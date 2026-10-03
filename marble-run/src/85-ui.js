
/* ============================================================================
 *  UI: tray, inspector (with the piano keyboard), transport, demos gallery,
 *  music strip, save & share, first-run coach, toasts.
 * ========================================================================== */
const UI = { showPath: store.get('marbleMusic.path') !== '0', oct: 4, inspFor: null, inspSig: '', stripOn: false, toastTimer: 0, metronome: false, frameNo: 0 };
const topbar = $('#topbar'), tray = $('#tray'), inspector = $('#inspector'), stripEl = $('#strip');
const playBtn = $('#playBtn'), stopBtn = $('#stopBtn'), dropBtn = $('#dropBtn'), undoBtn = $('#undoBtn'), redoBtn = $('#redoBtn');
const demosBtn = $('#demosBtn'), menuBtn = $('#menuBtn'), helpBtn = $('#helpBtn');
const coach = $('#coach'), demosDlg = $('#demos'), menuDlg = $('#menu');
const srStatus = $('#srStatus');
function say(text) { if (srStatus) srStatus.textContent = text; }

// The screen area the board may use (CSS px), from the HUD (and, on a tower, the minimap's column at its left). It
// does not depend on whether the inspector is open, so selecting a piece never refits the camera (a piece hidden by
// the inspector is panned into view instead). Measured once a frame (SAFE.frame; relayout measures again).
const SAFE = { frame: -1, r: null, base: null };
function uiSafeRect() {
  if (SAFE.frame === UI.frameNo && SAFE.r) return Object.assign({}, SAFE.r);
  const b = hudRect(), m = minimapRect(b);
  SAFE.base = b; SAFE.frame = UI.frameNo;
  SAFE.r = m ? Object.assign({}, b, { l: m.l + m.w + 8 }) : b;
  return Object.assign({}, SAFE.r);
}
function remeasureUI() { SAFE.frame = -1; SAFE.r = null; }
function hudRect() {
  const w = window.innerWidth, h = window.innerHeight;
  const side = window.matchMedia('(orientation: landscape) and (max-height: 540px)').matches;
  const tb = topbar.getBoundingClientRect(), tr = tray.getBoundingClientRect();
  const strip = !!stripDemo(), sr = strip && !stripEl.hidden ? stripEl.getBoundingClientRect() : null;
  if (side) return { l: tb.right + 6, r: tr.left - 6, t: strip ? (sr ? sr.bottom : 56) + 6 : 6, b: h - 6 };
  const upright = w < 720 && h > w;
  const r = { l: 10, r: w - 10, t: tb.bottom + 8, b: tr.top - 8 };
  if (strip && upright) r.b = (sr ? sr.top : tr.top - 80) - 6;          // phones: the strip sits above the tray
  else if (strip) r.t = (sr ? sr.bottom : tb.bottom + 8 + 80) + 6;
  return r;
}
// The minimap's place (CSS px: l, t, w, h), at the left of the HUD's free area, or null (not a tower). As tall as that
// area allows and at most 48 px wide (30 on a phone), keeping the board's proportions.
function minimapRect(b = SAFE.base || hudRect()) {
  if (!tallBoard()) return null;
  const B = FIT_BOX, a = (B.x1 - B.x0) / (B.y1 - B.y0), pad = 5, phone = window.innerWidth < 720 || window.innerHeight < 540;
  const avail = Math.max(60, b.b - b.t - 2 * pad);
  const w = Math.max(18, Math.min(phone ? 30 : 48, avail * a)), h = Math.min(avail, w / a);
  return { l: b.l, t: b.t + pad, w: w + 2 * pad, h: h + 2 * pad, cw: w, ch: h, pad };
}
// Where the whole board is fitted: the safe area, except on a phone held upright, where the (width-limited) board
// sits near the top and leaves the lower wall free
function boardFitRect() {
  const r = uiSafeRect(), w = window.innerWidth, h = window.innerHeight;
  if (w < 720 && h > w) {
    const B = FIT_BOX, need = (r.r - r.l) * (B.y1 - B.y0) / (B.x1 - B.x0);
    if (r.b - r.t > need + 40) r.b = r.t + need + 40;
  }
  return r;
}
// A newly selected piece hidden behind the inspector glides out from under it
function revealSelected() {
  const p = EDIT.selected && pieceById(EDIT.selected);
  if (!p || inspector.hidden) return;
  const ir = inspector.getBoundingClientRect(), s = VIEW.b2s(p.x, p.y);
  let dx = 0, dy = 0;
  if (s[0] > ir.left - 40 && s[0] < ir.right + 20 && s[1] > ir.top - 30 && s[1] < ir.bottom + 30) {
    if (ir.width < window.innerWidth * 0.7) dx = (ir.left - 60) - s[0];     // a side panel: move it left
    else dy = (ir.top - 50) - s[1];                                          // a bottom sheet: move it up
  }
  if (dx || dy) glideView(dx, dy);
}

/* ---- Toasts (with an optional action) ---- */
function hideToast() { clearTimeout(UI.toastTimer); clearTimeout(UI.hintTimer); $('#toast').classList.remove('show'); }
function toast(msg, action, fn, ms = 2600) {
  const t = $('#toast');
  UI.lastToast = { msg, action, fn };
  t.textContent = '';
  t.append(el('span', { text: msg }));
  // (the action runs after this toast is gone, so a toast it shows in turn, e.g. "Back to …" with Undo, stays)
  if (action) t.append(el('button', { type: 'button', text: action, onclick: () => { hideToast(); fn(); } }));
  t.classList.add('show');
  clearTimeout(UI.toastTimer);
  UI.toastTimer = setTimeout(() => t.classList.remove('show'), ms);
  say(msg);
}

// Say more in the toast that is showing (keeping its button), or show this alone
function toastMore(msg, ms = 6000) {
  const L = UI.lastToast, showing = L && $('#toast').classList.contains('show');
  if (showing) toast(L.msg + ' ' + msg, L.action, L.fn, ms); else toast(msg, null, null, ms);
}

/* ---- Icons: the 2D piece drawer on a small canvas, framed to the piece ---- */
const ICON_PIECE = {
  bar: { type: 'bar', x: 0, y: 0, rot: -12, len: 70 }, rail: { type: 'rail', x: 0, y: 0, rot: 10, len: 120 },
  curve: { type: 'curve', x: 0, y: -20, rot: 20, r: 55, sweep: 140 }, bell: { type: 'bell', x: 0, y: 0, rot: 0, r: 16 },
  spring: { type: 'spring', x: 0, y: -8, rot: 0, len: 60 }, wall: { type: 'wall', x: 0, y: 0, rot: 70, len: 90 },
  funnel: { type: 'funnel', x: 0, y: -10, rot: 0, w: 110, h: 60 }, dropper: { type: 'dropper', x: 0, y: 44, rot: 0 },
  bucket: { type: 'bucket', x: 0, y: 0, rot: 0, w: 70 },
};
const ICON_BOX = { bar: 90, rail: 130, curve: 110, bell: 44, spring: 80, wall: 100, funnel: 125, dropper: 110, bucket: 86 };
function drawIcon(canvas, p) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2), w = canvas.clientWidth || 64, h = canvas.clientHeight || 52;
  canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
  const g = canvas.getContext('2d'), s = Math.min(w, h * 1.25) / (ICON_BOX[p.type] || 90);
  g.setTransform(dpr * s, 0, 0, dpr * s, dpr * w / 2, dpr * h / 2);
  g.save(); g.shadowColor = 'rgba(40,24,8,0.35)'; g.shadowBlur = 4 * dpr; g.shadowOffsetX = 1.5 * dpr; g.shadowOffsetY = 2.5 * dpr;
  drawPiece2D(g, p, null, 0); g.restore();
  drawPiece2D(g, p, null, 0);
}

/* ---- The tray ---- */
const TRAY_BTNS = {};
function buildTray() {
  const box = $('#trayPieces');
  for (const type of PIECE_TYPES) {
    const info = PIECE_INFO[type];
    const b = el('button', { type: 'button', class: 'piece', 'data-type': type, title: info.name + ': ' + info.tip,
      'aria-label': info.name + '. ' + info.tip + ' Drag onto the board, or press Enter to add one.' },
      el('canvas', { 'aria-hidden': 'true' }), el('span', { text: info.name.replace('Bell bar', 'Bar') }),
      hasNote(type) ? el('span', { class: 'nx' }) : null);
    box.append(b);
    TRAY_BTNS[type] = b;
  }
  refreshTray(true);
}
let trayNoteShown = '';
function refreshTray(force) {
  const next = nextScaleNote(MODEL.lastNote, MODEL.scale);
  if (!force && next === trayNoteShown) return;
  trayNoteShown = next;
  for (const type of PIECE_TYPES) {
    const b = TRAY_BTNS[type];
    const p = Object.assign({}, ICON_PIECE[type], hasNote(type) ? { note: next } : {});
    drawIcon(b.querySelector('canvas'), p);
    const nx = b.querySelector('.nx');
    if (nx) { nx.textContent = noteLabel(next); nx.style.setProperty('--kc', noteHex(next)); }
  }
  const chip = $('#trayNext');
  chip.textContent = 'Next note: ' + noteLabel(next);
  chip.style.setProperty('--kc', noteHex(next));
}
function paletteRect(type) { const b = TRAY_BTNS[type]; return b ? b.getBoundingClientRect() : null; }

