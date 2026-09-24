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

The pairs that remain are all meaningful:

|              | → HTML (sanitised) | → HTML (normalised)    | → Markdown | → Plain text       |
| ------------ | ------------------ | ---------------------- | ---------- | ------------------ |
| **Markdown** | render             | render                 | reformat   | render, then strip |
| **HTML**     | sanitise           | sanitise and normalise | convert    | strip              |

`markdown → markdown` and `html → html` are not no-ops: they run the full
pipeline, so they reformat to your chosen conventions and sanitise
respectively.

**TWO HTML TARGETS, BECAUSE THEY ARE TWO OPERATIONS.** Normalising takes an
HTML source out to Markdown and back, which is what tidies real-world markup -
and which bounds the result by what Markdown can express. A `<div>` is
unwrapped, an `<img width>` is dropped, and a `<table>` written without a header
row **gains an empty one**, because a Markdown table always has one. Sanitising
alone invents nothing.

The control offered one word for both and performed the one that invents. Both
report what they removed, measured by comparing the documents rather than by
listing the schema - which is how three claims in
[docs/conversion-matrix.md](../../../docs/conversion-matrix.md#found-this-round)
turned out to be wrong.

From a MARKDOWN source the two are the same string, and have to be: HTML
produced from Markdown has already been through Markdown, so there is no round
trip left to make.

## Auto-detection

Conservative in a specific sense: it would rather **admit it is assuming** than
assert something it cannot support. The failure it is built to avoid is not
"picked the less likely option" but "said Markdown _with confidence_ about a
fragment of HTML", because the user then has no reason to look at the source
control.

It reports what it concluded on the `detected` output, with a confidence and a
reason — `markdown (confident) - Found an ATX heading.` — so a wrong guess is
visible rather than silent.

A fourth output, `report`, carries a different question: not what format was
read, but what the conversion changed or invented on the way out. It is a
`report`-presented port, so `ReportView` draws it on `/tools` and a canvas node
prints its `warn`-level notes on its own face — which is what makes a loss told
rather than merely available.

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

### Code is not markup, and this is most of what gets pasted

The tag search at step 1 ran over the document **as written**, so the contents
of a code span decided the format of the document around it:

```
Use `<div>` here.        ->   html (confident) - Found the HTML tag <div>.
```

That is a sentence about HTML, which is most of what anybody writes about HTML
and nearly all of what an LLM writes about it. The conversion that followed
read the code span's contents as markup: the backticks became literal text and
the element they quoted was parsed away, so a paragraph came back with the one
thing it was about missing from it. Nothing failed, and `confident` is exactly
what stops a reader checking the source control.

Fenced blocks and inline code spans are blanked out before the tag search now,
and **only** before that search — a fence is itself a Markdown signal, so step 2
still reads the document as written. A document that quotes a tag _and_ is HTML
(`<p>Use \`<div>\` here.</p>`) is still HTML.

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
| `tables`             | Plain text           | Aligned columns with a ruled header, or dropped.                                     |

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

Two more are **upstream defects**, with one cause — `mdast-util-to-markdown`'s
`safe()` escaping correctly for the construct in front of it: a backslash before
inline markup, and text escaped into something GFM then linkifies as an email
address (`|7*P*@Oj.EK` comes back as a `mailto:` link). Both are written up
under [Known limitations](#known-limitations). The second used to be a space at
the edge of a code span, which has since been fixed from outside the dependency
(see [Whitespace inside code](#whitespace-inside-code)).

A third used to be here: **a list starting at zero renumbered to one.** That
one now has a fix. `hast-util-to-mdast@10.1.2` tests `properties.start` for
truthiness, so zero — the one falsy number — was the one value it dropped; the
default handler is now called and its answer corrected. Delete `orderedList`
in `pipelines.ts` when upstream reads the property rather than testing it.

### A table cell cannot contain a line

A GFM row ends at the first newline, so nothing a cell holds may serialise to
more than one line. `<td><ul><li>one</li><li>two</li></ul></td>` used to
produce exactly that:

```
| h           |
| ----------- |
| - one
- two |
```

which re-parses as a one-row table, a stray `<ul>` and a lost `|`. A `<pre>` in
a cell was worse: the fence's newlines produced three extra rows and an empty
code block tagged `|`.

The cause is upstream and upstream says so. `hast-util-to-mdast`'s cell handler
is `state.all(node)` cast to `PhrasingContent[]`, with the comment _"Allow
potentially 'invalid' nodes, they might be unknown"_ — so a `<td>` containing a
`<ul>` really does produce a `tableCell` with a `list` inside it, and the
serialiser writes a list the only way it can.

**The answer was already in the cell path, for `<br>`.** A hard break in a cell
comes out as a SPACE, because `mdast-util-to-markdown`'s break handler asks
whether a newline is legal in the construct it is in and substitutes one when
it is not. The block handlers never ask. So the cell's children are flattened
to real phrasing before any of them is reached: the content survives, joined by
a space where a line break used to be, and the structure is what goes.

| Cell content                        | Now         |
| ----------------------------------- | ----------- |
| `<ul><li>one</li><li>two</li></ul>` | `one two`   |
| `<p>one</p><p>two</p>`              | `one two`   |
| `<pre>a⏎b</pre>`                    | `` `a b` `` |
| `<blockquote>q</blockquote>`        | `q`         |
| `a<hr>b`                            | `a b`       |
| `a<br>b`                            | `a b`       |

A block becomes a code span where it was code, because that is CommonMark's own
rule for a span and what this tool already does for a `<code>` whose text has a
line in it. A `thematicBreak` has no content to keep, and the boundary it
marked still becomes a space.

**What the cell loses is reported.** The `<ul>` and `<li>` are in the sanitised
document and in neither the Markdown nor the HTML it re-renders to, so the
change report names them. The fix stops the document rendering wrongly; the
report says what it cost.

**It does not consult the `unsupported` option, and that is a decision.** All
three values produce byte-identical output here, which is asserted — because
`unsupported` governs elements with no Markdown spelling at all, and a list has
one. It is just not one that fits in a cell. Making `keep` mean raw `<ul>`
markup inside a cell is a question about a construct GFM does not define and
only some renderers accept, and it is open rather than answered.

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
| [CommonMark 0.31.2](https://spec.commonmark.org/0.31.2/)                 | 652   | **624 (95.7%)** |
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

### The 28 CommonMark examples that do not pass

Every one is about raw HTML or about a URL. **None is about emphasis, lists,
tables, code, headings or any other Markdown construct** — which is asserted
directly, so a failure appearing in another section is a parser problem rather
than a policy one.

| Cause                                                                 | Count | Examples                                                               |
| --------------------------------------------------------------------- | ----- | ---------------------------------------------------------------------- |
| The sanitiser removed an element or attribute the spec passes through | 22    | 150, 152–154, 163, 164, 169–173, 176, 178, 201, 491, 524, 536, 613–617 |
| URL scheme not in the allow-list                                      | 4     | 596, 598, 599, 601                                                     |
| The scheme's case is normalised (`MAILTO:` → `mailto:`)               | 1     | 597                                                                    |
| A relative URL containing a colon is rejected upstream                | 1     | 500                                                                    |

The first two groups are the product rather than defects: cmark copies raw
HTML to the output verbatim and this tool refuses to, because its output is
meant to be safe to paste somewhere that renders it.

This section said 612 (93.9%) and 40 until HTML comments stopped being dropped.
That took twelve examples off the list: the seven comments; 180 and 182, a
processing instruction and a CDATA section, which an HTML parser represents as
comment nodes; and 627–629 from the sanitiser row, for the same reason. The
list in [`conformance.test.ts`](../../lib/markup/conformance.test.ts) is exact,
so the numbers here are the ones it asserts.

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

**A hard break is a line break, not a paragraph break**, and that took a fix.
Markdown's two spellings — two trailing spaces, and a trailing backslash — both
become `<br>` followed by a newline, because that is how the HTML serialiser
lays the element out. The renderer emitted one newline for the element and a
second for the newline in the text node after it, so a hard break came out with
a BLANK LINE in it. The same `<br>` written without the newline —
`<p>a<br>b</p>`, which is what hand-written HTML and a paste from a rich-text
editor look like — came out correctly as one break. One construct, two
spellings, two different answers, and the wrong one was the spelling Markdown
produces.

## Whitespace inside code

A blank line in a code block is a line of the program. So is a trailing space,
and so is the second space in `` `a  b` ``. This section exists because a bug
report said blank lines were being dropped in fenced blocks, and running it
down found three different losses — none of them the one reported.

### What was reported did not reproduce

Markdown → HTML keeps the blank line, in every spelling of the document there
is: backtick and tilde fences, with and without a language, indented four
spaces instead, inside a list, inside a blockquote, with CRLF line endings,
with spaces or a tab on the blank line, and with no trailing newline. Fifteen
variants, all measured, all correct. That direction was never broken, and the
reported document itself is now pinned in `hardening.test.ts` so it cannot
break quietly; the other spellings were measured once and are not all pinned —
the indented block and a `<pre>` arriving as HTML are.

### What did

**Two blank lines in a row became one, in the plain-text output.**
`htmlToText` finished by running `.replace(/\n{3,}/g, '\n\n')` over the whole
string. Between blocks that is exactly right — it is what stops a heading and a
list drifting apart. Inside a program it destroys a line. `tidyWhitespace`,
fifty lines further up the same file, carries a comment explaining that it
walks the tree rather than running a regex over the finished string "because a
regex could not tell the newlines between two table rows from the ones inside a
fenced code block". The same mistake, made again below it.

**A document that opened with a code block lost the indent on its first line
only.** The same post-processing ended with `.trim()`, which acts on the ends of
the document — and a leading code block is at one. Line one came out flush
against the margin with every line after it indented four spaces, which looks
like the code is broken rather than the converter.

Both are fixed by rendering each code block once, replacing it with a marker,
running the tidy-up, and substituting the blocks back. The marker is U+0000,
which is safe by construction rather than by hope: the HTML tokenizer disposes
of every NUL in character data, so no tree this code sees can contain one.
Every path parses HTML first, the Markdown one included. The substitution uses
a replacer **function**, not a replacement string, because `$&` in a shell
snippet is exactly what turns up inside a code block here.

**A trailing blank line inside a fence was lost on the way back to Markdown**,
and **a run of spaces inside a code span was collapsed**. Both upstream, and
both fixed from outside the dependency:

- `hast-util-to-mdast`'s code handler runs `trimTrailingLines`, which strips
  every trailing newline where mdast wants exactly one removed — the one that
  mdast-to-hast adds when it renders a fence. So the block came back one line
  shorter each time.
- It also runs `rehype-minify-whitespace` before any handler is consulted, and
  whitespace sensitivity there is a `switch` on tag name: `<pre>` is in it, a
  bare inline `<code>` is not. `<code>a  b</code>` arrived at the handler
  already collapsed.

Neither has an option. Both are reachable anyway, because `toMdast` minifies a
**clone** — the original tree is still there, and the clone keeps `position`,
which is a reliable identity for a parsed node. The pipeline records code text
off the real tree on the way past and hands it back to a handler that would
otherwise have to trust the clone. Same mechanism `stripAutolinkLiterals` uses.
A node with no position falls through to the default, so the worst case is the
old behaviour rather than a crash.

A line ending inside a code span still becomes a single space. That is not a
loss: a code span cannot contain a line break, so CommonMark has no spelling
for one.

### And one that reproduces, and is CommonMark

A `<pre>` written inside a **single-line `<details>`** really is cut in half at
the blank line:

```html
<details>
  <summary>s</summary>
  <pre><code>a

b</code></pre>
</details>
```

A raw HTML block opened by a tag other than `pre`, `script`, `style` or
`textarea` ends at the first blank line — CommonMark's HTML block condition 6.
[Example 148](https://spec.commonmark.org/0.31.2/#example-148) mandates exactly
this shape of damage, cmark-gfm does it, GitHub does it, and the conformance
suite already asserts this tool matches. Diverging would mean failing the spec
on purpose.

The document-level fix is the one every README uses: a blank line after the
`</summary>`, and the fence on its own lines.

````markdown
<details>
<summary>s</summary>

```ts
a;

b;
```
````

</details>
```

That form survives intact, and is asserted next to the broken one.

## `<details>` and the unsupported option

Converting `<details><summary>…</summary>…</details>` to Markdown with the
default settings returns the summary text and the body and drops both tags.
That is the `Markup Markdown cannot express` option doing what it says, not a
defect — but the loss is real and worth naming, because `<details>` is the one
element in that list where dropping the tag drops **meaning**. A collapsed
section stops being collapsed.

| Setting                 | `<details>`                             |
| ----------------------- | --------------------------------------- |
| Keep as inline HTML     | survives exactly, and reads back        |
| Keep the text (default) | the words survive, the fold does not    |
| Drop it entirely        | the element and its content are removed |

**The default stays `text`,** and the reason is in the git history rather than
in taste: `keep` writes a container element back as inline HTML, so a document
wrapped in a single `<div>` — which is every Word and Google Docs paste —
converted to itself. A default that is wrong for pasted HTML is worse than one
that is lossy for `<details>`, and `keep` is one control away.

`keep` is genuinely lossless here, not merely verbose: a block element is
written as its opening tag, its children as **real Markdown**, and its closing
tag, so a fenced code block inside `<details>` stays a fenced code block.

**`text` means text for every element on the list, from round thirteen.** It
used to register nothing and fall through to hast-util-to-mdast's defaults, on
the belief that they keep the words and drop the wrapper. For eight elements
they substitute instead: `<mark>` became `_emphasis_`, `<kbd>`, `<samp>` and
`<var>` became code spans, a definition list became bullets, and `<q>` wrote
quotation marks into the text. Under a policy labelled _Keep the text, drop the
tag_, that is formatting the source never had (TC-4, corpus row 17). Now each
becomes its words, and the census names the element that went. Choose `keep`
for `<kbd>` as a key cap; it is written back verbatim.

## Known limitations

The upstream ones are asserted against their **current, wrong** behaviour —
in [`hardening.test.ts`](../../lib/markup/hardening.test.ts), and the email
address in `constructs.test.ts` — so an upstream fix shows up as a failing test
with the file and line to go and delete. Of the deliberate ones, `data:`, the
emoji and the second round trip are asserted in `hardening.test.ts`, and
`<ol reversed>` and the class names in `normalisation.test.ts`. Two are asserted
nowhere: the missing `alt` (TC-11) and the backslash spelling of a hard break.
This paragraph used to say every one was in `hardening.test.ts`.

### Upstream, with no clean fix from outside

**A backslash immediately before inline markup is mangled.** `a\x<em>b</em>`
serialises as `a\&#x78;_b_`; read back, `\&` is an escaped ampersand, so the
character reference arrives as four visible characters instead of an `x`. The
serialiser encodes the `x` so the following `_` can open emphasis — correct in
isolation — but leaves the backslash bare. In `mdast-util-to-markdown`'s
`safe()`, which no configuration reaches. A backslash on its own is fine.

**Prose can be escaped into an email address.** Serialising
`|7<em>P</em>@Oj.EK` writes the `7` and the `P` as character references so the
`_` can open and close emphasis, and the result contains `_@Oj.EK`, which GFM's
autolink literals then read as an address: one round trip turns prose into a
`mailto:` link. The same `safe()`, again unreachable by configuration.

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

**An `<img>` with no `alt` is not given `alt=""` on HTML (sanitised).** An
empty alt is a claim that the image is decorative — a screen reader skips it —
and only the author knows that; adding it would hide an undescribed image from
exactly the people alt text is for. The other two targets do add one, because
`![](x)` has no spelling for "no alt", and nothing says so yet. (TC-11,
decided in round thirteen; the second half is recorded as open.)

**A hard line break is written as a trailing backslash.** CommonMark and GFM
both define it. The alternative, two trailing spaces, is invisible and is the
thing editors and linters strip; raw `<br>` trades a renderer question for an
HTML-in-Markdown one. Renderers that predate CommonMark will show the
backslash. (TC-12.)

**`<ol reversed>` survives the sanitiser, and cannot survive Markdown.**
`reversed` is a boolean with no URL, no script and no style, and it is
content: it decides the numbers a reader sees. So `HTML (sanitised)` keeps it.
CommonMark numbers every list upward from its first item, so on the other two
targets the list counts up, and the note says so rather than only naming the
attribute. (TC-3.)

**A class name the sanitiser filters is reported.** On seven elements the
schema allows `class` with permitted values only, and takes every other name
out of the attribute while keeping it — `<a class="btn">` becomes
`<a class="">`. The census counted names and could not see it; it now carries
class names per element and says which went (corpus row 16).

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

**That value is also the change report's third document**, which is why it is
computed once and handed to both. Comparing an HTML source with the HTML its
Markdown renders back to is exactly what `HTML → HTML (normalised)` compares,
so the Markdown target gets the same measured report for no extra conversion —
and the port and the report cannot disagree about what the output renders to,
because there is one string. For an HTML source it is the sanitised source, and
[for a while it was not](#the-four-outputs-and-the-input-that-was-too-narrow).

## The four outputs, and the input that was too narrow

| Port       | Label         | Type        | For                                                     |
| ---------- | ------------- | ----------- | ------------------------------------------------------- |
| `input`    | Document      | text, bytes | Markdown or HTML, detected unless you say otherwise.    |
| `output`   | Converted     | text        | The conversion, in whichever format `target` names.     |
| `rendered` | Rendered HTML | text        | Always sanitised HTML: the preview and rich-text copy.  |
| `detected` | Detected      | text        | What auto-detection concluded, and how sure it was.     |
| `report`   | Report        | json        | What the conversion changed or invented on the way out. |

`report` was added in round three and is a different question from `detected`:
not what format was READ, but what the conversion did to it. It is a
`report`-presented port, so `ReportView` draws it on the tool page and a canvas
node prints its `warn`-level notes on its own face.

**A fourth port rather than reshaping `detected` into it.** Changing that port's
data type from `text` to `json` would make every existing edge out of it
illegal, and `firstRefusedEdge` refuses the WHOLE document - so a share link
with `detected → hash` would stop opening rather than degrade. A new port breaks
nothing.

The [port audit](../../../docs/architecture.md#the-port-set) asked how
`Converted` differed from `Rendered HTML` when the target is HTML. The answer
was two separate things.

### `rendered` promised sanitised HTML and handed back the input

Nothing in `pipelines.ts` produced sanitised HTML from HTML. `markdownToHtml`
sanitises the HTML _it_ generates; `htmlToMarkdown` and `htmlToText` sanitise
on the way to something that is not HTML. So the hub value — which is what
`rendered` carries for every target but Markdown — was the input string
untouched whenever the source was HTML. Measured:

```
in:  <p onclick="alert(1)">hi<script>alert(2)</script></p>
out: <p onclick="alert(1)">hi<script>alert(2)</script></p>
```

Nothing ever ran. The preview is an `<iframe sandbox="">` — no scripting, an
opaque origin — so the markup was inert there, then and now. What did happen is
that the string went onto the clipboard through **Copy as rich text** and out
of the port into whatever node was wired to it, which are the two places where
the port's stated promise is all anybody has to go on.

`sanitiseHtml` in `pipelines.ts` fixes it, and it is `markdownToHtml`'s own
chain from `normaliseSchemes` onwards — the same allow-list in the same plugin
order, because two sanitisers with two answers is worse than one with the wrong
answer: only one of them ever gets reviewed. `output` is byte-identical either
way, since all three conversion pipelines already sanitised internally. It was
only the port that was wrong.

The two paths differ in one visible way, and it is not the allow-list: GFM's
tagfilter runs on the Markdown path only, where it **escapes** a `<script>`
into visible text rather than deleting it. That is the spec's behaviour and the
fix for an unclosed raw-text tag eating the rest of the document. Here the
input already is HTML, a real parser has handled it, and the sanitiser deletes
the element and its content. Neither leaves anything executable; one leaves the
tag legible as words.

### `output` and `rendered` coincide for HTML targets, and cannot be made not to

With a Markdown source and either HTML target the two ports are the same string,
because converting a document to HTML and rendering it are the same operation.
No definition of `rendered` can differ from `output` there. The same holds for
an HTML source with the **HTML (sanitised)** target, which is the sanitised
source and nothing else — exactly what `rendered` carries. This section used to
name one target; there are three combinations. Both alternatives
cost more:

- **One port, presented as HTML only when the target is HTML.**
  `OutputPort.presentation` is static data in the eager manifest, and
  `registry.test.ts` compares manifest ports to implementation ports with a
  structural equality a function property cannot pass — so "presented as HTML
  sometimes" is not expressible without giving that test up. Unconditional
  would draw Markdown output in an HTML preview.
- **A port that appears only for the targets where it differs.** Ports that
  come and go as options change was rejected when the port model was written,
  for a better reason than this one: a node whose shape moves under you while
  you are wiring it.

Losing the preview and the rich-text copy for the other two targets is a much
larger cost than one duplicated string. So the ports stay as they are and the
coincidence is stated on `rendered`'s own description, which the Ports panel
now shows, rather than left for someone to find by reading two identical text
boxes.

In the other five combinations they differ, and `html → html` is the
interesting one: `output` is the normalising round trip through Markdown, so it
drops markup Markdown cannot express, where `rendered` is the source with
nothing but the sanitiser applied. A `<div>` survives on one port and not the
other. Two genuinely different answers to two genuinely different questions.

### `detected` was considered for removal and kept

Nobody would sensibly wire a sentence about a guess into another tool, and that
is the test this project applies to a port occupying a socket on a 224px node.
It stays because the alternative is a wrong guess that is invisible, and this
tool guesses on every run by default. There is nowhere else for an advisory
note to go: a `ToolResult` is a value or an error, with no channel for "I think
this was Markdown, and I am not certain". Reshaping it as a `report`-presented
JSON port, which is how `image-convert` handles the same problem, would make it
properly wireable and no more wired, for one sentence written for a person.

Its label was **Detected source**, fifteen characters in an 84px box.

### The input accepts bytes

It declared `types: ['text']`, so base64's decoded output — which is `bytes` —
had no legal wire into it, and **"decode this payload and clean up the HTML
inside it" was a pipeline the canvas could not express**. A mail body is the
obvious case; a dropped `.md` or `.html` file is the other.
`structured-data` had already widened its own document port for exactly this
reason and recorded that refusing bytes "made the most obvious pipeline in the
product impossible". This tool is the same shape and had not had the same fix.

Bytes decode **strictly**, through [`lib/text.ts`](../../lib/text.ts), so a PNG
on that port says it is not text rather than being converted from mojibake into
a confident, well-formed document about content nobody wrote. That is the
condition on widening a port at all.

The label is **Document**, the same word `structured-data` uses, because the
two tools are the same shape — a source, a target and auto-detection — and a
port called Input says nothing a socket does not already say. There is a
`decode-and-clean` preset that exists only because of this change.

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
