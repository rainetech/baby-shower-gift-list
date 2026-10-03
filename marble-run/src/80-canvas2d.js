
/* ============================================================================
 *  RENDERING (fallback): Canvas 2D. Used when WebGL2 is missing or fails, and
 *  for the tray icons. Same camera idea (fit + pan/zoom), same overlay, same
 *  builder and playback; a flatter look (gradients for the metal, soft shadows).
 * ========================================================================== */
// Draw one piece in board units (the context's transform maps board units to pixels). fx: { glow, wiggle }
function drawPiece2D(g, p, fx, t = 0) {
  const glow = fx ? fx.glow : 0, wig = fx && !reducedMotion ? Math.sin(t * 62) * 0.028 * fx.wiggle : 0;
  g.save();
  g.translate(p.x, p.y);
  if (p.type !== 'dropper') g.rotate((p.rot || 0) * RAD + wig);
  const col = p.note ? noteHex(p.note) : '#c9ced6';
  const shade = (hex, k) => mixHex(hex, k > 0 ? '#ffffff' : '#000000', Math.abs(k));
  const steelGrad = (y0, y1, base = '#b7bcc4') => { const gr = g.createLinearGradient(0, y0, 0, y1); gr.addColorStop(0, shade(base, 0.55)); gr.addColorStop(0.45, base); gr.addColorStop(1, shade(base, -0.35)); return gr; };
  const capsule = (L, hw) => { g.beginPath(); g.moveTo(-L / 2, -hw); g.lineTo(L / 2, -hw); g.arc(L / 2, 0, hw, -Math.PI / 2, Math.PI / 2); g.lineTo(-L / 2, hw); g.arc(-L / 2, 0, hw, Math.PI / 2, Math.PI * 1.5); g.closePath(); };
  const rrect = (x, y, w, h, r) => { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); };
  switch (p.type) {
    case 'bar': {
      const hx = p.len / 2 + 5;
      rrect(-hx, -5, hx * 2, 10, 2.2);
      const gr = g.createLinearGradient(0, -5, 0, 5);
      gr.addColorStop(0, shade(col, 0.5)); gr.addColorStop(0.35, col); gr.addColorStop(1, shade(col, -0.4));
      g.fillStyle = gr; g.fill();
      g.strokeStyle = shade(col, -0.55); g.lineWidth = 0.8; g.stroke();
      g.fillStyle = 'rgba(255,255,255,0.45)'; g.fillRect(-hx + 2, -4.2, hx * 2 - 4, 1.1);
      const nx = hx * 2 * (0.5 - 0.224);
      for (const x of [-nx, nx]) { g.fillStyle = '#1b1b1f'; g.beginPath(); g.ellipse(x, -5.2, 3.2, 1.3, 0, 0, Math.PI * 2); g.fill(); g.fillStyle = '#e8eaee'; g.beginPath(); g.ellipse(x, -5.6, 1.7, 0.8, 0, 0, Math.PI * 2); g.fill(); }
      if (p.len >= 26) { g.fillStyle = 'rgba(255,255,255,0.92)'; g.font = `bold 6.4px ${UI_FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(noteLabel(p.note), 0, 0.6); }
      break;
    }
    case 'rail': case 'curve': {
      const path = () => { g.beginPath(); if (p.type === 'rail') { g.moveTo(-p.len / 2, -1.9); g.lineTo(p.len / 2, -1.9); } else g.arc(0, 0, p.r, 0, p.sweep * RAD); };
      g.lineCap = 'round';
      path(); g.strokeStyle = 'rgba(40,42,48,0.9)'; g.lineWidth = 6.4; g.stroke();
      path(); g.strokeStyle = '#d9dde3'; g.lineWidth = 4.6; g.stroke();
      path(); g.strokeStyle = '#ffffff'; g.lineWidth = 1.4; g.stroke();
      g.fillStyle = col;
      if (p.type === 'rail') { const n = Math.max(2, Math.round(p.len / 46) + 1); for (let i = 0; i < n; i++) { const x = -p.len / 2 + 6 + (p.len - 12) * i / (n - 1); g.fillRect(x - 1.8, 0.8, 3.6, 3.4); } }
      else { const n = Math.max(2, Math.round((p.sweep * RAD * p.r) / 40) + 1); for (let i = 0; i < n; i++) { const a = (p.sweep * (i + 0.5) / n) * RAD; g.beginPath(); g.arc(Math.cos(a) * p.r, Math.sin(a) * p.r, 2.2, 0, Math.PI * 2); g.fill(); } }
      break;
    }
    case 'bell': {
      const r = p.r, gr = g.createRadialGradient(-r * 0.35, -r * 0.4, r * 0.1, 0, 0, r);
      gr.addColorStop(0, '#fff6d8'); gr.addColorStop(0.35, '#e9b95a'); gr.addColorStop(0.85, '#a86f1e'); gr.addColorStop(1, '#6f4610');
      g.beginPath(); g.arc(0, 0, r, 0, Math.PI * 2); g.fillStyle = gr; g.fill();
      g.strokeStyle = col; g.lineWidth = Math.max(2, r * 0.18); g.beginPath(); g.arc(0, 0, r - g.lineWidth / 2, 0, Math.PI * 2); g.stroke();
      g.fillStyle = '#f4f5f7'; g.beginPath(); g.arc(0, 0, Math.max(1.6, r * 0.14), 0, Math.PI * 2); g.fill();
      break;
    }
    case 'spring': {
      const hx = p.len / 2 + 5;
      g.strokeStyle = '#9aa0a8'; g.lineWidth = 1.4;
      for (const x of p.len > 90 ? [-hx + 8, 0, hx - 8] : [-hx + 9, hx - 9]) { g.beginPath(); for (let i = 0; i <= 12; i++) g.lineTo(x + (i % 2 ? 3.6 : -3.6), 5 + i * 13 / 12); g.stroke(); }
      rrect(-hx + 2, 18.4, hx * 2 - 4, 3.2, 1.2); g.fillStyle = steelGrad(18, 22); g.fill();
      rrect(-hx, -1, hx * 2, 6, 1.2); g.fillStyle = steelGrad(-1, 5); g.fill();
      rrect(-hx, -5, hx * 2, 4.4, 1.8); g.fillStyle = col; g.fill();
      break;
    }
    case 'wall': {
      const hx = p.len / 2 + 5;
      rrect(-hx, -5, hx * 2, 10, 1.8); g.fillStyle = steelGrad(-5, 5, '#c3c8cf'); g.fill();
      g.strokeStyle = 'rgba(40,42,48,0.6)'; g.lineWidth = 0.7; g.stroke();
      g.fillStyle = col; g.fillRect(-hx + 2, -1.6, hx * 2 - 4, 3.2);
      break;
    }
    case 'funnel': {
      const w2 = p.w / 2, h2 = p.h / 2;
      g.beginPath(); g.moveTo(-w2, -h2); g.lineTo(-15, h2); g.lineTo(-15, h2 + 20); g.moveTo(w2, -h2); g.lineTo(15, h2); g.lineTo(15, h2 + 20);
      g.lineJoin = 'round'; g.lineCap = 'round';
      g.strokeStyle = 'rgba(40,42,48,0.85)'; g.lineWidth = 7.4; g.stroke();
      g.strokeStyle = '#c9ced6'; g.lineWidth = 5.4; g.stroke();
      g.strokeStyle = 'rgba(255,255,255,0.7)'; g.lineWidth = 1.4; g.stroke();
      g.fillStyle = col; for (const x of [-w2, w2]) { g.beginPath(); g.arc(x, -h2, 4, 0, Math.PI * 2); g.fill(); }
      break;
    }
    case 'dropper': {
      const gr = g.createLinearGradient(-12.6, 0, 12.6, 0);
      gr.addColorStop(0, '#7a4f12'); gr.addColorStop(0.3, '#f3cf7a'); gr.addColorStop(0.55, '#c8902e'); gr.addColorStop(1, '#6d4510');
      g.fillStyle = gr;
      g.beginPath(); g.moveTo(-20.6, -96); g.lineTo(20.6, -96); g.lineTo(12.6, -78); g.lineTo(12.6, -12); g.lineTo(-12.6, -12); g.lineTo(-12.6, -78); g.closePath(); g.fill();
      g.fillStyle = '#2a1a08'; g.beginPath(); g.ellipse(0, -95, 18, 3, 0, 0, Math.PI * 2); g.fill();
      const open = fx ? Math.min(1, fx.flick * 1.4) : 0;
      g.save(); g.translate(-13, -11); g.rotate(1.25 * open); g.fillStyle = '#d8a445'; g.fillRect(0, -1.1, 26, 2.2); g.restore();
      drawMarble2D(g, 0, -82, 10, 1000, 0.6);
      break;
    }
    case 'bucket': {
      g.beginPath(); g.moveTo(-36.5, -30); g.lineTo(36.5, -30); g.lineTo(31.5, 30); g.lineTo(-31.5, 30); g.closePath();
      g.fillStyle = steelGrad(-30, 30, '#aeb4bb'); g.fill();
      // a rolled stiffening ring round the middle, in the same galvanised steel (as the 3D pail)
      g.fillStyle = '#8e959d'; g.beginPath(); g.moveTo(-34.1, -3.4); g.lineTo(34.1, -3.4); g.lineTo(33.7, 3.4); g.lineTo(-33.7, 3.4); g.closePath(); g.fill();
      g.strokeStyle = 'rgba(240, 243, 246, 0.8)'; g.lineWidth = 1.1; g.beginPath(); g.moveTo(-34, -1.6); g.lineTo(34, -1.6); g.stroke();
      g.strokeStyle = '#e4e7eb'; g.lineWidth = 3.2; g.beginPath(); g.moveTo(-37, -30); g.lineTo(37, -30); g.stroke();
      g.strokeStyle = '#80868e'; g.lineWidth = 1.2; g.beginPath(); g.arc(0, -18, 36, Math.PI * 1.05, Math.PI * 1.95); g.stroke();
      break;
    }
  }
  if (glow > 0.01) {                                // it lights up in its colour when it plays
    g.globalCompositeOperation = 'lighter';
    g.globalAlpha = glow * 0.8;
    g.fillStyle = mixHex(col, '#ffffff', 0.3);
    g.beginPath(); g.arc(0, 0, (p.len || p.w || (p.r || 16) * 2) / 2 + 12, 0, Math.PI * 2);
    const rg = g.createRadialGradient(0, 0, 2, 0, 0, (p.len || p.w || (p.r || 16) * 2) / 2 + 12);
    rg.addColorStop(0, mixHex(col, '#ffffff', 0.4)); rg.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = rg; g.fill();
  }
  g.restore();
}
// A glass marble in 2D (board units); `id` picks its colours
function drawMarble2D(g, x, y, r, id, angle) {
  const c = MARBLE_COLORS[(id - 1 + MARBLE_COLORS.length * 8) % MARBLE_COLORS.length];
  g.save();
  g.translate(x, y);
  g.fillStyle = 'rgba(30, 18, 8, 0.28)';
  g.beginPath(); g.ellipse(2.4, 3.4, r * 0.95, r * 0.85, 0, 0, Math.PI * 2); g.fill();
  const body = g.createRadialGradient(-r * 0.35, -r * 0.4, r * 0.1, 0, 0, r);
  body.addColorStop(0, mixHex(c.glass, '#ffffff', 0.55)); body.addColorStop(0.55, c.glass); body.addColorStop(1, mixHex(c.glass, '#000000', 0.45));
  g.fillStyle = body; g.beginPath(); g.arc(0, 0, r, 0, Math.PI * 2); g.fill();
  g.save(); g.clip(); g.rotate(angle || 0); g.fillStyle = c.swirl; g.globalAlpha = 0.8;
  for (let k = 0; k < 3; k++) { g.rotate((Math.PI * 2) / 3); g.beginPath(); g.moveTo(0, 0); g.quadraticCurveTo(r * 0.6, -r * 0.4, r * 0.95, r * 0.12); g.quadraticCurveTo(r * 0.45, r * 0.02, 0, 0); g.fill(); }
  g.restore();
  g.fillStyle = 'rgba(255, 255, 255, 0.85)'; g.beginPath(); g.ellipse(-r * 0.38, -r * 0.42, r * 0.32, r * 0.19, -0.7, 0, Math.PI * 2); g.fill();
  g.restore();
}

function createCanvas2DRenderer(canvas) {
  const ctx = canvas.getContext('2d');
  const cam = { s: 1, ox: 0, oy: 0, fitS: 1, fitOx: 0, fitOy: 0 };
  let bg = null, bgKey = '', lastSig = '';
  function layout() {
    view.w = window.innerWidth; view.h = window.innerHeight;
    view.dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(view.w * view.dpr); canvas.height = Math.round(view.h * view.dpr);
    const safe = boardFitRect(), B = FIT_BOX;
    const bw = B.x1 - B.x0, bh = B.y1 - B.y0;
    cam.fitS = Math.min((safe.r - safe.l) / bw, (safe.b - safe.t) / bh);
    cam.fitOx = (safe.l + safe.r) / 2 - (B.x0 + bw / 2) * cam.fitS;
    cam.fitOy = (safe.t + safe.b) / 2 - (B.y0 + bh / 2) * cam.fitS;
    applyCam();
  }
  function applyCam() {
    const z = VIEWCAM.zoom, cx = (FIT_BOX.x0 + FIT_BOX.x1) / 2 + VIEWCAM.panX, cy = (FIT_BOX.y0 + FIT_BOX.y1) / 2 + VIEWCAM.panY;
    const sx = cam.fitOx + ((FIT_BOX.x0 + FIT_BOX.x1) / 2) * cam.fitS, sy = cam.fitOy + ((FIT_BOX.y0 + FIT_BOX.y1) / 2) * cam.fitS;
    cam.s = cam.fitS * z;
    cam.ox = sx - cx * cam.s; cam.oy = sy - cy * cam.s;
    VIEWCAM.version++;
  }
  const b2s = (x, y) => [cam.ox + x * cam.s, cam.oy + y * cam.s];
  const s2b = (px, py) => [(px - cam.ox) / cam.s, (py - cam.oy) / cam.s];
  // The room and the pegboard, painted once per view (only the part in view: a tower may be many screens tall)
  function paintBackground() {
    const W = canvas.width, H = canvas.height, d = view.dpr;
    if (!bg) bg = document.createElement('canvas');
    if (bg.width !== W || bg.height !== H) { bg.width = W; bg.height = H; }
    const g = bg.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0);
    const wall = g.createLinearGradient(0, 0, 0, H);
    wall.addColorStop(0, '#d9d1c1'); wall.addColorStop(1, '#bfb5a2');
    g.fillStyle = wall; g.fillRect(0, 0, W, H);
    g.setTransform(cam.s * d, 0, 0, cam.s * d, cam.ox * d, cam.oy * d);
    const s = cam.s, v = visible2D();
    g.fillStyle = '#a0784a'; g.fillRect(v.x0 - 10, DESK_Y, v.x1 - v.x0 + 20, Math.max(10, v.y1 - DESK_Y + 10));
    g.shadowColor = 'rgba(40, 25, 10, 0.4)'; g.shadowBlur = 24 * s * d; g.shadowOffsetX = 8 * s * d; g.shadowOffsetY = 12 * s * d;
    g.fillStyle = '#d7b98e'; g.fillRect(-BOARD_PAD - FRAME_W, -BOARD_PAD - FRAME_W, BOARD_W + 2 * (BOARD_PAD + FRAME_W), BOARD_H + 2 * (BOARD_PAD + FRAME_W));
    g.shadowColor = 'transparent';
    // (the board's tone drifts gently along a tower instead of one gradient stretched over all of it)
    const pg = g.createLinearGradient(0, 0, BOARD_W, Math.min(BOARD_H, BOARD_W * 0.7));
    pg.addColorStop(0, '#9c7650'); pg.addColorStop(1, '#84613f');
    g.fillStyle = pg; g.fillRect(-BOARD_PAD, -BOARD_PAD, BOARD_W + 2 * BOARD_PAD, BOARD_H + 2 * BOARD_PAD);
    // holes in view (skipped when they would be smaller than a pixel)
    if (s * 3.7 * d > 0.8) {
      g.fillStyle = 'rgba(38, 22, 10, 0.85)';
      const hx0 = Math.max(0, Math.floor(v.x0 / GRID) * GRID), hx1 = Math.min(BOARD_W, v.x1), hy0 = Math.max(0, Math.floor(v.y0 / GRID) * GRID), hy1 = Math.min(BOARD_H, v.y1);
      for (let y = hy0; y <= hy1; y += GRID) { g.beginPath(); for (let x = hx0; x <= hx1; x += GRID) { g.moveTo(x + 3.7, y); g.arc(x, y, 3.7, 0, Math.PI * 2); } g.fill(); }
    }
    g.fillStyle = '#b9bec5'; g.fillRect(TROUGH.x0, TROUGH.y0, TROUGH.x1 - TROUGH.x0, TROUGH.y1 - TROUGH.y0);
    g.fillStyle = '#e6e9ed'; g.fillRect(TROUGH.x0, TROUGH.y0, TROUGH.x1 - TROUGH.x0, 4);
  }
  // The board area in view (board units, with a margin for shadows and pieces reaching in)
  function visible2D() { const a = s2b(0, 0), b = s2b(view.w, view.h); return { x0: a[0] - 60, y0: a[1] - 60, x1: b[0] + 60, y1: b[1] + 60 }; }
  const inView = (p, v) => { const r = pieceReach(p); return !(p.x + r < v.x0 || p.x - r > v.x1 || p.y + r < v.y0 || p.y - r > v.y1); };
  function render(t) {
    const marbles = drawnMarbles().length;
    const sig = [MODEL.version, VIEWCAM.version, canvas.width, canvas.height, EDIT.ghost ? JSON.stringify(EDIT.ghost) : '', EDIT.lifted].join('|');
    const busy = marbles > 0 || fxAnimating() || EDIT.pulse > 0;
    if (!busy && sig === lastSig) { drawOverlay(t); return false; }
    lastSig = sig;
    const key = canvas.width + 'x' + canvas.height + ':' + VIEWCAM.version + ':' + BOARD_W + 'x' + BOARD_H;
    if (key !== bgKey || !bg) { paintBackground(); bgKey = key; }
    const d = view.dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(bg, 0, 0);
    ctx.setTransform(cam.s * d, 0, 0, cam.s * d, cam.ox * d, cam.oy * d);
    const v = visible2D(), all = [];
    for (const p of MODEL.pieces) if (inView(p, v)) all.push(p);
    if (EDIT.ghost) all.push(EDIT.ghost);
    for (const p of all) {                            // soft shadows first, then the metal
      ctx.save(); ctx.shadowColor = 'rgba(30, 16, 6, 0.45)'; ctx.shadowBlur = 8 * cam.s * d; ctx.shadowOffsetX = 5 * cam.s * d; ctx.shadowOffsetY = 7 * cam.s * d;
      drawPiece2D(ctx, p, null, t); ctx.restore();
    }
    for (const p of all) drawPiece2D(ctx, p, SIM.fx.get(p.id), t);
    for (const m of drawnMarbles()) { const q = marbleDrawPos(m, DRAWPOS); if (q) drawMarble2D(ctx, q[0], q[1], m.r, m.id, q[2]); }
    drawOverlay(t);
    return true;
  }
  const b2sTo = (x, y, out) => { out[0] = cam.ox + x * cam.s; out[1] = cam.oy + y * cam.s; return out; };
  return { layout, render, applyCam, b2s, b2sTo, s2b, ppu: () => cam.s };
}
