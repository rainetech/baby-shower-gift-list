
/* ============================================================================
 *  OVERLAY: screen-space guides drawn on the #fx canvas over either renderer
 *  - PATH PREVIEW: each dropper's marble run ahead with CANON: a thin line,
 *    a ring on every BEAT of the layout's beat grid (its tempo from Play, or a
 *    song's own timing, accelerando included; bar lines filled), the note it
 *    plays where it hits a piece (the label beside the hit, clear of the marble)
 *    and how the run ends (a pail tick, a red stop ring, or an arrow down).
 *    A beat ring is solid where a piece can take the note (the marble is in free
 *    flight) and a grey hollow ring where it cannot (it rolls on a piece there).
 *    Drop a bar on a solid ring and it rings exactly on the beat (it snaps there).
 *    Everything fades while marbles roll; playing, each marble shows only the
 *    next half second of its path. On a tower the paths run the whole way down
 *    (previewSeconds); only the marks in view are drawn and labelled.
 *  - the selected piece's outline and handles (rotate knob, size handles),
 *    the hovered piece, the piece being placed (with its predicted timing),
 *    note names floating up from pieces as they play, bucket counts.
 *  VIEW maps board <-> screen for whichever renderer is active.
 * ========================================================================== */
const VIEW = {
  b2s: (x, y, z = ZM) => { const p = project(x, y, z); return [p[0], p[1]]; },   // board -> CSS px
  b2sTo: (x, y, out) => { const p = project(x, y, ZM); out[0] = p[0]; out[1] = p[1]; return out; },   // (no garbage)
  s2b: (px, py) => unproject(px, py, ZM),                                         // CSS px -> board
  ppu: () => pxPerUnit(),
};
const FLOATS = [];                                  // note names rising from pieces that just played
function onNoteVisual(e) {
  if (FLOATS.length > 40) FLOATS.shift();
  FLOATS.push({ id: e.pieceId, note: e.note, t0: performance.now() / 1000 });   // (real time, not frame time)
}
const OVL = { sig: '', forceT: 0, stats: { maxAhead: 0, samples: 0 }, ends: [], hint: null, lblKey: '', frame: 0, predFrame: -9, stale: false };
const UI_FONT = '"Nunito", "Varela Round", "Segoe UI", system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif';
const SP = [0, 0];                                   // scratch screen point
const FONTS = new Map();                             // 'weight size' -> CSS font (built once each; sizes in half pixels)
function uiFont(weight, px) {
  px = Math.round(px * 2) / 2;
  const k = weight * 1000 + px;
  let f = FONTS.get(k);
  if (!f) { f = weight + ' ' + px + 'px ' + UI_FONT; FONTS.set(k, f); }
  return f;
}

function overlaySignature() {
  return [MODEL.version, VIEWCAM.version, view.w, view.h, view.dpr, EDIT.selected, EDIT.hover, EDIT.handle, EDIT.placing, EDIT.pulse > 0,
    SIM.session, SIM.playing, UI.showPath, EDIT.ghost ? EDIT.ghost.x + ',' + EDIT.ghost.y + ',' + EDIT.ghost.rot : '', EDIT.tapHint, EDIT.snap ? EDIT.snap.x : ''].join('|');
}
function drawOverlay(t) {
  const c = FXC.canvas, g = FXC.g;
  if (!g) return;
  const W = Math.round(view.w * view.dpr), H = Math.round(view.h * view.dpr);
  if (c.width !== W || c.height !== H) { c.width = W; c.height = H; OVL.sig = ''; }
  const anim = FLOATS.length > 0 || SIM.session || SIM.bucketCount.size > 0 || (EDIT.placing && !reducedMotion) || t < OVL.forceT || OVL.stale;
  const sig = overlaySignature();
  if (!anim && sig === OVL.sig) return;
  OVL.sig = sig; OVL.frame++;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, W, H);
  g.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
  const ppu = VIEW.ppu();
  drawHalos(g, ppu);
  if (UI.showPath) drawPaths(g, t, ppu);
  drawBucketCounts(g, ppu);
  drawEditMarks(g, t, ppu);
  drawFloats(g, t, ppu);
  if (!MODEL.pieces.length && !EDIT.ghost) drawEmptyHint(g, t, ppu);
}

