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

| Check                                                     | Needs                       | Time   |
| --------------------------------------------------------- | --------------------------- | ------ |
| [Safari itself](#1-safari-itself)                         | A Mac, or an iPhone or iPad | 6 min  |
| [A real on-screen keyboard](#2-a-real-on-screen-keyboard) | A phone                     | 4 min  |
| [A backgrounded tab](#3-a-backgrounded-tab)               | Any browser                 | 2 min  |
| [Rich text in Word](#4-rich-text-in-word)                 | Word, Google Docs, Outlook  | 10 min |
| [A repackaged video plays](#5-a-repackaged-video-plays)   | QuickTime, VLC, a phone     | 8 min  |

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

**Why a human.** `check:browsers` asserts that the compressed frames come out
of the video tool byte for byte and that the index round-trips through the
tool's own reader. That is a real assertion about a real answer, and it is not
the question a person has. **Nobody has ever played a file this tool produced.**

There is a second reason, and it is the one worth being uncomfortable about:
every fixture in the suite is hand-built, so **no file written by a real
encoder has ever been read by it**. The MP4 builder in `fixtures.ts` goes out
of its way to do what our writer does not — `mdat` first, a 32-bit `stco`,
several samples per chunk, a QuickTime version-1 audio entry — because a
fixture produced by the code under test proves only that the code agrees with
itself. It is still not a camera.

**Do these six in order.** You need one file off a phone and one `.mkv` from
anywhere. Under 256 MB, or the tool refuses it at the moment you choose it —
which is itself step 6.

1. **A phone video, repackaged.** Record ten seconds on a phone **holding it
   upright**, get the `.mov` onto the machine, open `/tools/video-remux`,
   choose it, and press Run. Download the result and open it in QuickTime or
   VLC.
   - _Pass:_ it plays, the picture is **the right way up**, and the sound is in
     step with it.
   - _Fail (the one this step exists for):_ it plays **on its side**. That is
     the display matrix not surviving the repackage, and it is the exact shape
     of failure this repository keeps writing down — correct in every
     measurable respect and obviously wrong to a person.
   - _Fail:_ the sound drifts out of step as it goes.

2. **The same file in Safari.** Drag the result into a Safari window.
   - _Pass:_ it plays. Safari is the strictest reader of an MP4 in common use,
     and it is also the one WebKit-via-Playwright is least like.
   - _Fail:_ a black frame, or a download prompt instead of a player.

3. **Scrubbing.** Drag the playhead to the middle and let go, three times.
   - _Pass:_ it lands and resumes within a moment each time.
   - _Fail:_ it jumps to the start, or stalls. That is the sync-sample table:
     an absent `stss` means "every frame is seekable", which is a plausible
     wrong answer that plays perfectly from the beginning.

4. **An `.mkv`, repackaged.** One with H.264 and AAC in it — a WebM will be
   refused, correctly, and tells you why. Play the result.
   - _Pass:_ it plays, in step, with the same running time as the original.
   - _Fail:_ the picture stutters or the frames are subtly out of order. That
     is the decode-time reconstruction, which is the one thing in this tool
     that is inference rather than transcription.

5. **The audio out of it.** Set the operation to **Extract the audio track**
   and run it on the same file. Play the `.m4a` in a music player.
   - _Pass:_ it plays end to end, at the right pitch and the right length.
   - _Fail:_ it is the right length and the wrong speed, or a fraction of the
     length it should be. Both are lacing: several audio frames share one
     Matroska block, and a reader that mishandles that produces audio that is
     all there and wrong.

6. **Something too big.** Choose a file over 256 MB.
   - _Pass:_ it is refused **at the moment you choose it**, naming the file,
     its size and the limit, before anything is read.
   - _Fail:_ the app thinks about it, then refuses. That means the limit is
     being applied after the read rather than before it.
