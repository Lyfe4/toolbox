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

Three are **defects**, all upstream of anything here, all narrow, all recorded
rather than papered over:

- **A list starting at zero renumbers to one.** `start` survives for every
  other value.
- **A backslash immediately before inline markup is mangled.** The serialiser
  writes `a\&#x78;_b_`, and `\&` reads back as an escaped ampersand, so the
  character reference arrives as four visible characters instead of an `x`.
- **A space at the edge of a code span is dropped.** `<code> ab</code>`
  becomes `` `ab` ``, though CommonMark can express it as `` `  ab ` ``.

Working around any of the three would mean regex-editing the serialiser's
output, which is how one narrow bug becomes an unbounded number of them.

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
