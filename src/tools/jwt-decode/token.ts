import {
  fail,
  isJsonObject,
  ok,
  type Bytes,
  type JsonValue,
  type ToolResult,
} from '@/features/registry/types';
import { decodeBase64 } from '@/lib/base64';

/**
 * JWT structure, with no opinions about trust.
 *
 * This module only takes a token apart. Whether any of it can be believed is
 * decided in verify.ts, and the two are kept separate on purpose: a decoder
 * that quietly implies trust is exactly the failure mode this tool exists to
 * avoid.
 */

/** Algorithms this tool can actually check, given a key. */
export const VERIFIABLE_ALGORITHMS = [
  'HS256',
  'HS384',
  'HS512',
  'RS256',
  'RS384',
  'RS512',
  'PS256',
  'PS384',
  'PS512',
  'ES256',
  'ES384',
  'ES512',
] as const;

export type VerifiableAlgorithm = (typeof VERIFIABLE_ALGORITHMS)[number];

export function isVerifiableAlgorithm(value: string): value is VerifiableAlgorithm {
  return (VERIFIABLE_ALGORITHMS as readonly string[]).includes(value);
}

export interface DecodedToken {
  readonly header: JsonValue;
  readonly payload: JsonValue;
  /** Raw signature bytes. Empty for an unsigned token. */
  readonly signature: Bytes;
  /** `header.payload` exactly as it appeared, which is what gets signed. */
  readonly signingInput: string;
  /** `alg` from the header, lowercased comparisons excluded - it is case-sensitive. */
  readonly algorithm: string | null;
}

function decodeSegment(segment: string, name: string): ToolResult<JsonValue> {
  const bytes = decodeBase64(segment);
  if (!bytes.ok) {
    return fail('parse-error', `The ${name} is not valid base64url.`);
  }

  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.value);
  } catch {
    return fail('parse-error', `The ${name} does not decode to UTF-8 text.`);
  }

  try {
    // JSON.parse returns `any`, so it is immediately narrowed to JsonValue -
    // the shape is guaranteed by JSON itself, and `any` must not escape.
    const parsed: unknown = JSON.parse(text);
    return ok(parsed as JsonValue);
  } catch {
    return fail('parse-error', `The ${name} is not valid JSON.`, { detail: text.slice(0, 120) });
  }
}

/** Reads a string property from a decoded JSON object, or null. */
function stringField(value: JsonValue, key: string): string | null {
  if (!isJsonObject(value)) return null;
  const field = value[key];
  return typeof field === 'string' ? field : null;
}

/** Reads a numeric property from a decoded JSON object, or null. */
export function numberField(value: JsonValue, key: string): number | null {
  if (!isJsonObject(value)) return null;
  const field = value[key];
  return typeof field === 'number' && Number.isFinite(field) ? field : null;
}

/**
 * Splits and decodes a compact-serialisation JWT.
 *
 * JWE (five segments) is refused rather than half-handled: its second segment
 * is an encrypted key, not a payload, and pretending otherwise would show the
 * user meaningless bytes labelled "payload".
 */
export function decodeToken(raw: string): ToolResult<DecodedToken> {
  const token = raw.trim().replace(/^Bearer\s+/i, '');
  if (token === '') return fail('invalid-input', 'Paste a JWT to decode.');

  const segments = token.split('.');

  if (segments.length === 5) {
    return fail('unsupported-type', 'That is a JWE (encrypted token), not a JWS.', {
      detail: 'Its contents cannot be read without the decryption key.',
    });
  }

  if (segments.length !== 3) {
    return fail('parse-error', 'A JWT has three dot-separated segments.', {
      detail: `This one has ${segments.length.toString()}.`,
    });
  }

  const [headerSegment = '', payloadSegment = '', signatureSegment = ''] = segments;

  const header = decodeSegment(headerSegment, 'header');
  if (!header.ok) return header;

  const payload = decodeSegment(payloadSegment, 'payload');
  if (!payload.ok) return payload;

  // An empty signature segment is legal in the serialisation and means the
  // token is unsigned. decodeBase64('') returns zero bytes, which is right.
  const signature = decodeBase64(signatureSegment);
  if (!signature.ok) {
    return fail('parse-error', 'The signature is not valid base64url.');
  }

  return ok({
    header: header.value,
    payload: payload.value,
    signature: signature.value,
    signingInput: `${headerSegment}.${payloadSegment}`,
    algorithm: stringField(header.value, 'alg'),
  });
}

/* ========================================================================== *
 * Registered claims
 * ========================================================================== */

export type ClaimReport = Readonly<Record<string, JsonValue>>;

function asIso(seconds: number | null): JsonValue {
  if (seconds === null) return null;
  const ms = seconds * 1000;
  // A nonsense timestamp must not become "Invalid Date" in a JSON document.
  if (!Number.isFinite(ms) || Math.abs(ms) > 8.64e15) return 'out of range';
  return new Date(ms).toISOString();
}

/**
 * Time-based claims, rendered readably.
 *
 * `nowMs` is a parameter rather than a call to Date.now() so the tests can pin
 * a moment; the tool passes the real clock.
 */
export function describeClaims(
  payload: JsonValue,
  nowMs: number,
  toleranceSec: number,
): ClaimReport {
  const exp = numberField(payload, 'exp');
  const iat = numberField(payload, 'iat');
  const nbf = numberField(payload, 'nbf');
  const nowSec = nowMs / 1000;

  return {
    issuedAt: asIso(iat),
    notBefore: asIso(nbf),
    expiresAt: asIso(exp),
    expired: exp === null ? false : nowSec > exp + toleranceSec,
    notYetValid: nbf === null ? false : nowSec + toleranceSec < nbf,
  };
}
