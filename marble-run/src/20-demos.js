
/* ============================================================================
 *  DEMOS: demo runs that play songs, as a small plug-in registry
 *
 *  A demo SOURCE is registered with MarbleDemos.addSource(source):
 *    source = { id, order?, demos: DemoDef[] }    (or { id, order?, list: () => DemoDef[] })
 *    order: sources are listed by it, lowest first (default 50). MarbleDemos.removeSource(id) drops a source.
 *    The songbook (22-songbook.js) is the source the app ships with.
 *    DemoDef = {
 *      id, title, subtitle?,                        // shown in the Demos gallery
 *      layout?, targets?  or  data() -> { layout, targets } | null   // precomputed (e.g. solved offline)
 *      build?() -> { layout, targets }              // solve here (used when there is no data, or it fails the check)
 *    }
 *    layout  = a Layout (see MODEL), droppers on { mode: 'times', times: [...] } schedules
 *    targets = [{ t, note, voice? }]  t = seconds after Play; voice 0 = melody, 1+ = accompaniment
 *  A demo is resolved once, lazily (when first needed), and cached. Precomputed data is VERIFIED here with
 *  CANON (the exact physics the app plays): every target played in order with the right pitch within
 *  VERIFY_TOL and no stray notes. If it fails (another browser's floating point) and the def has build(),
 *  the demo is solved here instead, and verified again: in the BACKGROUND when the def has solveAsync()
 *  (-> a promise of { layout, targets }; 23-solver-worker.js gives the songbook one), so the page never freezes
 *  while a tower is solved (seconds); the demo is 'solving' meanwhile (status(id); ready(id) is a promise of it;
 *  onDemoStatus(id, state, demo) is called when it is done) and build() returns null. Only a def without
 *  solveAsync() is solved here and now with build(). Unverified demos still load, flagged `verified: false`,
 *  and a warning names the misses; a background solve that fails keeps the baked data that way.
 * ========================================================================== */
