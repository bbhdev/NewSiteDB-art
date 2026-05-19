<?php
/**
 * Round-rect pill button — text on a thin border that's flooded
 * with the accent color on hover via an inflating circle.
 *
 * Pairs with .rr-button rules in assets/css/style.css. The CSS
 * reads --rr-width, --rr-height, --rr-radius custom props with
 * sensible defaults, so any of these three can be left as the
 * default by simply not passing it.
 *
 * Params:
 *   - label         string  visible text                         (default 'Button')
 *   - href          string  destination URL                      (default '#')
 *   - target        string  link target attribute, e.g. _blank   (default null)
 *   - width         string  optional CSS width override; pass    (default null)
 *                           a length like '12rem' or '160px' to
 *                           force a fixed width (otherwise the
 *                           pill auto-sizes around the label).
 *   - height        string  optional CSS height override         (default null)
 *   - cornerRadius  string  border-radius override; pass a       (default null)
 *                           length to change from the default
 *                           pill (which uses 2rem in the CSS).
 *
 * Usage:
 *   <?= snippet('rr-button', [
 *     'label' => 'Read more',
 *     'href'  => '/about',
 *   ]) ?>
 *
 *   <?= snippet('rr-button', [
 *     'label'        => 'Wide button',
 *     'width'        => '14rem',
 *     'cornerRadius' => '0.5rem',
 *   ]) ?>
 */
$href         = $href         ?? '#';
$label        = $label        ?? 'Button';
$target       = $target       ?? null;
$width        = $width        ?? null;
$height       = $height       ?? null;
$cornerRadius = $cornerRadius ?? null;

$styleParts = [];
if ($width !== null)        $styleParts[] = '--rr-width:' . esc($width);
if ($height !== null)       $styleParts[] = '--rr-height:' . esc($height);
if ($cornerRadius !== null) $styleParts[] = '--rr-radius:' . esc($cornerRadius);
$style = $styleParts ? ' style="' . implode(';', $styleParts) . '"' : '';
?>
<a class="rr-button"
   href="<?= esc($href) ?>"<?= $target ? ' target="' . esc($target) . '"' : '' ?><?= $style ?>>
  <?= esc($label) ?>
</a>
