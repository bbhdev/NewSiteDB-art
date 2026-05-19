<?php
/**
 * Circle scatter-button — a draggable circle that drifts on scroll.
 *
 * Pairs with [data-scatter-btn] wiring in assets/js/app.js for the
 * drag + scroll-scatter behavior, and with .c-button rules in
 * assets/css/style.css for the visual.
 *
 * Params:
 *   - href      string   destination URL                         (default '#')
 *   - title     string   primary label                           (default '')
 *   - subtitle  string   secondary label (italic, smaller)       (default '')
 *   - image     string   optional background-image URL for the   (default null)
 *                        inner shape (covers the entire shape)
 *   - radius    string   half-diameter as a CSS length, e.g.     (default '5rem')
 *                        '5rem' or '80px' — controls the visual
 *                        size of the .shape inside the anchor
 *   - scatterX  number   ± horizontal drift range in pixels      (default 75)
 *                        (anchor moves between -X and +X across
 *                        the scroll window)
 *   - scatterY  number   ± vertical drift range in pixels        (default 150)
 *
 * Usage:
 *   <?= snippet('c-button', [
 *     'href'     => '/projects/alpha',
 *     'title'    => 'Alpha',
 *     'subtitle' => 'sketch',
 *     'radius'   => '5rem',
 *     'image'    => '/assets/images/alpha.jpg',
 *   ]) ?>
 */
$href     = $href     ?? '#';
$title    = $title    ?? '';
$subtitle = $subtitle ?? '';
$image    = $image    ?? null;
$radius   = $radius   ?? '5rem';
$scatterX = $scatterX ?? 75;
$scatterY = $scatterY ?? 150;
$style    = '--rx:' . esc($radius) . ';--ry:' . esc($radius) . ';';
$bgStyle  = $image ? 'background-image:url(' . esc($image) . ')' : '';
?>
<a class="c-button scatter-btn"
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
