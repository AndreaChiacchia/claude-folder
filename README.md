# Claude-Folder

![version](https://img.shields.io/badge/version-0.1.3-blue)

A mod for the Claude Code CLI that folds each finished turn of the chat into one or two highlighted lines. A long session is mostly old turns you are done reading: the prompt, a screenful of tool calls, an answer, a "Baked for 41s". Claude-Folder keeps the prompt, the turn number, the first line of the answer, the tool count, the files it edited and the time, and hides the rest behind a click. The newest turn stays open until you send the next prompt, a click on any folded turn opens it again, each turn stands apart (a tinted band and a teal edge bar by default, or a card, alternating tints or a rule; setting `style`), and a gliding light runs over the folds so the transcript doesn't sit dead. When a turn ends, its last message (most of the time the summary) shimmers for a moment (setting `shimmer`).

```
▌ ▾ #11
▌ > test
▌   Listed 1 directory
▌ ● This test turn ran one tool call…
▌ ✻ Cooked for 7s

▌ ▸ #12 · test 2
▌   └ The "test" turn should have folded… · 3s

▌ ▸ #13 · test 3
▌   └ …
```

Every turn's header sits on a faint band (not visible in plain text): teal-slate when folded, lavender when open. An open turn's header shows only the marker and the turn number (`▾ #11`); the title, the answer and the stats appear on the folded lines, which start with the same marker and number (`▸ #12 · test 2`). The open turn keeps the bar down all its rows, an empty line starts each turn, and a click on a header's marker and number (`▸ #12` on a folded turn, `▾ #11` on an open one, in the same place) folds or opens the turn.

## Features

- **Folding, and when:** a finished turn folds when the next one starts (setting `foldWhen`), so the answer you are reading stays open until you send your next prompt. Or it folds 1.5 s after it ends. The running turn never folds. A turn started by a background agent or a notification folds like any other, titled by its message (`Message from @general-purpose`).
- **The header lines:** a folded turn is one, two or three lines (setting `lines`, two by default). The first line is the marker and the turn number, dim, then the prompt's first line in bold teal: `▸ #6 · fix the login`. The second line is the first line of the answer, then the tool count, the edited files and the time: `└ Fixed it. · 1 tool · edited auth.ts · 41s`. With one line the stats follow the title on the first line. With three lines the summary splits up: the answer's first line on a line of its own (`├ Fixed it.`), then the tools, the edited files by name and the time (`└ 1 tool · edited auth.ts · 41s`); a turn with no answer, or with no tools and no files, shows the two-line layout. An interrupted turn says `interrupted` in red, a failed one `error`. An open turn's header is one line in every style: the marker and `#6`, nothing else. With `lines: 3`, in the rail style:
  ```
  ▌ ▸ #6 · fix the login
  ▌   ├ Fixed it.
  ▌   └ 1 tool · edited auth.ts · 41s
  ```
- **Turn styles** (setting `style`): how turns stand apart.
  - **rail** (default): an empty line, then each turn's header on a faint band with a teal bar on its left edge: teal-slate when folded, lavender when open. An open turn keeps the bar down every one of its rows.
    ```
    ▌ ▸ #6 · fix the login
    ▌   └ Fixed it. · 1 tool · edited auth.ts · 41s
    ```
    Open:
    ```
    ▌ ▾ #6
    ```
  - **boxed:** a folded turn is a round-cornered card with its marker and number in the top border and its title and first answer line inside. An open turn sits wholly inside its card: the marker and the number in the top border, `│` down both sides of every row, and the bottom border under its last line.
    ```
    ╭─ ▸ #6 ───────────────────────╮
    │ fix the login                │
    │ └ Fixed it. · 1 tool · 41s   │
    ╰──────────────────────────────╯
    ```
    Open:
    ```
    ╭─ ▾ #6 ───────────────────────╮
    ```
  - **zebra:** folded turns alternate two faint tints (teal-slate and gray) and an open turn's header is lavender; each band has rounded ends `▐ … ▌`, with no bar and no extra lines.
    ```
    ▐▸ #6 · fix the login          ▌
    ▐  └ Fixed it. · 1 tool · 41s  ▌
    ```
    Open:
    ```
    ▐▾ #6                          ▌
    ```
  - **rules:** a thin line holding the marker, the turn number and, when folded, its time above each turn, and plain text lines under it. The line takes the card's colors: teal when folded, grey when open.
    ```
    ─── ▸ #6 · 41s ────────────────────
       fix the login
       └ Fixed it. · 1 tool · edited auth.ts
    ```
    Open: one line, with the marker and the number in it.
    ```
    ─── ▾ #6 ──────────────────────────
    ```
- **Edge bar** (setting `edge`, rail style): `▌` (default), `▎`, `│` or `|` for fonts without these glyphs.
- **Click to open or close** (fullscreen terminal): only a header's marker and number react, `▸ #6` folded and `▾ #6` open, in the same place in both states; the title, the answer line and the card do not. A click on `▸ #6` opens the turn, with its own rows back under a one-line header, and a click on the same spot (`▾ #6`) folds it again. The title, the answer line, the stats, the bars, a card's borders and sides, the rule and the gap do not react, and only the marker and number light on hover.
- **Folds survive a restart:** a session's turns are saved in the mod's own store, and come back after a restart or `claude --continue`/`--resume` with their numbers and fold states, so the history keeps its folding.
- **`/folder`:** the keyboard way. It toggles every finished turn, or opens or closes one by number, the last or all.
- **Markers** (setting `marker`): `▸ ▾` (default), `▹ ▿`, `+ −` or `> v` for fonts without the triangles. Every glyph is a single cell wide.
- **Motion** (setting `motion`): Lively (default), Subtle or Off. Only text and glyphs move, the band never does. One shimmer per action. Lively: a turn that folds or opens flips its marker with a gold flash and sends one light round its header's outline (the card is whole from its first frame); pointing at a header's marker and number sends one lap too, when the pointer arrives, never looping. A folded boxed card lights its whole border, an open boxed card its top line, a rail header its edge-bar cell; rules: the rule; zebra: the band's rounded ends. Subtle: the same with a softer flash and light, the light on a fold or an open only. Off: still lines (pointing still tints the marker and number and a click still folds or opens).
- **Last-message shimmer** (setting `shimmer`: `gold` by default, `text`, `teal`, `silver`, `lavender` or `off`): when a turn ends with an answer, its last message (the newest reply with text, unless a tool call came after it) fades to the preset's tint over 0.3 s, then glows once: it brightens to a lighter shade of the same hue over 0.9 s and dims back over 1.5 s, with nothing moving across the text. It holds the tint and fades back to its usual colors over the last 0.5 s: 3.7 s in all. `gold` goes from the text to gold and brightens once to a bright gold; `text` dims the text a little, brightens it back to full text color once and dims it again; `teal`, `silver` and `lavender` are those tints. Motion off turns the shimmer off (the engine draws the message), and subtle makes the glow half as bright. It ends at once when the turn folds or opens, and when the next turn starts. Under `foldWhen: finish` the fold waits for it (3.7 s after the turn instead of 1.5 s) when it applies. A message over 6,000 characters or 120 lines, a summary row, the last message of a turn that was interrupted or ended in an error, and a reply that a tool call follows keep the engine's drawing. While it plays the mod draws the message itself: code blocks are plain indented lines and tables are their raw `|` lines, and the message can reflow by a line when the engine's drawing returns.
- **Effort heat** (setting `heat`, `off` by default): a folded turn's frame warms with how much the turn did: teal for a quick one (under 3 tools and under 30 s), amber for a medium one, hot orange for a heavy one (10 tools or more, or 2 minutes or more). It colors the card's border in the boxed style, the rule in rules, the edge-bar cell of each header line in rail and the band's rounded ends in zebra; open headers and the bars of open turns keep their colors.
- **Failed turns:** a turn that was interrupted, ended in an error, or had at least one tool call fail (an error, or a refused permission) keeps a red `✗` right after its number, folded or open (`▸ #6 ✗ · fix the login`), and its fold runs its outline lap in red instead of the gliding light (with motion off the lap is gone, the `✗` stays).
- **Fold all on new turn** (setting `foldAll`, `off` by default): when a turn starts, every earlier turn folds, the ones you opened yourself included.
- **Focus mode** (`/folder focus`): folds every finished turn but the newest, and goes on doing so each time a turn starts. `/folder focus off` returns to the folding set in `/config`. It lasts for the session, across a reload of the mod, and is off after a restart.
- **No model call:** the summary is text the mod already has: the first line of the prompt, the first line of the answer, the tools Claude called, the files its edit tools named and the turn's duration.

## Install

**Claude Code CLI only.** You need Claude Code 2.1.306 or later, and the fullscreen renderer (`"tui": "fullscreen"` in your settings, or `CLAUDE_CODE_NO_FLICKER=1`): the main screen prints the transcript into the terminal's scrollback, where a finished turn can no longer be redrawn.

Load it in every session by adding the folder to `CLAUDE_CODE_PLUGIN_DIRS` in `~/.claude/settings.json` (separate several folders with `;` on Windows, `:` elsewhere):

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "C:\\Users\\<you>\\projects\\mods\\claudefolder"
  }
}
```

Or load it for a single session with `claude --plugin-dir <path to this folder>`.

## Usage

| Command | What it does |
|---|---|
| `/folder` | Toggle every finished turn: open them all when any is folded, else fold them all |
| `/folder open` | Open the newest folded turn |
| `/folder open last` | Open the last finished turn |
| `/folder open <n>` | Open turn `#n` |
| `/folder open all` | Open every finished turn |
| `/folder close` | Fold the newest open finished turn |
| `/folder close last` | Fold the last finished turn |
| `/folder close <n>` | Fold turn `#n` |
| `/folder close all` | Fold every finished turn |
| `/folder focus` | Fold every finished turn except the newest, and fold the earlier turns again at each new turn |
| `/folder focus off` | Stop focus mode |

