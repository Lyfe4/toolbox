/**
 * The canvas route's search validation, and nothing else.
 *
 * Deliberately its own module with zero imports. The route that declares
 * `validateSearch` is loaded eagerly, so everything this file touches is paid
 * for by every visitor - including someone who only ever opens /tools.
 *
 * It is hand-written rather than a Zod schema for exactly that reason: this
 * check is "is it a string, is it short enough", and pulling a validator
 * library into the initial bundle to express that cost 52.6 kB raw / 14.4 kB
 * gzipped. The security-relevant validation - the decoded payload, which is
 * genuinely untrusted structured data - is still Zod, in the lazy chunk where
 * it belongs.
 */

export const SHARE_PARAM = 'p';

/**
 * Hard ceiling on the encoded payload, enforced before anything decompresses
 * it - a short URL must not be able to expand into hundreds of megabytes.
 */
export const MAX_SHARE_PARAM_LENGTH = 8_000;

export interface CanvasSearch {
  /** The compressed pipeline payload, absent unless the link carried one. */
  readonly p?: string | undefined;
}

/**
 * TanStack Router's `validateSearch` contract: take whatever was in the URL,
 * return the typed shape. Returning `CanvasSearch` is what makes
 * `Route.useSearch()` typed at the call site - the inference comes from this
 * function's return type, not from any schema library.
 *
 * Anything that is not a short string is dropped rather than rejected: a
 * stray or oversized `?p=` should land the user on an empty canvas, not on an
 * error page.
 */
export function validateCanvasSearch(search: Record<string, unknown>): CanvasSearch {
  const raw = search[SHARE_PARAM];

  if (typeof raw !== 'string' || raw === '' || raw.length > MAX_SHARE_PARAM_LENGTH) {
    return {};
  }

  return { [SHARE_PARAM]: raw };
}
