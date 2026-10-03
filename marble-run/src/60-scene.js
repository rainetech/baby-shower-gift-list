/* ============================================================================
 *  RENDERING (WebGL2): the room
 *  A thick tempered-hardboard pegboard (holes every 20 units: the snap grid,
 *  right through the board) in a deep pine frame hangs on steel standoffs off
 *  the painted block wall, with a visible gap behind it. A brushed steel catch
 *  tray hangs under its bottom edge on wall brackets: marbles that leave the
 *  board drop into it (CANON removes them just below the board, hidden by its
 *  lip). The room is a box the camera can orbit inside: the block wall behind,
 *  block side walls, a ceiling with fluorescent strips and the butcher-block
 *  desk below, all sized from the board (BOARD_W x BOARD_H: a Wide board or a
 *  tower many screens tall) so that no edge of the room shows from any angle
 *  within the camera's limits (yaw +-75, pitch -25..+65 degrees). The desk,
 *  the ceiling and the side walls are one-sided (material flag 6/7): a camera
 *  zoomed out past them sees through them instead of a blank face. Static
 *  meshes, one per material, built again when the board's size changes
 *  (GLR.sceneBoard).
 * ========================================================================== */
const SCENE = { builders: {}, meshes: [] };
function MB(mat) { return SCENE.builders[mat] || (SCENE.builders[mat] = new MeshBuilder()); }
const BOARD_T = 9;                                // hardboard thickness
const BOARD_PAD = 10;                             // board edge beyond the outermost holes
const FRAME_W = 28, FRAME_Z = 3, FRAME_D = 22;    // pine frame: strip width, how far its face stands out, its depth
const FRAME_BACK = FRAME_Z - FRAME_D;             // the back of the frame (the standoffs start here)
const WALL_Z = -46;                               // the wall behind (the board hangs on standoffs: a 27-unit gap)
const STANDOFF_R = 7;                             // the steel spacer tubes between the frame and the wall
// Geometry that follows the board's size (boardGeometry): the desk top below it (board units, y down), the catch
// tray under its bottom edge (z0: its back wall, just in front of the frame's face; z1: its lip), and FIT_BOX, what
// the camera frames to show the whole board
let DESK_Y = 1190;
const TROUGH = { y0: 1024, y1: 1084, z0: 5, z1: 42, x0: 0, x1: 0 };
const FIT_BOX = { x0: 0, x1: 0, y0: 0, y1: 0, z0: 0, z1: 30 };
function boardGeometry() {
  DESK_Y = BOARD_H + 190;
  Object.assign(TROUGH, { y0: BOARD_H + 24, y1: BOARD_H + 84, x0: -FRAME_W - 12, x1: BOARD_W + FRAME_W + 12 });
  Object.assign(FIT_BOX, { x0: -FRAME_W - 18, x1: BOARD_W + FRAME_W + 18, y0: -FRAME_W - 18, y1: TROUGH.y1 + 8 });
}
boardGeometry();
onBoardSize(boardGeometry);
// How far the room reaches round the board (board units). The side walls at x0 / x1 and the ceiling at `top` (y,
// negative: above the board's top edge) are partitions the eye can pass (one-sided, see buildRoom); the back wall
// and the desk run on `beyond` them on each side, the wall from `wallTop` (above the ceiling) down to `floor` (below
// the desk), and the room is `z1` deep in front of the wall: from anywhere the camera can be (the whole tower framed
// from any angle within its limits, or a close-up) there is wall, desk or ceiling in every direction. `win` is the
// window on the left side wall the sun comes through (buildWindow).
const WIN_BEAM_W = 2600, WIN_MULLION_U = -330;   // the lit patch's width and its mullion in window-plane units (WINDOW, 75-render.js)
function roomExtent() {
  const r = Math.max(3000, BOARD_H * 1.2, BOARD_W * 1.6), x0 = -r, x1 = BOARD_W + r;
  // the window: where the sun's beam through the middle of the board meets the left wall (SUN_DIR points at the
  // light: up, to the left and towards the viewer); as wide on the wall as the beam, taller on a tower
  const U = V3.norm(V3.cross([0, 1, 0], SUN_DIR)), t = (BOARD_W / 2 - x0) / -SUN_DIR[0], k = Math.max(BOARD_W / 1600, 0.8);
  const win = { y: -BOARD_H / 2 + SUN_DIR[1] * t, z: SUN_DIR[2] * t, w: WIN_BEAM_W * k / U[2], mullionZ: WIN_MULLION_U * k / U[2], h: clamp(BOARD_H * 0.9 + 1500, 4400, 9000) };
  const top = Math.min(-Math.max(5000, BOARD_H * 3.5), -(win.y + win.h / 2 + 700));   // (the ceiling clears the window)
  return {
    x0, x1, top, win,
    z1: Math.max(16000, BOARD_H * 6, BOARD_W * 12, win.z + win.w / 2 + 2500),
    floor: Math.max(DESK_Y + 5000, BOARD_H * 3),
    wallTop: top - Math.max(3000, BOARD_H * 0.6),
    beyond: x1 - x0,
  };
}

