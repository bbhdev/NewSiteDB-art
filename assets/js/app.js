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
      // v0.8.79: cross-object Start / Stop side effects on fire.
      // Target is a class identity (line.masterId, stable string).
      // Stop has optional fade-out + return-home cleanup tween;
      // duration 0 OR neither bool set = instantaneous reset.
      if (b.trigger.startObjectId)   out.startObjectId   = String(b.trigger.startObjectId);
      if (b.trigger.stopObjectId)    out.stopObjectId    = String(b.trigger.stopObjectId);
      if (b.trigger.stopFadeOut)     out.stopFadeOut     = true;
      if (b.trigger.stopReturnHome)  out.stopReturnHome  = true;
      if (b.trigger.stopDurationSec != null) {
        const d = Number(b.trigger.stopDurationSec);
        if (d >= 0) out.stopDurationSec = d;
      }
      if (b.trigger.stopEasing)      out.stopEasing      = String(b.trigger.stopEasing);
      // v0.8.84: opt-in easy hit test for click/hover. When true,
      // the path is set to pointer-events:all so a click anywhere
      // inside the shape's geometric bounds counts (handy for
      // unfilled outlines). Default = SVG-native (visiblePainted).
      if (b.trigger.treatAsFilled)   out.treatAsFilled   = true;
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
      // v0.8.23: loopTo carries target + optional maxIterations.
      if (b.duration.mode === 'loopTo') {
        if (Number.isInteger(b.duration.target) && b.duration.target >= 0) {
          out.target = b.duration.target;
        }
        if (Number.isInteger(b.duration.maxIterations) && b.duration.maxIterations > 0) {
          out.maxIterations = b.duration.maxIterations;
        }
      }
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
    // v0.8.31: app version is surfaced inside the page-area outline
    // when the editor's "show page area" diagnostic is on, so the
    // author can confirm at a glance which build is rendering on a
    // page they're poking at. Falls back to 'dev' if the payload
    // didn't include it (older saves).
    const appVersion = (typeof data.version === 'string' && data.version) ? data.version : 'dev';

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

    // v0.8.195: text overlay helpers (runtime side; mirror of the
    // editor's resolveText / lineCenterFor in dev-draw.js). Slice 1 —
    // text lives on the master and is propagated to every resolved
    // line by the PHP resolver, so line.text is the canonical read.
    function resolveLineText(line) {
      const t = line && line.text;
      if (!t || typeof t !== 'object') return null;
      const value = (typeof t.value === 'string') ? t.value : '';
      if (!value) return null;
      return {
        value:      value,
        offsetX:    (typeof t.offsetX === 'number') ? t.offsetX : 0,
        offsetY:    (typeof t.offsetY === 'number') ? t.offsetY : 0,
        fontFamily: (typeof t.fontFamily === 'string' && t.fontFamily) ? t.fontFamily : 'Inter',
        fontSize:   (typeof t.fontSize === 'number' && t.fontSize > 0) ? t.fontSize : 14,
        color:      (typeof t.color === 'string' && t.color) ? t.color : null
      };
    }
    // Inject font references for every distinct fontFamily referenced
    // by any line.text across every class. Two sources:
    //   1. Local fonts: served by @font-face from /assets/fonts/local/.
    //      Fetched from /dev/draw/local-fonts; emitted as a <style>
    //      block. Local families are excluded from the Google URL
    //      because they'd 404 there.
    //   2. Google Fonts: every remaining family is included in a single
    //      <link rel="stylesheet"> pointing at fonts.googleapis.com.
    //
    // v0.8.216: added local-font support, mirroring the editor's
    // injectLocalFontFaces + injectGoogleFontsLink subtraction logic.
    (function injectFonts() {
      const usedSet = {};
      useClasses.forEach(function (cid) {
        const c = byClass[cid];
        if (!c || !Array.isArray(c.lines)) return;
        c.lines.forEach(function (l) {
          const t = resolveLineText(l);
          if (t && t.fontFamily) usedSet[t.fontFamily] = true;
        });
      });
      // No text at all → no work.
      if (!Object.keys(usedSet).length) return;

      function injectGoogleLink(excludeSet) {
        const families = Object.keys(usedSet).filter(function (f) {
          return !excludeSet[f];
        }).sort();
        if (!families.length) return;
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        const qs = families.map(function (f) {
          return 'family=' + encodeURIComponent(f).replace(/%20/g, '+');
        }).join('&');
        link.href = 'https://fonts.googleapis.com/css2?' + qs + '&display=swap';
        document.head.appendChild(link);
      }

      // v0.8.218: read the static manifest committed alongside the
      // font files at assets/fonts/local/manifest.json. The editor's
      // /dev/draw/local-fonts endpoint regenerates this file on every
      // scan, so it stays in sync without the runtime needing the
      // PHP route — works on static deploys / hosts where /dev/draw/*
      // is locked down or absent. Manifest format mirrors the endpoint
      // response: { fonts: [...], generatedAt, count }.
      fetch('/assets/fonts/local/manifest.json', { cache: 'no-cache' })
        .then(function (r) { return r.ok ? r.json() : { fonts: [] }; })
        .then(function (j) {
          const local = (j && Array.isArray(j.fonts)) ? j.fonts : [];
          const localSet = {};
          if (local.length) {
            const fmtMap = { otf: 'opentype', ttf: 'truetype', woff: 'woff', woff2: 'woff2' };
            const css = local.map(function (f) {
              const fmt = fmtMap[f.format] || '';
              const url = '/assets/fonts/local/' + encodeURIComponent(f.file);
              const fam = (f.family || '').replace(/"/g, '');
              localSet[f.family] = true;
              return '@font-face { font-family: "' + fam + '"; '
                   + 'src: url("' + url + '")'
                   + (fmt ? ' format("' + fmt + '")' : '') + '; '
                   + 'font-display: swap; }';
            }).join('\n');
            const style = document.createElement('style');
            style.id = 'rt-local-fontfaces';
            style.textContent = css;
            document.head.appendChild(style);
          }
          injectGoogleLink(localSet);
        })
        .catch(function () {
          // Endpoint absent (e.g. static deploy with no PHP runtime) —
          // proceed with Google-only injection so the page still renders
          // its text overlays in whatever Google families are referenced.
          injectGoogleLink({});
        });
    })();

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
    // v0.8.77: generic per-class teardown callbacks. Used by scroll-
    // stop / scroll-start subscriptions which own a scrollActivity
    // subscriber AND a pending setTimeout — both need to be released
    // on class-boundary re-render, and the (target, type, fn) shape
    // of ownListeners doesn't fit.
    const ownCleanups = [];

    // v0.8.231: convert window.scrollY (CSS pixels) to SVG coordinate
    // units for the flow-mode scroll translation. The SVG layer is
    // position:fixed and its viewBox maps a known number of SVG units
    // to the element's CSS height. getBoundingClientRect().height gives
    // the live CSS height (accounts for zoom, viewport resize, etc).
    // Called every frame inside writeAt so the ratio stays current.
    function scrollToSvgY() {
      var h = layer.getBoundingClientRect().height;
      if (h <= 0) return 0;
      var vb = layer.viewBox.baseVal;
      return window.scrollY * vb.height / h;
    }
    // Returns true when the instance should scroll with the page.
    // Absent scrollMode = 'flow' (the new default as of schema v12).
    function isFlowMode(lineDef) {
      return !lineDef.scrollMode || lineDef.scrollMode === 'flow';
    }
    let currentClassId = null;

    // v0.8.77: shared scroll-activity watcher for scroll-stop /
    // scroll-start triggers. One passive scroll listener at the
    // window level emits start/stop events to every subscriber; per-
    // block code (registered further down) subscribes here. "Stopped"
    // = no scroll event for STILL_MS after the last motion. The
    // initial state is "not scrolling and never has scrolled," so the
    // first start event waits until the user actually scrolls — no
    // false fires at page load.
    const SCROLL_STILL_MS = 150;
    const scrollActivity = (function () {
      const subs = [];
      let scrolling = false;
      let stillTimer = null;
      function onScroll() {
        if (!scrolling) {
          scrolling = true;
          const t = performance.now() / 1000;
          for (let i = 0; i < subs.length; i++) {
            try { if (subs[i].onStart) subs[i].onStart(t); } catch (e) {}
          }
        }
        clearTimeout(stillTimer);
        stillTimer = setTimeout(function () {
          scrolling = false;
          const t = performance.now() / 1000;
          for (let i = 0; i < subs.length; i++) {
            try { if (subs[i].onStop) subs[i].onStop(t); } catch (e) {}
          }
        }, SCROLL_STILL_MS);
      }
      window.addEventListener('scroll', onScroll, { passive: true });
      return {
        add: function (s) { subs.push(s); },
        remove: function (s) {
          const i = subs.indexOf(s);
          if (i !== -1) subs.splice(i, 1);
        }
      };
    })();

    // v0.8.79: cross-object Start / Stop registry. Every line whose
    // class identity is known (line.masterId) registers a controller
    // here under that key. Controllers expose requestStart() and
    // requestStop(opts) — fired by triggers carrying startObjectId /
    // stopObjectId. One masterId can have many controllers (every
    // rendered instance of that class), all driven together.
    //
    // The pendingObjectEffects queue defers any cross-object fires
    // that happen DURING per-line init (page-load triggers, scroll-
    // range immediate entries, etc.) until every line is registered
    // — otherwise a page-load trigger on the first line could try to
    // stop a class whose controller hasn't been registered yet.
    const objectRegistry = new Map();
    let objectInitFlushing = true;
    const pendingObjectEffects = [];
    function registerObjectController(key, ctrl) {
      if (!key) return;
      if (!objectRegistry.has(key)) objectRegistry.set(key, []);
      objectRegistry.get(key).push(ctrl);
    }
    function applyObjectEffects(trig) {
      if (!trig) return;
      if (!trig.startObjectId && !trig.stopObjectId) return;
      if (objectInitFlushing) {
        pendingObjectEffects.push(trig);
        return;
      }
      if (trig.stopObjectId) {
        const ctrls = objectRegistry.get(trig.stopObjectId);
        if (ctrls) {
          const opts = {
            fadeOut:     !!trig.stopFadeOut,
            returnHome:  !!trig.stopReturnHome,
            durationSec: Number(trig.stopDurationSec) || 0,
            easing:      trig.stopEasing || 'linear'
          };
          for (let i = 0; i < ctrls.length; i++) {
            try { ctrls[i].requestStop(opts); } catch (e) {}
          }
        }
      }
      if (trig.startObjectId) {
        const ctrls = objectRegistry.get(trig.startObjectId);
        if (ctrls) {
          for (let i = 0; i < ctrls.length; i++) {
            try { ctrls[i].requestStart(); } catch (e) {}
          }
        }
      }
    }

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
      ownCleanups.forEach(function (fn) { try { fn(); } catch (e) {} });
      ownCleanups.length = 0;
      // v0.8.79: drop every per-line stop/start controller; the next
      // class render will re-register fresh ones.
      objectRegistry.clear();
      pendingObjectEffects.length = 0;
      objectInitFlushing = true;
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

    // v0.8.61: pre-scan behaviors to figure out which lines are
    // referenced as pathFollow guides anywhere. A hidden guide
    // would normally be skipped (line.hidden / group.hidden), but
    // pathFollow needs the guide's <path> element in the DOM to
    // sample geometry — without it, layer.querySelector(
    // '[data-master-id=...]') misses and the follower never
    // moves. We render referenced-but-hidden guides invisibly
    // (visibility: hidden + pointer-events: none) so they're
    // queryable but stay out of sight.
    const guideMastersNeeded = {};
    const guideNamesNeeded   = {};
    lines.forEach(function (line) {
      if (!Array.isArray(line.behaviors)) return;
      line.behaviors.forEach(function (b) {
        const p = (b && b.params) || {};
        if (p.translateMode !== 'pathFollow') return;
        if (p.pathRef)     guideMastersNeeded[p.pathRef] = true;
        if (p.pathRefName) guideNamesNeeded[p.pathRefName] = true;
      });
    });

    // Render JSON-defined lines. Hidden lines (instance or group)
    // are skipped entirely on the live site — the editor's Visible
    // toggles are the gate. Image-kind lines without a src are also
    // skipped (no visible content + no placeholder outline outside
    // the editor).
    lines.forEach(function (line) {
      // v0.8.61: a hidden line still needs to render (invisibly)
      // when some other line references it as a pathFollow guide —
      // pathFollow reads geometry from the DOM. needAsGuide is the
      // is-this-line-a-guide check; on match, we render with
      // visibility hidden so viewers don't see it but
      // layer.querySelector('[data-master-id=...]') / [data-line-id=...]
      // still resolves.
      const lineName = line.name || line.id;
      const needAsGuide = (line.masterId && guideMastersNeeded[line.masterId])
                       || (lineName && guideNamesNeeded[lineName]);
      const group = groupById[line.groupId];
      const isHidden = line.hidden || (group && group.hidden);
      if (isHidden && !needAsGuide) return;

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
        // v0.8.61: same invisible-but-rendered treatment as the
        // path branch, for consistency. Images aren't valid path
        // guides today but the hidden-line semantics should be
        // uniform across kinds.
        if (isHidden) {
          img.style.visibility = 'hidden';
          img.style.pointerEvents = 'none';
        }
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
      // Fill:
      //   - textBlock (v0.8.228) reads line.fill (independent of
      //     stroke). Unset → fill="none". The fill picker writes
      //     a palette color id resolved via resolveStroke.
      //   - everything else: `filled` is authoritative when set
      //     (true for primitives, closed-loop freehand, any
      //     explicit author choice); falls back to `closed` for
      //     legacy data without `filled`. Fill follows stroke.
      if (line.kind === 'textBlock') {
        const fill = resolveStroke(line.fill);
        p.style.fill = fill || 'none';
      } else {
        const wantsFill = line.filled !== undefined ? !!line.filled : !!line.closed;
        if (wantsFill && stroke) p.style.fill = stroke;
      }
      p.dataset.lineId  = line.id;
      p.dataset.groupId = line.groupId || '';
      // v0.8.57: master id on the DOM lets pathFollow resolve a
      // guide across classes (line.id is per-class; masterId is
      // the shared canonical identity).
      if (line.masterId) p.dataset.masterId = line.masterId;
      // v0.8.61: hidden-but-needed-as-guide → render invisibly so
      // the DOM has the element for pathFollow's getPointAtLength /
      // getCTM, but the viewer doesn't see it. pointer-events none
      // so hit-testing also skips it.
      if (isHidden) {
        p.style.visibility = 'hidden';
        p.style.pointerEvents = 'none';
      }
      layer.appendChild(p);

      // v0.8.195: text overlay. Anchored at the line's natural center
      // plus authored (offsetX, offsetY). data-text-for is queried by
      // the writeAt closure below so the same per-frame transform /
      // opacity that drives the path is mirrored onto the <text>.
      // Drawn AFTER the path so author labels read on top of the line.
      const tx = resolveLineText(line);
      if (tx) {
        let cxN = 0, cyN = 0;
        if (line.params) {
          const pa = line.params;
          if (Number.isFinite(pa.cx) && Number.isFinite(pa.cy)) {
            cxN = pa.cx; cyN = pa.cy;
          } else if (Number.isFinite(pa.x) && Number.isFinite(pa.y)
                  && Number.isFinite(pa.w) && Number.isFinite(pa.h)) {
            cxN = pa.x + pa.w / 2;
            cyN = pa.y + pa.h / 2;
          }
        }
        if (cxN === 0 && cyN === 0) {
          try {
            const b = p.getBBox();
            if (b && b.width > 0) { cxN = b.x + b.width / 2; cyN = b.y + b.height / 2; }
          } catch (e) { /* getBBox unavailable */ }
        }
        const ax = cxN + tx.offsetX;
        const tEl = document.createElementNS(SVG_NS, 'text');
        tEl.setAttribute('x', String(ax));
        tEl.setAttribute('y', String(cyN + tx.offsetY));
        // v0.8.234: no centering — left/top-aligned at the offset point.
        // v0.8.235: dominant-baseline=text-before-edge so y marks the
        // top edge of the first line (matches editor).
        tEl.setAttribute('text-anchor', 'start');
        tEl.setAttribute('dominant-baseline', 'text-before-edge');
        tEl.setAttribute('font-family', tx.fontFamily);
        tEl.setAttribute('font-size', String(tx.fontSize));
        // v0.8.238: text color is a palette id (Slice 1b-2). Resolve
        // via the same paletteById table as line strokes; resolveStroke
        // passes through legacy CSS strings unchanged for back-compat.
        tEl.setAttribute('fill', resolveStroke(tx.color) || stroke || 'currentColor');
        tEl.style.pointerEvents = 'none';
        tEl.dataset.textFor = line.id;
        if (isHidden) tEl.style.visibility = 'hidden';
        // v0.8.232: multi-line content via <tspan>s, mirroring the
        // editor's setMultilineText. xml:space=preserve keeps runs of
        // whitespace; dy lifts the first line so the whole block is
        // vertically centered around the anchor.
        // v0.8.233: xml:space via XML namespace (plain setAttribute
        // didn't preserve whitespace); explicit text-anchor on each
        // tspan (inherited anchor drifted right line-by-line).
        const XML_NS = 'http://www.w3.org/XML/1998/namespace';
        tEl.setAttributeNS(XML_NS, 'space', 'preserve');
        (function writeTspans() {
          const lines = String(tx.value == null ? '' : tx.value).split('\n');
          const n = lines.length;
          for (let i = 0; i < n; i++) {
            const ts = document.createElementNS(SVG_NS, 'tspan');
            ts.setAttribute('x', String(ax));
            ts.setAttribute('text-anchor', 'start');
            ts.setAttributeNS(XML_NS, 'space', 'preserve');
            // v0.8.235: with dominant-baseline=text-before-edge on
            // the parent <text>, line 0's top sits at y directly. No
            // dy on the first line; subsequent lines drop 1em.
            if (i > 0) ts.setAttribute('dy', '1em');
            ts.textContent = lines[i];
            tEl.appendChild(ts);
          }
        })();
        layer.appendChild(tEl);
      }
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
      // v0.8.58: page-guide diagnostic also shows which class the
      // runtime selected (useful when debugging cross-class
      // mismatches — e.g. the editor was on wide but the runtime
      // picked narrow due to viewport width).
      const clsDef = classes.find(function (c) { return c.id === currentClassId; });
      const clsLabel = (clsDef && clsDef.name) ? clsDef.name : (currentClassId || '?');
      renderRuntimePageGuide(layer, page, appVersion, clsLabel);
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
      // v0.8.220: group behavior template. When the group designates a
      // member object as its template, the template's behaviors[] is
      // applied to every member ON TOP OF the member's own behaviors[]
      // (they compound, not replace). Group defaults are ignored when
      // a template is active. Geometry stays each member's own — only
      // the behaviors compound.
      //
      // Composition rule: for non-template members, the effective
      // behavior list is templateBehaviors ⧺ memberBehaviors. The
      // template object itself uses just its own behaviors (skipping
      // the prepend avoids doubling its blocks). The prepend order
      // doesn't matter for last-active-wins effects (opacity) because
      // each block carries its own trigger/duration; for additive
      // effects (translate, rotate) the sum is order-independent too.
      //
      // See dev-draw.js renderGroupPanel → "Behavior template" section.
      let groupTemplateActive = false;
      let compoundedBehaviors = lineDef.behaviors || [];
      if (group.behaviorTemplateObjectId) {
        const tplLine = lines.find(function (l) {
          return l.id === group.behaviorTemplateObjectId;
        });
        if (tplLine) {
          groupTemplateActive = true;
          if (tplLine.id === lineDef.id) {
            // The template object itself: use only its own behaviors,
            // no prepend (otherwise its blocks would run twice).
            compoundedBehaviors = lineDef.behaviors || [];
          } else {
            // pathFollow option (c): if the member has its own
            // pathFollow block, suppress template's pathFollow
            // blocks. Two pathFollow contributions would otherwise
            // sum-of-positions, which is geometrically nonsense
            // ("follow A AND follow B at the same time"). Member
            // intent wins; member-less-pathFollow members still
            // inherit the template's pathFollow.
            const memberBeh = lineDef.behaviors || [];
            const memberHasPathFollow = memberBeh.some(function (b) {
              return b && b.params && b.params.translateMode === 'pathFollow';
            });
            const templateBeh = (tplLine.behaviors || []).filter(function (b) {
              if (!memberHasPathFollow) return true;
              return !(b && b.params && b.params.translateMode === 'pathFollow');
            });
            compoundedBehaviors = templateBeh.concat(memberBeh);
          }
        }
      }
      // v0.8.195: companion text overlay for this line, if any. Lives
      // as a sibling <text data-text-for="..."> in the same layer.
      // writeAt mirrors transform+opacity onto it so labels travel with
      // their object through every scroll-driven motion / fade. NULL
      // when the line has no text, in which case the mirror calls
      // below short-circuit on the falsiness check.
      const textEl = layer.querySelector('[data-text-for="' + pathEl.dataset.lineId + '"]');
      // v0.8.91: drawIn moved into the per-frame computeAt pipeline.
      // Each block carries its own drawIn flag + direction (folded
      // in from group defaults at block-normalize time, ~line 902).
      // The runtime now treats drawIn as a per-block effect like
      // fadeOpacity — last-active-wins composition, progress sourced
      // from the block's own duration.mode (scroll / time / loop /
      // pingpong / loopTo). This means drawIn:true on a block with
      //   - trigger.when='page-load' + duration='time, X secs'
      //     → draws over X seconds after page load
      //   - trigger.when='scroll-range' + duration='scroll'
      //     → legacy behavior (reveal across scroll range)
      //   - trigger.when='time' / 'click' / 'hover' / 'wait'
      //     → draws over duration.seconds after trigger fires
      //   - duration.mode='pingpong'
      //     → repeatedly draws+undraws over 2 × duration.seconds
      // The legacy single-tween-bound-to-ScrollTrigger path is gone
      // (it was the reason "page load + time" didn't draw at all).

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

      // ── Natural center & rotation pivot ────────────────────────
      // v0.8.220: rotation pivot is one-per-object (NOT per-block).
      // All blocks' rot contributions sum into a single angle, applied
      // around a single pivot. The pivot is expressed as a DELTA from
      // the object's natural center (so (0,0) = pivot AT center).
      //
      // Resolution priority:
      //   1. Object's own pivot — the first block of THIS line whose
      //      params has both rotateOriginX and rotateOriginY as finite
      //      numbers.
      //   2. Template's pivot — same scan over the template object's
      //      behaviors[], applied as a delta from the MEMBER's
      //      natural center (the template's pivot offset is inherited
      //      as a pattern, not anchored to the template's coords).
      //   3. Default — delta (0,0), i.e. pivot at the member's
      //      natural center.
      //
      // "Empty / not set" means the block's params lacks finite
      // rotateOriginX/Y. An explicit (0,0) is distinct — it pins the
      // pivot to the natural center on purpose, and stops further
      // inheritance from the template.
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
      // Resolve single object pivot per the priority above.
      const findPivotDelta = function (behArr) {
        if (!Array.isArray(behArr)) return null;
        for (let i = 0; i < behArr.length; i++) {
          const p = behArr[i] && behArr[i].params;
          if (!p) continue;
          if (Number.isFinite(p.rotateOriginX) && Number.isFinite(p.rotateOriginY)) {
            return { dx: p.rotateOriginX, dy: p.rotateOriginY };
          }
        }
        return null;
      };
      let pivotDelta = findPivotDelta(lineDef.behaviors);
      if (!pivotDelta && groupTemplateActive) {
        const tplLine = lines.find(function (l) {
          return l.id === group.behaviorTemplateObjectId;
        });
        if (tplLine) pivotDelta = findPivotDelta(tplLine.behaviors);
      }
      if (!pivotDelta) pivotDelta = { dx: 0, dy: 0 };
      const originX = centerX + pivotDelta.dx;
      const originY = centerY + pivotDelta.dy;

      // v0.4.1: multi-block composition. Walk lineDef.behaviors[];
      // each block carries its own trigger + duration + params.
      // Empty behaviors[] falls back to one synthetic no-op block so
      // the rest of the pipeline always has at least one entry.
      //
      // v0.8.7: trigger / duration split into orthogonal axes.
      //   trigger.when  ∈ scroll-range | page-load | scroll-key |
      //                   in-view-partial | in-view-full |
      //                   after-previous
      //   duration.mode ∈ scroll | time | loop | pingpong | loopTo
      // Activation timestamp per block (activationState[i]) is the
      // moment the block crossed its trigger; time-based durations
      // measure elapsed from there + trigger.delay.
      //
      // v0.8.226 (CONTENT_SCHEMA_VERSION 11): group.defaults no
      // longer carries behavior fallbacks (translateX/Y, rotate,
      // rotateOriginX/Y, drawIn, drawInDirection, translateMode).
      // All behavior params live on block.params; missing values
      // default to 0 / false / 'fixed' / 'forward'.
      const rawBlocks = (compoundedBehaviors.length)
        ? compoundedBehaviors
        : [{ id: '__default', trigger: { when: 'scroll-range', range: { start: 0, end: 1 }, delay: 0 }, duration: { mode: 'scroll' }, kind: 'transform', params: {} }];
      const blocks = rawBlocks.map(function (b) {
        const p = b.params || {};
        const num = function (k) {
          return (typeof p[k] === 'number') ? p[k] : 0;
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
        const tmode = p.translateMode || 'fixed';
        // v0.8.26: per-block opacity fade. Authored as absolute
        // from→to values (not progress-weighted deltas like
        // tx/ty/rot), so blocks compose by "last active wins"
        // instead of summing — see computeAt below.
        const fadeOpacity = !!p.fadeOpacity;
        const opacityFrom = (typeof p.opacityFrom === 'number') ? p.opacityFrom : 1;
        const opacityTo   = (typeof p.opacityTo   === 'number') ? p.opacityTo   : 0;
        // v0.8.53: pathFollow params. Position is driven by another
        // line's path (the guide); pathRef = guide line id, picked
        // by the editor's translate-mode 'Along path' picker.
        // pathAlignToTangent: rotate this line to match the guide's
        // direction at the current point.
        // pathEndMode: only meaningful when bp can exceed 1 or wrap
        // (loop / pingpong duration); see computeAt below.
        const pathRef             = (typeof p.pathRef === 'string') ? p.pathRef : null;
        const pathAlignToTangent  = !!p.pathAlignToTangent;
        const pathEndMode         = p.pathEndMode || 'stop';
        return {
          trigger:  trigger,
          duration: duration,
          tx:       num('translateX'),
          ty:       num('translateY'),
          rot:      num('rotate'),
          translateMode: tmode,
          driftX:   (tmode === 'driftX' || tmode === 'driftBoth'),
          driftY:   (tmode === 'driftY' || tmode === 'driftBoth'),
          pathFollow:          (tmode === 'pathFollow'),
          pathRef:             pathRef,
          pathAlignToTangent:  pathAlignToTangent,
          pathEndMode:         pathEndMode,
          fadeOpacity: fadeOpacity,
          opacityFrom: opacityFrom,
          opacityTo:   opacityTo,
          drawIn:   !!p.drawIn,
          drawInDirection: p.drawInDirection || 'forward'
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
        // v0.8.26: fadeOpacity counts as motion.
        // v0.8.53: pathFollow counts too — a block with only
        // pathFollow has zero tx/ty/rot in the block data, but
        // it needs writeAt every frame to re-evaluate the path
        // position (and to follow a guide that's animating).
        // v0.8.91: drawIn counts too — when drawIn lives on the
        // per-frame compute path, a block with only drawIn:true
        // still needs writeAt to advance the dashoffset.
        return b.tx !== 0 || b.ty !== 0 || b.rot !== 0
            || b.fadeOpacity || b.pathFollow || b.drawIn;
      });
      // v0.8.91: any block with drawIn:true → initialize the path's
      // stroke-dasharray state once, here. After this, computeAt
      // produces a per-frame dashoffset that writeAt applies.
      // <image> has no stroke, so the dash setup is path-only.
      const anyDrawIn = blocks.some(function (b) { return b.drawIn; })
                    && pathEl.tagName.toLowerCase() === 'path';
      const firstDrawIn = anyDrawIn
        ? blocks.find(function (b) { return b.drawIn; })
        : null;
      const initialDashDir = (firstDrawIn && firstDrawIn.drawInDirection === 'reverse') ? -1 : 1;
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

      // v0.8.23: loopTo bookkeeping (only meaningful for blocks
      // whose duration.mode === 'loopTo').
      //   loopOffset[i]      snapshot of the sequence's cumulative
      //                      (tx, ty, rot) at the instant this
      //                      block activated — what the loop will
      //                      undo over its `seconds`. Re-snapshotted
      //                      each iteration (cleared on reset).
      //   loopPlayed[i]      one-shot guard: did the current play
      //                      already fire its completion handler?
      //                      Prevents re-firing the reset every
      //                      frame after bp hits 1.
      //   loopIterCount[i]   how many iterations the loop has
      //                      completed. Compared to maxIterations.
      //   loopDone[i]        true once the iteration cap is hit;
      //                      the block stays at bp=1 (line parked
      //                      at the target's start position) and
      //                      stops triggering further resets.
      const loopOffset    = blocks.map(function () { return null; });
      const loopPlayed    = blocks.map(function () { return false; });
      const loopIterCount = blocks.map(function () { return 0; });
      const loopDone      = blocks.map(function () { return false; });

      // v0.8.53: pathFollow per-block end-mode state.
      //   pathStopMax[i]   monotonic max of bp ever seen; used by
      //                    pathEndMode='stop' so that once the
      //                    follower reaches the end of the guide
      //                    path it stays there even if bp wraps.
      //   pathLastBp[i]    last frame's bp; used by pathEndMode=
      //                    'pingpong' to detect bp wraps and flip
      //                    pathDirection on each one.
      //   pathDirection[i] +1 (forward along path) / -1 (backward).
      //                    Flipped on each detected bp wrap when
      //                    pathEndMode='pingpong'.
      const pathStopMax   = blocks.map(function () { return 0; });
      const pathLastBp    = blocks.map(function () { return 0; });
      const pathDirection = blocks.map(function () { return 1; });
      // v0.8.56 DIAGNOSTIC: one-shot logs per pathFollow block so
      // we can see in the console which check is bailing when
      // motion doesn't appear. Set to true on first log; suppresses
      // subsequent ticks for the same block.
      const pathDiagLogged = blocks.map(function () { return false; });

      // v0.8.79: cross-object Stop / Start state. isStopped = the
      // target has been reset to its neutral pre-fire state (writeAt
      // no-ops; current rendered attrs frozen). stopState != null =
      // a cleanup tween (fadeOut and/or returnHome) is in progress
      // toward the neutral state; writeAt paints interpolated values
      // each frame and finalizes when elapsed >= durationSec.
      let isStopped = false;
      let stopState = null;

      // v0.8.79: per-block trigger teardown closures. Filled by
      // armTrigger(i, b) — each call pushes one teardown function.
      // Re-arming first runs and clears any prior teardown so a
      // requestStart() can wire everything fresh without leaking
      // listeners.
      const blockTriggerTeardown = blocks.map(function () { return []; });
      function teardownBlockTrigger(i) {
        const arr = blockTriggerTeardown[i];
        for (let k = 0; k < arr.length; k++) {
          try { arr[k](); } catch (e) {}
        }
        arr.length = 0;
      }

      // v0.8.79: extracted from the old `blocks.forEach` setup loop.
      // Callable repeatedly per block — wires (or re-wires) one
      // block's trigger from scratch. Each branch ends by pushing a
      // teardown closure so the listener/observer ownership stays
      // per-block (the older line-global ownListeners/ownObservers/
      // ownCleanups arrays are still used at the line level for
      // class-render teardown, but per-block re-arm needs finer
      // control). Object effects (startObjectId / stopObjectId) fire
      // at every activation site via applyObjectEffects(b.trigger).
      function armTrigger(i, b) {
        teardownBlockTrigger(i);
        const when = b.trigger.when;
        if (when === 'scroll-range') {
          // Activated lazily inside blockProg when scrollP enters
          // the range (applyObjectEffects called from there).
          return;
        }
        if (when === 'page-load') {
          activationState[i] = performance.now() / 1000;
          applyObjectEffects(b.trigger);
          return;
        }
        if (when === 'after-previous') {
          // Activated lazily inside blockProg when the predecessor
          // timed block finishes (applyObjectEffects called from
          // there).
          return;
        }
        if (when === 'scroll-key' && b.trigger.selector) {
          const el = document.querySelector(b.trigger.selector);
          if (!el) return;
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
                applyObjectEffects(b.trigger);
              }
            }
            wasInside = nowInside;
          };
          window.addEventListener('scroll', onScroll, { passive: true });
          blockTriggerTeardown[i].push(function () {
            try { window.removeEventListener('scroll', onScroll); } catch (e) {}
          });
          return;
        }
        if (when === 'scroll-stop' || when === 'scroll-start') {
          // v0.8.77: event-driven triggers fed by the shared
          // scrollActivity watcher. Subscribers schedule fire at
          // t + delay; the opposite event before delay elapses
          // cancels the pending fire (symmetric for both kinds).
          // Fire re-runs unconditionally — these triggers don't
          // expire or honor a repeat/once flag.
          const trig = b.trigger;
          const delaySec = (trig && trig.delay) || 0;
          let scheduled = null;
          const fire = function () {
            scheduled = null;
            const t = performance.now() / 1000;
            activationState[i] = t;
            applyObjectEffects(trig);
          };
          const cancel = function () {
            if (scheduled != null) {
              clearTimeout(scheduled);
              scheduled = null;
            }
          };
          const sub = (when === 'scroll-stop')
            ? {
                onStop: function () {
                  cancel();
                  scheduled = setTimeout(fire, delaySec * 1000);
                },
                onStart: cancel
              }
            : {
                onStart: function () {
                  cancel();
                  scheduled = setTimeout(fire, delaySec * 1000);
                },
                onStop: cancel
              };
          scrollActivity.add(sub);
          blockTriggerTeardown[i].push(function () {
            scrollActivity.remove(sub);
            cancel();
          });
          return;
        }
        if (when === 'in-view-partial' || when === 'in-view-full') {
          const threshold = (when === 'in-view-full') ? 0.999 : 0.001;
          const obs = new IntersectionObserver(function (entries) {
            entries.forEach(function (entry) {
              if (entry.isIntersecting && activationState[i] == null) {
                activationState[i] = performance.now() / 1000;
                applyObjectEffects(b.trigger);
              }
            });
          }, { threshold: threshold });
          obs.observe(pathEl);
          blockTriggerTeardown[i].push(function () {
            try { obs.disconnect(); } catch (e) {}
          });
          return;
        }
        // v0.8.85: 'click' and 'hover' — pointer-driven one-shot
        // triggers using document-level listeners + SVG geometry
        // hit-testing.
        //
        // Why not just pointer-events on the path? The lines layer
        // is z-index:0; .layout is z-index:1 ABOVE it. Even with
        // pointer-events:none on the layer and pointer-events:all
        // on a path, clicks at the layer's pixels first hit .layout
        // (which doesn't opt out of pointer-events) and never reach
        // the path. Tried in v0.8.84 — confirmed dead in testing.
        //
        // The document-level approach: install a `click` (and for
        // hover, also `mousemove`) listener on `document`, and on
        // each event ask the path itself via SVGGeometryElement's
        // isPointInFill / isPointInStroke whether the cursor is
        // inside its geometry. This is independent of z-order /
        // overlap / pointer-events anywhere in the tree.
        //
        // Coordinate transform: getScreenCTM() returns the matrix
        // mapping the path's local "d" coordinates to screen px,
        // INCLUDING the path's own transform attribute (the
        // positionOffset translate + any animation rotate). Its
        // inverse converts clientX/clientY into d-space, where
        // isPointInFill/Stroke operate. So a path scrolled or
        // translated mid-animation is hit-tested where it
        // currently APPEARS, not where it was authored.
        //
        // Hit modes:
        //   - default: stroke-only via isPointInStroke. In this
        //     app every path has fill:none (set by the layer's
        //     `#lines-layer path { fill: none }` rule), so the
        //     SVG-native equivalent is stroke-only — narrow but
        //     honest. The author chose the stroke width.
        //   - opt-in (b.trigger.treatAsFilled === true): hit if
        //     isPointInFill OR isPointInStroke — treats unfilled
        //     outlines as if they were filled.
        //
        // Mobile fallback for hover: touch devices don't fire
        // mousemove until a tap occurs, so 'hover' also installs
        // the click listener. Whichever event arrives first fires;
        // the activationState guard makes the loser a no-op.
        if (when === 'click' || when === 'hover') {
          const easyHit = !!(b.trigger && b.trigger.treatAsFilled);
          // v0.8.88: pointer-events on the path controls how
          // isPointInFill/isPointInStroke interpret paint. The
          // lines-layer's CSS `pointer-events: none` INHERITS
          // down to every path — and per SVG spec, with
          // pointer-events:none on the element, isPointInFill
          // returns false even when fill is painted. So even a
          // visibly-filled circle was reporting inFill=false in
          // v0.8.87 diagnostic.
          //
          // Override via inline style (presentation attributes
          // lose to CSS specificity, so setAttribute doesn't
          // override the inherited none — only style does).
          //   - easyHit:  pointer-events:all  → isPointInFill is
          //               geometric, returns true for any point
          //               inside the closed area regardless of
          //               paint. Lets unfilled outlines act as
          //               filled for hit purposes.
          //   - default:  pointer-events:auto → isPointInFill
          //               respects paint. Filled circle hits on
          //               disc; unfilled outline hits only on
          //               stroke.
          // Restored on teardown.
          //
          // We ALWAYS check isPointInFill || isPointInStroke now
          // — the easyHit flag controls hit-test semantics via
          // pointer-events, not via which API to call. This
          // gives the right behavior in every fill/stroke combo
          // without per-mode branching in the JS.
          //
          // The path having pointer-events != none doesn't make
          // it intercept clicks natively here: .layout sits at
          // z-index:1 above the layer, so the layout div
          // captures clicks at the layer's pixels anyway. Our
          // document-level capture listener is what actually
          // fires; the per-path pointer-events only affects the
          // SVG hit-test APIs.
          const prevStylePE = pathEl.style.pointerEvents;
          pathEl.style.pointerEvents = easyHit ? 'all' : 'auto';
          const pointHits = function (clientX, clientY) {
            try {
              const svg = pathEl.ownerSVGElement;
              if (!svg) return false;
              const ctm = pathEl.getScreenCTM();
              if (!ctm) return false;
              const pt = svg.createSVGPoint();
              pt.x = clientX;
              pt.y = clientY;
              const local = pt.matrixTransform(ctm.inverse());
              return pathEl.isPointInFill(local) || pathEl.isPointInStroke(local);
            } catch (e) {
              return false;
            }
          };
          const fire = function () {
            // v0.8.89: click/hover are re-fireable. Each event sets
            // a fresh activation timestamp (restarts the block's
            // own animation from t=0) and re-runs applyObjectEffects
            // so cross-object Start commands re-issue on every
            // click / hover-edge. Without this re-fire, a second
            // click on a "Wait for click" source did nothing because
            // activationState[i] was still set from the first fire.
            activationState[i] = performance.now() / 1000;
            applyObjectEffects(b.trigger);
          };
          const onClick = function (e) {
            if (pointHits(e.clientX, e.clientY)) fire();
          };
          // v0.8.86: capture phase. document-level bubble fires
          // last, after every other handler in the chain — if any
          // ancestor calls stopPropagation (which any third-party
          // overlay or button handler might), our listener never
          // fires. Capture phase walks top-down before bubble, so
          // we always see the event first. mousemove doesn't have
          // this problem in practice (no per-element handlers
          // call stopPropagation on it), but we use capture there
          // too for symmetry.
          document.addEventListener('click', onClick, true);
          let onMove = null;
          if (when === 'hover') {
            // Edge-triggered: fire only on the transition from
            // outside → inside. Without this, every pixel of
            // movement inside the path would re-fire (well, the
            // activationState guard would no-op them, but the
            // hit-test still runs per move). Rising-edge keeps
            // the per-move work to a single isPointInStroke call.
            let wasInside = false;
            onMove = function (e) {
              const inside = pointHits(e.clientX, e.clientY);
              if (inside && !wasInside) fire();
              wasInside = inside;
            };
            document.addEventListener('mousemove', onMove, true);
          }
          blockTriggerTeardown[i].push(function () {
            try { document.removeEventListener('click', onClick, true); } catch (e) {}
            if (onMove) {
              try { document.removeEventListener('mousemove', onMove, true); } catch (e) {}
            }
            // v0.8.88: restore inline pointer-events so a later
            // rearm/reconfiguration doesn't inherit our 'all'/'auto'
            // override if the trigger kind changes away from
            // click/hover.
            try { pathEl.style.pointerEvents = prevStylePE; } catch (e) {}
          });
          return;
        }
      }

      // v0.8.79: rearm() resets every per-block runtime variable
      // (activation, loop bookkeeping, path-follow trackers, drift
      // accumulator) and re-runs armTrigger(i) for every block.
      // Called from requestStart() — by the time a stopped target
      // is restarted, all derived state must look brand-new so the
      // animation re-fires from frame 0.
      function rearm() {
        for (let i = 0; i < blocks.length; i++) {
          activationState[i]  = null;
          loopOffset[i]       = null;
          loopPlayed[i]       = false;
          loopIterCount[i]    = 0;
          loopDone[i]         = false;
          pathStopMax[i]      = 0;
          pathLastBp[i]       = 0;
          pathDirection[i]    = 1;
          pathDiagLogged[i]   = false;
          blockDrift[i]       = { x: 0, y: 0, lastAct: null };
        }
        for (let i = 0; i < blocks.length; i++) armTrigger(i, blocks[i]);
      }

      blocks.forEach(function (b, i) { armTrigger(i, b); });

      // Class-render teardown must release every per-block trigger
      // listener too (independent of the line-level ownListeners
      // path — those are now empty since armTrigger keeps its own
      // teardowns).
      ownCleanups.push(function () {
        for (let i = 0; i < blockTriggerTeardown.length; i++) {
          teardownBlockTrigger(i);
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
        // v0.8.22: 'after-previous' is similarly lazy — walk back
        // to the nearest preceding TIMED block, check whether it
        // has reached its end (activation + delay + seconds), and
        // activate this block at that exact instant so the chain
        // is gapless. Continuous blocks (scroll-driven / loop /
        // ping-pong) are skipped during the walk because they have
        // no discrete end (the editor's picker disables this option
        // when no prior timed block exists, so prevIdx<0 is the
        // tampered-data path only).
        if (activationState[idx] == null) {
          if (when === 'scroll-range') {
            const r = (b.trigger && b.trigger.range) || { start: 0, end: 1 };
            if (scrollP >= r.start) {
              activationState[idx] = nowSec;
              applyObjectEffects(b.trigger);  // v0.8.79
            }
            else return 0;
          } else if (when === 'after-previous') {
            let prevIdx = -1;
            for (let j = idx - 1; j >= 0; j--) {
              const pm = blocks[j].duration && blocks[j].duration.mode;
              if (pm === 'time') { prevIdx = j; break; }
            }
            if (prevIdx < 0) return 0;
            if (activationState[prevIdx] == null) return 0;
            const pb       = blocks[prevIdx];
            const pDelay   = (pb.trigger && pb.trigger.delay) || 0;
            const pSeconds = (pb.duration && pb.duration.seconds > 0)
                             ? pb.duration.seconds : 1;
            const pEnd     = activationState[prevIdx] + pDelay + pSeconds;
            if (nowSec < pEnd) return 0;
            activationState[idx] = pEnd;
            applyObjectEffects(b.trigger);  // v0.8.79
          } else {
            return 0;
          }
        }

        const delay = (b.trigger && b.trigger.delay) || 0;
        const t = nowSec - activationState[idx] - delay;
        if (t <= 0) return 0;
        const dur = (b.duration && b.duration.seconds > 0) ? b.duration.seconds : 1;
        let raw;
        if (mode === 'time' || mode === 'loopTo') {
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

        // v0.8.23: loopTo housekeeping. (a) On the first frame
        // post-activation snapshot the offset we'll undo — sum of
        // tx/ty/rot over time-mode blocks in [target..idx). That
        // chain has just finished (loopTo is normally triggered
        // 'after-previous' off the last chain link), so each
        // contributor is at bp=1 and authored deltas equal the
        // displayed offset. (b) When raw hits 1, fire the
        // completion exactly once: bump the iteration counter; if
        // a cap was set and we've reached it, stay parked at bp=1
        // forever (line at the target's start position); otherwise
        // re-activate the target and clear the chain so it replays.
        if (mode === 'loopTo') {
          if (loopOffset[idx] == null) {
            const K0 = (b.duration && Number.isInteger(b.duration.target))
                       ? b.duration.target : -1;
            let sx = 0, sy = 0, sr = 0;
            if (K0 >= 0 && K0 < idx) {
              for (let j = K0; j < idx; j++) {
                const bj = blocks[j];
                const bjm = bj && bj.duration && bj.duration.mode;
                if (bjm === 'time') {
                  sx += bj.tx  || 0;
                  sy += bj.ty  || 0;
                  sr += bj.rot || 0;
                }
              }
            }
            loopOffset[idx] = { x: sx, y: sy, rot: sr };
          }
          if (raw >= 1 && !loopPlayed[idx] && !loopDone[idx]) {
            loopPlayed[idx] = true;
            loopIterCount[idx]++;
            const maxIter = (b.duration && Number.isInteger(b.duration.maxIterations)
                              && b.duration.maxIterations > 0)
                            ? b.duration.maxIterations : 0;
            const K = (b.duration && Number.isInteger(b.duration.target))
                      ? b.duration.target : -1;
            if (maxIter > 0 && loopIterCount[idx] >= maxIter) {
              loopDone[idx] = true;
              // Stay parked: bp clamped to 1, contribution stays
              // at -loopOffset (cancels the chain so the line
              // rests at the target's start position).
            } else if (K >= 0 && K < idx) {
              const pEnd = activationState[idx] + delay + dur;
              activationState[K] = pEnd;
              for (let j = K + 1; j <= idx; j++) {
                activationState[j] = null;
              }
              loopOffset[idx] = null;
              loopPlayed[idx] = false;
              // v0.8.79: each loopTo cycle restarts block K's
              // chain — re-apply its trigger's object effects so
              // long-running loops can repeatedly nudge other
              // objects on every iteration.
              applyObjectEffects(blocks[K].trigger);
            }
            // K invalid (tampered data): we incremented the
            // counter but there's no chain to restart — block
            // just stays at bp=1, contribution 0 (loopOffset
            // snapshot was all zeros). Harmless.
          }
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
        const bps = new Array(blocks.length);
        for (let i = 0; i < blocks.length; i++) {
          const b  = blocks[i];
          const bp = blockProg(b, i, scrollP, nowSec);
          bps[i] = bp;
          if (b.duration && b.duration.mode === 'loopTo') {
            const off = loopOffset[i];
            if (off) {
              tx  -= bp * off.x;
              ty  -= bp * off.y;
              rot -= bp * off.rot;
            }
            continue;
          }
          // v0.8.53: pathFollow blocks don't contribute the usual
          // tx/ty/rot deltas — their position is computed in the
          // reverse pass below (last-active-wins so chained guides
          // hand off cleanly).
          if (b.pathFollow) {
            pathLastBp[i] = bp;
            continue;
          }
          tx  += b.driftX ? blockDrift[i].x : bp * b.tx;
          ty  += b.driftY ? blockDrift[i].y : bp * b.ty;
          // v0.8.220: rot is summed; the single object pivot
          // (resolved once above) is applied at emit time.
          rot += bp * b.rot;
        }
        // v0.8.26: opacity composition — last active fade-opacity
        // block wins.
        // v0.8.67: replaced `bp <= 0` with isBlockActive — at
        // bp=0 the block is at its FROM value and should
        // contribute (block triggered, just at the start of its
        // animation). The old skip caused an opacity jump on
        // first scroll when a block had scroll range 0–X and
        // fade 0.5→1: page load showed opacity 1 (default,
        // because bp=0 was skipped), then scroll>0 immediately
        // showed 0.5. isBlockActive correctly skips only the
        // pre-trigger case.
        let opacity = 1;
        for (let i = blocks.length - 1; i >= 0; i--) {
          const b = blocks[i];
          if (!b.fadeOpacity) continue;
          if (!isBlockActive(i, scrollP, nowSec)) continue;
          const bp = bps[i];
          opacity = b.opacityFrom + (b.opacityTo - b.opacityFrom) * bp;
          break;
        }
        // v0.8.53: pathFollow composition — last active pathFollow
        // block wins (chained guides: a later block takes over
        // when its bp starts). Skipped silently if pathRef doesn't
        // resolve to a path element. When active, the path-derived
        // target overrides positionOffset in writeAt (the path
        // dictates absolute position, not an offset).
        let pathFollowActive = false;
        let pathTx = 0, pathTy = 0, pathRot = 0;
        for (let i = blocks.length - 1; i >= 0; i--) {
          const b = blocks[i];
          if (!b.pathFollow) continue;
          // v0.8.56 DIAGNOSTIC: log once per block on first reach.
          const _diagLog = function (msg, extra) {
            if (pathDiagLogged[i]) return;
            pathDiagLogged[i] = true;
            console.log('[pathFollow blk ' + i + ' on ' + (lineDef && lineDef.id) + '] '
              + msg, extra || '');
          };
          if (!isBlockActive(i, scrollP, nowSec)) {
            _diagLog('skipped: !isBlockActive', {
              triggerWhen: b.trigger && b.trigger.when,
              activationState: activationState[i],
              scrollP: scrollP, nowSec: nowSec
            });
            continue;
          }
          const bp = bps[i];
          // v0.8.57: pathRef is now a master id (shared across
          // classes), looked up via data-master-id on the path
          // elements. Legacy pathRef values that stored a per-
          // class line id won't resolve here — user re-picks the
          // guide in the editor's panel to save a master id.
          let guide = b.pathRef
            ? layer.querySelector('[data-master-id="' + b.pathRef + '"]')
            : null;
          // v0.8.60: master-id lookup fails when the user's data
          // has per-class master drift (the "same" logical line
          // has different masterIds in different classes — common
          // in datasets that survived the v0.8.42–46 skeleton-
          // corruption cycle). Fall back to NAME lookup: find a
          // line in the current class whose name matches what the
          // editor saved as pathRefName at pick time.
          if (!guide && b.pathRefName) {
            const sibLine = lines.find(function (l) {
              return (l.name || l.id) === b.pathRefName;
            });
            if (sibLine) {
              guide = layer.querySelector('[data-line-id="' + sibLine.id + '"]');
            }
          }
          if (!guide && b.pathRef && !pathDiagLogged[i]) {
            // v0.8.59: when the lookup fails, dump every master id
            // present on the layer so the user can see whether the
            // expected one is even rendered. Caps at 30 to avoid
            // flooding the console.
            const allMids = Array.prototype.slice
              .call(layer.querySelectorAll('[data-master-id]'))
              .map(function (el) { return el.dataset.masterId; });
            const sampleMids = allMids.slice(0, 30);
            console.log('[pathFollow blk ' + i + ' on ' + (lineDef && lineDef.id) + '] '
              + 'guide not found — DOM has ' + allMids.length
              + ' elements with data-master-id. First ' + sampleMids.length + ':',
              sampleMids);
          }
          if (!guide) {
            _diagLog('skipped: guide not found', { pathRef: b.pathRef });
            continue;
          }
          if (typeof guide.getTotalLength !== 'function') {
            _diagLog('skipped: guide has no getTotalLength', {
              pathRef: b.pathRef, tag: guide.tagName, kind: guide.dataset && guide.dataset.kind
            });
            continue;
          }
          const totalLen = guide.getTotalLength();
          if (!(totalLen > 0)) {
            _diagLog('skipped: totalLen <= 0', { totalLen: totalLen, pathRef: b.pathRef });
            continue;
          }
          // Map bp → path fraction via pathEndMode.
          let frac;
          if (b.pathEndMode === 'stop') {
            pathStopMax[i] = Math.max(pathStopMax[i] || 0, bp);
            frac = pathStopMax[i];
          } else if (b.pathEndMode === 'pingpong') {
            // Detect bp wrap (large backwards jump) and flip
            // direction so the path traversal reverses instead
            // of snapping back to start.
            const last = pathLastBp[i] || 0;
            if (last - bp > 0.5) pathDirection[i] = -(pathDirection[i] || 1);
            frac = (pathDirection[i] === -1) ? (1 - bp) : bp;
          } else {
            // 'loop' or default — use bp directly, accepting any
            // visual snap on the wrap (fine for closed paths).
            frac = bp;
          }
          if (frac < 0) frac = 0; else if (frac > 1) frac = 1;
          let localPoint;
          try { localPoint = guide.getPointAtLength(frac * totalLen); }
          catch (e) { continue; }
          // Transform from guide's local coords → SVG viewBox coords
          // (this layer's coordinate space). layer.getCTM().inverse()
          // × guide.getCTM() composes the two; whatever the guide's
          // own translate/rotate is at this frame is automatically
          // baked in via guide.getCTM().
          const ctmGuide = guide.getCTM();
          const ctmLayer = layer.getCTM();
          if (!ctmGuide || !ctmLayer) {
            _diagLog('skipped: null CTM', {
              ctmGuide: !!ctmGuide, ctmLayer: !!ctmLayer
            });
            continue;
          }
          const guideToLayer = ctmLayer.inverse().multiply(ctmGuide);
          // v0.8.62: use SVGPoint.matrixTransform instead of
          // DOMMatrix.transformPoint — older browsers / certain
          // SVG element implementations return SVGMatrix from
          // getCTM(), which has no transformPoint. matrixTransform
          // is on every SVGPoint / DOMPoint and accepts either
          // matrix type.
          const layerPt = localPoint.matrixTransform(guideToLayer);
          // Follower's natural center: bbox center in its own
          // local coords. We translate so that center lands on
          // layerPt. The translate replaces positionOffset (handled
          // in writeAt via pathFollowActive flag).
          let cx = 0, cy = 0;
          try {
            const bbox = pathEl.getBBox();
            cx = bbox.x + bbox.width  / 2;
            cy = bbox.y + bbox.height / 2;
          } catch (e) { /* path has no bbox yet */ }
          pathTx = layerPt.x - cx;
          pathTy = layerPt.y - cy;
          if (b.pathAlignToTangent) {
            // Sample one path-unit ahead for tangent direction;
            // transform both points so the tangent is in the
            // layer's coord space (handles guide rotation).
            const aheadFrac = Math.min(1, frac + 0.5 / totalLen);
            let aheadLocal;
            try { aheadLocal = guide.getPointAtLength(aheadFrac * totalLen); }
            catch (e) { aheadLocal = null; }
            if (aheadLocal) {
              const aheadLayer = aheadLocal.matrixTransform(guideToLayer);
              const dx = aheadLayer.x - layerPt.x;
              const dy = aheadLayer.y - layerPt.y;
              if (dx !== 0 || dy !== 0) {
                let ang = Math.atan2(dy, dx) * 180 / Math.PI;
                // If we walked backwards (pingpong reversed), flip
                // the tangent so the follower faces its travel
                // direction, not the path's authored direction.
                if (b.pathEndMode === 'pingpong' && pathDirection[i] === -1) {
                  ang += 180;
                }
                pathRot = ang;
              }
            }
          }
          _diagLog('ACTIVE', {
            bp: bp, frac: frac, totalLen: totalLen,
            localPt: { x: localPoint.x, y: localPoint.y },
            layerPt: { x: layerPt.x, y: layerPt.y },
            followerCenter: { x: cx, y: cy },
            pathTx: pathTx, pathTy: pathTy, pathRot: pathRot
          });
          pathFollowActive = true;
          break;
        }
        if (pathFollowActive) {
          tx  += pathTx;
          ty  += pathTy;
          rot += pathRot;
        }
        // v0.8.91: drawIn composition — last-active-wins, like
        // opacity. Pre-trigger blocks contribute nothing; the path
        // keeps the initial-paint hidden state (dashoffset = ±1).
        // Once a drawIn block is active, dashoffset = dir × (1 − bp):
        //   bp=0 → dashoffset = dir   (fully hidden, reveal not started)
        //   bp=1 → dashoffset = 0     (fully visible, reveal complete)
        // dir is per-block: 'forward' = +1, 'reverse' = -1.
        // Loop / pingpong durations make bp cycle, so dashoffset
        // cycles too — repeating draw / undraw passes for free.
        // null = no active drawIn this frame; writeAt leaves the
        // attribute alone (keeps prior frame's value, which is the
        // intent: a finished pass stays at offset=0, a not-yet-started
        // pass stays at ±1 from initial-paint).
        let drawInOffset = null;
        if (anyDrawIn) {
          for (let i = blocks.length - 1; i >= 0; i--) {
            const b = blocks[i];
            if (!b.drawIn) continue;
            if (!isBlockActive(i, scrollP, nowSec)) continue;
            const bp = bps[i];
            const dir = b.drawInDirection === 'reverse' ? -1 : 1;
            drawInOffset = dir * (1 - bp);
            break;
          }
        }
        return {
          tx: tx, ty: ty, rot: rot, opacity: opacity,
          pathFollowActive: pathFollowActive,
          drawInOffset: drawInOffset
        };
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
        // v0.8.77: scroll-stop / scroll-start trigger blocks need a
        // ticker so their fire gets painted — the trigger may fire
        // while the user is NOT scrolling, so ScrollTrigger.onUpdate
        // won't kick in on its own.
        // v0.8.91: drawIn now rides this same hasTime path implicitly:
        // a block with drawIn + duration.mode !== 'scroll' already
        // matches the first clause below, so the ticker fires and
        // writeAt advances the dashoffset over wall clock.
        const when = b.trigger && b.trigger.when;
        return (b.duration && b.duration.mode !== 'scroll')
            || b.driftX || b.driftY
            || when === 'scroll-stop' || when === 'scroll-start';
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

      // v0.8.231: flow-mode helper scoped to this line. Computes the
      // transform string for the given scrollY-in-SVG value. For static
      // objects the flow offset is always 0, so the result matches the
      // old initialXform every time.
      const xformFor = function (flowOffY) {
        return 'translate(' + offX + ' ' + (offY - flowOffY) + ') rotate(0 ' + originX + ' ' + originY + ')';
      };
      // Initial state: static positionOffset only (no animation yet).
      // For flow-mode lines, also account for the current scrollY so
      // the object appears at its correct document position on first paint
      // (important when the page loads partway down, e.g. via a hash link).
      const initialFlowY = (!diagMode && isFlowMode(lineDef)) ? scrollToSvgY() : 0;
      const initialXform = xformFor(initialFlowY);
      pathEl.setAttribute('transform', initialXform);
      // v0.8.217: mirror the initial transform onto the text overlay
      // too. Previously textEl only got a transform once writeAt fired
      // (per-frame), so on first paint — and forever for lines with
      // no behaviors at all — the text sat at canonical (pre-offset)
      // coordinates while the path was already translated by
      // positionOffset. Symptom: edit the object in the editor (which
      // updates positionOffset, not the master geometry the runtime
      // reads), reload runtime → object visually moved, text stuck at
      // its old place. Setting the same initialXform on textEl pulls
      // it along.
      if (textEl) textEl.setAttribute('transform', initialXform);

      // v0.8.231: for flow-mode objects that have NO behaviors (hasMotion
      // = false, so writeAt is never installed), wire up a dedicated
      // passive scroll listener to keep the transform current. For lines
      // with behaviors, writeAt already calls scrollToSvgY() on every
      // frame — no separate listener needed there.
      if (!diagMode && isFlowMode(lineDef) && !hasMotion) {
        const onScrollFlow = function () {
          const xf = xformFor(scrollToSvgY());
          pathEl.setAttribute('transform', xf);
          if (textEl) textEl.setAttribute('transform', xf);
        };
        window.addEventListener('scroll', onScrollFlow, { passive: true });
        ownListeners.push({ target: window, type: 'scroll', fn: onScrollFlow });
      }

      // v0.8.91: drawIn initial-paint. If any block has drawIn:true,
      // set up the dash machinery once. pathLength="1" normalizes
      // everything to a unit-length path so dasharray "1 1" plus
      // dashoffset ±1..0 work regardless of geometric length or any
      // non-uniform transform — same math the old GSAP tween used.
      // The wiring is what changed: the offset is now updated each
      // frame inside writeAt from each active block's bp.
      //
      // Initial offset:
      //   diagMode (Grid toggle) → 0 (fully visible, matches editor).
      //                            writeAt isn't installed in diagMode
      //                            so this value sticks.
      //   normal mode            → ±1 (fully hidden) so the line
      //                            doesn't flash full-visible at page
      //                            load before the first tick. Sign
      //                            follows the FIRST drawIn block's
      //                            direction.
      if (anyDrawIn) {
        pathEl.setAttribute('pathLength',       '1');
        pathEl.setAttribute('stroke-dasharray', '1 1');
        pathEl.setAttribute(
          'stroke-dashoffset',
          diagMode ? '0' : String(initialDashDir)
        );
      }

      // Diagnostic mode (Grid toggle on): paths render at their authored
      // d coordinates with identity transform — matches the editor canvas
      // exactly so the author can compare positions. Skip ScrollTrigger
      // setup so per-element triggers can't apply a mid-viewport progress
      // at scrollY=0.
      if (hasMotion && !diagMode) {
        // v0.8.79: snapshot of the most recent computeAt output.
        // requestStop() reads this as the "frozen" contribution
        // that the cleanup tween will scale toward zero — avoids
        // re-running computeAt (which has drift / loop side
        // effects) just to capture a still frame.
        let lastContribution = null;
        const paintNeutral = function () {
          const _pFlowY = isFlowMode(lineDef) ? scrollToSvgY() : 0;
          pathEl.setAttribute(
            'transform',
            'translate(' + offX + ' ' + (offY - _pFlowY) + ') ' +
            'rotate(0 ' + originX + ' ' + originY + ')'
          );
          pathEl.setAttribute('opacity', '1');
          // v0.8.91: reset draw-in to its initial-paint hidden state
          // so a future requestStart fires a fresh reveal. Without
          // this, a target stopped mid-reveal then restarted would
          // jump from its frozen partial-reveal to bp=0's hidden
          // state on the next tick — better to do it here in one
          // assignment than tolerate the flicker.
          if (anyDrawIn) {
            pathEl.setAttribute('stroke-dashoffset', String(initialDashDir));
          }
        };
        const writeAt = function (scrollP, nowSec) {
          // v0.8.79: cleanup tween painter. While stopState is set,
          // ignore the live behavior chain and tween the frozen
          // contribution toward zero (returnHome) and/or opacity
          // toward zero (fadeOut). At elapsed >= duration, finalize
          // into isStopped + clear per-block state so the target
          // sits in its neutral pre-fire form.
          if (stopState) {
            const elapsed = nowSec - stopState.t0;
            const dur = stopState.durationSec;
            if (elapsed >= dur) {
              const fz = stopState.frozen;
              const ftx  = stopState.returnHome ? 0 : fz.tx;
              const fty  = stopState.returnHome ? 0 : fz.ty;
              const frot = stopState.returnHome ? 0 : fz.rot;
              const fop  = stopState.fadeOut    ? 0 : fz.opacity;
              const _sFlowY = isFlowMode(lineDef) ? scrollToSvgY() : 0;
              const finalXform = 'translate(' + (offX + ftx) + ' ' + (offY + fty - _sFlowY) + ') ' +
                'rotate(' + frot + ' ' + originX + ' ' + originY + ')';
              pathEl.setAttribute('transform', finalXform);
              pathEl.setAttribute('opacity', fop);
              if (textEl) {
                textEl.setAttribute('transform', finalXform);
                textEl.setAttribute('opacity', fop);
              }
              isStopped = true;
              stopState = null;
              // Clear every per-block runtime variable so a future
              // requestStart() rearms from a clean slate.
              for (let i = 0; i < blocks.length; i++) {
                activationState[i] = null;
                loopOffset[i]      = null;
                loopPlayed[i]      = false;
                loopIterCount[i]   = 0;
                loopDone[i]        = false;
                pathStopMax[i]     = 0;
                pathLastBp[i]      = 0;
                pathDirection[i]   = 1;
                pathDiagLogged[i]  = false;
                blockDrift[i]      = { x: 0, y: 0, lastAct: null };
                teardownBlockTrigger(i);
              }
              // Stop the cleanup ticker if requestStop installed one.
              if (cleanupTicker) {
                try { gsap.ticker.remove(cleanupTicker); } catch (e) {}
                cleanupTicker = null;
              }
              return;
            }
            const tNorm = dur > 0 ? elapsed / dur : 1;
            const e = stopState.easingFn(tNorm);
            const inv = 1 - e;
            const fz = stopState.frozen;
            const txc  = stopState.returnHome ? fz.tx  * inv : fz.tx;
            const tyc  = stopState.returnHome ? fz.ty  * inv : fz.ty;
            const rotc = stopState.returnHome ? fz.rot * inv : fz.rot;
            const opc  = stopState.fadeOut    ? fz.opacity * inv : fz.opacity;
            const _cFlowY = isFlowMode(lineDef) ? scrollToSvgY() : 0;
            const cleanupXform = 'translate(' + (offX + txc) + ' ' + (offY + tyc - _cFlowY) + ') ' +
              'rotate(' + rotc + ' ' + originX + ' ' + originY + ')';
            pathEl.setAttribute('transform', cleanupXform);
            pathEl.setAttribute('opacity', opc);
            if (textEl) {
              textEl.setAttribute('transform', cleanupXform);
              textEl.setAttribute('opacity', opc);
            }
            return;
          }
          // v0.8.79: target is in neutral pre-fire state until
          // requestStart() re-arms us. writeAt leaves the path
          // attributes untouched (whatever paintNeutral / final
          // cleanup frame already set).
          if (isStopped) return;

          const t = computeAt(scrollP, nowSec);
          lastContribution = t;
          // v0.8.53: when pathFollow is the dominant translate
          // contributor this frame, the path dictates absolute
          // position — positionOffset would shift the follower
          // off the path. Skip the static offset in that case;
          // t.tx/t.ty already include (layerPathPoint - bbox
          // center) so the follower's center lands on the path.
          const useOffX = t.pathFollowActive ? 0 : offX;
          const useOffY = t.pathFollowActive ? 0 : offY;
          // v0.8.231: flow-mode lines scroll with the page. The SVG
          // layer is position:fixed so we compensate by subtracting
          // scrollY (in SVG units) from the Y component every frame.
          // Static-mode objects use flowOffY = 0 (prior behavior).
          const flowOffY = isFlowMode(lineDef) ? scrollToSvgY() : 0;
          const liveXform = 'translate(' + (useOffX + t.tx) + ' ' + (useOffY + t.ty - flowOffY) + ') ' +
            'rotate(' + t.rot + ' ' + originX + ' ' + originY + ')';
          pathEl.setAttribute('transform', liveXform);
          // v0.8.26: opacity is always written (cheap setAttribute,
          // and a constant 1 from no-fade blocks is the SVG default
          // — net no-op visually). Lets fade blocks just work
          // without an extra "has any fade?" precompute.
          pathEl.setAttribute('opacity', t.opacity);
          // v0.8.195: keep the text overlay in sync. Skip drawIn —
          // dashoffset is path-specific and SVG text doesn't paint via
          // stroke-dash in this app.
          if (textEl) {
            textEl.setAttribute('transform', liveXform);
            textEl.setAttribute('opacity', t.opacity);
          }
          // v0.8.91: drawIn dashoffset. null = no active drawIn
          // block this frame → leave the attribute alone (a
          // pre-trigger block keeps the initial-paint hidden state;
          // a completed block keeps its final visible state).
          if (t.drawInOffset != null) {
            pathEl.setAttribute('stroke-dashoffset', String(t.drawInOffset));
          }
        };
        // v0.8.79: cleanupTicker drives writeAt every frame during
        // a stopState tween, so the cleanup paints smoothly even
        // on a target line that has no time-driven blocks of its
        // own (and therefore no permanent ticker). Installed in
        // requestStop, removed on finalization or on requestStart.
        let cleanupTicker = null;
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
        // v0.8.71: prime the first frame. ScrollTrigger.create doesn't
        // reliably fire onUpdate at setup when scroll = 0 and the
        // trigger's start is also 0 (no scroll-position delta to
        // react to). That left visual state at the path's SVG
        // defaults — most visibly opacity (=1 by default) instead
        // of the block's opacityFrom — until the user scrolled,
        // producing a jump on first scroll. Calling writeAt
        // explicitly here applies the block's starting state on
        // page load, so the very first paint matches what the
        // animation should look like at bp = 0.
        writeAt(st.progress || 0, performance.now() / 1000);
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

        // v0.8.79: register this line as a Stop / Start target. Key
        // = line.masterId (class identity, shared by every rendered
        // instance of this class — siblings pause / restart together
        // by design). Lines without a masterId are not targetable;
        // they animate but can't be controlled cross-object.
        const classKey = lineDef.masterId || null;
        if (classKey) {
          const requestStop = function (opts) {
            if (isStopped || stopState) return;  // already stopped / in cleanup
            const dur = Number(opts && opts.durationSec) || 0;
            const fadeOut = !!(opts && opts.fadeOut);
            const returnHome = !!(opts && opts.returnHome);
            if (dur <= 0 || (!fadeOut && !returnHome)) {
              // Instantaneous reset — paint neutral, clear all
              // per-block state, tear down listeners.
              isStopped = true;
              paintNeutral();
              for (let i = 0; i < blocks.length; i++) {
                activationState[i] = null;
                loopOffset[i]      = null;
                loopPlayed[i]      = false;
                loopIterCount[i]   = 0;
                loopDone[i]        = false;
                pathStopMax[i]     = 0;
                pathLastBp[i]      = 0;
                pathDirection[i]   = 1;
                pathDiagLogged[i]  = false;
                blockDrift[i]      = { x: 0, y: 0, lastAct: null };
                teardownBlockTrigger(i);
              }
              return;
            }
            const frozen = lastContribution
              ? { tx: lastContribution.tx, ty: lastContribution.ty,
                  rot: lastContribution.rot, opacity: lastContribution.opacity }
              : { tx: 0, ty: 0, rot: 0, opacity: 1 };
            let easingFn;
            try {
              const en = (opts && opts.easing) || 'linear';
              easingFn = (en === 'linear')
                ? function (x) { return x; }
                : (gsap.parseEase && gsap.parseEase(en)) || function (x) { return x; };
            } catch (eEase) { easingFn = function (x) { return x; }; }
            stopState = {
              t0: performance.now() / 1000,
              durationSec: dur,
              easingFn: easingFn,
              fadeOut: fadeOut,
              returnHome: returnHome,
              frozen: frozen
            };
            // Ensure the cleanup paints every frame even if this
            // line has no time-driven blocks of its own.
            if (!cleanupTicker) {
              cleanupTicker = function () {
                writeAt(st ? st.progress : 0, performance.now() / 1000);
              };
              gsap.ticker.add(cleanupTicker);
            }
          };
          const requestStart = function () {
            // v0.8.82: unified Start semantics.
            //
            //   (a) If the target is stopped or mid-cleanup, rearm
            //       first — that resets every activationState[i] to
            //       null so all blocks return to the "waiting" state.
            //   (b) Then force-fire the EARLIEST waiting block: set
            //       its activationState, tear down its natural-arming
            //       listener so the natural condition can't fire it
            //       again later, and fan out applyObjectEffects.
            //
            // A "waiting" block is one whose natural trigger hasn't
            // fired yet (activationState[i] == null). Already-fired
            // blocks stay fired — Start never double-fires. If every
            // block has already fired, Start is a no-op.
            //
            // Earliest-only (not all) preserves the authored chain
            // ordering: an after-previous block will still chain off
            // the Start-fired block's completion; a later
            // scroll-range block still waits for its scroll cue.
            if (stopState) {
              stopState = null;
              if (cleanupTicker) {
                try { gsap.ticker.remove(cleanupTicker); } catch (e) {}
                cleanupTicker = null;
              }
              isStopped = false;
              paintNeutral();
              rearm();
            } else if (isStopped) {
              isStopped = false;
              paintNeutral();
              rearm();
            }
            for (let i = 0; i < blocks.length; i++) {
              if (activationState[i] == null) {
                activationState[i] = performance.now() / 1000;
                teardownBlockTrigger(i);
                applyObjectEffects(blocks[i].trigger);
                break;
              }
            }
          };
          registerObjectController(classKey, {
            classKey: classKey,
            requestStart: requestStart,
            requestStop: requestStop
          });
        }
      }

      // v0.8.91: legacy stand-alone drawIn tween removed — reveal is
      // now driven by computeAt → writeAt (search 'drawInOffset').
      // Initial-paint dash setup lives next to the transform init
      // above. The change makes drawIn work with non-scroll triggers
      // (page-load + time, click, hover, wait, …) and gives each
      // block independent timing for free.
    });

    // v0.8.79: every line is now registered in objectRegistry. Flush
    // any cross-object effects that fired during init (page-load
    // triggers, scroll-range immediate entries) — they were queued
    // because the first line couldn't safely act on the last line's
    // controller before that controller existed.
    objectInitFlushing = false;
    const queued = pendingObjectEffects.slice();
    pendingObjectEffects.length = 0;
    queued.forEach(applyObjectEffects);

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

  function renderRuntimePageGuide(layer, page, version, classLabel) {
    const SVG_NS_LOCAL = 'http://www.w3.org/2000/svg';
    const pw = page.pageW, ph = page.pageH;

    const rect = document.createElementNS(SVG_NS_LOCAL, 'rect');
    rect.setAttribute('x', 0);
    rect.setAttribute('y', 0);
    rect.setAttribute('width',  pw);
    rect.setAttribute('height', ph);
    rect.setAttribute('fill', 'none');
    rect.setAttribute('stroke', '#9a4');
    rect.setAttribute('stroke-width', 2);
    rect.setAttribute('stroke-dasharray', '8 4');
    rect.style.vectorEffect = 'non-scaling-stroke';
    rect.style.pointerEvents = 'none';
    layer.appendChild(rect);

    // v0.8.31: version badge in the top-right of the page area,
    // inset from the dashed outline so it reads as outline metadata
    // (not a corner-coordinate label). Same color family as the
    // outline + corner labels; tagged with the page-guide so it
    // appears and disappears together with the rest of the guide.
    if (version || classLabel) {
      // v0.8.58: combined version + class label, right-aligned in
      // the top-right of the page area. Class label tells the
      // author which class the runtime selected at the current
      // viewport width — critical when debugging behaviors that
      // reference other lines (cross-class id mismatches).
      const vt = document.createElementNS(SVG_NS_LOCAL, 'text');
      vt.setAttribute('x', pw - 8);
      vt.setAttribute('y', 16);
      vt.setAttribute('text-anchor', 'end');
      vt.setAttribute('fill', '#9a4');
      vt.setAttribute('font-family', 'ui-monospace, monospace');
      vt.setAttribute('font-size', 11);
      vt.style.pointerEvents = 'none';
      const parts = [];
      if (version)    parts.push('v' + version);
      if (classLabel) parts.push('class: ' + classLabel);
      vt.textContent = parts.join(' · ');
      layer.appendChild(vt);
    }

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
