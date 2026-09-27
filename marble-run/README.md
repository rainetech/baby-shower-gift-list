# Marble Music

Build marble runs from metal pieces on a pegboard. Every piece rings like a piano key when a marble lands on it,
and the demo runs play songs, one landing per note.

**To play:** open `index.html` in a browser (Chrome, Safari, Edge or Firefox). It is a single self-contained file
with no downloads or internet needed.

- Drag pieces from the tray onto the pegboard. Each new piece plays the next note of the scale; pick any note on
  the piano keyboard in the piece editor.
- Add a Dropper and press Play. The dotted line shows where a marble will go, with a ring on every beat: put a bar
  on a ring and it plays on the beat.
- Open **Demos** for songs played by marbles: Ode to Joy, Twinkle Twinkle Little Star, Frère Jacques, Für Elise,
  In the Hall of the Mountain King, Brahms' Lullaby, Jingle Bells, Happy Birthday, Canon in D and Mary Had a Little
  Lamb (all public domain). **Remix** turns a demo into your own run.
- Save & share keeps runs in the browser, makes share links and exports/imports JSON files.

**For developers:** `index.html` is assembled from `src/` by `./build.sh` (the modules are concatenated in file-name
order and syntax-checked). `CONTRACT.md` describes the modules, the data model, the physics core (`src/05-canon.js`),
audio timing, the demo plug-in interface and the `window.marbleMusic` test API. Development and test tools mentioned
there are not included in this folder.
