import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { htmlToMarkdown, htmlToText, markdownToHtml } from '@/lib/markup/pipelines';

import { htmlTextDefaultOptions } from './options';

const TO_MD = {
  bullet: '-',
  emphasis: '_',
  strong: '*',
  fence: '`',
  setext: false,
  unsupported: 'text',
} as const;
const TO_TEXT = { keepLinkUrls: true, listMarker: '-', tables: 'rows' } as const;

describe('HTML → Markdown', () => {
  it('converts structure rather than stripping it', () => {
    const out = htmlToMarkdown(
      '<h2>Title</h2><p>Some <strong>bold</strong> and <em>italic</em>.</p><ul><li>one</li><li>two</li></ul>',
      TO_MD,
    );

    expect(out).toContain('## Title');
    expect(out).toContain('**bold**');
    expect(out).toContain('_italic_');
    expect(out).toContain('- one');
  });

  it('keeps a table as a GFM table', () => {
    const out = htmlToMarkdown(
      '<table><thead><tr><th>a</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>',
      TO_MD,
    );

    expect(out).toContain('| a |');
    expect(out).toContain('| 1 |');
  });

  it('keeps a code block and its language', () => {
    const out = htmlToMarkdown('<pre><code class="language-js">const a = 1;</code></pre>', TO_MD);

    expect(out).toContain('```js');
    expect(out).toContain('const a = 1;');
  });

  it('survives the messy markup a CMS produces', () => {
    // Unclosed tags, stray attributes, nesting a validator would reject. The
    // HTML parser recovers from all of it, which is the point of using one.
    const out = htmlToMarkdown(
      '<div><p>One<p>Two<ul><li>a<li>b</ul><b>bold<i>both</b>italic</i></div>',
      TO_MD,
    );

    expect(out).toContain('One');
    expect(out).toContain('Two');
    expect(out).toContain('- a');
    expect(out).toContain('- b');
  });
});

describe('HTML → plain text', () => {
  it('keeps the words and drops the markup', () => {
    const out = htmlToText('<h1>Title</h1><p>Hello <strong>world</strong>.</p>', TO_TEXT);

    expect(out).toContain('Title');
    expect(out).toContain('Hello world.');
    expect(out).not.toContain('<');
  });

  it('writes link URLs in brackets, when asked and when they add something', () => {
    const withUrls = htmlToText('<p><a href="https://example.com">Docs</a></p>', TO_TEXT);
    const without = htmlToText('<p><a href="https://example.com">Docs</a></p>', {
      ...TO_TEXT,
      keepLinkUrls: false,
    });

    expect(withUrls).toContain('Docs (https://example.com)');
    expect(without).toBe('Docs');
  });

  it('does not repeat a URL that is already the link text', () => {
    const out = htmlToText('<p><a href="https://example.com">https://example.com</a></p>', TO_TEXT);

    expect(out).toBe('https://example.com');
  });

  it.each([
    ['-', '- one'],
    ['*', '* one'],
  ] as const)('uses %s as the list marker', (listMarker, expected) => {
    expect(htmlToText('<ul><li>one</li></ul>', { ...TO_TEXT, listMarker })).toContain(expected);
  });

  it('omits list markers when set to none', () => {
    const out = htmlToText('<ul><li>one</li></ul>', { ...TO_TEXT, listMarker: 'none' });

    expect(out).toContain('one');
    expect(out).not.toContain('-');
  });

  it('renders a table as tab-separated rows, or drops it', () => {
    const table =
      '<table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>';

    // Tabs, because that is what survives a paste into a spreadsheet.
    expect(htmlToText(table, TO_TEXT)).toContain('a\tb');
    expect(htmlToText(table, TO_TEXT)).toContain('1\t2');
    expect(htmlToText(table, { ...TO_TEXT, tables: 'drop' })).toBe('');
  });

  it('turns a line break into a line break', () => {
    expect(htmlToText('<p>one<br>two</p>', TO_TEXT)).toBe('one\ntwo');
  });

  it('never leaves a run of more than one blank line', () => {
    const out = htmlToText('<div><div><div><p>a</p></div></div></div><p>b</p>', TO_TEXT);

    expect(/\n{3,}/.test(out)).toBe(false);
  });
});

describe('invariants', () => {
  const htmlArb = fc
    .array(
      fc.constantFrom(
        '<h1>Title</h1>',
        '<p>Some text.</p>',
        '<ul><li>one</li><li>two</li></ul>',
        '<ol><li>first</li></ol>',
        '<blockquote><p>quoted</p></blockquote>',
        '<pre><code>code();</code></pre>',
        '<p><a href="https://example.com">link</a></p>',
        '<table><tr><td>cell</td></tr></table>',
        '<p><strong>bold</strong> <em>italic</em></p>',
        '<hr>',
      ),
      { minLength: 1, maxLength: 6 },
    )
    .map((parts) => parts.join(''));

  it('is stable: rendering the Markdown and converting again changes nothing', () => {
    /*
     * NOT `htmlToMarkdown(htmlToMarkdown(x))`. That would feed Markdown back
     * in as HTML, where `# Title` is a paragraph beginning with a hash - so
     * the converter correctly escapes it to `\# Title` and the two differ. It
     * would be testing a confusion between the two languages, not a property.
     *
     * The meaningful loop is through the renderer: HTML in, Markdown out,
     * rendered back to HTML, converted again. That must reach the same
     * Markdown, or the pair of tools disagrees about what the document says.
     */
    fc.assert(
      fc.property(htmlArb, (source) => {
        const once = htmlToMarkdown(source, TO_MD);
        const again = htmlToMarkdown(
          markdownToHtml(once, { headingIds: false, linkify: true }),
          TO_MD,
        );

        expect(again).toBe(once);
      }),
      { numRuns: 100 },
    );
  });

  it('is idempotent converting to text', () => {
    fc.assert(
      fc.property(htmlArb, (source) => {
        // Plain text IS valid HTML input, so re-running must be a no-op -
        // otherwise the tool mangles its own output the second time.
        const once = htmlToText(source, TO_TEXT);

        expect(htmlToText(once, TO_TEXT)).toBe(once);
      }),
      { numRuns: 100 },
    );
  });

  it('never emits markup from the text converter', () => {
    fc.assert(
      fc.property(htmlArb, (source) => {
        expect(htmlToText(source, TO_TEXT)).not.toMatch(/<[a-z/]/i);
      }),
      { numRuns: 100 },
    );
  });
});

describe('defaults', () => {
  it('start on Markdown, which is what people paste HTML in for', () => {
    expect(htmlTextDefaultOptions.mode).toBe('markdown');
    expect(htmlTextDefaultOptions.keepLinkUrls).toBe(true);
    // 'text' rather than 'keep': someone converting HTML to Markdown is trying
    // to get AWAY from the HTML.
    expect(htmlTextDefaultOptions.unsupported).toBe('text');
  });
});
