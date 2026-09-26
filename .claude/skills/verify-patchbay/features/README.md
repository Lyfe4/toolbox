# Patchbay verification map

This directory is the maintained source for verifying the user-facing behaviour of the deployed Patchbay. Read this index before driving the app, then use the matching feature file as the recipe.

## Baseline preconditions

- Target `https://patchbay-tools.netlify.app`, or another origin via `PATCHBAY_ORIGIN`. There is no local server to start.
- Run `node .claude/skills/verify-patchbay/doctor.mjs` first and require exit 0.
- Require `node_modules/playwright` (1.63.0, already a devDependency) and the browser binaries under `~/AppData/Local/ms-playwright`.
- Use a **fresh, non-persistent** browser context for every drive. `openBrowser()` in `harness.mjs` does this. A reused profile makes drives order-dependent and silently skips the cold open.
- Never drive a browser this run did not launch.

## Driving conventions

- Start every recipe from a fresh context unless its preconditions say otherwise.
- Prefer ARIA roles and accessible names, then `data-testid`. Never coordinates or tab order.
- Reach the canvas with `gotoCanvas(page, path)` — it navigates _and_ clears the cold open. Reach any other route with `gotoPage(page, path)`.
- After editing any canvas input, call `waitForPipelineIdle(page)`. The canvas has no Run button; it re-runs 300 ms after typing stops.
- On `/tools/<id>`, press the `Run` button and wait for the output textarea to become non-empty.
- Read the canvas readout with `readout(page)`, never raw `textContent` — the status spans run together as `0 nodes0 wiresidle100%`.
- Treat every quoted label and command here as literal.

## Proof and skip reporting

- Capture the user action _and_ the resulting state, not only the final screen.
- Where the feature computes something with a correct answer, compare against an independent oracle (Node `Buffer`, `crypto`, `zlib`) rather than against the page's own earlier value.
- Pair every negative assertion with a positive one. "Nothing is in error" passes on a graph that never ran.
- Verify persistence by reloading, not by reading the store you just wrote.
- Record the feature id and entry point used with every artefact. `drive.mjs` does this in `<feature>.json`.
- Report an unreachable path with the attempted action and the unmet precondition. Do not report a skipped entry point as verified through a different one.

## Features

| Id            | File                             | What it covers                                                   | Scripted? |
| ------------- | -------------------------------- | ---------------------------------------------------------------- | --------- |
| `canvas`      | [canvas.md](canvas.md)           | Cold open, palette, nodes, inspector, reactive execution         | yes       |
| `pipelines`   | [pipelines.md](pipelines.md)     | Wiring tools together, share links, data flowing down a chain    | yes       |
| `tools-index` | [tools-index.md](tools-index.md) | `/tools` — browsing, searching and filtering the eleven tools    | yes       |
| `tool-page`   | [tool-page.md](tool-page.md)     | `/tools/<id>` — running one tool standalone with an explicit Run | yes       |
| `appearance`  | [appearance.md](appearance.md)   | `/styleguide`, theme presets, the theme editor, persistence      | partly    |

Run any of them with `node .claude/skills/verify-patchbay/drive.mjs <id>`, or all five with `drive.mjs all`.

Deeper probes, run on their own when the feature they cover changes:

| Probe               | Covers                                                                                                                                                                                                         | Command                                                 |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `probe-search.mjs`  | `/tools` search across all four match sources, against a manifest-derived oracle                                                                                                                               | `node .claude/skills/verify-patchbay/probe-search.mjs`  |
| `probe-popover.mjs` | The Category select at 1440, 390, 320 and 568x320 and with no room below: the list's box against the viewport, the flip, the scroll lock, and every `securitypolicyviolation`, in chromium, firefox and webkit | `node .claude/skills/verify-patchbay/probe-popover.mjs` |

## Known uncovered ground

Named here rather than left to be discovered as a silent gap:

- **Per-tool correctness for every tool but two.** `drive.mjs` proves `base64` and `hash` against Node oracles. `diff`, `jwt-decode`, `regex-tester`, `color-convert`, `image-convert`, `video-remux`, `text-convert`, `timestamp` and `structured-data`'s full format matrix are covered by the unit suite and `pnpm check:browsers`, not here. Add a drive when one of them changes.
- **File input and download.** Every tool accepts a dropped file and offers Download; no drive exercises either. Use Playwright's `setInputFiles` and `waitForEvent('download')` when you need it.
- **Touch, pinch-zoom and narrow widths.** `pnpm check:browsers` covers these against `dist/`, including every Radix popover at phone widths (`checkPopovers`). Reproduce here with a `viewport` + `hasTouch` context if a mobile bug is reported. A console error seen at one width is a question about every width - `probe-popover.mjs` is the pattern.
- **The service worker / offline mode.** Fresh contexts have no registration, so no drive ever exercises the cached path.