A turn you open or close yourself never folds by itself again (unless `foldAll` or focus mode is on). On the main screen, `/folder` explains how to switch to the fullscreen view.

## Settings

Set them in `/config`, or in settings under `pluginConfigs.claudefolder`. A change applies at once.

| Setting | Values (default first) | What it does |
|---|---|---|
| `style` | `rail`, `boxed`, `zebra`, `rules` | how turns stand apart. rail: every turn's header on a faint band with a teal bar on its left edge, teal-slate when folded and lavender when open, and an open turn keeps the bar down every row / boxed: a folded turn is a round-cornered card with its marker and number in the top border (`╭─ ▸ #3 ─╮`) and its title and first answer line inside, and an open turn sits wholly inside its card, with the marker and the number in the top border / zebra: folded turns alternate two faint tints and an open header is lavender, each band with rounded ends `▐ ▌`, no bar and no extra lines / rules: a thin line holding the marker, the number and the time above each turn (teal when folded, one grey line with `▾ #n` when open). A folded header starts with the marker and the number in every style (`▸ #3 · title` in rail and zebra) |
| `foldWhen` | `next`, `finish` | next: a finished turn folds when the next one starts, so the answer you are reading stays open until you send your next prompt / finish: a turn folds 1.5 s after it ends. The running turn never folds; a click on a folded turn, or `/folder`, opens it again |
| `lines` | `2`, `1`, `3` | 2: the turn number and the prompt on the first line, then the first line of the answer with the tool count, the edited files and the time / 1: the first line alone, with the tools, files and time after the title / 3: the turn number and the prompt, then the first line of the answer on a line of its own, then the tools, the edited files by name and the time |
| `marker` | `triangles`, `hollow`, `plus`, `ascii` | the glyph before each turn, folded then open. triangles: `▸ ▾` / hollow: `▹ ▿` / plus: `+ −` / ascii: `> v`, for fonts without these glyphs |
| `edge` | `half`, `thin`, `line`, `ascii` | the bar on the left edge of a turn in the rail style. half: `▌` / thin: `▎` / line: `│` / ascii: `\|`, for fonts without these glyphs |
| `motion` | `lively`, `subtle`, `off` | lively: a turn that folds or opens flips its marker with a gold flash and sends one light round its header's outline (a folded card's whole border, an open card's top line, the header's edge-bar cell, the rule, a zebra band's ends); pointing at a header's marker and number sends one lap too / subtle: the same with a softer flash and light, the light on a fold or an open only / off: still lines; pointing still highlights the marker and number and a click still folds or opens |
| `shimmer` | `gold`, `text`, `teal`, `silver`, `lavender`, `off` | when a turn ends, its last message takes a tint, brightens once to a lighter shade and dims back, holds the tint, then returns to its usual colors after 3.7 s. gold: gold that brightens to a bright gold / text: the text dims a little, brightens back to full text color once and dims again / teal, silver, lavender: those tints / off: none. Motion off turns it off too; subtle makes the glow half as bright. A fold, an open or the next turn ends it |
| `heat` | `off`, `on` | on: a folded turn's frame (the card's border, the rule, the rail's edge bar, the zebra band's ends) is teal for a quick turn (under 3 tools and 30 s), amber, or hot orange for a heavy one (10 tools or more, or 2 minutes or more) / off: the usual colors |
| `foldAll` | `off`, `on` | on: when a turn starts, every earlier turn folds, the ones you opened yourself included / off: a turn you opened or closed yourself keeps its state. `/folder focus` does the same for one session |

