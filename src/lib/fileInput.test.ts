import { describe, expect, it, vi } from 'vitest';

import { measureInputs } from '@/features/execution/protocol';
import { getManifestEntry } from '@/features/registry';
import type { Bytes, InputPort, ToolInputs } from '@/features/registry/types';
import { bytesValue } from '@/features/registry/types';

import { fileValueFor, loadFileForPort, SNIFF_WINDOW_BYTES, sniffRejection } from './fileInput';
import { sniffBytes } from './sniff';

/**
 * A FILE ARRIVING AT AN INPUT PORT.
 *
 * These are the rules both routes share, and they are here rather than beside
 * either of them for that reason: the tool page has always accepted a file and
 * the canvas now does, and the whole point of one module is that neither can
 * drift into answering differently. Every test below names the behaviour it
 * exists to stop regressing.
 */

/**
 * A tool's first input port, from the live registry.
 *
 * Thrown rather than asserted with `!`: the repo bans non-null assertions, and
 * a fixture that silently became `undefined` because a port was renamed would
 * turn every test below into a passing test of nothing.
 */
function firstInput(toolId: Parameters<typeof getManifestEntry>[0]): InputPort {
  const port = getManifestEntry(toolId).inputs[0];
  if (!port) throw new Error(`${toolId} has no input port`);
  return port;
}

const bytesPort = firstInput('image-convert');
const textAndBytesPort = firstInput('hash');
const textOnlyPort = firstInput('jwt-decode');

/** A generous budget, for the tests that are not about size. */
const ROOM = { maxBytes: 64 * 1024 * 1024 };

// `Bytes`, not a bare `Uint8Array`: the loose form also permits a
// SharedArrayBuffer, which cannot be used to build a Blob - see the note on
// `Bytes` in the registry's types.
function fileOf(name: string, bytes: Bytes, type = 'application/octet-stream'): File {
  return new File([bytes], name, { type });
}

const PNG_HEADER = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('the declared media type is never read', () => {
  /*
   * Rename `payload.zip` to `photo.png` and the operating system will tell the
   * browser it is an image. This is the platform-wide rule, and it is asserted
   * here because a file control is the one place a user-supplied `type` reaches
   * the app at all.
   */
  it('takes the media type from the bytes, not from the file', async () => {
    const zip = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
    const result = await loadFileForPort(bytesPort, fileOf('photo.png', zip, 'image/png'), ROOM);

    expect('loaded' in result).toBe(true);
    if (!('loaded' in result)) return;
    expect(result.loaded.sniff.label).toBe('ZIP archive');
    expect(result.loaded.value).toMatchObject({ type: 'bytes', mediaType: 'application/zip' });
  });

  it('carries the sniffed type onto the value, not the declared one', () => {
    const file = fileOf('notes.json', PNG_HEADER, 'application/json');
    const built = fileValueFor(bytesPort, file, PNG_HEADER, sniffBytes(PNG_HEADER));

    expect(built).toMatchObject({
      value: { type: 'bytes', mediaType: 'image/png', filename: 'notes.json' },
    });

    /*
     * AND THE VALUE POINTS AT THE FILE RATHER THAN HOLDING IT. This is the
     * whole of what a `bytes` port costs now: a reference, a size and a head.
     * Asserting the blob is the very `File` object is the only way to say
     * "nothing was read" in a test, since a copy would be indistinguishable
     * from it by content.
     */
    if (!('value' in built) || built.value.type !== 'bytes') throw new Error('no value');
    const { data } = built.value;
    expect(data.kind).toBe('deferred');
    if (data.kind !== 'deferred') return;
    expect(data.blob).toBe(file);
    expect(data.size).toBe(PNG_HEADER.byteLength);
    expect(Array.from(data.head)).toEqual(Array.from(PNG_HEADER));
  });
});

