#!/usr/bin/env node
/**
 * Generates the JWS oracle fixture from RFC 7515's own appendices.
 *
 * WHY THIS SCRIPT EXISTS AT ALL. The RFC publishes its RS256 and ES256 examples
 * with the key in JSON Web Key form, and this tool takes a public key in SPKI
 * PEM form because that is what `crypto.subtle.importKey` takes and what a
 * person actually has on disk. Converting one to the other is the only step
 * between the specification's bytes and a test, and writing that conversion
 * into the test file by hand would make the fixture something this repository
 * authored. So the conversion is done HERE, by CPython's `cryptography` - an
 * implementation with no connection to the WebCrypto the tool verifies with -
 * and the result is committed.
 *
 * AND THE FIXTURE IS CHECKED BEFORE IT IS WRITTEN. Two independent verifiers
 * are run over the RFC's own signing input and signature with the key this
 * script just derived: CPython's `cryptography`, and Node's WebCrypto. A PEM
 * that decoded to the wrong key could not satisfy either. If the conversion
 * were wrong the script fails here rather than committing a fixture that makes
 * a green test out of a broken one.
 *
 * Regenerate with:
 *
 *     node scripts/generate-jws-oracle.mjs > src/tools/jwt-decode/spec/rfc7515.json && pnpm format
 *
 * Needs Python 3 with `cryptography` installed; nothing at test time does.
 *
 * https://www.rfc-editor.org/rfc/rfc7515#appendix-A.2
 * https://www.rfc-editor.org/rfc/rfc7515#appendix-A.3
 */
import { execFileSync } from 'node:child_process';
import { webcrypto } from 'node:crypto';

/* ========================================================================== *
 * The specification's own bytes, transcribed
 * ========================================================================== */

/**
 * Every value below is copied from the RFC, with the line breaks it describes
 * as "for display purposes only" removed. Nothing here is computed.
 */
const PAYLOAD =
  'eyJpc3MiOiJqb2UiLA0KICJleHAiOjEzMDA4MTkzODAsDQogImh0dHA6Ly9leGFtcGxlLmNvbS9pc19yb290Ijp0cnVlfQ';

const EXAMPLES = [
  {
    appendix: 'A.2',
    title: 'Example JWS Using RSASSA-PKCS1-v1_5 SHA-256',
    algorithm: 'RS256',
    header: 'eyJhbGciOiJSUzI1NiJ9',
    payload: PAYLOAD,
    signature:
      'cC4hiUPoj9Eetdgtv3hF80EGrhuB__dzERat0XF9g2VtQgr9PJbu3XOiZj5RZmh7' +
      'AAuHIm4Bh-0Qc_lF5YKt_O8W2Fp5jujGbds9uJdbF9CUAr7t1dnZcAcQjbKBYNX4' +
      'BAynRFdiuB--f_nZLgrnbyTyWzO75vRK5h6xBArLIARNPvkSjtQBMHlb1L07Qe7K' +
      '0GarZRmB_eSN9383LcOLn6_dO--xi12jzDwusC-eOkHWEsqtFZESc6BfI7noOPqv' +
      'hJ1phCnvWh6IeYI2w9QOYEUipUTI8np6LbgGY9Fs98rqVt5AXLIhWkWywlVmtVrB' +
      'p0igcN_IoypGlUPQGe77Rw',
    /** RFC 7515 A.2.1, with the line breaks inside the values removed. */
    jwk: {
      kty: 'RSA',
      n:
        'ofgWCuLjybRlzo0tZWJjNiuSfb4p4fAkd_wWJcyQoTbji9k0l8W26mPddx' +
        'HmfHQp-Vaw-4qPCJrcS2mJPMEzP1Pt0Bm4d4QlL-yRT-SFd2lZS-pCgNMs' +
        'D1W_YpRPEwOWvG6b32690r2jZ47soMZo9wGzjb_7OMg0LOL-bSf63kpaSH' +
        'SXndS5z5rexMdbBYUsLA9e-KXBdQOS-UTo7WTBEMa2R2CapHg665xsmtdV' +
        'MTBQY4uDZlxvb3qCo5ZwKh9kG4LT6_I5IhlJH7aGhyxXFvUK-DWNmoudF8' +
        'NAco9_h9iaGNj8q2ethFkMLs91kzk2PAcDTW9gb54h4FRWyuXpoQ',
      e: 'AQAB',
    },
  },
  {
    appendix: 'A.3',
    title: 'Example JWS Using ECDSA P-256 SHA-256',
    algorithm: 'ES256',
    header: 'eyJhbGciOiJFUzI1NiJ9',
    payload: PAYLOAD,
    signature:
      'DtEhU3ljbEg8L38VWAfUAqOyKAM6-Xx-F4GawxaepmXFCgfTjDxw5djxLa8ISlSA' + 'pmWQxfKTUJqPP3-Kg6NU1Q',
    /** RFC 7515 A.3.1. */
    jwk: {
      kty: 'EC',
      crv: 'P-256',
      x: 'f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU',
      y: 'x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0',
    },
  },
];

