import { describe, expect, it } from 'vitest';

import { isJsonArray, isJsonObject, type ToolRunContext } from '@/features/registry/types';
import { compareMarkup } from '@/lib/markup/changes';

import textConvertTool from './index';

/**
 * THE TWO NORMALISING PASSES, AND WHAT THEY CHANGE.
 *
 * `HTML → HTML` and `Markdown → Markdown` are round trips through another
 * format, and both were `lossy, silent` in docs/conversion-matrix.md. They lose
 * different things for different reasons and are reported by different
 * instruments - see `normalisation.ts` - so they are tested separately.
 *
 * EVERY ASSERTION HAS A NEGATIVE CONTROL. A note that fires on a document that
 * lost nothing is worse than no note at all, because it is the one that trains
 * people to ignore the channel.
 */

const context: ToolRunContext = {
  signal: new AbortController().signal,
  reportProgress: () => undefined,
};

interface Note {
  readonly level: string;
  readonly title: string;
  readonly body: string;
}

async function convert(
  text: string,
  options: Record<string, unknown> = {},
): Promise<{ readonly output: string; readonly notes: readonly Note[] }> {
  const result = await textConvertTool.run({
    inputs: { input: { type: 'text', text } },
    options,
    context,
  });
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);

  const report = result.value.report;
  if (report?.type !== 'json' || !isJsonObject(report.data)) throw new Error('no report');
  const raw = report.data.notes;
  const output = result.value.output;

  return {
    output: output?.type === 'text' ? output.text : '',
    notes:
      raw !== undefined && isJsonArray(raw)
        ? raw.filter(isJsonObject).map((note) => ({
            level: typeof note.level === 'string' ? note.level : '',
            title: typeof note.title === 'string' ? note.title : '',
            body: typeof note.body === 'string' ? note.body : '',
          }))
        : [],
  };
}

const titles = (notes: readonly Note[]): string[] => notes.map((note) => note.title);
const losses = (notes: readonly Note[]): string[] =>
  notes.filter((note) => note.level === 'warn').map((note) => note.title);

/* ========================================================================== *
 * The instrument
 * ========================================================================== */

describe('compareMarkup, which is what makes the HTML report measured', () => {
  it('finds an attribute that is in one document and not the other', () => {
    expect(compareMarkup('<p class="a">x</p>', '<p>x</p>')).toEqual([
      { kind: 'attribute-dropped', name: 'class' },
    ]);
  });

  it('finds an element that is gone', () => {
    expect(compareMarkup('<div><p>x</p></div>', '<p>x</p>')).toEqual([
      { kind: 'element-dropped', name: 'div' },
    ]);
  });

  it('finds an element that was not there before', () => {
    // A real table on both sides, because a stray `<thead>` outside one is
    // dropped by the HTML parser before this ever sees it.
    expect(
      compareMarkup(
        '<table><tbody><tr><td>a</td></tr></tbody></table>',
        '<table><thead><tr><th>h</th></tr></thead><tbody><tr><td>a</td></tr></tbody></table>',
      ),
      // `tr` is here as well as `thead` and `th`, because the count of `tr`
      // went from one to two. Counting rather than matching is what makes that
      // an addition, and stating it is cheaper than a similarity metric that
      // would sometimes be wrong about which `tr` is which.
    ).toEqual([
      { kind: 'element-added', name: 'thead' },
      { kind: 'element-added', name: 'tr' },
      { kind: 'element-added', name: 'th' },
    ]);
  });

  it('finds nothing between a document and itself', () => {
    // The negative control for the instrument. Without this every assertion
    // above is satisfied by a function that returns a list of everything.
    const html = '<table><tr><td>a</td></tr></table><p class="x">y</p>';
    expect(compareMarkup(html, html)).toEqual([]);
  });
});

/* ========================================================================== *
 * Decision 6: two HTML targets
 * ========================================================================== */

