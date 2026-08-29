# Base64

Encode text or files to base64, and decode base64 back to bytes.

## Why this tool exists in the reference set

It stresses two parts of the type system that nothing else would:

- **The binary path.** Decoding produces real `Uint8Array` bytes, not a string
  pretending to be bytes. A file can go in and a file can come out.
- **The multi-type input port.** One port accepts `text` **or** `bytes`, so the
  run function has to narrow on the value's tag before it can touch a payload.
  If the narrowing is removed, the tool stops compiling.

## Approach

Encoding and decoding are written directly against bytes rather than built on
`btoa`/`atob`.

`btoa` operates on a "binary string" in which every code unit must be ≤ 0xFF, so
`btoa('héllo')` throws — the classic broken-emoji bug. Text is instead run
through `TextEncoder` first, which produces UTF-8 bytes, and every code point
survives including astral-plane characters like `𝄞`.

The decoder uses a single 128-entry lookup table with **both** alphabets loaded,
and `-`/`_` mapped to the same values as `+`/`/`. Decoding is therefore
alphabet-agnostic: pasting a URL-safe JWT segment works without first telling
the tool it is URL-safe, which is what people actually expect.

## Options

| Option            | Effect                                                       |
| ----------------- | ------------------------------------------------------------ |
| Mode              | Encode or decode.                                            |
| URL-safe alphabet | Emit `-` and `_` instead of `+` and `/`.                     |
| Padding           | Append `=` so the length is a multiple of four.              |
| Wrap at column    | Insert line breaks. 0 for one line, 64 for PEM, 76 for MIME. |

## Edge cases handled

- **Empty input** encodes to an empty string and decodes to zero bytes.
- **Full Unicode**, including combining marks and astral-plane characters.
- **Whitespace in the input** is ignored when decoding, so wrapped MIME blocks
  and PEM bodies paste in directly. CRLF and LF are both fine.
- **Missing padding** is accepted; `Zg` decodes the same as `Zg==`.
- **Either alphabet** is accepted when decoding, regardless of the option.
- **A UTF-8 BOM** in the input is data, and is preserved byte-for-byte.
- **Invalid characters** produce a `parse-error` naming the character and its
  exact line and column, rather than silently skipping it.
- **Truncated input** (a group of one leftover character, which can never encode
  a whole byte) is rejected rather than producing a partial result.
- **Data after the padding** and **more than two `=`** are both rejected.
- **Decoded bytes that are not valid UTF-8** still decode successfully — the
  result is bytes. Only the on-screen _preview_ shows U+FFFD replacements, and
  the download gives you the real bytes.
- **Lone surrogates** in input text cannot round-trip: `TextEncoder` replaces an
  unpaired surrogate with U+FFFD, because UTF-8 has no encoding for one. This is
  a property of UTF-8, not of this tool.

## Limits

The tool declares a 32 MB input ceiling and runs in a Web Worker. Encoding a
large file on the main thread would drop frames, so `strategy: 'worker'` is a
declared property of the tool rather than a decision made by the caller.

## Tests

`base64.test.ts` covers the RFC 4648 test vectors, each edge case above, and
three property-based invariants: byte round-trip for arbitrary `Uint8Array`
inputs under every option combination, text round-trip for arbitrary well-formed
strings, and the guarantee that output only ever uses the declared alphabet.
