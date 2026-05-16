<?php snippet('header') ?>

<h1><?= $page->title() ?></h1>

<?php if ($page->intro()->isNotEmpty()): ?>
  <?= $page->intro()->kt() ?>
<?php endif ?>

<p>
  <?php snippet('rr-button', [
    'label' => 'Read more',
    'href'  => '#projects',
  ]) ?>
</p>

<div style="height: 60vh"></div>

<h2 id="projects">Projects</h2>
<p>Scroll past these — the circles drift. Drag one and it throws with inertia.</p>

<div class="circle-buttons">
  <?php snippet('circle-button', [
    'href' => '#',
    'title' => 'Alpha',
    'subtitle' => 'sketch',
  ]) ?>
  <?php snippet('circle-button', [
    'href' => '#',
    'title' => 'Beta',
    'subtitle' => 'in progress',
  ]) ?>
  <?php snippet('circle-button', [
    'href' => '#',
    'title' => 'Gamma',
    'subtitle' => 'archive',
  ]) ?>
</div>

<div style="height: 80vh"></div>

<p>End of placeholder content. Pass 3 adds the scroll-driven line system here.</p>

<?php snippet('footer') ?>
