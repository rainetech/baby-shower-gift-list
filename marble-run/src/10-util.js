
/* ============================================================================
 *  UTILITIES: small helpers, notes and scales, pitch colours, safe storage
 * ========================================================================== */
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const lerp = (a, b, t) => a + (b - a) * t;
const RAD = Math.PI / 180;

// Small seeded random generator (decoration only: textures, wobble). Physics never uses randomness.
function mulberry32(seed) {
  return function () {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// localStorage that never throws (private mode, blocked storage). set() returns '' when it worked, else why not:
// 'quota' (the storage is full) or 'blocked' (no storage here)
const store = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) {
    try { localStorage.setItem(k, v); return ''; } catch (e) {
      return e && (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED' || e.code === 22 || e.code === 1014) ? 'quota' : 'blocked';
    }
  },
  del(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } },
  json(k, fallback) { try { const v = JSON.parse(store.get(k)); return v == null ? fallback : v; } catch (e) { return fallback; } },
};

const reducedMotion = (() => { try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; } })();
const touchUI = (() => { try { return matchMedia('(hover: none) and (pointer: coarse)').matches; } catch (e) { return false; } })();

/* ---- Notes ----
 *  CANON does the note <-> MIDI arithmetic; these add display names, colours and scales. */
const noteFreq = CANON.noteFreq;
const noteToMidi = CANON.noteToMidi;
const midiToNote = CANON.midiToNote;
const NOTE_LO = 48, NOTE_HI = 96;          // C3 .. C7: what the keyboard offers
// Pitch-class rainbow: C red, D orange, E yellow, F green, G teal, A blue, B purple (sharps in between)
const PITCH_HEX = ['#e5392f', '#ef5f2c', '#f28a1e', '#f6b21f', '#f0d02a', '#5fb944', '#2fae6f',
  '#1ea7a3', '#2a8fcf', '#3d6bdb', '#6a55d6', '#9a4fd1'];
const PITCH_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
function pitchClass(note) { const m = noteToMidi(note); return m == null ? 0 : ((m % 12) + 12) % 12; }
function noteHex(note) { return note ? PITCH_HEX[pitchClass(note)] : '#b9bec6'; }
function noteLabel(note) {                   // 'C#5' -> 'C♯5'
  const m = noteToMidi(note);
  return m == null ? '' : PITCH_NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);
}
function noteLetter(note) { const m = noteToMidi(note); return m == null ? '' : PITCH_NAMES[((m % 12) + 12) % 12]; }
function hexRgb(hex) { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function mixHex(hex, to, k) {                 // blend a colour towards another ('#fff' style or [r,g,b])
  const a = hexRgb(hex), b = typeof to === 'string' ? hexRgb(to) : to;
  return 'rgb(' + a.map((v, i) => Math.round(v + (b[i] - v) * k)).join(',') + ')';
}

/* ---- Scales: a newly added piece gets the next note of the current scale (C major by default) ---- */
const SCALES = {
  'C major': { root: 0, steps: [0, 2, 4, 5, 7, 9, 11] },
  'C pentatonic': { root: 0, steps: [0, 2, 4, 7, 9] },
  'G major': { root: 7, steps: [0, 2, 4, 5, 7, 9, 11] },
  'F major': { root: 5, steps: [0, 2, 4, 5, 7, 9, 11] },
  'A minor': { root: 9, steps: [0, 2, 3, 5, 7, 8, 10] },
  'D minor': { root: 2, steps: [0, 2, 3, 5, 7, 8, 10] },
  'Blues (C)': { root: 0, steps: [0, 3, 5, 6, 7, 10] },
  'Chromatic': { root: 0, steps: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
};
const AUTO_LO = 60, AUTO_HI = 83;             // auto notes run through octaves 4 and 5 (C4 .. B5), then wrap
function inScale(midi, scaleName) {
  const s = SCALES[scaleName] || SCALES['C major'];
  return s.steps.includes((((midi - s.root) % 12) + 12) % 12);
}
// The next scale note above `prev` (or the first one from C4), wrapping from octave 5 back to octave 4
function nextScaleNote(prev, scaleName) {
  let m = prev ? noteToMidi(prev) : null;
  if (m == null) m = AUTO_LO - 1;
  for (let k = 1; k <= 24; k++) {
    let c = m + k;
    if (c > AUTO_HI) c = AUTO_LO + ((c - AUTO_LO) % (AUTO_HI - AUTO_LO + 1));
    if (inScale(c, scaleName)) return midiToNote(c);
  }
  return 'C4';
}

/* ---- Small DOM helpers ---- */
const $ = (sel, root = document) => root.querySelector(sel);
function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const k in attrs) {
    const v = attrs[k];
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids) if (c != null) e.append(c);
  return e;
}
