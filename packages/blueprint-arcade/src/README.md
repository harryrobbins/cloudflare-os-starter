# Arcade

Make and play retro games together. An arcade holds a shelf of games, a jukebox of tunes, shared high scores and each player's own key layout. Every game is a short JavaScript "cartridge" that anyone in the workspace can open, change and run beside a live preview.

A new arcade comes stocked with starters to play and adapt:

| Game | Style | What it shows off |
| --- | --- | --- |
| Invaders | Arcade, 224×256 | Sprite animation, marching formation, crumbling bunkers, a mystery saucer |
| Rocks | Vector, green phosphor | Rotating vector shapes, thrust and wraparound, polygon hit tests |
| Blocks | Falling blocks | The well kit: 7-bag, rotation with wall kicks, ghost piece, hold, music |
| Bricks | Bat and ball | Bounce angles, levels drawn as letter grids |
| Number Gulper | BBC Micro Mode 2 | Wide pixels, flashing colours, maths rules, wandering enemies |
| Teletext Tables | BBC Micro Mode 7 | Teletext control codes, mosaic graphics, typed answers against the clock |
| Dark Room | RM Nimbus | Hidden-text (cloze) puzzle, typed guesses, a classroom-program look |

**Blank cartridge** is the empty starting point for a new game.

## Using the arcade

- **Games.** Play a game, open its **Code**, or use ⋯ to rename, duplicate, reset a starter's code, clear its scores or delete it. **New game** starts from the blank cartridge or from a copy of any starter.
- **Play.** Click the screen, then use the keys shown beside it. P pauses. High scores update live and are recorded under your account. On a touch screen, buttons appear under the game.
- **Code.** Edit on the left and run on the right (Ctrl+Enter). Errors appear in the console with a link to the line. **Save** (Ctrl+S) shares your version with everyone. If someone else saved in the meantime, your save is refused rather than overwriting theirs. **Reference** shows this guide beside the code. Tab indents; press Escape then Tab to move focus out of the editor.
- **Music.** Tunes for up to four channels, written in MML (see "Composing music"). Play them with the piano roll, write notes with the on-screen or computer-keyboard piano, and use them in games by title. To download a tune as **WAV** audio or a **MIDI** file, use **Export** in the gadget's menu. The same menu exports every game's code as Markdown.
- **Controls.** Pick a key layout: the game's own, ARCADE (arrows and Space), BBC (Z X ; / and Return, the Acornsoft keys), WASD, or both hands. You can also rebind single actions. Settings are yours alone. Escape is never bound, because the platform uses it to leave full screen.

## Writing a game

A cartridge is an ES module with a `config` and a default function. The function receives `a`, the arcade API, and returns `{update, draw}`. `update()` runs 60 times a second; `draw(g)` paints the screen `g`.

```js
export const config = {
  title: "Catch",
  mode: "bbc1",               // screen preset, see "Screen modes"
  controls: "arcade",         // default key layout: arcade, bbc, wasd or both
  help: ["Left and right move", "Catch the stars"],
};

export default function game(a) {
  let x = a.W / 2, score = 0;
  const star = { x: a.rndi(10, a.W - 10), y: 0 };

  return {
    update() {
      if (a.btn("left")) x -= 3;
      if (a.btn("right")) x += 3;
      x = a.clamp(x, 8, a.W - 8);
      star.y += 2;
      if (a.hit.rects({ x: x - 8, y: a.H - 20, w: 16, h: 8 }, { x: star.x - 3, y: star.y - 3, w: 7, h: 7 })) {
        score += 10; a.sfx("coin"); star.y = 0; star.x = a.rndi(10, a.W - 10);
      }
      if (star.y > a.H) { a.score.submit(score); a.sfx("lose"); score = 0; star.y = 0; }
    },
    draw(g) {
      g.cls(0);
      g.sprite(a.sprites.star, star.x, star.y, { color: "yellow", center: true });
      g.fill(x - 8, a.H - 20, 16, 6, "cyan");
      g.text(`SCORE ${score}`, 4, 4, "white");
    },
  };
}
```

Rules of the cabinet:

