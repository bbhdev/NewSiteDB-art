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
  const newGroupBtn    = document.getElementById('new-group-btn');
  const newColorBtn    = document.getElementById('new-color-btn');
  const saveBtn        = document.getElementById('save-btn');
  const saveStatus     = document.getElementById('save-status');
  const clearLinesBtn  = document.getElementById('clear-lines-btn');

  // Defensive: if any required element is missing, the user is probably
  // serving stale cached HTML against fresh JS (or vice-versa). Log
  // loudly so the cause is obvious in DevTools.
  const zoomInBtn    = document.getElementById('zoom-in');
  const zoomOutBtn   = document.getElementById('zoom-out');
  const zoomLevelEl  = document.getElementById('zoom-level');
  const undoBtn      = document.getElementById('undo-btn');
  const redoBtn      = document.getElementById('redo-btn');

  const required = { svg, canvasWrap, gridG, linesG, previewG, handlesG,
                     labelsG, labelsBtn,
                     toolSettingsEl, groupsListEl, paletteListEl,
                     selectionPanel, newGroupBtn, newColorBtn,
                     saveBtn, saveStatus, clearLinesBtn,
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
   * Apply a translation (dx, dy) to every authored point of a line —
   * for manual lines, that includes control points so curves move
   * rigidly with the path instead of warping.
   */
  function translateLine(line, origPoints, origSegments, dx, dy) {
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
        const span = document.createElement('span');
        span.style.color = '#888';
        span.textContent = 'click to select · drag to move · drag handles to reshape';
        return [span];
      }
      // No onPointerDown / onPointerMove / onPointerUp — dispatcher
      // calls them through `tool && tool.onPointerDown ? ...` etc., so
      // their absence is a clean no-op.
    },

    freehand:       makeFreehandTool(false, 'Freehand'),
    freehandClosed: makeFreehandTool(true,  'Closed loop'),

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
    if (!meta || !Array.isArray(meta.points) || meta.points.length < 1) return;
    const line = {
      id: uid('l'),
      kind:     meta.kind || 'manual',
      points:   meta.points.map(function (p) { return { x: p.x, y: p.y }; }),
      smoothed: !!meta.smoothed,
      closed:   !!meta.closed,
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

  function deleteGroup(id) {
    if (state.groups.length > 1) {
      state.groups = state.groups.filter(function (g) { return g.id !== id; });
      // Re-home orphan lines into the first remaining group.
      const fallback = state.groups[0].id;
      state.lines.forEach(function (l) { if (l.groupId === id) l.groupId = fallback; });
      if (state.activeGroupId === id) state.activeGroupId = fallback;
    } else {
      // Deleting the LAST group — replace it with a fresh default so
      // lines aren't orphaned. The user can rename it after; this
      // keeps "Delete group" always functional, including for a fresh
      // page with just one group.
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
      // Closed loops fill with the stroke color so the inside reads as
      // a solid blob.
      if (line.closed && stroke) p.style.fill = stroke;
      if (line.id === state.selectedLineId) p.classList.add('is-selected');
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
      if (!Array.isArray(line.points) || !line.points.length) return;
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
      text.textContent = line.name;
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

  // Label placement: middle vertex of the points array. Picks a point
  // actually on the line so the label is anchored visually — bbox
  // center could fall in empty space for a curved/open path.
  function labelPositionFor(line) {
    const pts = line.points;
    const mid = pts[Math.floor(pts.length / 2)];
    // Slight offset so the label sits above-right of the anchor point
    // instead of directly on top of the line.
    return { x: mid.x + 6, y: mid.y + 6 };
  }

  function toggleLabels() {
    state.showLabels = !state.showLabels;
    localStorage.setItem('ed-show-labels', state.showLabels ? '1' : '0');
    labelsBtn.classList.toggle('is-active', state.showLabels);
    renderLabels();
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
    if (!state.selectedLineId) return;
    const line = state.lines.find(function (l) { return l.id === state.selectedLineId; });
    if (!line || !Array.isArray(line.points) || !line.points.length) return;

    // Handle radius is in viewBox units, but we want a constant visual
    // size regardless of zoom — so divide by zoom.
    const handleR = 6 / state.zoom;
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

      // Pure-visual disclosure indicator. Rotation is CSS-driven via
      // .ed-group.is-open. The whole row is the click target.
      const toggle = document.createElement('span');
      toggle.className = 'ed-group-toggle';
      toggle.textContent = '▸';
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
      li.appendChild(row);

      // Inline list of lines belonging to this group. Hidden by CSS
      // when the group isn't open.
      const ll = document.createElement('ul');
      ll.className = 'ed-line-list';
      state.lines.filter(function (l) { return l.groupId === g.id; })
        .forEach(function (line) {
          const lr = document.createElement('li');
          lr.className = 'ed-line-row' + (line.id === state.selectedLineId ? ' is-selected' : '');
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
    wrap.appendChild(numberField('Width', g.defaults.width != null ? g.defaults.width : 1, function (v) {
      updateGroupDefaults(g.id, { width: v });
    }));

    wrap.appendChild(divider('Behavior defaults'));
    wrap.appendChild(numberField('TranslateX', g.defaults.translateX, function (v) { updateGroupDefaults(g.id, { translateX: v }); }));
    wrap.appendChild(numberField('TranslateY', g.defaults.translateY, function (v) { updateGroupDefaults(g.id, { translateY: v }); }));
    wrap.appendChild(numberField('Rotate',     g.defaults.rotate,     function (v) { updateGroupDefaults(g.id, { rotate: v }); }));
    wrap.appendChild(checkboxField('Draw-in', !!g.defaults.drawIn, function (v) { updateGroupDefaults(g.id, { drawIn: v }); }));
    wrap.appendChild(selectField('Direction', g.defaults.drawInDirection || 'forward', [
      { value: 'forward', label: 'Begin → end' },
      { value: 'reverse', label: 'End → begin' }
    ], function (v) { updateGroupDefaults(g.id, { drawInDirection: v }); }));

    selectionPanel.appendChild(wrap);

    // Delete is always available. When this is the last remaining
    // group, deleteGroup replaces it with a fresh default so existing
    // lines have somewhere to live.
    const actions = document.createElement('div');
    actions.className = 'ed-actions';
    const del = document.createElement('button');
    del.className = 'ed-danger';
    del.textContent = 'Delete group';
    del.addEventListener('click', function () {
      const lineCount = state.lines.filter(function (l) { return l.groupId === g.id; }).length;
      const msg = (state.groups.length > 1)
        ? 'Delete group "' + g.name + '"?' +
          (lineCount ? ' Its ' + lineCount + ' line' + (lineCount === 1 ? '' : 's') +
                       ' will move to the first remaining group.' : '')
        : 'Delete the only group "' + g.name + '"? It will be replaced with a fresh default group; existing lines are kept.';
      if (confirm(msg)) deleteGroup(g.id);
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

    // Smoothing toggle is only meaningful for the freehand kinds — for
    // straight-line and chain kinds the regenerator ignores it.
    if (line.kind === 'freehand' || line.kind === 'freehandClosed') {
      wrap.appendChild(checkboxField('Smooth', !!line.smoothed, function (v) {
        updateLine(line.id, { smoothed: v });
      }));
    }

    wrap.appendChild(divider('Appearance'));
    wrap.appendChild(strokeField('Color', line.stroke, function (v) {
      updateLine(line.id, { stroke: v });
    }));
    wrap.appendChild(overrideNumberField('Width', line.width, group && group.defaults.width, function (v) {
      updateLine(line.id, { width: v });
    }));

    wrap.appendChild(divider('Behavior'));
    const ov = line.overrides || {};
    wrap.appendChild(overrideNumberField('TranslateX', ov.translateX, group && group.defaults.translateX, function (v) { updateLineOverride(line.id, 'translateX', v); }));
    wrap.appendChild(overrideNumberField('TranslateY', ov.translateY, group && group.defaults.translateY, function (v) { updateLineOverride(line.id, 'translateY', v); }));
    wrap.appendChild(overrideNumberField('Rotate',     ov.rotate,     group && group.defaults.rotate,     function (v) { updateLineOverride(line.id, 'rotate', v); }));
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
  zoomInBtn.addEventListener('click',  function () { zoomIn();  });
  zoomOutBtn.addEventListener('click', function () { zoomOut(); });
  zoomLevelEl.addEventListener('click', zoomReset);
  undoBtn.addEventListener('click', undo);
  redoBtn.addEventListener('click', redo);
  labelsBtn.addEventListener('click', toggleLabels);
  labelsBtn.classList.toggle('is-active', state.showLabels);

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

  svg.addEventListener('pointerdown', function (e) {
    if (e.button !== 0) return;
    e.preventDefault();
    svg.setPointerCapture(e.pointerId);
    pointerActive = true;
    downClient = { x: e.clientX, y: e.clientY };
    downTarget = e.target;

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
          origPoints:   line.points.map(function (p) { return { x: p.x, y: p.y }; }),
          origSegments: Array.isArray(line.segments)
            ? line.segments.map(function (s) {
                return {
                  cmd: s.cmd,
                  controlPoints: s.controlPoints.map(function (cp) { return { x: cp.x, y: cp.y }; }),
                  endpoint: s.endpoint ? { x: s.endpoint.x, y: s.endpoint.y } : null
                };
              })
            : null
        };
      }
      return; // skip tool dispatch
    }

    const tool = TOOLS[state.activeToolId];
    if (tool && tool.onPointerDown) tool.onPointerDown(eventPt(e));
  });
  svg.addEventListener('pointermove', function (e) {
    if (moveLine) {
      const cur = eventPt(e);
      const dx = cur.x - moveLine.startPt.x;
      const dy = cur.y - moveLine.startPt.y;
      const line = state.lines.find(function (l) { return l.id === moveLine.lineId; });
      if (line) {
        translateLine(line, moveLine.origPoints, moveLine.origSegments, dx, dy);
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
    if (moveLine) {
      moveLine = null;
      snapshot();          // undo restores the entire pre-move position
      downClient = null;
      downTarget = null;
      return;
    }
    const tool = TOOLS[state.activeToolId];
    if (tool && tool.onPointerUp) tool.onPointerUp(eventPt(e));

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
