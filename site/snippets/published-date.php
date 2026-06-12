<?php
/**
 * 2090 — "Published: <date>" informational badge.
 *
 * A factual statement of when the last propagate LANDED on THIS node, read from
 * sync state's `lastPropagateAt` (the real wall-clock instant it ran — NOT
 * `lastActivityAt`, which adopts the SOURCE's authoring stamp for the
 * equal-reading logic and would mis-report the moment).
 *
 * On B (the public node) this is literally "published" — the A→B publish
 * instant the author cross-checks after publishing ("timestamp matches what I
 * just did → it landed"). On A/L the same field means "last received a
 * propagate" (A: last L→A push or B→A back-prop; L: last A→L pull). The wording
 * stays a single "Published:" for ONE shared affordance: precise on the node
 * that ships to the public, and a useful dev-visible readout of the same fact
 * on A/L. (Want per-node wording? trivial to branch on role here.)
 *
 * Renders on ANY node — gated ONLY by "a propagate has actually landed"
 * (`lastPropagateAt` non-null). NO node restriction, deliberately: an affordance
 * has to be testable where the work is done (L), and the general snippet
 * principle [6020] has no business node-gating individual snippets. (Earlier
 * this gated to role B; dropped 2026-06-12 — the gate blocked seeing it on L and
 * bought nothing. The dirty-state spec's "B-only" was about never surfacing a
 * lag / "out of date" WARNING publicly — which this badge does not do — not
 * about where it may render. On L it appears once L has pulled at least once.)
 *
 * Low-key by intent: one element + a restrained default style the author can
 * override in the site CSS or move wherever it fits the design. Include it in a
 * template (footer is the default placement) with:
 *     <?php snippet('published-date') ?>
 */
if (!function_exists('sync_state_read')) return;

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
