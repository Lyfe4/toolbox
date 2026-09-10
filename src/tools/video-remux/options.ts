import type { OptionField } from '@/features/registry/types';
import { z } from '@/lib/zod';

/**
 * ONE OPTION, AND THE REASON THERE IS ONLY ONE.
 *
 * Every other converter in this set has a quality dial or a target format,
 * because every other one re-encodes and therefore has a trade to offer. This
 * one does not: it copies the compressed frames across untouched, so there is
 * nothing to trade and no setting that could make the result better or worse.
 * The two entries below are two different jobs, not two settings.
 *
 * The feasibility investigation is emphatic about the setting that is NOT here.
 * A transcoding video tool has to put the speed-against-size choice in front of
 * the user - measured at 41 seconds and a file LARGER than its input at one
 * end, and 4 minutes 44 seconds at the other, for the same one-minute clip -
 * because a converter that picks silently will be wrong for half its users. A
 * remuxer has no such choice to hide, which is most of why it is the half
 * worth shipping first.
 */
export const videoOptionsSchema = z.object({
  operation: z.enum(['container', 'audio']).default('container'),
});

export type VideoOptions = z.output<typeof videoOptionsSchema>;

export const videoDefaultOptions: VideoOptions = videoOptionsSchema.parse({});

export const videoOptionFields: readonly OptionField<VideoOptions>[] = [
  {
    key: 'operation',
    label: 'Operation',
    description:
      'Neither one re-encodes: the frames are copied across exactly as they were, so both are lossless and both take about as long as reading the file.',
    control: 'select',
    choices: [
      { value: 'container', label: 'Repackage as MP4' },
      { value: 'audio', label: 'Extract the audio track' },
    ],
  },
];
