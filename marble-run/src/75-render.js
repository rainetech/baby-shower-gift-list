
/* ============================================================================
 *  RENDERING (WebGL2): the renderer (engine reused from the cardboard run)
 *  Passes: two soft shadow cascades (board, room) -> PBR opaque scene (room
 *  meshes + the pieces, instanced: one draw per shared piece mesh) -> glass
 *  marbles (instanced, any number) that refract a copy of the scene -> bloom
 *  -> filmic grade. Frames are only drawn when something visible changes;
 *  software GL (no GPU) draws animated frames about once a second. The 2D overlay (path preview, selection, labels) is
 *  drawn on its own canvas every frame (see OVERLAY).
 * ========================================================================== */
const DEV = /[?&]dev\b/.test(location.search);
const GLR = {
  gl: null, ok: false, ready: false, abandoned: false, canvas: null, fx: null, fxg: null,
  progs: {}, mats: {}, meshes: [], env: null,
  cam: { view: null, proj: null, vp: null, inv: null, eye: [0, 0, 0] },
  shadow: [], scale: 1, software: false, mobile: false, lite: false, float: true,
  samples: 0, maxSamples: 0, msaa: true, taps: 18, tapsMax: 18, bloomLevels: 5,
  targets: null, targetsKey: '', buildToken: 0, layoutEpoch: 0, timings: {},
  lastSig: null, shadowKey: null, frames: 0,
};
const NO_DBG = Object.freeze({});
const devQuality = () => (DEV && window.__mmQuality) || NO_DBG;