/* ---- Transport ---- */
function hasDroppers() { return MODEL.pieces.some((p) => p.type === 'dropper'); }
function actPlay() {
  piano.init();
  if (SIM.playing) { actStop(); return false; }            // (the Play button stops a run that is playing)
  if (!hasDroppers()) { toast('Add a Dropper first: it releases the marbles.'); pulseTray('dropper'); return false; }
  play();
  refreshTransport();
  if (glOk && GLR.software && !store.get('marbleMusic.slow3d')) {      // (once: remembered)
    store.set('marbleMusic.slow3d', '1');
    toast('This computer draws 3D slowly. Use the smooth 2D view?', 'Switch', () => fallbackTo2D(), 9000);
  }
  return true;
}
function actStop() { stop(); refreshTransport(); }
function actDrop() {
  piano.init();
  const sel = EDIT.selected && pieceById(EDIT.selected);
  const d = sel && sel.type === 'dropper' ? sel : MODEL.pieces.find((p) => p.type === 'dropper');
  if (!d) { toast('Add a Dropper first: it releases the marbles.'); pulseTray('dropper'); return null; }
  return dropFrom(d.id);
}
function pulseTray(type) {
  const b = TRAY_BTNS[type];
  if (!b || reducedMotion) return;
  b.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.18)' }, { transform: 'scale(1)' }], { duration: 420, iterations: 2 });
}
function refreshTransport() {
  playBtn.classList.toggle('on', SIM.playing);
  playBtn.setAttribute('aria-pressed', String(SIM.playing));
  playBtn.setAttribute('aria-label', SIM.playing ? 'Stop (Space)' : 'Play (Space)'); playBtn.title = SIM.playing ? 'Stop (Space)' : 'Play (Space)';
  for (const l of playBtn.querySelectorAll('.lbl, .cap')) l.textContent = SIM.playing ? 'Stop' : 'Play';
  stopBtn.disabled = !SIM.session;
  stopBtn.hidden = SIM.playing;                                // while playing, the Play button itself reads "Stop"
  undoBtn.disabled = !HISTORY.undo.length;
  redoBtn.disabled = !HISTORY.redo.length;
  TEMPO.shown = '';
  refreshTempo();
  $('#layoutName').textContent = MODEL.name;
}
// The beat speed: the layout's tempo, or (a run timed for its song: every dropper on song times) the song's own
// tempo at this moment, shown read-only (the song's timing is never changed from here)
const TEMPO = { shown: '' };
function timedRun() { let n = 0; for (const p of MODEL.pieces) if (p.type === 'dropper') { if (!p.schedule || p.schedule.mode !== 'times') return false; n++; } return n > 0; }
function refreshTempo() {
  const timed = timedRun(), bpm = timed ? Math.round(layoutBeatClock().bpmAt(SIM.session ? Math.max(0, SIM.dispT) : 0)) : MODEL.tempo;
  const key = bpm + '|' + timed;
  if (key === TEMPO.shown) return;
  TEMPO.shown = key;
  $('#tempoVal').firstChild.textContent = String(bpm);
  $('#tempoVal2').textContent = bpm + ' beats a minute' + (timed ? ' (the song’s)' : '');
  $('.tempo').classList.toggle('timed', timed);
  for (const [id, up] of [['tempoDown', false], ['tempoUp', true], ['tempoDown2', false], ['tempoUp2', true]]) {
    const b = $('#' + id);
    b.setAttribute('aria-disabled', String(timed));
    b.title = timed ? 'This run is timed for its song' : (up ? 'Faster beat' : 'Slower beat') + ': sets the beat dots and how often repeating droppers drop. Marbles always fall at the speed of gravity.';
  }
}
function nudgeTempo(d) {
  if (timedRun()) { toast('This run is timed for its song: its marbles drop at the song’s own times.'); return; }
  setTempo(MODEL.tempo + d);
}
function setMetronome(on) {
  UI.metronome = on;
  for (const b of [$('#metroBtn'), $('#metroBtn2')]) b.setAttribute('aria-pressed', String(on));
  $('#metroBtn2').textContent = on ? 'Metronome on' : 'Metronome off';
  if (on) piano.init();
}
playBtn.addEventListener('click', () => actPlay());
stopBtn.addEventListener('click', () => actStop());
dropBtn.addEventListener('click', () => actDrop());
undoBtn.addEventListener('click', () => { undo(); });
redoBtn.addEventListener('click', () => { redo(); });
for (const [id, d] of [['tempoDown', -5], ['tempoUp', 5], ['tempoDown2', -5], ['tempoUp2', 5]]) $('#' + id).addEventListener('click', () => nudgeTempo(d));
$('#metroBtn').addEventListener('click', () => setMetronome(!UI.metronome));
$('#metroBtn2').addEventListener('click', () => setMetronome(!UI.metronome));
onSimChange(() => refreshTransport());

/* ---- View controls ---- */
$('#zoomInBtn').addEventListener('click', () => zoomAt(view.w / 2, view.h / 2, 1.25));
$('#zoomOutBtn').addEventListener('click', () => zoomAt(view.w / 2, view.h / 2, 0.8));
$('#fitBtn').addEventListener('click', () => toggleFit());
const pathBtn = $('#pathBtn');
function setShowPath(on) { UI.showPath = on; pathBtn.setAttribute('aria-pressed', String(on)); store.set('marbleMusic.path', on ? '1' : '0'); }
pathBtn.addEventListener('click', () => setShowPath(!UI.showPath));
setShowPath(UI.showPath);
// Cinematic (the demo strip): the view swings slowly round the run while it plays (off by default; remembered)
// With reduced motion on, the toggle is inert and says so (aria-disabled; the stored preference is left as it was and
// comes back when reduced motion goes off).
const cineBtn = $('#cineBtn'), CINE_TITLE = cineBtn.title;
let cineWanted = store.get('marbleMusic.cinematic') === '1';
function setCinematic(on, remember = true) {
  if (remember) { cineWanted = !!on; store.set('marbleMusic.cinematic', cineWanted ? '1' : '0'); }
  UI.cinematic = cineWanted && !reducedMotion;
  cineBtn.setAttribute('aria-pressed', String(UI.cinematic));
  cineBtn.setAttribute('aria-disabled', String(reducedMotion));
  cineBtn.title = reducedMotion ? 'Off: reduced motion is on' : CINE_TITLE;
}
setCinematic(cineWanted, false);
cineBtn.addEventListener('click', () => {
  if (reducedMotion) { say('Cinematic is off: reduced motion is on.'); return; }
  setCinematic(!UI.cinematic);
  say(UI.cinematic ? 'Cinematic on: the view swings round the run while it plays.' : 'Cinematic off.');
});
if (RM_QUERY) {
  const onRM = (e) => { reducedMotion = e.matches; setCinematic(cineWanted, false); };
  if (RM_QUERY.addEventListener) RM_QUERY.addEventListener('change', onRM); else if (RM_QUERY.addListener) RM_QUERY.addListener(onRM);
}

/* ---- The view compass (#viewCube): a small picture of the pegboard on its wall as the camera sees it (turned by
 *  the same yaw and pitch), with the angle under it. Drag on it to orbit (2 axes), press it for the front view; arrow
 *  keys turn it, Enter / Space put it back. Hidden in the 2D view (front-on: nothing to turn). Sits at the bottom
 *  right of the free area (placeViewCube). ---- */