- Games cannot `import` anything, reach the network, or store files. Everything is on `a`.
- Keep state in variables inside `game(a)`. For several screens (title, play, game over), keep a `mode` variable, or call `a.scene({enter, update, draw})` to switch.
- Submit a score with `a.score.submit(n)` when a game ends. The arcade keeps each player's best, and the top 20.
- A game with `config.typing: true` receives every key as typing: letters and digits reach `a.typed()`, and P does not pause.
- Read actions (`a.btn("fire")`), not raw keys, so every player's chosen layout works. If you need a raw key, `a.key("KeyQ")`, check that it doesn't clash with the BBC layout (Z X ; / Return).

### Config

| Field | Meaning |
| --- | --- |
| `title` | Shown in the arcade |
| `mode` | Screen preset (below). Override with `width`, `height`, `pixelAspect` (pixel width ÷ height), `palette` |
| `palette` | A name below, or your own list of `"#rrggbb"` |
| `controls` | Default layout: `arcade`, `bbc`, `wasd`, `both` |
| `typing` | `true` for games that read typed text |
| `help` | Lines shown beside the game |
| `crt` | `false` turns off the scanline overlay |

### Screen modes

| Mode | Size | Pixels | Palette |
| --- | --- | --- | --- |
| `default` | 320×256 | square | `arcade` (16 bright colours) |
| `arcade` | 224×256 | square | `arcade` (upright cabinet) |
| `bbc0` | 640×256 | tall (0.5) | `bbc` |
| `bbc1` | 320×256 | square | `bbc` |
| `bbc2` | 160×256 | wide (2) | `bbc`, with flashing colours 8-15 |
| `teletext` | 320×250 | 40×25 cells of 8×10 | `bbc` (use `a.teletext()`) |
| `nimbus` | 320×250 | square | `nimbus` (16 colours) |
| `nimbushi` | 640×250 | tall (0.5) | `nimbus` |
| `vector` | 320×240 | square | `green` phosphor |
| `gameboy` | 160×144 | square | `gameboy` (four greens) |

Palettes: `bbc` (0 black, 1 red, 2 green, 3 yellow, 4 blue, 5 magenta, 6 cyan, 7 white; 8-15 flash between a colour and its opposite), `nimbus`, `cga`, `zx`, `c64`, `pico`, `arcade`, `green`, `amber`, `gameboy`. A colour argument is a palette index, `"#rrggbb"`, or a name (`"red"`, `"cyan"`, `"orange"`...), which picks the nearest palette colour.

### Drawing: `g`

| Call | Does |
| --- | --- |
| `g.cls(c = 0)` | Clear to a colour |
| `g.pset(x, y, c)`, `g.pget(x, y)` | One pixel |
| `g.line(x0, y0, x1, y1, c)` | Line |
| `g.rect(x, y, w, h, c)`, `g.fill(x, y, w, h, c)` | Outline and filled box |
| `g.circ(x, y, r, c)`, `g.disc(x, y, r, c)` | Outline and filled circle |
| `g.poly(points, c)`, `g.polyfill(points, c)` | Closed polygon; points `[x0, y0, x1, y1, ...]` or `[[x, y], ...]` |
| `g.text(str, x, y, c, {scale, sx, sy, align, shadow, bg})` | 8×8 font. `align`: `"left"`, `"center"` or `"right"`. `sy: 2` is BBC double height. `\n` breaks lines. Returns the width |
| `g.textWidth(str, scale)` | Width in pixels |
| `g.sprite(spr, x, y, {color, scale, flipX, flipY, center})` | Draw a sprite; `color` recolours it |
| `g.camera(x, y)` | Offset everything drawn after it (scrolling) |
| `g.W`, `g.H` | Screen size (also `a.W`, `a.H`) |

### Sprites and shapes

- `a.sprite(rows, key)` makes a sprite from text rows. `.` and spaces are transparent, `0`-`9`/`a`-`f` are palette colours, other characters use `key` (`{X: "red", o: 3}`) or white.
- `a.sprites.<name>` are built in: `alienA1 alienA2 alienB1 alienB2 alienC1 alienC2 cannon saucer boom shot zigzag bunker heart star coin gem key apple ghost smiley arrow block brick ball paddle gulper1 gulper2 troggle owl man1 man2`. Recolour them with `{color}`.
- `a.shapes.<name>` are vector outlines around (0, 0), facing right: `ship flame saucer arrowhead diamond square triangle star5`. `a.shape(points, x, y, angle, scale)` rotates and places one for `g.poly`. `a.rock(radius)` makes a lumpy asteroid.

