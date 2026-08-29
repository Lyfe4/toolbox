import * as z from 'zod/mini';

/**
 * The canvas route's search schema, and nothing else.
 *
 * Deliberately its own module with no other imports. The route that declares
 * `validateSearch` is loaded eagerly, so anything this file touches is paid for
 * by every visitor - including someone who only ever opens /tools. Importing
 * the full share module here pulled zod, the registry and the base64 codec into
 * the initial bundle and blew the size budget by 25 kB.
 *
 * `zod/mini` is the same validator with a tree-shakeable, function-style API,
 * which is a fraction of the size for a schema this small.
 */

export const SHARE_PARAM = 'p';

/**
 * Hard ceiling on the encoded payload, enforced before anything decompresses
 * it - a short URL must not be able to expand into hundreds of megabytes.
 */
export const MAX_SHARE_PARAM_LENGTH = 8_000;

export const canvasSearchSchema = z.object({
  [SHARE_PARAM]: z.optional(z.string().check(z.maxLength(MAX_SHARE_PARAM_LENGTH))),
});

export type CanvasSearch = z.infer<typeof canvasSearchSchema>;
