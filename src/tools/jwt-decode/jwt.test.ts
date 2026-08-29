import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { isJsonObject, type JsonValue, type ToolRunContext } from '@/features/registry/types';
import { encodeBase64, textToBytes } from '@/lib/base64';

import jwtTool from './index';
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
