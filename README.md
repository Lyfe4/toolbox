# Patchbay

A developer toolbox that runs entirely in your browser. Patchbay collects the
small utilities you reach for every day — converters, encoders, formatters — and
lays them out as draggable modules on an infinite, pannable node canvas. Wire one
module's output into the next and a throwaway one-liner becomes a reusable
pipeline you can see. Nothing you paste ever leaves your machine.

## Principles

1. **Zero network.** Every tool runs client-side. No backend, no API, no
   telemetry, no CDN, no external fonts. Patchbay works offline. This is
   enforced by a Content-Security-Policy with `connect-src 'none'`
   (see [`public/_headers`](public/_headers)), not merely promised here.
2. **Accessibility is structural.** Full keyboard operability and screen-reader
   support, including on the canvas. Designed in from the start, not retrofitted.
3. **The code is the portfolio.** Strict types, no `any`, no suppressed errors,
   clear module boundaries, meaningful tests.

## Stack

| Concern     | Choice                                              |
| ----------- | --------------------------------------------------- |
| Build       | Vite                                                |
| UI          | React + TypeScript                                  |
| Routing     | TanStack Router (file-based, via its Vite plugin)   |
| State       | Zustand                                             |
| Styling     | CSS Modules + CSS custom properties (no framework)  |
| Headless UI | Radix Primitives (Tabs, Select, Tooltip, Toast)     |
| Type        | IBM Plex Mono + Archivo, self-hosted via Fontsource |
| Linting     | ESLint 9 flat config, typescript-eslint type-aware  |
| Formatting  | Prettier                                            |
| Testing     | Vitest + Testing Library + axe-core                 |
| Package mgr | pnpm                                                |

## Why local processing is a security property

Patchbay is not "local-first for convenience". Running in the tab is the
security model.

A developer toolbox is the kind of thing you paste secrets into: a JWT you are
debugging, a config file with a connection string, an API response with customer
records, a certificate. Every hosted equivalent of these tools receives all of
that on a server you do not control, where it may be logged, cached by a proxy,
retained in a backup, or exposed by a future breach. The only way to be sure
that does not happen is for the data never to leave the machine.

The guarantee is enforced rather than promised:

- `connect-src 'none'` in [`public/_headers`](public/_headers) means the browser
  itself refuses `fetch`, `XMLHttpRequest`, WebSocket, EventSource and
  `sendBeacon`. Application code _cannot_ phone home, whether by mistake, via a
  compromised dependency, or through injected script.
- `script-src` has no `'unsafe-inline'` and no `'unsafe-eval'`; the one inline
  bootstrap script is allowed by its sha256 hash.
- ESLint bans `eval`, `new Function`, `innerHTML`, `insertAdjacentHTML` and
  `dangerouslySetInnerHTML`, so pasted input can never become code or markup.
- Files are read with `FileReader`/`Blob`, size-capped before they are read, and
  identified by **magic bytes** rather than by the media type the OS guessed
  from the extension.
- Everything ships as static files, so there is no server-side component that
  could be compromised.

Turning any of these off is a visible change to a reviewed file, not a silent
regression.

## The canvas

`/` is the node canvas: tools as modules on an infinite pannable plane, wired
output-to-input. `/tools` is the same set of tools as a plain list. Neither is
a fallback for the other, and the header switches between them from the
keyboard on every page.

The canvas is hand-built - no React Flow. It is lazily loaded, so a visitor who
only ever opens `/tools` never downloads it.

### Keyboard map

Every canvas action works from the keyboard alone. Press `?` on the canvas for
this list; it is generated from the same array the canvas binds, so it cannot
drift.

