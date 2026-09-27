
/* ============================================================================
 *  RENDERING (WebGL2): geometry helpers
 *  All pieces are generated here as real 3D meshes (no sprites). Positions of
 *  board pieces are in panel-local space (x, -y, z); fixed pieces are relative
 *  to the tube/cup centre line. Normals always point out of the visible side;
 *  triangles are wound to agree with them so gl_FrontFacing is reliable.
 * ========================================================================== */
const P3 = (x, y, z) => [x, -y, z];             // (x, y down, z) -> 3D (Y up)

MeshBuilder.prototype.triAuto = function (a, b, c) {
  const v = this.v, S = VSTRIDE;
  const ax = v[a * S], ay = v[a * S + 1], az = v[a * S + 2];
  const e1 = [v[b * S] - ax, v[b * S + 1] - ay, v[b * S + 2] - az], e2 = [v[c * S] - ax, v[c * S + 1] - ay, v[c * S + 2] - az];
  const fn = V3.cross(e1, e2);
  const nn = [v[a * S + 3] + v[b * S + 3] + v[c * S + 3], v[a * S + 4] + v[b * S + 4] + v[c * S + 4], v[a * S + 5] + v[b * S + 5] + v[c * S + 5]];
  if (V3.dot(fn, nn) >= 0) this.idx.push(a, b, c); else this.idx.push(a, c, b);
};
MeshBuilder.prototype.quadAuto = function (a, b, c, d) { this.triAuto(a, b, c); this.triAuto(a, c, d); };

// Grid surface: pos(i, j) -> point; normals from neighbours, flipped to agree with outward(i, j, p)
function surfaceGrid(mb, rows, cols, pos, uv, outward, opts = {}) {
  const P = new Array(rows * cols);
  for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) P[i * cols + j] = pos(i, j);
  const at = (i, j) => P[i * cols + j];
  const base = mb.count;
  for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) {
    const p = at(i, j);
    const pi0 = at(Math.max(i - 1, 0), j), pi1 = at(Math.min(i + 1, rows - 1), j);
    let pj0, pj1;
    if (opts.wrapJ) { pj0 = at(i, j === 0 ? cols - 2 : j - 1); pj1 = at(i, j === cols - 1 ? 1 : j + 1); }
    else { pj0 = at(i, Math.max(j - 1, 0)); pj1 = at(i, Math.min(j + 1, cols - 1)); }
    let n = V3.cross(V3.sub(pj1, pj0), V3.sub(pi1, pi0));
    const ref = outward(i, j, p);
    if (V3.len(n) < 1e-9) n = ref;
    n = V3.norm(n);
    if (opts.forceRef) n = V3.norm(ref);
    if (V3.dot(n, ref) < 0) n = V3.scale(n, -1);
    mb.vert(p, n, uv(i, j), opts.col ? opts.col(i, j) : mb.col, opts.mat ? opts.mat(i, j) : mb.mat);
  }
  for (let i = 0; i < rows - 1; i++) for (let j = 0; j < cols - 1; j++) {
    const a = base + i * cols + j;
    mb.quadAuto(a, a + 1, a + cols + 1, a + cols);
  }
  return P;
}

// Flat quad with a given normal
function flatQuad(mb, p0, p1, p2, p3, n, uv0, uv1, uv2, uv3) {
  const a = mb.vert(p0, n, uv0), b = mb.vert(p1, n, uv1), c = mb.vert(p2, n, uv2), d = mb.vert(p3, n, uv3);
  mb.quadAuto(a, b, c, d);
}

// Flat polygon (star-shaped about its centroid) as a fan
function flatFan(mb, pts, n, uvFn) {
  const c = pts.reduce((s, p) => V3.add(s, p), [0, 0, 0]).map((x) => x / pts.length);
  const ci = mb.vert(c, n, uvFn(c));
  const idx = pts.map((p) => mb.vert(p, n, uvFn(p)));
  for (let i = 0; i < idx.length; i++) mb.triAuto(ci, idx[i], idx[(i + 1) % idx.length]);
}

