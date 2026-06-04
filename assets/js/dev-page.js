/*
 * /dev/page editor — Phase 2 Slice 1.
 *
 * Step 1 (v0.10.15): empty-state load.
 * Step 2 (v0.10.17): editor verbs phase A — add / select / move.
 * Step 3 (v0.10.18): Save button + POST dev/page/save round-trip.
 * Step 3.5 (v0.10.19): Save button colour tracks dirty state; flashes
 *   green on a successful save so the moment-of-save is visible even
 *   when the status line is glanced past.
 * Step 4 (v0.10.20): editor verbs phase B — resize (8 handles),
 *   delete (button + Delete/Backspace key), and chapter management
 *   (add/rename/delete in sidebar; assign selected rect to chapter
 *   via dropdown). Chapter delete unsets chapterId on member rects
 *   with a confirm dialog showing the affected count.
 * Slice 2 step 1 (v0.10.24): per-rect author note. Editor-only
 *   label authors can use to make a busy canvas navigable (e.g.
 *   "hero photo", "intro paragraph", "drilldown to studio"). Stored
 *   in rects.json under `note`, never rendered at runtime. Schema
 *   bumped 1 → 2; v1 files are migrated on load (server-side) so
 *   the editor only ever sees v2. New rects default to note=null.
 * Slice 2 step 2 (v0.10.27): manual numeric x/y/w/h fields in the
 *   selection panel (Enter/blur commit, Escape revert, clamped to
 *   x≥0/y≥0/w≥MIN/h≥MIN) and shift-held corner-handle drag locks
 *   the aspect ratio. The latter is generic — all rect kinds get
 *   it, not just images. Image-specific "Match rect to image" is
 *   a separate affordance landing in Slice 2 step 4.
 *
 * Vanilla JS, no module system, no build step. Mirrors dev-draw.js
 * in shape: reads embedded #editor-data JSON synchronously on load,
 * paints into the prebuilt DOM scaffolding, applies pointer-driven
 * verbs to the same DOM. Save round-trip arrives in step 3; resize +
 * delete + chapter management in step 4.
 *
 * Coordinate model: rect.x / rect.y are in canvas pixels (1:1 with
 * screen pixels at zoom 1.0 — zoom isn't a Slice-1 feature). The
 * canvas surface is sized by the template to the primary Deco
 * class's pageW × pageH; this file never recomputes that.
 */
