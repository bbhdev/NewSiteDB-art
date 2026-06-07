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
    // v0.10.75 (Slice 3a): `typographyId` — the typography token a text
    // rect renders with. Additive within schema v3, null default.
    if (r && typeof r === 'object' && !('typographyId' in r)) r.typographyId = null;
  });

  // Typography tokens (Slice 3a). The site-wide type styles a text rect
  // can point at; emitted as .ty-<id> CSS by the template, so picking a
  // token here previews in the rect's actual face. typoById indexes the
  // list for O(1) lookup in the selection panel + canvas render.
  state.typography = Array.isArray(state.typography) ? state.typography : [];
  const typoById = {};
  state.typography.forEach(function (t) {
    if (t && t.id) typoById[t.id] = t;
  });

  // Palette (TS3-a). The site-wide colours a text rect's `color` marks
  // can reference; the template emits one .mk-color-<id> rule per entry,
  // so a colour swatch picked in the toolbar previews in its true colour.
  // paletteById indexes the list for O(1) lookup. Only the list is needed
  // in JS (for the swatch UI) — the CSS itself comes from the template.
  state.palette = Array.isArray(state.palette) ? state.palette : [];
  const paletteById = {};
  state.palette.forEach(function (p) {
    if (p && p.id) paletteById[p.id] = p;
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
  // Slice T2: id of the text rect currently in inline on-canvas edit mode
  // (its .pe-rect-text becomes contenteditable). null = nobody editing.
  // Separate from selectedId: a rect is selected first, then double-clicked
  // to enter editing; exiting editing keeps it selected.
  let editingId = null;
  // Slice TS1 (v0.10.86): last-known plain text of the rect currently being
  // inline-edited. The contenteditable `input` handler diffs the live
  // textContent against this to compute a single {p,d,i} edit, remaps the
  // rect's style marks through it, then updates editText. Reset on
  // enterEditMode; meaningless while editingId == null.
  let editText = '';
  // Slice TS1 (v0.10.90): one-time guard for the document selectionchange
  // listener that keeps the B/I toolbar's pressed-state in sync with the
  // current selection while editing.
  let selChangeBound = false;
  // Slice TS2-b (v0.10.95): collapsed-caret PENDING format. When the author
  // toggles B/I with no selection (just a caret), there's no text to mark
  // yet — instead we remember the intended attrs here and apply them to the
  // NEXT typed characters. A Set of attr names, or null when there is no
  // override (typing then inherits naturally via remapMarks). An EMPTY Set is
  // a real override too: "type unstyled here" (e.g. caret inside a bold run,
  // hit B, type → plain). Edit-scoped, never persisted; reset on
  // enter/commit/cancel and cleared when the caret moves or a selection forms.
  let pendingAttrs = null;
  // Slice TS3-b-2 (v0.10.99): inline LINK url editor state. Unlike the colour
  // swatches (which apply on click and NEVER take focus — they preventDefault
  // so the editable keeps focus + selection), the link URL needs a real
  // <input> that DOES take focus. Focusing it blurs the editable, so two
  // things are needed: (1) capture the selection range BEFORE the input steals
  // focus (savedLinkRange) so the mark lands on the right text after the fact;
  // (2) guard the editable's blur→commit against focus moving into the toolbar
  // (see the blur handler). linkEditOpen drives the toolbar's input-row
  // disclosure. Both reset on enter/commit/cancel of the edit.
  let linkEditOpen = false;
  let savedLinkRange = null;
  // Slice T2 (v0.10.85): manual double-click/double-tap detection. We can't
  // use the native 'dblclick' event because the pointerdown handler calls
  // preventDefault() on every rect hit, and preventDefault on pointerdown
  // suppresses the browser's synthesized click/dblclick compatibility events.
  // Track the last tap's time + rect id ourselves; two taps on the same text
  // rect within DOUBLE_TAP_MS enter edit mode. Also gives the tablet layer a
  // real double-tap for free.
  let lastTapTime = 0;
  let lastTapId = null;
  const DOUBLE_TAP_MS = 350;
  let drag = null; // { id, pointerId, startX, startY, origX, origY, moved }
  let focusDrag = null; // focal-dot drag (step 4d); independent of `drag`
  // Objects panel (v0.10.70) — session-only display mode: 'type' groups by
  // kind, 'z' is one flat list ordered by layer. Not persisted.
  let objectsSortMode = 'type';
  // Slice (v0.10.100) — side-panel TEXT editor disclosure. The rect's text is
  // already visible on the canvas, so the panel doesn't show the (space-hungry)
  // textarea by default; it's opened on demand via an "Edit text here" button,
  // per rect, for this session only. A Set of rect ids that are currently
  // open. NOTE: unlike the behavior-block disclosure pattern, closing here only
  // HIDES the editor — it never clears r.text (text is primary content, not an
  // optional sparse feature). And it does NOT auto-open when text exists: the
  // canvas already shows that text, so there's no "data with no UI" risk that
  // the auto-open rule guards against.
  const panelTextOpen = new Set();
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
    if (editingId === id)  editingId  = null; // T2: drop a dangling edit
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

  // Slice 3a: typography token binding for text rects. tokenId '' / null
  // clears the binding (rect renders with inherited defaults). Unknown
  // ids are ignored (shouldn't happen via the UI dropdown).
  function setRectTypography(rectId, tokenId) {
    const r = state.rects.find(function (x) { return x.id === rectId; });
    if (!r) return;
    const next = (tokenId == null || tokenId === '') ? null : String(tokenId);
    if (next !== null && !typoById[next]) return;
    if (r.typographyId === next) return;
    r.typographyId = next;
    markDirty();
    render();
  }

  // Slice T1: plain-text body content for a text rect. Whitespace WITHIN
  // the content is preserved verbatim (the rect renders it pre-wrap), but
  // a wholly-blank value collapses to null so an "empty" text rect stores
  // no content and falls back to its stub — mirrors setRectNote's null
  // discipline. Capped at 5000 chars to match the save-route guard.
  function setRectText(rectId, text) {
    const r = state.rects.find(function (x) { return x.id === rectId; });
    if (!r) return;
    const raw  = (text == null ? '' : String(text));
    const next = raw.trim() === '' ? null : raw.slice(0, 5000);
    if ((r.text || null) === next) return;
    r.text = next;
    markDirty();
    render();
  }

  // ════════════════════════════════════════════════════════════════
  // Slice TS1: rich-text offset-marks engine.
  //
  // A text rect's styling is stored as `rect.marks` — an array of
  //   { start, end, attr, value }   over the half-open range [start,end)
  // against the plain `rect.text`. Marks are the NSAttributedString shape:
  // text + keyed-attribute ranges. *Runs* (contiguous same-style segments)
  // are DERIVED at render time by segments() — never stored or hand-edited.
  //
  // TS1 ships two atomic toggle attrs: 'strong' and 'em', value === true.
  // The shape already accommodates valued attrs (color/token/link, TS3).
  // Composition rule: same attr → overwrite/coalesce; different attr →
  // compose. All ops below are PURE and keep marks normalized.
  // ════════════════════════════════════════════════════════════════

  // Ordered layer map attr → CSS class. Written as a table (not a switch)
  // so M2 named-style layers slot in later without touching the resolver.
  // Atomic axes only (value ignored); valued axes are handled in
  // classForMark() below.
  const MARK_ATTR_CLASS = { strong: 'mk-strong', em: 'mk-em', underline: 'mk-underline' };

  // Sanitise a mark value into a CSS-class-safe id fragment (mirrors the
  // PHP preg_replace in deco_marks_classes / the .mk-color-<id> emitter).
  function safeMarkId(v) {
    return String(v == null ? '' : v).replace(/[^a-z0-9_-]/gi, '');
  }

  // Class for one value-bearing attr descriptor. Atomic axes map by name;
  // valued axes (color → palette id) map by name+value so two different
  // colours get two different classes. Mirrors PHP deco_marks_classes().
  function classForMark(attr, value) {
    if (attr === 'color') { const id = safeMarkId(value); return id ? 'mk-color-' + id : null; }
    return MARK_ATTR_CLASS[attr] || null;
  }

  // attrs is the value-bearing list produced by segments(): [{attr,value}].
  // NB: the 'link' attr maps to NO class here (its value is an href, not a
  // class fragment) — links are rendered as <a> by renderRunsInto / the PHP
  // loop, with mk-link added there. classForMark returns null for it.
  function attrsToClasses(attrs) {
    const cls = [];
    for (let k = 0; k < attrs.length; k++) {
      const c = classForMark(attrs[k].attr, attrs[k].value);
      if (c && cls.indexOf(c) === -1) cls.push(c);
    }
    return cls;
  }

  // TS3-b: governance for the `link` attr's value (an href). Returns a safe
  // href string, or null to reject. Allowlist (mirrors PHP deco_safe_href):
  // relative / anchor / root-relative are always safe; http(s):, mailto:,
  // tel: are the permitted explicit schemes; ANY other scheme-like prefix
  // (javascript:, data:, vbscript:, file:, …) is rejected; a bare value with
  // no scheme is treated as a relative path (browser-safe). This is the only
  // place a stored href is trusted — render-time defence-in-depth on top of
  // the save-route check (TS3-b-2), so even a hand-edited rects.json can't
  // emit a javascript: link.
  function safeHref(v) {
    if (typeof v !== 'string') return null;
    v = v.trim();
    if (!v) return null;
    if (/^(#|\/|\.\/|\.\.\/)/.test(v)) return v;          // relative / anchor
    if (/^(https?:|mailto:|tel:)/i.test(v)) return v;     // allowed schemes
    if (/^[a-z][a-z0-9+.-]*:/i.test(v)) return null;      // any other scheme → reject
    return v;                                             // bare relative path
  }

  // The safe href carried by a segment's attrs (first `link` mark), or null.
  function linkHref(attrs) {
    for (let k = 0; k < attrs.length; k++) {
      if (attrs[k].attr === 'link') return safeHref(attrs[k].value);
    }
    return null;
  }

  // Common prefix/suffix diff → a single edit: at position p, d chars were
  // deleted and i chars inserted. Covers type/delete/paste/replace uniformly
  // (run against the input event's before/after textContent). Offsets are
  // UTF-16 code units — same unit contenteditable selection uses.
  function diffText(o, n) {
    o = o == null ? '' : String(o);
    n = n == null ? '' : String(n);
    const ol = o.length, nl = n.length;
    const max = Math.min(ol, nl);
    let p = 0;
    while (p < max && o.charCodeAt(p) === n.charCodeAt(p)) p++;
    let s = 0;
    while (s < (max - p) && o.charCodeAt(ol - 1 - s) === n.charCodeAt(nl - 1 - s)) s++;
    return { p: p, d: ol - p - s, i: nl - p - s };
  }

  // Map one old-text offset through an edit. isStart selects the boundary
  // convention so a strictly-inside insertion GROWS a mark while an
  // insertion at either boundary leaves the new text unstyled (the user
  // can then style it). For a deletion, survivors clip to the edit point.
  function remapPos(x, p, d, i, isStart) {
    if (d === 0) {
      // pure insertion at p
      if (isStart) return x <  p ? x : x + i;   // start==p → after the insert
      else         return x <= p ? x : x + i;   // end==p   → before the insert
    }
    const end = p + d;
    if (x <= p)   return x;
    if (x >= end) return x - d + i;
    // x fell inside the deleted hole: a start jumps past the inserted text,
    // an end clamps to the edit point — neither swallows the inserted chars.
    return isStart ? p + i : p;
  }

  // Remap every mark through an edit; drop any that collapsed to empty
  // (fully covered by a deletion). Survivors keep their attr/value — this
  // is how runs persist across text modification.
  function remapMarks(marks, p, d, i) {
    const out = [];
    for (let k = 0; k < marks.length; k++) {
      const m = marks[k];
      const ns = remapPos(m.start, p, d, i, true);
      const ne = remapPos(m.end,   p, d, i, false);
      if (ne > ns) out.push({ start: ns, end: ne, attr: m.attr, value: m.value });
    }
    return out;
  }

  // Does every char in [a,b) already carry `attr`? (uniformity query that
  // drives toggle semantics). Merges that attr's intervals and checks for
  // full coverage with no gap.
  function rangeHasAttr(marks, a, b, attr) {
    if (b <= a) return false;
    const iv = [];
    for (let k = 0; k < marks.length; k++) {
      const m = marks[k];
      if (m.attr === attr && m.end > a && m.start < b) {
        iv.push([Math.max(m.start, a), Math.min(m.end, b)]);
      }
    }
    iv.sort(function (x, y) { return x[0] - y[0]; });
    let cur = a;
    for (let k = 0; k < iv.length; k++) {
      if (iv[k][0] > cur) return false;       // gap before this interval
      if (iv[k][1] > cur) cur = iv[k][1];
      if (cur >= b) return true;
    }
    return cur >= b;
  }

  // Coverage of `attr` over [a,b): 'none' | 'some' | 'all'. Drives the
  // toolbar's three-state pressed display (TS2): a selection that is fully
  // styled shows the button active, a partially-styled one shows it in the
  // indeterminate "mixed" state, none shows it off. 'some' iff any mark of
  // that attr overlaps the range but it isn't uniformly covered.
  function rangeAttrCoverage(marks, a, b, attr) {
    if (b <= a) return 'none';
    let any = false;
    for (let k = 0; k < marks.length; k++) {
      const m = marks[k];
      if (m.attr === attr && m.end > a && m.start < b) { any = true; break; }
    }
    if (!any) return 'none';
    return rangeHasAttr(marks, a, b, attr) ? 'all' : 'some';
  }

  // Attrs that a collapsed caret at offset `c` would NATURALLY inherit when
  // text is typed there — i.e. those strictly CONTAINING c (m.start < c <
  // m.end). This mirrors remapMarks' insertion rule (a strictly-inside insert
  // grows the mark; a boundary/outside insert stays unstyled). Used to seed
  // pending-format and to light the toolbar when the caret sits inside a run.
  function effAttrsAt(marks, c) {
    const out = [];
    for (let k = 0; k < marks.length; k++) {
      const m = marks[k];
      if (m.start < c && m.end > c && out.indexOf(m.attr) === -1) out.push(m.attr);
    }
    return out;
  }

  // Remove `attr` over [a,b): clip overlapping marks of that attr. A mark
  // that STRICTLY CONTAINS [a,b) splits into two — this is exactly how
  // partial-removal creates new runs. Other attrs are untouched.
  function removeAttrRange(marks, a, b, attr) {
    const out = [];
    for (let k = 0; k < marks.length; k++) {
      const m = marks[k];
      if (m.attr !== attr || m.end <= a || m.start >= b) { out.push(m); continue; }
      if (m.start < a) out.push({ start: m.start, end: a, attr: m.attr, value: m.value });
      if (m.end   > b) out.push({ start: b, end: m.end, attr: m.attr, value: m.value });
      // the [max(start,a), min(end,b)) middle is dropped
    }
    return out;
  }

  // Toggle an atomic attr over [a,b): if already uniform → remove, else add.
  // Pure; caller normalizes the result.
  function applyMark(marks, a, b, attr) {
    if (b <= a) return marks.slice();
    if (rangeHasAttr(marks, a, b, attr)) return removeAttrRange(marks, a, b, attr);
    return marks.concat([{ start: a, end: b, attr: attr, value: true }]);
  }

  // Stable serialization key for a mark value (true vs string).
  function markValKey(v) { return v === true ? 'true' : String(v); }

  // Set a VALUED attr over [a,b) with OVERWRITE semantics (TS3-a): unlike
  // the atomic toggle, a valued axis allows only one value per char, so we
  // first clear any existing mark of that attr in the range (removeAttrRange
  // splits a containing mark — exactly how a partial recolour creates new
  // runs), then add the new value. value == null clears only (no add).
  // Pure; caller normalizes.
  function setMark(marks, a, b, attr, value) {
    if (b <= a) return marks.slice();
    const cleared = removeAttrRange(marks, a, b, attr);
    if (value == null) return cleared;
    return cleared.concat([{ start: a, end: b, attr: attr, value: value }]);
  }

  // Does a SINGLE value of `attr` cover every char in [a,b)? Like
  // rangeHasAttr but restricted to marks whose value matches `value`.
  function rangeHasAttrValue(marks, a, b, attr, value) {
    if (b <= a) return false;
    const vk = markValKey(value);
    const iv = [];
    for (let k = 0; k < marks.length; k++) {
      const m = marks[k];
      if (m.attr === attr && markValKey(m.value) === vk && m.end > a && m.start < b) {
        iv.push([Math.max(m.start, a), Math.min(m.end, b)]);
      }
    }
    iv.sort(function (x, y) { return x[0] - y[0]; });
    let cur = a;
    for (let k = 0; k < iv.length; k++) {
      if (iv[k][0] > cur) return false;
      if (iv[k][1] > cur) cur = iv[k][1];
      if (cur >= b) return true;
    }
    return cur >= b;
  }

  // The single value of `attr` covering ALL of [a,b), or null if the range
  // is unstyled for that attr OR carries a mix of values. (After overwrite
  // semantics there is at most one value per char, so at most one candidate
  // can fully cover.) Drives the active-swatch indicator for a selection.
  function rangeUniformValue(marks, a, b, attr) {
    if (b <= a) return null;
    const cand = {};
    for (let k = 0; k < marks.length; k++) {
      const m = marks[k];
      if (m.attr === attr && m.end > a && m.start < b) cand[markValKey(m.value)] = m.value;
    }
    const keys = Object.keys(cand);
    for (let k = 0; k < keys.length; k++) {
      if (rangeHasAttrValue(marks, a, b, attr, cand[keys[k]])) return cand[keys[k]];
    }
    return null;
  }

  // Current value of `attr` for the editor selection: the uniform value over
  // a non-empty selection, or (collapsed caret) the value of the mark
  // strictly containing it. null = none / mixed. Drives swatch lighting.
  function currentMarkValue(marks, sel, attr) {
    if (!sel) return null;
    if (sel.end > sel.start) return rangeUniformValue(marks, sel.start, sel.end, attr);
    for (let k = 0; k < marks.length; k++) {
      const m = marks[k];
      if (m.attr === attr && m.start < sel.start && m.end > sel.start) return m.value;
    }
    return null;
  }

  // The [start,end) of the `attr` run that strictly CONTAINS offset `pos`
  // (boundaries excluded — matches currentMarkValue's collapsed-caret rule).
  // Marks are normalized to one run per (attr,value), so the first hit is the
  // whole run. Returns null if `pos` isn't inside such a run. Used so a
  // collapsed caret inside a link can edit the whole link without selecting
  // the label by hand first (v0.10.103).
  function markRangeAt(marks, pos, attr) {
    for (let k = 0; k < marks.length; k++) {
      const m = marks[k];
      if (m.attr === attr && m.start < pos && m.end > pos) {
        return { start: m.start, end: m.end };
      }
    }
    return null;
  }

  // Drop empties, clamp to [0,len], merge equal (attr,value) adjacent/
  // overlapping ranges, and return in a deterministic order (by start,
  // then attr) for stable on-disk diffs.
  function normalizeMarks(marks, len) {
    const cleaned = [];
    for (let k = 0; k < marks.length; k++) {
      const m = marks[k];
      const s = Math.max(0, Math.min(len, m.start | 0));
      const e = Math.max(0, Math.min(len, m.end | 0));
      if (e > s && m.attr) {
        cleaned.push({ start: s, end: e, attr: String(m.attr),
                       value: (m.value === undefined ? true : m.value) });
      }
    }
    // group by (attr,value) then start, so a single pass can merge runs
    cleaned.sort(function (x, y) {
      if (x.attr !== y.attr) return x.attr < y.attr ? -1 : 1;
      const xv = markValKey(x.value), yv = markValKey(y.value);
      if (xv !== yv) return xv < yv ? -1 : 1;
      return x.start - y.start;
    });
    const merged = [];
    for (let k = 0; k < cleaned.length; k++) {
      const m = cleaned[k];
      const last = merged[merged.length - 1];
      if (last && last.attr === m.attr && markValKey(last.value) === markValKey(m.value)
          && m.start <= last.end) {
        if (m.end > last.end) last.end = m.end;       // extend the run
      } else {
        merged.push({ start: m.start, end: m.end, attr: m.attr, value: m.value });
      }
    }
    merged.sort(function (x, y) {
      return (x.start - y.start) || (x.attr < y.attr ? -1 : x.attr > y.attr ? 1 : 0);
    });
    return merged;
  }

  // Derive runs: split `text` at every mark boundary and tag each segment
  // with the value-bearing attrs that fully cover it. Returns
  // [{text, attrs:[{attr,value}, …]}] (TS3-a: value-bearing, was bare
  // names). This is the one function reimplemented in PHP (canvas-page.php)
  // for runtime parity. Empty marks → a single unstyled segment.
  function segments(text, marks) {
    text = text == null ? '' : String(text);
    const len = text.length;
    if (!len) return [];
    const ms = marks || [];
    if (!ms.length) return [{ text: text, attrs: [] }];
    const bset = { 0: true };
    bset[len] = true;
    for (let k = 0; k < ms.length; k++) {
      if (ms[k].start > 0 && ms[k].start < len) bset[ms[k].start] = true;
      if (ms[k].end   > 0 && ms[k].end   < len) bset[ms[k].end]   = true;
    }
    const bounds = Object.keys(bset).map(Number).sort(function (a, b) { return a - b; });
    const segs = [];
    for (let k = 0; k < bounds.length - 1; k++) {
      const s = bounds[k], e = bounds[k + 1];
      if (e <= s) continue;
      const attrs = [];
      const seen = {};
      for (let j = 0; j < ms.length; j++) {
        if (ms[j].start <= s && ms[j].end >= e) {
          const key = ms[j].attr + ' ' + markValKey(ms[j].value);
          if (!seen[key]) { seen[key] = true; attrs.push({ attr: ms[j].attr, value: ms[j].value }); }
        }
      }
      segs.push({ text: text.slice(s, e), attrs: attrs });
    }
    return segs;
  }

  // ── Caret helpers — read/restore selection across a span rebuild ──

  // Selection offsets [start,end) relative to root's text content, or null
  // if there's no selection inside root.
  function getCaretOffset(root) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
    const pre = range.cloneRange();
    pre.selectNodeContents(root);
    pre.setEnd(range.startContainer, range.startOffset);
    const start = pre.toString().length;
    return { start: start, end: start + range.toString().length };
  }

  // Find the text node + local offset for a global text offset within root.
  function locateOffset(root, target) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    let acc = 0, node = walker.nextNode(), last = null;
    while (node) {
      const len = node.nodeValue.length;
      if (target <= acc + len) return { node: node, offset: target - acc };
      acc += len; last = node; node = walker.nextNode();
    }
    if (last) return { node: last, offset: last.nodeValue.length };
    return { node: root, offset: 0 };
  }

  // Restore a [a,b) selection inside root after its spans were rebuilt.
  function setSelectionRange(root, a, b) {
    try {
      const sp = locateOffset(root, a), ep = locateOffset(root, b);
      const r = document.createRange();
      r.setStart(sp.node, sp.offset);
      r.setEnd(ep.node, ep.offset);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
    } catch (e) { /* selection API unavailable — focus alone is fine */ }
  }

  // Paint derived runs into a container (used by both the static display and
  // the live editor — same span structure, so styling is identical whether
  // or not the rect is being edited = live WYSIWYG). Content always via
  // textContent / createTextNode — no markup honoured.
  function renderRunsInto(container, text, marks) {
    container.textContent = '';
    const segs = segments(text || '', marks);
    if (!segs.length) { container.textContent = text || ''; return; }
    for (let si = 0; si < segs.length; si++) {
      const seg = segs[si];
      const classes = attrsToClasses(seg.attrs);
      const href = linkHref(seg.attrs);
      if (href) {
        // TS3-b: link segment → real <a>. mk-link carries the underline
        // affordance; any atomic/color classes ride on the same element so a
        // bold-coloured link styles correctly. Content via textContent (no
        // markup honoured); href already passed safeHref(). In contenteditable
        // a plain click places the caret rather than navigating.
        const a = document.createElement('a');
        a.className = ('mk-link ' + classes.join(' ')).trim();
        a.setAttribute('href', href);
        a.textContent = seg.text;
        container.appendChild(a);
      } else if (!classes.length) {
        container.appendChild(document.createTextNode(seg.text));
      } else {
        const sp = document.createElement('span');
        sp.className = classes.join(' ');
        sp.textContent = seg.text;
        container.appendChild(sp);
      }
    }
  }

  // ────────────────────────────────────────────────────────────────
  // Slice T2: inline on-canvas text editing. Double-click a text rect
  // → its .pe-rect-text becomes contenteditable="plaintext-only" (a
  // WebKit/Blink-native plain-text editor: strips paste formatting,
  // and newlines round-trip through textContent with white-space:pre-
  // wrap). The author edits in the rect's actual typography face —
  // true WYSIWYG, and the touch-friendly path for the future tablet
  // layer (double-tap to edit). The side-panel textarea (T1) stays as
  // the secondary surface for long copy.
  // ────────────────────────────────────────────────────────────────

  // Move the caret to the end of a contenteditable element.
  function placeCaretEnd(el) {
    try {
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    } catch (e) { /* selection API unavailable — focus alone is fine */ }
  }

  // Re-focus the live editable after a render() rebuilt the DOM. No-op
  // if it's already focused (so a stray render mid-edit doesn't reset
  // the caret); only re-seats focus + caret when the element is new.
  function focusEditable() {
    if (editingId == null) return;
    const elx = surface && surface.querySelector('.pe-rect-text.is-editing');
    if (!elx) return;
    if (document.activeElement !== elx) {
      elx.focus();
      placeCaretEnd(elx);
    }
  }

  function enterEditMode(rectId) {
    const r = state.rects.find(function (x) { return x.id === rectId; });
    if (!r || r.kind !== 'text') return;
    // Cancel any in-flight drag from the double-click's pointerdowns so a
    // stray pointerup can't move the rect after we enter edit mode.
    drag = null;
    selectedId = rectId;
    editingId  = rectId;
    editText   = r.text || '';   // TS1: baseline for the input-diff remap
    pendingAttrs = null;         // TS2-b: no carried-over pending format
    linkEditOpen = false;        // TS3-b-2: no carried-over link editor
    savedLinkRange = null;
    render();          // rebuilds the rect with a contenteditable text node
    focusEditable();   // then seats focus + caret (caret at end)
  }

  // Commit the live editable's text into state. Reads textContent (never
  // innerHTML — no markup is honoured at this slice), applies the same
  // null/cap discipline as setRectText, but WITHOUT its own render so the
  // caller controls when the DOM rebuilds (avoids a double render and a
  // focus/caret jump). Pass doRender=true to redraw immediately.
  function commitEdit(doRender) {
    if (editingId == null) return;
    const id  = editingId;
    const elx = surface && surface.querySelector('.pe-rect-text.is-editing');
    const raw = elx ? String(elx.textContent || '') : '';
    editingId = null;
    pendingAttrs = null;   // TS2-b: edit-scoped pending format ends with the edit
    linkEditOpen = false;  // TS3-b-2: link editor is edit-scoped too
    savedLinkRange = null;
    const r = state.rects.find(function (x) { return x.id === id; });
    if (r) {
      const next = raw.trim() === '' ? null : raw.slice(0, 5000);
      let changed = false;
      if ((r.text || null) !== next) { r.text = next; changed = true; }
      // TS1: keep marks consistent with the committed text. Empty text drops
      // all marks; otherwise clamp/normalize against the final length (also
      // catches the 5000-char cap trimming the tail).
      const nextMarks = next == null ? [] : normalizeMarks(r.marks || [], next.length);
      if (JSON.stringify(r.marks || []) !== JSON.stringify(nextMarks)) {
        r.marks = nextMarks; changed = true;
      }
      if (changed) markDirty();
    }
    if (doRender) render();
  }

  // Abandon the edit without saving (Escape). The on-disk/in-memory text
  // is untouched; render() drops the contenteditable + restores the
  // normal display node (or the stub if empty).
  function cancelEdit() {
    if (editingId == null) return;
    editingId = null;
    pendingAttrs = null;   // TS2-b: drop pending format on cancel
    linkEditOpen = false;  // TS3-b-2: drop link editor on cancel
    savedLinkRange = null;
    render();
  }

  // Slice TS1: process one edit of the live editable. Diffs the current
  // textContent against editText → a single {p,d,i}, remaps the rect's marks
  // through it (survivors keep their style), normalizes, and records the new
  // text as editText. Does NOT render — the browser already shows the typed
  // text in place (patch-in-place keeps caret + IME composition intact);
  // spans only rebuild on a style apply or on commit.
  function handleEditInput(el, ev) {
    if (editingId == null) return;
    const r = state.rects.find(function (x) { return x.id === editingId; });
    if (!r) return;
    const t = String(el.textContent || '');
    if (t === editText) return;
    const e = diffText(editText, t);
    if (e.d !== 0 || e.i !== 0) {
      let m = remapMarks(r.marks || [], e.p, e.d, e.i);
      // TS2-b: a collapsed-caret pending format applies to the just-inserted
      // text [p, p+i). For every toggle attr: ensure it's present iff pending
      // wants it. This both ADDS style the natural remap wouldn't (typing at a
      // run boundary or in plain text) and REMOVES style it would (typing
      // inside a run with that attr toggled OFF in pending → splits the run).
      let styledInsert = false;
      if (pendingAttrs != null && e.i > 0) {
        const a = e.p, b = e.p + e.i;
        Object.keys(MARK_ATTR_CLASS).forEach(function (attr) {
          const want = pendingAttrs.has(attr);
          const has  = rangeHasAttr(m, a, b, attr);
          if (want && !has)      m = m.concat([{ start: a, end: b, attr: attr, value: true }]);
          else if (!want && has) m = removeAttrRange(m, a, b, attr);
        });
        styledInsert = true;
      }
      r.marks = normalizeMarks(m, t.length);
      // Live WYSIWYG for pending: the raw chars were patched into the DOM
      // UNSTYLED (or in the wrong run), so the spans no longer match the model
      // — repaint and restore the caret to just after the insert. Skip during
      // IME composition: rebuilding the node mid-composition aborts it; the
      // marks are still correct and the style shows on compositionend/commit.
      if (styledInsert && !(ev && ev.isComposing)) {
        renderRunsInto(el, t, r.marks);
        setSelectionRange(el, e.p + e.i, e.p + e.i);
      }
    }
    editText = t;
    markDirty();
  }

  // Insert literal plain text at the caret (used for Enter→'\n' and
  // paste→plaintext, since contenteditable="true" would otherwise insert
  // <div>/<br> on Enter and rich HTML on paste — neither survives our
  // textContent model). Real '\n' chars round-trip through textContent under
  // white-space:pre-wrap. After mutating the DOM we run handleEditInput
  // ourselves (a manual Range edit does not fire the 'input' event).
  function insertPlainTextAtCaret(el, str) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    range.deleteContents();
    const node = document.createTextNode(str);
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
    handleEditInput(el);
  }

  // ── Slice TS1: B/I styling toolbar (floats while editing) ──

  // Toggle an atomic style over the current selection. Collapsed caret is a
  // no-op for now (pending-format is TS2). Uses editText/r.marks (the LIVE
  // edit state — r.text is stale until commit), rebuilds the run spans in
  // place, and restores the selection so the author can keep toggling.
  function toggleStyle(attr) {
    if (editingId == null) return;
    const ed = surface && surface.querySelector('.pe-rect-text.is-editing');
    if (!ed) return;
    const sel = getCaretOffset(ed);
    if (!sel) return;                            // no caret in the editable
    const r = state.rects.find(function (x) { return x.id === editingId; });
    if (!r) return;

    // Collapsed caret → set/clear PENDING format (TS2-b). Nothing to mark yet;
    // the next typed chars pick it up in handleEditInput. Seed from what the
    // caret would naturally inherit so toggling reflects the real next-char
    // state (e.g. caret inside bold → pending starts {strong}, B turns it off).
    if (sel.end <= sel.start) {
      if (pendingAttrs == null) pendingAttrs = new Set(effAttrsAt(r.marks || [], sel.start));
      if (pendingAttrs.has(attr)) pendingAttrs.delete(attr);
      else pendingAttrs.add(attr);
      updateToolbarPressed();
      return;
    }

    // Non-empty selection → apply over the range now; a pending override (if
    // any) is irrelevant once real text is styled, so drop it.
    pendingAttrs = null;
    const len = editText.length;
    r.marks = normalizeMarks(applyMark(r.marks || [], sel.start, sel.end, attr), len);
    markDirty();
    renderRunsInto(ed, editText, r.marks);      // rebuild spans from the model
    setSelectionRange(ed, sel.start, sel.end);  // keep the selection
    updateToolbarPressed();
  }

  // Forget any collapsed-caret pending format and refresh the toolbar. Called
  // when the author moves the caret (arrows / click) or forms a selection —
  // the pending intent was tied to the old caret position.
  function clearPending() {
    if (pendingAttrs == null) return;
    pendingAttrs = null;
    updateToolbarPressed();
  }

  // TS3-a: set (or clear, value === null) a palette COLOUR over the current
  // selection. Selection-only for now — a collapsed caret is a no-op (pending
  // colour, "type in red here", is a deferred follow-on; pendingAttrs is an
  // atomic-toggle Set and can't carry a value). Overwrite semantics via
  // setMark: one colour per char. Rebuilds spans + restores the selection so
  // the author sees the colour land and can keep recolouring.
  function applyColor(value) {
    if (editingId == null) return;
    const ed = surface && surface.querySelector('.pe-rect-text.is-editing');
    if (!ed) return;
    const sel = getCaretOffset(ed);
    if (!sel || sel.end <= sel.start) return;    // selection required
    const r = state.rects.find(function (x) { return x.id === editingId; });
    if (!r) return;
    const len = editText.length;
    r.marks = normalizeMarks(setMark(r.marks || [], sel.start, sel.end, 'color', value), len);
    markDirty();
    renderRunsInto(ed, editText, r.marks);
    setSelectionRange(ed, sel.start, sel.end);
    updateToolbarPressed();
  }

  // TS3-b-2: open the inline link-URL editor for the current selection.
  // Selection-only (like colour) — a collapsed caret is a no-op. We capture
  // the selection range NOW, while focus is still in the editable (the Link
  // button preventDefault'd its pointerdown so the selection is intact), then
  // rebuild the toolbar with the input row and move focus to the input. The
  // editable's blur is guarded against toolbar focus, so the edit survives.
  // The input is prefilled with the existing href when the selection is one
  // uniform link (so the author edits rather than retypes).
  function openLinkInput() {
    if (editingId == null) return;
    const ed = surface && surface.querySelector('.pe-rect-text.is-editing');
    if (!ed) return;
    const sel = getCaretOffset(ed);
    if (!sel) return;
    const r = state.rects.find(function (x) { return x.id === editingId; });
    if (!r) return;
    const marks = r.marks || [];
    // A real selection edits/creates a link over it. A COLLAPSED caret inside
    // an existing link edits that whole link run (v0.10.103 — the read-out's
    // URL/pencil resolve the link at the caret, so the edit gesture must too;
    // before, a caret-without-selection opened nothing). A collapsed caret NOT
    // on a link is a no-op (creating a link needs a selection to span).
    let range;
    if (sel.end > sel.start) {
      range = { start: sel.start, end: sel.end };
    } else {
      range = markRangeAt(marks, sel.start, 'link');
      if (!range) return;
    }
    const cur = currentMarkValue(marks, range, 'link');
    savedLinkRange = { start: range.start, end: range.end };
    linkEditOpen = true;
    buildTextToolbar();                          // rebuild bar WITH the input row
    const bar = document.getElementById('pe-text-toolbar');
    const inp = bar && bar.querySelector('.pe-tt-link-input');
    if (inp) {
      inp.value = (typeof cur === 'string') ? cur : '';
      inp.focus();
      inp.select();
    }
  }

  // Apply (or remove) the link over the saved range from the input value.
  // Empty value → REMOVE the link over the range. A non-empty value that
  // fails the href allowlist (safeHref) is rejected with an inline error and
  // the editor stays open — defence-in-depth alongside the save-route + the
  // render-time guard, so a bad scheme never even becomes a mark. On success
  // the spans rebuild and the editor closes (restoring the selection).
  function applyLinkFromInput() {
    if (editingId == null || !savedLinkRange) { closeLinkInput(true); return; }
    const r = state.rects.find(function (x) { return x.id === editingId; });
    if (!r) { closeLinkInput(true); return; }
    const bar = document.getElementById('pe-text-toolbar');
    const inp = bar && bar.querySelector('.pe-tt-link-input');
    const raw = inp ? String(inp.value || '').trim() : '';
    const rng = savedLinkRange;
    const len = editText.length;
    if (raw !== '' && safeHref(raw) == null) {
      const err = bar && bar.querySelector('.pe-tt-link-err');
      if (err) err.textContent = 'Unsafe or unsupported URL — not applied.';
      if (inp) { inp.focus(); inp.select(); }
      return;                                    // keep the editor open
    }
    // setMark with null clears the attr over the range; with a string sets it.
    r.marks = normalizeMarks(
      setMark(r.marks || [], rng.start, rng.end, 'link', raw === '' ? null : raw), len);
    markDirty();
    closeLinkInput(true);
  }

  // Close the inline link editor (apply / cancel / blur). Rebuilds the spans
  // from the current model, returns the toolbar to its closed state, and (when
  // restoreFocus) puts focus + the saved selection back on the editable so the
  // author keeps editing exactly where they were.
  function closeLinkInput(restoreFocus) {
    const rng = savedLinkRange;
    linkEditOpen = false;
    savedLinkRange = null;
    const ed = surface && surface.querySelector('.pe-rect-text.is-editing');
    const r = editingId != null
      ? state.rects.find(function (x) { return x.id === editingId; }) : null;
    if (ed && r) renderRunsInto(ed, editText, r.marks || []);
    buildTextToolbar();
    if (restoreFocus && ed && rng) {
      ed.focus();
      setSelectionRange(ed, rng.start, rng.end);
    }
    updateToolbarPressed();
  }

  // Reflect each attr's coverage over the current selection as a THREE-state
  // pressed display (TS2): 'all' → .is-active, 'some' → .is-mixed
  // (indeterminate), 'none' → off. A collapsed caret has no selection to
  // cover → all buttons off (TS2-b adds pending/effective-state lighting).
  function updateToolbarPressed() {
    const bar = document.getElementById('pe-text-toolbar');
    if (!bar || editingId == null) return;
    const ed = surface && surface.querySelector('.pe-rect-text.is-editing');
    if (!ed) return;
    const sel = getCaretOffset(ed);
    const r = state.rects.find(function (x) { return x.id === editingId; });
    const marks = (r && r.marks) || [];
    const hasSel = !!(sel && sel.end > sel.start);
    const caretEff = (sel && !hasSel) ? effAttrsAt(marks, sel.start) : null;
    const btns = bar.querySelectorAll('.pe-tt-btn');
    for (let k = 0; k < btns.length; k++) {
      const attr = btns[k].dataset.attr;
      let cov;
      if (hasSel) {
        cov = rangeAttrCoverage(marks, sel.start, sel.end, attr);   // none|some|all
      } else if (pendingAttrs != null) {
        cov = pendingAttrs.has(attr) ? 'all' : 'none';              // explicit override
      } else if (caretEff) {
        cov = caretEff.indexOf(attr) !== -1 ? 'all' : 'none';       // natural state at caret
      } else {
        cov = 'none';
      }
      btns[k].classList.toggle('is-active', cov === 'all');
      btns[k].classList.toggle('is-mixed',  cov === 'some');
    }
    // TS3-a colour swatches: light the swatch whose value uniformly covers
    // the selection (or contains the caret); light "clear" when there's a
    // selection with no single colour. dataset.value '' = the clear swatch.
    const sws = bar.querySelectorAll('.pe-tt-swatch');
    if (sws.length) {
      const curColor = currentMarkValue(marks, sel, 'color');
      const curKey = curColor == null ? null : markValKey(curColor);
      for (let k = 0; k < sws.length; k++) {
        const v = sws[k].dataset.value;
        const on = (v === '') ? (hasSel && curKey === null) : (curKey === v);
        sws[k].classList.toggle('is-active', on);
      }
    }
    // v0.10.102: live link read-out. Show the URL (+ verify / edit) whenever
    // the selection is a single uniform link AND the editor isn't already open
    // (the prefilled input shows it then). Reposition the toolbar only on a
    // visibility TRANSITION so its height change doesn't overlap the editable,
    // while selection-drag doesn't cause per-event jitter.
    const info = bar.querySelector('.pe-tt-linkinfo');
    if (info) {
      const curLink = currentMarkValue(marks, sel, 'link');
      const show = (typeof curLink === 'string' && curLink !== '' && !linkEditOpen);
      const wasShown = info.style.display !== 'none';
      if (show) {
        const urlEl = info.querySelector('.pe-tt-linkinfo-url');
        const openEl = info.querySelector('.pe-tt-linkinfo-open');
        if (urlEl) { urlEl.textContent = curLink; urlEl.title = 'Edit this link: ' + curLink; }
        if (openEl) {
          const safe = safeHref(curLink);
          if (safe) { openEl.href = safe; openEl.style.display = ''; openEl.title = 'Open in a new tab: ' + safe; }
          else { openEl.removeAttribute('href'); openEl.style.display = 'none'; }
        }
        info.style.display = '';
      } else {
        info.style.display = 'none';
      }
      if (show !== wasShown) positionTextToolbar(bar, ed);
    }
  }

  // Position the (fixed) toolbar just above the editable — or below if it
  // would clip the top of the viewport.
  function positionTextToolbar(bar, ed) {
    const rc = ed.getBoundingClientRect();
    bar.style.position = 'fixed';
    bar.style.left = Math.max(4, rc.left) + 'px';
    let top = rc.top - bar.offsetHeight - 6;
    if (top < 4) top = rc.bottom + 6;
    bar.style.top = top + 'px';
  }

  // Build (or tear down) the floating text toolbar. Called from render():
  // removes any stale bar, and when editing builds a fresh one over the
  // active editable. B / I atomic toggles (TS1/TS2) + a palette colour-
  // swatch row (TS3-a).
  function buildTextToolbar() {
    const old = document.getElementById('pe-text-toolbar');
    if (old) old.remove();
    if (editingId == null) return;
    const ed = surface && surface.querySelector('.pe-rect-text.is-editing');
    if (!ed) return;
    const bar = document.createElement('div');
    bar.id = 'pe-text-toolbar';
    bar.className = 'pe-text-toolbar';
    const defs = [
      { attr: 'strong',    label: 'B', title: 'Bold (selection)' },
      { attr: 'em',        label: 'I', title: 'Italic (selection)' },
      { attr: 'underline', label: 'U', title: 'Underline (selection)' }
    ];
    defs.forEach(function (def) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'pe-tt-btn pe-tt-' + def.attr;
      b.textContent = def.label;
      b.title = def.title;
      b.dataset.attr = def.attr;
      // CRITICAL: preventDefault on pointerdown keeps focus + selection in
      // the editable, so its blur→commit doesn't fire before the click
      // applies the style (and the selection survives to be styled).
      b.addEventListener('pointerdown', function (ev) { ev.preventDefault(); });
      b.addEventListener('mousedown',   function (ev) { ev.preventDefault(); });
      b.addEventListener('click', function (ev) { ev.preventDefault(); toggleStyle(def.attr); });
      bar.appendChild(b);
    });
    // TS3-a colour swatches. A divider, a "clear colour" chip, then one
    // chip per palette colour (its real colour as the fill, so it previews
    // exactly what the run becomes). Same pointerdown/mousedown focus-guard
    // as the B/I buttons so the editable keeps focus + selection.
    if (state.palette && state.palette.length) {
      const sep = document.createElement('span');
      sep.className = 'pe-tt-sep';
      bar.appendChild(sep);
      const mkSwatch = function (value, title, styleVal) {
        const s = document.createElement('button');
        s.type = 'button';
        s.className = 'pe-tt-swatch' + (value === '' ? ' pe-tt-swatch-clear' : '');
        s.title = title;
        s.dataset.value = value;
        if (styleVal) s.style.background = styleVal;
        s.addEventListener('pointerdown', function (ev) { ev.preventDefault(); });
        s.addEventListener('mousedown',   function (ev) { ev.preventDefault(); });
        s.addEventListener('click', function (ev) {
          ev.preventDefault();
          applyColor(value === '' ? null : value);
        });
        bar.appendChild(s);
      };
      mkSwatch('', 'Clear colour (selection)', '');
      state.palette.forEach(function (p) {
        if (!p || !p.id) return;
        mkSwatch(String(p.id), (p.name || p.id) + ' (selection)', p.value || '');
      });
    }
    // TS3-b-2 LINK control. A divider, then a chain-link button that opens the
    // inline URL editor. dataset.attr='link' makes it light up via the generic
    // pressed-state loop (rangeAttrCoverage) whenever the selection is linked.
    // Icon (not microscopic): ~1.15rem chain-link SVG inside the 2rem button.
    const linkSep = document.createElement('span');
    linkSep.className = 'pe-tt-sep';
    bar.appendChild(linkSep);
    const lb = document.createElement('button');
    lb.type = 'button';
    lb.className = 'pe-tt-btn pe-tt-link';
    lb.dataset.attr = 'link';
    lb.title = 'Link (selection)';
    lb.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"'
      + ' stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">'
      + '<path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 1 0-7.07-7.07L11.5 4.5"/>'
      + '<path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 1 0 7.07 7.07L12.5 19.5"/></svg>';
    lb.addEventListener('pointerdown', function (ev) { ev.preventDefault(); });
    lb.addEventListener('mousedown',   function (ev) { ev.preventDefault(); });
    lb.addEventListener('click', function (ev) { ev.preventDefault(); openLinkInput(); });
    bar.appendChild(lb);

    // v0.10.102: live link READ-OUT. The structure is built once (hidden by
    // default); updateToolbarPressed fills + shows it whenever the selection is
    // a single uniform link, so an entered URL is always visible/checkable/
    // changeable — not hidden behind a guess at the chain button. Three parts:
    //   • the URL text (click → openLinkInput to CHANGE it),
    //   • an "open ↗" anchor (verify the destination in a new tab),
    //   • a pencil (also opens the editor — an explicit edit affordance).
    // Hidden while the editor is open (the prefilled input already shows it).
    const info = document.createElement('div');
    info.className = 'pe-tt-linkinfo';
    info.style.display = 'none';
    const infoUrl = document.createElement('span');
    infoUrl.className = 'pe-tt-linkinfo-url';
    infoUrl.title = 'Edit this link';
    infoUrl.addEventListener('pointerdown', function (ev) { ev.preventDefault(); });
    infoUrl.addEventListener('mousedown',   function (ev) { ev.preventDefault(); });
    infoUrl.addEventListener('click', function (ev) { ev.preventDefault(); openLinkInput(); });
    info.appendChild(infoUrl);
    // The open-in-new-tab anchor genuinely navigates (no preventDefault on
    // click). It lives INSIDE #pe-text-toolbar, so the editable's blur guard
    // skips commitEdit when focus moves to it — the edit session survives the
    // verify click. href is set (safeHref'd) in updateToolbarPressed.
    const infoOpen = document.createElement('a');
    infoOpen.className = 'pe-tt-linkinfo-open';
    infoOpen.target = '_blank';
    infoOpen.rel = 'noopener noreferrer';
    infoOpen.title = 'Open in a new tab to verify';
    infoOpen.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"'
      + ' stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">'
      + '<path d="M14 4h6v6"/><path d="M20 4l-9 9"/>'
      + '<path d="M18 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h6"/></svg>';
    info.appendChild(infoOpen);
    const infoEdit = document.createElement('button');
    infoEdit.type = 'button';
    infoEdit.className = 'pe-tt-linkinfo-edit';
    infoEdit.title = 'Edit this link';
    infoEdit.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"'
      + ' stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">'
      + '<path d="M4 20h4l10-10a2.83 2.83 0 0 0-4-4L4 16v4z"/>'
      + '<path d="M13.5 6.5l4 4"/></svg>';
    infoEdit.addEventListener('pointerdown', function (ev) { ev.preventDefault(); });
    infoEdit.addEventListener('mousedown',   function (ev) { ev.preventDefault(); });
    infoEdit.addEventListener('click', function (ev) { ev.preventDefault(); openLinkInput(); });
    info.appendChild(infoEdit);
    bar.appendChild(info);

    // When the editor is open, append a full-width input row (wraps under the
    // buttons — the toolbar is flex-wrap). The <input> is the ONE control that
    // intentionally takes focus; its Apply/Cancel buttons preventDefault so
    // focus stays in the input while they act on it.
    if (linkEditOpen) {
      const rowEl = document.createElement('div');
      rowEl.className = 'pe-tt-link-row';
      const inp = document.createElement('input');
      inp.type = 'text';
      inp.className = 'pe-tt-link-input';
      inp.placeholder = 'https://…   (leave empty to remove)';
      inp.spellcheck = false;
      inp.autocomplete = 'off';
      // Enter applies, Escape cancels. stopPropagation so the global canvas
      // keydown (Delete/Escape-deselect) never sees these while typing a URL.
      inp.addEventListener('keydown', function (ev) {
        ev.stopPropagation();
        if (ev.key === 'Enter')       { ev.preventDefault(); applyLinkFromInput(); }
        else if (ev.key === 'Escape') { ev.preventDefault(); closeLinkInput(true); }
      });
      rowEl.appendChild(inp);
      const ok = document.createElement('button');
      ok.type = 'button';
      ok.className = 'pe-tt-btn pe-tt-link-ok';
      ok.title = 'Apply link';
      ok.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"'
        + ' stroke-width="3" stroke-linecap="round" stroke-linejoin="round">'
        + '<path d="M5 13l4 4L19 7"/></svg>';
      ok.addEventListener('pointerdown', function (ev) { ev.preventDefault(); });
      ok.addEventListener('mousedown',   function (ev) { ev.preventDefault(); });
      ok.addEventListener('click', function (ev) { ev.preventDefault(); applyLinkFromInput(); });
      rowEl.appendChild(ok);
      const cx = document.createElement('button');
      cx.type = 'button';
      cx.className = 'pe-tt-btn pe-tt-link-cancel';
      cx.title = 'Cancel';
      cx.textContent = '×';
      cx.addEventListener('pointerdown', function (ev) { ev.preventDefault(); });
      cx.addEventListener('mousedown',   function (ev) { ev.preventDefault(); });
      cx.addEventListener('click', function (ev) { ev.preventDefault(); closeLinkInput(true); });
      rowEl.appendChild(cx);
      const err = document.createElement('span');
      err.className = 'pe-tt-link-err';
      rowEl.appendChild(err);
      bar.appendChild(rowEl);
    }
    document.body.appendChild(bar);
    positionTextToolbar(bar, ed);
    updateToolbarPressed();
    if (!selChangeBound) {
      selChangeBound = true;
      document.addEventListener('selectionchange', function () {
        if (editingId == null) return;
        // TS2-b: a NON-EMPTY selection supersedes a pending collapsed-caret
        // format — drop it. This is race-free: typing only ever yields a
        // collapsed caret, so it never trips this branch (the inserted-text
        // styling is handled in handleEditInput, not here).
        if (pendingAttrs != null) {
          const ed = surface && surface.querySelector('.pe-rect-text.is-editing');
          const sel = ed && getCaretOffset(ed);
          if (sel && sel.end > sel.start) pendingAttrs = null;
        }
        updateToolbarPressed();
      });
    }
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
    // Slice T2: inline-edit interception. If a rect is being edited and
    // the pointer landed INSIDE its editable text node, do nothing here —
    // no selection, no drag, no preventDefault — so the browser handles
    // caret placement / text selection natively. Any pointerdown OUTSIDE
    // the editable commits the edit first (synchronously, no render — the
    // logic below renders), then proceeds to select/drag the new target.
    if (editingId != null) {
      if (ev.target.closest && ev.target.closest('.pe-rect-text.is-editing')) {
        // Click inside the editable → native caret placement. The pending
        // collapsed-caret format was tied to the OLD caret, so discard it
        // (TS2-b); the new caret seeds a fresh pending only if the author
        // toggles again. updateToolbarPressed runs via selectionchange.
        clearPending();
        return;
      }
      commitEdit(false);
    }

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

    // Slice T2 (v0.10.85): manual double-click/double-tap → enter inline edit.
    // The second tap on the same text rect within DOUBLE_TAP_MS opens the
    // editor and skips drag setup. The first tap falls through to normal
    // select+drag. See lastTap* note at the state declarations for why we
    // can't use the native 'dblclick' event here.
    if (r.kind === 'text') {
      const now = Date.now();
      if (lastTapId === id && (now - lastTapTime) < DOUBLE_TAP_MS) {
        lastTapTime = 0;
        lastTapId = null;
        enterEditMode(id);
        ev.preventDefault();
        return;
      }
      lastTapTime = now;
      lastTapId = id;
    } else {
      lastTapTime = 0;
      lastTapId = null;
    }

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

  // NB: double-click to enter edit mode is handled inside the pointerdown
  // handler above via manual lastTap* tracking — NOT a native 'dblclick'
  // listener, which never fires here because pointerdown calls preventDefault
  // (that suppresses the browser's synthesized click/dblclick events). This
  // also gives the future tablet layer a real double-tap gesture.

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
    // Slice 3a: text rect carrying a (resolvable) typography token gets
    // the matching .ty-<id> class so its text renders in that face. The
    // class is forward-compat plumbing for real text content (next
    // slice); today it also styles any text the rect shows.
    if (rect.kind === 'text' && rect.typographyId && typoById[rect.typographyId]) {
      el.classList.add('ty-' + rect.typographyId);
      el.classList.add('has-typo');
    }
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

    // Slice T1/T2: real text content for a text rect, rendered behind the
    // editor chrome (kind/z badge + note + id) so the author sees the
    // actual copy on the canvas, in the rect's typography face (the
    // .ty-<id> class on `el` cascades to this child). Whitespace +
    // newlines are preserved via CSS white-space:pre-wrap. textContent
    // (never innerHTML) — no markup is interpreted at this slice.
    //
    // The node renders when the rect has text OR is being inline-edited
    // (T2) — an empty rect under edit still needs a caret target. In
    // edit mode it's contenteditable="plaintext-only" with blur/Escape/
    // Cmd-Enter handlers; otherwise it's a static, click-through display
    // node and the empty rect falls back to its kind stub.
    const isEditingThis = (rect.kind === 'text' && rect.id === editingId);
    if (rect.kind === 'text' && (rect.text || isEditingThis)) {
      const txt = document.createElement('div');
      txt.className = 'pe-rect-text';
      // Slice TS1: always paint the DERIVED runs (segments → <span class=
      // "mk-…"> per styled run). Each span's direct class beats the inherited
      // .ty-<id> typography token from `el` (the CSS descendant/inheritance
      // order working in our favour). Painting the same runs in edit mode is
      // what makes typing live-WYSIWYG — text typed inside a bold run lands
      // in the bold span and shows bold immediately.
      renderRunsInto(txt, rect.text || '', rect.marks);
      if (isEditingThis) {
        txt.classList.add('is-editing');
        // contenteditable="true" (NOT plaintext-only) so the styled child
        // spans survive editing — that's the live-WYSIWYG requirement. The
        // cost: Enter and paste must be intercepted (true would insert
        // <div>/<br> and rich HTML, neither of which round-trips through our
        // textContent model). Spellcheck off — design copy, not prose review.
        txt.contentEditable = 'true';
        txt.spellcheck = false;
        txt.addEventListener('keydown', function (ev) {
          // TS2-b: caret-moving keys discard any pending collapsed-caret
          // format (it was tied to the old caret position). Don't
          // preventDefault — the browser still moves the caret normally.
          if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight'
           || ev.key === 'ArrowUp'   || ev.key === 'ArrowDown'
           || ev.key === 'Home'      || ev.key === 'End'
           || ev.key === 'PageUp'    || ev.key === 'PageDown') {
            clearPending();
          }
          if (ev.key === 'Escape') {
            ev.preventDefault();
            ev.stopPropagation();
            cancelEdit();
          } else if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) {
            // Cmd/Ctrl+Enter commits — mirrors the T1 textarea contract.
            ev.preventDefault();
            commitEdit(true);
          } else if (ev.key === 'Enter') {
            // Plain Enter → insert a real '\n' (not a <br>/<div>).
            ev.preventDefault();
            insertPlainTextAtCaret(txt, '\n');
          } else if ((ev.metaKey || ev.ctrlKey) && !ev.altKey
                     && (ev.key === 'b' || ev.key === 'B'
                      || ev.key === 'i' || ev.key === 'I'
                      || ev.key === 'u' || ev.key === 'U')) {
            // ⌘/Ctrl+B / +I → route to OUR mark engine. CRITICAL: must
            // preventDefault — contenteditable="true" otherwise runs the
            // browser's native execCommand('bold'/'italic'/'underline'),
            // which injects foreign <b>/<i>/<u> nodes OUTSIDE the marks
            // model (button never
            // updates; the styling is silently dropped on commit when the
            // node collapses through textContent; caret offsets can desync
            // mid-edit). Toggling through toggleStyle keeps the model the
            // single source of truth and updates the pressed-state. (⌘B/⌘I
            // were named for TS2; pulled forward here because leaving the
            // native command active is a correctness hazard, not polish.)
            ev.preventDefault();
            const k = ev.key.toLowerCase();
            toggleStyle(k === 'b' ? 'strong' : (k === 'i' ? 'em' : 'underline'));
          }
        });
        // Typing / IME / delete: patch-in-place, remap marks, no re-render
        // (except when a pending format must repaint the inserted run — see
        // handleEditInput). Pass the event so it can detect IME composition.
        txt.addEventListener('input', function (ev) { handleEditInput(txt, ev); });
        // Paste arrives as plain text only.
        txt.addEventListener('paste', function (ev) {
          ev.preventDefault();
          const cd = ev.clipboardData || window.clipboardData;
          const t = cd ? cd.getData('text/plain') : '';
          if (t) insertPlainTextAtCaret(txt, t);
        });
        // Clicking away (another rect, the panel, empty canvas) commits.
        // TS3-b-2 EXCEPTION: focus moving INTO the toolbar (the link URL
        // <input>, or its Apply/Cancel buttons) must NOT commit — that would
        // tear down the edit and the input before the author can type a URL.
        // relatedTarget is the element receiving focus; if it's inside the
        // toolbar, skip the commit. All other blurs commit as before.
        txt.addEventListener('blur', function (ev) {
          const rt = ev && ev.relatedTarget;
          if (rt && rt.closest && rt.closest('#pe-text-toolbar')) return;
          commitEdit(true);
        });
      }
      el.appendChild(txt);
      el.classList.add('has-text');
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
    // Slice T2: while inline-editing, suppress the selection chrome entirely.
    // Its move grip + resize handles (pointer-events:auto, at the z ceiling)
    // would otherwise sit over the editable and steal caret clicks near the
    // corners/edges. The dashed is-editing ring is the affordance during
    // editing; the box returns on commit/cancel (next render).
    if (editingId != null) return ov;
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
    // Slice T2: if an inline edit is active, re-seat focus + caret on the
    // freshly-rebuilt editable (render() replaces the whole surface). No-op
    // when it's already focused, so a stray render mid-edit doesn't jump
    // the caret — only a render that destroyed+recreated the node re-focuses.
    focusEditable();
    // Slice TS1: float the B/I toolbar over the active editable (or remove
    // it when not editing). After focusEditable so the editable + caret exist.
    buildTextToolbar();
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

    function row(labelText, child, modifier) {
      const div = document.createElement('div');
      div.className = 'pe-selection-row' + (modifier ? ' ' + modifier : '');
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

    // Typography (Slice 3a) — only for text-kind rects. A dropdown of
    // site-wide tokens (none = inherit defaults) + a live preview line
    // rendered in the chosen token's actual face, so the author sees the
    // type before there's real text content in the rect. A dangling ref
    // (token deleted in draw) shows a flagged "missing" preview.
    if (r.kind === 'text') {
      const typoWrap = document.createElement('div');
      typoWrap.className = 'pe-typo';

      const sel = document.createElement('select');
      sel.className = 'pe-input';
      const none = document.createElement('option');
      none.value = '';
      none.textContent = '— none —';
      if (r.typographyId == null) none.selected = true;
      sel.appendChild(none);
      let refDangles = (r.typographyId != null && !typoById[r.typographyId]);
      state.typography.forEach(function (t) {
        const opt = document.createElement('option');
        opt.value = t.id;
        opt.textContent = t.name || t.id;
        if (r.typographyId === t.id) opt.selected = true;
        sel.appendChild(opt);
      });
      // Keep a dangling ref visible/selectable rather than silently
      // dropping it, so the author can see + fix the broken binding.
      if (refDangles) {
        const ghost = document.createElement('option');
        ghost.value = r.typographyId;
        ghost.textContent = r.typographyId + ' (missing)';
        ghost.selected = true;
        sel.appendChild(ghost);
      }
      sel.addEventListener('change', function () { setRectTypography(r.id, sel.value); });
      typoWrap.appendChild(sel);

      // Live preview line — class drives the actual font via the
      // template-emitted .ty-<id> rule. Capped height + clipped so a big
      // token can't blow out the panel.
      const tok = (r.typographyId && typoById[r.typographyId]) ? typoById[r.typographyId] : null;
      const prev = document.createElement('div');
      prev.className = 'pe-typo-preview';
      if (tok) {
        const sample = document.createElement('div');
        sample.className = 'pe-typo-sample ty-' + tok.id;
        sample.textContent = 'Ag — the quick brown fox';
        prev.appendChild(sample);
        const meta = document.createElement('div');
        meta.className = 'pe-typo-meta';
        const ls = (tok.letterSpacingPx || 0);
        meta.textContent = (tok.family || '?') + ' · ' + (tok.sizePx || '?') + 'px · '
          + (tok.weight || 400) + (tok.italic ? ' italic' : '')
          + ' · lh ' + (tok.lineHeight != null ? tok.lineHeight : '?')
          + (ls ? ' · ls ' + ls : '');
        prev.appendChild(meta);
      } else if (refDangles) {
        prev.className += ' is-missing';
        prev.textContent = 'Token “' + r.typographyId + '” no longer exists.';
      } else {
        prev.className += ' is-empty';
        prev.textContent = 'No token — inherits default text style.';
      }
      typoWrap.appendChild(prev);

      // v0.10.98: stack this ONE row (label on top, content full-width) so the
      // big type preview reclaims the empty label gutter — a 48px sample needs
      // the whole panel width. Every other row keeps the label-left layout.
      body.appendChild(row('Type', typoWrap, 'pe-selection-row--stack'));

      // Slice T1 / v0.10.100: plain-text body content, behind a disclosure.
      // The text is already shown on the canvas, so the panel keeps it closed
      // by default (an "Edit text here" button) to save vertical space; opened
      // on demand it becomes a full-width textarea (the empty label gutter is
      // reclaimed, like the Type preview). The textarea stays in a plain,
      // comfortable editing face (NOT the rect's typography token — a 48px
      // heading token would make this narrow field unusable; the live canvas
      // already shows the styled result). Commits on blur and on
      // Cmd/Ctrl+Enter (plain Enter inserts a newline — the textarea IS the
      // place where Enter means newline, not submit). Escape reverts.
      if (!panelTextOpen.has(r.id)) {
        // Closed: a single full-width disclosure button.
        const openBtn = document.createElement('button');
        openBtn.type = 'button';
        openBtn.className = 'pe-text-disclose';
        openBtn.innerHTML =
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"'
          + ' stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">'
          + '<path d="M4 20h4l10-10a2.83 2.83 0 0 0-4-4L4 16v4z"/>'
          + '<path d="M13.5 6.5l4 4"/></svg>'
          + '<span>Edit text here</span>';
        openBtn.addEventListener('click', function () {
          panelTextOpen.add(r.id);
          render();
          // Focus the freshly-built textarea (the panel was rebuilt by render).
          const ta = document.querySelector('#selection-body .pe-rect-textarea');
          if (ta) {
            ta.focus();
            const v = ta.value; ta.value = ''; ta.value = v;  // caret to end
          }
        });
        // v0.10.101: inline on the TEXT label's own row (compact button in the
        // content column), NOT stacked full-width — the closed affordance is
        // tiny, so it doesn't need the whole panel.
        body.appendChild(row('Text', openBtn));
      } else {
        // Open: a header row (label + collapse [×]) then the full-width
        // textarea. The collapse only HIDES the editor — the textarea has
        // already committed via its blur (focus moving to the × fires it), so
        // no text is lost; r.text is never cleared here.
        const head = document.createElement('div');
        head.className = 'pe-text-edit-head';
        const lab = document.createElement('span');
        lab.textContent = 'Text';
        const collapse = document.createElement('button');
        collapse.type = 'button';
        collapse.className = 'pe-text-collapse';
        collapse.title = 'Done editing text';
        // v0.10.101: labelled "Done" (was "×") — a bare × reads as delete/cancel;
        // this only hides the editor and the text is already committed on blur.
        collapse.textContent = 'Done';
        collapse.addEventListener('click', function () {
          panelTextOpen.delete(r.id);
          render();
        });
        head.appendChild(lab);
        head.appendChild(collapse);

        const textArea = document.createElement('textarea');
        textArea.className = 'pe-input pe-rect-textarea';
        textArea.rows = 4;
        textArea.maxLength = 5000;
        textArea.placeholder = 'text content (optional)';
        textArea.value = r.text || '';
        textArea.addEventListener('keydown', function (ev) {
          if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) {
            ev.preventDefault(); textArea.blur();
          } else if (ev.key === 'Escape') {
            ev.preventDefault(); textArea.value = r.text || ''; textArea.blur();
          }
        });
        textArea.addEventListener('blur', function () {
          setRectText(r.id, textArea.value);
        });

        const stack = document.createElement('div');
        stack.className = 'pe-text-edit-stack';
        stack.appendChild(head);
        stack.appendChild(textArea);

        // Slice T2: discoverability hint for inline on-canvas editing.
        const hint = document.createElement('div');
        hint.className = 'pe-field-hint';
        hint.textContent = 'Tip: double-click the rect to edit on the canvas (Esc cancels, ⌘↵ commits).';
        stack.appendChild(hint);

        body.appendChild(row('', stack, 'pe-selection-row--stack pe-selection-row--nolabel'));
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