const cubeEl = $('#viewCube'), cubeCv = $('#viewCubeCv');
const CUBE = { sig: '', pos: '', drag: null };
function placeViewCube() {
  const b = SAFE.base || hudRect(), size = cubeEl.offsetWidth || 66;
  let l = Math.round(b.r - size);
  const t = Math.round(b.b - size);
  if (!inspector.hidden) {                                        // a side-panel inspector reaching down to it: to its left
    const ir = inspector.getBoundingClientRect();
    if (ir.width < window.innerWidth * 0.7 && ir.bottom > t - 6 && ir.right > l - 6 && ir.left < l + size + 6) l = Math.round(ir.left - size - 8);
  }
  const key = l + ',' + t;
  if (CUBE.pos === key) return;
  CUBE.pos = key;
  cubeEl.style.left = l + 'px'; cubeEl.style.top = t + 'px';
}
function refreshViewCube() { CUBE.sig = ''; }
const CUBE_TXT = (yaw, pitch) => (Math.abs(yaw - CAMERA.yaw0) < 1.5 * RAD && Math.abs(pitch - CAMERA.pitch0) < 1.5 * RAD ? 'front' : Math.round(yaw / RAD) + '° ' + (pitch >= 0 ? '▾' : '▴') + Math.abs(Math.round(pitch / RAD)) + '°');
// Each frame (cheap: drawn again only when the angle changes)
function drawViewCube() {
  if (!glOk) { if (!cubeEl.hidden) cubeEl.hidden = true; return; }
  if (cubeEl.hidden) { cubeEl.hidden = false; CUBE.pos = ''; }
  placeViewCube();
  const yaw = GLR.cam.yaw || 0, pitch = GLR.cam.pitch || 0, w = cubeCv.clientWidth || 60, h = cubeCv.clientHeight || 60;
  const sig = Math.round(yaw * 300) + '|' + Math.round(pitch * 300) + '|' + w + 'x' + h + '|' + BOARD_W + 'x' + BOARD_H;
  if (sig === CUBE.sig) return;
  CUBE.sig = sig;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  if (cubeCv.width !== Math.round(w * dpr) || cubeCv.height !== Math.round(h * dpr)) { cubeCv.width = Math.round(w * dpr); cubeCv.height = Math.round(h * dpr); }
  const g = cubeCv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  const R = Math.min(w, h - 11) / 2 - 1, cx = w / 2, cy = R + 1;
  g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2);
  g.fillStyle = 'rgba(255, 255, 255, 0.55)'; g.fill();
  g.strokeStyle = 'rgba(80, 58, 36, 0.25)'; g.lineWidth = 1; g.stroke();
  // the camera's basis (as 75-render's lookAt): screen x = p . X, screen y = p . Y, depth = p . Z
  const sy = Math.sin(yaw), cyw = Math.cos(yaw), sp = Math.sin(pitch), cp = Math.cos(pitch);
  const X = [cyw, 0, -sy], Y = [-sp * sy, cp, -sp * cyw], Z = [sy * cp, sp, cyw * cp], k = R * 0.72;
  const P = (p) => { const d = p[0] * Z[0] + p[1] * Z[1] + p[2] * Z[2], s = k / (1 - d * 0.22); return [cx + (p[0] * X[0] + p[1] * X[1] + p[2] * X[2]) * s, cy - (p[0] * Y[0] + p[1] * Y[1] + p[2] * Y[2]) * s]; };
  const quad = (pts, fill, stroke) => { g.beginPath(); pts.forEach((p, i) => { const q = P(p); if (i) g.lineTo(q[0], q[1]); else g.moveTo(q[0], q[1]); }); g.closePath(); g.fillStyle = fill; g.fill(); if (stroke) { g.strokeStyle = stroke; g.lineWidth = 1; g.stroke(); } };
  g.save(); g.beginPath(); g.arc(cx, cy, R - 0.5, 0, Math.PI * 2); g.clip();
  quad([[-1.6, 1.6, -0.14], [1.6, 1.6, -0.14], [1.6, -1.6, -0.14], [-1.6, -1.6, -0.14]], '#d9d3c6');                      // the wall
  const tall = BOARD_H > BOARD_W * 1.3, bw = tall ? 0.34 : 0.62, bh = tall ? 0.72 : 0.62 * BOARD_H / BOARD_W, t = 0.08;
  quad([[-bw, -bh, 0], [bw, -bh, 0], [bw, -bh, t], [-bw, -bh, t]], '#6e5236');                                            // its bottom edge
  quad([[bw, bh, 0], [bw, -bh, 0], [bw, -bh, t], [bw, bh, t]], sy < 0 ? '#7a5b3c' : '#5c4430');                             // a side edge
  quad([[-bw, bh, 0], [-bw, -bh, 0], [-bw, -bh, t], [-bw, bh, t]], sy > 0 ? '#7a5b3c' : '#5c4430');
  quad([[-bw, bh, t], [bw, bh, t], [bw, -bh, t], [-bw, -bh, t]], '#a0784a', 'rgba(60, 40, 20, 0.6)');                     // the pegboard face
  g.fillStyle = 'rgba(60, 40, 20, 0.45)';
  for (let i = -1; i <= 1; i++) for (let j = -2; j <= 2; j++) { const q = P([i * bw * 0.55, j * bh * 0.38, t]); g.beginPath(); g.arc(q[0], q[1], 0.9, 0, Math.PI * 2); g.fill(); }
  const m = P([0, bh * 0.35, t + 0.16]);                                                                                   // a marble off the board
  g.beginPath(); g.arc(m[0], m[1], 2.6, 0, Math.PI * 2); g.fillStyle = '#4f9be8'; g.fill(); g.strokeStyle = '#fff'; g.lineWidth = 1; g.stroke();
  g.restore();
  g.font = uiFont(800, 9.5); g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = '#2b2118';
  g.fillText(CUBE_TXT(yaw, pitch), cx, h - 5);
  const now = CUBE_TXT(yaw, pitch);
  if (CUBE.said !== now) {
    CUBE.said = now;
    cubeEl.setAttribute('aria-label', 'View angle: ' + (now === 'front' ? 'the front view' : 'turned ' + Math.round(yaw / RAD) + ' degrees, tilted ' + Math.round(pitch / RAD) + ' degrees') + '. Drag to turn the view round the board, press for the front view. Arrow keys turn it too.');
  }
}
cubeEl.addEventListener('pointerdown', (e) => {
  if (e.button !== undefined && e.button !== 0) return;
  e.preventDefault();
  try { cubeEl.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
  stopOrbitMotion();
  CUBE.drag = { id: e.pointerId, lx: e.clientX, ly: e.clientY, x0: e.clientX, y0: e.clientY, moved: false };
});
cubeEl.addEventListener('pointermove', (e) => {
  const d = CUBE.drag;
  if (!d || e.pointerId !== d.id) return;
  if (!d.moved && Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < 3) return;
  d.moved = true;
  const g = 2.2 * RAD;                                            // (a small dial: 2.2° per px)
  orbitBy(-(e.clientX - d.lx) * g, (e.clientY - d.ly) * g);
  d.lx = e.clientX; d.ly = e.clientY;
});
const cubeUp = (e) => {
  const d = CUBE.drag;
  if (!d || e.pointerId !== d.id) return;
  CUBE.drag = null;
  if (!d.moved && e.type === 'pointerup') { frontView(0.5); say('Front view'); }
};
cubeEl.addEventListener('pointerup', cubeUp);
cubeEl.addEventListener('pointercancel', cubeUp);
cubeEl.addEventListener('keydown', (e) => {
  const s = (e.shiftKey ? 30 : 10) * RAD;
  if (e.key.startsWith('Arrow')) { e.preventDefault(); e.stopPropagation(); orbitStep(e.key === 'ArrowLeft' ? s : e.key === 'ArrowRight' ? -s : 0, e.key === 'ArrowUp' ? s : e.key === 'ArrowDown' ? -s : 0); return; }
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); frontView(0.5); say('Front view'); return; }
  if (e.key === 'Home') { e.preventDefault(); e.stopPropagation(); resetView(); say('The view is back at the start'); }
});

/* ============================================================================
 *  INSPECTOR: the selected piece. A two-octave piano keyboard sets (and plays) its note; sliders size it;
 *  buttons turn, copy and remove it; droppers get their schedule. The panel is built once per piece and then
 *  updated in place, so the keyboard focus stays on the control in use. On a phone held upright it opens as a
 *  compact editor above the tray (name, note, turn buttons and the keyboard); ▲ opens the whole panel.
 * ========================================================================== */
