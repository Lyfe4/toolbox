import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';

import {
  isJsonObject,
  type Bytes,
  type JsonValue,
  type ToolRunContext,
} from '@/features/registry/types';
import { decodeBase64, encodeBase64, textToBytes } from '@/lib/base64';

import jwtTool from './index';
import rfc4231 from './spec/rfc4231.json';
import rfc7515 from './spec/rfc7515.json';
import rfc7520 from './spec/rfc7520.json';
import wycheproof from './spec/wycheproof.json';
import { decodeToken, describeClaims, VERIFIABLE_ALGORITHMS } from './token';
import { validityAt } from './validity';
import {
  isTrustworthy,
  verifySignature,
  type KeyEncoding,
  type VerificationStatus,
} from './verify';

const context: ToolRunContext = {
  signal: new AbortController().signal,
};

const b64url = (text: string): string =>
  encodeBase64(textToBytes(text), { urlSafe: true, padding: false, wrapAt: 0 });

/** Builds a token with an arbitrary (possibly wrong) signature segment. */
function tokenOf(header: JsonValue, payload: JsonValue, signature = 'c2ln'): string {
  return `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}.${signature}`;
}

/** A real HS256 signature over the signing input, for the verified path. */
async function signHs256(signingInput: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    textToBytes(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, textToBytes(signingInput));
  return encodeBase64(new Uint8Array(signature), {
    urlSafe: true,
    padding: false,
    wrapAt: 0,
  });
}

