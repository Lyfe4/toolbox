import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  binaryBlob,
  blobSource,
  binaryHead,
  binarySize,
  createByteSink,
  deferredBinary,
  HEAD_BYTES,
  materialiseBinary,
  residentBinary,
  residentBytes,
  residentSource,
  sourceFor,
  type Bytes,
  type SyncFileReader,
} from './binary';

function pattern(length: number, seed = 1): Bytes {
  const out = new Uint8Array(length);
  let x = seed >>> 0;
  for (let index = 0; index < length; index += 1) {
    x = (x * 1664525 + 1013904223) >>> 0;
    out[index] = x & 0xff;
  }
  return out;
}

/* ========================================================================== *
 * Where the bytes are
 * ========================================================================== */

describe('a binary value describes itself without being read', () => {
  /*
   * THE WHOLE POINT OF THE HEAD. Everything that DESCRIBES a binary value -
   * the sniff, the node summary, the output panel's preview - runs
   * synchronously on the main thread, and a deferred value's bytes are on
   * disk. Carrying the front of the file is what lets those keep working
   * unchanged, so the two kinds have to be indistinguishable to them.
   */
  it('gives the same size and head whichever kind it is', async () => {
    const bytes = pattern(HEAD_BYTES * 3);
    const resident = residentBinary(bytes);
    const deferred = deferredBinary(new Blob([bytes]), bytes);

    expect(binarySize(resident)).toBe(bytes.byteLength);
    expect(binarySize(deferred)).toBe(bytes.byteLength);
    expect([...binaryHead(resident)]).toEqual([...binaryHead(deferred)]);
    expect(binaryHead(deferred)).toHaveLength(HEAD_BYTES);
    expect([...(await materialiseBinary(deferred))]).toEqual([...bytes]);
  });

  it('keeps a head no longer than the value itself', () => {
    const bytes = pattern(10);
    expect(binaryHead(deferredBinary(new Blob([bytes]), bytes))).toHaveLength(10);
    expect(binaryHead(residentBinary(bytes))).toHaveLength(10);
  });

  it('offers resident bytes only when they are resident', () => {
    const bytes = pattern(64);
    expect(residentBytes(residentBinary(bytes))).toBe(bytes);
    expect(residentBytes(deferredBinary(new Blob([bytes]), bytes))).toBeNull();
  });

  /*
   * A deferred value is what a chosen file becomes, and a download is where it
   * leaves again. Going out as a blob is what makes that free: the browser is
   * handed the reference it already had rather than a copy assembled in the
   * tab that just avoided holding one.
   */
  it('leaves as a blob of the right type either way', async () => {
    const bytes = pattern(128);
    const fromResident = binaryBlob(residentBinary(bytes), 'video/mp4');
    const fromDeferred = binaryBlob(deferredBinary(new Blob([bytes]), bytes), 'video/mp4');

    expect(fromResident.type).toBe('video/mp4');
    expect(fromDeferred.type).toBe('video/mp4');
    expect([...new Uint8Array(await fromDeferred.arrayBuffer())]).toEqual([...bytes]);
    expect(binaryBlob(residentBinary(bytes), null).type).toBe('application/octet-stream');
  });

  /*
   * THE FAN-OUT GUARANTEE, IN ITS NEW FORM. Inputs are borrowed rather than
   * transferred so one output can feed several inputs, and a stream that could
   * only be consumed once would have been in direct tension with that. A blob
   * is not: reading it does not spend it.
   */
  it('reads back the same bytes however many consumers ask', async () => {
    const bytes = pattern(4096, 9);
    const deferred = deferredBinary(new Blob([bytes]), bytes);

    for (let consumer = 0; consumer < 12; consumer += 1) {
      expect([...(await materialiseBinary(deferred))]).toEqual([...bytes]);
    }
  });
});

/* ========================================================================== *
 * Reading through a window
 * ========================================================================== */

describe('a resident source', () => {
  const bytes = pattern(256, 3);
  const source = residentSource(bytes);

  it('reads a byte past the end as zero, the way an array index did', () => {
    expect(source.u8(0)).toBe(bytes[0]);
    expect(source.u8(255)).toBe(bytes[255]);
    expect(source.u8(256)).toBe(0);
    expect(source.u8(-1)).toBe(0);
    expect(source.u8(1e9)).toBe(0);
  });

  it('clamps a span to the end rather than inventing bytes', () => {
    expect(source.view(250, 100)).toHaveLength(6);
    expect(source.slice(250, 100)).toHaveLength(6);
    expect(source.view(300, 10)).toHaveLength(0);
  });

  /*
   * The one sharp edge in the interface, asserted rather than described: a
   * slice is a COPY and a view may alias. Everything a reader keeps past its
   * own walk - a sample entry, a codec private block, a display matrix - has
   * to be the first.
   */
  it('hands back a slice that outlives a change to the original', () => {
    const mutable = pattern(16, 5);
    const over = residentSource(mutable);
    const copied = over.slice(0, 8);
    const viewed = over.view(0, 8);

    mutable[0] = (mutable[0] ?? 0) ^ 0xff;
    expect(copied[0]).not.toBe(mutable[0]);
    expect(viewed[0]).toBe(mutable[0]);
  });

  it('matches the array it was built from, at every offset', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 1, maxLength: 512 }), (sample) => {
        const over = residentSource(sample);
        for (let at = 0; at < sample.length; at += 1) {
          expect(over.u8(at)).toBe(sample[at]);
        }
        expect([...over.slice(0, sample.length)]).toEqual([...sample]);
      }),
      { numRuns: 25 },
    );
  });
});

