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
 * Slice 2 step 4b (v0.10.46): image binding. Image-kind rects can be
 *   bound to a file from the page's image library (the auto-created
 *   `images` child, listed via GET dev/page/images/<pageId>). The
 *   selection panel gains a "Bind image…" picker (modal thumb grid);
 *   the bound filename is stored on the rect as `image` (rect-schema
 *   2 → 3, additive). A bound rect previews the real image on the
 *   canvas; a dangling binding (file since renamed/removed) is flagged.
 *   The runtime <img> render lands in step 5.
 * Slice 2 step 4c (v0.10.47): image-fit handling for aspect mismatch.
 *   New optional `fit` field ('cover' default | 'contain'), additive
 *   within schema v3 (no bump). The selection panel gains a Cover/
 *   Contain toggle plus, when the rect and image aspect ratios differ,
 *   an aspect readout and a "Match rect to image" action (keeps width,
 *   adjusts height). renderRect drives object-fit via data-fit.
 * Slice 2 step 4c-ii (v0.10.48): image-first "Place image" flow. A
 *   "+ Place image…" toolbar button opens the picker in create mode;
 *   choosing a file creates a new image rect already bound AND sized to
 *   the image's aspect ratio (no mismatch on landing). addRect now also
 *   initialises image:null / fit:'cover' so every rect carries the full
 *   current shape from birth.
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
    if (r && typeof r === 'object' && !('note' in r))  r.note  = null;
    if (r && typeof r === 'object' && !('image' in r)) r.image = null;
    // v0.10.47: `fit` ('cover' default | 'contain') controls how a
    // bound image fills a rect with a different aspect ratio. Additive
    // within schema v3 — default to the behaviour-preserving 'cover'.
    if (r && typeof r === 'object' && r.fit !== 'contain') r.fit = 'cover';
    // v0.10.50: `focusX`/`focusY` (0–100, default 50) drive the bound
    // image's object-position so the author can choose which part of a
    // cover-cropped image is visible. Additive within schema v3 —
    // default 50/50 == centred == the prior behaviour.
    if (r && typeof r === 'object') {
      r.focusX = clampFocus(r.focusX);
      r.focusY = clampFocus(r.focusY);
    }
  });

  // Slice 2 step 4b: per-page image library, fetched once from
  // GET dev/page/images/<pageId>. null = not yet loaded; [] =
  // loaded-empty. imageByFilename indexes the list so renderRect and
  // the binding UI can resolve a bound filename → {url, thumb, w, h}.
  // Loaded asynchronously after first paint; a second render() runs
  // when it arrives so bound image rects upgrade from stub → <img>.
  let imageLibrary    = null;
  let imageByFilename = {};
  let imageLibError   = null;
  let uploadError     = null; // last in-editor upload failure (v0.10.54)

  // Step-2-local UI state: which rect is currently selected (or
  // null), and the active pointer drag if any.
  let selectedId = null;
  let drag = null; // { id, pointerId, startX, startY, origX, origY, moved }
  let focusDrag = null; // focal-dot drag (step 4d); independent of `drag`
  // Objects panel (v0.10.70) — session-only display mode: 'type' groups by
  // kind, 'z' is one flat list ordered by layer. Not persisted.
  let objectsSortMode = 'type';
  // Fixed kind order for the 'type' grouping (mirrors the Add-rect menu);
  // any unrecognised kind falls to the end.
  const KIND_ORDER = ['text', 'image', 'drilldown', 'deco-mount'];

  // Clamp an image focus coordinate to an integer in [0,100], with a
  // 50 (centred) fallback for missing/garbage input. Used by the
  // bootstrap normaliser and the focal-dot drag (step 4d).
  function clampFocus(v) {
    const n = Math.round(Number(v));
    if (!isFinite(n)) return 50;
    return Math.max(0, Math.min(100, n));
  }

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
      note:      null,
      // Initialise the image-binding keys explicitly so every rect
      // carries the full current shape from birth (the bootstrap
      // normaliser only runs on load; a freshly added rect would
      // otherwise lack them until its first save round-trip).
      image:     null,
      fit:       'cover',
      focusX:    50,
      focusY:    50
    };
    state.rects.push(rect);
    selectedId = rect.id;
    markDirty();
    render();
  }

  // Slice 2 step 4c-ii: image-first "Place image" flow. Instead of
  // add-empty-image-rect → bind, the author picks an image first and
  // gets a new image rect already bound AND sized to the image's aspect
  // ratio (default width, height = round(w / ratio)) — so it lands with
  // no mismatch. Falls back to the default image-rect size if the file
  // isn't in the loaded library (shouldn't happen — the picker only
  // offers library images — but stays safe).
  function placeImageRect(filename) {
    if (filename == null || filename === '') return;
    const found = imageByFilename[String(filename)];
    let w = DEFAULT_SIZE.image.w;
    let h = DEFAULT_SIZE.image.h;
    if (found && found.ratio > 0) {
      h = Math.max(MIN_SIZE, Math.round(w / found.ratio));
    }
    const pos  = nextSpawnXY(w, h);
    const rect = {
      id:        newRectId(),
      kind:      'image',
      x:         pos.x,
      y:         pos.y,
      w:         w,
      h:         h,
      chapterId: null,
      note:      null,
      image:     String(filename),
      fit:       'cover',
      focusX:    50,
      focusY:    50
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

  // ────────────────────────────────────────────────────────────────
  // Layer (Z) order — v0.10.65. Stacking is array order: render()
  // appends rects in state.rects order, so the LAST rect paints on
  // top (frontmost). The four ops mirror every layers panel:
  //   to-front = splice to end · forward = swap with next ·
  //   backward = swap with prev · to-back = splice to front.
  // No schema change — Z is purely the array position (displayed as
  // z = index+1, N = count). Selection is preserved across the move.
  // ────────────────────────────────────────────────────────────────
  function rectIndex(id) {
    return state.rects.findIndex(function (r) { return r.id === id; });
  }
  function moveRectToTop(id) {        // bring to front (end of array)
    const i = rectIndex(id);
    if (i < 0 || i === state.rects.length - 1) return;
    state.rects.push(state.rects.splice(i, 1)[0]);
    markDirty();
    render();
  }
  function moveRectToBottom(id) {     // send to back (start of array)
    const i = rectIndex(id);
    if (i <= 0) return;
    state.rects.unshift(state.rects.splice(i, 1)[0]);
    markDirty();
    render();
  }
  function moveRectUp(id) {           // forward one (toward the front)
    const i = rectIndex(id);
    if (i < 0 || i === state.rects.length - 1) return;
    const t = state.rects[i];
    state.rects[i] = state.rects[i + 1];
    state.rects[i + 1] = t;
    markDirty();
    render();
  }
  function moveRectDown(id) {         // backward one (toward the back)
    const i = rectIndex(id);
    if (i <= 0) return;
    const t = state.rects[i];
    state.rects[i] = state.rects[i - 1];
    state.rects[i - 1] = t;
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
  // Image binding (Slice 2 step 4b).
  // ────────────────────────────────────────────────────────────────
  function setRectImage(rectId, filename) {
    const r = state.rects.find(function (x) { return x.id === rectId; });
    if (!r) return;
    const next = (filename == null || filename === '') ? null : String(filename);
    if (r.image === next) return;
    r.image = next;
    markDirty();
    render();
  }

  // Slice 2 step 4c: image-fit handling for aspect mismatch.
  // `fit` is 'cover' (fill the rect, crop overflow) or 'contain'
  // (fit the whole image inside, letterbox the remainder).
  function setRectFit(rectId, mode) {
    const r = state.rects.find(function (x) { return x.id === rectId; });
    if (!r) return;
    const next = mode === 'contain' ? 'contain' : 'cover';
    if (r.fit === next) return;
    r.fit = next;
    markDirty();
    render();
  }

  // "Match rect to image": eliminate the aspect mismatch by resizing the
  // rect to the bound image's ratio. Width is the layout-driven axis, so
  // we KEEP width and recompute height = round(w / ratio); the author can
  // re-drag afterwards. No-op if the image isn't in the loaded library
  // (we have no ratio to match) or the height wouldn't actually change.
  function matchRectToImage(rectId) {
    const r = state.rects.find(function (x) { return x.id === rectId; });
    if (!r || !r.image) return;
    const found = imageByFilename[r.image];
    if (!found || !found.ratio || found.ratio <= 0) return;
    const newH = Math.max(MIN_SIZE, Math.round((r.w | 0) / found.ratio));
    if (newH === (r.h | 0)) return;
    r.h = newH;
    markDirty();
    render();
  }

  // Fetch the page's image library once. Re-callable (the picker's
  // refresh button) — always re-indexes and re-renders so freshly
  // uploaded images appear without a full page reload.
  function loadImageLibrary() {
    return fetch('/dev/page/images/' + encodeURIComponent(state.pageId))
      .then(function (res) { return res.json().catch(function () { return null; })
        .then(function (json) { return { res: res, json: json }; }); })
      .then(function (r) {
        if (!r.res.ok || !r.json || r.json.ok !== true) {
          imageLibError = (r.json && r.json.error) ? r.json.error : ('HTTP ' + r.res.status);
          imageLibrary  = imageLibrary || [];
          render();
          return;
        }
        imageLibError   = null;
        imageLibrary    = Array.isArray(r.json.images) ? r.json.images : [];
        imageByFilename = {};
        imageLibrary.forEach(function (img) {
          if (img && img.filename) imageByFilename[img.filename] = img;
        });
        render();
      })
      .catch(function (err) {
        imageLibError = (err && err.message) ? err.message : 'network';
        imageLibrary  = imageLibrary || [];
        render();
      });
  }

  // ────────────────────────────────────────────────────────────────
  // Image picker overlay (step 4b). A lightweight modal thumb grid
  // over the canvas — pick a file to bind it to the active rect.
  // Only one instance at a time; pickerEl tracks the live overlay so
  // the global keydown handler can suppress canvas shortcuts (Delete,
  // Escape-deselect) while it's open.
  // ────────────────────────────────────────────────────────────────
  let pickerEl = null;
  function closeImagePicker() {
    if (pickerEl && pickerEl.parentNode) pickerEl.parentNode.removeChild(pickerEl);
    pickerEl = null;
    uploadError = null; // don't carry a stale upload error into the next open
    document.removeEventListener('keydown', pickerKeydown, true);
  }
  function pickerKeydown(ev) {
    // Capture phase + stopPropagation so the canvas-level handler
    // never sees these while the picker owns the keyboard.
    if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); closeImagePicker(); }
  }
  // rectId === null → "place" mode: clicking a cell creates a new image
  // rect already bound to that file (step 4c-ii). Otherwise → "bind"
  // mode: the click sets the existing rect's image.
  function openImagePicker(rectId) {
    closeImagePicker();
    const placeMode = (rectId == null);

    const overlay = document.createElement('div');
    overlay.className = 'pe-picker-overlay';
    overlay.addEventListener('click', function (ev) {
      if (ev.target === overlay) closeImagePicker();
    });

    const modal = document.createElement('div');
    modal.className = 'pe-picker';
    overlay.appendChild(modal);

    const head = document.createElement('div');
    head.className = 'pe-picker-head';
    const title = document.createElement('h3');
    title.className = 'pe-picker-title';
    title.textContent = placeMode ? 'Place image' : 'Bind image';
    head.appendChild(title);
    // Upload (v0.10.54): drop a new image straight into the page's image
    // library without a Panel round-trip. A hidden file input drives a
    // styled button; on success the library is re-fetched and the new
    // image is immediately placed/bound (the user opened the picker to do
    // exactly that), then the picker closes.
    const upInput = document.createElement('input');
    upInput.type = 'file';
    // Match the server-side whitelist exactly (config.php upload route) so
    // the OS picker greys out what the server would reject anyway — notably
    // .heic, which the GD/Imagick thumb engine can't decode (v0.10.56).
    upInput.accept = '.jpg,.jpeg,.png,.gif,.webp,.avif,image/jpeg,image/png,image/gif,image/webp,image/avif';
    upInput.style.display = 'none';
    const upBtn = document.createElement('button');
    upBtn.type = 'button';
    upBtn.className = 'pe-create-btn';
    upBtn.textContent = 'Upload…';
    upBtn.addEventListener('click', function () {
      if (upBtn.disabled) return;
      upInput.value = ''; // allow re-picking the same file after an error
      upInput.click();
    });
    upInput.addEventListener('change', function () {
      const file = upInput.files && upInput.files[0];
      if (!file) return;
      uploadImage(file, upBtn);
    });
    head.appendChild(upBtn);
    head.appendChild(upInput);

    function uploadImage(file, btn) {
      btn.disabled = true;
      const restore = btn.textContent;
      btn.textContent = 'Uploading…';
      if (uploadError) { uploadError = null; renderPickerBody(); }
      const fd = new FormData();
      fd.append('page', state.pageId);
      fd.append('file', file);
      fetch('/dev/page/upload-image', { method: 'POST', body: fd })
        .then(function (res) { return res.json().then(function (j) { return { ok: res.ok, json: j }; }); })
        .then(function (r) {
          if (!r.ok || !r.json || !r.json.ok) {
            throw new Error((r.json && r.json.error) || ('HTTP ' + (r.ok ? '?' : 'error')));
          }
          const newName = r.json.filename;
          // Re-fetch the library so the new file is known, then place/bind
          // it exactly as a cell click would, and close.
          imageLibrary = null;
          return loadImageLibrary().then(function () {
            if (placeMode) placeImageRect(newName);
            else           setRectImage(rectId, newName);
            closeImagePicker();
          });
        })
        .catch(function (err) {
          uploadError = String(err && err.message ? err.message : err);
          btn.disabled = false;
          btn.textContent = restore;
          renderPickerBody();
        });
    }

    const refresh = document.createElement('button');
    refresh.type = 'button';
    refresh.className = 'pe-create-btn';
    refresh.textContent = 'Refresh';
    refresh.addEventListener('click', function () {
      imageLibrary = null;
      renderPickerBody();
      loadImageLibrary().then(renderPickerBody);
    });
    head.appendChild(refresh);
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'pe-picker-close';
    close.title = 'Close (Esc)';
    close.textContent = '×';
    close.addEventListener('click', closeImagePicker);
    head.appendChild(close);
    modal.appendChild(head);

    const bodyWrap = document.createElement('div');
    bodyWrap.className = 'pe-picker-body';
    modal.appendChild(bodyWrap);

    function renderPickerBody() {
      bodyWrap.innerHTML = '';
      if (imageLibrary === null) {
        const m = document.createElement('div');
        m.className = 'pe-empty';
        m.textContent = 'Loading…';
        bodyWrap.appendChild(m);
        return;
      }
      if (imageLibError) {
        const m = document.createElement('div');
        m.className = 'pe-picker-error';
        m.textContent = 'Could not load library: ' + imageLibError;
        bodyWrap.appendChild(m);
      }
      if (uploadError) {
        const m = document.createElement('div');
        m.className = 'pe-picker-error';
        m.textContent = 'Upload failed: ' + uploadError;
        bodyWrap.appendChild(m);
      }
      if (!imageLibrary.length) {
        const m = document.createElement('div');
        m.className = 'pe-empty';
        m.textContent = 'No images in this page’s library yet. Use “Upload…” above '
          + '(or add them in the Panel), then they appear here.';
        bodyWrap.appendChild(m);
        return;
      }
      const grid = document.createElement('div');
      grid.className = 'pe-picker-grid';
      const r = state.rects.find(function (x) { return x.id === rectId; });
      imageLibrary.forEach(function (img) {
        const cell = document.createElement('button');
        cell.type = 'button';
        cell.className = 'pe-picker-cell';
        if (r && r.image === img.filename) cell.classList.add('is-current');
        const th = document.createElement('img');
        th.className = 'pe-picker-thumb';
        th.src = img.thumb;
        th.alt = '';
        th.loading = 'lazy';
        cell.appendChild(th);
        const cap = document.createElement('span');
        cap.className = 'pe-picker-cap';
        cap.textContent = img.filename;
        cap.title = img.filename + ' · ' + img.width + '×' + img.height + ' · ' + img.size;
        cell.appendChild(cap);
        cell.addEventListener('click', function () {
          if (placeMode) placeImageRect(img.filename);
          else           setRectImage(rectId, img.filename);
          closeImagePicker();
        });
        grid.appendChild(cell);
      });
      bodyWrap.appendChild(grid);
    }

    document.body.appendChild(overlay);
    pickerEl = overlay;
    document.addEventListener('keydown', pickerKeydown, true);

    renderPickerBody();
    // Kick a load if the library was never fetched (or a prior fetch
    // errored and left it empty); the picker repaints when it lands.
    if (imageLibrary === null) loadImageLibrary().then(renderPickerBody);
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

  // Place-image button (step 4c-ii): opens the picker in create mode.
  const placeBtn = document.getElementById('place-image-btn');
  if (placeBtn) {
    placeBtn.addEventListener('click', function () { openImagePicker(null); });
  }

  // OBJECTS panel (v0.10.70) — T = group by type, Z = flat by layer. Mode is
  // session-only; the buttons just flip it and re-render the list.
  const objTypeBtn = document.getElementById('objects-sort-type');
  const objZBtn = document.getElementById('objects-sort-z');
  if (objTypeBtn) {
    objTypeBtn.addEventListener('click', function () {
      objectsSortMode = 'type';
      renderObjects();
    });
  }
  if (objZBtn) {
    objZBtn.addEventListener('click', function () {
      objectsSortMode = 'z';
      renderObjects();
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

    // Move-grip hit (v0.10.69). The grip lives in the always-on-top overlay
    // box, which belongs to the selected rect — so dragging it MOVES that rect
    // even when the rect body is buried under a higher-Z sibling. Like the
    // resize-handle branch, resolve the rect from selectedId (the grip's
    // ancestor is the overlay box, not a .pe-rect). closest() catches a hit on
    // the inner <span> icon too.
    const gripEl = ev.target && ev.target.closest &&
                   ev.target.closest('.pe-move-grip');
    if (gripEl) {
      const sr = state.rects.find(function (x) { return x.id === selectedId; });
      if (!sr) return;
      drag = {
        mode:      'move',
        id:        selectedId,
        pointerId: ev.pointerId,
        startX:    ev.clientX,
        startY:    ev.clientY,
        origX:     sr.x,
        origY:     sr.y,
        moved:     false
      };
      ev.preventDefault();
      return;
    }

    // Resize handle hit (v0.10.67). Handles live in the always-on-top
    // overlay, which belongs to the selected rect — so a handle hit resizes
    // selectedId even when the rect itself is buried under a higher-Z rect.
    // Resolve the rect from selectedId, not from a DOM-ancestor walk (the
    // handle's ancestor is the overlay box, not a .pe-rect).
    if (handleEl) {
      const sr = state.rects.find(function (x) { return x.id === selectedId; });
      if (!sr) return;
      drag = {
        mode:      'resize',
        dir:       handleEl.dataset.dir,
        id:        selectedId,
        pointerId: ev.pointerId,
        startX:    ev.clientX,
        startY:    ev.clientY,
        origX:     sr.x,
        origY:     sr.y,
        origW:     sr.w,
        origH:     sr.h,
        moved:     false
      };
      render();
      ev.preventDefault();
      return;
    }

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
    {
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
    // Focal-dot pan (independent of `drag`). Handled here, not on the dot,
    // so capture loss can't strand the gesture (v0.10.57).
    if (focusDrag && ev.pointerId === focusDrag.pointerId) {
      const r = state.rects.find(function (x) { return x.id === focusDrag.rectId; });
      if (r) {
        const cur = focusDrag.axis === 'x' ? ev.clientX : ev.clientY;
        const f = clampFocus(
          focusDrag.startFocus + (cur - focusDrag.startClient) / focusDrag.range * 100
        );
        if (f !== focusDrag.startFocus) focusDrag.dirty = true;
        if (focusDrag.axis === 'x') r.focusX = f; else r.focusY = f;
        // Imperative live crop update — no render() mid-drag (it would
        // rebuild the dot). The dot is hidden during the pan anyway.
        const fimg = surface.querySelector(
          '[data-rect-id="' + focusDrag.rectId + '"] .pe-rect-img'
        );
        if (fimg) {
          fimg.style.objectPosition =
            clampFocus(r.focusX) + '% ' + clampFocus(r.focusY) + '%';
        }
      }
      return;
    }
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
          // Live chrome/dot detach as the size crosses TINY_MAX (v0.10.53).
          refreshSizeChrome(el, r);
        }
        updateOverlayBox(r); // keep the always-on-top handles tracking
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
        updateOverlayBox(r); // keep the always-on-top handles tracking
      }
      writeStatus();
    }
  });

  // End the focal-dot pan from a document-level release so it can't be
  // stranded by pointer-capture loss (v0.10.57). Clears is-panning on
  // whatever element still carries it — the release may have targeted a
  // different element than the dot, and render() rebuilds the node anyway.
  function endFocusDrag(ev) {
    if (!focusDrag || ev.pointerId !== focusDrag.pointerId) return false;
    const changed = focusDrag.dirty === true;
    focusDrag = null;
    // Clear is-panning wherever it landed — both the rect (z-lift) and the
    // overlay box (dot-hide + rings). render() rebuilds the box anyway, but
    // clearing defensively avoids a stale state if a render is skipped.
    surface.querySelectorAll('.is-panning').forEach(function (n) {
      n.classList.remove('is-panning');
    });
    if (changed) markDirty();
    render(); // canonical re-render — rebuilds the dot at the new focal point
    return true;
  }

  document.addEventListener('pointerup', function (ev) {
    if (endFocusDrag(ev)) return;
    if (!drag || ev.pointerId !== drag.pointerId) return;
    const wasDrag = drag.moved;
    drag = null;
    if (wasDrag) { markDirty(); render(); } // canonical re-render after a commit
    // If it was a click (no movement), selection already happened on
    // pointerdown — nothing more to do here.
  });

  document.addEventListener('pointercancel', function (ev) {
    if (endFocusDrag(ev)) return;
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
  // A rect whose smaller side is below this lifts its kind/id chrome out
  // above the rect (CSS `.is-tiny`) AND detaches the focal dot to just
  // outside the rect. One shared threshold so "small image" behaves
  // consistently: both chrome and dot move out together (previously the
  // dot used a separate 70px cutoff, so a 70–100px rect lifted its chrome
  // but kept the dot inside — read as "the dot isn't moved out").
  const TINY_MAX = 100;

  // Focal-dot pan control (step 4d). Appended to a selected, cover-mode
  // image rect that has a real aspect mismatch (i.e. the cover crop
  // actually hides part of the image). The dot drags along the single
  // overflow axis — the other axis is locked because object-position on
  // a non-overflowing axis has no visible effect. The dot is a *grab
  // handle*, not a live position readout: during the drag it's hidden and
  // the rect outline switches to a "panning" style, with the live image
  // crop as the sole feedback (so the dot can never get stranded outside
  // the rect — Bug: it used to track the pointer to the edge and vanish).
  // It reappears (at its fixed outside-edge park spot) on pointerup via
  // render(). Mapping is relative (drag-delta), so the handle's position
  // need not track the focal point — which is why it can be parked fixed.

  // host = the element the dot is appended to and measured against. Since
  // v0.10.68 that's the overlay box (which matches the rect's geometry), so
  // the dot is part of the always-on-top chrome and stays visible/grabbable
  // when the image rect is buried. Idempotent: drops any existing dot first,
  // so it can be called to refresh during a live resize.
  function maybeAddFocusDot(host, rect, imgRatio) {
    const stale = host.querySelector('.pe-focus-dot');
    if (stale) stale.remove();
    const rw = rect.w | 0, rh = rect.h | 0;
    const rectRatio = rh > 0 ? rw / rh : 0;
    if (rectRatio <= 0) return;
    // Same >0.5% relative-difference threshold the Fit panel uses — below
    // it the crop hides nothing worth panning, so no dot.
    if (Math.abs(rectRatio - imgRatio) / imgRatio <= 0.005) return;
    // Cover scales to the larger ratio: an image wider than the rect
    // overflows horizontally (pan X); a taller one overflows vertically
    // (pan Y). Exactly one axis overflows in cover mode.
    const axis = imgRatio > rectRatio ? 'x' : 'y';

    // The dot is a FIXED grab handle, not a focal-point readout (since
    // v0.10.52 the live image crop is the sole feedback). So park it at a
    // stable spot just OUTSIDE the rect, on the edge parallel to the pan
    // axis. The old "rest at the focal point" placement caused two
    // problems the user hit (v0.10.58): the dot wandered to a different
    // spot every pan, and at a centred focal point it sat dead-centre
    // UNDER the kind label — invisible (label is z:4, dot z:3) yet still
    // the hit target (label is pointer-events:none), so clicking the type
    // secretly started a pan. Parking outside fixes both. is-detached
    // gives the heavier ring so it reads against the canvas.
    const dot = document.createElement('div');
    dot.className = 'pe-focus-dot pe-focus-dot--' + axis + ' is-detached';
    dot.title = 'Drag to choose which part of the image shows';

    if (axis === 'x') {
      // Horizontal pan → handle centred just below the bottom edge; the
      // user slides it left/right, parallel to that edge. +17px clears the
      // dot's own half-size (it's centred on its anchor via translate).
      dot.style.left = '50%';
      dot.style.top  = 'calc(100% + 17px)';
    } else {
      // Vertical pan → handle centred just outside the right edge; slide
      // it up/down, parallel to that edge.
      dot.style.left = 'calc(100% + 17px)';
      dot.style.top  = '50%';
    }

    dot.addEventListener('pointerdown', function (ev) {
      ev.stopPropagation();   // don't let the surface treat this as a rect move
      ev.preventDefault();
      const hostBox = host.getBoundingClientRect();
      const axisSize = axis === 'x' ? hostBox.width : hostBox.height;
      // Relative (drag-delta) mapping in every case: full 0→100 pan over
      // `range` px of pointer travel, floored at 140px so even a tiny rect
      // sweeps comfortably. Relative (not absolute "dot follows pointer")
      // is what lets us hide the dot during the drag — there's no need to
      // keep it under the finger.
      focusDrag = {
        rectId:      rect.id,
        pointerId:   ev.pointerId,
        axis:        axis,
        startClient: axis === 'x' ? ev.clientX : ev.clientY,
        startFocus:  axis === 'x' ? clampFocus(rect.focusX) : clampFocus(rect.focusY),
        range:       Math.max(axisSize, 140),
        dirty:       false
      };
      // Enter panning mode. The chrome (hide dot + dotted rings) is on the
      // overlay box so it stays on top; the rect ALSO gets is-panning purely
      // for its z-lift (line ~307), so the live image crop — the sole pan
      // feedback — rises above neighbouring rects even when buried.
      host.classList.add('is-panning');
      const rectEl = surface.querySelector('[data-rect-id="' + rect.id + '"]');
      if (rectEl) rectEl.classList.add('is-panning');
      // setPointerCapture is a nicety for the common case; the move/end of
      // the focus drag are handled at the DOCUMENT level (see the document
      // pointermove/up/cancel handlers) so they fire no matter where the
      // pointer is released — capture on the hidden dot was being lost when
      // the user let go outside the rect / near a corner, stranding the
      // is-panning chrome (v0.10.57).
      try { dot.setPointerCapture(ev.pointerId); } catch (e) {}
    });

    host.appendChild(dot);
  }

  // Live-refresh the size-dependent chrome on an existing rect node WITHOUT
  // a full render() — used during a resize drag so the kind/id chrome lift
  // and the focal-dot detach track the size as the handle moves, instead of
  // snapping into place only on pointerup. (A full render() would destroy
  // the resize handle mid-drag and drop its pointer capture.) Mirrors the
  // is-tiny + maybeAddFocusDot logic in renderRect.
  function refreshSizeChrome(el, rect) {
    if (Math.min(rect.w | 0, rect.h | 0) < TINY_MAX) el.classList.add('is-tiny');
    else el.classList.remove('is-tiny');
    // The focal dot lives in the overlay box now (v0.10.68); its live update
    // during a resize is handled by updateOverlayBox → refreshOverlayDot, not
    // here. This function only manages the rect's own size-dependent chrome.
  }

  function renderRect(rect, index) {
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

    // v0.10.51: a rect under 100px in either dimension is too small to
    // hold its kind label + id without them overlapping/mangling. Tag it
    // `is-tiny` so the CSS lifts the chrome OUT, stacked above the rect
    // — the same "detach when small" idea as the focal dot.
    if (Math.min(rect.w | 0, rect.h | 0) < TINY_MAX) el.classList.add('is-tiny');

    // Bound-image preview (step 4b). For an image-kind rect that
    // carries a filename, paint the real image behind the labels so
    // the binding is visible on the canvas. Three states:
    //   - library loaded + filename found → <img> (object-fit:cover).
    //   - library loaded + filename absent → .is-img-missing (dangling
    //     binding, e.g. the file was renamed/removed) → red flag.
    //   - library not loaded yet → no img; the stub shows until the
    //     async fetch resolves and triggers a re-render.
    if (rect.kind === 'image' && rect.image) {
      const found = imageByFilename[rect.image];
      if (found && found.url) {
        const img = document.createElement('img');
        img.className = 'pe-rect-img';
        img.src = found.url;
        img.alt = found.alt || '';
        img.draggable = false;
        // v0.10.50: object-position lets the author choose which part of
        // a cover-cropped image shows. Stored as focusX/focusY (0–100).
        const fx = clampFocus(rect.focusX), fy = clampFocus(rect.focusY);
        img.style.objectPosition = fx + '% ' + fy + '%';
        el.appendChild(img);
        el.classList.add('has-image');
        // v0.10.47: data-fit drives object-fit in CSS (cover|contain).
        el.dataset.fit = (rect.fit === 'contain') ? 'contain' : 'cover';
        // v0.10.68: the focal-pan dot is no longer a child of the rect. It
        // moved into the always-on-top selection overlay (see renderOverlay
        // → maybeAddFocusDot) so it stays grabbable when the selected rect
        // is buried under a higher-Z sibling — same motivation as the resize
        // handles relocating in v0.10.67.
      } else if (imageLibrary !== null) {
        el.classList.add('is-img-missing');
      }
    }

    const label = document.createElement('span');
    label.className = 'pe-rect-label';
    label.textContent = rect.kind || '?';
    // Layer (Z) badge after the kind, so the stacking order is legible
    // on the canvas without selecting (v0.10.65). z = array index + 1;
    // the frontmost rect carries the highest number.
    if (typeof index === 'number') {
      const zTag = document.createElement('span');
      zTag.className = 'pe-rect-z';
      zTag.textContent = 'z' + (index + 1);
      label.appendChild(zTag);
    }
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

    // Resize handles are NOT children of the rect anymore (v0.10.67).
    // They live in the always-on-top selection overlay (renderOverlay)
    // so they stay grabbable when the selected rect is buried under a
    // higher-Z rect — the motivation for author-managed layering.

    return el;
  }

  // Selection overlay (v0.10.67 — "Figma-style" chrome). A single layer
  // appended LAST to the surface, so it paints above every rect regardless
  // of stacking order. It carries the selection outline + the eight resize
  // handles for the currently-selected rect, positioned to match it. The
  // container is click-through (pointer-events:none); only the handles opt
  // back in, so clicking a rect body still hits the rect, not the overlay.
  function renderOverlay() {
    const ov = document.createElement('div');
    ov.className = 'pe-overlay';
    const r = selectedId &&
              state.rects.find(function (x) { return x.id === selectedId; });
    if (!r) return ov; // nothing selected → empty, fully click-through

    const box = document.createElement('div');
    box.className = 'pe-overlay-box';
    box.style.left   = (r.x | 0) + 'px';
    box.style.top    = (r.y | 0) + 'px';
    box.style.width  = (r.w | 0) + 'px';
    box.style.height = (r.h | 0) + 'px';

    // Handle offsets (-6px etc.) are relative to the box, which matches the
    // rect's geometry exactly — so the same per-direction CSS still lands.
    ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].forEach(function (d) {
      const h = document.createElement('div');
      h.className = 'pe-resize-handle pe-resize-handle--' + d;
      h.dataset.dir = d;
      box.appendChild(h);
    });
    // Move grip (v0.10.69) — an always-on-top drag handle so the selected
    // rect can be MOVED even when fully buried under a higher-Z sibling (its
    // body is unreachable; the box, at the z-index ceiling, is not). Parked
    // as a tab just above the box top edge so it never sits over content and
    // doesn't fight the body's own drag-to-move when the rect is exposed. The
    // explicit icon target is also the touch-friendly path for the planned
    // tablet UI (text-dense body-drag is hard on touch).
    const grip = document.createElement('div');
    grip.className = 'pe-move-grip';
    grip.title = 'Drag to move (works even when this rect is buried)';
    const gicon = document.createElement('span');
    gicon.className = 'material-icons';
    gicon.textContent = 'open_with';
    grip.appendChild(gicon);
    box.appendChild(grip);
    // Focal-pan dot (v0.10.68) — lives in the overlay box, on top of every
    // rect, so a buried image rect's pan handle stays grabbable. Only on an
    // image rect in cover mode whose image actually has hidden parts to pan
    // to (ratio mismatch); maybeAddFocusDot itself re-checks the threshold.
    maybeAddOverlayDot(box, r);
    ov.appendChild(box);
    return ov;
  }

  // Decide whether the selected image rect warrants a focal-pan dot, and if
  // so build it into the given overlay box. Centralises the kind/fit/ratio
  // gate so renderOverlay (initial paint) and refreshOverlayDot (live resize)
  // share one rule.
  function maybeAddOverlayDot(box, r) {
    if (!box || !r) return;
    if (r.kind !== 'image' || !r.image) return;
    if ((r.fit || 'cover') !== 'cover') return;
    const found = imageByFilename[r.image];
    if (!found || !(found.ratio > 0)) return;
    maybeAddFocusDot(box, r, found.ratio);
  }

  // Live-track the overlay box to the selected rect during a move/resize
  // drag (the box is rebuilt fresh by render() on pointerup). Identified by
  // class — NOT data-rect-id — so the existing rect-element querySelector in
  // the drag handler keeps resolving the rect, not the box.
  function updateOverlayBox(r) {
    const box = surface.querySelector('.pe-overlay-box');
    if (!box || !r) return;
    box.style.left   = (r.x | 0) + 'px';
    box.style.top    = (r.y | 0) + 'px';
    box.style.width  = (r.w | 0) + 'px';
    box.style.height = (r.h | 0) + 'px';
    refreshOverlayDot(box, r);
  }

  // Live-update the focal-pan dot during a resize drag (v0.10.68). Resizing
  // changes the rect ratio, which can flip the overflow axis (x↔y) or cross
  // the no-pan threshold — so the dot must be rebuilt, not just repositioned.
  // updateOverlayBox runs only during move/resize, never during a pan, so
  // tearing down and rebuilding the dot here can't strand an in-flight pan.
  function refreshOverlayDot(box, r) {
    if (!box || !r) return;
    const gatesDot =
      r.kind === 'image' && r.image && (r.fit || 'cover') === 'cover' &&
      imageByFilename[r.image] && imageByFilename[r.image].ratio > 0;
    if (gatesDot) {
      maybeAddOverlayDot(box, r); // re-checks ratio threshold internally
    } else {
      const stale = box.querySelector('.pe-focus-dot');
      if (stale) stale.remove();
    }
  }

  function render() {
    surface.innerHTML = '';
    state.rects.forEach(function (r, i) {
      surface.appendChild(renderRect(r, i));
    });
    // Selection chrome paints above every rect (appended last).
    surface.appendChild(renderOverlay());
    renderChapters();
    renderSelection();
    renderObjects();
    writeStatus();
  }

  // ────────────────────────────────────────────────────────────────
  // Sidebar: OBJECTS (v0.10.70) — navigation/help list so a rect hidden
  // behind another (or simply forgotten) stays reachable. Click a row to
  // select that rect; the selection chrome (move grip + handles) then makes
  // it actionable even when buried. Two display modes (T = by type, Z = by
  // layer) chosen by the header buttons. "Name" shown is the NOTE field,
  // falling back to the id when no note is set (the note exists precisely to
  // give objects a semantic label).
  // ────────────────────────────────────────────────────────────────
  function objectDisplayName(r) {
    const note = (r.note && typeof r.note === 'string') ? r.note.trim() : '';
    return note !== '' ? note : (r.id || '?');
  }

  // One clickable object row: name-or-note on the left, "z N" on the right.
  function objectRow(r) {
    const zIdx = rectIndex(r.id);
    const li = document.createElement('li');
    li.className = 'pe-object';
    li.dataset.rectId = r.id;
    if (r.id === selectedId) li.classList.add('is-current');
    // Title carries the id even when a note is shown, so hovering a labelled
    // row still reveals which rect it is.
    li.title = (objectDisplayName(r) === r.id) ? r.id
             : (objectDisplayName(r) + '  ·  ' + r.id);

    const name = document.createElement('span');
    name.className = 'pe-object-name';
    // No note → show the id but mark it dim/italic so "unlabelled" reads at a
    // glance and nudges the author to add a note.
    if (objectDisplayName(r) === r.id) name.classList.add('is-unnamed');
    name.textContent = objectDisplayName(r);

    const z = document.createElement('span');
    z.className = 'pe-object-z';
    z.textContent = 'z' + (zIdx + 1);

    li.appendChild(name);
    li.appendChild(z);
    li.addEventListener('click', function () {
      selectedId = r.id;
      render();
    });
    return li;
  }

  function renderObjects() {
    const host = document.getElementById('objects-body');
    if (!host) return;
    host.innerHTML = '';

    // Reflect the active mode on the header buttons.
    const tBtn = document.getElementById('objects-sort-type');
    const zBtn = document.getElementById('objects-sort-z');
    if (tBtn) tBtn.classList.toggle('is-active', objectsSortMode === 'type');
    if (zBtn) zBtn.classList.toggle('is-active', objectsSortMode === 'z');

    if (!state.rects.length) {
      const empty = document.createElement('div');
      empty.className = 'pe-empty';
      empty.textContent = 'No objects yet.';
      host.appendChild(empty);
      return;
    }

    // Descending Z (frontmost first) in both modes — matches a layers
    // panel: the row at the top is the object on top.
    const byZDesc = function (a, b) { return rectIndex(b.id) - rectIndex(a.id); };

    if (objectsSortMode === 'z') {
      const ul = document.createElement('ul');
      ul.className = 'pe-objects';
      state.rects.slice().sort(byZDesc).forEach(function (r) {
        ul.appendChild(objectRow(r));
      });
      host.appendChild(ul);
      return;
    }

    // Mode 'type': one sublist per kind present, kinds in KIND_ORDER then any
    // extras alphabetically; within a kind, Z-descending.
    const kinds = state.rects.map(function (r) { return r.kind || 'unknown'; });
    const present = [];
    KIND_ORDER.forEach(function (k) { if (kinds.indexOf(k) >= 0) present.push(k); });
    kinds.slice().sort().forEach(function (k) {
      if (KIND_ORDER.indexOf(k) < 0 && present.indexOf(k) < 0) present.push(k);
    });

    present.forEach(function (kind) {
      const group = state.rects.filter(function (r) {
        return (r.kind || 'unknown') === kind;
      }).sort(byZDesc);
      if (!group.length) return;

      const sub = document.createElement('div');
      sub.className = 'pe-objects-group';
      const head = document.createElement('div');
      head.className = 'pe-objects-subhead';
      head.textContent = kind + ' (' + group.length + ')';
      sub.appendChild(head);

      const ul = document.createElement('ul');
      ul.className = 'pe-objects';
      group.forEach(function (r) { ul.appendChild(objectRow(r)); });
      sub.appendChild(ul);
      host.appendChild(sub);
    });
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

    // Kind row — the kind, plus the "z N / M" stacking readout trailing
    // it (per "show Z after the rect type"). Keeping the readout here frees
    // the Layer row to hold its four buttons on a single line.
    const zIdx   = rectIndex(r.id);
    const zTotal = state.rects.length;
    const kindDim = document.createElement('span');
    kindDim.className = 'pe-dim';
    kindDim.textContent = r.kind;
    const zText = document.createElement('span');
    zText.className = 'pe-kind-z';
    zText.textContent = 'z ' + (zIdx + 1) + ' / ' + zTotal;
    kindDim.appendChild(zText);
    body.appendChild(row('Kind', kindDim));

    // Layer (Z) row — the four standard reorder controls (v0.10.65).
    // Buttons disable at the ends so the author can't no-op off the stack.
    // Selection is preserved through each move, and since a statically-
    // selected rect is no longer force-lifted, the reorder is immediately
    // visible on the canvas.
    const layer  = document.createElement('div');
    layer.className = 'pe-layer-controls';
    // [icon, title, handler, disabled] — ordered back→front, matching
    // the request: to bottom · down 1 · up 1 · to top. Single-step moves
    // use plain directional arrows (arrow_up/downward) rather than chevrons,
    // which read as a dropdown/disclosure caret; the to-end moves keep the
    // arrow-to-a-bar glyphs (vertical_align_*).
    [
      ['vertical_align_bottom', 'Send to back',   moveRectToBottom, zIdx <= 0],
      ['arrow_downward',        'Send backward',  moveRectDown,     zIdx <= 0],
      ['arrow_upward',          'Bring forward',  moveRectUp,       zIdx >= zTotal - 1],
      ['vertical_align_top',    'Bring to front', moveRectToTop,    zIdx >= zTotal - 1]
    ].forEach(function (spec) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'pe-layer-btn';
      b.title = spec[1];
      b.setAttribute('aria-label', spec[1]);
      b.disabled = spec[3];
      const ic = document.createElement('span');
      ic.className = 'material-icons';
      ic.textContent = spec[0];
      b.appendChild(ic);
      b.addEventListener('click', function () { spec[2](r.id); });
      layer.appendChild(b);
    });
    body.appendChild(row('Layer', layer));

    // Image binding (step 4b) — only for image-kind rects. Shows the
    // current binding with a thumb + filename and Change/Unbind, or a
    // "Bind image…" button when unbound. A dangling binding (filename
    // not in the loaded library) is flagged so the author notices.
    if (r.kind === 'image') {
      const bind = document.createElement('div');
      bind.className = 'pe-image-bind';

      if (r.image) {
        const found = imageByFilename[r.image];
        const card  = document.createElement('div');
        card.className = 'pe-image-bound' + (found ? '' : ' is-missing');

        if (found && found.thumb) {
          const th = document.createElement('img');
          th.className = 'pe-image-bound-thumb';
          th.src = found.thumb;
          th.alt = '';
          card.appendChild(th);
        }
        const meta = document.createElement('div');
        meta.className = 'pe-image-bound-meta';
        const name = document.createElement('span');
        name.className = 'pe-image-bound-name';
        name.textContent = r.image;
        name.title = r.image;
        meta.appendChild(name);
        const sub = document.createElement('span');
        sub.className = 'pe-image-bound-sub';
        sub.textContent = found
          ? (found.width + '×' + found.height + ' · ' + found.size)
          : (imageLibrary === null ? 'loading library…' : 'not found in library');
        meta.appendChild(sub);
        card.appendChild(meta);
        bind.appendChild(card);

        const acts = document.createElement('div');
        acts.className = 'pe-image-bind-actions';
        const change = document.createElement('button');
        change.type = 'button';
        change.className = 'pe-create-btn';
        change.textContent = 'Change…';
        change.addEventListener('click', function () { openImagePicker(r.id); });
        const unbind = document.createElement('button');
        unbind.type = 'button';
        unbind.className = 'pe-image-unbind';
        unbind.textContent = 'Unbind';
        unbind.addEventListener('click', function () { setRectImage(r.id, null); });
        acts.appendChild(change);
        acts.appendChild(unbind);
        bind.appendChild(acts);
      } else {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'pe-create-btn pe-image-bind-open';
        btn.textContent = 'Bind image…';
        btn.addEventListener('click', function () { openImagePicker(r.id); });
        bind.appendChild(btn);
      }
      body.appendChild(row('Image', bind));

      // Fit controls (step 4c) — only meaningful once a bound image is
      // actually resolved in the library (we need its real dimensions).
      // Always offer the Cover/Contain toggle; surface the aspect-ratio
      // mismatch readout + "Match rect to image" only when the ratios
      // actually differ, so a well-matched rect stays uncluttered.
      const fitFound = r.image ? imageByFilename[r.image] : null;
      if (fitFound && fitFound.ratio > 0) {
        const rectRatio = (r.h | 0) > 0 ? (r.w | 0) / (r.h | 0) : 0;
        const imgRatio  = fitFound.ratio;
        // Relative difference; >0.5% counts as a visible mismatch.
        const mismatch = rectRatio > 0 &&
          Math.abs(rectRatio - imgRatio) / imgRatio > 0.005;

        const fitBox = document.createElement('div');
        fitBox.className = 'pe-fit';

        // Segmented Cover / Contain toggle.
        const seg = document.createElement('div');
        seg.className = 'pe-fit-seg';
        [['cover', 'Cover', 'Fill the rect, cropping overflow'],
         ['contain', 'Contain', 'Fit the whole image, letterboxing the rest']
        ].forEach(function (opt) {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'pe-fit-opt' + ((r.fit || 'cover') === opt[0] ? ' is-active' : '');
          b.textContent = opt[1];
          b.title = opt[2];
          b.addEventListener('click', function () { setRectFit(r.id, opt[0]); });
          seg.appendChild(b);
        });
        fitBox.appendChild(seg);

        if (mismatch) {
          const note = document.createElement('div');
          note.className = 'pe-fit-mismatch';
          const fmt = function (x) { return (Math.round(x * 100) / 100).toFixed(2); };
          note.textContent = 'Aspect: rect ' + fmt(rectRatio) +
            ' vs image ' + fmt(imgRatio);
          fitBox.appendChild(note);

          const match = document.createElement('button');
          match.type = 'button';
          match.className = 'pe-create-btn pe-fit-match';
          match.textContent = 'Match rect to image';
          match.title = 'Resize the rect to the image ratio (keeps width, adjusts height)';
          match.addEventListener('click', function () { matchRectToImage(r.id); });
          fitBox.appendChild(match);
        }

        body.appendChild(row('Fit', fitBox));
      }
    }

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
    // While the image picker owns the screen, the canvas shortcuts
    // (Delete-rect, Escape-deselect) must not fire. The picker's own
    // capture-phase handler deals with Escape; everything else is a
    // no-op until it closes.
    if (pickerEl) return;
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
    // Plain "s" saves (outside text fields), mirroring the draw editor.
    // Cmd/Ctrl+S above works everywhere; this is the quick bare-key form.
    if (ev.key === 's' || ev.key === 'S') {
      ev.preventDefault();
      doSave();
      return;
    }
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

  // Kick the image-library fetch after first paint. Bound image rects
  // upgrade stub → <img> when it resolves; the binding UI and picker
  // reuse the same cached list. Fire-and-forget — render() is called
  // inside loadImageLibrary() on completion.
  loadImageLibrary();

  // Expose for console-poking during early-stage debugging only.
  // Removed once step 4 surfaces this through real UI.
  window.__pageEditor = { state: state, render: render };
})();
