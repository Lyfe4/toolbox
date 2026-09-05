import { describe, expect, it } from 'vitest';

import { PREVIEW_STYLESHEET, previewDocument } from '@/features/toolrunner/previewDocument';
import { richTextDocument, richTextPlain } from '@/features/toolrunner/richText';

import { htmlToMarkdown, htmlToText, markdownToHtml } from './pipelines';

/**
 * THE CATALOGUE OF REAL FAILURES.
 *
 * Every case here was found by running something real through the converter -
 * the CommonMark and GFM specs, nine READMEs from well-known repositories,
 * Markdown of the shape a language model writes, and HTML pasted out of Word,
 * Google Docs and an email client. None of it was invented to fill a section.
 *
 * Each case says what it caught. That is the point of the file: a future
 * contributor should be able to read it as a description of what goes wrong
 * with this kind of software, and a failure here should name the bug rather
 * than just the assertion.
 *
 * Organised by cause, not by feature:
 *
 *   1. Content loss - things that silently deleted the user's document
 *   2. URLs - destinations dropped, rewritten, or wrongly trusted
 *   3. Identifiers - anchors and ARIA references that stopped pointing at
 *      anything
 *   4. Round-tripping - shapes that did not survive the return journey
 *   5. Mathematics
 *   6. Markdown as a language model writes it
 *   7. HTML as the world actually supplies it
 *   8. Known limitations, asserted so that fixing one is noticed
 *   9. The preview document and the clipboard payload
 */

const HTML = { headingIds: false, linkify: true } as const;
const HTML_IDS = { headingIds: true, linkify: true } as const;
const MD = {
  bullet: '-',
  emphasis: '_',
  strong: '*',
  fence: '`',
  setext: false,
  unsupported: 'keep',
} as const;
const MD_TEXT = { ...MD, unsupported: 'text' } as const;
const TEXT = { keepLinkUrls: true, listMarker: '-', tables: 'rows' } as const;

const LF = String.fromCharCode(10);
const BACKSLASH = String.fromCharCode(92);
const FENCE = '```';

/** md → html → md, the journey every one of these is really about. */
const roundTrip = (markdown: string, options = MD): string =>
  htmlToMarkdown(markdownToHtml(markdown, HTML), options);

/* ========================================================================== *
 * 1. CONTENT LOSS
 * ========================================================================== */

describe('content loss', () => {
  /*
   * THE WORST BUG THIS PASS FOUND, and it was invisible from the spec suite.
   *
   * `<title>`, `<style>`, `<textarea>` and `<xmp>` are RCDATA or RAWTEXT
   * elements: the HTML parser stops looking for tags inside them and swallows
   * everything up to a closing tag that a Markdown author never wrote. So a
   * single stray `<title>` in prose ate the rest of the paragraph.
   *
   * Fixed by implementing GFM's tagfilter, which escapes these tags rather
   * than letting the parser see them. Now they appear as text, where the
   * author put them.
   */
  it('does not let a stray <title> swallow the rest of the line', () => {
    const out = markdownToHtml('a <title> b <em>c</em> d' + LF, HTML);

    expect(out).toContain('<em>c</em>');
    expect(out).toContain('d');
    // The tag survives as visible text rather than as a parser instruction.
    expect(out).toContain('title');
  });

  it('does not let <style> delete the words after it', () => {
    // Before: "a <style> b" produced "<p>a </p>". The " b" was simply gone.
    expect(markdownToHtml('a <style> b' + LF, HTML)).toContain('b');
  });

  it.each(['textarea', 'xmp', 'iframe', 'noembed', 'noframes', 'plaintext', 'script'])(
    'escapes <%s> rather than letting it eat the document',
    (tag) => {
      const out = markdownToHtml(`before <${tag}> after` + LF, HTML);

      expect(out).toContain('before');
      expect(out).toContain('after');
    },
  );

  it('leaves ordinary tags alone', () => {
    // The filter is nine names, not a general suspicion of angle brackets.
    expect(markdownToHtml('a <em>b</em> c' + LF, HTML)).toContain('<em>b</em>');
  });
});

