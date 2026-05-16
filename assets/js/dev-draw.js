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
  // Editor SVG uses the same viewBox as the runtime: 0 0 1200 800.
  const VB_W = 1200;
  const VB_H = 800;
  const SVG_NS = 'http://www.w3.org/2000/svg';

  // ── DOM refs ──────────────────────────────────────────────────────
  const svg        = document.getElementById('draw-surface');
  const gridG      = document.getElementById('grid');
  const linesG     = document.getElementById('committed-lines');
  const previewG   = document.getElementById('preview-layer');
  const toolButtons = document.querySelectorAll('.ed-tool');
  const toolSettingsEl = document.getElementById('tool-settings');
  const groupsListEl   = document.getElementById('groups-list');
  const selectionPanel = document.getElementById('selection-panel');
  const newGroupBtn    = document.getElementById('new-group-btn');
  const saveBtn        = document.getElementById('save-btn');
  const saveStatus     = document.getElementById('save-status');

  // ── State ─────────────────────────────────────────────────────────
  const initial = JSON.parse(document.getElementById('editor-data').textContent);
  const state = {
    pageId: initial.pageId,
    groups: initial.groups.length ? initial.groups : [defaultGroup()],
    lines:  initial.lines,
    activeGroupId:  null,
    selectedLineId: null,
    activeToolId:   'freehand',
    smoothing: true,
    chainPoints: null,  // active polyline points when lineChain is mid-chain
    dirty: false
  };
  state.activeGroupId = state.groups[0].id;

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
  function clientToSvg(clientX, clientY) {
    const rect = svg.getBoundingClientRect();
    return {
      x: ((clientX - rect.left) / rect.width)  * VB_W,
      y: ((clientY - rect.top)  / rect.height) * VB_H
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
        const pts = simplify(this._points, 3);
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
        span.textContent = state.chainPoints ? 'chain: ' + state.chainPoints.length + ' pts — Esc to finish' : 'click to start a chain';
        return [span];
      },
      onPointerDown: function (pt) {
        if (!state.chainPoints) {
          state.chainPoints = [pt];
          renderToolSettings();
          return;
        }
        const prev = state.chainPoints[state.chainPoints.length - 1];
        const dx = pt.x - prev.x, dy = pt.y - prev.y;
        if (dx * dx + dy * dy < 1) return; // ignore double-click duplicates
        commitLine(pathFromPoints([prev, pt], false));
        state.chainPoints.push(pt);
        renderToolSettings();
      },
      onPointerMove: function (pt) {
        if (!state.chainPoints) return;
        const prev = state.chainPoints[state.chainPoints.length - 1];
        if (!this._preview) {
          this._preview = createPath('is-preview', pathFromPoints([prev, pt], false));
          previewG.appendChild(this._preview);
        } else {
          this._preview.setAttribute('d', pathFromPoints([prev, pt], false));
        }
      },
      onPointerUp: function () { /* commits happen on down for chain */ },
      finish: function () {
        if (this._preview) this._preview.remove();
        this._preview = null;
        state.chainPoints = null;
        renderToolSettings();
      },
      cancel: function () { this.finish(); }
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
    renderGroupsList();
    renderSelectionPanel();
  }

  function updateGroupDefaults(id, patch) {
    const g = state.groups.find(function (g) { return g.id === id; });
    if (!g) return;
    g.defaults = Object.assign({}, g.defaults, patch);
    state.dirty = true;
    renderSelectionPanel();
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
    renderSelectionPanel();
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
    for (let x = 100; x < VB_W; x += 100) {
      const l = document.createElementNS(SVG_NS, 'line');
      l.setAttribute('x1', x); l.setAttribute('x2', x);
      l.setAttribute('y1', 0); l.setAttribute('y2', VB_H);
      gridG.appendChild(l);
    }
    for (let y = 100; y < VB_H; y += 100) {
      const l = document.createElementNS(SVG_NS, 'line');
      l.setAttribute('x1', 0); l.setAttribute('x2', VB_W);
      l.setAttribute('y1', y); l.setAttribute('y2', y);
      gridG.appendChild(l);
    }
  }

  function renderLines() {
    linesG.innerHTML = '';
    state.lines.forEach(function (line) {
      const p = createPath('', line.d);
      if (line.stroke) p.style.stroke = line.stroke;
      if (line.width)  p.style.strokeWidth = line.width;
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
      const li = document.createElement('li');
      li.className = 'ed-group' + (g.id === state.activeGroupId ? ' is-active' : '');

      const row = document.createElement('div');
      row.className = 'ed-group-row';
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
        state.activeGroupId = g.id;
        state.selectedLineId = null;
        renderGroupsList();
        renderSelectionPanel();
      });
      li.appendChild(row);

      // Inline list of lines belonging to this group.
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
    wrap.appendChild(textField('Trigger', g.trigger || '', function (v) {
      updateGroup(g.id, { trigger: v.trim() === '' ? null : v.trim() });
    }, 'CSS selector or empty = page-wide'));

    wrap.appendChild(divider('Defaults'));
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
          page: state.pageId,
          groups: state.groups,
          lines:  state.lines
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
  saveBtn.addEventListener('click', save);

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
})();
