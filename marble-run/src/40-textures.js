
/* ============================================================================
 *  RENDERING (WebGL2): procedural textures (reused engine + the metal workshop set)
 *  Every material gets two textures, both painted at start-up with Canvas 2D:
 *    albedo  (sRGB, alpha = baked ambient occlusion or a print mask)
 *    surface (linear: RG = tangent-space normal from a height map, B = roughness)
 * ========================================================================== */
const TEX = {};
const HAND = '"Comic Sans MS", "Chalkboard SE", "Comic Neue", "Marker Felt", "Segoe Print", "Trebuchet MS", "Segoe UI", system-ui, sans-serif';
const STENCIL = 'Impact, "Arial Black", "Franklin Gothic Heavy", "Liberation Sans", sans-serif';

// Every canvas painted for the 3D textures is remembered, so its memory can be given back once uploaded
const TEX_CANVASES = [];
function cnv(w, h) { const c = document.createElement('canvas'); c.width = Math.max(1, w | 0); c.height = Math.max(1, h | 0); TEX_CANVASES.push(c); return c; }
function freeTexCanvases() { for (const c of TEX_CANVASES) { c.width = 0; c.height = 0; } TEX_CANVASES.length = 0; }
function c2d(c) { return c.getContext('2d', { willReadFrequently: true }); }

// Separable box blur on a Float32 channel (3 passes approximate a gaussian)
function blurF32(a, w, h, r, wrap = false, passes = 3) {
  if (r < 1) return a;
  const tmp = new Float32Array(a.length);
  const pass = (src, dst, horiz) => {
    const n = horiz ? w : h, lines = horiz ? h : w, k = 1 / (2 * r + 1);
    for (let l = 0; l < lines; l++) {
      const at = (i) => {
        if (wrap) i = (i % n + n) % n; else i = i < 0 ? 0 : i >= n ? n - 1 : i;
        return horiz ? src[l * w + i] : src[i * w + l];
      };
      let s = 0;
      for (let i = -r; i <= r; i++) s += at(i);
      for (let i = 0; i < n; i++) {
        if (horiz) dst[l * w + i] = s * k; else dst[i * w + l] = s * k;
        s += at(i + r + 1) - at(i - r);
      }
    }
  };
  for (let p = 0; p < passes; p++) { pass(a, tmp, true); pass(tmp, a, false); }
  return a;
}

function grayOf(c) {
  const d = c2d(c).getImageData(0, 0, c.width, c.height).data, out = new Float32Array(c.width * c.height);
  for (let i = 0; i < out.length; i++) out[i] = d[i * 4] / 255;
  return out;
}

// Height (0..1) -> packed surface texture: RG normal (Sobel), B roughness, A = 255
function surfaceFromHeight(h, w, hh, strength, rough, wrap = true) {
  const out = new Uint8Array(w * hh * 4);
  const rArr = typeof rough === 'number' ? null : rough, rc = typeof rough === 'number' ? Math.round(clamp(rough, 0.02, 1) * 255) : 0;
  for (let y = 0; y < hh; y++) {
    const ym = y === 0 ? (wrap ? hh - 1 : 0) : y - 1, yp = y === hh - 1 ? (wrap ? 0 : hh - 1) : y + 1;
    const r0 = ym * w, r1 = y * w, r2 = yp * w;
    for (let x = 0; x < w; x++) {
      const xm = x === 0 ? (wrap ? w - 1 : 0) : x - 1, xp = x === w - 1 ? (wrap ? 0 : w - 1) : x + 1;
      const dx = (h[r0 + xp] + 2 * h[r1 + xp] + h[r2 + xp] - h[r0 + xm] - 2 * h[r1 + xm] - h[r2 + xm]) * 0.125;
      const dy = (h[r2 + xm] + 2 * h[r2 + x] + h[r2 + xp] - h[r0 + xm] - 2 * h[r0 + x] - h[r0 + xp]) * 0.125;
      const nx = -dx * strength, ny = -dy * strength, inv = 1 / Math.sqrt(nx * nx + ny * ny + 1);
      const i = (r1 + x) * 4;
      out[i] = (nx * inv * 0.5 + 0.5) * 255 + 0.5;
      out[i + 1] = (ny * inv * 0.5 + 0.5) * 255 + 0.5;
      out[i + 2] = rArr ? (rArr[r1 + x] < 0.02 ? 0.02 : rArr[r1 + x] > 1 ? 1 : rArr[r1 + x]) * 255 + 0.5 : rc;
      out[i + 3] = 255;
    }
  }
  return { width: w, height: hh, data: out };
}

// Smooth noise layers painted with Canvas upscaling (fast mottling for big textures). `wrap`: the cells repeat
// across the edges, so a tiling texture (the pegboard) has no seam
function paintMottle(g, W, H, seed, cells, alpha, mode = 'soft-light', tint = null, wrap = false) {
  const rnd = mulberry32(seed);
  const cw = Math.max(2, Math.round(cells)), ch = Math.max(2, Math.round(cells * H / W)), P = wrap ? 2 : 0;
  const vals = new Float32Array(cw * ch);
  for (let i = 0; i < vals.length; i++) vals[i] = rnd() * 255;
  const sw = cw + 2 * P, sh = ch + 2 * P, s = cnv(sw, sh), sg = c2d(s), id = sg.createImageData(sw, sh);
  for (let y = 0; y < sh; y++) for (let x = 0; x < sw; x++) {
    const v = vals[((y - P + ch) % ch) * cw + ((x - P + cw) % cw)], i = y * sw + x;
    id.data[i * 4] = tint ? tint[0] : v; id.data[i * 4 + 1] = tint ? tint[1] : v; id.data[i * 4 + 2] = tint ? tint[2] : v;
    id.data[i * 4 + 3] = tint ? v : 255;
  }
  sg.putImageData(id, 0, 0);
  g.save();
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
  g.globalAlpha = alpha; g.globalCompositeOperation = mode;
  g.drawImage(s, -P * W / cw, -P * H / ch, sw * W / cw, sh * H / ch);   // (the padding falls outside: the middle maps to 0..W)
  g.restore();
}

// Short paper fibres (`wrap`: a fibre near an edge is drawn again across it, for tiling textures)
function paintFibres(g, W, H, n, seed, light, dark, len = 6, width = 0.8, wrap = false) {
  const rnd = mulberry32(seed);
  g.save();
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.lineCap = 'round';
  for (let i = 0; i < n; i++) {
    const x = rnd() * W, y = rnd() * H, a = rnd() * Math.PI, l = len * (0.4 + rnd());
    g.strokeStyle = rnd() < 0.55 ? dark : light;
    g.lineWidth = width * (0.5 + rnd());
    const j1 = (rnd() - 0.5) * 2, j2 = (rnd() - 0.5) * 2;
    const offs = wrap && (x < l + 2 || x > W - l - 2 || y < l + 2 || y > H - l - 2) ? [[0, 0], [W, 0], [-W, 0], [0, H], [0, -H], [W, H], [-W, -H], [W, -H], [-W, H]] : [[0, 0]];
    for (const [ox, oy] of offs) {
      g.beginPath();
      g.moveTo(x + ox, y + oy);
      g.quadraticCurveTo(x + ox + Math.cos(a) * l * 0.5 + j1, y + oy + Math.sin(a) * l * 0.5 + j2, x + ox + Math.cos(a) * l, y + oy + Math.sin(a) * l);
      g.stroke();
    }
  }
  g.restore();
}

