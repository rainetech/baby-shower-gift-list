
/* ============================================================================
 *  MODEL: the layout being built
 *  Layout = { v: 1, name, tempo (bpm), board: { w: 1600, h: 1000 }, pieces: Piece[], timing? }
 *  Piece  = { id, type, x, y, rot, len?, r?, sweep?, w?, h?, note?, schedule? }
 *  Timing = { start, beatsPerBar, pulse?, tempoMap? }: a song's beat grid (see normTiming)
 *  Board units, y down, (x, y) = the piece centre, rot in degrees clockwise.
 *  A note piece plays `note`; `note: null` makes it a silent guide (a wall or rail
 *  that only steers). A new piece without a note gets the next note of the scale.
 *  Every change goes through change() (or beginChange/endChange for drags), which
 *  keeps the undo history, bumps MODEL.version and tells the listeners.
 * ========================================================================== */
const BOARD_W = 1600, BOARD_H = 1000, GRID = 20;
const PIECE_TYPES = ['bar', 'rail', 'curve', 'bell', 'spring', 'wall', 'funnel', 'dropper', 'bucket'];
const PARAM_KEYS = { bar: ['len'], rail: ['len'], curve: ['r', 'sweep'], bell: ['r'], spring: ['len'], wall: ['len'],
  funnel: ['w', 'h'], dropper: [], bucket: ['w'] };
const PIECE_INFO = {
  bar:     { name: 'Bell bar', tip: 'A tuned metal key. Marbles ring it like a piano key.' },
  rail:    { name: 'Rail', tip: 'Chrome track. Marbles roll along it.' },
  curve:   { name: 'Curve', tip: 'Bent chrome track: loops, bowls and turns.' },
  bell:    { name: 'Dome', tip: 'A springy brass dome that pings marbles away.' },
  spring:  { name: 'Spring', tip: 'Trampoline pad: big bounces.' },
  wall:    { name: 'Wall', tip: 'Steel stop plate: marbles bounce off it.' },
  funnel:  { name: 'Funnel', tip: 'Spun steel cone: gathers marbles into one spot.' },
  dropper: { name: 'Dropper', tip: 'Releases marbles when you press Play.' },
  bucket:  { name: 'Bucket', tip: 'Catches and counts marbles.' },
};
const hasNote = (type) => !!(CANON.PIECES[type] && CANON.PIECES[type].note);
const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(+v) ? +v : d);
function validNote(n) { const m = typeof n === 'string' ? noteToMidi(n) : null; return m != null && m >= 12 && m <= 120; }

