
/* ============================================================================
 *  INPUT: building with mouse, touch and keyboard
 *  - Tray: drag a piece onto the board (it snaps to the pegboard holes, every 20 units; hold Alt for free
 *    placement), or tap it and then tap the board. A new piece plays its note (the next note of the scale).
 *  - Board: press a piece to select it and drag to move it; drag the yellow knob to turn it (15° steps,
 *    Shift 5°, Alt free); drag the white handles to resize; drag it back onto the tray to remove it.
 *    Drag empty board (one finger) to ORBIT the view round the point in the middle of the screen (a light spin
 *    after a quick drag; the selection stays through it, only a plain click on empty board deselects). While a demo
 *    plays a drag that starts on a piece orbits too, and the piece is picked up after a short hold (HOLD_MS);
 *    Shift-, right- or middle-drag (two fingers) to pan (the board stays under the pointer; let go while moving and it glides on);
 *    wheel or pinch to zoom (on a tower the wheel scrolls and Ctrl+wheel zooms; a two-finger twist turns the view);
 *    double-click a piece to zoom in on it; the wheel over the selected piece turns it. In the 2D view (front-on)
 *    a drag pans instead.
 *  - Keys: Delete, Ctrl/Cmd+Z / Shift+Z / Y, Ctrl/Cmd+D, R (Shift+R = 5°), Q turns back, arrows nudge
 *    (Shift: 1 unit), Alt+arrows orbit, 0 the front view of the whole board, Space plays/stops, D drops a marble,
 *    F fits, +/- zoom, Esc deselects, H help; on a tower Page Up / Page Down, Home / End and (nothing selected) the
 *    arrow keys scroll.
 * ========================================================================== */
const EDIT = { selected: null, hover: null, handle: null, drag: null, ghost: null, ghostOnBoard: false, lifted: null, placing: null, tapHint: false, pulse: 0, snap: null, timing: null };
const snapOn = (e) => !(e && e.altKey);
const snapV = (v, on) => (on ? Math.round(v / GRID) * GRID : Math.round(v * 10) / 10);
const onBoard = (x, y) => x >= -10 && x <= BOARD_W + 10 && y >= -10 && y <= BOARD_H + 10;
function stageEl() { return document.getElementById('stage'); }

function select(id, reveal = true) {
  const changed = EDIT.selected !== id;
  if (changed) { EDIT.selected = id; EDIT.pulse = id ? 1 : 0; }
  refreshInspector();
  if (changed && id && reveal) requestAnimationFrame(revealSelected);
}
// Which piece is under a board point? (topmost first; `tol` in board units)
function pieceAt(x, y, tol) {
  for (let i = MODEL.pieces.length - 1; i >= 0; i--) {
    const p = MODEL.pieces[i];
    if (p.type === 'dropper') { const dx = x - p.x, dy = y - p.y; if (Math.abs(dx) < 22 + tol && dy > -100 - tol && dy < 4 + tol) return p; continue; }
    if (p.type === 'bucket') { const c = Math.cos(-(p.rot || 0) * RAD), s = Math.sin(-(p.rot || 0) * RAD), lx = (x - p.x) * c - (y - p.y) * s, ly = (x - p.x) * s + (y - p.y) * c; if (Math.abs(lx) < 38 + tol && Math.abs(ly) < 33 + tol) return p; continue; }
    for (const c of CANON.colliders(p)) {
      if (c.shape === 'circle') { if (Math.hypot(x - c.x, y - c.y) < c.r + tol) return p; continue; }
      let t = ((x - c.ax) * c.abx + (y - c.ay) * c.aby) / c.len2; t = clamp(t, 0, 1);
      if (Math.hypot(x - c.ax - c.abx * t, y - c.ay - c.aby * t) < c.hw + tol) return p;
    }
    if (p.type === 'funnel') { const c = Math.cos(-(p.rot || 0) * RAD), s = Math.sin(-(p.rot || 0) * RAD), lx = (x - p.x) * c - (y - p.y) * s, ly = (x - p.x) * s + (y - p.y) * c; if (ly > -p.h / 2 && ly < p.h / 2 + 20 && Math.abs(lx) < 15 + (p.w / 2 - 15) * (1 - (ly + p.h / 2) / p.h)) return p; }
  }
  return null;
}
function handleAt(px, py, touch) {
  const p = EDIT.selected && pieceById(EDIT.selected);
  if (!p) return null;
  const hs = handlesOf(p), size = hs.length && hs[0].size ? hs[0].size : 100;
  const r = touch ? 22 : clamp(size * 0.3, 8, 13);             // small pieces: keep their middle free for moving
  let best = null, bd = r;
  for (const h of hs) { const d = Math.hypot(h.x - px, h.y - py); if (d < (h.kind === 'rot' ? Math.max(r, 11) : r) && d < bd) { bd = d; best = h; } }
  return best;
}
// Over the tray itself (not a panel lying on top of it): only there does letting go remove a piece
function overTray(px, py) {
  const r = tray.getBoundingClientRect();
  if (!(px >= r.left && px <= r.right && py >= r.top && py <= r.bottom)) return false;
  const hit = document.elementFromPoint(px, py);
  return !!(hit && hit.closest && hit.closest('#tray'));
}
function overUI(px, py) {
  const hit = document.elementFromPoint(px, py);
  return !!hit && hit !== stageEl() && hit.id !== 'fx' && hit !== document.body && hit !== document.documentElement;
}

/* ---- Adding pieces ----
 *  A new bar, rail or wall comes tilted (bar 20°, rail and wall 15°), so the first marble bounces off it once and
 *  rolls on, instead of stopping on a level piece. Its low end leans against the marble's sideways motion where a
 *  path passes just above (a zig-zag cascade builds itself), else towards the middle of the board. */
const TILT = { bar: 20, rail: 15, wall: 15 };
function newPieceSpec(type, x, y) {
  const spec = { type, x, y, rot: 0 };
  if (TILT[type]) spec.rot = TILT[type] * tiltSign(x, y);
  if (hasNote(type)) spec.note = nextScaleNote(MODEL.lastNote, MODEL.scale);
  if (type === 'dropper') spec.schedule = { mode: 'manual' };
  return normPiece(Object.assign({ id: '__ghost' }, spec));
}
// +1: the right end lower. A path coming down within 60 units above the spot decides (lean against its sideways
// speed there); otherwise lean towards the middle of the board.
function tiltSign(x, y) {
  const base = snapBase(EDIT.lifted);
  let best = null;
  for (const { pr } of base.paths) {
    const P = pr.path;
    for (let i = 1; i < P.length; i++) {
      const q = P[i];
      if (Math.abs(q[0] - x) <= 30 && q[1] >= y - 60 && q[1] <= y + 5) { if (!best || q[2] < best.t) best = { t: q[2], vx: (q[0] - P[i - 1][0]) / ((q[2] - P[i - 1][2]) || 1) }; break; }
    }
  }
  if (best && Math.abs(best.vx) > 15) return best.vx > 0 ? -1 : 1;
  return x < BOARD_W / 2 ? 1 : -1;
}

/* ---- Beat snap: a note piece dragged near a beat dot is placed so that its note lands exactly on that beat ----
 *  The paths are those WITHOUT the piece being dragged. Only landable beats count (where the marble is in free
 *  flight). The piece's centre goes to C = B + n (R + hw): n its downward normal (a dome: along the marble's
 *  motion), R the marble radius, hw the piece's half thickness; then the marble touches it just as it gets to B.
 *  Alt (free placement) turns it off. */
