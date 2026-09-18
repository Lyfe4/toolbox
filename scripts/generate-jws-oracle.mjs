#!/usr/bin/env node
/**
 * Generates the JWS oracle fixtures from published test vectors.
 *
 * WHY THIS SCRIPT EXISTS AT ALL. Every verification in this repository that is
 * not driven from a published vector signs with WebCrypto and then checks with
 * WebCrypto, which proves two halves of one primitive agree with each other and
 * is exactly as true of a broken pair as of a working one. The vectors below
 * were published by somebody else: the key, the signing input and the signature
 * are all fixed, so a token this tool reports as verified is one an outside
 * authority says is verified.
 *
 * AND THE FIXTURES ARE CHECKED BEFORE THEY ARE WRITTEN. Two independent
 * verifiers are run over every case: CPython's `cryptography`, and Node's
 * WebCrypto - implementations with no connection to each other, and the second
 * of them none to the browser WebCrypto the tool verifies with. Both must agree
 * with the PUBLISHED verdict, and for every vector published as valid both must
 * additionally reject the same signature with one bit flipped. A disagreement
 * anywhere fails the script rather than committing a fixture that makes a green
 * test out of a broken one.
 *
 * THE KEY CONVERSION IS THE OTHER REASON. Most of these sources give their keys
 * as JSON Web Keys and this tool takes a public key in SPKI PEM form, because
 * that is what `crypto.subtle.importKey` takes and what a person actually has
 * on disk. That conversion is the only step between the published bytes and a
 * test, and writing it into the test file by hand would make the fixture
 * something this repository authored. So it happens HERE, in CPython, and the
 * PEM that ships is the one both verifiers were then pointed at.
 *
 * WHAT EACH FIXTURE HOLDS, and why there are four of them rather than one:
 *
 *   rfc7515.json    Appendices A.1 (HS256), A.2 (RS256), A.3 (ES256) and
 *                   A.4 (ES512). A.4 was missed in round five, which recorded
 *                   RFC 7515 as publishing "HS256, RS256 and ES256 and nothing
 *                   else"; A.1 was transcribed into the test file and never put
 *                   to a verifier that was not the tool under test.
 *   rfc7520.json    The JOSE cookbook, sections 4.1 (RS256), 4.2 (PS384),
 *                   4.3 (ES512) and 4.4 (HS256).
 *   rfc4231.json    HMAC-SHA-256/384/512 test vectors. NOT JWS: a key, a
 *                   message and a MAC. It is the only published source found
 *                   for HS384 and HS512, and what it settles is exactly what
 *                   was unsettled - the hash each `alg` selects.
 *   wycheproof.json Project Wycheproof's JWS vectors for the algorithms no RFC
 *                   covers (RS384, RS512, PS256, PS512), and its P-384/SHA-384
 *                   IEEE-P1363 ECDSA vectors, which are the only published
 *                   source found for ES384.
 *
 * Regenerate with:
 *
 *     node scripts/generate-jws-oracle.mjs && pnpm format
 *
 * Needs Python 3 with `cryptography` installed, and network access for the
 * Wycheproof files. Nothing at test time needs either.
 *
 * https://www.rfc-editor.org/rfc/rfc7515#appendix-A
 * https://www.rfc-editor.org/rfc/rfc7520#section-4
 * https://www.rfc-editor.org/rfc/rfc4231#section-4
 * https://github.com/C2SP/wycheproof
 */
import { execFileSync } from 'node:child_process';
import { createHash, webcrypto } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

const SPEC_URL = new URL('../src/tools/jwt-decode/spec/', import.meta.url);