function* buildScene() {
  const rnd = mulberry32(90210);
  buildPegboard(rnd);
  yield;
  buildFrame(rnd);
  buildStandoffs();
  buildTrough(rnd);
  yield;
  buildRoom(rnd);
  buildWindow();
  buildWallNotes(rnd);
}

/* ---- The pegboard: a slab. Front and back face grids (large-scale tone variation in the vertex colours; the
 *  holes go right through, so the back shows them too); its edges sit in the frame's rebate. ---- */
function buildPegboard(rnd) {
  const x0 = -BOARD_PAD, x1 = BOARD_W + BOARD_PAD, y0 = -BOARD_PAD, y1 = BOARD_H + BOARD_PAD;
  const face = MB('peg');
  face.setMat(1, 0, 0, 0);
  // (a vertex every 50 units or so; the tone's noise repeats only every 12800 units, far beyond any board)
  const nz = makeNoise2(31337, 64), cols = Math.max(2, Math.ceil((x1 - x0) / 50) + 1), rows = Math.max(2, Math.ceil((y1 - y0) / 50) + 1);
  const grid = (z, dir, tone) => surfaceGrid(face, rows, cols, (i, j) => P3(lerp(x0, x1, j / (cols - 1)), lerp(y0, y1, i / (rows - 1)), z),
    (i, j) => [(lerp(x0, x1, j / (cols - 1)) + 10) / PEG.tile, (lerp(y0, y1, i / (rows - 1)) + 10) / PEG.tile], () => [0, 0, dir],
    { forceRef: true, col: (i, j) => {
      const k = (0.95 + (nz(j / 4, i / 4, 64) - 0.5) * 0.16) * tone;
      const edge = Math.min(i, rows - 1 - i, j, cols - 1 - j) === 0 ? 0.86 : 1;   // a little darker under the frame
      return [k, k * 0.985, k * 0.97, edge];
    } });
  grid(0, 1, 1);
  grid(-BOARD_T, -1, 0.62);                          // the back: unpainted hardboard in the gap's shade
}

/* ---- Deep pine frame, mitred at the corners: front face, outer edges, the step down to the board, its back and
 *  the rebate that holds the board ---- */