### Input

| Call | Does |
| --- | --- |
| `a.btn(action)` | Held. Actions: `left right up down fire alt start pause` |
| `a.btnp(action, repeat?, delay?)` | Pressed this frame; with `repeat`, again every `repeat` frames after `delay` frames held (auto-shift) |
| `a.btnr(action)` | Released this frame |
| `a.axis()` | `{x, y}`, each -1, 0 or 1 |
| `a.key(code)`, `a.keyp(code)` | Raw keys by `KeyboardEvent.code`, e.g. `"KeyQ"`, `"Digit1"` |
| `a.typed()` | Characters typed this frame; `"\b"` is Delete, `"\n"` is Return |

### Sound and music

- `a.sfx(name)` plays a preset: `laser shoot explode bang thrust jump coin powerup hit blip select correct wrong lose win step lock line tick march1 march2 march3 march4 ufo`. Or make your own blip: `a.sfx({wave: "square", hz: 880, toHz: 220, seconds: 0.2, vol: 0.5, env: "perc"})`, or a list of blips played in turn, or `{mml: "o5 l16 c e g", tempo: 140}`.
- `a.sound(channel, amplitude, pitch, duration)` is BBC BASIC's SOUND. Channel 0 is noise, 1-3 are tone. Amplitude runs from -15 (loud) to 0. Pitch is in quarter semitones, and 53 is middle C. Duration is in twentieths of a second.
- `a.music("Tune title", {loop})` plays a tune from the Music tab (calling it again while that tune plays does nothing); `a.stopMusic()`.

### Helpers

- **Random:** `a.rnd(n)` (float below n), `a.rndi(lo, hi)`, `a.chance(p)`, `a.pick(list)`, `a.shuffle(list)`, `a.seed(n)`.
- **Maths:** `a.clamp`, `a.lerp`, `a.dist`, `a.angle(x1, y1, x2, y2)`, `a.wrap(v, max)`, `a.approach(v, target, step)`, and `a.ease.outQuad(t)` with `inQuad inOutQuad outBack outBounce`.
- **Collision:** `a.hit.rects(a, b)` for `{x, y, w, h}`, `a.hit.circles` for `{x, y, r}`, `a.hit.circleRect`, `a.hit.point(px, py, box)`, `a.hit.inPoly(px, py, poly)`, `a.hit.segCircle`, `a.hit.polyCircle(poly, circle)`.
- **Time:** `a.frame`, `a.t` (seconds), `a.after(frames, fn)` and `a.every(frames, fn)`, which return a cancel function.
- **Effects:** `const p = a.particles(); p.burst(x, y, {count, color, colors, speed, life, gravity, size}); p.update(); p.draw(g)`. `a.shake(frames, strength)`.
- **Menus:** `const m = a.menu(["Start", "Help"])`; `m.update(a)` returns the chosen index once (or -1); `m.draw(g, x, y, {color, active, align, scale})`.
- **Grids:** `a.grid(cols, rows, fill)` with `get set inside each fill` and `cells[y][x]`.
- **Falling blocks:** `const well = a.well(10, 20); const bag = a.bag();`. A piece is `{type, x, y, rot}` with types `I O T S Z J L`. Use `well.fits(p)`, `well.rotate(p, 1 | -1)` (with wall kicks, or `null`), `well.dropPosition(p)`, `well.place(p)` (false means game over), `well.clearLines()`, `well.cellsOf(p)` and `well.cells[y][x]` (null or a colour). `bag.next()` and `bag.peek(n)` give the next pieces; `a.tetrominoes[type].color` gives a piece's colour.
- **Scores:** `a.score.submit(n, detail?)`, `a.score.table()`, `a.score.best`, `a.score.draw(g, x, y, {rows, color, highlight, compact})`, and `a.player.name`.
- **Debugging:** `a.log(...)` prints to the console under the preview.

### Teletext (Mode 7)

`const page = a.teletext()` gives a 40×25 page. Draw it with `page.draw(g, a.t)` on a `mode: "teletext"` screen.

