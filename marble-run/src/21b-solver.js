/* ============================================================================
 *  MarbleSolver (tower): turns a song into ONE tall marble-run tower that ONE marble plays from top to bottom
 *
 *  A brass dropper at the top releases one marble. It zig-zags down a column (the board is 800 or 1000 wide and as
 *  tall as the song needs) and every melody note is the marble striking a tuned glockenspiel KEY (a pitch-coloured
 *  `bar`, its length following its pitch) exactly on the note's physics step. Between notes it either hops straight
 *  to the next key (a staircase or a ladder of keys) or uses SILENT chrome and steel (`note: null`: CANON never
 *  sounds them): a RAIL it lands on and rolls along (long notes), a STOP PLATE at a rail's end that turns it round,
 *  a SIDE WALL it meets at the top of an arc or banks off in a fast run, a LAUNCH RAMP under the dropper. The run
 *  ends in a pail at the foot of the tower. Only canonical pieces; everything is checked with CANON (used verbatim).
 *
 *  searchChain: a depth-first chain builder with backtracking (the best `branch` distinct candidates per note, a
 *  node budget per subtree so a dead end sends it back far enough, a one-note look-ahead that drops candidates
 *  leaving no key for the next note):
 *   - the key for note i goes where the marble WILL be at note i's physics step (the contact mid-step), angled to
 *     send it on; each angle's key is tried at its pitch length, shorter, and off-centre;
 *   - connectors to note i+1: none (a direct hop), a rail (its length solved so the marble drops off its end a set
 *     time before the note), rail + stop plate, rail + stop plate + second rail (a SWITCHBACK inside one long note),
 *     a side wall at the arc's apex (+ an optional rail), a bank shot off the side wall (fast runs);
 *   - candidates are ranked by an analytic preview, simulated exactly with CANON (only the new pieces: a marble that
 *     never comes near a piece cannot tell it is there, so the partial world is exact) and checked: clearances
 *     (pieces >= pieceGap apart, every marble path >= clearance from every piece it does not touch, the future
 *     included), clean hits (normal speed >= vnMin, incidence >= incMin, >= endMargin from a key's ends), speeds;
 *   - the score keeps the tower readable and the chain alive: legs that cross the tower and turn at its sides,
 *     staircases that descend, the marble falling (not skimming) onto keys, room ahead at the edges, the steady
 *     skim for a prestissimo (see thresholds);
 *   - REGENERATORS: a stop plate or side wall struck square on (inside CANON's sticking-friction cone) leaves the
 *     marble with an exact velocity along the plate's normal, whatever error it arrived with, and snaps its timing
 *     to the physics step: the drift a long single-marble chain accumulates is erased there;
 *   - ROBUSTNESS GATE: jittered copies of the run (every piece moved within +-gateJitterPos units and +-gateJitterRot
 *     degrees x gateAmps: the harness's jitter, x1.5 and x2; seeded per piece and trial) are carried along the chain
 *     note by note; a candidate is rejected if any copy misses its note, plays an extra one, drifts past the
 *     tolerance or jumps by more than a step at once, and the copies' spread is part of its score;
 *   - DRIFT PROBE (long notes): the exact marble sent in 1.5 steps late and early and 2 units to either side; a
 *     connector that turns that into much more timing error (a long lob, a slow roll) ranks behind every one that
 *     does not;
 *   - VALIDATION: a finished chain is played whole with `validate` fresh jittered copies the gate never saw (the
 *     search learns to please its own copies); if any gets a note wrong the search resumes at the note before the
 *     first wrong one, and after validateMax tries it keeps the chain the fewest copies got wrong.
 *  A song that one marble cannot play (Grieg's prestissimo) gets a HOLD where the chain gets stuck: the melody is
 *  cut at the longest note before that point, that marble drops into a pail and the next starts from a dropper
 *  directly below it (same column). The solver tries one marble first (on an 800- then a 1000-wide board, starting
 *  from either side); of the rounds that succeed, the first tower every validation copy plays right is kept, or
 *  else the one the fewest got wrong.
 *
 *  Timing: a note that must ring at physics step N is played by a marble released at step N - K (K = the steps from
 *  release to that note); the release is scheduled half a step early, (N - K - 0.5) * h. Targets are exact musical
 *  times. Budgets are deterministic (counted CANON steps and nodes, never the wall clock): the same song gives the
 *  same layout on any machine. Works in Node (module.exports) and in a browser (global MarbleSolver).
 *
 *  solveSong(song, CANON, opts) -> { layout, targets: [{ t, note, voice }] (the melody voice), stats }
 *  hintFrom(layout) -> { board, heading, holds }: opts.hint for re-solving a baked tower quickly (same result)
 *  demos -> [{ id, title, composer, year }] (from songs.js, when it is loaded)
 * ========================================================================== */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.MarbleSolver = api;
})(typeof globalThis !== 'undefined' ? globalThis : typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const RAD = Math.PI / 180;
  const DEFAULTS = {
    // ---- the tower
    boardW: 800,          // board width (the tower column is centred on it) ...
    boardWs: [800, 1000], // ... tried in turn (a wider tower for runs of very fast notes)
    colMargin: 40,        // pieces and marbles keep this far inside the board's sides
    dropY: 100,           // marble spawn y of the top dropper (its drawing, 97 units tall, stays on the board)
    falls: [70, 110, 150],// free fall from the dropper to the first key (tried in order)
    ramps: true, rampFall: 26, rampSlopes: [16, 26], rampLens: [110, 170], rampTfs: [0.06, 0.12], rampUp: 22,
    rampFirstDt: 0.26,    // launch ramps under the dropper (tried first when the first note is this short)
    lead: 1.2,            // seconds from Play to the first note
    bottomMargin: 60,     // board bottom below the lowest piece
    // ---- keys (tuned bars)
    rotStep: 2.5, rotMax: 62, rotSoft: 38,
    vnMin: 170,           // min approach speed along a key's normal (far from CANON's BOUNCE_MIN = 70)
    incMin: 0.34,         // min sine of the angle of incidence (no grazing hits)
    endMargin: 14,        // a key is struck at least this far from its ends
    minKeyLen: 44,        // keys are never shorter than this (readable); lengths follow pitch like a glockenspiel
    // notes reached by very short hops (see thresholds): a lower floor, shorter keys, and the steady skim
    fastDt: 0.22, vnMinFast: 130, incMinFast: 0.3, minKeyLenFast: 34, stairSlopeFast: 0.05, skimVx: 380, skimVy: 180, wSkim: 1,
    // ---- silent rails (note: null)
    rails: true,
    railMinDt: 0.36,      // a note at least this long may use a rail
    railSlopes: [2.5, 4, 6, 8.5, 12],
    railLand: 20,         // the marble lands at least this far from a rail's upper end
    railMin: 60, railMax: 640,
    tfs: [0.04, 0.09, 0.16],   // free fall from a rail's end to the next key (seconds, targets; short = robust)
    landFirmMin: 100, landFirmMax: 300,   // a firm rail landing's normal speed (a soft one skims in below BOUNCE_MIN)
    dtDirectMax: 0.78,    // a note longer than this always uses a rail
    // ---- silent steel: stop plates (rail ends), switchbacks, bank shots, side walls at an arc's apex
    stops: true, stopTfs: [0.16, 0.26], stopGap: 24, stopLen: 60, stopCost: 0, stopBonus: 0.8, stopEdgeScale: 220,
    switchbacks: true, switchbackMinT: 0.3, switchbackMax: 4, switchbackAt: [0.62, 0.5],
    banks: true, bankMaxDt: 0.45, bankKeys: 4, bankLen: 70, bankCost: 0.3,
    walls: true, wallMinDt: 0.3, wallRailMinDt: 0.62, wallKeys: 6, wallVnMin: 150, wallStick: 0.5, wallLen: 90, wallTop: 26, wallCost: 0.2,
    // ---- clearances, speeds and the shape of the tower (score weights)
    pieceGap: 8,          // min gap between two piece surfaces
    clearance: 5,         // min gap between a marble and any piece it must not touch
    softClear: 16,        // paths closer than this to other pieces are penalised
    vLo: 240, vHi: 680, vMax: 820,   // preferred / maximum marble speed at a key
    riseMax: 90,          // max rise of the marble above the key it just left
    vyLong: 280, vyShort: 200,   // arriving before a long (short) note, the marble should be falling at least this fast
    wEdge: 1.5,           // weight of the room-at-the-edge look-ahead
    runSpeed: 0,          // (off) room for a whole run of short notes
    lookahead: 4, wLook: 1.5,    // one-note look-ahead: keys wanted for the next note, and the penalty for fewer
    stairSlope: 0.45, wStair: 1, // short hops drop about this much per unit across (a diagonal staircase of keys)
    ladderDt: 0.3, ladderTurn: 0.25, vxFast: 280,   // fast notes: turning is cheap, and the marble should not race across
    turnBase: 0.6, turnSlope: 3, // cost of reversing the marble's direction away from the tower's edges
    // ---- search
    topK: 12,             // key angles simulated exactly per node (direct flights)
    railKeys: 6,          // keys whose flights are tried with rails
    railSpots: 3,         // landing spots per key (rails after a side wall or a stop)
    railSpotsTotal: 10, railCandsMax: 12,   // landing spots tried per node over all keys, rail candidates kept
    gateK: 6, gateTry: 14,               // candidates that pass the robustness gate per node (at most gateTry tried)
    search: 'dfs',        // 'dfs' (depth first with backtracking) or 'beam'
    branch: 5, diverseDist: 14, subtreeNodes: 150,   // distinct children per note; nodes one subtree may use
    beamWidth: 5, beamKids: 4, beamPerParent: 3,     // (search: 'beam')
    nodeFactor: 30,       // node budget per chain = nodeFactor * notes (a node = one note's candidates expanded)
    workBudget: 2.5e8,    // deterministic budget: CANON steps the solver may simulate in total
    // ---- robustness gate: jittered copies at the harness's jitter (x1), x1.5 and x2; tolerances per amplitude
    gateJitterPos: 0.05, gateJitterRot: 0.02, gateAmps: [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1.5, 1.5, 2, 2, 2, 2],
    gateTol: 0.005, gateTolHi: 0.009, gateTol2x: 0.013, crossMax: 3,
    gateJump: 0.0046, gateJumpHi: 0.007,    // a copy's deviation may change by at most this (x amplitude above x1) across one note
    wRobust: 1.0,
    // the drift probe: the exact marble shifted along its own flight by these fractions of a step (late > 0), as an
    // accumulated timing error would, must leave each connector with at most probeJump more (or less) error
    probes: [[-1.5, 0], [1.5, 0], [0, -2], [0, 2]], probeJump: 0.0055, wProbe: 0.5, probeMinDt: 0.3,   // [steps late, units aside]; long notes only
    // VALIDATION: a finished chain is played whole `validate` times with fresh jitter at x1 (copies the gate never
    // saw); if any copy gets a note wrong or off by more than validateTol, the search resumes at the note before
    // the first wrong one; after validateMax finished chains (or when the search runs out) the chain that the
    // fewest copies got wrong is kept
    validate: 24, validateTol: 0.0105, validateMax: 12,
    // ---- holds (only where one marble cannot play the song)
    holds: true, maxHolds: 3, segRetry: { branch: 7, subtreeNodes: 400, nodeFactor: 60 }, holdMinGap: 0.3, holdMinSeg: 6, holdTries: 4, holdGap: 12, holdFalls: [60, 90, 120],
    verify: true,
    debug: null,
  };

  // ---------------------------------------------------------------------------------------------------------
  // Song timing: tempo (bpm) with an optional piecewise-constant tempoMap [[beat, bpm], ...]
  function makeClock(song) {
    let base = song.tempo || 100;
    const changes = [];
    for (const c of song.tempoMap || song.tempoChanges || []) { if (c[0] <= 0) base = c[1]; else changes.push(c); }
    changes.sort((a, b) => a[0] - b[0]);
    const segs = [[0, base], ...changes];
    return function sec(beat) {
      if (beat <= 0) return (beat * 60) / base;
      let s = 0;
      for (let i = 0; i < segs.length; i++) {
        const b0 = segs[i][0], b1 = i + 1 < segs.length ? segs[i + 1][0] : Infinity;
        if (beat <= b0) break;
        s += ((Math.min(beat, b1) - b0) * 60) / segs[i][1];
      }
      return s;
    };
  }
  // The song's beat grid for the platform (music strip, path-preview beat dots): beat 0 is `start` seconds after
  // Play; `tempoMap` (only when the tempo changes or is not a whole bpm) = [[beat, bpm], ...] from that beat on;
  // `pulse` = the beat dots' spacing in quarter beats (eighths for compound meters such as 3/8).
  function layoutTiming(song, start, shift) {
    const t = { start: +start.toFixed(6), beatsPerBar: song.beatsPerBar || 4 };
    shift = shift || 0;
    if (!Number.isInteger(t.beatsPerBar)) t.pulse = 0.5;
    let base = song.tempo || 100;
    const changes = [];
    for (const c of song.tempoMap || song.tempoChanges || []) { if (c[0] <= 0) base = c[1]; else changes.push(c); }
    changes.sort((a, b) => a[0] - b[0]);
    let map = [[0, base]];
    for (const c of changes) if (c[1] !== map[map.length - 1][1]) map.push([c[0], c[1]]);
    if (shift) {           // re-count the tempo map from the grid's beat 0
      let cur = base;
      for (const c of map) if (c[0] <= shift) cur = c[1];
      map = [[0, cur], ...map.filter((c) => c[0] > shift).map((c) => [c[0] - shift, c[1]])];
    }
    if (map.length > 1 || base !== Math.round(song.tempo)) t.tempoMap = map;
    return t;
  }
  const isBassVoice = (v) => (v.rack ? v.rack === 'bass' : /bass/i.test(v.name || ''));
  // The voice the tower plays: song.towerVoice (index or name), else the first voice that is not a bass (the
  // melody; a round's first voice; a canon's first violin)
  function melodyVoice(song, opts) {
    const pick = opts && opts.voice !== undefined ? opts.voice : song.towerVoice;
    if (typeof pick === 'number') return pick;
    if (typeof pick === 'string') { const k = song.voices.findIndex((v) => v.name === pick); if (k >= 0) return k; }
    const k = song.voices.findIndex((v) => !isBassVoice(v));
    return k >= 0 ? k : 0;
  }

  // All notes of all voices: { voice (name), vi (index), bass, beat, sec, ts (whole physics steps from beat 0), note }
  function songNotes(song, h) {
    const sec = makeClock(song), out = [];
    song.voices.forEach((v, vi) => {
      const bass = isBassVoice(v);
      for (const [beat, note] of v.notes) {
        const s = sec(beat);
        out.push({ voice: v.name || 'voice ' + (vi + 1), vi, bass, beat, sec: s, ts: Math.round(s / h), note });
      }
    });
    out.sort((a, b) => a.sec - b.sec || a.vi - b.vi);
    return out;
  }

  // ---------------------------------------------------------------------------------------------------------
  // Geometry (on CANON's own colliders)
  function distPointSeg(px, py, c) {
    let t = ((px - c.ax) * c.abx + (py - c.ay) * c.aby) / c.len2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const dx = px - (c.ax + c.abx * t), dy = py - (c.ay + c.aby * t);
    return Math.sqrt(dx * dx + dy * dy);
  }
  // gap between a marble centred at (px, py) and the surface of a piece (negative = overlapping)
  function marbleGap(cols, px, py, R) {
    let g = Infinity;
    for (const c of cols) {
      const d = c.shape === 'seg' ? distPointSeg(px, py, c) - c.hw : Math.hypot(px - c.x, py - c.y) - c.r;
      if (d < g) g = d;
    }
    return g - R;
  }
  function segSegDist(a, b) {
    const cross = (ox, oy, px, py, qx, qy) => (px - ox) * (qy - oy) - (py - oy) * (qx - ox);
    const d1 = cross(a.ax, a.ay, a.bx, a.by, b.ax, b.ay), d2 = cross(a.ax, a.ay, a.bx, a.by, b.bx, b.by);
    const d3 = cross(b.ax, b.ay, b.bx, b.by, a.ax, a.ay), d4 = cross(b.ax, b.ay, b.bx, b.by, a.bx, a.by);
    if (d1 * d2 < 0 && d3 * d4 < 0) return 0;
    return Math.min(distPointSeg(a.ax, a.ay, b), distPointSeg(a.bx, a.by, b), distPointSeg(b.ax, b.ay, a), distPointSeg(b.bx, b.by, a));
  }
  function pieceGapBetween(ca, cb) {
    let g = Infinity;
    for (const a of ca) for (const b of cb) {
      let d;
      if (a.shape === 'seg' && b.shape === 'seg') d = segSegDist(a, b) - a.hw - b.hw;
      else if (a.shape === 'seg') d = distPointSeg(b.x, b.y, a) - a.hw - b.r;
      else if (b.shape === 'seg') d = distPointSeg(a.x, a.y, b) - b.hw - a.r;
      else d = Math.hypot(a.x - b.x, a.y - b.y) - a.r - b.r;
      if (d < g) g = d;
    }
    return g;
  }
  function bbox(cols) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const c of cols) {
      if (c.shape === 'seg') {
        x0 = Math.min(x0, c.ax - c.hw, c.bx - c.hw); x1 = Math.max(x1, c.ax + c.hw, c.bx + c.hw);
        y0 = Math.min(y0, c.ay - c.hw, c.by - c.hw); y1 = Math.max(y1, c.ay + c.hw, c.by + c.hw);
      } else { x0 = Math.min(x0, c.x - c.r); x1 = Math.max(x1, c.x + c.r); y0 = Math.min(y0, c.y - c.r); y1 = Math.max(y1, c.y + c.r); }
    }
    return { x0, y0, x1, y1 };
  }
  // A capsule that is not a physics collider: stands for a drawing (a dropper's brass tube and hopper) in
  // clearance checks, so no marble or piece passes through it on screen
  function pseudoSeg(ax, ay, bx, by, hw) {
    const abx = bx - ax, aby = by - ay;
    return { shape: 'seg', ax, ay, bx, by, abx, aby, len2: abx * abx + aby * aby || 1, hw, pseudo: true };
  }
  // The platform draws a dropper as a tube x +-12.6, y -78..-10 and a hopper x +-20.6, y -97..-78 (spawn-relative)
  function tubeCols(x, y) {
    return [pseudoSeg(x, y - 65.4, x, y - 22.6, 12.6), pseudoSeg(x - 10.6, y - 87.5, x + 10.6, y - 87.5, 10)];
  }

  // ---------------------------------------------------------------------------------------------------------
  // The scene: every piece placed so far and every marble position (one per physics step), on grids, with marks
  // so the depth-first search can undo whole levels (LIFO)
  function Scene() { this.C = 48; this.items = []; this.pg = new Map(); this.samples = []; this.sg = new Map(); this.stamp = 0; }
  Scene.prototype.cell = function (x, y) { return Math.floor(x / this.C) * 100003 + Math.floor(y / this.C); };
  Scene.prototype.forCells = function (x0, y0, x1, y1, fn) {
    const C = this.C;
    for (let i = Math.floor(x0 / C); i <= Math.floor(x1 / C); i++) for (let j = Math.floor(y0 / C); j <= Math.floor(y1 / C); j++) fn(i * 100003 + j);
  };
  Scene.prototype.addPiece = function (piece, cols, info) {
    const idx = this.items.length, bb = bbox(cols), cells = [];
    this.items.push({ piece, cols, bb, cells, info: info || null, mark: 0 });
    this.forCells(bb.x0, bb.y0, bb.x1, bb.y1, (k) => { let a = this.pg.get(k); if (!a) this.pg.set(k, (a = [])); a.push(idx); cells.push(k); });
    return idx;
  };
  Scene.prototype.addSamples = function (pts) {
    for (const p of pts) {
      const k = this.cell(p[0], p[1]);
      let a = this.sg.get(k);
      if (!a) this.sg.set(k, (a = []));
      a.push(this.samples.length);
      this.samples.push(p);
    }
  };
  Scene.prototype.mark = function () { return { ni: this.items.length, ns: this.samples.length }; };
  Scene.prototype.reset = function (mk) {
    while (this.items.length > mk.ni) { const it = this.items.pop(); for (const k of it.cells) this.pg.get(k).pop(); }
    while (this.samples.length > mk.ns) { const p = this.samples.pop(); this.sg.get(this.cell(p[0], p[1])).pop(); }
  };
  // items (indices) whose boxes come within `r` of a box
  Scene.prototype.near = function (x0, y0, x1, y1, r) {
    const s = ++this.stamp, out = [];
    this.forCells(x0 - r, y0 - r, x1 + r, y1 + r, (k) => {
      const a = this.pg.get(k);
      if (a) for (const idx of a) {
        const it = this.items[idx];
        if (it.mark === s) continue;
        it.mark = s;
        if (it.bb.x0 > x1 + r || it.bb.x1 < x0 - r || it.bb.y0 > y1 + r || it.bb.y1 < y0 - r) continue;
        out.push(idx);
      }
    });
    return out;
  };
  // gap from a marble at (x, y) to the nearest placed piece (skip: item indices to ignore)
  Scene.prototype.marbleGap = function (x, y, R, reach, skip) {
    let g = Infinity;
    for (const idx of this.near(x, y, x, y, R + reach)) {
      if (skip && skip.has(idx)) continue;
      const d = marbleGap(this.items[idx].cols, x, y, R);
      if (d < g) g = d;
    }
    return g;
  };
  Scene.prototype.pieceGap = function (cols, within) {
    const bb = bbox(cols);
    let g = Infinity;
    for (const idx of this.near(bb.x0, bb.y0, bb.x1, bb.y1, within)) g = Math.min(g, pieceGapBetween(cols, this.items[idx].cols));
    return g;
  };
  // does any marble position with index < upto come closer than `clear` to these colliders?
  Scene.prototype.pathHits = function (cols, R, clear, upto) {
    const bb = bbox(cols), r = R + clear + 1;
    let hit = false;
    this.forCells(bb.x0 - r, bb.y0 - r, bb.x1 + r, bb.y1 + r, (k) => {
      if (hit) return;
      const a = this.sg.get(k);
      if (a) for (const si of a) {
        if (si >= upto) continue;
        const p = this.samples[si];
        if (p[0] < bb.x0 - r || p[0] > bb.x1 + r || p[1] < bb.y0 - r || p[1] > bb.y1 + r) continue;
        if (marbleGap(cols, p[0], p[1], R) < clear) { hit = true; return; }
      }
    });
    return hit;
  };
  // the smallest gap between these colliders and the marble positions with index < upto (for scoring)
  Scene.prototype.pathGap = function (cols, R, reach, upto) {
    const bb = bbox(cols), r = R + reach;
    let g = Infinity;
    this.forCells(bb.x0 - r, bb.y0 - r, bb.x1 + r, bb.y1 + r, (k) => {
      const a = this.sg.get(k);
      if (a) for (const si of a) {
        if (si >= upto) continue;
        const p = this.samples[si];
        if (p[0] < bb.x0 - r || p[0] > bb.x1 + r || p[1] < bb.y0 - r || p[1] > bb.y1 + r) continue;
        g = Math.min(g, marbleGap(cols, p[0], p[1], R));
      }
    });
    return g;
  };

  // ---------------------------------------------------------------------------------------------------------
  // Deterministic PRNG (the robustness gate's jitter; seeded per piece id and trial)
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function strHash(s) { let x = 2166136261; for (let i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 16777619); } return x >>> 0; }
  // Pitch -> key length (lower notes get longer keys, like a glockenspiel)
  function barLen(CANON, note) {
    const m = CANON.noteToMidi(note) || 72;
    return Math.max(44, Math.min(84, Math.round(112 - (m - 36) * 1.1)));
  }
  function cloneMarble(m) { return Object.assign({}, m, { contactT: new Map(m.contactT), noteT: new Map(m.noteT) }); }
  // One CANON step, counted against the deterministic work budget
  function stepW(ctx, w) { ctx.work++; ctx.CANON.step(w); }
  const outOfWork = (ctx) => ctx.work > ctx.workMax;

  // ---------------------------------------------------------------------------------------------------------
  // The robustness gate's jitter: per trial and piece id, a fixed offset (dx, dy, drot)
  function jitterOf(id, trial, opts) {
    const r = mulberry32(strHash(id) ^ Math.imul(trial + 1, 0x9e3779b1)), a = opts.gateAmps[trial] || 1;
    return [(r() * 2 - 1) * opts.gateJitterPos * a, (r() * 2 - 1) * opts.gateJitterPos * a, (r() * 2 - 1) * opts.gateJitterRot * a];
  }
  function jittered(p, trial, opts) {
    const j = jitterOf(p.id, trial, opts);
    return Object.assign({}, p, { x: p.x + j[0], y: p.y + j[1], rot: (p.rot || 0) + j[2] });
  }
  // Free flight (no pieces) with CANON's own integrator from a marble state until it crosses the plane through
  // (qx, qy) with normal (nx, ny); returns the crossing time (interpolated) and the crossing point
  function planeCross(ctx, m, time, qx, qy, nx, ny) {
    const h = ctx.h, G = ctx.CANON.GRAVITY;
    let x = m.x, y = m.y, vx = m.vx, vy = m.vy, t = time;
    let d0 = (x - qx) * nx + (y - qy) * ny;
    for (let k = 0; k < 400; k++) {
      vy += G * h;
      const sp = Math.sqrt(vx * vx + vy * vy);
      if (sp > ctx.CANON.MAX_SPEED) { vx *= ctx.CANON.MAX_SPEED / sp; vy *= ctx.CANON.MAX_SPEED / sp; }
      const x1 = x + vx * h, y1 = y + vy * h;
      const d1 = (x1 - qx) * nx + (y1 - qy) * ny;
      if (d0 < 0 && d1 >= 0) { const f = -d0 / (d1 - d0); return { t: t + f * h, x: x + (x1 - x) * f, y: y + (y1 - y) * f }; }
      if (d0 >= 0) return { t, x, y };
      x = x1; y = y1; d0 = d1; t += h;
    }
    return null;
  }

  // ---------------------------------------------------------------------------------------------------------
  // One chain: a dropper, one key per note, silent rails between, and an exit (a pail). ns = [{ note, N }]
  // (N = the physics step, counted from Play, at which the note must ring). P = { id, dropX, dropY, heading,
  // xL, xR, yMin }. The scene (ctx.scene) holds everything already built (earlier chains of a held tower).
  function searchChain(ns, ctx, P) {
    const { CANON, opts, h } = ctx;
    const R = CANON.MARBLE_R, G = CANON.GRAVITY, scene = ctx.scene;
    const n = ns.length, last = n - 1;
    const xlo = P.xL + R, xhi = P.xR - R, Wc = xhi - xlo;
    const yMin = P.yMin;
    const BIG = { w: 1e5, h: 1e6 };
    const M = Math.min(6, Math.ceil(Math.max(opts.gateTol, opts.gateTolHi) / h) + 2);   // gate checkpoints: M steps before each contact
    const T = opts.gateAmps.length;
    let curDepth = 0, switchbacks = 0, validations = 0, chainVfails = 0;
    const D = opts.debug, why = (k) => { if (D) { D[k] = (D[k] || 0) + 1; if (D.byDepth) { const b = D.byDepth[curDepth] || (D.byDepth[curDepth] = {}); b[k] = (b[k] || 0) + 1; } } return null; };
    const hwBar = CANON.HW.bar, hwRail = CANON.HW.rail;
    const rots = [0];
    for (let a = opts.rotStep; a <= opts.rotMax + 1e-9; a += opts.rotStep) rots.push(a, -a);
    const pid = (s) => P.id + s;
    const nodeMax = opts.nodeFactor * n;
    // runAhead[i]: seconds from note i until the next long note (one that a rail, stop or side wall can turn on)
    const runAhead = new Array(n).fill(0);
    for (let i = n - 2; i >= 0; i--) { const dti = (ns[i + 1].N - ns[i].N) * h; runAhead[i] = dti >= opts.railMinDt ? 0 : dti + runAhead[i + 1]; }
    let nodes = 0;
    let deepest = -1;

    const dropper = { id: pid('d'), type: 'dropper', x: P.dropX, y: P.dropY, rot: 0 };
    const mk0 = scene.mark();
    const tube = tubeCols(P.dropX, P.dropY);
    if (scene.pieceGap(tube, opts.pieceGap + 4) < opts.pieceGap || scene.pathHits(tube, R, opts.clearance + 1, scene.samples.length)) return null;
    const tubeIdx = scene.addPiece(dropper, tube, { pseudo: true }), skipTube = new Set([tubeIdx]);

    // how the marble reaches the first key: a free fall from the dropper, or a LAUNCH RAMP (a silent rail under the
    // dropper that sends it off sideways: a fast first note, or a prestissimo after a hold, needs that speed)
    const starts = (P.falls || opts.falls).map((fall) => ({ fall }));
    const ramps = [];
    if (opts.ramps) for (const sl of opts.rampSlopes) for (const L of opts.rampLens) for (const tf of opts.rampTfs) ramps.push({ fall: opts.rampFall, sl, L, tf });
    const dt0 = n > 1 ? (ns[1].N - ns[0].N) * h : 1;
    const startList = dt0 <= opts.rampFirstDt ? [...ramps, ...starts] : [...starts, ...ramps];
    for (const sv of startList) {
      if (outOfWork(ctx)) break;
      const fall = sv.fall;
      let ramp = null, rampCols = null;
      if (sv.sl) {
        const d = P.heading, a = d * sv.sl * RAD, nx = -Math.sin(a), ny = Math.cos(a), ddx = d * Math.cos(a), ddy = d * Math.sin(a);
        const Cx = P.dropX + nx * (R + hwRail) * 0, Cy = P.dropY + fall + (R + hwRail) / Math.cos(sv.sl * RAD);
        const up = opts.rampUp;
        ramp = { id: pid('ramp'), type: 'rail', x: +(Cx + ddx * (sv.L / 2 - up)).toFixed(4), y: +(Cy + ddy * (sv.L / 2 - up)).toFixed(4), rot: d * sv.sl, len: sv.L, note: null };
        rampCols = CANON.colliders(ramp);
        const bb = bbox(rampCols);
        if (bb.x0 < P.xL || bb.x1 > P.xR) { why('ramp-col'); continue; }
        if (scene.pieceGap(rampCols, opts.pieceGap + 2) < opts.pieceGap) { why('ramp-piece'); continue; }
        if (scene.pathHits(rampCols, R, opts.clearance, scene.samples.length)) { why('ramp-path'); continue; }
      }
      // the fall (and roll) to the first key's contact
      const w = CANON.createWorld({ board: BIG, pieces: ramp ? [ramp] : [] });
      const m = CANON.spawn(w, P.dropX, P.dropY, dropper.id);
      const path = [[m.x, m.y]];
      let snap = null, j1 = -1, left = -1, touched = false;
      for (let k = 1; k < 2000; k++) {
        const before = cloneMarble(m), tb = w.time;
        stepW(ctx, w);
        path.push([m.x, m.y]);
        if (!ramp) { if (m.y >= P.dropY + fall) { j1 = k; snap = { m: before, time: tb }; break; } continue; }
        const g = marbleGap(rampCols, m.x, m.y, R);
        if (g < 0.5) { left = -1; touched = true; } else if (touched && left < 0) left = k;
        if (left > 0 && k - left >= Math.round(sv.tf / h)) { j1 = k; snap = { m: before, time: tb }; break; }
      }
      const rel = ns[0].N - j1;
      if (j1 < 0 || rel < 1) continue;
      if (ramp) {
        // it must roll off the far end (not bounce off the ramp) and fly clear of it to the first key
        const endX = ramp.x + Math.cos(ramp.rot * RAD) * ramp.len / 2 * P.heading;
        if (P.heading * (path[j1][0] - endX) < 0) { why('ramp-short'); continue; }
        if (marbleGap(rampCols, path[j1][0], path[j1][1], R) < opts.clearance) { why('ramp-near'); continue; }
      }
      // re-base the snapshot on the song clock (the marble is released at step rel)
      snap.time += rel * h;
      snap.m = Object.assign(snap.m, { bornT: snap.m.bornT + rel * h, stillT: snap.m.stillT + rel * h });
      const pts = [];
      let ok = true;
      for (let k = 0; k < j1; k++) {
        pts.push([path[k][0], path[k][1], rel + k]);
        if (scene.marbleGap(path[k][0], path[k][1], R, opts.clearance + 2, skipTube) < opts.clearance) ok = false;
      }
      if (!ok) continue;
      // the gate's trials: marbles from the jittered dropper, to M steps before the first note
      const trials = [];
      for (let t = 0; t < T; t++) {
        const dj = jittered(dropper, t, opts);
        const wt = CANON.createWorld({ board: BIG, pieces: ramp ? [jittered(ramp, t, opts)] : [] });
        wt.time = rel * h;
        const mt = CANON.spawn(wt, dj.x, dj.y, dropper.id);
        for (let k = 0; k < ns[0].N - M - rel; k++) stepW(ctx, wt);
        trials.push({ m: cloneMarble(mt), time: wt.time });
      }
      // the exact marble at the same moment (for the drift probe)
      const we = CANON.createWorld({ board: BIG, pieces: ramp ? [ramp] : [] });
      we.time = rel * h;
      const me = CANON.spawn(we, dropper.x, dropper.y, dropper.id);
      for (let k = 0; k < ns[0].N - M - rel; k++) stepW(ctx, we);
      const early0 = { m: cloneMarble(me), time: we.time };
      const mk = scene.mark();
      const rampIdx = ramp ? scene.addPiece(ramp, rampCols, { silent: true }) : -1;
      scene.addSamples(pts);
      const st0 = { i: 0, snap, early: early0, start: { ramp, rel }, Pprev: path[j1 - 1], Pcur: path[j1], trials, heading: P.heading, legX: P.dropX, ref: null, maxDev: 0, prevIdx: ramp ? new Set([rampIdx]) : null };
      const chain = opts.search === 'beam' ? beam(st0) : dfsRoot(st0);
      if (chain) return { dropper, ramp, rel, fall, chain, nodes, deepest, vfails: chainVfails };
      scene.reset(mk);
    }
    scene.reset(mk0);
    return { fail: true, nodes, deepest };

    // BEAM SEARCH over the notes: keep the beamWidth best partial towers (cumulative score: readability, speeds,
    // clearances, robustness spread), each expanded into its best few candidates for the next note, with at most
    // beamPerParent children of one parent (so a dead end does not take every beam with it). The scene holds the
    // pieces of one partial tower at a time; switching towers undoes and re-applies only what differs.
    // DEPTH-FIRST SEARCH with backtracking: the best `branch` candidates of each note are tried in order
    function dfsRoot(st0) {
      const chosen = [];
      let unwind = -1, best = null, halt = false;
      const dfs = (st) => {
        if (halt || ++nodes > nodeMax || outOfWork(ctx)) return false;
        if (st.i > deepest) {
          deepest = st.i;
          if (D && D.keepDeep) D.deep = { i: st.i, pieces: [dropper, ...chosen.flatMap((c) => [c.key, ...c.conn.map((q) => q.piece)])], Pcur: st.Pcur, Pprev: st.Pprev };
        }
        if (D) { D.depth = D.depth || []; D.depth[st.i] = (D.depth[st.i] || 0) + 1; }
        const cands = diverse(expand(st), opts.branch);
        const n0 = nodes;
        for (const c of cands) {
          if (nodes - n0 > opts.subtreeNodes) { why('subtree-cap'); break; }   // this note has had its share: back up further
          const mk = scene.mark();
          apply(c);
          chosen.push(c);
          if (c.exit) {
            const v = validate(chosen, st0.start);
            if (!v.fails) return true;
            why('v-fail');
            if (!best || v.fails < best.fails) best = { fails: v.fails, chain: chosen.slice() };
            if (validations >= opts.validateMax) halt = true;
            unwind = Math.max(0, v.first - 1);
            chosen.pop();
            scene.reset(mk);
            return false;
          }
          if (dfs(c.next)) return true;
          chosen.pop();
          scene.reset(mk);
          if (halt || nodes > nodeMax || outOfWork(ctx)) return false;
          if (unwind >= 0) { if (st.i > unwind) return false; unwind = -1; }   // back at the note to change
        }
        return false;
      };
      if (dfs(st0)) { chainVfails = 0; return chosen; }
      if (!best) return null;
      for (const c of best.chain) apply(c);
      chainVfails = best.fails;
      return best.chain;
    }
    // VALIDATION of a finished chain (see DEFAULTS.validate): returns the first note any fresh copy gets wrong, or -1
    function validate(chosen, start) {
      const V = opts.validate || 0;
      if (!V) return { fails: 0 };
      validations++;
      const pieces = [dropper, ...(start.ramp ? [start.ramp] : []), ...chosen.flatMap((c) => [c.key, ...c.conn.map((q) => q.piece), ...(c.exit ? [c.exit.piece] : [])])];
      const endN = ns[n - 1].N + Math.round(1 / h);
      let first = Infinity, fails = 0;
      for (let v = 0; v < V; v++) {
        const pcs = pieces.map((p) => jittered(p, 1000 + v, opts));   // trials past gateAmps are at x1
        const w = CANON.createWorld({ board: BIG, pieces: pcs });
        w.time = start.rel * h;
        CANON.spawn(w, pcs[0].x, pcs[0].y, dropper.id);
        for (let q = start.rel; q < endN && w.marbles.length; q++) { stepW(ctx, w); if (w.notes.length > n) break; }
        let j = 0;
        for (; j < n; j++) {
          const a = w.notes[j];
          if (!a || a.pieceId !== chosen[j].key.id || Math.abs(a.t - ns[j].N * h) > opts.validateTol) break;
        }
        if (j >= n && w.notes.length > n) j = n - 1;
        if (j < n) { fails++; first = Math.min(first, j); }
      }
      if (D) (D.vlog = D.vlog || []).push(P.id + ' ' + fails + '/' + V + (fails ? ' first ' + first : ''));
      return { fails, first };
    }
    // The best candidates that differ: a child whose next contact is within diverseDist of a better child of the
    // same kind is a near-duplicate (it would lead into the same dead end) and is skipped
    function diverse(cands, n) {
      const out = [];
      for (const c of cands) {
        if (out.length >= n) break;
        if (c.next && out.some((o) => o.kind === c.kind && o.next && Math.hypot(o.next.Pcur[0] - c.next.Pcur[0], o.next.Pcur[1] - c.next.Pcur[1]) < opts.diverseDist)) continue;
        out.push(c);
      }
      return out;
    }
    function beam(st0) {
      let beams = [{ chain: [], st: st0, score: 0 }];
      const applied = [], marks = [];
      const setTo = (chain) => {
        let p = 0;
        while (p < applied.length && p < chain.length && applied[p] === chain[p]) p++;
        if (p < applied.length) { scene.reset(marks[p]); applied.length = p; marks.length = p; }
        for (let q = p; q < chain.length; q++) { marks.push(scene.mark()); apply(chain[q]); applied.push(chain[q]); }
      };
      for (let depth = 0; depth < n; depth++) {
        const kids = [];
        for (const b of beams) {
          if (++nodes > nodeMax || outOfWork(ctx)) break;
          setTo(b.chain);
          if (b.st.i > deepest || (b.st.i === deepest && D && D.keepDeep && !D.deep)) {
            deepest = b.st.i;
            if (D && D.keepDeep) D.deep = { i: b.st.i, pieces: [dropper, ...b.chain.flatMap((c) => [c.key, ...c.conn.map((q) => q.piece)])], Pcur: b.st.Pcur, Pprev: b.st.Pprev };
          }
          if (D) { D.depth = D.depth || []; D.depth[b.st.i] = (D.depth[b.st.i] || 0) + 1; }
          const cands = expand(b.st);
          for (const c of cands.slice(0, opts.beamKids)) kids.push({ parent: b, c, score: b.score + c.score });
        }
        if (!kids.length) { setTo([]); return null; }
        kids.sort((a, b) => a.score - b.score);
        if (depth === n - 1) { const kd = kids[0]; setTo([...kd.parent.chain, kd.c]); return applied.slice(); }
        const per = new Map(), next = [];
        for (const kd of kids) {
          if (next.length >= opts.beamWidth) break;
          const c = per.get(kd.parent) || 0;
          if (c >= opts.beamPerParent) continue;
          per.set(kd.parent, c + 1);
          next.push({ chain: [...kd.parent.chain, kd.c], st: kd.c.next, score: kd.score });
        }
        beams = next;
      }
      return null;
    }
    function apply(c) {
      scene.addPiece(c.key, c.keyCols, { note: true });
      const idx = c.conn.map((q) => scene.addPiece(q.piece, q.cols, { silent: true }));
      if (c.next) c.next.prevIdx = idx.length ? new Set(idx) : null;
      if (c.exit) scene.addPiece(c.exit.piece, c.exit.cols, { bucket: true });
      scene.addSamples(c.seg);
    }

    // Exact CANON run of `pieces` from a snapshot; visit(k, marble, world) after each step (k = 1 is the step of
    // the key's contact); returns 'done', 'removed:<why>' or visit's failure reason
    // caps = { at: dtSteps }: also keep the marble's exact state after `at` steps (one step before the next note:
    // the next node's snapshot) and M - 1 steps earlier (the robustness gate's reference)
    function run(snap, pieces, nSteps, visit, caps) {
      const w2 = CANON.createWorld({ board: BIG, pieces });
      w2.time = snap.time;
      const mm = cloneMarble(snap.m);
      w2.marbles.push(mm);
      for (let k = 1; k <= nSteps; k++) {
        stepW(ctx, w2);
        if (!w2.marbles.length) return 'removed:' + w2.removed[w2.removed.length - 1].why;
        if (caps) { if (k === caps.at - M + 1) caps.early = { m: cloneMarble(mm), time: w2.time }; if (k === caps.at) { caps.m = cloneMarble(mm); caps.time = w2.time; } }
        const r = visit(k, mm, w2);
        if (r) return r;
      }
      return 'done';
    }
    // the scene samples a new piece must keep clear of: all, except the approach to the key being placed now
    function approachLimit(cols) {
      let u = scene.samples.length;
      while (u > 0 && u > scene.samples.length - 40) { const p = scene.samples[u - 1]; if (marbleGap(cols, p[0], p[1], R) < opts.clearance) u--; else break; }
      return u;
    }

    // All candidates for note i: a key (angle, length, offset) and the connector to note i+1 (none, or a rail),
    // simulated exactly, checked, gated, scored (lower is better)
    function expand(st) {
      const i = st.i, isLast = i === last, note = ns[i].note;
      curDepth = i; switchbacks = 0;
      const dtSteps = isLast ? 0 : ns[i + 1].N - ns[i].N, dt = dtSteps * h;
      const vx = (st.Pcur[0] - st.Pprev[0]) / h, vy = (st.Pcur[1] - st.Pprev[1]) / h, sp = Math.hypot(vx, vy);
      const mx = (st.Pprev[0] + st.Pcur[0]) / 2, my = (st.Pprev[1] + st.Pcur[1]) / 2;
      const mat = CANON.PIECES.bar.mat;
      const th = thresholds(i);
      const L0 = Math.max(opts.minKeyLen, barLen(CANON, note));
      const lens = keyLens(L0, th);
      const direct = !isLast && dt <= opts.dtDirectMax;
      const railOk = !isLast && opts.rails && dt >= opts.railMinDt;
      const wallOk = !isLast && opts.walls && dt >= opts.wallMinDt;
      const bankOk = !isLast && opts.banks && dt <= opts.bankMaxDt && dt >= 0.14;
      const keys = [];
      for (const rot of rots) {
        const a = rot * RAD, nx = -Math.sin(a), ny = Math.cos(a), ux = Math.cos(a), uy = Math.sin(a);
        const vn = vx * nx + vy * ny;
        if (vn < th.vnMin || vn / sp < th.incMin) { why('k-vn'); continue; }
        const cx = mx + nx * (R + hwBar), cy = my + ny * (R + hwBar);
        // bounce preview (CANON's resolve: restitution, then Coulomb friction)
        let ox = vx - (1 + mat.e) * vn * nx, oy = vy - (1 + mat.e) * vn * ny;
        const tx = -ny, ty = nx, vt = ox * tx + oy * ty, maxF = mat.mu * (1 + mat.e) * vn;
        const dvt = Math.abs(vt) <= maxF ? vt : Math.sign(vt) * maxF;
        ox -= dvt * tx; oy -= dvt * ty;
        const base = (Math.abs(rot) > opts.rotSoft ? Math.pow((Math.abs(rot) - opts.rotSoft) / 12, 2) : 0);
        // preview scores: direct flight to the next note / a rail / the exit
        let sDirect = Infinity, sRail = Infinity, sLast = Infinity, sWall = Infinity;
        const rise = oy < 0 ? (oy * oy) / (2 * G) : 0;
        if (rise > opts.riseMax) { why('k-rise'); continue; }
        if (direct) {
          const px = mx + ox * dt, py = my + oy * dt + 0.5 * G * dt * dt;
          if (px > xlo + 4 && px < xhi - 4) sDirect = base + nextScore(st, mx, px, py, ox, oy + G * dt, dt, ox, rise);
        }
        if (railOk) {
          const d = Math.sign(ox) || 1, tap = oy < 0 ? -oy / G : 0.02;
          const xap = mx + ox * tap, room = d > 0 ? xhi - xap : xap - xlo;
          const Tr = dt - tap - 0.06 - 0.17, Lest = Math.abs(ox) * Tr + 40 * Tr * Tr;
          if (Tr > 0.08 && Math.abs(ox) > 90 && Lest + 60 < room) sRail = base + 0.3 + turnCost(st, mx, d) + Math.pow((Math.abs(ox) - 320) / 160, 2) + (rise < 8 ? 0.5 : 0) + Math.pow(Math.max(0, rise - 50) / 30, 2);
        }
        if (isLast) sLast = base + Math.abs(ox) / 250 + (rise > 40 ? (rise - 40) / 30 : 0);
        if (!Number.isFinite(Math.min(sDirect, sRail, sLast)) && !(wallOk && oy < -60) && !bankOk) { why('k-preview'); continue; }
        for (const len of lens) {
          const f = len / 2 - opts.endMargin - 4;
          for (const off of f > 6 ? [0, f, -f] : [0]) {
            // (rounded to 1e-6: Math.sin/cos may differ in the last bit between JS engines; the search then runs on
            // the rounded key, so Node and every browser build the same tower)
            const key = { id: pid('k' + i), type: 'bar', x: +(cx + ux * off).toFixed(6), y: +(cy + uy * off).toFixed(6), rot, len, note };
            const extra = (th.tight ? (len !== lens[0] ? 0.4 : 0) : (len !== L0 ? 0.4 : 0)) + (off ? 0.3 : 0);
            let sW = Infinity;
            if (wallOk && oy < -60 && Math.abs(ox) >= opts.wallVnMin) {
              // the apex meets a side wall; then a free fall (or a rail) to the next note. The marble falls back
              // 0.3 x its reach: it must pass clear of this key (its extent toward the wall) unless it is caught
              // higher up
              const d = Math.sign(ox), tap = -oy / G, xap = mx + ox * tap, e = edgeDist(xap, d);
              const tf = dt - tap, reach = Math.abs(ox) * tap;
              const ext = Math.max(d * ux * (off - len / 2), d * ux * (off + len / 2));
              const clearKey = tf < tap * 0.9 || dt >= opts.wallRailMinDt || reach * 0.7 > ext + 24;
              if (e > -2 && tf > 0.1 && reach > 30 && clearKey) sW = base + Math.pow(e / 50, 2) + (tf > 0.5 && dt < opts.wallRailMinDt ? Math.pow((tf - 0.5) / 0.1, 2) : 0) + Math.pow(Math.max(0, rise - 60) / 30, 2) + (rise < 12 ? 1 : 0);
            }
            let sB = Infinity;
            if (bankOk && Math.abs(ox) >= opts.wallVnMin) {
              // a bank shot: the flight reaches the tower's side, bounces off a side wall, and falls onto the next key
              const d = Math.sign(ox), te = edgeDist(mx, d) / Math.abs(ox);
              if (te > 0.04 && te < dt - 0.08) sB = base + 0.4 + Math.pow(Math.max(0, rise - 50) / 30, 2) + Math.pow(Math.min(te, dt - te) < 0.08 ? 1 : 0, 2);
            }
            keys.push({ key, rot, ox, oy, off, sDirect: sDirect + extra, sRail: sRail + extra, sLast: sLast + extra, sWall: sW + extra, sBank: sB + extra });
          }
        }
      }
      // each connector type keeps its own best few keys (static checks in preview order: the column, other pieces,
      // the path so far); a key's flight is simulated once and shared
      const checked = new Map();
      const pass = (k) => {
        if (checked.has(k)) return checked.get(k);
        const cols = CANON.colliders(k.key), bb = bbox(cols);
        let ok = true;
        if (bb.x0 < P.xL || bb.x1 > P.xR || bb.y0 < yMin) ok = !!why('k-bounds');
        else if (scene.pieceGap(cols, opts.pieceGap + 2) < opts.pieceGap) ok = !!why('k-piece');
        else { const upto = approachLimit(cols); if (scene.pathHits(cols, R, opts.clearance, upto)) ok = !!why('k-path'); }
        if (ok) k.cols = cols;
        checked.set(k, ok);
        return ok;
      };
      // one key per angle (its best variant that passes: the length and offset change the key, not the flight)
      // (every variant that passes is kept on the angle's first one, `alts`: if the flight grazes the key's own
      // extent, a shorter or re-centred key of the same angle is tried)
      const pick = (field, n) => {
        const list = keys.filter((k) => Number.isFinite(k[field])).sort((p, q) => p[field] - q[field]), outK = [], byRot = new Map();
        for (const k of list) {
          const head = byRot.get(k.rot);
          if (head) { if (head.alts.length < 4 && k !== head && !head.alts.includes(k) && pass(k)) head.alts.push(k); continue; }
          if (outK.length >= n) continue;
          if (pass(k)) { k.alts = k.alts || []; byRot.set(k.rot, k); outK.push(k); }
        }
        return outK;
      };
      const exitKeys = isLast ? pick('sLast', opts.topK) : [];
      const directKeys = direct ? pick('sDirect', opts.topK) : [];
      const railKeys = railOk ? pick('sRail', opts.railKeys) : [];
      const wallKeys = wallOk ? pick('sWall', opts.wallKeys) : [];
      const bankKeys = bankOk ? pick('sBank', opts.bankKeys) : [];
      const good = [...new Set([...exitKeys, ...directKeys, ...railKeys, ...wallKeys, ...bankKeys])];
      // exact simulation of each key's flight; then the connectors
      const out = [], railFlights = [];
      for (const k of good) {
        if (outOfWork(ctx)) break;
        if (isLast) { const e = simExit(st, k); if (e) out.push(e); continue; }
        let fl = simFlight(st, k, dtSteps);
        for (let a = 0; !fl && k.alts && a < k.alts.length; a++) {
          const alt = k.alts[a];
          fl = simFlight(st, alt, dtSteps);
          if (fl) { k.key = alt.key; k.cols = alt.cols; k.off = alt.off; k.sDirect = alt.sDirect; k.sRail = alt.sRail; k.sWall = alt.sWall; k.sLast = alt.sLast; }
        }
        if (!fl) continue;
        if (directKeys.includes(k)) { const c = directCand(st, k, fl, dtSteps); if (c) out.push(c); }
        if (railKeys.includes(k)) railFlights.push({ k, fl });
        if (wallKeys.includes(k)) for (const c of wallCands(st, k, fl, dtSteps)) out.push(c);
        if (bankKeys.includes(k)) { const c = bankCand(st, k, fl, dtSteps); if (c) out.push(c); }
      }
      // rails: the best landing spots over all keys (a shared budget)
      if (railFlights.length) {
        const spots = [];
        for (const { k, fl } of railFlights) for (const sp of railSpots(st, k, fl, dtSteps, null)) spots.push({ k, fl, sp });
        spots.sort((p, q) => p.sp.score + p.k.sRail - (q.sp.score + q.k.sRail));
        let tried = 0, made = 0;
        for (const x of spots) {
          if (tried >= opts.railSpotsTotal || made >= opts.railCandsMax || outOfWork(ctx)) break;
          const r = oneRail(st, x.k, x.fl, dtSteps, x.sp, null);
          if (r === 'skip') continue;
          tried++;
          if (r) { out.push(...r); made += r.length; }
        }
      }
      // the robustness gate on the best few; its spread joins the score
      out.sort((p, q) => p.score - q.score);
      const gated = [];
      let gateTries = 0, weak = 0;
      for (const c of out) {
        if (gated.length - weak >= opts.gateK || gateTries++ >= opts.gateTry || outOfWork(ctx)) break;
        const g = gate(st, c);
        if (!g) continue;
        c.weak = g.probe > opts.probeJump;   // failed the drift probe: kept only behind every candidate that passed it
        c.score += opts.wRobust * Math.pow(g.maxDev / 0.003, 2) + (c.weak ? 0 : opts.wProbe * Math.pow(g.probe / 0.004, 2));
        if (c.next) { c.next.trials = g.trials; c.next.maxDev = g.maxDev; }
        c.maxDev = g.maxDev;
        gated.push(c);
        if (c.weak) gateTries--, weak++;   // (a weak one does not use up the gate's quota)
        if (weak > opts.gateTry) break;
      }
      // look one note ahead: place the candidate, and count the keys that could take the next note (angle, clean
      // hit, room: the static checks only); a candidate that leaves no key is a dead end
      if (opts.lookahead && !isLast) {
        for (let q = gated.length - 1; q >= 0; q--) {
          const c = gated[q];
          const mk = scene.mark();
          apply(c);
          const nv = viableKeys(c.next, opts.lookahead);
          scene.reset(mk);
          if (!nv) { why('la-dead'); gated.splice(q, 1); continue; }
          if (nv < opts.lookahead) c.score += opts.wLook * (opts.lookahead - nv) / opts.lookahead;
        }
      }
      gated.sort((p, q) => (p.weak ? 1 : 0) - (q.weak ? 1 : 0) || p.score - q.score);
      return gated;
    }

    // A new stretch of marble path against the scene: in the column, clear of every placed piece, except the rail
    // it has just rolled off (st.prevIdx), which it may still be leaving (never touching it again, never
    // re-approaching it once clear). Returns the smallest gap (for scoring) or -1.
    function pathOk(st, path, from, to) {
      let minGap = Infinity, awayPrev = !st.prevIdx;
      const skip = st.prevIdx || null;
      for (let z = from; z < to; z++) {
        const [x, y] = path[z];
        if (x < xlo || x > xhi || y < yMin + R) return why('p-bounds') || -1;
        const g = scene.marbleGap(x, y, R, opts.softClear + 2, skip);
        if (g < opts.clearance) return why('p-scene') || -1;
        if (g < minGap) minGap = g;
        if (skip) {
          let gp = Infinity;
          for (const idx of skip) gp = Math.min(gp, marbleGap(scene.items[idx].cols, x, y, R));
          if (gp < 0.3) return why('p-prev-touch') || -1;
          if (!awayPrev) { if (gp >= opts.clearance) awayPrev = true; }
          else if (gp < opts.clearance) return why('p-prev-graze') || -1;
          if (awayPrev && gp < minGap) minGap = gp;
        }
      }
      return minGap;
    }
    function freeAtSt(st, x, y) {
      if (x < xlo || x > xhi || y < yMin + R) return false;
      return scene.marbleGap(x, y, R, opts.clearance + 2, st.prevIdx) >= opts.clearance;
    }
    // Hit margins per note: a note reached by a very short hop (<= fastDt) cannot be struck as hard (a steady run of
    // short hops settles at a normal speed of about g dt / (1 + e)), so it gets a slightly lower floor (still about
    // twice CANON's bounce threshold) and may use shorter keys (they must fit between hops)
    function thresholds(i) {
      const dtIn = i > 0 ? (ns[i].N - ns[i - 1].N) * h : 1, dtOut = i < last ? (ns[i + 1].N - ns[i].N) * h : 1;
      const fast = dtIn <= opts.fastDt;
      // tight: a very short hop on either side (the neighbouring key is close): short keys first
      const tight = Math.min(dtIn, dtOut) <= opts.fastDt;
      return { fast, tight, vnMin: fast ? opts.vnMinFast : opts.vnMin, incMin: fast ? opts.incMinFast : opts.incMin };
    }
    function keyLens(L0, th) {
      const out = [L0];
      if (L0 > opts.minKeyLen + 6) out.push(opts.minKeyLen);
      if (th.tight && opts.minKeyLenFast < opts.minKeyLen) out.push(opts.minKeyLenFast);
      return th.tight ? out.reverse() : out;
    }
    // How many keys (up to `enough`) could take note st.i: a clean hit (normal speed, incidence), in the column,
    // clear of every piece and of the path so far (static checks only, no simulation)
    function viableKeys(st, enough) {
      const i = st.i, note = ns[i].note;
      const vx = (st.Pcur[0] - st.Pprev[0]) / h, vy = (st.Pcur[1] - st.Pprev[1]) / h, sp = Math.hypot(vx, vy);
      const mx = (st.Pprev[0] + st.Pcur[0]) / 2, my = (st.Pprev[1] + st.Pcur[1]) / 2;
      const L0 = Math.max(opts.minKeyLen, barLen(CANON, note)), th = thresholds(i);
      let count = 0;
      for (const rot of rots) {
        const a = rot * RAD, nx = -Math.sin(a), ny = Math.cos(a), ux = Math.cos(a), uy = Math.sin(a);
        const vn = vx * nx + vy * ny;
        if (vn < th.vnMin || vn / sp < th.incMin) continue;
        const cx = mx + nx * (R + hwBar), cy = my + ny * (R + hwBar);
        for (const len of keyLens(L0, th)) {
          const f = len / 2 - opts.endMargin - 4;
          let ok = false;
          for (const off of f > 6 ? [0, f, -f] : [0]) {
            const cols = CANON.colliders({ id: 'v', type: 'bar', x: cx + ux * off, y: cy + uy * off, rot, len, note }), bb = bbox(cols);
            if (bb.x0 < P.xL || bb.x1 > P.xR || bb.y0 < yMin) continue;
            if (scene.pieceGap(cols, opts.pieceGap + 2) < opts.pieceGap) continue;
            if (scene.pathHits(cols, R, opts.clearance, approachLimit(cols))) continue;
            ok = true; break;
          }
          if (ok) { if (++count >= enough) return count; break; }
        }
      }
      return count;
    }
    // Is the marble at (x, y) in the column and clear of everything placed so far?
    function freeAt(x, y) {
      if (x < xlo || x > xhi || y < yMin + R) return false;
      return scene.marbleGap(x, y, R, opts.clearance + 2) >= opts.clearance;
    }
    // A key's flight: the marble strikes it (the note, at step 1), leaves it and flies on (no other piece)
    function simFlight(st, k, dtSteps) {
      const nSteps = dtSteps + 1;
      const path = [], vel = [], caps = { at: dtSteps };
      let departed = false, minGap = Infinity, top = Infinity;
      const res = run(st.snap, [k.key], nSteps, (q, mm, w2) => {
        if (q === 1) { if (w2.notes.length !== 1 || w2.notes[0].pieceId !== k.key.id) return 'no-note'; }
        else if (w2.notes.length !== 1) return 'extra-note';
        path.push([mm.x, mm.y]); vel.push([mm.vx, mm.vy]);
        if (mm.y < top) top = mm.y;
        if (q > 1) {
          const g = marbleGap(k.cols, mm.x, mm.y, R);
          if (!departed) { if (g >= opts.clearance) departed = true; else if (q > 40) return 'no-depart'; }
          else if (g < opts.clearance) return 'return';
        }
        return null;
      }, caps);
      if (res !== 'done') return why('f-' + res);
      return { path, vel, top, caps };
    }
    // Direct flight to the next note: the next key goes where the marble is at step N(i+1)
    function directCand(st, k, fl, dtSteps, pre) {
      const path = fl.path;
      const minGap = pathOk(st, path, 0, path.length);
      if (minGap < 0) return null;
      if (pre) { const Pc0 = path[dtSteps]; if (marbleGap(pre.cols[0], Pc0[0], Pc0[1], R) < opts.clearance + 6) return why('d-near-wall'); }
      const Pp = path[dtSteps - 1], Pc = path[dtSteps];
      const vx2 = (Pc[0] - Pp[0]) / h, vy2 = (Pc[1] - Pp[1]) / h, sp2 = Math.hypot(vx2, vy2);
      if (sp2 > opts.vMax || sp2 < thresholds(st.i + 1).vnMin * 1.15) return why('d-speed');
      if (marbleGap(k.cols, Pc[0], Pc[1], R) < opts.clearance + 4) return why('d-near-key');
      const snapNext = fl.caps;
      const seg = [];
      for (let q = 0; q < dtSteps; q++) seg.push([path[q][0], path[q][1], ns[st.i].N + q]);
      const vxOut = pre ? fl.vel[pre.q + 2][0] : fl.vel[2][0];
      const score = keyBase(k) + nextScore(st, pre ? pre.pieces[0].x : k.key.x, Pc[0], Pc[1], vx2, vy2, dtSteps * h, vxOut, Math.max(0, my0(st) - fl.top), !!pre) + softPen(minGap) + (pre ? pre.score + opts.wallCost : 0);
      const conn = pre ? pre.pieces.map((pc, q) => ({ piece: pc, cols: pre.cols[q] })) : [];
      return mkCand(st, k, conn, seg, snapNext, Pp, Pc, score, pre ? 'wall' : 'direct', vx2);
    }
    function my0(st) { return (st.Pprev[1] + st.Pcur[1]) / 2; }
    function keyBase(k) { return (Math.abs(k.rot) > opts.rotSoft ? Math.pow((Math.abs(k.rot) - opts.rotSoft) / 12, 2) : 0) + (k.key.len < Math.max(opts.minKeyLen, barLen(CANON, k.key.note)) && !thresholds(curDepth).tight ? 0.4 : 0) + (k.off ? 0.3 : 0); }
    function softPen(g) { return g < opts.softClear ? Math.pow((opts.softClear - g) / 6, 2) : 0; }
    function mkCand(st, k, conn, seg, snapNext, Pp, Pc, score, kind, vxArr) {
      const heading = Math.abs(vxArr) > 40 ? Math.sign(vxArr) : st.heading;
      const turned = heading !== st.heading;
      return { key: k.key, keyCols: k.cols, conn, seg, kind, score,
        early: snapNext.early,
        next: { i: st.i + 1, snap: { m: snapNext.m, time: snapNext.time }, early: snapNext.early, Pprev: Pp, Pcur: Pc, heading, legX: turned ? k.key.x : st.legX, trials: null, maxDev: 0 } };
    }
    // How far is x from the column's edge in direction d?
    function edgeDist(x, d) { return d > 0 ? xhi - x : x - xlo; }
    // Reversing the direction of travel mid-column is penalised (legs should cross the tower)
    function turnCost(st, x, d) {
      if (d === st.heading) return 0;
      const e = edgeDist(x, st.heading) / Wc;
      return e < 0.18 ? 0.15 : opts.turnBase + opts.turnSlope * e;
    }
    // Score of the marble arriving at (px, py) with velocity (vx2, vy2) after leaving a key at x0 in direction of
    // vxOut: keep crossing the tower, sane speeds, modest drops, room for the next key
    function nextScore(st, x0, px, py, vx2, vy2, dt, vxOut, rise, walled) {
      const d = Math.sign(vxOut) || st.heading;
      // fast notes may zig-zag (a ladder of keys); slower ones should cross the tower before they turn
      let s = walled ? 0 : dt <= opts.ladderDt ? Math.min(opts.ladderTurn, turnCost(st, x0, d)) : turnCost(st, x0, d);
      // very fast notes (a prestissimo) can only skim: nearly level, fast across, keys struck at ~ g dt / (1 + e)
      const vfast = dt <= opts.fastDt;
      if (vfast) {
        // steer towards the steady skim: keys tipped a few degrees forward, the marble arriving at about
        // (skimVx, skimVy); away from it the run decays within a few notes
        s += opts.wSkim * (Math.pow((Math.abs(vx2) - opts.skimVx) / 70, 2) + Math.pow((vy2 - opts.skimVy) / 45, 2));
      } else if (dt <= opts.ladderDt && Math.abs(vx2) > opts.vxFast) s += Math.pow((Math.abs(vx2) - opts.vxFast) / 80, 2);
      const sp2 = Math.hypot(vx2, vy2);
      if (sp2 < opts.vLo) s += Math.pow((opts.vLo - sp2) / 80, 2);
      if (sp2 > opts.vHi) s += Math.pow((sp2 - opts.vHi) / 80, 2);
      const dy = py - my0(st), dyMax = 50 + 110 * dt;
      if (dy > dyMax) s += Math.pow((dy - dyMax) / 50, 2);
      if (dy < 6) s += Math.pow((6 - dy) / 10, 2);
      const e = Math.min(px - xlo, xhi - px);
      if (e < 30) s += Math.pow((30 - e) / 15, 2);
      const dx = Math.abs(px - x0);
      if (dx < 18) s += Math.pow((18 - dx) / 10, 2);
      // a staircase, not a skimming stone: each hop should drop about stairSlope x its stride
      if (!walled && dt < 0.45) { const err = dy - (vfast ? opts.stairSlopeFast : opts.stairSlope) * dx; if (err < 0) s += opts.wStair * Math.pow(err / 25, 2); }
      const inext = st.i + 1;
      if (inext < last) {
        const dtn = (ns[inext + 1].N - ns[inext].N) * h, dm = Math.sign(vx2) || d;
        // running at an edge: the next note must turn the marble, and a fast marble needs room to be turned; a run
        // of short notes (no rail, stop or wall to turn on until it ends) needs room for the whole run
        const room = edgeDist(px, dm);
        const need = Math.min(Wc * 0.85, Math.min(Math.abs(vx2), opts.runSpeed) * Math.max(Math.min(Math.max(dtn, 0.25), 1.2), runAhead[inext]) * 0.7 + 70);
        if (room < need) s += opts.wEdge * Math.pow((need - room) / 80, 2);
        // the next key wants the marble falling onto it (a firm, well-angled hit), not skimming in from the side
        const vyWant = dtn >= opts.railMinDt ? opts.vyLong : dtn <= opts.fastDt ? 0 : opts.vyShort;
        if (vy2 < vyWant) s += Math.pow((vyWant - vy2) / 100, 2);
      }
      if (rise > 55) s += Math.pow((rise - 55) / 25, 2);
      return s;
    }

    // Rails: the key throws the marble onto a silent rail (it lands near the top of its arc), the marble rolls down
    // it and drops off its far end a set time (tfs) before the next note; the next key goes where it then is
    function railCands(st, k, fl, dtSteps, pre, onlySpots) {
      const out = [], path = fl.path, vel = fl.vel;
      const spots = [];
      const q0 = pre ? pre.from : 3;
      let kMax = Math.min(path.length - Math.round(0.1 / h), q0 + Math.round(0.45 / h));
      if (fl.bad >= 0) kMax = Math.min(kMax, fl.bad - 6);
      for (let q = q0; q < kMax; q += 2) {
        const [vx1, vy1] = vel[q];
        if (vy1 < 0) continue;
        const d = Math.sign(vx1);
        if (!d || Math.abs(vx1) < 90) continue;
        const sp1 = Math.hypot(vx1, vy1), th = Math.atan2(vy1, Math.abs(vx1)) / RAD;
        const opts2 = [];
        const soft = th - 4.5;
        if (soft >= 2 && soft <= 12) opts2.push({ sl: +soft.toFixed(3), soft: true });
        for (const sl of opts.railSlopes) {
          const vn = sp1 * Math.sin((th - sl) * RAD);
          if (vn >= opts.landFirmMin && vn <= opts.landFirmMax) opts2.push({ sl, soft: false });
        }
        for (const o of opts2) {
          // cheap look ahead: the rail's first stretch (from its upper end, which reaches back `land` units for the
          // landing) must keep clear of this key and of any piece already placed
          const a = d * o.sl * RAD, nx = -Math.sin(a), ny = Math.cos(a), ddx = d * Math.cos(a), ddy = d * Math.sin(a);
          const Cx = (path[q - 1][0] + path[q][0]) / 2 + nx * (R + hwRail), Cy = (path[q - 1][1] + path[q][1]) / 2 + ny * (R + hwRail);
          const phi = Math.max(1, Math.atan2(vx1 * nx + vy1 * ny, Math.abs(vx1 * ddx + vy1 * ddy)) / RAD);
          const land = Math.min(110, Math.max(opts.railLand, (opts.clearance + 3) / Math.tan(phi * RAD) + 6));
          const Ux = Cx - ddx * land, Uy = Cy - ddy * land;
          const seg0 = [pseudoSeg(Ux, Uy, Cx + ddx * 40, Cy + ddy * 40, hwRail)];
          const gk0 = pieceGapBetween(seg0, k.cols);
          if (gk0 < opts.pieceGap + 1) { why('r-spot-key'); continue; }
          if (pre && pre.cols.some((pc) => pieceGapBetween(seg0, pc) < opts.pieceGap + 2)) { why('r-spot-pre'); continue; }
          if (scene.pieceGap(seg0, opts.pieceGap + 2) < opts.pieceGap) { why('r-spot-piece'); continue; }
          spots.push({ q, d, sl: o.sl, soft: o.soft, score: (o.soft ? 0 : 0.6) + q * h * 2 + turnCost(st, k.key.x, d) });
        }
      }
      spots.sort((p, q) => p.score - q.score);
      if (onlySpots) return spots;
      let tried = 0;
      for (const sp of spots) {
        if (tried >= opts.railSpots || outOfWork(ctx)) break;
        const r = oneRail(st, k, fl, dtSteps, sp, pre);
        if (r === 'skip') continue;
        tried++;
        if (r) out.push(...r);
      }
      return out;
    }
    function railSpots(st, k, fl, dtSteps, pre) { return railCands(st, k, fl, dtSteps, pre, true); }
    // SIDE WALLS (regenerators): the key throws the marble up and it meets a vertical silent wall at the top of its
    // arc. With |vy| well inside CANON's sticking-friction cone (|vt| <= mu (1 + e) vn) the wall sets vy to exactly
    // 0 and sends the marble back at 0.3 x its speed, so the drift the jittered trials have accumulated is erased
    // (only a whole-step shift can survive). The marble then falls onto the next key (or onto a rail: long notes).
    function wallCands(st, k, fl, dtSteps) {
      const path = fl.path, vel = fl.vel, out = [];
      const wm = CANON.PIECES.wall.mat, hwW = CANON.HW.wall;
      let qa = -1;
      for (let q = 1; q < vel.length; q++) if (vel[q - 1][1] < 0 && vel[q][1] >= 0) { qa = q; break; }
      if (qa < 0) return why('w-noapex') || out;
      let tried = 0;
      for (const dq of [0, -1, 1, -2, 2, -3, 3, -4, 4]) {
        if (tried >= 2) break;
        const q = qa + dq;
        if (q < 6 || q >= path.length - Math.round(0.1 / h)) { why('w-q'); continue; }
        const [vxq, vyq] = vel[q];
        if (Math.abs(vxq) < opts.wallVnMin) { why('w-slow'); continue; }
        if (Math.abs(vyq) > opts.wallStick * wm.mu * (1 + wm.e) * Math.abs(vxq)) { why('w-cone'); continue; }
        const d = Math.sign(vxq);
        const xw = (path[q - 1][0] + path[q][0]) / 2 + d * (R + hwW), yc = (path[q - 1][1] + path[q][1]) / 2;
        if (d > 0 ? xw + hwW > P.xR : xw - hwW < P.xL) { why('w-col'); continue; }
        const Lw = opts.wallLen;
        const wall = { id: pid('w' + curDepth), type: 'wall', x: +xw.toFixed(4), y: +(yc - opts.wallTop + Lw / 2).toFixed(4), rot: 90, len: Lw, note: null };
        const wcols = CANON.colliders(wall);
        if (pieceGapBetween(wcols, k.cols) < opts.pieceGap + 2) { why('w-key'); continue; }
        if (scene.pieceGap(wcols, opts.pieceGap + 2) < opts.pieceGap) { why('w-piece'); continue; }
        if (scene.pathHits(wcols, R, opts.clearance, scene.samples.length)) { why('w-path'); continue; }
        let okA = true;
        for (let z = 0; z < q - 8 && okA; z++) if (marbleGap(wcols, path[z][0], path[z][1], R) < opts.clearance) okA = false;
        if (!okA) { why('w-approach'); continue; }
        tried++;
        const pre = { pieces: [wall], cols: [wcols], q };
        // the exact flight with the wall
        const p2 = [], v2 = [], caps2 = { at: dtSteps };
        let hit = -1, away = false, bad = -1;
        const res = run(st.snap, [k.key, wall], dtSteps + 1, (z, mm, w2) => {
          p2.push([mm.x, mm.y]); v2.push([mm.vx, mm.vy]);
          if (bad >= 0) return null;
          if (w2.notes.length !== 1) { bad = z - 1; return null; }
          const g = marbleGap(wcols, mm.x, mm.y, R);
          if (hit < 0) { if (g < 0.5) hit = z - 1; }
          else if (!away) { if (g >= opts.clearance) away = true; }
          else if (g < opts.clearance) return 'wall-again';
          if (z > 40 && marbleGap(k.cols, mm.x, mm.y, R) < opts.clearance) bad = z - 1;     // (falls back onto this key: only a rail above it can help)
          return null;
        }, caps2);
        if (res !== 'done') { why('w-x-' + res); continue; }
        if (hit !== q || v2[q][1] !== 0) { why('w-x-stick'); continue; }
        const fl2 = { path: p2, vel: v2, top: fl.top, bad, caps: caps2 };
        pre.from = q + 8;
        pre.score = Math.pow(edgeDist(xw, d) / 50, 2);
        // straight down onto the next key
        if (bad >= 0) why('w-x-falls-on-key');
        if (bad < 0 && dtSteps * h <= opts.dtDirectMax + 0.3) {
          const c = directCand(st, k, fl2, dtSteps, pre);
          if (c) out.push(c);
        }
        // or onto a rail first (long notes)
        if (opts.rails && dtSteps * h >= opts.wallRailMinDt) for (const c of railCands(st, k, fl2, dtSteps, pre)) out.push(c);
      }
      return out;
    }
    // STOP PLATES (regenerators): the marble rolls off the rail's end, crosses a short gap and hits a silent plate
    // square on (tilted to face it: inside the sticking-friction cone). The plate leaves it moving straight back at
    // 0.3 x its speed, whatever tangential error it had, and quantises its timing to the physics step: the drift
    // the roll accumulated is erased. It falls away below the rail's end onto the next key.
    function railStop(st, k, dtSteps, sp, rail, cols, path, vel, zOff, landed, pre) {
      const prePieces = pre ? pre.pieces : [];
      let zw = -1;
      for (let z = zOff; z < path.length - 1; z++) if (marbleGap(cols, path[z][0], path[z][1], R) >= opts.stopGap) { zw = z; break; }
      if (zw < 0) return why('s-nogap');
      const tf2 = (dtSteps - zw) * h;
      if (tf2 < 0.12) return why('s-tf');
      const [vx1, vy1] = vel[zw], v1 = Math.hypot(vx1, vy1);
      if (v1 < opts.wallVnMin) return why('s-slow');
      const ux = vx1 / v1, uy = vy1 / v1, hwW = CANON.HW.wall;
      const cx0 = (path[zw - 1][0] + path[zw][0]) / 2 + ux * (R + hwW), cy0 = (path[zw - 1][1] + path[zw][1]) / 2 + uy * (R + hwW);
      // the plate reaches up from the contact (its lower end just below it), so the marble falls away beneath it
      const rotW = Math.atan2(uy, ux) / RAD + 90, ax0 = Math.cos(rotW * RAD), ay0 = Math.sin(rotW * RAD), up = ay0 < 0 ? 1 : -1;
      const offW = opts.stopLen / 2 - opts.endMargin;
      const wall = { id: pid('w' + curDepth), type: 'wall', x: +(cx0 + up * ax0 * offW).toFixed(4), y: +(cy0 + up * ay0 * offW).toFixed(4), rot: +rotW.toFixed(4), len: opts.stopLen, note: null };
      const wcols = CANON.colliders(wall), wb = bbox(wcols);
      if (wb.x0 < P.xL || wb.x1 > P.xR) return why('s-col');
      if (pieceGapBetween(wcols, cols) < opts.pieceGap || pieceGapBetween(wcols, k.cols) < opts.pieceGap) return why('s-gap-own');
      for (const pc of (pre ? pre.cols : [])) if (pieceGapBetween(wcols, pc) < opts.pieceGap) return why('s-gap-own');
      if (scene.pieceGap(wcols, opts.pieceGap + 2) < opts.pieceGap) return why('s-piece');
      if (scene.pathHits(wcols, R, opts.clearance, scene.samples.length)) return why('s-path');
      for (let z = 0; z < zw - 6; z++) if (marbleGap(wcols, path[z][0], path[z][1], R) < opts.clearance) return why('s-approach');
      const p2 = [], v2 = [], caps = { at: dtSteps };
      let hit = -1, awayW = false, bad = -1, zAway = -1;
      const res = run(st.snap, [k.key, ...prePieces, rail, wall], dtSteps + 1, (z, mm, w2) => {
        p2.push([mm.x, mm.y]); v2.push([mm.vx, mm.vy]);
        if (bad >= 0) return null;
        if (w2.notes.length !== 1) { bad = z - 1; return null; }
        const gw = marbleGap(wcols, mm.x, mm.y, R);
        if (hit < 0) { if (gw < 0.5) hit = z - 1; return null; }
        if (!awayW) { if (gw >= opts.clearance) { awayW = true; zAway = z - 1; } } else if (gw < opts.clearance) bad = z - 1;
        if (marbleGap(cols, mm.x, mm.y, R) < opts.clearance || marbleGap(k.cols, mm.x, mm.y, R) < opts.clearance) bad = z - 1;
        return null;
      }, caps);
      if (res !== 'done') return why('s-x-' + res);
      if (hit !== zw) return why('s-x-hit');
      // square on: after the plate the marble moves exactly along the plate's normal (friction took the rest)
      const [ax, ay] = v2[zw], wa = wall.rot * RAD;
      if (Math.abs(ax * Math.cos(wa) + ay * Math.sin(wa)) > 1e-6) return why('s-x-slip');
      const edgeW = Math.min(wb.x0 - P.xL, P.xR - wb.x1);
      const out = [];
      // SWITCHBACK: a second rail under the plate carries the marble back across the tower, then it drops onto
      // the next key (long notes: the whole turn happens inside one note)
      if (opts.switchbacks && !(pre && pre.noStop) && zAway > 0 && tf2 >= opts.switchbackMinT && switchbacks < opts.switchbackMax) {
        switchbacks++;
        const pre3 = { pieces: [...prePieces, rail, wall], cols: [...(pre ? pre.cols : []), cols, wcols], from: zAway + 2, q: zw, noStop: true, kind: 'switchback',
          score: (pre ? pre.score : 0) + 0.3 + Math.pow(edgeW / opts.stopEdgeScale, 2) - opts.stopBonus + (sp.soft ? 0 : 0.5) + (rail.len < 90 ? 0.4 : 0) };
        const fl3 = { path: p2, vel: v2, top: -Infinity, bad, caps };
        for (const c of railCands(st, k, fl3, dtSteps, pre3)) out.push(c);
      }
      if (bad >= 0) { why('s-x-again'); return out; }
      const minGap = pathOk(st, p2, 0, p2.length);
      if (minGap < 0) return out;
      const Pp = p2[dtSteps - 1], Pc = p2[dtSteps];
      const vx2 = (Pc[0] - Pp[0]) / h, vy2 = (Pc[1] - Pp[1]) / h, sp2 = Math.hypot(vx2, vy2);
      if (sp2 > opts.vMax || sp2 < opts.vnMin * 1.15) return why('s-x-speed') || out;
      if (marbleGap(wcols, Pc[0], Pc[1], R) < opts.clearance + 6 || marbleGap(cols, Pc[0], Pc[1], R) < opts.clearance + 6) return why('s-x-near') || out;
      const snapNext = caps;
      const seg = [];
      for (let z = 0; z < dtSteps; z++) seg.push([p2[z][0], p2[z][1], ns[st.i].N + z]);
      const pg = Math.min(scene.pathGap(cols, R, opts.softClear, scene.samples.length), scene.pathGap(wcols, R, opts.softClear, scene.samples.length));
      const score = keyBase(k) + 0.3 + opts.stopCost + Math.pow(edgeW / opts.stopEdgeScale, 2) - opts.stopBonus + (sp.soft ? 0 : 0.5) + (rail.len < 90 ? 0.4 : 0) + nextScore(st, k.key.x, Pc[0], Pc[1], vx2, vy2, Math.min(tf2 + 0.3, dtSteps * h), sp.d, 0, true) + softPen(minGap) + softPen(pg) + (pre ? pre.score : 0);
      const conn = pre ? pre.pieces.map((pc, q) => ({ piece: pc, cols: pre.cols[q] })) : [];
      conn.push({ piece: rail, cols }, { piece: wall, cols: wcols });
      const c = mkCand(st, k, conn, seg, snapNext, Pp, Pc, score, pre ? 'wall+rail+stop' : 'rail+stop', vx2);
      c.tf = tf2; c.soft = sp.soft;
      out.push(c);
      return out;
    }
    // BANK SHOTS (fast notes): the tower's side wall turns the marble within one short note: it flies off the key,
    // bounces off a vertical silent wall at the column's edge, and falls onto the next key
    function bankCand(st, k, fl, dtSteps) {
      const path = fl.path, vel = fl.vel, hwW = CANON.HW.wall;
      let q = -1;
      for (let z = 4; z < path.length - Math.round(0.07 / h); z++) {
        const d = Math.sign(vel[z][0]);
        if (d && edgeDist(path[z][0], d) <= 2 * CANON.HW.wall + 1) { q = z; break; }     // (the wall stands just inside the column's edge)
      }
      if (q < 0) return why('b-noedge');
      const [vxq, vyq] = vel[q], d = Math.sign(vxq);
      if (Math.abs(vxq) < opts.wallVnMin) return why('b-slow');
      const xw = (path[q - 1][0] + path[q][0]) / 2 + d * (R + hwW), yc = (path[q - 1][1] + path[q][1]) / 2;
      const Lw = opts.bankLen;
      // the wall reaches below the contact (the marble falls along it after the bounce) and a little above
      const wall = { id: pid('w' + curDepth), type: 'wall', x: +xw.toFixed(4), y: +(yc - opts.endMargin - 6 + Lw / 2).toFixed(4), rot: 90, len: Lw, note: null };
      const wcols = CANON.colliders(wall), wb = bbox(wcols);
      if (wb.x0 < P.xL - 1 || wb.x1 > P.xR + 1) return why('b-col');
      if (pieceGapBetween(wcols, k.cols) < opts.pieceGap) return why('b-key');
      if (scene.pieceGap(wcols, opts.pieceGap + 2) < opts.pieceGap) return why('b-piece');
      if (scene.pathHits(wcols, R, opts.clearance, scene.samples.length)) return why('b-path');
      for (let z = 0; z < q - 6; z++) if (marbleGap(wcols, path[z][0], path[z][1], R) < opts.clearance) return why('b-approach');
      const p2 = [], v2 = [], caps = { at: dtSteps };
      let hit = -1, away = false;
      const res = run(st.snap, [k.key, wall], dtSteps + 1, (z, mm, w2) => {
        if (w2.notes.length !== 1) return 'notes';
        p2.push([mm.x, mm.y]); v2.push([mm.vx, mm.vy]);
        const g = marbleGap(wcols, mm.x, mm.y, R);
        if (hit < 0) { if (g < 0.5) hit = z - 1; }
        else if (!away) { if (g >= opts.clearance) away = true; }
        else if (g < opts.clearance) return 'wall-again';
        if (z > 40 && marbleGap(k.cols, mm.x, mm.y, R) < opts.clearance) return 'key-again';
        return null;
      }, caps);
      if (res !== 'done') return why('b-x-' + res);
      if (hit !== q) return why('b-x-hit');
      const fl2 = { path: p2, vel: v2, top: fl.top, bad: -1, caps };
      const pre = { pieces: [wall], cols: [wcols], q, from: q + 8, score: opts.bankCost, kind: 'bank' };
      const c = directCand(st, k, fl2, dtSteps, pre);
      if (c) c.kind = 'bank';
      return c;
    }
    function railPiece(Cx, Cy, d, sl, L, land) {
      const rot = d * sl, a = rot * RAD, ddx = d * Math.cos(a), ddy = d * Math.sin(a);
      return { id: pid('r' + curDepth), type: 'rail', x: +(Cx + ddx * (L / 2 - land)).toFixed(4), y: +(Cy + ddy * (L / 2 - land)).toFixed(4), rot, len: +L.toFixed(2), note: null };
    }
    function oneRail(st, k, fl, dtSteps, sp, pre) {
      const prePieces = pre ? pre.pieces : [], preCols = pre ? pre.cols : [];
      const path = fl.path;
      const { q, d, sl } = sp;
      const a = d * sl * RAD, nx = -Math.sin(a), ny = Math.cos(a), ddx = d * Math.cos(a), ddy = d * Math.sin(a);
      const P0 = path[q - 1], P1 = path[q];          // (path[q] = the marble after q + 1 steps)
      const Cx = (P0[0] + P1[0]) / 2 + nx * (R + hwRail), Cy = (P0[1] + P1[1]) / 2 + ny * (R + hwRail);
      const vq = fl.vel[q], phi = Math.max(1, Math.atan2(vq[0] * nx + vq[1] * ny, Math.abs(vq[0] * ddx + vq[1] * ddy)) / RAD);
      const land = Math.min(110, Math.max(opts.railLand, (opts.clearance + 3) / Math.tan(phi * RAD) + 6));
      sp.land = land;
      const Ux = Cx - ddx * land, Uy = Cy - ddy * land;      // the rail's upper end
      // room to the column's edge along the rail
      const room = ddx > 0 ? (P.xR - 6 - Ux) / ddx : (Ux - (P.xL + 6)) / -ddx;
      const Lcap = Math.min(opts.railMax, room);
      if (Lcap < opts.railMin + 20) return why('r-room') || 'skip';
      // quick static checks on the longest rail (it only gets shorter)
      const longR = railPiece(Cx, Cy, d, sl, Lcap, land);
      const upCols = CANON.colliders(railPiece(Cx, Cy, d, sl, opts.railMin, land));
      if (pieceGapBetween(upCols, k.cols) < opts.pieceGap + 4) return why('r-key') || 'skip';
      for (const pc of preCols) if (pieceGapBetween(upCols, pc) < opts.pieceGap + 2) return why('r-pre') || 'skip';
      if (scene.pieceGap(upCols, opts.pieceGap + 2) < opts.pieceGap) return why('r-piece') || 'skip';
      // the flight before landing must pass clear of the rail's upper end and stay on its upper side (a shallow
      // landing skims the rail for a while before it touches: that is the landing itself)
      for (let z = pre ? pre.from - 1 : 0; z < q - 1; z++) {
        const ax = path[z][0] - Cx, ay = path[z][1] - Cy, al = ax * ddx + ay * ddy, an = ax * nx + ay * ny;
        if (an > -(R + hwRail) + 0.05 && al > -land) return why('r-approach') || 'skip';          // below the rail's top
        if (al < -land + 6 && marbleGap(upCols, path[z][0], path[z][1], R) < opts.clearance) return why('r-approach-end') || 'skip';
      }
      // one long roll: where is the marble along the rail at each step?
      const along = [], gaps = [];
      const lCols = CANON.colliders(longR);
      const res = run(st.snap, [k.key, ...prePieces, longR], dtSteps + 1, (z, mm, w2) => {
        if (w2.notes.length !== 1) return 'notes';
        along.push((mm.x - Cx) * ddx + (mm.y - Cy) * ddy);
        gaps.push(marbleGap(lCols, mm.x, mm.y, R));
        return null;
      });
      if (res !== 'done') return why('r-long-' + res);
      let kc = -1;
      for (let z = 0; z < gaps.length; z++) if (gaps[z] < 0.5) { kc = z; break; }
      if (kc < 0 || Math.abs(kc - q) > 2) return why('r-land');
      const out = [];
      const seenL = new Set();
      // plain: the marble drops off the end onto the next key tf later; stop: it crosses a short gap to a stop plate
      // (a regenerator) and falls from there onto the next key tf later
      const variants = opts.tfs.map((tf) => ({ tf, stop: false }));
      if (opts.stops && !(pre && pre.noStop)) {
        for (const tf of opts.stopTfs) variants.push({ tf, stop: true });
        if (opts.switchbacks) for (const f of opts.switchbackAt) if (dtSteps * h * f >= opts.switchbackMinT + 0.05) variants.push({ tf: dtSteps * h * f, stop: true });
      }
      for (const v of variants) {
        let zl = dtSteps + 1 - Math.round(v.tf / h) - 1;         // index of the step at which it should leave the end
        if (v.stop && zl > 2) { const sp1 = Math.max(60, (along[zl] - along[zl - 1]) / h); zl -= Math.round((opts.stopGap + 8) / sp1 / h) + 1; }
        if (zl <= kc + 8) continue;
        if (gaps[zl] > 1.5) continue;                          // already gone from the long rail by then
        const L = Math.round((land + along[zl] + 2) * 10) / 10;
        if (L < opts.railMin || L > Lcap || seenL.has(L + (v.stop ? 's' : ''))) continue;
        seenL.add(L + (v.stop ? 's' : ''));
        const c = railExact(st, k, fl, dtSteps, sp, Cx, Cy, L, kc, pre, v.stop);
        if (Array.isArray(c)) out.push(...c); else if (c) out.push(c);
      }
      return out;
    }
    function railExact(st, k, fl, dtSteps, sp, Cx, Cy, L, kc, pre, stop) {
      const prePieces = pre ? pre.pieces : [], preCols = pre ? pre.cols : [];
      const rail = railPiece(Cx, Cy, sp.d, sp.sl, L, sp.land);
      const cols = CANON.colliders(rail), bb = bbox(cols);
      if (bb.x0 < P.xL || bb.x1 > P.xR || bb.y0 < yMin) return why('r-bounds');
      if (scene.pieceGap(cols, opts.pieceGap + 2) < opts.pieceGap) return why('r-piece2');
      if (pieceGapBetween(cols, k.cols) < opts.pieceGap) return why('r-key2');
      for (const pc of preCols) if (pieceGapBetween(cols, pc) < opts.pieceGap) return why('r-pre2');
      if (scene.pathHits(cols, R, opts.clearance, scene.samples.length)) return why('r-path');
      const path = [], vel = [], capsR = { at: dtSteps };
      let lastC = -1, landed = -1, minGap = Infinity, departed = false;
      const res = run(st.snap, [k.key, ...prePieces, rail], dtSteps + 1, (z, mm, w2) => {
        if (w2.notes.length !== 1) return 'notes';
        path.push([mm.x, mm.y]); vel.push([mm.vx, mm.vy]);
        const g = marbleGap(cols, mm.x, mm.y, R);
        if (g < 0.5) { if (landed < 0) landed = z; lastC = z; }
        else if (landed >= 0 && lastC === z - 1 && g < 3) { /* a small hop */ }
        if (z > 1 && landed < 0 && z > kc + 4) return 'no-land';
        if (pre && z > pre.from + 1) for (const pc of preCols) if (marbleGap(pc, mm.x, mm.y, R) < opts.clearance) return 'wall-again';
        if (z > 1) {
          const gk = marbleGap(k.cols, mm.x, mm.y, R);
          if (!departed) { if (gk >= opts.clearance) departed = true; else if (z > 40) return 'no-depart'; }
          else if (gk < opts.clearance) return 'key-again';
        }
        return null;
      }, capsR);
      if (res !== 'done') return why('r-x-' + res);
      if (landed < 0 || Math.abs(landed - 1 - kc) > 2) return why('r-x-land');
      // it must roll all the way to the far end and leave it, then fly free until the next note
      const zOff = lastC;          // (1-based step of the last contact)
      const tf = (dtSteps + 1 - zOff) * h;
      if (tf < 0.025) return why('r-x-tf');
      const ra = sp.d * sp.sl * RAD;
      const offAlong = ((path[zOff - 1][0] - Cx) * Math.cos(ra) + (path[zOff - 1][1] - Cy) * Math.sin(ra)) * sp.d;
      if (offAlong < L - sp.land - 12) return why('r-x-early');
      for (let z = landed; z < zOff; z++) if (marbleGap(cols, path[z - 1][0], path[z - 1][1], R) > 4) return why('r-x-hop');
      if (stop) return railStop(st, k, dtSteps, sp, rail, cols, path, vel, zOff, landed, pre);
      if (!capsR.early) return why('r-x-caps');
      // after its last contact it moves away from the rail's end for good (no graze), well clear before the next note
      let away = false;
      for (let z = zOff + 1; z <= dtSteps + 1; z++) {
        const g = marbleGap(cols, path[z - 1][0], path[z - 1][1], R);
        if (!away) { if (g >= opts.clearance) away = true; }
        else if (g < opts.clearance) return why('r-x-regraze');
      }
      if ((dtSteps + 1 - zOff) < M + 2) return why('r-x-depart');
      minGap = pathOk(st, path, 0, path.length);
      if (minGap < 0) return null;
      // speeds while rolling and at the next key
      for (let z = landed; z < zOff; z++) { const s = Math.hypot(vel[z - 1][0], vel[z - 1][1]); if (s < 80 || s > opts.vHi) return why('r-x-rollspeed'); }
      const Pp = path[dtSteps - 1], Pc = path[dtSteps];
      const vx2 = (Pc[0] - Pp[0]) / h, vy2 = (Pc[1] - Pp[1]) / h, sp2 = Math.hypot(vx2, vy2);
      if (sp2 > opts.vMax || sp2 < opts.vnMin * 1.15) return why('r-x-speed');
      if (marbleGap(k.cols, Pc[0], Pc[1], R) < opts.clearance + 4) return why('r-x-near-key');
      const snapNext = capsR;
      const seg = [];
      for (let z = 0; z < dtSteps; z++) seg.push([path[z][0], path[z][1], ns[st.i].N + z]);
      const pg = scene.pathGap(cols, R, opts.softClear, scene.samples.length);
      const score = keyBase(k) + 0.3 + (sp.soft ? 0 : 0.5) + (L < 90 ? 0.4 : 0) + nextScore(st, k.key.x, Pc[0], Pc[1], vx2, vy2, Math.min(tf + 0.3, dtSteps * h), sp.d, Math.max(0, my0(st) - fl.top)) + softPen(minGap) + softPen(pg);
      const conn = pre ? pre.pieces.map((pc, q) => ({ piece: pc, cols: pre.cols[q] })) : [];
      conn.push({ piece: rail, cols });
      const c = mkCand(st, k, conn, seg, snapNext, Pp, Pc, score + (pre ? pre.score : 0), pre ? pre.kind || 'wall+rail' : 'rail', vx2);
      c.tf = tf; c.soft = sp.soft;
      return c;
    }

    // The last note: the key sends the marble into a pail at the foot of the tower (or, failing that, off the
    // bottom of the board into the platform's catch trough)
    function simExit(st, k) {
      const nSteps = Math.round(2.5 / h);
      const path = [];
      let departed = false, bad = -1;
      const yFloor = Math.max(sceneBottom(), k.key.y) + 260;
      const res = run(st.snap, [k.key], nSteps, (q, mm, w2) => {
        if (q === 1) { if (w2.notes.length !== 1 || w2.notes[0].pieceId !== k.key.id) return 'no-note'; }
        else if (w2.notes.length !== 1) return 'extra-note';
        path.push([mm.x, mm.y]);
        if (q > 1) {
          const g = marbleGap(k.cols, mm.x, mm.y, R);
          if (!departed) { if (g >= opts.clearance) departed = true; else if (q > 40) return 'no-depart'; }
          else if (g < opts.clearance) return 'return';
        }
        if (bad < 0 && !freeAtSt(st, mm.x, mm.y)) bad = q - 1;
        if (mm.y > yFloor) return 'deep';
        return null;
      });
      if (res !== 'deep') return why('x-' + res);
      const lim = bad < 0 ? path.length : bad;
      const yC = k.key.y;
      for (let yr = yC + 45; yr < yC + 400; yr += 12) {
        let q = 0;
        while (q < lim && path[q][1] < yr) q++;
        if (q >= lim) break;
        const bucket = { id: pid('b'), type: 'bucket', x: +path[q][0].toFixed(4), y: +(path[q][1] + 35).toFixed(4), rot: 0, w: 70 };
        const bcols = CANON.colliders(bucket), bb = bbox(bcols);
        if (bb.x0 < P.xL || bb.x1 > P.xR) { why('xb-col'); continue; }
        if (pieceGapBetween(bcols, k.cols) < opts.pieceGap || scene.pieceGap(bcols, opts.pieceGap + 2) < opts.pieceGap) { why('xb-piece'); continue; }
        if (scene.pathHits(bcols, R, opts.clearance, scene.samples.length)) { why('xb-path'); continue; }
        let ok = true;
        for (let z = 0; z < q && ok; z++) if (marbleGap(bcols, path[z][0], path[z][1], R) < opts.clearance) ok = false;
        if (!ok) { why('xb-own'); continue; }
        const seg = [], pts2 = [];
        let outcome = null, dep2 = false;
        const r2 = run(st.snap, [k.key, bucket], nSteps, (z, mm, w2) => {
          if (w2.notes.length !== 1) return 'notes';
          seg.push([mm.x, mm.y, ns[st.i].N + z - 1]);
          pts2.push([mm.x, mm.y]);
          // the whole way into the pail (bounces in it included) it keeps clear of the key it left
          if (z > 1) { const g = marbleGap(k.cols, mm.x, mm.y, R); if (!dep2) { if (g >= opts.clearance) dep2 = true; } else if (g < opts.clearance) return 'key-again'; }
          return null;
        });
        outcome = r2;
        if (outcome !== 'removed:bucket') { why('xb-' + outcome); continue; }
        if (pathOk(st, pts2, 0, pts2.length) < 0) { why('xb-scene'); continue; }
        // the pail must hold the marble still (not rattle out): its last second is spent inside
        const score = keyBase(k) + Math.abs(path[q][0] - k.key.x) / 400 + (yr - yC) / 300;
        return { key: k.key, keyCols: k.cols, conn: [], seg, kind: 'exit', score, exit: { piece: bucket, cols: bcols }, next: null };
      }
      return why('x-nobucket');
    }
    function sceneBottom() {
      let y = 0;
      for (const it of scene.items) if (it.bb.y1 > y) y = it.bb.y1;
      return y;
    }

    // ROBUSTNESS GATE: carry the jittered trials from M steps before note i to M steps before note i+1 (or to the
    // pail) through the candidate's pieces (and every placed piece nearby), all jittered per trial. Every trial must
    // play note i on this key within gateTol of the exact time and nothing else, and arrive at the next contact
    // plane within gateTol and crossMax units of the exact marble.
    function gate(st, c) {
      const i = st.i, isLast = !c.next;
      const N0 = ns[i].N, tgt = N0 * h;
      const segBB = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
      for (const p of c.seg) { segBB.x0 = Math.min(segBB.x0, p[0]); segBB.x1 = Math.max(segBB.x1, p[0]); segBB.y0 = Math.min(segBB.y0, p[1]); segBB.y1 = Math.max(segBB.y1, p[1]); }
      const nearIdx = scene.near(segBB.x0, segBB.y0, segBB.x1, segBB.y1, 40).filter((idx) => !scene.items[idx].info || !scene.items[idx].info.pseudo);
      const own = [c.key, ...c.conn.map((q) => q.piece)];
      if (c.exit) own.push(c.exit.piece);
      const steps = isLast ? Math.round(2.6 / h) : ns[i + 1].N - M - (N0 - M);
      let ref = null;
      if (!isLast) {
        // the exact marble's crossing of the plane through its next contact point, normal to its velocity there
        const nx = c.next.Pcur[0] - c.next.Pprev[0], ny = c.next.Pcur[1] - c.next.Pprev[1], nl = Math.hypot(nx, ny);
        const mid = [(c.next.Pprev[0] + c.next.Pcur[0]) / 2, (c.next.Pprev[1] + c.next.Pcur[1]) / 2];
        const base = c.early;
        ref = { nx: nx / nl, ny: ny / nl, qx: mid[0], qy: mid[1] };
        ref.cross = planeCross(ctx, base.m, base.time, ref.qx, ref.qy, ref.nx, ref.ny);
        if (!ref.cross) return null;
      }
      // the drift probe (exact pieces): a marble late or early by a fraction of a step, moved back or on along its
      // flight, keeps its error through this connector (a connector that multiplies it is rejected)
      let probe = 0;
      if (ref && st.early && opts.probes && opts.probes.length && (ns[i + 1].N - N0) * h >= opts.probeMinDt) {
        const G = CANON.GRAVITY, pcs = nearIdx.map((idx) => scene.items[idx].piece).concat(own);
        for (const [ph, side] of opts.probes) {
          const tau = ph * h, m0 = st.early.m, pm = cloneMarble(m0), sp = Math.hypot(m0.vx, m0.vy) || 1;
          pm.x = m0.x - m0.vx * tau - side * m0.vy / sp;
          pm.y = m0.y - m0.vy * tau + 0.5 * G * tau * tau + side * m0.vx / sp;
          pm.vy = m0.vy - G * tau;
          const w = CANON.createWorld({ board: BIG, pieces: pcs });
          w.time = st.early.time;
          w.marbles.push(pm);
          for (let q = 0; q < steps && w.marbles.length; q++) stepW(ctx, w);
          const cr = w.notes.length === 1 && w.notes[0].pieceId === c.key.id && w.marbles.length ? planeCross(ctx, pm, w.time, ref.qx, ref.qy, ref.nx, ref.ny) : null;
          const ex = cr ? Math.abs(cr.t - ref.cross.t - tau) : Infinity;
          if (ex > probe) probe = ex;
          if (probe > opts.probeJump) { why('g-probe'); break; }
        }
      }
      let maxDev = 0;
      const trials = [];
      for (let t = 0; t < T; t++) {
        const tr = st.trials[t];
        const pcs = nearIdx.map((idx) => jittered(scene.items[idx].piece, t, opts)).concat(own.map((p) => jittered(p, t, opts)));
        const w = CANON.createWorld({ board: BIG, pieces: pcs });
        w.time = tr.time;
        const m = cloneMarble(tr.m);
        w.marbles.push(m);
        for (let q = 0; q < steps && w.marbles.length; q++) stepW(ctx, w);
        if (w.notes.length !== 1 || w.notes[0].pieceId !== c.key.id) return why('g-notes');
        const amp = opts.gateAmps[t] || 1, hi = amp > 1, tol = amp >= 2 ? opts.gateTol2x : hi ? opts.gateTolHi : opts.gateTol;
        // no connector (and no key) may make a sudden jump: at most gateJump x amp beyond what the copy carried in
        const jump = hi ? opts.gateJumpHi * amp : opts.gateJump;
        const sdev = w.notes[0].t - tgt, dev = Math.abs(sdev);
        if (dev > tol + 1e-9) return why('g-note-time');
        if (tr.dev !== undefined && Math.abs(sdev - tr.dev) > jump) return why('g-jump');
        if (!hi && dev > maxDev) maxDev = dev;
        if (hi && dev / 2 > maxDev) maxDev = dev / 2;
        if (isLast) {
          if (w.marbles.length || !w.removed.length || w.removed[w.removed.length - 1].why !== 'bucket') return why('g-exit');
          continue;
        }
        if (!w.marbles.length) return why('g-lost');
        const cr = planeCross(ctx, m, w.time, ref.qx, ref.qy, ref.nx, ref.ny);
        if (!cr) return why('g-cross');
        const sdt2 = cr.t - ref.cross.t, dt2 = Math.abs(sdt2);
        if (dt2 > tol) return why('g-arrive-time');
        if (Math.abs(sdt2 - sdev) > jump) return why('g-jump');
        if (Math.hypot(cr.x - ref.cross.x, cr.y - ref.cross.y) > opts.crossMax * (hi ? 2 : 1)) return why('g-arrive-cross');
        if (!hi && dt2 > maxDev) maxDev = dt2;
        if (hi && dt2 / 2 > maxDev) maxDev = dt2 / 2;
        trials.push({ m: cloneMarble(m), time: w.time, dev: sdt2 });
      }
      return { maxDev, trials, probe };
    }
  }

  // ---------------------------------------------------------------------------------------------------------
  // Play a layout through CANON: notes, marble-marble contacts, removals
  function simulateLayout(CANON, layout, seconds) {
    const w = CANON.createWorld(layout);
    CANON.scheduleReleases(w, layout, seconds);
    const n = Math.round(seconds / CANON.SUBSTEP);
    let contacts = 0, minMM = Infinity;
    const touching = new Set();
    for (let i = 0; i < n; i++) {
      CANON.step(w);
      const ms = w.marbles;
      for (let a = 0; a < ms.length; a++) for (let b = a + 1; b < ms.length; b++) {
        const dx = ms[a].x - ms[b].x, dy = ms[a].y - ms[b].y;
        if (Math.abs(dx) > 60 || Math.abs(dy) > 60) continue;
        const d = Math.hypot(dx, dy);
        if (d < minMM) minMM = d;
        if (d <= 2 * CANON.MARBLE_R + 1e-6) { const k = ms[a].id + ':' + ms[b].id; if (!touching.has(k)) { touching.add(k); contacts++; } }
      }
      if (i > 10 && !ms.length && w.releaseIdx >= w.releases.length) break;
    }
    return { world: w, notes: w.notes, contacts, minMarbleGap: minMM };
  }
  // The harness rule (verify-music.js): targets in order, same pitch, nearest unused note within tol
  function scoreNotes(played, targets, tol = 0.015) {
    const used = new Array(played.length).fill(false);
    let matched = 0, maxErr = 0, sumErr = 0;
    const misses = [];
    for (const tg of targets) {
      let best = -1, bestErr = Infinity;
      for (let i = 0; i < played.length; i++) {
        if (used[i] || played[i].note !== tg.note) continue;
        const e = Math.abs(played[i].t - tg.t);
        if (e < bestErr) { bestErr = e; best = i; }
      }
      if (best >= 0 && bestErr <= tol) { used[best] = true; matched++; maxErr = Math.max(maxErr, bestErr); sumErr += bestErr; }
      else misses.push({ t: +tg.t.toFixed(3), note: tg.note, nearestErr: best >= 0 ? +bestErr.toFixed(4) : null });
    }
    const extras = played.filter((p, i) => !used[i]).map((p) => ({ t: +p.t.toFixed(3), note: p.note }));
    return { targets: targets.length, played: played.length, matched, matchedPct: targets.length ? (100 * matched) / targets.length : 100,
      extras: extras.length, maxErrMs: +(maxErr * 1000).toFixed(2), meanErrMs: matched ? +((sumErr / matched) * 1000).toFixed(2) : null,
      firstMisses: misses.slice(0, 6), firstExtras: extras.slice(0, 6) };
  }

  // ---------------------------------------------------------------------------------------------------------
  // The song -> the tower. Tries one chain (no hold) with a few column widths; if the melody cannot be played by
  // one marble within the budget, it splits the melody at its longest gaps (holds: cup + dropper directly below).
  function solveSong(song, CANON, userOpts) {
    const opts = Object.assign({}, DEFAULTS, song.tower || {}, userOpts || {});
    const h = CANON.SUBSTEP;
    const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
    const t0 = now();
    const all = songNotes(song, h);
    const vi = melodyVoice(song, opts);
    const mel = all.filter((n) => n.vi === vi);
    const lead = Math.round(opts.lead / h) - Math.min(...mel.map((n) => n.ts));
    opts.h = h;
    const ctx = { CANON, opts, h, work: 0, workMax: opts.workBudget, scene: null, stats: {} };
    const ns = mel.map((n) => ({ note: n.note, N: lead + n.ts }));
    const attempts = [];
    let W = opts.boardW;
    let result = null;
    // one marble first (both starting sides; the standard board, then a wider one for runs that need the room),
    // then, on the widest board, with holds where the chain gets stuck
    // (opts.hint = { board, heading, holds } from a baked layout: go straight to the round that solved it offline;
    // every attempt starts from an empty scene, so the result is byte-identical and much faster to reach)
    const widths = opts.boardWs || [opts.boardW];
    let rounds = widths.map((bw) => [bw, false]);
    if (opts.holds) rounds.push([widths[widths.length - 1], true]);
    let variants = opts.variants || [{ heading: 1 }, { heading: -1 }];
    if (opts.hint) { rounds = [[opts.hint.board, !!opts.hint.holds]]; variants = [{ heading: opts.hint.heading }]; }
    // Every round has its own work budget (so a hinted solve, which runs one round, gets the same result). A round
    // whose tower some validation copies got wrong (DEFAULTS.validate) does not end the search: the other rounds
    // of the same kind (one marble, or with holds) are tried too, and the tower fewest copies got wrong is kept.
    for (const [bw, withHolds] of rounds) {
      if (result && withHolds) break;   // holds only when no single-marble tower exists
      for (const variant of variants) {
        ctx.workMax = ctx.work + opts.workBudget;
        const r = buildTower(ns, variant, ctx, bw, withHolds);
        attempts.push({ board: bw, holds: r.ok ? r.segs.length - 1 : withHolds ? 'adaptive' : 0, heading: variant.heading, ok: !!r.ok, deepest: r.deepest, nodes: r.nodes, work: ctx.work, validationFails: r.ok ? r.vfails : undefined });
        if (r.ok && (!result || r.vfails < result.vfails)) { result = r; result.heading = variant.heading; W = bw; }
        if (result && !result.vfails) break;
      }
      if (result && !result.vfails) break;
    }
    if (!result) throw new Error('tower solver: no layout for ' + song.id + ' ' + JSON.stringify(attempts));
    // assemble: T<k>_d (dropper), T<k>_k<i> (keys), T<k>_s<i> (silent rails), T<k>_b (pail)
    const pieces = [], keyNote = new Map();
    let maxY = 0;
    for (const seg of result.segs) {
      pieces.push(Object.assign({}, seg.dropper, { schedule: { mode: 'times', times: [+((seg.rel - 0.5) * h).toFixed(6)] } }));
      if (seg.ramp) pieces.push(seg.ramp);
      seg.chain.forEach((c, q) => {
        pieces.push(c.key);
        keyNote.set(c.key.id, seg.first + q);
        for (const cc of c.conn) pieces.push(cc.piece);
        if (c.exit) pieces.push(c.exit.piece);
      });
    }
    for (const p of pieces) { if (p.type === 'dropper') continue; const bb = bbox(CANON.colliders(p)); maxY = Math.max(maxY, bb.y1); }
    const H = Math.ceil((maxY + opts.bottomMargin) / 20) * 20;
    const leadIn = lead * h;
    // the beat grid starts at the melody's first bar (a canon's first violin enters at bar 3): beat 0 of the grid
    const bpb = song.beatsPerBar || 4, shift = Math.max(0, Math.floor(Math.min(...mel.map((n) => n.beat)) / bpb + 1e-9) * bpb);
    const gridStart = leadIn + makeClock(song)(shift);
    const layout = { v: 1, name: song.title, tempo: Math.round(song.tempo), board: { w: W, h: H }, pieces, timing: layoutTiming(song, gridStart, shift) };
    const targets = mel.map((n) => ({ t: +(leadIn + n.sec).toFixed(6), note: n.note, voice: n.vi }));
    applyGains(song, layout, targets, leadIn, keyNote);
    const tuned = pieces.filter((p) => p.note).length, silent = pieces.filter((p) => p.note === null).length;
    const stats = {
      solveMs: 0, work: ctx.work, workBudget: opts.workBudget, voice: song.voices[vi].name, voiceIndex: vi, notes: ns.length,
      holds: result.segs.length - 1, marbles: result.segs.length, validation: { copies: opts.validate, fails: result.vfails },
      hint: { board: W, heading: result.heading, holds: result.segs.length > 1 }, pieces: pieces.length, tuned, silent,
      rails: pieces.filter((p) => p.type === 'rail').length, board: { w: W, h: H }, leadIn: layout.timing.start, attempts,
      nodes: result.segs.reduce((a, s) => a + s.nodes, 0),
      kinds: result.segs.reduce((a, s) => { for (const c of s.chain) a[c.kind] = (a[c.kind] || 0) + 1; return a; }, {}),
      devTrace: result.segs.map((s) => s.chain.map((c) => (c.maxDev * 1000).toFixed(1) + ({ direct: 'd', rail: 'r', 'rail+stop': 'S', switchback: 'Z', wall: 'W', 'wall+rail': 'w', bank: 'B', exit: 'x' }[c.kind] || '?')).join(' ')),
      gateMaxDevMs: +(Math.max(...result.segs.map((s) => Math.max(0, ...s.chain.map((c) => c.maxDev || 0)))) * 1000).toFixed(2),
    };
    if (opts.verify) {
      const sim = simulateLayout(CANON, layout, Math.max(...targets.map((x) => x.t)) + 5);
      const sc = scoreNotes(sim.notes.map((x) => ({ t: x.t, note: x.note })), targets);
      stats.verify = { matchedPct: +sc.matchedPct.toFixed(2), extras: sc.extras, maxErrMs: sc.maxErrMs, contacts: sim.contacts,
        removed: sim.world.removed.map((r) => r.why), firstMisses: sc.firstMisses, firstExtras: sc.firstExtras };
    }
    stats.solveMs = Math.round(now() - t0);
    return { layout, targets, stats };
  }

  // One tower. withHolds = false: one chain for the whole melody (one marble). withHolds = true: the chain goes as
  // far as it can; where it gets stuck, the melody is cut at the longest note (or rest) before that point: that
  // segment ends in a pail and the next marble starts from a dropper directly below it (a HOLD), same column.
  function buildTower(ns, variant, ctx, W, withHolds) {
    const { opts, h } = ctx;
    ctx.scene = new Scene();
    const segs = [], n = ns.length;
    let nodes = 0, deepest = 0, start = 0;
    const xL = opts.colMargin, xR = W - opts.colMargin;
    let heading = variant.heading;
    let dropX = heading > 0 ? xL + 70 : xR - 70, dropY = opts.dropY, yMin = opts.dropY + 12;
    const P = (end) => ({ id: 'T' + (segs.length + 1) + '_', dropX, dropY, heading, xL, xR, yMin, falls: segs.length ? opts.holdFalls : opts.falls });
    const next = (r) => {
      const b = r.chain[r.chain.length - 1].exit.piece;
      dropX = b.x; dropY = b.y + 30 + 3 + opts.holdGap + 97; yMin = b.y + 30 + 3;
      heading = dropX < W / 2 ? 1 : -1;
    };
    // after a hold, a segment is tried heading either way, and once more with a wider search
    const segSearch = (a, b) => {
      const tries = segs.length ? [[heading, null], [-heading, null], [heading, opts.segRetry]] : [[heading, null]];
      let r = null;
      for (const [hd, more] of tries) {
        const keep = heading, saved = {};
        heading = hd;
        if (more) for (const k in more) { saved[k] = opts[k]; opts[k] = more[k]; }
        r = searchChain(ns.slice(a, b), ctx, P());
        if (more) for (const k in more) opts[k] = saved[k];
        heading = keep;
        nodes += r ? r.nodes || 0 : 0;
        if (r && !r.fail) return r;
        if (outOfWork(ctx)) break;
      }
      return r;
    };
    while (start < n) {
      const r = segSearch(start, n);
      if (r && !r.fail) { r.first = start; segs.push(r); return { ok: true, segs, nodes, deepest: n - 1, vfails: segs.reduce((a, g) => a + g.vfails, 0) }; }
      const deep = start + (r ? r.deepest || 0 : 0);
      deepest = Math.max(deepest, deep);
      if (!withHolds || segs.length >= opts.maxHolds || outOfWork(ctx)) return { ok: false, nodes, deepest };
      // hold points: a long note or rest before the dead end (latest and longest first)
      const cuts = [];
      for (let c = Math.max(start + opts.holdMinSeg, 1); c <= Math.min(deep + 1, n - opts.holdMinSeg); c++) {
        const gap = (ns[c].N - ns[c - 1].N) * h;
        if (gap >= opts.holdMinGap) cuts.push({ c, score: gap * 2 + (c - start) / Math.max(1, deep - start) });
      }
      cuts.sort((a, b) => b.score - a.score);
      let ok = false;
      for (const { c } of cuts.slice(0, opts.holdTries)) {
        const r1 = segSearch(start, c);
        if (r1 && !r1.fail) { r1.first = start; segs.push(r1); start = c; next(r1); ok = true; break; }
        if (outOfWork(ctx)) break;
      }
      if (!ok) return { ok: false, nodes, deepest };
    }
    return { ok: true, segs, nodes, deepest, vfails: segs.reduce((a, g) => a + g.vfails, 0) };
  }

  // ---------------------------------------------------------------------------------------------------------
  // Loudness per piece: the platform plays a note at its impact's velocity times the struck piece's `gain` (only
  // stored when it is not 1): the song's own level (song.gain) and, for a song with statements (Mountain King:
  // song.statementBeats, song.statementGain), a crescendo from statement to statement. CANON ignores gain.
  function applyGains(song, layout, targets, leadIn, keyNote) {
    const sec = makeClock(song), st = song.statementGain, stBeats = song.statementBeats || 16;
    const statementOf = (t) => { let k = 0; while (st && k + 1 < st.length && leadIn + sec((k + 1) * stBeats) <= t + 1e-6) k++; return k; };
    const keys = layout.pieces.filter((p) => p.note);
    keys.forEach((p) => {
      const tg = keyNote.has(p.id) ? targets[keyNote.get(p.id)] : null;
      let g = song.gain || 1;
      if (st && tg) g *= st[statementOf(tg.t)];
      g = Math.round(Math.min(1.5, Math.max(0.25, g)) * 1000) / 1000;
      if (g !== 1) p.gain = g;
    });
  }

  // The demo list (id, title, composer) from the song library, when songs.js is loaded
  function loadSongs() {
    if (typeof MARBLE_SONGS !== 'undefined') return MARBLE_SONGS;     // eslint-disable-line no-undef
    try { if (typeof require === 'function') return require('./songs.js'); } catch (e) { /* not available */ }
    return null;
  }
  // The round that solved a baked layout: its board width, the side the first dropper stands on, and whether it holds
  function hintFrom(layout) {
    const drops = layout.pieces.filter((p) => p.type === 'dropper');
    const first = drops.find((d) => d.id === 'T1_d') || drops[0];
    return { board: layout.board.w, heading: first && first.x < layout.board.w / 2 ? 1 : -1, holds: drops.length > 1 };
  }
  const api = { solveSong, songNotes, makeClock, simulateLayout, scoreNotes, melodyVoice, hintFrom, DEFAULTS,
    solveDemo(id, CANON, opts) { const S = loadSongs(); const song = S && S.find((s) => s.id === id); if (!song) throw new Error('no demo ' + id); return solveSong(song, CANON, opts); },
    _internal: { searchChain, Scene } };
  Object.defineProperty(api, 'demos', { enumerable: true, get() { const S = loadSongs(); return S ? S.map((s) => ({ id: s.id, title: s.title, composer: s.composer, year: s.year })) : []; } });
  return api;
});
