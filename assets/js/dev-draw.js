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
  const newGroupBtn    = document.getElementById('new-group-btn');
  const newColorBtn    = document.getElementById('new-color-btn');
  const saveBtn        = document.getElementById('save-btn');
  const saveStatus     = document.getElementById('save-status');

  // Defensive: if any required element is missing, the user is probably
  // serving stale cached HTML against fresh JS (or vice-versa). Log
  // loudly so the cause is obvious in DevTools.
  const required = { svg, canvasWrap, gridG, linesG, previewG, toolSettingsEl,
                     groupsListEl, paletteListEl, selectionPanel,
                     newGroupBtn, newColorBtn, saveBtn, saveStatus };
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
    activeToolId:   'freehand',
    smoothing: true,
    chainPoints: null,         // active polyline points when lineChain is mid-chain
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
  const TOOLS = {
    freehand: {
      label: 'Freehand',
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
        this._points = [pt];
        this._preview = createPath('is-preview', pathFromPoints(this._points, false));
        previewG.appendChild(this._preview);
      },
      onPointerMove: function (pt) {
        if (!this._points) return;
        this._points.push(pt);
        this._preview.setAttribute('d', pathFromPoints(this._points, false));
      },
      onPointerUp: function () {
        if (!this._points) return;
        // Without smoothing: preserve nearly every captured point so the
        // stroke is faithful to the user's hand (including wobble).
        // With smoothing: drop most of the closely-spaced points first so
        // the quadratic-through-midpoints pass has room to actually round
        // out the curve — otherwise it ends up hugging every micro-jitter.
        const minDist = state.smoothing ? 22 : 2;
        const pts = simplify(this._points, minDist);
        const d = pathFromPoints(pts, state.smoothing);
        this._preview.remove();
        this._points = null;
        this._preview = null;
        if (d) commitLine(d);
      },
      cancel: function () {
        if (this._preview) this._preview.remove();
        this._points = null; this._preview = null;
      }
    },

    line: {
      label: 'Line',
      settings: function () { return []; },
      onPointerDown: function (pt) {
        this._start = pt;
        this._preview = createPath('is-preview', pathFromPoints([pt, pt], false));
        previewG.appendChild(this._preview);
      },
      onPointerMove: function (pt) {
        if (!this._start) return;
        this._preview.setAttribute('d', pathFromPoints([this._start, pt], false));
      },
      onPointerUp: function (pt) {
        if (!this._start) return;
        const start = this._start;
        this._preview.remove();
        this._start = null;
        this._preview = null;
        // Ignore zero-length clicks.
        const dx = pt.x - start.x, dy = pt.y - start.y;
        if (dx * dx + dy * dy < 1) return;
        commitLine(pathFromPoints([start, pt], false));
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
          commitLine(pathFromPoints(state.chainPoints, false));
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
  function commitLine(d) {
    if (!d) return;
    const line = {
      id: uid('l'),
      d: d,
      stroke: null,
      width: null,
      groupId: state.activeGroupId,
      overrides: {}
    };
    state.lines.push(line);
    state.selectedLineId = line.id;
    state.dirty = true;
    renderAll();
  }

  function deleteLine(id) {
    state.lines = state.lines.filter(function (l) { return l.id !== id; });
    if (state.selectedLineId === id) state.selectedLineId = null;
    state.dirty = true;
    renderAll();
  }

  function addGroup() {
    const g = defaultGroup();
    g.name = 'Group ' + (state.groups.length + 1);
    state.groups.push(g);
    state.activeGroupId = g.id;
    state.selectedLineId = null;
    state.dirty = true;
    renderAll();
  }

  function deleteGroup(id) {
    if (state.groups.length <= 1) return;
    state.groups = state.groups.filter(function (g) { return g.id !== id; });
    // Re-home orphan lines into the first remaining group.
    const fallback = state.groups[0].id;
    state.lines.forEach(function (l) { if (l.groupId === id) l.groupId = fallback; });
    if (state.activeGroupId === id) state.activeGroupId = fallback;
    state.dirty = true;
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
  }

  function updateGroupDefaults(id, patch) {
    const g = state.groups.find(function (g) { return g.id === id; });
    if (!g) return;
    g.defaults = Object.assign({}, g.defaults, patch);
    state.dirty = true;
    // Stroke/width default changes affect canvas rendering of every line
    // that doesn't override them.
    if ('stroke' in patch || 'width' in patch) renderLines();
  }

  function updateLine(id, patch) {
    const l = state.lines.find(function (l) { return l.id === id; });
    if (!l) return;
    Object.assign(l, patch);
    state.dirty = true;
    renderLines();
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
    // Keep the override-marker (*) in the sidebar in sync, but don't
    // rebuild the selection panel — the user is editing fields in it.
    renderGroupsList();
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
      const p = createPath('', line.d);
      const group = state.groups.find(function (g) { return g.id === line.groupId; });
      // Effective stroke / width: line value wins, then group default,
      // else fall back to the editor's CSS rule.
      const strokeRef = line.stroke || (group && group.defaults && group.defaults.stroke) || null;
      const stroke    = resolveStroke(strokeRef);
      const width  = (line.width != null) ? line.width
                   : (group && group.defaults && group.defaults.width != null ? group.defaults.width : null);
      if (stroke) p.style.stroke = stroke;
      if (width)  p.style.strokeWidth = width;
      if (line.id === state.selectedLineId) p.classList.add('is-selected');
      p.dataset.lineId = line.id;
      p.addEventListener('click', function (e) {
        e.stopPropagation();
        state.selectedLineId = line.id;
        renderLines();
        renderSelectionPanel();
      });
      linesG.appendChild(p);
    });
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
        // Closing a group deselects any line that belongs to it —
        // a hidden line shouldn't stay "selected".
        if (wasOpen && state.selectedLineId) {
          const sel = state.lines.find(function (l) { return l.id === state.selectedLineId; });
          if (sel && sel.groupId === g.id) state.selectedLineId = null;
        }
        renderGroupsList();
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
          idSpan.className = 'ed-line-id';
          idSpan.textContent = line.id;
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
        renderAll();
      });

      li.appendChild(sw);
      li.appendChild(nameInp);
      li.appendChild(valInp);
      li.appendChild(del);
      paletteListEl.appendChild(li);
    });
  }

  function addColor() {
    state.palette.push({
      id: uid('c'),
      name: 'Color ' + (state.palette.length + 1),
      value: '#888888'
    });
    state.dirty = true;
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

    selectionPanel.appendChild(wrap);

    if (state.groups.length > 1) {
      const actions = document.createElement('div');
      actions.className = 'ed-actions';
      const del = document.createElement('button');
      del.className = 'ed-danger';
      del.textContent = 'Delete group';
      del.addEventListener('click', function () {
        if (confirm('Delete group "' + g.name + '"? Its lines will move to the first remaining group.')) {
          deleteGroup(g.id);
        }
      });
      actions.appendChild(del);
      selectionPanel.appendChild(actions);
    }
  }

  function renderLinePanel(line) {
    const group = state.groups.find(function (g) { return g.id === line.groupId; });
    const head = document.createElement('header');
    head.className = 'ed-panel-head';
    head.innerHTML = '<h3>Line override</h3>';
    selectionPanel.appendChild(head);

    const meta = document.createElement('p');
    meta.style.color = '#888';
    meta.style.fontSize = '0.85em';
    meta.style.margin = '0 0 0.5rem';
    meta.innerHTML = 'id <code>' + line.id + '</code> · group <strong>' + (group ? group.name : '?') + '</strong> · empty = use group default';
    selectionPanel.appendChild(meta);

    const wrap = document.createElement('div');
    wrap.className = 'ed-settings';

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

  // Center the page area in the scrollable canvas on first load so the
  // user starts looking at the live viewport rather than empty off-page
  // space. The surface is 2400×1600; the page area starts at SVG pixel
  // (600, 400) — center the wrap on that point.
  function centerOnPage() {
    const wrap = canvasWrap;
    wrap.scrollLeft = 600 + PAGE_W / 2 - wrap.clientWidth  / 2;
    wrap.scrollTop  = 400 + PAGE_H / 2 - wrap.clientHeight / 2;
  }

  // Canvas click on empty area deselects the current line.
  svg.addEventListener('click', function () {
    state.selectedLineId = null;
    renderLines();
    renderSelectionPanel();
  });

  // Pointer events → active tool. Pointer capture keeps the stroke
  // alive even if the cursor leaves the SVG mid-drag.
  let pointerActive = false;
  svg.addEventListener('pointerdown', function (e) {
    if (e.button !== 0) return;
    e.preventDefault();
    svg.setPointerCapture(e.pointerId);
    pointerActive = true;
    const tool = TOOLS[state.activeToolId];
    if (tool && tool.onPointerDown) tool.onPointerDown(eventPt(e));
  });
  svg.addEventListener('pointermove', function (e) {
    const tool = TOOLS[state.activeToolId];
    if (!tool) return;
    // For chain mode, preview tracks cursor even without an active press.
    if (state.activeToolId === 'lineChain') {
      if (tool.onPointerMove) tool.onPointerMove(eventPt(e));
      return;
    }
    if (!pointerActive) return;
    if (tool.onPointerMove) tool.onPointerMove(eventPt(e));
  });
  svg.addEventListener('pointerup', function (e) {
    pointerActive = false;
    const tool = TOOLS[state.activeToolId];
    if (tool && tool.onPointerUp) tool.onPointerUp(eventPt(e));
  });
  svg.addEventListener('dblclick', function (e) {
    const tool = TOOLS[state.activeToolId];
    if (tool && tool.finish) { e.preventDefault(); tool.finish(); }
  });

  window.addEventListener('keydown', function (e) {
    if (e.target && /^(input|textarea|select)$/i.test(e.target.tagName)) return;
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
    if (e.key === 'f' || e.key === 'F') setActiveTool('freehand');
    if (e.key === 'l' || e.key === 'L') setActiveTool('line');
    if (e.key === 'c' || e.key === 'C') setActiveTool('lineChain');
  });

  // Warn before navigating away with unsaved changes.
  window.addEventListener('beforeunload', function (e) {
    if (state.dirty) { e.preventDefault(); e.returnValue = ''; }
  });

  // Initial render.
  renderGrid();
  setActiveTool('freehand');
  renderAll();
  centerOnPage();
})();
