(function () {
  'use strict';

  if (!window.gsap) return;
  gsap.registerPlugin(ScrollTrigger);
  if (window.Draggable)      gsap.registerPlugin(Draggable);
  if (window.InertiaPlugin)  gsap.registerPlugin(InertiaPlugin);

  initZoomCompensation();
  initCircleButtons();
  initLineSystem();

  /**
   * v0.8.18: Browser-zoom compensation for #lines-layer.
   *
   * Browser zoom (Ctrl/Cmd +/-) scales text physically but leaves
   * a vw/vh-sized SVG layer the same physical size on screen, so
   * decoration calibrated at 100% drifts visibly at any other
   * zoom. We write two CSS custom properties on :root that the
   * #lines-layer rule consumes:
   *
   *   --zoom-scale     current zoom factor; the rule multiplies
   *                    every vw/vh by it so the layer's CSS-px
   *                    box stays constant across zoom levels.
   *                    Constant CSS box → constant viewBox→CSS
   *                    mapping → marks land on the same CSS
   *                    coords as text does at any zoom.
   *
   *   --layout-shift-x horizontal offset of `.layout` (the
   *                    centered-column container) relative to
   *                    its CSS-x position at calibration. The
   *                    vw*scale dance keeps the layer fixed to
   *                    the viewport, but a max-width column
   *                    slides as the viewport CSS shrinks under
   *                    zoom; we apply the delta as a transform:
   *                    translateX so the layer follows.
   *
   * Zoom is detected from three signals (devicePixelRatio ratio,
   * outerWidth/innerWidth ratio, visualViewport.scale); we pick
   * whichever has moved furthest from 1 in log space, since
   * different browsers update different signals on Ctrl/Cmd +/-.
   *
   * No-op for pages without a `.layout` element — vertical
   * alignment still works, only the horizontal compensation goes
   * to 0.
   */
  function initZoomCompensation() {
    const baseDPR = window.devicePixelRatio || 1;
    const baseOI  = window.outerWidth / Math.max(1, window.innerWidth);

    function getLayoutLeft() {
      const el = document.querySelector('.layout');
      return el ? el.getBoundingClientRect().left : 0;
    }
    const baseLayoutLeft = getLayoutLeft();

    function currentZoom() {
      const dprZ = (window.devicePixelRatio || 1) / baseDPR;
      const oiZ  = (window.outerWidth / Math.max(1, window.innerWidth)) / baseOI;
      const vvZ  = (window.visualViewport && window.visualViewport.scale) || 1;
      let best = 1, bestDist = 0;
      [dprZ, oiZ, vvZ].forEach(function (v) {
        const d = Math.abs(Math.log(v || 1));
        if (d > bestDist) { bestDist = d; best = v; }
      });
      return best;
    }

    function apply() {
      const z = currentZoom();
      const shiftX = getLayoutLeft() - baseLayoutLeft;
      document.documentElement.style.setProperty('--zoom-scale', z);
      document.documentElement.style.setProperty('--layout-shift-x', shiftX.toFixed(2) + 'px');
    }

    apply();
    window.addEventListener('resize', apply);
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', apply);
    }
  }

  /**
   * Read a behavior block's trigger field, healing legacy shapes to
   * the v0.8.7 schema. Mirrors editor's cloneBehaviorTrigger so a
   * page rendered before the CLI migration ran still animates.
   *
   *   v0.8.7+:  trigger = { when, range?, selector?, delay }
   *   v0.8.1:   trigger = { type:'time', delay, duration }  →  page-load
   *   v0.8.0-:  no trigger; block.range carries scroll-range → scroll-range
   */
  function normalizeTrigger(b) {
    if (b.trigger && typeof b.trigger === 'object' && b.trigger.when) {
      const out = {
        when:  b.trigger.when,
        delay: Number(b.trigger.delay) || 0
      };
      if (b.trigger.range) {
        out.range = {
          start: Number(b.trigger.range.start) || 0,
          end:   Number(b.trigger.range.end)   || 1
        };
      }
      if (b.trigger.selector) out.selector = String(b.trigger.selector);
      if (b.trigger.viewportAt) out.viewportAt = String(b.trigger.viewportAt);
      if (b.trigger.repeat)     out.repeat     = String(b.trigger.repeat);
      return out;
    }
    if (b.trigger && b.trigger.type === 'time') {
      return { when: 'page-load', delay: Number(b.trigger.delay) || 0 };
    }
    const r = (b.range && typeof b.range === 'object')
      ? { start: Number(b.range.start) || 0, end: Number(b.range.end) || 1 }
      : { start: 0, end: 1 };
    return { when: 'scroll-range', range: r, delay: 0 };
  }

  function normalizeDuration(b) {
    if (b.duration && typeof b.duration === 'object' && b.duration.mode) {
      const out = { mode: b.duration.mode };
      if (typeof b.duration.seconds === 'number') out.seconds = b.duration.seconds;
      if (b.duration.easing) out.easing = String(b.duration.easing);
      return out;
    }
    if (b.trigger && b.trigger.type === 'time') {
      const s = Number(b.trigger.duration);
      return { mode: 'time', seconds: (s > 0 ? s : 1) };
    }
    return { mode: 'scroll' };
  }

  /**
   * For each [data-scatter-btn] (.c-button and .e-button both carry
   * it), on desktop only:
   *
   *   Scroll-scrub drift  →  drives --scrub-x / --scrub-y CSS vars on the
   *                          anchor; CSS uses them to translate the inner
   *                          shape + text. This leaves the anchor's own
   *                          transform free for Draggable.
   *
   *   Draggable           →  moves the anchor (translate via GSAP).
   *
   *   Composition         →  the visible shape ends up at:
   *                          anchor_layout_position
   *                            + draggable.translate
   *                            + scroll_scrub.translate
   *
   *   First-drag handoff  →  the moment the user drags a button, we tween
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
    const buttons = document.querySelectorAll('[data-scatter-btn]');
    if (!buttons.length) return;

    const container = buttons[0].closest('.c-buttons') || buttons[0].parentElement;

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

    // v3 payload shape:
    //   classes    — [{id, name, minWidth, maxWidth}, …] site-wide breakpoints
    //   page       — { useClasses, dims: { <classId>: {pageW,pageH,canvasW,canvasH} } }
    //   byClass    — { <classId>: { lines, groups } }
    //   palette    — site-wide colors
    //   svgImports — page-level dropped SVGs (not class-varying)
    const classes    = Array.isArray(data.classes)    ? data.classes    : [];
    const pageCfg    = (data.page && typeof data.page === 'object') ? data.page : {};
    const byClass    = (data.byClass && typeof data.byClass === 'object') ? data.byClass : {};
    const palette    = Array.isArray(data.palette)    ? data.palette    : [];
    const svgImports = Array.isArray(data.svgImports) ? data.svgImports : [];

    const useClasses = Array.isArray(pageCfg.useClasses) ? pageCfg.useClasses : [];
    const dimsByClass = (pageCfg.dims && typeof pageCfg.dims === 'object') ? pageCfg.dims : {};

    // No data at all → nothing to render; bail early so we don't even
    // bind the resize listener.
    const anyClassHasContent = useClasses.some(function (id) {
      const c = byClass[id];
      return c && ((Array.isArray(c.lines) && c.lines.length) || (Array.isArray(c.groups) && c.groups.length));
    });
    if (!anyClassHasContent && !svgImports.length) return;

    const SVG_NS = 'http://www.w3.org/2000/svg';
    const paletteById = {};
    palette.forEach(function (c) { paletteById[c.id] = c; });

    // ── Class selection ────────────────────────────────────────────
    function pickClassFor(width) {
      // Among the classes this page uses, prefer one whose [min, max]
      // contains the viewport width. If none matches (gap between
      // breakpoints, or viewport above the largest defined max with
      // no unbounded class), fall back to the class with the largest
      // minWidth ≤ width, else the first useClass.
      const usable = classes.filter(function (c) { return useClasses.indexOf(c.id) !== -1 && byClass[c.id]; });
      if (!usable.length) return null;
      for (let i = 0; i < usable.length; i++) {
        const c = usable[i];
        const minOk = (c.minWidth == null || width >= c.minWidth);
        const maxOk = (c.maxWidth == null || width <= c.maxWidth);
        if (minOk && maxOk) return c.id;
      }
      let best = usable[0].id, bestMin = -Infinity;
      for (let i = 0; i < usable.length; i++) {
        const c = usable[i];
        const mw = c.minWidth || 0;
        if (mw <= width && mw > bestMin) { best = c.id; bestMin = mw; }
      }
      return best;
    }

    // Track ScrollTriggers we own so re-render (on class boundary
    // cross) can tear them down cleanly without touching unrelated
    // triggers elsewhere in the page.
    const ownTriggers = [];
    // gsap.ticker callbacks registered for time-driven behavior
    // blocks (v0.8.1). Tracked alongside ownTriggers so a class-
    // boundary re-render can detach them.
    const ownTickers = [];
    // v0.8.7: IntersectionObservers created for in-view-partial /
    // in-view-full activations.
    const ownObservers = [];
    // v0.8.11: window scroll listeners for scroll-key activations
    // (crossing-detection — see comments at the registration site).
    const ownListeners = [];
    let currentClassId = null;

    function renderForClass(classId) {
      // Tear down previous render.
      ownTriggers.forEach(function (t) { try { t.kill(); } catch (e) {} });
      ownTriggers.length = 0;
      ownTickers.forEach(function (fn) { try { gsap.ticker.remove(fn); } catch (e) {} });
      ownTickers.length = 0;
      ownObservers.forEach(function (o) { try { o.disconnect(); } catch (e) {} });
      ownObservers.length = 0;
      ownListeners.forEach(function (L) {
        try { L.target.removeEventListener(L.type, L.fn); } catch (e) {}
      });
      ownListeners.length = 0;
      layer.innerHTML = '';
      currentClassId = classId;

      const cls    = byClass[classId] || {};
      const lines  = Array.isArray(cls.lines)  ? cls.lines  : [];
      const groups = Array.isArray(cls.groups) ? cls.groups : [];
      const dims   = dimsByClass[classId]
        || { pageW: 1200, pageH: 800, canvasW: 2400, canvasH: 1600 };
      const groupById = {};
      groups.forEach(function (g) { groupById[g.id] = g; });

      // Apply this class's viewBox so authored coords land where
      // intended for this viewport size.
      const vbx = -(dims.canvasW - dims.pageW) / 2;
      const vby = -(dims.canvasH - dims.pageH) / 2;
      layer.setAttribute('viewBox', vbx + ' ' + vby + ' ' + dims.canvasW + ' ' + dims.canvasH);

      renderClassContent(lines, groups, groupById, dims);
    }

    function renderClassContent(lines, groups, groupById, page) {

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

    // Render JSON-defined lines. Hidden lines (instance or group)
    // are skipped entirely on the live site — the editor's Visible
    // toggles are the gate. Image-kind lines without a src are also
    // skipped (no visible content + no placeholder outline outside
    // the editor).
    lines.forEach(function (line) {
      if (line.hidden) return;
      const group = groupById[line.groupId];
      if (group && group.hidden) return;

      if (line.kind === 'image') {
        if (!line.params || !line.params.src) return;
        const fit = line.params.fit === 'slice' ? 'xMidYMid slice'
                  : line.params.fit === 'fill'  ? 'none'
                  :                                'xMidYMid meet';
        const img = document.createElementNS(SVG_NS, 'image');
        img.setAttributeNS(null, 'href', line.params.src);
        // line.params.x/y are canonical (master coords). Per-class
        // positionOffset comes through as a separate field — apply
        // it via transform=translate, parallel to how the <path>
        // branch below handles offset. Without this the image
        // ignored its positionOffset and rendered at the canonical
        // position even after a per-class drag.
        const offX = (line.positionOffset && Number.isFinite(line.positionOffset.dx))
                     ? line.positionOffset.dx : 0;
        const offY = (line.positionOffset && Number.isFinite(line.positionOffset.dy))
                     ? line.positionOffset.dy : 0;
        img.setAttribute('x', line.params.x);
        img.setAttribute('y', line.params.y);
        img.setAttribute('width',  line.params.w);
        img.setAttribute('height', line.params.h);
        img.setAttribute('preserveAspectRatio', fit);
        if (offX !== 0 || offY !== 0) {
          img.setAttribute('transform', 'translate(' + offX + ' ' + offY + ')');
        }
        img.dataset.lineId  = line.id;
        img.dataset.groupId = line.groupId || '';
        layer.appendChild(img);
        return;
      }

      const p = document.createElementNS(SVG_NS, 'path');
      p.setAttribute('d', line.d);
      // Effective stroke / width: line value wins, then group default,
      // else fall back to the CSS rule on #lines-layer path.
      // Set via style (not the SVG attribute) so var(--…) resolves —
      // SVG presentation attributes don't evaluate CSS vars in most browsers.
      const strokeRef = line.stroke || (group && group.defaults && group.defaults.stroke) || null;
      const stroke    = resolveStroke(strokeRef);
      const width  = (line.width != null) ? line.width
                   : (group && group.defaults && group.defaults.width != null ? group.defaults.width : null);
      if (stroke) p.style.stroke = stroke;
      if (width)  p.style.strokeWidth = width;
      if (line.linejoin) p.style.strokeLinejoin = line.linejoin;
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
    const diagMode    = hasLS && localStorage.getItem('ed-show-diag-grid')    === '1';
    const dumpMode    = hasLS && localStorage.getItem('ed-show-runtime-dump') === '1';
    if (hasLS && localStorage.getItem('ed-show-labels') === '1') {
      renderRuntimeLabels(layer, lines, groups, groupById, paletteById);
    }
    // v0.8.16: page-area outline is now its own flag — useful on its
    // own when authors place objects in the bleed area and want to
    // see where the visible page sits, without the label clutter.
    if (hasLS && localStorage.getItem('ed-show-page-area') === '1') {
      renderRuntimePageGuide(layer, page);
    }
    if (diagMode) {
      renderRuntimeDiagGrid(layer, page);
      try { window.scrollTo(0, 0); } catch (e) { /* not all envs */ }
      mountScrollProgressIndicator();
    }

    // Animate each rendered line per its group's behaviors + overrides.
    // Walk every renderable line element (paths AND images both
    // carry data-line-id) so the scroll-driven transform pipeline
    // below applies to images too. v0.5.17 added a static
    // positionOffset transform on images but didn't wire them to
    // the scrub pipeline; broadening the selector here picks them
    // up so translateX / translateY / rotate behaviors take effect.
    layer.querySelectorAll('[data-line-id]').forEach(function (pathEl) {
      const group = groupById[pathEl.dataset.groupId];
      if (!group) return;

      const lineDef = lines.find(function (l) { return l.id === pathEl.dataset.lineId; }) || {};
      // v0.4.0: behavior keys live on lineDef.behaviors[0].params
      // (single-block UI today; multi-block lands in v0.4.1).
      // Group defaults provide fallbacks for any unset field. If
      // behaviors[] is empty, we fall back to group defaults
      // wholesale — an "uninherited" line carrying no overrides.
      const block0params = (Array.isArray(lineDef.behaviors)
                             && lineDef.behaviors[0]
                             && lineDef.behaviors[0].params)
        ? lineDef.behaviors[0].params : {};
      const behaviors = Object.assign({}, group.defaults || {}, block0params);

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
        // Natural 'top bottom' start = scrollY at which the trigger's
        // top reaches the bottom of the viewport. For elements already
        // partially or fully on-screen at page load this is NEGATIVE,
        // which would otherwise give progress > 0 at scrollY=0 and put
        // paths somewhere other than their authored coords on first
        // paint. Clamp to 0 so the runtime matches the editor at the
        // top of the page; below-the-fold triggers are unaffected.
        stConfig = {
          trigger: triggerEl,
          start: function () {
            const r = triggerEl.getBoundingClientRect();
            const natural = r.top + window.scrollY - window.innerHeight;
            return Math.max(0, natural);
          },
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
      //   1. Per-line rotateOriginX/Y on behaviors[0].params —
      //      treated as a DELTA from the line's natural center
      //      (v0.4.6+). So (0,0) = pivot at center; (50, 0) puts
      //      the pivot 50 to the right of center, traveling with
      //      the object instead of being pinned to a canvas spot.
      //   2. Group default rotateOriginX/Y — absolute canvas
      //      coord. Groups don't have a single natural center
      //      to subtract from; the group-level pivot is a shared
      //      anchor.
      //   3. Otherwise the line's natural center (primitive
      //      params, falling back to bbox).
      let centerX = 0, centerY = 0;
      if (lineDef.params) {
        const pa = lineDef.params;
        if ('cx' in pa && 'cy' in pa) {
          centerX = pa.cx; centerY = pa.cy;
        } else if ('x' in pa && 'y' in pa && 'w' in pa && 'h' in pa) {
          centerX = pa.x + pa.w / 2;
          centerY = pa.y + pa.h / 2;
        } else {
          try {
            const b = pathEl.getBBox();
            centerX = b.x + b.width  / 2;
            centerY = b.y + b.height / 2;
          } catch (e) { /* bbox unavailable */ }
        }
      } else {
        try {
          const b = pathEl.getBBox();
          centerX = b.x + b.width  / 2;
          centerY = b.y + b.height / 2;
        } catch (e) { /* bbox unavailable */ }
      }
      let originX = centerX, originY = centerY;
      const linePivotX = block0params.rotateOriginX;
      const linePivotY = block0params.rotateOriginY;
      if (Number.isFinite(linePivotX) && Number.isFinite(linePivotY)) {
        originX = centerX + linePivotX;
        originY = centerY + linePivotY;
      } else if (Number.isFinite(group.defaults.rotateOriginX) &&
                 Number.isFinite(group.defaults.rotateOriginY)) {
        originX = group.defaults.rotateOriginX;
        originY = group.defaults.rotateOriginY;
      }

      // v0.4.1: multi-block composition. Walk lineDef.behaviors[];
      // each block carries its own trigger + duration + params.
      // Empty behaviors[] falls back to one synthetic block from
      // group defaults so legacy / unmigrated data still animates.
      //
      // v0.8.7: trigger / duration split into orthogonal axes.
      //   trigger.when  ∈ scroll-range | page-load | scroll-key |
      //                   in-view-partial | in-view-full
      //   duration.mode ∈ scroll | time | loop | pingpong
      // Activation timestamp per block (activationState[i]) is the
      // moment the block crossed its trigger; time-based durations
      // measure elapsed from there + trigger.delay.
      const rawBlocks = (Array.isArray(lineDef.behaviors) && lineDef.behaviors.length)
        ? lineDef.behaviors
        : [{ id: '__default', trigger: { when: 'scroll-range', range: { start: 0, end: 1 }, delay: 0 }, duration: { mode: 'scroll' }, kind: 'transform', params: {} }];
      const gd = group.defaults || {};
      const blocks = rawBlocks.map(function (b) {
        const p = b.params || {};
        const num = function (k) {
          return (typeof p[k] === 'number') ? p[k]
               : (typeof gd[k] === 'number') ? gd[k] : 0;
        };
        // Heal legacy shapes here so the runtime never has to
        // branch on two versions. Same logic as editor's
        // cloneBehaviorTrigger / cloneBehaviorDuration.
        const trigger  = normalizeTrigger(b);
        const duration = normalizeDuration(b);
        // v0.8.17: translateMode = fixed (default) | driftX |
        // driftY | driftBoth. In a drift axis, tx/ty is a
        // per-scroll-px multiplier instead of a target
        // displacement — accumulated drift is added on top of
        // the fixed contribution from the other axis.
        const tmode = p.translateMode || gd.translateMode || 'fixed';
        return {
          trigger:  trigger,
          duration: duration,
          tx:       num('translateX'),
          ty:       num('translateY'),
          rot:      num('rotate'),
          translateMode: tmode,
          driftX:   (tmode === 'driftX' || tmode === 'driftBoth'),
          driftY:   (tmode === 'driftY' || tmode === 'driftBoth'),
          drawIn:   typeof p.drawIn === 'boolean' ? p.drawIn : !!gd.drawIn,
          drawInDirection: p.drawInDirection || gd.drawInDirection || 'forward'
        };
      });
      // Per-block easing fn (evaluated once; identity when GSAP
      // can't resolve it).
      const blockEases = blocks.map(function (b) {
        const name = b.duration && b.duration.easing;
        if (!name || name === 'linear') return function (t) { return t; };
        try {
          const fn = (gsap.parseEase && gsap.parseEase(name)) || null;
          return fn || function (t) { return t; };
        } catch (e) {
          return function (t) { return t; };
        }
      });
      const hasMotion = blocks.some(function (b) {
        return b.tx !== 0 || b.ty !== 0 || b.rot !== 0;
      });
      // v0.8.17: drift accumulators — one entry per block. Holds
      // the running translate contribution from per-scroll-px
      // motion, plus the activation timestamp this drift was
      // last bound to (so repeat='every' re-activations zero it).
      const blockDrift = blocks.map(function () {
        return { x: 0, y: 0, lastAct: null };
      });
      // Tracks window.scrollY across ticks so we can convert
      // scroll motion to drift deltas. Captured at line setup
      // time; updated inside tickDrift on every writeAt call.
      let prevScrollY = (typeof window !== 'undefined') ? window.scrollY : 0;
      // Activation state per block. null = not yet activated;
      // otherwise the wall-clock seconds at activation. For
      // 'scroll-range' activation the block becomes active the
      // first time scrollP enters its range; this is needed by
      // time / loop / pingpong duration modes (so seconds count
      // from when the user actually reached the trigger, not
      // page load).
      const activationState = blocks.map(function () { return null; });

      // For each non-scroll duration block, schedule its
      // activation per the `when` axis. scroll-range activations
      // are picked up inside the per-frame writeAt; the other
      // four are wired here.
      const lineStartedAt = performance.now() / 1000;
      blocks.forEach(function (b, i) {
        const when = b.trigger.when;
        // 'scroll-range' for non-scroll durations: activated by
        // scroll progress, handled in writeAt below. For 'scroll'
        // duration no activation timestamp is needed.
        if (when === 'scroll-range') return;
        if (when === 'page-load') {
          // Active immediately at page load. trigger.delay is
          // baked into blockProg's elapsed math (no need to
          // postpone activation itself).
          activationState[i] = lineStartedAt;
          return;
        }
        if (when === 'scroll-key' && b.trigger.selector) {
          const el = document.querySelector(b.trigger.selector);
          if (!el) return;
          // v0.8.11: "Scroll to key" — fire when the key enters a
          //   chosen trigger zone in viewport coords.
          // v0.8.14: 'object' tier — zone is the animated object's
          //   own rect (#lines-layer is fixed, so its viewport rect
          //   is a stable reference each scroll). The rect is read
          //   live, so a block chained after earlier transforms
          //   sees the current rendered position, not the natural
          //   one.
          // v0.8.15: bidirectional enter/leave + repeat tiers.
          //   The zone has an interior; an outside→inside
          //   transition activates. With repeat='every', each
          //   such transition re-activates (timed runs replay,
          //   loop/pingpong phases reset). Initial state is
          //   evaluated at creation so a key already inside the
          //   zone at load doesn't fire — the user has to scroll
          //   out and back in.
          //
          // For viewport-line tiers the zone is "key.top ≤ line";
          // for 'object' the zone is true vertical overlap of the
          // key and object rects (top OR bottom of the key
          // touching the object's rect from either side).
          const viewportAt = b.trigger.viewportAt || 'middle';
          const repeat     = b.trigger.repeat     || 'once';
          const insideZone = function () {
            const keyR = el.getBoundingClientRect();
            if (viewportAt === 'object') {
              const objR = pathEl.getBoundingClientRect();
              return keyR.top <= objR.bottom && keyR.bottom >= objR.top;
            }
            const vh = window.innerHeight;
            const th = viewportAt === 'top'    ? vh * 0.03
                     : viewportAt === 'middle' ? vh * 0.5
                     :                           vh * 0.97;
            return keyR.top <= th;
          };
          let wasInside = insideZone();
          const onScroll = function () {
            const nowInside = insideZone();
            if (!wasInside && nowInside) {
              if (repeat === 'every' || activationState[i] == null) {
                activationState[i] = performance.now() / 1000;
              }
            }
            wasInside = nowInside;
          };
          window.addEventListener('scroll', onScroll, { passive: true });
          ownListeners.push({ target: window, type: 'scroll', fn: onScroll });
          return;
        }
        if (when === 'in-view-partial' || when === 'in-view-full') {
          // Watch the rendered element itself. IntersectionObserver
          // threshold: 0 for partial (any pixel intersects), 1 for
          // fully visible.
          const threshold = (when === 'in-view-full') ? 0.999 : 0.001;
          const obs = new IntersectionObserver(function (entries) {
            entries.forEach(function (entry) {
              if (entry.isIntersecting && activationState[i] == null) {
                activationState[i] = performance.now() / 1000;
              }
            });
          }, { threshold: threshold });
          obs.observe(pathEl);
          ownObservers.push(obs);
          return;
        }
      });

      // Per-block progress at a moment (scrollP + wall clock).
      // scroll-range + scroll duration: progress = scrollP within
      //   range. All non-scroll durations: progress = function of
      //   elapsed wall-clock since activation, gated by delay.
      const blockProg = function (b, idx, scrollP, nowSec) {
        const mode = b.duration && b.duration.mode || 'scroll';
        const when = b.trigger.when;

        // Scroll-driven progress (the only mode that reads
        // scrollP directly).
        if (mode === 'scroll') {
          const r = (b.trigger && b.trigger.range) || { start: 0, end: 1 };
          let p;
          if (scrollP <= r.start) p = 0;
          else if (scrollP >= r.end) p = 1;
          else {
            const span = r.end - r.start;
            p = span > 0 ? (scrollP - r.start) / span : 1;
          }
          return blockEases[idx](p);
        }

        // Time-based modes need an activation timestamp. For
        // 'scroll-range' activation we lazy-activate the first
        // time scrollP enters the range.
        if (activationState[idx] == null) {
          if (when === 'scroll-range') {
            const r = (b.trigger && b.trigger.range) || { start: 0, end: 1 };
            if (scrollP >= r.start) activationState[idx] = nowSec;
            else return 0;
          } else {
            return 0;
          }
        }

        const delay = (b.trigger && b.trigger.delay) || 0;
        const t = nowSec - activationState[idx] - delay;
        if (t <= 0) return 0;
        const dur = (b.duration && b.duration.seconds > 0) ? b.duration.seconds : 1;
        let raw;
        if (mode === 'time') {
          raw = Math.min(1, t / dur);
        } else if (mode === 'loop') {
          raw = (t / dur) % 1;
        } else if (mode === 'pingpong') {
          // Triangle wave 0→1→0 over 2 × dur.
          const phase = (t / dur) % 2;
          raw = phase < 1 ? phase : 2 - phase;
        } else {
          raw = 0;
        }
        return blockEases[idx](raw);
      };
      // v0.8.17: drift accumulator support.
      //   isBlockActive(i): trigger has fired (post-delay) for
      //     non-scroll modes; for scroll mode, scrollP has reached
      //     range.start. Used both to gate drift accumulation and
      //     to detect freeze (block i+1 has activated).
      //   tickDrift: scroll-delta integrator. Runs each writeAt
      //     call; no-op when scrollY hasn't changed since the
      //     last call (the gsap.ticker hits writeAt every frame
      //     but only scroll motion contributes to drift).
      function isBlockActive(i, scrollP, nowSec) {
        if (i < 0 || i >= blocks.length) return false;
        const b = blocks[i];
        const mode = b.duration && b.duration.mode;
        if (mode === 'scroll') {
          const r = (b.trigger && b.trigger.range) || { start: 0, end: 1 };
          return scrollP >= r.start;
        }
        const act = activationState[i];
        if (act == null) return false;
        const delay = (b.trigger && b.trigger.delay) || 0;
        return nowSec >= act + delay;
      }
      function tickDrift(scrollP, nowSec) {
        const sy = window.scrollY;
        const delta = sy - prevScrollY;
        prevScrollY = sy;
        if (delta === 0) return;
        for (let i = 0; i < blocks.length; i++) {
          const b = blocks[i];
          if (!b.driftX && !b.driftY) continue;
          if (!isBlockActive(i, scrollP, nowSec)) continue;
          // Freeze when the immediately next block has activated.
          if (i + 1 < blocks.length && isBlockActive(i + 1, scrollP, nowSec)) continue;
          // Zero the accumulator on each re-activation so
          // repeat='every' triggers actually replay drift.
          if (blockDrift[i].lastAct !== activationState[i]) {
            blockDrift[i].x = 0;
            blockDrift[i].y = 0;
            blockDrift[i].lastAct = activationState[i];
          }
          if (b.driftX) blockDrift[i].x += b.tx * delta;
          if (b.driftY) blockDrift[i].y += b.ty * delta;
        }
      }
      const computeAt = function (scrollP, nowSec) {
        tickDrift(scrollP, nowSec);
        let tx = 0, ty = 0, rot = 0;
        for (let i = 0; i < blocks.length; i++) {
          const b  = blocks[i];
          const bp = blockProg(b, i, scrollP, nowSec);
          tx  += b.driftX ? blockDrift[i].x : bp * b.tx;
          ty  += b.driftY ? blockDrift[i].y : bp * b.ty;
          rot += bp * b.rot;
        }
        return { tx: tx, ty: ty, rot: rot };
      };
      // hasTime: any block whose progress is wall-clock-driven —
      // needs a gsap.ticker so the runtime keeps painting even
      // when the user doesn't scroll.
      // v0.8.17: ticker is also needed for drift blocks so the
      // accumulator updates on scroll motion outside the
      // ScrollTrigger's range (non-page-wide groups). tickDrift
      // itself no-ops when scrollY is unchanged, so the
      // continuous tick is cheap.
      const hasTime = blocks.some(function (b) {
        return (b.duration && b.duration.mode !== 'scroll')
            || b.driftX || b.driftY;
      });
      // v6+: per-class positionOffset baked into the path's transform.
      // line.d is canonical (master geometry) on the runtime side;
      // positionOffset shifts the rendered position without per-class
      // path data. Scroll-driven motion (px / py) layers on top of
      // the static offset. The rotation pivot stays in canonical /
      // pre-translate coords — the translate moves the pivot point
      // visually so the shape rotates around its own (shifted) center.
      const offX = (lineDef.positionOffset && Number.isFinite(lineDef.positionOffset.dx))
                   ? lineDef.positionOffset.dx : 0;
      const offY = (lineDef.positionOffset && Number.isFinite(lineDef.positionOffset.dy))
                   ? lineDef.positionOffset.dy : 0;

      // Initial state: static positionOffset only (no animation yet).
      pathEl.setAttribute(
        'transform',
        'translate(' + offX + ' ' + offY + ') rotate(0 ' + originX + ' ' + originY + ')'
      );

      // Diagnostic mode (Grid toggle on): paths render at their authored
      // d coordinates with identity transform — matches the editor canvas
      // exactly so the author can compare positions. Skip ScrollTrigger
      // setup so per-element triggers can't apply a mid-viewport progress
      // at scrollY=0.
      if (hasMotion && !diagMode) {
        const writeAt = function (scrollP, nowSec) {
          const t = computeAt(scrollP, nowSec);
          pathEl.setAttribute(
            'transform',
            'translate(' + (offX + t.tx) + ' ' + (offY + t.ty) + ') ' +
            'rotate(' + t.rot + ' ' + originX + ' ' + originY + ')'
          );
        };
        const st = ScrollTrigger.create({
          trigger: stConfig.trigger,
          start:   stConfig.start,
          end:     stConfig.end,
          scrub:   stConfig.scrub,
          onUpdate: function (self) {
            writeAt(self.progress, performance.now() / 1000);
          }
        });
        ownTriggers.push(st);
        // Time-driven blocks (any duration.mode !== 'scroll')
        // need per-frame updates independent of scroll — the user
        // might not scroll while a time / loop / pingpong block is
        // animating. gsap.ticker runs at 60fps; we re-read
        // ScrollTrigger's cached progress + the current wall-clock.
        if (hasTime) {
          const tick = function () {
            writeAt(st ? st.progress : 0, performance.now() / 1000);
          };
          gsap.ticker.add(tick);
          ownTickers.push(tick);
        }
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
      // Draw-in: stroke-dash reveal across the same scroll range.
      // Path-only — <image> has no stroke for dashing, so this is
      // a no-op there (would just clutter the element with dash
      // attrs that do nothing).
      if (behaviors.drawIn && !diagMode && pathEl.tagName.toLowerCase() === 'path') {
        pathEl.setAttribute('pathLength',       '1');
        pathEl.setAttribute('stroke-dasharray', '1 1');
        const dir = behaviors.drawInDirection === 'reverse' ? -1 : 1;
        pathEl.setAttribute('stroke-dashoffset', String(dir));
        const tween = gsap.fromTo(pathEl,
          { attr: { 'stroke-dashoffset': dir } },
          {
            attr: { 'stroke-dashoffset': 0 },
            ease: 'none',
            scrollTrigger: stConfig
          }
        );
        if (tween && tween.scrollTrigger) ownTriggers.push(tween.scrollTrigger);
      }
    });

    // Diagnostic dump: for every named line, log
    //   { id, name, expected_cx, expected_cy, bbox_cx, bbox_cy,
    //     shift_x, shift_y, transform_attr }
    // so the author can pinpoint whether the shift is in the d-string
    // (params vs bbox center) or in the applied transform. Gated
    // behind its own toggle so the cost (one rAF + getBBox per named
    // line) is only paid when explicitly requested.
    if (dumpMode) {
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
    }  // ← end renderClassContent

    // ── Bootstrap: pick initial class, render, listen for resize ──
    const initialClassId = pickClassFor(window.innerWidth)
      || (useClasses[0] || 'wide');
    renderForClass(initialClassId);

    // Re-pick on resize across a class boundary; snap-reload (no
    // cross-fade for now). Debounced because resize fires repeatedly
    // during a drag.
    let resizeTimer = null;
    window.addEventListener('resize', function () {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(function () {
        const w = window.innerWidth;
        const nextId = pickClassFor(w);
        if (nextId && nextId !== currentClassId) renderForClass(nextId);
      }, 150);
    });
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

  function renderRuntimeDiagGrid(layer, page) {
    const SVG_NS_LOCAL = 'http://www.w3.org/2000/svg';
    const g = document.createElementNS(SVG_NS_LOCAL, 'g');
    g.setAttribute('id', 'runtime-diag-grid');
    g.style.pointerEvents = 'none';
    // Grid spans the full viewBox: page area + symmetric bleed.
    const bleedX = (page.canvasW - page.pageW) / 2;
    const bleedY = (page.canvasH - page.pageH) / 2;
    const X0 = -bleedX, X1 = page.pageW + bleedX;
    const Y0 = -bleedY, Y1 = page.pageH + bleedY;
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

  function renderRuntimePageGuide(layer, page) {
    const SVG_NS_LOCAL = 'http://www.w3.org/2000/svg';
    const pw = page.pageW, ph = page.pageH;

    const rect = document.createElementNS(SVG_NS_LOCAL, 'rect');
    rect.setAttribute('x', 0);
    rect.setAttribute('y', 0);
    rect.setAttribute('width',  pw);
    rect.setAttribute('height', ph);
    rect.setAttribute('fill', 'none');
    rect.setAttribute('stroke', '#9a4');
    rect.setAttribute('stroke-width', 1);
    rect.setAttribute('stroke-dasharray', '8 4');
    rect.style.vectorEffect = 'non-scaling-stroke';
    rect.style.pointerEvents = 'none';
    layer.appendChild(rect);

    // Reference markers — page-area corners + center. Each is a small
    // crosshair + coord label so the author can spot-check the
    // viewBox-to-viewport mapping.
    const marks = [
      { x: 0,  y: 0,  label: '(0, 0)' },
      { x: pw, y: 0,  label: '(' + pw + ', 0)' },
      { x: 0,  y: ph, label: '(0, ' + ph + ')' },
      { x: pw, y: ph, label: '(' + pw + ', ' + ph + ')' },
      { x: pw / 2, y: ph / 2, label: '(' + (pw / 2) + ', ' + (ph / 2) + ')' }
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
