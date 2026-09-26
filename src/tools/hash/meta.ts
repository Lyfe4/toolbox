import type { ToolManifestEntry } from '@/features/registry/types';

/**
 * What the rest of the app knows about this tool without loading its code:
 * the manifest imports this file eagerly and `index.ts` spreads it into the
 * definition, so the two cannot disagree. Data only - no import may bring
 * code into the initial bundle (`registry.test.ts` holds that).
 */
export const hashMeta = {
  id: 'hash',
  name: 'Hash',
  summary: 'MD5, SHA-1, SHA-256, SHA-384 and SHA-512 digests of text or files.',
  category: 'hashing',
  keywords: ['md5', 'sha', 'sha1', 'sha256', 'digest', 'checksum', 'fingerprint'],

  inputs: [
    {
      id: 'input',
      label: 'Input',
      types: ['text', 'bytes'],
      required: true,
      description: 'Text or a file to fingerprint.',
    },
  ],

  /*
   * `output`, not `digest`, and the rename cost a migration.
   *
   * Every other tool in the set calls its first output `output`, and that
   * ordering is load-bearing: `resultSummary` shows the FIRST declared output
   * on a node because "the first port is the tool's answer and the rest are
   * its working". One tool spelling it differently made that a per-tool lookup
   * instead of a structural fact, and `ports.test.ts` now asserts the
   * convention for every tool at once. The LABEL stays "Digest" - the id is
   * the wiring identity, the label is the human word for the value.
   */
  outputs: [
    {
      id: 'output',
      label: 'Digest',
      types: ['text'],
      description: 'The fingerprint, in the chosen encoding and case.',
    },
  ],

  execution: {
    strategy: 'worker',
    requiresOffscreenCanvas: false,
    timeoutMs: 30_000,
    maxInputBytes: 64 * 1024 * 1024,
  },
} as const satisfies ToolManifestEntry;
