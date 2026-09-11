# Manual checks

Five things this repository cannot assert about itself. Everything else that
could be automated has been — see [the known
limitations](architecture.md#known-limitations) for what was reached and how,
including the two that turned out to be reachable after all (a shrunken visual
viewport, and two tabs over one `localStorage` key).

Each list below is meant to be run start to finish in the time given, with a
real device or a real application. Every step has an observable answer; if a
step does not tell you pass or fail, it is a bad step and should be rewritten
rather than skipped.

| Check                                                     | Needs                           | Time   |
| --------------------------------------------------------- | ------------------------------- | ------ |
| [Safari itself](#1-safari-itself)                         | A Mac, or an iPhone or iPad     | 6 min  |
| [A real on-screen keyboard](#2-a-real-on-screen-keyboard) | A phone                         | 4 min  |
| [A backgrounded tab](#3-a-backgrounded-tab)               | Any browser                     | 2 min  |
| [Rich text in Word](#4-rich-text-in-word)                 | Word, Google Docs, Outlook      | 10 min |
| [A repackaged video plays](#5-a-repackaged-video-plays)   | QuickTime, VLC, Safari, a phone | 20 min |

---

## 1. Safari itself

**Why a human.** `pnpm check:browsers` runs Playwright's **WebKit**, which is
the engine behind Safari and not the Safari application: a different release
cadence, a different media stack, and different platform integration. Two
divergences are already documented in the harness — `upgrade-insecure-requests`
is applied to loopback in WebKit where Chromium and Gecko exempt it, and
Playwright's WebKit build cannot navigate at all while offline, so the offline
reload check is explicitly skipped there.

**Do these five in order.** The first is the one that matters most, and the
reason is not obvious: Playwright's WebKit has **no `OffscreenCanvas` at all**,
so the entire image suite runs down the main-thread fallback there. Real Safari
has had it since 16.4. That means the **worker path for image conversion has
never run in any WebKit this repository can drive** — it is only ever exercised
in Firefox.

1. **Image conversion goes through the worker.** Open `/tools/image-convert`,
   choose a photograph, set the format to **JPEG** and quality to **0.6**, and
   press Run.
   - _Pass:_ a converted image appears with a before-and-after, and the page
     stays responsive while it converts — scroll it during the run.
   - _Fail:_ the tab freezes for the length of the conversion. That is the
     main-thread fallback, which means `OffscreenCanvas` was not detected and
     Safari is being downgraded when it should not be.
   - Then convert a **PNG with transparency to JPEG** and read the report: it
     must say the transparency was flattened and that metadata was dropped.

2. **The preview box does not jump.** Still on `/tools/image-convert`, watch
   the area under the Run button as a conversion finishes.
   - _Pass:_ the result appears in a box that was already the right size.
   - _Fail:_ everything below the image moves down as the picture appears.

3. **Offline.** Load `/`, add two tools and wire them together. Turn off
   Wi-Fi and cellular data. Reload.
   - _Pass:_ the app loads, the graph is still there, and the pipeline still
     runs.
   - _Fail:_ anything network-shaped — an error page, a missing font, an
     unstyled screen.

4. **Nothing leaves the origin.** Open the Web Inspector's Network tab, reload,
   and use three or four tools including a file input.
   - _Pass:_ every request is to this origin, and there are none at all after
     the first load.

5. **The clipboard.** On `/tools/text-convert`, set the target to **HTML**,
   Run, and press **Copy as rich text**.
   - _Pass:_ a "Copied as rich text" confirmation.
   - _Fail:_ "This browser cannot put formatted text on the clipboard" — which
     would mean Safari's `ClipboardItem` is not being detected.

**If you only have an iPhone or iPad**, do 1, 3 and 5, and add: rotate the
device on `/` and confirm the canvas and the inspector both survive it.

---

## 2. A real on-screen keyboard

**Why a human.** Neither engine Playwright drives can open one, and until
recently nothing here could produce the geometry either. `check:browsers` now
shadows `visualViewport.height` and fires its real `resize` event, which gives
a visual viewport genuinely shorter than the layout viewport and drives
`useKeyboardInset` down its real branch — see `checkSoftKeyboard`. That proves
the arithmetic, the wiring and the response to the right event. It cannot prove
that iOS fires that event when the keyboard opens, or that what you end up
looking at is usable.

**On a phone, portrait.**

1. **The inspector sheet.** Open `/`, press **Add tool**, choose **Base64**.
   Tap the node, then tap the input field in the panel that slides up.
   - _Pass:_ the whole panel lifts so it sits on top of the keyboard, and the
     field you tapped is visible with the caret in it.
   - _Fail:_ the panel is behind the keyboard, or only part of it cleared.
   - Type four characters. All four must appear. (A missing first character or
     two is the deferred-focus bug, not a keyboard problem — see
     [CONTRIBUTING](../CONTRIBUTING.md#moving-focus).)

2. **And it goes back.** Dismiss the keyboard.
   - _Pass:_ the panel drops flush to the bottom of the screen with no gap
     under it.

3. **Scrolling inside the sheet.** With the keyboard still open, scroll the
   panel.
   - _Pass:_ the options and the output can all be reached.

4. **A dialog.** Close the panel and press **Add tool** again. Its search field
   takes focus, so the keyboard opens by itself.
   - _Pass:_ the bottom of the tool list is above the keyboard, and scrolling
     to the end of the list reaches the last tool rather than scrolling it into
     the covered space.

5. **A tool page, which should need none of this.** Open
   `/tools/regex-tester` and tap the **Replacement** field near the bottom.
   - _Pass:_ the browser scrolls it into view by itself.

**Rotate to landscape and repeat step 1.** The keyboard takes a much larger
share of the screen there, and it is where a sheet that lifts by the wrong
amount is most obvious.

---

## 3. A backgrounded tab

**Why a human.** Neither headless engine reports a hidden tab:
`document.visibilityState` stays `visible` with another page fronted, and 300ms
timers still arrive at ~310ms intervals in both. `check:browsers` simulates the
consequence — it clamps `setTimeout` to a 3s floor and shadows
`visibilityState`, then runs a wedging node beside a healthy one on the real
worker — which covers the failure that clamping can actually cause. What it
cannot do is be a real hidden tab.

1. Open `/`, press **Add tool**, choose **Regex**. Select the node and paste
   this as the pattern:

   ```
   ((a|b|c|d|e|f|g|h|i|j|k|l|m|n|o|p|q|r|s|t|u|v|w|x|y|z|A|B|C|D|E|F|G|H|I|J|K|L|M|N|O|P|Q|R|S|T|U|V|W|X|Y|Z|0|1|2|3|4|5|6|7|8|9|@|#|%|&|=|~|:|;|,|<|>|/|"|'|-|_)*)*!!
   ```

   and this as the text: `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!` — forty
   a's and one bang, which is what denies the match and forces the
   backtracking.

   **Why it is that long.** JavaScriptCore bounds the backtracking _count_
   rather than the time, so lengthening the subject buys nothing there; what
   raises the cost is making each step more expensive, which is what the width
   of the alternation does. The harness uses a wider version still, for margin
   — see `WEDGE_BRANCHES` in `scripts/cross-browser-check.mjs`. If the regex
   node reports **ok** instead of failing, your engine is simply faster than
   this pattern is slow: widen the alternation and try again, and say so, since
   the harness's own fixture will be due the same treatment.

2. Add a **Base64** node beside it and give it `eyJuYW1lIjoiYWRhIn0=`.
3. As soon as the regex node says **Running**, switch to another tab and count
   to twenty.
4. Come back.
   - _Pass:_ the regex node has failed with a message about the pattern being
     too slow, and the Base64 node shows **ok**.
   - _Fail (the one worth catching):_ the Base64 node reports a timeout. It
     finished in milliseconds; a timeout there means a late deadline settled a
     request that had already answered.
   - _Fail:_ either node still says **Running**.

---

## 4. Rich text in Word

**Why a human.** No harness can open Word, Google Docs or Outlook.
`check:browsers` now reads back what the real engine put on the clipboard —
both flavours, the inline styles, the table's border attribute, the aligned
column, the charset — so the payload is asserted. Whether those three
applications honour it is the part only you can answer.

The document to convert and the seven things to look at are in
[`src/tools/text-convert/clipboard-check.md`](../src/tools/text-convert/clipboard-check.md).

---

## 5. A repackaged video plays

**Why a human.** `check:browsers` asserts that the compressed pictures come out
of the video tool unchanged and that the index round-trips through the tool's
own reader. That is a real assertion about a real answer, and it is not the
question a person has.

**What has changed since this list was last written.** Exactly one file this
tool produced has been played: a `.mov` off one phone, which came out the right
way up, scrubbed correctly and kept its sound in step. That is the whole of the
evidence that the writer, the rotation matrix and the timing tables work on
anything a real encoder wrote.

Two new readers — MPEG-TS and AVI — put that back where it was, and they are
more exposed than the first two were. **Every fixture behind them is hand-built,
including the H.264 and H.265 parameter sets, which are written out bit by bit
through the real syntax so that the sizes the reader reports are sizes an
encoder would have written rather than ones this repository invented.** It is
still not a camcorder.

They are also the first place this tool **rewrites bytes**. H.264 in a
transport stream is Annex B, and an MP4 wants length-prefixed NAL units with
the parameter sets hoisted into `avcC`. Every coded picture is copied verbatim;
the framing around it is not. So there is a new class of failure available here
that the first two containers did not have, and it is the one the steps below
are ordered by.

### In priority order

The list is ordered by **how bad the failure is if it is wrong**, not by how
likely it is — and the first four are all shapes that produce a file which
plays. Each names the failure it exists to catch, because that is what made
the rotation case worth having.

You need: a `.ts` or `.m2ts`/`.mts` from a real device (OBS, a camcorder, a
tuner), an old `.avi` film, and QuickTime or VLC, plus Safari and a phone. Size
is no longer a reason to pick a small one — **pick a large one on purpose**,
because the largest files are the ones nothing here has ever run on. See steps
11 and 12.

1. **A transport stream, in Safari.** Repackage a `.ts` or `.mts` holding
   H.264, download the result, and drag it into a Safari window. Do this
   **before** trying VLC, and the order is the point.
   - _Pass:_ it plays, with picture.
   - _Fail (the one this step exists for):_ **a black frame with sound, or a
     "cannot play" message, in Safari — and the same file plays perfectly in
     VLC.** That is the `avcC` being wrong. VLC reads the parameter sets out of
     the samples and barely consults the configuration record; Safari will not
     start a decoder without it. So this failure presents as a Safari bug and
     is not one, and checking VLC first is how you would fail to find it.
   - _Fail:_ it plays and the picture is a green or grey smear that resolves
     after a second. That is a wrong profile or level rather than a wrong
     record — the decoder started on the wrong assumptions.

2. **The same file in a browser, and look at its SIZE.** Open the result in
   Chrome or Firefox and check the video is laid out at its real dimensions.
   - _Pass:_ the picture fills the space it should, and right-clicking it
     reports the resolution you expect (1920×1080, not 1920×1088 and not
     1920×1084).
   - _Fail (the one this step exists for):_ **the video element occupies no
     space at all — nothing renders, and there is no error in the console.** A
     transport stream states no picture size anywhere, so a `tkhd` of 0×0 is
     what a reader that did not parse the parameter set writes. QuickTime plays
     such a file perfectly, because it reads the size out of the stream, so
     this is invisible to any check that uses a desktop player.
   - _Fail:_ 1080p reports as **1084** tall. That is the frame cropping being
     subtracted as pixels rather than as chroma samples, and it stretches every
     frame by a hair.

3. **Sound in step from the FIRST frame.** Play the repackaged transport stream
   from the very beginning and watch someone speaking, or watch a hand clap.
   Then jump to the middle and watch again.
   - _Pass:_ lips and sound agree at the start and stay agreeing.
   - _Fail (the one this step exists for):_ **the sound is out of step by a
     fixed fraction of a second, consistently, all the way through.** A
     transport stream's streams do not start together — audio commonly leads
     video, and a tuner recording can have half a second between them — and an
     MP4's sample table has no field for "this track starts late". The offset
     is written as an edit list instead, and a player that got it or a writer
     that lost it both produce a film that plays at the right length with the
     sound displaced. This looks like a bad encode, not like a bad remux, which
     is why it is this high.
   - _Fail:_ the sound drifts progressively further out as it goes. That is the
     audio frame-time projection rather than the offset.

4. **An AVI's soundtrack, at the right pitch and the right length.** Take an
   old `.avi` film, set the operation to **Extract the audio track**, and play
   the `.mp3` in a music player. Check its length against the film's.
   - _Pass:_ it plays end to end, at the right pitch, and is the same length as
     the film.
   - _Fail (the one this step exists for):_ **it is the right length and the
     wrong speed, or it clicks every few hundred milliseconds.** An AVI's
     interleaver chose its chunk sizes and the codec did not, so an MP3 frame
     routinely finishes in the chunk after the one it started in. A reader that
     took a chunk as a frame produces audio that is all there and wrong.
   - _Fail:_ it is a fraction of the length it should be. That is frames being
     skipped at the chunk boundaries rather than reassembled.

5. **And the AVI's refusal is the right refusal.** Set the operation back to
   **Repackage as MP4** and run it on the same film.
   - _Pass:_ it is refused, and the message **names the codec** — "MPEG-4
     Part 2 (DivX or Xvid)" or "Motion JPEG" — and says that extracting the
     audio will work.
   - _Fail:_ it succeeds and hands you an `.m4a`. That is a feature going in
     and a soundtrack coming out under the label "Repackaged", which is the
     specific thing `refuseAudioOnlyRepackage` exists to prevent.
   - _Fail:_ it says "that does not look like a video file", which means the
     container was not recognised at all.

6. **Scrubbing a transport stream.** Drag the playhead into the middle of the
   repackaged `.ts` and let go, three times.
   - _Pass:_ it lands and resumes within a moment each time.
   - _Fail:_ it jumps to the start, or stalls, or lands on a smear that clears
     after a second. Only IDR frames are marked seekable, deliberately —
     over-reporting produces a file that plays perfectly from the beginning and
     cannot be scrubbed, and this is the step that would find it.

7. **HEVC, if you can get it.** A newer camcorder or phone recording to
   `.m2ts`, or an H.265 `.ts` from a tuner. Repackage it and play it in
   QuickTime **and** in Safari.
   - _Pass:_ both play it.
   - _Fail:_ VLC plays it and Safari and QuickTime do not. That is `hvcC`, and
     it is the least-supported thing in this tool: twelve bytes of
     profile-tier-level behind variable-length fields, checkable against
     nothing but a decoder. If this fails, `readHevcSps` is where to look, and
     the sub-layer flag loop is the most likely line.

8. **An AVCHD camcorder clip, unmodified.** If you have a camcorder, take an
   `.mts` straight off the card without letting any software touch it.
   - _Pass:_ it is read at all.
   - _Fail:_ "that does not look like a video file". Those files are 192-byte
     packets — 188 plus a four-byte arrival timestamp — and this is the check
     that the stride detection is right on a real one.

9. **A phone video, repackaged.** The original check, kept because it is the
   only one that has ever passed on a real file and because a regression in it
   would be silent. Record ten seconds on a phone **holding it upright**, get
   the `.mov` onto the machine, repackage it, and open the result in QuickTime
   or VLC.
   - _Pass:_ it plays, the picture is **the right way up**, and the sound is in
     step.
   - _Fail:_ it plays **on its side**. That is the display matrix not surviving
     the repackage — correct in every measurable respect and obviously wrong to
     a person.

10. **An `.mkv`, repackaged.** One with H.264 and AAC in it. Play the result.
    - _Pass:_ it plays, in step, with the same running time as the original.
    - _Fail:_ the picture stutters or the frames are subtly out of order. That
      is the decode-time reconstruction, which for Matroska is inference rather
      than transcription — and note that a transport stream needs none of it,
      so a fault here is Matroska-only.

11. **Something genuinely large.** A real DivX film, an hour of tuner
    recording, or an AVCHD clip — 1 GB or more, on a desktop.
    - _Pass:_ choosing it is **instant**, because the page reads 4 kB of it and
      nothing else, and the size beside the chooser is right. Then the
      repackage either completes, or is refused **naming the size of the answer
      and pointing at the audio operation** — which is what happens past about
      1.9 GB of output, and is a browser's blob limit rather than a choice
      here.
    - _Fail:_ choosing it takes seconds and the tab's memory jumps. That is the
      file being read on the main thread, which is the whole thing the value
      model changed.
    - _Fail:_ the run dies, or the Download button produces nothing. That is
      blob storage refusing, and it is the number this repository has measured
      on a desktop and nowhere else — Chromium at 1.88 GiB, Gecko and
      JavaScriptCore past 4. Write down what the device did.

12. **On a phone, and watch the memory. THE FIRST THING TO CHECK.** Repackage a
    transport stream of 500 MB or more on a phone, and then something larger.
    - _Pass:_ it completes, and the tab survives.
    - _Fail:_ the tab reloads or the run dies. Nothing here has ever run on a
      device, and a phone is where the one remaining unmeasured number lives:
      **how much blob storage a mobile browser will give a page before
      `FileReaderSync` starts refusing.** The desktop numbers in the tool's
      README are a desktop's. The input is no longer the risk — it stays on
      disk and is read in 1 MB windows — so a failure here is about the OUTPUT
      and about what the gathered frames of a transport stream cost.