function initGL(canvas) {
  let gl = null;
  try {
    gl = canvas.getContext('webgl2', { antialias: false, alpha: false, depth: false, stencil: false, premultipliedAlpha: false, powerPreference: 'high-performance', desynchronized: false });
  } catch (e) { gl = null; }
  if (!gl || gl.isContextLost()) return false;
  GLR.gl = gl;
  let rname = String(gl.getParameter(gl.RENDERER) || '');
  if (!rname || /^(webkit webgl|mozilla|generic renderer)$/i.test(rname.trim())) {
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    if (dbg) rname = String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || rname);
  }
  GLR.software = /swiftshader|llvmpipe|softpipe|software|basic render/i.test(rname);
  GLR.rendererName = rname;
  GLR.float = !!(gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float'));
  gl.getExtension('OES_texture_float_linear');
  const ua = navigator.userAgent || '';
  GLR.mobile = /Android|iPhone|iPad|Mobile/i.test(ua) || (navigator.maxTouchPoints > 0 && /Macintosh/.test(ua)) || Math.min(screen.width, screen.height) < 600;
  GLR.lite = GLR.mobile || GLR.software;
  const Q = devQuality();
  GLR.shadowSize = GLR.software ? 2048 : GLR.mobile ? 2048 : Math.min(4096, gl.getParameter(gl.MAX_TEXTURE_SIZE) || 2048);
  GLR.aniso = Q.aniso !== undefined ? Q.aniso : GLR.lite ? 4 : 8;
  GLR.bloomLevels = GLR.lite ? 3 : 5;
  GLR.tapsMax = GLR.taps = GLR.lite ? 8 : 16;
  GLR.maxSamples = GLR.software ? 0 : formatSamples(gl);
  if (Q.samples !== undefined) GLR.maxSamples = Q.samples;
  // marbles casting soft shadows at once: as many as the fragment uniform budget allows (2 vec4 each; the rest of
  // the lit shader needs about 60), 24 .. 96
  GLR.marbleShadows = clamp(Math.floor(((gl.getParameter(gl.MAX_FRAGMENT_UNIFORM_VECTORS) || 224) - 64) / 2), 24, 96);
  MARBLE_DATA = new Float32Array(GLR.marbleShadows * 4);
  MARBLE_COL = new Float32Array(GLR.marbleShadows * 4);
  if (!compilePrograms()) return false;
  GLR.sphere = buildSphereMesh(gl);
  INST.tex = null; INST.rows = 0;
  GLR.quadVao = gl.createVertexArray();
  GLR.shadow = [glShadowTarget(gl, GLR.shadowSize), glShadowTarget(gl, GLR.shadowSize)];
  GLR.cmpSampler = gl.createSampler();
  gl.samplerParameteri(GLR.cmpSampler, gl.TEXTURE_COMPARE_MODE, gl.COMPARE_REF_TO_TEXTURE);
  gl.samplerParameteri(GLR.cmpSampler, gl.TEXTURE_COMPARE_FUNC, gl.LEQUAL);
  gl.samplerParameteri(GLR.cmpSampler, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.samplerParameteri(GLR.cmpSampler, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.samplerParameteri(GLR.cmpSampler, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.samplerParameteri(GLR.cmpSampler, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  PM.cache.clear(); PM.gate = null; PM.live = null; INST.pool.clear();
  GLR.ok = true;
  GLR.ready = false;
  return true;
}
function formatSamples(gl) {
  let s = Math.min(4, gl.getParameter(gl.MAX_SAMPLES) || 0);
  try {
    const f = gl.getInternalformatParameter(gl.RENDERBUFFER, GLR.float ? gl.RGBA16F : gl.RGBA8, gl.SAMPLES);
    s = f && f.length ? Math.min(s, f[0]) : 0;
  } catch (e) { s = 0; }
  return s > 1 ? s : 0;
}
function compilePrograms() {
  const gl = GLR.gl, Q = devQuality();
  const defs = `#define BLOCKER_SAMPLES ${Q.bs || (GLR.lite ? 5 : 10)}\n#define PCF_SAMPLES ${Q.pcf || (GLR.lite ? 12 : 16)}\n#define MARBLE_SHADOWS ${GLR.marbleShadows}\n`
    + (GLR.float ? '' : '#define LDR_TARGET\n') + (DEV ? '#define DEBUG\n' : '');
  const t0 = performance.now();
  const P = {
    pbr: glProgram(gl, 'pbr', VS_PBR, FS_PBR, defs),
    depth: glProgram(gl, 'depth', VS_PBR, FS_DEPTH, defs),
    marble: glProgram(gl, 'marble', VS_MARBLE, FS_MARBLE, defs),
    down: glProgram(gl, 'down', VS_QUAD, FS_DOWN, defs),
    up: glProgram(gl, 'up', VS_QUAD, FS_UP, defs),
    final: glProgram(gl, 'final', VS_QUAD, FS_FINAL, defs),
  };
  for (const k in P) if (!P[k]) return false;
  for (const k in GLR.progs) if (GLR.progs[k] && GLR.progs[k].gl === gl) gl.deleteProgram(GLR.progs[k].p);
  for (const k in P) P[k].gl = gl;
  GLR.progs = P;
  GLR.timings.programs = Math.round(performance.now() - t0);
  return true;
}

/* ---- Start-up: paint the textures, build the room; in small chunks after the first paint ---- */
const nextTask = () => new Promise((r) => setTimeout(r, 0));
async function buildGLAssets(onProgress) {
  const token = ++GLR.buildToken, gl = GLR.gl;
  const alive = () => token === GLR.buildToken && !gl.isContextLost() && !GLR.abandoned;
  GLR.ready = false;
  const T = GLR.timings;
  const run = async (label, f) => {
    const t0 = performance.now();
    const r = f();
    if (r && typeof r.next === 'function') {
      for (let s = r.next(); !s.done; s = r.next()) { await nextTask(); if (!alive()) return false; }
    }
    T[label] = Math.round((T[label] || 0) + performance.now() - t0);
    await nextTask();
    return alive();
  };
  const gens = [['peg', genPegboardTextures], ['metal', genMetalTextures], ['letters', genLetterTextures], ['wood', genWoodTextures],
    ['tape', genTapeTextures], ['misc', genMiscTextures], ['wall', genWallTextures], ['desk', genDeskTextures], ['note', genNoteTextures]];
  const mats = { peg: ['peg', { bias: -0.2 }], metal: ['metal'], letters: ['letters', { repeat: false }], wood: ['wood'], tape: ['tape'], misc: ['misc'],
    wall: ['wall', { repeat: false, bias: 0.4 }], desk: ['desk', { bias: 0 }], note: ['note', { repeat: false }] };
  const total = gens.length + 3;
  let done = 0;
  const step = () => { done++; if (onProgress) onProgress(Math.min(1, done / total)); };
  GLR.mats = {};
  for (const [label, f] of gens) {
    if (!(await run(label, f))) return false;
    if (!(await run('upload', () => {
      const [name, o = {}] = mats[label];
      const alb = TEX[name + 'Alb'], surf = TEX[name + 'Surf'];
      GLR.mats[name] = {
        alb: glTexture(gl, alb, { srgb: true, repeat: o.repeat !== false, aniso: GLR.aniso }),
        surf: glTexture(gl, surf, { srgb: false, repeat: o.repeat !== false, aniso: GLR.aniso }),
        lodBias: o.bias || 0, nscale: o.nscale || 1,
      };
      for (const c of [alb, surf]) if (c && c.getContext) { c.width = 0; c.height = 0; }
      delete TEX[name + 'Alb']; delete TEX[name + 'Surf'];
    }))) return false;
    step();
  }
  const envOut = {};
  if (!(await run('env', () => genEnvironment(gl, envOut)))) return false;
  GLR.env = envOut.env;
  step();
  SCENE.builders = {};
  if (!(await run('scene', buildScene))) return false;
  step();
  const meshes = [];
  if (!(await run('meshes', () => {
    for (const mat of Object.keys(SCENE.builders)) {
      const mesh = glMesh(gl, SCENE.builders[mat]);
      if (mesh) meshes.push({ mat, mesh });
    }
  }))) return false;
  SCENE.builders = {};
  GLR.meshes = meshes;
  freeTexCanvases();
  step();
  GLR.ready = true;
  GLR.dirty = true;
  GLR.lastSig = GLR.shadowKey = null;
  return true;
}

// Unit sphere, instanced per marble (the instance buffer grows with the number of marbles: see marbleSlots)
function buildSphereMesh(gl) {
  const pos = [], idx = [], R = 20, C = 32;
  for (let i = 0; i <= R; i++) for (let j = 0; j <= C; j++) {
    const th = (i / R) * Math.PI, ph = (j / C) * Math.PI * 2;
    pos.push(Math.sin(th) * Math.cos(ph), Math.cos(th), Math.sin(th) * Math.sin(ph));
  }
  for (let i = 0; i < R; i++) for (let j = 0; j < C; j++) { const a = i * (C + 1) + j, b = a + C + 1; idx.push(a, b, a + 1, a + 1, b, b + 1); }
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const vb = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vb);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(pos), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(ATTR.pos);
  gl.vertexAttribPointer(ATTR.pos, 3, gl.FLOAT, false, 12, 0);
  const inst = gl.createBuffer(), cap = 64;
  gl.bindBuffer(gl.ARRAY_BUFFER, inst);
  gl.bufferData(gl.ARRAY_BUFFER, cap * 16 * 4, gl.DYNAMIC_DRAW);
  [ATTR.iPos, ATTR.iRot, ATTR.iGlass, ATTR.iSwirl].forEach((loc, k) => {
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 4, gl.FLOAT, false, 64, k * 16);
    gl.vertexAttribDivisor(loc, 1);
  });
  const ib = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(idx), gl.STATIC_DRAW);
  gl.bindVertexArray(null);
  return { vao, inst, count: idx.length, cap, data: new Float32Array(cap * 16) };
}
// Room for n marble instances (doubling), so every marble on the board is drawn
function marbleSlots(n) {
  const S = GLR.sphere;
  if (n <= S.cap) return;
  while (S.cap < n) S.cap *= 2;
  S.data = new Float32Array(S.cap * 16);
  const gl = GLR.gl;
  gl.bindBuffer(gl.ARRAY_BUFFER, S.inst);
  gl.bufferData(gl.ARRAY_BUFFER, S.cap * 16 * 4, gl.DYNAMIC_DRAW);
}

/* ---- Offscreen targets (MSAA scene + resolve copy, or a plain texture + half-size refraction copy) ---- */
const TARGET_CACHE = new Map();
function freeTargets(t) {
  const gl = GLR.gl;
  gl.deleteFramebuffer(t.main); gl.deleteRenderbuffer(t.depth);
  if (t.color) gl.deleteRenderbuffer(t.color);
  if (t.colorTex) gl.deleteTexture(t.colorTex);
  for (const c of [t.copy, t.refr, ...t.bloom]) if (c) { gl.deleteFramebuffer(c.fb); gl.deleteTexture(c.tex); }
}
function freeAllTargets() {
  if (GLR.gl && !GLR.gl.isContextLost()) for (const t of TARGET_CACHE.values()) freeTargets(t);
  TARGET_CACHE.clear();
  GLR.targets = null;
}
function glTargets(w, h) {
  const key = w + 'x' + h;
  let t = TARGET_CACHE.get(key);
  if (!t) { t = makeTargets(w, h); if (t) TARGET_CACHE.set(key, t); }
  return t;
}
function makeTargets(w, h) {
  const gl = GLR.gl, fmt = GLR.float ? gl.RGBA16F : gl.RGBA8, samples = GLR.samples;
  const t = { w, h, samples, bloom: [], color: null, colorTex: null, copy: null, refr: null };
  t.main = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, t.main);
  if (samples > 1) {
    t.color = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, t.color);
    gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, fmt, w, h);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, t.color);
  } else {
    t.colorTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t.colorTex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, fmt, w, h);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t.colorTex, 0);
  }
  t.depth = gl.createRenderbuffer();
  gl.bindRenderbuffer(gl.RENDERBUFFER, t.depth);
  if (samples > 1) gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.DEPTH_COMPONENT24, w, h);
  else gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);
  gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, t.depth);
  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    freeTargets(t);
    if (samples > 1) { GLR.maxSamples = GLR.samples = 0; return makeTargets(w, h); }
    return null;
  }
  if (samples > 1) t.copy = glColorTarget(gl, w, h, fmt);
  else t.refr = glColorTarget(gl, Math.max(1, w >> 1), Math.max(1, h >> 1), fmt);
  let ok = !!(t.copy || t.refr), bw = w, bh = h;
  for (let i = 0; ok && i < GLR.bloomLevels; i++) {
    bw = Math.max(1, bw >> 1); bh = Math.max(1, bh >> 1);
    const b = glColorTarget(gl, bw, bh, fmt);
    if (b) t.bloom.push(b); else ok = false;
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  if (!ok) { freeTargets(t); return null; }
  t.sceneTex = samples > 1 ? t.copy.tex : t.colorTex;
  t.refrTex = samples > 1 ? t.copy.tex : t.refr.tex;
  return t;
}
function ensureTargets(w, h) {
  let t = glTargets(w, h);
  if (!t && GLR.float) {
    console.warn('Float render targets are not supported here: using 8-bit targets.');
    freeAllTargets();
    GLR.float = false;
    GLR.maxSamples = GLR.samples = Math.min(GLR.samples, formatSamples(GLR.gl));
    if (!compilePrograms()) return null;
    t = glTargets(w, h);
  }
  return t;
}
function resizeCanvases() {
  const c = GLR.canvas, s = GLR.software ? 1 : GLR.scale;
  const cw = Math.max(1, Math.round(view.w * view.dpr)), ch = Math.max(1, Math.round(view.h * view.dpr));
  if (c.width !== cw || c.height !== ch) { c.width = cw; c.height = ch; }
  GLR.rw = Math.max(1, Math.round(cw * s));
  GLR.rh = Math.max(1, Math.round(ch * s));
  // MSAA within a memory budget (128 MB of multisampled target on a desktop, 64 MB on a tablet), stepping 4x -> 2x -> 0;
  // phones at DPR 2+ use the (gated) FXAA
  let samples = GLR.msaa ? GLR.maxSamples : 0;
  if (GLR.mobile && view.dpr >= 2) samples = 0;
  const budget = (GLR.mobile ? 64 : 128) * 1048576;
  while (samples > 1 && GLR.rw * GLR.rh * samples * 12 > budget) samples >>= 1;
  if (samples < 2) samples = 0;
  const key = cw + 'x' + ch + ':' + samples;
  if (key !== GLR.targetsKey) { freeAllTargets(); GLR.targetsKey = key; }
  GLR.samples = samples;
  GLR.lastSig = null;
  if (!GLR.gl || GLR.gl.isContextLost()) { GLR.targets = null; return; }
  GLR.targets = ensureTargets(GLR.rw, GLR.rh);
  if (!GLR.targets && !GLR.gl.isContextLost()) {
    GLR.ok = false;
    setTimeout(() => fallbackTo2D('no usable render targets'), 0);
  }
}

