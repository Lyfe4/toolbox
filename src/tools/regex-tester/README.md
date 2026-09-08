# Regex

Test a regular expression against text, with groups, replacement and an
explanation of what happened.

This tool is unlike the rest of the toolbox in two ways, and both of them shape
everything below.

**Its input is a program.** A pattern is code, and this is the only tool here
that executes something the user wrote. The engine that runs it cannot be
interrupted, so the defences have to be structural rather than careful.

**Its value is in the feedback, not the count.** Nobody opens a regex tester to
be told a pattern matched. They open it because a pattern did something they did
not expect, and a tool that reports "0 matches" and stops has answered the easy
half of the question. Most of this file is about the other half.

- [The hazard, and the only defence that works](#the-hazard-and-the-only-defence-that-works)
- [Warning before it is too late](#warning-before-it-is-too-late)
- [Zero-length matches](#zero-length-matches)
- [The four numbers, and why each is what it is](#the-four-numbers-and-why-each-is-what-it-is)
- [When a pattern will not compile](#when-a-pattern-will-not-compile)
- [When a pattern found nothing](#when-a-pattern-found-nothing)
- [Flags](#flags)
- [Offsets, Unicode and what a character is](#offsets-unicode-and-what-a-character-is)
- [Replacement](#replacement)
- [Highlighting](#highlighting)
- [Options](#options)
- [Outputs](#outputs)
- [Known limitations](#known-limitations)
- [Tests](#tests)

## The hazard, and the only defence that works

JavaScript's regex engine backtracks. For a pattern like `(a+)+$` against a run
of `a`s with a non-matching tail, the number of ways to partition the input
grows **exponentially**. Twenty-seven characters is enough to hang a tab.

There is no way to interrupt it from inside. `RegExp.prototype.exec` is a single
synchronous call into the engine: no `AbortSignal` reaches it, no step budget
exists, no callback ever runs. Every working "regex timeout" in JavaScript works
the same way — **put the call somewhere killable, and kill it**.

So this tool:

- declares `strategy: 'worker'`, so the call is somewhere killable;
- declares `timeoutMs: 2000`, deliberately short. Measured: every honest pattern
  tried against the largest subject this tool accepts — two million characters
  of Apache log, matched with `\w+`, an email pattern, `^.*$` and a URL pattern —
  finishes in **under 25 ms**. A run that reaches two seconds is therefore
  overwhelmingly a blow-up rather than honest work, and waiting thirty seconds to
  say so would just be thirty seconds of a dead tab;
- declares its own `timeoutMessage`. The engine terminates and replaces the
  worker and reports **that pattern is too slow… almost certainly backtracking
  catastrophically** — not "the tool took too long", which would send the user
  looking for a bug in Patchbay rather than at their own pattern.

`ExecutionMeta.timeoutMessage` exists for this tool. `engine.test.ts` asserts the
engine prefers it over the generic text while still reporting the code as
`timeout` and saying how long it waited.

### The soft budget, which is a different defence

The worker kill is the only thing that survives a single `exec` that never
returns, and it is blunt: it takes the entire result with it, so the user is
left with an explanation and no matches.

There is a second shape of runaway that the kill handles badly — a perfectly
fast pattern asked to produce an enormous number of results. That one the tool
can stop itself, because the engine returns between matches. `runRegex` checks
the clock every 256 matches against a **1,000 ms** budget, half the worker
timeout, and stops with what it has and a note saying the count is a lower
bound. A partial answer that says it is partial beats no answer.

**It does not help against catastrophic backtracking**, and it is not intended
to. Nothing checked between engine calls can help when the engine never returns.

## Warning before it is too late

A timeout can only speak after two seconds of a dead tab, and it cannot speak at
all about the run that finished. So the pattern is also read _structurally_,
before it is run, and the result travels with every report.

Two shapes account for almost every real blow-up, and both are invisible to
anyone who has not been bitten before:

| Shape                                                              | Why it explodes                                                                                                                     |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| A quantified group whose body can itself repeat — `(a+)+`, `(.*)*` | The input can be split between the two quantifiers in exponentially many ways, and a failing tail makes the engine try all of them. |
| A quantified group whose branches overlap — `(a\|a)*`, `(\d\|\w)+` | Every character has more than one derivation, so _n_ characters have 2ⁿ.                                                            |

**The decision: warn always, block never, and say it is a heuristic.** The
warning appears on the run that succeeds — which is the useful moment, because
that is the run before the one on the real file. It never refuses to run a
pattern: a `(a+)+` that the user knows is safe on their input is their call, and
a tool that argues with you about your own regex is a tool you stop using. And
the view says _"a structural check, not a proof; it can be wrong in both
directions"_ in as many words, because a heuristic sold as a guarantee is worse
than no heuristic.

The check is deliberately quiet on ordinary work — there is a test that runs it
over an email pattern, an IPv4 pattern, an HTML-scraping pattern, a log pattern
and a lookahead-based password rule and asserts it says nothing. A warning that
fires on an email pattern is a warning nobody reads.

## Zero-length matches

A **global** pattern that can match the empty string never advances `lastIndex`
on its own, so `while ((m = re.exec(s)))` loops forever on `a*`. The remedy
every tutorial gives is `lastIndex += 1`, and this tool used to use it.

**It is wrong under the Unicode flags, and it was wrong here.** Incrementing by
one code _unit_ lands between the two halves of a surrogate pair, and the engine
then resolves that position back to the start of the same code point — so the
match repeats at the same offset forever. The symptom was not a hang but
something worse: `/^/gu` against any text containing an emoji reported **5,000
matches at index 0** and described itself as merely truncated. A wrong answer
wearing the costume of a big one.

The fix is the spec's own `AdvanceStringIndex`: advance by a whole code point
when `u` or `v` is on, and by one code unit otherwise. Both halves matter — with
`u` off the string really is a sequence of code units and every one of them is a
valid position.

`regex.test.ts` asserts the whole match list equals `String.prototype.matchAll`
across every combination of nineteen patterns, seven flag sets and eleven
subjects, and again over generated subjects with `fast-check`. `matchAll` is the
specification's own answer to "every match of a global pattern", so anywhere
this tool disagrees with it, this tool is wrong.

**The decision: zero-length matches are reported, never skipped.** `/^/gm` finding
the start of every line is a legitimate and useful query, and a tester that
silently dropped its results would be lying about the pattern. They are instead
made _visible_: the text listing writes `(empty match)` rather than an offset
followed by nothing, the highlight draws a caret rather than nothing at all, and
a note appears when every match is empty. That note distinguishes a pattern that
_could_ have consumed something and did not (`x*` — probably meant `+`, a
warning) from one made only of anchors (`^` under `m` — exactly right, a note).

## The four numbers, and why each is what it is

| Bound                   | Value    | What it caps                                      |
| ----------------------- | -------- | ------------------------------------------------- |
| `timeoutMs`             | 2,000 ms | The worker, killed from outside                   |
| `SCAN_BUDGET_MS`        | 1,000 ms | Our own scan, stopped from inside between matches |
| `MAX_MATCHES`           | 5,000    | Matches described in full                         |
| `MAX_HIGHLIGHT_MATCHES` | 500      | Matches drawn in the highlight                    |
| `MAX_HIGHLIGHT_CHARS`   | 100,000  | Subject length above which nothing is highlighted |

**The count and the listing are now separate numbers.** Past `MAX_MATCHES` the
scan carries on _counting_ and stops building result objects. That split is the
point: "how many times does this appear" is the question people most often bring
to a regex tester, and the previous behaviour — stop at 5,000 and report 5,000
as the count — answered it with a number that looked like a fact and was not.

**500 rather than 5,000 for the highlight**, because every highlighted match is
a DOM element and nobody reads the four thousandth. The listing and the count
are unaffected; only the picture stops, and it says so. The subject text is
still rendered in full, so the highlight is short rather than wrong.

## When a pattern will not compile

The engine is asked first and is the **only** authority on whether a pattern is
valid. Only once it has refused is the pattern read structurally, and only to
turn the answer into something actionable. A pattern our own reader dislikes but
the engine accepts simply runs.

That ordering matters because engines disagree about wording — V8 says
"Unterminated group", SpiderMonkey says "unterminated parenthetical" — and none
of them reports a position at all. Matching on those strings would be a
browser-sniffing exercise that rots the first time an engine rewords a message;
reading the pattern ourselves gives a message we control **and an offset**, which
is what turns "that pattern is not valid" into something to act on.

What it can name, with the caret in the right place:

- a `(` or `[` that was never closed, pointing at the one that opened it;
- `(?P<name>...)`, which is Python's spelling and the single most common thing
  to arrive here from a pattern written for another language;
- `(?#comment)`, which JavaScript has never had;
- `a{3,1}`, a quantifier that counts down;
- `a++`, a possessive quantifier, which JavaScript does not have either;
- a trailing lone backslash;
- two groups with the same name;
- `\k<nope>` and `\3` with two groups, with the names that do exist listed;
- an unknown Unicode property, with working examples;
- an escape that only `u` forbids.

The engine's own message is always kept as the detail, and where the reader has
nothing to say it is shown on its own rather than replaced by a worse guess.

### Features this browser may not have

`(?<=...)`, `(?<name>...)`, `\p{...}`, `(?i:...)` and the `v` flag are all
_syntax errors_ on an engine that lacks them, and the message is about syntax —
which sends the user hunting for a typo in a pattern that is perfectly well
formed. Each is probed once at module load and reported by name:

> This browser does not support lookbehind assertions. Safari did not support
> `(?<=...)` until 16.4.

Probing rather than sniffing a version, so the answer is a fact about the
browser doing the running rather than a table that goes stale.

## When a pattern found nothing

This is the case people actually bring here, and it is answerable. Every note is
derived by **running something**, never by guessing: if the tool says the pattern
matches with `i` on, it has compiled that pattern and matched it.

| It says                                  | Because it ran                                    |
| ---------------------------------------- | ------------------------------------------------- |
| The pattern still has its slashes        | `/^\/(.*)\/([dgimsuvy]*)$/` on the pattern itself |
| It matches if you ignore case            | the pattern again with `i` added                  |
| It matches with multiline on             | again with `m`, if the pattern has `^` or `$`     |
| It matches if `.` can cross a line break | again with `s`, if the pattern has a `.`          |
| It matches without the Unicode flag      | again with `u` or `v` removed                     |
| Your text uses CRLF line endings         | again with the `\r\n` normalised to `\n`          |
| **It matches as far as `^\d{4}-`**       | each prefix of the pattern, shortest first        |

The last one is the one that turns "no matches" into something to act on: not
"your pattern is wrong" but "everything up to here is fine, and the next part is
what fails". The pattern is cut at each **top-level** boundary — never inside a
group, which would produce something that does not compile — and a trailing `$`
is dropped, because keeping it would make every prefix fail for a reason that has
nothing to do with the part being tested. Patterns with top-level alternation are
declined outright: `abc` is not a prefix of `abc|def`, so reporting it as one
would be reporting something untrue.

**The probing is bounded.** Each probe is a single `test` against a non-global
copy, the prefix search stops after 24, and the whole set is skipped when the
main scan already took more than 50 ms — a pattern that took half a second to
find nothing must not be run eight more times to explain itself. When that
happens the tool says so, rather than being silently unhelpful.

The CRLF check is worth singling out. Text pasted from a Windows file ends its
lines `\r\n`; a pattern written against `\n` meets a `\r` it never allowed for,
because `.` and `[^\n]` both stop at one. It is the archetypal "works in my
editor, not here", and the character responsible draws nothing on screen. The
test is empirical rather than syntactic, so it stays quiet on a pattern that
already copes — `$` under `m` matches before a `\r` perfectly well, and gets no
note.

### And when it did match

Notes appear for the surprises on the other side too: global being off, a group
that never captured in any match, sticky stopping at the first gap, every match
being empty, the count exceeding the listing, and offsets being in UTF-16 code
units when the subject contains astral characters. A pattern that simply worked
gets no notes at all — asserted by a test, because the fastest way to make
advice worthless is to give it every time.

## Flags

All seven, and the two that interact confusingly are the two most worth having
in a _tester_.

**Sticky (`y`) is now offered**, having previously been left out on the grounds
that it "interacts confusingly with the match loop". That is exactly what a
tester should explain rather than hide, and hiding it left the tool unable to
answer a question people genuinely have. Its two behaviours are both explained
in the notes:

- **`y` without `g` is a single match**, anchored at position 0. It used to be
  looped over, which produced two matches for `/a/y` on `"aab"` while the
  _replacement_ — which the engine does, and which for a non-global regex is a
  single `exec` — changed one of them. The listing and the replacement
  disagreeing about how many matches there are is a worse failure than showing
  one match where a loop could show two.
- **`y` with `g` matches consecutively from the start** and stops at the first
  position that does not match. This is the tokeniser behaviour, and native
  `String.prototype.replace` does the same thing, so the two agree.

**`u` and `v` are one choice, not two toggles**, because `new RegExp('a', 'uv')`
throws. Two checkboxes that cannot both be ticked is a state the user can enter
and then has to be told off for; a select cannot represent it at all. The option
still reads the old boolean spelling — it used to be `unicode: true` — because
options travel in share links and in the saved canvas, and Zod strips keys it
does not recognise, which would have turned an old link into the same pattern
quietly matching different text.

**`d` is not offered and is always on.** It changes nothing about what matches;
it only adds `match.indices`, which is the only way to say _where_ a capture
group matched rather than merely what it captured — and "my group captured the
wrong thing" is most of what people come here to work out. Offering it as a
toggle would be offering a switch with no observable effect. It is added at
compile time and never appears in the flag string the tool talks about, and an
engine that rejects it gets the pattern compiled without it rather than being
told its own missing flag is the user's syntax error.

## Offsets, Unicode and what a character is

Every offset here — `index`, `end`, the group spans, the column — is in **UTF-16
code units**, which is what the engine reports and what `String.prototype.slice`
expects. It is also not what a person counts: `😀` is one character to a reader
and two to all of the above.

The decision is to use the engine's unit and _say so_, rather than to invent a
friendlier one that then disagrees with every other tool the user will paste the
number into. When the subject actually contains an astral character, a note
appears explaining that each counts as 2. The table header says
`Offset (UTF-16)` rather than `Offset`.

The highlight is unaffected by all of this: it is built from slices of the
subject rather than from arithmetic on offsets, so it is exact whatever the
text contains.

## Replacement

**The substitution is the engine's, not ours.** `$1`, `$&`, `` $` ``, `$'`, `$$`
and `$<name>` have rules subtle enough to be worth reading twice, and a
reimplementation that got one of them wrong would produce output that _looked_
right — which is the failure mode this whole pass exists to hunt. Measured, the
second pass over the subject costs about 5 ms on the largest input the tool
accepts, which is a very cheap way to be certain. A property test compares the
replaced text against `String.prototype.replace` across every token.

What the tool does instead is _read_ the replacement string and explain it:

- **`$3` with two groups is literal text.** So is `$0`. The tool says so rather
  than leaving the user to find `$3` in the output.
- **`$<nope>` is not literal.** With any named group in the pattern at all, an
  unknown name is replaced by _nothing_ — but with no named groups anywhere,
  `$<nope>` comes through untouched. Two opposite behaviours from the same
  spelling, and the tool names which one is happening.
- **`\1` is not a group reference.** It is the spelling in a pattern, in sed and
  in most other languages' replacement strings; in a JavaScript replacement it is
  an escaped `1`, which is a `1`.
- **`` $` `` and `$'`** insert everything before and everything after the match,
  so on a global replace each match carries a copy of the rest of the subject.

Note that a replacement is applied to **every** match, including any beyond
`MAX_MATCHES` — the engine does not have a listing limit. The listing says how
many it is showing and the count says how many there are, so the two can be
reconciled.

## Highlighting

The highlight and the table are a deliberate pair, and each does what the other
cannot.

**The highlight shows whole matches only.** Capture groups can nest and can be
adjacent, and there is no honest way to draw overlapping regions in a run of
text — any attempt picks a winner and lies about the rest. So groups live in the
table, where each states its own offsets unambiguously, and the table is the
authoritative half.

Four things the highlight has to get right, none of which a coloured `<pre>`
does on its own:

1. **Adjacent matches stay two matches.** `abab` against `/ab/g` is two marks
   with no gap between them, each with its own outline. Merging them would show
   one long match where there are two — and that error is invisible in the data.
2. **A zero-length match is drawn.** It has no text to colour, so it gets a
   2px inline-block caret carrying a visually hidden "empty match" label — which
   is also what a screen reader hears, since there is nothing to read.
   `inline-block` rather than `block`, because a block-level element inside a run
   of text splits the line three ways; this project measured that once already.
3. **Colour is never the only signal.** A match is a tint _and_ an outline _and_
   an underline, so it survives greyscale and a colour-vision deficiency, and
   forced-colors mode swaps in the system `Highlight` pair.
4. **The box scrolls, so it is focusable.** A scrollable region that cannot be
   focused is unreachable from the keyboard — a defect this project has already
   shipped once, in the shortcuts dialog, and one that is structurally invisible
   to jsdom.

Both the highlight and the table use `unicode-bidi: isolate`, for the same
reason the diff view does: a subject containing U+202E reorders everything after
it, and without an isolate that reordering escapes the box and rearranges the
page around it.

A property test asserts the segments concatenate back to the subject exactly. If
they ever stop doing so, the highlight is showing text the user did not type.

## Options

| Option                  | Effect                                                                                                          |
| ----------------------- | --------------------------------------------------------------------------------------------------------------- |
| Pattern                 | Written without slashes.                                                                                        |
| Mode                    | Find matches, or replace.                                                                                       |
| Replacement             | `$1`, `$<name>`, `$&`, `$$`, `` $` `` and `$'` all work. Shown in replace mode.                                 |
| Global (g)              | Every match rather than the first.                                                                              |
| Ignore case (i)         |                                                                                                                 |
| Multiline (m)           | `^` and `$` match at each line break.                                                                           |
| Dot matches newline (s) |                                                                                                                 |
| Unicode                 | Off, `u` (code points and `\p{...}`), or `v` (set notation, and properties that match more than one character). |
| Sticky (y)              | The match must start where the last one ended.                                                                  |

## Ports

The subject port accepts **`text` and `bytes`**, and it used to accept only
text. A log file is the canonical subject for a regular expression and a file
is bytes, so the widening closed a gap that was between the two ROUTES rather
than inside either: a tool page has always taken a dropped log file, because
the runner decodes a text-sniffed file before handing it over, while on the
canvas the same bytes arriving through a base64 decode had no legal wire at
all. One tool that accepts a file in one place and refuses it in the other is
drift rather than a decision. See the
[port audit](../../../docs/architecture.md#the-port-set).

Nothing on the canvas could be handed a log file DIRECTLY either, whatever the
port's types said, so the canonical use went through a base64 decode by hand.
A node's input can be a file now — drop one on the node or choose one in the
inspector — and the decode below is the same one either route takes. See
[a file as an input](../../../docs/architecture.md#a-file-as-an-input).

Bytes are decoded **strictly**, through [`lib/text.ts`](../../lib/text.ts), so
a PNG on that port says it is not text rather than being searched as mojibake
and reporting matches at offsets into characters nobody wrote. That is the
whole condition on widening a port: it has to refuse clearly instead of
guessing.

## Outputs

`output` is the replaced text in replace mode, and an offset-and-match listing
otherwise. The listing escapes `\r` and `\n` inside a match: a match containing
a newline used to become two rows, indistinguishable from two matches.

`matches` is the full report as JSON — pattern, flags, count, listing,
highlight segments, notes and risk findings. It is both the wire format for
another node and the view model for the highlight, which is the same bargain the
diff tool makes: one payload, drawn richly here and readable as plain JSON
anywhere else.

"Readable as plain JSON anywhere else" was, for a while, not true of the page
itself: `RegexView` rendered the report and offered no way back to it, so the
only route to the payload was to wire the port into another node. The view now
carries the same **Raw** toggle every other view does, with Copy and Download.
It is not redundant with `output` — that is the replaced text or a printed
listing, an answer to a different question — and the group names, the
per-capture offsets, the `risk` findings and the segment model behind the
highlight exist nowhere else. The match table also stops at 200 rows; the
payload does not, which is exactly the case where somebody wants it.

A group that did not participate in the match is `undefined` at runtime. The DOM
types model the match as `string[]`, and `match.indices` as an array of tuples,
neither of which is true; the code corrects both and reports such groups as
`null`, because JSON has no `undefined` and the hole has to survive the trip out
of the worker.

## Known limitations

**Only JavaScript's flavour.** PCRE, Python and Go differ in ways that matter —
possessive quantifiers, atomic groups, `\A`/`\z`, inline comments, different
Unicode defaults. The tool recognises three of those spellings well enough to
say "JavaScript does not have this" rather than "invalid group", which is the
most useful thing it can do without an engine to run them in.

> **If other flavours are added later**, the piece that will need work is
> [`pattern.ts`](pattern.ts), which reads JavaScript's syntax and is called by
> the error explainer, the risk analysis and the prefix search alike. Its
> `parsePattern` already takes a mode argument (`unicodeSets`), so widening that
> to a flavour enum is the natural shape. Nothing else assumes the flavour:
> `runRegex` only ever sees a compiled `RegExp`, and the diagnosis probes work by
> re-running whatever engine it was given. The one decision that _would_ have to
> be revisited is [`options.ts`](options.ts) — the flags are modelled as
> individual JavaScript toggles, and PCRE's `x` and `A` have no home there.

**The risk analysis is a heuristic.** It reports structure, not a proof.
`(a+)+` is flagged whether or not any subject can trigger the blow-up, and a
pattern it stays quiet about can still be slow — polynomial backtracking, which
is the more common real-world case, is not detected at all. The view says so.

**A pattern warning cannot appear before the first run.** The analysis lives in
the tool, and the tool runs in a worker when the user presses Run; the options
panel is generic and has no per-tool hook to render into. So the warning appears
_with_ the first result — which is still before the run on the real file, and is
the moment it is useful — but a pattern that times out on its very first run gets
the timeout message and no analysis, because our code never executed. Fixing that
properly means a per-tool options-panel affordance, which is a change to the
registry rather than to this tool.

**A pattern that hangs takes its neighbours with it.** When the worker is
killed, other tools running concurrently on the canvas are killed too, and each
then reports its own timeout after its own deadline — so a `base64` node beside a
runaway regex says "the tool took too long" when in truth it was collateral. This
is `engine.ts` behaviour rather than this tool's, and it is written down here
because this is the tool that makes it reachable. Reproduction: wire two nodes to
one source, give one of them `(a+)+$` and a run of forty `a`s, and run the graph.

**Offsets are UTF-16 code units.** See above; this is a decision rather than a
defect, but it is a decision that will surprise someone.

**No cross-flavour or cross-engine comparison.** The tool tells you what _this_
browser's engine does. Where two engines differ — and they do, at the edges of
Unicode property support — there is nothing here that would show you.

## Tests

- [`regex.test.ts`](regex.test.ts) — compilation, offsets, groups and their
  spans, the zero-length guard including the surrogate-pair case, the match
  limit and the count that outlives it, the soft budget, sticky, replacement
  against the engine, the highlight segments, agreement with `matchAll` across a
  matrix and under `fast-check`, patterns from the wild, and the pathological
  case.
- [`pattern.test.ts`](pattern.test.ts) — the structural reader: what it accepts,
  what it explains, the risk analysis including its silence on ordinary
  patterns, prefixes, and a property test asserting it is never stricter than the
  engine and always agrees about the group count.
- [`diagnose.test.ts`](diagnose.test.ts) — every note, including the ones that
  must _not_ appear.
- [`../../features/toolrunner/RegexView.test.tsx`](../../features/toolrunner/RegexView.test.tsx)
  — the rendering, driven by the real tool's real output, plus axe.

Everything about the highlight that is a question of geometry is asserted in
[`scripts/cross-browser-check.mjs`](../../../scripts/cross-browser-check.mjs)
instead, against Firefox and WebKit, because jsdom has no layout engine and
would pass either way. It measures the zero-length caret (2px × 13.2px, rather
than the 0 × 0 a reset would leave), confirms two adjacent matches are two boxes
with their own outlines, checks the underline and outline are really there,
checks the highlight box actually scrolls and carries a tabindex, checks a
4,000-character subject does not widen the page, and runs axe with
`color-contrast` **enabled** over a populated result in two themes.
