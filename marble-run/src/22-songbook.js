/* ============================================================================
 *  SONGBOOK: the Marble Music demo songs as a MarbleDemos source (the platform's src/22-songbook.js)
 *
 *  Needs, earlier in the concatenated script: CANON (05-canon.js), MarbleDemos (20-demos.js) and
 *    MARBLE_SONGS     (songs.js      -> src/21a-songs.js)       the song library: id, title, composer, notes
 *    MarbleSolver     (solver.js     -> src/21b-solver.js)      turns a song into a layout + targets
 *    MARBLE_DEMO_DATA (demo-data.js  -> src/21c-demo-data.js)   every demo solved offline (eval.js), optional
 *  Each demo gives the platform its baked layout first (data()); MarbleDemos re-verifies it with CANON in this
 *  browser (every target in order, right pitch, within 6 ms, no stray notes) and only if that fails calls
 *  build(), which solves the song here with the same solver (0.1-3 s per song on a desktop).
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
      const r = MarbleSolver.solveSong(song, CANON, { verify: false });
      return { layout: r.layout, targets: r.targets };
    },
  }));
  MarbleDemos.addSource({ id: 'songbook', order: 10, demos });
})();
