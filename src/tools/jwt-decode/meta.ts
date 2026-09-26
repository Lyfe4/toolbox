import type { ToolManifestEntry } from '@/features/registry/types';

/**
 * What the rest of the app knows about this tool without loading its code:
 * the manifest imports this file eagerly and `index.ts` spreads it into the
 * definition, so the two cannot disagree. Data only - no import may bring
 * code into the initial bundle (`registry.test.ts` holds that).
 */
export const jwtDecodeMeta = {
  id: 'jwt-decode',
  name: 'JWT',
  summary: 'Decode a JSON Web Token, and verify its signature when you supply the key.',
  category: 'encoding',
  keywords: ['jwt', 'jws', 'token', 'bearer', 'claims', 'signature', 'hs256', 'rs256'],

  inputs: [
    {
      id: 'input',
      label: 'Token',
      types: ['text'],
      required: true,
      description: 'A compact JWT: header.payload.signature.',
    },
  ],

  outputs: [
    {
      id: 'output',
      label: 'Decoded',
      types: ['json'],
      description: 'Signature verdict first, then the header and payload.',
      /*
       * Not a JSON tree. The verdict is the reason anybody opens a JWT
       * decoder, and as `JSON.stringify` it is a line of braces among other
       * braces - directly above claims that base64 makes trivial to forge.
       * See JwtView.
       */
      presentation: 'jwt',
    },
    {
      /*
       * A SECOND PORT, AND NOT THE ONE THAT WAS ARGUED AGAINST.
       *
       * The port audit rejected a `payload` output carrying just the claims,
       * because its entire effect would be to detach the claims from the
       * signature verdict - which is the one thing this tool's design exists to
       * prevent. That argument is about a port carrying CLAIMS. This one
       * carries none.
       *
       * What it carries is the loss the matrix has recorded since round one: a
       * `sub` or a `jti` that is a 64-bit key or a snowflake is rounded by
       * `JSON.parse`, so the decoder shows a different number from the one the
       * issuer signed. There is no way to avoid that in a JavaScript program
       * and no reason to be quiet about it, and a `ToolResult` is a value or an
       * error, so it needed somewhere to go.
       */
      id: 'report',
      label: 'Report',
      types: ['json'],
      description: 'Anything about the token the decoded value cannot carry exactly.',
      presentation: 'report',
    },
  ],

  execution: {
    strategy: 'worker',
    requiresOffscreenCanvas: false,
    timeoutMs: 10_000,
    // A JWT in a header is a few kB at most; anything far past that is not a
    // token and should be refused before a parser sees it.
    maxInputBytes: 256 * 1024,
  },

  /** The key is a user secret and is stripped before a graph is shared. */
  secretOptionKeys: ['key'],
} as const satisfies ToolManifestEntry;
