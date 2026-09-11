# Video

Change a video's container without re-encoding it, or lift its audio track out.
Both operations copy the compressed pictures across: nothing here decodes a
pixel, and nothing here can be lossy.

- [What it is for](#what-it-is-for)
- [Why there is no ffmpeg in it](#why-there-is-no-ffmpeg-in-it)
- [What travels, and what does not](#what-travels-and-what-does-not)
- [Where "byte for byte" stops being true](#where-byte-for-byte-stops-being-true)
- [Why AVI is mostly a refusal](#why-avi-is-mostly-a-refusal)
- [What it says it dropped](#what-it-says-it-dropped)
- [Malformed input](#malformed-input)
- [What it reads, and what it can hand back](#what-it-reads-and-what-it-can-hand-back)
- [What has not been tested](#what-has-not-been-tested)

## What it is for

The sentence this exists for is **"this video won't play"**, and the usual
reason is the container rather than the codec: a `.mkv` from somewhere, a
`.mov` off a phone, a `.ts` out of a screen recorder or a camcorder, holding
perfectly ordinary H.264 that every device in the house can decode, in a
wrapper the thing you want to play it on refuses to open. Repackaging fixes
exactly that, and it is nearly free — the pictures are already in the form an
MP4 wants, so the work is rebuilding the index around them.

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

The result is **68.2 kB raw, 23.6 kB gzipped**, in a lazy chunk. That is about
one three-hundredth of the compressed payload, it needs no CSP exception of any
kind, no service worker, and no `wasm-unsafe-eval` — which has been removed
from the policy along with it.

The cost is coverage, stated plainly below. ffmpeg reads every container ever
written; this reads four.

## What travels, and what does not

**Containers read**, from the bytes and never from the file name:

| In                      | Notes                                                                                                                         |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| MP4, MOV, M4V, M4A, 3GP | The ISO base media family. Also QuickTime files with no `ftyp` at all.                                                        |
| Matroska (MKV) and WebM | Both DocTypes.                                                                                                                |
| MPEG-TS (TS, M2TS, MTS) | Screen recorders, AVCHD camcorders, tuners, HLS segments. 188-, 192- and 204-byte packets; a file may begin mid-packet.       |
| AVI                     | Read in full and **mostly refused** — see [below](#why-avi-is-mostly-a-refusal), because that is a decision and not a defect. |

**Codecs carried**, which is a decision about what an MP4 is worth putting
things in rather than a limitation of the writer:

| Codec                             | Carried | Why                                                                                                                                                       |
| --------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| H.264, H.265                      | Yes     | Every container here stores them in a form an MP4 can hold. Matroska needs no change at all; TS and AVI need re-framing, which is the section below.      |
| AAC, MP3                          | Yes     | Both have a settled MP4 sample entry, and MP3 frames need no container at all.                                                                            |
| VP8, VP9, AV1                     | No      | WebM's own codecs. In an MP4 they are refused by Safari, so the "conversion" would produce a **less** playable file than the one you started with.        |
| Opus, Vorbis, FLAC                | No      | The same argument, for sound.                                                                                                                             |
| MPEG-4 Part 2 (DivX, Xvid)        | No      | Legal in an MP4 as `mp4v`, and decoded by no browser and no Apple device. This is the codec in most AVI films and is the reason most of them are refused. |
| MPEG-2 video, Motion JPEG         | No      | The same argument, for older files: an MP4 can hold them and nothing modern will play them.                                                               |
| MPEG audio Layer II               | No      | What European broadcast uses. An MP4 can hold it and almost nothing outside VLC decodes it from there.                                                    |
| AC-3, uncompressed PCM, subtitles | No      | Dropped, and named on the result.                                                                                                                         |

So **a WebM cannot become an MP4 here**, and neither can a DivX film, and the
refusal says so in terms of what the file actually holds — a container change
cannot convert a codec.

**Layer II and Layer III are told apart from the frame header, not from the
container.** A transport stream announces both as the same stream type and an
AVI can tag Layer II data as MP3; the layer is stated in each frame, so that is
where it is read. Only Layer III travels.

**One stream of each kind travels.** A film ripped to Matroska routinely carries
five audio dubs; an MP4 can hold them, but almost no player offers a track menu
for one, so carrying them all would multiply the size of the file with nothing
able to reach the extras. The first video track and the first audio track go,
and every track left behind is named on the result with its language. A
transport stream recorded off a whole multiplex gets the same treatment one
level up: **the first programme travels**, and the count of the others is named.

**A stream that never says how to decode it is dropped, not written.** H.264
and H.265 need their configuration record and AAC needs its
AudioSpecificConfig; a Matroska file that omits one expects a player to infer
it, which is exact for plain AAC-LC and wrong for the SBR variants — audio at
half pitch and twice the length, which plays, and is the kind of wrong answer
nobody reports. MP3 is the exception and not an inconsistency: an MP3 frame
header states its own sample rate, layer and channel mode, so the stream
describes itself.

For a transport stream that last rule has a second, friendlier form.
A broadcast repeats its parameter sets every second or so, so a clip cut out of
the middle of one can genuinely have none — and the refusal says exactly that,
because **a longer piece of the same recording will have them**.

**Three things are deliberately not read.** A **fragmented** MP4 keeps its index
in movie fragments spread through the file rather than in one table at the
front; it is refused by name, because "no `moov`" would be a true message about
the wrong thing. A Matroska file whose elements do not say how long they are
— a live capture — is refused rather than half-read, since finding where such an
element ends means scanning compressed frame data for something that looks like
the next element id. And a **scrambled** transport stream — a recording off a
pay-television tuner — is refused by name: its structure parses perfectly and
every frame in it is noise, so repackaging would hand back a file that looks
completely normal and plays static.

## Where "byte for byte" stops being true

This is the one claim in the sentence at the top of this file that two of the
four containers made untrue, and narrowing it is better than stretching it.

H.264 and H.265 in a transport stream, and in most AVI files that carry them,
are stored as **Annex B**: each NAL unit introduced by a `00 00 01` start code,
with the sequence and picture parameter sets repeated inside the stream so a
receiver that tuned in late can start decoding. An MP4 has an index and needs
neither: each NAL unit is preceded by its own length, and the parameter sets are
hoisted out into one `avcC` or `hvcC` record in the sample entry.

So for those two containers:

- **Every coded picture is the encoder's own, byte for byte.** Each NAL unit's
  payload is copied verbatim — every coefficient, every macroblock, every slice
  header. Nothing is decoded and nothing can be lossy.
- **The framing around them is rewritten.** Four bytes of length replace the
  start code, and the parameter sets, access-unit delimiters, filler and
  end-of-stream markers are dropped because the container now states or
  replaces all four.

A repackage of a `.ts` says so on the result, in those terms. The unit tests
assert the narrow claim rather than the broad one: they pull the NAL units back
out of the finished MP4 through their length prefixes and compare each payload
to the one that went in, which is a stronger assertion than comparing whole
samples would be, because it also proves the lengths are right.

Two things had to be **parsed** rather than copied to make that work, and both
are load-bearing in a way worth knowing about:

- **The configuration record.** There is no other copy of it in a transport
  stream. The H.264 profile and level bytes are lifted from fixed positions in
  the parameter set rather than derived; H.265's twelve bytes of
  profile-tier-level cannot be reached that way and are read with a proper bit
  reader. A wrong record produces a file **VLC plays and Safari shows as a
  black frame**, which presents as a Safari bug rather than as a bad
  conversion.
- **The picture size.** A transport stream never states it anywhere. An MP4
  with a `tkhd` of 0×0 plays perfectly in QuickTime, which reads the size out
  of the stream, and lays out at zero pixels in a browser, which does not — no
  error, no black frame, nothing at all. So the size is parsed out of the
  parameter set, cropping included: 1080p is coded 1088 lines tall with the
  bottom eight cropped, and the number in the parameter set is **4**, because
  the crop is counted in chroma samples.

## Why AVI is mostly a refusal

Stated here rather than discovered at the bottom of an error message, because
it is the honest shape of the feature.

**Most real AVI files will be read by this code and then refused for
repackaging.** The video in an old AVI is MPEG-4 Part 2, or Motion JPEG, or
MPEG-2, and all three have a legal home in an MP4 that no browser and no Apple
device will decode. Carrying them would produce a file that plays in VLC, which
already played the AVI, and nowhere else — which is the tool's own doctrine,
written down for VP9 and AV1 long before this reader existed.

What the reader is still worth is two things:

- **The refusal is the answer.** "That does not look like a video file" is the
  wrong response to an AVI and is what this tool said before. "Your video is
  Xvid, which is why nothing plays it, and a container change cannot convert a
  codec" is the thing the person holding the file wanted to know.
- **The sound comes out.** The audio in those films is MP3 in the large
  majority, and extracting it is exact — so **Extract the audio track** is a
  working feature on the format rather than a second refusal. The refusal for
  the repackage says so, by name, rather than leaving it to be found.

And an AVI that carries H.264 — which some capture hardware writes — repackages
properly, because the re-framing built for transport streams covers it.

One consequence worth naming, because it changed an earlier decision. A film
whose video cannot travel and whose audio can used to come back as an `.m4a`
labelled **Repackaged**: a feature going in and a soundtrack coming out, with a
warning above it. That is now refused, and the refusal names the video codec
and points at the audio operation. The salvage still happens where the video
was dropped because **the file** is broken rather than because of its codec —
a track whose configuration record an encoder never finished writing is one no
container can play, and rescuing the sound is better than refusing the lot.

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
- **Titles, tags, chapters and attachments** from a Matroska file, and the
  `INFO` chunks an AVI writer puts a title and a date in.
- **Every track that did not travel**, named with its codec and its language,
  and for a transport stream **every other programme in the multiplex**.

Three things that could have been dropped silently and are carried instead:

- **The display matrix.** A phone held upright records landscape pixels and
  writes a 90-degree rotation into the track header. Everything else about the
  file describes a landscape video; the matrix is the entire reason a player
  turns it up the right way. Rebuilding the header without it produces a
  repackage that is correct in every measurable respect and plays on its side.
- **The edit list**, which is how a track says it starts late or is trimmed.
- **The offset between two streams that do not start together.** New with
  transport streams, and the same shape of failure as the rotation. An MP4's
  `stts` holds the gap between one sample and the next, so a track's first
  sample is at media time zero by construction and there is no field for "this
  one starts a tenth of a second late". MP4 and Matroska never need one. A
  transport stream's timestamps start wherever the transmitter's clock was and
  its streams do not start together — audio commonly leads video, and a tuner
  recording can have half a second between them. Dropping the difference gives
  a file that plays, is the right length, and has **the sound out of step with
  the picture for its entire duration**, which looks like a bad encode. It is
  written as an edit list instead: an empty edit of that length, then the
  media.

And two things reconstructed rather than carried:

- **Decode times, for Matroska**, which does not have them. A Matroska block
  carries one timestamp and it is the _presentation_ time; MP4 wants both,
  separately. For a stream with B-frames the decode order and the display order
  differ, so the decode times are derived — the i-th frame decoded cannot be
  shown before the i-th earliest presentation time in the stream, which makes
  the sorted times a valid decode order. The whole file is then shifted later
  by the worst overshoot so that no composition offset comes out negative, **by
  the same amount on every track**, which is what stops the derivation moving
  sound relative to picture. A transport stream needs none of this: it states
  both times, so this is the one format that arrives with **less** inference in
  it than Matroska rather than more.
- **Audio frame times, for both new containers.** A stream states a time per
  PES packet or per AVI chunk, and each frame is a fixed number of samples
  long, so there are two sources for a frame's timestamp and they disagree by a
  tick or two constantly — 1024 samples at 44.1 kHz is 2089.796 ticks of a
  90 kHz clock, so the encoder rounds and the rounding alternates. Taking the
  stated time per frame writes a `stts` with an entry for almost every frame, a
  megabyte of table on an hour of audio, to express jitter that is not in the
  sound. Taking the codec's own frame length alone would ignore a real dropout
  and slide every later frame earlier for the rest of the film. So the frame
  length is projected, and a stated time that disagrees with the projection by
  more than two frames is treated as a genuine discontinuity, restarts it, and
  **is counted and reported**.

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

Two shapes are new with the later containers. A run of nothing but `00 00 01`
start codes is eighty million legal NAL units in a 256 MB file, every one of
them zero bytes long; the walk terminates because it advances, and it _answers_
because of the node bound. And the exp-Golomb reader over a parameter set is
the only place here that consumes a variable-length code — a leading-zero count
is unbounded in principle, so a field read from a long run of zero bytes would
scan the whole buffer, and there are a dozen such fields between the front of
an SPS and the picture size. The run is capped at 32 and the reader marks
itself overrun, which is the caller's signal to refuse the track.

**It does not allocate on trust.** Every table in `stbl` and every EBML element
begins with a length the file wrote. `entriesThatFit` is the one function that
turns a declared count into a real one, by measuring the box that declared it;
an `stsz` claiming four billion samples out of twelve bytes yields zero. The one
table with no per-entry bound — a uniform sample size — is bounded by the length
of the file instead, since a one-byte sample cannot appear more times than there
are bytes.

The two later containers add a new lever, because **they assemble**. An MP4 or a
Matroska sample is a contiguous run of the input, so the worst a hostile index
can do is point at the wrong bytes. A transport stream's frames are gathered
into a buffer this tool allocates and an AVI's audio likewise, so a hostile file
gets to choose how much is copied. Every such buffer is sized from a
**measurement** rather than from a declaration: the transport-stream reader
walks the packets once to total the real payload on each stream before it
allocates anything, and the AVI reader sums the chunk sizes it found by walking
`movi` rather than any length a chunk header claimed. One access unit is
assembled in a buffer that grows on demand and is capped, because a file that
withholds the start of the next frame would otherwise turn "gather until the
next one begins" into "gather the whole file again".

**It never throws.** A tool that throws takes the worker down and every
unrelated request in flight with it. Asserted over arbitrary bytes, over real
headers followed by noise, over bytes laid out on a valid packet grid with
hostile contents — which is what gets past a detector that is periodicity
rather than a signature — and, the one that reaches the interesting code, over
a valid file of each of the four containers with one byte changed, hundreds of
times each, in bounded time.

And one property that is about honesty rather than safety: **a damaged file is
refused or reported, never quietly half-converted.** Reading past the end of a
`Uint8Array` in JavaScript is not a crash, it is a zero — so a truncated
download whose index survived would otherwise produce a perfectly well-formed
MP4 full of silence and black. Every sample's byte range is checked against the
length of the file, once, before anything is allocated. Where a file is damaged
part of the way through and the rest is readable, what could be read is
repackaged **and the result says so**.

Two guards are worth naming on their own.

Nothing in either indexed container forbids two samples from pointing at the
same bytes, so a small file can describe an enormous one: a twenty-five
kilobyte file declaring two thousand samples of four kilobytes each asks for
eight megabytes, and every individual range in it is inside the file and passes
every other check. The bound is the input's own size, because a repackage
**copies** — it cannot honestly produce meaningfully more media than it was
given.

And a transport stream that loses its packet grid is **treated as damage rather
than as a reason to resynchronise**. Hunting for the next plausible 0x47 inside
compressed video finds one within a few hundred bytes, so a reader that does it
carries on confidently through nonsense and reports success.

## What it reads, and what it can hand back

This section used to be called "the size limit, and the files it rules out",
and the limit was **256 MB** — which ruled out very nearly every file this tool
exists for. That number was never about video. It was about memory: a run held
the input three times over, because the page kept the chosen file's bytes for
the session, the worker got a structured clone of them, and the output was
built beside that clone. A transport stream cost a fourth copy, because its
frames are not contiguous and had to be gathered before they could be indexed.

**None of those copies exists now**, and the change is in
[the value model](../../../docs/architecture.md#where-a-values-bytes-are)
rather than in this directory. A `bytes` value carries a reference to a blob
instead of the bytes themselves, so:

- the page never reads the chosen file — measured at **4096 bytes** for a
  320 MB video, which is the sniff and nothing else;
- the worker is handed it by reference, which costs 0.0–6.0 ms at 512 MB rather
  than a copy;
- all four readers walk it through a window, synchronously, through
  `FileReaderSync` — 868 MB/s in JavaScriptCore, 1149 in Chromium, 4163 in
  Gecko;
- a transport stream's gathered frames and the finished MP4 both go into a
  `ByteSink`, which keeps a small result in memory and hands a large one to
  blob storage as it fills.

### What it accepts

`maxInputBytes` is **4 GiB**, and it is a statement about what this tool will
agree to walk rather than about what fits anywhere. The number comes from the
formats: AVCHD splits its clips at 2 GB, an OpenDML AVI exists **because** the
format's 32-bit offsets cannot address past 2 GB, and an hour of DVB recording
is 2 to 4 GB. Those are the sizes the files this reads actually reach.

### What it can hand back

**About 1.9 GB**, and this is the one real limit left. A finished file has to
become a single blob for a download, and blob storage is bounded — measured by
assembling 8 MB parts in a worker and reading the result back after each,
Chromium refuses at 2 GiB with a `NotReadableError` and 1.88 GiB is the largest
that worked, while Gecko and JavaScriptCore both went past 4 GiB. So the
ceiling is Chromium's, and a repackage that would exceed it is **refused before
a byte is copied**, with the size named and the audio operation pointed at.

What that means for the four archetypal files:

| File                               | Repackage                                        | Extract the audio |
| ---------------------------------- | ------------------------------------------------ | ----------------- |
| A DivX film, 700 MB – 1.4 GB       | reads it, then refuses the **codec** — see above | yes               |
| A 1.5 GB MKV of a feature          | yes                                              | yes               |
| An AVCHD clip, split at 2 GB       | at the line — see below                          | yes               |
| An hour of DVB recording, 2 – 4 GB | refused: the answer would not fit                | yes               |

**At the line** means what it says. The output is usually a little smaller than
the input — the extra audio dubs are left behind, a transport stream's packet
headers are 2% of it, and nothing but `moov` and `mdat` is written — so a file
a shade over the ceiling often produces an answer a shade under it. A file well
over it does not, and the refusal names the figure rather than leaving anybody
to work it out.

The remaining fix is not a bigger number either. It is writing the output
somewhere that is not a blob — the File System Access API, which is Chromium
only, or OPFS, which all three have — and both of those are a save flow with a
file handle in it rather than a value on a wire. That is a product decision
about where a result lives, not a parser change.

## What has not been tested

Named here rather than left to be assumed, in the same spirit as the rest of
this repository.

**One file produced by this tool has been played by a real player**: a `.mov`
off one phone, repackaged, which came out the right way up, scrubbed correctly
and kept its sound in step. That is one file, from one encoder, in one
container — and it is the whole of the evidence that the writer, the rotation
matrix and the timing tables work on anything real.

**The two new readers put that back where it was**, and are more exposed than
the first two were:

- **No transport stream written by a real encoder has been read.** Every
  fixture is hand-built, including the parameter sets — which are written out
  bit by bit through the real syntax precisely so that the size the reader
  reports is a size an encoder would have written, rather than one this
  repository invented. It is still not a camcorder.
- **HEVC is the least-supported thing here.** It was already exercised only
  through the code path and not through a file; it now also has the most
  delicate function in the tool in front of it, `readHevcSps`, whose twelve
  bytes of profile-tier-level sit behind variable-length fields and cannot be
  checked against anything except a decoder.
- **No AVI carrying H.264 has been read.** That path is the one AVI case that
  produces a file rather than a refusal, and it is also the rarest kind of AVI,
  so it is the least likely to be tried by accident.
- **Nothing has run on a phone.** The memory arithmetic above is now measured
  rather than read off the engine — a 320 MB transport stream through the real
  app in two engines, with the main thread's reads of the file counted — but it
  is measured on a desktop. A phone has a fraction of the memory and a browser
  far quicker to discard a tab, and the number that is still a desktop's is how
  much blob storage one will actually give a page before `FileReaderSync`
  starts refusing. **That is the first thing to check on a device**, and it is
  the one claim here a laptop cannot stand in for.

The device checklist is [manual-checks.md](../../../docs/manual-checks.md),
in priority order, with the failure each step exists to catch.