/* ---- Beat points and the colliders a marble could be touching ---- */
const DROP_COLORS = ['#ffffff', '#ffe27a', '#9fe3ff', '#ffb3d9', '#b8f5a8', '#ffc58a'];
// When a dropper's first marble leaves, in seconds after Play: the physics step its release falls due in
// (0 for droppers that drop on Play)
function firstRelease(d) {
  const s = d && d.schedule;
  if (!s || s.mode !== 'times' || !s.times.length) return 0;
  let m = Infinity;
  for (const t of s.times) if (t < m) m = t;
  return Math.ceil((m - 1e-9) / H_STEP) * H_STEP;
}
const COLL = { key: '', list: [] };
function layoutColliders(pieces, key) {
  if (COLL.key !== key) { COLL.key = key; COLL.list = []; for (const p of pieces) for (const c of CANON.colliders(p)) COLL.list.push(c); }
  return COLL.list;
}
// How far a marble centre at (x, y) is from touching any collider (< 0: touching or rolling on it)
function clearance(x, y, list) {
  let best = Infinity;
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    let d;
    if (c.shape === 'circle') { const dx = x - c.x, dy = y - c.y; d = Math.sqrt(dx * dx + dy * dy) - c.r; }
    else {
      let u = ((x - c.ax) * c.abx + (y - c.ay) * c.aby) / c.len2;
      u = u < 0 ? 0 : u > 1 ? 1 : u;
      const dx = x - c.ax - c.abx * u, dy = y - c.ay - c.aby * u;
      d = Math.sqrt(dx * dx + dy * dy) - c.hw;
    }
    if (d < best) best = d;
  }
  return best - CANON.MARBLE_R;
}
// The beat points of a dropper's predicted path: where its marble is on every pulse of the beat grid (song time,
// counted from its first release), how it moves there, whether a piece placed there can take the note (landable:
// the marble is in free flight, not rolling on or touching a piece) and which pulses are bar lines.
// Cached on the path object (a path that did not change keeps its beats).
const BEATS = [];
function pathBeats(d, pr, colliders, clk, clkKey) {
  if (pr.beatsKey === clkKey && pr.beats) return pr.beats;
  const P = pr.path, out = [];
  if (typeof colliders === 'function') colliders = colliders();
  if (P.length >= 2) {
    const rel = firstRelease(d), tEnd = P[P.length - 1][2];
    let k = 1;
    for (const [bn, tb] of clk.beats(rel + 1e-6, rel + tEnd, BEATS)) {
      const tp = tb - rel;
      while (k < P.length - 1 && P[k][2] < tp) k++;
      const a = P[k - 1], b = P[k], dt = (b[2] - a[2]) || 1, f = clamp((tp - a[2]) / dt, 0, 1);
      const x = a[0] + (b[0] - a[0]) * f, y = a[1] + (b[1] - a[1]) * f;
      out.push({ bn, t: tb, tp, x, y, vx: (b[0] - a[0]) / dt, vy: (b[1] - a[1]) / dt, bar: clk.isBar(bn), landable: clearance(x, y, colliders) > 2 });
    }
  }
  pr.beats = out; pr.beatsKey = clkKey;
  return out;
}