const decodeBase64Url = (text) => Buffer.from(text.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const encodeBase64Url = (bytes) =>
  Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const same = (a, b) => Buffer.from(a).equals(Buffer.from(b));

/** Fails the run rather than letting a bad transcription reach a fixture. */
function must(condition, message) {
  if (!condition) throw new Error(message);
}

/* ========================================================================== *
 * RFC 7515, appendices A.2, A.3 and A.4
 * ========================================================================== */

/**
 * Every value below is copied from the RFC, with the line breaks it describes
 * as "for display purposes only" removed. Nothing here is computed.
 */
const A123_PAYLOAD =
  'eyJpc3MiOiJqb2UiLA0KICJleHAiOjEzMDA4MTkzODAsDQogImh0dHA6Ly9leGFtcGxlLmNvbS9pc19yb290Ijp0cnVlfQ';

const RFC7515 = [
  {
    /*
     * A.1, WHICH USED TO BE TRANSCRIBED IN THE TEST FILE AND NOWHERE ELSE.
     *
     * It is the one example whose key is a shared secret rather than a public
     * key, so round five had no reason to run it through a generator: there was
     * no conversion to do. But "no conversion" is not "no verification" - until
     * round six the only thing that had ever agreed with the RFC about these
     * bytes was the tool under test. It goes through the same two verifiers as
     * the rest now, and `check:browsers` reads it from here rather than from a
     * second transcription of its own.
     */
    appendix: 'A.1',
    title: 'Example JWS Using HMAC SHA-256',
    algorithm: 'HS256',
    header: 'eyJ0eXAiOiJKV1QiLA0KICJhbGciOiJIUzI1NiJ9',
    payload: A123_PAYLOAD,
    signature: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    /** RFC 7515 A.1.1, the `k` of the `oct` JWK, with its display breaks removed. */
    secretBase64Url:
      'AyM1SysPpbyDfgZld3umj1qzKObwVMkoqQ-EstJQLr_T-1qS0gZH75' + 'aKtMN3Yj0iPS4hcgUuTwjAzZr1Z9CAow',
  },
  {
    appendix: 'A.2',
    title: 'Example JWS Using RSASSA-PKCS1-v1_5 SHA-256',
    algorithm: 'RS256',
    header: 'eyJhbGciOiJSUzI1NiJ9',
    payload: A123_PAYLOAD,
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
    payload: A123_PAYLOAD,
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
  {
    /*
     * THE APPENDIX ROUND FIVE DID NOT SEE.
     *
     * Round five's note - repeated into the matrix and into the brief for this
     * one - says RFC 7515 "publishes vectors for HS256, RS256 and ES256 and for
     * nothing else". A.4 is a fourth, and it is the harder of the two curves:
     * P-521, whose name is 521 while its `alg` is ES512, and whose coordinates
     * are 66 octets with a leading zero that a careless conversion drops.
     *
     * Its payload is the ASCII string "Payload" rather than a JSON object, so
     * this one is a JWS and not a JWT - see `payloadIsJwtShaped` below, and the
     * test that asserts what this tool does with it.
     */
    appendix: 'A.4',
    title: 'Example JWS Using ECDSA P-521 SHA-512',
    algorithm: 'ES512',
    header: 'eyJhbGciOiJFUzUxMiJ9',
    payload: 'UGF5bG9hZA',
    signature:
      'AdwMgeerwtHoh-l192l60hp9wAHZFVJbLfD_UxMi70cwnZOYaRI1bKPWROc-mZZq' +
      'wqT2SI-KGDKB34XO0aw_7XdtAG8GaSwFKdCAPZgoXD2YBJZCPEX3xKpRwcdOO8Kp' +
      'EHwJjyqOgzDO7iKvU8vcnwNrmxYbSW9ERBXukOXolLzeO_Jn',
    /** RFC 7515 A.4.1. */
    jwk: {
      kty: 'EC',
      crv: 'P-521',
      x: 'AekpBQ8ST8a8VcfVOTNl353vSrDCLLJXmPk06wTjxrrjcBpXp5EOnYG_NjFZ6OvLFV1jSfS9tsz4qUxcWceqwQGk',
      y: 'ADSmRA43Z1DSNx_RvcLI87cdL07l6jQyyBXMoxVg_l2Th-x3S1WDhjDly79ajL4Kkd0AZMaZmh9ubmf63e3kyMj2',
    },
  },
];

/**
 * The octet listings the RFC prints beside each base64url value.
 *
 * Kept because they are a second, independent spelling of the same bytes in the
 * RFC itself: if a base64url string above were transcribed wrongly, these would
 * not agree with it, and `checkRfc7515Transcription` would say so.
 */
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
/** RFC 7515 A.4.1 prints the signing input as octets too - and it is shorter. */
const A4_SIGNING_INPUT = [
  101, 121, 74, 104, 98, 71, 99, 105, 79, 105, 74, 70, 85, 122, 85, 120, 77, 105, 74, 57, 46, 85,
  71, 70, 53, 98, 71, 57, 104, 90, 65,
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

/** A.3.1 and A.4.1 both print R and S as tables. The signature is R || S. */
const A3_R = [
  14, 209, 33, 83, 121, 99, 108, 72, 60, 47, 127, 21, 88, 7, 212, 2, 163, 178, 40, 3, 58, 249, 124,
  126, 23, 129, 154, 195, 22, 158, 166, 101,
];
const A3_S = [
  197, 10, 7, 211, 140, 60, 112, 229, 216, 241, 45, 175, 8, 74, 84, 128, 166, 101, 144, 197, 242,
  147, 80, 154, 143, 63, 127, 138, 131, 163, 84, 213,
];
const A4_R = [
  1, 220, 12, 129, 231, 171, 194, 209, 232, 135, 233, 117, 247, 105, 122, 210, 26, 125, 192, 1, 217,
  21, 82, 91, 45, 240, 255, 83, 19, 34, 239, 71, 48, 157, 147, 152, 105, 18, 53, 108, 163, 214, 68,
  231, 62, 153, 150, 106, 194, 164, 246, 72, 143, 138, 24, 50, 129, 223, 133, 206, 209, 172, 63,
  237, 119, 109,
];
const A4_S = [
  0, 111, 6, 105, 44, 5, 41, 208, 128, 61, 152, 40, 92, 61, 152, 4, 150, 66, 60, 69, 247, 196, 170,
  81, 193, 199, 78, 59, 194, 169, 16, 124, 9, 143, 42, 142, 131, 48, 206, 238, 34, 175, 83, 203,
  220, 159, 3, 107, 155, 22, 27, 73, 111, 68, 68, 21, 238, 144, 229, 232, 148, 188, 222, 59, 242,
  103,
];

/** RFC 7515 A.1.1 prints its signing input and its MAC as octets too. */
const A1_SIGNING_INPUT = [
  101, 121, 74, 48, 101, 88, 65, 105, 79, 105, 74, 75, 86, 49, 81, 105, 76, 65, 48, 75, 73, 67, 74,
  104, 98, 71, 99, 105, 79, 105, 74, 73, 85, 122, 73, 49, 78, 105, 74, 57, 46, 101, 121, 74, 112,
  99, 51, 77, 105, 79, 105, 74, 113, 98, 50, 85, 105, 76, 65, 48, 75, 73, 67, 74, 108, 101, 72, 65,
  105, 79, 106, 69, 122, 77, 68, 65, 52, 77, 84, 107, 122, 79, 68, 65, 115, 68, 81, 111, 103, 73,
  109, 104, 48, 100, 72, 65, 54, 76, 121, 57, 108, 101, 71, 70, 116, 99, 71, 120, 108, 76, 109, 78,
  118, 98, 83, 57, 112, 99, 49, 57, 121, 98, 50, 57, 48, 73, 106, 112, 48, 99, 110, 86, 108, 102,
  81,
];
const A1_SIGNATURE = [
  116, 24, 223, 180, 151, 153, 224, 37, 79, 250, 96, 125, 216, 173, 187, 186, 22, 212, 37, 77, 105,
  214, 191, 240, 91, 88, 5, 88, 83, 132, 141, 121,
];

const RFC7515_OCTETS = {
  'A.1': { signingInput: A1_SIGNING_INPUT, signature: A1_SIGNATURE },
  'A.2': { signingInput: A2_SIGNING_INPUT, signature: A2_SIGNATURE },
  'A.3': { signingInput: A3_SIGNING_INPUT, signature: [...A3_R, ...A3_S] },
  'A.4': { signingInput: A4_SIGNING_INPUT, signature: [...A4_R, ...A4_S] },
};

/** The RFC prints each value twice; this is the first check that it was read right. */
function checkRfc7515Transcription(example) {
  const expected = RFC7515_OCTETS[example.appendix];
  must(expected !== undefined, `${example.appendix}: no octet listing transcribed`);

  const signingInput = Buffer.from(`${example.header}.${example.payload}`, 'ascii');
  must(
    same(signingInput, expected.signingInput),
    `${example.appendix}: signing input does not match the RFC's octet listing`,
  );
  must(
    same(decodeBase64Url(example.signature), expected.signature),
    `${example.appendix}: signature does not match the RFC's octet listing`,
  );
}

/* ========================================================================== *
 * RFC 7520, the JOSE cookbook, section 4
 * ========================================================================== */

/**
 * The cookbook signs one payload with four algorithms, so the payload and the
 * keys are shared and only the header and the signature change.
 *
 * Every string is from the RFC with its display line breaks removed. Its keys
 * are figures 1 (EC public), 3 (RSA public) and 5 (oct); its payload is
 * figure 8; the four signatures are figures 12, 19, 26 and 33.
 *
 * NOTE THE PAYLOAD. It is an abridged quote from The Fellowship of the Ring,
 * not a JSON object - so none of these four is a JWT, and none of them can be
 * driven through this tool's whole pipeline. That is recorded rather than
 * worked around; see `payloadIsJwtShaped`.
 */
const RFC7520_PAYLOAD =
  'SXTigJlzIGEgZGFuZ2Vyb3VzIGJ1c2luZXNzLCBGcm9kbywgZ29pbmcgb3V0IH' +
  'lvdXIgZG9vci4gWW91IHN0ZXAgb250byB0aGUgcm9hZCwgYW5kIGlmIHlvdSBk' +
  'b24ndCBrZWVwIHlvdXIgZmVldCwgdGhlcmXigJlzIG5vIGtub3dpbmcgd2hlcm' +
  'UgeW91IG1pZ2h0IGJlIHN3ZXB0IG9mZiB0by4';

/** Figure 3: the 2048-bit RSA public key, used by 4.1 and 4.2. */
const RFC7520_RSA_JWK = {
  kty: 'RSA',
  n:
    'n4EPtAOCc9AlkeQHPzHStgAbgs7bTZLwUBZdR8_KuKPEHLd4rHVTeT' +
    '-O-XV2jRojdNhxJWTDvNd7nqQ0VEiZQHz_AJmSCpMaJMRBSFKrKb2wqV' +
    'wGU_NsYOYL-QtiWN2lbzcEe6XC0dApr5ydQLrHqkHHig3RBordaZ6Aj-' +
    'oBHqFEHYpPe7Tpe-OfVfHd1E6cS6M1FZcD1NNLYD5lFHpPI9bTwJlsde' +
    '3uhGqC0ZCuEHg8lhzwOHrtIQbS0FVbb9k3-tVTU4fg_3L_vniUFAKwuC' +
    'LqKnS2BYwdq_mzSnbLY7h_qixoR7jig3__kRhuaxwUkRz5iaiQkqgc5g' +
    'HdrNP5zw',
  e: 'AQAB',
};

/** Figure 1: the P-521 public key, used by 4.3. */
const RFC7520_EC_JWK = {
  kty: 'EC',
  crv: 'P-521',
  x: 'AHKZLLOsCOzz5cY97ewNUajB957y-C-U88c3v13nmGZx6sYl_oJXu9A5RkTKqjqvjyekWF-7ytDyRXYgCF5cj0Kt',
  y: 'AdymlHvOiLxXkEhayXQnNCvDX4h9htZaCJN34kfmC6pV5OhQHiraVySsUdaQkAgDPrwQrJmbnX9cwlGfP-HqHZR1',
};

/** Figure 5: the HMAC key, used by 4.4, given base64url in the JWK's `k`. */
const RFC7520_OCT_K = 'hJtXIZ2uSN5kbQfbtTNWbpdmhkV8FJG-Onbc6mxCcYg';

const RFC7520 = [
  {
    section: '4.1',
    title: 'RSA v1.5 Signature',
    algorithm: 'RS256',
    header: 'eyJhbGciOiJSUzI1NiIsImtpZCI6ImJpbGJvLmJhZ2dpbnNAaG9iYml0b24uZX' + 'hhbXBsZSJ9',
    signature:
      'MRjdkly7_-oTPTS3AXP41iQIGKa80A0ZmTuV5MEaHoxnW2e5CZ5NlKtainoFmK' +
      'ZopdHM1O2U4mwzJdQx996ivp83xuglII7PNDi84wnB-BDkoBwA78185hX-Es4J' +
      'IwmDLJK3lfWRa-XtL0RnltuYv746iYTh_qHRD68BNt1uSNCrUCTJDt5aAE6x8w' +
      'W1Kt9eRo4QPocSadnHXFxnt8Is9UzpERV0ePPQdLuW3IS_de3xyIrDaLGdjluP' +
      'xUAhb6L2aXic1U12podGU0KLUQSE_oI-ZnmKJ3F4uOZDnd6QZWJushZ41Axf_f' +
      'cIe8u9ipH84ogoree7vjbU5y18kDquDg',
    jwk: RFC7520_RSA_JWK,
  },
  {
    section: '4.2',
    title: 'RSA-PSS Signature',
    algorithm: 'PS384',
    header: 'eyJhbGciOiJQUzM4NCIsImtpZCI6ImJpbGJvLmJhZ2dpbnNAaG9iYml0b24uZX' + 'hhbXBsZSJ9',
    signature:
      'cu22eBqkYDKgIlTpzDXGvaFfz6WGoz7fUDcfT0kkOy42miAh2qyBzk1xEsnk2I' +
      'pN6-tPid6VrklHkqsGqDqHCdP6O8TTB5dDDItllVo6_1OLPpcbUrhiUSMxbbXU' +
      'vdvWXzg-UD8biiReQFlfz28zGWVsdiNAUf8ZnyPEgVFn442ZdNqiVJRmBqrYRX' +
      'e8P_ijQ7p8Vdz0TTrxUeT3lm8d9shnr2lfJT8ImUjvAA2Xez2Mlp8cBE5awDzT' +
      '0qI0n6uiP1aCN_2_jLAeQTlqRHtfa64QQSUmFAAjVKPbByi7xho0uTOcbH510a' +
      '6GYmJUAfmWjwZ6oD4ifKo8DYM-X72Eaw',
    jwk: RFC7520_RSA_JWK,
  },
  {
    section: '4.3',
    title: 'ECDSA Signature',
    algorithm: 'ES512',
    header: 'eyJhbGciOiJFUzUxMiIsImtpZCI6ImJpbGJvLmJhZ2dpbnNAaG9iYml0b24uZX' + 'hhbXBsZSJ9',
    signature:
      'AE_R_YZCChjn4791jSQCrdPZCNYqHXCTZH0-JZGYNlaAjP2kqaluUIIUnC9qvb' +
      'u9Plon7KRTzoNEuT4Va2cmL1eJAQy3mtPBu_u_sDDyYjnAMDxXPn7XrT0lw-kv' +
      'AD890jl8e2puQens_IEKBpHABlsbEPX6sFY8OcGDqoRuBomu9xQ2',
    jwk: RFC7520_EC_JWK,
  },
  {
    section: '4.4',
    title: 'HMAC-SHA2 Integrity Protection',
    algorithm: 'HS256',
    header: 'eyJhbGciOiJIUzI1NiIsImtpZCI6IjAxOGMwYWU1LTRkOWItNDcxYi1iZmQ2LW' + 'VlZjMxNGJjNzAzNyJ9',
    signature: 's0h6KThzkfBBBkLspW1h84VsJZFTsPPqMDA7g1Md7p0',
    secretBase64Url: RFC7520_OCT_K,
  },
];

/**
 * The cookbook prints no octet listings, so the redundancy it does have is used
 * instead: each example appears three times, once as a compact serialisation
 * and twice inside a JSON serialisation. The compact forms are transcribed
 * here, and a header or a signature read wrongly above will not rebuild them.
 */
const RFC7520_COMPACT = {
  4.1:
    'eyJhbGciOiJSUzI1NiIsImtpZCI6ImJpbGJvLmJhZ2dpbnNAaG9iYml0b24uZXhhbXBsZSJ9.' +
    'SXTigJlzIGEgZGFuZ2Vyb3VzIGJ1c2luZXNzLCBGcm9kbywgZ29pbmcgb3V0IHlvdXIgZG9vci4gWW91IHN0ZXAgb250byB0aGUgcm9hZCwgYW5kIGlmIHlvdSBkb24ndCBrZWVwIHlvdXIgZmVldCwgdGhlcmXigJlzIG5vIGtub3dpbmcgd2hlcmUgeW91IG1pZ2h0IGJlIHN3ZXB0IG9mZiB0by4.' +
    'MRjdkly7_-oTPTS3AXP41iQIGKa80A0ZmTuV5MEaHoxnW2e5CZ5NlKtainoFmKZopdHM1O2U4mwzJdQx996ivp83xuglII7PNDi84wnB-BDkoBwA78185hX-Es4JIwmDLJK3lfWRa-XtL0RnltuYv746iYTh_qHRD68BNt1uSNCrUCTJDt5aAE6x8wW1Kt9eRo4QPocSadnHXFxnt8Is9UzpERV0ePPQdLuW3IS_de3xyIrDaLGdjluPxUAhb6L2aXic1U12podGU0KLUQSE_oI-ZnmKJ3F4uOZDnd6QZWJushZ41Axf_fcIe8u9ipH84ogoree7vjbU5y18kDquDg',
  4.2:
    'eyJhbGciOiJQUzM4NCIsImtpZCI6ImJpbGJvLmJhZ2dpbnNAaG9iYml0b24uZXhhbXBsZSJ9.' +
    'SXTigJlzIGEgZGFuZ2Vyb3VzIGJ1c2luZXNzLCBGcm9kbywgZ29pbmcgb3V0IHlvdXIgZG9vci4gWW91IHN0ZXAgb250byB0aGUgcm9hZCwgYW5kIGlmIHlvdSBkb24ndCBrZWVwIHlvdXIgZmVldCwgdGhlcmXigJlzIG5vIGtub3dpbmcgd2hlcmUgeW91IG1pZ2h0IGJlIHN3ZXB0IG9mZiB0by4.' +
    'cu22eBqkYDKgIlTpzDXGvaFfz6WGoz7fUDcfT0kkOy42miAh2qyBzk1xEsnk2IpN6-tPid6VrklHkqsGqDqHCdP6O8TTB5dDDItllVo6_1OLPpcbUrhiUSMxbbXUvdvWXzg-UD8biiReQFlfz28zGWVsdiNAUf8ZnyPEgVFn442ZdNqiVJRmBqrYRXe8P_ijQ7p8Vdz0TTrxUeT3lm8d9shnr2lfJT8ImUjvAA2Xez2Mlp8cBE5awDzT0qI0n6uiP1aCN_2_jLAeQTlqRHtfa64QQSUmFAAjVKPbByi7xho0uTOcbH510a6GYmJUAfmWjwZ6oD4ifKo8DYM-X72Eaw',
  4.3:
    'eyJhbGciOiJFUzUxMiIsImtpZCI6ImJpbGJvLmJhZ2dpbnNAaG9iYml0b24uZXhhbXBsZSJ9.' +
    'SXTigJlzIGEgZGFuZ2Vyb3VzIGJ1c2luZXNzLCBGcm9kbywgZ29pbmcgb3V0IHlvdXIgZG9vci4gWW91IHN0ZXAgb250byB0aGUgcm9hZCwgYW5kIGlmIHlvdSBkb24ndCBrZWVwIHlvdXIgZmVldCwgdGhlcmXigJlzIG5vIGtub3dpbmcgd2hlcmUgeW91IG1pZ2h0IGJlIHN3ZXB0IG9mZiB0by4.' +
    'AE_R_YZCChjn4791jSQCrdPZCNYqHXCTZH0-JZGYNlaAjP2kqaluUIIUnC9qvbu9Plon7KRTzoNEuT4Va2cmL1eJAQy3mtPBu_u_sDDyYjnAMDxXPn7XrT0lw-kvAD890jl8e2puQens_IEKBpHABlsbEPX6sFY8OcGDqoRuBomu9xQ2',
  4.4:
    'eyJhbGciOiJIUzI1NiIsImtpZCI6IjAxOGMwYWU1LTRkOWItNDcxYi1iZmQ2LWVlZjMxNGJjNzAzNyJ9.' +
    'SXTigJlzIGEgZGFuZ2Vyb3VzIGJ1c2luZXNzLCBGcm9kbywgZ29pbmcgb3V0IHlvdXIgZG9vci4gWW91IHN0ZXAgb250byB0aGUgcm9hZCwgYW5kIGlmIHlvdSBkb24ndCBrZWVwIHlvdXIgZmVldCwgdGhlcmXigJlzIG5vIGtub3dpbmcgd2hlcmUgeW91IG1pZ2h0IGJlIHN3ZXB0IG9mZiB0by4.' +
    's0h6KThzkfBBBkLspW1h84VsJZFTsPPqMDA7g1Md7p0',
};

function checkRfc7520Transcription(example) {
  const rebuilt = `${example.header}.${RFC7520_PAYLOAD}.${example.signature}`;
  must(
    rebuilt === RFC7520_COMPACT[example.section],
    `RFC 7520 ${example.section}: the parts do not rebuild the published compact serialisation`,
  );
}

/* ========================================================================== *
 * RFC 4231, HMAC-SHA-2 test vectors
 * ========================================================================== */

/**
 * WHY A NON-JWS SOURCE IS HERE AT ALL.
 *
 * No published JWS or JWT vector for HS384 or HS512 was found - not in RFC
 * 7515, not in the cookbook, not in Wycheproof. What was unverified for those
 * two algorithms is exactly one thing: which hash `verify.ts` selects for each
 * `alg`. RFC 4231 publishes HMAC-SHA-384 and HMAC-SHA-512 over fixed keys and
 * messages, and `verifySignature` takes its signing input as a string and its
 * key as text - so the RFC's vectors go through the real function unchanged.
 *
 * WHAT IT THEREFORE DOES NOT COVER: the signing input here is a message, not a
 * `header.payload` pair, so nothing about token splitting is exercised. That is
 * covered for HS256 by RFC 7515 A.1 and RFC 7520 4.4, and the HMAC path does
 * not branch on the hash anywhere except the one table entry.
 *
 * Cases 3, 4 and 5 are left out and the reason is mechanical rather than
 * chosen: 3 and 4 have binary messages, which cannot be a signing-input string,
 * and 5 publishes a truncated MAC, which JWS never produces. Cases 1, 6 and 7
 * have binary KEYS, which is the base64url key encoding this tool offers; case
 * 2's key is the ASCII "Jefe", which is the other one.
 */
const RFC4231 = [
  {
    testCase: 1,
    keyHex: '0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b',
    message: 'Hi There',
    macs: {
      HS256: 'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7',
      HS384:
        'afd03944d84895626b0825f4ab46907f15f9dadbe4101ec682aa034c7cebc59c' +
        'faea9ea9076ede7f4af152e8b2fa9cb6',
      HS512:
        '87aa7cdea5ef619d4ff0b4241a1d6cb02379f4e2ce4ec2787ad0b30545e17cde' +
        'daa833b7d6b8a702038b274eaea3f4e4be9d914eeb61f1702e696c203a126854',
    },
  },
  {
    testCase: 2,
    keyHex: '4a656665',
    message: 'what do ya want for nothing?',
    macs: {
      HS256: '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
      HS384:
        'af45d2e376484031617f78d2b58a6b1b9c7ef464f5a01b47e42ec3736322445e' +
        '8e2240ca5e69e2c78b3239ecfab21649',
      HS512:
        '164b7a7bfcf819e2e395fbe73b56e0a387bd64222e831fd610270cd7ea250554' +
        '9758bf75c05a994a6d034f65f8f0e6fdcaeab1a34d4a6b4b636e070a38bce737',
    },
  },
  {
    testCase: 6,
    keyHex: 'aa'.repeat(131),
    message: 'Test Using Larger Than Block-Size Key - Hash Key First',
    macs: {
      HS256: '60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54',
      HS384:
        '4ece084485813e9088d2c63a041bc5b44f9ef1012a2b588f3cd11f05033ac4c6' +
        '0c2ef6ab4030fe8296248df163f44952',
      HS512:
        '80b24263c7c1a3ebb71493c1dd7be8b49b46d1f41b4aeec1121b013783f8f352' +
        '6b56d037e05f2598bd0fd2215d6a1e5295e64f73f63f0aec8b915a985d786598',
    },
  },
  {
    testCase: 7,
    keyHex: 'aa'.repeat(131),
    message:
      'This is a test using a larger than block-size key and a larger than ' +
      'block-size data. The key needs to be hashed before being used by the ' +
      'HMAC algorithm.',
    macs: {
      HS256: '9b09ffa71b942fcb27635fbcd5b0e944bfdc63644f0713938a7f51535c3a35e2',
      HS384:
        '6617178e941f020d351e2f254e8fd32c602420feb0b8fb9adccebb82461e99c5' +
        'a678cc31e799176d3860e6110c46523e',
      HS512:
        'e37b6a775dc87dbaa4dfa9f96e5e3ffddebd71f8867289865df5a32d20cdc944' +
        'b6022cac3c4982b10d5eeb55c3e4de15134676fb6de0446065c97440fa8c6a58',
    },
  },
];

/**
 * The RFC prints each message twice - as hex and as the quoted ASCII beside it.
 * Transcribing the readable half and checking it against the hex is the same
 * redundancy the other two sources give, so it is used the same way.
 */
const RFC4231_MESSAGE_HEX = {
  1: '4869205468657265',
  2: '7768617420646f2079612077616e7420666f72206e6f7468696e673f',
  6:
    '54657374205573696e67204c6172676572205468616e20426c6f636b2d53697a' +
    '65204b6579202d2048617368204b6579204669727374',
  7:
    '54686973206973206120746573742075' +
    '73696e672061206c6172676572207468' +
    '616e20626c6f636b2d73697a65206b65' +
    '7920616e642061206c61726765722074' +
    '68616e20626c6f636b2d73697a652064' +
    '6174612e20546865206b6579206e6565' +
    '647320746f2062652068617368656420' +
    '6265666f7265206265696e6720757365' +
    '642062792074686520484d414320616c' +
    '676f726974686d2e',
};

function checkRfc4231Transcription(vector) {
  const hex = RFC4231_MESSAGE_HEX[vector.testCase];
  must(hex !== undefined, `RFC 4231 case ${vector.testCase}: no message hex transcribed`);
  must(
    Buffer.from(vector.message, 'ascii').toString('hex') === hex,
    `RFC 4231 case ${vector.testCase}: the ASCII message does not match the RFC's hex`,
  );
  for (const [algorithm, mac] of Object.entries(vector.macs)) {
    const bits = Number(algorithm.slice(2));
    must(
      mac.length === bits / 4,
      `RFC 4231 case ${vector.testCase}: the ${algorithm} MAC is not ${(bits / 8).toString()} bytes`,
    );
  }
}

/* ========================================================================== *
 * Project Wycheproof
 * ========================================================================== */

/**
 * WHY A TEST SUITE RATHER THAN A SPECIFICATION, for these five algorithms.
 *
 * RS384, RS512, PS256, PS512 and ES384 have no vector in RFC 7515, none in the
 * cookbook, and none in any other JOSE document found. Wycheproof is the next
 * rung down the ladder in `docs/conversion-matrix.md`: a published, versioned
 * suite maintained outside this repository and used as a conformance check by
 * several mainstream crypto libraries. It is not a standards document and is
 * not recorded as one.
 *
 * THE FILES ARE PINNED TO A COMMIT AND HASHED. `main` moves, and a fixture
 * regenerated from different bytes than the last one, silently, is the failure
 * this whole exercise exists to avoid. If either file changes, this script
 * stops and somebody has to look at what changed.
 *
 * WHICH CASES ARE TAKEN, and it is a rule rather than a selection:
 *
 *   json_web_signature_test.json  The groups whose algorithm no RFC vector
 *                                 covers - RS384, RS512, PS256, PS512 - each
 *                                 IN FULL, valid and invalid alike. PS384 is
 *                                 not taken: RFC 7520 4.2 covers it, and a
 *                                 specification outranks a suite.
 *   ecdsa_secp384r1_sha384        The first group, in full. Its 103 other
 *   _p1363_test.json              groups are special-case KEYS, one or two
 *                                 tests each, which probe an engine's point
 *                                 validation rather than anything in this
 *                                 repository; the curve and hash tables that
 *                                 ARE ours are settled by the first group.
 *
 * P1363 is the fixed-width r||s encoding JWS uses, which is why that file and
 * not the DER one beside it. Its messages are ASCII digit strings, so each goes
 * through `verifySignature` as a signing input unchanged.
 */
const WYCHEPROOF_COMMIT = '3fa63dd0344abb611f1fb1d77e119938603ea230';
const WYCHEPROOF_FILES = {
  jws: {
    path: 'testvectors_v1/json_web_signature_test.json',
    sha256: '8e687a06fe8359f4ec51480f1a9f73c8faebd6f4c01b818b843b44eee54fd5d9',
  },
  ecdsaP384: {
    path: 'testvectors_v1/ecdsa_secp384r1_sha384_p1363_test.json',
    sha256: 'e27344bf6daae75fa19663620883809f91c79fc4b4420eff9eae8036b34476be',
  },
};

/** The algorithms taken from the JWS file, and nothing else from it. */
const WYCHEPROOF_JWS_ALGORITHMS = ['RS384', 'RS512', 'PS256', 'PS512'];

async function fetchWycheproof(entry) {
  const url = `https://raw.githubusercontent.com/C2SP/wycheproof/${WYCHEPROOF_COMMIT}/${entry.path}`;
  const response = await fetch(url);
  must(response.ok, `wycheproof: ${url} returned ${response.status.toString()}`);
  const body = Buffer.from(await response.arrayBuffer());
  const digest = createHash('sha256').update(body).digest('hex');
  must(
    digest === entry.sha256,
    `wycheproof: ${entry.path} hashes to ${digest}, not the pinned ${entry.sha256}`,
  );
  return JSON.parse(body.toString('utf8'));
}

/** The `alg` in a JWS protected header, or null if it has none. */
function headerAlgorithm(token) {
  try {
    const parsed = JSON.parse(decodeBase64Url(token.split('.')[0] ?? '').toString('utf8'));
    return typeof parsed.alg === 'string' ? parsed.alg : null;
  } catch {
    return null;
  }
}

const isUnsigned = (algorithm) => algorithm === null || algorithm.toLowerCase() === 'none';

/**
 * WHY WYCHEPROOF CALLS A CASE INVALID, which is not always "the maths fails".
 *
 * This distinction was not designed in; the gate below found it. Case 332 is a
 * genuine, correctly computed RS256 signature, and CPython and Node both said
 * so while the suite said `invalid` - which stopped the run, as it should have.
 *
 * The reason is that Wycheproof gives its keys as JWKs, and a JWK may carry an
 * `alg` that RESTRICTS it. Case 332's key says `alg: PS512`, so a library that
 * honours the key is required to refuse an RS256 token signed with it even
 * though the signature is perfectly valid. That is the JWK `alg` constraint of
 * RFC 7517 section 4.4, and it is a key-policy rule rather than a cryptographic
 * one.
 *
 * THIS TOOL CANNOT HONOUR IT AND SHOULD NOT PRETEND TO. Its key input is an
 * SPKI PEM, which carries a key and no policy at all - there is nowhere for an
 * `alg` restriction to live. So the three bases are separated here:
 *
 *   cryptographic  the published verdict is about the signature. Both verifiers
 *                  must reach it, and this is the overwhelming majority.
 *   key-policy     the published verdict is about the key's declared `alg`. The
 *                  signature is valid, and both verifiers must say SO - which is
 *                  what makes the disagreement with the suite the one named here
 *                  rather than an unexplained one.
 *   unsigned       `alg: none`. Nothing to verify; the assertion is the refusal.
 */
function verdictBasis(entry) {
  if (isUnsigned(entry.algorithm)) return 'unsigned';
  if (entry.flags.includes('WrongPrimitive') && entry.algorithm !== entry.keyAlgorithm) {
    return 'key-policy';
  }
  return 'cryptographic';
}

/* ========================================================================== *
 * The two verifiers
 * ========================================================================== */

/**
 * The WebCrypto parameters each `alg` implies, worked out HERE.
 *
 * This is deliberately a second implementation of the tables in
 * `src/tools/jwt-decode/verify.ts` rather than an import of them. A fixture
 * built with the tool's own table would agree with the tool by construction,
 * which is the failure this file exists to prevent. These parameters are what
 * Node's WebCrypto is given below, and they are written into each fixture so
 * that `scripts/cross-browser-check.mjs` can put the same question to two more
 * engines without re-deriving them either.
 */
function webcryptoParams(algorithm) {
  const bits = Number(algorithm.slice(2));
  must(Number.isFinite(bits), `unknown algorithm ${algorithm}`);

  if (algorithm.startsWith('HS')) {
    return {
      format: 'raw',
      importKey: { name: 'HMAC', hash: `SHA-${bits.toString()}` },
      verify: { name: 'HMAC' },
    };
  }
  if (algorithm.startsWith('ES')) {
    // ES512 is P-521, not P-512. The name of the curve is not the name of the
    // hash, and a table that assumed it was would be wrong on this row alone.
    const namedCurve = { 256: 'P-256', 384: 'P-384', 512: 'P-521' }[bits];
    must(namedCurve !== undefined, `no curve for ${algorithm}`);
    return {
      format: 'spki',
      importKey: { name: 'ECDSA', namedCurve },
      verify: { name: 'ECDSA', hash: `SHA-${bits.toString()}` },
    };
  }
  if (algorithm.startsWith('PS')) {
    // RFC 7518 section 3.5 fixes the PSS salt length to the hash length.
    return {
      format: 'spki',
      importKey: { name: 'RSA-PSS', hash: `SHA-${bits.toString()}` },
      verify: { name: 'RSA-PSS', saltLength: bits / 8 },
    };
  }
  must(algorithm.startsWith('RS'), `unknown algorithm ${algorithm}`);
  return {
    format: 'spki',
    importKey: { name: 'RSASSA-PKCS1-v1_5', hash: `SHA-${bits.toString()}` },
    verify: { name: 'RSASSA-PKCS1-v1_5' },
  };
}

const PYTHON = String.raw`
import base64, json, sys
from cryptography.hazmat.primitives import hashes, hmac, serialization
from cryptography.hazmat.primitives.asymmetric import ec, padding, rsa, utils

HASHES = {"SHA-256": hashes.SHA256, "SHA-384": hashes.SHA384, "SHA-512": hashes.SHA512}
CURVES = {"P-256": ec.SECP256R1, "P-384": ec.SECP384R1, "P-521": ec.SECP521R1}

def b64u(text):
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))

def num(text):
    return int.from_bytes(b64u(text), "big")

def build(job):
    """Returns (verify_callable, pem_or_none) for one job."""
    alg = job["algorithm"]
    digest = HASHES[job["hash"]]
    message = base64.b64decode(job["message"])

    if alg.startswith("HS"):
        secret = base64.b64decode(job["secret"])
        def check_hmac(signature):
            mac = hmac.HMAC(secret, digest())
            mac.update(message)
            mac.verify(signature)
        return check_hmac, None

    if job.get("pem"):
        public = serialization.load_pem_public_key(job["pem"].encode("ascii"))
    else:
        jwk = job["jwk"]
        if jwk["kty"] == "RSA":
            public = rsa.RSAPublicNumbers(num(jwk["e"]), num(jwk["n"])).public_key()
        else:
            public = ec.EllipticCurvePublicNumbers(
                num(jwk["x"]), num(jwk["y"]), CURVES[jwk["crv"]]()
            ).public_key()

    pem = public.public_bytes(
        serialization.Encoding.PEM,
        serialization.PublicFormat.SubjectPublicKeyInfo,
    ).decode("ascii")

    if alg.startswith("ES"):
        def check_ec(signature):
            # The JWS encoding is a fixed-width r||s and this library takes DER,
            # so the halves are re-encoded. A signature of the wrong width is
            # split anyway rather than refused here, so that the answer still
            # comes from a real verification rather than from a length check.
            half = len(signature) // 2
            der = utils.encode_dss_signature(
                int.from_bytes(signature[:half], "big"),
                int.from_bytes(signature[half:], "big"),
            )
            public.verify(der, message, ec.ECDSA(digest()))
        return check_ec, pem

    if alg.startswith("PS"):
        def check_pss(signature):
            public.verify(
                signature,
                message,
                padding.PSS(mgf=padding.MGF1(digest()), salt_length=job["saltLength"]),
                digest(),
            )
        return check_pss, pem

    def check_pkcs1(signature):
        public.verify(signature, message, padding.PKCS1v15(), digest())
    return check_pkcs1, pem

request = json.load(sys.stdin)
out = []
for job in request:
    check, pem = build(job)
    signature = base64.b64decode(job["signature"])

    def verdict(candidate, _check=check):
        try:
            _check(candidate)
            return True
        except Exception:
            return False

    # The same verifier over one flipped bit, so a "verified" that is really
    # "this code path does nothing" cannot reach a fixture.
    tampered = bytearray(signature) if signature else bytearray(b"\x00")
    tampered[0] ^= 0x01

    out.append({
        "id": job["id"],
        "pem": pem,
        "verified": verdict(signature),
        "tamperedVerified": verdict(bytes(tampered)),
    })

json.dump(out, sys.stdout)
`;

const PYTHON_VERSION = execFileSync(
  'py',
  ['-3', '-c', 'import cryptography, sys; print(cryptography.__version__, sys.version.split()[0])'],
  { encoding: 'utf8' },
).trim();

function pythonVerify(jobs) {
  const raw = execFileSync('py', ['-3', '-c', PYTHON], {
    input: JSON.stringify(jobs),
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  return new Map(JSON.parse(raw).map((entry) => [entry.id, entry]));
}

function derFromPem(pem) {
  const body = /-----BEGIN PUBLIC KEY-----([\s\S]*?)-----END PUBLIC KEY-----/.exec(pem)?.[1];
  must(body !== undefined, 'not a PEM public key');
  return Buffer.from(body.replace(/\s+/g, ''), 'base64');
}

async function nodeVerify(job, pem, signature) {
  const params = webcryptoParams(job.algorithm);
  const material = params.format === 'raw' ? Buffer.from(job.secret, 'base64') : derFromPem(pem);
  const key = await webcrypto.subtle.importKey(params.format, material, params.importKey, false, [
    'verify',
  ]);
  try {
    return await webcrypto.subtle.verify(
      params.verify,
      key,
      signature,
      Buffer.from(job.message, 'base64'),
    );
  } catch {
    /*
     * A signature of a width the engine refuses outright is a FAILED CHECK
     * rather than a reason to stop. Every case that reaches this line is one
     * its source published as invalid, and `false` is the verdict the tool
     * under test reaches for the same bytes; see the `try` in `verify.ts`.
     */
    return false;
  }
}

/* ========================================================================== *
 * The gate: both verifiers, against the published verdict
 * ========================================================================== */

/**
 * Runs every job through CPython and through Node, and throws unless the
 * published verdict, CPython's and Node's are all the same answer - plus, for
 * every case published as valid, that both reject the same signature with one
 * bit flipped.
 *
 * Returns the PEM each job's key converted to, by id.
 */
async function agreeOrThrow(jobs) {
  const python = pythonVerify(jobs);
  const pems = new Map();

  for (const job of jobs) {
    const result = python.get(job.id);
    must(result !== undefined, `${job.id}: CPython returned no result`);

    const expected = job.expect === 'valid';
    must(
      result.verified === expected,
      `${job.id}: CPython says ${result.verified ? 'valid' : 'invalid'}, the source says ${job.expect}`,
    );

    const pem = result.pem ?? null;
    const signature = Buffer.from(job.signature, 'base64');
    const node = await nodeVerify(job, pem, signature);
    must(
      node === expected,
      `${job.id}: Node WebCrypto says ${node ? 'valid' : 'invalid'}, the source says ${job.expect}`,
    );

    if (expected) {
      must(!result.tamperedVerified, `${job.id}: CPython accepted a signature with a flipped bit`);
      const flipped = Buffer.from(signature);
      flipped[0] ^= 0x01;
      must(
        !(await nodeVerify(job, pem, flipped)),
        `${job.id}: Node WebCrypto accepted a signature with a flipped bit`,
      );
    }

    pems.set(job.id, pem);
  }

  return pems;
}

/* ========================================================================== *
 * Building the fixtures
 * ========================================================================== */

const hashFor = (algorithm) => `SHA-${algorithm.slice(2)}`;
const ascii = (text) => Buffer.from(text, 'ascii').toString('base64');
const isPrintableAscii = (bytes) => /^[\x20-\x7e]*$/.test(bytes.toString('latin1'));

/**
 * Whether a JWS payload is one this tool will decode.
 *
 * `decodeToken` requires the payload to be JSON, because the tool is a JWT
 * decoder and RFC 7519 requires a JWT's payload to be a JSON object. Most
 * published JOSE examples are JWS rather than JWT - the cookbook signs a line
 * of prose, RFC 7515 A.4 signs the ASCII string "Payload", Wycheproof signs
 * "foo" - so this is recorded per case rather than assumed, and the tests
 * assert what the tool does in each direction.
 */
function payloadIsJwtShaped(payloadSegment) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(decodeBase64Url(payloadSegment));
  } catch {
    return false;
  }
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

const provenance = (source, extra) => ({
  source,
  keyConvertedBy: `CPython cryptography ${PYTHON_VERSION}`,
  verifiedBy: ['CPython cryptography', `Node ${process.version} WebCrypto`],
  ...extra,
});

async function writeFixture(name, body) {
  await writeFile(new URL(name, SPEC_URL), `${JSON.stringify(body, null, 2)}\n`, 'utf8');
  process.stdout.write(`${name}: ${body.cases.length.toString()} cases\n`);
}

/* -------------------------------------------------------------------------- */

for (const example of RFC7515) checkRfc7515Transcription(example);
for (const example of RFC7520) checkRfc7520Transcription(example);
for (const vector of RFC4231) checkRfc4231Transcription(vector);

/* -- RFC 7515 -------------------------------------------------------------- */

const rfc7515Pems = await agreeOrThrow(
  RFC7515.map((example) => ({
    id: `rfc7515-${example.appendix}`,
    algorithm: example.algorithm,
    hash: hashFor(example.algorithm),
    ...(example.secretBase64Url === undefined
      ? { jwk: example.jwk }
      : { secret: decodeBase64Url(example.secretBase64Url).toString('base64') }),
    message: ascii(`${example.header}.${example.payload}`),
    signature: decodeBase64Url(example.signature).toString('base64'),
    expect: 'valid',
  })),
);

await writeFixture('rfc7515.json', {
  generator: 'RFC 7515 appendices A.1, A.2, A.3 and A.4',
  ...provenance('https://www.rfc-editor.org/rfc/rfc7515'),
  cases: RFC7515.map((example) => ({
    appendix: example.appendix,
    title: example.title,
    algorithm: example.algorithm,
    header: example.header,
    payload: example.payload,
    signature: example.signature,
    token: `${example.header}.${example.payload}.${example.signature}`,
    payloadIsJwtShaped: payloadIsJwtShaped(example.payload),
    /*
     * `key` and `keyEncoding` rather than `publicKeyPem`, so that A.1's shared
     * secret and A.2's public key are one field a consumer can pass straight to
     * `verifySignature` - which is what both the unit suite and `check:browsers`
     * do, rather than each branching on the algorithm family again.
     */
    keyEncoding: example.secretBase64Url === undefined ? 'utf8' : 'base64url',
    key: example.secretBase64Url ?? rfc7515Pems.get(`rfc7515-${example.appendix}`),
    webcrypto: webcryptoParams(example.algorithm),
  })),
});

/* -- RFC 7520 -------------------------------------------------------------- */

const rfc7520Pems = await agreeOrThrow(
  RFC7520.map((example) => ({
    id: `rfc7520-${example.section}`,
    algorithm: example.algorithm,
    hash: hashFor(example.algorithm),
    ...(example.secretBase64Url === undefined
      ? { jwk: example.jwk }
      : { secret: decodeBase64Url(example.secretBase64Url).toString('base64') }),
    ...(example.algorithm.startsWith('PS')
      ? { saltLength: Number(example.algorithm.slice(2)) / 8 }
      : {}),
    message: ascii(`${example.header}.${RFC7520_PAYLOAD}`),
    signature: decodeBase64Url(example.signature).toString('base64'),
    expect: 'valid',
  })),
);

await writeFixture('rfc7520.json', {
  generator: 'RFC 7520 (JOSE cookbook) sections 4.1 to 4.4',
  ...provenance('https://www.rfc-editor.org/rfc/rfc7520'),
  cases: RFC7520.map((example) => ({
    section: example.section,
    title: example.title,
    algorithm: example.algorithm,
    header: example.header,
    payload: RFC7520_PAYLOAD,
    signature: example.signature,
    token: `${example.header}.${RFC7520_PAYLOAD}.${example.signature}`,
    payloadIsJwtShaped: payloadIsJwtShaped(RFC7520_PAYLOAD),
    keyEncoding: example.secretBase64Url === undefined ? 'utf8' : 'base64url',
    key: example.secretBase64Url ?? rfc7520Pems.get(`rfc7520-${example.section}`),
    webcrypto: webcryptoParams(example.algorithm),
  })),
});

/* -- RFC 4231 -------------------------------------------------------------- */

const rfc4231Cases = RFC4231.flatMap((vector) => {
  const keyBytes = Buffer.from(vector.keyHex, 'hex');
  /*
   * The key encoding a person would have to choose in the tool. A binary key
   * has no other honest spelling; "Jefe" is text and goes in as text, which is
   * the path an HS* user is actually on. Both encodings are therefore covered,
   * and by which vector rather than by a choice made here.
   */
  const text = isPrintableAscii(keyBytes);
  return Object.entries(vector.macs).map(([algorithm, mac]) => ({
    id: `rfc4231-${vector.testCase.toString()}-${algorithm}`,
    testCase: vector.testCase,
    algorithm,
    signingInput: vector.message,
    signature: encodeBase64Url(Buffer.from(mac, 'hex')),
    keyEncoding: text ? 'utf8' : 'base64url',
    key: text ? keyBytes.toString('ascii') : encodeBase64Url(keyBytes),
    keyHex: vector.keyHex,
  }));
});

await agreeOrThrow(
  rfc4231Cases.map((entry) => ({
    id: entry.id,
    algorithm: entry.algorithm,
    hash: hashFor(entry.algorithm),
    secret: Buffer.from(entry.keyHex, 'hex').toString('base64'),
    message: ascii(entry.signingInput),
    signature: decodeBase64Url(entry.signature).toString('base64'),
    expect: 'valid',
  })),
);

await writeFixture('rfc4231.json', {
  generator: 'RFC 4231 section 4, test cases 1, 2, 6 and 7',
  ...provenance('https://www.rfc-editor.org/rfc/rfc4231', {
    note:
      'HMAC vectors, not JWS: the signing input is a message rather than a ' +
      'header.payload pair. The only published source found for HS384 and HS512.',
  }),
  cases: rfc4231Cases.map((entry) => ({
    id: entry.id,
    testCase: entry.testCase,
    algorithm: entry.algorithm,
    signingInput: entry.signingInput,
    signature: entry.signature,
    keyEncoding: entry.keyEncoding,
    key: entry.key,
    webcrypto: webcryptoParams(entry.algorithm),
  })),
});

/* -- Wycheproof ------------------------------------------------------------ */

const wycheproofJws = await fetchWycheproof(WYCHEPROOF_FILES.jws);
const wycheproofEc = await fetchWycheproof(WYCHEPROOF_FILES.ecdsaP384);

/*
 * The group whose comment IS the algorithm, which is the file's own name for
 * the algorithm's own group. Matching on `public.alg` alone also catches its
 * `rfc7520` and `rfc7520WithKeyOps` groups, which re-import the cookbook's
 * examples - already covered here from the RFC itself, and taken from the RFC
 * rather than from somebody's copy of it.
 */
const jwsGroups = wycheproofJws.testGroups.filter(
  (group) =>
    WYCHEPROOF_JWS_ALGORITHMS.includes(group.public?.alg) &&
    group.comment === group.public.alg.toLowerCase(),
);
must(
  jwsGroups.length === WYCHEPROOF_JWS_ALGORITHMS.length,
  `wycheproof: expected one group per algorithm, found ${jwsGroups.length.toString()}`,
);

const wycheproofJwsCases = jwsGroups
  .flatMap((group) =>
    group.tests.map((test) => ({
      id: `wycheproof-jws-${test.tcId.toString()}`,
      tcId: test.tcId,
      keyAlgorithm: group.public.alg,
      algorithm: headerAlgorithm(test.jws),
      comment: test.comment,
      flags: test.flags,
      token: test.jws,
      expect: test.result,
      jwk: group.public,
    })),
  )
  .map((entry) => ({ ...entry, basis: verdictBasis(entry) }));

/*
 * `alg: none` has nothing to verify, so those cases do not go to the verifiers -
 * and saying so here is the point rather than an omission. What they assert is
 * this tool's REFUSAL, which is a property of `verify.ts` and not of any
 * signature; the fixture records them with no WebCrypto parameters at all.
 */
const wycheproofJwsPems = await agreeOrThrow(
  wycheproofJwsCases
    .filter((entry) => !isUnsigned(entry.algorithm))
    .map((entry) => {
      const [header = '', payload = '', signature = ''] = entry.token.split('.');
      return {
        id: entry.id,
        algorithm: entry.algorithm,
        hash: hashFor(entry.algorithm),
        jwk: entry.jwk,
        ...(entry.algorithm.startsWith('PS')
          ? { saltLength: Number(entry.algorithm.slice(2)) / 8 }
          : {}),
        message: ascii(`${header}.${payload}`),
        signature: decodeBase64Url(signature).toString('base64'),
        // A key-policy case is one the suite refuses and the maths accepts, so
        // what the verifiers are asked here is that it really does.
        expect: entry.basis === 'key-policy' ? 'valid' : entry.expect,
      };
    }),
);

/** One PEM per group, so the `alg: none` cases still ship the key they belong to. */
const pemByKeyAlgorithm = new Map(
  jwsGroups.map((group) => {
    const member = wycheproofJwsCases.find(
      (entry) => entry.keyAlgorithm === group.public.alg && wycheproofJwsPems.has(entry.id),
    );
    must(member !== undefined, `wycheproof: no PEM derived for ${group.public.alg}`);
    return [group.public.alg, wycheproofJwsPems.get(member.id)];
  }),
);

const ecGroup = wycheproofEc.testGroups[0];
must(ecGroup?.sha === 'SHA-384', 'wycheproof: the P-384 file does not start with a SHA-384 group');

const wycheproofEcCases = ecGroup.tests.map((test) => ({
  id: `wycheproof-es384-${test.tcId.toString()}`,
  tcId: test.tcId,
  comment: test.comment,
  flags: test.flags,
  signingInput: Buffer.from(test.msg, 'hex').toString('ascii'),
  signature: encodeBase64Url(Buffer.from(test.sig, 'hex')),
  expect: test.result,
}));

must(
  wycheproofEcCases.every((entry) => isPrintableAscii(Buffer.from(entry.signingInput, 'ascii'))),
  'wycheproof: a P-384 message is not printable ASCII and cannot be a signing input',
);

await agreeOrThrow(
  wycheproofEcCases.map((entry) => ({
    id: entry.id,
    algorithm: 'ES384',
    hash: 'SHA-384',
    pem: ecGroup.publicKeyPem,
    message: ascii(entry.signingInput),
    signature: decodeBase64Url(entry.signature).toString('base64'),
    expect: entry.expect,
  })),
);

/*
 * The keys and the parameter blocks are hoisted rather than repeated per case.
 * There are five keys and two hundred cases; inlining them made a 242 kB file
 * out of a 40 kB one, and a reviewer reading a diff would be reading the same
 * PEM two hundred times looking for the line that changed.
 */
const wycheproofAlgorithms = [
  ...new Set([
    ...wycheproofJwsCases.map((entry) => entry.algorithm).filter((alg) => !isUnsigned(alg)),
    'ES384',
  ]),
].sort();

await writeFixture('wycheproof.json', {
  generator: `Project Wycheproof, pinned at ${WYCHEPROOF_COMMIT}`,
  ...provenance(`https://github.com/C2SP/wycheproof/tree/${WYCHEPROOF_COMMIT}`, {
    files: Object.values(WYCHEPROOF_FILES),
    note:
      'A published test suite, not a specification. Taken only for the five ' +
      'algorithms no RFC vector covers: RS384, RS512, PS256, PS512 and ES384.',
  }),
  publicKeyPem: {
    ...Object.fromEntries(pemByKeyAlgorithm),
    ES384: ecGroup.publicKeyPem,
  },
  webcrypto: Object.fromEntries(
    wycheproofAlgorithms.map((algorithm) => [algorithm, webcryptoParams(algorithm)]),
  ),
  cases: [
    ...wycheproofJwsCases.map((entry) => ({
      kind: 'jws',
      id: entry.id,
      tcId: entry.tcId,
      algorithm: entry.algorithm,
      keyId: entry.keyAlgorithm,
      comment: entry.comment,
      flags: entry.flags,
      expect: entry.expect,
      verdictBasis: entry.basis,
      payloadIsJwtShaped: payloadIsJwtShaped(entry.token.split('.')[1] ?? ''),
      token: entry.token,
    })),
    ...wycheproofEcCases.map((entry) => ({
      kind: 'ecdsa',
      id: entry.id,
      tcId: entry.tcId,
      algorithm: 'ES384',
      keyId: 'ES384',
      comment: entry.comment,
      flags: entry.flags,
      expect: entry.expect,
      verdictBasis: 'cryptographic',
      signingInput: entry.signingInput,
      signature: entry.signature,
    })),
  ],
});
