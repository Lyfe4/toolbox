import type { ToolManifestEntry } from '@/features/registry/types';

/**
 * What the rest of the app knows about this tool without loading its code:
 * the manifest imports this file eagerly and `index.ts` spreads it into the
 * definition, so the two cannot disagree. Data only - no import may bring
 * code into the initial bundle (`registry.test.ts` holds that).
 */
export const imageConvertMeta = {
  id: 'image-convert',
  name: 'Image',
  summary: 'Convert and resize images between PNG, JPEG and WebP.',
  category: 'encoding',
  keywords: ['png', 'jpeg', 'jpg', 'webp', 'resize', 'compress', 'convert', 'optimise'],

  inputs: [
    {
      id: 'input',
      label: 'Image',
      types: ['bytes'],
      required: true,
      description: 'A PNG, JPEG, GIF or WebP file. The format is read from the bytes.',
    },
  ],

  outputs: [
    {
      id: 'output',
      // 'Converted', matching the other three converters in the set. The old
      // 'Converted image' was 15 characters in an 84px label box, and the word
      // 'image' was already on the input port opposite it.
      label: 'Converted',
      types: ['bytes'],
      description: 'The re-encoded image. Carries no metadata from the original.',
    },
    {
      id: 'report',
      /*
       * `report`/'Report', where it was `info`/'Details'.
       *
       * The port declares `presentation: 'report'` and is drawn by
       * `ReportView`; calling it three different things in four places made
       * the one word that describes it the one word it never used. 'Details'
       * also undersells it - the notes here are changes to the image the user
       * did not ask for, which is the opposite of a detail.
       */
      label: 'Report',
      types: ['json'],
      description: 'What changed, then dimensions and sizes before and after.',
      /*
       * Not a JSON tree. Everything in `notes` below is a change to the image
       * the user did not ask for, and a caveat rendered as `JSON.stringify`
       * two panels down has not been said. See ReportView.
       */
      presentation: 'report',
    },
  ],

  execution: {
    strategy: 'worker',
    /** Downgrades to the main thread when the browser lacks OffscreenCanvas. */
    requiresOffscreenCanvas: true,
    timeoutMs: 60_000,
    // Generous, because a raw camera-sized PNG is genuinely tens of megabytes.
    // The limit that actually protects memory is the pixel cap in convert.ts.
    maxInputBytes: 64 * 1024 * 1024,
  },
} as const satisfies ToolManifestEntry;
