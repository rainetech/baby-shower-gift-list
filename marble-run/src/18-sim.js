
/* ============================================================================
 *  SIM: the live marble world, driven by CANON
 *  - A "session" starts at Play (droppers release on their schedules) or at a
 *    single drop; its sim time (seconds) starts at 0. noteLog times use it.
 *  - Physics runs at CANON's fixed 240 Hz, paced by the AUDIO clock. A note found
 *    at sim time t is scheduled at anchor + t + LATENCY on the audio clock (never
 *    "now"), so frame jitter never reaches the ears. To have every note in hand
 *    before its time even when frames are slow, the physics runs AHEAD of the
 *    clock (head = clock - anchor + ahead; `ahead` follows the recent worst frame
 *    time). Marbles are drawn at the display time clock - anchor - LATENCY from a
 *    position history, so the eyes and the ears agree.
 *  - A stall (hidden tab) is caught up for at most MAX_CATCHUP; notes found while
 *    catching up that are already late are dropped rather than bunched, and a
 *    longer stall re-anchors (the music pauses, then goes on).
 *  - Editing the layout while marbles roll rebuilds the CANON world from the
 *    new pieces and carries the marbles, time, notes and schedule across.
 *  - What the ears get: loudness from the impact (a gentle curve, times the
 *    piece's own gain), the ring of the metal by piece type, the stereo place by
 *    the piece's x. The eyes wait for the output device's latency too.
 * ========================================================================== */
const LATENCY = 0.04;
const H_STEP = CANON.SUBSTEP;
const HIST = 960;                    // steps of position history per marble (4 s: covers `ahead` (up to 3.2 s) + LATENCY + output latency)
const MAX_CATCHUP = 0.25;
const SIM = {
  world: null, session: false, playing: false, horizon: 600, hasRepeat: false, outLat: 0, outLatAt: 0, tickT: -1,
  anchor: 0, clockSrc: '', noteIdx: 0, ahead: 0.05, dtMax: 0, delaySteps: 10, dispT: 0,
  events: [],                 // visual events waiting for the display time: { t, kind, pieceId, impact }
  fx: new Map(),              // pieceId -> { glow, wiggle, flick } (lights up and wiggles when it plays)
  bucketCount: new Map(),     // bucket pieceId -> marbles caught this session
  idleT: 0, listeners: [], dropCount: 0, landed: [], leaving: [],
};
function onSimChange(f) { SIM.listeners.push(f); }
function simNotify(kind) { for (const f of SIM.listeners) f(kind); }
function clockNow() { return piano.running ? piano.now : performance.now() / 1000; }

