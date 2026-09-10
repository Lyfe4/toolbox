# Patchbay

A developer toolbox — encoders, hashes, formatters, diff, regex, colour, image
and video conversion — that runs entirely in your browser. Wire the tools together on a
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
| **Image**           | Convert and resize between PNG, JPEG and WebP, with a before-and-after.     |
| **Text convert**    | Markdown, HTML and plain text, with a sandboxed preview and rich-text copy. |
| **Video**           | Repackage a video into an MP4 without re-encoding, or extract its audio.    |

Each has its own README next to the code, which is where the interesting parts
are written down: why [JWT](src/tools/jwt-decode/README.md) refuses
`alg: none` and why "not verified" is drawn as a warning rather than as an
absence, how [Regex](src/tools/regex-tester/README.md) survives a
catastrophically backtracking pattern and what it tells you when a pattern
finds nothing, why
[Image](src/tools/image-convert/README.md) strips every scrap of metadata from
a photograph and says so, why [Video](src/tools/video-remux/README.md) refuses
to put a WebM's codecs in an MP4 and ships no ffmpeg at all, why
[Text convert](src/tools/text-convert/README.md) round-trips are
checked for _meaning_ rather than byte equality, and why
[Structured data](src/tools/structured-data/README.md) refuses to guess that a
CSV cell holding `01234` is a number.

