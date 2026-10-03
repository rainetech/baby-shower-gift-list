
/* ============================================================================
 *  RENDERING (WebGL2): the metal pieces as real 3D meshes
 *  Every piece is built once per shape (type, size, note) in PIECE-LOCAL space:
 *  x along the piece, 3D Y up (= -board y), z out of the pegboard. The renderer
 *  rotates and places it per draw. The visible metal matches CANON's colliders:
 *  every surface a marble touches lies on the collider outline in the marble
 *  plane (z = ZM), so marbles sit on the metal, not in the air or inside it.
 *  Materials: 'metal' (brushed; steel, anodised aluminium and brass by tint and
 *  roughness), 'letters' (the engraved note on a bar's face), 'misc' (chrome,
 *  rubber), each tinted per vertex. Note pieces carry their note's colour.
 * ========================================================================== */
const ZM = 14;                                   // 3D depth of the marble plane (units in front of the board face)
const srgb2lin = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
function lin(hex, k = 1) { const n = parseInt(hex.slice(1), 16); return [srgb2lin((n >> 16) / 255) * k, srgb2lin(((n >> 8) & 255) / 255) * k, srgb2lin((n & 255) / 255) * k]; }
// Surface finishes: [roughness multiplier, metalness] (the brushed texture's own roughness is ~0.26)
// Anodised aluminium and brass are true metals (their colour is the colour of their reflections), on the brushed grain
const FIN = { anod: [0.92, 1], steel: [1.25, 1], satin: [1.9, 1], chrome: [0.16, 1], brass: [0.78, 1], rubber: [3.5, 0], galv: [2.3, 1] };
const STEEL = [0.62, 0.63, 0.65], CHROME = [0.95, 0.95, 0.97], BRASS = lin('#e3c27a'), RUBBER = [0.035, 0.035, 0.04];
// anodised colour: the note's colour lifted 15% towards white (in sRGB, which keeps the hue the eye sees)
function anodCol(note) { return hexRgb(noteHex(note)).map((v) => srgb2lin(lerp(v / 255, 1, 0.15))); }