/* ============================================================================
 *  CAMERA: frames the whole board (and its trough) in the screen area the HUD
 *  leaves free, from slightly above and to the right. The user can pan and zoom
 *  on top of that fit (VIEWCAM.zoom / pan in board units); "Fit" resets them.
 *  A lens shift keeps the camera level while the board sits off-centre.
 * ========================================================================== */
const view = { w: 0, h: 0, dpr: 1 };
const VIEWCAM = { zoom: 1, panX: 0, panY: 0, version: 0, anim: null };
const CAMERA = { pitch: 0.1, yaw: 0.07, fovDiag: 34 * Math.PI / 180 };
const FIT_BOX = { x0: -FRAME_W - 18, x1: BOARD_W + FRAME_W + 18, y0: -FRAME_W - 18, y1: TROUGH.y1 + 8, z0: 0, z1: 30 };
function fitCamera(w, h, safe) {
  const aspect = w / h, diag = Math.hypot(w, h);
  const fovY = 2 * Math.atan(Math.tan(CAMERA.fovDiag / 2) * h / diag);
  const dir = [Math.sin(CAMERA.yaw) * Math.cos(CAMERA.pitch), Math.sin(CAMERA.pitch), Math.cos(CAMERA.yaw) * Math.cos(CAMERA.pitch)];
  const B = FIT_BOX, target = [(B.x0 + B.x1) / 2, -(B.y0 + B.y1) / 2, 10];
  const pts = [];
  for (const x of [B.x0, B.x1]) for (const y of [B.y0, B.y1]) for (const z of [B.z0, B.z1]) pts.push([x, -y, z]);
  const build = (D, sx, sy, tg = target) => {
    const eye = V3.add(tg, V3.scale(dir, D));
    const viewM = M4.lookAt(eye, tg, [0, 1, 0]);
    const proj = M4.persp(fovY, aspect, Math.max(20, D * 0.2), D * 4 + 6000, sx, sy);
    return { eye, viewM, proj, vp: M4.mul(proj, viewM) };
  };
  const bbox = (vp) => {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const p of pts) { const q = M4.xform(vp, p); const x = q[0] / q[3], y = q[1] / q[3]; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    return { x0, x1, y0, y1 };
  };
  const availW = Math.max(40, safe.r - safe.l) / w * 2, availH = Math.max(40, safe.b - safe.t) / h * 2;
  let D = 3000;
  for (let it = 0; it < 8; it++) {
    const b = bbox(build(D, 0, 0).vp);
    D *= Math.max((b.x1 - b.x0) / availW, (b.y1 - b.y0) / availH);
  }
  const b = bbox(build(D, 0, 0).vp);
  const cx = ((safe.l + safe.r) / 2 / w) * 2 - 1, cy = 1 - ((safe.t + safe.b) / 2 / h) * 2;
  const sx = (b.x0 + b.x1) / 2 - cx, sy = (b.y0 + b.y1) / 2 - cy;   // (persp's lens shift moves the image by -s)
  return { fovY, aspect, D, dir, target, sx, sy, build };
}
// Lays out the 3D view: the fitted camera, then the user's pan and zoom on top
let FIT = null;
function layout3D() {
  view.w = window.innerWidth; view.h = window.innerHeight;
  view.dpr = Math.min(window.devicePixelRatio || 1, 2);
  FIT = fitCamera(view.w, view.h, boardFitRect());
  applyCamera();
  resizeCanvases();
  setupShadowFrusta();
  setupWindowLight();
  GLR.layoutEpoch++;
  GLR.dirty = true;
  GLR.shadowEpoch = (GLR.shadowEpoch || 0) + 1;
}
function applyCamera() {
  if (!FIT) return;
  const z = VIEWCAM.zoom, tg = [FIT.target[0] + VIEWCAM.panX, FIT.target[1] - VIEWCAM.panY, FIT.target[2]];
  const c = FIT.build(FIT.D / z, FIT.sx, FIT.sy, tg);
  GLR.cam = { eye: c.eye, target: tg, view: c.viewM, proj: c.proj, vp: c.vp, inv: M4.invert(c.vp), D: FIT.D / z, fovY: FIT.fovY };
  VIEWCAM.version++;
  GLR.dirty = true;
}
// Project a world point (board x, board y down, z) to CSS pixels: [x, y, w] (a reused array: read it at once)
const PROJ = [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]];
let projI = 0;
function project(x, y, z) {
  const m = GLR.cam.vp, Y = -y;
  const cx = m[0] * x + m[4] * Y + m[8] * z + m[12], cy = m[1] * x + m[5] * Y + m[9] * z + m[13], cw = m[3] * x + m[7] * Y + m[11] * z + m[15];
  const o = PROJ[projI = (projI + 1) & 3];
  o[0] = (cx / cw * 0.5 + 0.5) * view.w; o[1] = (0.5 - cy / cw * 0.5) * view.h; o[2] = cw;
  return o;
}
// CSS pixel -> board point on the plane z (default: the marble plane)
function unproject(px, py, z = ZM) {
  const nx = (px / view.w) * 2 - 1, ny = 1 - (py / view.h) * 2;
  const a = M4.xform(GLR.cam.inv, [nx, ny, -1]), b = M4.xform(GLR.cam.inv, [nx, ny, 1]);
  const p0 = [a[0] / a[3], a[1] / a[3], a[2] / a[3]], p1 = [b[0] / b[3], b[1] / b[3], b[2] / b[3]];
  const t = (z - p0[2]) / (p1[2] - p0[2]);
  return [p0[0] + (p1[0] - p0[0]) * t, -(p0[1] + (p1[1] - p0[1]) * t)];
}
// CSS px per board unit near a board point (for sizing overlay marks)
function pxPerUnit(x = BOARD_W / 2, y = BOARD_H / 2) {
  const a = project(x, y, ZM), ax = a[0], ay = a[1], b = project(x + 100, y, ZM);
  return Math.hypot(b[0] - ax, b[1] - ay) / 100;
}