const SIZE_LABELS = { len: 'Length', r: 'Radius', sweep: 'Bend', w: 'Width', h: 'Height' };
const SIZE_STEP = { len: 10, r: 2, sweep: 15, w: 10, h: 10 };
const INS = { key: '', parts: null };
const turnText = (p) => Math.round(((p.rot % 360) + 540) % 360 - 180) + '°';
function refreshInspector() {
  const p = EDIT.selected ? pieceById(EDIT.selected) : null;
  document.body.classList.toggle('ins-open', !!p);
  if (!p) { if (!inspector.hidden) { inspector.hidden = true; UI.inspFor = null; UI.inspFull = false; INS.key = ''; } return; }
  if (UI.inspFor !== p.id) { UI.inspFull = false; if (hasNote(p.type)) UI.oct = clamp(Math.floor((noteToMidi(p.note) ?? 60) / 12) - 1, 2, 5); }
  UI.inspFor = p.id;
  const key = p.id + '|' + p.type + '|' + UI.oct + '|' + (p.schedule && p.schedule.mode === 'times' ? p.schedule.times.length : '');
  if (INS.key !== key || inspector.hidden) {
    const a = document.activeElement, keep = a && inspector.contains(a) ? a.getAttribute('data-key') : null;
    buildInspector(p);
    INS.key = key;
    if (keep) { const f = inspector.querySelector('[data-key="' + keep + '"]'); if (f) f.focus({ preventScroll: true }); }
  }
  updateInspector(p);
  inspector.classList.toggle('compact', !UI.inspFull);
}
function buildInspector(p) {
  inspector.hidden = false;
  inspector.textContent = '';
  const info = PIECE_INFO[p.type], P = INS.parts = { keys: [], sliders: {}, seg: [] };
  const icon = el('canvas', { 'aria-hidden': 'true' });
  P.sub = el('small', {});
  P.chip = el('span', { class: 'notechip' });
  const cmp = (html, label, fn, key) => el('button', { type: 'button', class: 'cmp-only', 'aria-label': label, 'data-key': key, html, onclick: fn });
  const head = el('div', { class: 'ins-head' }, icon, el('h2', {}, info.name, P.sub),
    p.type !== 'dropper' && p.type !== 'bucket' ? cmp('⟲', 'Turn left 15 degrees', () => rotateSelected(-15), 'cl') : null,
    p.type !== 'dropper' && p.type !== 'bucket' ? cmp('⟳', 'Turn right 15 degrees', () => rotateSelected(15), 'cr') : null,
    p.type === 'dropper' ? cmp('Drop', 'Drop a marble now', () => { piano.init(); dropFrom(p.id); }, 'cd') : null,
    P.more = cmp('▲', 'More: size, turn, copy, delete', () => { UI.inspFull = !UI.inspFull; refreshInspector(); }, 'cm'),
    el('button', { type: 'button', class: 'x', 'aria-label': 'Close (Esc)', 'data-key': 'close', text: '×', onclick: () => select(null) }));
  inspector.append(head);
  requestAnimationFrame(() => drawIcon(icon, Object.assign({}, ICON_PIECE[p.type], hasNote(p.type) ? { note: p.note } : {})));
  if (hasNote(p.type)) inspector.append(pianoSection(p, P));
  const keys = PARAM_KEYS[p.type].filter(() => p.type !== 'bucket');
  if (keys.length) {
    const grid = el('div', { class: 'sizes' });
    for (const k of keys) {
      const [lo, hi] = CANON.PIECES[p.type].ranges[k];
      const out = el('output', {});
      const inp = el('input', { type: 'range', min: lo, max: hi, step: SIZE_STEP[k], 'aria-label': SIZE_LABELS[k], 'data-key': 'size-' + k });
      inp.addEventListener('pointerdown', () => { UI.sliding = true; beginChange(); });
      inp.addEventListener('input', () => { out.textContent = inp.value; beginChange(); updatePieceRaw(p.id, { [k]: +inp.value }); touched('live'); if (!UI.sliding) endChange(); });
      const done = () => { if (UI.sliding) { UI.sliding = false; endChange(); refreshInspector(); } };
      inp.addEventListener('pointerup', done); inp.addEventListener('change', done); inp.addEventListener('pointercancel', done);
      P.sliders[k] = { inp, out };
      grid.append(el('span', { text: SIZE_LABELS[k] }), inp, out);
    }
    inspector.append(el('div', { class: 'ins-sec full-only' }, el('div', { class: 'lab', text: 'Size' }), grid));
  }
  if (p.type === 'dropper') inspector.append(dropperSection(p, P));
  else if (p.type !== 'bucket') {
    P.turn = el('span', {});
    inspector.append(el('div', { class: 'ins-sec full-only' }, el('div', { class: 'lab' }, 'Turn', P.turn),
      el('div', { class: 'btnrow' },
        el('button', { type: 'button', 'aria-label': 'Turn left 15 degrees (Shift+R)', 'data-key': 'tl', onclick: () => rotateSelected(-15), html: '⟲ 15°' }),
        el('button', { type: 'button', 'aria-label': 'Level', 'data-key': 'tlev', onclick: () => updatePiece(p.id, { rot: 0 }), text: 'Level' }),
        el('button', { type: 'button', 'aria-label': 'Turn right 15 degrees (R)', 'data-key': 'tr', onclick: () => rotateSelected(15), html: '⟳ 15°' }))));
  }
  inspector.append(el('div', { class: 'btnrow full-only' },
    el('button', { type: 'button', 'data-key': 'dup', onclick: () => duplicateSelected(), title: 'Ctrl+D', text: 'Duplicate' }),
    el('button', { type: 'button', class: 'danger', 'data-key': 'del', onclick: () => deleteSelected(), title: 'Delete', text: 'Delete' })));
}
// Update the built panel to the piece as it is now (no rebuild: the focus stays where it is)
function updateInspector(p) {
  const P = INS.parts;
  if (!P) return;
  const info = PIECE_INFO[p.type];
  P.sub.textContent = hasNote(p.type) ? (p.note ? 'plays ' : 'silent: it only steers') : info.tip;
  if (hasNote(p.type) && p.note) { P.chip.style.background = noteHex(p.note); P.chip.textContent = noteLabel(p.note); P.sub.append(P.chip); }
  if (P.mute) { P.mute.setAttribute('aria-pressed', String(!p.note)); P.mute.textContent = p.note ? 'Silent' : 'Silent ✓'; }
  const cur = noteToMidi(p.note);
  let focusKey = null;
  for (const k of P.keys) {
    const on = k.m === cur;
    k.b.classList.toggle('on', on); k.b.setAttribute('aria-pressed', String(on));
    if (on) focusKey = k.b;
  }
  if (P.keys.length && !P.keys.some((k) => k.b === document.activeElement)) {   // roving tab stop: the note's key (or the first)
    for (const k of P.keys) k.b.tabIndex = -1;
    (focusKey || P.keys[0].b).tabIndex = 0;
  }
  for (const k in P.sliders) { const S = P.sliders[k]; if (!UI.sliding && S.inp !== document.activeElement) S.inp.value = p[k]; S.out.textContent = String(Math.round(p[k])); }
  if (P.turn) P.turn.textContent = turnText(p);
  if (P.seg.length) {
    const s = p.schedule || { mode: 'manual' };
    for (const o of P.seg) o.b.setAttribute('aria-pressed', String(o.is(s)));
  }
  if (P.more) { P.more.innerHTML = UI.inspFull ? '▼' : '▲'; P.more.setAttribute('aria-expanded', String(!!UI.inspFull)); }
}
// Two octaves of piano keys from C of UI.oct; clicking a key plays it and tunes the piece. "Silent" turns it into a
// guide that only steers the marbles (a key brings its note back). One tab stop; Left / Right move along the keys.
function pianoSection(p, P) {
  const sec = el('div', { class: 'ins-sec ins-piano' });
  P.mute = el('button', { type: 'button', class: 'mutebtn', 'data-key': 'mute', title: 'A silent piece only steers the marbles', onclick: () => silenceSelected() });
  const lab = el('div', { class: 'lab full-only' }, 'Note', el('span', { class: 'oct' }, P.mute,
    el('button', { type: 'button', 'aria-label': 'Lower octave', 'data-key': 'octdn', text: '◀', disabled: UI.oct <= 2, onclick: () => { UI.oct--; refreshInspector(); } }),
    el('span', { text: 'C' + UI.oct + '–C' + (UI.oct + 2) }),
    el('button', { type: 'button', 'aria-label': 'Higher octave', 'data-key': 'octup', text: '▶', disabled: UI.oct >= 5, onclick: () => { UI.oct++; refreshInspector(); } })));
  const kb = el('div', { class: 'piano', role: 'group', 'aria-label': 'Piano keyboard: pick the note (Left and Right move along it)' });
  const base = (UI.oct + 1) * 12, whites = [0, 2, 4, 5, 7, 9, 11];
  const nW = 15, blacks = [], order = [];
  const key = (cls, m, style, kids) => {
    const n = midiToNote(m);
    const b = el('button', { type: 'button', class: cls, style, 'aria-label': noteLabel(n), 'data-key': 'k' + m, tabindex: '-1' }, ...kids);
    b.addEventListener('click', () => tuneSelected(n));
    P.keys.push({ b, m });
    order.push({ b, m });
    return b;
  };
  for (let i = 0; i < nW; i++) {
    const m = base + Math.floor(i / 7) * 12 + whites[i % 7], n = midiToNote(m);
    kb.append(key('w', m, '--kc:' + PITCH_HEX[m % 12], [el('span', { class: 'dot' }), el('span', { text: i % 7 === 0 ? noteLabel(n) : noteLetter(n) })]));
    if (i < nW - 1 && [0, 1, 3, 4, 5].includes(i % 7)) blacks.push([i, m + 1]);
  }
  for (const [i, m] of blacks) kb.append(key('b', m, `--kc:${PITCH_HEX[m % 12]};left:calc(${((i + 1) / nW) * 100}% - ${(100 / nW) * 0.3}%);width:${(100 / nW) * 0.6}%`, []));
  order.sort((a, b) => a.m - b.m);
  kb.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault(); e.stopPropagation();
    const i = order.findIndex((o) => o.b === document.activeElement);
    const j = clamp((i < 0 ? 0 : i) + (e.key === 'ArrowRight' ? 1 : -1), 0, order.length - 1);
    for (const o of order) o.b.tabIndex = -1;
    order[j].b.tabIndex = 0; order[j].b.focus();
  });
  sec.append(lab, kb);
  return sec;
}
// When it drops: once on Play, every 1, 2 or 4 beats, or (a song's dropper) its own song timing
function dropperSection(p, P) {
  const s = p.schedule || { mode: 'manual' };
  const seg = el('div', { class: 'seg', role: 'group', 'aria-label': 'When it drops' });
  const opt = (label, sched, is, key) => {
    const b = el('button', { type: 'button', text: label, 'data-key': key });
    b.addEventListener('click', () => setSchedule(p.id, sched));
    P.seg.push({ b, is });
    return b;
  };
  seg.append(opt('Once', { mode: 'manual' }, (x) => x.mode === 'manual' || x.mode === 'once', 'once'));
  for (const n of [1, 2, 4]) seg.append(opt(n === 1 ? 'Every beat' : 'Every ' + n + ' beats', { mode: 'repeat', every: n }, (x) => x.mode === 'repeat' && x.every === n, 'every' + n));
  if (s.mode === 'times') {
    const song = { mode: 'times', times: s.times.slice() };
    seg.append(opt('Song timing (' + s.times.length + ' drop' + (s.times.length === 1 ? '' : 's') + ')', song, (x) => x.mode === 'times', 'song'));
  }
  const sec = el('div', { class: 'ins-sec full-only' }, el('div', { class: 'lab', text: 'Drops' }), seg);
  sec.append(el('div', { class: 'btnrow' }, el('button', { type: 'button', 'data-key': 'dropnow', text: 'Drop a marble now', onclick: () => { piano.init(); dropFrom(p.id); } })));
  return sec;
}
function setSchedule(id, sched) {
  const p = pieceById(id);
  if (!p) return;
  const was = p.schedule && p.schedule.mode === 'times' && sched.mode !== 'times';
  updatePiece(id, { schedule: sched });
  if (was) toast('Song timing replaced.', 'Undo', () => undo(), 6000);
}
function silenceSelected() {
  const p = EDIT.selected && pieceById(EDIT.selected);
  if (!p || !hasNote(p.type) || !p.note) return;
  updatePiece(p.id, { note: null });
  say('Silent: marbles bounce off it without a note. Pick a key to give it one again.');
}
function tuneSelected(note) {
  const p = EDIT.selected && pieceById(EDIT.selected);
  if (!p || !hasNote(p.type)) return;
  piano.init();
  piano.play(noteFreq(note), 0.6, 0, PIECE_METAL[p.type], piecePan(p));
  const f = fxOf(p.id); f.glow = 1; f.wiggle = 0.6;
  onNoteVisual({ pieceId: p.id, note });
  if (p.note !== note) updatePiece(p.id, { note });
}

/* ============================================================================
 *  DEMOS GALLERY and the MUSIC STRIP
 * ========================================================================== */