function buildFrame(rnd) {
  const wood = MB('wood');
  const ix0 = -BOARD_PAD, ix1 = BOARD_W + BOARD_PAD, iy0 = -BOARD_PAD, iy1 = BOARD_H + BOARD_PAD, W = FRAME_W, zb = FRAME_BACK;
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
    // outer edge face, the frame's full depth
    const [a, b] = horiz ? (k === 0 ? [q[0], q[1]] : [q[2], q[3]]) : (k === 1 ? [q[1], q[2]] : [q[3], q[0]]);
    const n = k === 0 ? [0, 1, 0] : k === 1 ? [1, 0, 0] : k === 2 ? [0, -1, 0] : [-1, 0, 0];
    const eu = horiz ? 1 / 128 : 1 / 128, along = (p) => (horiz ? p[0] : -p[1]) * eu + k * 0.37;
    flatQuad(wood, P3(a[0], a[1], FRAME_Z), P3(b[0], b[1], FRAME_Z), P3(b[0], b[1], zb), P3(a[0], a[1], zb), n,
      [along(a), 0], [along(b), 0], [along(b), FRAME_D / 32], [along(a), FRAME_D / 32]);
    // the back of the frame (seen through the gap from an oblique angle)
    wood.setCol(tone * 0.9, tone * 0.82, tone * 0.7, 1);
    const bk = q.map(([x, y]) => P3(x, y, zb));
    flatQuad(wood, bk[0], bk[1], bk[2], bk[3], [0, 0, -1], uv(bk[0]), uv(bk[1]), uv(bk[2]), uv(bk[3]));
    // the small step from the frame's face down to the board, and the rebate behind the board
    const [c, d] = horiz ? (k === 0 ? [q[2], q[3]] : [q[0], q[1]]) : (k === 1 ? [q[3], q[0]] : [q[1], q[2]]);
    wood.setCol(tone * 0.8, tone * 0.72, tone * 0.6, 1);
    flatQuad(wood, P3(c[0], c[1], FRAME_Z), P3(d[0], d[1], FRAME_Z), P3(d[0], d[1], 0), P3(c[0], c[1], 0), V3.scale(n, -1),
      [along(c), 0], [along(d), 0], [along(d), 0.02], [along(c), 0.02]);
    flatQuad(wood, P3(c[0], c[1], -BOARD_T), P3(d[0], d[1], -BOARD_T), P3(d[0], d[1], zb), P3(c[0], c[1], zb), V3.scale(n, -1),
      [along(c), 0.1], [along(d), 0.1], [along(d), 0.2], [along(c), 0.2]);
  });
}

/* ---- Steel standoffs between the frame's back and the wall: a spacer tube on a rubber washer at the corners and
 *  every ~900 units along the sides, so a tower hangs on a whole row of them ---- */
function buildStandoffs() {
  const m = MB('metal'); m.setCol(0.6, 0.61, 0.63, 1); m.setMat(1.8, 1, 0, 0);
  const rub = MB('misc'); rub.setCol(0.05, 0.05, 0.055, 1); rub.setMat(3, 0, 0, 0);
  const cx0 = -BOARD_PAD - FRAME_W / 2, cx1 = BOARD_W + BOARD_PAD + FRAME_W / 2, cy0 = -BOARD_PAD - FRAME_W / 2, cy1 = BOARD_H + BOARD_PAD + FRAME_W / 2;
  const along = (a, b) => { const n = Math.max(1, Math.round((b - a) / 900)), o = []; for (let i = 0; i <= n; i++) o.push(a + (b - a) * i / n); return o; };
  const pts = [];
  for (const x of along(cx0, cx1)) pts.push([x, cy0], [x, cy1]);
  for (const y of along(cy0, cy1).slice(1, -1)) pts.push([cx0, y], [cx1, y]);
  for (const [x, y] of pts) {
    postZ(m, x, y, STANDOFF_R, WALL_Z + 1.4, FRAME_BACK + 0.5, 0, 18);
    postZ(rub, x, y, STANDOFF_R + 2.6, WALL_Z + 0.15, WALL_Z + 1.6, 0, 18);
  }
}

/* ---- Brushed steel catch tray under the board: a real tray (back wall, floor, front lip, end caps, rolled top
 *  edges, a felt lining) hanging on galvanised L-brackets from the wall ---- */
