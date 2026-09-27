/* ============================================================================
 *  MARBLE MUSIC: the demo song library (public-domain melodies only)
 *
 *  Song = { id, title, composer, tempo, [tempoMap], beatsPerBar, voices: [{ name, notes: [[beat, 'C5'], ...] }] }
 *    beat      = start of the note in quarter-note beats from the first full bar (pickups are negative)
 *    tempo     = bpm (quarter notes); tempoMap = [[beat, bpm], ...]: piecewise-constant tempo from that beat on
 *    beatsPerBar (quarter beats per bar) lets the solver cut phrases on bar lines (3/8 = 1.5)
 *    voices    = the melody first; a voice whose name contains "bass" is played by the machine's bass rack,
 *                every other voice (melody, round voices, violins) by marble cascades
 *  Notation for seq(): 'NOTE:beats' (default 1 beat), 'r:beats' = rest, '|' = bar line. Every bar is checked
 *  against the meter when this file loads, so a wrong duration throws instead of silently shifting the song.
 *  Tempos are chosen so every note falls on the 240 Hz physics grid (0 ms nominal timing error); the Mountain
 *  King's accelerando uses beat lengths of an even number of physics steps for the same reason.
 *  Transcriptions follow solver C's library (checked note by note by the judge) with the judge's fixes:
 *  Ode to Joy bar 11 bass on V, Jingle Bells bars 7-8 bass on D7 -> G, a waltz bass for Happy Birthday.
 * ========================================================================== */
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.MARBLE_SONGS = api;
})(typeof globalThis !== 'undefined' ? globalThis : typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Parse 'E5 E5:.5 r:1 | G4:2' into [[beat, note], ...]; barLen (beats) checks that every bar adds up
  function seq(start, text, barLen, firstBarLen) {
    const out = [];
    let b = start, barStart = start, bar = 0;
    const check = () => {
      const want = bar === 0 && firstBarLen !== undefined ? firstBarLen : barLen;
      if (barLen && Math.abs(b - barStart - want) > 1e-9) throw new Error(`bar ${bar + 1} of "${text.trim().slice(0, 40)}..." has ${b - barStart} beats, expected ${want}`);
      barStart = b; bar++;
    };
    for (const tok of text.trim().split(/\s+/)) {
      if (tok === '|') { check(); continue; }
      const [n, d] = tok.split(':');
      const dur = d === undefined ? 1 : Number(d);
      if (!(dur > 0)) throw new Error('bad duration ' + tok);
      if (n !== 'r' && !/^[A-G][#b]?\d$/.test(n)) throw new Error('bad note ' + tok);
      if (n !== 'r') out.push([+b.toFixed(6), n]);
      b += dur;
    }
    return out;
  }
  const rep = (n, f) => { const out = []; for (let i = 0; i < n; i++) out.push(...f(i)); return out; };

  const songs = [];

  // ---- 1. Ode to Joy (Beethoven, Symphony No. 9, 1824), C major, with a root-fifth half-note bass.
  // (Bar 12 is the common simplified form with a half-note G, without the syncopated E into bar 13.)
  songs.push({ id: 'ode', title: 'Ode to Joy', composer: 'Ludwig van Beethoven', year: 1824, tempo: 120, beatsPerBar: 4, voices: [
    { name: 'melody', notes: seq(0, `E5 E5 F5 G5 | G5 F5 E5 D5 | C5 C5 D5 E5 | E5:1.5 D5:.5 D5:2 |
      E5 E5 F5 G5 | G5 F5 E5 D5 | C5 C5 D5 E5 | D5:1.5 C5:.5 C5:2 |
      D5 D5 E5 C5 | D5 E5:.5 F5:.5 E5 C5 | D5 E5:.5 F5:.5 E5 D5 | C5 D5 G4:2 |
      E5 E5 F5 G5 | G5 F5 E5 D5 | C5 C5 D5 E5 | D5:1.5 C5:.5 C5:2 |`, 4) },
    { name: 'bass', notes: seq(0, `C3:2 G2:2 | G2:2 D3:2 | C3:2 G2:2 | C3:2 G2:2 | C3:2 G2:2 | G2:2 D3:2 | C3:2 G2:2 | G2:2 C3:2 |
      G2:2 C3:2 | G2:2 C3:2 | G2:2 D3:2 | C3:2 G2:2 | C3:2 G2:2 | G2:2 D3:2 | C3:2 G2:2 | G2:2 C3:2 |`, 4) },
  ] });

  // ---- 2. Twinkle Twinkle Little Star ("Ah! vous dirai-je, maman", French, 1761), with a half-note bass
  songs.push({ id: 'twinkle', title: 'Twinkle Twinkle Little Star', composer: 'Traditional (French)', year: 1761, tempo: 100, beatsPerBar: 4, voices: [
    { name: 'melody', notes: seq(0, `C5 C5 G5 G5 | A5 A5 G5:2 | F5 F5 E5 E5 | D5 D5 C5:2 |
      G5 G5 F5 F5 | E5 E5 D5:2 | G5 G5 F5 F5 | E5 E5 D5:2 |
      C5 C5 G5 G5 | A5 A5 G5:2 | F5 F5 E5 E5 | D5 D5 C5:2 |`, 4) },
    { name: 'bass', notes: seq(0, `C3:2 E3:2 | F3:2 C3:2 | F3:2 C3:2 | G2:2 C3:2 | C3:2 F3:2 | C3:2 G2:2 |
      C3:2 F3:2 | C3:2 G2:2 | C3:2 E3:2 | F3:2 C3:2 | F3:2 C3:2 | G2:2 C3:2 |`, 4) },
  ] });

  // ---- 3. Frère Jacques (French traditional): a three-voice round, each voice entering two bars after the last
  const fj = `C5 D5 E5 C5 | C5 D5 E5 C5 | E5 F5 G5:2 | E5 F5 G5:2 |
    G5:.5 A5:.5 G5:.5 F5:.5 E5 C5 | G5:.5 A5:.5 G5:.5 F5:.5 E5 C5 | C5 G4 C5:2 | C5 G4 C5:2 |`;
  songs.push({ id: 'frere', title: 'Frère Jacques (round)', composer: 'Traditional (French)', tempo: 120, beatsPerBar: 4, voices: [
    { name: 'voice 1', notes: seq(0, fj, 4) },
    { name: 'voice 2', notes: seq(8, fj, 4) },
    { name: 'voice 3', notes: seq(16, fj, 4) },
  ] });

  // ---- 4. Für Elise (Beethoven, WoO 59, 1810): the A section twice (first ending leads back, second ends).
  // 3/8 time: a bar = 1.5 quarter beats = six sixteenths. Right hand = melody, left-hand arpeggios = bass.
  const eliseA = `E5:.25 D#5:.25 E5:.25 B4:.25 D5:.25 C5:.25 | A4:.75 C4:.25 E4:.25 A4:.25 |
    B4:.75 E4:.25 G#4:.25 B4:.25 | C5:.75 E4:.25 E5:.25 D#5:.25 |
    E5:.25 D#5:.25 E5:.25 B4:.25 D5:.25 C5:.25 | A4:.75 C4:.25 E4:.25 A4:.25 |
    B4:.75 E4:.25 C5:.25 B4:.25 |`;
  const eliseLH = `r:1.5 | A2:.25 E3:.25 A3:.25 r:.75 | E2:.25 E3:.25 G#3:.25 r:.75 | A2:.25 E3:.25 A3:.25 r:.75 |
    r:1.5 | A2:.25 E3:.25 A3:.25 r:.75 | E2:.25 E3:.25 G#3:.25 r:.75 | A2:.25 E3:.25 A3:.25 r:.75 |`;
  songs.push({ id: 'elise', title: 'Für Elise', composer: 'Ludwig van Beethoven', year: 1810, tempo: 72, beatsPerBar: 1.5, voices: [
    { name: 'melody', notes: [
      ...seq(-0.5, 'E5:.25 D#5:.25 |', 0.5),
      ...seq(0, eliseA + ' A4:.75 r:.25 E5:.25 D#5:.25 |', 1.5),       // first ending: back to the start
      ...seq(12, eliseA + ' A4:1.5 |', 1.5)] },                          // second ending
    { name: 'bass', notes: [...seq(0, eliseLH, 1.5), ...seq(12, eliseLH, 1.5)] },
  ] });

  // ---- 5. In the Hall of the Mountain King (Grieg, Peer Gynt, 1875), transposed to A minor: the theme, then Grieg's
  // answer a fifth higher, twice over, on a pizzicato A-E pedal, accelerating beat by beat from 104 to 200 bpm. Every
  // beat lasts an even number of 1/240 s physics steps, so every eighth note lands exactly on the physics grid.
  const hall = `A4:.5 B4:.5 C5:.5 D5:.5 E5:.5 C5:.5 E5 | D#5:.5 B4:.5 D#5 D5:.5 A#4:.5 D5 |
    A4:.5 B4:.5 C5:.5 D5:.5 E5:.5 C5:.5 E5:.5 A5:.5 | G5:.5 E5:.5 C5:.5 E5:.5 G5:2 |`;
  const hallAnswer = `E5:.5 F#5:.5 G5:.5 A5:.5 B5:.5 G5:.5 B5 | A#5:.5 F#5:.5 A#5 A5:.5 F5:.5 A5 |
    E5:.5 F#5:.5 G5:.5 A5:.5 B5:.5 G5:.5 B5:.5 E6:.5 | D6:.5 B5:.5 G5:.5 B5:.5 D6:2 |`;
  const hallTempo = [];
  for (let b = 0; b < 64; b++) {
    const bpm = 104 * Math.pow(200 / 104, b / 63);
    hallTempo.push([b, 14400 / (2 * Math.round(7200 / bpm))]);
  }
  // Solver hint: from beat 32 (the last two statements, 145 -> 200 bpm) the melody rains onto a melody glockenspiel
  // rack; the first two statements are marble cascades. `statementGain`: each statement a little louder (per piece:
  // the solver's layout carries it as the pieces' gain).
  songs.push({ id: 'mountain', title: 'In the Hall of the Mountain King', composer: 'Edvard Grieg', year: 1875, tempo: hallTempo[0][1], tempoMap: hallTempo, beatsPerBar: 4,
    melodyRackFrom: 32, statementBeats: 16, statementGain: [0.6, 0.72, 0.86, 1.0], voices: [
    { name: 'melody', notes: rep(4, (k) => seq(16 * k, k % 2 ? hallAnswer : hall, 4)) },
    { name: 'bass', notes: rep(16, (k) => seq(4 * k, 'A2:2 E3:2 |', 4)) },
  ] });

  // ---- 6. Brahms' Lullaby (Wiegenlied, Op. 49 No. 4, 1868), C major, 3/4, music-box octave, with a bass.
  // Bar 4 is "A G" plus the next phrase's pickup eighths "D E" (the phrases all start on the "and" of beat 3).
  songs.push({ id: 'lullaby', title: "Brahms' Lullaby", composer: 'Johannes Brahms', year: 1868, tempo: 90, beatsPerBar: 3, voices: [
    { name: 'melody', notes: seq(-1, `E5:.5 E5:.5 | G5:1.5 E5:.5 E5 | G5:2 E5:.5 G5:.5 | C6 B5:1.5 A5:.5 |
      A5 G5 D5:.5 E5:.5 | F5 D5 D5:.5 E5:.5 | F5:2 D5:.5 F5:.5 | B5:.5 A5:.5 G5 B5 | C6:2 C5:.5 C5:.5 |
      C6:2 A5:.5 F5:.5 | G5:2 E5:.5 C5:.5 | F5 G5 A5 | G5:2 C5:.5 C5:.5 |
      C6:2 A5:.5 F5:.5 | G5:2 E5:.5 C5:.5 | F5 E5 D5 | C5:3 |`, 3, 1) },
    { name: 'bass', notes: seq(0, `C3:3 | C3:3 | G2:3 | G2:3 | G2:3 | G2:3 | G2:3 | C3:3 |
      F2:3 | C3:3 | F2:3 | C3:3 | F2:3 | C3:3 | G2:3 | C3:3 |`, 3) },
  ] });

  // ---- 7. Jingle Bells (James Lord Pierpont, 1857), the chorus, with a root-fifth bass (bars 7-8: D7 -> G)
  songs.push({ id: 'jingle', title: 'Jingle Bells', composer: 'James Lord Pierpont', year: 1857, tempo: 150, beatsPerBar: 4, voices: [
    { name: 'melody', notes: seq(0, `E5 E5 E5:2 | E5 E5 E5:2 | E5 G5 C5:1.5 D5:.5 | E5:4 |
      F5 F5 F5:1.5 F5:.5 | F5 E5 E5 E5:.5 E5:.5 | E5 D5 D5 E5 | D5:2 G5:2 |
      E5 E5 E5:2 | E5 E5 E5:2 | E5 G5 C5:1.5 D5:.5 | E5:4 |
      F5 F5 F5:1.5 F5:.5 | F5 E5 E5 E5:.5 E5:.5 | G5 G5 F5 D5 | C5:4 |`, 4) },
    { name: 'bass', notes: seq(0, `C3:2 G2:2 | C3:2 G2:2 | C3:2 G2:2 | C3:2 G2:2 | F2:2 C3:2 | C3:2 G2:2 | D3:2 A2:2 | G2:2 D3:2 |
      C3:2 G2:2 | C3:2 G2:2 | C3:2 G2:2 | C3:2 G2:2 | F2:2 C3:2 | C3:2 G2:2 | G2:2 D3:2 | C3:4 |`, 4) },
  ] });

  // ---- 8. Happy Birthday (Mildred & Patty Hill, "Good Morning to All", 1893), 3/4, with an oom-pah-pah
  // waltz bass (the root on beat 1, the fifth on beats 2 and 3)
  songs.push({ id: 'birthday', title: 'Happy Birthday', composer: 'Mildred & Patty Hill', year: 1893, tempo: 90, beatsPerBar: 3, voices: [
    { name: 'melody', notes: seq(-1, `G4:.75 G4:.25 | A4 G4 C5 | B4:2 G4:.75 G4:.25 | A4 G4 D5 | C5:2 G4:.75 G4:.25 |
      G5 E5 C5 | B4 A4 F5:.75 F5:.25 | E5 C5 D5 | C5:3 |`, 3, 1) },
    { name: 'bass', notes: seq(0, `C3 G3 G3 | G2 D3 D3 | G2 D3 D3 | C3 G3 G3 | C3 G3 G3 | F2 C3 C3 | C3 G2 G2 | C3:3 |`, 3) },
  ] });

  // ---- 9. Canon in D (Johann Pachelbel, c. 1680): the ground bass four times; the violins enter in canon,
  // two bars apart, with the same lines (the third line in eighths); all end together on a D major chord
  const ground = 'D3 A2 B2 F#2 G2 D2 G2 A2 |';
  const line1 = 'F#5 E5 D5 C#5 B4 A4 B4 C#5 |';
  const line2 = 'D5 C#5 B4 A4 G4 F#4 G4 E4 |';
  const line3 = 'D4:.5 F#4:.5 A4:.5 G4:.5 F#4:.5 D4:.5 F#4:.5 E4:.5 D4:.5 B3:.5 D4:.5 A4:.5 G4:.5 B4:.5 A4:.5 G4:.5 |';
  songs.push({ id: 'canon', title: 'Canon in D', composer: 'Johann Pachelbel', year: 1680, tempo: 72, beatsPerBar: 4, voices: [
    { name: 'violin 1', notes: [...seq(8, line1, 8), ...seq(16, line2, 8), ...seq(24, line3, 8), ...seq(32, 'F#4:2 |', 2)] },
    { name: 'violin 2', notes: [...seq(16, line1, 8), ...seq(24, line2, 8), ...seq(32, 'D5:2 |', 2)] },
    { name: 'bass', notes: [...rep(4, (k) => seq(8 * k, ground, 8)), ...seq(32, 'D3:2 |', 2)] },
  ] });

  // ---- 10. Mary Had a Little Lamb (Lowell Mason's tune, c. 1830), with a half-note bass
  songs.push({ id: 'mary', title: 'Mary Had a Little Lamb', composer: 'Lowell Mason', year: 1830, tempo: 100, beatsPerBar: 4, voices: [
    { name: 'melody', notes: seq(0, `E5 D5 C5 D5 | E5 E5 E5:2 | D5 D5 D5:2 | E5 G5 G5:2 |
      E5 D5 C5 D5 | E5 E5 E5 E5 | D5 D5 E5 D5 | C5:4 |`, 4) },
    { name: 'bass', notes: seq(0, `C3:2 G2:2 | C3:2 G2:2 | G2:2 D3:2 | C3:2 G2:2 | C3:2 G2:2 | C3:2 G2:2 | G2:2 D3:2 | C3:4 |`, 4) },
  ] });

  // ---- The mix: each song's level (gain: every piece's loudness, so every demo plays at about the same
  // loudness) and its accompaniment against the melody (accGain: the bass voices' pieces), set by ear and by
  // measurement (platform/tools/audio-render.js: about -15.5 LUFS a song, the bass 1.5-3 dB under the melody)
  const MIX = { ode: [1.12, 0.98], twinkle: [1.29, 0.93], frere: [1, 1], elise: [0.94, 0.83], mountain: [1.06, 1.11],
    lullaby: [1.32, 1.12], jingle: [1.15, 0.88], birthday: [1.12, 0.82], canon: [1.12, 1.03], mary: [1.29, 0.98] };
  for (const s of songs) if (MIX[s.id]) { s.gain = MIX[s.id][0]; s.accGain = MIX[s.id][1]; }

  songs.seq = seq;
  return songs;
});
