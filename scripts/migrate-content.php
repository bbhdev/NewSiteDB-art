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
 *   php scripts/migrate-content.php --status         Report version per page.
 *   php scripts/migrate-content.php --dry-run        Show what would change.
 *   php scripts/migrate-content.php                  Apply pending migrations.
 *   php scripts/migrate-content.php --repair-names   Force-run the v4→v5 name
 *                                                    retrofit even if marker
 *                                                    is already past v5 — for
 *                                                    masters/instances that
 *                                                    missed the step.
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

const CONTENT_SCHEMA_VERSION = 5;

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
    4 => 'Master / instance split. Visual identity (kind, params, stroke, width,'
       . ' name, geometry) moves into site-wide content/_shared/masters.json.'
       . ' Per-class files become instances.json — each entry references a'
       . ' master by id, plus per-class { visible, groupId, overrides } (where'
       . ' overrides can include any master prop diverging from canonical, plus'
       . ' the existing behavior overrides). content/colors.json moves to'
       . ' content/_shared/palette.json. Legacy lines.json + colors.json are'
       . ' left in place as a recoverable safety net; v4 readers ignore them.',
    5 => 'Ensures every master AND every instance has a human-readable `name`'
       . ' field. Masters get their canonical line id (e.g. "amb-1", "dozeng")'
       . ' as a default name when none was set. Each instance gets a top-level'
       . ' `name` denormalized from its master (informational only — the'
       . ' resolver still reads name from master + overrides). Purpose: keep'
       . ' the JSON files self-describing when read by a human.',
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

    3 => function (string $pageRoot, bool $dryRun): bool {
        // v3 → v4: master / instance split.
        //   1) ensure content/_shared/palette.json (moved from colors.json)
        //   2) for each line in each class, extract visual identity into a
        //      master; keep behaviors + position-style overrides on the
        //      instance. Identical lines across classes share one master
        //      (same lineId → same master); divergent visual props on
        //      non-canonical classes become instance overrides.
        //   3) write per-class instances.json next to (deprecated) lines.json
        //   4) merge into / write site-wide _shared/masters.json
        $contentDir = dirname($pageRoot);
        $pageSlug   = basename($pageRoot);

        if (!ensureSharedPalette($contentDir, $dryRun)) return false;

        $cfgPath = $pageRoot . '/page.json';
        if (!is_file($cfgPath)) {
            fwrite(STDERR, "  $pageRoot: page.json missing (v3 prerequisite).\n");
            return false;
        }
        $cfg = json_decode(file_get_contents($cfgPath), true) ?: [];
        $useClasses = is_array($cfg['useClasses'] ?? null) ? $cfg['useClasses'] : ['wide'];

        // Visual keys live on masters. Everything else (groupId,
        // hidden, overrides) is instance-side.
        $visualKeys = ['kind', 'points', 'params', 'segments', 'smoothed',
                       'closed', 'filled', 'd', 'stroke', 'width', 'name'];

        // Pass 1: pick canonical visuals per lineId. Prefer the "wide"
        // class as canonical when present (Phase 2 cloned everything
        // from there); otherwise first-encountered wins.
        $orderedClasses = [];
        if (in_array('wide', $useClasses, true)) $orderedClasses[] = 'wide';
        foreach ($useClasses as $cid) {
            if ($cid !== 'wide') $orderedClasses[] = $cid;
        }

        $canonByLineId = [];   // lineId → visual array (master content)
        $rawByClass    = [];   // classId → array of raw lines (preserved)
        foreach ($useClasses as $cid) {
            $linesFile = $pageRoot . '/' . $cid . '/lines.json';
            $rawByClass[$cid] = is_file($linesFile)
                ? (json_decode(file_get_contents($linesFile), true) ?: [])
                : [];
        }
        foreach ($orderedClasses as $cid) {
            foreach ($rawByClass[$cid] as $line) {
                $lid = $line['id'] ?? null;
                if (!is_string($lid) || $lid === '') continue;
                if (isset($canonByLineId[$lid])) continue;
                $visual = [];
                foreach ($visualKeys as $vk) {
                    if (array_key_exists($vk, $line)) $visual[$vk] = $line[$vk];
                }
                $canonByLineId[$lid] = $visual;
            }
        }

        // Build masters keyed by deterministic ID = m-<8 hex of pageSlug/lineId>.
        // Deterministic so re-running the migration after a partial failure
        // gives the same IDs (idempotency at the master level).
        $masterIdByLineId = [];
        $newMasters       = [];
        foreach ($canonByLineId as $lid => $visual) {
            $mid = 'm-' . substr(md5($pageSlug . '/' . $lid), 0, 8);
            $masterIdByLineId[$lid] = $mid;
            // Default name = original line id — usually carries semantic
            // meaning (amb-1, dozeng, …). User can rename via the panel.
            if (!isset($visual['name']) || $visual['name'] === '') {
                $visual['name'] = $lid;
            }
            $newMasters[] = array_merge(['id' => $mid], $visual);
        }

        // Per-class instances: every line becomes an instance referencing
        // its master, with overrides for any visual prop diverging from
        // canonical PLUS the line's existing behavior overrides.
        $instancesByClass = [];
        foreach ($useClasses as $cid) {
            $instances = [];
            foreach ($rawByClass[$cid] as $line) {
                $lid = $line['id'] ?? null;
                if (!is_string($lid) || $lid === '' || !isset($masterIdByLineId[$lid])) continue;
                $mid    = $masterIdByLineId[$lid];
                $canon  = $canonByLineId[$lid];
                // Compute visual divergence.
                $visualOverrides = [];
                foreach ($visualKeys as $vk) {
                    if (array_key_exists($vk, $line)) {
                        $a = $line[$vk]; $b = $canon[$vk] ?? null;
                        // Use loose compare on the JSON representation —
                        // tolerates int/float differences in coords, etc.
                        if (json_encode($a) !== json_encode($b)) {
                            $visualOverrides[$vk] = $a;
                        }
                    }
                }
                $behaviorOverrides = is_array($line['overrides'] ?? null) ? $line['overrides'] : [];
                $merged = array_merge($behaviorOverrides, $visualOverrides);
                // Per-instance name: own name if set, else inherit the
                // master's name (which itself defaults to lineId). Kept
                // at top level for human readability of the JSON file;
                // the resolver ignores it and reads master.name.
                $instanceName = $line['name'] ?? ($canonByLineId[$lid]['name'] ?? $lid);
                $instances[] = [
                    'id'        => $lid,
                    'masterId'  => $mid,
                    'name'      => $instanceName,
                    'visible'   => empty($line['hidden']),
                    'groupId'   => $line['groupId'] ?? null,
                    'overrides' => (object) $merged,
                ];
            }
            $instancesByClass[$cid] = $instances;
        }

        if ($dryRun) {
            echo "    would write " . count($newMasters) . " master(s) for page '$pageSlug' into _shared/masters.json\n";
            foreach ($instancesByClass as $cid => $insts) {
                echo "    would write " . count($insts) . " instance(s) into $pageRoot/$cid/instances.json\n";
            }
            return true;
        }

        // Merge into existing masters.json (preserve other pages' masters).
        $mastersPath = $contentDir . '/_shared/masters.json';
        $existing    = is_file($mastersPath)
            ? (json_decode(file_get_contents($mastersPath), true) ?: [])
            : [];
        $newIds = array_column($newMasters, 'id');
        $all    = [];
        foreach ($existing as $em) {
            if (is_array($em) && isset($em['id']) && !in_array($em['id'], $newIds, true)) {
                $all[] = $em;
            }
        }
        foreach ($newMasters as $m) $all[] = $m;
        if (!is_dir($contentDir . '/_shared') && !mkdir($contentDir . '/_shared', 0755, true)) return false;
        if (file_put_contents($mastersPath,
                json_encode($all, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . "\n") === false) {
            return false;
        }

        // Per-class instances.json (lines.json left as a safety net).
        foreach ($instancesByClass as $cid => $insts) {
            $classDir = $pageRoot . '/' . $cid;
            if (!is_dir($classDir) && !mkdir($classDir, 0755, true)) return false;
            if (file_put_contents($classDir . '/instances.json',
                    json_encode($insts, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . "\n") === false) {
                return false;
            }
        }

        return true;
    },

    4 => function (string $pageRoot, bool $dryRun): bool {
        // v4 → v5: ensure every master and every instance has a `name`
        // field. Operates on site-wide data — re-running per-page is
        // idempotent (no-op after first page finishes).
        return ensureMasterAndInstanceNames(dirname($pageRoot), $dryRun);
    },
];

/**
 * Backfill `name` on every master and every instance across the
 * site (v4 → v5 retrofit). For each unnamed master, picks the first
 * referencing instance's id (a human-meaningful label like
 * "amb-1" or "dozeng"); falls back to the master id when no
 * instance is found. For each instance, denormalizes the master's
 * name into a top-level `name` field for JSON readability — the
 * resolver doesn't read it, so it's informational only.
 * Idempotent: re-running noops once names exist.
 */
function ensureMasterAndInstanceNames(string $contentDir, bool $dryRun): bool
{
    $verbose = $GLOBALS['VERBOSE_RETROFIT'] ?? false;
    $log = function (string $m) use ($verbose) {
        if ($verbose) echo $m;
    };
    $mastersPath = $contentDir . '/_shared/masters.json';
    if (!is_file($mastersPath)) {
        $log("    no _shared/masters.json — nothing to do\n");
        return true;
    }
    $masters = json_decode(file_get_contents($mastersPath), true);
    if (!is_array($masters)) {
        $log("    masters.json couldn't decode as array — bailing\n");
        return true;
    }

    // Collect master → first-instance-id mapping by scanning every
    // page's class folders. We only need ONE instance per master to
    // pick a name, so first-found wins.
    $instanceIdByMaster = [];
    $pageDirs = glob($contentDir . '/*', GLOB_ONLYDIR) ?: [];
    $log("    scanned " . count($pageDirs) . " page-dir candidate(s) under content/\n");
    foreach ($pageDirs as $pageDir) {
        $name = basename($pageDir);
        if ($name === '' || $name[0] === '_' || $name[0] === '.') continue;
        $classDirs = glob($pageDir . '/*', GLOB_ONLYDIR) ?: [];
        $log("    page '$name' has " . count($classDirs) . " subdir(s)\n");
        foreach ($classDirs as $classDir) {
            $instPath = $classDir . '/instances.json';
            if (!is_file($instPath)) continue;
            $insts = json_decode(file_get_contents($instPath), true);
            if (!is_array($insts)) continue;
            foreach ($insts as $inst) {
                if (!is_array($inst)) continue;
                $mid = $inst['masterId'] ?? null;
                $iid = $inst['id']       ?? null;
                if (is_string($mid) && is_string($iid)
                    && !isset($instanceIdByMaster[$mid])) {
                    $instanceIdByMaster[$mid] = $iid;
                }
            }
        }
    }
    $log("    collected " . count($instanceIdByMaster) . " master→instance id mapping(s)\n");

    // Patch masters with names where missing.
    $mastersChanged = false;
    foreach ($masters as &$m) {
        if (!is_array($m) || !isset($m['id'])) continue;
        if (isset($m['name']) && is_string($m['name']) && $m['name'] !== '') continue;
        $m['name'] = $instanceIdByMaster[$m['id']] ?? $m['id'];
        $mastersChanged = true;
    }
    unset($m);

    // Build master lookup AFTER patching so denormalization uses the
    // new names.
    $masterById = [];
    foreach ($masters as $m) {
        if (is_array($m) && isset($m['id'])) $masterById[$m['id']] = $m;
    }

    // Patch instances with denormalized names.
    $instanceFilesChanged = [];
    foreach (glob($contentDir . '/*', GLOB_ONLYDIR) ?: [] as $pageDir) {
        $name = basename($pageDir);
        if ($name === '' || $name[0] === '_' || $name[0] === '.') continue;
        foreach (glob($pageDir . '/*', GLOB_ONLYDIR) ?: [] as $classDir) {
            $instPath = $classDir . '/instances.json';
            if (!is_file($instPath)) continue;
            $insts = json_decode(file_get_contents($instPath), true);
            if (!is_array($insts)) continue;
            $changed = false;
            $log("    inspecting $instPath (" . count($insts) . " instance(s))\n");
            foreach ($insts as &$inst) {
                if (!is_array($inst)) continue;
                // Repair: PHP's json_decode(assoc=true) turns "{}" into
                // an empty array, and re-encode keeps it as "[]" — but
                // overrides is conceptually a map, not a list. Cast back
                // to stdClass so the next write produces "{}". Visible
                // only when retrofitting older v4 data.
                if (isset($inst['overrides']) && is_array($inst['overrides']) && empty($inst['overrides'])) {
                    $inst['overrides'] = (object) [];
                    $changed = true;
                }
                if (!isset($inst['name']) || !is_string($inst['name']) || $inst['name'] === '') {
                    $mid = $inst['masterId'] ?? null;
                    $candidate = ($mid && isset($masterById[$mid]['name']))
                        ? $masterById[$mid]['name']
                        : ($inst['id'] ?? null);
                    if ($candidate !== null) {
                        // Insert `name` right after masterId for
                        // consistency with the v3→v4 emission order.
                        $reordered = [];
                        foreach ($inst as $k => $v) {
                            $reordered[$k] = $v;
                            if ($k === 'masterId') $reordered['name'] = $candidate;
                        }
                        if (!isset($reordered['name'])) $reordered['name'] = $candidate;
                        $inst = $reordered;
                        $changed = true;
                    }
                }
            }
            unset($inst);
            $log("    → " . ($changed ? "changed; will write" : "no changes needed") . "\n");
            if ($changed) $instanceFilesChanged[$instPath] = $insts;
        }
    }

    if ($dryRun) {
        if ($mastersChanged) echo "    would add names to " . count($masters) . " master entries in $mastersPath\n";
        foreach ($instanceFilesChanged as $p => $_) echo "    would denormalize names into $p\n";
        return true;
    }

    if ($mastersChanged) {
        $log("    writing $mastersPath\n");
        if (file_put_contents($mastersPath,
                json_encode($masters, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . "\n") === false) {
            return false;
        }
    } else {
        $log("    masters already named — not rewriting\n");
    }
    if (!$instanceFilesChanged) {
        $log("    no instance files needed changes\n");
    }
    foreach ($instanceFilesChanged as $path => $insts) {
        $log("    writing $path\n");
        if (file_put_contents($path,
                json_encode($insts, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . "\n") === false) {
            return false;
        }
    }
    return true;
}

/**
 * Move content/colors.json → content/_shared/palette.json (copy,
 * don't delete — the legacy file is a safety net). Idempotent.
 * Called once per page by the v3→v4 migration; subsequent calls
 * notice the destination already exists and exit.
 */
function ensureSharedPalette(string $contentDir, bool $dryRun): bool
{
    $dest = $contentDir . '/_shared/palette.json';
    if (is_file($dest)) return true;
    $src = $contentDir . '/colors.json';
    if (!is_file($src)) {
        // Try the example seed for fresh clones.
        $seed = $contentDir . '/colors.example.json';
        if (!is_file($seed)) return true; // nothing to move
        $src = $seed;
    }
    if ($dryRun) {
        echo "    would copy $src → $dest\n";
        return true;
    }
    if (!is_dir($contentDir . '/_shared') && !mkdir($contentDir . '/_shared', 0755, true)) return false;
    return copy($src, $dest);
}

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
    if ($opts['repair-names']) return repairNames($contentDir, $opts);
    return runMigrations($pages, $opts);
}

/**
 * Force-run the v4→v5 name retrofit regardless of the current
 * schema marker. Use when the schema is already at v5 (or beyond)
 * but masters / instances are missing their `name` fields — e.g.
 * because an older migration step ran before the name logic was
 * added. Idempotent.
 */
function repairNames(string $contentDir, array $opts): int
{
    $dry = $opts['dry-run'];
    $GLOBALS['VERBOSE_RETROFIT'] = true;
    echo ($dry ? "[dry run] " : "") . "running name retrofit on $contentDir\n";
    $ok = ensureMasterAndInstanceNames($contentDir, $dry);
    if (!$ok) { fwrite(STDERR, "name retrofit failed.\n"); return 1; }
    echo ($dry ? "[dry run] " : "") . "name retrofit complete.\n";
    return 0;
}

function parseArgs(array $args): ?array
{
    $opts = ['dry-run' => false, 'status' => false, 'repair-names' => false];
    foreach ($args as $a) {
        if      ($a === '--dry-run')     $opts['dry-run']      = true;
        elseif  ($a === '--status')      $opts['status']       = true;
        elseif  ($a === '--repair-names')$opts['repair-names'] = true;
        elseif  ($a === '--help' || $a === '-h') {
            echo "Usage: php scripts/migrate-content.php "
               . "[--status | --dry-run | --repair-names]\n";
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