// Extrude a closed outline (in a plane) between two offsets along `dir`: side walls only
function extrudeSides(mb, pts, dir, depth, uvFn, smooth = false) {
  const n = pts.length;
  const c = pts.reduce((s, p) => V3.add(s, p), [0, 0, 0]).map((x) => x / n);
  for (let i = 0; i < n; i++) {
    const p0 = pts[i], p1 = pts[(i + 1) % n];
    const e = V3.sub(p1, p0);
    let nn = V3.norm(V3.cross(e, dir));
    const mid = V3.scale(V3.add(p0, p1), 0.5);
    if (V3.dot(nn, V3.sub(mid, c)) < 0) nn = V3.scale(nn, -1);
    const q0 = V3.add(p0, V3.scale(dir, depth)), q1 = V3.add(p1, V3.scale(dir, depth));
    const [u0, u1] = uvFn(i);
    flatQuad(mb, p0, p1, q1, q0, nn, [u0, 0], [u1, 0], [u1, 1], [u0, 1]);
  }
}

// Sweep a circle-ish cross-section along a 3D path (parallel-transport frames)
function sweepTube(mb, path, radiusFn, segs, uvFn, { inward = false, capStart = false, capEnd = false, up = null } = {}) {
  const n = path.length, T = [], N = [], B = [];
  for (let i = 0; i < n; i++) T.push(V3.norm(V3.sub(path[Math.min(i + 1, n - 1)], path[Math.max(i - 1, 0)])));
  let n0 = up ? V3.sub(up, V3.scale(T[0], V3.dot(up, T[0]))) : (Math.abs(T[0][2]) < 0.9 ? V3.cross(T[0], [0, 0, 1]) : V3.cross(T[0], [1, 0, 0]));
  n0 = V3.norm(n0);
  for (let i = 0; i < n; i++) {
    if (i > 0) { n0 = V3.sub(N[i - 1], V3.scale(T[i], V3.dot(N[i - 1], T[i]))); n0 = V3.norm(n0); }
    N.push(n0); B.push(V3.cross(T[i], n0));
  }
  const ring = (i, j) => { const a = (j / segs) * Math.PI * 2; return [Math.cos(a), Math.sin(a)]; };
  surfaceGrid(mb, n, segs + 1, (i, j) => {
    const [c, s] = ring(i, j), r = radiusFn(i, j);
    return V3.add(path[i], V3.add(V3.scale(N[i], c * r), V3.scale(B[i], s * r)));
  }, uvFn, (i, j, p) => (inward ? V3.sub(path[i], p) : V3.sub(p, path[i])), { wrapJ: true });
  const cap = (i, sign) => {
    const pts = [];
    for (let j = 0; j < segs; j++) { const [c, s] = ring(i, j), r = radiusFn(i, j); pts.push(V3.add(path[i], V3.add(V3.scale(N[i], c * r), V3.scale(B[i], s * r)))); }
    flatFan(mb, pts, V3.scale(T[i], sign), () => [0.5, 0.5]);
  };
  if (capStart) cap(0, -1);
  if (capEnd) cap(n - 1, 1);
  return { T, N, B };
}

// Surface of revolution about a vertical axis at (ax, az) in 3D. rowsY: list of 3D Y values; radius(i, theta).
// thetaRange(i) gives the angular span of each row (used to trim shells where they meet the board, Z >= 0).
function latheSurface(mb, rowsY, cols, ax, az, radius, thetaRange, uvFn, inward, opts = {}) {
  const th = (i, j) => { const [t0, t1] = thetaRange(i); return t0 + (t1 - t0) * (j / (cols - 1)); };
  return surfaceGrid(mb, rowsY.length, cols, (i, j) => {
    const t = th(i, j), r = radius(i, t);
    return [ax + Math.cos(t) * r, rowsY[i], az + Math.sin(t) * r];
  }, (i, j) => uvFn(i, j, th(i, j)), (i, j, p) => {
    const d = [p[0] - ax, 0, p[2] - az];
    return inward ? V3.scale(d, -1) : d;
  }, opts);
}

