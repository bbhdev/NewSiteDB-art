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
    'd', 'stroke', 'width', 'linejoin', 'name'
  ];
  // Position sub-keys live on positionOffset (not in scope). Owning
  // them per-class is structural — scope toggles don't apply.
  const POSITION_PARAM_SUBKEYS = ['cx', 'cy', 'x', 'y'];

  // Behavior keys live on instance.overrides regardless of scope —
  // they're scroll-driven animation params, always per-class.
  const BEHAVIOR_KEYS = ['translateX', 'translateY', 'rotate',
                         'drawIn', 'drawInDirection',
                         'rotateOriginX', 'rotateOriginY'];

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
    }
  };

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
      defaults: { translateX: 0, translateY: -60, rotate: 0, drawIn: false }
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
  function clearSelection() { state.selectedIds = []; }

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
    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'ed-mini';
    reset.textContent = '100%';
    reset.title = 'Reset to 100%';
    reset.addEventListener('click', function () {
      inp.value = '100';
      apply();
    });
    const range = document.createElement('span');
    range.style.color = '#888';
    range.style.fontSize = '0.85em';
    range.textContent = 'range 25–400';
    row.appendChild(inp);
    row.appendChild(pct);
    row.appendChild(reset);
    row.appendChild(range);
    body.appendChild(row);
    modal.appendChild(body);

    const btnRow = document.createElement('div');
    btnRow.className = 'ed-modal-buttons';
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
          <li><strong>Esc</strong> or empty-canvas click to clear the selection.</li>\
          <li><strong>Backspace</strong> / Delete to remove every selected object.</li>\
        </ul>\
        <p>The <kbd>Select all</kbd> button toggles between "every object selected" and nothing — the same selection list the canvas and sidebar drive.</p>\
        <h4>Workflow</h4>\
        <p>Click an existing line on the canvas to select it. Drag its body to move; drag handles to reshape. Click the same spot again to cycle to a line beneath.</p>\
        <p>Groups in the sidebar are labeled <strong>G1, G2, …</strong>; the same prefix appears on canvas labels (toggle <kbd>Labels</kbd>) so you can match them up.</p>\
        <p>Drag a line row onto another row to reorder it; drop position (above / below the target) drives the canvas Z-order — earlier in the list = drawn first = behind. Drop on a group row instead to send the line to the end of that group. Group rows reorder the same way — drag a group above/below another to restack every line inside it; lines stay in the order they had within the group. Behavior blocks in the per-line panel reorder by grabbing their title strip and dropping onto another block.</p>\
        <p><kbd>Cmd/Ctrl + Z</kbd> undoes; <kbd>Cmd/Ctrl + Shift + Z</kbd> redoes; <kbd>Esc</kbd> cancels the current gesture.</p>\
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
        <p><strong>Translate mode</strong> — switches TranslateX / TranslateY between two interpretations:</p>\
        <ul>\
          <li><strong>Fixed</strong> — the authored value is the final displacement at Progress = 1.</li>\
          <li><strong>Drift X / Y / Both</strong> — the value is a per-scroll-pixel multiplier on the chosen axis. The displacement accumulates while the block is active and freezes the moment the next block activates. Useful for "drift in from off-canvas indefinitely, then hand off".</li>\
        </ul>\
        <p><strong>Fade opacity</strong> — opt-in opacity transition. When on, the line\'s opacity is interpolated each frame from <em>Opacity from</em> (at Progress = 0) to <em>Opacity to</em> (at Progress = 1). Authored as absolute values (0 = invisible, 1 = fully opaque), not deltas — so 1→0 fades out, 0→1 fades in, 1→1 keeps it solid. Composes by "last active block wins": a chain of fade blocks reads as a sequence (fade to 0.5, then to 0, etc.); blocks without Fade opacity don\'t touch the line\'s opacity.</p>\
        <p><strong>Draw-in</strong> — when on, the line\'s stroke draws on with Progress instead of appearing fully drawn. <em>Direction</em> reverses the draw order.</p>\
        <p>Multiple blocks compose: TranslateX / TranslateY / Rotate contributions sum each frame; opacity uses last-active-wins. A Loop-back block contributes a <em>negative</em> snapshot of the chain it\'s undoing, so the line returns exactly to the target\'s start.</p>'
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

    // Pass 1: mint masters for any lines that don't have one yet.
    // Fresh masters get empty scope (all keys canonical) + a
    // snapshot of the line's current visual values.
    useClasses.forEach(function (cid) {
      const lines = (state.byClass[cid] && state.byClass[cid].lines) || [];
      lines.forEach(function (line) {
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
      const instances = lines.map(function (line) {
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
        return {
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

    return { masters: masters, byClass: byClass };
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
    // a constant visual size regardless of zoom level.
    renderHandles();
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
        defaults: { translateX: 0, translateY: 0, rotate: 0, drawIn: false }
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
    { id: 'star',    label: 'Star',    hint: 'N-pointed' },
    { id: 'image',   label: 'Image',   hint: 'click corner, drag bbox · set URL in panel' }
  ];
  const CREATE_TYPES = CREATE_TYPES_LINES.concat(CREATE_TYPES_PRIMITIVES);

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
    function makeTypeButton(t, col) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ed-create-type';
      b.title = t.hint;
      b.innerHTML = '<strong>' + t.label + '</strong><span>' + t.hint + '</span>';
      b.addEventListener('click', function () {
        pickedType = t.id;
        body.querySelectorAll('.ed-create-type').forEach(function (n) {
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

    typesGrid.appendChild(linesCol);
    typesGrid.appendChild(primsCol);
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
    let changed = false;
    const movedMasterIds = {};
    lineIds.forEach(function (id) {
      const line = state.lines.find(function (l) { return l.id === id; });
      if (!line || line.groupId === newGroupId) return;
      line.groupId = newGroupId;
      if (line.masterId) movedMasterIds[line.masterId] = true;
      changed = true;
    });
    if (!changed) return;
    if (modeIsAll()) {
      const targetGroup = state.groups.find(function (g) { return g.id === newGroupId; });
      const targetName = targetGroup ? targetGroup.name : null;
      if (targetName) {
        Object.keys(movedMasterIds).forEach(function (mid) {
          forSiblingsOf(mid, function (sib, cid, bucket) {
            const peer = bucket.groups.find(function (g) { return g.name === targetName; });
            if (peer) sib.groupId = peer.id;
          });
        });
      }
    }
    // Auto-open the destination group so the user sees the move land.
    state.openGroupIds[newGroupId] = true;
    state.activeGroupId = newGroupId;
    // v0.8.29: re-flatten state.lines by group order so the
    // moved line lands at the end of the destination group's
    // run in state.lines, matching where the sidebar shows it.
    rebuildLinesInGroupOrder();
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
    let groupChanged = false;
    draggedLines.forEach(function (l) {
      if (anchorGroupId && l.groupId !== anchorGroupId) {
        l.groupId = anchorGroupId;
        groupChanged = true;
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
    const groupIdx = {};
    state.groups.forEach(function (g, i) { groupIdx[g.id] = i; });
    const withPos = state.lines.map(function (l, i) { return { l: l, i: i }; });
    withPos.sort(function (a, b) {
      const ag = (groupIdx[a.l.groupId] != null) ? groupIdx[a.l.groupId] : Infinity;
      const bg = (groupIdx[b.l.groupId] != null) ? groupIdx[b.l.groupId] : Infinity;
      if (ag !== bg) return ag - bg;
      return a.i - b.i;
    });
    state.lines = withPos.map(function (x) { return x.l; });
  }

  // v0.8.29: drag-to-reorder for groups themselves. State.groups
  // order drives sidebar order top-to-bottom, and after the
  // rebuild above it also drives canvas Z (earlier group = drawn
  // first = behind). Same toIdx contract as moveBehaviorBlock —
  // pre-move insertion index, so fromIdx → toIdx reads as "place
  // this group at slot toIdx". 'all' mode is sidestepped: each
  // class can have its own visual stacking, and the on-disk
  // group records are per-class anyway.
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
      defaults: { translateX: 0, translateY: -60, rotate: 0, drawIn: false }
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
    g.defaults = Object.assign({}, g.defaults, patch);
    state.dirty = true;
    // Stroke/width default changes affect canvas rendering of every line
    // that doesn't override them.
    if ('stroke' in patch || 'width' in patch) renderLines();
    // Booleans / discrete picks snapshot immediately; numeric / text
    // fields coalesce so undo doesn't step through every keystroke.
    if (typeof patch[Object.keys(patch)[0]] === 'boolean') snapshot();
    else scheduleSnapshot();
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
    if (key === 'translateX' || key === 'translateY' || key === 'translateMode') {
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
  function addBehaviorBlock(lineId) {
    const l = state.lines.find(function (l) { return l.id === lineId; });
    if (!l) return;
    pushNewBlock(l);
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
    if (key === 'when' || key === 'viewportAt' || key === 'repeat') {
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
    } else {
      // No selection follows over → leave activeGroupId null so the
      // selection panel stays neutral (matches the launch state from
      // v0.5.7). User picks a group/object when they want to focus.
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
  function showLibraryDialog() {
    const overlay = document.createElement('div');
    overlay.className = 'ed-modal-overlay';
    const modal = document.createElement('div');
    modal.className = 'ed-modal ed-library-modal';

    // Filter state: classFilter === null → show every master.
    // Set to a class id → show only masters with ≥1 instance in
    // that class. Toggled via the per-class buttons in the header.
    let classFilter = null;

    const head = document.createElement('div');
    head.className = 'ed-modal-header ed-library-header';
    const title = document.createElement('h3');
    title.textContent = 'Master library';
    head.appendChild(title);

    // Class filter buttons — one per screen class, plus an "All"
    // reset. Active button shows accent border like the class
    // tabs do, so the visual language is consistent.
    const filterRow = document.createElement('div');
    filterRow.className = 'ed-library-filter';
    const filterButtons = [];
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
    body.className = 'ed-modal-body ed-library-body';

    const search = document.createElement('input');
    search.type = 'search';
    search.placeholder = 'Filter by name…';
    search.className = 'ed-library-search';
    search.addEventListener('input', renderRows);
    body.appendChild(search);

    const list = document.createElement('div');
    list.className = 'ed-library-list';
    body.appendChild(list);

    modal.appendChild(body);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    renderRows();
    search.focus();

    function renderRows() {
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
      state.pageConfig.useClasses.forEach(function (cid) {
        const cls = state.classes.find(function (c) { return c.id === cid; });
        const label = cls ? cls.name : cid;
        const count = usage[cid] || 0;
        const chip = document.createElement('span');
        chip.className = 'ed-library-chip' + (count === 0 ? ' is-absent' : '');
        chip.textContent = label + (count > 1 ? ' ×' + count : '');
        chip.title = count === 0
          ? 'Not present in ' + label
          : count + ' instance' + (count === 1 ? '' : 's') + ' in ' + label;
        chips.appendChild(chip);
      });
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

    function buildPreview(master) {
      const wrap = document.createElement('div');
      wrap.className = 'ed-library-preview';
      // Bake a transient line to compute its d, then fit-scale into
      // a 48×48 SVG. For image kind we show a 🖼 placeholder since
      // <image> elements require URL fetches in the modal.
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
      // Derive a viewBox from the line's bbox by inspecting params
      // or points. Falls back to a wide default so badly-formed
      // entries still render something.
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
      if (width)  p.style.strokeWidth = width;
      if (line.linejoin) p.style.strokeLinejoin = line.linejoin;
      // Fill rules:
      //   - `filled` is the source of truth when set explicitly
      //     (true for primitives, true for closed-loop freehand, etc.)
      //   - falls back to `closed` for legacy data without `filled`
      //   - image kind never gets the fill — the bitmap covers it.
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
    if (!state.showLabels) return;

    state.lines.forEach(function (line) {
      if (!line.name) return;
      // Need either points OR primitive params to anchor the label.
      const hasGeo = (Array.isArray(line.points) && line.points.length) ||
                     (PRIMITIVES[line.kind] && line.params);
      if (!hasGeo) return;
      const pos = labelPositionFor(line);

      const group = state.groups.find(function (g) { return g.id === line.groupId; });
      const strokeRef = line.stroke || (group && group.defaults && group.defaults.stroke) || null;
      const fill = resolveStroke(strokeRef) || '#aaa';

      const g = document.createElementNS(SVG_NS, 'g');
      g.setAttribute('class', 'ed-label');
      g.setAttribute('transform', 'translate(' + pos.x + ',' + pos.y + ')');

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
      nameSpan.textContent = groupTag + line.name;
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
            idSpan.title = line.id;
          } else {
            idSpan.className = 'ed-line-id';
            idSpan.textContent = line.id;
          }
          const overrideTag = document.createElement('span');
          overrideTag.style.color = '#888';
          overrideTag.textContent = (line.overrides && Object.keys(line.overrides).length) ? '*' : '';
          lr.appendChild(idSpan);
          lr.appendChild(overrideTag);
          lr.addEventListener('click', function (e) {
            e.stopPropagation();
            // Cmd/Shift toggles the row in/out of the selection; plain
            // click replaces with just this line. Matches the canvas
            // modifier-click behavior so both selection surfaces stay
            // in sync.
            const isMulti = (e.metaKey || e.ctrlKey || e.shiftKey);
            if (isMulti) {
              toggleInSelection(line.id);
            } else {
              selectOnly(line.id);
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
    if (!state.lines.length) return;
    const n = state.lines.length;
    if (!confirm('Delete all ' + n + ' line' + (n === 1 ? '' : 's') +
                 ' from this page?\n\nThis can be undone (Cmd+Z).')) return;
    state.lines = [];
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
    const wasSingleSelect = state.selectedIds.length === 1;
    // Multi-select takes precedence: show a compact bulk-actions panel.
    // Single selection shows the full line params panel (unchanged).
    // Otherwise fall through to the active group's settings.
    if (state.selectedIds.length > 1) {
      renderMultiSelectionPanel();
    } else if (wasSingleSelect) {
      const line = state.lines.find(function (l) { return l.id === primarySelectedId(); });
      if (line) renderLinePanel(line);
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
    if (!suppress && wasSingleSelect && selectionPanel.scrollIntoView
        && primaryId !== lastScrolledSelectionId) {
      selectionPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    // Update the tracker even when suppressed, so a later plain click
    // on the SAME object doesn't re-trigger the scroll (the user
    // already saw that panel via the modifier-click).
    lastScrolledSelectionId = primaryId;
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

    wrap.appendChild(divider('Behavior defaults'));
    wrap.appendChild(numberField('TranslateX', g.defaults.translateX, function (v) { updateGroupDefaults(g.id, { translateX: v }); }));
    wrap.appendChild(numberField('TranslateY', g.defaults.translateY, function (v) { updateGroupDefaults(g.id, { translateY: v }); }));
    wrap.appendChild(numberField('Rotate',     g.defaults.rotate,     function (v) { updateGroupDefaults(g.id, { rotate: v }); }));
    // Rotation pivot — leave blank for "use the shape's natural center"
    // (geometric center for primitives, bbox center for free-form).
    // Fill with explicit X/Y for off-center rotations; or click
    // "Set on canvas" then click anywhere on the surface to drop the
    // pivot visually.
    wrap.appendChild(numberField('Rotate origin X', g.defaults.rotateOriginX, function (v) { updateGroupDefaults(g.id, { rotateOriginX: v }); }));
    wrap.appendChild(numberField('Rotate origin Y', g.defaults.rotateOriginY, function (v) { updateGroupDefaults(g.id, { rotateOriginY: v }); }));
    wrap.appendChild(setOriginButton(function () { startSetRotateOrigin({ type: 'group', id: g.id }); }));

    wrap.appendChild(checkboxField('Draw-in', !!g.defaults.drawIn, function (v) { updateGroupDefaults(g.id, { drawIn: v }); }));
    wrap.appendChild(selectField('Direction', g.defaults.drawInDirection || 'forward', [
      { value: 'forward', label: 'Begin → end' },
      { value: 'reverse', label: 'End → begin' }
    ], function (v) { updateGroupDefaults(g.id, { drawInDirection: v }); }));

    selectionPanel.appendChild(wrap);

    // Delete is always available. The confirm dialog (empty vs.
    // non-empty group) lives in confirmAndDeleteGroup so the sidebar
    // group-row ✕ button can reuse the same flow.
    const actions = document.createElement('div');
    actions.className = 'ed-actions';
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
    if (choice === 'group') deleteGroup(g.id, false);
    else if (choice === 'both')  deleteGroup(g.id, true);
  }

  function renderLinePanel(line) {
    const group = state.groups.find(function (g) { return g.id === line.groupId; });
    const head = document.createElement('header');
    head.className = 'ed-panel-head';
    const h3 = document.createElement('h3');
    h3.textContent = line.name ? line.name : 'Line';
    head.appendChild(h3);
    selectionPanel.appendChild(head);

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
    selectionPanel.appendChild(meta);

    const wrap = document.createElement('div');
    wrap.className = 'ed-settings';

    wrap.appendChild(withScope(textField('Name', line.name || '', function (v) {
      setVisualProp(line.id, 'name', v);
      scheduleSnapshot();
      renderLines();
      renderGroupsList();
    }, 'optional'), line.masterId, 'name'));

    // Visibility — toggle off to hide on the live site without
    // deleting. Useful for trying variants. Renders faded in the
    // editor; runtime skips entirely.
    wrap.appendChild(checkboxField('Visible', !line.hidden, function (v) {
      updateLine(line.id, { hidden: !v });
    }));

    // "Reset position" — visible only when this instance has a
    // non-zero positionOffset. Snaps the instance back to the master's
    // canonical position. Doesn't touch other classes.
    const hasOffset = line.positionOffset
      && (Math.abs(line.positionOffset.dx) > 0.0001 || Math.abs(line.positionOffset.dy) > 0.0001);
    if (hasOffset) {
      const row = document.createElement('div');
      row.className = 'ed-field';
      const lbl = document.createElement('label');
      lbl.textContent = 'Position';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ed-mini';
      btn.textContent = '↺ Reset to master';
      btn.title = 'Clear this class\'s position offset so the object snaps back to the master\'s canonical placement.';
      btn.addEventListener('click', function () { resetPositionOffset(line.id); });
      row.appendChild(lbl);
      row.appendChild(btn);
      wrap.appendChild(row);
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
      // kind ignores fill (the bitmap covers the box).
      if (line.kind !== 'image') {
        wrap.appendChild(withScope(checkboxField('Filled', !!line.filled, function (v) {
          setVisualProp(line.id, 'filled', v);
          scheduleSnapshot();
          renderLines();
        }), line.masterId, 'filled'));
      }
    }

    wrap.appendChild(divider('Appearance'));
    wrap.appendChild(withScope(strokeField('Color', line.stroke, function (v) {
      setVisualProp(line.id, 'stroke', v);
      scheduleSnapshot();
      renderLines();
      renderGroupsList();
    }), line.masterId, 'stroke'));
    wrap.appendChild(withScope(overrideNumberField('Line width', line.width, group && group.defaults.width, function (v) {
      setVisualProp(line.id, 'width', v);
      scheduleSnapshot();
      renderLines();
    }), line.masterId, 'width'));
    // Stroke corner style. On a filled shape with a same-color stroke
    // (the default for primitives), `round` produces the bulgy
    // rounded-tip effect that scales with line width; `miter` keeps
    // sharp geometric points; `bevel` flattens them.
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

    wrap.appendChild(divider('Behavior'));
    // v0.4.1: behaviors[] authoring. Each block is a card with
    // its own range (start/end ∈ [0,1] within the trigger window)
    // and the legacy behavior params.
    // v0.8.20: corrected the comment / UX. The runtime ADDS every
    // block's contribution every frame (app.js computeAt) — it does
    // NOT pick a single block. A block contributes whenever its
    // progress > 0; that's automatic for scroll-driven blocks
    // outside their range, but timed runs clamp at 1 and keep
    // contributing forever once they've completed. The additive
    // note below makes this visible for multi-block lines.
    const blocks = Array.isArray(line.behaviors) ? line.behaviors : [];
    if (blocks.length >= 2) {
      const addNote = document.createElement('p');
      addNote.className = 'ed-behavior-additive-note';
      addNote.textContent = 'Multi-block: every block\'s translate / rotate is summed each frame. ' +
        'Scroll-driven blocks stop contributing outside their range, but timed/loop/ping-pong blocks ' +
        'whose progress has reached 1 keep contributing until the block\'s trigger ends.';
      wrap.appendChild(addNote);
    }
    const overlaps = findBehaviorOverlaps(blocks);
    if (overlaps.length) {
      const warn = document.createElement('p');
      warn.className = 'ed-behavior-warning';
      warn.textContent = 'Overlapping blocks: ' +
        overlaps.map(function (o) { return (o.a + 1) + ' & ' + (o.b + 1); }).join(', ') +
        '. Overlapping ranges contribute simultaneously — their deltas sum during the overlap. ' +
        'Sometimes intentional (parallel motion); otherwise space the ranges out.';
      wrap.appendChild(warn);
    }
    if (!blocks.length) {
      const ph = document.createElement('p');
      ph.className = 'ed-behavior-empty';
      ph.textContent = 'No behavior blocks yet. Add one to drive scroll animation.';
      wrap.appendChild(ph);
    } else {
      blocks.forEach(function (block, idx) {
        wrap.appendChild(renderBehaviorBlock(line, idx, group));
      });
    }
    const addBlockBtn = document.createElement('button');
    addBlockBtn.type = 'button';
    addBlockBtn.className = 'ed-mini ed-behavior-add';
    addBlockBtn.textContent = '+ Add block';
    addBlockBtn.title = 'Append a new behavior block (range 0–1; edit to chain).';
    addBlockBtn.addEventListener('click', function () { addBehaviorBlock(line.id); });
    wrap.appendChild(addBlockBtn);

    selectionPanel.appendChild(wrap);

    const actions = document.createElement('div');
    actions.className = 'ed-actions';
    // Delete — one mode-aware button. 'all' mode cascades site-
    // wide; 'one' mode drops just THIS class's instance row.
    const del = document.createElement('button');
    del.className = 'ed-danger';
    if (modeIsAll()) {
      del.textContent = 'Delete object (all classes)';
      del.title = 'Delete this object everywhere — every class loses it.';
    } else {
      del.textContent = 'Remove from this class';
      del.title = 'Drop just this class\'s instance; the object stays in other classes.';
    }
    del.addEventListener('click', function () {
      if (modeIsAll()) deleteLine(line.id);
      else removeLinesFromCurrentClass([line.id]);
    });
    actions.appendChild(del);
    selectionPanel.appendChild(actions);
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
    wrap.appendChild(lbl);
    wrap.appendChild(row);
    return wrap;
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
    } else {
      act = 'Triggers (' + when + ')';
    }
    if (delay > 0) act += ', waits ' + formatSeconds(delay);

    let prog;
    if (dmode === 'time') {
      prog = 'then runs once over ' + secs + ease;
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
    return act + ', ' + prog + '.';
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
        // v0.8.20: drift node may not exist (it's only rendered when
        // translateMode != fixed). If it does and drift just turned
        // off, blank it; the next full re-render will drop the node.
        n.textContent = driftText || '';
      } else {
        n.textContent = behaviorSummaryText(block);
      }
    }
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
  function renderBehaviorBlock(line, blockIdx, group) {
    const block = line.behaviors[blockIdx];
    const params = (block && block.params) || {};
    const range = (block && block.range) || { start: 0, end: 1 };
    const gd = (group && group.defaults) || {};

    const card = document.createElement('div');
    card.className = 'ed-behavior-block';

    const head = document.createElement('div');
    head.className = 'ed-behavior-head';
    // v0.8.28: the head strip is the block's drag handle — only it
    // is draggable, so number / select inputs further down the card
    // stay interactive. Block order maps to execution order (and to
    // loopTo's target index), so reordering rewires the sequence.
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
    title.textContent = 'Block ' + (blockIdx + 1);
    head.appendChild(title);
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'ed-behavior-remove';
    rm.textContent = '×';
    rm.title = 'Remove this block';
    // The remove button sits inside a draggable head, which on some
    // browsers swallows click-through. Stopping pointerdown keeps
    // the click reaching the button without starting a drag.
    rm.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
    rm.addEventListener('click', function () { removeBehaviorBlock(line.id, blockIdx); });
    head.appendChild(rm);
    card.appendChild(head);

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

    // v0.8.7: trigger (When) and duration (How) on independent
    // axes. Each is a button group; invalid combos are greyed and
    // click-on-greyed pops an explainer dialog.
    const trigger  = (block && block.trigger)  ? block.trigger  : { when: 'scroll-range', range: { start: 0, end: 1 }, delay: 0 };
    const duration = (block && block.duration) ? block.duration : { mode: 'scroll' };
    const when = trigger.when || 'scroll-range';
    const dmode = duration.mode || 'scroll';

    // v0.8.8: fluid post-summary strip — the orthogonal pickers
    // make the legal combos easy to confuse, so a plain-English
    // sentence makes the live combo readable at a glance.
    // v0.8.10: dataset stamps let refreshBehaviorSummary find this
    // node and update its text in place when a non-mode field
    // changes (range, delay, seconds, easing, selector) without
    // re-rendering the panel and stealing input focus.
    const summary = document.createElement('div');
    summary.className = 'ed-behavior-summary';
    summary.dataset.lineId  = String(line.id);
    summary.dataset.blockIdx = String(blockIdx);
    summary.textContent = behaviorSummaryText(block);
    card.appendChild(summary);

    // v0.8.20: drift line (only rendered when translateMode != fixed).
    // Its own dataset stamps so refreshBehaviorSummary can rewrite it
    // in place on translate*/translateMode edits without re-rendering
    // the panel.
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

    // When (activation) picker
    // v0.8.22: "After previous ends" trigger — fires when the most
    // recent preceding TIMED block finishes (activation + delay +
    // seconds). Scroll-driven / loop / ping-pong blocks are skipped
    // when walking back, because they don't have a discrete end. The
    // option is disabled when no prior timed block exists (blockIdx
    // 0, or all preceding blocks are continuous), with an explainer
    // dialog on click so the user knows why.
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
    card.appendChild(behaviorButtonGroup('Activate when', when, [
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
          'they have no discrete end.' }
    ], function (v) { updateBehaviorTrigger(line.id, blockIdx, 'when', v); },
       function (opt) { explainDurationDisabled(opt); }));

    // v0.8.19: render every trigger field on every render, so the
    // user always sees all axes — fields that don't apply to the
    // current "Activate when" are dimmed and disabled (.is-inactive)
    // rather than removed. Side effect: values entered before a mode
    // switch stay visible and are restored the moment the mode flips
    // back, without a hidden-but-persisted ghost state.
    const r = trigger.range || { start: 0, end: 1 };
    const rangeRow = document.createElement('div');
    rangeRow.className = 'ed-behavior-range';
    rangeRow.appendChild(rangeNumberField('Start', r.start, function (v) {
      updateBehaviorTrigger(line.id, blockIdx, 'rangeStart', v);
    }));
    rangeRow.appendChild(rangeNumberField('End', r.end, function (v) {
      updateBehaviorTrigger(line.id, blockIdx, 'rangeEnd', v);
    }));
    setInactive(rangeRow, when !== 'scroll-range');
    card.appendChild(rangeRow);

    card.appendChild(setInactive(triggerField('Trigger key', trigger.selector || '', function (v) {
      updateBehaviorTrigger(line.id, blockIdx, 'selector', v);
    }), when !== 'scroll-key'));
    // v0.8.12: where in the viewport the key has to land for
    // activation. 'bottom' preserves the v0.8.11 default with a
    // small inset; 'top' / 'middle' let the user gate activation
    // until the key has scrolled further up.
    const va = trigger.viewportAt || 'middle';
    card.appendChild(setInactive(behaviorButtonGroup('Reaches', va, [
      { value: 'top',    label: 'Top of viewport' },
      { value: 'middle', label: 'Middle' },
      { value: 'bottom', label: 'Bottom of viewport' },
      { value: 'object', label: 'The object' }
    ], function (v) { updateBehaviorTrigger(line.id, blockIdx, 'viewportAt', v); },
       null), when !== 'scroll-key'));
    // v0.8.15: re-arm on every scroll-back crossing so the
    // timed/loop/pingpong duration restarts each time the key
    // re-enters the trigger zone.
    const rep = trigger.repeat || 'once';
    card.appendChild(setInactive(behaviorButtonGroup('Repeat', rep, [
      { value: 'once',  label: 'Once' },
      { value: 'every', label: 'Every crossing' }
    ], function (v) { updateBehaviorTrigger(line.id, blockIdx, 'repeat', v); },
       null), when !== 'scroll-key'));

    // Delay is an additional offset (seconds) after the activation
    // event fires. Only meaningless when the block has no time
    // concept at all — that's the scroll-range × scroll-driven
    // combo, where progress is bound directly to scroll position.
    card.appendChild(setInactive(numberField('Delay after activation (s)', trigger.delay || 0, function (v) {
      updateBehaviorTrigger(line.id, blockIdx, 'delay', v);
    }), when === 'scroll-range' && dmode === 'scroll'));

    // Progress (How) picker — 'scroll' is only valid when
    // when=scroll-range; greyed otherwise and click-explains.
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
      // v0.8.23: loopTo turns the preceding sequence into a
      // continuous oscillating loop — over `seconds`, animate back
      // to where the target block started, then replay the chain.
      // Reuses the same "earlier timed block exists?" gate as the
      // after-previous trigger, since both need a finite anchor.
      { value: 'loopTo',   label: 'Loop back to earlier block',
        disabledIf: prevTimedIdx < 0,
        disabledReason: 'Loop-back needs an earlier Timed block to ' +
          'return to. Add at least one block above this one with ' +
          'Progress = "Timed run (seconds)" — scroll-driven / loop / ' +
          'ping-pong blocks have no fixed start position to anchor to.' }
    ];
    card.appendChild(behaviorButtonGroup('Progress', dmode, durationOpts,
      function (v) { updateBehaviorDuration(line.id, blockIdx, 'mode', v); },
      function (opt) { explainDurationDisabled(opt); }));

    // v0.8.19: always render Seconds + Easing, inactive when
    // Progress = Scroll-driven (which is bound to scroll position
    // and has no per-block time/easing). Lets the user see the
    // values they had set under Timed/Loop/Ping-pong even after
    // switching back to Scroll-driven.
    const secondsLabel = (dmode === 'loopTo') ? 'Return time (s)' : 'Seconds';
    card.appendChild(setInactive(numberField(secondsLabel, duration.seconds || 1, function (v) {
      updateBehaviorDuration(line.id, blockIdx, 'seconds', v);
    }), dmode === 'scroll'));
    card.appendChild(setInactive(selectField('Easing', duration.easing || 'linear',
      EASING_OPTIONS,
      function (v) { updateBehaviorDuration(line.id, blockIdx, 'easing', v); }),
      dmode === 'scroll'));

    // v0.8.23: loopTo-specific fields — target picker (earlier
    // time-mode blocks only) + optional max-iterations cap. When
    // dmode === 'loopTo' we stop rendering after these because the
    // per-block tx/ty/rot/drift/draw-in fields don't apply: a loopTo
    // block's contribution is computed at runtime from the chain it's
    // returning over, not from authored deltas. Fields stay in the
    // data model and reappear if the user flips Progress back.
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

    // v0.8.17: open-ended translate mode. 'Fixed' = current
    // behavior (translateX/Y are final displacements weighted
    // by block progress). 'Drift X / Y / Both' = that axis's
    // value is read as a per-scroll-px multiplier; the rendered
    // translate accumulates with scroll motion and freezes the
    // moment block idx+1 activates. Useful for "move object in
    // from off-canvas indefinitely, then hand off to the next
    // block" — saves authoring a precise translate value when
    // the exact distance doesn't matter, only the direction.
    const tmode = (params.translateMode || gd.translateMode || 'fixed');
    card.appendChild(behaviorButtonGroup('Translate mode', tmode, [
      { value: 'fixed',     label: 'Fixed' },
      { value: 'driftX',    label: 'Drift X' },
      { value: 'driftY',    label: 'Drift Y' },
      { value: 'driftBoth', label: 'Drift both' }
    ], function (v) {
      updateBehaviorParam(line.id, 'translateMode', v === 'fixed' ? null : v, blockIdx);
      renderSelectionPanel();
    }, null));
    const xDrift = (tmode === 'driftX' || tmode === 'driftBoth');
    const yDrift = (tmode === 'driftY' || tmode === 'driftBoth');
    card.appendChild(overrideNumberField(xDrift ? 'TranslateX (×scroll)' : 'TranslateX', params.translateX, gd.translateX, function (v) { updateBehaviorParam(line.id, 'translateX', v, blockIdx); }));
    card.appendChild(overrideNumberField(yDrift ? 'TranslateY (×scroll)' : 'TranslateY', params.translateY, gd.translateY, function (v) { updateBehaviorParam(line.id, 'translateY', v, blockIdx); }));
    card.appendChild(overrideNumberField('Rotate',     params.rotate,     gd.rotate,     function (v) { updateBehaviorParam(line.id, 'rotate', v, blockIdx); }));
    // v0.8.19: pivot fields + set-origin button gate on the
    // RESOLVED rotate (block override OR group default). If neither
    // produces a non-zero rotation the pivot does nothing visible,
    // so we dim those rows to point the user at Rotate first — but
    // keep them rendered so a pre-entered pivot stays visible.
    const resolvedRotate = (params.rotate != null) ? Number(params.rotate)
                         : Number(gd.rotate || 0);
    const noRotate = !Number.isFinite(resolvedRotate) || resolvedRotate === 0;
    // Per-line rotate-origin: DELTA from this object's natural
    // center, so the pivot travels with the line instead of
    // being pinned to a canvas coord. 0,0 = pivot at center.
    card.appendChild(setInactive(overrideNumberField('Pivot Δx (from center)', params.rotateOriginX, gd.rotateOriginX, function (v) { updateBehaviorParam(line.id, 'rotateOriginX', v, blockIdx); }), noRotate));
    card.appendChild(setInactive(overrideNumberField('Pivot Δy (from center)', params.rotateOriginY, gd.rotateOriginY, function (v) { updateBehaviorParam(line.id, 'rotateOriginY', v, blockIdx); }), noRotate));
    // Set-origin is per-block — the canvas-click handler reads
    // settingOrigin.blockIdx so the captured (x,y) lands in the
    // right block's params.
    card.appendChild(setInactive(setOriginButton(function () {
      startSetRotateOrigin({ type: 'line', id: line.id, blockIdx: blockIdx });
    }), noRotate));
    // v0.8.26: opacity fade is a per-block "mode of change" like
    // translate / rotate, except authored as absolute from→to
    // values instead of progress-weighted deltas. Off by default —
    // when on, the line's opacity is interpolated each frame by
    // this block's progress; if multiple opacity blocks overlap,
    // the latest active one (highest index) wins so a chained
    // sequence reads as a sequence of fades.
    const fadeOn = !!params.fadeOpacity;
    card.appendChild(checkboxField('Fade opacity', fadeOn, function (v) {
      updateBehaviorParam(line.id, 'fadeOpacity', v ? true : null, blockIdx);
      renderSelectionPanel();
    }));
    const oFrom = (typeof params.opacityFrom === 'number') ? params.opacityFrom : 1;
    const oTo   = (typeof params.opacityTo   === 'number') ? params.opacityTo   : 0;
    card.appendChild(setInactive(numberField('Opacity from (0–1)', oFrom, function (v) {
      updateBehaviorParam(line.id, 'opacityFrom', v, blockIdx);
    }), !fadeOn));
    card.appendChild(setInactive(numberField('Opacity to (0–1)', oTo, function (v) {
      updateBehaviorParam(line.id, 'opacityTo', v, blockIdx);
    }), !fadeOn));
    card.appendChild(overrideCheckboxField('Draw-in', params.drawIn, gd.drawIn, function (v) { updateBehaviorParam(line.id, 'drawIn', v, blockIdx); }));
    // v0.8.19: Direction gates on resolved drawIn (override OR
    // group default). drawIn=false → direction is a no-op.
    const resolvedDrawIn = (params.drawIn != null) ? !!params.drawIn : !!gd.drawIn;
    card.appendChild(setInactive(overrideSelectField('Direction', params.drawInDirection,
      gd.drawInDirection || 'forward',
      [
        { value: 'forward', label: 'Begin → end' },
        { value: 'reverse', label: 'End → begin' }
      ],
      function (v) { updateBehaviorParam(line.id, 'drawInDirection', v, blockIdx); }),
      !resolvedDrawIn));

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
    wrap.className = 'ed-field';
    const lbl = document.createElement('label'); lbl.textContent = label;
    const inp = document.createElement('input');
    inp.type = 'number'; inp.value = (value !== undefined && value !== null) ? value : 0;
    inp.addEventListener('input', function () { onChange(parseFloat(inp.value)); });
    wrap.appendChild(lbl); wrap.appendChild(inp);
    return wrap;
  }
  function checkboxField(label, value, onChange) {
    const wrap = document.createElement('div');
    wrap.className = 'ed-field';
    const lbl = document.createElement('label'); lbl.textContent = label;
    const inp = document.createElement('input');
    inp.type = 'checkbox'; inp.checked = !!value;
    inp.addEventListener('change', function () { onChange(inp.checked); });
    wrap.appendChild(lbl); wrap.appendChild(inp);
    return wrap;
  }
  function overrideNumberField(label, ov, fallback, onChange) {
    const wrap = document.createElement('div');
    wrap.className = 'ed-field';
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
    wrap.className = 'ed-field';
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
    btn.className = 'ed-mini';
    btn.textContent = 'Set on canvas →';
    btn.title = 'Click here, then click anywhere on the canvas to set the rotation origin to that point.';
    btn.addEventListener('click', onClick);
    wrap.appendChild(lbl); wrap.appendChild(btn);
    return wrap;
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
  }

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

  const libraryBtn = document.getElementById('library-btn');
  if (libraryBtn) libraryBtn.addEventListener('click', showLibraryDialog);

  // SVG import — file picker + button wiring. The input is hidden;
  // the button opens it. importSvgFile (defined above) does the
  // parsing, master-mint, snapshot, and re-render.
  const importSvgBtn   = document.getElementById('import-svg-btn');
  const importSvgInput = document.getElementById('import-svg-input');
  if (importSvgBtn && importSvgInput) {
    importSvgBtn.addEventListener('click', function () { importSvgInput.click(); });
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
  // Move-selection mode: pressing inside any selected object's hit
  // area (but not on a handle) starts translating every selected
  // object in lockstep. Single- and multi-select share this code path
  // — selectedIds.length is the only difference. Reset on pointerup.
  let moveSel = null;  // { startPt, origLines: [{ id, origPoints, origSegments, origParams, origOverrides }, …] }
  // Set-rotate-origin mode: the user clicked "Set on canvas →" in a
  // panel; the next canvas click writes that point into the active
  // target's rotateOriginX / Y, then mode exits.
  let settingOrigin = null; // { type: 'group'|'line', id: '…' }

  function startSetRotateOrigin(target) {
    settingOrigin = target;
    canvasWrap.classList.add('ed-set-origin-mode');
    if (setOriginBanner) setOriginBanner.hidden = false;
  }
  function exitSetRotateOrigin() {
    settingOrigin = null;
    canvasWrap.classList.remove('ed-set-origin-mode');
    if (setOriginBanner) setOriginBanner.hidden = true;
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

    svg.setPointerCapture(e.pointerId);
    pointerActive = true;
    downClient = { x: e.clientX, y: e.clientY };
    downTarget = e.target;

    // If the user pressed inside any selected object's hit area, and
    // no modifier is held, this drag is going to translate every
    // selected object in lockstep. The drawing tool's pointerDown is
    // skipped entirely. Modifier-press defers to pointerup so it can
    // be interpreted as a toggle-click instead of a move.
    const lineHit = e.target && e.target.closest
      ? e.target.closest('[data-line-id]') : null;
    const pressedSelected = lineHit && isSelected(lineHit.dataset.lineId);
    const modifier = e.metaKey || e.ctrlKey || e.shiftKey;
    if (pressedSelected && !modifier) {
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
        const modifier = e.shiftKey || e.metaKey || e.ctrlKey;

        let changed = false;
        if (modifier) {
          // Cmd/Shift-click toggles the topmost hit object in/out of
          // the selection. Empty-area modifier-click is a no-op (don't
          // accidentally deselect everything when the user just missed
          // a target). Cycle state is reset so a subsequent plain
          // click starts a fresh cycle.
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
          // clear it if the click hit empty canvas.
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
          renderSelectionPanel(modifier ? { suppressScroll: true } : undefined);
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
    // Skip remaining view shortcuts when a modifier is held — let
    // the browser handle Cmd+anything-else natively.
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'Escape') {
      // Escape cancels the set-rotate-origin gesture before anything
      // else, since it's the most "active" mode the user can be in.
      if (settingOrigin) { exitSetRotateOrigin(); return; }
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
})();