/* ========================================================================== *
 * 2. URLS
 * ========================================================================== */

describe('urls', () => {
  /*
   * Schemes are case-insensitive per RFC 3986; the sanitiser's allow-list is
   * compared literally. `<MAILTO:FOO@BAR.BAZ>` is a link CommonMark requires,
   * and it was arriving with no destination at all.
   */
  it('keeps the destination of an upper-case scheme', () => {
    const out = markdownToHtml('<MAILTO:FOO@BAR.BAZ>' + LF, HTML);

    expect(out).toContain('href="mailto:FOO@BAR.BAZ"');
    // Only the scheme is lowercased. The rest of a URL is case-sensitive.
    expect(out).toContain('FOO@BAR.BAZ');
  });

  it('still refuses the schemes that matter, whatever their case', () => {
    for (const source of [
      '[x](javascript:alert(1))',
      '[x](JAVASCRIPT:alert(1))',
      '[x](JaVaScRiPt:alert(1))',
      '[x](data:text/html;base64,PHNjcmlwdD4=)',
      '[x](DATA:text/html,<script>alert(1)</script>)',
      '[x](vbscript:msgbox(1))',
    ]) {
      const out = markdownToHtml(source + LF, HTML);

      expect(out).not.toContain('href');
      expect(out).not.toContain('script>');
    }
  });

  /*
   * When the allow-list rejects an href, hast-util-sanitize removes the
   * attribute and leaves the element - so `[docs](irc://x)` rendered as
   * `<a>docs</a>`: something announced as a link, that goes nowhere, and that
   * came back as the empty destination `[docs]()`.
   */
  it('unwraps a link whose destination was rejected, rather than leaving a dead one', () => {
    const out = markdownToHtml('[docs](irc://example.org/room)' + LF, HTML);

    expect(out).toContain('docs');
    expect(out).not.toContain('<a');

    // And the Markdown that comes back is text, not `[docs]()`.
    expect(roundTrip('[docs](irc://example.org/room)' + LF)).not.toContain('[docs]()');
  });

  it('leaves relative and fragment destinations alone', () => {
    expect(markdownToHtml('[a](./b/c.html)' + LF, HTML)).toContain('href="./b/c.html"');
    expect(markdownToHtml('[a](../up.md)' + LF, HTML)).toContain('href="../up.md"');
    expect(markdownToHtml('[a](tel:+15551234)' + LF, HTML)).toContain('href="tel:+15551234"');
  });
});

/* ========================================================================== *
 * 3. IDENTIFIERS
 * ========================================================================== */

describe('identifiers', () => {
  /*
   * Author ids are namespaced so that an `id="location"` cannot shadow a
   * global wherever the output is pasted. The naive version rewrote every
   * fragment link to match - including links to ids the document does not
   * define, which turned a working anchor into a dead one.
   *
   * Found by CommonMark example 501.
   */
  it('does not rewrite a fragment link when nothing here answers to it', () => {
    const out = markdownToHtml('[jump](#elsewhere)' + LF, HTML);

    expect(out).toContain('href="#elsewhere"');
    expect(out).not.toContain('user-content');
  });

  it('does rewrite one when the target is in this document', () => {
    const out = markdownToHtml('# Setup' + LF + LF + '[jump](#setup)' + LF, HTML_IDS);

    expect(out).toContain('id="user-content-setup"');
    expect(out).toContain('href="#user-content-setup"');
  });

  /*
   * `aria-describedby` is a space-separated token list, so hast parses it into
   * an ARRAY - which the string-only branch skipped. The id it pointed at was
   * renamed and the reference was not, leaving a footnote whose description
   * pointed at nothing: a dangling reference in the one place a screen reader
   * needs a working one.
   */
  it('namespaces ARIA reference lists along with the ids they point at', () => {
    const out = markdownToHtml('Text[^1]' + LF + LF + '[^1]: Note.' + LF, HTML);

    expect(out).toContain('id="user-content-footnote-label"');
    expect(out).toContain('aria-describedby="user-content-footnote-label"');
    // The footnote's own anchors still line up too.
    expect(out).toContain('href="#user-content-fn-1"');
    expect(out).toContain('id="user-content-fn-1"');
  });

  it('is idempotent, so converting twice does not grow the prefix', () => {
    const once = markdownToHtml('Text[^1]' + LF + LF + '[^1]: Note.' + LF, HTML);
    const twice = markdownToHtml(htmlToMarkdown(once, MD), HTML);

    expect(twice).not.toContain('user-content-user-content');
  });
});