const SNAP_REACH = 24;
const SNAPC = { key: '', beats: [], paths: [] };
function snapBase(excludeId) {
  const key = (MODEL.epoch || 0) + '|' + (excludeId || '') + '|' + BEAT_CLOCK.key + '|' + MODEL.tempo + '|' + MODEL.pieces.length + '|' + BOARD_W + 'x' + BOARD_H;
  if (SNAPC.key === key) return SNAPC;
  layoutBeatClock();
  const pieces = excludeId ? MODEL.pieces.filter((p) => p.id !== excludeId) : MODEL.pieces;
  const L = simLayout(pieces), clk = layoutBeatClock(), cols = [], secs = previewSeconds();
  for (const p of pieces) for (const c of CANON.colliders(p)) cols.push(c);
  // (the paths of the whole run, as the preview has them; without the piece being moved they differ only from where
  //  its marble first comes near that piece: a tower's long paths are run again only from there)
  const full = previewPaths(MODEL.pieces, MODEL.version + '||' + MODEL.tempo, previewSeconds(), false), gone = excludeId ? [pieceById(excludeId)] : [];
  const beats = [], paths = [];
  for (const d of pieces) {
    if (d.type !== 'dropper') continue;
    const pr = excludeId ? predictReusing(L, d.id, secs, full.get(d.id), gone) : full.get(d.id) || predictRun(L, d.id, secs);
    paths.push({ d, pr });
    for (const b of pathBeats(d, pr, cols, clk, key)) if (b.landable) beats.push(Object.assign({ dropperId: d.id }, b));
  }
  SNAPC.key = key; SNAPC.beats = beats; SNAPC.paths = paths; SNAPC.tryKey = ''; SNAPC.excl = excludeId || null;
  // Can a bar take each beat cleanly (ring once, on the beat, and send the marble on)? A few dozen quick CANON runs;
  // a beat where it cannot is shown as a hollow ring too. (Big layouts skip this: every landable beat counts.)
  SNAPC.clean = new Map();
  if (beats.length <= 48) {
    const probe = { id: '__probe', type: 'bar', len: 70, note: 'C4' };
    for (const b of beats) { b.clean = !!cleanWay(Object.assign({}, probe, { rot: 20 }), b, excludeId, [[20, true], [-20, true], [20, false], [-20, false]], SNAPC); SNAPC.clean.set(b.dropperId + '|' + b.tp, b.clean); }
  }
  return SNAPC;
}
const SNAP_TYPES = { bar: 1, rail: 1, wall: 1, spring: 1, bell: 1 };
// Where piece p (at its grid spot; `raw` = the pointer's own board point) should go to ring on a nearby beat:
// { x, y, beat } or null. Near = the grid spot within 24 units of that place, or the pointer within about 22 px
// of the beat dot itself. A tilted bar, rail or wall is slid along its length so the marble strikes it near its
// low end: the marble leaves towards the low end (it bounces or rolls that way), so it cannot land on it again.
// A spot where the piece would touch the marble's path before that beat does not count.
function beatSnap(p, excludeId, raw) {
  if (!SNAP_TYPES[p.type] || !p.note) return null;
  const base = snapBase(excludeId), near = Math.max(SNAP_REACH, 22 / Math.max(0.05, VIEW.ppu()));
  let best = null, bd = Infinity;
  for (const b of base.beats) {
    if (b.clean === false) continue;
    const c = snapSpot(p, b, p.rot || 0, true);
    const d = Math.min(Math.hypot(c[0] - p.x, c[1] - p.y) / SNAP_REACH, raw ? Math.hypot(raw[0] - b.x, raw[1] - b.y) / near : Infinity, raw ? Math.hypot(raw[0] - c[0], raw[1] - c[1]) / near : Infinity);
    if (d <= 1 && d < bd) { bd = d; best = b; }
  }
  if (!best) return null;
  // the piece as it will be: its tilt either way, slid or centred; the first way that rings exactly once, on the beat
  const key = [best.dropperId, best.tp, p.type, p.len || p.r, p.rot, excludeId].join('|');
  if (SNAPC.tryKey === key) return SNAPC.tryRes;
  // (a new piece may lean either way; a piece being moved keeps the turn its builder gave it)
  const tilt = p.rot || 0, ways = p.type === 'bell' || !tilt ? [[tilt, false]] : excludeId ? [[tilt, true], [tilt, false]] : [[tilt, true], [-tilt, true], [tilt, false], [-tilt, false]];
  const res = cleanWay(p, best, excludeId, ways, base);
  SNAPC.tryKey = key; SNAPC.tryRes = res;
  return res;
}
// The first way (rot, slid?) of placing piece p on beat b that keeps clear of the marble before the beat, rings once
// on the beat (within 15 ms) and rings no piece a second time for the next 2.5 s; null if there is none
function cleanWay(p, b, excludeId, ways, base) {
  const entry = base.paths.find((e) => e.d.id === b.dropperId);
  if (!entry) return null;
  const others = excludeId ? MODEL.pieces.filter((o) => o.id !== excludeId) : MODEL.pieces;
  const baseHits = entry.pr.hits.filter((h) => h.t <= b.tp + 2.5);
  for (const [rot, slide] of ways) {
    const c = snapSpot(p, b, rot, slide), q = Object.assign({}, p, { id: '__snap', x: c[0], y: c[1], rot });
    if (touchesPathBefore(q, entry, b.tp - 0.02)) continue;
    const pr = predictReusing(simLayout(others.concat([q])), b.dropperId, Math.min(b.tp + 2.5, entry.pr.seconds || b.tp + 2.5), entry.pr, [q]), hits = pr.hits.filter((h) => h.pieceId === '__snap');
    if (hits.length === 1 && Math.abs(hits[0].t - b.tp) <= 0.015 && repeats(pr.hits) <= repeats(baseHits)) return { x: c[0], y: c[1], rot, beat: b };
  }
  return null;
}
const repeats = (hits) => hits.length - new Set(hits.map((h) => h.pieceId)).size;
// Where piece p (turned `rot`) goes to take beat b: its centre line R + hw under the marble there (a dome: along
// the marble's motion), slid along its length (a tilted bar, rail or wall) so the marble strikes it near its low end
function snapSpot(p, b, rot, slide) {
  const R = CANON.MARBLE_R, a = rot * RAD;
  if (p.type === 'bell') { const v = Math.hypot(b.vx, b.vy) || 1; return [b.x + (b.vx / v) * (R + p.r), b.y + (b.vy / v) * (R + p.r)]; }
  let nx = -Math.sin(a), ny = Math.cos(a);
  if (ny < 0) { nx = -nx; ny = -ny; }
  const off = R + CANON.HW[p.type], ux = Math.cos(a), uy = Math.sin(a), s = slide && Math.abs(uy) > 0.05 ? Math.max(0, p.len / 2 - 14) * (uy > 0 ? -1 : 1) : 0;
  return [b.x + nx * off + ux * s, b.y + ny * off + uy * s];
}
// Would piece q meet its dropper's marble before time t (path time)?
function touchesPathBefore(q, entry, t) {
  if (!entry) return false;
  const cols = CANON.colliders(q), P = entry.pr.path;
  for (let i = 0; i < P.length && P[i][2] < t; i++) {
    for (const c of cols) {
      let d;
      if (c.shape === 'circle') d = Math.hypot(P[i][0] - c.x, P[i][1] - c.y) - c.r;
      else { let u = ((P[i][0] - c.ax) * c.abx + (P[i][1] - c.ay) * c.aby) / c.len2; u = u < 0 ? 0 : u > 1 ? 1 : u; d = Math.hypot(P[i][0] - c.ax - c.abx * u, P[i][1] - c.ay - c.aby * u) - c.hw; }
      if (d < CANON.MARBLE_R + 1) return true;
    }
  }
  return false;
}
// How the dragged piece's first note lands against the nearest beat (for the label under it): from the current
// preview, worked out on every move (so the overlay then draws these same paths, fresh)
function dragTiming(id) {
  const pieces = previewPieces(), paths = previewPaths(pieces, previewKey()), clk = layoutBeatClock();
  let first = null;
  for (const [did, pr] of paths) for (const h of pr.hits) if (h.pieceId === id && (!first || h.t < first.t)) { first = { t: h.t + firstRelease(pieces.find((q) => q.id === did)) }; break; }
  if (!first) return null;
  const pulse = clk.pulse || 1, b = Math.round(clk.beatAt(first.t) / pulse) * pulse, err = first.t - clk.sec(b);
  const on = Math.abs(err) <= 0.015;
  return { on, err, text: on ? '✓ on the beat' : Math.round(Math.abs(err) * 1000) + ' ms ' + (err < 0 ? 'early' : 'late') };
}
// Place piece spec g (grid spot in g.x, g.y) with the beat snap; sets EDIT.snap
function snapPlace(g, e, excludeId, raw) {
  EDIT.snap = null;
  if (!snapOn(e)) return g;
  const sn = beatSnap(g, excludeId, raw);
  if (sn) { g.x = sn.x; g.y = sn.y; g.rot = sn.rot; EDIT.snap = sn; }
  return g;
}

function addFromTray(type, x, y, rot) {
  piano.init();
  const spec = newPieceSpec(type, x, y);
  delete spec.id;
  if (rot != null) spec.rot = rot;
  const id = addPiece(spec);
  const p = pieceById(id);
  select(id);
  if (p && p.note) { piano.play(noteFreq(p.note), 0.65, 0, PIECE_METAL[p.type], piecePan(p)); const f = fxOf(id); f.glow = 1; f.wiggle = 0.7; onNoteVisual({ pieceId: id, note: p.note }); }
  say(PIECE_INFO[type].name + (p && p.note ? ' ' + noteLabel(p.note) : '') + ' added');
  if (!store.get('marbleMusic.added')) {
    store.set('marbleMusic.added', '1');
    clearTimeout(UI.hintTimer);
    UI.hintTimer = setTimeout(() => { if (!hasDroppers() && MODEL.pieces.length) toast('Next: put a Dropper above it, then press Play.'); }, 900);
  }
  return id;
}
// A spot for a piece added from the keyboard: near the selected piece, or the middle of what you can see
function freeSpot() {
  const sel = EDIT.selected && pieceById(EDIT.selected);
  if (sel) return [snapV(sel.x + 60, true), snapV(sel.y + 60, true)];
  const r = uiSafeRect(), c = VIEW.s2b((r.l + r.r) / 2, (r.t + r.b) / 2);
  return [snapV(clamp(c[0], 40, BOARD_W - 40), true), snapV(clamp(c[1], 40, BOARD_H - 40), true)];
}