describe('decision 6: HTML sanitised against HTML normalised', () => {
  const HEADERLESS = '<table><tr><td>a</td><td>b</td></tr></table>';

  it('reports the header row the Markdown round trip invents', async () => {
    /*
     * THE ONE THE MATRIX NAMES. A Markdown table always has a header row, so a
     * `<table>` written without one comes back with an empty one - content that
     * was never in the input, produced by a pass called "sanitise and
     * normalise", with nothing to say so.
     */
    const { output, notes } = await convert(HEADERLESS, { source: 'html', target: 'html' });

    expect(output).toContain('<thead>');
    expect(losses(notes).join(' ')).toContain('invented by the round trip');
    expect(notes.find((note) => note.title.includes('invented'))?.body).toContain('<thead>');
  });

  it('invents nothing at all with the sanitised target', async () => {
    // The whole point of the second target, and the negative control for the
    // note above: the same input, the other setting, nothing invented and
    // nothing reported.
    const { output, notes } = await convert(HEADERLESS, {
      source: 'html',
      target: 'html-sanitised',
    });

    expect(output).not.toContain('<thead>');
    expect(output).toContain('<td>a</td>');
    expect(notes).toEqual([]);
  });

  it('reports the attributes the SANITISER removes, in both HTML targets', async () => {
    /*
     * THE MATRIX HAD THIS IN THE WRONG PLACE, and the instrument is what said
     * so: `class` and `data-*` were listed as things the Markdown round trip
     * drops, and they are removed by the sanitiser - so "HTML (sanitised)"
     * loses them too. A report that attributed them to the round trip would
     * have told somebody that switching target would keep them, which is false.
     */
    const source = '<p class="lead" data-id="7">hello</p>';

    for (const target of ['html', 'html-sanitised']) {
      const { output, notes } = await convert(source, { source: 'html', target });

      expect(output).not.toContain('class=');
      const note = notes.find((entry) => entry.title.includes('removed by the sanitiser'));
      expect(note?.level).toBe('warn');
      expect(note?.body).toContain('class');
      expect(note?.body).toContain('data-*');
    }
  });

  it('reports an attribute only the round trip drops, and keeps it when sanitising', async () => {
    // `<img width>` is the one the matrix got right: the sanitiser allows it,
    // Markdown has no spelling for it.
    const source = '<img src="a.png" width="10" alt="a">';

    const normalised = await convert(source, { source: 'html', target: 'html' });
    expect(normalised.output).not.toContain('width');
    expect(losses(normalised.notes).join(' ')).toContain('the round trip could not carry');
    expect(
      normalised.notes.find((note) => note.title.includes('round trip could not carry'))?.body,
    ).toContain('width');

    const sanitised = await convert(source, { source: 'html', target: 'html-sanitised' });
    expect(sanitised.output).toContain('width="10"');
    expect(sanitised.notes).toEqual([]);
  });

  it('reports an element the round trip unwraps', async () => {
    const { notes } = await convert('<div><p>hello</p></div>', {
      source: 'html',
      target: 'html',
    });
    expect(losses(notes).join(' ')).toContain('the round trip could not carry');
    expect(notes.find((note) => note.title.includes('could not carry'))?.body).toContain('<div>');
  });

  it('says nothing for HTML the round trip leaves alone', async () => {
    /*
     * THE NEGATIVE CONTROL THAT MATTERS MOST. A plain paragraph survives the
     * trip to Markdown and back unchanged, so a report on it would fire on the
     * most ordinary input there is.
     */
    const { notes } = await convert('<p>hello</p>', { source: 'html', target: 'html' });
    expect(notes).toEqual([]);
  });

  it('is the same string from a Markdown source, whichever HTML target is chosen', async () => {
    // Stated as a test because it is stated in the option's description:
    // HTML produced from Markdown has already been through Markdown, so there
    // is no round trip left to make and nothing to report.
    const markdown = '# Title\n\nSome *text* with a [link](https://example.com).\n';

    const normalised = await convert(markdown, { source: 'markdown', target: 'html' });
    const sanitised = await convert(markdown, { source: 'markdown', target: 'html-sanitised' });

    expect(normalised.output).toBe(sanitised.output);
    expect(normalised.notes).toEqual([]);
  });
});