- **Writing:** `page.print(row, col, text)`, `page.center(row, text, codes)`, `page.banner(row, "BLUE")`, `page.cls()`.
- **Control codes** are characters: `a.tt.RED` to `a.tt.WHITE` for text colour, `a.tt.GFX_RED` onwards for graphics colour, `a.tt.DOUBLE`, `a.tt.NORMAL`, `a.tt.FLASH`, `a.tt.STEADY`, `a.tt.NEW_BG`, `a.tt.BLACK_BG`, `a.tt.SEPARATED`, `a.tt.CONTIGUOUS`, `a.tt.HOLD`, `a.tt.RELEASE`, `a.tt.CONCEAL`. Each takes one cell and shows as a space.
- **Mosaic graphics:** after a GFX code, `a.tt.block(tl, tr, ml, mr, bl, br)` makes a 2×3 block character from six on/off cells.

A line is built by concatenation: `page.print(3, 0, a.tt.YELLOW + "SCORE " + a.tt.WHITE + score)`.

### Classroom kit: `a.edu`

- **Maths questions:** `a.edu.question({kind, level, table, target})` returns `{text, answer, choices}`. `kind` is `add`, `sub`, `mul`, `div`, `bonds` (make the target), `times` (one `table`) or `mixed`; `level` runs 1-5.
- **Rules:** `a.edu.rules.multipleOf(3)`, `factorOf(24)`, `prime()`, `even()`, `odd()`, `square()`, `between(10, 20)` each return `{label, test(n)}`.
- **Word lists:** `a.edu.words.animals`, `colours`, `fruit`, `numbers`, `shapes`, `planets`, `year1`, `year2`, `year4`. `a.edu.passages.hare` and `.wind` are Aesop fables.
- **Typed answers:** `const box = a.edu.textbox({max, allow: /[0-9]/, upper})`. In `update`, `box.update(a.typed())` returns true on Return; `box.value`, `box.clear()`, `box.draw(g, x, y, c, a.frame, scale)`.
- **Adventure parser:** `a.edu.parse("get the lamp")` returns `{verb: "get", noun: "lamp"}`. It expands n/s/e/w/u/d and maps synonyms (take, grab, pick up → get).
- **Hidden text:** `const c = a.edu.cloze(text)`. `c.guess(word)` reveals every copy of a word and returns how many; `c.letter(ch)` reveals a letter; `c.hint(a.rnd)`. Read progress with `c.solved`, `c.progress`, `c.display(hidden)` and `c.lines(width, hidden)`.

## Composing music

A tune has a title, a tempo (beats a minute), a loop switch, and up to four channels, like the BBC Micro's sound chip (three tones and a noise) or a NES. Each channel has a wave, a volume (0-15), an envelope and its notes in MML:

| MML | Means |
| --- | --- |
| `c d e f g a b` | Notes; `+` or `#` sharp, `-` flat; then an optional length and dots: `c4`, `d+8.`, `e-16` |
| `r` | Rest (takes a length) |
| `&` | Tie into the next note of the same pitch: `c4&c8` |
| `o4`, `>`, `<` | Set the octave (0-8, middle C is `o4 c`), up one, down one |
| `l8` | Default length: 1 whole, 2 half, 4 quarter, 8, 16, 32, 64 (3, 6, 12, 24, 48 for triplets) |
| `v12` | Volume 0-15 from here on |
| `q6` | Gate: each note sounds for q/8 of its length (1-8; 8 is legato) |
| `@square` | Wave from here on: `square pulse25 pulse12 triangle saw sine noise periodic` |
| `[ ... ]3` | Repeat three times (nestable) |
| `\|`, spaces, newlines | Ignored; use them as bar lines |
| `; words` | Comment to the end of the line |

Envelopes: `organ` (held), `pluck`, `pad` (slow), `perc` (short hit) and `bell`. A song can also give `{a, d, s, r}` in seconds. On a `noise` channel the note sets the hiss: `o7 c` is a hi-hat, `o5 c` a snare, `o3 c` a kick. `periodic` is the BBC's buzzy periodic noise.

Keep looping tunes' channels the same length so they stay in step.

## RPC surface

Every write takes `by: {id, name}`, the signed-in account. Writes resolve to `{revision, ...}`, or to `{error}` when the rules refuse (a stale save, a bad song). Reads of an unknown id resolve to `{error}`.