/* ---- Shadow cascades: 0 = tight on the pegboard, 1 = the whole room in view ---- */
function lightFrustum(center, pts) {
  const eye = V3.add(center, V3.scale(SUN_DIR, 2500));
  const vm = M4.lookAt(eye, center, [0, 1, 0]);
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const p of pts) {
    const q = M4.xform(vm, p);
    x0 = Math.min(x0, q[0]); x1 = Math.max(x1, q[0]); y0 = Math.min(y0, q[1]); y1 = Math.max(y1, q[1]); z0 = Math.min(z0, q[2]); z1 = Math.max(z1, q[2]);
  }
  const ext = Math.max(x1 - x0, y1 - y0), mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
  const near = -z1 - 2400, far = -z0 + 60;
  const proj = M4.ortho(mx - ext / 2, mx + ext / 2, my - ext / 2, my + ext / 2, near, far);
  return { vp: M4.mul(proj, vm), ext, range: far - near };
}
function boxPts(x0, x1, y0, y1, z0, z1) { const o = []; for (const x of [x0, x1]) for (const y of [y0, y1]) for (const z of [z0, z1]) o.push([x, y, z]); return o; }
function setupShadowFrusta() {
  GLR.sf0 = lightFrustum([BOARD_W / 2, -BOARD_H / 2, 0], boxPts(-60, BOARD_W + 60, 60, -TROUGH.y1 - 20, -8, 80));
  GLR.sf1 = lightFrustum([BOARD_W / 2, -BOARD_H / 2, 0], boxPts(-1400, BOARD_W + 1400, 900, -DESK_Y - 10, WALL_Z, 160));
  GLR.shadowMats = [GLR.sf0.vp, GLR.sf1.vp];
}

/* ---- The window the sun comes through: a lit patch over the board with soft edges on the wall ---- */
const WINDOW = { u0: -1250, u1: 1350, v0: -2200, v1: 1200, mullionU: -330, transomV: 1e5, halfBar: 14, tan: 0.012 };
function setupWindowLight() {
  const L = SUN_DIR, U = V3.norm(V3.cross([0, 1, 0], L)), V = V3.cross(L, U), cx = BOARD_W / 2;
  GLR.win = {
    U: new Float32Array([U[0], U[1], U[2], -U[0] * cx]), V: new Float32Array([V[0], V[1], V[2], -V[0] * cx]),
    rect: new Float32Array([WINDOW.u0, WINDOW.v0, WINDOW.u1, WINDOW.v1]),
    bars: new Float32Array([WINDOW.mullionU, WINDOW.transomV, WINDOW.halfBar, WINDOW.tan]),
  };
}