## How it works

- **Which rows belong to a turn:** a `session.append` hook sees every row of the main conversation as it is stored, by its uuid, and files it (with the tool calls and results it holds) under the turn that runs, or, while idle, under the starter that waits for the next turn: a typed prompt, but also a background agent's hand-back, a notification or a queued command. A notification or a hand-back the engine records without running a turn for it (the mod knows when your next prompt or command comes instead) joins the turn before it: it draws inside that turn's card, which then closes under it, and folds with it; until then it draws as the engine does. The engine draws a prompt or answer row under its uuid with the last group (12 hex digits) zeroed, so rows are keyed by the first four groups of a uuid on both sides (`rowKeyOf`: appended ids and the `requestId` of a draw), and a `ui.render` hook finds each row's turn by that key. Subagent rows are left out. The engine leaves a turn's duration line out when background agents are still running as before (a hand-back or a notification turn); the mod counts those agents the same way, from the Agent calls and their task notifications, and closes that card under its last drawn row instead.
- **The fold:** the row that draws a turn's header draws the folded lines in place of the engine's row. That row is the turn's starter row: your prompt; for a background agent's hand-back, its message line (`Message from @general-purpose`); for a notification, its notification line; a turn with none, or one started by a slash command or a skill (the engine draws its `> /name args` line itself, where no hook reaches), takes its first reply (or its first tool call, which may sit inside a grouped run of calls), titled with the command. The turn's other rows (answers, tool calls and results, the duration line) draw nothing, but only after the header row has been drawn on screen: a turn never vanishes. Each row reads its turn's state while it draws, so a change to a turn (its end, a fold, a click, `/folder`) redraws exactly that turn's rows. The mod asks the screen to redraw every row only when it loads, when the header module fails, and once when a folded turn's header first appears after some of its rows had drawn open, and once when the view switches to or from ctrl+o or `--verbose`, which the turns' duration lines tell. A row you click open to see its details (a command's output, an agent's message) is drawn like the turn's other rows: inside its bar or card while the turn is open, hidden while it is folded. Nothing the mod does changes a stored row or what the model reads.
- **The header model:** each header is built as a model of rows by style. A header is drawn by a small surface module (`hooks/headerClient.tsx`) that sees the pointer: it draws the rows the mod composes, cut to exactly the viewport's width (the edge bar and marker, the title or the second line, the spaces that carry the band to the right edge), so no line wraps, and only the header's marker and number react to the pointer (they tint on hover, a press released on them toggles the turn). The outline light runs on the module's own frame clock, and the module draws the marker's flip itself from the header's rest cells. If the module fails, the header falls back to plain Text with Buttons over the text, drawn at rest, without the outline light.
- **The rail and the card of an open turn:** in the rail style every row of an open finished turn is wrapped in a box shifted two columns right, holding an absolutely placed one-column box with the edge glyph on many lines, clipped to the row's real height, so the bar is unbroken from the header through the last row. In the boxed style the same mechanism draws `│` at both edges of a card-wide box that holds the row two columns in; the card closes under the turn's duration line, or under its last line when it has none. Each bar starts at the row's first line on screen, which the engine reports for every row (the lines scrolled away above the viewport): the engine places a box that would begin above the screen at the screen's top line with its full height, so a bar begun above the screen would run past its row onto the rows below. A row drawn outside the viewport draws no bar.
- **The theme:** the tints come from a dark or a light palette, chosen once when the mod loads from the `theme` setting in your settings.
- **Painting:** nothing moves by redrawing rows. A fold or an unfold draws the folded or opened header once, complete, with a small descriptor of the effect (the marker flip and one lap of the outline light) and how old it is; the header module plays it on its own 20-frames-a-second clock, which runs only while an effect or a light plays, so the card is whole from its first frame and the mod writes no state while it plays. The outline light is the module's own too, about 3 cells per 50 ms, and runs one lap per fold or open and one lap when the pointer arrives on the marker and number.- **The saved session:** the engine wipes the mod's state when a session ends, so each session's turns (their members, and the keys of every row filed under each) are also written to the mod's own store (`$.store`) under `session:<sessionId>`, a moment after a change (a row filed while a turn runs within 10 s) and again when the session ends; each session's entry stays under 400,000 characters, its oldest turns dropped first, and a store that is full drops all but the two newest other sessions and saves again. At `session.start` (or at the first hook of a process that holds no turns) the mod reads that entry back: the members and the order return to the state, the row keys go into one in-memory map the draw consults when a row has no state of its own, and a turn saved while it ran comes back interrupted. It cannot rebuild turns from the transcript instead: the history the engine hands a mod says which rows exist, not which drawn row belongs to which turn.
- **The shimmer:** the tracker notes, as rows are appended, the running turn's newest response row with text (cleared by a tool call after it). When the turn completes with an answer, one write to the turn sets its `shine` field (that row and the time) and a 3.7 s timer starts. The row's `ui.render` draw then hands the message, as lines of runs, to a second surface module (`hooks/shineClient.tsx`) in place of the engine's drawing (a Text cannot recolor the engine's own node), which wraps it to its region and draws the tint and the glow on its own 20-frames-a-second clock (it repaints only when the color changes, so not while the tint holds), counted from the age the plugin hands it. A fold or an open (the turn's `changedAt` moves past the start) stops the draw at once; at the end, or when the next turn starts, one write clears the field and the row draws the engine's message again. No redraw is asked for. If the module fails, every last message is drawn by the engine from then on; the headers are untouched.
- **No model call** and no write outside the mod's own state and store.

## Limitations

- **Fullscreen only.** On the main screen the transcript is already printed into the scrollback and cannot fold after the fact; every hook then passes through.
- **A session's turns are saved in the mod's own store** and come back after a restart or `--continue`/`--resume`, with their numbers and fold states. Sessions from before this version, turns older than the newest 200 of a session, and sessions beyond the 8 most recent stay plain. A very long session keeps only its newest turns that fit in its share of the store. After `/compact` the earlier rows the engine still draws keep folding; rows it no longer draws are just absent. Two windows open on the same session at once can overwrite each other's save, and a turn that was running when Claude Code stopped comes back marked as interrupted.
- **Rows from before the mod loaded** (a conversation that was running when the mod was added) and subagent transcripts never fold.
- **Lines no mod can hook** (some notices and hook output) stay visible inside a folded turn.
- **ctrl+o and `--verbose` show everything.** The mod reads the view from the turns' duration lines and redraws every row once when it changes, so for a moment after ctrl+o the rows above the first duration line can still be folded or framed.
- **A row you click open stays open.** Claude Code keeps a row you clicked open (a command's output, an agent's message) open by itself, and no mod can close it: when its turn folds the row hides with it, and it is open again when the turn opens. The engine also draws a highlighted blank line under a row you clicked open, outside the row where no hook reaches; it stays under the folded card until you open the turn and click the row again to close it.
- **The summary is plain:** the first line of the prompt and the first line of the answer, cut to fit. A command turn shows `/name args`.
- **The tints assume a dark theme** unless the `theme` setting starts with `light`; any other value (dark, daltonized, auto, unset) gets the dark tints.
- **During the shimmer the last message is drawn by the mod, not the engine:** tables and code blocks are plain, and the message can reflow by a line when the engine's drawing returns.
- **Hovering lights a header's marker and number** (only those are clickable; the title, the answer, bars, card sides and borders neither light nor click); it does not change the band.
- **A turn whose header row never draws stays open;** turn numbers can skip a turn that drew nothing.
- **In the rail style the rows of an open finished turn are drawn two columns further right** than the engine draws them, and in the boxed style two columns inside the card; the rail style adds one empty line per finished turn.
- **An open card can stay open at the bottom** when its last line is one no mod can draw (an interrupt notice) or a tool call with no result line.
- **Pending background workflows** are not counted: a turn that ends while a workflow runs can keep its card open at the bottom. Turns saved before this version keep the closer they were saved with.
- **The running turn shows no bar** until it ends: its rows are drawn before they are stored, so a bar there would appear late and shift each row while you read it.
- **A prompt's image line** (`⎿ [Image #3]`) is drawn by the engine beside the prompt, where no mod can reach it: it stays visible under a folded card, and an open card's sides skip that line.
- **While you scroll,** a bar at the top edge can run a line past its row for a moment, until the engine reports the row's new position.
- **A slash command's line stays above its card:** a turn started by a slash command or a skill folds onto its first reply, titled with the command; the engine draws the `> /name args` line itself, with no render hook, so that line stays visible above the folded card. A turn saved before this version with its header on that line stays open.

## Troubleshooting

If a turn does not fold, start Claude Code with `claude --debug-file <path>` and look for the `claudefolder:` lines: they say how each row was filed, when a turn started and ended, when the screen was asked to redraw (`invalidate load|collapse|moved|fault|view`), when the view switches (`view expanded|normal`), each click (`toggle`) and each `/folder`, and how each row was drawn.

## Development

```
npx -y -p typescript@5.6.3 tsc -p .
claude plugin validate .
claude plugin test .
```

| Path | Contents |
|---|---|
| `hooks/register.tsx` | the mod: the hooks, the header and row trees, `/folder` |
| `hooks/headerClient.tsx` | the surface module: the header (rows, pointer, fold effect, outline light) |
| `hooks/shineClient.tsx` | the shimmer's surface module: the last message's lines wrapped, tinted and glowing once |
| `hooks/shine.ts` | the last message as shimmer lines (a small markdown reading: headings, lists, quotes, code, tables, rules, emphasis) and the module's props |
| `hooks/tracker.ts` | which turn each appended row belongs to, its header row, the row an open card closes under, and the row keys kept per turn for the saved session |
| `hooks/summary.ts` | the title, the reply and the stats |
| `hooks/header.ts` | the per-style header model: rows of cells and text parts, the pressable ranges, the outline path, the open card's bottom |
| `hooks/motion.ts` | the frame constants, the levels, and the rest cells and text of a header (the reference the module's effects are tested against) |
| `hooks/cells.ts` | colors and palettes, glyphs, blending, the cell encoding |
| `hooks/settings.ts` | the settings |
| `types/index.d.ts` | the mod's shared types and its state contract |
| `tests/` | tests for the summary, the tracker, the header model, the motion, the module's effects (`client.test.ts`), the shimmer (`shine.test.ts`), the folded rows, the engine's real event order (`live.test.tsx`) and the saved session (`persist.test.tsx`) |

## License

MIT, see [LICENSE](LICENSE).
