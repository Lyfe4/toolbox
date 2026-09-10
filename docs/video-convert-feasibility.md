# Video conversion: a feasibility investigation

A proposal for a client-side video converter — any format in, MP4 or similar
out — measured against this architecture rather than reasoned about.

Nothing here is built. This document exists so the decision can be made from
numbers. The spike that produced them is described at the end and has been
deleted; every figure below can be reproduced from the method given.

> **What happened next.** The remuxing half was built and shipped — see
> [the tool's README](../src/tools/video-remux/README.md). This document is
> left as the snapshot it was, because its numbers are what the decision was
> made from and rewriting them afterwards would destroy the record. Three
> things in it were **not** followed, each for a reason the building turned up:
>
> - **`@ffmpeg/core` is not shipped at all.** The recommendation was for a
>   remuxer that could also transcode, and taking only the first half removes
>   the argument for the payload: 30.7 MiB of encoders for an operation that
>   runs none. Both containers are parsed and the MP4 written in TypeScript, in
>   35.6 kB. The Cache Storage result stands and was not needed.
> - **`requiresWasm` and `wasmModules` were deleted rather than given a job**,
>   on the reasoning this document offered for exactly that case. So was
>   `'wasm-unsafe-eval'`, which is the same defect one layer down and was in
>   the security policy.
> - **Cross-origin isolation was kept**, and the header comment now says why:
>   not for threads, which this document measured as unusable, but because COOP
>   and COEP each earn their place without them — and because isolation gates
>   `performance.measureUserAgentSpecificMemory()`, which is the measurement
>   this document most wanted and could not get.
>
> And one thing it did not find, which the building did: **the files people
> most want to remux do not fit in a browser's memory at all.** The 92.6 MiB
> one-minute clip measured here generalises badly — the archetypal "won't play"
> file is a two-gigabyte film, and holding one is beyond this tool's 256 MB
> limit and beyond a WASM ffmpeg's 2 GiB heap ceiling alike.

- [The verdict](#the-verdict)
- [How this was measured](#how-this-was-measured)
- [The payload](#the-payload)
- [The CSP, which does not have to change](#the-csp-which-does-not-have-to-change)
- [What a conversion costs](#what-a-conversion-costs)
- [Memory](#memory)
- [What has to change in the engine](#what-has-to-change-in-the-engine)
- [The output, and whether it belongs on a wire](#the-output-and-whether-it-belongs-on-a-wire)
- [What breaks on a phone](#what-breaks-on-a-phone)
- [A realistic first version](#a-realistic-first-version)
- [How it would be tested](#how-it-would-be-tested)
- [What I am least confident about](#what-i-am-least-confident-about)

## The verdict

**Worth doing, narrowly, and not as the tool the sentence "convert any video to
MP4" describes.**

The three things I expected to be blockers are not, and one of them is much
better than expected:

- **The CSP does not have to change to ship the payload.** `connect-src 'none'`
  can stay exactly as it is, on the document and on the execution worker, by
  two separate routes I measured working in Firefox, WebKit and Chromium. The
  headline claim survives intact. The README's `connect-src` row does not
  change a word.
- **Memory is bounded and predictable.** Peak heap is a function of resolution
  and encoder preset, and is flat in clip length — 66 MB for 1080p at
  `ultrafast`, 412 MB at `medium`, the same for a 10-second clip as for a
  60-second one.
- **The payload is 6.9 MiB brotli**, not the tens of megabytes the raw figure
  suggests, and it costs the build 0.7 s.

What is a genuine blocker is **time**, and it is worse than the framing
"conversion takes minutes" implies, because the number depends on a setting
nobody will think to choose. At ffmpeg's own default preset a 1080p one-minute
clip took **284 seconds** on a desktop. At `ultrafast` the same clip took 41
seconds and produced an output _larger than its input_. There is no setting
that is both fast and good, and a tool that hides that choice will be wrong for
everybody.

The second genuine blocker is that the execution engine's three central
guarantees are each correct for a millisecond tool and each actively harmful
for a five-minute one — and they are not independent. Fixing them is a change
to the engine's contract, not a special case for one tool. That is the real
cost of this feature, and it is paid by the other nine tools.

The thing that resolves this, and the reason the verdict is yes rather than no,
is that **the operation most people want is nearly free**. Remuxing — changing
the container without re-encoding — did a 92.6 MiB 1080p one-minute clip in
**0.2 seconds**, 321× realtime, with no heap growth and no engine change
required at all. Audio extraction was 0.3 s. Transcoding is the expensive
minority case, not the common one, and a tool that leads with remuxing is a
useful tool on the day it ships.

So: build it, but build it as **a remuxer that can also transcode, and that is
honest about the difference** — not as a transcoder that happens to remux. The
detail is below.

If the answer is instead "not now", the thing worth keeping from this
investigation is the CSP result and the dead-manifest-field finding, both of
which stand on their own.

## How this was measured

A throwaway spike, driven by Playwright against a static server that reads
`dist/_headers` through the project's own
[`scripts/serve-dist.mjs`](../scripts/serve-dist.mjs), so every measurement ran
under the **real production policy** — the same CSP, COOP, COEP and CORP the
deploy sends. That mattered immediately: the spike's own inline bootstrap
script was refused by `script-src` on the first run, which is the harness
proving itself before it proves anything else.

- **Engines**: Firefox 1543 and WebKit 2359, the pair `check:browsers` already
  drives, plus Chromium 1243 where a third data point was worth having.
  Playwright's WebKit is not Safari; the caveat in the README applies here too.
- **Core**: `@ffmpeg/core` 0.12.10, the single-threaded build, loaded directly
  through its emscripten factory rather than through `@ffmpeg/ffmpeg`'s own
  worker layer — so that what was under test was this app's worker model and
  this app's CSP, not ffmpeg.wasm's.
- **Machine**: one desktop, Windows. Every timing is one machine's; the ratios
  between engines and between presets are the durable part, not the absolute
  seconds.
- **Sources**: synthesised in-browser with `testsrc2` plus a sine tone, then
  transcoded. Synthetic content encodes somewhat faster than camera footage, so
  the timings below are, if anything, optimistic.

Where a figure is an extrapolation rather than a measurement it says so.

## The payload

`@ffmpeg/core` 0.12.10, single-threaded:

| Artefact                             |      Raw |  gzip -9 |  brotli |
| ------------------------------------ | -------: | -------: | ------: |
| `ffmpeg-core.wasm`                   | 30.7 MiB |  9.8 MiB | 6.9 MiB |
| `ffmpeg-core.js` (glue)              |   112 kB |        — |       — |
| the same wasm, base64 in a JS module | 41.0 MiB | 13.4 MiB | 9.7 MiB |
| `@ffmpeg/core-mt` wasm               | 31.2 MiB |  9.8 MiB | 7.0 MiB |

For scale: the entire current initial payload is 329.3 kB raw / 106.6 kB
gzipped. Brotli-compressed, the wasm is about **65× everything the app loads
today**.

It is a complete ffmpeg. The build carries libx264, libx265, libvpx (VP8 and
VP9), Theora, ProRes, GIF, WebP, AAC, libmp3lame, Opus and Vorbis, so the
codec side of "almost any format" is not in question.

**The build cost is negligible.** Put the 41 MB base64 variant through this
project's own Vite 8 as a lazy chunk: **+0.7 s** over a trivial baseline, and
about 300 MB of transient node RSS. Rolldown does not care. I had expected this
to be an argument against embedding and it is not.

### Two things in the build would have to change, and neither is optional

**The service worker would download it for everybody.**
[`vite/plugins/service-worker.ts`](../vite/plugins/service-worker.ts) walks the
whole of `dist` and precaches every file with `cache.addAll`, which is
all-or-nothing by design. A 30 MB asset in `dist` is therefore fetched at
service-worker install by **every first-time visitor**, whether or not they
ever open the video tool — and one flaky byte fails the whole install, so the
app loses offline support entirely rather than losing the video tool. The
precache list needs an exclusion and the payload needs runtime caching instead.

**`bundle:check` cannot see it.**
[`scripts/check-bundle-budget.js`](../scripts/check-bundle-budget.js) measures
two things: what `index.html` loads eagerly, and the worker entry chunk. A
30 MB lazy chunk is invisible to both budgets, which means the largest artefact
in the build would be the one thing with no ceiling on it. That is the same
shape as the regression the worker budget was added for. A third budget — the
largest single lazy chunk, or the total of `dist` — should land in the same
commit as the payload, not after it.

## The CSP, which does not have to change

This was the question I expected to end in a trade-off, and it does not.

Everything below was run against the unmodified production headers, in three
engines, with `crossOriginIsolated === true` confirmed on every page.

| Route                                                                     | Document policy | Result                                                      |
| ------------------------------------------------------------------------- | --------------- | ----------------------------------------------------------- |
| execution worker calls `fetch()` for the `.wasm`                          | unchanged       | **Blocked**, both engines                                   |
| wasm base64'd into a JS module, loaded with `import()`                    | unchanged       | **Loads** (401 ms FF / 296 ms WK to acquire and decode)     |
| worker `fetch()`, with `connect-src 'self'` on the worker script only     | unchanged       | **Loads** (66 ms FF / 88 ms WK)                             |
| page reads the wasm out of Cache Storage, put there by the service worker | unchanged       | **Loads** (30.7 MiB in 11 ms Chromium / 76 ms FF / 4 ms WK) |

Three findings, in order of how much they matter.

**`connect-src 'none'` is real.** The worker's `fetch` of a same-origin
`.wasm` is refused in both engines, with WebKit naming the directive. The
guarantee is not decorative and the naive delivery route does not work.

**Cache Storage is not governed by `connect-src`, and this is the answer.**
`cache.add()` performs a fetch and is refused from the page — measured,
in all three engines. But `caches.match()` is a read from local storage, not a
fetch, and is **allowed**. So the service worker — which already has the one
documented `connect-src 'self'` exception, already written down in
[SECURITY.md](../SECURITY.md#the-one-deliberate-exception) — can put the wasm
in a cache, and the execution worker can read it back with `caches.match()`
while its own policy stays `connect-src 'none'`.

That means the payload can be shipped as a plain 30.7 MiB asset (6.9 MiB
brotli, no base64 inflation, nothing extra through the bundler), with **no new
CSP exception of any kind**. The actor that touches the network is the service
worker, doing exactly what it already does, for exactly the reason it already
has permission to.

The price is a real functional dependency: the tool needs the service worker to
be installed and active. Where service workers are unavailable — private
browsing in several browsers — the tool has no way to get its bytes and has to
say so. That is a constraint worth stating in the tool's own README rather than
discovering.

**The `connect-src 'self'`-on-the-worker route works, and should not be used.**
It is the fastest and simplest of the three, and it is a materially worse
concession than the service worker's. The distinction is what the two workers
touch: `/sw.js` handles cache files and never sees your input, whereas the
execution worker is _the place your pasted data is processed_. Giving that
worker a network destination — even a same-origin one, where the data would
land in the host's access logs — weakens the exact sentence SECURITY.md
currently gets to write: "The document is unaffected. Pages still run under
`connect-src 'none'`." I would not spend that.

**Recommendation: the Cache Storage route, with the base64 module as a
documented fallback** if the service-worker dependency turns out to be
unacceptable. Both keep `connect-src 'none'` intact everywhere.

### What the README would have to say afterwards

For wasm delivery: **nothing changes.** The `connect-src 'none'` row in the
enforcement table, the "zero-network guarantee" section, and SECURITY.md's
"one deliberate exception" all stand as written. That is the headline result
of this investigation.

One sentence in SECURITY.md would be worth extending, because the exception's
_scope_ grows even though its _policy_ does not: the service worker would now
be fetching a 30 MB payload rather than only the app's own small chunks. Same
origin, same permission, more bytes. A clause naming the wasm alongside the
chunks is honest bookkeeping rather than a new concession.

### The one CSP change that a preview would need

A `<video>` element pointed at a `blob:` URL is **refused today**, in Firefox,
WebKit and Chromium alike. There is no `media-src` directive, so it falls
through to `default-src 'self'`, which does not include `blob:`.

Showing the converted video in the app therefore needs:

```
media-src 'self' blob:
```

This is a much smaller thing than it sounds, and it is exactly parallel to the
`img-src 'self' data: blob:` that already ships for image previews: `blob:` is
an in-memory handle to bytes the page already has, and it is not a network
destination. It does not weaken `connect-src` and it does not give anything a
way off the machine.

The README would gain one row in the enforcement table and one line in the
`_headers` comment block, in the same voice as the `img-src` line: _tool output
(previews, generated media) is held in memory as `data:`/`blob:` URLs, never
uploaded._

Whether to spend even that is a product question. The image tool's precedent
says a preview earns its place; the alternative — download only, with the
sniffed facts on screen, which is what `ImageView` already does above its
8 MB preview limit — is a defensible first version that needs no CSP change at
all.

### Cross-origin isolation is currently buying nothing

The COOP/COEP headers were set, per their own comment in `public/_headers`, as
the precondition for multi-threaded ffmpeg. Two measurements say that
investment has not paid off yet:

- **`core-mt` commits a fixed 1 GiB `SharedArrayBuffer` at load.** Its imported
  memory declares `initial == maximum == 1024 MiB`, read straight out of the
  wasm binary and confirmed at runtime: heap after boot, before any work, was
  exactly 1024.0 MiB. It cannot grow, so 1 GiB is also its ceiling — _half_ the
  single-threaded core's 2048 MiB cap.
- **It booted and then hung.** Instantiation took 115 ms, and the first
  `exec` — a job the single-threaded core does in about a second — had not
  returned after 90 seconds, with nothing on the console. That is the shape of
  pthread workers failing to start inside a nested worker, but I did not
  establish the cause and will not claim one.

So the single-threaded core is the choice, and cross-origin isolation is not
what makes this feasible. That is worth correcting explicitly, because the
header comment currently reads as though it were.

## What a conversion costs

Single-threaded core. `x-realtime` is seconds of video produced per second of
wall clock; below 1.0 the conversion is slower than watching the video.

**Firefox and WebKit, `-preset ultrafast -crf 28`:**

| Job         | Firefox |   ×rt | WebKit |   ×rt |
| ----------- | ------: | ----: | -----: | ----: |
| 480p, 10 s  |   1.6 s | 6.27× |  2.3 s | 4.29× |
| 720p, 10 s  |   3.3 s | 3.07× |  4.8 s | 2.10× |
| 720p, 30 s  |   9.4 s | 3.20× | 13.7 s | 2.18× |
| 1080p, 10 s |   6.9 s | 1.45× | 10.1 s | 0.99× |

**WebKit is consistently 1.4–1.5× slower than Firefox.** Since WebKit is the
closest this repo gets to Safari, and Safari is the engine every iPhone runs,
that ratio compounds with everything in the phone section below.

**Chromium, and the preset that changes the answer** (`-crf 23`):

| Job         | `ultrafast` |       |    `medium` |       | peak heap (ultrafast → medium) |
| ----------- | ----------: | ----: | ----------: | ----: | -----------------------------: |
| 720p, 10 s  |       3.2 s | 3.09× |      23.4 s | 0.43× |             38.4 MB → 198.8 MB |
| 1080p, 10 s |       6.8 s | 1.48× |      47.2 s | 0.21× |             66.5 MB → 412.3 MB |
| 1080p, 60 s |      41.1 s | 1.46× | **284.4 s** | 0.21× |             66.5 MB → 412.3 MB |

**The headline number: a 1080p one-minute clip, at ffmpeg's own default
preset, took 4 minutes 44 seconds** on a desktop, and 412 MB of heap.

And the fast path is not free either. That same 1080p 60 s clip at `ultrafast`
finished in 41 s and produced **118.5 MiB of output from a 101.2 MiB input** —
a "conversion" that made the file bigger. At `medium` the output was 44.0 MiB.

This is the finding that most shapes the product. The preset is not a detail
to be defaulted away: it is a choice between _seven times the wait_ and _nearly
three times the file_, and both answers are the right one for somebody. A
converter that picks silently will be wrong for half its users and will look
broken to the other half.

### The operations that are nearly free

Against a 1080p 60 s H.264 MOV of 92.6 MiB:

| Operation                    |         Chromium |          Firefox |   Output |
| ---------------------------- | ---------------: | ---------------: | -------: |
| remux to MP4 (`-c copy`)     | **0.2 s** (321×) | **0.2 s** (271×) | 92.6 MiB |
| extract audio to MP3         | **0.3 s** (239×) | **0.3 s** (188×) |  0.3 MiB |
| scale to 720p, x264 `medium` |  188.3 s (0.32×) |     not measured | 10.4 MiB |

**Remuxing a one-minute 1080p file took two tenths of a second**, and neither
it nor the audio extraction grew the heap beyond what the source encode had
already claimed. That is a different kind of operation from transcoding, and it
is the one most requests for "convert this video" actually are: a container
change for a file some player refuses.

Note also the third row. Downscaling 1080p to 720p is often assumed to be the
cheap way out of a slow encode, and it is not — the decode still happens at
1080p, and the result was still three minutes. The only cheap paths are the
ones that do not re-encode.

A VP9/WebM transcode was attempted in the same pass and exited non-zero on the
arguments given. I did not chase it, so **VP9 output is unestablished** rather
than known broken.

**Time to first conversion**, on the embedded route: acquiring and decoding
the payload plus instantiating the module took **0.50–0.67 s in Firefox** and
**0.36 s in WebKit**, from bytes already on disk. Add the download on a cold
visit: 6.9 MiB brotli, which is 5–10 s on a typical mobile connection and
essentially instant on a warm cache. Via the Cache Storage route the read alone
is 4–76 ms.

That first-run cost is small enough to hide the way worker boot and tool import
are already hidden — pay it when the node is added, not when Run is pressed —
but 6.9 MiB is far too much to prefetch on hover, and the existing "deliberately
NOT called on hover across the palette" reasoning in `engine.ts` applies here
with about a thousand times the force.

## Memory

**Peak wasm heap is a function of resolution and preset, and is flat in
duration.** 66.5 MB for 1080p `ultrafast` whether the clip is 10 seconds or 60;
412.3 MB for 1080p `medium`, likewise. ffmpeg streams; it does not hold the
film.

That is much better than "a large file cannot be held whole in a browser heap"
suggests — for the _codec_. The file is a different matter, and this is where
the accounting gets uncomfortable.

**The heap figure excludes the files.** Emscripten's MEMFS keeps file bytes in
JS `Uint8Array`s outside the wasm heap, so `HEAPU8.byteLength` — which is what
I measured — does not count the input or the output at all. For the 1080p 60 s
`ultrafast` case that is 101.2 MiB in and 118.5 MiB out sitting on the JS heap
on top of the 66.5 MB.

**And this app copies.** Reading the engine, a single run holds the input
bytes:

1. on the main thread, as the chosen `File`'s bytes;
2. in the worker, because inputs are **borrowed** — structured cloned, never
   transferred, deliberately, so that one output can feed several inputs
   ([the fan-out guarantee](architecture.md#the-worker-boundary));
3. again in the worker, because `FS.writeFile` copies into MEMFS.

and the output symmetrically: in MEMFS, in the `readFile` copy, and in the
clone posted back to the page. For the 1080p 60 s `ultrafast` case that is
roughly `3 × 101 + 3 × 118 + 66 ≈ 720 MB` live across the two threads at the
peak.

**That arithmetic is read off the code, not measured.**
`performance.measureUserAgentSpecificMemory()` returned null in the worker, and
I did not find a second engine-independent way to get one total figure. It is
the number I would most want before committing, and it is the largest gap in
this investigation.

Two of those copies are avoidable and one is not. The worker's MEMFS copy can
go if the input is written with `FS.createDataFile` over the received view.
The `readFile` copy can go if the output is transferred rather than cloned —
and the engine already has `ownership: 'transfer'`, currently used by nothing,
with a guard that refuses to replay a transferred request precisely because its
buffers are detached. This tool would be the first caller that can honestly
claim single consumption, which makes that guard a live path rather than the
dead one `architecture.md` currently describes it as.

**The hard ceilings**, read out of the binaries: the single-threaded core's
memory section declares initial 32 MiB, **maximum 2048 MiB**. So 2 GiB is the
absolute cap on the codec's working set on any device. Extrapolating the
measured 412 MB for 1080p `medium` by pixel count, **4K at the default preset
would want roughly 1.6 GB and would sit right against that wall.** 4K at
default settings should be refused by the tool rather than discovered by the
user.

## What has to change in the engine

This is the expensive part, and the three changes are entangled.

**1. The deadline.** The longest timeout in the manifest today is 60 s
(`image-convert`); the measured job above needs 285 s and a 4K job would need
far more. The engine's guarantee is _at most `timeoutMs` waiting, then
`timeoutMs` running_ — so a 600 s tool implies a worst case of 20 minutes
before anything gives up, and the deadline is the **only** thing in the system
that ever destroys a wedged worker. Simply raising the number converts the
existing "a runaway tool is stopped" property into "a runaway tool is stopped
eventually, possibly after lunch".

This is where the question "does it generalise, or does it need a second mode"
gets answered: **it needs a second mode.** A deadline is the right instrument
for a wedged regex, where no progress is possible and elapsed time is the only
available signal. It is the wrong instrument for a legitimate long encode,
where progress _is_ observable — the core emitted 474 progress events over the
284 s run, and 83 over the 41 s one. The generalisable form is a **liveness
deadline rather than a total one**: a tool that declares progress is killed for
going quiet, not for taking a long time. That is one new field on
`ExecutionMeta`, it keeps the existing guarantee unchanged for every tool that
does not declare progress, and it does not require anyone to guess a number
that depends on the user's file and the user's laptop.

**2. Progress has to be wired through the pipeline first.** `runPipeline`
passes no `onProgress`, and `registry.test.ts` currently _fails the build_ if
any tool declares `reportsProgress: true` — a deliberate tripwire saying this
wiring is missing. That test is the honest gate on change (1), and it should be
satisfied before anything else here starts, not alongside it.

**3. Any edit throws the encode away.** `pipelineStore.run()` opens with
`controller?.abort()`, so an edit anywhere on the canvas, 500 ms after the last
keystroke, cancels the run in flight. For millisecond tools that is exactly
right. For a five-minute encode the consequence is a chain of behaviours that
are each individually correct:

- the result is discarded, and a cancelled node writes **nothing to the cache**,
  so the work is not merely interrupted but has to be redone from zero;
- cancelling does not stop the tool — [it cannot](architecture.md#cancelling-tells-the-worker-to-stop-it-does-not-make-it-stop)
  — so the worker stays busy for the remaining minutes;
- the replacement run is posted to that busy worker and queues behind it;
- and the canvas shows `Running` throughout, with nothing to explain the wait.

This is the same failure the repo already measured at 10.8 s in WebKit and
called "not a slow tool — a broken app", scaled by two orders of magnitude.
Widening the debounce does not fix it; only _not superseding a long-running
node whose inputs did not change_ does, which is a real change to the
supersession rule.

**4. One worker, one thread.** Four concurrent nodes are four messages in one
queue, [as `architecture.md` is careful to say](architecture.md#what-the-concurrency-bound-is-actually-for).
A five-minute encode therefore blocks every other tool on the canvas for five
minutes, including the millisecond ones. A second worker dedicated to long
tools is the obvious answer and it is not free: it doubles the wasm instances
in the worst case, and the existing timeout machinery — destroy the worker,
replay the bystanders — assumes there is one worker to destroy.

**5. `maxInputBytes`.** The largest today is 64 MB. The measured 1080p 60 s
source was 101 MiB, and it was 60 seconds. Whatever number is chosen, note that
`measureInputs` is checked before the tool module loads, which is the right
place, and that a video limit an order of magnitude above every other tool's is
a decision worth writing down rather than a constant worth bumping.

**And two dead fields that would come alive.** `requiresWasm` and `wasmModules`
are declared on `ExecutionMeta` and set on all nine tools, and **nothing in the
codebase reads either of them** — no consumer in `src/`, `scripts/` or `vite/`.
They are today exactly what `image` and `datetime` were before the port audit
removed them: a distinction the type system carries and nothing acts on. This
feature is the first thing that would give them a job. If it does not go ahead,
they should be deleted on the same reasoning the audit used.

## The output, and whether it belongs on a wire

The suspicion that a very large result may not belong on a port turns out to be
half right, and the half that is wrong is the half I expected to be the
problem.

**Moving the bytes is cheap.** Worker to page, structured cloned: 1.16 MiB in
0.9 ms in Firefox, 1.4 ms in Chromium, 4.7 ms in WebKit — roughly 1–4 ms per
MiB. A 44 MiB output is tens of milliseconds. The wire is not the issue, and
transferring instead of cloning would make it free.

**Holding them is not cheap.** The result cache holds **whole outputs** for the
life of the tab, pruned only when a node is deleted. A three-node chain that
passes video through would retain three full copies of intermediate video
indefinitely, in a cache whose whole design rationale is that it never has to
look at a value. Nothing about that is wrong for the tools that exist; it is
simply a policy written when the largest plausible output was a decoded
document.

The honest answer is that a first version should **not** put video on a wire at
all. `image-convert` is the precedent worth following in the other direction:
its output is `bytes`, wired freely to Hash and Base64, and that works because
the values are megabytes. For video the useful downstream operations are almost
nonexistent — hashing a 44 MiB MP4 is not a pipeline anybody wanted — and the
cost is a cache policy change plus three copies of a film.

So: **an output port that produces bytes, and a Download button, and no
expectation that anyone wires it onward.** If the port exists it will be wired,
so the more defensible first version declares the output and accepts the cost,
or declares it and adds a cache eviction rule for outputs above some size. That
second option is a change to the caching contract and should be a separate
decision.

## What breaks on a phone

**Measured, and device-independent:**

- 412 MB of wasm heap for 1080p at the default preset, plus input and output on
  the JS heap, plus the copy chain — a live footprint I estimate at ~720 MB for
  a one-minute 1080p clip.
- `core-mt` commits 1 GiB up front. If multi-threading is ever revisited, that
  alone rules it out for mobile.
- WebKit is 1.4–1.5× slower than Firefox on identical work, on a desktop.

**Extrapolated, and clearly labelled as such:** a phone core sustains roughly a
third to a fifth of a desktop core on this kind of work, and throttles
thermally within a minute or two of sustained load. Applying that to the
measured 0.21× realtime for 1080p `medium` puts a one-minute clip somewhere
between **15 and 25 minutes** on a phone. I have not measured this. I have no
phone.

**Structural, and worse than the arithmetic:**

- **iOS suspends backgrounded tabs.** A conversion measured in minutes cannot
  survive the user switching apps to do something else while they wait — which
  is precisely what a person does when told to wait fifteen minutes. This is
  already the repo's known blind spot: `check:browsers` cannot produce a hidden
  tab, and [manual-checks.md](manual-checks.md#3-a-backgrounded-tab) exists
  because of it. The difference is that today a backgrounded tab costs nothing
  but late timers; here it would cost the whole job.
- **Memory pressure kills the tab, it does not throw.** A failed allocation in
  the wasm heap is something the tool can report. A mobile browser reclaiming a
  tab is not — the page is simply gone, and on reload the canvas comes back
  with `"holiday.mov" needs choosing again`, which is a correct message about
  the wrong event.
- **The inspector is a bottom sheet over 60% of the canvas**, and it is where
  progress and cancel would have to live for the whole of a long run.

My reading is that **a first version should refuse to start a large conversion
on a phone rather than start one it cannot finish**, and say why. That is a
worse product than pretending, for about a minute, and a much better one after
that. It is also the same judgement the image tool already makes with its 8 MB
preview limit.

## A realistic first version

**What it does:**

- **Remux by default** — change the container without touching the pixels
  (`-c copy`). This is the operation most people actually want when they say a
  video "won't play": a `.mkv` or a `.mov` that needs to be a `.mp4`. Measured
  at **0.2 s for a 92.6 MiB 1080p one-minute clip** — 321× realtime, with no
  heap growth. It is lossless, it needs none of the engine changes above, and
  it fits the existing execution model exactly as it stands.
- **Transcode when the codecs genuinely do not fit**, with the speed/size
  trade-off **presented as a choice**, not defaulted. Two or three named
  presets with their measured consequences on the label — the repo already
  writes notes onto results for exactly this kind of thing, and "this will take
  about four minutes" is the same class of statement as "GPS location was
  removed".
- **Extract audio** — 0.3 s for the same clip, 239× realtime.
- **Report progress**, which the core supports and the pipeline does not yet
  carry.
- **State its refusals at the moment the file is chosen**, the way the file
  input already does — too large, too high a resolution for the chosen preset,
  a phone.

**What it explicitly does not do:**

- 4K at anything but the fastest preset. Measured heap says it sits against the
  2 GiB wall.
- Anything on a phone beyond remuxing and audio extraction.
- Live in a pipeline. One node, one file, one result, one download.
- Preview the result, unless `media-src 'self' blob:` is judged worth adding —
  and the first version is better without it, following `ImageView`'s
  above-the-limit behaviour: the sniffed facts and a Download button, always on
  screen.
- Multi-threading.

**Sequenced**, because the order is not arbitrary:

1. Wire `onProgress` through `runPipeline` and retire the `registry.test.ts`
   tripwire. Nothing else can start honestly before this.
2. The liveness deadline on `ExecutionMeta`, and the supersession rule for a
   long-running node whose inputs did not change.
3. The bundle budget for the largest lazy chunk, and the service-worker
   precache exclusion. Both before any large asset lands, so the first commit
   that adds one is measured by a gate that exists.
4. Payload delivery via Cache Storage, with a check in `check:browsers`
   asserting the document's `connect-src` is untouched and that no request
   leaves the origin — which the harness already asserts and would now be
   asserting about something that matters.
5. The tool: remux and audio first, transcode second.

## How it would be tested

The harness cannot say a video looks right, and cannot afford a run measured in
minutes. Both are true and neither is the obstacle it appears to be, because
the repo's own history says what to do instead: **name the mechanism, and ask
whether the mechanism can be produced separately from the thing that usually
causes it.**

**A conversion's correctness does not need a long conversion.** A 32×32,
two-frame clip exercises every seam in this feature — the payload load, the
worker protocol, MEMFS in and out, the port, the cache, the download — and runs
in milliseconds. Every seam bug found in this repo has been in the plumbing,
not in the library. `check:browsers` should convert something tiny, in both
engines, on every run.

**Output correctness is a container question, answered by reading bytes.**
The image tool's own history is the precedent: its decompression-bomb guard was
fixed by reading about forty bytes of container header rather than trusting a
decoder. The same applies here — assert the `ftyp` brand, the `moov` presence,
the codec fourcc, the declared dimensions and duration. That is a real
assertion about a real answer and it does not require looking at a picture.

**Whether it looks right is answerable, once, on decoded pixels.** The image
suite already compares decoded pixels for orientation and downscaling.
A converted clip can be drawn to a canvas from a `<video>` element and compared
against a known source frame — which needs `media-src 'self' blob:` in the
harness even if the app never ships a preview. One such check, over a
synthesised clip of flat colour blocks, would catch a conversion that produced
green mush.

**The engine changes must be tested without ffmpeg.** The liveness deadline,
the supersession rule and the second worker are properties of the engine, and
the existing suite already drives them with stand-ins — a fake worker in unit
tests, a catastrophically backtracking regex in `check:browsers`. A stub tool
that emits progress and then goes quiet produces the liveness condition exactly,
in milliseconds, and is a far better test than a real encode: it can be made to
go quiet _on purpose_, which a real encode cannot.

**And a count, not an assertion about an answer.** The Safari double-execution
bug was invisible to every test that looked at results and was caught by
counting `started` messages. A wasm module instantiated twice, or a payload
fetched twice, is the same shape of bug and needs the same shape of check.

**What genuinely cannot be tested here**, and belongs in
[manual-checks.md](manual-checks.md) with a pass and a fail per step rather
than a suggestion to try it:

- A real phone: one conversion, timed, with the tab backgrounded halfway.
- Safari itself, which the repo already says has never been tested.
- A conversion long enough to be interrupted by a real user doing real things.

The rule from CONTRIBUTING applies before any of those are written down: try
harder first. Two of the three above may have a producible mechanism I have not
found.

## What I am least confident about

In order.

**No phone measurement exists.** Every mobile figure in this document is an
extrapolation from desktop numbers by a factor I asserted. The phone section is
the least trustworthy part of this investigation and it is also the part most
likely to decide whether the feature is worth building.

**No single total-memory figure.** The ~720 MB is arithmetic over a copy chain
read out of the source, not a measurement.
`performance.measureUserAgentSpecificMemory()` returned null in the worker and I
did not find an engine-independent substitute. The per-component numbers are
solid; the sum is not.

**Adversarial input was never tested.** Every file ffmpeg saw in this spike was
one ffmpeg had just written. This repo's own history is emphatic about what
that misses — the image tool's bomb guard _read as safe_ and was measured
committing 1.6 GB before it ran. A container header declaring absurd dimensions,
a truncated stream, a file whose extension lies: none of it was tried, and the
image tool's experience says that is exactly where the first real bug will be.
Any go-ahead should treat a malformed-input pass as part of the first version
rather than a follow-up.

**The multi-threaded core hung and I do not know why.** I established that it
commits 1 GiB and that its first `exec` had not returned after 90 seconds. I did
not establish the cause, so "MT is unusable here" is not proven — only that it
did not work in a bounded attempt. If someone wants multi-threading, that is an
open question, not a closed one.

**The Cache Storage route is verified in the browser and not in the deploy.**
The three-engine result is solid and the mechanism is clear. What I could not
check is Netlify's behaviour serving a 30 MB asset, its edge caching of one, and
whether Cache Storage quota is comfortable at that size on a phone. The
`netlify dev` verification that `_headers` got — and which this repo rightly
insisted on for `/sw.js` — has not been done for any of this.

**Synthetic sources flatter the numbers.** `testsrc2` is cheaper to encode than
camera footage. The timings are optimistic by an amount I have not quantified.

**One machine, one run each.** No repetitions, no variance, and two of the
benchmarks overlapped in wall-clock time with another CPU-heavy run. The 1080p
60 s `medium` figure of 284.4 s reproduces the 0.21× realtime measured
independently at 10 s, which is reassuring, but nothing here is a benchmark.

---

## Appendix: the spike

Deleted, as agreed. It consisted of a static server wrapping
`scripts/serve-dist.mjs`'s own `readHeaders`/`headersFor` so the production
policy applied verbatim; a page and an ES-module worker mirroring this app's
`{ type: 'module' }` same-origin worker; the `@ffmpeg/core` 0.12.10 esm build
loaded through its emscripten factory with `wasmBinary` supplied directly; and
Playwright drivers for the CSP matrix, the Cache Storage probe, the media-src
probe, the conversion benchmarks, the multi-threaded probe and the Vite build
cost.

Nothing from it was committed and no project file was modified to run it. The
packages it installed (`@ffmpeg/core`, `@ffmpeg/core-mt`, `@ffmpeg/ffmpeg`,
`@ffmpeg/util`) were installed into a scratch directory outside the repository
and are not in this project's lockfile.