/* ========================================================================== *
 * Markdown to Markdown
 * ========================================================================== */

describe('Markdown to Markdown normalisation', () => {
  it('reports footnotes, which have no Markdown spelling on the way back', async () => {
    /*
     * MEASURED, NOT ASSUMED. The matrix said a footnote becomes raw `<sup>`
     * markup; what it actually becomes is an ordinary link to an anchor plus a
     * "Footnotes" heading. Both are losses and only one of them was true.
     */
    const source = 'Text with a note.[^1]\n\n[^1]: The note.\n';
    const { output, notes } = await convert(source, { source: 'markdown', target: 'markdown' });

    expect(output).toContain('](#user-content-fn-1)');
    expect(output).toContain('## Footnotes');
    expect(output).not.toContain('[^1]:');
    expect(losses(notes)).toContain('Footnotes stopped being footnotes');
  });

  it('reports display maths becoming a fenced block', async () => {
    // Also measured: it is a fence tagged `math`, not an inline code span.
    const source = 'Before.\n\n$$\nx = y\n$$\n\nAfter.\n';
    const { output, notes } = await convert(source, { source: 'markdown', target: 'markdown' });

    expect(output).toContain('```math');
    expect(output).not.toContain('$$');
    expect(losses(notes)).toContain('Display maths became a fenced code block');
  });

  it('reports a bare URL becoming an explicit link', async () => {
    const { output, notes } = await convert('See https://example.com for more.\n', {
      source: 'markdown',
      target: 'markdown',
      linkify: true,
    });

    expect(output).toContain('](');
    expect(losses(notes)).toContain('A bare URL became an explicit link');
  });

  it('says nothing about a bare URL when linkify is off', async () => {
    // The negative control for that note: it names an extension's behaviour, so
    // it must be silent when the extension is not doing it.
    const { notes } = await convert('See https://example.com for more.\n', {
      source: 'markdown',
      target: 'markdown',
      linkify: false,
    });
    expect(losses(notes)).not.toContain('A bare URL became an explicit link');
  });

  it('reports reformatting as a note rather than as a loss', async () => {
    /*
     * A different bullet marker is not a loss - the document means the same
     * thing, which `md → html → md → html` stability asserts - so it is `info`
     * and a node does not print it. If this were `warn`, every single
     * Markdown-to-Markdown run would put a warning on a canvas node.
     */
    const { notes } = await convert('* one\n* two\n', {
      source: 'markdown',
      target: 'markdown',
      bullet: '-',
    });

    expect(titles(notes)).toContain('The document was reformatted');
    expect(losses(notes)).toEqual([]);
  });

  it('says nothing at all about Markdown that comes back byte for byte', async () => {
    // The negative control for the whole section. This document is already in
    // the shape the writer produces, so nothing changed and nothing is said.
    const source = '# Title\n\nA paragraph.\n';
    const { output, notes } = await convert(source, { source: 'markdown', target: 'markdown' });

    expect(output).toBe(source);
    expect(notes).toEqual([]);
  });

  it('says nothing for a conversion that is not a round trip', async () => {
    // Markdown to plain text is lossy by definition and governed by its own
    // options; this channel is about passes that go out and come back.
    const { notes } = await convert('# Title\n', { source: 'markdown', target: 'text' });
    expect(notes).toEqual([]);
  });
});

/* ========================================================================== *
 * Markdown to HTML: the raw HTML the allow-list removes
 * ========================================================================== */

