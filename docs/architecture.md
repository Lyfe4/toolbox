# Architecture

How a value gets from a text box to a result, and why the pieces are split the
way they are.

- [The shape of it](#the-shape-of-it)
- [The registry](#the-registry)
- [The port set](#the-port-set)
- [Where a value's bytes are](#where-a-values-bytes-are)
- [The execution engine](#the-execution-engine)
- [The worker boundary](#the-worker-boundary)
- [Incremental caching](#incremental-caching)
- [The canvas](#the-canvas)
- [The first screen](#the-first-screen)
- [The node inspector](#the-node-inspector)
- [A file as an input](#a-file-as-an-input)
- [The tool runner page](#the-tool-runner-page)
- [Between tools](#between-tools)
- [State](#state)
- [Build and deployment](#build-and-deployment)

## The shape of it

```mermaid
flowchart TB
    subgraph ui["UI — main thread"]
        input["Typed input<br/>or dropped file"]
        canvas["Canvas<br/>nodes and wires"]
        runner["Tool runner<br/>the plain list view"]
    end

    subgraph core["Core — main thread"]
        manifest["Manifest<br/><i>eager</i><br/>ids, ports, names"]
        loader["Loader<br/><i>lazy</i><br/>dynamic import per tool"]
        engine["Execution engine<br/>topological order,<br/>cache keys, concurrency"]
    end

    subgraph worker["Web Worker"]
        protocol["Message protocol"]
        impl["Tool implementation<br/>run(input, options)"]
    end

    input --> canvas
    input --> runner
    canvas --> engine
    runner --> engine

    manifest -.->|"ports, limits,<br/>no tool code"| canvas
    manifest -.-> engine
    engine -->|"cache miss"| loader
    loader -->|"import()"| protocol
    engine <-->|"structured clone,<br/>buffers transferred"| protocol
    protocol --> impl
    impl -->|"ToolResult<br/>ok or error, never throws"| protocol

    engine -->|"result + status"| canvas
    engine -->|"result + status"| runner

    style worker fill:#00000000,stroke-dasharray: 4 4
```

Two things are load-bearing in that picture:

1. **The manifest is eager; implementations are not.** The canvas, the search
   box and the port-compatibility checks all need to reason about tools without
   loading a single line of their code.
2. **Nothing crosses the worker boundary as an exception.** A tool returns a
   `ToolResult` describing success or failure. A thrown error is a bug in the
   harness, not a way to report bad input.

## The registry

Two files describe every tool, and a test stops them disagreeing.

[`manifest.ts`](../src/features/registry/manifest.ts) holds the eager half: id,
name, summary, category, keywords, input and output ports, execution strategy,
size limits, and which option keys hold secrets. It is in the initial bundle.

[`loader.ts`](../src/features/registry/loader.ts) maps each id to a dynamic
`import()`. Each tool is therefore its own chunk, fetched when a node is added
or a tool page is opened.

`registry.test.ts` loads every implementation for real and asserts the two
descriptions agree — so a port added to a tool but not to its manifest entry
fails the build rather than producing a node with a missing socket.

### Ports are checked at compile time

A tool's `run` signature is _derived from_ its declared ports:

```ts
// A tool declaring a `bytes` input cannot be implemented with a function
// that expects a string — the type of `run` is computed from `inputs`.
type RunFor<T extends ToolSpec> = (
  input: InputsOf<T>,
  options: OptionsOf<T>,
) => Promise<ToolResult<OutputsOf<T>>>;
```

See [`types.ts`](../src/features/registry/types.ts). The practical effect is
that port compatibility is not a runtime string comparison that someone has to
remember to write — the compiler already refused the mismatch.

## The port set

Every tool declares its input and output ports, and for a long time each
declaration was written when that tool was written and never read beside the
others. The canvas can now show a node's output, which makes the ports the
thing a person reasons about while wiring — so they were audited as a set.
These are the rules that came out of it, and the reasoning is here rather than
in nine files because every one of them is about the set rather than about a
tool.

### The whole set, as it stands

| Tool              | In                                                         | Out                                                                                      |
| ----------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `base64`          | `input` Input · text, bytes                                | `output` Output · text, bytes                                                            |
| `structured-data` | `input` Document · text, json, bytes                       | `output` Converted · text — `data` Parsed data · json                                    |
| `hash`            | `input` Input · text, bytes                                | `output` Digest · text                                                                   |
| `jwt-decode`      | `input` Token · text                                       | `output` Decoded · json                                                                  |
| `diff`            | `original` Original, `changed` Changed · text, json, bytes | `output` Unified patch · text — `changes` Changes · json                                 |
| `regex-tester`    | `input` Subject · text, bytes                              | `output` Result · text — `matches` Matches · json                                        |
| `color-convert`   | `input` Colour · text, color                               | `output` Converted · text — `swatch` Swatch · color — `all` Notations · json             |
| `image-convert`   | `input` Image · bytes                                      | `output` Converted · bytes — `report` Report · json                                      |
| `text-convert`    | `input` Document · text, bytes                             | `output` Converted · text — `rendered` Rendered HTML · text — `detected` Detected · text |
| `video-remux`     | `input` Video · bytes                                      | `output` Repackaged · bytes — `report` Report · json                                     |

### The conventions, and what each one is worth

**A tool's first output is `output`.** It was on eight of the nine and `hash`
called its answer `digest`. That mattered because a node summarises its FIRST
declared output on the grounds that the first port is the tool's answer and the
rest are its working — a rule that was a per-tool lookup rather than something
the shape of the set guaranteed. It is asserted for every tool now.

**A tool with one input calls it `input`; a tool with several names each one.**
`diff` is the only tool with two, and neither of them is "the" input. The
v2 → v3 graph migration had to look a tool's first input port up in the live
registry precisely because this was not something it could assume.

**A port id is an identity; a label is a word for a person.** Ids appear in
edges, in `CanvasNode.inputs` and in share links, so renaming one is a breaking
change with a migration attached — see
[`retiredPorts.ts`](../src/features/canvas/retiredPorts.ts). Labels are free to
improve, and several did.

**A label has 84px and about eleven characters.** `Every notation`,
`Converted image` and `Detected source` were all drawn as a word and a half on
every node that had one. `Rendered HTML` and `Unified patch` deliberately sit
over the budget and take a tooltip instead, because in both the extra word is
information the port's data TYPE cannot carry.

**No label appears twice on one tool.** `color-convert` had an input labelled
Colour facing an output labelled Colour, which on a 224px node is two identical
words with nothing to tell them apart. The input is the one that could not
move: a colour converter's input is a colour.

**Every port has a description, and an output's is now shown.** A port's
description is the only documentation of it that reaches a person, and for an
OUTPUT port nothing on any route read it — an input's is its editor's
placeholder, an output's existed only in the manifest source. The Ports panel
on a tool page shows it. Inputs deliberately do not repeat theirs there, since
their prose is already on the page in the panel where it is acted on.

### A data type earns its place when a port carries it

`DATA_TYPES` held `image` and `datetime` and no port on any tool declared
either. `datetime` was merely dead — a payload shape no test could judge, and a
glyph in the canvas's port legend for a type the canvas could not produce.

`image` was worse than dead. Binary travels as `bytes` everywhere in this app
and the SNIFF says what it is, which is what makes `image-convert → hash` and
`image-convert → base64` legal wires. A separate `image` type would have made
exactly those illegal, and left every future author choosing between two types
for one concept with no right answer.

`color` is the counter-example and the reason the shape is worth having:
`color-convert` really does carry a parsed colour on a port, which is what lets
a colour hop between nodes without a lossy round trip through text.

### Every port that reads a document accepts bytes

This is the audit's main finding, and it was the same finding twice.
`structured-data` widened its document port to `bytes` some time ago and
recorded that refusing them "made the most obvious pipeline in the product
impossible". `regex-tester` and `text-convert` have the same port and had not
had the same fix, so:

- a decoded log file could not be wired into the regex subject, and
- a base64-decoded mail body could not be wired into the text converter.

Both were also inconsistent BETWEEN THE TWO ROUTES rather than merely
restrictive. A tool page has always accepted a dropped text file on either
tool, because the runner decodes a text-sniffed file before handing it over; it
was only the canvas, where the same bytes arrive on a wire, that refused. One
tool that accepts a file in one place and refuses it in the other is drift.

That was half the drift, and the other half was the affordance: the canvas could
not be handed a file at any port, whatever its types said. Both routes take one
now, through one implementation — see
[a file as an input](#a-file-as-an-input).

The two ports that still refuse bytes take a short LITERAL rather than a
document: a compact token and a colour. Their size limits say the same thing —
256 kB and 4 kB.

**Widening a port means refusing clearly, not guessing.** The risk of accepting
bytes is that non-text bytes get decoded to replacement characters and
processed anyway. `diff` did exactly that: two PNGs on its two ports produced a
valid unified diff of two walls of U+FFFD, an answer that looks like an answer
and means nothing. Every document port decodes through
[`lib/text.ts`](../src/lib/text.ts) now — strict UTF-8, with a UTF-16 byte
order mark as the one exception — and names which port could not be read,
because with two document ports "those bytes" is not an answer.

### What was deliberately left alone

**`hash` still refuses `json`.** Wiring `structured-data`'s parsed structure
into it looks obviously useful, and the digest of a STRUCTURE is undefined
until someone picks a serialisation: key order and indentation change the
bytes, so they change the number people compare across machines.
`structured-data`'s `output` port is where that choice is made explicitly, with
`sortKeys` and `indent` to control it. `diff` DOES accept `json`, and the
asymmetry is the point — an indentation choice changes how a comparison reads
rather than whether it is true.

**`jwt-decode` has one output, not a separate `payload`.** A port carrying just
the claims is the thing people would want downstream, and its entire effect
would be to detach the claims from the signature verdict — which is the one
thing this tool's whole design exists to prevent.

**`text-convert` keeps all three outputs.** See below.

**Every input stays required.** No tool in the set does anything useful with a
missing input, and an optional port makes its value `| undefined` in `run`,
which is a question the tool then has to have an answer for.

### `Converted` and `Rendered HTML`, which was the specific question

It was not obvious how `text-convert`'s first two outputs differed when the
target format was HTML. The answer turned out to be two separate things.

**One was a defect.** `rendered` declares "always HTML, sanitised" and there
was no function in the markup pipelines that produced one: `markdownToHtml`
sanitises the HTML it generates, and the other two sanitise on the way to
something that is not HTML. So for an HTML source with any target but Markdown,
the port carried the input string unchanged — `<script>` elements and `onclick`
attributes included. Nothing ran: the preview iframe is `sandbox=""`. What did
happen is that the string went onto the clipboard through Copy as rich text and
out of the port into whatever node was wired to it, which are the two places a
port's promise is all anybody has. `sanitiseHtml` fixes it, and `output` is
byte-identical either way — all three pipelines already sanitised internally,
so it was only the port that was wrong.

**The other cannot be designed away, and the ports are right as they are.**
With a Markdown source and an HTML target the two ports really are the same
string, because converting a document to HTML and rendering it are the same
operation. Both alternatives cost more:

- **One port, presented as HTML only when the target is HTML.**
  `OutputPort.presentation` is static data in the eager manifest, and
  `registry.test.ts` compares manifest ports to implementation ports with a
  structural equality that a function property cannot pass — so "presented as
  HTML sometimes" is not expressible without giving that test up. Making it
  unconditional would draw Markdown output in an HTML preview.
- **A port that appears only for the targets where it differs.** Ports that
  come and go as options change was rejected when the port model was written,
  for a better reason than this one: a node whose shape moves under you while
  you are wiring it.

Losing the preview and the rich-text copy for the other two targets is a much
larger cost than one duplicated string, so the coincidence is stated on the
port's own description instead of being left for someone to find by reading two
identical text boxes. In the other five combinations the two differ, and the
html → html case is the interesting one: `output` is the normalising round trip
through Markdown, `rendered` is the source with nothing but the sanitiser
applied.

**`detected` was considered for removal and kept.** Nobody would sensibly wire
a sentence about a guess, which is the test this project applies to a port on a
224px node. It stays because the alternative is a wrong guess that is
invisible, and this tool guesses on every run by default — a `ToolResult` is a
value or an error, so there is nowhere else for an advisory note to go.
Reshaping it as a `report`-presented JSON port, the way `image-convert` handles
the same problem, would make it properly wireable and no more wired, for one
sentence written for a person.

### Renamed, and what the migration does

| Tool            | Was      | Is       | Why                                                                                                                               |
| --------------- | -------- | -------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `hash`          | `digest` | `output` | The first-output convention above, which is now asserted rather than nearly true.                                                 |
| `image-convert` | `info`   | `report` | The port declares `presentation: 'report'` and is drawn by `ReportView`. Three names for one thing, none of them the word for it. |

Both are breaking changes to documents that already exist, and both are
migrated on both routes — the saved canvas at v4 → v5, and the share link at
v2 → v3. The table lives once, in
[`retiredPorts.ts`](../src/features/canvas/retiredPorts.ts), because three
places need the same answer and a second copy is a bug waiting for whichever
copy someone forgot.

**Not migrating was not an option, and neither was refusing.** An edge leaving
`hash.digest` still leaves a node that exists and arrives at a port that
exists, so nothing refuses it: the engine looks for a value on an output port
called `digest`, finds none, and reports `Nothing arrived on Original` against
the node BELOW — a node that is correctly wired and did nothing wrong. The rest
of the pipeline runs. That is a canvas that works except for the thing it was
built to do, with nothing on screen to say which wire is the problem. And
refusing every old link outright would break real pipelines belonging to real
people for a rename made for tidiness; two of the shipped presets end in a hash
node.

### `checkConnection` now guards the two routes from outside this session

`checkConnection` is the single source of truth for whether a wire is legal,
and it had three callers: the pointer drop, the keyboard flow, and
`validPartnersFor`, which both of those consult. The two routes that build a
graph from OUTSIDE this session — a share link and the saved canvas — had none,
and they are the two that most need one.

[`firstRefusedEdge`](../src/features/canvas/connections.ts) walks a graph's
edges onto a growing copy of it and returns the first one `checkConnection`
would refuse. Edge by edge onto a growing graph is not an optimisation: two of
the refusals are about the edges already present — an occupied input port, and
a cycle — so checking each edge against the finished graph would refuse every
edge for occupying the port it itself occupies.

Both routes now refuse the whole document, with the rejection's own sentence,
rather than applying part of it. Two silent repairs went with that change: the
share decoder used to skip an edge whose endpoint was missing, which
contradicted its own header — a link whose edges half survive IS a half-applied
pipeline, just one where the missing half is invisible — and the graph loader
used to filter the same edges out. `checkConnection` already reads a missing
endpoint as "that port no longer exists", so keeping the edge and refusing the
document gives one rule for every unusable wire instead of a filter in one
place and a check in another.

Nothing in the app can produce such a document: every route into the store goes
through `checkConnection`, and any new command clears the redo branch. This is
a guard against documents from elsewhere, not a state the canvas can reach by
itself.

**The presets are checked too.** A preset names ports as bare strings, which
makes it the one place in the app that can reference a port that does not
exist — and it failed exactly as quietly as the stale share link did. Every
preset wire goes through `firstRefusedEdge` in `ports.test.ts`.

## Where a value's bytes are

A `bytes` value used to be a whole `Uint8Array`, and inside every tool but one
it still is. It carries a **`BinaryData`** now, which says where the bytes are
rather than holding them:

| Kind       | Holds                                  | Where it comes from                     |
| ---------- | -------------------------------------- | --------------------------------------- |
| `resident` | a `Uint8Array`                         | every tool's output that fits in memory |
| `deferred` | a `Blob`, its size, and its first 4 kB | a chosen `File`, or a large tool output |

This exists for one tool and one problem. `video-remux` refused anything over
256 MB, and nearly every file it exists for is larger: a DivX film is 700 MB to
1.4 GB, an hour of tuner recording is 2 to 4 GB, AVCHD clips are split at 2 GB
by the format, and an OpenDML AVI exists _because_ the format cannot address
past 2 GB. What made 256 MB the number was not video. It was that a run held
the input three or four times over.

### Why a blob, and not a stream

The obvious shape for this is a stream, and a stream is the wrong shape, for
two reasons that had both been written down as objections before any of it was
built.

**Inputs are borrowed rather than transferred, deliberately, so one output can
feed several inputs.** A stream that can be consumed once is in direct tension
with that guarantee: the second consumer gets nothing, and on this canvas
twelve consumers on one binary output is a case that is asserted rather than
assumed. A blob is in no tension with it at all — it is immutable and
re-readable, so reading it does not spend it, and a fan-out costs twelve
pointers.

**The result cache holds whole outputs for the life of the tab, and its whole
design is that it never has to look at a value.** A deferred value is a
reference, so that stays exactly as true of a two-gigabyte output as it was of
a two-kilobyte one. Nothing in the cache changed.

And the third property is the one that made it worth doing at all: **a blob
crosses `postMessage` by reference.** Measured in all three engines, handing a
512 MB blob to a worker takes 0.0–6.0 ms, against 294 ms merely to allocate and
fill 64 MB of ordinary memory. The structured clone that used to be the second
copy of the input is not a copy.

### Two classes of tool, and what the other class has to know

The reason this was declined once before is worth keeping: **a streaming value
that some tools handle and others quietly buffer would be worse than an honest
ceiling.** So a tool declares how it reads binary input, and what it is handed
is derived from that — the same mechanism that already derives its `run`
signature from its ports.

| Class      | `run` receives | Tools                      |
| ---------- | -------------- | -------------------------- |
| `resident` | `bytes`        | the other nine             |
| `windowed` | `source`       | `video-remux`, and only it |

A windowed tool's input **has no `bytes` member at all.** That absence is the
whole mechanism: a tool cannot quietly buffer a value it has no way to ask for
whole, and one that declared `windowed` and reached for `input.bytes` would not
compile. The class is a property of the implementation rather than of the
manifest, set by which factory built it — `defineTool` or `defineStreamingTool`
— so the two descriptions cannot drift apart.

**What the resident tools have to know about the windowed one is: nothing.**
That is the design goal rather than a happy accident. A deferred value arriving
at a resident tool is materialised in `eraseTool`, which is the one place in the
app that buffers a whole value on a tool's behalf — and by the time it does, the
engine has already refused anything over that tool's own `maxInputBytes`. So a
resident tool cannot be handed more than the number it wrote down about itself,
however large the value on the wire was. A two-gigabyte video output wired into
`hash` fails as a size refusal naming both numbers, before anything is read.

The places that _describe_ a binary value rather than process it — the sniff,
the node summary, the output panel's preview and its Download button — work on
either kind without knowing which they have. That is what the **head** is for:
the first 4 kB travels beside the reference, which is already this app's idea of
enough to know what something is, since `sniffBytes` never looks further. So
`resultSummary` still runs synchronously during a render against a value whose
bytes are on disk.

### What has a ceiling now, and what does not

Reading no longer has one worth stating. An input arrives as a `File` the
operating system is holding; the tool walks it through a window; nothing
assembles. A 320 MB transport stream is repackaged in 2.4–4.0 s in Gecko
and 3.9–6.0 s in JavaScriptCore, and **the page reads 4096 bytes of it** —
measured in `checkLargeVideo`, by counting `Blob.prototype.slice` and
`.arrayBuffer` on the main thread for `File` receivers. The spread is the
machine's load rather than the file's; a busy laptop took 14.8 s for the same
work, which is still a repackage of a file the tool used to refuse outright.

The **answer** has one, and it is a browser's rather than a choice here. A
download is one blob, and blob storage is not unbounded: assembling 8 MB parts
in a worker and reading the result back after each, Chromium stops at 1.88 GiB
with a `NotReadableError`, while Gecko and JavaScriptCore both went past 4 GiB
without complaint. `MAX_BLOB_BYTES` is Chromium's number because Chromium's is
the one that binds, and the video tool refuses an output over it **before
copying anything**, naming the size and pointing at the audio operation, which
is not affected. A failure at the moment somebody presses Download, after
several minutes of work, is the worst possible place to discover a limit.

Two smaller things follow from the same measurements. A windowed read runs at
868 MB/s in JavaScriptCore, 1149 in Chromium and 4163 in Gecko, through
`FileReaderSync` — the only synchronous way to get bytes out of a blob, and the
reason four container readers did not have to be rewritten as asynchronous
state machines. And it exists **only in a worker**, which is why `ByteSource`
has two implementations and why the unit suite always takes the materialising
one: jsdom has no worker, so nothing in `pnpm test` has ever executed
`FileReaderSync` even once. That is what `checkLargeVideo` is for.

## The execution engine

Given a graph, the engine:

1. **Sorts it** into dependency order, rejecting cycles.
2. **Diffs it** against the previous run's cache keys (below).
3. **Runs what changed**, with independent branches executing concurrently up
   to a bound of 4.
4. **Reports per node**, not per graph.

Statuses are deliberately distinct:

| Status            | Means                                                                                                                   |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `blocked`         | A required input has neither a wire nor typed text. This is the normal state while you are still wiring, not an error.  |
| `error`           | This node failed. It shows why.                                                                                         |
| `upstream-failed` | Something this node depends on failed. It points back at the node that actually broke, rather than repeating the error. |
| `ok`              | Ran, produced output.                                                                                                   |
| `idle`            | Has not run. Also where a node goes when a run is **cancelled** — see below.                                            |

Runs are bounded at 100 nodes: beyond that the run is refused rather than
wedging the tab.

### What the concurrency bound is actually for

There is **one worker, and one thread behind it**. Four concurrent nodes are
not four cores; they are four messages in one queue. So the bound is not about
parallel CPU at all — raising it would not make a pipeline faster. What it buys
is that the worker's queue is never empty (its next tool's `import()` overlaps
the current tool's work) and that a main-thread tool can run while worker tools
are in flight.

What it costs is memory: every in-flight node's inputs are cloned into the
worker, so a large bound means several multi-megabyte intermediates alive at
once, and a longer wait in the queue for each. Four keeps the pipe full at a
small, bounded footprint. It is a scheduling decision, not a parallelism one,
and the earlier description of it here — "four workers' worth of work" — was
simply wrong.

### A deadline measures a tool's own work

The worker sends `started` between importing a tool and running it, and the
engine restarts that request's deadline when it arrives.

This matters because of the paragraph above: several requests posted together
are a queue, and timing a request from the moment it was _posted_ spent its
deadline on other tools' work. A regex node's 2 second limit, queued behind an
image conversion, reported a timeout for work it had not begun.

The timer armed at post time is not simply cancelled, because a request the
worker never acknowledges at all — the worker wedged before reaching it — still
has to fail rather than hang. The practical guarantee is therefore: **at most
`timeoutMs` waiting, then `timeoutMs` running.**

**And `timeoutMs` is now a budget plus a rate**, for the one tool that needed
it to be. A constant was honest while every tool's accepted input was bounded
in the megabytes; `video-remux` now accepts 4 GiB, and a number that fits a
four-minute phone clip strangles an hour of broadcast while a number that fits
the broadcast lets the clip hang for twenty minutes before anybody is told
anything. `timeoutMsPerMiB` is added to the constant from the measured size of
the request's inputs, and the video tool declares 20 — 50 MB/s, an order of
magnitude under the 868–4163 MB/s a windowed blob read was measured at, so the
budget has room for the parsing between the reads. Nothing else changes: the
clock is still restarted when the tool actually begins, so this is still a
budget for the tool's own work rather than for the queue.

### One node's timeout, and everything else in flight

A wedged synchronous tool cannot be interrupted from inside. The only remedy is
to destroy the worker and build a new one — and that takes down every _other_
request that happened to be in flight.

Those requests are **replayed onto the fresh worker**, not failed. A tool is a
pure function of its inputs and options, so running it again produces the answer
it would have produced, and reporting a failure on a node the user did nothing
to is the outcome worth avoiding. A base64 node beside a runaway regex used to
sit there for its own full 15 seconds and then report a timeout it never had.

Replay is refused in exactly two cases, both deliberate:

- **The request's buffers were transferred.** They are detached in the sender,
  so a replay would post zero-length views and compute a confident wrong answer
  — worse than the error it was avoiding. In practice nothing in the app
  transfers (see below), so this is a guard rather than a live path.
- **It has already been replayed once.** Otherwise two tools that both wedge
  would loop, rebuilding a worker for the same doomed request forever.

A worker `error` event is treated differently: nothing is replayed. A timeout
tells us exactly which tool misbehaved and that the others were innocent; an
`error` says the worker itself is broken, and a fresh worker built from the same
code would break the same way.

`scripts/cross-browser-check.mjs` drives this in both engines with a real
pattern that really does wedge a real worker. jsdom has no Worker, so the unit
suite can only assert it against a main-thread stand-in.

### Cancellation is not a result

A cancelled node returns to `idle`. It did not fail and it did not run, and
nothing about it is written to the cache.

That last clause is the whole point. A cancellation used to be stored like any
other error, under a key computed from a document that had not changed — so the
next run was a cache **hit**, and the node reported "Cancelled." forever without
ever executing again. Editing the node was the only way out, and nothing on
screen said so.

### Cancelling tells the worker to stop; it does not make it stop

This is the half of cancellation that is about the worker rather than about the
node, and it was missing.

Cancelling settles the caller immediately — waiting on a tool that may never
check its signal is the thing cancellation exists to avoid — and it used to
forget the request entirely at the same moment: entry dropped, deadline
cleared. But a synchronous tool cannot be interrupted from the outside, so a
request that had wedged the worker was still wedging it, and **the deadline
that was just cleared was the only thing in the system that would ever have
destroyed that worker.** Nothing was left holding a reference to a thread
spinning inside `RegExp.exec`.

What that cost is not theoretical, and it is one keystroke away: editing or
deleting a node while a runaway one is in flight supersedes the run, and a
superseded run is cancelled exactly like this. The next run is then posted to
the stranded worker and waits there — with the main thread idle and every node
on screen saying `Running` — until either the wedging tool happens to give up
by itself or the waiting node's **own** deadline expires.

Measured through the whole app, by deleting a runaway regex node mid-run and
then feeding an unrelated base64 node: **10.8 s in WebKit and 4.1 s in Gecko,
against 2.1 s in both** once the cancelled request keeps its deadline. Those
first two numbers are the runaway pattern giving up on its own — JavaScriptCore
and SpiderMonkey abandon it at different points, which is the only reason it is
seconds rather than the bound. The bound, for a tool that genuinely never
returns, is the waiting node's own timeout: 15 seconds for base64, 60 for an
image conversion. A pipeline that appears to hang for a quarter of a minute
with nothing running does not read as a slow tool. It reads as a broken app.

So a cancelled request keeps its deadline. The caller is settled and hears
nothing further — not even progress — but the entry stays until either the
worker answers for it or its time runs out, and if the time runs out the worker
is replaced and the innocent requests beside it are replayed, exactly as for
any other timeout. A cancelled request is never itself replayed: nobody is
waiting for its answer, and on the canvas replaying one is a whole superseded
pipeline executing a second time.

No new number was introduced for this, deliberately. The guarantee is the one
the tool already declares: **a request cannot hold the worker past its own
limit, whether or not anybody is still listening for the answer.** A
cooperative tool releases the deadline as soon as it notices the signal, which
is the usual case and costs nothing.

### What the intermittent worker-wedge failure actually was

`checkPipeline`'s second sub-check failed about one WebKit run in three, and
was filed against the scheduler: _"a scheduled pipeline run is delayed by
around 25 seconds while the main thread sits idle."_ It is worth writing down
that **nothing was ever delayed**, because the shape of the report sent the
investigation at the scheduler twice over, and the scheduler was blameless.

What the check does is type a catastrophic pattern into a regex node, type a
payload into an unrelated base64 node, and then wait up to 25 seconds for each
to reach its expected state. In a failing run the regex node sat at `blocked` —
which is what a node with **no input at all** says — for the whole window, and
the assertion below it read 25 000 ms. That number was not a delay. It was the
poll's own timeout expiring, because the node it was watching had nothing to
run and never would.

The text never reached the node. `fill` puts a value in the box and fires the
events; it does not know whether anything took it, and the canvas's [deferred
focus move](#the-keyboard) took focus off the field between Playwright focusing
it and inserting the text, so the characters went to the close button. Measured: the
saved graph after a failing run holds `regex-tester: {}` — not an empty string,
no key at all, so the store's setter was never called once.

The chain of evidence, in the order it was established:

1. The canvas moves focus to **Close the inspector** one animation frame after
   `Enter`, in both engines. Pressing `Enter` and typing `hello` leaves the
   editor empty.
2. In a failing run the value never enters the graph store, while `fill`
   reports success and the field's `aria-label` still names the right node.
3. Making that frame arrive late — replacing `requestAnimationFrame` with a
   40–90 ms timer, which is only what CPU load does to it — reproduces the loss
   directly, with focus observably on the close button and the field empty.
4. Interposing one extra round trip between locating the field and filling it,
   which lets the frame land first, took the failure rate from 2 in 18 to 0 in
   46 without changing anything else.
5. With the focus move fixed: 25 consecutive clean runs under the same load
   that produced the failures.

Two things follow for the harness rather than for the app. `typeInto` now
**verifies that what it typed arrived** — the editor is a controlled field, so
the box still holding the text a moment later is proof the graph has it — and a
precondition that can fail quietly is a check that blames the wrong thing
twenty-five seconds later. And the `Enter`-into-the-editor behaviour is asserted
directly, in both the unit suite and `check:browsers`, so it is a named failure
rather than a symptom somewhere else.

### Where else a long unexplained wait can come from

The failure a user experiences as the product being broken, rather than as an
error, is a wait with nothing on screen to explain it. Three were found in this
pass, and they are the ones worth keeping in mind when this code changes:

- **A cancelled request stranding the worker** — fixed above; measured at 10.8
  seconds of `Running` with nothing running, bounded only by the waiting node's
  own timeout.
- **A tool running twice** — see the worker boundary; it doubles every wait in
  Safari rather than creating one.
- **Main-thread image conversion**, which blocks its own deadline and everyone
  else's. Already recorded under [known
  limitations](#known-limitations) and unchanged.

Two more were looked at and found sound. A run superseded mid-flight can leave
the previous `runPipeline` winding down beside the new one, sharing the result
cache — but a cancelled node writes nothing to the cache and every emission is
gated on the run token, so the worst case is a wasted re-run rather than a
stale answer. And a node whose upstream produced nothing reports `blocked`
rather than waiting: the pump resolves when nothing is active and nothing is
ready, so there is no state in which the graph is waiting on a value that
cannot arrive.

## The worker boundary

Tools with `strategy: 'worker'` run off the main thread. The protocol is a
small tagged union — request, result, error — and the engine owns a single
shared worker rather than spawning one per run.

Binary payloads are `Uint8Array` or `Blob`, never base64 strings internally.
Base64 is a display format; using it as a transport triples memory and costs a
copy in each direction.

Buffers travel in one direction transferred and in the other copied, and the
asymmetry is the point.

**Outputs are transferred** back from the worker: nothing in there reuses them,
so moving ownership is free. **Inputs are borrowed** — structured cloned — from
every call site in the app, because on a canvas one output feeds several
inputs, and a transferred buffer would be detached by whichever consumer ran
first, leaving the rest with a zero-length view and no error to explain it.
`ownership: 'transfer'` exists for a caller that can prove single consumption;
nothing currently passes it.

A detached buffer produces a zero-length result several steps later, which is a
miserable thing to debug, so the fan-out case is asserted on the actual bytes
rather than on the shape of the result — twelve consumers, past the concurrency
bound, each checked against a known digest.

**None of that applies to a deferred value, and it needed no exception to be
carved for it.** A blob crosses `postMessage` by reference, so there is no copy
for a transfer to save and no buffer for one to detach; `collectTransferables`
simply finds nothing to collect. The list of transferables is about the
resident values, which are the small ones. See [where a value's bytes
are](#where-a-values-bytes-are).

Where `OffscreenCanvas` is unavailable, image work falls back to the main
thread and produces an identical result. `scripts/cross-browser-check.mjs`
asserts which branch was actually taken, so the fallback cannot rot unnoticed.

### The worker's entry is also a library, which ran every tool twice in Safari

`worker.ts` is the module the worker is constructed from, and it registers a
`message` listener on its global scope. It is also a **shared chunk**: the tool
chunks it dynamically imports import it back for the registry helpers Rollup
placed alongside it, and the page's own bundle imports it for the same reason.
An entry that doubles as a library gets evaluated in places nobody meant it to
be, and a global side effect run twice is not idempotent.

Both places turned out to be real, and neither was visible from any test that
looked at answers:

- **In the worker**, JavaScriptCore evaluated the entry a second time when a
  tool chunk imported it, so `message` had two listeners and **every request
  ran its tool twice**. Measured over a base64 → structured data → hash chain
  in Playwright's WebKit: two `started` and two `settled` for every one
  `execute`, from the first run on a fresh worker. Gecko evaluates it once and
  was always clean. Nothing was ever _wrong_ — a tool is a pure function, so
  the second answer equals the first and the engine drops it as a late reply to
  something already settled — it simply cost twice the CPU and twice the peak
  memory of every worker tool in Safari, which for a 20 MB image conversion is
  the whole difference.
- **On the main thread**, `self` is the window, so the same evaluation put a
  `message` listener on the _page_ that would run a tool for anything able to
  `postMessage` to it. Nothing can today — the one iframe in the app is the
  `sandbox=""` preview, which cannot script — but a page whose entire promise
  is that nothing you paste leaves it should not carry an unintended global
  entry point to its own executor.

The listener is registered once now, guarded on the global scope rather than in
module scope: two evaluations are two module scopes, and the thing that has to
be unique is the listener on the one global they share. It is also skipped
entirely outside a worker.

This is a build shape as much as a code one, and the check that would catch it
coming back is a **count** rather than an assertion about a result:
`checkPipeline` now counts `started` messages against the `execute` messages
posted, because no assertion about an answer can see a pure function run twice.

## Incremental caching

Each node has a cache key built from:

- its tool id,
- its options,
- its typed input, and
- **for each wire arriving at it: which input port it arrives at, which output
  port it leaves from, and the upstream node's cache key — never its value.**

That last choice is the whole point. Comparing upstream _keys_ is O(1)
whatever the data is, so a 30 MB decoded file never has to be hashed to know
whether it changed. Hashing values would make every run cost a pass over every
intermediate result, which is precisely the work the cache exists to avoid —
the cache would get slower exactly as the data got bigger.

The trade is that a key is an identity, not a fingerprint: two different
routes to the same bytes get different keys and both run. For a graph a person
wired by hand, that is a rounding error.

**The wiring is part of the identity**, and it was not always. The key used to
be the sorted _set_ of upstream keys, which cannot tell apart two graphs that a
person would never confuse:

- Swap the two wires into a `diff` node. The set is unchanged, so the cached
  patch is served for the reversed comparison — a well-formed unified diff with
  its two sides the wrong way round.
- Move a wire from a tool's `output` port to its `data` port. Same upstream
  node, entirely different value; the set is unchanged again, so the previous
  port's answer is served for the new one.

Both produce output that is confident, well formed and stale, which is the
worst failure a cache can have: nobody reports it, because nothing looks wrong.
Order within the key is normalised on the _receiving_ port, so the order edges
happen to sit in the document still cannot change it.

Two things are **not** cached, and both are deliberate:

- **Cancellations.** See the engine section above.
- **Nodes that no longer exist.** The cache is keyed by node id and holds whole
  outputs, so an entry for a deleted node would hold that node's decoded file
  for the life of the tab. Entries are pruned at the start of each run, which is
  the one place that sees both the cache and the graph it belongs to.

**A deferred value in the cache is a reference and not a file.** The cache's
design rationale — that it never has to look at a value — is what made this
survive the change to the value model untouched: an entry holding a
two-gigabyte repackage holds a blob handle, and the bytes behind it are the
browser's problem rather than the tab's. The pruning above still matters for
exactly the same reason it did, because a handle nobody drops is a file nobody
frees.

Editing one node re-runs that node and its descendants, and nothing else.
Typing is debounced, so a pipeline re-runs once you pause rather than once per
keystroke.

## The canvas

Hand-built — no React Flow — and lazily loaded, so a visitor who only opens
`/tools` never downloads it.

**Coordinates.** The plane is a 0×0 box with a `transform`; the transform _is_
the coordinate system, not a box that contains anything. Two consequences:
`reset.css`'s `svg { max-inline-size: 100% }` collapsed the wire layer to
nothing inside it (100% of zero), and the wire layer needs
`max-inline-size: none` and `overflow: visible` to paint outside its own
viewport.

**Input.** Wheel handling is a single non-passive listener on the canvas root,
batched into `requestAnimationFrame`. It is _not bound at all_ while an overlay
is open — overlays render inside that root, so a bound-and-guarded listener
would still cancel the dialog's own scrolling. The inspector is not an overlay
and is not inside that root; see
[the note on why](#it-is-a-sibling-of-the-canvas-not-a-child-of-it).

### One listener, three pointing devices

A mouse wheel, a trackpad two-finger scroll and a trackpad pinch all arrive at
that one listener, and the numbers they arrive in differ by about fifty times.
The arithmetic that reconciles them is in
[`wheel.ts`](../src/features/canvas/wheel.ts), DOM-free and unit-tested, for the
reason `pinch.ts` is.

| Gesture                      | What the engine reports                                                                                                      |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Mouse wheel, Chromium/WebKit | pixels; conventionally 100 per detent, but scaled by the OS "lines to scroll" setting, so 33, 40, 53⅓, 120 and 400 all occur |
| Mouse wheel, Firefox         | **lines** — `deltaMode` 1, three of them per detent                                                                          |
| Trackpad pinch               | pixels, synthesised as ctrl+wheel: a stream of one- and two-pixel events, several per frame                                  |

This used to be one expression, `exp(-deltaY * 0.01)`, and that coefficient is
correct — for a trackpad. It is the convention Chromium and WebKit scale their
synthesised pinch deltas against, so a two-pixel event moved the zoom by 2%.
Handed a mouse detent's hundred pixels it returns **e**: one notch of the wheel
multiplied the zoom by 2.72, the reachable scales were 33%, 90% and 250%, and
three notches spanned the whole range. In Firefox the same detent arrived as
`deltaY: 3` and moved the zoom by 3%, and the pan — which used `deltaY` raw —
moved the canvas three pixels where Chrome moved it a hundred.

Two steps fix all of it, and neither of them sniffs the device:

1. **Normalise to pixels once.** `deltaMode` says which unit, and one detent is
   100 pixels or 3 lines, so the conversion between them is fixed by the
   requirement that a detent pan the same distance in every engine. Pan uses the
   result directly.
2. **Convert pixels to notches, then cap at one notch per event.** The rate is
   the trackpad's — 12 pixels per notch, from `100 · ln 2 / 6` — and the cap is
   the mouse's. Every detent, in every engine and at every OS setting, is over
   the cap, so every detent is exactly one notch. Every trackpad event is a
   fiftieth of a notch and never reaches it, so a pinch stays continuous. The
   magnitude separates the devices on its own.

A notch is `2^(1/6)`, about 1.12. Six notches double the zoom, twenty cross the
whole 0.25–2.5 range, and the ladder passes exactly through 200%, 50% and 25% —
so the round scales are reachable rather than lucky. `+` and `-` walk the same
ladder two notches at a time, which is three presses per doubling; before them
there was no way to zoom from the keyboard at all, only `0` to reset and `F` to
fit.

**Notches accumulate; the pointer does not.** The pending buffer used to hold a
factor and be _assigned_ on every event, so of the several events that arrive
between two frames only the last one's zoom survived. Notches are additive —
summing them and exponentiating once is the same answer as multiplying the
factors, and only one of the two can be written as `+=` — so a trackpad firing
three times a frame now contributes all three. The pointer is the last one seen.

### What changes about the grid with scale

The grid is a background image on the static root, not scaled geometry, and
there is **one tile per axis** at the major square's size with every subdivision
drawn inside it as a percentage. That is the phase-lock fix: two separately
tiled layers — a 7.2px minor and a 57.6px major at 90% zoom — are rounded to
device pixels independently and stop agreeing about where the eighth line falls.
Fractions of a single tile cannot. There is now one `background-size` and one
`background-position` for all eight layers, which the value lists repeat to
cover, so there is no second number left that could diverge.

A grid at a fixed world pitch cannot read the same at every zoom, though: `GRID`
world units is 2px apart at the minimum and 20px at the maximum, and a hairline
every 2px is a tone rather than a grid. **Something has to change with scale,
and what changes is which world level is drawn** — never the ink and never the
weight. A square just means more world when you are further away.

- **The major square never moves.** `GRID * 8` world units at every scale, so a
  major square always means the same thing — eight snap steps — and the
  reference does not change under the user mid-zoom.
- **Three subdivisions inside it** — halves, quarters, eighths of the major
  square, which is 32, 16 and 8 world units. They come and go, and they only
  ever appear _between_ rules already on screen.
- **The ladder only coarsens**, and that is forced rather than chosen. Nodes
  snap to `GRID`, so a rule finer than `GRID` is a line nothing can land on.
- **A level is fully inked once its on-screen pitch reaches `GRID` pixels** —
  the pitch the grid is authored at, which is what one square looks like at 100%
  zoom — and not drawn at all below half that, where the ink doubles to 25%
  coverage and the rules stop resolving as lines.

Both ends of that band are derived, and the factor of two between them is what
does the real work: the levels are themselves an octave apart, so a
one-octave transition band can hold only one of them. **At most one level is
ever part-drawn.** The grid has one soft edge at a time rather than a general
haze, and the finest fully-drawn rules stay between 8 and 20 pixels apart across
the entire zoom range. `grid.test.ts` asserts each of those as a property over a
sweep of the range, including that one notch of the wheel cannot switch a level
on or off — the fade exists because a pop would undo the point of having made
the zoom continuous.

What this replaced was `opacity: zoom < 0.5 ? 0.4 : 1` on the whole layer, which
is the wrong variable twice over: it dimmed the entire canvas at 33% instead of
thinning the grid, and it said nothing at all about the other end.

**And the ink is its own pair of tokens.** The minor rules were
`--pb-border-subtle`, which is specified against `--pb-surface-raised` — a
decorative rule inside a panel. Against `--pb-surface-sunken`, which is what the
canvas is, it measures 1.26:1 in graphite and **exactly 1.00:1 in vellum**, where
the two tokens resolve to the same paper shade. A line at 1.00:1 is not a faint
line, it is no line; what hid that is that at 90% the rules were 7.2px apart and
a field of near-invisible hairlines that dense sums into a perceptible tint. So
the grid appeared to work at the zoom people looked at, vanished when the rules
spread out, and washed out when they closed up — one cause, three symptoms, none
of them looking like a colour problem. `--pb-canvas-grid-minor` and
`--pb-canvas-grid-major` are held to a _range_ against the backdrop by
`grid.contrast.test.ts`: a grid rule can fail by being too loud as easily as by
being too quiet, which is the one contrast assertion in this repo that is not
"at least".

A pointerdown on the toolbar or the status readout no longer clears the
selection. Both render inside the canvas root, so a press on either arrived as
"not a node" and threw the selection away as a silent side effect — survivable
while nothing on screen depended on the selection, and not survivable the moment
one of those buttons was the inspector toggle, which deselected the node and
then opened a panel reporting that no node was selected.

**Undo/redo** is a command history, not a stack of snapshots. Each mutation is
a small object holding just enough to do and to undo it. Memory is proportional
to the change rather than to the graph, a drag coalesces into one step — and so
does a run of typing into an option, for [the same reason](#typing-an-option-is-one-undo-step) — and
each entry can describe itself for the live region ("Undid move 3 nodes").
The price is that every command needs a correct inverse, which `graph.test.ts`
checks by applying and reverting each kind and asserting deep equality.

**Accessibility** is structural rather than added: the canvas is a
`role="application"` region so single letters reach it, each node is a
focusable `role="group"` whose accessible name states tool, position,
connection count, status, result summary and selection, and the tab order is
the DOM order, computed spatially. The
[inspector](#the-node-inspector) is a landmark outside that region, so a text
field in it never has to compete with the canvas for a keystroke. See the
[keyboard map](../README.md#accessibility) and
[the connect flow](../README.md#connecting-two-tools-without-a-pointer) in the
README; the flow has two entrances - `C` on a focused node, and the node's own
Connect button - and they are the same flow, not two.

### One flow, two entrances

The connect flow had a pointer route — drag a port — and a keyboard route,
`C` on a focused node. `C` is also the **documented way to read a port label
the node has truncated**, because a node is 224px wide, a port label is capped
at 84px of it, and the chooser lists every port by its full name. The port
tooltip is deliberately not that fallback: it opens on hover and on focus, and
[`PortButton`](../src/features/canvas/PortButton.tsx) explains why it does not
open on tap — a port's primary gesture is dragging a wire out of it, and a card
appearing under the finger that starts the drag is in the way.

Which left the fallback unreachable on the device where labels truncate most.
Nothing was blocked: a finger can drag a wire, fiddly but workable, and pinch
makes it easy. The escape hatch was simply fiction.

A node that is the sole selection now draws a **`Connect` button**, and it is
handed `beginConnectFrom` — the identical function the `C` branch of the key
handler calls. Not a second implementation of "which port, then which
partner": `nodeActions.test.tsx` walks both entrances over one graph and
compares the wire each produces, for the reason
[`firstRefusedEdge`](#checkconnection-now-guards-the-two-routes-from-outside-this-session)
exists — two routes to one graph that agree today are two routes that disagree
later.

**Below the node, not in it.** Every shared control grows to 44px on a coarse
pointer, and a node has no band that can absorb that: the header is 24px, the
footer is 24px, and both are numbers `nodeHeight` adds up in `geometry.ts` to
place the wire anchors. A finger-sized button in either would repeat the Panel
title-bar defect the mobile audit already found — a button drawing through its
own container's border — and move every wire landing on the node besides. It is
absolutely positioned outside the node's box, so it is not in the node's layout
at all and its height is nobody else's business.

The cost of that is honest and small: the canvas root clips, so a node whose
bottom edge is off screen has its button off screen too. That is the same
condition under which the node's own footer is already unreadable, so it is not
a new class of unreachable — if you can see the whole node you can see its
button, and `checkTouch` measures exactly that after a Fit.

**Only when it is the sole selection.** Not `selected`: three selected nodes
would draw three buttons each offering to connect "from" one node while Delete
and the arrow keys acted on all three. And not _always_, because 224px of node
is not somewhere to put permanent chrome — scoping it to the selection is what
paid for hanging it outside the box, since at most one is ever on the plane.
Tapping a node already selects it, so this is the second tap of a two-tap
gesture rather than a mode to discover.

**At every pointer type, not only a coarse one.** `pointer: coarse` is not "no
keyboard" — it is true of a tablet with a keyboard folded onto it and false of a
mouse user who has never opened the shortcut list, and connecting was
undiscoverable for the second group too. Scoping to the selection had already
paid for the space, so a media query would only have hidden the fix from half
the people it is for, and put a JavaScript copy of a breakpoint beside a CSS
one — see [the note on `railFits`](#a-phone-where-a-side-panel-and-a-canvas-cannot-both-have-the-screen)
for what that costs.

**Straight into the flow, not into a menu of node actions.** A menu was the
obvious alternative, because it would have closed three gaps rather than one:
Delete and Duplicate are still keyboard-only. It was rejected on the geometry.
A popup anchored to a node lives inside the pan-and-zoom plane, so it scales
with the plane, and the root clips it — and the toolbar's own overflow menu
carries a written note about being anchored to the _bar_ rather than to its
trigger precisely because a panel hung off a small control escaped the viewport
on both sides. A node is smaller than that trigger and can be anywhere. Delete
and Duplicate need a home that is not inside a transformed plane, and picking
one is a separate decision from making the connect flow reachable.

**Called `Connect`, with a word and not only a glyph.** An unlabelled icon
carrying information is the one thing the rules here refuse outright — it is why
a paperclip badge was rejected for the file summary on a node. The accessible
name is `Connect from <tool>`, because "Connect" read out of a list of controls
does not say connect _what_; the visible text stays `Connect`, which is what
keeps 2.5.3 Label in Name satisfied.

**Two things had to be fixed for the tap to work at all**, and neither was
visible to jsdom:

- A pointerdown inside a node begins a move and **captures the pointer on the
  canvas root**, and a captured pointer retargets its own `pointerup` and its
  `click` to the capture element — so the button's click would never have been
  dispatched. The root already had this escape hatch for the toolbar
  (`data-canvas-chrome`); the node's own control has its own
  (`data-node-action`), because the two want different things afterwards: a
  press on the toolbar must not disturb the selection, while this control only
  exists on a node that is already the sole selection.
- `pointerdown` on a chooser row was cancelled unconditionally, to keep focus
  in the search field. **WebKit routes a cancelled `pointerdown` down the same
  path as a cancelled `touchstart` and suppresses the synthesised click**, so
  every tap on a tool in the palette or a port in the connect flow did nothing
  at all. It survived because the harness pressed those rows with
  `locator.click()`, which is a mouse even in a context built with `hasTouch`;
  `checkTouch` now taps one with the real touchscreen, where the engine decides
  whether a click follows.

And one that was not about the tap at all. The canvas is a
`role="application"` region, so it claims every single letter — and that claim
reached controls rendered inside it. `Enter` would have taken the Connect
button away and opened the inspector instead, and `Space` had **already** been
cancelling on the way to every button in the toolbar: a `<button>` is activated
by `Space` on keyup only if the keydown's default action survived, so "Add
tool", "Fit", "Undo", "Redo", "Share" and "Shortcuts" could each be focused and
none could be pressed with it. Those two keys now belong to whatever control
has focus. Only those two: an arrow key still nudges the node whose button has
focus, because a button does nothing with an arrow key. Ports are excluded by
name — they are `<button>`s with `tabIndex={-1}` that a click still focuses,
and yielding `Enter` to one would mean `Enter` did nothing there.

**What a touch user could not reach, when this was written.** The keyboard map
covers undo, redo, fit, the palette, delete, duplicate, select-all and the
reference overlay. Undo, redo, fit, the palette and the overlay all have
visible controls. Delete, Duplicate and Select-all did not — on a phone you
could add nodes to a canvas and never remove one, which was a larger hole than
the connect flow had been. It was left deliberately, on the grounds that Delete
needed somewhere to live that is not a popup inside a transformed plane, and
that a destructive control needs its undo more visible than the third item of
an overflow menu. Both points stood, and both are answered in
[the section below](#deleting-things-without-a-keyboard).

### Deleting things without a keyboard

The gap above got worse the moment connecting became tappable, and the
combination is what made it blocking rather than merely incomplete:
`checkConnection` refuses a second wire into an occupied input and says to
remove the existing one first, and removing a wire needed `Delete`. So a finger
could wire two tools together in three taps and then be permanently unable to
rewire them.

**Wires were worse than that, and not only on touch.** Nothing on the keyboard
has ever put an edge in the selection — `Ctrl+A` selects nodes, `Shift+Enter`
toggles a node, and the wire layer's own `pointerdown` is the only thing in the
application that writes `selection.edges`. So `Delete` could only ever remove a
wire a POINTER had selected by hitting a 1.5px curve. Wire removal was
pointer-only at every input type, and that had not been noticed because the
touch audit was looking for missing buttons rather than for missing selections.

#### Where the affordance lives: a selection bar in the canvas chrome

Whatever is selected draws a bar of controls — the count, `Select all`,
`Duplicate`, `Delete` — under the toolbar, outside the pan-and-zoom plane. It
is present at every pointer type, for the same reason the node's `Connect`
button is: `pointer: coarse` is not "no keyboard", and Delete was
undiscoverable for a mouse user who has never opened the shortcut list either.

**Not on the node.** The node's own action strip was the obvious place, and it
cannot work: a wire has no box to hang a control off at all, so half the
problem would be left exactly where it was. The node strip also already carries
`Connect`, and a destructive control one tap from the thing people tap to
select is the wrong neighbour.

**Not a popup anchored to either.** This is the constraint the previous section
recorded and it has not changed: a panel hung off a node lives inside the
plane, scales with it, and is clipped by the root — the reason the toolbar's own
overflow menu is anchored to the _bar_ rather than to its trigger. A node is
smaller than that trigger and can be anywhere.

**Not the overflow menu.** Geometrically fine, since it is anchored to the bar.
Rejected twice over: that menu only exists below 640px, so anything put in it
is a control that does not exist on a desktop — the note above `overflowItems`
is explicit that the two layouts must run the same actions — and a destructive
action behind a tap on a control labelled `More` is precisely the undo-hiding
the earlier note refused.

**Not a long-press.** No discoverable affordance, and it collides with the
gesture a one-finger press already starts, which is a pan.

**At the top, under the toolbar, and it was measured there rather than
assumed.** The bar was built at the bottom first, above the readout, which is
better for a thumb. On a phone the inspector is a **sheet** covering the bottom
60% of the canvas root, and the root spans the whole workspace behind it — so
the bar and the readout both sat underneath it, present in the DOM, 300px below
the sheet's top edge, invisible and unpressable. For the readout that is an old
and survivable cost. For the only control that can delete anything it is the
whole feature gone in the state a phone user is most likely to be in, since the
inspector's open/closed state is remembered across sessions. `checkTouch` now
measures the bar against the sheet's top edge.

The top has a second argument once you are there. The bar appears and
disappears with the selection, and at the bottom it materialises next to the
thumb that is panning — a destructive control arriving under a moving finger. Up
here it appears inside the band already reserved for chrome.

Both bars are children of one absolutely positioned column rather than
positioning themselves, because "below the toolbar" is a relationship the
layout should hold: the toolbar is about 40px tall on a desktop and about 52px
on a coarse pointer, where every control grows to 44px, so any `calc()` would
be right at one pointer type and wrong at the other. The column declines
pointer events and each bar takes them back, so a full-width transparent box
across the top does not eat every pan that starts there.

**Only while something is selected.** Permanent chrome for an action that is
meaningless most of the time is chrome everybody pays for and nobody reads —
and a Delete button that is usually disabled is worse, because a disabled
destructive control still has to be understood before it can be ignored.

#### How a wire is selected by a finger

Three things had to be true, and only the first was.

1. **Something has to receive the press.** Every wire already had an invisible
   companion path with a fat stroke, which is what a pointer actually hits.

2. **That band has to be finger-sized on screen, at every zoom.** It was
   `stroke-width: 14` in plane units, so it was 14px at 100%, 3.5px at the
   minimum zoom and 35px at the maximum — a target whose size is a function of
   the zoom is the wrong size almost always, and it was smallest exactly when a
   wire is hardest to aim at: zoomed out, looking at a whole graph. It is now
   24px on a fine pointer and 44px on a coarse one (2.5.8 and 2.5.5), with the
   zoom divided back out.

   **`vector-effect: non-scaling-stroke` is the property for this and it does
   not work.** It is exactly what the property is for, it computes, and it
   governs painting only: hit-testing walks the untransformed stroke geometry.
   Measured rather than assumed — toggling the property off left the hit region
   byte-identical at 0.5× and at 1×. It would have shipped looking correct,
   because the one thing it does change is invisible on a transparent stroke.
   So `--canvas-zoom` is written on the plane beside its transform and the
   stylesheet divides by it. The pointer rule stays in CSS and the zoom comes
   from JavaScript, which is the one split where neither side keeps a copy of
   the other's number.

   **And the width needs its unit.** `stroke-width` takes a bare number as a
   presentation attribute, so `24` and `24px` read as interchangeable — but the
   division happens in `calc()`, and `calc(24 / 0.36)` is a unitless number in
   a length context. Chromium accepts that and resolves it to pixels. Gecko and
   WebKit reject the declaration outright and fall back to the initial
   `stroke-width: 1`, which is a **one-pixel** grab band on a wire. Both
   engines reported the hit region as 0px wide at 36% zoom on a build that was
   correct in Chromium, and the visible symptom would have been "tapping wires
   doesn't work on my phone" from the two engines every phone actually runs.

3. **The right wire has to win.** A 44px band immediately creates the problem
   it solved: bands that wide overlap wherever wires converge, and they
   converge hardest at a node's inputs, which sit on a 24px pitch. Hit-testing
   hands such a press to whichever band paints last — document order, which is
   to say an arbitrary wire that changes when an unrelated one is added. The
   band now decides only WHETHER a press is a wire press; `nearestEdge` decides
   which, by flattening each wire's cubic and taking the closest. That is the
   rule a person is applying when they aim, it is a total order so the same tap
   always selects the same wire, and it is pure arithmetic, so
   `wireHit.test.ts` can hold it to a graph with the edge order reversed.

   The sample count is measured rather than guessed. A chord always cuts inside
   the curve, so the error is one-sided and a wire can only ever measure as
   slightly further away than it is. A property test walking points off the
   drawn path across the whole addressable plane failed at 24 segments with a
   worst case of 1.0px, which is small but is not the "well under a pixel" the
   first version of the comment claimed; it is 48 now, and this runs once per
   press rather than once per frame.

   **And the press has to be converted to a world point by the one converter
   that already exists.** The first version did it inside the wire layer,
   measuring against that layer's own `getBoundingClientRect()` — reasoning
   that a 1×1 SVG pinned to the plane's origin with `overflow: visible` _is_
   world (0, 0). Chromium reports it that way. Gecko and WebKit return the
   union with the overflowing children, so the "origin" was wherever the
   leftmost wire happened to start, and every resolved point was out by however
   wide the graph was — with the visible symptom being that a tap aimed at a
   wire selected a node.

   `check:browsers` caught it in both engines, which is the whole argument for
   that gate: jsdom returns zeros for every rect, so the unit suite could not
   have told the two approaches apart, and on the machine it was written on it
   worked. The resolver is now supplied by the canvas, through the same
   `screenToWorld` a node drag and a wire drop have always used. A second
   coordinate conversion had no reason to exist.

**What is still only a hairline** is the wire itself. `.wire` is 1.5px in plane
units and `.wireSelected` 2.5px, so at the minimum zoom a selected wire is
under a pixel wide. The selection bar appearing and saying `1 wire selected` is
the feedback that carries the state; making the visible stroke screen-constant
too would change the weight of every wire at every zoom, which is a visual
decision and not this one.

#### How a deletion is reversed

Undo already existed, has a command history behind it, and has a visible
button — on a wide screen. Below 640px the toolbar collapses and Undo moves
into the overflow menu, so on the device where the only way to delete is a tap,
the only way to take it back was three taps behind a control whose label says
nothing about deletion.

**The notification that reports the deletion carries the Undo.** `Deleted
Base64` with an `Undo` beside it, which is why `ToastInput` grew an optional
action. A destructive action reachable by finger needs its reversal offered at
the moment it happens rather than discoverable later, and a toast is the one
surface that is already about "this just happened".

Three details are load-bearing:

- **A single node is named by its tool.** `Deleted 1 item` is true and useless:
  on a canvas of six nodes the question after a tap that deleted something is
  which one, and the answer has to be beside the offer for the offer to mean
  anything. Everything else is counted, because six tool names is a paragraph.
- **A toast with a control stays up for twelve seconds, not six.** Six is fine
  for a message — it is read or it is not. An offer has to be noticed,
  understood as reversible, and reached, and on a phone reaching it means
  moving a thumb to a control that was not there a moment ago. A toast that
  expires mid-reach teaches that the escape hatch is unreliable.
- **The number of history steps to undo is measured, not assumed.**
  `deleteSelection` pushes one command for wires and one for nodes, so a
  selection holding both is two entries and a single `undo()` would restore
  half of it and call that recovery. No gesture can currently select both at
  once — selecting a wire clears the nodes — which is exactly why it is worth
  handling: the guarantee lives in another file's selection rules, and "the
  undo button silently under-restores" is not a defect worth leaving armed
  behind one.

**No confirmation dialog.** A modal per deletion on a canvas people rearrange
constantly is a tax on the common case to protect the rare one, and it does not
even protect it well: a confirmation is dismissed reflexively, whereas an undo
is used deliberately. The [tool runner's own note on destructive
controls](#the-decisions-and-why) takes the same line.

#### Duplicate, Select all, and add-to-selection

**Duplicate falls out.** It acts on the node selection, which is what the bar
is about, and it is not destructive, so it needs nothing beyond the toolbar's
Undo.

**Select all is in the bar, not the toolbar.** It is the one action there that
is not strictly about the current selection, and the alternatives are worse:
the overflow menu does not exist above 640px, and a seventh permanent toolbar
button is what pushed that bar off a 320px screen once already. The
precondition — something must be selected before the bar exists — costs one tap
and is not a real barrier, since nobody wants "select every node" before
touching a node. What it buys is the only way a finger can clear a canvas that
is not N nodes × two taps. It is offered only when it would change something:
hidden once everything is selected, and hidden while a wire is selected, where
it would silently replace the selection with something unrelated.

**Add-to-selection is deliberately still keyboard-only.** `Shift`+tap has no
touch equivalent that is not a mode, and a mode on a canvas whose primary
gesture is a pan is a gesture that will be entered by accident. The actions
that matter are reachable per-node and, for "everything", through Select all,
so the marginal value is low against the cost. This is the one gap in this
section left open on purpose.

#### The route with no aiming in it

A wired input port in the inspector printed `Wired from Base64 · Output.` and
stopped there. It now carries a **`Disconnect`** button, whose accessible name
names both ends, because "Disconnect" read out of a list of controls on a node
with two occupied inputs does not say which.

This is the answer to the specific sentence that made the gap blocking: the
refusal says to remove the existing wire first, and this is that removal, at
the one place in the application that already knows which wire is in the way,
with no curve to hit. It is also the only route to removing a wire that a
keyboard can reach at all.

It does **not** go through `deleteSelection`. Doing so would mean selecting the
wire first, which clears the node selection — and the node selection is what
the panel is showing, so the panel would empty itself as a side effect of a
button inside it. `removeEdges` pushes exactly one command, so its undo offer
is one step by construction.

#### One function, three entrances

`Delete`/`Backspace` on the canvas, the bar's `Delete`, and the inspector's
`Disconnect` all end in the same place, and `Ctrl+D`/`Ctrl+A` share a function
with their buttons. `deletion.test.tsx` drives the key and the button over one
graph and compares the document each leaves behind, and the same for duplicate
and select-all. That is the shape [`firstRefusedEdge`](#checkconnection-now-guards-the-two-routes-from-outside-this-session)
and the connect flow's two entrances already have, for the reason this
repository keeps rediscovering: two routes to one graph that agree today are
two routes that disagree later.

Focus after a deletion moves to the canvas root **synchronously inside the
handler**, and needs no layout effect: the store write is batched, so the bar is
still mounted and the root still exists to aim at, and the button is unmounted
from under a focus that has already left it. That is different from the three
focus moves in `Canvas.tsx` that have to wait for a node or a panel to be
RENDERED before they can aim at it — and those are why the deferral is worth
naming rather than doing quietly.

#### What a first-time phone user still cannot do

Recorded rather than implied, because this is the second pass over the same
question and the first one's honest list is what made this one possible.

- **Add-to-selection**, as above.
- **Read a node's full title.** A node is 224px and its title truncates with an
  ellipsis; `C` opens a chooser that lists PORT labels in full, and the
  inspector's header shows the tool name, so the information exists — but there
  is no tooltip on tap, by the same reasoning `PortButton` records.
- **Nudge a node by a precise amount.** Arrow keys move by 8px or 64px on the
  grid; a finger drag snaps to the grid but cannot be told "one step left".
- **Reach the wire layer at all from the keyboard.** `Disconnect` covers
  removal, but there is still no keystroke that SELECTS a wire, so a keyboard
  user cannot ask "what is this wire" the way a pointer user can.
- **See a node whose bottom edge is off screen along with its action strip.**
  The root clips, so the `Connect` button below a node near the bottom edge is
  cut off. Unchanged, and `checkTouch` measures it after a Fit, which is where
  a graph actually sits.
- **Escape the on-screen keyboard's effect on the sheet** beyond what
  `keyboardInset` already does.

### The travelling dash that had never been drawn

Found while adding the reverse half of `cssModules.test.ts`, and worth writing
down because of what kind of bug it is.

`.wireActive` — a single dash travelling along a wire while data moves through
it, with a reduced-motion variant and a forced-colors variant — had its class
written, its condition computed in `Canvas.tsx` on every render, and the set of
active edges passed to `Wires` as a declared, typed prop. `Wires` never
destructured it. The animation had therefore never once been on an element.

Nothing failed. The prop was supplied and type-checked, `activeEdges` was
derived correctly from the live run states, and a class nobody names produces
no error and no visible difference from the same wire not moving. This is the
inverse of the rule this repository already enforces — styling that implies
behaviour the application does not have — and it is harder to notice, because
the thing that is missing was never seen working.

`cssModules.test.ts` has asked since the `.tokens` incident whether every class
a component NAMES is declared. It now also asks whether every class a
stylesheet DECLARES is named, which is the question that found this. Adding it
turned up four dead blocks in the canvas alone and dead rules in four more
stylesheets, including a `.placeholder` meant to hold an image panel open while
its object URL is created — so `ImageView` really did jump by 420px on the frame
after a run finishes, which was a known defect rather than a comment describing
behaviour that does not exist.

**It is fixed now, and not by reviving the placeholder.** A reserved box of a
fixed height only moves the jump: a favicon would open a 420px hole and then
collapse it. The box has to be the right size on the first frame, which means
knowing the aspect ratio before the decode — and every format this view will
preview states its own dimensions in its header, in the first few dozen bytes.
`inspectImage` already reads exactly those four formats for the image tool's own
size guard, so `previewAspectRatio` reuses it and the element carries an
`aspect-ratio` from the moment it is rendered. A header it cannot read returns
null and the element is left exactly as it was, because a wrong ratio is worse
than none: none is the old jump, and a wrong one is a box that resizes to
something else once the picture arrives. The comparison image is measured in
`comparisonFor`, where the bytes still exist — the preview is handed the `File`
itself rather than a copy of its bytes, so it has nothing of its own to
measure.

The reverse check cannot be asked of a stylesheet whose importers use a
computed key (`styles[variant]`, deliberate in four components), so those are
exempt by construction rather than by a list somebody has to maintain. The
reader was also generalised to any binding name: `Canvas.tsx` imports the
inspector's stylesheet as `inspectorStyles`, and a checker that only knew the
name `styles` had been blind to nine references in both directions.

### Announcements are a log, not a variable

The canvas has one live region, and several independent things announce into
it: the graph store, the pipeline, the viewport. None of them knows about the
others, and none of them can be asked to take turns.

A live region holds one string, so for a long time whichever message arrived
last was the only one anybody heard. That surfaced four separate times — a
connection refusal swallowed by a re-run, a move overwritten by a run summary,
a fit-to-view assertion that was intermittently red — and was patched four
times as four coincidences. It is one problem with two halves, and both halves
have to be fixed or neither is:

1. **Before the DOM.** React batches, so two `announce` calls in one tick
   produced a single render carrying only the second. The first never existed
   as a rendered value, so nothing downstream could have recovered it. Every
   announcement is now appended to a bounded log in the store
   ([`announce.ts`](../src/lib/announce.ts)), and the log is what the region
   reads.
2. **After the DOM.** Replacing the region's text before an assistive
   technology has observed the previous change loses it just as thoroughly.
   [`LiveRegion`](../src/components/LiveRegion/LiveRegion.tsx) drains the log
   one message at a time, each holding the floor for a 200ms floor — long
   enough to be a separate observable change, short enough that a burst of six
   finishes inside a second.

Two details in the region are load-bearing:

- The message is a **keyed child**, not the region's own text. "Nothing to
  undo." pressed twice writes identical text, and identical text is not a DOM
  change and is therefore silent; replacing the child is an addition, which is
  what `aria-live` reacts to.
- A message may name a **channel**, and a queued message is dropped when a
  later queued message shares it. Holding an arrow key announces per repeat,
  and reading all fifteen would leave someone hearing where the node used to be
  for seconds after it stopped. Only messages still _waiting_ are affected;
  anything already spoken stays spoken, and an unchannelled message is never
  superseded.

The pipeline store keeps its own log and the canvas forwards **every** unread
entry into the canvas's log — not just the newest, which was the same
last-writer-wins bug one layer further out.

### Several failures at once

Each failing node shows its own message, beside the thing it is about. On a
graph larger than the viewport that is a message you cannot see, so the readout
carries a **count** — `2 failed` — and nothing else. It is deliberately not a
second copy of the wording: two places that word the same error is two places
to keep in step.

Only real failures are counted. A node that never ran because something
upstream broke did not fail, and counting it would turn one broken node into
"5 failed" and send someone looking for five bugs. The run summary reports the
two separately (`failed` and `skipped`) for the same reason.

## The first screen

The canvas is the homepage, and for a long time the homepage was an empty grid
and a line about pressing `K`. The fix is not a route, and the reason it is not
is worth writing down, because a landing page at `/` is the obvious shape and
it is wrong.

**`/?p=...` is a share link.** It is the one URL in this application that other
people paste into chat and issue trackers, and the whole point of it is that it
opens the pipeline it describes. Moving the canvas to `/canvas` to make room
for an introduction means either breaking every link already in the world, or
answering one with a redirect through a page about the product. Both are worse
than the problem.

So the state that was actually missing content is narrower than a route:

| `/` with…     | Shows                       |
| ------------- | --------------------------- |
| `?p=...`      | the pipeline in the link    |
| a saved graph | your canvas, as you left it |
| neither       | **the cold open**           |

That third row is the only one that was ever empty, and it is by definition a
visitor who has never been here.

### Why it is in index.html

The panel is hand-written markup in `index.html`, styled by
`src/styles/cold-open.css`, and the app does not render it. Three things follow
from that, and none of them is available to a component:

1. **It exists without JavaScript.** Everything else on this site is behind a
   dynamic import, so a crawler or a link-preview bot that does not execute the
   router sees an empty `<div id="root">`. This is the one page where that
   matters, and it is the one page that no longer has the problem.
2. **It paints early.** The document's stylesheet is a render-blocking `<link>`
   in the built output, so the panel is on screen with its real type and
   colours before the canvas chunk has been requested.
3. **It costs nothing in JavaScript.** The initial payload is byte-for-byte
   what it was. The price is 2.3 kB gzipped of markup and CSS, in a document
   served `no-cache`.

The price of that is that nothing in the type system holds the two halves
together — so `coldOpen.test.ts` reads `index.html` with Vite's `?raw` and
asserts the joins: that each example link decodes against the live registry,
that the `localStorage` keys the inline script names as literals are the ones
the app writes, and that the element ids `coldOpen.ts` looks up are the ones
the markup carries.

### The decision is made in the parse, not in React

An inline script sits immediately after the markup it governs and before the
module script. It either removes the panel outright or marks `#root` inert, and
it does so in the same parse that produced the element.

That placement is the whole mechanism. A React effect could not promise it,
because by the time an effect runs a frame has already been painted — and the
failure being avoided is precisely a **flash of the wrong first screen**, not a
leftover element.

Removing rather than hiding is a different argument: a hidden panel is state,
and the app would have to know about it, agree with it, and keep agreeing. A
removed one cannot come back on a later render.

### The document owns its stylesheet

The style layer is a `<link>` in `index.html`, not an `import` in `main.tsx`,
and the difference is invisible in production and load-bearing in dev.

Vite extracts CSS out of the module graph at build time and writes exactly that
`<link>` into the head itself, so a production build looked identical either
way — which is why every gate passed. `pnpm dev` does no extraction: an
imported stylesheet arrives as a JavaScript module that injects a `<style>`
when it runs. So the one screen whose entire claim is that it exists before any
module has been fetched was served, in dev, as raw unstyled markup on a white
page for as long as the first chunk took.

The rule the fix generalises to is the same one the theme bootstrap already
followed: **whatever has to be true before the module runs is the document's to
declare.** The markup, the theme attribute, the decision about who sees the
panel, and now the stylesheet.

Both halves are asserted in `src/app/index.head.test.ts` — that the tag is
there, and that no module imports the stylesheet as well, because a second
owner is a silent route back to the dev behaviour rather than a duplicate in
the build. `check:browsers` adds the other end: it loads `/` with every
`assets/*.js` request aborted — scripting on, inline bootstrap running, the app
simply never arriving — and asserts the panel is still fully painted.

### Inert, and where focus goes

While the panel is up, `#root` is `inert`. The canvas mounts behind it a moment
later with a full toolbar, and an invisible-but-tabbable toolbar is the oldest
overlay bug there is. Nothing in `#root` is focusable before the app boots, so
setting the flag in the inline script has no ordering hazard.

`dismissColdOpen` clears it, and does three things rather than one — remove the
element, clear the flag, record that it happened — because a caller that did
two of the three would break in a way that only shows up for the next visit.
The focus move is the fourth, and it lives at the call site rather than in the
helper: focus was on the panel's own button, which has just left the document,
and focus on a removed element falls to `<body>` where the canvas's keyboard
model is unreachable and the next `Tab` restarts from the top of the page. A
panel that came down because a share link brought a graph with it never had
focus, so that path does not take it.

### A share link is fitted; a saved graph is not

The three example links are the first pipelines most people will ever open, and
the first version of them put every graph at the world origin. They decoded
perfectly, and both nodes landed in the top-left corner with half the first one
under the toolbar and the whole rest of the canvas empty. It read as a broken
page.

There were two causes and they needed two fixes, because either alone would
have hidden the other.

**The coordinates were wrong.** Nothing this application creates has ever put a
node at `(0, 0)` — `addPreset` drops a preset at `centre − (NODE_WIDTH, 80)` in
world space, which on any real canvas is a comfortable positive coordinate.
`(0, 0)` was a hand-encoded number and nothing else. The links now carry what
the app itself would have produced, and `coldOpen.test.ts` checks both the
place and the shape: every node at a positive coordinate, and the layout equal
to the `PIPELINE_PRESETS` entry of the same name, snapped the way the decoder
snaps.

**And nothing framed an arriving link.** This is the general case and it is not
about these three at all: a share link's coordinates belong to whoever sent it,
chosen against their viewport on their screen, and the person opening it has no
relationship with them. Dropped into the default viewport they land wherever
they land. So the canvas now fits on arrival — the same argument `addPreset`
already makes, that the point of loading a several-node graph is to see the
shape, and the case where it is most true, because the reader has never seen
the thing before.

**A restored save is deliberately left alone.** Those coordinates are the
reader's own, chosen against this viewport, and nodes are created in view — so
a save comes back where it was built. Fitting it would be the app overruling a
layout its own user made, on every reload, to solve a problem that case does
not have. `F` is one key away. The harness asserts both directions: an example
link lands with every node inside the canvas and clear of the toolbar, and a
restored save leaves the plane on the identity transform.

### Two empty states, deliberately

The canvas keeps its own `Empty canvas — choose Add tool, or press K`, and does
not draw it while the panel is up. They are not duplicates: one is an
introduction for somebody who does not yet know there is a canvas, and the other
is operational, for somebody who has one and has just cleared it.

**The element is the state.** The canvas reads it through
`useSyncExternalStore` rather than copying it into a `useState` on mount, and
the difference is not stylistic. A copy has to be maintained, and what
maintains it is `nodeOrder.length === 0` — which is true again the moment
somebody selects everything and presses Delete. That flips a copied boolean
back to "the introduction is up" on a canvas whose panel went in the bin ten
minutes ago: nothing renders, because the element was removed, and the canvas's
own empty state is suppressed on the one screen that needed a message. Asking
the document cannot get that wrong. There is one panel, it is removed exactly
once, and removal is the only event there is to publish.

## The node inspector

Select a node and one panel shows its **input, its options and its output**.
Before it, the canvas could build a pipeline and run it correctly and show you
none of it — a defect that had been true since the canvas was written, because
data flowing between nodes was tested thoroughly and nobody asked whether a
person could see or control any of it.

It is the **only** place input is entered. Two boxes holding one value is worse
than one extra press: it doubles the surface that has to stay in step, and it
made every node tall enough that you could not see two of them at once, which
is the point of a canvas.

### It is a sibling of the canvas, not a child of it

Every overlay the canvas draws — the palette, the two connect dialogs, the
shortcuts reference — renders inside the canvas root, and the canvas detaches
its wheel, pointer and key listeners for as long as one is open, because those
listeners would otherwise pan the canvas underneath a dialog and swallow the
dialog's own scrolling.

That machinery is right for a dialog and exactly wrong for this panel. A docked
inspector has to coexist with a live canvas: you change an option and watch the
chain behind it re-run, you pan to see the node it feeds, you press Tab and land
on a node. So the route renders a workspace holding the canvas root and the
inspector as siblings — and two problems stop existing rather than being
guarded against. No canvas listener ever sees a keystroke meant for a text
field, so a `role="application"` region cannot claim the "k" out of somebody's
regex; and nothing is fighting a wheel handler for the panel's scrolling.

### Two shapes, one component

|             |                                                                                               |
| ----------- | --------------------------------------------------------------------------------------------- |
| `>= 1000px` | A docked rail in the workspace grid. It does **not** overlay the canvas — the canvas narrows. |
| `< 1000px`  | A sheet along the bottom, overlaying the canvas, with a usable strip of canvas above it.      |

Both shapes start **closed** on a first visit — see below — and a share link is
the one arrival that overrides that.

**The breakpoint is arithmetic**, the same arithmetic as the tool runner's. The
rail is 320px at its narrowest and a canvas wants three node widths to still
read as a canvas: `224 × 3 = 672`, plus the rail's border, is 993. 1000 is the
next round number clear of it.

**Closed on a first visit, and wherever the user last left it after that.**

**Except when a share link arrives**, which is the one case the panel opens
itself, and it is not the exception it looks like. A link's graph lands
correctly framed and completely inert: a share link carries no data — that is
the whole privacy claim — so every node reads BLOCKED, and since input moved
into the inspector there is nothing on the canvas that says where a value goes.
Closed, the first thing a link showed you was a picture of a pipeline and no way
into it. The default exists for a first-time visitor on an EMPTY canvas, where
an open panel's entire message was that there was nothing to inspect; a pipeline
somebody deliberately sent you is the opposite case in the one respect that
matters, because it is nothing but something to inspect. So the panel opens on
the first node that will actually show a text box — spatially first, skipping
any whose every input is already wired — and **focus does not move**, because
this runs in a promise callback rather than from a keystroke and a deferred
focus move is the [most-repeated defect in this
repository](../CONTRIBUTING.md#moving-focus). A restored save is not touched:
its reader has already answered the question and the answer is remembered.

`I` toggles it at both sizes and a toolbar button carries the same toggle with
an `aria-pressed` that says which state it is in. Selection never opens or
closes it — on a phone that would bury the canvas on every tap while arranging
nodes, and on a desktop it would be a panel that reopens itself faster than it
can be dismissed. Closing does not clear the selection either: what you are
working on and whether the panel showing it is on screen are two facts, and
collapsing them would mean the only way to get the canvas's width back was to
deselect the node you were about to move.

It used to default to open wherever the rail fitted, on the grounds that the
canvas merely narrowed and so it cost nothing. What it cost was the first
screen: a first-time visitor on a desktop arrived at an empty canvas beside an
empty panel whose entire message was that there was nothing to inspect — the
application explaining its own furniture before the user had done anything. The
reasoning about open/closed being the USER's state and selection deciding only
the contents is untouched; the starting point is the only thing that moved.

**And it is remembered, where the rail's width is not.** The two look like the
same kind of preference and are not. A width is a preference inside an open
panel and one drag restores it, which is why it stays in session state; open
against closed is the difference between seeing the thing you were working on
and not, and since this panel became the only place a node's input is entered
and its output read, closing it on every reload would charge that to exactly the
people who use the canvas most, on a page load they did not ask for.

That buys a second storage key, `patchbay:inspector:v1`, and it is affordable
because it needs neither a schema nor a migration: it is one boolean, and the
only thing an unreadable value can mean is closed — which is also the
first-visit default. A value from a future build, a hand-edited one, a blocked
`localStorage` and a first visit all land on the same answer, and it is the
conservative one. Compare `graphStore`, where the same question needed Zod and
five versions of migration chain.

**Discoverability needed nothing new, and that is a conclusion rather than an
omission.** The panel is where a node's input is set, so a closed panel had to
be findable from a standing start — and the node itself already does it: a
freshly added tool is blocked for want of an input, and what it says about that
is `Type or add a file in the inspector, or wire Input.` The toolbar's toggle
sits beside Add tool with an `aria-pressed`, and the canvas's own
`aria-describedby` names `Enter or I to open the inspector`. Three routes, all
of which predate this change, and the first of them appears in the state a new
user is guaranteed to reach on their first action. A fourth affordance
advertising the panel would be furniture explaining furniture again.

**Nothing selected and several selected are different questions.** "Select a
node" answers the first and insults the second, so a multi-selection is listed
by name and one of them can be picked — which is also the only way a keyboard
user reaches one node of a group without clearing the whole thing.

### The height chain, which was wrong in a way only a browser could show

`1fr` inside an auto-height grid container is max-content, not free space. The
shell's `min-block-size: 100dvh` sets a floor, and a row whose content exceeds
it still grows — so the canvas route was a fixed-height viewport only for as
long as nothing inside it had intrinsic height. The inspector broke that on its
first result: measured in both engines, **a rail holding a long match table was
1,828px tall inside a 900px window**, and its own scroll region never scrolled
because it had all the room it wanted.

`<main>` is now a containing block and the workspace is `position: absolute;
inset: 0` against it, so the workspace contributes no height and its inset
resolves against a row that is genuinely the free space. Every other route is
untouched: `position: relative` changes nothing about a static child, and
`sticky` cares about scroll containers rather than containing blocks.

### A very large output

The panel is the one scroll region this adds. It does not need a second: every
output view already caps its own height, so a 30 MB decoded document cannot
push the sections below it off the panel however large the value is. What the
scroller does is let several already-bounded blocks stack — which is exactly
what the document does for the same views on a tool page below its breakpoint.

### While the pipeline is running

**The controls stay enabled.** The tool page disables them because Run there is
an explicit act; on the canvas the run is continuous and already debounced, and
a field that goes dead for 300ms at a time while you type in it is worse than
anything it would prevent.

**A running node says "Running", it does not show its last answer.** Keeping the
previous result on screen means showing the answer to a question the user has
already changed, and the only case where it lasts long enough to notice — a slow
tool — is the case where saying so is the truth. `NodeRunState` clears `outputs`
when a node starts, so this is also the shape the engine already has rather than
a second copy of it.

**Changing an option re-runs nothing directly.** It is an ordinary graph edit:
the store updates the document, the effect watching `graph` schedules a run, and
that schedule is the existing 300ms debounce. Options are part of the node's
cache key, so only that node and its descendants execute. A second trigger
beside the existing one would be a second thing to keep in step with the
debounce.

### Typing an option is one undo step

Options are part of the document on the canvas — they travel in a share link and
they belong in the undo history — where on the tool page they are component
state. Without care, typing a regex pattern would put one entry in the history
per keystroke and bury whatever the user actually wants to undo under forty
steps of their own typing.

Consecutive `set-options` commands on the same node are therefore merged, the
same way a held arrow key's moves already are, keeping the older `from` so one
undo returns to the value before the run of edits began. **The line is drawn on
the control, not on timing**: text and number fields merge, a toggle or a select
never does, because a discrete choice is a deliberate act worth its own step —
and a control is a fact where a pause is a guess.

### The node it is showing is deleted

Deleting from the canvas already returns focus to the canvas root, because the
key that did it was handled there. Every other route out — undo, a share link
replacing the graph, a redo that removes the node again — runs while focus is
_inside_ the panel, and an element that unmounts under focus drops it to
`<body>`, where none of the canvas's keys work and nothing says why.

Whether focus was in the panel has to be known **before** the unmount, because
afterwards `contains(document.activeElement)` always answers no. It is tracked
on `focusin`/`focusout`, and a `focusout` with a null `relatedTarget` is
deliberately not treated as leaving: focus went nowhere, because the thing that
had it stopped existing.

### A node keeps a summary, not a preview

A node is 224px wide with two clamped lines. Its summary box already switched
between the tool's description, the reason it is blocked and the error that
broke it; once a node has run, its **result** is its situation, so that is the
fourth case. Only the first declared output is summarised — six of the nine
tools have more than one, and the manifest's order is not arbitrary: the first
port is the tool's answer and the rest are its working. Since the [port
audit](#the-port-set) that first port is called `output` on every tool, and
`registry.test.ts` asserts it, so "the first output" and "the tool's answer"
are the same thing by construction rather than by nine separate decisions.

| Output                   | Summary                              | Why that and not something else                                                                                                                                                               |
| ------------------------ | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| regex report             | `47 matches`, `No matches`           | `count`, never `listed` — they differ exactly when the listing was truncated, and this tool has already once reported a count for a cut-short listing.                                        |
| diff                     | `+12 −3`, `Identical`                | Additions and removals are what a diff is. `identical` gets its own word: `+0 −0` reads as the tool having failed to run.                                                                     |
| decoded JWT              | `NOT VERIFIED · HS256`               | The one summary that is a warning rather than a measurement. A node mid-chain is where nobody opens the panel, and a decoded token that reads as ordinary makes a forgery look authoritative. |
| conversion report        | its own `summary` line               | The report already carries a sentence written for a person. A second wording would be a second thing to keep in step.                                                                         |
| bytes                    | `2.1 MB PNG image`                   | Size and the **sniffed** label, never the declared one — the same rule the rest of the app follows.                                                                                           |
| text (and rendered HTML) | its first non-empty line, or `Empty` | Plain text is already the answer. An empty result drawn as an empty summary is indistinguishable from no summary, and it is usually the surprise.                                             |
| bare JSON                | `12 keys`, `12 items`                | Nothing in an arbitrary JSON value can be relied on to be short, so nothing is quoted from it. Shape is what tells you the thing you expected came out.                                       |
| colour                   | `#3366ff`, `#000000 at 50%`          | The notation everybody recognises. Alpha is named because the hex alone would not say it.                                                                                                     |

Every one is truncated to 60 characters, because the summary is also in the
node's accessible name — a chain scannable by eye and not by ear is not a chain
a keyboard user can follow — and that string is read from end to end.

### An input port that cannot take text gets no text box, here too

`image-convert` declares `types: ['bytes']` on its only input. The canvas drew
an editor for every unwired input port without asking what the port accepted, so
that one got a textarea whose every keystroke was ignored: the engine's
preflight blocks a required bytes port with no wire whatever the box contains,
so the node sat blocked forever with an editor under it inviting another
attempt. The tool runner had the same bug and at least reported a type error;
this one said nothing at all. The port's own description is the instruction now,
which is the same fix [the runner made](#an-input-port-that-cannot-take-text-gets-no-text-box).

A **wired** port gets no editor either, and says what is feeding it instead. A
wire wins over typed text everywhere else in the engine, so drawing a box whose
contents the run would ignore is the same defect in a different costume.

What the description is no longer doing is standing in for the affordance. That
port takes a file, and there is now [a file control](#a-file-as-an-input) under
the sentence that does the thing the sentence describes — which is what made
`image-convert` reachable on the canvas at all.

### The keyboard

`Enter` on a focused node used to step into that node's input editor. The editor
moved, so `Enter` followed it: it selects the node, opens the inspector and puts
focus inside. Same key, same intent — which is why the panel needs no separate
"open on this node" affordance for the keyboard at all. `Escape` steps back out
to the node, which is the wording the shortcuts map has always carried.

**Into the editor, and in the same task as the keystroke.** Both halves of that
were wrong for as long as the panel has existed, and each hid the other.

The target was asked for as "the first thing in the inspector that takes
focus", written as one `querySelector` over a list of selectors — which returns
the first element matching _any_ of them, in **document order**. The panel's
header comes before its body, and the header holds the button that closes the
panel. So the key whose entire purpose is to step into the node's input landed
on **Close the inspector**: pressing `Enter` and typing produced nothing, and
the next `Space` shut the panel. The unit test covering this asserted that
focus was _somewhere in the panel_, which was true of the bug.

The move was also deferred to `requestAnimationFrame`, and a deferred focus
move is a focus move that lands in the middle of whatever happened next. Under
load that frame can be tens of milliseconds late; anything focused in the
meantime loses focus, and text typed into the editor in that window goes to the
close button and is **discarded silently**, because text landing on a button is
not an error anywhere. That is a real defect for anyone who types quickly, and
it is also what made `check:browsers` fail roughly one worker-wedge run in
three — see below. It is a layout effect now, which runs synchronously after
the commit that mounted the panel, in the same task as the keystroke: there is
no window to lose and no frame to guess at.

**And three more places had the same defect, which is why this section says the
rule rather than the case.** Choosing a tool moved focus onto the new node one
animation frame later, for the same defensible reason — the node is added to
the store, so it is not in the DOM when the handler returns — and with the same
consequence: add a tool, move to another node, and the late frame takes that
node away from you, so the next keystroke acts on the one the palette added.
`C` connects from it, an arrow key moves it, `Delete` deletes it, and none of
those is an error anywhere.

It surfaced as a unit test building a keyboard three-node chain **backwards**,
failing fifteen seconds later against the executor, which had run the graph it
was given correctly. Reproduced by making that frame 18 ms late — which is only
what CPU load does to it — and reproduced exactly: the same wiring, the same
`blocked, Waiting upstream` on the head of the chain, the same
`Pipeline finished. 3 blocked.`

The correction is the one above. `addTool` records a request in state and a
layout effect performs the move, so React commits the new node and the effect in
one pass and the focus lands after the node exists and before the task ends. The
request carries a sequence number as well as the id, because adding the same
tool again after an undo would otherwise be a changed nothing and no effect at
all.

**The remaining two were the dialogs' own focus-on-mount**, which had not been
looked at because they are one line each and obviously correct: `CommandDialog`
focuses its search field and `ShortcutsOverlay` focuses its close button, both
from a passive `useEffect`. Same defect, and the palette's is the one that
bites. It is opened by `K`, and `K` is followed immediately by what the user
came to type — so every character struck before the browser paints goes to
whatever had focus, which is the canvas root: a `role="application"` region
that swallows single letters and shows nothing for them. The search box then
opens already missing the front of the word, with no error anywhere, because
text landing on a region that claims it is not an error. Both are layout
effects now. That makes five corrections of one shape in this feature, and the
rule is worth stating plainly: **a focus move that answers a keystroke belongs
in the task the keystroke started.** The only reason any of them needs to wait
at all is a target that does not exist yet, and a layout effect is exactly the
"after the commit that created it, before the task ends" the deferral was
reaching for. A `requestAnimationFrame` is never that.

Where each half is asserted follows from what each half is. That focus lands on
the right element, and lands **before anything else can run**, is a scheduling
question and is asserted in the unit suite, driven with `fireEvent` so there is
no `await` for a late move to catch up inside. That the element is really
mounted by the time the effect looks for it is a question about React's commit
in an engine, and `check:browsers` asks it — a miss there would leave focus on
the canvas root with nothing on screen to say so.

A wired input port carries a **`Disconnect`** button, which is the only route
to removing a wire that a keyboard can reach: nothing on the keyboard puts an
edge in the selection, so `Delete` could only ever remove a wire a pointer had
selected off the plane. See
[the deletion section](#the-route-with-no-aiming-in-it) for the rest of that,
including why it does not go through the selection.

The rail's size handle is the ARIA window-splitter pattern: a **focusable**
separator with a value, arrow keys that resize by one grid step, and Home/End
for the extremes. A handle only a pointer can move is a preference only a
pointer user has, and the reason the rail is resizable at all is that a diff
wants more width than a colour swatch does. It is built on a real `<button>` so
that focus, activation and the tab order are the browser's rather than
hand-rolled; the width is session state, because it is one drag to restore and a
stored value would be another key to validate and migrate.

**What it draws is a hairline; what it can be grabbed by is not.** The two are
separate concerns and were one box: a 4px sunken column with a border down each
side, which is three visible edges where an instrument wants one, and heavier
than any other divider in the app. The visible rule is a `::before` at
`--pb-border-width` — one pixel, the same as every other boundary — and the grab
area is an `::after` that overhangs it and paints nothing.

A pseudo-element rather than a wider button, because width here is width taken
from the graph: the handle is a grid track, so every pixel it occupies is a
pixel the canvas does not get. An absolutely positioned overhang costs no
layout at all, and a pseudo-element is hit tested as part of the element that
originated it — so the target grows and the column does not.

|                | Rule | Target                                  |
| -------------- | ---- | --------------------------------------- |
| Fine pointer   | 1px  | ~16px, an 8px column plus 4px each side |
| Coarse pointer | 1px  | 44px, WCAG 2.5.5                        |

Only the reach changes between them. `checkMobileLayout` measures every target
against 44px at 320–430px and never sees this one, because below the breakpoint
the panel is a sheet and there is nothing to resize — so a touchscreen at 1000px
or more is the one place this control exists under a finger, and it was 4px
there.

**Painting the rule as a background has one cost, and it is paid back
explicitly.** In forced-colors mode the OS replaces every author background with
its own Canvas, so a one-pixel strip of `--pb-border-hairline` becomes a
one-pixel strip of the surface behind it and the divider vanishes. The version
this replaced used `border-inline`, which the UA repaints in `CanvasText` for
free — so the regression would have been silent, and silent for exactly the
users who need a boundary most. One media query using system colour keywords
answers it, the same escape hatch `canvas.module.css` uses for the selected
node's border, and `check:browsers` asserts it because the failure is invisible
in every other mode. On hover and on focus the **rule** responds rather than a box appearing:
it thickens to `--pb-border-width-strong` and takes the accent, and the focus
ring goes on the rule rather than around the whole grab column, where it would
have drawn a box four times the width of the thing it was describing.

### Opening and closing is a slide

`--pb-motion-base` and `--pb-ease` — 150ms on the sharp curve, the same pair
every other transition in the app uses. Reduced motion needs no media query
here: `global.css` collapses every duration to 1ms wholesale, and its own
comment says 1ms rather than 0 precisely so `animationend` still fires and a
state machine cannot stall. This is that state machine.

**The panel has four states, of which two are the animation.** `closed` and
`open` are the resting pair; `entering` and `closing` exist because the element
has to be on screen while it moves — a panel that unmounts the moment it is
closed has nothing left to slide, and one that mounts already in place has
nowhere to slide from. `animationend` on the panel retires each of them, with a
deadline behind it that is a guard against a signal that never arrives rather
than a second opinion about the duration. A `closing` panel is `inert`, which is
both halves of what a panel on its way out needs: out of the tab order and out
of the accessibility tree, where `aria-hidden` alone would have left a focusable
close button inside a subtree screen readers had been told to ignore.

**The rail animates its WIDTH and the sheet animates a TRANSLATE**, because the
rail is a grid track the canvas is meant to narrow with, and the sheet is
absolutely positioned over a canvas that nothing has to move out of the way for.

#### Animating the width does not stutter, and the reason is structural

The obvious objection is that the rail narrows the canvas rather than covering
it, so animating its width relays out the canvas sixty times a second. Measured
on a 48-node, 47-wire canvas with a real match table in the panel, against an
idle baseline sampled in the same page — because the raw frame timings are not
comparable between variants, headless Gecko ticking `requestAnimationFrame` at
about 160Hz while a main-thread animation is pending and headless JavaScriptCore
sitting near 33Hz throughout:

| Variant                       | Gecko, worst frame | JavaScriptCore, worst frame |
| ----------------------------- | ------------------ | --------------------------- |
| Idle, nothing happening       | 16.5ms             | 32–46ms                     |
| **Width, content pinned**     | **30ms**           | **36–68ms**                 |
| Transform instead of width    | 30.3ms             | 48–52ms                     |
| No animation at all           | 30–31.5ms          | 45–47ms                     |
| Width, content **not** pinned | 31.8–32.6ms        | 72–75ms                     |

The first thing those numbers say is that **the toggle costs about 14ms of worst
frame whatever it animates**, including when it animates nothing — that is React
mounting and unmounting the panel, not the slide. Against that, the shipped
width animation is within about 2ms of no animation at all in Gecko and
indistinguishable from it in JavaScriptCore.

It is cheap because nothing inside the canvas depends on the root's width. The
nodes and the wire layer sit on a 0×0 absolutely positioned transformed plane,
and the grid is a repeating background image on the static root — so narrowing
the root changes three boxes and repaints a gradient, and does not reflow or
re-render a single node. There is no `ResizeObserver` on the canvas either, so
React is not woken at all.

**What is not free is letting the panel's contents re-wrap.** The last row is
the naive version of the same animation, and it is the one that stutters: every
label, select and table row re-laying out at every intermediate width doubled
the worst frame in JavaScriptCore, 72ms against 36ms, and halved the number of
frames actually painted — 5 or 6 against 10, which is a visible judder. So the
panel's content column is pinned at its resting width with
`grid-template-columns`, the subtree is laid out once, and while the box is
narrower the content overhangs to the right and the workspace clips it. The
panel's left edge and the canvas's right edge move together while its contents
sit still relative to that edge, which is what a slide is. `check:browsers`
asserts the pin as a computed style rather than asserting a frame timing, which
in that harness would be flaky.

The workspace carries `overflow: clip` for that clipping — `clip` rather than
`hidden`, for the reason the tool runner has a paragraph about: `hidden` makes
an element a scroll container, and a sticky element inside a scroller that never
scrolls never moves.

### A phone, where a side panel and a canvas cannot both have the screen

The sheet takes the axis that is not scarce. The canvas keeps its full size
underneath it and stays pannable in the strip above, because the sheet is a
sibling rather than a child — no canvas gesture is intercepted and none of the
overlay-detaching machinery is involved.

The on-screen keyboard changed shape with this. There used to be a textarea on
every node — on the transformed plane, inside an `overflow: hidden` root, with
nothing for a browser to scroll — so the canvas panned its own viewport to lift a
focused field clear of the keyboard. Input is entered in the inspector now, and
**the inspector is an ordinary scroll container**: the engine's own
scroll-into-view has somewhere to put a focused field, exactly as on a tool
page, and no application code is involved in that half any more.

What no engine can do is move the sheet. It is anchored to the bottom of the
_layout_ viewport and a keyboard shrinks the _visual_ one, so the whole panel
would sit behind the keyboard and its internal scrolling could not help.
[`keyboardInset.ts`](../src/features/canvas/keyboardInset.ts) measures the
difference from `visualViewport` and the sheet sits that far up — on a coarse
pointer only, because a panel that jumped whenever a window resized would be
worse than the bug being fixed. The arithmetic is unit-tested, the wiring is
driven in both engines by shrinking the window, and **the keyboard itself is
still not tested anywhere**, for the reason in the limitations below.

### What was rejected

- **Opening on selection.** Buries the canvas on every tap on a phone; on a
  desktop, a panel that reopens itself cannot be closed.
- **Keeping the input box on the node as well.** Two places to type one value,
  and it is what made every node tall enough to lose the graph.
- **A file control on the node.** Same argument: the node is 224px with two
  clamped lines and a summary already doing four jobs. The whole node is a drop
  target instead — see [a file as an input](#a-file-as-an-input).
- **Showing the last result while a new one computes.** An answer to a question
  the user has already changed.
- **Disabling the controls during a run.** The run is continuous here; the field
  would go dead while you typed in it.
- **The image before-and-after.** Two images side by side at 320px are two
  images too small to judge anything by — ImageView's own argument.
- **Rich-text copy in the panel.** It needs the clipboard document builder,
  which pulls the whole markup pipeline in behind it, for a button that is one
  click away on the tool page. The panel says where to find it.
- **Deferring the output views behind a second dynamic import.** A canvas exists
  to produce output, so the deferral would last seconds and buy a loading state
  in a 320px panel.
- **Persisting the rail width.** One drag to restore, against another storage
  key to validate and migrate. Whether the panel is OPEN is persisted, and the
  difference is argued above.
- **A transform for the rail instead of its width.** Cheaper by nothing
  measurable, and it slides the panel over a canvas that has already snapped to
  its new size — the narrowing is the half of the animation that says where the
  space came from.
- **Animating the width without pinning the content column.** The same animation
  and the naive version of it: the panel's contents re-wrap at every
  intermediate width, which doubled the worst frame in one engine and halved the
  frames painted.
- **A `transitionend` on the grid track as the completion signal.** It would
  have made the unmount depend on an engine interpolating
  `grid-template-columns`, and on being able to tell that transition apart from
  every hover inside the panel that bubbles one.
- **A fourth affordance advertising the panel now it starts closed.** The node's
  own blocked guidance already names the inspector in the state a new user
  reaches on their first action, which is earlier than anything a banner could
  manage.

## A file as an input

You could not put a file on the canvas. No node had a file control, so the only
way to get bytes into a pipeline was to type base64 into a text box and decode
it — which means **"hash this file" and "convert this image", the two things
those tools exist for, could not be started on the canvas at all.**
`image-convert`'s only input takes `bytes`, so there was nothing to type into
it and no wire that could have come from anywhere.

The [port audit](#the-port-set) found this and concluded the ports were right
and the affordance was missing. The [inspector](#the-node-inspector) is where
it goes, for the reason input goes there at all: it is the one place a node's
input is entered.

### One control per port, not one per node

The tool page sends its single file to "the first port that accepts `bytes`,
falling back to the first port". That is all one control can do, and it makes
`diff`'s second document port unreachable by file — so comparing two files is
possible on neither route. The inspector already draws one editor per unwired
input port; a file is input like any other and gets the same treatment.

Every input port in the set declares `text` or `bytes`, and both can come from
a file, so **every unwired port gets a file control** — including the two that
take a short literal. A JWT saved to a `.txt` file is a real thing, and
inventing a canvas-only rule about which ports deserve a file would be new
drift between the two routes, which is what the port audit was about.

**A wire wins, then a file, then typed text**, in that order — each a more
deliberate act than the one after it. A wired port draws neither control and
says what is feeding it, which is the rule it already followed for text; a port
with a file shows the file's summary in place of the box. That is the same rule
again rather than a new one: nothing draws a control whose contents the run
would ignore. The typed text is not destroyed — it is still in `node.inputs`
and the box comes back with it when the file is removed.

The tool page disables its textarea instead of removing it, and the difference
is deliberate: the inspector already states the winner for a wired port, and a
320px rail cannot afford to draw both.

### Where the bytes live, and why not in the document

A `File` is not serialisable. The graph is a single `localStorage` key and it is
also shared by URL, so neither could carry one — and a filename could travel in
a URL, which is worse than useless.

|                         |                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------- |
| `CanvasNode.fileInputs` | Per port: **name, size and a token**. Persisted locally. Never in a share link. |
| `attachmentStore`       | The built `ToolValue`, keyed by node and port. **Session only.**                |

The split is what turns a reload into a sentence. The document remembers that
this port was fed `holiday.png` and that it was 2.1 MB; the session no longer
has the bytes; so the node says **`"holiday.png" needs choosing again`** and the
inspector explains that a file is never saved with a canvas. Without the stub
the node would be indistinguishable from one nobody had ever fed, which is a
silently empty node rather than an answer.

**What is stored is the built value, not the `File`** — and for a `bytes` port
that value now _is_ a reference to the `File`, which is the one thing in this
section the streaming change moved. It is still validated against its port at
the moment it is chosen, so nothing downstream can be handed a file its port
cannot use; what no longer happens is the read. Choosing a 320 MB video used to
put 320 MB in the tab before anything had decided to do anything with it, and
that copy then lived for the whole session. It now costs the 4 kB the sniff
already looked at — measured, in both engines, in `checkLargeVideo`.

A port that needs **text** still reads the whole file, and that asymmetry is
the honest shape of the two cases rather than an optimisation: a text port has
to decode, decoding is a pass over the whole thing, and every tool with a
text-only document port declares a limit in the kilobytes or low megabytes.
Nothing reads a file it has not already agreed to hold.

The cost of the change, stated plainly: a resident tool fed a 64 MB file reads
it from disk on each run rather than from memory. That only happens on a cache
miss — which means the node's own work is about to be redone anyway — and a
disk read is a fraction of the work that follows it.

`token` distinguishes two files with the same name and the same size, which name
and size alone cannot. It is part of the node's cache key, so replacing a file
always re-runs the node instead of serving the previous answer — the failure
this cache has already had once, and the worst kind it can have, because nobody
reports an answer that looks completely plausible.

### What happens on a reload, and on a shared link

|                |                                                                                                                                                                                                    |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Reload**     | The name and size come back; the bytes do not. The node is `blocked` naming the file, and the inspector offers the chooser with the same name beside it, so the user knows which file to look for. |
| **Share link** | Nothing at all. The recipient gets an ordinary empty port asking for a file, exactly as they get an empty text box for an input nobody typed into.                                                 |

A share link carries no filename **and that is not merely the same rule as
`inputs` again.** The bytes could not travel at any size, so the only question
was the name — and a filename is often the most revealing single string in a
document: `Q3-layoffs.xlsx` says something a pipeline's shape does not. The
recipient does not have the file and would gain nothing but the name. It is
enforced by `toSharePayload`'s explicit field list, which is written as a field
list precisely so that adding a field to `CanvasNode` cannot start leaking it,
and asserted by `share.test.ts`.

**Duplicating a node copies its file**, bytes included. `...source` copies
`fileInputs`, so without that the copy would claim a file it could not produce
and look exactly like a reloaded node.

**Deleting a node does not drop its file**, and that is a trade. Undo restores a
deleted node whole — options, wires and typed text all come back — and a file
that did not would make undo a partial repair of the user's own data. The cost
is that a deleted node's bytes are retained until the graph is replaced or the
tab closes, bounded by the tool's own `maxInputBytes`.

**Replacing the graph drops every file.** Node ids repeat across documents —
every canvas starts at `n1` — so an attachment that survived would hand the
previous canvas's file to whatever the new one happens to call `n1`. That is the
rule `pipelineStore.reset` already follows for results, and here it would be
worse than a stale answer: it is one person's data appearing inside a pipeline
somebody else shared with them.

### Refused where the user is standing

Every refusal happens at the moment of selection, and each one names the file
and what to do about it. A limit reported afterwards is a limit the user
discovers by waiting; a type error reported at run time is one they discover by
pressing a button that was never going to work.

[`lib/fileInput.ts`](../src/lib/fileInput.ts) is the one implementation, used by
both routes, and its order is deliberate — each step is cheaper than the one
below it:

1. **Size**, before a single byte is read.
2. **The sniff window**, to refuse a binary file on a text-only port. Only the
   first 4 kB is read: `sniffBytes` matches signatures in the first twelve bytes
   and examines 4 kB for its is-this-text heuristic, so a slice gives a
   byte-identical verdict. This used to read the whole file to sniff it, so a
   64 MB binary dropped on a text-only port was pulled into memory in full and
   then refused.
3. **The whole file**, and a strict decode where the port needs text.

**The size limit is the tool's whole input, not one file.** `diff`'s is 8 MB
across both ports, so two 5 MB files would each pass a per-file check and be
refused together by the engine at run time. What a file is weighed against is
computed with `measureInputs` — the very function `engine.execute` weighs a run
with — so a file accepted at selection cannot be refused later for its size. The
one exception is a port fed by a wire, whose value is not known until the node
above it has run; counting nothing is the only honest answer there, and it is
the one case where a size refusal could not have landed any earlier.

**The declared MIME type is never read.** `file.type` comes from the operating
system's extension mapping: rename `payload.exe` to `notes.json` and the browser
reports `application/json`. Every decision here comes from the bytes, which is
the rule the rest of the app follows.

**And it decodes strictly, which fixed an inconsistency rather than adding one.**
The file path used a lenient `TextDecoder` gated on the sniff while bytes on a
wire went through [`lib/text.ts`](../src/lib/text.ts) — strict UTF-8, with a
UTF-16 byte order mark as the one exception. So a Latin-1 file dropped on a tool
page was processed as replacement characters and produced an answer, while the
identical bytes arriving from a base64 node were refused: one tool, two answers,
decided by which route the bytes took. Both go through `decodeDocument` now.

### Dragging a file onto a node

Dragging is the gesture people try first, and this route was doing the worst
possible thing with it: **with no handler anywhere, dropping a file on the
canvas made the browser navigate to it**, replacing the app with a picture.
`dragover` is prevented across the whole workspace now, which is true whatever
the drop then means.

| Dropped on                        | What happens                                                               |
| --------------------------------- | -------------------------------------------------------------------------- |
| A node with **one** free input    | The file lands on it.                                                      |
| A node with **several**           | The node is selected, the inspector opens, and a message names both ports. |
| A node whose inputs are all wired | Refused, saying to remove a wire.                                          |
| The background                    | Refused, saying to drop on a node or use the inspector.                    |

**Two ports do not get a guess.** `diff` is the only tool in the set with two
inputs and neither of them is "the" one, so picking the first would silently
make one of the two comparisons unreachable by drag — and the wrong one half the
time. Handing over to the inspector puts the user in front of the two named
controls that can answer the question.

**A drop on the background is refused rather than turned into a node.** Choosing
which tool a file wants means reading its bytes and picking on the user's
behalf — a hash for an archive, a converter for a PNG — and a gesture that
silently chooses a tool is a worse surprise than one that does nothing and says
what would have worked.

The node under the pointer is marked while a file is over it, with a **dashed**
accent border at the strong width and lifted above its neighbours — the border
STYLE changes as well as its colour, because nothing here may rely on colour
alone, and a drop target nothing marks is a guess the user gets wrong on
overlapping nodes.

It deliberately does not tint the node. The first version filled it with
`--pb-accent-subtle`, which puts the title, the summary and the status over a
token that is not in `CONTRAST_PAIRS` and is a light colour in two of the four
themes — and nothing could have caught it, because the state exists only while
a pointer is dragging: `themes.contrast.test.ts` iterates a known list of pairs
and axe in `check:browsers` sees a resting page. A border answers the question
without asking one nothing can answer.

### Keyboard and touch

**There is no separate keyboard path to maintain, because the real
`<input type="file">` is the control.** It is visually hidden but focusable and
labelled by the button beside it, so Tab then Enter opens the picker and
dragging is the extra. That is `FileDrop`'s own design and it came for free with
reusing it.

`Enter` on a node means "step into that node's input". A bytes-only port has no
editor to step into, so **the key lands on its file chooser** — otherwise it
would silently do nothing on exactly the node this feature exists for. The
lookup asks for the text editor first and the file control second, in that
order, rather than as one `querySelector` over a selector list: that form
returns the first match in document order, which is the bug that once put focus
on "Close the inspector".

The label carries the 44px minimum on a coarse pointer — the label rather than
the input, because the input is the control and is visually hidden, so the label
is the whole of what a finger can aim at. The mobile audit had already had to
add that once for the tool page, where picking a file was the only way to get
data into `image-convert` at all; reuse means the canvas inherits it rather than
repeating the finding. `check:browsers` measures it in both engines with a real
coarse pointer, on the two-port tool, so it is two controls that are measured.

### What a node shows

`photo.png · 2.1 MB` in the summary box, **while there is no result yet**. Once
a node has run, its answer is its situation — the rule the summary box already
follows for the tool's description — and a file that pushed the result out of
the box would cost the node the thing it exists to show. The filename is in the
node's accessible name unconditionally, so it does not stop being available when
the answer arrives, and "which node has the photograph" is a question a file
input creates.

Rejected: a permanent chip in the footer, which has 224px for `blocked` and
`3 wires` already; and a paperclip badge, which is an unlabelled glyph carrying
information — the one thing the accessibility rules here refuse outright — and
labelling it needs room the node does not have.

### One file feeding two nodes

Binary payload ownership has bitten before, which is why inputs are **borrowed**
(structured cloned) by default and transferred only on an explicit opt-in: a
fan-out to two consumers detaches the second. A file is a second source of one
buffer reaching several tools, so the same guarantee is asserted for it —
`fanout.test.ts` holds the line for a wired output, `attachments.test.ts` and
`graph.test.ts` hold it for a file, and `check:browsers` crosses a real
`postMessage` with two hashes of one file and compares both digests against
known values. An empty input has its own well-known digest, so a detached buffer
would sail past a "both ran" assertion.

### What was rejected

- **Persisting the file in IndexedDB.** It would mean a canvas silently carrying
  somebody's 60 MB photograph across sessions, plus a second store to validate,
  migrate and garbage-collect, for a value the user still has on disk.
- **Putting the filename in a share link.** The recipient has no file and gains
  only the name — and a filename is frequently the most revealing string in a
  document.
- **A single file per node**, as the tool page has. It leaves `diff`'s second
  port unreachable by file on both routes.
- **Choosing a file as an undo step.** Input is not in the history — typing is
  not either — and it would be an entry undo could not always honour, since the
  reference would come back pointing at bytes nothing holds.
- **Guessing a port for a two-input drop.** One of the two comparisons becomes
  unreachable by drag, and it is the wrong one half the time.
- **Creating a node from a drop on the background.** A gesture that silently
  picks a tool from a file's bytes is a worse surprise than one that does
  nothing.
- **A drop zone on the node itself.** The node is 224px with two clamped lines
  and a summary that is already doing four jobs; the whole node is the target
  instead.
- **Reading the file per run rather than holding the value.** A 64 MB image
  re-read on every 300ms debounce, triggered by typing in an unrelated node.

## The tool runner page

`/tools/:id` is the plain view of one tool. It is generated entirely from the
manifest entry plus the tool's own `optionFields`, so ten tools share one
component and adding an eleventh adds no UI.

### Four regions, in reading order

The source order is the reading order. Three of the four are in a grid; the
fourth is deliberately not, for reasons the next section is about:

```
                        < 1000px                  >= 1000px

                     +--------------+      +-------------+--------+
                  1  |    Input     |      |    Input    | Options|  <- .layout
                     +--------------+      +-------------+  ....  |
                  2  |   Options    |      |             | scroll |
                     |     Run      |      |   Output    |  ....  |
                     +--------------+      |             |  Run   |
                  3  |    Output    |      +-------------+--------+
                     +--------------+
                  4  |    Ports     |      |         Ports        |  <- page flow
                     +--------------+      +----------------------+
```

**Options come before Output in the DOM.** This is the whole design, and it is
in the markup rather than in the CSS on purpose. The layout it replaced was two
stacked columns — `[Input, Output]` beside `[Options, Ports]` — which put the
options panel after the output in source order and had both available defects
at once:

- Stacked, below the breakpoint, the options were literally _below the result_.
  Changing one option meant scrolling past an arbitrarily long output, changing
  it, and scrolling back up to see what happened — on every tool, on every
  visit.
- Side by side, above the breakpoint, the eye read Input, Options, Output while
  Tab and a screen reader went Input, Output, Options. Nothing looked wrong,
  which is why it survived.

`order`, `row-reverse` and a column-major grid would each have fixed the first
and made the second worse, so none of them is used. Two tests hold the line:
`ToolRunner.layout.test.tsx` asserts the heading order, the tab order and that
the stylesheet contains no reordering property at all; `checkRunnerLayout` in
`cross-browser-check.mjs` measures the four regions at 320, 390, 768, 999,
1000, 1280 and 1920 px and asserts that sorting them by (top, left) reproduces
their DOM order.

### The decisions, and why

**The breakpoint is 1000px, and the number is arithmetic.** The rail is 300px
and the page's gutters are 16px a side, so a second column only pays for itself
once what is left over is a main column wide enough for the widest thing drawn
in it — the regex match table and the side-by-side diff both want about 600px
before they start scrolling. 600 + 300 + 16 + 32 = 948, and 1000 is the next
round number clear of it. Below that the rail would be taking width from the
data in order to show four select boxes. There is deliberately only one
breakpoint: the extra width on a large monitor goes to the output, where a diff
and a match table can use it.

**The options are never collapsed or hidden.** A `<details>` closed by default
would reproduce the original bug in a different shape — the options would be
discoverable only by knowing they were there — and open by default it saves
nothing. The panel is always expanded, at every width.

**Run moved out of the Input panel and into the rail, below the options.**
Required rather than cosmetic: with the options directly above the output, a
Run button above the options would mean change a flag, scroll up past them to
reach the button, scroll back down past them to see the result. It also means
that on a wide screen — where the rail is sticky — Run is on screen however far
down a long result you have scrolled, which it was not before.

**It sits in a card.** It used to be the rail's bare tail: a button, a cancel
button and a progress bar directly on the page background, on a surface where
every other region is a bordered module. It is a `Panel` now, untitled — `Panel`
claims a named region only when it has a title, and a fifth unnamed region in
the landmark list would be noise while "Run" as a heading above a button
labelled Run is worse than no heading at all.

**And it travels with the options**, which is a decision rather than a leftover
— see [the height the page does not
reserve](#the-height-the-page-does-not-reserve).

**The rail is sticky above the breakpoint, and scrolls independently when it
has to.** It spans both content rows, so `sticky` has somewhere to travel; it
stops at the bottom of the output, because below that you are reading the ports
footnote rather than the result. `grid-template-rows: minmax(0, 1fr) auto` puts
the scroll on the options and never on the run button — the tallest options
panel in the set (regex, with a pattern, a mode, a replacement and five flags)
is taller than a 460px window. Below the breakpoint it is neither sticky nor a
scroller: a pinned rail on a phone spends viewport the result needs, and a
nested scrollbar inside a document that already scrolls is a defect this
project has already fixed once.

### The rail's containing block, and the thing it was allowed to paint over

A sticky box's travel is bounded by its **containing block**, and for a grid
item that containing block is the grid **container** — not the grid area it was
placed in. That is the opposite of the intuitive reading, and getting it wrong
cost this page a defect that was visible on every tool.

Ports used to be a third row of `.layout`, spanning both columns. The rail
spans rows one and two, so the natural assumption is that it can only travel
across those two rows. It cannot: it travels until its bottom edge reaches the
bottom of the **grid**, and the grid's bottom edge is below Ports. Measured on
`/tools/jwt-decode` at 1280×800 — scrolled to the foot of the page, the rail's
bottom sat 52px below the top of the Ports panel, and from the moment it came
unstuck its bottom edge tracked the grid's bottom edge to the pixel. The JWT
page failed soonest only because its options panel is the second tallest in the
set; nothing about the failure was specific to it.

**`/styleguide` runs the same pattern and has never had the problem**, which is
the clue that made the cause findable. Its grid has exactly two children: one
`.content` column holding every section, and the sticky `.sidebar`. So the
sidebar's containing block bottom _is_ the content column's bottom, and there is
nothing inside the grid below it to reach. The tool page's grid had a third row,
and that row was full-bleed, so it lay across the rail's whole travel range.

**The fix is that `.layout` holds only the three regions the rail travels
beside.** Ports is a sibling in the page's own flow. Nothing about z-index,
margins or padding was involved, and none of them could have been: the rail was
not escaping its bounds, it was inside them. The property that now holds is
structural rather than measured — anything a future tool renders below the fold
is outside the rail's containing block, because it is outside that grid, whatever
its height and however tall the options panel is.

One more thing fell out of the same span. **Two `auto` rows split the rail's
surplus height between them**, which put 80px of nothing between the Input and
Output panels on a JWT page and moved the Output panel's top whenever an option
appeared. The rows are `min-content minmax(0, 1fr)` now: row one is exactly the
input's height, so an option appearing or going cannot shift where the result
starts, and row two absorbs whatever surplus there is, where it is invisible
because the Output panel stretches into it.

**`.optionsScroll` being a scroll container is load-bearing, not hygiene.** A
scroll container's min-content contribution in the scrolling axis is zero, so it
is what stops a tall options panel sizing the grid's rows by its own height —
without it a tool declaring forty fields would inflate row two and hand the
Output panel several thousand pixels of empty card. What such a panel can do is
push the rail up to its viewport cap and no further: measured, a 2400px options
panel and a 4800px one draw the identical page, and the first takes a JWT page
from 1077px to 1353px and stops. That bound used to be zero rather than a
viewport, because a page already forced to `100dvh` could not be made taller by
anything — bounded rather than free is the honest shape of a two-column layout
whose second column is the tall one. It has to be
that box rather than the rail: `overflow: hidden` on the rail would make the
rail itself a scrollport, and a rail that scrolls is one whose options and whose
run button can be scrolled apart from each other inside a page that already
scrolls.

And **the `z-index` is gone**. It was on the rail, and it was never the fix — it
decided which of two boxes painted on top of a collision rather than preventing
one. A rail that cannot reach any other content does not need to be told what it
paints over.

> **The canvas selection bar is the same family and not the same primitive**, so
> it was checked and left alone. It is `position: absolute` inside the canvas
> root, which is explicitly `position: relative` with `overflow: hidden` — an
> out-of-flow box whose containing block is declared rather than implied, and
> which clips. The canvas route does not scroll at all, so there is no
> scrollport for a travel range to exist in. The tool page's bug was that its
> containing block was _implied_ by the grid and happened to include a third
> row; nothing on the canvas can acquire one by accident.

> `<main>` carries `overflow: clip` rather than `overflow: hidden`, and the
> difference is load-bearing. `hidden` makes an element a scroll container —
> one that happens never to scroll — and `position: sticky` inside a scroll
> container that never scrolls never moves. The rail was pinned to `<main>`
> instead of to the viewport and scrolled away with the page. `clip` clips
> exactly the same pixels and establishes no scroll container.

### The height the page does not reserve

`.layout` carried `min-block-size: calc(100dvh - var(--pb-space-lg) * 2)` and
the rail carried `block-size: 100%`. Between them they held every tool page open
to a full screen, and the reason was Run: a region that is never shorter than a
full-height rail is a region whose last row is always in the same place, so no
option appearing above the button could move it.

It worked. Here is what it cost, measured in the production build at 1280×800
with nothing run yet:

| Tool  | Grid  | Options scroller | Options inside it | Output panel |
| ----- | ----- | ---------------- | ----------------- | ------------ |
| Hash  | 768px | 694px            | 302px             | 416px        |
| Regex | 768px | 694px            | 490px             | 416px        |
| JWT   | 768px | 694px            | 418px             | 416px        |
| Image | 768px | 694px            | 302px             | 600px        |

Three things follow from that table, and all three are what the page looked
like. Every tool page was the same height whatever was on it. The Output panel
was several hundred pixels of bordered nothing around the sentence "No output
yet", and on the tools whose result is one short string it stayed that way after
a run. And the rail carried 200–400px of bare page background between the last
option and the run card, so the primary action was a box attached to nothing —
which then needed `position: sticky` on its block end to rescue it from a fold
the reserved height had put it below. Two mechanisms, the second compensating
for the first.

**Both are gone. The grid is as tall as its tallest column and no taller**, and
`checkRunnerLayout` asserts exactly that at seven widths, along with the options
scroller being exactly its content whenever the options fit.

**The consequence is that Run moves again, and that is the trade.** The rail is
one sticky unit — the options, then the card — so the card is one gap below the
last option and travels when the options change height. One tool changes it:
`text-convert` reveals and hides fields as its target format changes, which puts
the button at 536 for HTML, 669 for plain text and 914 for Markdown.

**And the run card's `position: sticky` went with it, which fixed a defect
rather than causing one.** Its job was to push the card up to the fold when the
reserved height had put its resting place below one — which was every tool page.
But the card is opaque, and the box it was pushed up over is `.optionsScroll`.
Measured on the shipped build at 1280×800 with text-convert set to Markdown: the
scroller ran to 885, the card sat at 726..784, and the last 159px of a
_scrolling_ options list was underneath it — three fields you could scroll to
and not see. On the other tools the reserved height left the scroller mostly
empty, so the card was floating over nothing and nobody saw it.

Nothing replaces it. A rail is only taller than the space below the page heading
if its options genuinely are, which at 1280×800 is text-convert's Markdown
layout and nothing else; there the button rests at 914 in an 800px window, about
120px of scrolling away. A button one small scroll away is a smaller cost than a
button that hides the settings it applies, and `checkRunnerLayout` now asserts
that the gap between the options and the button is positive in all three
layouts.

In that one state the rail does not stick either, and the reason is worth
knowing rather than fixing: `sticky` needs slack between the box and its
containing block, and a rail that is the tallest thing in the grid is exactly as
tall as the block bounding it. That can only happen while there is no result —
which is also when there is nothing for the rail to stay beside. As soon as a
result gives the content column height, the rail has travel again and pins,
which is the case `checkRunnerLayout` measures on a 600-row diff.

The arithmetic is not close. The reserved height charged every page of every
tool a screen of dead space in order to hold one button still on one tool when
one control is changed — and what it bought was a button pinned to the far side
of a gap, which is not the same thing as a button you can find. What is asserted
in its place is the property that actually matters, for all three of
text-convert's layouts: **Run is one gap below the options, never on top of
them, and never more than a screen from the fold.** A control that travels with
the panel it belongs to is legible when it moves.

Two things that did _not_ depend on the reserved height, and are unchanged: row
one is `min-content`, so the Output panel's top is the input's height alone, and
`.optionsScroll` is a scroll container, so a tall options panel cannot size the
grid's rows.

### A result is drawn the size of the result

The output textarea shared `.editor` with the input editors, so it inherited a
200px floor. That floor is right for an input — an input is a place to put
something that is not there yet, and a box sized to its emptiness is one you
have to grow before you can use it. It is exactly wrong for an output, which
already knows how much of it there is. Colour's `#3366cc`, seven characters, was
drawn in a box 200px tall and 560px wide, and hash's sixty-four-character digest
in the same one. On the two tools whose entire result is one short string, the
box around the result was the largest thing on the page.

`.result` is its own class now and asks for `field-sizing: content`, clamped to
a floor of one and a half controls and to the 520px cap the diff scroller
already uses. Past that cap a result is something you copy or download rather
than read through a window.

**`rows` is the fallback and not the mechanism**, and the order matters.
`field-sizing` measures the _wrapped_ height, which is the accurate answer; a
`rows` count can only count newlines, so a 40 kB base64 string is one line to it
and forty screens to the browser. Where `field-sizing` is unavailable the box
asks for the floor and gets a scrollbar, which is the correct failure rather
than a wrong height. Both paths are clamped by the same stylesheet, so the two
agree about the floor and the cap. `OutputPanel.test.tsx` holds the `rows`
arithmetic, because jsdom can see an attribute and cannot see a height;
`checkRunnerLayout` holds the height.

**An output port is named only where the name distinguishes something.** Base64
declares its single output as "Output", under a panel heading that says
"Output" — two labels for one value, and the same duplication on five of the
nine tools. The input editors already followed this rule. Colour and diff
declare two outputs each and keep their labels, because there the name is the
only thing telling the swatch from the converted string. Nothing is lost by
dropping the rest: the Ports footnote names every port on the page, and the
accessible name of the output box is built from the port label whether or not it
is drawn above it.

### Output views are chosen by the port, except for bytes

There are two rules here and they are deliberately different, because they
answer two different questions.

**A `json` value is drawn by whatever its PORT declared.** A diff, a regex
report, an image-conversion report and a decoded JWT are all `json`, and a JSON
tree is the wrong view for every one of them. Nothing in the value itself can
tell them apart, so `OutputPort.presentation` names the renderer — `diff`,
`regex`, `html`, `report` or `jwt`. It is a hint only: the value stays ordinary
JSON, and anything consuming the port ignores it and still gets valid data.

**A `bytes` value is drawn by what the BYTES ARE.** That question has an answer,
and the branch was already asking half of it — the sniff is how it chose between
a text preview and "Binary output. Download it rather than trying to read it
here." Asking it one step further is what turns the image converter into a tool
that shows you the picture, and it does so without a port hint, which means
base64's decoded output gets the preview too. Declared media types are ignored
in favour of sniffed ones, the same rule the rest of the app follows.

Two of the five views exist because a tool did careful work that the
presentation threw away:

- **`report`**, because the image tool's prose about what it changed without
  being asked — transparency flattened, frames dropped, GPS coordinates removed
  — was rendered as `JSON.stringify` in a read-only textarea three panels down.
- **`jwt`**, because `NOT VERIFIED - no key supplied` was a string value among
  other string values, one line above a `header` object nobody scrolls past.
  That one is not an aesthetic problem: a JWT payload is base64 rather than
  encryption, so a decoder that shows claims without the verdict being obvious
  is one that makes forgeries look authoritative. The view's rules are written
  down in [the tool's README](../src/tools/jwt-decode/README.md#how-it-is-drawn).

### One toggle, and the rule it follows

A view is a presentation of an output, never a replacement for it, so every
view that renders a payload as something other than the payload has to hand the
payload back. That was true of two of the four views: the HTML output had Source
and Preview, the report had Report and Raw — with identical markup and two
byte-identical copies of the same CSS — and the diff and the regex report had no
way to reach their JSON at all. Three implementations of one decision, and a
fourth that had quietly opted out of it.

[`ViewToggle`](../src/features/toolrunner/ViewToggle.tsx) and
[`RawPayload`](../src/features/toolrunner/RawPayload.tsx) are now the only
implementation, and the rule is:

> A view is `[rendering] [raw]`, in that order, with the rendering pressed by
> default — **except** where the raw payload is what the person came for, in
> which case raw comes first and is the default.

HTML source is the one case of the exception: it is a developer tool, and a
preview you have to dismiss before you can read the markup would be in the way.
Two `aria-pressed` buttons describe the control; a `role="status"` line says
which view is SHOWING, because "Raw, pressed" is a fact about a button.
`views.consistency.test.tsx` asserts all of that for every view at once, which
is the test that stops them drifting apart a second time.

**Bytes are the one documented exception, and have no raw state.** Their payload
is a file rather than text — nothing to put in a textarea, nothing to copy — so
Download and the sniffed facts are on screen in every state instead of behind a
switch. That is a stronger form of the same guarantee rather than an exemption
from it, and the consistency test asserts the absence so it reads as a decision.

### The same views on the canvas

The canvas used to render no output values at all, and no options either: a
node carried a title, a status LED, a timing, its ports and a text box. The
consequence was not cosmetic. **Every node in every chain ran on default
settings**, because there was nowhere to change them, and **no result was
visible anywhere** — including the last node's, which is the thing a chain is
built for. `NodeRunState` had held `outputs` all along and nothing read them.

The [node inspector](#the-node-inspector) is where they are read now, and it
uses `OptionsPanel` and `OutputView` unmodified. Two things made that possible
rather than a rewrite:

- The options panel is already driven entirely by the tool's typed
  `optionFields`, including the `when` predicates. It filters internally, so
  text-convert's conditional panel — and the stability property asserted by
  `conditionalOptions.test.tsx` — holds in the inspector for free.
- Every output view already caps its own height (the diff scroller at 520px,
  the regex tables at 320 and 380, an image at 420) and is already measured at
  320–430px by `checkMobileLayout`, because that is what a tool page looks like
  on a phone. **The rail's 320px minimum is inside a range those views are
  already held to**, which is why a full-width panel's components fit in a
  narrow one without a second implementation.

One prop is deliberately not passed through: `comparison`, the image
before-and-after. ImageView's own reasoning is that two images side by side at
320px are two images too small to judge anything by, and the rail is 320px at
its narrowest by construction.

### An input port that cannot take text gets no text box

The runner used to draw a full-size editor for every declared input port.
`image-convert` declares `types: ['bytes']`, so every keystroke in its editor
could only ever produce `Input "Image" cannot accept text data` — an affordance
for behaviour that does not exist. A port that does not accept `text` now
renders its own description as the instruction for the file control instead,
and running with nothing chosen says "Image takes a file. Choose or drop one
first." rather than reporting a type error.

The file control itself is [shared with the canvas](#a-file-as-an-input) now,
and two things about this page changed with that. It is handed the PORT its file
will feed rather than only a size limit, so a PNG chosen for a text-only port is
refused at the moment of selection instead of at the moment of Run. And it no
longer re-reads the file on every press: the whole `File` was pulled into memory
twice per run — once to sniff it and again to use it — which also meant the
sniff came from one read and the bytes from another, so a file edited on disk
between the two would have been processed under the previous file's verdict
about what it was.

## Between tools

Every tool is sound on its own. This section is about the seams — the places
where composing them behaves differently from either half, and where the
answers below were decided rather than fallen into.

### A port's types are a promise about what _might_ arrive

`canConnect` compares two ports' declared type lists and allows the wire if
they overlap. That is a static check on a union, and a union is not a
guarantee: base64's output really is `text` when encoding and `bytes` when
decoding, so `base64 → jwt` is legal to draw and may still deliver bytes to a
port that only takes text.

So the wire is checked twice, and the second check is the real one:
`validateInputs` runs inside `eraseTool` against the value that actually
arrived, and refuses it with `unsupported-type` naming the type it got. The
refusal lands on the node that received the value, which is where the wire's
consequence is visible, and it does not disturb anything else on the same
output port.

The example used to be `base64 → regex`, and the [port
audit](#the-port-set) took it away: every port that reads a document accepts
`bytes` now, so the only ports left that can refuse a value at runtime are the
two that take a short literal — a compact token and a colour. That is the
shape to expect. The static check is loose where a tool can genuinely read
several kinds of value and tight where it cannot, so a runtime refusal is
increasingly a sign that somebody wired a picture into a colour box rather than
a hazard of the model.

The alternative — ports that appear and disappear as options change, so the
graph is always statically sound — was rejected when the port model was
written, and composing the tools has not produced a reason to revisit it. What
it would buy is a wire you cannot draw; what it costs is a node whose shape
changes under you while you are wiring it.

### A run holds the graph it started with

Editing anything schedules a new run, and starting a run aborts the one before
it. A run therefore works on a snapshot, and can finish computing a node the
user has since deleted.

Three rules keep that from leaking:

- A superseded run's per-node updates are dropped (the run token in
  `pipelineStore`), so it cannot paint over the newer run's results.
- The finished run replaces the state map wholesale, so nodes that are gone
  from the graph are gone from the state.
- Cache entries for absent nodes are pruned at the start of every run.

Undo and redo are graph edits like any other and go through exactly that path.
A graph _replaced_ rather than edited — a share link, a saved canvas — also
resets the pipeline store, because node ids are reused across documents (every
canvas starts at `n1`) and the previous pipeline's output on the new
pipeline's nodes is a wrong answer rather than a missing one.

### Ids from outside this session

`nextId` is a counter, and `withNode`/`withEdge` keep it ahead of everything
they insert — for graphs built in this session. A graph that arrives from
outside carries ids issued by a different one, and its counter has to be
rebuilt from the ids present rather than guessed at.

It was guessed. A share link restored with `nodes.length + edges.length + 1`,
which is correct only while ids are dense — and they stop being dense the
moment anyone deletes a node. A pipeline whose survivors were `n3` and `n7`
restored with a counter of 3, so the next node the recipient added was _also_
`n3`: adding a node silently overwrote an existing one, changing its tool while
its wires stayed attached to ports the new tool does not have. The saved
canvas had the same shape of bug via a stored counter that had fallen behind.

### Known limitations

**Two tabs, one canvas.** The saved graph is a single `localStorage` key with
no cross-tab coordination, and nothing listens for `storage`. Open the canvas in
two tabs, add a node in each, and reload the first: the second tab's save has
replaced the first's, including its ids. Last write wins, silently. This is not
fixed here because the fix is a product decision (which tab wins, and what the
other is told) rather than a defect to repair, and a half-measure — a toast
saying the canvas changed elsewhere — is more confusing than the current
behaviour rather than less.

What has changed is that it is now **reproduced rather than described**.
`checkTwoTabs` in `check:browsers` opens two pages in one browser context —
which is exactly the scope `localStorage` has, so it is a second tab in every
sense — adds a different tool in each, and asserts the behaviour in three
parts: both tabs stay right about themselves while they are open, the saved key
holds only the last writer, and reloading the first silently gives it the second
one's canvas with no message at all. It was reachable all along, and appears to
have gone unreached because it was filed under _decided_ rather than under
_untested_. Asserting the current behaviour is what stops the paragraph above
drifting away from the app: if somebody adds a `storage` listener, that check
goes red and the change is deliberate.

**Image conversion blocks its own deadline where `OffscreenCanvas` is absent.**
The engine downgrades `image-convert` to the main thread there (Safari before
16.4, Firefox before 105), which is the documented fallback and produces an
identical result. What it also does is block the main thread for the length of
the conversion — during which no timer fires and no worker message is
processed. A sibling node's deadline can therefore expire while its result is
already sitting in the message queue, and be reported as a timeout. To
reproduce: on a browser without `OffscreenCanvas`, convert a large image beside
a regex node on the same canvas. There is no workaround short of chunking the
conversion across frames, which is a redesign of the tool rather than a fix to
the engine. `scripts/cross-browser-check.mjs` asserts which branch each engine
takes, so the fallback cannot rot unnoticed.

**No harness here has seen a real on-screen keyboard.** Playwright cannot open
one in either engine. What it _can_ now be made to produce is the geometry, and
that turned out to matter more than it looked.

The check used to drive this by shrinking the window with `setViewportSize`,
described as "the same arithmetic on a different event". It was not the same
arithmetic. A window resize moves the layout viewport **and** the visual one
together, so `innerHeight - visualViewport.bottom` is zero and
[`keyboardInset`](../src/features/canvas/keyboardInset.ts) computed **0 px**
however small the window got. The sheet stayed on screen because the bottom of
the layout viewport had moved up with it — which is equally true of a sheet with
no keyboard handling at all. The check was passing on an app that had never had
the feature.

`visualViewport.height` is an accessor on the prototype, so an own property
defined on the instance shadows it, and the app reads the instance. Defining one
and dispatching the real `resize` event on the real `visualViewport` object puts
the page into the state a keyboard puts it in: a visual viewport genuinely
shorter than a layout viewport that has not moved. `checkSoftKeyboard` does that
now, and asserts four things it could not before — that a window resize yields a
zero inset (logged as a number, so the paragraph above is a measurement rather
than a claim), that a visual-viewport shrink lifts the sheet by exactly the
covered height, that the sheet and its focused field both end up above the
keyboard line, and that the inset returns to zero when the keyboard closes. The
dialog check and the fine-pointer check are driven the same way, so the chain
from `visualViewport` through `useKeyboardInset` to the custom property to the
geometry is exercised as one thing rather than in halves.

**It found a defect on its first run**, which is the strongest argument that the
window resize had been proving nothing. The inset MOVED the sheet and never
RESIZED it. Its height cap was `max-block-size: 65%`, measured against the
layout viewport that a keyboard does not shrink — so at 390×780 with a 336 px
keyboard, a 474 px sheet lifted to sit on top of the keyboard had its top at
**−30 px**. The body scrolls, so nothing in it was lost; the head does not, so
what went off the top was the node's name and the only control that closes the
panel. The cap is `min(65%, calc(100% - var(--keyboard-inset, 0px)))` now: the
second term is exactly the visible band, and with a keyboard open the canvas
behind the sheet is not what anybody is looking at, so filling that band is
right rather than merely safe. This is the same defect the inset itself was
written to fix, one step further along.

This is a simulation and is labelled as one in the run. The geometry is real,
the event is real and the code path is real; the keyboard is not. What it proves
that nothing here could before is that the sheet moves for the **visual**
viewport specifically — an implementation reading `window.innerHeight`, which is
the obvious wrong answer, passes a window resize and fails this. Whether iOS
fires that event when the keyboard opens, and whether what you end up looking at
is usable, still needs a phone: see
[manual-checks.md](manual-checks.md#2-a-real-on-screen-keyboard).

The rest is unchanged, and is why there is only one number to compute: every
field in the app lives in an ordinary scrolling box — the routes are documents,
and the canvas's fields are in the inspector, which is a scroll container — so
the engine's own scroll-into-view has somewhere to put a focused field. The one
thing left to application code is the inspector SHEET's position, anchored to
the bottom of the layout viewport that a keyboard does not shrink.

(This replaced a viewport pan. Node fields sat on the 0×0 transformed plane
inside an `overflow: hidden` root, so `scrollHeight` equalled `clientHeight`
however far the graph extended and there was nothing for a browser to scroll:
measured at the time, a node's textarea at y=491 with the visible area cut to
444px left `scrollTop` at 0 in both engines. Moving input into the inspector
removed the condition rather than the symptom.)

**A file lasts as long as the tab.** This is the deliberate answer rather than
a defect — see [a file as an input](#a-file-as-an-input) — but the consequence
is worth stating as a limitation: a canvas whose sources are files is not a
canvas you can close and come back to without re-choosing them, and a graph you
share is not one the recipient can run without supplying their own. A node
deleted and undone keeps its file; a graph replaced by a load or a link loses
every one, and a deleted node's bytes are retained until then.

**A repackaged video cannot be larger than about 1.9 GB, and that is a
browser's limit rather than this app's.** This paragraph used to say something
much worse — that nothing over 256 MB could be repackaged at all, and that
almost every file the tool exists for is larger than that. What changed is
[the value model](#where-a-values-bytes-are), and what is left is the half of
the problem a tab genuinely cannot solve.

The input side has no limit worth stating any more. A chosen file stays on
disk, crosses into the worker as a reference, and is read through a window;
`maxInputBytes` is 4 GiB and is a statement about what the tool will agree to
walk rather than about what fits in memory. The old number was three or four
copies of the input, and none of those copies exists.

The **output** is the part that cannot be streamed away. It has to become one
blob for a download, and blob storage is bounded: assembling 8 MB parts in a
worker and reading the result back after each, Chromium stops at 1.88 GiB with
a `NotReadableError`, while Gecko and JavaScriptCore both went past 4 GiB. So
`MAX_BLOB_BYTES` is 1.875 GiB — the largest size measured readable in every
engine — and a repackage that would exceed it is refused **before anything is
copied**, naming the size and pointing at the audio operation, which produces a
few tens of megabytes out of the same file and is unaffected.

What that means in practice: a DivX film and a feature-length MKV now go
through, an AVCHD clip split at 2 GB is at the line, and a four-gigabyte tuner
recording can have its audio extracted but not its container changed. The
output is usually a little smaller than the input - the extra audio dubs are
left behind and nothing but `moov` and `mdat` is written - so a file a shade
over the ceiling often produces an answer a shade under it. The remaining fix is not a larger number either
— it is writing the output somewhere other than a blob, which means the File
System Access API in Chromium or OPFS in all three, and both are a save flow
rather than a value. Neither is paid for by anything this version does.

**The fourth copy a transport stream cost is gone too, and it is worth saying
where it went.** Its frames are not contiguous in the file — one picture is
spread across dozens of 188-byte packets, each with a header in the middle of
it — so the samples that get written still have to be gathered before they can
be indexed. They are gathered into a `ByteSink` rather than into a buffer: a
small stream stays in memory exactly as it did, and a large one goes to blob
storage as it fills, and what the writer indexes afterwards is a source over
it. The measuring pass survives, not to size an allocation but as the bound on
how much a hostile file may cause to be gathered.

**Progress is not reported through a pipeline.** `runPipeline` passes no
`onProgress`, so a tool that reports progress shows none on the canvas. No
shipped tool declares `reportsProgress: true`, so nothing is currently lost;
adding one would need this wiring first.

"Nothing is currently lost" is a statement about the manifest, and the manifest
changes — so it is asserted rather than written down. `registry.test.ts` fails
if any entry declares `reportsProgress: true`, with a message saying what has to
be wired. Left as prose, the day somebody adds such a tool is the day this
paragraph quietly becomes wrong and the canvas quietly starts discarding
progress, with nothing failing, because a callback nobody passes raises no
error.

**Nothing here has seen a backgrounded tab, but the thing a backgrounded tab
does is now measured.** Playwright cannot produce one: bringing another page in
the same context to the front leaves `document.visibilityState` at `visible` in
both headless engines, with 300 ms timers still arriving at ~310 ms intervals
(measured, both engines).

What the app is exposed to, though, is not hiddenness. It is **late timers** —
every deadline in the engine is a `window.setTimeout`, and a hidden tab clamps
those to a 1 s floor and later to something far coarser. A late timer can be
produced exactly, in a real engine, against the real worker: replace
`setTimeout` with one that will not fire before a floor, which is what the
browser does and all that it does. `checkBackgroundedTab` installs a 3 s floor
and a shadowed `visibilityState` before the bundle loads, then runs a wedging
regex node beside a healthy base64 node.

The reasoning used to be that clamping can only make a deadline **late**, and
that a late deadline is a no-op because a settled request has already been
removed from `pending` with its timer cleared. That is reasoning about code, and
it is now three assertions: the wedged node still fails rather than hanging, the
healthy node beside it keeps its own result rather than being blamed by a
deadline that arrived after the answer, and nothing throws while the clock is
stretched. The base64 node is the one that matters — it finishes in single-digit
milliseconds and its own 15 s deadline is never reached, so a late deadline able
to settle an already-answered request would show up there as an `error` on a
node that plainly succeeded.

Timers under 100 ms are left alone so Playwright's own injected polling keeps
working; every deadline this is about is far above that — 2 s for regex, 15 s
for base64, 500 ms for the re-run debounce. A genuinely hidden tab is two
minutes of manual work: see
[manual-checks.md](manual-checks.md#3-a-backgrounded-tab).

**The two engines disagree about catastrophic backtracking**, which matters for
any test that wants to wedge a worker on purpose. SpiderMonkey runs until it
exhausts its stack — about seven seconds — and throws. JavaScriptCore bounds
the backtracking **count**, not the time, and gives up quietly: under a second
for the familiar `(a+)+$`, and around two for `(a*)*(b*)*c`. A check that
assumes the Firefox behaviour passes in WebKit while proving nothing.

The consequence for the harness is that **lengthening the subject does not make
a pattern more expensive in WebKit**. The budget is spent inside a single
`exec` however long the input is — 40 characters and 200 characters both give
up at about the same moment — so `(a*)*(b*)*c` over 40 characters sat within a
few hundred milliseconds of the regex tool's 2s deadline and drifted onto the
wrong side of it, reporting `ok` for a node that was supposed to wedge. What
raises the cost is making each backtrack step more expensive, so the pattern
`scripts/cross-browser-check.mjs` uses now alternates over the whole lower-case
alphabet: about 6.8s in WebKit and 7.0s in Firefox, better than three times the
deadline in both.

### What was looked at and found sound

Recording these because knowing where the scrutiny went is worth as much as the
list of things it found:

- **Fan-out and buffer ownership.** Twelve consumers on one binary output, more
  than the concurrency bound, all receive intact bytes — including on a run
  where the source is served from cache. Inputs are borrowed (structured
  cloned), never transferred, from every call site in the app. A file is the
  second source of one buffer reaching several tools and is held to the same
  line, in both engines. **A deferred value is held to it a third way**: a blob
  is immutable and re-readable, so twelve consumers reading one get twelve
  intact copies, and the test reads every one of them rather than the first —
  a value that read back correctly only once is the failure that shape could
  have.
- **Every legal pair of tools.** Each output/input pair whose declared types
  overlap was run with real data. Every one either produces a correct value or
  fails with a message about the actual input; none crashes, hangs, or produces
  a plausible wrong answer.
- **Failure propagation down a long chain.** Every node below a failure names
  the node that actually broke, not the one above it, and carries no error text
  of its own.
- **Cache identity across documents.** The cache is keyed by node id, and node
  ids repeat across documents — but every other component of the key is derived
  from content, so a collision can only serve a result that is correct anyway.
  The pipeline store is reset on load regardless, because the _displayed_ state
  would otherwise be stale for the length of the re-run debounce.
- **Dangling edges.** A wire whose source node is missing used to leave its
  target waiting forever and absent from the run's states — neither failed nor
  blocked, just unmentioned. Nothing in the app produces one, and there is now
  a guard for when something does.
- **Every route and every overlay at 320, 360, 390 and 430px**, in both engines,
  with a coarse pointer. `checkMobileLayout` in `check:browsers` asserts the
  document's own `scrollWidth`, every visible box against the viewport, every
  box against a clipping ancestor, every child against a parent with a definite
  height, every interactive target against 44px and every typeable field against
  16px. It found a good deal the first time it ran — see the commit — and the
  measurements, not the controls' existence, are what it keeps asserting.

## State

Five Zustand stores, split by what invalidates them:

| Store             | Holds                                    | Persisted                                 |
| ----------------- | ---------------------------------------- | ----------------------------------------- |
| `graphStore`      | nodes, edges, selection, undo history    | `patchbay:graph:v3`                       |
| `viewportStore`   | pan and zoom                             | no                                        |
| `pipelineStore`   | per-node run status and results          | no                                        |
| `attachmentStore` | the bytes behind each node's file inputs | no                                        |
| `themeStore`      | selection, authored themes, draft        | `patchbay:theme:v1`, `patchbay:themes:v1` |

One more key belongs to no store: `patchbay:inspector:v1`, a single boolean for
whether the inspector is showing. It is read in a `useState` initialiser rather
than through a store because it is needed for the first render — an effect would
paint one frame of the wrong state, and here that frame would also start the
enter animation on a panel that was supposed to be simply present. See
[the node inspector](#the-node-inspector) for why it persists at all.

`attachmentStore` is not persisted for the same reason `pipelineStore` is not
part of the document — plus one of its own: a `File` cannot be serialised into
the key the graph lives in, and a filename must never travel in a share link.
The document keeps a name, a size and a token per port; the bytes live here for
the session. See [a file as an input](#a-file-as-an-input) for what that means
on a reload.

`graphStore` and `pipelineStore` both also hold an announcement log — see
[announcements](#announcements-are-a-log-not-a-variable). It is state rather
than a callback because a message must survive React's batching, and it is
bounded because a tab can stay open for days.

`themeStore` is the one that reads storage at MODULE LOAD rather than in an
effect: the first paint has to already be wearing the right theme, and an
effect running afterwards would show one frame of the wrong one. That is also
why its reader is hand-written rather than Zod — it is in the initial payload.
See [theming.md](theming.md).

Its `draftTheme` is the theme currently being edited. It outranks the selection
on screen and is never persisted, because it is what the page is showing rather
than what the user has chosen.

Execution status lives in `pipelineStore`, not on the node. It is _derived from
a run_, not part of the document — which is what the v1 → v2 migration was
about.

Saves are debounced, so a drag writes once rather than sixty times. Loads are
validated with Zod and cross-checked against the live registry; anything
corrupt, older, or naming a tool that no longer exists yields an empty canvas
and a message, never a crash.

## Build and deployment

```mermaid
flowchart LR
    src["src/"] --> tsc["tsc -b<br/>typecheck"]
    tsc --> vite["vite build"]
    pub["public/<br/>_headers, _redirects,<br/>fonts, icons"] -->|copied verbatim| dist
    vite --> dist["dist/"]
    dist --> sw["service-worker plugin<br/>emits sw.js with<br/>the real asset list"]
    sw --> csp["csp-hash plugin<br/>hashes the inline script<br/>into _headers"]
    csp --> out["deployable output"]
```

Three Vite plugins do work that cannot be done by hand:

- [`service-worker.ts`](../vite/plugins/service-worker.ts) lists the finished
  build and writes `sw.js` with that list plus a build id derived from it. A
  hand-maintained precache list would be wrong the moment anything was edited.
- [`csp-hash.ts`](../vite/plugins/csp-hash.ts) hashes the inline theme
  bootstrap **from the built HTML** and substitutes it into `_headers`. Hashing
  the source would be hashing something the browser never executes.

- [`index-html.ts`](../vite/plugins/index-html.ts) strips HTML comments from
  the shipped document — the source explains itself at length and none of that
  is any use to a browser — and refuses to build if a `%VITE_SITE_URL%`
  placeholder survived or an og:image, og:url or canonical is not absolute.

The `{{INLINE_SCRIPT_HASHES}}` placeholder is not a valid CSP source, so a
build that somehow skipped the plugin produces an obviously broken policy
rather than a quietly permissive one. The same instinct runs through
`index-html.ts`: the failure modes it guards against are all silent ones, and
the build is the last moment anybody is looking.

### The head has two audiences

The complete Open Graph and Twitter set is static markup in index.html, because
crawlers and link-preview bots never run the router. The router's per-route
head — see [`head.ts`](../src/app/head.ts) — is for the tab strip and for
consumers that do execute JavaScript. The static tags are marked `data-default`
and removed on mount, because React hoists its own copies without removing
anything already present.

Deployment is Netlify. `_headers` and `_redirects` live in `public/` rather
than in `netlify.toml` so that the exact bytes deployed are the ones in the
repo, and so `scripts/serve-dist.mjs` can serve the built app under the real
policy — what is tested locally is what ships.
