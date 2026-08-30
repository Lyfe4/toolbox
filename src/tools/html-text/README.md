# HTML to text

HTML → Markdown, or HTML → plain text. The one-way counterpart to the
[Markdown](../markdown/README.md) tool, for the case that actually comes up:
something copied out of a page, an email or a CMS that needs to become text a
human or a diff can read.

## Libraries

The same unified pipeline as the Markdown tool — `rehype-parse`,
`rehype-sanitize`, `rehype-remark`, `remark-gfm`, `remark-stringify` — for the
same reason: it is pure JavaScript over a syntax tree, so it runs in a Web
Worker where Turndown and DOMPurify cannot. The rationale is written up once,
in the [Markdown README](../markdown/README.md#the-libraries-and-why).

Plain-text extraction is a small hand-written walk over the sanitised tree
rather than `hast-util-to-text` alone, because the options here — keeping link
URLs, choosing a list marker, deciding what a table becomes — are presentation
decisions a generic extractor has no opinion about.

## Sanitisation

Input is sanitised **before anything reads it**, including for the plain-text
mode where the output carries no markup at all. Two reasons: a `<script>` body
would otherwise be dumped into the text as its own source code, and the text of
an element the allow-list rejects is not content anybody asked to read.

That is what the schema's `strip` list is for. `hast-util-sanitize`'s default
for a disallowed element is to keep its children — right for `<font>`, wrong
for `<script>`, where unwrapping would delete the tag and leave `alert(1)`
sitting in the output as visible text.

## No preview, no rich-text copy

This tool's output is never HTML, so its output port carries no
`presentation: 'html'` hint and gets neither affordance. There would be nothing
to preview and nothing to paste as formatted text.

Chain it into the Markdown tool if you want to see the result rendered — that
pairing is exactly what the **Clean up pasted HTML** preset does.

## Options

| Option                        | Mode       | Notes                                                                                                          |
| ----------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------- |
| `mode`                        | —          | Markdown or plain text.                                                                                        |
| `bullet`, `emphasis`, `fence` | → Markdown | As the Markdown tool.                                                                                          |
| `unsupported`                 | → Markdown | Defaults to `text`, not `keep`: someone converting HTML to Markdown is trying to get _away_ from the HTML.     |
| `keepLinkUrls`                | → text     | Writes the URL in brackets after the link text, and only when it adds something the text does not already say. |
| `listMarker`                  | → text     | `-`, `*`, or none.                                                                                             |
| `tables`                      | → text     | Tab-separated rows, or dropped. Tabs because that is what survives a paste into a spreadsheet.                 |

The Markdown `strong` delimiter is deliberately not offered here. This tool has
one job, and every extra control is one more thing between a paste and a
result.

## Invariants

Asserted with `fast-check`:

- **Idempotent to text.** Plain text is valid HTML input, so re-running must be
  a no-op — otherwise the tool mangles its own output the second time.
- **Stable to Markdown.** HTML in, Markdown out, rendered back to HTML,
  converted again reaches the same Markdown.
- **Never emits markup** from the text converter.

The Markdown property is deliberately _not_ `htmlToMarkdown(htmlToMarkdown(x))`.
That would feed Markdown back in as HTML, where `# Title` is a paragraph
beginning with a hash — so the converter correctly escapes it to `\# Title` and
the two differ. It would be testing a confusion between the two languages
rather than a property of either.
