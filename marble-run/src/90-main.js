
/* ============================================================================
 *  MAIN: start-up, renderer choice, the frame loop and the test API
 * ========================================================================== */
const FXC = { canvas: document.getElementById('fx'), g: null };
FXC.g = FXC.canvas.getContext('2d');
let RENDER = null, rendererName = 'webgl2', glOk = false, restoreTimer = 0, clock = 0;
const loadingEl = $('#loading'), loadingBar = $('#loadingBar');

/* ---- 1) The layout: the autosave, else a small starter run that already plays. A shared link opens over it once
 *  the UI is up (so Undo and "Back to my run" lead back to your own run).
 *  Boot guard: while this page is on screen and has not drawn a good frame yet, 'marbleMusic.booting' holds a
 *  heartbeat (the time, renewed every second). The next boot reads it:
 *  - a fresh heartbeat: another tab is starting right now (on screen, not drawing yet), which is not a crash;
 *  - 'ended' (a boot that was left before it drew a good frame: its script stopped, or its frames kept failing) or a
 *    heartbeat gone quiet (a hang): that boot crashed, so the saved run is put aside in Recent (it opens again from
 *    there) and the starter run loads, with a notice.
 *  A page that is never given a frame (a background tab, a throttled frame) is not a crash: hidden, it holds no flag,
 *  and left without a single frame it takes its flag away. ---- */
const BOOT_KEY = 'marbleMusic.booting', BOOT_BEAT_MS = 1000, BOOT_QUIET_MS = 5000;
const BOOT = { shared: null, notice: '', noticeMenu: false, started: false, frames: 0, drawn: false, beat: 0 };
function bootArm() {
  if (BOOT.drawn || BOOT.beat || document.visibilityState === 'hidden') return;
  const beat = () => store.set(BOOT_KEY, String(Date.now()));
  beat();
  BOOT.beat = setInterval(beat, BOOT_BEAT_MS);
}
function bootDisarm(ended) {
  if (!BOOT.beat) return;
  clearInterval(BOOT.beat); BOOT.beat = 0;
  if (ended) store.set(BOOT_KEY, 'ended'); else store.del(BOOT_KEY);
}
function bootDrawn() { BOOT.drawn = true; bootDisarm(false); }            // (the first good frame)
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') bootDisarm(false); else bootArm(); });
window.addEventListener('pagehide', () => bootDisarm(!BOOT.started || BOOT.frames > 0));
window.addEventListener('pageshow', (e) => { if (e.persisted) bootArm(); });
// The autosave that crashed the last boot: out of the way of this one, and into Recent. Returns the notice.
function setAsideAutosave() {
  const raw = store.get(AUTO_KEY);
  if (!raw) return '';
  store.set(AUTO_KEY + '.bad', raw); store.del(AUTO_KEY);
  let L = null;
  try { L = JSON.parse(raw); } catch (e) { /* unreadable */ }
  if (!L || typeof L !== 'object' || !Array.isArray(L.pieces)) return L && L.demoId ? 'The last demo could not be opened here.' : 'Your last run could not be read.';
  if (!addRecent(L)) return 'Your last run could not be opened.';
  BOOT.noticeMenu = true;
  return 'Your last run could not be opened. It is kept under Save\u00a0›\u00a0Recent.';
}
function starterLayout() {
  if (typeof STARTER_LAYOUT !== 'undefined') return JSON.parse(JSON.stringify(STARTER_LAYOUT));   // (21-starter.js)
  return { v: 1, name: 'My marble run', tempo: 100, pieces: [
    { id: 'p1', type: 'dropper', x: 800, y: 100, schedule: { mode: 'manual' } },
    { id: 'p2', type: 'bar', x: 800, y: 260, rot: 20, len: 70, note: 'C4' }] };
}
(function bootLayout() {
  const flag = store.get(BOOT_KEY);
  const crashed = flag != null && !(Date.now() - Number(flag) < BOOT_QUIET_MS);
  bootArm();
  let shared = layoutFromHash();
  if (shared) try { history.replaceState(null, '', location.href.split('#')[0]); } catch (e) { /* file:// in some browsers */ }
  if (crashed) { BOOT.notice = setAsideAutosave(); shared = null; }
  let saved = null;
  try { saved = crashed ? null : readAutosave(); } catch (e) { console.warn('The autosave could not be read: ' + e.message); }
  try {
    applyLayout(saved || starterLayout());
    MODEL.demoId = saved && saved.demoId && MarbleDemos.get(saved.demoId) ? saved.demoId : null;
    MODEL.remixOf = (saved && saved.remixOf) || null;
  } catch (e) {
    console.error('The saved run could not be opened: ' + (e && e.message));
    applyLayout(starterLayout()); MODEL.demoId = null;
  }
  if (MODEL.remixOf) MarbleDemos.build(MODEL.remixOf);    // (a remix shows its song in the strip)
  if (shared && shared.error) BOOT.notice = 'That link could not be opened.';
  else if (shared) BOOT.shared = shared;
  const lastNoted = [...MODEL.pieces].reverse().find((p) => p.note);
  MODEL.lastNote = lastNoted ? lastNoted.note : null;
  MODEL.version++;
})();