/* ========================================================================== *
 * 4. ROUND-TRIPPING
 * ========================================================================== */

describe('round-tripping', () => {
  /*
   * FOUND BY ROUND-TRIPPING REMARK'S OWN README.
   *
   * `unsupported: 'keep'` serialised a whole `<details>` subtree as one raw
   * HTML string. A CommonMark HTML block ends at the first BLANK LINE, and a
   * fenced code block inside `<details>` contains blank lines - so the block
   * was cut in half and its second half re-parsed as paragraphs, losing the
   * fence and the indentation.
   *
   * Block elements are now written as opening tag, real Markdown, closing tag.
   */
  it('keeps a fenced code block inside <details> a fenced code block', () => {
    const source =
      '<details>' +
      LF +
      '<summary>Show</summary>' +
      LF +
      LF +
      FENCE +
      'js' +
      LF +
      'const a = 1;' +
      LF +
      LF +
      '  return a;' +
      LF +
      FENCE +
      LF +
      LF +
      '</details>' +
      LF;

    const once = roundTrip(source);
    const twice = roundTrip(once);

    expect(once).toContain('<details>');
    expect(once).toContain(FENCE + 'js');
    // The blank line inside the code survives, which is the whole point.
    expect(once).toContain('  return a;');
    expect(twice).toBe(once);
  });

  it('keeps an inline element inline', () => {
    // Inline phrasing cannot contain a blank line, so there is nothing to
    // split and splitting would only make the Markdown uglier.
    expect(roundTrip('Press <kbd>Esc</kbd> now' + LF)).toContain('<kbd>Esc</kbd>');
  });

  /*
   * hast-util-to-mdast@10.1.2 lib/handlers/list.js tests `properties.start`
   * for truthiness, so the one value that is falsy - zero - is the one it
   * drops. Worked around by correcting the default handler's answer.
   */
  it('keeps an ordered list that starts at zero', () => {
    expect(htmlToMarkdown('<ol start="0"><li>a</li></ol>', MD)).toBe('0. a' + LF);
  });

  it.each([
    ['3', '3. a'],
    ['1', '1. a'],
    ['12', '12. a'],
  ])('keeps a list starting at %s', (start, expected) => {
    expect(htmlToMarkdown(`<ol start="${start}"><li>a</li></ol>`, MD)).toBe(expected + LF);
  });

  it('still numbers a list with no start attribute from one', () => {
    expect(htmlToMarkdown('<ol><li>a</li></ol>', MD)).toBe('1. a' + LF);
  });
});

/* ========================================================================== *
 * 5. MATHEMATICS
 * ========================================================================== */

