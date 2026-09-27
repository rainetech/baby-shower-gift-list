
/* ============================================================================
 *  AUDIO: the piano-key synthesiser (Web Audio)
 *  - Every note is a piano-like voice: a 4 ms attack, a prompt drop of about
 *    8 dB over 0.12 s, then a long aftersound (T60 about 5.5 s at G2, 4.5 s at
 *    C4, 2.8 s at C6; higher partials die sooner), under a low-pass that closes
 *    over 0.8 s. Under the key rings the METAL piece that was struck: the bar's
 *    inharmonic 2.76f / 5.40f modes (level by piece type) and a short bright tick.
 *  - Cheap on the CPU: after the first gesture each voice needed (a note and one
 *    of 3 metal classes) is rendered ONCE into a buffer with an OfflineAudioContext
 *    running this same voice code; a note then plays that buffer through a gain
 *    (its velocity), a gentle velocity low-pass and a stereo panner (the piece's
 *    place on the board). Until its buffer is ready a note uses the oscillator
 *    voice itself. At most 48 buffers are kept (least recently used go first).
 *  - Never refuses a note for polyphony: over 40 sounding voices (28 oscillator
 *    voices) the oldest fades out in 10 ms (no click) to make room.
 *  - Notes are scheduled at exact audio-clock times, so frame jitter never
 *    reaches the ears (see SIM for the timing scheme). The AudioContext is only
 *    created after a click, tap or key press; notes asked for while it is still
 *    waking up are played as soon as it runs (dropped only if 50 ms late).
 *  - makePiano({ context }) builds the same synth on any (e.g. offline) context.
 * ========================================================================== */
const METAL_CLASS = [0.35, 0.55, 0.9];                // wall/funnel/rail/curve, bar/spring, bell (dome)
const metalClass = (m) => (m >= 0.75 ? 2 : m >= 0.45 ? 1 : 0);
// Aftersound length (to -60 dB) by pitch, interpolated on log frequency: G2 5.5 s, C4 4.5 s, C6 2.8 s
function noteT60(freq) {
  const l = Math.log2(freq), G2 = Math.log2(97.999), C4 = Math.log2(261.626), C6 = Math.log2(1046.502);
  const v = l <= C4 ? 5.5 + (4.5 - 5.5) * (l - G2) / (C4 - G2) : 4.5 + (2.8 - 4.5) * (l - C4) / (C6 - C4);
  return clamp(v, 2.2, 6);
}
function noiseBuffer(ac, seconds, seed, shape) {
  const n = Math.max(1, Math.floor(ac.sampleRate * seconds));
  const b = ac.createBuffer(1, n, ac.sampleRate), d = b.getChannelData(0), rnd = mulberry32(seed);
  for (let i = 0; i < n; i++) d[i] = (rnd() * 2 - 1) * shape(i / n);
  return b;
}

// One piano-key voice at full velocity, started at `t` into `dest` of audio context `ac` (live or offline).
// Returns { srcs, end }.
function pianoVoice(ac, dest, freq, t, metal, bufs) {
  const T = noteT60(freq), low = freq < 250;
  const out = ac.createGain();
  out.gain.value = 0.3 * clamp(Math.pow(262 / freq, 0.3), 1, 1.5);   // low notes a little louder (as on a piano), so the bass carries
  const lp = ac.createBiquadFilter();
  lp.type = 'lowpass';
  lp.Q.value = 0.6;
  const floor = low ? Math.max(freq * 20, 1500) : Math.max(freq * 4, 1200);   // (bass keeps its upper partials: small speakers need them)
  lp.frequency.setValueAtTime(Math.min(Math.max(freq * 12, floor * 1.5), 16000), t);
  lp.frequency.exponentialRampToValueAtTime(floor, t + 0.8);
  out.connect(lp);
  lp.connect(dest);
  const srcs = [], end = t + T + 0.2;
  const env = (g, amp, t60) => {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(amp, t + 0.004);          // hammer attack
    g.gain.exponentialRampToValueAtTime(amp * 0.45, t + 0.12);    // prompt drop (-7 dB)
    g.gain.setTargetAtTime(0, t + 0.12, t60 / 6.91);              // aftersound: -60 dB after t60
  };
  const osc = (f, amp, t60, cents = 0) => {
    const o = ac.createOscillator();
    o.type = 'sine';
    o.frequency.value = f;
    o.detune.value = cents;
    const g = ac.createGain();
    env(g, amp, t60);
    o.connect(g); g.connect(out);
    o.start(t); o.stop(end);
    srcs.push(o);
  };
  // [harmonic, amplitude, detune in cents]; two slightly detuned fundamentals: a piano's paired strings
  const partials = low ? [[1, 0.9, 0.5], [1, 0.25, -0.5], [2, 0.55, 0], [3, 0.4, 0], [4, 0.25, 0], [5, 0.15, 0], [6, 0.1, 0]]
    : [[1, 0.9, 0.5], [1, 0.25, -0.5], [2, 0.4, 0], [3, 0.18, 0], [4, 0.09, 0], [5, 0.05, 0]];
  for (const [n, amp, cents] of partials) osc(freq * n * Math.sqrt(1 + 0.0004 * n * n), amp, T / Math.pow(n, 0.7), cents);
  // the struck metal: its first two inharmonic modes (2.76f about -18 dB at a bar, 5.40f 8 dB lower), shorter-lived
  if (metal > 0) {
    const a = 0.2 * metal;
    if (freq * 2.76 < 15000) osc(freq * 2.76, a, T * 0.7);
    if (freq * 5.4 < 15000) osc(freq * 5.4, a * 0.4, T * 0.5);
  }
  // the felt of the hammer (a short band-passed thock) and the metal's bright tick (4 ms of high-passed noise)
  const thock = ac.createBufferSource(), bp = ac.createBiquadFilter(), ng = ac.createGain();
  thock.buffer = bufs.thock;
  bp.type = 'bandpass'; bp.frequency.value = Math.min(freq * 3, 5000); bp.Q.value = 1.2;
  ng.gain.value = 0.15;
  thock.connect(bp); bp.connect(ng); ng.connect(out);
  thock.start(t);
  srcs.push(thock);
  const tick = ac.createBufferSource(), hp = ac.createBiquadFilter(), tg = ac.createGain();
  tick.buffer = bufs.tick;
  hp.type = 'highpass'; hp.frequency.value = 4500; hp.Q.value = 0.7;
  tg.gain.value = 0.06 * (0.5 + metal);
  tick.connect(hp); hp.connect(tg); tg.connect(dest);             // (past the voice's closing low-pass)
  tick.start(t);
  srcs.push(tick);
  return { srcs, end };
}