/* ---- Marker lettering: a tiny single-stroke font, so every label looks written with a felt-tip pen
 *  on every device (no dependence on installed handwriting fonts). Glyphs are polylines on a
 *  10-unit cap height; a leading '~' marks a stroke drawn smoothed. */
const GLYPHS = {
  A: '0,10 5,0 10,10|2.3,6.4 7.7,6.4', B: '0,0 0,10|~0,0 5.5,0 8.6,1.3 8.6,3.8 5.5,5 0,5|~0,5 6,5 9.5,6.4 9.5,8.7 6,10 0,10',
  C: '~9.5,1.8 7.5,0.2 4.5,0 1.4,1.6 0,5 1.4,8.5 4.5,10 7.6,9.8 9.6,8.2', D: '0,0 0,10|~0,0 4.5,0 8.5,1.8 10,5 8.5,8.2 4.5,10 0,10',
  E: '9,0 0,0 0,10 9,10|0,5 6.8,5', F: '9,0 0,0 0,10|0,5 6.8,5',
  G: '~9.5,1.8 7.5,0.2 4.5,0 1.4,1.6 0,5 1.4,8.5 4.5,10 7.6,9.8 9.8,8 9.8,5.6|5.4,5.6 9.8,5.6',
  H: '0,0 0,10|9,0 9,10|0,5 9,5', I: '0,0 5,0|2.5,0 2.5,10|0,10 5,10', J: '~8.5,0 8.5,7 7.2,9.4 4.2,10 1.3,9.2 0,7.2',
  K: '0,0 0,10|8.5,0 0,6.2|2.8,4.3 9,10', L: '0,0 0,10 8,10', M: '0,10 0.6,0 5.5,6.6 10.4,0 11,10', N: '0,10 0,0 9,10 9,0',
  O: '~5,0 1.4,1.5 0,5 1.4,8.5 5,10 8.6,8.5 10,5 8.6,1.5 5,0 4,0.3', P: '0,10 0,0|~0,0 5.5,0 8.8,1.4 8.8,4 5.5,5.4 0,5.4',
  Q: '~5,0 1.4,1.5 0,5 1.4,8.5 5,10 8.6,8.5 10,5 8.6,1.5 5,0 4,0.3|6.2,7.2 10.2,10.6',
  R: '0,10 0,0|~0,0 5.5,0 8.8,1.4 8.8,4 5.5,5.4 0,5.4|4.4,5.4 9,10',
  S: '~9,1.6 7,0.1 3.5,0 1,1.3 0.6,3.4 3,4.7 6.5,5.3 9,6.6 9.4,8.6 7,9.9 3,10 0.3,8.4', T: '0,0 10,0|5,0 5,10',
  U: '~0,0 0,6.8 1.3,9.3 4.5,10 7.7,9.3 9,6.8 9,0', V: '0,0 5,10 10,0', W: '0,0 2.8,10 6,3.4 9.2,10 12,0',
  X: '0,0 9,10|9,0 0,10', Y: '0,0 4.5,5 9,0|4.5,5 4.5,10', Z: '0,0 9,0 0,10 9,10',
  0: '~4,0 0.8,1.8 0,5 0.8,8.2 4,10 7.2,8.2 8,5 7.2,1.8 4,0', 1: '1,2 4,0 4,10|1,10 7,10',
  2: '~0.5,2.2 2.5,0.3 5.5,0 8,1.4 8.4,3.6 6,6.2 0,10|0,10 9,10',
  3: '~0.5,1 4,0 7.5,0.8 8.2,2.8 6.5,4.4 3.5,4.9|~3.5,4.9 7.2,5.4 8.8,7.4 7.6,9.4 4,10 0.3,9', 4: '6.5,10 6.5,0 0,7 9,7',
  5: '8.5,0 1,0 0.6,4.6|~0.6,4.6 3.5,3.9 7,4.4 8.8,6.8 7.8,9.2 4.5,10 0.4,9',
  6: '~8,0.6 5,0 2,1.4 0.3,4.8 0.4,8 3,10 6.5,9.8 8.6,7.6 8,5.4 5.5,4.4 2.5,4.8 0.4,6.6', 7: '0,0 9,0 3.5,10',
  8: '~4.5,5 1.2,3.8 1,1.4 4.5,0 8,1.4 7.8,3.8 4.5,5 0.8,6.6 0.5,8.8 4.5,10 8.5,8.8 8.2,6.6 4.5,5',
  9: '~8.2,4.4 5.5,5.8 2,5.2 0.4,3 1.8,0.6 5,0 7.8,1.2 8.6,4 8,7.5 5.5,9.8 1.5,9.6',
  '!': '1.5,0 1.5,6.8|1.5,9.4 1.5,10', '?': '~0.4,2.3 2.5,0.2 5.5,0 8,1.6 8,3.8 4.5,5.8 4.3,7.2|4.3,9.4 4.3,10',
  '.': '1,9.4 1,10', ',': '1.5,9.2 0.5,11', '·': '1,4.8 1,5.3', '-': '0,5 6,5', "'": '1,0 0.6,3', '+': '0,5 8,5|4,1 4,9',
  '(': '~4,-0.5 1.2,2.5 0.5,5 1.2,7.5 4,10.5', ')': '~0,-0.5 2.8,2.5 3.5,5 2.8,7.5 0,10.5', '/': '0,10 6,0',
  '%': '0,10 8,0|~1.6,0 0.2,1.2 0.6,2.8 2.2,3.2 3.2,1.6 1.6,0|~6.4,6.8 5,8 5.4,9.6 7,10 8,8.4 6.4,6.8', ':': '1,3 1,3.5|1,9.4 1,10',
  '←': '0,5 13,5|4,1.5 0,5 4,8.5', '→': '0,5 13,5|9,1.5 13,5 9,8.5', '↓': '4,0 4,11|0.5,7.5 4,11 7.5,7.5',
  '♪': '5,8.6 5,0 8.6,2.8|~5,8.6 3.6,7.7 1.6,8 1,9.3 2.5,10 4.4,9.7 5,8.6',
  '♫': '3.4,8.6 3.4,1 9.4,0 9.4,7.6|3.4,2.8 9.4,1.8|~3.4,8.6 2.2,7.9 0.5,8.2 0.2,9.3 1.5,10 3,9.7 3.4,8.6|~9.4,7.6 8.2,6.9 6.5,7.2 6.2,8.3 7.5,9 9,8.7 9.4,7.6',
  '✓': '0,5.5 3,9 9,0', '★': '5,0 6.4,3.6 10,3.8 7.2,6.2 8.2,10 5,7.8 1.8,10 2.8,6.2 0,3.8 3.6,3.6 5,0',
};
const GLYPH_CACHE = {};
function glyph(ch) {
  if (GLYPH_CACHE[ch]) return GLYPH_CACHE[ch];
  const src = GLYPHS[ch];
  if (!src) return (GLYPH_CACHE[ch] = { strokes: [], w: ch === ' ' ? 5 : 6 });
  let maxX = 0;
  const strokes = src.split('|').map((st) => {
    const smooth = st[0] === '~';
    const pts = (smooth ? st.slice(1) : st).trim().split(/\s+/).map((q) => q.split(',').map(Number));
    for (const q of pts) maxX = Math.max(maxX, q[0]);
    return { smooth, pts };
  });
  return (GLYPH_CACHE[ch] = { strokes, w: maxX });
}
// Width of a marker string at a given cap height
function markerWidth(text, size) {
  let w = 0;
  for (const ch of text.toUpperCase()) w += (glyph(ch).w + 3.2) * size / 10;
  return w - 3.2 * size / 10;
}
// Marker text centred at (x, y), cap height `size`. A seeded wobble makes it look hand-written;
// a second, thinner offset pass reads as ink soaking into the fibres.
function markerText2(g, text, x, y, size, opts = {}) {
  const seed0 = opts.seed || (text.length * 977 + Math.round(size * 13));
  const color = opts.color || '#231a12', k = size / 10;
  const W = markerWidth(text, size);
  g.save();
  g.translate(x, y);
  g.rotate(opts.rot || 0);
  g.lineCap = g.lineJoin = 'round';
  const passes = opts.passes || [[1, 0.9, 0, 0], [0.62, 0.28, 0.35, 0.3]];  // [width scale, alpha, dx, dy]
  const chars = [...text.toUpperCase()];
  for (const [ws, alpha, dx, dy] of passes) {
    const r2 = mulberry32(seed0), rnd = mulberry32(seed0 + 101);          // same wobble on every pass
    let cx = -W / 2;
    g.strokeStyle = color;
    g.globalAlpha = alpha * (opts.alpha == null ? 1 : opts.alpha);
    const lw = size * (opts.weight || 0.13) * ws;
    for (const ch of chars) {
      const gl = glyph(ch);
      const bob = (r2() - 0.5) * size * 0.08, tilt = (r2() - 0.5) * 0.09, sc = 0.94 + r2() * 0.12;
      g.save();
      g.translate(cx + dx * k, -size / 2 + bob + dy * k);
      g.rotate(tilt);
      g.scale(k * sc, k * sc);
      g.lineWidth = lw / (k * sc);
      for (const st of gl.strokes) {
        const q = st.pts.map(([px, py]) => [px + (rnd() - 0.5) * 0.45, py + (rnd() - 0.5) * 0.45]);
        g.beginPath();
        g.moveTo(q[0][0], q[0][1]);
        if (st.smooth && q.length > 2) {
          for (let i = 1; i < q.length - 1; i++) g.quadraticCurveTo(q[i][0], q[i][1], (q[i][0] + q[i + 1][0]) / 2, (q[i][1] + q[i + 1][1]) / 2);
          g.lineTo(q[q.length - 1][0], q[q.length - 1][1]);
        } else for (let i = 1; i < q.length; i++) g.lineTo(q[i][0], q[i][1]);
        if (q.length === 2 && Math.hypot(q[1][0] - q[0][0], q[1][1] - q[0][1]) < 0.8) g.lineTo(q[0][0] + 0.3, q[0][1] + 0.3);   // dots
        g.stroke();
      }
      g.restore();
      cx += (gl.w + 3.2) * k;
    }
  }
  g.restore();
}
// SVG path data for the same lettering (HUD title), origin at the left of the baseline box, cap height `size`
function markerPath(text, size, seed = 31) {
  const r2 = mulberry32(seed), rnd = mulberry32(seed + 101), k = size / 10;
  let cx = 0, d = '';
  for (const ch of text.toUpperCase()) {
    const gl = glyph(ch);
    const bob = (r2() - 0.5) * size * 0.08, tilt = (r2() - 0.5) * 0.09, sc = 0.94 + r2() * 0.12;
    const cs = Math.cos(tilt) * k * sc, sn = Math.sin(tilt) * k * sc;
    const P = (px, py) => [(cx + px * cs - py * sn).toFixed(1), (bob + px * sn + py * cs).toFixed(1)].join(' ');
    for (const st of gl.strokes) {
      const q = st.pts.map(([px, py]) => [px + (rnd() - 0.5) * 0.45, py + (rnd() - 0.5) * 0.45]);
      d += 'M' + P(q[0][0], q[0][1]);
      if (st.smooth && q.length > 2) {
        for (let i = 1; i < q.length - 1; i++) d += 'Q' + P(q[i][0], q[i][1]) + ' ' + P((q[i][0] + q[i + 1][0]) / 2, (q[i][1] + q[i + 1][1]) / 2);
        d += 'L' + P(q[q.length - 1][0], q[q.length - 1][1]);
      } else for (let i = 1; i < q.length; i++) d += 'L' + P(q[i][0], q[i][1]);
      if (q.length === 2 && Math.hypot(q[1][0] - q[0][0], q[1][1] - q[0][1]) < 0.8) d += 'L' + P(q[0][0] + 0.3, q[0][1] + 0.3);
    }
    cx += (gl.w + 3.2) * k;
  }
  return { d, w: cx - 3.2 * k };
}
// Labels: `size` is a font size in px; the marker's cap height is about 0.72 of it. '\n' starts a new line.
function markerText(g, text, x, y, size, rot, color) {
  const lines = text.split('\n'), lh = size * 1.08;
  lines.forEach((ln, i) => {
    const dy = (i - (lines.length - 1) / 2) * lh;
    markerText2(g, ln, x - Math.sin(rot || 0) * dy, y + Math.cos(rot || 0) * dy, size * 0.72,
      { rot, color, weight: 0.15, seed: Math.round(x * 7 + y * 3 + ln.length + i * 17) });
  });
}
function markerArrow(g, from, to, color = 'rgba(30,22,15,0.85)', w = 2, bend = 0.2) {
  const [x0, y0] = from, [x1, y1] = to;
  const mx = (x0 + x1) / 2 + (y1 - y0) * bend, my = (y0 + y1) / 2 - (x1 - x0) * bend;
  g.save();
  g.strokeStyle = color; g.lineWidth = w; g.lineCap = g.lineJoin = 'round';
  g.beginPath(); g.moveTo(x0, y0); g.quadraticCurveTo(mx, my, x1, y1); g.stroke();
  const a = Math.atan2(y1 - my, x1 - mx), hl = 4 + w * 2;
  g.beginPath();
  g.moveTo(x1 - Math.cos(a - 0.5) * hl, y1 - Math.sin(a - 0.5) * hl);
  g.lineTo(x1, y1);
  g.lineTo(x1 - Math.cos(a + 0.45) * hl, y1 - Math.sin(a + 0.45) * hl);
  g.stroke();
  g.restore();
}
// Birch popsicle-stick wood: grain along u (4 px/unit: 128 x 32 units)
function genWoodTextures() {
  const W = 512, H = 128, nz = makeNoise2(41, 64);
  const c = cnv(W, H), g = c2d(c), id = g.createImageData(W, H), px = id.data;
  const h = new Float32Array(W * H), rough = new Float32Array(W * H), rnd = mulberry32(42);
  const streak = new Float32Array(H); for (let y = 0; y < H; y++) streak[y] = rnd();
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const u = x / W, v = y / H;
    const warp = nz(u * 8, v * 2, 8, 2) * 0.6 + nz(u * 16, v * 4, 16, 4) * 0.25;
    const ring = Math.sin((v * 34 + warp * 2.2) * Math.PI * 2);
    const line = Math.pow(0.5 + 0.5 * ring, 14) * 0.7;
    const fine = (streak[y] - 0.5) * 0.06 + (rnd() - 0.5) * 0.05;
    const tone = 1 - line * 0.17 + fine + (nz(u * 3, v * 2, 3, 2) - 0.5) * 0.12;
    const i = (y * W + x) * 4;
    px[i] = 232 * tone; px[i + 1] = 200 * tone; px[i + 2] = 148 * tone; px[i + 3] = 255;
    h[y * W + x] = 0.5 - line * 0.25 + fine * 0.8;
    rough[y * W + x] = 0.62 + line * 0.12;
  }
  g.putImageData(id, 0, 0);
  TEX.woodAlb = c;
  TEX.woodSurf = surfaceFromHeight(h, W, H, 2.2, rough, true);
}
// Masking tape: crepe paper (top half tiles along u; bottom half carries the hand-written FINISH label)
function genTapeTextures() {
  const W = 512, H = 256;
  const c = cnv(W, H), g = c2d(c);
  g.fillStyle = '#dac68f'; g.fillRect(0, 0, W, H);
  paintMottle(g, W, H, 81, 16, 0.2);
  const rnd = mulberry32(82);
  const hgt = new Float32Array(W * H).fill(0.5);
  const crepe = new Float32Array(W);
  let acc = 0;
  let ph = 0;
  for (let x = 0; x < W; x++) { acc += (rnd() - 0.5) * 0.9; acc *= 0.8; ph += 0.9 + rnd() * 1.4; crepe[x] = Math.sin(ph) * 0.25 + acc * 0.3; }
  const id = g.getImageData(0, 0, W, H), px = id.data;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x, v = (y % 128) / 128;
    const wav = crepe[(x + Math.round(Math.sin(y * 0.05) * 2) + W) % W];
    const edge = Math.min(v, 1 - v);
    const k = 1 + wav * 0.035 - (edge < 0.05 ? 0.08 * (1 - edge / 0.05) : 0) + (rnd() - 0.5) * 0.04;
    px[i * 4] *= k; px[i * 4 + 1] *= k; px[i * 4 + 2] *= k;
    px[i * 4 + 3] = 255;
    hgt[i] = 0.5 + wav * 0.25 + (rnd() - 0.5) * 0.06;
  }
  g.putImageData(id, 0, 0);
  TEX.tapeAlb = c;
  TEX.tapeSurf = surfaceFromHeight(hgt, W, H, 2.2, 0.62, true);
}