/* ---- 2) The renderer: WebGL2, or the Canvas 2D view ---- */
let stage = document.getElementById('stage');
try { glOk = initGL(stage); } catch (e) { console.warn('WebGL renderer failed to start: ' + (e && e.message || e)); glOk = false; }
if (glOk) {
  GLR.canvas = stage; GLR.fx = FXC.canvas;
  RENDER = { layout: layout3D, render: renderGL, applyCam: applyCamera };
  watchContext(stage);
} else useCanvas2D();

function useCanvas2D() {
  glOk = false;
  GLR.ok = false; GLR.ready = false; GLR.abandoned = true; GLR.buildToken++;
  clearTimeout(restoreTimer); restoreTimer = 0;
  rendererName = 'canvas2d';
  if (GLR.gl) {
    try { const lc = GLR.gl.getExtension('WEBGL_lose_context'); if (lc && !GLR.gl.isContextLost()) lc.loseContext(); } catch (e) { /* gone */ }
    const fresh = stage.cloneNode(false);
    fresh.__inputAttached = false;
    stage.replaceWith(fresh); stage = fresh;
  }
  hideLoading();
  const r2 = createCanvas2DRenderer(stage);
  RENDER = { layout: r2.layout, render: r2.render, applyCam: r2.applyCam };
  VIEW.b2s = (x, y) => r2.b2s(x, y);
  VIEW.b2sTo = (x, y, out) => r2.b2sTo(x, y, out);
  VIEW.s2b = (px, py) => r2.s2b(px, py);
  VIEW.ppu = () => r2.ppu();
}
function fallbackTo2D() {
  if (!glOk) return;
  ctxLost = false;
  useCanvas2D(); attachInput(); relayout();
}
function showLoading(msg, frac) {
  loadingEl.hidden = false;
  if (msg) $('#loadingMsg').textContent = msg;
  loadingBar.style.width = frac == null ? '0' : Math.round(frac * 100) + '%';
}
function hideLoading() { loadingEl.hidden = true; }
function startAssetBuild(msg) {
  showLoading(msg || 'Polishing the metal…', 0);
  buildGLAssets((f) => { loadingBar.style.width = Math.round(f * 100) + '%'; })
    .then((ok) => { if (ok) { hideLoading(); scheduleDemoPrebuild(); } })
    .catch((e) => { console.warn('3D scene failed to build, using the 2D view: ' + (e && e.stack || e)); fallbackTo2D(); });
}
// GPU context loss: keep building with the overlay; rebuild if it comes back within 3 s (counted only while the
// page is visible: a phone drops a background tab's context and slows its timers), else the 2D view
let ctxLost = false;
function lossCountdown() {
  clearTimeout(restoreTimer); restoreTimer = 0;
  if (!ctxLost || document.hidden) return;
  restoreTimer = setTimeout(() => { restoreTimer = 0; if (!GLR.ok && ctxLost && !document.hidden) { console.warn('The 3D view did not come back: switching to the 2D view.'); fallbackTo2D(); } }, 3000);
}
document.addEventListener('visibilitychange', () => { if (ctxLost) lossCountdown(); });
function watchContext(canvas) {
  canvas.addEventListener('webglcontextlost', (e) => {
    if (GLR.abandoned || canvas !== stage) return;
    e.preventDefault();
    GLR.ok = false; GLR.ready = false; GLR.buildToken++;
    ctxLost = true;
    showLoading('Restoring 3D…', null);
    lossCountdown();
  });
  canvas.addEventListener('webglcontextrestored', () => {
    if (GLR.abandoned || canvas !== stage || !ctxLost) return;
    ctxLost = false;
    clearTimeout(restoreTimer); restoreTimer = 0;
    try {
      TARGET_CACHE.clear(); GLR.targets = null; GLR.targetsKey = '';
      GLR.lastSig = GLR.shadowKey = null; GLR.ready = false; GLR.progs = {}; GLR.meshes = [];
      if (!initGL(stage)) throw new Error('the GPU context could not be set up again');
      relayout();
      setTimeout(() => startAssetBuild('Restoring 3D…'), 0);
    } catch (e) { console.warn('3D restore failed, using the 2D view: ' + e); fallbackTo2D(); }
  });
}