// Input limits: anything read from a file, a link or the API is bounded before CANON sees it (CANON's broadphase
// loops over a piece's grid cells, so a piece at x = 1e18 would never finish), and every legitimate value is kept
// bit-identical (a demo solved with exact floats must replay exactly).
const LIMITS = { pad: 1000, idLen: 40, times: 2000, maxT: 600, tempoMap: 512, pieces: 1500 };
const NORM = { off: 0, trimmed: 0, capped: 0 };        // what the last normalisation dropped (see applyLayout)
function normSchedule(s) {
  if (!s || typeof s !== 'object') return { mode: 'manual' };
  if (s.mode === 'repeat') return { mode: 'repeat', every: clamp(num(s.every, 2), 0.25, 64) };
  if (s.mode === 'times') {
    const src = Array.isArray(s.times) ? s.times : [], out = [], seen = new Set();
    for (let i = 0; i < src.length; i++) {
      const t = num(src[i], NaN);
      // only finite times in [0, 600], each once (two marbles released together from one tube would overlap)
      if (!(t >= 0 && t <= LIMITS.maxT) || seen.has(t) || out.length >= LIMITS.times) { NORM.trimmed++; continue; }
      seen.add(t); out.push(t);
    }
    return { mode: 'times', times: out };
  }
  return { mode: 'manual' };
}
// A piece in canonical form (fixed key order, parameters clamped to their ranges). Values are kept exactly
// as given (no rounding): a demo solved with exact floats must replay identically.
function normPiece(p) {
  const type = p && p.type, def = CANON.PIECES[type];
  if (!def) return null;
  const x = num(p.x, BOARD_W / 2), y = num(p.y, BOARD_H / 2);
  if (x < -LIMITS.pad || x > BOARD_W + LIMITS.pad || y < -LIMITS.pad || y > BOARD_H + LIMITS.pad) { NORM.off++; return null; }
  let rot = num(p.rot, 0);
  if (Math.abs(rot) > 3600) rot %= 360;                    // (only absurd turns are reduced; normal ones stay exact)
  const o = { id: String(p.id != null ? p.id : '').slice(0, LIMITS.idLen), type, x, y, rot };
  for (const k of PARAM_KEYS[type]) {
    let v = num(p[k], def.defaults[k]);
    const r = def.ranges[k];
    if (r) v = clamp(v, r[0], r[1]);
    o[k] = v;
  }
  if (type === 'bucket') o.w = 70;                          // the bucket has one size
  if (def.note) {
    o.note = validNote(p.note) ? p.note : null;
    // loudness of this piece's notes (a song layout sets it per voice); only stored when it is not 1
    const gain = num(p.gain, 1);
    if (gain !== 1) o.gain = clamp(gain, 0.25, 1.5);
  }
  if (type === 'dropper') o.schedule = normSchedule(p.schedule);
  return o;
}
// The beat grid of a song layout (optional). start: seconds from Play to beat 0; beatsPerBar: quarter beats per bar
// (3/8 = 1.5); pulse: the beat dots' spacing in quarter beats (default 1); tempoMap: [[beat, bpm], ...], each tempo
// holding from its beat on (an accelerando). Without a timing the grid is the layout tempo from Play.
// Values are kept exactly as given (they describe a song solved with exact floats).
function normTiming(t) {
  if (!t || typeof t !== 'object') return null;
  const o = { start: clamp(num(t.start, 0), 0, 600), beatsPerBar: clamp(num(t.beatsPerBar, 4), 0.5, 32) };
  const pulse = num(t.pulse, 1);
  if (pulse !== 1) o.pulse = clamp(pulse, 0.125, 8);
  const map = [], src = Array.isArray(t.tempoMap) ? t.tempoMap : [];
  if (src.length > LIMITS.tempoMap) NORM.trimmed++;
  for (const e of src) {
    if (map.length >= LIMITS.tempoMap) break;
    const b = Array.isArray(e) ? num(e[0], -1) : -1, bpm = Array.isArray(e) ? num(e[1], 0) : 0;
    if (b >= 0 && bpm > 0 && (!map.length || b > map[map.length - 1][0])) map.push([b, clamp(bpm, 10, 600)]);
  }
  if (map.length) o.tempoMap = map;
  return o;
}
// The beat grid as a clock: sec(b) = seconds after Play of quarter beat b (a pickup has b < 0), beatAt(t) the
// inverse, bpmAt(t) the tempo then, beats(t0, t1) = every pulse [b, t] from t0 to t1, isBar(b) = a bar line
function makeBeatClock(timing, tempo) {
  const T = timing || {}, start = T.start || 0, beatsPerBar = T.beatsPerBar || 4, pulse = T.pulse || 1;
  const map = T.tempoMap && T.tempoMap.length ? T.tempoMap.slice() : [[0, tempo || 100]];
  if (map[0][0] > 0) map.unshift([0, tempo || map[0][1]]);
  const segs = [];                                   // [beat, bpm, seconds from beat 0 to that beat]
  let acc = 0;
  map.forEach(([b, bpm], i) => { if (i) acc += ((b - map[i - 1][0]) * 60) / map[i - 1][1]; segs.push([b, bpm, acc]); });
  const segOfBeat = (b) => { let k = segs.length - 1; while (k > 0 && segs[k][0] > b) k--; return segs[k]; };
  const sec = (b) => { if (b <= 0) return start + (b * 60) / segs[0][1]; const g = segOfBeat(b); return start + g[2] + ((b - g[0]) * 60) / g[1]; };
  const beatAt = (t) => {
    const x = t - start;
    if (x <= 0) return (x * segs[0][1]) / 60;
    let k = segs.length - 1;
    while (k > 0 && segs[k][2] > x) k--;
    return segs[k][0] + ((x - segs[k][2]) * segs[k][1]) / 60;
  };
  return {
    start, beatsPerBar, pulse, varies: segs.length > 1, sec, beatAt,
    bpmAt: (t) => segOfBeat(Math.max(0, beatAt(t)))[1],
    isBar: (b) => { const q = b / beatsPerBar; return Math.abs(q - Math.round(q)) < 1e-6; },
    beats(t0, t1, out = []) {
      out.length = 0;
      for (let k = Math.ceil(beatAt(t0) / pulse - 1e-6), t; (t = sec(k * pulse)) <= t1 + 1e-9 && out.length < 4000; k++) out.push([k * pulse, t]);
      return out;
    },
  };
}
// The clock of the layout being built (cached until its tempo or timing changes)
const BEAT_CLOCK = { key: '', clock: null };
function layoutBeatClock() {
  const key = MODEL.tempo + '|' + JSON.stringify(MODEL.timing);
  if (key !== BEAT_CLOCK.key) { BEAT_CLOCK.key = key; BEAT_CLOCK.clock = makeBeatClock(MODEL.timing, MODEL.tempo); }
  return BEAT_CLOCK.clock;
}
const copyTiming = (t) => (t ? Object.assign({}, t, t.tempoMap ? { tempoMap: t.tempoMap.map((e) => e.slice()) } : {}) : null);
function copyPiece(p) {
  const o = Object.assign({}, p);
  if (p.schedule) o.schedule = p.schedule.times ? { mode: p.schedule.mode, times: p.schedule.times.slice() } : Object.assign({}, p.schedule);
  return o;
}