// Loudness of a note from its impact: soft touches 0.35..0.62, real landings 0.62..0.95 (a gentle square-root curve,
// so a run of equal drops sounds even)
function noteVelocity(impact) {
  return impact < 120 ? 0.35 + 0.27 * impact / 120 : 0.62 + 0.33 * Math.sqrt(clamp((impact - 150) / 650, 0, 1));
}
const PIECE_METAL = { bar: 0.6, bell: 0.9, spring: 0.5, wall: 0.4, funnel: 0.4, rail: 0.3, curve: 0.3 };
const piecePan = (p) => 0.6 * (2 * clamp(p.x, 0, BOARD_W) / BOARD_W - 1);
// Every voice this layout can play ({ freq, metal }), for the synth to have ready
function layoutVoices(pieces = MODEL.pieces) {
  const out = [], seen = new Set();
  for (const p of pieces) {
    if (!p.note) continue;
    const k = p.note + '|' + metalClass(PIECE_METAL[p.type]);
    if (!seen.has(k)) { seen.add(k); out.push({ freq: noteFreq(p.note), metal: PIECE_METAL[p.type] }); }
  }
  return out;
}
function newWorld(playing) {
  const L = simLayout();
  const w = CANON.createWorld(L);
  SIM.hasRepeat = L.pieces.some((p) => p.type === 'dropper' && p.schedule && p.schedule.mode === 'repeat');
  SIM.horizon = 600;
  if (playing) CANON.scheduleReleases(w, L, SIM.horizon);
  return w;
}
// Repeat droppers drop until Stop: schedule another 10 minutes when the schedule runs short
function extendReleases(w) {
  SIM.horizon = w.time + 600;
  CANON.scheduleReleases(w, simLayout(), SIM.horizon);
  let i = 0;                                  // (releases already due dropped at an earlier step)
  while (i < w.releases.length && w.releases[i].t <= w.time - H_STEP + 1e-9) i++;
  w.releaseIdx = i;
}
function startSession(playing) {
  piano.cancelQueued();
  SIM.world = newWorld(playing);
  SIM.session = true; SIM.playing = playing;
  SIM.clockSrc = piano.running ? 'audio' : 'perf';
  SIM.anchor = clockNow() + 0.03;            // a hair of lead so the very first notes are not late
  SIM.dispT = 0; SIM.delaySteps = 0; SIM.tickT = -1;
  SIM.noteIdx = 0; SIM.events.length = 0; SIM.landed.length = 0; SIM.leaving.length = 0; SIM.idleT = 0;
  SIM.bucketCount.clear();
  readOutputLatency();
  simNotify(playing ? 'play' : 'drop');
}
function ensureSession() { if (!SIM.session || !SIM.world) startSession(false); }
function play() { startSession(true); return true; }
function stop() {
  const was = SIM.session;
  piano.cancelQueued();
  SIM.playing = false; SIM.session = false;
  if (SIM.world) { SIM.world.marbles.length = 0; SIM.world.releases = []; SIM.world.releaseIdx = 0; }
  SIM.events.length = 0; SIM.leaving.length = 0;
  SIM.bucketCount.clear();
  if (was) simNotify('stop');
  return true;
}
// Drop one marble from a dropper now (starts a session when none is running)
function dropFrom(dropperId) {
  const d = pieceById(dropperId);
  if (!d || d.type !== 'dropper') return null;
  ensureSession();
  const m = CANON.dropFrom(SIM.world, dropperId);
  if (m) { SIM.dropCount++; SIM.idleT = 0; flickDropper(dropperId, SIM.world.time); }
  simNotify('drop');
  return m ? m.id : null;
}
function flickDropper(id, t) { SIM.events.push({ t, kind: 'release', pieceId: id }); }

// Rebuild the world after an edit, keeping every rolling marble, the time, the notes and the schedule
function rebuildWorld() {
  const old = SIM.world;
  if (!old) return;
  const L = simLayout();
  const w = CANON.createWorld(L);
  w.marbles = old.marbles; w.time = old.time; w.nextMarbleId = old.nextMarbleId;
  w.notes = old.notes; w.removed = old.removed;
  SIM.hasRepeat = L.pieces.some((p) => p.type === 'dropper' && p.schedule && p.schedule.mode === 'repeat');
  if (SIM.playing) {
    CANON.scheduleReleases(w, L, SIM.horizon);
    let i = 0;                                // releases already due (they dropped at an earlier step) are skipped
    while (i < w.releases.length && w.releases[i].t <= old.time - H_STEP + 1e-9) i++;
    w.releaseIdx = i;
  }
  SIM.world = w;
}
onModelChange(() => { if (SIM.world && SIM.session) rebuildWorld(); });   // (with no session running, the next one builds its own)