describe('mathematics', () => {
  /*
   * Without math parsing, `$$ ... $$` is ordinary paragraph text and Markdown's
   * backslash escapes eat the LaTeX: every `\,` `\;` `\!` became bare
   * punctuation, and `\\` - the row separator in every matrix - became a
   * single backslash.
   */
  it('preserves LaTeX escapes in block math', () => {
    const source = '$$' + LF + BACKSLASH + 'int_0^1 x' + BACKSLASH + ',dx' + LF + '$$' + LF;
    const out = markdownToHtml(source, HTML);

    expect(out).toContain(BACKSLASH + 'int_0^1');
    expect(out).toContain(BACKSLASH + ',dx');
  });

  it('preserves the row separator in a matrix', () => {
    const source = '$$' + LF + 'a & b ' + BACKSLASH + BACKSLASH + LF + 'c & d' + LF + '$$' + LF;

    expect(markdownToHtml(source, HTML)).toContain(BACKSLASH + BACKSLASH);
  });

  it('round-trips block math as a math fence, which is what GitHub renders', () => {
    const source = '$$' + LF + 'x^2' + LF + '$$' + LF;

    expect(roundTrip(source)).toBe(FENCE + 'math' + LF + 'x^2' + LF + FENCE + LF);
  });

  /*
   * WHY SINGLE-DOLLAR INLINE MATH IS OFF. With it on, this paragraph became
   * `It costs <code class="language-math">5 and </code>10 today.` - ordinary
   * prose silently turned into mathematics. Money is far commoner in a
   * document than inline LaTeX, and a converter that corrupts prose to support
   * a minority case has the trade backwards.
   */
  it('leaves money alone', () => {
    for (const source of [
      'It costs $5 and $10 today.',
      'Between $5 and $10 there is a gap.',
      'Prices: $1, $2, $3.',
      'Pay $20 now or $30 later.',
    ]) {
      const out = markdownToHtml(source + LF, HTML);

      expect(out).not.toContain('math');
      // The paragraph arrives exactly as written, dollars and all.
      expect(out).toBe(`<p>${source}</p>`);
    }
  });

  it('leaves shell variables alone', () => {
    expect(markdownToHtml('Run `echo $HOME` and `$PATH`.' + LF, HTML)).not.toContain('math');
    expect(markdownToHtml(FENCE + 'sh' + LF + 'echo $A $B' + LF + FENCE + LF, HTML)).not.toContain(
      'language-math',
    );
  });
});

/* ========================================================================== *
 * 6. MARKDOWN AS A LANGUAGE MODEL WRITES IT
 * ========================================================================== */