function openDialog(d, focusSel) {
  d.hidden = false;
  UI.returnFocus = document.activeElement;
  const f = d.querySelector(focusSel || 'button');
  if (f) f.focus({ preventScroll: true });
}
function closeDialog(d) {
  d.hidden = true;
  const r = UI.returnFocus;
  if (r && r.focus && document.contains(r) && r !== document.body) r.focus({ preventScroll: true }); else stageEl().focus({ preventScroll: true });
}
for (const d of [demosDlg, menuDlg]) {
  d.addEventListener('click', (e) => { if (e.target === d || (e.target.closest && e.target.closest('[data-close]'))) closeDialog(d); });
}
function openDemos() {
  perfQuiet();
  const box = $('#demoCards');
  box.textContent = '';
  for (const def of MarbleDemos.list()) {
    const cv = el('canvas', { 'aria-hidden': 'true' });
    const card = el('div', { class: 'card' }, cv, el('div', { class: 'body' },
      el('h3', {}, def.title, el('small', { text: def.subtitle || '' })),
      el('div', { class: 'btnrow' },
        el('button', { type: 'button', class: 'play', text: '▶ Play', 'aria-label': 'Play ' + def.title, onclick: () => { closeDialog(demosDlg); loadDemo(def.id, true); } }),
        el('button', { type: 'button', text: 'Remix', 'aria-label': 'Remix ' + def.title + ' in the builder', onclick: () => { closeDialog(demosDlg); loadDemo(def.id, false); remixDemo(); } }))));
    box.append(card);
    UI.demoCards.set(def.id, cv);
    requestAnimationFrame(() => { const b = MarbleDemos.build(def.id); drawRoll(cv, b ? b.targets : [], null, null, b && demoClock(b)); });
  }
  openDialog(demosDlg, '.card .play');
}
demosBtn.addEventListener('click', () => openDemos());
UI.demoCards = new Map();
function loadDemo(id, andPlay) {
  perfQuiet();
  const b = MarbleDemos.build(id);
  if (!b) return demoNotReady(id, andPlay);
  stop();
  const kept = stashUserRun() || listRecent().length > 0;
  loadLayoutUndoable(b.layout, id);
  select(null);
  homeView();
  piano.prepare(layoutVoices());
  if (andPlay) { piano.init(); play(); }
  refreshTransport();
  if (kept) toast((andPlay ? 'Playing ' : 'Opened ') + b.title + '. Your run is safe.', 'Back to my run', backToMyRun, 6000);
  else hideToast();
  if (!b.verified) toastMore('It may not play note-perfectly on this computer.', 7000);   // (the check failed and the solve could not do better)
  say('Loaded the demo ' + b.title);
  return true;
}
// A demo that is not ready: its baked tower failed CANON's check on this computer and it is being solved again in
// the background (20-demos.js, 23-solver-worker.js: the page stays responsive; a progress note counts the seconds
// and the demo opens by itself when it lands), or it could not be built at all (the other songs are offered)
function demoNotReady(id, andPlay) {
  const st = MarbleDemos.status(id), def = MarbleDemos.get(id), title = def ? def.title : 'That demo';
  clearInterval(UI.solveTick);
  if (st.state === 'solving') {
    UI.wantDemo = { id, andPlay };
    const text = () => { const s = Math.round((MarbleDemos.status(id).elapsed || 0) / 1000); return title + ' plays differently on this computer, so it is being solved again here… ' + s + ' s' + (s >= 30 ? ' (still solving)' : s >= 8 ? ' (up to about half a minute)' : ''); };
    toast(text(), 'Cancel', () => { UI.wantDemo = null; clearInterval(UI.solveTick); MarbleDemos.cancel(id); }, 1e9);
    UI.solveTick = setInterval(() => {
      if (MarbleDemos.status(id).state !== 'solving' || !UI.wantDemo || UI.wantDemo.id !== id) { clearInterval(UI.solveTick); return; }
      const t = $('#toast span'); if (t) t.textContent = text();
    }, 1000);
    return false;
  }
  UI.wantDemo = null;
  toast(title + ' could not be built on this computer. The other songs are in Demos.', 'Demos', openDemos, 8000);
  return false;
}
// A background solve finished (MarbleDemos calls this): open the demo the user is waiting for; redraw its card
function onDemoStatus(id, state, out) {
  const w = UI.wantDemo;
  if (w && w.id === id) {
    UI.wantDemo = null; clearInterval(UI.solveTick);
    if (state === 'ready') { hideToast(); loadDemo(id, w.andPlay); toastMore(out.verified ? 'Solved!' : 'Solved, though not note-perfect here.'); }
    else demoNotReady(id, w.andPlay);
  }
  const cv = UI.demoCards.get(id);
  if (cv && !demosDlg.hidden) drawRoll(cv, out ? out.targets : [], null, null, out && demoClock(out));
}
// Open the newest of your recent runs again (after a demo or a link replaced it). The run on the board goes to
// Recent first (a remix such as "My Ode to Joy" is yours too), so pressing it again swaps back.
function backToMyRun() {
  const r = listRecent()[0];
  if (!r) { toast('No run of yours to go back to.'); return false; }
  stop();
  stashUserRun();
  loadLayoutUndoable(r.layout);
  select(null);
  frameRun();
  toast('Back to “' + MODEL.name + '”.', 'Undo', () => undo(), 6000);
  return true;
}
// A demo becomes your own run: by Remix, or by your first edit of it. The song stays as the target in the strip.
function adoptDemo(fromEdit) {
  if (!MODEL.demoId) return;
  const b = MarbleDemos.cached(MODEL.demoId);
  MODEL.remixOf = MODEL.demoId; MODEL.demoId = null;
  MODEL.name = ('My ' + (b ? b.title : 'remix')).slice(0, 60);
  if (fromEdit) toast('It\'s your run now: “' + MODEL.name + '”.', 'Undo', () => undo(), 6000);
}
function remixDemo() {
  if (!MODEL.demoId) return;
  change(() => adoptDemo(false));
  relayout();
  if (!tallBoard()) frameRun();                          // (a tower stays where you are looking)
  toast('It\'s your run now: move, retune and add pieces!');
}
$('#remixBtn').addEventListener('click', () => { stop(); remixDemo(); refreshTransport(); });
$('#backBtn').addEventListener('click', () => backToMyRun());
// A demo's beat grid (its layout's timing: start, meter, tempo map), cached per demo
const DEMO_CLOCKS = new WeakMap();
function demoClock(b) {
  let c = DEMO_CLOCKS.get(b);
  if (!c) DEMO_CLOCKS.set(b, (c = makeBeatClock(b.layout.timing, b.layout.tempo)));
  return c;
}
// A piano-roll picture of a song over its own beat grid (beats and bar lines, which close up as a song speeds up):
// the melody in the upper lane, the accompaniment in a thinner lane below (darker pills). `now` draws a playhead,
// lights the notes played in time (`played`: target indexes) and, when the tempo changes, the tempo at that moment.
const ROLL_BEATS = [];
function drawRoll(cv, targets, now, played, clock) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2), w = cv.clientWidth || 240, h = cv.clientHeight || 90;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  g.fillStyle = '#231a12'; g.fillRect(0, 0, w, h);
  if (!targets || !targets.length) { g.fillStyle = 'rgba(255,255,255,0.5)'; g.font = `700 12px ${UI_FONT}`; g.textAlign = 'center'; g.fillText('tuning the run…', w / 2, h / 2); return; }
  // lanes: melody (voice 0) above, accompaniment below, each with its own pitch range
  const lanes = [{ lo: 999, hi: -999 }, { lo: 999, hi: -999 }], ms = new Array(targets.length);
  for (let i = 0; i < targets.length; i++) {
    const m = noteToMidi(targets[i].note), L = lanes[targets[i].voice ? 1 : 0];
    ms[i] = m; if (m < L.lo) L.lo = m; if (m > L.hi) L.hi = m;
  }
  const two = lanes[1].hi >= lanes[1].lo && lanes[0].hi >= lanes[0].lo, split = two ? Math.round(h * 0.64) : h;
  lanes[0].y0 = 3; lanes[0].y1 = split - (two ? 3 : 3); lanes[1].y0 = split + 2; lanes[1].y1 = h - 3;
  if (!(lanes[0].hi >= lanes[0].lo)) { lanes[0] = lanes[1]; }
  let t0 = targets[0].t, tn = targets[0].t;
  for (const x of targets) { if (x.t < t0) t0 = x.t; if (x.t > tn) tn = x.t; }
  t0 = now == null ? t0 - 0.3 : now - 1.2;
  const span = now == null ? tn - targets[0].t + 0.9 : 5;
  const X = (t) => ((t - t0) / span) * w;
  const Y = (m, L) => L.y1 - 2 - ((m - L.lo + 0.5) / Math.max(1, L.hi - L.lo + 1)) * (L.y1 - L.y0 - 4);
  if (two) { g.fillStyle = 'rgba(0,0,0,0.25)'; g.fillRect(0, split, w, h - split); g.fillStyle = 'rgba(255,236,200,0.12)'; g.fillRect(0, split, w, 1); }
  if (clock) {
    for (const [b, tb] of clock.beats(t0, t0 + span, ROLL_BEATS)) {
      const bar = clock.isBar(b);
      if (!bar && now == null) continue;                        // (the whole-song picture: bar lines only)
      const x = Math.round(X(tb)) + 0.5;
      g.strokeStyle = bar ? 'rgba(255,236,200,0.2)' : 'rgba(255,236,200,0.07)'; g.lineWidth = 1;
      g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke();
    }
  }
  const pw = Math.max(5, Math.min(14, w / (span * 3.2)));
  for (let i = 0; i < targets.length; i++) {
    const x = targets[i], px = X(x.t);
    if (px < -20 || px > w + 20) continue;
    const L = lanes[x.voice && two ? 1 : 0], acc = x.voice && two;
    const ph = Math.max(3, Math.min(acc ? 6 : 8, (L.y1 - L.y0 - 4) / Math.max(4, L.hi - L.lo + 1) + 1)), py = Y(ms[i], L);
    // (a note counts as played only once the playhead reaches it: the sim runs a little ahead of the picture)
    const past = now != null && x.t <= now, hit = past && played && played.has(i);
    g.globalAlpha = now == null ? 1 : past ? (hit ? 1 : 0.4) : 0.85;
    const col = PITCH_HEX[((ms[i] % 12) + 12) % 12];
    g.fillStyle = acc ? mixHex(col, '#1a120c', 0.35) : col;
    roundRectPath(g, px - pw / 2, py - ph / 2, pw, ph, ph / 2); g.fill();
    if (past && !hit) { g.strokeStyle = 'rgba(255,120,100,0.9)'; g.lineWidth = 1; g.stroke(); }
    if (hit && now - x.t < 0.35) { g.globalAlpha = 1 - (now - x.t) / 0.35; g.strokeStyle = '#fff'; g.lineWidth = 2; g.stroke(); }
  }
  g.globalAlpha = 1;
  if (now != null) { const px = X(now); g.strokeStyle = 'rgba(255,255,255,0.85)'; g.lineWidth = 1.5; g.beginPath(); g.moveTo(px, 2); g.lineTo(px, h - 2); g.stroke(); }
  if (now != null && clock && clock.varies) {
    const txt = '♩ = ' + Math.round(clock.bpmAt(Math.max(now, clock.start)));
    g.font = `800 11px ${UI_FONT}`; g.textAlign = 'right'; g.textBaseline = 'top';
    const tw = g.measureText(txt).width;
    g.fillStyle = 'rgba(35,26,18,0.8)'; g.fillRect(w - tw - 10, 2, tw + 8, 15);
    g.fillStyle = 'rgba(255,240,215,0.95)'; g.fillText(txt, w - 6, 4);
  }
}
// The song on the board: a demo, or the demo a remix came from (then its notes are the target to keep in time)
function stripDemo() { const id = MODEL.demoId || MODEL.remixOf; return id && MarbleDemos.cached(id) ? id : null; }
// While a song is on the board: its title and the roll; playing, the roll scrolls and lights each target played in
// time (same pitch within 15 ms); a remix counts how many notes are still in time
const STRIP = { id: null, played: new Set(), lastLen: 0, key: '', count: '' };
const STRIP_TOL = 0.015;
function refreshStrip() {
  const id = stripDemo(), b = id ? MarbleDemos.cached(id) : null;
  const on = !!b;
  if (stripEl.hidden === on) { stripEl.hidden = !on; document.body.classList.toggle('has-strip', on); remeasureUI(); }
  if (!on) { STRIP.id = null; return; }
  if (cineBtn.hidden !== !glOk) cineBtn.hidden = !glOk;          // (the 2D view is front-on: nothing to swing)
  const remix = !MODEL.demoId, key = id + '|' + remix + '|' + MODEL.name;
  if (STRIP.key !== key) {
    STRIP.key = key; STRIP.id = id; STRIP.played.clear(); STRIP.lastLen = 0; STRIP.count = '';
    const t = $('#stripTitle'); t.textContent = '';
    t.append(remix ? MODEL.name : b.title, el('small', { id: 'stripSub', class: remix ? '' : 'demo-sub', text: remix ? 'Original: ' + b.title : b.verified ? 'one landing, one note' : 'not quite in tune here' }));
    $('#remixBtn').hidden = remix;
    $('#backBtn').hidden = !listRecent().length;
  }
  const cv = $('#stripCanvas');
  if (SIM.session && SIM.world) {
    const now = SIM.dispT, notes = SIM.world.notes;
    if (notes.length < STRIP.lastLen) STRIP.played.clear();
    for (let i = STRIP.lastLen; i < notes.length; i++) {       // light the target each played note matches
      const n = notes[i];
      if (n.t > now + 0.5) break;
      let best = -1, be = STRIP_TOL + 1e-9;
      for (let k = lowerBound(b.targets, n.t - STRIP_TOL); k < b.targets.length && b.targets[k].t <= n.t + STRIP_TOL; k++) {
        const x = b.targets[k], e = Math.abs(x.t - n.t);
        if (x.note === n.note && e < be && !STRIP.played.has(k)) { be = e; best = k; }
      }
      if (best >= 0) STRIP.played.add(best);
      STRIP.lastLen = i + 1;
    }
    drawRoll(cv, b.targets, now, STRIP.played, demoClock(b));
    if (remix) {
      const due = lowerBound(b.targets, now + 1e-9);           // (counted as the playhead reaches them, like the roll)
      let inTime = 0;
      for (const k of STRIP.played) if (k < due) inTime++;
      const txt = 'Still in time: ' + inTime + '/' + b.targets.length + ' notes';
      if (due > 0 && txt !== STRIP.count) { STRIP.count = txt; $('#stripSub').textContent = txt; }
    }
  } else if (STRIP.drawnStill !== id + '|' + cv.clientWidth + '|' + cv.clientHeight) { STRIP.drawnStill = id + '|' + cv.clientWidth + '|' + cv.clientHeight; drawRoll(cv, b.targets, null, null, demoClock(b)); }
  if (SIM.session) STRIP.drawnStill = '';
}
onSimChange((k) => { if (k === 'play') { STRIP.played.clear(); STRIP.lastLen = 0; } });

