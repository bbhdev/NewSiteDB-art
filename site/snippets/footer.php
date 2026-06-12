<?php $v = option('version', 'dev') ?>
</main>
<?php /* 2090 — "Published: <date>" badge. Renders on any node, gated only by
        "a propagate has landed" (lastPropagateAt non-null); emits nothing
        before the first propagate. Default placement here at the page foot —
        move it wherever fits. */ ?>
<?php snippet('published-date') ?>
<script src="<?= url('assets/js/gsap.min.js') ?>?v=<?= $v ?>"></script>
<script src="<?= url('assets/js/ScrollTrigger.min.js') ?>?v=<?= $v ?>"></script>
<script src="<?= url('assets/js/Draggable.min.js') ?>?v=<?= $v ?>"></script>
<script src="<?= url('assets/js/InertiaPlugin.min.js') ?>?v=<?= $v ?>"></script>
<script src="<?= url('assets/js/app.js') ?>?v=<?= $v ?>"></script>
<!-- v<?= $v ?> -->
</body>
</html>