/* ---- Primitive builders (local 2D outlines are y-down, like the board) ---- */
// Rounded rectangle outline, centred on (0, 0): half sizes hx, hy, corner radius rc (clockwise on screen)
function roundRectPts(hx, hy, rc, seg = 4) {
  const pts = [], c = [[hx - rc, -hy + rc, -Math.PI / 2], [hx - rc, hy - rc, 0], [-hx + rc, hy - rc, Math.PI / 2], [-hx + rc, -hy + rc, Math.PI]];
  for (const [cx, cy, a0] of c) for (let i = 0; i <= seg; i++) { const a = a0 + (i / seg) * Math.PI / 2; pts.push([cx + Math.cos(a) * rc, cy + Math.sin(a) * rc]); }
  return pts;
}
// Offset a closed outline (clockwise on screen, y down) inwards by d, along each vertex's mitred normal
function insetPts(pts, d) {
  const n = pts.length, out = [];
  const en = (a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1; return [dy / l, -dx / l]; };
  for (let i = 0; i < n; i++) {
    const a = pts[(i - 1 + n) % n], b = pts[i], c = pts[(i + 1) % n];
    const n1 = en(a, b), n2 = en(b, c);
    let vx = n1[0] + n2[0], vy = n1[1] + n2[1];
    const l = Math.hypot(vx, vy) || 1; vx /= l; vy /= l;
    const k = d / Math.max(0.35, vx * n1[0] + vy * n1[1]);
    out.push([b[0] - vx * k, b[1] - vy * k]);
  }
  return out;
}
// Extrude a closed local outline between z0 and z1 with a chamfer `bev` on the front edge; front face as a fan
// uvFn(x, y) gives the brushed-metal uv (u along the grain)
function prism(mb, pts, z0, z1, bev, uvFn, { front = true, back = false } = {}) {
  const n = pts.length;
  let cx = 0, cy = 0;
  for (const p of pts) { cx += p[0] / n; cy += p[1] / n; }
  const inset = insetPts(pts, bev);
  const rings = [[pts, z0], [pts, z1 - bev], [inset, z1]];
  let per = 0;
  const perim = [0];
  for (let i = 0; i < n; i++) { per += Math.hypot(pts[(i + 1) % n][0] - pts[i][0], pts[(i + 1) % n][1] - pts[i][1]); perim.push(per); }
  surfaceGrid(mb, rings.length, n + 1, (i, j) => { const [P, z] = rings[i]; const q = P[j % n]; return P3(q[0], q[1], z); },
    (i, j) => [perim[j] / 64, rings[i][1] / 64],
    (i, j) => { const q = pts[j % n]; return [q[0] - cx, -(q[1] - cy), i === 2 ? 1.4 : 0]; });
  if (front) flatFan(mb, inset.map(([x, y]) => P3(x, y, z1)), [0, 0, 1], (p) => uvFn(p[0], -p[1]));
  if (back) flatFan(mb, pts.map(([x, y]) => P3(x, y, z0)), [0, 0, -1], (p) => uvFn(p[0], -p[1]));
}
// Cylinder along z at local (x, y): a standoff or peg, with a domed or flat front
function postZ(mb, x, y, r, z0, z1, dome = 0, segs = 14) {
  const rows = [[r, z0], [r, z1 - dome * 0.6]];
  if (dome) for (let k = 1; k <= 3; k++) { const a = (k / 3) * Math.PI / 2; rows.push([r * Math.cos(a) + 0.001, z1 - dome * 0.6 + Math.sin(a) * dome]); }
  surfaceGrid(mb, rows.length, segs + 1, (i, j) => { const a = (j / segs) * Math.PI * 2; return P3(x + Math.cos(a) * rows[i][0], y + Math.sin(a) * rows[i][0], rows[i][1]); },
    (i, j) => [j / segs, rows[i][1] / 32], (i, j, p) => [Math.cos((j / segs) * Math.PI * 2), -Math.sin((j / segs) * Math.PI * 2), i >= 2 ? (i - 1) / 3 : 0], { wrapJ: true });
  if (!dome) { const pts = []; for (let j = 0; j < segs; j++) { const a = (j / segs) * Math.PI * 2; pts.push(P3(x + Math.cos(a) * r, y + Math.sin(a) * r, z1)); } flatFan(mb, pts, [0, 0, 1], () => [0.5, 0.5]); }
}
// A rod (tube) along a local 3D path with hemispherical ends
function rod(mb, path, r, segs = 12, ends = true) {
  const n = path.length, full = [], rad = [];
  const d0 = V3.norm(V3.sub(path[0], path[1])), d1 = V3.norm(V3.sub(path[n - 1], path[n - 2]));
  if (ends) for (let k = 3; k >= 1; k--) { const a = (k / 4) * Math.PI / 2; full.push(V3.add(path[0], V3.scale(d0, Math.sin(a) * r))); rad.push(Math.cos(a) * r + 0.01); }
  for (const p of path) { full.push(p); rad.push(r); }
  if (ends) for (let k = 1; k <= 3; k++) { const a = (k / 4) * Math.PI / 2; full.push(V3.add(path[n - 1], V3.scale(d1, Math.sin(a) * r))); rad.push(Math.cos(a) * r + 0.01); }
  let s = 0;
  const arc = [0];
  for (let i = 1; i < full.length; i++) { s += V3.len(V3.sub(full[i], full[i - 1])); arc.push(s); }
  sweepTube(mb, full, (i) => rad[i], segs, (i, j) => [arc[i] / 48, j / segs], { up: [0, 0, 1] });
}
// Surface of revolution about the local y axis at z = az: rows [[y, r]], angles a0..a1 (0 = +x, pi/2 = +z)
function latheY(mb, rows, a0, a1, cols, inward, uvScale = 48, az = ZM) {
  surfaceGrid(mb, rows.length, cols, (i, j) => { const a = a0 + (a1 - a0) * j / (cols - 1), r = rows[i][1]; return [Math.cos(a) * r, -rows[i][0], az + Math.sin(a) * r]; },
    (i, j) => { const a = a0 + (a1 - a0) * j / (cols - 1); return [a * rows[i][1] / uvScale, rows[i][0] / uvScale]; },
    (i, j, p) => { const d = [p[0], 0, p[2] - az]; return inward ? V3.scale(d, -1) : d; });
}
// Surface of revolution about the z axis at local (0, 0): rows [[z, r]]
function latheZ(mb, rows, cols = 40) {
  surfaceGrid(mb, rows.length, cols + 1, (i, j) => { const a = (j / cols) * Math.PI * 2; return P3(Math.cos(a) * rows[i][1], Math.sin(a) * rows[i][1], rows[i][0]); },
    (i, j) => [(j / cols) * 3, rows[i][0] / 16], (i, j, p) => {
      const a = (j / cols) * Math.PI * 2, i0 = Math.max(0, i - 1), i1 = Math.min(rows.length - 1, i + 1);
      const dr = rows[i1][1] - rows[i0][1], dz = rows[i1][0] - rows[i0][0];
      return [Math.cos(a) * dz, -Math.sin(a) * dz, -dr];
    }, { wrapJ: true });
}
const put = (mb, col, fin, flag = 0) => { mb.setCol(col[0], col[1], col[2], 1); mb.setMat(fin[0], fin[1], 0, flag); return mb; };
// A rubber washer where a post meets the board (every bracket stands on one: the piece visibly touches the board)
function foot(M, x, y, r) {
  const rub = put(M('misc'), RUBBER, FIN.rubber);
  latheZ(rub, [[0.12, r + 0.7], [1.0, r + 0.5], [1.7, r - 0.4], [1.7, 0.01]], 16);
  translateLast(rub, x, y);
}
// A chrome pan-head screw on a surface at z, at local (x, y)
function screw(M, x, y, z, r = 1.9) {
  const s = put(M('metal'), CHROME, FIN.chrome);
  latheZ(s, [[z - 0.1, r], [z + 0.9, r * 0.95], [z + 1.5, r * 0.6], [z + 1.7, 0.01]], 14);
  translateLast(s, x, y);
}

