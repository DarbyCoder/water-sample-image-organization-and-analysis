/**
 * Demo mode: the catalog and labeling running on made-up data. Turn it on by
 * adding ?demo to any page's address, and off with ?demo=0:
 *
 *   labeling.html?demo
 *   index.html?demo=0
 *
 * It swaps the data side of window.supabase for a small in-memory imitation
 * (the handful of calls the pages make) and generates microscope-style images
 * as SVG, so the labeling workflow can be tried -- or shown to the professor --
 * before the real database has the labeling migration, or offline. Anyone may
 * label the sample images, signed in or not. Labels are kept in the browser
 * tab's session storage; nothing is ever sent anywhere.
 *
 * Accounts stay real: sign-in, sign-out, the header and your role all come from
 * Supabase as usual, so entering or leaving the demo never signs you in or out.
 *
 * The 45 folders below are a real sample of the catalog's folder names.
 *
 * Blind review works here exactly as 006_blind_review.sql has it on the real
 * site: images.label is the official label only, and a labeler's label waits
 * in a separate pending list until one other labeler picks the same label on
 * the Review page without seeing it, or an admin reviews it. The functions
 * below (submit_labels, folder_pending, review_queue, ...) answer like the
 * real ones, so the pages run the same code in and out of the demo. The
 * pill's "Acting as" menu switches between sample people, to play several
 * labelers.
 */
