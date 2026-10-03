# Marble Music platform: contract

A pegboard marble-run builder. Metal pieces ring like piano keys when marbles land on them; demo runs play songs,
one landing per note. One self-contained `index.html` (no libraries, no network, works from `file://`), built from
`src/` by `build.sh`. The board's size comes with the layout: a Wide board (1600 x 1000, the original), or a TOWER many
screens tall (1000 x 3000 by default for new runs, up to 4000 x 16000) that one marble zig-zags all the way down while
the camera follows it (see "Towers" in sections 2, 3, 7 and 8). Every demo IS such a tower (`../solver-tower/`: one
marble plays the song's melody all the way down; section 5). The camera is FREE: the view can be turned round the
board (yaw), tilted (pitch), zoomed and panned at any time, playing included, and orbits a marble being followed (see
"The free camera" in sections 7 and 8), and the tower reads as a solid object from any angle: a thick pegboard on
standoffs off the wall, pieces on visible hardware, a real room round it (section 8).

```
./build.sh                          # src/00-head.html + every src/*.js in name order + src/99-tail.html -> index.html; node --check
node tools/bake-starter.js          # solve the first-run starter run with the song solver -> src/21-starter.js
node tools/demo-test.js [--solve] [id]       # resolve + verify every demo in Node, exactly as the page does [+ solve from scratch]
node tools/tower-synth.js [h] [out] [w]      # a synthetic tall run (bars + silent rails placed with CANON) -> out/tower-synth.json (the tower tools read it)
node tools/tower-test.js                     # towers in the page: checkpointed previews == CANON.predict, board sizes, follow
node tools/tower-shots.js out/tower [--gpu | --2d] [--only desk|phone|land]   # tower screenshots (idle, playing, minimap, Fit, builder)
node tools/tower-interact.js                 # getting about a tower: Play zooms in + follows, wheel, fling, minimap, edge scroll, keys
node tools/tower-fit.js                      # the minimap and Follow button fit and clear the HUD at 17 screen sizes
node tools/tower-perf.js                     # a tower followed at 60 fps on the real-GPU path: draw calls, culling, shadow redraws
node tools/orbit-test.js [--layout ../solver-tower/layouts/ode.json]   # the free camera on the real-GPU path: API, limits, follow + orbit, picking and drags from oblique angles, keys, compass, touch (CDP), Cinematic
node tools/orbit-shots.js [--layout ...]     # screenshots from the front, 45°, the yaw limit, tilted down, looking up, close up, the hint, the inspector, a phone -> out/orbit
node tools/merge-shots.js [--out out-merge/shots] [--demo ode]   # the merged scene + camera on the real-GPU path: a shipped tower demo held mid-drop from the front, 45°, both yaw limits, tilted down, looking up, close up (the marble, from below), the whole tower tilted and swung to the limits, pieces from below, the inspector from an angle, the window, a phone
node tools/merge-test.js                     # the ten tower demos (baked, verified, one marble); a forced check failure -> solved again on a Worker, the page responsive, the progress note, the demo opens itself; a demo that cannot be built; no Workers -> the synchronous solve
node tools/platform-towers.js                # every ../solver-tower/layouts/*.json played through loadLayout: notes, the 6 ms check, the round trip (-> out-merge/platform-report.json)
NODE_PATH=$(npm root -g) node ../../verify-music.js index.html out-merge   # the harness (all checks pass)
```
Other `tools/` (Node + Playwright): `audio-render.js` (the page's own piano on an OfflineAudioContext: loudness,
balance, sustain, T60, reverb, clinks, pan, CPU, voice stealing for every demo), `songbook.js` (the 10 demos through the test API, timing kept, silent pieces,
share links), `realtime.js` (real-time playback with the renderer stubbed: every note scheduled at anchor + target +
LATENCY), `perf.js` (draw calls, demo load and first-frame time on the real-GPU path), `gpushot.js` (screenshots on
the real-GPU path), `manymarbles.js` (150 marbles at once, all drawn), `smoke.js`, `shots.js` (the harness's
screenshots, fast), `closeup.js` (every piece up close, `?dev`), `ui.js` (inspector, gallery, menu), `interact.js`
(real-mouse editing), `behave.js` (live edits, repeat droppers, undo), `audio.js`, `stopq.js`, `fit.js` (HUD fits
320 px to 1920 px), `twod.js`, `lose.js` (context loss), `tablet.js`. The "real-GPU path" tools spoof the GPU name so
SwiftShader is not treated as software GL (slow, but it runs the full-quality code).

`build.sh` refuses to build if a copied file differs from its original: `src/05-canon.js` (the shared
`../../canon.js`) and the songbook files `src/21a-songs.js`, `21b-solver.js`, `21c-demo-data.js`, `22-songbook.js`
(`SOLVER_DIR = ../solver-tower/`: the tower demos). The one-line marker files `04-canon-begin.js`, `05z-canon-end.js`,
`21az-solver-begin.js`, `21bz-solver-end.js` bracket CANON and the solver in the built script so that
`23-solver-worker.js` can cut them out of the page's own `<script>` text for its Worker (section 5).

## 1. Module layout (`src/`, concatenated in this order into one `<script>`)

| file | what it holds |
|------|---------------|
| `00-head.html` | markup (top bar, tray, inspector, strip, dialogs, coach) and all CSS (desktop, phone portrait, phone landscape) |
| `04-canon-begin.js`, `05z-canon-end.js` | one-line marker comments round CANON (read by `23-solver-worker.js`) |
| `05-canon.js` | **CANON, verbatim**: physics, piece colliders, note rule, releases, predict |
| `10-util.js` | clamp/lerp, seeded RNG (decoration only), safe `store`, note names, pitch-class rainbow, scales + `nextScaleNote`, DOM helper `el` |
| `12-audio.js` | `piano`: the Web Audio piano (pre-rendered voices per note and metal class, reverb, pan, voice stealing), `play(freq, vel, when, metal, pan)` at an exact audio-clock time, `clink`, `tick` (metronome) |
| `15-model.js` | the layout model, the board's size (`BOARD_W/H`, `normBoard`, `resizeBoard`), normalisation and limits (the load report), undo/redo history, share-link packing, autosave, recent runs and save slots |
| `18-sim.js` | the live CANON world: sessions, audio-clock pacing, note scheduling, rebuild-on-edit, marble history, effects, path preview cache with checkpointed long predictions (`predictRun`, `predictReusing`) |
| `20-demos.js` | `MarbleDemos` plug-in registry + CANON verification; a baked demo that fails the check is solved again in the background (`solveAsync`; `status(id)`, `ready(id)`, `onDemoStatus`) |
| `21-starter.js` | generated by `tools/bake-starter.js`: the first-run starter run (C E G C down four bars at the top of a Tower board), solved with the song solver |
| `21a-songs.js` | copy of `../solver-tower/songs.js`: `MARBLE_SONGS`, the 10 public-domain songs |
| `21az-solver-begin.js`, `21bz-solver-end.js` | marker comments round the solver (for the Worker) |
| `21b-solver.js` | copy of `../solver-tower/solver.js`: `MarbleSolver`, song -> ONE tall tower (layout + the melody's targets); `hintFrom(layout)` sends a re-solve straight to the round that made a baked tower |
| `21c-demo-data.js` | copy of `../solver-tower/demo-data.js`: `MARBLE_DEMO_DATA`, every tower solved offline (re-verified at load) |
| `22-songbook.js` | copy of `../solver-tower/songbook-plugin.js`: registers the songbook with `MarbleDemos` (baked data first, the hinted solve as `build()`) |
| `23-solver-worker.js` | `SOLVER_WORKER`: solves a song on a Worker built from the page's own script (CANON + the solver between the markers), one job at a time; gives every songbook demo `solveAsync()` |
| `30-glcore.js`, `50-geometry.js` | reused WebGL2 engine: math, GL helpers, MeshBuilder, surface/tube/lathe builders |
| `40-textures.js` | reused procedural textures (wall, desk, paper, env map) + pegboard, brushed metal, engraved note-letter atlas |
| `55-pieces3d.js` | every piece type as a real 3D mesh in piece-local space (shared per shape; drawn with a per-piece transform), standing off the board on visible hardware (a bar on grommets over a resonator plate with a slot; rails and curves clamped in `bracket`s on foot plates; posts on rubber feet; flanges, clamps, screws), contact occlusion baked into the vertex alpha (`bakeContactAO`) |
| `60-scene.js` | the room, sized from the board (`boardGeometry`: `DESK_Y`, `TROUGH`, `FIT_BOX`; `roomExtent`), built for a camera that orbits: a thick pegboard in a deep pine frame on steel standoffs off the block wall, the catch tray on wall brackets, one-sided side walls, ceiling (light strips) and desk with the back wall and desk running on beyond them, the window the sun comes through (`buildWindow`), drawing and sticky note |
| `70-shaders.js` | PBR (per-draw transform, coloured glow, metals mirror the board; material flags 5/6/7: emissive, one-sided room surfaces, with material slot z choosing the clip plane), shadow depth, glass marbles, bloom, grade |
| `75-render.js` | renderer: init, assets, targets, the free camera (the front-view fit + pan, dolly zoom and orbit: `CAMERA`, `applyCamera`, `project` / `unproject`, `pxPerUnit`; a far plane that reaches the whole room, `ROOM_FAR`), shadows fitted to what the camera sees from any angle, window light, culled instanced draw lists, scene rebuild for a new board size, frame |
| `78-overlay.js` | 2D overlay (`#fx`) for both renderers, every mark projected through the real camera (`VIEW.b2s` = `project`): path preview (a point behind the camera breaks the line), beat dots, note labels (only what is in view), selection outline (an ellipse from an angle) + handles, floats, bucket counts, marble halos (phones, towers) |
| `80-canvas2d.js` | Canvas 2D fallback renderer and the 2D piece drawer (also paints the tray icons) |
| `85-ui.js` | tray, inspector with the 2-octave piano keyboard, transport, demos gallery, music strip (with the Cinematic toggle), the view compass `#viewCube` (`drawViewCube`, `placeViewCube`), minimap and Follow button (towers), board size choice, save & share, coach, toasts |
| `88-input.js` | editing with mouse/touch/keys: select, move, rotate, resize, delete (key, button, drag to tray), duplicate, tap-to-place; the view: orbit (drag, twist, Alt+arrows, the compass; soft limits, spin, glide, the Cinematic swing: `ORBIT`, `orbitBy`, `orbitTo`, `stepOrbit`), pan / pinch / zoom, home zoom, scrolling a tower (wheel, fling, keys, edge scroll), Fit / front view, the follow camera, `cameraState` / `setCameraState` |
| `90-main.js` | boot (shared link > autosave > starter run), renderer choice + 2D fallback + context-loss recovery, a new board size viewed afresh (relayout + home view), frame loop (camera, minimap, compass), adaptive quality, `window.marbleMusic` |

## 2. Data model

```
Layout = { v: 1, name, tempo (bpm), board: { w, h }, pieces: Piece[], timing? }
Piece  = { id, type, x, y, rot, <params>, note?, gain?, schedule? }
Timing = { start, beatsPerBar, pulse?, tempoMap? }
```

* **The board** is the layout's own `board: { w, h }` (kept exactly as given, clamped to 400..4000 x 400..16000; CANON
  removes marbles below `h + 60` or beyond the sides). A layout, link or file without a board is an older run: the
  Wide 1600 x 1000 board. New runs (the starter, and the board size picked for your own runs) default to the Tower.
  `BOARD_W / BOARD_H` hold the size of the board on the wall; `setBoardSize` changes them (applyLayout, undo,
  resizeBoard only) and runs the `onBoardSize` hooks at once (the room's geometry). `tallBoard()` (h > 1.3 w) = a tower:
  it is viewed zoomed in and scrolled along, with a minimap and the follow camera. Board sizes offered in Save & share >
  Board (`BOARD_SIZES`): Wide 1600 x 1000, Tower 1000 x 3000, Tall tower 1000 x 6000; a demo's own size shows as
  "This board is W x H". **`resizeBoard(w, h)` never loses a piece** (one undo step, kind `'board'`): the run keeps its
  place relative to the board's middle (moved sideways in whole 20-unit holes), is slid in if it would stick out at a
  side, and a board too small for it grows to hold it (100-unit steps, said in the toast, which offers Undo). Pieces
  never move up or down. Clear keeps the board's size.
* Board units, y down, origin top-left, `(x, y)` = the piece centre, `rot` degrees clockwise. Types and params are
  CANON's (`bar len`, `rail len`, `curve r sweep`, `bell r`, `spring len`, `wall len`, `funnel w h`, `dropper`,
  `bucket w` (always 70)). Every type except dropper/bucket has a `note` ('C4', 'F#5', ...), or `note: null`: a silent
  piece (a guide wall or rail that only steers; CANON's note rule skips it). A new piece without a `note` gets the
  next note of the scale (the default: "each new piece is the next piano key"); `addPiece({ ..., note: null })` or the
  inspector's "Silent" button makes it silent, a piano key gives it a note again.
* `timing` (optional): the layout's beat grid. `start` = seconds from Play to beat 0, `beatsPerBar` in quarter beats
  (3/8 = 1.5), `pulse` = the beat-dot spacing in quarter beats (default 1), `tempoMap = [[beat, bpm], ...]`, each
  tempo holding from its beat on (an accelerando). Without it the grid is `tempo` from Play. Demo layouts carry their
  song's grid; the starter run's starts on its first note. `makeBeatClock(timing, tempo)` turns it into a clock
  (`sec(beat)`, `beatAt(t)`, `bpmAt(t)`, `beats(t0, t1)`, `isBar(beat)`); changing the tempo drops the tempo map.
* `normPiece` gives every piece a fixed key order (`id, type, x, y, rot, params..., note, schedule`) and clamps
  params to CANON's ranges. **Values are never rounded or re-normalised** (e.g. `rot` is kept as given): a demo
  solved with exact floats must replay bit-identically.
* `gain` (optional, 0.25..1.5, only stored when not 1): the piece's loudness against its note's velocity. The song
  solver sets it to balance a song (melody over bass, a crescendo); the builder never adds it.
* **Limits** (everything that loads, whatever its source, goes through `applyLayout`): the board is set first, then
  pieces more than 1000 units off that board are left out, at most 1500 pieces, ids cut to 40 characters, `rot` reduced mod 360 only past 3600, drop
  `times` finite, unique, within 0..600 s and at most 2000, a `tempoMap` of at most 512 entries. What was left out is
  in `MODEL.loadReport` and shown in a toast (`loadReportText()`). CANON never sees an unchecked piece.
* Dropper `schedule`: `{ mode: 'manual' }` (drops once on Play, or on "Drop one"), `{ mode: 'repeat', every: beats }`,
  `{ mode: 'times', times: [s...] }` (demos).
* Piece order is collider order in CANON's world (it breaks ties between simultaneous contacts), so the model keeps
  pieces in the order they were added / loaded.
* Ids: kept when loading (`p<n>` for new pieces). Kept in share links too, because CANON orders equal-time releases by
  dropper id.
* Every edit goes through `change(fn)` (one undo step) or `beginChange()` ... `touched('live')` ... `endChange()`
  (drags, sliders). Undo/redo store whole-layout snapshots.
* Share link: `index.html#m=<base64url(JSON [1, name, tempo, rows, timing | 0, [boardW, boardH]])>` (older links without
  the board open as Wide boards), row = `[id, typeIndex, x, y, rot,
  ...params, note (0 = silent), gain (only when not 1), schedule]`, numbers at full precision; up to 2 MB. On load the
  hash wins over the autosave (the run it replaces goes to Recent), then it is removed from the address bar; a new
  `#m=` while the page is open (hashchange) opens too, with Undo.
* **The user's run is never lost.** Autosave: `localStorage['marbleMusic.autosave']` (debounced on every edit, only
  after a frame that ran cleanly; an untouched demo is saved as `{ v, name, demoId }` and rebuilt from the songbook).
  Loading a demo, a link, an import or Clear first puts the run being replaced in **Recent**
  (`marbleMusic.recent`, the last 3 different runs; an untouched starter is not kept), and every such step, a delete
  and Clear offer Undo in a toast (no native dialogs). "Back to my run" (the demo toast, the strip's **My run**) opens
  the newest Recent run and puts the run it replaces (an edited demo, "My Ode to Joy") in Recent too. Boot guard:
  while a page is on screen and has not drawn a good frame, `marbleMusic.booting` holds a heartbeat (the time, every
  second); a hidden page holds none, and a page left without a single frame takes it away. The next start treats a
  fresh heartbeat as another tab starting (not a crash); `'ended'` (left before a good frame) or a heartbeat quiet for
  5 s means the saved run crashed the page: it moves to Recent (and `marbleMusic.autosave.bad`) and the starter loads,
  with a notice whose Show opens Recent. Save slots: `marbleMusic.slots` (up to 20;
  a name already used asks replace / save as new; full asks which to replace); a storage failure (full, blocked) is
  said once, with Export as the way out. Export/import `.json` = `getLayout()` (import up to 2 MB).
* `remixOf`: a demo made editable (Remix, or its first edit) remembers the demo it came from; the strip then compares
  the run with the original ("Still in time: N/M notes").

## 3. How CANON is used live (`18-sim.js`)

* **One world per session.** A session starts at Play (`CANON.createWorld(layout)` + `CANON.scheduleReleases(world,
  layout, 600)`) or, when nothing is running, at a single drop (`CANON.dropFrom`). Its sim time starts at 0; that is
  the `t` of `noteLog` ("seconds since Play or since the first drop"). Stop clears the marbles but keeps the notes.
* **Stepping** is only ever `CANON.step(world)` at `CANON.SUBSTEP` (240 Hz). Notes are `world.notes` (CANON's touch
  rule decides them); buckets and removals are CANON's too.
* **Editing while marbles roll** (`rebuildWorld`, on every model change while a session runs, including live drags;
  with no session the next one builds its own world): a new world is built
  from the edited pieces with `CANON.createWorld`, and the old world's `marbles`, `time`, `nextMarbleId`, `notes` and
  `removed` are carried into it. While playing, releases are re-scheduled from the edited droppers/tempo and the ones
  already due are skipped (`t <= time - SUBSTEP`). Nothing is lost; the marbles simply meet the new pieces
  (tested: a far-away piece added mid-run changes neither the marbles nor a single note; moving a bar ahead of a
  marble changes the music). Because the physics runs slightly ahead of what is shown (section 4), an edit reaches the
  marbles `ahead + LATENCY` later than the eye sees them (about 75 ms at 60 fps).
* Marbles CANON removes (fell, bucket, stuck) stay drawable until the display time reaches their removal.
* **Path preview** = one marble per dropper run ahead with CANON (no other marbles), exactly `CANON.predict(layout,
  dropperId, previewSeconds(), 1/60)`: 8 s on a Wide board, `h / 40` s (20..240) on a tower, so a tower's path runs
  the whole way down. `predictRun` is CANON.predict with a CHECKPOINT of the marble every 0.5 s; after an edit a path
  is run again only from the last checkpoint before its marble first comes within reach of a changed piece
  (`predictReusing`), bit-identical to a fresh predict (`tools/tower-test.js`: 60 random edits on a 6000-unit tower,
  0 differences; 1.9 ms instead of 5.4 ms a preview; the first full 70 s preview 35 ms; a 12000-unit tower's 145 s
  preview 80-100 ms). While a piece is dragged or resized (a live edit) a path is run on for at most `LIVE_SPAN`
  (10 s) past where it had to start again, so a piece near the top of a long tower costs ~2 ms a move instead of a
  whole re-run; when the edit ends the cut path is carried on from its last checkpoint (and is again identical to a
  fresh predict). The beat snap (`snapBase`, `cleanWay`) reuses the same checkpoints. Cached
  per layout version (and recomputed live while a piece is dragged in: during a drag at most every third overlay frame,
  so the paths trail the piece by up to two frames and catch up when it stops). After a small edit only the droppers whose
  cached path comes within reach of a changed piece (old or new place; a bucket's pocket too) are run again: a marble
  that never comes within touching distance of a piece cannot tell it is there, so the other paths are exactly the
  same (`tools/songbook.js`: 80 random edits, 0 differences from a fresh predict; 0.6 ms instead of 6.4 ms). Beat dots are drawn where the marble is on
  every beat of the layout's beat grid (`timing`, else `tempo` from Play), counted from the dropper's first release
  (Play, or the step its first `times` release falls due in); a bar line gets a bigger dot. Note labels at the
  predicted hits (placed once per preview and view, never over the marble at its hit; a path that did not change
  keeps its labels). So a bar placed on a beat dot rings on the beat, a demo's dots sit on its notes, and Mountain
  King's dots close up as it speeds up. A dot where a bar cannot take the note cleanly (the marble rolls there, or a
  bar would ring twice) is a hollow grey ring. While marbles fly the paths fade to 30 %; during Play each marble shows
  only the next 0.5 s of its path.
* **Beat snap** (`snapBase`, `beatSnap`, `cleanWay` in `88-input.js`): a bar, rail, wall, spring or bell dragged
  within about 22 px of a landable dot (or its grid spot within 24 units of the spot that would ring on it) snaps
  there: tilted pieces slide along their length so the marble strikes near the low end, and each candidate (the
  tilt either way, slid or not) is checked with CANON: it must ring exactly once, within 15 ms of the beat, and not
  touch the path before it. The label under the piece reads '✓ on the beat' (|error| <= 15 ms) or 'N ms early/late'.
  Alt places freely. New bars, rails and walls lean against the marble's direction (20° / 15°).
* `simulate(seconds)` (API) steps `round(seconds / SUBSTEP)` times, marks the notes found as already handled (no
  sound) and re-anchors the clock.
* The song solver (`MarbleSolver`, `21b-solver.js`) uses the same CANON, so a demo solved in the browser or in Node
  plays identically in the app.

## 4. Timing and audio scheduling

* The sim is paced by the **audio clock** (`AudioContext.currentTime`; `performance.now()` until a gesture unlocks
  audio; switching clocks re-anchors without a jump).
* Each note found at sim time `t` is scheduled with `piano.play(freq, vel, anchor + t + LATENCY, metal, pan)`,
  `LATENCY = 0.04` s, never "now": frame jitter never reaches the ears. Velocity `noteVelocity(impact)` (0.35..0.95,
  flat for the usual landings, so a song's melody keeps an even touch) times the piece's `gain`; `metal` by piece type
  (a bell rings longest, a rail shortest); `pan` by the piece's x (±0.6).
* **The piano**: each (note, metal class) voice is rendered once on an OfflineAudioContext (partials, the bar's 2.76f
  and 5.4f modes, a soft thock and tick; T60 from 5.5 s at G2 to 2.8 s at C6) and kept (48, least recently used);
  until it is ready an oscillator voice of the same design plays. A small wooden room reverb (1.4 s), a compressor,
  master 0.7: every demo renders at -16..-15 LUFS, true peak <= -2.6 dBFS (`tools/audio-render.js`). Over 40 voices
  sounding (28 oscillator voices) the oldest fades out in 10 ms; a note is never refused. Clinks (a marble in a pail)
  are quiet, softer while a song plays. The metronome (off by default, Music section) ticks the layout's beat grid.
* The display time also subtracts the output latency (`AudioContext.outputLatency`, re-read every 2 s): what the eye
  sees matches what the speakers play (Bluetooth included).
* iPhone: `navigator.audioSession.type = 'playback'` (plays with the ring switch on silent); a note asked for while
  the context wakes up is queued and played once it runs (up to 300 ms late for the answer to a tap, 50 ms for a
  note in a song).
* **Look-ahead**: the physics head runs `SIM.ahead` in front of the clock (head = `clock - anchor + ahead`), where
  `ahead` follows the recent worst frame interval (x1.25 + 12 ms, 20 ms .. 1.25 s; rises at once, relaxes over
  seconds). So every note is in hand before its time even when frames are slow: measured in headless software GL
  (~1 frame/s) every demo note was scheduled 0.27 s or more early with 0 ms error against `anchor + t + LATENCY`.
* The **display time** is `clock - anchor - LATENCY`: marbles are drawn from a 336-step position ring per marble at
  that time, and pieces light up / wiggle / show their note name, buckets count, when it reaches their event. Eyes
  and ears agree.
* Stalls (hidden tab): catch-up is capped (`MAX_CATCHUP` 0.25 s past `ahead`); notes that would already be late
  (> 12 ms) are dropped rather than bunched; the anchor moves (the music pauses, then goes on).
* Play re-anchors; **Stop and a new Play cancel every note queued for the future** (`piano.cancelQueued`). The
  AudioContext is only created/resumed from gestures (re-armed when the browser suspends it). Per-piece-per-marble
  cooldowns are CANON's note rule.

## 5. Demos: the plug-in interface (`20-demos.js`) and the songbook

```js
MarbleDemos.addSource({
  id: 'songbook',                 // unique
  order: 10,                      // optional: lower is listed first (default 50)
  demos: [                        // or list: () => DemoDef[]
    {
      id: 'ode', title: 'Ode to Joy', subtitle: 'Ludwig van Beethoven (1824)',
      data() { return { layout, targets }; },    // precomputed (or layout + targets on the def)
      build() { return { layout, targets }; },   // solve here (the fallback)
    },
  ],
});
MarbleDemos.removeSource(id);
```

* `layout`: a Layout (section 2) whose droppers use `{ mode: 'times', times: [...] }`, with the song's `timing`.
  `targets`: `[{ t, note, voice? }]`, `t` = seconds after Play, `voice` 0 = melody, 1+ = accompaniment.
* Resolution is lazy (first gallery view, `loadDemo`, `demoTargets`, or a background pre-build 1.5 s after start-up,
  one demo per 250 ms) and cached. Precomputed data is **re-verified with CANON in this browser** (play from Play for
  `max(t) + 4` s: every target matched in order with the right pitch within 6 ms, no stray notes). If it fails, the
  song is solved again: **in the background** when the def has `solveAsync()` (a promise of `{ layout, targets }`;
  every songbook demo gets one from `23-solver-worker.js`), so the page never freezes while a tower is solved
  (seconds: Frère Jacques 0.3 s, Ode to Joy ~4 s, Mountain King up to ~30 s, hinted): `MarbleDemos.build(id)` returns
  null meanwhile and `status(id)` reads `{ state: 'solving', since, elapsed, why }`; `ready(id)` is a promise of the
  built demo; when the solve lands it is verified and cached like any other and `onDemoStatus(id, 'ready' |
  'failed', demo)` is called (85-ui.js: the demo the user was waiting for opens by itself). A solve that fails or is
  no better keeps the baked data, flagged. Only a def without `solveAsync()` is solved here and now with `build()`
  (the page waits: the last resort, e.g. no Workers). The result carries `verified`, `report` and `source` ('data' |
  'solved'); an unverified demo still loads (the toast says it may not play note-perfectly), a demo that cannot be
  built at all (`state: 'failed'`) is said so, with the Demos gallery offered. `MarbleDemos.verify(layout, targets)`,
  `.matchNotes()`, `.status(id)` and `.ready(id)` are public. The Worker (`SOLVER_WORKER`, `23-solver-worker.js`)
  is built from a blob of CANON + the solver cut out of the page's own `<script>` between the marker files (section
  1), so the single file needs no second script; jobs run one at a time (a background pre-build on a phone would
  otherwise solve ten songs at once). `tools/merge-test.js` forces the failure (corrupting `MARBLE_DEMO_DATA` and
  re-adding the songbook source, which clears the cache) and checks the whole path, and the no-Worker path.
* **The songbook** (`22-songbook.js`, from `../solver-tower/`) is the one source: the 10 public-domain songs of
  `21a-songs.js`, each solved offline by `21b-solver.js` into ONE TALL TOWER (`21c-demo-data.js`: `board` 800 or 1000
  wide, 2440 to 4680 tall; one marble released once at the top plays the melody on tuned bars, silent (`note: null`)
  chrome rails and steel walls carry it between them, a pail at the foot; Mountain King holds twice, so three
  marbles, `T1_` / `T2_` / `T3_`; the targets are the melody voice only, every note at 0 ms nominal error), and
  `build()` solving the song in the page if the data ever fails the check, hinted (`MarbleSolver.hintFrom`) straight
  to the round that made the baked tower, so it gives the same tower back (checked in `tools/merge-test.js`). Every
  tower plays 100 % with 0 extras at 0 ms in the harness and round-trips through `loadLayout` / `getLayout`
  unchanged (`tools/platform-towers.js`). See `../solver-tower/README.md` and `INTEGRATION.md`.
* UI: Demos gallery (a card per song: a piano-roll picture with bar lines, the title, composer and year, Play /
  Remix). While a demo is loaded, the music strip shows the song's roll over its own beat grid (beats and bar lines,
  which close up as a song speeds up); while playing it scrolls with a playhead, lights each target as its note lands
  and, when the tempo changes, shows the tempo at that moment. Remix makes it an ordinary editable run (any edit does
  too).

## 6. Test API: `window.marbleMusic`

| member | meaning |
|--------|---------|
| `ready` | true once the 3D scene is built (always true in the 2D view) |
| `pieces` | copy of the layout's pieces |
| `addPiece(spec) -> id` | add (no snapping; a note piece without `note` gets the next scale note, `note: null` = silent) |
| `updatePiece(id, patch)`, `removePiece(id)`, `clear()` | undoable edits |
| `undo()`, `redo()` | history |
| `getLayout()`, `loadLayout(layout)` | the Layout (section 2), `timing` included |
| `shareURL()` | this page + `#m=...` |
| `play()`, `stop()`, `dropFrom(dropperId)` | sessions (section 3) |
| `simulate(seconds, dt = 1/60)` | advance the sim without rendering (240 Hz steps) |
| `marbles` | `[{ id, x, y, vx, vy, dropperId }]` of the running session |
| `noteLog`, `clearNoteLog()` | `[{ t, note, pieceId, marbleId }]`, t = sim seconds since Play / first drop |
| `demos`, `loadDemo(id)`, `demoTargets(id)` | `[{ id, title }]`; load (no autoplay; false while the demo is still being solved in the background, or when it cannot be built); `[{ t, note, voice }]` relative to Play (empty while solving) |
| `demoStatus(id)`, `demoReady(id)` | `{ state: 'ready' \| 'solving' \| 'failed' \| 'new' \| 'unknown', verified?, source?, since?, elapsed?, why? }`; a promise of true once the demo is built (false if it cannot be) |
| `predict(dropperId, seconds = 6)` | `CANON.predict` of the current layout: `{ path: [[x, y, t]...], hits: [{ t, note, pieceId, x, y }], end }` |
| `renderer` | `'webgl2'` or `'canvas2d'` |
| `boardToScreen(x, y)`, `screenToBoard(px, py)` | CSS px <-> board units (on the marble plane) |
| `paletteRect(type)` | the tray button's DOMRect |
| extras | `selected`, `select(id)`, `tempo`, `setTempo(bpm)`, `playing`, `MarbleDemos`, `gpu` (also `drawnPieces`, `shadowEpoch`, `shadowExt`); `debugCloseUp(x, y, ...)` with `?dev` |
| board, view | `board` (`{ w, h, tall, size: 'wide' \| 'tower' \| 'tall' \| 'custom' }`), `setBoard(w, h)` (= the Board choice: undoable, keeps every piece, returns `{ w, h, dx, grew }`), `view` (`{ x, y }` the board point in the middle of the free area, `w, h` the span it shows front-on, `zoom, ppu, following, followPaused, mode }`), `scrollTo(y)`, `resumeFollow()`, `homeView()` |
| camera | `camera` (`{ yaw, pitch }` in degrees: yaw > 0 = the eye to the right of the board, pitch > 0 = the eye above, looking down; `dist` = the eye's distance from the target in board units; `target: [x, y]` = the board point in the middle of the free area; `following`), `setCamera({ yaw?, pitch?, dist?, target? })` (any of them at once, angles clamped to the limits, `dist` clamped to the zoom range; a `target` pauses the follow camera, `dist` does not; returns `camera`), `resetView()` (the front view of the board as it opened: a Wide board whole, a tower from its top; a run being followed stays followed), `cameraLimits` (`{ yaw: [-75, 75], pitch: [-25, 65], zoom: [min, max] }`). `boardToScreen` / `screenToBoard` go through the real camera (on the marble plane, so a round trip is exact from any angle). In the 2D view the camera stays front-on: `yaw` and `pitch` read 0 and `setCamera` only takes `dist` and `target`. |

`clear()` also puts the view back (the whole board; a tower from its top); `loadLayout()` shows the load report
(section 2) in a toast and, when the board's size changes, views it afresh.

Element ids: `#playBtn #stopBtn #dropBtn #undoBtn #redoBtn #demosBtn #menuBtn #helpBtn`, tray buttons
`.piece[data-type=...]`, `#inspector`, `#strip` (with `#remixBtn #backBtn #cineBtn`), `#demos`, `#menu`, `#coach`,
`#minimap`, `#followBtn`, `#viewCube` (the view compass), `#boardSeg`.
localStorage: `marbleMusic.helpSeen` (`'1'` = never show the coach), `.autosave` (`.autosave.bad`: a run that crashed
the page), `.booting`, `.recent`, `.slots`, `.scale`, `.path`, `.added`, `.follow`, `.slow3d`, `.towerHint` and
`.orbitHint` (`'1'` = the one-time "a tower" / "you are turning the view" toasts were shown; toasts never block the
page), `.cinematic` (`'1'` = the Cinematic swing is on).

## 7. Builder UX summary

Tray (drag onto the board, or tap then tap the board; Enter adds one near the selection). While a piece is dragged
in, the path preview already includes it. New pieces snap to the
20-unit hole grid (Alt: free), get the next note of the scale (C major, C4..B5, then wrap; scale in Save & share) and
play it. Select: outline, yellow turn knob (15°, Shift 5°, Alt free; wheel over the piece; R / Q), white size handles;
drag to move (dragging onto the tray removes it); Delete / Backspace; Ctrl/Cmd+D; Ctrl/Cmd+Z, Shift+Z / Y; arrows nudge
(Alt: 1 unit); `[` `]` step through pieces. Inspector: piano keyboard (2 octaves, octave arrows) that previews and
assigns, size sliders, turn buttons, dropper schedule (a demo's dropper: 'Song timing (N drops)'), duplicate,
delete; on phones a compact sheet above the tray (the full one on demand). Arrow keys nudge the selection (Shift: 1
unit). The Fit button (F) toggles between the run (framed to its pieces) and the whole board, both from the front
(0 = the whole board from the front); on phones Follow keeps the next second of notes in view while a Wide board's
demo plays.

**The free camera** (3D view; the 2D view stays front-on and a drag pans). The view can be turned, tilted, zoomed and
panned at ANY time, a run playing included:
* Orbit: a plain drag on empty board (one finger) turns the view round the TARGET, the board point in the middle of
  the free area (yaw, about the vertical: a drag across the screen is ~160°) and tilts it (pitch); a quick drag let go
  spins on a little and settles. Yaw keeps within ±75° and pitch within -25° (looking up) .. +65° (looking down),
  and the eye never goes below the desk; the last 12 % of each range is eased into (a drag slows down near a limit
  and never snaps). Alt+arrows turn in 10° steps (Shift: 30°). A two-finger twist (past an 8° dead zone) turns the
  yaw. The first drag that turns the view shows a one-time toast saying what does what (`.orbitHint`).
* Pan: Shift-, right- or middle-drag with the mouse (with a fling), two fingers on touch (after 10 px); the board
  moves with the pointer through the real camera. Zoom is a dolly along the line of sight: the wheel on a Wide board
  (a tower's wheel scrolls; Ctrl+wheel and a trackpad pinch zoom), a pinch, + / -, keeping the board point under the
  pointer where it is; from the whole board (zoom 1) down to a close-up where a marble fills about a fifth of the
  screen (`zoomMax`: a view ~100 units tall). Double-click a piece: it is selected and zoomed to (about two thirds
  of the free area).
* Follow + orbit: while a marble is followed down a tower (section "Towers"), orbiting, tilting and zooming do NOT
  pause the follow camera: the view keeps the marble in frame and swings round it (zooming by hand keeps the new
  distance: `TFOLLOW.userZoom`; zooming about the marble, not the pointer). Panning by hand (a Shift-drag, two
  fingers, the wheel, the minimap, keys) pauses it as before; `#followBtn` ("Follow the marble") resumes it at the
  same angle, a new Play too.
* The view compass `#viewCube` (bottom right of the free area; to the left of a desktop inspector that reaches down
  to it; hidden in the 2D view and under a phone's inspector sheet): a small picture of the pegboard on its wall
  drawn from the camera's own angle, the angle written under it ("front", or "35° ▾20°"). Drag on it to orbit (2.2°
  per px), press it for the front view; focusable: arrow keys turn it, Enter / Space the front view, Home = Reset
  view. Fit (F), 0, Reset view (`resetView`) and a new board all go back to the front view (`CAMERA.yaw0 / pitch0`,
  a 0.5 s glide).
* Cinematic (`#cineBtn` in the demo strip, off by default, remembered in `.cinematic`, hidden in the 2D view): while a
  run plays the view swings slowly on its own (a 30 s sine of ±19° yaw and a little pitch, fading in over 2.5 s and out
  over 0.7 s when the run ends), on top of anything the user does; a drag in progress holds it.
* Everything drawn on top projects through the camera: the path preview and beat rings, note labels, the selection
  outline (an ellipse from an angle) and handles, floats, bucket counts, halos; picking casts the pointer onto the
  marble plane (z = `ZM`, where every piece's metal is centred), so a tap selects and a drag moves a piece exactly
  from any angle (tested at yaw 45 / pitch 25, -62 / 55, 70 / -20: the piece lands where the pointer says). The
  minimap's view frame is the free area's corners cast onto the marble plane (a trapezium from an angle, each corner
  kept within three front-on spans of the target).
* Measures the view logic relies on are angle-free: `VIEW.ppu()` (px per board unit) and `viewSpan()` are taken
  front-on at the target, a pure function of the camera's distance, so the home zoom, the follow camera, snap
  tolerances and label sizes do not change as the view is turned; `viewCentre()` is the target itself.

**Towers** (`tallBoard()`). A tower opens at its HOME view: the board's width across the free area, about 0.78 of a
board-width of it in view (`homeHeight`, at most 1.3 px per unit), from its top, from the front. The wheel and a
trackpad scroll it (Shift: sideways; eased over ~0.1 s), Ctrl+wheel and a trackpad pinch zoom; a Shift-, right- or
middle-drag or two fingers slide it (with a fling; a plain drag / one finger turns the view instead: "The free
camera" above); Page Up / Page Down, Home / End and (nothing selected) the arrow keys scroll; a piece dragged to the top or
bottom edge of the free area scrolls the tower along under it (armed once the pointer has been in the middle). Fit
shows the whole tower; F again (Run) the run's top at the home zoom. A slim MINIMAP (`#minimap`, left of the board,
at most 48 px wide, 30 on phones, the board's proportions) shows the whole tower: every piece in its note colour, the
predicted path, the view as a bright frame, the marbles as glowing dots and the pieces ringing now; press or drag on
it to go there (a press on the marble while the camera has let go of it follows it again); it is a vertical slider for
the keyboard too. During a session (Play or Drop one) the camera FOLLOWS the lead marble (the oldest one): the view
moves with the aim's smoothed speed and a critically damped spring (exact step, calm at any frame rate) takes up the
rest; the aim keeps the marble about a third of the way down the free area and the lowest point of its predicted path
over the next 1.2 s in view (up to 85 % down); between marbles (a hold) it goes on to the dropper that releases next;
a jump of more than a screen glides (0.8 s, eased, zooming in to the home zoom when the view is further out).
Scrolling, sliding the board or using the minimap pauses it (orbiting, tilting and zooming do not); `#followBtn`
("Follow the marble", beside the minimap) resumes it, and so does a new Play. Marbles on a tower have a soft halo. Board size: Save & share > Board (Wide,
Tower, Tall tower, with pictures; `resizeBoard`, section 2). Transport: Play/Stop
(Space), Drop one (D), tempo (a song's own tempo map is read-only), metronome. Every button has a title; the board
is focusable and the inspector keeps keyboard focus as it updates.

## 8. Rendering notes

**A solid tower in a room the camera can orbit** (`60-scene.js`, `55-pieces3d.js`, `70-shaders.js`). The pegboard is
a 9-unit slab (front and back face grids: the holes go right through) in a pine frame 22 deep (face, outer edges, the
step down to the board, its back and the rebate behind the board), hanging on steel standoff tubes on rubber washers
(the corners and every ~900 units along the sides: `buildStandoffs`) off a wall 46 units behind the board face
(`WALL_Z`), so an oblique view sees the gap and the board's soft shadow on the wall. The catch trough is a real tray
(`TROUGH.z0` its back wall just in front of the frame's face, `z1` its lip; floor, end caps, rolled top edges, felt)
on galvanised L-brackets with a diagonal brace from the wall. Every piece stands off the board on visible hardware:
bars on grommet posts over a satin resonator plate with a recessed dark slot below the bar (screwed to the board);
twin-rod rails and curves clamped in a row of `bracket`s (a tie in the note's colour standing on the board on a satin
steel foot plate with two chrome screws; radial on a curve); springs, walls and funnels on posts with rubber feet;
domes on a base flange; droppers on clamp brackets; pails screwed through their backs. `bakeContactAO` darkens the
vertex AO of everything within 9 units of the board face, so the ambient light drops where a piece touches the board.
Nothing in the marble plane changed: the surfaces a marble touches still lie exactly on CANON's colliders (every
addition sits at z < 4, below the marble's reach (`ZM - MARBLE_R`), or inside the collider outline), and every
piece's metal is still centred on z = `ZM`, the plane picking casts onto (section 7).

**The room** (`roomExtent`) is a box the camera can leave without seeing its edges: the block wall behind, block side
walls at `x0 / x1` (1.2 board-heights, 1.6 board-widths, at least 3000 units out), a plaster ceiling at `top` (3.5
board-heights, at least 5000, above the board's top; higher when the window needs it) with fluorescent strips
(emissive, flag 7: they bloom), and the desk, all `z1` deep (6 board-heights, at least 16000) in front of the wall.
The side walls, the ceiling, its strips and the desk are **one-sided** (material flag 6/7): the vertex shader clips
them when the eye is behind their plane, and the back wall and the desk run on `beyond` (a room's width) past the
side walls, the wall from above the ceiling (`wallTop`) down to a floor line (`floor`, 3 board-heights) below the
desk, so a camera that frames a whole tower and tilts or orbits to a limit (the eye is then beyond a side wall; the
camera's `pitchFloor` keeps it above the desk) looks through the partition at more wall and desk, never at a blank
face or the void; the corner occlusion gradients sit at the real corners (x0, x1, the ceiling line, the desk line).
The camera's far plane follows the room (`ROOM_FAR`, `roomFar()`: the farthest corner of the wall, floor line and
room depth, at least 40000), so the wall's far end never drops out at the yaw limit however close the zoom. **The
window** the sun comes through (`buildWindow`) is on the left side wall exactly where the beam along `SUN_DIR`
through the middle of the board meets it: as wide on the wall as the lit patch (`WIN_BEAM_W`, the width of `WINDOW`
in 75-render.js), its upright mullion where the shadow bar falls (`WIN_MULLION_U`), transoms, a painted frame and
sill standing proud of the wall, panes of daylight (emissive), so the lit patch on the board, the mullion's shadow
across it, the bright rectangle in the metal's reflections (`envRadiance`) and the window agree. The frame is
one-sided with its wall: material slot z (`aMat.z`, unused before) picks a one-sided surface's clip plane (0 its own
normal, 1 +x, 2 -x, 3 -y, 4 +y); `uCamPos` is set for every program (the shadow pass too), so the clip is the same
in every pass. Far room surfaces (flag 6/7) get extra bounced daylight in the shader, the down-facing ones (the
ceiling) the sunlit desk's warm bounce. Side walls and ceiling use the `wall` material, so `isRoomCaster` leaves them
out of the shadow maps and the ceiling never shadows the board; the standoffs, tray brackets and window frame are
casters (cascade 1 reaches from `WALL_Z` out to 160). The environment reflections, the sun's highlights and the
marble's refraction are all evaluated from `uCamPos` / `uViewProj`, so they slide as the camera orbits. The room's
extra surfaces and the pieces' brackets are part of the same meshes: no extra draw calls. `tools/merge-shots.js`
(real-GPU path) photographs a shipped tower demo held mid-drop from the front, 45°, both yaw limits, tilted down,
looking up and close up, the whole tower tilted and swung to the limits, every piece from below, the window.

**Any board size**: the pegboard (a vertex every ~50 units, its tone noise repeating only every 12800), frame, trough,
desk and walls are built from the board (`boardGeometry`, `roomExtent`, above) and rebuilt when its size
changes (`rebuildScene`, a few ms; the textures stay). The wall's texture is one seamless tile of 10 x 10 blocks
(5000 x 2500 units) with a gentle large-scale tone in the vertex colours on top, so no repeat shows. On a tower the
window is as tall as the tower: the light patch's top-left-to-bottom-right fall-off is folded along it (a smooth wave,
period ~1500 units, `uWinFold`), so every storey gets the same warm light. **Shadows fitted to the view**: both
cascades cover what is on screen plus 0.3 of its height each way (cascade 0 the board in that region, cascade 1 the
wall and desk round it), from one fixed light view with sizes rounded up (64 / 256 units) and placement snapped to
whole shadow texels, and are redrawn only when the view leaves that region or zooms well in (`updateShadowRegion`), so
a 10000-unit tower's shadows are as sharp as a small board's and do not shimmer as the camera follows. The region is
what the camera sees FROM ITS CURRENT ANGLE (`visibleBoardRect`: the canvas's corners and edge midpoints cast onto
the board face, each kept within three front-on spans of the target, since from a steep angle the far rays land a
long way off or miss); cascade 0, the sharp one, keeps to 1.6 spans round the target and cascade 1 covers the rest,
so a tilted view stays sharp where the eye is and cheap. **The camera** (`fitCamera`, `applyCamera`): the FIT frames
the whole board (`FIT_BOX`) in the free area from the front view (`CAMERA.yaw0 / pitch0`: 4° to the right, 5.7°
above; a lens shift keeps the camera level while the board sits off-centre); on top of it the user's pan moves the
target along the marble plane, the zoom is a dolly (distance = `FIT.D / zoom`) and the orbit swings the eye round
the target by `CAMERA.yaw / pitch` (plus the Cinematic `autoYaw / autoPitch`), clamped to the limits and to
`pitchFloor` (the eye stays above the desk). Near plane `max(4, 0.04 D)`, far `max(4 D + 6000, ROOM_FAR)` (the
whole room: ~41000 for an 800 x 4680 tower, more for a bigger board). `project` marks a point behind the camera as far off screen (`OFFSCREEN`) and `unproject`
gives a ray that misses the plane a far point in its direction (clamped to ±1e6), so nothing streaks across the
screen at a steep angle. **Culling**:
pieces outside that region (plus 120 units) are not drawn at all; their meshes are built ahead, two a frame, so
scrolling never waits for them. The Canvas 2D view paints only the holes, desk and pieces in view. Measured on the
real-GPU path (`tools/tower-perf.js`, 960 x 600, the 6000-unit synthetic tower followed for 40 s at 60 fps): 42 draw
calls a frame (109 when the shadow maps are redrawn), the shadow maps redrawn 6 times in the 40 s, 44 of its 94
pieces drawn, 0.3 ms of CPU a frame for the GL work; the marble stayed 18-39 % of the way down the free area
(measured on the merged build, `out-merge/tower-perf.txt`; a front-on follow: an orbit in progress changes the
visible region's shape, so `updateShadowRegion` can redraw the maps more often than that).

WebGL2: the reused PBR engine (PCSS soft shadows in two cascades, window-light cookie, SH + prefiltered env, glass
marbles refracting the scene, bloom, ACES grade, FXAA/MSAA, adaptive quality, context-loss recovery). The room the
metal reflects: pale walls and a sunlit desk round the viewer, a bright wall behind them and a ceiling light strip
(reflection only: the SH irradiance leaves them out, so the board keeps its tone); a piece on the board mirrors the
board behind it at up to 50 %. Finishes: anodised aluminium (metalness 1, the note colour lifted 15 % towards white in
sRGB), brass (#e3c27a), satin steel. The window light falls as a patch, brightest up on the left. MSAA up to 128 MB of
target on desktops (4x, then 2x, then none; phones none); without MSAA, FXAA runs only next to geometry (the scene's
alpha marks it), so the pegboard's texture holes stay round. Adaptive quality estimates the display's refresh interval
(10th percentile of the last 120 frames), steps down when 40 frames average over 1.25x it, and back up after 5 s at
<= 1.08x (on 2 s probation). Piece meshes are cached per shape and evicted only when unused for 120 frames (at most
max(260, 1.5x the shapes on the board) kept). Pieces are
meshes built once per shape (type, size, note) and drawn **instanced**: every piece sharing a mesh in one draw, its
transform, lift, glow and glow colour read by the vertex shader from a float texture (3 texels per instance, row 0 =
the room). A piece lights up in its note colour and wiggles when it plays. Measured on the real-GPU path
(`tools/perf.js`): a playing frame of the biggest demo (Frère Jacques, 102 pieces) takes 56 draw calls (291 before
instancing), a frame that also redraws the shadow maps 150 (855); loading a demo and drawing its first frame, piece
meshes included, takes 20-40 ms of CPU. **Marbles**: any number is drawn (the instance buffer grows); the first
`GLR.marbleShadows` (from the GPU's fragment uniform budget, 24-96; rolling marbles first, then the one waiting in
each hopper) also cast soft shadows. A song's dropper shows up to three waiting marbles through its sight slot.
`tools/manymarbles.js` draws 150. On software GL (SwiftShader) animated frames are drawn at most every
max(0.6 s, 2x the last frame's cost); still frames at once; a run that draws over 400 pieces at once opens in the 2D
view (on a tower only the pieces in view count), and Play
offers the 2D view once (`.slow3d`). A context lost while the tab is hidden is restored when it is visible again.
Canvas 2D fallback: same camera logic, overlay, UI and playback. Layout: desktop (inspector as a side panel, below
the music strip when a demo is loaded), tablets (compact top bar), phones upright (icon top bar, 2-row tray, the
inspector as a bottom sheet, the board near the top) and phones on their side (control column left, tray column right).

## 9. CANON change requests

None needed. CANON v2 (stuck timer from the release, exact step times, epsilon comparisons, 3-degree curve chords) was
copied in as is; nothing here relied on the old behaviour (a rebuilt world copies `time` only, from which CANON
derives the step; curves are drawn as smooth arcs and hit-tested with `CANON.colliders`). (Observation only:
`predict` samples a single marble with no other marbles, which is exactly what the path preview wants.)