// A rail bracket at local (x, y), turned by `ang` (radians, clockwise on screen): a tie in the note's colour that
// clamps the twin rods (half spacing dz; it reaches up between them), standing on the board on a satin steel foot
// plate with two chrome screws. Everything of it in the marble's reach lies inside the rail's collider outline.
function bracket(M, x, y, ang, note, dz) {
  const c = Math.cos(ang), s = Math.sin(ang), at = ([u, v]) => [x + c * u - s * v, y + s * u + c * v];
  prism(put(M('metal'), anodCol(note), FIN.anod), roundRectPts(1.8, 2.2, 0.8, 2).map(at), 1.4, ZM + dz + 1.5, 0.5, (u, v) => [u / 64, v / 64]);
  prism(put(M('metal'), STEEL, FIN.satin), roundRectPts(5.6, 3.3, 1.2, 3).map(at), 0.2, 1.6, 0.4, (u, v) => [u / 64, v / 64 + 0.3]);
  for (const u of [-3.7, 3.7]) { const q = at([u, 1.6]); screw(M, q[0], q[1], 1.6, 1.15); }
}

/* ---- The pieces ---- */
const PIECE_BUILD = {
  // Tuned glockenspiel bar: anodised aluminium in the note's colour, the note engraved on its face, resting on
  // two rubber grommets at its nodal points (where a real bar is held so it rings freely)
  bar(p, M) {
    const L = p.len, hx = L / 2 + CANON.HW.bar, hy = CANON.HW.bar, z0 = ZM - 10, z1 = ZM + 10;
    const col = anodCol(p.note), body = put(M('metal'), col, FIN.anod);
    const outline = roundRectPts(hx, hy, 2.2);
    prism(body, outline, z0, z1 - 0.01, 1.2, (x, y) => [x / 64, y / 64], { front: false });
    // front face: anodised, the note engraved in the middle (one material across, so it reads as one face)
    const lw = Math.min(16, hx * 2 - 6), lh = lw / 2, fz = z1, bh = hy - 1.2, bx = hx - 1.2;
    const lt = put(M('letters'), col, FIN.anod, 1);
    const blank = letterCellUV(null, 0.5, 0.5);
    const face = (xa, xb) => flatQuad(lt, P3(xa, -bh, fz), P3(xb, -bh, fz), P3(xb, bh, fz), P3(xa, bh, fz), [0, 0, 1], blank, blank, blank, blank);
    face(-bx, -lw / 2); face(lw / 2, bx);
    const uv = (u, v) => letterCellUV(p.note, u, v);
    const vA = 0.5 - bh / lh, vB = 0.5 + bh / lh;
    flatQuad(lt, P3(-lw / 2, -bh, fz), P3(lw / 2, -bh, fz), P3(lw / 2, bh, fz), P3(-lw / 2, bh, fz), [0, 0, 1], uv(0, vA), uv(1, vA), uv(1, vB), uv(0, vB));
    // nodal mounts: rubber grommet + chrome screw on top, a steel post to the board behind
    const nx = hx * 2 * (0.5 - 0.224);
    for (const x of [-nx, nx]) {
      const rub = put(M('misc'), RUBBER, FIN.rubber);
      latheY(rub, [[-hy - 1.3, 2.6], [-hy - 0.4, 3.4], [-hy + 0.2, 3.5]], 0, Math.PI * 2, 18, false, 16, ZM);
      translateLast(rub, x, 0);
      const scr = put(M('metal'), CHROME, FIN.chrome);
      latheY(scr, [[-hy - 2.2, 0.01], [-hy - 2.0, 1.2], [-hy - 1.4, 1.9], [-hy - 1.1, 2.0]], 0, Math.PI * 2, 16, false, 16, ZM);
      translateLast(scr, x, 0);
      postZ(put(M('metal'), STEEL, FIN.satin), x, 0, 2.6, 0, z0 + 0.5, 0);
    }
    // resonator: a satin steel plate on the board behind the bar with a dark slot (the bar's air column) cut into
    // it below the bar; the plate has thickness and the slot real depth, so the bar stands off the board
    const px = hx + 5, py = hy + 8, pz = 3.2, rp = put(M('metal'), [0.64, 0.65, 0.67], FIN.satin);
    prism(rp, roundRectPts(px, py, 1.2, 3), 0.3, pz, 0.7, (x, y) => [x / 64, y / 64 + 0.5], { front: false });
    const fx = px - 0.7, fy = py - 0.7, s0x = -hx + 4, s1x = hx - 4, s0y = hy + 1.2, s1y = hy + 5.4, fl = 0.8;
    const fq = (a, b, c, d, z = pz, n = [0, 0, 1]) => flatQuad(rp, P3(a[0], a[1], z), P3(b[0], b[1], z), P3(c[0], c[1], z), P3(d[0], d[1], z), n,
      [a[0] / 64, a[1] / 64 + 0.5], [b[0] / 64, b[1] / 64 + 0.5], [c[0] / 64, c[1] / 64 + 0.5], [d[0] / 64, d[1] / 64 + 0.5]);
    fq([-fx, -fy], [fx, -fy], [fx, s0y], [-fx, s0y]); fq([-fx, s1y], [fx, s1y], [fx, fy], [-fx, fy]);
    fq([-fx, s0y], [s0x, s0y], [s0x, s1y], [-fx, s1y]); fq([s1x, s0y], [fx, s0y], [fx, s1y], [s1x, s1y]);
    const wq = (a, b, n) => flatQuad(rp, P3(a[0], a[1], pz), P3(b[0], b[1], pz), P3(b[0], b[1], fl), P3(a[0], a[1], fl), n, [0, 0], [0.4, 0], [0.4, 0.04], [0, 0.04]);
    wq([s0x, s0y], [s1x, s0y], [0, -1, 0]); wq([s0x, s1y], [s1x, s1y], [0, 1, 0]); wq([s0x, s0y], [s0x, s1y], [1, 0, 0]); wq([s1x, s0y], [s1x, s1y], [-1, 0, 0]);
    const dark = put(M('misc'), [0.02, 0.02, 0.025], [2.5, 0]);
    flatQuad(dark, P3(s0x, s0y, fl), P3(s1x, s0y, fl), P3(s1x, s1y, fl), P3(s0x, s1y, fl), [0, 0, 1], [0, 0], [1, 0], [1, 1], [0, 1]);
    for (const x of [-px + 3.2, px - 3.2]) screw(M, x, py - 3.2, pz, 1.5);
  },
  // Chrome twin-rod track clamped in a row of brackets (`bracket`: a tie in the note's colour standing on the board
  // on a steel foot plate with two screws), so the rail visibly stands off the board from any angle
  rail(p, M) {
    const L = p.len, hw = CANON.HW.rail, rr = 2.3, yRod = -hw + 2.1, dz = 5.6;
    const ch = put(M('metal'), CHROME, FIN.chrome);
    for (const s of [-1, 1]) rod(ch, [P3(-L / 2, yRod, ZM + s * dz), P3(L / 2, yRod, ZM + s * dz)], rr, 14);
    const nt = Math.max(2, Math.round(L / 46) + 1);
    for (let i = 0; i < nt; i++) bracket(M, -L / 2 + 6 + (L - 12) * i / (nt - 1), yRod + 2.6, 0, p.note, dz);
  },
  // The same track bent round an arc (rods on the collider arc; the arc is drawn smooth), its brackets radial
  curve(p, M) {
    const r = p.r, sw = p.sweep, rr = 2.3, dz = 5.6, n = Math.max(8, Math.ceil(sw / 4));
    const ch = put(M('metal'), CHROME, FIN.chrome);
    const at = (a, rad, z) => P3(Math.cos(a * RAD) * rad, Math.sin(a * RAD) * rad, z);
    for (const s of [-1, 1]) { const path = []; for (let i = 0; i <= n; i++) path.push(at(sw * i / n, r, ZM + s * dz)); rod(ch, path, rr, 12); }
    const nt = Math.max(2, Math.round((sw * RAD * r) / 40) + 1);
    for (let i = 0; i < nt; i++) {
      const a = (sw * (i + 0.5)) / nt * RAD;
      bracket(M, Math.cos(a) * r, Math.sin(a) * r, a + Math.PI / 2, p.note, dz);
    }
  },
  // Polished brass dome bumper on a steel stem, with a band of the note's colour round its skirt
  bell(p, M) {
    const r = p.r, br = put(M('metal'), BRASS, FIN.brass);
    const rows = [[0.5, r * 0.98], [ZM - 2, r], [ZM + 1.5, r]];
    for (let k = 1; k <= 7; k++) { const a = (k / 7) * Math.PI / 2; rows.push([ZM + 1.5 + Math.sin(a) * r * 0.62, r * Math.cos(a) + 0.01]); }
    latheZ(br, rows, 44);
    const band = put(M('metal'), anodCol(p.note), FIN.anod);
    latheZ(band, [[ZM - 6, r + 0.45], [ZM - 5.4, r + 0.8], [ZM - 2.6, r + 0.8], [ZM - 2.0, r + 0.45]], 44);
    const nut = put(M('metal'), CHROME, FIN.chrome);
    latheZ(nut, [[ZM + 1.5 + r * 0.62 - 0.4, 2.4], [ZM + 1.5 + r * 0.62 + 0.8, 2.3], [ZM + 1.5 + r * 0.62 + 1.6, 1.4], [ZM + 1.5 + r * 0.62 + 1.9, 0.01]], 16);
    // a satin steel base flange screwed to the board (the dome stands on it)
    latheZ(put(M('metal'), STEEL, FIN.satin), [[0.2, r + 4.5], [1.4, r + 4.3], [2.4, r + 2.2], [2.4, r * 0.9]], 36);
    for (let k = 0; k < 3; k++) { const a = k * Math.PI * 2 / 3 + 0.5; screw(M, Math.cos(a) * (r + 2.9), Math.sin(a) * (r + 2.9), 1.4, 1.3); }
  },
  // Trampoline pad: a coloured rubber-topped steel plate on coil springs over a base bar
  spring(p, M) {
    const L = p.len, hw = CANON.HW.spring, hx = L / 2 + hw;
    const pad = put(M('misc'), anodCol(p.note).map((v) => v * 0.9), [2.2, 0]);
    prism(pad, roundRectPts(hx, 2.1, 1.8).map(([x, y]) => [x, y - hw + 2.1]), ZM - 10, ZM + 10, 1, (x, y) => [x / 64, y / 64]);
    const plate = put(M('metal'), STEEL, FIN.steel);
    prism(plate, roundRectPts(hx, 2.9, 1.2).map(([x, y]) => [x, y + hw - 2.9]), ZM - 10, ZM + 10, 0.8, (x, y) => [x / 64, y / 64]);
    const coil = put(M('metal'), [0.7, 0.71, 0.74], FIN.steel);
    const nsp = L > 90 ? 3 : 2;
    for (let k = 0; k < nsp; k++) {
      const x = -L / 2 + 6 + (L - 12) * (nsp === 1 ? 0.5 : k / (nsp - 1)), path = [];
      for (let i = 0; i <= 60; i++) { const a = (i / 60) * Math.PI * 2 * 4.5; path.push(P3(x + Math.cos(a) * 3.6, hw + 0.4 + (i / 60) * 13, ZM + Math.sin(a) * 3.6)); }
      rod(coil, path, 0.8, 6, false);
    }
    prism(put(M('metal'), STEEL, FIN.satin), roundRectPts(hx - 2, 1.6, 1).map(([x, y]) => [x, y + hw + 15]), ZM - 8, ZM + 8, 0.6, (x, y) => [x / 64, y / 64]);
    for (const x of [-hx * 0.6, hx * 0.6]) { postZ(put(M('metal'), STEEL, FIN.satin), x, hw + 15, 2.2, 0, ZM - 8, 0); foot(M, x, hw + 15, 3.3); }
  },
  // Brushed steel stop plate with a stripe of the note's colour and two bolts
  wall(p, M) {
    const L = p.len, hw = CANON.HW.wall, hx = L / 2 + hw;
    prism(put(M('metal'), [0.78, 0.79, 0.81], FIN.satin), roundRectPts(hx, hw, 1.8), ZM - 11, ZM + 11, 2.2, (x, y) => [x / 64, y / 64]);   // light satin steel, wide bevel
    const st = put(M('metal'), anodCol(p.note), FIN.anod);
    flatQuad(st, P3(-hx + 2, -1.6, ZM + 11.02), P3(hx - 2, -1.6, ZM + 11.02), P3(hx - 2, 1.6, ZM + 11.02), P3(-hx + 2, 1.6, ZM + 11.02), [0, 0, 1], [0, 0], [1, 0], [1, 0.1], [0, 0.1]);
    for (const x of [-hx + 7, hx - 7]) { const b = put(M('metal'), CHROME, FIN.chrome); latheZ(b, [[ZM + 11, 2.3], [ZM + 11.9, 2.2], [ZM + 12.6, 1.4], [ZM + 12.9, 0.01]], 14); translateLast(b, x, 0); }
    for (const x of [-hx * 0.55, hx * 0.55]) { postZ(put(M('metal'), STEEL, FIN.satin), x, 0, 2.4, 0, ZM - 10.5, 0); foot(M, x, 0, 3.5); }
  },
  // Spun steel funnel: a flattened half-cone (an elliptical cross-section) whose back rests on the board. In the
  // marble plane its walls are exactly CANON's funnel lines (x radius); the z semi-axis is squashed so the shell
  // runs from just off the board up to the marble plane, with a spun collar round the neck, a rolled rim in the
  // note's colour, and short standoffs under the shell on its centre line. The brushed grain runs down the slant.
  funnel(p, M) {
    const w2 = p.w / 2, h2 = p.h / 2, hw = CANON.HW.funnel, rN = 15, C = ZM - 1.6;   // z semi-axis: the back at z ~ 1.6
    const rows = [];                                   // [y (board, down), x radius] down the cone, then the neck
    for (let i = 0; i <= 12; i++) { const f = i / 12; rows.push([-h2 + p.h * f, w2 + (rN - w2) * f]); }
    for (let i = 1; i <= 4; i++) rows.push([h2 + 20 * i / 4, rN]);
    const slant = [0];
    for (let i = 1; i < rows.length; i++) slant.push(slant[i - 1] + Math.hypot(rows[i][0] - rows[i - 1][0], rows[i][1] - rows[i - 1][1]));
    const steel = put(M('metal'), [0.8, 0.81, 0.83], FIN.steel);
    const d0 = Math.asin(Math.min(0.9, hw / C));        // the shell reaches a little in front of the marble plane
    const a0 = -Math.PI - d0, a1 = d0, cols = 33;
    const at = (r, c, a, y) => [Math.cos(a) * r, -y, ZM + Math.sin(a) * c];
    for (const off of [-hw * 0.6, hw * 0.6]) {         // inner and outer skins (the sheet is 2 hw thick)
      surfaceGrid(steel, rows.length, cols, (i, j) => at(rows[i][1] + off, C + off, a0 + (a1 - a0) * j / (cols - 1), rows[i][0]),
        (i, j) => [slant[i] / 40, (a0 + (a1 - a0) * j / (cols - 1)) * rows[i][1] / 40],
        (i, j, q) => { const d = [q[0] / (rows[i][1] * rows[i][1] || 1), 0, (q[2] - ZM) / (C * C)]; return off < 0 ? V3.scale(d, -1) : d; });
    }
    // rolled rim round the top, and down both cut edges, in the note's colour
    const rim = put(M('metal'), anodCol(p.note), FIN.anod), top = [];
    for (let j = 0; j <= 24; j++) top.push(at(w2, C, a0 + (a1 - a0) * j / 24, -h2 - 0.5));
    rod(rim, top, 1.9, 8);
    for (const a of [a0, a1]) rod(put(M('metal'), anodCol(p.note), FIN.anod), rows.map(([y, r]) => at(r, C, a, y)), 1.4, 8);
    // a spun collar where the cone meets the neck
    const collar = put(M('metal'), [0.86, 0.87, 0.89], FIN.chrome), ring = [];
    for (let j = 0; j <= 18; j++) ring.push(at(rN + 1.2, C + 1.2, a0 + (a1 - a0) * j / 18, h2 + 1));
    rod(collar, ring, 2.2, 8);
    // standoffs from the board to the shell's back, on its centre line
    for (const y of [-h2 * 0.45, h2 * 0.35, h2 + 12]) { postZ(put(M('metal'), STEEL, FIN.satin), 0, y, 2.4, 0, ZM - C + 0.4, 0); foot(M, 0, y, 3.5); }
  },
  // Brass drop tube with a loading hopper on top, a 70-degree sight slot down its front (you can see the marble
  // waiting in it) and a little gate at the bottom (the gate is its own mesh)
  dropper(p, M) {
    const br = put(M('metal'), BRASS, FIN.brass);
    const top = -78, bot = -12, R = 12.6, Ri = 11.2, s0 = -70, s1 = -20, half = 35 * RAD;
    const full = [-Math.PI / 2, Math.PI * 1.5], open = [Math.PI / 2 + half, Math.PI * 2.5 - half];   // (+z is the front)
    const dark = put(M('misc'), [0.06, 0.045, 0.03], [2.5, 0]);
    const tube = (y0, y1, [a0, a1], cols) => {
      latheY(br, [[y0, R], [y1, R]], a0, a1, cols, false);
      latheY(dark, [[y0, Ri], [y1, Ri]], a0, a1, cols, true);
    };
    tube(top, s0, full, 40); tube(s0, s1, open, 34); tube(s1, bot + 1.2, full, 40);
    latheY(br, [[bot + 1.2, R], [bot + 0.2, R - 0.4], [bot, R - 1.2]], full[0], full[1], 40, false);
    latheY(dark, [[top - 16, Ri + 7.8], [top, Ri]], full[0], full[1], 32, true);
    for (const a of open) {                            // the slot's cut edges (the wall's thickness)
      const q = (r, y) => [Math.cos(a) * r, -y, ZM + Math.sin(a) * r];
      flatQuad(br, q(Ri, s0), q(R, s0), q(R, s1), q(Ri, s1), [-Math.sin(a), 0, Math.cos(a)], [0, 0], [0.05, 0], [0.05, 0.8], [0, 0.8]);
    }
    for (const y of [s0 - 1.6, s1 + 1.6]) {            // brass rings framing the slot
      const ring = [];
      for (let j = 0; j <= 32; j++) { const a = full[0] + (full[1] - full[0]) * j / 32; ring.push([Math.cos(a) * (R + 0.5), -y, ZM + Math.sin(a) * (R + 0.5)]); }
      rod(br, ring, 1.3, 6, false);
    }
    latheY(br, [[top, R], [top - 16, R + 8], [top - 17.6, R + 8.4], [top - 18.2, R + 7.6], [top - 17, Ri + 7.8]], full[0], full[1], 40, false);
    // two clamp brackets to the board
    for (const y of [top + 4, bot - 6]) {
      prism(put(M('metal'), STEEL, FIN.satin), roundRectPts(11, 3.4, 1.2).map(([x, yy]) => [x, yy + y]), 0, ZM - R + 0.8, 0.6, (x, yy) => [x / 64, yy / 64]);
      rod(put(M('metal'), STEEL, FIN.satin), (() => { const q = []; for (let j = 0; j <= 12; j++) { const a = (j / 12) * Math.PI; q.push([Math.cos(a) * (R + 0.9), -y, ZM + Math.sin(a) * (R + 0.9)]); } return q; })(), 1.1, 6, false);
      for (const x of [-8.2, 8.2]) screw(M, x, y, ZM - R + 0.8, 1.4);
    }
  },
  // Wall-mounted galvanised pail (D-shaped: flat against the board), wire handle and a painted band
  bucket(p, M) {
    const galv = put(M('metal'), [0.7, 0.72, 0.74], FIN.galv);
    const rows = [[30, 30], [-30, 35]], lo = (r) => -Math.asin(Math.min(1, (ZM - 1.5) / r));
    const span = (r) => [lo(r), Math.PI - lo(r)];
    for (const [off, inward] of [[3, false], [0, true]]) {
      const rr = rows.map(([y, r]) => [y, r + off - 1.5]);
      surfaceGrid(galv, 6, 36, (i, j) => { const f = i / 5, y = rr[0][0] + (rr[1][0] - rr[0][0]) * f, r = rr[0][1] + (rr[1][1] - rr[0][1]) * f; const [a0, a1] = span(r); const a = a0 + (a1 - a0) * j / 35; return [Math.cos(a) * r, -y, ZM + Math.sin(a) * r]; },
        (i, j) => [j / 12, i / 5], (i, j, q) => { const d = [q[0], 0.08, q[2] - ZM]; return inward ? V3.scale(d, -1) : d; });
    }
    // a rolled stiffening ring pressed round the middle, in the same (slightly darker, spangled) galvanised steel
    const band = put(M('metal'), [0.56, 0.58, 0.6], FIN.galv), bandPath = [];
    { const y = 2, r = 30 + (30 - y) / 12 + 1.9, [a0, a1] = span(r); for (let j = 0; j <= 30; j++) { const a = a0 + (a1 - a0) * j / 30; bandPath.push([Math.cos(a) * r, -y, ZM + Math.sin(a) * r]); } }
    rod(band, bandPath, 1.7, 8, false);
    const rim = put(M('metal'), [0.78, 0.8, 0.82], FIN.steel), path = [];
    const [ra0, ra1] = span(35);
    for (let j = 0; j <= 30; j++) { const a = ra0 + (ra1 - ra0) * j / 30; path.push([Math.cos(a) * 35.6, 30, ZM + Math.sin(a) * 35.6]); }
    rod(rim, path, 1.7, 8);
    const bottom = []; for (let j = 0; j < 24; j++) { const [a0, a1] = span(30); const a = a0 + (a1 - a0) * j / 23; bottom.push([Math.cos(a) * 30, -29, ZM + Math.sin(a) * 30]); }
    flatFan(galv, bottom, [0, 1, 0], (q) => [q[0] / 64, q[2] / 64]);
    const back = [];                                 // flat back plate against the board
    for (const [x, y] of [[-35, -30], [35, -30], [30, 30], [-30, 30]]) back.push(P3(x * 0.99, y, 1.6));
    flatFan(galv, back, [0, 0, 1], (q) => [q[0] / 64, q[1] / 64]);
    for (const [x, y] of [[-16, -20], [16, -20], [0, 14]]) screw(M, x, y, 1.6, 1.6);   // screwed to the board through its back
    const wire = put(M('misc'), [0.55, 0.56, 0.58], [1.2, 1]), h = [];
    for (let j = 0; j <= 20; j++) { const a = Math.PI * j / 20; h.push([Math.cos(a) * 36.2, 22 + Math.sin(a) * 24, ZM + 12 + Math.sin(a) * 10]); }
    rod(wire, h, 0.9, 6);
  },
};
// Move the last-built vertices of a builder (used for small repeated parts built at the origin)
const LAST = new WeakMap();
function markStart(mb) { LAST.set(mb, mb.count); }
function translateLast(mb, dx, dy) {
  const from = LAST.get(mb) ?? 0;
  for (let i = from; i < mb.count; i++) { mb.v[i * VSTRIDE] += dx; mb.v[i * VSTRIDE + 1] -= dy; }
  LAST.set(mb, mb.count);
}

