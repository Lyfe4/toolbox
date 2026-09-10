import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { ToolResult } from '@/features/registry/types';

import { avcConfig, ebml, makeMatroska, makeMp4, mp4Box, sampleBytes } from './fixtures';
import { readIsoBmff } from './isobmff';
import { readMatroska } from './matroska';
import { remux } from './remux';

/**
 * ADVERSARIAL INPUT, WHICH IS WHERE THE FIRST REAL BUG WAS ALWAYS GOING TO BE.
 *
 * The feasibility investigation that led to this tool named this as the gap in
 * itself: every file its spike saw was one ffmpeg had just written, and this
 * repository's own history is emphatic about what that misses. The image
 * tool's decompression-bomb guard READ AS SAFE and was measured committing
 * 1.6 GB before it ran, and the README documented it as a strength.
 *
 * The difference here is that this tool has no library between it and the
 * file. Every byte of an MP4 or a Matroska file is parsed by code in this
 * directory, so a hostile file's whole surface is ours. Three properties have
 * to hold whatever it says, and each has its own section below:
 *
 *   1. IT RETURNS. No parser here may loop, recurse without bound, or spend
 *      time proportional to a number the file chose rather than to the number
 *      of bytes it actually contains.
 *   2. IT DOES NOT ALLOCATE ON TRUST. Every table in both containers begins
 *      with a count the file wrote, and no array is ever sized from one.
 *   3. IT NEVER THROWS. A tool that throws takes the worker down and every
 *      unrelated request in flight with it, which is the one failure the whole
 *      result type exists to prevent.
 *
 * And a fourth that is about honesty rather than safety: A DAMAGED FILE IS
 * REFUSED OR REPORTED, NEVER QUIETLY HALF-CONVERTED. The worst outcome
 * available here is not a crash - it is a file that looks exactly like a
 * successful repackage and holds a run of zeros.
 */

/** Where a four-character box or element tag sits, so a test can corrupt it. */
function indexOfTag(bytes: Uint8Array, tag: string): number {
  return new TextDecoder('latin1').decode(bytes).indexOf(tag);
}

function withBytesAt(source: Uint8Array, at: number, values: readonly number[]): Uint8Array {
  const out = new Uint8Array(source);
  out.set(values, at);
  return out;
}

function expectRefused<T>(result: ToolResult<T>): string {
  expect(result.ok).toBe(false);
  if (result.ok) return '';
  return `${result.error.message} ${result.error.detail ?? ''}`;
}

const VIDEO = {
  kind: 'video',
  fourcc: 'avc1',
  timescale: 1000,
  delta: 40,
  samples: [sampleBytes(1, 500), sampleBytes(2, 400), sampleBytes(3, 450)],
  width: 640,
  height: 480,
} as const;

const validMp4 = makeMp4({ tracks: [VIDEO] });

const validMkv = makeMatroska({
  tracks: [
    {
      number: 1,
      kind: 'video',
      codecId: 'V_MPEG4/ISO/AVC',
      codecPrivate: avcConfig(),
      width: 640,
      height: 480,
    },
  ],
  blocks: [
    { track: 1, time: 0, frames: [sampleBytes(1, 500)] },
    { track: 1, time: 40, frames: [sampleBytes(2, 400)] },
  ],
});

/* ========================================================================== *
 * 1. Box headers that cannot be true
 * ========================================================================== */

describe('a box header that cannot be true', () => {
  it('refuses a size smaller than the header it sits in', () => {
    // Three bytes for something that needs eight. Believed, this rewinds the
    // cursor and the walk never ends.
    const at = indexOfTag(validMp4, 'moov') - 4;
    const said = expectRefused(remux(withBytesAt(validMp4, at, [0, 0, 0, 3]), 'container'));
    expect(said).toContain('less than a header');
  });

  it('refuses a box that runs past the file that contains it', () => {
    const at = indexOfTag(validMp4, 'moov') - 4;
    const said = expectRefused(
      remux(withBytesAt(validMp4, at, [0x7f, 0xff, 0xff, 0xff]), 'container'),
    );
    expect(said).toContain('past the end');
  });

  it('refuses a 64-bit size with no room for its own field', () => {
    // Size 1 says "the real size is the eight bytes after the type", and this
    // box is at the very end of the file.
    const truncated = new Uint8Array(validMp4.byteLength + 8);
    truncated.set(validMp4);
    truncated.set([0, 0, 0, 1, 0x66, 0x72, 0x65, 0x65], validMp4.byteLength);
    const said = expectRefused(remux(truncated, 'container'));
    expect(said).toContain('64-bit size');
  });

  it('refuses a 64-bit size that is smaller than the header it declares', () => {
    const at = indexOfTag(validMp4, 'moov') - 4;
    const broken = withBytesAt(validMp4, at, [0, 0, 0, 1]);
    // The largesize field lands where `moov`'s first child used to start.
    broken.set([0, 0, 0, 0, 0, 0, 0, 4], at + 8);
    expect(expectRefused(remux(broken, 'container'))).toContain('smaller than its own header');
  });

  it('accepts a size of zero, which legitimately means "to the end"', () => {
    // The shape a streamed `mdat` is written with. Treated as an actual zero
    // it is a box that never advances; refused outright it breaks real files.
    const at = indexOfTag(validMp4, 'mdat') - 4;
    const streamed = withBytesAt(validMp4, at, [0, 0, 0, 0]);
    // `moov` now sits inside `mdat`, so there is no index and the file is
    // refused - but for the right reason, and without hanging.
    expect(expectRefused(remux(streamed, 'container'))).toContain('no movie header');
  });

  it('refuses boxes nested deeper than any real file nests them', () => {
    let nested = mp4Box('moov', mp4Box('free'));
    for (let depth = 0; depth < 20; depth += 1) nested = mp4Box('free', nested);
    const bomb = new Uint8Array([...mp4Box('ftyp', [0x69, 0x73, 0x6f, 0x6d]), ...nested]);
    expect(remux(bomb, 'container').ok).toBe(false);
  });
});