/* ---- Per-frame data (preallocated) ---- */
const SUN_COL = [4.1, 3.8, 3.3];
const LIGHT_TAN = 0.1;
const EXPOSURE = 1.18;
const BOARD_REFL = [0.32, 0.26, 0.19];
let MARBLE_DATA = new Float32Array(0), MARBLE_COL = new Float32Array(0);   // the shadow casters (sized in initGL)
const MARBLE_COLORS = [
  { glass: '#4f9be8', swirl: '#ff7a2e' }, { glass: '#e24a4a', swirl: '#ffe066' }, { glass: '#3fbf7f', swirl: '#ffffff' },
  { glass: '#f2b632', swirl: '#2f6fd6' }, { glass: '#9b6ce0', swirl: '#7cf0c8' }, { glass: '#2bb3c0', swirl: '#ff5d8f' },
  { glass: '#ff8a3d', swirl: '#3b2cc0' },
];
const LOOKS = new Map();
// A marble's look from its id (deterministic): glass tint, swirl colour, base orientation, swirl seed
function marbleLook(id) {
  let L = LOOKS.get(id);
  if (!L) {
    const c = MARBLE_COLORS[(id - 1 + MARBLE_COLORS.length * 8) % MARBLE_COLORS.length], r = mulberry32(id * 7919 + 13);
    const g = lin(c.glass), s = lin(c.swirl), tint = g.map((v) => lerp(v, 1, 0.5));
    const u1 = r(), u2 = r(), u3 = r();
    const q0 = [Math.sqrt(1 - u1) * Math.sin(2 * Math.PI * u2), Math.sqrt(1 - u1) * Math.cos(2 * Math.PI * u2), Math.sqrt(u1) * Math.sin(2 * Math.PI * u3), Math.sqrt(u1) * Math.cos(2 * Math.PI * u3)];
    L = { tint, swirl: s, q0, seed: r() };
    if (LOOKS.size > 400) LOOKS.clear();
    LOOKS.set(id, L);
  }
  return L;
}
function qmulTo(o, a, b) {
  o[0] = a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1];
  o[1] = a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0];
  o[2] = a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3];
  o[3] = a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2];
  return o;
}
const Q_ROLL = new Float64Array([0, 0, 0, 1]), Q_TMP = new Float64Array([0, 0, 0, 1]);
function rollQ(angle, L, out) { const h = -angle / 2; Q_ROLL[2] = Math.sin(h); Q_ROLL[3] = Math.cos(h); return qmulTo(out, Q_ROLL, L.q0); }
function putMarble(n, x, y, z, r, q, L, fade) {
  const inst = GLR.sphere.data, o = n * 16, t = L.tint, s = L.swirl;
  inst[o] = x; inst[o + 1] = -y; inst[o + 2] = z; inst[o + 3] = r;
  inst[o + 4] = q[0]; inst[o + 5] = q[1]; inst[o + 6] = q[2]; inst[o + 7] = q[3];
  inst[o + 8] = t[0]; inst[o + 9] = t[1]; inst[o + 10] = t[2]; inst[o + 11] = fade;
  inst[o + 12] = s[0]; inst[o + 13] = s[1]; inst[o + 14] = s[2]; inst[o + 15] = L.seed;
  if (n >= GLR.marbleShadows) return;
  const k = n * 4;
  MARBLE_DATA[k] = x; MARBLE_DATA[k + 1] = -y; MARBLE_DATA[k + 2] = z; MARBLE_DATA[k + 3] = r;
  MARBLE_COL[k] = t[0]; MARBLE_COL[k + 1] = t[1]; MARBLE_COL[k + 2] = t[2]; MARBLE_COL[k + 3] = fade;
}
const DRAWPOS = [0, 0, 0];
// How many of a song dropper's marbles are still to drop (all before Play; while playing, those not yet shown leaving)
function waitingDrops(times) {
  if (!SIM.session) return times.length;
  let n = 0;
  for (let i = 0; i < times.length; i++) if (times[i] > SIM.dispT) n++;
  return n;
}
// Marbles to draw: the rolling ones (LATENCY behind the physics head), and one waiting in each dropper's hopper.
// All of them are drawn; the first GLR.marbleShadows (rolling ones first) also cast soft shadows.
function frameMarbles() {
  let n = 0, drops = 0;
  const list = drawnMarbles(), pieces = MODEL.pieces;
  for (let i = 0; i < pieces.length; i++) if (pieces[i].type === 'dropper') drops++;
  marbleSlots(list.length + drops * 3);
  for (let i = 0; i < list.length; i++) {
    const m = list[i];
    const p = marbleDrawPos(m, DRAWPOS);
    if (!p) continue;
    const L = marbleLook(m.id);
    putMarble(n++, p[0], p[1], ZM, m.r, rollQ(p[2], L, Q_TMP), L, 1);
  }
  GLR.rollCount = n;
  // the marble waiting in each dropper shows through its sight slot; a song's dropper with more drops to come
  // shows up to two more stacked above it (in the hopper)
  let k = 0;
  for (let i = 0; i < pieces.length; i++) {
    const p = pieces[i];
    if (p.type !== 'dropper') continue;
    const s = p.schedule, left = s && s.mode === 'times' ? waitingDrops(s.times) : 1;
    for (let j = 0; j < Math.min(3, Math.max(1, left)); j++) {
      const L = marbleLook(1000 + (k++));
      putMarble(n++, p.x, p.y - 45 - j * 20.5, ZM - 1, CANON.MARBLE_R, rollQ(0.6 * k, L, Q_TMP), L, 1);
    }
  }
  GLR.marbleCount = n;
  GLR.shadowCount = Math.min(n, GLR.marbleShadows);
}

/* ---- Piece meshes: built on first use per shape, shared by every piece of that shape ----
 *  Shapes no longer on the board are let go of AFTER a frame is drawn (never one this frame uses), and only while
 *  the cache holds more than max(260, 1.5 x the shapes on the board). While a piece is being resized (a live edit),
 *  bars, rails, walls and springs are drawn with the mesh they had when the edit began, stretched along their
 *  length; curves and funnels are rebuilt at most every 100 ms; the exact mesh is built when the edit ends. */
const PM = { cache: new Map(), gate: null, live: null, shapes: new Set() };
function glMeshSet(mbs) {
  const list = [];
  for (const mat in mbs) { const mesh = glMesh(GLR.gl, mbs[mat]); if (mesh) list.push({ mat, mesh }); }
  return { list, used: 0 };
}
function pieceMeshSet(p, key = pieceShapeKey(p)) {
  let e = PM.cache.get(key);
  if (!e) { e = glMeshSet(buildPieceMeshes(p)); PM.cache.set(key, e); }
  e.used = GLR.frames;
  return e;
}
function freeMeshSet(v) { for (const m of v.list) { GLR.gl.deleteBuffer(m.mesh.vb); GLR.gl.deleteBuffer(m.mesh.ib); GLR.gl.deleteVertexArray(m.mesh.vao); } }
function evictMeshes() {
  const keep = Math.max(260, Math.ceil(PM.shapes.size * 1.5));
  if (PM.cache.size <= keep) return;
  const old = [...PM.cache.entries()].filter(([, v]) => v.used < GLR.frames - 120).sort((a, b) => a[1].used - b[1].used);
  for (const [k, v] of old) { if (PM.cache.size <= keep) break; freeMeshSet(v); PM.cache.delete(k); }
}
const STRETCH = { bar: 1, rail: 1, wall: 1, spring: 1 }, REBUILD_MS = 100;
// The mesh for a piece in a live resize (see above): { set, sx } (sx: stretch along its length)
function liveMeshSet(p) {
  const L = PM.live;
  if (!L || L.id !== p.id) {
    PM.live = { id: p.id, key: pieceShapeKey(p), set: pieceMeshSet(p), len: p.len, at: performance.now() };
    return { set: PM.live.set, sx: 0 };
  }
  const key = pieceShapeKey(p);
  if (key === L.key) return { set: L.set, sx: 0 };
  if (STRETCH[p.type]) { L.set.used = GLR.frames; const hw = CANON.HW[p.type]; return { set: L.set, sx: (p.len + 2 * hw) / (L.len + 2 * hw) }; }
  if (performance.now() - L.at >= REBUILD_MS || PM.cache.has(key)) { L.key = key; L.set = pieceMeshSet(p, key); L.at = performance.now(); }
  L.set.used = GLR.frames;
  return { set: L.set, sx: 0 };
}
// The draw list: every piece (and the one being dragged in from the tray) with its transform and effects
// (objects pooled, glow colours cached per note: no garbage per frame)
const DRAWS = [], DRAW_POOL = [], GLOW_COL = new Map(), GLOW_PLAIN = [1.2, 0.9, 0.5];
function glowColor(note) { let c = GLOW_COL.get(note); if (!c) GLOW_COL.set(note, (c = lin(noteHex(note), 1.6))); return c; }
function drawItem(set, x, y, c, s, lift, scale, glow, glowCol, sx) {
  const d = DRAW_POOL[DRAWS.length] || (DRAW_POOL[DRAWS.length] = {});
  d.set = set; d.x = x; d.y = y; d.c = c; d.s = s; d.lift = lift; d.scale = scale; d.glow = glow; d.glowCol = glowCol; d.sx = sx;
  DRAWS.push(d);
  return d;
}
function frameDraws(t) {
  DRAWS.length = 0;
  PM.shapes.clear();
  const live = HISTORY.pending ? HISTORY.liveId || EDIT.selected : null;
  if (!live) PM.live = null;
  const n = MODEL.pieces.length + (EDIT.ghost ? 1 : 0);
  for (let i = 0; i < n; i++) {
    const p = i < MODEL.pieces.length ? MODEL.pieces[i] : EDIT.ghost;
    const f = SIM.fx.get(p.id), ghost = p === EDIT.ghost, lifted = ghost || EDIT.lifted === p.id;
    const wig = f && !reducedMotion ? Math.sin(t * 62 + p.x * 0.1) * 0.028 * f.wiggle : 0;
    const a = -(p.type === 'dropper' ? 0 : p.rot || 0) * RAD + wig;
    const sc = p.type === 'bell' && f && !reducedMotion ? 1 + 0.07 * f.wiggle * Math.sin(t * 48) : 1;
    const glowCol = hasNote(p.type) ? glowColor(p.note) : GLOW_PLAIN;
    let set, sx = 0;
    if (p.id === live) { const L = liveMeshSet(p); set = L.set; sx = L.sx; } else { const key = pieceShapeKey(p); set = pieceMeshSet(p, key); PM.shapes.add(key); }
    const d = drawItem(set, p.x, -p.y, Math.cos(a), Math.sin(a), lifted ? 7 : 0, sc,
      Math.max(f ? f.glow * 0.9 : 0, ghost ? 0.25 : 0, EDIT.selected === p.id && EDIT.pulse > 0 ? EDIT.pulse * 0.5 : 0), glowCol, sx);
    if (p.type === 'dropper') {                      // its gate flicks open as a marble leaves
      if (!PM.gate) PM.gate = glMeshSet(buildGateMeshes());
      const open = f ? Math.sin(Math.min(1, f.flick * 1.4) * Math.PI / 2) : 0, ga = -1.25 * open;
      drawItem(PM.gate, p.x - 13, -(p.y - 11), Math.cos(ga), Math.sin(ga), d.lift, 1, 0, glowCol, 0);
    }
  }
}