// Plain near-white with a whisper of noise (metal, glue, stickers, clips; tinted per vertex)
function genMiscTextures() {
  const W = 64, H = 64, c = cnv(W, H), g = c2d(c), id = g.createImageData(W, H), r = mulberry32(91);
  const h = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) { const k = 245 + (r() - 0.5) * 10; id.data[i * 4] = id.data[i * 4 + 1] = id.data[i * 4 + 2] = k; id.data[i * 4 + 3] = 255; h[i] = r(); }
  g.putImageData(id, 0, 0);
  TEX.miscAlb = c;
  blurF32(h, W, H, 1, true, 2);
  TEX.miscSurf = surfaceFromHeight(h, W, H, 1.5, 1, true);
}
// Painted cinder-block classroom wall: one tile of 10 x 10 blocks (WALL_TEX.uw x uh units), seamless both ways, so
// the wall can run as far round a tower as the camera sees (the room adds a gentle large-scale tone on top). It holds
// the paint (block-to-block tone, roller laps, pits) at 0.26 px per unit; the mortar joints are the shader's.
const WALL_TEX = { w: 1280, h: 640, uw: 5000, uh: 2500 };
function* genWallTextures() {
  const { w: W, h: H, uw } = WALL_TEX, s = W / uw;
  const c = cnv(W, H), g = c2d(c);
  g.fillStyle = '#cbc3b1'; g.fillRect(0, 0, W, H);
  paintMottle(g, W, H, 101, 6, 0.25, 'soft-light', null, true);
  paintMottle(g, W, H, 102, 40, 0.18, 'soft-light', null, true);
  // paint-roller laps: faint vertical bands (full height, so they tile)
  const rr = mulberry32(104);
  for (let x = 0; x < W - 12; x += 9 + rr() * 10) { g.fillStyle = rr() < 0.5 ? 'rgba(255,250,238,0.035)' : 'rgba(80,70,55,0.03)'; g.fillRect(x, 0, 6 + rr() * 12, H); }
  const hc = cnv(W, H), hg = c2d(hc);
  hg.fillStyle = '#909090'; hg.fillRect(0, 0, W, H);
  const BW = 500, BH = 250, J = 11;                      // block and joint size (units)
  const rnd = mulberry32(103), tones = [];
  for (let i = 0; i < 100; i++) tones.push((rnd() - 0.5) * 0.06);
  for (let row = -1; row * BH < WALL_TEX.uh + BH; row++) {
    const off = (row % 2) * BW / 2;
    for (let col = -1; col * BW < uw + BW; col++) {
      const x = (col * BW + off) * s, y = row * BH * s, bw = (BW - J) * s, bh = (BH - J) * s;
      const tone = tones[((row % 10) + 10) % 10 * 10 + ((Math.floor((col * BW + off) / BW) % 10) + 10) % 10];   // (a block and its copy across the seam match)
      g.fillStyle = tone > 0 ? `rgba(255,252,240,${tone})` : `rgba(90,80,60,${-tone})`;
      g.fillRect(x, y, bw, bh);               // (the mortar joints between the blocks are drawn by the shader, exactly: `uWall`)
    }
  }
  yield;
  const id = g.getImageData(0, 0, W, H), px = id.data;
  const hgt = grayOf(hc);
  for (let i = 0; i < W * H; i++) {
    const p = rnd();
    let k = 1 + (p - 0.5) * 0.05;
    if (p < 0.006) { k *= 0.94; hgt[i] -= 0.12; }           // pits in the block face
    px[i * 4] *= k; px[i * 4 + 1] *= k; px[i * 4 + 2] *= k; px[i * 4 + 3] = 255;
    hgt[i] += (rnd() - 0.5) * 0.08;
  }
  g.putImageData(id, 0, 0);
  TEX.wallAlb = c;
  yield;
  blurF32(hgt, W, H, 1, true, 1);
  TEX.wallSurf = surfaceFromHeight(hgt, W, H, 3, 0.72, true);
}
// Butcher-block desk top (tiling: 1 px/unit, 1024 x 1024 units). Strips run along x.
function genDeskTextures() {
  const W = 512, H = 512, nz = makeNoise2(111, 64);
  const c = cnv(W, H), g = c2d(c), id = g.createImageData(W, H), px = id.data;
  const h = new Float32Array(W * H), rough = new Float32Array(W * H), rnd = mulberry32(112);
  const SW = 26;                                           // strip width (texels; 2 units each)
  const stripTone = [], stripPhase = [];
  for (let k = 0; k < H / SW + 2; k++) { stripTone.push(0.82 + rnd() * 0.3); stripPhase.push(rnd() * 10); }
  for (let y = 0; y < H; y++) {
    const k = Math.floor(y / SW), vy = (y % SW) / SW;
    for (let x = 0; x < W; x++) {
      const u = x / W;
      const warp = nz(u * 6, y / 32, 6, 16) * 2 + nz(u * 24, y / 16, 24, 32) * 0.3;
      const ring = Math.sin((vy * 5 + warp * 1.6 + stripPhase[k]) * Math.PI * 2);
      const line = Math.pow(0.5 + 0.5 * ring, 8);
      const tone = stripTone[k] * (1 - line * 0.22 + (rnd() - 0.5) * 0.05) * (vy < 0.02 || vy > 0.98 ? 0.75 : 1);
      const i = (y * W + x) * 4;
      px[i] = 196 * tone; px[i + 1] = 146 * tone; px[i + 2] = 92 * tone; px[i + 3] = 255;
      h[y * W + x] = 0.5 - line * 0.1 - (vy < 0.02 || vy > 0.98 ? 0.3 : 0);
      rough[y * W + x] = 0.38 + line * 0.1 + nz(u * 12, y / 32, 12, 16) * 0.12;
    }
  }
  g.putImageData(id, 0, 0);
  g.lineCap = 'round';                                     // scratches and a stray pencil mark
  for (let i = 0; i < 60; i++) {
    const x = rnd() * W, y = rnd() * H, a = (rnd() - 0.5) * 0.6, l = 20 + rnd() * 80;
    g.strokeStyle = `rgba(255,235,200,${0.05 + rnd() * 0.08})`; g.lineWidth = 0.8;
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); g.stroke();
  }
  g.strokeStyle = 'rgba(60,60,70,0.35)'; g.lineWidth = 1.2;
  g.beginPath(); g.moveTo(300, 610); g.quadraticCurveTo(360, 590, 420, 640); g.stroke();
  TEX.deskAlb = c;
  TEX.deskSurf = surfaceFromHeight(h, W, H, 2, rough, true);
}
// Paper atlas: a child's crayon drawing taped to the wall (left half) and a sticky note that points at the tube (top right)
const NOTE_UV = { drawing: [0, 0, 0.5, 1], sticky: [0.5, 0, 0.75, 0.5] };
function genNoteTextures() {
  const W = 1024, H = 512, c = cnv(W, H), g = c2d(c), rnd = mulberry32(141);
  g.fillStyle = '#8a7a66'; g.fillRect(0, 0, W, H);
  // (a) crayon drawing on printer paper
  g.fillStyle = '#f4f1e8'; g.fillRect(0, 0, 512, 512);
  paintMottle(g, 512, 512, 142, 10, 0.06);
  const crayon = (pts, col, w = 7, smooth = true) => {
    for (let pass = 0; pass < 3; pass++) {
      g.strokeStyle = col; g.globalAlpha = 0.55; g.lineWidth = w * (1 - pass * 0.2); g.lineCap = g.lineJoin = 'round';
      g.beginPath();
      pts.forEach(([x, y], i) => { const jx = x + (rnd() - 0.5) * 2.5, jy = y + (rnd() - 0.5) * 2.5; if (!i) g.moveTo(jx, jy); else if (smooth) g.lineTo(jx, jy); else g.lineTo(jx, jy); });
      g.stroke();
    }
    g.globalAlpha = 1;
  };
  const arc = (cx, cy, r, a0, a1, col, w) => { const pts = []; for (let k = 0; k <= 24; k++) { const a = a0 + (a1 - a0) * k / 24; pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]); } crayon(pts, col, w); };
  // rainbow and sun
  ['#e8453c', '#f39a2b', '#f2d23a', '#57b347', '#3f7fd6'].forEach((col, i) => arc(256, 250, 170 - i * 11, Math.PI * 1.08, Math.PI * 1.92, col, 10));
  arc(440, 70, 30, 0, Math.PI * 2, '#f2c23a', 9);
  for (let k = 0; k < 9; k++) { const a = k / 9 * Math.PI * 2; crayon([[440 + Math.cos(a) * 42, 70 + Math.sin(a) * 42], [440 + Math.cos(a) * 58, 70 + Math.sin(a) * 58]], '#f2c23a', 6); }
  // the marble run: a board with zig-zag ramps, a tube, a cup and marbles
  crayon([[150, 150], [362, 150], [362, 440], [150, 440], [150, 150]], '#9b6a3a', 6);
  crayon([[244, 92], [244, 140]], '#8a6a4a', 8); crayon([[268, 92], [268, 140]], '#8a6a4a', 8);
  crayon([[170, 200], [290, 230]], '#7a4a22', 8); crayon([[345, 250], [230, 285]], '#7a4a22', 8);
  crayon([[165, 320], [285, 350]], '#7a4a22', 8); crayon([[340, 370], [270, 400]], '#7a4a22', 8);
  crayon([[230, 452], [238, 492], [284, 492], [292, 452]], '#4aa0c8', 6);
  for (const [x, y, col] of [[205, 190, '#3f7fd6'], [300, 240, '#e8453c'], [215, 310, '#57b347'], [262, 470, '#9b5bd6']]) {
    g.fillStyle = col; g.globalAlpha = 0.75; g.beginPath(); g.arc(x, y, 11, 0, Math.PI * 2); g.fill(); g.globalAlpha = 1;
  }
  crayon([[200, 210], [196, 240], [205, 270]], '#555', 3); crayon([[296, 262], [300, 290]], '#555', 3);
  markerText2(g, 'MY MARBLE RUN', 250, 46, 24, { rot: -0.05, color: '#3a55a8', weight: 0.2, seed: 17 });
  markerText2(g, 'BY ME, AGE 6', 392, 488, 14, { rot: 0.04, color: '#e8453c', weight: 0.2, seed: 19 });
  // crayon skips on the paper grain
  for (let i = 0; i < 9000; i++) { g.fillStyle = 'rgba(244,241,232,0.55)'; g.fillRect(rnd() * 512, rnd() * 512, 1.4, 1.4); }
  // (b) sticky note
  g.fillStyle = '#ffe36b'; g.fillRect(512, 0, 256, 256);
  paintMottle(g, W, H, 143, 12, 0.05);
  g.fillStyle = 'rgba(160, 120, 0, 0.1)'; g.fillRect(512, 0, 256, 48);
  g.fillStyle = '#ffe36b'; g.globalAlpha = 0.2; g.fillRect(512, 250, 256, 6); g.globalAlpha = 1;
  markerText2(g, '♪ MARBLE', 640, 70, 24, { rot: -0.04, color: '#1f1712', weight: 0.22, seed: 23 });
  markerText2(g, 'MUSIC!', 632, 124, 30, { rot: -0.03, color: '#c22a1e', weight: 0.22, seed: 24 });
  markerText2(g, '♫ ♪ ♫', 640, 190, 26, { rot: 0.02, color: '#2a55b0', weight: 0.2, seed: 25 });
  TEX.noteAlb = c;
  const h = new Float32Array(W * H), r = mulberry32(144);
  for (let i = 0; i < h.length; i++) h[i] = r() * 0.25;
  blurF32(h, W, H, 1, true, 1);
  const rough = new Float32Array(W * H);
  rough.fill(0.88);
  TEX.noteSurf = surfaceFromHeight(h, W, H, 1.6, rough, true);
}
/* ---- HDR environment: a sunny classroom (window on the left, ceiling lights, warm walls) ----
 *  Evaluated analytically; `blur` (0..1) widens every feature for the rougher mip levels. */