/* ---- 3) UI wiring ---- */
buildTray();
attachTray();
attachInput();
let laidDemo = stripDemo();
let voicesTimer = 0;
onModelChange((kind) => {
  if (kind === 'edit' && MODEL.demoId) adoptDemo(true);           // your first edit of a demo: it is your run now
  if (kind !== 'live') {
    autosaveSoon();
    clearTimeout(voicesTimer); voicesTimer = setTimeout(() => piano.prepare(layoutVoices()), 500);   // the synth readies this run's notes
  }
  if (kind === 'load') SIM.bucketCount.clear();
  if (EDIT.selected && !pieceById(EDIT.selected)) EDIT.selected = null;
  refreshTransport(); refreshTray(); refreshInspector();
  const st = stripDemo();
  if (st !== laidDemo) { laidDemo = st; relayout(); }
  if (glOk) GLR.dirty = true;
});
function onDemosChanged() { /* a new demo source was added: the gallery lists it next time it opens */ }
// Audio may only start after a gesture (Safari wants touchend/click); re-armed when the browser suspends it
const UNLOCK_EVENTS = ['touchend', 'pointerup', 'click', 'keydown'];
let unlockArmed = false;
function unlockAudio() { piano.init(); if (piano.running) disarmAudioUnlock(); }
function armAudioUnlock() { if (unlockArmed) return; unlockArmed = true; for (const ev of UNLOCK_EVENTS) document.addEventListener(ev, unlockAudio, true); }
function disarmAudioUnlock() { if (!unlockArmed) return; unlockArmed = false; for (const ev of UNLOCK_EVENTS) document.removeEventListener(ev, unlockAudio, true); }
armAudioUnlock();
piano.onStateChange = (s) => { if (s === 'running') disarmAudioUnlock(); else if (s !== 'closed') armAudioUnlock(); };

function relayout() { RENDER.layout(); OVL.sig = ''; }
let resizeQueued = false;
window.addEventListener('resize', () => { perfQuiet(); if (resizeQueued) return; resizeQueued = true; requestAnimationFrame(() => { resizeQueued = false; relayout(); refreshTray(true); }); });
document.addEventListener('visibilitychange', () => { perfQuiet(); lastFrame = performance.now(); if (!document.hidden) armAudioUnlock(); });

