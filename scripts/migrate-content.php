<?php
/**
 * scripts/migrate-content.php
 *
 * Schema-aware migrator for the line-drawing content tree under
 * content/<slug>/. Each phase of the upcoming architecture refactor
 * (page dimensions, screen classes, master/instance, behavior lists)
 * ships its own migration registered below — running this script
 * brings any installation forward to the current target version.
 *
 * Usage (from project root):
 *   php scripts/migrate-content.php --status    Report version per page.
 *   php scripts/migrate-content.php --dry-run   Show what would change.
 *   php scripts/migrate-content.php             Apply pending migrations.
 *
 * Adding a new migration (when a phase changes the on-disk shape):
 *   1. Append an entry to $MIGRATIONS keyed by the FROM version,
 *      whose value is `function($pageRoot, $dryRun): bool`. It must
 *      either succeed and write the new shape, or fail and write
 *      nothing. The `_schemaVersion` marker is updated by the runner,
 *      not by the migration body.
 *   2. Bump CONTENT_SCHEMA_VERSION to the new target.
 *   3. Append a one-line summary to the SCHEMA_HISTORY array so
 *      `--status` reports stay self-documenting.
 *   4. Test on a content backup. Migrations write in place; rely on
 *      git history (and --dry-run) as the rollback path.
 *
 * Detection rule:
 *   v1 is detected by the absence of any `_schemaVersion` marker. Once
 *   a migration runs and writes page.json (Phase 1+), the marker lives
 *   in that file.
 */

const CONTENT_SCHEMA_VERSION = 3;

$SCHEMA_HISTORY = [
    1 => 'Initial: content/<slug>/{lines.json, groups.json}; flat array of'
       . ' lines; hardcoded viewBox; single design per page (no classes).',
    2 => 'Adds content/<slug>/page.json with { pageW, pageH, canvasW, canvasH }.'
       . ' Hardcoded viewBox removed from code; editor + runtime read dims'
       . ' from page.json (defaults preserve v1 visuals on existing content).',
    3 => 'Introduces screen classes. Site-wide content/_shared/classes.json'
       . ' (narrow / medium / wide). page.json nests to { useClasses, dims:'
       . ' {<classId>:{pageW,pageH,canvasW,canvasH}} }. Per-page lines + groups'
       . ' move into content/<slug>/<classId>/ subfolders (all classes cloned'
       . ' identically from v2 content so visuals survive).',
];

/**
 * Migrations are keyed by the FROM-version they upgrade away from.
 * Each callable receives the page-root directory path and a dry-run
 * flag, and returns true on success. The runner stamps the new
 * `_schemaVersion` marker into page.json after the callable returns —
 * migrations don't manage that field themselves.
 *
 * @var array<int, callable(string $pageRoot, bool $dryRun): bool>
 */
