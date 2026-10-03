
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
        src = canon + '\n' + solver + '\nself.onmessage = function (e) { var d = e.data; if (d.hang) { for (;;) { /* (?dev test hook: a solve that never ends) */ } } try { var r = MarbleSolver.solveSong(d.song, CANON, { verify: false, hint: d.hint }); self.postMessage({ ok: true, layout: r.layout, targets: r.targets }); } catch (err) { self.postMessage({ ok: false, error: String((err && err.message) || err) }); } };\n';
      }
    } catch (e) { src = null; }
    return src;
  }
  const available = () => !!source();
  // How long one solve may take before it is given up (a hung or throttled worker must not hold the queue for the
  // session): 90 s, 3 minutes on a phone (a song takes seconds to about half a minute); ?dev: window.__mmSolveDeadline (ms)
  const deadline = () => (typeof DEV !== 'undefined' && DEV && window.__mmSolveDeadline) || (typeof GLR !== 'undefined' && GLR.mobile ? 180000 : 90000);
  function next() {
    if (busy || !queue.length) return;
    const job = queue.shift();
    busy = true;
    let url = null, w = null, timer = 0, over = false;
    const end = () => { over = true; clearTimeout(timer); busy = false; try { if (w) w.terminate(); } catch (e) { /* gone */ } try { if (url) URL.revokeObjectURL(url); } catch (e) { /* gone */ } setTimeout(next, 0); };
    // (ends the running job with an error: the deadline, or a cancel)
    job.abort = (err) => { if (over) return; end(); job.reject(err); };
    try {
      url = URL.createObjectURL(new Blob([source()], { type: 'text/javascript' }));
      w = new Worker(url);
    } catch (e) { end(); job.reject(e); return; }
    w.onmessage = (e) => { if (over) return; const d = e.data || {}; end(); if (d.ok) job.resolve({ layout: d.layout, targets: d.targets }); else job.reject(new Error(d.error || 'the solve failed')); };
    w.onerror = (e) => { if (over) return; end(); job.reject(new Error((e && e.message) || 'the solver worker failed')); };
    timer = setTimeout(() => job.abort(new Error('took too long')), deadline());
    w.postMessage({ song: job.song, hint: job.hint, hang: typeof DEV !== 'undefined' && DEV && !!window.__mmSolverHang });
  }
  // Solve `song` (opts.hint: the round that solved its baked tower, MarbleSolver.hintFrom) on a worker, queued:
  // a promise of { layout, targets } (it has .cancel(): leave the queue, or stop the worker that is running it);
  // null when workers are not available here
  function solve(song, hint) {
    if (!available()) return null;
    let job = null;
    const p = new Promise((resolve, reject) => { job = { song, hint, resolve, reject, abort: null }; queue.push(job); next(); });
    p.cancel = () => {
      const i = queue.indexOf(job);
      if (i >= 0) { queue.splice(i, 1); job.reject(new Error('cancelled')); } else if (job.abort) job.abort(new Error('cancelled'));
    };
    return p;
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
