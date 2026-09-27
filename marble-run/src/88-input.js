
/* ============================================================================
 *  INPUT: building with mouse, touch and keyboard
 *  - Tray: drag a piece onto the board (it snaps to the pegboard holes, every 20 units; hold Alt for free
 *    placement), or tap it and then tap the board. A new piece plays its note (the next note of the scale).
 *  - Board: press a piece to select it and drag to move it; drag the yellow knob to turn it (15° steps,
 *    Shift 5°, Alt free); drag the white handles to resize; drag it back onto the tray to remove it.
 *    Drag empty board (or two fingers) to pan; wheel or pinch to zoom; the wheel over the selected piece turns it.
 *  - Keys: Delete, Ctrl/Cmd+Z / Shift+Z / Y, Ctrl/Cmd+D, R (Shift+R = 5°), Q turns back, arrows nudge
 *    (Alt: 1 unit), Space plays/stops, D drops a marble, F fits, +/- zoom, Esc deselects, H help.
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
  const key = (MODEL.epoch || 0) + '|' + (excludeId || '') + '|' + BEAT_CLOCK.key + '|' + MODEL.tempo + '|' + MODEL.pieces.length;
  if (SNAPC.key === key) return SNAPC;
  layoutBeatClock();
  const pieces = excludeId ? MODEL.pieces.filter((p) => p.id !== excludeId) : MODEL.pieces;
  const L = simLayout(pieces), clk = layoutBeatClock(), cols = [];
  for (const p of pieces) for (const c of CANON.colliders(p)) cols.push(c);
  const beats = [], paths = [];
  for (const d of pieces) {
    if (d.type !== 'dropper') continue;
    const pr = CANON.predict(L, d.id, 8, 1 / 60);
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
    const pr = CANON.predict(simLayout(others.concat([q])), b.dropperId, b.tp + 2.5, 1 / 60), hits = pr.hits.filter((h) => h.pieceId === '__snap');
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
function boardDown(e) {
  const stage = stageEl();
  piano.init();
  stage.focus({ preventScroll: true });
  POINTERS.set(e.pointerId, { x: e.clientX, y: e.clientY });
  try { stage.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
  const touch = e.pointerType !== 'mouse';
  if (POINTERS.size === 2) {                          // second finger: pinch/pan the view instead
    if (EDIT.drag && EDIT.drag.kind !== 'pinch') { if (EDIT.drag.kind === 'move' || EDIT.drag.kind === 'handle') { EDIT.lifted = null; endChange(); } }
    const [a, b] = [...POINTERS.values()];
    EDIT.drag = { kind: 'pinch', d0: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
    return;
  }
  if (e.button !== undefined && e.button > 0 && e.pointerType === 'mouse') { EDIT.drag = { kind: 'pan', id: e.pointerId, lx: e.clientX, ly: e.clientY }; return; }
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
    select(p.id);
    EDIT.drag = { kind: 'move', id: e.pointerId, pid: p.id, x0: e.clientX, y0: e.clientY, bx: bp[0], by: bp[1], px: p.x, py: p.y, moved: false };
    return;
  }
  select(null);
  EDIT.drag = { kind: 'pan', id: e.pointerId, lx: e.clientX, ly: e.clientY, x0: e.clientX, y0: e.clientY };
}
function boardMove(e) {
  if (POINTERS.has(e.pointerId)) POINTERS.set(e.pointerId, { x: e.clientX, y: e.clientY });
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
    if (POINTERS.size < 2) return;
    const [a, b] = [...POINTERS.values()];
    const dist = Math.hypot(a.x - b.x, a.y - b.y), cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
    panBy(cx - d.cx, cy - d.cy);
    if (d.d0 > 10) zoomAt(cx, cy, dist / d.d0);
    d.d0 = dist; d.cx = cx; d.cy = cy;
    return;
  }
  if (e.pointerId !== d.id) return;
  if (d.kind === 'pan') { panBy(e.clientX - d.lx, e.clientY - d.ly); d.lx = e.clientX; d.ly = e.clientY; stageEl().style.cursor = 'grabbing'; return; }
  const bp = VIEW.s2b(e.clientX, e.clientY);
  if (d.kind === 'move') {
    if (!d.moved && Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < 4) return;
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

/* ---- The view: pan, zoom, fit; frame the run; follow the music on phones ----
 *  The base view fits the whole board. On top of it the user pans and zooms (VIEWCAM, board units), and a run is
 *  framed when it opens (its pieces fill the screen, zoom 1..3). Fit (F) toggles the whole board and the run.
 *  On a phone, while a demo plays, "Follow" zooms in (the board's height fills the screen) and glides along to
 *  where the next second of music is played; Stop puts the view back. */
