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

/** Named so an expectation about a table row reads as text rather than as an escape. */
const LF = String.fromCharCode(10);

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
    /*
     * `<tr>` and `<th>`, NOT `<thead>`, and that is a correction round ten
     * made rather than a detail. `<thead>` is inserted by the HTML serialiser
     * on its own account, so it appeared in this note for every table whose
     * header row was written as a plain `<tr>` of `<th>` - a document where
     * nothing was invented at all. The two elements left are the ones a reader
     * can point at: an extra row, of empty header cells. See
     * `SERIALISER_WRAPPERS`.
     */
    const body = notes.find((note) => note.title.includes('invented'))?.body ?? '';
    expect(body).toContain('<tr>');
    expect(body).toContain('<th>');
    expect(body).not.toContain('<thead>');
  });

  it('invents nothing for a table whose header row is a plain <tr> of <th>', async () => {
    /*
     * THE NEGATIVE CONTROL FOR THE CORRECTION ABOVE, and the document that
     * found it. `<table><tr><th>` parses with the row inside an implied
     * `<tbody>` and no `<thead>`, and every table this tool writes has a
     * `<thead>` - so the census sees an element appear on the commonest shape
     * of hand-written table there is. Nothing visible was invented: the header
     * row was in the input and is in the output.
     */
    const { output, notes } = await convert(
      '<table><tr><th>Region</th></tr><tr><td>North</td></tr></table>',
      { source: 'html', target: 'html' },
    );

    expect(output).toContain('<thead>');
    expect(output).toContain('<th>Region</th>');
    expect(notes).toEqual([]);
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

/* ========================================================================== *
 * The identifiers the author wrote
 * ========================================================================== */

describe('an id the author wrote, under a prefix they did not', () => {
  /*
   * THE SILENCE `compareMarkup` CANNOT SEE.
   *
   * Every HTML this tool produces has its `id` and `name` attributes prefixed
   * `user-content-`, so that markup pasted into a page cannot shadow something
   * already on it. `id` is present in both documents, so the census comparison
   * finds nothing and reported nothing - which the matrix recorded under "still
   * unverified" and described as "documented elsewhere". Elsewhere was a
   * comment in this repository, and a comment is not a channel.
   *
   * Links inside the document are moved to follow it, so the document still
   * works. Anything outside it that pointed at the old name does not, and that
   * is the failure nobody reports: `#location` in a stylesheet, a script, or a
   * link from another page simply finds nothing.
   */
  const SOURCE = '<h2 id="location">Where</h2>\n<p><a href="#location">jump</a></p>';

  it('names it for the sanitised target, which keeps the document working', async () => {
    const { output, notes } = await convert(SOURCE, { source: 'html', target: 'html-sanitised' });

    // The rename really happened, and the in-document link went with it, which
    // is what the note is about and what it says.
    expect(output).toContain('id="user-content-location"');
    expect(output).toContain('href="#user-content-location"');

    expect(losses(notes)).toContain('1 identifier was namespaced');
    const note = notes.find((entry) => entry.title === '1 identifier was namespaced');
    expect(note?.body).toContain('location became user-content-location');
    // Nothing is dead here: the target moved and the link moved with it.
    expect(titles(notes).some((title) => title.includes('at nothing'))).toBe(false);
  });

  /*
   * THE ONE THE INSTRUMENT FOUND, WHICH IS WORSE THAN THE ONE IT WAS WRITTEN
   * FOR.
   *
   * `HTML → HTML (normalised)` takes the document out to Markdown. Markdown has
   * no spelling for a heading's id, so it is dropped, and `rehypeSlug` invents
   * a fresh one from the heading's TEXT on the way back. The link that pointed
   * at the author's id is carried through untouched and now names something
   * that is in no document anywhere.
   *
   * `compareMarkup` sees nothing: one `id` in, one `id` out, one `href` in, one
   * `href` out. A table of contents can arrive dead with every count equal,
   * which is exactly the shape this round exists to find.
   */
  it('reports a link the normalising round trip left pointing at nothing', async () => {
    const { output, notes } = await convert(SOURCE, { source: 'html', target: 'html' });

    // The defect, measured rather than described.
    expect(output).toContain('id="user-content-where"');
    expect(output).toContain('href="#user-content-location"');
    expect(output).not.toContain('id="user-content-location"');

    expect(losses(notes)).toContain('1 link in the document points at nothing');
    const dead = notes.find((entry) => entry.title.includes('at nothing'));
    expect(dead?.body).toContain('#user-content-location');
    // And the cause is named beside the consequence.
    expect(losses(notes)).toContain('1 identifier is not in the result');
  });

  it('says nothing about a link that was already dead when it arrived', async () => {
    /*
     * The negative control that makes the note above mean anything. A document
     * can arrive with an anchor pointing at nothing, and blaming the conversion
     * for it would be a confident wrong sentence about somebody else's markup.
     */
    const { notes } = await convert('<p><a href="#gone">g</a></p>', {
      source: 'html',
      target: 'html',
    });

    expect(titles(notes).some((title) => title.includes('at nothing'))).toBe(false);
  });

  it('counts them, and names the first five', async () => {
    const many = Array.from(
      { length: 7 },
      (_unused, index) => `<p id="a${String(index)}">x</p>`,
    ).join('\n');
    const { notes } = await convert(many, { source: 'html', target: 'html-sanitised' });

    const note = notes.find((entry) => entry.title.includes('identifiers were namespaced'));
    expect(note?.title).toBe('7 identifiers were namespaced');
    expect(note?.body).toContain('a0 became user-content-a0');
    expect(note?.body).toContain('a4 became user-content-a4');
    expect(note?.body).not.toContain('a5 became');
    expect(note?.body).toContain('and 2 more');
  });

  it('reports one an author wrote inside a Markdown document', async () => {
    const { output, notes } = await convert('# T\n\n<p id="here">x</p>\n', {
      source: 'markdown',
      target: 'html',
    });

    expect(output).toContain('id="user-content-here"');
    expect(losses(notes)).toContain('1 identifier was namespaced');
  });

  /* -- The negative controls, which are the whole of why this is trustworthy - */

  it('says nothing about a document with no identifier in it', async () => {
    const { notes } = await convert('<p>plain</p>', { source: 'html', target: 'html-sanitised' });
    expect(titles(notes)).not.toContain('1 identifier was namespaced');
  });

  it('says nothing about a heading slug this tool invented', async () => {
    /*
     * THE FALSE POSITIVE THE FIRST VERSION HAD, and the reason the question is
     * asked of the source rather than of the pre-sanitised tree. `rehypeSlug`
     * makes an id per heading and `remarkRehype` makes one per footnote; both
     * carry the prefix and neither is a name the author chose, so reporting
     * them would put a loss on almost every Markdown document there is.
     */
    const { output, notes } = await convert('# Setup\n\nwords\n', {
      source: 'markdown',
      target: 'html',
      headingIds: true,
    });

    expect(output).toContain('id="user-content-setup"');
    expect(losses(notes)).not.toContain('1 identifier was namespaced');
  });

  it('says nothing about a footnote anchor this tool invented', async () => {
    const { output, notes } = await convert('A[^1]\n\n[^1]: note\n', {
      source: 'markdown',
      target: 'html',
    });

    expect(output).toContain('user-content-fn-1');
    expect(notes.filter((entry) => entry.title.includes('namespaced'))).toEqual([]);
  });

  it('says nothing about markup inside a fenced block, which was never parsed', async () => {
    // A README ABOUT HTML. The tag is escaped to visible text rather than
    // renamed, so a note would describe something that did not happen.
    const { notes } = await convert('```html\n<div id="main">x</div>\n```\n', {
      source: 'markdown',
      target: 'html',
    });

    expect(notes.filter((entry) => entry.title.includes('namespaced'))).toEqual([]);
  });

  it('says nothing the second time, because the prefix is already there', async () => {
    // The idempotence the hand-rolled namespacing exists to provide. A
    // document that has been through this tool once has nothing left to rename.
    const first = await convert(SOURCE, { source: 'html', target: 'html-sanitised' });
    const second = await convert(first.output, { source: 'html', target: 'html-sanitised' });

    expect(second.output).toContain('id="user-content-location"');
    expect(second.notes.filter((entry) => entry.title.includes('namespaced'))).toEqual([]);
  });

  it('says nothing for a plain-text target, where no identifier survives at all', async () => {
    const { output, notes } = await convert('# T\n\n<p id="here">x</p>\n', {
      source: 'markdown',
      target: 'text',
    });

    expect(output).not.toContain('user-content');
    expect(notes.filter((entry) => entry.title.includes('namespaced'))).toEqual([]);
  });
});

/* ========================================================================== *
 * The census the Markdown target never had
 * ========================================================================== */

/**
 * TC-1, TC-5 AND TC-13 WERE ONE SILENCE, AND THIS IS IT.
 *
 * For an HTML source with a Markdown target, nothing compared the input with
 * the result. The reason recorded in `normalisation.ts` - "for Markdown there
 * is nothing to compare" - is true of a Markdown SOURCE and was applied to the
 * target: here there are three documents, and the third was already being
 * computed for the `rendered` port. `markdownToHtml(output)` IS what the `html`
 * target calls normalising, so this costs no conversion at all.
 *
 * EVERY CASE HERE HAS A CONTROL, and the controls are the point rather than the
 * ceremony: these notes are new on this target, and a note that fires on an
 * ordinary HTML table is one that trains people to ignore the channel. One of
 * them found a false report that had been shipped on the HTML target since
 * round four - see `SERIALISER_WRAPPERS`.
 */
describe('the census on the Markdown target', () => {
  const MARKDOWN = { source: 'html', target: 'markdown' } as const;

  it('reports a table caption, which Markdown has nowhere to put', async () => {
    // TC-5, confirmed on this target and reported on the other.
    const { output, notes } = await convert(
      '<table><caption>Quarterly sales</caption><tr><th>Region</th></tr><tr><td>North</td></tr></table>',
      MARKDOWN,
    );

    expect(output).not.toContain('Quarterly sales');
    const note = notes.find((entry) => entry.title.includes('could not carry'));
    expect(note?.level).toBe('warn');
    expect(note?.body).toContain('<caption>');
  });

  it('reports the list structure a table cell loses', async () => {
    /*
     * TC-1's other half. The cell no longer emits a newline - see
     * constructs.test.ts - and the bullets are what that costs, so this is the
     * note that says the cell used to be a list.
     */
    const { output, notes } = await convert(
      '<table><tr><th>Region</th></tr><tr><td><ul><li>North</li><li>South</li></ul></td></tr></table>',
      MARKDOWN,
    );

    expect(output).toContain('| North South |');
    const note = notes.find((entry) => entry.title.includes('could not carry'));
    expect(note?.level).toBe('warn');
    expect(note?.body).toContain('<ul>');
    expect(note?.body).toContain('<li>');
  });

  it('reports the empty header row a headerless table gains', async () => {
    // TC-13, which was reported on `HTML → HTML (normalised)` and silent here.
    const { output, notes } = await convert(
      '<table><tr><td>North</td><td>3</td></tr></table>',
      MARKDOWN,
    );

    // The header cells are empty; the columns are padded to their content.
    expect(output.split(LF)[0]).toBe('|       |   |');
    const note = notes.find((entry) => entry.title.includes('invented'));
    expect(note?.level).toBe('warn');
    expect(note?.body).toContain('<th>');
    expect(note?.body).toContain('header row');
  });

  it('reports what the sanitiser removed, on the way to Markdown too', async () => {
    const { notes } = await convert('<p class="lead" data-id="7">hello</p>', MARKDOWN);

    const note = notes.find((entry) => entry.title.includes('removed by the sanitiser'));
    expect(note?.level).toBe('warn');
    expect(note?.body).toContain('class');
    expect(note?.body).toContain('data-*');
    // The sentence used to say "every HTML this tool produces", which is not
    // what the reader of a Markdown output is holding.
    expect(note?.body).not.toContain('every HTML this tool produces');
  });

  it('explains a header row only when a header row is what was invented', async () => {
    /*
     * THE SECOND FALSE SENTENCE THIS ROUND FOUND, and it surfaced only because
     * the census now runs on a target where inventions are common. `<mark>`
     * becoming `_…_` invents an `<em>`, and the note explained the invention by
     * saying that a Markdown table always has a header row. The count was
     * right; the reason under it was about somebody else's document.
     */
    const substituted = await convert(
      '<p><mark>highlighted</mark> and <kbd>Esc</kbd></p>',
      MARKDOWN,
    );
    const invention = substituted.notes.find((entry) => entry.title.includes('invented'));

    expect(substituted.output).toBe('_highlighted_ and `Esc`\n');
    expect(invention?.body).toContain('<em>');
    expect(invention?.body).not.toContain('header row');

    // And the positive half, so this is not a test that the sentence is gone.
    const headerless = await convert('<table><tr><td>North</td></tr></table>', MARKDOWN);
    expect(headerless.notes.find((entry) => entry.title.includes('invented'))?.body).toContain(
      'header row',
    );
  });

  it('does not offer a table caption as an explanation for every element it lost', async () => {
    // The same defect in the other note, and milder: the clause was
    // illustrative rather than a claim, and it was still an illustration of
    // the wrong document.
    const { notes } = await convert('<p><mark>highlighted</mark></p>', MARKDOWN);
    const note = notes.find((entry) => entry.title.includes('could not carry'));

    expect(note?.body).toContain('<mark>');
    expect(note?.body).not.toContain('caption');
  });

  it('says which document an element was counted in', async () => {
    /*
     * An element is only countable as an element in HTML, and the reader of a
     * Markdown output is not holding that document. Saying so is the
     * difference between a measurement and a claim about their file.
     */
    const { notes } = await convert(
      '<table><caption>c</caption><tr><td>x</td></tr></table>',
      MARKDOWN,
    );

    expect(notes.some((entry) => entry.body.includes('rendering this Markdown back to HTML'))).toBe(
      true,
    );
  });

  it.each([
    [
      'a paragraph with a link and emphasis',
      '<p>Hello <strong>world</strong>, <a href="/x">x</a>.</p>',
    ],
    ['a heading and a list', '<h2>Title</h2><ul><li>one</li><li>two</li></ul>'],
    ['a fenced code block', '<pre><code class="language-js">const a = 1;\n</code></pre>'],
    ['a blockquote', '<blockquote><p>quoted</p></blockquote>'],
    ['a nested list', '<ul><li>one<ul><li>a</li></ul></li><li>two</li></ul>'],
    ['a task list', '<ul><li><input type="checkbox" checked> done</li></ul>'],
    [
      'a table with a thead',
      '<table><thead><tr><th>h</th></tr></thead><tbody><tr><td>x</td></tr></tbody></table>',
    ],
    [
      'a table whose header row is a plain tr of th',
      '<table><tr><th>h</th></tr><tr><td>x</td></tr></table>',
    ],
    [
      'a table cell of inline content',
      '<table><tr><th>h</th></tr><tr><td>a <em>b</em></td></tr></table>',
    ],
  ])('says nothing about a Markdown target that lost nothing: %s', async (_what, source) => {
    /*
     * THE CONTROLS, AND THE ONE THAT CHANGED THE CODE. The last three are
     * tables, because tables are what these notes are mostly about and a
     * report that fires on every table is no report. The eighth is the
     * document that found the `<thead>` false positive: its header row is
     * written as a plain `<tr>` of `<th>`, which is the commonest shape there
     * is, and the census saw a `<thead>` appear because the HTML serialiser
     * writes one.
     */
    const { notes } = await convert(source, MARKDOWN);
    expect(notes).toEqual([]);
  });

  it('takes no census of a plain-text target, which has no markup to count', async () => {
    /*
     * THE BOUNDARY, STATED AS A TEST. Plain text has no third document - the
     * same absence a Markdown SOURCE has, and the one place the reasoning this
     * change overturned still applies. A census of a document with no elements
     * in it would report every element as dropped.
     */
    const { notes } = await convert(
      '<table><caption>c</caption><tr><th>h</th></tr><tr><td><ul><li>a</li></ul></td></tr></table>',
      { source: 'html', target: 'text' },
    );

    expect(notes).toEqual([]);
  });

  it('leaves a Markdown source with a Markdown target on its own instrument', async () => {
    // The other side of the same boundary: md to md still reports the named
    // constructs and the reformatting note, and gains no census.
    const { notes } = await convert('# Title\n\nSome *text*.\n', {
      source: 'markdown',
      target: 'markdown',
    });

    expect(titles(notes)).toEqual(['The document was reformatted']);
  });

  it('names both the ports a Markdown target loses in', async () => {
    /*
     * `output` AND `rendered`. For this target `rendered` is the output
     * re-rendered, so it lost exactly what the output lost - which is the
     * opposite of the HTML-normalised case, where `rendered` is the hub and
     * still has what the round trip dropped.
     */
    const result = await textConvertTool.run({
      inputs: {
        input: {
          type: 'text',
          text: '<table><caption>c</caption><tr><td>x</td></tr></table>',
        },
      },
      options: MARKDOWN,
      context,
    });
    if (!result.ok) throw new Error(result.error.message);

    const report = result.value.report;
    if (report?.type !== 'json' || !isJsonObject(report.data)) throw new Error('no report');
    const raw = report.data.notes;
    if (raw === undefined || !isJsonArray(raw)) throw new Error('no notes');

    const reaches = raw
      .filter(isJsonObject)
      .filter((note) => note.level === 'warn')
      .map((note) => note.reaches);

    expect(reaches.length).toBeGreaterThan(0);
    for (const entry of reaches) expect(entry).toEqual(['output', 'rendered']);
  });
});