describe('a port that cannot use a file says so before reading it', () => {
  /*
   * THE COST OF ASKING LATE. `sniffBytes` matches signatures in the first
   * twelve bytes and examines the first 4 kB for its is-this-text heuristic, so
   * the verdict for a 64 MB file is already available from a 4 kB slice. This
   * used to read the whole file to sniff it - so a 64 MB binary dropped on a
   * text-only port was pulled into memory in full and then refused.
   */
  it('refuses a binary file on a text-only port without reading the whole file', async () => {
    const file = fileOf('token.txt', PNG_HEADER);
    const wholeFile = vi.spyOn(file, 'arrayBuffer');

    const result = await loadFileForPort(textOnlyPort, file, ROOM);

    expect(result).toEqual({ error: 'That file looks like png image, and Token needs text.' });
    expect(wholeFile).not.toHaveBeenCalled();
  });

  it('sniffs a slice to the same verdict as the whole file', () => {
    // 8 kB of text with a NUL right at the end: past the window, so both the
    // slice and the whole file must agree that it is text. The window IS the
    // decision, and a test that used a short file could not tell the two apart.
    const long = new Uint8Array(SNIFF_WINDOW_BYTES * 2).fill(0x61);
    long[long.length - 1] = 0;

    expect(sniffBytes(long.subarray(0, SNIFF_WINDOW_BYTES))).toEqual(sniffBytes(long));
  });

  it('accepts any file on a port that takes bytes', () => {
    expect(sniffRejection(bytesPort, sniffBytes(PNG_HEADER))).toBeNull();
  });
});

describe('a text-only port decodes strictly, the same as a wire does', () => {
  /*
   * ONE TOOL, TWO ANSWERS, DECIDED BY WHICH ROUTE THE BYTES TOOK.
   *
   * The file path used a LENIENT `TextDecoder` gated on the sniff, while bytes
   * arriving on a wire went through `decodeDocument` - strict UTF-8. So a
   * Latin-1 file dropped on a tool page was processed as replacement characters
   * and produced an answer, while the identical bytes from a base64 node were
   * refused. Both go through `decodeDocument` now.
   */
  it('refuses a text-sniffed file that is not valid UTF-8, rather than mangling it', () => {
    // `caf` + 0xE9 - "café" in Latin-1. Printable, no NUL, so the sniff calls
    // it text; it is not valid UTF-8.
    const latin1 = Uint8Array.from([0x63, 0x61, 0x66, 0xe9]);

    const built = fileValueFor(
      textAndBytesPort,
      fileOf('notes.txt', latin1),
      latin1,
      sniffBytes(latin1),
    );
    // `hash` takes bytes, so it never decodes - the refusal is for a port that
    // has to. `jwt-decode`'s Token is the text-only one.
    expect(built).toHaveProperty('value');

    const strict = fileValueFor(textOnlyPort, fileOf('t.txt', latin1), latin1, sniffBytes(latin1));
    expect(strict).toEqual({
      error:
        '"t.txt" could not be read as text. Documents must be UTF-8, or UTF-16 with a byte order mark.',
    });
  });

  /*
   * Excel's "Unicode Text (*.txt)" export is UTF-16LE, and it is one of the
   * two ways a spreadsheet leaves a Windows machine. Refusing the commonest
   * tab-separated export there is, with a message about UTF-8, is a bad answer
   * to a file that says in its first two bytes exactly what it is.
   */
  it('decodes UTF-16 with a byte order mark, because the file said what it was', () => {
    const utf16 = Uint8Array.from([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00]);

    expect(
      fileValueFor(textOnlyPort, fileOf('sheet.txt', utf16), utf16, sniffBytes(utf16)),
    ).toEqual({ value: { type: 'text', text: 'hi' } });
  });

  it('names the file in the refusal, so which file is never a question', () => {
    const bad = Uint8Array.from([0x63, 0xe9]);
    const built = fileValueFor(textOnlyPort, fileOf('claims.txt', bad), bad, sniffBytes(bad));

    expect('error' in built && built.error).toContain('"claims.txt"');
  });
});