const VIEWMODE = { mode: 'board' };                  // 'board' (whole board), 'run' (framed), 'free' (the user's own)
function applyCam() { RENDER.applyCam(); OVL.sig = ''; }
function panBy(dx, dy, user = true) {
  const ppu = Math.max(0.02, VIEW.ppu());
  VIEWCAM.panX = clamp(VIEWCAM.panX - dx / ppu, -BOARD_W * 0.6, BOARD_W * 0.6);
  VIEWCAM.panY = clamp(VIEWCAM.panY - dy / ppu, -BOARD_H * 0.6, BOARD_H * 0.6);
  if (user) setViewMode('free');
  applyCam();
}
function zoomAt(px, py, k) {
  const before = VIEW.s2b(px, py);
  const z = clamp(VIEWCAM.zoom * k, 0.75, 6);
  if (z === VIEWCAM.zoom) return;
  VIEWCAM.zoom = z;
  setViewMode('free');
  applyCam();
  for (let it = 0; it < 2; it++) {                    // keep the board point under the pointer where it is
    const after = VIEW.s2b(px, py);
    VIEWCAM.panX += before[0] - after[0]; VIEWCAM.panY += before[1] - after[1];
    applyCam();
  }
}
// Pan the view by (dx, dy) screen px over ~0.3 s
function glideView(dx, dy) {
  if (reducedMotion) { panBy(dx, dy, false); return; }
  VIEWCAM.anim = { dx, dy, done: 0, t: 0 };
}
function stepViewAnim(dt) {
  follow(dt);
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
  const b = $('#fitBtn'), toRun = m === 'board' && MODEL.pieces.length > 0 && !stripDemo();
  b.textContent = toRun ? 'Run' : 'Fit';
  b.setAttribute('aria-label', toRun ? 'Zoom to the run (F)' : 'Show the whole board (F)');
  b.title = toRun ? 'Zoom to the run (F)' : 'Show the whole board (F)';
}
function fitView() { VIEWCAM.zoom = 1; VIEWCAM.panX = 0; VIEWCAM.panY = 0; VIEWCAM.anim = null; FOLLOW.saved = null; relayout(); VIEWMODE.mode = ''; setViewMode('board'); }
// Fit (F): the whole board, or (from the whole board) the run again
function toggleFit() { if (VIEWMODE.mode === 'board' && MODEL.pieces.length && !stripDemo()) frameRun(); else fitView(); }
// The board area the run takes: every piece's metal, dropper tubes and pails, plus a margin
function runBox(pieces = MODEL.pieces) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (x, y, r) => { x0 = Math.min(x0, x - r); x1 = Math.max(x1, x + r); y0 = Math.min(y0, y - r); y1 = Math.max(y1, y + r); };
  for (const p of pieces) {
    if (p.type === 'dropper') { add(p.x, p.y - 100, 22); add(p.x, p.y, 16); continue; }
    for (const c of CANON.colliders(p)) {
      if (c.shape === 'circle') add(c.x, c.y, c.r);
      else { add(c.ax, c.ay, c.hw); add(c.bx, c.by, c.hw); }
    }
  }
  if (!(x1 >= x0)) return null;
  const m = 30, B = FIT_BOX;
  return { x0: clamp(x0 - m, B.x0, B.x1), x1: clamp(x1 + m, B.x0, B.x1), y0: clamp(y0 - m, B.y0, B.y1), y1: clamp(y1 + m, B.y0, B.y1) };
}
// Frame a board box in the screen area the HUD leaves free (zoom zMin..zMax, at most 1.3 px per unit); works for
// either renderer (it measures the view it gets)
function frameBox(box, zMin = 1, zMax = 3, safe = uiSafeRect()) {
  VIEWCAM.anim = null;
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
    VIEWCAM.panX = clamp(VIEWCAM.panX + cx - at[0], -BOARD_W * 0.6, BOARD_W * 0.6);
    VIEWCAM.panY = clamp(VIEWCAM.panY + cy - at[1], -BOARD_H * 0.6, BOARD_H * 0.6);
    applyCam();
  }
}
// Frame the run on the board (a demo, which spans the board, and an empty board show the whole board)
function frameRun() {
  const box = !stripDemo() && runBox();
  if (!box || !RENDER) { fitView(); return; }
  FOLLOW.saved = null;
  frameBox(box);
  VIEWMODE.mode = ''; setViewMode(Math.abs(VIEWCAM.zoom - 1) < 0.02 && Math.abs(VIEWCAM.panX) < 1 && Math.abs(VIEWCAM.panY) < 1 ? 'board' : 'run');
}
// Phones: a small screen shows the whole board at under 0.25 px per unit, so a demo is followed instead
const FOLLOW = { on: store.get('marbleMusic.follow') !== '0', active: false, saved: null, x: null };
const phoneView = () => window.innerWidth < 720 || window.matchMedia('(orientation: landscape) and (max-height: 540px)').matches;
function follow(dt) {
  const want = FOLLOW.on && SIM.playing && !!MODEL.demoId && phoneView() && !EDIT.drag;
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
    frameBox({ x0: BOARD_W / 2 - 50, x1: BOARD_W / 2 + 50, y0, y1 }, 1, 4);
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
  if ((k === '[' || k === ']') && MODEL.pieces.length) {         // keyboard: step through the pieces
    const i = MODEL.pieces.findIndex((p) => p.id === EDIT.selected), n = MODEL.pieces.length;
    const p = MODEL.pieces[((i < 0 ? (k === ']' ? -1 : 0) : i) + (k === ']' ? 1 : -1) + n) % n];
    select(p.id);
    say(PIECE_INFO[p.type].name + (p.note ? ' ' + noteLabel(p.note) : '') + ' selected');
    return;
  }
  if (k.startsWith('Arrow') && EDIT.selected && !onButton) {
    e.preventDefault();
    const s = e.altKey ? 1 : GRID;
    nudgeSelected(k === 'ArrowLeft' ? -s : k === 'ArrowRight' ? s : 0, k === 'ArrowUp' ? -s : k === 'ArrowDown' ? s : 0);
  }
});

function attachInput() {
  const stage = stageEl();
  if (stage.__inputAttached) return;
  stage.__inputAttached = true;
  stage.addEventListener('pointerdown', boardDown);
  stage.addEventListener('pointermove', boardMove);
  stage.addEventListener('pointerup', boardUp);
  stage.addEventListener('pointercancel', boardUp);
  stage.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse' && !EDIT.drag) EDIT.hover = null; });
  stage.addEventListener('wheel', boardWheel, { passive: false });
  stage.addEventListener('contextmenu', (e) => e.preventDefault());
}
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