/* ---- Path preview ---- */
const LABEL_BOXES = [];
// The pieces the preview runs (with the piece being dragged in) and its cache key
const previewPieces = () => (EDIT.ghost ? MODEL.pieces.concat([EDIT.ghost]) : MODEL.pieces);
const previewKey = () => MODEL.version + '|' + (EDIT.ghost ? JSON.stringify(EDIT.ghost) : '') + '|' + MODEL.tempo;
// The preview the overlay shows. During a live change (a slider, a size or turn handle, the wheel) the paths are run
// again on every third frame at most (each run is a whole CANON prediction, and garbage on a phone): they trail the
// piece by up to two frames and catch up as soon as it stops. A piece moved by the pointer is always current: its
// move handler works out the preview for the timing label.
function overlayPaths(pieces, key) {
  OVL.stale = PREVIEW.cut;                               // (a path cut short in a live edit: drawn again until whole)
  if (previewCurrent(key)) return PREVIEW.paths;
  if ((HISTORY.pending || EDIT.ghost) && PREVIEW.paths.size && OVL.frame - OVL.predFrame < 3) { OVL.stale = true; return PREVIEW.paths; }
  OVL.predFrame = OVL.frame;
  const paths = previewPaths(pieces, key);
  OVL.stale = OVL.stale || PREVIEW.cut;
  return paths;
}
// While a run plays and the view is zoomed far in (past 4 x the home zoom), the 2D path preview, beat rings, labels
// and look-ahead are painted over the pieces nearer the eye than the marble plane (they have no depth) and undo the
// solidity of what is in front of them: they fade out between 4 x and 6 x the home zoom. Building (no session) keeps
// them at full strength.
function pathFade() {
  if (!SIM.session || !glOk) return 1;
  return 1 - clamp((VIEWCAM.zoom / Math.max(1, homeZoom()) - 4) / 2, 0, 1);
}
function drawPaths(g, t, ppu) {
  const fade = pathFade();
  if (fade <= 0.01) return;
  const pieces = previewPieces(), key = previewKey();
  const paths = overlayPaths(pieces, key);
  OVL.ends.length = 0;
  OVL.stats.maxAhead = 0; OVL.stats.samples = 0;
  // Note labels are placed only when the paths or the view change (a redraw for a hover reuses them). A path that
  // did not change keeps its labels, and the new paths' labels are placed around them (so labels do not jump about
  // while something elsewhere is dragged).
  const viewKey = VIEWCAM.version + '|' + view.w + 'x' + view.h, lblKey = PREVIEW.gen + '|' + viewKey;
  const relabel = lblKey !== OVL.lblKey;
  if (relabel) {
    OVL.lblKey = lblKey; LABEL_BOXES.length = 0;
    paths.forEach((pr) => { if (pr.lblView === viewKey && pr.labels) for (let i = 0; i < pr.labels.length; i++) LABEL_BOXES.push(pr.labels[i]); });
  }
  if (!paths.size) return;
  const clk = layoutBeatClock(), clkKey = BEAT_CLOCK.key;
  const moving = SIM.session && drawnMarbles().length > 0;
  const playing = SIM.playing, alpha = (moving ? 0.3 : 1) * fade;
  const colliders = () => layoutColliders(pieces, key);  // (built only if a path's beats need working out again)
  const md = 2 * CANON.MARBLE_R * ppu;                     // a marble's diameter on screen
  const sel = EDIT.selected;
  const tiny = ppu < 0.3;                                   // (a board this small shows only the selected dropper's marks)
  g.save();
  g.lineJoin = 'round'; g.lineCap = 'round';
  if (playing) { drawLookAhead(g, paths, pieces, fade); g.restore(); return; }
  const clean = !EDIT.drag && !EDIT.ghost ? snapBase(null).clean : null;        // (where a bar can take the note cleanly)
  let di = 0;
  for (const [id, pr] of paths) {
    const col = DROP_COLORS[di++ % DROP_COLORS.length], P = pr.path;
    if (P.length < 2) continue;
    const S = screenPath(pr);
    // the path: a thin line
    g.globalAlpha = alpha * 0.6;
    g.strokeStyle = 'rgba(20, 14, 8, 0.5)'; g.lineWidth = 3;
    strokePath(g, S, 0, P.length);
    g.strokeStyle = col; g.lineWidth = 1.5;
    strokePath(g, S, 0, P.length);
    OVL.stats.samples += P.length;
    if (tiny && sel !== id) continue;
    g.globalAlpha = alpha;
    // beat rings where the marble is on each beat (bar lines filled; hollow grey where it rolls on a piece)
    const d = pieces.find((p) => p.id === id), beats = pathBeats(d, pr, colliders, clk, clkKey);
    const r0 = Math.min(0.24 * md, 3.8), r1 = Math.min(0.3 * md, 4.6), nums = ppu >= 0.6;   // (never over 0.6 of a marble across)
    g.font = uiFont(800, clamp(8 * ppu + 3, 8, 11)); g.textAlign = 'center'; g.textBaseline = 'middle';
    for (const b of beats) {
      VIEW.b2sTo(b.x, b.y, SP);
      const r = b.bar ? r1 : r0;
      if (r < 0.8 || SP[1] < -20 || SP[1] > view.h + 20 || SP[0] < -20 || SP[0] > view.w + 20) continue;
      g.beginPath(); g.arc(SP[0], SP[1], r, 0, Math.PI * 2);
      if (!b.landable || (clean && clean.get(id + '|' + b.tp) === false)) { g.strokeStyle = 'rgba(190, 190, 190, 0.75)'; g.lineWidth = 1; g.stroke(); continue; }
      if (b.bar) { g.fillStyle = col; g.fill(); g.strokeStyle = 'rgba(20, 14, 8, 0.6)'; g.lineWidth = 1; g.stroke(); }
      else { g.strokeStyle = 'rgba(20, 14, 8, 0.55)'; g.lineWidth = 2.6; g.stroke(); g.strokeStyle = col; g.lineWidth = 1.4; g.stroke(); }
      if (nums) {
        const bpb = clk.beatsPerBar || 4, n = ((Math.round(b.bn) % Math.max(1, Math.round(bpb))) + Math.round(bpb)) % Math.max(1, Math.round(bpb)) + 1;
        g.fillStyle = 'rgba(255,255,255,0.85)'; g.fillText(String(n), SP[0] + r + 5, SP[1] - r - 3);
      }
    }
    // note labels beside each hit (one marble diameter off the contact point, away from the path; never piled up)
    if (relabel && pr.lblView !== viewKey) { placeHitLabels(g, pr, S, ppu, md); pr.lblView = viewKey; }
    drawHitLabels(g, pr, ppu, md);
    // where it ends: into a pail (tick), stopped on a piece (red ring with a cross), or off the board (arrow down)
    if (pr.end) drawEnd(g, pr.end, id);
  }
  g.restore();
}
// A path's screen points, cached per view (Float32Array x, y pairs)
function screenPath(pr) {
  const key = VIEWCAM.version + '|' + view.w + 'x' + view.h;
  if (pr.scrKey === key) return pr.scr;
  const P = pr.path, S = pr.scr && pr.scr.length === P.length * 2 ? pr.scr : new Float32Array(P.length * 2);
  for (let i = 0; i < P.length; i++) { VIEW.b2sTo(P[i][0], P[i][1], SP); S[i * 2] = SP[0]; S[i * 2 + 1] = SP[1]; }
  pr.scr = S; pr.scrKey = key;
  return S;
}
// (a point behind the camera, OFFSCREEN from project(), breaks the line: the path goes on from the next one in view)
function strokePath(g, S, i0, i1) {
  g.beginPath();
  let lx = NaN, ly = NaN, pen = false;
  for (let i = i0; i < i1; i++) {
    const x = S[i * 2], y = S[i * 2 + 1];
    if (x < -1e5) { pen = false; continue; }
    if (!pen) { g.moveTo(x, y); lx = x; ly = y; pen = true; continue; }
    const dx = x - lx, dy = y - ly;
    if (dx * dx + dy * dy < 2.25 && i < i1 - 1) continue;   // (points under 1.5 px apart add nothing to the line)
    g.lineTo(x, y); lx = x; ly = y;
  }
  g.stroke();
}
// Playing: each rolling marble shows the next half second of its dropper's path (a marble follows its dropper's
// predicted path while nothing else touches it; path time = display time - its release)
const LOOK = { key: null, colOf: new Map() };             // each dropper's colour, per preview
function drawLookAhead(g, paths, pieces, fade = 1) {
  const list = drawnMarbles(), dt = 1 / 60;
  g.globalAlpha = 0.3 * fade; g.lineWidth = 2;              // (faint: the marbles in flight are what to watch)
  if (LOOK.key !== paths) {
    LOOK.key = paths; LOOK.colOf.clear();
    let di = 0;
    paths.forEach((pr, id) => LOOK.colOf.set(id, DROP_COLORS[di++ % DROP_COLORS.length]));
  }
  const colOf = LOOK.colOf;
  for (let li = 0; li < list.length; li++) {
    const m = list[li];
    const pr = paths.get(m.dropperId);
    if (!pr || pr.path.length < 2 || m.removedAt != null) continue;
    const tau = SIM.dispT - m.bornT;
    if (tau < 0) continue;
    const P = pr.path, i0 = Math.max(0, Math.floor(tau / dt)), i1 = Math.min(P.length, Math.floor((tau + 0.5) / dt) + 1);
    if (i1 - i0 < 2) continue;
    const S = screenPath(pr);
    g.strokeStyle = colOf.get(m.dropperId) || '#fff';
    strokePath(g, S, i0, i1);
    OVL.stats.samples += i1 - i0;
    OVL.stats.maxAhead = Math.max(OVL.stats.maxAhead, P[i1 - 1][2] - tau);
  }
}
// Label placement: 8 spots around the hit, one marble diameter out; the first whose box clears the marble, the
// other labels and the path nearby wins. Kept on the path object as [x0, y0, x1, y1, text, colour] per hit.
const LABEL_DIRS = [[0.7, -0.7], [-0.7, -0.7], [1, 0], [-1, 0], [0.7, 0.7], [-0.7, 0.7], [0, -1], [0, 1]];
const LABEL_W = new Map();                                 // text width per font size and text
function labelWidth(g, fs, txt) {
  const k = fs + txt;
  let w = LABEL_W.get(k);
  if (w == null) { w = g.measureText(txt).width; LABEL_W.set(k, w); }
  return w;
}
// (plain loops and squared distances: this runs for every hit on every path each time the preview changes)
function placeHitLabels(g, pr, S, ppu, md) {
  const P = pr.path, hits = pr.hits, out = pr.labels || (pr.labels = []);
  out.length = 0;
  if (ppu < 0.42) return;                                  // (a small board shows coloured dots instead)
  const fs = Math.round(clamp(ppu * 16, 9, 14) * 2) / 2, th = fs + 5, gap = Math.max(14, md);   // (the box keeps this far from the hit)
  g.font = uiFont(800, fs);
  let k = 0;
  for (let hi = 0; hi < hits.length; hi++) {
    const h = hits[hi];
    VIEW.b2sTo(h.x, h.y, SP);
    const hx = SP[0], hy = SP[1];
    if (hx < -60 || hy < -60 || hx > view.w + 60 || hy > view.h + 60) continue;   // (off screen: a tower's other storeys)
    while (k < P.length - 1 && P[k][2] < h.t) k++;
    const txt = noteLabel(h.note), tw = labelWidth(g, fs, txt) + 9, hw = tw / 2, hh = th / 2;
    let bx = 0, by = 0, bestScore = -Infinity;
    for (let di = 0; di < LABEL_DIRS.length; di++) {
      const dx = LABEL_DIRS[di][0], dy = LABEL_DIRS[di][1];
      // the nearest distance (on a 2 px step from gap) at which the box, centred along (dx, dy), clears the hit by gap
      const s0 = labelReach(Math.abs(dx), Math.abs(dy), hw, hh, gap);
      if (s0 >= gap + tw + th) continue;
      const cx = hx + dx * s0, cy = hy + dy * s0;
      const x0 = cx - hw, y0 = cy - hh, x1 = cx + hw, y1 = cy + hh;
      let hit = false;
      for (let bi = 0; bi < LABEL_BOXES.length; bi++) { const b = LABEL_BOXES[bi]; if (x0 < b[2] && x1 > b[0] && y0 < b[3] && y1 > b[1]) { hit = true; break; } }
      if (hit) continue;
      // keep clear of the path around the hit (0.25 s either side)
      let near2 = Infinity;
      for (let i = Math.max(0, k - 15), e = Math.min(P.length, k + 15); i < e; i++) {
        const sx = S[i * 2], sy = S[i * 2 + 1];
        const ex = sx < x0 ? x0 - sx : sx > x1 ? sx - x1 : 0, ey = sy < y0 ? y0 - sy : sy > y1 ? sy - y1 : 0;
        const d2 = ex * ex + ey * ey;
        if (d2 < near2) near2 = d2;
      }
      const score = Math.min(Math.sqrt(near2), 30) - s0 * 0.05;
      if (score > bestScore) { bestScore = score; bx = x0; by = y0; }
    }
    if (bestScore === -Infinity) continue;
    const box = [bx, by, bx + tw, by + th, txt, noteHex(h.note)];
    LABEL_BOXES.push(box); out.push(box);
  }
}
// The smallest s = gap + 2n where a box of half size (hw, hh), centred s along a direction (a, b >= 0), keeps gap
// between its edge and the centre: |(max(0, a s - hw), max(0, b s - hh))| >= gap
function reachOk(a, b, hw, hh, gap, s) { const ex = Math.max(0, a * s - hw), ey = Math.max(0, b * s - hh); return ex * ex + ey * ey >= gap * gap; }
function labelReach(a, b, hw, hh, gap) {
  let s = Infinity;
  if (a > 0) { const t = (gap + hw) / a; if (b * t <= hh) s = Math.min(s, t); }
  if (b > 0) { const t = (gap + hh) / b; if (a * t <= hw) s = Math.min(s, t); }
  const A = a * a + b * b, B = a * hw + b * hh, C = hw * hw + hh * hh - gap * gap, D = B * B - A * C;
  if (D >= 0) { const t = (B + Math.sqrt(D)) / A; if (a * t >= hw && b * t >= hh) s = Math.min(s, t); }
  if (!(s < Infinity)) return Infinity;
  let s0 = s <= gap ? gap : gap + 2 * Math.ceil((s - gap) / 2 - 1e-9);
  while (s0 > gap && reachOk(a, b, hw, hh, gap, s0 - 2)) s0 -= 2;   // (guard the rounding either way)
  while (!reachOk(a, b, hw, hh, gap, s0)) s0 += 2;
  return s0;
}
// Draw a path's labels as placed (on a small board: a coloured dot beside each hit)
function drawHitLabels(g, pr, ppu, md) {
  if (ppu < 0.42) {
    const r = clamp(0.3 * md, 1.2, 3.2), off = md / 2 + r + 2;
    for (const h of pr.hits) {
      VIEW.b2sTo(h.x, h.y, SP);
      g.beginPath(); g.arc(SP[0] + off * 0.7, SP[1] - off * 0.7, r, 0, Math.PI * 2);
      g.fillStyle = noteHex(h.note); g.fill(); g.strokeStyle = 'rgba(255,255,255,0.9)'; g.lineWidth = 1; g.stroke();
    }
    return;
  }
  if (!pr.labels || !pr.labels.length) return;
  const fs = Math.round(clamp(ppu * 16, 9, 14) * 2) / 2, th = fs + 5;
  g.font = uiFont(800, fs);
  g.textAlign = 'center'; g.textBaseline = 'middle';
  for (const b of pr.labels) {
    g.fillStyle = b[5];
    roundRectPath(g, b[0], b[1], b[2] - b[0], th, th / 2); g.fill();
    g.strokeStyle = 'rgba(255,255,255,0.9)'; g.lineWidth = 1.2; g.stroke();
    g.fillStyle = '#fff'; g.fillText(b[4], (b[0] + b[2]) / 2, b[1] + th / 2 + 0.5);
  }
}
function drawEnd(g, end, id) {
  VIEW.b2sTo(end.x, end.y, SP);
  const x = SP[0], y = SP[1];
  OVL.ends.push({ dropperId: id, why: end.why, x, y, bx: end.x, by: end.y });
  g.lineWidth = 3; g.lineCap = 'round';
  if (end.why === 'bucket') {
    g.strokeStyle = '#3ddc84';
    g.beginPath(); g.moveTo(x - 6, y); g.lineTo(x - 1, y + 5); g.lineTo(x + 7, y - 5); g.stroke();
  } else if (end.why === 'stuck') {
    g.beginPath(); g.arc(x, y, 9, 0, Math.PI * 2); g.fillStyle = 'rgba(255,255,255,0.85)'; g.fill();
    g.strokeStyle = '#e0493b'; g.lineWidth = 2.5; g.stroke();
    g.beginPath(); g.moveTo(x - 4, y - 4); g.lineTo(x + 4, y + 4); g.moveTo(x + 4, y - 4); g.lineTo(x - 4, y + 4); g.stroke();
  } else {
    g.strokeStyle = 'rgba(255,255,255,0.7)'; g.lineWidth = 2;
    g.beginPath(); g.moveTo(x, y - 6); g.lineTo(x, y + 5); g.moveTo(x - 4, y + 1); g.lineTo(x, y + 5); g.lineTo(x + 4, y + 1); g.stroke();
  }
}
// Phones, a demo playing, and any run on a tower: a soft halo round each marble in its voice's tint (melody bright,
// accompaniment darker), so the marbles can be followed at a small scale and down a tall board. It fades out as the
// view zooms in (full below a 28 px marble, gone at 44 px): at the follow zoom the glass, swirl and glint are what to
// look at, so the glow stays a faint ring (radius 1.6 R, peak alpha 0.4) that only helps the eye find the marble.
function drawHalos(g, ppu) {
  if (!SIM.session || !(tallBoard() || (SIM.playing && MODEL.demoId && phoneView()))) return;
  const md = 2 * CANON.MARBLE_R * ppu, fade = clamp((44 - md) / 16, 0, 1);
  if (fade <= 0) return;
  const b = MarbleDemos.cached(MODEL.demoId), dv = b && b.dropperVoice;
  const r = Math.max(8, CANON.MARBLE_R * ppu * 1.6);
  g.save();
  g.globalAlpha = fade;
  for (const m of drawnMarbles()) {
    const q = marbleDrawPos(m, DRAWPOS);
    if (!q) continue;
    VIEW.b2sTo(q[0], q[1], SP);
    const mel = !dv || !dv.get(m.dropperId);
    const gr = g.createRadialGradient(SP[0], SP[1], CANON.MARBLE_R * ppu * 0.9, SP[0], SP[1], r);
    gr.addColorStop(0, mel ? 'rgba(255, 244, 190, 0.4)' : 'rgba(120, 165, 255, 0.3)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr; g.beginPath(); g.arc(SP[0], SP[1], r, 0, Math.PI * 2); g.fill();
  }
  g.restore();
}
function roundRectPath(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y); g.lineTo(x + w - r, y); g.arcTo(x + w, y, x + w, y + r, r);
  g.lineTo(x + w, y + h - r); g.arcTo(x + w, y + h, x + w - r, y + h, r);
  g.lineTo(x + r, y + h); g.arcTo(x, y + h, x, y + h - r, r);
  g.lineTo(x, y + r); g.arcTo(x, y, x + r, y, r);
  g.closePath();
}