describe('generated markdown', () => {
  it('keeps a fenced code block inside a nested list item', () => {
    const source =
      '1. First' +
      LF +
      '   - sub' +
      LF +
      LF +
      '     ' +
      FENCE +
      'js' +
      LF +
      '     const a = 1;' +
      LF +
      '     ' +
      FENCE +
      LF;
    const out = markdownToHtml(source, HTML);

    expect(out).toContain('<code class="language-js">');
    expect(out).toContain('const a = 1;');
    // Still inside the nested list rather than escaping to the top level.
    expect(out.indexOf('<ul>')).toBeLessThan(out.indexOf('<code class="language-js">'));
  });

  it('keeps a fence that contains backticks', () => {
    const source = '````' + LF + 'Use ' + FENCE + 'code' + FENCE + ' here' + LF + '````' + LF;

    expect(markdownToHtml(source, HTML)).toContain('Use ' + FENCE + 'code' + FENCE + ' here');
    // Coming back, the fence has to grow again or the content escapes.
    expect(roundTrip(source)).toContain('````');
  });

  it('accepts a tilde fence and keeps its language', () => {
    const source = '~~~python' + LF + 'print("x")' + LF + '~~~' + LF;

    expect(markdownToHtml(source, HTML)).toContain('language-python');
  });

  it('keeps an escaped pipe inside inline code inside a table cell', () => {
    const source = '| a | b |' + LF + '| - | - |' + LF + '| `x' + BACKSLASH + '|y` | n |' + LF;
    const out = markdownToHtml(source, HTML);

    // One cell containing `x|y`, not two cells split on the pipe.
    expect(out).toContain('<code>x|y</code>');
    expect(out.match(/<td>/g)).toHaveLength(2);
  });

  it('keeps a task list nested in a blockquote nested in a list', () => {
    const source = '- item' + LF + '  > - [ ] todo' + LF + '  > - [x] done' + LF;
    const out = markdownToHtml(source, HTML);

    expect(out).toContain('<blockquote>');
    expect(out).toContain('type="checkbox"');
    expect(out).toContain('checked');
    expect(roundTrip(source)).toContain('> - [x] done');
  });

  it('reads tab-indented nesting the same as space-indented', () => {
    const tabbed = '- a' + LF + '\t- b' + LF + '\t\t- c' + LF;
    const spaced = '- a' + LF + '  - b' + LF + '    - c' + LF;

    expect(markdownToHtml(tabbed, HTML)).toBe(markdownToHtml(spaced, HTML));
  });

  it('passes emoji through, as shortcodes and as characters', () => {
    // GFM does not specify shortcode expansion - that is a GitHub feature
    // outside the spec - so `:rocket:` must survive as written rather than
    // being half-translated.
    expect(markdownToHtml('Ship it :rocket:' + LF, HTML)).toContain(':rocket:');
    expect(markdownToHtml('Ship it \u{1F680}' + LF, HTML)).toContain('\u{1F680}');
    expect(roundTrip('Ship it :rocket: \u{1F680}' + LF)).toContain(':rocket:');
  });

  it.each([
    ['trailing double space', 'a  ' + LF + 'b' + LF],
    ['trailing backslash', 'a' + BACKSLASH + LF + 'b' + LF],
  ])('makes a hard break from a %s', (_name, source) => {
    expect(markdownToHtml(source, HTML)).toContain('<br>');
  });

  it('keeps inline code and links inside headings', () => {
    expect(markdownToHtml('## The `run()` function' + LF, HTML)).toContain(
      '<h2>The <code>run()</code> function</h2>',
    );
    expect(markdownToHtml('## See [docs](https://x.dev)' + LF, HTML)).toContain(
      '<a href="https://x.dev">docs</a>',
    );
  });

  it('keeps two fenced blocks with no blank line between them apart', () => {
    const source =
      FENCE + 'js' + LF + 'a' + LF + FENCE + LF + FENCE + 'py' + LF + 'b' + LF + FENCE + LF;
    const out = markdownToHtml(source, HTML);

    expect(out).toContain('language-js');
    expect(out).toContain('language-py');
    expect(out.match(/<pre>/g)).toHaveLength(2);
  });

  it('survives six levels of mixed nesting', () => {
    const source =
      '- a' +
      LF +
      '  - b' +
      LF +
      '    - c' +
      LF +
      '      - d' +
      LF +
      '        1. e' +
      LF +
      '           > quote' +
      LF;
    const out = markdownToHtml(source, HTML);

    expect(out).toContain('<blockquote>');
    expect(out).toContain('<ol>');
    expect(roundTrip(source)).toContain('> quote');
  });
});

/* ========================================================================== *
 * 7. HTML AS THE WORLD SUPPLIES IT
 * ========================================================================== */