// Instancing: the draw list grouped by mesh (pieces of one shape, size and note share it), each group's
// instances in consecutive rows of a float texture (3 texels each; row 0 = the room: no transform, no glow).
// One instanced draw per group and pass.
const INST = { tex: null, rows: 0, data: new Float32Array(0), groups: [], byMesh: new Map(), pool: new Map() };
function frameInstances() {
  const gl = GLR.gl, groups = INST.groups;
  INST.byMesh.clear(); groups.length = 0;
  for (let i = 0; i < DRAWS.length; i++) for (let j = 0, d = DRAWS[i], L = d.set.list; j < L.length; j++) {
    const e = L[j];
    let g = INST.byMesh.get(e.mesh);
    if (!g) {
      g = INST.pool.get(e.mesh);
      if (!g) { g = { mat: e.mat, mesh: e.mesh, items: [], base: 0 }; INST.pool.set(e.mesh, g); }
      g.items.length = 0;
      INST.byMesh.set(e.mesh, g); groups.push(g);
    }
    g.items.push(d);
  }
  if (INST.pool.size > 2 * INST.byMesh.size + 64) for (const k of [...INST.pool.keys()]) if (!INST.byMesh.has(k)) INST.pool.delete(k);
  let n = 1;
  for (let i = 0; i < groups.length; i++) { groups[i].base = n; n += groups[i].items.length; }
  const rows = Math.ceil(n / INST_PER_ROW), W = INST_PER_ROW * 3;
  if (rows > INST.rows || !INST.tex) {                // (re)allocate, with room to grow
    if (INST.tex) gl.deleteTexture(INST.tex);
    INST.rows = Math.max(rows, 2);
    INST.data = new Float32Array(W * INST.rows * 4);
    INST.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, INST.tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, W, INST.rows);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  }
  const D = INST.data;
  D.fill(0, 0, 12); D[2] = 1; D[5] = 1;             // the room: cos 1, sin 0, lift 0, scale 1, no glow
  for (let i = 0; i < groups.length; i++) for (let k = 0, g = groups[i]; k < g.items.length; k++) {
    const d = g.items[k], o = (g.base + k) * 12;
    D[o] = d.x; D[o + 1] = d.y; D[o + 2] = d.c; D[o + 3] = d.s;
    D[o + 4] = d.lift; D[o + 5] = d.scale; D[o + 6] = d.glow; D[o + 7] = d.sx || 0;
    D[o + 8] = d.glowCol[0]; D[o + 9] = d.glowCol[1]; D[o + 10] = d.glowCol[2]; D[o + 11] = 0;
  }
  gl.activeTexture(gl.TEXTURE8);
  gl.bindTexture(gl.TEXTURE_2D, INST.tex);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, W, rows, gl.RGBA, gl.FLOAT, D, 0);
}