const MODEL = {
  name: 'My marble run', tempo: 100, timing: null, pieces: [], version: 0, scale: store.get('marbleMusic.scale') || 'C major',
  lastNote: null, nextId: 1, demoId: null, remixOf: null, loadReport: null, listeners: [],
};
if (!SCALES[MODEL.scale]) MODEL.scale = 'C major';
const pieceById = (id) => MODEL.pieces.find((p) => p.id === id) || null;
function freshId() {
  let id;
  do id = 'p' + MODEL.nextId++; while (MODEL.pieces.some((p) => p.id === id));
  return id;
}
function onModelChange(f) { MODEL.listeners.push(f); }
function touched(kind = 'edit') {
  MODEL.version++;
  if (kind !== 'live') MODEL.epoch = (MODEL.epoch || 0) + 1;        // (real edits only: live drags keep it)
  for (const f of MODEL.listeners) f(kind);
}

function getLayout() {
  const L = { v: 1, name: MODEL.name, tempo: MODEL.tempo, board: { w: BOARD_W, h: BOARD_H }, pieces: MODEL.pieces.map(copyPiece) };
  if (MODEL.timing) L.timing = copyTiming(MODEL.timing);
  return L;
}
// The layout handed to CANON (read-only there: createWorld copies every piece)
function simLayout(pieces = MODEL.pieces) { return { v: 1, tempo: MODEL.tempo, board: { w: BOARD_W, h: BOARD_H }, pieces }; }

// Replace the whole layout (load, demo, import, undo). Pieces without ids get fresh ones; note pieces without a
// note get the next scale note (`note: null` keeps a piece silent). Returns (and keeps in MODEL.loadReport) what had
// to be left out: pieces off the board, pieces over the limit, out-of-range drop times or tempo changes.
function applyLayout(layout) {
  const L = layout && typeof layout === 'object' ? layout : {};
  NORM.off = NORM.trimmed = NORM.capped = 0;
  MODEL.name = typeof L.name === 'string' && L.name ? L.name.slice(0, 60) : 'My marble run';
  MODEL.tempo = clamp(Math.round(num(L.tempo, 100) * 100) / 100, 30, 300);
  MODEL.timing = normTiming(L.timing);
  const out = [], seen = new Set(), silent = new Set(), src = Array.isArray(L.pieces) ? L.pieces : [];
  for (let i = 0; i < src.length; i++) {
    if (out.length >= LIMITS.pieces) { NORM.capped = src.length - i; break; }
    const p = src[i] && typeof src[i] === 'object' ? normPiece(src[i]) : null;
    if (!p) continue;
    if (!p.id || seen.has(p.id)) p.id = '';
    if (p.id) seen.add(p.id);
    if (src[i].note === null) silent.add(p);
    out.push(p);
  }
  MODEL.pieces = out;
  let maxN = 0;
  for (const p of out) { const m = /^p(\d+)$/.exec(p.id); if (m) maxN = Math.max(maxN, +m[1]); }
  MODEL.nextId = maxN + 1;
  for (const p of out) {
    if (!p.id) p.id = freshId();
    if (hasNote(p.type) && !p.note && !silent.has(p)) p.note = MODEL.lastNote = nextScaleNote(MODEL.lastNote, MODEL.scale);
  }
  MODEL.loadReport = { off: NORM.off, capped: NORM.capped, trimmed: NORM.trimmed };
  return MODEL.loadReport;
}
// What a load left out, in words ('' when nothing was)
function loadReportText(r = MODEL.loadReport) {
  if (!r) return '';
  const out = [];
  if (r.off) out.push(r.off + (r.off === 1 ? ' piece was off the board and was left out.' : ' pieces were off the board and were left out.'));
  if (r.capped) out.push('Only the first ' + LIMITS.pieces + ' pieces were loaded.');
  if (r.trimmed) out.push('Some drop times or tempo changes were out of range and were left out.');
  return out.join(' ');
}

