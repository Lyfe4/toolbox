import type { ToolManifestEntry } from '@/features/registry/types';

/**
 * What the rest of the app knows about this tool without loading its code:
 * the manifest imports this file eagerly and `index.ts` spreads it into the
 * definition, so the two cannot disagree. Data only - no import may bring
 * code into the initial bundle (`registry.test.ts` holds that).
 */
export const timestampMeta = {
  id: 'timestamp',
  name: 'Timestamp',
  summary: 'Convert between Unix time, RFC 3339 and readable dates in any time zone.',
  category: 'time',
  keywords: [
    'unix',
    'epoch',
    'time',
    'date',
    'iso 8601',
    'rfc 3339',
    'time zone',
    'timezone',
    'utc',
    'milliseconds',
    'nanoseconds',
    'exp',
    'iat',
    'dst',
  ],

  inputs: [
    {
      id: 'input',
      label: 'Timestamp',
      /*
       * `json` so that a decoded JWT's `exp` can be wired in: jwt-decode's one
       * output is `json`, and a text-only port would make the wire illegal to
       * draw. Field names the member. Not `bytes`: a timestamp is a short
       * literal, like a colour, and the port rules keep bytes for documents.
       */
      types: ['text', 'json'],
      required: true,
      description:
        '1727308800, 2024-09-26T08:00:00+02:00 or Thu, 26 Sep 2024 06:00:00 GMT - or wired JSON, with Field naming the member.',
    },
  ],

  outputs: [
    {
      id: 'output',
      label: 'Converted',
      types: ['text'],
      description: 'The instant in the chosen notation.',
    },
    {
      id: 'all',
      label: 'Notations',
      types: ['json'],
      description:
        'The same instant as Unix time in every unit, RFC 3339 and a readable date at once, each exact.',
    },
    {
      id: 'report',
      label: 'Report',
      types: ['json'],
      description: 'What was read, what was assumed, and anything the conversion could not carry.',
      presentation: 'report',
    },
  ],

  execution: {
    // Main thread: a parse and a handful of `Intl` calls on a short string.
    // A worker round trip would cost more than the work.
    strategy: 'main',
    requiresOffscreenCanvas: false,
    timeoutMs: 5_000,
    // A timestamp is a few dozen characters. The cap is for a wired JSON
    // value, which Field then reads one member of.
    maxInputBytes: 256 * 1024,
  },
} as const satisfies ToolManifestEntry;