describe('html from real sources', () => {
  /*
   * GOOGLE DOCS WRAPS EVERY PASTE in `<b style="font-weight:normal">` - a bold
   * that explicitly asks not to be bold. Converted naively, every word of a
   * pasted document came out `**bold**`.
   */
  it('does not bold an entire Google Docs paste', () => {
    const paste =
      '<b style="font-weight:normal" id="docs-internal-guid-1">' +
      '<p dir="ltr"><span style="font-size:11pt">Doc text </span>' +
      '<span style="font-weight:700">bold</span></p></b>';
    const out = htmlToMarkdown(paste, MD_TEXT);

    expect(out).toContain('Doc text');
    expect(out).not.toBe('**Doc text bold**' + LF);
  });

  it('still bolds a genuine bold', () => {
    expect(htmlToMarkdown('<p>a <b>real</b> bold</p>', MD_TEXT)).toContain('**real**');
    expect(htmlToMarkdown('<p><strong>strong</strong></p>', MD_TEXT)).toContain('**strong**');
  });

  it('does not mistake a vendor property for a weight declaration', () => {
    /*
     * `mso-bidi-font-weight: normal` is Word's, says nothing about the visual
     * weight, and appears on text that IS bold. An unanchored match on
     * "font-weight" therefore unwrapped genuine bolds - which this caught.
     */
    expect(
      htmlToMarkdown('<p><b style="mso-bidi-font-weight:normal">w</b></p>', MD_TEXT),
    ).toContain('**w**');
    // And the real declaration is still recognised, wherever it sits.
    expect(
      htmlToMarkdown('<p><b style="color:red; font-weight:normal">w</b></p>', MD_TEXT),
    ).not.toContain('**w**');
  });

  it('reduces a rendered page of div and span soup to its words', () => {
    const soup =
      '<div class="wrap"><div class="row"><span style="font-weight:700">Bold</span>' +
      ' and <span class="x">plain</span></div></div>';

    expect(htmlToMarkdown(soup, MD_TEXT).trim()).toBe('Bold and plain');
  });

  it('survives a Word paste with its conditional comments and MSO attributes', () => {
    const word =
      '<!--[if gte mso 9]><xml><w:WordDocument></w:WordDocument></xml><![endif]-->' +
      '<p class="MsoNormal" style="margin:0in"><span style="font-family:Calibri">' +
      'Hello <b style="mso-bidi-font-weight:normal">world</b></span></p>';
    const out = htmlToMarkdown(word, MD_TEXT);

    expect(out).toContain('Hello');
    expect(out).toContain('**world**');
    expect(out).not.toContain('WordDocument');
  });

  it('gets the content out of a table-based email layout', () => {
    const email =
      '<table width="100%"><tr><td align="center"><table><tr><td>' +
      '<h1>Newsletter</h1><p>Hello there.</p></td></tr></table></td></tr></table>';

    // The layout is not recoverable and does not matter; the words are.
    expect(htmlToText(email, TEXT)).toContain('Newsletter');
    expect(htmlToText(email, TEXT)).toContain('Hello there.');
  });

  it('reads minified HTML with no whitespace at all', () => {
    const minified = '<h1>T</h1><p>A <b>b</b> c</p><ul><li>x</li><li>y</li></ul>';

    expect(htmlToMarkdown(minified, MD_TEXT)).toBe(
      '# T' + LF + LF + 'A **b** c' + LF + LF + '- x' + LF + '- y' + LF,
    );
  });

  it.each([
    ['unclosed tags', '<p>One<p>Two<div>Three', ['One', 'Two', 'Three']],
    ['mismatched nesting', '<b><i>text</b></i>', ['text']],
    ['a stray closing tag', 'lead</div></p><p>after</p>', ['lead', 'after']],
  ])('recovers the content from %s', (_name, source, expected) => {
    const out = htmlToMarkdown(source, MD_TEXT);

    for (const word of expected) expect(out).toContain(word);
  });
});

/* ========================================================================== *
 * 9. THE PREVIEW AND THE CLIPBOARD
 * ========================================================================== */

describe('the preview document', () => {
  /*
   * THE PREVIEW HAD NO STYLING AT ALL, and the cause was not the markup.
   *
   * Measured against the real policy in a real `sandbox=""` frame: an inline
   * <style>, a style="" attribute and a <link> to this origin are all refused
   * - the last because a sandboxed frame has an OPAQUE ORIGIN, where 'self'
   * matches nothing. So tables had no borders because no stylesheet could
   * reach the frame by any route, not because a rule was missing.
   *
   * A hashed <style> block is the way through, and `check:browsers` asserts
   * the frame actually renders styled in both engines.
   */
  it('carries its stylesheet inline, since nothing can be fetched into the frame', () => {
    const out = previewDocument('<p>x</p>');

    expect(out.startsWith('<meta charset="utf-8"><style>')).toBe(true);
    expect(out).toContain('<p>x</p>');
    expect(out).not.toContain('<link');
  });

  it('styles every element the sanitiser allows', () => {
    // A rule for each, so an element added to the allow-list without a rule
    // shows up here rather than as something that renders unstyled.
    for (const selector of [
      'table',
      'th',
      'td',
      'caption',
      'blockquote',
      'pre',
      'kbd',
      'sub',
      'sup',
      'abbr[title]',
      'mark',
      'ins',
      'small',
      'figure',
      'figcaption',
      'dt',
      'dd',
      'details',
      'summary',
      'hr',
      'img',
      'h1',
      'h6',
    ]) {
      expect(PREVIEW_STYLESHEET).toContain(selector);
    }
  });

  it('honours the alignment attribute GFM writes onto cells', () => {
    // Without these the preview shows every column left-aligned, whatever the
    // table said.
    expect(PREVIEW_STYLESHEET).toContain("td[align='right']");
    expect(PREVIEW_STYLESHEET).toContain("td[align='center']");
  });

  it('hides the footnote label remark expects a host stylesheet to hide', () => {
    // remark marks it `sr-only` and leaves the hiding to whoever renders it.
    // Nothing here would, so it rendered as a stray "Footnotes" heading.
    expect(PREVIEW_STYLESHEET).toContain('.sr-only');
  });
});