describe('a source for a value', () => {
  /*
   * IN A WORKER THIS IS A WINDOW AND HERE IT IS A MATERIALISATION, and the
   * asynchronous signature is what makes the second one visible rather than a
   * surprise. jsdom has no `FileReaderSync`, so the unit suite always takes
   * the fallback - which is exactly why the fallback cannot rot.
   */
  it('reads a deferred value the same way a resident one reads', async () => {
    const bytes = pattern(1000, 11);
    const fromResident = await sourceFor(residentBinary(bytes));
    const fromDeferred = await sourceFor(deferredBinary(new Blob([bytes]), bytes));

    expect(fromDeferred.size).toBe(fromResident.size);
    for (const at of [0, 1, 499, 999, 1000]) {
      expect(fromDeferred.u8(at)).toBe(fromResident.u8(at));
    }
    expect([...fromDeferred.slice(100, 50)]).toEqual([...bytes.subarray(100, 150)]);
  });
});

/* ========================================================================== *
 * Writing without holding
 * ========================================================================== */

describe('a byte sink', () => {
  /*
   * A SMALL ANSWER STAYS A `Uint8Array`, and that is load-bearing rather than
   * incidental: every output this app produced before the sink existed is
   * still produced in the same form, at the same cost, and is still something
   * a test can compare against a literal.
   */
  it('keeps a small result resident', () => {
    const sink = createByteSink();
    sink.write(pattern(10, 2));
    sink.write(pattern(10, 3));

    const written = sink.finish();
    expect(written.kind).toBe('resident');
    expect(binarySize(written)).toBe(20);
    expect([...(residentBytes(written) ?? [])]).toEqual([...pattern(10, 2), ...pattern(10, 3)]);
  });

  it('spills a large result and still reads back byte for byte', async () => {
    const sink = createByteSink();
    const chunk = pattern(1024 * 1024, 7);
    for (let index = 0; index < 10; index += 1) sink.write(chunk);

    const written = sink.finish();
    expect(written.kind).toBe('deferred');
    expect(binarySize(written)).toBe(10 * 1024 * 1024);

    const back = await materialiseBinary(written);
    expect(back.byteLength).toBe(10 * 1024 * 1024);
    // Spot checks rather than ten megabytes of comparison, at the two places a
    // chunked writer gets wrong: the join between parts, and the very end.
    for (const at of [0, 1024 * 1024 - 1, 1024 * 1024, 8 * 1024 * 1024, back.byteLength - 1]) {
      expect(back[at]).toBe(chunk[at % chunk.byteLength]);
    }
  });

  /*
   * The head is captured as the bytes go past rather than read back at the
   * end, because by the end the front of the value is in blob storage - and
   * the head exists precisely so that nothing has to read blob storage to
   * describe the value.
   */
  it('carries a head for a spilled result without reading it back', () => {
    const sink = createByteSink();
    const first = pattern(HEAD_BYTES * 2, 13);
    sink.write(first);
    for (let index = 0; index < 10; index += 1) sink.write(pattern(1024 * 1024, 1));

    const written = sink.finish();
    expect(written.kind).toBe('deferred');
    expect([...binaryHead(written)]).toEqual([...first.subarray(0, HEAD_BYTES)]);
  });

  it('copies from a source without assembling it first', () => {
    const source = residentSource(pattern(4096, 17));
    const sink = createByteSink();
    sink.copyFrom(source, 100, 200);
    sink.copyFrom(source, 4000, 200); // runs past the end, and is clamped

    expect(sink.written).toBe(296);
    expect([...(residentBytes(sink.finish()) ?? [])]).toEqual([
      ...source.slice(100, 200),
      ...source.slice(4000, 96),
    ]);
  });

  /*
   * A sink built without spilling is what a realm with no synchronous blob
   * read gets, and it has to produce exactly the same bytes - the transport
   * stream reader assembles through one in the unit suite and through the
   * spilling one in the worker, and a difference between the two would be a
   * bug nothing here could see.
   */
  it('produces the same bytes whether or not it spills', () => {
    fc.assert(
      fc.property(
        fc.array(fc.uint8Array({ minLength: 0, maxLength: 300 }), { maxLength: 40 }),
        (chunks) => {
          const spilling = createByteSink();
          const held = createByteSink({ spill: false });
          for (const chunk of chunks) {
            spilling.write(chunk);
            held.write(chunk);
          }
          expect(spilling.written).toBe(held.written);

          const expected = chunks.flatMap((chunk) => [...chunk]);
          expect([...(residentBytes(spilling.finish()) ?? [])]).toEqual(expected);
          expect([...(residentBytes(held.finish()) ?? [])]).toEqual(expected);
        },
      ),
      { numRuns: 40 },
    );
  });

  /*
   * The intermediate case: a stream gathered out of its packets is written
   * once and then INDEXED, in a different order, by the writer. `source` is
   * the shape that serves, and it has to agree with `finish` about the bytes.
   */
  it('reads back what was written, as a source', () => {
    const sink = createByteSink({ spill: false });
    const written = pattern(300_000, 23);
    for (let at = 0; at < written.byteLength; at += 7000) {
      sink.write(written.subarray(at, at + 7000));
    }

    const source = sink.source();
    expect(source.size).toBe(written.byteLength);
    for (const at of [0, 6999, 7000, 150_000, written.byteLength - 1]) {
      expect(source.u8(at)).toBe(written[at]);
    }
    expect([...source.slice(299_000, 1000)]).toEqual([...written.subarray(299_000)]);
  });
});