function setCommon(p) {
  const gl = GLR.gl, u = p.u, c = GLR.cam, w = GLR.win;
  gl.useProgram(p.p);
  if (u.uViewProj) gl.uniformMatrix4fv(u.uViewProj, false, c.vp);
  if (u.uCamPos) gl.uniform3fv(u.uCamPos, c.eye);
  if (u.uSunDir) gl.uniform3fv(u.uSunDir, SUN_DIR);
  if (u.uSunCol) gl.uniform3fv(u.uSunCol, SUN_COL);
  if (u.uSH) gl.uniform3fv(u.uSH, GLR.env.sh);
  if (u.uEnvMax) gl.uniform1f(u.uEnvMax, GLR.env.levels - 1);
  if (u.uLightTan) gl.uniform1f(u.uLightTan, LIGHT_TAN);
  if (u.uTaps) gl.uniform1i(u.uTaps, GLR.taps);
  if (u.uTime) gl.uniform1f(u.uTime, clock);
  if (u.uMarbles) gl.uniform4fv(u.uMarbles, MARBLE_DATA);
  if (u.uMarbleCol) gl.uniform4fv(u.uMarbleCol, MARBLE_COL);
  if (u.uMarbleRange) gl.uniform2i(u.uMarbleRange, 0, GLR.shadowCount);
  if (u.uInst) { gl.activeTexture(gl.TEXTURE8); gl.bindTexture(gl.TEXTURE_2D, INST.tex); gl.uniform1i(u.uInst, 8); }
  if (u.uBoardCol) gl.uniform3fv(u.uBoardCol, BOARD_REFL);
  if (u.uWinU) { gl.uniform4fv(u.uWinU, w.U); gl.uniform4fv(u.uWinV, w.V); gl.uniform4fv(u.uWinRect, w.rect); gl.uniform4fv(u.uWinBars, w.bars); }
  if (u.uEnv) { gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_CUBE_MAP, GLR.env.tex); gl.uniform1i(u.uEnv, 2); }
  const s0 = GLR.shadowMats;
  if (u.uShadow0) { gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, GLR.shadow[0].tex); gl.uniform1i(u.uShadow0, 3); }
  if (u.uShadow1) { gl.activeTexture(gl.TEXTURE4); gl.bindTexture(gl.TEXTURE_2D, GLR.shadow[1].tex); gl.uniform1i(u.uShadow1, 4); }
  if (u.uShadowCmp0) { gl.activeTexture(gl.TEXTURE6); gl.bindTexture(gl.TEXTURE_2D, GLR.shadow[0].tex); gl.bindSampler(6, GLR.cmpSampler); gl.uniform1i(u.uShadowCmp0, 6); }
  if (u.uShadowCmp1) { gl.activeTexture(gl.TEXTURE7); gl.bindTexture(gl.TEXTURE_2D, GLR.shadow[1].tex); gl.bindSampler(7, GLR.cmpSampler); gl.uniform1i(u.uShadowCmp1, 7); }
  if (u.uShadowMat0) gl.uniformMatrix4fv(u.uShadowMat0, false, s0[0]);
  if (u.uShadowMat1) gl.uniformMatrix4fv(u.uShadowMat1, false, s0[1]);
  const S = GLR.shadowSize;
  if (u.uShadowInfo0) gl.uniform4f(u.uShadowInfo0, GLR.sf0.ext, GLR.sf0.range, 1 / S, (GLR.sf0.ext / S) * 1.5);
  if (u.uShadowInfo1) gl.uniform4f(u.uShadowInfo1, GLR.sf1.ext, GLR.sf1.range, 1 / S, (GLR.sf1.ext / S) * 1.5);
}
function bindMat(p, mat, big) {
  const gl = GLR.gl, u = p.u, mt = GLR.mats[(DEV && window.__mmMat && window.__mmMat[mat]) || mat] || GLR.mats.misc;
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, mt.alb); gl.uniform1i(u.uAlb, 0);
  gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, mt.surf); gl.uniform1i(u.uSurf, 1);
  if (u.uLodBias) gl.uniform1f(u.uLodBias, mt.lodBias);
  if (u.uNormalScale) gl.uniform1f(u.uNormalScale, mt.nscale);
  if (u.uTaps) gl.uniform1i(u.uTaps, big ? Math.min(GLR.taps, GLR.lite ? 8 : 12) : GLR.taps);
}
const isRoomCaster = (m) => m.mat !== 'wall' && m.mat !== 'desk';
const PIECE_MATS = ['metal', 'misc', 'letters'];
// (the per-frame loops below index their arrays: a for-of iterator is garbage until the function is optimised)
// Draw the room meshes, then the pieces (grouped by material, one instanced draw per mesh), with or without textures
function drawAll(p, withTextures, casterOnly) {
  const gl = GLR.gl, u = p.u;
  gl.uniform1i(u.uInstBase, 0);
  if (u.uBoardRefl) gl.uniform1f(u.uBoardRefl, 0);
  for (let i = 0; i < GLR.meshes.length; i++) {
    const m = GLR.meshes[i];
    if (casterOnly && !isRoomCaster(m)) continue;
    const big = m.mat === 'wall' || m.mat === 'desk' || m.mat === 'peg';
    if (withTextures) bindMat(p, m.mat, big);
    if (u.uEdgeAA) gl.uniform1f(u.uEdgeAA, big ? 0 : 1);      // (FXAA leaves the big textured surfaces' insides alone)
    gl.bindVertexArray(m.mesh.vao);
    gl.drawElements(gl.TRIANGLES, m.mesh.count, gl.UNSIGNED_INT, 0);
  }
  if (u.uBoardRefl) gl.uniform1f(u.uBoardRefl, 1);
  if (u.uEdgeAA) gl.uniform1f(u.uEdgeAA, 1);
  for (let mi = 0; mi < PIECE_MATS.length; mi++) {
    const mat = PIECE_MATS[mi];
    let bound = false;
    for (let gi = 0; gi < INST.groups.length; gi++) {
      const g = INST.groups[gi];
      if (g.mat !== mat) continue;
      if (withTextures && !bound) { bindMat(p, mat, false); bound = true; }
      gl.uniform1i(u.uInstBase, g.base);
      gl.bindVertexArray(g.mesh.vao);
      gl.drawElementsInstanced(gl.TRIANGLES, g.mesh.count, gl.UNSIGNED_INT, 0, g.items.length);
    }
  }
  gl.bindVertexArray(null);
}

