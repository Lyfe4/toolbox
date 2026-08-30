import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { htmlToMarkdown, markdownToHtml } from '@/lib/markup/pipelines';

import { markdownDefaultOptions } from './options';

/**
 * GITHUB FLAVOURED MARKDOWN, structure by structure.
 *
 * Each case below is one of the constructs that a naive converter gets wrong -
 * usually by handling the outer structure and losing the inner one. They are
 * separate tests rather than one big document because "the README converted"
 * failing tells you nothing about which part broke.
 */

const TO_HTML = { headingIds: true, linkify: true };
const TO_MD = {
  bullet: '-',
  emphasis: '_',
  strong: '*',
  fence: '`',
  setext: false,
  unsupported: 'keep',
} as const;

const html = (markdown: string): string => markdownToHtml(markdown, TO_HTML);
const md = (source: string): string => htmlToMarkdown(source, TO_MD);

describe('GFM constructs', () => {
  it('renders tables, with alignment', () => {
    const out = html('| left | right |\n| :--- | ----: |\n| a | b |\n');

    expect(out).toContain('<table>');
    expect(out).toContain('<th align="left">left</th>');
    expect(out).toContain('<td align="right">b</td>');
  });

  it('renders strikethrough', () => {
    expect(html('~~gone~~\n')).toContain('<del>gone</del>');
  });

  it('renders task lists as checkboxes, checked and unchecked', () => {
    const out = html('- [ ] todo\n- [x] done\n');

    expect(out).toContain('class="task-list-item"');
    expect((out.match(/type="checkbox"/g) ?? []).length).toBe(2);
    expect(out).toContain('checked');
  });

  it('autolinks bare URLs and www hosts', () => {
    const out = html('See https://example.com and www.example.org today.\n');

    expect(out).toContain('href="https://example.com"');
    expect(out).toContain('www.example.org');
  });

  it('renders footnotes with a back-reference', () => {
    const out = html('Text with a note[^1].\n\n[^1]: The note itself.\n');

    expect(out).toContain('data-footnote-ref');
    expect(out).toContain('The note itself.');
    expect(out).toContain('data-footnote-backref');
  });

  it('keeps the language hint on a fenced code block', () => {
    expect(html('```ts\nconst a: number = 1;\n```\n')).toContain('class="language-ts"');
  });

  it('keeps a fenced code block nested inside a list item', () => {
    // The case that catches converters that treat a fence as a block-level
    // construct only: indented four spaces, it is still a fence, not a
    // code-indented paragraph.
    const out = html('1. Step one\n\n   ```sh\n   npm run build\n   ```\n\n2. Step two\n');

    expect(out).toContain('<ol>');
    expect(out).toContain('class="language-sh"');
    expect(out).toContain('npm run build');
  });

  it('handles a blockquote containing a list containing a task list', () => {
    const source = '> Notes:\n>\n> - first\n>   - [ ] nested task\n>   - [x] nested done\n';
    const out = html(source);

    expect(out).toContain('<blockquote>');
    // Two levels of list, and the checkboxes survived the descent.
    expect((out.match(/<ul/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect((out.match(/type="checkbox"/g) ?? []).length).toBe(2);
  });

  it('handles deeply nested lists mixing ordered and unordered', () => {
    const source = ['- a', '  1. b', '     - c', '       1. d', '          - e'].join('\n');
    const out = html(source);

    expect((out.match(/<ul/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect((out.match(/<ol/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(out).toContain('e');
  });

  it('reads both setext and ATX headings', () => {
    const out = html('Setext One\n==========\n\nSetext Two\n----------\n\n### ATX Three\n');

    expect(out).toContain('<h1');
    expect(out).toContain('<h2');
    expect(out).toContain('<h3');
  });

  it('resolves reference-style links', () => {
    const out = html('See [the docs][ref].\n\n[ref]: https://example.com "Title"\n');

    expect(out).toContain('href="https://example.com"');
    expect(out).toContain('title="Title"');
  });

  it('keeps an HTML block written inside Markdown', () => {
    // rehype-raw is what makes this work, and the sanitiser is what makes it
    // safe. `<kbd>` is allowed; the surrounding structure survives.
    const out = html('Before\n\n<div class="note"><kbd>Ctrl</kbd></div>\n\nAfter\n');

    expect(out).toContain('<kbd>Ctrl</kbd>');
    expect(out).toContain('Before');
    expect(out).toContain('After');
  });

  it('honours hard line breaks', () => {
    // Two trailing spaces is a hard break in CommonMark, and losing it merges
    // two lines of an address into one.
    expect(html('one  \ntwo\n')).toContain('<br');
    expect(html('one\\\ntwo\n')).toContain('<br');
  });

  it('respects escaped characters', () => {
    const out = html('\\*not emphasis\\* and \\# not a heading\n');

    expect(out).not.toContain('<em>');
    expect(out).not.toContain('<h1');
    expect(out).toContain('*not emphasis*');
  });

  it('decodes entity references', () => {
    const out = html('&amp; &lt; &copy; &#8212;\n');

    // & and < must come back OUT escaped, or the output is not valid HTML.
    expect(out).toContain('&#x26;');
    expect(out).toContain('&#x3C;');
    expect(out).toContain('©');
    expect(out).toContain('—');
  });
});

describe('options', () => {
  it('adds heading ids only when asked', () => {
    expect(markdownToHtml('# Hi there\n', { headingIds: true, linkify: true })).toContain('id="');
    expect(markdownToHtml('# Hi there\n', { headingIds: false, linkify: true })).not.toContain(
      'id="',
    );
  });

  it('leaves bare URLs alone when linkify is off, without touching real links', () => {
    const source = 'Bare https://a.com, angle <https://b.com>, explicit [c](https://c.com).\n';

    expect(
      (markdownToHtml(source, { headingIds: false, linkify: true }).match(/<a /g) ?? []).length,
    ).toBe(3);

    const off = markdownToHtml(source, { headingIds: false, linkify: false });
    expect((off.match(/<a /g) ?? []).length).toBe(2);
    expect(off).toContain('Bare https://a.com');
  });

  it.each([
    ['-', '- item'],
    ['*', '* item'],
    ['+', '+ item'],
  ] as const)('writes %s as the bullet marker', (bullet, expected) => {
    expect(htmlToMarkdown('<ul><li>item</li></ul>', { ...TO_MD, bullet })).toContain(expected);
  });

  it.each([
    ['_', '_word_'],
    ['*', '*word*'],
  ] as const)('writes %s as the emphasis delimiter', (emphasis, expected) => {
    expect(htmlToMarkdown('<p><em>word</em></p>', { ...TO_MD, emphasis })).toContain(expected);
  });

  it.each([
    ['`', '```'],
    ['~', '~~~'],
  ] as const)('writes %s as the code fence', (fence, expected) => {
    expect(htmlToMarkdown('<pre><code>x</code></pre>', { ...TO_MD, fence })).toContain(expected);
  });

  it('writes setext headings when asked, falling back to ATX below h2', () => {
    const out = htmlToMarkdown('<h1>One</h1><h2>Two</h2><h3>Three</h3>', {
      ...TO_MD,
      setext: true,
    });

    expect(out).toContain('=');
    expect(out).toContain('### Three');
  });

  it.each([
    ['keep', '<kbd>'],
    ['text', 'Ctrl'],
  ] as const)('handles unsupported markup with %s', (unsupported, expected) => {
    const out = htmlToMarkdown('<p><kbd>Ctrl</kbd> rules</p>', {
      ...TO_MD,
      unsupported,
    });

    expect(out).toContain(expected);
  });
});

describe('round-tripping', () => {
  /*
   * MARKDOWN → HTML → MARKDOWN IS NOT BYTE-IDENTICAL, AND THAT IS CORRECT.
   *
   * `*em*` and `_em_` both produce `<em>`, so exactly one of them survives the
   * journey back. So does the choice of bullet, of fence, of heading style,
   * and of how a link was written. Chasing byte equality here would mean
   * recording the original syntax in the HTML, which is not what HTML is for.
   *
   * The two properties below are the ones that DO hold, and they are the ones
   * worth defending. Written as fast-check properties rather than examples
   * because the interesting inputs are the ones nobody thinks to write down.
   */

  /** Markdown fragments assembled from constructs, not random characters. */
  const markdownArb = fc
    .array(
      fc.oneof(
        fc.constantFrom(
          '# Heading',
          '## Another',
          'Plain paragraph text.',
          '- one\n- two',
          '1. first\n2. second',
          '- [ ] todo\n- [x] done',
          '> quoted',
          '```js\nconst a = 1;\n```',
          '| a | b |\n| - | - |\n| 1 | 2 |',
          '~~struck~~',
          '**bold** and _italic_',
          '[link](https://example.com)',
          '`code span`',
          '---',
        ),
        fc.string({ minLength: 1, maxLength: 24 }).map((s) => s.replace(/[\r\n]/g, ' ')),
      ),
      { minLength: 1, maxLength: 6 },
    )
    .map((parts) => `${parts.join('\n\n')}\n`);

  it('is idempotent: converting twice is the same as converting once', () => {
    fc.assert(
      fc.property(markdownArb, (source) => {
        const once = md(html(source));
        const twice = md(html(once));

        expect(twice).toBe(once);
      }),
      { numRuns: 120 },
    );
  });

  it('is semantically stable: md → html → md → html gives identical HTML', () => {
    fc.assert(
      fc.property(markdownArb, (source) => {
        const first = html(source);
        const second = html(md(first));

        expect(second).toBe(first);
      }),
      { numRuns: 120 },
    );
  });

  /*
   * FOOTNOTES ARE ONE-WAY, and this test exists so nobody "fixes" that by
   * accident or is surprised by it.
   *
   * md → html renders GFM footnotes properly: a <sup> reference and a
   * <section data-footnotes> holding the definitions. Coming BACK, rehype-remark
   * has no handler that recognises that structure as footnotes, so the
   * reference survives as an inline link and the definition block degenerates
   * into an ordinary heading and list. Reconstructing `[^1]:` syntax would mean
   * writing that handler and pattern-matching on GitHub's exact markup.
   *
   * What does hold is that it settles: one round trip loses the structure, and
   * every round trip after that changes nothing. That fixed point is what the
   * idempotence property covers, and it is asserted directly here. It is why
   * footnotes are excluded from the semantic-stability arbitrary rather than
   * the property being weakened for everything else.
   */
  it('renders footnotes one way, and is stable from then on', () => {
    const source = 'Text with a note[^1].\n\n[^1]: The note.\n';

    const first = html(source);
    expect(first).toContain('data-footnotes');
    expect(first).toContain('data-footnote-backref');

    const roundTripped = html(md(first));
    // The section is gone - this is the documented loss.
    expect(roundTripped).not.toContain('data-footnotes');

    // And it does not keep degrading: one more trip changes nothing.
    expect(html(md(roundTripped))).toBe(roundTripped);
  });

  it('keeps every in-document anchor pointing at an id that exists', () => {
    // The bug this catches: the sanitiser namespaces ids but not hrefs, so
    // every footnote and heading link pointed at a name that no longer existed.
    const out = html('# A heading\n\nText with a note[^1].\n\n[^1]: The note.\n');

    const ids = new Set([...out.matchAll(/id="([^"]+)"/g)].map((match) => match[1]));
    const fragments = [...out.matchAll(/href="#([^"]+)"/g)].map((match) => match[1]);

    expect(fragments.length).toBeGreaterThan(0);
    expect(fragments.filter((fragment) => !ids.has(fragment))).toEqual([]);
  });

  it('namespaces identifiers exactly once, however many times it runs', () => {
    const once = html('# Heading\n');
    const twice = html(md(once));

    expect(once).toContain('id="user-content-heading"');
    expect(twice).not.toContain('user-content-user-content-');
  });

  it('is idempotent for HTML → Markdown too', () => {
    fc.assert(
      fc.property(markdownArb, (source) => {
        const asHtml = html(source);
        const once = md(asHtml);

        expect(md(html(once))).toBe(once);
      }),
      { numRuns: 60 },
    );
  });
});

describe('defaults', () => {
  it('start in the direction most people want', () => {
    expect(markdownDefaultOptions.direction).toBe('md-to-html');
    expect(markdownDefaultOptions.headingIds).toBe(true);
    expect(markdownDefaultOptions.linkify).toBe(true);
  });
});
