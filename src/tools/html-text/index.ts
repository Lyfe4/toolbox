import { defineTool, eraseTool, fail, ok, type ErasedTool } from '@/features/registry/types';

import { htmlTextDefaultOptions, htmlTextOptionFields, htmlTextOptionsSchema } from './options';

/**
 * HTML → Markdown, or HTML → plain text.
 *
 * The one-way counterpart to the Markdown tool, for the case that actually
 * comes up: something copied out of a page, an email or a CMS, which needs to
 * become text a human or a diff can read.
 *
 * Its output is never HTML, so it carries no `presentation: 'html'` hint and
 * gets no preview pane or rich-text copy - there would be nothing to preview.
 * Chain it into the Markdown tool if you want to see the result rendered; that
 * pairing is what the "Clean up pasted HTML" preset does.
 */
export const htmlTextTool = defineTool({
  id: 'html-text',
  name: 'HTML to text',
  summary: 'Turn HTML into Markdown, or strip it down to plain text.',
  category: 'text',

  inputs: [
    {
      id: 'input',
      label: 'HTML',
      types: ['text'],
      required: true,
      description: 'Any HTML fragment. It is sanitised before anything reads it.',
    },
  ],

  outputs: [
    {
      id: 'output',
      label: 'Converted',
      types: ['text'],
      description: 'Markdown or plain text, depending on the mode.',
    },
  ],

  optionsSchema: htmlTextOptionsSchema,
  defaultOptions: htmlTextDefaultOptions,
  optionFields: htmlTextOptionFields,

  execution: {
    // Worker, for the same reason as the Markdown tool: a tree-based parse of
    // up to 4 MB, and a sanitiser that needs no DOM.
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

    const { htmlToMarkdown, htmlToText } = await import('@/lib/markup/pipelines');

    try {
      const text =
        options.mode === 'markdown'
          ? htmlToMarkdown(source, {
              bullet: options.bullet,
              emphasis: options.emphasis,
              // Markdown's strong delimiter is not offered here: this tool has
              // one job and every extra control is one more thing between a
              // paste and a result.
              strong: '*',
              fence: options.fence,
              setext: false,
              unsupported: options.unsupported,
            })
          : htmlToText(source, {
              keepLinkUrls: options.keepLinkUrls,
              listMarker: options.listMarker,
              tables: options.tables,
            });

      return ok({ output: { type: 'text', text } as const });
    } catch (error) {
      // The HTML parser recovers from anything, so reaching here is a fault in
      // the converter rather than bad input, and is reported as one.
      return fail('internal', 'The converter failed on this input.', {
        detail: error instanceof Error ? error.message : undefined,
      });
    }
  },
});

const erased: ErasedTool = eraseTool(htmlTextTool);
export default erased;
