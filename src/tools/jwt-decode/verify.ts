import type { Bytes } from '@/features/registry/types';
import { decodeBase64, textToBytes } from '@/lib/base64';

import { isVerifiableAlgorithm, type VerifiableAlgorithm } from './token';

/**
 * SIGNATURE VERIFICATION
 *
 * The one rule this file exists to enforce: a signature is reported as valid
 * only when it was actually checked, cryptographically, against a key the user
 * supplied. Every other outcome - no key, an algorithm we cannot check, a
 * malformed key, `alg: none` - reports as NOT verified, in the same loud way.
 *
 * A decoder that shows a payload with no visible caveat is the real hazard
 * here: JWT payloads are base64, not encrypted, so anyone can rewrite one. The
 * signature is the only thing that says the claims came from who they say.
 */

export type VerificationStatus =
  /** Checked, and the signature is genuine. */
  | 'verified'
  /** Checked, and the signature does not match. The token is forged or altered. */
  | 'invalid'
  /** Not checked: no key was supplied. */
  | 'no-key'
  /** Not checked: the algorithm or key is not something we can handle here. */
  | 'unsupported'
  /** Refused outright: `alg: none`. See below. */
  | 'rejected';

export interface Verification {
  readonly status: VerificationStatus;
  /** One sentence, written to be read by the person holding the token. */
  readonly summary: string;
  readonly detail: string;
}

/** True only for the one status that means "you may rely on this". */
export function isTrustworthy(status: VerificationStatus): boolean {
  return status === 'verified';
}

const HASH_FOR: Record<VerifiableAlgorithm, 'SHA-256' | 'SHA-384' | 'SHA-512'> = {
  HS256: 'SHA-256',
  HS384: 'SHA-384',
  HS512: 'SHA-512',
  RS256: 'SHA-256',
  RS384: 'SHA-384',
  RS512: 'SHA-512',
  PS256: 'SHA-256',
  PS384: 'SHA-384',
  PS512: 'SHA-512',
  ES256: 'SHA-256',
  ES384: 'SHA-384',
  ES512: 'SHA-512',
};

/** ECDSA JWS signatures are fixed-width r||s; the curve sets the width. */
const CURVE_FOR: Partial<Record<VerifiableAlgorithm, 'P-256' | 'P-384' | 'P-521'>> = {
  ES256: 'P-256',
  ES384: 'P-384',
  ES512: 'P-521',
};

export type KeyEncoding = 'utf8' | 'base64url' | 'pem';

/** Strips the armour from a PEM block and decodes the base64 body. */
function pemBody(text: string): Bytes | null {
  const match = /-----BEGIN [A-Z ]+-----([\s\S]*?)-----END [A-Z ]+-----/.exec(text);
  if (!match?.[1]) return null;
  const decoded = decodeBase64(match[1].replace(/\s+/g, ''));
  return decoded.ok ? decoded.value : null;
}

function looksLikePem(text: string): boolean {
  return text.includes('-----BEGIN');
}

async function importKey(
  algorithm: VerifiableAlgorithm,
  key: string,
  encoding: KeyEncoding,
  subtle: SubtleCrypto,
): Promise<CryptoKey | null> {
  const hash = HASH_FOR[algorithm];

  if (algorithm.startsWith('HS')) {
    // A PEM public key is not an HMAC secret. Refusing is better than hashing
    // the literal armour text and reporting "invalid".
    if (looksLikePem(key)) return null;

    let secret: Bytes;
    if (encoding === 'base64url') {
      const decoded = decodeBase64(key);
      if (!decoded.ok) return null;
      secret = decoded.value;
    } else {
      secret = textToBytes(key);
    }

    return subtle.importKey('raw', secret, { name: 'HMAC', hash }, false, ['verify']);
  }

  // Everything else is a public-key algorithm, so the key must be SPKI PEM.
  const spki = pemBody(key);
  if (!spki) return null;

  if (algorithm.startsWith('ES')) {
    const namedCurve = CURVE_FOR[algorithm];
    if (!namedCurve) return null;
    return subtle.importKey('spki', spki, { name: 'ECDSA', namedCurve }, false, ['verify']);
  }

  const name = algorithm.startsWith('PS') ? 'RSA-PSS' : 'RSASSA-PKCS1-v1_5';
  return subtle.importKey('spki', spki, { name, hash }, false, ['verify']);
}