// Build the mesh builders of one piece shape: { material: MeshBuilder }
function buildPieceMeshes(p) {
  const mbs = {};
  const M = (mat) => { let b = mbs[mat]; if (!b) { b = mbs[mat] = new MeshBuilder(); } markStart(b); return b; };
  const f = PIECE_BUILD[p.type];
  if (f) f(p, M);
  for (const mat in mbs) bakeContactAO(mbs[mat]);
  return mbs;
}
// Contact occlusion baked into the vertex AO (colour alpha): where a piece meets the board (posts, feet, plates,
// the backs of tubes and pails, a dome's skirt) it darkens towards z = 0, so pieces sit on the board instead of
// floating over it. Only the ambient light is occluded (the shader keeps the sun on it).
function bakeContactAO(mb) {
  const v = mb.v, S = VSTRIDE;
  for (let i = 0; i < v.length; i += S) {
    const z = v[i + 2];
    if (z >= 9) continue;
    const t = Math.max(0, z) / 9, s = t * t * (3 - 2 * t);
    v[i + 15] *= 0.42 + 0.58 * s;
  }
}
// Shape key: pieces with equal keys share meshes
function pieceShapeKey(p) {
  let k = p.type;
  for (const q of PARAM_KEYS[p.type] || []) k += '|' + (Math.round(p[q] * 100) / 100);
  if (hasNote(p.type)) k += '|' + (p.note || '');
  return k;
}
// The gate of a dropper (drawn separately so it can flick open): a brass plate hinged at its left end
function buildGateMeshes() {
  const mb = new MeshBuilder();
  put(mb, BRASS, FIN.brass);
  prism(mb, roundRectPts(13, 1.1, 0.8).map(([x, y]) => [x + 13, y]), ZM - 11, ZM + 11, 0.4, (x, y) => [x / 64, y / 64]);
  return { metal: mb };
}
