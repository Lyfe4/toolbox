# Markdown

Markdown ⇄ HTML, both directions, GitHub Flavoured.

## The libraries, and why

**[unified](https://unifiedjs.com) — remark for Markdown, rehype for HTML.**
Specifically `remark-parse`, `remark-gfm`, `remark-rehype`, `rehype-raw`,
`rehype-sanitize`, `rehype-slug`, `rehype-stringify` on the way out, and
`rehype-parse`, `rehype-remark`, `remark-stringify` on the way back.

The obvious alternative was `marked` + `turndown` + `DOMPurify`, which is
smaller and more widely used. It was ruled out for a reason that has nothing to
do with either:

> **Turndown and DOMPurify both need a DOM.** Turndown ships
> `@mixmark-io/domino` to get a `document`; DOMPurify describes itself as
> "DOM-only" and needs jsdom outside a browser. These tools accept up to 4 MB
> of markup, so they run in a **Web Worker** — where there is no `document` at
> all.

unified is pure JavaScript over a syntax tree, so it runs anywhere. That turned
a constraint into an advantage for the sanitiser in particular: see
[Sanitisation](#sanitisation).

The secondary reason is correctness. remark implements CommonMark and GFM
against their specifications and is the parser behind most of the Markdown
anyone has actually read. Hand-rolling a Markdown parser was never on the
table.

## Round-tripping: what is guaranteed and what is not

**Markdown → HTML → Markdown is not byte-identical, and chasing that would be a
mistake.** `*em*` and `_em_` both produce `<em>`, so exactly one of them
survives the journey back. The same is true of bullet characters, fence
characters, heading style, and whether a link was written inline or as a
reference. Recording the original syntax in the HTML so it could be restored is
not what HTML is for.

Two properties do hold, and both are asserted with `fast-check` over documents
assembled from real Markdown constructs:

| Property               | Statement                                                            |
| ---------------------- | -------------------------------------------------------------------- |
| **Idempotence**        | Converting twice produces the same output as converting once.        |
| **Semantic stability** | `md → html → md → html` produces byte-identical HTML to `md → html`. |

Semantic stability is the one that matters: it says the _meaning_ survives even
though the spelling does not.

### The one documented exception: footnotes are one-way

`md → html` renders GFM footnotes properly — a `<sup>` reference and a
`<section data-footnotes>` holding the definitions. Coming **back**,
`rehype-remark` has no handler that recognises that structure as footnotes, so
the reference degrades into an ordinary link and the definition block becomes a
plain heading and list. Rebuilding `[^1]:` syntax would mean writing a handler
that pattern-matches GitHub's exact markup.

What does hold is that it **settles**: one round trip loses the structure and
every round trip after that changes nothing. That fixed point is asserted
directly in `markdown.test.ts`, and footnotes are excluded from the
semantic-stability arbitrary rather than the property being weakened for
everything else.

## Two bugs the property tests found

Both were in identifier handling, and neither would have been found by an
example-based test.

**The clobber prefix was not idempotent.** `hast-util-sanitize` namespaces
author-supplied identifiers by prefixing `id` and `name` with `user-content-`,
which stops markup defining `id="location"` shadowing a global wherever the
output is pasted. It prefixes whatever it finds — _including an id that already
carries the prefix_. So `user-content-fn-1` became
`user-content-user-content-fn-1` on the next pass, and grew another prefix
every pass after that. That is exactly what semantic stability is for.

**It never touched `href`.** An id renamed to `user-content-fn-1` left every
link to `#fn-1` pointing at nothing — every footnote reference and every
heading anchor was broken.

Both are fixed by turning the built-in clobbering off and doing it in
`namespaceIds()`, which prefixes only if not already prefixed and moves
fragment hrefs to match. One owner, applied once, ids and links agreeing.

## Sanitisation

See [`src/lib/markup/sanitise.ts`](../../lib/markup/sanitise.ts) for the schema
and [`sanitise.test.ts`](../../lib/markup/sanitise.test.ts) for the vectors.

The short version:

- **`rehype-sanitize`**, an allow-list applied to an **already-parsed tree**.
  It never sees a string of HTML, so it never has to decide what a malformed
  tag "means" — which closes the whole mutation-XSS family by construction
  rather than by pattern-matching. There is no second parse to disagree with
  the first.
- The schema is **GitHub's own `defaultSchema`, narrowed**. Nothing is added:
  no tag, no attribute, no protocol. An allow-list is only worth having if
  changes to it are subtractions.
- **Both directions.** Markdown can carry raw HTML blocks, so the output side
  needs it as much as the input side.

`allowDangerousHtml` plus `rehype-raw` is what lets an HTML block inside
Markdown be parsed as markup instead of escaped — which is what GitHub does and
what anyone converting a README expects. It is safe **only because**
`rehypeSanitize` runs immediately afterwards, which is why the two are written
together in `markdownToHtml`.

## Options

`direction` picks the way round. The rest only mean something in one direction,
and each label says which:

| Option               | Direction  | Notes                                                                                                |
| -------------------- | ---------- | ---------------------------------------------------------------------------------------------------- |
| `headingIds`         | → HTML     | Adds `id` to headings. Namespaced `user-content-`.                                                   |
| `linkify`            | → HTML     | GFM turns a bare `https://` or `www.` into a link.                                                   |
| `bullet`             | → Markdown | `-`, `*` or `+`.                                                                                     |
| `emphasis`, `strong` | → Markdown | `_` or `*`.                                                                                          |
| `fence`              | → Markdown | Backticks or tildes. Always fenced, never indented — an indented block cannot carry a language hint. |
| `headingStyle`       | → Markdown | Setext only reaches two levels; h3 and below stay ATX regardless.                                    |
| `unsupported`        | → Markdown | What to do with markup Markdown cannot express.                                                      |

`linkify` needed implementing rather than configuring: `remark-gfm` bundles
autolink literals with tables, footnotes, strikethrough and task lists, and
dropping the plugin to lose one of five is not a trade worth making. Instead
the tree is corrected afterwards, and the test is the **source text** — by the
time parsing is done, `https://x` written bare, as `<https://x>`, and as
`[https://x](https://x)` are three identical link nodes. What distinguishes
them is the character the node starts at in the original document, which is
what `position` records.

`unsupported` is handled per element, because `hast-util-to-mdast` registers
handlers by tag name and has no catch-all. The list is exactly the intersection
of "allowed through the sanitiser" and "no Markdown equivalent" — checked
against the schema rather than guessed. Elements like `<abbr>` and `<mark>` are
not in it because they are not in the allow-list at all, and have already been
unwrapped to their text before the option is consulted.

## Outputs

Two, and the second is not redundant:

- **`output`** — the conversion in whichever direction was asked for. This is
  what chains onward.
- **`rendered`** — **always** HTML. Going `md → html` it is the same string;
  going `html → md` it is the produced Markdown rendered back to HTML.

Every declared output must be produced, so a port that only _sometimes_ carries
HTML cannot be typed. Making one that always does is what lets
`presentation: 'html'` be a fact rather than a guess — and the preview pane and
"copy as rich text" hang off that fact. It also makes the semantic-stability
invariant visible: if the Markdown this tool produced is faithful, `rendered`
looks like the HTML that went in.

## The preview

A sandboxed `<iframe>` with `sandbox=""` — the empty string, which applies
_every_ restriction, not a missing attribute, which applies none. No
`allow-scripts`, so nothing runs; no `allow-same-origin`, so it is an opaque
origin that cannot reach this page. The pair matters more than either alone:
`allow-scripts` **with** `allow-same-origin` would let framed content remove
its own sandbox attribute, which is the classic escape.

Populated by `srcdoc`, so there is no URL, no request, and nothing for
`connect-src 'none'` to make an exception for. It renders the **sanitised
output**, never the raw input.

Source is the default view. This is a developer tool and the markup is what
most people came for.

It renders on a plain white surface rather than the current theme, and that is
a consequence of the isolation rather than an oversight: an opaque-origin frame
cannot be handed our stylesheet or our custom properties. Theming it would mean
inlining a stylesheet into content the user did not write, or relaxing the
sandbox. Neither is worth it for a colour, and a plain document is arguably the
more honest preview of how it will look wherever it is pasted.
