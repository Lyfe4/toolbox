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
- `state` carries the same answer as a token rather than as prose — `verified`,
  `invalid`, `rejected`, `no-key` or `unsupported`. `verified: false` covers
  five different situations, and the difference between "nobody checked" and
  "this is forged" is most of the content of this output; anything drawing it
  should not have to sniff a sentence for the word INVALID.
- Every other outcome says `NOT VERIFIED` in capitals, with a sentence
  explaining that the claims prove nothing.

## How it is drawn

All of the care above used to be spent on a payload rendered as
`JSON.stringify(..., 2)` in a read-only textarea, where
`NOT VERIFIED - no key supplied` was a string value among other string values,
one line above a `header` object nobody scrolls past. The caveat was said, and
nobody was going to read it — which is the same failure the ordering above
exists to prevent, reintroduced one level up.

The `output` port therefore declares `presentation: 'jwt'`, and
[`JwtView`](../../features/toolrunner/JwtView.tsx) draws it under three rules:

1. **The verdict is first and it is the loudest thing on screen** — a banner
   with a word, a rule, an icon and a sentence, at heading size above claims
   set at value size. `check:browsers` measures that, because "louder" is a
   claim about computed font size and box position that jsdom cannot evaluate.
2. **"Not verified" is never quiet and never neutral.** Five of the six
   outcomes mean the claims cannot be relied on and all five are drawn as a
   warning or as danger; there is one calm state and it is the one where a real
   signature was checked against a real key. The no-key case — the common one,
   because most people paste a token simply to read it — is a **warning**
   rather than an absence, because an absence is what makes a forged token look
   ordinary.
3. **The caveat travels with the claims.** A banner at the top is a banner you
   scroll past, so the payload's own heading reads `Payload (unverified)` and a
   sentence sits between that heading and the data.

The view **fails closed** in every direction: a payload with no `state`, a
`state` it has never heard of, and a `state` claiming `verified` over a
`verified` flag that is not `true` all report as unverified. There is no route
to the calm treatment that does not pass through `verified === true`.

Expiry is drawn **separately** from the signature. A token whose signature
verifies and whose `exp` passed last Tuesday is still a token every server
refuses, and folding the two verdicts into one loses one of them.

Registered claims are a table: the moment in words, in the reader's own time
zone with the zone named, and the raw epoch integer in its own column — because
the reason somebody is reading a token by hand is usually that a server
disagreed with them about one of those numbers, and the number is what they
will paste into the argument. The relative phrase comes from `claims.checkedAt`,
the instant the tool computed `expired`, so a tab left open for an hour cannot
render a countdown that contradicts the flag beside it.

The whole payload stays one press away behind the view's **Raw** toggle, with
Copy and Download — and the verdict banner sits **outside** that toggle, so one
press cannot turn a token the tool warned about into an unlabelled wall of
claims.

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
