
/* ============================================================================
 *  RENDERING (WebGL2): math helpers
 *  3D space: X = world x, Y = -world y (up), Z = towards the viewer.
 *  The board's front face is the plane Z = 0; marbles roll in the plane Z = ZM.
 * ========================================================================== */
const V3 = {
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  scale: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  len: (a) => Math.hypot(a[0], a[1], a[2]),
  norm: (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; },
  lerp: (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t],
};

const M4 = {
  ident() { const m = new Float32Array(16); m[0] = m[5] = m[10] = m[15] = 1; return m; },
  mul(a, b) {                       // a * b (column-major)
    const o = new Float32Array(16);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
      o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
    return o;
  },
  // Perspective with a lens shift (sx, sy in NDC units) so the subject can sit off-centre without tilting the camera
  persp(fovY, aspect, near, far, sx = 0, sy = 0) {
    const f = 1 / Math.tan(fovY / 2), m = new Float32Array(16);
    m[0] = f / aspect; m[5] = f; m[8] = sx; m[9] = sy;
    m[10] = (far + near) / (near - far); m[11] = -1; m[14] = (2 * far * near) / (near - far);
    return m;
  },
  ortho(l, r, b, t, n, f) {
    const m = new Float32Array(16);
    m[0] = 2 / (r - l); m[5] = 2 / (t - b); m[10] = -2 / (f - n);
    m[12] = -(r + l) / (r - l); m[13] = -(t + b) / (t - b); m[14] = -(f + n) / (f - n); m[15] = 1;
    return m;
  },
  lookAt(eye, at, up) {
    const z = V3.norm(V3.sub(eye, at)), x = V3.norm(V3.cross(up, z)), y = V3.cross(z, x);
    const m = new Float32Array(16);
    m[0] = x[0]; m[4] = x[1]; m[8] = x[2];
    m[1] = y[0]; m[5] = y[1]; m[9] = y[2];
    m[2] = z[0]; m[6] = z[1]; m[10] = z[2];
    m[12] = -V3.dot(x, eye); m[13] = -V3.dot(y, eye); m[14] = -V3.dot(z, eye); m[15] = 1;
    return m;
  },
  invert(m) {
    const inv = new Float32Array(16);
    const [a00, a01, a02, a03, a10, a11, a12, a13, a20, a21, a22, a23, a30, a31, a32, a33] = m;
    const b00 = a00 * a11 - a01 * a10, b01 = a00 * a12 - a02 * a10, b02 = a00 * a13 - a03 * a10;
    const b03 = a01 * a12 - a02 * a11, b04 = a01 * a13 - a03 * a11, b05 = a02 * a13 - a03 * a12;
    const b06 = a20 * a31 - a21 * a30, b07 = a20 * a32 - a22 * a30, b08 = a20 * a33 - a23 * a30;
    const b09 = a21 * a32 - a22 * a31, b10 = a21 * a33 - a23 * a31, b11 = a22 * a33 - a23 * a32;
    let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
    if (!det) return M4.ident();
    det = 1 / det;
    inv[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det; inv[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
    inv[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det; inv[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
    inv[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det; inv[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
    inv[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det; inv[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
    inv[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det; inv[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
    inv[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det; inv[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
    inv[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det; inv[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
    inv[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det; inv[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
    return inv;
  },
  xform(m, p) {                    // returns clip-space [x, y, z, w]
    const [x, y, z] = p;
    return [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13],
            m[2] * x + m[6] * y + m[10] * z + m[14], m[3] * x + m[7] * y + m[11] * z + m[15]];
  },
};

/* ============================================================================
 *  RENDERING (WebGL2): GL helpers
 * ========================================================================== */
const ATTR = { pos: 0, nrm: 1, uv: 2, tan: 3, col: 4, mat: 5, iPos: 6, iRot: 7, iGlass: 8, iSwirl: 9 };
const VSTRIDE = 20;               // floats per vertex: pos3 nrm3 uv2 tan4 col4 mat4

function glCompile(gl, type, src, name) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS) && !gl.isContextLost()) {
    const log = gl.getShaderInfoLog(sh);
    const lines = src.split('\n').map((l, i) => (i + 1) + ': ' + l);
    const m = /ERROR: \d+:(\d+)/.exec(log || '');
    const near = m ? lines.slice(Math.max(0, m[1] - 4), Number(m[1]) + 2).join('\n') : '';
    console.error('Shader compile failed (' + name + '): ' + log + '\n' + near);
    return null;
  }
  return sh;
}

function glProgram(gl, name, vs, fs, defines = '') {
  const head = '#version 300 es\nprecision highp float;\nprecision highp int;\nprecision highp sampler2D;\nprecision highp samplerCube;\nprecision highp sampler2DShadow;\n' + defines + '\n';
  const v = glCompile(gl, gl.VERTEX_SHADER, head + vs, name + '.vs');
  const f = glCompile(gl, gl.FRAGMENT_SHADER, head + fs, name + '.fs');
  if (!v || !f) return null;
  const p = gl.createProgram();
  gl.attachShader(p, v); gl.attachShader(p, f);
  for (const k in ATTR) gl.bindAttribLocation(p, ATTR[k], 'a' + k[0].toUpperCase() + k.slice(1));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS) && !gl.isContextLost()) {
    console.error('Program link failed (' + name + '): ' + gl.getProgramInfoLog(p));
    return null;
  }
  // Cache uniform locations
  const u = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(p, i);
    const nm = info.name.replace(/\[0\]$/, '');
    u[nm] = gl.getUniformLocation(p, info.name);
  }
  return { p, u, name };
}

// Texture from a canvas / ImageData. srgb: colour data (decoded to linear by the GPU)
function glTexture(gl, src, { srgb = false, repeat = true, mips = true, aniso = 8 } = {}) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
  if (src instanceof ImageData || src.data) {
    gl.texImage2D(gl.TEXTURE_2D, 0, srgb ? gl.SRGB8_ALPHA8 : gl.RGBA8, src.width, src.height, 0, gl.RGBA, gl.UNSIGNED_BYTE,
      src.data instanceof Uint8ClampedArray ? new Uint8Array(src.data.buffer) : src.data);
  } else {
    gl.texImage2D(gl.TEXTURE_2D, 0, srgb ? gl.SRGB8_ALPHA8 : gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, src);
  }
  const wrap = repeat ? gl.REPEAT : gl.CLAMP_TO_EDGE;
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mips ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
  if (mips) gl.generateMipmap(gl.TEXTURE_2D);
  const ext = gl.getExtension('EXT_texture_filter_anisotropic');
  if (ext && aniso > 1) gl.texParameterf(gl.TEXTURE_2D, ext.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(aniso, gl.getParameter(ext.MAX_TEXTURE_MAX_ANISOTROPY_EXT)));
  return t;
}

/* ---- Mesh building: interleaved vertices, 32-bit indices, tangents from UVs ---- */
class MeshBuilder {
  constructor() { this.v = []; this.idx = []; this.col = [1, 1, 1, 1]; this.mat = [1, 0, 0, 0]; }
  get count() { return this.v.length / VSTRIDE; }
  setCol(r, g, b, ao = 1) { this.col = [r, g, b, ao]; return this; }
  setMat(rough = 1, metal = 0, obIndex = 0, flag = 0) { this.mat = [rough, metal, obIndex, flag]; return this; }
  vert(p, n, uv, col = this.col, mat = this.mat) {
    this.v.push(p[0], p[1], p[2], n[0], n[1], n[2], uv[0], uv[1], 0, 0, 0, 0, col[0], col[1], col[2], col[3], mat[0], mat[1], mat[2], mat[3]);
    return this.count - 1;
  }
  tri(a, b, c) { this.idx.push(a, b, c); }
  quad(a, b, c, d) { this.idx.push(a, b, c, a, c, d); }
  // Grid of vertices (rows x cols) from a function f(i, j) -> {p, n, uv}; quads between neighbours
  grid(rows, cols, f, flip = false) {
    const base = this.count;
    for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) {
      const q = f(i, j);
      this.vert(q.p, q.n, q.uv, q.col || this.col, q.mat || this.mat);
    }
    for (let i = 0; i < rows - 1; i++) for (let j = 0; j < cols - 1; j++) {
      const a = base + i * cols + j, b = a + 1, c = a + cols + 1, d = a + cols;
      if (flip) this.quad(a, d, c, b); else this.quad(a, b, c, d);
    }
  }
  append(o) {
    const base = this.count;
    for (const x of o.v) this.v.push(x);
    for (const i of o.idx) this.idx.push(i + base);
  }
  // Per-vertex tangents from UV gradients (accumulated over the faces), w = handedness
  computeTangents() {
    const n = this.count, v = this.v, t1 = new Float32Array(n * 3), t2 = new Float32Array(n * 3);
    for (let k = 0; k < this.idx.length; k += 3) {
      const i0 = this.idx[k], i1 = this.idx[k + 1], i2 = this.idx[k + 2];
      const o0 = i0 * VSTRIDE, o1 = i1 * VSTRIDE, o2 = i2 * VSTRIDE;
      const e1 = [v[o1] - v[o0], v[o1 + 1] - v[o0 + 1], v[o1 + 2] - v[o0 + 2]];
      const e2 = [v[o2] - v[o0], v[o2 + 1] - v[o0 + 1], v[o2 + 2] - v[o0 + 2]];
      const du1 = v[o1 + 6] - v[o0 + 6], dv1 = v[o1 + 7] - v[o0 + 7], du2 = v[o2 + 6] - v[o0 + 6], dv2 = v[o2 + 7] - v[o0 + 7];
      let r = du1 * dv2 - du2 * dv1;
      if (Math.abs(r) < 1e-12) continue;
      r = 1 / r;
      const sx = (e1[0] * dv2 - e2[0] * dv1) * r, sy = (e1[1] * dv2 - e2[1] * dv1) * r, sz = (e1[2] * dv2 - e2[2] * dv1) * r;
      const tx = (e2[0] * du1 - e1[0] * du2) * r, ty = (e2[1] * du1 - e1[1] * du2) * r, tz = (e2[2] * du1 - e1[2] * du2) * r;
      for (const i of [i0, i1, i2]) { t1[i * 3] += sx; t1[i * 3 + 1] += sy; t1[i * 3 + 2] += sz; t2[i * 3] += tx; t2[i * 3 + 1] += ty; t2[i * 3 + 2] += tz; }
    }
    for (let i = 0; i < n; i++) {
      const o = i * VSTRIDE, nn = [v[o + 3], v[o + 4], v[o + 5]];
      let t = [t1[i * 3], t1[i * 3 + 1], t1[i * 3 + 2]];
      t = V3.sub(t, V3.scale(nn, V3.dot(nn, t)));           // Gram-Schmidt
      if (V3.len(t) < 1e-8) {                                // no UV gradient: any perpendicular
        t = Math.abs(nn[0]) < 0.9 ? V3.cross(nn, [1, 0, 0]) : V3.cross(nn, [0, 1, 0]);
      }
      t = V3.norm(t);
      const w = V3.dot(V3.cross(nn, t), [t2[i * 3], t2[i * 3 + 1], t2[i * 3 + 2]]) < 0 ? -1 : 1;
      v[o + 8] = t[0]; v[o + 9] = t[1]; v[o + 10] = t[2]; v[o + 11] = w;
    }
    return this;
  }
}

function glMesh(gl, mb) {
  if (!mb || !mb.idx.length) return null;
  mb.computeTangents();
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const vb = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vb);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(mb.v), gl.STATIC_DRAW);
  const S = VSTRIDE * 4;
  const attrs = [[ATTR.pos, 3, 0], [ATTR.nrm, 3, 12], [ATTR.uv, 2, 24], [ATTR.tan, 4, 32], [ATTR.col, 4, 48], [ATTR.mat, 4, 64]];
  for (const [loc, size, off] of attrs) { gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, size, gl.FLOAT, false, S, off); }
  const ib = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint32Array(mb.idx), gl.STATIC_DRAW);
  gl.bindVertexArray(null);
  return { vao, count: mb.idx.length, vb, ib };
}

/* ---- Framebuffers ---- */
// A texture you can render into; null if this driver can't render to that format (the caller falls back)
function glColorTarget(gl, w, h, internal, filter = gl.LINEAR) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texStorage2D(gl.TEXTURE_2D, 1, internal, w, h);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fb); gl.deleteTexture(t);
    return null;
  }
  return { fb, tex: t, w, h };
}

function glShadowTarget(gl, size) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.DEPTH_COMPONENT24, size, size);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, t, 0);
  gl.drawBuffers([gl.NONE]);
  gl.readBuffer(gl.NONE);
  return { fb, tex: t, size };
}

// Seeded value noise helpers used by the texture generators
function makeNoise2(seed, size = 256) {
  const rnd = mulberry32(seed), tab = new Float32Array(size * size);
  for (let i = 0; i < tab.length; i++) tab[i] = rnd();
  const S = size;
  const at = (x, y) => tab[(y % S) * S + (x % S)];
  // smooth value noise; px/py = lattice period on each axis (for seamless tiling)
  function n(x, y, px = S, py = px) {
    const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
    const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
    const X0 = ((xi % px) + px) % px, Y0 = ((yi % py) + py) % py, X1 = (X0 + 1) % px, Y1 = (Y0 + 1) % py;
    const a = at(X0, Y0), b = at(X1, Y0), c = at(X0, Y1), d = at(X1, Y1);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }
  return n;
}
