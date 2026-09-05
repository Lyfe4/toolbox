# Text convert

Markdown, HTML and plain text, in one tool.

## Why one tool

This replaces two: `markdown` (Markdown ⇄ HTML) and `html-text` (HTML →
Markdown, HTML → plain text). They overlapped — **both converted HTML to
Markdown** — so the palette offered two entries that accepted the same input
and produced the same output, with no right answer to "which one do I want?".
That reads as accumulation rather than design.

It is shaped like the [structured-data](../structured-data/README.md) tool —
source format, target format, auto-detection — so the two read as a pair rather
than as two different ideas about the same job.

## Plain text is a target, not a source

**Decision: text can be converted _to_, never _from_.**

Every other format has structure to read. Text does not. "Convert text to
Markdown" can only mean escaping the characters Markdown would otherwise
interpret and wrapping the result — a real operation, and a _different_ one
from converting. Putting two unrelated jobs behind one control is exactly the
mistake this merge exists to undo.

It would also invite an expectation the tool must not meet. A source list
containing "Plain text" implies the converter will do something intelligent
with it — notice the lines that look like a list, linkify the URLs — and
anything it did would be guesswork applied to a document that never asked for
it.

The six pairs that remain are all meaningful:

|              | → HTML                 | → Markdown | → Plain text       |
| ------------ | ---------------------- | ---------- | ------------------ |
| **Markdown** | render                 | reformat   | render, then strip |
| **HTML**     | sanitise and normalise | convert    | strip              |

`markdown → markdown` and `html → html` are not no-ops: they run the full
pipeline, so they reformat to your chosen conventions and sanitise
respectively.

## Auto-detection

Conservative in a specific sense: it would rather **admit it is assuming** than
assert something it cannot support. The failure it is built to avoid is not
"picked the less likely option" but "said Markdown _with confidence_ about a
fragment of HTML", because the user then has no reason to look at the source
control.

It reports what it concluded on the `detected` output, with a confidence and a
reason — `markdown (confident) - Found an ATX heading.` — so a wrong guess is
visible rather than silent.

Order of evidence:

1. **A structural HTML tag** is close to conclusive. The list is small and
   block-level on purpose. Markdown is full of angle brackets that are not
   markup — `<https://example.com>` autolinks, `Array<T>` in a code span,
   `a < b` in prose — and "anything in angle brackets" would send a perfectly
   good README down the wrong pipeline.
2. **Markdown syntax** — headings, lists, fences, tables, footnotes,
   strikethrough. Syntax HTML has no equivalent of.
3. **Both** is the genuinely ambiguous case, and it drops to `assumed` either
   way. It resolves on _where_ the markup starts: at the very beginning it is a
   document, further down it is an embedded block inside Markdown.
4. **Neither** falls to Markdown, `assumed`. Markdown is a superset of plain
   prose, so converting a paragraph as Markdown returns the paragraph.

## Options

`source` and `target` are always shown. Everything else is an **output**
setting, so each one belongs to exactly one target format and appears only when
that target is selected.

| Option               | Shown when target is | Notes                                                                                |
| -------------------- | -------------------- | ------------------------------------------------------------------------------------ |
| `headingIds`         | HTML                 | Adds `id` to headings, namespaced `user-content-`.                                   |
| `linkify`            | HTML                 | GFM turns a bare `https://` or `www.` into a link.                                   |
| `bullet`             | Markdown             | `-`, `*` or `+`.                                                                     |
| `emphasis`, `strong` | Markdown             | `_` or `*`.                                                                          |
| `fence`              | Markdown             | Backticks or tildes. Always fenced — an indented block cannot carry a language hint. |
| `headingStyle`       | Markdown             | Setext reaches two levels; h3 and below stay ATX.                                    |
| `unsupported`        | Markdown             | What to do with markup Markdown cannot express.                                      |
| `keepLinkUrls`       | Plain text           | Writes the URL in brackets, when it adds something.                                  |
| `listMarker`         | Plain text           | `-`, `*`, or none.                                                                   |
| `tables`             | Plain text           | Tab-separated rows, or dropped.                                                      |

**One default the merge had to pick.** `markdown` defaulted `unsupported` to
`keep`, `html-text` to `text`, and one tool cannot have two.

`text` wins, on evidence rather than preference. `keep` reads as the lossless
choice, but keeping an element means writing it out _verbatim, subtree and
all_ — and a `<div>` is an element Markdown cannot express. Real pasted HTML
almost always arrives wrapped in one, so `keep` turns the commonest input into
a document that converts to itself. A default that can silently no-op is worse
than one that unwraps a container nobody asked to keep, and `keep` is one
control away.