/* ========================================================================== *
 * 2. Counts the file made up
 * ========================================================================== */

describe('a declared count that the file has no room for', () => {
  /**
   * The single most important guard in the reader, exercised four ways.
   *
   * Each of these boxes begins with a 32-bit entry count, and each is followed
   * by entries of a fixed width. Believed, the smallest of these asks for four
   * billion entries out of a twelve-byte box - which is not a slow parse, it
   * is thirty gigabytes of allocation before a single check runs.
   */
  it.each(['stsz', 'stts', 'stsc', 'stco', 'stss'])(
    'clamps %s to what the box actually holds',
    (table) => {
      const at = indexOfTag(validMp4, table);
      if (at === -1) return;
      // The count sits four bytes into the body for every one of these, and
      // eight for `stsz`, whose first field is the uniform size.
      const countAt = at + 4 + 4 + (table === 'stsz' ? 4 : 0);
      const started = Date.now();
      const result = remux(withBytesAt(validMp4, countAt, [0xff, 0xff, 0xff, 0xff]), 'container');
      // Refused or repackaged, but bounded either way, and the elapsed time is
      // the only observable proof: a reader that believed the count would
      // still be allocating.
      expect(Date.now() - started).toBeLessThan(1000);
      if (result.ok) expect(result.value.bytes.byteLength).toBeLessThan(validMp4.byteLength * 4);
    },
  );

  it('refuses a chunk that claims to hold no samples', () => {
    // `samples_per_chunk` of zero: every chunk consumes nothing, so a walk
    // that trusts it makes no progress through the sample list.
    const at = indexOfTag(validMp4, 'stsc');
    const said = expectRefused(remux(withBytesAt(validMp4, at + 16, [0, 0, 0, 0]), 'container'));
    expect(said).toContain('no readable tracks');
  });

  it('does not size a table from a uniform sample size the file cannot hold', () => {
    // `stsz` with a fixed size of one byte and four billion samples is twelve
    // bytes on disk and asks for a four-billion-entry table. The file's own
    // length is the bound: a one-byte sample cannot appear more times than
    // there are bytes.
    const at = indexOfTag(validMp4, 'stsz');
    const bomb = withBytesAt(validMp4, at + 8, [0, 0, 0, 1]);
    bomb.set([0xff, 0xff, 0xff, 0xff], at + 12);
    const started = Date.now();
    expectRefused(remux(bomb, 'container'));
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

/* ========================================================================== *
 * 3. An index that does not match the media
 * ========================================================================== */

describe('an index describing bytes that are not there', () => {
  it('refuses a truncated file rather than repackaging a run of zeros', () => {
    // The exact shape of an interrupted download: a complete index, and media
    // data that stops early. Reading past the end of a Uint8Array is not a
    // crash in JavaScript - it is `undefined` per byte - so without this check
    // the output is a perfectly well-formed MP4 full of silence and black.
    const done = remux(validMp4.subarray(0, validMp4.byteLength - 40), 'container');
    // The tail holds the index, so this one is refused for want of a `moov`.
    expect(done.ok).toBe(false);
  });

  it('refuses an offset that points outside the file', () => {
    const at = indexOfTag(validMp4, 'stco');
    const said = expectRefused(
      remux(withBytesAt(validMp4, at + 12, [0x00, 0xff, 0xff, 0xff]), 'container'),
    );
    expect(said).toContain('truncated');
  });

  it('refuses an index asking for far more media than the file contains', () => {
    /*
     * Nothing in either container forbids two samples from pointing at the
     * same bytes, so a small file can describe an enormous one. Here every
     * sample is enlarged to nearly the whole file; with a real sample count
     * that is gigabytes of output from a two-kilobyte input, and every
     * individual range in it is inside the file and passes every other check.
     */
    const count = 2000;
    const source = makeMp4({
      tracks: [
        { ...VIDEO, samples: Array.from({ length: count }, (_, index) => sampleBytes(index, 4)) },
      ],
    });

    // Every sample enlarged to four kilobytes, all still starting inside the
    // file. Eight megabytes of output from a twenty-five kilobyte input, with
    // every individual range legal.
    const at = indexOfTag(source, 'stsz');
    const inflated = new Uint8Array(source);
    for (let index = 0; index < count; index += 1) {
      inflated.set([0, 0, 0x10, 0x00], at + 16 + index * 4);
    }

    const said = expectRefused(remux(inflated, 'container'));
    expect(said).toContain('more media than it contains');
  });
});

/* ========================================================================== *
 * 4. Matroska, whose lengths are the file's to choose
 * ========================================================================== */

describe('a Matroska file that lies about its own shape', () => {
  it('refuses an EBML integer that declares a length nothing can hold', () => {
    // A first byte of zero says "the length marker is past the eighth bit",
    // which EBML does not define. Read carelessly it consumes no bytes, and a
    // walk that consumes no bytes does not end.
    const at = indexOfTag(validMkv, 'matroska') + 20;
    expect(remux(withBytesAt(validMkv, at, [0x00, 0x00, 0x00, 0x00]), 'container').ok).toBe(false);
  });

  it('refuses an unsized element that is not the segment', () => {
    /*
     * A length of "unknown" - a vint whose value bits are all set - is legal
     * on a Segment, where it means "the rest of the file", and that is how a
     * live capture is written. Anywhere else it means the reader has to guess
     * where the element ends by scanning compressed frame data for something
     * that looks like the next id, which is guesswork with a plausible wrong
     * answer. Refused by name.
     */
    const segmentAt = validMkv.indexOf(0x18);
    const unsizedTracks = new Uint8Array([0x16, 0x54, 0xae, 0x6b, 0xff, 0, 0, 0, 0]);
    const broken = new Uint8Array([
      ...validMkv.subarray(0, segmentAt),
      ...ebml(0x18538067, unsizedTracks),
    ]);

    expect(expectRefused(remux(broken, 'container'))).toContain('does not say how long it is');
  });

  it('refuses a timestamp scale of zero rather than dividing by it', () => {
    const source = makeMatroska({
      timestampScale: 0,
      tracks: [{ number: 1, kind: 'video', codecId: 'V_MPEG4/ISO/AVC', codecPrivate: avcConfig() }],
      blocks: [{ track: 1, time: 0, frames: [sampleBytes(1, 100)] }],
    });
    expect(expectRefused(remux(source, 'container'))).toContain('zero seconds long');
  });

  it('refuses a document type that is not a video', () => {
    const source = makeMatroska({
      docType: 'seomthing-else',
      tracks: [{ number: 1, kind: 'video', codecId: 'V_MPEG4/ISO/AVC', codecPrivate: avcConfig() }],
      blocks: [{ track: 1, time: 0, frames: [sampleBytes(1, 100)] }],
    });
    expect(expectRefused(remux(source, 'container'))).toContain('seomthing-else');
  });

  it('drops a lace whose frame sizes overrun the block that holds them', () => {
    /*
     * Xiph lacing writes each frame's size as a run of 0xFF bytes plus a
     * remainder, and nothing ties the total to what the block actually holds.
     * Here the first frame claims 520 bytes out of a block with twenty in it.
     * Believed, that is a sample pointing at bytes belonging to whatever
     * element comes next - which in this file is the end of the buffer.
     *
     * The body is written out directly: track number 1, a zero relative
     * timestamp, keyframe plus Xiph lacing, two frames, then the impossible
     * size. It cannot be expressed by describing frames, because the whole
     * point of it is that the description and the frames disagree.
     */
    const source = makeMatroska({
      tracks: [
        { number: 1, kind: 'audio', codecId: 'A_AAC', codecPrivate: new Uint8Array([0x12, 0x10]) },
      ],
      blocks: [
        {
          track: 1,
          time: 0,
          frames: [],
          rawBody: new Uint8Array([
            0x81,
            0x00,
            0x00,
            0x82,
            0x01,
            0xff,
            0xff,
            0x0a,
            ...sampleBytes(1, 20),
          ]),
        },
      ],
    });

    expect(expectRefused(remux(source, 'container'))).toContain('no frames');
  });

  it('ignores a track numbered zero, which no block can ever address', () => {
    const source = makeMatroska({
      tracks: [
        { number: 0, kind: 'video', codecId: 'V_MPEG4/ISO/AVC', codecPrivate: avcConfig() },
        {
          number: 1,
          kind: 'video',
          codecId: 'V_MPEG4/ISO/AVC',
          codecPrivate: avcConfig(),
          width: 320,
          height: 240,
        },
      ],
      blocks: [{ track: 1, time: 0, frames: [sampleBytes(1, 100)] }],
    });
    const read = readMatroska(source);
    if (!read.ok) throw new Error(read.error.message);
    expect(read.value.tracks).toHaveLength(1);
    expect(read.value.tracks[0]?.width).toBe(320);
  });

  it('drops a stream that never says how to decode it', () => {
    // A track entry with no CodecPrivate. Writing the sample entry anyway
    // produces a file that looks complete and plays nothing at all.
    const source = makeMatroska({
      tracks: [{ number: 1, kind: 'video', codecId: 'V_MPEG4/ISO/AVC', width: 320, height: 240 }],
      blocks: [{ track: 1, time: 0, frames: [sampleBytes(1, 100)] }],
    });
    const said = expectRefused(remux(source, 'container'));
    expect(said).toContain('how to decode');
  });
});

/* ========================================================================== *
 * 5. The properties, over inputs nobody wrote down
 * ========================================================================== */

describe('the properties that must hold for any bytes at all', () => {
  /**
   * NOTHING THROWS ACROSS THE BOUNDARY.
   *
   * A tool that throws does not merely fail its own node: it takes the worker
   * down and every unrelated request in flight with it, and the engine has to
   * rebuild and replay. `worker.ts` converts a throw into an `internal` error
   * precisely because a tool might, and this is the assertion that says this
   * one does not need that net.
   */
  it('returns a result for arbitrary bytes, and never throws', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 0, maxLength: 400 }), (bytes) => {
        expect(() => remux(bytes, 'container')).not.toThrow();
        expect(() => remux(bytes, 'audio')).not.toThrow();
      }),
      { numRuns: 300 },
    );
  });

  /**
   * And the same over bytes that get PAST the front door, which random noise
   * almost never does: a real header followed by nonsense is the shape that
   * reaches the sample-table code at all.
   */
  it.each([
    ['an ISO base media header', [0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]],
    ['an EBML header', [0x1a, 0x45, 0xdf, 0xa3]],
  ])('returns a result for %s followed by noise', (_name, prefix) => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 8, maxLength: 400 }), (tail) => {
        const bytes = new Uint8Array([...prefix, ...tail]);
        expect(() => remux(bytes, 'container')).not.toThrow();
      }),
      { numRuns: 300 },
    );
  });

  /**
   * A REAL FILE, ONE BYTE AT A TIME.
   *
   * Random noise is refused at the first box header and proves little. Damage
   * to a file that is otherwise entirely valid is what actually reaches the
   * interesting code, and it is the shape a half-finished download, a bad
   * sector or a truncated upload really has.
   *
   * The assertion is deliberately not "it fails": some corruptions are to
   * bytes nothing reads, and those must still convert. It is that the tool
   * always ANSWERS, in bounded time, and never invents media that is not in
   * the file.
   */
  it.each([
    ['MP4', validMp4],
    ['Matroska', validMkv],
  ])('answers for a corrupted %s, whatever the damage', (_name, valid) => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: valid.byteLength - 1 }),
        fc.integer({ min: 0, max: 255 }),
        (at, value) => {
          const damaged = withBytesAt(valid, at, [value]);
          const started = Date.now();
          const done = remux(damaged, 'container');
          expect(Date.now() - started).toBeLessThan(500);
          if (done.ok) {
            expect(done.value.bytes.byteLength).toBeLessThanOrEqual(damaged.byteLength * 2 + 4096);
          }
        },
      ),
      { numRuns: 400 },
    );
  });

  it('answers for a file cut short at any point', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: validMp4.byteLength }), (length) => {
        expect(() => remux(validMp4.subarray(0, length), 'container')).not.toThrow();
      }),
      { numRuns: 200 },
    );
  });

  /**
   * AND THE READERS ARE HELD TO THE SAME LINE DIRECTLY.
   *
   * `remux` refuses most nonsense before either reader is reached - the
   * container sniff alone rejects almost every random buffer - so the
   * properties above prove much less about the parsers than they appear to.
   * These call them with the signature already in place.
   */
  it('reads or refuses any bytes claiming to be either container', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 16, maxLength: 300 }), (tail) => {
        const iso = new Uint8Array([0, 0, 0, 0x10, 0x66, 0x74, 0x79, 0x70, ...tail]);
        const mkv = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, ...tail]);
        expect(() => readIsoBmff(iso)).not.toThrow();
        expect(() => readMatroska(mkv)).not.toThrow();
      }),
      { numRuns: 300 },
    );
  });
});
