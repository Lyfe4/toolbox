# Patchbay

A developer toolbox — encoders, hashes, formatters, diff, regex, colour, image
conversion — that runs entirely in your browser. Wire the tools together on a
node canvas and a throwaway one-liner becomes a pipeline you can see, share and
re-run, without anything you paste ever leaving the page.

- [The tools](#the-tools)
- [The zero-network guarantee](#the-zero-network-guarantee)
- [Architecture](#architecture)
- [Accessibility](#accessibility)
- [Testing](#testing)
- [Performance](#performance)
- [Adding a tool](#adding-a-tool)
- [Setup](#setup)
- [Browser support](#browser-support)

## The tools

| Tool                | Does                                                                        |
| ------------------- | --------------------------------------------------------------------------- |
| **Base64**          | Encode text or files, decode back to bytes.                                 |
| **Structured data** | JSON, YAML, CSV and TSV, with auto-detection.                               |
| **Hash**            | MD5 and the SHA family, over text or files.                                 |
| **JWT**             | Decode a token, and verify it when you supply the key.                      |
| **Diff**            | Compare two texts, with word-level highlighting.                            |
| **Regex**           | Test a pattern, with groups and replacement.                                |
| **Colour**          | Convert hex, `rgb()`, `hsl()` and `oklch()`, with contrast checks.          |
| **Image**           | Convert and resize between PNG, JPEG and WebP.                              |
| **Text convert**    | Markdown, HTML and plain text, with a sandboxed preview and rich-text copy. |

Each has its own README next to the code, which is where the interesting parts
are written down: why [JWT](src/tools/jwt-decode/README.md) refuses
`alg: none`, how [Regex](src/tools/regex-tester/README.md) survives a
catastrophically backtracking pattern, what stops
[Image](src/tools/image-convert/README.md) being killed by a decompression
bomb, and why [Text convert](src/tools/text-convert/README.md) round-trips are
checked for _meaning_ rather than byte equality.

**Rich text** is the one thing not deducible from the options: it is not a
target format. Set Text convert's target to **HTML**, run, and press **Copy as
rich text** on the Rendered HTML output — it pastes into Word, Google Docs or
an email with the formatting intact, where **Copy HTML** beside it gives you
the markup. `Plain text (strip formatting)` is the opposite: it removes the
formatting rather than carrying it.

`/` is the node canvas; `/tools` is the same set as a plain list. Neither is a
fallback for the other.

## The zero-network guarantee

A developer toolbox is a thing you paste secrets into: a JWT you are debugging,
a config with a connection string, an API response full of customer records.
Every hosted equivalent receives all of that on a server you do not control.
Patchbay's answer is that the data never moves — and the point of this section
is that the browser is what stops it, not us.

**`connect-src 'none'`.** Every document is served with a Content-Security-Policy
that removes the ability to make a network request at all. `fetch`,
`XMLHttpRequest`, `WebSocket`, `EventSource` and `navigator.sendBeacon` are
refused below the JavaScript, in the network stack. Application code cannot
phone home — not by mistake, not through a compromised dependency, not through
injected script.

That is the headline, and here is the rest of the enforcement:

| Mechanism                                                                                                                                          | Where                                                  |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `connect-src 'none'`, `object-src 'none'`, `base-uri 'self'`, `form-action 'none'`, `frame-ancestors 'none'`                                       | [`public/_headers`](public/_headers)                   |
| `script-src` with no `'unsafe-inline'` and no `'unsafe-eval'` — the one inline script is allowed by its sha256, computed from the **built** output | [`vite/plugins/csp-hash.ts`](vite/plugins/csp-hash.ts) |
| Fonts self-hosted from `/fonts/`. No Google Fonts, no CDN, no icon font, no emoji                                                                  | [`scripts/sync-fonts.js`](scripts/sync-fonts.js)       |
| `eval`, `new Function`, `innerHTML`, `insertAdjacentHTML`, `dangerouslySetInnerHTML` banned by lint rule                                           | [`eslint.config.js`](eslint.config.js)                 |
| No analytics, no telemetry, no error reporting, no fonts CDN, no third party of any kind                                                           | `package.json` has no such dependency                  |
| Share links carry pipeline **structure only** — never your input, asserted by test                                                                 | `share.test.ts`                                        |

**Verified in-browser, not asserted here.** `pnpm check:browsers` drives the
production build in Firefox and WebKit under the real headers and fails if a
single request leaves the origin. The same harness confirms the app is fully
functional offline after first load.

The guarantee has exactly one documented exception — the service worker is
served with `connect-src 'self'` so it can populate its own cache, and can
reach no other origin. That, and everything this architecture explicitly does
**not** protect you from — a compromised dependency, a malicious browser
extension — is written down in [SECURITY.md](SECURITY.md).

## Architecture

Full detail in [docs/architecture.md](docs/architecture.md).

**Typed tool registry, split in two.** An eager manifest holds every tool's id,
ports, limits and search terms; implementations sit behind dynamic imports, one
chunk each. The canvas, the search box and the compatibility checks reason
about tools without loading a line of their code. A test loads every
implementation for real and asserts the two halves agree, so they cannot drift.

**Ports are a compile-time type system.** A tool's `run` signature is _derived
from_ its declared ports, so a tool declaring a `bytes` input cannot be
implemented with a function expecting a string, and a port accepting
`['text', 'bytes']` forces the implementation to narrow on the tag before
touching either payload. Connection legality on the canvas is the same
information at runtime — the drag preview, the keyboard connect flow and the
share-link validator all ask one `checkConnection`.

**Worker execution.** Heavy tools run off the main thread behind a small tagged
message protocol. Binary payloads are `Uint8Array` or `Blob` — never base64
strings internally — and buffers are transferred rather than copied. Execution
never throws across the boundary: a tool returns a result describing success or
failure, and bad input is a result, not an exception.

**Incremental caching keyed on upstream cache keys, not values.** Each node's
key is built from its tool, its options, its typed input, and the _keys_ of the
nodes feeding it.

> Why it matters: comparing upstream keys is O(1) whatever the data is, so a
> 30 MB decoded file never has to be hashed to know whether it changed. Keying
> on values would make every run cost a pass over every intermediate result —
> the cache would get slower exactly as the data got bigger, which is the case
> it exists for. The trade is that a key is an identity rather than a
> fingerprint: two different routes to the same bytes both run. In a graph a
> person wired by hand, that is a rounding error.

Editing one node re-runs that node and its descendants and nothing else.

## Accessibility

The canvas has a complete keyboard path. It is not a fallback view, and there
is no "use the list instead" — `/tools` is a different affordance for the same
tools, not an accessible alternative to an inaccessible thing.

Press `?` on the canvas for the full map; it is generated from the same array
the canvas binds, so it cannot drift. `K` opens the palette, arrows move the
selection by 8px, `Ctrl/Cmd+Z` undoes, `F` fits, `0` resets zoom.

### Connecting two tools without a pointer

This is the least common thing here, so it is worth spelling out.

1. **Focus a node** — `Tab` moves between them in spatial order, top to bottom
   then left to right. (The DOM is rendered in that order, so this is the
   browser's own tab sequence rather than a hand-rolled roving tabindex.)
2. **Press `C`.** If the tool has one output the flow skips straight to step 4.
3. **Choose which output**, in a filtered combobox.
4. **Choose the target port.** The list contains exactly the ports a pointer
   drop would be allowed to land on — the same `checkConnection` decides both —
   so type mismatches, occupied inputs and cycles are never offered rather than
   being offered and then refused.
5. **Enter.** Focus returns to the canvas and the live region says what
   happened.

Each node is a focusable `role="group"` whose accessible name states its tool,
position, connection count, status and selection: _"Base64, at 608, 368,
1 connection, blocked, Needs input, selected"_. Announcements are split
deliberately — movement and selection go to a polite live region, while a
refused connection also raises a toast, so the reason reaches sighted users as
well as screen-reader users rather than only one of them.

**Nothing relies on colour alone.** Port data types are shapes — square for
text, diamond for JSON, circle for bytes. The selected palette row is a raised
surface _and_ a solid accent bar. Wires and ports switch to `CanvasText` and
`Highlight` under `forced-colors`.

axe runs against every component and route in the unit suite, and against every
route in two real engines — with `color-contrast` enabled, which jsdom cannot
do — in `pnpm check:browsers`. All four themes are held to WCAG AA by a test
that resolves the real CSS and measures each pair.

## Testing

1,327 tests across 61 files. The count is not the interesting part; what the
tests caught is.

### Conformance, measured against the specifications

The Markdown converter is held to the official suites rather than to an
impression of correctness. Both are checked into `src/lib/markup/spec/` and
run on every `pnpm test`; neither reaches the network.

| Suite                                                    | Cases | Passing         |
| -------------------------------------------------------- | ----- | --------------- |
| [CommonMark 0.31.2](https://spec.commonmark.org/0.31.2/) | 652   | **624 (95.7%)** |
| GFM extensions                                           | 24    | **21 (87.5%)**  |

Comparison is by parsed DOM rather than by bytes — on a byte comparison the
same converter scores 475/652, and almost all of that gap is spelling (`<hr />`
against `<hr>`, `&#x26;` against `&amp;`, an inserted `<tbody>`) rather than
meaning.

The expected-failure list is **exact**, not a threshold: an example that starts
passing fails the suite too, so the list cannot quietly drift away from the
truth. Every remaining failure is about raw HTML or a URL — none is about
emphasis, lists, tables, code or headings — and that shape is itself asserted.
[The full breakdown, with a cause against each example](src/tools/text-convert/README.md#measured-conformance),
is in the tool's README, along with its known limitations.

### What property-based testing actually found

`fast-check` generates the inputs nobody thinks to write down. Three real bugs,
all in code that passed its example-based tests:

**Prototype pollution via `__proto__`.** A YAML document with a `__proto__` key
did not create a property — plain assignment `target['__proto__'] = x`
_replaces the object's prototype_, so the key silently vanished from the parsed
data and the object gained a prototype the input had chosen. Fixed with
`Object.defineProperty`, which always creates a real own property whatever the
key is called. See [`safeObject.ts`](src/lib/safeObject.ts).

**The `toString` prototype leak.** Round-tripping JSON → CSV → JSON, a column
literally named `toString` came back with the source of `function toString() {
[native code] }` in it: a bare `record[column]` read found the inherited
`Object.prototype` member rather than the row's own (absent) value. Every
column name in `Object.prototype` had the same problem. Fixed with
`Object.hasOwn` before the read.

**Identifier namespacing that was not idempotent.** The Markdown tools
namespace author-supplied `id` attributes so that markup defining
`id="location"` cannot shadow a global wherever the output is pasted. The
sanitiser's built-in version prefixes whatever it finds — _including an id that
already carries the prefix_ — so `user-content-fn-1` became
`user-content-user-content-fn-1` on the next pass and grew again on every pass
after. It also never touched `href`, so every footnote reference and heading
anchor pointed at a name that no longer existed. Both were caught by a
`md → html → md → html` stability property, and neither by any example.

**Swallowed YAML errors.** The parser was configured `logLevel: 'silent'` to
quiet unresolved-tag warnings — which also suppressed genuine syntax errors, so
malformed YAML returned a half-parsed document instead of reporting the fault.
`logLevel: 'error'` quiets the noise and still throws on real errors.

### Two findings that were only ever going to be found by looking

Both are `reset.css` rules that are correct in general and expensive here.
Neither is visible to a unit test, because jsdom has no layout engine.

**`svg { max-inline-size: 100% }` collapsed every wire.** The canvas plane is a
0×0 box whose `transform` _is_ the coordinate system. 100% of a zero-width
parent is zero, so the wire layer's viewport collapsed and clipped every wire
out of existence — committed and in-flight alike. The wires were all there in
the DOM, with correct path data, painting nowhere. Fixed with
`max-inline-size: none` on the wire layer.

**`svg { display: block }` splits a text run three ways.** Measured: a
paragraph reading `before <span><svg/></span> after` is **60.8px tall instead
of 22.4px** — the block-level svg forces a break before and after it, so one
line becomes three. A `display: flex` wrapper does _not_ rescue it (still
60.8px); only `inline-flex` does (22.4px). That is why every icon-plus-text
control in this codebase is `inline-flex` rather than a plain span, and why an
icon cannot simply be dropped into prose.

### Where each kind of test lives

jsdom has no layout engine, no Worker, no `OffscreenCanvas` and no pointer
events. Anything about geometry, overflow, computed colour, or whether
something actually scrolls is asserted in
[`scripts/cross-browser-check.mjs`](scripts/cross-browser-check.mjs) against
Firefox and WebKit instead — where it drags a node with real pointer events,
runs a tool in a real worker, converts a real PNG, scans every route with axe,
goes offline and reloads, and asserts nothing left the origin.

That split is not tidiness. A serious accessibility bug — the shortcuts dialog
scrolled but nothing could focus it, so a keyboard user could not read past the
fold — was found by axe in a real browser and is structurally invisible to
jsdom, because whether a box scrolls is a question about layout.

## Performance

All figures from the production build, measured in Firefox on a desktop
machine. They are not a benchmark against anything; they are here so the claims
in this file have numbers behind them.

### Bundle

|                                          | Raw      | Gzipped  |
| ---------------------------------------- | -------- | -------- |
| Initial JavaScript                       | 324.7 kB | 105.1 kB |
| Budget (enforced by `pnpm bundle:check`) | 380.0 kB | —        |

Every tool, the canvas, the styleguide and the tool pages are lazy chunks and
none of them are in that figure.

### Cold start

The first run of a tool used to pay for two things it did not need to:

|                     | Before     | After                           |
| ------------------- | ---------- | ------------------------------- |
| Worker boot         | ~22 ms     | 0 — paid when the canvas mounts |
| Tool chunk import   | ~6 ms      | 0 — paid when the node is added |
| The tool's own work | ~0.8 ms    | ~0.5 ms                         |
| **First execution** | **~30 ms** | **~1.5 ms**                     |

Both costs still exist; they moved somewhere the user is not waiting.

### Route transitions

Cold, with 150 ms of simulated latency per chunk:

|               | No prefetch | After a hover |
| ------------- | ----------- | ------------- |
| `/tools`      | 206 ms      | 36 ms         |
| `/styleguide` | 243 ms      | 95 ms         |

Preloading is TanStack Router's own `defaultPreload: 'intent'` — hover and
focus, so the keyboard benefits too — and it does not pull lazy chunks into the
initial bundle.

### Panning

**0.04 ms median, 0.10 ms at p95, per pan step, with 8 nodes on the canvas.**

**This is the synchronous style-and-layout cost of one step, not a frame time.**
It is measured by setting the plane's transform and then forcing the browser to
do style and layout immediately, so it deliberately excludes paint, compositing
and everything else in a frame. It is a useful number for "does the transform
cause expensive layout work" — which is what it was measured to answer — and it
is _not_ evidence of a frame rate. Nothing here measures frames.

### Lighthouse

Production build, served with the real headers, gzipped as the CDN serves it.

| Route           | Performance (mobile / desktop) | Accessibility | Best practices | SEO |
| --------------- | ------------------------------ | ------------- | -------------- | --- |
| `/`             | 89 / 100                       | 100           | 100            | 91  |
| `/tools`        | 91 / 100                       | 100           | 100            | 91  |
| `/tools/base64` | 93 / 99                        | 100           | 100            | 91  |
| `/styleguide`   | 90 / 100                       | 100           | 100            | 91  |

SEO is 91 everywhere because of a single audit — Lighthouse's fetch of
`/robots.txt` fails with a Chrome DevTools protocol error in this environment.
The file is served correctly (200, `text/plain`), and the failure persists with
every one of our headers removed, so it is a harness artifact rather than a
deployment defect.

## Adding a tool

A tool is one directory and two edits. Full worked example in
[docs/adding-a-tool.md](docs/adding-a-tool.md).

```ts
// src/tools/case-convert/index.ts
export const caseConvertTool = defineTool({
  id: 'case-convert',
  name: 'Case',
  summary: 'Convert text between upper, lower, title, snake and kebab case.',
  category: 'text',
  inputs: [{ id: 'input', label: 'Text', types: ['text'], required: true }],
  outputs: [{ id: 'output', label: 'Converted', types: ['text'] }],
  optionsSchema: caseOptionsSchema,
  defaultOptions: caseDefaultOptions,
  optionFields: caseOptionFields,
  execution: { strategy: 'main', timeoutMs: 5_000, maxInputBytes: 2 * 1024 * 1024 },
  // `inputs.input` is narrowed to the text variant by the port declaration
  // above — the run signature is derived from the ports, not asserted.
  run: ({ inputs, options }) =>
    ok({ output: { type: 'text', text: convert(inputs.input.text, options.target) } as const }),
});
```

Then one line in the manifest and one in the loader. It now appears in the
index, in canvas search and in the palette, and can be wired to anything with
compatible ports — without any of those places being edited. No route, no UI,
no worker message type, no caching, no cancellation handling.

## Design system

Instrument panel: dense modular grids on an 8px baseline, hairline borders
instead of shadows, tight uppercase monospace labels, near-monochrome palettes
with one saturated accent, mechanical 120–180 ms motion, radii never above 2px.

Tokens are CSS custom properties in three layers — raw scale, semantic
meanings, theme overrides — and the boundary between them is enforced by a test
rather than by convention. Four themes, each held to WCAG AA by a test that
resolves the real CSS. The rule and its rationale are in
[CONTRIBUTING.md](CONTRIBUTING.md#the-token-layering-rule); run the app and
visit `/styleguide` to see every token with contrast ratios measured live.

## Setup

Requires Node 22 (see [`.nvmrc`](.nvmrc)) and pnpm.

```bash
corepack enable pnpm
pnpm install
pnpm dev
```

Contributing guide, including the six gates and the token-layering rule:
[CONTRIBUTING.md](CONTRIBUTING.md).

| Script                                       | Does                                                         |
| -------------------------------------------- | ------------------------------------------------------------ |
| `pnpm dev`                                   | Start the dev server                                         |
| `pnpm build`                                 | Typecheck, then build to `dist/`                             |
| `pnpm preview`                               | Serve the build (without the real headers)                   |
| `pnpm serve:dist`                            | Serve the build **with** the real `_headers` and gzip        |
| `pnpm typecheck`                             | `tsc` across both TS projects                                |
| `pnpm lint` / `lint:fix`                     | ESLint, zero warnings tolerated                              |
| `pnpm format` / `format:check`               | Prettier                                                     |
| `pnpm test` / `test:watch` / `test:coverage` | Vitest                                                       |
| `pnpm bundle:check`                          | Fail if the initial payload exceeds its budget               |
| `pnpm check:browsers`                        | Drive the built app in Firefox and WebKit                    |
| `pnpm assets:generate`                       | Regenerate icons and the social image from the design tokens |
| `pnpm fonts:sync`                            | Copy font subsets out of Fontsource into `public/fonts/`     |

## Browser support

Current Firefox, Chrome, Edge and Safari. The app degrades rather than breaks
where a capability is missing — without `OffscreenCanvas`, image work runs on
the main thread and produces an identical result, and the cross-browser harness
asserts which branch was actually taken so the fallback cannot rot unnoticed.

**The Safari caveat, stated plainly.** `pnpm check:browsers` runs Firefox and
Playwright's **WebKit** — the engine behind Safari, not the Safari application.
It is the closest a non-Mac machine gets, and it is not the same thing: WebKit
via Playwright differs from shipping Safari in its release cadence, its
media stack, and some of its platform integration. Two consequences are
already documented in the harness — `upgrade-insecure-requests` is applied to
loopback in WebKit where Chromium and Gecko exempt it, and Playwright's WebKit
build cannot navigate at all while offline, so the offline reload check is
explicitly skipped there rather than silently dropped. **Patchbay has not been
tested on Safari itself.**

## Deployment

Netlify, from `main`. [`public/_headers`](public/_headers) and
[`public/_redirects`](public/_redirects) are copied verbatim into the build, so
the bytes that get deployed are the ones in the repo and `pnpm serve:dist` can
serve the built app under the real policy.

The site's public origin is one value, `VITE_SITE_URL` in [`.env`](.env). It is
substituted into index.html as `%VITE_SITE_URL%` and read at runtime as
`import.meta.env.VITE_SITE_URL`, so a custom domain is one edit rather than a
search for stragglers. The build fails if it is missing or relative — an
og:image that does not resolve is a shared link with a blank card, and nobody
notices until someone shares one.

### Link previews

Crawlers and link-preview bots do not run JavaScript, so the complete Open
Graph and Twitter set is **static markup in index.html**, not something the
router applies. Those tags carry `data-default`; the router replaces them on
mount and `dropStaticHead()` removes them, because React hoists its own copies
into `<head>` without removing what was already there — which produced two of
every tag until it was fixed. Both halves are asserted: the static set against
the built file, and the one-of-each result in two real browsers.

## License

MIT — see [LICENSE](LICENSE).
