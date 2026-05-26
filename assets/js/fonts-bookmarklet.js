/*
 * Font-bundle bookmarklet source (Slice 2a-2, v0.8.200).
 *
 * Loaded by the /dev/draw/fonts-bundle generator page. The page wraps
 * this file in an IIFE with `var ENDPOINT = '<your-site>/dev/draw/font-bundle';`
 * prepended, URL-encodes the whole thing, and outputs it as a draggable
 * `<a href="javascript:...">` link.
 *
 * Behaviour, in fonts.google.com's page context:
 *   1. Idempotent — re-clicking the bookmark re-shows an existing panel
 *      rather than stacking copies.
 *   2. Scans every <a href="/specimen/FAMILY+NAME"> link in the DOM to
 *      auto-populate the candidate list. Re-scan button refreshes after
 *      the user scrolls or applies Google's filters.
 *   3. Manual additions via textarea for fonts not on screen (one per
 *      line).
 *   4. Save → POST { fonts: [...] } to ENDPOINT (CORS allowed by Slice
 *      2a-1's server-side header).
 *
 * Plain ES5, no build step. Inline styles to avoid CSP conflicts with
 * fonts.google.com's own stylesheets.
 */
(function () {
  if (window.__nsdbFontPicker) {
    window.__nsdbFontPicker.show();
    return;
  }

  // ENDPOINT is injected by the generator page above this IIFE body.
  if (typeof ENDPOINT !== 'string' || !ENDPOINT) {
    alert('Font Picker bookmarklet has no endpoint configured.\n' +
          'Reinstall it from your site\'s /dev/draw/fonts-bundle page.');
    return;
  }

  // Persist work-in-progress across page navigations on fonts.google.com.
  // Google's SPA tears down our injected DOM during route changes; once
  // the user re-clicks the bookmark, panel state is reloaded from here.
  // Key includes ENDPOINT so the picker remembers per-site state if the
  // same bookmarklet is somehow reused for two different sites.
  var STORAGE_KEY = '__nsdbFontPicker_state__' + ENDPOINT;
  function loadState() {
    try {
      var raw = sessionStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      var s = JSON.parse(raw);
      if (s && typeof s === 'object') return s;
    } catch (e) {}
    return null;
  }
  function saveState(state, manualText) {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify({
        selected: state.selected,
        manual:   manualText || ''
      }));
    } catch (e) {}
  }
  function clearState() {
    try { sessionStorage.removeItem(STORAGE_KEY); } catch (e) {}
  }

  function scrapeFonts() {
    var anchors = document.querySelectorAll('a[href^="/specimen/"]');
    var seen = {};
    var fonts = [];
    for (var i = 0; i < anchors.length; i++) {
      var href = anchors[i].getAttribute('href') || '';
      var path = href.replace(/^\/specimen\//, '');
      path = path.split(/[\/?#]/)[0];
      if (!path) continue;
      var name;
      try { name = decodeURIComponent(path).replace(/\+/g, ' '); }
      catch (e) { name = path.replace(/\+/g, ' '); }
      name = name.trim();
      if (!name || seen[name]) continue;
      seen[name] = true;
      fonts.push(name);
    }
    fonts.sort(function (a, b) { return a.localeCompare(b); });
    return fonts;
  }

  function renderList(fonts, listEl, state, manualEl) {
    listEl.innerHTML = '';
    if (!fonts.length) {
      var empty = document.createElement('div');
      empty.style.cssText = 'color:#999;padding:8px 4px;font-style:italic;';
      empty.textContent = 'No fonts detected on this page. Try scrolling, apply a Google Fonts filter, then re-scan. Or use the manual textarea below.';
      listEl.appendChild(empty);
      return;
    }
    for (var i = 0; i < fonts.length; i++) {
      (function (name) {
        var row = document.createElement('label');
        row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:4px 2px;cursor:pointer;border-bottom:1px solid #f0f0f0;';
        var cb = document.createElement('input');
        cb.type = 'checkbox';
        // Default checked unless sessionStorage explicitly says false.
        var stored = state.selected[name];
        cb.checked = stored !== false;
        state.selected[name] = cb.checked;
        cb.addEventListener('change', function () {
          state.selected[name] = cb.checked;
          saveState(state, manualEl ? manualEl.value : '');
        });
        var span = document.createElement('span');
        span.textContent = name;
        span.style.cssText = 'flex:1;';
        row.appendChild(cb);
        row.appendChild(span);
        listEl.appendChild(row);
      })(fonts[i]);
    }
  }

  function collectFromTextarea(ta) {
    return (ta.value || '').split(/\r?\n/)
      .map(function (s) { return s.trim(); })
      .filter(function (s) { return s.length > 0; });
  }

  function doSave(state, manualEl, statusEl, mode) {
    var fonts = [];
    var names = Object.keys(state.selected);
    for (var i = 0; i < names.length; i++) {
      if (state.selected[names[i]]) fonts.push(names[i]);
    }
    var manual = collectFromTextarea(manualEl);
    for (var j = 0; j < manual.length; j++) {
      if (fonts.indexOf(manual[j]) === -1) fonts.push(manual[j]);
    }
    // After a successful save, the work-in-progress is done — clear
    // sessionStorage so the next bookmarklet click starts fresh
    // (no stale ghosts of last week's selection).
    var onSuccess = function () { clearState(); };
    if (mode === 'merge') {
      // Fetch existing first, then union before posting.
      statusEl.textContent = 'Fetching existing bundle…';
      fetch(ENDPOINT, { method: 'GET' })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          var existing = (j && j.fonts) || [];
          for (var k = 0; k < existing.length; k++) {
            if (fonts.indexOf(existing[k]) === -1) fonts.push(existing[k]);
          }
          postFonts(fonts, statusEl, onSuccess);
        })
        .catch(function (err) {
          statusEl.textContent = 'Could not fetch existing: ' + err.message;
        });
      return;
    }
    postFonts(fonts, statusEl, onSuccess);
  }

  function postFonts(fonts, statusEl, onSuccess) {
    if (!fonts.length) {
      statusEl.textContent = 'Nothing to save.';
      return;
    }
    statusEl.textContent = 'Saving ' + fonts.length + '…';
    fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fonts: fonts })
    }).then(function (r) {
      return r.json().then(function (j) { return { ok: r.ok, j: j || {} }; });
    }).then(function (res) {
      if (res.ok && res.j.ok) {
        statusEl.textContent = 'Saved — bundle now has ' + (res.j.count || fonts.length) + ' fonts.';
        if (typeof onSuccess === 'function') onSuccess();
      } else {
        statusEl.textContent = 'Save failed: ' + (res.j.error || 'HTTP ' + (res.j.status || '?'));
      }
    }).catch(function (err) {
      statusEl.textContent = 'Save failed: ' + err.message;
    });
  }

  function buildPanel() {
    var panel = document.createElement('div');
    panel.id = 'nsdb-font-picker';
    panel.style.cssText = [
      'position:fixed', 'top:16px', 'right:16px', 'width:380px',
      'max-height:85vh', 'display:flex', 'flex-direction:column',
      'background:#fff', 'color:#222',
      'border:2px solid #ff5500', 'border-radius:8px',
      'box-shadow:0 10px 30px rgba(0,0,0,0.35)',
      'font:13px/1.4 system-ui,-apple-system,sans-serif',
      'z-index:2147483647', 'overflow:hidden'
    ].join(';') + ';';

    var header = document.createElement('div');
    header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:8px 12px;background:#ff5500;color:#fff;font-weight:600;';
    var title = document.createElement('span');
    title.textContent = 'Font bundle picker';
    header.appendChild(title);
    var closeBtn = document.createElement('button');
    closeBtn.textContent = '×';
    closeBtn.title = 'Close';
    closeBtn.style.cssText = 'background:transparent;border:none;color:#fff;font-size:22px;line-height:1;cursor:pointer;padding:0 4px;';
    closeBtn.onclick = function () { panel.style.display = 'none'; };
    header.appendChild(closeBtn);
    panel.appendChild(header);

    var controls = document.createElement('div');
    controls.style.cssText = 'display:flex;gap:6px;align-items:center;padding:8px 12px;border-bottom:1px solid #eee;';
    var scanBtn = document.createElement('button');
    scanBtn.textContent = 'Re-scan page';
    scanBtn.style.cssText = 'padding:4px 10px;cursor:pointer;border:1px solid #ccc;background:#f6f6f6;border-radius:3px;';
    var status = document.createElement('span');
    status.style.cssText = 'flex:1;color:#666;font-size:11px;text-align:right;';
    status.textContent = '';
    controls.appendChild(scanBtn);
    controls.appendChild(status);
    panel.appendChild(controls);

    var list = document.createElement('div');
    list.style.cssText = 'flex:1;overflow-y:auto;padding:6px 12px;min-height:120px;';
    panel.appendChild(list);

    var manualWrap = document.createElement('div');
    manualWrap.style.cssText = 'padding:8px 12px;border-top:1px solid #eee;';
    var manualLabel = document.createElement('div');
    manualLabel.style.cssText = 'font-size:11px;color:#666;margin-bottom:4px;';
    manualLabel.textContent = 'Manual additions (one family per line)';
    manualWrap.appendChild(manualLabel);
    var manual = document.createElement('textarea');
    manual.style.cssText = 'width:100%;height:54px;font:inherit;font-size:12px;box-sizing:border-box;border:1px solid #ccc;border-radius:3px;padding:4px;';
    manualWrap.appendChild(manual);
    panel.appendChild(manualWrap);

    var saveWrap = document.createElement('div');
    saveWrap.style.cssText = 'display:flex;gap:6px;padding:8px 12px;border-top:1px solid #eee;';
    var mergeBtn = document.createElement('button');
    mergeBtn.textContent = 'Add to bundle';
    mergeBtn.title = 'Merge with the bundle currently saved on the server';
    mergeBtn.style.cssText = 'flex:1;padding:8px;background:#f6f6f6;color:#222;border:1px solid #ccc;border-radius:4px;cursor:pointer;';
    var replaceBtn = document.createElement('button');
    replaceBtn.textContent = 'Replace bundle';
    replaceBtn.title = 'Overwrite the server bundle with exactly what is selected here';
    replaceBtn.style.cssText = 'flex:1;padding:8px;background:#ff5500;color:#fff;border:none;border-radius:4px;cursor:pointer;font-weight:600;';
    saveWrap.appendChild(mergeBtn);
    saveWrap.appendChild(replaceBtn);
    panel.appendChild(saveWrap);

    // Restore prior session state (selections + manual textarea).
    var prior = loadState();
    var state = { selected: (prior && prior.selected) || {} };
    if (prior && typeof prior.manual === 'string') manual.value = prior.manual;
    manual.addEventListener('input', function () {
      saveState(state, manual.value);
    });

    function rescan() {
      var fonts = scrapeFonts();
      // Don't blow away prior selections — renderList honours
      // state.selected and only overwrites entries it draws.
      renderList(fonts, list, state, manual);
      saveState(state, manual.value);
      status.textContent = fonts.length + ' detected';
    }
    scanBtn.onclick = rescan;
    mergeBtn.onclick = function () { doSave(state, manual, status, 'merge'); };
    replaceBtn.onclick = function () { doSave(state, manual, status, 'replace'); };

    document.body.appendChild(panel);
    rescan();
    return panel;
  }

  var panel = buildPanel();

  // Self-healing watchdog. Google's SPA tears down injected DOM during
  // route changes; without this, the panel silently vanishes when the
  // user clicks a font specimen and navigates back. Cheap to run.
  var keepalive = setInterval(function () {
    if (!document.body.contains(panel)) {
      // The panel was wiped. Rebuild with restored state.
      panel = buildPanel();
      window.__nsdbFontPicker.show = function () { panel.style.display = 'flex'; };
      window.__nsdbFontPicker.hide = function () { panel.style.display = 'none'; };
    }
  }, 1000);

  window.__nsdbFontPicker = {
    show: function () { panel.style.display = 'flex'; },
    hide: function () { panel.style.display = 'none'; },
    stop: function () { clearInterval(keepalive); panel.remove(); clearState(); }
  };
})();
