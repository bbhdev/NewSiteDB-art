<?php
/**
 * 2090 — "Published: <date>" informational badge (PUBLIC node B only).
 *
 * A factual statement of when the last A→B propagate LANDED on this node,
 * read from sync state's `lastPropagateAt` (the real wall-clock instant the
 * publish ran — NOT `lastActivityAt`, which adopts A's authoring stamp for the
 * equal-reading logic, and would mis-report the publish time). It lets the
 * author verify, after publishing, that the content actually went live:
 * "timestamp matches what I just did → it landed."
 *
 * Renders ONLY on B (the public node) and ONLY once a propagate has run. On
 * L/A, or before B's first publish, it emits nothing. There is deliberately NO
 * "out of date" warning: B being behind A is by design (staging → public), so
 * a lag warning here would mis-communicate the model (see the dirty-state
 * visibility spec).
 *
 * Low-key by intent: one element + a restrained default style the author can
 * override in the site CSS or move wherever it fits the design. Include it in a
 * public template (footer is the default placement) with:
 *     <?php snippet('published-date') ?>
 */
$syncOpt = option('sync');
$role = is_array($syncOpt) ? (string) ($syncOpt['role'] ?? '') : '';
if ($role !== 'B' || !function_exists('sync_state_read')) return;

$iso = sync_state_read()['lastPropagateAt'] ?? null;
if (!$iso) return;
$ts = strtotime((string) $iso);
if ($ts === false) return;

// Date + time so a same-day re-publish is still distinguishable when the
// author cross-checks the moment they hit Publish.
$label = date('j M Y, H:i', $ts);
?>
<style>
  /* Placeholder treatment — restyle / reposition to fit the site design. */
  .site-published{
    font:12px/1.5 system-ui,-apple-system,BlinkMacSystemFont,sans-serif;
    color:#8a8a8a; text-align:center; padding:10px 0; letter-spacing:.02em;
  }
</style>
<div class="site-published">Published: <?= $label ?></div>
