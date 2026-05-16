<?php
/**
 * Round-rect button — the pill with the inflating accent-color hover.
 * Usage: <?= snippet('rr-button', ['label' => 'Read more', 'href' => '/about']) ?>
 */
$href   = $href   ?? '#';
$label  = $label  ?? 'Button';
$target = $target ?? null;
?>
<a class="rr-button" href="<?= esc($href) ?>"<?= $target ? ' target="' . esc($target) . '"' : '' ?>>
  <?= esc($label) ?>
</a>
