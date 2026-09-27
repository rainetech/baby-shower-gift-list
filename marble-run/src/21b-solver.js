/* ============================================================================
 *  MarbleSolver: turns a song into a Marble Music layout that plays it
 *
 *  The machine has two parts, both built only from canonical pieces and checked with CANON (the shared physics,
 *  used verbatim):
 *
 *  1. MELODY CASCADES (from solver A). Every melodic voice (the melody, the voices of a round, the violins of a
 *     canon) is cut into phrases. Each distinct phrase gets a LANE: a dropper on the top row releases one marble,
 *     which cascades down a ladder of tuned bars (plus the odd spring or rolling rail). Every piece sits exactly
 *     where the marble will be at its note time and is angled to throw the marble on to the next piece. The lane
 *     ends in a collector pail (or the marble drops out of the bottom of the board). A phrase that repeats, or
 *     that another voice sings later (a round, a canon), reuses its lane: the dropper releases another marble.
 *     Lanes with the same rhythm reuse one geometry, retuned (the rhythm cache), so they read as identical modules.
 *  2. BASS RACK (from solver C). Bass voices are played by a compact glockenspiel rack at the bottom of the board:
 *     one dropper and one bar tilted 40 degrees per pitch, the strike 12 units from the bar's lower end; the marble
 *     glances off and falls into the catch trough. Every column is a translate of one prototype, so rack paths
 *     never cross; a pitch that repeats too fast gets a second column (greedy interval partitioning). The rack
 *     sits bottom centre (bottom left when tall lanes need the room). Melody the cascades cannot hold (Grieg's
 *     prestissimo, or any song that would overflow the board) goes to a second, melody rack at the bottom right.
 *
 *  The solver ranks phrase plans (shared or per-voice lanes, 1-4 bar phrases), solves the best few for real and
 *  keeps the most readable layout (fewest pieces, most identical modules, one tier, a filled board).
 *
 *  Timing: a note that must ring at physics step N is played by a marble released at step N - K (K = steps from
 *  release to that note, measured with CANON). Releases are scheduled half a step early, (N - K - 0.5) * h, so
 *  float accumulation in world.time can never move one. Targets are the exact musical times.
 *  Search budgets are deterministic (counted CANON steps, never the wall clock): the same song gives the same
 *  layout on any machine. Works in Node (module.exports) and in a browser (global MarbleSolver).
 *
 *  solveSong(song, CANON, opts) -> { layout, targets: [{ t, note, voice }], stats }
 *  demos -> [{ id, title, composer, year }] (from songs.js, when it is loaded)
 * ========================================================================== */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.MarbleSolver = api;
})(typeof globalThis !== 'undefined' ? globalThis : typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const BOARD = { w: 1600, h: 1000 };
  const RAD = Math.PI / 180;
  const DEFAULTS = {
    // ---- melody lanes
    dropY: 100,           // lane dropper row (marble spawn y): the dropper drawing (97 units above) stays on the board
    edge: 12,             // keep pieces and marbles this far inside the board's sides
    pieceGap: 8,          // min gap between two piece surfaces
    clearance: 5,         // min gap between a marble and any piece it must not touch
    pathSep: 10,          // two marbles never come closer than 2r + this
    vnMin: 170,           // min approach speed along the piece normal (keeps the contact step robust, far from BOUNCE_MIN)
    vLo: 300, vHi: 720,   // preferred marble speed arriving at a piece
    minSpacing: 45,       // vertical room the height plan gives each note at least
    stretchMax: 2.2,      // a lane's height plan may stretch its natural spacing this much to fill its band
    incMin: 0.34,         // min sine of the angle of incidence (no grazing hits)
    rotStep: 5, rotMax: 65, rotSoft: 45,
    topK: 10,             // exact simulations per search node
    branch: 4,            // children explored per node
    nodeBudget: 300,      // search nodes per chain attempt
    jitterTrials: 16,     // per-lane robustness check: pieces jittered by up to jitterPos units / jitterRot degrees,
    jitterPos: 0.1, jitterRot: 0.05, robustTol: 0.006,   // every note must stay within robustTol seconds
    barOptions: [4, 3, 2, 1, 0], // phrase lengths (bars) tried per voice; 0 = one note per marble
    maxGap: 0.9,          // seconds; a longer gap inside a phrase splits it (the release schedule covers it)
    maxPhraseNotes: 14,
    maxPhraseSec: 6.5,
    maxLaneDrop: 640,     // a phrase whose notes need more vertical room than this (estimated) is cut
    fastDt: 0.215,        // phrases with notes closer than this are shared by two alternating marbles
    splitInterleaveDt: 0.34,
    lead: 1.2,            // seconds from Play to the song's first note
    exitMax: 4,           // seconds allowed to leave the board (or reach a bucket) after the last note
    workBudget: 6e7,      // deterministic search budget: CANON steps the solver may simulate in total
    maxPlans: 8,
    planCandidates: 3,    // complete plans solved and compared (layoutScore) before choosing one
    maxSplits: 8,
    tiers: 2,             // allow two-tier columns when one row of lanes does not fit
    tier2Cost: 200,       // planning cost of a two-tier plan (busier, and its pairs are harder to solve)
    melodyDripCost: 800,
    rails: true,          // tracks: land (the note), roll, drop off the end - for gaps of at least railMinDt seconds
    railMinDt: 0.4, railSlopes: [6, 10, 15, 21, 28], railLens: [70, 110, 160], railCost: 1.2,
    laneWidths: [150, 190, 240],
    laneWidths1: [110, 150, 190],
    maxLaneGap: 150,      // spare board width is shared out between the columns, up to this much each
    abortWidth: 1700,     // a plan whose solved lanes (plus estimates) already need this much width is abandoned
    fill: 0.8,            // planning aims the lanes' total width at this fraction of the board
    buckets: true,
    bucketGap: 1.35,      // a lane may end in a bucket only if its marbles are at least this many seconds apart
    shareVoices: true,    // identical phrases of different voices (a round, a canon) share a lane ...
    shareChoice: true,    // ... or, if that ranks better, every voice gets its own lanes (identical modules)
    moduleBonus: 60,      // planning bonus for each lane that repeats an earlier lane's rhythm (an identical module)
    moduleScore: 10, tierCost: 12, fillScore: 300, dripScore: 8,   // layoutScore weights (see layoutScore)
    rhythmCache: true,    // a phrase with the rhythm of a solved lane reuses its geometry, retuned
    // ---- bass rack
    rack: true,
    rackAlign: 'auto',    // 'auto' | 'left' | 'center' | 'right': where the bass rack sits along the bottom
    rackY: 900,           // marble-centre height of the rack strikes
    rackTheta: 40, rackDrop: 25, rackLaneGap: 24, rackMargin: 4, rackVisualGap: 6,
    rackGap: 24,          // vertical room kept between the rack's dropper drawings and the lanes above it
    rackSpread: 1.25,     // spare room may widen the rack's column spacing up to this factor
    rackMaxWidth: 700,    // shrink the rack's bars if it would be wider than this
    rackFallback: true,   // melody that the cascades cannot hold moves to a melody rack (see solveSong)
    verify: true,         // play the finished layout through CANON once and report the score in stats
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
  function layoutTiming(song, start) {
    const t = { start: +start.toFixed(6), beatsPerBar: song.beatsPerBar || 4 };
    if (!Number.isInteger(t.beatsPerBar)) t.pulse = 0.5;
    let base = song.tempo || 100;
    const changes = [];
    for (const c of song.tempoMap || song.tempoChanges || []) { if (c[0] <= 0) base = c[1]; else changes.push(c); }
    changes.sort((a, b) => a[0] - b[0]);
    const map = [[0, base]];
    for (const c of changes) if (c[1] !== map[map.length - 1][1]) map.push([c[0], c[1]]);
    if (map.length > 1 || base !== Math.round(song.tempo)) t.tempoMap = map;
    return t;
  }
  const isBassVoice = (v) => (v.rack ? v.rack === 'bass' : /bass/i.test(v.name || ''));

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
  // Phrases. A unit = one distinct phrase { key, voice, notes: [{ note, s (steps after the first) }], occ: [ts0...] }
  function phraseKey(voice, notes, share) { return (share ? '*' : voice) + ':' + notes.map((n) => n.note + '@' + n.s).join(','); }
  function mergeUnits(occs, prev, share) {
    const map = new Map();
    for (const u of prev || []) map.set(u.key, u);
    for (const o of occs) {
      const base = o.key0 || phraseKey(o.voice, o.notes, share);
      let key = base, u = map.get(key), dup = 1;
      // the same phrase at the same moment in two voices (a unison) needs a second lane
      while (u && u.occ.includes(o.ts0)) { key = base + '#' + ++dup; u = map.get(key); }
      if (!u) map.set(key, (u = { key, voice: o.voice, notes: o.notes, occ: [] }));
      u.occ.push(o.ts0);
    }
    const units = [...map.values()];
    for (const u of units) u.occ.sort((a, b) => a - b);
    return units;
  }
  // One voice, N bars per phrase (N = 0: every note is its own one-note phrase)
  function segmentVoice(voice, ns, bpb, N, opts) {
    const groups = [];
    let cur = null, curG = null;
    for (const n of ns) {
      const bar = Math.max(0, Math.floor(n.beat / bpb + 1e-9)), g = N ? Math.floor(bar / N) : n.ts;
      const gap = cur ? n.sec - cur[cur.length - 1].sec : 0;
      if (!cur || g !== curG || gap > opts.maxGap) { cur = []; groups.push(cur); curG = g; }
      cur.push(n);
    }
    // a lone note (a long note alone in its bar) joins the phrase before it, when that phrase runs into it
    if (N) for (let k = groups.length - 1; k >= 1; k--) {
      const g = groups[k], p = groups[k - 1];
      if (g.length === 1 && g[0].sec - p[p.length - 1].sec <= opts.maxGap && p.length < opts.maxPhraseNotes) { p.push(g[0]); groups.splice(k, 1); }
    }
    // over-long groups are cut into equal parts (at the longest gaps near the cut points)
    for (let k = 0; k < groups.length; k++) {
      const gr = groups[k];
      // (a lane can only be so tall: long notes need ~20 + 220 dt^2 units of drop each)
      let hgt = 0;
      for (let i = 1; i < gr.length; i++) hgt += spacing(gr[i].sec - gr[i - 1].sec, opts);
      const parts = Math.max(Math.ceil(gr.length / opts.maxPhraseNotes), Math.ceil((gr[gr.length - 1].sec - gr[0].sec) / opts.maxPhraseSec), Math.ceil(hgt / opts.maxLaneDrop));
      if (parts <= 1) continue;
      const cuts = [];
      for (let q = 1; q < parts; q++) {
        const ideal = Math.round((q * gr.length) / parts);
        let best = ideal, bestGap = -1;
        for (let c = Math.max(1, ideal - 1); c <= Math.min(gr.length - 1, ideal + 1); c++) {
          const gp = gr[c].sec - gr[c - 1].sec;
          if (gp > bestGap + 1e-9) { bestGap = gp; best = c; }
        }
        cuts.push(best);
      }
      const pieces = [];
      let from = 0;
      for (const c of cuts) { if (c > from) { pieces.push(gr.slice(from, c)); from = c; } }
      pieces.push(gr.slice(from));
      groups.splice(k, 1, ...pieces);
      k += pieces.length - 1;
    }
    return groups.map((g) => ({ voice, ts0: g[0].ts, notes: g.map((n) => ({ note: n.note, s: n.ts - g[0].ts })) }));
  }
  function minInterval(o) { let m = Infinity; for (let i = 1; i < o.notes.length; i++) m = Math.min(m, o.notes[i].s - o.notes[i - 1].s); return m; }
  function interleave(o) {
    return [0, 1].map((par) => {
      const ns = o.notes.filter((_, i) => i % 2 === par), s0 = ns[0].s;
      return { voice: o.voice, ts0: o.ts0 + s0, notes: ns.map((n) => ({ note: n.note, s: n.s - s0 })) };
    });
  }
  // first-fit: each note goes to the first marble whose previous note is at least minSteps earlier (for an even
  // run this is odd / even; for mixed rhythms it keeps every marble's gaps short)
  function firstFit(o, minSteps) {
    const lanes = [];
    for (const n of o.notes) {
      let L = lanes.find((l) => n.s - l[l.length - 1].s >= minSteps);
      if (!L) lanes.push((L = []));
      L.push(n);
    }
    return lanes.map((ns) => ({ voice: o.voice, ts0: o.ts0 + ns[0].s, notes: ns.map((n) => ({ note: n.note, s: n.s - ns[0].s })) }));
  }
  function densify(occs, minSteps) {
    const out = [];
    for (const o of occs) {
      if (o.notes.length >= 3 && minInterval(o) < minSteps) out.push(...firstFit(o, minSteps));
      else out.push(o);
    }
    return out;
  }
  // Vertical room a lane needs: first drop + the room the height plan gives each interval + the exit
  function spacing(dt, opts) { return Math.max(opts.minSpacing, Math.min(200, 20 + 220 * dt * dt)); }
  function estHeight(u, h, opts) {
    let y = 90 + 120;
    for (let i = 1; i < u.notes.length; i++) y += spacing((u.notes[i].s - u.notes[i - 1].s) * h, opts);
    return y;
  }
  // Lowest board y a lane is expected to reach (its bucket), when it starts from the top row
  const estBottom = (u, h, opts) => estHeight(u, h, opts) + opts.dropY - 45 + 70;
  const bucketOk = (u, h, opts) => { for (let q = 1; q < u.occ.length; q++) if ((u.occ[q] - u.occ[q - 1]) * h <= opts.bucketGap) return false; return true; };
  const estWidth = (u) => (u.notes.length === 1 ? 110 : 140 + 1.5 * u.notes.length);
  // Can this unit sit above the bass rack? (short enough, and it can end in a bucket)
  const fitsAbove = (u, ctx) => ctx.racks.length > 0 && estBottom(u, ctx.h, ctx.opts) <= ctx.shortYMax - 30 && bucketOk(u, ctx.h, ctx.opts);

  // Plans: every combination of per-voice phrase lengths, ranked by estimated board width (one tier, or two-tier
  // columns if one row would not fit), number of marbles and fragility; melodic voices prefer real cascades.
  function planUnits(song, notes, ctx) {
    const opts = ctx.opts, h = ctx.h;
    const bpb = song.beatsPerBar || 4;
    const byVoice = new Map();
    for (const n of notes) { if (n.bass) continue; if (!byVoice.has(n.voice)) byVoice.set(n.voice, []); byVoice.get(n.voice).push(n); }
    const voices = [...byVoice.keys()];
    if (!voices.length) return [{ cost: 0, units: [], tiers: 1, drip: false }];
    const minSteps = Math.round(opts.fastDt / h);
    const options = voices.map((voice) => opts.barOptions.map((N) => ({ N, drip: N === 0, occs: densify(segmentVoice(voice, byVoice.get(voice), bpb, N, opts), minSteps) })));
    const room = BOARD.w - 40, rackW = ctx.racks.reduce((a, r) => a + r.width + opts.rackGap, 0);
    const plans = [];
    // voices that sing the same phrase (a round, a canon) may share lanes or get their own; both are ranked
    const shares = voices.length > 1 && opts.shareChoice ? [opts.shareVoices, !opts.shareVoices] : [opts.shareVoices];
    let share = shares[0];
    const pick = (v, acc) => {
      if (v === voices.length) {
        const units = mergeUnits(acc.flatMap((o) => o.occs), null, share);
        let extra = 0;
        for (const u of units) extra += 1.5 * u.occ.length + 10 * Math.max(0, u.notes.length - 10);
        extra += opts.melodyDripCost * acc.filter((o) => o.drip).length;
        // regularity: a lane with the rhythm of another is built as an identical module (the rhythm cache)
        const seenR = new Set();
        for (const u of units) { const rk = rhythmKey(u); if (seenR.has(rk) && u.notes.length > 1) extra -= opts.moduleBonus; seenR.add(rk); }
        let width = 0, tallW = 0;
        for (const u of units) { const w = estWidth(u); width += w; if (!fitsAbove(u, ctx)) tallW += w; }
        // a machine that fills the board reads best: aim the total lane width at opts.fill of the board
        const over = (w, t) => Math.max(0, w - room) + Math.max(0, t - (room - rackW));
        const fillCost = (w) => Math.abs(w - opts.fill * room);
        let cost = fillCost(width) + extra + 4 * over(width, tallW), tiers = 1;
        if (over(width, tallW) > 0 && opts.tiers > 1) {
          const cols = buildColumns(laneOrder(units, ctx), ctx);
          let w2 = 0, t2 = 0;
          for (const c of cols) { w2 += c.width; if (c.lower || !fitsAbove(c.tall || c.upper, ctx)) t2 += c.width; }
          const c2 = fillCost(w2) + extra + opts.tier2Cost + 4 * over(w2, t2);
          if (c2 < cost) { cost = c2; tiers = 2; }
        }
        plans.push({ cost, units, tiers, drip: acc.some((o) => o.drip), share });
        return;
      }
      for (const o of options[v]) {
        // voices with their own lanes use one segmentation, so every voice gets the same set of modules
        if (!share && v > 0 && o.N !== acc[0].N) continue;
        acc.push(o); pick(v + 1, acc); acc.pop();
      }
    };
    for (share of shares) pick(0, []);
    plans.sort((a, b) => (a.drip - b.drip) || (a.cost - b.cost));
    // shared and unshared voice lanes take turns in the ranking, so both are really tried (the estimates are rough)
    if (shares.length > 1) {
      const A = plans.filter((p) => p.share === shares[0]), B = plans.filter((p) => p.share === shares[1]);
      plans.length = 0;
      for (let i = 0; i < Math.max(A.length, B.length); i++) { if (A[i]) plans.push(A[i]); if (B[i]) plans.push(B[i]); }
      plans.sort((a, b) => a.drip - b.drip);
    }
    const out = [], seen = new Set();
    for (const p of plans) {
      const sig = p.share + ':' + p.units.map((u) => u.key + '/' + u.occ.join(',')).sort().join('|');
      if (seen.has(sig)) continue;
      seen.add(sig);
      out.push(p);
    }
    return out;
  }
  // Two-tier columns: consecutive short lanes are paired. The upper lane starts on the top row and ends in its
  // pail; the lower lane has its own dropper hanging at `mid`, below that pail, and falls out of the bottom.
  // Room: top row + first drop (~180) + upper notes + pail and drawing (~TUBE_ROOM + 45) + lower first drop and
  // notes + exit must fit in the board's 1000 units.
  function drop(u, h, opts) { let y = 0; for (let i = 1; i < u.notes.length; i++) y += spacing((u.notes[i].s - u.notes[i - 1].s) * h, opts); return y; }
  function buildColumns(order, ctx) {
    const { h, opts } = ctx;
    const D = order.map((u) => drop(u, h, opts));
    const room = BOARD.h - (opts.dropY + 80) - (TUBE_ROOM + 45) - 90 - 40;
    const cols = [], used = new Set();
    for (let i = 0; i < order.length; i++) {
      if (used.has(i)) continue;
      used.add(i);
      const u = order[i];
      // partner: the fullest fit among the next few lanes (keeps the song order roughly left to right)
      let j = -1;
      if (D[i] <= room - 90) for (let k = i + 1; k < order.length && k <= i + 8; k++) {
        if (!used.has(k) && D[i] + D[k] <= room && (bucketOk(u, h, opts) || bucketOk(order[k], h, opts)) && (j < 0 || D[k] > D[j] + 20)) j = k;
      }
      if (j < 0) { cols.push({ tall: u, width: estWidth(u) }); continue; }
      used.add(j);
      const [up, lo, du, dl] = bucketOk(u, h, opts) ? [u, order[j], D[i], D[j]] : [order[j], u, D[j], D[i]];
      const mid = Math.round((opts.dropY + 80 + du + TUBE_ROOM + 45 + (room - du - dl) / 2) / 10) * 10;
      cols.push({ upper: up, lower: lo, mid, width: Math.max(estWidth(up), estWidth(lo)) });
    }
    return cols;
  }
  // Split a unit that could not be solved into two parts (odd / even notes for fast passages, else halves)
  function splitUnit(u, opts) {
    const n = u.notes.length;
    if (n < 2) return null;
    if (n >= 3 && minInterval(u) * opts.h < opts.splitInterleaveDt) {
      const occs = [];
      for (const t of u.occ) occs.push(...interleave({ voice: u.voice, ts0: t, notes: u.notes }));
      return occs;
    }
    let best = 1, bestScore = -Infinity;
    for (let i = 1; i < n; i++) {
      const gap = u.notes[i].s - u.notes[i - 1].s, balance = Math.min(i, n - i) / n;
      const sc = gap * (0.5 + balance);
      if (sc > bestScore) { bestScore = sc; best = i; }
    }
    const a = u.notes.slice(0, best), b0 = u.notes[best].s, b = u.notes.slice(best).map((x) => ({ note: x.note, s: x.s - b0 }));
    const occs = [];
    for (const t of u.occ) { occs.push({ voice: u.voice, ts0: t, notes: a }); occs.push({ voice: u.voice, ts0: t + b0, notes: b }); }
    return occs;
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
  function shiftCols(cols, dx) {
    return cols.map((c) => (c.shape === 'seg' ? Object.assign({}, c, { ax: c.ax + dx, bx: c.bx + dx }) : Object.assign({}, c, { x: c.x + dx })));
  }

  // Everything already placed: pieces (for clearance) and marble paths (for clearance and timing), on a grid
  function Occupancy() { this.C = 40; this.pg = new Map(); this.sg = new Map(); this.lanes = []; this.stamp = 0; }
  Occupancy.prototype.cells = function (x0, y0, x1, y1, fn) {
    const C = this.C;
    for (let i = Math.floor(x0 / C); i <= Math.floor(x1 / C); i++) for (let j = Math.floor(y0 / C); j <= Math.floor(y1 / C); j++) fn((i + 100) * 1000 + j + 100);
  };
  Occupancy.prototype.addPiece = function (cols) {
    const item = { cols, bb: bbox(cols), mark: 0 };
    this.cells(item.bb.x0, item.bb.y0, item.bb.x1, item.bb.y1, (k) => { let a = this.pg.get(k); if (!a) this.pg.set(k, (a = [])); a.push(item); });
  };
  Occupancy.prototype.marbleGap = function (x, y, R, within) {
    let g = Infinity;
    const s = ++this.stamp, r = R + within + 6;
    this.cells(x - r, y - r, x + r, y + r, (k) => {
      const a = this.pg.get(k);
      if (a) for (const it of a) {
        if (it.mark === s) continue;
        it.mark = s;
        if (x < it.bb.x0 - r || x > it.bb.x1 + r || y < it.bb.y0 - r || y > it.bb.y1 + r) continue;
        const d = marbleGap(it.cols, x, y, R);
        if (d < g) g = d;
      }
    });
    return g;
  };
  Occupancy.prototype.pieceGap = function (cols, within) {
    const bb = bbox(cols), s = ++this.stamp;
    let g = Infinity;
    this.cells(bb.x0 - within, bb.y0 - within, bb.x1 + within, bb.y1 + within, (k) => {
      const a = this.pg.get(k);
      if (a) for (const it of a) {
        if (it.mark === s) continue;
        it.mark = s;
        if (it.bb.x0 > bb.x1 + within || it.bb.x1 < bb.x0 - within || it.bb.y0 > bb.y1 + within || it.bb.y1 < bb.y0 - within) continue;
        g = Math.min(g, pieceGapBetween(cols, it.cols));
      }
    });
    return g;
  };
  Occupancy.prototype.addPath = function (path, rels) {
    const lane = this.lanes.length;
    this.lanes.push({ path, rels });
    for (let k = 0; k < path.length; k++) {
      const [x, y] = path[k];
      if (y > BOARD.h + 40) break;
      const key = (Math.floor(x / this.C) + 100) * 1000 + Math.floor(y / this.C) + 100;
      let a = this.sg.get(key);
      if (!a) this.sg.set(key, (a = []));
      a.push({ x, y, lane, k });
    }
  };
  // Does a piece come closer than `clear` to any placed marble path?
  Occupancy.prototype.pieceHitsPaths = function (cols, R, clear) {
    const bb = bbox(cols), r = R + clear + 4;
    let hit = false;
    this.cells(bb.x0 - r, bb.y0 - r, bb.x1 + r, bb.y1 + r, (k) => {
      if (hit) return;
      const a = this.sg.get(k);
      if (a) for (const p of a) {
        if (p.x < bb.x0 - r || p.x > bb.x1 + r || p.y < bb.y0 - r || p.y > bb.y1 + r) continue;
        if (marbleGap(cols, p.x, p.y, R) < clear) { hit = true; return; }
      }
    });
    return hit;
  };
  // Would a marble of a lane with releases `rels`, at lane step k and (x, y), be closer than `dist` to an already
  // placed marble at the same moment? (exact: the other marble's position at that very step is looked up)
  Occupancy.prototype.meets = function (x, y, k, rels, dist) {
    const r = dist + 12, lanes = new Set();
    this.cells(x - r, y - r, x + r, y + r, (key) => {
      const a = this.sg.get(key);
      if (a) for (const p of a) if (Math.abs(p.x - x) <= r && Math.abs(p.y - y) <= r) lanes.add(p.lane);
    });
    for (const L of lanes) {
      const o = this.lanes[L];
      for (const r1 of rels) for (const r2 of o.rels) {
        const k2 = r1 + k - r2;
        if (k2 < 0 || k2 >= o.path.length) continue;
        const q = o.path[k2];
        if (Math.abs(q[0] - x) < dist && Math.abs(q[1] - y) < dist && Math.hypot(q[0] - x, q[1] - y) < dist) return true;
      }
    }
    return false;
  };

  // This lane's own path so far, on a grid; DFS levels are pushed and popped as the search backtracks
  function PathGrid() { this.C = 32; this.g = new Map(); }
  PathGrid.prototype.key = function (x, y) { return (Math.floor(x / this.C) + 100) * 1000 + Math.floor(y / this.C) + 100; };
  PathGrid.prototype.add = function (pts, k0, level) {
    for (let q = 0; q < pts.length; q++) {
      const key = this.key(pts[q][0], pts[q][1]);
      let a = this.g.get(key);
      if (!a) this.g.set(key, (a = []));
      a.push({ x: pts[q][0], y: pts[q][1], k: k0 + q, level });
    }
  };
  PathGrid.prototype.remove = function (pts, level) {
    for (let q = 0; q < pts.length; q++) {
      const a = this.g.get(this.key(pts[q][0], pts[q][1]));
      while (a && a.length && a[a.length - 1].level === level) a.pop();
    }
  };
  PathGrid.prototype.hits = function (cols, R, clear, kMax) {
    const bb = bbox(cols), r = R + clear + 2, C = this.C;
    for (let i = Math.floor((bb.x0 - r) / C); i <= Math.floor((bb.x1 + r) / C); i++) {
      for (let j = Math.floor((bb.y0 - r) / C); j <= Math.floor((bb.y1 + r) / C); j++) {
        const a = this.g.get((i + 100) * 1000 + j + 100);
        if (a) for (const p of a) if (p.k <= kMax && marbleGap(cols, p.x, p.y, R) < clear) return true;
      }
    }
    return false;
  };

  // Deterministic PRNG for the robustness checks
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Pitch -> bar length (lower notes get longer bars, like a glockenspiel)
  function barLen(CANON, note) {
    const m = CANON.noteToMidi(note) || 72;
    return Math.max(44, Math.min(84, Math.round(112 - (m - 36) * 1.1)));
  }
  function cloneMarble(m) { return Object.assign({}, m, { contactT: new Map(m.contactT), noteT: new Map(m.noteT) }); }
  // One CANON step, counted against the deterministic work budget
  function stepW(ctx, w) { ctx.work++; ctx.CANON.step(w); }
  const outOfWork = (ctx) => ctx.work > ctx.workMax;

  // Robustness gate: jitter a lane's pieces (up to jitterPos units, jitterRot degrees; seeded) and require the
  // same notes within robustTol seconds, no extra note and the same exit, in every trial
  function robustLane(pcs, dropperId, J, notes, exitKind, ctx) {
    const { CANON, opts, h } = ctx;
    const last = J.length - 1, want = J.map((j) => j * h);
    for (let trial = 0; trial < opts.jitterTrials; trial++) {
      const rnd = mulberry32(1000 + trial * 7919);
      const jp = opts.jitterPos, ja = opts.jitterRot;
      const jit = pcs.map((p) => Object.assign({}, p, { x: p.x + (rnd() * 2 - 1) * jp, y: p.y + (rnd() * 2 - 1) * jp, rot: (p.rot || 0) + (rnd() * 2 - 1) * ja }));
      const wj = CANON.createWorld({ board: BOARD, pieces: jit });
      CANON.dropFrom(wj, dropperId);
      const n1 = J[last] + 30;
      for (let k = 0; k < n1 && wj.marbles.length; k++) stepW(ctx, wj);
      if (wj.notes.length !== notes.length) return false;
      for (let q = 0; q < notes.length; q++) if (wj.notes[q].note !== notes[q].note || Math.abs(wj.notes[q].t - want[q]) > opts.robustTol) return false;
      for (let k = 0; k < opts.exitMax / h && wj.marbles.length; k++) stepW(ctx, wj);
      if (wj.notes.length !== notes.length || wj.marbles.length) return false;
      const rm = wj.removed[0];
      if (!rm || rm.why !== exitKind) return false;
    }
    return true;
  }

  // ---------------------------------------------------------------------------------------------------------
  // One lane: a dropper, one tuned piece per note and an exit (a collector bucket, or a free fall off the bottom of
  // the board). band = { x0, F }: the lane prefers x0 .. x0 + F. The marble falls `fall` units from the dropper to
  // its first piece.
  function solveChain(unit, band, ctx) {
    const { CANON, opts, h, occ } = ctx;
    const R = CANON.MARBLE_R, H = BOARD.h;
    const notes = unit.notes, last = notes.length - 1;
    const F = band.F, xc = band.x0 + F / 2, hwid = F / 2;
    const xlo = Math.max(opts.edge, band.hard ? band.x0 : 0) + R, xhi = Math.min(BOARD.w - opts.edge, band.hard ? band.x0 + F : BOARD.w) - R;
    const pxlo = xlo - R, pxhi = xhi + R;
    // vertical limits: pieces stay below the lane's dropper row; marbles never climb back into it
    const yd = band.dropY || opts.dropY;
    const yMin = yd + 20, yMax = band.yMax || H - 12, pathYMax = band.yMax ? band.yMax + 10 : H + 100;
    const pathYMin = yd + 5 + R;
    const yBot = band.yBot || 880;
    const rots = [];
    for (let a = opts.rotStep; a <= opts.rotMax; a += opts.rotStep) rots.push(a, -a);
    const pid = (k) => unit.id + '_' + k;
    const D = opts.debug, why = (k) => { if (D) D[k] = (D[k] || 0) + 1; return null; };
    let gap = Infinity;
    for (let q = 1; q < unit.occ.length; q++) gap = Math.min(gap, unit.occ[q] - unit.occ[q - 1]);
    const allowBucket = opts.buckets && gap * h > opts.bucketGap;
    const meetDist = 2 * R + opts.pathSep;

    const dropXs = band.dropXs || [xc, xc - F * 0.2, xc + F * 0.2];
    const falls = band.falls || [110, 170, 60, 240];
    for (const fall of falls) for (const xd of dropXs) {
      if (outOfWork(ctx)) return null;
      if (xd < xlo + 10 || xd > xhi - 10) continue;
      const res = attempt(xd, fall);
      if (res) return res;
    }
    return null;

    function xPenalty(x) {
      let s = Math.pow((x - xc) / hwid, 2) * 1.5;
      if (x > band.x0 + F) s += Math.pow((x - band.x0 - F) / 40, 2);
      if (x < band.x0) s += Math.pow((band.x0 - x) / 60, 2);
      return s;
    }
    function sampleOk(x, y, k, rels) {
      if (occ.marbleGap(x, y, R, opts.clearance) < opts.clearance) return 'occ-piece';
      if (occ.meets(x, y, k, rels, meetDist)) return 'occ-marble';
      return null;
    }

    function attempt(xd, fall) {
      const dropper = { id: pid('d'), type: 'dropper', x: xd, y: yd, rot: 0 };
      const tube = tubeCols(xd, yd);
      if (occ.pieceGap(tube, opts.pieceGap + 4) < opts.pieceGap || occ.pieceHitsPaths(tube, R, opts.clearance + 1)) return why('tube');
      // free fall from the dropper
      const w = CANON.createWorld({ board: BOARD, pieces: [] });
      const m = CANON.spawn(w, xd, yd, dropper.id);
      const path = [[m.x, m.y]];
      let snap = null, j1 = -1;
      for (let k = 1; k < 2000; k++) {
        const before = cloneMarble(m), tBefore = w.time;
        stepW(ctx, w);
        if (!w.marbles.length) return null;
        path.push([m.x, m.y]);
        if (m.y >= yd + fall) { j1 = k; snap = { m: before, time: tBefore }; break; }
      }
      if (j1 < 0 || w.notes.length) return null;
      if (j1 > ctx.lead + unit.occ[0]) return why('fall-too-long');
      const rels = unit.occ.map((ts0) => ctx.lead + ts0 - j1);
      for (let k = 0; k < j1; k++) { const bad = sampleOk(path[k][0], path[k][1], k, rels); if (bad) return why('fall-' + bad); }
      const J = notes.map((n) => j1 + n.s);
      const J1y = path[j1][1];
      const spaceW = [0];
      for (let q = 1; q < notes.length; q++) spaceW.push(spaceW[q - 1] + spacing((notes[q].s - notes[q - 1].s) * h, opts));
      const own = [];
      const state = { i: 0, snap, Pprev: path[j1 - 1], Pcur: path[j1], path: path.slice(0, j1) };
      const ownGrid = new PathGrid();
      ownGrid.add(state.path, 0, 0);
      let nodes = 0;
      const chosen = [];
      if (!dfs(state)) return null;
      const all = chosen.map((c) => c.piece);
      if (chosen.bucket) all.push(chosen.bucket);
      let maxX = -Infinity, minX = Infinity, maxY = -Infinity;
      for (const p of all) { const bb = bbox(CANON.colliders(p)); maxX = Math.max(maxX, bb.x1); minX = Math.min(minX, bb.x0); maxY = Math.max(maxY, bb.y1); }
      for (const q of chosen.fullPath) if (q[1] < H + 60) { maxX = Math.max(maxX, q[0] + R); minX = Math.min(minX, q[0] - R); if (!chosen.bucket) maxY = H + 60; }
      return { unit, dropper, pieces: chosen.map((c) => c.piece), bucket: chosen.bucket || null, j1, J, rels,
        path: chosen.fullPath, band, minX, maxX, maxY, nodes };

      function dfs(st) {
        if (++nodes > opts.nodeBudget || outOfWork(ctx)) return false;
        const i = st.i, isLast = i === last;
        if (D) { D['depth' + i] = (D['depth' + i] || 0) + 1; if (!D.deep || D.deep.i < i) D.deep = { i, pieces: chosen.map((c) => c.piece), path: st.path.slice(), band }; }
        const cands = candidates(st);
        let tried = 0;
        const feasible = [];
        for (const c of cands) {
          if (tried >= opts.topK) break;
          tried++;
          const r = isLast ? simulateLast(st, c) : simulate(st, c);
          if (r) feasible.push(r);
        }
        feasible.sort((a, b) => a.score - b.score);
        let expanded = 0;
        for (const r of feasible) {
          if (expanded++ >= opts.branch) break;
          chosen.push({ piece: r.piece });
          own.push({ piece: r.piece, cols: r.cols });
          if (isLast) {
            chosen.fullPath = st.path.concat(r.seg);
            chosen.bucket = r.bucket || null;
            if (selfClear(chosen.fullPath) && robust()) return true;
          } else {
            ownGrid.add(r.seg, J[i], i + 1);
            if (dfs({ i: i + 1, snap: r.snap, Pprev: r.Pprev, Pcur: r.Pcur, path: st.path.concat(r.seg) })) return true;
            ownGrid.remove(r.seg, i + 1);
          }
          chosen.pop(); own.pop();
          if (nodes > opts.nodeBudget || outOfWork(ctx)) return false;
        }
        return false;
      }

      // Candidate pieces for note i, ranked by an analytic preview of the bounce (exact simulation follows)
      function candidates(st) {
        const i = st.i, isLast = i === last, note = notes[i].note;
        const vx = (st.Pcur[0] - st.Pprev[0]) / h, vy = (st.Pcur[1] - st.Pprev[1]) / h, sp = Math.hypot(vx, vy);
        const whyC = (k) => why(isLast ? 'L-' + k : k);
        const mx = (st.Pprev[0] + st.Pcur[0]) / 2, my = (st.Pprev[1] + st.Pcur[1]) / 2;
        const dtNext = isLast ? 0 : (J[i + 1] - J[i]) * h;
        const types = isLast ? ['bar'] : dtNext > 0.62 ? ['spring', 'bar'] : ['bar', 'spring'];
        const out = [];
        for (const type of types) {
          const mat = CANON.PIECES[type].mat, hw = CANON.HW[type];
          const L0 = type === 'spring' ? 56 : Math.max(opts.minBarLen || 0, barLen(CANON, note));
          const lens = (L0 > 48 ? [L0, 40] : [L0, 34]).filter((l, q) => !q || l >= (opts.minBarLen || 0));   // (opts.minBarLen: no shorter bars)
          for (const rot of rots) {
            const a = rot * RAD, nx = -Math.sin(a), ny = Math.cos(a);   // normal pointing into the piece
            const vn = vx * nx + vy * ny;
            if (vn < opts.vnMin || vn / sp < opts.incMin) { whyC('pv-vn'); continue; }
            const cx = mx + nx * (R + hw), cy = my + ny * (R + hw);
            const e = vn > CANON.BOUNCE_MIN ? mat.e : 0, kick = vn > CANON.BOUNCE_MIN ? mat.kick : 0;
            let ox = vx - (1 + e) * vn * nx - kick * nx, oy = vy - (1 + e) * vn * ny - kick * ny;
            const tx = -ny, ty = nx, vt = ox * tx + oy * ty, maxF = mat.mu * (1 + e) * vn;
            const dvt = Math.abs(vt) <= maxF ? vt : Math.sign(vt) * maxF;
            ox -= dvt * tx; oy -= dvt * ty;
            let score = Math.abs(rot) > opts.rotSoft ? Math.pow((Math.abs(rot) - opts.rotSoft) / 15, 2) : 0;
            if (!isLast) {
              const px = mx + ox * dtNext, py = my + oy * dtNext + 0.5 * CANON.GRAVITY * dtNext * dtNext;
              if (px < xlo - 20 || px > xhi + 20) { whyC('pv-x'); continue; }
              if (py > Math.min(H - 70, yMax - 20) || py < pathYMin + 10) { whyC('pv-y'); continue; }
              score += previewScore(i + 1, px, py, ox, oy + CANON.GRAVITY * dtNext, my, mx);
            } else {
              score += Math.abs(ox) / 150 + (oy < 0 ? -oy / 400 : 0) + xPenalty(mx) * 0.3;
            }
            const ux = Math.cos(a), uy = Math.sin(a);
            for (const len of lens) {
              const f = Math.max(0, len / 2 - 14);
              for (const off of f > 4 && band.offsets && i === 0 ? [0, f, -f] : [0]) {
                const piece = { id: pid('p' + i), type, x: cx + ux * off, y: cy + uy * off, rot, len, note };
                out.push({ piece, score: score + (len !== lens[0] ? 0.4 : 0) + (off ? 0.35 : 0) });
              }
            }
          }
        }
        // rails: the marble lands (the note) near the uphill end, rolls down and drops off the far end; rolling
        // spends time without height, so rails suit long gaps
        if (opts.rails && !isLast && dtNext >= opts.railMinDt) {
          const hw = CANON.HW.rail;
          for (const slope of opts.railSlopes) for (const dir of [1, -1]) {
            const rot = dir * slope, a = rot * RAD, nx = -Math.sin(a), ny = Math.cos(a);
            const vn = vx * nx + vy * ny;
            if (vn < opts.vnMin || vn / sp < opts.incMin) continue;
            const ddx = dir * Math.cos(a), ddy = dir * Math.sin(a);
            const cx0 = mx + nx * (R + hw), cy0 = my + ny * (R + hw);
            const vt0 = Math.max(0, vx * ddx + vy * ddy) * 0.97, acc = CANON.GRAVITY * Math.sin(slope * RAD) - 30;
            for (const L of opts.railLens) {
              const land = 18, dist = L - land;
              const disc = vt0 * vt0 + 2 * acc * dist;
              if (disc <= 0) continue;
              const tau = acc > 1e-6 ? (-vt0 + Math.sqrt(disc)) / acc : dist / Math.max(vt0, 1);
              let score = opts.railCost;
              const tf = dtNext - tau;
              if (tf < 0.06) continue;
              const v1 = vt0 + acc * tau;
              const ex = cx0 + ddx * dist - nx * (R + hw), ey = cy0 + ddy * dist - ny * (R + hw);
              const px = ex + v1 * ddx * tf, py = ey + v1 * ddy * tf + 0.5 * CANON.GRAVITY * tf * tf;
              if (px < xlo - 20 || px > xhi + 20) { whyC('pv-x'); continue; }
              if (py > Math.min(H - 70, yMax - 20) || py < pathYMin + 10) { whyC('pv-y'); continue; }
              score += previewScore(i + 1, px, py, v1 * ddx, v1 * ddy + CANON.GRAVITY * tf, my, mx) - (dtNext > 0.6 ? 0.5 : 0);
              const piece = { id: pid('p' + i), type: 'rail', x: cx0 + ddx * (L / 2 - land), y: cy0 + ddy * (L / 2 - land), rot, len: L, note };
              out.push({ piece, score });
            }
          }
        }
        out.sort((p, q) => p.score - q.score);
        // static checks, in rank order, until we have enough (rails keep a few of the exact-simulation slots)
        const res = [], rails = [];
        const railQuota = isLast ? 0 : dtNext > 0.6 ? 4 : 2;
        for (const c of out) {
          if (res.length >= opts.topK * 2 && rails.length >= railQuota) break;
          if (c.piece.type === 'rail' ? rails.length >= railQuota : res.length >= opts.topK * 2) continue;
          const cols = CANON.colliders(c.piece), bb = bbox(cols);
          if (bb.x0 < pxlo || bb.x1 > pxhi) { whyC('c-bounds-x'); continue; }
          if (bb.y0 < yMin || bb.y1 > yMax) { whyC('c-bounds-y'); continue; }
          if (!clearOfOwn(cols, st.path, true)) { whyC('c-own'); continue; }
          if (occ.pieceGap(cols, opts.pieceGap + 2) < opts.pieceGap) { whyC('c-occ-piece'); continue; }
          if (occ.pieceHitsPaths(cols, R, opts.clearance + 1)) { whyC('c-occ-path'); continue; }
          c.cols = cols;
          (c.piece.type === 'rail' ? rails : res).push(c);
        }
        if (!rails.length) return res;
        const keep = Math.max(0, opts.topK - rails.length);
        return res.slice(0, keep).concat(rails, res.slice(keep));
      }

      function clearOfOwn(cols, P, approach) {
        for (const o of own) if (pieceGapBetween(cols, o.cols) < opts.pieceGap) return false;
        let k = P.length - 1;
        if (approach) while (k >= 0 && marbleGap(cols, P[k][0], P[k][1], R) < opts.clearance) k--;
        return !ownGrid.hits(cols, R, opts.clearance, k);
      }

      // where the next hit should be: the opposite side of the lane (a zigzag keeps lanes narrow and uncrossed)
      function zigzag(px, xNow) {
        const d = F * 0.22, sc = F * 0.3;
        let s;
        if (xNow === undefined || Math.abs(xNow - xc) < F * 0.08) s = Math.pow((Math.abs(px - xc) - d) / sc, 2);
        else s = Math.pow((px - (xc - Math.sign(xNow - xc) * d)) / sc, 2);
        if (px > band.x0 + F) s += Math.pow((px - band.x0 - F) / 40, 2);
        if (px < band.x0) s += Math.pow((band.x0 - px) / 40, 2);
        return 1.5 * s;
      }
      function previewScore(iNext, px, py, vx2, vy2, yNow, xNow) {
        let s = zigzag(px, xNow);
        const spd = Math.hypot(vx2, vy2);
        if (spd > opts.vHi) s += Math.pow((spd - opts.vHi) / 150, 2);
        if (spd < opts.vLo) s += Math.pow((opts.vLo - spd) / 120, 2);
        // height plan: each interval gets its natural room, stretched (up to stretchMax) so the lane fills its band
        const y1 = J1y, yEnd = Math.min(yBot, y1 + spaceW[last] * opts.stretchMax);
        const yPlan = y1 + ((yEnd - y1) * spaceW[iNext]) / Math.max(1, spaceW[last]);
        s += Math.pow((py - yPlan) / 110, 2);
        if (yNow !== undefined && py < yNow - 15) s += Math.pow((yNow - 15 - py) / 70, 2);
        return s;
      }

      // Exact CANON run of a candidate from just before its contact; visit(k, marble, world, pre) before and
      // after each step (k = 1 is the contact step). Returns 'done' | 'removed:<why>' | a failure reason.
      function run(st, pieces, nSteps, visit) {
        const w2 = CANON.createWorld({ board: BOARD, pieces });
        w2.time = st.snap.time;
        const mm = cloneMarble(st.snap.m);
        w2.marbles.push(mm);
        for (let k = 1; k <= nSteps; k++) {
          const res = visit(k, mm, w2, true);
          if (res) return res;
          stepW(ctx, w2);
          if (!w2.marbles.length) return 'removed:' + w2.removed[w2.removed.length - 1].why;
          if (k === 1) { if (w2.notes.length !== 1 || w2.notes[0].pieceId !== pieces[0].id) return 'no-note'; }
          else if (w2.notes.length !== 1) return 'extra-note';
          const r2 = visit(k, mm, w2, false);
          if (r2) return r2;
        }
        return 'done';
      }

      function simulate(st, c) {
        const i = st.i, piece = c.piece, cols = c.cols;
        const seg = [];
        const nSteps = J[i + 1] - J[i] + 1;
        let departed = false, snap = null;
        const res = run(st, [piece], nSteps, (k, mm, w2, pre) => {
          if (pre) { if (k === nSteps) snap = { m: cloneMarble(mm), time: w2.time }; return null; }
          const x = mm.x, y = mm.y;
          seg.push([x, y]);
          if (x < xlo || x > xhi || y < pathYMin || y > pathYMax) return 'bounds';
          if (k > 1) {
            const g = marbleGap(cols, x, y, R);
            if (!departed) { if (g >= opts.clearance) departed = true; else if (k > (piece.type === 'rail' ? nSteps : 60)) return 'no-depart'; }
            else if (g < opts.clearance) return 'return-to-piece';
            for (let q = 0; q < own.length; q++) if (marbleGap(own[q].cols, x, y, R) < opts.clearance) return 'own-piece';
          }
          return k < nSteps ? sampleOk(x, y, J[i] - 1 + k, rels) : null;
        });
        if (res !== 'done') return why(res);
        const Pprev = seg[nSteps - 2], Pcur = seg[nSteps - 1];
        const vx = (Pcur[0] - Pprev[0]) / h, vy = (Pcur[1] - Pprev[1]) / h;
        if (Pcur[1] > Math.min(H - 70, yMax - 20)) return why('too-low');
        if (Math.hypot(vx, vy) < opts.vnMin * 1.1) return why('too-slow');
        why('ok');
        const rotPen = Math.abs(piece.rot) > opts.rotSoft ? Math.pow((Math.abs(piece.rot) - opts.rotSoft) / 15, 2) : 0;
        return { piece, cols, seg: seg.slice(0, nSteps - 1), snap, Pprev, Pcur,
          score: rotPen + previewScore(i + 1, Pcur[0], Pcur[1], vx, vy, seg[0][1], seg[0][0]) + (piece.len < barLen(CANON, piece.note) ? 0.4 : 0) };
      }

      // Last note: the marble must leave cleanly, either falling off the bottom or into a bucket
      function simulateLast(st, c) {
        const piece = c.piece, cols = c.cols, i = st.i;
        const seg = [];
        const nSteps = Math.round(opts.exitMax / h);
        let departed = false, bad = -1;
        const res = run(st, [piece], nSteps, (k, mm, w2, pre) => {
          if (pre) return null;
          const x = mm.x, y = mm.y;
          seg.push([x, y]);
          if (bad >= 0) return y > H + 60 ? 'gone' : null;
          let fail = x < xlo || x > xhi || y < pathYMin || y > pathYMax;
          if (!fail && k > 1) {
            const g = marbleGap(cols, x, y, R);
            if (!departed) { if (g >= opts.clearance) departed = true; else if (k > (piece.type === 'rail' ? 400 : 60)) return 'no-depart'; }
            else if (g < opts.clearance) return 'return-to-piece';
            for (let q = 0; q < own.length && !fail; q++) if (marbleGap(own[q].cols, x, y, R) < opts.clearance) fail = true;
          }
          if (!fail && y < H + 30 && sampleOk(x, y, J[i] - 1 + k, rels)) fail = true;
          if (fail) bad = seg.length - 1;
          return null;
        });
        if (res === 'no-depart' || res === 'return-to-piece' || res === 'no-note' || res === 'extra-note') return why('last-' + res);
        const yC = seg[0][1];
        const out = [];
        if (bad < 0 && res === 'removed:fell' && !band.yMax) out.push({ piece, cols, seg, score: c.score + 0.8, bucket: null });
        if (allowBucket) {
          const lim = bad < 0 ? seg.length : bad;
          for (let yr = Math.max(yC + 45, 150); yr <= Math.min(H - 75, yMax - 60); yr += 20) {
            let q = 0;
            while (q < lim && seg[q][1] < yr) q++;
            if (q >= lim) break;
            const bucket = { id: pid('b'), type: 'bucket', x: seg[q][0], y: seg[q][1] + 35, rot: 0, w: 70 };
            const bcols = CANON.colliders(bucket), bb = bbox(bcols);
            if (bb.x0 < pxlo || bb.x1 > pxhi || bb.y1 > (band.yMax ? band.yMax + 25 : H - 4)) continue;
            if (pieceGapBetween(bcols, cols) < opts.pieceGap || !clearOfOwn(bcols, st.path, false)) continue;
            if (occ.pieceGap(bcols, opts.pieceGap + 2) < opts.pieceGap || occ.pieceHitsPaths(bcols, R, opts.clearance + 1)) continue;
            let ok = true;
            for (let k = 0; k < q && ok; k++) if (marbleGap(bcols, seg[k][0], seg[k][1], R) < opts.clearance) ok = false;
            if (!ok) continue;
            const seg2 = [];
            const r2 = run(st, [piece, bucket], nSteps, (k, mm, w2, pre) => {
              if (pre) return null;
              seg2.push([mm.x, mm.y]);
              return k > q ? sampleOk(mm.x, mm.y, J[i] - 1 + k, rels) : null;
            });
            if (r2 !== 'removed:bucket') continue;
            out.push({ piece, cols, seg: seg2, score: c.score + (yr - yC) / 400, bucket });
            break;
          }
        }
        if (!out.length) return why('last-noexit');
        out.sort((a, b) => a.score - b.score);
        why('ok-last');
        return out[0];
      }

      // Two marbles of this lane (a repeated phrase) must never meet each other either
      function selfClear(P) { return selfClearPath(P, rels, meetDist) || !!why('self-meet'); }

      function robust() {
        const pcs = [dropper, ...chosen.map((c) => c.piece)];
        if (chosen.bucket) pcs.push(chosen.bucket);
        return robustLane(pcs, dropper.id, J, notes, chosen.bucket ? 'bucket' : 'fell', ctx) || !!why('notRobust');
      }
    }
  }
  function selfClearPath(P, rels, meetDist) {
    for (let a = 0; a < rels.length; a++) for (let b = a + 1; b < rels.length; b++) {
      const d = Math.abs(rels[b] - rels[a]);
      if (d >= P.length) continue;
      for (let k = d; k < P.length; k++) {
        const p = P[k], q = P[k - d];
        if (Math.abs(p[0] - q[0]) < meetDist && Math.abs(p[1] - q[1]) < meetDist && Math.hypot(p[0] - q[0], p[1] - q[1]) < meetDist) return false;
      }
    }
    return true;
  }

  // ---------------------------------------------------------------------------------------------------------
  // Lanes are solved one at a time in a canonical frame (x from FRAME_X), cached, then packed into columns and
  // translated into place. Every translated lane is re-simulated to confirm it still plays exactly.
  const FRAME_X = 400;
  const TUBE_ROOM = 97 + 15 + 25;   // a pail (bottom <= yMax + 25) stays 15 above a dropper drawing (97 tall) below it
  function laneBand(role, W, mid, ctx) {
    if (role === 'tall') return { x0: FRAME_X, F: W, hard: true };
    if (role === 'short') return { x0: FRAME_X, F: W, hard: true, yMax: ctx.shortYMax, yBot: ctx.shortYMax - 100 };
    // two-tier columns: the upper lane ends in its pail above the lower lane's dropper, which hangs at `mid`
    if (role === 'upper') return { x0: FRAME_X, F: W, hard: true, yMax: mid - TUBE_ROOM, yBot: mid - TUBE_ROOM - 60 };
    return { x0: FRAME_X, F: W, hard: true, dropY: mid, yBot: 930, falls: [60, 110, 170] };
  }
  // Rhythm key: a lane's geometry depends only on its note steps (and the timing of its repeats), not its pitches
  const rhythmKey = (u) => u.notes.map((n) => n.s).join(',');
  function solveLane(u, role, ctx, above, mid) {
    const occRel = u.occ.map((t) => t - u.occ[0]).join(',');
    const key = role + (mid ? '@' + mid : '') + '|' + u.key + '|' + u.occ.join(',') + (above ? '|' + above.key : '');
    if (ctx.cache.has(key)) return ctx.cache.get(key);
    let res = null;
    // rhythm cache: a solved lane with the same rhythm and role is retuned to these pitches and re-verified
    if (ctx.opts.rhythmCache && !above) {
      const rk = role + (mid ? '@' + mid : '') + '|' + rhythmKey(u);
      for (const cand of ctx.rhythm.get(rk) || []) {
        res = retuneLane(cand, u, ctx);
        if (res) { ctx.stats.rhythmReuse++; break; }
      }
    }
    const one = u.notes.length === 1, widths = one ? ctx.opts.laneWidths1 : ctx.opts.laneWidths;
    const passes = one && role === 'tall' ? [[110, 170, 60, 240], [720, 660, 600]] : [null];
    for (const falls of passes) for (const W0 of widths) {
      if (res || outOfWork(ctx)) break;
      const W = above ? Math.max(W0, above.W) : W0;
      ctx.occ = new Occupancy();
      if (above) {
        const a = above.r;
        for (const p of [...a.pieces, ...(a.bucket ? [a.bucket] : [])]) ctx.occ.addPiece(ctx.CANON.colliders(p));
        ctx.occ.addPath(a.path, a.rels);
      }
      const band = laneBand(role, W, mid, ctx);
      if (falls) band.falls = falls;
      const r = solveChain(u, band, ctx);
      if (r) {
        res = { r, role, W, key, width: Math.ceil(r.maxX - FRAME_X) };
        if (ctx.opts.rhythmCache && !above) {
          const rk = role + (mid ? '@' + mid : '') + '|' + rhythmKey(u);
          if (!ctx.rhythm.has(rk)) ctx.rhythm.set(rk, []);
          ctx.rhythm.get(rk).push(res);
        }
      }
    }
    if (res) res.occRel = occRel;
    if (res || !outOfWork(ctx)) ctx.cache.set(key, res);
    return res;
  }
  // Reuse a solved lane (same rhythm, same role) for another phrase: new pitches, the same geometry. Bars first
  // try the glockenspiel length of their new pitch (re-verified exactly and under jitter); if that fails they keep
  // the cached lengths (then the physics is bit-identical, so the lane is exact by construction).
  function retuneLane(cand, u, ctx) {
    const { CANON, opts, h } = ctx, r0 = cand.r, R = CANON.MARBLE_R;
    const rels = u.occ.map((ts0) => ctx.lead + ts0 - r0.j1);
    if (rels.some((q) => q < 0)) return null;
    // repeats: the bucket needs its marbles far enough apart, and marbles of this lane must never meet
    if (r0.bucket) for (let q = 1; q < u.occ.length; q++) if ((u.occ[q] - u.occ[q - 1]) * h <= opts.bucketGap) return null;
    if (!selfClearPath(r0.path, rels, 2 * R + opts.pathSep)) return null;
    const id = u.id, rename = (p, k) => Object.assign({}, p, { id: id + '_' + k });
    const relabel = r0.pieces.map((p, i) => Object.assign(rename(p, 'p' + i), { note: u.notes[i].note }));
    const dropper = rename(r0.dropper, 'd');
    const bucket = r0.bucket ? rename(r0.bucket, 'b') : null;
    const base = { unit: u, dropper, bucket, j1: r0.j1, J: r0.J, rels, band: r0.band, minX: r0.minX, maxX: r0.maxX, maxY: r0.maxY, nodes: 0, reused: true };
    // glockenspiel lengths for the new pitches (bars whose cached length was the pitch length of the old note)
    let changed = false;
    const tuned = relabel.map((p, i) => {
      if (p.type !== 'bar' || r0.pieces[i].len !== barLen(CANON, r0.pieces[i].note)) return p;
      const L = barLen(CANON, p.note);
      if (L === p.len) return p;
      changed = true;
      return Object.assign({}, p, { len: L });
    });
    if (changed) {
      const chk = checkLane({ dropper, pieces: tuned, bucket, J: r0.J, notes: u.notes }, ctx);
      if (chk && robustLane([dropper, ...tuned, ...(bucket ? [bucket] : [])], dropper.id, r0.J, u.notes, bucket ? 'bucket' : 'fell', ctx)) {
        let minX = Infinity, maxX = -Infinity;
        for (const p of [...tuned, ...(bucket ? [bucket] : [])]) { const bb = bbox(CANON.colliders(p)); minX = Math.min(minX, bb.x0); maxX = Math.max(maxX, bb.x1); }
        for (const q of chk.path) if (q[1] < BOARD.h + 60) { minX = Math.min(minX, q[0] - R); maxX = Math.max(maxX, q[0] + R); }
        return { r: Object.assign(base, { pieces: tuned, path: chk.path, minX, maxX }), role: cand.role, W: cand.W, key: cand.key, width: Math.ceil(maxX - FRAME_X) };
      }
    }
    return { r: Object.assign(base, { pieces: relabel, path: r0.path }), role: cand.role, W: cand.W, key: cand.key, width: cand.width };
  }
  // A lane alone: notes exactly at steps J on the right pieces, no extra note, a clean exit, and its path clear of
  // every piece of the lane except around that piece's own strike. Returns { path } or null.
  function checkLane(L, ctx) {
    const { CANON, opts, h } = ctx, R = CANON.MARBLE_R;
    const pieces = [L.dropper, ...L.pieces, ...(L.bucket ? [L.bucket] : [])];
    const w = CANON.createWorld({ board: BOARD, pieces });
    const m = CANON.dropFrom(w, L.dropper.id);
    const path = [[m.x, m.y]];
    const last = L.J[L.J.length - 1], n = last + Math.round(opts.exitMax / h);
    for (let k = 0; k < n && w.marbles.length; k++) { stepW(ctx, w); if (w.marbles.length) path.push([m.x, m.y]); }
    if (w.marbles.length || w.notes.length !== L.J.length) return null;
    for (let q = 0; q < L.J.length; q++) {
      if (w.notes[q].pieceId !== L.pieces[q].id || w.notes[q].note !== L.notes[q].note || Math.abs(w.notes[q].t - L.J[q] * h) > 1e-9) return null;
    }
    if (!w.removed[0] || w.removed[0].why !== (L.bucket ? 'bucket' : 'fell')) return null;
    // clearances: every piece vs the path, outside that piece's own contact window
    for (let q = 0; q < L.pieces.length; q++) {
      const cols = CANON.colliders(L.pieces[q]);
      let a = L.J[q], b = L.J[q];
      while (a > 0 && marbleGap(cols, path[a - 1][0], path[a - 1][1], R) < opts.clearance) a--;
      while (b + 1 < path.length && marbleGap(cols, path[b + 1][0], path[b + 1][1], R) < opts.clearance) b++;
      for (let k = 1; k < path.length; k++) {
        if (k >= a && k <= b) continue;
        if (path[k][1] > BOARD.h + 30) break;
        if (marbleGap(cols, path[k][0], path[k][1], R) < opts.clearance - 1e-9) return null;
      }
    }
    return { path };
  }

  // Lane order: melody lanes in order of first appearance, then the other voices
  function laneOrder(units, ctx) {
    const vr = (u) => ctx.voiceRank.get(u.voice) || 0;
    const byVoice = ctx.share === false;
    return units.slice().sort((a, b) => (byVoice ? vr(a) - vr(b) : 0) || (a.occ[0] - b.occ[0]) || (a.key < b.key ? -1 : 1));
  }

  // Solve a plan's lanes and arrange them in columns; returns { cols, failed }
  function buildPlan(units, tiers, ctx) {
    const order = laneOrder(units, ctx);
    const groups = tiers === 2 ? buildColumns(order, ctx) : order.map((u) => ({ tall: u }));
    const cols = [], failed = [];
    const alone = (u) => {
      // a lane that can end above the bass rack is solved that way (it may then sit anywhere)
      const s = (fitsAbove(u, ctx) && solveLane(u, 'short', ctx)) || solveLane(u, 'tall', ctx);
      if (s) cols.push({ lanes: [s], width: s.width }); else failed.push(u);
    };
    let solvedW = 0, solvedEst = 0, restW = groups.reduce((a, g) => a + g.width, 0);
    for (const g of groups) {
      solvedW = cols.reduce((a, c) => a + c.width, 0);
      if (outOfWork(ctx)) { failed.push(...[g.tall, g.upper, g.lower].filter(Boolean)); continue; }
      // give up on a plan whose lanes will clearly need more width than the board has: the solved columns' real
      // widths plus the estimates of the rest, scaled by how far the estimates have been off so far (the next plan
      // reuses every lane solved here through the cache)
      const ratio = solvedEst > 0 ? Math.max(1, solvedW / solvedEst) : 1;
      if (solvedW + restW * ratio > ctx.opts.abortWidth) return { cols, failed: failed.concat(...[g.tall, g.upper, g.lower].filter(Boolean)), aborted: true };
      restW -= g.width; solvedEst += g.width;
      if (g.tall) { alone(g.tall); continue; }
      const su = solveLane(g.upper, 'upper', ctx, null, g.mid);
      const sl = g.lower && su ? solveLane(g.lower, 'lower', ctx, su, g.mid) : null;
      if (su && (sl || !g.lower)) { const lanes = [su, sl].filter(Boolean); cols.push({ lanes, width: Math.max(...lanes.map((l) => l.width)) }); continue; }
      if (su) cols.push({ lanes: [su], width: su.width }); else alone(g.upper);
      if (g.lower) alone(g.lower);
    }
    if (cols.reduce((a, c) => a + c.width, 0) > ctx.opts.abortWidth) return { cols, failed, aborted: true };
    return { cols, failed };
  }

  // Coordinates are rounded to 1e-4 here, before the lane is re-verified, so the emitted layout is the verified one
  const rd4 = (v) => Math.round(v * 1e4) / 1e4;
  function translateLane(s, dx) {
    const mv = (p) => Object.assign({}, p, { x: rd4(p.x + dx), y: rd4(p.y), rot: rd4(p.rot || 0) });
    const r = s.r;
    return { dropper: mv(r.dropper), pieces: r.pieces.map(mv), bucket: r.bucket ? mv(r.bucket) : null,
      path: r.path.map((q) => [q[0] + dx, q[1]]), r, role: s.role, dx };
  }
  function laneStillExact(t, ctx) {
    const { CANON, h, opts } = ctx, r = t.r;
    const pieces = [t.dropper, ...t.pieces, ...(t.bucket ? [t.bucket] : [])];
    const w = CANON.createWorld({ board: BOARD, pieces });
    CANON.dropFrom(w, t.dropper.id);
    const last = r.J[r.J.length - 1];
    for (let k = 0; k < last + Math.round(opts.exitMax / h) && w.marbles.length; k++) stepW(ctx, w);
    if (w.notes.length !== r.J.length || w.marbles.length) return false;
    for (let q = 0; q < r.J.length; q++) if (w.notes[q].note !== r.unit.notes[q].note || Math.abs(w.notes[q].t - r.J[q] * h) > 1e-9) return false;
    return w.removed[0] && w.removed[0].why === (t.bucket ? 'bucket' : 'fell');
  }
  function exactAt(s, x, ctx) {
    for (const nudge of [0, 0.37, -0.29, 0.61]) {
      const t = translateLane(s, Math.round((x + nudge) * 1000) / 1000);
      if (laneStillExact(t, ctx)) return t;
    }
    return null;
  }
  const lanePieces = (r) => [...r.pieces, ...(r.bucket ? [r.bucket] : [])];
  // Occupancy items of a lane in the canonical frame: its pieces plus its dropper drawing
  function laneItems(s, CANON) {
    const r = s.r;
    return lanePieces(r).map((p) => CANON.colliders(p)).concat([tubeCols(r.dropper.x, r.dropper.y)]);
  }

  // Place columns left to right: each slides left until it would touch what is already placed (the bass rack,
  // earlier columns: pieces, dropper drawings, marble paths, and marbles of other runs at the same moment); then
  // the spare width is shared out (re-checked). Returns { lanes } or null if they cannot fit.
  function placeColumns(cols, ctx) {
    const { opts, CANON } = ctx, R = CANON.MARBLE_R, edge = opts.edge, n = cols.length;
    const meetDist = 2 * R + opts.pathSep;
    const pre = cols.map((c) => c.lanes.map((s) => ({ s, pcs: laneItems(s, CANON) })));
    const baseOcc = () => { const o = new Occupancy(); for (const r of ctx.racks) r.addTo(o); return o; };
    const fits = (occ, k, dx) => {
      for (const L of pre[k]) {
        for (const pc of L.pcs) {
          const sc = shiftCols(pc, dx);
          if (occ.pieceGap(sc, opts.pieceGap + 2) < opts.pieceGap || occ.pieceHitsPaths(sc, R, opts.clearance + 1)) return false;
        }
        const P = L.s.r.path, rels = L.s.r.rels;
        for (let q = 0; q < P.length; q++) {
          const x = P[q][0] + dx, y = P[q][1];
          if (y > BOARD.h + 40) break;
          if (occ.marbleGap(x, y, R, opts.clearance) < opts.clearance || occ.meets(x, y, q, rels, meetDist)) return false;
        }
      }
      return true;
    };
    const add = (occ, k, dx) => {
      for (const L of pre[k]) {
        for (const pc of L.pcs) occ.addPiece(shiftCols(pc, dx));
        occ.addPath(L.s.r.path.map((q) => [q[0] + dx, q[1]]), L.s.r.rels);
      }
    };
    const span = (k) => ({ minRel: Math.min(...cols[k].lanes.map((s) => s.r.minX)) - FRAME_X, maxRel: Math.max(...cols[k].lanes.map((s) => s.r.maxX)) - FRAME_X });
    let occ = baseOcc();
    const xs = [];
    let prev = -Infinity;
    for (let k = 0; k < n; k++) {
      const { minRel, maxRel } = span(k);
      const lo = Math.max(edge - FRAME_X - minRel, prev + 30), hi = BOARD.w - edge - FRAME_X - maxRel;
      let got = null;
      for (let dx = lo; dx <= hi && got === null; dx += 3) if (fits(occ, k, dx)) got = dx;
      if (got === null) return null;
      xs.push(got);
      prev = got;
      add(occ, k, got);
    }
    // share out the slack: move column k right by step * (k + 0.5); check the whole arrangement, halve on failure
    const right = Math.max(...cols.map((c, k) => span(k).maxRel + xs[k] + FRAME_X));
    const slack = BOARD.w - edge - right;
    let step = Math.min(opts.maxLaneGap, slack / Math.max(1, n));
    let final = xs;
    while (step >= 2) {
      const centre = Math.max(0, (slack - step * n) / 2);
      const cand = xs.map((dx, k) => dx + step * (k + 0.5) + centre);
      const o2 = baseOcc();
      let ok = true;
      for (let k = 0; k < n && ok; k++) { if (!fits(o2, k, cand[k])) ok = false; else add(o2, k, cand[k]); }
      if (ok) { final = cand; break; }
      step /= 2;
    }
    const lanes = [];
    for (let k = 0; k < n; k++) for (const s of cols[k].lanes) {
      const t = exactAt(s, final[k], ctx);
      if (!t) return null;
      lanes.push(t);
    }
    return { lanes };
  }

  // ---------------------------------------------------------------------------------------------------------
  // BASS RACK (graft from solver C): one column per bass pitch. A dropper and, `drop` units below it, a tuned bar
  // tilted theta degrees; the strike is `b` units from the bar's lower end, so the marble glances off once and falls
  // out of the bottom of the board. Every column is a translate of one prototype.
  function rackBarGeom(theta, drop, sx, sy, len, b) {
    const u = [Math.cos(theta * RAD), Math.sin(theta * RAD)], n = [Math.sin(theta * RAD), -Math.cos(theta * RAD)];
    const R = 15, Cx = sx, Cy = sy + drop, Px = Cx - R * n[0], Py = Cy - R * n[1];
    const off = len / 2 - b;
    return { x: Px - off * u[0], y: Py - off * u[1], u, n };
  }
  const protoCache = new Map();
  function rackPrototype(C, theta, drop, laneGap) {
    const key = theta + '/' + drop + '/' + laneGap;
    if (protoCache.has(key)) return protoCache.get(key);
    const SX = 300, SY = 12, LEN = 60;
    const mk = (b) => {
      const g = rackBarGeom(theta, drop, SX, SY, LEN, b);
      return { v: 1, tempo: 100, board: BOARD, pieces: [
        { id: 'd', type: 'dropper', x: SX, y: SY, schedule: { mode: 'manual' } },
        { id: 'b', type: 'bar', x: g.x, y: g.y, rot: theta, len: LEN, note: 'C5' }] };
    };
    // largest contact offset b (from the lower end) for which the marble leaves the bar for good after one strike
    let bMax = 0;
    for (let b = 4; b <= 40; b += 2) {
      const w = C.createWorld(mk(b)), m = C.dropFrom(w, 'd'), c = w.colliders[0];
      let prev = -1, rising = true, hit = -1;
      for (let i = 0; i < 400 && w.marbles.length; i++) {
        C.step(w);
        if (w.notes.length && hit < 0) hit = i;
        if (hit >= 0 && i > hit) {
          const d = distPointSeg(m.x, m.y, c);
          if (d < prev - 1e-9) { rising = false; break; }
          prev = d;
          if (d > 60) break;
        }
      }
      if (w.notes.length === 1 && rising) bMax = b; else break;
    }
    const b = Math.max(6, Math.min(14, bMax - 8));
    const lay = mk(b), w = C.createWorld(lay), m = C.dropFrom(w, 'd');
    const path = [[0, 0]];
    let K = -1;
    for (let i = 0; i < 240 * 3 && w.marbles.length; i++) {
      C.step(w);
      if (K < 0 && w.notes.length) K = i + 1;
      if (w.marbles.length) path.push([m.x - SX, m.y - SY]);
    }
    // same column: the smallest release interval (steps) keeping two marbles >= laneGap apart
    let same = 0;
    for (let k = 20; k < 240; k++) {
      const w2 = C.createWorld(lay), a = C.dropFrom(w2, 'd');
      let bm = null, md = Infinity;
      for (let i = 0; i < k + 300 && (w2.marbles.length || i < k); i++) {
        if (i === k) bm = C.dropFrom(w2, 'd');
        C.step(w2);
        if (bm && w2.marbles.includes(a) && w2.marbles.includes(bm)) md = Math.min(md, Math.hypot(a.x - bm.x, a.y - bm.y));
      }
      if (md >= laneGap && w2.notes.length === 2) { same = k; break; }
    }
    const px = new Float64Array(path.map((p) => p[0])), py = new Float64Array(path.map((p) => p[1]));
    for (let i = 1; i < py.length; i++) if (py[i] < py[i - 1]) py[i] = py[i - 1];
    const proto = { theta, drop, b, bMax, K, path, px, py, sameLaneSteps: same, impact: w.notes[0] ? w.notes[0].impact : 0 };
    protoCache.set(key, proto);
    return proto;
  }
  // Bar length by pitch, glockenspiel-like (x0.72 per octave up), times a fit scale
  function rackBarLength(midi, scale, kind) {
    const L = kind === 'melody' ? Math.max(40, Math.min(96, 74 * Math.pow(2, -(midi - 72) / 24))) : Math.max(70, Math.min(130, 118 * Math.pow(2, -(midi - 48) / 24)));
    return Math.max(30, Math.round(30 + (L - 30) * scale));
  }
  // Clearance geometry of one rack column placed with its spawn point at (sx, sy)
  function rackColGeom(proto, len, sx, sy) {
    const g = rackBarGeom(proto.theta, proto.drop, sx, sy, len, proto.b);
    const hl = len / 2;
    const seg = [g.x - g.u[0] * hl, g.y - g.u[1] * hl, g.x + g.u[0] * hl, g.y + g.u[1] * hl];
    const tubes = [[sx - 12.6, sy - 78, sx + 12.6, sy - 10], [sx - 20.6, sy - 97, sx + 20.6, sy - 78]];
    return { sx, sy, bar: { x: g.x, y: g.y }, seg, tubes, px: proto.px, py: proto.py };
  }
  function segDist4(px, py, s) { return distPointSeg(px, py, { ax: s[0], ay: s[1], abx: s[2] - s[0], aby: s[3] - s[1], len2: (s[2] - s[0]) ** 2 + (s[3] - s[1]) ** 2 || 1 }); }
  function segSeg4(a, b) {
    const A = { ax: a[0], ay: a[1], bx: a[2], by: a[3], abx: a[2] - a[0], aby: a[3] - a[1], len2: (a[2] - a[0]) ** 2 + (a[3] - a[1]) ** 2 || 1 };
    const B = { ax: b[0], ay: b[1], bx: b[2], by: b[3], abx: b[2] - b[0], aby: b[3] - b[1], len2: (b[2] - b[0]) ** 2 + (b[3] - b[1]) ** 2 || 1 };
    return segSegDist(A, B);
  }
  function rectPointDist(r, px, py) { const dx = Math.max(r[0] - px, 0, px - r[2]), dy = Math.max(r[1] - py, 0, py - r[3]); return Math.sqrt(dx * dx + dy * dy); }
  function rectSegDist(r, s) {
    const inside = (x, y) => x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3];
    if (inside(s[0], s[1]) || inside(s[2], s[3])) return 0;
    let d = Infinity;
    for (const e of [[r[0], r[1], r[2], r[1]], [r[2], r[1], r[2], r[3]], [r[2], r[3], r[0], r[3]], [r[0], r[3], r[0], r[1]]]) d = Math.min(d, segSeg4(e, s));
    return d;
  }
  function lowerIdx(arr, v) { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < v) lo = m + 1; else hi = m; } return lo; }
  function pathSegDist(G, seg, reach) {
    const y0 = Math.min(seg[1], seg[3]) - reach - G.sy, y1 = Math.max(seg[1], seg[3]) + reach - G.sy;
    let m = Infinity;
    for (let i = Math.max(0, lowerIdx(G.py, y0) - 1); i < G.py.length && G.py[i] <= y1 + 6; i++) m = Math.min(m, segDist4(G.sx + G.px[i], G.sy + G.py[i], seg));
    return m;
  }
  function pathRectDist(G, r, reach) {
    let m = Infinity;
    for (let i = Math.max(0, lowerIdx(G.py, r[1] - reach - G.sy) - 1); i < G.py.length && G.py[i] <= r[3] + reach - G.sy + 6; i++) m = Math.min(m, rectPointDist(r, G.sx + G.px[i], G.sy + G.py[i]));
    return m;
  }
  // Worst clearance between two rack columns (negative = conflict)
  function rackPairSlack(A, B, o) {
    let s = Infinity;
    const R = 15, reach = R + o.rackMargin + 1, vg = o.rackVisualGap;
    s = Math.min(s, pathSegDist(A, B.seg, reach) - R - o.rackMargin, pathSegDist(B, A.seg, reach) - R - o.rackMargin);
    s = Math.min(s, segSeg4(A.seg, B.seg) - 10 - vg);
    for (const r of A.tubes) s = Math.min(s, rectSegDist(r, B.seg) - 5 - vg);
    for (const r of B.tubes) s = Math.min(s, rectSegDist(r, A.seg) - 5 - vg);
    for (const ra of A.tubes) for (const rb of B.tubes) {
      const dx = Math.max(ra[0] - rb[2], rb[0] - ra[2]), dy = Math.max(ra[1] - rb[3], rb[1] - ra[3]);
      s = Math.min(s, Math.max(dx, dy) - vg);
    }
    const tr = 10 + vg + 1;
    for (const r of B.tubes) s = Math.min(s, pathRectDist(A, r, tr) - 10 - vg);
    for (const r of A.tubes) s = Math.min(s, pathRectDist(B, r, tr) - 10 - vg);
    return s;
  }
  function rackExitX(G) { const i = lowerIdx(G.py, BOARD.h + 10 - G.sy); return i < G.py.length ? G.sx + G.px[i] : G.sx + G.px[G.px.length - 1]; }
  // Split the bass notes into columns: one per pitch, low to high; a pitch repeating faster than the column's
  // safe spacing gets a second (third...) column (greedy interval partitioning)
  function rackColumns(events, sameSteps) {
    const byPitch = new Map();
    for (const e of events) { if (!byPitch.has(e.midi)) byPitch.set(e.midi, []); byPitch.get(e.midi).push(e); }
    const cols = [];
    for (const midi of [...byPitch.keys()].sort((a, b) => a - b)) {
      const lanes = [];
      for (const e of byPitch.get(midi)) {
        let lane = lanes.find((l) => e.N - l.last >= sameSteps);
        if (!lane) { lane = { midi, note: e.note, last: -1e9, events: [] }; lanes.push(lane); }
        lane.last = e.N; lane.events.push(e);
      }
      lanes.forEach((l, i) => { l.dup = i; cols.push(l); });
    }
    return cols;
  }
  // spec = { prefix: 'B' (bass) | 'M' (melody), kind, align: 'left' | 'right', maxWidth }
  function buildRack(events, ctx, spec) {
    const { CANON, opts, h } = ctx;
    spec = spec || { prefix: 'B', kind: 'bass', align: opts.rackAlign, maxWidth: opts.rackMaxWidth };
    if (!events.length || !opts.rack) return null;
    const proto = rackPrototype(CANON, opts.rackTheta, opts.rackDrop, opts.rackLaneGap);
    if (!(proto.K > 0) || !proto.sameLaneSteps) throw new Error('bass rack prototype failed');
    const cols = rackColumns(events, proto.sameLaneSteps);
    const sy = opts.rackY - proto.drop;
    let placed = null, scale = 1;
    for (scale = 1; scale >= 0.5 - 1e-9; scale -= 0.1) {
      for (const c of cols) c.len = rackBarLength(c.midi, scale, spec.kind);
      // pack left to right at the smallest spacing that keeps every clearance (frame: first column at x = 0)
      const xs = [];
      const G = [];
      let x = 0;
      for (let i = 0; i < cols.length; i++) {
        const fitsAt = (xx) => { const g = rackColGeom(proto, cols[i].len, xx, sy); for (const P of G) if (rackPairSlack(P, g, opts) < 0) return null; return g; };
        let g = null;
        while (!(g = fitsAt(x)) && x < 4000) x += 8;
        for (let k = 0; k < 8; k++) { const g2 = fitsAt(x - 1); if (!g2) break; x -= 1; g = g2; }
        xs.push(x); G.push(g);
        x += 1;
      }
      const ext = (gs) => {
        let lo = Infinity, hi = -Infinity;
        for (const g of gs) {
          lo = Math.min(lo, g.seg[0] - 5, g.seg[2] - 5, g.tubes[1][0]);
          hi = Math.max(hi, g.seg[0] + 5, g.seg[2] + 5, g.tubes[1][2], rackExitX(g) + 12);
        }
        return { lo, hi };
      };
      // widen the spacing up to rackSpread (checked), if the rack stays narrow enough
      let best = { xs, G };
      for (let f = opts.rackSpread; f > 1.001; f -= 0.05) {
        const xs2 = xs.map((v) => v * f), G2 = xs2.map((v, i) => rackColGeom(proto, cols[i].len, v, sy));
        let ok = true;
        for (let i = 0; i < G2.length && ok; i++) for (let j = 0; j < i && ok; j++) if (rackPairSlack(G2[j], G2[i], opts) < 0) ok = false;
        const e2 = ext(G2);
        if (ok && e2.hi - e2.lo <= spec.maxWidth) { best = { xs: xs2, G: G2 }; break; }
      }
      const e = ext(best.G);
      if (e.hi - e.lo <= spec.maxWidth || scale <= 0.5 + 1e-9) {
        const shift = spec.align === 'right' ? BOARD.w - opts.edge - e.hi : spec.align === 'center' ? Math.round((BOARD.w - e.hi - e.lo) / 2) : opts.edge - e.lo;
        placed = best.xs.map((v, i) => ({ c: cols[i], x: Math.round((v + shift) * 1000) / 1000 }));
        break;
      }
    }
    // pieces, and each column's exact path and steps-to-note measured with CANON (in isolation)
    const pieces = [], columns = [];
    placed.forEach((p, i) => {
      const c = p.c, id = spec.prefix + String(i + 1).padStart(2, '0');
      const bar = rackBarGeom(proto.theta, proto.drop, p.x, sy, c.len, proto.b);
      const dropper = { id: id + '_d', type: 'dropper', x: p.x, y: sy, rot: 0, schedule: { mode: 'times', times: [] } };
      const barP = { id: id + '_bar', type: 'bar', x: +bar.x.toFixed(4), y: +bar.y.toFixed(4), rot: proto.theta, len: c.len, note: c.note };
      const w = CANON.createWorld({ board: BOARD, pieces: [dropper, barP] });
      const m = CANON.dropFrom(w, dropper.id);
      const path = [[m.x, m.y]];
      for (let k = 0; k < 900 && w.marbles.length; k++) { CANON.step(w); if (w.marbles.length) path.push([m.x, m.y]); }
      if (w.notes.length !== 1 || w.notes[0].pieceId !== barP.id || !w.removed[0] || w.removed[0].why !== 'fell') throw new Error('bass rack column ' + c.note + ' does not play cleanly');
      const K = Math.round(w.notes[0].t / h);
      const rels = c.events.map((e) => e.N - K);
      if (rels.some((q) => q < 0)) throw new Error('lead-in too short for the bass rack');
      pieces.push(dropper, barP);
      columns.push({ id, note: c.note, midi: c.midi, dup: c.dup, dropper, bar: barP, K, rels, path, events: c.events, impact: w.notes[0].impact });
    });
    let x0 = Infinity, x1 = -Infinity;
    for (const col of columns) {
      { const bb = bbox(CANON.colliders(col.bar)); x0 = Math.min(x0, bb.x0); x1 = Math.max(x1, bb.x1); }
      x0 = Math.min(x0, col.dropper.x - 20.6); x1 = Math.max(x1, col.dropper.x + 20.6);
      for (const q of col.path) if (q[1] < BOARD.h + 10) { x0 = Math.min(x0, q[0] - 10); x1 = Math.max(x1, q[0] + 10); }
    }
    const top = sy - 97;
    return {
      kind: spec.kind, align: spec.align, proto, columns, pieces, scale, x0, x1, width: x1 - x0, top,
      // everything the melody lanes must keep clear of: rack pieces, dropper drawings, and the rack's marbles
      addTo(occ) {
        for (const col of columns) {
          occ.addPiece(CANON.colliders(col.bar));
          occ.addPiece(tubeCols(col.dropper.x, col.dropper.y));
          occ.addPath(col.path, col.rels);
        }
      },
    };
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

  // Readability of a placed set of lanes (lower is better): every piece is clutter, a lane that repeats another's
  // rhythm is an identical module (easy to read), two-tier columns are busier, and an emptyish board looks unfinished
  function layoutScore(lanes, ctx) {
    const { opts, CANON } = ctx;
    const groups = new Map();
    for (const t of lanes) { const k = rhythmKey(t.r.unit); groups.set(k, (groups.get(k) || 0) + 1); }
    let pieces = 0, modules = 0, lower = 0, x0 = Infinity, x1 = -Infinity;
    for (const t of lanes) {
      pieces += 1 + t.pieces.length + (t.bucket ? 1 : 0) + (t.pieces.length === 1 ? opts.dripScore : 0);
      if (groups.get(rhythmKey(t.r.unit)) > 1 && t.r.unit.notes.length > 1) modules++;
      if (t.role === 'lower') lower++;
      x0 = Math.min(x0, t.r.minX + t.dx); x1 = Math.max(x1, t.r.maxX + t.dx);
    }
    const fill = lanes.length ? (x1 - x0) / (BOARD.w - 2 * opts.edge) : 0;
    return pieces + opts.tierCost * lower - opts.moduleScore * modules + opts.fillScore * Math.max(0, opts.fill - fill);
  }

  // A lower bound of layoutScore for a plan, before solving it: its lanes' droppers and tuned pieces minus
  // the modules its rhythms promise (pails, second tiers and fill only add)
  function planLowerBound(units, ctx, tiers) {
    const groups = new Map();
    const pairs = tiers === 2 ? buildColumns(laneOrder(units, ctx), ctx).filter((c) => c.lower).length : 0;
    for (const u of units) { const k = rhythmKey(u); groups.set(k, (groups.get(k) || 0) + 1); }
    let lb = 0;
    for (const u of units) {
      lb += 1 + u.notes.length + (u.notes.length === 1 ? ctx.opts.dripScore : 0);
      if (groups.get(rhythmKey(u)) > 1 && u.notes.length > 1) lb -= ctx.opts.moduleScore;
    }
    return lb + ctx.opts.tierCost * pairs;
  }

  // ---------------------------------------------------------------------------------------------------------
  function solveSong(song, CANON, userOpts) {
    // song.solver = per-song hints (e.g. { shareVoices: false, barOptions: [1] }); explicit opts override them
    const opts = Object.assign({}, DEFAULTS, song.solver || {}, userOpts || {});
    const h = CANON.SUBSTEP;
    const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
    const t0 = now();
    const notes = songNotes(song, h);
    const lead = Math.round(opts.lead / h) - Math.min(...notes.map((n) => n.ts));
    opts.h = h;
    const ctx = { CANON, opts, h, lead, occ: new Occupancy(), cache: new Map(), rhythm: new Map(), work: 0, workMax: opts.workBudget,
      voiceRank: new Map(song.voices.map((v, k) => [v.name, k])), stats: { rhythmReuse: 0 } };
    // One attempt: melody notes from beat `rackFrom` on (undefined: none) go to the melody rack, the rest to lanes
    function attempt(rackFrom) {
      // 1. the racks, fixed first (the lanes keep clear of them): the bass voices on the bass rack (bottom left);
      // melody notes from song.melodyRackFrom (beat) on, if given, on a melody rack (bottom right). Grieg's
      // prestissimo is faster than cascades can pack on one board, so there the marbles rain onto a glockenspiel.
      for (const n of notes) n.mrack = !n.bass && rackFrom !== undefined && n.beat >= rackFrom - 1e-9;
      const ev = (f) => notes.filter(f).map((n) => ({ note: n.note, midi: CANON.noteToMidi(n.note), N: lead + n.ts, vi: n.vi }));
      ctx.racks = [];
      // the bass rack sits bottom left, or (rackAlign 'auto') bottom centre when every tall lane fits to its left
      const bassSpec = (align) => ({ prefix: 'B', kind: 'bass', align, maxWidth: opts.rackMaxWidth });
      const melRack = buildRack(ev((n) => n.mrack), ctx, { prefix: 'M', kind: 'melody', align: 'right', maxWidth: opts.rackMaxWidth });
      const fixedAlign = opts.rackAlign === 'auto' ? (melRack ? 'left' : null) : opts.rackAlign;
      const bassMain = buildRack(ev((n) => n.bass), ctx, bassSpec(fixedAlign || 'left'));
      const bassCentre = !fixedAlign && bassMain ? buildRack(ev((n) => n.bass), ctx, bassSpec('center')) : null;
      const rackSet = (b) => [b, melRack].filter(Boolean);
      ctx.racks = rackSet(bassMain);
      ctx.shortYMax = ctx.racks.length ? Math.min(...ctx.racks.map((r) => r.top)) - opts.rackGap : BOARD.h - 12;
      // 2. the melody lanes
      const plans = planUnits(song, notes.filter((n) => !n.mrack), ctx).slice(0, opts.maxPlans);
      let best = null, tried = 0;
      const complete = [];
      for (let k = 0; k < plans.length && !outOfWork(ctx); k++) {
        // branch and bound: skip a plan that cannot beat the best complete layout so far (see planLowerBound)
        if (complete.length && (plans[k].drip || planLowerBound(plans[k].units, ctx, plans[k].tiers) >= Math.min(...complete.map((r) => r.score)))) continue;
        let units = plans[k].units.map((u) => Object.assign({}, u, { occ: u.occ.slice() }));
        ctx.share = plans[k].share;
        let splits = 0, res = null;
        for (;;) {
          units.forEach((u, q) => { u.id = 'c' + (q + 1); });
          const { cols, failed, aborted } = buildPlan(units, plans[k].tiers, ctx);
          if (aborted) { res = { lanes: [], failed: units.map((u) => u.key), overflow: true, covered: 0, splits, plan: k, tiers: plans[k].tiers, cols: cols.length }; break; }
          // placement order: short columns (that may sit above a rack) cover the left rack first, then the tall
          // columns, then the remaining short ones (over a right-hand rack)
          const isShort = (c) => c.lanes.every((s) => s.r.maxY <= ctx.shortYMax);
          let ordered = cols;
          ctx.racks = rackSet(bassMain);
          if (bassCentre && cols.filter((c) => !isShort(c)).reduce((a, c) => a + c.width, 0) <= bassCentre.x0 - opts.edge - opts.rackGap - 20) ctx.racks = rackSet(bassCentre);
          if (ctx.racks.length) {
            // left to right: tall columns fill the room left of the first rack, short ones cover that rack, then
            // the rest (tall ones first; the short ones left over can also sit above a right-hand rack)
            const r0 = ctx.racks.reduce((a, r) => (r.x0 < a.x0 ? r : a));
            const leftFree = r0.x0 - opts.edge - opts.rackGap;
            const shortC = cols.filter(isShort), tallC = cols.filter((c) => !isShort(c)), first = [];
            let w = 0;
            while (w < leftFree - 60 && (tallC.length || shortC.length)) { const c = tallC.length ? tallC.shift() : shortC.shift(); first.push(c); w += c.width; }
            w = 0;
            while (shortC.length && w < r0.width - 40) { const c = shortC.shift(); first.push(c); w += c.width; }
            ordered = first.concat(tallC, shortC);
          }
          let placed = placeColumns(ordered, ctx);
          const dropped = [];
          if (!placed) {
            const keepCols = ordered.slice();
            while (keepCols.length && !placed) { dropped.push(...keepCols.pop().lanes.map((l) => l.r.unit)); placed = placeColumns(keepCols, ctx); }
            if (placed) placed.partial = true;
          }
          const lanes = placed && placed.lanes;
          const covered = (lanes || []).reduce((a, t) => a + t.r.unit.notes.length * t.r.unit.occ.length, 0);
          res = { lanes: lanes || [], failed: failed.concat(dropped).map((u) => u.key), overflow: !placed || !!placed.partial, covered, splits, plan: k, tiers: plans[k].tiers, cols: cols.length, racks: ctx.racks.slice() };
          if (opts.debugPlans) opts.debugPlans.push({ plan: k, tiers: plans[k].tiers, units: units.length, cols: cols.length, width: cols.reduce((a, c) => a + c.width, 0),
            widths: cols.map((c) => c.width + ':' + c.lanes.map((l) => l.role[0] + l.r.unit.notes.length).join('/')).join(' '), failed: failed.map((u) => u.notes.length + 'n'), work: ctx.work });
          if (!failed.length || !placed || placed.partial || splits >= opts.maxSplits || outOfWork(ctx)) break;
          let occs = [];
          const keep = units.filter((u) => !failed.includes(u));
          for (const u of failed) { const sp = splitUnit(Object.assign({}, u), opts); if (sp) occs.push(...sp); else keep.push(u); }
          if (!occs.length) break;
          splits += failed.length;
          units = mergeUnits(occs.map((o) => Object.assign({}, o)), keep.map((u) => ({ key: u.key, voice: u.voice, notes: u.notes, occ: u.occ.slice() })), plans[k].share);
        }
        tried++;
        res.complete = !res.failed.length && !res.overflow;
        if (res.complete) { res.score = layoutScore(res.lanes, ctx); complete.push(res); if (complete.length >= opts.planCandidates) break; }
        if (!best || res.covered > best.covered) best = res;
      }
      // the most readable complete layout: fewest pieces, most identical modules, one tier, filling the board
      if (complete.length) best = complete.reduce((a, b) => (b.score < a.score - 1e-9 ? b : a));
      if (best) best.complete = !!best.complete;
      return { best, complete, plans, tried, racks: best && best.racks ? best.racks : ctx.racks, shortYMax: ctx.shortYMax, rackFrom };
    }
    // A song may name its melody-rack cut (song.melodyRackFrom). Otherwise, if the cascades cannot hold the melody
    // (lanes that fail or do not fit the board), its later part moves to the melody rack, bar by bar from 3/4,
    // 1/2, 1/4 of the melody or all of it: the solver degrades gracefully and never drops notes.
    const hinted = opts.melodyRackFrom !== undefined ? opts.melodyRackFrom : song.melodyRackFrom;
    const cuts = [hinted];
    if (opts.rackFallback) {
      const mel = notes.filter((n) => !n.bass && (hinted === undefined || n.beat < hinted - 1e-9)).map((n) => n.beat).sort((a, b) => a - b);
      const bpb = song.beatsPerBar || 4;
      for (const f of [0.75, 0.5, 0.25, 0]) {
        if (!mel.length) break;
        const b = f === 0 ? mel[0] : Math.floor(mel[Math.floor(f * mel.length)] / bpb + 1e-9) * bpb;
        if (!cuts.some((c) => c !== undefined && Math.abs(c - b) < 1e-9)) cuts.push(b);
      }
    }
    let A = null;
    for (const cut of cuts) {
      const a = attempt(cut);
      if (!A || (a.best && a.best.complete && !(A.best && A.best.complete))) A = a;
      if (A.best && A.best.complete) break;
    }
    ctx.racks = A.racks; ctx.shortYMax = A.shortYMax;
    const best = A.best, complete = A.complete, plans = A.plans, tried = A.tried;
    const lanes = best ? best.lanes : [];
    // 3. assemble: lane k = dropper Lk_d, pieces Lk_p0.., bucket Lk_b; rack column = Bnn_d/_bar
    const pieces = [];
    let marbles = 0;
    const rel = (q) => +((q - 0.5) * h).toFixed(6);
    lanes.forEach((t, k) => {
      const L = 'L' + (k + 1) + '_', r = t.r;
      const times = r.rels.map(rel);
      marbles += times.length;
      pieces.push(Object.assign({}, t.dropper, { id: L + 'd', schedule: { mode: 'times', times } }),
        ...t.pieces.map((p, q) => Object.assign({}, p, { id: L + 'p' + q })));
      if (t.bucket) pieces.push(Object.assign({}, t.bucket, { id: L + 'b' }));
    });
    for (const rack of ctx.racks) for (const col of rack.columns) {
      marbles += col.rels.length;
      pieces.push(Object.assign({}, col.dropper, { schedule: { mode: 'times', times: col.rels.map(rel) } }), col.bar);
    }
    const leadIn = lead * h;
    const layout = { v: 1, name: song.title, tempo: Math.round(song.tempo), board: { w: BOARD.w, h: BOARD.h }, pieces, timing: layoutTiming(song, leadIn) };
    const targets = notes.map((n) => ({ t: +(leadIn + n.sec).toFixed(6), note: n.note, voice: n.vi }));
    applyGains(song, layout, targets, leadIn, CANON);
    if (opts.returns !== false) addReturns(layout, targets, CANON);
    const stats = {
      solveMs: 0, work: ctx.work, workBudget: ctx.workMax, lanes: lanes.length, failed: best ? best.failed : [], overflow: best ? best.overflow : false,
      splits: best ? best.splits : 0, plan: best ? best.plan : -1, sharedVoiceLanes: best && plans[best.plan] ? plans[best.plan].share : null,
      melodyRackFrom: A.rackFrom === undefined ? null : A.rackFrom,
      layoutScore: best && best.score !== undefined ? +best.score.toFixed(1) : null, candidates: complete.map((r) => ({ plan: r.plan, score: +r.score.toFixed(1), lanes: r.lanes.length })), tiers: best ? best.tiers : 1, plansTried: tried, pieces: pieces.length, marbles, leadIn,
      rhythmReuse: ctx.stats.rhythmReuse,
      racks: ctx.racks.map((r) => ({ kind: r.kind, columns: r.columns.length, notes: r.columns.reduce((a, c) => a + c.rels.length, 0), x0: +r.x0.toFixed(1), x1: +r.x1.toFixed(1),
        top: r.top, barScale: +r.scale.toFixed(2), stepsToNote: r.proto.K, sameColumnSteps: r.proto.sameLaneSteps })),
      laneInfo: lanes.map((t, k) => ({ id: 'L' + (k + 1), voice: t.r.unit.voice, notes: t.r.unit.notes.map((n) => n.note).join(' '), uses: t.r.unit.occ.length,
        role: t.role, reused: !!t.r.reused, x: [Math.round(t.r.minX + t.dx), Math.round(t.r.maxX + t.dx)], exit: t.bucket ? 'bucket' : 'fall', nodes: t.r.nodes })),
    };
    if (opts.verify) {
      const sim = simulateLayout(CANON, layout, Math.max(...targets.map((x) => x.t)) + 5);
      const sc = scoreNotes(sim.notes.map((x) => ({ t: x.t, note: x.note })), targets);
      stats.verify = { matchedPct: +sc.matchedPct.toFixed(2), extras: sc.extras, maxErrMs: sc.maxErrMs, contacts: sim.contacts,
        minMarbleGap: +sim.minMarbleGap.toFixed(2), firstMisses: sc.firstMisses, firstExtras: sc.firstExtras };
    }
    stats.solveMs = Math.round(now() - t0);
    return { layout, targets, stats };
  }

  // ---------------------------------------------------------------------------------------------------------
  // Loudness per piece: the platform plays a note at its impact's velocity (noteVel below, the same curve as the
  // platform's noteVelocity) times the struck piece's `gain` (only stored when it is not 1). The song's own level
  // (song.gain), its accompaniment (bass voices) under the melody (song.accGain, default 0.8) and, for a song with
  // statements (Mountain King: song.statementBeats, song.statementGain), a crescendo from statement to statement.
  // A melody rack's strikes are softer than a cascade's (a short fixed drop), so its bars are raised to match (at
  // least 1). A piece struck in several statements gets the mean. The physics is untouched (CANON ignores gain).
  function noteVel(impact) { return impact < 120 ? 0.35 + 0.27 * impact / 120 : 0.62 + 0.33 * Math.sqrt(Math.min(1, Math.max(0, (impact - 150) / 650))); }
  function applyGains(song, layout, targets, leadIn, CANON) {
    const w = CANON.createWorld(layout);
    CANON.scheduleReleases(w, layout, 600);
    CANON.simulate(w, targets.reduce((m, x) => Math.max(m, x.t), 0) + 4);
    const sec = makeClock(song), st = song.statementGain, stBeats = song.statementBeats || 16;
    const statementOf = (t) => { let k = 0; while (st && k + 1 < st.length && leadIn + sec((k + 1) * stBeats) <= t + 1e-6) k++; return k; };
    const used = new Set(), strikes = new Map(), isRack = (id) => /^M\d/.test(id);
    for (const n of w.notes) {
      let best = -1, be = 0.015;
      targets.forEach((tg, k) => { const e = Math.abs(tg.t - n.t); if (tg.note === n.note && e <= be && !used.has(k)) { be = e; best = k; } });
      if (best < 0) continue;
      used.add(best);
      const bass = isBassVoice(song.voices[targets[best].voice] || {});
      const g = (song.gain || 1) * (bass ? (song.accGain != null ? song.accGain : 0.8) : st ? st[statementOf(n.t)] : 1);
      if (!strikes.has(n.pieceId)) strikes.set(n.pieceId, []);
      strikes.get(n.pieceId).push({ g, vel: noteVel(n.impact), mel: !bass });
    }
    // a melody rack played as loud as the cascades (their mean velocity over the rack's)
    let comp = 1;
    if (st) {
      let cv = 0, cn = 0, rv = 0, rn = 0;
      for (const [id, list] of strikes) for (const x of list) if (x.mel) { if (isRack(id)) { rv += x.vel; rn++; } else { cv += x.vel; cn++; } }
      if (cn && rn) comp = (cv / cn) / (rv / rn);
    }
    for (const p of layout.pieces) {
      const list = strikes.get(p.id);
      if (!list || !list.length) continue;
      let g = list.reduce((a, x) => a + x.g, 0) / list.length;
      if (st && isRack(p.id)) g = Math.max(g * comp, song.gain || 1);
      g = Math.round(Math.min(1.5, Math.max(0.25, g)) * 1000) / 1000;
      if (g !== 1) p.gain = g;
    }
  }

  // ---------------------------------------------------------------------------------------------------------
  // Feeds and returns: silent spun-steel funnels (note: null: they play nothing). A feed hangs under a lane's
  // dropper, its neck centred on the drop line, so the marble falls cleanly through it into the lane; a return sits
  // over a lane's pail and gathers the marble into it after the lane's last note. Each is kept only where it clears
  // every other piece and the whole song still plays exactly as before (every note at the same step on the same
  // piece, every marble removed the same way, no marble touching another).
  function addReturns(layout, targets, CANON) {
    const end = targets.reduce((m, x) => Math.max(m, x.t), 0) + 6;
    const base = simulateLayout(CANON, layout, end);
    const sig = (r) => r.notes.map((n) => n.t.toFixed(6) + n.note + n.pieceId).join('|') + '#' + r.world.removed.map((x) => x.why).sort().join(',');
    const want = sig(base);
    const segDist = (a, b) => {
      const d = (px, py, c) => { let u = ((px - c.ax) * c.abx + (py - c.ay) * c.aby) / c.len2; u = u < 0 ? 0 : u > 1 ? 1 : u; return Math.hypot(px - c.ax - c.abx * u, py - c.ay - c.aby * u); };
      return Math.min(d(a.ax, a.ay, b), d(a.bx, a.by, b), d(b.ax, b.ay, a), d(b.bx, b.by, a));
    };
    const spots = [];
    for (const d of layout.pieces.filter((p) => p.type === 'dropper' && /^L\d+_d$/.test(p.id))) for (const [w, h] of [[70, 34], [60, 30]]) spots.push({ owner: d, f: { id: d.id.replace(/d$/, 'feed'), type: 'funnel', x: d.x, y: d.y + 6 + h / 2, rot: 0, w, h, note: null } });
    for (const b of layout.pieces.filter((p) => p.type === 'bucket')) for (const [w, h] of [[90, 40], [110, 44], [80, 34]]) spots.push({ owner: b, f: { id: b.id.replace(/b$/, 'f'), type: 'funnel', x: b.x, y: b.y - 30 - 26 - 20 - h / 2, rot: 0, w, h, note: null } });
    for (const { owner: b, f } of spots) {
      {
        const w = f.w, h = f.h;
        if (f.y - h / 2 < 20 || layout.pieces.some((p) => p.id === f.id)) continue;
        const fc = CANON.colliders(f);
        let clear = true;
        for (const p of layout.pieces) {
          if (p === b) continue;
          if (p.type === 'dropper') { if (Math.abs(p.x - f.x) < w / 2 + 30 && p.y - 100 < f.y + h / 2 + 22 && p.y + 10 > f.y - h / 2) clear = false; continue; }
          if (p.type === 'funnel' && p.note === null && p.x === f.x) { clear = false; break; }
          for (const c of CANON.colliders(p)) for (const e of fc) {
            if (c.shape === 'circle') { let u = ((c.x - e.ax) * e.abx + (c.y - e.ay) * e.aby) / e.len2; u = u < 0 ? 0 : u > 1 ? 1 : u; if (Math.hypot(c.x - e.ax - e.abx * u, c.y - e.ay - e.aby * u) < c.r + e.hw + 28) clear = false; }
            else if (segDist(c, e) < c.hw + e.hw + 28) clear = false;
          }
          if (!clear) break;
        }
        if (!clear) continue;
        layout.pieces.push(f);
        const r = simulateLayout(CANON, layout, end);
        if (r.contacts === 0 && sig(r) === want) continue;
        layout.pieces.pop();
      }
    }
  }

  // The demo list (id, title, composer) from the song library, when songs.js is loaded
  function loadSongs() {
    if (typeof MARBLE_SONGS !== 'undefined') return MARBLE_SONGS;     // eslint-disable-line no-undef
    try { if (typeof require === 'function') return require('./songs.js'); } catch (e) { /* not available */ }
    return null;
  }
  const api = { solveSong, songNotes, makeClock, simulateLayout, scoreNotes, DEFAULTS, BOARD,
    solveDemo(id, CANON, opts) { const S = loadSongs(); const song = S && S.find((s) => s.id === id); if (!song) throw new Error('no demo ' + id); return solveSong(song, CANON, opts); },
    _internal: { solveLane, Occupancy, buildColumns, laneOrder, estHeight, planUnits, buildRack, rackPrototype } };
  Object.defineProperty(api, 'demos', { enumerable: true, get() { const S = loadSongs(); return S ? S.map((s) => ({ id: s.id, title: s.title, composer: s.composer, year: s.year })) : []; } });
  return api;
});