describe('the rich-text clipboard payload', () => {
  const TABLE =
    '<table><thead><tr><th align="right">n</th></tr></thead>' +
    '<tbody><tr><td align="right">1</td></tr></tbody></table>';

  /*
   * A STYLESHEET WOULD NOT DO. Google Docs discards <style> blocks outright
   * and Outlook's Word engine ignores most of what it does not recognise; the
   * one thing all three honour is an inline style attribute. So the clipboard
   * document is the opposite choice from the preview, which uses a stylesheet
   * because a style attribute is what its CSP refuses.
   */
  it('inlines the styling rather than linking a stylesheet', () => {
    const out = richTextDocument(TABLE);

    expect(out).toContain('border-collapse:collapse');
    expect(out).toContain('border:1px solid');
    expect(out).not.toContain('<style');
    expect(out).not.toContain('<link');
  });

  it('is a complete document with a declared charset', () => {
    // Word and Outlook read the payload as a document and will guess an
    // encoding if none is declared, which is how an em dash becomes mojibake.
    const out = richTextDocument('<p>a — b</p>');

    expect(out.startsWith('<!DOCTYPE html><html><head><meta charset="utf-8">')).toBe(true);
    expect(out.endsWith('</body></html>')).toBe(true);
    expect(out).toContain('—');
  });

  it('carries the legacy table attributes Outlook still needs', () => {
    // Outlook's engine ignores border declarations in a pasted document often
    // enough that the attribute is what keeps the grid visible there.
    expect(richTextDocument(TABLE)).toContain('border="1"');
  });

  it('keeps column alignment as a declaration, not only an attribute', () => {
    // Word honours align=""; Google Docs does not. Both get a declaration.
    expect(richTextDocument(TABLE)).toContain('text-align:right');
  });

  it('escapes text and attribute values', () => {
    const out = richTextDocument('<p title="a&quot;b">1 &#x3C; 2 &#x26; 3</p>');

    expect(out).toContain('1 &lt; 2 &amp; 3');
    expect(out).toContain('title="a&quot;b"');
  });

  it('writes void elements without a closing tag', () => {
    expect(richTextDocument('<p>a<br>b</p>')).toContain('<br');
    expect(richTextDocument('<p>a<br>b</p>')).not.toContain('</br>');
  });

  it('leaves code untouched inside pre', () => {
    const out = richTextDocument('<pre><code>a\n  b\n</code></pre>');

    expect(out).toContain('a\n  b');
    expect(out).toContain('white-space:pre-wrap');
  });

  /*
   * THE PLAIN FLAVOUR USED TO BE THE HTML SOURCE. `copyRichText(html, html)`,
   * so every application that asked for text/plain - which is most of them -
   * got a wall of angle brackets.
   */
  it('gives readable text as the plain-text flavour, not markup', () => {
    const out = richTextPlain('<h2>Title</h2><p>Body <strong>text</strong>.</p>');

    expect(out).not.toContain('<');
    expect(out).toContain('## Title');
    expect(out).toContain('Body text.');
  });

  it('keeps list numbering, nesting and checkbox state in the plain flavour', () => {
    const out = richTextPlain(
      '<ol start="3"><li>a<ul><li>b</li></ul></li></ol>' +
        '<ul class="contains-task-list"><li class="task-list-item">' +
        '<input type="checkbox" checked disabled> done</li></ul>',
    );

    expect(out).toContain('3. a');
    expect(out).toContain('  - b');
    expect(out).toContain('[x] done');
  });

  it('does not repeat a mailto URL that is already the link text', () => {
    expect(richTextPlain('<p><a href="mailto:a@b.c">a@b.c</a></p>')).toBe('a@b.c');
    expect(richTextPlain('<p><a href="https://x.dev">docs</a></p>')).toBe('docs (https://x.dev)');
  });
});

