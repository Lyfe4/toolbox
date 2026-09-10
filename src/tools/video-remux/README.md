# Video

Change a video's container without re-encoding it, or lift its audio track out.
Both operations copy the compressed frames across byte for byte: nothing here
decodes a pixel, and nothing here can be lossy.

- [What it is for](#what-it-is-for)
- [Why there is no ffmpeg in it](#why-there-is-no-ffmpeg-in-it)
- [What travels, and what does not](#what-travels-and-what-does-not)
- [What it says it dropped](#what-it-says-it-dropped)
- [Malformed input](#malformed-input)
- [The size limit, and the files it rules out](#the-size-limit-and-the-files-it-rules-out)
- [What has not been tested](#what-has-not-been-tested)

## What it is for

The sentence this exists for is **"this video won't play"**, and the usual
reason is the container rather than the codec: a `.mkv` from somewhere, or a
`.mov` off a phone, holding perfectly ordinary H.264 that every device in the
house can decode, in a wrapper the thing you want to play it on refuses to
open. Repackaging fixes exactly that, and it is nearly free — the frames are
already in the form an MP4 wants, so the work is rebuilding the index around
them.

Two operations:

| Operation                   | Produces                                            |
| --------------------------- | --------------------------------------------------- |
| **Repackage as MP4**        | `.mp4`, with the index at the front for fast start. |
| **Extract the audio track** | `.m4a` for AAC, `.mp3` for MP3.                     |

There is no quality setting, and that absence is the point. Every other
converter in this app re-encodes and therefore has a trade to offer; this one
copies, so there is nothing to trade and no setting that could make the result
better or worse.

## Why there is no ffmpeg in it

[The feasibility investigation](../../../docs/video-convert-feasibility.md) that
led to this tool recommended building **"a remuxer that can also transcode"** on
`@ffmpeg/core`, and measured everything needed to do it: the payload is 6.9 MiB
brotli, the CSP does not have to change because a service worker can put the
wasm in Cache Storage and the page can read it back with `caches.match()`, and
remuxing a 92.6 MiB clip took 0.2 seconds.

This version is the first half of that recommendation and **not** the delivery
mechanism, and the reason is that removing transcoding removes the entire
argument for the payload:

- ffmpeg's 30.7 MiB is libx264, libx265, libvpx, Theora, ProRes, AAC, LAME,
  Opus and Vorbis — **encoders**, all of them, and a remuxer runs none. Shipping
  them to copy bytes from one box to another is 6.9 MiB of download for work
  that is `Uint8Array.prototype.set`.
- The Cache Storage route is elegant and it costs a **functional dependency on
  the service worker**, which is unavailable in private browsing in several
  browsers. That is a real price, and it buys nothing a tool this size needs.
- The investigation's own least-confident list names **adversarial input** as
  the gap where the first real bug will be. With ffmpeg, the answer to that is
  "we guard at the boundary and trust thirty megabytes of someone else's C".
  Here every byte of every container is parsed by code in this directory, so
  the guards are ours to write and ours to test — which is what
  [`malformed.test.ts`](malformed.test.ts) does.

The result is **35.6 kB raw, 12.8 kB gzipped**, in a lazy chunk. That is about
one five-hundredth of the compressed payload, it needs no CSP exception of any
kind, no service worker, and no `wasm-unsafe-eval` — which has been removed
from the policy along with it.

The cost is coverage, stated plainly below. ffmpeg reads every container ever
written; this reads two families.

## What travels, and what does not

**Containers read**, from the bytes and never from the file name:

| In                      | Notes                                                                  |
| ----------------------- | ---------------------------------------------------------------------- |
| MP4, MOV, M4V, M4A, 3GP | The ISO base media family. Also QuickTime files with no `ftyp` at all. |
| Matroska (MKV) and WebM | Both DocTypes.                                                         |

**Codecs carried**, which is a decision about what an MP4 is worth putting
things in rather than a limitation of the writer:

| Codec              | Carried | Why                                                                                                                                                |
| ------------------ | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| H.264, H.265       | Yes     | Matroska stores both in exactly the form an MP4 does, so there is no bitstream conversion in either direction.                                     |
| AAC, MP3           | Yes     | Both have a settled MP4 sample entry, and MP3 frames need no container at all.                                                                     |
| VP8, VP9, AV1      | No      | WebM's own codecs. In an MP4 they are refused by Safari, so the "conversion" would produce a **less** playable file than the one you started with. |
| Opus, Vorbis, FLAC | No      | The same argument, for sound.                                                                                                                      |
| AC-3, subtitles    | No      | Dropped, and named on the result.                                                                                                                  |

So **a WebM cannot become an MP4 here**, and the refusal says so in terms of
what the file actually holds — a container change cannot convert a codec, and a
WebM already plays in Chrome, Firefox and Edge.

**One stream of each kind travels.** A film ripped to Matroska routinely carries
five audio dubs; an MP4 can hold them, but almost no player offers a track menu
for one, so carrying them all would multiply the size of the file with nothing
able to reach the extras. The first video track and the first audio track go,
and every track left behind is named on the result with its language.

**A stream that never says how to decode it is dropped, not written.** H.264
and H.265 need their configuration record and AAC needs its
AudioSpecificConfig; a Matroska file that omits one expects a player to infer
it, which is exact for plain AAC-LC and wrong for the SBR variants — audio at
half pitch and twice the length, which plays, and is the kind of wrong answer
nobody reports. MP3 is the exception and not an inconsistency: an MP3 frame
header states its own sample rate, layer and channel mode, so the stream
describes itself.

**Two things are deliberately not read.** A **fragmented** MP4 keeps its index
in movie fragments spread through the file rather than in one table at the
front; it is refused by name, because "no `moov`" would be a true message about
the wrong thing. And a Matroska file whose elements do not say how long they are
— a live capture — is refused rather than half-read, since finding where such an
element ends means scanning compressed frame data for something that looks like
the next element id.

## What it says it dropped

This is the half of the tool that is not about containers, and it is the lesson
[the image tool](../image-convert/README.md) learned the expensive way: a
converter that hands back a plausible file is believed, so every silent change
it made is a change nobody finds out about.

A repackage rebuilds the index and carries the streams. **Everything else in
the file is left behind**, and the result says which:

- **GPS location.** A phone writes the coordinates it recorded at into a `©xyz`
  atom, and a repackage does not carry it. In an application whose whole pitch
  is that your data does not move, that is close to the most important sentence
  it can print — and it is asserted on the output bytes rather than promised in
  this paragraph.
- **The recording date**, which is a real timestamp of when the camera was
  running. The writer emits zero.
- **Titles, tags, chapters and attachments** from a Matroska file.
- **Every track that did not travel**, named with its codec and its language.

Two things that could have been dropped silently and are carried instead:

- **The display matrix.** A phone held upright records landscape pixels and
  writes a 90-degree rotation into the track header. Everything else about the
  file describes a landscape video; the matrix is the entire reason a player
  turns it up the right way. Rebuilding the header without it produces a
  repackage that is correct in every measurable respect and plays on its side.
- **The edit list**, which is how a track says it starts late or is trimmed.

And one thing that is reconstructed rather than carried, because Matroska does
not have it: **decode times**. A Matroska block carries one timestamp and it is
the _presentation_ time; MP4 wants both, separately. For a stream with B-frames
the decode order and the display order differ, so the decode times are derived —
the i-th frame decoded cannot be shown before the i-th earliest presentation
time in the stream, which makes the sorted times a valid decode order. The whole
file is then shifted later by the worst overshoot so that no composition offset
comes out negative, **by the same amount on every track**, which is what stops
the derivation moving sound relative to picture.

## Malformed input

Every file this tool sees is parsed here, and nothing is decoded. That is the
opposite of the usual arrangement, where a library absorbs a hostile file on
your behalf — and it means the whole attack surface is in this directory.

Three properties hold whatever a file says, and
[`malformed.test.ts`](malformed.test.ts) is organised around them:

**It returns.** Every walk advances by at least one byte or stops; a box whose
declared size does not move the cursor ends the walk rather than repeating it.
Nesting is capped, the total number of nodes is capped, and the chunk planner
advances to the next real sample rather than stepping a fixed second at a time —
a hostile file's timestamps run to four billion ticks, and a stepped loop over
that is a denial of service written as arithmetic.

**It does not allocate on trust.** Every table in `stbl` and every EBML element
begins with a length the file wrote. `entriesThatFit` is the one function that
turns a declared count into a real one, by measuring the box that declared it;
an `stsz` claiming four billion samples out of twelve bytes yields zero. The one
table with no per-entry bound — a uniform sample size — is bounded by the length
of the file instead, since a one-byte sample cannot appear more times than there
are bytes.

**It never throws.** A tool that throws takes the worker down and every
unrelated request in flight with it. Asserted over arbitrary bytes, over real
headers followed by noise, and — the one that reaches the interesting code —
over a valid file with one byte changed, four hundred times, in bounded time.

And one property that is about honesty rather than safety: **a damaged file is
refused or reported, never quietly half-converted.** Reading past the end of a
`Uint8Array` in JavaScript is not a crash, it is a zero — so a truncated
download whose index survived would otherwise produce a perfectly well-formed
MP4 full of silence and black. Every sample's byte range is checked against the
length of the file, once, before anything is allocated. Where a file is damaged
part of the way through and the rest is readable, what could be read is
repackaged **and the result says so**.

One guard is worth naming on its own. Nothing in either container forbids two
samples from pointing at the same bytes, so a small file can describe an
enormous one: a twenty-five kilobyte file declaring two thousand samples of four
kilobytes each asks for eight megabytes, and every individual range in it is
inside the file and passes every other check. The bound is the input's own size,
because a repackage **copies** — it cannot honestly produce meaningfully more
media than it was given.

## The size limit, and the files it rules out

`maxInputBytes` is **256 MB**, four times the largest limit in the rest of the
set, and it is a memory decision rather than a video one. A run holds the input
about three times over: the page keeps the chosen file's bytes for the session,
the worker gets a structured clone of them because
[inputs are borrowed rather than transferred](../../../docs/architecture.md#the-worker-boundary),
and the output is built beside that clone.

**So this will not repackage a film, and that is worth stating rather than
discovering.** About four minutes of 1080p phone video fits. A two-gigabyte MKV
of a feature — which is exactly the file people most often want to remux — does
not, and no browser tool can hold one: not this one, and not a WASM ffmpeg
either, whose own heap ceiling is 2 GiB before the file itself is counted.

The fix is not a bigger number. It is reading the input from disk in pieces and
writing the output in pieces, which is a change to the execution engine's value
model — `ToolValue` carries a whole `Uint8Array` — rather than to this tool.
The investigation did not find this, because it measured a one-minute clip and
generalised.

## What has not been tested

Named here rather than left to be assumed, in the same spirit as the rest of
this repository:

- **No file produced by this tool has been played by a real player.** The
  harness asserts that the frames come out byte for byte and that the index
  round-trips through this tool's own reader, which is a real assertion about a
  real answer — but "it plays in QuickTime, in VLC and in Safari" is a person
  with a Mac, and it is in [manual-checks.md](../../../docs/manual-checks.md).
- **No file written by a real encoder has been read by it.** Every fixture here
  is hand-built. The MP4 builder deliberately does what the writer does not —
  `mdat` first, 32-bit `stco`, several samples per chunk, a QuickTime version-1
  audio entry — precisely because a fixture produced by our own writer proves
  the two agree and nothing more. It is still not a camera.
- **HEVC has been exercised only through the code path, not through a file.**
  It shares every line with H.264 except two four-character codes.
- **Nothing has run on a phone.** The memory arithmetic above is read off the
  engine rather than measured, which is the same gap the investigation named as
  its second-least-confident finding.