/* ---- 4) Adaptive quality (GPU only): worse in steps when frames are slow, better when clearly fast ---- */
const QUALITY = [
  { msaa: true, taps: 0, scale: 1 }, { msaa: false, taps: 0, scale: 1 }, { msaa: false, taps: 10, scale: 1 },
  { msaa: false, taps: 6, scale: 1 }, { msaa: false, taps: 6, scale: 0.85 }, { msaa: false, taps: 6, scale: 0.7 }, { msaa: false, taps: 6, scale: 0.55 },
];
// The display's refresh interval is estimated as the 10th percentile of the last 120 frame intervals (6.9..34 ms;
// until measured, 60 Hz). Worse when 40 frames average over 1.25 x that (a steady 30 fps cap is fine); better
// again after 5 s at up to 1.08 x, on probation: if the next 2 s average over 1.2 x, back down and no new try for
// 60 s. The second after a demo loads, the gallery opens, a resize or a tab switch is not counted.
const perf = { ring: new Float32Array(120).fill(1000 / 60), ri: 0, acc: 0, sq: 0, n: 0, goodMs: 0, level: 0, skip: 0, prob: 0, probAcc: 0, probN: 0, block: 0 };
function resetPerf() { perf.acc = perf.sq = perf.n = perf.goodMs = 0; perf.prob = 0; }
function perfQuiet() { resetPerf(); perf.skip = 1000; }
function refreshInterval() { const a = Array.from(perf.ring).sort((x, y) => x - y); return clamp(a[Math.floor(a.length * 0.1)], 6.9, 34); }
function qualityKey(i) { const q = QUALITY[i]; return (q.msaa && GLR.maxSamples > 1 ? 1 : 0) + '/' + (q.taps ? Math.min(q.taps, GLR.tapsMax) : GLR.tapsMax) + '/' + q.scale; }
function stepQuality(dir) {
  const cur = qualityKey(perf.level);
  for (let i = perf.level + dir; i >= 0 && i < QUALITY.length; i += dir) {
    if (qualityKey(i) === cur) continue;
    const q = QUALITY[i];
    perf.level = i;
    GLR.msaa = q.msaa; GLR.taps = q.taps ? Math.min(q.taps, GLR.tapsMax) : GLR.tapsMax; GLR.scale = q.scale;
    resizeCanvases();
    GLR.dirty = true;
    return true;
  }
  return false;
}
function adaptResolution(ms) {
  if (!glOk || GLR.software || !GLR.ready) return;
  ms = Math.min(ms, 100);
  perf.ring[perf.ri++ % perf.ring.length] = ms;
  if (perf.skip > 0) { perf.skip -= ms; return; }
  if (perf.block > 0) perf.block -= ms;
  if (perf.prob > 0) {                                  // probation after a step up
    perf.probAcc += ms; perf.probN++; perf.prob -= ms;
    if (perf.prob <= 0 && perf.probAcc / perf.probN > 1.2 * refreshInterval()) { stepQuality(1); perf.block = 60000; perf.goodMs = 0; }
  }
  perf.acc += ms; perf.sq += ms * ms; perf.n++;
  if (perf.n < 40) return;
  const avg = perf.acc / perf.n, sd = Math.sqrt(Math.max(0, perf.sq / perf.n - avg * avg)), span = perf.acc;
  perf.acc = perf.sq = perf.n = 0;
  const hz = refreshInterval(), capped30 = Math.abs(avg - 33.3) < 3 && sd < 2;
  if (avg > 1.25 * hz && !capped30) { perf.goodMs = 0; perf.prob = 0; stepQuality(1); }
  else if (avg <= 1.08 * hz) {
    perf.goodMs += span;
    if (perf.goodMs >= 5000 && perf.level > 0 && perf.block <= 0 && perf.prob <= 0) { perf.goodMs = 0; if (stepQuality(-1)) { perf.prob = 2000; perf.probAcc = perf.probN = 0; } }
  } else perf.goodMs = 0;
}

