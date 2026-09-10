import { defineTool, eraseTool, fail, ok, type ErasedTool } from '@/features/registry/types';
import { decodeDocument } from '@/lib/text';

import { detectFormat, type SourceFormat } from './detect';
import {
  textConvertDefaultOptions,
  textConvertOptionFields,
  textConvertOptionsSchema,
} from './options';

/**
 * Markdown, HTML and plain text, one tool.
 *
 * Replaces the separate `markdown` and `html-text` tools. Both converted HTML
 * to Markdown, so the palette offered two entries that accepted the same input
 * and produced the same output - a "which one do I want?" with no right
 * answer. Shaped like the structured-data tool (source, target, auto-detect)
 * so the two read as a pair rather than as two different ideas about the same
 * job.
 *
 * PLAIN TEXT IS A TARGET, NOT A SOURCE. Every other format has structure to
 * read; text does not. "Convert text to Markdown" can only mean escaping the
 * characters Markdown would otherwise interpret and wrapping the result - a
 * real operation, and a different one from converting. Offering it in the
 * source list would put two unrelated jobs behind one control, which is the
 * mistake this merge exists to undo. See the README.
 *
 * THREE OUTPUTS, AND THE TWO TEXT ONES COINCIDE FOR EXACTLY ONE TARGET.
 *
 * `output` is the conversion, in whichever format `target` names. `rendered` is
 * always sanitised HTML, which is what makes `presentation: 'html'` a fact
 * rather than a guess and is what the preview and Copy as rich text hang off.
 * `detected` reports what auto-detection concluded and how sure it was, so a
 * wrong guess is visible rather than silent.
 *
 * With `target: 'html'` and a Markdown source the first two are the SAME
 * STRING, and they have to be: converting a document to HTML and rendering it
 * are the same operation, so no definition of `rendered` can differ from
 * `output` there. The alternatives were weighed and both cost more:
 *
 *   - One port, presented as HTML only when the target is HTML. `presentation`
 *     is static data in the eager manifest - the registry test compares
 *     manifest ports to implementation ports with a structural equality that a
 *     function property cannot pass - so "presented as HTML sometimes" is not
 *     expressible. Making it unconditional would draw Markdown output in an
 *     HTML preview.
 *   - A port that appears only for the targets where it differs. Ports that
 *     come and go as options change was rejected when the port model was
 *     written, and for a better reason than this one: a node whose shape moves
 *     under you while you are wiring it.
 *
 * So the coincidence is stated on the port itself rather than left for someone
 * to discover by reading two identical text boxes. The cost of the other three
 * targets losing the preview and the rich-text copy is much higher than the
 * cost of one duplicated string.
 */
