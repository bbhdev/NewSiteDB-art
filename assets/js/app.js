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

    // Render JSON-defined lines. Hidden lines are skipped entirely on
    // the live site — the editor's Visible toggle is the gate.
    lines.forEach(function (line) {
      if (line.hidden) return;
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

    // Optional dev aids. The editor's toggle buttons (Labels, Grid)
    // are stored in localStorage (shared origin), so when the author
    // enables them they see the same aids on the live site too.
    // Other visitors don't have the flags set → no overlay.
    const hasLS = (typeof localStorage !== 'undefined');
    const diagMode = hasLS && localStorage.getItem('ed-show-diag-grid') === '1';
    if (hasLS && localStorage.getItem('ed-show-labels') === '1') {
      renderRuntimeLabels(layer, lines, groups, groupById, paletteById);
      // Page-area outline + reference markers (see v0.1.21).
      renderRuntimePageGuide(layer);
    }
    if (diagMode) {
      renderRuntimeDiagGrid(layer);
      try { window.scrollTo(0, 0); } catch (e) { /* not all envs */ }
      mountScrollProgressIndicator();
      // Per-line bbox-vs-params dump runs after motion setup below so
      // it observes the actual rendered transform.
      window.__diagLines = lines;
    }

    // Animate each rendered line per its group's behaviors + overrides.
    layer.querySelectorAll('path[data-line-id]').forEach(function (pathEl) {
      const group = groupById[pathEl.dataset.groupId];
      if (!group) return;

      const lineDef = lines.find(function (l) { return l.id === pathEl.dataset.lineId; }) || {};
      const behaviors = Object.assign({}, group.defaults || {}, lineDef.overrides || {});

      const triggerSel = group.trigger || 'body';
      const isPageWide = !group.trigger || group.trigger === 'body' || group.trigger === 'html';

      // Build the ScrollTrigger config once and reuse it for the
      // motion tween and the drawIn tween — same scroll progress
      // drives both.
      //
      //   page-wide  → no trigger element. Raw scroll positions
      //                start: 0 (top of document) and end: 'max'
      //                (max scrollable position). This is the
      //                canonical way to drive a tween over the
      //                whole document, and it sidesteps the silent
      //                no-fire behavior we hit when using `body` as
      //                a trigger element with 'top top' / 'bottom
      //                bottom' (ScrollTrigger doesn't compute the
      //                range correctly for `body` itself).
      //
      //   section    → trigger on the named element. Animation runs
      //                while the section sweeps through the viewport
      //                (top reaches bottom-of-viewport → bottom
      //                reaches top-of-viewport).
      let stConfig;
      if (isPageWide) {
        stConfig = { start: 0, end: 'max', scrub: 1 };
      } else {
        const triggerEl = document.querySelector(triggerSel);
        if (!triggerEl) {
          console.warn('[lines] group "' + (group.name || group.id) + '" trigger "' +
                       triggerSel + '" did not match any element — ' +
                       'its lines will render but not animate.');
          return;
        }
        stConfig = {
          trigger: triggerEl,
          start: 'top bottom',
          end:   'bottom top',
          scrub: 1
        };
      }

      // ── Rotation pivot ──────────────────────────────────────────
      // SVG's native `rotate(angle, cx, cy)` syntax has a built-in
      // origin parameter, so we use the SVG `transform` attribute
      // directly. Sidesteps the GSAP svgOrigin / CSS transform-box
      // route that didn't take effect for custom origins.
      //
      // Priority:
      //   1. Explicit rotateOriginX/Y from the behavior — lets the
      //      user place the pivot anywhere on the page.
      //   2. Primitive's geometric center (cx/cy or rect-center).
      //   3. Fallback to path's bbox center via getBBox().
      let originX = 0, originY = 0;
      if (Number.isFinite(behaviors.rotateOriginX) &&
          Number.isFinite(behaviors.rotateOriginY)) {
        originX = behaviors.rotateOriginX;
        originY = behaviors.rotateOriginY;
      } else if (lineDef.params) {
        const pa = lineDef.params;
        if ('cx' in pa && 'cy' in pa) {
          originX = pa.cx; originY = pa.cy;
        } else if ('x' in pa && 'y' in pa && 'w' in pa && 'h' in pa) {
          originX = pa.x + pa.w / 2;
          originY = pa.y + pa.h / 2;
        }
      } else {
        try {
          const b = pathEl.getBBox();
          originX = b.x + b.width  / 2;
          originY = b.y + b.height / 2;
        } catch (e) { /* bbox unavailable for malformed paths */ }
      }

      const tx  = (typeof behaviors.translateX === 'number') ? behaviors.translateX : 0;
      const ty  = (typeof behaviors.translateY === 'number') ? behaviors.translateY : 0;
      const rot = (typeof behaviors.rotate     === 'number') ? behaviors.rotate     : 0;
      const hasMotion = (tx !== 0 || ty !== 0 || rot !== 0);

      // Initial state: identity-equivalent transform. The path renders
      // exactly at its authored `d` coordinates at scroll 0 — same as
      // the editor. (Previously GSAP's CSS-based transform plus
      // transform-box: fill-box was causing subpixel rendering
      // differences between draw-time and runtime.)
      pathEl.setAttribute(
        'transform',
        'translate(0 0) rotate(0 ' + originX + ' ' + originY + ')'
      );

      // Diagnostic mode (Grid toggle on): paths render at their authored
      // d coordinates with identity transform — matches the editor canvas
      // exactly so the author can compare positions. Skip ScrollTrigger
      // setup so per-element triggers can't apply a mid-viewport progress
      // at scrollY=0.
      if (hasMotion && !diagMode) {
        ScrollTrigger.create({
          trigger: stConfig.trigger,
          start:   stConfig.start,
          end:     stConfig.end,
          scrub:   stConfig.scrub,
          onUpdate: function (self) {
            const p   = self.progress;
            const px  = p * tx;
            const py  = p * ty;
            const pr  = p * rot;
            pathEl.setAttribute(
              'transform',
              'translate(' + px + ' ' + py + ') ' +
              'rotate(' + pr + ' ' + originX + ' ' + originY + ')'
            );
          }
        });
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
      // Diagnostic mode: skip the drawIn reveal so the full path is
      // visible at scroll=0 (matches the editor's render).
      if (behaviors.drawIn && !diagMode) {
        pathEl.setAttribute('pathLength',       '1');
        pathEl.setAttribute('stroke-dasharray', '1 1');
        const dir = behaviors.drawInDirection === 'reverse' ? -1 : 1;
        pathEl.setAttribute('stroke-dashoffset', String(dir));
        gsap.fromTo(pathEl,
          { attr: { 'stroke-dashoffset': dir } },
          {
            attr: { 'stroke-dashoffset': 0 },
            ease: 'none',
            scrollTrigger: stConfig
          }
        );
      }
    });

    // Diagnostic dump: for every named line, log
    //   { id, name, expected_cx, expected_cy, bbox_cx, bbox_cy,
    //     shift_x, shift_y, transform_attr }
    // so the author can pinpoint whether the shift is in the d-string
    // (params vs bbox center) or in the applied transform.
    if (diagMode) {
      requestAnimationFrame(function () {
        const rows = [];
        lines.forEach(function (line) {
          if (line.hidden || !line.name) return;
          const pathEl = layer.querySelector('path[data-line-id="' + line.id + '"]');
          if (!pathEl) return;
          let expCx = null, expCy = null;
          if (line.params) {
            const pa = line.params;
            if ('cx' in pa && 'cy' in pa) { expCx = pa.cx; expCy = pa.cy; }
            else if ('x' in pa && 'y' in pa && 'w' in pa && 'h' in pa) {
              expCx = pa.x + pa.w / 2; expCy = pa.y + pa.h / 2;
            }
          }
          let bbCx = null, bbCy = null;
          try {
            const b = pathEl.getBBox();
            bbCx = b.x + b.width / 2;
            bbCy = b.y + b.height / 2;
          } catch (e) { /* malformed */ }
          rows.push({
            id: line.id,
            name: line.name,
            kind: line.kind || '',
            expected_cx: expCx, expected_cy: expCy,
            bbox_cx: bbCx != null ? +bbCx.toFixed(1) : null,
            bbox_cy: bbCy != null ? +bbCy.toFixed(1) : null,
            shift_x: (expCx != null && bbCx != null) ? +(bbCx - expCx).toFixed(1) : null,
            shift_y: (expCy != null && bbCy != null) ? +(bbCy - expCy).toFixed(1) : null,
            transform: pathEl.getAttribute('transform')
          });
        });
        if (rows.length && console.table) console.table(rows);
        else console.log('[lines diag]', rows);
      });
    }
  }

  /**
   * Render developer-facing name labels next to each named line, with
   * the same double-stroke text + double-bordered rect treatment used
   * in the editor. Only invoked when the editor's Labels toggle is on
   * (read from localStorage).
   */
  /**
   * Draw the page-area outline + a few internal reference points on
   * the live SVG layer. Author-facing dev aid — only shown when the
   * editor's Labels toggle is on, so other visitors never see it.
   *
   * The outline matches the editor's bg-page rect exactly (0 0
   * 1200 800 in viewBox coords). Center + four corners get small
   * crosshairs with their viewBox coords printed, so the author can
   * confirm at a glance where the design canvas's coordinates land
   * inside the actual viewport.
   */
  /**
   * Diagnostic coord grid, mirroring the one the editor draws when
   * its Grid button is on. Cyan, 50px step, coords every 100px
   * (checkerboarded). Renders below labels but above lines so it
   * doesn't obscure shape colors. Inserted as the FIRST child of the
   * SVG so it always sits behind everything else.
   */
  /**
   * Small floating "scroll: N%" indicator pinned to the top-right of
   * the viewport. Only shown alongside the diagnostic grid (since it
   * piggybacks on the same Grid toggle in the editor). Lets the
   * author tell at a glance whether a shape's apparent position is
   * affected by scroll-driven animation: at 0%, lines sit at their
   * authored coords; anywhere else, translates / rotations are
   * partially applied.
   */
  function mountScrollProgressIndicator() {
    if (document.getElementById('diag-scroll-progress')) return;
    const el = document.createElement('div');
    el.id = 'diag-scroll-progress';
    el.style.cssText =
      'position:fixed;top:8px;right:8px;z-index:200;' +
      'background:rgba(0,0,0,0.78);color:#FF00FF;' +
      'font-family:ui-monospace,monospace;font-size:13px;' +
      'padding:0.35em 0.7em;border-radius:4px;' +
      'pointer-events:none;letter-spacing:0.04em;';
    document.body.appendChild(el);

    function update() {
      const max = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
      const p = max > 0 ? (window.scrollY / max) : 0;
      el.textContent = 'scroll ' + (p * 100).toFixed(1) + '%' +
                       ' · y=' + Math.round(window.scrollY) +
                       ' / ' + Math.round(max);
    }
    update();
    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
  }

  function renderRuntimeDiagGrid(layer) {
    const SVG_NS_LOCAL = 'http://www.w3.org/2000/svg';
    const g = document.createElementNS(SVG_NS_LOCAL, 'g');
    g.setAttribute('id', 'runtime-diag-grid');
    g.style.pointerEvents = 'none';
    const X0 = -600, X1 = 1800, Y0 = -400, Y1 = 1200;
    const STEP = 50, LABEL_STEP = 100;
    function ln(x1, y1, x2, y2, opacity) {
      const l = document.createElementNS(SVG_NS_LOCAL, 'line');
      l.setAttribute('x1', x1); l.setAttribute('y1', y1);
      l.setAttribute('x2', x2); l.setAttribute('y2', y2);
      // Magenta on the live site (the editor uses cyan against its
      // dark canvas; magenta reads better against the beige page bg).
      l.setAttribute('stroke', '#FF00FF');
      l.setAttribute('stroke-opacity', opacity);
      l.setAttribute('stroke-width', '1');
      l.style.vectorEffect = 'non-scaling-stroke';
      return l;
    }
    for (let x = X0; x <= X1; x += STEP) {
      g.appendChild(ln(x, Y0, x, Y1, x % LABEL_STEP === 0 ? '0.5' : '0.2'));
    }
    for (let y = Y0; y <= Y1; y += STEP) {
      g.appendChild(ln(X0, y, X1, y, y % LABEL_STEP === 0 ? '0.5' : '0.2'));
    }
    for (let x = X0; x <= X1; x += LABEL_STEP) {
      for (let y = Y0; y <= Y1; y += LABEL_STEP) {
        if (((x / LABEL_STEP) + (y / LABEL_STEP)) & 1) continue;
        const t = document.createElementNS(SVG_NS_LOCAL, 'text');
        t.setAttribute('x', x + 3); t.setAttribute('y', y + 12);
        t.setAttribute('fill', '#FF00FF');
        t.setAttribute('font-size', '10');
        t.setAttribute('font-family', 'ui-monospace, monospace');
        t.style.opacity = '0.75';
        t.textContent = x + ',' + y;
        g.appendChild(t);
      }
    }
    // Behind everything else.
    layer.insertBefore(g, layer.firstChild);
  }

  function renderRuntimePageGuide(layer) {
    const SVG_NS_LOCAL = 'http://www.w3.org/2000/svg';

    const rect = document.createElementNS(SVG_NS_LOCAL, 'rect');
    rect.setAttribute('x', 0);
    rect.setAttribute('y', 0);
    rect.setAttribute('width',  1200);
    rect.setAttribute('height', 800);
    rect.setAttribute('fill', 'none');
    rect.setAttribute('stroke', '#9a4');
    rect.setAttribute('stroke-width', 1);
    rect.setAttribute('stroke-dasharray', '8 4');
    rect.style.vectorEffect = 'non-scaling-stroke';
    rect.style.pointerEvents = 'none';
    layer.appendChild(rect);

    // Reference markers — viewBox corners + center. Each is a small
    // crosshair + coord label so the author can spot-check the
    // viewBox-to-viewport mapping.
    const marks = [
      { x: 0,    y: 0,    label: '(0, 0)'     },
      { x: 1200, y: 0,    label: '(1200, 0)'  },
      { x: 0,    y: 800,  label: '(0, 800)'   },
      { x: 1200, y: 800,  label: '(1200, 800)'},
      { x: 600,  y: 400,  label: '(600, 400)' }
    ];
    marks.forEach(function (m) {
      const g = document.createElementNS(SVG_NS_LOCAL, 'g');
      g.setAttribute('transform', 'translate(' + m.x + ',' + m.y + ')');
      // Crosshair
      const sz = 6;
      const h = document.createElementNS(SVG_NS_LOCAL, 'line');
      h.setAttribute('x1', -sz); h.setAttribute('y1', 0);
      h.setAttribute('x2',  sz); h.setAttribute('y2', 0);
      h.setAttribute('stroke', '#9a4'); h.setAttribute('stroke-width', 1.5);
      h.style.vectorEffect = 'non-scaling-stroke';
      g.appendChild(h);
      const v = document.createElementNS(SVG_NS_LOCAL, 'line');
      v.setAttribute('x1', 0); v.setAttribute('y1', -sz);
      v.setAttribute('x2', 0); v.setAttribute('y2',  sz);
      v.setAttribute('stroke', '#9a4'); v.setAttribute('stroke-width', 1.5);
      v.style.vectorEffect = 'non-scaling-stroke';
      g.appendChild(v);
      // Label
      const t = document.createElementNS(SVG_NS_LOCAL, 'text');
      t.setAttribute('x', 8); t.setAttribute('y', -8);
      t.setAttribute('fill', '#9a4');
      t.setAttribute('font-family', 'ui-monospace, monospace');
      t.setAttribute('font-size', 11);
      t.style.pointerEvents = 'none';
      t.textContent = m.label;
      g.appendChild(t);
      g.style.pointerEvents = 'none';
      layer.appendChild(g);
    });
  }

  function renderRuntimeLabels(layer, lines, groups, groupById, paletteById) {
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
      text.setAttribute('font-family', 'system-ui, -apple-system, sans-serif');
      text.setAttribute('font-size', 14);
      text.setAttribute('font-weight', 600);
      text.setAttribute('dominant-baseline', 'hanging');
      // Two-line label: "Gx <name>" on the first line, "(x, y)" coords
      // on the second. Matches the editor exactly so the user can
      // compare draw-position vs runtime-position when chasing
      // initial-position bugs.
      const gIdx = groups.findIndex(function (gg) { return gg.id === line.groupId; });
      const groupTag = gIdx >= 0 ? 'G' + (gIdx + 1) + ' ' : '';
      const nameSpan = document.createElementNS(SVG_NS, 'tspan');
      nameSpan.setAttribute('x', 6);
      nameSpan.textContent = groupTag + line.name;
      text.appendChild(nameSpan);
      // Use the same `pos` we computed above (offset by 6,6 from the
      // line's center) minus the offset to recover the actual center.
      const cx = pos.x - 6;
      const cy = pos.y - 6;
      const coords = document.createElementNS(SVG_NS, 'tspan');
      coords.setAttribute('x', 6);
      coords.setAttribute('dy', '1.15em');
      coords.setAttribute('font-size', 11);
      coords.setAttribute('font-weight', 400);
      coords.textContent = '(' + Math.round(cx) + ', ' + Math.round(cy) + ')';
      text.appendChild(coords);
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
      outer.setAttribute('fill', 'white');
      outer.setAttribute('stroke', fill);
      outer.setAttribute('stroke-width', 3);
      outer.style.vectorEffect = 'non-scaling-stroke';
      g.insertBefore(outer, text);
    });
  }
})();