const SUN_DIR = V3.norm([-0.52, 0.62, 0.58]);          // towards the key light (upper left, in front)
// `diffuse`: the light the room sheds on matt surfaces (the spherical harmonics); the reflections (the prefiltered
// map) also see the bright room behind the viewer, a lit wall and a long ceiling light, which put crisp streaks on
// rods, bevels and domes without changing the tone of the board or the wall.
// `mirror`: the room as chrome and glass see it (a dim room with bright, crisp features, see RM); its luminance is stored in
// the cube's alpha (genEnvironment) and the shader gives the plain room's colour that luminance, so only the sharpest mirrors
// use it and every matt or satin metal keeps the pale daylit room it was tuned against.
// The mirror room: the tone of the walls and the desk between the lights, and the lights (azimuth from the board's
// normal, elevation, in degrees: from, to, from, to; radiance; green and blue relative to red). Azimuth > 0 is the viewer's right.
const RM = {
  wall: 0.06, desk: 0.07, edge: 0.03,
  feats: [
    [-16, 16, -8, 62, 3.0, 0.99, 0.95],          // the light column behind the viewer: a whiteboard and the ceiling panel over it
    [-110, -72, -6, 54, 4.0, 1.0, 1.1],          // the window (the sun comes through it, up on the left)
    [72, 110, -6, 54, 3.4, 1.0, 0.95],           // a door and a second window on the right
    [-16, 16, -60, -10, 1.6, 0.95, 0.85],        // the sunlit desk in front of the whiteboard
    [-110, -72, -60, -10, 2.0, 0.9, 0.7],        // the patch of sun the window throws on the desk
    [72, 110, -60, -10, 1.8, 0.95, 0.85],        // and its bounce on the other side
  ],
};
function envRadiance(d, blur, diffuse = false, mirror = false) {
  const [x, y, z] = d;
  const soft = 0.012 + blur * blur * 0.8;              // angular edge softness (radians)
  const sm = (e0, e1, v) => { const t = clamp((v - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };
  // room: warm floor/desk below, pale walls at the horizon, a brighter ceiling, the sunlit wall behind the board
  let r, g, b;
  if (y < 0) { const k = sm(0, -0.35 - soft, y); r = lerp(0.14, 0.085, k); g = lerp(0.125, 0.06, k); b = lerp(0.11, 0.04, k); }
  else { const k = sm(0, 0.85, y); r = lerp(0.14, 0.22, k); g = lerp(0.135, 0.215, k); b = lerp(0.125, 0.2, k); }
  if (z < -0.15) { const k = sm(-0.15, -0.55, z) * (1 - sm(0.25, 0.8, y)) * (1 - sm(0, -0.4, y)); r = lerp(r, 0.34, k); g = lerp(g, 0.31, k); b = lerp(b, 0.27, k); }
  // the window: a bright rectangle up and to the left, with mullions (sharp levels only)
  const az = Math.atan2(x, z), el = Math.asin(clamp(y, -1, 1));
  const waz = Math.atan2(SUN_DIR[0], SUN_DIR[2]) + 0.12, wel = 0.44, hu = 0.46, hv0 = -0.3, hv1 = 0.34;
  const du = Math.abs(az - waz), dv = el - wel;
  const s2 = Math.min(soft, 0.9 * hu);
  const inWin = sm(hu + s2, hu - s2, du) * sm(hv0 - s2, hv0 + s2, dv) * sm(hv1 + s2, hv1 - s2, dv) * (hu / Math.max(hu, soft));
  if (inWin > 0) {
    let mull = 1;
    if (blur < 0.3 && diffuse) {          // (the reflections see no mullions: a hairline in the plain room would leave a hairline in the mirror room's gain)
      const mw = 0.016 + soft * 0.5;
      const cu = Math.abs(((az - waz) / 0.23) - Math.round((az - waz) / 0.23)) * 0.23;
      const cv = Math.abs(((dv - 0.02) / 0.32) - Math.round((dv - 0.02) / 0.32)) * 0.32;
      mull = (1 - (1 - sm(mw * 0.5, mw, cu)) * 0.9) * (1 - (1 - sm(mw * 0.5, mw, cv)) * 0.9);
    }
    const sky = 1 - 0.3 * sm(-0.3, 0.3, dv);
    const L = 1.85 * mull * sky;
    r += (0.85 * L - r) * inWin; g += (0.95 * L - g) * inWin; b += (1.15 * L - b) * inWin;
  }
  if (!diffuse) {
    // (the mirror room fades back to the pale one as the blur grows: a rough reflection averages the lights and the walls)
    const crisp = mirror ? 1 - sm(0.25, 0.9, blur) : 0;
    // below the horizon the reflections see the sunlit desk, not a dark floor: down-facing metal (the undersides of
    // bars, rail ties from below) would otherwise go black (the matt surfaces' spherical harmonics keep their own tone)
    if (y < 0) { const kf = sm(0, -0.35 - soft, y), f = lerp(0.32, 0.22, kf), w = 0.85; r = lerp(r, f, w); g = lerp(g, f * 0.93, w); b = lerp(b, f * 0.8, w); }
    // the room round and behind the viewer: pale walls in daylight above, the sunlit desk below
    // (the two meet at eye level with no dark seam between them)
    const kr = sm(-0.5, -0.05, z) * sm(-0.06, 0.1, y), kd = sm(-0.5, -0.05, z) * sm(0.02, -0.08, y) * (1 - sm(-0.75, -0.95, y));
    const wl = lerp(0.65, RM.wall, crisp), dl = lerp(0.65, RM.desk, crisp);
    r = lerp(r, wl, kr); g = lerp(g, wl * 0.985, kr); b = lerp(b, wl * 0.94, kr);
    r = lerp(r, dl, kd); g = lerp(g, dl * 0.97, kd); b = lerp(b, dl * 0.91, kd);
    // a bright wall facing the board, behind the viewer (a soft rectangle: the blur of the lights below)
    const s3 = Math.max(soft, 0.05), az2 = Math.atan2(x, z), el2 = Math.asin(clamp(y, -1, 1));
    const wall = sm(0.75 + s3, 0.75 - s3, Math.abs(az2 + 0.15)) * sm(-0.02 - s3, -0.02 + s3, el2) * sm(0.5 + s3, 0.5 - s3, el2) * (1 - crisp);
    r = lerp(r, 1.35, wall); g = lerp(g, 1.32, wall); b = lerp(b, 1.26, wall);
    // a long ceiling light strip running left-right over the viewer's head, and a second one over the board's side of
    // the room (crisp at the sharp levels: the reflections of rods and domes slide across them as the view turns)
    // (the mirror room's strips are wider and softer, with the same energy: against its dim walls a 10-degree strip would be a hairline)
    const w1 = lerp(0.09, 0.2, crisp), w2 = lerp(0.06, 0.14, crisp);
    const strip = sm(w1 + s3, w1 - s3, Math.abs(Math.atan2(z - 0.35, y))) * sm(0.9 + s3, 0.9 - s3, Math.abs(x)) * (y > 0 ? 1 : 0) * (w1 / Math.max(w1, s3)) * (0.09 / w1);
    r += 4.2 * strip; g += 4.2 * strip; b += 4.0 * strip;
    const strip2 = sm(w2 + s3, w2 - s3, Math.abs(Math.atan2(z + 0.42, y))) * sm(0.85 + s3, 0.85 - s3, Math.abs(x)) * (y > 0 ? 1 : 0) * (w2 / Math.max(w2, s3)) * (0.06 / w2);
    r += 3.2 * strip2; g += 3.2 * strip2; b += 3.0 * strip2;
    // a bright door / whiteboard on the wall behind the viewer, off to one side (a crisp rectangle at the sharp levels)
    const s4 = Math.max(soft, 0.012);
    const door = sm(0.17 + s4, 0.17 - s4, Math.abs(az2 - 0.62)) * sm(-0.3 - s4, -0.3 + s4, el2) * sm(0.34 + s4, 0.34 - s4, el2) * (z > 0 ? 1 : 0) * (1 - crisp);
    r = lerp(r, 1.9, door); g = lerp(g, 1.85, door); b = lerp(b, 1.75, door);
    // the lit features of the mirror room, as soft-edged rectangles
    if (crisp > 0) {
      const sf = Math.max(soft, RM.edge);
      for (const f of RM.feats) {
        const k = sm(f[0] * RAD - sf, f[0] * RAD + sf, az2) * sm(f[1] * RAD + sf, f[1] * RAD - sf, az2) * sm(f[2] * RAD - sf, f[2] * RAD + sf, el2) * sm(f[3] * RAD + sf, f[3] * RAD - sf, el2) * sm(-0.3, -0.1, z) * crisp;
        if (k > 0) { r = lerp(r, f[4], k); g = lerp(g, f[4] * f[5], k); b = lerp(b, f[4] * f[6], k); }
      }
    }
  }
  // two fluorescent ceiling panels (energy-conserving when blurred)
  const rho = 0.1;
  for (const [cx, cz] of [[0.15, 0.45], [0.2, -0.15]]) {
    const n = V3.norm([cx, 1, cz]), a = Math.acos(clamp(V3.dot(d, n), -1, 1));
    const sp = soft * 1.2;
    const k = sm(rho + sp, Math.max(0, rho - sp), a) * (rho * rho) / (rho * rho + sp * sp);
    if (k > 0) { r += 1.3 * k; g += 1.3 * k; b += 1.25 * k; }
  }
  return [r, g, b];
}

function* genEnvironment(gl, out) {
  const sizes = [128, 64, 32, 16, 8];
  const faceDir = (f, u, v) => {
    switch (f) {
      case 0: return [1, -v, -u]; case 1: return [-1, -v, u];
      case 2: return [u, 1, v]; case 3: return [u, -1, -v];
      case 4: return [u, -v, 1]; default: return [-u, -v, -1];
    }
  };
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_CUBE_MAP, tex);
  gl.texStorage2D(gl.TEXTURE_CUBE_MAP, sizes.length, gl.RGBA16F, sizes[0], sizes[0]);
  sizes.forEach((S, level) => {
    const blur = level / (sizes.length - 1);
    for (let f = 0; f < 6; f++) {
      const data = new Float32Array(S * S * 4);
      for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
        const d = V3.norm(faceDir(f, (x + 0.5) / S * 2 - 1, (y + 0.5) / S * 2 - 1));
        const c = envRadiance(d, blur), m = envRadiance(d, blur, false, true), i = (y * S + x) * 4;
        data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; data[i + 3] = 0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2];   // (alpha: the mirror room's luminance)
      }
      gl.texSubImage2D(gl.TEXTURE_CUBE_MAP_POSITIVE_X + f, level, 0, 0, S, S, gl.RGBA, gl.FLOAT, data);
    }
  });
  yield;
  gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  // Diffuse irradiance as 9 spherical-harmonic coefficients
  const sh = new Float32Array(27), N1 = 128, N2 = 64;
  let wsum = 0;
  for (let j = 0; j < N2; j++) for (let i = 0; i < N1; i++) {
    const th = (j + 0.5) / N2 * Math.PI, ph = (i + 0.5) / N1 * Math.PI * 2;
    const d = [Math.sin(th) * Math.cos(ph), Math.cos(th), Math.sin(th) * Math.sin(ph)];
    const c = envRadiance(d, 0.05, true), w = Math.sin(th);
    const [x, y, z] = d;
    const basis = [0.282095, 0.488603 * y, 0.488603 * z, 0.488603 * x, 1.092548 * x * y, 1.092548 * y * z,
      0.315392 * (3 * z * z - 1), 1.092548 * x * z, 0.546274 * (x * x - y * y)];
    for (let k = 0; k < 9; k++) for (let ch = 0; ch < 3; ch++) sh[k * 3 + ch] += c[ch] * basis[k] * w;
    wsum += w;
  }
  const norm = (4 * Math.PI) / wsum;
  for (let k = 0; k < 27; k++) sh[k] *= norm;
  out.env = { tex, levels: sizes.length, sh };
}

