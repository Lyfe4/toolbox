---
name: verify-patchbay
description: Drive the deployed Patchbay site (https://patchbay-tools.netlify.app) in a real browser with Playwright and capture evidence - node canvas, tool pipelines, the /tools index, individual tool pages, and theming. Reach for this to prove a user-facing change actually works on the live site, to confirm a deploy landed, to prove a fix on a local production build before it ships (PATCHBAY_ORIGIN), or whenever a claim about Patchbay's behaviour needs something stronger than the unit suite.
---

# Verify Patchbay

Patchbay is a fully offline, client-side developer toolbox: tools that run on an infinite node canvas, plus a plain `/tools` list for running one at a time. This skill drives **the deployed site** by default, and a local production build when `PATCHBAY_ORIGIN` points at one - see [Proving a fix before it ships](#proving-a-fix-before-it-ships). Never a dev server: it has no CSP.

**Target:** `https://patchbay-tools.netlify.app` — override with `PATCHBAY_ORIGIN` for a branch or deploy preview.

## Safety: why driving the live site is a read-only act

The live site has **no backend at all**. `public/_headers` ships `connect-src 'none'` and `form-action 'none'`, so application code physically cannot issue a fetch, XHR, WebSocket, or form submission — the browser refuses. Everything a drive creates (the saved graph, the cold-open flag, the chosen theme) lands in `localStorage` inside a Playwright context that is destroyed when the run ends.

So typing into a tool and watching it compute changes nothing outside a throwaway browser profile. **`doctor.mjs` re-checks both CSP directives on every run.** If that check ever fails, stop and re-read this section before driving anything — the premise has changed.

Do not use a persistent context or `storageState`. Every drive starts from a fresh context on purpose (see Drive).

## Launch

There is nothing to start. The target is already running; "launch" is one install check.

```bash
pnpm install          # only if node_modules is missing — Playwright 1.63.0 is already a devDependency
```

Browsers are installed at `~/AppData/Local/ms-playwright` (chromium, firefox, webkit). If a launch fails with a missing-executable error:

```bash
pnpm exec playwright install chromium
```

**Ready when:** `doctor.mjs` exits 0.

**No port, no `dist/`, no server** — against the deployed site. This matters: `pnpm check:browsers` owns `dist/` and port 4319, and this skill touches neither, so the two can run at the same time without a conflict.

### Proving a fix before it ships

The same drives run against a local production build, under the real `public/_headers`, because every script takes its origin from `PATCHBAY_ORIGIN`:

```bash
pnpm build
node scripts/serve-dist.mjs 4331          # any port but 4319, which check:browsers owns
PATCHBAY_ORIGIN=http://127.0.0.1:4331 node .claude/skills/verify-patchbay/doctor.mjs
PATCHBAY_ORIGIN=http://127.0.0.1:4331 node .claude/skills/verify-patchbay/drive.mjs all
```

Measured in round fifteen: the doctor passes (including "the deploy matches the local build") and all five drives pass. Stop the server by PID afterwards. **This mode does touch `dist/` and a port**, so do not run it while `check:browsers` is running or building, and do not rebuild while it is serving. What it cannot show is the deploy itself - Netlify's headers and the CDN - which is what the default origin is for.

## Doctor

One read-only check that answers "is this instance worth driving?" Run it first whenever anything looks off — it separates _the site is broken_ from _my script is wrong_ from _I am looking at a different build than my working tree_.

```bash
node .claude/skills/verify-patchbay/doctor.mjs
PATCHBAY_ORIGIN=https://deploy-preview-12--patchbay-tools.netlify.app node .claude/skills/verify-patchbay/doctor.mjs
```

It checks, in order:

1. The origin answers 200 and serves the Patchbay shell.
2. The CSP still carries `connect-src 'none'` and `form-action 'none'` (the safety premise above).
3. The hashed entry bundle, **compared against `dist/index.html` if a local build exists**. A mismatch is reported as a NOTE, not a failure — it means the deploy is older or newer than your working tree, which is the single most common reason a locally-verified change "is not on the site".
4. `/tools`, `/tools/base64`, `/styleguide`, `/sw.js`, `/site.webmanifest` all answer.
5. A real Chromium boots the canvas, its toolbar is usable, and the readout reports an empty graph.
6. No console errors during boot.

Exit 0 = worth driving. Evidence (including a screenshot and `doctor.json`) lands under `evidence/doctor-<stamp>/`.

## Drive

`drive.mjs` runs a mapped feature end to end and writes evidence. `harness.mjs` holds the shared helpers and is importable from any one-off script you write next to it.

```bash
node .claude/skills/verify-patchbay/drive.mjs <feature>            # canvas | pipelines | tools-index | tool-page | appearance
node .claude/skills/verify-patchbay/drive.mjs all
node .claude/skills/verify-patchbay/drive.mjs canvas --engine=webkit
```

Read [`features/README.md`](features/README.md) before driving. The map is the maintained list of what a proof has to cover; a run that exercises one convenient entry point is incomplete when the map names others.

### Stable handles in this app

Use these. Do not use coordinates or tab order.

| What                       | Handle                                                                                                                                                          |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Canvas root / plane / grid | `data-testid="canvas-root"`, `canvas-plane`, `canvas-grid`                                                                                                      |
| Canvas status readout      | `data-testid="canvas-readout"`                                                                                                                                  |
| A node                     | `data-testid="node-<nodeId>"`, `role="group"` with an `aria-label` naming the tool, its position, wires and state                                               |
| Palette                    | button `Add tool` → `[role="dialog"]` → `data-testid="dialog-option-<toolId>"`                                                                                  |
| Inspector                  | button `Inspector` (exact) → `data-testid="node-inspector"`, `inspector-body`, `inspector-handle`                                                               |
| Selection bar              | `data-testid="canvas-selection-bar"`                                                                                                                            |
| Tool page heading          | `role="heading"`, level 1, name = the tool's manifest `name` (`Base64`, `Hash`, `Colour`, `Text convert`, …)                                                    |
| A tool's text input        | `aria-label` = `"<Tool name> input"`, or `"<Tool name> <Port label> input"` when the tool has more than one input (`Diff Original input`, `Diff Changed input`) |
| A tool's output            | `aria-label` = `"<Tool name> <Output label>"` (`Base64 Result`, `Hash Digest`, `Structured data Converted`)                                                     |
| Tool index                 | heading `Every tool`, `data-testid="tool-count"`, cards are `a[href^="/tools/"]`                                                                                |
| Cold open                  | `#cold-open`, dismissed via `#cold-open-start`                                                                                                                  |

The tool ids, in the order the index lists them:

<!-- manifest:tool-ids:begin -->

`base64`, `structured-data`, `hash`, `jwt-decode`, `diff`, `regex-tester`, `color-convert`, `image-convert`, `video-remux`, `text-convert`, `timestamp`

<!-- manifest:tool-ids:end -->

### The two things that trip up every first attempt

**1. `/` opens behind the cold open.** A first-time visitor gets an introduction panel with `#root` inert behind it. Every fresh Playwright context is a first-time visitor. `gotoCanvas()` clicks through it the way a person does rather than seeding storage to skip it. Share links and `/tools/*` arrive with no panel at all.

**2. The canvas has no Run button; the tool page does.** The canvas re-runs the whole graph 300 ms after typing stops (`RERUN_DEBOUNCE_MS`, `src/features/execution/pipelineStore.ts`), so reading an output immediately after `fill()` reads the _previous_ value, and checking for "idle" right after typing sees a run that has not started. Use `waitForPipelineIdle(page)`. On `/tools/<id>`, press the `Run` button — that surface is deterministic, which makes it the right place to prove a tool's arithmetic.

## Evidence

Everything lands in `.claude/skills/verify-patchbay/evidence/<feature>-<ISO-stamp>/`:

- `run.log` — every check, pass or fail, with its detail.
- `NN-<name>.png` — numbered screenshots.
- `<feature>.json` — the readings, the oracle, and the verdicts.

`evidence/` is gitignored, so runs accumulate on disk without touching the repo. Everything else in this skill is committed; see Maintenance.

### Proof standards

- **Drive the real user path.** Click the palette, type in the textarea, press Run. Never reach into a Zustand store, call an exported function, or use a test-only hook. There are no test-only endpoints here and none should be added.
- **Capture the action and the resulting state**, not just the final screen. Each drive shoots before and after the interaction.
- **Check the answer against something other than itself.** Patchbay computes things with correct answers, so use them: the base64 and SHA-256 proofs compare the page's output to Node's `Buffer`/`crypto`. A screenshot of a plausible-looking string is not a proof.
- **Verify the side effect alongside what's visible.** The theme drive reads `localStorage` _and_ reloads the page to prove persistence, rather than trusting the attribute change.
- **A negative assertion needs a positive partner.** "No node is in error" passes just as happily on a graph that never ran. The pipelines drive asserts the graph starts _blocked_, then feeds it, then asserts a transformed value came out the far end.
- **Mocks:** none, and none are needed. The app has no external system to isolate — that is what `connect-src 'none'` means.

## Cleanup

Each drive closes the browser it opened, in a `finally`, including on failure. Nothing else is created:

- No processes beyond the Playwright browser this run launched. **Never kill by process name** — a stray `taskkill /im chrome.exe` would take out the user's own browser. `browser.close()` closes what this run started.
- No ports bound, no files outside `evidence/`, no `dist/` touched.
- Browser state dies with the ephemeral context.

**Cleanup never removes evidence.** `evidence/` is not touched by any script here; prune it by hand when it gets large.

If a run is interrupted before `finally`, a headless browser may survive. Find it by PID:

```bash
# Windows: list headless browsers started from the Playwright cache, then kill by PID
powershell -c "Get-CimInstance Win32_Process | Where-Object { \$_.ExecutablePath -like '*ms-playwright*' } | Select-Object ProcessId, ExecutablePath"
```

## Helpers

| File                | What it is                                                                                                        | How to run it                                                               |
| ------------------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `doctor.mjs`        | Read-only health + build-identity check                                                                           | `node .claude/skills/verify-patchbay/doctor.mjs`                            |
| `drive.mjs`         | Scripted proof for each mapped feature                                                                            | `node .claude/skills/verify-patchbay/drive.mjs <feature>\|all [--engine=…]` |
| `harness.mjs`       | Shared helpers — import it for one-off scripts                                                                    | see below                                                                   |
| `probe-search.mjs`  | `/tools` search against a manifest-derived oracle                                                                 | `node .claude/skills/verify-patchbay/probe-search.mjs`                      |
| `probe-popover.mjs` | Where a Radix popover lands at desktop and phone widths, and every CSP refusal while it is open, in three engines | `node .claude/skills/verify-patchbay/probe-popover.mjs [--engine=…]`        |

```js
// A one-off script, saved anywhere and run with `node <file>`.
// Import paths are relative to .claude/skills/verify-patchbay/.
import {
  openBrowser,
  gotoCanvas,
  addTool,
  setInspector,
  waitForPipelineIdle,
  readout,
  evidenceDir,
  shot,
  log,
  artefact,
  makeChecker,
} from './harness.mjs';

const dir = evidenceDir('scratch');
const check = makeChecker(dir);
const { browser, page, consoleErrors } = await openBrowser({ engine: 'chromium' });
try {
  await gotoCanvas(page); // navigates AND clears the cold open
  await addTool(page, 'regex-tester'); // palette → dialog-option-regex-tester
  await setInspector(page, true);
  await page.getByLabel('Regex input').fill('hello world');
  await waitForPipelineIdle(page); // the canvas has no Run button
  await shot(page, dir, 'result');
  check('something observable', true, await readout(page));
} finally {
  await browser.close(); // cleanup: close what you opened
}
```

## Maintenance

Keep `features/` honest as the app changes when routes, tools, or selectors move. (This used to say to run `/maintain-verification-skill`; no such command exists in this environment.)

**This skill is in the repository; its evidence is not.** `.gitignore` keeps the rest of `.claude/` out and un-ignores `.claude/skills/`, except for each skill's `evidence/`. Until round fifteen the whole of `.claude/` was ignored, so this file, the harness, the feature map and `KNOWN_CONSOLE_NOISE` lived on one machine and changed where no review could see them.

**Check that a new file here shows up in `git status`.** Claude Code's runtime keeps its own block of patterns in `.git/info/exclude`, which is per clone and not reviewable, and on this machine that block once held `.claude/skills/verify-*/`. That line hid this directory even after `.gitignore` stopped doing so. A file that is already committed stays tracked whatever an exclude says, but a new probe would be silently ignored. `git check-ignore -v <file>` names the rule that is hiding it.

This skill drives the deployed site by default, and **`pnpm check:browsers` runs all of it against `dist/`** - `doctor.mjs`, `drive.mjs all`, `probe-search.mjs` and `probe-popover.mjs`, in Firefox and WebKit, through `checkVerificationSkill`, which sets `PATCHBAY_ORIGIN` to its own server and `PATCHBAY_ENGINE` to the engine it is in. Each has to exit 0 and name that server in its output. Until round twenty-six nothing ran this skill between the days somebody remembered to - its probes crashed against every deploy for a round before anyone noticed - so a change here that breaks a script now fails the pre-commit run. `PATCHBAY_ENGINE` is also the way to run any script in another engine by hand; the default is Chromium. In WebKit a screenshot's own injected stylesheet is refused by the CSP and reported as a console error; `shot` takes back exactly that one, matched by its event.
