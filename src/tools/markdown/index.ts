import { defineTool, eraseTool, fail, ok, type ErasedTool } from '@/features/registry/types';

import { markdownDefaultOptions, markdownOptionFields, markdownOptionsSchema } from './options';

/**
 * Markdown ⇄ HTML.
 *
 * TWO OUTPUTS, and the second one needs explaining.
 *
 * `output` is the conversion in whichever direction was asked for - HTML going
 * one way, Markdown the other - and it is what chains onward to a diff or a
 * hash.
 *
 * `rendered` is ALWAYS HTML. Going md → html it is the same string. Going
 * html → md it is the produced Markdown rendered back to HTML, which is a more
 * useful thing than it first sounds:
 *
 *   - Every declared output must be produced (see OutputsOf), so a port that
 *     only sometimes carries HTML cannot be typed. Making one that always does
 *     is what lets `presentation: 'html'` be a fact rather than a guess, and
 *     the preview pane and "copy as rich text" hang off that fact.
 *   - It is the semantic-stability invariant made visible: if the Markdown
 *     this tool produced is faithful, `rendered` looks like the HTML that went
 *     in. If it does not, the conversion lost something and you can see what.
 */
export const markdownTool = defineTool({
  id: 'markdown',
  name: 'Markdown',
  summary: 'Convert Markdown to HTML and HTML back to Markdown, with GitHub Flavoured syntax.',
  category: 'text',

  inputs: [
    {
      id: 'input',
      label: 'Input',
      types: ['text'],
      required: true,
      description: 'Markdown, or HTML - whichever the direction expects.',
    },
  ],

  outputs: [
    {
      id: 'output',
      label: 'Converted',
      types: ['text'],
      description: 'HTML, or Markdown, depending on the direction.',
    },
    {
      id: 'rendered',
      label: 'Rendered HTML',
      types: ['text'],
      description: 'Always HTML, sanitised. This is what the preview shows.',
      presentation: 'html',
    },
  ],

  optionsSchema: markdownOptionsSchema,
  defaultOptions: markdownDefaultOptions,
  optionFields: markdownOptionFields,

  execution: {
    /*
     * Worker, not main. Parsing a large README builds a syntax tree several
     * times over - mdast, hast, and back - and 4 MB of it on the main thread
     * would drop frames. It is also the reason the sanitiser had to be a
     * tree-based one rather than DOMPurify: there is no `document` in here.
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
   * worker's entry chunk, taking it from 231 kB to 621 kB raw. The worker is
   * warmed when the canvas mounts, so that is 390 kB every canvas visitor pays
   * whether or not they ever convert any Markdown.
   *
   * Loading it here makes it a sibling chunk fetched on first run instead, which
   * is the same bargain the tool registry already makes: the manifest is eager
   * so the canvas can reason about ports, and the code arrives when it is used.
   */
  run: async ({ inputs, options }) => {
    const source = inputs.input.text;

    if (source.trim() === '') {
      return fail('invalid-input', 'Nothing to convert: the input is empty.');
    }

    const toHtml = {
      headingIds: options.headingIds,
      linkify: options.linkify,
    };

    const toMarkdown = {
      bullet: options.bullet,
      emphasis: options.emphasis,
      strong: options.strong,
      fence: options.fence,
      setext: options.headingStyle === 'setext',
      unsupported: options.unsupported,
    };

    const { htmlToMarkdown, markdownToHtml } = await import('@/lib/markup/pipelines');

    try {
      if (options.direction === 'md-to-html') {
        const html = markdownToHtml(source, toHtml);
        return ok({
          output: { type: 'text', text: html } as const,
          rendered: { type: 'text', text: html } as const,
        });
      }

      const markdown = htmlToMarkdown(source, toMarkdown);
      return ok({
        output: { type: 'text', text: markdown } as const,
        // The Markdown we just produced, rendered. See the note above.
        rendered: { type: 'text', text: markdownToHtml(markdown, toHtml) } as const,
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

const erased: ErasedTool = eraseTool(markdownTool);
export default erased;
