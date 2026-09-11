import { describe, expect, it } from 'vitest';

import type { Bytes, ResidentValue, ToolRunContext } from '@/features/registry/types';
import { textToBytes } from '@/lib/base64';

import { textConvertTool } from './index';
import { textConvertDefaultOptions, type TextConvertOptions } from './options';

/**
 * THE THREE OUTPUT PORTS, and the question the port audit was asked about them.
 *
 * `Converted`, `Rendered HTML` and `Detected` - and it was not obvious how the
 * first two differed when the target format was HTML. The answer turned out to
 * be two separate things:
 *
 *   1. A DEFECT. `Rendered HTML` promised sanitised HTML and, for an HTML
 *      source with any target but Markdown, handed back the input string
 *      unchanged - script elements and event handlers included.
 *   2. A COINCIDENCE THAT CANNOT BE DESIGNED AWAY. For a Markdown source with
 *      an HTML target the two ports really are the same string, because
 *      converting a document to HTML and rendering it ARE the same operation.
 *
 * The first is fixed. The second is asserted here as a fact, so that a future
 * reader finds a decision rather than a surprise - and so that if anybody
 * changes it, they change this test and read the reasoning in `index.ts` on
 * the way past.
 */

const context: ToolRunContext = {
  signal: new AbortController().signal,
  reportProgress: () => undefined,
};

async function run(
  input: ResidentValue,
  overrides: Partial<TextConvertOptions> = {},
): Promise<Record<'output' | 'rendered' | 'detected', string>> {
  const result = await textConvertTool.run({
    inputs: { input: input as never },
    options: { ...textConvertDefaultOptions, ...overrides },
    context,
  });

  if (!result.ok) throw new Error(`expected success, got ${result.error.message}`);
  return {
    output: result.value.output.text,
    rendered: result.value.rendered.text,
    detected: result.value.detected.text,
  };
}

const text = (value: string) => ({ type: 'text' as const, text: value });

/**
 * The RESIDENT shape, because these tests call the typed tool rather than the
 * erased one - and the typed tool is what a resident tool's `run` signature is
 * derived from. Going through the erased tool would test the conversion as
 * well as the tool, which `ports.test.ts` already does.
 */
const residentBytes = (value: Bytes) => ({
  type: 'bytes' as const,
  bytes: value,
  mediaType: null,
  filename: null,
});

const bytes = (value: string) => residentBytes(textToBytes(value));

/* ========================================================================== *
 * The rendered port is sanitised, always
 * ========================================================================== */

describe('the Rendered HTML port', () => {
  const DANGEROUS = '<p onclick="alert(1)">hi<script>alert(2)</script></p>';

  /*
   * All three targets, because the bug was in exactly the two where `rendered`
   * is the hub value rather than a re-render of the output - and it was
   * invisible in the third, which is why it survived.
   */
  it.each<TextConvertOptions['target']>(['html', 'markdown', 'text'])(
    'carries sanitised HTML for an html source with target %s',
    async (target) => {
      const { rendered } = await run(text(DANGEROUS), { source: 'html', target });

      expect(rendered).not.toContain('onclick');
      expect(rendered).not.toContain('script');
      expect(rendered).not.toContain('alert');
      // Sanitised, not emptied: the words are the document.
      expect(rendered).toContain('hi');
    },
  );

  it('carries sanitised HTML for a markdown source too', async () => {
    const { rendered } = await run(text(`Text and ${DANGEROUS}\n`), {
      source: 'markdown',
      target: 'markdown',
    });

    expect(rendered).not.toContain('onclick');
    /*
     * `<script` ESCAPED rather than absent, which is GFM's tagfilter and not a
     * hole. The spec escapes nine tags on the Markdown path because the HTML
     * tokenizer treats them as raw text, so an unclosed one eats the rest of
     * the document - and escaping turns that silent loss into something the
     * reader can see where they wrote it. The word `alert` therefore survives
     * as visible text; the element does not exist.
     */
    expect(rendered).not.toMatch(/<script/i);
    expect(rendered).toContain('&#x3C;script>');
  });

  /*
   * The `output` port was byte-identical before and after the fix, and that is
   * worth pinning: all three conversion pipelines sanitise internally, so
   * sanitising the hub changed nothing about the answer. Only the port whose
   * description was false changed.
   */
  it('leaves the Converted port producing exactly what it produced before', async () => {
    expect((await run(text(DANGEROUS), { source: 'html', target: 'html' })).output).toBe(
      '<p>hi</p>',
    );
    expect((await run(text(DANGEROUS), { source: 'html', target: 'text' })).output).toBe('hi');
  });
});

/* ========================================================================== *
 * How the two text ports relate
 * ========================================================================== */