/* ========================================================================== *
 * The windowing itself
 * ========================================================================== */

/**
 * A blob whose reads can be watched, and a synchronous reader for it.
 *
 * jsdom has no `FileReaderSync`, so without this the windowing - the alignment,
 * the eviction, the spans that cross two windows - would be reachable only by
 * driving a real browser. That matters more here than it usually would: every
 * one of those has the same failure mode, which is a file that is subtly and
 * silently wrong rather than an error, and a video that is wrong in the middle
 * is not something a test of the ANSWER would catch either.
 *
 * The regions are recorded against the sliced blob rather than in call order,
 * so the assertions below are about which bytes were read and not about the
 * order the source happened to ask in.
 */
function watchedBlob(bytes: Bytes): {
  readonly blob: Blob;
  readonly reader: SyncFileReader;
  readonly reads: [number, number][];
} {
  const blob = new Blob([bytes]);
  const regions = new WeakMap<Blob, Uint8Array>();
  const reads: [number, number][] = [];
  const slice = blob.slice.bind(blob);

  Object.defineProperty(blob, 'slice', {
    value: (start: number, end: number) => {
      const piece = slice(start, end);
      regions.set(piece, bytes.subarray(start, end));
      reads.push([start, end]);
      return piece;
    },
  });

  return {
    blob,
    reads,
    reader: {
      readAsArrayBuffer: (piece) => {
        const region = regions.get(piece);
        if (region === undefined) throw new Error('read a slice this fake did not make');
        return region.slice().buffer;
      },
    },
  };
}

const WINDOW = 1024 * 1024;

