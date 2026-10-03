# Marble Music

Build marble runs from metal pieces on a pegboard. Every piece rings like a piano key when a marble lands on it,
and the demo runs are tall marble towers that play songs, one landing per note.

**To play:** open `index.html` in a browser (Chrome, Safari, Edge or Firefox). It is a single self-contained file
with no downloads or internet needed.

## Building
- Drag pieces from the tray onto the pegboard. Each new piece plays the next note of the scale; pick any note on
  the piano keyboard in the piece editor.
- Add a Dropper and press Play. The dotted line shows where a marble will go, with a ring on every beat: put a bar
  on a ring and it plays on the beat.
- Your board can be Wide, a Tower or a Tall tower (Save & share, then Board). Towers scroll down several screens.
- Save & share keeps runs in the browser, makes share links and exports/imports JSON files.

## Demos
Open **Demos** for songs played by one marble zig-zagging down a tall tower: Ode to Joy, Twinkle Twinkle Little
Star, Frère Jacques, Für Elise, In the Hall of the Mountain King, Brahms' Lullaby, Jingle Bells, Happy Birthday,
Canon in D and Mary Had a Little Lamb (all public domain). Each tower plays the song's melody; Mountain King hands
the marble on twice because its ending is so fast. **Remix** turns a demo into your own run.

## Looking around (works while a marble is dropping)
- **Orbit and tilt:** drag on an empty part of the board (one finger on a touch screen). The view eases into its
  limits. The small compass at the bottom right shows the angle; press it to return to the front view.
- **Pan:** Shift-drag, right-drag or middle-drag (two fingers on a touch screen). **Zoom:** Ctrl+wheel or pinch.
  The plain wheel scrolls a tall tower. Double-click a piece to zoom in on it.
- **Follow the marble:** during Play the camera follows the marble down the tower, and you can orbit and zoom at the
  same time. Panning pauses following; the "Follow the marble" button resumes it. **Cinematic** (in the demo
  strip) adds a slow swing.
- **Keyboard:** Alt+arrow keys orbit, 0 returns to the front view, Shift+arrow keys nudge the selected piece.
- The slim map on the left shows the whole tower, where the marble is and what you can see. Press it to jump.

## For developers
`index.html` is assembled from `src/` by `./build.sh` (the modules are concatenated in file-name order and
syntax-checked). `CONTRACT.md` describes the modules, the data model, the physics core (`src/05-canon.js`), audio
timing, the camera, the demo plug-in interface and the `window.marbleMusic` test API. Development and test tools
mentioned there are not included in this folder.