(function () {
  'use strict';

  var FLAG = 'wsic-demo', DATA = 'wsic-demo-data-v3';  // v3: pending labels kept apart, as in 006_blind_review.sql

  function session(key, value) {
    try {
      if (value === undefined) return sessionStorage.getItem(key);
      if (value === null) sessionStorage.removeItem(key); else sessionStorage.setItem(key, value);
    } catch (e) { /* storage blocked: demo still works for this page */ }
    return null;
  }

  var params = new URLSearchParams(location.search);
  if (params.has('demo')) {
    var arg = params.get('demo');
    if (arg === '0' || arg === 'off') { session(FLAG, null); session(DATA, null); }
    else session(FLAG, '1');
  }
  if (session(FLAG) !== '1') return;
  window.APP_DEMO = true;

  // The real supabase-js (null if the CDN didn't load), kept for accounts.
  var realLib = window.supabase && window.supabase.createClient ? window.supabase : null;

  // ---------------------------------------------------------------------------
  // Data
  // ---------------------------------------------------------------------------

  // [folder_name, site, water_body, date, iso_date, magnification, code, capture, dilution, is_pp, images, minW, maxW, minH, maxH]
  var FOLDER_DATA = [
    ["Indian Lake_10.14.2023_10x_TM 0.5 dilution -pp","indian lake","lake","10.14.2023","2023-10-14","10x","TM","trigger","0.5",true,380,18,731,26,816],
    ["Indian_CR10.15.22_10x_AI1-pp-1","indian lake","lake","10.15.22","2022-10-15","10x","AI1","autoimage","",true,150,16,374,19,1089],
    ["Indian_WCMC_CR10.16.21_TR1-PP","indian lake","lake","10.16.21","2021-10-16","10x","TR1","trigger","",true,93,25,268,27,368],
    ["Coes Reservoir_10.14.2023_10x_TM 0.5 dilution -pp","coes reservoir","reservoir","10.14.2023","2023-10-14","10x","TM","trigger","0.5",true,65,24,358,26,571],
    ["CoesPond_WCMC_CR10.16.21_TR1-pp","coes reservoir","reservoir","10.16.21","2021-10-16","10x","TR1","trigger","",true,21,22,197,30,452],
    ["Coes Reservoir_10.2.2023_10x_TM 0.5 dilution -pp","coes reservoir","reservoir","10.2.2023","2023-10-02","10x","TM","trigger","0.5",true,71,23,462,29,640],
    ["Little Indian Lake_10.14.2023_10x_TM 0.1 dilution -pp","little indian lake","lake","10.14.2023","2023-10-14","10x","TM","trigger","0.1",true,38,26,211,25,270],
    ["LittleIndian_CR10.15.22_10x_AI1 .1dilution-pp","little indian lake","lake","10.15.22","2022-10-15","10x","AI1","autoimage","0.1",true,430,19,427,21,1038],
    ["LittleIndian_WCMC_CR10.16.21_TR1-PP","little indian lake","lake","10.16.21","2021-10-16","10x","TR1","trigger","",true,150,18,430,27,814],
    ["Cooks_CR10.15.22_10x_AI1-pp","cooks pond","pond","10.15.22","2022-10-15","10x","AI1","autoimage","",true,150,17,385,18,373],
    ["Cooks_WCMC_CR10.16.21_TR1-PP","cooks pond","pond","10.16.21","2021-10-16","10x","TR1","trigger","",true,40,27,321,28,712],
    ["Cooks_CR10.3.22_10x_AI1-pp","cooks pond","pond","10.3.22","2022-10-03","10x","AI1","autoimage","",true,150,20,343,19,347],
    ["Newton Pond_10.14.2023_10x_TM 0.5 dilution -pp","newton pond","pond","10.14.2023","2023-10-14","10x","TM","trigger","0.5",true,16,31,113,30,111],
    ["Newton_CR10.15.22_10x_AI1-pp","newton pond","pond","10.15.22","2022-10-15","10x","AI1","autoimage","",true,150,17,315,16,284],
    ["Newton_WCMC_CR10.16.21_TR1-PP","newton pond","pond","10.16.21","2021-10-16","10x","TR1","trigger","",true,45,23,229,28,342],
    ["Manchaug Pond_10.14.2023_10x_TM 0.5 dilution -pp","manchaug pond","pond","10.14.2023","2023-10-14","10x","TM","trigger","0.5",true,16,27,133,32,123],
    ["Manchaug_CR10.15.22_10x_AI1-pp","manchaug pond","pond","10.15.22","2022-10-15","10x","AI1","autoimage","",true,44,18,169,25,184],
    ["Manchaug_WCMC_CR10.16.21_TR1-PP","manchaug pond","pond","10.16.21","2021-10-16","10x","TR1","trigger","",true,16,27,113,30,131],
    ["Burncoat Pond_10.14.2023_10x_TM 0.1 dilution -pp","burncoat pond","pond","10.14.2023","2023-10-14","10x","TM","trigger","0.1",true,43,26,513,29,585],
    ["Burncoat_CR10.15.22_10x_AI1 .1 dilution-pp","burncoat pond","pond","10.15.22","2022-10-15","10x","AI1","autoimage","0.1",true,260,22,134,18,341],
    ["Burncoat_WCMC_CR10.16.21_TR1-PP","burncoat pond","pond","10.16.21","2021-10-16","10x","TR1","trigger","",true,150,18,660,24,1062],
    ["Green Hill Pond_10.14.2023_10x_TM 0.5 dilution -pp","green hill pond","pond","10.14.2023","2023-10-14","10x","TM","trigger","0.5",true,110,22,797,24,1050],
    ["GreenHill_CR10.15.22_10x_AI1 .1 dilution-pp","green hill pond","pond","10.15.22","2022-10-15","10x","AI1","autoimage","0.1",true,150,22,263,23,419],
    ["Green Hill Pond_10.2.2023_10x_TM 0.1 dilution -pp","green hill pond","pond","10.2.2023","2023-10-02","10x","TM","trigger","0.1",true,16,30,608,26,464],
    ["Patch Reservoir_10.14.2023_10x_TM 0.5 dilution -pp","patch reservoir","reservoir","10.14.2023","2023-10-14","10x","TM","trigger","0.5",true,78,26,258,25,239],
    ["Patch Res_10.2.2023_10x_TM 0.5 dilution -pp","patch reservoir","reservoir","10.2.2023","2023-10-02","10x","TM","trigger","0.5",true,51,27,398,29,488],
    ["Patch Res_10.30.2023_10x_TM 0.5 dilution-pp","patch reservoir","reservoir","10.30.2023","2023-10-30","10x","TM","trigger","0.5",true,30,29,171,28,258],
    ["Kiver Pond_10.14.2023_10x_TM 0.1 dilution -pp","kiver pond","pond","10.14.2023","2023-10-14","10x","TM","trigger","0.1",true,16,33,178,41,85],
    ["Kiver_CR10.15.22_10x_AI1 .1dilution-pp","kiver pond","pond","10.15.22","2022-10-15","10x","AI1","autoimage","0.1",true,138,21,163,24,304],
    ["Kiver_WCMC_CR10.16.21_TR2-PP","kiver pond","pond","10.16.21","2021-10-16","10x","TR2","trigger","",true,150,19,485,20,586],
    ["Patch Pond_10.14.2023_10x_TM 0.5 dilution -pp","patch pond","pond","10.14.2023","2023-10-14","10x","TM","trigger","0.5",true,26,23,223,27,251],
    ["PatchPond_CR10.15.22_10x_AI1-pp","patch pond","pond","10.15.22","2022-10-15","10x","AI1","autoimage","",true,150,18,262,22,425],
    ["Patch Pond_10.2.2023_10x_TM 0.5 dilution -pp","patch pond","pond","10.2.2023","2023-10-02","10x","TM","trigger","0.5",true,19,34,215,32,142],
    ["Salisbury Pond_10.14.2023_10x_TM 0.5 dilution -pp","salisbury pond","pond","10.14.2023","2023-10-14","10x","TM","trigger","0.5",true,150,24,499,22,960],
    ["Salisbury_WCMC_CR10.16.21_TR1-PP","salisbury pond","pond","10.16.21","2021-10-16","10x","TR1","trigger","",true,63,22,235,24,416],
    ["Salisbury Pond_10.2.2023_10x_TM 0.1 dilution -pp","salisbury pond","pond","10.2.2023","2023-10-02","10x","TM","trigger","0.1",true,20,21,161,33,202],
    ["Ecotarium Pond_10.14.2023_10x_TM 0.5 dilution -pp","ecotarium pond","pond","10.14.2023","2023-10-14","10x","TM","trigger","0.5",true,17,29,132,29,152],
    ["Ecotarium_CR10.3.22_10x AI1 0.1 dilution-pp","ecotarium pond","pond","10.3.22","2022-10-03","10x","AI1","autoimage","0.1",true,73,20,92,25,159],
    ["Ecotarium_5.15.2023_10X_TR1 0.1 dilution-pp","ecotarium pond","pond","5.15.2023","2023-05-15","10x","TR1","trigger","0.1",true,16,28,259,33,226],
    ["Stevens Pond_10.14.2023_10x_TM 0.5 dilution -pp","stevens pond","pond","10.14.2023","2023-10-14","10x","TM","trigger","0.5",true,16,38,139,34,109],
    ["Stevens_CR10.15.22_10x_AI1-pp","stevens pond","pond","10.15.22","2022-10-15","10x","AI1","autoimage","",true,36,21,97,27,100],
    ["Stevens_CR10.3.22_10x AI1-pp","stevens pond","pond","10.3.22","2022-10-03","10x","AI1","autoimage","",true,135,22,237,22,185],
    ["Farm_CR10.15.22_10x_AI1-pp","farm pond","pond","10.15.22","2022-10-15","10x","AI1","autoimage","",true,150,20,166,24,258],
    ["Farm Pond_10.30.2023_10x_TM 0.5 dilution -pp","farm pond","pond","10.30.2023","2023-10-30","10x","TM","trigger","0.5",true,16,43,105,45,93],
    ["Farm Pond_4.29.23_10x_TR1 no dilution-pp","farm pond","pond","4.29.23","2023-04-29","10x","TR1","trigger","1",true,16,42,96,33,132]
  ];

  function hashStr(s) {
    var h = 2166136261 >>> 0;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return h >>> 0;
  }
  function rng(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hex16(s) {
    var a = hashStr(s).toString(16), b = hashStr(s + '#').toString(16);
    return (('00000000' + a).slice(-8) + ('00000000' + b).slice(-8));
  }

  // --- procedural "microscope" images -----------------------------------------------

  var specCache = {};
  function specimen(relPath) {
    if (specCache[relPath]) return specCache[relPath];
    var seed = hashStr(relPath), r = rng(seed), roll = r();
    var cls = roll < 0.34 ? 'filament' : roll < 0.46 ? 'colony' : roll < 0.62 ? 'diatom' : roll < 0.74 ? 'other' : roll < 0.9 ? 'debris' : 'blank';
    var w, h;
    if (cls === 'filament') { w = 110 + Math.floor(r() * 200); h = 46 + Math.floor(r() * 110); }
    else if (cls === 'colony') { w = 70 + Math.floor(r() * 120); h = Math.max(60, w - 20 + Math.floor(r() * 40)); }
    else if (cls === 'diatom') { w = 64 + Math.floor(r() * 110); h = 28 + Math.floor(r() * 44); }
    else if (cls === 'other') { w = 54 + Math.floor(r() * 90); h = 54 + Math.floor(r() * 80); }
    else if (cls === 'debris') { w = 28 + Math.floor(r() * 130); h = 28 + Math.floor(r() * 110); }
    else { w = 44 + Math.floor(r() * 80); h = 40 + Math.floor(r() * 70); }
    var kinds = {
      filament: ['Aphanizomenon', 'Dolichospermum', 'Oscillatoria'], colony: ['Microcystis', 'Woronichinia'],
      diatom: ['Fragilaria', 'Centric Diatom'], other: ['Staurastrum', 'Dinobryon'],
      debris: ['Microcystis Debris', 'Unsure'], blank: ['Blank / empty'],
    }[cls];
    var truth = kinds[Math.floor(r() * kinds.length)];
    return (specCache[relPath] = { cls: cls, truth: truth, w: w, h: h, seed: seed });
  }

  function svgFor(spec) {
    var r = rng(spec.seed ^ 0x9e3779b9), w = spec.w, h = spec.h, s = [];
    var pick = function (arr) { return arr[Math.floor(r() * arr.length)]; };
    var f = function (n) { return n.toFixed(1); };
    var bg = pick(['#dad8d0', '#dddbd3', '#d4d3cc', '#e1dfd7']);
    s.push('<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '">');
    s.push('<defs><radialGradient id="v" cx=".5" cy=".5" r=".78"><stop offset=".5" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".18"/></radialGradient>'
      + '<filter id="b" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation="' + (Math.min(w, h) / 150).toFixed(2) + '"/></filter></defs>');
    s.push('<rect width="' + w + '" height="' + h + '" fill="' + bg + '"/>');
    for (var i = 0; i < 7; i++) s.push('<circle cx="' + f(r() * w) + '" cy="' + f(r() * h) + '" r="' + f(0.6 + r() * 1.6) + '" fill="#8d8b82" opacity=".16"/>');
    s.push('<g filter="url(#b)">');

    var cx = w / 2, cy = h / 2, k;
    if (spec.cls === 'filament') {
      var n = 10 + Math.floor(r() * 10), amp = h * (0.12 + r() * 0.18), freq = 0.8 + r() * 1.5, ph = r() * 6.28, cr = Math.max(2.4, h * (0.07 + r() * 0.03)), pts = [];
      var col = pick(['#4d8c5a', '#3f7d63', '#5a9a4e']);
      for (k = 0; k < n; k++) {
        var t = k / (n - 1);
        pts.push([w * (0.07 + t * 0.86), cy + (r() - 0.5) * 2 + Math.sin(t * freq * 6.283 + ph) * amp]);
      }
      s.push('<polyline fill="none" stroke="' + col + '" stroke-width="' + f(cr * 1.5) + '" stroke-linecap="round" stroke-linejoin="round" opacity=".85" points="' + pts.map(function (p) { return f(p[0]) + ',' + f(p[1]); }).join(' ') + '"/>');
      pts.forEach(function (p) {
        s.push('<circle cx="' + f(p[0]) + '" cy="' + f(p[1]) + '" r="' + f(cr) + '" fill="' + col + '" stroke="#2f5d3b" stroke-width=".6"/>');
        s.push('<circle cx="' + f(p[0] - cr * 0.25) + '" cy="' + f(p[1] - cr * 0.25) + '" r="' + f(cr * 0.38) + '" fill="#bfe3b3" opacity=".6"/>');
      });
    } else if (spec.cls === 'colony') {
      var R = Math.min(w, h) * (0.3 + r() * 0.1), cnt = 18 + Math.floor(r() * 24);
      s.push('<circle cx="' + f(cx) + '" cy="' + f(cy) + '" r="' + f(R * 1.18) + '" fill="#6fa56b" opacity=".16"/>');
      for (k = 0; k < cnt; k++) {
        var ang = r() * 6.283, d = Math.sqrt(r()) * R, rr = Math.max(2, R * (0.1 + r() * 0.08));
        s.push('<circle cx="' + f(cx + Math.cos(ang) * d) + '" cy="' + f(cy + Math.sin(ang) * d) + '" r="' + f(rr) + '" fill="#6ba66a" stroke="#3d6f47" stroke-width=".6" opacity=".92"/>');
      }
    } else if (spec.cls === 'diatom') {
      var a = w * 0.36, b = h * 0.2, rot = (r() - 0.5) * 36;
      s.push('<g transform="rotate(' + f(rot) + ' ' + f(cx) + ' ' + f(cy) + ')">');
      s.push('<ellipse cx="' + f(cx) + '" cy="' + f(cy) + '" rx="' + f(a) + '" ry="' + f(b) + '" fill="#d4b062" stroke="#8c6a26" stroke-width="1.4"/>');
      s.push('<line x1="' + f(cx - a * 0.9) + '" y1="' + f(cy) + '" x2="' + f(cx + a * 0.9) + '" y2="' + f(cy) + '" stroke="#8c6a26" stroke-width="1"/>');
      for (k = -5; k <= 5; k++) s.push('<line x1="' + f(cx + k * a * 0.16) + '" y1="' + f(cy - b * 0.82) + '" x2="' + f(cx + k * a * 0.16) + '" y2="' + f(cy + b * 0.82) + '" stroke="#8c6a26" stroke-width=".7" opacity=".7"/>');
      s.push('</g>');
    } else if (spec.cls === 'other') {
      var m = 7 + Math.floor(r() * 6), RR = Math.min(w, h) * 0.3;
      for (k = 0; k < m; k++) {
        var an = (k / m) * 6.283;
        s.push('<ellipse cx="' + f(cx + Math.cos(an) * RR) + '" cy="' + f(cy + Math.sin(an) * RR) + '" rx="' + f(RR * 0.42) + '" ry="' + f(RR * 0.26) + '" transform="rotate(' + f(an * 57.3) + ' ' + f(cx + Math.cos(an) * RR) + ' ' + f(cy + Math.sin(an) * RR) + ')" fill="#86b25e" stroke="#4f7a36" stroke-width=".8"/>');
      }
      s.push('<circle cx="' + f(cx) + '" cy="' + f(cy) + '" r="' + f(RR * 0.45) + '" fill="#a6c97f" stroke="#4f7a36" stroke-width=".8"/>');
    } else if (spec.cls === 'debris') {
      var v = 7 + Math.floor(r() * 6), pts2 = [], base = Math.min(w, h) * (0.26 + r() * 0.14), tone = pick(['#6a5948', '#5a626b', '#7a6a55']);
      for (k = 0; k < v; k++) {
        var a2 = (k / v) * 6.283, rr2 = base * (0.55 + r() * 0.75);
        pts2.push(f(cx + Math.cos(a2) * rr2 * 1.2) + ',' + f(cy + Math.sin(a2) * rr2));
      }
      s.push('<polygon points="' + pts2.join(' ') + '" fill="' + tone + '" stroke="#3a3a3a" stroke-width="1" opacity=".92"/>');
      for (k = 0; k < 3; k++) s.push('<circle cx="' + f(r() * w) + '" cy="' + f(r() * h) + '" r="' + f(1 + r() * 2.5) + '" fill="' + tone + '" opacity=".7"/>');
    } else {
      for (k = 0; k < 4; k++) s.push('<circle cx="' + f(r() * w) + '" cy="' + f(r() * h) + '" r="' + f(1 + r() * 2) + '" fill="#9a988e" opacity=".28"/>');
      s.push('<ellipse cx="' + f(cx) + '" cy="' + f(cy) + '" rx="' + f(w * 0.3) + '" ry="' + f(h * 0.16) + '" fill="#bdbbb0" opacity=".25"/>');
    }
    s.push('</g><rect width="100%" height="100%" fill="url(#v)"/></svg>');
    return s.join('');
  }

  var urlCache = {};
  function imageUrl(relPath) {
    if (!urlCache[relPath]) urlCache[relPath] = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgFor(specimen(relPath)));
    return urlCache[relPath];
  }

  // --- folders, images, people ---------------------------------------------------------

  // Made-up people; the admin page lists them alongside your real account.
  var USERS = [
    { id: 'demo-admin-2', email: 'jordan.reyes@example.com', full_name: 'Jordan Reyes', provider: 'google', role: 'admin', created_at: '2026-09-02T14:10:00Z', last_sign_in_at: '2026-10-03T15:22:00Z' },
    { id: 'demo-labeler-2', email: 'avery.lin@example.com', full_name: 'Avery Lin', provider: 'google', role: 'labeler', created_at: '2026-09-04T16:45:00Z', last_sign_in_at: '2026-10-02T21:08:00Z' },
    { id: 'demo-labeler-3', email: 'sam.okafor@example.com', full_name: 'Sam Okafor', provider: 'email', role: 'labeler', created_at: '2026-09-06T12:20:00Z', last_sign_in_at: '2026-10-01T18:40:00Z' },
    { id: 'demo-viewer-2', email: 'riley.chen@example.com', full_name: 'Riley Chen', provider: 'google', role: 'viewer', created_at: '2026-09-25T08:05:00Z', last_sign_in_at: '2026-09-30T13:12:00Z' },
  ];

  var folders = FOLDER_DATA.map(function (d) {
    return {
      folder_name: d[0], site_raw: d[1], site_normalized: d[1], water_body_type: d[2], date: d[3], sample_date: d[4],
      magnification: d[5], sample_code: d[6], capture_mode: d[7], dilution: d[8], is_pp: d[9], pp_of_folder: null,
      image_count: d[10], unreadable_count: 0, min_width: d[11], max_width: d[12], min_height: d[13], max_height: d[14],
    };
  });

  var stored = {};
  try { stored = JSON.parse(session(DATA) || '{}'); } catch (e) { stored = {}; }
  stored.labels = stored.labels || {};   // image_id -> [label, by, iso date]
  stored.roles = stored.roles || {};     // user id -> role
  // The label list: 005_label_options.sql's starting labels, then any added here.
  var BUILTIN_LABELS = [
    ['Aphanizomenon', 'cyanobacteria'], ['Dolichospermum', 'cyanobacteria'], ['Microcystis', 'cyanobacteria'],
    ['Oscillatoria', 'cyanobacteria'], ['Woronichinia', 'cyanobacteria'], ['Microcystis Debris', 'cyanobacteria'],
    ['Staurastrum', 'other_significant'], ['Fragilaria', 'other_significant'], ['Dinobryon', 'other_significant'],
    ['Centric Diatom', 'other_significant'], ['Blank / empty', 'non_organism'], ['Unsure', 'non_organism'],
  ];
  stored.labelOptions = stored.labelOptions || BUILTIN_LABELS.map(function (l) {
    return { name: l[0], category: l[1], is_builtin: true, created_by: null, created_at: '2026-09-01T12:00:00Z' };
  });
  var LABEL_CATEGORIES = ['cyanobacteria', 'other_significant', 'non_organism'];
  // Pending labels (006): image_id -> { label, by, at, status, review_label, review_by, review_at }.
  // The sample ones are made below; stored.pending holds changes (null: removed).
  stored.pending = stored.pending || {};
  var pending = {};
  stored.actAs = stored.actAs || null;   // a sample person's id, or null for you
  function labelOption(name) { return stored.labelOptions.filter(function (o) { return o.name === name; })[0] || null; }
  // user id -> latest role request; Riley starts with one waiting for review.
  stored.requests = stored.requests || {
    'demo-viewer-2': { requested_role: 'labeler', status: 'pending', requested_at: '2026-09-30T13:20:00Z', decided_at: null },
  };
  function persist() { session(DATA, JSON.stringify(stored)); }
  USERS.forEach(function (u) { if (stored.roles[u.id]) u.role = stored.roles[u.id]; });

  var images = [];
  folders.forEach(function (f, fi) {
    var fraction = fi % 7 === 0 ? 1 : fi % 3 === 0 ? 0.55 : fi % 5 === 1 ? 0.2 : 0;
    var slug = f.site_normalized.replace(/\s+/g, '_');
    for (var i = 0; i < f.image_count; i++) {
      var filename = slug + '_' + f.date.replace(/\./g, '-') + '_' + ('00000' + (i + 1)).slice(-5) + '.png';
      var rel = f.folder_name + '/' + filename;
      var spec = specimen(rel);
      var r = rng(hashStr(rel + 'label'));
      var row = {
        image_id: hex16(rel), folder_name: f.folder_name, filename: filename, relative_path: rel,
        width: spec.w, height: spec.h, file_size_bytes: Math.round(spec.w * spec.h * 1.1 + 900), format: 'PNG', mode: 'RGB',
        is_readable: true, source_dataset: 'demo', label: null, labeled_by: null, labeled_date: null,
      };
      if (r() < fraction) {
        var wrong = r() < 0.1;
        row.label = wrong ? ['Fragilaria', 'Microcystis Debris', 'Staurastrum', 'Unsure'][Math.floor(r() * 4)] : spec.truth;
        row.labeled_by = r() < 0.6 ? 'demo-labeler-2' : 'demo-labeler-3';
        row.labeled_date = new Date(Date.now() - Math.floor(r() * 12 * 86400000) - 3600000).toISOString();
        // Most sample labels are already official; some wait for review, a few are disputed.
        var roll = r(), other = row.labeled_by === 'demo-labeler-2' ? 'demo-labeler-3' : 'demo-labeler-2';
        if (roll >= 0.55) {
          var p = { label: row.label, by: row.labeled_by, at: row.labeled_date, status: roll < 0.92 ? 'in_review' : 'disputed',
            review_label: null, review_by: null, review_at: null };
          if (p.status === 'disputed') {
            var alt = ['Microcystis', 'Unsure', 'Fragilaria', 'Dolichospermum'].filter(function (x) { return x !== row.label; });
            p.review_label = alt[Math.floor(r() * alt.length)]; p.review_by = other; p.review_at = row.labeled_date;
          }
          pending[row.image_id] = p;
          row.label = null; row.labeled_by = null; row.labeled_date = null;
        }
      }
      var s = stored.labels[row.image_id];
      if (s) { row.label = s[0]; row.labeled_by = s[1]; row.labeled_date = s[2]; }
      if (row.image_id in stored.pending) {
        if (stored.pending[row.image_id]) pending[row.image_id] = stored.pending[row.image_id];
        else delete pending[row.image_id];
      }
      images.push(row);
    }
  });

  // A sample of the FlowCam measurements (the real database has 64), made up
  // from each image's size so that the size filters pick sensible images.
  // [column, label, unit, group, sort order, value(measurements so far, image, random)],
  // listed so each value comes after the ones it's made from.
  var MEASURE_DEFS = [
    ['particle_length', 'Length', 'µm', 'Size', 13, function (m, x, r) { return Math.max(x.width, x.height) * 0.55 * (0.85 + 0.3 * r()); }],
    ['particle_width', 'Width', 'µm', 'Size', 14, function (m, x, r) { return Math.min(x.width, x.height) * 0.5 * (0.7 + 0.3 * r()); }],
    ['diameter_esd', 'Diameter (ESD)', 'µm', 'Size', 10, function (m) { return (m.particle_length + m.particle_width) * 0.47; }],
    ['area_abd', 'Area (ABD)', 'µm²', 'Size', 15, function (m) { return Math.PI / 4 * m.particle_length * m.particle_width * 0.8; }],
    ['biovolume_sphere', 'Biovolume (sphere)', 'µm³', 'Size', 23, function (m) { return Math.PI / 6 * Math.pow(m.diameter_esd, 3); }],
    ['width', 'Image width', 'px', 'Size', 26, function (m, x) { return x.width; }],
    ['height', 'Image height', 'px', 'Size', 27, function (m, x) { return x.height; }],
    ['aspect_ratio', 'Aspect ratio', null, 'Shape', 30, function (m) { return m.particle_width / m.particle_length; }],
    ['circularity', 'Circularity', null, 'Shape', 31, function (m, x, r) { return Math.min(1, 0.15 + 0.8 * m.aspect_ratio * r()); }],
    ['elongation', 'Elongation', null, 'Shape', 36, function (m, x, r) { return (1 / m.aspect_ratio) * (1 + 2 * r()); }],
    ['intensity', 'Intensity', null, 'Colour and intensity', 56, function (m, x, r) { return 110 + 60 * r(); }],
    ['transparency', 'Transparency', null, 'Colour and intensity', 59, function (m, x, r) { return 0.04 + 0.6 * r() * r(); }],
    ['ch1_peak', 'Ch1 peak', null, 'Fluorescence', 71, function (m, x, r) { return r() < 0.3 ? 0 : 3 + 2 * r(); }],
  ];
  images.forEach(function (x) {
    var r = rng(hashStr(x.relative_path + 'measure'));
    var m = {};
    MEASURE_DEFS.forEach(function (d) { m[d[0]] = d[5](m, x, r); });
    MEASURE_DEFS.forEach(function (d) {
      if (d[0] !== 'width' && d[0] !== 'height') x[d[0]] = Number(m[d[0]].toPrecision(7));
    });
  });
  var MEASURES = MEASURE_DEFS.map(function (d) {
    var values = images.map(function (x) { return x[d[0]]; }).sort(function (a, b) { return a - b; });
    var at = function (p) { return values[Math.round(p * (values.length - 1))]; };
    return {
      column_name: d[0], source_name: d[0], label: d[1], unit: d[2], group_name: d[3], sort_order: d[4],
      description: 'Demo: made-up values.', image_count: values.length,
      min_value: values[0], max_value: values[values.length - 1], p01: at(0.01), p99: at(0.99),
    };
  });

  // Make the folders' own size ranges agree with their generated images.
  folders.forEach(function (f) {
    var mine = images.filter(function (x) { return x.folder_name === f.folder_name; });
    f.min_width = Math.min.apply(null, mine.map(function (x) { return x.width; }));
    f.max_width = Math.max.apply(null, mine.map(function (x) { return x.width; }));
    f.min_height = Math.min.apply(null, mine.map(function (x) { return x.height; }));
    f.max_height = Math.max.apply(null, mine.map(function (x) { return x.height; }));
  });

  // ---------------------------------------------------------------------------
  // Views the real database computes
  // ---------------------------------------------------------------------------

  function groupSum(rows, keyFn, valFn) {
    var m = {};
    rows.forEach(function (r) { var k = keyFn(r); m[k] = (m[k] || 0) + valFn(r); });
    return m;
  }

  var views = {
    folders_visible: function () { return folders; },
    qa_log: function () {
      return [
        { id: 1, level: 'INFO', target: 'catalog', detail: 'Demo data: 45 folders sampled from the real catalog.' },
        { id: 2, level: 'WARN', target: 'Bell_CR9.12.22_10xTR1 1', detail: 'Raw folder kept: no -pp counterpart found.' },
        { id: 3, level: 'INFO', target: 'sites', detail: 'Site names merged: 6 spelling variants folded into their parent sites.' },
      ];
    },
    dashboard_stats: function () {
      var dates = folders.map(function (f) { return f.sample_date; }).sort();
      return [{
        total_folders: folders.length,
        total_images: folders.reduce(function (s, f) { return s + f.image_count; }, 0),
        unique_sites: new Set(folders.map(function (f) { return f.site_normalized; })).size,
        first_date: dates[0], last_date: dates[dates.length - 1],
        pp_folders: folders.filter(function (f) { return f.is_pp; }).length,
        raw_folders: folders.filter(function (f) { return !f.is_pp; }).length,
      }];
    },
    chart_site_counts: function () {
      var m = groupSum(folders, function (f) { return f.site_normalized; }, function (f) { return f.image_count; });
      return Object.keys(m).map(function (k) { return { site_normalized: k, image_count: m[k], folder_count: 1 }; })
        .sort(function (a, b) { return b.image_count - a.image_count || a.site_normalized.localeCompare(b.site_normalized); });
    },
    chart_date_counts: function () {
      var m = groupSum(folders, function (f) { return f.sample_date.slice(0, 7) + '-01'; }, function (f) { return f.image_count; });
      return Object.keys(m).sort().map(function (k) { return { month: k, image_count: m[k], folder_count: 1 }; });
    },
    chart_water_body_counts: function () {
      var m = groupSum(folders, function (f) { return f.water_body_type || 'Unknown'; }, function () { return 1; });
      return Object.keys(m).map(function (k) { return { water_body_type: k, folder_count: m[k], image_count: 0 }; })
        .sort(function (a, b) { return b.folder_count - a.folder_count || a.water_body_type.localeCompare(b.water_body_type); });
    },
    // images.label is the official label, so these count official labels only.
    labeling_stats: function () {
      var labeled = images.filter(function (x) { return x.label; });
      var who = new Set(labeled.map(function (x) { return x.labeled_by; }));
      var dates = labeled.map(function (x) { return x.labeled_date; }).sort();
      return [{
        total_images: images.length, labeled_images: labeled.length, unlabeled_images: images.length - labeled.length,
        pct_labeled: images.length ? Math.round(1000 * labeled.length / images.length) / 10 : 0,
        labeler_count: who.size, last_labeled_at: dates.length ? dates[dates.length - 1] : null,
      }];
    },
    label_counts: function () {
      var m = groupSum(images.filter(function (x) { return x.label; }), function (x) { return x.label; }, function () { return 1; });
      return Object.keys(m).map(function (k) { return { label: k, image_count: m[k] }; })
        .sort(function (a, b) { return b.image_count - a.image_count || a.label.localeCompare(b.label); });
    },
    // 006: a pending label on an unlabeled image counts as done here.
    folder_labeling_progress: function () {
      var m = groupSum(images.filter(function (x) { return x.label || pending[x.image_id]; }), function (x) { return x.folder_name; }, function () { return 1; });
      return folders.map(function (f) {
        var l = m[f.folder_name] || 0;
        return {
          folder_name: f.folder_name, site_normalized: f.site_normalized, image_count: f.image_count, labeled_count: l,
          unlabeled_count: f.image_count - l, pct_labeled: f.image_count ? Math.round(1000 * l / f.image_count) / 10 : 0,
        };
      }).sort(function (a, b) { return a.folder_name.localeCompare(b.folder_name); });
    },
    images: function () { return images; },
    // Like the real policy: admins read every request, anyone else only their own.
    role_requests: function () {
      var me = actor(), admin = isAdminRole(realRole());
      return Object.keys(stored.requests)
        .filter(function (id) { return admin || id === me.id; })
        .map(function (id) { return Object.assign({ user_id: id }, stored.requests[id]); });
    },
    measurement_columns: function () { return MEASURES; },
    label_options: function () { return stored.labelOptions; },
    profiles: function () { return []; },  // only used when the real client is missing (no one is signed in then)
  };

  // ---------------------------------------------------------------------------
  // Who is acting: your real account (auth.js), or a guest when signed out
  // ---------------------------------------------------------------------------

  var GUEST = { id: 'demo-guest', email: null };

  function signedIn() {
    var a = window.Auth && window.Auth.current();
    return a && a.user ? a : null;
  }
  // Who is acting: a sample person picked in the pill's "Acting as" menu, else
  // your real account, else a guest.
  function actingAs() { return stored.actAs ? USERS.filter(function (u) { return u.id === stored.actAs; })[0] || null : null; }
  function actor() { var p = actingAs(); if (p) return p; var a = signedIn(); return a ? a.user : GUEST; }
  // Your real admin role counts here; anyone else in the demo labels as a labeler.
  function actorRole() { var p = actingAs(); if (p) return p.role; var rr = realRole(); return isAdminRole(rr) ? rr : 'labeler'; }
  function actorRoleFor(id) {
    if (id) { var u = USERS.filter(function (x) { return x.id === id; })[0]; return u ? u.role : 'labeler'; }
    var rr = realRole(); return isAdminRole(rr) ? rr : 'labeler';
  }
  function personName(id) {
    if (id === GUEST.id) return 'Guest';
    var u = people().filter(function (x) { return x.id === id; })[0];
    return u ? (u.full_name || u.email || 'Someone') : 'Someone';
  }
  function realRole() { var a = signedIn(); return a ? ((a.profile && a.profile.role) || 'viewer') : null; }
  function isAdminRole(role) { return role === 'admin' || role === 'owner'; }
  var RANK = { viewer: 1, labeler: 2, admin: 3, owner: 4 };

  // The sample people, plus your real account at the top when you're signed in.
  function people() {
    var a = signedIn();
    if (!a) return USERS.slice();
    var meta = a.user.app_metadata || {};
    var now = new Date().toISOString();
    return [{
      id: a.user.id, email: a.user.email, full_name: (a.profile && a.profile.full_name) || null,
      provider: (meta.providers || [meta.provider || 'email']).join(','), role: realRole(),
      created_at: a.user.created_at || now, last_sign_in_at: a.user.last_sign_in_at || now,
    }].concat(USERS);
  }

  // ---------------------------------------------------------------------------
  // The query builder (the subset of supabase-js the pages use)
  // ---------------------------------------------------------------------------

  var failRate = parseFloat(params.get('fail') || '0') || 0;
  function delay() { return new Promise(function (res) { setTimeout(res, 70 + Math.random() * 110); }); }
  function err(message, code) { return { data: null, error: { message: message, code: code || 'DEMO', hint: null }, count: null }; }

  function Query(table, kind, args) {
    this.table = table; this.kind = kind || 'table'; this.args = args || {};
    this.filters = []; this.orders = []; this.window = null; this.cols = '*'; this.wantCount = false;
    this.mode = 'select'; this.patch = null; this.single_ = false; this.maybe_ = false;
  }
  var P = Query.prototype;
  P.select = function (cols, opts) { this.cols = cols || '*'; if (opts && opts.count === 'exact') this.wantCount = true; return this; };
  P.eq = function (c, v) { this.filters.push(function (r) { return r[c] === v; }); return this; };
  P.in = function (c, arr) { var set = new Set(arr); this.filters.push(function (r) { return set.has(r[c]); }); return this; };
  P.not = function (c, op, v) { if (op === 'is' && v === null) this.filters.push(function (r) { return r[c] != null; }); return this; };
  P.is = function (c, v) { if (v === null) this.filters.push(function (r) { return r[c] == null; }); return this; };
  P.gte = function (c, v) { this.filters.push(function (r) { return r[c] != null && r[c] >= v; }); return this; };
  P.lte = function (c, v) { this.filters.push(function (r) { return r[c] != null && r[c] <= v; }); return this; };
  P.order = function (c, o) { this.orders.push([c, !o || o.ascending !== false]); return this; };
  P.range = function (a, b) { this.window = [a, b]; return this; };
  P.limit = function (n) { this.window = [0, n - 1]; return this; };
  P.single = function () { this.single_ = true; return this; };
  P.maybeSingle = function () { this.maybe_ = true; return this; };
  P.update = function (values) { this.mode = 'update'; this.patch = values; return this; };
  P.insert = function (values) { this.mode = 'insert'; this.patch = values; return this; };
  P.then = function (resolve, reject) { return this.run().then(resolve, reject); };

  P.run = function () {
    var q = this;
    return delay().then(function () {
      if (q.kind === 'rpc') return q.runRpc();
      if (!views[q.table]) return err("Could not find the table 'public." + q.table + "' in the schema cache", 'PGRST205');
      if (q.mode === 'update') return q.runUpdate();
      if (q.mode === 'insert') return q.runInsert();

      var rows = views[q.table]().filter(function (r) { return q.filters.every(function (f) { return f(r); }); });
      return q.shape(rows);
    });
  };

  P.shape = function (rows) {
    var q = this;
    q.orders.slice().reverse().forEach(function (o) {
      rows = rows.slice().sort(function (a, b) {
        var x = a[o[0]], y = b[o[0]];
        if (x == null) x = ''; if (y == null) y = '';
        var c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
        return o[1] ? c : -c;
      });
    });
    var count = rows.length;
    if (q.window) rows = rows.slice(q.window[0], q.window[1] + 1);
    if (q.cols && q.cols !== '*') {
      var keys = q.cols.split(',').map(function (c) { return c.trim(); }).filter(Boolean);
      rows = rows.map(function (r) { var o = {}; keys.forEach(function (k) { o[k] = r[k]; }); return o; });
    } else {
      rows = rows.map(function (r) { return Object.assign({}, r); });
    }
    if (q.single_ || q.maybe_) {
      if (rows.length === 1) return { data: rows[0], error: null, count: count };
      if (q.maybe_ && rows.length === 0) return { data: null, error: null, count: 0 };
      return err('JSON object requested, multiple (or no) rows returned', 'PGRST116');
    }
    return { data: rows, error: null, count: q.wantCount ? count : null };
  };

  P.runUpdate = function () {
    var q = this;
    if (q.table !== 'images') return err('Updates are not supported on ' + q.table);
    if (failRate && Math.random() < failRate) return err('Simulated network failure (demo ?fail=' + failRate + ')', 'DEMO_FAIL');
    var keys = Object.keys(q.patch);
    if (keys.some(function (k) { return k !== 'label'; })) return err('permission denied for table images', '42501');
    var me = actor(), now = new Date().toISOString();
    // images_check_label (005): the label must be on the list.
    if (q.patch.label != null && !labelOption(q.patch.label)) {
      return { data: null, error: { message: 'Unknown label "' + q.patch.label + '"', code: '23503', hint: 'Add it with "Enter new label" first, or refresh the page.' }, count: null };
    }
    // 006: only admins write images.label directly; labelers use submit_labels.
    if (!isAdminRole(actorRole())) return { data: null, error: null, count: null };  // RLS: 0 rows, no error
    images.filter(function (r) { return q.filters.every(function (f) { return f(r); }); }).forEach(function (r) {
      setOfficial(r, q.patch.label == null ? null : q.patch.label, me.id);
    });
    persist();
    return { data: null, error: null, count: null };
  };

  // Adding a label (anyone may label in the demo, so anyone may add one).
  P.runInsert = function () {
    var q = this;
    if (q.table !== 'label_options') return err('permission denied for table ' + q.table, '42501');
    var keys = Object.keys(q.patch);
    if (keys.some(function (k) { return k !== 'name' && k !== 'category'; })) return err('permission denied for table label_options', '42501');
    var name = String(q.patch.name || '').trim().replace(/\s+/g, ' ');
    if (!name || name.length > 60) return err('new row for relation "label_options" violates check constraint', '23514');
    if (LABEL_CATEGORIES.indexOf(q.patch.category) < 0) return err('new row for relation "label_options" violates check constraint', '23514');
    if (labelOption(name)) return err('duplicate key value violates unique constraint "label_options_pkey"', '23505');
    var row = { name: name, category: q.patch.category, is_builtin: false, created_by: actor().id, created_at: new Date().toISOString() };
    stored.labelOptions.push(row);
    persist();
    return q.shape([row]);
  };

  function labelInUse(name) { return images.some(function (x) { return x.label === name; }); }

  // admin_update_label() / admin_delete_label() with 005's rules.
  function updateLabel(a) {
    if (!isAdminRole(realRole())) return err('Only admins can change labels', '42501');
    var o = labelOption(a.label_name);
    if (!o) return err('No label called "' + a.label_name + '"', 'P0002');
    if (LABEL_CATEGORIES.indexOf(a.new_category) < 0) return err('Invalid category "' + a.new_category + '"', '22023');
    var name = String(a.new_name || '').trim().replace(/\s+/g, ' ');
    if (!name) return err('A label needs a name', '22023');
    if (name !== o.name) {
      if (labelInUse(o.name)) return { data: null, error: { message: 'Images already use "' + o.name + '", so it can\'t be renamed', code: '22023', hint: 'You can still change its category.' } };
      if (labelOption(name)) return err('There is already a label called "' + name + '"', '23505');
    }
    // Pending labels follow a rename (006: on update cascade).
    Object.keys(pending).forEach(function (id) {
      if (pending[id].label === o.name) pending[id].label = name;
      if (pending[id].review_label === o.name) pending[id].review_label = name;
      savePending(id);
    });
    o.name = name;
    o.category = a.new_category;
    persist();
    return { data: null, error: null };
  }
  function deleteLabel(a) {
    if (!isAdminRole(realRole())) return err('Only admins can delete labels', '42501');
    var o = labelOption(a.label_name);
    if (!o) return err('No label called "' + a.label_name + '"', 'P0002');
    if (labelInUse(o.name)) return { data: null, error: { message: 'Images use "' + o.name + '", so it can\'t be deleted', code: '22023', hint: 'Relabel those images first.' } };
    if (Object.keys(pending).some(function (id) { return pending[id].label === o.name || pending[id].review_label === o.name; })) {
      return { data: null, error: { message: 'Labels waiting for review use "' + o.name + '", so it can\'t be deleted', code: '22023', hint: 'Review or settle those first.' } };
    }
    stored.labelOptions = stored.labelOptions.filter(function (x) { return x !== o; });
    persist();
    return { data: null, error: null };
  }

  // --- Blind review (006_blind_review.sql) -----------------------------------------------

  function imageById(id) { return images.filter(function (i) { return i.image_id === id; })[0] || null; }
  function savePending(id) { stored.pending[id] = pending[id] || null; }
  // Make `value` the official label, credited to `by`, and drop any pending label.
  function setOfficial(x, value, by) {
    if (value !== x.label) {
      x.label = value;
      x.labeled_by = value ? by : null;
      x.labeled_date = value ? new Date().toISOString() : null;
      stored.labels[x.image_id] = [x.label, x.labeled_by, x.labeled_date];
    }
    delete pending[x.image_id];
    savePending(x.image_id);
  }
  function blindRow(x) {
    return { image_id: x.image_id, folder_name: x.folder_name, filename: x.filename, relative_path: x.relative_path,
      width: x.width, height: x.height, file_size_bytes: x.file_size_bytes, format: x.format };
  }
  function pendingIds() { return Object.keys(pending); }

  var reviewRpc = {
    submit_labels: function (a, me) {
      var admin = isAdminRole(actorRole()), value = a.new_label == null ? null : a.new_label;
      if (value != null && !labelOption(value)) return { error: ['Unknown label "' + value + '"', '23503'] };
      if (failRate && Math.random() < failRate) return { error: ['Simulated network failure (demo ?fail=' + failRate + ')', 'DEMO_FAIL'] };
      var out = (a.image_ids || []).map(function (id) {
        var x = imageById(id), p = pending[id], outcome;
        if (!x) return { target: id, outcome: 'missing' };
        if (admin) {
          outcome = value === x.label && !p ? 'unchanged' : value == null ? 'cleared' : 'official';
          setOfficial(x, value, me.id);
        } else if (p && p.by !== me.id) outcome = 'locked';
        else if (value == null || value === x.label) {
          if (p) { delete pending[id]; savePending(id); outcome = 'withdrawn'; }
          else outcome = value == null && x.label ? 'not_allowed' : 'unchanged';
        } else if (p && p.label === value && p.status === 'in_review') outcome = 'unchanged';
        else {
          pending[id] = { label: value, by: me.id, at: new Date().toISOString(), status: 'in_review', review_label: null, review_by: null, review_at: null };
          savePending(id);
          outcome = 'in_review';
        }
        return { target: id, outcome: outcome };
      });
      persist();
      return out;
    },
    // A pending label is shown only to whoever gave it, and to admins.
    folder_pending: function (a, me) {
      var admin = isAdminRole(actorRole());
      return images.filter(function (x) { return x.folder_name === a.folder && pending[x.image_id]; }).map(function (x) {
        var p = pending[x.image_id];
        return { image_id: x.image_id, status: p.status, label: p.by === me.id || admin ? p.label : null, is_mine: p.by === me.id };
      });
    },
    review_queue: function (a, me) {
      return pendingIds().filter(function (id) { return pending[id].status === 'in_review' && pending[id].by !== me.id; })
        .sort(function (x, y) { return String(pending[x].at).localeCompare(String(pending[y].at)) || x.localeCompare(y); })
        .slice(0, a.max_rows || 200)
        .map(function (id) { return blindRow(imageById(id)); });
    },
    review_counts: function (a, me) {
      var ids = pendingIds();
      var n = function (f) { return ids.filter(function (id) { return f(pending[id]); }).length; };
      return {
        to_review: n(function (p) { return p.status === 'in_review' && p.by !== me.id; }),
        in_review: n(function (p) { return p.status === 'in_review'; }),
        disputed: n(function (p) { return p.status === 'disputed'; }),
        official: images.filter(function (x) { return x.label; }).length,
        mine_waiting: n(function (p) { return p.status === 'in_review' && p.by === me.id; }),
      };
    },
    // A match makes it official (credited to the labeler); a different pick makes it disputed.
    // An admin's pick is final. The answer never says who gave the first label.
    submit_review: function (a, me) {
      var x = imageById(a.target), p = pending[a.target];
      if (!labelOption(a.chosen)) return { error: ['Unknown label "' + a.chosen + '"', '23503'] };
      if (!x || !p || p.status !== 'in_review') return { error: ['This image isn’t waiting for review any more', 'P0002'] };
      if (p.by === me.id) return { error: ['You can’t review your own label', '42501'] };
      var outcome;
      if (isAdminRole(actorRole())) {
        outcome = a.chosen === p.label ? 'official' : 'corrected';
        setOfficial(x, a.chosen, a.chosen === p.label ? p.by : me.id);
      } else if (a.chosen === p.label) {
        outcome = 'official';
        setOfficial(x, a.chosen, p.by);
      } else {
        outcome = 'disputed';
        p.status = 'disputed'; p.review_label = a.chosen; p.review_by = me.id; p.review_at = new Date().toISOString();
        savePending(a.target);
      }
      persist();
      return { data: { outcome: outcome, first_label: p.label } };
    },
    // Admins only: both labels and who gave them.
    disputed_list: function (a, me) {
      if (!isAdminRole(actorRole())) return { error: ['Only admins can settle disputes', '42501'] };
      return pendingIds().filter(function (id) { return pending[id].status === 'disputed'; }).map(function (id) {
        var p = pending[id];
        return Object.assign(blindRow(imageById(id)), { first_label: p.label, first_by: personName(p.by), first_at: p.at,
          review_label: p.review_label, review_by: p.review_by ? personName(p.review_by) : null, review_at: p.review_at });
      });
    },
    resolve_dispute: function (a, me) {
      if (!isAdminRole(actorRole())) return { error: ['Only admins can settle disputes', '42501'] };
      if (!labelOption(a.chosen)) return { error: ['Unknown label "' + a.chosen + '"', '23503'] };
      var x = imageById(a.target), p = pending[a.target];
      if (!x || !p || p.status !== 'disputed') return { error: ['This image isn’t disputed any more', 'P0002'] };
      setOfficial(x, a.chosen, a.chosen === p.label ? p.by : a.chosen === p.review_label ? p.review_by : me.id);
      persist();
      return { data: null };
    },
  };

  // How much each person (and the guest) has labeled, as admin_labeling_by_user() returns it.
  function labelingByPerson() {
    var guest = { id: GUEST.id, email: null, full_name: 'Guest (not signed in)', role: 'viewer' };
    return people().concat([guest]).map(function (u) {
      var mine = images.filter(function (x) { return x.labeled_by === u.id; });
      var dates = mine.map(function (x) { return x.labeled_date; }).sort();
      return { id: u.id, email: u.email, full_name: u.full_name, role: u.role, labeled_count: mine.length, last_labeled_at: dates.length ? dates[dates.length - 1] : null };
    }).sort(function (x, y) { return y.labeled_count - x.labeled_count; });
  }

  // set_user_role() with 004_roles.sql's rules, on the made-up people only.
  function setRole(me, targetId, newRole) {
    if (!isAdminRole(realRole())) return err('Only admins can change roles', '42501');
    if (['admin', 'labeler', 'viewer'].indexOf(newRole) < 0) return err('Invalid role "' + newRole + '": must be admin, labeler or viewer', '22023');
    if (targetId === me.id) return err("Demo mode can't change your real account's role", 'DEMO');
    var target = USERS.filter(function (u) { return u.id === targetId; })[0];
    if (!target) return err('No user with id ' + targetId, 'P0002');
    if (target.role === 'admin' && realRole() !== 'owner') return err("Only the Owner can change another admin's role", '42501');
    target.role = newRole;
    stored.roles[target.id] = newRole;
    var req = stored.requests[target.id];
    if (req && req.status === 'pending' && RANK[newRole] >= RANK[req.requested_role]) {
      req.status = 'approved';
      req.decided_at = new Date().toISOString();
    }
    persist();
    return { data: null, error: null };
  }

  P.runRpc = function () {
    var name = this.table, a = this.args, me = actor(), admin = isAdminRole(realRole());
    var rows, req;
    if (name === 'my_labeling_count') {
      return { data: images.filter(function (x) { return x.labeled_by === me.id; }).length, error: null };
    }
    if (name === 'can_label') return { data: true, error: null };
    if (name === 'is_admin') return { data: admin, error: null };
    if (name === 'admin_list_users') {
      if (!admin) return err('Not authorized', '42501');
      rows = people().map(function (u) { return Object.assign({ avatar_url: null }, u); });
    } else if (name === 'admin_labeling_by_user') {
      if (!admin) return err('Not authorized', '42501');
      rows = labelingByPerson();
    } else if (name === 'team_labeling_progress') {
      // Anyone may label in the demo, so anyone may see this too. No emails, as for real.
      rows = labelingByPerson().filter(function (r) { return r.labeled_count > 0; }).map(function (r) {
        return { full_name: r.full_name, role: r.role, is_me: r.id === me.id, labeled_count: r.labeled_count, last_labeled_at: r.last_labeled_at };
      });
    } else if (reviewRpc[name]) {
      var out = reviewRpc[name](a || {}, me);
      if (Array.isArray(out)) { rows = out; }
      else if (out && out.error) return err(out.error[0], out.error[1]);
      else if (out && 'data' in out) return { data: out.data, error: null };
      else return { data: out, error: null };
    } else if (name === 'admin_update_label') {
      return updateLabel(a);
    } else if (name === 'admin_delete_label') {
      return deleteLabel(a);
    } else if (name === 'set_user_role') {
      return setRole(me, a.target, a.new_role);
    } else if (name === 'review_role_request') {
      if (!admin) return err('Only admins can review role requests', '42501');
      req = stored.requests[a.target];
      if (!req || req.status !== 'pending') return err('This account has no open role request', 'P0002');
      if (a.approve) return setRole(me, a.target, req.requested_role);
      req.status = 'declined';
      req.decided_at = new Date().toISOString();
      persist();
      return { data: null, error: null };
    } else if (name === 'request_role') {
      if (!signedIn()) return err('Sign in to request a role', '42501');
      if (a.requested !== 'admin' && a.requested !== 'labeler') return err('Invalid request "' + a.requested + '": you can ask for admin or labeler', '22023');
      if (RANK[realRole()] >= RANK[a.requested]) return err('You already have that role or a higher one', '22023');
      stored.requests[me.id] = { requested_role: a.requested, status: 'pending', requested_at: new Date().toISOString(), decided_at: null };
      persist();
      return { data: null, error: null };
    } else if (name === 'cancel_role_request') {
      req = stored.requests[me.id];
      if (req && req.status === 'pending') delete stored.requests[me.id];
      persist();
      return { data: null, error: null };
    } else {
      return err('Could not find the function public.' + name, 'PGRST202');
    }
    return this.shape(rows);
  };

  // ---------------------------------------------------------------------------
  // The client auth.js talks to: made-up data, real accounts
  // ---------------------------------------------------------------------------

  // Without supabase-js (offline, or blocked) nobody can sign in, but the
  // demo data still works.
  function noSignIn() {
    return Promise.resolve({ data: null, error: { message: 'Network error: the sign-in service did not load.' } });
  }
  var offlineAuth = {
    getSession: function () { return Promise.resolve({ data: { session: null }, error: null }); },
    onAuthStateChange: function () { return { data: { subscription: { unsubscribe: function () {} } } }; },
    signOut: function () { return Promise.resolve({ error: null }); },
    signInWithPassword: noSignIn, signInWithOAuth: noSignIn, signUp: noSignIn,
    resetPasswordForEmail: noSignIn, updateUser: noSignIn,
  };

  window.supabase = {
    createClient: function (url, key) {
      var real = null;
      try { real = realLib ? realLib.createClient(url, key) : null; } catch (e) { real = null; }
      return {
        // Your profile (and so your role) is read from the real database.
        from: function (t) { return t === 'profiles' && real ? real.from(t) : new Query(t); },
        rpc: function (name, args) { return new Query(name, 'rpc', args); },
        auth: real ? real.auth : offlineAuth,
      };
    },
  };

  // The measurement filter files (deploy/build_filter_data.py), made from the
  // sample images: folders by name, images in each by image_id.
  var filterOrder = null;
  function filterImages() {
    if (!filterOrder) {
      filterOrder = images.slice().sort(function (x, y) {
        return x.folder_name < y.folder_name ? -1 : x.folder_name > y.folder_name ? 1
          : x.image_id < y.image_id ? -1 : x.image_id > y.image_id ? 1 : 0;
      });
    }
    return filterOrder;
  }
  var filterData = {
    index: function () {
      var counts = groupSum(images, function (x) { return x.folder_name; }, function () { return 1; });
      return {
        version: 'demo', images: images.length,
        folders: Object.keys(counts).sort().map(function (f) { return [f, counts[f]]; }),
        columns: MEASURES.map(function (m) { return m.column_name; }),
      };
    },
    values: function (col) {
      return Float32Array.from(filterImages(), function (x) { return x[col] == null ? NaN : x[col]; });
    },
  };

  window.Demo = {
    imageUrl: imageUrl,
    filterData: filterData,
    guest: GUEST,  // who labels when no one is signed in
    // Who is acting now (a sample person, you, or the guest), with their demo role.
    actor: function () { var u = actor(); return { id: u.id, email: u.email || null, full_name: u.full_name || (u === GUEST ? 'Guest' : null), role: actorRole() }; },
    truth: function (relPath) { return specimen(relPath).truth; },
    reset: function () { session(DATA, null); location.reload(); },
    exit: function () { session(FLAG, null); session(DATA, null); },
  };

  // ---------------------------------------------------------------------------
  // The little pill that says "this is a demo"
  // ---------------------------------------------------------------------------

  document.addEventListener('DOMContentLoaded', function () {
    var pill = document.createElement('div');
    pill.className = 'demo-pill';
    pill.setAttribute('role', 'region');
    pill.setAttribute('aria-label', 'Demo mode');
    pill.innerHTML = '<span>Demo mode · sample data, nothing is saved</span>'
      + '<label class="demo-actor"><span>Acting as</span><select id="demo-actor"></select></label>'
      + '<a href="#" id="demo-reset">Reset</a><a href="?demo=0" id="demo-exit">Exit</a>';
    var sel = pill.querySelector('#demo-actor');
    var a = signedIn();
    var meText = (a ? (a.profile && a.profile.full_name) || a.user.email || 'You' : 'You (guest)') + ' · ' + actorRoleFor(null);
    [[null, meText]].concat(USERS.filter(function (u) { return u.role !== 'viewer'; }).map(function (u) { return [u.id, u.full_name + ' · ' + u.role]; }))
      .forEach(function (o) {
        var opt = document.createElement('option');
        opt.value = o[0] || '';
        opt.textContent = o[1];
        if ((o[0] || null) === stored.actAs) opt.selected = true;
        sel.appendChild(opt);
      });
    sel.addEventListener('change', function () { stored.actAs = sel.value || null; persist(); location.reload(); });
    // Your name arrives once the sign-in check finishes.
    if (window.Auth && window.Auth.ready) window.Auth.ready.then(function (auth) {
      if (!auth || !auth.user) return;
      sel.options[0].textContent = ((auth.profile && auth.profile.full_name) || auth.user.email || 'You') + ' · ' + actorRoleFor(null);
    });

    if (window.matchMedia && window.matchMedia('(max-width: 640px)').matches) document.body.insertBefore(pill, document.body.firstChild);
    else document.body.appendChild(pill);
    pill.querySelector('#demo-reset').addEventListener('click', function (e) { e.preventDefault(); window.Demo.reset(); });
  });
})();
