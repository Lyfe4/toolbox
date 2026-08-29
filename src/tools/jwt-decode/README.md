# JWT

Decode a JSON Web Token, and verify its signature when you supply the key.

## The thing this tool is actually for

A JWT payload is **base64, not encryption**. Anyone holding a token can read it,
and anyone can edit it and re-encode it in about fifteen seconds. The only thing
that says a token's claims came from who they say is the **signature**.

So the risk with a decoder is not that it fails to decode. It is that it shows
you a nicely formatted payload with no visible caveat, and you believe it. That
is why:

- The output object puts **`signature` first**, before `header` and `payload`.
  Whatever renders it — the JSON view here, a downstream tool, a result pasted
  into a chat — the first thing anyone reads is whether the claims can be
  believed.
- `verified` is a boolean, and it is `true` **only** when a signature was
  actually checked cryptographically against a key you supplied.
- Every other outcome says `NOT VERIFIED` in capitals, with a sentence
  explaining that the claims prove nothing.

## `alg: none` is never accepted

`{"alg":"none"}` means "this token is unsigned". It is a real and historically
exploited attack: a server that lets the token's own header choose the
verification algorithm can be handed an unsigned token and told to trust it.

This tool reports `alg: none` as **REJECTED**, in every case — with or without a
key, and whatever case the string is written in. It still decodes the token,
because someone investigating an attack needs to see what it contained; it just
never calls it valid. `jwt.test.ts` asserts this across `none`, `None` and
`NONE`, with and without a key.

## What can and cannot be verified in a browser

| Family        | Key you supply           | Verified?   |
| ------------- | ------------------------ | ----------- |
| HS256/384/512 | The shared HMAC secret   | Yes         |
| RS256/384/512 | RSA public key, SPKI PEM | Yes         |
| PS256/384/512 | RSA public key, SPKI PEM | Yes         |
| ES256/384/512 | EC public key, SPKI PEM  | Yes         |
| `none`        | —                        | Rejected    |
| Anything else | —                        | Not checked |

All of it is `crypto.subtle`; no cryptography is implemented here. Notes:

- **HS\*** takes the raw secret. A PEM block pasted into the key field is
  refused rather than HMAC'd as literal text, because "invalid signature" would
  be a misleading answer to "you gave me the wrong kind of key".
- **PS\*** uses `saltLength` equal to the hash length, which is what RFC 7518
  fixes it to.
- **ES\*** signatures are the fixed-width `r||s` form, and the curve is derived
  from the algorithm (`ES512` is P-521, not P-512 — the name is a hash size, not
  a curve size).
- A malformed signature makes `subtle.verify` throw rather than return `false`.
  That is caught and reported as **invalid**, because a failed check is a failed
  check.

## The key never travels in a share link

Tool options normally _do_ go into a share link — that is the point of one. The
key is listed in this tool's `secretOptionKeys`, and `share.ts` copies only the
options that are **not** listed there. The manifest carries the same list
eagerly, so the encoder knows what to omit without loading any tool code, and
`registry.test.ts` asserts the two copies agree.

The key field also renders as a password input, which is not security so much as
courtesy: it keeps a secret off a shared screen and out of a screenshot.

## Options

| Option                    | Effect                                                             |
| ------------------------- | ------------------------------------------------------------------ |
| Key                       | HMAC secret or PEM public key. Empty means "decode, don't verify". |
| Secret encoding           | How to read an HMAC secret. PEM is detected automatically.         |
| Clock tolerance (seconds) | Slack allowed on `exp` and `nbf`, for clock drift.                 |

## Edge cases handled

- **`Bearer ` prefix** is stripped, because that is how tokens are usually
  copied.
- **A JWE** (five segments) is refused by name rather than half-decoded. Its
  second segment is an encrypted key, not a payload.
- **Non-JSON or non-UTF-8 segments** produce a parse error naming which segment.
- **An empty signature segment** is legal in the serialisation and decodes to
  zero bytes rather than failing.
- **Nonsense timestamps** (`exp: 1e30`) render as `"out of range"` rather than
  `Invalid Date`.
- **No secure context** means no `crypto.subtle`, which is reported as NOT
  VERIFIED rather than crashing.

## Tests

`jwt.test.ts` covers decoding, a genuine HS256 verification against a signature
made with WebCrypto in the test itself, the wrong-key case, the no-key case, the
`none` cases, PEM-as-HMAC-secret, the registered claims against a pinned clock,
and a property asserting that no token, with any signature bytes, ever comes
back `verified: true` without a key.