/* ============================================================================
 *  MINIMAP (towers) and the FOLLOW button
 *  A slim picture of the whole tower at the left of the board: the board, every piece in its note's colour (silent
 *  ones grey), the predicted path, where the view is (a bright frame) and where the marbles are (glowing dots).
 *  Press or drag on it to go there (a press on the marble, once the camera has let go of it, follows it again). It is a
 *  vertical slider for the keyboard too (arrow keys, Page Up / Down, Home / End). The Follow button appears beside
 *  it when the camera has stopped following a playing run because you scrolled away.
 * ========================================================================== */
const miniEl = $('#minimap'), miniCv = $('#miniCanvas'), followBtn = $('#followBtn');
const MINI = { k: 1, rect: null, key: '', layer: null, dyn: '', drag: false };
// Board point <-> minimap canvas point (CSS px)
const miniX = (x) => (x - FIT_BOX.x0) * MINI.k, miniY = (y) => (y - FIT_BOX.y0) * MINI.k;
function placeMinimap() {
  const m = minimapRect(SAFE.base || hudRect());
  const on = !!m;
  if (miniEl.hidden === on) miniEl.hidden = !on;
  if (!on) { MINI.rect = null; followBtn.hidden = true; return; }
  const key = [m.l, m.t, m.w, m.h].map(Math.round).join(',');
  if (MINI.rect && MINI.rect.key === key) return;
  MINI.rect = Object.assign({ key }, m);
  Object.assign(miniEl.style, { left: m.l + 'px', top: m.t + 'px', width: m.w + 'px', height: m.h + 'px', padding: m.pad + 'px' });
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  miniCv.width = Math.round(m.cw * dpr); miniCv.height = Math.round(m.ch * dpr);
  MINI.k = m.cw / (FIT_BOX.x1 - FIT_BOX.x0); MINI.key = ''; MINI.dyn = '';
  Object.assign(followBtn.style, { left: (m.l + m.w + 8) + 'px', top: (m.t + Math.max(0, m.h - 44)) + 'px' });
}
// The still picture (board, pieces, path), redrawn when the run or the preview changes
function miniLayer() {
  const paths = UI.showPath ? PREVIEW.paths : null, key = MODEL.version + '|' + miniCv.width + 'x' + miniCv.height + '|' + (paths ? PREVIEW.gen : '');
  if (MINI.key === key && MINI.layer) return MINI.layer;
  MINI.key = key;
  const c = MINI.layer || (MINI.layer = document.createElement('canvas'));
  c.width = miniCv.width; c.height = miniCv.height;
  const g = c.getContext('2d'), dpr = miniCv.width / MINI.rect.cw, k = MINI.k;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.fillStyle = '#cfae7c'; g.fillRect(0, 0, MINI.rect.cw, MINI.rect.ch);                           // the pine frame
  g.fillStyle = '#8d6a45'; g.fillRect(miniX(-BOARD_PAD), miniY(-BOARD_PAD), (BOARD_W + 2 * BOARD_PAD) * k, (BOARD_H + 2 * BOARD_PAD) * k);
  g.fillStyle = '#b9bec5'; g.fillRect(miniX(TROUGH.x0), miniY(TROUGH.y0), (TROUGH.x1 - TROUGH.x0) * k, Math.max(1.5, (TROUGH.y1 - TROUGH.y0) * k));
  if (paths) {                                                                                     // the way down
    g.strokeStyle = 'rgba(255, 255, 255, 0.45)'; g.lineWidth = 1; g.lineJoin = 'round';
    paths.forEach((pr) => {
      const P = pr.path;
      if (P.length < 2) return;
      g.beginPath(); g.moveTo(miniX(P[0][0]), miniY(P[0][1]));
      for (let i = 4; i < P.length; i += 4) g.lineTo(miniX(P[i][0]), miniY(P[i][1]));
      g.stroke();
    });
  }
  g.lineCap = 'round';
  const lw = Math.max(1.4, 10 * k);
  for (const p of MODEL.pieces) {
    const col = p.type === 'dropper' ? '#e8b64c' : p.type === 'bucket' ? '#d9dde2' : p.note ? noteHex(p.note) : '#e4e7eb';
    g.strokeStyle = col; g.fillStyle = col; g.lineWidth = lw;
    if (p.type === 'dropper') { g.fillRect(miniX(p.x) - 2, miniY(p.y - 100), 4, Math.max(3, 100 * k)); continue; }
    if (p.type === 'bell') { g.beginPath(); g.arc(miniX(p.x), miniY(p.y), Math.max(1.4, p.r * k), 0, Math.PI * 2); g.fill(); continue; }
    g.beginPath();
    for (const cl of CANON.colliders(p)) { if (cl.shape === 'seg') { g.moveTo(miniX(cl.ax), miniY(cl.ay)); g.lineTo(miniX(cl.bx), miniY(cl.by)); } }
    g.stroke();
  }
  return c;
}
// Each frame (cheap: the still picture is cached): the view's frame, the marbles and the pieces that just played
function drawMinimap() {
  placeMinimap();
  if (!MINI.rect) return;
  const marbles = drawnMarbles();
  const dyn = MINI.key + '|' + VIEWCAM.version + '|' + (marbles.length ? SIM.dispT : '') + '|' + SIM.fx.size;
  const layer = miniLayer();
  if (dyn === MINI.dyn && MINI.key === MINI.drawnKey) return;
  MINI.dyn = dyn; MINI.drawnKey = MINI.key;
  const g = miniCv.getContext('2d'), dpr = miniCv.width / MINI.rect.cw, W = MINI.rect.cw, H = MINI.rect.ch;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.drawImage(layer, 0, 0);
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  for (const [id, f] of SIM.fx) {                                          // pieces ringing now
    if (!(f.glow > 0.05)) continue;
    const p = pieceById(id);
    if (!p) continue;
    g.globalAlpha = Math.min(1, f.glow); g.fillStyle = p.note ? mixHex(noteHex(p.note), '#ffffff', 0.4) : '#fff';
    g.beginPath(); g.arc(miniX(p.x), miniY(p.y), 3.2, 0, Math.PI * 2); g.fill();
  }
  g.globalAlpha = 1;
  // the view: a bright frame round the part of the tower on screen: the free area's corners cast through the camera
  // onto the marble plane (a trapezium from an angle; a corner whose ray lands far off or misses the board is kept
  // within three front-on spans of the target)
  const sr = uiSafeRect(), c = viewCentre(), [sw, sh] = viewSpan();
  const Q = [[sr.l, sr.t], [sr.r, sr.t], [sr.r, sr.b], [sr.l, sr.b]].map(([px, py]) => {
    const b = VIEW.s2b(px, py);
    return [clamp(miniX(clamp(b[0], c[0] - 3 * sw, c[0] + 3 * sw)), 0.75, W - 0.75), clamp(miniY(clamp(b[1], c[1] - 3 * sh, c[1] + 3 * sh)), 0.75, H - 0.75)];
  });
  g.beginPath(); for (let i = 0; i < 4; i++) { if (i) g.lineTo(Q[i][0], Q[i][1]); else g.moveTo(Q[i][0], Q[i][1]); } g.closePath();
  g.fillStyle = 'rgba(255, 255, 255, 0.18)'; g.fill();
  g.lineJoin = 'round';
  g.strokeStyle = 'rgba(20, 14, 8, 0.6)'; g.lineWidth = 3; g.stroke();
  g.strokeStyle = '#fff'; g.lineWidth = 1.5; g.stroke();
  // the marbles
  for (const m of marbles) {
    const q = marbleDrawPos(m, DRAWPOS);
    if (!q) continue;
    const x = miniX(q[0]), y = miniY(q[1]);
    const gr = g.createRadialGradient(x, y, 0, x, y, 7);
    gr.addColorStop(0, 'rgba(255, 246, 200, 0.95)'); gr.addColorStop(1, 'rgba(255, 220, 120, 0)');
    g.fillStyle = gr; g.beginPath(); g.arc(x, y, 7, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#4f9be8'; g.strokeStyle = '#fff'; g.lineWidth = 1.2;
    g.beginPath(); g.arc(x, y, 2.6, 0, Math.PI * 2); g.fill(); g.stroke();
  }
  // (for assistive tech: how far down the tower the view is)
  const pct = Math.round(clamp((c[1] - FIT_BOX.y0) / (FIT_BOX.y1 - FIT_BOX.y0), 0, 1) * 100);
  if (miniEl.getAttribute('aria-valuenow') !== String(pct)) { miniEl.setAttribute('aria-valuenow', String(pct)); miniEl.setAttribute('aria-valuetext', pct + '% of the way down the tower'); }
}
// Press / drag: go there. A press on a marble (while the camera has let go of it) follows it again.
function miniBoardPoint(e) {
  const r = miniCv.getBoundingClientRect();
  return [FIT_BOX.x0 + (e.clientX - r.left) / MINI.k, FIT_BOX.y0 + (e.clientY - r.top) / MINI.k];
}
function miniGo(e, glide) {
  const [x, y] = miniBoardPoint(e), [sw] = viewSpan(), B = FIT_BOX;
  const cx = B.x1 - B.x0 <= sw * 1.02 ? (B.x0 + B.x1) / 2 : x;
  pauseFollow(); setViewMode('free'); stopFling(); SCROLLQ.x = SCROLLQ.y = 0;
  if (glide) glideTo(cx, y, Math.max(VIEWCAM.zoom, homeZoom() * 0.999), 0.3); else { VIEWCAM.glide = null; setViewCentre(cx, y); }
}
miniEl.addEventListener('pointerdown', (e) => {
  if (e.button !== undefined && e.button !== 0) return;
  e.preventDefault();
  try { miniEl.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
  if (TFOLLOW.active && TFOLLOW.paused) {                       // on the marble: follow it again
    const [x, y] = miniBoardPoint(e), lead = leadMarble();
    if (lead && Math.hypot(lead.x - x, lead.y - y) * MINI.k < 12) { resumeFollow(); return; }
  }
  MINI.drag = true;
  miniGo(e, true);
});
miniEl.addEventListener('pointermove', (e) => { if (MINI.drag) miniGo(e, false); });
const miniUp = () => { MINI.drag = false; };
miniEl.addEventListener('pointerup', miniUp);
miniEl.addEventListener('pointercancel', miniUp);
miniEl.addEventListener('wheel', (e) => { e.preventDefault(); scrollView(0, e.deltaY * (e.deltaMode === 1 ? 32 : 1)); }, { passive: false });
miniEl.addEventListener('keydown', (e) => {
  const [, sh] = viewSpan(), ppu = VIEW.ppu(), c = viewCentre();
  const step = { ArrowDown: 0.15, ArrowUp: -0.15, PageDown: 0.85, PageUp: -0.85 }[e.key];
  if (step) { e.preventDefault(); e.stopPropagation(); scrollView(0, step * sh * ppu); return; }
  if (e.key === 'Home' || e.key === 'End') { e.preventDefault(); e.stopPropagation(); pauseFollow(); glideTo(c[0], e.key === 'Home' ? FIT_BOX.y0 + sh / 2 : FIT_BOX.y1 - sh / 2, VIEWCAM.zoom, 0.6); }
});
// Shown while a tower's run plays and the camera has let go of the marble
function refreshFollowBtn() {
  const show = !!MINI.rect && TFOLLOW.active && TFOLLOW.paused;
  if (followBtn.hidden === !show) return;
  followBtn.hidden = !show;
  if (show) say('The camera stopped following the marble. Press Follow to follow it again.');
}
followBtn.addEventListener('click', () => { resumeFollow(); stageEl().focus({ preventScroll: true }); });
// The first tower you see says once how to get about it (remembered: 'marbleMusic.towerHint')
function towerHint() {
  if (!tallBoard() || store.get('marbleMusic.towerHint') || !coach.hidden) return;
  store.set('marbleMusic.towerHint', '1');
  let tries = 0;
  const show = () => {                                        // (after any toast already showing: never over a notice)
    if ($('#toast').classList.contains('show') && tries++ < 4) { setTimeout(show, 2500); return; }
    if (!tallBoard()) return;
    toast((touchUI ? 'A tower! Two fingers slide it up and down, one finger turns it round' : 'A tower! Scroll to go up and down, drag to turn it round') +
      ' (the map on the left shows all of it). Play follows the marble.', null, null, 6500);
  };
  setTimeout(show, 900);
}

/* ---- Board size (Save & share > Board): Wide, Tower or Tall tower. No piece is ever lost (resizeBoard): the run
 *  stays centred, a board too small for it grows to hold it, and Undo puts the old board back. ---- */
const boardSeg = $('#boardSeg');
// A small picture of the board's shape with a zig-zag of bars on it (a Wide board, a Tower, a Tall tower)
const BOARD_ICON = { wide: [28, 17, 2], tower: [14, 26, 3], tall: [11, 31, 4] };
function boardIcon(S) {
  const [w, h, n] = BOARD_ICON[S.id] || [20, 20, 2], x0 = 16 - w / 2, y0 = 16 - h / 2, cols = ['#e5392f', '#f0d02a', '#2a8fcf', '#5fb944'];
  let bars = '';
  for (let i = 0; i < n; i++) {
    const y = y0 + h * (i + 0.7) / (n + 0.4), l = x0 + w * 0.18, r = x0 + w * 0.82, d = Math.min(3, h / (n * 3));
    bars += '<path d="M' + l.toFixed(1) + ' ' + (y - (i % 2 ? -d : d)).toFixed(1) + 'L' + r.toFixed(1) + ' ' + (y + (i % 2 ? -d : d)).toFixed(1) + '" stroke="' + cols[i % 4] + '" stroke-width="1.8" stroke-linecap="round"/>';
  }
  return el('span', { class: 'bicon', 'aria-hidden': 'true', html: '<svg viewBox="0 0 32 32"><rect x="' + x0 + '" y="' + y0 + '" width="' + w + '" height="' + h + '" rx="1.5" fill="#8d6a45" stroke="#cfae7c" stroke-width="1.6"/>' + bars + '</svg>' });
}
function renderBoardChoice() {
  boardSeg.textContent = '';
  const cur = boardSizeOf();
  for (const S of BOARD_SIZES) {
    const b = el('button', { type: 'button', 'aria-pressed': String(cur === S), title: S.name + ' board: ' + S.w + ' × ' + S.h },
      boardIcon(S), el('span', {}, S.name, el('small', { text: S.w + ' × ' + S.h })));
    b.addEventListener('click', () => chooseBoard(S));
    boardSeg.append(b);
  }
  $('#boardNow').textContent = cur ? '' : 'This board is ' + Math.round(BOARD_W) + ' × ' + Math.round(BOARD_H) + '.';
}
function chooseBoard(S) {
  if (BOARD_W === S.w && BOARD_H === S.h) { closeDialog(menuDlg); return; }
  stop();
  const r = resizeBoard(S.w, S.h);
  closeDialog(menuDlg);
  homeView();                                               // (the new board as it now is: Wide whole, a tower from the top)
  refreshTransport();
  let msg = 'Board: ' + S.name + ' (' + r.w + ' × ' + r.h + ').';
  if (r.grew) msg = 'Board: ' + r.w + ' × ' + r.h + ', just big enough to keep every piece.';
  else if (r.dx) msg += ' Your run moved with it.';
  toast(msg, 'Undo', () => undo(), 7000);
}

/* ============================================================================
 *  SAVE & SHARE
 * ========================================================================== */
const scaleSel = $('#scaleSel');
for (const k of Object.keys(SCALES)) scaleSel.append(el('option', { value: k, text: k }));
scaleSel.value = MODEL.scale;
scaleSel.addEventListener('change', () => { MODEL.scale = scaleSel.value; store.set('marbleMusic.scale', MODEL.scale); refreshTray(true); });
function openMenu() {
  $('#nameInput').value = MODEL.name;
  $('#shareOut').hidden = true;
  UI.slotAsk = null;
  renderSlots();
  renderBoardChoice();
  $('#twoDBtn').hidden = !glOk;
  openDialog(menuDlg, touchUI ? '[data-close]' : '#nameInput');
}
const fmtDate = (t) => { try { return new Date(t).toLocaleDateString(); } catch (e) { return ''; } };
// Saved runs (and, while a save needs a choice, the question), then your recent runs
function renderSlots() {
  const ul = $('#slotList'), ask = UI.slotAsk;
  ul.textContent = '';
  const slots = listSlots();
  if (ask) {
    const q = el('li', { class: 'ask' }, el('span', { text: ask.full ? 'Your ' + MAX_SLOTS + ' saved runs are full: pick one to replace.' : 'A run called “' + ask.name + '” is saved already.' }));
    if (!ask.full) {
      q.append(el('button', { type: 'button', text: 'Replace', onclick: () => doSave(ask.name, ask.index) }),
        el('button', { type: 'button', text: 'Save as “' + ask.alt + '”', onclick: () => doSave(ask.alt, -1) }));
    }
    q.append(el('button', { type: 'button', 'aria-label': 'Cancel', text: '×', onclick: () => { UI.slotAsk = null; renderSlots(); } }));
    ul.append(q);
  }
  if (!slots.length) ul.append(el('li', {}, el('small', { text: 'Saved runs appear here.' })));
  slots.forEach((s, i) => {
    const replace = ask && ask.full;
    ul.append(el('li', {}, el('span', { text: s.name }), el('small', { text: fmtDate(s.t) }),
      replace ? el('button', { type: 'button', text: 'Replace', onclick: () => doSave(ask.name, i) })
        : el('button', { type: 'button', text: 'Open', 'aria-label': 'Open ' + s.name, onclick: () => openRun(s.layout, 'Opened “' + s.name + '”') }),
      replace ? null : el('button', { type: 'button', class: 'danger', 'aria-label': 'Delete ' + s.name, text: '×', onclick: () => {
        const gone = deleteSlot(i);
        renderSlots();
        if (gone) toast('Deleted “' + gone.name + '”.', 'Undo', () => { restoreSlot(gone, i); if (!menuDlg.hidden) renderSlots(); }, 6000);
      } })));
  });
  const rec = $('#recentList');
  rec.textContent = '';
  const recent = listRecent();
  $('#recentSec').hidden = !recent.length;
  for (const r of recent) {
    rec.append(el('li', {}, el('span', { text: r.name || 'My marble run' }), el('small', { text: r.layout.pieces.length + ' pieces · ' + fmtDate(r.t) }),
      el('button', { type: 'button', text: 'Open', 'aria-label': 'Open ' + (r.name || 'recent run'), onclick: () => openRun(r.layout, 'Opened “' + (r.name || 'My marble run') + '”') })));
  }
}
// Open a saved or recent run (your current run goes to Recent first)
function openRun(layout, msg) {
  stop();
  stashUserRun();
  loadLayoutUndoable(layout);
  select(null);
  closeDialog(menuDlg);
  frameRun();
  toast(msg, 'Undo', () => undo(), 6000);
}
function saveError(err) { toast(err === 'quota' ? 'Could not save: this browser\'s storage is full. Delete an old run, or use Export .json.' : 'Could not save here (storage is blocked). Use Export .json instead.', null, null, 6000); }
function doSave(name, index) {
  const err = saveSlot(name, index);
  if (err === 'full') { UI.slotAsk = { full: true, name }; renderSlots(); return; }
  UI.slotAsk = null;
  if (err) { saveError(err); renderSlots(); return; }
  toast('Saved “' + name + '”'); renderSlots(); refreshTransport();
}
menuBtn.addEventListener('click', () => openMenu());
$('#nameInput').addEventListener('change', (e) => { MODEL.name = e.target.value.trim().slice(0, 60) || 'My marble run'; autosaveSoon(); refreshTransport(); });
$('#saveBtn').addEventListener('click', () => {
  const name = $('#nameInput').value.trim().slice(0, 60) || 'My marble run';
  const slots = listSlots(), i = slots.findIndex((s) => s.name === name);
  if (i >= 0) {                                   // never overwrite without asking
    let k = 2; while (slots.some((s) => s.name === name + ' (' + k + ')')) k++;
    UI.slotAsk = { name, index: i, alt: (name + ' (' + k + ')').slice(0, 60) };
    renderSlots();
    return;
  }
  if (slots.length >= MAX_SLOTS) { UI.slotAsk = { full: true, name }; renderSlots(); return; }
  doSave(name, -1);
});
$('#shareBtn').addEventListener('click', () => {
  const url = shareURL(), out = $('#shareOut');
  out.value = url; out.hidden = false; out.focus(); out.select();
  let ok = false;
  try { ok = document.execCommand && document.execCommand('copy'); } catch (e) { ok = false; }
  const local = location.protocol === 'file:';
  const done = (copied) => toast(local ? (copied ? 'Link copied. ' : '') + 'This link works on this computer. To send the run to someone, use Export .json.'
    : copied ? 'Link copied: anyone who opens it gets this run.' : 'Copy the link from the box.', null, null, local ? 6000 : 2600);
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(() => done(true), () => done(ok));
  else done(ok);
});
$('#exportBtn').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(getLayout(), null, 1)], { type: 'application/json' });
  const a = el('a', { href: URL.createObjectURL(blob), download: (MODEL.name || 'marble-run').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') + '.json' });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
});
$('#importBtn').addEventListener('click', () => $('#importFile').click());
const IMPORT_MAX = 2 * 1048576;
$('#importFile').addEventListener('change', (e) => {
  const f = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!f) return;
  if (f.size > IMPORT_MAX) { toast('That file is too big to be a marble run.'); return; }
  f.text().then((txt) => {
    const L = JSON.parse(txt);
    if (!L || !Array.isArray(L.pieces)) throw new Error('no pieces');
    stop(); stashUserRun(); loadLayoutUndoable(L); select(null); closeDialog(menuDlg); frameRun();
    const extra = loadReportText();
    toast('Imported “' + MODEL.name + '”.' + (extra ? ' ' + extra : ''), 'Undo', () => undo(), extra ? 8000 : 6000);
  }).catch(() => toast('That file is not a marble run.'));
});
$('#clearBtn').addEventListener('click', () => {
  if (!MODEL.pieces.length) return;
  stop(); stashUserRun(); clearBoard(); select(null); closeDialog(menuDlg); homeView();
  toast('Board cleared.', 'Undo', () => undo(), 6000);
});
// The autosave could not be written (full or blocked storage): say so once
function onAutosaveFailed(err) {
  toast('Couldn\'t autosave' + (err === 'quota' ? ' (storage is full)' : '') + '. Use Save & share > Export .json to keep your run.', null, null, 7000);
}
const muteBtn = $('#muteBtn');
muteBtn.addEventListener('click', () => { piano.init(); piano.setMuted(!piano.muted); muteBtn.textContent = piano.muted ? 'Sound off' : 'Sound on'; muteBtn.setAttribute('aria-pressed', String(piano.muted)); });
$('#twoDBtn').addEventListener('click', () => { closeDialog(menuDlg); fallbackTo2D(); });

