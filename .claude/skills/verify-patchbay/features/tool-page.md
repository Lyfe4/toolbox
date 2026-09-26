# Tool page

`/tools/<id>` runs one tool on its own, away from the canvas: paste input, set options, press Run, read the output. Unlike the canvas this surface is **not** reactive — nothing computes until Run is pressed — which makes it the right place to prove a tool's arithmetic.

## Sub-features

- `input` — a textarea per input port, or a file drop for tools that take bytes.
- `options` — the tool's settings, some of which appear conditionally (encoding, case, target format, mode).
- `run` — the explicit Run button; `Ctrl`/`Cmd`+`Enter` in the input does the same.
- `output` — one panel per output port, with Copy and Download.
- `views` — tool-specific renderings: a diff table, a colour swatch, a JWT breakdown, a regex match list, an image preview.
- `report` — a `report`-presentation port explaining what the run detected or lost.
- `progress` — a progress bar for long-running tools (image, video).
- `not-found` — an unknown id renders the app's 404, not a blank page.

## How to get to it (user POV)

- Open `https://patchbay-tools.netlify.app/tools/base64` (or any of the eleven ids) directly.
- Click a card on `/tools`.
- Deep-link from anywhere — the SPA fallback serves the app and the router resolves the id.

## Driving it with Playwright

**Preconditions:** doctor exits 0; fresh non-persistent context. No cold open on this route.

- **Land on a tool** → `await gotoPage(page, '/tools/base64')` → `page.getByRole('heading', { level: 1, name: 'Base64' })` resolves. The heading name is the manifest `name`, which is **not** always the id: `jwt-decode` → `JWT`, `color-convert` → `Colour`, `regex-tester` → `Regex`, `image-convert` → `Image`, `video-remux` → `Video`.
- **Type input** → `await page.getByLabel('Base64 input').fill(text)`. Two-input tools name the port: `Diff Original input`, `Diff Changed input`.
- **Set an option** → `await page.getByRole('combobox', { name: 'Target format' }).click()` then `await page.getByRole('option', { name: 'YAML', exact: true }).click()`. Radix, not native — `selectOption()` does nothing.
- **Run** → `await page.getByRole('button', { name: 'Run' }).click()`.
- **Wait for output** → poll until the output textarea's `value` is non-empty. Do not `waitForTimeout` and hope; worker startup is variable.
- **Read output** → `await page.getByRole('textbox', { name: 'Base64 Result' }).inputValue()`. The name is `"<Tool name> <Output port label>"` — `Hash Digest`, `Structured data Converted`, `Diff Unified patch`.
- **Prove it against an oracle** → `Buffer.from(input, 'utf8').toString('base64')` must equal the output exactly.
- **Alternative views** → `await page.getByRole('button', { name: 'Raw' }).click()` switches a rendered view back to its raw payload.

Scripted as `driveToolPage` in `drive.mjs` (base64 encode). Run: `node .claude/skills/verify-patchbay/drive.mjs tool-page`.

## Gotchas

- **Nothing runs until Run is pressed.** Reading the output right after `fill()` reads an empty box. This is the opposite of the canvas, and mixing the two up is the most common way a drive here produces a confusing empty result.
- **The heading is the tool's `name`, not its id.** Waiting for a heading called `Jwt-decode` times out forever.
- **Single-input tools drop the port name from the label.** `Regex input`, not `Regex Subject input` — even though the port is called `Subject`. The port name only appears when a tool has more than one input.
- **Options can appear and disappear.** Several tools show options only in certain modes (see `conditionalOptions.test.tsx`). Set the mode first, then the option that depends on it.
- **`image-convert` and `video-remux` are slow and engine-dependent.** They need OffscreenCanvas and real media handling; budget a long timeout and prefer Chromium. WebKit under Playwright cannot play media at all, so any playback assertion there is a harness limit, not an app fault.
- **An unknown id returns HTTP 200, not 404** — the SPA fallback serves `index.html` and the router renders the in-app 404. Assert on the rendered NotFound view, never on the status code.
- **Only `base64` and `hash` have oracle-backed drives.** The other eight are unit-tested but unproven here; see the "Known uncovered ground" section of [README.md](README.md).