| Keys                              | Action                                                                                                                                                                                                                                                                              |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Tab` / `Shift+Tab`               | Move between nodes, **top to bottom, then left to right**. Rows are bucketed into 64px bands first, so nodes that look like one row are treated as one row. The DOM is rendered in that order, so this is the browser's own Tab sequence rather than a hand-rolled roving tabindex. |
| `Arrows`                          | Move the selected nodes by 8px                                                                                                                                                                                                                                                      |
| `Shift+Arrows`                    | Move them by 64px                                                                                                                                                                                                                                                                   |
| `Shift+Enter`                     | Add the focused node to the selection                                                                                                                                                                                                                                               |
| `Ctrl/Cmd+A`                      | Select every node                                                                                                                                                                                                                                                                   |
| `Ctrl/Cmd+D`                      | Duplicate the selection                                                                                                                                                                                                                                                             |
| `Delete` / `Backspace`            | Delete the selection                                                                                                                                                                                                                                                                |
| `Ctrl/Cmd+Z` / `Ctrl/Cmd+Shift+Z` | Undo / redo                                                                                                                                                                                                                                                                         |
| `K`                               | Open the tool palette                                                                                                                                                                                                                                                               |
| `C`                               | Connect from the focused node, without dragging                                                                                                                                                                                                                                     |
| `Escape`                          | Cancel the current dialog, drag or connection                                                                                                                                                                                                                                       |
| `F`                               | Fit every node in view                                                                                                                                                                                                                                                              |
| `0`                               | Reset zoom to 100%                                                                                                                                                                                                                                                                  |
| `?`                               | Show the shortcut reference                                                                                                                                                                                                                                                         |
| `Space+drag`, middle-drag, scroll | Pan                                                                                                                                                                                                                                                                                 |
| `Ctrl+scroll`, pinch              | Zoom about the pointer                                                                                                                                                                                                                                                              |

**Connecting without a pointer:** focus a node, press `C`. If the tool has one
output the flow skips straight to picking a target; otherwise it asks which
output first. The target list contains exactly the ports a pointer drop would
be allowed to land on - the same `checkConnection` decides both - so type
mismatches, occupied inputs and cycles are never offered rather than being
offered and then refused.

The canvas is a `role="application"` region, which is what lets arrow keys and
single letters reach it instead of being swallowed by a screen reader's browse
mode. Each node is a focusable `role="group"` whose accessible name states its
tool, position, connection count, status and selection: _"Base64, at 280, 0,
1 connection, idle, selected"_.

Announcements are split deliberately. Movement and selection chatter goes to
the canvas's own polite live region; a refused connection also raises a toast,
so the reason reaches sighted users as well as screen-reader users rather than
only one of them.

Data types on ports are shown as **shapes**, not colours - square for text,
diamond for JSON, circle for bytes, and so on - because colour-only encoding
fails for colour-blind users and disappears entirely in forced-colors mode.
Wires and ports switch to `CanvasText` and `Highlight` there so they stay
visible.

### Undo/redo

A command history, not a stack of snapshots. Each mutation is a small object
holding just enough to do and to undo it - see
[`commands.ts`](src/features/canvas/commands.ts). Memory is proportional to the
change rather than to the graph, a drag or a run of arrow-key nudges coalesces
into one step, and each entry can describe itself ("Undid move 3 nodes") for
the live region. Snapshots could do none of those. The price is that every
command needs a correct inverse, which `graph.test.ts` checks by applying and
reverting each kind and asserting deep equality.

### Persistence

The graph is saved to `patchbay:graph:v1`, debounced so a drag writes once
rather than sixty times. It is validated with Zod on load and cross-checked
against the live tool registry; anything corrupt, older, or referring to a tool
that no longer exists produces an empty canvas and a message, never a crash.

## Adding a tool

A tool is one directory plus one manifest entry:

1. `src/tools/<id>/` containing the implementation, an options schema, tests and
   a README.
2. An entry in [`src/features/registry/manifest.ts`](src/features/registry/manifest.ts)
   and a matching line in [`loader.ts`](src/features/registry/loader.ts).

The manifest is eager (so the index, search and the canvas can reason about
tools without loading code) while implementations are behind dynamic imports, so
each tool is its own chunk. `registry.test.ts` loads every tool for real and
asserts the two descriptions agree, so they cannot drift.

Ports are checked at compile time: a tool's `run` signature is _derived from_
its declared ports, so a tool declaring a `bytes` input cannot be implemented
with a function that expects a string. See
[`types.ts`](src/features/registry/types.ts).

## Design system

The visual language is **instrument panel**: dense modular grids on an 8px
baseline, hairline borders instead of shadows, tight uppercase monospace
labels, near-monochrome palettes with one saturated accent, and mechanical
120-180ms motion. Radii never exceed 2px.

Tokens are CSS custom properties in three layers, and the boundary between them
is enforced by a test rather than by convention alone:

1. **Primitives** (`--raw-*`, [`src/styles/primitives.css`](src/styles/primitives.css))
   are the raw scale. Components must never name one.
2. **Semantic** (`--pb-*`, [`src/styles/semantic.css`](src/styles/semantic.css))
   names meanings - surface levels, ink levels, borders, signals, focus. This is
   the system's public API and the only layer components may use.
3. **Themes** ([`src/styles/themes.css`](src/styles/themes.css)) re-declare the
   themed half of layer 2 under a `[data-theme]` selector.

`src/styles/token-layering.test.ts` fails the build if a component stylesheet
reaches past the semantic layer or names a token that does not exist.

### Themes

Four presets, selected by a `data-theme` attribute on `<html>` and persisted to
`localStorage` under `patchbay:theme:v1`. With nothing stored, the app follows
`prefers-color-scheme`. A blocking inline script in `index.html` applies the
theme before first paint; its sha256 is computed from the built output and
injected into `script-src` by [`vite/plugins/csp-hash.ts`](vite/plugins/csp-hash.ts),
so the CSP never needs `unsafe-inline`.

| Preset      | Appearance | Accent         |
| ----------- | ---------- | -------------- |
| `graphite`  | Dark       | Amber          |
| `vellum`    | Light      | Vermilion      |
| `phosphor`  | Dark       | Phosphor green |
| `blueprint` | Dark       | Cyan           |

Every preset is held to WCAG AA by `src/styles/themes.contrast.test.ts`, which
resolves the real CSS and measures each pair: 4.5:1 for text, 3:1 for control
boundaries and the focus ring.

Run the app and visit [`/styleguide`](src/routes/styleguide.tsx) to see every
token and primitive, with contrast ratios measured live in the browser.

## Setup

Requires Node 22 (see [`.nvmrc`](.nvmrc)) and pnpm.

```bash
nvm use
corepack enable pnpm
pnpm install
pnpm dev
```

## Scripts

| Script               | Does                                      |
| -------------------- | ----------------------------------------- |
| `pnpm dev`           | Start the dev server                      |
| `pnpm build`         | Typecheck, then build to `dist/`          |
| `pnpm preview`       | Serve the production build locally        |
| `pnpm typecheck`     | Run `tsc` across both TS projects         |
| `pnpm lint`          | ESLint, zero warnings tolerated           |
| `pnpm lint:fix`      | ESLint with autofix                       |
| `pnpm format`        | Prettier, write                           |
| `pnpm format:check`  | Prettier, check only                      |
| `pnpm test`          | Run the test suite once                   |
| `pnpm test:watch`    | Run the test suite in watch mode          |
| `pnpm test:coverage` | Run the test suite with a coverage report |

## Layout

```
src/
  app/          router setup and root providers
  routes/       TanStack file-based routes
  features/     feature modules
    registry/   tool types, manifest, lazy loader, port compatibility
    execution/  Web Worker engine, message protocol, run state machine
    theme/      theming engine
    toolrunner/ the plain accessible tool UI
  tools/        individual tool implementations, one directory each
  components/   shared presentational components
  lib/          pure utilities
  styles/       global CSS and design tokens
  types/        shared type declarations
```

Fonts are copied out of the Fontsource packages into `public/fonts/` by
`pnpm fonts:sync` and committed, so they have stable paths that `index.html` can
preload. Only the latin subset and the weights actually used are shipped.

`src/routeTree.gen.ts` is generated by the TanStack Router plugin and is
committed, so a fresh clone typechecks before it has ever run a build.

## License

MIT — see [LICENSE](LICENSE).