describe('decoding', () => {
  it('splits a token into its header and payload', () => {
    const result = decodeToken(tokenOf({ alg: 'HS256', typ: 'JWT' }, { sub: '42', name: 'Ada' }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.algorithm).toBe('HS256');
    expect(result.value.payload).toEqual({ sub: '42', name: 'Ada' });
  });

  it('tolerates a leading "Bearer "', () => {
    const raw = tokenOf({ alg: 'HS256' }, { a: 1 });
    expect(decodeToken(`Bearer ${raw}`).ok).toBe(true);
  });

  it.each([
    ['not a token at all', 'plain text'],
    ['a.b', 'two segments'],
    ['a.b.c.d', 'four segments'],
  ])('refuses %j (%s)', (input) => {
    const result = decodeToken(input);
    expect(result.ok).toBe(false);
  });

  it('refuses a JWE rather than showing its encrypted key as a payload', () => {
    const result = decodeToken('a.b.c.d.e');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('JWE');
  });

  it('reports a payload that is not JSON rather than throwing', () => {
    const result = decodeToken(`${b64url('{"alg":"HS256"}')}.${b64url('not json')}.sig`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('parse-error');
  });

  it('round-trips any JSON object through the segments', () => {
    fc.assert(
      fc.property(
        fc.dictionary(fc.string(), fc.oneof(fc.string(), fc.integer(), fc.boolean())),
        (payload) => {
          const result = decodeToken(tokenOf({ alg: 'HS256' }, payload));
          expect(result.ok).toBe(true);
          if (!result.ok) return;
          expect(result.value.payload).toEqual(payload);
        },
      ),
    );
  });
});

describe('signature verification', () => {
  const signingInput = 'header.payload';
  const empty = new Uint8Array(0);

  it('verifies a genuine HS256 signature', async () => {
    const header = b64url('{"alg":"HS256"}');
    const payload = b64url('{"sub":"1"}');
    const input = `${header}.${payload}`;
    const signature = await signHs256(input, 'topsecret');

    const decoded = decodeToken(`${input}.${signature}`);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;

    const verification = await verifySignature({
      algorithm: 'HS256',
      signingInput: decoded.value.signingInput,
      signature: decoded.value.signature,
      key: 'topsecret',
      keyEncoding: 'utf8',
    });

    expect(verification.status).toBe('verified');
    expect(verification.summary).toContain('VERIFIED');
  });

  it('reports a wrong key as invalid, not as unverified', async () => {
    const header = b64url('{"alg":"HS256"}');
    const payload = b64url('{"sub":"1"}');
    const input = `${header}.${payload}`;
    const signature = await signHs256(input, 'topsecret');

    const decoded = decodeToken(`${input}.${signature}`);
    if (!decoded.ok) throw new Error('fixture is malformed');

    const verification = await verifySignature({
      algorithm: 'HS256',
      signingInput: decoded.value.signingInput,
      signature: decoded.value.signature,
      key: 'wrong',
      keyEncoding: 'utf8',
    });

    // The distinction matters: "not checked" and "checked and forged" are
    // very different pieces of news.
    expect(verification.status).toBe('invalid');
    expect(verification.summary).toContain('INVALID');
  });

  it('says NOT VERIFIED, unmistakably, when no key is supplied', async () => {
    const verification = await verifySignature({
      algorithm: 'HS256',
      signingInput,
      signature: empty,
      key: '',
      keyEncoding: 'utf8',
    });

    expect(verification.status).toBe('no-key');
    expect(verification.summary).toContain('NOT VERIFIED');
    expect(verification.detail).toContain('prove nothing');
  });

  /*
   * The security case for this tool. "alg: none" is a real attack on servers
   * that let the token choose its own algorithm, so it must never reach a
   * verification path and must never be reported as anything but rejected -
   * with or without a key, and whatever case it is written in.
   */
  it.each(['none', 'None', 'NONE'])('never accepts "%s" as an algorithm', async (algorithm) => {
    for (const key of ['', 'a-key-that-should-not-matter']) {
      const verification = await verifySignature({
        algorithm,
        signingInput,
        signature: empty,
        key,
        keyEncoding: 'utf8',
      });

      expect(verification.status).toBe('rejected');
      expect(verification.summary).toContain('REJECTED');
    }
  });

  it('refuses an algorithm it cannot check rather than staying silent', async () => {
    const verification = await verifySignature({
      algorithm: 'HS1024',
      signingInput,
      signature: empty,
      key: 'secret',
      keyEncoding: 'utf8',
    });

    expect(verification.status).toBe('unsupported');
    expect(verification.summary).toContain('NOT VERIFIED');
  });

  it('does not treat a PEM block as an HMAC secret', async () => {
    const verification = await verifySignature({
      algorithm: 'HS256',
      signingInput,
      signature: empty,
      key: '-----BEGIN PUBLIC KEY-----\nMFkw\n-----END PUBLIC KEY-----',
      keyEncoding: 'utf8',
    });

    expect(verification.status).toBe('unsupported');
    expect(verification.detail).toContain('not a PEM block');
  });
});

describe('registered claims', () => {
  // 2026-01-01T00:00:00Z, pinned so the assertions do not rot.
  const now = Date.UTC(2026, 0, 1);
  const nowSec = now / 1000;

  it('renders timestamps as ISO strings', () => {
    const claims = describeClaims({ iat: nowSec }, 0);
    expect(claims.issuedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('does not produce "Invalid Date" for a nonsense timestamp', () => {
    const claims = describeClaims({ exp: 1e30 }, 0);
    expect(claims.expiresAt).toBe('out of range');
  });

  /*
   * No verdict on the port. expired, notYetValid and checkedAt were each
   * true at the moment of the run and at no other, and the run is cached.
   */
  it('carries the facts a verdict needs and no verdict', () => {
    const claims = describeClaims({ iat: nowSec, nbf: nowSec, exp: nowSec + 60 }, 30);
    expect(Object.keys(claims).sort()).toEqual([
      'expiresAt',
      'issuedAt',
      'notBefore',
      'toleranceSeconds',
    ]);
    expect(claims.toleranceSeconds).toBe(30);
  });
});

describe('whether a token is usable, at a given moment', () => {
  const now = Date.UTC(2026, 0, 1);
  const nowSec = now / 1000;
  const at = (claims: { exp?: number; nbf?: number }, tolerance = 0, moment = now) =>
    validityAt(
      { exp: claims.exp ?? null, nbf: claims.nbf ?? null, toleranceSec: tolerance },
      moment,
    );

  it('marks an expired token as expired', () => {
    expect(at({ exp: nowSec - 60 })).toBe('expired');
  });

  it('honours the clock tolerance', () => {
    expect(at({ exp: nowSec - 60 }, 120)).toBe('live');
    expect(at({ nbf: nowSec + 60 }, 120)).toBe('live');
  });

  it('marks a not-yet-valid token', () => {
    expect(at({ nbf: nowSec + 600 })).toBe('not-yet');
  });

  /*
   * RFC 7519 4.1.4: the token MUST NOT be accepted ON OR AFTER `exp`... and
   * this tool has always read it as strictly after, with the tolerance as the
   * margin. Held at the second so a change to either side of the comparison
   * is a failing test rather than a silent shift.
   */
  it('turns at the second after exp plus the tolerance, not before', () => {
    expect(at({ exp: nowSec }, 0, now)).toBe('live');
    expect(at({ exp: nowSec }, 0, now + 1)).toBe('expired');
    expect(at({ exp: nowSec }, 10, now + 10_000)).toBe('live');
    expect(at({ exp: nowSec }, 10, now + 10_001)).toBe('expired');
  });

  it('says expired over not-yet when a token is both', () => {
    expect(at({ exp: nowSec - 60, nbf: nowSec + 60 })).toBe('expired');
  });

  it('says nothing about a token that states neither time', () => {
    expect(at({})).toBeNull();
    expect(at({ nbf: nowSec - 60 })).toBe('live');
  });
});

describe('the tool', () => {
  /*
   * THE CACHE'S ONE PRECONDITION, HELD FOR THE TOOL THAT BROKE IT.
   *
   * A canvas node is re-run only when its key changes, and the key is the
   * tool, its options and its inputs - so a result is served again for as long
   * as the graph stays the same. This tool used to stamp `Date.now()` into its
   * output and decide `expired` from it, so the cached answer to "has this
   * token expired?" was the answer at the moment it ran, served as if it were
   * the answer now. Two runs of the same token at two different moments must
   * be the same value; whether it has expired belongs to whoever reads it.
   */
  it('produces the same value whenever it runs, so nothing in it can go stale', async () => {
    const token = tokenOf({ alg: 'HS256' }, { sub: 'ada', iat: 1_800_000_000, exp: 1_800_003_600 });
    const at = async (moment: number): Promise<unknown> => {
      const clock = vi.spyOn(Date, 'now').mockReturnValue(moment);
      try {
        const result = await jwtTool.run({
          inputs: { input: { type: 'text', text: token } },
          options: { key: '', keyEncoding: 'utf8', clockToleranceSec: 0 },
          context,
        });
        if (!result.ok) throw new Error(result.error.message);
        return result.value;
      } finally {
        clock.mockRestore();
      }
    };

    // Before the token is usable, while it is live, and a day after it expired.
    const before = await at(Date.UTC(2020, 0, 1));
    const during = await at(1_800_001_800_000);
    const after = await at(1_800_090_000_000);
    expect(during).toEqual(before);
    expect(after).toEqual(before);
  });

  it('puts the signature verdict first in its output', async () => {
    const result = await jwtTool.run({
      inputs: { input: { type: 'text', text: tokenOf({ alg: 'HS256' }, { sub: '1' }) } },
      options: { key: '', keyEncoding: 'utf8', clockToleranceSec: 0 },
      context,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const output = result.value.output;
    expect(output?.type).toBe('json');
    if (output?.type !== 'json') return;
    if (!isJsonObject(output.data)) throw new Error('expected an object');

    // Order is part of the contract here: whatever renders this, the first
    // thing read is whether the claims can be believed.
    expect(Object.keys(output.data)[0]).toBe('signature');

    const signature = output.data.signature;
    if (signature === undefined || !isJsonObject(signature)) {
      throw new Error('expected a signature object');
    }
    expect(signature.verified).toBe(false);
    expect(signature.status).toBeTypeOf('string');
    expect(signature.status as string).toContain('NOT VERIFIED');
  });

  it('never reports verified: true without a key', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string(), fc.string(), async (sub, signature) => {
        const result = await jwtTool.run({
          inputs: {
            input: {
              type: 'text',
              text: tokenOf({ alg: 'HS256' }, { sub }, b64url(signature)),
            },
          },
          options: { key: '', keyEncoding: 'utf8', clockToleranceSec: 0 },
          context,
        });

        if (!result.ok) return;
        const output = result.value.output;
        if (output?.type !== 'json' || !isJsonObject(output.data)) return;
        const verdict = output.data.signature;
        if (verdict === undefined || !isJsonObject(verdict)) return;
        expect(verdict.verified).toBe(false);
      }),
    );
  });

  it('declares its key an option that never travels in a share link', () => {
    expect(jwtTool.secretOptionKeys).toContain('key');
  });
});

/* ========================================================================== *
 * The specification's own example
 * ========================================================================== */

/**
 * RFC 7515 APPENDIX A.1 - THE JWS HMAC-SHA256 EXAMPLE.
 *
 * Every other verification test in this file signs with WebCrypto and then
 * checks with WebCrypto, which proves the two halves of one primitive agree
 * with each other and nothing else. These bytes were published by the working
 * group: the header, the payload, the key and the signature are all fixed, so
 * a token this tool reports as verified is one the specification says is
 * verified.
 *
 * https://www.rfc-editor.org/rfc/rfc7515#appendix-A.1
 */
const RFC7515_HEADER = 'eyJ0eXAiOiJKV1QiLA0KICJhbGciOiJIUzI1NiJ9';
const RFC7515_PAYLOAD =
  'eyJpc3MiOiJqb2UiLA0KICJleHAiOjEzMDA4MTkzODAsDQogImh0dHA6Ly9leGFtcGxlLmNvbS9pc19yb290Ijp0cnVlfQ';
const RFC7515_SIGNATURE = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
/** The example key, given in the RFC as the base64url of 64 octets. */
const RFC7515_KEY =
  'AyM1SysPpbyDfgZld3umj1qzKObwVMkoqQ-EstJQLr_T-1qS0gZH75aKtMN3Yj0iPS4hcgUuTwjAzZr1Z9CAow';

const RFC7515_TOKEN = `${RFC7515_HEADER}.${RFC7515_PAYLOAD}.${RFC7515_SIGNATURE}`;

describe('RFC 7515 appendix A.1', () => {
  it('decodes the header and payload the RFC prints', () => {
    const result = decodeToken(RFC7515_TOKEN);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // The RFC's header is written with a CRLF and a space inside it, which is
    // why the encoded form is not the one a minifier would produce.
    expect(result.value.header).toEqual({ typ: 'JWT', alg: 'HS256' });
    expect(result.value.payload).toEqual({
      iss: 'joe',
      exp: 1300819380,
      'http://example.com/is_root': true,
    });
    expect(result.value.signingInput).toBe(`${RFC7515_HEADER}.${RFC7515_PAYLOAD}`);
  });

  it('reports the published signature as verified, with the published key', async () => {
    const result = decodeToken(RFC7515_TOKEN);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const verification = await verifySignature({
      algorithm: 'HS256',
      signingInput: result.value.signingInput,
      signature: result.value.signature,
      key: RFC7515_KEY,
      keyEncoding: 'base64url',
    });

    expect(verification.status).toBe('verified');
  });

  it('reports it as invalid when one character of the signature is changed', async () => {
    // The instrument has to be able to say no: `verified` above would mean
    // nothing if a wrong signature reached the same verdict.
    const tampered = RFC7515_SIGNATURE.replace(/^d/, 'e');
    const result = decodeToken(`${RFC7515_HEADER}.${RFC7515_PAYLOAD}.${tampered}`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const verification = await verifySignature({
      algorithm: 'HS256',
      signingInput: result.value.signingInput,
      signature: result.value.signature,
      key: RFC7515_KEY,
      keyEncoding: 'base64url',
    });

    expect(verification.status).toBe('invalid');
  });

  it('reports it as invalid when one character of the payload is changed', async () => {
    // Re-encoded rather than edited in place, so the result is still a token
    // this tool will decode: the point is that the SIGNING INPUT changed.
    const tampered = b64url('{"iss":"ann","exp":1300819380,"http://example.com/is_root":true}');
    const result = decodeToken(`${RFC7515_HEADER}.${tampered}.${RFC7515_SIGNATURE}`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const verification = await verifySignature({
      algorithm: 'HS256',
      signingInput: result.value.signingInput,
      signature: result.value.signature,
      key: RFC7515_KEY,
      keyEncoding: 'base64url',
    });

    expect(verification.status).toBe('invalid');
  });
});
/* ========================================================================== *
 * Published vectors, for every algorithm this tool offers
 * ========================================================================== */

/**
 * WHERE THE ANSWERS COME FROM, AND WHY NOT FROM HERE.
 *
 * A.1 above settles HMAC-SHA-256 and nothing else. Everything the matrix said
 * about the other eleven algorithms rested on this file signing with WebCrypto
 * and then checking with WebCrypto - two halves of one primitive agreeing with
 * each other, which is exactly as true of a broken pair as of a working one.
 *
 * Round six went looking for published vectors for all twelve and found them
 * for all twelve, in four places. Each fixture is generated by
 * `scripts/generate-jws-oracle.mjs`, which refuses to write one unless CPython's
 * `cryptography` AND Node's WebCrypto both reach the PUBLISHED verdict for every
 * case, and both reject every valid signature with one bit flipped.
 *
 *   rfc7515.json     A.2 RS256, A.3 ES256, A.4 ES512.
 *   rfc7520.json     The JOSE cookbook: 4.1 RS256, 4.2 PS384, 4.3 ES512,
 *                    4.4 HS256.
 *   rfc4231.json     HMAC-SHA-256/384/512 vectors. Not JWS - see below.
 *   wycheproof.json  RS384, RS512, PS256, PS512 as JWS; ES384 as raw P-1363
 *                    ECDSA. A published suite rather than a specification, and
 *                    used only where no specification has anything to say.
 *
 * TWO OF THE TWELVE ARE SETTLED BELOW THE TOKEN. No published JWS or JWT vector
 * exists for HS384, HS512 or ES384 - not in RFC 7515, not in the cookbook, not
 * in Wycheproof's JWS file. What was unverified for those three was one entry in
 * a table per algorithm: which hash, and which curve. RFC 4231 and Wycheproof's
 * P-1363 file publish a key, a message and a signature, and `verifySignature`
 * takes its signing input as a string - so those vectors go through the real
 * function unchanged and settle the real question. What they do NOT exercise is
 * token splitting, which has nothing to do with the algorithm and is settled by
 * the nine that are tokens.
 *
 * AND MOST PUBLISHED JOSE EXAMPLES ARE NOT JWTs. RFC 7515 A.4 signs the ASCII
 * string "Payload", the cookbook signs a line of Tolkien and Wycheproof signs
 * "foo" - all legal JWS, none of them a JWT, because RFC 7519 requires a JWT's
 * payload to be JSON and `decodeToken` enforces that. The consequence is that
 * this tool's WHOLE PIPELINE can only be driven by the four vectors that happen
 * to have a JSON payload, and that is asserted in both directions rather than
 * worked around: the tests below check that the refusal happens, and check that
 * `verifySignature` still reaches the right verdict for the same bytes.
 */
/** Fixture bytes to the `Bytes` the tool takes. Throws rather than asserting. */
function bytesOf(base64url: string): Bytes {
  const decoded = decodeBase64(base64url);
  if (!decoded.ok) throw new Error(`fixture: "${base64url}" is not base64url`);
  return decoded.value;
}

/**
 * One published vector, reduced to what `verifySignature` takes.
 *
 * Going straight to `verifySignature` rather than through `decodeToken` is what
 * lets the nine JWS-but-not-JWT vectors be checked at all; the JWT-shaped ones
 * are ALSO driven through `decodeToken` and through `run`, further down.
 */
interface Vector {
  readonly name: string;
  readonly algorithm: string;
  readonly signingInput: string;
  readonly signature: string;
  readonly key: string;
  readonly keyEncoding: KeyEncoding;
}

const statusOf = async (
  vector: Vector,
  override: Partial<Vector> = {},
): Promise<VerificationStatus> => {
  const merged = { ...vector, ...override };
  const verification = await verifySignature({
    algorithm: merged.algorithm,
    signingInput: merged.signingInput,
    signature: bytesOf(merged.signature),
    key: merged.key,
    keyEncoding: merged.keyEncoding,
  });
  return verification.status;
};

/** The same signature with its first byte changed - the standing control. */
function flipFirstByte(base64url: string): string {
  const bytes = Uint8Array.from(bytesOf(base64url));
  bytes[0] = (bytes[0] ?? 0) ^ 0x01;
  return encodeBase64(bytes, { urlSafe: true, padding: false, wrapAt: 0 });
}

/**
 * Every algorithm that has at least one PUBLISHED, POSITIVE vector, with where
 * it came from. The ledger at the foot of this file asserts against it, so an
 * emptied fixture or a newly offered algorithm is a failing test rather than a
 * quiet gap.
 */
const covered = new Map<string, Set<string>>();
const recordCoverage = (algorithm: string, source: string): void => {
  const sources = covered.get(algorithm) ?? new Set<string>();
  sources.add(source);
  covered.set(algorithm, sources);
};

/* -------------------------------------------------------------------------- *
 * RFC 7515, appendices A.2, A.3 and A.4
 * -------------------------------------------------------------------------- */

interface Rfc7515Case {
  readonly appendix: string;
  readonly title: string;
  readonly algorithm: string;
  readonly header: string;
  readonly payload: string;
  readonly signature: string;
  readonly token: string;
  readonly payloadIsJwtShaped: boolean;
  readonly keyEncoding: string;
  readonly key: string;
}

const jwsCases = rfc7515.cases as readonly Rfc7515Case[];

const vectorOf7515 = (entry: Rfc7515Case): Vector => ({
  name: `${entry.appendix} ${entry.algorithm}`,
  algorithm: entry.algorithm,
  signingInput: `${entry.header}.${entry.payload}`,
  signature: entry.signature,
  key: entry.key,
  // A.1's key is the RFC's base64url secret; the other three are PEM, which is
  // detected from the armour whatever this is set to - so for those it is the
  // setting a person who never touched it has, which is the case worth having.
  keyEncoding: entry.keyEncoding as KeyEncoding,
});

for (const entry of jwsCases) recordCoverage(entry.algorithm, `RFC 7515 ${entry.appendix}`);

const named = <T>(entries: readonly T[], name: (entry: T) => string) =>
  entries.map((entry) => [name(entry), entry] as const);

describe('RFC 7515 appendices A.2, A.3 and A.4', () => {
  it('holds the examples it says it holds', () => {
    // Satisfied by nothing else in this block: every assertion below passes
    // over an empty fixture.
    expect(rfc7515.source).toContain('rfc7515');
    expect(jwsCases.map((entry) => entry.appendix)).toEqual(['A.1', 'A.2', 'A.3', 'A.4']);
    expect(jwsCases.map((entry) => entry.algorithm)).toEqual(['HS256', 'RS256', 'ES256', 'ES512']);
    for (const entry of jwsCases) {
      // One shared secret and three public keys, and which is which is the
      // RFC's business rather than this file's.
      expect(entry.key).toContain(
        entry.algorithm === 'HS256' ? 'AyM1SysPpbyDfgZld3umj' : '-----BEGIN PUBLIC KEY-----',
      );
    }
  });

  it.each(named(jwsCases, (entry) => `${entry.appendix} ${entry.algorithm}`))(
    'reports %s as verified against the RFC’s own public key',
    async (_name, entry) => {
      expect(await statusOf(vectorOf7515(entry))).toBe('verified');
    },
  );

  it.each(named(jwsCases, (entry) => `${entry.appendix} ${entry.algorithm}`))(
    'reports %s as invalid when one byte of the signature is changed',
    async (_name, entry) => {
      const vector = vectorOf7515(entry);
      expect(await statusOf(vector, { signature: flipFirstByte(vector.signature) })).toBe(
        'invalid',
      );
    },
  );

  it.each(named(jwsCases, (entry) => `${entry.appendix} ${entry.algorithm}`))(
    'reports %s as invalid when the signing input is changed',
    async (_name, entry) => {
      const vector = vectorOf7515(entry);
      const tampered = `${entry.header}.${b64url('{"iss":"ann"}')}`;
      expect(await statusOf(vector, { signingInput: tampered })).toBe('invalid');
    },
  );

  /*
   * THE KEYS ARE NOT INTERCHANGEABLE, AND WITH A.4 THAT IS NOW A SHARPER CLAIM.
   *
   * `importKey` is given a different algorithm name and a different curve per
   * `alg`, from two tables in `verify.ts`. Round five could only swap an RSA key
   * for an EC one, which a wrong CURVE would survive - both EC algorithms would
   * still refuse an RSA key. A.4 adds a second curve, so P-256 into the ES512
   * path and P-521 into the ES256 path are now in this loop, and a curve table
   * that named one curve for both would fail here.
   *
   * `unsupported` is the right answer and is asserted as such: it is the status
   * for a key that would not import at all, NOT `invalid`, which would mean a
   * check happened and the signature lost.
   */
  it('agrees with the transcription of A.1 at the top of this file', () => {
    // The A.1 block above was written out by hand before there was a fixture,
    // and it is kept: two independent transcriptions of the same appendix that
    // have to agree is worth more than one of them deleted.
    const a1 = jwsCases.find((entry) => entry.appendix === 'A.1');
    expect(a1).toBeDefined();
    if (a1 === undefined) return;
    expect(a1.token).toBe(RFC7515_TOKEN);
    expect(a1.key).toBe(RFC7515_KEY);
  });

  it('refuses a key of the wrong kind or the wrong curve rather than checking with it', async () => {
    for (const entry of jwsCases) {
      for (const other of jwsCases) {
        if (other.appendix === entry.appendix) continue;
        expect([
          `${entry.appendix} with ${other.appendix}`,
          await statusOf(vectorOf7515(entry), { key: other.key }),
        ]).toEqual([`${entry.appendix} with ${other.appendix}`, 'unsupported']);
      }
    }
  });

  /*
   * AN ECDSA SIGNATURE OF THE WRONG WIDTH IS A FAILED CHECK, AND THIS IS NOT
   * THE TEST FOR THE CATCH IT LOOKS LIKE.
   *
   * `verify.ts` wraps `subtle.verify` in a `try`, and until round five its
   * comment read "a malformed signature (wrong length for the curve, say)
   * throws rather than returning false". Measured in three implementations,
   * that is not so: an empty, 32-, 63- and 65-byte P-256 signature, and an
   * empty and a 7-byte RSA one, all come back `false` from Node's WebCrypto,
   * from Gecko and from WebKit. Rethrowing from that catch leaves this test
   * green, which is the whole reason it says so here rather than claiming
   * coverage it does not have.
   *
   * What it does assert is the verdict a person sees, which is worth its own
   * line either way: a truncated signature reads `invalid`, not an exception
   * escaping into a page with no verdict on it. Which engines - if any - throw
   * instead is measured in `check:browsers` rather than asserted from a
   * comment; see "what an engine does with a signature of the wrong width".
   */
  it('reports a truncated ES256 signature as invalid rather than throwing', async () => {
    const entry = jwsCases.find((candidate) => candidate.algorithm === 'ES256');
    expect(entry).toBeDefined();
    if (entry === undefined) return;

    const verification = await verifySignature({
      algorithm: 'ES256',
      signingInput: `${entry.header}.${entry.payload}`,
      signature: bytesOf(entry.signature).slice(0, 32),
      key: entry.key,
      keyEncoding: 'utf8',
    });

    expect(verification.status).toBe('invalid');
  });
});

/* -------------------------------------------------------------------------- *
 * The whole pipeline, for the vectors that are JWTs
 * -------------------------------------------------------------------------- */

describe('RFC 7515’s JWT-shaped examples, end to end', () => {
  const jwtShaped = jwsCases.filter((entry) => entry.payloadIsJwtShaped);

  it('is A.1, A.2 and A.3, and A.4 is not one of them', () => {
    // The guard for everything below, and a fact about the RFC rather than
    // about this repository: A.4 signs the ASCII string "Payload".
    expect(jwtShaped.map((entry) => entry.appendix)).toEqual(['A.1', 'A.2', 'A.3']);
  });

  it.each(named(jwtShaped, (entry) => `${entry.appendix} ${entry.algorithm}`))(
    'decodes %s to the header and payload the RFC prints',
    (_name, entry) => {
      const result = decodeToken(entry.token);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.algorithm).toBe(entry.algorithm);
      // A.1's header carries `typ` as well, which is the RFC's business.
      expect(result.value.header).toMatchObject({ alg: entry.algorithm });
      expect(result.value.payload).toEqual({
        iss: 'joe',
        exp: 1300819380,
        'http://example.com/is_root': true,
      });
      expect(result.value.signingInput).toBe(`${entry.header}.${entry.payload}`);
    },
  );

  /*
   * THE WHOLE TOOL, NOT JUST `verifySignature`. The verdict a person sees comes
   * from `run`, and `state: 'verified'` there is what the banner is drawn from.
   */
  it.each(named(jwtShaped, (entry) => `${entry.appendix} ${entry.algorithm}`))(
    'runs %s end to end with the verdict on the output port',
    async (_name, entry) => {
      const result = await jwtTool.run({
        inputs: { input: { type: 'text', text: entry.token } },
        options: { key: entry.key, keyEncoding: entry.keyEncoding, clockToleranceSec: 0 },
        context,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const output = result.value.output;
      expect(output?.type).toBe('json');
      if (output?.type !== 'json' || !isJsonObject(output.data)) return;

      const signature = output.data.signature;
      expect(signature !== undefined && isJsonObject(signature) ? signature.state : null).toBe(
        'verified',
      );
      expect(signature !== undefined && isJsonObject(signature) ? signature.verified : null).toBe(
        true,
      );
    },
  );

  /*
   * AND WHAT HAPPENS TO A JWS THAT IS NOT A JWT, which is most published JOSE.
   *
   * This is a LIMITATION recorded rather than a behaviour defended. RFC 7515
   * A.4's signature is checkable and this tool declines to check it, because
   * `decodeToken` refuses the payload before `verifySignature` is ever called.
   * That is defensible for a tool called JWT - RFC 7519 requires a JSON payload
   * - and it is the reason eight of the twelve algorithms are settled through
   * `verifySignature` above and cannot be settled through `run`. It is asserted
   * here so that a change to it is a failing test and a decision, rather than
   * something that quietly starts or stops happening.
   */
  it('refuses A.4 at the payload, before any signature is checked', () => {
    const entry = jwsCases.find((candidate) => candidate.appendix === 'A.4');
    expect(entry).toBeDefined();
    if (entry === undefined) return;

    const result = decodeToken(entry.token);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('payload');

    // The positive partner: the same bytes DO verify, so the refusal above is
    // about the payload's shape and not about anything being wrong with A.4.
    expect(entry.payloadIsJwtShaped).toBe(false);
  });
});

/* -------------------------------------------------------------------------- *
 * RFC 7520, the JOSE cookbook
 * -------------------------------------------------------------------------- */

interface Rfc7520Case {
  readonly section: string;
  readonly title: string;
  readonly algorithm: string;
  readonly header: string;
  readonly payload: string;
  readonly signature: string;
  readonly token: string;
  readonly payloadIsJwtShaped: boolean;
  readonly keyEncoding: string;
  readonly key: string;
}

const cookbook = rfc7520.cases as readonly Rfc7520Case[];

const vectorOf7520 = (entry: Rfc7520Case): Vector => ({
  name: `${entry.section} ${entry.algorithm}`,
  algorithm: entry.algorithm,
  signingInput: `${entry.header}.${entry.payload}`,
  signature: entry.signature,
  key: entry.key,
  keyEncoding: entry.keyEncoding as KeyEncoding,
});

for (const entry of cookbook) recordCoverage(entry.algorithm, `RFC 7520 ${entry.section}`);

describe('RFC 7520, the JOSE cookbook', () => {
  it('holds the examples it says it holds', () => {
    expect(rfc7520.source).toContain('rfc7520');
    expect(cookbook.map((entry) => entry.algorithm)).toEqual(['RS256', 'PS384', 'ES512', 'HS256']);
  });

  it.each(named(cookbook, (entry) => `${entry.section} ${entry.algorithm}`))(
    'reports %s as verified against the key the cookbook publishes',
    async (_name, entry) => {
      expect(await statusOf(vectorOf7520(entry))).toBe('verified');
    },
  );

  it.each(named(cookbook, (entry) => `${entry.section} ${entry.algorithm}`))(
    'reports %s as invalid when one byte of the signature is changed',
    async (_name, entry) => {
      const vector = vectorOf7520(entry);
      expect(await statusOf(vector, { signature: flipFirstByte(vector.signature) })).toBe(
        'invalid',
      );
    },
  );

  /*
   * THE SHARPEST CONTROL IN THIS FILE, and the cookbook is the only source that
   * offers it: 4.1 and 4.2 sign the SAME payload with the SAME RSA key, one
   * PKCS#1 v1.5 and one PSS. So checking each token under the other's algorithm
   * cannot fail for any reason except the padding - the key imports, the hash
   * is available, the bytes are the right length. A `verifyParams` that returned
   * PKCS#1 for PS*, or a salt length that was not the hash length, would be
   * caught here and nowhere else in this file.
   *
   * `invalid` rather than `unsupported` is the assertion, because a check
   * really does happen: the difference between "nobody looked" and "it does not
   * match" is the entire content of this tool's output.
   */
  it('does not confuse PKCS#1 v1.5 with PSS, on one key that does both', async () => {
    const pkcs1 = cookbook.find((entry) => entry.algorithm === 'RS256');
    const pss = cookbook.find((entry) => entry.algorithm === 'PS384');
    expect(pkcs1).toBeDefined();
    expect(pss).toBeDefined();
    if (pkcs1 === undefined || pss === undefined) return;
    expect(pkcs1.key).toBe(pss.key);

    expect(await statusOf(vectorOf7520(pkcs1), { algorithm: 'PS384' })).toBe('invalid');
    expect(await statusOf(vectorOf7520(pss), { algorithm: 'RS256' })).toBe('invalid');
  });

  it('refuses a key of the wrong kind rather than checking with it', async () => {
    const pss = cookbook.find((entry) => entry.algorithm === 'PS384');
    const ecdsa = cookbook.find((entry) => entry.algorithm === 'ES512');
    expect(pss).toBeDefined();
    expect(ecdsa).toBeDefined();
    if (pss === undefined || ecdsa === undefined) return;

    expect(await statusOf(vectorOf7520(pss), { key: ecdsa.key })).toBe('unsupported');
    expect(await statusOf(vectorOf7520(ecdsa), { key: pss.key })).toBe('unsupported');
  });

  /*
   * NONE OF THE FOUR IS A JWT, and that is why they are checked through
   * `verifySignature` above rather than through `run`. The cookbook signs an
   * abridged quote from The Fellowship of the Ring; `decodeToken` requires JSON.
   */
  it.each(named(cookbook, (entry) => `${entry.section} ${entry.algorithm}`))(
    'is a JWS and not a JWT, so the decoder refuses %s at the payload',
    (_name, entry) => {
      expect(entry.payloadIsJwtShaped).toBe(false);
      const result = decodeToken(entry.token);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain('payload');
    },
  );
});

/* -------------------------------------------------------------------------- *
 * RFC 4231: the only published source found for HS384 and HS512
 * -------------------------------------------------------------------------- */

interface Rfc4231Case {
  readonly id: string;
  readonly testCase: number;
  readonly algorithm: string;
  readonly signingInput: string;
  readonly signature: string;
  readonly keyEncoding: string;
  readonly key: string;
}

const hmacVectors = rfc4231.cases as readonly Rfc4231Case[];

const vectorOf4231 = (entry: Rfc4231Case): Vector => ({
  name: entry.id,
  algorithm: entry.algorithm,
  signingInput: entry.signingInput,
  signature: entry.signature,
  key: entry.key,
  keyEncoding: entry.keyEncoding as KeyEncoding,
});

for (const entry of hmacVectors) {
  recordCoverage(entry.algorithm, `RFC 4231 case ${entry.testCase.toString()}`);
}

describe('RFC 4231 HMAC-SHA-2 vectors', () => {
  it('holds vectors for all three HMAC algorithms, under both key encodings', () => {
    expect(rfc4231.source).toContain('rfc4231');
    expect(new Set(hmacVectors.map((entry) => entry.algorithm))).toEqual(
      new Set(['HS256', 'HS384', 'HS512']),
    );
    // Both encodings the tool offers, and by which vector rather than by a
    // choice made here: case 2's key is the ASCII "Jefe", the others are binary.
    expect(new Set(hmacVectors.map((entry) => entry.keyEncoding))).toEqual(
      new Set(['utf8', 'base64url']),
    );
  });

  it.each(named(hmacVectors, (entry) => entry.id))(
    'reports %s as verified against the RFC’s own key',
    async (_name, entry) => {
      expect(await statusOf(vectorOf4231(entry))).toBe('verified');
    },
  );

  it.each(named(hmacVectors, (entry) => entry.id))(
    'reports %s as invalid when one byte of the MAC is changed',
    async (_name, entry) => {
      const vector = vectorOf4231(entry);
      expect(await statusOf(vector, { signature: flipFirstByte(vector.signature) })).toBe(
        'invalid',
      );
    },
  );

  /*
   * THE ASSERTION THIS WHOLE FIXTURE EXISTS FOR.
   *
   * What was unverified about HS384 and HS512 was one entry each in `HASH_FOR`.
   * RFC 4231 publishes all three MACs over the SAME key and the SAME message,
   * so checking each one under the other two algorithms isolates the table and
   * nothing else: same key, same input, same code path, different hash. A table
   * that mapped HS384 to SHA-256 - or, the likelier slip, that mapped all three
   * to one - fails here on every vector.
   */
  it('does not accept a MAC computed with a different hash', async () => {
    for (const entry of hmacVectors) {
      for (const other of ['HS256', 'HS384', 'HS512']) {
        if (other === entry.algorithm) continue;
        expect([
          entry.id,
          other,
          await statusOf(vectorOf4231(entry), { algorithm: other }),
        ]).toEqual([entry.id, other, 'invalid']);
      }
    }
  });

  it('reports a MAC as invalid against a different key', async () => {
    const [first, second] = [
      hmacVectors.find((entry) => entry.testCase === 1 && entry.algorithm === 'HS512'),
      hmacVectors.find((entry) => entry.testCase === 2 && entry.algorithm === 'HS512'),
    ];
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    if (first === undefined || second === undefined) return;

    expect(
      await statusOf(vectorOf4231(first), {
        key: second.key,
        keyEncoding: second.keyEncoding as KeyEncoding,
      }),
    ).toBe('invalid');
  });
});

/* -------------------------------------------------------------------------- *
 * Project Wycheproof: the five algorithms no specification covers
 * -------------------------------------------------------------------------- */

interface WycheproofCase {
  readonly kind: 'jws' | 'ecdsa';
  readonly id: string;
  readonly tcId: number;
  readonly algorithm: string;
  readonly keyId: string;
  readonly comment: string;
  readonly flags: readonly string[];
  readonly expect: 'valid' | 'invalid';
  readonly verdictBasis: 'cryptographic' | 'key-policy' | 'unsigned';
  readonly payloadIsJwtShaped?: boolean;
  readonly token?: string;
  readonly signingInput?: string;
  readonly signature?: string;
}

const wycheproofCases = wycheproof.cases as readonly WycheproofCase[];
const wycheproofKeys = wycheproof.publicKeyPem as Readonly<Record<string, string>>;

function vectorOfWycheproof(entry: WycheproofCase): Vector {
  const key = wycheproofKeys[entry.keyId] ?? '';
  if (entry.kind === 'ecdsa') {
    return {
      name: entry.id,
      algorithm: entry.algorithm,
      signingInput: entry.signingInput ?? '',
      signature: entry.signature ?? '',
      key,
      keyEncoding: 'utf8',
    };
  }
  const [header = '', payload = '', signature = ''] = (entry.token ?? '').split('.');
  return {
    name: entry.id,
    algorithm: entry.algorithm,
    signingInput: `${header}.${payload}`,
    signature,
    key,
    keyEncoding: 'utf8',
  };
}

for (const entry of wycheproofCases) {
  if (entry.expect === 'valid') recordCoverage(entry.algorithm, 'Wycheproof');
}

describe('Project Wycheproof', () => {
  it('holds vectors for the five algorithms no RFC covers', () => {
    expect(wycheproof.source).toContain('wycheproof');
    const positives = new Set(
      wycheproofCases.filter((entry) => entry.expect === 'valid').map((entry) => entry.algorithm),
    );
    expect(positives).toEqual(new Set(['RS384', 'RS512', 'PS256', 'PS512', 'ES384']));
    // And negatives, which are the reason to reach for this suite at all.
    expect(wycheproofCases.filter((entry) => entry.expect === 'invalid').length).toBeGreaterThan(
      50,
    );
  });

  const positives = wycheproofCases.filter((entry) => entry.expect === 'valid');

  it.each(named(positives, (entry) => `${entry.id} ${entry.algorithm} ${entry.comment}`))(
    'reports %s as verified',
    async (_name, entry) => {
      expect(await statusOf(vectorOfWycheproof(entry))).toBe('verified');
    },
  );

  const cryptographicNegatives = wycheproofCases.filter(
    (entry) => entry.expect === 'invalid' && entry.verdictBasis === 'cryptographic',
  );

  it.each(
    named(cryptographicNegatives, (entry) => `${entry.id} ${entry.algorithm} ${entry.comment}`),
  )('reports %s as invalid', async (_name, entry) => {
    const status = await statusOf(vectorOfWycheproof(entry));
    expect(isTrustworthy(status)).toBe(false);
    // Not merely "not trusted": a check happened and the signature lost. An
    // `unsupported` here would mean the key never imported, which would make
    // every one of these pass for the wrong reason.
    expect(status).toBe('invalid');
  });

  const unsigned = wycheproofCases.filter((entry) => entry.verdictBasis === 'unsigned');

  it.each(named(unsigned, (entry) => `${entry.id} ${entry.comment}`))(
    'rejects %s outright rather than checking it',
    async (_name, entry) => {
      // `alg: none` and `alg: NONE` both. The suite publishes the upper-case
      // spelling precisely because a case-sensitive comparison would miss it.
      expect(await statusOf(vectorOfWycheproof(entry))).toBe('rejected');
    },
  );

  /*
   * WHERE THIS TOOL AND THE SUITE DISAGREE, AND WHY THAT IS THE RIGHT ANSWER.
   *
   * Wycheproof gives its keys as JWKs, and a JWK may carry an `alg` that
   * RESTRICTS it (RFC 7517 section 4.4). Case 332 is a correctly computed RS256
   * signature made with a key whose JWK says `alg: PS512`, so a library that
   * honours the key must refuse it - and the suite publishes it as invalid.
   *
   * This tool's key input is an SPKI PEM, which carries a key and no policy at
   * all: there is nowhere for an `alg` restriction to live, and inventing one
   * would mean guessing at a constraint the user never expressed. So it verifies
   * with the header's algorithm and says so, which is what these assert.
   *
   * The generator holds up its end: it requires CPython AND Node to find every
   * one of these cryptographically VALID before writing it, so the disagreement
   * is known to be the one named here rather than an unexplained failure.
   */
  const keyPolicy = wycheproofCases.filter((entry) => entry.verdictBasis === 'key-policy');

  it('verifies a signature the suite refuses on the key’s declared `alg`', async () => {
    expect(keyPolicy.length).toBeGreaterThan(0);
    for (const entry of keyPolicy) {
      expect(entry.expect).toBe('invalid');
      expect([entry.id, await statusOf(vectorOfWycheproof(entry))]).toEqual([entry.id, 'verified']);
    }
  });

  /*
   * ES384's CURVE, ISOLATED. A P-384 key handed to the ES256 or ES512 path must
   * not import at all, which is what says `CURVE_FOR` holds three different
   * curves rather than one. The hash is settled by the positives above: a
   * SHA-384 signature does not verify under any other digest.
   */
  it('does not accept a P-384 key for another curve’s algorithm', async () => {
    const entry = wycheproofCases.find(
      (candidate) => candidate.kind === 'ecdsa' && candidate.expect === 'valid',
    );
    expect(entry).toBeDefined();
    if (entry === undefined) return;

    for (const other of ['ES256', 'ES512']) {
      expect([other, await statusOf(vectorOfWycheproof(entry), { algorithm: other })]).toEqual([
        other,
        'unsupported',
      ]);
    }
  });
});

/* -------------------------------------------------------------------------- *
 * The ledger
 * -------------------------------------------------------------------------- */

/**
 * EVERY ALGORITHM THIS TOOL OFFERS HAS A PUBLISHED, POSITIVE VECTOR.
 *
 * This is the assertion that makes the four blocks above add up to a claim.
 * `VERIFIABLE_ALGORITHMS` is what the tool tells a user it can check; the map is
 * built from the fixtures as they are read. An emptied fixture, a fixture that
 * lost a case, or a thirteenth algorithm added to the list without a vector to
 * go with it, all fail here - which is the difference between a matrix row that
 * is true and one that was true when it was written.
 */
describe('the coverage ledger', () => {
  it('has at least one published positive vector for every algorithm offered', () => {
    const missing = VERIFIABLE_ALGORITHMS.filter((algorithm) => !covered.has(algorithm));
    expect(missing).toEqual([]);
  });

  it('names the source of every one of them', () => {
    const ledger = Object.fromEntries(
      VERIFIABLE_ALGORITHMS.map((algorithm) => [
        algorithm,
        [...(covered.get(algorithm) ?? [])].sort(),
      ]),
    );

    expect(ledger).toEqual({
      HS256: [
        'RFC 4231 case 1',
        'RFC 4231 case 2',
        'RFC 4231 case 6',
        'RFC 4231 case 7',
        'RFC 7515 A.1',
        'RFC 7520 4.4',
      ],
      HS384: ['RFC 4231 case 1', 'RFC 4231 case 2', 'RFC 4231 case 6', 'RFC 4231 case 7'],
      HS512: ['RFC 4231 case 1', 'RFC 4231 case 2', 'RFC 4231 case 6', 'RFC 4231 case 7'],
      RS256: ['RFC 7515 A.2', 'RFC 7520 4.1'],
      RS384: ['Wycheproof'],
      RS512: ['Wycheproof'],
      PS256: ['Wycheproof'],
      PS384: ['RFC 7520 4.2'],
      PS512: ['Wycheproof'],
      ES256: ['RFC 7515 A.3'],
      ES384: ['Wycheproof'],
      ES512: ['RFC 7515 A.4', 'RFC 7520 4.3'],
    });
  });
});

/* ========================================================================== *
 * Claims a double cannot hold
 * ========================================================================== */

describe('a numeric claim past 2^53', () => {
  /*
   * A `sub` or a `jti` that is a 64-bit database key, a Discord or Twitter
   * snowflake, or a nanosecond timestamp is rounded by `JSON.parse` - so the
   * decoder shows a DIFFERENT NUMBER from the one the issuer signed, with
   * nothing to say so. It is unavoidable in a JavaScript program and there is
   * no reason for it to be quiet.
   *
   * The token itself is built by hand rather than with `tokenOf`, because
   * `JSON.stringify` of a rounded number would produce the rounded digits and
   * there would be nothing left to find.
   */
  const bigToken = (claims: string): string =>
    `${b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64url(claims)}.c2ln`;

  async function reportOf(token: string): Promise<string> {
    const result = await jwtTool.run({
      inputs: { input: { type: 'text', text: token } },
      options: {},
      context,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return '';
    const report = result.value.report;
    return report?.type === 'json' ? JSON.stringify(report.data) : '';
  }

  it('reports the claim by path, with what it became', async () => {
    const report = await reportOf(bigToken('{"sub":12345678901234567890}'));

    expect(report).toContain('The claim at payload.sub was rounded');
    expect(report).toContain('12345678901234567890 became 12345678901234567000');
    expect(report).toContain('"level":"warn"');
  });

  it('counts several', async () => {
    const report = await reportOf(
      bigToken('{"sub":12345678901234567890,"jti":98765432109876543210}'),
    );
    expect(report).toContain('2 claims were rounded');
  });

  /*
   * NAMES FIVE AND COUNTS THE REST. This note listed the first five paths and
   * stopped, so a token with seven rounded claims read as a complete list of
   * five - the one copy of the "and N more" bargain that had lost its count,
   * found when every copy became `someOf` in round twenty-six.
   */
  it('names five of seven and says how many more there are', async () => {
    const claims = Object.fromEntries(
      ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((key) => [key, '12345678901234567890']),
    );
    const report = await reportOf(
      bigToken(JSON.stringify(claims).replace(/"12345678901234567890"/g, '12345678901234567890')),
    );
    expect(report).toContain('7 claims were rounded');
    expect(report).toContain('payload.e, and 2 more.');
    expect(report).not.toContain('payload.f');
  });

  /*
   * THE NEGATIVE CONTROLS.
   *
   * An ordinary token must say nothing, and - the one that matters - neither
   * must a claim that is past 2^53 and EXACTLY REPRESENTABLE. 9007199254740994
   * is 2^53 + 2: `Number.isSafeInteger` says false and a double holds it
   * perfectly, so the obvious implementation reports a number that was never
   * rounded.
   */
  it('says nothing about an ordinary token', async () => {
    const report = await reportOf(tokenOf({ alg: 'HS256' }, { sub: 'ada', exp: 1_700_000_000 }));
    expect(report).toContain('"notes":[]');
  });

  it('says nothing about an integer past 2^53 that a double holds exactly', async () => {
    const report = await reportOf(bigToken('{"sub":9007199254740994}'));
    expect(report).toContain('"notes":[]');
  });

  it('says nothing about a long numeric STRING, which is how issuers avoid this', async () => {
    const report = await reportOf(bigToken('{"sub":"12345678901234567890"}'));
    expect(report).toContain('"notes":[]');
  });

  it('leaves the decoded value and the verdict exactly as they were', async () => {
    // The report is additive. The claims still say what `JSON.parse` made of
    // them, and the signature verdict is untouched - the rounding happens after
    // the bytes that were signed have already been read.
    const result = await jwtTool.run({
      inputs: { input: { type: 'text', text: bigToken('{"sub":12345678901234567890}') } },
      options: {},
      context,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const output = result.value.output;
    expect(output?.type).toBe('json');
    if (output?.type !== 'json' || !isJsonObject(output.data)) return;
    const payload = output.data.payload;
    /*
     * The ROUNDED value, written the way a double actually holds it. Writing
     * the issuer's twenty digits here would be a literal the compiler rounds
     * on its way in - the very thing being reported - and lint refuses it, for
     * the same reason.
     */
    expect(payload !== undefined && isJsonObject(payload) ? payload.sub : null).toBe(
      12345678901234567000,
    );
  });

  /*
   * THE VERDICT HALF, which the test above is named for and did not check until
   * round seventeen: it passed no key, so there was no verdict to compare. A
   * token signed over the issuer's twenty digits verifies, with the rounding
   * note beside it - the signature was checked over the bytes, not over what
   * `JSON.parse` made of them.
   */
  it('verifies a genuine signature over a claim it had to round', async () => {
    const signingInput = `${b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64url('{"sub":12345678901234567890}')}`;
    const token = `${signingInput}.${await signHs256(signingInput, 'topsecret')}`;
    const result = await jwtTool.run({
      inputs: { input: { type: 'text', text: token } },
      options: { key: 'topsecret' },
      context,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const output = result.value.output;
    if (output?.type !== 'json' || !isJsonObject(output.data))
      throw new Error('expected the decoded token');
    const signature = output.data.signature;
    expect(signature !== undefined && isJsonObject(signature) ? signature.state : null).toBe(
      'verified',
    );
    const report = result.value.report;
    expect(report?.type === 'json' ? JSON.stringify(report.data) : '').toContain(
      'The claim at payload.sub was rounded',
    );
  });
});