$MIGRATIONS = [
    1 => function (string $pageRoot, bool $dryRun): bool {
        // v1 → v2: write page.json with the dimensions the hardcoded
        // viewBox previously used (1200×800 page, 2400×1600 canvas).
        // A page.json that already exists (e.g. hand-written) is
        // preserved; we only fill in missing dim fields.
        $marker = $pageRoot . '/page.json';
        $existing = is_file($marker)
            ? (json_decode(file_get_contents($marker), true) ?: [])
            : [];
        $defaults = ['pageW' => 1200, 'pageH' => 800, 'canvasW' => 2400, 'canvasH' => 1600];
        $merged = $existing;
        foreach ($defaults as $k => $v) {
            if (!isset($merged[$k])) $merged[$k] = $v;
        }
        if ($dryRun) {
            echo "    would write $marker with " . json_encode($merged) . "\n";
            return true;
        }
        return file_put_contents(
            $marker,
            json_encode($merged, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . "\n"
        ) !== false;
    },

    2 => function (string $pageRoot, bool $dryRun): bool {
        // v2 → v3: introduce per-class layout.
        //   1) ensure site-wide content/_shared/classes.json exists
        //   2) restructure page.json: flat dims → { useClasses, dims }
        //   3) clone <pageRoot>/lines.json + groups.json into
        //      <pageRoot>/narrow/ + /medium/ + /wide/ (all three start
        //      identical so the runtime has data for every class)
        // Old lines.json / groups.json at the page root are LEFT in
        // place — recoverable safety net; v3+ readers ignore them.
        $contentDir = dirname($pageRoot);
        if (!ensureSiteClasses($contentDir, $dryRun)) return false;

        $marker = $pageRoot . '/page.json';
        if (!is_file($marker)) {
            fwrite(STDERR, "  $pageRoot: page.json missing (v1→v2 prerequisite). Run prior step first.\n");
            return false;
        }
        $old = json_decode(file_get_contents($marker), true) ?: [];

        $flatDims = [
            'pageW'   => isset($old['pageW'])   ? $old['pageW']   : 1200,
            'pageH'   => isset($old['pageH'])   ? $old['pageH']   : 800,
            'canvasW' => isset($old['canvasW']) ? $old['canvasW'] : 2400,
            'canvasH' => isset($old['canvasH']) ? $old['canvasH'] : 1600,
        ];
        $classes = ['narrow', 'medium', 'wide'];
        $nested = [
            'useClasses' => $classes,
            'dims'       => array_fill_keys($classes, $flatDims),
        ];
        // Preserve unknown top-level keys (skip the v2 dim keys + the
        // marker; the runner manages _schemaVersion).
        foreach ($old as $k => $v) {
            $isDimKey  = in_array($k, ['pageW', 'pageH', 'canvasW', 'canvasH'], true);
            $isMarker  = $k === '_schemaVersion';
            if (!$isDimKey && !$isMarker && !isset($nested[$k])) $nested[$k] = $v;
        }

        $linesData  = is_file($pageRoot . '/lines.json')
            ? file_get_contents($pageRoot . '/lines.json')  : null;
        $groupsData = is_file($pageRoot . '/groups.json')
            ? file_get_contents($pageRoot . '/groups.json') : null;

        if ($dryRun) {
            echo "    would rewrite $marker → v3 (useClasses + dims)\n";
            foreach ($classes as $c) {
                echo "    would clone lines.json + groups.json into $pageRoot/$c/\n";
            }
            return true;
        }

        foreach ($classes as $classId) {
            $dir = $pageRoot . '/' . $classId;
            if (!is_dir($dir) && !mkdir($dir, 0755, true)) return false;
            if ($linesData  !== null) file_put_contents($dir . '/lines.json',  $linesData);
            if ($groupsData !== null) file_put_contents($dir . '/groups.json', $groupsData);
        }

        return file_put_contents(
            $marker,
            json_encode($nested, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . "\n"
        ) !== false;
    },
];

/**
 * Create content/_shared/classes.json with the default 3-class
 * breakpoint set if it doesn't exist. Called from the v2→v3
 * migration; idempotent so re-running across multiple pages is
 * safe.
 */
function ensureSiteClasses(string $contentDir, bool $dryRun): bool
{
    $sharedDir = $contentDir . '/_shared';
    $marker    = $sharedDir . '/classes.json';
    if (is_file($marker)) return true;
    $defaults = [
        ['id' => 'narrow', 'name' => 'Narrow', 'minWidth' => 0,    'maxWidth' => 640],
        ['id' => 'medium', 'name' => 'Medium', 'minWidth' => 641,  'maxWidth' => 1100],
        ['id' => 'wide',   'name' => 'Wide',   'minWidth' => 1101, 'maxWidth' => null],
    ];
    if ($dryRun) {
        echo "    would create $marker with default 3-class breakpoint set\n";
        return true;
    }
    if (!is_dir($sharedDir) && !mkdir($sharedDir, 0755, true)) return false;
    return file_put_contents(
        $marker,
        json_encode($defaults, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . "\n"
    ) !== false;
}

// ─── CLI entry ──────────────────────────────────────────────────────

function main(array $argv): int
{
    $opts = parseArgs(array_slice($argv, 1));
    if ($opts === null) return 2;

    $contentDir = realpath(__DIR__ . '/../content');
    if ($contentDir === false || !is_dir($contentDir)) {
        fwrite(STDERR, "error: content/ not found (looked in " . __DIR__ . "/../content)\n");
        return 1;
    }

    $pages = findPages($contentDir);
    if (!$pages) {
        echo "no pages found under $contentDir\n";
        return 0;
    }

    if ($opts['status']) return printStatus($pages);
    return runMigrations($pages, $opts);
}

function parseArgs(array $args): ?array
{
    $opts = ['dry-run' => false, 'status' => false];
    foreach ($args as $a) {
        if      ($a === '--dry-run') $opts['dry-run'] = true;
        elseif  ($a === '--status')  $opts['status']  = true;
        elseif  ($a === '--help' || $a === '-h') {
            echo "Usage: php scripts/migrate-content.php [--status|--dry-run]\n";
            return null;
        } else {
            fwrite(STDERR, "unknown arg: $a (try --help)\n");
            return null;
        }
    }
    return $opts;
}

/**
 * A "page" is any direct child folder of content/ that contains a
 * Kirby `<slug>.txt` file. Folders starting with `_` or `.` are
 * skipped — that's Kirby's convention for site-wide / hidden data.
 *
 * @return array<string, string> slug => absolute path
 */
function findPages(string $contentDir): array
{
    $pages = [];
    foreach (new DirectoryIterator($contentDir) as $entry) {
        if ($entry->isDot() || !$entry->isDir()) continue;
        $name = $entry->getFilename();
        if ($name[0] === '_' || $name[0] === '.') continue;
        if (glob($entry->getPathname() . '/*.txt')) {
            $pages[$name] = $entry->getPathname();
        }
    }
    ksort($pages);
    return $pages;
}

/**
 * Read the schema version recorded for a page. We look in page.json
 * (which is itself a v2+ artifact); absence is the v1 signal.
 */
function detectSchemaVersion(string $pageRoot): int
{
    $marker = $pageRoot . '/page.json';
    if (is_file($marker)) {
        $j = json_decode(file_get_contents($marker), true);
        if (is_array($j) && isset($j['_schemaVersion'])) {
            return (int) $j['_schemaVersion'];
        }
    }
    return 1;
}

function printStatus(array $pages): int
{
    global $SCHEMA_HISTORY;
    $target = CONTENT_SCHEMA_VERSION;
    echo "Target schema version: v$target\n";
    echo "  v$target — " . ($SCHEMA_HISTORY[$target] ?? '(no description)') . "\n\n";
    echo str_pad('PAGE', 20) . str_pad('VERSION', 10) . "STATUS\n";
    echo str_repeat('─', 60) . "\n";
    foreach ($pages as $slug => $root) {
        $v = detectSchemaVersion($root);
        $status =
            $v === $target ? 'up to date' :
            ($v <  $target ? 'pending: ' . ($target - $v) . ' migration step(s)' :
                             'FUTURE schema — refusing to load');
        echo str_pad($slug, 20) . str_pad('v' . $v, 10) . $status . "\n";
    }
    echo "\n" . count($pages) . " page(s).\n";
    return 0;
}

function runMigrations(array $pages, array $opts): int
{
    global $MIGRATIONS;
    $target  = CONTENT_SCHEMA_VERSION;
    $dryRun  = $opts['dry-run'];
    $stepCount = 0;
    $tag = $dryRun ? '[dry run] ' : '';

    foreach ($pages as $slug => $root) {
        $cur = detectSchemaVersion($root);
        if ($cur === $target) {
            echo "{$tag}[$slug] v$cur — up to date.\n";
            continue;
        }
        if ($cur > $target) {
            fwrite(STDERR, "{$tag}[$slug] v$cur — FUTURE schema, refusing to downgrade.\n");
            continue;
        }
        echo "{$tag}[$slug] v$cur → v$target\n";
        for ($from = $cur; $from < $target; $from++) {
            if (!isset($MIGRATIONS[$from])) {
                fwrite(STDERR, "{$tag}  no migration registered from v$from — abort.\n");
                return 1;
            }
            echo "{$tag}  applying v$from → v" . ($from + 1) . "\n";
            $ok = ($MIGRATIONS[$from])($root, $dryRun);
            if (!$ok) {
                fwrite(STDERR, "{$tag}  migration v$from failed — abort.\n");
                return 1;
            }
            if (!$dryRun) writeSchemaMarker($root, $from + 1);
            $stepCount++;
        }
    }
    echo "\n{$tag}applied $stepCount migration step(s) across " . count($pages) . " page(s).\n";
    if ($stepCount === 0) echo "(nothing to do)\n";
    return 0;
}

/**
 * Update the `_schemaVersion` field in page.json after a successful
 * migration step. Creates page.json if absent (v1→v2 case, where the
 * file is itself the migration's product). Migrations don't need to
 * touch this themselves — keeps the marker authoritative in one
 * place.
 */
function writeSchemaMarker(string $pageRoot, int $version): void
{
    $marker = $pageRoot . '/page.json';
    $data   = is_file($marker)
            ? (json_decode(file_get_contents($marker), true) ?: [])
            : [];
    $data['_schemaVersion'] = $version;
    file_put_contents(
        $marker,
        json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . "\n"
    );
}

exit(main($argv));