/* ============================================================================
 *  The metal workshop set: pegboard, brushed metal, engraved note letters
 * ========================================================================== */
// Tempered hardboard pegboard: one 320-unit tile of grain (mottle and fibres) at 2 px per unit. The HOLES are not in the
// texture: the shader draws them from the position (a hole every 20 units: the snap grid, 3.7 units in radius), exactly
// at any zoom, with parallax down each bore (FS_PBR, `uPeg`). uv = (x + 10) / 320 keeps the grain registered to the
// holes' grid. Albedo alpha is 1 (the occlusion round the holes comes from the shader).
const PEG = { tile: 320, pitch: 20, hole: 3.7, px: 2 };
function* genPegboardTextures() {
  const S = PEG.tile * PEG.px;
  const c = cnv(S, S), g = c2d(c);
  g.fillStyle = '#a07a52'; g.fillRect(0, 0, S, S);
  // (every layer tiles: large-scale tone changes come from the board mesh's own vertex colours)
  paintMottle(g, S, S, 201, 6, 0.04, 'soft-light', null, true);
  paintMottle(g, S, S, 202, 30, 0.1, 'soft-light', null, true);
  paintMottle(g, S, S, 203, 120, 0.1, 'soft-light', null, true);
  paintFibres(g, S, S, 7200, 204, 'rgba(255,225,185,0.07)', 'rgba(60,35,15,0.09)', 4.7, 0.9, true);
  g.getImageData(0, 0, 1, 1); yield;
  const id = g.getImageData(0, 0, S, S), px = id.data;
  const hgt = new Float32Array(S * S), rough = new Float32Array(S * S), rnd = mulberry32(205), nz = makeNoise2(206, 64);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const i = y * S + x, k = i * 4;
    const grain = (nz(x / S * 32, y / S * 32, 32) - 0.5) * 0.06 + (rnd() - 0.5) * 0.05;
    px[k] *= 1 + grain; px[k + 1] *= 1 + grain; px[k + 2] *= 1 + grain; px[k + 3] = 255;
    hgt[i] = 0.62 + grain * 0.4; rough[i] = 0.52 + (nz(x / S * 8, y / S * 8, 8) - 0.5) * 0.12;
  }
  g.putImageData(id, 0, 0);
  TEX.pegAlb = c;
  yield;
  TEX.pegSurf = surfaceFromHeight(hgt, S, S, 3.2, rough, true);
}

