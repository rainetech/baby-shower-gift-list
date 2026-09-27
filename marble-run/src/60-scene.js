
/* ============================================================================
 *  RENDERING (WebGL2): the room
 *  A tempered-hardboard pegboard (holes every 20 units: the snap grid) in a slim
 *  pine frame hangs on the painted block wall above the desk. A brushed steel
 *  catch trough runs along its bottom edge: marbles that leave the board drop
 *  into it (CANON removes them just below the board, hidden by its lip).
 *  Static meshes, built once, one per material.
 * ========================================================================== */
const SCENE = { builders: {}, meshes: [] };
function MB(mat) { return SCENE.builders[mat] || (SCENE.builders[mat] = new MeshBuilder()); }
const BOARD_T = 6;                                // hardboard thickness
const BOARD_PAD = 10;                             // board edge beyond the outermost holes
const FRAME_W = 28, FRAME_Z = 3;                  // pine frame strip width and how far its face stands out
const WALL_Z = -34;                               // the wall behind (the board hangs on standoffs)
const DESK_Y = 1190;                              // desk top (board units, y down)
const TROUGH = { y0: 1024, y1: 1084, z1: 42, x0: -FRAME_W - 12, x1: BOARD_W + FRAME_W + 12 };

function* buildScene() {
  const rnd = mulberry32(90210);
  buildPegboard(rnd);
  yield;
  buildFrame(rnd);
  buildTrough(rnd);
  yield;
  buildRoom(rnd);
  buildWallNotes(rnd);
}

/* ---- The pegboard: one face grid (large-scale tone variation in the vertex colours), edges and back ---- */
function buildPegboard(rnd) {
  const x0 = -BOARD_PAD, x1 = BOARD_W + BOARD_PAD, y0 = -BOARD_PAD, y1 = BOARD_H + BOARD_PAD;
  const face = MB('peg');
  face.setMat(1, 0, 0, 0);
  const nz = makeNoise2(31337, 16), cols = 33, rows = 21;
  surfaceGrid(face, rows, cols, (i, j) => P3(lerp(x0, x1, j / (cols - 1)), lerp(y0, y1, i / (rows - 1)), 0),
    (i, j) => [(lerp(x0, x1, j / (cols - 1)) + 10) / PEG.tile, (lerp(y0, y1, i / (rows - 1)) + 10) / PEG.tile], () => [0, 0, 1],
    { forceRef: true, col: (i, j) => {
      const k = 0.95 + (nz(j / 4, i / 4, 16) - 0.5) * 0.16;
      const edge = Math.min(i, rows - 1 - i, j, cols - 1 - j) === 0 ? 0.86 : 1;   // a little darker under the frame
      return [k, k * 0.985, k * 0.97, edge];
    } });
}

/* ---- Slim pine frame, mitred at the corners ---- */
function buildFrame(rnd) {
  const wood = MB('wood');
  const ix0 = -BOARD_PAD, ix1 = BOARD_W + BOARD_PAD, iy0 = -BOARD_PAD, iy1 = BOARD_H + BOARD_PAD, W = FRAME_W;
  const strips = [
    [[ix0 - W, iy0 - W], [ix1 + W, iy0 - W], [ix1, iy0], [ix0, iy0]],
    [[ix1, iy0], [ix1 + W, iy0 - W], [ix1 + W, iy1 + W], [ix1, iy1]],
    [[ix0, iy1], [ix1, iy1], [ix1 + W, iy1 + W], [ix0 - W, iy1 + W]],
    [[ix0 - W, iy0 - W], [ix0, iy0], [ix0, iy1], [ix0 - W, iy1 + W]],
  ];
  strips.forEach((q, k) => {
    const tone = 0.96 + rnd() * 0.08;
    wood.setCol(tone * 1.02, tone * 0.93, tone * 0.8, 1); wood.setMat(1.05, 0, 0, 0);
    const horiz = k % 2 === 0;
    const uv = (p) => (horiz ? [p[0] / 128 + k * 0.37, -p[1] / 32] : [-p[1] / 128 + k * 0.37, p[0] / 32]);
    const pts = q.map(([x, y]) => P3(x, y, FRAME_Z));
    flatQuad(wood, pts[0], pts[1], pts[2], pts[3], [0, 0, 1], uv(pts[0]), uv(pts[1]), uv(pts[2]), uv(pts[3]));
    // outer edge face (the inner edge is hidden by the board)
    const [a, b] = horiz ? (k === 0 ? [q[0], q[1]] : [q[2], q[3]]) : (k === 1 ? [q[1], q[2]] : [q[3], q[0]]);
    const n = k === 0 ? [0, 1, 0] : k === 1 ? [1, 0, 0] : k === 2 ? [0, -1, 0] : [-1, 0, 0];
    flatQuad(wood, P3(a[0], a[1], FRAME_Z), P3(b[0], b[1], FRAME_Z), P3(b[0], b[1], -BOARD_T - 4), P3(a[0], a[1], -BOARD_T - 4), n,
      [0, 0], [1.5, 0], [1.5, 0.1], [0, 0.1]);
    // the small step from the frame's face down to the board
    const [c, d] = horiz ? (k === 0 ? [q[2], q[3]] : [q[0], q[1]]) : (k === 1 ? [q[3], q[0]] : [q[1], q[2]]);
    wood.setCol(tone * 0.8, tone * 0.72, tone * 0.6, 1);
    flatQuad(wood, P3(c[0], c[1], FRAME_Z), P3(d[0], d[1], FRAME_Z), P3(d[0], d[1], 0), P3(c[0], c[1], 0), V3.scale(n, -1),
      [0, 0], [1.5, 0], [1.5, 0.02], [0, 0.02]);
  });
}

