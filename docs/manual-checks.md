# Manual checks

Four things this repository cannot assert about itself. Everything else that
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
