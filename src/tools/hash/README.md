# Hash

MD5, SHA-1, SHA-256, SHA-384 and SHA-512 digests of text or files.

## Why this tool exists

It is what makes the canvas genuinely useful rather than a demonstration. It
turns two tools into a real workflow:

- **file → base64 decode → hash** — check a payload against a published checksum
  without saving it anywhere.
- **CSV → structured-data → hash** — fingerprint content so you can tell whether
  two exports are the same data in a different order.

## Which algorithms come from where

`crypto.subtle.digest` provides **SHA-1, SHA-256, SHA-384 and SHA-512**. Only
**MD5** is missing from WebCrypto, so it is the one algorithm implemented here
(`md5.ts`), verified against every vector in RFC 1321 appendix A.5.

(The brief assumed SHA-1 was also absent from WebCrypto. It is not — it is
available on every current engine, so vendoring an implementation would have
meant owning security-sensitive code for no benefit.)

## MD5 and SHA-1 are broken

Both are labelled **(broken)** in the algorithm picker, and `BROKEN_ALGORITHMS`
names them in code.

- MD5 has had practical collisions since 2004 and chosen-prefix collisions
  since 2009.
- SHA-1 fell to a practical collision in 2017 (SHAttered).

Neither may be used for signatures, integrity against an adversary, or anything
password-shaped. They stay available because the world is full of MD5 and SHA-1
checksums that still need checking, and a developer toolbox that cannot check
one has a real gap.

## Streaming

MD5 is **incremental**: `createMd5()` returns a hasher whose `update` folds each
chunk into the running state and keeps nothing, so a large input costs no extra
memory. The tool feeds it 1 MB slices.

The SHA family **cannot** stream. `crypto.subtle.digest` is one-shot — the Web
Crypto spec has no incremental digest API at all — so the chunks are joined
first. That is a platform limitation, not a choice; the alternative would be
shipping our own SHA implementations, which would be slower and would mean
owning security-critical code.

## Options

| Option          | Effect                                 |
| --------------- | -------------------------------------- |
| Algorithm       | MD5, SHA-1, SHA-256, SHA-384, SHA-512. |
| Output encoding | Hexadecimal or base64.                 |
| Case            | Applies to hex only.                   |

Base64 is never case-folded: `3q2+7w==` and `3Q2+7W==` decode to different
bytes, so applying the case option to it would silently corrupt the value.

## Edge cases handled

- **Empty input** hashes correctly (`d41d8cd9…` for MD5, `e3b0c442…` for SHA-256).
- **Block boundaries** — 55, 56, 63, 64 and 65-byte inputs are tested, because
  56 is where MD5's padding has to spill into a second block.
- **Any chunking** gives the same digest as hashing the whole buffer; asserted
  as a property over arbitrary inputs and arbitrary chunk sizes.
- **Text and bytes agree** — hashing the string "abc" and the UTF-8 bytes of
  "abc" produce the same digest.
- **Inputs above 512 MB** still record the correct 64-bit length in the padding.
- **Reuse after digesting** throws rather than returning a wrong answer.

## Tests

`hash.test.ts` covers the RFC 1321 vectors, published SHA-1/SHA-256 vectors,
digest lengths, formatting, the broken-algorithm labelling, and a property test
asserting that chunked and whole-buffer hashing always agree.