describe('Markdown to HTML, which was labelled exact and is not', () => {
  /*
   * The matrix said "exact, 95.7%", and 95.7% is not what exact means. Of the
   * 28 CommonMark examples this converter does not match, 22 are raw HTML this
   * tool does not copy through - which is the product working, and which
   * nothing said.
   *
   * WHAT THE INSTRUMENT FOUND, and it is not what the schema's reputation
   * suggests. The allow-list is considerably more generous than "strip the
   * markup": `<details>`, `<summary>`, `<kbd>` and even `<img align>` all
   * survive. What goes is an element the list does not name at all and an
   * attribute it does not permit.
   *
   * AND ONE CLASS OF LOSS THAT IS NOT REPORTED, ON PURPOSE. `<script>` and
   * `<iframe>` never become elements: GFM's tagfilter escapes them, so they
   * arrive in the output as VISIBLE `&lt;script&gt;` text. Nothing is missing
   * from the document and the reader can see exactly what happened, so there is
   * nothing to tell them. The last test here is what pins that distinction.
   */
  it('reports an element the allow-list does not name', async () => {
    const source = 'Hi\n\n<foo>bar</foo>\n';
    const { output, notes } = await convert(source, { source: 'markdown', target: 'html' });

    expect(output).not.toContain('<foo>');
    expect(output).toContain('bar');
    const note = notes.find((entry) => entry.title.includes('allow-list does not permit'));
    expect(note?.level).toBe('warn');
    expect(note?.body).toContain('<foo>');
  });

  it('reports an attribute the allow-list does not permit on raw HTML', async () => {
    const source = 'Hi\n\n<div class="wrap">\n\nInner.\n\n</div>\n';
    const { output, notes } = await convert(source, { source: 'markdown', target: 'html' });

    expect(output).toContain('<div>');
    expect(output).not.toContain('class=');
    expect(
      notes.find((entry) => entry.title.includes('allow-list does not permit'))?.body,
    ).toContain('class');
  });

  it('reports it for the plain text target too', async () => {
    // The text output is where a removal is least visible of all, and it is
    // still a thing the document had.
    const { notes } = await convert('Hi\n\n<foo>bar</foo>\n', {
      source: 'markdown',
      target: 'text',
    });
    expect(losses(notes).join(' ')).toContain('allow-list does not permit');
  });

  /*
   * THE NEGATIVE CONTROLS. Four, because there are four ways this note could
   * fire on a document that lost nothing - and a note that fires on every
   * README is the one nobody reads.
   */
  it('says nothing about Markdown with no raw HTML in it', async () => {
    const { notes } = await convert('# Title\n\nA paragraph with *emphasis*.\n', {
      source: 'markdown',
      target: 'html',
    });
    expect(notes).toEqual([]);
  });

  it('says nothing about a README\u2019s <details> block, which survives', async () => {
    // Measured, and it is the case the matrix was most likely to be wrong
    // about: the allow-list names <details> and <summary>.
    const source = '# T\n\n<details>\n<summary>More</summary>\n\nHidden.\n\n</details>\n';
    const { output, notes } = await convert(source, { source: 'markdown', target: 'html' });

    expect(output).toContain('<details>');
    expect(output).toContain('<summary>');
    expect(notes).toEqual([]);
  });

  it('says nothing about a tag inside a code span, which is not raw HTML', async () => {
    // The `<` gate is cheap and wrong on its own; the comparison is what
    // decides. A code span is escaped rather than parsed, so nothing is removed.
    const { notes } = await convert('Use `<div>` here.\n', { source: 'markdown', target: 'html' });
    expect(notes).toEqual([]);
  });

  it('says nothing about a <script>, because it is escaped rather than removed', async () => {
    /*
     * GFM's tagfilter turns `<script>` into visible text before anything else
     * sees it, so the output SHOWS the reader what happened. A note here would
     * claim something had been removed when nothing had.
     */
    const { output, notes } = await convert('Hi\n\n<script>alert(1)</script>\n', {
      source: 'markdown',
      target: 'html',
    });

    expect(output).toContain('&#x3C;script>');
    expect(notes).toEqual([]);
  });
});