export const textConvertTool = defineTool({
  id: 'text-convert',
  name: 'Text convert',
  summary: 'Convert between Markdown, HTML and plain text, with GitHub Flavoured syntax.',
  category: 'text',

  inputs: [
    {
      id: 'input',
      // 'Document', the same word `structured-data` uses, because the two
      // tools are the same shape - a source, a target, and auto-detection -
      // and a port called 'Input' says nothing a socket does not already say.
      label: 'Document',
      /*
       * Bytes as well as text, for exactly the reason `structured-data` gives
       * for the same widening: a document arrives as raw bytes far more often
       * than not - out of a base64 decode, or a dropped `.md` or `.html` file
       * - and refusing them made "decode this payload and clean up the HTML in
       * it" impossible to wire. Decoded strictly, so a PNG on this port says
       * so instead of being converted from mojibake.
       */
      types: ['text', 'bytes'],
      required: true,
      description: 'Markdown or HTML. Detected automatically unless you say otherwise.',
    },
  ],

  outputs: [
    {
      id: 'output',
      label: 'Converted',
      types: ['text'],
      description: 'The result, in the target format.',
    },
    {
      id: 'rendered',
      label: 'Rendered HTML',
      types: ['text'],
      description:
        'Always HTML, sanitised - the preview and Copy as rich text. Identical to Converted when Markdown becomes HTML.',
      presentation: 'html',
    },
    {
      id: 'detected',
      label: 'Detected',
      types: ['text'],
      description: 'What auto-detection concluded, and whether it was sure.',
    },
  ],

  optionsSchema: textConvertOptionsSchema,
  defaultOptions: textConvertDefaultOptions,
  optionFields: textConvertOptionFields,

  execution: {
    /*
     * Worker, not main. Parsing a large document builds a syntax tree several
     * times over - mdast, hast, and back - and 4 MB of it on the main thread
     * would drop frames. It is also why the sanitiser had to be a tree-based
     * one rather than DOMPurify: there is no `document` in here.
     */
    strategy: 'worker',
    requiresOffscreenCanvas: false,
    reportsProgress: false,
    timeoutMs: 15_000,
    maxInputBytes: 4 * 1024 * 1024,
  },

  /*
   * The conversion pipelines are imported DYNAMICALLY, inside run().
   *
   * Measured: with a static import, the markup libraries ended up inside the
   * worker's entry chunk. The worker is warmed when the canvas mounts, so that
   * is ~390 kB every canvas visitor pays whether or not they ever convert
   * anything. Loading it here makes it a sibling chunk fetched on first run.
   */
  run: async ({ inputs, options }) => {
    // `arrived`, not `source`: `source` below is the FORMAT this document is
    // in, which is a different question from where the characters came from.
    const arrived = inputs.input;
    const decoded = arrived.type === 'text' ? ok(arrived.text) : decodeDocument(arrived.bytes);
    if (!decoded.ok) return decoded;
    const text = decoded.value;

    if (text.trim() === '') {
      return fail('invalid-input', 'Nothing to convert: the input is empty.');
    }

    const detection = detectFormat(text);
    const source: SourceFormat = options.source === 'auto' ? detection.format : options.source;

    const note =
      options.source === 'auto'
        ? `${detection.format} (${detection.confidence}) - ${detection.reason}`
        : `${source} (chosen, not detected)`;

    const { htmlToMarkdown, htmlToText, markdownToHtml, sanitiseHtml } =
      await import('@/lib/markup/pipelines');

    const toHtmlOptions = { headingIds: options.headingIds, linkify: options.linkify };
    const toMarkdownOptions = {
      bullet: options.bullet,
      emphasis: options.emphasis,
      strong: options.strong,
      fence: options.fence,
      setext: options.headingStyle === 'setext',
      unsupported: options.unsupported,
    };
    const toTextOptions = {
      keepLinkUrls: options.keepLinkUrls,
      listMarker: options.listMarker,
      tables: options.tables,
    };

    try {
      /*
       * Everything routes through HTML, and that is the design rather than a
       * shortcut. HTML is the only one of the three that can express every
       * construct the others can, so it is the hub: Markdown in becomes HTML,
       * and HTML becomes whatever was asked for. It is also what makes
       * `rendered` free - the hub value IS the rendered output.
       */
      const html =
        source === 'markdown'
          ? markdownToHtml(text, toHtmlOptions)
          : /*
             * SANITISED HERE, not left as the input string.
             *
             * This value is the hub, and it is also what `rendered` carries
             * for two of the three targets - so passing the input through
             * unchanged put raw markup on a port that declares it is
             * sanitised, and from there onto the clipboard and into whatever
             * node was wired to it. The three pipelines below all sanitise
             * internally, so `output` is byte-identical either way; it is the
             * port that promised it which was wrong.
             */
            sanitiseHtml(text, { headingIds: options.headingIds });

      const output =
        options.target === 'html'
          ? // Coming from HTML to HTML still runs the pipeline: that is the
            // sanitise-and-normalise pass, not a copy.
            source === 'html'
            ? markdownToHtml(htmlToMarkdown(html, toMarkdownOptions), toHtmlOptions)
            : html
          : options.target === 'markdown'
            ? htmlToMarkdown(html, toMarkdownOptions)
            : htmlToText(html, toTextOptions);

      return ok({
        output: { type: 'text', text: output } as const,
        rendered: {
          type: 'text',
          // For a Markdown target this re-renders what was produced, which is
          // the semantic-stability invariant made visible: if the Markdown is
          // faithful, this looks like the HTML that went in.
          text: options.target === 'markdown' ? markdownToHtml(output, toHtmlOptions) : html,
        } as const,
        detected: { type: 'text', text: note } as const,
      });
    } catch (error) {
      /*
       * remark and rehype are total on string input - there is no such thing
       * as invalid Markdown, and the HTML parser recovers from anything. So
       * reaching here means a genuine fault rather than bad input, and it is
       * reported as one rather than blamed on the user's text.
       */
      return fail('internal', 'The converter failed on this input.', {
        detail: error instanceof Error ? error.message : undefined,
      });
    }
  },
});

const erased: ErasedTool = eraseTool(textConvertTool);
export default erased;
