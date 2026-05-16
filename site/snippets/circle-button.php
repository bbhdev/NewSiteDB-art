<?php
/**
 * Circle button — draggable on desktop, scattered by scroll.
 * app.js finds these by [data-circle-button] and wires up GSAP.
 *
 * Usage:
 *   <?= snippet('circle-button', [
 *     'href' => '/projects/foo',
 *     'title' => 'Foo',
 *     'subtitle' => 'a project',
 *     'image' => '/assets/images/foo.jpg',   // optional
 *     'scatterX' => 75,                       // optional, default 75
 *     'scatterY' => 150,                      // optional, default 150
 *   ]) ?>
 */
$href     = $href     ?? '#';
$title    = $title    ?? '';
$subtitle = $subtitle ?? '';
$image    = $image    ?? null;
$scatterX = $scatterX ?? 75;
$scatterY = $scatterY ?? 150;
$bgStyle  = $image ? ' style="background-image:url(' . esc($image) . ')"' : '';
?>
<a class="circle-button"
   href="<?= esc($href) ?>"
   data-circle-button
   data-scatter-x="<?= esc($scatterX) ?>"
   data-scatter-y="<?= esc($scatterY) ?>">
  <span class="circle"<?= $bgStyle ?>></span>
  <span class="text">
    <?php if ($title): ?><span class="title"><?= esc($title) ?></span><?php endif ?>
    <?php if ($subtitle): ?><span class="subtitle"><?= esc($subtitle) ?></span><?php endif ?>
  </span>
</a>