| Method | Notes |
| --- | --- |
| `getView(viewerId)` | Arcade title, games (without code) with their top 10 scores, tunes (with songs), starter templates, the viewer's prefs |
| `getGame(gameId)` | One game with `source` and `version` |
| `getTune(tuneId)` | `{id, song, version}` |
| `getTemplates()` | Starter cartridges with their source |
| `getSummaryMarkdown()` | Games, scores and tunes |
| `setTitle({by, title})` | The arcade's name |
| `createGame({by, title?, template?, source?, description?})` | From a template id (default `blank`) or from `source`. Returns `{game}` |
| `saveGame({by, gameId, source, baseVersion?})` | Returns `{version}`. With `baseVersion`, refused if someone saved since |
| `updateGame({by, gameId, title?, description?})` | |
| `duplicateGame({by, gameId, title?})`, `resetGame({by, gameId})`, `deleteGame({by, gameId})`, `moveGame({by, gameId, toIndex})` | `resetGame` restores a starter's shipped code |
| `submitScore({by, gameId, score, detail?})` | Keeps each player's best. Returns `{rank, best, recorded}` |
| `clearScores({by, gameId})` | |
| `createTune({by, song?})`, `saveTune({by, tuneId, song, baseVersion?})`, `duplicateTune`, `deleteTune` | `song` is `{title, tempo, loop, channels: [{name, wave, volume, env, mml}]}` |
| `setPrefs({by, layout?, custom?, muted?, volume?})` | `layout`: `auto` (the game's own), `arcade`, `bbc`, `wasd` or `both`. `custom` is `{action: ["KeyCode"]}` |
| `subscribe(target, {clientId, viewerId})` | target has `update(view)`. Returns the view and pushes a new one after every change |
| `ping(clientId, viewerId)`, `unsubscribe(clientId)` | Heartbeat and leave |

**Exports:** a Markdown summary, every game's code, and each tune (up to 15) as WAV audio and as a MIDI file.

**Agents:**

- **Adapting a game:** read it with `getGame`, change its `source` following "Writing a game", and save with `saveGame` and the `baseVersion` you read. Tell the user to open the game's Code tab and press Run to try it.
- **Writing a tune:** use `createTune` or `saveTune` with MML channels. Check that looping channels are the same length in beats.
- **Scores:** never submit a score for a person.
- **New games:** prefer small, readable changes. Base them on the nearest starter (`getTemplates`), since players will read and adapt the code.

**Trust limits:**

- The server takes `by` from the caller, as every format here does.
- Game code runs in the viewer's sandboxed frame, with no network access and no platform access beyond the arcade API. Anyone who can edit the arcade can change what its games do.
- High scores are honest-client only.

## Adapting this gadget

Each gadget is an editable copy. Changes to a copy do not flow back to this source package.

- `client.js`: readable view entry with the `adapt` block near the top.
- `client.lib.js`: prebuilt UI, sync and rendering library, loaded before the entry.
- `server.js`: readable `Gadget` class and its RPC surface.
- `server.lib.js`: prebuilt core, validation and storage helpers.
- `README.md`: this guide. Never edit `*.lib.js`; rebuild source to change stable library code.

For content work, call `describeGadget()` through `describeBinding` and use the described
operations without editing files. Common operations: `getTemplates`, `getView`, `createGame`, `setTitle`.

The `adapt` fields are:

- `title`: browser document title; it does not rename stored content.
- `actionLabel`: accessible name of the extra-actions region.
- `styles`: extra CSS applied after the built-in styles.
- `actions`: `{ id, label, title?, run(app) }` commands shown at the bottom right. Buttons
  work with keyboard and touch; invalid or duplicate actions are ignored with a console warning.
- `onReady(app)`: called once after the initial view has loaded (or shown its connection state).
  Async actions and callbacks are supported; failures appear as a short status message.

`app` is a frozen handle with these RPC methods (same arguments and results as the server):
`getView`, `getTemplates`, `getGame`, `createGame`, `saveGame`, `updateGame`, `createTune`, `getTune`, `setTitle`. It also has `notify(text)` for a short live status message and
`refresh()` to reload data where the view supports it (otherwise it is a no-op).
The handle exposes no storage, approval tokens, or UI internals.

For example, inspect the current content:

```js
await env.Arcade.getTemplates();
```

To add a help action to your copy, change `actions` in `client.js`:

```js
actions: [{ id: "help", label: "About this view", run(app) {
  app.notify("Use the built-in controls to explore this arcade.");
} }],
```
