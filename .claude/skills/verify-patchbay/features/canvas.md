# Canvas

The canvas at `/` is Patchbay's main surface: an infinite, pannable plane where a user adds tools as nodes, types into them, and watches them compute. A first visit is met by an introduction panel; after that the canvas remembers the graph between visits.

## Sub-features

- `cold-open` — the introduction panel that gates a first visit, and the preset links in it.
- `palette` — the `Add tool` command dialog that puts a node on the plane.
- `node` — a tool on the canvas: its face, its ports, its status LED and its result summary.
- `inspector` — the right-hand rail where a selected node's input, options and output live.
- `reactive-run` — editing an input re-runs the graph automatically after a typing pause.
- `readout` — the chrome that reports node count, wire count, running/idle and zoom.
- `selection` — the bar offering Select all / Duplicate / Delete for what is selected.
- `persistence` — the graph is saved to `localStorage` and restored on reload.

## How to get to it (user POV)

- Open `https://patchbay-tools.netlify.app/` — the canvas is the home page.
- Click `HOME` in the masthead from any other route.
- Follow one of the four preset links in the cold open (three install a pipeline; the fourth goes to `/tools`).
- Open a share link (`/?p=<payload>`) — arrives straight on the canvas with a graph already installed and **no** cold open.

## Driving it with Playwright

**Preconditions:** doctor exits 0; fresh non-persistent context.

- **Land on a first visit** → `await page.goto(ORIGIN + '/', { waitUntil: 'networkidle' })` → `page.locator('#cold-open')` has count 1 and `#root` is inert.
- **Dismiss the introduction** → `await gotoCanvas(page)` (clicks `#cold-open-start`, waits for `#cold-open` to detach) → `data-testid="canvas-root"` is present; `readout(page)` returns `0 nodes · 0 wires · idle · 100%`.
- **Add a tool** → `await addTool(page, 'hash')` (clicks `Add tool`, waits for `[role="dialog"]`, clicks `dialog-option-hash`, waits for the dialog to detach) → readout starts `1 node`; focus lands on the new node (`document.activeElement` carries `data-node-id`).
- **Open the inspector** → `await setInspector(page, true)` → `data-testid="node-inspector"` attaches. It starts **closed** on a first visit; do not assume it is open.
- **Type an input** → `await page.getByLabel('Hash input').fill('the quick brown fox')` → the node face updates its byte count.
- **Wait for the run** → `await waitForPipelineIdle(page)` → the readout's status span reads `idle` after having gone `running`.
- **Read the result** → `await page.getByRole('textbox', { name: 'Hash Digest' }).inputValue()`.
- **Prove it against an oracle** → `createHash('sha256').update(input, 'utf8').digest('hex')` must equal the digest, case-insensitively. This is the check that makes the drive a proof rather than a screenshot.

Scripted as `driveCanvas` in `drive.mjs`. Run: `node .claude/skills/verify-patchbay/drive.mjs canvas`.

## Gotchas

- **The cold open is not a test artefact.** Every fresh context is a first-time visitor, so `/` always shows it. Do not seed `patchbay:cold-open:v1` to skip it — walking through it is part of what is being verified, and the flag's name is an implementation detail that can change.
- **There is no Run button on the canvas.** Reading an output immediately after `fill()` returns the previous value. Checking the readout immediately after `fill()` sees `idle` because the 300 ms debounce has not fired yet — `waitForPipelineIdle` waits out the debounce _before_ it looks.
- **The readout spans have no whitespace between them.** Raw `textContent` is `1 node0 wiresidle100%`, which defeats `/\b0 nodes\b/` and `/\brunning\b/` alike. Use `readout(page)`.
- **Single-input tools are labelled `"<Tool> input"`, not `"<Tool> <Port> input"`.** Regex's port is called `Subject` but its textarea is `Regex input`, because naming the port only happens when a tool has more than one. `Diff` has two, so it is `Diff Original input` / `Diff Changed input`.
- **Wheel zoom stalls in a hidden browser pane.** If you need a different zoom level, press `+` / `-` on the keyboard and read the readout percentage; do not drive `page.mouse.wheel` and wait on a rAF that may never run.
- **`image-convert` and `video-remux` need real engine features** (OffscreenCanvas, media decode). WebKit under Playwright cannot play media, so a playback assertion there fails for harness reasons, not app reasons.