/* ---- Piece outlines (in board units -> screen) ---- */
// Trace a piece's outline: its colliders grown by `pad` board units (dropper and bucket get their body box)
function tracePiece(g, p, pad) {
  g.beginPath();
  if (p.type === 'dropper') {
    const pts = [[-22, -100], [22, -100], [15, -2], [-15, -2]];
    pts.forEach(([lx, ly], i) => { VIEW.b2sTo(p.x + lx, p.y + ly, SP); if (i) g.lineTo(SP[0], SP[1]); else g.moveTo(SP[0], SP[1]); });
    g.closePath();
    return;
  }
  for (const c of CANON.colliders(p)) {
    if (c.shape === 'circle') {                       // (its outline projected point by point: an ellipse from an angle)
      const r = c.r + pad;
      for (let i = 0; i <= 24; i++) {
        const a = (i / 24) * Math.PI * 2;
        VIEW.b2sTo(c.x + Math.cos(a) * r, c.y + Math.sin(a) * r, SP);
        if (i) g.lineTo(SP[0], SP[1]); else g.moveTo(SP[0], SP[1]);
      }
      g.closePath();
      continue;
    }
    const L = Math.sqrt(c.len2), ux = c.abx / L, uy = c.aby / L, nx = -uy, ny = ux, R = c.hw + pad;
    for (let i = 0; i <= 17; i++) {
      const end = i <= 8, a = (end ? Math.PI / 2 : -Math.PI / 2) + ((end ? i : i - 9) / 8) * Math.PI, ox = end ? c.ax : c.bx, oy = end ? c.ay : c.by;
      VIEW.b2sTo(ox + (ux * Math.cos(a) + nx * Math.sin(a)) * R, oy + (uy * Math.cos(a) + ny * Math.sin(a)) * R, SP);
      if (i) g.lineTo(SP[0], SP[1]); else g.moveTo(SP[0], SP[1]);
    }
    g.closePath();
  }
}

