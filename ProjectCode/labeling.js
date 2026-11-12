/**
 * Labeling workspace (labeling.html).
 *
 * Anyone can browse; admins and labelers can also label (in demo mode, anyone
 * can label the sample images). Data comes from
 * Supabase (window.sb, created in auth.js) and images from the Cloudflare
 * Worker. Only the `label` column is writable from the browser; labeled_by and
 * labeled_date are stamped by a database trigger (supabase/migrations/002_labeling.sql),
 * never sent from here.
 *
 * How labeling works:
 *   - Click tiles to select them (Shift-click for a range), then pick a label in
 *     the label panel beside the grid: type part of its name (any part: "deb"
 *     finds Microcystis Debris) and press Enter, or click it. Every selected
 *     image gets it at once. "Enter new label" adds a label to the shared list.
 *   - With nothing selected, / or L jumps to the panel for the focused (or
 *     hovered) tile.
 *   - Each tile also has its own label box, and Enter / the expand button opens
 *     the viewer for careful, one-by-one review.
 *   - Changes appear instantly and save in the background (in order, in batches);
 *     if a save fails, the images are put back and you're told. Undo covers it all.
 *
 * The label list (shared, in the database) and the type-ahead box live in labels.js.
 *
 * Blind review (supabase/migrations/006_blind_review.sql; demo.js answers the
 * same way): images.label is the official label. A labeler's label is saved
 * through submit_labels() as "in review" until another labeler confirms it on
 * review.html; an admin's is official at once. Other people's labels in review
 * are hidden and locked here, and the progress counts official labels only.
 * Without 006 applied, labels are official as soon as they're saved, as before.
 */