/* ========================================================================== *
 * 8. KNOWN LIMITATIONS
 * ========================================================================== */

describe('known limitations', () => {
  /*
   * These assert the CURRENT, WRONG behaviour on purpose.
   *
   * Each is an upstream defect with no clean fix from outside the dependency,
   * and each is written up in the tool's README. Asserting them means that if
   * an upstream release fixes one, this suite says so - loudly, with the file
   * and line to go and delete.
   */
  it('KNOWN: drops a space at the edge of a code span', () => {
    /*
     * hast-util-to-mdast runs `rehype-minify-whitespace` over the tree before
     * any handler sees it, so the leading space is gone before there is
     * anything to preserve it with. Not the serialiser, which was the previous
     * guess: the serialiser pads correctly when given the right value.
     */
    expect(htmlToMarkdown('<p><code> ab</code></p>', MD)).toBe('`ab`' + LF);
    // Interior spaces are safe; it is only the edges.
    expect(htmlToMarkdown('<p><code>a b</code></p>', MD)).toBe('`a b`' + LF);
  });

  it('KNOWN: mangles a backslash immediately before inline markup', () => {
    /*
     * The serialiser writes the `x` as a character reference so that the
     * following `_` can open emphasis - correct in isolation - but leaves the
     * backslash bare, so `\&#x78;` reads back as an escaped ampersand.
     * mdast-util-to-markdown's `safe()`; no configuration reaches it.
     */
    expect(htmlToMarkdown('<p>a' + BACKSLASH + 'x<em>b</em></p>', MD)).toContain('&#x78;');
    // A backslash on its own is fine, which is what makes this narrow.
    expect(htmlToMarkdown('<p>a' + BACKSLASH + 'x b</p>', MD)).toBe('a' + BACKSLASH + 'x b' + LF);
  });

  it('KNOWN: does not linkify a bare ftp:// URL', () => {
    // micromark-extension-gfm-autolink-literal covers http and https only.
    expect(markdownToHtml('See ftp://foo.bar.baz for files.' + LF, HTML)).not.toContain('<a');
    expect(markdownToHtml('See https://foo.bar for files.' + LF, HTML)).toContain('<a');
  });

  it('KNOWN: refuses a data: image source, so the picture does not survive', () => {
    /*
     * Considered and refused rather than overlooked. An SVG loaded through
     * `<img src>` is in secure static mode and cannot run script, so the
     * payload would be inert HERE - but this tool's output is HTML somebody
     * pastes somewhere else, and "inert in an <img>" is a fact about one
     * element in one context. The allow-list is worth more than the images.
     *
     * The symptom that prompted looking at it was fixed instead: the image
     * degrades to its alt text rather than to a broken icon.
     */
    const out = markdownToHtml('![a dot](data:image/gif;base64,R0lGOD)' + LF, HTML);

    expect(out).not.toContain('data:');
    expect(out).toContain('a dot');
    expect(out).not.toContain('<img');
  });

  it('KNOWN: needs a second pass to settle a document containing raw HTML', () => {
    /*
     * Raw HTML normalises to its Markdown spelling on the first round trip, so
     * a document that starts with raw HTML reaches its fixed point on the
     * second rather than the first. Measured across nine real READMEs: all
     * nine settle, none cycles.
     */
    const source = '<div align="center">' + LF + LF + '**hi**' + LF + LF + '</div>' + LF;
    const one = roundTrip(source);
    const two = roundTrip(one);
    const three = roundTrip(two);

    expect(two).toBe(three);
  });
});
