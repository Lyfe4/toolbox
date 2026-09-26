/**
 * Whether a token is usable at a given moment.
 *
 * NOT CALLED BY THE TOOL, and that is the point of this file. The tool's output
 * is cached on its inputs and re-served for as long as they stay the same, so
 * anything on it has to be as true tomorrow as it was when it ran - and "has
 * this token expired?" is a question about the moment somebody reads the
 * answer, not the moment it was computed. The tool used to decide it from
 * `Date.now()` inside the run, and a canvas node went on saying a token was
 * live for as long as the cache held its result.
 *
 * So the tool carries the facts - `exp`, `nbf` and the tolerance the user
 * chose - and the view calls this with its own clock, as it draws. It lives
 * beside the tool rather than in the view because it is the tool's rule, RFC
 * 7519 sections 4.1.4 and 4.1.5 with the tolerance they allow, and one
 * definition is what keeps the margin from being decided two ways.
 */

export type Validity = 'expired' | 'not-yet' | 'live';

export interface TimeClaims {
  /** `exp`, in epoch seconds, or null if the token has none. */
  readonly exp: number | null;
  /** `nbf`, in epoch seconds, or null if the token has none. */
  readonly nbf: number | null;
  readonly toleranceSec: number;
}

/**
 * Expired wins over not-yet-valid, as it always has here: a token whose `exp`
 * is before its `nbf` is unusable either way, and "expired" is the one a
 * server will say.
 *
 * Null when the token states neither time: a token with no `exp` has not "not
 * expired", it never said.
 */
export function validityAt(claims: TimeClaims, nowMs: number): Validity | null {
  const nowSec = nowMs / 1000;
  if (claims.exp !== null && nowSec > claims.exp + claims.toleranceSec) return 'expired';
  if (claims.nbf !== null && nowSec + claims.toleranceSec < claims.nbf) return 'not-yet';
  return claims.exp === null && claims.nbf === null ? null : 'live';
}