const VERIFY_TOL = 0.006;
const MarbleDemos = (() => {
  const sources = [], cache = new Map();
  function addSource(src) {
    if (!src || !src.id) throw new Error('a demo source needs an id');
    const i = sources.findIndex((s) => s.id === src.id);
    if (i >= 0) sources.splice(i, 1, src); else sources.push(src);
    sources.sort((a, b) => (a.order ?? 50) - (b.order ?? 50));
    for (const d of defsOf(src)) { cache.delete(d.id); pending.delete(d.id); }
    if (typeof onDemosChanged === 'function') onDemosChanged();
    return src;
  }
  function removeSource(id) {
    const i = sources.findIndex((s) => s.id === id);
    if (i < 0) return false;
    for (const d of defsOf(sources[i])) { cache.delete(d.id); pending.delete(d.id); }
    sources.splice(i, 1);
    if (typeof onDemosChanged === 'function') onDemosChanged();
    return true;
  }
  function defsOf(src) { try { return (typeof src.list === 'function' ? src.list() : src.demos) || []; } catch (e) { console.warn('demo source ' + src.id + ': ' + e.message); return []; } }
  function list() {
    const out = [], seen = new Set();
    for (const s of sources) for (const d of defsOf(s)) if (d && d.id && !seen.has(d.id)) { seen.add(d.id); out.push(d); }
    return out;
  }
  function get(id) { return list().find((d) => d.id === id) || null; }
  // The demo's layout and targets, built on first use and verified with CANON. A demo that cannot be built is
  // remembered as failed (never retried in this session: a failing solve can take seconds).
  const FAILED = { failed: true };
  const pending = new Map(), waiters = new Map();    // demos being solved in the background: id -> { t0, why }
  const norm = (r) => (r && r.layout && r.targets ? { layout: r.layout, targets: r.targets.map((x) => ({ t: x.t, note: x.note, voice: x.voice || 0 })).sort((a, b) => a.t - b.t) } : null);
  function build(id) {
    if (cache.has(id)) { const c = cache.get(id); return c === FAILED ? null : c; }
    if (pending.has(id)) return null;
    const def = get(id);
    if (!def) return null;
    let res = null, report = null, source = 'data';
    try {
      res = norm(def.layout && def.targets ? def : typeof def.data === 'function' ? def.data() : null);
      if (res) report = verify(res.layout, res.targets);
      if (!res || !report.ok) {
        // the baked data fails here: solve the song again, in the background when the def can (the page stays
        // responsive; the demo is 'solving' until then), else here and now
        const p = typeof def.solveAsync === 'function' ? def.solveAsync() : null;
        if (p && typeof p.then === 'function') { startPending(id, def, p, res, report); return null; }
        if (typeof def.build === 'function') { res = norm(def.build()); source = 'solved'; report = res && verify(res.layout, res.targets); }
      }
    } catch (e) { console.warn('demo ' + id + ' failed to build: ' + (e && e.message)); res = null; }
    return settle(id, def, res, report, source);
  }
  function settle(id, def, res, report, source) {
    if (!res || !report) { cache.set(id, FAILED); return null; }
    const targets = res.targets;
    if (!report.ok) console.warn('demo ' + id + ' is not note-perfect here: ' + JSON.stringify(report.firstMisses));
    const out = { id, title: def.title, subtitle: def.subtitle || '', layout: res.layout, targets, verified: report.ok, report, source, notes: report.notes, dropperVoice: report.dropperVoice };
    cache.set(id, out);
    return out;
  }
  // A background solve: when it lands, the result is verified and cached like any other (a solve that is no
  // better, or fails, keeps the baked data, flagged); whoever waits (ready(), onDemoStatus) is told
  function startPending(id, def, promise, dataRes, dataReport) {
    const entry = { t0: Date.now(), why: dataRes ? 'the baked tower plays differently here: ' + JSON.stringify(dataReport.firstMisses) : 'no baked data' };
    console.warn('demo ' + id + ': ' + entry.why + '; solving it in the background');
    pending.set(id, entry);
    const done = (res, report, source) => {
      if (pending.get(id) !== entry) return;                 // (the source was replaced meanwhile: stale)
      pending.delete(id);
      const out = settle(id, def, res, report, source);
      const w = waiters.get(id) || [];
      waiters.delete(id);
      for (const f of w) { try { f(out); } catch (e) { console.warn(e); } }
      if (typeof onDemoStatus === 'function') onDemoStatus(id, out ? 'ready' : 'failed', out);
    };
    promise.then((r) => {
      let res = null, report = null;
      try { res = norm(r); report = res && verify(res.layout, res.targets); } catch (e) { console.warn('demo ' + id + ': the solve gave a bad result: ' + (e && e.message)); res = null; }
      if (res && report && report.ok) done(res, report, 'solved');
      else if (dataRes) done(dataRes, dataReport, 'data');
      else done(res, report, 'solved');
    }, (e) => {
      console.warn('demo ' + id + ' could not be solved here: ' + (e && e.message));
      if (dataRes) done(dataRes, dataReport, 'data'); else done(null, null, 'solved');
    });
  }
  // Where a demo stands: { state: 'ready' | 'solving' | 'failed' | 'new' | 'unknown', ... }
  function status(id) {
    const p = pending.get(id);
    if (p) return { state: 'solving', since: p.t0, elapsed: Date.now() - p.t0, why: p.why };
    if (cache.has(id)) { const c = cache.get(id); return c === FAILED ? { state: 'failed' } : { state: 'ready', verified: c.verified, source: c.source }; }
    return { state: get(id) ? 'new' : 'unknown' };
  }
  // A promise of the built demo (null when it cannot be built): builds it if need be, waits for a background solve
  function ready(id) {
    const c = build(id);
    if (c || !pending.has(id)) return Promise.resolve(c);
    return new Promise((resolve) => { const w = waiters.get(id) || []; w.push(resolve); waiters.set(id, w); });
  }
  // Only what is already built (never builds: for per-frame callers such as the music strip)
  function cached(id) { const c = cache.get(id); return c && c !== FAILED ? c : null; }
  // Play the layout from Play with CANON and match the notes against the targets (in order, same pitch, within tol).
  // The report keeps where each note was played ({ t, note, pieceId, x, y }, for the camera to follow) and which
  // voice each dropper's marbles play (dropperVoice: for the marbles' halos).
  function verify(layout, targets, tol = VERIFY_TOL) {
    const w = CANON.createWorld(layout);
    CANON.scheduleReleases(w, layout, 120);
    const end = targets.reduce((m, x) => Math.max(m, x.t), 0) + 4, drop = new Map();
    for (let i = 0, n = Math.round(end / CANON.SUBSTEP); i < n; i++) {        // (= CANON.simulate, step by step)
      CANON.step(w);
      for (const m of w.marbles) if (!drop.has(m.id)) drop.set(m.id, m.dropperId);
    }
    const r = matchNotes(w.notes, targets, tol);
    r.notes = w.notes.map((n) => ({ t: n.t, note: n.note, pieceId: n.pieceId, x: n.x, y: n.y }));
    r.dropperVoice = new Map();
    r.pair.forEach((k, i) => { const d = drop.get(w.notes[i].marbleId); if (k >= 0 && d && !r.dropperVoice.has(d)) r.dropperVoice.set(d, targets[k].voice || 0); });
    return r;
  }
  function matchNotes(played, targets, tol) {
    const used = new Array(played.length).fill(false), pair = new Array(played.length).fill(-1), misses = [];
    let matched = 0, maxErr = 0;
    targets.forEach((tg, k) => {
      let best = -1, bestErr = Infinity;
      for (let i = 0; i < played.length; i++) {
        if (used[i] || played[i].note !== tg.note) continue;
        const e = Math.abs(played[i].t - tg.t);
        if (e < bestErr) { bestErr = e; best = i; }
      }
      if (best >= 0 && bestErr <= tol) { used[best] = true; pair[best] = k; matched++; maxErr = Math.max(maxErr, bestErr); }
      else misses.push({ t: tg.t, note: tg.note });
    });
    const extras = played.filter((p, i) => !used[i]).map((p) => ({ t: p.t, note: p.note }));
    return { ok: !misses.length && !extras.length, matched, targets: targets.length, extras: extras.length, maxErr, firstMisses: misses.slice(0, 4), firstExtras: extras.slice(0, 4), pair };
  }
  return { addSource, removeSource, list, get, build, cached, status, ready, verify, matchNotes, get sources() { return sources.slice(); } };
})();
if (typeof window !== 'undefined') window.MarbleDemos = MarbleDemos;
