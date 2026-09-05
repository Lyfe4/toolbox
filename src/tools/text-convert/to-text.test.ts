import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { htmlToMarkdown, htmlToText, markdownToHtml } from '@/lib/markup/pipelines';

import { textConvertDefaultOptions } from './options';

/**
 * MOVED, NOT REWRITTEN, from the html-text tool this one replaces.
 *
 * Every option is passed explicitly rather than read from a default, so these
 * cases keep asserting the same behaviour they asserted before the merge no
 * matter what the merged tool chooses to default to.
 */
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

  it('renders a table as aligned columns, or drops it', () => {
    const table =
      '<table><thead><tr><th>a</th><th>long header</th></tr></thead>' +
      '<tbody><tr><td>1</td><td>2</td></tr></tbody></table>';

    /*
     * ALIGNED COLUMNS, NOT TABS - which reverses the earlier choice.
     *
     * Tabs were picked so that a table would survive a paste into a
     * spreadsheet. But this app has a structured-data tool that emits real
     * CSV, and plain text is for reading: a table whose columns no longer
     * line up is much harder to read than one that has merely lost its
     * borders. A rule under the header says where the data starts.
     */
    const out = htmlToText(table, TO_TEXT);

    expect(out).toContain('a  long header');
    expect(out).toContain('-  -----------');
    expect(out).toContain('1  2');
    expect(out).not.toContain('\t');
    expect(htmlToText(table, { ...TO_TEXT, tables: 'drop' })).toBe('');
  });

  it('turns a line break into a line break', () => {
    expect(htmlToText('<p>one<br>two</p>', TO_TEXT)).toBe('one\ntwo');
  });

  it('never leaves a run of more than one blank line BETWEEN blocks', () => {
    const out = htmlToText('<div><div><div><p>a</p></div></div></div><p>b</p>', TO_TEXT);

    expect(/\n{3,}/.test(out)).toBe(false);
  });

  it('does leave one inside a code block, where it is content', () => {
    // The qualifier above is load-bearing. Collapsing blank lines is right
    // between blocks and wrong inside a program, and the collapse used to be
    // a regex over the finished string that could not tell the two apart.
    const out = htmlToText('<pre><code>a\n\n\nb</code></pre>', TO_TEXT);

    expect(out).toBe('    a\n\n\n    b');
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
  it('keeps link URLs when producing text', () => {
    expect(textConvertDefaultOptions.keepLinkUrls).toBe(true);
    expect(textConvertDefaultOptions.listMarker).toBe('-');
    expect(textConvertDefaultOptions.tables).toBe('rows');
  });

  /*
   * THE ONE DEFAULT THE MERGE HAD TO PICK. `markdown` defaulted `unsupported`
   * to 'keep'; `html-text` defaulted it to 'text'. One tool cannot have two.
   *
   * 'text' wins, and the case below is the reason rather than a preference.
   * 'keep' reads as the lossless choice, but keeping an element means writing
   * it out verbatim - subtree and all - and a <div> is an element Markdown
   * cannot express. Pasted HTML almost always arrives inside one, so 'keep'
   * would make the commonest input convert to itself. A default that can
   * silently no-op is worse than one that unwraps a container, especially when
   * 'keep' is one control away.
   */
  it('unwraps containers by default, so real pasted HTML actually converts', () => {
    expect(textConvertDefaultOptions.unsupported).toBe('text');

    const wrapped = htmlToMarkdown('<div><h2>Notes</h2><p>Body</p></div>', {
      ...TO_MD,
      unsupported: textConvertDefaultOptions.unsupported,
    });

    expect(wrapped).toContain('## Notes');
    expect(wrapped).not.toContain('<div>');
  });

  it('still carries unconvertible markup through when asked to', () => {
    // The lossless behaviour is not gone, it is opt-in.
    const kept = htmlToMarkdown('<p>Press <kbd>Esc</kbd></p>', { ...TO_MD, unsupported: 'keep' });

    expect(kept).toContain('<kbd>Esc</kbd>');
  });
});
