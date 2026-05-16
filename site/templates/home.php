<?php snippet('header') ?>

<h1><?= $page->title() ?></h1>

<?php if ($page->intro()->isNotEmpty()): ?>
  <?= $page->intro()->kt() ?>
<?php endif ?>

<?php snippet('footer') ?>
