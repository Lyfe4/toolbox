import type { OptionField } from '@/features/registry/types';
import { z } from '@/lib/zod';

import { OUTPUT_FORMATS } from './convert';

export const imageOptionsSchema = z.object({
  format: z.enum(OUTPUT_FORMATS).default('image/webp'),
  /** 0-1. PNG ignores it, being lossless. */
  quality: z.number().min(0.1).max(1).default(0.85),
  /** Longest edge after scaling. 0 keeps the original size. */
  maxEdge: z.number().int().min(0).max(16_384).default(0),
});

export type ImageOptions = z.output<typeof imageOptionsSchema>;

export const imageDefaultOptions: ImageOptions = imageOptionsSchema.parse({});

export const imageOptionFields: readonly OptionField<ImageOptions>[] = [
  {
    key: 'format',
    label: 'Convert to',
    control: 'select',
    choices: [
      { value: 'image/webp', label: 'WebP' },
      { value: 'image/jpeg', label: 'JPEG' },
      { value: 'image/png', label: 'PNG (lossless)' },
    ],
  },
  {
    key: 'quality',
    label: 'Quality',
    description: '0.1 to 1. Lower is smaller and softer; 1 is the best this encoder will do.',
    control: 'number',
    min: 0.1,
    max: 1,
    step: 0.05,
    /*
     * PNG is lossless and its encoder ignores quality entirely - measured: the
     * same 16x16 image comes out at exactly the same byte count at 0.1 and at
     * 1 in both Firefox and WebKit. A control that silently does nothing is
     * the `cursor: pointer` with no handler problem in another costume, so it
     * is hidden rather than left there to be fiddled with. The value survives
     * the hiding and comes back the moment the target is lossy again, and the
     * `info` output still carries a note saying quality did not apply - the
     * panel is not the only consumer of this tool.
     */
    when: (options) => options.format !== 'image/png',
  },
  {
    key: 'maxEdge',
    label: 'Longest edge (pixels)',
    description: '0 keeps the original size. Scaling preserves the aspect ratio.',
    control: 'number',
    min: 0,
    max: 16_384,
    step: 64,
  },
];
