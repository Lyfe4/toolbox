import { fail, ok, type ToolResult } from '@/features/registry/types';

/**
 * BYTES ARRIVING AT A PORT THAT WANTS A DOCUMENT.
 *
 * Every tool whose input is going to be read as a document declares `bytes`
 * alongside `text` — `structured-data`, `diff`, `regex-tester` and
 * `text-convert` today — and all of them need the same answer to the same question, so
 * it is written once. It lived in `structured-data/convert.ts` while that tool
 * was the only one that accepted bytes; a second copy would have been the bug
 * `retiredTools.ts` has a paragraph about.
 *
 * UTF-8 with a STRICT decoder is the rule, so a PNG wired into a document port
 * says it is not text rather than being decoded as mojibake and failing several
 * steps later with a syntax error about a character nobody typed. The lenient
 * `bytesToText` in `lib/base64.ts` is deliberately different and stays where it
 * is: base64's decoded output frequently is not text at all, and replacement
 * characters in a PREVIEW are more useful than a refusal.
 *
 * The exception is a UTF-16 byte order mark, and it is not a guess: Excel's
 * "Unicode Text (*.txt)" export is UTF-16LE, and it is one of the two ways a
 * spreadsheet leaves a Windows machine. Refusing the most common tab-separated
 * export there is, with a message about UTF-8, is a bad answer to a file that
 * says in its first two bytes exactly what it is. Nothing without a BOM is
 * decoded as anything but UTF-8.
 *
 * `subject` names the thing that could not be read, because a tool with two
 * document ports has to say WHICH one. "Those bytes" is right for a tool with
 * one input; "Original" is the only useful answer for `diff`.
 */
/**
 * THE ONE BYTE THAT WENT IN AND DID NOT COME OUT.
 *
 * `TextDecoder` removes a leading U+FEFF unless `ignoreBOM` is set, for both
 * UTF-8 and UTF-16, and that is the right default: a byte order mark is a
 * declaration about the encoding, not a character of the document, and leaving
 * it in front of `{` breaks every parser downstream. It is also, unavoidably, a
 * byte the user had and no longer has - and typing the same document into the
 * box on `/tools` keeps it, because nothing decoded anything there. One file,
 * two routes, two different documents.
 *
 * It is not going to stop being stripped. It is going to be SAID, which is what
 * this is for: the tools with a report channel put a note on it, so "the wire
 * and the clipboard differ by exactly one thing" stops being a sentence that
 * only exists in docs/conversion-matrix.md.
 */
export function hasByteOrderMark(bytes: Uint8Array): boolean {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return true;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return !(bytes[2] === 0x00 && bytes[3] === 0x00);
  return bytes[0] === 0xfe && bytes[1] === 0xff;
}

export function decodeDocument(bytes: Uint8Array, subject = 'Those bytes'): ToolResult<string> {
  const encoding = utf16EncodingOf(bytes);

  try {
    if (encoding !== null) return ok(new TextDecoder(encoding, { fatal: true }).decode(bytes));
    return ok(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return fail('invalid-input', `${subject} could not be read as text.`, {
      detail:
        encoding === null
          ? 'Documents must be UTF-8, or UTF-16 with a byte order mark.'
          : `The byte order mark says ${encoding}, but the bytes are not valid ${encoding}.`,
    });
  }
}

function utf16EncodingOf(bytes: Uint8Array): 'utf-16le' | 'utf-16be' | null {
  // FF FE 00 00 is UTF-32LE, not UTF-16LE with a null first character. There is
  // no UTF-32 decoder to hand it to, so it falls through to the UTF-8 refusal
  // rather than being decoded as the wrong thing.
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return bytes[2] === 0x00 && bytes[3] === 0x00 ? null : 'utf-16le';
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be';
  return null;
}
