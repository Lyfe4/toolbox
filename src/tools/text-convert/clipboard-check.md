# Clipboard check

Paste this into the text-convert tool, set **Target format** to **HTML**, press
**Run**, then press **Copy as rich text** on the _Rendered HTML_ output.

Paste the result into Word, Google Docs and Outlook. What to look for is listed
in [the README](README.md#checking-it-against-word-yourself); items 1 to 6
below correspond to its first six. Item 7 here has no entry there, and the
README's seventh is the plain-text paste at the end of this file.

---

## 1. Table with borders and alignment

| Algorithm    | Burst | Cost |
| :----------- | :---: | ---: |
| Fixed window | poor  | O(1) |
| Sliding log  | exact | O(n) |
| Token bucket | good  | O(1) |

Every cell should have a visible border. The header row should be shaded and
bold. **Burst** should be centred and **Cost** right-aligned.

## 2. Code, block and inline

Set the limit with `rate: 10`, then:

```ts
function refill(bucket: Bucket, rate: number): void {
  const now = Date.now();

  bucket.tokens = Math.min(rate, bucket.tokens + elapsed * rate);
}
```

The block should have a grey background, a monospace font, and its indentation
and blank line intact. `rate: 10` should be monospace too.

## 3. Nested lists, starting at three

3. First step, numbered three.
   - A nested bullet.
     - And a deeper one.
4. Second step.

The numbering must start at 3, and both levels of nesting must survive.

## 4. Task list

- [x] Bucket state defined
- [ ] Refill implemented
  - [x] Handles idle buckets
  - [ ] Handles clock skew

Checked and unchecked items must be distinguishable — as real checkboxes, or as
`[x]` and `[ ]`. Blank space in front of every item means the state was lost.

## 5. Links, images and quotes

See [the specification](https://spec.commonmark.org/0.31.2/) or email
<ops@example.org>.

![A red dot](https://example.org/dot.png)

> A blockquote, which should keep its left bar or its indentation.

## 6. Encoding

An em dash —, a non-breaking space in 25 °C, “curly quotes”, a rocket 🚀
and H<sub>2</sub>O. None of these should arrive as mojibake, and the space in
25 °C should not break across a line.

## 7. Everything else the allow-list permits

Press <kbd>Ctrl</kbd>+<kbd>C</kbd>. <mark>Highlighted</mark>, <ins>inserted</ins>,
<small>small</small>, <abbr title="HyperText Markup Language">HTML</abbr>, and
<time datetime="2026-01-01">New Year</time>.

<dl>
<dt>Token</dt>
<dd>A unit of permission.</dd>
</dl>

---

Then paste into a **plain-text** field — Notepad, a terminal, a chat box that
does not render formatting. You should get readable text with `#` headings,
`1.` numbering, `[x]` checkboxes and aligned table columns. If you get HTML
source, the `text/plain` flavour is broken.
