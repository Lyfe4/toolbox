import type { ToolManifestEntry } from '@/features/registry/types';

/**
 * What the rest of the app knows about this tool without loading its code:
 * the manifest imports this file eagerly and `index.ts` spreads it into the
 * definition, so the two cannot disagree. Data only - no import may bring
 * code into the initial bundle (`registry.test.ts` holds that).
 */
export const textConvertMeta = {
  id: 'text-convert',
  name: 'Text convert',
  summary: 'Convert between Markdown, HTML and plain text, with GitHub Flavoured syntax.',
  category: 'text',
  keywords: [
    'md',
    'gfm',
    'commonmark',
    'readme',
    'render',
    'rich text',
    'strip tags',
    'plain',
    'scrape',
    'clean',
    'unhtml',
  ],

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
        'Always HTML, sanitised - the preview and Copy as rich text. Identical to Converted when Markdown becomes HTML, and when HTML becomes HTML (sanitised).',
      presentation: 'html',
    },
    {
      id: 'detected',
      label: 'Detected',
      types: ['text'],
      description: 'What auto-detection concluded, and whether it was sure.',
    },
    {
      /*
       * WHAT THE CONVERSION CHANGED THAT NOBODY ASKED IT TO.
       *
       * `detected` says what format was read, in one sentence written for a
       * person, and it is a `text` port that things are wired to. This is a
       * different question with more than one answer: `HTML → HTML` and
       * `Markdown → Markdown` are normalising passes that go out through
       * another format and back, and both of them drop and INVENT things -
       * a headerless table gains an empty header row, a footnote becomes raw
       * `<sup>` markup - with nothing anywhere to say so.
       *
       * A fourth port rather than reshaping `detected` into this one. Changing
       * that port's data type from `text` to `json` would make every existing
       * edge out of it illegal, and `firstRefusedEdge` refuses the WHOLE
       * document - so a share link with `detected → hash` would stop opening
       * rather than degrade. A new port breaks nothing.
       */
      id: 'report',
      label: 'Report',
      types: ['json'],
      description: 'What the conversion changed or invented, and what it could not carry.',
      presentation: 'report',
    },
  ],

  execution: {
    /*
     * Worker, not main. Parsing a large document builds a syntax tree several
     * times over - mdast, hast, and back - and 4 MB of it on the main thread
     * would drop frames. It is also why the sanitiser had to be a tree-based
     * one rather than DOMPurify: there is no `document` in here.
     */
    strategy: 'worker',
    requiresOffscreenCanvas: false,
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
} as const satisfies ToolManifestEntry;