// One fixed step, plus the short position history each marble is drawn from
const STEP_BEFORE = [];
function stepOnce() {
  const w = SIM.world;
  const nRel = w.releaseIdx, nRem = w.removed.length;
  STEP_BEFORE.length = 0;
  for (let i = 0; i < w.marbles.length; i++) STEP_BEFORE.push(w.marbles[i]);
  if (SIM.playing && SIM.hasRepeat && w.time > SIM.horizon - 60) extendReleases(w);
  CANON.step(w);
  if (w.removed.length > nRem) for (const m of STEP_BEFORE) if (!w.marbles.includes(m)) { m.removedAt = w.time; SIM.leaving.push(m); }   // drawn until the display time gets there
  for (let i = nRel; i < w.releaseIdx; i++) flickDropper(w.releases[i].dropperId, w.releases[i].t);
  for (let i = 0; i < w.marbles.length; i++) {
    const m = w.marbles[i];
    if (!m.hx) { m.hx = new Float64Array(HIST * 3); m.hn = 0; }
    const k = (m.hn % HIST) * 3;
    m.hx[k] = m.x; m.hx[k + 1] = m.y; m.hx[k + 2] = m.angle;
    m.hn++;
    if (m.bucketT >= 0 && !m.caught) { m.caught = 1; SIM.landed.push({ t: m.bucketT, x: m.x, y: m.y, impact: Math.hypot(m.vx, m.vy) }); }
  }
}
// Every marble to draw now: the rolling ones and those that left the physics but are still ahead of the display
function drawnMarbles() {
  const w = SIM.world;
  if (!w || !SIM.session) return NO_MARBLES;
  for (let i = SIM.leaving.length - 1; i >= 0; i--) if (SIM.leaving[i].removedAt < SIM.dispT) SIM.leaving.splice(i, 1);
  if (!SIM.leaving.length) return w.marbles;
  DRAWN.length = 0;
  for (const m of w.marbles) DRAWN.push(m);
  for (const m of SIM.leaving) DRAWN.push(m);
  return DRAWN;
}
const NO_MARBLES = [], DRAWN = [];
// How far ahead of the clock the physics runs: the recent worst frame time (rises at once, relaxes slowly)
// (Up to 1.25 s ahead; 3.2 s on a computer that draws 3D slowly, whose frames can take 2 s)
function trackFrames(dt) {
  if (dt <= 0 || dt > 2.5) return;                             // (longer: a real stall, handled as one)
  SIM.dtMax = Math.max(dt, SIM.dtMax * Math.exp(-dt / 3));
  const cap = (typeof GLR !== 'undefined' && GLR.software) || SIM.dtMax > 1 ? 3.2 : 1.25;
  const want = clamp(SIM.dtMax * 1.25 + 0.012, 0.02, cap);
  SIM.ahead = want > SIM.ahead ? want : SIM.ahead + (want - SIM.ahead) * Math.min(1, dt / 3);
}
// The output device's own delay (Bluetooth: up to 0.3 s): read when the audio starts and every few seconds
function readOutputLatency() { SIM.outLat = piano.running ? clamp(piano.outputLatency || 0, 0, 0.3) : 0; SIM.outLatAt = performance.now(); }
// The display time (what the ears hear now) and how many physics steps behind the head it is
function setDisplayTime(now) {
  const w = SIM.world;
  SIM.dispT = Math.min(w.time, now - SIM.anchor - LATENCY - SIM.outLat);
  SIM.delaySteps = clamp(Math.round((w.time - SIM.dispT) / H_STEP), 0, HIST - 1);
}
// Where to draw a marble at the display time (null while it is still in the dropper's tube)
function marbleDrawPos(m, out) {
  const back = m.removedAt != null ? Math.round((m.removedAt - SIM.dispT) / H_STEP) : SIM.delaySteps;
  if (!m.hn || m.hn <= back || back < 0 || back >= HIST) return null;
  const k = ((m.hn - 1 - back) % HIST) * 3;
  out[0] = m.hx[k]; out[1] = m.hx[k + 1]; out[2] = m.hx[k + 2];
  return out;
}

// Advance to the audio clock; schedule the notes found; queue the visual effects
function simFrame(dt, realDt = dt) {
  decayFx(Math.min(realDt, 1));                                   // effects fade in real time, however slow the frames
  if (!SIM.session || !SIM.world) return;
  const w = SIM.world;
  if (DEV && window.__mmPause) { SIM.anchor = clockNow() + SIM.ahead - w.time; setDisplayTime(clockNow()); fireEvents(SIM.dispT); return; }   // (?dev: freeze for close-ups)
  const src = piano.running ? 'audio' : 'perf';
  let now = clockNow();
  if (src !== SIM.clockSrc) { SIM.clockSrc = src; SIM.anchor = now + SIM.ahead - w.time; readOutputLatency(); }   // the audio clock just started
  else if (performance.now() - SIM.outLatAt > 2000) readOutputLatency();
  trackFrames(realDt);
  let lag = now - SIM.anchor + SIM.ahead - w.time;
  if (lag > MAX_CATCHUP + SIM.ahead) { SIM.anchor = now + SIM.ahead - MAX_CATCHUP - w.time; lag = MAX_CATCHUP; }   // stall: pause the music
  let n = Math.floor(lag / H_STEP + 1e-6);
  while (n-- > 0) stepOnce();
  handleNotes(true);
  metronome();
  setDisplayTime(now);
  fireEvents(SIM.dispT);
  // A session without Play ends a moment after its last marble; Play ends when nothing is left to drop
  const pending = w.releaseIdx < w.releases.length;
  if (!w.marbles.length && !pending && !SIM.leaving.length && !SIM.events.length) {
    SIM.idleT += dt;
    if (SIM.idleT > (SIM.playing ? 1.4 : 0.8) + SIM.ahead) { SIM.playing = false; SIM.session = false; simNotify('stop'); }
  } else SIM.idleT = 0;
}

