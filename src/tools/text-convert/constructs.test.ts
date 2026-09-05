import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { htmlToMarkdown, markdownToHtml } from '@/lib/markup/pipelines';

import { textConvertDefaultOptions } from './options';

/**
 * GITHUB FLAVOURED MARKDOWN, structure by structure.
 *
 * MOVED, NOT REWRITTEN, from the markdown tool this one replaces. These call
 * the shared pipelines directly, which is what makes them survive the merge
 * unchanged: the conversion never moved, only the tool wrapped around it.
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

/** A newline and a backslash, named so expectations read as text not escapes. */
const LF = String.fromCharCode(10);
const BACKSLASH = String.fromCharCode(92);

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
        /*
         * Noise, to exercise escaping of ordinary prose. Three things are
         * normalised out of it first, and each one is a known asymmetry
         * asserted by name below rather than merely avoided here - the same
         * treatment footnotes already get.
         *
         *   NEWLINES would invent block structure the surrounding join did
         *   not intend.
         *
         *   RUNS OF SPACES collapse when HTML renders, so `<p>a  b</p>` is
         *   correctly converted to `a b`. That is the converter being right
         *   about HTML, not a stability failure.
         *
         *   ANGLE BRACKETS turn noise into raw HTML, and raw HTML embedded in
         *   Markdown is normalised to its Markdown spelling on the way back -
         *   `<s>` returns as `<del>`. It settles after one round trip, which
         *   is what the idempotence property covers.
         *
         *   A BACKTICK makes a code span, and a space at the edge of one is
         *   dropped on the way back. Below, by name.
         *
         *   A DOLLAR became a construct character when math parsing was added:
         *   `$$` opens a block of it, and two of them in a noise string turn
         *   the rest of the document into mathematics. Below, by name.
         *
         *   AN AT SIGN can be linkified into an email address, and the
         *   serialiser's own escaping is what creates the address. Same
         *   upstream cause as the backslash below; same case.
         *
         *   A LITERAL BACKSLASH next to inline markup hits an escaping defect
         *   in the Markdown serialiser. This one is a real bug rather than a
         *   normalisation, and it is upstream; see the case below.
         *
         * And a leading `0.` is rewritten, because a list numbered from zero
         * comes back numbered from one. Also below, also by name.
         */
        fc
          .string({ minLength: 1, maxLength: 24 })
          .map((noise) =>
            noise
              .replace(/[<>`$@\\]/g, '')
              .replace(/\s+/g, ' ')
              .replace(/^0(?=[.)])/, '1'),
          )
          .filter((noise) => noise.trim() !== ''),
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

  /*
   * A COUNTEREXAMPLE THE PROPERTY ABOVE ACTUALLY FOUND, kept as a named case
   * so a regression reads as a bug rather than as a flaky property.
   *
   * GFM's linkify turns `+@.A` in ordinary prose into a mailto link. The
   * Markdown serialiser then wrote it as the autolink `<+@.A>` - but
   * CommonMark's email-autolink grammar rejects it, because a domain label
   * cannot begin with a dot, so reading it back gave escaped text and a stray
   * angle bracket. Writing links in resource form fixes it; see the comment on
   * `resourceLink` in pipelines.ts.
   */
  it('round-trips a link whose URL is not a valid autolink', () => {
    const first = html('+@.A\n');

    expect(first).toContain('mailto:+@.A');
    expect(html(md(first))).toBe(first);
  });

  /*
   * THE THREE ASYMMETRIES THE ARBITRARY ABOVE STEPS AROUND.
   *
   * Each is real, each is narrow, and each settles after one round trip, so
   * they belong to the idempotence property rather than to semantic stability.
   * They are named here so that a change in any of them shows up as a failing
   * test with a description, rather than as a property that fails one run in a
   * few thousand.
   */
  it('collapses runs of spaces, because HTML does', () => {
    // Not a loss: two spaces and one space render identically, so the Markdown
    // settles on the one spelling HTML would have shown anyway.
    expect(md('<p>a  b</p>')).toBe('a b' + LF);
  });

  it('normalises raw HTML in the source to its Markdown spelling, once', () => {
    // <s> has no Markdown of its own; the nearest Markdown is ~~, and ~~ means
    // <del>. So the first round trip rewrites it, and the second changes
    // nothing - which is the fixed point idempotence asserts.
    const first = html('<s>gone</s>' + LF);
    const second = html(md(first));

    expect(first).toContain('<s>gone</s>');
    expect(second).toContain('<del>gone</del>');
    expect(html(md(second))).toBe(second);
  });

  it('normalises block math to a math fence, once', () => {
    /*
     * `$$ ... $$` and a ```math fence are the same document, and the fence is
     * the spelling GitHub renders - so the first round trip settles on it and
     * every one after that changes nothing. The same class as raw HTML
     * normalising to its Markdown spelling, and the reason `$` is excluded
     * from the noise above.
     */
    const first = html('$$' + LF + 'x^2' + LF + '$$' + LF);
    const second = html(md(first));

    expect(md(first)).toContain('```math');
    expect(html(md(second))).toBe(second);
  });

  it('lets an unclosed $$ run to the end, exactly as an unclosed fence does', () => {
    /*
     * `$$ oops` opens a math block whose info string is "oops", and with no
     * closing `$$` it consumes the rest of the document - which is precisely
     * what ```` ```oops ```` does. Surprising the first time, but it is
     * Markdown's own rule for an unterminated fence rather than something
     * this tool invented, so it is recorded rather than worked around.
     */
    const out = html('$$ oops' + LF + LF + 'swallowed' + LF);

    expect(out).toContain('language-math');
    expect(out).toContain('swallowed');
  });

  it('KNOWN DEFECT: drops a space at the edge of a code span', () => {
    /*
     * `<code> ab</code>` serialises as `` `ab` ``, losing the space.
     *
     * CommonMark strips one space from each end of a code span when both ends
     * have one, so the space IS expressible - as `` `  ab ` `` - and the
     * serialiser simply does not pad for it. Upstream, and the same judgement
     * as the backslash case: recorded rather than papered over, because
     * whitespace inside a code span is content.
     */
    expect(md('<p><code> ab</code></p>')).toBe('`ab`' + LF);

    // Interior spaces are safe; it is only the edges.
    expect(md('<p><code>a b</code></p>')).toBe('`a b`' + LF);
  });

  it('KNOWN DEFECT: can escape text into an email address', () => {
    /*
     * The same root cause as the backslash below, with a different symptom.
     *
     * Serialising `|7<em>P</em>@Oj.EK` writes the `7` and the `P` as character
     * references so the `_` can open and close emphasis - correct in
     * isolation - and the result, `|&#x37;_&#x50;_@Oj.EK`, contains the
     * sequence `_@Oj.EK`. GFM's autolink literals then read that as an email
     * address, so a round trip turns a fragment of prose into a mailto link.
     *
     * mdast-util-to-markdown's `safe()` again, and again no configuration
     * reaches it: the escaping is correct for the construct it is protecting
     * and simply does not know a linkifier will look at the result.
     */
    const first = html('|7*P*@Oj.EK' + LF);

    // Nothing here is a link: the emphasis separates the `P` from the `@`.
    expect(first).not.toContain('mailto:');
    expect(first).toContain('<em>P</em>');

    // After one round trip it is one, and the escaping is why.
    expect(md(first)).toContain('&#x37;');
    expect(html(md(first))).toContain('mailto:');
  });

  it('KNOWN DEFECT: mangles a backslash that sits next to inline markup', () => {
    /*
     * Not a normalisation - this one loses information, and the test records
     * it rather than pretending otherwise.
     *
     * Serialising `a\x<em>b</em>` writes the x as the character reference
     * `&#x78;` while leaving the backslash bare, giving `a\&#x78;_b_`. Read
     * back, `\&` is an escaped ampersand, so the reference stops being a
     * reference and `&#x78;` arrives as four visible characters instead of an
     * x. It needs a backslash IMMEDIATELY BEFORE inline markup; a backslash on
     * its own is fine, and so is the character-reference escaping on its own.
     *
     * The fault is in mdast-util-to-markdown's escaping, several levels below
     * anything this repository owns, and working around it would mean
     * post-processing the serialiser's output with a regex - which is how you
     * turn one narrow bug into an unbounded number of them. Left alone,
     * written down, and asserted so that an upstream fix shows up here as a
     * failing test rather than going unnoticed.
     */
    expect(md('<p>a' + BACKSLASH + 'x<em>b</em></p>')).toContain('&#x78;');

    // A backslash on its own survives, which is what makes this narrow.
    expect(md('<p>a' + BACKSLASH + 'x b</p>')).toBe('a' + BACKSLASH + 'x b' + LF);
  });

  it('keeps a list that starts at zero, which it used not to', () => {
    /*
     * WAS a known upstream defect, now fixed. hast-util-to-mdast tests
     * `properties.start` for truthiness, so zero - the one falsy number - was
     * the one value it dropped, and `<ol start="0">` renumbered to 1. The
     * default handler is now called and its answer corrected; see
     * `orderedList` in pipelines.ts.
     */
    expect(md('<ol start="3"><li>a</li></ol>')).toBe('3. a' + LF);
    expect(md('<ol start="0"><li>a</li></ol>')).toBe('0. a' + LF);
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
  it('start on the conversion most people want', () => {
    // Auto-detect in, HTML out: the old markdown tool's md-to-html default,
    // reached without having to name the source.
    expect(textConvertDefaultOptions.source).toBe('auto');
    expect(textConvertDefaultOptions.target).toBe('html');
    expect(textConvertDefaultOptions.headingIds).toBe(true);
    expect(textConvertDefaultOptions.linkify).toBe(true);
  });
});