**How a result is drawn** is a decision per output port rather than per tool,
and the reasoning lives in
[architecture.md](docs/architecture.md#output-views-are-chosen-by-the-port-except-for-bytes):
JSON that means something particular — a diff, a regex report, a conversion
report, a decoded token — gets a view named by the port, bytes that turn out to
be an image get a preview, and everything else is plain text because plain text
is already the answer. Every view keeps its payload one press away.

**Rich text** is the one thing not deducible from the options: it is not a
target format. Set Text convert's target to **HTML**, run, and press **Copy as
rich text** on the Rendered HTML output — it pastes into Word, Google Docs or
an email with the formatting intact, where **Copy HTML** beside it gives you
the markup. `Plain text (strip formatting)` is the opposite: it removes the
formatting rather than carrying it.

`/` is the node canvas; `/tools` is the same set as a plain list. Neither is a
fallback for the other.

**On the canvas, a node's input, options and output are one panel.** Select a
node and the inspector shows all three, using the same options panel and the
same five output views the tool page uses — so a chain runs on the settings you
chose and you can read what it produced, including the last node's. The node
itself keeps a short summary of its result — `47 matches`, `2.1 MB PNG image`,
`+12 −3` — so a pipeline can be scanned without opening anything. See
[architecture.md](docs/architecture.md#the-node-inspector).

It **starts closed** and slides in when you open it, and it comes back however
you last left it. Open by default was the wrong first screen: an empty canvas
beside an empty panel saying there was nothing to inspect. Whether it is open
is still your state and selection only decides what is in it — but where the
rail's width is deliberately forgotten between sessions, whether the panel is
showing is not, because it is the difference between seeing what you were
working on and having to ask for it again on every reload.

**A node's input can be a file.** Drop one on a node, or choose one in the
inspector — every unwired input port has its own control, so `diff` can compare
two files and `image-convert` can be started at all. It could not be, before:
its only input takes `bytes`, so on the canvas there was nothing to type into it
and no wire that could have come from anywhere. Size limits and the "this port
needs text" refusal both land at the moment you choose the file rather than when
you run, the format comes from the bytes and never from the extension, and the
same control drives both routes.

**A file lasts as long as the tab, deliberately.** A graph is saved to
`localStorage` and shared by URL, and a `File` belongs in neither — so the
document keeps the name and size and the bytes do not persist. Reload and the
node says `"holiday.png" needs choosing again` rather than coming back looking
as though nobody had ever fed it; a link you share carries no filename at all,
because a filename is often the most revealing string in a document. The whole
answer, and what was rejected, is in
[architecture.md](docs/architecture.md#a-file-as-an-input).

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
information at runtime — the drag preview, the keyboard connect flow, the
share-link validator and the saved-canvas loader all ask one
`checkConnection`. The [port set](docs/architecture.md#the-port-set) itself was
audited as a set rather than tool by tool, and its conventions are asserted:
every tool's first output is `output`, every port has a description, and every
data type in the system is carried by a port somewhere.

**Worker execution.** Heavy tools run off the main thread behind a small tagged
message protocol. Binary payloads are `Uint8Array` or `Blob` — never base64
strings internally — and buffers are transferred rather than copied. Execution
never throws across the boundary: a tool returns a result describing success or
failure, and bad input is a result, not an exception.

**Incremental caching keyed on upstream cache keys, not values.** Each node's
key is built from its tool, its options, its typed input, the identity of any
file chosen for it, and the _keys_ of the nodes feeding it.

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
the canvas binds, so it cannot drift. `K` opens the palette, `I` shows and
hides the inspector, `Enter` opens it on the focused node and moves into it,
`Escape` steps back out to the node, arrows move the selection by 8px,
`Ctrl/Cmd+Z` undoes, `F` fits, `0` resets zoom.

`Enter` and `Space` are the two keys the canvas does **not** claim when a
control inside it has focus. It is a `role="application"` region, so every
single letter reaches its own handler — and that claim was cancelling `Space`
on the way to every button in the toolbar, since a `<button>` is activated by
`Space` on keyup only if the keydown's default action survived. Every other
key still belongs to the canvas: an arrow key nudges the node whose button has
focus, because a button does nothing with an arrow key.

The rail's divider is a **focusable separator** with arrow keys that resize by
one grid step and Home/End for the extremes — a handle only a pointer can move
is a preference only a pointer user has. It draws a one-pixel rule and is
grabbed by a target much larger than that, which are two separate boxes: 44px
under a finger, and the rule stays a hairline at every size.

`Enter` steps into whichever control the node's first free input actually has —
its text editor, or its file chooser on a port that takes bytes only. The
chooser is a real `<input type="file">`, visually hidden and labelled, so Tab
then Enter opens the picker: dragging a file onto a node is the extra rather
than the route.

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

**And a selected node carries a `Connect` button, which opens the same flow at
step 2.** It exists because step 2 was a keystroke, and a phone has no
keystrokes: dragging a wire from a port works with a finger, so nothing was
blocked, but this flow is also **the documented way to read a port label the
node has had to truncate** — and 224px of node truncates labels most on exactly
the device that had no way in. The button is handed the same function `C` is
bound to, so the two are one flow with two entrances rather than two routes
that agree until one of them changes; a test drives both and compares the wire
each produces.

It appears **only on the node that is the only thing selected**, and at every
pointer type. Only-when-selected is what pays for it: a node is 224px wide and
permanent chrome on every one of them is a cost everybody carries forever,
where this is at most one control on the plane. Every pointer type rather than
coarse-only because `pointer: coarse` is not "no keyboard" — it is true of a
tablet with a keyboard folded onto it and false of a mouse user who has never
opened the shortcut list, and connecting was undiscoverable for the second
group too. The reasoning, and what was rejected, is in
[architecture.md](docs/architecture.md#one-flow-two-entrances).

### Without a keyboard at all

The keyboard path above is complete. The pointer path was not, and the gap was
in one direction only: **everything that removes something was keyboard-only.**
`Delete`, `Ctrl+D` and `Ctrl+A` had no visible controls, so on a phone you
could add nodes to a canvas and never remove one — and once connecting became
tappable that stopped being merely incomplete, because an occupied input
refuses a second wire and tells you to remove the existing one first. Three
taps to build a graph, and no way to rewire it.

**Whatever is selected now draws a bar of controls** under the toolbar:
`Select all`, `Duplicate` and `Delete`, with the selection named beside them.
It is canvas chrome rather than anything anchored to the selection, because a
panel hung off a node lives inside the pan-and-zoom plane — it scales with the
plane and the root clips it — and a wire has no box to hang anything off at all.
It is at the **top** because on a phone the inspector is a sheet across the
bottom 60% of the canvas, and the bar was measured underneath it before it moved.

**A wire is selected by tapping it.** The grab band around each wire is 24px
wide on a mouse and 44px under a finger, and it stays that size at every zoom —
it used to be declared in plane units, so it was 3.5px zoomed out, which is
exactly when a wire is hardest to aim at. Where two wires run close together
the **nearest** one wins rather than whichever the browser painted last: a
node's inputs are 24px apart, so finger-sized bands overlap there by
construction, and paint order is an arbitrary answer that changes when an
unrelated wire is added.

**A deletion offers its own undo.** `Deleted Base64`, with an `Undo` beside it
in the notification. Undo has existed since the canvas had a history, but below
640px the toolbar collapses and it moves into an overflow menu — so on the one
device where deleting is a tap, reversing it was three taps behind a control
whose label says nothing about deletion.

**And a wired input carries `Disconnect` in the inspector**, which is the route
with no aiming in it and the only one a keyboard can reach: nothing on the
keyboard has ever put a wire in the selection, so before this a wire could only
be removed by a pointer hitting a curve. It is also exactly where the refusal
points — the panel already prints which wire is in the way.

`?` lists all of this in a "Without a keyboard" table generated from the same
array the canvas implements, so it cannot drift. What is still keyboard-only is
**add-to-selection**: `Shift`+tap has no touch equivalent that is not a mode,
and a mode on a surface whose primary gesture is a pan will be entered by
accident. The reasoning, the alternatives rejected, and the rest of what a
first-time phone user still cannot do are in
[architecture.md](docs/architecture.md#deleting-things-without-a-keyboard).

Each node is a focusable `role="group"` whose accessible name states its tool,
position, connection count, status, what it produced and selection: _"Base64,
at 608, 368, 1 connection, blocked, Needs input, selected"_, and once it has run
_"Hash, at 832, 368, 1 connection, succeeded, 5d41402abc4b2a76b9719d911017c592"_.
The result is in the name for the same reason it is on the node: a chain you can
scan by eye and not by ear is not a chain a keyboard user can follow.
Announcements are split
deliberately — movement and selection go to a polite live region, while a
refused connection also raises a toast, so the reason reaches sighted users as
well as screen-reader users rather than only one of them.

That live region is **queued**, not overwritten. Several unrelated things
announce into it — the graph, the running pipeline, the viewport — and a region
that holds one string loses whichever message arrives second. Messages are
appended to a log and delivered one at a time, so a fit-to-view during a run
says both things rather than whichever finished last. Position chatter from a
held arrow key is the one exception: queued messages there supersede each
other, so nobody hears where a node used to be several seconds after it
stopped. See [architecture.md](docs/architecture.md#announcements-are-a-log-not-a-variable).

**Nothing relies on colour alone.** Port data types are shapes — square for
text, diamond for JSON, circle for bytes, hexagon for a colour, and two offset
squares for a port that accepts more than one. The selected palette row is a raised
surface _and_ a solid accent bar. Wires and ports switch to `CanvasText` and
`Highlight` under `forced-colors`.

axe runs against every component and route in the unit suite, and against every
route in two real engines — with `color-contrast` enabled, which jsdom cannot
do — in `pnpm check:browsers`. All four themes are held to WCAG AA by a test
that resolves the real CSS and measures each pair.

A theme somebody builds themselves cannot be held to that by a test, because it
does not exist when the test runs — so the theme editor measures the same 39
pairs live, with the same code the test uses, and says which pair is failing
against which. Saving a failing theme is allowed; it is the user's choice. The
state is carried by a signal colour, a rule and the words "5 of 39 pairs fail
WCAG AA", so it does not depend on being able to see the colour it is warning
about.

## Testing

2,764 tests across 104 files. The count is not the interesting part; what the
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

### The bugs that produced an answer rather than an error

[Structured data](src/tools/structured-data/README.md) is the tool where being
wrong is quiet: every other tool here fails visibly, and a converter fails by
handing back a document that looks exactly like the one you asked for. A pass
looking specifically for that shape found five, none of which any test was
failing on:

- **A semicolon-separated export came back as one long string.** Detection only
  ever tried tabs and commas, so what Excel writes across most of Europe matched
  neither, fell through to YAML, and parsed as a single plain scalar.
- **`Hello, world` was confidently reported as an empty table.** One line
  satisfies "every line agrees on its field count", and a one-line CSV is a
  header with no rows — so a non-empty document produced `[]`.
- **A file ending `name\n""` lost its last record.** An empty _quoted_ field is
  neither a non-empty field nor a completed one, so the pending row was never
  flushed. From the outside it looked like a file with no rows.
- **A YAML mapping with both `true:` and `"true":` lost one of them.** They are
  two keys to YAML and one key to JavaScript. The parser's uniqueness check
  compares scalar values, so it saw two, and the object it built had one.
- **Deeply nested input threw `RangeError` out of `run`.** Through the `json`
  input port, which is the one route that never meets a parser, so it met no
  guard either — and a tool throwing across the execution boundary is the thing
  the whole result type exists to prevent.

Each is now a named regression test, and the tool's README carries the coercion
policy, the detection rules and what it does with data that cannot survive the
conversion — including the one silent loss that is not fixable here.

### What a video tool cost, and what it did not

[Video](src/tools/video-remux/README.md) changes a container without
re-encoding: an `.mkv` or a `.mov` becomes an `.mp4`, or its audio track comes
out on its own. The frames are copied across byte for byte, so nothing here
decodes a pixel and nothing here can be lossy.

**It was measured before it was built.**
[docs/video-convert-feasibility.md](docs/video-convert-feasibility.md) is an
investigation that built nothing and produced numbers: a 1080p one-minute clip
transcodes in **4 minutes 44 seconds** at ffmpeg's own default preset and
**remuxes in 0.2 seconds**. Transcoding also needs three changes to the
execution engine's central guarantees, paid for by every other tool.
So this is the remuxing half, shipped on its own.

**And it ships no ffmpeg**, which is where the build departed from the
investigation. That recommendation was for a remuxer that could _also_
transcode, and removing the transcoding removes the argument for the payload:
ffmpeg's 30.7 MiB is libx264, libx265, libvpx, LAME and the rest — **encoders**,
all of them — and a remuxer runs none. Both containers are parsed and the MP4 is
written in TypeScript, in **35.6 kB raw / 12.8 kB gzipped**, about one
five-hundredth of the 6.9 MiB brotli payload. It needs no service worker, no
Cache Storage, and no CSP exception — `'wasm-unsafe-eval'`, which had been
carried since the project began for "the WASM-backed tools to come", is gone
from the policy with it.

The trade is coverage, and it is stated rather than discovered: two container
families rather than every one ever written, and H.264, H.265, AAC and MP3
rather than every codec. A WebM is **refused**, because VP9 and Opus inside an
MP4 make a file that fewer players accept than the one it came from.

Three things came out of building it that the investigation had not found:

- **The files people most want to remux do not fit in memory.** The 92.6 MiB
  clip it measured generalises badly: the archetypal "won't play" file is a
  two-gigabyte film, and no browser tool can hold one — not this one at its
  256 MB limit, and not a WASM ffmpeg either, whose heap ceiling is 2 GiB
  before the file itself is counted. The fix is streaming the input and the
  output, which is a change to `ToolValue` rather than to a tool.
- **A repackage silently discards the recording location and date**, which a
  phone writes into every file it produces. That is the image tool's GPS
  finding in a second place, and it is now a warning on the result and an
  assertion on the output bytes.
- **A rotation is one line away from being lost.** A phone held upright
  records landscape pixels and writes a 90-degree transform into the track
  header; everything else in the file describes a landscape video. A rebuilt
  header without it produces a repackage that is correct in every measurable
  respect and plays on its side.

**Malformed input was part of the first version rather than a follow-up**,
because the investigation named it as its own largest gap: every file its spike
saw was one ffmpeg had just written. With no library in the way, the whole
attack surface is ours — so `entriesThatFit` is the single function that turns a
declared 32-bit count into a real one by measuring the box that declared it, and
no array anywhere is sized from a number a file chose. An `stsz` claiming four
billion samples out of twelve bytes yields zero. The properties are asserted
over arbitrary bytes, over real headers followed by noise, and — the one that
reaches the interesting code — over a valid file with one byte changed, four
hundred times, in bounded time.

The guard worth naming on its own is the one that has no analogue in the image
tool. Nothing in either container forbids two frames from pointing at the same
bytes, so a small file can describe an enormous one: twenty-five kilobytes
declaring two thousand samples of four kilobytes each asks for eight megabytes,
and every individual range in it is inside the file and passes every other
check. The bound is the input's own size, because a repackage **copies**.

### The guard that was in the wrong place

[Image](src/tools/image-convert/README.md) refused a decompression bomb by
reading the decoded bitmap's dimensions and bailing out before allocating a
canvas. That reads as safe. Measured in two real engines, it is not:

> A 48 kB PNG declaring 20000×20000 **decodes successfully** in about two
> seconds in both Firefox and WebKit. By the time `bitmap.width` could be read,
> the browser had already committed 1.6 GB of RGBA.

The canvas was never the expensive allocation — the decode was, and the guard
ran after it. The limits now apply to the dimensions in the container header,
read from about forty bytes before any decoder is called, and the bomb is
refused in ~230 ms. The post-decode check stays as a backstop, because a header
may only ever refuse a file and never approve one.

The same pass found a GIF's frames are not obliged to fit inside its declared
logical screen — a file can announce a 1×1 screen and hold a 20000×20000 frame
— and that every step of the encode could throw rather than return, which is a
tool throwing across the worker boundary.

### The conversions that were plausible and wrong

Also Image, and all of the same shape: output nobody would report, because it
looks like an image.

An animated GIF converted to a still frame and said nothing. A transparent PNG
was correctly matted onto white and said nothing. A photograph's GPS
coordinates were correctly removed and said nothing — which, in an app whose
whole pitch is that your data does not move, is the one that most needed
saying. Each is now a note on the result, and the warn-level ones are repeated
in the summary line, because a caveat nobody scrolls to has not been said.

Two suspicions turned out to be **correct behaviour** and were left alone: EXIF
orientation is honoured by both engines, and an 8× downscale of one-pixel
stripes comes back uniform grey rather than aliased. Both are now regression
tests, measured on decoded pixels, so they cannot quietly stop being true.

### The wrong answer that looked like a big one

[Regex](src/tools/regex-tester/README.md) advanced past a zero-length match with
`lastIndex += 1`, which is the remedy every tutorial gives. Under the `u` or `v`
flag it lands **between the two halves of a surrogate pair**, and the engine
resolves that position back to the start of the same code point — so the match
repeats at the same offset forever.

`/^/gu` against any text containing an emoji therefore reported **5,000 matches
at index 0** and described itself as merely truncated. Not a hang, not an error:
a plausible-looking result with a limit note attached, which is the shape of bug
nobody reports. The fix is the spec's own `AdvanceStringIndex`, and the whole
match list is now asserted equal to `String.prototype.matchAll` — the
specification's own answer to the same question — across a matrix of patterns,
flags and subjects and again under `fast-check`.

The same pass found the tool reporting `count: 5000` for a truncated listing
(the count now outlives the listing), a match containing a newline rendering as
two rows indistinguishable from two matches, and a sticky-without-global listing
that disagreed with the replacement it sat next to.

### What building the node inspector found

The panel itself was the easy part. Four of these are bugs it uncovered rather
than bugs it introduced, and the first two had been shipping.

**A bytes-only port had a text box on the canvas too.** `image-convert`
declares `types: ['bytes']` on its only input, and the canvas drew an editor for
every unwired input port without asking what the port accepted. The tool page
had the same defect and was fixed; the canvas's version was worse. Typing into
it could not even produce an error — the engine's preflight blocks a required
bytes port with no wire whatever the box contains — so the node sat blocked
forever with an editor under it inviting another attempt. That is the fifth time
this codebase has drawn an affordance for behaviour that does not exist, which
is why CONTRIBUTING names the pattern explicitly.

**Pressing anything in the toolbar cleared the node selection.** The toolbar and
the status readout render inside the canvas root, so a pointerdown on Fit, Undo,
Share or Shortcuts arrived at the canvas's own handler as "not a node" and threw
the selection away, silently, at every width. Survivable while nothing on screen
depended on the selection. Not survivable the moment one of those buttons was
the inspector toggle, which deselected the node and then opened a panel
reporting that no node was selected.

**`1fr` is max-content in an auto-height grid container.** The shell's
`min-block-size: 100dvh` is a floor, not a cap, so a row whose content exceeds
it still grows — which meant the canvas route was a fixed-height viewport only
for as long as nothing inside it had intrinsic height. Measured in both engines
the moment the inspector held a result: **a rail with a long match table in it
was 1,828px tall inside a 900px window**, and its own scroll region never
scrolled because it had all the room it wanted. jsdom cannot see it; every box
there is zero.

**A 32px title bar with a 44px button in it.** On a coarse pointer the Button
component correctly grows to WCAG's 44px, and a child taller than a
fixed-height parent overflows it — 7px past the panel's own border, at every
phone width, found by the mobile sweep that measures every box against its
clipping ancestor.

**And a test that had quietly gone stale.** `JwtView.test.tsx` pinned the
_view's_ clock with a prop and let the `decode` helper run the real tool, which
reads `Date.now()`. The two agreed on the day the file was written and drifted
apart afterwards: a token whose `nbf` was "now + 2 hours" became usable, and one
expiring "in 1 hour" became expired. `Date.now` is pinned alongside the prop now.

### Three findings that were only ever going to be found by looking

None of them is visible to a unit test, because jsdom has no layout engine. The
first two are `reset.css` rules that are correct in general and expensive here.

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

**450 invisible spans gave a long diff 7,600px of nothing to scroll.** Every
diff row carries a visually hidden `<span>` naming the change and the line —
_"removed, original line 12"_ — and the recipe for that is `position: absolute`
with a 1px clip. An absolutely positioned box is clipped by an ancestor's
`overflow` **only if that ancestor is its containing block**, and the row
scroller was not positioned, so the containing block was the document. The
hidden spans escaped the scroller, laid themselves out down the page, and
contributed to the document's scrollable overflow: on a 600-row comparison the
scrollbar said the page was five times longer than it is, and dragging it
landed you in blank space. `position: relative` on the scroller is the whole
fix.

Nothing painted there, nothing overflowed sideways and nothing was clipped, so
none of the existing geometric checks could see it — it was found by measuring
the page height while making the tool runner's options panel sticky, which is
the only reason anybody asked how tall the page was.

### The other containing block, one layer up

The same question — _what box is this positioned thing measured against?_ — had
a second wrong answer on the same page, and this one was visible.

A `position: sticky` box's travel is bounded by its containing block, and for a
grid item that containing block is the grid **container**, not the grid area it
was placed in. The options rail spans the two content rows so that sticky has
somewhere to travel, which makes the natural reading "it can only move across
those two rows". It cannot: it moves until its bottom reaches the bottom of the
grid. The Ports footnote was a third row of that grid, spanning both columns —
so it lay across the rail's entire travel range, and at the foot of
`/tools/jwt-decode` the rail covered 52px of it. From the moment it came
unstuck its bottom edge tracked the grid's bottom edge to the pixel, which is
what identified the constraint.

**`/styleguide` runs the same pattern and never had the problem**, and that is
the clue that made the cause findable rather than workaroundable. Its grid has
exactly two children: one content column holding every section, and the sticky
sidebar. Its sidebar's containing block bottom _is_ the content column's
bottom, so there is nothing inside the grid below it to reach. The tool page had
a third row and that row was full-bleed.

So the fix is not z-index, and could not have been: the rail was never escaping
its bounds. The grid now holds only the three regions the rail travels beside,
and everything a tool page renders below them is a sibling in the page's flow —
outside the rail's containing block, whatever its height and however tall the
options panel is. Another defect went with the same span: the surplus height a
spanning item distributes across `auto` rows was putting 80px of nothing between
the input and the output, which `min-content minmax(0, 1fr)` fixed by giving
row one the input's height exactly.

**The third thing that came off that span has since been undone on purpose.**
Run was held still by reserving a viewport of height on `.layout`, and the price
was every tool page being a screen tall whether or not it had anything on it —
a 416px Output panel around one sentence, and 200–400px of bare background
between the options and the button. The rail is as tall as its contents again,
Run travels with the options, and what is asserted instead is that it is on
screen and one gap below them. See
[architecture.md](docs/architecture.md#the-height-the-page-does-not-reserve).

### What reading the ports as a set found

Nine tools' worth of port declarations, each written when its tool was written
and never read beside the others. Individually every one was defensible; the
set had four problems, and none of them is the kind a test could have asked
about because each is a judgement about the whole.

**A port promised sanitised HTML and handed back the input.** Text convert's
`Rendered HTML` output declares "always HTML, sanitised", and there was no
function in the markup pipelines that produced one — `markdownToHtml` sanitises
the HTML _it_ generates, and the other two sanitise on the way to something
that is not HTML. So for an HTML source with any target but Markdown, the port
carried the input string unchanged. Measured:

```
in:  <p onclick="alert(1)">hi<script>alert(2)</script></p>
out: <p onclick="alert(1)">hi<script>alert(2)</script></p>
```

Nothing ever ran, because the preview iframe is `sandbox=""` — no scripting, an
opaque origin. What did happen is that the string went onto the clipboard
through **Copy as rich text** and out of the port into whatever node was wired
to it, which are the two places where a port's stated promise is all anybody
has to go on. The conversion output is byte-identical either way; it was only
the port that was wrong.

**Two tools that read documents refused files.** Structured data widened its
document port to accept `bytes` some time ago, recording that refusing them
"made the most obvious pipeline in the product impossible". Regex and Text
convert have the same port and never got the same fix, so a decoded log file
could not be wired into a regex subject and a base64-decoded mail body could
not be wired into the converter. Both were also inconsistent between the two
_routes_ rather than merely strict: a tool page has always accepted a dropped
text file on either tool, because the runner decodes it first. Only the canvas
refused. One tool that takes a file in one place and refuses it in the other is
drift, not a decision.

**A diff of two PNGs was a valid unified diff of two walls of U+FFFD.** The
lenient decoder is right where it lives — a preview of decoded base64 is more
use than a refusal — and wrong on a document port, where it turns bytes nobody
can read into a confident answer about content nobody wrote. Widening a port
only pays if the port refuses clearly, so every document port decodes strictly
now and says _which_ port it was: with two of them, "those bytes" is not an
answer.

**Two data types had no ports at all.** `image` and `datetime` were in the type
system and nothing declared either. `datetime` was merely dead. `image` was
worse: binary travels as `bytes` everywhere in this app and the sniff says what
it is, which is exactly what makes Image → Hash and Image → Base64 legal — so a
separate `image` type would have made those illegal and left every future
author choosing between two types for one concept with no right answer.

Two ports were renamed for consistency (`hash.digest` → `output`,
`image-convert.info` → `report`), which breaks saved canvases and share links
and is migrated on both routes. The interesting part is what _not_ migrating
looked like: an edge leaving `hash.digest` still leaves a node that exists and
arrives at a port that exists, so nothing refuses it — the engine finds no
value on a port called `digest` and reports `Nothing arrived on Original`
against the node **below**, which is correctly wired and did nothing wrong. The
rest of the pipeline runs normally. A canvas that works except for the one
thing it was built to do, with nothing on screen to say which wire is the
problem.

That is also why `checkConnection` now guards the two routes that build a graph
from outside this session. It had three callers — the pointer drop, the
keyboard flow, and the target list both of those consult — and the share link
and the saved canvas had none, though this README already claimed otherwise.
Both refuse the whole document with the reason now, rather than applying the
part of it they understood. Two silent repairs went with that: the share
decoder used to skip an edge whose endpoint was missing, contradicting its own
header, and the graph loader used to filter the same edges out.

The reasoning for every call, including the four things deliberately left
alone, is in
[architecture.md](docs/architecture.md#the-port-set).

### What a test that failed one run in three was really telling us

`check:browsers` had one intermittent failure, in the check that wedges a real
worker with a catastrophically backtracking pattern. It failed about one WebKit
run in three, and it was filed as a scheduling defect: a pipeline run apparently
delayed by twenty-five seconds with the main thread idle. Nothing was delayed.
The 25 000 ms was the poll's own timeout expiring against a node that had no
input to run and never would — and the reason it had none is a bug a user hits
without a harness anywhere near them.

**Pressing `Enter` on a node put focus on the button that closes the inspector.**
`Enter` exists to step into that node's input editor, and the panel's first
focusable element in document order is the close button in its header —
`querySelector` over a list of selectors returns the first element matching any
of them, not the first selector that matches something. So pressing `Enter` and
typing produced nothing, and the next `Space` shut the panel. The unit test
covering this asserted that focus was _somewhere in the panel_, which was true
of the bug.

The move was also deferred to an animation frame, which is what made it
intermittent rather than constant in the harness: Playwright focuses a field and
inserts the text as two steps, and a frame that arrives late under load lands
between them. The text then goes to the close button, where text landing on a
button is not an error anywhere — the fill reports success, the node stays
`blocked` for want of an input it appears to have, and the check fails
twenty-five seconds later against the part of the system that did nothing wrong.

Two more defects came out of looking at the same area properly, and both are the
kind that only ever show up as a wait:

- **A cancelled request stranded its worker.** Cancelling settles the caller; it
  does not stop a synchronous tool. Forgetting the request also cleared the
  deadline that was the only thing in the system that would ever have destroyed
  the wedged worker — so the next run queued behind a thread that would never
  answer. Measured: 10.8 s in WebKit and 4.1 s in Gecko of `Running` with
  nothing running, against 2.1 s with the deadline kept, and bounded only by the
  waiting node's own timeout. Editing or deleting a node while a runaway one is
  in flight is all it takes.
- **Every tool ran twice in Safari.** The worker's entry module is also a shared
  chunk, so JavaScriptCore evaluated it a second time when a tool chunk imported
  it back, and `message` had two listeners. Nothing was ever wrong, because a
  tool is a pure function — it simply cost twice the CPU and twice the peak
  memory of every worker tool, invisibly, in one engine. No assertion about an
  answer can see that; the check that catches it counts.

The reasoning, the measurements and what was looked at and found sound are in
[architecture.md](docs/architecture.md#what-the-intermittent-worker-wedge-failure-actually-was).

### The same defect, a second time, one screen further up

CI failed on a unit test that builds a three-node chain entirely from the
keyboard and then runs it. The chain came out **wired backwards** — Structured
data → Hash → Base64 — and the assertion that noticed was the one fifteen
seconds later, about the pipeline, which had executed that graph perfectly
correctly. The head node reported `blocked, Waiting upstream`, which is what a
node says when something is wired _into_ it, on the one node in the chain that
was supposed to have nothing above it.

The cause was the deferred focus move written up above, in a second place that
never got the fix. **Choosing a tool in the palette moved focus onto the new
node one animation frame later.** The node is created in the store, so it is
not in the DOM when the palette's handler returns — which is a real problem,
and a frame is the wrong answer to it, because a frame waits for longer than
the render takes and everything in the surplus gets its focus stolen. Add a
tool, move to another node, press a key, and the late frame puts you back on
the tool you just added: `C` connects from it, an arrow key moves it, `Delete`
deletes it.

**A user on a slow machine hits this**, and it is worse for them than for the
test, because nothing about it looks like a failure. Every wire the wrong node
produces is a legal wire, so there is no refusal, no toast and no error — just
a pipeline that runs the wrong way round and a node reporting that it is
waiting for something upstream of the first tool in the chain.

Measured: with that frame made 18 ms late — which is only what CPU load does to
it — the keyboard flow built `Hash → Base64` instead of `Base64 → Structured
data`, reproducing CI's DOM and its announcer text (`Pipeline finished. 3
blocked.`) exactly. It is a layout effect now, like its twin: React commits the
new node and the effect in the same pass, so the move happens after the node
exists and before the task the keystroke started can end.

**And two more, found by going back and looking.** `CommandDialog` focuses its
search field on mount and `ShortcutsOverlay` focuses its close button, each one
line, each from a passive `useEffect` — which had not been questioned because
they look obviously correct. They are the same defect, and the palette's is the
one that bites: it is opened by `K`, and `K` is followed immediately by what
the user came to type, so every character struck before the browser paints goes
to the canvas root instead. That root is a `role="application"` region which
claims single letters and shows nothing for them, so the search box opens
already missing the front of the word with no error anywhere. Five corrections
of one shape now, which is enough to state the rule: **a focus move that
answers a keystroke belongs in the task the keystroke started**, and the only
thing that ever needs waiting for is a target that does not exist yet — which is
what a layout effect is for.

Three tests came out of it, and the shape of the old ones is the point:

- The test that covered this asserted focus **eventually** reached the new
  node, through a `waitFor`. That is true of a move deferred by any amount, so
  it was never going to fail. It is asserted synchronously now, and the
  interleaving itself is driven with `fireEvent` rather than `userEvent` —
  every `await` in a user-event helper is a place where a late move can quietly
  catch up and pass.
- The keyboard pipeline test asserted **two edges**, which any two legal wires
  satisfy. It names the chain now, so a mis-wire fails where it happens instead
  of fifteen seconds downstream against the executor.
- `Enter` on a node with no text editor was asserted to land "somewhere in the
  panel" — the exact wording this repository already knew was satisfied by the
  bug. It names the file chooser now.

And a duplicate React key found in the same log: `Space + drag` and
`Middle-drag` both read "Pan the canvas", and the shortcuts reference keyed its
rows on the action, so two rows shared `Moving around-Pan the canvas` and React
warned out of every test file that opens the dialog. Both rows did render — the
list is fixed at mount, and a duplicate key only drops or duplicates a child
once the list changes — so the visible damage was nil and the latent damage was
not. Rows are keyed on the binding now, and `shortcuts.test.ts` asserts the
array itself is unique under that identity, because the reference is generated
from the array the canvas binds.

### What adding a file input found

The starting point was not a bug report, it was a sentence nobody could carry
out: **drop a photo, convert it to WebP, hash the result.** Every piece of that
existed and worked. `image-convert`'s only input declares `bytes`, so on the
canvas there was nothing to type into it and no wire that could have come from
anywhere — the pipeline could not be _started_, which is a different kind of
missing from a pipeline that runs wrong.

Four things came out of building the way in.

**Dropping a file on the canvas navigated the browser to it.** No handler
existed anywhere on the route, so the default action ran: the app was replaced
by a picture of the file, and whatever was on the canvas went with it. The graph
is saved, so nothing was permanently lost — but the gesture people try first
took them out of the application, and nothing in the app had ever said no to it.
`dragover` is prevented across the whole workspace now, which is true whatever a
drop then means.

**One tool was giving two answers, decided by which route the bytes took.** A
file dropped on a tool page was decoded with a lenient `TextDecoder` gated on
the content sniff; the identical bytes arriving on a wire went through the
strict UTF-8 decoder the [port audit](docs/architecture.md#the-port-set) had
introduced. So a Latin-1 file was processed as replacement characters on one
route and refused on the other. That is the same class of drift the audit
existed to remove, one level down: not which types a port accepts, but what
happens to the bytes once they are accepted. Both routes go through
`decodeDocument` now, and putting the file rules in one module is what made the
disagreement visible at all.

**The tool page read every file twice, and mixed the two reads.** It read the
whole file to sniff it, threw the bytes away, and read it again on every press
of Run — so a 60 MB image was pulled into memory twice per run. Worse than the
cost: the sniff came from the first read and the bytes from the second, so a
file edited on disk between them would have been processed under the previous
file's verdict about what it was. One read now, and the value it produces is
built and validated against its port at that moment, which is what lets both
routes hand it straight to the engine without re-checking anything.

**A migration was stamping the wrong version.** Migrations chain: each step
rewrites the payload and hands it back to the dispatcher, which reads the
`version` it finds. The v4 → v5 step wrote `CURRENT_GRAPH_VERSION` rather than
the literal 5 — correct for exactly as long as it was the last step in the
chain, and wrong the moment a v6 was added, because a v4 save would have claimed
to have had the v5 → v6 step run over it and skipped it. Nothing was broken
when it was written; adding a step to the chain is what would have broken it,
which is the kind of latent defect only turns up when somebody reads the chain
because they are about to extend it.

And one thing that was measured rather than reasoned about: **a 64 MB binary
dropped on a text-only port was read into memory in full and then refused.** The
sniff needs the first 4 kB — twelve bytes for the signatures and 4 kB for the
is-this-text heuristic — so the verdict was available from a slice all along.
`fileInput.test.ts` asserts that the slice and the whole file give a
byte-identical verdict, and that the whole file is never read when the sniff has
already refused it, because "it reads less now" is not something a test of the
answer can see.

The persistence and share-link answers are decisions rather than findings, and
both are written down with what was rejected in
[architecture.md](docs/architecture.md#a-file-as-an-input): a file lasts as long
as the tab, a reload names the file it needs again, and a link carries no
filename at any size.

### Where each kind of test lives

jsdom has no layout engine, no Worker, no `OffscreenCanvas` and no pointer
events. Anything about geometry, overflow, computed colour, or whether
something actually scrolls is asserted in
[`scripts/cross-browser-check.mjs`](scripts/cross-browser-check.mjs) against
Firefox and WebKit instead — where it drags a node with real pointer events,
runs a tool in a real worker, converts a real PNG, drops a real file on a node
through a real `DataTransfer`, scans every route with axe, goes offline and
reloads, and asserts nothing left the origin.

The file input is a good example of the split earning its keep, and of the
harness's own fixtures needing the same scrutiny as the code. Three of its
checks failed on their first run, all three for reasons in the check rather than
in the app: two share links were passing `webp` for an option that takes a media
type, so the node failed on its options and the file never came into it, and one
compared a SHA-256 against a node summary that is deliberately truncated to 60
characters because it is also the node's accessible name. The check that noticed
none of this was a negative assertion — "the summary is not the guidance" —
which `Those options are not valid for this tool.` satisfies perfectly well. It
asks for the report's own arrow now.

That split is not tidiness. A serious accessibility bug — the shortcuts dialog
scrolled but nothing could focus it, so a keyboard user could not read past the
fold — was found by axe in a real browser and is structurally invisible to
jsdom, because whether a box scrolls is a question about layout.

### The third tier, and the trap in it

A few things are reachable by neither, and they are listed in
[docs/manual-checks.md](docs/manual-checks.md) with a checklist each rather than
a suggestion to try it on a phone: Safari itself, a real on-screen keyboard, a
genuinely backgrounded tab, and pasting into Word.

The trap is that "the harness cannot do this" is easy to say and expensive to
be wrong about. The soft-keyboard check is the cautionary example. It was
described as running the same arithmetic on a different event, by shrinking the
window — and a window resize moves the layout viewport and the visual one
together, so the inset it computed was **zero every time**. It would have passed
against a build with no keyboard handling at all. The fix was not more effort in
the same direction but a different one: `visualViewport.height` is a prototype
accessor, an own property shadows it, and dispatching the real `resize` event on
the real object produces the one condition a keyboard produces and a window
resize cannot. Two tabs racing over one `localStorage` key went the same way —
two pages in one browser context _is_ a second tab, and it had gone unreproduced
because it was filed under "decided" rather than "untested".

So the rule is: before writing something down as unreachable, say precisely what
the mechanism is, and check whether the mechanism can be produced separately
from the thing that usually causes it. A hidden tab cannot be produced; late
timers, which is all a hidden tab does to this app, can be.

## Performance

All figures from the production build, measured in Firefox on a desktop
machine. They are not a benchmark against anything; they are here so the claims
in this file have numbers behind them.

### Bundle

|                                          | Raw      | Gzipped  |
| ---------------------------------------- | -------- | -------- |
| Initial JavaScript                       | 329.3 kB | 106.6 kB |
| Budget (enforced by `pnpm bundle:check`) | 380.0 kB | —        |

Every tool, the canvas, the styleguide and the tool pages are lazy chunks and
none of them are in that figure.

The node inspector reuses the tool runner's options panel and output views, so
those moved into a chunk both routes share rather than being duplicated:

|                             | Before                 | After                  |
| --------------------------- | ---------------------- | ---------------------- |
| Initial payload             | 328.0 kB / 106.2 kB gz | 328.0 kB / 106.1 kB gz |
| Canvas route, first load    | ~135 kB                | ~214 kB                |
| Tool page route, first load | ~191 kB                | ~194 kB                |
| Shared `toolrunner` chunk   | —                      | 64.8 kB / 20.9 kB gz   |

The canvas pays about 79 kB raw (~24 kB gzipped) more on first load, all of it
the five output views and the options panel, and a visitor who opens both
routes now downloads them once instead of once per route. Deferring the views
behind a second dynamic import was considered and rejected: a canvas exists to
produce output, so the deferral would last seconds and buy a loading state
nobody wants in a 320px panel.

The file input cost the initial payload nothing at all, and that is a property
of where the code sits rather than of how small it is: the shared file rules are
in the `toolrunner` chunk both routes already load, the canvas's half is in the
canvas chunk, and the document field is a type. Checked rather than assumed —
neither initial chunk contains a byte of either.

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

**Build your own theme there too.** The editor on `/styleguide` overrides the
same semantic tokens the presets use — nothing else is themable, by
construction — with a native colour picker and a text field that accepts hex,
`rgb()`, `hsl()` and `oklch()` through the colour tool's own parser. Changes
apply to the whole page as you make them, so you are editing against the real
component gallery rather than a swatch. Themes are saved locally, exported and
imported as JSON, and never leave the machine.

Values are stored as hex and only hex, which is a security boundary rather than
a style rule: a custom property will happily hold `url(...)`, and a token used
in a `background` would then make a network request out of an application whose
whole premise is that it makes none. [docs/theming.md](docs/theming.md) has the
rest, including why the editor is deliberately painted by the theme it is
editing and why themes are not shareable by URL.

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
the main thread and produces an identical result. That is asserted rather than
claimed: Playwright's WebKit has no `OffscreenCanvas` at all, so the harness's
whole image suite — colour fidelity, transparency, orientation, downscaling —
runs down the fallback path in one engine and the worker path in the other, and
the harness also asserts which branch was actually taken.

**The Safari caveat, stated plainly.** `pnpm check:browsers` runs Firefox and
Playwright's **WebKit** — the engine behind Safari, not the Safari application.
It is the closest a non-Mac machine gets, and it is not the same thing: WebKit
via Playwright differs from shipping Safari in its release cadence, its
media stack, and some of its platform integration. Two consequences are
already documented in the harness — `upgrade-insecure-requests` is applied to
loopback in WebKit where Chromium and Gecko exempt it, and Playwright's WebKit
build cannot navigate at all while offline, so the offline reload check is
explicitly skipped there rather than silently dropped.

There is a third, and it is the one worth knowing: **Playwright's WebKit has no
`OffscreenCanvas` at all, and real Safari has had it since 16.4.** So the image
tool's _worker_ path has never run in any WebKit this repository can drive — it
is exercised only in Firefox, and WebKit only ever proves the main-thread
fallback. That is the first item on
[docs/manual-checks.md](docs/manual-checks.md#1-safari-itself), which is six
minutes on a Mac or an iPhone and is what "tested on Safari" would actually
mean. **Patchbay has not been tested on Safari itself.**

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
