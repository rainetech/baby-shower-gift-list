/* ============================================================================
 *  CANON: the canonical marble physics and metal-piece geometry
 *  Shared verbatim by the Marble Music platform (browser) and the demo-song
 *  solver (browser or Node), so a generated demo plays identically in the app.
 *  Board units, y points down, origin at the board's top-left, angles in
 *  degrees clockwise. Deterministic: no randomness anywhere.
 * ========================================================================== */
const CANON = (() => {
  // ---- Constants (same values as the v1 marble run)
  const GRAVITY = 1500;          // units / s^2
  const SUBSTEP = 1 / 240;       // fixed physics step
  const MAX_SPEED = 1300;        // speed cap keeps marbles from tunnelling through thin pieces
  const BOUNCE_MIN = 70;         // impacts slower than this don't bounce, so marbles settle and roll
  const MARBLE_R = 10;
  const NEW_NOTE_IMPACT = 10;    // a newly touched piece sounds if the impact is at least this
  const REBOUNCE_IMPACT = 90;    // the same piece again needs a real bounce ...
  const NOTE_COOLDOWN = 0.3;     // ... and this long since it last sounded for that marble
  const CONTACT_GAP = 0.07;      // contact within this long counts as still rolling on the piece
  const STUCK_SPEED = 12, STUCK_TIME = 5;   // a marble this slow for this long is removed
  const EPS = 1e-9;             // time comparisons are exact to this (times are step counts x SUBSTEP)

  // ---- Piece types: defaults, parameter ranges, material (restitution e, friction mu, kick)
  const PIECES = {
    bar:     { note: true,  defaults: { len: 70 },            ranges: { len: [30, 200] },             mat: { e: 0.55, mu: 0.08, kick: 0 } },
    rail:    { note: true,  defaults: { len: 200 },           ranges: { len: [40, 800] },             mat: { e: 0.15, mu: 0.03, kick: 0 } },
    curve:   { note: true,  defaults: { r: 80, sweep: 90 },   ranges: { r: [30, 300], sweep: [15, 270] }, mat: { e: 0.15, mu: 0.03, kick: 0 } },
    bell:    { note: true,  defaults: { r: 16 },              ranges: { r: [8, 40] },                 mat: { e: 0.75, mu: 0.05, kick: 30 } },
    spring:  { note: true,  defaults: { len: 60 },            ranges: { len: [30, 160] },             mat: { e: 0.92, mu: 0.05, kick: 60 } },
    wall:    { note: true,  defaults: { len: 100 },           ranges: { len: [20, 400] },             mat: { e: 0.30, mu: 0.10, kick: 0 } },
    funnel:  { note: true,  defaults: { w: 120, h: 70 },      ranges: { w: [60, 300], h: [30, 200] }, mat: { e: 0.20, mu: 0.05, kick: 0 } },
    dropper: { note: false, defaults: {},                     ranges: {},                             mat: null },
    bucket:  { note: false, defaults: { w: 70 },              ranges: {},                             mat: { e: 0.10, mu: 0.30, kick: 0 } },
  };
  const HW = { bar: 5, rail: 4, curve: 4, spring: 5, wall: 5, funnel: 3, bucket: 3 };

  // ---- Notes: 'C4' <-> MIDI number, frequency
  const SEMI = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  function noteToMidi(name) {
    const m = /^([A-G])([#b]?)(-?\d)$/.exec(name || '');
    if (!m) return null;
    return (Number(m[3]) + 1) * 12 + SEMI[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
  }
  function midiToNote(n) { return NAMES[((n % 12) + 12) % 12] + (Math.floor(n / 12) - 1); }
  function noteFreq(name) { const n = noteToMidi(name); return n == null ? 440 : 440 * Math.pow(2, (n - 69) / 12); }

  // ---- Geometry helpers
  const RAD = Math.PI / 180;
  function withDefaults(p) {
    const def = PIECES[p.type] ? PIECES[p.type].defaults : {};
    return Object.assign({ rot: 0 }, def, p);
  }
  // Local point (lx, ly) of piece p -> board coordinates (rotation about the piece centre)
  function toBoard(p, lx, ly) {
    const c = Math.cos((p.rot || 0) * RAD), s = Math.sin((p.rot || 0) * RAD);
    return [p.x + lx * c - ly * s, p.y + lx * s + ly * c];
  }
  function seg(p, a, b, hw, mat) {
    const abx = b[0] - a[0], aby = b[1] - a[1];
    return { shape: 'seg', ax: a[0], ay: a[1], bx: b[0], by: b[1], abx, aby, len2: abx * abx + aby * aby || 1,
      hw, e: mat.e, mu: mat.mu, kick: mat.kick, pieceId: p.id };
  }

  // The collision shapes of one piece (see the table in the spec)
  function colliders(piece) {
    const p = withDefaults(piece), def = PIECES[p.type];
    if (!def || !def.mat) return [];
    const mat = def.mat, hw = HW[p.type];
    switch (p.type) {
      case 'bar': case 'rail': case 'spring': case 'wall':
        return [seg(p, toBoard(p, -p.len / 2, 0), toBoard(p, p.len / 2, 0), hw, mat)];
      case 'bell':
        return [{ shape: 'circle', x: p.x, y: p.y, r: p.r, e: mat.e, mu: mat.mu, kick: mat.kick, pieceId: p.id }];
      case 'curve': {
        const n = Math.max(1, Math.ceil(p.sweep / 3)), out = [];   // 3-degree chords: smooth to roll on
        let prev = null;
        for (let i = 0; i <= n; i++) {
          const a = (p.rot + (p.sweep * i) / n) * RAD;
          const pt = [p.x + p.r * Math.cos(a), p.y + p.r * Math.sin(a)];
          if (prev) out.push(seg(p, prev, pt, hw, mat));
          prev = pt;
        }
        return out;
      }
      case 'funnel': {
        const w = p.w / 2, h = p.h / 2;
        return [
          seg(p, toBoard(p, -w, -h), toBoard(p, -15, h), hw, mat),
          seg(p, toBoard(p, w, -h), toBoard(p, 15, h), hw, mat),
          seg(p, toBoard(p, -15, h), toBoard(p, -15, h + 20), hw, mat),
          seg(p, toBoard(p, 15, h), toBoard(p, 15, h + 20), hw, mat),
        ];
      }
      case 'bucket':
        return [
          seg(p, toBoard(p, -35, -30), toBoard(p, -30, 30), hw, mat),
          seg(p, toBoard(p, -30, 30), toBoard(p, 30, 30), hw, mat),
          seg(p, toBoard(p, 30, 30), toBoard(p, 35, -30), hw, mat),
        ];
    }
    return [];
  }

  // ---- World: pieces -> colliders with a uniform-grid broadphase
  const CELL = 64;
  function createWorld(layout) {
    const board = (layout && layout.board) || { w: 1600, h: 1000 };
    const pieces = ((layout && layout.pieces) || []).map(withDefaults);
    const byId = new Map(pieces.map((p) => [p.id, p]));
    const list = [];
    for (const p of pieces) for (const c of colliders(p)) list.push(c);
    const pad = MARBLE_R + 2;
    const grid = new Map();
    list.forEach((c, i) => {
      if (c.shape === 'seg') {
        c.minX = Math.min(c.ax, c.bx) - c.hw - pad; c.maxX = Math.max(c.ax, c.bx) + c.hw + pad;
        c.minY = Math.min(c.ay, c.by) - c.hw - pad; c.maxY = Math.max(c.ay, c.by) + c.hw + pad;
      } else {
        c.minX = c.x - c.r - pad; c.maxX = c.x + c.r + pad; c.minY = c.y - c.r - pad; c.maxY = c.y + c.r + pad;
      }
      for (let gx = Math.floor(c.minX / CELL); gx <= Math.floor(c.maxX / CELL); gx++) {
        for (let gy = Math.floor(c.minY / CELL); gy <= Math.floor(c.maxY / CELL); gy++) {
          const k = gx * 100003 + gy;
          let cell = grid.get(k);
          if (!cell) grid.set(k, (cell = []));
          cell.push(i);                            // ascending collider index: same order as a brute-force pass
        }
      }
    });
    return { board, pieces, byId, colliders: list, grid, marbles: [], time: 0, stepN: 0, nextMarbleId: 1,
      releases: [], releaseIdx: 0, notes: [], removed: [] };
  }

  // Schedule marble releases: [{ t, dropperId }] (sorted); 'times' schedules and 'repeat' up to `until` seconds
  function scheduleReleases(world, layout, until = 600) {
    const beat = 60 / ((layout && layout.tempo) || 100);
    const out = [];
    for (const p of world.pieces) {
      if (p.type !== 'dropper' || !p.schedule) continue;
      const s = p.schedule;
      if (s.mode === 'times') for (const t of s.times || []) out.push({ t, dropperId: p.id });
      else if (s.mode === 'repeat') for (let t = 0; t <= until; t += Math.max(0.05, (s.every || 1) * beat)) out.push({ t, dropperId: p.id });
      else if (s.mode === 'once' || s.mode === 'manual') out.push({ t: 0, dropperId: p.id });
    }
    out.sort((a, b) => a.t - b.t || (a.dropperId < b.dropperId ? -1 : a.dropperId > b.dropperId ? 1 : 0));
    world.releases = out;
    world.releaseIdx = 0;
    return out;
  }

  function spawn(world, x, y, dropperId) {
    const m = { id: world.nextMarbleId++, x, y, vx: 0, vy: 0, r: MARBLE_R, angle: 0, spin: 0, dropperId: dropperId || null,
      bornT: world.time, contactT: new Map(), noteT: new Map(), lastPiece: null, stillT: world.time, ax: x, ay: y, bucketT: -1 };
    world.marbles.push(m);
    return m;
  }
  function dropFrom(world, dropperId) {
    const d = world.byId.get(dropperId);
    return d ? spawn(world, d.x, d.y, d.id) : null;
  }

  // Contact bookkeeping and the note rule (identical to the v1 touch rule)
  function touch(world, m, c, impact) {
    const p = world.byId.get(c.pieceId);
    if (!p || !p.note) return;
    const t = world.time, id = p.id;
    const last = m.contactT.get(id);
    m.contactT.set(id, t);
    if (last !== undefined && t - last < CONTACT_GAP - EPS) return;    // still rolling on it
    const played = m.noteT.get(id);
    if (played !== undefined && t - played < NOTE_COOLDOWN - EPS) return;   // exactly 72 steps later counts as cooled down
    const isNew = m.lastPiece !== id;
    if (impact < (isNew ? NEW_NOTE_IMPACT : REBOUNCE_IMPACT)) return;
    m.noteT.set(id, t);
    m.lastPiece = id;
    world.notes.push({ t, note: p.note, pieceId: id, marbleId: m.id, impact, x: m.x, y: m.y });
  }

  function resolve(world, m, nx, ny, pen, c) {
    m.x += nx * pen;
    m.y += ny * pen;
    let rvx = m.vx, rvy = m.vy;
    const vn = rvx * nx + rvy * ny;
    if (vn >= 0) return;                                               // already separating
    const impact = -vn;
    const e = impact > BOUNCE_MIN ? c.e : 0;                           // gentle contacts don't bounce
    const jn = -(1 + e) * vn;
    rvx += jn * nx;
    rvy += jn * ny;
    if (c.kick && impact > BOUNCE_MIN) { rvx += nx * c.kick; rvy += ny * c.kick; }
    const tx = -ny, ty = nx;                                           // Coulomb friction, tangential part
    const vt = rvx * tx + rvy * ty;
    const maxF = c.mu * jn;
    const dvt = Math.abs(vt) <= maxF ? vt : Math.sign(vt) * maxF;
    rvx -= dvt * tx;
    rvy -= dvt * ty;
    m.vx = rvx;
    m.vy = rvy;
    m.spin = (vt - dvt) / m.r;
    touch(world, m, c, impact);
  }

  function collideSeg(world, m, c) {
    let t = ((m.x - c.ax) * c.abx + (m.y - c.ay) * c.aby) / c.len2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const dx = m.x - (c.ax + c.abx * t), dy = m.y - (c.ay + c.aby * t);
    const minD = m.r + c.hw, d2 = dx * dx + dy * dy;
    if (d2 >= minD * minD) return;
    const d = Math.sqrt(d2);
    if (d < 1e-6) {                                                    // dead centre on the line: push out upwards
      const l = Math.sqrt(c.len2);
      let nx = -c.aby / l, ny = c.abx / l;
      if (ny > 0) { nx = -nx; ny = -ny; }
      resolve(world, m, nx, ny, minD, c);
      return;
    }
    resolve(world, m, dx / d, dy / d, minD - d, c);
  }
  function collideCircle(world, m, c) {
    const dx = m.x - c.x, dy = m.y - c.y, minD = m.r + c.r, d2 = dx * dx + dy * dy;
    if (d2 >= minD * minD) return;
    const d = Math.sqrt(d2);
    if (d < 1e-6) { resolve(world, m, 0, -1, minD, c); return; }
    resolve(world, m, dx / d, dy / d, minD - d, c);
  }

  function collideMarbles(world) {
    const ms = world.marbles;
    for (let i = 0; i < ms.length; i++) {
      const a = ms[i];
      for (let j = i + 1; j < ms.length; j++) {
        const b = ms[j];
        const dx = b.x - a.x, dy = b.y - a.y, minD = a.r + b.r, d2 = dx * dx + dy * dy;
        if (d2 >= minD * minD || d2 < 1e-9) continue;
        const d = Math.sqrt(d2), nx = dx / d, ny = dy / d, pen = (minD - d) / 2;
        a.x -= nx * pen; a.y -= ny * pen;
        b.x += nx * pen; b.y += ny * pen;
        const vn = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
        if (vn < 0) {
          const e = -vn > BOUNCE_MIN ? 0.7 : 0.1;
          const jn = (-(1 + e) * vn) / 2;
          a.vx -= jn * nx; a.vy -= jn * ny;
          b.vx += jn * nx; b.vy += jn * ny;
        }
      }
    }
  }

  // Is the marble inside a bucket's U? (local frame of the bucket)
  function inBucket(p, m) {
    const c = Math.cos(-(p.rot || 0) * RAD), s = Math.sin(-(p.rot || 0) * RAD);
    const lx = (m.x - p.x) * c - (m.y - p.y) * s, ly = (m.x - p.x) * s + (m.y - p.y) * c;
    return Math.abs(lx) < 28 && ly > -20 && ly < 28;
  }

  // One fixed step: releases due at the start of the step, integrate, collide, notes, removals
  function step(world, h = SUBSTEP) {
    const t0 = world.time;
    const rel = world.releases;
    while (world.releaseIdx < rel.length && rel[world.releaseIdx].t <= t0 + 1e-9) dropFrom(world, rel[world.releaseIdx++].dropperId);
    // Exact step times (no drift from repeated addition). The step is derived from `time`, so code that copies
    // only `time` into a rebuilt world stays correct.
    if (h === SUBSTEP) { world.stepN = Math.round(t0 / SUBSTEP) + 1; world.time = world.stepN * SUBSTEP; }
    else world.time = t0 + h;
    const grid = world.grid, list = world.colliders;
    for (const m of world.marbles) {
      m.vy += GRAVITY * h;
      const sp = Math.sqrt(m.vx * m.vx + m.vy * m.vy);
      if (sp > MAX_SPEED) { m.vx *= MAX_SPEED / sp; m.vy *= MAX_SPEED / sp; }
      m.x += m.vx * h;
      m.y += m.vy * h;
      const cell = grid.get(Math.floor(m.x / CELL) * 100003 + Math.floor(m.y / CELL));
      if (cell) for (let k = 0; k < cell.length; k++) {
        const c = list[cell[k]];
        if (m.x < c.minX || m.x > c.maxX || m.y < c.minY || m.y > c.maxY) continue;
        if (c.shape === 'seg') collideSeg(world, m, c); else collideCircle(world, m, c);
      }
      m.angle += m.spin * h;
    }
    collideMarbles(world);
    // Removals: off the board, collected in a bucket, or stuck
    const W = world.board.w, H = world.board.h;
    for (let i = world.marbles.length - 1; i >= 0; i--) {
      const m = world.marbles[i];
      let why = null;
      if (m.y > H + 60 || m.x < -120 || m.x > W + 120) why = 'fell';
      else {
        for (const p of world.pieces) if (p.type === 'bucket' && inBucket(p, m)) { if (m.bucketT < 0) m.bucketT = world.time; break; }
        if (m.bucketT >= 0 && world.time - m.bucketT > 1) why = 'bucket';
        if (Math.hypot(m.x - m.ax, m.y - m.ay) > 6) { m.ax = m.x; m.ay = m.y; m.stillT = world.time; }
        else if (world.time - m.stillT > STUCK_TIME && m.bucketT < 0) why = 'stuck';
      }
      if (why) { world.removed.push({ t: world.time, marbleId: m.id, why, x: m.x, y: m.y }); world.marbles.splice(i, 1); }
    }
  }

  function simulate(world, seconds, h = SUBSTEP) {
    const n = Math.round(seconds / h);
    for (let i = 0; i < n; i++) step(world, h);
    return world;
  }

  // Predict one marble dropped from a dropper: its path (sampled every `every` s) and the notes it plays
  function predict(layout, dropperId, seconds = 6, every = 1 / 60) {
    const w = createWorld(layout);
    const m = dropFrom(w, dropperId);
    if (!m) return { path: [], hits: [] };
    const path = [[m.x, m.y, 0]];
    const steps = Math.round(seconds / SUBSTEP), sampleEvery = Math.max(1, Math.round(every / SUBSTEP));
    for (let i = 1; i <= steps && w.marbles.length; i++) {
      step(w);
      if (i % sampleEvery === 0 && w.marbles.length) path.push([m.x, m.y, w.time]);
    }
    return { path, hits: w.notes.map((n) => ({ t: n.t, note: n.note, pieceId: n.pieceId, x: n.x, y: n.y })), end: w.removed[0] || null };
  }

  return { GRAVITY, SUBSTEP, MAX_SPEED, BOUNCE_MIN, MARBLE_R, NEW_NOTE_IMPACT, REBOUNCE_IMPACT, NOTE_COOLDOWN, PIECES, HW,
    noteToMidi, midiToNote, noteFreq, withDefaults, toBoard, colliders, createWorld, scheduleReleases, spawn, dropFrom,
    step, simulate, predict };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = CANON;