(function () {
  'use strict';

  // ────────────────────────────────────────────────────────────────
  // Bootstrap: read the JSON payload the template embedded inline.
  // ────────────────────────────────────────────────────────────────
  const dataEl = document.getElementById('editor-data');
  if (!dataEl) {
    console.error('[dev-page] no #editor-data found');
    return;
  }
  let state;
  try {
    state = JSON.parse(dataEl.textContent || '{}');
  } catch (err) {
    console.error('[dev-page] failed to parse #editor-data:', err);
    return;
  }

  // Defensive normalisation: a stale cached editor against a new
  // template could arrive without these fields. Default rather than
  // throw.
  state.rects    = Array.isArray(state.rects)    ? state.rects    : [];
  state.chapters = Array.isArray(state.chapters) ? state.chapters : [];
  state.canvas   = state.canvas   || { pageW: 1200, pageH: 800, classId: 'wide' };
  state.schemaVersion = state.schemaVersion || 2;
  // Client-side migration safety net. The template already
  // normalises v1 → v2 at read time, but if a stale cached editor
  // somehow loads a payload with missing `note` fields, default
  // them here so the rest of the code never has to branch on
  // presence-vs-null.
  state.rects.forEach(function (r) {
    if (r && typeof r === 'object' && !('note' in r)) r.note = null;
  });

  // Step-2-local UI state: which rect is currently selected (or
  // null), and the active pointer drag if any.
  let selectedId = null;
  let drag = null; // { id, pointerId, startX, startY, origX, origY, moved }

  // Step 3: dirty tracking. Every mutation (add / drag commit /
  // later resize / delete / chapter ops) calls markDirty(); a
  // successful save clears it. Save button is enabled iff dirty.
  let dirty = false;
  let saving = false;
  function markDirty()  { dirty = true;  syncSaveButton(); writeStatus(); }
  function markClean()  { dirty = false; syncSaveButton(); writeStatus(); }
  function syncSaveButton() {
    const btn = document.getElementById('save-btn');
    if (!btn) return;
    btn.disabled = saving || !dirty;
    btn.classList.toggle('is-dirty', dirty && !saving);
  }
  function flashSaveButton() {
    const btn = document.getElementById('save-btn');
    if (!btn) return;
    // Restart the animation: remove class, force reflow, re-add. Without
    // the reflow, two saves in quick succession would skip the second
    // flash because the class is already present.
    btn.classList.remove('is-flash');
    // eslint-disable-next-line no-unused-expressions
    void btn.offsetWidth;
    btn.classList.add('is-flash');
    setTimeout(function () { btn.classList.remove('is-flash'); }, 700);
  }

  // ────────────────────────────────────────────────────────────────
  // ID generation. Cheap enough — 8 chars of [a-z0-9] gives ~10^12
  // possibilities, way past what one page will ever hold. Prefix
  // 'r-' so JSON-grepping is friction-free.
  // ────────────────────────────────────────────────────────────────
  function newRectId() {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let s = '';
    for (let i = 0; i < 8; i++) {
      s += chars[Math.floor(Math.random() * chars.length)];
    }
    // Collision guard — vanishingly unlikely but free to add.
    if (state.rects.some(function (r) { return r.id === 'r-' + s; })) {
      return newRectId();
    }
    return 'r-' + s;
  }

  // Default size by kind. Chosen to give each kind a sensibly
  // different starting footprint so authors don't have to resize
  // every new rect immediately. Adjust freely — these are just
  // defaults.
  const DEFAULT_SIZE = {
    'text':       { w: 400, h: 80 },
    'image':      { w: 300, h: 200 },
    'drilldown':  { w: 320, h: 100 },
    'deco-mount': { w: 600, h: 400 }
  };

  // New rect's spawn position. Stacked offsets so successive adds
  // don't all pile up at exactly the same coords — the author can
  // see they actually added multiple rects before dragging them
  // apart. Wraps at the canvas bottom.
  function nextSpawnXY(w, h) {
    const margin = 40;
    const step   = 24;
    const n      = state.rects.length;
    const x      = margin + (n * step) % Math.max(1, state.canvas.pageW - w - margin);
    const y      = margin + (n * step) % Math.max(1, state.canvas.pageH - h - margin);
    return { x: x, y: y };
  }

  function addRect(kind) {
    const size = DEFAULT_SIZE[kind] || { w: 300, h: 120 };
    const pos  = nextSpawnXY(size.w, size.h);
    const rect = {
      id:        newRectId(),
      kind:      kind,
      x:         pos.x,
      y:         pos.y,
      w:         size.w,
      h:         size.h,
      chapterId: null,
      note:      null
    };
    state.rects.push(rect);
    selectedId = rect.id;
    markDirty();
    render();
  }

  // ────────────────────────────────────────────────────────────────
  // Delete + chapter ops.
  // ────────────────────────────────────────────────────────────────
  function newChapterId() {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let s = '';
    for (let i = 0; i < 8; i++) {
      s += chars[Math.floor(Math.random() * chars.length)];
    }
    if (state.chapters.some(function (c) { return c.id === 'ch-' + s; })) {
      return newChapterId();
    }
    return 'ch-' + s;
  }

  function deleteRect(id) {
    const i = state.rects.findIndex(function (r) { return r.id === id; });
    if (i < 0) return;
    state.rects.splice(i, 1);
    if (selectedId === id) selectedId = null;
    markDirty();
    render();
  }

  function addChapter(name) {
    const trimmed = (name || '').trim();
    if (!trimmed) return;
    // Server-side regex: /^[\p{L}\p{N} _.,'()\[\]\-]+$/u . Light client
    // validation so the author gets immediate feedback rather than a
    // save-time rejection.
    if (!/^[\p{L}\p{N} _.,'()\[\]\-]+$/u.test(trimmed)) {
      alert('Chapter name contains an unsupported character.');
      return;
    }
    state.chapters.push({ id: newChapterId(), name: trimmed });
    markDirty();
    render();
  }

  function renameChapter(id, name) {
    const c = state.chapters.find(function (x) { return x.id === id; });
    if (!c) return;
    const trimmed = (name || '').trim();
    if (!trimmed || trimmed === c.name) return;
    if (!/^[\p{L}\p{N} _.,'()\[\]\-]+$/u.test(trimmed)) {
      alert('Chapter name contains an unsupported character.');
      return;
    }
    c.name = trimmed;
    markDirty();
    render();
  }

  function deleteChapter(id) {
    const c = state.chapters.find(function (x) { return x.id === id; });
    if (!c) return;
    const members = state.rects.filter(function (r) { return r.chapterId === id; });
    const msg = members.length
      ? 'Delete chapter "' + c.name + '"? ' + members.length +
        ' rect(s) currently in it will be unassigned (rects themselves are kept).'
      : 'Delete chapter "' + c.name + '"?';
    if (!window.confirm(msg)) return;
    members.forEach(function (r) { r.chapterId = null; });
    state.chapters = state.chapters.filter(function (x) { return x.id !== id; });
    markDirty();
    render();
  }

  // Numeric-input commit for x/y/w/h. Surgical update: writes the
  // value, updates only the rect's DOM element (left/top/width/
  // height) and the status line. Skips the full render() so
  // Tab-walking between the four fields keeps focus — render()
  // would tear down and rebuild the selection panel, dropping the
  // browser's pending focus move. Returns the clamped value (which
  // may differ from the raw input) so the caller can reflect any
  // clamp back into the field.
  function setRectGeomField(rectId, field, rawValue) {
    const r = state.rects.find(function (x) { return x.id === rectId; });
    if (!r) return null;
    const n = parseInt(String(rawValue).trim(), 10);
    if (!Number.isFinite(n)) return null;
    let next;
    if (field === 'x')      next = Math.max(0, n);
    else if (field === 'y') next = Math.max(0, n);
    else if (field === 'w') next = Math.max(MIN_SIZE, n);
    else if (field === 'h') next = Math.max(MIN_SIZE, n);
    else return null;
    if (r[field] !== next) {
      r[field] = next;
      markDirty();
      // Sync only the affected rect's CSS — the chapter list,
      // selection panel header, and other rects don't depend on
      // geom and don't need a rerender.
      const el = surface.querySelector('[data-rect-id="' + r.id + '"]');
      if (el) {
        el.style.left   = r.x + 'px';
        el.style.top    = r.y + 'px';
        el.style.width  = r.w + 'px';
        el.style.height = r.h + 'px';
      }
      writeStatus();
    }
    return next;
  }

  function setRectNote(rectId, note) {
    const r = state.rects.find(function (x) { return x.id === rectId; });
    if (!r) return;
    // Trim + treat empty string as null so on-disk shape stays
    // tidy (null vs "" disambiguation is meaningless to authors).
    const trimmed = (note == null ? '' : String(note)).trim();
    const next    = trimmed === '' ? null : trimmed.slice(0, 120);
    if (r.note === next) return;
    r.note = next;
    markDirty();
    // Re-render touches the in-rect label + selection panel echo.
    render();
  }

  function setRectChapter(rectId, chapterId) {
    const r = state.rects.find(function (x) { return x.id === rectId; });
    if (!r) return;
    const next = chapterId === '' ? null : chapterId;
    if (next !== null && !state.chapters.some(function (c) { return c.id === next; })) {
      return; // unknown chapter, ignore (shouldn't happen via UI)
    }
    if (r.chapterId === next) return;
    r.chapterId = next;
    markDirty();
    render();
  }

  // ────────────────────────────────────────────────────────────────
  // Page-picker: switch target page by reloading with new ?page=.
  // ────────────────────────────────────────────────────────────────
  const pageSelect = document.getElementById('page-select');
  if (pageSelect) {
    pageSelect.addEventListener('change', function () {
      const slug = pageSelect.value;
      if (!slug) return;
      const url = new URL(window.location.href);
      url.searchParams.set('page', slug);
      window.location.href = url.toString();
    });
  }

  // ────────────────────────────────────────────────────────────────
  // Add-rect select: choosing a kind adds a rect of that kind and
  // resets the picker so the placeholder ("+ Add rect") is shown
  // again for the next add.
  // ────────────────────────────────────────────────────────────────
  const addSelect = document.getElementById('add-rect-select');
  if (addSelect) {
    addSelect.addEventListener('change', function () {
      const kind = addSelect.value;
      if (!kind) return;
      addRect(kind);
      addSelect.value = '';
    });
  }

  // ────────────────────────────────────────────────────────────────
  // Selection + drag.
  //
  // Implementation: one pointerdown handler delegated on the canvas
  // surface. Records the start point; subsequent pointermove/up are
  // listened on the document so the drag continues even if the
  // pointer leaves the rect bounds (which it always does once the
  // user moves it). Pointer capture would also work but document-
  // level listeners are simpler and behave identically for our
  // single-finger case.
  //
  // Click vs drag is decided by a 3px threshold: a release that
  // never moved past 3px is a click (select-only); a release after
  // moving past 3px is a drag commit (position already updated
  // during pointermove, no extra work at up).
  // ────────────────────────────────────────────────────────────────
  const surface = document.getElementById('page-editor-surface');
  if (!surface) {
    console.error('[dev-page] no #page-editor-surface found');
    return;
  }

  function findRectElement(target) {
    // Walk up from event.target until we hit a .pe-rect or the
    // surface itself.
    let el = target;
    while (el && el !== surface) {
      if (el.classList && el.classList.contains('pe-rect')) return el;
      el = el.parentElement;
    }
    return null;
  }

  // Minimum rect size — prevents resize from collapsing a rect to a
  // sliver that can't be re-grabbed. 20px is enough to still see and
  // click the handles after a shrink.
  const MIN_SIZE = 20;

  surface.addEventListener('pointerdown', function (ev) {
    // Resize-handle hit takes priority over rect-body hit. The handle
    // is a child of the selected rect, so the rectEl walk would also
    // find the parent rect — but we need to know the handle direction.
    const handleEl = ev.target && ev.target.classList &&
                     ev.target.classList.contains('pe-resize-handle')
                     ? ev.target : null;

    const rectEl = findRectElement(ev.target);
    if (!rectEl) {
      // Empty-canvas click: deselect.
      if (selectedId !== null) {
        selectedId = null;
        render();
      }
      return;
    }
    const id = rectEl.dataset.rectId;
    const r  = state.rects.find(function (x) { return x.id === id; });
    if (!r) return;

    // Selection happens on pointerdown regardless of subsequent
    // drag — feels more responsive than waiting for pointerup.
    selectedId = id;
    if (handleEl) {
      // Resize gesture. Direction encoded in the dataset.
      drag = {
        mode:      'resize',
        dir:       handleEl.dataset.dir,
        id:        id,
        pointerId: ev.pointerId,
        startX:    ev.clientX,
        startY:    ev.clientY,
        origX:     r.x,
        origY:     r.y,
        origW:     r.w,
        origH:     r.h,
        moved:     false
      };
    } else {
      drag = {
        mode:      'move',
        id:        id,
        pointerId: ev.pointerId,
        startX:    ev.clientX,
        startY:    ev.clientY,
        origX:     r.x,
        origY:     r.y,
        moved:     false
      };
    }
    rectEl.classList.add('is-selected');
    // Re-render to update status line + other selection visuals.
    // The rectEl's class is updated above so re-render isn't strictly
    // necessary for the visual, but keeping render() the single
    // source of truth is simpler.
    render();
    ev.preventDefault();
  });

  document.addEventListener('pointermove', function (ev) {
    if (!drag || ev.pointerId !== drag.pointerId) return;
    const dx = ev.clientX - drag.startX;
    const dy = ev.clientY - drag.startY;
    if (!drag.moved && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) {
      drag.moved = true;
      const el = surface.querySelector('[data-rect-id="' + drag.id + '"]');
      if (el) el.classList.add('is-dragging');
    }
    if (drag.moved) {
      const r = state.rects.find(function (x) { return x.id === drag.id; });
      if (!r) return;
      if (drag.mode === 'resize') {
        // Resize math, direction-aware. N/W edges move x/y too; E/S
        // edges grow w/h only. Corners are the union of two edges.
        let nx = drag.origX, ny = drag.origY;
        let nw = drag.origW, nh = drag.origH;
        const d = drag.dir || '';
        if (d.indexOf('e') >= 0) nw = Math.max(MIN_SIZE, drag.origW + dx);
        if (d.indexOf('s') >= 0) nh = Math.max(MIN_SIZE, drag.origH + dy);
        if (d.indexOf('w') >= 0) {
          nw = Math.max(MIN_SIZE, drag.origW - dx);
          nx = drag.origX + (drag.origW - nw);
        }
        if (d.indexOf('n') >= 0) {
          nh = Math.max(MIN_SIZE, drag.origH - dy);
          ny = drag.origY + (drag.origH - nh);
        }
        // Shift on a corner handle locks the aspect ratio. Live
        // check (not captured at pointerdown) so author can toggle
        // mid-drag. The axis with the larger fractional change wins
        // — felt right in practice: drag the corner mostly
        // horizontally, width drives; drag it mostly vertically,
        // height drives. Anchored corner (the one opposite the drag
        // handle) stays fixed; x/y are recomputed for N/W edges so
        // the locked aspect doesn't drift the anchor.
        const isCorner = d.length === 2;
        if (isCorner && ev.shiftKey && drag.origW > 0 && drag.origH > 0) {
          const aspect = drag.origW / drag.origH;
          const wRatio = nw / drag.origW;
          const hRatio = nh / drag.origH;
          if (wRatio >= hRatio) {
            nh = Math.max(MIN_SIZE, Math.round(nw / aspect));
          } else {
            nw = Math.max(MIN_SIZE, Math.round(nh * aspect));
          }
          // Re-anchor x/y if the dragged corner is on the W/N side.
          if (d.indexOf('w') >= 0) nx = drag.origX + (drag.origW - nw);
          if (d.indexOf('n') >= 0) ny = drag.origY + (drag.origH - nh);
        }
        r.x = Math.round(nx); r.y = Math.round(ny);
        r.w = Math.round(nw); r.h = Math.round(nh);
        const el = surface.querySelector('[data-rect-id="' + drag.id + '"]');
        if (el) {
          el.style.left   = r.x + 'px';
          el.style.top    = r.y + 'px';
          el.style.width  = r.w + 'px';
          el.style.height = r.h + 'px';
        }
      } else {
        r.x = Math.round(drag.origX + dx);
        r.y = Math.round(drag.origY + dy);
        // Cheap live update: write directly on the existing DOM node
        // rather than re-render the whole list every pointermove.
        // The full render() runs on pointerup to flush status + any
        // derived state.
        const el = surface.querySelector('[data-rect-id="' + drag.id + '"]');
        if (el) {
          el.style.left = r.x + 'px';
          el.style.top  = r.y + 'px';
        }
      }
      writeStatus();
    }
  });

  document.addEventListener('pointerup', function (ev) {
    if (!drag || ev.pointerId !== drag.pointerId) return;
    const wasDrag = drag.moved;
    drag = null;
    if (wasDrag) { markDirty(); render(); } // canonical re-render after a commit
    // If it was a click (no movement), selection already happened on
    // pointerdown — nothing more to do here.
  });

  document.addEventListener('pointercancel', function (ev) {
    if (!drag || ev.pointerId !== drag.pointerId) return;
    // Revert the in-progress move so a cancelled gesture doesn't
    // leave the rect at a half-dragged position.
    const r = state.rects.find(function (x) { return x.id === drag.id; });
    if (r) {
      r.x = drag.origX; r.y = drag.origY;
      if (drag.mode === 'resize') { r.w = drag.origW; r.h = drag.origH; }
    }
    drag = null;
    render();
  });

  // ────────────────────────────────────────────────────────────────
  // Render: paint the full rect list. Cheap at Slice 1 scale
  // (handful of rects); a diff-render arrives in step 4 if perf
  // demands.
  // ────────────────────────────────────────────────────────────────
  function renderRect(rect) {
    const el = document.createElement('div');
    el.className = 'pe-rect pe-rect--' + (rect.kind || 'unknown');
    if (rect.id === selectedId) el.classList.add('is-selected');
    el.dataset.rectId = rect.id || '';
    if (rect.chapterId) el.dataset.chapter = rect.chapterId;
    el.style.position = 'absolute';
    el.style.left     = (rect.x | 0) + 'px';
    el.style.top      = (rect.y | 0) + 'px';
    el.style.width    = (rect.w | 0) + 'px';
    el.style.height   = (rect.h | 0) + 'px';

    const label = document.createElement('span');
    label.className = 'pe-rect-label';
    label.textContent = rect.kind || '?';
    el.appendChild(label);

    // Author note — editor-only, visible inside the rect when set.
    // Rendered under the kind label so a glance at the canvas tells
    // the author "ah, this rect is the studio-intro paragraph"
    // without having to select it. Empty/null → no node, no space.
    if (rect.note && typeof rect.note === 'string') {
      const note = document.createElement('span');
      note.className = 'pe-rect-note';
      note.textContent = rect.note;
      el.appendChild(note);
    }

    const idTag = document.createElement('span');
    idTag.className = 'pe-rect-id';
    idTag.textContent = rect.id || '';
    el.appendChild(idTag);

    // Resize handles — emitted on every rect; CSS hides them unless
    // the rect carries .is-selected. Cheaper than conditional DOM
    // insertion and keeps selection toggling a one-class flip.
    const dirs = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
    dirs.forEach(function (d) {
      const h = document.createElement('div');
      h.className = 'pe-resize-handle pe-resize-handle--' + d;
      h.dataset.dir = d;
      el.appendChild(h);
    });

    return el;
  }

  function render() {
    surface.innerHTML = '';
    state.rects.forEach(function (r) {
      surface.appendChild(renderRect(r));
    });
    renderChapters();
    renderSelection();
    writeStatus();
  }

  // ────────────────────────────────────────────────────────────────
  // Sidebar: chapter list.
  // Each row: editable name (commits on blur / Enter), member count,
  // delete button. Add form at the bottom of the panel (in template).
  // ────────────────────────────────────────────────────────────────
  function renderChapters() {
    const ul = document.getElementById('chapters-list');
    if (!ul) return;
    ul.innerHTML = '';
    if (!state.chapters.length) {
      const li = document.createElement('li');
      li.className = 'pe-empty';
      li.textContent = 'No chapters yet.';
      ul.appendChild(li);
      return;
    }
    // Which chapter does the currently-selected rect belong to?
    // Used to mark that chapter's row as "current" — small affordance
    // for navigability when the canvas has many rects across several
    // chapters (v0.10.25).
    const selectedRect = selectedId
      ? state.rects.find(function (x) { return x.id === selectedId; })
      : null;
    const selectedChId = selectedRect ? selectedRect.chapterId : null;

    state.chapters.forEach(function (c) {
      const li = document.createElement('li');
      li.dataset.chapterId = c.id;
      if (c.id === selectedChId) li.classList.add('is-current');

      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'pe-chapter-name';
      input.value = c.name;
      input.maxLength = 64;
      input.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter') { ev.preventDefault(); input.blur(); }
        if (ev.key === 'Escape') { input.value = c.name; input.blur(); }
      });
      input.addEventListener('blur', function () {
        renameChapter(c.id, input.value);
      });

      const count = state.rects.filter(function (r) { return r.chapterId === c.id; }).length;
      const countEl = document.createElement('span');
      countEl.className = 'pe-chapter-count';
      countEl.textContent = count + ' rect' + (count === 1 ? '' : 's');

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'pe-chapter-del';
      del.title = 'Delete chapter';
      del.textContent = '×';
      del.addEventListener('click', function () { deleteChapter(c.id); });

      li.appendChild(input);
      li.appendChild(countEl);
      li.appendChild(del);
      ul.appendChild(li);
    });
  }

  // ────────────────────────────────────────────────────────────────
  // Sidebar: selection panel.
  // Empty state when no selection. Otherwise: rect id + kind + dims,
  // chapter dropdown, delete button.
  // ────────────────────────────────────────────────────────────────
  function renderSelection() {
    const body = document.getElementById('selection-body');
    if (!body) return;
    body.innerHTML = '';
    const r = selectedId
      ? state.rects.find(function (x) { return x.id === selectedId; })
      : null;
    if (!r) {
      const empty = document.createElement('div');
      empty.className = 'pe-empty';
      empty.textContent = 'No rect selected.';
      body.appendChild(empty);
      return;
    }

    function row(labelText, child) {
      const div = document.createElement('div');
      div.className = 'pe-selection-row';
      const lab = document.createElement('label');
      lab.textContent = labelText;
      div.appendChild(lab);
      div.appendChild(child);
      return div;
    }

    const idDim = document.createElement('span');
    idDim.className = 'pe-dim';
    idDim.textContent = r.id;
    body.appendChild(row('ID', idDim));

    const kindDim = document.createElement('span');
    kindDim.className = 'pe-dim';
    kindDim.textContent = r.kind;
    body.appendChild(row('Kind', kindDim));

    // Geometry — four small numeric inputs (x / y / w / h). Tab
    // walks between them; Enter or blur commits; Escape reverts
    // the field to the rect's current value. Each field clamps
    // independently (x≥0, y≥0, w≥MIN, h≥MIN). Authors use this
    // for precise placement (e.g. "snap to x=120 exactly") that
    // drag can't hit without zoom.
    const geomBox = document.createElement('span');
    geomBox.className = 'pe-geom-fields';
    function geomField(key, value) {
      const wrap = document.createElement('label');
      wrap.className = 'pe-geom-field';
      const lab = document.createElement('span');
      lab.className = 'pe-geom-key';
      lab.textContent = key;
      const inp = document.createElement('input');
      inp.type = 'number';
      inp.className = 'pe-input pe-geom-input';
      inp.value = String(value);
      inp.step = '1';
      inp.min = (key === 'w' || key === 'h') ? String(MIN_SIZE) : '0';
      inp.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter')  { ev.preventDefault(); inp.blur(); }
        if (ev.key === 'Escape') { inp.value = String(r[key]); inp.blur(); }
      });
      inp.addEventListener('blur', function () {
        const clamped = setRectGeomField(r.id, key, inp.value);
        // Re-display the canonical (post-clamp) value so the field
        // never shows bad input or a pre-clamp number. If parse
        // failed (clamped === null) or value was unchanged, fall
        // back to the rect's current value.
        inp.value = String(clamped !== null ? clamped : r[key]);
      });
      wrap.appendChild(lab);
      wrap.appendChild(inp);
      return wrap;
    }
    geomBox.appendChild(geomField('x', r.x));
    geomBox.appendChild(geomField('y', r.y));
    geomBox.appendChild(geomField('w', r.w));
    geomBox.appendChild(geomField('h', r.h));
    // v0.10.28 — geom fields render directly (no left-side row label).
    // The four X/Y/W/H key labels above each input make the inline
    // "Geometry" label redundant; dropping it gives the inputs the
    // full row width and the values stop colliding with the focus
    // ring of the active field.
    geomBox.classList.add('pe-geom-fields--standalone');
    body.appendChild(geomBox);

    // Author note — short editor-only label. Commits on blur or
    // Enter; Escape reverts to the saved value (same UX as the
    // chapter-rename input). Empty input clears the note (stored
    // as null on disk).
    const noteInput = document.createElement('input');
    noteInput.type = 'text';
    noteInput.className = 'pe-input';
    noteInput.maxLength = 120;
    noteInput.placeholder = 'short author note (optional)';
    noteInput.value = r.note || '';
    noteInput.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter')  { ev.preventDefault(); noteInput.blur(); }
      if (ev.key === 'Escape') { noteInput.value = r.note || ''; noteInput.blur(); }
    });
    noteInput.addEventListener('blur', function () {
      setRectNote(r.id, noteInput.value);
    });
    body.appendChild(row('Note', noteInput));

    const chSel = document.createElement('select');
    chSel.className = 'pe-input';
    const noneOpt = document.createElement('option');
    noneOpt.value = '';
    noneOpt.textContent = '— none —';
    if (r.chapterId == null) noneOpt.selected = true;
    chSel.appendChild(noneOpt);
    state.chapters.forEach(function (c) {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = c.name;
      if (r.chapterId === c.id) opt.selected = true;
      chSel.appendChild(opt);
    });
    chSel.addEventListener('change', function () {
      setRectChapter(r.id, chSel.value);
    });
    body.appendChild(row('Chapter', chSel));

    const actions = document.createElement('div');
    actions.className = 'pe-selection-actions';
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'pe-rect-del';
    del.textContent = 'Delete rect';
    del.addEventListener('click', function () { deleteRect(r.id); });
    actions.appendChild(del);
    body.appendChild(actions);
  }

  // ────────────────────────────────────────────────────────────────
  // Status line: surface what's loaded + what's selected so the
  // author can confirm the editor is pointing at the right state.
  // Real dirty-indicator + save status arrive in step 3.
  // ────────────────────────────────────────────────────────────────
  const statusEl = document.getElementById('save-status');
  let transientStatus = null; // { text, until } for short-lived messages
  function writeStatus() {
    if (!statusEl) return;
    // Transient (saved / error) overrides the steady-state line for a few
    // seconds so the author sees the outcome of the last Save click.
    if (transientStatus && Date.now() < transientStatus.until) {
      statusEl.textContent = transientStatus.text;
      return;
    }
    transientStatus = null;
    const sel = selectedId
      ? (function () {
          const r = state.rects.find(function (x) { return x.id === selectedId; });
          return r
            ? ' · sel=' + r.id + ' (' + r.kind + ' ' + r.x + ',' + r.y + ' ' + r.w + '×' + r.h + ')'
            : '';
        })()
      : '';
    const dirtyTag = saving ? ' · saving…' : (dirty ? ' · unsaved' : ' · saved');
    statusEl.textContent =
      'loaded · ' + state.rects.length + ' rect(s) · ' +
      state.chapters.length + ' chapter(s) · class=' + state.canvas.classId +
      sel + dirtyTag;
  }
  function setTransient(text, ms) {
    transientStatus = { text: text, until: Date.now() + (ms || 2500) };
    writeStatus();
    setTimeout(function () { writeStatus(); }, (ms || 2500) + 50);
  }

  // ────────────────────────────────────────────────────────────────
  // Save: POST { page, schemaVersion, chapters, rects } to
  // /dev/page/save. Endpoint validates + writes rects.json atomically.
  // Canvas dimensions are not part of the payload — they come from
  // Deco's per-page config (decision #2 of the slice plan).
  // ────────────────────────────────────────────────────────────────
  const saveBtn = document.getElementById('save-btn');
  async function doSave() {
    if (!dirty || saving) return;
    saving = true;
    syncSaveButton();
    writeStatus();
    try {
      const res = await fetch('/dev/page/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          page:          state.pageId,
          schemaVersion: state.schemaVersion,
          chapters:      state.chapters,
          rects:         state.rects
        })
      });
      let json = null;
      try { json = await res.json(); } catch (_) {}
      if (!res.ok || !json || json.ok !== true) {
        const msg = (json && json.error) ? json.error : ('HTTP ' + res.status);
        setTransient('save failed · ' + msg, 4000);
        console.error('[dev-page] save failed', res.status, json);
      } else {
        markClean();
        flashSaveButton();
        setTransient('saved ✓', 2000);
      }
    } catch (err) {
      console.error('[dev-page] save error', err);
      setTransient('save error · ' + (err && err.message ? err.message : 'network'), 4000);
    } finally {
      saving = false;
      syncSaveButton();
    }
  }
  if (saveBtn) {
    saveBtn.addEventListener('click', function () { doSave(); });
  }
  // Chapter add form. Submit on Enter or the [+] button. Empty input
  // is a no-op (addChapter trims + bails).
  const chForm  = document.getElementById('chapter-add-form');
  const chInput = document.getElementById('chapter-add-input');
  if (chForm && chInput) {
    chForm.addEventListener('submit', function (ev) {
      ev.preventDefault();
      const name = chInput.value;
      chInput.value = '';
      addChapter(name);
      chInput.focus();
    });
  }

  // Keyboard shortcuts. The handler skips when focus is in an editable
  // field — otherwise typing in the chapter rename input would delete
  // the selected rect on Backspace.
  document.addEventListener('keydown', function (ev) {
    if ((ev.metaKey || ev.ctrlKey) && (ev.key === 's' || ev.key === 'S')) {
      ev.preventDefault();
      doSave();
      return;
    }
    const t = ev.target;
    const inField = t && (
      t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' ||
      t.tagName === 'SELECT' || (t.isContentEditable === true)
    );
    if (inField) return;
    if (ev.key === 'Delete' || ev.key === 'Backspace') {
      if (selectedId) {
        ev.preventDefault();
        deleteRect(selectedId);
      }
      return;
    }
    if (ev.key === 'Escape') {
      if (selectedId) {
        selectedId = null;
        render();
      }
      return;
    }
  });

  render();
  syncSaveButton();

  // Expose for console-poking during early-stage debugging only.
  // Removed once step 4 surfaces this through real UI.
  window.__pageEditor = { state: state, render: render };
})();