// Angular span of a circle of radius r centred at depth az that lies in front of the board (z >= zMin)
function frontSpan(r, az, zMin = 0) {
  if (r <= az - zMin) return [-Math.PI / 2, Math.PI * 1.5];      // full ring, clear of the board
  const s = Math.asin(clamp((zMin - az) / r, -1, 1));
  return [s, Math.PI - s];
}

// Masking tape: a strip along a polyline of surface points, `side` = width direction, torn zig-zag ends.
// nrm[i] is the surface normal under segment i. The tape floats 0.3 units above the surface.
function tapeStrip(mb, pts, nrm, side, width, rnd, vBand = [0, 0.5], uStart = 0) {
  const K = 7, lift = 0.3, hw = width / 2;
  let u = uStart;
  for (let s = 0; s < pts.length - 1; s++) {
    const n = nrm[s], p0 = V3.add(pts[s], V3.scale(n, lift)), p1 = V3.add(pts[s + 1], V3.scale(n, lift));
    const dir = V3.norm(V3.sub(p1, p0)), len = V3.len(V3.sub(p1, p0));
    const rows = [];
    for (const [end, p] of [[0, p0], [1, p1]]) {
      const torn = (s === 0 && end === 0) || (s === pts.length - 2 && end === 1);
      const row = [];
      for (let k = 0; k < K; k++) {
        const f = k / (K - 1), off = -hw + width * f;
        let q = V3.add(p, V3.scale(side, off));
        let du = 0;
        if (torn) { du = (rnd() - 0.5) * 2.4 * (end ? 1 : -1); q = V3.add(q, V3.scale(dir, du)); }
        row.push({ q, uv: [(u + (end ? len : 0) + du) / 128, vBand[0] + (vBand[1] - vBand[0]) * f] });
      }
      rows.push(row);
    }
    const base = mb.count;
    for (const row of rows) for (const { q, uv } of row) mb.vert(q, n, uv);
    for (let k = 0; k < K - 1; k++) mb.quadAuto(base + k, base + k + 1, base + K + k + 1, base + K + k);
    u += len;
  }
}

// Lumpy hot-glue bead along a path: the radius swells and thins (0.5..1.3x) like a real squeeze of glue
function glueBead(mb, path, r, rnd) {
  const ph = rnd() * 6.28, f = 0.9 + rnd() * 0.8;
  const wob = path.map((p, i) => clamp(0.9 + 0.3 * Math.sin(i * f + ph) + (rnd() - 0.5) * 0.35, 0.5, 1.3));
  wob[0] *= 0.7; wob[wob.length - 1] *= 0.7;                         // tapered ends
  sweepTube(mb, path, (i, j) => r * wob[i] * (0.85 + 0.15 * Math.sin(j * 1.7 + i)), 8, (i, j) => [i / 4, j / 8], { capStart: true, capEnd: true });
}

// Slightly flattened lumpy blob (glue dab)
function glueBlob(mb, c, r, h, rnd) {
  const rows = 5, cols = 14, lump = [];
  for (let j = 0; j < cols; j++) lump.push(0.8 + rnd() * 0.4);
  surfaceGrid(mb, rows, cols + 1, (i, j) => {
    const a = (j % cols) / cols * Math.PI * 2, e = (i / (rows - 1)) * Math.PI / 2;
    const rr = r * lump[j % cols] * Math.cos(e);
    return [c[0] + Math.cos(a) * rr, c[1] + Math.sin(a) * rr, c[2] + Math.sin(e) * h];
  }, (i, j) => [j / cols, i / rows], (i, j, p) => V3.sub(p, [c[0], c[1], c[2] - h * 0.5]), { wrapJ: true });
}

// Stapled wire: a flat U lying on a surface (normal n), crown along `dir`
function staple(mb, c, dir, n, w = 11) {
  const s = V3.norm(V3.cross(n, dir));
  const pts = [];
  const lift = 0.35;
  for (const f of [-0.5, -0.46, 0.46, 0.5]) pts.push(V3.add(V3.add(c, V3.scale(dir, f * w)), V3.scale(n, f === -0.5 || f === 0.5 ? -0.2 : lift)));
  sweepTube(mb, pts, () => 0.42, 6, (i, j) => [i, j / 6], { up: n });
  void s;
}