/* ---- Selection, hover, handles and the piece being placed ---- */
function drawEditMarks(g, t, ppu) {
  g.save();
  g.lineJoin = 'round';
  const hov = EDIT.hover && EDIT.hover !== EDIT.selected ? pieceById(EDIT.hover) : null;
  if (hov && !EDIT.drag) {
    tracePiece(g, hov, 5);
    g.strokeStyle = 'rgba(255, 255, 255, 0.7)'; g.lineWidth = 2; g.setLineDash([5, 4]); g.stroke(); g.setLineDash([]);
  }
  const sel = EDIT.selected ? pieceById(EDIT.selected) : null;
  if (sel) {
    tracePiece(g, sel, 6);
    g.strokeStyle = 'rgba(20, 14, 8, 0.55)'; g.lineWidth = 5; g.stroke();
    g.strokeStyle = '#ffd54a'; g.lineWidth = 2.5; g.stroke();
    if (!EDIT.drag || EDIT.handle) for (const h of handlesOf(sel)) drawHandle(g, h, EDIT.handle === h.kind);
    drawStuckHint(g, sel, ppu);
  }
  const gh = EDIT.ghost;
  if (gh) {
    tracePiece(g, gh, 6);
    const ok = EDIT.ghostOnBoard;
    g.fillStyle = ok ? 'rgba(255, 213, 74, 0.12)' : 'rgba(230, 70, 60, 0.12)'; g.fill();
    g.strokeStyle = ok ? '#ffd54a' : '#ff7a6b'; g.lineWidth = 2.5; g.setLineDash([7, 5]); g.stroke(); g.setLineDash([]);
    VIEW.b2sTo(gh.x, gh.y, SP);
    const sx = SP[0], sy = SP[1];
    g.strokeStyle = 'rgba(255,255,255,0.85)'; g.lineWidth = 1.5;
    g.beginPath(); g.moveTo(sx - 7, sy); g.lineTo(sx + 7, sy); g.moveTo(sx, sy - 7); g.lineTo(sx, sy + 7); g.stroke();
    if (!ok) { g.font = uiFont(800, 13); g.textAlign = 'center'; g.fillStyle = '#fff'; g.fillText('drop here to remove', sx, sy - 30); }
  }
  drawSnapMarks(g, ppu);
  g.restore();
}
// While a note piece is dragged: the beat it snapped to (a ring on the dot) and how its note will land on the beat
function drawSnapMarks(g, ppu) {
  const s = EDIT.snap;
  if (s && s.beat) {
    VIEW.b2sTo(s.beat.x, s.beat.y, SP);
    g.beginPath(); g.arc(SP[0], SP[1], Math.max(7, CANON.MARBLE_R * ppu * 1.2), 0, Math.PI * 2);
    g.strokeStyle = '#ffd54a'; g.lineWidth = 2.5; g.stroke();
  }
  const T = EDIT.timing;
  if (!T || !EDIT.drag) return;
  const p = EDIT.ghost || (EDIT.lifted && pieceById(EDIT.lifted));
  if (!p) return;
  VIEW.b2sTo(p.x, p.y, SP);
  const txt = T.text, fs = 13;
  g.font = uiFont(900, fs); g.textAlign = 'center'; g.textBaseline = 'middle';
  const tw = g.measureText(txt).width + 14, th = fs + 9, x = SP[0], y = SP[1] + Math.max(24, (p.len || 60) * ppu * 0.25 + 22);
  g.fillStyle = T.on ? 'rgba(31, 138, 73, 0.95)' : 'rgba(176, 110, 12, 0.95)';
  roundRectPath(g, x - tw / 2, y - th / 2, tw, th, th / 2); g.fill();
  g.fillStyle = '#fff'; g.fillText(txt, x, y + 0.5);
}
// The run stops on the selected piece: say how to fix it, next to it (until the run no longer stops there)
function drawStuckHint(g, sel, ppu) {
  OVL.hint = null;
  if (EDIT.drag || SIM.playing || !UI.showPath) return;
  const end = OVL.ends.find((e) => e.why === 'stuck' && pieceAt(e.bx, e.by, 16) === sel);
  if (!end) return;
  const txt = 'The marble stops here. Turn it with the yellow knob.';
  OVL.hint = { pieceId: sel.id, text: txt };
  g.font = uiFont(800, 13); g.textAlign = 'left'; g.textBaseline = 'middle';
  const tw = g.measureText(txt).width + 16, th = 26;
  let x = end.x + 16, y = end.y + 22;
  if (x + tw > view.w - 8) x = end.x - 16 - tw;
  g.fillStyle = 'rgba(35, 26, 18, 0.9)'; roundRectPath(g, x, y - th / 2, tw, th, 8); g.fill();
  g.fillStyle = '#fff'; g.fillText(txt, x + 8, y + 0.5);
  if (UI.stuckSaid !== sel.id) { UI.stuckSaid = sel.id; say(txt); }
}
// Handles of a piece (screen positions): rotate knob for everything but droppers; size handles per type
function handlesOf(p) {
  const out = [], ppu = VIEW.ppu();
  const c = VIEW.b2s(p.x, p.y), a = (p.rot || 0) * RAD, ca = Math.cos(a), sa = Math.sin(a);
  const loc = (lx, ly) => VIEW.b2s(p.x + lx * ca - ly * sa, p.y + lx * sa + ly * ca);
  const up = VIEW.b2s(p.x + sa * 10, p.y - ca * 10);
  let nx = up[0] - c[0], ny = up[1] - c[1];
  const nl = Math.hypot(nx, ny) || 1; nx /= nl; ny /= nl;
  const reach = { bar: 5, rail: 4, spring: 5, wall: 5, bell: p.r || 16, curve: 0, funnel: (p.h || 70) / 2, bucket: 30, dropper: 0 }[p.type] || 0;
  const size = (p.len || p.w || (p.r || 20) * 2) * ppu, small = size < (touchUI ? 56 : 30);   // tiny on screen: turn knob only
  if (p.type !== 'dropper') {
    let base = c;
    if (p.type === 'curve') base = VIEW.b2s(p.x + Math.cos(a + (p.sweep * RAD) / 2) * p.r, p.y + Math.sin(a + (p.sweep * RAD) / 2) * p.r);
    const d = reach * ppu + (small ? 24 : 34);
    out.push({ kind: 'rot', x: base[0] + nx * d, y: base[1] + ny * d, from: base, small, size });
  }
  if (small) return out;
  if (p.len != null) { const e0 = loc(-p.len / 2, 0), e1 = loc(p.len / 2, 0); out.push({ kind: 'len0', x: e0[0], y: e0[1] }, { kind: 'len1', x: e1[0], y: e1[1] }); }
  if (p.type === 'bell') { const e = VIEW.b2s(p.x + p.r, p.y); out.push({ kind: 'r', x: e[0], y: e[1] }); }
  if (p.type === 'curve') {
    const m = VIEW.b2s(p.x + Math.cos(a + (p.sweep * RAD) / 2) * p.r, p.y + Math.sin(a + (p.sweep * RAD) / 2) * p.r);
    const e = VIEW.b2s(p.x + Math.cos(a + p.sweep * RAD) * p.r, p.y + Math.sin(a + p.sweep * RAD) * p.r);
    out.push({ kind: 'r', x: m[0], y: m[1] }, { kind: 'sweep', x: e[0], y: e[1] });
  }
  if (p.type === 'funnel') { const e = loc(p.w / 2, -p.h / 2), f = loc(0, p.h / 2 + 20); out.push({ kind: 'w', x: e[0], y: e[1] }, { kind: 'h', x: f[0], y: f[1] }); }
  return out;
}
function drawHandle(g, h, active) {
  if (h.kind === 'rot') {
    g.strokeStyle = 'rgba(255, 213, 74, 0.9)'; g.lineWidth = 2; g.setLineDash([3, 3]);
    g.beginPath(); g.moveTo(h.from[0], h.from[1]); g.lineTo(h.x, h.y); g.stroke(); g.setLineDash([]);
    g.beginPath(); g.arc(h.x, h.y, (active ? 11 : 9.5) * (h.small ? 0.75 : 1), 0, Math.PI * 2);
    g.fillStyle = '#ffd54a'; g.fill(); g.strokeStyle = 'rgba(20,14,8,0.7)'; g.lineWidth = 2; g.stroke();
    if (h.small) return;
    // a curved double arrow: "turn me"
    g.strokeStyle = '#2a1d12'; g.lineWidth = 1.8; g.lineCap = 'round';
    g.beginPath(); g.arc(h.x, h.y, 4.6, -2.6, 0.6); g.stroke();
    g.beginPath(); g.moveTo(h.x + 4.6 * Math.cos(0.6) + 2.4, h.y + 4.6 * Math.sin(0.6) - 1.4); g.lineTo(h.x + 4.6 * Math.cos(0.6), h.y + 4.6 * Math.sin(0.6)); g.lineTo(h.x + 4.6 * Math.cos(0.6) - 0.6, h.y + 4.6 * Math.sin(0.6) - 3); g.stroke();
    return;
  }
  g.beginPath(); g.arc(h.x, h.y, active ? 8.5 : 7, 0, Math.PI * 2);
  g.fillStyle = '#fff'; g.fill(); g.strokeStyle = '#e0a800'; g.lineWidth = 3; g.stroke();
}

