/**
 * Stacks mockup (stacks-demo.html): a standalone page showing how grouped
 * images could look in the labeling workspace. It is not connected to
 * labeling.js, the database or demo mode, and nothing is labeled or saved.
 *
 *   - "Show groups as stacks" (remembered in this browser) swaps the flat grid
 *     for one card per stack: the cover image with staggered cards behind it
 *     and a count. Stacks of one stay as normal tiles.
 *   - Enter on a stack (or a click) opens a pop-up with every image in it;
 *     Enter on an image there opens the full-screen viewer (viewer.js).
 *   - Enter on a single image opens the viewer directly.
 *
 * The stacks here are made up: the sample specimens are grouped by their kind
 * and split into stacks of 2-15, plus one large stack and a few loners. The
 * real grouping will come from a separate script; in this mockup a stack is
 * just { id, cover, images }.
 */
(function () {
  'use strict';

  const h = UI.h;
  const $ = (id) => document.getElementById(id);
  const fmt = (n) => Number(n).toLocaleString();
  const FOLDER = 'Cooks_CR10.15.22_10x_AI1-pp';
  const IMAGE_COUNT = 150;

  // 1. Sample images (a cut-down copy of demo.js's generator) ------------------------------

  function hashStr(s) {
    let x = 2166136261 >>> 0;
    for (let i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 16777619) >>> 0; }
    return x >>> 0;
  }
  function rng(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const CLASSES = ['filament', 'colony', 'diatom', 'other', 'debris', 'blank'];

  function specimen(rel) {
    const seed = hashStr(rel), r = rng(seed), roll = r();
    const cls = roll < 0.34 ? 'filament' : roll < 0.46 ? 'colony' : roll < 0.62 ? 'diatom' : roll < 0.74 ? 'other' : roll < 0.9 ? 'debris' : 'blank';
    const size = {
      filament: [110, 200, 46, 110], colony: [70, 120, 70, 110], diatom: [64, 110, 28, 44],
      other: [54, 90, 54, 80], debris: [28, 130, 28, 110], blank: [44, 80, 40, 70],
    }[cls];
    return { cls, seed, w: size[0] + Math.floor(r() * size[1]), h: size[2] + Math.floor(r() * size[3]) };
  }

  function svgFor(spec) {
    const r = rng(spec.seed ^ 0x9e3779b9), w = spec.w, ht = spec.h, s = [];
    const f = (n) => n.toFixed(1);
    const cx = w / 2, cy = ht / 2;
    s.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${ht}" viewBox="0 0 ${w} ${ht}">`
      + '<defs><radialGradient id="v" cx=".5" cy=".5" r=".78"><stop offset=".5" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".18"/></radialGradient></defs>'
      + `<rect width="${w}" height="${ht}" fill="#dad8d0"/>`);
    for (let i = 0; i < 7; i++) s.push(`<circle cx="${f(r() * w)}" cy="${f(r() * ht)}" r="${f(0.6 + r() * 1.6)}" fill="#8d8b82" opacity=".16"/>`);
    let k;
    if (spec.cls === 'filament') {
      const n = 10 + Math.floor(r() * 10), amp = ht * (0.12 + r() * 0.18), freq = 0.8 + r() * 1.5, ph = r() * 6.28, cr = Math.max(2.4, ht * 0.08), pts = [];
      for (k = 0; k < n; k++) { const t = k / (n - 1); pts.push([w * (0.07 + t * 0.86), cy + Math.sin(t * freq * 6.283 + ph) * amp]); }
      s.push(`<polyline fill="none" stroke="#4d8c5a" stroke-width="${f(cr * 1.5)}" stroke-linecap="round" opacity=".85" points="${pts.map(p => f(p[0]) + ',' + f(p[1])).join(' ')}"/>`);
      pts.forEach(p => s.push(`<circle cx="${f(p[0])}" cy="${f(p[1])}" r="${f(cr)}" fill="#4d8c5a" stroke="#2f5d3b" stroke-width=".6"/>`));
    } else if (spec.cls === 'colony') {
      const R = Math.min(w, ht) * (0.3 + r() * 0.1), cnt = 18 + Math.floor(r() * 24);
      s.push(`<circle cx="${f(cx)}" cy="${f(cy)}" r="${f(R * 1.18)}" fill="#6fa56b" opacity=".16"/>`);
      for (k = 0; k < cnt; k++) {
        const ang = r() * 6.283, d = Math.sqrt(r()) * R;
        s.push(`<circle cx="${f(cx + Math.cos(ang) * d)}" cy="${f(cy + Math.sin(ang) * d)}" r="${f(Math.max(2, R * (0.1 + r() * 0.08)))}" fill="#6ba66a" stroke="#3d6f47" stroke-width=".6"/>`);
      }
    } else if (spec.cls === 'diatom') {
      const a = w * 0.36, b = ht * 0.2, rot = (r() - 0.5) * 36;
      s.push(`<g transform="rotate(${f(rot)} ${f(cx)} ${f(cy)})"><ellipse cx="${f(cx)}" cy="${f(cy)}" rx="${f(a)}" ry="${f(b)}" fill="#d4b062" stroke="#8c6a26" stroke-width="1.4"/>`);
      for (k = -5; k <= 5; k++) s.push(`<line x1="${f(cx + k * a * 0.16)}" y1="${f(cy - b * 0.82)}" x2="${f(cx + k * a * 0.16)}" y2="${f(cy + b * 0.82)}" stroke="#8c6a26" stroke-width=".7" opacity=".7"/>`);
      s.push('</g>');
    } else if (spec.cls === 'other') {
      const m = 7 + Math.floor(r() * 6), RR = Math.min(w, ht) * 0.3;
      for (k = 0; k < m; k++) {
        const an = (k / m) * 6.283, x = cx + Math.cos(an) * RR, y = cy + Math.sin(an) * RR;
        s.push(`<ellipse cx="${f(x)}" cy="${f(y)}" rx="${f(RR * 0.42)}" ry="${f(RR * 0.26)}" transform="rotate(${f(an * 57.3)} ${f(x)} ${f(y)})" fill="#86b25e" stroke="#4f7a36" stroke-width=".8"/>`);
      }
      s.push(`<circle cx="${f(cx)}" cy="${f(cy)}" r="${f(RR * 0.45)}" fill="#a6c97f" stroke="#4f7a36" stroke-width=".8"/>`);
    } else if (spec.cls === 'debris') {
      const v = 7 + Math.floor(r() * 6), base = Math.min(w, ht) * (0.26 + r() * 0.14), pts = [];
      for (k = 0; k < v; k++) { const a2 = (k / v) * 6.283, rr = base * (0.55 + r() * 0.75); pts.push(f(cx + Math.cos(a2) * rr * 1.2) + ',' + f(cy + Math.sin(a2) * rr)); }
      s.push(`<polygon points="${pts.join(' ')}" fill="#6a5948" stroke="#3a3a3a" stroke-width="1" opacity=".92"/>`);
    } else {
      s.push(`<ellipse cx="${f(cx)}" cy="${f(cy)}" rx="${f(w * 0.3)}" ry="${f(ht * 0.16)}" fill="#bdbbb0" opacity=".25"/>`);
    }
    s.push('<rect width="100%" height="100%" fill="url(#v)"/></svg>');
    return s.join('');
  }

  const urlCache = {};
  // UI.imageUrl() asks window.Demo first, so the shared tiles and viewer show these.
  window.Demo = {
    imageUrl(rel) {
      if (!urlCache[rel]) urlCache[rel] = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgFor(specimen(rel)));
      return urlCache[rel];
    },
  };

  const images = [];
  for (let i = 0; i < IMAGE_COUNT; i++) {
    const filename = `${FOLDER.split('_')[0]}_${String(i + 1).padStart(5, '0')}.png`;
    const rel = `${FOLDER}/${filename}`;
    const spec = specimen(rel);
    images.push({ image_id: hashStr(rel).toString(16), filename, relative_path: rel, width: spec.w, height: spec.h, format: 'PNG', cls: spec.cls, label: null });
  }

  // 2. Made-up stacks ---------------------------------------------------------------------

  function buildStacks() {
    const r = rng(42);
    const byClass = new Map(CLASSES.map(c => [c, []]));
    images.forEach(img => byClass.get(img.cls).push(img));
    const out = [];
    let bigDone = false;
    byClass.forEach(list => {
      let at = 0;
      while (at < list.length) {
        // one large stack to show how the pop-up copes; a few loners; the rest 2-15
        let n = !bigDone && list.length >= 40 ? 40 : r() < 0.18 ? 1 : 2 + Math.floor(r() * 14);
        if (n === 40) bigDone = true;
        const members = list.slice(at, at + n);
        at += n;
        out.push({ id: `S${out.length + 1}`, cover: members[0], images: members });
      }
    });
    // shuffle so the grid isn't sorted by kind
    for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
    out.forEach((s, i) => { s.id = `${i + 1}`; });
    return out;
  }
  const stacks = buildStacks();

  // 3. Grid -------------------------------------------------------------------------------

  const state = {
    stacksOn: !!UI.store.get('stacks-demo-on', true),
    size: UI.store.get('stacks-demo-size', 'm'),
    focusKey: null,     // data-key of the card that has the roving tabindex
  };
  let popup = null;

  // One grid entry: a stack (2+ images) or a single image.
  function entries() {
    if (!state.stacksOn) return images.map(img => ({ key: 'i' + img.image_id, image: img }));
    return stacks.map(s => s.images.length > 1 ? { key: 's' + s.id, stack: s } : { key: 'i' + s.cover.image_id, image: s.cover });
  }

  function tile(img, opts) {
    opts = opts || {};
    const main = h('button', { type: 'button', class: 'tile-main', tabindex: '-1', 'aria-label': opts.aria || `${img.filename}, ${img.width} by ${img.height} pixels, unlabeled. Open in the viewer` });
    const picture = h('img', { src: UI.imageUrl(img.relative_path), alt: '', loading: 'lazy', decoding: 'async', draggable: 'false' });
    const media = h('div', { class: 'tile-media' }, picture, main,
      opts.count ? h('span', { class: 'stack-count', 'aria-hidden': 'true' }, UI.icon('layers'), fmt(opts.count)) : null,
      h('span', { class: 'tile-dim', text: `${img.width}×${img.height}` }));
    const foot = h('div', { class: 'tile-foot' }, h('div', { class: 'tile-label' },
      h('span', { class: 'lab' }, h('span', { text: opts.footText || 'Unlabeled' }))));
    return h('div', { class: 'tile readonly', style: { '--i': String((opts.i || 0) % 24) } }, media, foot);
  }

  function stackCard(s, i) {
    const n = s.images.length;
    const cover = tile(s.cover, {
      i, count: n, footText: `Stack of ${fmt(n)}`,
      aria: `Stack ${s.id}: ${fmt(n)} similar images, unlabeled. Open the stack`,
    });
    cover.classList.add('stack-top');
    // Up to two cards behind the cover; fewer for small stacks.
    const layers = n >= 3 ? 2 : 1;
    const wrap = h('div', { class: `stack-card layers-${layers}` },
      layers >= 2 ? h('span', { class: 'stack-layer l2', 'aria-hidden': 'true' }) : null,
      h('span', { class: 'stack-layer l1', 'aria-hidden': 'true' }),
      cover);
    return wrap;
  }

  function renderGrid() {
    const grid = $('image-grid');
    const list = entries();
    grid.innerHTML = '';
    grid.dataset.size = state.size;
    grid.classList.toggle('stacked', state.stacksOn);
    if (!list.some(e => e.key === state.focusKey)) state.focusKey = list[0] && list[0].key;
    list.forEach((e, i) => {
      const el = e.stack ? stackCard(e.stack, i) : tile(e.image, { i });
      const item = h('div', { class: 'grid-item', 'data-key': e.key }, el);
      item.querySelector('.tile-main').tabIndex = e.key === state.focusKey ? 0 : -1;
      grid.appendChild(item);
    });
    const multi = stacks.filter(s => s.images.length > 1);
    const singles = stacks.length - multi.length;
    $('folder-sub').textContent = `cooks pond · 10/15/2022 · ${fmt(images.length)} images`;
    $('grid-summary').textContent = state.stacksOn
      ? `${fmt(images.length)} images as ${fmt(multi.length)} stacks and ${fmt(singles)} single images`
      : `${fmt(images.length)} images, not grouped`;
  }

  function itemEls() { return [...$('image-grid').querySelectorAll('.grid-item')]; }

  function focusItem(el) {
    if (!el) return;
    itemEls().forEach(x => { x.querySelector('.tile-main').tabIndex = x === el ? 0 : -1; });
    state.focusKey = el.dataset.key;
    el.querySelector('.tile-main').focus();
  }

  function columnsOf(grid) {
    return Math.max(1, getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length);
  }

  // Arrow keys / Home / End move a roving focus through a grid's items.
  function moveIn(grid, items, from, e, focus) {
    const cols = columnsOf(grid);
    const map = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols, ArrowUp: -cols, Home: -1e6, End: 1e6 };
    if (!(e.key in map)) return false;
    e.preventDefault();
    const at = items.indexOf(from);
    focus(items[Math.max(0, Math.min(items.length - 1, at + map[e.key]))]);
    return true;
  }

  function activate(item) {
    const key = item.dataset.key;
    state.focusKey = key;
    if (key[0] === 's') openStack(stacks.find(s => 's' + s.id === key), item);
    else {
      const img = images.find(x => 'i' + x.image_id === key);
      // In stacks view, a single image opens alone; otherwise browse the whole folder.
      const list = state.stacksOn ? [img] : images;
      openViewer(list, list.indexOf(img), item.querySelector('.tile'), (last) => {
        const back = state.stacksOn ? item : itemEls().find(x => x.dataset.key === 'i' + list[last].image_id);
        focusItem(back && document.contains(back) ? back : item);
      });
    }
  }

  function openViewer(list, index, originEl, onClose) {
    ImageViewer.open({ items: list, index, folderName: FOLDER, canLabel: false, originEl, onClose });
  }

  // 4. Stack pop-up -----------------------------------------------------------------------

  const FOCUSABLE = 'button:not([disabled]), [tabindex]:not([tabindex="-1"])';

  function openStack(stack, originItem) {
    if (popup) return;
    const n = stack.images.length;
    const titleId = 'stack-title';
    const grid = h('div', { class: 'image-grid stack-grid', 'data-size': state.size, role: 'group', 'aria-label': `Images in stack ${stack.id}` });
    stack.images.forEach((img, i) => {
      const t = tile(img, { i, footText: i === 0 ? 'Cover image' : img.filename });
      if (i === 0) t.classList.add('is-cover');
      const item = h('div', { class: 'grid-item', 'data-index': String(i) }, t);
      item.querySelector('.tile-main').tabIndex = i === 0 ? 0 : -1;
      grid.appendChild(item);
    });
    const closeBtn = h('button', { type: 'button', class: 'close-btn', 'aria-label': 'Close' }, UI.icon('x'));
    const box = h('div', { class: 'modal stack-modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
      h('div', { class: 'modal-header' },
        h('div', {},
          h('p', { class: 'eyebrow', text: `Stack ${stack.id}` }),
          h('h2', { id: titleId, text: `${fmt(n)} similar images` })),
        closeBtn),
      h('div', { class: 'modal-body' },
        h('p', { class: 'stack-hint', text: 'Arrow keys move · Enter opens an image in the viewer · Esc closes' }),
        grid));
    const backdrop = h('div', { class: 'stack-backdrop' }, box);

    const popItems = () => [...grid.querySelectorAll('.grid-item')];
    const focusPop = (el) => {
      if (!el) return;
      popItems().forEach(x => { x.querySelector('.tile-main').tabIndex = x === el ? 0 : -1; });
      el.querySelector('.tile-main').focus();
    };
    const openAt = (item) => {
      const i = Number(item.dataset.index);
      openViewer(stack.images, i, item.querySelector('.tile'), (last) => {
        document.body.classList.add('modal-open');   // the viewer clears it on close
        focusPop(popItems()[last]);
      });
    };

    function close() {
      document.removeEventListener('keydown', onKey, true);
      backdrop.remove();
      document.body.classList.remove('modal-open');
      popup = null;
      if (originItem && document.contains(originItem)) focusItem(originItem);
    }
    function onKey(e) {
      if (ImageViewer.current) return;   // the viewer handles its own keys (Esc closes it, not this)
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
      if (e.key === 'Tab') {
        const nodes = [...box.querySelectorAll(FOCUSABLE)];
        const first = nodes[0], last = nodes[nodes.length - 1];
        if (e.shiftKey && document.activeElement === first) { last.focus(); e.preventDefault(); }
        else if (!e.shiftKey && document.activeElement === last) { first.focus(); e.preventDefault(); }
        return;
      }
      const item = e.target.closest && e.target.closest('.stack-grid .grid-item');
      if (!item) return;
      if (moveIn(grid, popItems(), item, e, focusPop)) return;
      if (e.key === 'Enter') { e.preventDefault(); openAt(item); }
    }

    grid.addEventListener('click', (e) => {
      const item = e.target.closest('.grid-item');
      if (item) openAt(item);
    });
    closeBtn.addEventListener('click', close);
    backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) close(); });
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(backdrop);
    document.body.classList.add('modal-open');
    popup = { close };
    focusPop(popItems()[0]);
    UI.announce(`Stack ${stack.id} opened: ${n} images`);
  }

  // 5. Wiring -----------------------------------------------------------------------------

  function syncControls() {
    $('stacks-toggle').checked = state.stacksOn;
    document.querySelectorAll('#size-seg button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.size === state.size)));
  }

  $('stacks-toggle').addEventListener('change', (e) => {
    state.stacksOn = e.target.checked;
    UI.store.set('stacks-demo-on', state.stacksOn);
    state.focusKey = null;
    renderGrid();
    UI.announce(state.stacksOn ? 'Showing groups as stacks' : 'Showing every image');
  });
  $('size-seg').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-size]');
    if (!b) return;
    state.size = b.dataset.size;
    UI.store.set('stacks-demo-size', state.size);
    syncControls();
    renderGrid();
  });

  const grid = $('image-grid');
  grid.addEventListener('click', (e) => {
    const item = e.target.closest('.grid-item');
    if (item) activate(item);
  });
  grid.addEventListener('keydown', (e) => {
    const item = e.target.closest && e.target.closest('.grid-item');
    if (!item) return;
    if (moveIn(grid, itemEls(), item, e, focusItem)) return;
    if (e.key === 'Enter') { e.preventDefault(); activate(item); }
  });

  syncControls();
  renderGrid();
})();
