import {
  defineTool,
  eraseTool,
  ok,
  type ErasedTool,
  type JsonValue,
} from '@/features/registry/types';

import { jwtDefaultOptions, jwtOptionFields, jwtOptionsSchema } from './options';
import { decodeToken, describeClaims } from './token';
import { verifySignature } from './verify';

/**
 * Decode a JWT, and verify it where that is actually possible.
 *
 * The output is deliberately ordered with `signature` FIRST. Whatever renders
 * it - the JSON view here, a downstream tool, a copied-and-pasted result - the
 * first thing anyone reads is whether the claims below can be believed. A
 * decoder that leads with the payload invites people to trust data that a
 * fifteen-second edit can forge.
 */
export const jwtDecodeTool = defineTool({
  id: 'jwt-decode',
  name: 'JWT',
  summary: 'Decode a JSON Web Token, and verify its signature when you supply the key.',
  category: 'encoding',

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
    },
  ],

  optionsSchema: jwtOptionsSchema,
  defaultOptions: jwtDefaultOptions,
  optionFields: jwtOptionFields,

  /** The key is a user secret and is stripped before a graph is shared. */
  secretOptionKeys: ['key'],

  execution: {
    strategy: 'worker',
    requiresWasm: false,
    wasmModules: [],
    requiresOffscreenCanvas: false,
    reportsProgress: false,
    timeoutMs: 10_000,
    // A JWT in a header is a few kB at most; anything far past that is not a
    // token and should be refused before a parser sees it.
    maxInputBytes: 256 * 1024,
  },

  run: async ({ inputs, options }) => {
    const decoded = decodeToken(inputs.input.text);
    if (!decoded.ok) return decoded;

    const verification = await verifySignature({
      algorithm: decoded.value.algorithm,
      signingInput: decoded.value.signingInput,
      signature: decoded.value.signature,
      key: options.key,
      keyEncoding: options.keyEncoding,
    });

    const data: JsonValue = {
      signature: {
        algorithm: decoded.value.algorithm,
        verified: verification.status === 'verified',
        status: verification.summary,
        detail: verification.detail,
      },
      header: decoded.value.header,
      payload: decoded.value.payload,
      claims: describeClaims(decoded.value.payload, Date.now(), options.clockToleranceSec),
    };

    return ok({ output: { type: 'json', data } as const });
  },
});

const erased: ErasedTool = eraseTool(jwtDecodeTool);
export default erased;