/* ---- 5) The frame loop: every stage runs on its own, so one failing stage never stops the app ----
 *  An error is logged once (per message); 3 render failures in a row switch to the 2D view, 3 physics failures in
 *  a row stop the run and offer to undo the last change. The autosave only writes after a frame that went well. */
const FAIL = { seen: new Set(), sim: 0, render: 0 };
function logOnce(where, e) {
  const k = where + ': ' + ((e && e.message) || e);
  if (FAIL.seen.has(k) || FAIL.seen.size > 40) return;
  FAIL.seen.add(k);
  console.error('Marble Music (' + where + '): ' + ((e && e.stack) || e));
}
window.addEventListener('error', (e) => logOnce('error', e.error || e.message));
window.addEventListener('unhandledrejection', (e) => logOnce('promise', e.reason));
let lastFrame = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  if (!BOOT.drawn) BOOT.frames++;
  const ms = Math.max(0, now - lastFrame);
  const dt = Math.min(ms / 1000, 0.25);                  // effects age in real time (the sim follows the audio clock)
  lastFrame = now;
  clock += dt;
  let ok = true;
  try { if (glOk && Math.min(window.devicePixelRatio || 1, 2) !== view.dpr) relayout(); } catch (e) { ok = false; logOnce('layout', e); }
  try { simFrame(dt, ms / 1000); FAIL.sim = 0; } catch (e) {
    ok = false; logOnce('physics', e);
    if (++FAIL.sim === 3) { try { stop(); } catch (e2) { /* already stopped */ } toast('Something went wrong', 'Undo last change', () => undo(), 8000); }
  }
  EDIT.pulse = Math.max(0, EDIT.pulse - dt * 2.5);
  try { stepViewAnim(dt); } catch (e) { ok = false; VIEWCAM.anim = null; logOnce('view', e); }
  try { refreshStrip(); if (SIM.playing) refreshTempo(); } catch (e) { ok = false; logOnce('strip', e); }
  let drew = false;
  if (FAIL.drew && glOk) GLR.lastRenderMs = ms;             // (a drawn frame's real cost: until the next frame could start)
  try { drew = RENDER.render(clock); FAIL.render = 0; } catch (e) {
    ok = false; logOnce('render', e);
    if (++FAIL.render >= 3) { FAIL.render = 0; if (glOk) fallbackTo2D(); }
  }
  try { if (drew) adaptResolution(ms); } catch (e) { logOnce('quality', e); }
  FAIL.drew = drew;
  // a huge run on a computer that draws 3D in software would take seconds per frame: the 2D view instead
  if (glOk && GLR.software && GLR.ready && MODEL.pieces.length > 400) { fallbackTo2D(); toastMore('This run is too big to draw in 3D on this computer: here is the 2D view.'); }
  SAVE.frameOk = ok;
  if (ok && !BOOT.drawn) bootDrawn();
}
RENDER.layout();
refreshTransport();
refreshInspector();
BOOT.started = true;                                       // (start-up got as far as the frame loop)
requestAnimationFrame(frame);
if (glOk) requestAnimationFrame(() => setTimeout(() => { if (glOk && !GLR.ready) startAssetBuild(); }, 30));
else scheduleDemoPrebuild();
if (store.get('marbleMusic.helpSeen') !== '1') openHelp();
// Demos are solved and verified in the background once the page is up, one per idle slot
function scheduleDemoPrebuild() {
  const ids = MarbleDemos.list().map((d) => d.id);
  const next = () => { const id = ids.shift(); if (!id) return; MarbleDemos.build(id); setTimeout(next, 250); };
  setTimeout(next, 1500);
}
// A shared link: at start-up (after the UI is up) and when a second link is followed in this tab
function openSharedLayout(L) {
  stop();
  stashUserRun();
  loadLayoutUndoable(L);
  select(null);
  frameRun();
  const extra = loadReportText();
  toast('Opened “' + MODEL.name + '” from a link.' + (extra ? ' ' + extra : ''), 'Undo', () => undo(), 7000);
}
window.addEventListener('hashchange', () => {
  const L = layoutFromHash();
  if (!L) return;
  try { history.replaceState(null, '', location.href.split('#')[0]); } catch (e) { /* file:// */ }
  if (L.error) toast('That link could not be opened.'); else openSharedLayout(L);
});
if (BOOT.shared) openSharedLayout(BOOT.shared);
else if (BOOT.notice) toast(BOOT.notice, BOOT.noticeMenu ? 'Show' : null, BOOT.noticeMenu ? openMenu : null, 9000);
else if (MODEL.pieces.length) frameRun();