## Round-tripping: what is guaranteed and what is not

**Markdown → HTML → Markdown is not byte-identical, and chasing that would be a
mistake.** `*em*` and `_em_` both produce `<em>`, so exactly one survives the
journey back. So do bullet characters, fence characters, heading style, and
whether a link was written inline or as a reference. Recording the original
syntax in the HTML so it could be restored is not what HTML is for.

Two properties hold, both asserted with `fast-check` over documents assembled
from real Markdown constructs:

| Property               | Statement                                                            |
| ---------------------- | -------------------------------------------------------------------- |
| **Idempotence**        | Converting twice produces the same output as converting once.        |
| **Semantic stability** | `md → html → md → html` produces byte-identical HTML to `md → html`. |

Semantic stability is the one that matters: the _meaning_ survives even though
the spelling does not.

### Footnotes are one-way

`md → html` renders GFM footnotes properly — a `<sup>` reference and a
`<section data-footnotes>` holding the definitions. Coming **back**,
`rehype-remark` has no handler that recognises that structure as footnotes, so
the reference degrades into an ordinary link and the definition block becomes a
plain heading and list. Rebuilding `[^1]:` syntax would mean writing a handler
that pattern-matches GitHub's exact markup.

What does hold is that it **settles**: one round trip loses the structure, and
every round trip after that changes nothing. That fixed point is asserted
directly, and footnotes are excluded from the semantic-stability arbitrary
rather than the property being weakened for everything else.

### The other things the properties step around

The stability property is stated over Markdown, and these are the places where
the arbitrary that feeds it excludes an input rather than the property being
softened. Each one is asserted by name in `constructs.test.ts`, so a change
shows up as a failing test with a description on it.

Two are the converter being **right**, and settle after one round trip:

- **Runs of spaces collapse.** HTML renders `a  b` and `a b` identically, so
  the Markdown settles on the spelling HTML would have shown.
- **Raw HTML in the source is normalised to its Markdown spelling.** `<s>`
  comes back as `<del>`, because `~~` is the nearest Markdown and `~~` means
  `<del>`. Once, then never again.