/**
 * The R and S octet sequences RFC 7515 A.3.1 prints as a table.
 *
 * Kept because they are a second, independent spelling of the same signature in
 * the RFC itself: if the base64url above were transcribed wrongly, these would
 * not agree with it, and the check below would say so.
 */
const A3_R = [
  14, 209, 33, 83, 121, 99, 108, 72, 60, 47, 127, 21, 88, 7, 212, 2, 163, 178, 40, 3, 58, 249, 124,
  126, 23, 129, 154, 195, 22, 158, 166, 101,
];
const A3_S = [
  197, 10, 7, 211, 140, 60, 112, 229, 216, 241, 45, 175, 8, 74, 84, 128, 166, 101, 144, 197, 242,
  147, 80, 154, 143, 63, 127, 138, 131, 163, 84, 213,
];

/** RFC 7515 A.2.1 prints the RS256 signature as octets as well. */
const A2_SIGNATURE = [
  112, 46, 33, 137, 67, 232, 143, 209, 30, 181, 216, 45, 191, 120, 69, 243, 65, 6, 174, 27, 129,
  255, 247, 115, 17, 22, 173, 209, 113, 125, 131, 101, 109, 66, 10, 253, 60, 150, 238, 221, 115,
  162, 102, 62, 81, 102, 104, 123, 0, 11, 135, 34, 110, 1, 135, 237, 16, 115, 249, 69, 229, 130,
  173, 252, 239, 22, 216, 90, 121, 142, 232, 198, 109, 219, 61, 184, 151, 91, 23, 208, 148, 2, 190,
  237, 213, 217, 217, 112, 7, 16, 141, 178, 129, 96, 213, 248, 4, 12, 167, 68, 87, 98, 184, 31, 190,
  127, 249, 217, 46, 10, 231, 111, 36, 242, 91, 51, 187, 230, 244, 74, 230, 30, 177, 4, 10, 203, 32,
  4, 77, 62, 249, 18, 142, 212, 1, 48, 121, 91, 212, 189, 59, 65, 238, 202, 208, 102, 171, 101, 25,
  129, 253, 228, 141, 247, 127, 55, 45, 195, 139, 159, 175, 221, 59, 239, 177, 139, 93, 163, 204,
  60, 46, 176, 47, 158, 58, 65, 214, 18, 202, 173, 21, 145, 18, 115, 160, 95, 35, 185, 232, 56, 250,
  175, 132, 157, 105, 132, 41, 239, 90, 30, 136, 121, 130, 54, 195, 212, 14, 96, 69, 34, 165, 68,
  200, 242, 122, 122, 45, 184, 6, 99, 209, 108, 247, 202, 234, 86, 222, 64, 92, 178, 33, 90, 69,
  178, 194, 85, 102, 181, 90, 193, 167, 72, 160, 112, 223, 200, 163, 42, 70, 149, 67, 208, 25, 238,
  251, 71,
];

