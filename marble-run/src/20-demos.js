
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
 *  the demo is solved here instead, and verified again. Unverified demos still load, flagged
 *  `verified: false`, and a warning names the misses.
 * ========================================================================== */
const VERIFY_TOL = 0.006;
const MarbleDemos = (() => {
  const sources = [], cache = new Map();
  function addSource(src) {
    if (!src || !src.id) throw new Error('a demo source needs an id');
    const i = sources.findIndex((s) => s.id === src.id);
    if (i >= 0) sources.splice(i, 1, src); else sources.push(src);
    sources.sort((a, b) => (a.order ?? 50) - (b.order ?? 50));
    for (const d of defsOf(src)) cache.delete(d.id);
    if (typeof onDemosChanged === 'function') onDemosChanged();
    return src;
  }
  function removeSource(id) {
    const i = sources.findIndex((s) => s.id === id);
    if (i < 0) return false;
    for (const d of defsOf(sources[i])) cache.delete(d.id);
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
  function build(id) {
    if (cache.has(id)) { const c = cache.get(id); return c === FAILED ? null : c; }
    const def = get(id);
    if (!def) return null;
    const norm = (r) => (r && r.layout && r.targets ? { layout: r.layout, targets: r.targets.map((x) => ({ t: x.t, note: x.note, voice: x.voice || 0 })).sort((a, b) => a.t - b.t) } : null);
    let res = null, report = null, source = 'data';
    try {
      res = norm(def.layout && def.targets ? def : typeof def.data === 'function' ? def.data() : null);
      if (res) report = verify(res.layout, res.targets);
      if ((!res || !report.ok) && typeof def.build === 'function') { res = norm(def.build()); source = 'solved'; report = res && verify(res.layout, res.targets); }
    } catch (e) { console.warn('demo ' + id + ' failed to build: ' + (e && e.message)); res = null; }
    if (!res || !report) { cache.set(id, FAILED); return null; }
    const targets = res.targets;
    if (!report.ok) console.warn('demo ' + id + ' is not note-perfect here: ' + JSON.stringify(report.firstMisses));
    const out = { id, title: def.title, subtitle: def.subtitle || '', layout: res.layout, targets, verified: report.ok, report, source, notes: report.notes, dropperVoice: report.dropperVoice };
    cache.set(id, out);
    return out;
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
  return { addSource, removeSource, list, get, build, cached, verify, matchNotes, get sources() { return sources.slice(); } };
})();
if (typeof window !== 'undefined') window.MarbleDemos = MarbleDemos;