(function () {
  'use strict';

  const h = UI.h;
  const DB_PAGE_SIZE = 1000;   // PostgREST's per-request row cap
  const BATCH_SIZE = 200;      // ids per UPDATE request (image_id is a 16-char hex string)
  const IMAGE_COLUMNS = 'image_id, filename, relative_path, width, height, file_size_bytes, format, label, labeled_by, labeled_date';
  const fmt = (n) => Number(n).toLocaleString();
  const $ = (id) => document.getElementById(id);

  const state = {
    booted: false,
    user: null,
    role: 'viewer',
    canLabel: false,
    stats: null,            // labeling_stats row
    counts: new Map(),      // label -> number of images
    myCount: 0,
    folders: [],            // progress + metadata per folder
    currentFolder: null,    // one of state.folders
    images: [],             // every image in the current folder
    byId: new Map(),
    viewFilter: UI.store.get('lbl-view', 'all'),   // all | unlabeled | labeled | label:<value>
    page: 1,
    pageSize: UI.store.get('lbl-pagesize', 48),
    size: UI.store.get('lbl-size', 'm'),
    railFilter: UI.store.get('lbl-railf', 'todo'),
    railSort: UI.store.get('lbl-sort', 'least'),
    railQuery: '',
    selected: new Set(),
    anchorId: null,         // where a Shift-click range starts
    focusId: null,          // tile that has (or last had) keyboard focus
    hoverId: null,
    lastVia: 'focus',
    undoStack: [],
    pending: 0,             // saves in flight
    queue: Promise.resolve(),
    loadSeq: 0,
    celebrated: new Set(),
    rerenderTimer: null,
    pinnedId: null,         // with nothing selected, the image the label panel acts on
    reviewMode: false,      // blind review is on (006 applied, or the demo)
    reviewCounts: null,     // review_counts(): in_review, disputed, to_review, ...
    isAdmin: false,
  };

  // Has a label, even one hidden from you while it's in review.
  const hasLabel = (img) => !!(img.label || img.label_hidden);
  // Someone else's label waiting for review (demo): not yours to change here.
  const isLocked = (img) => state.reviewMode && !state.isAdmin && !!img.label_hidden;
  const statusText = (img) => img.review_status === 'disputed' ? 'Disputed' : 'In review';
  let panelPicker = null;
  let tileEls = new Map();
  let menuEl = null;
  let exporting = false;

  // 1. Data access --------------------------------------------------------------------

  async function fetchAll(build) {
    const rows = [];
    for (let from = 0; ; from += DB_PAGE_SIZE) {
      const { data, error } = await build().range(from, from + DB_PAGE_SIZE - 1);
      if (error) throw error;
      rows.push(...data);
      if (data.length < DB_PAGE_SIZE) return rows;
    }
  }

  async function fetchFolderImages(folderName) {
    const query = (opts) => sb.from('images').select(IMAGE_COLUMNS, opts).eq('folder_name', folderName).order('filename');
    const first = await query({ count: 'exact' }).range(0, DB_PAGE_SIZE - 1);
    if (first.error) throw first.error;
    const total = first.count ?? first.data.length;
    const offsets = [];
    for (let from = DB_PAGE_SIZE; from < total; from += DB_PAGE_SIZE) offsets.push(from);
    const pages = [];
    for (let i = 0; i < offsets.length; i += 4) {
      const batch = await Promise.all(offsets.slice(i, i + 4).map(async (from) => {
        const { data, error } = await query({}).range(from, from + DB_PAGE_SIZE - 1);
        if (error) throw error;
        return data;
      }));
      pages.push(...batch);
    }
    return first.data.concat(...pages);
  }

  function isMissingSchema(err) {
    const text = `${(err && err.code) || ''} ${(err && err.message) || ''}`;
    return /PGRST205|PGRST202|42P01|42703|schema cache|does not exist/i.test(text);
  }

  async function loadOverview() {
    const statsRes = await sb.from('labeling_stats').select('*').single();
    if (statsRes.error) throw statsRes.error;
    const [counts, progress, meta, mine] = await Promise.all([
      fetchAll(() => sb.from('label_counts').select('label, image_count')),
      fetchAll(() => sb.from('folder_labeling_progress').select('folder_name, image_count, labeled_count, unlabeled_count, pct_labeled')),
      fetchAll(() => sb.from('folders_visible').select('folder_name, site_normalized, date, sample_date, sample_code, capture_mode, is_pp')),
      state.user ? sb.rpc('my_labeling_count') : Promise.resolve({ data: 0, error: null }),
      loadReviewCounts(),
    ]);
    const byName = new Map(meta.map(m => [m.folder_name, m]));
    state.stats = statsRes.data;
    state.counts = new Map(counts.map(c => [c.label, Number(c.image_count)]));
    state.myCount = mine.error ? 0 : Number(mine.data || 0);
    state.folders = progress.map(p => {
      const m = byName.get(p.folder_name) || {};
      return {
        folder_name: p.folder_name,
        image_count: Number(p.image_count),
        labeled_count: Number(p.labeled_count),
        site: m.site_normalized || '', date: m.date || '', sample_date: m.sample_date || '',
        capture_mode: m.capture_mode || '', sample_code: m.sample_code || '', is_pp: !!m.is_pp,
      };
    });
    if (state.currentFolder) state.currentFolder = state.folders.find(f => f.folder_name === state.currentFolder.folder_name) || state.currentFolder;
  }

  // Blind review is on when review_counts() exists (006) and this person can label.
  async function loadReviewCounts() {
    if (!state.canLabel || !state.user) { state.reviewMode = false; state.reviewCounts = null; return; }
    const { data, error } = await sb.rpc('review_counts');
    if (error) {
      if (!isMissingSchema(error)) console.error('Couldn’t load the review counts:', error);
      state.reviewMode = false; state.reviewCounts = null;
      return;
    }
    state.reviewMode = true;
    state.reviewCounts = data;
  }

  // 2. Boot and accounts -------------------------------------------------------------------

  let lastAuthKey = null;

  async function applyAuth(auth) {
    const role = (auth.profile && auth.profile.role) || 'viewer';
    const demo = !!window.APP_DEMO;
    const actor = demo ? Demo.actor() : null;
    const key = (auth.user ? `${auth.user.id}|${role}` : 'anon') + (actor ? `|${actor.id}` : '');
    if (key === lastAuthKey) return;
    lastAuthKey = key;
    // Demo mode (demo.js) is a sandbox on sample data: anyone may label there,
    // signed in or not, as themselves or a sample person ("Acting as").
    state.user = demo ? actor : auth.user;
    state.role = demo ? actor.role : auth.user ? role : 'viewer';
    state.canLabel = demo || (!!auth.user && ['owner', 'admin', 'labeler'].includes(role));
    state.isAdmin = ['owner', 'admin'].includes(state.role);
    renderRoleBanner();
    if (!state.booted) await boot();
    else { await refreshOverview(true); applyRoleToUi(); }
  }

  function renderRoleBanner() {
    const host = $('role-banner');
    host.innerHTML = '';
    if (state.canLabel) return;
    const signedIn = !!state.user;
    host.appendChild(h('div', { class: 'alert alert-info', role: 'status' },
      UI.icon('eye'),
      h('div', { class: 'alert-body' },
        h('div', {},
          h('strong', { text: 'You’re in view-only mode' }),
          h('span', { text: signedIn
            ? ' Your account has the Viewer role. Request the labeler role on the Admin page, and the labeling tools will appear here once an admin approves it.'
            : ' Browse every folder and image. Sign in with a labeler account to label them.' })),
        signedIn
          ? h('a', { class: 'btn btn-sm btn-primary', href: 'admin.html' }, UI.icon('shield'), 'Request the labeler role')
          : h('button', { type: 'button', class: 'btn btn-sm btn-primary', onclick: () => Auth.openSignIn('signin') }, UI.icon('log-in'), 'Sign in'))));
  }

  async function boot() {
    state.booted = true;
    if (!window.sb) return showFatal(new Error('The Supabase library did not load (blocked by the network or a browser extension?).'));
    try {
      await Promise.all([loadOverview(), Labels.ready]);
    } catch (err) {
      if (isMissingSchema(err)) { $('role-banner').innerHTML = ''; $('setup-card').hidden = false; return; }
      return showFatal(err);
    }
    $('labeling-app').hidden = false;
    buildViewFilter();
    syncControls();
    renderProgress(false);
    renderRail();
    setupLabelPanel();
    applyRoleToUi();
    Labels.onChange(() => {
      buildViewFilter();
      renderProgress(false);
      if (state.currentFolder) renderGrid({ keepFocus: true });
    });

    const wanted = new URLSearchParams(location.search).get('folder');
    if (wanted && state.folders.some(f => f.folder_name === wanted)) await selectFolder(wanted, { quiet: true });
    else if (state.canLabel) startNext(true);

    document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshOverview(true); });
    window.setInterval(() => { if (!document.hidden) refreshOverview(true); }, 120000);
  }

  function showFatal(err) {
    console.error('Labeling failed to load:', err);
    const host = $('role-banner');
    host.innerHTML = '';
    host.appendChild(h('div', { class: 'alert alert-error', role: 'alert' }, UI.icon('alert'),
      h('div', { class: 'alert-body' },
        h('strong', { text: 'Couldn’t load the labeling workspace.' }),
        h('p', { text: (err && err.message) || String(err) }),
        h('button', { type: 'button', class: 'btn btn-sm', onclick: () => location.reload() }, UI.icon('refresh'), 'Reload'))));
  }

  async function refreshOverview(silent) {
    if (state.pending) return;
    try {
      await loadOverview();
      renderProgress(true);
      renderRail(true);
      if (state.currentFolder) renderFolderHeader();
      if (!silent) UI.toast({ message: 'Progress refreshed.', kind: 'info', duration: 2000 });
    } catch (err) {
      if (!silent) UI.toast({ message: `Couldn’t refresh: ${err.message || err}`, kind: 'error' });
    }
  }

  function applyRoleToUi() {
    $('select-tools').hidden = !state.canLabel;
    $('label-panel').hidden = !state.canLabel;
    $('status-hint').textContent = state.canLabel
      ? 'Click to select · Shift-click for a range · / to label · Enter opens the viewer'
      : 'Click an image to open it in the viewer';
    if (state.currentFolder) renderGrid({ keepFocus: true });
    updatePanel();
  }

  // 3. Overview: ring, label mix, export ----------------------------------------------------------

  function renderProgress(animate) {
    const s = state.stats;
    if (!s) return;
    const total = Number(s.total_images), labeled = Number(s.labeled_images);
    const pct = total ? (labeled / total) * 100 : 0;
    const shown = pct > 0 && pct < 1 ? pct.toFixed(1) : Math.round(pct);
    $('ring-fill').setAttribute('stroke-dasharray', `${pct} ${100 - pct}`);
    const pctEl = $('ring-pct');
    if (animate) UI.countUp(pctEl, pct, { duration: 700, format: n => `${n > 0 && n < 1 ? n.toFixed(1) : Math.round(n)}%` });
    else { pctEl.textContent = `${shown}%`; pctEl._countValue = pct; }

    const stats = $('progress-stats');
    stats.innerHTML = '';
    stats.append(h('strong', { text: fmt(labeled) }), ` of ${fmt(total)} images ${state.reviewMode ? 'officially ' : ''}labeled`);
    const rc = state.reviewCounts;
    if (state.reviewMode && rc) {
      stats.append(' · ', h('strong', { text: fmt(rc.in_review) }), ' in review');
      if (Number(rc.disputed)) stats.append(' · ', h('strong', { text: fmt(rc.disputed) }), ' disputed');
      stats.append(' · ', h('a', { href: 'review.html', text: 'Open the review queue' }));
    }
    if (state.user) stats.append(' · you’ve labeled ', h('strong', { text: fmt(state.myCount) }));
    if (Number(s.labeler_count)) stats.append(` · ${s.labeler_count} ${Number(s.labeler_count) === 1 ? 'person' : 'people'} contributing`);

    // The bar is split by category; the legend lists each category's labels.
    const bar = $('mix-bar');
    const legend = $('label-breakdown');
    bar.innerHTML = '';
    legend.innerHTML = '';
    legend.classList.add('by-cat');
    const known = Labels.options.map(o => o.value);
    const extra = [...state.counts.keys()].filter(k => known.indexOf(k) < 0 && state.counts.get(k) > 0);
    const groups = Labels.categories.map(c => ({ cat: c, values: Labels.options.filter(o => o.category === c.key).map(o => o.value) }));
    if (extra.length) groups.push({ cat: Labels.categoryOf(''), values: extra });
    const parts = [];
    groups.forEach(({ cat, values }) => {
      const total = values.reduce((sum, v) => sum + (state.counts.get(v) || 0), 0);
      if (total > 0) {
        bar.appendChild(h('span', { 'data-cat': cat.key || null, style: { flexGrow: String(total), flexBasis: '0' }, title: `${cat.text}: ${fmt(total)}` }));
        parts.push(`${cat.text} ${fmt(total)}`);
      }
      const li = h('li', { 'data-cat': cat.key || null },
        h('span', { class: 'mix-cat-name' }, Labels.glyph(cat.glyph), cat.text, h('b', { text: fmt(total) })));
      values.forEach(value => {
        const n = state.counts.get(value) || 0;
        const chip = Labels.chip(value);
        chip.appendChild(h('b', { text: fmt(n) }));
        if (n === 0) chip.style.opacity = '0.55';
        li.appendChild(chip);
      });
      legend.appendChild(li);
    });
    bar.setAttribute('aria-label', labeled ? `Label mix: ${parts.join(', ')}` : 'No labels yet');
  }

  async function exportLabels() {
    if (exporting) return;
    exporting = true;
    const btn = $('export-btn');
    btn.disabled = true;
    const toast = UI.toast({ message: 'Preparing your CSV…', kind: 'info', sticky: true, id: 'export' });
    try {
      const rows = await fetchAll(() => sb.from('images').select('image_id, folder_name, filename, label, labeled_date')
        .not('label', 'is', null).order('folder_name').order('filename'));
      toast.dismiss(true);
      if (!rows.length) { UI.toast({ message: 'Nothing has been labeled yet, so there’s nothing to export.', kind: 'info' }); return; }
      // images.label holds official labels only, so that's what this exports.
      rows.forEach(r => { r.category = Labels.category(r.label).key || ''; });
      const text = UI.csv(rows, ['image_id', 'folder_name', 'filename', 'label', 'category', 'labeled_date']);
      UI.download(`water-sample-labels-${new Date().toISOString().slice(0, 10)}.csv`, text);
      UI.toast({ message: `Exported ${fmt(rows.length)} labels.`, kind: 'success' });
    } catch (err) {
      toast.dismiss(true);
      UI.toast({ message: `Export failed: ${err.message || err}`, kind: 'error' });
    } finally {
      exporting = false;
      btn.disabled = false;
    }
  }

  // 4. Folder rail ---------------------------------------------------------------------------------

  function railRows() {
    const q = state.railQuery.trim().toLowerCase();
    let rows = state.folders.filter(f => {
      if (q && !(`${f.folder_name} ${f.site} ${f.date} ${UI.formatDate(f.sample_date, f.date)}`.toLowerCase().includes(q))) return false;
      const todo = f.labeled_count < f.image_count;
      if (state.railFilter === 'todo') return todo;
      if (state.railFilter === 'done') return !todo && f.image_count > 0;
      return true;
    });
    const byName = (a, b) => a.folder_name.localeCompare(b.folder_name);
    const sorters = {
      least: (a, b) => (a.labeled_count / (a.image_count || 1)) - (b.labeled_count / (b.image_count || 1)) || byName(a, b),
      most: (a, b) => b.image_count - a.image_count || byName(a, b),
      name: byName,
      date: (a, b) => (a.sample_date || '9').localeCompare(b.sample_date || '9') || byName(a, b),
    };
    return rows.sort(sorters[state.railSort] || byName);
  }

  function railItem(f) {
    const pct = f.image_count ? (f.labeled_count / f.image_count) * 100 : 0;
    const done = f.image_count > 0 && f.labeled_count >= f.image_count;
    const current = state.currentFolder && state.currentFolder.folder_name === f.folder_name;
    const meta = [f.site ? f.site.replace(/\b[a-z]/g, c => c.toUpperCase()) : '', UI.formatDate(f.sample_date, f.date), f.capture_mode].filter(Boolean).join(' · ');
    const btn = h('button', {
      type: 'button', class: `rail-item${done ? ' done' : ''}`, 'data-folder': f.folder_name, 'aria-current': current ? 'true' : null,
      title: f.folder_name,
    },
      h('span', { class: 'rail-name', text: f.folder_name }),
      h('span', { class: 'rail-frac' }, done ? UI.icon('check') : null, done ? ' Done' : `${fmt(f.labeled_count)}/${fmt(f.image_count)}`),
      h('span', { class: 'rail-meta', text: meta }),
      h('span', { class: `progress thin${done ? ' done' : ''}` }, h('span', { style: { '--value': `${pct}%` } })));
    return h('li', {}, btn);
  }

  function renderRail(keepScroll) {
    const list = $('folder-list');
    const top = keepScroll ? list.scrollTop : 0;
    const rows = railRows();
    list.innerHTML = '';
    $('rail-count').textContent = fmt(rows.length);
    if (!rows.length) {
      list.appendChild(h('li', { class: 'rail-empty', text: state.railFilter === 'todo' && !state.railQuery ? 'Every folder is fully labeled. Nice work!' : 'No folders match.' }));
      return;
    }
    rows.forEach(f => list.appendChild(railItem(f)));
    list.scrollTop = top;
    const active = list.querySelector('[aria-current="true"]');
    if (active && !keepScroll) active.scrollIntoView({ block: 'nearest' });
  }

  function updateRailItem(f) {
    const old = $('folder-list').querySelector(`[data-folder="${CSS.escape(f.folder_name)}"]`);
    if (!old) return;
    const li = railItem(f);
    old.closest('li').replaceWith(li);
  }

  function startNext(silent) {
    const rows = state.folders.filter(f => f.labeled_count < f.image_count)
      .sort((a, b) => (a.labeled_count / (a.image_count || 1)) - (b.labeled_count / (b.image_count || 1)) || a.folder_name.localeCompare(b.folder_name));
    const cur = state.currentFolder && state.currentFolder.folder_name;
    const next = rows.find(f => f.folder_name !== cur) || rows[0];
    if (!next) {
      if (!silent) UI.toast({ message: 'Every folder is fully labeled.', kind: 'success' });
      return;
    }
    selectFolder(next.folder_name, { quiet: !!silent });
  }

  // 5. Opening a folder -------------------------------------------------------------------------------

  async function selectFolder(name, opts) {
    const f = state.folders.find(x => x.folder_name === name);
    if (!f) return;
    closeMenu();
    const seq = ++state.loadSeq;
    state.currentFolder = f;
    state.selected.clear();
    state.anchorId = null; state.focusId = null; state.hoverId = null;
    state.page = 1;
    state.undoStack = [];
    state.images = []; state.byId = new Map();

    $('grid-empty').hidden = true;
    $('grid-content').hidden = false;
    renderFolderHeader();
    renderSkeleton();
    document.querySelectorAll('.rail-item[aria-current]').forEach(el => el.removeAttribute('aria-current'));
    const railBtn = $('folder-list').querySelector(`[data-folder="${CSS.escape(name)}"]`);
    if (railBtn) railBtn.setAttribute('aria-current', 'true');
    syncUrl();
    if (!opts || !opts.quiet) {
      const panel = $('grid-panel');
      if (panel.getBoundingClientRect().top < 0 || window.innerWidth < 1100) panel.scrollIntoView({ behavior: UI.reducedMotion() ? 'auto' : 'smooth', block: 'start' });
    }

    try {
      const [images, pendingRows] = await Promise.all([
        fetchFolderImages(name),
        state.reviewMode ? sb.rpc('folder_pending', { folder: name }).then(r => { if (r.error) throw r.error; return r.data || []; }) : Promise.resolve([]),
      ]);
      if (seq !== state.loadSeq) return;
      images.forEach(i => {
        i._folder = f;
        i.official_label = i.label || null;
        i.review_status = i.label ? 'official' : null;
        i.label_hidden = false;
      });
      // Pending labels: yours (or, for admins, everyone's) show; others' are hidden and locked.
      const byIdNow = new Map(images.map(i => [i.image_id, i]));
      pendingRows.forEach(p => {
        const img = byIdNow.get(p.image_id);
        if (!img) return;
        img.review_status = p.status;
        if (p.label) img.label = p.label;
        else img.label_hidden = true;
      });
      state.images = images;
      state.byId = new Map(images.map(i => [i.image_id, i]));
      // the server's count is the truth; keep the rail in step with what we actually loaded
      f.image_count = images.length;
      f.labeled_count = images.filter(hasLabel).length;
      updateRailItem(f);
      renderFolderHeader();
      renderGrid();
    } catch (err) {
      if (seq !== state.loadSeq) return;
      console.error(err);
      $('image-grid').innerHTML = '';
      $('image-grid').appendChild(h('div', { class: 'alert alert-error', role: 'alert', style: { gridColumn: '1 / -1' } }, UI.icon('alert'),
        h('div', { class: 'alert-body' }, h('strong', { text: 'Couldn’t load this folder.' }), h('p', { text: err.message || String(err) }),
          h('button', { type: 'button', class: 'btn btn-sm', onclick: () => selectFolder(name) }, UI.icon('refresh'), 'Try again'))));
    }
  }

  function syncUrl() {
    const url = new URL(location.href);
    if (state.currentFolder) url.searchParams.set('folder', state.currentFolder.folder_name);
    history.replaceState(null, '', url);
  }

  function renderFolderHeader() {
    const f = state.currentFolder;
    if (!f) return;
    $('folder-title').textContent = f.folder_name;
    const sub = [f.site ? f.site.replace(/\b[a-z]/g, c => c.toUpperCase()) : '', UI.formatDate(f.sample_date, f.date), f.capture_mode, f.sample_code, f.is_pp ? 'Post-processed' : 'Raw'].filter(Boolean).join(' · ');
    $('folder-sub').textContent = sub;
    const pct = f.image_count ? (f.labeled_count / f.image_count) * 100 : 0;
    const bar = $('folder-bar');
    bar.style.setProperty('--value', `${pct}%`);
    bar.parentElement.classList.toggle('done', pct >= 100);
    $('folder-progress-text').textContent = `${fmt(f.labeled_count)} / ${fmt(f.image_count)} labeled`;
  }

  // 6. The grid -------------------------------------------------------------------------------------------

  function buildViewFilter() {
    const sel = $('view-filter');
    sel.innerHTML = '';
    const add = (value, text, parent) => (parent || sel).appendChild(h('option', { value, text }));
    add('all', 'All images');
    add('unlabeled', 'Unlabeled only');
    add('labeled', 'Labeled (any)');
    if (state.reviewMode) { add('status:in_review', 'In review'); add('status:disputed', 'Disputed'); add('status:official', 'Official'); }
    const cats = h('optgroup', { label: 'A category' });
    Labels.categories.forEach(c => add(`cat:${c.key}`, c.text, cats));
    sel.appendChild(cats);
    Labels.categories.forEach(c => {
      const opts = Labels.options.filter(o => o.category === c.key);
      if (!opts.length) return;
      const group = h('optgroup', { label: c.text });
      opts.forEach(o => add(`label:${o.value}`, o.text, group));
      sel.appendChild(group);
    });
    if (![...sel.options].some(o => o.value === state.viewFilter)) state.viewFilter = 'all';
    sel.value = state.viewFilter;
  }

  function syncControls() {
    document.querySelectorAll('#rail-filter button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.f === state.railFilter)));
    $('folder-sort').value = state.railSort;
    document.querySelectorAll('#size-seg button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.size === state.size)));
    $('image-grid').dataset.size = state.size;
    $('grid-page-size').value = String(state.pageSize);
  }

  function viewList() {
    const f = state.viewFilter;
    if (f === 'unlabeled') return state.images.filter(i => !hasLabel(i));
    if (f === 'labeled') return state.images.filter(hasLabel);
    if (f.startsWith('status:')) { const st = f.slice(7); return state.images.filter(i => hasLabel(i) && i.review_status === st); }
    if (f.startsWith('label:')) { const v = f.slice(6); return state.images.filter(i => i.label === v); }
    if (f.startsWith('cat:')) { const c = f.slice(4); return state.images.filter(i => i.label && Labels.get(i.label).category === c); }
    return state.images;
  }

  function pageOf(list) {
    const pages = Math.max(1, Math.ceil(list.length / state.pageSize));
    state.page = Math.max(1, Math.min(state.page, pages));
    const start = (state.page - 1) * state.pageSize;
    return { pages, start, slice: list.slice(start, start + state.pageSize) };
  }

  function renderSkeleton() {
    const grid = $('image-grid');
    grid.innerHTML = '';
    grid.setAttribute('aria-busy', 'true');
    for (let i = 0; i < 12; i++) {
      grid.appendChild(h('div', { class: 'tile skel' },
        h('div', { class: 'tile-media' }, h('span', { class: 'skeleton' })),
        h('div', { class: 'tile-foot' }, h('span', { class: 'skeleton' }))));
    }
    $('grid-pager').hidden = true;
  }

  function renderGrid(opts) {
    if (!state.currentFolder) return;
    opts = opts || {};
    const grid = $('image-grid');
    const activeTile = document.activeElement && document.activeElement.closest ? document.activeElement.closest('.tile') : null;
    const hadFocus = !!activeTile && grid.contains(activeTile);
    if (hadFocus) state.focusId = activeTile.dataset.id;
    const oldIds = [...tileEls.keys()];
    const oldFocusAt = Math.max(0, oldIds.indexOf(state.focusId));
    const list = viewList();
    const { pages, start, slice } = pageOf(list);
    grid.removeAttribute('aria-busy');
    grid.innerHTML = '';
    tileEls = new Map();
    $('grid-pager').hidden = false;

    const f = state.currentFolder;
    const complete = f.image_count > 0 && f.labeled_count >= f.image_count;
    const existing = document.getElementById('done-banner');
    if (existing) existing.remove();
    if (complete && state.canLabel) {
      grid.before(h('div', { id: 'done-banner', class: 'done-banner', role: 'status' }, UI.icon('check-circle'),
        h('strong', { text: 'This folder is fully labeled.' }),
        h('span', { text: 'Review it below, or move on.' }),
        h('button', { type: 'button', class: 'btn btn-sm btn-primary', onclick: () => startNext() }, 'Next folder that needs labels', UI.icon('arrow-right'))));
    }

    if (!list.length) {
      const msg = state.viewFilter === 'unlabeled'
        ? ['All caught up here', 'Every image in this folder has a label.']
        : ['Nothing matches this filter', 'Try “All images” to see the whole folder.'];
      grid.appendChild(h('div', { class: 'empty-state', style: { gridColumn: '1 / -1' } }, UI.icon('check-circle'), h('strong', { text: msg[0] }), h('span', { text: msg[1] }),
        state.viewFilter !== 'all' ? h('button', { type: 'button', class: 'btn btn-sm', onclick: () => setViewFilter('all') }, 'Show all images') : null));
    } else {
      if (!state.focusId || !slice.some(i => i.image_id === state.focusId)) {
        state.focusId = slice[Math.min(oldFocusAt, slice.length - 1)].image_id;
      }
      slice.forEach((img, i) => {
        const tile = buildTile(img, i);
        tileEls.set(img.image_id, tile);
        grid.appendChild(tile);
      });
    }
    grid.setAttribute('aria-label', `Images ${list.length ? `${start + 1} to ${start + slice.length} of ${fmt(list.length)}` : ''}`);
    renderPager(list.length, pages);
    renderSelection();
    if (opts.keepFocus && hadFocus && state.focusId && tileEls.has(state.focusId)) focusTile(state.focusId, true);
  }

  function labelButtonContent(img) {
    if (isLocked(img)) return [h('span', { class: 'lab' }, UI.icon('eye-off'), h('span', { text: statusText(img) })), h('span', { class: 'tile-status', text: 'Hidden' })];
    if (!img.label) return [h('span', { class: 'lab' }, state.canLabel ? 'Add label' : 'Unlabeled'), state.canLabel ? UI.icon('chevron-down', 'chev') : null];
    const pending = state.reviewMode && img.review_status && img.review_status !== 'official';
    return [h('span', { class: 'lab' }, Labels.glyph(Labels.category(img.label).glyph), h('span', { text: Labels.text(img.label) })),
      pending ? h('span', { class: 'tile-status', text: statusText(img) }) : null,
      state.canLabel ? UI.icon('chevron-down', 'chev') : null];
  }

  function tileAria(img) {
    const bits = [img.filename];
    if (img.width) bits.push(`${img.width} by ${img.height} pixels`);
    bits.push(isLocked(img) ? `${statusText(img).toLowerCase()}, label hidden` : img.label ? `labeled ${Labels.text(img.label)}` : 'unlabeled');
    if (state.reviewMode && img.label && img.review_status && img.review_status !== 'official') bits.push(statusText(img).toLowerCase());
    return bits.join(', ');
  }

  function buildTile(img, i) {
    const main = h('button', { type: 'button', class: 'tile-main', tabindex: '-1', 'aria-pressed': 'false' });
    const picture = h('img', { src: UI.imageUrl(img.relative_path), alt: '', loading: 'lazy', decoding: 'async', draggable: 'false' });
    picture.addEventListener('error', () => picture.classList.add('broken'), { once: true });
    const expand = h('button', { type: 'button', class: 'icon-btn sm tile-open', tabindex: '-1', 'aria-label': `Open ${img.filename} in the viewer` }, UI.icon('maximize'));
    const media = h('div', { class: 'tile-media' },
      picture, h('div', { class: 'tile-fallback', text: 'Preview unavailable' }), main,
      state.canLabel ? h('span', { class: 'tile-check', 'aria-hidden': 'true' }, UI.icon('check')) : null,
      img.width ? h('span', { class: 'tile-dim', text: `${img.width}×${img.height}` }) : null, expand);
    const labelBtn = h(state.canLabel ? 'button' : 'div', { class: 'tile-label' });
    if (state.canLabel) { labelBtn.type = 'button'; labelBtn.tabIndex = -1; labelBtn.setAttribute('aria-haspopup', 'dialog'); }
    const tile = h('div', { class: `tile${state.canLabel ? '' : ' readonly'}`, 'data-id': img.image_id, style: { '--i': String(i % 24) } },
      media, h('div', { class: 'tile-foot' }, labelBtn));
    paintTile(tile, img);
    return tile;
  }

  // Sync a tile's label colour, label button text, and selection state with the data.
  function paintTile(tile, img) {
    const labelBtn = tile.querySelector('.tile-label');
    const main = tile.querySelector('.tile-main');
    Labels.paint(tile, img.label);
    Labels.paint(labelBtn, img.label);
    if (state.reviewMode && hasLabel(img) && img.review_status) tile.setAttribute('data-status', img.review_status); else tile.removeAttribute('data-status');
    tile.classList.toggle('locked', isLocked(img));
    labelBtn.innerHTML = '';
    labelBtn.append(...labelButtonContent(img).filter(Boolean));  // append() would write a null as "null"
    if (state.canLabel) labelBtn.setAttribute('aria-label', isLocked(img) ? `${statusText(img)}: waiting for review` : `Label: ${Labels.text(img.label)}. Change label`);
    const selected = state.selected.has(img.image_id);
    tile.classList.toggle('selected', selected);
    main.setAttribute('aria-pressed', String(selected));
    main.setAttribute('aria-label', tileAria(img) + (selected ? ', selected' : ''));
    main.tabIndex = img.image_id === state.focusId ? 0 : -1;
  }

  function renderPager(total, pages) {
    const info = $('grid-pagination-info');
    const box = $('grid-pagination-container');
    box.innerHTML = '';
    if (!total) { info.textContent = 'No images to show'; return; }
    const start = (state.page - 1) * state.pageSize + 1;
    info.textContent = `Showing ${fmt(start)}–${fmt(Math.min(total, start + state.pageSize - 1))} of ${fmt(total)}`;
    const btn = (content, page, o = {}) => {
      const b = h('button', { type: 'button', class: o.active ? 'active' : null, 'aria-label': o.label || `Page ${page}`, 'aria-current': o.active ? 'page' : null, onclick: () => goPage(page) }, content);
      b.disabled = !!o.disabled;
      return b;
    };
    box.appendChild(btn([UI.icon('chevron-left'), ' Prev'], state.page - 1, { label: 'Previous page', disabled: state.page <= 1 }));
    const win = 5;
    let from = Math.max(1, state.page - 2);
    const to = Math.min(pages, from + win - 1);
    from = Math.max(1, to - win + 1);
    if (from > 1) { box.appendChild(btn('1', 1)); if (from > 2) box.appendChild(h('span', { class: 'page-ellipsis', text: '…' })); }
    for (let p = from; p <= to; p++) box.appendChild(btn(String(p), p, { active: p === state.page }));
    if (to < pages) { if (to < pages - 1) box.appendChild(h('span', { class: 'page-ellipsis', text: '…' })); box.appendChild(btn(String(pages), pages)); }
    box.appendChild(btn(['Next ', UI.icon('chevron-right')], state.page + 1, { label: 'Next page', disabled: state.page >= pages }));
  }

  function goPage(p, focusFirst) {
    state.page = p;
    state.focusId = null;
    renderGrid();
    const grid = $('image-grid');
    const top = $('sticky-tools').getBoundingClientRect().top + window.scrollY - 80;
    if (window.scrollY > top) window.scrollTo({ top: Math.max(0, top), behavior: UI.reducedMotion() ? 'auto' : 'smooth' });
    if (focusFirst && state.focusId) focusTile(state.focusId);
    void grid;
  }

  function setViewFilter(value) {
    state.viewFilter = value;
    UI.store.set('lbl-view', value);
    $('view-filter').value = value;
    state.page = 1;
    state.focusId = null;
    renderGrid();
  }

  // 7. Selection, focus and targets --------------------------------------------------------------------------

  function visibleIds() { return viewList().map(i => i.image_id); }

  function lockedToast() {
    UI.toast({ id: 'locked', message: 'That image is waiting for review. Its label is hidden until someone reviews it on the Review page.', kind: 'info', duration: 3500 });
  }

  function selectable(id) { const img = state.byId.get(id); return !!img && !isLocked(img); }

  function toggleSelect(id, extend) {
    if (!state.canLabel) return;
    if (!selectable(id)) { lockedToast(); return; }
    if (extend && state.anchorId && state.anchorId !== id) {
      const ids = visibleIds();
      const a = ids.indexOf(state.anchorId), b = ids.indexOf(id);
      if (a >= 0 && b >= 0) {
        const [lo, hi] = a < b ? [a, b] : [b, a];
        for (let i = lo; i <= hi; i++) if (selectable(ids[i])) state.selected.add(ids[i]);
      }
    } else {
      if (state.selected.has(id)) state.selected.delete(id); else state.selected.add(id);
      state.anchorId = id;
    }
    state.pinnedId = null;
    renderSelection();
  }

  function selectPage() {
    const { slice } = pageOf(viewList());
    const open = slice.filter(i => !isLocked(i));
    open.forEach(i => state.selected.add(i.image_id));
    renderSelection();
    UI.announce(`${open.length} images selected`);
  }

  function clearSelection() {
    if (!state.selected.size) return;
    state.selected.clear();
    state.anchorId = null;
    renderSelection();
  }

  function renderSelection() {
    if (state.selected.size) state.pinnedId = null;
    tileEls.forEach((tile, id) => {
      const on = state.selected.has(id);
      tile.classList.toggle('selected', on);
      tile.querySelector('.tile-main').setAttribute('aria-pressed', String(on));
      const img = state.byId.get(id);
      if (img) tile.querySelector('.tile-main').setAttribute('aria-label', tileAria(img) + (on ? ', selected' : ''));
    });
    updatePanel();
  }

  // The tile that has real keyboard focus right now (not just the roving-tabindex anchor).
  function focusedTileId() {
    const el = document.activeElement;
    const tile = el && el.closest && el.closest('.tile');
    return tile && tileEls.has(tile.dataset.id) ? tile.dataset.id : null;
  }

  // With nothing selected, number keys act on the tile you last pointed at or
  // moved to, whichever you did most recently.
  function targetId() {
    const focused = focusedTileId();
    const hovered = state.hoverId && tileEls.has(state.hoverId) ? state.hoverId : null;
    return state.lastVia === 'hover' ? (hovered || focused) : (focused || hovered);
  }

  function inPanel() {
    const el = document.activeElement;
    return !!(el && $('label-panel').contains(el));
  }

  // Selected images, else the one image the panel was opened for, else the
  // focused or hovered tile.
  function targets() {
    if (state.selected.size) return [...state.selected].map(id => state.byId.get(id)).filter(Boolean);
    const id = inPanel() ? state.pinnedId : targetId();
    const img = id && state.byId.get(id);
    return img && !isLocked(img) ? [img] : [];
  }

  // Remember which image the panel acts on before focus moves into it (while
  // the mouse is in the panel there's no hovered tile any more).
  function pinTarget() {
    if (inPanel()) return;
    state.pinnedId = state.selected.size ? null : targetId();
  }

  function focusTile(id, silent) {
    const tile = tileEls.get(id);
    if (!tile) return;
    tileEls.forEach((t, tid) => { t.querySelector('.tile-main').tabIndex = tid === id ? 0 : -1; });
    state.focusId = id;
    state.lastVia = 'focus';
    tile.querySelector('.tile-main').focus({ preventScroll: !!silent });
  }

  function columns() {
    const cols = getComputedStyle($('image-grid')).gridTemplateColumns.split(' ').filter(Boolean).length;
    return Math.max(1, cols);
  }

  function moveFocus(delta, extend, fromId) {
    const ids = [...tileEls.keys()];
    const at = ids.indexOf(fromId || state.focusId);
    const next = Math.max(0, Math.min(ids.length - 1, at + delta));
    if (state.canLabel && extend) {
      if (!state.anchorId) state.anchorId = fromId || state.focusId;
      const a = ids.indexOf(state.anchorId), lo = Math.min(a, next), hi = Math.max(a, next);
      for (let i = lo; i <= hi; i++) if (selectable(ids[i])) state.selected.add(ids[i]);
      renderSelection();
    }
    focusTile(ids[next]);
  }

  function updatePanel() {
    const panel = $('label-panel');
    if (!panel || panel.hidden) return;
    const t = targets();
    panel.classList.toggle('armed', t.length > 0);
    const target = $('label-target');
    target.textContent = state.selected.size
      ? `Applies to ${fmt(state.selected.size)} selected ${state.selected.size === 1 ? 'image' : 'images'}`
      : t.length ? `Applies to ${t[0].filename}` : 'Select the images to label';
    target.classList.toggle('has', t.length > 0);
    $('clear-label-btn').disabled = !t.some(i => i.label);
    $('undo-btn').disabled = !state.undoStack.some(e => !e.failed);
    const count = $('selection-count');
    count.textContent = state.selected.size ? `${fmt(state.selected.size)} selected` : 'Nothing selected';
    count.classList.toggle('has', state.selected.size > 0);
    document.querySelectorAll('.tile.is-target').forEach(el => el.classList.remove('is-target'));
    if (!state.selected.size && state.canLabel) {
      const id = inPanel() ? state.pinnedId : targetId();
      const el = id && tileEls.get(id);
      if (el && !el.classList.contains('locked')) el.classList.add('is-target');
    }
    // The current label is marked in the list when every target shares it.
    if (panelPicker) panelPicker.refresh();
  }

  function sharedLabel() {
    const t = targets();
    if (!t.length) return null;
    const first = t[0].label || null;
    return t.every(i => (i.label || null) === first) ? first : null;
  }

  function setupLabelPanel() {
    panelPicker = Labels.picker({
      label: 'Label the selected images',
      current: sharedLabel,
      onPick: (option) => applyFromPanel(option.value),
      onEscape: () => returnToGrid(),
    });
    $('label-picker-host').appendChild(panelPicker.el);
    const panel = $('label-panel');
    panel.addEventListener('pointerdown', pinTarget, true);
    panel.addEventListener('focusin', () => updatePanel());
    panel.addEventListener('focusout', () => setTimeout(updatePanel, 0));
    $('clear-label-btn').addEventListener('click', () => applyFromPanel(null));
    $('undo-btn').addEventListener('click', () => undo());
  }

  function applyFromPanel(value) {
    const t = targets();
    if (!t.length) {
      UI.toast({ message: 'Select some images first, or hover one and press /.', kind: 'info', duration: 2600 });
      return;
    }
    const fromSelection = state.selected.size > 0;
    const backTo = fromSelection ? null : t[0].image_id;
    applyLabel(t, value, { source: 'grid', clearSelection: fromSelection });
    state.pinnedId = null;
    returnToGrid(backTo);
  }

  // Back to the grid so the arrow keys work again.
  function returnToGrid(id) {
    const want = id || state.focusId;
    if (want && tileEls.has(want)) focusTile(want, true);
    else if (document.activeElement && $('label-panel').contains(document.activeElement)) document.activeElement.blur();
    updatePanel();
  }

  function focusPanel() {
    if (!state.canLabel || !panelPicker) return;
    pinTarget();
    panelPicker.focus();
    const panel = $('label-panel');
    const r = panel.getBoundingClientRect();
    if (r.top < 0 || r.bottom > window.innerHeight) panel.scrollIntoView({ block: 'nearest', behavior: UI.reducedMotion() ? 'auto' : 'smooth' });
    updatePanel();
  }

  // 8. Labeling: apply, save, undo -----------------------------------------------------------------------------

  function applyToTargets(value) {
    const t = targets();
    if (!t.length) { UI.toast({ message: 'Select some images first, or hover one.', kind: 'info', duration: 2400 }); return; }
    const fromSelection = state.selected.size > 0;
    applyLabel(t, value, { source: 'grid', clearSelection: fromSelection });
  }

  function pushUndo(entry) {
    state.undoStack.push(entry);
    if (state.undoStack.length > 30) state.undoStack.shift();
  }

  // An image's label state: what this person sees (label), the official label,
  // and the review status (official, in_review, disputed, or null).
  function viewOf(img) {
    return { label: img.label || null, official: img.official_label !== undefined ? img.official_label || null : img.label || null,
      status: img.review_status || (img.label ? 'official' : null), hidden: !!img.label_hidden };
  }

  // What labeling an image `value` (null: clear) leads to. Admins (and every
  // label without blind review) are official at once. A labeler's label waits
  // for review; picking the official label again, or clearing, withdraws it.
  function nextView(img, value) {
    if (!state.reviewMode || state.isAdmin) return { label: value, official: value, status: value ? 'official' : null, hidden: false };
    const cur = viewOf(img);
    if (value === null || value === cur.official) return { label: cur.official, official: cur.official, status: cur.official ? 'official' : null, hidden: false };
    return { label: value, official: cur.official, status: 'in_review', hidden: false };
  }

  const isPendingStatus = (st) => st === 'in_review' || st === 'disputed';
  const hasAny = (v) => !!(v.label || v.hidden || v.official);

  // Keeps the counters in step as an image moves from one label state to another.
  // Only official labels count as labeled overall; any label counts for the folder.
  function bump(img, prev, next, by) {
    const s = state.stats;
    if (prev.official !== next.official) {
      if (!prev.official && next.official) { s.labeled_images = Number(s.labeled_images) + 1; s.unlabeled_images = Number(s.unlabeled_images) - 1; }
      if (prev.official && !next.official) { s.labeled_images = Number(s.labeled_images) - 1; s.unlabeled_images = Number(s.unlabeled_images) + 1; }
      s.pct_labeled = Number(s.total_images) ? Math.round((1000 * Number(s.labeled_images)) / Number(s.total_images)) / 10 : 0;
      if (prev.official) state.counts.set(prev.official, Math.max(0, (state.counts.get(prev.official) || 0) - 1));
      if (next.official) state.counts.set(next.official, (state.counts.get(next.official) || 0) + 1);
      const me = state.user && state.user.id;
      if (prev.official && img.labeled_by === me) state.myCount = Math.max(0, state.myCount - 1);
      if (next.official && by === me) state.myCount += 1;
    }
    const rc = state.reviewCounts;
    if (rc) {
      if (isPendingStatus(prev.status)) rc[prev.status] = Math.max(0, Number(rc[prev.status]) - 1);
      if (isPendingStatus(next.status)) rc[next.status] = Number(rc[next.status]) + 1;
    }
    const f = img._folder || state.currentFolder;
    if (f) {
      if (!hasAny(prev) && hasAny(next)) f.labeled_count += 1;
      if (hasAny(prev) && !hasAny(next)) f.labeled_count = Math.max(0, f.labeled_count - 1);
    }
  }

  // Moves an image to label state `next`. by/date credit an official label that changed.
  function applyView(img, next, by, date) {
    const prev = viewOf(img);
    bump(img, prev, next, by);
    if (prev.official !== next.official) {
      img.labeled_by = next.official ? by : null;
      img.labeled_date = next.official ? date : null;
    }
    img.label = next.label;
    img.official_label = next.official;
    img.review_status = next.status;
    img.label_hidden = next.hidden;
  }

  const sameView = (a, b) => a.label === b.label && a.official === b.official && a.status === b.status && a.hidden === b.hidden;

  // Apply `value` (or null to clear) to images; returns the images that actually changed.
  function applyLabel(images, value, opts) {
    opts = opts || {};
    if (!state.canLabel || !state.user) return [];
    value = value || null;
    let explained = false;  // a reason was already shown, so no "Nothing to clear" on top
    const locked = images.filter(isLocked);
    if (locked.length) {
      images = images.filter(img => !isLocked(img));
      if (!opts.quiet) UI.toast({ id: 'locked', message: `Skipped ${fmt(locked.length)} ${locked.length === 1 ? 'image' : 'images'} waiting for review.`, kind: 'info', duration: 3000 });
      explained = true;
    }
    // Labelers can withdraw their own label in review, but only admins clear an official one.
    if (value === null && state.reviewMode && !state.isAdmin) {
      const official = images.filter(img => viewOf(img).status === 'official');
      if (official.length) {
        images = images.filter(img => viewOf(img).status !== 'official');
        if (!opts.quiet) UI.toast({ id: 'locked', message: `Only an admin can clear an official label (${fmt(official.length)} skipped).`, kind: 'info', duration: 3500 });
        explained = true;
      }
    }
    const changing = images.filter(img => !sameView(viewOf(img), nextView(img, value)));
    if (!changing.length) {
      if (!opts.quiet && !explained) UI.toast({ message: value ? `Already labeled ${Labels.text(value)}.` : 'Nothing to clear.', kind: 'info', duration: 2200 });
      return [];
    }
    const me = state.user.id, now = new Date().toISOString();
    const snapshot = changing.map(img => Object.assign({ img, by: img.labeled_by || null, date: img.labeled_date || null }, viewOf(img)));
    const entry = { snapshot, value, failed: false };
    if (opts.record !== false) pushUndo(entry);
    changing.forEach(img => applyView(img, nextView(img, value), me, now));

    afterChange(changing, value, opts);
    enqueueSave(changing, value, snapshot, entry);
    return changing;
  }

  function afterChange(changed, value, opts) {
    const f = state.currentFolder;
    const filter = state.viewFilter;
    const stillShown = (img) => filter === 'all' || (filter === 'unlabeled' && !hasLabel(img)) || (filter === 'labeled' && hasLabel(img))
      || (filter.startsWith('status:') && img.review_status === filter.slice(7))
      || (filter.startsWith('label:') && img.label === filter.slice(6))
      || (filter.startsWith('cat:') && !!img.label && Labels.get(img.label).category === filter.slice(4));
    let leaving = 0;
    changed.forEach(img => {
      const tile = tileEls.get(img.image_id);
      if (!tile) return;
      paintTile(tile, img);
      if (stillShown(img)) {
        if (value && !UI.reducedMotion()) { tile.classList.remove('flash'); void tile.offsetWidth; tile.classList.add('flash'); }
      } else { tile.classList.add('leaving'); leaving++; }
    });
    if (opts.clearSelection) { state.selected.clear(); state.anchorId = null; renderSelection(); }
    else updatePanel();
    if (leaving) scheduleRerender(340);

    renderFolderHeader();
    new Set(changed.map(i => i._folder || f)).forEach(folder => { if (folder) updateRailItem(folder); });
    renderProgress(true);

    if (opts.source !== 'viewer' && opts.source !== 'undo' && !opts.quiet) {
      const n = changed.length;
      UI.toast({
        id: 'label', kind: 'success', duration: 6000,
        message: value
          ? `Labeled ${fmt(n)} ${n === 1 ? 'image' : 'images'} as ${Labels.text(value)}${state.reviewMode && !state.isAdmin ? ' (waiting for review)' : ''}`
          : `Cleared the label on ${fmt(n)} ${n === 1 ? 'image' : 'images'}`,
        action: { label: 'Undo', onClick: () => undo() },
      });
    }
    UI.announce(value ? `${changed.length} labeled ${Labels.text(value)}` : `${changed.length} labels cleared`);
    checkComplete(f);
  }

  function scheduleRerender(ms) {
    clearTimeout(state.rerenderTimer);
    state.rerenderTimer = setTimeout(() => { if (!ImageViewer.current) renderGrid({ keepFocus: true }); else state.needsRerender = true; }, ms);
  }

  function checkComplete(f) {
    if (!f || !(f.image_count > 0) || f.labeled_count < f.image_count) return;
    if (state.celebrated.has(f.folder_name)) return;
    state.celebrated.add(f.folder_name);
    const rect = $('grid-panel').getBoundingClientRect();
    FX.confetti({ x: rect.left + rect.width / 2, y: Math.max(140, Math.min(window.innerHeight * 0.4, rect.top + 160)) });
    UI.toast({ message: 'Folder complete. Nice work!', kind: 'success', duration: 5000,
      action: { label: 'Next folder', onClick: () => startNext() } });
    if (!ImageViewer.current) renderGrid({ keepFocus: true }); else state.needsRerender = true;
  }

  // Saves happen one job at a time, in the order the labels were applied, so a
  // quick sequence (label, then clear) always lands on the server in that order.
  function enqueueSave(images, value, snapshot, entry) {
    state.pending++;
    updateSaveStatus();
    const ids = images.map(i => i.image_id);
    state.queue = state.queue.then(async () => {
      let saved = 0;
      try {
        const refused = [];
        for (let i = 0; i < ids.length; i += BATCH_SIZE) {
          const batch = ids.slice(i, i + BATCH_SIZE);
          if (state.reviewMode) {
            // 006: one row per image; a few can be refused (someone else's label in review).
            const { data, error } = await sb.rpc('submit_labels', { image_ids: batch, new_label: value });
            if (error) throw error;
            (data || []).forEach(r => { if (['locked', 'not_allowed', 'missing'].includes(r.outcome)) refused.push(r.target); });
          } else {
            const { error } = await sb.from('images').update({ label: value }).in('image_id', batch);
            if (error) throw error;
          }
          saved = i + batch.length;
        }
        if (refused.length) {
          revert(snapshot.filter(s => refused.includes(s.img.image_id)), {
            message: `${refused.length === 1 ? 'that image is' : 'those images are'} waiting for someone else’s review, or only an admin can change them`, code: 'REFUSED' });
        }
      } catch (err) {
        entry.failed = true;
        revert(snapshot.filter(s => ids.indexOf(s.img.image_id) >= saved), err);
      }
    }).finally(() => {
      state.pending--;
      updateSaveStatus();
    });
  }

  function revert(snapshot, err) {
    snapshot.forEach(s => {
      applyView(s.img, { label: s.label, official: s.official, status: s.status, hidden: s.hidden }, s.by, s.date);
      s.img.labeled_by = s.by; s.img.labeled_date = s.date;
    });
    snapshot.forEach(s => { const tile = tileEls.get(s.img.image_id); if (tile) paintTile(tile, s.img); });
    const f = state.currentFolder;
    renderFolderHeader();
    new Set(snapshot.map(x => x.img._folder || f)).forEach(folder => { if (folder) updateRailItem(folder); });
    renderProgress(true);
    updatePanel();
    state.saveError = true;
    updateSaveStatus();
    const denied = err && (err.code === '42501' || /row-level security|permission denied/i.test(err.message || ''));
    UI.toast({
      id: 'label', kind: 'error', duration: 9000,
      message: denied
        ? 'Your account isn’t allowed to label. Ask an admin for the labeler role. The images were put back.'
        : `Couldn’t save ${fmt(snapshot.length)} ${snapshot.length === 1 ? 'label' : 'labels'} (${(err && err.message) || 'network error'}). The images were put back.`,
    });
  }

  function updateSaveStatus() {
    const el = $('save-status');
    if (!el) return;
    el.classList.toggle('saving', state.pending > 0);
    el.classList.toggle('error', !state.pending && !!state.saveError);
    el.innerHTML = '';
    if (state.pending) el.append(UI.icon('refresh'), `Saving${state.pending > 1 ? ` (${state.pending})` : ''}…`);
    else if (state.saveError) { el.append(UI.icon('alert'), 'Some changes couldn’t be saved'); }
    else el.append(UI.icon('check-circle'), 'All changes saved');
    if (!state.pending) state.saveError = false;
  }

  function undo() {
    while (state.undoStack.length) {
      const entry = state.undoStack.pop();
      if (entry.failed) continue;
      const groups = new Map();
      entry.snapshot.forEach(s => {
        const k = s.label || '';
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(s.img);
      });
      const restored = [];
      groups.forEach((imgs, k) => restored.push(...applyLabel(imgs, k || null, { record: false, quiet: true, source: 'undo' })));
      UI.toast({ message: `Undid ${fmt(entry.snapshot.length)} ${entry.snapshot.length === 1 ? 'label' : 'labels'}.`, kind: 'info', duration: 2600, id: 'label' });
      updatePanel();
      return restored.length ? restored : true;
    }
    UI.toast({ message: 'Nothing to undo.', kind: 'info', duration: 2000 });
    return false;
  }

  // 9. Per-tile label menu ----------------------------------------------------------------------------------------

  function closeMenu(restoreFocus) {
    if (!menuEl) return;
    const returnTo = menuEl._returnTo;
    if (menuEl._picker) menuEl._picker.destroy();
    menuEl.remove();
    menuEl = null;
    document.removeEventListener('pointerdown', onOutsideMenu, true);
    window.removeEventListener('scroll', onMenuScroll, true);
    window.removeEventListener('resize', closeMenu);
    if (restoreFocus && returnTo && document.contains(returnTo)) returnTo.focus({ preventScroll: true });
  }
  function onOutsideMenu(e) { if (menuEl && !menuEl.contains(e.target)) closeMenu(); }
  // Scrolling the page closes the box; scrolling its own list doesn't.
  function onMenuScroll(e) { if (menuEl && !menuEl.contains(e.target)) closeMenu(); }

  // The label box for one tile, floating next to its label button.
  function openLabelMenu(anchor, img, returnTo) {
    if (!state.canLabel) return;
    if (isLocked(img)) { lockedToast(); return; }
    closeMenu();
    const picker = Labels.picker({
      label: `Label for ${img.filename}`,
      current: () => img.label || null,
      onPick: (option) => { closeMenu(true); applyLabel([img], option.value, { source: 'menu' }); },
      onEscape: () => closeMenu(true),
    });
    const clearBtn = h('button', { type: 'button', class: 'btn btn-sm btn-ghost', disabled: !img.label,
      onclick: () => { closeMenu(true); applyLabel([img], null, { source: 'menu' }); } }, UI.icon('x'), 'Clear label');
    const menu = h('div', { class: 'popover label-popover', role: 'dialog', 'aria-label': `Label for ${img.filename}` },
      h('div', { class: 'lp-head' }, h('strong', { text: img.filename }), clearBtn),
      picker.el);
    menu._returnTo = returnTo || anchor;
    menu._picker = picker;
    menu.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu(true); }
      else if (e.key === 'Tab') UI.trapFocus(menu, e);
    });
    (document.querySelector('main') || document.body).appendChild(menu);
    menuEl = menu;

    const r = anchor.getBoundingClientRect();
    const mh = menu.offsetHeight, mw = menu.offsetWidth;
    const below = r.bottom + 6 + mh < window.innerHeight - 8;
    menu.style.top = `${below ? r.bottom + 6 : Math.max(8, r.top - mh - 6)}px`;
    menu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - mw - 8))}px`;
    menu.style.setProperty('--ox', below ? 'top left' : 'bottom left');

    document.addEventListener('pointerdown', onOutsideMenu, true);
    window.addEventListener('scroll', onMenuScroll, true);
    window.addEventListener('resize', closeMenu);
    picker.focus();
  }

  // 10. The viewer ---------------------------------------------------------------------------------------------------

  function openViewer(id, originEl) {
    const list = viewList();
    const index = list.findIndex(i => i.image_id === id);
    if (index < 0) return;
    ImageViewer.open({
      items: list.slice(),
      index,
      folderName: state.currentFolder.folder_name,
      canLabel: state.canLabel,
      lockedText: (item) => isLocked(item) ? `${statusText(item)}: someone else’s label, hidden until it’s reviewed` : null,
      userId: state.user && state.user.id,
      originEl,
      onLabel: (items, value) => applyLabel(items, value, { source: 'viewer', quiet: true }),
      onUndo: () => undo(),
      onClose: (lastIndex) => {
        const item = list[lastIndex];
        if (item) {
          const at = viewList().findIndex(i => i.image_id === item.image_id);
          if (at >= 0) state.page = Math.floor(at / state.pageSize) + 1;
          state.focusId = item.image_id;
        }
        state.needsRerender = false;
        renderGrid();
        if (state.focusId && tileEls.has(state.focusId)) focusTile(state.focusId, true);
      },
    });
  }

  // 11. Keyboard + shortcuts help ---------------------------------------------------------------------------------------

  function openHelp() {
    const group = (title, rows) => h('section', { class: 'shortcut-group' }, h('h3', { text: title }),
      h('dl', {}, rows.map(([keys, text]) => [h('dt', {}, keys.map(k => h('kbd', { text: k }))), h('dd', { text })])));
    UI.dialog({
      title: 'Keyboard shortcuts', wide: true,
      content: h('div', { class: 'shortcut-grid' },
        group('In the grid', [
          [['←', '↑', '→', '↓'], 'Move between images'],
          [['Space'], 'Select or deselect the image'],
          [['Shift', '←→'], 'Extend the selection'],
          [['Enter'], 'Open the viewer'],
          [['/'], 'Go to the label box (L works too)'],
          [['0'], 'Clear the label'],
          [['Z'], 'Undo the last change'],
          [['Ctrl/⌘', 'A'], 'Select everything on this page'],
          [['Esc'], 'Deselect'],
          [['PgUp', 'PgDn'], 'Previous / next page'],
        ]),
        group('In the label box', [
          [['a–z'], 'Type any part of a name: “deb” finds Microcystis Debris'],
          [['↑', '↓'], 'Move through the matches'],
          [['Enter'], 'Apply the highlighted label (or add a new one)'],
          [['Esc'], 'Clear what you typed, then back to the images'],
        ]),
        group('In the viewer', [
          [['←', '→'], 'Previous / next image'],
          [['/'], 'Go to the label box; Enter labels it and moves on'],
          [['0'], 'Clear the label'],
          [['N'], 'Jump to the next unlabeled image'],
          [['Z'], 'Undo'],
          [['+', '−'], 'Zoom in / out (or scroll)'],
          [['F'], 'Fit to window'],
          [['A'], 'Actual pixels'],
          [['S'], 'Sharp pixels on / off'],
          [['Esc'], 'Close the viewer'],
        ])),
    });
  }
  window.LabelingHelp = openHelp;

  function onGlobalKey(e) {
    if (ImageViewer.current || document.querySelector('.modal-backdrop') || menuEl || !state.currentFolder) return;
    const tag = ((e.target && e.target.tagName) || '').toLowerCase();
    if (tag === 'select' || tag === 'textarea' || (tag === 'input' && e.target.type !== 'checkbox')) return;
    if (e.altKey) return;
    const key = e.key;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && key.toLowerCase() === 'z' && state.canLabel) { e.preventDefault(); undo(); return; }
    if (mod && key.toLowerCase() === 'a' && state.canLabel) { e.preventDefault(); selectPage(); return; }
    if (mod) return;
    if (key === '?') { e.preventDefault(); openHelp(); return; }
    if ($('label-panel').contains(e.target)) return;
    if (key === 'Escape') { if (state.selected.size) { e.preventDefault(); clearSelection(); } return; }
    if (key === 'PageDown') { const pages = pageOf(viewList()).pages; if (state.page < pages) { e.preventDefault(); goPage(state.page + 1, true); } return; }
    if (key === 'PageUp') { if (state.page > 1) { e.preventDefault(); goPage(state.page - 1, true); } return; }
    if (!state.canLabel) return;
    if (key === 'z' || key === 'Z') { e.preventDefault(); undo(); return; }
    if (key === '/' || key === 'l' || key === 'L') { e.preventDefault(); focusPanel(); return; }
    if (key === '0' || key === 'Delete' || key === 'Backspace') { e.preventDefault(); applyToTargets(null); return; }
  }

  function onTileKey(e) {
    const main = e.target.closest && e.target.closest('.tile-main');
    if (!main) return;
    const id = main.closest('.tile').dataset.id;
    const cols = columns();
    const map = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols, ArrowUp: -cols };
    if (e.key in map) { e.preventDefault(); moveFocus(map[e.key], e.shiftKey, id); }
    else if (e.key === 'Home') { e.preventDefault(); moveFocus(-1e6, false, id); }
    else if (e.key === 'End') { e.preventDefault(); moveFocus(1e6, false, id); }
    else if (e.key === 'Enter') { e.preventDefault(); openViewer(id, main.closest('.tile')); }
  }

  // 12. Wiring ---------------------------------------------------------------------------------------------------------------

  function bindEvents() {
    const grid = $('image-grid');

    grid.addEventListener('click', (e) => {
      const tile = e.target.closest('.tile');
      if (!tile || tile.classList.contains('skel')) return;
      const id = tile.dataset.id;
      if (e.target.closest('.tile-open')) { openViewer(id, tile); return; }
      if (e.target.closest('button.tile-label')) { openLabelMenu(e.target.closest('button.tile-label'), state.byId.get(id), tile.querySelector('.tile-main')); return; }
      if (!e.target.closest('.tile-main')) return;
      state.focusId = id; state.lastVia = 'focus';
      if (!state.canLabel) { openViewer(id, tile); return; }
      toggleSelect(id, e.shiftKey);
    });
    grid.addEventListener('dblclick', (e) => {
      const tile = e.target.closest('.tile');
      if (tile && e.target.closest('.tile-main') && state.canLabel) openViewer(tile.dataset.id, tile);
    });
    grid.addEventListener('keydown', onTileKey);
    grid.addEventListener('focusin', (e) => {
      const tile = e.target.closest && e.target.closest('.tile');
      if (!tile || !e.target.classList.contains('tile-main')) return;
      state.focusId = tile.dataset.id;
      state.lastVia = 'focus';
      tileEls.forEach((t, tid) => { t.querySelector('.tile-main').tabIndex = tid === state.focusId ? 0 : -1; });
      updatePanel();
    });
    grid.addEventListener('focusout', () => setTimeout(updatePanel, 0));
    grid.addEventListener('pointerover', (e) => {
      if (e.pointerType === 'touch') return;
      const tile = e.target.closest('.tile');
      const id = tile && !tile.classList.contains('skel') ? tile.dataset.id : null;
      if (id === state.hoverId) return;
      state.hoverId = id;
      if (id) state.lastVia = 'hover';
      updatePanel();
    });
    grid.addEventListener('pointerleave', () => { state.hoverId = null; updatePanel(); });

    document.addEventListener('keydown', onGlobalKey);

    $('help-btn').addEventListener('click', openHelp);
    $('export-btn').addEventListener('click', exportLabels);
    $('refresh-btn').addEventListener('click', () => {
      refreshOverview(false);
      if (state.currentFolder && !state.pending) selectFolder(state.currentFolder.folder_name, { quiet: true });
    });
    $('start-btn').addEventListener('click', () => startNext());

    $('folder-search').addEventListener('input', UI.debounce((e) => { state.railQuery = e.target.value; renderRail(); }, 160));
    $('rail-filter').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-f]');
      if (!b) return;
      state.railFilter = b.dataset.f;
      UI.store.set('lbl-railf', state.railFilter);
      syncControls();
      renderRail();
    });
    $('folder-sort').addEventListener('change', (e) => { state.railSort = e.target.value; UI.store.set('lbl-sort', state.railSort); renderRail(); });
    $('folder-list').addEventListener('click', (e) => {
      const b = e.target.closest('.rail-item');
      if (b) selectFolder(b.dataset.folder);
    });

    $('view-filter').addEventListener('change', (e) => setViewFilter(e.target.value));
    $('select-page-btn').addEventListener('click', selectPage);
    $('clear-selection-btn').addEventListener('click', clearSelection);
    $('size-seg').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-size]');
      if (!b) return;
      state.size = b.dataset.size;
      UI.store.set('lbl-size', state.size);
      syncControls();
    });
    $('grid-page-size').addEventListener('change', (e) => {
      state.pageSize = parseInt(e.target.value, 10);
      UI.store.set('lbl-pagesize', state.pageSize);
      state.page = 1; state.focusId = null;
      renderGrid();
    });

    window.addEventListener('beforeunload', (e) => { if (state.pending) { e.preventDefault(); e.returnValue = ''; } });
  }

  document.addEventListener('DOMContentLoaded', () => {
    bindEvents();
    syncControls();
    Auth.ready.then((auth) => { applyAuth(auth); Auth.onChange(applyAuth); });
  });
})();