/* ---- Brushed steel catch trough under the board, on two brackets ---- */
function buildTrough(rnd) {
  const m = MB('metal');
  m.setCol(0.8, 0.81, 0.83, 1); m.setMat(1.4, 0.55, 0, 0);
  const { y0, y1, z1, x0, x1 } = TROUGH;
  // front lip, floor, rolled top edge and end caps
  flatQuad(m, [x0, -y0, z1], [x1, -y0, z1], [x1, -y1, z1], [x0, -y1, z1], [0, 0, 1], [x0 / 64, 0], [x1 / 64, 0], [x1 / 64, 1], [x0 / 64, 1]);
  flatQuad(m, [x0, -y1 + 3, 0], [x1, -y1 + 3, 0], [x1, -y1 + 3, z1], [x0, -y1 + 3, z1], [0, 1, 0], [x0 / 64, 0], [x1 / 64, 0], [x1 / 64, 0.6], [x0 / 64, 0.6]);
  flatQuad(m, [x0, -y1, z1], [x1, -y1, z1], [x1, -y1, 0], [x0, -y1, 0], [0, -1, 0], [x0 / 64, 0], [x1 / 64, 0], [x1 / 64, 0.6], [x0 / 64, 0.6]);
  m.setMat(0.3, 1, 0, 0);                          // a polished rolled edge
  rod(m, [[x0, -y0, z1 - 0.5], [x1, -y0, z1 - 0.5]], 2.4, 12, false);
  m.setMat(1.4, 0.55, 0, 0);
  for (const [x, nx] of [[x0, -1], [x1, 1]]) flatQuad(m, [x, -y0, z1], [x, -y0, 0], [x, -y1, 0], [x, -y1, z1], [nx, 0, 0], [0, 0], [0.6, 0], [0.6, 1], [0, 1]);
  // inside: a darker felt lining so marbles land softly (and read against it)
  const felt = MB('misc');
  felt.setCol(0.09, 0.1, 0.13, 1); felt.setMat(1, 0, 0, 0);
  flatQuad(felt, [x0 + 1, -y1 + 3.2, 0.5], [x1 - 1, -y1 + 3.2, 0.5], [x1 - 1, -y1 + 3.2, z1 - 1], [x0 + 1, -y1 + 3.2, z1 - 1], [0, 1, 0], [0, 0], [1, 0], [1, 1], [0, 1]);
  const br = MB('metal');
  br.setCol(0.55, 0.56, 0.58, 1); br.setMat(1.8, 1, 0, 0);
  for (const x of [120, BOARD_W / 2, BOARD_W - 120]) boxMesh(br, [x - 6, -y1 - 16, -BOARD_T], [x + 6, -y1 + 2, 30], 32);   // (under the floor: nothing shows over the lip)
}

