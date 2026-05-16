(function () {
  'use strict';

  if (!window.gsap) return;
  gsap.registerPlugin(ScrollTrigger);
  if (window.Draggable)      gsap.registerPlugin(Draggable);
  if (window.InertiaPlugin)  gsap.registerPlugin(InertiaPlugin);

  initCircleButtons();

  /**
   * For each [data-circle-button], on desktop only:
   *   - make it Draggable with inertia
   *   - scrub its position over scroll via ScrollTrigger
   *   - dragging cancels the scroll-driven tween so user input wins
   *
   * On mobile (≤1000px) the elements stay where the grid puts them
   * (CSS already pins transform: translate(0,0) !important at that size).
   *
   * Pattern adapted from reference f.js L378–423.
   */
  function initCircleButtons() {
    const buttons = document.querySelectorAll('[data-circle-button]');
    if (!buttons.length) return;

    const container = buttons[0].closest('.circle-buttons') || buttons[0].parentElement;

    buttons.forEach(function (btn) {
      const sx = parseFloat(btn.dataset.scatterX) || 75;
      const sy = parseFloat(btn.dataset.scatterY) || 150;

      ScrollTrigger.matchMedia({
        '(min-width: 1001px)': function () {
          let scrubTween;

          if (window.Draggable) {
            Draggable.create(btn, {
              type: 'x,y',
              inertia: !!window.InertiaPlugin,
              edgeResistance: 0.25,
              throwResistance: 1000,
              allowContextMenu: true,
              cursor: 'grab',
              activeCursor: 'grabbing',
              onDragStart: function () { if (scrubTween) scrubTween.kill(false); }
            });
          }

          // Bias start/end so motion is always clearly visible (signals to
          // the user that the circles are interactive / draggable). Start
          // is always in the upper-left quadrant of the scatter range,
          // end is always in the lower-right — guarantees a minimum of
          // ~60% sy vertical travel and a leftward-to-rightward arc.
          scrubTween = gsap.fromTo(btn,
            {
              y: 'random(' + (-sy) + ', ' + (-sy * 0.3).toFixed(0) + ')',
              x: 'random(' + (-sx) + ', 0)'
            },
            {
              y: 'random(' + (sy * 0.3).toFixed(0) + ', ' + sy + ')',
              x: 'random(0, ' + sx + ')',
              scrollTrigger: {
                trigger: container,
                start: 'top bottom',
                end: 'bottom top',
                scrub: 1
              }
            }
          );

          return function cleanup() { if (scrubTween) scrubTween.kill(); };
        }
      });
    });
  }

  // Line system runtime will be added in Pass 3.
})();