// The pegboard's hole pattern as the pieces' reflections see it (FS_PBR, pegSeen): one 20-unit cell, the hole in the middle
// (1 = board, down to 0.1 in the bore, a darker bevel round it), R8 and mipmapped: the GPU's anisotropic filter then averages it
// along the long side of a pixel's footprint, so it never aliases whatever the reflection's stretch
function genPegHoleTile(gl, size = 128) {
  const px = new Uint8Array(size * size), c = size / 2, R = PEG.hole, ss = 4;
  const sm = (e0, e1, v) => { const t = clamp((v - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };
  let sum = 0;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let v = 0;
    for (let j = 0; j < ss; j++) for (let i = 0; i < ss; i++) {
      const d = Math.hypot((x + (i + 0.5) / ss - c) * PEG.pitch / size, (y + (j + 0.5) / ss - c) * PEG.pitch / size);
      v += 1 - 0.9 * (1 - sm(R - 0.25, R + 0.25, d)) - 0.25 * (1 - sm(R, R + 1.8, d));
    }
    px[y * size + x] = Math.round(255 * v / (ss * ss)); sum += px[y * size + x];
  }
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, size, size, 0, gl.RED, gl.UNSIGNED_BYTE, px);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.generateMipmap(gl.TEXTURE_2D);
  const ext = gl.getExtension('EXT_texture_filter_anisotropic');
  if (ext) gl.texParameterf(gl.TEXTURE_2D, ext.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(GLR.aniso || 8, gl.getParameter(ext.MAX_TEXTURE_MAX_ANISOTROPY_EXT)));
  genPegHoleTile.mean = sum / (size * size * 255);
  return t;
}