/* ---- Undo / redo: whole-layout snapshots (layouts are small) ---- */
const HISTORY = { undo: [], redo: [], max: 200, pending: null, liveId: null };
function snapshot() { return JSON.stringify({ name: MODEL.name, tempo: MODEL.tempo, timing: MODEL.timing, pieces: MODEL.pieces, demoId: MODEL.demoId, remixOf: MODEL.remixOf }); }
function restore(s) {
  const o = JSON.parse(s);
  const keepNext = MODEL.nextId;
  applyLayout(o);
  MODEL.demoId = o.demoId || null;
  MODEL.remixOf = o.remixOf || null;
  MODEL.nextId = Math.max(MODEL.nextId, keepNext);
}
function pushUndo(before) {
  HISTORY.undo.push(before);
  if (HISTORY.undo.length > HISTORY.max) HISTORY.undo.shift();
  HISTORY.redo.length = 0;
}
// Run an edit as one undo step; returns fn's result
function change(fn, kind = 'edit') {
  const before = snapshot();
  const r = fn();
  if (snapshot() !== before) { pushUndo(before); touched(kind); }
  return r;
}
// Long edits (drags): one undo step from beginChange() to endChange(); live updates in between via touched('live')
function beginChange() { if (!HISTORY.pending) HISTORY.pending = snapshot(); }
function endChange() {
  const before = HISTORY.pending;
  HISTORY.pending = null; HISTORY.liveId = null;
  if (before != null && snapshot() !== before) { pushUndo(before); touched('edit'); return true; }
  return false;
}
function undo() {
  if (HISTORY.pending) endChange();
  if (!HISTORY.undo.length) return false;
  HISTORY.redo.push(snapshot());
  restore(HISTORY.undo.pop());
  touched('undo');
  return true;
}
function redo() {
  if (!HISTORY.redo.length) return false;
  HISTORY.undo.push(snapshot());
  restore(HISTORY.redo.pop());
  touched('undo');
  return true;
}

/* ---- Editing operations (all undoable) ---- */
// Add a piece; returns its id. A note piece without a note gets the next note of the scale ("each new piece is
// the next piano key"); `note: null` adds it silent.
function addPieceRaw(spec) {
  const p = normPiece(Object.assign({ x: BOARD_W / 2, y: BOARD_H / 2 }, spec));
  if (!p) return null;
  if (!p.id || pieceById(p.id)) p.id = freshId();
  if (hasNote(p.type) && !(spec && spec.note === null)) {
    if (!p.note) p.note = nextScaleNote(MODEL.lastNote, MODEL.scale);
    MODEL.lastNote = p.note;
  }
  MODEL.pieces.push(p);
  return p.id;
}
function addPiece(spec) { return change(() => addPieceRaw(spec)); }
function updatePieceRaw(id, patch) {
  const p = pieceById(id);
  if (!p) return false;
  const merged = normPiece(Object.assign(copyPiece(p), patch, { id: p.id, type: p.type }));
  if (!merged) return false;
  if (HISTORY.pending) HISTORY.liveId = id;              // (the piece a drag or slider is changing: see frameDraws)
  if (hasNote(p.type) && !merged.note && !(patch && patch.note === null)) merged.note = p.note;   // (null: silence it)
  Object.assign(p, merged);
  if (patch && patch.note && hasNote(p.type)) MODEL.lastNote = p.note;
  return true;
}
function updatePiece(id, patch) { return change(() => updatePieceRaw(id, patch)); }
function removePiece(id) {
  return change(() => {
    const i = MODEL.pieces.findIndex((p) => p.id === id);
    if (i < 0) return false;
    MODEL.pieces.splice(i, 1);
    return true;
  });
}
function clearBoard() { return change(() => { MODEL.pieces = []; MODEL.demoId = null; MODEL.remixOf = null; MODEL.name = 'My marble run'; MODEL.lastNote = null; MODEL.timing = null; }); }
// A new tempo replaces a song's tempo map (the beat grid keeps its start and meter)
function setTempo(bpm) {
  return change(() => {
    MODEL.tempo = clamp(Math.round(bpm), 30, 300);
    if (MODEL.timing && MODEL.timing.tempoMap) { MODEL.timing = copyTiming(MODEL.timing); delete MODEL.timing.tempoMap; }
  }, 'tempo');
}
function loadLayoutUndoable(layout, demoId = null) { return change(() => { applyLayout(layout); MODEL.demoId = demoId; MODEL.remixOf = (layout && layout.remixOf) || null; }, 'load'); }

