/**
 * Image viewer: a full-screen lightbox with zoom/pan, a filmstrip, and -- when
 * the visitor can label -- a type-ahead label box (Labels.picker, labels.js)
 * that labels the image and moves on to the next one.
 *
 *   ImageViewer.open({
 *     items,           array of {image_id, filename, relative_path, width, height,
 *                      file_size_bytes, format, label, labeled_date, labeled_by}.
 *                      The viewer works on this exact array (a snapshot the caller
 *                      made) and reads item.label live, so labels applied here show up.
 *     index,           which item to show first
 *     folderName,      shown as a subtitle
 *     canLabel,        true for labelers/admins
 *     userId,          current account id (to say "you" in "labeled by you")
 *     onLabel(items, value)   apply a label (null clears); the caller updates the
 *                             items synchronously and saves in the background
 *     lockedText(item) optional; text for an image this person can't label
 *                      (demo blind review: someone else's label in review)
 *     onUndo(),        optional; returns true if something was undone
 *     onClose(index),  optional
 *     originEl,        element to animate from and to return focus to
 *   })
 *
 * Keys: arrows/J/K move, / or L label, 0/Delete clear, Z undo, N next unlabeled,
 * F fit, A actual size, + / - zoom, S sharp pixels, ? help, Esc close.
 */
