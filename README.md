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
  features/     feature modules (canvas, registry, ...)
  tools/        individual tool implementations
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