/* ---- 6) The test and tinkering API ---- */
window.marbleMusic = {
  get ready() { return glOk ? GLR.ready : true; },
  get pieces() { return getLayout().pieces; },
  addPiece(spec) { return addPiece(spec); },
  updatePiece(id, patch) { return updatePiece(id, patch); },
  removePiece(id) { const r = removePiece(id); if (EDIT.selected === id) select(null); return r; },
  clear() { stop(); clearBoard(); select(null); fitView(); return true; },
  undo() { return undo(); },
  redo() { return redo(); },
  getLayout() { return getLayout(); },
  loadLayout(layout) { stop(); loadLayoutUndoable(layout); select(null); const r = loadReportText(); if (r) toast(r, null, null, 6000); return true; },
  shareURL() { return shareURL(); },
  play() { return play(); },
  stop() { return stop(); },
  dropFrom(dropperId) { return dropFrom(dropperId); },
  simulate(seconds, dt = 1 / 60) { void dt; simulateSeconds(seconds); return SIM.world ? SIM.world.time : 0; },
  get marbles() { const w = SIM.world; return w && SIM.session ? w.marbles.map((m) => ({ id: m.id, x: m.x, y: m.y, vx: m.vx, vy: m.vy, dropperId: m.dropperId })) : []; },
  get noteLog() { const w = SIM.world; return w ? w.notes.map((n) => ({ t: n.t, note: n.note, pieceId: n.pieceId, marbleId: n.marbleId })) : []; },
  clearNoteLog() { if (SIM.world) { SIM.world.notes.length = 0; SIM.noteIdx = 0; } },
  get demos() { return MarbleDemos.list().map((d) => ({ id: d.id, title: d.title })); },
  loadDemo(id) { return loadDemo(id, false); },
  demoTargets(id) { const b = MarbleDemos.build(id); return b ? b.targets.map((x) => ({ t: x.t, note: x.note, voice: x.voice })) : []; },
  predict(dropperId, seconds = 6) { const r = CANON.predict(simLayout(), dropperId, seconds, 1 / 60); return { path: r.path, hits: r.hits, end: r.end }; },
  get renderer() { return rendererName; },
  boardToScreen(x, y) { const s = VIEW.b2s(x, y); return { x: s[0], y: s[1] }; },
  screenToBoard(px, py) { const b = VIEW.s2b(px, py); return { x: b[0], y: b[1] }; },
  paletteRect(type) { return paletteRect(type); },
  get selected() { return EDIT.selected; },
  select(id) { select(pieceById(id) ? id : null); },
  get tempo() { return MODEL.tempo; },
  setTempo(bpm) { return setTempo(bpm); },
  get playing() { return SIM.playing; },
  MarbleDemos,
  get gpu() { return glOk ? { frameMs: Math.round(GLR.lastFrameMs || 0), software: GLR.software, scale: GLR.scale, samples: GLR.samples, taps: GLR.taps, timings: GLR.timings, frames: GLR.frames } : null; },
  debugCloseUp: DEV ? (...a) => debugCloseUp(...a) : undefined,
};
