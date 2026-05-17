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
              // Constrain to the viewport so an enthusiastic throw can't
              // send a button off-screen where it becomes unreachable.
              // High edgeResistance gives a rubbery feel approaching the
              // edges instead of a hard stop. Bouncing-off-walls is the
              // ideal endgame but needs a custom physics loop on top of
              // GSAP's inertia; deferred for now.
              bounds: window,
              edgeResistance: 0.85,
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
    const palette    = Array.isArray(data.palette)    ? data.palette    : [];
    const svgImports = Array.isArray(data.svgImports) ? data.svgImports : [];

    if (!lines.length && !svgImports.length) return;

    const SVG_NS = 'http://www.w3.org/2000/svg';
    const groupById = {};
    groups.forEach(function (g) { groupById[g.id] = g; });
    const paletteById = {};
    palette.forEach(function (c) { paletteById[c.id] = c; });

    /**
     * Resolve a stroke value. Lines and group defaults store a palette
     * color ID (e.g. "text"); the runtime looks up the actual CSS color.
     * If the value isn't a palette ID it's treated as a literal CSS
     * color, keeping backward compatibility with pre-palette data.
     */
    function resolveStroke(ref) {
      if (!ref) return null;
      return paletteById[ref] ? paletteById[ref].value : ref;
    }

    // Render JSON-defined lines.
    lines.forEach(function (line) {
      const p = document.createElementNS(SVG_NS, 'path');
      p.setAttribute('d', line.d);
      // Effective stroke / width: line value wins, then group default,
      // else fall back to the CSS rule on #lines-layer path.
      // Set via style (not the SVG attribute) so var(--…) resolves —
      // SVG presentation attributes don't evaluate CSS vars in most browsers.
      const group = groupById[line.groupId];
      const strokeRef = line.stroke || (group && group.defaults && group.defaults.stroke) || null;
      const stroke    = resolveStroke(strokeRef);
      const width  = (line.width != null) ? line.width
                   : (group && group.defaults && group.defaults.width != null ? group.defaults.width : null);
      if (stroke) p.style.stroke = stroke;
      if (width)  p.style.strokeWidth = width;
      // Fill: `filled` is authoritative when set (true for primitives,
      // closed-loop freehand, and any explicit author choice); falls
      // back to `closed` for legacy data without `filled`.
      const wantsFill = line.filled !== undefined ? !!line.filled : !!line.closed;
      if (wantsFill && stroke) p.style.fill = stroke;
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

    // Optional name labels. The editor's "Labels" toggle is stored in
    // localStorage (shared origin), so when the author enables it they
    // see labels on the live site too. Labels never appear for other
    // visitors (their localStorage doesn't have the flag set).
    if (typeof localStorage !== 'undefined' &&
        localStorage.getItem('ed-show-labels') === '1') {
      renderRuntimeLabels(layer, lines, groupById, paletteById);
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
      //
      // KNOWN QUIRK: the forward (begin → end) direction occasionally
      // shows a faint "phantom" sliver beyond the path's end at low
      // scroll progress. The reverse (end → begin) direction does not.
      // Multiple attempts to fix it (pathLength normalization in v0.1.8,
      // attribute-based animation in v0.1.9) cleared reverse but left
      // forward affected — almost certainly a browser-level rendering
      // quirk in how stroke-dasharray + non-scaling-stroke interact
      // with positive dashoffsets on stretched viewBoxes. The visual
      // effect is mild and reads as intentional, so it's left as-is
      // per the project owner's call. The code below is the cleanest
      // implementation we landed on.
      //
      // pathLength="1" normalizes all stroke-length calculations to a
      // path of length 1, so dasharray "1 1" and dashoffset ±1 → 0
      // work regardless of the path's actual geometric length or any
      // non-uniform transform.
      //
      // Direction:
      //   forward  — dashoffset animates from +1 to 0; reveals begin → end.
      //   reverse  — dashoffset animates from −1 to 0; reveals end → begin.
      if (behaviors.drawIn) {
        pathEl.setAttribute('pathLength',       '1');
        pathEl.setAttribute('stroke-dasharray', '1 1');
        const dir = behaviors.drawInDirection === 'reverse' ? -1 : 1;
        pathEl.setAttribute('stroke-dashoffset', String(dir));
        gsap.fromTo(pathEl,
          { attr: { 'stroke-dashoffset': dir } },
          {
            attr: { 'stroke-dashoffset': 0 },
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
    });
  }

  /**
   * Render developer-facing name labels next to each named line, with
   * the same double-stroke text + double-bordered rect treatment used
   * in the editor. Only invoked when the editor's Labels toggle is on
   * (read from localStorage).
   */
  function renderRuntimeLabels(layer, lines, groupById, paletteById) {
    const SVG_NS = 'http://www.w3.org/2000/svg';
    function resolveStroke(ref) {
      if (!ref) return null;
      return paletteById[ref] ? paletteById[ref].value : ref;
    }
    lines.forEach(function (line) {
      if (!line.name) return;
      const pathEl = layer.querySelector('path[data-line-id="' + line.id + '"]');
      if (!pathEl) return;

      // Position by line type:
      //   - primitives: use their geometric center from `params`.
      //   - free-form lines: middle of `points`.
      //   - legacy seed data with neither: path bbox center.
      let pos;
      if (line.params) {
        const p = line.params;
        if ('cx' in p && 'cy' in p) {
          pos = { x: p.cx + 6, y: p.cy + 6 };
        } else if ('x' in p && 'y' in p && 'w' in p && 'h' in p) {
          pos = { x: p.x + p.w / 2 + 6, y: p.y + p.h / 2 + 6 };
        }
      }
      if (!pos && Array.isArray(line.points) && line.points.length) {
        const mid = line.points[Math.floor(line.points.length / 2)];
        pos = { x: mid.x + 6, y: mid.y + 6 };
      }
      if (!pos) {
        try {
          const b = pathEl.getBBox();
          pos = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
        } catch (e) { return; }
      }

      const group = groupById[line.groupId];
      const strokeRef = line.stroke || (group && group.defaults && group.defaults.stroke) || null;
      const fill = resolveStroke(strokeRef) || '#aaa';

      const g = document.createElementNS(SVG_NS, 'g');
      g.setAttribute('transform', 'translate(' + pos.x + ',' + pos.y + ')');
      const text = document.createElementNS(SVG_NS, 'text');
      text.setAttribute('x', 6); text.setAttribute('y', 4);
      text.setAttribute('fill', '#000');
      text.setAttribute('stroke', '#fff');
      text.setAttribute('stroke-width', 3);
      text.setAttribute('paint-order', 'stroke fill');
      text.setAttribute('font-family', 'system-ui, -apple-system, sans-serif');
      text.setAttribute('font-size', 14);
      text.setAttribute('font-weight', 600);
      text.setAttribute('dominant-baseline', 'hanging');
      text.textContent = line.name;
      g.appendChild(text);
      layer.appendChild(g);

      const bb = text.getBBox();
      const pad = 4;
      const outer = document.createElementNS(SVG_NS, 'rect');
      outer.setAttribute('x',      (bb.x - pad).toFixed(1));
      outer.setAttribute('y',      (bb.y - pad).toFixed(1));
      outer.setAttribute('width',  (bb.width + pad * 2).toFixed(1));
      outer.setAttribute('height', (bb.height + pad * 2).toFixed(1));
      outer.setAttribute('rx', 3);
      outer.setAttribute('fill', fill);
      outer.setAttribute('stroke', '#000');
      outer.setAttribute('stroke-width', 2);
      outer.style.vectorEffect = 'non-scaling-stroke';
      g.insertBefore(outer, text);

      const inner = document.createElementNS(SVG_NS, 'rect');
      inner.setAttribute('x',      (bb.x - pad + 1).toFixed(1));
      inner.setAttribute('y',      (bb.y - pad + 1).toFixed(1));
      inner.setAttribute('width',  (bb.width + pad * 2 - 2).toFixed(1));
      inner.setAttribute('height', (bb.height + pad * 2 - 2).toFixed(1));
      inner.setAttribute('rx', 2);
      inner.setAttribute('fill', 'none');
      inner.setAttribute('stroke', '#fff');
      inner.setAttribute('stroke-width', 1);
      inner.style.vectorEffect = 'non-scaling-stroke';
      g.insertBefore(inner, text);
    });
  }
})();