(function () {
  var h = function () { return UI.h.apply(null, arguments); };
  var current = null;

  // Has a label, even one hidden while it's in review (demo blind review).
  function labeled(it) { return !!(it.label || it.label_hidden); }

  function open(opts) {
    if (!opts.items || !opts.items.length) return null;
    if (current) current.close(true);

    var items = opts.items;
    var canLabel = !!opts.canLabel;
    var index = Math.max(0, Math.min(items.length - 1, opts.index || 0));
    var originEl = opts.originEl || document.activeElement;

    var prefs = {
      advance: UI.store.get('viewer-advance', true),
      skipLabeled: UI.store.get('viewer-skip', true),
      sharp: UI.store.get('viewer-sharp', false),
    };
    var view = { zoom: 1, x: 0, y: 0, fit: 1, natW: 0, natH: 0 };
    var pointers = new Map();
    var pinchStart = null;
    var dragStart = null;

    // --- DOM -------------------------------------------------------------

    var img = h('img', { class: 'viewer-img', alt: '', draggable: 'false', decoding: 'async' });
    var spinner = h('div', { class: 'viewer-spinner', 'aria-hidden': 'true' }, h('div', { class: 'spinner' }));
    var broken = h('div', { class: 'viewer-broken', hidden: true },
      UI.icon('image'), h('p', { text: 'This image can’t be previewed in the browser.' }),
      h('a', { class: 'btn btn-sm', target: '_blank', rel: 'noopener' }, UI.icon('download'), 'Download it'));

    var counter = h('span', { class: 'viewer-counter' });
    var folderEl = h('span', { class: 'viewer-folder', text: opts.folderName || '' });
    var closeBtn = h('button', { type: 'button', class: 'icon-btn viewer-close', 'aria-label': 'Close viewer (Esc)' }, UI.icon('x'));
    var prevBtn = h('button', { type: 'button', class: 'icon-btn viewer-nav prev', 'aria-label': 'Previous image' }, UI.icon('chevron-left'));
    var nextBtn = h('button', { type: 'button', class: 'icon-btn viewer-nav next', 'aria-label': 'Next image' }, UI.icon('chevron-right'));

    var zoomLabel = h('span', { class: 'viewer-zoom-label', 'aria-live': 'off', text: '100%' });
    var sharpBtn = h('button', { type: 'button', class: 'icon-btn sm', 'aria-pressed': String(prefs.sharp), title: 'Sharp pixels (S)', 'aria-label': 'Sharp pixels' }, UI.icon('grid'));
    var tools = h('div', { class: 'viewer-tools', role: 'toolbar', 'aria-label': 'Zoom' },
      h('button', { type: 'button', class: 'icon-btn sm', 'aria-label': 'Zoom out', title: 'Zoom out (-)', onclick: function () { zoomBy(1 / 1.5); } }, UI.icon('zoom-out')),
      zoomLabel,
      h('button', { type: 'button', class: 'icon-btn sm', 'aria-label': 'Zoom in', title: 'Zoom in (+)', onclick: function () { zoomBy(1.5); } }, UI.icon('zoom-in')),
      h('button', { type: 'button', class: 'icon-btn sm', 'aria-label': 'Fit to window', title: 'Fit to window (F)', onclick: fitView }, UI.icon('maximize')),
      h('button', { type: 'button', class: 'btn btn-sm btn-light', title: 'Actual pixels (A)', onclick: actualSize }, '1:1'),
      sharpBtn);

    var stage = h('div', { class: 'viewer-stage', tabindex: '0', role: 'group', 'aria-label': 'Image preview' },
      img, spinner, broken,
      h('div', { class: 'viewer-top' }, counter, folderEl, closeBtn),
      prevBtn, nextBtn, tools);

    var strip = h('div', { class: 'viewer-strip', role: 'group', 'aria-label': 'Nearby images' });

    // side panel
    var titleEl = h('h2', { class: 'viewer-name' });
    var metaEl = h('p', { class: 'viewer-meta' });
    var statusEl = h('div', { class: 'viewer-status' });
    // Focus stays in the box after a label, so the next image can be labeled
    // straight away by typing; Esc goes back to the image (arrow keys, zoom).
    var picker = canLabel ? Labels.picker({
      className: 'viewer-picker',
      label: 'Label this image',
      current: function () { return cur().label || null; },
      onPick: function (option) { applyLabel(option.value); },
      onEscape: function () { stage.focus(); },
    }) : null;
    var labelBox = picker ? picker.el : null;
    var clearBtn = h('button', { type: 'button', class: 'btn btn-sm btn-danger', onclick: function () { applyLabel(null); } }, UI.icon('x'), 'Clear label ', h('kbd', { text: '0' }));
    var undoBtn = h('button', { type: 'button', class: 'btn btn-sm', onclick: undo }, UI.icon('undo'), 'Undo ', h('kbd', { text: 'Z' }));
    var nextUnlabeledBtn = h('button', { type: 'button', class: 'btn btn-sm', onclick: function () { goNextUnlabeled(true); } }, UI.icon('skip-forward'), 'Next unlabeled ', h('kbd', { text: 'N' }));
    var advanceSwitch = switchEl('Move on after labeling', prefs.advance, function (on) { prefs.advance = on; UI.store.set('viewer-advance', on); });
    var skipSwitch = switchEl('Skip images that already have a label', prefs.skipLabeled, function (on) { prefs.skipLabeled = on; UI.store.set('viewer-skip', on); });
    var viewOnly = h('div', { class: 'viewer-viewonly' });
    var downloadLink = h('a', { class: 'btn btn-sm', target: '_blank', rel: 'noopener' }, UI.icon('download'), 'Download');
    var openLink = h('a', { class: 'btn btn-sm btn-ghost', target: '_blank', rel: 'noopener' }, UI.icon('external'), 'Open original');

    var labelSection = canLabel ? h('div', { class: 'viewer-section' },
      h('h3', { class: 'viewer-h', text: 'Label' }),
      labelBox,
      h('div', { class: 'viewer-actions' }, clearBtn, undoBtn, nextUnlabeledBtn)) : null;
    var side = h('aside', { class: 'viewer-side' },
      h('div', { class: 'viewer-head' }, titleEl, metaEl),
      statusEl,
      labelSection || viewOnly,
      canLabel ? h('div', { class: 'viewer-section' }, h('h3', { class: 'viewer-h', text: 'Flow' }), advanceSwitch.el, skipSwitch.el) : null,
      h('div', { class: 'viewer-section viewer-links' }, downloadLink, openLink),
      h('p', { class: 'viewer-hint' }, canLabel ? [h('kbd', { text: '←' }), ' ', h('kbd', { text: '→' }), ' move · ', h('kbd', { text: '/' }), ' label · ', h('kbd', { text: '?' }), ' all shortcuts']
        : [h('kbd', { text: '←' }), ' ', h('kbd', { text: '→' }), ' move · scroll to zoom · ', h('kbd', { text: 'Esc' }), ' close']));

    var root = h('div', { class: 'viewer', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Image viewer' },
      h('div', { class: 'viewer-backdrop' }),
      h('div', { class: 'viewer-shell' }, h('div', { class: 'viewer-main' }, stage, strip), side));

    if (!canLabel) buildViewOnly();

    // --- helpers -----------------------------------------------------------

    function switchEl(text, on, onChange) {
      var input = h('input', { type: 'checkbox', role: 'switch' });
      input.checked = on;
      input.addEventListener('change', function () { onChange(input.checked); });
      return { el: h('label', { class: 'switch' }, input, h('span', { class: 'switch-track' }), h('span', { text: text })), input: input };
    }

    function buildViewOnly() {
      if (opts.labelHref) {
        viewOnly.appendChild(UI.icon('tag'));
        viewOnly.appendChild(h('div', {},
          h('strong', { text: 'Ready to label?' }),
          h('p', { text: 'Open this folder in the labeling workspace to tag images one by one or in bulk.' }),
          h('a', { class: 'btn btn-sm btn-primary', href: opts.labelHref }, 'Open in labeling')));
        return;
      }
      var signedIn = window.Auth && Auth.current().user;
      viewOnly.appendChild(UI.icon('lock'));
      viewOnly.appendChild(h('div', {},
        h('strong', { text: 'View only' }),
        h('p', { text: signedIn ? 'Your account can’t label yet. Ask an admin to make you a labeler.' : 'Sign in with a labeler account to label images.' }),
        !signedIn && window.Auth ? h('button', { type: 'button', class: 'btn btn-sm btn-primary', onclick: function () { close(); Auth.openSignIn('signin'); } }, 'Sign in') : null));
    }

    function cur() { return items[index]; }

    function labelledBy(item) {
      if (!item.label) return '';
      var when = item.labeled_date ? UI.relativeTime(item.labeled_date) : '';
      var who = item.labeled_by && opts.userId && item.labeled_by === opts.userId ? 'by you' : (item.labeled_by ? 'by another labeler' : '');
      return ['Labeled', when, who].filter(Boolean).join(' ');
    }

    function render() {
      var item = cur();
      counter.textContent = (index + 1).toLocaleString() + ' / ' + items.length.toLocaleString();
      titleEl.textContent = item.filename;
      var bits = [];
      if (item.width && item.height) bits.push(item.width + ' × ' + item.height + ' px');
      if (item.file_size_bytes != null) bits.push(UI.formatBytes(item.file_size_bytes));
      if (item.format) bits.push(item.format);
      metaEl.textContent = bits.join(' · ');
      stage.setAttribute('aria-label', 'Image ' + (index + 1) + ' of ' + items.length + ': ' + item.filename + '. ' + (item.label ? 'Labeled ' + Labels.text(item.label) : 'Unlabeled'));

      statusEl.innerHTML = '';
      var locked = opts.lockedText ? opts.lockedText(item) : null;
      if (locked) statusEl.appendChild(h('span', { class: 'viewer-locked' }, UI.icon('eye-off'), locked));
      else {
        statusEl.appendChild(Labels.chip(item.label));
        var waiting = item.label && (item.review_status === 'in_review' || item.review_status === 'disputed');
        if (waiting) statusEl.appendChild(h('span', { class: 'badge', text: item.review_status === 'disputed' ? 'Disputed' : 'In review' }));
        if (item.label) statusEl.appendChild(h('span', { class: 'viewer-when', text: waiting ? 'waiting for another labeler' : labelledBy(item) }));
      }
      if (labelSection) labelSection.hidden = !!locked;

      if (picker) picker.refresh();
      prevBtn.disabled = index === 0;
      nextBtn.disabled = index === items.length - 1;
      clearBtn.disabled = !item.label;
      undoBtn.hidden = !opts.onUndo;

      var url = UI.imageUrl(item.relative_path);
      downloadLink.href = UI.imageUrl(item.relative_path, true);
      openLink.href = url;
      broken.querySelector('a').href = UI.imageUrl(item.relative_path, true);
      renderStrip();
    }

    function renderStrip() {
      strip.innerHTML = '';
      var from = Math.max(0, index - 7), to = Math.min(items.length - 1, index + 7);
      for (var i = from; i <= to; i++) {
        (function (i) {
          var it = items[i];
          var t = h('button', {
            type: 'button', class: 'strip-thumb' + (i === index ? ' active' : ''), 'aria-label': 'Go to image ' + (i + 1) + (it.label ? ', ' + Labels.text(it.label) : ''),
            'aria-current': i === index ? 'true' : null, onclick: function () { show(i); },
          }, h('img', { src: UI.imageUrl(it.relative_path), alt: '', loading: 'lazy', draggable: 'false' }));
          Labels.paint(t, it.label);
          strip.appendChild(t);
        })(i);
      }
    }

    function show(i, animate) {
      index = Math.max(0, Math.min(items.length - 1, i));
      var item = cur();
      img.classList.remove('loaded');
      broken.hidden = true;
      spinner.hidden = false;
      view.zoom = 1; view.x = 0; view.y = 0;
      img.onload = function () {
        view.natW = img.naturalWidth; view.natH = img.naturalHeight;
        spinner.hidden = true;
        layout();
        img.classList.add('loaded');
      };
      img.onerror = function () { spinner.hidden = true; broken.hidden = false; };
      img.src = UI.imageUrl(item.relative_path);
      img.alt = item.filename;
      render();
      preload(index + 1); preload(index - 1);
      if (animate) {
        img.animate([{ opacity: 0, transform: 'scale(0.96)' }, { opacity: 1, transform: 'none' }], { duration: 180, easing: 'ease-out' });
      }
    }

    function preload(i) {
      if (i < 0 || i >= items.length) return;
      var p = new Image();
      p.src = UI.imageUrl(items[i].relative_path);
    }

    // --- zoom / pan ------------------------------------------------------------

    function layout() {
      var sw = stage.clientWidth, sh = stage.clientHeight;
      if (!view.natW || !view.natH || !sw || !sh) return;
      view.fit = Math.min((sw * 0.86) / view.natW, (sh * 0.78) / view.natH, 14);
      img.style.width = (view.natW * view.fit) + 'px';
      img.style.height = (view.natH * view.fit) + 'px';
      applyTransform();
    }

    function clampPan() {
      var sw = stage.clientWidth, sh = stage.clientHeight;
      var iw = view.natW * view.fit * view.zoom, ih = view.natH * view.fit * view.zoom;
      var maxX = Math.max(0, (iw + sw) / 2 - 80), maxY = Math.max(0, (ih + sh) / 2 - 80);
      view.x = Math.max(-maxX, Math.min(maxX, view.x));
      view.y = Math.max(-maxY, Math.min(maxY, view.y));
    }

    function applyTransform() {
      clampPan();
      img.style.transform = 'translate(' + view.x + 'px,' + view.y + 'px) scale(' + view.zoom + ')';
      zoomLabel.textContent = Math.round(view.zoom * view.fit * 100) + '%';
      stage.classList.toggle('zoomed', view.zoom > 1.001);
    }

    function setZoom(z, cx, cy) {
      var old = view.zoom;
      var next = Math.max(0.2, Math.min(40 / Math.max(view.fit, 0.01), z));
      var rect = stage.getBoundingClientRect();
      var px = (cx == null ? rect.left + rect.width / 2 : cx) - (rect.left + rect.width / 2);
      var py = (cy == null ? rect.top + rect.height / 2 : cy) - (rect.top + rect.height / 2);
      view.x = px - (px - view.x) * (next / old);
      view.y = py - (py - view.y) * (next / old);
      view.zoom = next;
      applyTransform();
    }
    function zoomBy(f, cx, cy) { setZoom(view.zoom * f, cx, cy); }
    function fitView() { view.zoom = 1; view.x = 0; view.y = 0; applyTransform(); }
    function actualSize() { view.x = 0; view.y = 0; view.zoom = 1 / Math.max(view.fit, 0.0001); applyTransform(); }
    function setSharp(on) {
      prefs.sharp = on;
      UI.store.set('viewer-sharp', on);
      img.classList.toggle('sharp', on);
      sharpBtn.setAttribute('aria-pressed', String(on));
    }
    sharpBtn.addEventListener('click', function () { setSharp(!prefs.sharp); });
    setSharp(prefs.sharp);

    stage.addEventListener('wheel', function (e) {
      e.preventDefault();
      zoomBy(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0018)), e.clientX, e.clientY);
    }, { passive: false });
    stage.addEventListener('dblclick', function (e) {
      if (e.target.closest('button, .viewer-tools, a')) return;
      if (view.zoom > 1.05) fitView(); else setZoom(2.6, e.clientX, e.clientY);
    });
    stage.addEventListener('pointerdown', function (e) {
      if (e.target.closest('button, .viewer-tools, a')) return;
      stage.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 1) dragStart = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
      if (pointers.size === 2) {
        var pts = Array.from(pointers.values());
        pinchStart = { d: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y), z: view.zoom };
        dragStart = null;
      }
      stage.classList.add('grabbing');
    });
    stage.addEventListener('pointermove', function (e) {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2 && pinchStart) {
        var pts = Array.from(pointers.values());
        var d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
        setZoom(pinchStart.z * (d / pinchStart.d), (pts[0].x + pts[1].x) / 2, (pts[0].y + pts[1].y) / 2);
      } else if (dragStart) {
        view.x = dragStart.vx + (e.clientX - dragStart.x);
        view.y = dragStart.vy + (e.clientY - dragStart.y);
        applyTransform();
      }
    });
    function endPointer(e) {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinchStart = null;
      if (pointers.size === 0) { dragStart = null; stage.classList.remove('grabbing'); }
      else if (pointers.size === 1) {
        var only = Array.from(pointers.values())[0];
        dragStart = { x: only.x, y: only.y, vx: view.x, vy: view.y };
      }
    }
    stage.addEventListener('pointerup', endPointer);
    stage.addEventListener('pointercancel', endPointer);

    // --- navigation + labeling ---------------------------------------------------

    function go(delta) { var n = index + delta; if (n >= 0 && n < items.length) show(n, true); }

    function goNextUnlabeled(announce) {
      for (var i = index + 1; i < items.length; i++) if (!labeled(items[i])) { show(i, true); return true; }
      for (var j = 0; j < index; j++) if (!labeled(items[j])) { show(j, true); return true; }
      if (announce) UI.toast({ message: 'Every image in this view has a label.', kind: 'success' });
      return false;
    }

    function advanceAfterLabel() {
      if (!prefs.advance) return;
      if (prefs.skipLabeled) {
        for (var i = index + 1; i < items.length; i++) if (!labeled(items[i])) { show(i, true); return; }
        UI.toast({ message: 'That was the last unlabeled image in this view.', kind: 'info' });
      } else if (index < items.length - 1) {
        show(index + 1, true);
      }
    }

    function applyLabel(value) {
      if (!canLabel) return;
      var item = cur();
      if ((item.label || null) === (value || null)) return;
      opts.onLabel([item], value);
      UI.announce(value ? 'Labeled ' + Labels.text(value) : 'Label cleared');
      render();
      pulse(value);
      if (value) advanceAfterLabel();
    }

    function pulse(value) {
      var btn = value ? statusEl : clearBtn;
      if (btn && btn.animate) btn.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.08)' }, { transform: 'scale(1)' }], { duration: 260, easing: 'ease-out' });
    }

    function undo() {
      if (!opts.onUndo) return;
      var restored = opts.onUndo();
      if (restored) {
        var first = Array.isArray(restored) ? restored[0] : null;
        if (first != null) { var at = items.indexOf(first); if (at >= 0) show(at, true); else render(); } else render();
      }
    }

    // --- keyboard ----------------------------------------------------------------

    function onKey(e) {
      if (document.querySelector('.modal-backdrop')) return;
      var tag = (e.target.tagName || '').toLowerCase();
      if (e.key === 'Tab') { UI.trapFocus(root, e); return; }
      if (tag === 'input' && e.target.type !== 'checkbox') return;
      if (picker && picker.el.contains(e.target)) return;  // the box handles its own keys, Esc included
      if (e.altKey) return;
      var key = e.key;

      if (key === 'Escape') { e.preventDefault(); close(); return; }
      if (key === 'Tab') { UI.trapFocus(root, e); return; }
      if ((e.ctrlKey || e.metaKey) && key.toLowerCase() === 'z') { e.preventDefault(); undo(); return; }
      if (e.ctrlKey || e.metaKey) return;

      if (key === 'ArrowLeft' || key === 'k' || key === 'K') { e.preventDefault(); go(-1); }
      else if (key === 'ArrowRight' || key === 'j' || key === 'J') { e.preventDefault(); go(1); }
      else if (key === 'Home') { e.preventDefault(); show(0, true); }
      else if (key === 'End') { e.preventDefault(); show(items.length - 1, true); }
      else if (key === '+' || key === '=') { e.preventDefault(); zoomBy(1.4); }
      else if (key === '-' || key === '_') { e.preventDefault(); zoomBy(1 / 1.4); }
      else if (key === 'f' || key === 'F') { fitView(); }
      else if (key === 'a' || key === 'A') { actualSize(); }
      else if (key === 's' || key === 'S') { setSharp(!prefs.sharp); }
      else if (key === '?') { e.preventDefault(); if (window.LabelingHelp) window.LabelingHelp(); }
      else if (canLabel && (key === 'n' || key === 'N')) { goNextUnlabeled(true); }
      else if (canLabel && (key === 'z' || key === 'Z')) { undo(); }
      else if (canLabel && (key === '0' || key === 'Delete' || key === 'Backspace')) { e.preventDefault(); applyLabel(null); }
      else if (canLabel && (key === '/' || key === 'l' || key === 'L')) { e.preventDefault(); picker.focus(); }
      else if (key === '0') { fitView(); }
    }

    // --- open / close ----------------------------------------------------------------

    var inerted = [];
    function close(immediate) {
      if (current !== api) return;
      current = null;
      if (picker) picker.destroy();
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', layout);
      inerted.forEach(function (el) { el.inert = false; });
      document.body.classList.remove('modal-open');
      var done = function () {
        root.remove();
        var back = opts.originEl && document.contains(opts.originEl) ? opts.originEl : originEl;
        if (back && back.focus) back.focus({ preventScroll: true });
        if (opts.onClose) opts.onClose(index);
      };
      if (immediate || UI.reducedMotion()) { done(); return; }
      root.classList.add('closing');
      setTimeout(done, 200);
    }

    closeBtn.addEventListener('click', function () { close(); });
    root.querySelector('.viewer-backdrop').addEventListener('mousedown', function () { close(); });
    prevBtn.addEventListener('click', function () { go(-1); });
    nextBtn.addEventListener('click', function () { go(1); });
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', layout);

    document.body.appendChild(root);
    document.body.classList.add('modal-open');
    Array.prototype.forEach.call(document.body.children, function (el) {
      if (el !== root && !el.classList.contains('toasts') && !el.classList.contains('demo-pill') && el.id !== 'sr-live' && el.tagName !== 'SCRIPT' && !el.inert) {
        el.inert = true; inerted.push(el);
      }
    });

    var api = {
      close: close,
      goTo: function (i) { show(i, true); },
      refresh: render,
      get index() { return index; },
      el: root,
    };
    current = api;

    show(index, false);
    // grow out of the clicked thumbnail
    if (opts.originEl && opts.originEl.getBoundingClientRect && !UI.reducedMotion()) {
      var from = opts.originEl.getBoundingClientRect();
      var to = stage.getBoundingClientRect();
      var dx = (from.left + from.width / 2) - (to.left + to.width / 2);
      var dy = (from.top + from.height / 2) - (to.top + to.height / 2);
      var s = Math.max(0.05, Math.min(from.width / Math.max(to.width * 0.5, 1), 1));
      root.querySelector('.viewer-shell').animate([
        { opacity: 0, transform: 'translate(' + dx + 'px,' + dy + 'px) scale(' + s + ')' },
        { opacity: 1, transform: 'none' },
      ], { duration: 340, easing: 'cubic-bezier(0.22, 0.8, 0.2, 1)' });
    }
    stage.focus({ preventScroll: true });
    return api;
  }

  window.ImageViewer = { open: open, get current() { return current; } };
})();
