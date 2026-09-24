import {
  defineTool,
  eraseTool,
  ok,
  type ErasedTool,
  type JsonValue,
} from '@/features/registry/types';
import { lossLine, lost, notesToJson, type ToolNote } from '@/lib/notes';

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

  optionsSchema: jwtOptionsSchema,
  defaultOptions: jwtDefaultOptions,
  optionFields: jwtOptionFields,

  /** The key is a user secret and is stripped before a graph is shared. */
  secretOptionKeys: ['key'],

  execution: {
    strategy: 'worker',
    requiresOffscreenCanvas: false,
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
        /*
         * The outcome as a TOKEN rather than as prose, beside the prose.
         *
         * `verified: false` covers five different situations - no key, an
         * algorithm we cannot check, a key that would not import, a signature
         * that did not match, and `alg: none` - and the difference between
         * "nobody checked" and "it is forged" is the entire content of this
         * output. Anything drawing this had only `status`, a sentence written
         * for a human, and sniffing prose for the word INVALID is not a way to
         * decide how loudly to shout. See JwtView.
         */
        state: verification.status,
        status: verification.summary,
        detail: verification.detail,
      },
      header: decoded.value.header,
      payload: decoded.value.payload,
      claims: describeClaims(decoded.value.payload, Date.now(), options.clockToleranceSec),
    };

    const rounded = decoded.value.roundedClaims;
    const notes: ToolNote[] =
      rounded.length === 0
        ? []
        : [
            lost(
              rounded.length === 1
                ? `The claim at ${rounded[0]?.path ?? ''} was rounded`
                : `${rounded.length.toString()} claims were rounded`,
              `JavaScript has one numeric type and it is a double, so an integer past 2^53 cannot be held exactly. ${rounded[0]?.source ?? ''} became ${(rounded[0]?.value ?? 0).toString()}. A 64-bit database key, a snowflake or a nanosecond timestamp in a claim is therefore NOT the number the issuer signed, at ${rounded
                .slice(0, 5)
                .map((entry) => entry.path)
                .join(
                  ', ',
                )}. The signature is still verified against the original bytes, which this rounding does not touch.`,
              // The decoded token. The signature verdict on the same port is
              // unaffected - the note says so - but the claims are the port.
              ['output'],
            ),
          ];

    const losses = lossLine(notes);

    return ok({
      output: { type: 'json', data } as const,
      report: {
        type: 'json',
        data: {
          summary: `${decoded.value.algorithm ?? 'no alg'}${losses === null ? '' : ` · ${losses}`}`,
          notes: notesToJson(notes),
        },
      } as const,
    });
  },
});

const erased: ErasedTool = eraseTool(jwtDecodeTool);
export default erased;