function verifyParams(
  algorithm: VerifiableAlgorithm,
): AlgorithmIdentifier | RsaPssParams | EcdsaParams {
  if (algorithm.startsWith('HS')) return { name: 'HMAC' };
  if (algorithm.startsWith('ES')) return { name: 'ECDSA', hash: HASH_FOR[algorithm] };
  if (algorithm.startsWith('PS')) {
    // RFC 7518 fixes the PSS salt length to the hash length.
    const bits = Number(algorithm.slice(2));
    return { name: 'RSA-PSS', saltLength: bits / 8 };
  }
  return { name: 'RSASSA-PKCS1-v1_5' };
}

const NOT_VERIFIED_DETAIL =
  'A JWT payload is base64, not encrypted - anyone can rewrite it. Without a verified ' +
  'signature these claims prove nothing about who issued them.';

/**
 * Verifies a token's signature, or explains precisely why it did not.
 *
 * Note that `alg: none` never reaches a verification path at all. It is a
 * real, historically exploited attack: a server that honours the header's
 * choice of algorithm can be handed a token with no signature and told to
 * accept it. This tool treats it as a red flag rather than as an algorithm.
 */
export async function verifySignature(input: {
  readonly algorithm: string | null;
  readonly signingInput: string;
  readonly signature: Bytes;
  readonly key: string;
  readonly keyEncoding: KeyEncoding;
}): Promise<Verification> {
  const { algorithm, signingInput, signature, key, keyEncoding } = input;

  if (algorithm === null) {
    return {
      status: 'unsupported',
      summary: 'NOT VERIFIED - the header declares no algorithm.',
      detail: NOT_VERIFIED_DETAIL,
    };
  }

  if (algorithm.toLowerCase() === 'none') {
    return {
      status: 'rejected',
      summary: 'REJECTED - this token claims the "none" algorithm, which means it is unsigned.',
      detail:
        'Treat this token as attacker-controlled. "alg: none" is a known attack against servers ' +
        'that trust the header to choose the algorithm; it is never a valid signature.',
    };
  }

  if (!isVerifiableAlgorithm(algorithm)) {
    return {
      status: 'unsupported',
      summary: `NOT VERIFIED - "${algorithm}" is not an algorithm this tool can check.`,
      detail: NOT_VERIFIED_DETAIL,
    };
  }

  if (key.trim() === '') {
    return {
      status: 'no-key',
      summary: `NOT VERIFIED - no key supplied, so the ${algorithm} signature was not checked.`,
      detail: `${NOT_VERIFIED_DETAIL} Supply the shared secret (HS*) or the public key in PEM form (RS*, PS*, ES*) to check it.`,
    };
  }

  // Typed as always present by the DOM lib, genuinely absent outside a secure
  // context. Reporting "not verified" is the only honest outcome there.
  const subtle = globalThis.crypto.subtle as SubtleCrypto | undefined;
  if (subtle === undefined) {
    return {
      status: 'unsupported',
      summary: 'NOT VERIFIED - WebCrypto is unavailable in this context.',
      detail: NOT_VERIFIED_DETAIL,
    };
  }

  let cryptoKey: CryptoKey | null;
  try {
    cryptoKey = await importKey(algorithm, key, keyEncoding, subtle);
  } catch {
    cryptoKey = null;
  }

  if (cryptoKey === null) {
    return {
      status: 'unsupported',
      summary: `NOT VERIFIED - that key could not be read as a ${algorithm} key.`,
      detail: algorithm.startsWith('HS')
        ? `${NOT_VERIFIED_DETAIL} HS* needs the raw shared secret, not a PEM block.`
        : `${NOT_VERIFIED_DETAIL} ${algorithm} needs a public key in SPKI PEM form ("-----BEGIN PUBLIC KEY-----").`,
    };
  }

  let valid: boolean;
  try {
    valid = await subtle.verify(
      verifyParams(algorithm),
      cryptoKey,
      signature,
      textToBytes(signingInput),
    );
  } catch {
    // A malformed signature (wrong length for the curve, say) throws rather
    // than returning false. That is a failed check, not a verified token.
    valid = false;
  }

  return valid
    ? {
        status: 'verified',
        summary: `VERIFIED - the ${algorithm} signature matches the key you supplied.`,
        detail: 'The header and payload below have not been altered since they were signed.',
      }
    : {
        status: 'invalid',
        summary: `INVALID - the ${algorithm} signature does not match the key you supplied.`,
        detail: 'Either the key is wrong or the token has been altered. Do not trust these claims.',
      };
}
