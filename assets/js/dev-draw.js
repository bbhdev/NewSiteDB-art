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
  function isLocal(master, keyPath) {
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
        ['src', 'Image URL', 'text'],
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
      if (BEHAVIOR_KEYS.indexOf(k) !== -1) {
        cleanOverrides[k] = ov[k];
        return;
      }
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
    smoothing: true,
    chainPoints: null,         // active polyline points when lineChain is mid-chain
    bezierPoints: null,        // active bezier anchors when bezier is mid-draw
    zoom: 1,                   // canvas zoom factor (1 = 100%, 2 = 200%, …)
    // Editor-local view toggle, persisted to localStorage so it survives
    // reloads. When on, every named line gets a colored label rendered
    // next to it so the user can spot which is which in a busy canvas.
    showLabels: localStorage.getItem('ed-show-labels') === '1',
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
  // The "primary" selection is the most recently added id; the params
  // panel renders this one's fields when exactly one object is selected.
  function primarySelectedId() {
    return state.selectedIds.length
      ? state.selectedIds[state.selectedIds.length - 1] : null;
  }
  function allObjectsSelected() {
    return state.lines.length > 0 &&
           state.selectedIds.length === state.lines.length;
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
        <p>Drag a line row onto another group in the sidebar to move it between groups.</p>\
        <p><kbd>Cmd/Ctrl + Z</kbd> undoes; <kbd>Cmd/Ctrl + Shift + Z</kbd> redoes; <kbd>Esc</kbd> cancels the current gesture.</p>'
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
  function setVisualProp(lineId, keyPath, value) {
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
    state.dirty = true;
    snapshot();
    renderAll();
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
          if (BEHAVIOR_KEYS.indexOf(k) !== -1) {
            cleanOverrides[k] = src[k];
            return;
          }
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
          masterId:  mid,
          // Denormalized name for human readability of instances.json.
          // The resolver doesn't read it; kept fresh on every save.
          name:      (line.name != null && line.name !== '')
                       ? line.name
                       : (master && master.name ? master.name : line.id),
          visible:   !line.hidden,
          groupId:   line.groupId || null,
          positionOffset: { dx: offDx, dy: offDy },
          overrides: cleanOverrides
        };
      });
      byClass[cid] = { instances: instances, groups: groups };
    });

    // Drop unreferenced masters.
    const masters = Object.keys(masterMap)
      .filter(function (mid) { return usedMasterIds[mid]; })
      .map(function (mid) { return masterMap[mid]; });

    return { masters: masters, byClass: byClass };
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
        buttons: [
          { label: 'Cancel',                value: null },
          { label: 'Current class only',    value: 'current' },
          { label: 'Apply everywhere',      value: 'all', className: 'ed-primary' }
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
    const line = state.lines.find(function (l) { return l.id === lineId; });
    if (!line || line.groupId === newGroupId) return;
    line.groupId = newGroupId;
    // Auto-open the destination group so the user sees the move land.
    state.openGroupIds[newGroupId] = true;
    state.activeGroupId = newGroupId;
    state.dirty = true;
    snapshot();
    renderAll();
  }

  function addGroup() {
    // A new group is a site-wide concept (you almost always want it
    // on every screen-class), so create a same-name group in every
    // class. Each class gets its own id; rename / delete still acts
    // per-class. activeGroupId follows the one in the current class.
    const name = 'Group ' + (state.groups.length + 1);
    let activeIdForCurrentClass = null;
    state.pageConfig.useClasses.forEach(function (cid) {
      const bucket = state.byClass[cid];
      if (!bucket || !Array.isArray(bucket.groups)) return;
      const g = {
        id: uid('g'),
        name: name,
        trigger: null,
        defaults: { translateX: 0, translateY: -60, rotate: 0, drawIn: false }
      };
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
      state.lines = state.lines.filter(function (l) { return l.groupId !== id; });
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
    Object.assign(g, patch);
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
    state.dirty = true;
    renderLines();
    if ('name' in patch) renderGroupsList();
    if (typeof patch[Object.keys(patch)[0]] === 'boolean') snapshot();
    else scheduleSnapshot();
  }

  function updateLineOverride(id, key, value) {
    const l = state.lines.find(function (l) { return l.id === id; });
    if (!l) return;
    if (!l.overrides) l.overrides = {};
    if (value === '' || value === null || (typeof value === 'number' && isNaN(value))) {
      delete l.overrides[key];
    } else {
      l.overrides[key] = value;
    }
    state.dirty = true;
    renderGroupsList();
    if (typeof value === 'boolean' || value === null) snapshot();
    else scheduleSnapshot();
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

  // "Select all" toggles between every object selected and nothing
  // selected. It just drives the same selectedIds the modifier-click
  // path uses, so the rest of the UI (handles, panel, drag-to-move)
  // doesn't need a separate code path for the all-selected case.
  function toggleSelectAll() {
    if (allObjectsSelected()) clearSelection();
    else state.selectedIds = state.lines.map(function (l) { return l.id; });
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
    const ov  = line.overrides || {};
    const gd  = (group && group.defaults) || {};
    // Effective pivot = line override or group default. Either coord
    // missing → no custom pivot, no marker.
    const ox = Number.isFinite(ov.rotateOriginX) ? ov.rotateOriginX : gd.rotateOriginX;
    const oy = Number.isFinite(ov.rotateOriginY) ? ov.rotateOriginY : gd.rotateOriginY;
    if (!Number.isFinite(ox) || !Number.isFinite(oy)) return;
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
    state.groups.forEach(function (g) {
      const isOpen = !!state.openGroupIds[g.id];
      const li = document.createElement('li');
      li.className = 'ed-group'
        + (g.id === state.activeGroupId ? ' is-active' : '')
        + (isOpen ? ' is-open' : '');

      const row = document.createElement('div');
      row.className = 'ed-group-row';

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
      // Make group rows valid drop targets for lines dragged from the
      // sidebar — dropping a line here re-homes it into this group.
      row.addEventListener('dragenter', function (e) {
        if (e.dataTransfer && Array.from(e.dataTransfer.types).indexOf('text/x-line-id') !== -1) {
          e.preventDefault();
          row.classList.add('ed-drop-target');
        }
      });
      row.addEventListener('dragover', function (e) {
        if (e.dataTransfer && Array.from(e.dataTransfer.types).indexOf('text/x-line-id') !== -1) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
        }
      });
      row.addEventListener('dragleave', function () {
        row.classList.remove('ed-drop-target');
      });
      row.addEventListener('drop', function (e) {
        row.classList.remove('ed-drop-target');
        const lineId = e.dataTransfer && e.dataTransfer.getData('text/x-line-id');
        if (lineId) {
          e.preventDefault();
          moveLineToGroup(lineId, g.id);
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
          lr.draggable = true;
          lr.addEventListener('dragstart', function (e) {
            e.dataTransfer.setData('text/x-line-id', line.id);
            e.dataTransfer.effectAllowed = 'move';
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
            if (e.metaKey || e.ctrlKey || e.shiftKey) {
              toggleInSelection(line.id);
            } else {
              selectOnly(line.id);
            }
            state.activeGroupId  = g.id;
            state.openGroupIds[g.id] = true;
            updateSelectAllButton();
            renderGroupsList();
            renderLines();
            renderSelectionPanel();
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

  function renderSelectionPanel() {
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
    // When a single object is selected, scroll the sidebar so the
    // line panel is visible — saves the user from manually scrolling
    // past the groups list to reach params.
    if (wasSingleSelect && selectionPanel.scrollIntoView) {
      selectionPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
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
      state.selectedIds.forEach(function (id) { setVisualProp(id, 'stroke', v); });
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
    const del = document.createElement('button');
    del.className = 'ed-danger';
    del.textContent = 'Delete selected';
    del.addEventListener('click', function () {
      if (!confirm('Delete ' + n + ' objects? This can be undone (Cmd+Z).')) return;
      deleteSelected();
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
      // Cascade: clear line.stroke on every line in this group so the
      // new default actually paints. Group defaults are FALLBACKS in
      // the resolve order — without this, lines that already have an
      // explicit stroke would ignore the group change and the user
      // would see no visual update. setVisualProp routes through
      // master.scope, so the change propagates across classes.
      state.lines
        .filter(function (l) { return l.groupId === g.id; })
        .forEach(function (l) { setVisualProp(l.id, 'stroke', null); });
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
    const ov = line.overrides || {};
    wrap.appendChild(overrideNumberField('TranslateX', ov.translateX, group && group.defaults.translateX, function (v) { updateLineOverride(line.id, 'translateX', v); }));
    wrap.appendChild(overrideNumberField('TranslateY', ov.translateY, group && group.defaults.translateY, function (v) { updateLineOverride(line.id, 'translateY', v); }));
    wrap.appendChild(overrideNumberField('Rotate',     ov.rotate,     group && group.defaults.rotate,     function (v) { updateLineOverride(line.id, 'rotate', v); }));
    // Per-line rotation pivot — overrides the group default (or the
    // shape's natural center if the group also has none).
    wrap.appendChild(overrideNumberField('Rotate origin X', ov.rotateOriginX, group && group.defaults.rotateOriginX, function (v) { updateLineOverride(line.id, 'rotateOriginX', v); }));
    wrap.appendChild(overrideNumberField('Rotate origin Y', ov.rotateOriginY, group && group.defaults.rotateOriginY, function (v) { updateLineOverride(line.id, 'rotateOriginY', v); }));
    wrap.appendChild(setOriginButton(function () { startSetRotateOrigin({ type: 'line', id: line.id }); }));

    wrap.appendChild(overrideCheckboxField('Draw-in', ov.drawIn, group && group.defaults.drawIn, function (v) { updateLineOverride(line.id, 'drawIn', v); }));
    wrap.appendChild(overrideSelectField('Direction', ov.drawInDirection,
      group && group.defaults.drawInDirection || 'forward',
      [
        { value: 'forward', label: 'Begin → end' },
        { value: 'reverse', label: 'End → begin' }
      ],
      function (v) { updateLineOverride(line.id, 'drawInDirection', v); }));

    selectionPanel.appendChild(wrap);

    const actions = document.createElement('div');
    actions.className = 'ed-actions';
    const del = document.createElement('button');
    del.className = 'ed-danger';
    del.textContent = 'Delete line';
    del.addEventListener('click', function () {
      deleteLine(line.id);
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
    if (keyPath === 'kind' || keyPath === 'd'
        || keyPath === 'points' || keyPath === 'segments') return null;
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
    if (!tog) return field;
    field.classList.add('ed-master-linked');
    const master = state.masters.find(function (m) { return m.id === masterId; });
    if (master && isLocal(master, keyPath)) field.classList.add('is-overridden');
    field.appendChild(tog);
    return field;
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
          palette: state.palette,
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
  // Click the percentage to type an exact zoom value. Most fine-
  // grained way to dial in a target zoom for direct comparison with
  // the live page. Out-of-range / unparseable inputs are ignored.
  // (Reset to 100% is just typing 100.)
  zoomLevelEl.addEventListener('click', function () {
    const current = Math.round(state.zoom * 100);
    const input = prompt('Zoom percent (25 – 400):', current);
    if (input == null) return;
    const v = parseFloat(input);
    if (Number.isFinite(v) && v >= 25 && v <= 400) setZoom(v / 100);
  });
  zoomLevelEl.title = 'Click to type an exact zoom percentage';
  undoBtn.addEventListener('click', undo);
  redoBtn.addEventListener('click', redo);
  renderDiagGrid(); // initial paint if the flag was already on
  settingsBtn.addEventListener('click', showSettings);

  // Create-object wizard wiring.
  if (createObjectBtn) createObjectBtn.addEventListener('click', showCreateModal);

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
        updateGroupDefaults(settingOrigin.id, { rotateOriginX: x, rotateOriginY: y });
      } else if (settingOrigin.type === 'line') {
        updateLineOverride(settingOrigin.id, 'rotateOriginX', x);
        updateLineOverride(settingOrigin.id, 'rotateOriginY', y);
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
        }).filter(function (s) { return s; })
      };
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
        linesG.querySelectorAll('[data-line-id="' + line.id + '"]')
          .forEach(function (el) { el.setAttribute('d', line.d); });
      });
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
          renderSelectionPanel();
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