function buildTrough(rnd) {
  const m = MB('metal');
  m.setCol(0.8, 0.81, 0.83, 1); m.setMat(1.4, 0.55, 0, 0);
  const { y0, y1, z0, z1, x0, x1 } = TROUGH, Y0 = -y0, Y1 = -y1, T = 1.2, F = Y1 + 3;   // (F: the floor's top)
  const uvx = (x) => x / 64;
  const sheet = (p0, p1, p2, p3, n, v0, v1) => flatQuad(m, p0, p1, p2, p3, n, [uvx(p0[0]), v0], [uvx(p1[0]), v0], [uvx(p2[0]), v1], [uvx(p3[0]), v1]);
  // front lip: outside and inside faces; back wall: inside (facing the tray) and outside (facing the frame)
  sheet([x0, Y0, z1], [x1, Y0, z1], [x1, Y1, z1], [x0, Y1, z1], [0, 0, 1], 0, 1);
  sheet([x0, Y0, z1 - T], [x1, Y0, z1 - T], [x1, F, z1 - T], [x0, F, z1 - T], [0, 0, -1], 0, 0.9);
  sheet([x0, Y0, z0 + T], [x1, Y0, z0 + T], [x1, F, z0 + T], [x0, F, z0 + T], [0, 0, 1], 0.3, 1.2);
  sheet([x0, Y0, z0], [x1, Y0, z0], [x1, Y1, z0], [x0, Y1, z0], [0, 0, -1], 0, 1);
  // floor: top and underside; end caps
  sheet([x0, F, z0], [x1, F, z0], [x1, F, z1], [x0, F, z1], [0, 1, 0], 0, 0.6);
  sheet([x0, Y1, z0], [x1, Y1, z0], [x1, Y1, z1], [x0, Y1, z1], [0, -1, 0], 0, 0.6);
  for (const [x, nx] of [[x0, -1], [x1, 1]]) flatQuad(m, [x, Y0, z1], [x, Y0, z0], [x, Y1, z0], [x, Y1, z1], [nx, 0, 0], [0, 0], [0.6, 0], [0.6, 1], [0, 1]);
  m.setMat(0.3, 1, 0, 0);                          // polished rolled edges along the lip and the back wall
  rod(m, [[x0, Y0, z1 - 0.6], [x1, Y0, z1 - 0.6]], 2.4, 12, false);
  rod(m, [[x0, Y0, z0 + 0.6], [x1, Y0, z0 + 0.6]], 1.8, 10, false);
  m.setMat(1.4, 0.55, 0, 0);
  // inside: a darker felt lining so marbles land softly (and read against it)
  const felt = MB('misc');
  felt.setCol(0.09, 0.1, 0.13, 1); felt.setMat(1, 0, 0, 0);
  flatQuad(felt, [x0 + 1, F + 0.2, z0 + T + 0.3], [x1 - 1, F + 0.2, z0 + T + 0.3], [x1 - 1, F + 0.2, z1 - T - 0.3], [x0 + 1, F + 0.2, z1 - T - 0.3], [0, 1, 0], [0, 0], [1, 0], [1, 1], [0, 1]);
  // galvanised L-brackets from the wall: an arm under the floor, a leg up the wall behind the frame
  const br = MB('metal');
  br.setCol(0.55, 0.56, 0.58, 1); br.setMat(1.8, 1, 0, 0);
  const xs = BOARD_W >= 1400 ? [110, BOARD_W / 2, BOARD_W - 110] : [110, BOARD_W - 110];
  for (const x of xs) {
    boxMesh(br, [x - 6, Y1 - 8, WALL_Z + 0.5], [x + 6, Y1 + 0.4, z1 - 9], 32);
    boxMesh(br, [x - 6, Y1 - 8, WALL_Z + 0.5], [x + 6, -(BOARD_H + 12), WALL_Z + 7], 32);
    rod(br, [[x, Y1 - 7, z1 - 14], [x, -(BOARD_H + 40), WALL_Z + 6]], 2.2, 8, false);   // a diagonal brace
  }
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

/* ---- The room: a painted block wall behind the board, block side walls, a plaster ceiling with fluorescent strips
 *  and a butcher-block desk (grids of strips, so every corner gets a soft occlusion gradient). The wall's texture
 *  tiles (WALL_TEX: 10 x 10 blocks); a gentle large-scale tone in the vertex colours keeps its repeats from showing
 *  on a tall tower. The side walls, the ceiling, its strips and the desk are ONE-SIDED (flag 6 / 7): a camera that
 *  orbits out past one of them (the whole tower framed and tilted to a limit) looks through it instead of at a blank
 *  face; the back wall and the desk run on far beyond them (the wall above the ceiling and below the desk down to a
 *  floor line too), so what shows through is more wall and desk, never the void. ---- */
function buildRoom(rnd) {
  const wall = MB('wall'); wall.setMat(1, 0, 0, 0);
  const { uw, uh } = WALL_TEX, R = roomExtent(), nz = makeNoise2(4242, 64);
  const Z1 = R.z1, top = R.top, X0 = R.x0 - R.beyond, X1 = R.x1 + R.beyond;
  const tone = (x, y) => 1 + (nz(x / 1300, y / 1300, 64) - 0.5) * 0.07;
  const wcol = (k, t) => [(0.94 + 0.06 * k) * t, (0.94 + 0.06 * k) * t, (0.95 + 0.05 * k) * t, k];
  // strips [position, occlusion]: seq = evenly from a up to (not including) b; corner = the gradient into a corner at c
  const seq = (o, a, b, step) => { const n = Math.max(1, Math.ceil((b - a) / step)); for (let i = 0; i < n; i++) o.push([a + (b - a) * i / n, 1]); return o; };
  const corner = (o, c) => o.push([c - 150, 0.97], [c - 40, 0.9], [c, 0.72], [c + 40, 0.88], [c + 150, 0.97]);
  // rows (board y, down): from above the ceiling, its corner, down to the desk's corner, on to the floor line
  const wy = seq([], R.wallTop, top - 150, 700);
  corner(wy, top);
  seq(wy, top + 400, DESK_Y - 160, 600);
  wy.push([DESK_Y - 160, 1], [DESK_Y - 70, 0.9], [DESK_Y - 25, 0.72], [DESK_Y, 0.5], [DESK_Y + 25, 0.72], [DESK_Y + 70, 0.9], [DESK_Y + 160, 1]);
  seq(wy, DESK_Y + 500, R.floor, 700);
  wy.push([R.floor, 1]);
  // columns (x): far beyond the left side wall, its corner, across the room, the right corner, far beyond
  const wx = seq([], X0, R.x0 - 150, 800);
  corner(wx, R.x0);
  seq(wx, R.x0 + 400, R.x1 - 150, 700);
  corner(wx, R.x1);
  seq(wx, R.x1 + 400, X1, 800);
  wx.push([X1, 1]);
  surfaceGrid(wall, wy.length, wx.length, (i, j) => [wx[j][0], -wy[i][0], WALL_Z], (i, j) => [wx[j][0] / uw, wy[i][0] / uh], () => [0, 0, 1],
    { forceRef: true, col: (i, j) => wcol(wy[i][1] * wx[j][1], tone(wx[j][0], wy[i][0])) });
  // side walls (one-sided): columns from the back corner out to the front of the room, rows from the ceiling down
  const wz = [[WALL_Z, 0.55], [WALL_Z + 30, 0.78], [WALL_Z + 120, 0.93], [WALL_Z + 400, 1]];
  for (let z = WALL_Z + 1100; z < Z1; z += 700) wz.push([z, 1]);
  wz.push([Z1, 1]);
  const sy = wy.filter(([y]) => y >= top);
  wall.setMat(1, 0, 0, 6);
  for (const [X, nx] of [[R.x0, 1], [R.x1, -1]]) {
    surfaceGrid(wall, sy.length, wz.length, (i, j) => [X, -sy[i][0], wz[j][0]], (i, j) => [wz[j][0] / uw + nx * 0.37, sy[i][0] / uh], () => [nx, 0, 0],
      { forceRef: true, col: (i, j) => wcol(sy[i][1] * wz[j][1], tone(wz[j][0] + nx * 4000, sy[i][0])) });
  }
  // the ceiling (one-sided): painted plaster (the wall texture's own mottle, magnified inside one block's face),
  // darker into its corners; the sun and the marbles do not reach it (no shadows: it is not a caster)
  const cz = [[WALL_Z, 0.6], [WALL_Z + 40, 0.8], [WALL_Z + 180, 0.94], [WALL_Z + 700, 1], [Z1, 1]];
  const cx = [[R.x0, 0.6], [R.x0 + 40, 0.8], [R.x0 + 180, 0.94], [R.x0 + 700, 1], [R.x1 - 700, 1], [R.x1 - 180, 0.94], [R.x1 - 40, 0.8], [R.x1, 0.6]];
  surfaceGrid(wall, cz.length, cx.length, (i, j) => [cx[j][0], -top, cz[i][0]],
    (i, j) => [0.014 + 0.07 * (cx[j][0] - R.x0) / (R.x1 - R.x0), 0.014 + 0.066 * (cz[i][0] - WALL_Z) / (Z1 - WALL_Z)], () => [0, -1, 0],
    { forceRef: true, col: (i, j) => { const k = cz[i][1] * cx[j][1]; return [0.9 * k + 0.02, 0.89 * k + 0.02, 0.87 * k + 0.02, k]; } });
  // fluorescent strips along the ceiling (emissive, one-sided: seen from below only)
  wall.setCol(1, 0.97, 0.9, 1); wall.setMat(1, 0, 0, 7);
  const gap = Math.max(3000, Z1 / 6), sx0 = R.x0 + (R.x1 - R.x0) * 0.08, sx1 = R.x1 - (R.x1 - R.x0) * 0.08;
  for (let z = 1300; z < Z1 * 0.8; z += gap) boxMesh(wall, [sx0, -top - 12, z - 32], [sx1, -top - 1, z + 32], 64);
  wall.setCol(1, 1, 1, 1); wall.setMat(1, 0, 0, 0);
  // the desk (one-sided): from the wall's corner on past the camera, far beyond the side walls, with the occlusion
  // gradient of the side walls' corners; a camera dipping under it looks through it at the wall going on down
  const desk = MB('desk'); desk.setMat(1, 0, 0, 6);
  // (it ends at DESK_EDGE: a real desk top with a front edge, legs and a floor under it, not a plane to the horizon)
  const dz = [[WALL_Z, 0.5], [WALL_Z + 18, 0.72], [WALL_Z + 55, 0.9], [WALL_Z + 140, 1], [DESK_EDGE, 1]];
  const dx = [[X0, 1], [R.x0 - 40, 1], [R.x0, 0.6], [R.x0 + 40, 0.8], [R.x0 + 200, 0.95], [R.x0 + 600, 1], [R.x1 - 600, 1], [R.x1 - 200, 0.95], [R.x1 - 40, 0.8], [R.x1, 0.6], [R.x1 + 40, 1], [X1, 1]];
  surfaceGrid(desk, dz.length, dx.length, (i, j) => [dx[j][0], -DESK_Y, dz[i][0]], (i, j) => [dx[j][0] / 1024, dz[i][0] / 1024], () => [0, 1, 0],
    { forceRef: true, col: (i, j) => { const k = dz[i][1] * dx[j][1]; return [0.9 + 0.1 * k, 0.9 + 0.1 * k, 0.9 + 0.1 * k, k]; } });
  buildDeskKit(desk, R, X0, X1);
  desk.setMat(1, 0, 0, 0);
  buildPendant(wall, R);
}

/* ---- Under and on the desk: a 70-unit front edge (the slab's thickness), legs, a floor, and a few things that give the
 *  tower a size (1 unit is about 1 mm: the desk is 760 high, the pencil pot 95). The floor is the desk's wood in a
 *  grey tint, one-sided like the desk (a camera below it sees through to the wall going on down). ---- */
const DESK_EDGE = 1800, DESK_LEG = 760;
function buildDeskKit(desk, R, X0, X1) {
  const top = -DESK_Y, fl = top - DESK_LEG;
  desk.setCol(0.8, 0.8, 0.8, 1); desk.setMat(1, 0, 0, 6);
  flatQuad(desk, [X0, top - 70, DESK_EDGE], [X1, top - 70, DESK_EDGE], [X1, top, DESK_EDGE], [X0, top, DESK_EDGE], [0, 0, 1], [X0 / 1024, 0], [X1 / 1024, 0], [X1 / 1024, 0.07], [X0 / 1024, 0.07]);
  desk.setMat(1, 0, 0, 0); desk.setCol(0.62, 0.6, 0.57, 1);
  for (let x = X0 + 400; x < X1; x += 2400) boxMesh(desk, [x - 40, fl, DESK_EDGE - 120], [x + 40, top - 70, DESK_EDGE - 40], 96);
  // the floor: grey boards, darker towards the wall
  desk.setMat(1, 0, 0, 6);
  const fz = [[WALL_Z, 0.5], [WALL_Z + 30, 0.7], [WALL_Z + 150, 0.9], [WALL_Z + 600, 1], [R.z1, 1]];
  surfaceGrid(desk, fz.length, 2, (i, j) => [j ? X1 : X0, fl, fz[i][0]], (i, j) => [(j ? X1 : X0) / 1024, fz[i][0] / 1024], () => [0, 1, 0],
    { forceRef: true, col: (i) => { const k = fz[i][1]; return [0.5 * k, 0.5 * k, 0.52 * k, k]; } });
  desk.setMat(1, 0, 0, 0); desk.setCol(1, 1, 1, 1);
  // a steel pencil pot with pencils on one side of the tray, a jar of marbles on the other (lathed at the origin, moved)
  const m = MB('metal'), jarR = 52, potR = 36, potH = 95, jarX = -210, potX = BOARD_W + 210;
  const lathe = (cx, cz, rows) => { markStart(m); latheY(m, rows, 0, Math.PI * 2, 30, false, 64, cz); translateLast(m, cx, 0); };
  put(m, [0.7, 0.71, 0.74], FIN.steel);
  lathe(potX, 150, [[DESK_Y, potR - 2], [DESK_Y - 0.5, potR], [DESK_Y - potH + 2, potR], [DESK_Y - potH, potR - 1.5]]);
  const pen = ['#e8453c', '#f2d23a', '#3f7fd6', '#57b347', '#f39a2b'];
  pen.forEach((hex, k) => {
    const a = k / pen.length * Math.PI * 2, tx = Math.cos(a) * 30, tz = Math.sin(a) * 30;
    rod(put(m, lin(hex), FIN.satin), [[potX + tx * 0.3, top + 25, 150 + tz * 0.3], [potX + tx, top + potH + 55 + (k % 3) * 10, 150 + tz]], 3.6, 6, true);
  });
  put(m, [0.03, 0.03, 0.035], [2.5, 0]);
  lathe(potX, 150, [[DESK_Y - potH + 1.5, potR - 1.5], [DESK_Y - potH + 1.5, 0.5]]);
  // the jar: dark glass-green, a brass lid
  put(m, [0.18, 0.34, 0.3], [0.5, 0]);
  lathe(jarX, 190, [[DESK_Y, jarR - 4], [DESK_Y - 4, jarR], [DESK_Y - 92, jarR], [DESK_Y - 100, jarR - 6], [DESK_Y - 104, jarR - 14]]);
  put(m, BRASS, FIN.brass);
  lathe(jarX, 190, [[DESK_Y - 104, jarR - 13], [DESK_Y - 111, jarR - 13], [DESK_Y - 115, jarR - 17]]);
  lathe(jarX, 190, [[DESK_Y - 115, jarR - 17], [DESK_Y - 115.1, 0.5]]);
  m.setCol(1, 1, 1, 1); m.setMat(1, 0, 0, 0);
}
/* ---- A light you can see from the tower: a fluorescent light bar on the wall just above the top of the board (the way a
 *  picture light sits over a board), emissive so it blooms, so the sunlight and the blooming strips have a source in
 *  sight wherever the camera is near the top of the tower (the ceiling is 16000 units up and the window 5000 away: out
 *  of reach within the camera's limits). Its housing is window-frame material, which casts no shadow, and it stands behind the
 *  board's plane, so it neither shades nor hides the board from any angle. ---- */
function buildPendant(wall, R) {
  void R;
  const w = Math.max(900, BOARD_W * 1.15), cx = BOARD_W / 2, y0 = 130, z0 = WALL_Z + 1, z1 = WALL_Z + 38;
  const hs = MB('window');                                                                  // (the window frame's material: no mortar pattern, no shadow)
  hs.setCol(0.16, 0.16, 0.17, 1); hs.setMat(1, 0, 0, 0);
  boxMesh(hs, [cx - w / 2, y0, z0], [cx + w / 2, y0 + 50, z1], 64);                         // the steel housing
  hs.setCol(1, 1, 1, 1);
  wall.setCol(1, 0.97, 0.9, 1); wall.setMat(1, 0, 0, 7);
  flatQuad(wall, [cx - w / 2 + 8, y0 + 6, z1 + 0.6], [cx + w / 2 - 8, y0 + 6, z1 + 0.6], [cx + w / 2 - 8, y0 + 44, z1 + 0.6], [cx - w / 2 + 8, y0 + 44, z1 + 0.6], [0, 0, 1], [0, 0], [1, 0], [1, 1], [0, 1]);   // the diffuser
  wall.setCol(1, 1, 1, 1); wall.setMat(1, 0, 0, 0);
}

/* ---- The window the sun comes through: on the left side wall where the beam through the middle of the board meets
 *  it (roomExtent().win), so the lit patch on the board, the mullion's shadow across it and the bright rectangle in
 *  the reflections all come from the same place. A painted frame standing proud of the wall, the upright mullion
 *  where the shadow bar falls, transoms, and panes of daylight (emissive, they bloom). One-sided with the wall it is
 *  on: clipped when the eye is beyond that wall (clip normal +x: material slot z = 1, see VS_PBR). ---- */
function buildWindow() {
  const R = roomExtent(), W = R.win, x = R.x0 + 0.5, hw = W.w / 2, hh = W.h / 2, yc = W.y, zc = W.z;
  const F = 120, D = 48, B = 30;                            // frame width, its depth off the wall, glazing bar width
  // (its own material key, drawn with the 'misc' textures: bindMat falls back to them. It is NOT a shadow caster: the
  //  frame stands thousands of units in front of the wall at a zoomed-out view and, inside cascade 1's range, painted
  //  hard black bars across the wall and desk that disagree with the analytic window cookie (windowCookie), which
  //  already puts the window's own shadow, mullion included, on the board and the room; see isRoomCaster)
  const paint = MB('window'); paint.setCol(0.93, 0.92, 0.9, 1); paint.setMat(1.15, 0, 1, 6);
  const box = (y0, z0, y1, z1, d = D) => boxMesh(paint, [x, y0, z0], [x + d, y1, z1], 128);
  box(yc - hh - F, zc - hw - F, yc + hh + F, zc - hw);      // jambs
  box(yc - hh - F, zc + hw, yc + hh + F, zc + hw + F);
  box(yc + hh, zc - hw, yc + hh + F, zc + hw);              // head
  box(yc - hh - F - 40, zc - hw - F - 70, yc - hh, zc + hw + F + 70, D + 60);   // the sill, deeper
  box(yc - hh, zc + W.mullionZ - B / 2, yc + hh, zc + W.mullionZ + B / 2, D * 0.7);   // the upright mullion (its shadow crosses the board)
  const nT = Math.max(1, Math.round(W.h / 1500));
  for (let k = 1; k < nT; k++) { const y = yc - hh + W.h * k / nT; box(y - B / 2, zc - hw, y + B / 2, zc + hw, D * 0.7); }
  paint.setCol(1, 1, 1, 1); paint.setMat(1, 0, 0, 0);
  const glass = MB('wall'); glass.setCol(0.8, 0.9, 1.0, 1); glass.setMat(1, 0, 1, 7);
  flatQuad(glass, [x + 1, yc - hh, zc - hw], [x + 1, yc - hh, zc + hw], [x + 1, yc + hh, zc + hw], [x + 1, yc + hh, zc - hw], [1, 0, 0], [0, 0], [1, 0], [1, 1], [0, 1]);
  glass.setCol(1, 1, 1, 1); glass.setMat(1, 0, 0, 0);
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
