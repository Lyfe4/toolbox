import { defineTool, eraseTool, fail, ok, type ErasedTool } from '@/features/registry/types';

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
 * THREE OUTPUTS. `output` is the conversion. `rendered` is always HTML, which
 * is what makes `presentation: 'html'` a fact rather than a guess and hangs the
 * preview and rich-text copy off it. `detected` reports what auto-detection
 * concluded and how sure it was, so a wrong guess is visible rather than
 * silent.
 */
export const textConvertTool = defineTool({
  id: 'text-convert',
  name: 'Text convert',
  summary: 'Convert between Markdown, HTML and plain text, with GitHub Flavoured syntax.',
  category: 'text',

  inputs: [
    {
      id: 'input',
      label: 'Input',
      types: ['text'],
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
      description: 'Always HTML, sanitised. This is what the preview shows.',
      presentation: 'html',
    },
    {
      id: 'detected',
      label: 'Detected source',
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
    requiresWasm: false,
    wasmModules: [],
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
    const text = inputs.input.text;

    if (text.trim() === '') {
      return fail('invalid-input', 'Nothing to convert: the input is empty.');
    }

    const detection = detectFormat(text);
    const source: SourceFormat = options.source === 'auto' ? detection.format : options.source;

    const note =
      options.source === 'auto'
        ? `${detection.format} (${detection.confidence}) - ${detection.reason}`
        : `${source} (chosen, not detected)`;

    const { htmlToMarkdown, htmlToText, markdownToHtml } = await import('@/lib/markup/pipelines');

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
      const html = source === 'markdown' ? markdownToHtml(text, toHtmlOptions) : text;

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
