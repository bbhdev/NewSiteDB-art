(function () {
  'use strict';

  if (window.gsap && window.ScrollTrigger) {
    gsap.registerPlugin(ScrollTrigger);
  }
  if (window.gsap && window.Draggable) {
    gsap.registerPlugin(Draggable);
  }
  if (window.gsap && window.InertiaPlugin) {
    gsap.registerPlugin(InertiaPlugin);
  }

  // Primitives will be wired up in later passes:
  // - [data-circle-button] -> scroll-scatter + draggable
  // - <svg id="lines-layer"> -> scroll-driven line runtime
})();
