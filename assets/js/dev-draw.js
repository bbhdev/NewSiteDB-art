/**
 * /dev/draw — line-system editor.
 *
 * Tools shipped in 3b.1:
 *   freehand   click-drag to draw a smoothed/raw stroke
 *   line       click, drag to a second point, release — single line
 *   lineChain  click anchors in succession, each one creates a new line
 *              from the previous endpoint. Esc or double-click finishes.
 *
 * Geometric primitives (circle, rect, arc, N-star, diamond, pentagon)
 * arrive in 3b.2 as additional entries in the TOOLS registry.
 *
 * No build step, no framework — vanilla DOM + a hand-rolled mini state
 * model. Each user action mutates `state`, then renderAll() rebuilds
 * the parts of the UI that depend on it.
 */
(function () {
  'use strict';

  // ── Coordinate space ──────────────────────────────────────────────
  // The editor SVG matches the runtime layer: page area sits at
  // (0, 0) – (pageW, pageH), and the viewBox extends symmetrically
  // around it to canvasW × canvasH so off-page lines have room. All
  // four dimensions are per-page data (state.page), so changing them
  // re-skins the canvas at runtime — see applyPageConfig() below.
  // Pointer events are converted to logical viewBox coords by
  // clientToSvg(), which reads the viewBox attribute live so this
  // works after scrolling, zooming, or resizing the canvas.
  const SVG_NS = 'http://www.w3.org/2000/svg';

  // ── DOM refs ──────────────────────────────────────────────────────
  const svg        = document.getElementById('draw-surface');
  const canvasWrap = document.querySelector('.ed-canvas-wrap');
  const gridG      = document.getElementById('grid');
  const linesG     = document.getElementById('committed-lines');
  const previewG   = document.getElementById('preview-layer');
  const toolButtons = document.querySelectorAll('.ed-tool');
  const toolSettingsEl = document.getElementById('tool-settings');
  const groupsListEl   = document.getElementById('groups-list');
  const paletteListEl  = document.getElementById('palette-list');
  const selectionPanel = document.getElementById('selection-panel');
  const handlesG       = document.getElementById('handles-layer');
  const labelsG        = document.getElementById('labels-layer');
  const settingsBtn    = document.getElementById('settings-btn');
  const selectAllBtn   = document.getElementById('select-all-btn');
  const newGroupBtn    = document.getElementById('new-group-btn');
  const newColorBtn    = document.getElementById('new-color-btn');
  const saveBtn        = document.getElementById('save-btn');
  const saveStatus     = document.getElementById('save-status');
  const clearLinesBtn  = document.getElementById('clear-lines-btn');
  const helpBtn        = document.getElementById('help-btn');
  const setOriginBanner = document.getElementById('set-origin-banner');
  const wizardBanner    = document.getElementById('wizard-banner');
  const wizardLabel     = document.getElementById('wizard-banner-label');
  const wizardSaveBtn   = document.getElementById('wizard-save-btn');
  const wizardCancelBtn = document.getElementById('wizard-cancel-btn');
  const createObjectBtn = document.getElementById('create-object-btn');

  // Defensive: if any required element is missing, the user is probably
  // serving stale cached HTML against fresh JS (or vice-versa). Log
  // loudly so the cause is obvious in DevTools.
  const zoomInBtn    = document.getElementById('zoom-in');
  const zoomOutBtn   = document.getElementById('zoom-out');
  const zoomLevelEl  = document.getElementById('zoom-level');
  const undoBtn      = document.getElementById('undo-btn');
  const redoBtn      = document.getElementById('redo-btn');

  const required = { svg, canvasWrap, gridG, linesG, previewG, handlesG,
                     labelsG, settingsBtn, selectAllBtn,
                     toolSettingsEl, groupsListEl, paletteListEl,
                     selectionPanel, newGroupBtn, newColorBtn,
                     saveBtn, saveStatus, clearLinesBtn, helpBtn,
                     zoomInBtn, zoomOutBtn, zoomLevelEl,
                     undoBtn, redoBtn };
  const missing = Object.keys(required).filter(function (k) { return !required[k]; });
  if (missing.length) {
    console.error('[dev-draw] Missing required DOM elements:', missing,
                  '— browser may be serving stale HTML. Hard-reload (Cmd+Shift+R).');
    return;
  }

  // ── Master / instance plumbing (v4+) ─────────────────────────────
  // The editor operates on flat "line" records (resolved master ⊕
  // instance overrides). Masters + instances are the on-disk shape;
  // load (below) resolves them in, save (decomposeForSave, further
  // down) writes them back out. line.overrides keeps the explicit
  // override map (both visual + behavior keys), so the editor can
  // tell at any moment whether a given property is master-linked
  // (no entry in overrides) or instance-overridden (entry present).
  // Declared here (above state init) so resolveInstanceJS is
  // callable at load time without TDZ trouble.
  const MASTER_VISUAL_KEYS = [
    'kind', 'points', 'params', 'segments',
    'smoothed', 'closed', 'filled',
    'd', 'stroke', 'width', 'linejoin', 'name',
    // v0.8.195: optional text overlay (Slice 1 — master-level only,
    // canonical by default; no per-instance override UI yet). Shape:
    //   { value, offsetX, offsetY, fontFamily, fontSize, color }
    // Absent / empty value → no text rendered.
    'text',
    // v0.8.228 (textBlock Slice 1a): independent fill color. Today
    // only the textBlock kind reads this (everything else uses
    // line.stroke as its fill when `filled`). Stored as a palette
    // color id (resolved at render time) so palette renames
    // propagate, same as `stroke`.
    'fill'
  ];
  // Position sub-keys live on positionOffset (not in scope). Owning
  // them per-class is structural — scope toggles don't apply.
  const POSITION_PARAM_SUBKEYS = ['cx', 'cy', 'x', 'y'];

  // Behavior keys live on instance.overrides regardless of scope —
  // they're scroll-driven animation params, always per-class.
  const BEHAVIOR_KEYS = ['translateX', 'translateY', 'rotate',
                         'drawIn', 'drawInDirection',
                         'rotateOriginX', 'rotateOriginY'];

  // v0.8.46: shared issue log populated during the load pass
  // (resolveInstanceJS pushes here; decomposeForSave reads it too).
  // Declared above state-init because resolveInstanceJS runs in the
  // initial-byClass mapping before `state` exists. After state init
  // the editor reads this on render and surfaces a banner if non-
  // empty so silent corruption like the v0.8.45 skeleton-master
  // case can't ride along undetected.
  const loadIssues = { missingMasters: [], skeletonLines: [] };

  // v0.8.40: hand-drawn outline arrows for the Import (up) and
  // Snapshots (down) buttons. Inline SVG so they render
  // identically regardless of font / weight / parent context —
  // the prior Unicode-glyph approach (⇧ / ⇩) was at the mercy
  // of glyph variants and anti-aliasing differences between the
  // two button cascades. Same path, just one flipped via CSS
  // (scaleY(-1)) so the up/down geometry is provably identical.
  const ARROW_SVG_DOWN_HTML =
    '<svg class="ed-arrow-icon" viewBox="0 0 16 16" '
    + 'fill="none" stroke="currentColor" stroke-width="1.4" '
    + 'stroke-linejoin="round" stroke-linecap="round" '
    + 'aria-hidden="true">'
    + '<path d="M5 1 L5 8 L1.5 8 L8 14.5 L14.5 8 L11 8 L11 1 Z"/>'
    + '</svg>';
  const ARROW_SVG_UP_HTML =
    '<svg class="ed-arrow-icon ed-arrow-icon-flip" viewBox="0 0 16 16" '
    + 'fill="none" stroke="currentColor" stroke-width="1.4" '
    + 'stroke-linejoin="round" stroke-linecap="round" '
    + 'aria-hidden="true">'
    + '<path d="M5 1 L5 8 L1.5 8 L8 14.5 L14.5 8 L11 8 L11 1 Z"/>'
    + '</svg>';
  // v0.8.45: monochrome magnifying-glass icon for the Orphans
  // button. Matches the arrow icons' line weight + currentColor
  // approach so the editor's icon vocabulary stays white-on-dark
  // throughout — colored emoji (the previous 🧹 broom) read as
  // out of place and had a dark interior segment that disappeared
  // against the button background.
  const FIND_ICON_SVG_HTML =
    '<svg class="ed-arrow-icon" viewBox="0 0 16 16" '
    + 'fill="none" stroke="currentColor" stroke-width="1.4" '
    + 'stroke-linecap="round" stroke-linejoin="round" '
    + 'aria-hidden="true">'
    + '<circle cx="7" cy="7" r="4.5"/>'
    + '<line x1="10.5" y1="10.5" x2="14" y2="14"/>'
    + '</svg>';

  /**
   * Read the scope of a property on a master. Returns 'local' or
   * 'canonical'. Default is canonical when the master has no scope
   * entry (sparse map — only locals are listed).
   *
   * Path is dotted for nested keys: 'stroke', 'params.points',
   * 'params.sides', etc.
   */
  function getScope(master, keyPath) {
    if (!master || !master.scope) return 'canonical';
    return master.scope[keyPath] === 'local' ? 'local' : 'canonical';
  }
  // Behavior blocks describe scroll-driven animation per instance.
  // Each block: { id, range: { start, end }, kind, params }.
  // range is a scroll-progress interval (0..1) within the line's
  // trigger window. params holds the legacy behavior keys
  // (translateX/Y, rotate, drawIn, …). Multiple blocks per line
  // enable chained motions — v0.4.0 lays the data + minimal
  // single-block UI; multi-block authoring lands in v0.4.1.
  function cloneBehavior(b) {
    // v0.8.7: trigger and duration split into orthogonal axes.
    //   trigger: { when, range?, selector?, delay }
    //     when ∈ { scroll-range, page-load, scroll-key,
    //              in-view-partial, in-view-full, after-previous }
    //   duration: { mode, seconds?, easing?, target?, maxIterations? }
    //     mode ∈ { scroll, time, loop, pingpong, loopTo }
    //     target, maxIterations: loopTo only (target = index of an
    //     earlier time-mode block to return to; maxIterations = 0/
    //     missing means run forever, else stop after N iterations).
    //
    // Old shapes are healed in-place: legacy block.range / legacy
    // trigger.type fall back to the new shape via cloneBehaviorTrigger
    // / cloneBehaviorDuration so a save without the CLI migration
    // still produces clean data.
    const out = {
      id:   b.id || ('b-' + Math.random().toString(36).slice(2, 10)),
      kind: (b.kind === 'scroll-transform' || !b.kind) ? 'transform' : b.kind,
      trigger:  cloneBehaviorTrigger(b),
      duration: cloneBehaviorDuration(b),
      params:   b.params ? Object.assign({}, b.params) : {}
    };
    return out;
  }
  function cloneBehaviorTrigger(b) {
    // If b.trigger already has the new shape ({ when }), clone it.
    if (b.trigger && typeof b.trigger === 'object' && b.trigger.when) {
      const out = { when: b.trigger.when, delay: Number(b.trigger.delay) || 0 };
      if (b.trigger.range)    out.range    = { start: Number(b.trigger.range.start) || 0, end: Number(b.trigger.range.end) || 1 };
      if (b.trigger.selector) out.selector = String(b.trigger.selector);
      if (b.trigger.viewportAt) out.viewportAt = String(b.trigger.viewportAt);
      if (b.trigger.repeat)     out.repeat     = String(b.trigger.repeat);
      // v0.8.79: cross-object Start / Stop side effects on fire.
      if (b.trigger.startObjectId)  out.startObjectId  = String(b.trigger.startObjectId);
      if (b.trigger.stopObjectId)   out.stopObjectId   = String(b.trigger.stopObjectId);
      if (b.trigger.stopFadeOut)    out.stopFadeOut    = true;
      if (b.trigger.stopReturnHome) out.stopReturnHome = true;
      if (b.trigger.stopDurationSec != null) {
        const d = Number(b.trigger.stopDurationSec);
        if (d >= 0) out.stopDurationSec = d;
      }
      if (b.trigger.stopEasing)     out.stopEasing     = String(b.trigger.stopEasing);
      // v0.8.84: easy-hit opt-in for click/hover triggers.
      if (b.trigger.treatAsFilled)  out.treatAsFilled  = true;
      // v0.8.243: per-trigger scroll direction filter (scroll-start only).
      // 'down' | 'up' | 'both' — absent = 'both' (no filter, current behavior).
      // We only carry the value when it's actually constraining, so legacy
      // data without the field stays clean.
      if (b.trigger.direction === 'down' || b.trigger.direction === 'up') {
        out.direction = b.trigger.direction;
      }
      return out;
    }
    // Legacy: old trigger.type 'time' → page-load + carry delay.
    if (b.trigger && typeof b.trigger === 'object' && b.trigger.type === 'time') {
      return { when: 'page-load', delay: Number(b.trigger.delay) || 0 };
    }
    // Default / legacy 'scroll': scroll-range, range from b.range.
    const r = (b.range && typeof b.range === 'object')
      ? { start: Number(b.range.start) || 0, end: Number(b.range.end) || 1 }
      : { start: 0, end: 1 };
    return { when: 'scroll-range', range: r, delay: 0 };
  }
  function cloneBehaviorDuration(b) {
    if (b.duration && typeof b.duration === 'object' && b.duration.mode) {
      const out = { mode: b.duration.mode };
      if (typeof b.duration.seconds === 'number') out.seconds = b.duration.seconds;
      if (b.duration.easing)                       out.easing  = String(b.duration.easing);
      // v0.8.23: loopTo carries a target block index + optional cap.
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
    // Legacy: trigger.type 'time' carried duration seconds.
    if (b.trigger && typeof b.trigger === 'object' && b.trigger.type === 'time') {
      const s = Number(b.trigger.duration);
      return { mode: 'time', seconds: Number.isFinite(s) && s > 0 ? s : 1 };
    }
    // Default / legacy 'scroll': scroll-driven duration.
    return { mode: 'scroll' };
  }
  function newBehaviorBlock() {
    return {
      id:       'b-' + Math.random().toString(36).slice(2, 10),
      kind:     'transform',
      trigger:  { when: 'scroll-range', range: { start: 0, end: 1 }, delay: 0 },
      duration: { mode: 'scroll' },
      params:   {}
    };
  }

  function isLocal(master, keyPath) {
    // `name` is structurally canonical — a master with a per-class
    // name isn't really one master. Hard-force false here so any
    // stale scope.name = 'local' (legacy data) or stray
    // instance.overrides.name (defensive) can't take effect at
    // resolve time.
    if (keyPath === 'name') return false;
    return getScope(master, keyPath) === 'local';
  }

  // PRIMITIVES — geometric kinds the editor knows about. Declared
  // up here (instead of next to the tool definitions further down)
  // because computeLineD reads it, and computeLineD is called from
  // resolveInstanceJS at init time. The path-builder helpers
  // referenced inside (circlePathD, polygonPathD, …) are function
  // declarations, so they're hoisted and safe to reference even
  // though their source is later in the file.
  const PRIMITIVES = {
    circle: {
      label: 'Circle',
      paramsFromDrag: function (s, e) {
        return { cx: s.x, cy: s.y, r: Math.max(1, Math.hypot(e.x - s.x, e.y - s.y)) };
      },
      generateD: function (p) { return circlePathD(p.cx, p.cy, p.r); },
      handles: function (p) {
        return [
          { id: 'c', x: p.cx,         y: p.cy },
          { id: 'r', x: p.cx + p.r,   y: p.cy }
        ];
      },
      updateFromHandle: function (p, id, pos) {
        if (id === 'c') return Object.assign({}, p, { cx: pos.x, cy: pos.y });
        return Object.assign({}, p, { r: Math.max(1, Math.hypot(pos.x - p.cx, pos.y - p.cy)) });
      },
      paramFields: [['cx', 'Center X'], ['cy', 'Center Y'], ['r', 'Radius']],
      positionKeys: ['cx', 'cy'],
      labelPosition: function (p) { return { x: p.cx + 6, y: p.cy + 6 }; }
    },

    ellipse: {
      label: 'Ellipse',
      paramsFromDrag: function (s, e) {
        return {
          cx: s.x, cy: s.y,
          rx: Math.max(1, Math.abs(e.x - s.x)),
          ry: Math.max(1, Math.abs(e.y - s.y))
        };
      },
      generateD: function (p) { return ellipsePathD(p.cx, p.cy, p.rx, p.ry); },
      handles: function (p) {
        return [
          { id: 'c',  x: p.cx,         y: p.cy },
          { id: 'rx', x: p.cx + p.rx,  y: p.cy },
          { id: 'ry', x: p.cx,         y: p.cy + p.ry }
        ];
      },
      updateFromHandle: function (p, id, pos) {
        if (id === 'c')  return Object.assign({}, p, { cx: pos.x, cy: pos.y });
        if (id === 'rx') return Object.assign({}, p, { rx: Math.max(1, Math.abs(pos.x - p.cx)) });
        return Object.assign({}, p, { ry: Math.max(1, Math.abs(pos.y - p.cy)) });
      },
      paramFields: [['cx', 'Center X'], ['cy', 'Center Y'], ['rx', 'Radius X'], ['ry', 'Radius Y']],
      positionKeys: ['cx', 'cy'],
      labelPosition: function (p) { return { x: p.cx + 6, y: p.cy + 6 }; }
    },

    rect: {
      label: 'Rectangle',
      paramsFromDrag: function (s, e) {
        return {
          x: Math.min(s.x, e.x),
          y: Math.min(s.y, e.y),
          w: Math.max(1, Math.abs(e.x - s.x)),
          h: Math.max(1, Math.abs(e.y - s.y)),
          r: 0
        };
      },
      generateD: function (p) { return rectPathD(p.x, p.y, p.w, p.h, p.r); },
      handles: function (p) {
        return [
          { id: 'tl', x: p.x,       y: p.y },
          { id: 'tr', x: p.x + p.w, y: p.y },
          { id: 'br', x: p.x + p.w, y: p.y + p.h },
          { id: 'bl', x: p.x,       y: p.y + p.h }
        ];
      },
      updateFromHandle: function (p, id, pos) {
        // Compute new bounding box from the moved corner. The opposite
        // corner stays fixed so the rect resizes naturally.
        let x1 = p.x, y1 = p.y, x2 = p.x + p.w, y2 = p.y + p.h;
        if      (id === 'tl') { x1 = pos.x; y1 = pos.y; }
        else if (id === 'tr') { x2 = pos.x; y1 = pos.y; }
        else if (id === 'br') { x2 = pos.x; y2 = pos.y; }
        else if (id === 'bl') { x1 = pos.x; y2 = pos.y; }
        const nx = Math.min(x1, x2), ny = Math.min(y1, y2);
        return Object.assign({}, p, {
          x: nx, y: ny,
          w: Math.max(1, Math.abs(x2 - x1)),
          h: Math.max(1, Math.abs(y2 - y1))
        });
      },
      paramFields: [
        ['x', 'X'], ['y', 'Y'],
        ['w', 'Width'], ['h', 'Height'],
        ['r', 'Corner radius']
      ],
      positionKeys: ['x', 'y'],
      labelPosition: function (p) { return { x: p.x + p.w / 2 + 6, y: p.y + p.h / 2 + 6 }; }
    },

    polygon: {
      label: 'Polygon',
      paramsFromDrag: function (s, e) {
        return {
          cx: s.x, cy: s.y,
          r: Math.max(1, Math.hypot(e.x - s.x, e.y - s.y)),
          sides: 5,
          angle: 0
        };
      },
      generateD: function (p) { return polygonPathD(p.cx, p.cy, p.r, p.sides, p.angle); },
      handles: function (p) {
        // One handle for center, one at the first vertex (drives radius
        // and rotation simultaneously).
        const t = (p.angle - 90) * Math.PI / 180;
        return [
          { id: 'c', x: p.cx, y: p.cy },
          { id: 'v', x: p.cx + p.r * Math.cos(t), y: p.cy + p.r * Math.sin(t) }
        ];
      },
      updateFromHandle: function (p, id, pos) {
        if (id === 'c') return Object.assign({}, p, { cx: pos.x, cy: pos.y });
        const dx = pos.x - p.cx, dy = pos.y - p.cy;
        const r = Math.max(1, Math.hypot(dx, dy));
        const angle = Math.atan2(dy, dx) * 180 / Math.PI + 90;
        return Object.assign({}, p, { r: r, angle: angle });
      },
      paramFields: [
        ['cx', 'Center X'], ['cy', 'Center Y'],
        ['r', 'Radius'], ['sides', 'Sides'], ['angle', 'Angle']
      ],
      positionKeys: ['cx', 'cy'],
      labelPosition: function (p) { return { x: p.cx + 6, y: p.cy + 6 }; }
    },

    star: {
      label: 'Star',
      paramsFromDrag: function (s, e) {
        const r = Math.max(1, Math.hypot(e.x - s.x, e.y - s.y));
        return { cx: s.x, cy: s.y, rOuter: r, rInner: r * 0.4, points: 5, angle: 0 };
      },
      generateD: function (p) {
        return starPathD(p.cx, p.cy, p.rOuter, p.rInner, p.points, p.angle);
      },
      handles: function (p) {
        const tO = (p.angle - 90) * Math.PI / 180;
        const tI = (p.angle - 90 + 180 / p.points) * Math.PI / 180;
        return [
          { id: 'c', x: p.cx, y: p.cy },
          { id: 'o', x: p.cx + p.rOuter * Math.cos(tO), y: p.cy + p.rOuter * Math.sin(tO) },
          { id: 'i', x: p.cx + p.rInner * Math.cos(tI), y: p.cy + p.rInner * Math.sin(tI) }
        ];
      },
      updateFromHandle: function (p, id, pos) {
        if (id === 'c') return Object.assign({}, p, { cx: pos.x, cy: pos.y });
        const dx = pos.x - p.cx, dy = pos.y - p.cy;
        const r = Math.max(1, Math.hypot(dx, dy));
        if (id === 'o') {
          // Outer vertex drives outer radius + overall rotation.
          const angle = Math.atan2(dy, dx) * 180 / Math.PI + 90;
          return Object.assign({}, p, { rOuter: r, angle: angle });
        }
        // Inner vertex: only its radius changes.
        return Object.assign({}, p, { rInner: r });
      },
      paramFields: [
        ['cx', 'Center X'], ['cy', 'Center Y'],
        ['rOuter', 'Outer radius'], ['rInner', 'Inner radius'],
        ['points', 'Points'], ['angle', 'Angle']
      ],
      positionKeys: ['cx', 'cy'],
      labelPosition: function (p) { return { x: p.cx + 6, y: p.cy + 6 }; }
    },

    image: {
      label: 'Image',
      // Drag-create like rect; the bbox is the image's display area.
      // The bitmap (or vector) source lands later via the panel's
      // "Image URL" field. paramFields' third element flags the field
      // type so the panel emits a text input for src and a select for
      // fit instead of the default numberField.
      paramsFromDrag: function (s, e) {
        return {
          x: Math.min(s.x, e.x),
          y: Math.min(s.y, e.y),
          w: Math.max(1, Math.abs(e.x - s.x)),
          h: Math.max(1, Math.abs(e.y - s.y)),
          src: '',
          fit: 'meet'
        };
      },
      // The "d" we emit is the bbox rect — used as the editor's hit
      // target and as the fallback outline when no src is set yet.
      // The visible bitmap is a separate SVG <image> element layered
      // on top by renderLines / runtime; see the image-kind branch
      // there.
      generateD: function (p) { return rectPathD(p.x, p.y, p.w, p.h, 0); },
      handles: function (p) {
        return [
          { id: 'tl', x: p.x,       y: p.y },
          { id: 'tr', x: p.x + p.w, y: p.y },
          { id: 'br', x: p.x + p.w, y: p.y + p.h },
          { id: 'bl', x: p.x,       y: p.y + p.h }
        ];
      },
      updateFromHandle: function (p, id, pos) {
        let x1 = p.x, y1 = p.y, x2 = p.x + p.w, y2 = p.y + p.h;
        if      (id === 'tl') { x1 = pos.x; y1 = pos.y; }
        else if (id === 'tr') { x2 = pos.x; y1 = pos.y; }
        else if (id === 'br') { x2 = pos.x; y2 = pos.y; }
        else if (id === 'bl') { x1 = pos.x; y2 = pos.y; }
        const nx = Math.min(x1, x2), ny = Math.min(y1, y2);
        return Object.assign({}, p, {
          x: nx, y: ny,
          w: Math.max(1, Math.abs(x2 - x1)),
          h: Math.max(1, Math.abs(y2 - y1))
        });
      },
      paramFields: [
        ['x', 'X'], ['y', 'Y'],
        ['w', 'Width'], ['h', 'Height'],
        ['src', 'Image URL', 'image-source'],
        ['fit', 'Fit', 'select', [
          { value: 'meet',  label: 'Fit (letterbox)' },
          { value: 'slice', label: 'Cover (crop)' },
          { value: 'fill',  label: 'Stretch' }
        ]]
      ],
      positionKeys: ['x', 'y'],
      labelPosition: function (p) { return { x: p.x + p.w / 2 + 6, y: p.y + p.h / 2 + 6 }; }
    },

    // v0.8.228 (textBlock Slice 1a): rect-like primitive that
    // represents a future HTML text container (phase 2 web page
    // generator). Slice 1a renders only the rect outline + fill;
    // text/font/htmlKey fields land in 1b/1c. Geometry handling
    // mirrors `rect` / `image` since they share the same (x, y,
    // w, h) shape.
    textBlock: {
      label: 'Text block',
      paramsFromDrag: function (s, e) {
        return {
          x: Math.min(s.x, e.x),
          y: Math.min(s.y, e.y),
          w: Math.max(1, Math.abs(e.x - s.x)),
          h: Math.max(1, Math.abs(e.y - s.y))
        };
      },
      // Slice 1a: the d-path is just the rect outline. Used for
      // the hit-target and as the visible rect (with line.fill
      // + line.stroke applied at render time, NOT through the
      // standard `filled → fill = stroke` shortcut).
      generateD: function (p) { return rectPathD(p.x, p.y, p.w, p.h, 0); },
      handles: function (p) {
        return [
          { id: 'tl', x: p.x,       y: p.y },
          { id: 'tr', x: p.x + p.w, y: p.y },
          { id: 'br', x: p.x + p.w, y: p.y + p.h },
          { id: 'bl', x: p.x,       y: p.y + p.h }
        ];
      },
      updateFromHandle: function (p, id, pos) {
        let x1 = p.x, y1 = p.y, x2 = p.x + p.w, y2 = p.y + p.h;
        if      (id === 'tl') { x1 = pos.x; y1 = pos.y; }
        else if (id === 'tr') { x2 = pos.x; y1 = pos.y; }
        else if (id === 'br') { x2 = pos.x; y2 = pos.y; }
        else if (id === 'bl') { x1 = pos.x; y2 = pos.y; }
        const nx = Math.min(x1, x2), ny = Math.min(y1, y2);
        return Object.assign({}, p, {
          x: nx, y: ny,
          w: Math.max(1, Math.abs(x2 - x1)),
          h: Math.max(1, Math.abs(y2 - y1))
        });
      },
      paramFields: [
        ['x', 'X'], ['y', 'Y'],
        ['w', 'Width'], ['h', 'Height']
      ],
      positionKeys: ['x', 'y'],
      labelPosition: function (p) { return { x: p.x + p.w / 2 + 6, y: p.y + p.h / 2 + 6 }; }
    }
  };

  // v0.8.195: text overlay helpers. The text record is a small
  // optional object on the master (and propagated to every resolved
  // line by Object.assign in resolveInstanceJS). Slice 1 is master-
  // only — no per-instance override surface — so reads can go
  // straight to line.text without merging an overrides layer.
  const TEXT_DEFAULTS = {
    value:      '',
    offsetX:    0,
    offsetY:    0,
    fontFamily: 'Inter',
    fontSize:   14,
    color:      null   // null = inherit object stroke color
  };
  /**
   * Return the resolved text record for a line, or null if no text
   * should be drawn. Falls back to TEXT_DEFAULTS field-by-field so
   * partial author data still renders sanely.
   */
  function resolveText(line) {
    const t = line && line.text;
    if (!t || typeof t !== 'object') return null;
    const value = (typeof t.value === 'string') ? t.value : '';
    if (!value) return null;
    return {
      value:      value,
      offsetX:    Number.isFinite(t.offsetX)  ? t.offsetX  : 0,
      offsetY:    Number.isFinite(t.offsetY)  ? t.offsetY  : 0,
      fontFamily: (typeof t.fontFamily === 'string' && t.fontFamily) ? t.fontFamily : TEXT_DEFAULTS.fontFamily,
      fontSize:   Number.isFinite(t.fontSize) ? t.fontSize : TEXT_DEFAULTS.fontSize,
      color:      (typeof t.color === 'string' && t.color) ? t.color : null
    };
  }
  /**
   * Geometric center of a line in editor / viewBox coordinates.
   * Mirrors the runtime's center-derivation logic in renderClassContent:
   * primitive params first, then bbox via the live SVG element when
   * available, else (0,0). Used to anchor the text overlay so the
   * user's authored (offsetX, offsetY) is relative to the object's
   * natural center.
   */
  function lineCenterFor(line, svgEl) {
    if (line && line.params) {
      const pa = line.params;
      if (Number.isFinite(pa.cx) && Number.isFinite(pa.cy)) {
        return { x: pa.cx, y: pa.cy };
      }
      if (Number.isFinite(pa.x) && Number.isFinite(pa.y)
          && Number.isFinite(pa.w) && Number.isFinite(pa.h)) {
        return { x: pa.x + pa.w / 2, y: pa.y + pa.h / 2 };
      }
    }
    if (svgEl) {
      try {
        const b = svgEl.getBBox();
        if (b && b.width > 0) return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
      } catch (e) { /* getBBox can throw on disconnected nodes */ }
    }
    return { x: 0, y: 0 };
  }

  /**
   * v0.8.216: live-drag helper. The text overlay is rendered as a
   * sibling <text data-text-for="<lineId>"> in linesG (see
   * renderLines). During drag-translate / vertex-drag the code mutates
   * the line's <path d=...> attribute in place to keep things smooth,
   * but the <text> element was left at its old position — so the text
   * stayed put while the object moved. (A full renderLines on pointer-
   * up reconciled it, hence "save & reload restores the right place".)
   *
   * Call this after any in-place geometry mutation that doesn't trigger
   * a full re-render. Reads the line's resolved text and re-anchors
   * the <text> at (lineCenter + offset). No-op if the line has no
   * text overlay.
   */
  function syncTextOverlayPosition(line) {
    const tEl = linesG.querySelector('[data-text-for="' + line.id + '"]');
    if (!tEl) return;
    const tx = resolveText(line);
    if (!tx) return;
    const pathEl = linesG.querySelector('[data-line-id="' + line.id + '"]');
    const c = lineCenterFor(line, pathEl);
    const ax = c.x + tx.offsetX;
    tEl.setAttribute('x', String(ax));
    tEl.setAttribute('y', String(c.y + tx.offsetY));
    // Re-anchor every tspan to the new x (multi-line text — v0.8.232).
    // Single-line texts have either no tspans (legacy textContent path)
    // or one tspan; loop handles both.
    Array.prototype.forEach.call(tEl.querySelectorAll('tspan'), function (ts) {
      ts.setAttribute('x', String(ax));
    });
  }

  /**
   * v0.8.232: write a (possibly multi-line) string into an SVG <text>
   * element as a stack of <tspan>s, one per source line.
   *
   *   • newlines (\n) split lines; multiple spaces survive because the
   *     parent <text> sets xml:space="preserve".
   *   • Each tspan sets x = anchorX so the multi-line block stays
   *     horizontally centered with text-anchor=middle.
   *   • dy lifts the first line by -((n-1)/2) em so the *block* is
   *     vertically centered around the anchor (matches the single-line
   *     dominant-baseline=central feel for n=1). Subsequent lines drop
   *     by 1em.
   *   • Empty lines: tspans with no text still advance the baseline
   *     thanks to dy — visible blank line between paragraphs.
   *
   * Both the editor (dev-draw.js) and runtime (app.js) call into this
   * shape; the runtime has its own copy so the two evolve together if
   * they need to.
   */
  /**
   * v0.8.241 (textBlock Slice 1b-3): greedy word-wrap helper.
   *
   *   value     — source string (\n splits paragraphs)
   *   maxWidth  — wrap width in user / viewBox units; ≤ 0 disables
   *               wrap (caller gets one visual line per \n-segment)
   *   fontSize  — px size for measureText
   *   fontFamily— family name passed straight to ctx.font
   *
   * Returns an array of visual line strings. Within each paragraph,
   * tokens are split on whitespace runs (the runs are kept as tokens
   * so multi-space groups can survive when they fit on a line); we
   * greedily append tokens until the next would overflow, then start
   * a new line, dropping any pure-whitespace token that would
   * otherwise indent the wrapped line.
   *
   * Caveat: if the chosen font hasn't finished loading, measureText
   * uses fallback metrics and lines may break in the wrong place.
   * The editor re-renders on every edit so it self-corrects almost
   * immediately; the runtime triggers a re-wrap pass once
   * document.fonts.ready resolves (see app.js).
   */
  let _wrapCanvas = null;
  function wrapTextToWidth(value, maxWidth, fontSize, fontFamily) {
    const paragraphs = String(value == null ? '' : value).split('\n');
    if (!(maxWidth > 0)) return paragraphs;
    if (!_wrapCanvas) _wrapCanvas = document.createElement('canvas');
    const ctx = _wrapCanvas.getContext('2d');
    ctx.font = fontSize + 'px ' + fontFamily;
    const out = [];
    for (let p = 0; p < paragraphs.length; p++) {
      const para = paragraphs[p];
      if (para === '') { out.push(''); continue; }
      const tokens = para.split(/(\s+)/);
      let current = '';
      for (let i = 0; i < tokens.length; i++) {
        const tok = tokens[i];
        if (!tok) continue;
        const tentative = current + tok;
        if (current === '' || ctx.measureText(tentative).width <= maxWidth) {
          current = tentative;
        } else {
          out.push(current);
          // Drop leading whitespace at the start of a wrapped line so
          // text doesn't appear indented after a soft break.
          current = /^\s+$/.test(tok) ? '' : tok;
        }
      }
      out.push(current);
    }
    return out;
  }

  function setMultilineText(tEl, lines, anchorX) {
    while (tEl.firstChild) tEl.removeChild(tEl.firstChild);
    // v0.8.234: no centering — text flows from (offsetX, offsetY) like
    // an HTML textbox. Each line is left-aligned at anchorX; the first
    // line's baseline sits below the anchor point (so the offset
    // marks the top of the text), subsequent lines drop by 1em.
    // v0.8.241: now accepts a pre-split lines[] array — the caller
    // decides whether lines come from naive \n-split or from
    // wrapTextToWidth (textBlock kind).
    tEl.setAttributeNS('http://www.w3.org/XML/1998/namespace', 'space', 'preserve');
    if (!Array.isArray(lines)) lines = [String(lines == null ? '' : lines)];
    const n = lines.length;
    for (let i = 0; i < n; i++) {
      const ts = document.createElementNS(SVG_NS, 'tspan');
      ts.setAttribute('x', String(anchorX));
      ts.setAttribute('text-anchor', 'start');
      ts.setAttributeNS('http://www.w3.org/XML/1998/namespace', 'space', 'preserve');
      // v0.8.235: with dominant-baseline=text-before-edge on the
      // parent <text>, the y attribute already marks the top of the
      // first line. No dy on tspan 0; subsequent tspans drop 1em
      // for one-line-height spacing.
      if (i > 0) ts.setAttribute('dy', '1em');
      ts.textContent = lines[i];
      tEl.appendChild(ts);
    }
  }

  /**
   * Collect every distinct fontFamily referenced by any master.text
   * AND every family in the curated bundle (state.fontBundle), and
   * inject a single Google Fonts <link> for the union. Bundled fonts
   * are included so they're available for preview in the font picker
   * before they're applied to any object. Idempotent — only refreshes
   * when the family set changes.
   */
  let _fontsLinkEl = null;
  let _fontsLastKey = '';
  function injectGoogleFontsLink() {
    if (!Array.isArray(state.masters)) return;
    const set = {};
    state.masters.forEach(function (m) {
      if (!m || !m.text || typeof m.text.fontFamily !== 'string') return;
      const fam = m.text.fontFamily.trim();
      if (fam) set[fam] = true;
    });
    // v0.8.206: include curated bundle so picker previews render in
    // their actual face even before the font is applied to anything.
    if (Array.isArray(state.fontBundle)) {
      state.fontBundle.forEach(function (f) {
        const fam = (f || '').trim();
        if (fam) set[fam] = true;
      });
    }
    // v0.8.215: local fonts are served by @font-face from /assets/fonts/local/
    // and must NOT be requested from Google (they'd 404). Subtract any local
    // family from the set before building the Google Fonts URL.
    if (Array.isArray(state.localFonts)) {
      state.localFonts.forEach(function (f) {
        const fam = (f && f.family || '').trim();
        if (fam) delete set[fam];
      });
    }
    const families = Object.keys(set).sort();
    if (!families.length) {
      if (_fontsLinkEl && _fontsLinkEl.parentNode) _fontsLinkEl.parentNode.removeChild(_fontsLinkEl);
      _fontsLinkEl = null;
      _fontsLastKey = '';
      return;
    }
    const key = families.join('|');
    if (key === _fontsLastKey) return;
    _fontsLastKey = key;
    if (!_fontsLinkEl) {
      _fontsLinkEl = document.createElement('link');
      _fontsLinkEl.rel = 'stylesheet';
      document.head.appendChild(_fontsLinkEl);
    }
    const qs = families.map(function (f) {
      return 'family=' + encodeURIComponent(f).replace(/%20/g, '+');
    }).join('&');
    _fontsLinkEl.href = 'https://fonts.googleapis.com/css2?' + qs + '&display=swap';
  }

  /*
   * Font-bundle cache (v0.8.206). Loaded once at editor start (called
   * after `state` is declared, near renderAll) and refreshed by the
   * Settings → Font bundle Save flow. Drives:
   *   • injectGoogleFontsLink (above) — ensures all bundled families
   *     are loaded for preview.
   *   • The TEXT section's font-family field (fontFamilyField below)
   *     surfaces the bundle as <datalist> suggestions.
   *
   * state.fontBundle is left undefined here on purpose — `state` is
   * const-declared further down (the editor is one big closure), so
   * touching it at this point would hit the temporal dead zone. All
   * readers guard with Array.isArray so undefined is harmless until
   * loadFontBundle() populates it.
   */
  let _fontBundleDatalist = null;
  function rebuildFontBundleDatalist() {
    if (!_fontBundleDatalist) {
      _fontBundleDatalist = document.createElement('datalist');
      _fontBundleDatalist.id = 'ed-font-bundle-list';
      document.body.appendChild(_fontBundleDatalist);
    }
    _fontBundleDatalist.innerHTML = '';
    // v0.8.215: union Google bundle + local families. The datalist is
    // mostly dead code now that the picker uses a custom popup, but
    // keep it in sync so any input still using `list="ed-font-bundle-list"`
    // (legacy or third-party) sees the right values.
    const bundle = Array.isArray(state.fontBundle) ? state.fontBundle : [];
    const local  = Array.isArray(state.localFonts)
      ? state.localFonts.map(function (f) { return f.family; }).filter(Boolean)
      : [];
    const seen = {};
    bundle.concat(local).forEach(function (name) {
      const k = (name || '').toLowerCase();
      if (!k || seen[k]) return;
      seen[k] = true;
      const opt = document.createElement('option');
      opt.value = name;
      _fontBundleDatalist.appendChild(opt);
    });
  }
  function loadFontBundle() {
    return fetch('/dev/draw/font-bundle', { method: 'GET' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (j && j.ok && Array.isArray(j.fonts)) {
          state.fontBundle = j.fonts.slice();
        } else {
          state.fontBundle = [];
        }
        rebuildFontBundleDatalist();
        injectGoogleFontsLink();
      })
      .catch(function () {
        // Editor stays usable without the bundle — free-text font
        // field still works, just without suggestions.
        state.fontBundle = [];
        rebuildFontBundleDatalist();
      });
  }

  /*
   * Local fonts (Slice 3-2, v0.8.215). Companion to the Google Fonts
   * bundle: assets/fonts/local/ holds OTF/TTF/WOFF files served at
   * /assets/fonts/local/<file>. The /dev/draw/local-fonts endpoint
   * returns the family name read from each file's name table.
   *
   * On editor startup we:
   *   1. Fetch the list into state.localFonts.
   *   2. Emit a <style id="ed-local-fontfaces"> block with one
   *      @font-face per entry so the family is usable by name.
   *   3. Rebuild the font-bundle datalist (which now unions Google
   *      + local families) and re-inject the Google link.
   *
   * The picker (fontFamilyField, Settings textarea, anywhere that
   * surfaces fonts) treats local families exactly like Google ones —
   * once @font-face resolves the family name, the browser doesn't
   * care where the bytes came from.
   */
  let _localFontFaceStyleEl = null;
  function injectLocalFontFaces() {
    if (!_localFontFaceStyleEl) {
      _localFontFaceStyleEl = document.createElement('style');
      _localFontFaceStyleEl.id = 'ed-local-fontfaces';
      document.head.appendChild(_localFontFaceStyleEl);
    }
    const list = Array.isArray(state.localFonts) ? state.localFonts : [];
    const css = list.map(function (f) {
      // Map file extension to the CSS @font-face format() hint.
      const fmtMap = { otf: 'opentype', ttf: 'truetype', woff: 'woff', woff2: 'woff2' };
      const fmt = fmtMap[f.format] || '';
      const url = '/assets/fonts/local/' + encodeURIComponent(f.file);
      const fam = (f.family || '').replace(/"/g, '');
      return '@font-face { font-family: "' + fam + '"; '
           + 'src: url("' + url + '")'
           + (fmt ? ' format("' + fmt + '")' : '') + '; '
           + 'font-display: swap; }';
    }).join('\n');
    _localFontFaceStyleEl.textContent = css;
  }
  function loadLocalFonts() {
    return fetch('/dev/draw/local-fonts', { method: 'GET' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        state.localFonts = (j && j.ok && Array.isArray(j.fonts)) ? j.fonts.slice() : [];
        injectLocalFontFaces();
        rebuildFontBundleDatalist();
      })
      .catch(function () {
        state.localFonts = [];
        injectLocalFontFaces();
        rebuildFontBundleDatalist();
      });
  }

  /**
   * Compose a flat line record from an instance + the master library
   * under the scope-driven model (v7+):
   *
   *   - Start with master values for all visual props.
   *   - For each scope-local prop on the master, apply the instance's
   *     override if present (otherwise keep master's value).
   *   - Behavior keys (translateX/Y, rotate, drawIn, …) come from the
   *     instance override regardless of scope — they're always per-
   *     class by definition.
   *   - positionOffset is applied to the visual position (params
   *     cx/cy/x/y, points, segments) so the editor's tools, handles,
   *     labels, and panel all see the same on-screen coordinates.
   *
   * d is recomputed locally from the offset-applied source values.
   */
  function resolveInstanceJS(inst, mby) {
    if (!inst) return {};
    const master = inst.masterId ? mby[inst.masterId] : null;
    // v0.8.46: warn when a master lookup fails. Previously this path
    // silently produced an empty `line = {}` (no kind, no params, no
    // path data) — a render-time no-op AND a save-time time bomb,
    // because decomposeForSave would later mint a skeleton master
    // from the empty line, baking the corruption into disk. The
    // warn surfaces the issue at the moment it happens; the
    // missing-master count gets summed in state._loadIssues for a
    // post-load banner so the editor flags broken data on startup.
    if (inst.masterId && !master) {
      console.warn('[load] line "' + inst.id + '" references missing master '
        + inst.masterId + ' — rendering will fail until the master is restored or the line is removed.');
      loadIssues.missingMasters.push({ lineId: inst.id, masterId: inst.masterId });
    }
    const line = master ? Object.assign({}, master) : {};
    delete line.id;     // master.id != instance.id
    delete line.scope;  // master-level metadata, not a line prop

    // Deep-copy mutable nested values so per-class mutations don't
    // leak back into the master record via shared references.
    if (line.params && typeof line.params === 'object') {
      line.params = Object.assign({}, line.params);
    }
    if (Array.isArray(line.points)) {
      line.points = line.points.map(function (p) { return { x: p.x, y: p.y }; });
    }
    if (Array.isArray(line.segments)) {
      line.segments = line.segments.map(function (s) {
        return {
          cmd: s.cmd,
          controlPoints: (s.controlPoints || []).map(function (cp) {
            return { x: cp.x, y: cp.y };
          }),
          endpoint: s.endpoint ? { x: s.endpoint.x, y: s.endpoint.y } : null
        };
      });
    }

    // Apply overrides:
    //   - Behavior keys: kept on line.overrides for the runtime's
    //     behavior pipeline; not merged onto the line itself.
    //   - Visual keys: applied to line[k] iff scope says local.
    //   - params: handled at sub-key level (each sub-key consulted
    //     against scope).
    const ov = (inst.overrides && typeof inst.overrides === 'object') ? inst.overrides : {};
    const cleanOverrides = {}; // what we'll keep on line.overrides
    Object.keys(ov).forEach(function (k) {
      // Behavior keys (translateX/Y, rotate, drawIn, …) used to
      // live in overrides; v0.4.0 moved them into line.behaviors[].
      // Strip any leftover entries silently — disk migration handles
      // canonical data; this is just defensive against in-memory
      // crud.
      if (BEHAVIOR_KEYS.indexOf(k) !== -1) return;
      if (k === 'params' && ov[k] && typeof ov[k] === 'object'
          && master && master.params && typeof master.params === 'object') {
        const opParams = {};
        Object.keys(ov[k]).forEach(function (sk) {
          if (isLocal(master, 'params.' + sk)) {
            line.params[sk] = ov[k][sk];
            opParams[sk] = ov[k][sk];
          }
        });
        if (Object.keys(opParams).length) cleanOverrides.params = opParams;
        return;
      }
      if (master && isLocal(master, k)) {
        line[k] = ov[k];
        cleanOverrides[k] = ov[k];
      }
      // Else: the override targets a canonical key; drop it.
    });

    line.id        = inst.id;
    line.groupId   = inst.groupId;
    line.masterId  = inst.masterId || null;
    line.hidden    = !(inst.visible === undefined ? true : inst.visible);
    line.overrides = cleanOverrides;
    // Behaviors are per-instance, not in the scope contract (always
    // per-class by definition). Pass through with a deep clone so
    // mutations don't leak between resolveInstanceJS callers.
    line.behaviors = Array.isArray(inst.behaviors)
      ? inst.behaviors.map(cloneBehavior)
      : [];

    // positionOffset — structural per-class translation.
    const offX = (inst.positionOffset && Number.isFinite(inst.positionOffset.dx))
                 ? inst.positionOffset.dx : 0;
    const offY = (inst.positionOffset && Number.isFinite(inst.positionOffset.dy))
                 ? inst.positionOffset.dy : 0;
    line.positionOffset = { dx: offX, dy: offY };
    if (offX !== 0 || offY !== 0) {
      if (line.params && typeof line.params === 'object') {
        ['cx', 'x'].forEach(function (k) {
          if (Number.isFinite(line.params[k])) line.params[k] += offX;
        });
        ['cy', 'y'].forEach(function (k) {
          if (Number.isFinite(line.params[k])) line.params[k] += offY;
        });
      }
      if (Array.isArray(line.points)) {
        line.points = line.points.map(function (p) {
          return { x: (p.x || 0) + offX, y: (p.y || 0) + offY };
        });
      }
      if (Array.isArray(line.segments)) {
        line.segments = line.segments.map(function (s) {
          return {
            cmd: s.cmd,
            controlPoints: (s.controlPoints || []).map(function (cp) {
              return { x: (cp.x || 0) + offX, y: (cp.y || 0) + offY };
            }),
            endpoint: s.endpoint
              ? { x: (s.endpoint.x || 0) + offX, y: (s.endpoint.y || 0) + offY }
              : null
          };
        });
      }
    }
    // Always recompute d locally — visual overrides may have changed
    // params/points/segments since master.d was last derived, and a
    // zero positionOffset wouldn't otherwise trigger a refresh.
    computeLineD(line);
    // v0.8.231 / schema v12: scrollMode per-instance ('flow' | 'static').
    // Pass through so the editor can display and persist it correctly.
    // Absent field = 'flow' (the runtime and editor both read undefined as flow).
    if (inst.scrollMode) line.scrollMode = inst.scrollMode;
    return line;
  }

  // ── State ─────────────────────────────────────────────────────────
  const initial = JSON.parse(document.getElementById('editor-data').textContent);

  // localStorage-remembered last class for this browser (any page).
  // Applied on init if it's a class the loaded page actually uses;
  // otherwise the server's initial pick wins.
  const rememberedClass = (function () {
    try { return localStorage.getItem('ed-last-class'); } catch (e) { return null; }
  })();
  const useClasses = (initial.page && Array.isArray(initial.page.useClasses))
    ? initial.page.useClasses
    : ['wide'];
  const startClassId = (rememberedClass && useClasses.indexOf(rememberedClass) !== -1)
    ? rememberedClass
    : (initial.classId || useClasses[0] || 'wide');

  // Site-wide masters (v4+): { id, kind, params, ... } — visual
  // identity. Carried through state so the save step can decompose
  // current per-class line records back into (master + instance)
  // pairs. Internally the editor still operates on flat "line"
  // records (resolved master ⊕ instance overrides) so existing
  // tool / mutation code is unchanged from Phase 3.
  const initialMasters = Array.isArray(initial.masters) ? initial.masters : [];

  // byClass: { <classId>: { lines, groups, instances } }
  //   - lines      → editor's working model; resolveInstance(inst, mby)
  //                  per entry on load. Mutations write here directly,
  //                  the same as Phase 3.
  //   - instances  → original per-class records as loaded from the
  //                  server. Used only as the seed for `lines`; on save
  //                  we rebuild fresh from `lines` + masters.
  //   - groups     → per-class behavior groups (unchanged).
  const initialByClass = (initial.byClass && typeof initial.byClass === 'object')
    ? initial.byClass : {};
  useClasses.forEach(function (cid) {
    if (!initialByClass[cid]) initialByClass[cid] = {};
    if (!Array.isArray(initialByClass[cid].instances)) initialByClass[cid].instances = [];
    if (!Array.isArray(initialByClass[cid].groups))    initialByClass[cid].groups    = [];
  });

  // Resolve each class's instances against the master library into
  // flat line records. masters lookup is built once per load.
  const mastersById = {};
  initialMasters.forEach(function (m) { if (m && m.id) mastersById[m.id] = m; });
  useClasses.forEach(function (cid) {
    initialByClass[cid].lines = initialByClass[cid].instances.map(function (inst) {
      return resolveInstanceJS(inst, mastersById);
    });
    // The raw instances were only seed data; the editor mutates
    // byClass[cid].lines directly from here on. Drop them so there's
    // a single source of truth in memory.
    delete initialByClass[cid].instances;
  });

  const state = {
    pageId:  initial.pageId,
    pages:   Array.isArray(initial.pages)   ? initial.pages   : [],
    classId: startClassId,
    classes: Array.isArray(initial.classes) ? initial.classes : [],
    byClass: initialByClass,
    masters: initialMasters,
    palette: initial.palette && initial.palette.length ? initial.palette : defaultPalette(),
    // Nested per-page config (v3): { useClasses, dims }.
    pageConfig: initial.page && initial.page.dims
      ? initial.page
      : { useClasses: ['wide'], dims: { wide: { pageW: 1200, pageH: 800, canvasW: 2400, canvasH: 1600 } } },
    openGroupIds:   {},        // groupId → true when expanded in sidebar
    activeGroupId:  null,
    // Multi-select: ordered array of object ids (formerly `selectedLineId`).
    // Order = click order; the last entry is the "primary" selection used
    // by the params panel. Empty = no selection. The "Select all" button
    // just fills this with every object id (no separate allSelected flag).
    selectedIds:    [],
    activeToolId:   'select',  // neutral on first load — no accidental strokes
    // Edit scope: 'all' = mutations cross every class (the default);
    // 'one' = only the current class is affected. Session-local
    // (not persisted) so a reload starts fresh in 'all' — safer
    // than discovering yesterday's restricted mode mid-edit.
    // v0.7.0 introduces the toggle + visual; action wiring lands
    // in v0.7.1+.
    mode: 'all',
    smoothing: true,
    chainPoints: null,         // active polyline points when lineChain is mid-chain
    bezierPoints: null,        // active bezier anchors when bezier is mid-draw
    zoom: 1,                   // canvas zoom factor (1 = 100%, 2 = 200%, …)
    // Editor-local view toggle, persisted to localStorage so it survives
    // reloads. When on, every named line gets a colored label rendered
    // next to it so the user can spot which is which in a busy canvas.
    showLabels: localStorage.getItem('ed-show-labels') === '1',
    // v0.8.16: Page-area outline on the live site. The editor canvas
    // already shows the page rect by default; this toggle controls
    // whether the runtime draws the same dotted rect + corner coord
    // markers, useful for verifying where authored coords land
    // against the live viewport when objects live in the bleed area.
    showPageArea: localStorage.getItem('ed-show-page-area') === '1',
    // Diagnostic coord grid — cyan, 50px step, coords every 100px.
    // Persisted in localStorage so refresh keeps the same view, and
    // the runtime in app.js reads the same flag so the grid renders
    // on the live site too. Handy for comparing where authored coords
    // actually land in each surface.
    showDiagGrid: localStorage.getItem('ed-show-diag-grid') === '1',
    // Live-site only: dump a console.table of every named line's
    // expected/actual centers + transform at page load. Kept behind a
    // separate toggle so the table only appears when we're actively
    // diagnosing a position drift — Grid alone shouldn't pay the cost.
    showRuntimeDump: localStorage.getItem('ed-show-runtime-dump') === '1',
    // v0.8.99: keyboard-arrow nudge step (mm of canvas geometry).
    // Persisted so refresh keeps the value. Shift+arrow multiplies
    // by 10 (standard editor convention).
    nudgeStepMM: (function () {
      const raw = parseFloat(localStorage.getItem('ed-nudge-step-mm'));
      return Number.isFinite(raw) && raw > 0 ? raw : 1;
    })(),
    // v0.8.119: Step 2d — multi-select spawns one floating 'object'
    // panel per selected object (pinned). To prevent a 50-object
    // multi-select from blanketing the screen with panels, prompt
    // for confirmation when the selection size exceeds this limit.
    // Persisted in localStorage; default 5.
    multiSelectPanelLimit: (function () {
      const raw = parseInt(localStorage.getItem('ed-multi-panel-limit'), 10);
      return Number.isFinite(raw) && raw >= 1 ? raw : 5;
    })(),
    dirty: false
  };
  // Make sure every useClass has a dims slot + a byClass entry, so
  // getters never see undefined.
  useClasses.forEach(function (cid) {
    if (!state.pageConfig.dims[cid]) {
      state.pageConfig.dims[cid] = { pageW: 1200, pageH: 800, canvasW: 2400, canvasH: 1600 };
    }
  });

  // Live aliases tied to state.classId. Reads/writes go through
  // byClass[classId] and pageConfig.dims[classId] so all mutations
  // (push, splice, assign) reach the canonical store. Switching
  // class doesn't need any field-by-field copy step — the getter
  // simply resolves to the new slot.
  Object.defineProperty(state, 'lines', {
    enumerable: true,
    get: function () { return state.byClass[state.classId].lines;  },
    set: function (v) { state.byClass[state.classId].lines = v;    }
  });
  Object.defineProperty(state, 'groups', {
    enumerable: true,
    get: function () { return state.byClass[state.classId].groups; },
    set: function (v) { state.byClass[state.classId].groups = v;   }
  });
  Object.defineProperty(state, 'page', {
    enumerable: true,
    get: function () { return state.pageConfig.dims[state.classId];      },
    set: function (v) { state.pageConfig.dims[state.classId] = v;        }
  });

  // If the current class has no groups at all (empty class — e.g.,
  // fresh page with no content yet), seed it with a default group so
  // the line-creation tools have somewhere to put their output.
  if (!state.groups.length) state.groups = [defaultGroup()];

  // Editor opens in a neutral state — no group active, none expanded,
  // selection panel empty. Picking a group row or an object lights up
  // the right panel. commitLine + finalizeSvgImport fall back to the
  // first group when activeGroupId is null so a fresh draw still has
  // somewhere to land.
  state.activeGroupId = null;
  state.openGroupIds  = {};

  function defaultPalette() {
    return [
      { id: 'text',   name: 'Text',   value: 'var(--text)'   },
      { id: 'accent', name: 'Accent', value: 'var(--accent)' }
    ];
  }

  function defaultGroup() {
    return {
      id: uid('g'),
      name: 'Default',
      trigger: null,
      // v0.8.219: when set to a lineId of a member object, the group
      // adopts that object's behaviors + render params (everything
      // except geometry) at runtime. Picker only allows objects that
      // are themselves in the group. Cleared automatically when the
      // referenced object is deleted or moved out.
      behaviorTemplateObjectId: null,
      defaults: {}
    };
  }

  function uid(prefix) {
    return prefix + '-' + Math.random().toString(36).slice(2, 8);
  }

  // ── Multi-select helpers ──────────────────────────────────────────
  function isSelected(id) { return state.selectedIds.indexOf(id) >= 0; }
  function selectOnly(id) { state.selectedIds = id ? [id] : []; }
  function toggleInSelection(id) {
    const i = state.selectedIds.indexOf(id);
    if (i >= 0) state.selectedIds.splice(i, 1);
    else state.selectedIds.push(id);
  }
  function clearSelection() {
    if (typeof clearBboxOverlay === 'function') clearBboxOverlay();
    state.selectedIds = [];
  }

  // ── Scope-mode helpers ────────────────────────────────────────────
  // state.mode === 'all' → mutating actions fan out across every
  // class that has the same master. state.mode === 'one' → only the
  // current class is touched. These helpers centralize the "for each
  // sibling instance / group of this master / name in other classes"
  // loops so callers stay terse.

  function forSiblingsOf(masterId, fn) {
    if (!masterId) return;
    state.pageConfig.useClasses.forEach(function (cid) {
      if (cid === state.classId) return;
      const bucket = state.byClass[cid];
      if (!bucket || !Array.isArray(bucket.lines)) return;
      bucket.lines.forEach(function (sib) {
        if (sib.masterId === masterId) fn(sib, cid, bucket);
      });
    });
  }
  function forSiblingGroupsByName(groupName, fn) {
    if (!groupName) return;
    state.pageConfig.useClasses.forEach(function (cid) {
      if (cid === state.classId) return;
      const bucket = state.byClass[cid];
      if (!bucket || !Array.isArray(bucket.groups)) return;
      bucket.groups.forEach(function (g) {
        if (g.name === groupName) fn(g, cid, bucket);
      });
    });
  }
  function modeIsAll() { return state.mode === 'all'; }
  // The "primary" selection is the most recently added id; the params
  // panel renders this one's fields when exactly one object is selected.
  function primarySelectedId() {
    return state.selectedIds.length
      ? state.selectedIds[state.selectedIds.length - 1] : null;
  }
  // Hidden lines (or lines in a hidden group) are excluded from the
  // "select all" count so the button reads "Deselect all" only when
  // every VISIBLE object is in the selection. Picking hidden objects
  // via Select-all was a footgun — destructive bulk actions
  // (Delete, Merge) would then touch objects the user couldn't see.
  function visibleLines() {
    return state.lines.filter(function (l) {
      if (l.hidden) return false;
      const group = state.groups.find(function (g) { return g.id === l.groupId; });
      if (group && group.hidden) return false;
      return true;
    });
  }
  function allObjectsSelected() {
    const eligible = visibleLines();
    return eligible.length > 0 && state.selectedIds.length === eligible.length;
  }

  function arraysEqual(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  // ── Modals (help panel, choice dialog) ────────────────────────────
  // A central place for any prompt that needs more than the browser's
  // 2-button confirm() — and a substrate for future help content.

  /**
   * Show a modal with custom buttons. Returns a Promise that resolves
   * with the chosen button's value (or null on Escape / overlay click).
   *
   * opts.title    — header text (optional)
   * opts.message  — body text or HTML
   * opts.html     — if true, message is HTML; otherwise plain text
   * opts.buttons  — [{ label, value, className? }, …]
   */
  /**
   * Zoom dialog — a small modal with a number input, a "Reset to
   * 100%" button, and Apply / Cancel. Replaces the bare prompt()
   * so the user can reach 100% in one click instead of having to
   * type the value (the typing flow stays available for exact
   * percents like 175). Apply or Enter commits; Cancel or Esc
   * aborts. Out-of-range inputs (25–400) flash the input border
   * and don't commit.
   */
  function showZoomDialog() {
    const current = Math.round(state.zoom * 100);
    const overlay = document.createElement('div');
    overlay.className = 'ed-modal-overlay';
    const modal = document.createElement('div');
    modal.className = 'ed-modal';

    const head = document.createElement('div');
    head.className = 'ed-modal-header';
    const t = document.createElement('h3'); t.textContent = 'Zoom';
    head.appendChild(t);
    const x = document.createElement('button');
    x.className = 'ed-modal-close'; x.textContent = '×';
    x.addEventListener('click', cleanup);
    head.appendChild(x);
    modal.appendChild(head);

    const body = document.createElement('div');
    body.className = 'ed-modal-body';
    const row = document.createElement('div');
    row.style.display = 'flex';
    row.style.alignItems = 'center';
    row.style.gap = '0.5rem';
    row.style.flexWrap = 'wrap';
    const inp = document.createElement('input');
    inp.type = 'number';
    inp.min = '25';
    inp.max = '400';
    inp.step = '5';
    inp.value = String(current);
    inp.style.width = '5.5em';
    const pct = document.createElement('span'); pct.textContent = '%';
    const range = document.createElement('span');
    range.style.color = '#888';
    range.style.fontSize = '0.85em';
    range.textContent = 'range 25–400';
    row.appendChild(inp);
    row.appendChild(pct);
    row.appendChild(range);
    body.appendChild(row);
    modal.appendChild(body);

    const btnRow = document.createElement('div');
    btnRow.className = 'ed-modal-buttons';
    // v0.8.31: "100%" is a first-class action that commits and
    // closes the dialog, just like Apply — promote it to the same
    // visual weight (.ed-primary, accent orange) and put it on the
    // buttons row. margin-right:auto pushes Cancel/Apply to the
    // far end so the buttons read as "shortcut … Cancel / Apply".
    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'ed-primary';
    reset.textContent = '100%';
    reset.title = 'Reset to 100% and apply';
    reset.style.marginRight = 'auto';
    reset.addEventListener('click', function () {
      inp.value = '100';
      apply();
    });
    btnRow.appendChild(reset);
    const cancel = document.createElement('button');
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', cleanup);
    btnRow.appendChild(cancel);
    const applyBtn = document.createElement('button');
    applyBtn.className = 'ed-primary';
    applyBtn.textContent = 'Apply';
    applyBtn.addEventListener('click', apply);
    btnRow.appendChild(applyBtn);
    modal.appendChild(btnRow);

    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    inp.focus();
    inp.select();

    function apply() {
      const v = parseFloat(inp.value);
      if (!Number.isFinite(v) || v < 25 || v > 400) {
        inp.style.borderColor = '#f88';
        inp.focus();
        return;
      }
      setZoom(v / 100);
      cleanup();
    }
    function cleanup() {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
    }
    function onKey(e) {
      if (e.key === 'Escape') cleanup();
      else if (e.key === 'Enter') apply();
    }
    document.addEventListener('keydown', onKey);
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) cleanup();
    });
  }

  function showChoiceDialog(opts) {
    return new Promise(function (resolve) {
      const overlay = document.createElement('div');
      overlay.className = 'ed-modal-overlay';
      const modal = document.createElement('div');
      modal.className = 'ed-modal';

      if (opts.title) {
        const h = document.createElement('div');
        h.className = 'ed-modal-header';
        const t = document.createElement('h3'); t.textContent = opts.title;
        h.appendChild(t);
        const x = document.createElement('button');
        x.className = 'ed-modal-close'; x.textContent = '×';
        x.addEventListener('click', function () { cleanup(); resolve(null); });
        h.appendChild(x);
        modal.appendChild(h);
      }

      const body = document.createElement('div');
      body.className = 'ed-modal-body';
      if (opts.html) body.innerHTML = opts.message;
      else {
        const p = document.createElement('p'); p.textContent = opts.message;
        body.appendChild(p);
      }
      modal.appendChild(body);

      const btnRow = document.createElement('div');
      btnRow.className = 'ed-modal-buttons';
      opts.buttons.forEach(function (b) {
        const btn = document.createElement('button');
        btn.textContent = b.label;
        if (b.className) btn.className = b.className;
        btn.addEventListener('click', function () { cleanup(); resolve(b.value); });
        btnRow.appendChild(btn);
      });
      modal.appendChild(btnRow);

      overlay.appendChild(modal);
      document.body.appendChild(overlay);

      function cleanup() {
        overlay.remove();
        document.removeEventListener('keydown', onKey);
      }
      function onKey(e) {
        if (e.key === 'Escape') { cleanup(); resolve(null); }
      }
      document.addEventListener('keydown', onKey);
      overlay.addEventListener('click', function (e) {
        if (e.target === overlay) { cleanup(); resolve(null); }
      });
    });
  }

  // Help-topic registry. More topics can be added later (per tool,
  // per panel, etc.) and surfaced via showHelp(topicId).
  const HELP_TOPICS = {
    general: {
      title: 'Editor tips',
      html: '\
        <h4>Tools</h4>\
        <p>Pick a tool then draw on the canvas. Each tool commits on release.</p>\
        <ul>\
          <li><strong>Freehand / Loop</strong> — click-drag for an organic stroke. Loop auto-closes and fills.</li>\
          <li><strong>Line / Chain</strong> — straight segments. Chain adds anchors on each click; Esc or double-click finishes.</li>\
          <li><strong>Bezier</strong> — clicks become a smooth curve through every anchor. Esc / double-click finishes.</li>\
          <li><strong>Circle, Ellipse, Rect, Polygon, Star</strong> — click-drag to size.</li>\
        </ul>\
        <h4>Select mode</h4>\
        <p>Neutral mode — no drawing happens. Click a tool to switch back to drawing.</p>\
        <ul>\
          <li><strong>Click</strong> on an object to select it.</li>\
          <li><strong>Click again</strong> at the same spot to cycle to the next object beneath.</li>\
          <li><strong>Cmd/Shift-click</strong> on the canvas or on a row in the sidebar to add an object to the selection — or remove it if already selected.</li>\
          <li><strong>Drag</strong> any selected object\'s body to move every selected object in lockstep, preserving their spatial relationship.</li>\
          <li><strong>Drag handles</strong> (cyan dots) to reshape — point handles on free-form lines, parameter handles on primitives. Handles only show when exactly one object is selected.</li>\
          <li><strong>⌥ Option-click</strong> (Alt-click on Windows) on an object to select it <em>and</em> open its detail panel. If the panel is already open for that object, Option-click closes it instead. Option-click on empty canvas deselects and closes any open unpinned panel.</li>\
          <li><strong>Arrow keys</strong> scroll the canvas (works immediately after page load, no click needed first). With a selection, arrows nudge selected objects instead; Shift multiplies the nudge step by 10.</li>\
          <li><strong>⌥ Option+Arrow</strong> scrolls the canvas <em>and</em> shifts all open floating panels in lockstep — use this to bring panels intentionally parked off-screen into view, then Option-arrow back to restore their position. Works with or without a selection.</li>\
          <li><strong>Esc</strong> or empty-canvas click to clear the selection.</li>\
          <li><strong>Backspace</strong> / Delete to remove every selected object.</li>\
        </ul>\
        <p>The <kbd>Select all</kbd> button toggles between "every object selected" and nothing — the same selection list the canvas and sidebar drive.</p>\
        <h4>Workflow</h4>\
        <p>Click an existing line on the canvas to select it. Drag its body to move; drag handles to reshape. Click the same spot again to cycle to a line beneath.</p>\
        <p>Groups in the sidebar are labeled <strong>G1, G2, …</strong>; the same prefix appears on canvas labels (toggle <kbd>Labels</kbd>) so you can match them up.</p>\
        <p>Drag a line row onto another row to reorder it; drop position (above / below the target) drives the canvas Z-order — earlier in the list = drawn first = behind. Drop on a group row instead to send the line to the end of that group. Group rows reorder the same way — drag a group above/below another to restack every line inside it; lines stay in the order they had within the group. Behavior blocks in the per-line panel reorder by grabbing their title strip and dropping onto another block.</p>\
        <p><kbd>Cmd/Ctrl + Z</kbd> undoes; <kbd>Cmd/Ctrl + Shift + Z</kbd> redoes; <kbd>Esc</kbd> cancels the current gesture.</p>\
        <h4>Panels</h4>\
        <p>Every object has a floating detail panel that shows its full parameters, style, and behavior blocks without displacing the sidebar. Two ways to open it:</p>\
        <ul>\
          <li><strong>⌥ Option-click</strong> (Alt-click on Windows) on any object on the canvas, or on its row in the sidebar.</li>\
          <li>The <strong>⊞ button</strong> on the right end of each sidebar row — always visible; red when the panel is open.</li>\
        </ul>\
        <p>Panels can be pinned (📌) to stay open when the selection changes, or left unpinned to follow the current selection. Drag the panel header to reposition. A common workflow is to push a panel (and its attached block panel) to the right edge of the window for a clear view of the canvas — <strong>⌥ Option+Arrow keys</strong> then pan the canvas and all open panels together in lockstep, so you can bring them into view to edit, and arrow back out when done. No need to deselect.</p>\
        <h4>Behaviors</h4>\
        <p>Every line carries an ordered list of behavior blocks. Each block has two independent axes — <strong>Activate when</strong> (the trigger that turns the block on) and <strong>Progress</strong> (how the block\'s 0→1 advances once active) — plus per-block translate / rotate deltas that get weighted by progress. The side panel summary describes the active combination on the selected block; the table below catalogs every option.</p>\
        <p><strong>Activate when</strong> — picks the trigger:</p>\
        <ul>\
          <li><strong>Scroll range</strong> — fires the first time scroll position enters [start, end] (expressed as a fraction of page scroll). Pairs with any progress mode.</li>\
          <li><strong>Page load</strong> — fires at page load. Optional delay (s) pushes it later.</li>\
          <li><strong>Scroll key</strong> — fires when scroll brings a named DOM element (by selector) past a viewport anchor (top / middle / bottom / the object itself). Set <em>Repeat</em> to fire once or every crossing.</li>\
          <li><strong>In view (partial)</strong> — fires when the animated object first enters the viewport.</li>\
          <li><strong>In view (full)</strong> — fires when the animated object is fully inside the viewport.</li>\
          <li><strong>After previous</strong> — fires at the exact instant the previous timed block ends, for gapless chains. Requires a Timed / Loop-back block earlier in the list.</li>\
          <li><strong>Scroll stops</strong> — fires when the user stops scrolling. <em>Delay</em> (s) is how long the page must stay still before firing; if scrolling resumes before the delay elapses, the pending fire is cancelled.</li>\
          <li><strong>Scroll resumes</strong> — symmetric to <em>Scroll stops</em>: fires when the user starts scrolling after being still. <em>Delay</em> is how long scrolling must continue before firing; a stop before the delay elapses cancels the pending fire.</li>\
          <li><strong>Wait for external Start</strong> — does nothing on its own. The block sits dormant until another object\'s trigger fires a Start command targeting this class. Use this to build externally-driven sequences where the activation is owned by a different object.</li>\
          <li><strong>Wait for click</strong> — fires when the user clicks the object. Default hit test is SVG-native (the filled body of closed shapes; stroke only on unfilled outlines). Optional checkbox <em>Treat shape as filled for hit test</em> flips it to "click anywhere inside the shape\'s bounds counts" — useful for unfilled outlines where stroke-only would be too narrow to target. Fires once.</li>\
          <li><strong>Wait for hover</strong> — fires the first time the pointer enters the object. Same hit-test options as click, including the optional fill-extent override. On touch devices (no hover), the trigger also accepts a click as a fallback — whichever comes first fires it. Fires once.</li>\
        </ul>\
        <p><strong>Cross-object Start / Stop</strong> — every trigger can optionally affect <em>another</em> object when it fires. The target is picked by class name (objects sharing a class animate together). Self is excluded from the lists.</p>\
        <ul>\
          <li><strong>Start object</strong> — fires the target\'s <em>earliest waiting block</em> (the first block in the list whose natural trigger hasn\'t fired yet) as if its trigger had just fired. Already-fired blocks stay fired — Start never double-fires a block. If every block has already fired, Start is a no-op. If the target is currently Stopped (or mid-cleanup), Start first cancels the cleanup and rearms every block to waiting, then fires the earliest waiting one. Pairs with <em>Wait for external Start</em> triggers for fully externally-driven chains.</li>\
          <li><strong>Stop object</strong> — visually resets the target to its neutral, pre-fire state: no translation, no rotation, original opacity, original draw-in fully drawn. The target ends ready to fire again from frame zero. Two optional cleanups: <em>fade out to opacity 0</em> and <em>return to original position</em>; both share a single <em>cleanup duration</em> (0 = instant) and <em>easing</em>. A second Stop while a cleanup is already running is ignored; a Start while a cleanup is running cancels the cleanup and re-arms.</li>\
        </ul>\
        <p><strong>Progress</strong> — picks how 0→1 advances:</p>\
        <ul>\
          <li><strong>Scroll-driven</strong> — progress = scroll position within the trigger\'s range. Only valid when the trigger is Scroll range. Seconds / easing don\'t apply.</li>\
          <li><strong>Timed run (seconds)</strong> — progress runs 0→1 over <em>Seconds</em> of wall-clock time after the trigger fires, then stays at 1.</li>\
          <li><strong>Loop forever</strong> — progress cycles 0→1 every <em>Seconds</em>, sawtooth-style.</li>\
          <li><strong>Ping-pong forever</strong> — progress oscillates 0→1→0 every 2×<em>Seconds</em>.</li>\
          <li><strong>Loop back to earlier block</strong> — animates the line over <em>Seconds</em> back to where the chosen target block started, then replays the chain from the target onward. Pair with After previous + a sequence of Timed blocks above to build a walking / looping multi-step animation. Optional <em>Max iterations</em> caps the cycles (0 = forever); when capped, the line parks at the target\'s start position.</li>\
        </ul>\
        <p>Each block also carries a set of "what changes" controls — translation, rotation, opacity, draw-in. They\'re independent: a single block can move, rotate, and fade at the same time, all driven by the block\'s Progress.</p>\
        <p><strong>Translate / Rotate</strong> — per-block deltas weighted by Progress. TranslateX / TranslateY / Rotate at Progress = 1 equals the authored value; at 0.5 it\'s half. Pivot (Δx, Δy) offsets the rotation center from the object\'s natural center.</p>\
        <p><strong>Translate mode</strong> — switches how the object\'s position is driven:</p>\
        <ul>\
          <li><strong>Fixed</strong> — TranslateX / TranslateY are the final displacement at Progress = 1.</li>\
          <li><strong>Drift X / Y / Both</strong> — the value is a per-scroll-pixel multiplier on the chosen axis. The displacement accumulates while the block is active and freezes the moment the next block activates. Useful for "drift in from off-canvas indefinitely, then hand off".</li>\
          <li><strong>Along path</strong> — the object travels along another line\'s path (its <em>guide</em>) as Progress goes 0→1. The guide can be almost any line — freehand, loop, bezier, chain, imported SVG, or any primitive (circle, ellipse, rect, polygon, star). Only image objects can\'t serve as guides since they don\'t carry a path. Three sub-controls appear:\
            <ul>\
              <li><em>Path guide</em> picks the guide line from the current class. The guide can be visible or hidden — hidden guides still drive the motion (the runtime renders them invisibly so they can be sampled).</li>\
              <li><em>Align to tangent</em> rotates the moving object to match the path direction at each point, so it "faces forward" along its travel.</li>\
              <li><em>At end of path</em> controls what happens once Progress reaches 1 on an open path: <strong>Stop</strong> parks the object at the end; <strong>Loop</strong> snaps back to the start (smooth on closed paths, jump on open); <strong>Ping-pong</strong> reverses direction at each end. Closed paths (loops) make the choice mostly cosmetic since end ≈ start.</li>\
            </ul>\
            The guide can itself be animating (via its own behavior blocks) — the follower tracks the guide\'s current shape and position frame-by-frame. Multiple Along-path blocks can chain in time: the most recent active one wins, so the follower can hand off between guides over the timeline.\
          </li>\
        </ul>\
        <p><strong>Fade opacity</strong> — opt-in opacity transition. When on, the line\'s opacity is interpolated each frame from <em>Opacity from</em> (at Progress = 0) to <em>Opacity to</em> (at Progress = 1). Authored as absolute values (0 = invisible, 1 = fully opaque), not deltas — so 1→0 fades out, 0→1 fades in, 1→1 keeps it solid. Composes by "last active block wins": a chain of fade blocks reads as a sequence (fade to 0.5, then to 0, etc.); blocks without Fade opacity don\'t touch the line\'s opacity.</p>\
        <p><strong>Draw-in</strong> — when on, the line\'s stroke draws on with Progress instead of appearing fully drawn. <em>Direction</em> reverses the draw order.</p>\
        <p>Multiple blocks compose: TranslateX / TranslateY / Rotate contributions sum each frame; opacity uses last-active-wins; Along-path also uses last-active-wins for the position contribution but its own tx/ty replace the block\'s authored deltas (other blocks\' Fixed / Drift values still sum on top). A Loop-back block contributes a <em>negative</em> snapshot of the chain it\'s undoing, so the line returns exactly to the target\'s start.</p>'
    }
  };

  function showHelp(topicId) {
    const topic = HELP_TOPICS[topicId];
    if (!topic) return;
    showChoiceDialog({
      title:   topic.title,
      message: topic.html,
      html:    true,
      buttons: [{ label: 'Close', value: null }]
    });
  }

  // ── Coord helpers ─────────────────────────────────────────────────
  // Converts client (viewport) pixel coords to viewBox logical coords.
  // Uses getBoundingClientRect so scroll offsets and any future zoom
  // are handled automatically — the rect already reflects the surface's
  // current visual position. The viewBox.baseVal gives the origin
  // offset (-600, -400) plus the logical size (2400, 1600).
  function clientToSvg(clientX, clientY) {
    const rect = svg.getBoundingClientRect();
    const vb   = svg.viewBox.baseVal;
    return {
      x: vb.x + ((clientX - rect.left) / rect.width)  * vb.width,
      y: vb.y + ((clientY - rect.top)  / rect.height) * vb.height
    };
  }
  function eventPt(e) { return clientToSvg(e.clientX, e.clientY); }

  // ── Undo / redo ───────────────────────────────────────────────────
  // Snapshot-based undo. Each snapshot deep-copies the editable parts
  // of state (groups, lines, palette, current selection). Discrete
  // actions (commit / delete / add color / etc.) snapshot immediately;
  // text and number field edits coalesce via a debounce so undoing
  // doesn't step through every keystroke.
  const HISTORY_MAX = 50;
  state.history    = [];
  state.historyIdx = -1;
  let snapshotTimer = null;

  function deepCopy(o) { return JSON.parse(JSON.stringify(o)); }

  /**
   * Single mutation entry point for ANY visual prop.
   *
   *   - If master.scope[keyPath] === 'local': write the instance's
   *     override and update line[key] only on the current line.
   *   - Else (canonical): write master[key] and propagate to every
   *     instance of that master across every class.
   *
   * For params sub-keys the keyPath is 'params.<sub-key>' and the
   * write happens at sub-key granularity on both master.params and
   * each instance's line.params. Position sub-keys
   * (cx / cy / x / y) bypass this entirely — they go through
   * setPositionFromPanel which writes to positionOffset.
   *
   * Lines without a masterId (rare — newly-drawn pre-save) just
   * mutate locally; decomposeForSave mints a master from them.
   */
  async function setVisualProp(lineId, keyPath, value, opts) {
    opts = opts || {};
    const line = state.lines.find(function (l) { return l.id === lineId; });
    if (!line) return;
    const master = line.masterId
      ? state.masters.find(function (x) { return x.id === line.masterId; })
      : null;
    const parts = keyPath.split('.');
    const isParamSub = (parts[0] === 'params' && parts.length === 2);
    const subKey = isParamSub ? parts[1] : null;
    if (isParamSub && POSITION_PARAM_SUBKEYS.indexOf(subKey) !== -1) {
      // Position sub-key — route to positionOffset instead.
      setPositionFromPanel(lineId, subKey, value);
      return;
    }

    // 'one' mode + canonical scope → refuse cleanly. The user has
    // to leave 'one' mode to edit a canonical key, or flip the
    // key's scope to local via the 🔗 toggle first (in either
    // mode). No "Flip & apply" shortcut here — the contract is
    // "explicit decisions", not "hidden assists". Cascade-style
    // callers opt out via opts.silent and skip silently.
    let asyncPath = false;
    if (state.mode === 'one' && master && !isLocal(master, keyPath)) {
      if (opts.silent) return;
      asyncPath = true;
      await explainRefusal(master, keyPath);
      renderSelectionPanel(); // revert UI from any typed/clicked value
      return;
    }

    if (!master || isLocal(master, keyPath)) {
      // Local scope (or no master to write to) → instance-only.
      if (isParamSub) {
        if (!line.params) line.params = {};
        line.params[subKey] = value;
        if (!line.overrides) line.overrides = {};
        if (!line.overrides.params || typeof line.overrides.params !== 'object') {
          line.overrides.params = {};
        }
        line.overrides.params[subKey] = value;
      } else {
        line[keyPath] = value;
        if (!line.overrides) line.overrides = {};
        line.overrides[keyPath] = value;
      }
      computeLineD(line);
    } else {
      // Canonical scope → master + every instance of the master.
      if (isParamSub) {
        if (!master.params) master.params = {};
        master.params[subKey] = value;
        computeLineD(master);
      } else {
        master[keyPath] = value;
        computeLineD(master);
      }
      state.pageConfig.useClasses.forEach(function (cid) {
        const lines = (state.byClass[cid] && state.byClass[cid].lines) || [];
        lines.forEach(function (l) {
          if (l.masterId !== master.id) return;
          if (isParamSub) {
            if (!l.params) l.params = {};
            l.params[subKey] = value;
            // Any per-class override on this sub-key would have been
            // ignored at resolve time (scope is canonical), but tidy
            // up the override map anyway.
            if (l.overrides && l.overrides.params
                && Object.prototype.hasOwnProperty.call(l.overrides.params, subKey)) {
              delete l.overrides.params[subKey];
              if (!Object.keys(l.overrides.params).length) delete l.overrides.params;
            }
          } else {
            l[keyPath] = value;
            if (l.overrides && Object.prototype.hasOwnProperty.call(l.overrides, keyPath)) {
              delete l.overrides[keyPath];
            }
          }
          computeLineD(l);
        });
      });
    }
    state.dirty = true;
    // When we took the async refusal-dialog path the caller's
    // synchronous side effects (renderLines / scheduleSnapshot)
    // already fired with pre-write state. Re-trigger now so the
    // canvas + panel + groups list reflect the post-write reality.
    if (asyncPath) {
      scheduleSnapshot();
      renderLines();
      if (keyPath === 'stroke' || keyPath === 'width') renderGroupsList();
      renderSelectionPanel();
    }
  }

  /**
   * Explain why a canonical visual prop can't be edited in 'one'
   * mode. Single OK button — no in-dialog flip shortcut. The user
   * has two paths out: switch to 'all' mode (canonical edit
   * affecting every class), or flip the key's scope to local via
   * the 🔗 toggle on the field row first. Structurally canonical
   * keys (e.g., 'name') have no 🔗 toggle, so the dialog only
   * offers the 'all'-mode path for those.
   */
  async function explainRefusal(master, keyPath) {
    const niceName = humanizeKeyPath(keyPath);
    const escHtml = function (s) {
      const d = document.createElement('div');
      d.textContent = String(s);
      return d.innerHTML;
    };
    const lines = [
      '<p><strong>' + escHtml(niceName) + '</strong> is canonical on this object — ' +
      'it applies to every class together.</p>',
      '<p>You\'re in <strong>one-class</strong> mode (the <strong>1</strong> button next ' +
      'to the class tabs). One-class mode only writes to the current class — editing a ' +
      'canonical key isn\'t allowed because that would diverge the master.</p>'
    ];
    if (keyPath === 'name') {
      lines.push('<p>To rename this object, switch to <strong>all</strong> mode (the ' +
        '<strong>A</strong> button).</p>');
    } else {
      lines.push('<p>Two ways forward:</p>' +
        '<ul>' +
        '<li>Switch to <strong>all</strong> mode (A button) to edit canonically across every class.</li>' +
        '<li>Or flip <strong>' + escHtml(niceName) + '</strong> to local via the ' +
        '<strong>🔗</strong> toggle next to the field — then come back here and edit.</li>' +
        '</ul>');
    }
    await showChoiceDialog({
      title:   'Edit disallowed in one-class mode',
      message: lines.join(''),
      html:    true,
      buttons: [{ label: 'OK', value: null, className: 'ed-primary' }]
    });
  }

  // Pretty key paths for dialogs. "params.r" → "Radius (params.r)";
  // bare keys → title-cased. Unknown keys fall back to the raw
  // key path so the user can still recognize the thing.
  function humanizeKeyPath(keyPath) {
    const NAMES = {
      'stroke':           'Color',
      'width':            'Line width',
      'linejoin':         'Corners',
      'smoothed':         'Smooth',
      'filled':           'Filled',
      'closed':           'Closed',
      'name':             'Name',
      'params.r':         'Radius',
      'params.rx':        'Radius X',
      'params.ry':        'Radius Y',
      'params.rOuter':    'Outer radius',
      'params.rInner':    'Inner radius',
      'params.w':         'Width',
      'params.h':         'Height',
      'params.sides':     'Sides',
      'params.points':    'Points',
      'params.angle':     'Angle',
      'params.src':       'Image URL',
      'params.fit':       'Fit'
    };
    return NAMES[keyPath] || keyPath;
  }

  /**
   * Visually lock a field row when the editor is in 'one' mode AND
   * the keyPath is canonical on the master. Disables every
   * editable control inside (input / select / non-toggle button)
   * and routes clicks on the wrap to the explainRefusal dialog.
   * The 🔗/✎ scope toggle stays clickable — that's the path the
   * dialog points at, so it has to remain operable. Always-per-
   * class keys (behavior, position sub-keys) bypass this since
   * they never go through the scope contract.
   */
  function lockIfCanonicalInOneMode(field, masterId, keyPath) {
    if (state.mode !== 'one' || !masterId) return field;
    // Position sub-keys (params.cx/cy/x/y) always write per-class
    // via positionOffset — they're outside the scope contract and
    // must stay editable in 'one' mode.
    const parts = keyPath.split('.');
    if (parts[0] === 'params' && POSITION_PARAM_SUBKEYS.indexOf(parts[1]) !== -1) {
      return field;
    }
    const master = state.masters.find(function (m) { return m.id === masterId; });
    if (!master || isLocal(master, keyPath)) return field;
    field.classList.add('is-refused');
    field.querySelectorAll('input, select, textarea').forEach(function (el) {
      el.disabled = true;
      el.tabIndex = -1;
    });
    // Color picker uses <button class="swatch">, not <input>;
    // disable those too. Leave .ed-link-toggle untouched so the
    // scope flipper still works.
    field.querySelectorAll('button:not(.ed-link-toggle)').forEach(function (el) {
      el.disabled = true;
      el.tabIndex = -1;
    });
    // Click anywhere on the row (except the scope toggle) → dialog.
    // Capture phase so the field's own click handlers don't fire.
    field.addEventListener('click', function (e) {
      if (e.target && e.target.closest && e.target.closest('.ed-link-toggle')) return;
      e.stopPropagation();
      e.preventDefault();
      explainRefusal(master, keyPath);
    }, true);
    return field;
  }

  /**
   * Update positionOffset to make a param sub-key (cx/cy/x/y) equal
   * the typed value on the current instance only. Master is not
   * touched; other classes don't follow.
   */
  function setPositionFromPanel(lineId, subKey, value) {
    const line = state.lines.find(function (l) { return l.id === lineId; });
    if (!line) return;
    if (!line.params) line.params = {};
    if (!line.positionOffset) line.positionOffset = { dx: 0, dy: 0 };
    const master = line.masterId
      ? state.masters.find(function (x) { return x.id === line.masterId; })
      : null;
    const canonical = (master && master.params && Number.isFinite(master.params[subKey]))
      ? master.params[subKey] : 0;
    const isXAxis = (subKey === 'cx' || subKey === 'x');
    if (isXAxis) line.positionOffset.dx = value - canonical;
    else         line.positionOffset.dy = value - canonical;
    line.params[subKey] = value;
    computeLineD(line);
    state.dirty = true;
    renderLines();
  }

  /**
   * v0.8.95 SUPERSEDED: setLinePositionOffset was a wrong-headed
   * helper that bumped positionOffset without translating the stored
   * geometry — leaving the object visually un-moved because the
   * renderer draws from line.d. Use shiftLineBy(line, dx, dy) for
   * any direct position move. The panel non-primitive Parameters
   * block now does its edits via that helper.
   */

  /**
   * Zero a line's positionOffset, snapping it back to the master's
   * canonical placement. Only the current class is affected.
   */
  function resetPositionOffset(lineId) {
    const line = state.lines.find(function (l) { return l.id === lineId; });
    if (!line) return;
    snapPositionOffsetToZero(line);
    // 'all' mode: every sibling-class instance snaps back too.
    // 'one' mode: just this class — sibling positions stay where
    // the user left them.
    if (modeIsAll() && line.masterId) {
      forSiblingsOf(line.masterId, function (sib) {
        snapPositionOffsetToZero(sib);
      });
    }
    state.dirty = true;
    snapshot();
    renderAll();
  }
  function snapPositionOffsetToZero(line) {
    line.positionOffset = { dx: 0, dy: 0 };
    if (line.masterId && line.params) {
      const m = state.masters.find(function (x) { return x.id === line.masterId; });
      if (m && m.params) {
        ['cx', 'cy', 'x', 'y'].forEach(function (k) {
          if (Number.isFinite(m.params[k])) line.params[k] = m.params[k];
        });
      }
    }
    if (line.masterId && Array.isArray(line.points)) {
      const m = state.masters.find(function (x) { return x.id === line.masterId; });
      if (m && Array.isArray(m.points)) {
        line.points = m.points.map(function (p) { return { x: p.x, y: p.y }; });
      }
    }
    computeLineD(line);
  }

  /**
   * Flip scope on a master property. Local ⇄ canonical. When going
   * canonical-to-local we keep current per-instance values as
   * overrides so the visible state doesn't jump. When going
   * local-to-canonical we drop all instance overrides on that key;
   * everyone snaps to master.
   */
  function setMasterScope(masterId, keyPath, newScope) {
    const m = state.masters.find(function (x) { return x.id === masterId; });
    if (!m) return;
    // `name` is structurally canonical (see isLocal). Refuse any
    // attempt to flip its scope — UI shouldn't surface the toggle
    // (scopeToggle returns null for 'name'), but a defensive
    // refuse here protects against direct callers / future code.
    if (keyPath === 'name') return;
    if (!m.scope || typeof m.scope !== 'object') m.scope = {};
    if (newScope === 'local') {
      m.scope[keyPath] = 'local';
      // Snapshot each instance's current value into its overrides
      // (so what's visible right now becomes the new local value).
      state.pageConfig.useClasses.forEach(function (cid) {
        const lines = (state.byClass[cid] && state.byClass[cid].lines) || [];
        lines.forEach(function (l) {
          if (l.masterId !== masterId) return;
          if (!l.overrides) l.overrides = {};
          const parts = keyPath.split('.');
          if (parts[0] === 'params' && parts.length === 2) {
            if (!l.overrides.params) l.overrides.params = {};
            if (l.params && l.params[parts[1]] !== undefined) {
              l.overrides.params[parts[1]] = l.params[parts[1]];
            }
          } else if (l[keyPath] !== undefined) {
            l.overrides[keyPath] = l[keyPath];
          }
        });
      });
    } else {
      delete m.scope[keyPath];
      // Drop instance overrides on this key + snap line values back
      // to master.
      state.pageConfig.useClasses.forEach(function (cid) {
        const lines = (state.byClass[cid] && state.byClass[cid].lines) || [];
        lines.forEach(function (l) {
          if (l.masterId !== masterId) return;
          const parts = keyPath.split('.');
          if (parts[0] === 'params' && parts.length === 2) {
            if (l.overrides && l.overrides.params
                && Object.prototype.hasOwnProperty.call(l.overrides.params, parts[1])) {
              delete l.overrides.params[parts[1]];
              if (!Object.keys(l.overrides.params).length) delete l.overrides.params;
            }
            if (m.params && m.params[parts[1]] !== undefined && l.params) {
              l.params[parts[1]] = m.params[parts[1]];
            }
          } else {
            if (l.overrides) delete l.overrides[keyPath];
            if (m[keyPath] !== undefined) l[keyPath] = m[keyPath];
          }
          computeLineD(l);
        });
      });
    }
    state.dirty = true;
  }

  /**
   * Decompose state.byClass[].lines + state.masters into the on-disk
   * shape for save. Under the scope-driven model the save side is
   * pure bookkeeping — all routing happened at edit time:
   *
   *   - Canonical edits (default scope) mutated master + every
   *     instance in place via setVisualProp / propagateLineToMaster.
   *   - Local edits (scope flipped to 'local') landed in
   *     line.overrides. Behavior keys always land there too.
   *   - Position lives in line.positionOffset, never in overrides.
   *
   * So the per-instance overrides we emit equal line.overrides,
   * filtered defensively against the master's current scope: any
   * stray canonical-scoped visual key in there gets dropped.
   *
   * Pass 1 mints masters for freshly drawn lines (empty scope,
   * snapshot of current visual values). Pass 2 emits per-class
   * instances. Unreferenced masters are pruned.
   */
  function decomposeForSave() {
    const useClasses = state.pageConfig.useClasses || [];
    const masterMap = {};
    state.masters.forEach(function (m) {
      if (!m || !m.id) return;
      const copy = Object.assign({}, m);
      if (m.scope && typeof m.scope === 'object') {
        copy.scope = Object.assign({}, m.scope);
      } else {
        copy.scope = {};
      }
      masterMap[m.id] = copy;
    });

    // v0.8.46: skeleton-line guard. A "skeleton" line has no `kind`,
    // typically because its master got deleted and resolveInstanceJS
    // built it from an empty fallback `{}`. Previously decomposeFor-
    // Save happily minted a master from such a line — the master was
    // empty, dropping kind/params/d to disk and silently corrupting
    // the dataset. Now we identify skeleton lines up front, refuse
    // to mint masters from them, and drop them from Pass 2 so they
    // never reach the saved instances files. Caller (save()) sees
    // the count via the returned `droppedLines` array and surfaces
    // a confirm dialog so the user knows their save just trimmed
    // broken records.
    const skeletonLines = new Set();
    const droppedLines = [];
    useClasses.forEach(function (cid) {
      const lines = (state.byClass[cid] && state.byClass[cid].lines) || [];
      lines.forEach(function (line) {
        if (line.kind == null) {
          skeletonLines.add(line);
          droppedLines.push({ cid: cid, id: line.id, masterId: line.masterId || null });
        }
      });
    });

    // Pass 1: mint masters for any lines that don't have one yet.
    // Fresh masters get empty scope (all keys canonical) + a
    // snapshot of the line's current visual values. Skeleton lines
    // are excluded — they'd mint empty masters.
    useClasses.forEach(function (cid) {
      const lines = (state.byClass[cid] && state.byClass[cid].lines) || [];
      lines.forEach(function (line) {
        if (skeletonLines.has(line)) return;
        if (line.masterId && masterMap[line.masterId]) return;
        const mid = line.masterId || ('m-' + Math.random().toString(36).slice(2, 10));
        line.masterId = mid;
        const m = { id: mid, scope: {} };
        MASTER_VISUAL_KEYS.forEach(function (k) {
          if (line[k] !== undefined && line[k] !== null) m[k] = line[k];
        });
        if (m.name === undefined) m.name = line.name || line.id;
        masterMap[mid] = m;
      });
    });

    // Pass 2: per-class instances. Filter overrides through the
    // master's scope: keep behavior keys + scope-local visual keys.
    // Drop anything else (canonical visual keys, position sub-keys).
    const byClass = {};
    const usedMasterIds = {};
    useClasses.forEach(function (cid) {
      const lines = (state.byClass[cid] && state.byClass[cid].lines) || [];
      const groups = (state.byClass[cid] && state.byClass[cid].groups) || [];
      // v0.8.46: drop skeleton lines from the save — they have no
      // master content and would only persist the corruption further.
      const instances = lines.filter(function (line) {
        return !skeletonLines.has(line);
      }).map(function (line) {
        const mid = line.masterId;
        usedMasterIds[mid] = true;
        const master = masterMap[mid];
        const cleanOverrides = {};
        const src = (line.overrides && typeof line.overrides === 'object')
          ? line.overrides : {};
        Object.keys(src).forEach(function (k) {
          // Behavior keys live on line.behaviors[] now (v0.4.0).
          // Drop any stray copies in overrides so they don't get
          // re-saved to disk.
          if (BEHAVIOR_KEYS.indexOf(k) !== -1) return;
          if (k === 'params' && src.params && typeof src.params === 'object') {
            const cleanParams = {};
            Object.keys(src.params).forEach(function (sk) {
              if (POSITION_PARAM_SUBKEYS.indexOf(sk) !== -1) return;
              if (master && isLocal(master, 'params.' + sk)) {
                cleanParams[sk] = src.params[sk];
              }
            });
            if (Object.keys(cleanParams).length) cleanOverrides.params = cleanParams;
            return;
          }
          if (master && isLocal(master, k)) {
            cleanOverrides[k] = src[k];
          }
        });
        const offDx = (line.positionOffset && Number.isFinite(line.positionOffset.dx))
          ? line.positionOffset.dx : 0;
        const offDy = (line.positionOffset && Number.isFinite(line.positionOffset.dy))
          ? line.positionOffset.dy : 0;
        const instRecord = {
          id:        line.id,
          // Denormalized name for human readability of instances.json.
          // The resolver doesn't read it; kept fresh on every save.
          // `id` and `name` lead so the file is easy to scan when
          // grepping or eyeballing it directly.
          name:      (line.name != null && line.name !== '')
                       ? line.name
                       : (master && master.name ? master.name : line.id),
          masterId:  mid,
          visible:   !line.hidden,
          groupId:   line.groupId || null,
          positionOffset: { dx: offDx, dy: offDy },
          behaviors: Array.isArray(line.behaviors)
            ? line.behaviors.map(cloneBehavior)
            : [],
          overrides: cleanOverrides
        };
        // v0.8.231 / schema v12: scrollMode is per-instance. Omit the
        // field when it's 'flow' and wasn't explicitly set — keeps JSON
        // tidy (absence = flow, the runtime default). Always write it
        // when it's 'static' so the static intent is explicit on disk.
        if (line.scrollMode === 'static') {
          instRecord.scrollMode = 'static';
        } else if (line.scrollMode === 'flow') {
          instRecord.scrollMode = 'flow';
        }
        // (absent = flow — no field needed for the default)
        return instRecord;
      });
      byClass[cid] = {
        instances: instances,
        // Reorder groups so id / name lead too — matches the
        // master + instance ordering. defaultGroup already has
        // them in that order, but defensive in case some path
        // built a group with a different shape.
        groups: groups.map(reorderIdNameFirst)
      };
    });

    // Drop unreferenced masters + emit each master with `id` and
    // `name` at the front so JSON inspection lands on the human-
    // readable identifier immediately. Other keys preserve their
    // existing insertion order.
    const masters = Object.keys(masterMap)
      .filter(function (mid) { return usedMasterIds[mid]; })
      .map(function (mid) { return reorderIdNameFirst(masterMap[mid]); });

    return { masters: masters, byClass: byClass, droppedLines: droppedLines };
  }

  // Rebuild an object so { id, name } sit at the front. Subsequent
  // keys are appended in the source's original order, minus id /
  // name (we already wrote them). Used for save-side records that
  // benefit from name-near-the-top when grepping the JSON files.
  function reorderIdNameFirst(obj) {
    if (!obj || typeof obj !== 'object') return obj;
    const out = {};
    if ('id'   in obj) out.id   = obj.id;
    if ('name' in obj) out.name = obj.name;
    Object.keys(obj).forEach(function (k) {
      if (k === 'id' || k === 'name') return;
      out[k] = obj[k];
    });
    return out;
  }

  function snapshot() {
    if (snapshotTimer) { clearTimeout(snapshotTimer); snapshotTimer = null; }
    const snap = {
      byClass:    deepCopy(state.byClass),
      masters:    deepCopy(state.masters),
      palette:    deepCopy(state.palette),
      pageConfig: deepCopy(state.pageConfig),
      classId:    state.classId,
      selectedIds:    state.selectedIds.slice(),
      activeGroupId:  state.activeGroupId
    };
    // Truncate any redo branch beyond the current position.
    state.history = state.history.slice(0, state.historyIdx + 1);
    state.history.push(snap);
    if (state.history.length > HISTORY_MAX) state.history.shift();
    state.historyIdx = state.history.length - 1;
    updateUndoButtons();
  }

  // Debounced snapshot for field-by-field text/number edits. Rapid
  // typing collapses into one history step; finishing edits (pause >
  // 600ms) commits a snapshot.
  function scheduleSnapshot() {
    if (snapshotTimer) clearTimeout(snapshotTimer);
    snapshotTimer = setTimeout(function () {
      snapshotTimer = null;
      snapshot();
    }, 600);
  }

  function restoreFromSnapshot(snap) {
    state.byClass = deepCopy(snap.byClass);
    if (Array.isArray(snap.masters)) state.masters = deepCopy(snap.masters);
    state.palette = deepCopy(snap.palette);
    if (snap.pageConfig) state.pageConfig = deepCopy(snap.pageConfig);
    // Don't restore classId. Class is a view choice, not a design
    // action — undoing a design action shouldn't yank the user to
    // another class. The restored byClass already contains every
    // class's content, so whichever class is currently visible
    // shows its correct pre-action state.
    applyPageConfig();
    renderCanvasPanel();
    // Filter stale selection / active group references to ids that
    // exist in the currently-viewed class. Otherwise an undo that
    // walked us past a deletion or class switch could leave the
    // selection panel pointing at IDs that no longer resolve here.
    const currentLines  = (state.byClass[state.classId] && state.byClass[state.classId].lines)  || [];
    const currentGroups = (state.byClass[state.classId] && state.byClass[state.classId].groups) || [];
    const currentLineIds  = currentLines.map(function (l) { return l.id; });
    const currentGroupIds = currentGroups.map(function (g) { return g.id; });
    state.selectedIds   = (snap.selectedIds || []).filter(function (id) {
      return currentLineIds.indexOf(id) !== -1;
    });
    state.activeGroupId = (snap.activeGroupId && currentGroupIds.indexOf(snap.activeGroupId) !== -1)
      ? snap.activeGroupId
      : (currentGroups[0] ? currentGroups[0].id : null);
    state.dirty = true;
    renderAll();
    updateUndoButtons();
  }

  function undo() {
    // Flush any pending debounced snapshot first so the in-progress
    // edit becomes its own history entry the user can step back from.
    if (snapshotTimer) snapshot();
    if (state.historyIdx <= 0) return;
    state.historyIdx--;
    restoreFromSnapshot(state.history[state.historyIdx]);
  }

  function redo() {
    if (state.historyIdx >= state.history.length - 1) return;
    state.historyIdx++;
    restoreFromSnapshot(state.history[state.historyIdx]);
  }

  function updateUndoButtons() {
    undoBtn.disabled = state.historyIdx <= 0;
    redoBtn.disabled = state.historyIdx >= state.history.length - 1;
  }

  // ── Zoom ──────────────────────────────────────────────────────────
  // Zoom is implemented by scaling the SVG element's CSS width/height
  // away from its base canvasW × canvasH pixel size. The viewBox
  // stays fixed (per state.page), so authored coordinates don't change with
  // zoom; only the rendered scale does. clientToSvg already reads
  // rect.width / rect.height, so pointer-to-viewBox math keeps working
  // at any zoom level without changes.
  const ZOOM_MIN = 0.25, ZOOM_MAX = 4, ZOOM_STEP = 1.25;

  function setZoom(z, anchorClientX, anchorClientY) {
    const newZoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));
    if (newZoom === state.zoom) return;

    // Keep the point under the anchor visually fixed across the zoom
    // change. If no anchor is supplied, anchor to the center of the
    // visible viewport of the wrap.
    const wrapRect = canvasWrap.getBoundingClientRect();
    const ax = (anchorClientX != null) ? anchorClientX : wrapRect.left + wrapRect.width  / 2;
    const ay = (anchorClientY != null) ? anchorClientY : wrapRect.top  + wrapRect.height / 2;
    const wrapX = ax - wrapRect.left;
    const wrapY = ay - wrapRect.top;
    // What logical content position is under the anchor right now?
    const contentX = (canvasWrap.scrollLeft + wrapX) / state.zoom;
    const contentY = (canvasWrap.scrollTop  + wrapY) / state.zoom;

    state.zoom = newZoom;
    svg.style.width  = (state.page.canvasW * newZoom) + 'px';
    svg.style.height = (state.page.canvasH * newZoom) + 'px';

    // Put the same logical content position back under the anchor by
    // adjusting scroll.
    canvasWrap.scrollLeft = contentX * newZoom - wrapX;
    canvasWrap.scrollTop  = contentY * newZoom - wrapY;

    zoomLevelEl.textContent = Math.round(newZoom * 100) + '%';
    // Handles need to re-render at the new inverse scale so they stay
    // a constant visual size regardless of zoom level. Same for the
    // origin indicator (lives in the grid layer; v0.8.95).
    renderHandles();
    renderGrid();
  }
  function zoomIn(anchorX, anchorY)  { setZoom(state.zoom * ZOOM_STEP, anchorX, anchorY); }
  function zoomOut(anchorX, anchorY) { setZoom(state.zoom / ZOOM_STEP, anchorX, anchorY); }
  function zoomReset() { setZoom(1); }

  // ── Line data model ───────────────────────────────────────────────
  // Every line carries:
  //   kind     "freehand" | "freehandClosed" | "line" | "chain" | "manual"
  //   points   [{x, y}, …]  — the vertices the user authored
  //   smoothed boolean (relevant for freehand kinds)
  //   closed   boolean (true for freehandClosed; closes path with Z + fill)
  //   d        SVG `d` string — regenerated from points on every edit
  // Legacy lines (sample data, SVG imports) have only `d`; we parse it on
  // load to populate `points` and tag them as `kind: "manual"` so handles
  // still appear and can drag the path's endpoints around.

  /**
   * Parse an SVG `d` string into an array of segments. Each segment
   * captures its command (M/L/C/Q/S/T/H/V/Z), any control points, and
   * the endpoint — so we can regenerate the path later WITHOUT losing
   * curve types. This is what keeps the seed wavy lines wavy after a
   * handle is dragged: before this parser existed, we extracted only
   * endpoints and the regenerator turned every C/S/Q into a straight L.
   */
  function parseSegments(d) {
    if (!d) return [];
    const segments = [];
    let cur = { x: 0, y: 0 };
    const re = /([MLHVCSQTAZmlhvcsqtaz])([^MLHVCSQTAZmlhvcsqtaz]*)/g;
    let m;
    const abs = function (rel, x, y) {
      return rel ? { x: cur.x + x, y: cur.y + y } : { x: x, y: y };
    };
    while ((m = re.exec(d)) !== null) {
      const cmd = m[1];
      const C   = cmd.toUpperCase();
      const rel = cmd !== C;
      const nums = (m[2].match(/-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/g) || []).map(parseFloat);

      if (C === 'M' || C === 'L' || C === 'T') {
        for (let i = 0; i + 1 < nums.length; i += 2) {
          const ep = abs(rel, nums[i], nums[i + 1]);
          // Repeated coords after an M act like implicit L's per spec.
          const segCmd = (C === 'M' && segments.length > 0 && i > 0) ? 'L' : C;
          segments.push({ cmd: segCmd, controlPoints: [], endpoint: ep });
          cur = ep;
        }
      } else if (C === 'H') {
        for (let i = 0; i < nums.length; i++) {
          const ep = rel ? { x: cur.x + nums[i], y: cur.y } : { x: nums[i], y: cur.y };
          segments.push({ cmd: 'L', controlPoints: [], endpoint: ep });
          cur = ep;
        }
      } else if (C === 'V') {
        for (let i = 0; i < nums.length; i++) {
          const ep = rel ? { x: cur.x, y: cur.y + nums[i] } : { x: cur.x, y: nums[i] };
          segments.push({ cmd: 'L', controlPoints: [], endpoint: ep });
          cur = ep;
        }
      } else if (C === 'C') {
        for (let i = 0; i + 5 < nums.length; i += 6) {
          const cp1 = abs(rel, nums[i],     nums[i + 1]);
          const cp2 = abs(rel, nums[i + 2], nums[i + 3]);
          const ep  = abs(rel, nums[i + 4], nums[i + 5]);
          segments.push({ cmd: 'C', controlPoints: [cp1, cp2], endpoint: ep });
          cur = ep;
        }
      } else if (C === 'S') {
        for (let i = 0; i + 3 < nums.length; i += 4) {
          const cp2 = abs(rel, nums[i],     nums[i + 1]);
          const ep  = abs(rel, nums[i + 2], nums[i + 3]);
          segments.push({ cmd: 'S', controlPoints: [cp2], endpoint: ep });
          cur = ep;
        }
      } else if (C === 'Q') {
        for (let i = 0; i + 3 < nums.length; i += 4) {
          const cp = abs(rel, nums[i],     nums[i + 1]);
          const ep = abs(rel, nums[i + 2], nums[i + 3]);
          segments.push({ cmd: 'Q', controlPoints: [cp], endpoint: ep });
          cur = ep;
        }
      } else if (C === 'A') {
        // SVG arc: rx ry x-axis-rot large-flag sweep-flag x y. We
        // preserve the arc-specific args on the segment so segmentsToD
        // can re-emit it intact; the editor's handle UI just sees the
        // endpoint (arc curvature has no draggable control points
        // here — that would be a separate authoring mode).
        for (let i = 0; i + 6 < nums.length; i += 7) {
          const ep = abs(rel, nums[i + 5], nums[i + 6]);
          segments.push({
            cmd: 'A',
            controlPoints: [],
            endpoint: ep,
            arcArgs: {
              rx:    nums[i],
              ry:    nums[i + 1],
              rot:   nums[i + 2],
              large: nums[i + 3] ? 1 : 0,
              sweep: nums[i + 4] ? 1 : 0
            }
          });
          cur = ep;
        }
      } else if (C === 'Z') {
        segments.push({ cmd: 'Z', controlPoints: [], endpoint: null });
      }
    }
    return segments;
  }

  // ── SVG Import ──────────────────────────────────────────────────────
  // Parse a dropped .svg, walk every renderable element, and turn each
  // into a (master, instance) pair in the current class. Nested
  // <g transform=…> compose through into the rendered geometry.
  // Supported: <path>, <rect>, <circle>, <ellipse>, <polygon>,
  // <polyline>, <line>. Colors referenced by fill / stroke get added
  // to the palette automatically. Primitives keep their PRIMITIVES.*
  // kind when the cumulative transform is pure translate / uniform
  // scale (so the user can still drag handles in the editor);
  // anything more (rotation, skew, non-uniform scale) falls back to
  // `kind: 'manual'` with the matrix baked into segment points.

  const SVG_NUM_RE  = /-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/g;
  const SVG_IDENT_M = [1, 0, 0, 1, 0, 0];

  function svgMultiply(M1, M2) {
    return [
      M1[0]*M2[0] + M1[2]*M2[1],
      M1[1]*M2[0] + M1[3]*M2[1],
      M1[0]*M2[2] + M1[2]*M2[3],
      M1[1]*M2[2] + M1[3]*M2[3],
      M1[0]*M2[4] + M1[2]*M2[5] + M1[4],
      M1[1]*M2[4] + M1[3]*M2[5] + M1[5]
    ];
  }
  function svgApply(M, x, y) {
    return { x: M[0]*x + M[2]*y + M[4], y: M[1]*x + M[3]*y + M[5] };
  }
  function svgIsTranslateOrUniformScale(M) {
    return Math.abs(M[1]) < 1e-9
        && Math.abs(M[2]) < 1e-9
        && Math.abs(M[0] - M[3]) < 1e-9;
  }

  function parseSvgTransform(attr) {
    if (!attr) return SVG_IDENT_M.slice();
    let M = SVG_IDENT_M.slice();
    const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(\s*([^)]*)\)/g;
    let m;
    while ((m = re.exec(attr)) !== null) {
      const op = m[1];
      const nums = (m[2].match(SVG_NUM_RE) || []).map(parseFloat);
      let T = SVG_IDENT_M.slice();
      if (op === 'matrix' && nums.length >= 6) {
        T = nums.slice(0, 6);
      } else if (op === 'translate') {
        T = [1, 0, 0, 1, nums[0] || 0, nums[1] || 0];
      } else if (op === 'scale') {
        const sx = nums.length ? nums[0] : 1;
        const sy = nums.length > 1 ? nums[1] : sx;
        T = [sx, 0, 0, sy, 0, 0];
      } else if (op === 'rotate') {
        const a = (nums[0] || 0) * Math.PI / 180;
        const ca = Math.cos(a), sa = Math.sin(a);
        if (nums.length >= 3) {
          const cx = nums[1], cy = nums[2];
          T = svgMultiply(svgMultiply([1,0,0,1,cx,cy], [ca,sa,-sa,ca,0,0]),
                          [1,0,0,1,-cx,-cy]);
        } else {
          T = [ca, sa, -sa, ca, 0, 0];
        }
      } else if (op === 'skewX') {
        T = [1, 0, Math.tan((nums[0] || 0) * Math.PI / 180), 1, 0, 0];
      } else if (op === 'skewY') {
        T = [1, Math.tan((nums[0] || 0) * Math.PI / 180), 0, 1, 0, 0];
      }
      M = svgMultiply(M, T);
    }
    return M;
  }

  function ensurePaletteColor(value) {
    if (!value) return null;
    const v = String(value).trim();
    if (!v || v === 'none' || v === 'transparent') return null;
    const lower = v.toLowerCase();
    const existing = state.palette.find(function (c) {
      return c.value && String(c.value).toLowerCase() === lower;
    });
    if (existing) return existing.id;
    const id = uid('c');
    state.palette.push({ id: id, name: v, value: v });
    return id;
  }

  function readSvgShapeAttrs(el) {
    const inlineStyle = el.getAttribute('style') || '';
    const styleMap = {};
    inlineStyle.split(';').forEach(function (p) {
      const i = p.indexOf(':');
      if (i > 0) styleMap[p.slice(0, i).trim()] = p.slice(i + 1).trim();
    });
    const get = function (name) {
      return el.getAttribute(name) || styleMap[name] || null;
    };
    const sw = parseFloat(get('stroke-width'));
    return {
      fill:        get('fill'),
      stroke:      get('stroke'),
      strokeWidth: Number.isFinite(sw) ? sw : null
    };
  }

  function svgTransformSegment(s, M) {
    if (s.cmd === 'Z' || !s.endpoint) {
      return { cmd: s.cmd, controlPoints: [], endpoint: null };
    }
    const out = {
      cmd: s.cmd,
      controlPoints: s.controlPoints.map(function (cp) { return svgApply(M, cp.x, cp.y); }),
      endpoint: svgApply(M, s.endpoint.x, s.endpoint.y)
    };
    if (s.arcArgs) {
      // For uniform scale + translate, scale rx/ry by the scale factor;
      // rot/large/sweep stay as-is. Non-uniform / rotation transforms
      // distort arcs and would need a flatten-to-bezier pass — skipped
      // here, the arc just lands with original rx/ry which is wrong in
      // that case but rare for import flows.
      const scale = (Math.abs(M[1]) < 1e-9 && Math.abs(M[2]) < 1e-9
                     && Math.abs(M[0] - M[3]) < 1e-9) ? M[0] : 1;
      out.arcArgs = {
        rx: s.arcArgs.rx * scale,
        ry: s.arcArgs.ry * scale,
        rot: s.arcArgs.rot,
        large: s.arcArgs.large,
        sweep: s.arcArgs.sweep
      };
    }
    return out;
  }

  function convertSvgElement(el, M, inherited) {
    const tag = (el.tagName || '').toLowerCase();
    const attrs = readSvgShapeAttrs(el);
    const fill   = attrs.fill   != null ? attrs.fill   : inherited.fill;
    const stroke = attrs.stroke != null ? attrs.stroke : inherited.stroke;
    const widthN = attrs.strokeWidth != null ? attrs.strokeWidth : inherited.strokeWidth;
    const hasFill   = fill   && fill   !== 'none' && fill   !== 'transparent';
    const hasStroke = stroke && stroke !== 'none' && stroke !== 'transparent';
    // Use the fill color when present (the more visible role on a
    // closed shape); otherwise fall back to stroke for outline-only
    // shapes like <line>. Both get a palette entry regardless of
    // which one drives the resolved line.stroke ref.
    const colorValue = hasFill ? fill : (hasStroke ? stroke : null);
    const colorId    = ensurePaletteColor(colorValue);
    if (hasStroke && colorValue !== stroke) ensurePaletteColor(stroke);

    const uniform = svgIsTranslateOrUniformScale(M);
    const scale   = M[0]; // valid when uniform — same on both axes
    let line = null;

    if (tag === 'circle' && uniform) {
      const cx = parseFloat(el.getAttribute('cx')) || 0;
      const cy = parseFloat(el.getAttribute('cy')) || 0;
      const r  = parseFloat(el.getAttribute('r'))  || 0;
      const p = svgApply(M, cx, cy);
      line = { kind: 'circle', params: { cx: p.x, cy: p.y, r: r * scale } };
    } else if (tag === 'ellipse' && uniform) {
      const cx = parseFloat(el.getAttribute('cx')) || 0;
      const cy = parseFloat(el.getAttribute('cy')) || 0;
      const rx = parseFloat(el.getAttribute('rx')) || 0;
      const ry = parseFloat(el.getAttribute('ry')) || 0;
      const p = svgApply(M, cx, cy);
      line = { kind: 'ellipse', params: { cx: p.x, cy: p.y, rx: rx * scale, ry: ry * scale } };
    } else if (tag === 'rect' && uniform) {
      const x = parseFloat(el.getAttribute('x')) || 0;
      const y = parseFloat(el.getAttribute('y')) || 0;
      const w = parseFloat(el.getAttribute('width'))  || 0;
      const h = parseFloat(el.getAttribute('height')) || 0;
      const r = parseFloat(el.getAttribute('rx') || el.getAttribute('ry') || '0') || 0;
      const tl = svgApply(M, x, y);
      line = {
        kind: 'rect',
        params: { x: tl.x, y: tl.y, w: w * scale, h: h * scale, r: r * scale }
      };
    } else if (tag === 'path' || tag === 'circle' || tag === 'ellipse' || tag === 'rect') {
      // Non-uniform-transform fallback for primitives + every <path>.
      let d = el.getAttribute('d');
      if (!d) {
        if (tag === 'circle') {
          d = circlePathD(parseFloat(el.getAttribute('cx')) || 0,
                          parseFloat(el.getAttribute('cy')) || 0,
                          parseFloat(el.getAttribute('r'))  || 0);
        } else if (tag === 'ellipse') {
          d = ellipsePathD(parseFloat(el.getAttribute('cx')) || 0,
                           parseFloat(el.getAttribute('cy')) || 0,
                           parseFloat(el.getAttribute('rx')) || 0,
                           parseFloat(el.getAttribute('ry')) || 0);
        } else if (tag === 'rect') {
          d = rectPathD(parseFloat(el.getAttribute('x')) || 0,
                        parseFloat(el.getAttribute('y')) || 0,
                        parseFloat(el.getAttribute('width'))  || 0,
                        parseFloat(el.getAttribute('height')) || 0,
                        parseFloat(el.getAttribute('rx') || el.getAttribute('ry') || '0') || 0);
        }
      }
      const segments = parseSegments(d).map(function (s) { return svgTransformSegment(s, M); });
      if (!segments.length) return null;
      const points = segments.filter(function (s) { return s.endpoint; })
                              .map(function (s) { return { x: s.endpoint.x, y: s.endpoint.y }; });
      line = {
        kind: 'manual',
        segments: segments,
        points: points,
        closed: segments.some(function (s) { return s.cmd === 'Z'; })
      };
    } else if (tag === 'polygon' || tag === 'polyline') {
      const ptsStr = el.getAttribute('points') || '';
      const nums = (ptsStr.match(SVG_NUM_RE) || []).map(parseFloat);
      if (nums.length < 4) return null;
      const segments = [];
      const points = [];
      for (let i = 0; i + 1 < nums.length; i += 2) {
        const p = svgApply(M, nums[i], nums[i + 1]);
        segments.push({ cmd: i === 0 ? 'M' : 'L', controlPoints: [], endpoint: p });
        points.push(p);
      }
      const closed = (tag === 'polygon');
      if (closed) segments.push({ cmd: 'Z', controlPoints: [], endpoint: null });
      line = { kind: 'manual', segments: segments, points: points, closed: closed };
    } else if (tag === 'line') {
      const p1 = svgApply(M, parseFloat(el.getAttribute('x1')) || 0,
                              parseFloat(el.getAttribute('y1')) || 0);
      const p2 = svgApply(M, parseFloat(el.getAttribute('x2')) || 0,
                              parseFloat(el.getAttribute('y2')) || 0);
      line = {
        kind: 'manual',
        segments: [
          { cmd: 'M', controlPoints: [], endpoint: p1 },
          { cmd: 'L', controlPoints: [], endpoint: p2 }
        ],
        points: [p1, p2],
        closed: false
      };
    } else {
      return null;
    }

    line.smoothed = false;
    line.filled   = hasFill;
    line.stroke   = colorId;
    line.width    = widthN;
    return line;
  }

  function walkSvg(node, parentM, inheritedAttrs, visit) {
    const local = parseSvgTransform(node.getAttribute && node.getAttribute('transform'));
    const M = svgMultiply(parentM, local);
    const inherited = Object.assign({}, inheritedAttrs);
    if (node.getAttribute) {
      const a = readSvgShapeAttrs(node);
      if (a.fill        != null) inherited.fill        = a.fill;
      if (a.stroke      != null) inherited.stroke      = a.stroke;
      if (a.strokeWidth != null) inherited.strokeWidth = a.strokeWidth;
    }
    const tag = (node.tagName || '').toLowerCase();
    if (['path','rect','circle','ellipse','polygon','polyline','line'].indexOf(tag) !== -1) {
      visit(node, M, inherited);
      return;
    }
    Array.prototype.slice.call(node.children || []).forEach(function (child) {
      walkSvg(child, M, inherited, visit);
    });
  }

  // Parse a single SVG file and return its lines (master-ready
  // shape, no instance fields). Wrapped in a Promise so the
  // multi-file caller can await each file in turn.
  function parseSvgFileToLines(file) {
    return new Promise(function (resolve, reject) {
      if (!file) { resolve([]); return; }
      const reader = new FileReader();
      reader.onerror = function () { reject(new Error('Couldn\'t read file.')); };
      reader.onload  = function () {
        const text = String(reader.result || '');
        const doc  = new DOMParser().parseFromString(text, 'image/svg+xml');
        const root = doc.documentElement;
        if (!root || root.nodeName !== 'svg' || doc.getElementsByTagName('parsererror').length) {
          reject(new Error('Not a valid SVG.'));
          return;
        }
        const out = [];
        walkSvg(root, SVG_IDENT_M.slice(),
          { fill: '#000000', stroke: null, strokeWidth: null },
          function (el, M, inherited) {
            const line = convertSvgElement(el, M, inherited);
            if (line) out.push(line);
          });
        resolve(out);
      };
      reader.readAsText(file);
    });
  }

  async function importSvgFiles(fileList) {
    if (!fileList || !fileList.length) return;
    const all = [];
    for (let i = 0; i < fileList.length; i++) {
      const f = fileList[i];
      try {
        const lines = await parseSvgFileToLines(f);
        all.push.apply(all, lines);
      } catch (err) {
        alert('Skipped ' + f.name + ': ' + err.message);
      }
    }
    if (!all.length) {
      alert('No drawable elements found in the selected file(s).');
      return;
    }
    // When 2+ path-style shapes come in (no image kinds — those
    // can't be merged into a path), ask whether to combine them
    // into one object. Common case: a drawing exported as several
    // path files. Yes here skips the entire "import-then-merge"
    // dance and lands a single canonical master in every class
    // with zero divergence to reconcile.
    const pathRaws  = all.filter(function (r) { return r.kind !== 'image'; });
    const imageRaws = all.filter(function (r) { return r.kind === 'image'; });
    if (pathRaws.length >= 2) {
      const choice = await showChoiceDialog({
        title:   'SVG import',
        message: 'You\'re importing ' + pathRaws.length + ' paths' +
                 (imageRaws.length ? ' (+ ' + imageRaws.length + ' image' +
                   (imageRaws.length === 1 ? '' : 's') + ')' : '') +
                 '. Merge the paths into one object?',
        buttons: [
          { label: 'Cancel',     value: 'cancel' },
          { label: 'No, keep separate', value: 'no' },
          { label: 'Yes, merge', value: 'yes', className: 'ed-primary' }
        ]
      });
      if (choice === 'cancel' || choice === null) return;
      if (choice === 'yes') {
        const mergedRaw = mergeRawsIntoOne(pathRaws);
        finalizeSvgImport([mergedRaw].concat(imageRaws));
        return;
      }
    }
    finalizeSvgImport(all);
  }

  // Combine N parsed-raw lines into a single manual raw whose
  // segments are the concatenation of each input's visible d. Used
  // by the import-time merge prompt to land one canonical object
  // instead of N. Image-kind raws are excluded by the caller.
  function mergeRawsIntoOne(raws) {
    const combined = [];
    raws.forEach(function (r) {
      // Build a transient line so computeLineD gives us the visible
      // d, then parseSegments to get rich segments back (so arcs
      // survive). Doing it through computeLineD keeps every primitive
      // kind on the same path.
      const tmp = Object.assign({ d: '' }, r);
      computeLineD(tmp);
      const segs = parseSegments(tmp.d);
      for (let i = 0; i < segs.length; i++) combined.push(segs[i]);
    });
    const first = raws[0] || {};
    const points = combined.filter(function (s) { return s.endpoint; })
                           .map(function (s) { return { x: s.endpoint.x, y: s.endpoint.y }; });
    return {
      kind: 'manual',
      segments: combined,
      points: points,
      closed: combined.some(function (s) { return s.cmd === 'Z'; }),
      smoothed: false,
      filled:   !!first.filled,
      stroke:   first.stroke || null,
      width:    first.width != null ? first.width : null,
      linejoin: first.linejoin || null
    };
  }

  // Drop the imported shapes into the currently-active group, and
  // into a same-named counterpart in every other class — masters are
  // site-wide so an imported object naturally belongs to every
  // class's page. Each class gets its own instance row (own line id,
  // own positionOffset starting at 0/0) pointing at the shared
  // masterId. After import, every imported line in the CURRENT class
  // is selected, ready for an immediate "Merge into one" if the
  // drawing arrived as several files.
  function finalizeSvgImport(importedLines) {
    // Active group when set, else first group, else fall through to
    // the "Imported" group that ensureGroupInAllClasses will mint.
    const activeGroup = state.groups.find(function (g) { return g.id === state.activeGroupId; })
                     || state.groups[0];
    const targetName  = activeGroup ? activeGroup.name : 'Imported';
    // Make sure every class has a group with this name; create
    // empties where missing so each class's instance has somewhere
    // to land.
    ensureGroupInAllClasses(targetName);

    const currentClassLineIds = [];
    importedLines.forEach(function (raw) {
      // Mint the master once — same id used by every per-class instance.
      const mid = 'm-' + Math.random().toString(36).slice(2, 10);
      const m = { id: mid, scope: {} };
      MASTER_VISUAL_KEYS.forEach(function (k) {
        if (raw[k] !== undefined && raw[k] !== null) {
          m[k] = (typeof raw[k] === 'object') ? JSON.parse(JSON.stringify(raw[k])) : raw[k];
        }
      });
      if (!m.name) m.name = nextDefaultName();
      state.masters.push(m);

      state.pageConfig.useClasses.forEach(function (cid) {
        const bucket = state.byClass[cid];
        if (!bucket) return;
        const g = bucket.groups.find(function (g) { return g.name === targetName; })
                  || bucket.groups[0];
        if (!g) return;
        const line = {
          id: uid('l'),
          masterId: mid,
          d: '',
          positionOffset: { dx: 0, dy: 0 },
          groupId: g.id,
          behaviors: [],
          overrides: {},
          name: m.name
        };
        MASTER_VISUAL_KEYS.forEach(function (k) {
          if (k === 'name') return;
          if (raw[k] !== undefined && raw[k] !== null) {
            line[k] = (typeof raw[k] === 'object') ? JSON.parse(JSON.stringify(raw[k])) : raw[k];
          }
        });
        computeLineD(line);
        bucket.lines.push(line);
        if (cid === state.classId) currentClassLineIds.push(line.id);
      });
    });

    // Select all just-imported lines in the current class so the user
    // can hit "Merge into one" right away when the drawing arrived as
    // several files.
    state.selectedIds  = currentClassLineIds;
    state.openGroupIds = state.openGroupIds || {};
    const ag = state.groups.find(function (g) { return g.name === targetName; });
    if (ag) {
      state.activeGroupId = ag.id;
      state.openGroupIds[ag.id] = true;
    }
    state.dirty = true;
    snapshot();
    renderAll();
  }

  // Make sure every class has a group with the given name. Creates
  // empty same-named groups where missing. Used by the SVG import
  // flow and by addGroup so a new group fans out across classes.
  function ensureGroupInAllClasses(name) {
    if (!name) return;
    state.pageConfig.useClasses.forEach(function (cid) {
      const bucket = state.byClass[cid];
      if (!bucket || !Array.isArray(bucket.groups)) return;
      if (bucket.groups.find(function (g) { return g.name === name; })) return;
      bucket.groups.push({
        id: uid('g'),
        name: name,
        trigger: null,
        behaviorTemplateObjectId: null, // v0.8.219
        defaults: {}                    // v0.8.226: behavior fallbacks removed
      });
    });
  }

  /**
   * Merge every currently-selected line into a single new master +
   * one instance in the current class. The merged line is
   * kind: 'manual' with the union of all selected lines' visible
   * segments (parsed from each line.d, so primitives + arcs survive).
   * Visual stroke / width / filled / linejoin inherit from the FIRST
   * selected line — the user can reset any of those after.
   *
   * Site-wide effect: deleting the source lines cascades through
   * their masters, which removes any instances of those masters in
   * other classes too. Re-clone if you need the merge mirrored
   * elsewhere. One snapshot for the whole op.
   */
  async function mergeSelectedIntoOne() {
    const ids = state.selectedIds.slice();
    if (ids.length < 2) return;
    const srcLines = ids
      .map(function (id) { return state.lines.find(function (l) { return l.id === id; }); })
      .filter(Boolean);
    if (srcLines.length < 2) return;

    const combinedSegments = [];
    srcLines.forEach(function (l) {
      const segs = parseSegments(l.d);
      for (let i = 0; i < segs.length; i++) combinedSegments.push(segs[i]);
    });
    if (!combinedSegments.length) {
      alert('Selected objects have no path data to merge.');
      return;
    }

    const first = srcLines[0];
    const firstGroup = state.groups.find(function (g) { return g.id === first.groupId; });
    const targetGroupName = firstGroup ? firstGroup.name : null;
    const mergedName = first.name || nextDefaultName();
    const masterIds = srcLines.map(function (l) { return l.masterId; }).filter(Boolean);

    // Divergence check: do any OTHER classes hold a different
    // version of the objects being merged? If yes, ask before
    // overwriting their state; if no, silent fan-out is safe.
    let scope = 'all';
    const divergence = analyzeMergeDivergence(masterIds);
    const divergedClasses = Object.keys(divergence).filter(function (cid) {
      return divergence[cid].diverged > 0 || divergence[cid].missing > 0;
    });
    if (divergedClasses.length > 0) {
      const labelOf = function (cid) {
        const c = state.classes.find(function (x) { return x.id === cid; });
        return c ? c.name : cid;
      };
      const escHtml = function (s) {
        const d = document.createElement('div');
        d.textContent = String(s);
        return d.innerHTML;
      };
      const items = divergedClasses.map(function (cid) {
        const d = divergence[cid];
        const bits = [];
        if (d.diverged) bits.push(d.diverged + ' with local changes');
        if (d.missing)  bits.push(d.missing + ' not present');
        return '<li><strong>' + escHtml(labelOf(cid)) + '</strong>: ' + bits.join(', ') + '</li>';
      });
      const msg = '<p>Some classes hold a different version of the objects you\'re merging:</p>' +
                  '<ul>' + items.join('') + '</ul>' +
                  '<p>Apply the merge there too, overwriting their differences?</p>';
      const choice = await showChoiceDialog({
        title:   'Merge — divergence detected',
        message: msg,
        html:    true,
        // Primary button picks by state.mode — matches the user's
        // current intent. They can still pick the other path.
        buttons: [
          { label: 'Cancel',             value: null },
          { label: 'Current class only', value: 'current',
            className: modeIsAll() ? '' : 'ed-primary' },
          { label: 'Apply everywhere',   value: 'all',
            className: modeIsAll() ? 'ed-primary' : '' }
        ]
      });
      if (!choice) return;
      scope = choice;
    }

    // Helpers shared by both scopes.
    const cloneSegment = function (s) {
      return {
        cmd: s.cmd,
        controlPoints: (s.controlPoints || []).map(function (cp) { return { x: cp.x, y: cp.y }; }),
        endpoint: s.endpoint ? { x: s.endpoint.x, y: s.endpoint.y } : null,
        arcArgs: s.arcArgs ? Object.assign({}, s.arcArgs) : undefined
      };
    };
    const masterSegments = combinedSegments.map(cloneSegment);
    const masterPoints = masterSegments
      .filter(function (s) { return s.endpoint; })
      .map(function (s) { return { x: s.endpoint.x, y: s.endpoint.y }; });
    const masterClosed = masterSegments.some(function (s) { return s.cmd === 'Z'; });
    const targetMasterIds = new Set();
    srcLines.forEach(function (l) { if (l.masterId) targetMasterIds.add(l.masterId); });
    const mid = 'm-' + Math.random().toString(36).slice(2, 10);
    const buildInstance = function (groupId) {
      const line = {
        id: uid('l'),
        masterId: mid,
        kind: 'manual',
        segments: masterSegments.map(cloneSegment),
        points: masterPoints.map(function (p) { return { x: p.x, y: p.y }; }),
        closed: masterClosed,
        smoothed: false,
        filled:   !!first.filled,
        stroke:   first.stroke || null,
        width:    first.width != null ? first.width : null,
        linejoin: first.linejoin || null,
        d: '',
        positionOffset: { dx: 0, dy: 0 },
        groupId: groupId,
        behaviors: [],
        overrides: {},
        name: mergedName
      };
      computeLineD(line);
      return line;
    };

    if (scope === 'all') {
      // Site-wide: drop originals + their masters, fan out merged
      // instance into every class.
      state.pageConfig.useClasses.forEach(function (cid) {
        const bucket = state.byClass[cid];
        if (!bucket || !Array.isArray(bucket.lines)) return;
        bucket.lines = bucket.lines.filter(function (l) {
          return !(l.masterId && targetMasterIds.has(l.masterId));
        });
      });
      state.masters = state.masters.filter(function (m) {
        return !targetMasterIds.has(m.id);
      });
      if (targetGroupName) ensureGroupInAllClasses(targetGroupName);
      const masterRec = {
        id: mid, scope: {}, kind: 'manual',
        segments: masterSegments, points: masterPoints, closed: masterClosed,
        smoothed: false, filled: !!first.filled,
        stroke: first.stroke || null,
        width:  first.width != null ? first.width : null,
        linejoin: first.linejoin || null,
        name: mergedName
      };
      computeLineD(masterRec);
      state.masters.push(masterRec);
      let currentClassLineId = null;
      state.pageConfig.useClasses.forEach(function (cid) {
        const bucket = state.byClass[cid];
        if (!bucket) return;
        let groupId = null;
        if (targetGroupName) {
          const g = bucket.groups.find(function (g) { return g.name === targetGroupName; });
          if (g) groupId = g.id;
        }
        if (!groupId && bucket.groups[0]) groupId = bucket.groups[0].id;
        const line = buildInstance(groupId);
        bucket.lines.push(line);
        if (cid === state.classId) currentClassLineId = line.id;
      });
      if (currentClassLineId) selectOnly(currentClassLineId);
    } else {
      // Current class only: drop originals from THIS class, keep the
      // old masters (other classes still reference them), add the
      // new merged master + one instance here. Other classes are
      // untouched — their diverged state survives.
      state.lines = state.lines.filter(function (l) {
        return !(l.masterId && targetMasterIds.has(l.masterId));
      });
      const masterRec = {
        id: mid, scope: {}, kind: 'manual',
        segments: masterSegments, points: masterPoints, closed: masterClosed,
        smoothed: false, filled: !!first.filled,
        stroke: first.stroke || null,
        width:  first.width != null ? first.width : null,
        linejoin: first.linejoin || null,
        name: mergedName
      };
      computeLineD(masterRec);
      state.masters.push(masterRec);
      let groupId = null;
      if (targetGroupName) {
        const g = state.groups.find(function (g) { return g.name === targetGroupName; });
        if (g) groupId = g.id;
      }
      if (!groupId && state.groups[0]) groupId = state.groups[0].id;
      const line = buildInstance(groupId);
      state.lines.push(line);
      selectOnly(line.id);
    }
    state.dirty = true;
    snapshot();
    renderAll();
  }

  // Per-class summary of how OTHER classes hold the masters being
  // merged. `diverged` = an instance exists with a non-zero
  // positionOffset, any override key, or hidden=true. `missing` =
  // no instance at all for that master in that class.
  function analyzeMergeDivergence(masterIds) {
    const result = {};
    state.pageConfig.useClasses.forEach(function (cid) {
      if (cid === state.classId) return;
      const bucket = state.byClass[cid];
      if (!bucket || !Array.isArray(bucket.lines)) return;
      let diverged = 0;
      let missing  = 0;
      masterIds.forEach(function (mid) {
        const inst = bucket.lines.find(function (l) { return l.masterId === mid; });
        if (!inst) { missing++; return; }
        const offDx = (inst.positionOffset && inst.positionOffset.dx) || 0;
        const offDy = (inst.positionOffset && inst.positionOffset.dy) || 0;
        const hasOverrides = inst.overrides && Object.keys(inst.overrides).length > 0;
        if (offDx !== 0 || offDy !== 0 || hasOverrides || inst.hidden) diverged++;
      });
      result[cid] = { diverged: diverged, missing: missing, total: masterIds.length };
    });
    return result;
  }

  function segmentsToD(segments) {
    return segments.map(function (s) {
      if (s.cmd === 'Z' || !s.endpoint) return 'Z';
      if (s.cmd === 'A' && s.arcArgs) {
        const a = s.arcArgs;
        return 'A ' + fmt(a.rx) + ' ' + fmt(a.ry) + ' ' + fmt(a.rot) + ' '
                    + (a.large ? 1 : 0) + ' ' + (a.sweep ? 1 : 0) + ' '
                    + fmt(s.endpoint.x) + ' ' + fmt(s.endpoint.y);
      }
      const cps = s.controlPoints
        .map(function (cp) { return fmt(cp.x) + ' ' + fmt(cp.y); })
        .join(' ');
      const ep = fmt(s.endpoint.x) + ' ' + fmt(s.endpoint.y);
      return s.cmd + ' ' + (cps ? cps + ' ' : '') + ep;
    }).join(' ');
  }

  // Indices into segments[] for segments that have an endpoint — i.e.
  // every segment except Z. Used to map handle index ↔ segment index.
  function pointSegmentIndices(segments) {
    const out = [];
    for (let i = 0; i < segments.length; i++) {
      if (segments[i].endpoint) out.push(i);
    }
    return out;
  }

  /**
   * Auto-upgrade any line that lacks `points` (sample seed data, SVG
   * imports). Parses the existing `d` into rich segments so curve
   * types survive subsequent handle edits; populates `points` as the
   * flat endpoint list the handle UI expects.
   */
  function migrateLines() {
    state.lines.forEach(function (line) {
      if (!Array.isArray(line.points)) {
        line.kind     = line.kind || 'manual';
        line.segments = parseSegments(line.d);
        line.points   = line.segments
          .filter(function (s) { return s.endpoint; })
          .map(function (s) { return { x: s.endpoint.x, y: s.endpoint.y }; });
        line.smoothed = (line.smoothed !== undefined) ? line.smoothed : false;
        line.closed   = (line.closed   !== undefined) ? line.closed
                       : line.segments.some(function (s) { return s.cmd === 'Z'; });
      }
    });
  }
  migrateLines();

  /**
   * Regenerate `d` from the line's authored form.
   *
   * For "manual" lines (legacy / imported), we have a rich `segments`
   * array that preserves each command's type and control points, so
   * the regenerator emits the same curve types as the original — only
   * the endpoints reflect any edits the user has made.
   *
   * For tool-authored lines (freehand, line, chain, freehandClosed),
   * `points` is the source of truth and we generate from scratch with
   * kind-appropriate smoothing + optional Z closure.
   */
  /**
   * Recompute the line's d from its current source values, AND
   * (scope-permitting) push shape changes back to the master + every
   * sibling instance. Used by callers that mutate line.params /
   * line.points / line.segments directly (handle drags etc.) and
   * want the change to take effect across classes the way the user
   * expects from a master edit.
   *
   * Note this is the v0.3.5 successor to the old sync function but
   * far simpler — scope tells it exactly which keys are canonical
   * (propagate) vs local (don't). It does NOT walk override maps
   * looking for per-key local toggles; there are none under v7.
   */
  function regenerateLineD(line) {
    computeLineD(line);
    propagateLineToMaster(line);
  }

  function propagateLineToMaster(line) {
    if (!line || !line.masterId) return;
    const m = state.masters.find(function (x) { return x.id === line.masterId; });
    if (!m) return;
    const offX = (line.positionOffset && line.positionOffset.dx) || 0;
    const offY = (line.positionOffset && line.positionOffset.dy) || 0;
    const SCALAR_KEYS = ['kind', 'smoothed', 'closed', 'filled'];
    const POINT_KEYS  = ['points', 'segments'];

    // Push canonical-form values onto the master, only for keys whose
    // scope is canonical. Skip the rest — they're either always per-
    // class (position) or explicitly opted into local scope.
    SCALAR_KEYS.forEach(function (k) {
      if (line[k] === undefined) return;
      if (isLocal(m, k)) return;
      m[k] = line[k];
    });
    POINT_KEYS.forEach(function (k) {
      if (line[k] === undefined) return;
      if (isLocal(m, k)) return;
      if (k === 'points' && Array.isArray(line.points)) {
        m.points = line.points.map(function (p) {
          return { x: (p.x || 0) - offX, y: (p.y || 0) - offY };
        });
      } else if (k === 'segments' && Array.isArray(line.segments)) {
        m.segments = line.segments.map(function (s) {
          return {
            cmd: s.cmd,
            controlPoints: (s.controlPoints || []).map(function (cp) {
              return { x: (cp.x || 0) - offX, y: (cp.y || 0) - offY };
            }),
            endpoint: s.endpoint
              ? { x: (s.endpoint.x || 0) - offX, y: (s.endpoint.y || 0) - offY }
              : null
          };
        });
      }
    });
    if (line.params && typeof line.params === 'object') {
      if (!m.params || typeof m.params !== 'object') m.params = {};
      Object.keys(line.params).forEach(function (sk) {
        // Position sub-keys are always per-class via positionOffset
        // — they never write to master. Absorbed below.
        if (POSITION_PARAM_SUBKEYS.indexOf(sk) !== -1) return;
        if (isLocal(m, 'params.' + sk)) return;
        m.params[sk] = line.params[sk];
      });
      // Re-derive source line's positionOffset from the post-edit
      // visual coords vs the (unchanged) canonical master coords. This
      // keeps handle-drag-on-primitive-center as a per-class move
      // without touching siblings — matches selection-drag-translate
      // semantics.
      POSITION_PARAM_SUBKEYS.forEach(function (sk) {
        if (line.params[sk] === undefined) return;
        if (m.params[sk] === undefined) return;
        if (!line.positionOffset) line.positionOffset = { dx: 0, dy: 0 };
        const isXAxis = (sk === 'cx' || sk === 'x');
        const delta = line.params[sk] - m.params[sk];
        if (isXAxis) line.positionOffset.dx = delta;
        else         line.positionOffset.dy = delta;
      });
    }
    computeLineD(m);

    // Push the canonical master state back out to every other instance,
    // re-applying each one's positionOffset on the way.
    state.pageConfig.useClasses.forEach(function (cid) {
      const lines = (state.byClass[cid] && state.byClass[cid].lines) || [];
      lines.forEach(function (sib) {
        if (sib.masterId !== m.id) return;
        if (sib === line) return;
        const sibOffX = (sib.positionOffset && sib.positionOffset.dx) || 0;
        const sibOffY = (sib.positionOffset && sib.positionOffset.dy) || 0;
        SCALAR_KEYS.forEach(function (k) {
          if (m[k] === undefined) return;
          if (isLocal(m, k)) return;
          sib[k] = m[k];
        });
        POINT_KEYS.forEach(function (k) {
          if (m[k] === undefined) return;
          if (isLocal(m, k)) return;
          if (k === 'points' && Array.isArray(m.points)) {
            sib.points = m.points.map(function (p) {
              return { x: (p.x || 0) + sibOffX, y: (p.y || 0) + sibOffY };
            });
          } else if (k === 'segments' && Array.isArray(m.segments)) {
            sib.segments = m.segments.map(function (s) {
              return {
                cmd: s.cmd,
                controlPoints: (s.controlPoints || []).map(function (cp) {
                  return { x: (cp.x || 0) + sibOffX, y: (cp.y || 0) + sibOffY };
                }),
                endpoint: s.endpoint
                  ? { x: (s.endpoint.x || 0) + sibOffX, y: (s.endpoint.y || 0) + sibOffY }
                  : null
              };
            });
          }
        });
        if (m.params && typeof m.params === 'object') {
          if (!sib.params || typeof sib.params !== 'object') sib.params = {};
          Object.keys(m.params).forEach(function (sk) {
            if (isLocal(m, 'params.' + sk)) return;
            if (POSITION_PARAM_SUBKEYS.indexOf(sk) !== -1) {
              const isXAxis = (sk === 'cx' || sk === 'x');
              sib.params[sk] = m.params[sk] + (isXAxis ? sibOffX : sibOffY);
            } else {
              sib.params[sk] = m.params[sk];
            }
          });
        }
        computeLineD(sib);
      });
    });
  }

  function computeLineD(line) {
    // Geometric primitives generate `d` from their `params` table.
    if (PRIMITIVES[line.kind] && line.params) {
      line.d = PRIMITIVES[line.kind].generateD(line.params);
      return;
    }
    if (line.kind === 'manual' && Array.isArray(line.segments) && line.segments.length) {
      line.d = segmentsToD(line.segments);
      return;
    }
    if (!Array.isArray(line.points) || !line.points.length) return;
    if (line.kind === 'bezier') {
      // Auto-smooth curve through every anchor. Closed bezier loops
      // get a Z to seal back to the first point.
      line.d = bezierThroughPoints(line.points) + (line.closed ? ' Z' : '');
      return;
    }
    const smoothable = (line.kind === 'freehand' || line.kind === 'freehandClosed');
    const smooth = smoothable && !!line.smoothed;
    let d = pathFromPoints(line.points, smooth);
    if (line.closed) d += ' Z';
    line.d = d;
  }

  // (v0.3.5 removed: stripOffsetCanonical / applyOffsetCanonical /
  // syncLineGeometryToMaster / deepCopyIfNeeded — propagation now
  // happens at the call site via setVisualProp / setMasterScope.
  // regenerateLineD's sync hook is gone too; it just calls
  // computeLineD.)

  /**
   * v0.8.95: Translate an instance's visual geometry by (dx, dy) AND
   * bump its positionOffset by the same delta. The two stay in lock-
   * step: stored points/segments/params carry on-canvas coords (so
   * renderLines/handle picking/panel display are accurate), and
   * positionOffset is the per-class delta used by master-propagation
   * accounting (master_points = instance_points − positionOffset).
   *
   * This is the same logic as translateLine() but without the drag-
   * snapshot ceremony — useful for direct API moves: panel position
   * edits and duplicate displacement. Both previously bumped only
   * positionOffset without translating the geometry, which left the
   * object visually un-moved because the renderer draws from line.d
   * (built from the un-shifted points), not from positionOffset.
   */
  function shiftLineBy(line, dx, dy) {
    if (!Number.isFinite(dx)) dx = 0;
    if (!Number.isFinite(dy)) dy = 0;
    if (dx === 0 && dy === 0) return;
    if (!line.positionOffset) line.positionOffset = { dx: 0, dy: 0 };
    line.positionOffset.dx = (line.positionOffset.dx || 0) + dx;
    line.positionOffset.dy = (line.positionOffset.dy || 0) + dy;
    if (Array.isArray(line.points)) {
      line.points = line.points.map(function (p) {
        return { x: (p.x || 0) + dx, y: (p.y || 0) + dy };
      });
    }
    if (Array.isArray(line.segments)) {
      line.segments = line.segments.map(function (s) {
        return {
          cmd: s.cmd,
          controlPoints: (s.controlPoints || []).map(function (cp) {
            return { x: (cp.x || 0) + dx, y: (cp.y || 0) + dy };
          }),
          endpoint: s.endpoint
            ? { x: (s.endpoint.x || 0) + dx, y: (s.endpoint.y || 0) + dy }
            : null
        };
      });
    }
    if (line.params && typeof line.params === 'object') {
      ['cx', 'x'].forEach(function (k) {
        if (Number.isFinite(line.params[k])) line.params[k] += dx;
      });
      ['cy', 'y'].forEach(function (k) {
        if (Number.isFinite(line.params[k])) line.params[k] += dy;
      });
    }
    computeLineD(line);
  }

  /**
   * v0.8.99: Translate every selected line by (dx, dy). In ALL mode,
   * the same delta also rides along to every sibling-class instance
   * of the affected masters (matches drag-translate's ALL-mode fan-
   * out). Used by keyboard-arrow nudge and the bbox move grip.
   *
   * `opts.snapshot` controls whether to push a history entry. Pass
   * false for incremental drag steps (the drag's pointerup commits
   * one snapshot at the end) and true for one-shot nudges.
   */
  function nudgeSelectionBy(dx, dy, opts) {
    if (!state.selectedIds.length) return;
    if (!dx && !dy) return;
    opts = opts || {};
    const affectedMasterIds = {};
    state.selectedIds.forEach(function (id) {
      const line = state.lines.find(function (l) { return l.id === id; });
      if (!line) return;
      shiftLineBy(line, dx, dy);
      if (line.masterId) affectedMasterIds[line.masterId] = true;
    });
    if (modeIsAll()) {
      Object.keys(affectedMasterIds).forEach(function (mid) {
        forSiblingsOf(mid, function (sib) { shiftLineBy(sib, dx, dy); });
      });
    }
    state.dirty = true;
    if (opts.snapshot !== false) {
      renderLines();
      renderHandles();
      renderLabels();
      renderSelectionPanel({ suppressScroll: true });
      snapshot();
    }
  }

  /**
   * v0.8.96: Read the current bbox top-left of a line's authored
   * geometry. Used by the non-primitive Position X/Y edit handlers to
   * recompute the delta against the live shape — the panel-build-time
   * minX/minY captured in the closure becomes stale on each keystroke
   * once shiftLineBy has moved the geometry. Returns null if the line
   * has no finite-coord points or segments.
   */
  function currentBboxTopLeft(line) {
    let minX = Infinity, minY = Infinity;
    if (Array.isArray(line.points) && line.points.length) {
      line.points.forEach(function (p) {
        const x = +p.x, y = +p.y;
        if (Number.isFinite(x) && x < minX) minX = x;
        if (Number.isFinite(y) && y < minY) minY = y;
      });
    } else if (Array.isArray(line.segments) && line.segments.length) {
      line.segments.forEach(function (s) {
        if (s.endpoint) {
          const x = +s.endpoint.x, y = +s.endpoint.y;
          if (Number.isFinite(x) && x < minX) minX = x;
          if (Number.isFinite(y) && y < minY) minY = y;
        }
      });
    }
    if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;
    return { minX: minX, minY: minY };
  }

  // ────────────────────────────────────────────────────────────────
  // v0.8.101: Instance ↔ master relationships — visual identity for
  // the "two objects share a master" case so the user can spot
  // linked instances at a glance in the sidebar AND on the canvas.
  //
  // Vocabulary recap:
  //   - "linked" = master is shared by ≥2 instances (counting across
  //     every useClass — same masterId in any bucket counts).
  //   - badge = short alphabetic identifier per linked master, A→Z,
  //     AA→AZ, BA→… (Excel-column scheme), assigned by master order
  //     in state.masters so it stays stable across renders/sessions.
  //   - color = hue hashed from masterId — same master always paints
  //     the same color regardless of which class you're viewing.
  // ────────────────────────────────────────────────────────────────

  function letterBadge(idx) {
    if (idx < 0) return '';
    let s = '';
    let n = idx;
    do {
      s = String.fromCharCode(65 + (n % 26)) + s;
      n = Math.floor(n / 26) - 1;
    } while (n >= 0);
    return s;
  }

  function masterHashHue(masterId) {
    if (!masterId) return 0;
    let h = 0;
    for (let i = 0; i < masterId.length; i++) {
      h = ((h * 31) + masterId.charCodeAt(i)) | 0;
    }
    return Math.abs(h) % 360;
  }

  // Walks every useClass, counts instances per masterId, then assigns
  // a badge letter only to masters with ≥2 instances. Returns
  // { masterId: { badge, count, hue } } for every master (count
  // included even for singletons so callers can check linkage).
  // Cheap enough to call per render — total work is O(sum of all
  // lines across classes).
  function computeMasterRelationships() {
    const counts = {};
    (state.pageConfig.useClasses || []).forEach(function (cid) {
      const bucket = state.byClass[cid];
      if (!bucket || !Array.isArray(bucket.lines)) return;
      bucket.lines.forEach(function (l) {
        if (!l.masterId) return;
        counts[l.masterId] = (counts[l.masterId] || 0) + 1;
      });
    });
    const map = {};
    let badgeIdx = 0;
    (state.masters || []).forEach(function (m) {
      const c = counts[m.id] || 0;
      // Hue assignment: badge-bearing masters use a golden-angle walk
      // (137.508°) starting from a fixed offset — this guarantees
      // maximum perceptual separation between consecutive letters
      // (A/B/C never look alike), which the previous hash-mod-360
      // could not promise. Singletons keep the hash-based hue but it
      // is unused (no badge is rendered for them).
      const entry = { badge: null, count: c, hue: masterHashHue(m.id) };
      if (c >= 2) {
        entry.badge = letterBadge(badgeIdx);
        entry.hue = Math.round((25 + badgeIdx * 137.508) % 360);
        badgeIdx += 1;
      }
      map[m.id] = entry;
    });
    return map;
  }

  // Short, readable master ID for canvas labels. Full IDs look like
  // "m-abc12345" — the "m-" prefix is noise, last 5 chars are enough
  // to disambiguate visually.
  function shortMasterId(masterId) {
    if (!masterId) return '';
    return masterId.replace(/^m-/, '').slice(-5);
  }

  /**
   * Build an HTML link badge for sidebar / panel use. Returns null
   * for non-linked instances (no badge needed). The badge is a span
   * with a hsl background, white letter inside, and a tooltip
   * showing "<master.name> · N linked".
   */
  function buildLinkBadgeHTML(masterId, rel, inClassCount) {
    if (!masterId) return null;
    const entry = rel ? rel[masterId] : null;
    // v0.8.107: gate the colored badge by in-class count (matches the
    // master chip's "siblings" semantic). Cross-class siblings give a
    // global entry.badge but if there's only one instance HERE, the
    // letter is misleading — render a neutral empty circle instead.
    // The placeholder keeps the column visually aligned ("nothing to
    // say here" rather than empty space jumping rows around).
    const linked = entry && entry.badge && (inClassCount == null || inClassCount >= 2);
    const span = document.createElement('span');
    span.className = 'ed-link-badge' + (linked ? '' : ' is-empty');
    if (linked) {
      span.textContent = entry.badge;
      span.style.background = 'hsl(' + entry.hue + ', 70%, 32%)';
      const master = state.masters.find(function (m) { return m.id === masterId; });
      span.title = (master && master.name ? master.name : masterId) +
                   ' · ' + (inClassCount != null ? inClassCount : entry.count) + ' linked';
    } else {
      span.textContent = '';
      // Neutral mid-gray, no letter — reads as "no relationship to show".
      span.style.background = 'transparent';
      span.title = 'No linked siblings in this class';
    }
    return span;
  }

  /**
   * Select every instance of `masterId` in the current class.
   * Powers the "click chip → highlight siblings" action in the line
   * panel header.
   */
  function selectSiblingsOfMaster(masterId) {
    if (!masterId) return;
    const ids = state.lines
      .filter(function (l) { return l.masterId === masterId; })
      .map(function (l) { return l.id; });
    if (!ids.length) return;
    state.selectedIds = ids;
    updateSelectAllButton();
    renderGroupsList();
    renderLines();
    renderSelectionPanel();
  }

  /**
   * Apply a translation (dx, dy) to a line's authored form.
   *
   * Drag-translate is structurally per-class — the user is placing
   * this object somewhere in this class, not reshaping it for
   * everyone. The drag is recorded as positionOffset on the
   * instance; line.params / points / segments are recomputed to
   * their visual (offset-applied) form so handles + panel display
   * stay accurate. The master and sibling instances are not
   * touched. (Handle drags + panel edits route through
   * regenerateLineD → propagateLineToMaster, which DOES propagate.)
   *
   *   - Geometric primitives shift only their position keys (cx/cy or
   *     x/y) so the whole shape moves rigidly without distortion.
   *   - Manual lines shift every point AND every segment control point
   *     so authored curves keep their shape.
   *   - Everything else just shifts points.
   */
  function translateLine(line, origPoints, origSegments, origParams, origOverrides, origOffset, dx, dy) {
    if (!line.overrides) line.overrides = {};
    if (!line.positionOffset) line.positionOffset = { dx: 0, dy: 0 };
    // v0.3.0+: drag-translate is structurally per-class. The new
    // position is recorded as positionOffset on the instance;
    // line.params / points / segments are recomputed below from the
    // original snapshot + drag delta (so they stay in visual /
    // offset-applied form for handle picking + panel display). The
    // master is not touched.
    const baseDx = (origOffset && Number.isFinite(origOffset.dx)) ? origOffset.dx : 0;
    const baseDy = (origOffset && Number.isFinite(origOffset.dy)) ? origOffset.dy : 0;
    line.positionOffset.dx = baseDx + dx;
    line.positionOffset.dy = baseDy + dy;
    if (PRIMITIVES[line.kind] && origParams) {
      const keys = PRIMITIVES[line.kind].positionKeys;
      line.params = Object.assign({}, origParams);
      keys.forEach(function (k, i) {
        if (k in origParams) {
          line.params[k] = origParams[k] + (i === 0 ? dx : dy);
        }
      });
    } else if (origPoints) {
      line.points = origPoints.map(function (p) { return { x: p.x + dx, y: p.y + dy }; });
      if (line.kind === 'manual' && Array.isArray(origSegments)) {
        line.segments = origSegments.map(function (s) {
          return {
            cmd: s.cmd,
            controlPoints: s.controlPoints.map(function (cp) {
              return { x: cp.x + dx, y: cp.y + dy };
            }),
            endpoint: s.endpoint ? { x: s.endpoint.x + dx, y: s.endpoint.y + dy } : null
          };
        });
      }
    }
    // v6+ note: rotateOriginX/Y are NOT translated with the drag.
    // The runtime composes the rotation pivot with positionOffset via
    // the SVG transform (translate after rotate), so a canonical
    // pivot value naturally follows the shape's offset position
    // without manual bookkeeping.
    // computeLineD instead of regenerateLineD: drag-translate is
    // purely an instance-level positionOffset change, NOT a master
    // edit, so it must not trigger the master-propagation sync.
    computeLineD(line);
  }

  /**
   * Build a cubic-Bezier path that passes smoothly through a list of
   * anchor points (Catmull-Rom → Bezier conversion with tension 1).
   *
   * For each interior pair (P1, P2), the cubic's control points are:
   *   cp1 = P1 + (P2 − P0) / 6
   *   cp2 = P2 − (P3 − P1) / 6
   * where P0 and P3 are the neighbors on either side. Endpoints reuse
   * themselves so the curve doesn't "fly out" past the first or last
   * anchor. The result feels like the hand-authored wavy seed lines —
   * smooth curves through every click.
   */
  /**
   * Return the auto-smoothed Bezier as a segments array — same
   * Catmull-Rom-to-Bezier math as bezierThroughPoints but emitting
   * the structured segment form instead of a `d` string. Used by
   * the CP-handle renderer to surface bezier-kind curves' control
   * points without storing them yet; on the user's first CP drag
   * the line gets promoted to `kind: 'manual'` with these segments
   * locked in.
   */
  function bezierSegmentsFromPoints(points, closed) {
    if (!points.length) return [];
    const segments = [{
      cmd: 'M', controlPoints: [],
      endpoint: { x: points[0].x, y: points[0].y }
    }];
    if (points.length === 1) return segments;
    if (points.length === 2) {
      segments.push({
        cmd: 'L', controlPoints: [],
        endpoint: { x: points[1].x, y: points[1].y }
      });
      if (closed) segments.push({ cmd: 'Z', controlPoints: [], endpoint: null });
      return segments;
    }
    for (let i = 0; i < points.length - 1; i++) {
      const p0 = points[i - 1] || points[i];
      const p1 = points[i];
      const p2 = points[i + 1];
      const p3 = points[i + 2] || points[i + 1];
      segments.push({
        cmd: 'C',
        controlPoints: [
          { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 },
          { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 }
        ],
        endpoint: { x: p2.x, y: p2.y }
      });
    }
    if (closed) segments.push({ cmd: 'Z', controlPoints: [], endpoint: null });
    return segments;
  }

  function bezierThroughPoints(points) {
    if (!points.length) return '';
    if (points.length === 1) return 'M ' + fmt(points[0].x) + ' ' + fmt(points[0].y);
    if (points.length === 2) {
      return 'M ' + fmt(points[0].x) + ' ' + fmt(points[0].y) +
             ' L ' + fmt(points[1].x) + ' ' + fmt(points[1].y);
    }
    let d = 'M ' + fmt(points[0].x) + ' ' + fmt(points[0].y);
    for (let i = 0; i < points.length - 1; i++) {
      const p0 = points[i - 1] || points[i];
      const p1 = points[i];
      const p2 = points[i + 1];
      const p3 = points[i + 2] || points[i + 1];
      const cp1 = { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 };
      const cp2 = { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 };
      d += ' C ' + fmt(cp1.x) + ' ' + fmt(cp1.y) +
           ' '  + fmt(cp2.x) + ' ' + fmt(cp2.y) +
           ' '  + fmt(p2.x)  + ' ' + fmt(p2.y);
    }
    return d;
  }

  // ── Geometric primitives ──────────────────────────────────────────
  // Each primitive is a self-contained entry in PRIMITIVES that knows:
  //   paramsFromDrag (start, end)  — initial params from a click+drag
  //   generateD      (params)      — SVG path "d" string for these params
  //   handles        (params)      — list of { id, x, y } handle positions
  //   updateFromHandle(params,id,p)— new params when a handle is moved
  //   paramFields                  — [[key, label], …] for the line panel
  //   positionKeys                 — which keys move when translating
  //                                  (so drag-to-move shifts the whole shape)
  //   labelPosition  (params)      — where to place the name label

  function circlePathD(cx, cy, r) {
    // Two half-arcs to make a full circle as a path (SVG paths don't
    // have a native circle command, so we approximate with arc-tos).
    return 'M ' + fmt(cx - r) + ' ' + fmt(cy) +
           ' A ' + fmt(r) + ' ' + fmt(r) + ' 0 1 0 ' + fmt(cx + r) + ' ' + fmt(cy) +
           ' A ' + fmt(r) + ' ' + fmt(r) + ' 0 1 0 ' + fmt(cx - r) + ' ' + fmt(cy) + ' Z';
  }
  function ellipsePathD(cx, cy, rx, ry) {
    return 'M ' + fmt(cx - rx) + ' ' + fmt(cy) +
           ' A ' + fmt(rx) + ' ' + fmt(ry) + ' 0 1 0 ' + fmt(cx + rx) + ' ' + fmt(cy) +
           ' A ' + fmt(rx) + ' ' + fmt(ry) + ' 0 1 0 ' + fmt(cx - rx) + ' ' + fmt(cy) + ' Z';
  }
  function rectPathD(x, y, w, h, r) {
    if (!r || r <= 0) {
      return 'M ' + fmt(x) + ' ' + fmt(y) +
             ' L ' + fmt(x + w) + ' ' + fmt(y) +
             ' L ' + fmt(x + w) + ' ' + fmt(y + h) +
             ' L ' + fmt(x)     + ' ' + fmt(y + h) + ' Z';
    }
    // Rounded rectangle. Clamp the radius to half of the smaller side
    // so it can't exceed the rect's geometry.
    r = Math.min(r, w / 2, h / 2);
    return 'M ' + fmt(x + r)     + ' ' + fmt(y)         +
           ' L ' + fmt(x + w - r) + ' ' + fmt(y)         +
           ' A ' + fmt(r) + ' ' + fmt(r) + ' 0 0 1 ' + fmt(x + w)     + ' ' + fmt(y + r) +
           ' L ' + fmt(x + w)     + ' ' + fmt(y + h - r) +
           ' A ' + fmt(r) + ' ' + fmt(r) + ' 0 0 1 ' + fmt(x + w - r) + ' ' + fmt(y + h) +
           ' L ' + fmt(x + r)     + ' ' + fmt(y + h)     +
           ' A ' + fmt(r) + ' ' + fmt(r) + ' 0 0 1 ' + fmt(x)         + ' ' + fmt(y + h - r) +
           ' L ' + fmt(x)         + ' ' + fmt(y + r)     +
           ' A ' + fmt(r) + ' ' + fmt(r) + ' 0 0 1 ' + fmt(x + r)     + ' ' + fmt(y)         +
           ' Z';
  }
  function polygonPathD(cx, cy, r, sides, angleDeg) {
    sides = Math.max(3, Math.round(sides));
    let d = '';
    for (let i = 0; i < sides; i++) {
      // Start at top (angle 0 = pointing up).
      const theta = ((i * 360 / sides) + angleDeg - 90) * Math.PI / 180;
      const x = cx + r * Math.cos(theta);
      const y = cy + r * Math.sin(theta);
      d += (i === 0 ? 'M ' : ' L ') + fmt(x) + ' ' + fmt(y);
    }
    return d + ' Z';
  }
  function starPathD(cx, cy, rOuter, rInner, points, angleDeg) {
    points = Math.max(2, Math.round(points));
    let d = '';
    for (let i = 0; i < points * 2; i++) {
      const r = (i % 2 === 0) ? rOuter : rInner;
      const theta = ((i * 180 / points) + angleDeg - 90) * Math.PI / 180;
      const x = cx + r * Math.cos(theta);
      const y = cy + r * Math.sin(theta);
      d += (i === 0 ? 'M ' : ' L ') + fmt(x) + ' ' + fmt(y);
    }
    return d + ' Z';
  }

  // (PRIMITIVES was here; hoisted above resolveInstanceJS in v0.3.3
  // so the init-time resolution can read it without TDZ.)

  /**
   * One factory builds the click-drag tool for every primitive. The
   * specifics (params from a drag, path d, etc.) live in PRIMITIVES;
   * the tool here just wires up the gesture and a preview path.
   */
  function makePrimitiveTool(kindId) {
    const PRIM = PRIMITIVES[kindId];
    return {
      label: PRIM.label,
      settings: function () { return []; },
      onPointerDown: function (pt) {
        this._start = pt;
        this._preview = null;
      },
      onPointerMove: function (pt) {
        if (!this._start) return;
        const params = PRIM.paramsFromDrag(this._start, pt);
        const d = PRIM.generateD(params);
        if (!this._preview) {
          this._preview = createPath('is-preview', d);
          previewG.appendChild(this._preview);
        } else {
          this._preview.setAttribute('d', d);
        }
      },
      onPointerUp: function (pt) {
        if (!this._start) return;
        const start = this._start;
        this._start = null;
        if (this._preview) { this._preview.remove(); this._preview = null; }
        const dx = pt.x - start.x, dy = pt.y - start.y;
        if (dx * dx + dy * dy < MIN_STROKE_LENGTH * MIN_STROKE_LENGTH) return;
        commitLine({
          kind:   kindId,
          params: PRIM.paramsFromDrag(start, pt),
          filled: true
        });
      },
      cancel: function () {
        if (this._preview) this._preview.remove();
        this._preview = null; this._start = null;
      }
    };
  }

  function pathFromPoints(points, smooth) {
    if (!points.length) return '';
    if (points.length === 1) return 'M ' + fmt(points[0].x) + ' ' + fmt(points[0].y);
    if (!smooth || points.length < 3) {
      let d = 'M ' + fmt(points[0].x) + ' ' + fmt(points[0].y);
      for (let i = 1; i < points.length; i++) d += ' L ' + fmt(points[i].x) + ' ' + fmt(points[i].y);
      return d;
    }
    // Smoothing: each input point is a quadratic control; curves run
    // between midpoints of consecutive control points so the line
    // passes smoothly through the captured stroke.
    let d = 'M ' + fmt(points[0].x) + ' ' + fmt(points[0].y);
    for (let i = 1; i < points.length - 1; i++) {
      const c = points[i];
      const n = points[i + 1];
      const mx = (c.x + n.x) / 2;
      const my = (c.y + n.y) / 2;
      d += ' Q ' + fmt(c.x) + ' ' + fmt(c.y) + ' ' + fmt(mx) + ' ' + fmt(my);
    }
    const last = points[points.length - 1];
    d += ' L ' + fmt(last.x) + ' ' + fmt(last.y);
    return d;
  }
  function fmt(n) { return Math.round(n * 100) / 100; }

  /**
   * Total arc-length of a polyline (sum of consecutive segment lengths).
   * Used as the "is this even a line?" gate for freehand strokes — a
   * pure click can still wobble a few px and produce a tiny path that
   * would otherwise commit as a near-invisible blob.
   */
  function pathLength(points) {
    let total = 0;
    for (let i = 1; i < points.length; i++) {
      const dx = points[i].x - points[i - 1].x;
      const dy = points[i].y - points[i - 1].y;
      total += Math.sqrt(dx * dx + dy * dy);
    }
    return total;
  }

  // Minimum total displacement before a stroke is allowed to commit.
  // ~10 viewBox units = ~10px at 100% zoom, easily clears the noise of
  // a misclick but doesn't get in the way of intentional short strokes.
  const MIN_STROKE_LENGTH = 10;

  function simplify(points, minDist) {
    if (points.length < 2) return points;
    const out = [points[0]];
    const md2 = minDist * minDist;
    for (let i = 1; i < points.length; i++) {
      const last = out[out.length - 1];
      const dx = points[i].x - last.x;
      const dy = points[i].y - last.y;
      if (dx * dx + dy * dy >= md2) out.push(points[i]);
    }
    // Always preserve the very last point so the stroke ends where it should.
    if (out[out.length - 1] !== points[points.length - 1]) out.push(points[points.length - 1]);
    return out;
  }

  // ── Tools registry ────────────────────────────────────────────────
  /**
   * Freehand strokes — shared logic between open and closed variants.
   * The `closed` flag at commit time decides whether the path gets a
   * Z appended (auto-close back to start) and a fill applied.
   */
  function makeFreehandTool(closed, labelText) {
    return {
      label: labelText,
      settings: function () {
        const lbl = document.createElement('label');
        const cb  = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = state.smoothing;
        cb.addEventListener('change', function () { state.smoothing = cb.checked; });
        lbl.appendChild(cb);
        lbl.appendChild(document.createTextNode(' smooth'));
        return [lbl];
      },
      onPointerDown: function (pt) {
        // Stash the first point but DON'T create a preview yet. The
        // preview only appears on the first actual move — that way a
        // pure click (no drag) leaves no trace and doesn't compete
        // with click-to-select logic.
        this._points = [pt];
        this._preview = null;
      },
      onPointerMove: function (pt) {
        if (!this._points) return;
        this._points.push(pt);
        if (!this._preview) {
          this._preview = createPath('is-preview', pathFromPoints(this._points, false));
          previewG.appendChild(this._preview);
        } else {
          this._preview.setAttribute('d', pathFromPoints(this._points, false));
        }
      },
      onPointerUp: function () {
        if (!this._points) return;
        const pts = this._points;
        this._points = null;
        if (this._preview) { this._preview.remove(); this._preview = null; }
        if (pts.length < 2) return; // pure click — nothing to commit
        // Without smoothing: preserve nearly every captured point so the
        // stroke is faithful to the user's hand (including wobble).
        // With smoothing: drop most of the closely-spaced points first so
        // the quadratic-through-midpoints pass has room to actually round
        // out the curve — otherwise it ends up hugging every micro-jitter.
        const minDist = state.smoothing ? 22 : 2;
        const simp = simplify(pts, minDist);
        if (simp.length < 2) return;
        // Reject strokes shorter than the noise threshold so a slightly
        // jittery click doesn't end up as a tiny invisible squiggle.
        if (pathLength(simp) < MIN_STROKE_LENGTH) return;
        commitLine({
          kind:     closed ? 'freehandClosed' : 'freehand',
          points:   simp,
          smoothed: state.smoothing,
          closed:   closed
        });
      },
      cancel: function () {
        if (this._preview) this._preview.remove();
        this._points = null; this._preview = null;
      }
    };
  }

  const TOOLS = {
    /**
     * Select — neutral mode. No drawing happens; pointerdown skips
     * the tool dispatcher entirely (no preview, no commit). All the
     * non-drawing gestures (click-to-select, drag a selected line,
     * drag a handle) still work, because they're wired separately from
     * the tool registry. The shortcut S and the leading toolbar button
     * make it easy to reach when the user just wants to navigate.
     */
    select: {
      label: 'Select'
      // No settings / pointer handlers — Select is neutral mode.
      // The Help button at the bottom-left of the sidebar opens the
      // general topic, which now also contains the Select-mode
      // section (was a separate ⓘ icon here, awkward placement).
    },

    freehand:       makeFreehandTool(false, 'Freehand'),
    freehandClosed: makeFreehandTool(true,  'Closed loop'),

    // Geometric primitives — each generated from PRIMITIVES so adding
    // another shape later is just a registry entry.
    circle:  makePrimitiveTool('circle'),
    ellipse: makePrimitiveTool('ellipse'),
    rect:    makePrimitiveTool('rect'),
    polygon: makePrimitiveTool('polygon'),
    star:    makePrimitiveTool('star'),
    image:   makePrimitiveTool('image'),
    textBlock: makePrimitiveTool('textBlock'),

    line: {
      label: 'Line',
      settings: function () { return []; },
      onPointerDown: function (pt) {
        this._start = pt;
        this._preview = null; // deferred until first move
      },
      onPointerMove: function (pt) {
        if (!this._start) return;
        if (!this._preview) {
          this._preview = createPath('is-preview', pathFromPoints([this._start, pt], false));
          previewG.appendChild(this._preview);
        } else {
          this._preview.setAttribute('d', pathFromPoints([this._start, pt], false));
        }
      },
      onPointerUp: function (pt) {
        if (!this._start) return;
        const start = this._start;
        this._start = null;
        if (this._preview) { this._preview.remove(); this._preview = null; }
        // Ignore tiny strokes (misclicks); the SVG pointerup dispatcher
        // treats anything below this threshold as a select/deselect.
        const dx = pt.x - start.x, dy = pt.y - start.y;
        if (dx * dx + dy * dy < MIN_STROKE_LENGTH * MIN_STROKE_LENGTH) return;
        commitLine({ kind: 'line', points: [start, pt], smoothed: false, closed: false });
      },
      cancel: function () {
        if (this._preview) this._preview.remove();
        this._start = null; this._preview = null;
      }
    },

    lineChain: {
      label: 'Line chain',
      settings: function () {
        const span = document.createElement('span');
        span.style.color = '#888';
        span.textContent = state.chainPoints
          ? 'chain: ' + state.chainPoints.length + ' pt' + (state.chainPoints.length === 1 ? '' : 's') + ' — Esc or double-click to finish'
          : 'click to start a chain';
        return [span];
      },
      // A chain is built up over multiple clicks but committed as ONE
      // line at the end, so the whole zig-zag carries a single set of
      // behaviors. Two previews run during construction:
      //   _committedPreview  — solid line through points clicked so far
      //   _cursorPreview     — dashed line from last anchor to cursor
      onPointerDown: function (pt) {
        if (!state.chainPoints) {
          state.chainPoints = [pt];
        } else {
          const prev = state.chainPoints[state.chainPoints.length - 1];
          const dx = pt.x - prev.x, dy = pt.y - prev.y;
          if (dx * dx + dy * dy < 1) return; // ignore double-click duplicates
          state.chainPoints.push(pt);
        }
        this._updateCommittedPreview();
        renderToolSettings();
      },
      onPointerMove: function (pt) {
        if (!state.chainPoints || !state.chainPoints.length) return;
        const prev = state.chainPoints[state.chainPoints.length - 1];
        if (!this._cursorPreview) {
          this._cursorPreview = createPath('is-preview', pathFromPoints([prev, pt], false));
          previewG.appendChild(this._cursorPreview);
        } else {
          this._cursorPreview.setAttribute('d', pathFromPoints([prev, pt], false));
        }
      },
      onPointerUp: function () { /* chain advances on pointer DOWN */ },
      finish: function () {
        // Commit the whole chain as a single multi-segment line.
        if (state.chainPoints && state.chainPoints.length >= 2) {
          commitLine({
            kind:     'chain',
            points:   state.chainPoints,
            smoothed: false,
            closed:   false
          });
        }
        if (this._committedPreview) { this._committedPreview.remove(); this._committedPreview = null; }
        if (this._cursorPreview)    { this._cursorPreview.remove();    this._cursorPreview    = null; }
        state.chainPoints = null;
        renderToolSettings();
      },
      cancel: function () {
        if (this._committedPreview) { this._committedPreview.remove(); this._committedPreview = null; }
        if (this._cursorPreview)    { this._cursorPreview.remove();    this._cursorPreview    = null; }
        state.chainPoints = null;
        renderToolSettings();
      },
      _updateCommittedPreview: function () {
        if (!state.chainPoints || state.chainPoints.length < 2) {
          if (this._committedPreview) {
            this._committedPreview.remove();
            this._committedPreview = null;
          }
          return;
        }
        const d = pathFromPoints(state.chainPoints, false);
        if (!this._committedPreview) {
          this._committedPreview = createPath('', d);
          this._committedPreview.style.stroke = '#ccc';
          this._committedPreview.style.strokeWidth = '2';
          this._committedPreview.style.pointerEvents = 'none';
          previewG.appendChild(this._committedPreview);
        } else {
          this._committedPreview.setAttribute('d', d);
        }
      }
    },

    /**
     * Bezier — click anchors to drop them; the path is rendered as a
     * smooth cubic curve passing through every anchor (Catmull-Rom →
     * cubic Bezier). Esc or double-click finishes. Same multi-click
     * UX as Chain mode; the curve type is what differs.
     */
    bezier: {
      label: 'Bezier',
      settings: function () {
        const span = document.createElement('span');
        span.style.color = '#888';
        span.textContent = state.bezierPoints
          ? 'bezier: ' + state.bezierPoints.length + ' anchor' +
            (state.bezierPoints.length === 1 ? '' : 's') +
            ' — Esc or double-click to finish'
          : 'click to drop anchors';
        return [span];
      },
      onPointerDown: function (pt) {
        if (!state.bezierPoints) {
          state.bezierPoints = [pt];
        } else {
          const prev = state.bezierPoints[state.bezierPoints.length - 1];
          const dx = pt.x - prev.x, dy = pt.y - prev.y;
          if (dx * dx + dy * dy < 1) return; // ignore double-click duplicates
          state.bezierPoints.push(pt);
        }
        this._updateCommittedPreview();
        renderToolSettings();
      },
      onPointerMove: function (pt) {
        if (!state.bezierPoints || !state.bezierPoints.length) return;
        // Live preview: smooth curve through (anchors so far + cursor)
        // so the user sees what the next click will produce.
        const previewPts = state.bezierPoints.concat([pt]);
        if (!this._cursorPreview) {
          this._cursorPreview = createPath('is-preview', bezierThroughPoints(previewPts));
          previewG.appendChild(this._cursorPreview);
        } else {
          this._cursorPreview.setAttribute('d', bezierThroughPoints(previewPts));
        }
      },
      onPointerUp: function () { /* chain advances on pointer DOWN */ },
      finish: function () {
        if (state.bezierPoints && state.bezierPoints.length >= 2) {
          commitLine({
            kind:     'bezier',
            points:   state.bezierPoints,
            smoothed: false,
            closed:   false
          });
        }
        if (this._committedPreview) { this._committedPreview.remove(); this._committedPreview = null; }
        if (this._cursorPreview)    { this._cursorPreview.remove();    this._cursorPreview    = null; }
        state.bezierPoints = null;
        renderToolSettings();
      },
      cancel: function () {
        if (this._committedPreview) { this._committedPreview.remove(); this._committedPreview = null; }
        if (this._cursorPreview)    { this._cursorPreview.remove();    this._cursorPreview    = null; }
        state.bezierPoints = null;
        renderToolSettings();
      },
      _updateCommittedPreview: function () {
        if (!state.bezierPoints || state.bezierPoints.length < 2) {
          if (this._committedPreview) {
            this._committedPreview.remove();
            this._committedPreview = null;
          }
          return;
        }
        const d = bezierThroughPoints(state.bezierPoints);
        if (!this._committedPreview) {
          this._committedPreview = createPath('', d);
          this._committedPreview.style.stroke = '#ccc';
          this._committedPreview.style.strokeWidth = '2';
          this._committedPreview.style.pointerEvents = 'none';
          previewG.appendChild(this._committedPreview);
        } else {
          this._committedPreview.setAttribute('d', d);
        }
      }
    }
  };

  function setActiveTool(id) {
    if (!TOOLS[id]) return;
    const prev = TOOLS[state.activeToolId];
    if (prev && prev.cancel) prev.cancel();
    state.activeToolId = id;
    refreshSelectButtonStates();
    renderToolSettings();
  }

  /**
   * Update the Select / Select-all button visuals. The Select
   * button reads as active only when the select tool is current
   * AND select-all isn't on — otherwise both buttons would show
   * active state at the same time, which is visually confusing.
   */
  function refreshSelectButtonStates() {
    const all = (typeof allObjectsSelected === 'function')
      ? allObjectsSelected() : false;
    toolButtons.forEach(function (b) {
      if (b.dataset.tool === 'select') {
        b.classList.toggle('is-active',
          state.activeToolId === 'select' && !all);
      } else if (b.dataset.tool) {
        b.classList.toggle('is-active', b.dataset.tool === state.activeToolId);
      }
    });
  }

  function renderToolSettings() {
    toolSettingsEl.innerHTML = '';
    const tool = TOOLS[state.activeToolId];
    if (tool && tool.settings) {
      tool.settings().forEach(function (el) { toolSettingsEl.appendChild(el); });
    }
  }

  // ── Create-object wizard (Phase 5) ───────────────────────────────
  // Default state is select. Drawing starts via "Create object",
  // which opens a modal to pick the type + destination classes. The
  // tool then activates; the user draws one shape; commitLine
  // detects the wizard is active and mints a master immediately so
  // the draft has a stable identity. The user tweaks; Save object
  // replicates instances into the other selected classes; Cancel
  // tears the draft down. Without the wizard active (e.g. keyboard
  // shortcut) drawing still works the legacy way — the line just
  // doesn't get auto-instanced.
  state.wizard = null;
  // Tool ids paired with the human label for the type list. Two
  // categories: free-form lines on one side, geometric primitives on
  // the other.
  const CREATE_TYPES_LINES = [
    { id: 'freehand',       label: 'Freehand', hint: 'click-drag organic stroke' },
    { id: 'freehandClosed', label: 'Loop',     hint: 'closed freehand, auto-fills' },
    { id: 'line',           label: 'Line',     hint: 'click-drag straight' },
    { id: 'lineChain',      label: 'Chain',    hint: 'click anchors, Esc to finish' },
    { id: 'bezier',         label: 'Bezier',   hint: 'click anchors, smooth curve' }
  ];
  const CREATE_TYPES_PRIMITIVES = [
    { id: 'circle',  label: 'Circle',  hint: 'click center, drag radius' },
    { id: 'ellipse', label: 'Ellipse', hint: 'click center, drag rx/ry' },
    { id: 'rect',    label: 'Rect',    hint: 'click corner, drag size' },
    { id: 'polygon', label: 'Polygon', hint: 'triangle/N-gon (set Sides)' },
    { id: 'star',    label: 'Star',    hint: 'N-pointed' }
  ];
  // v0.8.229: third column. Kinds that carry external content
  // (bitmap, text) rather than purely geometric shape. Same
  // drag-create UX as primitives; grouped separately so authors
  // can scan "what kind of thing does this object hold" in one
  // glance.
  const CREATE_TYPES_CONTAINERS = [
    { id: 'image',     label: 'Image',      hint: 'click corner, drag bbox · set URL in panel' },
    { id: 'textBlock', label: 'Text block', hint: 'click corner, drag bbox · holds HTML text for phase-2 page gen' }
  ];
  const CREATE_TYPES = CREATE_TYPES_LINES
    .concat(CREATE_TYPES_PRIMITIVES)
    .concat(CREATE_TYPES_CONTAINERS);

  function showCreateModal() {
    if (state.wizard) return; // already mid-wizard

    const overlay = document.createElement('div');
    overlay.className = 'ed-modal-overlay';
    const modal = document.createElement('div');
    modal.className = 'ed-modal ed-create-modal';

    const h = document.createElement('div');
    h.className = 'ed-modal-header';
    const t = document.createElement('h3'); t.textContent = 'Create object';
    h.appendChild(t);
    const x = document.createElement('button');
    x.className = 'ed-modal-close'; x.textContent = '×';
    x.addEventListener('click', cleanup);
    h.appendChild(x);
    modal.appendChild(h);

    const body = document.createElement('div');
    body.className = 'ed-modal-body';

    let pickedType = null;
    let startBtn   = null;

    // v0.8.36: SVG import affordance, the third "give me a new
    // object" pathway alongside Lines and Primitives. Doesn't
    // belong on the toolbar (logically secondary to Create object
    // and Library) so it lives here, in the Create object modal,
    // left-aligned at the top so the eye lands on it first when
    // the user just wants to drop a pre-made SVG in.
    const importSection = document.createElement('div');
    importSection.className = 'ed-create-import';
    const importHead = document.createElement('h5');
    importHead.textContent = 'Import existing';
    importSection.appendChild(importHead);
    const importBtn = document.createElement('button');
    importBtn.type = 'button';
    importBtn.className = 'ed-create-type ed-create-import-btn';
    // v0.8.40: inline SVG arrow instead of a Unicode glyph — the
    // ⇧ / ⇩ pair was at the mercy of font fallbacks (bolder weight
    // from <strong> in this context vs the lighter weight on the
    // Snapshots button picked up a different glyph rendering on
    // some platforms). SVG is identical everywhere.
    importBtn.innerHTML = '<strong>' + ARROW_SVG_DOWN_HTML + ' Import SVG file…</strong>'
                       + '<span>One or more SVG files. Each top-level shape '
                       + 'becomes a master + an instance in the current class, '
                       + 'dropped into the currently-active group.</span>';
    importBtn.addEventListener('click', function () {
      const inp = document.getElementById('import-svg-input');
      if (!inp) return;
      // Close the modal first — the file picker runs out-of-band
      // and the user has no further choices to make in this modal
      // once Import is the intent. The destinations checkboxes
      // below only apply to the Lines/Primitives drawing flow;
      // import drops into the active class only (existing behavior).
      cleanup();
      inp.click();
    });
    importSection.appendChild(importBtn);
    body.appendChild(importSection);

    function makeTypeButton(t, col) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ed-create-type';
      b.title = t.hint;
      b.innerHTML = '<strong>' + t.label + '</strong><span>' + t.hint + '</span>';
      b.addEventListener('click', function () {
        pickedType = t.id;
        body.querySelectorAll('.ed-create-type:not(.ed-create-import-btn)').forEach(function (n) {
          n.classList.toggle('is-active', n === b);
        });
        if (startBtn) startBtn.disabled = false;
      });
      col.appendChild(b);
    }

    // Side-by-side: Lines (left) and Primitives (right). The
    // column headings (h5) act as the section label — no
    // standalone "Type" header needed.
    const typesGrid = document.createElement('div');
    typesGrid.className = 'ed-create-types-grid';

    const linesCol = document.createElement('div');
    linesCol.className = 'ed-create-types-col';
    const linesHead = document.createElement('h5');
    linesHead.textContent = 'Lines';
    linesCol.appendChild(linesHead);
    CREATE_TYPES_LINES.forEach(function (t) { makeTypeButton(t, linesCol); });

    const primsCol = document.createElement('div');
    primsCol.className = 'ed-create-types-col';
    const primsHead = document.createElement('h5');
    primsHead.textContent = 'Primitives';
    primsCol.appendChild(primsHead);
    CREATE_TYPES_PRIMITIVES.forEach(function (t) { makeTypeButton(t, primsCol); });

    // v0.8.229: Containers column — kinds that wrap external
    // content (image bitmap, future-phase-2 HTML text). Sits to
    // the right of Primitives.
    const containersCol = document.createElement('div');
    containersCol.className = 'ed-create-types-col';
    const containersHead = document.createElement('h5');
    containersHead.textContent = 'Containers';
    containersCol.appendChild(containersHead);
    CREATE_TYPES_CONTAINERS.forEach(function (t) { makeTypeButton(t, containersCol); });

    typesGrid.appendChild(linesCol);
    typesGrid.appendChild(primsCol);
    typesGrid.appendChild(containersCol);
    body.appendChild(typesGrid);

    // Destination classes for the current page (only).
    const destHead = document.createElement('h4');
    destHead.textContent = 'Show in classes';
    body.appendChild(destHead);

    const useClasses = state.pageConfig.useClasses || [];
    const destState = {};
    useClasses.forEach(function (cid) { destState[cid] = true; });
    const destsWrap = document.createElement('div');
    destsWrap.className = 'ed-create-dests';
    useClasses.forEach(function (cid) {
      const def = state.classes.find(function (c) { return c.id === cid; });
      const labelText = (def && def.name) ? def.name : cid;
      if (cid === state.classId) {
        // Current class: always included, no toggle. Shown as a
        // check mark + label + "(current — drawing here)" badge so
        // the meaning is unambiguous.
        const row = document.createElement('div');
        row.className = 'ed-create-dest is-current';
        row.innerHTML = '<span class="ed-create-dest-check">✓</span>'
                      + '<span class="ed-create-dest-label">' + labelText + '</span>'
                      + '<span class="ed-create-dest-badge">drawing here</span>';
        destsWrap.appendChild(row);
      } else {
        const lbl = document.createElement('label');
        lbl.className = 'ed-create-dest';
        const chk = document.createElement('input');
        chk.type = 'checkbox';
        chk.checked = true;
        chk.addEventListener('change', function () { destState[cid] = chk.checked; });
        lbl.appendChild(chk);
        const span = document.createElement('span');
        span.className = 'ed-create-dest-label';
        span.textContent = labelText;
        lbl.appendChild(span);
        destsWrap.appendChild(lbl);
      }
    });
    body.appendChild(destsWrap);

    modal.appendChild(body);

    // Buttons.
    const btnRow = document.createElement('div');
    btnRow.className = 'ed-modal-buttons';
    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', cleanup);
    btnRow.appendChild(cancelBtn);
    startBtn = document.createElement('button');
    startBtn.textContent = 'Start drawing';
    startBtn.className = 'ed-primary';
    startBtn.disabled = true;
    startBtn.addEventListener('click', function () {
      const destinations = useClasses.filter(function (c) { return destState[c]; });
      // Current class is always a destination (the input was disabled
      // for it, but reading destState[currentClass] is true anyway).
      cleanup();
      beginWizard(pickedType, destinations);
    });
    btnRow.appendChild(startBtn);
    modal.appendChild(btnRow);

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    function cleanup() {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
    }
    function onKey(e) { if (e.key === 'Escape') cleanup(); }
    document.addEventListener('keydown', onKey);
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) cleanup();
    });
  }

  function beginWizard(toolId, destinations) {
    state.wizard = {
      type:        toolId,
      destinations: destinations,
      draftId:     null,
      draftMasterId: null
    };
    setActiveTool(toolId);
    showWizardBanner('Drafting new ' + (CREATE_TYPES.find(function (t) { return t.id === toolId; }) || { label: toolId }).label);
  }

  function showWizardBanner(text, draftCaptured) {
    if (!wizardBanner) return;
    wizardLabel.textContent = text;
    wizardSaveBtn.disabled = !draftCaptured;
    wizardBanner.hidden = false;
  }
  function hideWizardBanner() { if (wizardBanner) wizardBanner.hidden = true; }

  /**
   * Called from commitLine when a tool finishes drawing a shape
   * during wizard mode. Mints a master from the line's current
   * visual values, attaches the new masterId to the line so the
   * editor's master-link toggle works immediately, and switches
   * the tool back to Select so the user can tweak.
   */
  function captureWizardDraft(line) {
    if (!state.wizard || state.wizard.draftId) return;
    const mid = 'm-' + Math.random().toString(36).slice(2, 10);
    const m = { id: mid, scope: {} };
    MASTER_VISUAL_KEYS.forEach(function (k) {
      if (line[k] !== undefined && line[k] !== null) m[k] = line[k];
    });
    if (!m.name) m.name = line.name || nextDefaultName();
    line.name = m.name;
    state.masters.push(m);
    line.masterId = mid;
    state.wizard.draftId       = line.id;
    state.wizard.draftMasterId = mid;
    setActiveTool('select');
    const typeLabel = (CREATE_TYPES.find(function (t) { return t.id === state.wizard.type; }) || { label: state.wizard.type }).label;
    showWizardBanner('Drafting new ' + typeLabel + ' — tweak then Save object', true);
  }

  /**
   * Finalize the wizard: replicate the draft instance into every
   * other selected destination class (same id, same masterId, no
   * overrides) so the new object appears across classes at the
   * authored position. Exits wizard mode.
   */
  function saveWizardObject() {
    if (!state.wizard || !state.wizard.draftId) return;
    const w = state.wizard;
    const line = state.lines.find(function (l) { return l.id === w.draftId; });
    if (!line) { cancelWizard(); return; }
    w.destinations.forEach(function (cid) {
      if (cid === state.classId) return;
      if (!state.byClass[cid]) return;
      // Don't duplicate if for some reason an instance already exists here.
      if (state.byClass[cid].lines.some(function (l) { return l.id === line.id; })) return;
      const copy = deepCopy(line);
      // Fresh override map — the new instance inherits visuals from
      // the master and starts with no class-specific overrides.
      copy.overrides = {};
      state.byClass[cid].lines.push(copy);
    });
    state.wizard = null;
    hideWizardBanner();
    state.dirty = true;
    snapshot();
    renderAll();
  }

  function cancelWizard() {
    if (!state.wizard) return;
    const w = state.wizard;
    if (w.draftId) {
      state.byClass[state.classId].lines =
        state.byClass[state.classId].lines.filter(function (l) { return l.id !== w.draftId; });
      state.selectedIds = state.selectedIds.filter(function (id) { return id !== w.draftId; });
    }
    if (w.draftMasterId) {
      state.masters = state.masters.filter(function (m) { return m.id !== w.draftMasterId; });
    }
    state.wizard = null;
    hideWizardBanner();
    setActiveTool('select');
    state.dirty = true;
    snapshot();
    renderAll();
  }

  // ── Line + group mutations ────────────────────────────────────────
  /**
   * Create a new line and select it. Tools pass meta describing the
   * line's geometry origin so handles + future re-render know how to
   * regenerate `d` from `points`.
   */
  function commitLine(meta) {
    if (!meta) return;
    const isPrim = !!PRIMITIVES[meta.kind];
    // Primitives store `params` (shape-specific) and don't need
    // `points`; everything else needs at least one point.
    if (!isPrim && (!Array.isArray(meta.points) || meta.points.length < 1)) return;
    const line = {
      id: uid('l'),
      kind:     meta.kind || 'manual',
      points:   meta.points ? meta.points.map(function (p) { return { x: p.x, y: p.y }; }) : null,
      params:   meta.params ? Object.assign({}, meta.params) : null,
      smoothed: !!meta.smoothed,
      closed:   !!meta.closed,
      // Primitives default to filled; other kinds inherit from `closed`
      // unless explicitly overridden.
      filled:   meta.filled !== undefined ? !!meta.filled : (isPrim || !!meta.closed),
      d: '',
      stroke: null,
      width: null,
      // Brand-new lines are drawn at the canonical position — no
      // class-specific shift yet. Drag-translate later will populate
      // positionOffset; the master keeps the drawn position.
      positionOffset: { dx: 0, dy: 0 },
      groupId: state.activeGroupId || (state.groups[0] && state.groups[0].id) || null,
      behaviors: [],
      overrides: {}
    };
    regenerateLineD(line);
    if (!line.d) return;
    state.lines.push(line);
    selectOnly(line.id);
    state.dirty = true;
    // Wizard hook: if a "Create object" flow is active and this is
    // the first shape drawn in it, mint a master, attach it, and
    // switch the tool back to Select so the user can tweak. The
    // wizard banner's Save / Cancel buttons take it from here.
    if (state.wizard && !state.wizard.draftId) {
      captureWizardDraft(line);
    } else {
      // Mint a master right away so the line participates in the
      // scope contract from the first paint (otherwise the scope
      // toggles wouldn't appear until after Save → reload).
      mintMasterForLine(line);
    }
    snapshot();
    renderAll();
  }

  function mintMasterForLine(line) {
    if (line.masterId) return;
    const mid = 'm-' + Math.random().toString(36).slice(2, 10);
    const m = { id: mid, scope: {} };
    MASTER_VISUAL_KEYS.forEach(function (k) {
      if (line[k] !== undefined && line[k] !== null) m[k] = line[k];
    });
    if (!m.name) m.name = line.name || nextDefaultName();
    // Mirror onto the instance so the label + panel render the
    // new name immediately (no Save→reload round-trip needed).
    line.name = m.name;
    state.masters.push(m);
    line.masterId = mid;
  }

  /**
   * Compute the next available "Object N" name site-wide. Masters
   * are stored in content/_shared/masters.json, so the namespace is
   * naturally site-wide; we count the highest existing N across all
   * masters and add one. Manually renamed masters with non-matching
   * names don't count, and don't gap the sequence either.
   */
  function nextDefaultName() {
    const re = /^Object (\d+)$/;
    let maxN = 0;
    state.masters.forEach(function (m) {
      if (!m || !m.name) return;
      const match = m.name.match(re);
      if (match) {
        const n = parseInt(match[1], 10);
        if (n > maxN) maxN = n;
      }
    });
    return 'Object ' + (maxN + 1);
  }

  function deleteLine(id) {
    deleteLinesByMasterIds([id], state.classId);
  }

  /**
   * Per-class removal — drop the given instance line ids from THIS
   * class only. masters + sibling-class instances are untouched, so
   * the object still exists in classes that had it. If this leaves
   * a master with zero instances anywhere, the save-time prune in
   * decomposeForSave drops it. Use when "this class no longer has
   * this object" but you don't want to delete the canonical object.
   */
  function removeLinesFromCurrentClass(lineIds) {
    if (!lineIds || !lineIds.length) return;
    const idSet = {};
    lineIds.forEach(function (id) { idSet[id] = true; });
    state.lines = state.lines.filter(function (l) { return !idSet[l.id]; });
    state.selectedIds = state.selectedIds.filter(function (x) { return !idSet[x]; });
    // v0.8.219: clear template refs that now point at removed instances.
    pruneGroupTemplateRefs();
    state.dirty = true;
    snapshot();
    renderAll();
  }

  // Delete every currently selected object in one go (Backspace / Delete
  // when 1+ objects are selected, including the multi-select case).
  function deleteSelected() {
    if (!state.selectedIds.length) return;
    const ids = state.selectedIds.slice();
    deleteLinesByMasterIds(ids, state.classId);
    clearSelection();
  }

  /**
   * Cascade-delete: for every line id passed in, find its master and
   * remove the master AND every instance in every class that
   * references it. Matches the user's "object = master" mental
   * model — deleting an object anywhere makes it gone everywhere.
   * Lines with no masterId (legacy / detached) are removed only from
   * the active class.
   */
  function deleteLinesByMasterIds(lineIds, srcClassId) {
    const srcLines = (state.byClass[srcClassId] && state.byClass[srcClassId].lines) || [];
    const targetMasterIds = new Set();
    const looseInstanceIds = new Set();
    lineIds.forEach(function (lid) {
      const ln = srcLines.find(function (l) { return l.id === lid; });
      if (!ln) return;
      if (ln.masterId) targetMasterIds.add(ln.masterId);
      else             looseInstanceIds.add(ln.id);
    });
    state.pageConfig.useClasses.forEach(function (cid) {
      const bucket = state.byClass[cid];
      if (!bucket || !Array.isArray(bucket.lines)) return;
      bucket.lines = bucket.lines.filter(function (l) {
        if (l.masterId && targetMasterIds.has(l.masterId)) return false;
        if (cid === srcClassId && looseInstanceIds.has(l.id)) return false;
        return true;
      });
    });
    state.masters = state.masters.filter(function (m) {
      return !targetMasterIds.has(m.id);
    });
    state.selectedIds = state.selectedIds.filter(function (x) { return lineIds.indexOf(x) < 0; });
    // v0.8.219: clear any group template refs pointing at deleted lines.
    pruneGroupTemplateRefs();
    state.dirty = true;
    snapshot();
    renderAll();
  }

  function moveLineToGroup(lineId, newGroupId) {
    moveLinesToGroup([lineId], newGroupId);
  }

  // Move N lines into a new group in one transaction. Used by the
  // sidebar drag-and-drop: when the dragged line is part of the
  // current multi-selection the whole selection follows.
  //
  // 'all' mode also moves every sibling-class instance of the same
  // masters into the same-named target group of their class. If a
  // class doesn't have a same-name group yet, its sibling stays
  // put (we don't auto-create groups here — the user already had
  // to pick the destination via drag-and-drop, so creation is out
  // of band).
  function moveLinesToGroup(lineIds, newGroupId) {
    // v0.8.32 DIAGNOSTIC — same idea as moveLinesAdjacentTo.
    console.log('[move-to-group/start]', {
      mode: state.mode, classId: state.classId,
      lineIds: lineIds, newGroupId: newGroupId
    });
    let changed = false;
    // v0.8.30: track groupId changes as { masterId: groupName } so
    // fanOutZReorder can mirror them in sibling classes by name.
    // Replaces the old per-line forSiblingsOf loop — fanOutZReorder
    // also takes care of repositioning sibling lines, which the
    // previous fan-out skipped (group changed but Z didn't follow).
    const groupIdChanges = {};
    const targetGroup = state.groups.find(function (g) { return g.id === newGroupId; });
    const targetName = targetGroup ? targetGroup.name : null;
    lineIds.forEach(function (id) {
      const line = state.lines.find(function (l) { return l.id === id; });
      if (!line || line.groupId === newGroupId) return;
      line.groupId = newGroupId;
      if (line.masterId && targetName) {
        groupIdChanges[line.masterId] = targetName;
      }
      changed = true;
    });
    if (!changed) return;
    // Auto-open the destination group so the user sees the move land.
    state.openGroupIds[newGroupId] = true;
    state.activeGroupId = newGroupId;
    // v0.8.29: re-flatten state.lines by group order so the
    // moved line lands at the end of the destination group's
    // run in state.lines, matching where the sidebar shows it.
    rebuildLinesInGroupOrder();
    fanOutZReorder({ groupIdChanges: groupIdChanges });
    // v0.8.219: lines that just changed groupId may have been the
    // template of their old group — clear those stale refs.
    pruneGroupTemplateRefs();
    state.dirty = true;
    snapshot();
    renderAll();
  }
  // v0.8.28: drag-to-reorder for lines. `where` ∈ {'before','after'}
  // places the dragged ids next to anchorLineId in state.lines —
  // which is the same array that drives canvas Z-stacking (later
  // append = on top), so reordering the sidebar reorders the canvas
  // in lockstep. If the anchor lives in a different group, the
  // dragged lines also re-home into that group, collapsing
  // "drag-to-group" and "drag-to-reorder" into one gesture.
  function moveLinesAdjacentTo(draggedIds, anchorLineId, where, anchorGroupId) {
    if (!draggedIds || !draggedIds.length || !anchorLineId) return;
    // v0.8.32 DIAGNOSTIC: capture pre-move snapshots of every
    // master-matched line across all classes so we can see where
    // appearance / behaviors are getting lost on a cross-group
    // drag. Cheap to leave on; remove once the bug is fixed.
    var _dbgSnap = function (line) {
      if (!line) return '(none)';
      return {
        id: line.id, masterId: line.masterId, groupId: line.groupId,
        stroke: line.stroke,
        behaviorsLen: Array.isArray(line.behaviors) ? line.behaviors.length : -1,
        behaviorIds: Array.isArray(line.behaviors)
          ? line.behaviors.map(function (b) { return b.id; }) : null,
        paramKeys: line.params ? Object.keys(line.params) : null,
        overrideKeys: line.overrides ? Object.keys(line.overrides) : null
      };
    };
    var _dbgSibs = function (mid) {
      var out = {};
      state.pageConfig.useClasses.forEach(function (cid) {
        var bucket = state.byClass[cid];
        if (!bucket || !Array.isArray(bucket.lines)) return;
        var l = bucket.lines.find(function (x) { return x.masterId === mid; });
        out[cid] = _dbgSnap(l);
      });
      return out;
    };
    var _dbgFirstId = draggedIds[0];
    var _dbgFirstLine = state.lines.find(function (l) { return l.id === _dbgFirstId; });
    var _dbgFirstMid = _dbgFirstLine && _dbgFirstLine.masterId;
    console.log('[drag/start]', {
      mode: state.mode, classId: state.classId,
      draggedIds: draggedIds, anchorLineId: anchorLineId, where: where,
      anchorGroupId: anchorGroupId,
      sibsForMaster: _dbgFirstMid ? _dbgSibs(_dbgFirstMid) : null
    });
    // De-dupe + drop the anchor (dropping on yourself is a no-op).
    const ids = [];
    draggedIds.forEach(function (id) {
      if (id && id !== anchorLineId && ids.indexOf(id) === -1) ids.push(id);
    });
    if (!ids.length) return;
    // Preserve visual order: when the user multi-selects A, C, B
    // (click order) and drags, we want A,B,C — the order they read
    // in state.lines today — to land at the drop point. Sort the
    // dragged ids by their pre-move state.lines position.
    const draggedLines = ids
      .map(function (id) {
        const pos = state.lines.findIndex(function (l) { return l.id === id; });
        const obj = state.lines[pos];
        return obj ? { obj: obj, pos: pos } : null;
      })
      .filter(Boolean)
      .sort(function (a, b) { return a.pos - b.pos; })
      .map(function (x) { return x.obj; });
    if (!draggedLines.length) return;
    // Snip them out, re-home if needed, then splice in at the
    // anchor's NEW position (which may have shifted if the anchor
    // was after a removed line).
    const movedIds = {};
    draggedLines.forEach(function (l) { movedIds[l.id] = true; });
    state.lines = state.lines.filter(function (l) { return !movedIds[l.id]; });
    const anchorIdx = state.lines.findIndex(function (l) { return l.id === anchorLineId; });
    if (anchorIdx === -1) return;
    const insertAt = (where === 'before') ? anchorIdx : anchorIdx + 1;
    // v0.8.30: track which masterIds actually cross groups in this
    // operation. fanOutZReorder uses this list — and ONLY this list —
    // to update sibling groupIds, so siblings that intentionally
    // diverged on groupId for an unrelated master aren't dragged
    // along by a Z reorder elsewhere.
    const groupIdChanges = {};
    const anchorGroupName = (anchorGroupId
      && (state.groups.find(function (g) { return g.id === anchorGroupId; }) || {}).name) || null;
    let groupChanged = false;
    draggedLines.forEach(function (l) {
      if (anchorGroupId && l.groupId !== anchorGroupId) {
        l.groupId = anchorGroupId;
        groupChanged = true;
        if (l.masterId && anchorGroupName) {
          groupIdChanges[l.masterId] = anchorGroupName;
        }
      }
    });
    state.lines.splice.apply(state.lines, [insertAt, 0].concat(draggedLines));
    if (groupChanged && anchorGroupId) {
      state.openGroupIds[anchorGroupId] = true;
      state.activeGroupId = anchorGroupId;
    }
    // v0.8.29: a within-group splice can leave state.lines
    // interspersed across groups if it wasn't already flattened —
    // re-sort by group order so the sidebar's visual order keeps
    // matching canvas Z (renderLines + decomposeForSave both walk
    // state.lines top-to-bottom).
    rebuildLinesInGroupOrder();
    // v0.8.32 DIAGNOSTIC: just before fan-out, dump current-class
    // snapshot of the dragged line + every sibling's master-matched
    // line. If they look fine here but corrupted after fan-out, the
    // bug is in fanOutZReorder.
    console.log('[drag/post-local]', {
      groupIdChanges: groupIdChanges,
      sibsForMaster: _dbgFirstMid ? _dbgSibs(_dbgFirstMid) : null,
      currentDraggedSnap: _dbgSnap(state.lines.find(function (l) { return l.id === _dbgFirstId; }))
    });
    fanOutZReorder({ groupIdChanges: groupIdChanges });
    console.log('[drag/post-fanout]', {
      sibsForMaster: _dbgFirstMid ? _dbgSibs(_dbgFirstMid) : null,
      currentDraggedSnap: _dbgSnap(state.lines.find(function (l) { return l.id === _dbgFirstId; }))
    });
    // v0.8.219: same rationale as moveLinesToGroup — dragged lines
    // may have just left a group whose template referenced them.
    pruneGroupTemplateRefs();
    state.dirty = true;
    snapshot();
    renderAll();
  }

  // v0.8.29: stable-sort state.lines by (group position in
  // state.groups, pre-existing relative position within group).
  // The result is the same flat array, but flattened so all of
  // group N's lines come before all of group N+1's. Lines whose
  // groupId doesn't match any group (orphans) sort to the end so
  // they're still visible on canvas; the user can re-home them.
  function rebuildLinesInGroupOrder() {
    rebuildLinesInGroupOrderFor(state.byClass[state.classId]);
  }
  function rebuildLinesInGroupOrderFor(bucket) {
    if (!bucket || !Array.isArray(bucket.groups) || !Array.isArray(bucket.lines)) return;
    const groupIdx = {};
    bucket.groups.forEach(function (g, i) { groupIdx[g.id] = i; });
    const withPos = bucket.lines.map(function (l, i) { return { l: l, i: i }; });
    withPos.sort(function (a, b) {
      const ag = (groupIdx[a.l.groupId] != null) ? groupIdx[a.l.groupId] : Infinity;
      const bg = (groupIdx[b.l.groupId] != null) ? groupIdx[b.l.groupId] : Infinity;
      if (ag !== bg) return ag - bg;
      return a.i - b.i;
    });
    bucket.lines = withPos.map(function (x) { return x.l; });
  }

  // v0.8.30: orphan-preserving reorder. Given sibling's PRE-reorder
  // sequence and current's NEW order over the shared items, return
  // the sibling's NEW sequence: shared items reordered to match
  // current; orphans (items in sibSeq with no counterpart in
  // currentNewOrder) anchored to their immediate predecessor
  // shared item from sibSeq, falling back to "before everything"
  // when the orphan sits before the first shared item.
  //
  // sibIdentity:   (sibItem) → identity key
  // curIdentity:   (curItem) → identity key (typically the same
  //                identity domain — group name, master id, etc.)
  function applyReorderToSibling(sibSeq, currentNewOrder, sibIdentity, curIdentity) {
    if (!Array.isArray(sibSeq) || !sibSeq.length) return sibSeq || [];
    const curIds = {};
    currentNewOrder.forEach(function (c) { curIds[curIdentity(c)] = true; });
    // Bucket orphans by the immediate-predecessor shared item they
    // follow in sibSeq. Orphans before any shared item go to head.
    const head = [];
    const trailingByIdentity = {};
    const sharedBySibIdentity = {};
    let lastSharedId = null;
    sibSeq.forEach(function (item) {
      const id = sibIdentity(item);
      if (curIds[id]) {
        lastSharedId = id;
        sharedBySibIdentity[id] = item;
        if (!trailingByIdentity[id]) trailingByIdentity[id] = [];
      } else {
        if (lastSharedId == null) head.push(item);
        else trailingByIdentity[lastSharedId].push(item);
      }
    });
    // Re-emit: head + (each shared in current's new order, then its trailing orphans).
    const out = head.slice();
    currentNewOrder.forEach(function (c) {
      const id = curIdentity(c);
      const sib = sharedBySibIdentity[id];
      if (!sib) return; // current item has no counterpart in this sibling — skip.
      out.push(sib);
      const trail = trailingByIdentity[id];
      if (trail && trail.length) out.push.apply(out, trail);
    });
    return out;
  }

  // v0.8.30: ALL-mode fan-out for Z reorders. Applies the
  // current class's new (group order, line order, groupId
  // changes) to every sibling class:
  //   1. Sibling groups reorder to match current's group-name
  //      sequence; sibling-only groups float with their
  //      predecessor.
  //   2. Sibling lines whose masterId appears in opts.groupIdChanges
  //      get their groupId re-homed by group-name lookup (only
  //      the explicit list — Z drag isn't supposed to silently
  //      sync siblings that intentionally diverged on groupId).
  //   3. Sibling lines reorder by masterId to match current's
  //      line order; sibling-only lines (master not in current)
  //      float with their predecessor master.
  //   4. rebuildLinesInGroupOrderFor flattens the sibling's lines
  //      by its OWN group order, same invariant the current class
  //      maintains.
  // opts.groupIdChanges: { masterId: targetGroupName | null }.
  //   Empty / omitted = pure positional reorder; nothing in
  //   sibling switches groups.
  function fanOutZReorder(opts) {
    if (!modeIsAll()) return;
    opts = opts || {};
    const groupIdChanges = opts.groupIdChanges || {};
    const curGroupOrder = state.groups.slice();
    const curMasterOrder = state.lines
      .map(function (l) { return l.masterId; })
      .filter(Boolean);

    state.pageConfig.useClasses.forEach(function (cid) {
      if (cid === state.classId) return;
      const bucket = state.byClass[cid];
      if (!bucket) return;

      if (Array.isArray(bucket.groups)) {
        bucket.groups = applyReorderToSibling(
          bucket.groups,
          curGroupOrder,
          function (g) { return g.name; },
          function (g) { return g.name; }
        );
      }
      if (!Array.isArray(bucket.lines)) return;

      const sibGroupIdByName = {};
      (bucket.groups || []).forEach(function (g) { sibGroupIdByName[g.name] = g.id; });
      Object.keys(groupIdChanges).forEach(function (mid) {
        const tgtName = groupIdChanges[mid];
        if (tgtName == null) return;
        const tgtId = sibGroupIdByName[tgtName];
        if (!tgtId) return;
        bucket.lines.forEach(function (sibLine) {
          if (sibLine.masterId === mid && sibLine.groupId !== tgtId) {
            sibLine.groupId = tgtId;
          }
        });
      });
      bucket.lines = applyReorderToSibling(
        bucket.lines,
        curMasterOrder,
        function (sibLine) { return sibLine.masterId || ('__nm__' + sibLine.id); },
        function (mid) { return mid; }
      );
      rebuildLinesInGroupOrderFor(bucket);
    });
  }

  // v0.8.29: drag-to-reorder for groups themselves. State.groups
  // order drives sidebar order top-to-bottom, and after the
  // rebuild above it also drives canvas Z (earlier group = drawn
  // first = behind). Same toIdx contract as moveBehaviorBlock —
  // pre-move insertion index, so fromIdx → toIdx reads as "place
  // this group at slot toIdx".
  // v0.8.30: in ALL mode, fan out the reorder to sibling classes
  // via group-name match. Pure positional change — no groupId
  // rewrites, so sibling-only groups float with their
  // predecessor and no cross-class group dependency is rewritten.
  function moveGroup(fromIdx, toIdx) {
    if (!Array.isArray(state.groups)) return;
    if (fromIdx < 0 || fromIdx >= state.groups.length) return;
    if (toIdx < 0) toIdx = 0;
    if (toIdx > state.groups.length) toIdx = state.groups.length;
    if (fromIdx === toIdx || fromIdx === toIdx - 1) return;
    const moved = state.groups.splice(fromIdx, 1)[0];
    const insertAt = (toIdx > fromIdx) ? toIdx - 1 : toIdx;
    state.groups.splice(insertAt, 0, moved);
    rebuildLinesInGroupOrder();
    fanOutZReorder();
    state.dirty = true;
    snapshot();
    renderAll();
  }

  // ── Duplication ──────────────────────────────────────────────────
  //
  // v0.8.92: Two flavors for both object and group, exposed in the
  // side panel:
  //   • Duplicate (new master)  — geometry deep-copied; the duplicate
  //                               is fully independent of the source.
  //   • Duplicate (linked)      — geometry shared (same masterId);
  //                               transform / behaviors / position
  //                               offset are still per-instance, so
  //                               the duplicate can animate on its own.
  //
  // ALL/1 mode is honored. In 'one' mode the duplicate lives in the
  // current class only. In 'all' mode it fans out the same way the
  // source is spread: every class that holds an instance of the
  // source gets the duplicate. If the source's spread is incomplete
  // we ask before acting (mirror existing spread vs spread into every
  // useClass).
  //
  // Group duplicate rewrites cross-object behavior refs WITHIN the
  // duplicated set (startObjectId / stopObjectId / params.pathRef on
  // masters that are also being duplicated) so the new group is
  // self-contained. Refs pointing OUT of the set keep pointing to
  // the originals — almost certainly the user's intent.

  function uniqueObjectName(baseName) {
    const existing = new Set();
    state.masters.forEach(function (m) { if (m && m.name) existing.add(m.name); });
    const root = (baseName || 'object') + ' copy';
    if (!existing.has(root)) return root;
    let n = 2;
    while (existing.has(root + ' ' + n)) n++;
    return root + ' ' + n;
  }

  function uniqueGroupName(baseName) {
    // Groups are per-class, linked across classes by name — so the
    // candidate must be unused in EVERY class's group list.
    const existing = new Set();
    (state.pageConfig.useClasses || []).forEach(function (cid) {
      const b = state.byClass[cid];
      if (!b || !Array.isArray(b.groups)) return;
      b.groups.forEach(function (g) { if (g && g.name) existing.add(g.name); });
    });
    const root = (baseName || 'group') + ' copy';
    if (!existing.has(root)) return root;
    let n = 2;
    while (existing.has(root + ' ' + n)) n++;
    return root + ' ' + n;
  }

  function cloneMasterRecord(src, newName) {
    const c = deepCopy(src);
    c.id = uid('m');
    if (newName) c.name = newName;
    return c;
  }

  function cloneLineRecord(src, opts) {
    const c = deepCopy(src);
    c.id = uid('l');
    if (opts.masterId) c.masterId = opts.masterId;
    if (opts.groupId)  c.groupId  = opts.groupId;
    if (opts.name)     c.name     = opts.name;
    // v0.8.95: must translate the geometry too — not just bump
    // positionOffset. The renderer draws from line.d (regenerated from
    // line.points/segments/params), so without translating those the
    // duplicate would render at the source's exact spot. shiftLineBy
    // handles offset + geometry atomically.
    if (opts.offsetDx || opts.offsetDy) {
      shiftLineBy(c, opts.offsetDx || 0, opts.offsetDy || 0);
    }
    // Fresh ids on behaviors so the duplicate's blocks don't collide
    // with the source's in any future block-id-keyed lookup.
    if (Array.isArray(c.behaviors)) {
      c.behaviors.forEach(function (b) { b.id = uid('b'); });
    }
    return c;
  }

  // Rewrite cross-object references on a (deep-copied) line's
  // behaviors. masterMap is { srcMasterId → newMasterId } for masters
  // we just duplicated. Refs whose target IS in the map → rewrite.
  // Refs whose target ISN'T → untouched.
  function rewriteBehaviorRefs(line, masterMap) {
    if (!Array.isArray(line.behaviors)) return;
    line.behaviors.forEach(function (b) {
      if (b && b.trigger) {
        if (b.trigger.startObjectId && masterMap[b.trigger.startObjectId]) {
          b.trigger.startObjectId = masterMap[b.trigger.startObjectId];
        }
        if (b.trigger.stopObjectId && masterMap[b.trigger.stopObjectId]) {
          b.trigger.stopObjectId = masterMap[b.trigger.stopObjectId];
        }
      }
      if (b && b.params && b.params.pathRef && masterMap[b.params.pathRef]) {
        b.params.pathRef = masterMap[b.params.pathRef];
      }
    });
  }

  // Confirm dialog for the ALL-mode incomplete-spread case. Returns
  // 'mirror' | 'all' | null (cancel).
  async function askSpreadScope(presentClassIds, missingClassIds, label) {
    const labelOf = function (cid) {
      const c = state.classes.find(function (x) { return x.id === cid; });
      return c ? c.name : cid;
    };
    const mirrorN = presentClassIds.length;
    const allN    = mirrorN + missingClassIds.length;
    const esc = function (s) {
      const d = document.createElement('div'); d.textContent = String(s); return d.innerHTML;
    };
    const missList = missingClassIds.map(function (cid) {
      return '<li>' + esc(labelOf(cid)) + '</li>';
    }).join('');
    const msg = '<p>The source ' + (label || 'object') +
                ' is present in <strong>' + mirrorN + '</strong> of <strong>' + allN +
                '</strong> classes. Missing from:</p>' +
                '<ul>' + missList + '</ul>' +
                '<p>Where should the duplicate go?</p>';
    return await showChoiceDialog({
      title:   'Duplicate — spread choice',
      message: msg,
      html:    true,
      buttons: [
        { label: 'Cancel',                                        value: null },
        { label: 'Mirror current spread (' + mirrorN + ')',       value: 'mirror', className: 'ed-primary' },
        { label: 'Spread to all useClasses (' + allN + ')',       value: 'all' }
      ]
    });
  }

  async function duplicateObject(lineId, opts) {
    const linked = !!(opts && opts.linked);
    const offsetMM = 20;
    const srcLine = state.lines.find(function (l) { return l.id === lineId; });
    if (!srcLine) return;
    const srcMaster = srcLine.masterId
      ? state.masters.find(function (m) { return m.id === srcLine.masterId; })
      : null;

    // Loose-instance path (no master): can only exist in the current
    // class anyway, so ALL/1 doesn't matter and there's no master to
    // duplicate. Just clone the line locally.
    if (!srcMaster) {
      const newLine = cloneLineRecord(srcLine, {
        name: srcLine.name ? (srcLine.name + ' copy') : null,
        offsetDx: offsetMM, offsetDy: offsetMM
      });
      state.lines.push(newLine);
      selectOnly(newLine.id);
      state.dirty = true;
      snapshot();
      renderAll();
      return;
    }

    // Target-class set.
    let targetClassIds;
    if (modeIsAll()) {
      const present = [];
      const missing = [];
      (state.pageConfig.useClasses || []).forEach(function (cid) {
        const b = state.byClass[cid];
        if (!b || !Array.isArray(b.lines)) { missing.push(cid); return; }
        const has = b.lines.some(function (l) { return l.masterId === srcMaster.id; });
        (has ? present : missing).push(cid);
      });
      if (missing.length === 0) {
        targetClassIds = present;
      } else {
        const choice = await askSpreadScope(present, missing, 'object');
        if (!choice) return;
        targetClassIds = choice === 'mirror' ? present : (state.pageConfig.useClasses || []).slice();
      }
    } else {
      targetClassIds = [state.classId];
    }
    if (!targetClassIds.length) return;

    // New master (or reuse for linked).
    const newName = uniqueObjectName(srcMaster.name || 'object');
    let newMasterId;
    if (linked) {
      newMasterId = srcMaster.id;
    } else {
      const newMaster = cloneMasterRecord(srcMaster, newName);
      state.masters.push(newMaster);
      newMasterId = newMaster.id;
    }

    let firstNewLineIdInCurrentClass = null;
    targetClassIds.forEach(function (cid) {
      const bucket = state.byClass[cid];
      if (!bucket || !Array.isArray(bucket.lines)) return;
      // Template = source instance in THIS class. Force-spread case
      // (class doesn't have one) → fall back to srcLine so the new
      // instance still has plausible per-class defaults.
      const sourceInstance = bucket.lines.find(function (l) { return l.masterId === srcMaster.id; })
                          || srcLine;
      // Group lookup: same group as the source instance has in this
      // class, identified by name in cross-class cases.
      let groupId = sourceInstance.groupId;
      if (cid !== state.classId) {
        const homeBucket = state.byClass[state.classId];
        const srcGroup = homeBucket && (homeBucket.groups || []).find(function (g) {
          return g.id === sourceInstance.groupId;
        });
        const peerGroup = srcGroup
          ? (bucket.groups || []).find(function (g) { return g.name === srcGroup.name; })
          : null;
        groupId = peerGroup ? peerGroup.id
                            : ((bucket.groups[0] && bucket.groups[0].id) || null);
      }
      // v0.8.100: linked-duplicate line.name suffix. The master is
      // shared, so master.name can't distinguish the new instance
      // from the source. Append " linked" to line.name on each new
      // instance — the sidebar prefers line.name over master.name
      // when set, so the duplicate is recognisable at a glance.
      // Guard against stacking ("foo linked linked") if the source's
      // own name already ends with " linked".
      let linkedName = sourceInstance.name || srcMaster.name || 'object';
      if (linked && !/ linked(?: \d+)?$/.test(linkedName)) {
        linkedName = linkedName + ' linked';
      }
      const newLine = cloneLineRecord(sourceInstance, {
        masterId: newMasterId,
        groupId:  groupId,
        // 'name' on a line is mostly vestigial (name is canonical on
        // the master), but copy it through so older code paths that
        // read line.name display the new name.
        name: linked ? linkedName : newName,
        offsetDx: offsetMM, offsetDy: offsetMM
      });
      bucket.lines.push(newLine);
      if (cid === state.classId) firstNewLineIdInCurrentClass = newLine.id;
    });

    if (firstNewLineIdInCurrentClass) selectOnly(firstNewLineIdInCurrentClass);
    state.dirty = true;
    snapshot();
    renderAll();
  }

  async function duplicateGroupAction(groupId, opts) {
    const linked = !!(opts && opts.linked);
    const offsetMM = 20;
    const srcGroup = state.groups.find(function (g) { return g.id === groupId; });
    if (!srcGroup) return;
    const srcLines = state.lines.filter(function (l) { return l.groupId === srcGroup.id; });

    // Target-class set: classes that hold a same-named group as
    // the source. (Groups link across classes by name.)
    let targetClassIds;
    if (modeIsAll()) {
      const present = [];
      const missing = [];
      (state.pageConfig.useClasses || []).forEach(function (cid) {
        const b = state.byClass[cid];
        if (!b || !Array.isArray(b.groups)) { missing.push(cid); return; }
        const has = b.groups.some(function (g) { return g.name === srcGroup.name; });
        (has ? present : missing).push(cid);
      });
      if (missing.length === 0) {
        targetClassIds = present;
      } else {
        const choice = await askSpreadScope(present, missing, 'group');
        if (!choice) return;
        targetClassIds = choice === 'mirror' ? present : (state.pageConfig.useClasses || []).slice();
      }
    } else {
      targetClassIds = [state.classId];
    }
    if (!targetClassIds.length) return;

    const newGroupName = uniqueGroupName(srcGroup.name || 'group');

    // Old-master → new-master remap. Empty for linked (no new masters).
    // For new-master mode, one new master per unique source master.
    const masterMap = {};
    if (!linked) {
      srcLines.forEach(function (srcLine) {
        const srcMid = srcLine.masterId;
        if (!srcMid || masterMap[srcMid]) return;
        const srcMaster = state.masters.find(function (m) { return m.id === srcMid; });
        if (!srcMaster) return;
        const newMaster = cloneMasterRecord(srcMaster, uniqueObjectName(srcMaster.name || 'object'));
        state.masters.push(newMaster);
        masterMap[srcMid] = newMaster.id;
      });
    }

    let firstNewGroupIdInCurrentClass = null;
    targetClassIds.forEach(function (cid) {
      const bucket = state.byClass[cid];
      if (!bucket || !Array.isArray(bucket.groups) || !Array.isArray(bucket.lines)) return;
      const newGroup = {
        id: uid('g'),
        name: newGroupName,
        trigger: srcGroup.trigger || null,
        defaults: deepCopy(srcGroup.defaults || {})
      };
      bucket.groups.push(newGroup);
      if (cid === state.classId) firstNewGroupIdInCurrentClass = newGroup.id;

      // Find the source-group's peer in THIS class (same name) so we
      // can pick up each line's per-class overrides from this class's
      // instance of the relevant master.
      const peerSrcGroup = (bucket.groups || []).find(function (g) {
        return g.name === srcGroup.name && g.id !== newGroup.id;
      });

      srcLines.forEach(function (srcLine) {
        const srcMid = srcLine.masterId;
        // Template line in this class. Prefer the same-named peer
        // group's instance of this master; fall back to srcLine
        // (force-spread case).
        let template = null;
        if (peerSrcGroup) {
          template = bucket.lines.find(function (l) {
            return l.groupId === peerSrcGroup.id && l.masterId === srcMid;
          });
        }
        if (!template) template = srcLine;
        const newMid = linked ? srcMid : masterMap[srcMid];
        if (!newMid) return;  // No master + new-master mode → skip
        const newLine = cloneLineRecord(template, {
          masterId: newMid,
          groupId:  newGroup.id,
          offsetDx: offsetMM, offsetDy: offsetMM
        });
        // Internal cross-refs rewrite: only matters when masterMap is
        // non-empty (i.e. new-master mode). In linked mode the refs
        // already point to the originals, which IS the duplicate's
        // intended target.
        rewriteBehaviorRefs(newLine, masterMap);
        bucket.lines.push(newLine);
      });
    });

    if (firstNewGroupIdInCurrentClass) {
      state.activeGroupId = firstNewGroupIdInCurrentClass;
      state.openGroupIds[firstNewGroupIdInCurrentClass] = true;
    }
    clearSelection();
    state.dirty = true;
    snapshot();
    renderAll();
  }

  function addGroup() {
    // 'all' mode: a new group fans out across every class with the
    // same name (each class gets its own id). 'one' mode: just
    // this class — useful for class-specific groupings that the
    // other classes shouldn't carry.
    const name = 'Group ' + (state.groups.length + 1);
    const tmpl = {
      name: name,
      trigger: null,
      behaviorTemplateObjectId: null, // v0.8.219
      defaults: {}                    // v0.8.226: behavior fallbacks removed
    };
    let activeIdForCurrentClass = null;
    const fanout = modeIsAll() ? state.pageConfig.useClasses : [state.classId];
    fanout.forEach(function (cid) {
      const bucket = state.byClass[cid];
      if (!bucket || !Array.isArray(bucket.groups)) return;
      const g = Object.assign({ id: uid('g') }, tmpl);
      bucket.groups.push(g);
      if (cid === state.classId) activeIdForCurrentClass = g.id;
    });
    if (activeIdForCurrentClass) state.activeGroupId = activeIdForCurrentClass;
    clearSelection();
    state.dirty = true;
    snapshot();
    renderAll();
  }

  /**
   * Delete a group.
   *   alsoDeleteLines = false  → re-home the group's lines into the
   *                              first remaining group (preserve them).
   *   alsoDeleteLines = true   → delete the group AND every line it
   *                              owns.
   *
   * If `id` is the last group, it's replaced with a fresh default so
   * the editor always has at least one group to receive new lines.
   */
  function deleteGroup(id, alsoDeleteLines) {
    if (alsoDeleteLines) {
      // 'all' mode: cascade site-wide via masterId — every class
      // loses these objects. 'one' mode: drop lines from THIS class
      // only; sibling classes keep their instances + the masters
      // survive. The GROUP entity itself is class-local in both
      // cases (deleteGroup affects state.groups for the current
      // class only). The group's name peers in other classes
      // survive — emptied if 'all', untouched if 'one'.
      const targetMasterIds = new Set();
      const looseInstanceIds = new Set();
      state.lines.forEach(function (l) {
        if (l.groupId !== id) return;
        if (l.masterId) targetMasterIds.add(l.masterId);
        else            looseInstanceIds.add(l.id);
      });
      const cidsToTouch = modeIsAll()
        ? state.pageConfig.useClasses
        : [state.classId];
      cidsToTouch.forEach(function (cid) {
        const bucket = state.byClass[cid];
        if (!bucket || !Array.isArray(bucket.lines)) return;
        bucket.lines = bucket.lines.filter(function (l) {
          if (l.masterId && targetMasterIds.has(l.masterId)) return false;
          if (cid === state.classId && looseInstanceIds.has(l.id)) return false;
          return true;
        });
      });
      // Only prune masters when the cascade reached every class.
      // 'one' mode leaves masters alone (siblings still reference
      // them).
      if (modeIsAll()) {
        state.masters = state.masters.filter(function (m) {
          return !targetMasterIds.has(m.id);
        });
      }
    }
    if (state.groups.length > 1) {
      state.groups = state.groups.filter(function (g) { return g.id !== id; });
      const fallback = state.groups[0].id;
      // Re-home any surviving lines that still point at the deleted group.
      state.lines.forEach(function (l) { if (l.groupId === id) l.groupId = fallback; });
      if (state.activeGroupId === id) state.activeGroupId = fallback;
    } else {
      // Deleting the only group — replace it with a fresh default so
      // surviving (or future) lines have somewhere to live.
      const replacement = defaultGroup();
      state.groups = [replacement];
      state.lines.forEach(function (l) { l.groupId = replacement.id; });
      state.activeGroupId = replacement.id;
    }
    state.openGroupIds = {};
    state.openGroupIds[state.activeGroupId] = true;
    clearSelection();
    // v0.8.219: re-home and group-replacement above may leave template
    // refs pointing at lines now in a different group. Clear stale ones.
    pruneGroupTemplateRefs();
    state.dirty = true;
    snapshot();
    renderAll();
  }

  function updateGroup(id, patch) {
    const g = state.groups.find(function (g) { return g.id === id; });
    if (!g) return;
    // Capture the pre-patch name BEFORE applying — peer lookup is
    // by name, and the patch might be a rename. Without this a
    // rename couldn't find its siblings.
    const peerName = g.name;
    Object.assign(g, patch);
    // In 'all' mode, mirror the patch onto same-named groups in
    // every other class. Lets the user rename or flip visibility
    // on what is conceptually one group across the site, not have
    // to walk every class manually. 'one' mode keeps the change
    // local. (Note: groups are per-class structurally — the patch
    // applies to whatever same-name peer exists; no peer = no-op.)
    if (modeIsAll()) {
      forSiblingGroupsByName(peerName, function (peer) {
        Object.assign(peer, patch);
      });
    }
    state.dirty = true;
    // Only refresh the sidebar (group name, line count). Do NOT re-render
    // the selection panel — that would destroy the input the user is
    // typing into and steal focus.
    renderGroupsList();
    scheduleSnapshot();
  }

  function updateGroupDefaults(id, patch) {
    const g = state.groups.find(function (g) { return g.id === id; });
    if (!g) return;
    // v0.8.64: in ALL mode, mirror onto same-named groups in every
    // other class — analogous to updateGroup's existing fan-out for
    // name / hidden changes. Without this, ALL mode left group
    // defaults (translateX/Y, rotate, stroke, width, drawIn,
    // rotateOriginX/Y) inconsistent across classes despite the
    // user's explicit "edit applies everywhere" intent.
    const peerName = g.name;
    g.defaults = Object.assign({}, g.defaults, patch);
    if (modeIsAll()) {
      forSiblingGroupsByName(peerName, function (peer) {
        peer.defaults = Object.assign({}, peer.defaults, patch);
      });
    }
    state.dirty = true;
    // Stroke/width default changes affect canvas rendering of every line
    // that doesn't override them.
    if ('stroke' in patch || 'width' in patch) renderLines();
    // Booleans / discrete picks snapshot immediately; numeric / text
    // fields coalesce so undo doesn't step through every keystroke.
    if (typeof patch[Object.keys(patch)[0]] === 'boolean') snapshot();
    else scheduleSnapshot();
  }

  // v0.8.219: set/clear the behavior-template object for a group.
  // The picker only allows objects that are themselves in the group,
  // so the caller is expected to validate lineId belongs to g.id (or
  // pass null to clear). In ALL mode, the intent fans out to same-
  // name peer groups: each peer adopts the masterId-matching sibling
  // line in its own class, if one exists in that peer group. Peers
  // without a matching member leave their template untouched (we
  // don't auto-clear — the user may have set a different valid
  // template there, and overwriting silently is worse than leaving
  // a divergence).
  function updateGroupBehaviorTemplate(groupId, lineId) {
    const g = state.groups.find(function (gr) { return gr.id === groupId; });
    if (!g) return;
    // Local validation: lineId must be null OR a member of this group.
    if (lineId) {
      const ln = state.lines.find(function (l) { return l.id === lineId; });
      if (!ln || ln.groupId !== g.id) return;
    }
    g.behaviorTemplateObjectId = lineId || null;
    if (modeIsAll()) {
      const srcLine = lineId
        ? state.lines.find(function (l) { return l.id === lineId; })
        : null;
      const srcMid = srcLine && srcLine.masterId;
      const peerName = g.name;
      forSiblingGroupsByName(peerName, function (peer, peerClassId) {
        if (!lineId) {
          peer.behaviorTemplateObjectId = null;
          return;
        }
        if (!srcMid) return; // can't resolve sibling without a master link
        const peerBucket = state.byClass[peerClassId];
        if (!peerBucket || !Array.isArray(peerBucket.lines)) return;
        const peerLine = peerBucket.lines.find(function (l) {
          return l.masterId === srcMid && l.groupId === peer.id;
        });
        if (peerLine) peer.behaviorTemplateObjectId = peerLine.id;
        // else: leave the peer's existing template alone (see comment).
      });
    }
    state.dirty = true;
    snapshot();
    renderGroupsList();
    renderLines();
  }

  // v0.8.219: drop any group.behaviorTemplateObjectId references that
  // point at a line which (a) no longer exists in this class or (b)
  // is no longer a member of the referring group. Called after any
  // mutation that could leave a stale reference: line delete, line
  // group-reassignment, group delete (re-home).
  function pruneGroupTemplateRefs() {
    const useClasses = (state.pageConfig && state.pageConfig.useClasses) || [];
    let touched = false;
    useClasses.forEach(function (cid) {
      const bucket = state.byClass[cid];
      if (!bucket || !Array.isArray(bucket.groups)) return;
      const lineById = {};
      (bucket.lines || []).forEach(function (l) { lineById[l.id] = l; });
      bucket.groups.forEach(function (g) {
        const tid = g.behaviorTemplateObjectId;
        if (!tid) return;
        const ln = lineById[tid];
        if (!ln || ln.groupId !== g.id) {
          g.behaviorTemplateObjectId = null;
          touched = true;
        }
      });
    });
    return touched;
  }

  function updateLine(id, patch) {
    const l = state.lines.find(function (l) { return l.id === id; });
    if (!l) return;
    Object.assign(l, patch);
    // Geometry-affecting fields require regenerating `d` so the canvas
    // (and the live site after save) reflects the new path shape.
    if ('smoothed' in patch || 'closed' in patch) regenerateLineD(l);
    // In 'all' mode, instance-level fields like `hidden` mirror onto
    // every sibling-class instance of the same master. Smoothed /
    // closed go through regenerateLineD's propagation already so we
    // skip them here. masterId and groupId are class-local by
    // design and not synced.
    if (modeIsAll() && l.masterId && 'hidden' in patch) {
      forSiblingsOf(l.masterId, function (sib) {
        sib.hidden = patch.hidden;
      });
    }
    state.dirty = true;
    renderLines();
    if ('name' in patch) renderGroupsList();
    if (typeof patch[Object.keys(patch)[0]] === 'boolean') snapshot();
    else scheduleSnapshot();
  }

  // Edit a single behavior key on the FIRST block of a line's
  // behaviors[] array. Creates the block if the array is empty.
  // v0.4.0 wires the existing per-line Behavior section to block
  // 0; multi-block authoring (range / kind editing, add/remove)
  // comes in v0.4.1.
  function updateBehaviorParam(id, key, value, blockIdx) {
    blockIdx = blockIdx || 0;
    const l = state.lines.find(function (l) { return l.id === id; });
    if (!l) return;
    writeBehaviorParam(l, key, value, blockIdx);
    // 'all' mode fan-out: every sibling-class instance of this
    // master gets the same edit, on the same block index. If the
    // sibling has fewer blocks (shouldn't happen for v0.4.0 since
    // migration mints parallel arrays, but defensive), we extend
    // its behaviors[] up to blockIdx.
    if (modeIsAll() && l.masterId) {
      forSiblingsOf(l.masterId, function (sib) {
        writeBehaviorParam(sib, key, value, blockIdx);
      });
    }
    state.dirty = true;
    renderGroupsList();
    // v0.8.20: drift summary line reads translateMode + translateX/Y.
    // The translateMode picker triggers a full re-render itself, but
    // the translateX/Y number fields don't (their onInput keeps focus
    // mid-edit, by design). Refresh the per-block summary so the
    // drift line text stays live as the user types.
    // v0.8.167: path-follow keys read by the summary too — pathRef
    // (which guide), pathAlignToTangent, pathEndMode. None of these
    // controls (selectField / checkboxField) trigger a re-render of
    // their own, so the summary was stale until something else forced
    // a re-render. Add them to the refresh list.
    if (key === 'translateX'   || key === 'translateY'   || key === 'translateMode' ||
        key === 'pathRef'      || key === 'pathRefName'  ||
        key === 'pathAlignToTangent' || key === 'pathEndMode') {
      refreshBehaviorSummary(id, blockIdx);
    }
    if (typeof value === 'boolean' || value === null) snapshot();
    else scheduleSnapshot();
  }
  function writeBehaviorParam(line, key, value, blockIdx) {
    if (!Array.isArray(line.behaviors)) line.behaviors = [];
    while (line.behaviors.length <= blockIdx) {
      line.behaviors.push(newBehaviorBlock());
    }
    const block = line.behaviors[blockIdx];
    if (!block.params) block.params = {};
    if (value === '' || value === null || (typeof value === 'number' && isNaN(value))) {
      delete block.params[key];
    } else {
      block.params[key] = value;
    }
    // v0.4.1: don't auto-trim blocks anymore. With multi-block
    // authoring the user explicitly removes blocks via the ✕
    // button; auto-trimming empty trailing blocks would silently
    // delete user-added blocks that haven't been filled in yet.
  }

  // ── Behavior block lifecycle (v0.4.1) ───────────────────────────
  // Add / remove / range-edit. Each goes through scope-mode fan-out
  // for siblings of the same master in 'all' mode.

  // v0.8.158: Session-only set of block IDs where the "Also control
  // other objects" side-effects section has been deliberately opened.
  // Auto-shows when startObjectId or stopObjectId is already set so
  // existing configurations are never hidden.
  const behaviorShowSideEffects = new Set();

  // v0.8.196: Session-only set of master IDs whose TEXT section has
  // been deliberately opened. Auto-shows when master.text.value is
  // non-empty so existing text overlays are never hidden. Closing
  // (via the [×] button on the section title) wipes master.text and
  // removes the flag, returning the property to absent.
  const showTextSection = new Set();

  // v0.8.154: Session-only phase map for progressive disclosure.
  // 0 = fresh (trigger picker only, no active button);
  // 1 = trigger chosen (trigger options visible);
  // 2 = trigger options done (progress picker + start/stop objects visible);
  // 3 = progress chosen (progress options + effects visible).
  // Existing blocks default to 3 (fully expanded) so saved configs
  // are unaffected. Keys are block.id strings; values 0–3.
  const behaviorBlockPhases = {};
  function getBlockPhase(blockId) {
    return Object.prototype.hasOwnProperty.call(behaviorBlockPhases, blockId)
      ? behaviorBlockPhases[blockId] : 3;
  }
  // Explicitly set phase — used by back buttons to go to a previous step.
  // Unlike advanceBlockPhase this can decrease the phase.
  function setBlockPhase(blockId, phase) {
    behaviorBlockPhases[blockId] = phase;
  }
  function advanceBlockPhase(blockId, minPhase) {
    // Fallback must match getBlockPhase (3 = fully expanded for existing
    // blocks). Using 0 here caused existing blocks to regress to phase 1
    // the first time any trigger button was clicked in a session: the
    // block was absent from the map, hasOwnProperty returned false,
    // cur defaulted to 0, and advanceBlockPhase(id, 1) wrote 1 into the
    // map — hiding everything below phase 1 on the next render.
    const cur = Object.prototype.hasOwnProperty.call(behaviorBlockPhases, blockId)
      ? behaviorBlockPhases[blockId] : 3;
    if (minPhase > cur) behaviorBlockPhases[blockId] = minPhase;
  }

  function addBehaviorBlock(lineId) {
    const l = state.lines.find(function (l) { return l.id === lineId; });
    if (!l) return;
    pushNewBlock(l);
    // v0.8.153: tag the new block as phase 0 (progressive disclosure
    // starts at trigger-only). Only the block on `l` — sibling copies
    // in other classes are already-existing from the user's perspective
    // and default to phase 2 via getBlockPhase.
    if (Array.isArray(l.behaviors) && l.behaviors.length) {
      const nb = l.behaviors[l.behaviors.length - 1];
      if (nb && nb.id) behaviorBlockPhases[nb.id] = 0;
    }
    if (modeIsAll() && l.masterId) {
      forSiblingsOf(l.masterId, function (sib) { pushNewBlock(sib); });
    }
    state.dirty = true;
    snapshot();
    renderSelectionPanel();
  }
  function pushNewBlock(line) {
    if (!Array.isArray(line.behaviors)) line.behaviors = [];
    line.behaviors.push(newBehaviorBlock());
  }
  function removeBehaviorBlock(lineId, blockIdx) {
    const l = state.lines.find(function (l) { return l.id === lineId; });
    if (!l || !Array.isArray(l.behaviors) || blockIdx >= l.behaviors.length) return;
    l.behaviors.splice(blockIdx, 1);
    if (modeIsAll() && l.masterId) {
      forSiblingsOf(l.masterId, function (sib) {
        if (Array.isArray(sib.behaviors) && blockIdx < sib.behaviors.length) {
          sib.behaviors.splice(blockIdx, 1);
        }
      });
    }
    state.dirty = true;
    snapshot();
    renderSelectionPanel();
  }
  // v0.8.28: reorder behavior blocks via drag handle. toIdx is the
  // insertion index in the PRE-move array — i.e. blockIdx values
  // the user sees in the panel, not post-splice positions, so
  // fromIdx → toIdx reads as "place this block at slot toIdx".
  // Same all-mode fan-out as add/remove.
  function moveBehaviorBlock(lineId, fromIdx, toIdx) {
    const l = state.lines.find(function (l) { return l.id === lineId; });
    if (!l || !Array.isArray(l.behaviors)) return;
    if (fromIdx < 0 || fromIdx >= l.behaviors.length) return;
    if (toIdx < 0) toIdx = 0;
    if (toIdx > l.behaviors.length) toIdx = l.behaviors.length;
    // No-op: dropping a block right where it already sits (either
    // its own slot, or the slot just after it, which means "before
    // the next block" — same final position).
    if (fromIdx === toIdx || fromIdx === toIdx - 1) return;
    spliceAndRemapBehavior(l, fromIdx, toIdx);
    if (modeIsAll() && l.masterId) {
      forSiblingsOf(l.masterId, function (sib) {
        if (Array.isArray(sib.behaviors) && fromIdx < sib.behaviors.length) {
          const sibTo = Math.min(toIdx, sib.behaviors.length);
          spliceAndRemapBehavior(sib, fromIdx, sibTo);
        }
      });
    }
    state.dirty = true;
    snapshot();
    renderSelectionPanel();
  }
  function spliceAndRemapBehavior(line, fromIdx, toIdx) {
    // Snapshot pre-move id order so we can rebuild oldIdx → newIdx
    // lookups for any cross-block index reference (today: loopTo's
    // duration.target). Block.id is stable across the reorder, so
    // findIndex on the new array gives the post-move position.
    const idsBefore = line.behaviors.map(function (b) { return b.id; });
    const moved = line.behaviors.splice(fromIdx, 1)[0];
    const insertAt = (toIdx > fromIdx) ? toIdx - 1 : toIdx;
    line.behaviors.splice(insertAt, 0, moved);
    const newIdxOfOld = {};
    line.behaviors.forEach(function (b, i) {
      const oldIdx = idsBefore.indexOf(b.id);
      if (oldIdx !== -1) newIdxOfOld[oldIdx] = i;
    });
    // Remap loopTo targets. If the remapped target is no longer
    // earlier than the loopTo block itself, the reference is now
    // invalid (target must precede the loop) — drop it; the editor
    // will show the dropdown unselected and the runtime treats
    // missing target as a no-op snapshot.
    line.behaviors.forEach(function (b, i) {
      if (!b.duration || b.duration.mode !== 'loopTo') return;
      if (!Number.isInteger(b.duration.target)) return;
      const remapped = newIdxOfOld[b.duration.target];
      if (remapped == null || remapped >= i) {
        delete b.duration.target;
      } else {
        b.duration.target = remapped;
      }
    });
  }
  // Behavior block field writers. v0.8.7 split — trigger.when /
  // trigger.range / trigger.selector / trigger.delay vs
  // duration.mode / duration.seconds / duration.easing.

  function updateBehaviorTrigger(lineId, blockIdx, key, value) {
    const l = state.lines.find(function (l) { return l.id === lineId; });
    if (!l) return;
    writeBehaviorTrigger(l, blockIdx, key, value);
    if (modeIsAll() && l.masterId) {
      forSiblingsOf(l.masterId, function (sib) {
        writeBehaviorTrigger(sib, blockIdx, key, value);
      });
    }
    state.dirty = true;
    scheduleSnapshot();
    // Changing trigger.when toggles which secondary inputs are
    // available; re-render so the right ones appear and the
    // greyed-out duration options update. viewportAt also goes
    // through re-render so its button-group active state flips.
    // v0.8.244: 'direction' joins the same list — same reason
    // (button-group, is-active class only set at build time). Without
    // the re-render the chip highlight stays on the previous choice
    // even though the underlying data did update, which made the
    // feature look broken (user thought direction wasn't saving and
    // therefore that the runtime filter was ignored).
    if (key === 'when' || key === 'viewportAt' || key === 'repeat'
        || key === 'startObjectId' || key === 'stopObjectId'
        || key === 'direction') {
      renderSelectionPanel();
    } else {
      refreshBehaviorSummary(lineId, blockIdx);
    }
  }
  function writeBehaviorTrigger(line, blockIdx, key, value) {
    if (!Array.isArray(line.behaviors) || blockIdx >= line.behaviors.length) return;
    const b = line.behaviors[blockIdx];
    if (!b.trigger || typeof b.trigger !== 'object') {
      b.trigger = { when: 'scroll-range', range: { start: 0, end: 1 }, delay: 0 };
    }
    if (key === 'when') {
      b.trigger.when = value;
      // Seed missing fields per activation type.
      if (value === 'scroll-range' && !b.trigger.range) {
        b.trigger.range = { start: 0, end: 1 };
      }
      if (value === 'scroll-key' && !b.trigger.selector) {
        b.trigger.selector = '';
      }
      if (value === 'scroll-key' && !b.trigger.viewportAt) {
        b.trigger.viewportAt = 'middle';
      }
      if (typeof b.trigger.delay !== 'number') b.trigger.delay = 0;
      // Auto-flip duration if the previous combination is now
      // invalid (only valid invalidation today: scroll duration
      // requires scroll-range activation).
      if (b.duration && b.duration.mode === 'scroll' && value !== 'scroll-range') {
        b.duration = { mode: 'time', seconds: 1 };
      }
      // v0.8.84: treatAsFilled is only meaningful for click /
      // hover triggers — strip it when leaving those.
      if (value !== 'click' && value !== 'hover') {
        delete b.trigger.treatAsFilled;
      }
      // v0.8.243: direction filter is scroll-start-only — strip when
      // leaving so the data doesn't carry stale orientation.
      if (value !== 'scroll-start') {
        delete b.trigger.direction;
      }
    } else if (key === 'direction') {
      // v0.8.243: 'both' is the absent / no-filter case — don't store it
      // (keeps legacy data shape clean). 'down' / 'up' both stored.
      const v = String(value || 'both');
      if (v === 'down' || v === 'up') b.trigger.direction = v;
      else delete b.trigger.direction;
    } else if (key === 'selector') {
      b.trigger.selector = String(value || '');
    } else if (key === 'viewportAt') {
      b.trigger.viewportAt = String(value || 'middle');
    } else if (key === 'repeat') {
      b.trigger.repeat = String(value || 'once');
    } else if (key === 'delay' || key === 'rangeStart' || key === 'rangeEnd') {
      let v = Number(value);
      if (!Number.isFinite(v)) v = 0;
      if (key === 'delay') {
        b.trigger.delay = Math.max(0, v);
      } else {
        if (!b.trigger.range) b.trigger.range = { start: 0, end: 1 };
        v = Math.max(0, Math.min(1, v));
        b.trigger.range[key === 'rangeStart' ? 'start' : 'end'] = v;
      }
    } else if (key === 'startObjectId' || key === 'stopObjectId') {
      // v0.8.79: target a class (masterId). Empty string clears the
      // slot. Clearing stopObjectId also drops its sub-fields — they
      // only mean anything paired with a target.
      if (value === '' || value == null) {
        delete b.trigger[key];
        if (key === 'stopObjectId') {
          delete b.trigger.stopFadeOut;
          delete b.trigger.stopReturnHome;
          delete b.trigger.stopDurationSec;
          delete b.trigger.stopEasing;
        }
      } else {
        b.trigger[key] = String(value);
      }
    } else if (key === 'stopFadeOut' || key === 'stopReturnHome') {
      if (value) b.trigger[key] = true;
      else       delete b.trigger[key];
    } else if (key === 'treatAsFilled') {
      // v0.8.84: easy-hit opt-in. Only meaningful for click /
      // hover; harmless to carry on other when's but cleaner to
      // strip — see updateBehaviorTrigger 'when' branch below
      // (clears it when when changes away from pointer triggers).
      if (value) b.trigger.treatAsFilled = true;
      else       delete b.trigger.treatAsFilled;
    } else if (key === 'stopDurationSec') {
      let v = Number(value);
      if (!Number.isFinite(v) || v < 0) v = 0;
      b.trigger.stopDurationSec = v;
    } else if (key === 'stopEasing') {
      if (!value || value === 'linear') delete b.trigger.stopEasing;
      else b.trigger.stopEasing = String(value);
    }
  }

  function updateBehaviorDuration(lineId, blockIdx, key, value) {
    const l = state.lines.find(function (l) { return l.id === lineId; });
    if (!l) return;
    writeBehaviorDuration(l, blockIdx, key, value);
    if (modeIsAll() && l.masterId) {
      forSiblingsOf(l.masterId, function (sib) {
        writeBehaviorDuration(sib, blockIdx, key, value);
      });
    }
    state.dirty = true;
    scheduleSnapshot();
    if (key === 'mode') {
      renderSelectionPanel();
    } else {
      refreshBehaviorSummary(lineId, blockIdx);
    }
  }
  function writeBehaviorDuration(line, blockIdx, key, value) {
    if (!Array.isArray(line.behaviors) || blockIdx >= line.behaviors.length) return;
    const b = line.behaviors[blockIdx];
    if (!b.duration || typeof b.duration !== 'object') {
      b.duration = { mode: 'scroll' };
    }
    if (key === 'mode') {
      b.duration.mode = value;
      if (value !== 'scroll' && typeof b.duration.seconds !== 'number') {
        b.duration.seconds = 1;
      }
      if (value === 'scroll') {
        delete b.duration.seconds;
      }
      // v0.8.23: loopTo needs a target index. Seed with the
      // earliest time-mode block before this one so the user
      // sees a working default; if they wanted a different
      // target they can pick from the dropdown.
      if (value === 'loopTo') {
        if (!Number.isInteger(b.duration.target)) {
          for (let j = 0; j < blockIdx; j++) {
            const bj = line.behaviors[j];
            const bjm = bj && bj.duration && bj.duration.mode;
            if (bjm === 'time') { b.duration.target = j; break; }
          }
        }
      } else {
        // Switching away from loopTo: clear loopTo-only fields so
        // the data model doesn't carry stale config on a block
        // that no longer uses them. Re-entering loopTo re-seeds.
        delete b.duration.target;
        delete b.duration.maxIterations;
      }
    } else if (key === 'seconds') {
      let v = Number(value);
      if (!Number.isFinite(v) || v <= 0) v = 0.01;
      b.duration.seconds = v;
    } else if (key === 'easing') {
      if (!value || value === 'linear' || value === 'none') {
        delete b.duration.easing;
      } else {
        b.duration.easing = String(value);
      }
    } else if (key === 'target') {
      // v0.8.23: loopTo target = index of an earlier block.
      const v = Math.floor(Number(value));
      if (Number.isInteger(v) && v >= 0 && v < blockIdx) {
        b.duration.target = v;
      } else {
        delete b.duration.target;
      }
    } else if (key === 'maxIterations') {
      // 0 / blank / non-positive = run forever (clear the cap).
      const v = Math.floor(Number(value));
      if (Number.isFinite(v) && v > 0) {
        b.duration.maxIterations = v;
      } else {
        delete b.duration.maxIterations;
      }
    }
  }
  // Detect overlapping ranges among a behaviors[] array. Open
  // overlap only — blocks touching at a single point (a.end ===
  // b.start) don't count.
  // Overlap detection — only meaningful between scroll-driven
  // blocks (trigger.when=scroll-range + duration.mode=scroll, the
  // only combination that shares a scroll timeline). Any other
  // activation/duration combo has its own timeline and can't
  // meaningfully "overlap" with a scroll range.
  function findBehaviorOverlaps(blocks) {
    const out = [];
    if (!Array.isArray(blocks)) return out;
    const isScrollDriven = function (b) {
      const when = b.trigger && b.trigger.when;
      const mode = b.duration && b.duration.mode;
      return when === 'scroll-range' && mode === 'scroll';
    };
    const rangeOf = function (b) {
      return (b.trigger && b.trigger.range) || { start: 0, end: 1 };
    };
    for (let i = 0; i < blocks.length; i++) {
      if (!isScrollDriven(blocks[i])) continue;
      const a = rangeOf(blocks[i]);
      for (let j = i + 1; j < blocks.length; j++) {
        if (!isScrollDriven(blocks[j])) continue;
        const b = rangeOf(blocks[j]);
        if (a.start < b.end && b.start < a.end) out.push({ a: i, b: j });
      }
    }
    return out;
  }

  // ── Rendering ─────────────────────────────────────────────────────

  /**
   * Push state.page values onto the SVG: recompute the viewBox, the
   * <svg> width/height (at zoom 1.0, then re-applied by setZoom),
   * the background outer + page rectangles, the page-area grid, and
   * the diagnostic grid bounds. Called on first paint and after any
   * Canvas-panel edit.
   */
  function applyPageConfig() {
    const pw = state.page.pageW, ph = state.page.pageH;
    const cw = state.page.canvasW, ch = state.page.canvasH;
    const vbx = -(cw - pw) / 2;
    const vby = -(ch - ph) / 2;
    svg.setAttribute('viewBox', vbx + ' ' + vby + ' ' + cw + ' ' + ch);
    svg.setAttribute('width',  cw);
    svg.setAttribute('height', ch);
    svg.style.width  = (cw * state.zoom) + 'px';
    svg.style.height = (ch * state.zoom) + 'px';

    const outer = svg.querySelector('.bg-outer');
    if (outer) {
      outer.setAttribute('x', vbx); outer.setAttribute('y', vby);
      outer.setAttribute('width', cw); outer.setAttribute('height', ch);
    }
    const pageRect = svg.querySelector('.bg-page');
    if (pageRect) {
      pageRect.setAttribute('width', pw);
      pageRect.setAttribute('height', ph);
    }

    renderGrid();
    renderDiagGrid();
  }

  function createPath(cls, d) {
    const p = document.createElementNS(SVG_NS, 'path');
    if (cls) p.setAttribute('class', cls);
    if (d)   p.setAttribute('d', d);
    return p;
  }

  // Per-page Canvas panel (sidebar): pageW/H + canvasW/H number inputs
  // that re-render the canvas live and mark dirty for Save. Kept
  // intentionally validation-light — invalid combos (e.g. canvasW <
  // pageW) produce a weird-looking but non-crashing canvas, and the
  // user can correct via the same panel.
  const canvasFieldsEl = document.getElementById('canvas-fields');
  function renderCanvasPanel() {
    if (!canvasFieldsEl) return;
    canvasFieldsEl.innerHTML = '';
    const labels = {
      pageW:   'Page width',
      pageH:   'Page height',
      canvasW: 'Canvas width',
      canvasH: 'Canvas height'
    };
    ['pageW', 'pageH', 'canvasW', 'canvasH'].forEach(function (key) {
      canvasFieldsEl.appendChild(numberField(labels[key], state.page[key], function (v) {
        if (!Number.isFinite(v) || v <= 0) return; // ignore mid-edit garbage
        state.page[key] = v;
        state.dirty = true;
        applyPageConfig();
        scheduleSnapshot();
      }));
    });
    // v0.8.99: editor-wide nudge step for arrow-key moves. Not page
    // data (doesn't go in snapshots), just an editor preference — but
    // physically lives in the canvas panel because it's about
    // canvas-coordinate units, not appearance toggles.
    canvasFieldsEl.appendChild(numberField('Nudge step (mm)', state.nudgeStepMM, function (v) {
      if (!Number.isFinite(v) || v <= 0) return;
      state.nudgeStepMM = v;
      try { localStorage.setItem('ed-nudge-step-mm', String(v)); } catch (e) {}
    }));
    // v0.8.110: floating-panel system launcher (Step 1 stub). Until
    // real panel types are migrated in subsequent steps, this single
    // button opens the demo panel so the user can validate drag /
    // resize / pin / close / per-class persistence end-to-end.
    const launchRow = document.createElement('div');
    launchRow.style.marginTop = '0.5rem';
    launchRow.style.paddingTop = '0.5rem';
    launchRow.style.borderTop = '1px dashed #3a3a3a';
    const launchBtn = document.createElement('button');
    launchBtn.type = 'button';
    launchBtn.className = 'ed-mini';
    launchBtn.textContent = '🪟 Demo floating panel';
    launchBtn.title = 'Open the Step-1 demo panel — validates the floating-panel framework. Drag the header to move, drag the corner to resize, 📌 to pin to the current selection, ✕ to close. Position persists per class.';
    launchBtn.addEventListener('click', function () {
      if (window.PanelManager) window.PanelManager.open('demo');
    });
    launchRow.appendChild(launchBtn);
    canvasFieldsEl.appendChild(launchRow);
  }

  /**
   * Switch the active class. Live aliases (state.lines / .groups /
   * .page) auto-flip via their getters; we just need to refresh the
   * UI: canvas geometry, sidebar lists, selection state, and the
   * tab-active styling. Tab clicks come here AND so does the
   * remembered-class restore on init.
   */
  function switchClass(newClassId) {
    if (!newClassId || newClassId === state.classId) return;
    if (!state.byClass[newClassId]) return; // unknown class — ignore
    // Drop any in-flight tool state — chain anchors / bezier handles
    // are coordinates in the OLD class's logical space and have no
    // meaning in the new one.
    state.chainPoints  = null;
    state.bezierPoints = null;
    previewG.innerHTML = '';
    // Map the current selection's instance IDs to masterIds before
    // we flip the class — same object has a different instance id in
    // each class, but the masterId is shared, so we can re-select the
    // counterpart in the new class. Lets the user tweak an object
    // across classes without losing their place.
    const oldLines = (state.byClass[state.classId] && state.byClass[state.classId].lines) || [];
    const selectedMasterIds = state.selectedIds
      .map(function (id) {
        const l = oldLines.find(function (x) { return x.id === id; });
        return l ? l.masterId : null;
      })
      .filter(function (mid) { return mid != null; });
    // v0.8.69: also capture the active GROUP's name before the
    // class flip. Groups have per-class ids but share names across
    // classes (forSiblingGroupsByName uses that), so name is the
    // cross-class identity. Without this, switching class would
    // lose the active group selection in the no-line-selected case.
    const oldGroups = (state.byClass[state.classId] && state.byClass[state.classId].groups) || [];
    const activeGroupName = state.activeGroupId
      ? ((oldGroups.find(function (g) { return g.id === state.activeGroupId; }) || {}).name) || null
      : null;
    state.classId = newClassId;
    try { localStorage.setItem('ed-last-class', newClassId); } catch (e) {}
    // Re-select counterparts in the new class. Any masters that don't
    // have an instance here just drop out silently.
    const newLines = (state.byClass[newClassId] && state.byClass[newClassId].lines) || [];
    state.selectedIds = newLines
      .filter(function (l) { return selectedMasterIds.indexOf(l.masterId) !== -1; })
      .map(function (l) { return l.id; });
    if (state.selectedIds.length) {
      const first = newLines.find(function (l) { return l.id === state.selectedIds[0]; });
      state.activeGroupId = (first && first.groupId) || null;
    } else if (activeGroupName) {
      // No line selection but we had a group active — find the
      // same-named group in the new class.
      const newGroups = (state.byClass[newClassId] && state.byClass[newClassId].groups) || [];
      const peer = newGroups.find(function (g) { return g.name === activeGroupName; });
      state.activeGroupId = peer ? peer.id : null;
    } else {
      // Neither selection nor active group followed over → leave
      // activeGroupId null so the selection panel stays neutral.
      state.activeGroupId = null;
    }
    // openGroupIds is global (keyed by class-scoped group ids), so
    // it naturally persists each class's expanded state across
    // switches. Don't wipe + re-seed it — let the user's per-class
    // memory carry forward. Standard sidebar UX: rows stay where
    // the user left them.
    applyPageConfig();
    renderCanvasPanel();
    renderAll();
    centerOnPage();
    // Tab styling.
    document.querySelectorAll('.ed-class-tab').forEach(function (b) {
      const on = b.dataset.classId === state.classId;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    // v0.8.110: floating panels are keyed per (pageId, classId).
    // Tear the current set down and rebuild from the new class's
    // persisted snapshot so each class remembers its own layout.
    if (window.PanelManager) {
      try { window.PanelManager.restore(); } catch (e) { console.error(e); }
    }
  }

  /**
   * Cherry-pick clone dialog. User picks a source class + which of
   * its groups to bring across; on apply, each picked group either
   * REPLACES a same-name group in the current class (the group's
   * lines are wholesale swapped) or ADDS as a new group when no
   * name match exists. Class dims stay untouched. Snapshots so the
   * action is undoable.
   */
  /**
   * Master library overlay — full-canvas modal listing every master
   * in the site, one row per master with a preview, name, class-
   * usage chips, scope summary, and a delete button. Search filters
   * by name (substring, case-insensitive). Delete cascades site-
   * wide through deleteLinesByMasterIds (one instance id from any
   * class is enough to land all of them).
   *
   * v0.6.0 MVP. Inline rename + per-key scope flippers + sort
   * options are queued for a follow-up.
   */
  // v0.8.34: snapshots dialog — save/load named copies of every
  // content/* file via the dev/draw/library/{list,save,load} routes.
  // Each snapshot is a folder under /library/ with a meta.json
  // (savedAt, appVersion, schemaVersion) and a recursive copy of
  // content/. Load refuses on schemaVersion mismatch — the bump
  // signal that the on-disk shape has changed and the snapshot is
  // no longer structurally compatible.
  // v0.8.174: optional onBack callback — when launched from the Project
  // hub, a Back chip in the header re-opens the hub on cleanup.
  function showSnapshotsDialog(onBack) {
    const overlay = document.createElement('div');
    overlay.className = 'ed-modal-overlay';
    const modal = document.createElement('div');
    modal.className = 'ed-modal ed-snapshots-modal';

    const head = document.createElement('div');
    head.className = 'ed-modal-header';
    if (typeof onBack === 'function') {
      const back = document.createElement('button');
      back.type = 'button';
      back.className = 'ed-project-back';
      back.innerHTML = '‹ Back';
      back.title = 'Back to Project hub';
      // .ed-modal-header has no gap (unlike .ed-project-header), so
      // the chip would sit flush against the title — add inline spacing.
      back.style.marginRight = '0.5rem';
      back.addEventListener('click', function () { cleanup(); onBack(); });
      head.appendChild(back);
    }
    const title = document.createElement('h3');
    title.textContent = 'Snapshots';
    head.appendChild(title);
    const x = document.createElement('button');
    x.className = 'ed-modal-close'; x.textContent = '×';
    x.style.marginLeft = 'auto';
    x.addEventListener('click', cleanup);
    head.appendChild(x);
    modal.appendChild(head);

    const body = document.createElement('div');
    body.className = 'ed-modal-body ed-snapshots-body';
    const saveRow = document.createElement('div');
    saveRow.className = 'ed-snapshots-save';
    const saveLabel = document.createElement('span');
    saveLabel.textContent = 'Save current content as:';
    const saveInput = document.createElement('input');
    saveInput.type = 'text';
    saveInput.placeholder = 'snapshot name';
    saveInput.maxLength = 80;
    const saveBtnEl = document.createElement('button');
    saveBtnEl.type = 'button';
    saveBtnEl.className = 'ed-primary';
    saveBtnEl.textContent = 'Save snapshot';
    saveBtnEl.addEventListener('click', function () { doSave(saveInput.value); });
    saveInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') doSave(saveInput.value);
    });
    saveRow.appendChild(saveLabel);
    saveRow.appendChild(saveInput);
    saveRow.appendChild(saveBtnEl);
    body.appendChild(saveRow);

    const status = document.createElement('div');
    status.className = 'ed-snapshots-status';
    body.appendChild(status);

    const list = document.createElement('div');
    list.className = 'ed-snapshots-list';
    body.appendChild(list);

    modal.appendChild(body);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    function cleanup() {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
    }
    function onKey(e) { if (e.key === 'Escape') cleanup(); }
    document.addEventListener('keydown', onKey);
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) cleanup();
    });

    function setStatus(msg, isError) {
      status.textContent = msg || '';
      status.classList.toggle('is-error', !!isError);
    }

    async function refresh() {
      list.innerHTML = '';
      setStatus('Loading…');
      try {
        const res = await fetch('/dev/draw/library/list');
        const body = await res.json().catch(function () { return {}; });
        if (!res.ok || !body.ok) throw new Error(body.error || 'HTTP ' + res.status);
        setStatus('');
        const snaps = body.snapshots || [];
        if (!snaps.length) {
          const empty = document.createElement('div');
          empty.className = 'ed-snapshots-empty';
          empty.textContent = 'No snapshots yet. Save one above.';
          list.appendChild(empty);
          return;
        }
        snaps.forEach(function (s) { list.appendChild(buildRow(s, body.schemaVersion)); });
      } catch (err) {
        setStatus('Failed to load list: ' + err.message, true);
      }
    }

    function buildRow(snap, currentSchema) {
      const row = document.createElement('div');
      row.className = 'ed-snapshots-row';
      const loadBtn = document.createElement('button');
      loadBtn.type = 'button';
      loadBtn.className = 'ed-snapshots-load';
      loadBtn.textContent = 'Load';
      const schemaMismatch = (snap.schemaVersion !== currentSchema);
      if (schemaMismatch) {
        loadBtn.disabled = true;
        loadBtn.title = 'Snapshot schema v' + snap.schemaVersion
          + ' is incompatible with current schema v' + currentSchema;
      }
      loadBtn.addEventListener('click', function () { doLoad(snap.name); });
      row.appendChild(loadBtn);
      const meta = document.createElement('div');
      meta.className = 'ed-snapshots-meta';
      const nm = document.createElement('div');
      nm.className = 'ed-snapshots-name';
      nm.textContent = snap.name;
      meta.appendChild(nm);
      const sub = document.createElement('div');
      sub.className = 'ed-snapshots-sub';
      const when = snap.savedAt ? new Date(snap.savedAt).toLocaleString() : '(unknown date)';
      const ver  = snap.appVersion ? 'v' + snap.appVersion : '';
      const sch  = (snap.schemaVersion != null) ? ' · schema ' + snap.schemaVersion
        + (schemaMismatch ? ' (incompatible)' : '') : '';
      sub.textContent = when + (ver ? ' · ' + ver : '') + sch;
      meta.appendChild(sub);
      row.appendChild(meta);
      return row;
    }

    async function doSave(name) {
      name = String(name || '').trim();
      if (!name) { setStatus('Enter a name first.', true); saveInput.focus(); return; }
      setStatus('Saving…');
      saveBtnEl.disabled = true;
      try {
        const res = await fetch('/dev/draw/library/save', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: name })
        });
        const body = await res.json().catch(function () { return {}; });
        if (!res.ok || !body.ok) throw new Error(body.error || 'HTTP ' + res.status);
        saveInput.value = '';
        setStatus('Saved snapshot "' + name + '".');
        await refresh();
      } catch (err) {
        setStatus('Save failed: ' + err.message, true);
      } finally {
        saveBtnEl.disabled = false;
      }
    }

    async function doLoad(name) {
      const dirtyWarn = state.dirty
        ? '\n\nYou have unsaved edits — they will be discarded.' : '';
      if (!window.confirm('Replace current content files with snapshot "' + name + '"?' + dirtyWarn)) return;
      setStatus('Loading "' + name + '"…');
      try {
        const res = await fetch('/dev/draw/library/load', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: name })
        });
        const body = await res.json().catch(function () { return {}; });
        if (!res.ok || !body.ok) throw new Error(body.error || 'HTTP ' + res.status);
        setStatus('Loaded. Reloading editor…');
        // The editor's in-memory state is stale now; the simplest
        // way to pick up the restored content/ is a hard reload.
        // Mark dirty=false first so the beforeunload handler doesn't
        // prompt about losing changes that no longer matter.
        state.dirty = false;
        setTimeout(function () { location.reload(); }, 400);
      } catch (err) {
        setStatus('Load failed: ' + err.message, true);
      }
    }

    refresh();
    saveInput.focus();
  }

  // v0.8.43: orphan detection + "Find orphans" maintenance dialog.
  // Three categories, conservative semantics:
  //   - Masters in state.masters that no class has an instance of.
  //   - Palette colors not referenced by any master.stroke,
  //     line.stroke, line.overrides.stroke, or group.defaults.stroke.
  //   - Per-class groups with zero lines (listed but opt-in via
  //     checkbox since empty groups are often intentional).
  function findOrphans() {
    const masterUsage = {};
    const colorUsage  = {};
    // v0.8.44: also detect "orphan instances" — lines whose
    // masterId doesn't resolve to a master, or whose groupId
    // doesn't resolve to a group in the same class. These are
    // the dangling refs that the user's initial concern was
    // about (instances surviving the deletion of their master /
    // group). Indexed by class for the dialog's per-class layout.
    const masterIdSet = {};
    (state.masters || []).forEach(function (m) { masterIdSet[m.id] = true; });
    const orphanInstancesByClass = {};
    Object.keys(state.byClass).forEach(function (cid) {
      const bucket = state.byClass[cid];
      if (!bucket) return;
      const groupIdSet = {};
      (bucket.groups || []).forEach(function (g) { groupIdSet[g.id] = true; });
      const dangling = [];
      (bucket.lines || []).forEach(function (line) {
        if (line.masterId) masterUsage[line.masterId] = (masterUsage[line.masterId] || 0) + 1;
        if (line.stroke)   colorUsage[line.stroke]    = (colorUsage[line.stroke]    || 0) + 1;
        if (line.overrides && line.overrides.stroke) {
          colorUsage[line.overrides.stroke] = (colorUsage[line.overrides.stroke] || 0) + 1;
        }
        const reasons = [];
        if (line.masterId && !masterIdSet[line.masterId]) {
          reasons.push('master ' + line.masterId + ' missing');
        }
        if (line.groupId && !groupIdSet[line.groupId]) {
          reasons.push('group ' + line.groupId + ' missing');
        }
        if (reasons.length) dangling.push({ line: line, reasons: reasons });
      });
      (bucket.groups || []).forEach(function (g) {
        if (g.defaults && g.defaults.stroke) {
          colorUsage[g.defaults.stroke] = (colorUsage[g.defaults.stroke] || 0) + 1;
        }
      });
      if (dangling.length) orphanInstancesByClass[cid] = dangling;
    });
    (state.masters || []).forEach(function (m) {
      if (m.stroke) colorUsage[m.stroke] = (colorUsage[m.stroke] || 0) + 1;
    });
    const orphanMasters = (state.masters || []).filter(function (m) {
      return !(masterUsage[m.id] > 0);
    });
    const orphanColors = (state.palette || []).filter(function (c) {
      return !(colorUsage[c.id] > 0);
    });
    const emptyGroupsByClass = {};
    Object.keys(state.byClass).forEach(function (cid) {
      const bucket = state.byClass[cid];
      if (!bucket) return;
      const lineCounts = {};
      (bucket.lines || []).forEach(function (l) {
        if (l.groupId) lineCounts[l.groupId] = (lineCounts[l.groupId] || 0) + 1;
      });
      const empties = (bucket.groups || []).filter(function (g) {
        return !(lineCounts[g.id] > 0);
      });
      if (empties.length) emptyGroupsByClass[cid] = empties;
    });
    return {
      masters: orphanMasters,
      colors:  orphanColors,
      emptyGroupsByClass: emptyGroupsByClass,
      orphanInstancesByClass: orphanInstancesByClass
    };
  }

  // v0.8.174: optional onBack callback — when launched from the Project
  // hub, a Back chip in the header re-opens the hub on cleanup.
  function showOrphansDialog(onBack) {
    const overlay = document.createElement('div');
    overlay.className = 'ed-modal-overlay';
    const modal = document.createElement('div');
    modal.className = 'ed-modal ed-orphans-modal';

    const head = document.createElement('div');
    head.className = 'ed-modal-header';
    if (typeof onBack === 'function') {
      const back = document.createElement('button');
      back.type = 'button';
      back.className = 'ed-project-back';
      back.innerHTML = '‹ Back';
      back.title = 'Back to Project hub';
      // .ed-modal-header has no gap (unlike .ed-project-header), so
      // the chip would sit flush against the title — add inline spacing.
      back.style.marginRight = '0.5rem';
      back.addEventListener('click', function () { cleanup(); onBack(); });
      head.appendChild(back);
    }
    const title = document.createElement('h3');
    title.textContent = 'Find orphans';
    head.appendChild(title);
    const x = document.createElement('button');
    x.className = 'ed-modal-close'; x.textContent = '×';
    x.style.marginLeft = 'auto';
    x.addEventListener('click', cleanup);
    head.appendChild(x);
    modal.appendChild(head);

    const body = document.createElement('div');
    body.className = 'ed-modal-body ed-orphans-body';
    modal.appendChild(body);

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    function cleanup() {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
    }
    function onKey(e) { if (e.key === 'Escape') cleanup(); }
    document.addEventListener('keydown', onKey);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) cleanup(); });

    // Track which empty groups the user has opted in to remove
    // (checkbox state). Persisted across re-renders.
    const groupCheckState = {}; // cid|gid → boolean

    function render() {
      body.innerHTML = '';
      const orphans = findOrphans();
      const nothing = !orphans.masters.length
                   && !orphans.colors.length
                   && !Object.keys(orphans.emptyGroupsByClass).length
                   && !Object.keys(orphans.orphanInstancesByClass).length;
      if (nothing) {
        const ok = document.createElement('div');
        ok.className = 'ed-orphans-empty';
        ok.textContent = 'No orphans found. Everything in state.* is referenced.';
        body.appendChild(ok);
        return;
      }

      // ── Orphan masters ─────────────────────────────────────────
      if (orphans.masters.length) {
        body.appendChild(buildSection(
          'Orphan masters',
          orphans.masters.length + ' master record' + (orphans.masters.length === 1 ? '' : 's')
            + ' with no instances in any class.',
          function (removeAllBtn) {
            removeAllBtn.addEventListener('click', function () {
              if (!confirm('Remove all ' + orphans.masters.length + ' orphan masters?')) return;
              const ids = orphans.masters.map(function (m) { return m.id; });
              state.masters = state.masters.filter(function (m) { return ids.indexOf(m.id) === -1; });
              commit();
            });
          },
          orphans.masters.map(function (m) {
            return {
              label: m.name || m.id,
              sub:   m.id + ' · ' + (m.kind || 'unknown'),
              onRemove: function () {
                state.masters = state.masters.filter(function (x) { return x.id !== m.id; });
                commit();
              }
            };
          })
        ));
      }

      // ── Unused colors ──────────────────────────────────────────
      if (orphans.colors.length) {
        body.appendChild(buildSection(
          'Unused colors',
          orphans.colors.length + ' palette color' + (orphans.colors.length === 1 ? '' : 's')
            + ' not referenced anywhere.',
          function (removeAllBtn) {
            removeAllBtn.addEventListener('click', function () {
              if (!confirm('Remove all ' + orphans.colors.length + ' unused colors?')) return;
              const ids = orphans.colors.map(function (c) { return c.id; });
              state.palette = state.palette.filter(function (c) { return ids.indexOf(c.id) === -1; });
              commit();
            });
          },
          orphans.colors.map(function (c) {
            return {
              swatch: c.value,
              label:  c.name || c.id,
              sub:    c.value,
              onRemove: function () {
                state.palette = state.palette.filter(function (x) { return x.id !== c.id; });
                commit();
              }
            };
          })
        ));
      }

      // ── Orphan instances (dangling refs) ───────────────────────
      // v0.8.44: lines that have a masterId or groupId that doesn't
      // resolve. The user's original concern was about exactly this
      // category — instances that survive the deletion of what they
      // referenced and end up stranded in the on-disk class files.
      const instKeys = Object.keys(orphans.orphanInstancesByClass);
      if (instKeys.length) {
        const totalInst = instKeys.reduce(function (s, cid) {
          return s + orphans.orphanInstancesByClass[cid].length;
        }, 0);
        const section = document.createElement('div');
        section.className = 'ed-orphans-section';
        const head = document.createElement('div');
        head.className = 'ed-orphans-section-head';
        const h = document.createElement('h4');
        h.textContent = 'Orphan instances (' + totalInst + ')';
        head.appendChild(h);
        const removeAllBtn = document.createElement('button');
        removeAllBtn.type = 'button';
        removeAllBtn.className = 'ed-mini ed-danger';
        removeAllBtn.textContent = 'Remove all';
        removeAllBtn.addEventListener('click', function () {
          if (!confirm('Remove all ' + totalInst + ' orphan instance'
                       + (totalInst === 1 ? '' : 's') + '?')) return;
          instKeys.forEach(function (cid) {
            const bucket = state.byClass[cid];
            if (!bucket || !Array.isArray(bucket.lines)) return;
            const ids = orphans.orphanInstancesByClass[cid].map(function (x) { return x.line.id; });
            bucket.lines = bucket.lines.filter(function (l) { return ids.indexOf(l.id) === -1; });
          });
          commit();
        });
        head.appendChild(removeAllBtn);
        section.appendChild(head);
        const note = document.createElement('p');
        note.className = 'ed-orphans-note';
        note.textContent = 'Lines whose masterId or groupId no longer resolves. '
          + 'Safe to remove — the references are already broken.';
        section.appendChild(note);
        instKeys.forEach(function (cid) {
          const cls = state.classes.find(function (c) { return c.id === cid; });
          const clsLabel = (cls && cls.name) ? cls.name : cid;
          const sub = document.createElement('div');
          sub.className = 'ed-orphans-subhead';
          sub.textContent = clsLabel;
          section.appendChild(sub);
          orphans.orphanInstancesByClass[cid].forEach(function (entry) {
            const row = document.createElement('div');
            row.className = 'ed-orphans-row';
            const labelWrap = document.createElement('div');
            labelWrap.className = 'ed-orphans-labels';
            const nm = document.createElement('div');
            nm.className = 'ed-orphans-name';
            nm.textContent = entry.line.name || entry.line.id;
            labelWrap.appendChild(nm);
            const s = document.createElement('div');
            s.className = 'ed-orphans-sub';
            s.textContent = entry.line.id + ' · ' + entry.reasons.join(', ');
            labelWrap.appendChild(s);
            row.appendChild(labelWrap);
            const rmBtn = document.createElement('button');
            rmBtn.type = 'button';
            rmBtn.className = 'ed-mini ed-danger';
            rmBtn.textContent = 'Remove';
            rmBtn.addEventListener('click', function () {
              const bucket = state.byClass[cid];
              if (!bucket || !Array.isArray(bucket.lines)) return;
              bucket.lines = bucket.lines.filter(function (l) { return l.id !== entry.line.id; });
              commit();
            });
            row.appendChild(rmBtn);
            section.appendChild(row);
          });
        });
        body.appendChild(section);
      }

      // ── Empty groups ───────────────────────────────────────────
      const groupKeys = Object.keys(orphans.emptyGroupsByClass);
      if (groupKeys.length) {
        const section = document.createElement('div');
        section.className = 'ed-orphans-section';
        const h = document.createElement('h4');
        const total = groupKeys.reduce(function (s, cid) {
          return s + orphans.emptyGroupsByClass[cid].length;
        }, 0);
        h.textContent = 'Empty groups (' + total + ')';
        section.appendChild(h);
        const note = document.createElement('p');
        note.className = 'ed-orphans-note';
        note.textContent = 'Empty groups are often intentional (a placeholder you'
          + ' plan to fill). Tick only the ones you want removed.';
        section.appendChild(note);
        groupKeys.forEach(function (cid) {
          const cls = state.classes.find(function (c) { return c.id === cid; });
          const clsLabel = (cls && cls.name) ? cls.name : cid;
          const sub = document.createElement('div');
          sub.className = 'ed-orphans-subhead';
          sub.textContent = clsLabel;
          section.appendChild(sub);
          orphans.emptyGroupsByClass[cid].forEach(function (g) {
            const key = cid + '|' + g.id;
            const row = document.createElement('label');
            row.className = 'ed-orphans-row ed-orphans-row-check';
            const chk = document.createElement('input');
            chk.type = 'checkbox';
            chk.checked = !!groupCheckState[key];
            chk.addEventListener('change', function () { groupCheckState[key] = chk.checked; });
            row.appendChild(chk);
            const nm = document.createElement('span');
            nm.className = 'ed-orphans-name';
            nm.textContent = g.name || g.id;
            row.appendChild(nm);
            section.appendChild(row);
          });
        });
        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'ed-mini ed-danger';
        removeBtn.textContent = 'Remove checked';
        removeBtn.addEventListener('click', function () {
          const todo = []; // [{cid, gid}]
          Object.keys(groupCheckState).forEach(function (key) {
            if (!groupCheckState[key]) return;
            const i = key.indexOf('|');
            if (i < 0) return;
            todo.push({ cid: key.slice(0, i), gid: key.slice(i + 1) });
          });
          if (!todo.length) { alert('No groups checked.'); return; }
          if (!confirm('Remove ' + todo.length + ' empty group' + (todo.length === 1 ? '' : 's') + '?')) return;
          todo.forEach(function (t) {
            const bucket = state.byClass[t.cid];
            if (!bucket || !Array.isArray(bucket.groups)) return;
            bucket.groups = bucket.groups.filter(function (g) { return g.id !== t.gid; });
          });
          Object.keys(groupCheckState).forEach(function (k) { delete groupCheckState[k]; });
          commit();
        });
        section.appendChild(removeBtn);
        body.appendChild(section);
      }
    }

    function buildSection(heading, summary, wireRemoveAll, items) {
      const section = document.createElement('div');
      section.className = 'ed-orphans-section';
      const head = document.createElement('div');
      head.className = 'ed-orphans-section-head';
      const h = document.createElement('h4');
      h.textContent = heading + ' (' + items.length + ')';
      head.appendChild(h);
      const removeAllBtn = document.createElement('button');
      removeAllBtn.type = 'button';
      removeAllBtn.className = 'ed-mini ed-danger';
      removeAllBtn.textContent = 'Remove all';
      head.appendChild(removeAllBtn);
      wireRemoveAll(removeAllBtn);
      section.appendChild(head);
      if (summary) {
        const p = document.createElement('p');
        p.className = 'ed-orphans-note';
        p.textContent = summary;
        section.appendChild(p);
      }
      items.forEach(function (it) {
        const row = document.createElement('div');
        row.className = 'ed-orphans-row';
        if (it.swatch) {
          const sw = document.createElement('span');
          sw.className = 'ed-orphans-swatch';
          sw.style.background = it.swatch;
          row.appendChild(sw);
        }
        const labelWrap = document.createElement('div');
        labelWrap.className = 'ed-orphans-labels';
        const nm = document.createElement('div');
        nm.className = 'ed-orphans-name';
        nm.textContent = it.label;
        labelWrap.appendChild(nm);
        if (it.sub) {
          const s = document.createElement('div');
          s.className = 'ed-orphans-sub';
          s.textContent = it.sub;
          labelWrap.appendChild(s);
        }
        row.appendChild(labelWrap);
        const rmBtn = document.createElement('button');
        rmBtn.type = 'button';
        rmBtn.className = 'ed-mini ed-danger';
        rmBtn.textContent = 'Remove';
        rmBtn.addEventListener('click', function () { it.onRemove(); });
        row.appendChild(rmBtn);
        section.appendChild(row);
      });
      return section;
    }

    function commit() {
      state.dirty = true;
      snapshot();
      renderAll();
      render(); // re-detect + re-render the orphans list
    }

    render();
  }

  // v0.8.177: hoisted out of the Project hub closure so the Overview
  // panel can reuse the same per-master vignette (visual continuity
  // between Master library and Overview rows). Inputs: a master-like
  // object with `kind`, optional `params`/`points`/`segments`, `stroke`,
  // `filled`, `linejoin`. Output: a `.ed-library-preview` wrapper div
  // containing either an SVG path fit-scaled into a viewBox, or a
  // placeholder glyph for image/empty cases.
  function buildPreview(master) {
    const wrap = document.createElement('div');
    wrap.className = 'ed-library-preview';
    if (master.kind === 'image') {
      wrap.classList.add('is-placeholder');
      wrap.textContent = '🖼';
      return wrap;
    }
    const tmp = Object.assign({ d: '' }, master);
    try { computeLineD(tmp); } catch (e) { /* let d stay empty */ }
    if (!tmp.d) {
      wrap.classList.add('is-placeholder');
      wrap.textContent = '·';
      return wrap;
    }
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', previewViewBox(tmp));
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', tmp.d);
    const stroke = resolveStroke(master.stroke || 'text') || 'currentColor';
    p.setAttribute('stroke', stroke);
    p.setAttribute('stroke-width', '2');
    p.setAttribute('vector-effect', 'non-scaling-stroke');
    p.setAttribute('fill', master.filled ? stroke : 'none');
    p.setAttribute('stroke-linejoin', master.linejoin || 'round');
    p.setAttribute('stroke-linecap', 'round');
    svg.appendChild(p);
    wrap.appendChild(svg);
    return wrap;
  }

  function previewViewBox(line) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const eat = function (x, y) {
      if (x < minX) minX = x; if (y < minY) minY = y;
      if (x > maxX) maxX = x; if (y > maxY) maxY = y;
    };
    if (line.params) {
      const p = line.params;
      if ('cx' in p && 'cy' in p) {
        const r = p.r || Math.max(p.rx || 0, p.ry || 0) || 1;
        eat(p.cx - r, p.cy - r); eat(p.cx + r, p.cy + r);
      } else if ('x' in p && 'y' in p && 'w' in p && 'h' in p) {
        eat(p.x, p.y); eat(p.x + p.w, p.y + p.h);
      }
    }
    if (Array.isArray(line.points)) {
      line.points.forEach(function (pt) { eat(pt.x, pt.y); });
    }
    if (Array.isArray(line.segments)) {
      line.segments.forEach(function (s) {
        if (s.endpoint) eat(s.endpoint.x, s.endpoint.y);
      });
    }
    if (!Number.isFinite(minX)) { minX = 0; minY = 0; maxX = 100; maxY = 100; }
    const w = Math.max(1, maxX - minX);
    const h = Math.max(1, maxY - minY);
    const pad = Math.max(w, h) * 0.1;
    return (minX - pad) + ' ' + (minY - pad) + ' ' +
           (w + pad * 2) + ' ' + (h + pad * 2);
  }

  // v0.8.173: Project hub modal (formerly the Library modal). Provides
  // a 4-tile home view that routes to: Master library, Overview,
  // Orphans, Snapshots. Master library is rendered inline as a level-2
  // sub-section with a Back button; Overview is stubbed pending its
  // dedicated panel build (slice 2). Orphans and Snapshots tiles still
  // launch their existing sibling overlays for now — folding them in as
  // inline sub-sections is a later slice. The top-right × always closes
  // the whole project modal regardless of which view is active.
  function showProjectDialog() {
    const overlay = document.createElement('div');
    overlay.className = 'ed-modal-overlay';
    const modal = document.createElement('div');
    modal.className = 'ed-modal ed-project-modal';

    // Header — title swaps between "Project" (home) and the active
    // sub-section title; a Back button appears in sub-section views.
    const head = document.createElement('div');
    head.className = 'ed-modal-header ed-project-header';

    const backBtn = document.createElement('button');
    backBtn.type = 'button';
    backBtn.className = 'ed-project-back';
    backBtn.innerHTML = '‹ Back';
    backBtn.title = 'Back to Project hub';
    backBtn.style.display = 'none';
    backBtn.addEventListener('click', function () { setView('home'); });
    head.appendChild(backBtn);

    const title = document.createElement('h3');
    title.textContent = 'Project';
    head.appendChild(title);

    // Master-library sub-section needs class-filter buttons in the
    // header — created once and shown/hidden on view change.
    let classFilter = null;
    const filterButtons = [];
    const filterRow = document.createElement('div');
    filterRow.className = 'ed-library-filter';
    filterRow.style.display = 'none';
    const addFilterBtn = function (label, cid) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ed-library-filter-btn' + (classFilter === cid ? ' is-active' : '');
      b.textContent = label;
      b.title = cid
        ? 'Show only masters with an instance in ' + label
        : 'Show every master';
      b.addEventListener('click', function () {
        classFilter = cid;
        filterButtons.forEach(function (entry) {
          entry.el.classList.toggle('is-active', entry.cid === classFilter);
        });
        renderRows();
      });
      filterButtons.push({ el: b, cid: cid });
      filterRow.appendChild(b);
    };
    addFilterBtn('All', null);
    state.pageConfig.useClasses.forEach(function (cid) {
      const cls = state.classes.find(function (c) { return c.id === cid; });
      addFilterBtn(cls ? cls.name : cid, cid);
    });
    head.appendChild(filterRow);

    const close = document.createElement('button');
    close.className = 'ed-modal-close'; close.textContent = '×';
    close.addEventListener('click', cleanup);
    head.appendChild(close);
    modal.appendChild(head);

    const body = document.createElement('div');
    body.className = 'ed-modal-body ed-project-body';
    modal.appendChild(body);

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    // Sub-section refs used by Master library renderer (created lazily
    // when the masters view mounts; kept as closure locals so renderRows
    // can target them).
    let search = null;
    let list = null;

    setView('home');

    function setView(view) {
      body.innerHTML = '';
      if (view === 'home') {
        title.textContent = 'Project';
        backBtn.style.display = 'none';
        filterRow.style.display = 'none';
        mountHomeView();
        return;
      }
      backBtn.style.display = '';
      if (view === 'masters') {
        title.textContent = 'Master library';
        filterRow.style.display = '';
        mountMastersView();
      }
      // v0.8.176: 'overview' is no longer a Project-hub sub-section —
      // it opens as a separate panel above the hub via showOverviewPanel.
    }

    function mountHomeView() {
      const grid = document.createElement('div');
      grid.className = 'ed-project-tiles';

      const addTile = function (label, hint, onClick) {
        const tile = document.createElement('button');
        tile.type = 'button';
        tile.className = 'ed-project-tile';
        const lab = document.createElement('div');
        lab.className = 'ed-project-tile-label';
        lab.textContent = label;
        tile.appendChild(lab);
        const sub = document.createElement('div');
        sub.className = 'ed-project-tile-hint';
        sub.textContent = hint;
        tile.appendChild(sub);
        tile.addEventListener('click', onClick);
        grid.appendChild(tile);
        return tile;
      };

      addTile('Master library',
        'Browse every master across the site — usage chips per class, scope summary, delete canonical objects.',
        function () { setView('masters'); });
      addTile('Overview',
        'Read-only behaviors review across the whole design (single-class default, diff mode opt-in).',
        // v0.8.176: Overview lives in its OWN panel stacked above the
        // Project hub (not as a sub-section inside it). The hub stays
        // in the DOM behind it so Back returns to the hub without
        // rebuilding state. The hub's overlay reference is passed in
        // so the panel can hide-and-resume both layers on jump-to-canvas.
        function () { showOverviewPanel(overlay); });
      addTile('Orphans',
        'Detect masters with no instances, unused palette colors, empty groups, and dangling refs.',
        function () { cleanup(); showOrphansDialog(showProjectDialog); });
      addTile('Snapshots',
        'Save / load named copies of every content file.',
        function () { cleanup(); showSnapshotsDialog(showProjectDialog); });

      body.appendChild(grid);
    }

    function mountMastersView() {
      body.classList.add('ed-library-body');
      search = document.createElement('input');
      search.type = 'search';
      search.placeholder = 'Filter by name…';
      search.className = 'ed-library-search';
      search.addEventListener('input', renderRows);
      body.appendChild(search);

      list = document.createElement('div');
      list.className = 'ed-library-list';
      body.appendChild(list);

      renderRows();
      search.focus();
    }

    function renderRows() {
      // Filter-button clicks can fire renderRows before the masters
      // sub-section has been mounted (or after switching back to home).
      // Bail safely in those cases.
      if (!list || !search) return;
      list.innerHTML = '';
      const query = search.value.trim().toLowerCase();
      const masters = state.masters
        .filter(function (m) { return m && m.id; })
        .filter(function (m) {
          if (!classFilter) return true;
          const bucket = state.byClass[classFilter];
          if (!bucket || !Array.isArray(bucket.lines)) return false;
          return bucket.lines.some(function (l) { return l.masterId === m.id; });
        })
        .filter(function (m) {
          if (!query) return true;
          const name = String(m.name || '').toLowerCase();
          return name.indexOf(query) !== -1;
        });
      // Stable name sort so the user can scan alphabetically.
      masters.sort(function (a, b) {
        return String(a.name || a.id).localeCompare(String(b.name || b.id));
      });
      if (!masters.length) {
        const empty = document.createElement('div');
        empty.className = 'ed-library-empty';
        const parts = [];
        if (query) parts.push('matching "' + query + '"');
        if (classFilter) {
          const cls = state.classes.find(function (c) { return c.id === classFilter; });
          parts.push('present in ' + (cls ? cls.name : classFilter));
        }
        empty.textContent = parts.length
          ? 'No masters ' + parts.join(' and ') + '.'
          : 'No masters yet. Create or import an object to populate the library.';
        list.appendChild(empty);
        return;
      }
      masters.forEach(function (m) { list.appendChild(buildRow(m)); });
    }

    function buildRow(master) {
      const row = document.createElement('div');
      row.className = 'ed-library-row';
      // Click the row → jump to an instance. Prefer the active
      // class; otherwise the first class that has the master.
      // Closes the modal, switches class if needed, selects the
      // line. Delete button below stops propagation so it can't
      // accidentally jump-then-delete.
      row.addEventListener('click', function () {
        const targetClassId = pickClassWithMaster(master.id);
        if (!targetClassId) {
          // Orphan master (no instances in any class) — leave the
          // modal open; nothing to select. User can delete from
          // here if they want.
          return;
        }
        cleanup();
        if (targetClassId !== state.classId) {
          switchClass(targetClassId);
        }
        const bucket = state.byClass[targetClassId];
        const inst = bucket && bucket.lines.find(function (l) { return l.masterId === master.id; });
        if (!inst) return;
        // Open the instance's group so the line panel renders and
        // the sidebar's line list expands underneath it.
        if (inst.groupId) {
          state.activeGroupId = inst.groupId;
          state.openGroupIds[inst.groupId] = true;
        }
        selectOnly(inst.id);
        // switchClass already rendered (possibly) — but selectOnly
        // doesn't touch the DOM, so the selection visuals + line
        // panel need a fresh paint regardless of whether we
        // switched class.
        renderAll();
      });

      // Preview — small SVG fitting the master's bbox into a fixed
      // square. Falls back to a "no preview" placeholder for
      // image-kind or shapes without `d`.
      row.appendChild(buildPreview(master));

      const meta = document.createElement('div');
      meta.className = 'ed-library-meta';
      const name = document.createElement('div');
      name.className = 'ed-library-name';
      name.textContent = master.name || master.id;
      meta.appendChild(name);
      const id = document.createElement('div');
      id.className = 'ed-library-id';
      id.textContent = master.id + ' · ' + (master.kind || 'unknown');
      meta.appendChild(id);

      // Class-usage chips.
      const chips = document.createElement('div');
      chips.className = 'ed-library-chips';
      const usage = countMasterUsage(master.id);
      let totalUsage = 0;
      state.pageConfig.useClasses.forEach(function (cid) {
        const cls = state.classes.find(function (c) { return c.id === cid; });
        const label = cls ? cls.name : cid;
        const count = usage[cid] || 0;
        totalUsage += count;
        const chip = document.createElement('span');
        chip.className = 'ed-library-chip' + (count === 0 ? ' is-absent' : '');
        chip.textContent = label + (count > 1 ? ' ×' + count : '');
        chip.title = count === 0
          ? 'Not present in ' + label
          : count + ' instance' + (count === 1 ? '' : 's') + ' in ' + label;
        chips.appendChild(chip);
      });
      // v0.8.43: dim the whole row + add a "0 instances" badge when
      // the master has no instances anywhere. Surfaces orphan
      // masters without needing to open the Find-orphans dialog;
      // the dialog still handles bulk cleanup.
      if (totalUsage === 0) {
        row.classList.add('is-orphan');
        const badge = document.createElement('span');
        badge.className = 'ed-library-chip ed-library-chip-orphan';
        badge.textContent = '0 instances';
        badge.title = 'No instances anywhere — orphan master, safe to delete.';
        chips.appendChild(badge);
      }
      meta.appendChild(chips);

      // Scope summary.
      const scopeKeys = master.scope && typeof master.scope === 'object'
        ? Object.keys(master.scope) : [];
      const scope = document.createElement('div');
      scope.className = 'ed-library-scope';
      if (scopeKeys.length) {
        scope.textContent = 'Local: ' + scopeKeys.join(', ');
      } else {
        scope.textContent = 'All canonical';
        scope.classList.add('is-default');
      }
      meta.appendChild(scope);

      row.appendChild(meta);

      // Actions — delete only in this MVP.
      const actions = document.createElement('div');
      actions.className = 'ed-library-actions';
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'ed-mini ed-danger';
      del.textContent = 'Delete';
      del.title = 'Delete this master and every instance in every class.';
      del.addEventListener('click', function (e) {
        e.stopPropagation();
        const total = Object.values(usage).reduce(function (s, n) { return s + n; }, 0);
        if (!confirm('Delete "' + (master.name || master.id) + '"? ' +
                     'This removes ' + total + ' instance' + (total === 1 ? '' : 's') +
                     ' across every class.')) return;
        // Find any instance id to pass to deleteLinesByMasterIds —
        // that helper resolves the masterId from it and cascades.
        let sampleLineId = null;
        let sampleClassId = state.classId;
        state.pageConfig.useClasses.some(function (cid) {
          const bucket = state.byClass[cid];
          if (!bucket) return false;
          const inst = (bucket.lines || []).find(function (l) { return l.masterId === master.id; });
          if (inst) { sampleLineId = inst.id; sampleClassId = cid; return true; }
          return false;
        });
        if (sampleLineId) {
          deleteLinesByMasterIds([sampleLineId], sampleClassId);
        } else {
          // Master with no instances anywhere — orphan; drop directly.
          state.masters = state.masters.filter(function (x) { return x.id !== master.id; });
          state.dirty = true;
          snapshot();
          renderAll();
        }
        renderRows();
      });
      actions.appendChild(del);
      row.appendChild(actions);

      return row;
    }

    // v0.8.177: buildPreview / previewViewBox hoisted to module scope
    // so showOverviewPanel can reuse them. See module-level definitions.

    function countMasterUsage(masterId) {
      const counts = {};
      state.pageConfig.useClasses.forEach(function (cid) {
        const bucket = state.byClass[cid];
        if (!bucket || !Array.isArray(bucket.lines)) return;
        counts[cid] = bucket.lines.filter(function (l) {
          return l.masterId === masterId;
        }).length;
      });
      return counts;
    }

    // Pick a class that has at least one instance of this master.
    // Prefer the active class so a same-class click doesn't bounce
    // the user away from where they were. Returns null if no class
    // has an instance (pure orphan master).
    function pickClassWithMaster(masterId) {
      const order = [state.classId].concat(
        state.pageConfig.useClasses.filter(function (c) { return c !== state.classId; })
      );
      for (let i = 0; i < order.length; i++) {
        const bucket = state.byClass[order[i]];
        if (bucket && bucket.lines.some(function (l) { return l.masterId === masterId; })) {
          return order[i];
        }
      }
      return null;
    }

    function cleanup() {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
    }
    function onKey(e) { if (e.key === 'Escape') cleanup(); }
    document.addEventListener('keydown', onKey);
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) cleanup();
    });
  }

  // v0.8.176: Overview panel (slice 2). Stacks ABOVE the Project hub —
  // both overlays stay in the DOM simultaneously so Back returns to the
  // hub without rebuilding it. Single-class view (current active class
  // by default; user can switch via class chips). Diff mode is opt-in
  // and ships in slice 3. Jump-to-canvas HIDES both overlays and shows
  // a floating "Resume overview" chip — the user can fix a problem on
  // canvas and resume reviewing without losing position. The chip's ×
  // closes both overlays for good.
  function showOverviewPanel(hubOverlay) {
    const overlay = document.createElement('div');
    overlay.className = 'ed-modal-overlay ed-overview-overlay';

    const panel = document.createElement('div');
    panel.className = 'ed-modal ed-overview-panel';

    // Header.
    const head = document.createElement('div');
    head.className = 'ed-modal-header ed-overview-header';

    // v0.8.193: Back is context-aware. In single-class mode it returns
    // to the Project hub (closes overview only). In diff mode it
    // returns to single-class mode (exits diff in place). The Diff
    // button is hidden while in diff mode — Back IS the exit. Title +
    // label update to keep the meaning unambiguous.
    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'ed-project-back';
    back.innerHTML = '‹ Back';
    back.title = 'Back to Project hub';
    back.addEventListener('click', function () {
      if (diffMode) { exitDiffMode(); return; }
      closeOverviewOnly();
    });
    head.appendChild(back);

    const title = document.createElement('h3');
    title.textContent = 'Overview';
    head.appendChild(title);

    // Class chips — single-class view, one chip per useClass; active
    // chip uses the same is-active style as the library filter.
    // v0.8.192: also hidden when diff mode is on (diff compares all
    // classes at once; per-class selection is meaningless).
    let activeClassId = state.classId;
    const classRow = document.createElement('div');
    classRow.className = 'ed-library-filter ed-overview-classes';
    const classButtons = [];
    state.pageConfig.useClasses.forEach(function (cid) {
      const cls = state.classes.find(function (c) { return c.id === cid; });
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ed-library-filter-btn' + (cid === activeClassId ? ' is-active' : '');
      b.textContent = cls ? cls.name : cid;
      b.addEventListener('click', function () {
        activeClassId = cid;
        classButtons.forEach(function (e) { e.el.classList.toggle('is-active', e.cid === cid); });
        renderBody();
      });
      classButtons.push({ el: b, cid: cid });
      classRow.appendChild(b);
    });
    head.appendChild(classRow);

    // v0.8.192: per-class color mapping for diff mode. Names matched
    // case-insensitively against the conventional wide/medium/narrow
    // labels (the user's standard breakpoint naming); unmatched classes
    // fall back to position-based slots (other-1..other-3). The slot
    // strings become CSS class names below (`.is-class-<slot>`) so the
    // diff rows pick up the right tint.
    function diffSlotForClass(cid) {
      const cls = state.classes.find(function (c) { return c.id === cid; });
      const nm = ((cls && cls.name) || '').trim().toLowerCase();
      if (nm === 'wide')   return 'wide';
      if (nm === 'medium') return 'medium';
      if (nm === 'narrow') return 'narrow';
      const i = state.pageConfig.useClasses.indexOf(cid);
      return 'other-' + ((i % 3) + 1);
    }
    function classLabelFor(cid) {
      const cls = state.classes.find(function (c) { return c.id === cid; });
      return cls ? cls.name : cid;
    }

    // v0.8.186: vertical separator between the class chips and the
    // global "All details" action — same look as the top-toolbar
    // `.ed-tools` group divider (1px #444 with left padding). Matches
    // the visual grouping pattern the rest of the app uses.
    const sep = document.createElement('span');
    sep.className = 'ed-overview-toolbar-sep';
    head.appendChild(sep);

    // v0.8.192: Diff mode toggle. When active, the per-class chips +
    // "All details" are hidden, and the body renders a stacked diff
    // across every class in `useClasses`. A sub-toggle ("Only
    // differences") sits next to it, default ON. Both follow the
    // outline-always state-button convention (label swaps with state).
    let diffMode = false;
    let diffOnlyDiffering = true;

    const diffBtn = document.createElement('button');
    diffBtn.type = 'button';
    diffBtn.className = 'ed-overview-alldetails-btn ed-overview-diff-btn';
    diffBtn.textContent = 'Diff';
    diffBtn.title = 'Compare all classes side-by-side (stacked)';

    const onlyDiffBtn = document.createElement('button');
    onlyDiffBtn.type = 'button';
    onlyDiffBtn.className = 'ed-overview-alldetails-btn ed-overview-onlydiff-btn is-active';
    // v0.8.194: label = ACTION-on-click (matches the "All details"
    // convention, not "current state"). Default state is
    // diffOnlyDiffering=true → showing only differences → clicking
    // would show all items → label "All items".
    onlyDiffBtn.textContent = 'All items';
    onlyDiffBtn.title = 'Toggle between only differences / all items';
    onlyDiffBtn.style.display = 'none';
    onlyDiffBtn.addEventListener('click', function () {
      diffOnlyDiffering = !diffOnlyDiffering;
      onlyDiffBtn.classList.toggle('is-active', diffOnlyDiffering);
      onlyDiffBtn.textContent = diffOnlyDiffering ? 'All items' : 'Only differences';
      renderBody();
    });

    // Legend (3 swatches: green/blue/yellow for wide/medium/narrow)
    // Built once; visibility toggled with diff mode.
    const legend = document.createElement('span');
    legend.className = 'ed-overview-diff-legend';
    legend.style.display = 'none';
    state.pageConfig.useClasses.forEach(function (cid) {
      const sw = document.createElement('span');
      sw.className = 'ed-overview-diff-swatch is-class-' + diffSlotForClass(cid);
      const lb = document.createElement('span');
      lb.className = 'ed-overview-diff-swatch-label';
      lb.textContent = classLabelFor(cid);
      const wrap = document.createElement('span');
      wrap.className = 'ed-overview-diff-swatch-wrap';
      wrap.appendChild(sw);
      wrap.appendChild(lb);
      legend.appendChild(wrap);
    });

    // "All details" — state button (accent outline + label swap to
    // "Hide details" when active). Sits on the LEFT, grouped with the
    // class chips; a flex spacer after it pushes × to the right edge.
    let allDetailsOpen = false;
    const allBtn = document.createElement('button');
    allBtn.type = 'button';
    // v0.8.189: distinct class — this button follows the
    // "outline-always-visible, label-swap on state" convention the
    // user described. The per-row `.ed-overview-details-btn` follows
    // a different one (neutral off / accent on), so we can't reuse it.
    allBtn.className = 'ed-overview-alldetails-btn';
    allBtn.textContent = 'All details';
    allBtn.title = 'Open every block detail at once';
    allBtn.addEventListener('click', function () {
      allDetailsOpen = !allDetailsOpen;
      allBtn.classList.toggle('is-active', allDetailsOpen);
      allBtn.textContent = allDetailsOpen ? 'Hide details' : 'All details';
      const rows = body.querySelectorAll('.ed-overview-row');
      rows.forEach(function (r) {
        r.classList.toggle('is-details-open', allDetailsOpen);
      });
    });
    head.appendChild(allBtn);

    // v0.8.193: Diff is enter-only. Once on, the Diff button hides
    // entirely (Back becomes the exit); when off, only-diff toggle
    // and legend hide and per-class chips return. enterDiffMode /
    // exitDiffMode are split so Back can call exit directly.
    function enterDiffMode() {
      diffMode = true;
      classRow.style.display    = 'none';
      allBtn.style.display      = 'none';
      sep.style.display         = 'none';
      diffBtn.style.display     = 'none';
      legend.style.display      = '';
      onlyDiffBtn.style.display = '';
      back.title = 'Back to single-class Overview';
      renderBody();
    }
    function exitDiffMode() {
      diffMode = false;
      classRow.style.display    = '';
      allBtn.style.display      = '';
      sep.style.display         = '';
      diffBtn.style.display     = '';
      legend.style.display      = 'none';
      onlyDiffBtn.style.display = 'none';
      back.title = 'Back to Project hub';
      renderBody();
    }
    diffBtn.addEventListener('click', enterDiffMode);
    head.appendChild(diffBtn);
    head.appendChild(onlyDiffBtn);
    head.appendChild(legend);

    const spacer = document.createElement('span');
    spacer.className = 'ed-overview-toolbar-spacer';
    head.appendChild(spacer);

    const close = document.createElement('button');
    close.className = 'ed-modal-close'; close.textContent = '×';
    close.title = 'Close Overview and Project hub';
    close.addEventListener('click', function () { closeEverything(); });
    head.appendChild(close);
    panel.appendChild(head);

    // Search row (above the body so it stays visible while scrolling).
    const searchRow = document.createElement('div');
    searchRow.className = 'ed-overview-searchrow';
    const search = document.createElement('input');
    search.type = 'search';
    search.placeholder = 'Filter by object or group name…';
    search.className = 'ed-library-search';
    search.addEventListener('input', renderBody);
    searchRow.appendChild(search);
    panel.appendChild(searchRow);

    const body = document.createElement('div');
    body.className = 'ed-modal-body ed-overview-body';
    panel.appendChild(body);

    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    // v0.8.179: drag (header) + resize (bottom-right grip), like the
    // object panels. The panel is absolutely positioned inside the
    // overlay; initial geometry centers it occupying most of the
    // viewport. Drag and resize manipulate panel.style.{left,top,w,h}
    // directly — lightweight, no PanelManager integration (overview
    // is transient, no persistence across reopens).
    (function initGeometry() {
      const vw = window.innerWidth, vh = window.innerHeight;
      const w  = Math.round(vw * 0.98);
      const h  = Math.round(vh * 0.95);
      panel.style.position = 'absolute';
      panel.style.width  = w + 'px';
      panel.style.height = h + 'px';
      panel.style.left   = Math.round((vw - w) / 2) + 'px';
      panel.style.top    = Math.round((vh - h) / 2) + 'px';
      panel.style.maxWidth  = 'none';
      panel.style.maxHeight = 'none';
    })();

    // Add the resize grip in the bottom-right corner.
    const grip = document.createElement('div');
    grip.className = 'ed-overview-resize';
    grip.title = 'Drag to resize';
    panel.appendChild(grip);

    // Drag state — module-private to this panel instance.
    let dragRef = null, rzRef = null;
    function onMouseMove(e) {
      if (dragRef) {
        const dx = e.clientX - dragRef.x, dy = e.clientY - dragRef.y;
        // Keep at least 60px of the header visible inside the viewport
        // on each side so the user can always grab it back.
        const vw = window.innerWidth, vh = window.innerHeight;
        const w  = panel.offsetWidth;
        let nx = dragRef.px + dx, ny = dragRef.py + dy;
        nx = Math.max(60 - w, Math.min(vw - 60, nx));
        ny = Math.max(0,      Math.min(vh - 28, ny));
        panel.style.left = nx + 'px';
        panel.style.top  = ny + 'px';
      } else if (rzRef) {
        const dx = e.clientX - rzRef.x, dy = e.clientY - rzRef.y;
        const w = Math.max(420, rzRef.w + dx);
        const h = Math.max(280, rzRef.h + dy);
        panel.style.width  = w + 'px';
        panel.style.height = h + 'px';
      }
    }
    function onMouseUp() {
      dragRef = null;
      rzRef = null;
      document.body.style.userSelect = '';
    }
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup',   onMouseUp);

    head.addEventListener('mousedown', function (e) {
      // Don't start a drag when the user is clicking a control inside
      // the header (Back, class chips, ×, etc.) or selecting text.
      if (e.target.closest('button, input, select, a')) return;
      dragRef = { x: e.clientX, y: e.clientY,
                  px: panel.offsetLeft, py: panel.offsetTop };
      document.body.style.userSelect = 'none';
      e.preventDefault();
    });
    head.style.cursor = 'move';

    grip.addEventListener('mousedown', function (e) {
      rzRef = { x: e.clientX, y: e.clientY,
                w: panel.offsetWidth, h: panel.offsetHeight };
      document.body.style.userSelect = 'none';
      e.preventDefault();
      e.stopPropagation();
    });

    renderBody();
    search.focus();

    document.addEventListener('keydown', onKey);
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) closeOverviewOnly();
    });

    function onKey(e) { if (e.key === 'Escape') closeOverviewOnly(); }

    function closeOverviewOnly() {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup',   onMouseUp);
    }
    function closeEverything() {
      closeOverviewOnly();
      if (hubOverlay && hubOverlay.parentNode) hubOverlay.remove();
    }

    function renderBody() {
      body.innerHTML = '';
      if (diffMode) { renderDiffBody(); return; }
      const query = search.value.trim().toLowerCase();
      const bucket = state.byClass[activeClassId];
      const lines  = (bucket && Array.isArray(bucket.lines))  ? bucket.lines  : [];
      // v0.8.190: groups are PER-CLASS — `state.byClass[cid].groups`
      // is the source of truth. The previous code used `state.groups`,
      // which is a getter for `state.byClass[state.classId].groups`
      // (the EDITOR's currently-selected class, not the overview's).
      // Result: when the user clicked a different class chip in the
      // overview header, the loop iterated the editor-class's groups
      // and filtered lines by `l.groupId === g.id` — virtually no
      // matches, since group IDs differ per class. Only stray matches
      // (or the very first group, if IDs happened to collide) rendered.
      const groups = (bucket && Array.isArray(bucket.groups)) ? bucket.groups : [];

      // Iterate the active class's groups order — same as the sidebar
      // would show if the editor were on that class. Hidden groups and
      // hidden lines are excluded per spec.
      let printedAny = false;
      groups.forEach(function (g) {
        if (g.hidden) return;
        const groupLines = lines.filter(function (l) {
          return l.groupId === g.id && !l.hidden;
        });
        // v0.8.191: empty groups now render (parity with the sidebar
        // group list, which shows "0 lines" entries). Without this,
        // narrow/medium looked indistinguishable from wide whenever
        // their extra groups happened to be empty — confusing data
        // mismatch with the sidebar.

        // Group-level filter pass: if a search query is set, keep
        // group rows whose name matches OR which contain ≥1 matching
        // line; otherwise the whole group renders.
        const groupNameMatch = !query || (g.name || '').toLowerCase().indexOf(query) !== -1;
        const matchingLines = query
          ? groupLines.filter(function (l) {
              const nm = (l.name || (l.masterId
                ? (state.masters.find(function (m) { return m.id === l.masterId; }) || {}).name
                : '') || l.id || '').toLowerCase();
              return groupNameMatch || nm.indexOf(query) !== -1;
            })
          : groupLines;
        // Under a search query, drop the group only when it has no
        // matching lines AND its own name doesn't match — otherwise
        // we'd show empty groups that don't match the query.
        if (query && !matchingLines.length && !groupNameMatch) return;

        // v0.8.177: reuse sidebar group styling so the overview reads
        // as the same visual language as the editor. Wrapped in an
        // `.ed-overview-group` for layout, but the head itself is a
        // real `.ed-group` > `.ed-group-row` — same pill, same colors.
        // Read-only: no eye / delete buttons.
        const section = document.createElement('div');
        section.className = 'ed-overview-group ed-group';

        const ghead = document.createElement('div');
        ghead.className = 'ed-group-row ed-overview-ghead';
        ghead.style.cursor = 'default';
        const toggle = document.createElement('span');
        toggle.className = 'ed-group-toggle';
        toggle.textContent = 'G' + (groups.indexOf(g) + 1);
        ghead.appendChild(toggle);
        const gname = document.createElement('span');
        gname.className = 'ed-group-name';
        // v0.8.191: append (ID) — sibling classes carry same-named
        // groups with distinct IDs (the cross-class fanout assigns a
        // fresh id per class). Showing the id lets the user actually
        // verify whether "Group 4" in narrow and "Group 4" in wide
        // are the matching peers or accidentally similar names.
        gname.textContent = g.name + ' (' + g.id + ')';
        ghead.appendChild(gname);
        const gcount = document.createElement('span');
        gcount.className = 'ed-group-count';
        gcount.textContent = matchingLines.length + ' line' + (matchingLines.length === 1 ? '' : 's');
        ghead.appendChild(gcount);
        section.appendChild(ghead);

        const list = document.createElement('div');
        list.className = 'ed-overview-lines';
        matchingLines.forEach(function (line) {
          list.appendChild(buildLineRow(line));
        });
        section.appendChild(list);
        body.appendChild(section);
        printedAny = true;
      });

      if (!printedAny) {
        const empty = document.createElement('div');
        empty.className = 'ed-library-empty';
        empty.textContent = query
          ? 'No groups or lines match "' + query + '".'
          : 'No visible groups or lines in this class.';
        body.appendChild(empty);
      }
    }

    function buildLineRow(line) {
      const row = document.createElement('div');
      row.className = 'ed-overview-row';
      // v0.8.184: rows created after the toolbar's "All details"
      // toggle is on must inherit the open state (search-filter
      // re-renders re-create rows from scratch).
      if (allDetailsOpen) row.classList.add('is-details-open');

      // Two columns: vignette (left, reuses Master library preview)
      // and main column (right) with name+chip+block list.
      const master = line.masterId
        ? (state.masters.find(function (m) { return m.id === line.masterId; }) || null)
        : null;
      // The vignette helper accepts any object exposing the master-
      // shape fields. If a line lacks a master link, pass the line
      // itself — it still has kind/params/points/stroke. The wrapper
      // also doubles as the jump-to-canvas affordance so users can
      // click the picture, not just the text.
      const vignette = buildPreview(master || line);
      vignette.classList.add('ed-overview-vignette');
      const blocks = Array.isArray(line.behaviors) ? line.behaviors : [];
      // v0.8.181: the WHOLE row is the click target for toggling
      // details — aiming at a small name was fiddly. The "On canvas"
      // button stops propagation so it still does its own job.
      const toggleDetails = function () {
        if (!blocks.length) return;
        row.classList.toggle('is-details-open');
      };
      if (blocks.length) {
        row.style.cursor = 'pointer';
        // v0.8.183: no tooltip — it fired on every hover and became
        // intrusive. The pointer cursor + the explicit "On canvas"
        // button next to it already communicate that the rest of the
        // row is its own click target.
        row.addEventListener('click', function () { toggleDetails(); });
      }
      row.appendChild(vignette);

      const main = document.createElement('div');
      main.className = 'ed-overview-row-main';

      const top = document.createElement('div');
      top.className = 'ed-overview-row-top';
      const nameEl = document.createElement('span');
      nameEl.className = 'ed-overview-row-name';
      // v0.8.191: show "name (id)" — instances share names across
      // classes (and with the master); the id is the only reliable
      // disambiguator when something looks off. line.id is the
      // instance id; for shared-master objects, the master id is also
      // worth surfacing but instance id is what jump/select uses.
      {
        const nm = line.name || (master && master.name) || '';
        nameEl.textContent = nm ? (nm + ' (' + line.id + ')') : line.id;
      }
      top.appendChild(nameEl);

      const chip = document.createElement('span');
      chip.className = 'ed-overview-row-chip';
      chip.textContent = blocks.length + ' block' + (blocks.length === 1 ? '' : 's');
      if (!blocks.length) chip.classList.add('is-empty');
      top.appendChild(chip);

      // v0.8.180: "On canvas" button replaces the previous "Details"
      // toggle. It is the explicit jump-to-canvas action (was on the
      // object click). Kept on every row, regardless of block count —
      // jumping is useful even for objects with no behaviors.
      const jumpBtn = document.createElement('button');
      jumpBtn.type = 'button';
      jumpBtn.className = 'ed-overview-details-btn';
      jumpBtn.textContent = 'On canvas';
      jumpBtn.title = 'Jump to this object on the canvas';
      jumpBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        jumpToLine(line);
      });
      top.appendChild(jumpBtn);
      main.appendChild(top);

      if (!blocks.length) {
        const none = document.createElement('div');
        none.className = 'ed-overview-noblocks';
        none.textContent = '(no behaviors)';
        main.appendChild(none);
      } else {
        const bl = document.createElement('ul');
        bl.className = 'ed-overview-blocks';
        blocks.forEach(function (block, idx) {
          const li = document.createElement('li');
          li.className = 'ed-overview-block';
          // Summary line — always visible.
          const head = document.createElement('div');
          head.className = 'ed-overview-block-head';
          // Centralized formatter — future block-semantics changes
          // flow through behaviorAutoName so the overview never
          // drifts from the sidebar panel labels.
          head.textContent = behaviorAutoName(block, idx);
          li.appendChild(head);
          // Details — pre-rendered hidden, revealed by the Details
          // toggle on the row. behaviorSummaryText is the same prose
          // the sidebar's behavior block summary uses (single source
          // of truth for option descriptions).
          // v0.8.182: detail = trigger/duration sentence
          // (behaviorSummaryText) + per-effect values
          // (behaviorEffectsText) + drift line (behaviorDriftLineText
          // when applicable). Each goes on its own row so the user
          // sees the same three slices the sidebar reveals.
          const det = document.createElement('div');
          det.className = 'ed-overview-block-detail';
          const detLines = [];
          detLines.push(behaviorSummaryText(block));
          const fx = behaviorEffectsText(block);
          if (fx) detLines.push(fx);
          const isLast = idx === blocks.length - 1;
          const drift = behaviorDriftLineText(block, isLast);
          if (drift) detLines.push(drift);
          detLines.forEach(function (txt, i) {
            const p = document.createElement('div');
            p.className = 'ed-overview-block-detail-line';
            p.textContent = txt;
            det.appendChild(p);
          });
          li.appendChild(det);
          bl.appendChild(li);
        });
        main.appendChild(bl);
      }
      row.appendChild(main);
      return row;
    }

    // ============================================================
    // v0.8.192 — Cross-class diff mode
    // ============================================================
    //
    // Vertically stacked diff: each group / object / behavior block
    // is walked across every class in `state.pageConfig.useClasses`
    // and rendered in one column. Identical content collapses to a
    // single neutral row; differences are shown as per-class
    // colored rows (wide=green, medium=blue, narrow=yellow). The
    // "Only differences" toggle hides identical rows entirely.
    //
    // Identity rules:
    //   - groups : matched across classes by `name` (the cross-class
    //              identity; per-class groups have distinct ids).
    //   - lines  : matched by `masterId` when present; otherwise by
    //              `name + kind` as a fallback.
    //   - blocks : matched 1:1 by index within a line (the runtime
    //              processes blocks ordinally; mismatch by index is a
    //              real authoring divergence and should surface).
    //
    // Comparison: the canonical key list below is the set of every
    // authored block field referenced by behaviorAutoName /
    // behaviorSummaryText / behaviorEffectsText / behaviorDriftLineText
    // (i.e. everything that visibly affects runtime). Anything outside
    // this list is treated as not-comparing — keeps the diff focused
    // on authored intent, not bookkeeping (e.g. block ids).
    const BLOCK_COMPARE_PATHS = [
      'trigger.when',
      'trigger.range.start', 'trigger.range.end',
      'trigger.delay',
      'trigger.selector', 'trigger.viewportAt', 'trigger.repeat',
      'trigger.treatAsFilled',
      'trigger.startObjectId',
      'trigger.stopObjectId', 'trigger.stopFadeOut', 'trigger.stopReturnHome',
      'trigger.stopDurationSec', 'trigger.stopEasing',
      'duration.mode', 'duration.seconds', 'duration.easing',
      'duration.target', 'duration.maxIterations',
      'params.translateX', 'params.translateY', 'params.rotate',
      'params.translateMode',
      'params.fadeOpacity', 'params.opacityFrom', 'params.opacityTo',
      'params.drawIn', 'params.drawInDirection',
      'params.pathRef', 'params.pathRefName',
      'params.pathAlignToTangent', 'params.pathEndMode',
      'params.rotateOriginX', 'params.rotateOriginY',
    ];

    function diffGetPath(obj, path) {
      if (!obj) return undefined;
      const parts = path.split('.');
      let cur = obj;
      for (let i = 0; i < parts.length; i++) {
        if (cur == null) return undefined;
        cur = cur[parts[i]];
      }
      return cur;
    }
    // Strict equality with undefined-leniency: two undefined values are
    // equal; an undefined and a primitive aren't. NaN is not a concern
    // (no authored params ever produce NaN).
    function diffValEq(a, b) {
      if (a === b) return true;
      if (a == null && b == null) return true;
      return false;
    }
    // Stable display string for a block value. Booleans, numbers,
    // strings render as-is. masterId-style fields (startObjectId /
    // stopObjectId / pathRef) get resolved via objectLabel for
    // readability — IDs alone are useless side-by-side.
    function diffFormatVal(path, v) {
      if (v == null) return '∅';
      if (typeof v === 'boolean') return v ? 'on' : 'off';
      if (path === 'trigger.startObjectId' || path === 'trigger.stopObjectId' ||
          path === 'params.pathRef') {
        const m = state.masters.find(function (x) { return x.id === v; });
        const nm = m && m.name ? m.name : null;
        return nm ? (nm + ' (' + v + ')') : v;
      }
      return String(v);
    }

    // True if two blocks are identical across every comparable path.
    function diffBlocksIdentical(a, b) {
      if (!a && !b) return true;
      if (!a || !b) return false;
      for (let i = 0; i < BLOCK_COMPARE_PATHS.length; i++) {
        const p = BLOCK_COMPARE_PATHS[i];
        if (!diffValEq(diffGetPath(a, p), diffGetPath(b, p))) return false;
      }
      return true;
    }
    // Returns the subset of BLOCK_COMPARE_PATHS that differ when
    // walking the supplied per-class blocks. A path is "differing" if
    // any pair of (defined) values disagree, OR if the value is
    // defined in some classes but undefined in others.
    function diffPropsDiffer(blocksByClass) {
      const out = [];
      for (let i = 0; i < BLOCK_COMPARE_PATHS.length; i++) {
        const p = BLOCK_COMPARE_PATHS[i];
        const vals = blocksByClass.map(function (b) {
          return b ? diffGetPath(b, p) : undefined;
        });
        let sample = null, sampled = false, mismatched = false;
        for (let j = 0; j < vals.length; j++) {
          // Only compare against classes where the block exists at
          // all — presence/absence is a separate row, so don't
          // double-count "absent" as a property diff.
          if (!blocksByClass[j]) continue;
          if (!sampled) { sample = vals[j]; sampled = true; continue; }
          if (!diffValEq(sample, vals[j])) { mismatched = true; break; }
        }
        if (mismatched) out.push(p);
      }
      return out;
    }

    // Build the union-ordered list of group names across all classes.
    // First class's order wins; further classes append their unique
    // group names at the end (in their own order).
    function diffBuildGroupOrder(classIds) {
      const seen = new Set(), out = [];
      classIds.forEach(function (cid) {
        const bucket = state.byClass[cid];
        const gs = (bucket && Array.isArray(bucket.groups)) ? bucket.groups : [];
        gs.forEach(function (g) {
          if (g.hidden) return;
          if (seen.has(g.name)) return;
          seen.add(g.name);
          out.push(g.name);
        });
      });
      return out;
    }
    // Per-group: collect each class's matching group + non-hidden lines.
    function diffGroupRecord(name, classIds) {
      const perClass = {};
      classIds.forEach(function (cid) {
        const bucket = state.byClass[cid];
        const g = (bucket && Array.isArray(bucket.groups))
          ? bucket.groups.find(function (x) { return x.name === name && !x.hidden; })
          : null;
        const lines = (g && bucket && Array.isArray(bucket.lines))
          ? bucket.lines.filter(function (l) { return l.groupId === g.id && !l.hidden; })
          : [];
        perClass[cid] = { group: g || null, lines: lines };
      });
      return perClass;
    }
    // A line's cross-class identity key. masterId wins; falls back to
    // "name|kind" (per HANDOFF's name-fallback principle) for masterless
    // lines or per-class master drift edge cases.
    function diffLineKey(line) {
      if (!line) return null;
      if (line.masterId) return 'm:' + line.masterId;
      const nm = (line.name || '').trim();
      const kd = line.kind || '';
      if (nm) return 'n:' + nm + '|' + kd;
      return 'i:' + line.id;
    }
    function diffBuildLineOrder(perClassGroup, classIds) {
      const seen = new Set(), out = [];
      classIds.forEach(function (cid) {
        const rec = perClassGroup[cid];
        if (!rec) return;
        rec.lines.forEach(function (l) {
          const k = diffLineKey(l);
          if (!k || seen.has(k)) return;
          seen.add(k);
          out.push(k);
        });
      });
      return out;
    }
    function diffFindLineByKey(perClassGroup, classIds, key) {
      const out = {};
      classIds.forEach(function (cid) {
        const rec = perClassGroup[cid];
        const found = rec && rec.lines
          ? rec.lines.find(function (l) { return diffLineKey(l) === key; })
          : null;
        out[cid] = found || null;
      });
      return out;
    }
    // A short label for the line — prefers name (with id appended for
    // disambiguation, matching the v0.8.179 convention used elsewhere).
    function diffLineLabel(perClassLines, classIds) {
      // Use the first defined line's name (or master.name) + id.
      for (let i = 0; i < classIds.length; i++) {
        const l = perClassLines[classIds[i]];
        if (!l) continue;
        const m = l.masterId
          ? state.masters.find(function (x) { return x.id === l.masterId; })
          : null;
        const nm = l.name || (m && m.name) || '';
        const idLabel = l.masterId || l.id;
        return nm ? (nm + ' (' + idLabel + ')') : idLabel;
      }
      return '(unknown)';
    }

    // Build a row that says "[class] something". Used both for
    // presence-only displays ("absent in narrow") and for per-property
    // diffs. The slot CSS class drives the background tint.
    function diffMakeClassRow(cid, content) {
      const div = document.createElement('div');
      div.className = 'ed-overview-diff-row is-class-' + diffSlotForClass(cid);
      const tag = document.createElement('span');
      tag.className = 'ed-overview-diff-tag';
      tag.textContent = classLabelFor(cid);
      div.appendChild(tag);
      const body = document.createElement('span');
      body.className = 'ed-overview-diff-rowbody';
      if (typeof content === 'string') body.textContent = content;
      else if (content) body.appendChild(content);
      div.appendChild(body);
      return div;
    }
    // v0.8.194: a fixed-width left slot for presence chips. All head
    // rows (group / line / block / disclosure) put the chip in this
    // slot as the first child so the chips line up vertically in a
    // narrow left rail — much easier to scan than chips floating
    // wherever the natural flex layout puts them. min-width keeps
    // alignment for short chips ("identical", "differs"); long ones
    // ("only in wide, medium, narrow") expand the slot for that row
    // only — acceptable tradeoff vs truncation/clipping.
    function diffMakeChipSlot(chipNode) {
      const slot = document.createElement('span');
      slot.className = 'ed-overview-diff-chipslot';
      if (chipNode) slot.appendChild(chipNode);
      return slot;
    }
    function diffMakeNeutralRow(text, opts) {
      const div = document.createElement('div');
      div.className = 'ed-overview-diff-neutral' + ((opts && opts.dim) ? ' is-dim' : '');
      div.textContent = text;
      return div;
    }

    function renderDiffBody() {
      const classIds = state.pageConfig.useClasses.slice();
      const query = search.value.trim().toLowerCase();
      const groupNames = diffBuildGroupOrder(classIds);
      let printedAny = false;

      groupNames.forEach(function (gname) {
        if (query && gname.toLowerCase().indexOf(query) === -1) {
          // Group name doesn't itself match — keep it only if some
          // child line matches; we'll check during line iteration and
          // skip the whole group if nothing matches.
        }
        const perClass = diffGroupRecord(gname, classIds);
        // Presence: which classes have this group at all?
        const present = classIds.filter(function (cid) { return !!perClass[cid].group; });
        const absent  = classIds.filter(function (cid) { return !perClass[cid].group; });

        // Pre-build the line entries so we can decide whether to emit
        // the group at all (only-differences mode hides groups whose
        // every line is identical and which itself is present everywhere).
        const lineKeys = diffBuildLineOrder(perClass, classIds);
        const lineEntries = lineKeys.map(function (key) {
          const linesByClass = diffFindLineByKey(perClass, classIds, key);
          const linePresent  = classIds.filter(function (cid) { return !!linesByClass[cid]; });
          const lineAbsent   = classIds.filter(function (cid) { return !linesByClass[cid]; });
          // Max block count among present.
          let maxBlocks = 0;
          linePresent.forEach(function (cid) {
            const bs = linesByClass[cid].behaviors || [];
            if (bs.length > maxBlocks) maxBlocks = bs.length;
          });
          // Per-block diff records.
          const blockEntries = [];
          for (let i = 0; i < maxBlocks; i++) {
            const perCB = classIds.map(function (cid) {
              const l = linesByClass[cid];
              return (l && Array.isArray(l.behaviors) && i < l.behaviors.length)
                ? l.behaviors[i] : null;
            });
            const blockPresent = classIds.filter(function (_, j) { return !!perCB[j]; });
            const blockAbsent  = classIds.filter(function (_, j) { return !perCB[j]; });
            const diffPaths = diffPropsDiffer(perCB);
            const differs   = (blockAbsent.length > 0) || diffPaths.length > 0;
            blockEntries.push({
              index: i,
              perCB: perCB,
              blockPresent: blockPresent,
              blockAbsent: blockAbsent,
              diffPaths: diffPaths,
              differs: differs
            });
          }
          const lineDiffers = (lineAbsent.length > 0) ||
                              blockEntries.some(function (b) { return b.differs; });
          return {
            key: key,
            linesByClass: linesByClass,
            linePresent: linePresent,
            lineAbsent: lineAbsent,
            blockEntries: blockEntries,
            differs: lineDiffers
          };
        });

        // Apply search filter.
        const filteredLines = !query ? lineEntries : lineEntries.filter(function (le) {
          if (gname.toLowerCase().indexOf(query) !== -1) return true;
          const lbl = diffLineLabel(le.linesByClass, classIds).toLowerCase();
          return lbl.indexOf(query) !== -1;
        });
        if (!filteredLines.length && query) return;

        const groupItselfDiffers = absent.length > 0;
        const visibleLines = diffOnlyDiffering
          ? filteredLines.filter(function (le) { return le.differs; })
          : filteredLines;
        // Hide a group entirely only when only-diff mode is on AND
        // both the group itself agrees across classes AND no children
        // differ. Otherwise the group header still matters.
        if (diffOnlyDiffering && !groupItselfDiffers && !visibleLines.length) return;

        // Group header — chip slot first (v0.8.194), then toggle + name.
        const section = document.createElement('div');
        section.className = 'ed-overview-group ed-group ed-overview-diff-group';
        const ghead = document.createElement('div');
        ghead.className = 'ed-group-row ed-overview-ghead';
        ghead.style.cursor = 'default';
        // v0.8.193: groups carry the same three-state presence chip
        // as lines and blocks — partial (some classes missing it),
        // identical (present in all and every child line/block agrees),
        // or differs (present in all but at least one child diverges).
        const anyChildDiffers = lineEntries.some(function (le) { return le.differs; });
        const presenceTag = document.createElement('span');
        presenceTag.className = 'ed-overview-diff-presence';
        if (groupItselfDiffers) {
          presenceTag.textContent = 'only in ' + present.map(classLabelFor).join(', ');
          presenceTag.classList.add('is-partial');
        } else if (anyChildDiffers) {
          presenceTag.textContent = 'differs';
          presenceTag.classList.add('is-differs');
        } else {
          presenceTag.textContent = 'identical';
          presenceTag.classList.add('is-identical');
        }
        ghead.appendChild(diffMakeChipSlot(presenceTag));
        const toggle = document.createElement('span');
        toggle.className = 'ed-group-toggle';
        toggle.textContent = 'G';
        ghead.appendChild(toggle);
        const nm = document.createElement('span');
        nm.className = 'ed-group-name';
        nm.textContent = gname;
        ghead.appendChild(nm);
        section.appendChild(ghead);

        // Compaction for identical-runs when showing everything.
        // Walk visibleLines; for each run of consecutive non-differing
        // lines (only happens when only-differences is OFF), collapse
        // into a single disclosure.
        const lineHost = document.createElement('div');
        lineHost.className = 'ed-overview-diff-lines';

        let run = [];
        function flushRun() {
          if (!run.length) return;
          if (run.length === 1) {
            lineHost.appendChild(renderDiffLine(run[0], classIds));
          } else {
            lineHost.appendChild(renderIdenticalRun(run, classIds, 'objects'));
          }
          run = [];
        }
        visibleLines.forEach(function (le) {
          if (!le.differs) { run.push(le); return; }
          flushRun();
          lineHost.appendChild(renderDiffLine(le, classIds));
        });
        flushRun();

        section.appendChild(lineHost);
        body.appendChild(section);
        printedAny = true;
      });

      if (!printedAny) {
        const empty = document.createElement('div');
        empty.className = 'ed-library-empty';
        empty.textContent = query
          ? 'No groups or lines match "' + query + '".'
          : (diffOnlyDiffering
              ? 'No differences across classes — every visible group, object and behavior block matches.'
              : 'No visible groups or lines in any class.');
        body.appendChild(empty);
      }
    }

    // v0.8.193: disclosure heads carry the is-identical chip too —
    // user wants to be able to scan visually for "identical" markers
    // without parsing the disclosure label. The chip is appended to
    // the button after the label text so the arrow + count read first.
    function makeIdenticalChip() {
      const c = document.createElement('span');
      c.className = 'ed-overview-diff-presence is-identical';
      c.textContent = 'identical';
      return c;
    }
    function renderIdenticalRun(entries, classIds, label) {
      const wrap = document.createElement('div');
      wrap.className = 'ed-overview-diff-runwrap';
      const head = document.createElement('button');
      head.type = 'button';
      head.className = 'ed-overview-diff-runhead';
      // v0.8.194: chip slot first, then arrow + text. setLabel
      // rebuilds the whole content so the chip and label stay in sync
      // when toggling open/closed.
      function setLabel(open) {
        head.innerHTML = '';
        head.appendChild(diffMakeChipSlot(makeIdenticalChip()));
        const txt = document.createElement('span');
        txt.textContent = (open ? '▾ ' : '▸ ') + entries.length + ' ' + label;
        head.appendChild(txt);
      }
      setLabel(false);
      head.title = 'Click to expand the identical ' + label;
      const list = document.createElement('div');
      list.className = 'ed-overview-diff-runlist';
      list.style.display = 'none';
      entries.forEach(function (le) {
        list.appendChild(renderDiffLine(le, classIds));
      });
      let open = false;
      head.addEventListener('click', function () {
        open = !open;
        setLabel(open);
        list.style.display = open ? '' : 'none';
      });
      wrap.appendChild(head);
      wrap.appendChild(list);
      return wrap;
    }

    function renderDiffLine(entry, classIds) {
      const wrap = document.createElement('div');
      wrap.className = 'ed-overview-diff-line' + (entry.differs ? ' is-differs' : '');
      // Line header — chip slot first (v0.8.194), then name + spacer
      // + On-canvas button. The spacer absorbs remaining width so
      // On-canvas anchors to the right.
      const hd = document.createElement('div');
      hd.className = 'ed-overview-diff-linehead';
      const presence = document.createElement('span');
      presence.className = 'ed-overview-diff-presence';
      if (entry.lineAbsent.length > 0) {
        presence.textContent = 'only in ' + entry.linePresent.map(classLabelFor).join(', ');
        presence.classList.add('is-partial');
      } else if (!entry.differs) {
        presence.textContent = 'identical';
        presence.classList.add('is-identical');
      } else {
        presence.textContent = 'differs';
        presence.classList.add('is-differs');
      }
      hd.appendChild(diffMakeChipSlot(presence));
      const nameEl = document.createElement('span');
      nameEl.className = 'ed-overview-diff-linename';
      nameEl.textContent = diffLineLabel(entry.linesByClass, classIds);
      hd.appendChild(nameEl);
      const spacer = document.createElement('span');
      spacer.className = 'ed-overview-diff-linehead-spacer';
      hd.appendChild(spacer);
      // Jump to canvas (uses the first present line).
      const jumpBtn = document.createElement('button');
      jumpBtn.type = 'button';
      jumpBtn.className = 'ed-overview-details-btn';
      jumpBtn.textContent = 'On canvas';
      jumpBtn.title = 'Jump to this object on the canvas (uses the first class where it exists)';
      jumpBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        for (let i = 0; i < classIds.length; i++) {
          const l = entry.linesByClass[classIds[i]];
          if (l) {
            // Override activeClassId so jumpToLine switches into the
            // class where the line actually lives.
            activeClassId = classIds[i];
            jumpToLine(l);
            return;
          }
        }
      });
      hd.appendChild(jumpBtn);
      wrap.appendChild(hd);

      // If the line is absent in some classes, surface the presence
      // rows — one colored row per class that HAS it (showing autoName
      // of block 1 as a quick identifier) and one "absent" row per
      // class that doesn't.
      if (entry.lineAbsent.length > 0) {
        const presBlock = document.createElement('div');
        presBlock.className = 'ed-overview-diff-presblock';
        classIds.forEach(function (cid) {
          const l = entry.linesByClass[cid];
          if (l) {
            const bcount = (l.behaviors || []).length;
            const desc = bcount
              ? (bcount + ' block' + (bcount === 1 ? '' : 's'))
              : 'no behaviors';
            presBlock.appendChild(diffMakeClassRow(cid, 'present · ' + desc));
          } else {
            const row = diffMakeClassRow(cid, 'absent');
            row.classList.add('is-absent');
            presBlock.appendChild(row);
          }
        });
        wrap.appendChild(presBlock);
      }

      // Block-level diffs (only rendered for classes that share the
      // line — absent rows are already covered above).
      const blocks = entry.blockEntries;
      if (blocks.length) {
        const bWrap = document.createElement('div');
        bWrap.className = 'ed-overview-diff-blocks';
        // Compact runs of identical blocks when not in only-diff mode.
        let brun = [];
        function flushBlockRun() {
          if (!brun.length) return;
          if (brun.length === 1) {
            bWrap.appendChild(renderDiffBlock(brun[0], entry, classIds));
          } else {
            bWrap.appendChild(renderIdenticalBlocksRun(brun, entry, classIds));
          }
          brun = [];
        }
        blocks.forEach(function (be) {
          const skip = diffOnlyDiffering && !be.differs;
          if (skip) return;
          if (!be.differs) { brun.push(be); return; }
          flushBlockRun();
          bWrap.appendChild(renderDiffBlock(be, entry, classIds));
        });
        flushBlockRun();
        if (bWrap.childNodes.length) wrap.appendChild(bWrap);
      }
      return wrap;
    }

    function renderIdenticalBlocksRun(blockEntries, lineEntry, classIds) {
      const wrap = document.createElement('div');
      wrap.className = 'ed-overview-diff-runwrap is-blocks';
      const head = document.createElement('button');
      head.type = 'button';
      head.className = 'ed-overview-diff-runhead';
      const range = (blockEntries.length === 1)
        ? ('Block ' + (blockEntries[0].index + 1))
        : ('Blocks ' + (blockEntries[0].index + 1) + '–'
                     + (blockEntries[blockEntries.length - 1].index + 1));
      function setLabel(open) {
        head.innerHTML = '';
        head.appendChild(diffMakeChipSlot(makeIdenticalChip()));
        const txt = document.createElement('span');
        txt.textContent = (open ? '▾ ' : '▸ ') + range;
        head.appendChild(txt);
      }
      setLabel(false);
      const list = document.createElement('div');
      list.className = 'ed-overview-diff-runlist';
      list.style.display = 'none';
      blockEntries.forEach(function (be) {
        list.appendChild(renderDiffBlock(be, lineEntry, classIds));
      });
      let open = false;
      head.addEventListener('click', function () {
        open = !open;
        setLabel(open);
        list.style.display = open ? '' : 'none';
      });
      wrap.appendChild(head);
      wrap.appendChild(list);
      return wrap;
    }

    function renderDiffBlock(be, lineEntry, classIds) {
      const div = document.createElement('div');
      div.className = 'ed-overview-diff-block' + (be.differs ? ' is-differs' : '');
      // Block header — use behaviorAutoName from the first present
      // block as the heading. If they auto-name differently across
      // classes (rare — would mean the dominant effect itself differs),
      // we still pick the first; the per-property rows below carry the
      // actual diff.
      let headLabel = 'Block ' + (be.index + 1);
      for (let i = 0; i < classIds.length; i++) {
        const b = be.perCB[i];
        if (b) { headLabel = behaviorAutoName(b, be.index); break; }
      }
      // v0.8.194: chip slot first, then label text. (Was: label set
      // via textContent then chip appended — leaving chip on the
      // right edge, breaking the left-rail alignment.)
      const head = document.createElement('div');
      head.className = 'ed-overview-diff-blockhead';
      let blockChip = null;
      if (be.blockAbsent.length > 0) {
        blockChip = document.createElement('span');
        blockChip.className = 'ed-overview-diff-presence is-partial';
        blockChip.textContent = 'only in ' + be.blockPresent.map(classLabelFor).join(', ');
      } else if (!be.differs) {
        blockChip = document.createElement('span');
        blockChip.className = 'ed-overview-diff-presence is-identical';
        blockChip.textContent = 'identical';
      } else {
        blockChip = document.createElement('span');
        blockChip.className = 'ed-overview-diff-presence is-differs';
        blockChip.textContent = 'differs';
      }
      head.appendChild(diffMakeChipSlot(blockChip));
      const headLabelEl = document.createElement('span');
      headLabelEl.className = 'ed-overview-diff-blocklabel';
      headLabelEl.textContent = headLabel;
      head.appendChild(headLabelEl);
      div.appendChild(head);

      // Presence rows for absent classes.
      if (be.blockAbsent.length > 0) {
        const presBlock = document.createElement('div');
        presBlock.className = 'ed-overview-diff-presblock';
        classIds.forEach(function (cid, j) {
          if (be.perCB[j]) {
            presBlock.appendChild(diffMakeClassRow(
              cid, behaviorAutoName(be.perCB[j], be.index)));
          } else {
            const r = diffMakeClassRow(cid, 'absent (line has fewer blocks)');
            r.classList.add('is-absent');
            presBlock.appendChild(r);
          }
        });
        div.appendChild(presBlock);
      }

      // Per-property diffs (only the differing paths).
      if (be.diffPaths.length > 0) {
        const propBlock = document.createElement('div');
        propBlock.className = 'ed-overview-diff-props';
        be.diffPaths.forEach(function (path) {
          const propTitle = document.createElement('div');
          propTitle.className = 'ed-overview-diff-propname';
          propTitle.textContent = path;
          propBlock.appendChild(propTitle);
          classIds.forEach(function (cid, j) {
            const b = be.perCB[j];
            if (!b) return;  // already handled above
            const v = diffGetPath(b, path);
            propBlock.appendChild(diffMakeClassRow(cid, diffFormatVal(path, v)));
          });
        });
        div.appendChild(propBlock);
      }

      // If the block is identical and we're showing everything, render
      // the autoName line only (already in the head); no extra rows.
      return div;
    }

    // Jump-to-canvas: HIDE (not remove) both layers; show a floating
    // "Resume overview" chip. User can edit on canvas and resume
    // reviewing without losing scroll position, class selection, or
    // search query.
    function jumpToLine(line) {
      // Switch class if the line lives in a different class than the
      // editor's current one.
      if (activeClassId !== state.classId) {
        switchClass(activeClassId);
      }
      // Open the line's group so the line panel renders.
      if (line.groupId) {
        state.activeGroupId = line.groupId;
        state.openGroupIds[line.groupId] = true;
      }
      selectOnly(line.id);
      renderAll();

      // Hide both layers (preserve state).
      overlay.style.display = 'none';
      if (hubOverlay) hubOverlay.style.display = 'none';

      const chip = document.createElement('div');
      chip.className = 'ed-overview-resume-chip';
      const resume = document.createElement('button');
      resume.type = 'button';
      resume.className = 'ed-overview-resume-btn';
      resume.textContent = '↩ Resume overview';
      resume.title = 'Re-show the Overview panel and the Project hub';
      resume.addEventListener('click', function (e) {
        e.stopPropagation();
        overlay.style.display = '';
        if (hubOverlay) hubOverlay.style.display = '';
        chip.remove();
      });
      const dismiss = document.createElement('button');
      dismiss.type = 'button';
      dismiss.className = 'ed-overview-resume-close';
      dismiss.textContent = '×';
      dismiss.title = 'Close Overview (and Project hub) without resuming';
      dismiss.addEventListener('click', function (e) {
        // v0.8.178: belt-and-suspenders close — stop propagation so
        // nothing else captures the click, remove the chip first, then
        // tear down both hidden overlays via closeEverything (which
        // also unhooks the mousemove/mouseup listeners installed by
        // the drag/resize wiring in v0.8.179).
        e.stopPropagation();
        if (chip.parentNode) chip.remove();
        closeEverything();
      });
      chip.appendChild(resume);
      chip.appendChild(dismiss);
      document.body.appendChild(chip);
    }
  }

  function showCloneDialog() {
    const others = state.pageConfig.useClasses.filter(function (cid) {
      return cid !== state.classId && state.byClass[cid];
    });
    if (!others.length) {
      alert('No other class on this page to clone from.');
      return;
    }
    const labelOf = function (cid) {
      const c = state.classes.find(function (x) { return x.id === cid; });
      return c ? c.name : cid;
    };

    const overlay = document.createElement('div');
    overlay.className = 'ed-modal-overlay';
    const modal = document.createElement('div');
    modal.className = 'ed-modal';

    const head = document.createElement('div');
    head.className = 'ed-modal-header';
    const headH = document.createElement('h3');
    headH.textContent = 'Clone groups into ' + labelOf(state.classId);
    head.appendChild(headH);
    const closeBtn = document.createElement('button');
    closeBtn.className = 'ed-modal-close'; closeBtn.textContent = '×';
    closeBtn.addEventListener('click', cleanup);
    head.appendChild(closeBtn);
    modal.appendChild(head);

    const body = document.createElement('div');
    body.className = 'ed-modal-body';

    // Source class picker — radio-style buttons, one per other
    // class. With only 2–3 classes in practice the dropdown was an
    // extra click for nothing; buttons surface the choice in place.
    let currentSourceId = others[0];
    const sourceRow = document.createElement('div');
    sourceRow.className = 'ed-clone-source';
    const sourceLabel = document.createElement('label'); sourceLabel.textContent = 'From:';
    sourceRow.appendChild(sourceLabel);
    const sourceBtns = document.createElement('div');
    sourceBtns.className = 'ed-clone-source-buttons';
    others.forEach(function (cid, idx) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ed-clone-source-btn' + (idx === 0 ? ' is-active' : '');
      b.textContent = labelOf(cid);
      b.dataset.cid = cid;
      b.addEventListener('click', function () {
        currentSourceId = cid;
        sourceBtns.querySelectorAll('.ed-clone-source-btn').forEach(function (x) {
          x.classList.toggle('is-active', x === b);
        });
        renderGroupsList();
      });
      sourceBtns.appendChild(b);
    });
    sourceRow.appendChild(sourceBtns);
    body.appendChild(sourceRow);

    // "Select all" / "Unselect all" toggle above the groups list.
    // Defaults are all-checked, so the button starts as "Unselect all";
    // flips its own label each click.
    const togRow = document.createElement('div');
    togRow.className = 'ed-clone-tog-row';
    const togBtn = document.createElement('button');
    togBtn.type = 'button';
    togBtn.className = 'ed-mini';
    togBtn.textContent = 'Unselect all';
    togBtn.addEventListener('click', function () {
      const checkboxes = groupsList.querySelectorAll('input[type="checkbox"]');
      const anyChecked = Array.prototype.slice.call(checkboxes)
        .some(function (cb) { return cb.checked; });
      const newState = !anyChecked;
      checkboxes.forEach(function (cb) { cb.checked = newState; });
      togBtn.textContent = newState ? 'Unselect all' : 'Select all';
    });
    togRow.appendChild(togBtn);
    body.appendChild(togRow);

    const groupsList = document.createElement('div');
    groupsList.className = 'ed-clone-groups';
    body.appendChild(groupsList);

    const help = document.createElement('p');
    help.style.color = '#888';
    help.style.fontSize = '0.85em';
    help.style.margin = '0';
    help.textContent = 'Groups marked “replaces” will swap out the same-name group in ' +
      labelOf(state.classId) + '. Other selected groups are added new.';
    body.appendChild(help);

    modal.appendChild(body);

    const btnRow = document.createElement('div');
    btnRow.className = 'ed-modal-buttons';
    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', cleanup);
    btnRow.appendChild(cancelBtn);
    const applyBtn = document.createElement('button');
    applyBtn.className = 'ed-primary';
    applyBtn.textContent = 'Clone selected';
    applyBtn.addEventListener('click', function () {
      const selected = Array.prototype.slice
        .call(groupsList.querySelectorAll('input[type="checkbox"]:checked'))
        .map(function (cb) { return cb.dataset.groupId; });
      cleanup();
      if (selected.length) applyCloneCherryPick(currentSourceId, selected);
    });
    btnRow.appendChild(applyBtn);
    modal.appendChild(btnRow);

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    function renderGroupsList() {
      const sourceId = currentSourceId;
      const src = state.byClass[sourceId];
      groupsList.innerHTML = '';
      if (!src || !src.groups || !src.groups.length) {
        const empty = document.createElement('div');
        empty.className = 'ed-clone-empty';
        empty.textContent = 'No groups in this class.';
        groupsList.appendChild(empty);
        applyBtn.disabled = true;
        return;
      }
      applyBtn.disabled = false;
      const dstNames = (state.byClass[state.classId].groups || [])
        .map(function (g) { return g.name; });
      src.groups.forEach(function (g) {
        const row = document.createElement('label');
        row.className = 'ed-clone-group';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = true;
        cb.dataset.groupId = g.id;
        const name = document.createElement('span');
        name.className = 'name';
        name.textContent = g.name || g.id;
        const lineCount = src.lines.filter(function (l) { return l.groupId === g.id; }).length;
        const meta = document.createElement('span');
        meta.className = 'meta';
        meta.textContent = lineCount + (lineCount === 1 ? ' line' : ' lines');
        const badge = document.createElement('span');
        badge.className = 'badge';
        badge.textContent = dstNames.indexOf(g.name) !== -1 ? 'replaces' : '';
        row.appendChild(cb);
        row.appendChild(name);
        row.appendChild(meta);
        row.appendChild(badge);
        groupsList.appendChild(row);
      });
    }
    renderGroupsList();

    function cleanup() {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
    }
    function onKey(e) { if (e.key === 'Escape') cleanup(); }
    document.addEventListener('keydown', onKey);
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) cleanup();
    });
  }

  /**
   * Merge: for each picked source group, drop the same-name group
   * from the destination (if any) along with its lines, then push
   * a deep-copy of the source group + its lines in. Group + line
   * ids are freshly minted in the destination so they can't collide
   * with surviving rows. masterId is preserved on each copied line
   * — same canonical object, new instance row in this class.
   * Lines from non-picked dest groups whose master is being brought
   * in are also dropped, to avoid the same master appearing twice
   * across groups in the destination.
   */
  function applyCloneCherryPick(sourceId, selectedGroupIds) {
    const src = state.byClass[sourceId];
    const dst = state.byClass[state.classId];
    if (!src || !dst) return;

    const pickedGroups = src.groups.filter(function (g) {
      return selectedGroupIds.indexOf(g.id) !== -1;
    });
    const pickedGroupNames = pickedGroups.map(function (g) { return g.name; });
    const pickedLines = src.lines.filter(function (l) {
      return selectedGroupIds.indexOf(l.groupId) !== -1;
    });
    const pickedMasterIdSet = {};
    pickedLines.forEach(function (l) {
      if (l.masterId) pickedMasterIdSet[l.masterId] = true;
    });

    const survivingGroups = dst.groups.filter(function (g) {
      return pickedGroupNames.indexOf(g.name) === -1;
    });
    const survivingGroupIds = survivingGroups.map(function (g) { return g.id; });
    const survivingLines = dst.lines.filter(function (l) {
      return survivingGroupIds.indexOf(l.groupId) !== -1
          && !pickedMasterIdSet[l.masterId];
    });

    const groupIdMap = {};
    pickedGroups.forEach(function (g) {
      const copy = deepCopy(g);
      groupIdMap[g.id] = uid('g');
      copy.id = groupIdMap[g.id];
      survivingGroups.push(copy);
    });
    pickedLines.forEach(function (l) {
      const copy = deepCopy(l);
      copy.id = uid('l');
      if (groupIdMap[copy.groupId]) copy.groupId = groupIdMap[copy.groupId];
      survivingLines.push(copy);
    });

    state.byClass[state.classId].groups = survivingGroups;
    state.byClass[state.classId].lines = survivingLines;
    state.selectedIds = [];
    state.activeGroupId = (survivingGroups[0] && survivingGroups[0].id) || null;
    state.openGroupIds = {};
    if (state.activeGroupId) state.openGroupIds[state.activeGroupId] = true;
    state.dirty = true;
    snapshot();
    renderAll();
  }

  function renderGrid() {
    gridG.innerHTML = '';
    // Grid covers only the page area (0–pageW, 0–pageH). Off-page
    // space stays solid #181818 so the user can see which side of
    // the live viewport they're authoring in.
    const pw = state.page.pageW, ph = state.page.pageH;
    for (let x = 100; x < pw; x += 100) {
      const l = document.createElementNS(SVG_NS, 'line');
      l.setAttribute('x1', x); l.setAttribute('x2', x);
      l.setAttribute('y1', 0); l.setAttribute('y2', ph);
      gridG.appendChild(l);
    }
    for (let y = 100; y < ph; y += 100) {
      const l = document.createElementNS(SVG_NS, 'line');
      l.setAttribute('x1', 0); l.setAttribute('x2', pw);
      l.setAttribute('y1', y); l.setAttribute('y2', y);
      gridG.appendChild(l);
    }
    // v0.8.95: permanent origin indicator. Small "+" at (0, 0) with
    // a "0,0" label and tiny +X / +Y axis arrows. Gives every position
    // number on canvas a visible reference point, so the Parameters
    // panel's mm values are interpretable without the diagnostic grid.
    renderOriginIndicator();
  }

  /**
   * v0.8.95: Origin indicator at (0, 0). Drawn into gridG so it's part
   * of the permanent canvas chrome (re-emitted on every page reflow).
   * Sized via 1/state.zoom so the visual stays small at any zoom level.
   */
  function renderOriginIndicator() {
    const z = state.zoom || 1;
    const armLen   = 14 / z;   // half-length of each + arm, mm
    const arrowLen = 28 / z;   // distance from origin to arrow tip, mm
    const tipSize  = 4  / z;   // arrowhead size
    const labelDx  = 6  / z;
    const labelDy  = 6  / z;
    const g = document.createElementNS(SVG_NS, 'g');
    g.setAttribute('class', 'ed-origin-indicator');
    g.style.pointerEvents = 'none';
    const mkLine = function (x1, y1, x2, y2) {
      const l = document.createElementNS(SVG_NS, 'line');
      l.setAttribute('x1', x1); l.setAttribute('y1', y1);
      l.setAttribute('x2', x2); l.setAttribute('y2', y2);
      l.setAttribute('stroke', '#ffaa33');
      l.setAttribute('stroke-width', '1.5');
      l.style.vectorEffect = 'non-scaling-stroke';
      return l;
    };
    // The crosshair "+"
    g.appendChild(mkLine(-armLen, 0, armLen, 0));
    g.appendChild(mkLine(0, -armLen, 0, armLen));
    // +X axis arrow (right). SVG +y is down, so +Y arrow points down.
    g.appendChild(mkLine(armLen, 0, arrowLen, 0));
    g.appendChild(mkLine(arrowLen, 0, arrowLen - tipSize, -tipSize));
    g.appendChild(mkLine(arrowLen, 0, arrowLen - tipSize, tipSize));
    g.appendChild(mkLine(0, armLen, 0, arrowLen));
    g.appendChild(mkLine(0, arrowLen,  tipSize, arrowLen - tipSize));
    g.appendChild(mkLine(0, arrowLen, -tipSize, arrowLen - tipSize));
    // "0,0" label, just outside the crosshair, top-left-ish
    const lbl = document.createElementNS(SVG_NS, 'text');
    lbl.setAttribute('x', -labelDx);
    lbl.setAttribute('y', -labelDy);
    lbl.setAttribute('fill', '#ffaa33');
    lbl.setAttribute('text-anchor', 'end');
    lbl.setAttribute('font-size', (11 / z));
    lbl.setAttribute('font-family', 'monospace');
    lbl.style.pointerEvents = 'none';
    lbl.textContent = '0,0';
    g.appendChild(lbl);
    // Axis labels at arrow tips
    const xL = document.createElementNS(SVG_NS, 'text');
    xL.setAttribute('x', arrowLen + (3 / z));
    xL.setAttribute('y', 4 / z);
    xL.setAttribute('fill', '#ffaa33');
    xL.setAttribute('font-size', (10 / z));
    xL.setAttribute('font-family', 'monospace');
    xL.style.pointerEvents = 'none';
    xL.textContent = '+X';
    g.appendChild(xL);
    const yL = document.createElementNS(SVG_NS, 'text');
    yL.setAttribute('x', 4 / z);
    yL.setAttribute('y', arrowLen + (10 / z));
    yL.setAttribute('fill', '#ffaa33');
    yL.setAttribute('font-size', (10 / z));
    yL.setAttribute('font-family', 'monospace');
    yL.style.pointerEvents = 'none';
    yL.textContent = '+Y';
    g.appendChild(yL);
    gridG.appendChild(g);
  }

  // Diagnostic grid — cyan ruling spanning the full viewBox, lines
  // every 50px, coords every 100px (checkerboarded so labels don't
  // collide at dense intersections). Toggled by the Grid button;
  // persisted in localStorage so refresh keeps the same view, and
  // the runtime in app.js reads the same flag so the live site shows
  // an identical grid. Useful for visually verifying that authored
  // coordinates land at the same viewport positions in editor and
  // live, and for spotting scroll-driven shifts at a glance.
  let diagGridG = null;
  function ensureDiagGridLayer() {
    if (diagGridG) return;
    diagGridG = document.createElementNS(SVG_NS, 'g');
    diagGridG.setAttribute('id', 'diag-grid');
    diagGridG.style.pointerEvents = 'none';
    // Insert right after the page/bg layer (gridG's location) so the
    // grid sits below committed lines but above the page-area fill.
    gridG.parentNode.insertBefore(diagGridG, gridG.nextSibling);
  }
  function renderDiagGrid() {
    ensureDiagGridLayer();
    diagGridG.innerHTML = '';
    if (!state.showDiagGrid) return;
    // Grid bounds = the full viewBox: page area + symmetric bleed
    // around it. Bleed thickness on each side = (canvas - page) / 2,
    // matching the SVG's actual viewBox offset.
    const pw = state.page.pageW, ph = state.page.pageH;
    const bleedX = (state.page.canvasW - pw) / 2;
    const bleedY = (state.page.canvasH - ph) / 2;
    const X0 = -bleedX, X1 = pw + bleedX, Y0 = -bleedY, Y1 = ph + bleedY;
    const STEP = 50, LABEL_STEP = 100;
    for (let x = X0; x <= X1; x += STEP) {
      const l = document.createElementNS(SVG_NS, 'line');
      l.setAttribute('x1', x); l.setAttribute('y1', Y0);
      l.setAttribute('x2', x); l.setAttribute('y2', Y1);
      l.setAttribute('stroke', '#00FFFF');
      l.setAttribute('stroke-opacity', x % LABEL_STEP === 0 ? '0.5' : '0.2');
      l.setAttribute('stroke-width', '1');
      l.style.vectorEffect = 'non-scaling-stroke';
      diagGridG.appendChild(l);
    }
    for (let y = Y0; y <= Y1; y += STEP) {
      const l = document.createElementNS(SVG_NS, 'line');
      l.setAttribute('x1', X0); l.setAttribute('y1', y);
      l.setAttribute('x2', X1); l.setAttribute('y2', y);
      l.setAttribute('stroke', '#00FFFF');
      l.setAttribute('stroke-opacity', y % LABEL_STEP === 0 ? '0.5' : '0.2');
      l.setAttribute('stroke-width', '1');
      l.style.vectorEffect = 'non-scaling-stroke';
      diagGridG.appendChild(l);
    }
    // Coord labels — at the 100px intersections, checkerboarded so
    // every other intersection gets labelled (cuts the count roughly
    // in half and keeps the grid readable). Format: "x,y".
    for (let x = X0; x <= X1; x += LABEL_STEP) {
      for (let y = Y0; y <= Y1; y += LABEL_STEP) {
        if (((x / LABEL_STEP) + (y / LABEL_STEP)) & 1) continue;
        const t = document.createElementNS(SVG_NS, 'text');
        t.setAttribute('x', x + 3);
        t.setAttribute('y', y + 12);
        t.setAttribute('fill', '#00FFFF');
        t.setAttribute('font-size', '10');
        t.setAttribute('font-family', 'ui-monospace, monospace');
        t.style.opacity = '0.75';
        t.textContent = x + ',' + y;
        diagGridG.appendChild(t);
      }
    }
  }
  function toggleDiagGrid() {
    state.showDiagGrid = !state.showDiagGrid;
    localStorage.setItem('ed-show-diag-grid', state.showDiagGrid ? '1' : '0');
    renderDiagGrid();
  }
  /**
   * Settings modal. Holds preferences that don't deserve a top-level
   * toolbar slot — currently just the runtime-dump diagnostic toggle.
   * Add new settings here as the editor grows (each one is a row with
   * a label, optional help text, and an input).
   */
  function showSettings() {
    const overlay = document.createElement('div');
    overlay.className = 'ed-modal-overlay';
    const modal = document.createElement('div');
    modal.className = 'ed-modal';

    const h = document.createElement('div');
    h.className = 'ed-modal-header';
    const t = document.createElement('h3'); t.textContent = 'Settings';
    h.appendChild(t);
    const x = document.createElement('button');
    x.className = 'ed-modal-close'; x.textContent = '×';
    x.addEventListener('click', cleanup);
    h.appendChild(x);
    modal.appendChild(h);

    const body = document.createElement('div');
    body.className = 'ed-modal-body ed-settings-body';

    body.appendChild(settingRow({
      label: 'Name labels',
      help:  'Show / hide the name label on every named line. The same ' +
             'flag drives the editor canvas and the live site, so you can ' +
             'compare placements across both.',
      value: state.showLabels,
      onChange: function (v) { if (v !== state.showLabels) toggleLabels(); }
    }));

    body.appendChild(settingRow({
      label: 'Page area outline',
      help:  'Live site only. Overlays a dotted rect on the runtime canvas ' +
             'at the authored page boundary, with (0,0)/(pageW,pageH) corner ' +
             'markers. Useful when objects live in the bleed area and you ' +
             'want to see where they sit relative to the visible page.',
      value: state.showPageArea,
      onChange: function (v) { if (v !== state.showPageArea) togglePageArea(); }
    }));

    body.appendChild(settingRow({
      label: 'Coordinate grid',
      help:  'Diagnostic grid: cyan lines at 50px step, coords every 100px. ' +
             'Renders on the live site too — useful for verifying where ' +
             'authored coords land in each surface. With it on, the live ' +
             'site also pins to scrollY=0 and skips scroll-driven motion ' +
             'so shapes show at their authored coords.',
      value: state.showDiagGrid,
      onChange: function (v) { if (v !== state.showDiagGrid) toggleDiagGrid(); }
    }));

    body.appendChild(settingRow({
      label: 'Runtime dump',
      help:  'Live site only. When on, logs a console.table of every named ' +
             'line’s expected center, actual bbox center, shift, and ' +
             'transform attribute at page load. Use this when diagnosing ' +
             'position drift between the editor and the live site.',
      value: state.showRuntimeDump,
      onChange: function (v) {
        state.showRuntimeDump = v;
        localStorage.setItem('ed-show-runtime-dump', v ? '1' : '0');
      }
    }));

    // v0.8.119: numeric setting — multi-select object-panel limit.
    body.appendChild(settingNumberRow({
      label: 'Multi-select panel limit',
      help:  'Multi-selecting objects opens one floating object panel ' +
             'per selected object (each pinned, useful for side-by-side ' +
             'comparison). When the selection exceeds this limit, you ' +
             'will be asked to confirm before the panels open. Set to a ' +
             'small value if you usually want only a quick preview.',
      value: state.multiSelectPanelLimit,
      min:   1,
      onChange: function (v) {
        if (!Number.isFinite(v) || v < 1) return;
        state.multiSelectPanelLimit = v | 0;
        try { localStorage.setItem('ed-multi-panel-limit', String(state.multiSelectPanelLimit)); } catch (e) {}
      }
    }));

    // v0.8.205: Font bundle — list of Google Fonts available for text
    // overlays. One family per line; Save normalizes (trim, dedupe,
    // alpha-sort) and persists via /dev/draw/font-bundle. The TEXT
    // section's font picker (Slice 2a-3b) reads from the same bundle.
    body.appendChild(settingFontBundleRow());

    modal.appendChild(body);

    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    function cleanup() {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
    }
    function onKey(e) { if (e.key === 'Escape') cleanup(); }
    document.addEventListener('keydown', onKey);
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) cleanup();
    });
  }

  function settingRow(spec) {
    const row = document.createElement('div');
    row.className = 'ed-setting-row';
    const main = document.createElement('div');
    main.className = 'ed-setting-main';
    const lbl = document.createElement('label'); lbl.textContent = spec.label;
    const inp = document.createElement('input');
    inp.type = 'checkbox'; inp.checked = !!spec.value;
    inp.addEventListener('change', function () { spec.onChange(inp.checked); });
    main.appendChild(lbl); main.appendChild(inp);
    row.appendChild(main);
    if (spec.help) {
      const help = document.createElement('p');
      help.className = 'ed-setting-help';
      help.textContent = spec.help;
      row.appendChild(help);
    }
    return row;
  }
  // v0.8.119: numeric counterpart to settingRow — same layout, but
  // the control is a small number input. Committed on change/blur.
  function settingNumberRow(spec) {
    const row = document.createElement('div');
    row.className = 'ed-setting-row';
    const main = document.createElement('div');
    main.className = 'ed-setting-main';
    const lbl = document.createElement('label'); lbl.textContent = spec.label;
    const inp = document.createElement('input');
    inp.type = 'number';
    inp.style.width = '5em';
    if (spec.min != null) inp.min = String(spec.min);
    if (spec.max != null) inp.max = String(spec.max);
    if (spec.step != null) inp.step = String(spec.step);
    inp.value = String(spec.value);
    function commit() {
      const v = parseFloat(inp.value);
      spec.onChange(Number.isFinite(v) ? v : spec.value);
    }
    inp.addEventListener('change', commit);
    inp.addEventListener('blur', commit);
    main.appendChild(lbl); main.appendChild(inp);
    row.appendChild(main);
    if (spec.help) {
      const help = document.createElement('p');
      help.className = 'ed-setting-help';
      help.textContent = spec.help;
      row.appendChild(help);
    }
    return row;
  }

  /**
   * Font-bundle row (v0.8.205). Lists the Google Fonts available for
   * text overlays as a textarea, one family per line. Loads the
   * current bundle async via GET /dev/draw/font-bundle on open; the
   * Save button POSTs the normalised list back. Server dedupes,
   * trims, alpha-sorts, and echoes the canonical list — we mirror its
   * response into the textarea so the user sees exactly what was
   * persisted.
   */
  function settingFontBundleRow() {
    const row = document.createElement('div');
    row.className = 'ed-setting-row';

    const main = document.createElement('div');
    main.className = 'ed-setting-main';
    const lbl = document.createElement('label');
    lbl.textContent = 'Font bundle';
    main.appendChild(lbl);
    row.appendChild(main);

    const help = document.createElement('p');
    help.className = 'ed-setting-help';
    help.textContent =
      'Google Fonts available for text overlays. One family per line ' +
      '(e.g. "Inter", "Playfair Display", "Caveat"). Save normalises ' +
      '(trim, dedupe, alpha-sort) and persists; the TEXT section\'s ' +
      'font picker reads from this list. The fonts are loaded on the ' +
      'editor and the live site via Google Fonts CSS.';
    row.appendChild(help);

    const ta = document.createElement('textarea');
    ta.style.cssText =
      'width:100%;min-height:160px;margin-top:0.4rem;' +
      'font:13px/1.4 system-ui,sans-serif;padding:6px;box-sizing:border-box;';
    ta.placeholder = 'Loading current bundle…';
    ta.disabled = true;
    row.appendChild(ta);

    const ctrls = document.createElement('div');
    ctrls.style.cssText = 'display:flex;gap:8px;align-items:center;margin-top:6px;';
    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.textContent = 'Save bundle';
    saveBtn.disabled = true;
    const status = document.createElement('span');
    status.style.cssText = 'flex:1;font-size:0.85em;color:#888;';
    status.textContent = '';
    ctrls.appendChild(saveBtn);
    ctrls.appendChild(status);
    row.appendChild(ctrls);

    function setFromList(list) {
      ta.value = (list || []).join('\n');
    }

    // Load current bundle.
    fetch('/dev/draw/font-bundle', { method: 'GET' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (j && j.ok) {
          setFromList(j.fonts || []);
          status.textContent = (j.fonts || []).length + ' in bundle';
        } else {
          status.textContent = 'Could not load bundle.';
        }
      })
      .catch(function (err) {
        status.textContent = 'Load failed: ' + err.message;
      })
      .then(function () {
        ta.disabled = false;
        saveBtn.disabled = false;
        ta.placeholder = 'One font family per line…';
      });

    saveBtn.addEventListener('click', function () {
      const lines = ta.value.split(/\r?\n/).map(function (s) {
        return s.trim();
      }).filter(function (s) { return s.length > 0; });
      saveBtn.disabled = true;
      status.textContent = 'Saving…';
      fetch('/dev/draw/font-bundle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fonts: lines })
      })
        .then(function (r) {
          return r.json().then(function (j) { return { ok: r.ok, j: j || {} }; });
        })
        .then(function (res) {
          if (res.ok && res.j.ok) {
            setFromList(res.j.fonts || []);
            status.textContent = 'Saved — ' + (res.j.count || 0) + ' fonts.';
            // Refresh in-editor cache + datalist + Google Fonts link
            // so the TEXT picker reflects the new bundle immediately.
            state.fontBundle = (res.j.fonts || []).slice();
            rebuildFontBundleDatalist();
            injectGoogleFontsLink();
          } else {
            status.textContent = 'Save failed: ' + (res.j.error || 'unknown error');
          }
        })
        .catch(function (err) {
          status.textContent = 'Save failed: ' + err.message;
        })
        .then(function () {
          saveBtn.disabled = false;
        });
    });

    return row;
  }

  function resolveStroke(ref) {
    if (!ref) return null;
    const entry = state.palette.find(function (p) { return p.id === ref; });
    return entry ? entry.value : ref; // legacy literal fallback
  }

  /**
   * Map an image-kind `fit` value to the SVG preserveAspectRatio
   * attribute. 'meet' letterboxes, 'slice' fills + crops, 'fill'
   * stretches (disables aspect preservation). Default: 'meet'.
   */
  function imageFitAttr(fit) {
    if (fit === 'slice') return 'xMidYMid slice';
    if (fit === 'fill')  return 'none';
    return 'xMidYMid meet';
  }

  function renderLines() {
    linesG.innerHTML = '';
    state.lines.forEach(function (line) {
      const group = state.groups.find(function (g) { return g.id === line.groupId; });
      const isImage = line.kind === 'image';
      // v0.8.228: textBlock has its own fill (line.fill, distinct
      // from line.stroke). Slice 1a renders just the rect with
      // both colors; Slice 1b will layer wrapped text on top.
      const isTextBlock = line.kind === 'textBlock';

      // Invisible wide hit-target so the line is easy to click for
      // selection — picking a 1.5px stroke pixel-perfectly is awful.
      // The hit target carries the data-line-id; click resolution
      // happens in the SVG pointerup dispatcher.
      const hit = createPath('ed-line-hit', line.d);
      hit.dataset.lineId = line.id;
      linesG.appendChild(hit);

      // Visible path. For image kind it's the bbox outline (so the
      // user can see where the image lives even before a src is set
      // or while the bitmap is loading); the actual <image> is
      // layered on top below.
      const p = createPath('', line.d);
      const strokeRef = line.stroke || (group && group.defaults && group.defaults.stroke) || null;
      const stroke    = resolveStroke(strokeRef);
      const width  = (line.width != null) ? line.width
                   : (group && group.defaults && group.defaults.width != null ? group.defaults.width : null);
      if (stroke) p.style.stroke = stroke;
      // v0.8.242: accept stroke-width 0 (especially useful for textBlock
      // to make the rect outline invisible while keeping the fill). The
      // previous truthy check treated 0 as "absent" and fell through to
      // the CSS default of ~1px. `width != null` keeps null/undefined
      // (no override, no group default) falling through to CSS while
      // honoring an explicit 0.
      if (width != null) p.style.strokeWidth = width;
      if (line.linejoin) p.style.strokeLinejoin = line.linejoin;
      // Fill rules:
      //   - textBlock uses line.fill (independent of stroke);
      //     unset → fill="none" (transparent block, still selectable
      //     via the hit-target).
      //   - `filled` is the source of truth for other kinds when set
      //     (true for primitives, true for closed-loop freehand, etc.)
      //   - falls back to `closed` for legacy data without `filled`
      //   - image kind never gets the fill — the bitmap covers it.
      if (isTextBlock) {
        const fill = resolveStroke(line.fill);
        p.style.fill = fill || 'none';
        // Empty / no-content textBlock: dashed outline so the bbox
        // still reads as "a textBlock lives here" before the author
        // sets fill or stroke. Mirrors the image-kind affordance.
        const blank = !line.fill && !line.stroke;
        if (blank) {
          p.style.strokeDasharray = '4 4';
          if (!stroke) p.style.stroke = '#888';
        }
      } else {
        const wantsFill = !isImage
          && (line.filled !== undefined ? !!line.filled : !!line.closed);
        if (wantsFill && stroke) p.style.fill = stroke;
        if (isImage) {
          p.style.fill = 'none';
          // Dashed outline when no source yet, so the empty bbox still
          // reads as "an image is here" rather than just a thin rect.
          if (!line.params || !line.params.src) {
            p.style.strokeDasharray = '4 4';
            if (!stroke) p.style.stroke = '#888';
          }
        }
      }
      // Primitives rotate around their geometric center, not their
      // bounding box center — matters for odd-vertex polygons and
      // stars where the two differ. (Runtime applies the same logic;
      // the editor doesn't run scroll triggers but we keep transform-
      // box consistent so any preview rotation in the panel agrees.)
      if (line.params) {
        const pa = line.params;
        if ('cx' in pa && 'cy' in pa) {
          p.style.transformBox = 'view-box';
          p.style.transformOrigin = pa.cx + 'px ' + pa.cy + 'px';
        } else if ('x' in pa && 'y' in pa && 'w' in pa && 'h' in pa) {
          p.style.transformBox = 'view-box';
          p.style.transformOrigin = (pa.x + pa.w / 2) + 'px ' + (pa.y + pa.h / 2) + 'px';
        }
      }
      if (isSelected(line.id)) p.classList.add('is-selected');
      // Hidden lines stay visible in the editor (so the user can find
      // them and re-enable) but render at low opacity so they read as
      // "off". A hidden group also fades every line in it. The runtime
      // drops both cases entirely.
      if (line.hidden || (group && group.hidden)) p.style.opacity = '0.18';
      p.dataset.lineId = line.id;
      linesG.appendChild(p);

      // v0.8.195: text overlay. Anchored at the line's geometric
      // center (params or bbox) plus authored (offsetX, offsetY).
      // text-anchor=middle + dominant-baseline=central centers the
      // glyph extent on the anchor point. Color falls back to the
      // line's stroke color so author-set null = "inherit object
      // color". data-text-for ties the <text> to its line so the
      // runtime's writeAt closure can mirror transform/opacity onto
      // it (mirrored in app.js); in the editor we re-render on every
      // edit so no live mutation is needed here.
      const tx = resolveText(line);
      if (tx) {
        const c = lineCenterFor(line, p);
        const ax = c.x + tx.offsetX;
        const tEl = document.createElementNS(SVG_NS, 'text');
        tEl.setAttribute('x', String(ax));
        // v0.8.237: y attribute lands at the em-box top (via
        // dominant-baseline=text-before-edge). The visible glyph top
        // sits slightly below — by an amount that varies per font
        // family (cap-height / ascent ratio). Author compensates by
        // clicking slightly above the desired visual top; no magic
        // per-font correction (the previous 0.15em was Allura-tuned
        // and wrong for other faces).
        tEl.setAttribute('y', String(c.y + tx.offsetY));
        // v0.8.234: no centering — left/top-aligned at the offset
        // point (HTML textbox-like). tspans inherit text-anchor=start.
        // v0.8.235: dominant-baseline=text-before-edge so the y attr
        // marks the TOP of the first line, not its baseline.
        tEl.setAttribute('text-anchor', 'start');
        tEl.setAttribute('dominant-baseline', 'text-before-edge');
        tEl.setAttribute('font-family', tx.fontFamily);
        tEl.setAttribute('font-size', String(tx.fontSize));
        // v0.8.238: text color is a palette id; resolve to CSS.
        // resolveStroke passes through legacy CSS strings unchanged.
        tEl.setAttribute('fill', resolveStroke(tx.color) || stroke || '#888');
        tEl.style.pointerEvents = 'none';
        tEl.dataset.textFor = line.id;
        if (line.hidden || (group && group.hidden)) tEl.style.opacity = '0.18';
        // v0.8.232: multi-line content via tspans. Preserves \n line
        // breaks and runs of whitespace.
        // v0.8.241 (Slice 1b-3): for textBlock, wrap text within the
        // rect's horizontal bounds (anchor → rect right edge) and
        // clip vertical overflow to the rect. Other kinds keep the
        // naive \n-split behavior — they have no natural wrap zone.
        let visualLines;
        if (line.kind === 'textBlock'
            && line.params && Number.isFinite(line.params.x)
            && Number.isFinite(line.params.w) && line.params.w > 0) {
          const maxWidth = Math.max(0, (line.params.x + line.params.w) - ax);
          visualLines = wrapTextToWidth(tx.value, maxWidth, tx.fontSize, tx.fontFamily);
        } else {
          visualLines = String(tx.value == null ? '' : tx.value).split('\n');
        }
        setMultilineText(tEl, visualLines, ax);
        // Clip vertical (and horizontal) overflow to the textBlock
        // rect. Author resizes the rect if they want more text to
        // show; this matches the "HTML textarea inside a box" mental
        // model — content past the bottom edge is hidden.
        if (line.kind === 'textBlock'
            && line.params && Number.isFinite(line.params.x)
            && Number.isFinite(line.params.y)
            && Number.isFinite(line.params.w)
            && Number.isFinite(line.params.h)) {
          const clipId = 'ed-tbclip-' + line.id;
          let cp = linesG.querySelector('clipPath[id="' + clipId + '"]');
          if (!cp) {
            cp = document.createElementNS(SVG_NS, 'clipPath');
            cp.setAttribute('id', clipId);
            cp.appendChild(document.createElementNS(SVG_NS, 'rect'));
            linesG.appendChild(cp);
          }
          const r = cp.firstChild;
          r.setAttribute('x', String(line.params.x));
          r.setAttribute('y', String(line.params.y));
          r.setAttribute('width',  String(line.params.w));
          r.setAttribute('height', String(line.params.h));
          tEl.setAttribute('clip-path', 'url(#' + clipId + ')');
        }
        linesG.appendChild(tEl);
      }

      // Image overlay — emitted only when a src is set. The bitmap
      // sits on top of the bbox path; if it loads, the dashed
      // outline behind it is invisible anyway because the image
      // covers it.
      if (isImage && line.params && line.params.src) {
        const img = document.createElementNS(SVG_NS, 'image');
        img.setAttributeNS(null, 'href', line.params.src);
        img.setAttribute('x', line.params.x);
        img.setAttribute('y', line.params.y);
        img.setAttribute('width',  line.params.w);
        img.setAttribute('height', line.params.h);
        img.setAttribute('preserveAspectRatio', imageFitAttr(line.params.fit));
        img.style.pointerEvents = 'none'; // hit path handles selection
        if (line.hidden || (group && group.hidden)) img.style.opacity = '0.18';
        img.dataset.lineId = line.id;
        linesG.appendChild(img);
      }
    });
    renderLabels();
    renderHandles();
  }

  /**
   * Optional per-line name overlay. For every line that has a `name`
   * set, draw a small label near its midpoint: black text inside a
   * rounded rect filled with the line's own color and bordered black.
   * Toggled by the Labels button in the toolbar (state.showLabels);
   * off by default, persists across reloads via localStorage.
   *
   * The rect is sized to the text's bbox after insertion — SVG text
   * has no intrinsic width, so we render text first, measure, then
   * back-fill the rect.
   */
  function renderLabels() {
    labelsG.innerHTML = '';
    // v0.8.101: link badges run independently of showLabels — they
    // need to appear next to selected objects even when labels are
    // off. Hoisted past the early return below.
    renderLinkBadges();
    if (!state.showLabels) return;

    state.lines.forEach(function (line) {
      if (!line.name) return;
      // Need either points OR primitive params to anchor the label.
      const hasGeo = (Array.isArray(line.points) && line.points.length) ||
                     (PRIMITIVES[line.kind] && line.params);
      if (!hasGeo) return;
      const pos = labelPositionFor(line);
      // v0.8.104: user-draggable label offset. When non-zero, the
      // label is rendered at (pos + offset) and a leader line is drawn
      // from the anchor back to the label edge in the label's border
      // color, so the user can still tell which object owns the label.
      const off = (line.labelOffset && typeof line.labelOffset === 'object')
                    ? line.labelOffset : { x: 0, y: 0 };
      const lx = pos.x + (Number(off.x) || 0);
      const ly = pos.y + (Number(off.y) || 0);

      const group = state.groups.find(function (g) { return g.id === line.groupId; });
      const strokeRef = line.stroke || (group && group.defaults && group.defaults.stroke) || null;
      const fill = resolveStroke(strokeRef) || '#aaa';

      // Leader line: drawn FIRST so the label background covers its
      // tip cleanly. Skipped when the offset is effectively zero (no
      // need to clutter the canvas with a degenerate stub).
      const hasOffset = Math.abs(lx - pos.x) > 0.01 || Math.abs(ly - pos.y) > 0.01;
      if (hasOffset) {
        const z = state.zoom || 1;
        const leader = document.createElementNS(SVG_NS, 'line');
        leader.setAttribute('class', 'ed-label-leader');
        leader.setAttribute('data-line-id', line.id);
        leader.setAttribute('x1', pos.x);
        leader.setAttribute('y1', pos.y);
        leader.setAttribute('x2', lx);
        leader.setAttribute('y2', ly);
        leader.setAttribute('stroke', fill);
        leader.setAttribute('stroke-width', (2 / z));
        leader.style.pointerEvents = 'none';
        labelsG.appendChild(leader);
      }

      const g = document.createElementNS(SVG_NS, 'g');
      g.setAttribute('class', 'ed-label');
      g.setAttribute('transform', 'translate(' + lx + ',' + ly + ')');
      g.style.cursor = 'grab';
      g.setAttribute('data-line-id', line.id);

      const text = document.createElementNS(SVG_NS, 'text');
      text.setAttribute('class', 'ed-label-text');
      text.setAttribute('x', 6);
      text.setAttribute('y', 4);
      // First line: group prefix (Gx) + line name. Group prefix
      // matches the pill in the sidebar.
      const gIdx = state.groups.findIndex(function (gg) { return gg.id === line.groupId; });
      const groupTag = gIdx >= 0 ? 'G' + (gIdx + 1) + ' ' : '';
      const nameSpan = document.createElementNS(SVG_NS, 'tspan');
      nameSpan.setAttribute('x', 6);
      // Prefix with the short master ID in brackets when linked, so the
      // label block carries the master-identity info that used to float
      // separately next to the canvas badge — same info, readable inside
      // the high-contrast label background.
      const midTag = line.masterId ? '[' + shortMasterId(line.masterId) + '] ' : '';
      nameSpan.textContent = groupTag + midTag + line.name;
      text.appendChild(nameSpan);
      // Second line: the line's center coords, useful for debugging
      // initial-position issues (same coords are visible on the live
      // site when Labels is on, so the user can compare drawing vs
      // runtime placement).
      const center = centerOf(line);
      if (center) {
        const coords = document.createElementNS(SVG_NS, 'tspan');
        coords.setAttribute('x', 6);
        coords.setAttribute('dy', '1.15em');
        coords.setAttribute('class', 'ed-label-coords');
        coords.textContent = '(' + Math.round(center.x) + ', ' + Math.round(center.y) + ')';
        text.appendChild(coords);
      }
      g.appendChild(text);
      labelsG.appendChild(g);

      // Now that text is in the DOM, measure it and build the background
      // rect: white fill with a 3px border in the object's own color.
      const bb = text.getBBox();
      const pad = 4;
      const outer = document.createElementNS(SVG_NS, 'rect');
      outer.setAttribute('class', 'ed-label-bg-outer');
      outer.setAttribute('x',      (bb.x - pad).toFixed(1));
      outer.setAttribute('y',      (bb.y - pad).toFixed(1));
      outer.setAttribute('width',  (bb.width  + pad * 2).toFixed(1));
      outer.setAttribute('height', (bb.height + pad * 2).toFixed(1));
      outer.setAttribute('rx', 3);
      outer.style.fill   = 'white';
      outer.style.stroke = fill;
      g.insertBefore(outer, text);

      // v0.8.108: pointerdown on the label group starts an in-place
      // drag. CRITICAL: we MUST NOT call renderLabels() mid-drag, because
      // that does labelsG.innerHTML = '' — which destroys `g`, releases
      // the pointer capture, and silently kills the gesture. Instead we
      // mutate g's transform and the leader line attributes directly.
      // renderLabels() runs only on pointerup (after snapshot).
      //
      // Capture refs so we can close over them in the move handler.
      // leaderRef may be null at start (no offset yet) — created lazily.
      const anchorX = pos.x;
      const anchorY = pos.y;
      let dragStartPt = null;
      let dragStartOff = null;
      let leaderRef = hasOffset ? labelsG.querySelector(
        '.ed-label-leader[data-line-id="' + line.id + '"]'
      ) : null;
      g.addEventListener('pointerdown', function (e) {
        e.stopPropagation();
        e.preventDefault();
        dragStartPt = clientToSvg(e.clientX, e.clientY);
        dragStartOff = {
          x: (line.labelOffset && Number(line.labelOffset.x)) || 0,
          y: (line.labelOffset && Number(line.labelOffset.y)) || 0,
        };
        g.style.cursor = 'grabbing';
        g.setPointerCapture(e.pointerId);
      });
      g.addEventListener('pointermove', function (e) {
        if (!dragStartPt) return;
        const cur = clientToSvg(e.clientX, e.clientY);
        const newOffX = dragStartOff.x + (cur.x - dragStartPt.x);
        const newOffY = dragStartOff.y + (cur.y - dragStartPt.y);
        const lxNew = anchorX + newOffX;
        const lyNew = anchorY + newOffY;
        // Mutate live, no re-render.
        g.setAttribute('transform', 'translate(' + lxNew + ',' + lyNew + ')');
        if (!leaderRef) {
          // Lazily create the leader the first time the label moves
          // off the anchor — covers the common case of starting at
          // offset (0,0) and dragging away.
          leaderRef = document.createElementNS(SVG_NS, 'line');
          leaderRef.setAttribute('class', 'ed-label-leader');
          leaderRef.setAttribute('data-line-id', line.id);
          leaderRef.setAttribute('x1', anchorX);
          leaderRef.setAttribute('y1', anchorY);
          leaderRef.setAttribute('stroke', fill);
          leaderRef.setAttribute('stroke-width', (2 / (state.zoom || 1)));
          leaderRef.style.pointerEvents = 'none';
          labelsG.insertBefore(leaderRef, g);
        }
        leaderRef.setAttribute('x2', lxNew);
        leaderRef.setAttribute('y2', lyNew);
        // Store the committed offset on the line so pointerup snapshot
        // captures it.
        line.labelOffset = { x: newOffX, y: newOffY };
      });
      g.addEventListener('pointerup', function (e) {
        if (!dragStartPt) return;
        e.stopPropagation();
        dragStartPt = null;
        dragStartOff = null;
        g.style.cursor = 'grab';
        try { g.releasePointerCapture(e.pointerId); } catch (err) {}
        // Snap to zero if the user dragged the label very close to its
        // anchor — lets the user reset by dragging it back rather than
        // hunting for a "reset" affordance.
        if (line.labelOffset &&
            Math.abs(line.labelOffset.x) < 2 &&
            Math.abs(line.labelOffset.y) < 2) {
          delete line.labelOffset;
        }
        renderLabels();
        snapshot();
      });
    });
  }

  /**
   * v0.8.101: On-canvas link badge — a small colored circle with the
   * master's letter, paired with a short master-ID label. Drawn for
   * every linked instance (master shared by ≥2 instances) when
   * showLabels is on, OR for any selected linked instance even when
   * labels are off. Singletons get nothing — keeps the canvas
   * uncluttered in the common case.
   *
   * Position: just above the label-anchor point, offset up-left so
   * it sits next to (not on top of) the named label when both are
   * visible. Sized in viewBox units / zoom so the visual size stays
   * constant across zoom levels.
   */
  function renderLinkBadges() {
    const rel = computeMasterRelationships();
    const z = state.zoom || 1;
    const selectedSet = {};
    state.selectedIds.forEach(function (id) { selectedSet[id] = true; });
    // v0.8.219: precompute groupId → template lineId so the per-line
    // pass below can also paint a "template" badge in O(1).
    const templateLineByGroup = {};
    state.groups.forEach(function (gr) {
      if (gr.behaviorTemplateObjectId) {
        templateLineByGroup[gr.id] = gr.behaviorTemplateObjectId;
      }
    });
    // v0.8.210: canvas only renders badges for instances that actually
    // have linked siblings in this class. The previous behavior drew a
    // hollow neutral ring for singletons (mirroring the sidebar's
    // "nothing to say here" placeholder), but the canvas doesn't need
    // a column-alignment placeholder — empty rings just added visual
    // noise around every standalone object. Sidebar still renders the
    // neutral placeholder for layout consistency.
    const inClassCounts = {};
    state.lines.forEach(function (l) {
      if (!l.masterId) return;
      inClassCounts[l.masterId] = (inClassCounts[l.masterId] || 0) + 1;
    });
    state.lines.forEach(function (line) {
      if (!line.masterId) return;
      const entry = rel[line.masterId];
      // Visibility gate: when labels are off, only render for the
      // currently selected lines so the canvas stays clean.
      if (!state.showLabels && !selectedSet[line.id]) return;
      const hasGeo = (Array.isArray(line.points) && line.points.length) ||
                     (PRIMITIVES[line.kind] && line.params);
      if (!hasGeo) return;
      const inClassCount = inClassCounts[line.masterId] || 0;
      const linked = entry && entry.badge && inClassCount >= 2;
      // v0.8.210: skip non-linked instances entirely on the canvas.
      if (!linked) return;
      const pos = labelPositionFor(line);
      const cx = pos.x - (14 / z);
      const cy = pos.y - (24 / z);
      const r  = 14 / z;
      const master = state.masters.find(function (m) { return m.id === line.masterId; });
      const g = document.createElementNS(SVG_NS, 'g');
      g.setAttribute('class', 'ed-link-canvas-badge');
      g.style.pointerEvents = 'none';
      const circ = document.createElementNS(SVG_NS, 'circle');
      circ.setAttribute('cx', cx);
      circ.setAttribute('cy', cy);
      circ.setAttribute('r',  r);
      circ.setAttribute('fill',   'hsl(' + entry.hue + ', 70%, 32%)');
      circ.setAttribute('stroke', '#fff');
      circ.setAttribute('stroke-width', (1.4 / z));
      g.appendChild(circ);
      const letter = document.createElementNS(SVG_NS, 'text');
      letter.setAttribute('x', cx);
      letter.setAttribute('y', cy);
      letter.setAttribute('text-anchor', 'middle');
      letter.setAttribute('dominant-baseline', 'central');
      letter.setAttribute('fill', '#fff');
      letter.setAttribute('font-weight', '700');
      letter.setAttribute('font-size', (17 / z));
      letter.setAttribute('font-family', 'system-ui, sans-serif');
      letter.textContent = entry.badge;
      g.appendChild(letter);
      const ttl = document.createElementNS(SVG_NS, 'title');
      ttl.textContent = (master && master.name ? master.name : line.masterId) +
                        ' · ' + inClassCount + ' linked';
      g.appendChild(ttl);
      labelsG.appendChild(g);
    });

    // v0.8.219: template-object canvas badge. Independent of the
    // link badge above (a template object need not be linked, and a
    // linked object need not be a template). Same visibility gating:
    // when labels are off, draw only for selected lines so the
    // canvas stays clean.
    //
    // Placement: just above the top-left corner of the rendered
    // bounding box. labelPositionFor() (used by link badges) is
    // inconsistent across primitive vs free-form geometries and lands
    // unpredictably for arcs, stars, etc. — bbox top-left works
    // uniformly because getBBox() reads the actual on-screen geometry.
    state.lines.forEach(function (line) {
      if (templateLineByGroup[line.groupId] !== line.id) return;
      if (!state.showLabels && !selectedSet[line.id]) return;
      const hasGeo = (Array.isArray(line.points) && line.points.length) ||
                     (PRIMITIVES[line.kind] && line.params);
      if (!hasGeo) return;
      // For alignment with the position "+" crosshair: that marker
      // anchors to currentBboxTopLeft() (minX/minY over the line's
      // points/segments), not to getBBox() — the two differ when the
      // rendered path has curve overshoot. Use the same source as the
      // crosshair so our cx lines up exactly with the handle column.
      // currentBboxTopLeft returns null for primitives (no points
      // array), in which case fall back to getBBox().
      let anchorX, anchorY;
      const tl = currentBboxTopLeft(line);
      if (tl) {
        anchorX = tl.minX;
        anchorY = tl.minY;
      } else {
        const svgEl = linesG.querySelector('[data-line-id="' + line.id + '"]');
        if (!svgEl) return;
        let bb;
        try { bb = svgEl.getBBox(); }
        catch (e) { return; }
        if (!bb || !Number.isFinite(bb.x) || !Number.isFinite(bb.y)) return;
        anchorX = bb.x;
        anchorY = bb.y;
      }
      const r  = 14 / z;
      // Align the badge over the bbox-move-grip (the small amber
      // square that sits OUTSIDE the bbox top-left corner) for an
      // edge-of-object reading. Grip geometry (when selected):
      //   x0 = anchorX - 16/z, y0 = anchorY - 16/z
      //   side = 14/z → center = (anchorX - 9/z, anchorY - 9/z)
      // Badge sits directly above the grip with a small gap.
      // For primitives there's no grip (renderBboxMoveHandle skips
      // them), so fall back to the bbox top-left column (anchorX).
      const hasGrip = !PRIMITIVES[line.kind];
      const gripCenterX = hasGrip ? (anchorX - 9 / z) : anchorX;
      const gripTopY    = hasGrip ? (anchorY - 16 / z) : anchorY;
      const gap = 6 / z;
      const cx = gripCenterX;
      const cy = gripTopY - gap - r;
      const g = document.createElementNS(SVG_NS, 'g');
      g.setAttribute('class', 'ed-template-canvas-badge');
      g.style.pointerEvents = 'none';
      const circ = document.createElementNS(SVG_NS, 'circle');
      circ.setAttribute('cx', cx);
      circ.setAttribute('cy', cy);
      circ.setAttribute('r',  r);
      // Distinct yellow/amber so it reads as "drives the group",
      // separable from the link badge's hue-per-master scheme.
      circ.setAttribute('fill',   '#d09418');
      circ.setAttribute('stroke', '#fff');
      circ.setAttribute('stroke-width', (1.4 / z));
      g.appendChild(circ);
      const glyph = document.createElementNS(SVG_NS, 'text');
      glyph.setAttribute('x', cx);
      // Triangle reads optically high at central baseline — nudge down.
      glyph.setAttribute('y', cy + (1 / z));
      glyph.setAttribute('text-anchor', 'middle');
      glyph.setAttribute('dominant-baseline', 'central');
      glyph.setAttribute('fill', '#fff');
      glyph.setAttribute('font-weight', '700');
      glyph.setAttribute('font-size', (15 / z));
      glyph.setAttribute('font-family', 'system-ui, sans-serif');
      glyph.textContent = '▶';
      g.appendChild(glyph);
      const grp = state.groups.find(function (gr) { return gr.id === line.groupId; });
      const ttl = document.createElementNS(SVG_NS, 'title');
      ttl.textContent = 'Behavior template for "' + (grp ? grp.name : line.groupId) + '"';
      g.appendChild(ttl);
      labelsG.appendChild(g);
    });
  }

  // Label placement: primitives use their own labelPosition() (anchored
  // to center/bbox); everything else uses the middle vertex of the
  // points array, which lies actually on the line.
  function labelPositionFor(line) {
    if (PRIMITIVES[line.kind] && line.params) {
      return PRIMITIVES[line.kind].labelPosition(line.params);
    }
    const pts = line.points;
    if (!pts || !pts.length) return { x: 0, y: 0 };
    const mid = pts[Math.floor(pts.length / 2)];
    return { x: mid.x + 6, y: mid.y + 6 };
  }

  function toggleLabels() {
    state.showLabels = !state.showLabels;
    localStorage.setItem('ed-show-labels', state.showLabels ? '1' : '0');
    renderLabels();
  }

  // v0.8.16: Page-area outline on the runtime. Editor-side is a no-op
  // (the editor canvas already shows the page rect) — the toggle's
  // only effect is the localStorage flag that the live site reads.
  function togglePageArea() {
    state.showPageArea = !state.showPageArea;
    localStorage.setItem('ed-show-page-area', state.showPageArea ? '1' : '0');
  }

  // "Select all" toggles between every object selected and nothing
  // selected. It just drives the same selectedIds the modifier-click
  // path uses, so the rest of the UI (handles, panel, drag-to-move)
  // doesn't need a separate code path for the all-selected case.
  function toggleSelectAll() {
    if (allObjectsSelected()) clearSelection();
    else state.selectedIds = visibleLines().map(function (l) { return l.id; });
    updateSelectAllButton();
    renderGroupsList();
    renderLines();
    renderSelectionPanel();
  }

  function updateSelectAllButton() {
    const all = allObjectsSelected();
    selectAllBtn.classList.toggle('is-active', all);
    selectAllBtn.textContent = all ? 'Deselect all' : 'Select all';
    // Re-derive Select's active state so it isn't visually
    // co-active with Select-all.
    refreshSelectButtonStates();
  }

  /**
   * Draw the selection handles for the currently selected line.
   * Handles serve as both:
   *   - the visual selection indicator (so the line's authored color
   *     stays visible, unlike a stroke override)
   *   - drag targets that edit the underlying `points` array
   *
   * Freehand strokes can hold many points; we down-sample so handles
   * stay roughly 50 viewBox units apart (the user gets visible dots
   * without clutter) while always preserving the first and last point.
   */
  function renderHandles() {
    handlesG.innerHTML = '';
    // No selection → nothing.
    if (!state.selectedIds.length) return;
    // Multi-select (2+): one accent-colored marker per selected object
    // at its visual center, instead of per-vertex handles. Communicates
    // "these are selected" without flooding the canvas with handles —
    // and matches what the old "Select all" mode used to draw.
    if (state.selectedIds.length > 1) {
      renderMultiSelectedMarkers();
      return;
    }
    const primaryId = primarySelectedId();
    const line = state.lines.find(function (l) { return l.id === primaryId; });
    if (!line) return;

    // If the selected line has an explicit rotation pivot (via its own
    // override or its group's default), draw a crosshair at that point
    // so the user can see where rotations will pivot before saving.
    renderRotateOriginMarker(line);

    // v0.8.95: position marker — a small crosshair + "(x, y)" label at
    // the selected object's bbox top-left. Makes the Position X/Y panel
    // values directly verifiable on canvas; also makes "compare two
    // objects' positions" a select-and-look operation.
    renderSelectedPositionMarker(line);

    // v0.8.99: bbox move grip — a small square just OUTSIDE the bbox
    // top-left, sized so it sits clear of the corner handles. Gives
    // dense-handle drawings a guaranteed drag-to-translate target
    // (otherwise every interior click lands on a vertex handle).
    // Skipped for primitives — they already have a centred move handle.
    renderBboxMoveHandle(line);

    // Handle radius is in viewBox units, but we want a constant visual
    // size regardless of zoom — so divide by zoom.
    const handleR = 6 / state.zoom;

    // Geometric primitives have parameter-driven handles (radius vertex,
    // rect corners, star points, etc.) — dragging one updates `params`
    // and other handles re-position together via PRIMITIVES.handles().
    if (PRIMITIVES[line.kind] && line.params) {
      renderPrimitiveHandles(line, handleR);
      return;
    }
    if (!Array.isArray(line.points) || !line.points.length) return;

    const indices = sparseHandleIndices(line.points, 50);
    indices.forEach(function (idx) {
      const pt = line.points[idx];
      const c  = document.createElementNS(SVG_NS, 'circle');
      c.setAttribute('cx', pt.x);
      c.setAttribute('cy', pt.y);
      c.setAttribute('r',  handleR);
      c.setAttribute('class', 'ed-handle');
      c.dataset.idx    = idx;
      c.dataset.lineId = line.id;

      let dragging = false;
      c.addEventListener('pointerdown', function (e) {
        // v0.8.100: Alt-bypass — Alt+drag-anywhere should translate
        // the whole object even when the click lands on a vertex
        // handle. Returning without stopPropagation lets the event
        // bubble to svg.pointerdown, which then arms a move.
        if (e.altKey) return;
        e.stopPropagation();
        e.preventDefault();
        dragging = true;
        c.classList.add('is-dragging');
        c.setPointerCapture(e.pointerId);
      });
      c.addEventListener('pointermove', function (e) {
        if (!dragging) return;
        const pos = clientToSvg(e.clientX, e.clientY);
        line.points[idx] = { x: pos.x, y: pos.y };
        // Manual lines also have a segments array that mirrors points.
        // Keep them in sync so the segment-aware regenerator preserves
        // C/S/Q curve types when emitting `d`.
        if (line.kind === 'manual' && Array.isArray(line.segments)) {
          const segIdxList = pointSegmentIndices(line.segments);
          const segIdx = segIdxList[idx];
          if (segIdx != null) {
            line.segments[segIdx].endpoint = { x: pos.x, y: pos.y };
          }
        }
        regenerateLineD(line);
        state.dirty = true;
        // Update the moving handle + the line's paths inline (no full
        // re-render — keeps drag smooth and preserves other handles).
        // Each line owns TWO path elements (a wide invisible hit target
        // + the visible stroke), both tagged with data-line-id, so we
        // update all matches — otherwise the visible path stays stale
        // while only the hit area moves.
        c.setAttribute('cx', pos.x);
        c.setAttribute('cy', pos.y);
        linesG.querySelectorAll('[data-line-id="' + line.id + '"]')
          .forEach(function (el) { el.setAttribute('d', line.d); });
        syncTextOverlayPosition(line);
        // Labels read their coords from line.points / line.params, so
        // they need to refresh as the drag moves a point — otherwise
        // the label is stuck at the pre-drag position and shows stale
        // (x, y) text underneath.
        renderLabels();
      });
      c.addEventListener('pointerup', function (e) {
        if (!dragging) return;
        e.stopPropagation();
        dragging = false;
        c.classList.remove('is-dragging');
        // One snapshot per drag — undo restores the entire pre-drag
        // path in a single step, not pixel-by-pixel.
        snapshot();
        // A full re-render after the drag ends syncs every handle
        // position (some may need updates if the path is closed/smoothed).
        renderHandles();
        renderLabels();
        // Panel number-inputs were rendered with pre-drag values and
        // aren't bound to state changes — refresh so they show the new
        // coords too.
        renderSelectionPanel();
      });

      handlesG.appendChild(c);
    });

    // Surface each cubic / quadratic segment's control points as
    // smaller cyan-filled handles + a dashed tangent line back to
    // the anchor. Anchors stay the bigger white-fill handles
    // handled above. Two kinds:
    //   - kind: 'manual' — segments are stored; CP edits go
    //     straight into line.segments[i].controlPoints[j].
    //   - kind: 'bezier' — segments are auto-derived from points
    //     each render. CP edits would have nowhere to go unless
    //     we materialize: on first CP drag the current
    //     auto-smoothed segments get locked in (line.segments =
    //     transient) and line.kind flips to 'manual'. After that
    //     it's a plain manual line.
    if (line.kind === 'manual' && Array.isArray(line.segments)) {
      renderControlPointHandles(line, line.segments, false, handleR);
    } else if (line.kind === 'bezier' && Array.isArray(line.points) && line.points.length >= 2) {
      const transient = bezierSegmentsFromPoints(line.points, line.closed);
      renderControlPointHandles(line, transient, true, handleR);
    }
  }

  function renderControlPointHandles(line, segs, needsMaterialize, handleR) {
    let prevEndpoint = null;
    // Capture the materialize flag in a closure so each CP-handle
    // drag sees the same value (and can flip it on first edit).
    const ctx = { needsMaterialize: needsMaterialize, segs: segs };
    segs.forEach(function (seg, segIdx) {
      if (seg.cmd === 'C' && Array.isArray(seg.controlPoints) && seg.controlPoints.length === 2) {
        // Cubic Bezier — cp1 extends out from the previous endpoint,
        // cp2 reaches back from this segment's endpoint.
        if (prevEndpoint) renderCpHandle(line, ctx, segIdx, 0, seg.controlPoints[0], prevEndpoint, handleR);
        if (seg.endpoint) renderCpHandle(line, ctx, segIdx, 1, seg.controlPoints[1], seg.endpoint, handleR);
      } else if (seg.cmd === 'Q' && Array.isArray(seg.controlPoints) && seg.controlPoints.length === 1) {
        // Quadratic Bezier — single control between prev and ep.
        // Anchor the tangent at the previous endpoint.
        if (prevEndpoint) renderCpHandle(line, ctx, segIdx, 0, seg.controlPoints[0], prevEndpoint, handleR);
      }
      if (seg.endpoint) prevEndpoint = seg.endpoint;
    });
  }

  function renderCpHandle(line, ctx, segIdx, cpIdx, cp, anchorPt, handleR) {
    // Dashed tangent line from the anchor to the control point.
    const tan = document.createElementNS(SVG_NS, 'line');
    tan.setAttribute('class', 'ed-cp-tangent');
    tan.setAttribute('x1', anchorPt.x);
    tan.setAttribute('y1', anchorPt.y);
    tan.setAttribute('x2', cp.x);
    tan.setAttribute('y2', cp.y);
    handlesG.appendChild(tan);

    // The CP handle itself — smaller than anchor handles and
    // inverted (cyan fill, white border) so it reads as a
    // secondary control.
    const c = document.createElementNS(SVG_NS, 'circle');
    c.setAttribute('class', 'ed-handle ed-cp-handle');
    c.setAttribute('cx', cp.x);
    c.setAttribute('cy', cp.y);
    c.setAttribute('r',  handleR * 0.75);
    c.dataset.lineId = line.id;
    c.dataset.segIdx = segIdx;
    c.dataset.cpIdx  = cpIdx;

    let dragging = false;
    c.addEventListener('pointerdown', function (e) {
      // v0.8.100: Alt-bypass (see vertex-handle pointerdown above).
      if (e.altKey) return;
      e.stopPropagation();
      e.preventDefault();
      // For bezier-kind lines the segments aren't stored — they're
      // recomputed each render. The first CP edit locks the current
      // auto-smoothed segments in as the new authoritative shape
      // and promotes the line to 'manual', so subsequent edits
      // persist. After that, ctx.needsMaterialize stays false for
      // this handle session and any sibling CP handles already on
      // the canvas (they share the same ctx).
      if (ctx.needsMaterialize) {
        line.segments = ctx.segs.map(function (s) {
          return {
            cmd: s.cmd,
            controlPoints: (s.controlPoints || []).map(function (cp) { return { x: cp.x, y: cp.y }; }),
            endpoint: s.endpoint ? { x: s.endpoint.x, y: s.endpoint.y } : null
          };
        });
        line.kind = 'manual';
        // Repoint ctx.segs so subsequent pointermove writes land on
        // the just-materialized array, not the throwaway transient.
        ctx.segs = line.segments;
        ctx.needsMaterialize = false;
      }
      dragging = true;
      c.classList.add('is-dragging');
      c.setPointerCapture(e.pointerId);
    });
    c.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      const pos = clientToSvg(e.clientX, e.clientY);
      ctx.segs[segIdx].controlPoints[cpIdx] = { x: pos.x, y: pos.y };
      regenerateLineD(line);
      state.dirty = true;
      // Inline updates — keep the drag smooth without a full
      // renderHandles (which would tear the pointer-capture target
      // out from under us).
      c.setAttribute('cx', pos.x);
      c.setAttribute('cy', pos.y);
      tan.setAttribute('x2', pos.x);
      tan.setAttribute('y2', pos.y);
      linesG.querySelectorAll('[data-line-id="' + line.id + '"]')
        .forEach(function (el) {
          if (el.tagName.toLowerCase() === 'image') return;
          el.setAttribute('d', line.d);
        });
      renderLabels();
    });
    c.addEventListener('pointerup', function (e) {
      if (!dragging) return;
      e.stopPropagation();
      dragging = false;
      c.classList.remove('is-dragging');
      snapshot();
      renderHandles();
    });

    handlesG.appendChild(c);
  }

  /**
   * Render the parameter-driven handles for a geometric primitive.
   * Each handle's position is computed from PRIMITIVES[kind].handles()
   * for the current `params`. Dragging a handle calls updateFromHandle
   * with the cursor position; we update `params`, regenerate `d`, and
   * reposition every handle live so handles that depend on each other
   * (rect corners, star outer/inner) track together.
   */
  function renderPrimitiveHandles(line, handleR) {
    const PRIM = PRIMITIVES[line.kind];
    const handleEls = {};

    function applyHandles(params) {
      const hs = PRIM.handles(params);
      hs.forEach(function (h) {
        const el = handleEls[h.id];
        if (el) { el.setAttribute('cx', h.x); el.setAttribute('cy', h.y); }
      });
    }

    PRIM.handles(line.params).forEach(function (h) {
      const c = document.createElementNS(SVG_NS, 'circle');
      c.setAttribute('cx', h.x);
      c.setAttribute('cy', h.y);
      c.setAttribute('r',  handleR);
      c.setAttribute('class', 'ed-handle');
      c.dataset.handleId = h.id;

      let dragging = false;
      c.addEventListener('pointerdown', function (e) {
        // v0.8.100: Alt-bypass — Alt+drag-anywhere should translate
        // the whole object even when the click lands on a vertex
        // handle. Returning without stopPropagation lets the event
        // bubble to svg.pointerdown, which then arms a move.
        if (e.altKey) return;
        e.stopPropagation();
        e.preventDefault();
        dragging = true;
        c.classList.add('is-dragging');
        c.setPointerCapture(e.pointerId);
      });
      c.addEventListener('pointermove', function (e) {
        if (!dragging) return;
        const pos = clientToSvg(e.clientX, e.clientY);
        line.params = PRIM.updateFromHandle(line.params, h.id, pos);
        regenerateLineD(line);
        state.dirty = true;
        // Update the path's two DOM elements (hit target + visible).
        linesG.querySelectorAll('[data-line-id="' + line.id + '"]')
          .forEach(function (el) { el.setAttribute('d', line.d); });
        syncTextOverlayPosition(line);
        // Reposition every handle so dependents track the dragged one
        // (e.g. rect corners share x/y with neighbors).
        applyHandles(line.params);
        // Labels follow the shape — see point-handle drag for context.
        renderLabels();
      });
      c.addEventListener('pointerup', function (e) {
        if (!dragging) return;
        e.stopPropagation();
        dragging = false;
        c.classList.remove('is-dragging');
        snapshot();
        renderHandles();
        renderLabels();
        // Panel inputs (Center X, Center Y, Radius, …) were rendered
        // with pre-drag values; refresh so the panel agrees with the
        // dragged shape's actual params.
        renderSelectionPanel();
      });

      handleEls[h.id] = c;
      handlesG.appendChild(c);
    });
  }

  // Geometric / visual center of a line, used by select-all markers
  // and by labelPositionFor. For primitives this is the shape's actual
  // center; for free-form lines it's the middle vertex of the points
  // array (a point that's ON the line, not floating in empty space).
  function centerOf(line) {
    if (PRIMITIVES[line.kind] && line.params) {
      const p = line.params;
      if ('cx' in p && 'cy' in p) return { x: p.cx, y: p.cy };
      if ('x' in p && 'w' in p)  return { x: p.x + p.w / 2, y: p.y + p.h / 2 };
    }
    if (Array.isArray(line.points) && line.points.length) {
      const mid = line.points[Math.floor(line.points.length / 2)];
      return { x: mid.x, y: mid.y };
    }
    return null;
  }

  function renderRotateOriginMarker(line) {
    const group = state.groups.find(function (g) { return g.id === line.groupId; });
    // Per-line rotateOrigin (v0.4.6+): delta from natural center,
    // stored on behaviors[0].params. Group-default rotateOrigin
    // stays as an absolute canvas coord — it's group-wide and
    // doesn't track any single object's center.
    const block0 = (line.behaviors && line.behaviors[0]) || null;
    const params0 = (block0 && block0.params) || {};
    const gd  = (group && group.defaults) || {};
    let ox, oy;
    if (Number.isFinite(params0.rotateOriginX) && Number.isFinite(params0.rotateOriginY)) {
      const c = centerOf(line);
      if (!c) return;
      ox = c.x + params0.rotateOriginX;
      oy = c.y + params0.rotateOriginY;
    } else if (Number.isFinite(gd.rotateOriginX) && Number.isFinite(gd.rotateOriginY)) {
      ox = gd.rotateOriginX;
      oy = gd.rotateOriginY;
    } else {
      return; // no custom pivot
    }
    const size = 12 / state.zoom;
    const g = document.createElementNS(SVG_NS, 'g');
    g.setAttribute('class', 'ed-rotate-origin');
    const h = document.createElementNS(SVG_NS, 'line');
    h.setAttribute('x1', ox - size); h.setAttribute('y1', oy);
    h.setAttribute('x2', ox + size); h.setAttribute('y2', oy);
    g.appendChild(h);
    const v = document.createElementNS(SVG_NS, 'line');
    v.setAttribute('x1', ox); v.setAttribute('y1', oy - size);
    v.setAttribute('x2', ox); v.setAttribute('y2', oy + size);
    g.appendChild(v);
    const c = document.createElementNS(SVG_NS, 'circle');
    c.setAttribute('cx', ox); c.setAttribute('cy', oy);
    c.setAttribute('r', 2 / state.zoom);
    g.appendChild(c);
    handlesG.appendChild(g);
  }

  /**
   * v0.8.95: Position marker for the currently-selected single object.
   * Drawn at the bbox top-left — the same point the Parameters panel
   * reports as "Position X/Y". A small + plus a "(x, y)" label gives
   * the panel number a visible counterpart on canvas. Without this,
   * mm coordinates are abstract: with it, "compare two objects" is
   * select one, glance at the marker, select the other, repeat.
   *
   * Color: same accent as the origin indicator so the user reads
   * both as "position chrome". Skipped on primitives (they have
   * native handles that already communicate position; their cx/x in
   * the panel reads against the canvas anyway).
   */
  function renderSelectedPositionMarker(line) {
    if (!line) return;
    if (PRIMITIVES[line.kind] && line.params) return;
    let minX = Infinity, minY = Infinity;
    if (Array.isArray(line.points) && line.points.length) {
      line.points.forEach(function (p) {
        const x = +p.x, y = +p.y;
        if (Number.isFinite(x) && x < minX) minX = x;
        if (Number.isFinite(y) && y < minY) minY = y;
      });
    } else if (Array.isArray(line.segments) && line.segments.length) {
      line.segments.forEach(function (s) {
        if (s.endpoint) {
          const x = +s.endpoint.x, y = +s.endpoint.y;
          if (Number.isFinite(x) && x < minX) minX = x;
          if (Number.isFinite(y) && y < minY) minY = y;
        }
      });
    }
    if (!Number.isFinite(minX) || !Number.isFinite(minY)) return;
    const z = state.zoom || 1;
    const armLen = 8 / z;
    const g = document.createElementNS(SVG_NS, 'g');
    g.setAttribute('class', 'ed-position-marker');
    g.style.pointerEvents = 'none';
    const mkLine = function (x1, y1, x2, y2) {
      const l = document.createElementNS(SVG_NS, 'line');
      l.setAttribute('x1', x1); l.setAttribute('y1', y1);
      l.setAttribute('x2', x2); l.setAttribute('y2', y2);
      l.setAttribute('stroke', '#ffaa33');
      l.setAttribute('stroke-width', '1.5');
      l.style.vectorEffect = 'non-scaling-stroke';
      return l;
    };
    g.appendChild(mkLine(minX - armLen, minY, minX + armLen, minY));
    g.appendChild(mkLine(minX, minY - armLen, minX, minY + armLen));
    const lbl = document.createElementNS(SVG_NS, 'text');
    lbl.setAttribute('x', minX + (armLen + 3 / z));
    lbl.setAttribute('y', minY - (3 / z));
    lbl.setAttribute('fill', '#ffaa33');
    lbl.setAttribute('font-size', (11 / z));
    lbl.setAttribute('font-family', 'monospace');
    lbl.style.pointerEvents = 'none';
    lbl.textContent = '(' + minX.toFixed(1) + ', ' + minY.toFixed(1) + ')';
    g.appendChild(lbl);
    handlesG.appendChild(g);
  }

  /**
   * v0.8.99: A draggable square positioned just OUTSIDE the bbox
   * top-left corner — by exactly its own size, so it never collides
   * with vertex handles that cluster at the corner. Drives the same
   * shiftLineBy translate that arrow-key nudges use, with sibling
   * fan-out in ALL mode and one snapshot on pointerup.
   *
   * Skips primitives (they have a centred move handle already) and
   * skips lines with no finite-coord geometry. The grip element
   * itself never re-renders mid-drag (the rest of the handle layer
   * would be torn down, breaking pointer capture); we mutate its
   * x/y in lockstep with the shift.
   */
  function renderBboxMoveHandle(line) {
    if (!line) return;
    if (PRIMITIVES[line.kind]) return;
    const tl = currentBboxTopLeft(line);
    if (!tl) return;
    const z = state.zoom || 1;
    const size = 14 / z;   // grip side in canvas units
    const gap  = 2 / z;    // small breathing room between grip and bbox corner
    const x0 = tl.minX - size - gap;
    const y0 = tl.minY - size - gap;
    const rect = document.createElementNS(SVG_NS, 'rect');
    rect.setAttribute('x', x0);
    rect.setAttribute('y', y0);
    rect.setAttribute('width',  size);
    rect.setAttribute('height', size);
    rect.setAttribute('rx', (3 / z));
    rect.setAttribute('ry', (3 / z));
    rect.setAttribute('fill', 'rgba(255, 170, 51, 0.85)');
    rect.setAttribute('stroke', '#7a4a00');
    rect.setAttribute('stroke-width', (1 / z));
    rect.style.vectorEffect = 'non-scaling-stroke';
    rect.style.cursor = 'move';
    rect.setAttribute('class', 'ed-bbox-move-grip');
    // Visual ✥ glyph inside to communicate "move". Pointer-events
    // none so it doesn't intercept events meant for the rect.
    const glyph = document.createElementNS(SVG_NS, 'text');
    glyph.setAttribute('x', x0 + size / 2);
    glyph.setAttribute('y', y0 + size / 2);
    glyph.setAttribute('text-anchor', 'middle');
    glyph.setAttribute('dominant-baseline', 'central');
    glyph.setAttribute('font-size', (10 / z));
    glyph.setAttribute('fill', '#222');
    glyph.style.pointerEvents = 'none';
    glyph.textContent = '✥';

    let dragging = false;
    let lastPt = null;
    rect.addEventListener('pointerdown', function (e) {
      e.stopPropagation();
      e.preventDefault();
      dragging = true;
      lastPt = clientToSvg(e.clientX, e.clientY);
      rect.setPointerCapture(e.pointerId);
    });
    rect.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      const cur = clientToSvg(e.clientX, e.clientY);
      const dx = cur.x - lastPt.x;
      const dy = cur.y - lastPt.y;
      if (dx === 0 && dy === 0) return;
      // Incremental shift — no snapshot, no re-render of handles
      // (which would tear down this grip and break pointer capture).
      nudgeSelectionBy(dx, dy, { snapshot: false });
      lastPt = cur;
      // Move the visible paths in lockstep. Mirrors what the regular
      // drag does (linesG.querySelectorAll by data-line-id).
      state.selectedIds.forEach(function (id) {
        const l = state.lines.find(function (ll) { return ll.id === id; });
        if (!l) return;
        linesG.querySelectorAll('[data-line-id="' + l.id + '"]')
          .forEach(function (el) {
            if (el.tagName.toLowerCase() === 'image' && l.params) {
              el.setAttribute('x', l.params.x);
              el.setAttribute('y', l.params.y);
            } else if (l.d) {
              el.setAttribute('d', l.d);
            }
          });
        syncTextOverlayPosition(l);
      });
      // Slide the grip itself so it stays anchored to the moving bbox.
      const newX = parseFloat(rect.getAttribute('x')) + dx;
      const newY = parseFloat(rect.getAttribute('y')) + dy;
      rect.setAttribute('x', newX);
      rect.setAttribute('y', newY);
      glyph.setAttribute('x', newX + size / 2);
      glyph.setAttribute('y', newY + size / 2);
    });
    rect.addEventListener('pointerup', function (e) {
      if (!dragging) return;
      e.stopPropagation();
      dragging = false;
      try { rect.releasePointerCapture(e.pointerId); } catch (err) {}
      // One snapshot per gesture, and a full re-render to refresh
      // labels / position marker / panel / sibling-class state.
      snapshot();
      renderLines();
      renderHandles();
      renderLabels();
      renderSelectionPanel({ suppressScroll: true });
    });
    handlesG.appendChild(rect);
    handlesG.appendChild(glyph);
  }

  function renderMultiSelectedMarkers() {
    const r = 7 / state.zoom;
    state.selectedIds.forEach(function (id) {
      const line = state.lines.find(function (l) { return l.id === id; });
      if (!line || line.hidden) return;
      const c = centerOf(line);
      if (!c) return;
      const dot = document.createElementNS(SVG_NS, 'circle');
      dot.setAttribute('cx', c.x);
      dot.setAttribute('cy', c.y);
      dot.setAttribute('r',  r);
      dot.setAttribute('class', 'ed-handle-all');
      handlesG.appendChild(dot);
    });
  }

  function sparseHandleIndices(points, minDist) {
    if (points.length <= 1) return points.map(function (_, i) { return i; });
    const md2 = minDist * minDist;
    const out = [0];
    let last = points[0];
    for (let i = 1; i < points.length - 1; i++) {
      const dx = points[i].x - last.x;
      const dy = points[i].y - last.y;
      if (dx * dx + dy * dy >= md2) { out.push(i); last = points[i]; }
    }
    if (out[out.length - 1] !== points.length - 1) out.push(points.length - 1);
    return out;
  }

  function renderGroupsList() {
    groupsListEl.innerHTML = '';
    // v0.8.101: compute once per render so every line row in this
    // pass gets the same badge map (cheap, but pointless to redo
    // per line).
    const rel = computeMasterRelationships();
    // v0.8.107: in-class instance counts per masterId. Used by the
    // row badge to decide colored-letter vs neutral-empty rendering.
    const inClassCounts = {};
    state.lines.forEach(function (l) {
      if (!l.masterId) return;
      inClassCounts[l.masterId] = (inClassCounts[l.masterId] || 0) + 1;
    });
    // v0.8.171: collected for the post-append fit pass. We need the rows
    // to be in the DOM to read scrollWidth/clientWidth, so the fit runs
    // after the loop, not inline per-row.
    const nameRefsToFit = [];
    state.groups.forEach(function (g, gIdx) {
      const isOpen = !!state.openGroupIds[g.id];
      const li = document.createElement('li');
      li.className = 'ed-group'
        + (g.id === state.activeGroupId ? ' is-active' : '')
        + (isOpen ? ' is-open' : '');

      const row = document.createElement('div');
      row.className = 'ed-group-row';
      // v0.8.29: group row is itself draggable for Z-reorder. The
      // dragstart uses a distinct dataTransfer type from the line
      // and behavior-block drags so the dropover/drop handlers
      // below can route by intent.
      row.draggable = true;
      row.addEventListener('dragstart', function (e) {
        if (!e.dataTransfer) return;
        e.dataTransfer.setData('text/x-group-id', g.id);
        e.dataTransfer.effectAllowed = 'move';
        row.classList.add('ed-group-dragging');
      });
      row.addEventListener('dragend', function () {
        row.classList.remove('ed-group-dragging');
      });

      // Group index pill (G1, G2, …) sitting where the disclosure
      // triangle used to be. Matched by the "Gx" prefix on canvas
      // labels so the user can tell at a glance which group an
      // on-canvas label belongs to. The whole row is the click target
      // and the line-list visibility itself indicates open state.
      const idx = state.groups.indexOf(g);
      const toggle = document.createElement('span');
      toggle.className = 'ed-group-toggle';
      toggle.textContent = 'G' + (idx + 1);
      row.appendChild(toggle);

      const name = document.createElement('span');
      name.className = 'ed-group-name';
      name.textContent = g.name;
      nameRefsToFit.push(name);
      const count = document.createElement('span');
      count.className = 'ed-group-count';
      const n = state.lines.filter(function (l) { return l.groupId === g.id; }).length;
      count.textContent = n + ' line' + (n === 1 ? '' : 's');
      row.appendChild(name);
      row.appendChild(count);
      // Inline 👁 + ✕ controls — both stopPropagation so they don't
      // also trigger the row's "open this group" click handler.
      const eye = document.createElement('button');
      eye.type = 'button';
      eye.className = 'ed-group-eye' + (g.hidden ? ' is-hidden' : '');
      eye.textContent = g.hidden ? '⊘' : '●';
      eye.title = g.hidden ? 'Group is hidden — click to show' : 'Group is visible — click to hide';
      eye.setAttribute('aria-label', eye.title);
      eye.addEventListener('click', function (e) {
        e.stopPropagation();
        updateGroup(g.id, { hidden: !g.hidden });
        snapshot();
        renderGroupsList();
        renderLines();
      });
      row.appendChild(eye);
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'ed-group-delete';
      del.textContent = '×';
      del.title = 'Delete group…';
      del.setAttribute('aria-label', 'Delete group');
      del.addEventListener('click', function (e) {
        e.stopPropagation();
        confirmAndDeleteGroup(g);
      });
      row.appendChild(del);
      if (g.hidden) li.classList.add('is-hidden');
      row.addEventListener('click', function () {
        const wasOpen = !!state.openGroupIds[g.id];
        state.activeGroupId = g.id;
        state.openGroupIds[g.id] = !wasOpen;
        // Clicking a group row always means "this group is the focus
        // now" — drop any leftover line selection so the next edit
        // goes to the group's settings, not to a stale line. Also
        // re-render the lines layer so the handle dots from the
        // previously selected line disappear with it.
        clearSelection();
        renderGroupsList();
        renderLines();
        renderSelectionPanel();
      });
      // Group row accepts two drag types:
      //   - text/x-line-id  → re-home the dragged line(s) into this
      //     group (existing).
      //   - text/x-group-id → reorder this group above or below the
      //     hovered one (v0.8.29). Above/below is decided by mouse
      //     Y vs row midpoint, same as the line and behavior-block
      //     drop targets.
      row.addEventListener('dragenter', function (e) {
        if (!e.dataTransfer) return;
        const types = Array.from(e.dataTransfer.types);
        if (types.indexOf('text/x-line-id') !== -1) {
          e.preventDefault();
          row.classList.add('ed-drop-target');
        } else if (types.indexOf('text/x-group-id') !== -1) {
          e.preventDefault();
        }
      });
      row.addEventListener('dragover', function (e) {
        if (!e.dataTransfer) return;
        const types = Array.from(e.dataTransfer.types);
        if (types.indexOf('text/x-line-id') !== -1) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
        } else if (types.indexOf('text/x-group-id') !== -1) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          // Hide the source's own ghost target — dropping a group
          // onto itself is a no-op so don't tease the user with an
          // indicator. The group-id payload identifies the source.
          const srcId = e.dataTransfer.getData('text/x-group-id');
          if (srcId === g.id) return;
          const rect = row.getBoundingClientRect();
          const isAbove = e.clientY < rect.top + rect.height / 2;
          row.classList.toggle('ed-drop-above', isAbove);
          row.classList.toggle('ed-drop-below', !isAbove);
        }
      });
      row.addEventListener('dragleave', function (e) {
        // Only clear when leaving the row itself (not when entering
        // a nested span like the count badge).
        if (!row.contains(e.relatedTarget)) {
          row.classList.remove('ed-drop-target');
          row.classList.remove('ed-drop-above');
          row.classList.remove('ed-drop-below');
        }
      });
      row.addEventListener('drop', function (e) {
        row.classList.remove('ed-drop-target');
        row.classList.remove('ed-drop-above');
        row.classList.remove('ed-drop-below');
        if (!e.dataTransfer) return;
        const types = Array.from(e.dataTransfer.types);
        // Group reorder takes precedence: a group payload trumps
        // any stray line payload that might also be present.
        if (types.indexOf('text/x-group-id') !== -1) {
          const srcId = e.dataTransfer.getData('text/x-group-id');
          if (!srcId || srcId === g.id) return;
          e.preventDefault();
          e.stopPropagation();
          const fromIdx = state.groups.findIndex(function (x) { return x.id === srcId; });
          if (fromIdx === -1) return;
          const rect = row.getBoundingClientRect();
          const isAbove = e.clientY < rect.top + rect.height / 2;
          const toIdx = isAbove ? gIdx : gIdx + 1;
          moveGroup(fromIdx, toIdx);
          return;
        }
        const lineId = e.dataTransfer.getData('text/x-line-id');
        if (lineId) {
          e.preventDefault();
          // If the dragged line is part of an active multi-selection,
          // move every selected line in lockstep — otherwise the user
          // has to drop each one individually, which is a footgun
          // when "select N + drag to new group" reads as one action.
          const inSel = state.selectedIds.indexOf(lineId) !== -1;
          const ids = (inSel && state.selectedIds.length > 1)
            ? state.selectedIds.slice()
            : [lineId];
          moveLinesToGroup(ids, g.id);
        }
      });
      li.appendChild(row);

      // Inline list of lines belonging to this group. Hidden by CSS
      // when the group isn't open.
      const ll = document.createElement('ul');
      ll.className = 'ed-line-list';
      state.lines.filter(function (l) { return l.groupId === g.id; })
        .forEach(function (line) {
          const lr = document.createElement('li');
          lr.className = 'ed-line-row' + (isSelected(line.id) ? ' is-selected' : '');
          // Drag-and-drop source: a line row can be dragged onto any
          // group row in the sidebar to move the line into that group.
          // v0.8.28: line rows are ALSO drop targets — dropping onto
          // a row inserts the dragged line(s) above or below it, in
          // either the same or another group (state.lines position
          // drives canvas Z-stacking, so this is also "send forward /
          // backward").
          lr.draggable = true;
          lr.addEventListener('dragstart', function (e) {
            e.dataTransfer.setData('text/x-line-id', line.id);
            e.dataTransfer.effectAllowed = 'move';
            lr.classList.add('ed-line-dragging');
          });
          lr.addEventListener('dragend', function () {
            lr.classList.remove('ed-line-dragging');
          });
          lr.addEventListener('dragover', function (e) {
            if (!e.dataTransfer) return;
            if (Array.from(e.dataTransfer.types).indexOf('text/x-line-id') === -1) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            const rect = lr.getBoundingClientRect();
            const isAbove = e.clientY < rect.top + rect.height / 2;
            lr.classList.toggle('ed-drop-above', isAbove);
            lr.classList.toggle('ed-drop-below', !isAbove);
          });
          lr.addEventListener('dragleave', function (e) {
            if (!lr.contains(e.relatedTarget)) {
              lr.classList.remove('ed-drop-above');
              lr.classList.remove('ed-drop-below');
            }
          });
          lr.addEventListener('drop', function (e) {
            lr.classList.remove('ed-drop-above');
            lr.classList.remove('ed-drop-below');
            const draggedId = e.dataTransfer && e.dataTransfer.getData('text/x-line-id');
            if (!draggedId || draggedId === line.id) return;
            e.preventDefault();
            // Stop the bubble — without this the group row's drop
            // handler also fires and moves the line to the END of
            // the group, undoing the positional drop.
            e.stopPropagation();
            const rect = lr.getBoundingClientRect();
            const isAbove = e.clientY < rect.top + rect.height / 2;
            // Multi-selection lockstep, same idiom as the group-row
            // drop: if the dragged line is part of an active multi-
            // selection, every selected line moves together.
            const inSel = state.selectedIds.indexOf(draggedId) !== -1;
            const ids = (inSel && state.selectedIds.length > 1)
              ? state.selectedIds.slice()
              : [draggedId];
            moveLinesAdjacentTo(ids, line.id, isAbove ? 'before' : 'after', g.id);
          });
          const idSpan = document.createElement('span');
          if (line.name) {
            idSpan.className = 'ed-line-name';
            idSpan.textContent = line.name;
            idSpan.title = line.id + ' — ⌥ Option-click to open detail panel';
          } else {
            idSpan.className = 'ed-line-id';
            idSpan.textContent = line.id;
            idSpan.title = '⌥ Option-click to open detail panel';
          }
          const overrideTag = document.createElement('span');
          overrideTag.style.color = '#888';
          overrideTag.textContent = (line.overrides && Object.keys(line.overrides).length) ? '*' : '';
          // v0.8.51: small behavior-count badge on the row's right
          // side, alongside the `*` override marker. Hidden when 0
          // so lines without behaviors don't clutter the list; non-
          // zero counts read at a glance during selection / drag.
          // The per-line panel still shows "N behaviors" (including
          // 0) — this is the compact list-view version of the same
          // stat.
          const bCount = Array.isArray(line.behaviors) ? line.behaviors.length : 0;
          const rightWrap = document.createElement('span');
          rightWrap.className = 'ed-line-row-right';
          // v0.8.219: template badge — this object is the group's
          // behavior template. Small chip with a "▶" play glyph,
          // distinct color so it doesn't blur with the link badge.
          if (g.behaviorTemplateObjectId === line.id) {
            const tplBadge = document.createElement('span');
            tplBadge.className = 'ed-template-badge';
            tplBadge.textContent = '▶';
            tplBadge.title = 'Behavior template for "' + g.name + '" — every member adopts this object’s behaviors.';
            rightWrap.appendChild(tplBadge);
          }
          // v0.8.101: link badge — colored circle with a per-master
          // letter. Only present when this line's master has ≥2
          // instances (linked); single-instance objects stay
          // uncluttered. Lives in the right column alongside the
          // override marker and behavior count.
          const linkBadge = buildLinkBadgeHTML(line.masterId, rel,
                                                 inClassCounts[line.masterId] || 0);
          if (linkBadge) rightWrap.appendChild(linkBadge);
          rightWrap.appendChild(overrideTag);
          // v0.8.52: always render the behavior badge — "-" for zero
          // counts, the number otherwise. Consistent column position
          // across the list, so the eye reads the row's metadata at
          // a fixed location instead of jumping when a count appears
          // or disappears.
          const bBadge = document.createElement('span');
          bBadge.className = 'ed-line-bcount' + (bCount === 0 ? ' is-zero' : '');
          bBadge.textContent = bCount > 0 ? bCount : '-';
          bBadge.title = bCount > 0
            ? bCount + ' behavior block' + (bCount === 1 ? '' : 's')
            : 'No behavior blocks';
          rightWrap.appendChild(bBadge);
          // v0.8.135: panel-open button — visible on row hover, same
          // affordance as ⌥ option-click but discoverable.
          const panelBtn = document.createElement('button');
          panelBtn.type = 'button';
          panelBtn.className = 'ed-line-panel-btn' +
            (isObjectPanelOpenFor(line.id) ? ' is-panel-open' : '');
          panelBtn.dataset.lineId = line.id;
          panelBtn.textContent = '⊞';
          panelBtn.title = 'Open detail panel (⌥ Option-click also works)';
          panelBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            // v0.8.141: capture intent BEFORE selection change.
            // If we call toggleObjectPanelFor after selectOnly(), an
            // unpinned panel has already rebound to this object via
            // notifySelection, so the toggle sees "panel open for this
            // object" and closes instead of opens. Snapshot the state
            // now, then act directly.
            const alreadyOpen = isObjectPanelOpenFor(line.id);
            if (!isSelected(line.id)) {
              selectOnly(line.id);
              state.activeGroupId  = g.id;
              state.openGroupIds[g.id] = true;
              sidebarAnchorLineId  = line.id;
              sidebarAnchorGroupId = g.id;
              updateSelectAllButton();
              renderGroupsList();
              renderLines();
              renderSelectionPanel({ suppressScroll: true });
            }
            if (alreadyOpen) {
              // Close whichever panel was showing this object.
              const opn = window.PanelManager
                ? window.PanelManager.listOpen().filter(function (p) { return p.type === 'object'; })
                : [];
              const pinned = opn.find(function (p) { return p.pinned && p.objectId === line.id; });
              const target = pinned || opn.find(function (p) { return !p.pinned; });
              if (target) { try { window.PanelManager.close(target.id); } catch (ex) {} }
            } else {
              // Close any existing unpinned object panel first — it
              // rebound to this object via notifySelection but the user
              // is explicitly asking for a fresh panel here, not a
              // leftover follower from the previous selection.
              if (window.PanelManager) {
                const opn2 = window.PanelManager.listOpen().filter(function (p) {
                  return p.type === 'object' && !p.pinned;
                });
                opn2.forEach(function (p) {
                  try { window.PanelManager.close(p.id); } catch (ex) {}
                });
              }
              // Open a fresh panel — primary is now this object.
              try { window.PanelManager.open('object'); } catch (ex) { console.error(ex); }
            }
          });
          rightWrap.appendChild(panelBtn);
          lr.appendChild(idSpan);
          lr.appendChild(rightWrap);
          lr.addEventListener('click', function (e) {
            e.stopPropagation();
            // v0.8.48: Mac-standard sidebar multi-select.
            //   Cmd/Ctrl-click  → toggle this row in/out of selection
            //                     (anchor moves to this row).
            //   Shift-click     → select range from anchor to this
            //                     row, REPLACING selection — but only
            //                     within the same group as the anchor.
            //                     Cross-group shift-click falls back
            //                     to plain click (Finder convention).
            //   Plain click     → replace selection with just this row
            //                     (anchor moves to this row).
            // Cmd takes precedence over Shift when both held.
            //
            // v0.8.126: opt-click (alt) mirrors the canvas gesture —
            // toggle the floating panel for this line's object,
            // selecting it first if it isn't already the sole
            // selection. Alt takes precedence over cmd/shift here;
            // it's a panel-management gesture, not a selection one.
            if (e.altKey) {
              if (!isSelected(line.id)) {
                selectOnly(line.id);
                state.activeGroupId  = g.id;
                state.openGroupIds[g.id] = true;
                sidebarAnchorLineId  = line.id;
                sidebarAnchorGroupId = g.id;
                updateSelectAllButton();
                renderGroupsList();
                renderLines();
                // suppressScroll: opt-click is panel-management, not
                // a "show me this object's properties" gesture, so
                // skip the auto-scroll-to-panel that plain click does.
                renderSelectionPanel({ suppressScroll: true });
              }
              toggleObjectPanelFor(line.id);
              return;
            }
            const isCmd   = e.metaKey || e.ctrlKey;
            const isShift = e.shiftKey && !isCmd;
            let isMulti = false;
            const canRange = isShift
                          && sidebarAnchorLineId
                          && sidebarAnchorGroupId === g.id;
            if (canRange) {
              const groupLines = state.lines.filter(function (l) {
                return l.groupId === g.id;
              });
              const ai = groupLines.findIndex(function (l) { return l.id === sidebarAnchorLineId; });
              const ci = groupLines.findIndex(function (l) { return l.id === line.id; });
              if (ai !== -1 && ci !== -1) {
                const lo = Math.min(ai, ci), hi = Math.max(ai, ci);
                state.selectedIds = groupLines.slice(lo, hi + 1).map(function (l) { return l.id; });
                isMulti = true;
                // Anchor stays put — Mac convention; further shift-
                // clicks extend from the same origin until a plain
                // or Cmd click resets it.
              }
            } else if (isCmd) {
              toggleInSelection(line.id);
              sidebarAnchorLineId  = line.id;
              sidebarAnchorGroupId = g.id;
              isMulti = true;
            } else {
              // Plain click — or shift-click without a usable anchor
              // (no prior anchor, or anchor was in a different group).
              selectOnly(line.id);
              sidebarAnchorLineId  = line.id;
              sidebarAnchorGroupId = g.id;
            }
            state.activeGroupId  = g.id;
            state.openGroupIds[g.id] = true;
            updateSelectAllButton();
            renderGroupsList();
            renderLines();
            // v0.8.27: see canvas click handler — multi-select gesture
            // doesn't auto-scroll the sidebar panel.
            renderSelectionPanel(isMulti ? { suppressScroll: true } : undefined);
          });
          ll.appendChild(lr);
        });
      li.appendChild(ll);

      groupsListEl.appendChild(li);
    });

    // v0.8.171/172: post-append name-fit pass. Run synchronously so the
    // initial paint is already fitted, AND wire a ResizeObserver below
    // so any later width change (scrollbar appearance when a group
    // opens its line-list, sidebar resize, viewport resize) also
    // triggers a refit.
    nameRefsToFit.forEach(fitGroupName);
    ensureGroupNameFitObserver();
  }

  // v0.8.172: shared fit helper, reused by both the synchronous pass
  // in renderGroupsList AND the ResizeObserver below. Critically, it
  // RESETS any prior inline styles before measuring — otherwise a
  // previously-shrunk-and-nowrapped name would stay shrunk forever
  // even after the row regains width (e.g. scrollbar disappears).
  //
  // Algorithm:
  //   1. Clear inline fontSize + whiteSpace so getComputedStyle reads
  //      the stylesheet defaults.
  //   2. Force `white-space: nowrap`. Combined with `min-width: 0` on
  //      .ed-group-name (CSS), this lets the name shrink below its
  //      content size in the flex row, so `scrollWidth` reports the
  //      un-wrapped text width while `clientWidth` reports the slot
  //      the flex layout allocated. The comparison is meaningful.
  //   3. If scrollWidth ≤ clientWidth → fits naturally, restore wrap.
  //   4. Else try one 2px shrink (≈1.5pt, within the user-specified
  //      2pt budget). If it now fits → keep nowrap + smaller font.
  //   5. Else fully restore — let it wrap at the original size.
  function fitGroupName(el) {
    // Reset first so we can re-evaluate from the stylesheet baseline.
    el.style.fontSize = '';
    el.style.whiteSpace = '';
    const cs = getComputedStyle(el);
    const origSize = parseFloat(cs.fontSize) || 15;
    // Force single-line measurement.
    el.style.whiteSpace = 'nowrap';
    if (el.scrollWidth <= el.clientWidth) {
      el.style.whiteSpace = '';
      return;
    }
    el.style.fontSize = Math.max(9, origSize - 2) + 'px';
    if (el.scrollWidth <= el.clientWidth) return;
    el.style.fontSize = '';
    el.style.whiteSpace = '';
  }

  // v0.8.172: a single ResizeObserver on groupsListEl catches every
  // layout state the synchronous fit pass can't see on its own —
  // the canonical case is "user clicks a closed group → line-list
  // becomes visible → sidebar scroll container grows a vertical
  // scrollbar → groupsListEl narrows by ~15px → previously-fitting
  // names now overflow". The observer fires whenever the list's
  // own size changes, and we re-fit every name currently in the
  // DOM. A rAF debounce prevents reentrant loops if font shrink
  // happens to flip the scrollbar state.
  let _groupNameFitObserver = null;
  let _groupNameFitPending = false;
  function ensureGroupNameFitObserver() {
    if (_groupNameFitObserver || typeof ResizeObserver === 'undefined') return;
    if (!groupsListEl) return;
    _groupNameFitObserver = new ResizeObserver(function () {
      if (_groupNameFitPending) return;
      _groupNameFitPending = true;
      requestAnimationFrame(function () {
        _groupNameFitPending = false;
        const names = groupsListEl.querySelectorAll('.ed-group-name');
        for (let i = 0; i < names.length; i++) fitGroupName(names[i]);
      });
    });
    _groupNameFitObserver.observe(groupsListEl);
  }

  // ── Palette panel ─────────────────────────────────────────────────
  function renderPaletteList() {
    paletteListEl.innerHTML = '';
    state.palette.forEach(function (c) {
      const li = document.createElement('li');
      li.className = 'ed-palette-row';

      const sw = document.createElement('span');
      sw.className = 'ed-palette-swatch';
      sw.style.background = c.value;

      const nameInp = document.createElement('input');
      nameInp.type = 'text';
      nameInp.value = c.name;
      nameInp.placeholder = 'name';
      nameInp.addEventListener('input', function () {
        c.name = nameInp.value;
        state.dirty = true;
        scheduleSnapshot();
      });

      const valInp = document.createElement('input');
      valInp.type = 'text';
      valInp.value = c.value;
      valInp.placeholder = 'css color';
      valInp.addEventListener('input', function () {
        c.value = valInp.value;
        sw.style.background = c.value;
        state.dirty = true;
        renderLines();             // canvas reflects new color
        renderSelectionPanel();    // active swatch glow follows it
        scheduleSnapshot();
      });

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'ed-mini';
      del.style.borderColor = '#855';
      del.style.color = '#f88';
      del.textContent = '×';
      del.title = 'Delete color';
      del.addEventListener('click', function () {
        if (!confirm('Delete color "' + c.name + '"? Lines using it will revert to inherit.')) return;
        // Clear references in groups + lines.
        state.groups.forEach(function (g) {
          if (g.defaults && g.defaults.stroke === c.id) delete g.defaults.stroke;
        });
        state.lines.forEach(function (l) {
          if (l.stroke === c.id) l.stroke = null;
        });
        state.palette = state.palette.filter(function (p) { return p.id !== c.id; });
        state.dirty = true;
        snapshot();
        renderAll();
      });

      li.appendChild(sw);
      li.appendChild(nameInp);
      li.appendChild(valInp);
      li.appendChild(del);
      paletteListEl.appendChild(li);
    });
  }

  function clearAllLines() {
    // v0.8.42: in ALL mode, count across every class so the
    // confirm message reflects the actual scope of the wipe, and
    // clear every class's lines + every master so the disk save
    // produces a truly empty slate. (Old behavior cleared only
    // the current class's lines, leaving sibling classes intact
    // and masters orphaned — both surface back into the on-disk
    // files at save time. The user reported deleting "everything"
    // and seeing instance files still populated because of this.)
    const isAll = modeIsAll();
    let totalLines = 0;
    if (isAll) {
      Object.keys(state.byClass).forEach(function (cid) {
        const lines = state.byClass[cid] && state.byClass[cid].lines;
        if (Array.isArray(lines)) totalLines += lines.length;
      });
    } else {
      totalLines = state.lines.length;
    }
    if (!totalLines) return;
    const scopeLabel = isAll ? ' across every class' : ' from this class';
    const masterNote = isAll && state.masters && state.masters.length
      ? '\n\nMasters (' + state.masters.length + ') will also be removed since '
        + 'all instances are going away.'
      : '';
    if (!confirm('Delete all ' + totalLines + ' line' + (totalLines === 1 ? '' : 's')
                 + scopeLabel + '?\n\nThis can be undone (Cmd+Z).' + masterNote)) return;
    if (isAll) {
      Object.keys(state.byClass).forEach(function (cid) {
        if (state.byClass[cid]) state.byClass[cid].lines = [];
      });
      // Masters are orphans now — clear them so the master library
      // and the next save reflect the empty state. Groups stay:
      // they're the user's organizational structure, not part of
      // "objects to delete".
      state.masters = [];
    } else {
      state.lines = [];
    }
    clearSelection();
    state.dirty = true;
    snapshot();
    renderAll();
  }

  function addColor() {
    state.palette.push({
      id: uid('c'),
      name: 'Color ' + (state.palette.length + 1),
      value: '#888888'
    });
    state.dirty = true;
    snapshot();
    renderPaletteList();
    renderSelectionPanel();
  }

  // Track which line id we last scrolled the panel-into-view for.
  // Edit-driven re-renders (trigger flips, scope flips, etc.) hit
  // renderSelectionPanel without selection change; skip the
  // scroll then so the user's scroll position inside the panel
  // is preserved.
  let lastScrolledSelectionId = null;

  function renderSelectionPanel(opts) {
    selectionPanel.innerHTML = '';
    // v0.8.119: drop the multi-select dedupe memo whenever the
    // selection collapses, so a later identical multi-select still
    // re-fires the fan-out.
    maybeResetMultiSpawnMemo();
    const wasSingleSelect = state.selectedIds.length === 1;
    // Multi-select takes precedence: show a compact bulk-actions panel.
    // Single selection shows the full line params panel (unchanged).
    // Otherwise fall through to the active group's settings.
    if (state.selectedIds.length > 1) {
      renderMultiSelectionPanel();
    } else if (wasSingleSelect) {
      // v0.8.112: single-select line panel migrated to the floating
      // 'object' panel. Sidebar shows a compact hint pointing at the
      // floater so the slot isn't visually empty; the panel itself
      // gets auto-spawned (if no unpinned object panel already
      // exists) below, after we've finished updating the sidebar.
      const line = state.lines.find(function (l) { return l.id === primarySelectedId(); });
      if (line) renderLineSidebarHint(line);
    } else if (state.activeGroupId) {
      const g = state.groups.find(function (g) { return g.id === state.activeGroupId; });
      if (g) renderGroupPanel(g);
    }
    // When a single object is FIRST selected, scroll the sidebar
    // so the line panel is visible — saves the user from manually
    // scrolling past the groups list to reach params. But don't
    // scroll on every re-render: edits inside the panel (trigger
    // type flips, scope flips, etc.) re-call renderSelectionPanel
    // and used to snap back to the top of the panel, hiding
    // wherever the user was working. Track the last-scrolled id;
    // only fire scrollIntoView when the primary selection changes.
    //
    // v0.8.27: caller can pass { suppressScroll: true } to skip the
    // scroll-into-view even on a brand-new selection — used by
    // modifier-click handlers (Cmd / Shift / Ctrl) so initiating a
    // multi-selection from an empty selection doesn't jerk the
    // sidebar to the per-line panel the user is about to abandon
    // on the next modifier-click.
    const suppress  = !!(opts && opts.suppressScroll);
    const primaryId = wasSingleSelect ? primarySelectedId() : null;
    // v0.8.112: sidebar slot now holds only a tiny hint for single-
    // select (the line panel lives in a floating panel). Scrolling
    // the sidebar to a hint adds nothing, so the scrollIntoView is
    // gated to non-single-select cases (multi-select still has a
    // real bulk-actions panel worth scrolling to).
    if (!suppress && !wasSingleSelect && state.selectedIds.length > 1
        && selectionPanel.scrollIntoView
        && primaryId !== lastScrolledSelectionId) {
      selectionPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    // Update the tracker even when suppressed, so a later plain click
    // on the SAME object doesn't re-trigger the scroll (the user
    // already saw that panel via the modifier-click).
    lastScrolledSelectionId = primaryId;
    // v0.8.110: fan out to the floating-panel system. Every
    // selection mutation in the editor already converges on
    // renderSelectionPanel, so this single hook is enough to
    // keep selection-following panels in sync.
    // v0.8.113: switched from notifySelection to notifyDataChanged.
    // Block edits inside a 'behavior-block' panel call
    // updateBehaviorParam → renderSelectionPanel, but that panel
    // type doesn't followSelection so notifySelection skipped it.
    // notifyDataChanged re-renders every panel (including pinned
    // ones — refresh is a no-op when nothing relevant changed)
    // so block-detail panels stay in sync with deletes / moves /
    // param edits.
    if (window.PanelManager) {
      try { window.PanelManager.notifyDataChanged(); } catch (e) { console.error(e); }
      // v0.8.123: single-select no longer auto-spawns a follower
      // panel. A first click on an object is now JUST selection — the
      // user might be about to drag it, extend the selection, or open
      // the panel; we don't know yet. Opening the panel is now an
      // explicit gesture handled by the canvas pointerup code:
      //   - plain re-click on an already-selected single object →
      //     toggle the follower panel (open if closed, close if open)
      //   - cmd-click on any object → toggle its follower panel in
      //     one shot (selects it too if it wasn't already)
      // The original auto-spawn was friendly the first time but
      // intrusive every subsequent click; the explicit gesture fixes
      // that without losing the one-click-to-edit feeling for users
      // who want it (cmd-click).
      //
      // v0.8.125: multi-select fan-out is no longer auto-fired.
      // shift-click in the canvas or in the sidebar is "extend the
      // selection," not "open N panels" — those are independent
      // intents. spawnMultiSelectObjectPanels is kept as a helper
      // (callable from an explicit "open panels for all" button if
      // we wire one up later) but renderSelectionPanel no longer
      // calls it.
    }
  }

  // v0.8.119: per-multi-select-set memo. Used to dedupe the fan-out
  // (re-renders fire repeatedly while a selection persists; we only
  // want to spawn ONCE per distinct multi-select set). Reset when
  // the selection collapses to single or empty.
  let lastMultiSpawnKey = null;
  function spawnMultiSelectObjectPanels() {
    if (!window.PanelManager) return;
    const ids = state.selectedIds.slice().sort();
    const key = ids.join('|');
    if (key === lastMultiSpawnKey) return;
    // Set immediately so re-renders during the deferred work don't
    // re-enter this function for the same set. If the user cancels
    // the confirm, we still don't re-prompt — they made a choice.
    lastMultiSpawnKey = key;
    // v0.8.120: defer past the next paint so the new selection
    // (canvas highlights + sidebar bulk panel) is visible BEFORE
    // any confirm() blocks the UI thread. Without this, the user
    // hits the dialog without seeing what they selected.
    // v0.8.122: rAF fires BEFORE the next paint, not after — so a
    // single rAF still blocked pre-paint. Double rAF: the first
    // callback runs in the pre-paint phase of frame N, the second
    // runs at the start of frame N+1, which is guaranteed to be
    // after frame N actually painted. setTimeout(0) would also
    // work but is less precise about ordering vs other rAF work.
    requestAnimationFrame(function () { requestAnimationFrame(function () {
      // Re-check: selection may have changed (or class switched)
      // between scheduling and firing.
      const liveIds = state.selectedIds.slice().sort();
      if (liveIds.join('|') !== key) return;
      const open = window.PanelManager.listOpen();
      // Objects that already have a pinned panel can be skipped.
      const pinnedObjIds = {};
      open.forEach(function (p) {
        if (p.type === 'object' && p.pinned && p.objectId) pinnedObjIds[p.objectId] = true;
      });
      const toSpawn = liveIds.filter(function (id) { return !pinnedObjIds[id]; });
      if (toSpawn.length === 0) return;
      const limit = state.multiSelectPanelLimit | 0;
      if (toSpawn.length > limit) {
        const ok = window.confirm(
          'Open ' + toSpawn.length + ' object panels (one per selected object)?\n\n' +
          'Your current limit is ' + limit + '. You can change it in Settings ' +
          '("Multi-select panel limit").'
        );
        if (!ok) return;
      }
      // Each open() bumps the same-type count, so the next call
      // sees N+1 existing and cascades further along the diagonal.
      // Panels open PINNED on purpose: unpinned 'object' panels
      // follow the primary selection, which would make every panel
      // show the same one object instead of the per-object split
      // this fan-out exists for.
      toSpawn.forEach(function (id) {
        try {
          window.PanelManager.open('object', { objectId: id, pinned: true });
        } catch (e) { console.error(e); }
      });
    }); });
  }
  // Hook to clear the multi-spawn memo whenever selection drops out
  // of multi-select — wired into renderSelectionPanel below by
  // checking state.selectedIds.length on each call. Centralized
  // here for clarity.
  function maybeResetMultiSpawnMemo() {
    if (state.selectedIds.length <= 1) lastMultiSpawnKey = null;
  }

  // v0.8.112: compact sidebar placeholder shown when a single
  // object is selected. The full editor lives in the floating
  // 'object' panel; this hint keeps the sidebar slot meaningful
  // (selection acknowledged, quick-reopen affordance) without
  // duplicating the panel content.
  function renderLineSidebarHint(line) {
    const group = state.groups.find(function (g) { return g.id === line.groupId; });
    const head = document.createElement('header');
    head.className = 'ed-panel-head';
    const h3 = document.createElement('h3');
    h3.textContent = line.name || 'Object';
    head.appendChild(h3);
    selectionPanel.appendChild(head);

    const meta = document.createElement('p');
    meta.style.color = '#888';
    meta.style.fontSize = '0.85em';
    meta.style.margin = '0 0 0.5rem';
    meta.appendChild(document.createTextNode('group '));
    const grpStrong = document.createElement('strong');
    grpStrong.textContent = group ? group.name : '?';
    meta.appendChild(grpStrong);
    meta.appendChild(document.createTextNode(' · ' + line.kind));
    selectionPanel.appendChild(meta);

    const hint = document.createElement('p');
    hint.style.color = '#9c9c9c';
    hint.style.fontSize = '0.85em';
    hint.style.margin = '0 0 0.4rem';
    hint.textContent = 'Editing in floating panel.';
    selectionPanel.appendChild(hint);

    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'ed-mini';
    openBtn.textContent = '🪟 Open / focus panel';
    openBtn.title = 'Bring the object panel to the front (or open one if it was closed)';
    openBtn.addEventListener('click', function () {
      if (!window.PanelManager) return;
      const open = window.PanelManager.listOpen();
      const target = open.find(function (p) { return p.type === 'object' && !p.pinned; });
      if (target) window.PanelManager.bringToFront(target.id);
      else window.PanelManager.open('object');
    });
    selectionPanel.appendChild(openBtn);
  }

  function renderMultiSelectionPanel() {
    const n = state.selectedIds.length;
    const head = document.createElement('header');
    head.className = 'ed-panel-head';
    head.innerHTML = '<h3>' + n + ' objects selected</h3>';
    selectionPanel.appendChild(head);

    const hint = document.createElement('p');
    hint.className = 'ed-panel-hint';
    hint.style.color = '#888';
    hint.style.margin = '6px 0 12px';
    hint.textContent = 'Drag any one to move them all together. ' +
                       'Cmd/Shift-click to add or remove from the selection.';
    selectionPanel.appendChild(hint);

    // Bulk Color picker — applies to every selected object via the
    // scope contract. Shows as "active" only when every selected
    // line shares the same stroke ref; mixed selection shows the
    // "inherit" slot active so the user has a clear neutral state.
    const settings = document.createElement('div');
    settings.className = 'ed-settings';
    const allStrokes = state.selectedIds
      .map(function (id) {
        const l = state.lines.find(function (x) { return x.id === id; });
        return l ? l.stroke : undefined;
      });
    const sharedStroke = allStrokes.every(function (s) { return s === allStrokes[0]; })
      ? allStrokes[0] : null;
    settings.appendChild(strokeField('Color', sharedStroke, function (v) {
      // silent: true on bulk writes — in 'one' mode + canonical
      // stroke, the per-line dialog would fire N times. silent
      // skips canonical writes in 'one' mode instead, so masters
      // with canonical color stay unchanged. To bulk-recolor in
      // 'one' mode, flip stroke to local on each master first
      // (via the line panel) or switch to 'all'.
      state.selectedIds.forEach(function (id) { setVisualProp(id, 'stroke', v, { silent: true }); });
      scheduleSnapshot();
      renderLines();
      renderGroupsList();
      // Re-render this panel so the swatch state catches up.
      renderSelectionPanel();
    }));
    selectionPanel.appendChild(settings);

    const actions = document.createElement('div');
    actions.className = 'ed-actions';
    // Merge — combines the selected lines into one new master +
    // instance. Site-wide fan-out is silent when other classes hold
    // identical state for these objects; when any class differs
    // (positionOffset / overrides / hidden), a divergence dialog
    // surfaces the choice (Cancel / Current class only / Apply
    // everywhere) before anything is touched.
    const merge = document.createElement('button');
    merge.textContent = 'Merge into one';
    merge.title = 'Combine the selected objects into one new master. ' +
                  'Stroke / width / fill inherit from the first selected. ' +
                  'A dialog appears only if other classes hold local changes.';
    merge.addEventListener('click', function () { mergeSelectedIntoOne(); });
    actions.appendChild(merge);
    // Delete — one mode-aware button. Label + behavior follow
    // state.mode: 'all' deletes the objects site-wide; 'one'
    // removes just this class's instance rows.
    const del = document.createElement('button');
    del.className = 'ed-danger';
    const refreshDelLabel = function () {
      if (modeIsAll()) {
        del.textContent = 'Delete (all classes)';
        del.title = 'Delete these objects everywhere — every class loses them.';
      } else {
        del.textContent = 'Remove from this class';
        del.title = 'Drop these instances in THIS class only; the objects stay in other classes.';
      }
    };
    refreshDelLabel();
    del.addEventListener('click', function () {
      if (modeIsAll()) {
        if (!confirm('Delete ' + n + ' objects everywhere? This can be undone (Cmd+Z).')) return;
        deleteSelected();
      } else {
        if (!confirm('Remove ' + n + ' from this class only? They stay in other classes.')) return;
        removeLinesFromCurrentClass(state.selectedIds.slice());
      }
    });
    actions.appendChild(del);
    selectionPanel.appendChild(actions);
  }

  function renderGroupPanel(g) {
    const head = document.createElement('header');
    head.className = 'ed-panel-head';
    head.innerHTML = '<h3>Group settings</h3>';
    selectionPanel.appendChild(head);

    const wrap = document.createElement('div');
    wrap.className = 'ed-settings';

    wrap.appendChild(textField('Name', g.name, function (v) { updateGroup(g.id, { name: v }); }));
    // Group visibility — per-class (groups themselves are per-class,
    // so this is naturally local). Hidden groups fade in the editor
    // and are skipped entirely on the live site, just like hidden
    // lines. Toggleable from the sidebar group-row 👁 too.
    wrap.appendChild(checkboxField('Visible', !g.hidden, function (v) {
      updateGroup(g.id, { hidden: !v });
      renderGroupsList();
      renderLines();
    }));
    wrap.appendChild(triggerField('Trigger', g.trigger || '', function (v) {
      updateGroup(g.id, { trigger: v.trim() === '' ? null : v.trim() });
    }));

    wrap.appendChild(divider('Appearance'));
    wrap.appendChild(strokeField('Color', g.defaults.stroke, function (v) {
      updateGroupDefaults(g.id, { stroke: v });
      // Cascade: clear line.stroke on every line in this group so
      // the new default actually paints. silent: true so the
      // cascade doesn't fire N refusal dialogs in 'one' mode; in
      // 'one' mode + canonical stroke the silent call just skips
      // the per-line clear, and lines with explicit strokes keep
      // them — the user gets the group default for new/un-set
      // lines only. To force every line to the new color in 'one'
      // mode, user can switch to 'all' or click each line's color.
      state.lines
        .filter(function (l) { return l.groupId === g.id; })
        .forEach(function (l) { setVisualProp(l.id, 'stroke', null, { silent: true }); });
      renderLines();
    }));
    // "Line width" — distinguishes the stroke width from primitives'
    // shape width (rect's `w` param uses "Width" as its label).
    wrap.appendChild(numberField('Line width', g.defaults.width != null ? g.defaults.width : 1, function (v) {
      updateGroupDefaults(g.id, { width: v });
    }));

    // v0.8.219: Behavior template picker.
    // Lists only objects that are themselves members of this group.
    // When set, the runtime/preview will adopt the template object's
    // behaviors + render params (everything except geometry) for every
    // member object. Picker stays compact: a select dropdown rather
    // than a search combobox — group membership is usually small.
    {
      // Custom divider with an (i) tooltip aligned right on the title row.
      const div = divider('Behavior template');
      div.style.display = 'flex';
      div.style.alignItems = 'center';
      div.style.justifyContent = 'space-between';
      const info = document.createElement('span');
      info.className = 'ed-info-icon';
      info.textContent = 'i';
      const members = state.lines.filter(function (l) { return l.groupId === g.id; });
      info.title = members.length === 0
        ? 'Add objects to this group to enable a template.'
        : 'When set, every object in the group adopts the template '
          + 'object’s behaviors (geometry stays each object’s own). '
          + 'Template behaviors COMPOUND with each member’s own '
          + 'behaviors — they don’t replace them. The template object '
          + 'can still render normally.';
      div.appendChild(info);
      wrap.appendChild(div);
    }
    {
      const members = state.lines.filter(function (l) { return l.groupId === g.id; });
      const options = [{ value: '__none__', label: '(none — group is static)' }]
        .concat(members.map(function (l) {
          const master = l.masterId
            ? state.masters.find(function (m) { return m.id === l.masterId; })
            : null;
          const displayName = (l.name && l.name.trim())
            || (master && master.name)
            || l.id;
          return { value: l.id, label: displayName };
        }));
      const currentVal = g.behaviorTemplateObjectId || '__none__';
      // If the stored template id isn't in the members list any more
      // (shouldn't happen with pruneGroupTemplateRefs, but defensive),
      // surface it as a missing entry so the user can clear it.
      if (g.behaviorTemplateObjectId
          && !members.find(function (l) { return l.id === g.behaviorTemplateObjectId; })) {
        options.push({
          value: g.behaviorTemplateObjectId,
          label: '⚠ ' + g.behaviorTemplateObjectId + ' (not in group)'
        });
      }
      wrap.appendChild(selectField('Template object', currentVal, options, function (v) {
        updateGroupBehaviorTemplate(g.id, v === '__none__' ? null : v);
      }));
    }

    // v0.8.226 (CONTENT_SCHEMA_VERSION 11): the legacy "Behavior defaults"
    // panel was removed. Group-level fallbacks for translateX/Y, rotate,
    // rotateOriginX/Y, drawIn, drawInDirection, translateMode are no longer
    // part of the schema — behaviors live entirely on objects (or on the
    // group's behavior-template object, compounded onto members at runtime).

    selectionPanel.appendChild(wrap);

    // Delete is always available. The confirm dialog (empty vs.
    // non-empty group) lives in confirmAndDeleteGroup so the sidebar
    // group-row ✕ button can reuse the same flow.
    // v0.8.171: stacked full-width buttons (same idiom as the object
    // panel's duplicate/delete actions, .ed-actions--stack). The labels
    // are too long to ride side-by-side without wrapping, and stacked
    // reads more cleanly anyway.
    const actions = document.createElement('div');
    actions.className = 'ed-actions ed-actions--stack';

    // Duplication (v0.8.92). Two flavours so users don't have to
    // answer a prompt: new-masters = fully independent geometry;
    // same-masters (formerly "linked") = shares masters with the source,
    // transforms/behaviors independent. Both honor ALL/1 mode and rewrite
    // internal cross-refs to point at the duplicates in new-masters mode.
    // v0.8.171: label wording aligned with user terminology — "same
    // masters" reads as a clearer counterpart to "new masters" than
    // "linked" did.
    const dupNew = document.createElement('button');
    dupNew.type = 'button';
    dupNew.textContent = 'Duplicate group, new masters';
    dupNew.title = 'Duplicate the group with fully independent copies of every object (geometry can evolve separately).';
    dupNew.addEventListener('click', function () { duplicateGroupAction(g.id, { linked: false }); });
    actions.appendChild(dupNew);

    const dupLink = document.createElement('button');
    dupLink.type = 'button';
    dupLink.textContent = 'Duplicate group, same masters';
    dupLink.title = 'Duplicate the group; copies share geometry with the originals (transforms/behaviors independent).';
    dupLink.addEventListener('click', function () { duplicateGroupAction(g.id, { linked: true }); });
    actions.appendChild(dupLink);

    const del = document.createElement('button');
    del.className = 'ed-danger';
    del.textContent = 'Delete group';
    del.addEventListener('click', function () { confirmAndDeleteGroup(g); });
    actions.appendChild(del);
    selectionPanel.appendChild(actions);
  }

  async function confirmAndDeleteGroup(g) {
    const lineCount = state.lines.filter(function (l) { return l.groupId === g.id; }).length;
    if (lineCount === 0) {
      const choice = await showChoiceDialog({
        title: 'Delete group',
        message: 'Delete empty group "' + g.name + '"?',
        buttons: [
          { label: 'Cancel', value: null },
          { label: 'Delete', value: 'group', className: 'ed-danger' }
        ]
      });
      if (choice === 'group') deleteGroup(g.id, false);
      return;
    }
    const choice = await showChoiceDialog({
      title:   'Delete group',
      message: 'Delete group "' + g.name + '"? It contains ' +
               lineCount + ' line' + (lineCount === 1 ? '' : 's') + '.',
      buttons: [
        { label: 'Cancel',         value: null },
        { label: 'Group only',     value: 'group' },
        { label: 'Group and lines', value: 'both', className: 'ed-danger' }
      ]
    });
    if (choice === 'group') { deleteGroup(g.id, false); return; }
    if (choice !== 'both') return;

    // v0.8.97: "Group and lines" cascade can reach instances that
    // live OUTSIDE the group being deleted, because the cascade
    // works by masterId (in ALL mode, site-wide; in ONE mode,
    // across the current class). Warn the user before that
    // collateral damage happens, listing the affected instances
    // so they know exactly what will disappear.
    //
    // Detection scope mirrors deleteGroup():
    //   ALL: every useClass; the user's "this group" intent
    //        includes same-name peer groups in sibling classes,
    //        so instances there are NOT considered collateral.
    //   ONE: current class only; the deleted group is the sole
    //        in-scope group, so any other group in this class
    //        holding the same master counts as collateral.
    const groupMasterIds = new Set();
    state.lines.forEach(function (l) {
      if (l.groupId === g.id && l.masterId) groupMasterIds.add(l.masterId);
    });
    const extras = [];
    if (groupMasterIds.size > 0) {
      const isAll = modeIsAll();
      const cidsToScan = isAll ? state.pageConfig.useClasses : [state.classId];
      cidsToScan.forEach(function (cid) {
        const bucket = state.byClass[cid];
        if (!bucket || !Array.isArray(bucket.lines)) return;
        // In ALL mode, find the same-name peer group in this class;
        // its members share the user's "delete this group" intent
        // and are excluded from collateral. In ONE mode, only the
        // current class is touched and only g.id is in-scope.
        let inScopeGroupId = null;
        if (isAll) {
          const peer = (bucket.groups || []).find(function (gr) { return gr.name === g.name; });
          if (peer) inScopeGroupId = peer.id;
        } else {
          inScopeGroupId = g.id;
        }
        bucket.lines.forEach(function (l) {
          if (!l.masterId || !groupMasterIds.has(l.masterId)) return;
          if (l.groupId === inScopeGroupId) return;
          const peerGroup = (bucket.groups || []).find(function (gr) { return gr.id === l.groupId; });
          extras.push({ classId: cid, line: l, group: peerGroup });
        });
      });
    }

    if (extras.length > 0) {
      const escHtml = function (s) {
        const d = document.createElement('div');
        d.textContent = String(s == null ? '' : s);
        return d.innerHTML;
      };
      const classLabel = function (cid) {
        const c = state.classes.find(function (x) { return x.id === cid; });
        return c ? c.name : cid;
      };
      const rows = extras.map(function (e) {
        const master = state.masters.find(function (m) { return m.id === e.line.masterId; });
        const objName = (e.line.name && e.line.name.trim()) || (master && master.name) || e.line.id;
        const grpName = e.group ? e.group.name : '?';
        return '<li><strong>' + escHtml(classLabel(e.classId)) + '</strong>' +
               ' · ' + escHtml(grpName) +
               ' · ' + escHtml(objName) + '</li>';
      }).join('');
      const msg =
        '<p>Deleting <strong>' + escHtml(g.name) + '</strong> with its lines will also remove ' +
        extras.length + ' linked instance' + (extras.length === 1 ? '' : 's') +
        ' that live in other groups' +
        (modeIsAll() ? ' across the site' : ' in this class') + ':</p>' +
        '<ul style="max-height:200px;overflow:auto;margin:0.5em 0;padding-left:1.25em;">' +
        rows + '</ul>' +
        '<p>They share a master with this group and will disappear from all locations.</p>';
      const confirm = await showChoiceDialog({
        title: 'Linked instances will be removed',
        message: msg,
        html: true,
        // v0.8.98: "Cancel" reads as "cancel the whole delete operation";
        // here we just want to choose whether the linked siblings tag
        // along. "Keep" / "Delete too" makes the scope of the choice
        // explicit — keep them and only delete the group's own lines,
        // or delete them too.
        buttons: [
          { label: 'Keep',       value: 'keep' },
          { label: 'Delete too', value: 'ok', className: 'ed-danger' }
        ]
      });
      if (confirm === 'keep') {
        // "Keep the outside-group siblings": remove only lines that
        // are actually IN the group being deleted (per the cascade
        // scope — current class in ONE mode, same-name peer groups
        // in ALL mode), then let deleteGroup tear down the group
        // entity with alsoDeleteLines=false so it doesn't run its
        // own master-id cascade. Masters survive (still referenced
        // by the kept siblings), and the kept siblings stay where
        // they were.
        const isAll = modeIsAll();
        const cidsToTouch = isAll ? state.pageConfig.useClasses : [state.classId];
        cidsToTouch.forEach(function (cid) {
          const bucket = state.byClass[cid];
          if (!bucket || !Array.isArray(bucket.lines)) return;
          let inScopeGroupId = null;
          if (isAll) {
            const peer = (bucket.groups || []).find(function (gr) { return gr.name === g.name; });
            if (peer) inScopeGroupId = peer.id;
          } else {
            inScopeGroupId = g.id;
          }
          if (!inScopeGroupId) return;
          bucket.lines = bucket.lines.filter(function (l) { return l.groupId !== inScopeGroupId; });
        });
        deleteGroup(g.id, false);
        return;
      }
      if (confirm !== 'ok') return;
    }
    deleteGroup(g.id, true);
  }

  function renderLinePanel(line, host, panelState) {
    // v0.8.112: host parameter lets the same renderer paint either
    // into the sidebar selection slot (legacy callers, host omitted)
    // or into a floating panel body (PANEL_REGISTRY 'object' type).
    // Falls back to selectionPanel for backward compat.
    // v0.8.113: panelState (optional) lets the BEHAVIORS block list
    // know which object-panel owns it, so block-row clicks can
    // open block-detail children with the correct parentId.
    host = host || selectionPanel;
    // v0.8.32 DIAGNOSTIC: log what the panel is actually reading.
    // If `line` looks intact here but the panel still shows defaults,
    // the bug is downstream (in the field-render code). If `line` is
    // already empty, the data was mutated earlier.
    console.log('[panel/render]', {
      id: line && line.id, masterId: line && line.masterId,
      groupId: line && line.groupId, stroke: line && line.stroke,
      behaviorsLen: line && Array.isArray(line.behaviors) ? line.behaviors.length : -1,
      behaviorIds: line && Array.isArray(line.behaviors)
        ? line.behaviors.map(function (b) { return b.id; }) : null,
      sameRefAsInState: line === state.lines.find(function (l) { return l && l.id === (line && line.id); })
    });
    const group = state.groups.find(function (g) { return g.id === line.groupId; });
    const head = document.createElement('header');
    head.className = 'ed-panel-head';
    const h3 = document.createElement('h3');
    h3.textContent = line.name ? line.name : 'Line';
    head.appendChild(h3);
    // v0.8.47: behavior count badge in the header, right-aligned —
    // the parent .ed-panel-head is already flex/space-between, so a
    // second child lands on the opposite end without extra layout.
    // Always shown (including "0 behaviors") so the user sees the
    // value without inferring its absence.
    const bCount = Array.isArray(line.behaviors) ? line.behaviors.length : 0;
    const countBadge = document.createElement('span');
    countBadge.className = 'ed-panel-head-count';
    countBadge.textContent = bCount + ' behavior' + (bCount === 1 ? '' : 's');
    countBadge.title = 'Behavior blocks on this object';
    head.appendChild(countBadge);
    host.appendChild(head);

    const meta = document.createElement('p');
    meta.style.color = '#888';
    meta.style.fontSize = '0.85em';
    meta.style.margin = '0 0 0.5rem';
    const idCode = document.createElement('code');
    idCode.textContent = line.id;
    meta.appendChild(document.createTextNode('id '));
    meta.appendChild(idCode);
    meta.appendChild(document.createTextNode(' · group '));
    const grpStrong = document.createElement('strong');
    grpStrong.textContent = group ? group.name : '?';
    meta.appendChild(grpStrong);
    meta.appendChild(document.createTextNode(' · ' + line.kind));
    host.appendChild(meta);

    // v0.8.101: master chip — visible whenever the line has a master.
    // Shows the master's badge letter (color-coded), master name, and
    // the linked count. Clicking selects every sibling instance in
    // the current class so the user can edit or move the linked
    // family together. Singleton masters get a faded chip with no
    // letter and no "linked" suffix, so the user still sees which
    // master owns this instance.
    // v0.8.104: only show the master chip when the object actually has
    // siblings (count ≥ 2). Singletons carry no useful relationship info,
    // so the chip was pure clutter — removed.
    if (line.masterId) {
      const rel = computeMasterRelationships();
      const entry = rel[line.masterId];
      // v0.8.106: gate by IN-CLASS sibling count, not global count.
      // The chip's only action is selectSiblingsOfMaster, which only
      // operates on the current class — so a master with instances in
      // other classes but a single instance here is functionally a
      // singleton from this object's perspective.
      const inClassCount = state.lines.reduce(function (n, l) {
        return n + (l.masterId === line.masterId ? 1 : 0);
      }, 0);
      if (entry && entry.badge && inClassCount >= 2) {
        const master = state.masters.find(function (m) { return m.id === line.masterId; });
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'ed-master-chip';
        const dot = document.createElement('span');
        dot.className = 'ed-link-badge';
        dot.style.background = 'hsl(' + entry.hue + ', 70%, 32%)';
        dot.textContent = entry.badge;
        chip.appendChild(dot);
        const nm = document.createElement('span');
        nm.className = 'ed-master-chip-name';
        nm.textContent = (master && master.name) ? master.name : shortMasterId(line.masterId);
        chip.appendChild(nm);
        const cnt = document.createElement('span');
        cnt.className = 'ed-master-chip-count';
        cnt.textContent = inClassCount + ' linked';
        chip.appendChild(cnt);
        chip.title = 'Click to select all ' + inClassCount + ' linked instances in this class';
        chip.addEventListener('click', function () {
          selectSiblingsOfMaster(line.masterId);
        });
        host.appendChild(chip);
      }
    }

    const wrap = document.createElement('div');
    wrap.className = 'ed-settings';

    wrap.appendChild(withScope(textField('Name', line.name || '', function (v) {
      setVisualProp(line.id, 'name', v);
      scheduleSnapshot();
      renderLines();
      renderGroupsList();
    }, 'optional'), line.masterId, 'name'));

    // v0.8.98: Group affordance — explicit selector to move this
    // object to a different group without resorting to drag-and-drop.
    // Especially needed for linked objects: previously the only way
    // to take an instance out of a group was to delete the group
    // (which cascaded) or drag the row in the sidebar, neither of
    // which is discoverable from the panel. moveLinesToGroup also
    // fans the change out to sibling classes in ALL mode by name.
    if (state.groups.length > 1) {
      // v0.8.229: confirm dialog removed. The group reassignment is
      // fully reversible (Cmd+Z, or pick the original group back) and
      // the confirm() interrupted a frequent, low-risk operation. The
      // fan-out to sibling instances in ALL mode is still in effect
      // via moveLinesToGroup — that's a feature, not a hazard.
      wrap.appendChild(selectField(
        'Group',
        line.groupId || '',
        state.groups.map(function (gr) { return { value: gr.id, label: gr.name }; }),
        function (newId) {
          if (!newId || newId === line.groupId) return;
          moveLinesToGroup([line.id], newId);
        }
      ));
    }

    // Visibility — toggle off to hide on the live site without
    // deleting. Useful for trying variants. Renders faded in the
    // editor; runtime skips entirely.
    wrap.appendChild(checkboxField('Visible', !line.hidden, function (v) {
      updateLine(line.id, { hidden: !v });
    }));

    // v0.8.128: B4 — Reset to master button is deferred and inserted
    // into the Parameters section next to Position X/Y (see below)
    // so the Position label and its reset button are co-located.
    const hasOffset = line.positionOffset
      && (Math.abs(line.positionOffset.dx) > 0.0001 || Math.abs(line.positionOffset.dy) > 0.0001);
    var _resetToMasterBtn = null;
    if (hasOffset) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ed-mini';
      btn.textContent = '↺ Reset position to master';
      btn.title = 'Clear this class\'s position offset — the XY drift from the master\'s canonical placement.';
      btn.addEventListener('click', function () { resetPositionOffset(line.id); });
      _resetToMasterBtn = btn;
    }

    // Smoothing toggle is only meaningful for the freehand kinds — for
    // straight-line and chain kinds the regenerator ignores it.
    if (line.kind === 'freehand' || line.kind === 'freehandClosed') {
      wrap.appendChild(withScope(checkboxField('Smooth', !!line.smoothed, function (v) {
        setVisualProp(line.id, 'smoothed', v);
        scheduleSnapshot();
        renderLines();
      }), line.masterId, 'smoothed'));
    }

    // Primitive parameters (cx/cy/r for circle, w/h/r for rect, etc.).
    // setVisualProp routes the edit by master.scope:
    //   - canonical sub-key → master + all instances follow.
    //   - local sub-key → instance override only.
    //   - position sub-keys (cx/cy/x/y) → positionOffset (per-class).
    if (PRIMITIVES[line.kind] && line.params) {
      wrap.appendChild(divider('Parameters'));
      const PRIM = PRIMITIVES[line.kind];
      PRIM.paramFields.forEach(function (entry) {
        const key = entry[0], label = entry[1];
        const type = entry[2] || 'number';
        const onChange = function (v) {
          setVisualProp(line.id, 'params.' + key, v);
          scheduleSnapshot();
          renderLines();
        };
        let field;
        if (type === 'text') {
          field = textField(label, line.params[key] || '', onChange);
        } else if (type === 'image-source') {
          field = imageSourceField(label, line.params[key] || '', onChange);
        } else if (type === 'select') {
          field = selectField(label, line.params[key] || (entry[3][0] && entry[3][0].value),
                              entry[3], onChange);
        } else {
          field = numberField(label, line.params[key], onChange);
        }
        wrap.appendChild(withScope(field, line.masterId, 'params.' + key));
      });
      // "Filled" only makes sense for filled-shape primitives. Image
      // kind ignores fill (the bitmap covers the box). textBlock has
      // an independent fill color (in the Appearance section below)
      // so the boolean toggle is meaningless there — empty fill = no
      // fill.
      if (line.kind !== 'image' && line.kind !== 'textBlock') {
        wrap.appendChild(withScope(checkboxField('Filled', !!line.filled, function (v) {
          setVisualProp(line.id, 'filled', v);
          scheduleSnapshot();
          renderLines();
        }), line.masterId, 'filled'));
      }
      // v0.8.132: bounding box before reset button, from live SVG.
      appendBboxRow(wrap, line);
      if (_resetToMasterBtn) wrap.appendChild(_resetToMasterBtn);
    } else {
      // v0.8.95: Parameters fallback for non-primitive kinds (freehand,
      // freehandClosed, manual, bezier, svgImport, line, lineChain, …).
      // Stored line.points / segments are already in visual on-canvas
      // coords (translateLine + propagateLineToMaster keep them in
      // "offset-applied" form), so the bbox top-left IS the on-canvas
      // position. No addition with positionOffset needed.
      wrap.appendChild(divider('Parameters'));
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      let ptCount = 0, hasGeo = false;
      if (Array.isArray(line.points) && line.points.length) {
        line.points.forEach(function (p) {
          const x = +p.x, y = +p.y;
          if (Number.isFinite(x)) { hasGeo = true; if (x < minX) minX = x; if (x > maxX) maxX = x; }
          if (Number.isFinite(y)) { if (y < minY) minY = y; if (y > maxY) maxY = y; }
        });
        ptCount = line.points.length;
      } else if (Array.isArray(line.segments) && line.segments.length) {
        line.segments.forEach(function (s) {
          if (s.endpoint) {
            const x = +s.endpoint.x, y = +s.endpoint.y;
            if (Number.isFinite(x)) { hasGeo = true; if (x < minX) minX = x; if (x > maxX) maxX = x; }
            if (Number.isFinite(y)) { if (y < minY) minY = y; if (y > maxY) maxY = y; }
          }
        });
        ptCount = line.segments.length;
      }
      if (hasGeo) {
        // Editing X/Y translates the whole shape (geometry + offset).
        // shiftLineBy keeps stored points + positionOffset in lock-step.
        //
        // v0.8.96: numberField fires onChange on every keystroke, and
        // each call must compute delta against the CURRENT minX, not
        // the panel-build-time value. Capturing minX in the closure
        // and reusing it for successive keystrokes compounded shifts
        // off a moving target (typing "220" landed at −175 instead of
        // 220). currentBboxTopLeft(line) re-walks the shape each call.
        wrap.appendChild(numberField('Position X (mm)', minX, function (v) {
          const cur = currentBboxTopLeft(line);
          if (!cur) { scheduleSnapshot(); return; }
          const delta = (Number.isFinite(v) ? v : cur.minX) - cur.minX;
          if (delta !== 0) {
            shiftLineBy(line, delta, 0);
            state.dirty = true;
            renderLines();
          }
          scheduleSnapshot();
        }));
        wrap.appendChild(numberField('Position Y (mm)', minY, function (v) {
          const cur = currentBboxTopLeft(line);
          if (!cur) { scheduleSnapshot(); return; }
          const delta = (Number.isFinite(v) ? v : cur.minY) - cur.minY;
          if (delta !== 0) {
            shiftLineBy(line, 0, delta);
            state.dirty = true;
            renderLines();
          }
          scheduleSnapshot();
        }));
        // v0.8.132: bbox first (after position XY), then reset.
        appendBboxRow(wrap, line);
        if (_resetToMasterBtn) wrap.appendChild(_resetToMasterBtn);
        // Point/segment count note.
        const cntNote = document.createElement('div');
        cntNote.className = 'ed-params-meta';
        cntNote.textContent = ptCount + (Array.isArray(line.segments) && !Array.isArray(line.points) ? ' segments' : ' points');
        wrap.appendChild(cntNote);
      } else {
        // Degenerate: no geometry to anchor the position to.
        wrap.appendChild(textField('Position', '— (no geometry)', function () {}, ''));
      }
    }

    wrap.appendChild(divider('Appearance'));
    // v0.8.228: textBlock carries an independent fill (line.fill);
    // for every other kind the legacy "Color" field is the single
    // stroke-and-fill picker (fill follows stroke when `filled`).
    if (line.kind === 'textBlock') {
      wrap.appendChild(withScope(strokeField('Fill color', line.fill, function (v) {
        setVisualProp(line.id, 'fill', v);
        scheduleSnapshot();
        renderLines();
        renderGroupsList();
      }), line.masterId, 'fill'));
    }
    wrap.appendChild(withScope(strokeField(
      line.kind === 'textBlock' ? 'Stroke color' : 'Color',
      line.stroke,
      function (v) {
        setVisualProp(line.id, 'stroke', v);
        scheduleSnapshot();
        renderLines();
        renderGroupsList();
      }
    ), line.masterId, 'stroke'));
    wrap.appendChild(withScope(overrideNumberField(
      line.kind === 'textBlock' ? 'Stroke width' : 'Line width',
      line.width, group && group.defaults.width, function (v) {
        setVisualProp(line.id, 'width', v);
        scheduleSnapshot();
        renderLines();
      }
    ), line.masterId, 'width'));
    // Stroke corner style. On a filled shape with a same-color stroke
    // (the default for primitives), `round` produces the bulgy
    // rounded-tip effect that scales with line width; `miter` keeps
    // sharp geometric points; `bevel` flattens them.
    // v0.8.133: hide entirely for kinds that have no corner geometry —
    // smooth conic primitives (circle / ellipse) and images.
    // Other kinds (rect, polygon, star, chain, loop, freehand, bezier,
    // svgImport) may have corners and keep the setting active.
    const noCorners = (line.kind === 'circle' || line.kind === 'ellipse'
                    || line.kind === 'image');
    if (!noCorners) {
      wrap.appendChild(withScope(selectField('Corners', line.linejoin || 'round',
        [
          { value: 'round', label: 'Round' },
          { value: 'miter', label: 'Miter' },
          { value: 'bevel', label: 'Bevel' }
        ],
        function (v) {
          setVisualProp(line.id, 'linejoin', v);
          scheduleSnapshot();
          renderLines();
        }), line.masterId, 'linejoin'));
    }

    // v0.8.195: TEXT section. Slice 1 — master-only edits, propagated
    // to every resolved line by reference (line.text === master.text
    // after Object.assign in resolveInstanceJS).
    //
    // v0.8.196: Progressive disclosure — most objects won't have text,
    // so the section is hidden by default behind a "+ Add text"
    // button. Auto-opens when master.text.value is non-empty (saved
    // text on load) or after the user clicks the +Add button this
    // session. The [×] close button on the open section title wipes
    // master.text + removes the session flag, so closing reverts the
    // property to absent (safe escape hatch for an accidental open).
    if (line.masterId) {
      const masterRec = state.masters.find(function (m) { return m.id === line.masterId; });
      if (masterRec) {
        const hasText = !!(masterRec.text && masterRec.text.value);
        const sessionOpen = showTextSection.has(masterRec.id);
        const open = hasText || sessionOpen;
        if (!open) {
          // Separator before the +Add button so the closed-state TEXT
          // section is visually demarcated from the preceding property
          // (Corners). The open-state title row supplies its own border-
          // top; this matches that visual rhythm. v0.8.198.
          wrap.appendChild(behaviorPropDivider());
          const addBtn = document.createElement('button');
          addBtn.type = 'button';
          addBtn.className = 'ed-behavior-also-btn';
          addBtn.textContent = '+ Add text';
          addBtn.title = 'Add a text label to this object.';
          addBtn.addEventListener('click', function () {
            showTextSection.add(masterRec.id);
            renderSelectionPanel();
          });
          wrap.appendChild(addBtn);
        } else {
          // Open state — title row with close [×], then fields.
          const titleRow = document.createElement('div');
          titleRow.className = 'ed-behavior-section-title ed-behavior-also-title';
          const titleText = document.createElement('span');
          titleText.textContent = 'TEXT';
          titleRow.appendChild(titleText);
          const closeBtn = document.createElement('button');
          closeBtn.type = 'button';
          closeBtn.className = 'ed-behavior-also-close';
          closeBtn.title = 'Remove text from this object';
          closeBtn.setAttribute('aria-label', 'Remove text');
          closeBtn.innerHTML =
            '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
              '<line x1="6"  y1="6"  x2="18" y2="18" stroke="currentColor" ' +
                    'stroke-width="3" stroke-linecap="round"></line>' +
              '<line x1="18" y1="6"  x2="6"  y2="18" stroke="currentColor" ' +
                    'stroke-width="3" stroke-linecap="round"></line>' +
            '</svg>';
          closeBtn.addEventListener('click', function () {
            // Wipe text from master + every resolved line so the
            // renderer drops the overlay. hasText becomes false →
            // next render falls back to the +Add button (modulo
            // sessionOpen, which we also clear).
            delete masterRec.text;
            state.pageConfig.useClasses.forEach(function (cid) {
              const lns = (state.byClass[cid] && state.byClass[cid].lines) || [];
              lns.forEach(function (l) {
                if (l.masterId === masterRec.id) delete l.text;
              });
            });
            showTextSection.delete(masterRec.id);
            state.dirty = true;
            scheduleSnapshot();
            renderLines();
            renderSelectionPanel();
          });
          titleRow.appendChild(closeBtn);
          wrap.appendChild(titleRow);

          // Ensure the master has a text object before any field tries
          // to write through (avoids `master.text.value = …` on null).
          function ensureMasterText() {
            if (!masterRec.text || typeof masterRec.text !== 'object') {
              masterRec.text = Object.assign({}, TEXT_DEFAULTS);
            }
            return masterRec.text;
          }
          const t = masterRec.text || TEXT_DEFAULTS;
          wrap.appendChild(textareaField('Text', t.value || '', function (v) {
            const rec = ensureMasterText();
            rec.value = v;
            // Mirror onto every resolved line.text for this master so
            // the renderer sees it (resolveInstanceJS aliased line.text
            // to master.text, but only when text existed at load time).
            state.pageConfig.useClasses.forEach(function (cid) {
              const lns = (state.byClass[cid] && state.byClass[cid].lines) || [];
              lns.forEach(function (l) {
                if (l.masterId === masterRec.id) l.text = rec;
              });
            });
            state.dirty = true;
            scheduleSnapshot();
            renderLines();
          }, 'label this object'));
          wrap.appendChild(numberField('Offset X', t.offsetX || 0, function (v) {
            ensureMasterText().offsetX = Number.isFinite(v) ? v : 0;
            state.dirty = true; scheduleSnapshot(); renderLines();
          }));
          wrap.appendChild(numberField('Offset Y', t.offsetY || 0, function (v) {
            ensureMasterText().offsetY = Number.isFinite(v) ? v : 0;
            state.dirty = true; scheduleSnapshot(); renderLines();
          }));
          // v0.8.197: click-on-canvas convenience — mirrors the
          // rotate-origin button. Activates a one-shot mode where the
          // next canvas click sets master.text.offsetX/Y to the click
          // point's delta from the line's natural center.
          wrap.appendChild(setOriginButton(function () {
            ensureMasterText();
            startSetTextOffset({ masterId: masterRec.id, lineId: line.id });
          }));
          wrap.appendChild(fontFamilyField('Font family', t.fontFamily || '', function (v) {
            ensureMasterText().fontFamily = v || TEXT_DEFAULTS.fontFamily;
            state.dirty = true; scheduleSnapshot();
            renderLines();
            injectGoogleFontsLink();
          }, 'Pick from bundle or type any name'));
          wrap.appendChild(numberField('Font size', t.fontSize || TEXT_DEFAULTS.fontSize, function (v) {
            ensureMasterText().fontSize = Number.isFinite(v) && v > 0 ? v : TEXT_DEFAULTS.fontSize;
            state.dirty = true; scheduleSnapshot(); renderLines();
          }));
          // v0.8.238 (Slice 1b-2): Text color uses the project palette
          // instead of free-form CSS. Stores a palette id (or null for
          // "inherit" — falls back to the object's stroke color, same
          // as before). Legacy CSS strings on disk still render at
          // runtime because resolveStroke passes through any non-id
          // value unchanged; on next edit the user picks from the
          // palette and the legacy value is overwritten.
          wrap.appendChild(strokeField('Text color', t.color || '', function (v) {
            ensureMasterText().color = v || null;
            state.dirty = true; scheduleSnapshot(); renderLines();
          }));
        }
      }
    }

    // v0.8.114: BEHAVIORS divider now carries an (i) tooltip for the
    // multi-block additive semantics — used to be an always-on
    // paragraph that ate vertical space on every render. The text
    // lives in a native `title` attr so it shows on hover (desktop)
    // and on long-press (touch).
    const behaviorsDivider = divider('BEHAVIORS');
    behaviorsDivider.style.display = 'flex';
    behaviorsDivider.style.alignItems = 'center';
    behaviorsDivider.style.justifyContent = 'space-between';
    const helpIcon = document.createElement('span');
    helpIcon.className = 'ed-help-icon';
    helpIcon.textContent = 'ⓘ';
    helpIcon.title =
      'Multi-block: every block\'s translate / rotate is summed each frame. ' +
      'Scroll-driven blocks stop contributing outside their range, but ' +
      'timed/loop/ping-pong blocks whose progress has reached 1 keep ' +
      'contributing until the block\'s trigger ends.';
    behaviorsDivider.appendChild(helpIcon);
    wrap.appendChild(behaviorsDivider);

    // v0.8.113: block list — one row per block, click to open the
    // block-detail floating panel. Replaces the inline cards that
    // used to fill this section (now relocated to the dedicated
    // 'behavior-block' panel). Click on the row body opens / re-
    // binds the child panel; the ✕ button deletes the block.
    const blocks = Array.isArray(line.behaviors) ? line.behaviors : [];
    const overlaps = findBehaviorOverlaps(blocks);
    if (overlaps.length) {
      const warn = document.createElement('p');
      warn.className = 'ed-behavior-warning';
      warn.dataset.lineId = line.id;
      // v0.8.128: B2 — include the actual range values so it's clear
      // at a glance which ranges are causing the overlap.
      warn.textContent = 'Overlapping blocks: ' +
        overlaps.map(function (o) {
          const ba = blocks[o.a], bb = blocks[o.b];
          const ra = (ba && ba.trigger && ba.trigger.range) || { start: 0, end: 1 };
          const rb = (bb && bb.trigger && bb.trigger.range) || { start: 0, end: 1 };
          return (o.a + 1) + ' (' + ra.start + '–' + ra.end + ')'
               + ' & ' + (o.b + 1) + ' (' + rb.start + '–' + rb.end + ')';
        }).join(', ') +
        '. Overlapping ranges contribute simultaneously — their deltas sum during the overlap.';
      wrap.appendChild(warn);
    }

    // v0.8.133: block list always created so the add-block row lives
    // inside it and inherits the same gap as real block rows.
    const list = document.createElement('ul');
    list.className = 'ed-block-list';
    if (!blocks.length) {
      const ph = document.createElement('li');
      ph.className = 'ed-behavior-empty';
      ph.style.cssText = 'list-style:none;padding:0.15rem 0 0.35rem';
      ph.textContent = 'No behavior blocks yet.';
      list.appendChild(ph);
    } else {
      // Mark inOverlap blocks so we can flag them in the list.
      const inOverlap = {};
      overlaps.forEach(function (o) { inOverlap[o.a] = true; inOverlap[o.b] = true; });
      blocks.forEach(function (block, idx) {
        const row = document.createElement('li');
        row.className = 'ed-block-row' + (inOverlap[idx] ? ' is-overlap' : '');
        row.dataset.lineId = line.id;
        row.dataset.blockId = block && block.id || '';

        const nameBtn = document.createElement('button');
        nameBtn.type = 'button';
        nameBtn.className = 'ed-block-name';
        nameBtn.textContent = behaviorAutoName(block, idx);
        nameBtn.title = 'Open block editor in a floating panel';
        nameBtn.addEventListener('click', function () {
          if (!block || !block.id) return;
          openBehaviorPanelForBlock(line.id, block.id,
            panelState ? panelState.id : null);
        });
        row.appendChild(nameBtn);

        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'ed-block-del';
        delBtn.textContent = '✕';
        delBtn.title = 'Delete this block';
        delBtn.addEventListener('click', function (e) {
          e.stopPropagation();
          removeBehaviorBlock(line.id, idx);
        });
        row.appendChild(delBtn);
        list.appendChild(row);
      });
    }

    // Add-block as a ghost row — same position/gap as real rows.
    const addRow = document.createElement('li');
    addRow.className = 'ed-block-row ed-block-row--add';
    const addNameBtn = document.createElement('button');
    addNameBtn.type = 'button';
    addNameBtn.className = 'ed-block-name';
    addNameBtn.textContent = '+ Add block';
    addNameBtn.title = 'Append a new behavior block (range 0–1; edit to chain).';
    addNameBtn.addEventListener('click', function () {
      addBehaviorBlock(line.id);
      // v0.8.128: B1 — immediately open the block panel for the new
      // block so the user doesn't have to click a second time. The
      // new block is always the last one; addBehaviorBlock already
      // called renderSelectionPanel so state.lines is current.
      if (panelState && panelState.id) {
        const updated = state.lines.find(function (l) { return l.id === line.id; });
        const nb = updated && Array.isArray(updated.behaviors) && updated.behaviors.length
          ? updated.behaviors[updated.behaviors.length - 1] : null;
        if (nb && nb.id) {
          openBehaviorPanelForBlock(line.id, nb.id, panelState.id);
        }
      }
    });
    addRow.appendChild(addNameBtn);
    list.appendChild(addRow);
    wrap.appendChild(list);

    host.appendChild(wrap);

    // v0.8.231: scrollMode selector — controls whether this object scrolls
    // with the page ('flow', the default) or stays viewport-pinned ('static',
    // the pre-v12 behavior). Absent field = 'flow'. Per-object, not per-group.
    // Lives in the behaviors area since it governs page-level motion.
    wrap.appendChild(divider('Page scroll'));
    wrap.appendChild(selectField(
      'Scroll mode',
      line.scrollMode || 'flow',
      [
        { value: 'flow',   label: 'Flow with page (default)' },
        { value: 'static', label: 'Static — viewport-pinned' }
      ],
      function (v) {
        updateLine(line.id, { scrollMode: v });
      }
    ));

    // v0.8.128: B5 — actions behind a divider; stacked vertically so
    // long button labels don't wrap when constrained in a narrow panel.
    wrap.appendChild(divider(''));
    const actions = document.createElement('div');
    actions.className = 'ed-actions ed-actions--stack';

    // Duplication (v0.8.92). 'new master' = independent copy; 'linked'
    // = shares the master record (geometry follows the original; per-
    // instance transforms/behaviors are independent). Both honor ALL/1
    // and rewrite cross-references when applicable.
    const dupNew = document.createElement('button');
    dupNew.type = 'button';
    dupNew.textContent = 'Duplicate from new master';
    dupNew.title = 'Create a fully independent copy. New master record; geometry can evolve separately.';
    dupNew.addEventListener('click', function () { duplicateObject(line.id, { linked: false }); });
    actions.appendChild(dupNew);

    const dupLink = document.createElement('button');
    dupLink.type = 'button';
    dupLink.textContent = 'Duplicate from same master';
    dupLink.title = 'Create a copy that shares geometry with this object (same master). Per-instance transforms and behaviors are independent.';
    dupLink.addEventListener('click', function () { duplicateObject(line.id, { linked: true }); });
    actions.appendChild(dupLink);

    // Delete — one mode-aware button. 'all' mode cascades site-wide;
    // 'one' mode drops just THIS class's instance row.
    const del = document.createElement('button');
    del.className = 'ed-danger';
    if (modeIsAll()) {
      del.textContent = 'Delete object in all classes';
      del.title = 'Delete this object everywhere — every class loses it.';
    } else {
      del.textContent = 'Delete object in this class only';
      del.title = 'Drop just this class\'s instance; the object stays in other classes.';
    }
    del.addEventListener('click', function () {
      if (modeIsAll()) deleteLine(line.id);
      else removeLinesFromCurrentClass([line.id]);
    });
    actions.appendChild(del);
    host.appendChild(actions);
  }

  // ── Field constructors ────────────────────────────────────────────
  // (v0.3.5 removed: wrapWithMasterLink — the per-instance master-
  // link toggle is gone. Scope is now master-level, configured via
  // the scopeToggle below.)

  /**
   * Per-master scope toggle button. Flips one keyPath between
   * canonical (lives on master, propagates to every instance) and
   * local (lives in instance.overrides, this instance only). The
   * button itself reads master.scope; setMasterScope handles the
   * actual flip + cleanup. Returns null for keys outside the scope
   * contract (position sub-keys, kind, d, points, segments) so the
   * caller can `if (tog) field.appendChild(tog)` without checks.
   */
  function scopeToggle(masterId, keyPath) {
    if (!masterId) return null;
    // Structural-canonical keys never get a scope toggle: making
    // them local breaks the model. `name` is in this set because
    // a master with a per-class name isn't really one master — if
    // you want a different name, that's a different master.
    if (keyPath === 'kind' || keyPath === 'd'
        || keyPath === 'points' || keyPath === 'segments'
        || keyPath === 'name') return null;
    const parts = keyPath.split('.');
    if (parts[0] === 'params' && POSITION_PARAM_SUBKEYS.indexOf(parts[1]) !== -1) {
      return null;
    }
    const master = state.masters.find(function (m) { return m.id === masterId; });
    if (!master) return null;
    const local = isLocal(master, keyPath);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ed-link-toggle';
    btn.textContent = local ? '✎' : '🔗';
    btn.title = local
      ? 'LOCAL — this property is per-class (overrides live on each instance). Click to make it canonical (one value on the master, propagates to every class).'
      : 'CANONICAL — this property lives on the master and propagates to every class. Click to make it LOCAL so each class can hold its own value.';
    btn.addEventListener('click', function () {
      setMasterScope(masterId, keyPath, local ? 'canonical' : 'local');
      snapshot();
      renderSelectionPanel();
      renderLines();
    });
    return btn;
  }

  /**
   * Decorate a field row (`.ed-field`) with a scope toggle. No-op
   * when the keyPath isn't scope-able. Adds `.ed-master-linked` to
   * widen the row's grid track for the toggle, and `.is-overridden`
   * when the master scope is local so the field reads as "diverged
   * from master" (accent border + colored toggle icon).
   */
  function withScope(field, masterId, keyPath) {
    const tog = scopeToggle(masterId, keyPath);
    if (tog) {
      field.classList.add('ed-master-linked');
      const master = state.masters.find(function (m) { return m.id === masterId; });
      if (master && isLocal(master, keyPath)) field.classList.add('is-overridden');
      field.appendChild(tog);
    }
    // Even structurally-canonical fields (e.g. 'name', which has
    // no scope toggle) need to be locked in 'one' mode. Apply the
    // lock regardless of whether a toggle was attached.
    return lockIfCanonicalInOneMode(field, masterId, keyPath);
  }

  function textField(label, value, onChange, placeholder) {
    const wrap = document.createElement('div');
    wrap.className = 'ed-field';
    const lbl = document.createElement('label'); lbl.textContent = label;
    const inp = document.createElement('input');
    inp.type = 'text'; inp.value = value || '';
    if (placeholder) inp.placeholder = placeholder;
    inp.addEventListener('input', function () { onChange(inp.value); });
    wrap.appendChild(lbl); wrap.appendChild(inp);
    return wrap;
  }
  /**
   * v0.8.232: multi-line text input. Same wrap/label as textField but a
   * <textarea> instead of <input> so newlines and runs of whitespace
   * are preserved verbatim. Used by the master TEXT block so authors
   * can write paragraphs that render as multi-line SVG <text> (one
   * <tspan> per source line). Rows default to 3 — tall enough to read
   * a short paragraph, the user can drag-resize for longer copy.
   */
  function textareaField(label, value, onChange, placeholder, rows) {
    const wrap = document.createElement('div');
    wrap.className = 'ed-field';
    const lbl = document.createElement('label'); lbl.textContent = label;
    const ta = document.createElement('textarea');
    ta.value = value || '';
    ta.rows = rows || 3;
    // Disable autocorrect / autocapitalize so authored copy isn't
    // silently mutated mid-type — the field is a content holder, not
    // a chat input.
    ta.setAttribute('spellcheck', 'false');
    ta.setAttribute('autocapitalize', 'off');
    ta.setAttribute('autocomplete', 'off');
    if (placeholder) ta.placeholder = placeholder;
    ta.addEventListener('input', function () { onChange(ta.value); });
    wrap.appendChild(lbl); wrap.appendChild(ta);
    return wrap;
  }
  /**
   * v0.8.213: scale a popup option's font-size so its rendered cap-
   * height lands near `targetPx`, regardless of the face's intrinsic
   * proportions. Script faces (e.g. Allison) have tiny x-heights and
   * read as illegible at the same nominal size as a serif/sans face;
   * measuring actualBoundingBoxAscent via the Canvas API and back-
   * solving for font-size equalizes the visual weight of every
   * option in the picker.
   *
   * Async — uses document.fonts.load to ensure the face is in memory
   * before measurement. Falls back gracefully when the API isn't
   * available or the load fails (option keeps its default size).
   * Clamped to [12, 36] px to keep outliers from disrupting layout.
   */
  function fitOptionToTargetCapHeight(opt, fontFamily, targetPx) {
    const BASE = 24;
    const MIN = 12;
    const MAX = 36;
    function measureAndApply() {
      try {
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        ctx.font = BASE + 'px "' + fontFamily.replace(/"/g, '') + '", system-ui';
        const m = ctx.measureText(fontFamily);
        const ascent = m.actualBoundingBoxAscent || (BASE * 0.7);
        if (!ascent || !isFinite(ascent)) return;
        const scale = targetPx / ascent;
        const px = Math.min(MAX, Math.max(MIN, BASE * scale));
        opt.style.fontSize = px.toFixed(1) + 'px';
      } catch (e) { /* keep default size on failure */ }
    }
    if (document.fonts && document.fonts.load) {
      document.fonts
        .load(BASE + 'px "' + fontFamily.replace(/"/g, '') + '"')
        .then(measureAndApply, function () { /* ignore */ });
    } else {
      // No FontFaceSet API — measure immediately; will reflect fallback
      // metrics if the face hasn't loaded yet, but better than nothing.
      measureAndApply();
    }
  }

  /**
   * Font-family field (v0.8.208) — combobox: free-text input + an
   * explicit ▾ button that opens a popup listing the curated bundle.
   *
   * Why not a bare <datalist>? Datalist UX is inconsistent across
   * browsers — Safari shows nothing until the user types a letter,
   * Chrome surfaces only a faint marker, and there's no programmatic
   * way to force-open it. Users couldn't discover the bundle. The
   * custom popup makes the affordance obvious and lets us render each
   * option in its own face for in-place preview.
   *
   * Free-text typing is preserved: bundle membership is a suggestion,
   * not a constraint. The input's value is shown in the typed family's
   * own face when the font is loaded (injectGoogleFontsLink ensures
   * this for every bundled family).
   */
  function fontFamilyField(label, value, onChange, placeholder) {
    const wrap = document.createElement('div');
    wrap.className = 'ed-field';
    const lbl = document.createElement('label'); lbl.textContent = label;

    const row = document.createElement('div');
    row.style.cssText = 'display:flex; gap:4px; align-items:stretch; position:relative;';

    const inp = document.createElement('input');
    inp.type = 'text'; inp.value = value || '';
    inp.style.flex = '1 1 auto';
    if (placeholder) inp.placeholder = placeholder;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = '▾';
    btn.title = 'Pick from font bundle';
    btn.style.cssText = 'flex:0 0 auto; padding:0 8px; cursor:pointer;';

    const pop = document.createElement('div');
    pop.style.cssText = [
      'position:absolute', 'top:100%', 'left:0', 'right:0',
      'max-height:260px', 'overflow-y:auto',
      'background:#2a2a2a', 'color:#e8e8e8', 'border:1px solid #444',
      'box-shadow:0 4px 12px rgba(0,0,0,0.5)',
      'z-index:1000', 'display:none', 'margin-top:2px'
    ].join(';');

    function reflectFace() {
      inp.style.fontFamily = inp.value
        ? '"' + inp.value.replace(/"/g, '') + '", system-ui, sans-serif'
        : '';
    }
    function closePop() { pop.style.display = 'none'; }
    function openPop() {
      pop.innerHTML = '';
      // v0.8.215: union Google-bundled families and local-fonts families.
      // Dedup case-insensitively, sort case-insensitively. The browser
      // doesn't distinguish at render time (the @font-face block makes
      // local families resolvable by name), so we don't tag the source
      // visually — they're all just "available families".
      const bundle = Array.isArray(state.fontBundle) ? state.fontBundle : [];
      const local  = Array.isArray(state.localFonts)
        ? state.localFonts.map(function (f) { return f.family; }).filter(Boolean)
        : [];
      const seen = {};
      const fonts = bundle.concat(local).filter(function (n) {
        const k = (n || '').toLowerCase();
        if (!k || seen[k]) return false;
        seen[k] = true; return true;
      }).sort(function (a, b) { return a.localeCompare(b, undefined, {sensitivity:'base'}); });
      if (!fonts.length) {
        const empty = document.createElement('div');
        empty.textContent = 'No fonts available — add Google families in Settings → Font bundle, or drop OTF/TTF files into assets/fonts/local/.';
        empty.style.cssText = 'padding:8px 10px; color:#aaa; font-style:italic;';
        pop.appendChild(empty);
      } else {
        fonts.forEach(function (name) {
          const opt = document.createElement('div');
          opt.textContent = name;
          opt.style.cssText = 'padding:6px 10px; cursor:pointer; line-height:1.4; '
            + 'font-family:"' + name.replace(/"/g, '') + '", system-ui, sans-serif;';
          opt.addEventListener('mouseenter', function () { opt.style.background = '#3a3a55'; });
          opt.addEventListener('mouseleave', function () { opt.style.background = ''; });
          opt.addEventListener('mousedown', function (e) {
            e.preventDefault();
            inp.value = name;
            onChange(name);
            reflectFace();
            closePop();
          });
          pop.appendChild(opt);
          // v0.8.213: equalize visual size across faces. Script fonts
          // (Allison, Allura) have a small x-height at the same font-
          // size as serif/sans (Bodoni), so a flat font-size makes
          // them unreadable. Measure each face's actual bounding-box
          // ascent via the Canvas API after the font loads, then
          // scale font-size so every option lands near a target
          // cap-height (~16 px). Clamped to a sensible range to keep
          // outliers from blowing up the popup.
          fitOptionToTargetCapHeight(opt, name, 16);
        });
      }
      pop.style.display = 'block';
    }
    btn.addEventListener('click', function () {
      if (pop.style.display === 'block') closePop(); else openPop();
    });
    inp.addEventListener('input', function () {
      onChange(inp.value);
      reflectFace();
    });
    // Dismiss popup when clicking elsewhere
    document.addEventListener('mousedown', function (e) {
      if (!row.contains(e.target)) closePop();
    });

    reflectFace();
    row.appendChild(inp); row.appendChild(btn); row.appendChild(pop);
    wrap.appendChild(lbl); wrap.appendChild(row);
    return wrap;
  }
  // Numeric range field — same shape as numberField but clamped
  // to 0..1 with a small step. Used for behavior-block range
  // editing (start / end ∈ [0,1] within the line's scroll window).
  // GSAP easings curated for behavior duration. Linear is the
  // default (no easing); the rest are the common GSAP eases
  // most authoring tools expose.
  const EASING_OPTIONS = [
    { value: 'linear',        label: 'Linear (no easing)' },
    { value: 'power1.in',     label: 'Ease in (mild)' },
    { value: 'power1.out',    label: 'Ease out (mild)' },
    { value: 'power1.inOut',  label: 'Ease in-out (mild)' },
    { value: 'power2.in',     label: 'Ease in' },
    { value: 'power2.out',    label: 'Ease out' },
    { value: 'power2.inOut',  label: 'Ease in-out' },
    { value: 'power4.in',     label: 'Strong in' },
    { value: 'power4.out',    label: 'Strong out' },
    { value: 'power4.inOut',  label: 'Strong in-out' },
    { value: 'back.in',       label: 'Back in (overshoot start)' },
    { value: 'back.out',      label: 'Back out (overshoot end)' },
    { value: 'back.inOut',    label: 'Back in-out' },
    { value: 'elastic.in',    label: 'Elastic in' },
    { value: 'elastic.out',   label: 'Elastic out' },
    { value: 'bounce.in',     label: 'Bounce in' },
    { value: 'bounce.out',    label: 'Bounce out' },
    { value: 'circ.inOut',    label: 'Circular in-out' },
    { value: 'expo.inOut',    label: 'Exponential in-out' },
    { value: 'sine.inOut',    label: 'Sine in-out' }
  ];

  // Button-group picker. Each option is a button; an option with
  // .disabledIf=true gets the .is-disabled class and clicking it
  // opens an explainer dialog (callbacks: onPick(value) for valid,
  // onPickDisabled(opt) for disabled). The active option has the
  // accent border treatment.
  function behaviorButtonGroup(label, currentValue, options, onPick, onPickDisabled) {
    const wrap = document.createElement('div');
    wrap.className = 'ed-field ed-behavior-group';
    const lbl = document.createElement('label'); lbl.textContent = label;
    const row = document.createElement('div');
    row.className = 'ed-behavior-group-row';
    options.forEach(function (opt) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ed-behavior-group-btn'
        + (opt.value === currentValue ? ' is-active' : '')
        + (opt.disabledIf ? ' is-disabled' : '');
      btn.textContent = opt.label;
      btn.title = opt.disabledIf ? opt.disabledReason || 'Not valid with the current activation.' : '';
      btn.addEventListener('click', function () {
        if (opt.disabledIf) {
          if (onPickDisabled) onPickDisabled(opt);
        } else {
          onPick(opt.value);
        }
      });
      row.appendChild(btn);
    });
    if (label) wrap.appendChild(lbl);
    wrap.appendChild(row);
    return wrap;
  }

  // v0.8.165: back-arrow button shown next to a locked chip (the
  // selected trigger / progress mode). The chip itself is no longer
  // clickable to go back — only this small arrow is. The SVG is sized
  // to fill ~80% of the button height for clear visibility.
  function makeBehaviorChipBack(onClick, tooltip) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ed-behavior-chip-back';
    btn.title = tooltip || 'Back — change this choice';
    btn.setAttribute('aria-label', tooltip || 'Back');
    btn.innerHTML =
      '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
        '<polyline points="15 4 7 12 15 20" stroke="currentColor" stroke-width="3" ' +
                  'fill="none" stroke-linecap="round" stroke-linejoin="round"></polyline>' +
      '</svg>';
    btn.addEventListener('click', onClick);
    return btn;
  }

  // Build a chip + back-arrow pair, appending both to a behaviorButtonGroup
  // row. The chip displays the chosen value; the arrow is the single
  // back affordance. Click on the chip is a no-op.
  // v0.8.169: thin horizontal rule used to separate unrelated property
  // groups WITHIN a behavior section (e.g. rotate | opacity | draw-in
  // under "What changes"). Section-titles already supply the BETWEEN-
  // section dividers; this is the within-section variant — same hairline
  // color, no label, slimmer vertical footprint.
  function behaviorPropDivider() {
    const el = document.createElement('div');
    el.className = 'ed-behavior-prop-divider';
    return el;
  }
  function appendLockedChip(card, value, label, onBack, tooltip) {
    const chipGroup = behaviorButtonGroup('', value, [{ value: value, label: label }],
      function () { /* no-op: chip is display only; use arrow to go back */ },
      null);
    // Mark the chip as locked (no hover brightness, no pointer cursor)
    const chipBtn = chipGroup.querySelector('.ed-behavior-group-btn');
    if (chipBtn) chipBtn.classList.add('is-locked-chip');
    const chipRow = chipGroup.querySelector('.ed-behavior-group-row');
    if (chipRow) chipRow.appendChild(makeBehaviorChipBack(onBack, tooltip));
    card.appendChild(chipGroup);
  }

  // Explainer dialog for greyed-out duration options.
  function explainDurationDisabled(opt) {
    showChoiceDialog({
      title:   'Not available with this activation',
      message: opt.disabledReason || 'Not valid with the current activation.',
      buttons: [{ label: 'OK', value: null, className: 'ed-primary' }]
    });
  }

  // Plain-English summary of an activation × progress combo, shown
  // in the .ed-behavior-summary strip at the top of each block. The
  // sentence is deterministic in (trigger, duration, params); each
  // re-render rebuilds it so the user always sees the live combo.
  function formatScrollPct(v) {
    const pct = Math.round((Number(v) || 0) * 1000) / 10;
    return pct.toFixed(1).replace(/\.0$/, '') + '%';
  }
  function formatSeconds(v) {
    const n = Number(v);
    if (!isFinite(n) || n <= 0) return '0 s';
    return n + ' s';
  }
  // v0.8.113: auto-generated short label for a behavior block, used
  // by the block-name list inside the object panel. Format:
  //   "Block N · <trigger> · <main effect>"
  // Trigger: a compact label for trigger.when (scroll-range collapses
  // to 'scroll'). Main effect: pick the dominant param actually set
  // on this block — translate / rotate / fade / path / draw / hide /
  // show, in that priority. Empty params get '(no effect)'.
  function behaviorAutoName(block, index) {
    const n = (index | 0) + 1;
    const trigger = (block && block.trigger) || {};
    const when    = trigger.when || 'scroll-range';
    const triggerLabel = (
      when === 'scroll-range'    ? 'scroll' :
      when === 'scroll-stop'     ? 'stop'   :
      when === 'scroll-start'    ? 'start'  :
      when === 'scroll-key'      ? 'key'    :
      when === 'in-view-partial' ? 'in-view' :
      when === 'in-view-full'    ? 'in-view (full)' :
      when === 'after-previous'  ? 'after prev' :
      when === 'page-load'       ? 'load'   :
      when === 'click'           ? 'click'  :
      when === 'hover'           ? 'hover'  :
      when === 'wait'            ? 'wait'   :
      when
    );
    const p = (block && block.params) || {};
    // Detection: presence is what matters, not magnitude — a 0
    // translateX is still an authored intent and shows up in the
    // panel, so let it surface in the name too.
    // v0.8.114: audit covers EVERY authored key written by the
    // updateBehaviorParam / updateBehaviorTrigger pipelines, including
    // cross-object side effects (trigger.startObjectId / stopObjectId)
    // which are full first-class effects of the block — a "click +
    // stop object X" block has an effect, even with no visual params.
    function has(k) { return Object.prototype.hasOwnProperty.call(p, k); }
    const hasTx = has('translateX'), hasTy = has('translateY');
    const effects = [];
    // Visual effects (params side).
    if (hasTx && hasTy) effects.push('translate');
    else if (hasTx)     effects.push('translate X');
    else if (hasTy)     effects.push('translate Y');
    if (has('rotate'))                          effects.push('rotate');
    if (has('fadeOpacity'))                     effects.push('fade');
    if (has('opacityFrom') || has('opacityTo')) effects.push('opacity');
    if (has('pathRef'))                         effects.push('path');
    if (has('drawIn'))                          effects.push('draw');
    // Cross-object side effects (trigger side) — every block can
    // optionally stop or start another object when it fires.
    // v0.8.115: resolve masterId → human-readable name so the row
    // says "stops Brown dotty" instead of an opaque "stops other".
    // Falls back to the masterId itself if name lookup misses (e.g.
    // stale id pointing at a deleted master).
    // v0.8.179: format is "name (id)" — id retained as disambiguator.
    function objLabelFor(masterId) {
      if (!masterId) return '';
      let nm = null;
      const m = state.masters && state.masters.find(function (x) { return x.id === masterId; });
      if (m && m.name) nm = m.name;
      if (!nm) {
        const ln = state.lines && state.lines.find(function (l) { return l.masterId === masterId; });
        if (ln && ln.name) nm = ln.name;
      }
      return nm ? (nm + ' (' + masterId + ')') : masterId;
    }
    if (trigger.stopObjectId)  effects.push('stops ' + objLabelFor(trigger.stopObjectId));
    if (trigger.startObjectId) effects.push('starts ' + objLabelFor(trigger.startObjectId));
    const effect = effects.length ? effects.join(' + ') : '(no effect)';
    return 'Block ' + n + ' · ' + triggerLabel + ' · ' + effect;
  }

  // v0.8.113: open (or re-bind, if one already exists) the block-
  // detail floating panel for a (lineId, blockId) pair owned by a
  // given object panel. One child per parent — clicking another
  // block in the same object panel reuses the existing child.
  function openBehaviorPanelForBlock(lineId, blockId, parentPanelId) {
    if (!window.PanelManager) return;
    const open = window.PanelManager.listOpen();
    const existing = open.find(function (p) {
      return p.type === 'behavior-block' && p.parentId === parentPanelId;
    });
    if (existing) {
      window.PanelManager.updatePanel(existing.id, {
        objectId: lineId, blockId: blockId
      });
      window.PanelManager.bringToFront(existing.id);
      return;
    }
    // Stick to the right of the parent if we can find it; otherwise
    // fall back to the registry's default position.
    const parent = open.find(function (p) { return p.id === parentPanelId; });
    const opts = { objectId: lineId, blockId: blockId, parentId: parentPanelId };
    if (parent) {
      opts.x = parent.x + parent.w + 8;
      opts.y = parent.y;
    }
    window.PanelManager.open('behavior-block', opts);
  }

  function behaviorSummaryText(block) {
    const trigger  = (block && block.trigger)  ? block.trigger  : { when: 'scroll-range', range: { start: 0, end: 1 }, delay: 0 };
    const duration = (block && block.duration) ? block.duration : { mode: 'scroll' };
    const when  = trigger.when  || 'scroll-range';
    const dmode = duration.mode || 'scroll';
    const delay = Number(trigger.delay) || 0;
    const secs  = formatSeconds(duration.seconds || 1);
    const ease  = (duration.easing && duration.easing !== 'linear')
      ? ' (eased: ' + duration.easing + ')' : '';

    // Scroll-range + scroll-driven progress: activation and
    // progress collapse into a single statement.
    if (when === 'scroll-range' && dmode === 'scroll') {
      const r = trigger.range || { start: 0, end: 1 };
      return 'Tracks scroll across ' + formatScrollPct(r.start) + '–' + formatScrollPct(r.end)
           + '; progress follows scroll position within that range.';
    }

    let act;
    if (when === 'scroll-range') {
      const r = trigger.range || { start: 0, end: 1 };
      act = 'Triggers the first time scroll enters ' + formatScrollPct(r.start) + '–' + formatScrollPct(r.end);
    } else if (when === 'page-load') {
      act = 'Triggers at page load';
    } else if (when === 'scroll-key') {
      const k  = trigger.selector ? '"' + trigger.selector + '"' : '(none set)';
      const va = trigger.viewportAt || 'middle';
      const where = va === 'top'    ? 'the top of the viewport'
                  : va === 'middle' ? 'the middle of the viewport'
                  : va === 'object' ? 'the animated object'
                                    : 'the bottom of the viewport';
      const verb = (trigger.repeat === 'every') ? 'Triggers each time ' : 'Triggers when ';
      act = verb + 'scroll brings key ' + k + ' to ' + where;
    } else if (when === 'in-view-partial') {
      act = 'Triggers when the object enters the viewport';
    } else if (when === 'in-view-full') {
      act = 'Triggers when the object is fully in the viewport';
    } else if (when === 'after-previous') {
      // v0.8.22
      act = 'Triggers when the previous timed block ends';
    } else if (when === 'scroll-stop') {
      // v0.8.77
      act = (delay > 0)
        ? 'Triggers ' + formatSeconds(delay) + ' after the user stops scrolling'
        : 'Triggers the moment the user stops scrolling';
    } else if (when === 'scroll-start') {
      // v0.8.243: surface direction in the summary so the panel name
      // tells the truth at a glance (… 'scrolling downward' / 'upward').
      const dirSuffix = (trigger.direction === 'down') ? ' downward'
                      : (trigger.direction === 'up')   ? ' upward'
                      : '';
      act = (delay > 0)
        ? 'Triggers ' + formatSeconds(delay) + ' after the user resumes scrolling' + dirSuffix
        : 'Triggers the moment the user resumes scrolling' + dirSuffix;
    } else if (when === 'wait') {
      // v0.8.82
      act = 'Waits for another object’s Start command (does not fire on its own)';
    } else if (when === 'click') {
      // v0.8.84
      act = trigger.treatAsFilled
        ? 'Triggers when the user clicks anywhere inside the object’s bounds'
        : 'Triggers when the user clicks the object';
    } else if (when === 'hover') {
      // v0.8.84
      const where = trigger.treatAsFilled ? 'anywhere inside the object’s bounds' : 'the object';
      act = 'Triggers when the user hovers over ' + where + ' (or clicks it on touch devices)';
    } else {
      act = 'Triggers (' + when + ')';
    }
    if (delay > 0 && when !== 'scroll-stop' && when !== 'scroll-start') {
      act += ', waits ' + formatSeconds(delay);
    }

    let prog;
    if (dmode === 'time') {
      // v0.8.166: was "runs once over X" — but with trigger.repeat='every'
      // that read as a contradiction ("each crossing… runs once"). The
      // "once" was meant to convey "non-looping", which is already implied
      // by dmode='time' (vs 'loop' / 'pingpong'). Drop it.
      prog = 'then animates over ' + secs + ease;
    } else if (dmode === 'loop') {
      prog = 'then loops every ' + secs + ease;
    } else if (dmode === 'pingpong') {
      prog = 'then ping-pongs every ' + secs + ease;
    } else if (dmode === 'loopTo') {
      // v0.8.23
      const tgt = Number.isInteger(duration.target) ? duration.target : null;
      const tgtTxt = (tgt != null) ? 'block ' + (tgt + 1) : '(no target set)';
      const cap   = (Number.isInteger(duration.maxIterations) && duration.maxIterations > 0)
                    ? ' (' + duration.maxIterations + ' iterations max)' : ' (forever)';
      prog = 'then animates over ' + secs + ease
           + ' back to the position where ' + tgtTxt + ' started, ' +
           'and replays the chain from there' + cap;
    } else {
      prog = 'progress mode: ' + dmode;
    }
    let summary = act + ', ' + prog + '.';
    // v0.8.79: cross-object side effects on trigger fire. Resolve
    // the opaque masterId to a human-readable label.
    // v0.8.179: format is "name (id)" — name first for readability,
    // id in parens so the user can still grep / disambiguate. Falls
    // back to just the id when no name can be resolved.
    const labelForMasterId = function (mid) {
      if (!mid) return '';
      const master = state.masters.find(function (x) { return x.id === mid; });
      let nm = null;
      if (master && master.name) nm = master.name;
      if (!nm) {
        const inst = state.lines.find(function (l) { return l.masterId === mid; });
        if (inst && inst.name) nm = inst.name;
      }
      return nm ? (nm + ' (' + mid + ')') : mid;
    };
    const sideParts = [];
    if (trigger.startObjectId) {
      sideParts.push('starts "' + labelForMasterId(trigger.startObjectId) + '"');
    }
    if (trigger.stopObjectId) {
      const cleanups = [];
      if (trigger.stopFadeOut)    cleanups.push('fade out');
      if (trigger.stopReturnHome) cleanups.push('return to origin');
      const dur = (typeof trigger.stopDurationSec === 'number' && trigger.stopDurationSec > 0)
        ? ' over ' + formatSeconds(trigger.stopDurationSec) : '';
      const ez  = (trigger.stopEasing && trigger.stopEasing !== 'linear')
        ? ' (eased: ' + trigger.stopEasing + ')' : '';
      // v0.8.179: route through labelForMasterId (was leaking raw id).
      let stopTxt = 'stops "' + labelForMasterId(trigger.stopObjectId) + '"';
      if (cleanups.length) stopTxt += ' with ' + cleanups.join(' + ') + dur + ez;
      sideParts.push(stopTxt);
    }
    if (sideParts.length) {
      summary += ' On fire: ' + sideParts.join('; ') + '.';
    }
    return summary;
  }

  // v0.8.182: per-effect prose. behaviorSummaryText covers the
  // trigger × duration sentence and cross-object side effects;
  // behaviorDriftLineText covers drift / path-follow. This helper
  // covers everything else the block actually animates — the values
  // implied by the effect tags in behaviorAutoName (translate X +
  // fade + opacity + draw, etc.). Returns null when there are no
  // animated params worth describing, so callers can skip a line.
  function behaviorEffectsText(block) {
    const p = (block && block.params) || {};
    function has(k) { return Object.prototype.hasOwnProperty.call(p, k); }
    const parts = [];
    // Translate — only the "fixed" mode is a delta. drift / pathFollow
    // are described by behaviorDriftLineText, so skip the translate
    // line when translateMode says it's a drift.
    const tmode = p.translateMode;
    const isDrift = tmode && tmode !== 'fixed';
    if (!isDrift) {
      const hasTx = has('translateX'), hasTy = has('translateY');
      const tx = Number(p.translateX) || 0;
      const ty = Number(p.translateY) || 0;
      if (hasTx && hasTy)      parts.push('translates by (' + tx + ', ' + ty + ') px');
      else if (hasTx)          parts.push('translates X by ' + tx + ' px');
      else if (hasTy)          parts.push('translates Y by ' + ty + ' px');
    }
    if (has('rotate')) {
      parts.push('rotates by ' + (Number(p.rotate) || 0) + '°');
    }
    if (has('fadeOpacity')) {
      // fadeOpacity is a boolean toggle that uses opacityFrom/To when
      // present, otherwise the implicit 1 → 0 fade.
      const oFrom = (typeof p.opacityFrom === 'number') ? p.opacityFrom : 1;
      const oTo   = (typeof p.opacityTo   === 'number') ? p.opacityTo   : 0;
      parts.push('fades opacity ' + oFrom + ' → ' + oTo);
    } else if (has('opacityFrom') || has('opacityTo')) {
      const oFrom = (typeof p.opacityFrom === 'number') ? p.opacityFrom : 1;
      const oTo   = (typeof p.opacityTo   === 'number') ? p.opacityTo   : 1;
      parts.push('opacity ' + oFrom + ' → ' + oTo);
    }
    if (has('drawIn') && p.drawIn) {
      const dir = p.drawInDirection || 'forward';
      parts.push('draws in (' + dir + ')');
    }
    if (!parts.length) return null;
    return 'Effects: ' + parts.join('; ') + '.';
  }

  // v0.8.20: drift behavior is independent of trigger × duration and
  // not captured by behaviorSummaryText. When translateMode != fixed
  // the drift axis ignores progress: each scroll-px adds (multiplier
  // × delta) to that axis's accumulator. The other axis still acts
  // as a fixed `bp × translate`. We surface this as a second summary
  // line under the main one, only on blocks that have drift on.
  // isLastBlock controls the "frozen / continues" tail because drift
  // freezes the moment block i+1 activates (app.js tickDrift).
  function behaviorDriftLineText(block, isLastBlock) {
    const params = (block && block.params) || {};
    const tmode = params.translateMode;
    if (!tmode || tmode === 'fixed') return null;
    const tx = Number(params.translateX) || 0;
    const ty = Number(params.translateY) || 0;
    function axisText(axis, mult) {
      if (mult === 0) {
        return axis + ' drift on but multiplier is 0 — no ' + axis +
               ' motion (set Translate' + axis + ' to drive it)';
      }
      // v0.8.21: spell out SVG direction (X+ = right, Y+ = down) and
      // tell the user how to flip it. The screenshot bug that drove
      // this — translateY=+1 on an off-page object — looked like a
      // valid "drift in" setting but pushed the object further away
      // because Y+ is down in SVG. Sign-aware so the hint flips for
      // already-negative values too.
      const abs    = Math.abs(mult);
      const dirNow = (mult > 0) ? (axis === 'X' ? 'right' : 'down')
                                : (axis === 'X' ? 'left'  : 'up');
      const dirAlt = (mult > 0) ? (axis === 'X' ? 'left'  : 'up')
                                : (axis === 'X' ? 'right' : 'down');
      const altSign = (mult > 0) ? 'negative' : 'positive';
      return axis + ' drifts ' + abs + ' px per scroll-px ' + dirNow +
             ' (use a ' + altSign + ' multiplier to drift ' + dirAlt + ')';
    }
    let parts;
    if (tmode === 'driftX')         parts = [axisText('X', tx)];
    else if (tmode === 'driftY')    parts = [axisText('Y', ty)];
    else if (tmode === 'driftBoth') parts = [axisText('X', tx), axisText('Y', ty)];
    else if (tmode === 'pathFollow') {
      // v0.8.54: pathFollow isn't drift — it's a path-driven
      // translate that replaces tx/ty. Produce a short summary
      // line here so the same red strip explains both modes.
      // v0.8.57: pathRef stores the guide's MASTER id (shared
      // across classes), so the lookup matches by masterId.
      const guideMid = params.pathRef;
      const guide = guideMid
        ? state.lines.find(function (l) { return l.masterId === guideMid; })
        : null;
      const guideLbl = guide ? (guide.name || guide.id) : '(no guide picked)';
      const tan = params.pathAlignToTangent ? ', aligned to tangent' : '';
      const end = ({ stop: 'stops at end', loop: 'snaps to start at end',
                     pingpong: 'reverses at end' })[params.pathEndMode || 'stop'];
      return 'Follows path of ' + guideLbl + tan + '; ' + end + '.';
    }
    else return 'Drift mode: ' + tmode;
    const tail = isLastBlock
      ? ' Continues while the block is active.'
      : ' Freezes when the next block activates.';
    return parts.join('; ') + '.' + tail;
  }

  // v0.8.10: refresh just the summary node for one block without
  // re-rendering the panel. Used by trigger/duration field
  // updates that don't change the picker layout (range, delay,
  // seconds, easing, selector) — a full re-render would yank
  // input focus mid-edit.
  function refreshBehaviorSummary(lineId, blockIdx) {
    const l = state.lines.find(function (l) { return l.id === lineId; });
    if (!l || !Array.isArray(l.behaviors)) return;
    const block = l.behaviors[blockIdx];
    if (!block) return;
    const isLast = blockIdx === l.behaviors.length - 1;
    const driftText = behaviorDriftLineText(block, isLast);
    const nodes = document.querySelectorAll('.ed-behavior-summary');
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (n.dataset.lineId !== String(lineId)) continue;
      if (n.dataset.blockIdx !== String(blockIdx)) continue;
      if (n.dataset.kind === 'drift') {
        n.textContent = driftText || '';
      } else {
        n.textContent = behaviorSummaryText(block);
      }
      // v0.8.153: flash to draw attention to the updated text.
      n.classList.remove('is-flash');
      void n.offsetWidth; // restart CSS animation
      n.classList.add('is-flash');
    }
    // v0.8.66: range edits change which blocks overlap; refresh the
    // warning text and the per-block red-border markers so the
    // visual signal stays in sync without losing the focused
    // numeric input.
    refreshBehaviorOverlapMarkers(lineId);
  }

  // v0.8.66: re-evaluate behavior-overlap state and update DOM
  // accordingly. Updates two surfaces:
  //   - The bottom-of-list .ed-behavior-warning text (cleared if
  //     no overlaps; the paragraph stays in the DOM either way so
  //     it doesn't reflow the panel).
  //   - The .ed-behavior-block cards involved in any overlap get
  //     an .is-overlap class (2 px red border via CSS) — visible
  //     even when the warning paragraph has scrolled out of view.
  function refreshBehaviorOverlapMarkers(lineId) {
    const l = state.lines.find(function (x) { return x.id === lineId; });
    if (!l) return;
    const blocks = Array.isArray(l.behaviors) ? l.behaviors : [];
    const overlaps = findBehaviorOverlaps(blocks);
    const inOverlap = {};
    overlaps.forEach(function (o) { inOverlap[o.a] = true; inOverlap[o.b] = true; });
    const cards = document.querySelectorAll('.ed-behavior-block');
    cards.forEach(function (card) {
      const idx = parseInt(card.dataset.blockIdx, 10);
      if (card.dataset.lineId !== String(lineId)) return;
      if (Number.isInteger(idx)) {
        card.classList.toggle('is-overlap', !!inOverlap[idx]);
      }
    });
    const warns = document.querySelectorAll('.ed-behavior-warning');
    warns.forEach(function (w) {
      if (w.dataset.lineId !== String(lineId)) return;
      if (overlaps.length) {
        w.textContent = 'Overlapping blocks: ' +
          overlaps.map(function (o) { return (o.a + 1) + ' & ' + (o.b + 1); }).join(', ') +
          '. Overlapping ranges contribute simultaneously — their deltas sum during the overlap. ' +
          'Sometimes intentional (parallel motion); otherwise space the ranges out.';
        w.classList.remove('is-hidden');
      } else {
        w.textContent = '';
        w.classList.add('is-hidden');
      }
    });
  }

  function rangeNumberField(label, value, onChange) {
    const wrap = document.createElement('div');
    wrap.className = 'ed-field';
    const lbl = document.createElement('label'); lbl.textContent = label;
    const inp = document.createElement('input');
    inp.type = 'number';
    inp.min  = '0';
    inp.max  = '1';
    inp.step = '0.05';
    inp.value = (value !== undefined && value !== null) ? value : 0;
    inp.addEventListener('input', function () { onChange(parseFloat(inp.value)); });
    wrap.appendChild(lbl); wrap.appendChild(inp);
    return wrap;
  }

  // Render one behavior-block card inside the line panel. Each card
  // owns its block's range + params; ✕ removes the block.
  function renderBehaviorBlock(line, blockIdx, group, panelState) {
    const block = line.behaviors[blockIdx];
    const params = (block && block.params) || {};
    const range = (block && block.range) || { start: 0, end: 1 };
    const gd = (group && group.defaults) || {};

    const card = document.createElement('div');
    // v0.8.129: strip the card border/background when inside a floating
    // panel — the panel chrome already provides the visual container,
    // and the card's own border created a "panel inside panel" look.
    card.className = panelState
      ? 'ed-behavior-block ed-behavior-block--inpanel'
      : 'ed-behavior-block';
    // v0.8.66: tag the card so refreshBehaviorOverlapMarkers can
    // find it by (lineId, blockIdx) without a full re-render.
    card.dataset.lineId  = line.id;
    card.dataset.blockIdx = String(blockIdx);

    // v0.8.128: when rendering inside a floating panel the head strip
    // is skipped — the panel frame's own title bar is the drag handle
    // and the × close button is in the panel chrome. Showing the head
    // would duplicate the "Block N" label and create a panel-inside-
    // panel visual. The head is still built for the legacy inline path
    // (no panelState), though that path has no current call sites.
    const totalBlocks = Array.isArray(line.behaviors) ? line.behaviors.length : 0;
    if (!panelState) {
      const head = document.createElement('div');
      head.className = 'ed-behavior-head';
      head.draggable = true;
      head.title = 'Drag to reorder';
      head.addEventListener('dragstart', function (e) {
        if (!e.dataTransfer) return;
        e.dataTransfer.setData('text/x-behavior-block', String(blockIdx));
        e.dataTransfer.setData('text/x-behavior-line', line.id);
        e.dataTransfer.effectAllowed = 'move';
        card.classList.add('ed-behavior-dragging');
      });
      head.addEventListener('dragend', function () {
        card.classList.remove('ed-behavior-dragging');
      });
      const title = document.createElement('span');
      title.className = 'ed-behavior-title';
      title.textContent = 'Block ' + (blockIdx + 1) + ' / ' + totalBlocks;
      head.appendChild(title);
      const rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'ed-behavior-remove';
      rm.textContent = '×';
      rm.title = 'Remove this block';
      rm.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
      rm.addEventListener('click', function () { removeBehaviorBlock(line.id, blockIdx); });
      head.appendChild(rm);
      card.appendChild(head);
    }

    // v0.8.127: prev / next block navigation. Rebinds THIS panel to
    // the adjacent block instead of opening another panel — keeps
    // the "one floating panel per block" rule while letting the
    // user step through the sequence without going back to the
    // parent object panel. Buttons disable at the ends. Only
    // active when we know our own panelId (passed from the panel
    // registry); legacy inline uses of renderBehaviorBlock skip
    // the nav silently.
    if (panelState && panelState.id && window.PanelManager && totalBlocks > 1) {
      const navWrap = document.createElement('span');
      navWrap.className = 'ed-behavior-nav';
      const mkNav = function (label, targetIdx, titleStr) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'ed-behavior-nav-btn';
        btn.textContent = label;
        btn.title = titleStr;
        const disabled = targetIdx < 0 || targetIdx >= totalBlocks;
        btn.disabled = disabled;
        // Same dragstart-swallow trick as the × button.
        btn.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
        if (!disabled) {
          btn.addEventListener('click', function () {
            const target = line.behaviors[targetIdx];
            if (!target || !target.id) return;
            try {
              window.PanelManager.updatePanel(panelState.id, {
                objectId: line.id, blockId: target.id
              });
              window.PanelManager.bringToFront(panelState.id);
            } catch (e) { console.error(e); }
          });
        }
        return btn;
      };
      // v0.8.130: delete button removed from nav — it's available on
      // each block-list row in the parent object panel, so having a
      // second one here just created a second × that looked like a
      // close button.
      navWrap.appendChild(mkNav('Previous', blockIdx - 1, 'Previous block'));
      navWrap.appendChild(mkNav('Next', blockIdx + 1, 'Next block'));
      card.appendChild(navWrap);
    }

    // Drop zone — every card listens for drops of OTHER blocks
    // from the same line. The mouse Y vs midpoint decides insert-
    // above vs insert-below, mirrored in the CSS bar indicator.
    card.addEventListener('dragover', function (e) {
      if (!e.dataTransfer) return;
      if (Array.from(e.dataTransfer.types).indexOf('text/x-behavior-block') === -1) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const rect = card.getBoundingClientRect();
      const isAbove = e.clientY < rect.top + rect.height / 2;
      card.classList.toggle('ed-drop-above', isAbove);
      card.classList.toggle('ed-drop-below', !isAbove);
    });
    card.addEventListener('dragleave', function (e) {
      // The leave event fires when entering a child element too;
      // only clear when actually exiting the card.
      if (!card.contains(e.relatedTarget)) {
        card.classList.remove('ed-drop-above');
        card.classList.remove('ed-drop-below');
      }
    });
    card.addEventListener('drop', function (e) {
      if (!e.dataTransfer) return;
      const fromIdxStr  = e.dataTransfer.getData('text/x-behavior-block');
      const fromLineId  = e.dataTransfer.getData('text/x-behavior-line');
      card.classList.remove('ed-drop-above');
      card.classList.remove('ed-drop-below');
      if (fromIdxStr === '' || fromLineId !== line.id) return;
      e.preventDefault();
      const fromIdx = parseInt(fromIdxStr, 10);
      if (!Number.isFinite(fromIdx)) return;
      const rect = card.getBoundingClientRect();
      const isAbove = e.clientY < rect.top + rect.height / 2;
      const toIdx = isAbove ? blockIdx : blockIdx + 1;
      moveBehaviorBlock(line.id, fromIdx, toIdx);
    });

    // v0.8.7: trigger (When) and duration (How) on independent axes.
    // v0.8.153: progressive disclosure via behaviorBlockPhases.
    const trigger  = (block && block.trigger)  ? block.trigger  : { when: 'scroll-range', range: { start: 0, end: 1 }, delay: 0 };
    const duration = (block && block.duration) ? block.duration : { mode: 'scroll' };
    const when = trigger.when || 'scroll-range';
    const dmode = duration.mode || 'scroll';
    const phase = getBlockPhase(block.id || '');

    // Summary strip — always visible; flashes in refreshBehaviorSummary
    // when a non-mode field changes. Positioned first so it reads as
    // the panel's live "what this block does" headline.
    const summary = document.createElement('div');
    summary.className = 'ed-behavior-summary';
    summary.dataset.lineId   = String(line.id);
    summary.dataset.blockIdx = String(blockIdx);
    summary.textContent = (phase === 0) ? 'Select a trigger.' : behaviorSummaryText(block);
    card.appendChild(summary);

    const isLastBlock = blockIdx === line.behaviors.length - 1;
    const driftText = behaviorDriftLineText(block, isLastBlock);
    if (driftText) {
      const driftLine = document.createElement('div');
      driftLine.className = 'ed-behavior-summary ed-behavior-summary-drift';
      driftLine.dataset.lineId   = String(line.id);
      driftLine.dataset.blockIdx = String(blockIdx);
      driftLine.dataset.kind     = 'drift';
      driftLine.textContent = driftText;
      card.appendChild(driftLine);
    }

    // ── Section: Activate when ─────────────────────────────────────────────
    const triggerTitle = document.createElement('div');
    triggerTitle.className = 'ed-behavior-section-title';
    triggerTitle.textContent = 'Activate when';
    card.appendChild(triggerTitle);

    const prevTimedIdx = (function () {
      if (!Array.isArray(line.behaviors)) return -1;
      for (let j = blockIdx - 1; j >= 0; j--) {
        const pb = line.behaviors[j];
        const pm = pb && pb.duration && pb.duration.mode;
        if (pm === 'time') return j;
      }
      return -1;
    })();
    const afterPrevDisabled = prevTimedIdx < 0;

    // v0.8.163: trigger picker is shown in full only at phases 0 and 1.
    // At phase 0 no trigger is active (null → no highlighted button).
    // At phase 1 all buttons remain visible so the user can change their mind.
    // At phase >= 2 the trigger is locked; only the chosen option is shown as
    // a single chip — clicking it returns to phase 1 to re-expand all options.
    const allTriggerOpts = [
      { value: 'scroll-range',     label: 'Scroll range' },
      { value: 'page-load',        label: 'Page load' },
      { value: 'scroll-key',       label: 'Scroll to key' },
      { value: 'in-view-partial',  label: 'In view (partial)' },
      { value: 'in-view-full',     label: 'In view (full)' },
      { value: 'after-previous',   label: 'After previous ends',
        disabledIf: afterPrevDisabled,
        disabledReason: 'No previous timed block to chain after. ' +
          'Add a block above this one with Progress = "Timed run (seconds)" ' +
          '— scroll-driven / loop / ping-pong blocks are skipped because ' +
          'they have no discrete end.' },
      { value: 'scroll-stop',      label: 'Scroll stops' },
      { value: 'scroll-start',     label: 'Scroll resumes' },
      { value: 'wait',             label: 'Wait for external Start' },
      { value: 'click',            label: 'Wait for click' },
      { value: 'hover',            label: 'Wait for hover' }
    ];
    // v0.8.165: trigger collapses to a chip immediately when one is picked.
    // Phase 0: all options shown, none active.
    // Phase >= 1: chip only (chosen trigger) + small back-arrow button.
    // The chip itself is no longer clickable to go back; only the arrow is.
    if (phase >= 1) {
      var lockedTriggerOpt = null;
      for (var _ti = 0; _ti < allTriggerOpts.length; _ti++) {
        if (allTriggerOpts[_ti].value === when) { lockedTriggerOpt = allTriggerOpts[_ti]; break; }
      }
      const triggerLabel = lockedTriggerOpt ? lockedTriggerOpt.label : when;
      appendLockedChip(card, when, triggerLabel, function () {
        setBlockPhase(block.id, 0);
        renderSelectionPanel();
      }, 'Back — pick a different trigger');
    } else {
      // Phase 0: all options visible, none active.
      card.appendChild(behaviorButtonGroup('', null, allTriggerOpts,
        function (v) {
          advanceBlockPhase(block.id, 1);
          updateBehaviorTrigger(line.id, blockIdx, 'when', v);
        }, function (opt) { explainDurationDisabled(opt); }));
    }

    // ── Phase >= 1: trigger-specific options ──────────────────────────
    // selectorFieldWrap is set inside the scroll-key branch so the
    // Continue handler (below) can mark it invalid without a DOM query.
    let selectorFieldWrap = null;
    if (phase >= 1) {
      if (when === 'scroll-range') {
        const r = trigger.range || { start: 0, end: 1 };
        const rangeRow = document.createElement('div');
        rangeRow.className = 'ed-behavior-range';
        rangeRow.appendChild(rangeNumberField('Start', r.start, function (v) {
          updateBehaviorTrigger(line.id, blockIdx, 'rangeStart', v);
        }));
        rangeRow.appendChild(rangeNumberField('End', r.end, function (v) {
          updateBehaviorTrigger(line.id, blockIdx, 'rangeEnd', v);
        }));
        card.appendChild(rangeRow);
      }

      if (when === 'scroll-key') {
        selectorFieldWrap = triggerField('Trigger key', trigger.selector || '', function (v) {
          if (selectorFieldWrap) selectorFieldWrap.classList.remove('is-required-empty');
          updateBehaviorTrigger(line.id, blockIdx, 'selector', v);
        });
        card.appendChild(selectorFieldWrap);
        const va = trigger.viewportAt || 'middle';
        card.appendChild(behaviorButtonGroup('Reaches', va, [
          { value: 'top',    label: 'Top of viewport' },
          { value: 'middle', label: 'Middle' },
          { value: 'bottom', label: 'Bottom of viewport' },
          { value: 'object', label: 'The object' }
        ], function (v) {
          updateBehaviorTrigger(line.id, blockIdx, 'viewportAt', v);
        }, null));
        const rep = trigger.repeat || 'once';
        card.appendChild(behaviorButtonGroup('Repeat', rep, [
          { value: 'once',  label: 'Once' },
          { value: 'every', label: 'Every crossing' }
        ], function (v) {
          updateBehaviorTrigger(line.id, blockIdx, 'repeat', v);
        }, null));
      }

      // v0.8.243: scroll-start direction filter. Absent = 'both' (any
      // direction triggers, matches pre-v0.8.243 behavior). Authors who
      // want a one-way trigger pick 'down' or 'up'. The runtime also
      // applies a ~4mm dead zone so accidental tiny scrolls don't fire
      // — that's global / non-configurable today.
      if (when === 'scroll-start') {
        const dir = trigger.direction || 'both';
        card.appendChild(behaviorButtonGroup('Direction', dir, [
          { value: 'down', label: 'Down' },
          { value: 'up',   label: 'Up' },
          { value: 'both', label: 'Both' }
        ], function (v) {
          updateBehaviorTrigger(line.id, blockIdx, 'direction', v);
        }, null));
      }

      const delayApplies = !(when === 'scroll-range' && dmode === 'scroll');
      if (delayApplies) {
        card.appendChild(numberField('Delay after activation (s)', trigger.delay || 0, function (v) {
          updateBehaviorTrigger(line.id, blockIdx, 'delay', v);
        }));
      }

      if (when === 'click' || when === 'hover') {
        card.appendChild(checkboxField(
          'Treat as filled',
          !!trigger.treatAsFilled,
          function (v) { updateBehaviorTrigger(line.id, blockIdx, 'treatAsFilled', v); }
        ));
      }
    }

    // ── Phase === 1: Continue button ───────────────────────────────────
    // v0.8.165: The labeled "Back" button was removed — the back-arrow
    // next to the trigger chip is now the single back affordance. Continue
    // advances to phase 2; refused with shake if a required field is empty.
    if (phase === 1) {
      const btnArea = document.createElement('div');
      btnArea.className = 'ed-behavior-btn-area';

      const contBtn = document.createElement('button');
      contBtn.type = 'button';
      contBtn.className = 'ed-behavior-continue';
      contBtn.textContent = 'Continue →';
      contBtn.addEventListener('click', function () {
        // scroll-key requires a non-empty selector before proceeding.
        if (when === 'scroll-key' && !(trigger.selector || '').trim()) {
          contBtn.classList.remove('is-invalid');
          void contBtn.offsetWidth; // restart animation
          contBtn.classList.add('is-invalid');
          setTimeout(function () { contBtn.classList.remove('is-invalid'); }, 600);
          if (selectorFieldWrap) selectorFieldWrap.classList.add('is-required-empty');
          return;
        }
        advanceBlockPhase(block.id, 2);
        renderSelectionPanel();
      });
      btnArea.appendChild(contBtn);
      card.appendChild(btnArea);
    }

    // ── Phase >= 2: Progress section + cross-object side effects ──────
    if (phase >= 2) {
      // v0.8.165: standalone "Back" button removed. Back navigation is now
      // exclusively via the back-arrow next to the trigger chip (resets the
      // trigger, returning to phase 0). Consistent with progress at phase 3.

      // ── Section: Progress ──────────────────────────────────────────────────
      const progressTitle = document.createElement('div');
      progressTitle.className = 'ed-behavior-section-title';
      progressTitle.textContent = 'Progress';
      card.appendChild(progressTitle);

      const durationOpts = [
        { value: 'scroll',   label: 'Scroll-driven',
          disabledIf: when !== 'scroll-range',
          disabledReason: 'Scroll-driven progress only works when ' +
            'activation is "Scroll range" — the range defines both ' +
            'when the block activates AND how its progress advances. ' +
            'Pick a different activation OR a different progress mode.' },
        { value: 'time',     label: 'Timed run (seconds)' },
        { value: 'loop',     label: 'Loop forever' },
        { value: 'pingpong', label: 'Ping-pong forever' },
        { value: 'loopTo',   label: 'Loop back to earlier block',
          disabledIf: prevTimedIdx < 0,
          disabledReason: 'Loop-back needs an earlier Timed block to ' +
            'return to. Add at least one block above this one with ' +
            'Progress = "Timed run (seconds)" — scroll-driven / loop / ' +
            'ping-pong blocks have no fixed start position to anchor to.' }
      ];
      // v0.8.165: progress picker mirrors the trigger picker pattern.
      // Phase 2: all options shown, none active.
      // Phase >= 3: chip + back-arrow. Chip is display only; arrow is back.
      if (phase >= 3) {
        var lockedDOpt = null;
        for (var _di = 0; _di < durationOpts.length; _di++) {
          if (durationOpts[_di].value === dmode) { lockedDOpt = durationOpts[_di]; break; }
        }
        const dmodeLabel = lockedDOpt ? lockedDOpt.label : dmode;
        appendLockedChip(card, dmode, dmodeLabel, function () {
          setBlockPhase(block.id, 2);
          renderSelectionPanel();
        }, 'Back — pick a different progress mode');
      } else {
        // Phase 2: all options visible, none pre-selected
        card.appendChild(behaviorButtonGroup('', null, durationOpts,
          function (v) {
            advanceBlockPhase(block.id, 3);
            updateBehaviorDuration(line.id, blockIdx, 'mode', v);
          },
          function (opt) { explainDurationDisabled(opt); }));
      }

      // ── Side effects: "Also control other objects" ─────────────────────
      // Hidden by default — user must opt in. Auto-shown if values are
      // already set (backward-compat with existing saved blocks).
      const hasSideEffects = !!(trigger.startObjectId || trigger.stopObjectId);
      const showSideEffects = hasSideEffects || behaviorShowSideEffects.has(block.id || '');

      if (showSideEffects) {
        const selfMaster = line.masterId || null;
        const objectIds = [];
        const seenObjMasters = {};
        state.lines.forEach(function (ln) {
          const m = ln.masterId;
          if (!m || m === selfMaster) return;
          if (seenObjMasters[m]) return;
          seenObjMasters[m] = true;
          const master = state.masters.find(function (x) { return x.id === m; });
          const label = (master && master.name) || ln.name || ln.id || m;
          objectIds.push({ value: m, label: label });
        });
        objectIds.sort(function (a, b) { return a.label.localeCompare(b.label); });
        const objOptsWithNone = [{ value: '', label: '(none)' }].concat(objectIds);

        // v0.8.162: "Also" title row with a close [×] button so user can
        // collapse the section and optionally clear the saved objects.
        const sideTitleRow = document.createElement('div');
        sideTitleRow.className = 'ed-behavior-section-title ed-behavior-also-title';
        const sideTitleText = document.createElement('span');
        sideTitleText.textContent = 'Also';
        sideTitleRow.appendChild(sideTitleText);
        // v0.8.166: SVG × replaces the old text glyph — the previous
        // 1.1em "×" character was visually undersized for an action button.
        // Sized in line with .ed-behavior-chip-back (icon-only button).
        const alsoCloseBtn = document.createElement('button');
        alsoCloseBtn.type = 'button';
        alsoCloseBtn.className = 'ed-behavior-also-close';
        alsoCloseBtn.title = 'Remove "also" controls';
        alsoCloseBtn.setAttribute('aria-label', 'Remove also-controls');
        alsoCloseBtn.innerHTML =
          '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
            '<line x1="6"  y1="6"  x2="18" y2="18" stroke="currentColor" ' +
                  'stroke-width="3" stroke-linecap="round"></line>' +
            '<line x1="18" y1="6"  x2="6"  y2="18" stroke="currentColor" ' +
                  'stroke-width="3" stroke-linecap="round"></line>' +
          '</svg>';
        alsoCloseBtn.addEventListener('click', function () {
          behaviorShowSideEffects.delete(block.id || '');
          // Clear any saved object IDs so hasSideEffects becomes false
          // and the section stays hidden on next render.
          updateBehaviorTrigger(line.id, blockIdx, 'startObjectId', '');
          updateBehaviorTrigger(line.id, blockIdx, 'stopObjectId',  '');
        });
        sideTitleRow.appendChild(alsoCloseBtn);
        card.appendChild(sideTitleRow);
        card.appendChild(selectField('Start object', trigger.startObjectId || '', objOptsWithNone,
          function (v) { updateBehaviorTrigger(line.id, blockIdx, 'startObjectId', v); }));
        card.appendChild(selectField('Stop object', trigger.stopObjectId || '', objOptsWithNone,
          function (v) { updateBehaviorTrigger(line.id, blockIdx, 'stopObjectId', v); }));
        if (trigger.stopObjectId) {
          card.appendChild(checkboxField('  …fade out to opacity 0', !!trigger.stopFadeOut,
            function (v) { updateBehaviorTrigger(line.id, blockIdx, 'stopFadeOut', v); }));
          card.appendChild(checkboxField('  …return to original position', !!trigger.stopReturnHome,
            function (v) { updateBehaviorTrigger(line.id, blockIdx, 'stopReturnHome', v); }));
          const stopDur = (typeof trigger.stopDurationSec === 'number') ? trigger.stopDurationSec : 0;
          card.appendChild(numberField('  …cleanup duration (s, 0 = instant)', stopDur,
            function (v) { updateBehaviorTrigger(line.id, blockIdx, 'stopDurationSec', v); }));
          card.appendChild(selectField('  …cleanup easing', trigger.stopEasing || 'linear',
            EASING_OPTIONS,
            function (v) { updateBehaviorTrigger(line.id, blockIdx, 'stopEasing', v); }));
        }
      } else {
        const alsoBtn = document.createElement('button');
        alsoBtn.type = 'button';
        alsoBtn.className = 'ed-behavior-also-btn';
        alsoBtn.textContent = '+ Also control other objects';
        alsoBtn.addEventListener('click', function () {
          behaviorShowSideEffects.add(block.id || '');
          renderSelectionPanel();
        });
        card.appendChild(alsoBtn);
      }
    }

    // ── Phase >= 3: progress options + effects ─────────────────────────
    if (phase >= 3) {
      if (dmode !== 'scroll') {
        const secondsLabel = (dmode === 'loopTo') ? 'Return time (s)' : 'Seconds';
        card.appendChild(numberField(secondsLabel, duration.seconds || 1, function (v) {
          updateBehaviorDuration(line.id, blockIdx, 'seconds', v);
        }));
        card.appendChild(selectField('Easing', duration.easing || 'linear',
          EASING_OPTIONS,
          function (v) { updateBehaviorDuration(line.id, blockIdx, 'easing', v); }));
      }

      if (dmode === 'loopTo') {
        const targets = [];
        for (let j = 0; j < blockIdx; j++) {
          const bj = line.behaviors && line.behaviors[j];
          const bjm = bj && bj.duration && bj.duration.mode;
          if (bjm === 'time') {
            targets.push({ value: String(j), label: 'Block ' + (j + 1) + ' (Timed)' });
          }
        }
        const curTarget = Number.isInteger(duration.target) ? String(duration.target) : '';
        card.appendChild(selectField('Loop back to', curTarget, targets, function (v) {
          updateBehaviorDuration(line.id, blockIdx, 'target', parseInt(v, 10));
        }));
        const maxIter = (Number.isInteger(duration.maxIterations) && duration.maxIterations > 0)
                        ? duration.maxIterations : 0;
        card.appendChild(numberField('Max iterations (0 = forever)', maxIter, function (v) {
          updateBehaviorDuration(line.id, blockIdx, 'maxIterations', v);
        }));
        return card;
      }

      // ── Section: What changes ──────────────────────────────────────────────
      const effectsTitle = document.createElement('div');
      effectsTitle.className = 'ed-behavior-section-title';
      effectsTitle.textContent = 'What changes';
      card.appendChild(effectsTitle);

      const tmode = (params.translateMode || gd.translateMode || 'fixed');
      const NON_PATH_KINDS = ['image'];
      const guideOpts = state.lines
        .filter(function (l) {
          return l.id !== line.id
              && !!l.masterId
              && NON_PATH_KINDS.indexOf(l.kind) === -1;
        })
        .map(function (l) {
          return { value: l.masterId, label: (l.name || l.id) + ' (' + l.kind + ')' };
        });
      const canPathFollow = guideOpts.length > 0;
      card.appendChild(behaviorButtonGroup('Translate mode', tmode, [
        { value: 'fixed',      label: 'Fixed' },
        { value: 'driftX',     label: 'Drift X' },
        { value: 'driftY',     label: 'Drift Y' },
        { value: 'driftBoth',  label: 'Drift both' },
        { value: 'pathFollow', label: 'Along path',
          disabledIf: !canPathFollow,
          disabledReason: 'No other path-bearing lines in this class. '
            + 'Add at least one freehand, bezier, chain, loop, or imported '
            + 'SVG line to use as a path guide.' }
      ], function (v) {
        updateBehaviorParam(line.id, 'translateMode', v === 'fixed' ? null : v, blockIdx);
        if (v === 'pathFollow' && guideOpts.length) {
          const l2 = state.lines.find(function (l) { return l.id === line.id; });
          const cur = l2 && Array.isArray(l2.behaviors) && l2.behaviors[blockIdx]
                         && l2.behaviors[blockIdx].params;
          if (cur && !cur.pathRef) {
            updateBehaviorParam(line.id, 'pathRef', guideOpts[0].value, blockIdx);
            const seeded = state.lines.find(function (l) { return l.masterId === guideOpts[0].value; });
            if (seeded) {
              updateBehaviorParam(line.id, 'pathRefName', seeded.name || seeded.id, blockIdx);
            }
          }
        }
        renderSelectionPanel();
      }, function (opt) {
        if (opt && opt.disabledReason) alert(opt.disabledReason);
      }));

      const xDrift = (tmode === 'driftX' || tmode === 'driftBoth');
      const yDrift = (tmode === 'driftY' || tmode === 'driftBoth');
      const isPathFollow = (tmode === 'pathFollow');
      if (!isPathFollow) {
        card.appendChild(overrideNumberField(xDrift ? 'TranslateX (\xd7scroll)' : 'TranslateX', params.translateX, gd.translateX, function (v) { updateBehaviorParam(line.id, 'translateX', v, blockIdx); }));
        card.appendChild(overrideNumberField(yDrift ? 'TranslateY (\xd7scroll)' : 'TranslateY', params.translateY, gd.translateY, function (v) { updateBehaviorParam(line.id, 'translateY', v, blockIdx); }));
      } else {
        const currentGuide = (typeof params.pathRef === 'string') ? params.pathRef : '';
        card.appendChild(selectField('Path guide', currentGuide, guideOpts, function (v) {
          updateBehaviorParam(line.id, 'pathRef', v || null, blockIdx);
          const picked = v ? state.lines.find(function (l) { return l.masterId === v; }) : null;
          const nm = picked ? (picked.name || picked.id) : null;
          updateBehaviorParam(line.id, 'pathRefName', nm, blockIdx);
        }));
        card.appendChild(checkboxField('Align to tangent', !!params.pathAlignToTangent, function (v) {
          updateBehaviorParam(line.id, 'pathAlignToTangent', v ? true : null, blockIdx);
        }));
        const endMode = params.pathEndMode || 'stop';
        card.appendChild(selectField('At end of path', endMode, [
          { value: 'stop',     label: 'Stop at end' },
          { value: 'loop',     label: 'Loop (snap to start)' },
          { value: 'pingpong', label: 'Ping-pong (reverse direction)' }
        ], function (v) {
          updateBehaviorParam(line.id, 'pathEndMode', (v === 'stop' ? null : v), blockIdx);
        }));
      }
      card.appendChild(overrideNumberField('Rotate', params.rotate, gd.rotate, function (v) { updateBehaviorParam(line.id, 'rotate', v, blockIdx); }));
      const resolvedRotate = (params.rotate != null) ? Number(params.rotate)
                           : Number(gd.rotate || 0);
      const noRotate = !Number.isFinite(resolvedRotate) || resolvedRotate === 0;
      if (!noRotate) {
        card.appendChild(overrideNumberField('Pivot Δx (from center)', params.rotateOriginX, gd.rotateOriginX, function (v) { updateBehaviorParam(line.id, 'rotateOriginX', v, blockIdx); }));
        card.appendChild(overrideNumberField('Pivot Δy (from center)', params.rotateOriginY, gd.rotateOriginY, function (v) { updateBehaviorParam(line.id, 'rotateOriginY', v, blockIdx); }));
        card.appendChild(setOriginButton(function () {
          startSetRotateOrigin({ type: 'line', id: line.id, blockIdx: blockIdx });
        }));
      }
      // v0.8.169: thin separator between rotate-group and opacity-group
      // — rotate and opacity are unrelated properties; the divider makes
      // that grouping obvious. Same idiom as section-title border-top
      // but without a label since both groups live under "What changes".
      card.appendChild(behaviorPropDivider());
      const fadeOn = !!params.fadeOpacity;
      card.appendChild(checkboxField('Fade opacity', fadeOn, function (v) {
        updateBehaviorParam(line.id, 'fadeOpacity', v ? true : null, blockIdx);
        renderSelectionPanel();
      }));
      if (fadeOn) {
        const oFrom = (typeof params.opacityFrom === 'number') ? params.opacityFrom : 1;
        const oTo   = (typeof params.opacityTo   === 'number') ? params.opacityTo   : 0;
        card.appendChild(numberField('Opacity from (0–1)', oFrom, function (v) {
          updateBehaviorParam(line.id, 'opacityFrom', v, blockIdx);
        }));
        card.appendChild(numberField('Opacity to (0–1)', oTo, function (v) {
          updateBehaviorParam(line.id, 'opacityTo', v, blockIdx);
        }));
      }
      // v0.8.169: thin separator between opacity-group and draw-in group.
      card.appendChild(behaviorPropDivider());
      card.appendChild(overrideCheckboxField('Draw-in', params.drawIn, gd.drawIn, function (v) {
        updateBehaviorParam(line.id, 'drawIn', v, blockIdx);
        renderSelectionPanel();
      }));
      const resolvedDrawIn = (params.drawIn != null) ? !!params.drawIn : !!gd.drawIn;
      if (resolvedDrawIn) {
        card.appendChild(overrideSelectField('Direction', params.drawInDirection,
          gd.drawInDirection || 'forward',
          [
            { value: 'forward', label: 'Begin → end' },
            { value: 'reverse', label: 'End → begin' }
          ],
          function (v) { updateBehaviorParam(line.id, 'drawInDirection', v, blockIdx); }));
      }
    }

    return card;
  }

  // v0.8.19: gray + disable a field row whose value can't take
  // effect under the current combination of other settings (e.g.
  // "Trigger key" while Activate=Scroll range). Returns the same
  // node so this can be wrapped around a card.appendChild(...)
  // call without a temp var. CSS handles the visual + pointer-
  // events; the underlying value stays in the model so the field
  // is restored intact when the gating condition flips back.
  function setInactive(node, inactive) {
    if (inactive) node.classList.add('is-inactive');
    else node.classList.remove('is-inactive');
    return node;
  }

  function numberField(label, value, onChange) {
    const wrap = document.createElement('div');
    wrap.className = 'ed-field ed-field--number';
    const lbl = document.createElement('label'); lbl.textContent = label;
    const inp = document.createElement('input');
    inp.type = 'number'; inp.value = (value !== undefined && value !== null) ? value : 0;
    inp.addEventListener('input', function () { onChange(parseFloat(inp.value)); });
    wrap.appendChild(lbl); wrap.appendChild(inp);
    return wrap;
  }
  function checkboxField(label, value, onChange) {
    const wrap = document.createElement('div');
    wrap.className = 'ed-field ed-field--checkbox';
    const lbl = document.createElement('label'); lbl.textContent = label;
    const inp = document.createElement('input');
    inp.type = 'checkbox'; inp.checked = !!value;
    inp.addEventListener('change', function () { onChange(inp.checked); });
    wrap.appendChild(lbl); wrap.appendChild(inp);
    return wrap;
  }
  function overrideNumberField(label, ov, fallback, onChange) {
    const wrap = document.createElement('div');
    wrap.className = 'ed-field ed-field--number';
    const lbl = document.createElement('label'); lbl.textContent = label;
    const inp = document.createElement('input');
    inp.type = 'number';
    inp.value = (ov !== undefined) ? ov : '';
    inp.placeholder = (fallback !== undefined && fallback !== null) ? String(fallback) : '';
    inp.addEventListener('input', function () {
      const v = inp.value === '' ? null : parseFloat(inp.value);
      onChange(v);
    });
    wrap.appendChild(lbl); wrap.appendChild(inp);
    return wrap;
  }
  function overrideCheckboxField(label, ov, fallback, onChange) {
    // Tri-state: indeterminate = inherit, checked/unchecked = override.
    const wrap = document.createElement('div');
    wrap.className = 'ed-field ed-field--checkbox';
    const lbl = document.createElement('label'); lbl.textContent = label;
    const grp = document.createElement('div');
    grp.style.display = 'flex'; grp.style.gap = '0.5rem'; grp.style.alignItems = 'center';
    const inp = document.createElement('input');
    inp.type = 'checkbox';
    inp.checked = (ov === undefined) ? !!fallback : !!ov;
    inp.indeterminate = (ov === undefined);
    inp.addEventListener('change', function () {
      inp.indeterminate = false;
      onChange(inp.checked);
    });
    const clr = document.createElement('button');
    clr.type = 'button'; clr.textContent = 'inherit';
    clr.style.background = 'transparent'; clr.style.border = '1px solid #555';
    clr.style.color = '#888'; clr.style.padding = '0.1rem 0.4rem'; clr.style.borderRadius = '3px';
    clr.style.cursor = 'pointer'; clr.style.fontSize = '0.8em';
    clr.addEventListener('click', function () { onChange(null); });
    grp.appendChild(inp); grp.appendChild(clr);
    wrap.appendChild(lbl); wrap.appendChild(grp);
    return wrap;
  }
  function strokeField(label, value, onChange) {
    // Color picker constrained to the palette — no free entry.
    // Enforces the "design system" discipline: every line color must
    // come from the project palette. Add/edit colors via the Design
    // colors panel; this field only references them by id.
    // Empty / "inherit" clears the field so the line falls back to its
    // group default (or, for groups, the runtime CSS default).
    const wrap = document.createElement('div');
    wrap.className = 'ed-field';
    const lbl = document.createElement('label'); lbl.textContent = label;

    const picker = document.createElement('div');
    picker.className = 'ed-color-picker';

    function activate(target) {
      picker.querySelectorAll('.swatch').forEach(function (s) { s.classList.remove('is-active'); });
      target.classList.add('is-active');
    }

    state.palette.forEach(function (c) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'swatch' + (value === c.id ? ' is-active' : '');
      btn.style.background = c.value;
      btn.title = c.name;
      btn.addEventListener('click', function () {
        activate(btn);
        onChange(c.id);
      });
      picker.appendChild(btn);
    });

    // Inherit / clear button.
    const clr = document.createElement('button');
    clr.type = 'button';
    clr.className = 'swatch is-clear' + (!value ? ' is-active' : '');
    clr.textContent = 'inherit';
    clr.title = 'Clear (use group default)';
    clr.addEventListener('click', function () {
      activate(clr);
      onChange(null);
    });
    picker.appendChild(clr);

    wrap.appendChild(lbl); wrap.appendChild(picker);
    return wrap;
  }

  function imageSourceField(label, value, onChange) {
    // Image URL input — datalist-backed text input. Suggestions are
    // public URLs the server collected at editor render time: page-
    // attached files + assets/images/. Picking from the dropdown is
    // a click; pasting any URL (external CDN, etc.) still works
    // because it's a plain text input, the datalist is suggestions
    // not constraints.
    const wrap = document.createElement('div');
    wrap.className = 'ed-field';
    const lbl = document.createElement('label'); lbl.textContent = label;
    const datalistId = 'ed-image-sources';
    if (!document.getElementById(datalistId)) {
      const dl = document.createElement('datalist');
      dl.id = datalistId;
      const sources = Array.isArray(initial.imageSources) ? initial.imageSources : [];
      sources.forEach(function (s) {
        const opt = document.createElement('option');
        opt.value = s;
        dl.appendChild(opt);
      });
      document.body.appendChild(dl);
    }
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.setAttribute('list', datalistId);
    inp.value = value || '';
    inp.placeholder = 'pick from server, or paste any URL';
    inp.addEventListener('input', function () { onChange(inp.value); });
    wrap.appendChild(lbl); wrap.appendChild(inp);
    return wrap;
  }

  function triggerField(label, value, onChange) {
    // Trigger input — a free-text field paired with a <datalist> so the
    // user gets autocomplete suggestions for selectors that actually
    // exist in the target page's template (extracted at render time and
    // passed in via the editor-data JSON), but can still type anything.
    const wrap = document.createElement('div');
    wrap.className = 'ed-field';
    const lbl = document.createElement('label'); lbl.textContent = label;

    const datalistId = 'ed-trigger-suggestions';
    if (!document.getElementById(datalistId)) {
      const dl = document.createElement('datalist');
      dl.id = datalistId;
      const suggestions = Array.isArray(initial.triggerSuggestions) ? initial.triggerSuggestions : [];
      suggestions.forEach(function (s) {
        const opt = document.createElement('option');
        opt.value = s;
        dl.appendChild(opt);
      });
      document.body.appendChild(dl);
    }

    const inp = document.createElement('input');
    inp.type = 'text';
    inp.setAttribute('list', datalistId);
    inp.value = value || '';
    inp.placeholder = 'CSS selector, empty = page-wide';
    inp.addEventListener('input', function () { onChange(inp.value); });

    wrap.appendChild(lbl); wrap.appendChild(inp);
    return wrap;
  }

  function selectField(label, value, options, onChange) {
    const wrap = document.createElement('div');
    wrap.className = 'ed-field';
    const lbl = document.createElement('label'); lbl.textContent = label;
    const sel = document.createElement('select');
    options.forEach(function (o) {
      const opt = document.createElement('option');
      opt.value = o.value;
      opt.textContent = o.label;
      if (o.value === value) opt.selected = true;
      sel.appendChild(opt);
    });
    sel.addEventListener('change', function () { onChange(sel.value); });
    wrap.appendChild(lbl); wrap.appendChild(sel);
    return wrap;
  }

  // For tri-state per-line overrides on select fields: an extra
  // "(inherit)" option at the top maps to null (clear override).
  function overrideSelectField(label, ov, fallbackValue, options, onChange) {
    const augmented = [{ value: '__inherit__', label: '(inherit)' }].concat(options);
    return selectField(label, ov == null ? '__inherit__' : ov, augmented, function (v) {
      onChange(v === '__inherit__' ? null : v);
    });
  }

  function setOriginButton(onClick) {
    // A field row whose right column is a button. Empty label keeps
    // the grid layout aligned with the number fields above.
    const wrap = document.createElement('div');
    wrap.className = 'ed-field';
    const lbl = document.createElement('label'); lbl.textContent = '';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ed-mini ed-set-origin-btn';
    btn.textContent = 'Set on canvas →';
    btn.title = 'Click here, then click anywhere on the canvas to set the rotation origin to that point.';
    btn.addEventListener('click', function (e) {
      // v0.8.230: arm the button visually before invoking the callback,
      // so the user gets immediate confirmation that the click landed.
      // Without this, the only feedback was the red crosshair cursor —
      // which only appears once the pointer enters the canvas area.
      // For a button in the side panel, that meant zero feedback at
      // the click site. Clear any previously-armed button first (only
      // one set-origin/set-text-offset flow can be active at a time).
      document.querySelectorAll('.ed-set-origin-btn.is-armed').forEach(function (b) {
        b.classList.remove('is-armed');
      });
      btn.classList.add('is-armed');
      onClick(e);
    });
    wrap.appendChild(lbl); wrap.appendChild(btn);
    return wrap;
  }
  // v0.8.230: shared with exitSetRotateOrigin / exitSetTextOffset so
  // the armed-button highlight clears when the canvas click consumes
  // the mode, or when the user hits Escape.
  function clearArmedSetOriginButtons() {
    document.querySelectorAll('.ed-set-origin-btn.is-armed').forEach(function (b) {
      b.classList.remove('is-armed');
    });
  }

  // v0.8.132: shared helper — appends a bounding-box metadata row
  // to `container` for `line`. Uses getBBox() on the live SVG element
  // (works for all kinds). Includes a Show / Hide button that paints
  // a temporary dotted rectangle on the canvas overlay. The overlay
  // is cleared automatically on panel close or object deselect — it
  // is purely ephemeral and never persisted.
  var _bboxOverlayEl = null; // singleton overlay rect element
  var _bboxOverlayLineId = null;
  function clearBboxOverlay() {
    if (_bboxOverlayEl && _bboxOverlayEl.parentNode) {
      _bboxOverlayEl.parentNode.removeChild(_bboxOverlayEl);
    }
    _bboxOverlayEl = null;
    _bboxOverlayLineId = null;
  }
  function appendBboxRow(container, line) {
    var svgEl = linesG && linesG.querySelector('[data-line-id="' + line.id + '"]');
    if (!svgEl) return;
    var bb;
    try { bb = svgEl.getBBox(); } catch (e) { return; }
    if (!bb || bb.width <= 0) return;

    var row = document.createElement('div');
    row.className = 'ed-params-meta ed-params-meta--bbox';

    var text = document.createElement('span');
    text.textContent = 'Bounding box ' + bb.width.toFixed(1) + ' × ' + bb.height.toFixed(1) + ' mm';
    row.appendChild(text);

    var showBtn = document.createElement('button');
    showBtn.type = 'button';
    showBtn.className = 'ed-mini ed-bbox-show-btn';
    var isShowing = _bboxOverlayLineId === line.id && !!_bboxOverlayEl;
    showBtn.textContent = isShowing ? 'Hide' : 'Show';
    showBtn.addEventListener('click', function () {
      var currentlyShowing = _bboxOverlayLineId === line.id && !!_bboxOverlayEl;
      clearBboxOverlay();
      if (!currentlyShowing) {
        // Re-query — geometry may have changed since row was built.
        var el = linesG && linesG.querySelector('[data-line-id="' + line.id + '"]');
        var b2;
        try { b2 = el && el.getBBox(); } catch (e) { return; }
        if (!b2 || b2.width <= 0) return;
        var rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        rect.setAttribute('x',      String(b2.x));
        rect.setAttribute('y',      String(b2.y));
        rect.setAttribute('width',  String(b2.width));
        rect.setAttribute('height', String(b2.height));
        rect.setAttribute('fill',   'none');
        rect.setAttribute('stroke', '#5fa8d3');
        rect.setAttribute('stroke-width', '0.5');
        rect.setAttribute('stroke-dasharray', '2 2');
        rect.setAttribute('pointer-events', 'none');
        svg.appendChild(rect);
        _bboxOverlayEl = rect;
        _bboxOverlayLineId = line.id;
        showBtn.textContent = 'Hide';
      } else {
        showBtn.textContent = 'Show';
      }
    });
    row.appendChild(showBtn);
    container.appendChild(row);
  }

  function divider(label) {
    const el = document.createElement('div');
    el.style.color = '#888';
    el.style.fontSize = '0.75em';
    el.style.textTransform = 'uppercase';
    el.style.letterSpacing = '0.08em';
    el.style.borderTop = '1px solid #333';
    el.style.paddingTop = '0.4rem';
    el.style.marginTop = '0.3rem';
    el.textContent = label;
    return el;
  }

  function renderAll() {
    renderPaletteList();
    renderGroupsList();
    renderLines();
    renderSelectionPanel();
    // v0.8.195: keep the Google Fonts <link> in sync with whatever
    // font families the masters reference. Cheap (no-op when the
    // family set hasn't changed).
    injectGoogleFontsLink();
  }

  // v0.8.206: load the curated font bundle once at editor start so the
  // TEXT section's font picker has its <datalist> suggestions ready
  // and bundled families are preloaded for face-accurate preview.
  // Fire-and-forget — the editor stays usable while it resolves.
  loadFontBundle();
  loadLocalFonts();

  // ── Save ──────────────────────────────────────────────────────────
  async function save() {
    saveBtn.disabled = true;
    saveStatus.classList.remove('is-error');
    saveStatus.textContent = 'Saving…';
    try {
      // Decompose flat per-class lines back into the v4 on-disk shape:
      //   masters[]                — site-wide visual definitions
      //   byClass[cid].instances[] — per-class refs + overrides
      // state.masters is refreshed too so the next save sees the
      // current values (e.g., after renaming or restyling in canonical
      // class).
      const decomposed = decomposeForSave();
      // v0.8.46: skeleton-line guard — if decomposeForSave had to
      // drop lines with no master content, confirm before writing
      // so the user can't silently lose data. The dropped lines
      // wouldn't have rendered anyway, but acknowledging the drop
      // is what stops the silent-corruption pattern that produced
      // them in the first place.
      if (decomposed.droppedLines && decomposed.droppedLines.length) {
        const summary = decomposed.droppedLines.slice(0, 8).map(function (d) {
          return '  • ' + d.id + ' (' + d.cid + ')'
            + (d.masterId ? ' → missing master ' + d.masterId : '');
        }).join('\n');
        const more = decomposed.droppedLines.length > 8
          ? '\n  …and ' + (decomposed.droppedLines.length - 8) + ' more'
          : '';
        const ok = confirm(decomposed.droppedLines.length
          + ' line(s) reference missing master data and will be DROPPED from '
          + 'this save:\n\n' + summary + more
          + '\n\nProceed? (Cancel to investigate first — these lines wouldn\'t '
          + 'render anyway, but dropping them is permanent.)');
        if (!ok) {
          saveStatus.textContent = 'Save canceled.';
          saveBtn.disabled = false;
          return;
        }
      }
      state.masters = decomposed.masters;

      const res = await fetch('/dev/draw/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          page:    state.pageId,
          masters: decomposed.masters,
          byClass: decomposed.byClass,
          palette: state.palette.map(reorderIdNameFirst),
          pageCfg: state.pageConfig
        })
      });
      const body = await res.json().catch(function () { return {}; });
      if (!res.ok || !body.ok) {
        throw new Error(body.error || ('HTTP ' + res.status));
      }
      state.dirty = false;
      // Flash the Save button itself (where the user's eyes already
      // are) instead of relying on the status text aside.
      saveBtn.classList.add('is-flash-success');
      setTimeout(function () { saveBtn.classList.remove('is-flash-success'); }, 900);
      saveStatus.textContent = 'Saved.';
      setTimeout(function () { saveStatus.textContent = ''; }, 2500);
    } catch (err) {
      saveStatus.classList.add('is-error');
      saveStatus.textContent = 'Save failed: ' + err.message;
    } finally {
      saveBtn.disabled = false;
    }
  }

  // ── Wire-up ───────────────────────────────────────────────────────
  toolButtons.forEach(function (b) {
    b.addEventListener('click', function () { setActiveTool(b.dataset.tool); });
  });
  newGroupBtn.addEventListener('click', addGroup);
  newColorBtn.addEventListener('click', addColor);
  saveBtn.addEventListener('click', save);
  clearLinesBtn.addEventListener('click', clearAllLines);
  helpBtn.addEventListener('click', function () { showHelp('general'); });
  zoomInBtn.addEventListener('click',  function () { zoomIn();  });
  zoomOutBtn.addEventListener('click', function () { zoomOut(); });
  // Click the percentage to open a small zoom dialog. Lets the user
  // either type an exact percent OR hit "100%" for a one-click
  // return to fit-to-canvas — the easy reset that the bare prompt()
  // dialog used to require typing.
  zoomLevelEl.addEventListener('click', showZoomDialog);
  zoomLevelEl.title = 'Click to set an exact zoom percentage';
  undoBtn.addEventListener('click', undo);
  redoBtn.addEventListener('click', redo);
  renderDiagGrid(); // initial paint if the flag was already on
  settingsBtn.addEventListener('click', showSettings);

  // Create-object wizard wiring.
  if (createObjectBtn) createObjectBtn.addEventListener('click', showCreateModal);

  // v0.8.173: button id kept as `library-btn` for backward compat but
  // now opens the Project hub modal (Master library is one of its tiles).
  const libraryBtn = document.getElementById('library-btn');
  if (libraryBtn) libraryBtn.addEventListener('click', showProjectDialog);

  // SVG import — file picker wiring. The input is hidden at page
  // scope so the change handler stays bound for the lifetime of
  // the editor; v0.8.36 moved the trigger button into the Create
  // object modal (showCreateModal) so the toolbar isn't crowded
  // with two "new object" actions. The button there does
  // importSvgInput.click() to pop the file picker.
  const importSvgInput = document.getElementById('import-svg-input');
  if (importSvgInput) {
    importSvgInput.addEventListener('change', function () {
      // Copy to a real array BEFORE clearing input.value — otherwise
      // some browsers invalidate the FileList ref mid-import.
      const files = Array.prototype.slice.call(importSvgInput.files || []);
      importSvgInput.value = '';
      if (files.length) importSvgFiles(files);
    });
  }
  if (wizardSaveBtn)   wizardSaveBtn.addEventListener('click',   saveWizardObject);
  if (wizardCancelBtn) wizardCancelBtn.addEventListener('click', cancelWizard);

  // Page picker — reloads with ?page=<slug>. If the user has unsaved
  // changes we confirm first; otherwise switch immediately.
  const pageSelect = document.getElementById('page-select');
  if (pageSelect) {
    pageSelect.addEventListener('change', function () {
      const slug = pageSelect.value;
      if (slug === state.pageId) return;
      if (state.dirty && !confirm('Unsaved changes will be lost. Switch page anyway?')) {
        pageSelect.value = state.pageId;
        return;
      }
      window.location.assign('/dev/draw?page=' + encodeURIComponent(slug));
    });
  }

  // Class tabs — hot-swap (no reload). state.classId update flips
  // the live aliases for lines / groups / page, then re-renders.
  document.querySelectorAll('.ed-class-tab').forEach(function (btn) {
    btn.addEventListener('click', function () {
      switchClass(btn.dataset.classId);
    });
  });

  // Apply remembered class on init if it differs from the server's
  // initial pick (template emitted a class for first paint; we may
  // hot-swap immediately to honor the user's preference).
  if (state.classId !== (initial.classId || 'wide')) {
    // The template emitted SVG dims for initial.classId; rebind the
    // canvas to the chosen class.
    applyPageConfig();
    document.querySelectorAll('.ed-class-tab').forEach(function (b) {
      const on = b.dataset.classId === state.classId;
      b.classList.toggle('is-active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
  }

  // Clone-from-class action — copies another class's lines + groups
  // into the current class. Canvas dims are left alone (they're
  // class-specific by design).
  const cloneClassBtn = document.getElementById('clone-class-btn');
  if (cloneClassBtn) {
    cloneClassBtn.addEventListener('click', showCloneDialog);
  }

  // Scope mode toggle (A / 1) — v0.7.0 scaffolding. Flips
  // state.mode between 'all' and 'one' and re-paints the class-
  // tab strip so the visual treatment matches. Action wiring is
  // intentionally noop at this stage — the mode is observable but
  // doesn't change behavior yet.
  const scopeModeBtn = document.getElementById('scope-mode-btn');
  const classTabsEl  = document.querySelector('.ed-class-tabs');
  function applyScopeModeVisuals() {
    if (classTabsEl) classTabsEl.classList.toggle('is-mode-all', state.mode === 'all');
    if (scopeModeBtn) {
      scopeModeBtn.textContent = state.mode === 'all' ? 'A' : '1';
      scopeModeBtn.classList.toggle('is-mode-all', state.mode === 'all');
      scopeModeBtn.title = state.mode === 'all'
        ? 'Scope: ALL classes — edits apply across every class. Click to restrict to the current class only.'
        : 'Scope: ONE class — edits stay in the current class. Click to apply across every class.';
    }
  }
  if (scopeModeBtn) {
    scopeModeBtn.addEventListener('click', function () {
      state.mode = state.mode === 'all' ? 'one' : 'all';
      applyScopeModeVisuals();
      // Re-render the selection panel so canonical-key fields
      // pick up / drop the locked treatment as the mode flips.
      renderSelectionPanel();
    });
  }
  applyScopeModeVisuals();

  selectAllBtn.addEventListener('click', toggleSelectAll);
  updateSelectAllButton();

  // Wheel zoom — requires Ctrl/Cmd modifier so plain wheel keeps
  // scrolling the canvas wrap normally. Anchored to the cursor so
  // the point under the pointer stays put across the zoom step.
  canvasWrap.addEventListener('wheel', function (e) {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    // Very fine 1.5% per tick — toolbar buttons use 1.25× for bigger
    // jumps; the wheel is for dialing in precise zoom levels (e.g.,
    // matching the live viewport's effective zoom for screenshot
    // comparison).
    const factor = e.deltaY < 0 ? 1.015 : (1 / 1.015);
    setZoom(state.zoom * factor, e.clientX, e.clientY);
  }, { passive: false });

  // Center the page area in the scrollable canvas on first load so
  // the user starts looking at the live viewport rather than empty
  // off-page space. The page area's top-left corner sits at SVG
  // pixel ((canvas-page)/2) in each axis — center the wrap on the
  // page's midpoint, scaled by current zoom.
  function centerOnPage() {
    const wrap = canvasWrap;
    const pw = state.page.pageW, ph = state.page.pageH;
    const bleedX = (state.page.canvasW - pw) / 2;
    const bleedY = (state.page.canvasH - ph) / 2;
    wrap.scrollLeft = (bleedX + pw / 2) * state.zoom - wrap.clientWidth  / 2;
    wrap.scrollTop  = (bleedY + ph / 2) * state.zoom - wrap.clientHeight / 2;
  }

  // Pointer events → active tool. Pointer capture keeps the stroke
  // alive even if the cursor leaves the SVG mid-drag.
  //
  // A click (pointerdown + pointerup with no significant movement) is
  // treated as a selection gesture: clicking on a line's hit target
  // selects it, clicking empty canvas deselects. This runs after the
  // active tool's onPointerUp, so a pure-click never commits a stroke
  // (each tool's onPointerUp short-circuits on insufficient movement)
  // and the tool's cleanup leaves no residue to compete with.
  let pointerActive = false;
  let downClient = null;
  let downTarget = null;
  // Cycle-through selection: when several lines' hit-targets overlap
  // under one click, the first click picks the topmost, subsequent
  // clicks at the same spot rotate through the rest.
  let clickCycle = null; // { x, y, ids: [...], idx: <int> }
  // v0.8.48: anchor for Mac-style shift-click range select in the
  // sidebar's per-group line lists. Updated on plain/cmd clicks of
  // a line row; consumed by shift-click to compute a range within
  // the same group. Cross-group shift-click falls back to plain
  // click (Mac convention — Finder doesn't range across folders).
  let sidebarAnchorLineId  = null;
  let sidebarAnchorGroupId = null;
  // Move-selection mode: pressing inside any selected object's hit
  // area (but not on a handle) starts translating every selected
  // object in lockstep. Single- and multi-select share this code path
  // — selectedIds.length is the only difference. Reset on pointerup.
  let moveSel = null;  // { startPt, origLines: [{ id, origPoints, origSegments, origParams, origOverrides }, …] }
  // Set-rotate-origin mode: the user clicked "Set on canvas →" in a
  // panel; the next canvas click writes that point into the active
  // target's rotateOriginX / Y, then mode exits.
  let settingOrigin = null; // { type: 'group'|'line', id: '…' }
  // v0.8.197: same idea for the text overlay — the next canvas click
  // becomes the text anchor (offset stored on master.text as a delta
  // from the line's natural center). { masterId, lineId } so we can
  // recompute the center via centerOf(line). Exits on click.
  let settingTextOffset = null;

  // v0.8.125: toggle the 'object' panel for a specific objectId.
  // The caller passes the opt-clicked id explicitly so we can
  // recognize "this object already has a panel" regardless of
  // whether it's pinned (objectId-bound) or unpinned (follower
  // showing the primary selection). Without this, opt-clicking an
  // object that already has a pinned panel (e.g. from a prior
  // multi-select fan-out) spawned a *second* panel for the same
  // object — the unpinned-only check missed the pinned one.
  //
  // Match rules:
  //   - pinned panel with objectId === target → "for this object"
  //   - unpinned follower AND state.selectedIds[0] === target → also
  //     "for this object" (the follower is currently showing it)
  //
  // If a matching panel exists, close it. Otherwise open:
  //   - the unpinned follower if target is the primary selection
  //     (the natural single-selection case)
  //   - a pinned panel bound to target if it isn't (opt-clicking a
  //     non-primary object in a multi-select is rare but we should
  //     show the panel for the object the user actually clicked,
  //     not for whatever happens to be selectedIds[0])
  // v0.8.137: Returns true when an object panel is currently open and
  // displaying content for the given lineId — either a pinned panel
  // explicitly bound to it, or the selection-following unpinned panel
  // while this object is the primary selection.
  function isObjectPanelOpenFor(lineId) {
    if (!window.PanelManager || !lineId) return false;
    const opn = window.PanelManager.listOpen().filter(function (p) {
      return p.type === 'object';
    });
    if (opn.some(function (p) { return p.pinned && p.objectId === lineId; })) return true;
    const follower = opn.find(function (p) { return !p.pinned; });
    return !!(follower && state.selectedIds[0] === lineId);
  }

  // Refreshes the is-panel-open class on all sidebar panel buttons
  // without triggering a full renderGroupsList re-build. Called by
  // PanelManager after open() and close().
  function syncPanelButtonStates() {
    document.querySelectorAll('.ed-line-panel-btn[data-line-id]').forEach(function (btn) {
      btn.classList.toggle('is-panel-open', isObjectPanelOpenFor(btn.dataset.lineId));
    });
  }

  function toggleObjectPanelFor(objectId) {
    if (!window.PanelManager || !objectId) return;
    const opn = window.PanelManager.listOpen()
      .filter(function (p) { return p.type === 'object'; });
    const primary = state.selectedIds[0];
    const pinnedForObj = opn.find(function (p) {
      return p.pinned && p.objectId === objectId;
    });
    if (pinnedForObj) {
      try { window.PanelManager.close(pinnedForObj.id); } catch (e) { console.error(e); }
      return;
    }
    const follower = opn.find(function (p) { return !p.pinned; });
    if (follower && primary === objectId) {
      try { window.PanelManager.close(follower.id); } catch (e) { console.error(e); }
      return;
    }
    // No existing panel for this object — open one.
    try {
      if (primary === objectId) {
        window.PanelManager.open('object');
      } else {
        window.PanelManager.open('object', { objectId: objectId, pinned: true });
      }
    } catch (e) { console.error(e); }
  }

  function startSetRotateOrigin(target) {
    settingOrigin = target;
    canvasWrap.classList.add('ed-set-origin-mode');
    if (setOriginBanner) setOriginBanner.hidden = false;
  }
  function exitSetRotateOrigin() {
    settingOrigin = null;
    canvasWrap.classList.remove('ed-set-origin-mode');
    if (setOriginBanner) setOriginBanner.hidden = true;
    clearArmedSetOriginButtons();
  }
  // v0.8.197: text-offset click-to-set. Reuses the same canvasWrap
  // class + banner the rotate-origin flow already wires up, so the
  // user sees the same "click anywhere on the canvas" cue.
  function startSetTextOffset(target) {
    settingTextOffset = target;
    canvasWrap.classList.add('ed-set-origin-mode');
    if (setOriginBanner) setOriginBanner.hidden = false;
  }
  function exitSetTextOffset() {
    settingTextOffset = null;
    canvasWrap.classList.remove('ed-set-origin-mode');
    if (setOriginBanner) setOriginBanner.hidden = true;
    clearArmedSetOriginButtons();
  }

  svg.addEventListener('pointerdown', function (e) {
    if (e.button !== 0) return;
    e.preventDefault();

    // Set-rotate-origin mode: consume this click as the origin and
    // exit the mode. Don't run any other behavior (no tool, no select,
    // no move).
    if (settingOrigin) {
      const pt = eventPt(e);
      const x = Math.round(pt.x * 10) / 10;
      const y = Math.round(pt.y * 10) / 10;
      if (settingOrigin.type === 'group') {
        // Group defaults still use the click coords directly — a
        // group's pivot is shared by every line in it and has no
        // single "natural center" to subtract from.
        updateGroupDefaults(settingOrigin.id, { rotateOriginX: x, rotateOriginY: y });
      } else if (settingOrigin.type === 'line') {
        // Per-line rotateOrigin is now a DELTA from the line's
        // own natural center (v0.4.6). (0,0) = pivot at center;
        // (50, 0) = 50 to the right of center. So the pivot
        // travels with the object instead of being pinned to
        // an absolute canvas spot.
        const blockIdx = (settingOrigin.blockIdx != null) ? settingOrigin.blockIdx : 0;
        const line = state.lines.find(function (l) { return l.id === settingOrigin.id; });
        const c = line ? centerOf(line) : null;
        const dx = c ? Math.round((x - c.x) * 10) / 10 : x;
        const dy = c ? Math.round((y - c.y) * 10) / 10 : y;
        updateBehaviorParam(settingOrigin.id, 'rotateOriginX', dx, blockIdx);
        updateBehaviorParam(settingOrigin.id, 'rotateOriginY', dy, blockIdx);
      }
      exitSetRotateOrigin();
      renderSelectionPanel(); // refresh the input fields with new values
      renderHandles();        // re-render so the pivot marker shows
      return;
    }

    // v0.8.197: text-offset placement. The next canvas click becomes
    // the text anchor for the target master; offset is stored as a
    // delta from the line's natural center so the text travels with
    // its object when the object's position changes (same model as
    // rotate-origin per-line deltas).
    if (settingTextOffset) {
      const pt = eventPt(e);
      const x = Math.round(pt.x * 10) / 10;
      const y = Math.round(pt.y * 10) / 10;
      const masterRec = state.masters.find(function (m) {
        return m.id === settingTextOffset.masterId;
      });
      const ln = state.lines.find(function (l) {
        return l.id === settingTextOffset.lineId;
      });
      if (masterRec && ln) {
        // Ensure the text record exists before writing offsets — a
        // user could in theory hit this mode through a stale UI state
        // where master.text was wiped between render and click.
        if (!masterRec.text || typeof masterRec.text !== 'object') {
          masterRec.text = Object.assign({}, TEXT_DEFAULTS);
        }
        // v0.8.212: must use lineCenterFor — the same anchor the
        // renderer uses at draw time — not centerOf. Previously click-
        // set used centerOf (middle vertex of the points array for
        // free-form lines), while the renderer anchors text at the
        // SVG bbox center. For primitives the two agree, but for a
        // drawing whose middle vertex is far from the bbox center
        // (curvy / asymmetric path), the text landed 50–100 px off
        // the click point. Looking up the rendered SVG element by
        // data-line-id gives the renderer its own bbox-based center.
        const svgEl = linesG.querySelector('[data-line-id="' + ln.id + '"]');
        const c = lineCenterFor(ln, svgEl);
        const dx = c ? Math.round((x - c.x) * 10) / 10 : x;
        const dy = c ? Math.round((y - c.y) * 10) / 10 : y;
        masterRec.text.offsetX = dx;
        masterRec.text.offsetY = dy;
        // Mirror master.text onto every resolved line in case any
        // sibling instance was loaded before master.text existed
        // (resolveInstanceJS only aliases the field when it's present
        // at load time).
        state.pageConfig.useClasses.forEach(function (cid) {
          const lns = (state.byClass[cid] && state.byClass[cid].lines) || [];
          lns.forEach(function (l) {
            if (l.masterId === masterRec.id) l.text = masterRec.text;
          });
        });
        state.dirty = true;
        scheduleSnapshot();
      }
      exitSetTextOffset();
      renderLines();
      renderSelectionPanel();
      return;
    }

    svg.setPointerCapture(e.pointerId);
    pointerActive = true;
    downClient = { x: e.clientX, y: e.clientY };
    downTarget = e.target;

    // If the user pressed inside any selected object's hit area, and
    // no modifier is held, this drag is going to translate every
    // selected object in lockstep. The drawing tool's pointerDown is
    // skipped entirely. Modifier-press defers to pointerup so it can
    // be interpreted as a toggle-click instead of a move.
    // v0.8.49: check EVERY line under the cursor, not just the
    // topmost — `e.target.closest('[data-line-id]')` returns the
    // visually-topmost path, so if a non-selected object overlapped
    // the selected one at the click point, the drag silently
    // refused to start. elementsFromPoint walks the whole stack.
    // v0.8.50: when the cursor isn't over any currently-selected
    // line but IS over an unselected one, implicitly click-to-
    // select the topmost line (Illustrator / Figma convention),
    // then arm the drag — turns drag-on-a-line into one gesture
    // that selects + moves instead of requiring a separate click
    // first. If the cursor is over genuine empty canvas (no lines
    // anywhere in the stack), behavior is unchanged: drag doesn't
    // arm, pointerup falls through to the regular selection cycle.
    const linesAtPoint = (document.elementsFromPoint(e.clientX, e.clientY) || [])
      .filter(function (el) { return el && el.dataset && el.dataset.lineId; })
      .map(function (el) { return el.dataset.lineId; });
    const pressedSelected = linesAtPoint.some(function (id) { return isSelected(id); });
    // v0.8.146: altKey included so opt-click on an unselected object
    // doesn't trigger the implicit-select path here in pointerdown.
    // Without this, selectOnly(B) fires in pointerdown, making
    // isObjectPanelOpenFor(B) return true by the time pointerup runs,
    // which causes the panel-toggle logic to close the panel instead of
    // rebinding it. Alt-click selection is handled entirely in pointerup.
    const modifier = e.metaKey || e.ctrlKey || e.shiftKey || e.altKey;
    let armMove = false;
    // v0.8.229: only the Select tool intercepts a press on an existing
    // object as a select / move gesture. When a drawing tool is active
    // (rect, textBlock, image, freehand, …), a press that lands on an
    // existing object must still start the new drawing — otherwise users
    // can't draw a new object whose top-left corner falls on top of an
    // existing one, which is a perfectly normal layout situation.
    const toolIsDrawing = state.activeToolId && state.activeToolId !== 'select';
    if (!modifier && !toolIsDrawing) {
      if (pressedSelected) {
        armMove = true;
        // v0.8.123/124: removed the inline panel auto-open.
        // Opening the follower panel is now an explicit opt-click
        // gesture handled at pointerup. Plain click on a selected
        // object just arms drag-to-move (no panel side effect).
      } else if (linesAtPoint.length) {
        // Implicit click → select the topmost line at the cursor.
        // Mirror the sidebar-click side-effects so the editor's
        // state is consistent: open + activate the target's group,
        // update the sidebar anchor, reset click-cycle so a
        // subsequent same-spot click cycles to the next stacked
        // line as usual.
        const topId = linesAtPoint[0];
        selectOnly(topId);
        const sel = state.lines.find(function (l) { return l.id === topId; });
        if (sel && sel.groupId) {
          state.openGroupIds[sel.groupId] = true;
          state.activeGroupId = sel.groupId;
          sidebarAnchorLineId  = sel.id;
          sidebarAnchorGroupId = sel.groupId;
        }
        clickCycle = null;
        updateSelectAllButton();
        renderGroupsList();
        renderLines();
        renderSelectionPanel({ suppressScroll: true });
        armMove = true;
      }
    }
    if (armMove) {
      moveSel = {
        startPt: eventPt(e),
        origLines: state.selectedIds.map(function (id) {
          const l = state.lines.find(function (x) { return x.id === id; });
          if (!l) return null;
          return {
            id: l.id,
            origPoints:   Array.isArray(l.points)
              ? l.points.map(function (p) { return { x: p.x, y: p.y }; })
              : null,
            origSegments: Array.isArray(l.segments)
              ? l.segments.map(function (s) {
                  return {
                    cmd: s.cmd,
                    controlPoints: s.controlPoints.map(function (cp) { return { x: cp.x, y: cp.y }; }),
                    endpoint: s.endpoint ? { x: s.endpoint.x, y: s.endpoint.y } : null
                  };
                })
              : null,
            origParams:    l.params    ? Object.assign({}, l.params)    : null,
            origOverrides: l.overrides ? Object.assign({}, l.overrides) : null,
            // Snapshot the offset at drag-start so translateLine can
            // compute the new total as orig + cumulative-dx (pointermove
            // delivers cumulative dx/dy, not increments).
            origOffset: l.positionOffset
              ? { dx: l.positionOffset.dx || 0, dy: l.positionOffset.dy || 0 }
              : { dx: 0, dy: 0 }
          };
        }).filter(function (s) { return s; }),
        // In 'all' mode, the same drag delta also applies to every
        // sibling-class instance of the masters being dragged. Snapshot
        // their pre-drag state here so pointermove can translate each
        // by the cumulative dx/dy alongside the current-class lines.
        // 'one' mode leaves this empty — siblings stay put.
        origSiblings: []
      };
      if (modeIsAll()) {
        const masterIds = {};
        moveSel.origLines.forEach(function (snap) {
          const l = state.lines.find(function (x) { return x.id === snap.id; });
          if (l && l.masterId) masterIds[l.masterId] = true;
        });
        Object.keys(masterIds).forEach(function (mid) {
          forSiblingsOf(mid, function (sib, cid) {
            moveSel.origSiblings.push({
              classId: cid,
              lineId:  sib.id,
              origPoints: Array.isArray(sib.points)
                ? sib.points.map(function (p) { return { x: p.x, y: p.y }; })
                : null,
              origSegments: Array.isArray(sib.segments)
                ? sib.segments.map(function (s) {
                    return {
                      cmd: s.cmd,
                      controlPoints: s.controlPoints.map(function (cp) { return { x: cp.x, y: cp.y }; }),
                      endpoint: s.endpoint ? { x: s.endpoint.x, y: s.endpoint.y } : null
                    };
                  })
                : null,
              origParams:    sib.params    ? Object.assign({}, sib.params)    : null,
              origOverrides: sib.overrides ? Object.assign({}, sib.overrides) : null,
              origOffset: sib.positionOffset
                ? { dx: sib.positionOffset.dx || 0, dy: sib.positionOffset.dy || 0 }
                : { dx: 0, dy: 0 }
            });
          });
        });
      }
      return; // skip tool dispatch
    }

    const tool = TOOLS[state.activeToolId];
    if (tool && tool.onPointerDown) tool.onPointerDown(eventPt(e));
  });
  svg.addEventListener('pointermove', function (e) {
    if (moveSel) {
      const cur = eventPt(e);
      const dx = cur.x - moveSel.startPt.x;
      const dy = cur.y - moveSel.startPt.y;
      moveSel.origLines.forEach(function (snap) {
        const line = state.lines.find(function (l) { return l.id === snap.id; });
        if (!line) return;
        translateLine(line, snap.origPoints, snap.origSegments, snap.origParams, snap.origOverrides, snap.origOffset, dx, dy);
        // Update every DOM element bound to this line. Paths take the
        // new `d`; <image> elements need x/y/width/height instead (no
        // d attribute), so the bbox path AND the bitmap track the
        // drag in lockstep. Without this branch, paths moved and the
        // image stayed put until pointer-up triggered a full
        // renderLines.
        linesG.querySelectorAll('[data-line-id="' + line.id + '"]')
          .forEach(function (el) {
            if (el.tagName.toLowerCase() === 'image') {
              el.setAttribute('x', line.params.x);
              el.setAttribute('y', line.params.y);
              el.setAttribute('width',  line.params.w);
              el.setAttribute('height', line.params.h);
            } else {
              el.setAttribute('d', line.d);
            }
          });
        syncTextOverlayPosition(line);
      });
      // In 'all' mode, mirror the same Δ onto every sibling-class
      // instance of the dragged masters. No DOM updates needed
      // (siblings aren't on this class's canvas), just state.
      if (moveSel.origSiblings && moveSel.origSiblings.length) {
        moveSel.origSiblings.forEach(function (snap) {
          const bucket = state.byClass[snap.classId];
          if (!bucket) return;
          const sib = bucket.lines.find(function (l) { return l.id === snap.lineId; });
          if (!sib) return;
          translateLine(sib, snap.origPoints, snap.origSegments, snap.origParams,
                        snap.origOverrides, snap.origOffset, dx, dy);
        });
      }
      state.dirty = true;
      renderHandles(); // accent dots / single-line handles follow their lines
      renderLabels();  // labels follow their lines too
      return;
    }
    const tool = TOOLS[state.activeToolId];
    if (!tool) return;
    // Chain and Bezier are multi-click tools — their preview needs to
    // track the cursor between clicks (no button held). Other tools
    // only care about pointermove while a drag is active.
    if (state.activeToolId === 'lineChain' || state.activeToolId === 'bezier') {
      if (tool.onPointerMove) tool.onPointerMove(eventPt(e));
      return;
    }
    if (!pointerActive) return;
    if (tool.onPointerMove) tool.onPointerMove(eventPt(e));
  });
  svg.addEventListener('pointerup', function (e) {
    pointerActive = false;
    // If the user pressed inside a selected object's hit area and then
    // actually dragged, commit the (single- or multi-line) move. A
    // pure click (no drag) falls through to the selection-cycle path
    // below so the user can step down to a shape covered by the
    // current one — or cycle through siblings within a multi-select.
    let wasMoveSel = false;
    if (moveSel) {
      wasMoveSel = true;
      const dxMove = downClient ? (e.clientX - downClient.x) : 0;
      const dyMove = downClient ? (e.clientY - downClient.y) : 0;
      const dragged = (dxMove * dxMove + dyMove * dyMove) > 9; // ~3px slop
      moveSel = null;
      if (dragged) {
        snapshot();
        // Panel inputs (Center X/Y, X/Y, etc.) were rendered with the
        // pre-drag values — refresh so the panel agrees with where the
        // dragged objects landed.
        renderSelectionPanel();
        downClient = null;
        downTarget = null;
        return;
      }
      // else: fall through to selection logic (don't dispatch to a
      // drawing tool's onPointerUp since pointerDown was bypassed).
    }
    if (!wasMoveSel) {
      const tool = TOOLS[state.activeToolId];
      if (tool && tool.onPointerUp) tool.onPointerUp(eventPt(e));
    }

    // Click vs drag detection. Threshold is in client (viewport) pixels.
    if (downClient) {
      const dx = e.clientX - downClient.x;
      const dy = e.clientY - downClient.y;
      const dragged = (dx * dx + dy * dy) > 9;  // ~3px slop
      // Multi-click tools (chain, bezier) consume bare clicks as anchor
      // additions, so we don't also treat them as selection clicks.
      const mid = (state.activeToolId === 'lineChain' && state.chainPoints) ||
                  (state.activeToolId === 'bezier'    && state.bezierPoints);
      if (!dragged && !mid) {
        // Find every line whose hit-target sits under the click point
        // (top-to-bottom z-order). Lets us cycle through overlapping
        // lines on repeat clicks.
        const ids = document.elementsFromPoint(downClient.x, downClient.y)
          .filter(function (el) { return el && el.dataset && el.dataset.lineId; })
          .map(function (el) { return el.dataset.lineId; });
        // v0.8.124: modifier roles, corrected from v0.8.123:
        //   - shift / cmd / ctrl → multi-select extend (standard)
        //   - alt (opt)          → panel toggle for the hit object
        //   - plain click        → pure selection cycle, NO panel
        //                          side effects (drag, shift-extend,
        //                          and click-cycle all stay clean)
        // The "re-click opens a closed panel" gesture from v0.8.123
        // was dropped — too implicit to discover, and conflicts with
        // the natural "click around to navigate selection" rhythm.
        // The follower panel is now strictly opt-click summoned.
        const alt   = e.altKey;
        const multi = (e.shiftKey || e.metaKey || e.ctrlKey) && !alt;

        let changed = false;
        // v0.8.124: panel toggle is fired immediately on the
        // pointerup that recognized opt-click — no rAF, no setTimeout.
        // v0.8.125: track the hit id so the toggle can match panels
        // by objectId (including pinned ones), not just look for the
        // global unpinned follower.
        let togglePanelFor = null;
        let openPanelAfterRender = false;
        if (alt) {
          // Opt-click on an object: select it + open/close its panel.
          // Opt-click on empty canvas: deselect + close unpinned panel.
          // v0.8.144: snapshot panel intent BEFORE any selection change
          // to avoid the rebind-then-misread problem (same fix as the
          // sidebar ⊞ button in v0.8.141).
          clickCycle = null;
          if (ids.length) {
            // v0.8.211: when several objects are stacked at the click
            // point, prefer one that's already selected — opt-click is
            // "open the panel for THIS object", not "switch to topmost
            // and open it". Previously a user who'd cycled selection
            // to a lower-z object and then opt-clicked saw the topmost
            // sibling steal the selection. Fall back to ids[0] only
            // when none of the stacked hits is currently selected.
            const preselected = ids.find(function (id) { return isSelected(id); });
            const hit = preselected || ids[0];
            // Capture whether a panel is already explicitly open for
            // this object before we change the selection.
            const panelAlreadyOpen = isObjectPanelOpenFor(hit);
            if (!isSelected(hit)) {
              selectOnly(hit);
              const sel = state.lines.find(function (l) { return l.id === hit; });
              if (sel && sel.groupId) {
                state.openGroupIds[sel.groupId] = true;
                state.activeGroupId = sel.groupId;
              }
              changed = true;
            }
            if (panelAlreadyOpen) {
              // Panel was showing this object — toggle it off.
              togglePanelFor = hit;
            } else {
              // No panel was explicitly open for this object.
              // If an unpinned follower already exists, it will rebind
              // to the new selection automatically via notifyDataChanged
              // in renderSelectionPanel — no close/reopen needed.
              // Only open a fresh panel if no follower exists at all.
              const hasFollower = window.PanelManager &&
                window.PanelManager.listOpen().some(function (p) {
                  return p.type === 'object' && !p.pinned;
                });
              if (!hasFollower) openPanelAfterRender = true;
            }
          } else {
            // v0.8.144: empty-canvas opt-click — deselect (same as
            // plain click) AND close any unpinned object panel.
            const before = state.selectedIds.slice();
            clearSelection();
            changed = before.length > 0;
            clickCycle = null;
            if (window.PanelManager) {
              window.PanelManager.listOpen()
                .filter(function (p) { return p.type === 'object' && !p.pinned; })
                .forEach(function (p) {
                  try { window.PanelManager.close(p.id); } catch (ex) {}
                });
            }
          }
        } else if (multi) {
          // Shift/Cmd/Ctrl-click toggles the topmost hit object in/
          // out of the selection (multi-select extend). Empty-area
          // multi-click is a no-op (don't accidentally deselect when
          // the user just missed a target). Cycle state is reset.
          clickCycle = null;
          if (ids.length) {
            const hit = ids[0];
            toggleInSelection(hit);
            const sel = state.lines.find(function (l) { return l.id === hit; });
            if (sel && sel.groupId) {
              state.openGroupIds[sel.groupId] = true;
              state.activeGroupId = sel.groupId;
            }
            changed = true;
          }
        } else {
          // Plain click: replace selection with one cycled-to id, or
          // clear it if the click hit empty canvas. NO panel side
          // effects — opt-click is the gesture for that.
          let newSelection = null;
          if (ids.length) {
            const sameZone = clickCycle &&
              Math.abs(downClient.x - clickCycle.x) < 5 &&
              Math.abs(downClient.y - clickCycle.y) < 5 &&
              arraysEqual(clickCycle.ids, ids);
            if (sameZone) {
              clickCycle.idx = (clickCycle.idx + 1) % ids.length;
            } else {
              clickCycle = { x: downClient.x, y: downClient.y, ids: ids, idx: 0 };
            }
            newSelection = ids[clickCycle.idx];
          } else {
            clickCycle = null;
          }
          const before = state.selectedIds.slice();
          selectOnly(newSelection);
          if (newSelection) {
            const sel = state.lines.find(function (l) { return l.id === newSelection; });
            if (sel && sel.groupId) {
              state.openGroupIds[sel.groupId] = true;
              state.activeGroupId = sel.groupId;
            }
          }
          changed = !arraysEqual(before, state.selectedIds);
        }

        if (changed) {
          updateSelectAllButton();
          renderGroupsList();
          renderLines();
          // v0.8.27: modifier-click is a multi-select gesture — skip
          // the scroll-into-view that normally lands on the per-line
          // panel for a fresh single-selection. Plain click keeps the
          // scroll so "click an object, see its properties" still
          // works.
          renderSelectionPanel((multi || alt) ? { suppressScroll: true } : undefined);
        }
        // Fire panel actions AFTER any selection render so the panel
        // sees the post-click selection state. close() doesn't depend
        // on selection, so order is fine for that branch too.
        if (togglePanelFor) toggleObjectPanelFor(togglePanelFor);
        if (openPanelAfterRender && window.PanelManager) {
          try { window.PanelManager.open('object'); } catch (ex) { console.error(ex); }
        }
      }
    }
    downClient = null;
    downTarget = null;
  });
  svg.addEventListener('dblclick', function (e) {
    const tool = TOOLS[state.activeToolId];
    if (tool && tool.finish) { e.preventDefault(); tool.finish(); }
  });

  window.addEventListener('keydown', function (e) {
    // Undo / Redo — works even inside inputs, just like every text app.
    if ((e.metaKey || e.ctrlKey) && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault();
      if (e.shiftKey) redo(); else undo();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && (e.key === 'y' || e.key === 'Y')) {
      e.preventDefault();
      redo();
      return;
    }
    // Save — Cmd/Ctrl+S works everywhere (overrides the browser's
    // save-page-as), plain S works outside text inputs.
    if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S')) {
      e.preventDefault();
      save();
      return;
    }
    if (e.target && /^(input|textarea|select)$/i.test(e.target.tagName)) return;
    if (e.key === 's' || e.key === 'S') {
      e.preventDefault();
      save();
      return;
    }
    // v0.8.99: Arrow keys nudge the current selection by state.nudgeStepMM
    // (Shift = ×10). Honored even with Shift held (modifier check below
    // would otherwise swallow Shift+Arrow). Cmd/Ctrl/Alt+Arrow stay free
    // for native browser behavior. ALL-mode fan-out is inside
    // nudgeSelectionBy.
    if (state.selectedIds.length &&
        (e.key === 'ArrowUp' || e.key === 'ArrowDown' ||
         e.key === 'ArrowLeft' || e.key === 'ArrowRight') &&
        !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      const step = (state.nudgeStepMM || 1) * (e.shiftKey ? 10 : 1);
      let dx = 0, dy = 0;
      if (e.key === 'ArrowUp')    dy = -step;
      if (e.key === 'ArrowDown')  dy =  step;
      if (e.key === 'ArrowLeft')  dx = -step;
      if (e.key === 'ArrowRight') dx =  step;
      nudgeSelectionBy(dx, dy);
      return;
    }
    // v0.8.148: Option/Alt+Arrow — scroll canvas AND shift all open
    // floating panels in lockstep. Lets the user temporarily bring
    // intentionally off-screen panels into view without touching them
    // individually, then Option-arrow back to restore their position.
    //
    // Direction: scrollBy(+dx) moves canvas content LEFT in viewport;
    // shiftAllPanels(-dx) moves panel CSS `left` in the same leftward
    // direction, so both canvas content and panels travel together.
    // Must sit before the altKey guard below.
    if (e.altKey &&
        (e.key === 'ArrowUp' || e.key === 'ArrowDown' ||
         e.key === 'ArrowLeft' || e.key === 'ArrowRight') &&
        !e.metaKey && !e.ctrlKey && !e.shiftKey) {
      e.preventDefault();
      const PAN_STEP = 80;
      let pdx = 0, pdy = 0;
      if (e.key === 'ArrowLeft')  pdx = -PAN_STEP;
      if (e.key === 'ArrowRight') pdx =  PAN_STEP;
      if (e.key === 'ArrowUp')    pdy = -PAN_STEP;
      if (e.key === 'ArrowDown')  pdy =  PAN_STEP;
      canvasWrap.scrollBy(pdx, pdy);
      // Negate panel delta: scrollBy(+dx) slides content left, so
      // panels must also go left → shiftAllPanels(-dx).
      if (window.PanelManager) window.PanelManager.shiftAllPanels(-pdx, -pdy);
      return;
    }
    // Plain Arrow with no selection — explicitly scroll canvasWrap so
    // arrow keys work immediately after page load without requiring a
    // click to focus the canvas first. (Browser-native scroll requires
    // canvasWrap to have DOM focus; this bypasses that dependency.)
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown' ||
         e.key === 'ArrowLeft' || e.key === 'ArrowRight') &&
        !state.selectedIds.length &&
        !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      const SCROLL_STEP = 80;
      let sdx = 0, sdy = 0;
      if (e.key === 'ArrowLeft')  sdx = -SCROLL_STEP;
      if (e.key === 'ArrowRight') sdx =  SCROLL_STEP;
      if (e.key === 'ArrowUp')    sdy = -SCROLL_STEP;
      if (e.key === 'ArrowDown')  sdy =  SCROLL_STEP;
      canvasWrap.scrollBy(sdx, sdy);
      return;
    }
    // Skip remaining view shortcuts when a modifier is held — let
    // the browser handle Cmd+anything-else natively.
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'Escape') {
      // Escape cancels the set-rotate-origin gesture before anything
      // else, since it's the most "active" mode the user can be in.
      if (settingOrigin) { exitSetRotateOrigin(); return; }
      // v0.8.197: same Escape semantics for the text-offset set
      // gesture. Wired before the wizard / tool / selection cascade
      // so an in-progress "click anywhere" never leaks into other
      // Escape handlers.
      if (settingTextOffset) { exitSetTextOffset(); return; }
      // Wizard takes priority next — if the user has begun a create
      // flow (with or without a drawn draft), Esc tears it down.
      if (state.wizard) { cancelWizard(); return; }
      const tool = TOOLS[state.activeToolId];
      if (tool && tool.cancel) tool.cancel();
      clearSelection();
      updateSelectAllButton();
      renderAll();
      return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (state.selectedIds.length) { e.preventDefault(); deleteSelected(); return; }
      // No lines selected → if a group is active (group panel showing),
      // Backspace deletes the group (with the same confirm dialog as
      // the panel + sidebar buttons). Same shortcut, parallel meaning.
      if (state.activeGroupId) {
        const g = state.groups.find(function (x) { return x.id === state.activeGroupId; });
        if (g) { e.preventDefault(); confirmAndDeleteGroup(g); }
      }
      return;
    }
    // (Drawing-tool shortcuts removed — tools are now reached only
    // via the Create-object wizard, so single-key activations no
    // longer match the UI surface.)
    // Zoom shortcuts
    if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomIn();  }
    if (e.key === '-' || e.key === '_') { e.preventDefault(); zoomOut(); }
    if (e.key === '0')                  { e.preventDefault(); zoomReset(); }
  });

  // Warn before navigating away with unsaved changes.
  window.addEventListener('beforeunload', function (e) {
    if (state.dirty) { e.preventDefault(); e.returnValue = ''; }
  });

  // Initial render. Snapshot the loaded state so the user always has
  // at least one history entry (and can't undo into emptiness).
  applyPageConfig();    // paints viewBox, page rect, bg, grids from state.page
  renderCanvasPanel();  // sidebar inputs for pageW/H + canvasW/H
  setActiveTool('select');
  snapshot();
  renderAll();
  centerOnPage();

  // v0.8.33 DIAGNOSTIC: init banner so we can tell from the console
  // alone whether the new build is loaded. Also wires two globals
  // that dump line / master state so the user can inspect the data
  // mid-bug without us having to ship more rounds of console.log.
  // v0.8.46: also surface load-issue counts and (if any) mount a
  // sticky banner at the top of the sidebar pointing at Find orphans.
  console.log('[editor v0.8.46 loaded] state.classId=' + state.classId
    + ' mode=' + state.mode
    + ' loadIssues.missingMasters=' + loadIssues.missingMasters.length);
  if (loadIssues.missingMasters.length) {
    const banner = document.createElement('div');
    banner.className = 'ed-load-banner';
    const msg = document.createElement('span');
    msg.innerHTML = '<strong>' + loadIssues.missingMasters.length
      + ' instance' + (loadIssues.missingMasters.length === 1 ? '' : 's')
      + '</strong> reference missing master records — they will not render.';
    banner.appendChild(msg);
    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'ed-mini';
    openBtn.textContent = 'Open Find orphans';
    openBtn.addEventListener('click', function () { showOrphansDialog(); });
    banner.appendChild(openBtn);
    const dismissBtn = document.createElement('button');
    dismissBtn.type = 'button';
    dismissBtn.className = 'ed-load-banner-dismiss';
    dismissBtn.textContent = '×';
    dismissBtn.title = 'Dismiss (the issue stays until you fix it)';
    dismissBtn.addEventListener('click', function () { banner.remove(); });
    banner.appendChild(dismissBtn);
    const sidebar = document.querySelector('.ed-sidebar');
    if (sidebar) sidebar.insertBefore(banner, sidebar.firstChild);
  }

  function _dumpLineFor(line, cid) {
    if (!line) return null;
    return {
      class:        cid,
      id:           line.id,
      name:         line.name,
      masterId:     line.masterId,
      groupId:      line.groupId,
      stroke:       line.stroke,
      width:        line.width,
      behaviorsLen: Array.isArray(line.behaviors) ? line.behaviors.length : -1,
      behaviorIds:  Array.isArray(line.behaviors)
        ? line.behaviors.map(function (b) { return b.id; }) : null,
      paramKeys:    line.params    ? Object.keys(line.params)    : null,
      overrideKeys: line.overrides ? Object.keys(line.overrides) : null,
      hidden:       !!line.hidden
    };
  }
  // Search across every class for lines matching `q` (by name or id
  // substring). Also returns the master record if any of the matches
  // share a masterId. Use in the browser console:
  //   _dumpLine('blob 1')          → finds by name OR id
  //   _dumpLine('m-abc1234')       → finds by masterId
  window._dumpLine = function (q) {
    if (!q) { console.log('usage: _dumpLine(nameOrId)'); return; }
    const matches = [];
    const masterIdsSeen = {};
    Object.keys(state.byClass).forEach(function (cid) {
      const bucket = state.byClass[cid];
      if (!bucket || !Array.isArray(bucket.lines)) return;
      bucket.lines.forEach(function (line) {
        const hit = (line.id && line.id.indexOf(q) !== -1)
                 || (line.name && line.name.toLowerCase().indexOf(String(q).toLowerCase()) !== -1)
                 || (line.masterId && line.masterId.indexOf(q) !== -1);
        if (!hit) return;
        matches.push(_dumpLineFor(line, cid));
        if (line.masterId) masterIdsSeen[line.masterId] = true;
      });
    });
    const masters = Object.keys(masterIdsSeen).map(function (mid) {
      const m = state.masters.find(function (x) { return x.id === mid; });
      if (!m) return { id: mid, missing: true };
      return {
        id: m.id, name: m.name, kind: m.kind, stroke: m.stroke,
        width: m.width, paramKeys: m.params ? Object.keys(m.params) : null,
        scopeKeys: m.scope ? Object.keys(m.scope) : null
      };
    });
    const out = { matches: matches, masters: masters };
    console.log('[_dumpLine]', JSON.stringify(out, null, 2));
    return out;
  };
  // Dumps the complete behavior-block list for every line across
  // every class. Use after a suspect drag to compare blob 1's
  // behavior IDs in WIDE vs MEDIUM vs NARROW.
  window._dumpAllBlocks = function () {
    const out = {};
    Object.keys(state.byClass).forEach(function (cid) {
      const bucket = state.byClass[cid];
      if (!bucket || !Array.isArray(bucket.lines)) return;
      out[cid] = bucket.lines.map(function (line) {
        return {
          id: line.id, name: line.name, masterId: line.masterId,
          groupId: line.groupId,
          behaviorIds: Array.isArray(line.behaviors)
            ? line.behaviors.map(function (b) { return b.id; }) : null
        };
      });
    });
    console.log('[_dumpAllBlocks]', JSON.stringify(out, null, 2));
    return out;
  };

  // =========================================================
  // v0.8.110 — Floating-panel system (Step 1: infra only)
  // ---------------------------------------------------------
  // Goal: give the editor a fleet of free-floating, draggable,
  // non-modal panels that can be opened on demand and reused
  // for the side-panel migration in later steps. Step 1 ships
  // ONLY the framework + a stub 'demo' panel. No existing UI
  // moves yet — we validate drag/resize/pin/close/persist
  // end-to-end before any user-visible migration.
  //
  // Concepts:
  //   - PANEL_REGISTRY: { type → { title, defaultSize, defaultPos,
  //                                followsSelection?, render(host, ctx) } }
  //   - Per-panel state: { id, type, objectId?, pinned, x, y, w, h, z }
  //   - Persistence: localStorage key per (pageId, classId). Panel
  //     positions, sizes, and pinned-object bindings survive reload.
  //   - notifySelection(ids): unpinned panels that followSelection
  //     re-render against the new selection; pinned panels ignore it.
  //   - Z-stack: clicking any panel header bumps it to top.
  // =========================================================

  const PANEL_REGISTRY = {
    // v0.8.112: real 'object' panel. Replaces the sidebar selection
    // slot for single-select. Reuses renderLinePanel (refactored to
    // accept a host) so behavior, validation, and the field set
    // stay exactly identical to today — the floating shell is the
    // only thing that changed. Subsequent sub-steps (2b/2c) carve
    // out behaviors into a dedicated child panel; for now it's the
    // full line panel content lifted as-is.
    object: {
      title: 'Object',
      defaultSize: { w: 380, h: 560 },
      defaultPos:  { x: 320, y: 90 },
      followsSelection: true,
      render: function (body, ctx) {
        if (!ctx.primaryLine) {
          const msg = document.createElement('p');
          msg.style.color = '#888';
          msg.style.fontSize = '0.9em';
          msg.textContent = ctx.panelState.pinned
            ? 'Pinned object not found in any class.'
            : 'Select an object to edit its properties.';
          body.appendChild(msg);
          return;
        }
        // Pass the panel body as the host AND the panel state so
        // nested affordances (block-list rows) know which panel
        // owns them — block-detail children carry parentId.
        renderLinePanel(ctx.primaryLine, body, ctx.panelState);
      }
    },
    // v0.8.113: block-detail panel. Opens to the right of its
    // parent object panel when a block-name row is clicked; closes
    // with the parent or when the parent re-binds. Bound by
    // blockId (not index), so reorders don't strand it.
    'behavior-block': {
      title: 'Block',
      defaultSize: { w: 380, h: 600 },
      defaultPos:  { x: 720, y: 90 },
      followsSelection: false,
      render: function (body, ctx) {
        function msg(text) {
          const p = document.createElement('p');
          p.style.color = '#888'; p.style.fontSize = '0.9em';
          p.textContent = text;
          return p;
        }
        const line = ctx.primaryLine;
        if (!line) { body.appendChild(msg('Parent object not found.')); return; }
        const blocks = Array.isArray(line.behaviors) ? line.behaviors : [];
        const idx = blocks.findIndex(function (b) {
          return b && b.id === ctx.panelState.blockId;
        });
        if (idx < 0) {
          body.appendChild(msg(
            'This block no longer exists (was it deleted?). Close the panel and pick another.'
          ));
          return;
        }
        const group = state.groups.find(function (g) { return g.id === line.groupId; });
        // v0.8.129: update the panel chrome title to "Block N/M · name"
        // so the panel stays self-describing even when pinned alone
        // after the parent object panel is closed.
        const frame = body.closest('.ed-floating-panel');
        if (frame) {
          const titleEl = frame.querySelector('.ed-floating-panel-title');
          if (titleEl) {
            const objName = line.name || String(line.id).slice(0, 8);
            titleEl.textContent = 'Block ' + (idx + 1) + '/' + blocks.length + ' · ' + objName;
          }
        }
        body.appendChild(renderBehaviorBlock(line, idx, group, ctx.panelState));
      }
    },
    // Stub demo panel used to validate the system. Subsequent
    // steps register real panels (Behaviors, Parameters, ...).
    demo: {
      title: 'Demo panel',
      defaultSize: { w: 320, h: 220 },
      defaultPos:  { x: 120, y: 120 },
      followsSelection: true,
      render: function (bodyEl, ctx) {
        // ctx: { panelState, primarySelectionId, primaryLine, allSelectedIds }
        const wrap = document.createElement('div');
        wrap.style.fontFamily = 'ui-monospace, monospace';
        wrap.style.fontSize = '0.85em';
        wrap.style.lineHeight = '1.5';
        const sel = ctx.allSelectedIds || [];
        const primary = ctx.primaryLine;
        const lines = [
          'pageId:  ' + state.pageId,
          'classId: ' + state.classId,
          'mode:    ' + state.mode,
          'selected: ' + sel.length + (sel.length ? ' [' + sel.join(', ') + ']' : ''),
          ctx.panelState.objectId
            ? '📌 pinned to: ' + ctx.panelState.objectId
            : 'follows current selection'
        ];
        if (primary) {
          lines.push('—');
          lines.push('name:   ' + (primary.name || '(unnamed)'));
          lines.push('master: ' + (primary.masterId || '(none)'));
          lines.push('group:  ' + (primary.groupId || '(none)'));
        }
        wrap.textContent = lines.join('\n');
        wrap.style.whiteSpace = 'pre';
        bodyEl.appendChild(wrap);
      }
    }
  };

  const PanelManager = (function () {
    const hostEl = document.getElementById('panel-host');
    // panelId → { state, frameEl, bodyEl, headerEl, titleEl, subEl, pinBtn }
    const panels = {};
    let zCounter = 1000;
    let nextId   = 1;

    function storageKey() {
      return 'ed-panels-' + state.pageId + '-' + state.classId;
    }
    // v0.8.117: "last seen" geometry per panel type (per page/class).
    // When a panel is closed and later reopened — for the same or a
    // different object — restore the user's last position+size so it
    // reappears where they put it, not at the registry default. Only
    // tracked for parent-less panels (hard-sticked children derive
    // their position from the parent).
    function lastPosKey() {
      return 'ed-panel-lastpos-' + state.pageId + '-' + state.classId;
    }
    function loadLastPos() {
      try {
        const raw = localStorage.getItem(lastPosKey());
        if (!raw) return {};
        const obj = JSON.parse(raw);
        return (obj && typeof obj === 'object') ? obj : {};
      } catch (e) { return {}; }
    }
    function rememberLastPos(type, geom) {
      try {
        const all = loadLastPos();
        all[type] = { x: geom.x, y: geom.y, w: geom.w, h: geom.h };
        localStorage.setItem(lastPosKey(), JSON.stringify(all));
      } catch (e) { /* ignore */ }
    }

    function persist() {
      try {
        const snapshot = Object.keys(panels).map(function (pid) {
          const p = panels[pid].state;
          return {
            id: p.id, type: p.type,
            objectId: p.objectId || null,
            // v0.8.113: blockId (stable, not index) for 'behavior-block'
            // panels. parentId chains child panels to their owner so
            // close cascades and per-object lifetime work cleanly.
            blockId:  p.blockId  || null,
            parentId: p.parentId || null,
            pinned: !!p.pinned, x: p.x, y: p.y, w: p.w, h: p.h, z: p.z,
            // v0.8.121: persist userPositioned so the lastPos memory
            // gate survives a reload. Without this, a user-positioned
            // panel restored from snapshot would close as
            // auto-positioned and skip the rememberLastPos call.
            userPositioned: !!p.userPositioned
          };
        });
        localStorage.setItem(storageKey(), JSON.stringify(snapshot));
      } catch (e) { /* private mode / quota — ignore */ }
    }

    function loadPersisted() {
      try {
        const raw = localStorage.getItem(storageKey());
        if (!raw) return [];
        const arr = JSON.parse(raw);
        return Array.isArray(arr) ? arr : [];
      } catch (e) { return []; }
    }

    // Clamp a position so the title bar always remains visible
    // (≥ 40px of header inside viewport on each side). Panels
    // dragged off-screen would otherwise become unreachable.
    function clampPos(x, y, w) {
      const vw = window.innerWidth, vh = window.innerHeight;
      const minX = 40 - w, maxX = vw - 40;
      const minY = 0,      maxY = vh - 28;
      return {
        x: Math.max(minX, Math.min(maxX, x)),
        y: Math.max(minY, Math.min(maxY, y))
      };
    }

    function bringToFront(panelId) {
      const p = panels[panelId]; if (!p) return;
      p.state.z = ++zCounter;
      p.frameEl.style.zIndex = String(p.state.z);
      persist();
    }

    function buildFrame(panelState) {
      const reg = PANEL_REGISTRY[panelState.type];
      const frame = document.createElement('div');
      frame.className = 'ed-floating-panel'
        + (panelState.pinned ? ' is-pinned' : '')
        // v0.8.114: child block panels get a distinct outline so
        // they read as "owned by an object panel" rather than as
        // another peer-level object panel.
        + (panelState.type === 'behavior-block' ? ' ed-floating-panel--block' : '');
      frame.style.left   = panelState.x + 'px';
      frame.style.top    = panelState.y + 'px';
      frame.style.width  = panelState.w + 'px';
      frame.style.height = panelState.h + 'px';
      frame.style.zIndex = String(panelState.z);
      frame.dataset.panelId = panelState.id;

      const header = document.createElement('div');
      header.className = 'ed-floating-panel-header';

      const title = document.createElement('div');
      title.className = 'ed-floating-panel-title';
      title.textContent = reg ? reg.title : panelState.type;
      header.appendChild(title);

      const sub = document.createElement('span');
      sub.className = 'ed-floating-panel-subtitle';
      header.appendChild(sub);

      const pinBtn = document.createElement('button');
      pinBtn.type = 'button';
      pinBtn.className = 'ed-floating-panel-btn' + (panelState.pinned ? ' is-on' : '');
      pinBtn.title = panelState.pinned
        ? 'Unpin — panel will follow the current selection again'
        : 'Pin — keep showing the currently-bound object even when selection changes';
      pinBtn.textContent = '📌';
      pinBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        togglePin(panelState.id);
      });
      header.appendChild(pinBtn);

      const closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'ed-floating-panel-btn';
      closeBtn.title = 'Close panel';
      closeBtn.textContent = '✕';
      closeBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        close(panelState.id);
      });
      header.appendChild(closeBtn);

      const body = document.createElement('div');
      body.className = 'ed-floating-panel-body';

      const resize = document.createElement('div');
      resize.className = 'ed-floating-panel-resize';
      resize.title = 'Drag to resize';

      frame.appendChild(header);
      frame.appendChild(body);
      frame.appendChild(resize);

      // Bring-to-front on any click inside frame (not just header).
      frame.addEventListener('pointerdown', function () {
        bringToFront(panelState.id);
      });

      // Header drag — move the panel.
      // v0.8.114: hard-stick — dragging any panel in a parent/child
      // tree moves the whole tree as a unit. We find the root,
      // snapshot the starting position of every member, and apply
      // the same delta to all of them on each pointermove.
      header.addEventListener('pointerdown', function (e) {
        // Ignore drags that start on the buttons.
        if (e.target.closest('.ed-floating-panel-btn')) return;
        e.preventDefault();
        const startX = e.clientX, startY = e.clientY;
        const rootId = findRootPanelId(panelState.id);
        const treeIds = collectTree(rootId);
        // Snapshot starting positions so each move computes against
        // the original, not the previous frame (avoids drift).
        const snap = treeIds.map(function (pid) {
          const pp = panels[pid];
          return { id: pid, ox: pp.state.x, oy: pp.state.y, w: pp.state.w };
        });
        header.setPointerCapture(e.pointerId);
        function onMove(ev) {
          const dx = ev.clientX - startX;
          const dy = ev.clientY - startY;
          snap.forEach(function (s) {
            const pp = panels[s.id]; if (!pp) return;
            const c = clampPos(s.ox + dx, s.oy + dy, s.w);
            pp.state.x = c.x; pp.state.y = c.y;
            pp.frameEl.style.left = c.x + 'px';
            pp.frameEl.style.top  = c.y + 'px';
          });
        }
        function onUp() {
          header.removeEventListener('pointermove', onMove);
          header.removeEventListener('pointerup', onUp);
          // v0.8.121: mark the entire tree as user-positioned, since
          // hard-stick moved them all together. lastPos is now safe
          // to update on close.
          collectTree(rootId).forEach(function (pid) {
            if (panels[pid]) panels[pid].state.userPositioned = true;
          });
          persist();
        }
        header.addEventListener('pointermove', onMove);
        header.addEventListener('pointerup', onUp);
      });

      // Corner resize.
      // v0.8.114: after resize, slide any children so they stay glued
      // to the parent's right edge. Width grows → child slides right.
      resize.addEventListener('pointerdown', function (e) {
        e.preventDefault();
        e.stopPropagation();
        const startX = e.clientX, startY = e.clientY;
        const origW = panelState.w, origH = panelState.h;
        resize.setPointerCapture(e.pointerId);
        function onMove(ev) {
          const w = Math.max(220, origW + (ev.clientX - startX));
          const h = Math.max(120, origH + (ev.clientY - startY));
          panelState.w = w; panelState.h = h;
          frame.style.width  = w + 'px';
          frame.style.height = h + 'px';
          repositionChildrenOf(panelState.id);
        }
        function onUp() {
          resize.removeEventListener('pointermove', onMove);
          resize.removeEventListener('pointerup', onUp);
          // v0.8.121: explicit user resize → lastPos may track this
          // panel's size (and position, if it had also been moved).
          panelState.userPositioned = true;
          persist();
        }
        resize.addEventListener('pointermove', onMove);
        resize.addEventListener('pointerup', onUp);
      });

      return { frame: frame, header: header, body: body, title: title, sub: sub, pinBtn: pinBtn };
    }

    // Build the render context handed to a panel's render(). Folds
    // in the current selection so panels that follow selection show
    // fresh data. Pinned panels, and panels that don't follow
    // selection at all (like behavior-block), use their bound
    // objectId regardless of pinned state — for these, objectId is
    // always authoritative, not just when pinned.
    function buildContext(panelState) {
      const reg = PANEL_REGISTRY[panelState.type];
      const allSel = state.selectedIds.slice();
      let primaryId = null;
      // v0.8.130: use objectId when (a) pinned, or (b) the panel
      // type doesn't follow selection (e.g. behavior-block — always
      // bound to a specific parent object, pinned or not).
      const objectIdAuthoritative = panelState.objectId &&
        (panelState.pinned || (reg && !reg.followsSelection));
      if (objectIdAuthoritative) {
        primaryId = panelState.objectId;
      } else {
        primaryId = allSel.length ? allSel[allSel.length - 1] : null;
      }
      let primaryLine = null;
      if (primaryId) {
        // v0.8.132: search current class first. In modeIsAll, sibling
        // lines across classes can share the same l.id (same master),
        // so iterating all classes in arbitrary insertion order found
        // a sibling with stale behavior ids instead of the live current-
        // class line. Preferring state.lines (current class) avoids the
        // collision. Cross-class fallback still handles pinned-panel
        // cross-class browsing.
        const curClassLines = state.byClass[state.classId] && state.byClass[state.classId].lines;
        if (curClassLines) {
          primaryLine = curClassLines.find(function (l) { return l.id === primaryId; }) || null;
        }
        if (!primaryLine) {
          // Fallback: search all other classes (pinned objectIds for
          // objects not in the current class).
          Object.keys(state.byClass).some(function (cid) {
            if (cid === state.classId) return false;
            const ls = state.byClass[cid] && state.byClass[cid].lines;
            if (!ls) return false;
            const found = ls.find(function (l) { return l.id === primaryId; });
            if (found) { primaryLine = found; return true; }
            return false;
          });
        }
      }
      return {
        panelState: panelState,
        primarySelectionId: primaryId,
        primaryLine: primaryLine,
        allSelectedIds: allSel
      };
    }

    function renderPanel(panelId) {
      const p = panels[panelId]; if (!p) return;
      const reg = PANEL_REGISTRY[p.state.type];
      if (!reg) return;
      // Subtitle reflects the binding mode so the user can see at a
      // glance whether the panel is locked to one object or live-
      // following selection.
      // v0.8.129: show object name + short id. Name is more useful
      // to the user; short id lets them cross-reference the data
      // file when needed.
      function panelLineLabel(lineId) {
        if (!lineId) return '—';
        let found = null;
        Object.keys(state.byClass).some(function (cid) {
          const ls = state.byClass[cid] && state.byClass[cid].lines;
          if (!ls) return false;
          const l = ls.find(function (x) { return x.id === lineId; });
          if (l) { found = l; return true; }
          return false;
        });
        const name = found && found.name ? found.name : null;
        const shortId = String(lineId).slice(0, 7);
        return name ? name + ' (' + shortId + ')' : shortId;
      }
      if (p.state.pinned && p.state.objectId) {
        p.sub.textContent = '· 📌 ' + panelLineLabel(p.state.objectId);
      } else if (reg.followsSelection) {
        const sel = state.selectedIds;
        const last = sel.length ? sel[sel.length - 1] : null;
        p.sub.textContent = last ? '· ' + panelLineLabel(last) : '· no selection';
      } else {
        p.sub.textContent = '';
      }
      try {
        // v0.8.112: clear body before each render so registry
        // functions don't all have to repeat the boilerplate.
        // Demo panel previously did this itself; now it's central.
        p.body.innerHTML = '';
        const ctx = buildContext(p.state);
        // v0.8.113: binding-change cascade. If THIS unpinned panel
        // is about to switch to a new object, kill its children
        // first (they reference the old object's blockIds and would
        // otherwise show "no longer exists"). Has to live here in
        // renderPanel so it fires regardless of which fan-out
        // method (notifySelection / notifyDataChanged) triggered
        // the re-render.
        if (p.state.type === 'object' && !p.state.pinned) {
          const prev = p.lastBoundObjectId || null;
          const nextId = ctx.primarySelectionId || null;
          if (prev && nextId && prev !== nextId) {
            closeChildrenOf(p.state.id);
          }
        }
        p.lastBoundObjectId = ctx.primarySelectionId;
        reg.render(p.body, ctx);
      } catch (e) {
        p.body.innerHTML = '';
        const err = document.createElement('div');
        err.style.color = '#f88';
        err.textContent = 'Panel render error: ' + (e && e.message ? e.message : String(e));
        p.body.appendChild(err);
        console.error('[PanelManager] render error', p.state, e);
      }
    }

    function open(type, opts) {
      opts = opts || {};
      const reg = PANEL_REGISTRY[type];
      if (!reg) { console.warn('[PanelManager] unknown panel type', type); return null; }
      // Cascade subsequent same-type panels by +20px so they don't
      // stack precisely on top of each other.
      const existingSameType = Object.keys(panels).filter(function (pid) {
        return panels[pid].state.type === type;
      }).length;
      const dx = existingSameType * 24;
      const defPos = reg.defaultPos  || { x: 100, y: 100 };
      const defSz  = reg.defaultSize || { w: 320, h: 240 };
      // v0.8.117: if the caller didn't pass explicit geometry, reuse
      // the last-seen geometry for this type so a close-then-reopen
      // lands where the user left it. opts.id passed → restore from
      // snapshot, which already has its own x/y/w/h; we still honor
      // those.
      // v0.8.118: lastPos size applies to ALL panel types (including
      // children) — position only applies to non-children (children
      // derive x/y from parent via hard-stick, and openBehaviorPanel-
      // ForBlock always passes explicit opts.x/y anyway).
      const lp = loadLastPos()[type] || null;
      // v0.8.120: cascade offset (+dx) must apply on top of lastPos
      // too, otherwise multi-spawning N panels in quick succession
      // stacks them all at the same remembered position. The dx
      // count is based on already-existing same-type panels at
      // call time, so each subsequent open() in a forEach loop
      // sees one more existing panel and lands further along the
      // diagonal.
      const fallbackX = ((lp && !opts.parentId) ? lp.x : defPos.x) + dx;
      const fallbackY = ((lp && !opts.parentId) ? lp.y : defPos.y) + dx;
      const fallbackW = lp ? lp.w : defSz.w;
      const fallbackH = lp ? lp.h : defSz.h;
      const panelState = {
        id:       opts.id       || ('p' + (nextId++)),
        type:     type,
        objectId: opts.objectId || null,
        // v0.8.113: child-panel binding fields. blockId locks a
        // 'behavior-block' panel to a specific block.id (not index —
        // surviving reorders); parentId chains it to the owning
        // object panel for close-cascade and per-object lifecycle.
        blockId:  opts.blockId  || null,
        parentId: opts.parentId || null,
        pinned:   !!opts.pinned,
        x:        opts.x != null ? opts.x : fallbackX,
        y:        opts.y != null ? opts.y : fallbackY,
        w:        opts.w        || fallbackW,
        h:        opts.h        || fallbackH,
        z:        ++zCounter,
        // v0.8.121: restored from snapshot if previously set; new
        // panels start false until the user actually drags or resizes.
        userPositioned: !!opts.userPositioned
      };
      const clamped = clampPos(panelState.x, panelState.y, panelState.w);
      panelState.x = clamped.x; panelState.y = clamped.y;

      const built = buildFrame(panelState);
      panels[panelState.id] = {
        state: panelState, frameEl: built.frame, headerEl: built.header,
        bodyEl: built.body, body: built.body, sub: built.sub, pinBtn: built.pinBtn
      };
      hostEl.appendChild(built.frame);
      renderPanel(panelState.id);
      persist();
      if (typeof syncPanelButtonStates === 'function') syncPanelButtonStates();
      return panelState.id;
    }

    function close(panelId) {
      const p = panels[panelId]; if (!p) return;
      // v0.8.113: cascade-close children. Block-detail panels are
      // owned by their object panel — closing the parent removes
      // them. Snapshot the child id list FIRST, then delete the
      // panel itself, THEN recurse.
      // v0.8.115: delete-before-recurse + self-exclude. The old order
      // (recurse → delete) opened a stack-overflow door if any latent
      // parentId cycle existed (panel A.parent=B and B.parent=A, or
      // A.parent=A from a bad persist/restore): close(A) found B as
      // child → close(B) found A as child (A still in `panels`) →
      // close(A) again → infinite. Deleting A from `panels` before
      // recursing breaks the cycle. The `pid !== panelId` exclusion
      // is a second belt for the self-reference case specifically.
      const childIds = Object.keys(panels).filter(function (pid) {
        return pid !== panelId && panels[pid].state.parentId === panelId;
      });
      // v0.8.117: remember where parent-less panels were sitting so a
      // reopen lands in the same spot.
      // v0.8.118: also remember size for child panels — position
      // stays derived via hard-stick, but the user's chosen w/h
      // should survive a close/reopen cycle.
      // v0.8.121: gate the memory update on userPositioned so cascade-
      // offset multi-spawn panels don't drift lastPos by their +24px
      // offsets when closed. Auto-positioned panels (default / lastPos
      // restore / multi-spawn cascade) leave the memory untouched on
      // close; only panels the user actually dragged or resized
      // overwrite it.
      if (p.state.userPositioned) {
        rememberLastPos(p.state.type, p.state);
      }
      if (p.frameEl.parentNode) p.frameEl.parentNode.removeChild(p.frameEl);
      delete panels[panelId];
      childIds.forEach(function (cid) { close(cid); });
      // v0.8.132: clear bbox overlay when an object or block panel closes.
      if (typeof clearBboxOverlay === 'function') clearBboxOverlay();
      persist();
      if (typeof syncPanelButtonStates === 'function') syncPanelButtonStates();
    }

    // v0.8.113: external mutation of an existing panel's state
    // (e.g. clicking a different block in the parent re-binds the
    // child to the new blockId). Re-renders + persists.
    function updatePanel(panelId, patch) {
      const p = panels[panelId]; if (!p) return;
      Object.keys(patch || {}).forEach(function (k) {
        p.state[k] = patch[k];
      });
      renderPanel(panelId);
      persist();
    }

    // v0.8.113: helper — close every panel whose parentId === parentId.
    // Called when an 'object' panel re-binds to a different selection
    // so stale block-detail children don't keep showing the wrong
    // object's blocks.
    function closeChildrenOf(parentId) {
      const childIds = Object.keys(panels).filter(function (pid) {
        return panels[pid].state.parentId === parentId;
      });
      childIds.forEach(function (cid) { close(cid); });
    }

    // v0.8.114: hard-stick helpers. A child panel is glued to its
    // parent's right edge (parent.x + parent.w + 8, parent.y). Dragging
    // either panel moves the whole tree as a unit; resizing the parent
    // slides the child to track its new right edge.
    function findRootPanelId(panelId) {
      let cur = panels[panelId];
      while (cur && cur.state.parentId && panels[cur.state.parentId]) {
        cur = panels[cur.state.parentId];
      }
      return cur ? cur.state.id : panelId;
    }
    function getChildrenOf(parentId) {
      return Object.keys(panels).filter(function (pid) {
        return panels[pid].state.parentId === parentId;
      });
    }
    function collectTree(rootId, out) {
      out = out || [];
      const p = panels[rootId]; if (!p) return out;
      out.push(rootId);
      getChildrenOf(rootId).forEach(function (cid) { collectTree(cid, out); });
      return out;
    }
    // After a parent resize, slide each child to stay glued to the
    // parent's right edge. Recurses so grand-children follow too.
    function repositionChildrenOf(parentId) {
      const parent = panels[parentId]; if (!parent) return;
      getChildrenOf(parentId).forEach(function (cid) {
        const ch = panels[cid]; if (!ch) return;
        ch.state.x = parent.state.x + parent.state.w + 8;
        ch.state.y = parent.state.y;
        ch.frameEl.style.left = ch.state.x + 'px';
        ch.frameEl.style.top  = ch.state.y + 'px';
        repositionChildrenOf(cid);
      });
    }

    function togglePin(panelId) {
      const p = panels[panelId]; if (!p) return;
      if (p.state.pinned) {
        p.state.pinned = false;
        p.state.objectId = null;
      } else {
        p.state.pinned = true;
        // Bind to the current primary selection at pin time. If
        // nothing is selected, pin still flips but objectId stays
        // null (the panel just sits empty until something is bound).
        const sel = state.selectedIds;
        p.state.objectId = sel.length ? sel[sel.length - 1] : null;
      }
      p.frameEl.classList.toggle('is-pinned', p.state.pinned);
      p.pinBtn.classList.toggle('is-on', p.state.pinned);
      p.pinBtn.title = p.state.pinned
        ? 'Unpin — panel will follow the current selection again'
        : 'Pin — keep showing the currently-bound object even when selection changes';
      renderPanel(panelId);
      persist();
    }

    // Called by the editor when the selection changes. Unpinned
    // panels of types that follow selection re-render; pinned
    // panels keep their bound object. The binding-change cascade
    // lives in renderPanel itself (v0.8.113) so it fires for any
    // re-render trigger.
    function notifySelection() {
      Object.keys(panels).forEach(function (pid) {
        const p = panels[pid];
        const reg = PANEL_REGISTRY[p.state.type];
        if (!reg) return;
        if (p.state.pinned) return;
        if (!reg.followsSelection) return;
        renderPanel(pid);
      });
    }

    // Called on bulk data changes (snapshot restore, class switch,
    // etc.) — re-render every panel so pinned objects refresh too.
    function notifyDataChanged() {
      Object.keys(panels).forEach(function (pid) { renderPanel(pid); });
    }

    // Wipe and rebuild from persisted snapshot. Called on boot and
    // any time the (pageId, classId) tuple changes — panel state is
    // scoped per class, since class switches today change what's
    // selectable anyway.
    function restore() {
      // Tear down anything currently shown.
      Object.keys(panels).forEach(function (pid) {
        const p = panels[pid];
        if (p.frameEl.parentNode) p.frameEl.parentNode.removeChild(p.frameEl);
        delete panels[pid];
      });
      // v0.8.152: Don't reopen panels when there is no active selection.
      // On page load selectedIds is always empty, so this prevents stale
      // panels from appearing without context and conflicting with panels
      // opened by the first user interaction. persist() here writes the
      // now-empty map back to localStorage, clearing any stale entry.
      // lastPos (position memory) lives in a separate key and is unaffected.
      if (!state.selectedIds || !state.selectedIds.length) {
        persist();
        return;
      }
      const snap = loadPersisted();
      snap.forEach(function (rec) {
        if (!PANEL_REGISTRY[rec.type]) return; // stale type
        open(rec.type, {
          id: rec.id, objectId: rec.objectId,
          blockId: rec.blockId, parentId: rec.parentId,
          pinned: rec.pinned,
          x: rec.x, y: rec.y, w: rec.w, h: rec.h,
          // v0.8.121: preserve userPositioned across reloads so the
          // lastPos memory gate continues to work.
          userPositioned: rec.userPositioned
        });
      });
    }

    function listOpen() {
      return Object.keys(panels).map(function (pid) {
        return Object.assign({}, panels[pid].state);
      });
    }

    // v0.8.147: move every open panel by (dx, dy) screen pixels in
    // lockstep with a canvas scroll. Used by Shift+Arrow so the user
    // can pan canvas + panels together without touching individual
    // panel positions. Applies the same clampPos guard as the drag
    // handler — prevents panels from going completely out of reach,
    // and naturally limits Shift+→ so panels park back at the right
    // edge where they were intentionally placed.
    function shiftAllPanels(dx, dy) {
      Object.keys(panels).forEach(function (pid) {
        const p = panels[pid]; if (!p) return;
        const c = clampPos(p.state.x + dx, p.state.y + dy, p.state.w);
        p.state.x = c.x; p.state.y = c.y;
        p.frameEl.style.left = c.x + 'px';
        p.frameEl.style.top  = c.y + 'px';
      });
      persist();
    }

    return {
      open: open, close: close, togglePin: togglePin,
      bringToFront: bringToFront,
      updatePanel: updatePanel,
      closeChildrenOf: closeChildrenOf,
      notifySelection: notifySelection,
      notifyDataChanged: notifyDataChanged,
      restore: restore,
      listOpen: listOpen,
      shiftAllPanels: shiftAllPanels,
      // Exposed for late additions of new panel types from outside
      // this IIFE (debug consoles, plugin-style extensions).
      register: function (type, def) { PANEL_REGISTRY[type] = def; },
      _registry: PANEL_REGISTRY
    };
  })();

  // Expose globally for diagnostic / future-step access. The actual
  // hooks into selection / class-switch live as direct calls inside
  // renderSelectionPanel and switchClass — wrapping a `function`
  // declaration in strict mode is not reliable, and direct calls
  // are simpler to grep for.
  window.PanelManager = PanelManager;

  // Boot: restore any panels persisted for this (pageId, classId).
  // Done at the very end so PANEL_REGISTRY + state are fully set up.
  try { PanelManager.restore(); } catch (e) { console.error('[PanelManager] restore failed', e); }
})();
