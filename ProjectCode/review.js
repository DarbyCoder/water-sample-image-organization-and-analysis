/**
 * Blind review (review.html).
 *
 * A labeler's label waits "in review" until one other labeler picks the same
 * label here without seeing it, or an admin reviews it; then it's official.
 * A different pick makes it "disputed", and an admin settles it on the
 * Disputed tab. An admin's own label is official straight away.
 *
 * The rules live in the database (supabase/migrations/006_blind_review.sql:
 * review_queue, review_counts, submit_review, disputed_list, resolve_dispute);
 * demo.js answers the same calls on sample data. Signed-in labelers and admins
 * can review; anyone else is told what they need.
 */
(function () {
  'use strict';

  const h = UI.h;
  const $ = (id) => document.getElementById(id);
  const fmt = (n) => Number(n).toLocaleString();

  const state = {
    actor: null,
    isAdmin: false,
    counts: null,
    queue: [],
    index: 0,
    skipped: new Set(),
    disputes: [],
    tab: 'review',
    result: null,      // the last review's outcome, shown until "Next image"
    busy: false,
  };
  let picker = null;

  async function rpc(name, args) {
    const { data, error } = await sb.rpc(name, args || {});
    if (error) throw error;
    return data;
  }

  // 1. Loading -----------------------------------------------------------------

  let lastKey = null;

  // Who is reviewing: the demo's acting person, or your account and its role.
  async function boot(auth) {
    const role = (auth && auth.profile && auth.profile.role) || 'viewer';
    const actor = window.APP_DEMO ? Demo.actor()
      : auth && auth.user ? { id: auth.user.id, role } : null;
    const key = actor ? `${actor.id}|${actor.role}` : 'anon';
    if (key === lastKey) return;
    lastKey = key;
    state.actor = actor;
    state.isAdmin = !!actor && ['owner', 'admin'].includes(actor.role);
    if (!window.sb) return blocked('Couldn’t reach the database', 'The Supabase library didn’t load. Reload the page.');
    if (!actor) return blocked('Sign in to review labels', 'Blind review is for labelers and admins.', h('button', { type: 'button', class: 'btn btn-primary', onclick: () => Auth.openSignIn('signin') }, UI.icon('log-in'), 'Sign in'));
    if (!['owner', 'admin', 'labeler'].includes(actor.role)) {
      return blocked('Reviewing needs the labeler role', 'Your account can browse but not label or review. Ask for the labeler role on the Admin page.',
        h('a', { class: 'btn btn-primary', href: 'admin.html' }, UI.icon('shield'), 'Request the labeler role'));
    }
    $('review-blocked').hidden = true;
    $('review-app').hidden = false;
    $('tab-disputed').hidden = !state.isAdmin;
    if (!state.isAdmin && state.tab === 'disputed') state.tab = 'review';
    await Labels.ready;
    await reload();
  }

  function blocked(title, text, action) {
    $('review-app').hidden = true;
    const body = $('review-blocked-body');
    body.innerHTML = '';
    body.append(h('h2', { text: title }), h('p', { text }));
    if (action) body.appendChild(h('p', {}, action));
    if (!window.APP_DEMO) body.appendChild(h('p', { class: 'text-muted' }, 'Or try it on sample data in the ', h('a', { href: 'review.html?demo', text: 'demo' }), '.'));
    $('review-blocked').hidden = false;
  }

  const isMissingSchema = (err) => /PGRST202|PGRST205|schema cache|does not exist|Could not find/i.test(`${err && err.code} ${err && err.message}`);

  async function reload() {
    try {
      const [counts, queue, disputes] = await Promise.all([
        rpc('review_counts'),
        rpc('review_queue'),
        state.isAdmin ? rpc('disputed_list') : Promise.resolve([]),
      ]);
      state.counts = counts;
      state.queue = queue.filter(r => !state.skipped.has(r.image_id)).concat(queue.filter(r => state.skipped.has(r.image_id)));
      state.disputes = disputes;
      state.index = 0;
      renderCounts();
      renderTab();
    } catch (err) {
      if (isMissingSchema(err)) {
        return blocked('Blind review isn’t switched on for this site yet',
          'The database needs supabase/migrations/006_blind_review.sql. Whoever holds the database password can add it with: python deploy/apply_migrations.py');
      }
      $('panel-review').innerHTML = '';
      $('panel-review').appendChild(h('div', { class: 'alert alert-error', role: 'alert' }, UI.icon('alert'),
        h('div', { class: 'alert-body' }, h('strong', { text: 'Couldn’t load the review queue.' }), h('p', { text: err.message || String(err) }))));
    }
  }

  function renderCounts() {
    const c = state.counts;
    const dl = $('review-counts');
    dl.innerHTML = '';
    const item = (label, value, cls) => dl.appendChild(h('div', { class: `review-count ${cls || ''}` }, h('dt', { text: label }), h('dd', { text: fmt(value) })));
    item('For you to review', c.to_review, 'is-you');
    item('In review', c.in_review, 'is-review');
    item('Disputed', c.disputed, 'is-disputed');
    item('Official', c.official, 'is-official');
    if (c.mine_waiting) item('Your labels waiting', c.mine_waiting, '');
    $('count-review').textContent = fmt(c.to_review);
    $('count-disputed').textContent = fmt(c.disputed);
  }

  // 2. Tabs --------------------------------------------------------------------------

  function setTab(tab) {
    state.tab = tab;
    renderTab();
  }

  function renderTab() {
    const review = state.tab === 'review';
    $('tab-review').setAttribute('aria-selected', String(review));
    $('tab-disputed').setAttribute('aria-selected', String(!review));
    $('panel-review').hidden = !review;
    $('panel-disputed').hidden = review;
    if (review) renderReview(); else renderDisputes();
  }

  // 3. To review: one image at a time, label hidden ------------------------------------

  function current() { return state.queue[state.index] || null; }

  function renderReview() {
    const panel = $('panel-review');
    panel.innerHTML = '';
    if (picker) { picker.destroy(); picker = null; }
    const item = current();
    if (!item) {
      panel.appendChild(h('div', { class: 'empty-state review-empty' }, UI.icon('check-circle'),
        h('strong', { text: 'Nothing for you to review right now' }),
        h('span', { text: (state.counts && state.counts.mine_waiting
          ? `${fmt(state.counts.mine_waiting)} of your labels are waiting for another labeler. `
          : 'New labels from other labelers show up here. ')
          + (window.APP_DEMO ? 'In the demo, switch “Acting as” (bottom of the page) to play someone else.' : '') }),
        h('a', { class: 'btn btn-sm', href: 'labeling.html' }, UI.icon('tag'), 'Go to labeling')));
      return;
    }

    const img = h('img', { src: UI.imageUrl(item.relative_path), alt: `Image ${item.filename}`, decoding: 'async' });
    img.addEventListener('error', () => img.classList.add('broken'), { once: true });
    const media = h('button', { type: 'button', class: 'review-media', title: 'Open larger', 'aria-label': `Open ${item.filename} larger` }, img, h('span', { class: 'review-zoom' }, UI.icon('maximize')));
    media.addEventListener('click', () => openLarge(item, media));

    const meta = h('div', { class: 'review-meta' },
      h('p', { class: 'eyebrow', text: `Image ${fmt(state.index + 1)} of ${fmt(state.queue.length)}` }),
      h('h2', { class: 'review-file', text: item.filename }),
      h('p', { class: 'text-muted', text: [item.folder_name, item.width ? `${item.width} × ${item.height} px` : null].filter(Boolean).join(' · ') }));

    const side = h('div', { class: 'review-side' }, meta);
    if (state.result && state.result.id === item.image_id) {
      side.appendChild(resultCard(state.result));
    } else {
      picker = Labels.picker({
        label: 'Your label for this image',
        placeholder: 'What is it? e.g. Microcystis',
        onPick: (option) => submit(item, option.value),
        onEscape: () => picker.input.blur(),
      });
      side.appendChild(h('div', { class: 'review-ask' },
        h('h3', { text: 'What do you see?' }),
        h('p', { class: 'text-muted', text: 'The label it was given is hidden. Choose the one you would give it.' }),
        picker.el,
        h('div', { class: 'review-actions' },
          h('button', { type: 'button', class: 'btn btn-sm btn-ghost', onclick: () => skip() }, UI.icon('skip-forward'), 'Skip for now'))));
    }
    panel.appendChild(h('div', { class: 'review-layout' }, media, side));
    if (picker) picker.focus();
    else { const next = panel.querySelector('.review-next'); if (next) next.focus(); }
  }

  function resultCard(r) {
    const match = r.outcome === 'official';
    const corrected = r.outcome === 'corrected';
    const kind = match ? 'is-match' : corrected ? 'is-corrected' : 'is-different';
    const title = match ? 'Match: it’s official now' : corrected ? 'Official, with your label' : 'Different: sent to an admin';
    // Never who gave the first label: reviewers stay blind to people, not just labels.
    const body = match
      ? `The labeler chose ${r.chosen} too.`
      : corrected
        ? `The labeler chose ${r.first_label}. As an admin, your ${r.chosen} is the official label.`
        : `The labeler chose ${r.first_label}; you chose ${r.chosen}. An admin will settle it.`;
    return h('div', { class: `review-result ${kind}`, role: 'status' },
      UI.icon(match || corrected ? 'check-circle' : 'flag'),
      h('div', {}, h('strong', { text: title }), h('p', { text: body }),
        h('button', { type: 'button', class: 'btn btn-sm btn-primary review-next', onclick: () => next() }, 'Next image', UI.icon('arrow-right'))));
  }

  async function submit(item, value) {
    if (state.busy) return;
    state.busy = true;
    try {
      const out = await rpc('submit_review', { target: item.image_id, chosen: value });
      state.result = Object.assign({ id: item.image_id, chosen: value }, out);
      state.counts = await rpc('review_counts');
      renderCounts();
      renderReview();
    } catch (err) {
      UI.toast({ message: `Couldn’t save your review: ${err.message || err}`, kind: 'error' });
      await reload();
    } finally {
      state.busy = false;
    }
  }

  // The queue comes 200 at a time, oldest first; fetch more once these are done.
  function next() {
    const done = state.result && state.result.id;
    state.result = null;
    if (done) state.queue = state.queue.filter(r => r.image_id !== done);
    if (!state.queue.length && state.counts && state.counts.to_review > 0) { reload(); return; }
    if (state.index >= state.queue.length) state.index = 0;
    renderReview();
  }

  function skip() {
    const item = current();
    if (!item) return;
    state.skipped.add(item.image_id);
    state.queue.splice(state.index, 1);
    state.queue.push(item);
    if (state.queue.length > 1 && state.queue[state.index] === item) state.index = (state.index + 1) % state.queue.length;
    renderReview();
  }

  function openLarge(item, originEl) {
    ImageViewer.open({
      items: [item], index: 0, folderName: item.folder_name, canLabel: false, originEl,
      lockedText: () => 'Label hidden for blind review',
    });
  }

  // 4. Disputed (admins): both labels shown, the admin picks ----------------------------

  function renderDisputes() {
    const panel = $('panel-disputed');
    panel.innerHTML = '';
    if (!state.disputes.length) {
      panel.appendChild(h('div', { class: 'empty-state review-empty' }, UI.icon('check-circle'),
        h('strong', { text: 'No disputes' }), h('span', { text: 'When a reviewer picks a different label than the labeler, the image shows up here for you to decide.' })));
      return;
    }
    panel.appendChild(h('p', { class: 'text-muted dispute-help', text: 'Two people disagreed on each of these. Choose one of their labels, or pick another. Your choice is official.' }));
    const list = h('ul', { class: 'dispute-list' });
    state.disputes.forEach(d => list.appendChild(disputeCard(d)));
    panel.appendChild(list);
  }

  function disputeCard(d) {
    const img = h('img', { src: UI.imageUrl(d.relative_path), alt: `Image ${d.filename}`, loading: 'lazy' });
    const choice = (label, who) => {
      const b = h('button', { type: 'button', class: 'dispute-choice', onclick: () => resolve(d, label) },
        Labels.chip(label), h('span', { class: 'dispute-who', text: `by ${who}` }));
      return b;
    };
    const otherHost = h('div', { class: 'dispute-other', hidden: true });
    const otherBtn = h('button', { type: 'button', class: 'btn btn-sm btn-ghost', onclick: () => {
      otherBtn.hidden = true;
      otherHost.hidden = false;
      const p = Labels.picker({ label: `Another label for ${d.filename}`, onPick: (o) => resolve(d, o.value), onEscape: () => { otherHost.hidden = true; otherBtn.hidden = false; } });
      p.el.style.setProperty('--lp-max', '12rem');
      otherHost.appendChild(p.el);
      p.focus();
    } }, UI.icon('tag'), 'Something else');
    return h('li', { class: 'dispute-card', 'data-id': d.image_id },
      h('button', { type: 'button', class: 'dispute-media', 'aria-label': `Open ${d.filename} larger`, onclick: (e) => ImageViewer.open({ items: [Object.assign({}, d, { label: d.first_label })], index: 0, folderName: d.folder_name, canLabel: false, originEl: e.currentTarget }) }, img),
      h('div', { class: 'dispute-body' },
        h('p', { class: 'dispute-file' }, h('strong', { text: d.filename }), h('span', { class: 'text-muted', text: ` · ${d.folder_name}` })),
        h('div', { class: 'dispute-choices' }, choice(d.first_label, d.first_by), h('span', { class: 'dispute-vs', text: 'or' }), d.review_label ? choice(d.review_label, d.review_by) : null),
        otherBtn, otherHost));
  }

  async function resolve(d, value) {
    if (state.busy) return;
    state.busy = true;
    try {
      await rpc('resolve_dispute', { target: d.image_id, chosen: value });
      UI.toast({ message: `Settled: ${d.filename} is officially ${Labels.text(value)}.`, kind: 'success' });
      state.disputes = state.disputes.filter(x => x.image_id !== d.image_id);
      state.counts = await rpc('review_counts');
      renderCounts();
      renderDisputes();
    } catch (err) {
      UI.toast({ message: `Couldn’t settle it: ${err.message || err}`, kind: 'error' });
    } finally {
      state.busy = false;
    }
  }

  // 5. Wiring ---------------------------------------------------------------------------

  document.addEventListener('DOMContentLoaded', () => {
    $('tab-review').addEventListener('click', () => setTab('review'));
    $('tab-disputed').addEventListener('click', () => setTab('disputed'));
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || !state.result) return;
      const tag = ((e.target && e.target.tagName) || '').toLowerCase();
      if (tag === 'button' || tag === 'input') return;
      e.preventDefault();
      next();
    });
    Auth.ready.then((auth) => { boot(auth); Auth.onChange(boot); });
  });
})();