describe('a size limit is enforced at the point of selection', () => {
  it('refuses an oversized file before a single byte is read', async () => {
    const file = fileOf('big.bin', new Uint8Array(2048));
    const wholeFile = vi.spyOn(file, 'arrayBuffer');
    const slice = vi.spyOn(file, 'slice');

    const result = await loadFileForPort(bytesPort, file, { maxBytes: 1024 });

    expect(result).toEqual({
      error: '"big.bin" is 2.0 kB, over this tool\'s 1.0 kB limit.',
    });
    expect(wholeFile).not.toHaveBeenCalled();
    expect(slice).not.toHaveBeenCalled();
  });

  /*
   * `maxInputBytes` BOUNDS A TOOL'S WHOLE INPUT, NOT ONE FILE. `diff`'s README
   * says 8 MB across both ports, so checking only the file being chosen would
   * accept two 5 MB files one at a time and let the ENGINE refuse them together
   * at run time - the after-the-fact refusal a selection-time check exists to
   * avoid, on a node the user has already walked away from.
   */
  it('weighs a second file against the first rather than leaving it to the run', async () => {
    const result = await loadFileForPort(bytesPort, fileOf('b.bin', new Uint8Array(600)), {
      maxBytes: 1000,
      otherBytes: 600,
    });

    expect(result).toEqual({
      error:
        '"b.bin" is 600 B and this node\'s other inputs already hold 600 B, over this tool\'s 1000 B limit.',
    });
  });

  it('accepts a second file that does fit alongside the first', async () => {
    const result = await loadFileForPort(bytesPort, fileOf('b.bin', new Uint8Array(300)), {
      maxBytes: 1000,
      otherBytes: 600,
    });

    expect('loaded' in result).toBe(true);
  });

  /*
   * THE TWO CHECKS AGREE BY CONSTRUCTION, and this is the assertion that keeps
   * them agreeing. The budget is measured with `measureInputs` - the very
   * function `engine.execute` weighs a run with - so a file accepted here
   * cannot be refused there for its size.
   */
  it('measures a budget the way the engine measures a run', async () => {
    const first = Uint8Array.from([1, 2, 3, 4]);
    const committed: ToolInputs = {
      original: bytesValue(first, { filename: 'a.bin' }),
    };
    const otherBytes = measureInputs(committed);
    expect(otherBytes).toBe(4);

    const maxBytes = 6;
    const tooBig = await loadFileForPort(bytesPort, fileOf('b.bin', new Uint8Array(3)), {
      maxBytes,
      otherBytes,
    });
    expect('error' in tooBig).toBe(true);

    const fits = await loadFileForPort(bytesPort, fileOf('b.bin', new Uint8Array(2)), {
      maxBytes,
      otherBytes,
    });
    expect('loaded' in fits).toBe(true);
    if (!('loaded' in fits)) return;

    // And the engine, given both, agrees it is inside the limit.
    expect(measureInputs({ ...committed, changed: fits.loaded.value })).toBeLessThanOrEqual(
      maxBytes,
    );
  });
});

describe('a loaded file cannot exist unless its port can use it', () => {
  /*
   * The invariant the rest of the app relies on. `buildInputValue` on the tool
   * page and `buildInputs` in the engine both hand `LoadedFile.value` straight
   * over with no further checking, which is only safe because getting one
   * required passing every check in this file.
   */
  it('carries a value the port declared a type for', async () => {
    const text = Uint8Array.from([0x68, 0x69]);

    const onBytes = await loadFileForPort(bytesPort, fileOf('a.bin', text), ROOM);
    expect('loaded' in onBytes && onBytes.loaded.value.type).toBe('bytes');

    const onText = await loadFileForPort(textOnlyPort, fileOf('a.txt', text), ROOM);
    expect('loaded' in onText && onText.loaded.value.type).toBe('text');
  });

  it('prefers bytes on a port that takes either, so nothing is decoded needlessly', async () => {
    const result = await loadFileForPort(
      textAndBytesPort,
      fileOf('a.txt', Uint8Array.from([0x68, 0x69])),
      ROOM,
    );

    // `hash` declares text AND bytes. Handing it bytes is lossless; decoding
    // first would refuse a binary file the tool is perfectly able to hash.
    expect('loaded' in result && result.loaded.value.type).toBe('bytes');
  });
});