/* ---- Tray: drag onto the board, or tap then tap the board ---- */
function trayDown(e) {
  const b = e.currentTarget, type = b.dataset.type;
  if (e.button !== undefined && e.button !== 0) return;
  piano.init();
  if (UI.inspFull) { UI.inspFull = false; refreshInspector(); }       // (a phone's full editor folds back to the compact one)
  e.preventDefault();
  try { b.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
  EDIT.drag = { kind: 'tray', type, id: e.pointerId, x0: e.clientX, y0: e.clientY, moved: false, btn: b };
}
function trayMove(e) {
  const d = EDIT.drag;
  if (!d || d.kind !== 'tray' || e.pointerId !== d.id) return;
  keepPointer(trayMove, e);
  if (!d.moved && Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < 6) return;
  d.moved = true;
  cancelPlacing();
  const bp = VIEW.s2b(e.clientX, e.clientY);
  const sp = snapOn(e);
  const g = snapPlace(newPieceSpec(d.type, snapV(bp[0], sp), snapV(bp[1], sp)), e, null, bp);
  EDIT.ghostOnBoard = onBoard(g.x, g.y) && !overTray(e.clientX, e.clientY);
  EDIT.ghost = EDIT.ghostOnBoard ? g : null;
  if (!EDIT.ghost) EDIT.snap = null;
  if (EDIT.ghost) { touched('live'); EDIT.timing = hasNote(g.type) ? dragTiming('__ghost') : null; } else EDIT.timing = null;
}
function trayUp(e) {
  const d = EDIT.drag;
  if (!d || d.kind !== 'tray' || e.pointerId !== d.id) return;
  EDIT.drag = null;
  const g = EDIT.ghost;
  EDIT.ghost = null; EDIT.snap = null; EDIT.timing = null;
  if (!d.moved) { if (e.type === 'pointerup') startPlacing(d.type); return; }
  if (g && e.type === 'pointerup' && EDIT.ghostOnBoard) addFromTray(d.type, g.x, g.y, g.rot);
  else touched('live');
}
function startPlacing(type) {
  if (EDIT.placing === type) { cancelPlacing(); return; }
  cancelPlacing();
  EDIT.placing = type;
  TRAY_BTNS[type].classList.add('arm');
  toast((touchUI ? 'Tap' : 'Click') + ' the board to place the ' + PIECE_INFO[type].name.toLowerCase() + '.', null, null, 3500);
}
function cancelPlacing() {
  if (!EDIT.placing) return;
  TRAY_BTNS[EDIT.placing].classList.remove('arm');
  EDIT.placing = null;
}
function trayKey(e) {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  e.preventDefault();
  const [x, y] = freeSpot();
  addFromTray(e.currentTarget.dataset.type, x, y);
}

/* ---- The board ---- */
const POINTERS = new Map();                           // active touch/pen pointers (pinch)
const TWIST_DEAD = 8 * RAD;                           // a two-finger twist turns the view once it has passed this
const HOLD_MS = 250;                                  // a piece of a playing demo is picked up after this long held still (a quicker drag turns the view)
const SLIDE_PX = 16;                                  // two fingers pan (and pause following) after this much NET midpoint travel
function boardDown(e) {
  const stage = stageEl();
  piano.init();
  stage.focus({ preventScroll: true });
  const now = performance.now();
  for (const [id, q] of POINTERS) if (now - q.t > 3000) POINTERS.delete(id);   // (a finger whose pointerup never came: see clearPointers)
  POINTERS.set(e.pointerId, { x: e.clientX, y: e.clientY, t: now });
  try { stage.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
  const touch = e.pointerType !== 'mouse';
  if (POINTERS.size === 2) {                          // second finger: pinch (zoom), pan and twist (orbit) the view instead
    stopFling(); stopOrbitMotion();
    if (EDIT.drag && EDIT.drag.kind !== 'pinch') { if (EDIT.drag.kind === 'move' || EDIT.drag.kind === 'handle') { EDIT.lifted = null; endChange(); } }
    const ids = [...POINTERS.keys()], a = POINTERS.get(ids[0]), b = POINTERS.get(ids[1]);
    // (the fingers' places as of the last step taken, and which of them has moved since: see pinchStep)
    EDIT.drag = { kind: 'pinch', ids, pa: { x: a.x, y: a.y }, pb: { x: b.x, y: b.y }, fresh: [false, false], last: -1, run: 0, c0: [(a.x + b.x) / 2, (a.y + b.y) / 2],
      slid: false, d0: Math.hypot(a.x - b.x, a.y - b.y), a0: Math.atan2(b.y - a.y, b.x - a.x), twist: 0 };
    return;
  }
  if (POINTERS.size > 2) return;
  if (e.pointerType === 'mouse' && ((e.button !== undefined && e.button > 0) || e.shiftKey)) {   // right, middle or Shift-drag: pan
    stopFling(); stopOrbitMotion();
    EDIT.drag = { kind: 'pan', id: e.pointerId, lx: e.clientX, ly: e.clientY, x0: e.clientX, y0: e.clientY, moved: false };
    return;
  }
  const bp = VIEW.s2b(e.clientX, e.clientY);
  if (EDIT.placing) {                                 // tap-to-place
    const sp = snapOn(e), type = EDIT.placing;
    cancelPlacing();
    const x = snapV(bp[0], sp), y = snapV(bp[1], sp);
    if (onBoard(x, y)) addFromTray(type, x, y);
    return;
  }
  const h = handleAt(e.clientX, e.clientY, touch);
  if (h) { beginChange(); EDIT.handle = h.kind; EDIT.drag = { kind: 'handle', id: e.pointerId, h: h.kind }; return; }
  const tol = (touch ? 16 : 7) / Math.max(0.05, VIEW.ppu());
  const p = pieceAt(bp[0], bp[1], tol);
  if (p) {
    if (SIM.playing && MODEL.demoId && glOk) {         // a demo playing (not yet your run): a plain drag turns the view, even over a piece;
      stopFling(); stopOrbitMotion();                  // moving the piece takes a short hold (HOLD_MS), a tap still selects it
      const t0 = e.timeStamp || now, d = { kind: 'orbit', id: e.pointerId, lx: e.clientX, ly: e.clientY, x0: e.clientX, y0: e.clientY, touch, moved: false, pendingMove: p.id, t0, bx: bp[0], by: bp[1] };
      EDIT.drag = d;
      setTimeout(() => { if (EDIT.drag === d && d.pendingMove && !d.moved) holdToMove(d); }, HOLD_MS);
      return;
    }
    select(p.id);
    EDIT.drag = { kind: 'move', id: e.pointerId, pid: p.id, x0: e.clientX, y0: e.clientY, bx: bp[0], by: bp[1], px: p.x, py: p.y, moved: false };
    return;
  }
  stopFling(); stopOrbitMotion();
  // empty board: orbit the 3D view (the 2D view, front-on, pans). The selection stays through a drag (turning the
  // view to look at the selected piece from another side is the point); only a plain click on empty board
  // deselects it (boardUp).
  EDIT.drag = { kind: glOk ? 'orbit' : 'pan', id: e.pointerId, lx: e.clientX, ly: e.clientY, x0: e.clientX, y0: e.clientY, touch, moved: false, fromEmpty: true };
}
// A drag that began on a piece of a playing demo has been held still for HOLD_MS: it is a normal move drag now
function holdToMove(d) {
  const p = pieceById(d.pendingMove);
  d.pendingMove = null;
  if (!p || EDIT.drag !== d) return;
  select(p.id);
  EDIT.drag = { kind: 'move', id: d.id, pid: p.id, x0: d.x0, y0: d.y0, bx: d.bx, by: d.by, px: p.x, py: p.y, moved: false };
}
// A finger (or pen) whose pointerup never came (capture lost, the window blurred or hidden, the canvas replaced under
// a drag) would stay in POINTERS, and every next finger would be taken for the second of a pinch: let them all go
function clearPointers() {
  POINTERS.clear();
  const d = EDIT.drag;
  if (d && (d.kind === 'pinch' || d.kind === 'orbit' || d.kind === 'pan')) { EDIT.drag = null; try { stageEl().style.cursor = ''; } catch (e) { /* no stage yet */ } }
}
// One step of a two-finger gesture, from the fingers' places now (a, b) and as of the last step (d.pa, d.pb): pinching
// zooms (about the marble while following, else about the midpoint), twisting turns the yaw (past a dead zone), and
// moving the midpoint slides the board. Whether this is a slide is decided from the NET travel of the midpoint since
// the gesture began (SLIDE_PX), not from the sum of its steps, so a steady pinch never lets go of the followed marble;
// only a slide pauses the follow camera (the twist and the zoom never do).
function pinchStep(d, a, b) {
  const dist = Math.hypot(a.x - b.x, a.y - b.y), cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2, px = (d.pa.x + d.pb.x) / 2, py = (d.pa.y + d.pb.y) / 2;
  if (!d.slid && Math.hypot(cx - d.c0[0], cy - d.c0[1]) > SLIDE_PX) d.slid = true;
  const following = TFOLLOW.active && !TFOLLOW.paused, grab = VIEW.s2b(px, py);   // (the board point that was under the midpoint)
  if (d.d0 > 10 && dist > 10) zoomAt(cx, cy, dist / d.d0);
  if (glOk) {
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    let da = ang - d.a0; if (da > Math.PI) da -= 2 * Math.PI; else if (da < -Math.PI) da += 2 * Math.PI;
    d.a0 = ang;
    const was = d.twist; d.twist += da;
    const use = Math.max(0, Math.abs(d.twist) - TWIST_DEAD) * Math.sign(d.twist) - Math.max(0, Math.abs(was) - TWIST_DEAD) * Math.sign(was);
    if (use) orbitBy(use, 0);
  }
  if (d.slid || !following) panGrabPoint(grab, cx, cy, d.slid);     // (a followed view stays put until the slide is certain)
  d.pa.x = a.x; d.pa.y = a.y; d.pb.x = b.x; d.pb.y = b.y; d.d0 = dist;
}
function boardMove(e) {
  if (POINTERS.has(e.pointerId)) POINTERS.set(e.pointerId, { x: e.clientX, y: e.clientY, t: performance.now() });
  const d = EDIT.drag;
  if (!d) {                                           // hover (mouse)
    if (e.pointerType === 'mouse') {
      const bp = VIEW.s2b(e.clientX, e.clientY);
      const h = handleAt(e.clientX, e.clientY, false);
      const p = h ? null : pieceAt(bp[0], bp[1], 7 / Math.max(0.05, VIEW.ppu()));
      EDIT.hover = p ? p.id : null;
      stageEl().style.cursor = EDIT.placing ? 'crosshair' : h ? (h.kind === 'rot' ? 'grab' : 'nwse-resize') : p ? 'move' : 'grab';
    }
    return;
  }
  if (d.kind === 'pinch') {
    // pointermove arrives one finger at a time, so the midpoint of the fingers' CURRENT places jitters by half a
    // finger step per event even in a perfectly symmetric pinch. A step is taken only when both fingers have moved
    // since the last one (or the same finger twice running: the other is resting), from the places both had then.
    const i = d.ids.indexOf(e.pointerId);
    if (i < 0 || POINTERS.size < 2 || !POINTERS.has(d.ids[0]) || !POINTERS.has(d.ids[1])) return;
    d.run = d.last === e.pointerId ? d.run + 1 : 1; d.last = e.pointerId; d.fresh[i] = true;
    if (!(d.fresh[0] && d.fresh[1]) && d.run < 2) return;
    d.fresh[0] = d.fresh[1] = false;
    pinchStep(d, POINTERS.get(d.ids[0]), POINTERS.get(d.ids[1]));
    return;
  }
  if (e.pointerId !== d.id) return;
  if (d.kind === 'pan') {                            // (the fling's speed from the events' own times: a busy frame does not slow it)
    const now = e.timeStamp || performance.now(), dtm = Math.max(1, now - (d.lt || now - 16)), k = Math.min(1, dtm / 50);
    d.vx = (d.vx || 0) * (1 - k) + ((e.clientX - d.lx) / dtm * 1000) * k; d.vy = (d.vy || 0) * (1 - k) + ((e.clientY - d.ly) / dtm * 1000) * k; d.lt = now;
    if (!d.moved && Math.hypot(e.clientX - d.x0, e.clientY - d.y0) >= 4) d.moved = true;
    panGrab(d.lx, d.ly, e.clientX, e.clientY); d.lx = e.clientX; d.ly = e.clientY; stageEl().style.cursor = 'grabbing';
    return;
  }
  if (d.kind === 'orbit') {                          // drag right: the view swings left round the target (the board turns with the pointer)
    if (d.pendingMove && (e.timeStamp || performance.now()) - d.t0 >= HOLD_MS && Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < 4) { holdToMove(d); return; }   // (held still: the timer may have been late)
    if (!d.moved && Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < 4) return;
    if (!d.moved) { d.moved = true; d.pendingMove = null; orbitHint(d.touch); }
    const g = orbitGain(), dy = -(e.clientX - d.lx) * g, dp = (e.clientY - d.ly) * g * PITCH_GAIN;
    const now = e.timeStamp || performance.now(), dtm = Math.max(1, now - (d.lt || now - 16)), k = Math.min(1, dtm / 50);
    d.vy = (d.vy || 0) * (1 - k) + (dy / dtm * 1000) * k; d.vp = (d.vp || 0) * (1 - k) + (dp / dtm * 1000) * k; d.lt = now;
    orbitBy(dy, dp);
    d.lx = e.clientX; d.ly = e.clientY; stageEl().style.cursor = 'grabbing';
    return;
  }
  const bp = VIEW.s2b(e.clientX, e.clientY);
  if (d.kind === 'move') {
    if (!d.moved && Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < 4) return;
    keepPointer(boardMove, e);
    if (!d.moved) { d.moved = true; beginChange(); EDIT.lifted = d.pid; snapBase(d.pid); }
    const sp = snapOn(e);
    const p = pieceById(d.pid);
    if (!p) return;
    const g = snapPlace(Object.assign(copyPiece(p), { x: snapV(d.px + bp[0] - d.bx, sp), y: snapV(d.py + bp[1] - d.by, sp) }), e, d.pid, [d.px + bp[0] - d.bx, d.py + bp[1] - d.by]);
    const nx = clamp(g.x, -20, BOARD_W + 20), ny = clamp(g.y, -20, BOARD_H + 20);
    if (p.x !== nx || p.y !== ny) { updatePieceRaw(d.pid, { x: nx, y: ny }); touched('live'); }
    EDIT.timing = hasNote(p.type) ? dragTiming(d.pid) : null;
    const trash = overTray(e.clientX, e.clientY);
    tray.classList.toggle('trash', trash);
    return;
  }
  if (d.kind === 'handle') { dragHandle(d.h, bp, e); return; }
}
function boardUp(e) {
  POINTERS.delete(e.pointerId);
  const d = EDIT.drag;
  if (!d) return;
  if (d.kind === 'pinch') { if (POINTERS.size === 0) EDIT.drag = null; return; }
  if (e.pointerId !== d.id) return;
  EDIT.drag = null;
  stageEl().style.cursor = '';
  if ((d.kind === 'pan' || d.kind === 'orbit') && d.fromEmpty && !d.moved && e.type === 'pointerup') select(null);   // a plain click on empty board deselects
  if (d.kind === 'orbit' && d.pendingMove && !d.moved && e.type === 'pointerup') select(d.pendingMove);              // a tap on a piece of a playing demo selects it
  if (d.kind === 'pan' && d.lt && (e.timeStamp || performance.now()) - d.lt < 80 && Math.hypot(d.vx, d.vy) > 250 && !reducedMotion) { FLING.vx = d.vx; FLING.vy = d.vy; return; }
  if (d.kind === 'orbit') {                          // let go while turning: it spins on a little (at most ~20°) and settles
    if (d.moved && d.lt && (e.timeStamp || performance.now()) - d.lt < 80 && Math.hypot(d.vy, d.vp) > 0.6 && !reducedMotion) { ORBIT.vyaw = clamp(d.vy, -SPIN_MAX, SPIN_MAX); ORBIT.vpitch = clamp(d.vp, -SPIN_MAX, SPIN_MAX); }
    return;
  }
  if (d.kind === 'move') {
    EDIT.lifted = null; EDIT.snap = null; EDIT.timing = null;
    tray.classList.remove('trash');
    if (d.moved && e.type === 'pointerup' && overTray(e.clientX, e.clientY)) {   // dragged back to the tray: remove
      const pid = d.pid;
      endChange();
      removePiece(pid); select(null);
      toast('Piece removed.', 'Undo', () => undo());
      return;
    }
    if (d.moved) endChange(); else touched('live');
    return;
  }
  if (d.kind === 'handle') { EDIT.handle = null; endChange(); refreshInspector(); return; }
}
// Resize / turn with a handle (board point bp)
function dragHandle(kind, bp, e) {
  const p = pieceById(EDIT.selected);
  if (!p) return;
  const a = (p.rot || 0) * RAD, ca = Math.cos(a), sa = Math.sin(a);
  const R = CANON.PIECES[p.type].ranges;
  let patch = null;
  if (kind === 'rot') {
    let ang = Math.atan2(bp[1] - p.y, bp[0] - p.x) / RAD + 90;
    if (p.type === 'curve') ang -= p.sweep / 2;
    const step = e.altKey ? 1 : e.shiftKey ? 5 : 15;
    ang = Math.round(ang / step) * step;
    ang = ((ang % 360) + 540) % 360 - 180;
    patch = { rot: ang };
  } else if (kind === 'len0' || kind === 'len1') {
    const s = kind === 'len1' ? 1 : -1, fx = p.x - s * ca * p.len / 2, fy = p.y - s * sa * p.len / 2;   // the other end stays put
    let L = ((bp[0] - fx) * ca + (bp[1] - fy) * sa) * s;
    L = clamp(Math.round(L / 10) * 10, R.len[0], R.len[1]);
    patch = { len: L, x: Math.round((fx + s * ca * L / 2) * 100) / 100, y: Math.round((fy + s * sa * L / 2) * 100) / 100 };
  } else if (kind === 'r') {
    const r = Math.hypot(bp[0] - p.x, bp[1] - p.y);
    patch = { r: clamp(Math.round(r / (p.type === 'bell' ? 2 : 5)) * (p.type === 'bell' ? 2 : 5), R.r[0], R.r[1]) };
  } else if (kind === 'sweep') {
    let s = (Math.atan2(bp[1] - p.y, bp[0] - p.x) / RAD - p.rot) % 360;
    if (s < 0) s += 360;
    patch = { sweep: clamp(Math.round(s / 15) * 15 || 15, R.sweep[0], R.sweep[1]) };
  } else if (kind === 'w' || kind === 'h') {
    const lx = (bp[0] - p.x) * ca + (bp[1] - p.y) * sa, ly = -(bp[0] - p.x) * sa + (bp[1] - p.y) * ca;
    patch = kind === 'w' ? { w: clamp(Math.round(Math.abs(lx) * 2 / 10) * 10, R.w[0], R.w[1]) } : { h: clamp(Math.round((ly - 20) * 2 / 10) * 10, R.h[0], R.h[1]) };
  }
  if (patch) { updatePieceRaw(p.id, patch); touched('live'); }
}
function boardWheel(e) {
  e.preventDefault();
  const sel = EDIT.selected && pieceById(EDIT.selected);
  if (sel && sel.type !== 'dropper' && !e.ctrlKey) {
    const bp = VIEW.s2b(e.clientX, e.clientY);
    const on = pieceAt(bp[0], bp[1], 10 / Math.max(0.05, VIEW.ppu()));
    if (on && on.id === sel.id) {
      const now = performance.now();
      if (now - (EDIT.wheelT || 0) < 90) return;       // one step per notch (trackpads send streams)
      EDIT.wheelT = now;
      rotateSelected((e.deltaY > 0 ? 1 : -1) * (e.shiftKey ? 5 : 15));
      return;
    }
  }
  // a tower scrolls (Shift: sideways); Ctrl+wheel and a trackpad pinch (which arrives as Ctrl+wheel) zoom
  if (tallBoard() && !e.ctrlKey && !e.metaKey) {
    const u = e.deltaMode === 1 ? 32 : e.deltaMode === 2 ? view.h * 0.9 : 1;
    let dx = e.deltaX * u, dy = e.deltaY * u;
    if (e.shiftKey && !dx) { dx = dy; dy = 0; }
    scrollView(dx, dy);
    return;
  }
  const k = Math.exp(-clamp(e.deltaY * (e.deltaMode === 1 ? 16 : 1), -120, 120) * 0.0022);
  zoomAt(e.clientX, e.clientY, k);
}

/* ---- Editing commands (buttons, keys and the API use these) ---- */
function rotateSelected(deg) {
  const p = EDIT.selected && pieceById(EDIT.selected);
  if (!p || p.type === 'dropper') return;
  let r = (p.rot || 0) + deg;
  r = ((r % 360) + 540) % 360 - 180;
  updatePiece(p.id, { rot: Math.round(r * 100) / 100 });
}
function nudgeSelected(dx, dy) {
  const p = EDIT.selected && pieceById(EDIT.selected);
  if (!p) return;
  updatePiece(p.id, { x: clamp(p.x + dx, -20, BOARD_W + 20), y: clamp(p.y + dy, -20, BOARD_H + 20) });
}
function deleteSelected() {
  const id = EDIT.selected;
  if (!id || !pieceById(id)) return;
  removePiece(id);
  select(null);
  toast('Piece removed.', 'Undo', () => undo(), 6000);
}
function duplicateSelected() {
  const p = EDIT.selected && pieceById(EDIT.selected);
  if (!p) return null;
  const c = copyPiece(p);
  delete c.id;
  c.x = clamp(p.x + 2 * GRID, 0, BOARD_W); c.y = clamp(p.y + 2 * GRID, 0, BOARD_H);
  const id = change(() => { const nid = addPieceRaw(c); return nid; });
  select(id);
  const q = pieceById(id);
  if (q && q.note) { piano.play(noteFreq(q.note), 0.55, 0, PIECE_METAL[q.type], piecePan(q)); fxOf(id).glow = 1; }
  return id;
}

/* ---- The view: orbit, pan, zoom, fit, scroll a tower, follow the marble ----
 *  VIEWCAM holds the user's pan (board units) and zoom on top of the fitted camera (zoom 1 = the whole board), and
 *  CAMERA (75-render.js) the orbit: yaw and pitch about the TARGET, the board point in the middle of the free area.
 *  All of it works at all times, playing included: orbiting a marble being followed swings round it. A Wide board is
 *  shown whole and a run is framed when it opens (its pieces fill the screen). A TOWER (tallBoard) is worked on at
 *  its HOME zoom, the board's width across the screen, and scrolled along: the wheel or a trackpad scrolls
 *  (Ctrl+wheel and pinch zoom), a Shift-, right- or middle-drag (two fingers) pans (with a fling), the minimap
 *  jumps, Page Up / Page Down, Home / End and the arrow keys (nothing selected) scroll. A plain drag (one finger)
 *  orbits; Alt+arrows orbit in steps; the view widget (85-ui.js) orbits too and shows the angle. Fit (F) toggles
 *  the whole board and the run, both from the front; 0 and Reset view go back to the front view.
 *  During a session on a tower the camera FOLLOWS the lead marble (followCam): look-ahead from its predicted path
 *  keeps the next pieces in view below it, a critically damped spring keeps the motion calm, and a jump of more than
 *  a screen glides. Panning by hand pauses it (orbit, tilt and zoom do not); the Follow button (or a new Play)
 *  resumes it. On a phone, a Wide board's demo is followed sideways instead (followWide).
 *  Measures: VIEW.ppu() and viewSpan() are front-on at the target (a pure function of the camera's distance), so
 *  nothing here changes with the angle; viewCentre() is the target itself; panBy() moves the board with the pointer
 *  through the real camera. */
const VIEWMODE = { mode: 'board' };                  // 'board' (whole board), 'run' (framed), 'free' (the user's own)
const ZOOM_MIN = 0.75;
function applyCam() { RENDER.applyCam(); OVL.sig = ''; }
function rectCentre(r) { return [(r.l + r.r) / 2, (r.t + r.b) / 2]; }
// The board point in the middle of the free screen area (the target), and the board span that area shows front-on
function viewCentre() { const c = rectCentre(uiSafeRect()); return VIEW.s2b(c[0], c[1]); }
function viewSpan(r = uiSafeRect()) { const ppu = Math.max(1e-6, VIEW.ppu()); return [(r.r - r.l) / ppu, (r.b - r.t) / ppu]; }
// The camera's distance from the target (the 3D camera's own; front-on equivalent for the 2D view)
function camDist() { return glOk && GLR.cam.D ? GLR.cam.D : view.h / (2 * Math.max(1e-6, VIEW.ppu()) * Math.tan(fovYNow() / 2)); }
function fovYNow() { return glOk && GLR.cam.fovY ? GLR.cam.fovY : 2 * Math.atan(Math.tan(CAMERA.fovDiag / 2) * view.h / Math.max(1, Math.hypot(view.w, view.h))); }
const zoomForDist = (dist) => VIEWCAM.zoom * camDist() / Math.max(1, dist);

/* ---- Orbit: yaw / pitch about the target. The limits are eased into (soft): within the last 12% of a range every step
 *  towards the limit is scaled by the distance still to go (an exponential approach: a drag slows down as it nears a
 *  limit, never snaps and never passes it), while a step away from it is taken in full at once, so a view that sits at
 *  a limit (the floor pushed it there, or a drag held it there) answers the first pixel of a drag the other way. A
 *  quick drag let go spins on and settles (ORBIT.vyaw / vpitch). The cinematic swing (UI.cinematic, the demo strip)
 *  adds a slow sine on top while a demo plays (CAMERA.autoYaw / autoPitch), fading in and out. */
const ORBIT = { vyaw: 0, vpitch: 0, glide: null, autoT: 0, autoK: 0 };
const SOFT = 0.12;
const PITCH_GAIN = 0.55;                              // tilting is slower than turning (a pitch range is only 90°, a yaw range 150°)
const SPIN_MAX = 1.5;                                 // rad/s: the spin after a flick travels at most SPIN_MAX / SPIN_DECAY = ~19°
const SPIN_DECAY = 4.5;                               // 1/s
// Add d to the angle v (limits lo..hi, the last SOFT of the range eased into)
function softAdd(v, d, lo, hi) {
  const w = Math.max(1e-6, (hi - lo) * SOFT);
  v = clamp(v, lo, hi);
  if (d > 0) {
    const lin = Math.min(d, Math.max(0, hi - w - v)); v += lin; d -= lin;
    if (d > 0) v = hi - (hi - v) * Math.exp(-d / w);
  } else if (d < 0) {
    const lin = Math.min(-d, Math.max(0, v - lo - w)); v -= lin; d += lin;
    if (d < 0) v = lo + (v - lo) * Math.exp(d / w);
  }
  return clamp(v, lo, hi);
}
const yawLimits = () => [-CAMERA.yawMax, CAMERA.yawMax];
function pitchLimits() { const c = glOk && GLR.cam.target; return [c ? pitchFloor(c[1], GLR.cam.D) : CAMERA.pitchMin, CAMERA.pitchMax]; }
function orbitRaw() { return [CAMERA.yaw, CAMERA.pitch]; }       // (the angles a turn starts from)
// radians per px: a fixed angular rate however small the screen (0.16°/px on a phone or tablet, 0.127°/px on a 1280 px
// desktop, where a drag across the screen turns ~160°); tilting uses PITCH_GAIN of it
function orbitGain() { return 0.9 * Math.PI / Math.max(1024, view.w); }
function stopOrbitMotion() { ORBIT.vyaw = ORBIT.vpitch = 0; ORBIT.glide = null; }
// Turn by (dyaw, dpitch) radians
function orbitBy(dyaw, dpitch) {
  if (!glOk) return;
  ORBIT.glide = null;
  const y = yawLimits(), p = pitchLimits();
  CAMERA.yaw = softAdd(CAMERA.yaw, dyaw, y[0], y[1]); CAMERA.pitch = softAdd(CAMERA.pitch, dpitch, p[0], p[1]);
  applyCam(); refreshViewCube();
}
// Glide to an orientation (radians) over dur s (at once with reduced motion)
function orbitTo(yaw, pitch, dur = 0.5) {
  if (!glOk) return;
  const y = yawLimits(), p = pitchLimits();
  yaw = clamp(yaw, y[0], y[1]); pitch = clamp(pitch, p[0], p[1]);
  ORBIT.vyaw = ORBIT.vpitch = 0;
  if (reducedMotion || dur <= 0) { ORBIT.glide = null; CAMERA.yaw = yaw; CAMERA.pitch = pitch; applyCam(); refreshViewCube(); return; }
  ORBIT.glide = { y0: CAMERA.yaw, p0: CAMERA.pitch, y1: yaw, p1: pitch, t: 0, dur };
}
function orbitStep(dyaw, dpitch) { const y = yawLimits(), p = pitchLimits(); orbitTo(softAdd(CAMERA.yaw, dyaw, y[0], y[1]), softAdd(CAMERA.pitch, dpitch, p[0], p[1]), 0.25); }
function frontView(dur = 0.5) { orbitTo(CAMERA.yaw0, CAMERA.pitch0, dur); }
const isFrontView = () => Math.abs(CAMERA.yaw - CAMERA.yaw0) < 0.5 * RAD && Math.abs(CAMERA.pitch - CAMERA.pitch0) < 0.5 * RAD;
// Run fn with the camera at the front view (for measuring a fit), then put the orbit back
function withFrontCam(fn) {
  const y = CAMERA.yaw, p = CAMERA.pitch, ay = CAMERA.autoYaw, ap = CAMERA.autoPitch;
  CAMERA.yaw = CAMERA.yaw0; CAMERA.pitch = CAMERA.pitch0; CAMERA.autoYaw = CAMERA.autoPitch = 0;
  try { fn(); } finally { CAMERA.yaw = y; CAMERA.pitch = p; CAMERA.autoYaw = ay; CAMERA.autoPitch = ap; applyCam(); }
}
// Is the camera being moved by hand or on its own (orbit drag, pinch, pan, a glide, the spin after a flick, the
// Cinematic swing, a fling)? The shadow cascades take a wider margin while it is (updateShadowRegion).
function cameraMoving() {
  const d = EDIT.drag;
  return !!((d && ((d.kind === 'orbit' && d.moved) || d.kind === 'pinch' || (d.kind === 'pan' && d.moved))) || ORBIT.glide || ORBIT.vyaw || ORBIT.vpitch || ORBIT.autoK > 0
    || VIEWCAM.glide || VIEWCAM.anim || FLING.vx || FLING.vy);
}
// Each frame: the glide, the spin after a drag, the cinematic swing
function stepOrbit(dt) {
  if (!glOk) return;
  let changed = false;
  const G = ORBIT.glide;
  if (G) {
    G.t = Math.min(1, G.t + dt / G.dur);
    const e = G.t < 0.5 ? 2 * G.t * G.t : 1 - Math.pow(-2 * G.t + 2, 2) / 2;
    CAMERA.yaw = lerp(G.y0, G.y1, e); CAMERA.pitch = lerp(G.p0, G.p1, e);
    if (G.t >= 1) ORBIT.glide = null;
    changed = true;
  } else if (ORBIT.vyaw || ORBIT.vpitch) {
    const k = Math.exp(-dt * SPIN_DECAY), run = (1 - k) / SPIN_DECAY;   // (the exact distance covered in dt: the same spin at any frame rate)
    const y = yawLimits(), p = pitchLimits();
    CAMERA.yaw = softAdd(CAMERA.yaw, ORBIT.vyaw * run, y[0], y[1]); CAMERA.pitch = softAdd(CAMERA.pitch, ORBIT.vpitch * run, p[0], p[1]);
    ORBIT.vyaw *= k; ORBIT.vpitch *= k;
    if (Math.hypot(ORBIT.vyaw, ORBIT.vpitch) < 0.02) ORBIT.vyaw = ORBIT.vpitch = 0;
    changed = true;
  }
  // (Cinematic is a demo-strip preference: a remembered '1' does not swing the builder's own run, whose strip, and so
  //  whose toggle, is hidden; a Remix keeps its demo's strip)
  const swing = UI.cinematic && SIM.session && !!stripDemo() && !reducedMotion && !(EDIT.drag && (EDIT.drag.kind === 'orbit' || EDIT.drag.kind === 'pinch'));
  if (swing) {
    ORBIT.autoT += dt; ORBIT.autoK = Math.min(1, ORBIT.autoK + dt / 2.5);
    CAMERA.autoYaw = ORBIT.autoK * 0.34 * Math.sin(ORBIT.autoT * 2 * Math.PI / 30);
    CAMERA.autoPitch = ORBIT.autoK * (0.06 * Math.sin(ORBIT.autoT * 2 * Math.PI / 21 + 1.2) + 0.05);
    changed = true;
  } else if (CAMERA.autoYaw || CAMERA.autoPitch) {
    const k = Math.exp(-dt / 0.7);
    CAMERA.autoYaw *= k; CAMERA.autoPitch *= k;
    if (Math.abs(CAMERA.autoYaw) + Math.abs(CAMERA.autoPitch) < 2e-4) { CAMERA.autoYaw = CAMERA.autoPitch = 0; ORBIT.autoT = 0; }
    ORBIT.autoK = 0;
    changed = true;
  }
  if (changed) { applyCam(); refreshViewCube(); }
}
// The first time the view is turned by hand: say what does what (remembered: 'marbleMusic.orbitHint')
function orbitHint(touch) {
  if (store.get('marbleMusic.orbitHint')) return;
  store.set('marbleMusic.orbitHint', '1');
  toast(touch ? 'You are turning the view. Two fingers slide it, pinch zooms; the compass puts it back.'
    : 'You are turning the view. Shift-drag slides it, the wheel ' + (tallBoard() ? 'scrolls' : 'zooms') + '; the compass puts it back.', null, null, 5000);
}
// Zoom in on a piece (double-click): it takes about two thirds of the free area
function zoomToPiece(p) {
  const r = uiSafeRect(), size = Math.max(60, pieceReach(p) * 2 + 20);
  const want = Math.min(r.r - r.l, r.b - r.t) * 0.7 / size;
  const z = clamp(VIEWCAM.zoom * want / Math.max(1e-6, VIEW.ppu()), ZOOM_MIN, zoomMax());
  setViewMode('free'); TFOLLOW.userZoom = true;
  const aim = TFOLLOW.active && !TFOLLOW.paused && followAim();
  if (aim) { glideTo(aim.x, aim.y, z, 0.5); return; }            // following: only the zoom glides (it lands on the marble's moving aim)
  pauseFollow();
  glideTo(p.x, p.y, z, 0.5);
}
// The camera as the API reports it: angles in degrees, the distance, the target (board units), following
function cameraState() {
  const c = viewCentre(), yaw = glOk && GLR.cam.yaw != null ? GLR.cam.yaw : 0, pitch = glOk && GLR.cam.pitch != null ? GLR.cam.pitch : 0;
  return { yaw: Math.round(yaw / RAD * 100) / 100, pitch: Math.round(pitch / RAD * 100) / 100, dist: Math.round(camDist() * 10) / 10,
    target: [Math.round(c[0] * 10) / 10, Math.round(c[1] * 10) / 10], following: TFOLLOW.active && !TFOLLOW.paused };
}
// Set the camera at once (the API): yaw / pitch in degrees (clamped to the limits), dist, target [x, y]
function setCameraState(o) {
  o = o || {};
  stopOrbitMotion(); VIEWCAM.glide = null; VIEWCAM.anim = null; SCROLLQ.x = SCROLLQ.y = 0; stopFling();
  if (glOk) {
    if (o.yaw != null && Number.isFinite(+o.yaw)) CAMERA.yaw = clamp(+o.yaw * RAD, -CAMERA.yawMax, CAMERA.yawMax);
    if (o.pitch != null && Number.isFinite(+o.pitch)) CAMERA.pitch = clamp(+o.pitch * RAD, CAMERA.pitchMin, CAMERA.pitchMax);
  }
  if (o.dist != null && +o.dist > 0) { VIEWCAM.zoom = clamp(zoomForDist(+o.dist), ZOOM_MIN, zoomMax()); TFOLLOW.userZoom = true; setViewMode('free'); }
  applyCam();
  if (Array.isArray(o.target) && Number.isFinite(+o.target[0]) && Number.isFinite(+o.target[1])) { pauseFollow(); setViewMode('free'); setViewCentre(+o.target[0], +o.target[1]); }
  else clampPan();
  refreshViewCube();
  return cameraState();
}
// Keep the board in view: the middle of the fitted area may pass the board's edge by a third of the view at most
// (measured in the area the whole board is fitted to, so the untouched fitted view never moves)
function clampPan() {
  const r = boardFitRect(), B = FIT_BOX, [sw, sh] = viewSpan(r), cp = rectCentre(r), c = VIEW.s2b(cp[0], cp[1]);
  const lim = (lo, hi, span, v) => { const pad = span * 0.3 + 40; let a = lo + span / 2 - pad, b = hi - span / 2 + pad; if (a > b) a = b = (lo + hi) / 2; return v < a ? a : v > b ? b : v; };
  const dx = lim(B.x0, B.x1, sw, c[0]) - c[0], dy = lim(B.y0, B.y1, sh, c[1]) - c[1];
  if (Math.abs(dx) > 1e-6 || Math.abs(dy) > 1e-6) { VIEWCAM.panX += dx; VIEWCAM.panY += dy; applyCam(); }
}
// Put board point (x, y) in the middle of the free screen area (panning moves the camera along the board, so this
// is exact in one step)
function setViewCentre(x, y) {
  const c = viewCentre();
  VIEWCAM.panX += x - c[0]; VIEWCAM.panY += y - c[1];
  applyCam(); clampPan();
}
// Closest: a marble fills a fifth of the screen (a view about 100 units tall) on the 3D camera; five home zooms in 2D
function zoomMax() { return glOk && GLR.cam.D ? Math.max(6, zoomForDist(50 / Math.tan(fovYNow() / 2))) : Math.max(6, homeZoom() * 5); }
function panBy(dx, dy, user = true) {                 // (screen px: the board moves with the pointer, through the real camera)
  const c = rectCentre(uiSafeRect()), a = VIEW.s2b(c[0], c[1]), b = VIEW.s2b(c[0] - dx, c[1] - dy);
  const mx = clamp(b[0] - a[0], -5000, 5000), my = clamp(b[1] - a[1], -5000, 5000);
  VIEWCAM.panX += mx; VIEWCAM.panY += my;
  applyCam(); clampPan();
  if (user) { setViewMode('free'); pauseFollow(); }
}
// Pan so that the board point under screen point (x0, y0) comes under (x1, y1): the board is held by the pointer from
// any angle (panBy measures the displacement at the middle of the view, so at an oblique angle a grabbed point
// would slide off the pointer). A grab that misses the board (too far from the target: a steep angle near the
// horizon) falls back to panBy.
function panGrab(x0, y0, x1, y1, user = true) {
  if (!glOk) { panBy(x1 - x0, y1 - y0, user); return; }
  const g = VIEW.s2b(x0, y0);
  if (!panGrabPoint(g, x1, y1, user)) panBy(x1 - x0, y1 - y0, user);
}
// Move the view so that board point g is under screen point (px, py); false (nothing moved) when g is not near the view
function panGrabPoint(g, px, py, user = true) {
  const c = rectCentre(uiSafeRect()), t = VIEW.s2b(c[0], c[1]), [sw, sh] = viewSpan(), lim = 3 * Math.max(sw, sh);
  if (!(Math.abs(g[0] - t[0]) < lim && Math.abs(g[1] - t[1]) < lim)) return false;
  for (let it = 0; it < 2; it++) {                    // (a pan moves the point under any pixel by exactly the pan: the second pass is for the pitch floor)
    const now = VIEW.s2b(px, py);
    VIEWCAM.panX += clamp(g[0] - now[0], -5000, 5000); VIEWCAM.panY += clamp(g[1] - now[1], -5000, 5000);
    applyCam();
  }
  clampPan();
  if (user) { setViewMode('free'); pauseFollow(); }
  return true;
}
// Zoom (a dolly) keeping the board point under (px, py) where it is. Zooming by hand does not pause the follow
// camera (it keeps following at the new distance), but it stops it from zooming back in on its own (userZoom).
function zoomAt(px, py, k, user = true) {
  const before = VIEW.s2b(px, py);
  const z = clamp(VIEWCAM.zoom * k, ZOOM_MIN, zoomMax());
  if (z === VIEWCAM.zoom) return;
  VIEWCAM.zoom = z;
  if (user) { setViewMode('free'); TFOLLOW.userZoom = true; VIEWCAM.glide = null; }
  applyCam();
  if (TFOLLOW.active && !TFOLLOW.paused) { clampPan(); return; }   // (following: zoom about the marble, not the pointer)
  for (let it = 0; it < 2; it++) {                    // keep the board point under the pointer where it is
    const after = VIEW.s2b(px, py);
    VIEWCAM.panX += clamp(before[0] - after[0], -5000, 5000); VIEWCAM.panY += clamp(before[1] - after[1], -5000, 5000);
    applyCam();
  }
  clampPan();
}
// A tower's home view: about four fifths of a board-width of it at a time (the board's width across the free area
// on a phone held upright), so the pieces and the marble are big enough to watch
function homeHeight() { const B = FIT_BOX; return Math.min(B.y1 - B.y0, Math.max(640, 0.78 * (B.x1 - B.x0))); }
function homeZoom() {
  if (!tallBoard()) return 1;
  const r = uiSafeRect(), B = FIT_BOX, ppu = Math.max(1e-4, VIEW.ppu());
  const want = Math.min((r.r - r.l) / (B.x1 - B.x0), (r.b - r.t) / homeHeight(), 1.3);
  return Math.max(1, VIEWCAM.zoom * want / ppu);
}
// Pan the view by (dx, dy) screen px over ~0.3 s
function glideView(dx, dy) {
  if (reducedMotion) { panBy(dx, dy, false); return; }
  VIEWCAM.anim = { dx, dy, done: 0, t: 0 };
}
// Glide the middle of the view to board point (x, y) (and zoom z) over `dur` s, eased at both ends
function glideTo(x, y, z = VIEWCAM.zoom, dur = 0.45) {
  const c = viewCentre();
  VIEWCAM.anim = null;
  if (reducedMotion || dur <= 0) { if (z !== VIEWCAM.zoom) { VIEWCAM.zoom = z; applyCam(); } setViewCentre(x, y); VIEWCAM.glide = null; return; }
  VIEWCAM.glide = { x0: c[0], y0: c[1], z0: VIEWCAM.zoom, x, y, z, t: 0, dur };
}
function stepGlide(dt) {
  const G = VIEWCAM.glide;
  if (!G) return;
  G.t = Math.min(1, G.t + dt / G.dur);
  const e = G.t < 0.5 ? 4 * G.t * G.t * G.t : 1 - Math.pow(-2 * G.t + 2, 3) / 2;
  const z = G.z0 * Math.pow(G.z / G.z0, e);
  if (Math.abs(z - VIEWCAM.zoom) > 1e-9) { VIEWCAM.zoom = z; applyCam(); }
  setViewCentre(G.x0 + (G.x - G.x0) * e, G.y0 + (G.y - G.y0) * e);
  if (G.t >= 1) VIEWCAM.glide = null;
}
// Smooth scrolling (wheel, keys): screen px still to go, eased out over about 0.1 s
const SCROLLQ = { x: 0, y: 0 };
function scrollView(dx, dy) { VIEWCAM.glide = null; stopFling(); SCROLLQ.x += dx; SCROLLQ.y += dy; pauseFollow(); setViewMode('free'); }
function stepScroll(dt) {
  if (!SCROLLQ.x && !SCROLLQ.y) return;
  const k = reducedMotion ? 1 : 1 - Math.exp(-dt / 0.07);
  let mx = SCROLLQ.x * k, my = SCROLLQ.y * k;
  if (Math.abs(SCROLLQ.x - mx) < 0.5 && Math.abs(SCROLLQ.y - my) < 0.5) { mx = SCROLLQ.x; my = SCROLLQ.y; }
  SCROLLQ.x -= mx; SCROLLQ.y -= my;
  panBy(-mx, -my);
}
// A drag of the board that is let go while moving keeps gliding and slows down
const FLING = { vx: 0, vy: 0 };
function stopFling() { FLING.vx = FLING.vy = 0; }
function stepFling(dt) {
  if (!FLING.vx && !FLING.vy) return;
  panBy(FLING.vx * dt, FLING.vy * dt);
  const k = Math.exp(-dt * 3.2);
  FLING.vx *= k; FLING.vy *= k;
  if (Math.hypot(FLING.vx, FLING.vy) < 25) stopFling();
}
// A piece dragged to the top or bottom edge of the free area on a tower scrolls the tower along (faster the nearer
// the edge), and the piece stays under the pointer. (Armed once the pointer has been in the middle: a piece picked up
// from the tray below does not scroll the tower on its way up.)
const EDGE = { fn: null, e: null };
function keepPointer(fn, e) { EDGE.fn = fn; EDGE.e = { clientX: e.clientX, clientY: e.clientY, pointerId: e.pointerId, altKey: e.altKey, shiftKey: e.shiftKey, pointerType: e.pointerType }; }
function stepEdgeScroll(dt) {
  const d = EDIT.drag;
  if (!d || (d.kind !== 'move' && d.kind !== 'tray') || !EDGE.e || EDGE.e.pointerId !== d.id || !tallBoard()) { EDGE.e = null; return; }
  if (d.kind === 'move' ? !d.moved : !EDIT.ghost) return;
  const r = uiSafeRect(), y = EDGE.e.clientY, zone = 56;
  if (!d.edgeArmed) { if (y > r.t + zone && y < r.b - zone) d.edgeArmed = true; return; }   // (only once it has been away from the edges)
  const k = y < r.t + zone ? -(r.t + zone - y) / zone : y > r.b - zone && y < r.b + zone ? (y - (r.b - zone)) / zone : 0;
  if (!k || EDGE.e.clientX < r.l - 20 || EDGE.e.clientX > r.r + 20) return;
  panBy(0, -clamp(k, -1, 1) * 900 * dt);
  EDGE.fn(EDGE.e);
}
// (realDt: the whole time since the last frame, up to 1 s: the camera keeps up with the marble however slow frames are)
function stepViewAnim(dt, realDt = dt) {
  stepEdgeScroll(dt);
  followCam(realDt);
  followWide(dt);
  stepGlide(realDt);                                  // (glides keep to real time however slow the frames are)
  stepScroll(dt);
  stepFling(dt);
  stepOrbit(realDt);                                  // (a glide keeps to real time however slow the frames are)
  const a = VIEWCAM.anim;
  if (!a) return;
  a.t = Math.min(1, a.t + dt / 0.3);
  const e = 1 - Math.pow(1 - a.t, 3), k = e - a.done;
  a.done = e;
  panBy(a.dx * k, a.dy * k, false);
  if (a.t >= 1) VIEWCAM.anim = null;
}
function setViewMode(m) {
  if (VIEWMODE.mode === m) return;
  VIEWMODE.mode = m;
  const b = $('#fitBtn'), toRun = m === 'board' && MODEL.pieces.length > 0 && (!stripDemo() || tallBoard());
  const whole = tallBoard() ? 'Show the whole tower (F)' : 'Show the whole board (F)';
  b.textContent = toRun ? 'Run' : 'Fit';
  b.setAttribute('aria-label', toRun ? 'Zoom to the run (F)' : whole);
  b.title = toRun ? 'Zoom to the run (F)' : whole;
}
function resetViewCam() { VIEWCAM.zoom = 1; VIEWCAM.panX = 0; VIEWCAM.panY = 0; VIEWCAM.anim = null; VIEWCAM.glide = null; SCROLLQ.x = SCROLLQ.y = 0; stopFling(); FOLLOW.saved = null; TFOLLOW.userZoom = false; }
// The whole board (zoom 1), from the front. While a marble is followed this lets go of it first (the whole tower is
// what was asked for, and the follow camera would zoom straight back in); the Follow button, which resumes at the
// home zoom, is the way back.
function fitView(dur = 0.5) {
  pauseFollow();
  resetViewCam(); frontView(dur); relayout(); VIEWMODE.mode = ''; setViewMode('board');
}
// The view a board opens with: a Wide board whole; a tower from its top at the home zoom; from the front (dur: the
// turn to the front, 0 = at once)
function homeView(dur = 0.5) {
  if (!tallBoard() || !RENDER) { fitView(dur); return; }
  resetViewCam(); frontView(dur); relayout();
  VIEWCAM.zoom = homeZoom(); applyCam();
  const [, sh] = viewSpan();
  setViewCentre((FIT_BOX.x0 + FIT_BOX.x1) / 2, FIT_BOX.y0 + sh / 2 - 12);
  VIEWMODE.mode = ''; setViewMode('run');
}
// Reset view (the widget, the API): the front view of the board as it opened; a run being followed stays followed.
// The widget turns to it over 0.5 s; the API (dur 0) lands at once, so a script reads the new camera straight away.
function resetView(dur = 0.5) { homeView(dur); refreshViewCube(); }
// Fit (F): the whole board, or (from the whole board) the run again
function toggleFit() {
  pauseFollow();
  if (VIEWMODE.mode === 'board' && MODEL.pieces.length && (!stripDemo() || tallBoard())) frameRun(); else fitView();
}
// The board area the run takes: every piece's metal, dropper tubes and pails, plus a margin
function runBox(pieces = MODEL.pieces) {
  const b = piecesBox(pieces);
  if (!b) return null;
  const m = 30, B = FIT_BOX;
  return { x0: clamp(b.x0 - m, B.x0, B.x1), x1: clamp(b.x1 + m, B.x0, B.x1), y0: clamp(b.y0 - m, B.y0, B.y1), y1: clamp(b.y1 + m, B.y0, B.y1) };
}
// Frame a board box in the screen area the HUD leaves free (zoom zMin..zMax, at most 1.3 px per unit); works for
// either renderer (it measures the view it gets)
function frameBox(box, zMin = 1, zMax = 3, safe = uiSafeRect()) {
  VIEWCAM.anim = null; VIEWCAM.glide = null;
  VIEWCAM.zoom = 1; VIEWCAM.panX = 0; VIEWCAM.panY = 0;
  applyCam();
  const sw = Math.max(40, safe.r - safe.l), sh = Math.max(40, safe.b - safe.t), cx = (box.x0 + box.x1) / 2, cy = (box.y0 + box.y1) / 2;
  for (let it = 0; it < 4; it++) {
    let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity;
    for (const [x, y] of [[box.x0, box.y0], [box.x1, box.y0], [box.x0, box.y1], [box.x1, box.y1]]) { const s = VIEW.b2s(x, y); a = Math.min(a, s[0]); b = Math.max(b, s[0]); c = Math.min(c, s[1]); d = Math.max(d, s[1]); }
    const k = Math.min(sw / Math.max(1, b - a), sh / Math.max(1, d - c));
    let z = clamp(VIEWCAM.zoom * k, zMin, zMax);
    const ppu = VIEW.ppu() * z / VIEWCAM.zoom;
    if (ppu > 1.3) z *= 1.3 / ppu;
    VIEWCAM.zoom = Math.max(zMin, z);
    applyCam();
    const at = VIEW.s2b((safe.l + safe.r) / 2, (safe.t + safe.b) / 2);
    VIEWCAM.panX += cx - at[0]; VIEWCAM.panY += cy - at[1];
    applyCam();
  }
}
// Frame the run on the board (a Wide board's demo, which spans the board, and an empty board show the whole board).
// A tower's run is framed from its top: at most a home view's height of it, never smaller than the home zoom.
function frameRun() {
  const tall = tallBoard(), box = (tall || !stripDemo()) && runBox();
  if (!box || !RENDER) { homeView(); return; }
  FOLLOW.saved = null;
  frontView();
  if (tall) {
    resetViewCam(); relayout();
    withFrontCam(() => {
      const hz = homeZoom();
      frameBox({ x0: box.x0, x1: box.x1, y0: box.y0, y1: Math.min(box.y1, box.y0 + homeHeight()) }, hz, zoomMax());
      clampPan();
    });
    VIEWMODE.mode = ''; setViewMode('run');
    return;
  }
  withFrontCam(() => frameBox(box));
  VIEWMODE.mode = ''; setViewMode(Math.abs(VIEWCAM.zoom - 1) < 0.02 && Math.abs(VIEWCAM.panX) < 1 && Math.abs(VIEWCAM.panY) < 1 ? 'board' : 'run');
}

/* ---- Following the marble down a tower ----
 *  The lead marble is the oldest one in view of the physics (a song's single marble; with a repeating dropper, the
 *  one furthest along). Its predicted path (the path preview: the same physics, still valid while the marble keeps
 *  to it) says where it will be over the next 1.2 s; the view keeps the marble about a third of the way down and that
 *  stretch in view below it. Between marbles (a hold: one marble into a cup, the next from a dropper just below) the
 *  camera goes on to the dropper that releases next. */
const TFOLLOW = { active: false, paused: false, vx: 0, vy: 0, ax: 0, ay: 0, leadId: null, last: null, lastLead: null, userZoom: false };
const LEADPOS = [0, 0, 0];
function pauseFollow() { if (TFOLLOW.active && !TFOLLOW.paused) { TFOLLOW.paused = true; refreshFollowBtn(); } }
function resumeFollow() {
  TFOLLOW.paused = false; TFOLLOW.vx = TFOLLOW.vy = 0; TFOLLOW.leadId = null; TFOLLOW.userZoom = false;
  SCROLLQ.x = SCROLLQ.y = 0; stopFling();
  refreshFollowBtn();
  const aim = followAim(), hz = homeZoom() * 0.999;
  if (aim) { glideTo(aim.x, aim.y, Math.max(VIEWCAM.zoom, hz), 0.6); if (VIEWCAM.zoom < hz) setViewMode('run'); }   // (back at the home zoom: the Fit button says Fit again)
}
onSimChange((k) => { if (k === 'play') { TFOLLOW.paused = false; TFOLLOW.leadId = null; TFOLLOW.userZoom = false; } refreshFollowBtn(); });
// The lead marble { id, x, y, aheadY } (display positions), or null
function leadMarble() {
  let best = null, bestM = null;
  for (const m of drawnMarbles()) {
    if (m.removedAt != null || !marbleDrawPos(m, LEADPOS)) continue;
    if (!bestM || m.id < bestM.id) { bestM = m; best = { id: m.id, x: LEADPOS[0], y: LEADPOS[1] }; }
  }
  if (!best) return null;
  // look ahead: the lowest point of its predicted path over the next 1.2 s, while it is still on that path; else
  // from its speed
  let ay = best.y + 100;
  const pr = previewPaths(previewPieces(), previewKey()).get(bestM.dropperId);
  const tau = SIM.dispT - bestM.bornT, P = pr && pr.path, i0 = Math.round(tau * 60);
  if (P && i0 >= 0 && i0 < P.length && Math.hypot(P[i0][0] - best.x, P[i0][1] - best.y) < 30) {
    for (let i = i0, e = Math.min(P.length, i0 + 73); i < e; i++) if (P[i][1] > ay) ay = P[i][1];
  } else {
    const back = Math.min(SIM.delaySteps + 24, (bestM.hn || 1) - 1);
    if (bestM.hx && back > SIM.delaySteps) {
      const k = ((bestM.hn - 1 - back) % HIST) * 3, vy = (best.y - bestM.hx[k + 1]) / ((back - SIM.delaySteps) * H_STEP);
      ay = Math.max(ay, best.y + clamp(vy, 0, 900) * 0.9);
    }
  }
  best.aheadY = ay;
  return best;
}
// Where the middle of the view should be now: { x, y }, or null (nothing to follow yet)
function followAim() {
  const [sw, sh] = viewSpan();
  let mx, my, ay;
  const lead = leadMarble();
  if (lead) { mx = lead.x; my = lead.y; ay = lead.aheadY; TFOLLOW.leadId = lead.id; }
  else {
    const w = SIM.world, r = w && SIM.playing ? w.releases[w.releaseIdx] : null;   // the marble that drops next, if soon
    if (!r || r.t - SIM.dispT > 1.5) return null;
    const d = pieceById(r.dropperId);
    if (!d) return null;
    mx = d.x; my = d.y - 40; ay = d.y + 160;
  }
  let cy = my + 0.15 * sh;                          // the marble a third of the way down the view,
  cy = Math.max(cy, ay - 0.35 * sh);                // the next 1.2 s of its way in view below it (to 85 %),
  cy = Math.min(cy, my + 0.3 * sh);                 // but never higher than a fifth of the way down
  const B = FIT_BOX, fits = B.x1 - B.x0 <= sw * 1.02, ax = fits ? (B.x0 + B.x1) / 2 : mx;
  return { x: ax, y: aimInScreen(ax, cy, mx, my, ay) };
}
// The aim above is worked out front-on. From a combined yaw and pitch at the limits the board is foreshortened and
// the far end of the marble plane rises up the screen, so the same aim leaves the marble 77 % of the way down the
// free area and the next pieces off the bottom. Correct it in screen space: pretend the camera moved to the aim
// (a pure translation in the marble plane, so a board point P then lands where P - t lands now), project the marble
// (mx, my) and the look-ahead point (mx, ahead), and if the marble is outside 25-45 % of the free area's height or
// the look-ahead below 85 % (or the marble above 20 %) slide the aim along the board by what moves that point
// where it should be. The correction grows from nothing at the edge of those bands, so it is smooth, and a front-on
// view needs none. (The spring in followCam smooths what comes out.)
function aimInScreen(ax, ay0, mx, my, ahead) {
  if (!glOk || !GLR.cam.inv) return ay0;
  const r = uiSafeRect(), h = Math.max(40, r.b - r.t), c = viewCentre(), tx = ax - c[0], span = viewSpan(r)[1];
  let ty = ay0 - c[1];
  const fy = (px, py) => { const q = project(px - tx, py - ty, ZM); return q[1] <= OFFSCREEN / 2 ? null : (q[1] - r.t) / h; };
  const shiftTo = (px, py, want) => {                 // slide the pretended camera so that board point (px, py) lands `want` of the way down
    for (let it = 0; it < 2; it++) {
      const q = project(px - tx, py - ty, ZM), sx = q[0], sy = q[1];
      if (sy <= OFFSCREEN / 2) return;
      const qm = unproject(sx, sy), qd = unproject(sx, r.t + want * h);
      ty += clamp(qm[1] - qd[1], -2 * span, 2 * span);
    }
  };
  let m = fy(mx, my);
  if (m != null && (m < 0.25 || m > 0.45)) shiftTo(mx, my, clamp(m, 0.25, 0.45));
  const a = fy(mx, ahead);
  if (a != null && a > 0.85) shiftTo(mx, ahead, 0.85);
  m = fy(mx, my);
  if (m != null && m < 0.2) shiftTo(mx, my, 0.2);
  return c[1] + ty;
}
// Each frame while a session runs on a tower: the view moves along with the aim's (smoothed) speed and a critically
// damped spring (an exact step: calm at any frame rate) takes up the rest, so a steady fall is followed without lag
// and a turn is taken smoothly; a jump of more than a screen glides instead, zooming in to the home zoom first if the
// view is further out than that
function followCam(dt) {
  const want = tallBoard() && SIM.session && !!RENDER;
  if (!want) { if (TFOLLOW.active) { TFOLLOW.active = false; refreshFollowBtn(); } return; }
  if (!TFOLLOW.active) { Object.assign(TFOLLOW, { active: true, paused: false, vx: 0, vy: 0, ax: 0, ay: 0, leadId: null, last: null }); refreshFollowBtn(); }
  // (an orbit or a pinch in progress does not stop the following: the view keeps swinging round the marble)
  const d = EDIT.drag, editing = d && (d.kind === 'move' || d.kind === 'handle' || d.kind === 'pan');
  if (TFOLLOW.paused || editing || dt <= 0) { TFOLLOW.last = null; return; }
  const aim = followAim();
  if (!aim) { TFOLLOW.last = null; return; }
  const L = TFOLLOW.last, same = L && TFOLLOW.leadId === TFOLLOW.lastLead, kf = 1 - Math.exp(-dt / 0.25);
  TFOLLOW.ax += ((same ? clamp((aim.x - L.x) / dt, -1500, 1500) : 0) - TFOLLOW.ax) * kf;
  TFOLLOW.ay += ((same ? clamp((aim.y - L.y) / dt, -1500, 1500) : 0) - TFOLLOW.ay) * kf;
  TFOLLOW.last = { x: aim.x, y: aim.y }; TFOLLOW.lastLead = TFOLLOW.leadId;
  const G = VIEWCAM.glide;
  if (G) { G.x = aim.x; G.y = aim.y; return; }             // (a glide in progress lands on the moving aim)
  const hz = homeZoom();
  if (VIEWCAM.zoom < hz * 0.85 && !TFOLLOW.userZoom) { glideTo(aim.x, aim.y, hz, 0.9); setViewMode('run'); TFOLLOW.vx = TFOLLOW.vy = 0; return; }   // (a zoom set by hand is kept)
  const c = viewCentre(), [sw, sh] = viewSpan();
  const ox = c[0] + TFOLLOW.ax * dt - aim.x, oy = c[1] + TFOLLOW.ay * dt - aim.y;
  if (Math.abs(oy) > 1.1 * sh || Math.abs(ox) > 1.1 * sw) { glideTo(aim.x, aim.y, VIEWCAM.zoom, 0.8); TFOLLOW.vx = TFOLLOW.vy = 0; return; }
  const w = 3.4, e = Math.exp(-w * dt);
  const step = (x0, v0) => { const b = v0 + w * x0; return [(x0 + b * dt) * e, (v0 - w * b * dt) * e]; };
  const [nx, nvx] = step(ox, TFOLLOW.vx), [ny, nvy] = step(oy, TFOLLOW.vy);
  TFOLLOW.vx = nvx; TFOLLOW.vy = nvy;
  if (Math.abs(aim.x + nx - c[0]) > 0.01 || Math.abs(aim.y + ny - c[1]) > 0.01) setViewCentre(aim.x + nx, aim.y + ny);
}

/* ---- Phones, a Wide board's demo playing: "Follow" zooms in (the board's height fills the screen) and glides along
 *  to where the next second of music is played; Stop puts the view back ---- */
const FOLLOW = { on: store.get('marbleMusic.follow') !== '0', active: false, saved: null, x: null };
const phoneView = () => window.innerWidth < 720 || window.matchMedia('(orientation: landscape) and (max-height: 540px)').matches;
function followWide(dt) {
  const want = FOLLOW.on && SIM.playing && !!MODEL.demoId && phoneView() && !EDIT.drag && !tallBoard();
  if (!want) {
    if (FOLLOW.active) {                             // Stop: the view the user had
      FOLLOW.active = false;
      const s = FOLLOW.saved; FOLLOW.saved = null;
      if (s) { VIEWCAM.zoom = s.zoom; VIEWCAM.panX = s.panX; VIEWCAM.panY = s.panY; applyCam(); VIEWMODE.mode = ''; setViewMode(s.mode); }
    }
    return;
  }
  const b = MarbleDemos.cached(MODEL.demoId);
  if (!FOLLOW.active) {
    FOLLOW.active = true;
    FOLLOW.saved = { zoom: VIEWCAM.zoom, panX: VIEWCAM.panX, panY: VIEWCAM.panY, mode: VIEWMODE.mode };
    let y0 = Infinity, y1 = -Infinity;                // the run's height (dropper tubes may be cut off) fills the screen
    for (const p of MODEL.pieces) {
      if (p.type === 'dropper') { y0 = Math.min(y0, p.y - 40); continue; }
      for (const c of CANON.colliders(p)) { const top = c.shape === 'circle' ? c.y - c.r : Math.min(c.ay, c.by) - c.hw, bot = c.shape === 'circle' ? c.y + c.r : Math.max(c.ay, c.by) + c.hw; y0 = Math.min(y0, top); y1 = Math.max(y1, bot + 12); }
    }
    if (!(y1 > y0)) { y0 = 0; y1 = BOARD_H; }
    withFrontCam(() => frameBox({ x0: BOARD_W / 2 - 50, x1: BOARD_W / 2 + 50, y0, y1 }, 1, 4));
    FOLLOW.x = null;
    setViewMode('free');
  }
  // where the next second of music is played (a demo's notes are known: the same physics played them already):
  // the view window that holds the most of it (the next 0.4 s count double), nearest the view as it is
  const notes = b && b.notes ? b.notes : SIM.world ? SIM.world.notes : [];
  const t0 = SIM.dispT, i0 = lowerBound(notes, t0), safe = uiSafeRect();
  const L = VIEW.s2b(safe.l, (safe.t + safe.b) / 2), Rr = VIEW.s2b(safe.r, (safe.t + safe.b) / 2), hw = (Rr[0] - L[0]) * 0.42;
  const here = VIEW.s2b((safe.l + safe.r) / 2, (safe.t + safe.b) / 2)[0];
  let want0 = null, bestW = 0;
  for (let i = i0; i < notes.length && notes[i].t <= t0 + 1; i++) {
    for (const c of [notes[i].x - hw, notes[i].x + hw, notes[i].x]) {
      let w = 0;
      for (let j = i0; j < notes.length && notes[j].t <= t0 + 1; j++) if (Math.abs(notes[j].x - c) <= hw) w += notes[j].t <= t0 + 0.4 ? 2 : 1;
      if (w > bestW + 1e-9 || (Math.abs(w - bestW) < 1e-9 && want0 != null && Math.abs(c - here) < Math.abs(want0 - here))) { bestW = w; want0 = c; }
    }
  }
  if (want0 == null) return;
  const at = VIEW.s2b((safe.l + safe.r) / 2, (safe.t + safe.b) / 2);
  const k = FOLLOW.x == null ? 1 : 1 - Math.exp(-dt / 0.6);
  FOLLOW.x = want0;
  const dx = (want0 - at[0]) * k;
  if (Math.abs(dx) > 0.05) { VIEWCAM.panX = clamp(VIEWCAM.panX + dx, -BOARD_W * 0.6, BOARD_W * 0.6); applyCam(); }
}
function lowerBound(notes, t) { let lo = 0, hi = notes.length; while (lo < hi) { const m = (lo + hi) >> 1; if (notes[m].t < t) lo = m + 1; else hi = m; } return lo; }

/* ---- Keyboard ---- */
function typing(e) { const t = e.target; return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable); }
window.addEventListener('keydown', (e) => {
  if (typing(e)) return;
  const dlg = [coach, demosDlg, menuDlg].find((x) => !x.hidden);
  if (dlg) { if (e.key === 'Escape') { e.preventDefault(); if (dlg === coach) closeHelp(); else closeDialog(dlg); } return; }
  const mod = e.ctrlKey || e.metaKey, k = e.key;
  if (mod && (k === 'z' || k === 'Z')) { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
  if (mod && (k === 'y' || k === 'Y')) { e.preventDefault(); redo(); return; }
  if (mod && (k === 'd' || k === 'D')) { e.preventDefault(); duplicateSelected(); return; }
  if (mod) return;
  const onButton = e.target instanceof HTMLButtonElement;
  if (k === 'Delete' || k === 'Backspace') { if (EDIT.selected) { e.preventDefault(); deleteSelected(); } return; }
  if (k === 'Escape') { cancelPlacing(); select(null); return; }
  if (k === ' ' && !onButton) { e.preventDefault(); if (SIM.playing) actStop(); else actPlay(); return; }
  if ((k === 'd' || k === 'D') && !onButton) { actDrop(); return; }
  if (k === 'r' || k === 'R') { rotateSelected(e.shiftKey ? 5 : 15); return; }
  if (k === 'q' || k === 'Q') { rotateSelected(e.shiftKey ? -5 : -15); return; }
  if (k === 'f' || k === 'F') { toggleFit(); return; }
  if (k === '0') { fitView(); return; }
  if (k === '+' || k === '=') { zoomAt(view.w / 2, view.h / 2, 1.25); return; }
  if (k === '-' || k === '_') { zoomAt(view.w / 2, view.h / 2, 0.8); return; }
  if (k === 'h' || k === 'H' || k === '?') { openHelp(); return; }
  if (e.altKey && k.startsWith('Arrow')) {                        // Alt+arrows: orbit in 10° steps (Shift: 30°)
    e.preventDefault();
    const s = (e.shiftKey ? 30 : 10) * RAD;
    orbitStep(k === 'ArrowLeft' ? s : k === 'ArrowRight' ? -s : 0, k === 'ArrowUp' ? s : k === 'ArrowDown' ? -s : 0);
    return;
  }
  if (tallBoard() && (k === 'PageDown' || k === 'PageUp' || k === 'Home' || k === 'End')) {   // scroll the tower
    e.preventDefault();
    const [, sh] = viewSpan(), c = viewCentre();
    if (k === 'Home' || k === 'End') { pauseFollow(); setViewMode('free'); glideTo(c[0], k === 'Home' ? FIT_BOX.y0 + sh / 2 : FIT_BOX.y1 - sh / 2, VIEWCAM.zoom, 0.6); }
    else scrollView(0, (k === 'PageDown' ? 0.85 : -0.85) * sh * VIEW.ppu());
    return;
  }
  if (tallBoard() && !EDIT.selected && (k === 'ArrowUp' || k === 'ArrowDown') && !onButton) { e.preventDefault(); scrollView(0, (k === 'ArrowDown' ? 0.15 : -0.15) * viewSpan()[1] * VIEW.ppu()); return; }
  if ((k === '[' || k === ']') && MODEL.pieces.length) {         // keyboard: step through the pieces
    const i = MODEL.pieces.findIndex((p) => p.id === EDIT.selected), n = MODEL.pieces.length;
    const p = MODEL.pieces[((i < 0 ? (k === ']' ? -1 : 0) : i) + (k === ']' ? 1 : -1) + n) % n];
    select(p.id);
    say(PIECE_INFO[p.type].name + (p.note ? ' ' + noteLabel(p.note) : '') + ' selected');
    return;
  }
  if (k.startsWith('Arrow') && EDIT.selected && !onButton) {
    e.preventDefault();
    const s = e.shiftKey ? 1 : GRID;
    nudgeSelected(k === 'ArrowLeft' ? -s : k === 'ArrowRight' ? s : 0, k === 'ArrowUp' ? -s : k === 'ArrowDown' ? s : 0);
  }
});
// Double-click a piece: zoom in on it
function boardDblClick(e) {
  const bp = VIEW.s2b(e.clientX, e.clientY), p = pieceAt(bp[0], bp[1], 8 / Math.max(0.05, VIEW.ppu()));
  if (!p) return;
  e.preventDefault();
  select(p.id, false);
  zoomToPiece(p);
}

function attachInput() {
  const stage = stageEl();
  if (stage.__inputAttached) return;
  stage.__inputAttached = true;
  stage.addEventListener('pointerdown', boardDown);
  stage.addEventListener('pointermove', boardMove);
  stage.addEventListener('pointerup', boardUp);
  stage.addEventListener('pointercancel', boardUp);
  stage.addEventListener('lostpointercapture', (e) => { if (POINTERS.has(e.pointerId)) boardUp(e); });   // (capture gone without a pointerup)
  stage.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse' && !EDIT.drag) EDIT.hover = null; });
  stage.addEventListener('wheel', boardWheel, { passive: false });
  stage.addEventListener('dblclick', boardDblClick);
  stage.addEventListener('contextmenu', (e) => e.preventDefault());
}
window.addEventListener('blur', clearPointers);
document.addEventListener('visibilitychange', () => { if (document.hidden) clearPointers(); });
function attachTray() {
  for (const type of PIECE_TYPES) {
    const b = TRAY_BTNS[type];
    b.addEventListener('pointerdown', trayDown);
    b.addEventListener('pointermove', trayMove);
    b.addEventListener('pointerup', trayUp);
    b.addEventListener('pointercancel', trayUp);
    b.addEventListener('keydown', trayKey);
    b.addEventListener('click', (e) => { if (e.detail === 0) { /* keyboard click: handled on keydown */ } });
  }
}
