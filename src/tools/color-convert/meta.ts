import type { ToolManifestEntry } from '@/features/registry/types';

/**
 * What the rest of the app knows about this tool without loading its code:
 * the manifest imports this file eagerly and `index.ts` spreads it into the
 * definition, so the two cannot disagree. Data only - no import may bring
 * code into the initial bundle (`registry.test.ts` holds that).
 */
export const colorConvertMeta = {
  id: 'color-convert',
  name: 'Colour',
  summary: 'Convert between hex, rgb(), hsl() and oklch(), with contrast checks.',
  category: 'colour',
  keywords: ['color', 'colour', 'hex', 'rgb', 'hsl', 'oklch', 'contrast', 'wcag', 'a11y'],

  inputs: [
    {
      id: 'input',
      label: 'Colour',
      types: ['text', 'color'],
      required: true,
      description: '#3b82f6, rgb(59 130 246), hsl(217 91% 60%) or oklch(0.62 0.19 259).',
    },
  ],

  outputs: [
    {
      id: 'output',
      label: 'Converted',
      types: ['text'],
      description: 'The colour written in the target notation.',
    },
    {
      id: 'swatch',
      // 'Swatch', not 'Colour'. The input port is called 'Colour', and a node
      // reading `Colour` on the left and `Colour` on the right says nothing
      // about which is which - on a 224px node the labels are all there is.
      label: 'Swatch',
      types: ['color'],
      description: 'The parsed colour, previewed with its contrast against black and white.',
    },
    {
      id: 'all',
      // Was 'Every notation', which is 14 characters against an 84px label box
      // and was therefore drawn as 'Every notat…' on every node that had one.
      label: 'Notations',
      types: ['json'],
      description: 'The same colour as hex, rgb(), hsl() and oklch() at once.',
    },
    {
      /*
       * THE CHANNEL THIS TOOL DID NOT HAVE.
       *
       * Every other shipped tool that changes a value has somewhere to say so;
       * this one did not, and that single absence is what four findings in
       * `docs/test-findings.md` have in common. `oklch(0.7 0.4 150)` came back
       * as `oklch(0.7587 0.25817 142.5)` - lightness up, chroma down by 35%,
       * hue moved 7.5 degrees - with no warning anywhere, and the conversion
       * matrix recorded the cell as `lossy, told` regardless.
       *
       * It could not be fixed by writing a better sentence somewhere, because
       * the matrix's own definition of `lossy, told` is "told on the panel on
       * /tools AND on the canvas node", and a canvas node reads `warn` notes
       * off a port presented as a `report`. With no such port there was no
       * arrangement of words that could reach the bar.
       *
       * ADDITIVE, so no share link and no saved canvas changes: a new output
       * id is one more port to wire, never a different one.
       */
      id: 'report',
      label: 'Report',
      types: ['json'],
      description: 'What the parser had to change about the colour to answer.',
      presentation: 'report',
    },
  ],

  execution: {
    strategy: 'main',
    requiresOffscreenCanvas: false,
    timeoutMs: 5_000,
    // A colour is a few dozen characters. The cap is generous for a pasted
    // list that turns out to be one line, and absurd for anything else.
    maxInputBytes: 4 * 1024,
  },
} as const satisfies ToolManifestEntry;
