(function () {
  'use strict';

  if (!window.gsap) return;
  gsap.registerPlugin(ScrollTrigger);
  if (window.Draggable)      gsap.registerPlugin(Draggable);
  if (window.InertiaPlugin)  gsap.registerPlugin(InertiaPlugin);

  initCircleButtons();
  initLineSystem();

  /**
   * For each [data-circle-button], on desktop only:
   *
   *   Scroll-scrub drift  →  drives --scrub-x / --scrub-y CSS vars on the
   *                          anchor; CSS uses them to translate the inner
   *                          .circle + .text. This leaves the anchor's
   *                          own transform free for Draggable.
   *
   *   Draggable           →  moves the anchor (translate via GSAP).
   *
   *   Composition         →  the visible circle ends up at:
   *                          anchor_layout_position
   *                            + draggable.translate
   *                            + scroll_scrub.translate
   *
   *   First-drag handoff  →  the moment the user drags a circle, we tween
   *                          a "mult" factor from 1 → 0.5 over 0.4s so the
   *                          scroll drift continues at half amplitude.
   *                          Signals "you're now in charge" without
   *                          freezing the auto-motion entirely.
   *
   * On mobile (≤1000px) matchMedia skips both behaviors; the CSS pins
   * the anchor's transform to translate(0,0) and the --scrub vars stay 0.
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

          // Per-button start/end offsets — randomized once per session.
          // Biased so motion is guaranteed visible (upper-left → lower-right).
          const startX = gsap.utils.random(-sx, 0);
          const startY = gsap.utils.random(-sy, -sy * 0.3);
          const endX   = gsap.utils.random(0, sx);
          const endY   = gsap.utils.random(sy * 0.3, sy);

          // progress: smoothed scroll position (0–1) from ScrollTrigger.
          // mult:     drift amplitude factor; halves on first drag.
          const state = { progress: 0, mult: 1 };

          const apply = function () {
            const p = state.progress;
            const m = state.mult;
            btn.style.setProperty('--scrub-x',
              (((endX - startX) * p + startX) * m).toFixed(2) + 'px');
            btn.style.setProperty('--scrub-y',
              (((endY - startY) * p + startY) * m).toFixed(2) + 'px');
          };

          const st = ScrollTrigger.create({
            trigger: container,
            start: 'top bottom',
            end: 'bottom top',
            scrub: 1,
            onUpdate: function (self) {
              state.progress = self.progress;
              apply();
            }
          });

          // Set initial scattered position before first scroll event.
          apply();

          if (window.Draggable) {
            Draggable.create(btn, {
              type: 'x,y',
              inertia: !!window.InertiaPlugin,
              edgeResistance: 0.25,
              throwResistance: 1000,
              allowContextMenu: true,
              cursor: 'grab',
              activeCursor: 'grabbing',
              onDragStart: function () {
                if (state.mult > 0.5 + 0.001) {
                  gsap.to(state, {
                    mult: 0.5,
                    duration: 0.4,
                    ease: 'power2.out',
                    onUpdate: apply
                  });
                }
              }
            });
          }

          return function cleanup() { if (st) st.kill(); };
        }
      });
    });
  }

  /**
   * Line system runtime — reads the inlined JSON from the
   * <script id="lines-data"> emitted by site/snippets/lines-layer.php,
   * builds an <svg> path per line, and scroll-animates each line per
   * its group's behaviors (translateX, translateY, rotate, drawIn),
   * with per-line overrides.
   *
   * The SVG has viewBox 0 0 1200 800, so all "d" attributes are
   * authored in that coordinate space. The element fills the viewport
   * non-uniformly (preserveAspectRatio="none") so lines stretch with
   * the screen.
   */
  function initLineSystem() {
    const layer  = document.getElementById('lines-layer');
    const dataEl = document.getElementById('lines-data');
    if (!layer || !dataEl) return;

    let data;
    try { data = JSON.parse(dataEl.textContent); } catch (e) { return; }

    const groups     = Array.isArray(data.groups)     ? data.groups     : [];
    const lines      = Array.isArray(data.lines)      ? data.lines      : [];
    const svgImports = Array.isArray(data.svgImports) ? data.svgImports : [];

    if (!lines.length && !svgImports.length) return;

    const SVG_NS = 'http://www.w3.org/2000/svg';
    const groupById = {};
    groups.forEach(function (g) { groupById[g.id] = g; });

    // Render JSON-defined lines.
    lines.forEach(function (line) {
      const p = document.createElementNS(SVG_NS, 'path');
      p.setAttribute('d', line.d);
      // Effective stroke / width: line value wins, then group default,
      // else fall back to the CSS rule on #lines-layer path.
      // Set via style (not the SVG attribute) so var(--…) resolves —
      // SVG presentation attributes don't evaluate CSS vars in most browsers.
      const group = groupById[line.groupId];
      const stroke = line.stroke || (group && group.defaults && group.defaults.stroke) || null;
      const width  = (line.width != null) ? line.width
                   : (group && group.defaults && group.defaults.width != null ? group.defaults.width : null);
      if (stroke) p.style.stroke = stroke;
      if (width)  p.style.strokeWidth = width;
      p.dataset.lineId  = line.id;
      p.dataset.groupId = line.groupId || '';
      layer.appendChild(p);
    });

    // Render imported SVG files. Extract every <path>; each becomes a
    // line in a synthetic "__imported" group (registered if absent).
    if (svgImports.length) {
      const parser = new DOMParser();
      svgImports.forEach(function (imp) {
        const doc = parser.parseFromString(imp.content, 'image/svg+xml');
        const paths = doc.querySelectorAll('path');
        paths.forEach(function (sourcePath, i) {
          const p = document.createElementNS(SVG_NS, 'path');
          p.setAttribute('d', sourcePath.getAttribute('d') || '');
          const s = sourcePath.getAttribute('stroke');
          if (s) p.style.stroke = s;
          p.dataset.lineId  = imp.id + '-' + i;
          p.dataset.groupId = '__imported';
          layer.appendChild(p);
        });
      });
      if (!groupById['__imported']) {
        groupById['__imported'] = {
          id: '__imported',
          trigger: null,
          defaults: { translateX: 0, translateY: -40, rotate: 0, drawIn: false }
        };
      }
    }

    // Animate each rendered line per its group's behaviors + overrides.
    layer.querySelectorAll('path[data-line-id]').forEach(function (pathEl) {
      const group = groupById[pathEl.dataset.groupId];
      if (!group) return;

      const lineDef = lines.find(function (l) { return l.id === pathEl.dataset.lineId; }) || {};
      const behaviors = Object.assign({}, group.defaults || {}, lineDef.overrides || {});

      const triggerSel = group.trigger || 'body';
      const triggerEl = document.querySelector(triggerSel);
      if (!triggerEl) return;

      const target = { transformOrigin: '50% 50%' };
      let hasMotion = false;
      if (typeof behaviors.translateX === 'number') { target.x        = behaviors.translateX; hasMotion = true; }
      if (typeof behaviors.translateY === 'number') { target.y        = behaviors.translateY; hasMotion = true; }
      if (typeof behaviors.rotate     === 'number') { target.rotation = behaviors.rotate;     hasMotion = true; }

      if (hasMotion) {
        gsap.fromTo(pathEl,
          { x: 0, y: 0, rotation: 0, transformOrigin: '50% 50%' },
          Object.assign({}, target, {
            scrollTrigger: {
              trigger: triggerEl,
              start: 'top bottom',
              end: 'bottom top',
              scrub: 1
            }
          })
        );
      }

      // Draw-in: stroke-dash reveal across the same scroll range.
      if (behaviors.drawIn) {
        let len = 0;
        try { len = pathEl.getTotalLength(); } catch (e) { /* path may be malformed */ }
        if (len > 0) {
          pathEl.style.strokeDasharray  = len + ' ' + len;
          pathEl.style.strokeDashoffset = len;
          gsap.fromTo(pathEl,
            { strokeDashoffset: len },
            {
              strokeDashoffset: 0,
              ease: 'none',
              scrollTrigger: {
                trigger: triggerEl,
                start: 'top bottom',
                end: 'bottom top',
                scrub: 1
              }
            }
          );
        }
      }
    });
  }
})();