describe('Converted against Rendered HTML', () => {
  /*
   * THE ONE CASE WHERE THEY COINCIDE, and it is inherent rather than sloppy.
   *
   * `rendered` must always be HTML for `presentation: 'html'` to be a fact,
   * and `output` IS the HTML when the target is HTML, so for a Markdown source
   * no definition of `rendered` can differ from `output` here. Both
   * alternatives cost more: one port would lose the preview and the rich-text
   * copy for the other two targets, and a port that appears only for the
   * targets where it differs is the ports-that-come-and-go model the type
   * system rejected on purpose.
   */
  it('is the same string for a markdown source with an html target', async () => {
    const { output, rendered } = await run(text('# Title\n\nBody with *emphasis*.\n'), {
      source: 'markdown',
      target: 'html',
    });

    expect(rendered).toBe(output);
  });

  /*
   * And they differ in every other combination, which is why two ports is the
   * right number. The html -> html case is the interesting one: `output` is a
   * round trip through Markdown - the normalising pass, which drops markup
   * Markdown cannot express - where `rendered` is the source with nothing but
   * the sanitiser applied. Two genuinely different answers to two genuinely
   * different questions.
   */
  it.each<[TextConvertOptions['source'], TextConvertOptions['target']]>([
    ['markdown', 'markdown'],
    ['markdown', 'text'],
    ['html', 'html'],
    ['html', 'markdown'],
    ['html', 'text'],
  ])('differs for a %s source with a %s target', async (source, target) => {
    const document =
      source === 'markdown' ? '# Title\n\nBody with *emphasis*.\n' : '<h1>Title</h1><p>Body</p>';

    const { output, rendered } = await run(text(document), { source, target });
    expect(rendered).not.toBe(output);
  });

  it('keeps html-to-html different because output normalises and rendered does not', async () => {
    // A <div> is markup Markdown cannot express, so the normalising round trip
    // unwraps it while the sanitiser keeps it.
    const { output, rendered } = await run(text('<div><p>kept</p></div>'), {
      source: 'html',
      target: 'html',
      unsupported: 'text',
    });

    expect(rendered).toContain('<div>');
    expect(output).not.toContain('<div>');
  });
});

/* ========================================================================== *
 * The detected port
 * ========================================================================== */

describe('the Detected port', () => {
  /*
   * KEPT, AND THE AUDIT CONSIDERED REMOVING IT. It is a port nobody would
   * sensibly WIRE - a sentence about a guess is not an input to anything - and
   * that is the test this repository applies to a port on a 224px node.
   *
   * It stays because the alternative is a wrong guess that is invisible, and
   * this tool guesses on every run by default. There is no other channel for
   * an advisory note: a `ToolResult` is a value or an error, and the tool has
   * no place to put "I think this was Markdown, and I am not certain". The
   * shape image-convert uses for the same problem - a `report`-presented JSON
   * port - would make it properly wireable and no more wired, for a value that
   * is one sentence written for a person.
   */
  it('says what was detected, with a confidence and a reason', async () => {
    const { detected } = await run(text('# Heading\n'));
    expect(detected).toMatch(/^markdown \(.+\) - .+/);
  });

  it('says so when the format was chosen rather than detected', async () => {
    const { detected } = await run(text('# Heading\n'), { source: 'markdown' });
    expect(detected).toBe('markdown (chosen, not detected)');
  });
});

/* ========================================================================== *
 * The widened input port
 * ========================================================================== */

describe('the Document input port', () => {
  /*
   * Widened to `bytes`, which is what made "decode a base64 payload and clean
   * up the HTML inside it" expressible on the canvas at all - base64's decoded
   * output is bytes, and `text` and `bytes` do not overlap, so there was no
   * legal wire. `structured-data` had already widened its own document port
   * for exactly this reason.
   */
  it('converts a document that arrived as bytes', async () => {
    const { output } = await run(bytes('<p>from a file</p>'), {
      source: 'html',
      target: 'markdown',
    });
    expect(output.trim()).toBe('from a file');
  });

  it('reads a UTF-16 document with a byte order mark', async () => {
    // Excel's "Unicode Text" export, and the reason `decodeDocument` has the
    // exception at all. Assembled by hand: TextEncoder only writes UTF-8.
    const source = '# Heading';
    const utf16 = new Uint8Array(2 + source.length * 2);
    utf16[0] = 0xff;
    utf16[1] = 0xfe;
    for (let index = 0; index < source.length; index += 1) {
      utf16[2 + index * 2] = source.charCodeAt(index) & 0xff;
      utf16[3 + index * 2] = source.charCodeAt(index) >> 8;
    }

    const { output } = await run(residentBytes(utf16), {
      source: 'markdown',
      target: 'html',
      headingIds: false,
    });
    expect(output).toContain('<h1>Heading</h1>');
  });

  /*
   * A TOO-WIDE TYPE HAS TO REFUSE CLEARLY RATHER THAN GUESS. The risk of
   * accepting bytes is that a PNG gets decoded to replacement characters and
   * converted anyway, producing a confident, well-formed document about
   * content nobody wrote. Strict decoding is what makes the wider port safe.
   */
  it('refuses bytes that are not text, rather than converting mojibake', async () => {
    const result = await textConvertTool.run({
      inputs: {
        input: residentBytes(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x80])),
      },
      options: textConvertDefaultOptions,
      context,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toBe('Those bytes could not be read as text.');
  });
});