describe('a windowed source over a blob', () => {
  /*
   * ALIGNED TO A GRID, which is the difference between reading each region of
   * the file once and sliding a window along it a byte at a time. A walk that
   * asks for byte 5, then 6, then 7 must produce one read, not three.
   */
  it('reads a whole aligned window, once, however many bytes are asked for', () => {
    const bytes = pattern(WINDOW * 3, 21);
    const { blob, reader, reads } = watchedBlob(bytes);
    const source = blobSource(blob, reader);

    for (let at = 0; at < 5000; at += 1) expect(source.u8(at)).toBe(bytes[at]);
    expect(reads).toEqual([[0, WINDOW]]);

    // And the window boundary is a second read, not a re-read of the first.
    expect(source.u8(WINDOW + 10)).toBe(bytes[WINDOW + 10]);
    expect(reads).toEqual([
      [0, WINDOW],
      [WINDOW, WINDOW * 2],
    ]);
  });

  it('clamps the last window to the end of the blob', () => {
    const bytes = pattern(WINDOW + 100, 22);
    const { blob, reader, reads } = watchedBlob(bytes);
    const source = blobSource(blob, reader);

    expect(source.u8(WINDOW + 99)).toBe(bytes[WINDOW + 99]);
    expect(reads).toEqual([[WINDOW, WINDOW + 100]]);
    expect(source.u8(WINDOW + 100)).toBe(0);
    expect(source.size).toBe(WINDOW + 100);
  });

  /*
   * FOUR WINDOWS, AND THE WRITER IS WHY. It copies the finished file in
   * playback order, which alternates between the video track's bytes and the
   * audio track's every second or so - two cursors, a long way apart. With one
   * window that pattern reloads it twice per chunk; a two-hour film would read
   * fourteen gigabytes to copy two.
   */
  it('keeps two distant cursors resident instead of thrashing between them', () => {
    const bytes = pattern(WINDOW * 8, 23);
    const { blob, reader, reads } = watchedBlob(bytes);
    const source = blobSource(blob, reader);

    const video = 0;
    const audio = WINDOW * 5;
    for (let step = 0; step < 50; step += 1) {
      expect(source.u8(video + step)).toBe(bytes[video + step]);
      expect(source.u8(audio + step)).toBe(bytes[audio + step]);
    }

    expect(reads).toEqual([
      [0, WINDOW],
      [WINDOW * 5, WINDOW * 6],
    ]);
  });

  it('evicts the least recently read window when a fifth is wanted', () => {
    const bytes = pattern(WINDOW * 6, 24);
    const { blob, reader, reads } = watchedBlob(bytes);
    const source = blobSource(blob, reader);

    // Touch five separate windows, then go back to the second - which is still
    // held, because the first was the one evicted.
    for (const window of [0, 1, 2, 3, 4]) source.u8(WINDOW * window);
    expect(reads).toHaveLength(5);

    source.u8(WINDOW * 1 + 5);
    expect(reads).toHaveLength(5);

    // And the first is gone, so asking for it again is a sixth read.
    source.u8(0);
    expect(reads).toHaveLength(6);
  });

  /*
   * THE PROMISE THE TRANSPORT-STREAM WALK DEPENDS ON. It pulls a block of
   * packets and iterates inside it while the visitor reads elsewhere in the
   * file - which can evict the very window the block is a view onto. A window
   * is REPLACED rather than overwritten, so the block stays readable, and that
   * is a property of this implementation rather than a hope about it.
   */
  it('leaves an earlier view readable after its window has been evicted', () => {
    const bytes = pattern(WINDOW * 8, 25);
    const { blob, reader } = watchedBlob(bytes);
    const source = blobSource(blob, reader);

    const held = source.view(0, 64);
    expect([...held]).toEqual([...bytes.subarray(0, 64)]);

    for (const window of [1, 2, 3, 4, 5]) source.u8(WINDOW * window);

    expect([...held]).toEqual([...bytes.subarray(0, 64)]);
  });

  it('assembles a span that crosses two windows', () => {
    const bytes = pattern(WINDOW * 3, 26);
    const { blob, reader } = watchedBlob(bytes);
    const source = blobSource(blob, reader);

    const across = source.slice(WINDOW - 8, 16);
    expect([...across]).toEqual([...bytes.subarray(WINDOW - 8, WINDOW + 8)]);

    // `view` gives the same bytes where it has to assemble them, and the
    // difference between the two is only whether it may alias.
    expect([...source.view(WINDOW - 8, 16)]).toEqual([...across]);
  });

  it('reads a span longer than a window without disturbing the cache', () => {
    const bytes = pattern(WINDOW * 4, 27);
    const { blob, reader, reads } = watchedBlob(bytes);
    const source = blobSource(blob, reader);

    source.u8(0);
    const big = source.slice(WINDOW, WINDOW * 2 + 10);
    expect(big).toHaveLength(WINDOW * 2 + 10);
    expect([...big.subarray(0, 8)]).toEqual([...bytes.subarray(WINDOW, WINDOW + 8)]);
    expect([...big.subarray(big.length - 8)]).toEqual([
      ...bytes.subarray(WINDOW * 3 + 2, WINDOW * 3 + 10),
    ]);

    // One aligned window for the first byte, then the span read whole - and
    // the window it evicted nothing to make room for is still there.
    expect(reads).toEqual([
      [0, WINDOW],
      [WINDOW, WINDOW * 3 + 10],
    ]);
    source.u8(1);
    expect(reads).toHaveLength(2);
  });

  it('reads every byte of a blob the same way a resident source does', () => {
    const bytes = pattern(WINDOW * 2 + 1234, 28);
    const { blob, reader } = watchedBlob(bytes);
    const windowed = blobSource(blob, reader);
    const resident = residentSource(bytes);

    for (const at of [
      0,
      1,
      WINDOW - 1,
      WINDOW,
      WINDOW + 1,
      WINDOW * 2 - 1,
      WINDOW * 2,
      bytes.byteLength - 1,
      bytes.byteLength,
      bytes.byteLength + 1000,
    ]) {
      expect(windowed.u8(at)).toBe(resident.u8(at));
    }
    expect([...windowed.slice(bytes.byteLength - 10, 50)]).toEqual([
      ...resident.slice(bytes.byteLength - 10, 50),
    ]);
    expect(windowed.view(bytes.byteLength + 5, 10)).toHaveLength(0);
  });
});
