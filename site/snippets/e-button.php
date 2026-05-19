<?php
/**
 * Ellipse scatter-button — sibling of c-button with independent
 * radii on the x and y axes.
 *
 * Pairs with [data-scatter-btn] wiring in assets/js/app.js for the
 * drag + scroll-scatter behavior, and with .e-button rules in
 * assets/css/style.css for the visual.
 *
 * Params:
 *   - href      string   destination URL                         (default '#')
 *   - title     string   primary label                           (default '')
 *   - subtitle  string   secondary label (italic, smaller)       (default '')
 *   - image     string   optional background-image URL for the   (default null)
 *                        inner shape (covers the entire shape)
 *   - radiusX   string   horizontal half-axis as a CSS length    (default '6rem')
 *   - radiusY   string   vertical half-axis as a CSS length      (default '4rem')
 *   - scatterX  number   ± horizontal drift range in pixels      (default 75)
 *   - scatterY  number   ± vertical drift range in pixels        (default 150)
 *
 * Usage:
 *   <?= snippet('e-button', [
 *     'href'     => '/projects/alpha',
 *     'title'    => 'Alpha',
 *     'subtitle' => 'wide',
 *     'radiusX'  => '7rem',
 *     'radiusY'  => '4rem',
 *   ]) ?>
 */
$href     = $href     ?? '#';
$title    = $title    ?? '';
$subtitle = $subtitle ?? '';
$image    = $image    ?? null;
$radiusX  = $radiusX  ?? '6rem';
$radiusY  = $radiusY  ?? '4rem';
$scatterX = $scatterX ?? 75;
$scatterY = $scatterY ?? 150;
$style    = '--rx:' . esc($radiusX) . ';--ry:' . esc($radiusY) . ';';
$bgStyle  = $image ? 'background-image:url(' . esc($image) . ')' : '';
?>
<a class="e-button scatter-btn"
   href="<?= esc($href) ?>"
   data-scatter-btn
   data-scatter-x="<?= esc($scatterX) ?>"
   data-scatter-y="<?= esc($scatterY) ?>"
   style="<?= $style ?>">
  <span class="shape"<?= $bgStyle ? ' style="' . $bgStyle . '"' : '' ?>></span>
  <span class="text">
    <?php if ($title): ?><span class="title"><?= esc($title) ?></span><?php endif ?>
    <?php if ($subtitle): ?><span class="subtitle"><?= esc($subtitle) ?></span><?php endif ?>
  </span>
</a>