/* ---- Note names floating up from pieces that play; bucket counts; the empty-board hint ---- */
// (from the top of the piece plus one marble diameter, so the name never covers the note being struck)
function pieceTop(p) {
  if (p.type === 'dropper') return p.y - 100;
  let top = p.y;
  for (const c of CANON.colliders(p)) top = Math.min(top, c.shape === 'circle' ? c.y - c.r : Math.min(c.ay, c.by) - c.hw);
  return top;
}
function drawFloats(g, t, ppu) {
  g.save();
  g.textAlign = 'center'; g.textBaseline = 'middle';
  const now = performance.now() / 1000;
  for (let i = FLOATS.length - 1; i >= 0; i--) {
    const f = FLOATS[i], k = (now - f.t0) / 0.95;
    if (k >= 1 || k < 0) { FLOATS.splice(i, 1); continue; }
    const p = pieceById(f.id);
    if (!p) continue;
    if (f.top == null) f.top = pieceTop(p);
    VIEW.b2sTo(p.x, f.top, SP);
    const y = SP[1] - 2 * CANON.MARBLE_R * ppu - 8 - k * 34, size = clamp(ppu * 17, 11, 16) * (1 + (1 - k) * 0.25);
    g.globalAlpha = k < 0.15 ? k / 0.15 : 1 - (k - 0.15) / 0.85;
    g.font = uiFont(900, size);
    g.lineWidth = 3.5; g.strokeStyle = 'rgba(20,14,8,0.7)';
    const txt = '♪ ' + noteLabel(f.note);
    g.strokeText(txt, SP[0], y);
    g.fillStyle = mixHex(noteHex(f.note), '#ffffff', 0.35); g.fillText(txt, SP[0], y);
  }
  g.restore();
}
function drawBucketCounts(g, ppu) {
  if (!SIM.bucketCount.size) return;
  g.save();
  g.textAlign = 'center'; g.textBaseline = 'middle';
  for (const [id, n] of SIM.bucketCount) {
    const p = pieceById(id);
    if (!p) continue;
    const s = VIEW.b2s(p.x, p.y + 6, ZM + 38), f = SIM.fx.get(id), sc = (1 + (f ? f.bump * 0.35 : 0)) * clamp(ppu * 1.4, 0.55, 1);
    const r = 12 * sc;
    g.beginPath(); g.arc(s[0], s[1], r, 0, Math.PI * 2);
    g.fillStyle = '#fff'; g.fill(); g.strokeStyle = '#6f7780'; g.lineWidth = 2.5 * sc; g.stroke();
    g.font = uiFont(900, Math.round(13 * sc)); g.fillStyle = '#2a1d12'; g.fillText(String(n), s[0], s[1] + 0.5);
  }
  g.restore();
}
function drawEmptyHint(g, t, ppu) {
  const c = tallBoard() ? viewCentre() : [BOARD_W / 2, BOARD_H / 2], s = VIEW.b2s(c[0], c[1]);   // (a tower: where you are on it)
  g.save();
  g.textAlign = 'center'; g.textBaseline = 'middle';
  const fs = clamp(ppu * 34, 15, 26);
  g.font = uiFont(800, fs);
  const l1 = touchUI ? 'Tap a piece below, then tap the board' : 'Drag pieces from the tray onto the board';
  const w = g.measureText(l1).width + fs * 1.6, h = fs * 2.2;
  g.fillStyle = 'rgba(20, 14, 8, 0.55)';
  roundRectPath(g, s[0] - w / 2, s[1] - h / 2, w, h, h / 2); g.fill();
  g.fillStyle = '#fff'; g.fillText(l1, s[0], s[1] + 1);
  g.restore();
}
