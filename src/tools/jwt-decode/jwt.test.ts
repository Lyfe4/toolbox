import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { isJsonObject, type JsonValue, type ToolRunContext } from '@/features/registry/types';
import { encodeBase64, textToBytes } from '@/lib/base64';

import jwtTool from './index';
import rfc7515 from './spec/rfc7515.json';
import { decodeToken, describeClaims } from './token';
import { verifySignature } from './verify';

const context: ToolRunContext = {
  signal: new AbortController().signal,
  reportProgress: () => undefined,
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

  it('marks an expired token as expired', () => {
    const claims = describeClaims({ exp: nowSec - 60 }, now, 0);
    expect(claims.expired).toBe(true);
  });

  it('honours the clock tolerance', () => {
    const claims = describeClaims({ exp: nowSec - 60 }, now, 120);
    expect(claims.expired).toBe(false);
  });

  it('marks a not-yet-valid token', () => {
    const claims = describeClaims({ nbf: nowSec + 600 }, now, 0);
    expect(claims.notYetValid).toBe(true);
  });

  it('renders timestamps as ISO strings', () => {
    const claims = describeClaims({ iat: nowSec }, now, 0);
    expect(claims.issuedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('does not produce "Invalid Date" for a nonsense timestamp', () => {
    const claims = describeClaims({ exp: 1e30 }, now, 0);
    expect(claims.expiresAt).toBe('out of range');
  });
});

describe('the tool', () => {
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
 * The specification's other two examples: a public key, not a shared secret
 * ========================================================================== */

/**
 * RFC 7515 APPENDICES A.2 (RS256) AND A.3 (ES256).
 *
 * A.1 above settles HMAC and nothing else. Everything the matrix said about
 * RS*, PS* and ES* rested on this file signing with WebCrypto and then checking
 * with WebCrypto - two halves of one primitive agreeing with each other, which
 * is exactly as true of a broken pair as of a working one. It also could not
 * see the part of `verify.ts` that is actually ours: the SPKI PEM path, the
 * curve table, and the rule that an ECDSA signature of the wrong width is a
 * failed check rather than a thrown error.
 *
 * The fixture is [`spec/rfc7515.json`](./spec/rfc7515.json), generated by
 * `scripts/generate-jws-oracle.mjs`. The RFC gives its keys as JWKs and this
 * tool takes SPKI PEM, so the conversion happens in the generator, in CPython's
 * `cryptography` - and the generator refuses to write a fixture unless CPython
 * AND Node's WebCrypto both accept the RFC's signature with the derived key and
 * both reject it with one bit flipped.
 */
interface JwsCase {
  readonly appendix: string;
  readonly title: string;
  readonly algorithm: string;
  readonly header: string;
  readonly payload: string;
  readonly signature: string;
  readonly token: string;
  readonly publicKeyPem: string;
}

const jwsCases = rfc7515.cases as readonly JwsCase[];

describe('RFC 7515 appendices A.2 and A.3', () => {
  it('holds the examples it says it holds', () => {
    // Satisfied by nothing else in this block: every assertion below passes
    // over an empty fixture.
    expect(rfc7515.source).toContain('rfc7515');
    expect(jwsCases.map((entry) => entry.algorithm)).toEqual(['RS256', 'ES256']);
    for (const entry of jwsCases) {
      expect(entry.publicKeyPem).toContain('-----BEGIN PUBLIC KEY-----');
    }
  });

  it.each(jwsCases.map((entry) => [`${entry.appendix} ${entry.algorithm}`, entry] as const))(
    'decodes %s to the header and payload the RFC prints',
    (_name, entry) => {
      const result = decodeToken(entry.token);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.algorithm).toBe(entry.algorithm);
      expect(result.value.header).toEqual({ alg: entry.algorithm });
      expect(result.value.payload).toEqual({
        iss: 'joe',
        exp: 1300819380,
        'http://example.com/is_root': true,
      });
      expect(result.value.signingInput).toBe(`${entry.header}.${entry.payload}`);
    },
  );

  it.each(jwsCases.map((entry) => [`${entry.appendix} ${entry.algorithm}`, entry] as const))(
    'reports %s as verified against the RFC’s own public key',
    async (_name, entry) => {
      const result = decodeToken(entry.token);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const verification = await verifySignature({
        algorithm: entry.algorithm,
        signingInput: result.value.signingInput,
        signature: result.value.signature,
        key: entry.publicKeyPem,
        // PEM is detected from the armour, so the encoding setting is the one a
        // person who never touched it has - which is the case worth asserting.
        keyEncoding: 'utf8',
      });

      expect(verification.status).toBe('verified');
    },
  );

  it.each(jwsCases.map((entry) => [`${entry.appendix} ${entry.algorithm}`, entry] as const))(
    'reports %s as invalid when one byte of the signature is changed',
    async (_name, entry) => {
      const result = decodeToken(entry.token);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const tampered = Uint8Array.from(result.value.signature);
      tampered[0] = (tampered[0] ?? 0) ^ 0x01;

      const verification = await verifySignature({
        algorithm: entry.algorithm,
        signingInput: result.value.signingInput,
        signature: tampered,
        key: entry.publicKeyPem,
        keyEncoding: 'utf8',
      });

      expect(verification.status).toBe('invalid');
    },
  );

  it.each(jwsCases.map((entry) => [`${entry.appendix} ${entry.algorithm}`, entry] as const))(
    'reports %s as invalid when the payload is changed',
    async (_name, entry) => {
      const tampered = b64url('{"iss":"ann","exp":1300819380,"http://example.com/is_root":true}');
      const result = decodeToken(`${entry.header}.${tampered}.${entry.signature}`);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const verification = await verifySignature({
        algorithm: entry.algorithm,
        signingInput: result.value.signingInput,
        signature: result.value.signature,
        key: entry.publicKeyPem,
        keyEncoding: 'utf8',
      });

      expect(verification.status).toBe('invalid');
    },
  );

  /*
   * THE KEYS ARE NOT INTERCHANGEABLE, WHICH IS WORTH ONE ASSERTION.
   *
   * `importKey` is given a different algorithm name and a different curve per
   * `alg`, from two tables in `verify.ts`. Handing A.3's EC key to the RS256
   * path and A.2's RSA key to the ES256 path is the cheapest way to say those
   * tables are read rather than decorative: both must come back `unsupported`,
   * which is the status for a key that would not import - NOT `invalid`, which
   * would mean a check happened.
   */
  it('refuses a key of the wrong kind rather than reporting it as a failed check', async () => {
    const [rsa, ec] = jwsCases;
    expect(rsa).toBeDefined();
    expect(ec).toBeDefined();
    if (rsa === undefined || ec === undefined) return;

    for (const [entry, key] of [
      [rsa, ec.publicKeyPem],
      [ec, rsa.publicKeyPem],
    ] as const) {
      const result = decodeToken(entry.token);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const verification = await verifySignature({
        algorithm: entry.algorithm,
        signingInput: result.value.signingInput,
        signature: result.value.signature,
        key,
        keyEncoding: 'utf8',
      });

      expect(verification.status).toBe('unsupported');
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

    const result = decodeToken(entry.token);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const verification = await verifySignature({
      algorithm: 'ES256',
      signingInput: result.value.signingInput,
      signature: result.value.signature.slice(0, 32),
      key: entry.publicKeyPem,
      keyEncoding: 'utf8',
    });

    expect(verification.status).toBe('invalid');
  });

  /*
   * THE WHOLE TOOL, NOT JUST `verifySignature`. The verdict a person sees comes
   * from `run`, and `state: 'verified'` there is what the banner is drawn from.
   */
  it.each(jwsCases.map((entry) => [`${entry.appendix} ${entry.algorithm}`, entry] as const))(
    'runs %s end to end with the verdict on the output port',
    async (_name, entry) => {
      const result = await jwtTool.run({
        inputs: { input: { type: 'text', text: entry.token } },
        options: { key: entry.publicKeyPem, keyEncoding: 'utf8', clockToleranceSec: 0 },
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
});