/** RFC 7515 A.2.1 and A.3.1 both print the signing input as ASCII octets. */
const A2_SIGNING_INPUT = [
  101, 121, 74, 104, 98, 71, 99, 105, 79, 105, 74, 83, 85, 122, 73, 49, 78, 105, 74, 57, 46, 101,
  121, 74, 112, 99, 51, 77, 105, 79, 105, 74, 113, 98, 50, 85, 105, 76, 65, 48, 75, 73, 67, 74, 108,
  101, 72, 65, 105, 79, 106, 69, 122, 77, 68, 65, 52, 77, 84, 107, 122, 79, 68, 65, 115, 68, 81,
  111, 103, 73, 109, 104, 48, 100, 72, 65, 54, 76, 121, 57, 108, 101, 71, 70, 116, 99, 71, 120, 108,
  76, 109, 78, 118, 98, 83, 57, 112, 99, 49, 57, 121, 98, 50, 57, 48, 73, 106, 112, 48, 99, 110, 86,
  108, 102, 81,
];
const A3_SIGNING_INPUT = [
  101, 121, 74, 104, 98, 71, 99, 105, 79, 105, 74, 70, 85, 122, 73, 49, 78, 105, 74, 57, 46, 101,
  121, 74, 112, 99, 51, 77, 105, 79, 105, 74, 113, 98, 50, 85, 105, 76, 65, 48, 75, 73, 67, 74, 108,
  101, 72, 65, 105, 79, 106, 69, 122, 77, 68, 65, 52, 77, 84, 107, 122, 79, 68, 65, 115, 68, 81,
  111, 103, 73, 109, 104, 48, 100, 72, 65, 54, 76, 121, 57, 108, 101, 71, 70, 116, 99, 71, 120, 108,
  76, 109, 78, 118, 98, 83, 57, 112, 99, 49, 57, 121, 98, 50, 57, 48, 73, 106, 112, 48, 99, 110, 86,
  108, 102, 81,
];

/* ========================================================================== */