// New notes: audio at anchor + t + LATENCY on the audio clock (late ones are dropped), visuals queued
function handleNotes(withAudio) {
  const w = SIM.world, notes = w.notes;
  const audioNow = piano.running ? piano.now : -1;
  for (; SIM.noteIdx < notes.length; SIM.noteIdx++) {
    const n = notes[SIM.noteIdx];
    if (withAudio && audioNow >= 0) {
      const when = SIM.anchor + n.t + LATENCY;
      if (when >= audioNow - 0.012) {
        const p = w.byId.get(n.pieceId) || { type: 'bar', x: n.x };
        piano.play(noteFreq(n.note), noteVelocity(n.impact) * (p.gain || 1), when, PIECE_METAL[p.type], piecePan(p));
      }
    }
    SIM.events.push({ t: n.t, kind: 'note', pieceId: n.pieceId, impact: n.impact, note: n.note });
  }
  for (const r of SIM.landed) {                  // marbles that just landed in a bucket: count, bump, clink
    const b = nearestBucket(r.x, r.y);
    if (!b) continue;
    SIM.events.push({ t: r.t, kind: 'bucket', pieceId: b.id });   // counted when the eyes see it land
    const when = SIM.anchor + r.t + LATENCY;
    if (withAudio && audioNow >= 0 && when >= audioNow - 0.012) piano.clink(when, r.impact || 300, !!MODEL.demoId, piecePan(b));
  }
  SIM.landed.length = 0;
}
// The metronome (off by default): a soft tick on every pulse of the beat grid while playing, on the audio clock
const TICK_BEATS = [];
function metronome() {
  const w = SIM.world;
  if (!SIM.playing || !UI.metronome || !piano.running) { SIM.tickT = w.time; return; }
  const clk = layoutBeatClock(), from = SIM.tickT;
  for (const [b, tb] of clk.beats(Math.max(0, from), w.time, TICK_BEATS)) {
    if (tb <= from + 1e-9) continue;
    const when = SIM.anchor + tb + LATENCY;
    if (when >= piano.now - 0.012) piano.tick(when, clk.isBar(b));
  }
  SIM.tickT = w.time;
}
function nearestBucket(x, y) {
  let best = null, bd = 60;
  for (const p of MODEL.pieces) if (p.type === 'bucket') { const d = Math.hypot(p.x - x, p.y - y); if (d < bd) { bd = d; best = p; } }
  return best;
}
function fxOf(id) { let f = SIM.fx.get(id); if (!f) SIM.fx.set(id, (f = { glow: 0, wiggle: 0, flick: 0, bump: 0 })); return f; }
function fireEvents(dispT) {
  const ev = SIM.events;
  let k = 0;
  for (let i = 0; i < ev.length; i++) {
    const e = ev[i];
    if (e.t > dispT) { ev[k++] = e; continue; }
    const f = fxOf(e.pieceId);
    if (e.kind === 'note') { f.glow = Math.min(1, 0.55 + e.impact / 700); f.wiggle = Math.min(1, 0.4 + e.impact / 500); if (typeof onNoteVisual === 'function') onNoteVisual(e); }
    else if (e.kind === 'release') f.flick = 1;
    else if (e.kind === 'bucket') { f.bump = 1; SIM.bucketCount.set(e.pieceId, (SIM.bucketCount.get(e.pieceId) || 0) + 1); }
  }
  ev.length = k;
}
function decayFx(dt) {
  for (const [id, f] of SIM.fx) {
    f.glow = Math.max(0, f.glow - dt * 1.5);
    f.wiggle = Math.max(0, f.wiggle - dt * 2.2);
    f.flick = Math.max(0, f.flick - dt * 3);
    f.bump = Math.max(0, f.bump - dt * 2.5);
    if (!f.glow && !f.wiggle && !f.flick && !f.bump) SIM.fx.delete(id);
  }
}
function fxAnimating() { return SIM.fx.size > 0; }

