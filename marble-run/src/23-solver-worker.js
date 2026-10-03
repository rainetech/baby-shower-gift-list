
/* ============================================================================
 *  SOLVING IN THE BACKGROUND: a Worker built from the page's own script
 *  A baked tower is checked with CANON when a demo is first needed (20-demos.js).
 *  If it fails here (another browser's floating point, a changed CANON), the song
 *  is solved again with the same solver, which takes seconds (Ode to Joy ~4 s,
 *  Mountain King up to ~30 s: INTEGRATION.md). That must never freeze the page,
 *  so it runs on a Worker: the single-file page has no script to load, so the
 *  Worker's source is cut out of this page's own <script> text between the
 *  marker comments round CANON (src/04-, 05z-) and MarbleSolver (src/21az-,
 *  21bz-), which are byte-identical copies that run unchanged in a worker
 *  scope. Jobs run one at a time (a phone cannot solve ten songs at once).
 *  The songbook's demos get `solveAsync()` here; MarbleDemos.build calls it
 *  before the synchronous build() and keeps the demo 'solving' meanwhile.
 * ========================================================================== */
const SOLVER_WORKER = (() => {
  const script = typeof document !== 'undefined' ? document.currentScript : null;
  const M = (k) => '/*@@' + k + '@@*/';               // (built here so the marker never appears in this file's text)
  let src = null, tried = false, busy = false;
  const queue = [];
  function source() {
    if (tried) return src;
    tried = true;
    try {
      const t = (script && script.text) || '';
      const cut = (a, b) => { const i = t.indexOf(M(a)), j = t.indexOf(M(b)); return i >= 0 && j > i ? t.slice(i + M(a).length, j) : null; };
      const canon = cut('CANON:BEGIN', 'CANON:END'), solver = cut('SOLVER:BEGIN', 'SOLVER:END');
      if (canon && solver && typeof Worker !== 'undefined' && typeof Blob !== 'undefined' && typeof URL !== 'undefined' && URL.createObjectURL) {
        src = canon + '\n' + solver + '\nself.onmessage = function (e) { var d = e.data; try { var r = MarbleSolver.solveSong(d.song, CANON, { verify: false, hint: d.hint }); self.postMessage({ ok: true, layout: r.layout, targets: r.targets }); } catch (err) { self.postMessage({ ok: false, error: String((err && err.message) || err) }); } };\n';
      }
    } catch (e) { src = null; }
    return src;
  }
  const available = () => !!source();
  function next() {
    if (busy || !queue.length) return;
    const job = queue.shift();
    busy = true;
    let url = null, w = null;
    const end = () => { busy = false; try { if (w) w.terminate(); } catch (e) { /* gone */ } try { if (url) URL.revokeObjectURL(url); } catch (e) { /* gone */ } setTimeout(next, 0); };
    try {
      url = URL.createObjectURL(new Blob([source()], { type: 'text/javascript' }));
      w = new Worker(url);
    } catch (e) { end(); job.reject(e); return; }
    w.onmessage = (e) => { const d = e.data || {}; end(); if (d.ok) job.resolve({ layout: d.layout, targets: d.targets }); else job.reject(new Error(d.error || 'the solve failed')); };
    w.onerror = (e) => { end(); job.reject(new Error((e && e.message) || 'the solver worker failed')); };
    w.postMessage({ song: job.song, hint: job.hint });
  }
  // Solve `song` (opts.hint: the round that solved its baked tower, MarbleSolver.hintFrom) on a worker, queued:
  // a promise of { layout, targets }; null when workers are not available here
  function solve(song, hint) {
    if (!available()) return null;
    return new Promise((resolve, reject) => { queue.push({ song, hint, resolve, reject }); next(); });
  }
  return { solve, available, get queued() { return queue.length + (busy ? 1 : 0); } };
})();
// The songbook's demos (22-songbook.js, a copy of the solver's plugin) solve in the background
(function () {
  if (typeof MarbleDemos === 'undefined' || typeof MARBLE_SONGS === 'undefined' || typeof MarbleSolver === 'undefined') return;
  const src = MarbleDemos.sources.find((s) => s.id === 'songbook');
  if (!src || !Array.isArray(src.demos)) return;
  const baked = typeof MARBLE_DEMO_DATA !== 'undefined' ? MARBLE_DEMO_DATA : {};
  for (const d of src.demos) {
    const song = MARBLE_SONGS.find((s) => s.id === d.id);
    if (!song) continue;
    d.solveAsync = () => SOLVER_WORKER.solve(song, baked[d.id] && MarbleSolver.hintFrom ? MarbleSolver.hintFrom(baked[d.id].layout) : undefined);
  }
})();