const decodeBase64Url = (text) => Buffer.from(text.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

const same = (a, b) => Buffer.from(a).equals(Buffer.from(b));

/** The RFC prints each value twice; this is the first check that it was read right. */
function checkTranscription(example) {
  const signingInput = Buffer.from(`${example.header}.${example.payload}`, 'ascii');
  const expectedInput = example.appendix === 'A.2' ? A2_SIGNING_INPUT : A3_SIGNING_INPUT;
  if (!same(signingInput, expectedInput)) {
    throw new Error(`${example.appendix}: signing input does not match the RFC's octet listing`);
  }

  const signature = decodeBase64Url(example.signature);
  const expectedSignature = example.appendix === 'A.2' ? A2_SIGNATURE : [...A3_R, ...A3_S];
  if (!same(signature, expectedSignature)) {
    throw new Error(`${example.appendix}: signature does not match the RFC's octet listing`);
  }
}

/* ========================================================================== *
 * CPython: the conversion, and the first of two verifications
 * ========================================================================== */

const PYTHON = `
import base64, json, sys
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, padding, rsa, utils

def b64u(text):
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))

def num(text):
    return int.from_bytes(b64u(text), "big")

request = json.load(sys.stdin)
out = []
for item in request:
    jwk = item["jwk"]
    signing_input = item["signingInput"].encode("ascii")
    signature = b64u(item["signature"])

    if jwk["kty"] == "RSA":
        public = rsa.RSAPublicNumbers(num(jwk["e"]), num(jwk["n"])).public_key()
        def check(sig):
            public.verify(sig, signing_input, padding.PKCS1v15(), hashes.SHA256())
    else:
        public = ec.EllipticCurvePublicNumbers(
            num(jwk["x"]), num(jwk["y"]), ec.SECP256R1()
        ).public_key()
        def check(sig, _public=public):
            half = len(sig) // 2
            der = utils.encode_dss_signature(
                int.from_bytes(sig[:half], "big"),
                int.from_bytes(sig[half:], "big"),
            )
            _public.verify(der, signing_input, ec.ECDSA(hashes.SHA256()))

    def verdict(sig):
        try:
            check(sig)
            return True
        except Exception:
            return False

    # The same verifier over one flipped bit, so a "verified" that is really
    # "this code path does nothing" cannot reach the fixture.
    tampered = bytearray(signature)
    tampered[0] ^= 0x01

    pem = public.public_bytes(
        serialization.Encoding.PEM,
        serialization.PublicFormat.SubjectPublicKeyInfo,
    ).decode("ascii")
    out.append({"pem": pem, "verified": verdict(signature), "tamperedVerified": verdict(bytes(tampered))})

json.dump({"library": "cryptography", "results": out}, sys.stdout)
`;

function pythonConvertAndVerify(examples) {
  const request = examples.map((example) => ({
    jwk: example.jwk,
    signingInput: `${example.header}.${example.payload}`,
    signature: example.signature,
  }));

  const raw = execFileSync('py', ['-3', '-c', PYTHON], {
    input: JSON.stringify(request),
    encoding: 'utf8',
  });
  return JSON.parse(raw);
}

/* ========================================================================== *
 * Node's WebCrypto: the second verification, over the PEM that will ship
 * ========================================================================== */

function derFromPem(pem) {
  const body = /-----BEGIN PUBLIC KEY-----([\s\S]*?)-----END PUBLIC KEY-----/.exec(pem)?.[1];
  if (!body) throw new Error('not a PEM public key');
  return Buffer.from(body.replace(/\s+/g, ''), 'base64');
}

async function webcryptoVerify(example, pem, signature = decodeBase64Url(example.signature)) {
  const spki = derFromPem(pem);
  const key =
    example.algorithm === 'RS256'
      ? await webcrypto.subtle.importKey(
          'spki',
          spki,
          { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
          false,
          ['verify'],
        )
      : await webcrypto.subtle.importKey(
          'spki',
          spki,
          { name: 'ECDSA', namedCurve: 'P-256' },
          false,
          ['verify'],
        );

  const params =
    example.algorithm === 'RS256'
      ? { name: 'RSASSA-PKCS1-v1_5' }
      : { name: 'ECDSA', hash: 'SHA-256' };

  return webcrypto.subtle.verify(
    params,
    key,
    signature,
    Buffer.from(`${example.header}.${example.payload}`, 'ascii'),
  );
}

/* ========================================================================== */

for (const example of EXAMPLES) checkTranscription(example);

const python = pythonConvertAndVerify(EXAMPLES);
const pythonVersion = execFileSync(
  'py',
  ['-3', '-c', 'import cryptography, sys; print(cryptography.__version__, sys.version.split()[0])'],
  { encoding: 'utf8' },
).trim();

const cases = [];
for (const [index, example] of EXAMPLES.entries()) {
  const { pem, verified, tamperedVerified } = python.results[index];

  if (!verified) throw new Error(`${example.appendix}: CPython rejected the RFC's own signature`);
  if (tamperedVerified) {
    throw new Error(`${example.appendix}: CPython accepted a signature with a flipped bit`);
  }

  if (!(await webcryptoVerify(example, pem))) {
    throw new Error(`${example.appendix}: Node's WebCrypto rejected the derived key`);
  }

  const tampered = decodeBase64Url(example.signature);
  tampered[0] ^= 0x01;
  if (await webcryptoVerify(example, pem, tampered)) {
    throw new Error(
      `${example.appendix}: Node's WebCrypto accepted a signature with a flipped bit`,
    );
  }

  cases.push({
    appendix: example.appendix,
    title: example.title,
    algorithm: example.algorithm,
    header: example.header,
    payload: example.payload,
    signature: example.signature,
    token: `${example.header}.${example.payload}.${example.signature}`,
    publicKeyPem: pem,
  });
}

process.stdout.write(
  `${JSON.stringify(
    {
      generator: 'RFC 7515 appendices A.2 and A.3',
      source: 'https://www.rfc-editor.org/rfc/rfc7515',
      keyConvertedBy: `CPython cryptography ${pythonVersion}`,
      verifiedBy: ['CPython cryptography', `Node ${process.version} WebCrypto`],
      cases,
    },
    null,
    2,
  )}\n`,
);