// Brushed metal (tiling, 512 x 512 = 128 x 128 units): long fine streaks along u. Tinted per vertex for
// steel, anodised aluminium and brass; roughness scaled per vertex (chrome = nearly a mirror).
function genMetalTextures() {
  const W = 512, H = 512, rnd = mulberry32(211);
  const hgt = new Float32Array(W * H), rough = new Float32Array(W * H);
  const c = cnv(W, H), g = c2d(c), id = g.createImageData(W, H), px = id.data;
  const nz = makeNoise2(212, 64);
  const rows = new Float32Array(H);
  for (let y = 0; y < H; y++) rows[y] = rnd();
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    // very fine streaks along u (a row's value drifting slowly), a whisper of scratches
    const streak = rows[y] * 0.35 + nz(x / W * 6, y / H * 256, 6, 256) * 0.45 + rnd() * 0.2;
    const i = y * W + x;
    hgt[i] = streak * 0.5;
    rough[i] = 0.24 + (streak - 0.5) * 0.05;
    const v = 236 + (streak - 0.5) * 7;
    px[i * 4] = v; px[i * 4 + 1] = v; px[i * 4 + 2] = v + 1; px[i * 4 + 3] = 255;
  }
  g.putImageData(id, 0, 0);
  TEX.metalAlb = c;
  TEX.metalSurf = surfaceFromHeight(hgt, W, H, 0.35, rough, true);
}