function makePiano(opts = {}) {
  let ctx = null, master = null, reverbIn = null, comp = null, bufs = null;
  let muted = false, resuming = null;
  const VOLUME = 0.7, SAMPLE_VOICES = opts.sampleVoices || 40, OSC_VOICES = opts.oscVoices || 28, MAX_BUFFERS = 48;
  const steals = [];                   // (when voices were faded out to make room: for measuring tools)
  const voices = [];                   // sounding or scheduled: { start, end, gain, srcs }
  const waiting = [];                  // notes asked for while the context was waking up
  const BUF = new Map();               // voice key -> AudioBuffer (Map order = least recently used first)
  const want = [];                     // voice keys still to render: { key, freq, cls }
  let pumping = false;

  // Called from user gestures only. Also wakes a context that the browser suspended or interrupted (iOS).
  function init() {
    try { if (navigator.audioSession && navigator.audioSession.type !== 'playback') navigator.audioSession.type = 'playback'; } catch (e) { /* not supported */ }
    if (ctx) { if (ctx.state !== 'running' && ctx.state !== 'closed') resume(); return; }
    if (opts.context) ctx = opts.context;
    else {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      try { ctx = new AC({ latencyHint: 'interactive' }); } catch (e) { try { ctx = new AC(); } catch (e2) { ctx = null; return; } }
    }
    ctx.onstatechange = () => { if (ctx.state === 'running') flushWaiting(); if (api.onStateChange) api.onStateChange(ctx.state); };
    comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -16; comp.knee.value = 12; comp.ratio.value = 4;
    comp.attack.value = 0.003; comp.release.value = 0.2;
    master = ctx.createGain();
    master.gain.value = muted ? 0 : VOLUME;
    master.connect(comp);
    comp.connect(ctx.destination);
    // A small wooden room: 1.4 s of decaying stereo noise after a 15 ms pre-delay, gently darkened
    const conv = ctx.createConvolver();
    conv.buffer = makeImpulse(1.4, 0.015);
    reverbIn = ctx.createGain();
    reverbIn.gain.value = 0.8;
    reverbIn.connect(conv);
    conv.connect(master);
    bufs = {
      thock: noiseBuffer(ctx, 0.04, 12345, (x) => 1 - x),
      tick: noiseBuffer(ctx, 0.004, 4242, (x) => (1 - x) * (1 - x)),
    };
    if (ctx.state !== 'running') resume();
    if (opts.warm) prepare(opts.warm(), false);
    pump();
  }
  function resume() {
    if (resuming || !ctx || !ctx.resume) return;
    let r;
    try { r = ctx.resume(); } catch (e) { r = null; }
    resuming = Promise.resolve(r).then(() => { resuming = null; flushWaiting(); }, () => { resuming = null; });
  }
  function makeImpulse(seconds, pre) {
    const rate = ctx.sampleRate, len = Math.floor(rate * seconds), p0 = Math.floor(rate * pre);
    const buf = ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const data = buf.getChannelData(ch), rnd = mulberry32(777 + ch * 31);
      let y = 0;
      for (let i = p0; i < len; i++) {
        const k = (i - p0) / (len - p0);
        const a = 0.55 - 0.3 * k;                               // one-pole high cut, darker as it dies away
        y += a * ((rnd() * 2 - 1) - y);
        data[i] = y * Math.exp(-6.9 * k);
      }
    }
    return buf;
  }

  /* ---- Voice buffers: rendered once per (note, metal class), off the main thread ---- */
  const keyOf = (freq, cls) => Math.round(freq * 100) + ':' + cls;
  // Ask for these voices to be ready (front: before anything already asked for). list: [{ freq, metal }]
  function prepare(list, front = true) {
    const add = [];
    for (const v of list || []) {
      const cls = metalClass(v.metal == null ? 0.55 : v.metal), key = keyOf(v.freq, cls);
      if (BUF.has(key) || add.some((a) => a.key === key)) continue;
      const i = want.findIndex((w) => w.key === key);
      if (i >= 0) want.splice(i, 1);
      add.push({ key, freq: v.freq, cls });
    }
    if (front) want.unshift(...add); else want.push(...add);
    if (want.length > MAX_BUFFERS) want.length = MAX_BUFFERS;
    pump();
  }
  // Render a few voices per idle slice
  function pump() {
    if (pumping || !ctx || !want.length || typeof OfflineAudioContext === 'undefined') return;
    pumping = true;
    const job = want.shift();
    renderVoice(job.freq, job.cls).then((b) => {
      if (b) { BUF.set(job.key, b); while (BUF.size > MAX_BUFFERS) BUF.delete(BUF.keys().next().value); }
    }, () => { /* this browser cannot render offline: the oscillator voice plays instead */ want.length = 0; })
      .then(() => { pumping = false; if (want.length) setTimeout(pump, 16); });
  }
  function renderVoice(freq, cls) {
    const sr = ctx.sampleRate, T = noteT60(freq) + 0.2;
    let off;
    try { off = new OfflineAudioContext(1, Math.ceil(T * sr), sr); } catch (e) { return Promise.reject(e); }
    pianoVoice(off, off.destination, freq, 0, METAL_CLASS[cls], bufs);
    return off.startRendering();
  }
  // Wait until every voice asked for is rendered (offline tools)
  function ready() { return new Promise((res) => { const w = () => (!want.length && !pumping ? res() : setTimeout(w, 10)); w(); }); }

  /* ---- Playing a note ---- */
  // Make room at time t: over `limit` voices sounding then, the oldest fades out (10 ms) and stops
  function steal(t, limit) {
    for (let i = voices.length - 1; i >= 0; i--) if (voices[i].end < ctx.currentTime - 0.05) voices.splice(i, 1);
    for (;;) {
      let n = 0, oldest = null;
      for (const v of voices) if (v.start <= t + 1e-4 && v.end > t) { n++; if (!oldest || v.start < oldest.start) oldest = v; }
      if (n < limit || !oldest) return;
      try { oldest.gain.gain.setTargetAtTime(0, t, 0.01); for (const s of oldest.srcs) s.stop(t + 0.12); } catch (e) { /* already ending */ }
      oldest.end = t;                                             // (no longer counted)
      if (steals.length < 1000) steals.push(t);
    }
  }
  // One note at audio time `when` (0 = now). velocity: loudness 0..1.3; metal: how much the struck piece rings
  // (0..1, by piece type); pan: -1 (left) .. 1 (right). Returns false only without sound (no context, muted).
  function play(freq, velocity = 0.7, when = 0, metal = 0.55, pan = 0) {
    if (!ctx || muted) return false;
    if (ctx.state !== 'running') {
      if (ctx.state === 'closed') return false;
      waiting.push({ freq, velocity, when, metal, pan, at: performance.now() });
      if (waiting.length > 64) waiting.shift();
      resume();
      return true;
    }
    const t = Math.max(ctx.currentTime, when || 0);
    const vel = clamp(velocity, 0.05, 1.4), cls = metalClass(metal), key = keyOf(freq, cls);
    const buf = BUF.get(key);
    if (buf) { BUF.delete(key); BUF.set(key, buf); }             // (least recently used order)
    else prepare([{ freq, metal: METAL_CLASS[cls] }]);
    steal(t, buf ? SAMPLE_VOICES : OSC_VOICES);
    const g = ctx.createGain();
    g.gain.value = vel;
    let head = g;
    if (vel < 0.85) {                                             // softer notes are a little darker
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.Q.value = 0.5;
      lp.frequency.value = 1800 + 14000 * vel * vel;
      g.connect(lp); head = lp;
    }
    if (ctx.createStereoPanner && pan) { const p = ctx.createStereoPanner(); p.pan.value = clamp(pan, -1, 1); head.connect(p); head = p; }
    if (opts.route !== 'wet') head.connect(master);              // (opts.route: measuring tools hear one path only)
    if (opts.route !== 'dry') head.connect(reverbIn);
    let v;
    if (buf) {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(g);
      src.start(t);
      v = { start: t, end: t + buf.duration, gain: g, srcs: [src] };
    } else {
      const r = pianoVoice(ctx, g, freq, t, METAL_CLASS[cls], bufs);
      v = { start: t, end: r.end, gain: g, srcs: r.srcs };
    }
    v.srcs[0].onended = () => { try { g.disconnect(); } catch (e) { /* gone */ } };
    voices.push(v);
    return true;
  }
  // The context is running again: play what was asked for meanwhile, unless it would be late: over 50 ms for a
  // note in a song, over 300 ms for the answer to a tap (a phone's audio can take that long to wake)
  function flushWaiting() {
    if (!ctx || ctx.state !== 'running') return;
    const list = waiting.splice(0);
    for (const w of list) {
      const late = w.when ? ctx.currentTime - w.when : (performance.now() - w.at) / 1000;
      if (late <= (w.when ? 0.05 : 0.3)) play(w.freq, w.velocity, w.when ? Math.max(w.when, ctx.currentTime) : 0, w.metal, w.pan);
    }
  }
  // Silence every note that has not started yet (Stop, or a new Play, while notes are queued ahead)
  function cancelQueued() {
    waiting.length = 0;
    if (!ctx) return;
    const now = ctx.currentTime;
    for (const v of voices) {
      if (v.start <= now) continue;
      try { v.gain.gain.cancelScheduledValues(now); v.gain.gain.setValueAtTime(0, now); for (const s of v.srcs) s.stop(now); } catch (e) { /* already stopped */ }
      v.end = now;
    }
  }

  // A soft glassy clink (a marble landing in a pail): quiet, low-passed, by impact; `quiet` while a song plays
  function clink(when = 0, impact = 300, quiet = false, pan = 0) {
    if (!ctx || ctx.state !== 'running' || muted) return;
    const t = Math.max(ctx.currentTime, when || 0);
    const k = 0.16 * clamp(impact / 400, 0.3, 1) * (quiet ? 0.5 : 1);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 3000; lp.Q.value = 0.7;
    let head = lp;
    if (ctx.createStereoPanner && pan) { const p = ctx.createStereoPanner(); p.pan.value = clamp(pan, -1, 1); lp.connect(p); head = p; }
    head.connect(master);
    for (const [f, a] of [[2637, 0.05], [3951, 0.03]]) {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = f; o.type = 'sine';
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(a * k, t + 0.003); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
      o.connect(g); g.connect(lp); o.start(t); o.stop(t + 0.3);
    }
  }
  // A soft woodblock tick (the metronome): accented on bar lines
  function tick(when = 0, accent = false) {
    if (!ctx || ctx.state !== 'running' || muted) return false;
    const t = Math.max(ctx.currentTime, when || 0);
    const src = ctx.createBufferSource(), bp = ctx.createBiquadFilter(), g = ctx.createGain();
    src.buffer = bufs.thock;
    bp.type = 'bandpass'; bp.frequency.value = accent ? 1900 : 1500; bp.Q.value = 6;
    g.gain.setValueAtTime(accent ? 0.9 : 0.55, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.05);
    src.connect(bp); bp.connect(g); g.connect(master);
    src.start(t); src.stop(t + 0.06);
    voices.push({ start: t, end: t + 0.06, gain: g, srcs: [src], tick: true });
    return true;
  }

  function setMuted(m) {
    muted = m;
    if (master) master.gain.setTargetAtTime(m ? 0 : VOLUME, ctx.currentTime, 0.03);
  }

  const api = { init, play, clink, tick, prepare, ready, cancelQueued, setMuted, onStateChange: null,
    get muted() { return muted; }, get state() { return ctx ? ctx.state : 'none'; },
    get running() { return !!ctx && ctx.state === 'running'; },
    get now() { return ctx ? ctx.currentTime : 0; },
    get outputLatency() { return ctx ? (ctx.outputLatency || ctx.baseLatency || 0) : 0; },
    get voiceCount() { const t = ctx ? ctx.currentTime : 0; return voices.filter((v) => v.start <= t && v.end > t).length; },
    get buffers() { return BUF.size; }, get context() { return ctx; }, get steals() { return steals.slice(); } };
  return api;
}
// The page's piano: first the scale most new pieces play (C4 .. C6 on bars), then each layout's own notes
const piano = makePiano({ warm: () => [60, 62, 64, 65, 67, 69, 71, 72, 74, 76, 77, 79, 81, 83, 84].map((m) => ({ freq: 440 * Math.pow(2, (m - 69) / 12), metal: 0.6 })) });