Two more are **upstream defects** — a backslash before inline markup, and a
space at the edge of a code span. Both are written up under
[Known limitations](#known-limitations) with their causes located exactly.

A third used to be here: **a list starting at zero renumbered to one.** That
one now has a fix. `hast-util-to-mdast@10.1.2` tests `properties.start` for
truthiness, so zero — the one falsy number — was the one value it dropped; the
default handler is now called and its answer corrected. Delete `orderedList`
in `pipelines.ts` when upstream reads the property rather than testing it.

### One thing was fixed rather than documented

Links are now always written in resource form — `[text](url)`, never the
`<url>` autolink shorthand. The serialiser decided to write an autolink on a
looser rule than the parser uses to read one back, and GFM's linkify reaches
the gap from ordinary prose: `+@.A` became `<+@.A>`, which CommonMark's
email-autolink grammar rejects because a domain label cannot begin with a dot,
so re-rendering produced escaped text and a stray angle bracket. The resource
form always parses back to the link it came from. It costs the prettier
spelling of a plain URL — a spelling this document already promises not to
preserve — and buys an invariant that holds.

## Getting rich text out

Rich text is what most people come here for, and it is **not one of the target
formats** — which is the one thing about this tool that is not deducible from
the options panel. `Plain text (strip formatting)` is the opposite of it: it
throws every bit of formatting away.

To paste formatted text into Word, Google Docs, an email or anywhere else that
understands it:

1. Set **Target format** to **HTML**.
2. Run.
3. On the **Rendered HTML** output, press **Copy as rich text**.

Then paste. The headings, bold, links, lists and tables arrive intact.

The button beside it, **Copy HTML**, gives you the markup as text — the thing
you want if you are pasting into an editor rather than a document. The two are
grouped because they are two answers to the same question, and the note under
them says which is which.

Behind that, one clipboard write carries both `text/html` and `text/plain`
flavours in a single `ClipboardItem`, so the receiving application takes
whichever it understands. `navigator.clipboard.writeText` can only carry one,
which is why the plain button still exists rather than being replaced.

Switching the output to **Preview** shows the rendered document, which is
exactly what rich text pastes.

## Measured conformance

The numbers, so that "it handles Markdown well" is a claim with evidence
behind it. Both suites are checked into
[`src/lib/markup/spec/`](../../lib/markup/spec/) and run on every `pnpm test`;
neither reaches the network.

| Suite                                                                    | Cases | Passing         |
| ------------------------------------------------------------------------ | ----- | --------------- |
| [CommonMark 0.31.2](https://spec.commonmark.org/0.31.2/)                 | 652   | **612 (93.9%)** |
| GFM extensions (tables, task lists, strikethrough, autolinks, tagfilter) | 24    | **21 (87.5%)**  |

**Comparison is by DOM, not by bytes**, and that choice is worth understanding
before reading the numbers. On a byte comparison the same converter scores
475/652 — and almost every one of those 177 "failures" is spelling: `<hr />`
against `<hr>`, `&quot;` against `"`, `&#x26;` against `&amp;`, a `<tbody>`
the HTML parser inserts. None is a difference a browser can see. Parsing both
sides and comparing the trees asks the question that matters, and it is not a
weakening — a dropped attribute, a removed element, or raw HTML where escaped
text was expected all still fail. The one normalisation on top is that
whitespace-only text containing a newline is treated as formatting, outside
`pre` and `code`. See [`conformance.ts`](../../lib/markup/conformance.ts).

### The 40 CommonMark examples that do not pass

Every one is about raw HTML or about a URL. **None is about emphasis, lists,
tables, code, headings or any other Markdown construct** — which is asserted
directly, so a failure appearing in another section is a parser problem rather
than a policy one.

| Cause                                                                 | Count | Examples                                                                        |
| --------------------------------------------------------------------- | ----- | ------------------------------------------------------------------------------- |
| The sanitiser removed an element or attribute the spec passes through | 25    | 150, 152–154, 163, 164, 169–173, 176, 178, 201, 491, 524, 536, 613–617, 627–629 |
| HTML comments are dropped                                             | 7     | 177, 179, 183, 308, 309, 625, 626                                               |
| URL scheme not in the allow-list                                      | 4     | 596, 598, 599, 601                                                              |
| Processing instructions and CDATA are dropped                         | 2     | 180, 182                                                                        |
| The scheme's case is normalised (`MAILTO:` → `mailto:`)               | 1     | 597                                                                             |
| A relative URL containing a colon is rejected upstream                | 1     | 500                                                                             |

The first four groups are the product rather than defects: cmark copies raw
HTML to the output verbatim and this tool refuses to, because its output is
meant to be safe to paste somewhere that renders it.

### The 3 GFM examples that do not pass

- **279, 280 — task lists.** remark-gfm adds `class="task-list-item"` and
  `class="contains-task-list"`, which the spec text does not have and
  github.com does. Ours is closer to what GitHub actually serves.
- **628 — `ftp://` is not linkified.**
  `micromark-extension-gfm-autolink-literal@2.1.0` handles `http` and `https`
  only (`dev/lib/syntax.js:363`). Left alone: a second linkifier beside the
  first, duplicating its trailing-punctuation rules, is a poor trade for a
  scheme Chrome and Firefox both dropped in 2021.

## Mathematics

`$$ ... $$` is parsed as mathematics and preserved exactly, then written back
as a ` ```math ` fence — the spelling GitHub renders.

This matters because without it, Markdown's own backslash escapes eat LaTeX:
`\,` collapses to a comma and `\\`, the row separator in every
matrix, collapses to a single backslash. Language models emit display maths
constantly, so this was the commonest silent corruption in generated content.

**Single-dollar `$...$` is deliberately off.** With it on, "It costs $5 and
$10 today." became `It costs <code class="language-math">5 and </code>10
today.` — ordinary prose turned into mathematics. Money is far commoner in a
document than inline LaTeX, and a converter that corrupts prose to support the
minority case has the trade backwards. Inline `$x^2$` therefore survives as
literal text, which is what it was before.

Cost: **+5.7 kB raw, +1.4 kB gzipped**, in the lazily-loaded pipeline chunk.
KaTeX is a dependency of `micromark-extension-math` but only of its HTML
compiler, which nothing here imports — verified absent from the built output.

## The preview, and why it had no styling

Tables in the preview rendered without borders or padding, and columns
collapsed to their content. **The markup was never the problem.** Measured
against the real Content-Security-Policy, inside a real `sandbox=""` frame:

| Route                              | Result      |
| ---------------------------------- | ----------- |
| inline `<style>` block, unhashed   | blocked     |
| `style=""` attribute               | blocked     |
| `<link>` to this origin            | blocked     |
| inline `<style>` block, **hashed** | **renders** |
| the same block, one byte changed   | blocked     |

The first three are `style-src 'self'` doing its job. No `'unsafe-inline'`
means no style element and no style attribute — and a sandboxed frame has an
**opaque origin**, so `'self'` matches nothing and even our own stylesheet
cannot be fetched into it. There was no route by which any styling could reach
the preview.

The fix is a hash, and it is not a weakening: `script-src` already carries the
hash of the theme bootstrap for exactly this reason, and a hash permits one
byte sequence rather than a category. The fifth row is the proof — change a
byte and the browser refuses it.

`vite/plugins/csp-hash.ts` computes the sha256 of
[`preview.css`](../../features/toolrunner/preview.css) at build time and writes
it into `style-src`; `previewDocument.ts` imports the same file as a string.
Both normalise line endings first, so a CRLF checkout cannot produce a hash the
browser will not match. `pnpm check:browsers` asserts in both engines that the
stylesheet actually applies — not that it is present, but that a table cell's
computed border really is 1px.

The preview is styled to look like a **document**, close to how GitHub renders
Markdown, rather than like the instrument panel around it. It is always light,
in every theme: the line above it says "this is what Copy as rich text pastes",
and what it pastes into is light.

## Rich text: what actually goes on the clipboard

Both flavours were wrong.

**The HTML flavour was unstyled** — the tool's sanitised output verbatim. A
bare `<table>` has no borders in Word, which is the single commonest way a
rich-text paste disappoints.

A stylesheet would not fix it. Google Docs discards `<style>` blocks outright
and Outlook's Word engine ignores most of what it does not recognise; the one
thing all three honour is an inline `style` attribute. So **the clipboard
document carries its styling inline** — the opposite choice from the preview,
which must use a stylesheet because a `style` attribute is what its CSP
refuses. It is a complete `<!DOCTYPE html>` document with a declared charset,
because Word and Outlook read the payload as a document and will otherwise
guess the encoding.

Tables additionally carry `border="1" cellspacing="0" cellpadding="6"`.
Outlook's engine ignores border declarations in a pasted document often enough
that the attribute is what keeps the grid visible there, and `border-collapse`
stops the two doubling up anywhere else. Column alignment is written as a
declaration as well as an attribute, because Word honours `align=""` and
Google Docs does not.

**The plain flavour was the HTML source.** `copyRichText(html, html)` — so
every application that asked for `text/plain`, which is most of them, received
a wall of angle brackets. It is now a readable text rendering with heading
markers, real list numbers and checkbox state.

### Checking it against Word yourself

Everything assertable is asserted, but no test can paste into Word. Convert
[`clipboard-check.md`](clipboard-check.md) with **Target format: HTML**,
press **Copy as rich text**, and paste into each of Word, Google Docs and
Outlook. What to look at:

1. **The table has visible borders**, header shading, and the third column is
   right-aligned. This is the one that used to fail everywhere.
2. **The code block has a grey background** and a monospace font, and its
   indentation is intact.
3. **Nested list items stay nested**, and the ordered list starts at 3.
4. **Checkboxes survive** as checkboxes or as `[x]`/`[ ]`, not as blank space.
5. **The link is a link**, and the image's alt text is present.
6. **The em dash and the emoji are not mojibake** — that is the charset
   declaration doing its job.
7. Paste into a **plain-text** field as well (Notepad, a terminal): you should
   get readable text with `#` headings, not HTML source.

## Plain text: structure survives, syntax does not

That is the whole policy for both `→ Plain text` directions, and every
decision follows from it. Formatting goes — emphasis markers, link syntax,
fences, escaping, table pipes. Anything a reader needs in order to still
understand the shape of the document stays.

| Construct        | Becomes                                   | Why                                                                                              |
| ---------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Headings         | `## Heading`                              | Losing the hierarchy of a long document is worse than keeping one marker. Works past two levels. |
| Ordered lists    | `1.` `2.` `3.`, honouring `start`         | Rendering them as bullets was simply a bug.                                                      |
| Nested lists     | two spaces per level                      | Depth is structure.                                                                              |
| Task lists       | `[x]` / `[ ]`                             | The state is the information. Dropping it says the opposite half the time.                       |
| Code blocks      | indented four spaces                      | Indentation is layout; a fence is syntax.                                                        |
| Blockquotes      | `> `                                      | Without it a quotation silently becomes the author's own words.                                  |
| Tables           | aligned columns, ruled header             | See below.                                                                                       |
| Links            | `text (url)`, when the URL adds something | Suppressed when the URL equals the text, or is `mailto:` plus the text.                          |
| Images           | their alt text                            | The alt text is what an image says when it cannot be shown.                                      |
| Horizontal rules | `---`                                     |                                                                                                  |

**Tables became aligned columns, reversing an earlier choice.** They used to be
tab-separated, chosen so a table would survive a paste into a spreadsheet — but
this app has a structured-data tool that emits real CSV, and plain text is for
reading. A table whose columns no longer line up is much harder to read than
one that has merely lost its borders. A rule under the header shows where the
data starts.

Whitespace is normalised throughout: no trailing spaces on any line, never more
than one blank line, and a list item spanning several lines gets a blank line
after it while a one-line item stays tight against its neighbours.

## Known limitations

Every one of these is asserted in
[`hardening.test.ts`](hardening.test.ts) against its **current, wrong**
behaviour, so an upstream fix shows up as a failing test with the file and
line to go and delete.

### Upstream, with no clean fix from outside

**A space at the edge of a code span is dropped.** `<code> ab</code>` becomes
`` `ab` ``. `hast-util-to-mdast` runs `rehype-minify-whitespace` over the tree
before any handler sees it, so the space is gone before there is anything to
preserve it with. (The previous guess blamed the serialiser; the serialiser
pads correctly when given the right value.) Interior spaces are safe.

**A backslash immediately before inline markup is mangled.** `a\x<em>b</em>`
serialises as `a\&#x78;_b_`; read back, `\&` is an escaped ampersand, so the
character reference arrives as four visible characters instead of an `x`. The
serialiser encodes the `x` so the following `_` can open emphasis — correct in
isolation — but leaves the backslash bare. In `mdast-util-to-markdown`'s
`safe()`, which no configuration reaches. A backslash on its own is fine.

**`ftp://` is not linkified.** See the GFM section above.

### Deliberate, and the reason

**A `data:` image source is refused, so the picture does not survive.**
Considered and refused rather than overlooked. An SVG loaded through
`<img src>` is in secure static mode and cannot run script, so the payload
would be inert here — but this tool's output is HTML somebody pastes somewhere
else, and "inert in an `<img>`" is a fact about one element in one context.
The allow-list is worth more than the images. What was fixed instead is the
symptom: a rejected image now degrades to its alt text rather than to a broken
icon.

**Raw HTML is repaired, not passed through.** cmark copies unbalanced markup
to its output verbatim; this tool parses it, so `<a href="x">` with no closing
tag comes out closed. Ours is well-formed and theirs is not, which is the
right way round for output meant to be pasted somewhere.

**Emoji shortcodes are not expanded.** `:rocket:` stays `:rocket:`. Shortcode
expansion is a GitHub feature outside the GFM specification, and half-doing it
would be worse than not doing it.

**A document containing raw HTML needs two round trips to settle**, not one:
the first converts the raw HTML into Markdown, and the result is stable from
there. Measured across nine READMEs from well-known repositories — all nine
settle, none cycles.

## Libraries, sanitisation and the preview

Unchanged by the merge, and written up where they live:

- **[`src/lib/markup/sanitise.ts`](../../lib/markup/sanitise.ts)** — the
  allow-list, and why `rehype-sanitize` rather than DOMPurify: it is pure
  JavaScript over an already-parsed tree, so it runs in a Web Worker and there
  is no second parse for a mutation-XSS payload to disagree with.
- **[`src/lib/markup/pipelines.ts`](../../lib/markup/pipelines.ts)** — the
  unified/remark/rehype pipelines, the idempotent id namespacing, and the
  whitespace tidy that `rehype-raw` makes necessary.
- **[`src/features/toolrunner/HtmlView.tsx`](../../features/toolrunner/HtmlView.tsx)**
  — the `sandbox=""` `srcdoc` preview and the two-flavour clipboard write.

`presentation: 'html'` on the `rendered` output is what hangs the preview and
the rich-text copy off a fact rather than a guess. `rendered` is **always**
HTML: for a Markdown target it re-renders what was produced, which makes the
semantic-stability invariant visible — if the Markdown is faithful, it looks
like the HTML that went in.

## Migration

Saved canvases and shared links still name the old tools. Both are migrated,
not refused — see
[`retiredTools.ts`](../../features/canvas/retiredTools.ts).

| Old                      | New               |
| ------------------------ | ----------------- |
| `markdown`, `md-to-html` | `markdown → html` |
| `markdown`, `html-to-md` | `html → markdown` |
| `html-text`, `markdown`  | `html → markdown` |
| `html-text`, `text`      | `html → text`     |