// Advance without rendering (test API): the notes found are not played; the clock re-anchors afterwards
function simulateSeconds(seconds) {
  ensureSession();
  const n = Math.round(Math.max(0, seconds) / H_STEP);
  for (let i = 0; i < n; i++) stepOnce();
  handleNotes(false);
  SIM.events.length = 0;
  SIM.tickT = SIM.world.time;
  SIM.anchor = clockNow() + SIM.ahead - SIM.world.time;        // carry on from here, in step with the clock
  setDisplayTime(clockNow());
}

// Path preview: one marble from each dropper, run ahead with CANON, cached per layout version. After a small edit
// only the droppers whose path comes within reach of a changed piece (its old or new place) are run again: a marble
// that never comes within touching distance of a piece cannot tell whether it is there, so every other path is
// exactly the same. (Path samples are 1/60 s apart, so "within reach" allows for a marble's travel in between.)
const PREVIEW = { key: '', paths: new Map(), sig: new Map() };
const PREVIEW_REACH = CANON.MARBLE_R + 2 + CANON.MAX_SPEED / 60;
function previewPaths(pieces, key, seconds = 8) {
  if (key === PREVIEW.key) return PREVIEW.paths;
  const L = simLayout(pieces), out = new Map(), sig = new Map();
  for (const p of pieces) sig.set(p.id, JSON.stringify(p));
  const changed = [];                               // other pieces added, removed or changed, as they were and are
  sig.forEach((s, id) => { if (PREVIEW.sig.get(id) !== s) { changed.push(s); if (PREVIEW.sig.has(id)) changed.push(PREVIEW.sig.get(id)); } });
  PREVIEW.sig.forEach((s, id) => { if (!sig.has(id)) changed.push(s); });
  const shapes = changed.length <= 16 ? previewShapes(changed.map((s) => JSON.parse(s)).filter((p) => p.type !== 'dropper')) : null;
  for (const p of pieces) {
    if (p.type !== 'dropper') continue;
    const old = PREVIEW.paths.get(p.id);
    const keep = shapes && old && PREVIEW.sig.get(p.id) === sig.get(p.id) && !pathNear(old.path, shapes);
    out.set(p.id, keep ? old : CANON.predict(L, p.id, seconds, 1 / 60));
  }
  PREVIEW.key = key; PREVIEW.paths = out; PREVIEW.sig = sig;
  return out;
}
// What a marble can feel of these pieces: their colliders, and for a bucket the pocket where it catches marbles
function previewShapes(list) {
  const out = [];
  for (const p of list) {
    for (const c of CANON.colliders(p)) out.push(c.shape === 'seg' ? c : { ax: c.x, ay: c.y, abx: 0, aby: 0, len2: 1, hw: c.r });
    if (p.type === 'bucket') out.push({ ax: p.x, ay: p.y, abx: 0, aby: 0, len2: 1, hw: 50 });
  }
  return out;
}
function pathNear(path, shapes) {
  for (let si = 0; si < shapes.length; si++) {
    const c = shapes[si];
    const r = c.hw + PREVIEW_REACH, x0 = Math.min(c.ax, c.ax + c.abx) - r, x1 = Math.max(c.ax, c.ax + c.abx) + r;
    const y0 = Math.min(c.ay, c.ay + c.aby) - r, y1 = Math.max(c.ay, c.ay + c.aby) + r;
    for (let i = 0; i < path.length; i++) {
      const q = path[i];
      if (q[0] < x0 || q[0] > x1 || q[1] < y0 || q[1] > y1) continue;
      let t = ((q[0] - c.ax) * c.abx + (q[1] - c.ay) * c.aby) / c.len2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const dx = q[0] - c.ax - c.abx * t, dy = q[1] - c.ay - c.aby * t;
      if (dx * dx + dy * dy < r * r) return true;
    }
  }
  return false;
}
