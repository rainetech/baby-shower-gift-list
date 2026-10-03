/* ============================================================================
 *  SONGBOOK: the Marble Music demo songs as a MarbleDemos source (the platform's src/22-songbook.js)
 *
 *  Needs, earlier in the concatenated script: CANON (05-canon.js), MarbleDemos (20-demos.js) and
 *    MARBLE_SONGS     (songs.js      -> src/21a-songs.js)       the song library: id, title, composer, notes
 *    MarbleSolver     (solver.js     -> src/21b-solver.js)      turns a song into a tower layout + targets
 *    MARBLE_DEMO_DATA (demo-data.js  -> src/21c-demo-data.js)   every demo solved offline (eval.js), optional
 *  Every demo is ONE tall tower: one marble, released once at the top, plays the song's melody on its way down
 *  (Mountain King holds twice: a marble drops into a pail and the next one starts right below it). The layout's
 *  board is as tall as the tower (layout.board = { w, h }); the targets are the melody only.
 *  Each demo gives the platform its baked layout first (data()); MarbleDemos re-verifies it with CANON in this
 *  browser (every target in order, right pitch, within 6 ms, no stray notes) and only if that fails calls
 *  build(), which solves the song here with the same solver. With baked data present, build() goes straight to the
 *  round that solved it offline (MarbleSolver.hintFrom: board width, starting side, holds), so it reproduces the
 *  same tower in a fraction of the full search's time (see INTEGRATION.md for the times).
 *  A layout carries its song's beat grid (layout.timing: start, meter, tempo map), which the music strip and the
 *  path preview's beat dots follow.
 * ========================================================================== */
(function () {
  if (typeof MarbleDemos === 'undefined' || typeof MARBLE_SONGS === 'undefined') return;
  const baked = typeof MARBLE_DEMO_DATA !== 'undefined' ? MARBLE_DEMO_DATA : {};
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const demos = MARBLE_SONGS.map((song) => ({
    id: song.id,
    title: song.title,
    composer: song.composer,
    subtitle: song.composer + (song.year ? ' (' + (song.year === 1680 ? 'c. ' : '') + song.year + ')' : ''),
    data: () => (baked[song.id] ? { layout: clone(baked[song.id].layout), targets: clone(baked[song.id].targets) } : null),
    build: typeof MarbleSolver === 'undefined' ? undefined : () => {
      const hint = baked[song.id] && MarbleSolver.hintFrom ? MarbleSolver.hintFrom(baked[song.id].layout) : undefined;
      const r = MarbleSolver.solveSong(song, CANON, { verify: false, hint });
      return { layout: r.layout, targets: r.targets };
    },
  }));
  MarbleDemos.addSource({ id: 'songbook', order: 10, demos });
})();