// Engraved note names for the bars' front faces: one 128 x 64 cell per note, MIDI 36 (C2) .. 99.
// Alpha is the engraving mask (the cut shows bright bare aluminium through the anodised colour).
const LETTER_ATLAS = { cols: 8, rows: 8, first: 36, blank: 63 };
function letterCellUV(note, u, v) {                 // u, v in 0..1 within the cell -> atlas uv (note null: the blank cell)
  const m = note == null ? LETTER_ATLAS.blank : clamp((noteToMidi(note) ?? 60) - LETTER_ATLAS.first, 0, 62);
  return [((m % 8) + u) / 8, (Math.floor(m / 8) + v) / 8];
}
function genLetterTextures() {
  const W = 1024, H = 512, c = cnv(W, H), g = c2d(c);
  g.clearRect(0, 0, W, H);
  const hc = cnv(W, H), hg = c2d(hc);
  hg.fillStyle = '#808080'; hg.fillRect(0, 0, W, H);
  g.textAlign = hg.textAlign = 'center'; g.textBaseline = hg.textBaseline = 'middle';
  for (let m = 0; m < 63; m++) {
    const note = midiToNote(LETTER_ATLAS.first + m), cx = (m % 8) * 128 + 64, cy = Math.floor(m / 8) * 64 + 33;
    const txt = noteLabel(note);
    g.font = hg.font = `bold 44px ${'"Helvetica Neue", Arial, "Liberation Sans", sans-serif'}`;
    g.fillStyle = 'rgba(236, 238, 242, 0.95)'; g.fillText(txt, cx, cy);
    hg.fillStyle = '#303030'; hg.fillText(txt, cx, cy);
  }
  TEX.lettersAlb = c;
  const h = grayOf(hc);
  blurF32(h, W, H, 1, false, 1);
  const rough = new Float32Array(W * H);
  for (let i = 0; i < rough.length; i++) rough[i] = h[i] < 0.45 ? 0.16 : 0.24;
  TEX.lettersSurf = surfaceFromHeight(h, W, H, 2.2, rough, false);
}