// Axis-aligned box with all six faces (u scaled by `uvs` units)
function boxMesh(mb, lo, hi, uvs = 64) {
  const [x0, y0, z0] = lo, [x1, y1, z1] = hi;
  const F = [
    [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1]],
    [[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [0, 0, -1]],
    [[x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [0, 1, 0]],
    [[x0, y0, z1], [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [0, -1, 0]],
    [[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [1, 0, 0]],
    [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [-1, 0, 0]],
  ];
  for (const [a, b, c, d, n] of F) {
    const uv = (p) => (Math.abs(n[2]) > 0.5 ? [p[0] / uvs, p[1] / uvs] : Math.abs(n[1]) > 0.5 ? [p[0] / uvs, p[2] / uvs] : [p[2] / uvs, p[1] / uvs]);
    flatQuad(mb, a, b, c, d, n, uv(a), uv(b), uv(c), uv(d));
  }
}

/* ---- Painted block wall and a butcher-block desk (strips, so their corner gets a soft occlusion gradient) ---- */
function buildRoom(rnd) {
  const wall = MB('wall'); wall.setMat(1, 0, 0, 0);
  const { x0, y0, uw, uh } = WALL_TEX;
  // (the wall runs on above its painted texture, mirrored, so a zoomed-out tall screen never sees past it)
  const wy = [[y0 - 1150, 1], [y0, 1], [DESK_Y - 160, 1], [DESK_Y - 70, 0.9], [DESK_Y - 25, 0.72], [DESK_Y, 0.5], [y0 + uh, 0.5]];
  surfaceGrid(wall, wy.length, 2, (i, j) => [x0 + uw * j, -wy[i][0], WALL_Z], (i, j) => [j, Math.abs(wy[i][0] - y0) / uh], () => [0, 0, 1],
    { forceRef: true, col: (i) => { const k = wy[i][1]; return [0.94 + 0.06 * k, 0.94 + 0.06 * k, 0.95 + 0.05 * k, k]; } });
  // a soft contact shadow of the board on the wall is left to the shadow map; the board's hanging cleat:
  const wood = MB('wood'); wood.setCol(0.75, 0.66, 0.55, 1); wood.setMat(1, 0, 0, 0);
  for (const x of [200, BOARD_W - 200]) boxMesh(wood, [x - 40, -(-BOARD_PAD - 2), WALL_Z], [x + 40, -(-BOARD_PAD + 30), -BOARD_T], 64);
  // (the desk runs on past the camera, however far back a phone's view sits: no empty space below it)
  const desk = MB('desk'); desk.setMat(1, 0, 0, 0);
  const X0 = -6000, X1 = 7600;
  const dz = [[WALL_Z, 0.5], [WALL_Z + 18, 0.72], [WALL_Z + 55, 0.9], [WALL_Z + 140, 1], [1800, 1], [14000, 1]];
  surfaceGrid(desk, dz.length, 2, (i, j) => [j ? X1 : X0, -DESK_Y, dz[i][0]], (i, j) => [(j ? X1 : X0) / 1024, dz[i][0] / 1024], () => [0, 1, 0],
    { forceRef: true, col: (i) => { const k = dz[i][1]; return [0.9 + 0.1 * k, 0.9 + 0.1 * k, 0.9 + 0.1 * k, k]; } });
}

/* ---- On the wall beside the board: a child's crayon drawing; a sticky note on the frame ---- */
function buildWallNotes(rnd) {
  const note = MB('note'); note.setCol(1, 1, 1, 1); note.setMat(1, 0, 0, 0);
  const tape = MB('tape'); tape.setCol(1, 1, 1, 1); tape.setMat(1, 0, 0, 0);
  const sheet = (cx, cy, w, h, rot, z, uv, curl) => {
    const [u0, v0, u1, v1] = uv, cs = Math.cos(rot), sn = Math.sin(rot);
    const at = (u, v) => {
      const lx = (u - 0.5) * w, ly = (v - 0.5) * h;
      const lift = curl * Math.pow(Math.max(0, v - 0.5) / 0.5, 2) * (0.5 + 0.5 * Math.abs(u - 0.5) * 2);
      return P3(cx + lx * cs - ly * sn, cy + lx * sn + ly * cs, z + lift);
    };
    surfaceGrid(note, 7, 7, (i, j) => at(j / 6, i / 6), (i, j) => [lerp(u0, u1, j / 6), lerp(v0, v1, i / 6)], () => [0, 0, 1]);
    return at;
  };
  const at = sheet(-300, 330, 190, 224, 0.05, WALL_Z + 0.35, NOTE_UV.drawing, 3.5);
  for (const [u, a] of [[0.04, -0.7], [0.96, 0.7]]) {
    const c = at(u, 0.03), d = [Math.cos(a) * 14, Math.sin(a) * 14, 0];
    tapeStrip(tape, [V3.sub(c, d), V3.add(c, d)], [[0, 0, 1]], V3.norm([-Math.sin(a), Math.cos(a), 0]), 11, rnd, [0, 0.5], rnd() * 300);
  }
  sheet(-12, -16, 62, 58, -0.08, FRAME_Z + 0.4, NOTE_UV.sticky, 2.5);
}