/* ---- Share links: the layout packed into the URL hash (works over file://) ----
 *  '#m=' + base64url(JSON [v, name, tempo, rows, timing?]); row = [id, typeIndex, x, y, rot, ...params, note, gain?,
 *  schedule] (note 0 = silent; gain only when it is not 1). Numbers keep full precision, so a shared demo replays
 *  identically. Links over 1 MB are ignored; rows that are not rows are skipped. */
const HASH_MAX = 2 << 20;                        // (2 MB, as for an imported file)
function b64urlEncode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(s) {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
function packLayout(L) {
  const rows = L.pieces.map((p) => {
    const r = [p.id, PIECE_TYPES.indexOf(p.type), p.x, p.y, p.rot];
    for (const k of PARAM_KEYS[p.type]) r.push(p[k]);
    if (hasNote(p.type)) { r.push(p.note || 0); if (p.gain != null && p.gain !== 1) r.push(p.gain); }
    if (p.type === 'dropper') {
      const s = p.schedule || { mode: 'manual' };
      r.push(s.mode === 'repeat' ? ['r', s.every] : s.mode === 'times' ? ['t', s.times] : 'm');
    }
    return r;
  });
  return b64urlEncode(JSON.stringify(L.timing ? [1, L.name, L.tempo, rows, L.timing] : [1, L.name, L.tempo, rows]));
}
function unpackLayout(str) {
  const a = JSON.parse(b64urlDecode(str));
  if (!Array.isArray(a) || a[0] !== 1) throw new Error('unknown share format');
  const pieces = [];
  for (const r of Array.isArray(a[3]) ? a[3] : []) {
    if (!Array.isArray(r)) continue;
    const type = PIECE_TYPES[r[1]];
    if (!type) continue;
    const p = { id: r[0], type, x: r[2], y: r[3], rot: r[4] };
    let i = 5;
    for (const k of PARAM_KEYS[type]) p[k] = r[i++];
    if (hasNote(type)) { p.note = r[i++] || null; if (typeof r[i] === 'number') p.gain = r[i++]; }
    if (type === 'dropper') {
      const s = r[i++];
      p.schedule = Array.isArray(s) && s[0] === 'r' ? { mode: 'repeat', every: s[1] } : Array.isArray(s) && s[0] === 't' ? { mode: 'times', times: s[1] } : { mode: 'manual' };
    }
    pieces.push(p);
  }
  const L = { v: 1, name: a[1], tempo: a[2], board: { w: BOARD_W, h: BOARD_H }, pieces };
  if (a[4] && typeof a[4] === 'object') L.timing = a[4];
  return L;
}
function shareURL() {
  const base = location.href.split('#')[0];
  return base + '#m=' + packLayout(getLayout());
}
// The run in the address bar's '#m=' link: a layout, null (no link), or { error } (a link that cannot be read)
function layoutFromHash() {
  const h = location.hash || '';
  const i = h.search(/[#&]m=/);
  if (i < 0) return null;
  if (h.length > HASH_MAX) { console.warn('The shared link is too long to be a marble run.'); return { error: 'too long' }; }
  const m = /^[A-Za-z0-9_-]+/.exec(h.slice(i + 3));
  try { if (!m) throw new Error('empty'); return unpackLayout(m[0]); } catch (e) { console.warn('Could not read the shared layout: ' + e.message); return { error: e.message }; }
}

/* ---- Autosave, recent runs and named save slots (localStorage) ----
 *  The autosave holds the run on the board (an unedited demo only as { v, demoId }: it is rebuilt from the songbook).
 *  'Recent runs' keeps the last 3 of YOUR runs that a demo, a link, an import or a saved run replaced, so opening
 *  something never loses your work. */
const SLOT_KEY = 'marbleMusic.slots', AUTO_KEY = 'marbleMusic.autosave', RECENT_KEY = 'marbleMusic.recent', MAX_SLOTS = 20, MAX_RECENT = 3;
const SAVE = { timer: 0, failed: '', warned: false, frameOk: true };
function autosaveNow() {
  clearTimeout(SAVE.timer); SAVE.timer = 0;
  if (!SAVE.frameOk) { SAVE.timer = setTimeout(autosaveNow, 1500); return; }   // never save a run that just failed to draw
  const L = MODEL.demoId ? { v: 1, name: MODEL.name, demoId: MODEL.demoId } : Object.assign(getLayout(), { demoId: null }, MODEL.remixOf ? { remixOf: MODEL.remixOf } : {});
  const err = store.set(AUTO_KEY, JSON.stringify(L));
  SAVE.failed = err || '';
  if (err && !SAVE.warned && typeof onAutosaveFailed === 'function') { SAVE.warned = true; onAutosaveFailed(err); }
}
function autosaveSoon() { clearTimeout(SAVE.timer); SAVE.timer = setTimeout(autosaveNow, 400); }
// never lose the last edit: flush when the page is hidden or closed
window.addEventListener('pagehide', () => { if (SAVE.timer) autosaveNow(); });
document.addEventListener('visibilitychange', () => { if (document.hidden && SAVE.timer) autosaveNow(); });
function readAutosave() {
  const L = store.json(AUTO_KEY, null);
  if (!L || typeof L !== 'object') return null;
  if (!Array.isArray(L.pieces)) {                          // an unedited demo: rebuild it
    const b = L.demoId && typeof MarbleDemos !== 'undefined' ? MarbleDemos.build(L.demoId) : null;
    return b ? Object.assign(JSON.parse(JSON.stringify(b.layout)), { demoId: L.demoId }) : null;
  }
  return L;
}
// Recent runs: [{ name, t, layout }], newest first
function listRecent() { const r = store.json(RECENT_KEY, []); return Array.isArray(r) ? r.filter((x) => x && x.layout && Array.isArray(x.layout.pieces)) : []; }
const runSig = (L) => JSON.stringify([L.tempo, L.timing || null, L.pieces]);
// Keep the run on the board in Recent before something replaces it (a user run only: not a demo, not empty, not the
// untouched starter run, not the same as the newest entry). Returns true when it was kept.
function stashUserRun() {
  if (MODEL.demoId || !MODEL.pieces.length) return false;
  const L = getLayout(), sig = runSig(L);
  if (typeof starterLayout === 'function') {                // the untouched starter run is not worth keeping
    const S = starterLayout();
    if (runSig({ tempo: S.tempo, timing: normTiming(S.timing), pieces: S.pieces.map(normPiece) }) === sig) return false;
  }
  const list = listRecent();
  if (list.length && runSig(list[0].layout) === sig) return false;
  if (MODEL.remixOf) L.remixOf = MODEL.remixOf;
  return addRecent(L);
}
// Put a layout at the top of Recent (an older copy of the same run moves up rather than doubling). True when stored.
function addRecent(L) {
  const sig = runSig(L), list = listRecent().filter((r) => runSig(r.layout) !== sig);
  list.unshift({ name: L.name || 'My marble run', t: Date.now(), layout: L });
  while (list.length > MAX_RECENT) list.pop();
  return !store.set(RECENT_KEY, JSON.stringify(list));
}
function listSlots() { const s = store.json(SLOT_KEY, []); return Array.isArray(s) ? s.filter((x) => x && x.layout) : []; }
function writeSlots(slots) { return store.set(SLOT_KEY, JSON.stringify(slots)); }
// Save the run under a name (a new slot first; `replace` = the index of a slot to overwrite). Returns an error kind
// ('quota' | 'blocked') or '' on success.
function saveSlot(name, replace = -1) {
  const slots = listSlots();
  const entry = { name, t: Date.now(), layout: Object.assign(getLayout(), { name }) };
  if (replace >= 0 && replace < slots.length) slots.splice(replace, 1);
  slots.unshift(entry);
  if (slots.length > MAX_SLOTS) return 'full';
  const err = writeSlots(slots);
  if (!err) MODEL.name = name;
  return err || '';
}
function deleteSlot(index) { const slots = listSlots(); const [gone] = slots.splice(index, 1); return gone && !writeSlots(slots) ? gone : null; }
function restoreSlot(entry, index) { const slots = listSlots(); slots.splice(Math.min(index, slots.length), 0, entry); return !writeSlots(slots); }