/* ============================================================================
 *  FIRST-RUN COACH (remembered in localStorage 'marbleMusic.helpSeen')
 * ========================================================================== */
function openHelp() { openDialog(coach, '#coachGo'); }
function closeHelp() {
  store.set('marbleMusic.helpSeen', '1'); closeDialog(coach);
  towerHint();
  if (!reducedMotion) playBtn.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.14)' }, { transform: 'scale(1)' }], { duration: 520, delay: 250 });   // "now press Play"
}
$('#coachGo').addEventListener('click', () => { piano.init(); closeHelp(); });
coach.addEventListener('click', (e) => { if (e.target === coach) closeHelp(); });
helpBtn.addEventListener('click', () => openHelp());
// keep Tab inside an open dialog
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Tab') return;
  const d = [coach, demosDlg, menuDlg].find((x) => !x.hidden);
  if (!d) return;
  const f = [...d.querySelectorAll('button, input, select, textarea')].filter((x) => !x.disabled && !x.hidden && x.offsetParent !== null);
  if (!f.length) return;
  const i = f.indexOf(document.activeElement);
  if (e.shiftKey && i <= 0) { e.preventDefault(); f[f.length - 1].focus(); }
  else if (!e.shiftKey && i === f.length - 1) { e.preventDefault(); f[0].focus(); }
}, true);