/* ---- One frame ---- */
// Render on demand: a still scene is drawn once; anything moving asks for frames
function sceneSignature(t) {
  const anim = GLR.rollCount > 0 || fxAnimating() || !!EDIT.ghost || EDIT.pulse > 0 || !!VIEWCAM.anim;
  if (anim) return t;
  return -(MODEL.version * 7919 + VIEWCAM.version * 131 + GLR.rw * 3 + GLR.rh + (EDIT.lifted ? 17 : 0) + (GLR.dirty ? t : 0)) - 1;
}
function renderGL(t) {
  if (!GLR.ok || !GLR.ready || !GLR.targets) { drawOverlay(t); return false; }
  const gl = GLR.gl, P = GLR.progs;
  frameMarbles();
  const sig = sceneSignature(t);
  if (sig === GLR.lastSig) { drawOverlay(t); return false; }
  let T = GLR.targets;
  if (GLR.software) {                             // software GL: animated frames at most every max(0.6 s, 2 x the last frame's time)
    const animating = sig > 0, now = performance.now();
    if (animating && now - (GLR.lastRenderAt || -1e9) < Math.max(600, 2 * (GLR.lastRenderMs || 0))) { drawOverlay(t); return false; }
    GLR.lastSig = animating ? 'low' : sig;
  } else GLR.lastSig = sig;
  GLR.dirty = false;
  GLR.frames++;
  const tStart = performance.now();
  frameDraws(t);
  frameInstances();
  // 1) shadow maps: only when a piece moved, changed, wiggles or floats
  gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.depthMask(true);
  gl.disable(gl.CULL_FACE); gl.disable(gl.BLEND);
  gl.enable(gl.POLYGON_OFFSET_FILL); gl.polygonOffset(1.6, 2.0);
  const dp = P.depth;
  setCommon(dp);
  const moving = !!EDIT.ghost || !!EDIT.lifted;                  // (a playing piece's tiny wiggle does not show in its shadow)
  const shadowKey = MODEL.version * 1e4 + (moving ? t : 0) + GLR.shadowEpoch * 1e-3;
  if (shadowKey !== GLR.shadowKey) {
    GLR.shadowKey = shadowKey;
    gl.uniform1f(dp.u.uCoverage, 1);
    for (let k = 0; k < 2; k++) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, GLR.shadow[k].fb);
      gl.viewport(0, 0, GLR.shadowSize, GLR.shadowSize);
      gl.clear(gl.DEPTH_BUFFER_BIT);
      gl.uniformMatrix4fv(dp.u.uViewProj, false, GLR.shadowMats[k]);
      drawAll(dp, false, true);
    }
  }
  gl.disable(gl.POLYGON_OFFSET_FILL);
  // 2) opaque scene
  gl.bindFramebuffer(gl.FRAMEBUFFER, T.main);
  gl.viewport(0, 0, T.w, T.h);
  gl.clearColor(0.16, 0.11, 0.07, 1);                         // (the desk's shadowed tone, should anything show through)
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  setCommon(P.pbr);
  if (DEV && P.pbr.u.uDebug) gl.uniform1i(P.pbr.u.uDebug, window.__mmDebug || 0);
  drawAll(P.pbr, true, false);
  // 3) a copy of the opaque scene for the glass to refract
  if (T.samples > 1) blit(T.main, T.copy.fb, T.w, T.h);
  else downsample(T.colorTex, T.w, T.h, T.refr);
  gl.bindFramebuffer(gl.FRAMEBUFFER, T.main);
  gl.viewport(0, 0, T.w, T.h);
  // 4) glass marbles
  if (GLR.marbleCount) {
    const mp = P.marble;
    setCommon(mp);
    gl.activeTexture(gl.TEXTURE5); gl.bindTexture(gl.TEXTURE_2D, T.refrTex); gl.uniform1i(mp.u.uScene, 5);
    gl.bindBuffer(gl.ARRAY_BUFFER, GLR.sphere.inst);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, GLR.sphere.data, 0, GLR.marbleCount * 16);
    gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.enable(gl.CULL_FACE); gl.cullFace(gl.BACK);
    gl.bindVertexArray(GLR.sphere.vao);
    gl.drawElementsInstanced(gl.TRIANGLES, GLR.sphere.count, gl.UNSIGNED_SHORT, 0, GLR.marbleCount);
    gl.bindVertexArray(null);
    gl.disable(gl.CULL_FACE); gl.disable(gl.BLEND);
  }
  // 5) resolve (MSAA)
  if (T.samples > 1) {
    blit(T.main, T.copy.fb, T.w, T.h);
    gl.bindFramebuffer(gl.FRAMEBUFFER, T.main);
    gl.invalidateFramebuffer(gl.FRAMEBUFFER, INVALIDATE_ALL);
  } else gl.invalidateFramebuffer(gl.FRAMEBUFFER, INVALIDATE_DEPTH);
  // 6) bloom and the final grade
  gl.disable(gl.DEPTH_TEST);
  gl.bindVertexArray(GLR.quadVao);
  let src = T.sceneTex, sw = T.w, sh = T.h;
  const down = P.down;
  gl.useProgram(down.p);
  for (let i = 0; i < T.bloom.length; i++) {
    const b = T.bloom[i];
    gl.bindFramebuffer(gl.FRAMEBUFFER, b.fb); gl.viewport(0, 0, b.w, b.h);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, src); gl.uniform1i(down.u.uSrc, 0);
    gl.uniform2f(down.u.uTexel, 0.5 / sw, 0.5 / sh); gl.uniform1f(down.u.uPrefilter, i === 0 ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    src = b.tex; sw = b.w; sh = b.h;
  }
  const up = P.up;
  gl.useProgram(up.p);
  gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
  for (let i = T.bloom.length - 1; i > 0; i--) {
    const s = T.bloom[i], d = T.bloom[i - 1];
    gl.bindFramebuffer(gl.FRAMEBUFFER, d.fb); gl.viewport(0, 0, d.w, d.h);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, s.tex); gl.uniform1i(up.u.uSrc, 0);
    gl.uniform2f(up.u.uTexel, 1 / s.w, 1 / s.h);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  gl.disable(gl.BLEND);
  const fp = P.final;
  gl.useProgram(fp.p);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, GLR.canvas.width, GLR.canvas.height);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, T.sceneTex); gl.uniform1i(fp.u.uSrc, 0);
  gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, T.bloom[0].tex); gl.uniform1i(fp.u.uBloom, 1);
  gl.uniform1f(fp.u.uBloomAmt, 0.08);
  gl.uniform1f(fp.u.uExposure, EXPOSURE);
  gl.uniform1f(fp.u.uTime, GLR.software ? 0 : t);
  gl.uniform1i(fp.u.uFxaa, T.samples > 1 ? 0 : 1);
  gl.uniform2f(fp.u.uSrcTexel, 1 / T.w, 1 / T.h);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  gl.bindVertexArray(null);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, null);
  if (GLR.software) gl.finish();
  GLR.lastFrameMs = performance.now() - tStart;
  GLR.lastRenderAt = performance.now();
  evictMeshes();
  drawOverlay(t);
  return true;
}
const INVALIDATE_ALL = [0x8CE0, 0x8D00];
const INVALIDATE_DEPTH = [0x8D00];
function blit(from, toFb, w, h) {
  const gl = GLR.gl;
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, from);
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, toFb);
  gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
  gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
}
function downsample(srcTex, sw, sh, dst) {
  const gl = GLR.gl, down = GLR.progs.down;
  gl.disable(gl.DEPTH_TEST);
  gl.useProgram(down.p);
  gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fb); gl.viewport(0, 0, dst.w, dst.h);
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, srcTex); gl.uniform1i(down.u.uSrc, 0);
  gl.uniform2f(down.u.uTexel, 0.5 / sw, 0.5 / sh); gl.uniform1f(down.u.uPrefilter, 0);
  gl.bindVertexArray(GLR.quadVao); gl.drawArrays(gl.TRIANGLES, 0, 3); gl.bindVertexArray(null);
  gl.bindTexture(gl.TEXTURE_2D, null);
  gl.enable(gl.DEPTH_TEST);
}

// Inspection (?dev only): frame a close-up of a board point for screenshot scripts
const debugCloseUp = DEV ? function (bx, by, dist = 300, yaw = 0.35, pitch = 0.3, fovDeg = 30, z = 12) {
  const target = [bx, -by, z];
  const dir = [Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)];
  const eye = V3.add(target, V3.scale(dir, dist));
  const viewM = M4.lookAt(eye, target, [0, 1, 0]);
  const proj = M4.persp(fovDeg * Math.PI / 180, view.w / view.h, 2, dist + 4000);
  GLR.cam = { ...GLR.cam, eye, target, view: viewM, proj, vp: M4.mul(proj, viewM) };
  GLR.cam.inv = M4.invert(GLR.cam.vp);
  VIEWCAM.version++;
  GLR.layoutEpoch++;
  GLR.dirty = true;
} : undefined;
