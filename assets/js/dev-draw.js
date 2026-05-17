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
  // Editor SVG matches the runtime viewBox: -600 -400 2400 1600.
  // The central 1200×800 (0,0 → 1200,800) is the visible page area;
  // outside is off-page space for slide-in effects. Pointer events are
  // converted to logical viewBox coords by clientToSvg(), which reads
  // the viewBox attribute live so this works even after the surface
  // is scrolled or zoomed.
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const PAGE_W = 1200;
  const PAGE_H = 800;

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
  const labelsBtn      = document.getElementById('labels-btn');
  const selectAllBtn   = document.getElementById('select-all-btn');
  const newGroupBtn    = document.getElementById('new-group-btn');
  const newColorBtn    = document.getElementById('new-color-btn');
  const saveBtn        = document.getElementById('save-btn');
  const saveStatus     = document.getElementById('save-status');
  const clearLinesBtn  = document.getElementById('clear-lines-btn');
  const helpBtn        = document.getElementById('help-btn');

  // Defensive: if any required element is missing, the user is probably
  // serving stale cached HTML against fresh JS (or vice-versa). Log
  // loudly so the cause is obvious in DevTools.
  const zoomInBtn    = document.getElementById('zoom-in');
  const zoomOutBtn   = document.getElementById('zoom-out');
  const zoomLevelEl  = document.getElementById('zoom-level');
  const undoBtn      = document.getElementById('undo-btn');
  const redoBtn      = document.getElementById('redo-btn');

  const required = { svg, canvasWrap, gridG, linesG, previewG, handlesG,
                     labelsG, labelsBtn, selectAllBtn,
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

  // ── State ─────────────────────────────────────────────────────────
  const initial = JSON.parse(document.getElementById('editor-data').textContent);
  const state = {
    pageId: initial.pageId,
    groups: initial.groups.length ? initial.groups : [defaultGroup()],
    lines:  initial.lines,
    palette: initial.palette && initial.palette.length ? initial.palette : defaultPalette(),
    openGroupIds:   {},        // groupId → true when expanded in sidebar
    activeGroupId:  null,
    selectedLineId: null,
    activeToolId:   'select',  // neutral on first load — no accidental strokes
    smoothing: true,
    chainPoints: null,         // active polyline points when lineChain is mid-chain
    bezierPoints: null,        // active bezier anchors when bezier is mid-draw
    allSelected: false,        // "Select all" mode — drag anywhere moves every line
    zoom: 1,                   // canvas zoom factor (1 = 100%, 2 = 200%, …)
    // Editor-local view toggle, persisted to localStorage so it survives
    // reloads. When on, every named line gets a colored label rendered
    // next to it so the user can spot which is which in a busy canvas.
    showLabels: localStorage.getItem('ed-show-labels') === '1',
    dirty: false
  };
  state.activeGroupId = state.groups[0].id;
  state.openGroupIds[state.activeGroupId] = true;

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
        <p>Click an existing line on the canvas to select it. Drag its body to move; drag handles to reshape. Click the same spot again to cycle to a line beneath.</p>\
        <p>Groups in the sidebar are labeled <strong>G1, G2, …</strong>; the same prefix appears on canvas labels (toggle <kbd>Labels</kbd>) so you can match them up.</p>\
        <p>Drag a line row onto another group in the sidebar to move it between groups.</p>\
        <p><kbd>Cmd/Ctrl + Z</kbd> undoes; <kbd>Cmd/Ctrl + Shift + Z</kbd> redoes; <kbd>Esc</kbd> cancels the current gesture.</p>'
    },
    select: {
      title: 'Select mode',
      html: '\
        <p>Neutral mode — no drawing happens. Click a tool to switch back to drawing.</p>\
        <ul>\
          <li><strong>Click</strong> on a line to select it.</li>\
          <li><strong>Click again</strong> at the same spot to cycle to the next line beneath.</li>\
          <li><strong>Drag</strong> a selected line\'s body to move the whole shape.</li>\
          <li><strong>Drag handles</strong> (cyan dots) to reshape — point handles on free-form lines, parameter handles on primitives.</li>\
          <li><strong>Esc</strong> or empty-canvas click to deselect.</li>\
          <li><strong>Backspace</strong> / Delete to remove the selected line.</li>\
        </ul>\
        <p>Use the <kbd>Select all</kbd> button alongside this one to grab every line at once and drag them in lockstep.</p>'
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

  function snapshot() {
    if (snapshotTimer) { clearTimeout(snapshotTimer); snapshotTimer = null; }
    const snap = {
      groups:  deepCopy(state.groups),
      lines:   deepCopy(state.lines),
      palette: deepCopy(state.palette),
      selectedLineId: state.selectedLineId,
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
    state.groups  = deepCopy(snap.groups);
    state.lines   = deepCopy(snap.lines);
    state.palette = deepCopy(snap.palette);
    state.selectedLineId = snap.selectedLineId;
    state.activeGroupId  = snap.activeGroupId;
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
  // away from its base 2400×1600 pixel size. The viewBox stays fixed
  // at -600 -400 2400 1600, so authored coordinates don't change with
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
    svg.style.width  = (2400 * newZoom) + 'px';
    svg.style.height = (1600 * newZoom) + 'px';

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
      } else if (C === 'Z') {
        segments.push({ cmd: 'Z', controlPoints: [], endpoint: null });
      }
    }
    return segments;
  }

  function segmentsToD(segments) {
    return segments.map(function (s) {
      if (s.cmd === 'Z' || !s.endpoint) return 'Z';
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
  function regenerateLineD(line) {
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

  /**
   * Apply a translation (dx, dy) to a line's authored form.
   *   - Geometric primitives shift only their position keys (cx/cy or
   *     x/y) so the whole shape moves rigidly without distortion.
   *   - Manual lines shift every point AND every segment control point
   *     so authored curves keep their shape.
   *   - Everything else just shifts points.
   */
  function translateLine(line, origPoints, origSegments, origParams, dx, dy) {
    if (PRIMITIVES[line.kind] && origParams) {
      const keys = PRIMITIVES[line.kind].positionKeys;
      line.params = Object.assign({}, origParams);
      keys.forEach(function (k, i) {
        if (k in origParams) {
          line.params[k] = origParams[k] + (i === 0 ? dx : dy);
        }
      });
      regenerateLineD(line);
      return;
    }
    if (!origPoints) return;
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
    regenerateLineD(line);
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
    }
  };

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
      label: 'Select',
      settings: function () {
        // Accent-bordered ⓘ button — opens a help panel describing
        // what selection mode can do. Discoverable and clearly
        // clickable (the previous dim-gray glyph was easy to miss).
        // Built on the generic showHelp() so adding more topics is
        // just another entry in HELP_TOPICS.
        const info = document.createElement('button');
        info.type = 'button';
        info.className = 'ed-info-btn';
        info.textContent = 'ⓘ';
        info.title = 'Help — Select mode';
        info.addEventListener('click', function () { showHelp('select'); });
        return [info];
      }
      // No onPointerDown / onPointerMove / onPointerUp — dispatcher
      // calls them through `tool && tool.onPointerDown ? ...` etc., so
      // their absence is a clean no-op.
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
    toolButtons.forEach(function (b) { b.classList.toggle('is-active', b.dataset.tool === id); });
    renderToolSettings();
  }

  function renderToolSettings() {
    toolSettingsEl.innerHTML = '';
    const tool = TOOLS[state.activeToolId];
    if (tool && tool.settings) {
      tool.settings().forEach(function (el) { toolSettingsEl.appendChild(el); });
    }
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
      groupId: state.activeGroupId,
      overrides: {}
    };
    regenerateLineD(line);
    if (!line.d) return;
    state.lines.push(line);
    state.selectedLineId = line.id;
    state.dirty = true;
    snapshot();
    renderAll();
  }

  function deleteLine(id) {
    state.lines = state.lines.filter(function (l) { return l.id !== id; });
    if (state.selectedLineId === id) state.selectedLineId = null;
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
    const g = defaultGroup();
    g.name = 'Group ' + (state.groups.length + 1);
    state.groups.push(g);
    state.activeGroupId = g.id;
    state.selectedLineId = null;
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
    state.selectedLineId = null;
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
  function createPath(cls, d) {
    const p = document.createElementNS(SVG_NS, 'path');
    if (cls) p.setAttribute('class', cls);
    if (d)   p.setAttribute('d', d);
    return p;
  }

  function renderGrid() {
    gridG.innerHTML = '';
    // Grid covers only the page area (0–1200, 0–800). Off-page space
    // stays solid #181818 so the user can see which side of the live
    // viewport they're authoring in.
    for (let x = 100; x < PAGE_W; x += 100) {
      const l = document.createElementNS(SVG_NS, 'line');
      l.setAttribute('x1', x); l.setAttribute('x2', x);
      l.setAttribute('y1', 0); l.setAttribute('y2', PAGE_H);
      gridG.appendChild(l);
    }
    for (let y = 100; y < PAGE_H; y += 100) {
      const l = document.createElementNS(SVG_NS, 'line');
      l.setAttribute('x1', 0); l.setAttribute('x2', PAGE_W);
      l.setAttribute('y1', y); l.setAttribute('y2', y);
      gridG.appendChild(l);
    }
  }

  function resolveStroke(ref) {
    if (!ref) return null;
    const entry = state.palette.find(function (p) { return p.id === ref; });
    return entry ? entry.value : ref; // legacy literal fallback
  }

  function renderLines() {
    linesG.innerHTML = '';
    state.lines.forEach(function (line) {
      const group = state.groups.find(function (g) { return g.id === line.groupId; });

      // Invisible wide hit-target so the line is easy to click for
      // selection — picking a 1.5px stroke pixel-perfectly is awful.
      // The hit target carries the data-line-id; click resolution
      // happens in the SVG pointerup dispatcher.
      const hit = createPath('ed-line-hit', line.d);
      hit.dataset.lineId = line.id;
      linesG.appendChild(hit);

      // Visible path.
      const p = createPath('', line.d);
      const strokeRef = line.stroke || (group && group.defaults && group.defaults.stroke) || null;
      const stroke    = resolveStroke(strokeRef);
      const width  = (line.width != null) ? line.width
                   : (group && group.defaults && group.defaults.width != null ? group.defaults.width : null);
      if (stroke) p.style.stroke = stroke;
      if (width)  p.style.strokeWidth = width;
      // Fill rules:
      //   - `filled` is the source of truth when set explicitly
      //     (true for primitives, true for closed-loop freehand, etc.)
      //   - falls back to `closed` for legacy data without `filled`
      const wantsFill = line.filled !== undefined ? !!line.filled : !!line.closed;
      if (wantsFill && stroke) p.style.fill = stroke;
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
      if (line.id === state.selectedLineId) p.classList.add('is-selected');
      // Hidden lines stay visible in the editor (so the user can find
      // them and re-enable) but render at low opacity so they read as
      // "off". The runtime drops them entirely.
      if (line.hidden) p.style.opacity = '0.18';
      p.dataset.lineId = line.id;
      linesG.appendChild(p);
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

      // Now that text is in the DOM, measure it and build the double-
      // border rect behind it: outer rect with black 2px stroke +
      // line-color fill, then inner rect 1px inside with a white 1px
      // stroke. The two strokes interleave so the border reads against
      // any background.
      const bb = text.getBBox();
      const pad = 4;
      const outer = document.createElementNS(SVG_NS, 'rect');
      outer.setAttribute('class', 'ed-label-bg-outer');
      outer.setAttribute('x',      (bb.x - pad).toFixed(1));
      outer.setAttribute('y',      (bb.y - pad).toFixed(1));
      outer.setAttribute('width',  (bb.width  + pad * 2).toFixed(1));
      outer.setAttribute('height', (bb.height + pad * 2).toFixed(1));
      outer.setAttribute('rx', 3);
      outer.style.fill = fill;
      g.insertBefore(outer, text);

      const inner = document.createElementNS(SVG_NS, 'rect');
      inner.setAttribute('class', 'ed-label-bg-inner');
      inner.setAttribute('x',      (bb.x - pad + 1).toFixed(1));
      inner.setAttribute('y',      (bb.y - pad + 1).toFixed(1));
      inner.setAttribute('width',  (bb.width  + pad * 2 - 2).toFixed(1));
      inner.setAttribute('height', (bb.height + pad * 2 - 2).toFixed(1));
      inner.setAttribute('rx', 2);
      g.insertBefore(inner, text);
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
    labelsBtn.classList.toggle('is-active', state.showLabels);
    renderLabels();
  }

  function toggleSelectAll() {
    state.allSelected = !state.allSelected;
    // Stepping into select-all clears any single-line selection so the
    // user doesn't see two competing UI states (selected line handles
    // + select-all banner). Stepping out leaves no selection either.
    state.selectedLineId = null;
    updateSelectAllButton();
    renderLines();
    renderSelectionPanel();
  }

  function updateSelectAllButton() {
    selectAllBtn.classList.toggle('is-active', state.allSelected);
    selectAllBtn.textContent = state.allSelected ? 'Deselect all' : 'Select all';
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
    // Select-all mode: one accent-colored marker per line at its
    // visual center instead of per-vertex handles. Communicates "all
    // selected" without flooding the canvas with handles.
    if (state.allSelected) {
      renderAllSelectedMarkers();
      return;
    }
    if (!state.selectedLineId) return;
    const line = state.lines.find(function (l) { return l.id === state.selectedLineId; });
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
      });
      c.addEventListener('pointerup', function (e) {
        if (!dragging) return;
        e.stopPropagation();
        dragging = false;
        c.classList.remove('is-dragging');
        snapshot();
        renderHandles();
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

  function renderAllSelectedMarkers() {
    const r = 7 / state.zoom;
    state.lines.forEach(function (line) {
      if (line.hidden) return;
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
      row.addEventListener('click', function () {
        const wasOpen = !!state.openGroupIds[g.id];
        state.activeGroupId = g.id;
        state.openGroupIds[g.id] = !wasOpen;
        // Clicking a group row always means "this group is the focus
        // now" — drop any leftover line selection so the next edit
        // goes to the group's settings, not to a stale line. Also
        // re-render the lines layer so the handle dots from the
        // previously selected line disappear with it.
        state.selectedLineId = null;
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
          lr.className = 'ed-line-row' + (line.id === state.selectedLineId ? ' is-selected' : '');
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
            state.selectedLineId = line.id;
            state.activeGroupId  = g.id;
            state.openGroupIds[g.id] = true;
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
    state.selectedLineId = null;
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
    // Line selection takes precedence over group selection.
    if (state.selectedLineId) {
      const line  = state.lines.find(function (l) { return l.id === state.selectedLineId; });
      if (line) renderLinePanel(line);
    } else if (state.activeGroupId) {
      const g = state.groups.find(function (g) { return g.id === state.activeGroupId; });
      if (g) renderGroupPanel(g);
    }
  }

  function renderGroupPanel(g) {
    const head = document.createElement('header');
    head.className = 'ed-panel-head';
    head.innerHTML = '<h3>Group settings</h3>';
    selectionPanel.appendChild(head);

    const wrap = document.createElement('div');
    wrap.className = 'ed-settings';

    wrap.appendChild(textField('Name', g.name, function (v) { updateGroup(g.id, { name: v }); }));
    wrap.appendChild(triggerField('Trigger', g.trigger || '', function (v) {
      updateGroup(g.id, { trigger: v.trim() === '' ? null : v.trim() });
    }));

    wrap.appendChild(divider('Appearance'));
    wrap.appendChild(strokeField('Color', g.defaults.stroke, function (v) {
      updateGroupDefaults(g.id, { stroke: v });
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

    // Delete is always available. Empty groups: a single confirm.
    // Non-empty groups: a custom 3-button dialog so the choice
    // (Cancel / Group only / Group + lines) is one prompt instead of
    // two chained confirms.
    const actions = document.createElement('div');
    actions.className = 'ed-actions';
    const del = document.createElement('button');
    del.className = 'ed-danger';
    del.textContent = 'Delete group';
    del.addEventListener('click', async function () {
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
    });
    actions.appendChild(del);
    selectionPanel.appendChild(actions);
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

    wrap.appendChild(textField('Name', line.name || '', function (v) {
      updateLine(line.id, { name: v });
    }, 'optional'));

    // Visibility — toggle off to hide on the live site without
    // deleting. Useful for trying variants. Renders faded in the
    // editor; runtime skips entirely.
    wrap.appendChild(checkboxField('Visible', !line.hidden, function (v) {
      updateLine(line.id, { hidden: !v });
    }));

    // Smoothing toggle is only meaningful for the freehand kinds — for
    // straight-line and chain kinds the regenerator ignores it.
    if (line.kind === 'freehand' || line.kind === 'freehandClosed') {
      wrap.appendChild(checkboxField('Smooth', !!line.smoothed, function (v) {
        updateLine(line.id, { smoothed: v });
      }));
    }

    // Primitive parameters (cx/cy/r for circle, w/h/r for rect, etc.).
    // Editing any value regenerates the path live.
    if (PRIMITIVES[line.kind] && line.params) {
      wrap.appendChild(divider('Parameters'));
      const PRIM = PRIMITIVES[line.kind];
      PRIM.paramFields.forEach(function (entry) {
        const key = entry[0], label = entry[1];
        wrap.appendChild(numberField(label, line.params[key], function (v) {
          line.params = Object.assign({}, line.params, function () {
            const patch = {}; patch[key] = v; return patch;
          }());
          regenerateLineD(line);
          state.dirty = true;
          renderLines();
          scheduleSnapshot();
        }));
      });
      wrap.appendChild(checkboxField('Filled', !!line.filled, function (v) {
        updateLine(line.id, { filled: v });
      }));
    }

    wrap.appendChild(divider('Appearance'));
    wrap.appendChild(strokeField('Color', line.stroke, function (v) {
      updateLine(line.id, { stroke: v });
    }));
    wrap.appendChild(overrideNumberField('Line width', line.width, group && group.defaults.width, function (v) {
      updateLine(line.id, { width: v });
    }));

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
      const res = await fetch('/dev/draw/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          page:    state.pageId,
          groups:  state.groups,
          lines:   state.lines,
          palette: state.palette
        })
      });
      const body = await res.json().catch(function () { return {}; });
      if (!res.ok || !body.ok) {
        throw new Error(body.error || ('HTTP ' + res.status));
      }
      state.dirty = false;
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
  zoomLevelEl.addEventListener('click', zoomReset);
  undoBtn.addEventListener('click', undo);
  redoBtn.addEventListener('click', redo);
  labelsBtn.addEventListener('click', toggleLabels);
  labelsBtn.classList.toggle('is-active', state.showLabels);
  selectAllBtn.addEventListener('click', toggleSelectAll);
  updateSelectAllButton();

  // Wheel zoom — requires Ctrl/Cmd modifier so plain wheel keeps
  // scrolling the canvas wrap normally. Anchored to the cursor so
  // the point under the pointer stays put across the zoom step.
  canvasWrap.addEventListener('wheel', function (e) {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    // Very fine 2.5% per tick — toolbar buttons use 1.25× for bigger
    // jumps; the wheel is for dialing in precise zoom levels.
    const factor = e.deltaY < 0 ? 1.025 : (1 / 1.025);
    setZoom(state.zoom * factor, e.clientX, e.clientY);
  }, { passive: false });

  // Center the page area in the scrollable canvas on first load so the
  // user starts looking at the live viewport rather than empty off-page
  // space. The surface is 2400×1600; the page area starts at SVG pixel
  // (600, 400) — center the wrap on that point.
  function centerOnPage() {
    const wrap = canvasWrap;
    wrap.scrollLeft = 600 + PAGE_W / 2 - wrap.clientWidth  / 2;
    wrap.scrollTop  = 400 + PAGE_H / 2 - wrap.clientHeight / 2;
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
  // Move-line mode: pressing inside the SELECTED line's hit area (but
  // not on one of its handles) starts translating the entire line.
  // Indispensable for big shapes where moving each handle would be
  // impractical. Reset on pointerup.
  let moveLine = null; // { lineId, startPt, origPoints, origSegments }
  // Move-all mode: when state.allSelected is on, a drag anywhere moves
  // every line on the page together. The original geometry of every
  // line is captured at drag start so the translation stays rigid.
  let moveAll = null;  // { startPt, origLines: [{ id, origPoints, origSegments, origParams }, …] }
  // Set-rotate-origin mode: the user clicked "Set on canvas →" in a
  // panel; the next canvas click writes that point into the active
  // target's rotateOriginX / Y, then mode exits.
  let settingOrigin = null; // { type: 'group'|'line', id: '…' }

  function startSetRotateOrigin(target) {
    settingOrigin = target;
    canvasWrap.classList.add('ed-set-origin-mode');
  }
  function exitSetRotateOrigin() {
    settingOrigin = null;
    canvasWrap.classList.remove('ed-set-origin-mode');
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

    // Select-all mode: any drag (anywhere) translates every line in
    // lockstep. A pure click (no drag) exits select-all and proceeds
    // to regular single-line selection.
    if (state.allSelected) {
      moveAll = {
        startPt: eventPt(e),
        origLines: state.lines.map(function (l) {
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
            origParams: l.params ? Object.assign({}, l.params) : null
          };
        })
      };
      return;
    }

    // If the user pressed inside the currently selected line's hit
    // area, this drag is going to translate the whole line, not start
    // a new stroke. The drawing tool's pointerDown is skipped entirely.
    const lineHit = e.target && e.target.closest
      ? e.target.closest('[data-line-id]') : null;
    if (lineHit && lineHit.dataset.lineId === state.selectedLineId) {
      const line = state.lines.find(function (l) { return l.id === state.selectedLineId; });
      if (line) {
        moveLine = {
          lineId: line.id,
          startPt: eventPt(e),
          origPoints:   Array.isArray(line.points)
            ? line.points.map(function (p) { return { x: p.x, y: p.y }; })
            : null,
          origSegments: Array.isArray(line.segments)
            ? line.segments.map(function (s) {
                return {
                  cmd: s.cmd,
                  controlPoints: s.controlPoints.map(function (cp) { return { x: cp.x, y: cp.y }; }),
                  endpoint: s.endpoint ? { x: s.endpoint.x, y: s.endpoint.y } : null
                };
              })
            : null,
          origParams: line.params ? Object.assign({}, line.params) : null
        };
      }
      return; // skip tool dispatch
    }

    const tool = TOOLS[state.activeToolId];
    if (tool && tool.onPointerDown) tool.onPointerDown(eventPt(e));
  });
  svg.addEventListener('pointermove', function (e) {
    if (moveAll) {
      const cur = eventPt(e);
      const dx = cur.x - moveAll.startPt.x;
      const dy = cur.y - moveAll.startPt.y;
      moveAll.origLines.forEach(function (snap) {
        const line = state.lines.find(function (l) { return l.id === snap.id; });
        if (!line) return;
        translateLine(line, snap.origPoints, snap.origSegments, snap.origParams, dx, dy);
        linesG.querySelectorAll('[data-line-id="' + line.id + '"]')
          .forEach(function (el) { el.setAttribute('d', line.d); });
      });
      state.dirty = true;
      renderHandles(); // accent select-all dots follow their lines
      renderLabels();  // labels follow their lines too
      return;
    }
    if (moveLine) {
      const cur = eventPt(e);
      const dx = cur.x - moveLine.startPt.x;
      const dy = cur.y - moveLine.startPt.y;
      const line = state.lines.find(function (l) { return l.id === moveLine.lineId; });
      if (line) {
        translateLine(line, moveLine.origPoints, moveLine.origSegments, moveLine.origParams, dx, dy);
        state.dirty = true;
        // Sync every visual piece tied to this line: hit + visible
        // path, handles, label.
        linesG.querySelectorAll('[data-line-id="' + line.id + '"]')
          .forEach(function (el) { el.setAttribute('d', line.d); });
        renderHandles();
        renderLabels();
      }
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
    // Select-all + drag → commit translation of every line. Pure click
    // in select-all → exit select-all and proceed to normal selection.
    if (moveAll) {
      const dxAll = downClient ? (e.clientX - downClient.x) : 0;
      const dyAll = downClient ? (e.clientY - downClient.y) : 0;
      const dragged = (dxAll * dxAll + dyAll * dyAll) > 9;
      moveAll = null;
      if (dragged) {
        snapshot();
        downClient = null; downTarget = null;
        return;
      }
      // Pure click — turn off select-all; fall through to single-line selection.
      state.allSelected = false;
      updateSelectAllButton();
    }
    // If the user pressed on the selected line's hit area and then
    // actually dragged, commit the move. A pure click (no drag) falls
    // through to the selection-cycle path below so the user can step
    // down to a shape covered by the current one.
    let wasMoveLine = false;
    if (moveLine) {
      wasMoveLine = true;
      const dxMove = downClient ? (e.clientX - downClient.x) : 0;
      const dyMove = downClient ? (e.clientY - downClient.y) : 0;
      const dragged = (dxMove * dxMove + dyMove * dyMove) > 9; // ~3px slop
      moveLine = null;
      if (dragged) {
        snapshot();
        downClient = null;
        downTarget = null;
        return;
      }
      // else: fall through to selection logic (don't dispatch to a
      // drawing tool's onPointerUp since pointerDown was bypassed).
    }
    if (!wasMoveLine) {
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

        if (newSelection !== state.selectedLineId) {
          state.selectedLineId = newSelection;
          // Make the sidebar reflect the new selection: open the line's
          // group (so the highlighted row is actually visible) and make
          // it the active group too. Both renderGroupsList AND
          // renderLines run so the sidebar's row highlight and the
          // canvas's handle dots track the new selection.
          if (newSelection) {
            const sel = state.lines.find(function (l) { return l.id === newSelection; });
            if (sel && sel.groupId) {
              state.openGroupIds[sel.groupId] = true;
              state.activeGroupId = sel.groupId;
            }
          }
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
    if (e.target && /^(input|textarea|select)$/i.test(e.target.tagName)) return;
    // Skip tool / view shortcuts when a modifier is held (Cmd+S, Cmd+F,
    // etc. should stay native — not silently swap the active tool).
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'Escape') {
      // Escape cancels the set-rotate-origin gesture before anything
      // else, since it's the most "active" mode the user can be in.
      if (settingOrigin) { exitSetRotateOrigin(); return; }
      const tool = TOOLS[state.activeToolId];
      if (tool && tool.cancel) tool.cancel();
      state.selectedLineId = null;
      renderAll();
      return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (state.selectedLineId) { e.preventDefault(); deleteLine(state.selectedLineId); }
      return;
    }
    // Tool shortcuts
    if (e.key === 's' || e.key === 'S') setActiveTool('select');
    if (e.key === 'f' || e.key === 'F') setActiveTool('freehand');
    if (e.key === 'o' || e.key === 'O') setActiveTool('freehandClosed');
    if (e.key === 'l' || e.key === 'L') setActiveTool('line');
    if (e.key === 'c' || e.key === 'C') setActiveTool('lineChain');
    if (e.key === 'b' || e.key === 'B') setActiveTool('bezier');
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
  renderGrid();
  setActiveTool('select');
  snapshot();
  renderAll();
  centerOnPage();
})();
