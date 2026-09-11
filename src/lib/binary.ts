/**
 * WHERE A BINARY VALUE'S BYTES ACTUALLY ARE.
 *
 * For most of this app's life every `bytes` value in it was a whole
 * `Uint8Array`, and that was the right answer: a 2 MB PNG, a base64 payload, a
 * digest's input. It stopped being the right answer when the video tool
 * arrived, because the files that tool exists for - a DivX film, an hour of
 * tuner recording, a camcorder clip the format itself split at 2 GB - are
 * larger than a tab can hold even once, let alone the three or four times a
 * run used to hold them.
 *
 * So a binary value now says where its bytes are rather than carrying them:
 *
 *   - RESIDENT, which is a `Uint8Array` and is exactly what every value was
 *     before. Small things stay small things, and nothing about them changed.
 *   - DEFERRED, which is a `Blob` - very often the `File` the user chose,
 *     still sitting on their disk and never read - plus its size and its first
 *     few kilobytes.
 *
 * THREE PROPERTIES OF A BLOB ARE WHY THIS WORKS, and each one answers an
 * objection that had killed the idea before:
 *
 *   1. A Blob crosses `postMessage` BY REFERENCE. Measured in all three
 *      engines: handing a 512 MB blob to a worker takes 0.0-6.0 ms, against
 *      294 ms merely to allocate and fill 64 MB of ordinary memory. So the
 *      structured clone that used to be the second copy of the input is no
 *      copy at all.
 *   2. A Blob is IMMUTABLE AND RE-READABLE, which is the whole reason this is
 *      a blob and not a stream. Inputs in this engine are borrowed rather than
 *      transferred precisely so one output can feed several inputs, and a
 *      stream that can only be consumed once is in direct tension with that
 *      guarantee. A blob is in no tension with it at all: twelve consumers
 *      reading one blob get twelve intact copies of the bytes, and the cost is
 *      twelve pointers.
 *   3. A Blob's bytes are the BROWSER's problem rather than the tab's. The
 *      result cache holds whole outputs for the life of the tab and its whole
 *      design is that it never has to look at a value; a deferred value is a
 *      reference, so that stays true of a two-gigabyte output exactly as it
 *      was of a two-kilobyte one.
 *
 * AND ONE PROPERTY THAT IS A LIMIT RATHER THAN A GIFT. Blob storage is not
 * unbounded, and the bound is not the same in every engine - see
 * `MAX_BLOB_BYTES`.
 */

/**
 * Bytes we own.
 *
 * Explicitly `Uint8Array<ArrayBuffer>` rather than the default
 * `Uint8Array<ArrayBufferLike>`: the loose form also permits a
 * SharedArrayBuffer, which can be neither transferred to a worker nor used to
 * build a Blob. Pinning it here means those guarantees hold everywhere.
 */
export type Bytes = Uint8Array<ArrayBuffer>;

/**
 * How much of a deferred value travels beside the reference.
 *
 * Everything in this app that looks at binary data WITHOUT processing it - the
 * sniff that decides what a file is, the node summary that says "14.2 MB MP4
 * video", the hex preview in the output panel - needs the front of the file
 * and nothing else. Carrying that much is what lets every one of them keep
 * working synchronously, on the main thread, against a value whose bytes are
 * on disk.
 *
 * 4096, because that is already this app's idea of "enough to know what this
 * is": `sniffBytes` matches signatures in the first twelve bytes and runs its
 * is-this-text heuristic over the first 4 kB, so a head this long gives a
 * byte-identical `SniffResult` to the whole file.
 */
export const HEAD_BYTES = 4096;

/**
 * The largest blob every engine has been measured able to read back.
 *
 * Chromium refuses at 2 GiB - a `NotReadableError` out of `FileReaderSync`, on
 * a blob it had itself just built - and 1.88 GiB is the largest size that
 * worked. Gecko and JavaScriptCore both read a 4 GiB blob without complaint.
 * So this is Chromium's number, and it is the one that binds.
 *
 * It is a ceiling on what this app can PRODUCE rather than on what it can
 * read. An input arrives as a `File` the operating system is holding, and
 * windowed reads out of one assemble nothing. Anything built here - an output,
 * a stream gathered out of a transport stream - has to fit under this, and the
 * tool that would exceed it is expected to say so by name rather than to fail
 * at the moment somebody presses Download.
 */
export const MAX_BLOB_BYTES = 1_920 * 1024 * 1024;

/* ========================================================================== *
 * The value
 * ========================================================================== */

export type BinaryData =
  | { readonly kind: 'resident'; readonly bytes: Bytes }
  | {
      readonly kind: 'deferred';
      readonly blob: Blob;
      readonly size: number;
      /** The first `HEAD_BYTES`, or the whole thing where it is shorter. */
      readonly head: Bytes;
    };

export function residentBinary(bytes: Bytes): BinaryData {
  return { kind: 'resident', bytes };
}

/**
 * A value that points at a blob instead of holding it.
 *
 * The head is passed in rather than read here, because every caller already
 * has it: a chosen file was sniffed from its first 4 kB before it was accepted
 * for a port, and a written output passed its first 4 kB through the sink.
 * Reading it again would be the one asynchronous step in an otherwise
 * synchronous path, for bytes somebody has already looked at.
 */
export function deferredBinary(blob: Blob, head: Bytes): BinaryData {
  return {
    kind: 'deferred',
    blob,
    size: blob.size,
    head: head.slice(0, HEAD_BYTES),
  };
}

/**
 * The bytes, when they happen to be here, and null when they are not.
 *
 * For the places that can do something better with bytes in hand and
 * something sensible without them - a preview, an assertion, a copy to the
 * clipboard. Anything that NEEDS them whole awaits `materialiseBinary`.
 */
export function residentBytes(data: BinaryData): Bytes | null {
  return data.kind === 'resident' ? data.bytes : null;
}

export function binarySize(data: BinaryData): number {
  return data.kind === 'resident' ? data.bytes.byteLength : data.size;
}

/**
 * The front of a binary value, for anything that describes it rather than
 * processes it.
 *
 * Synchronous for both kinds, which is the point: `resultSummary` runs during
 * a render and `sniffBytes` runs during a file selection, and neither of those
 * can wait on a disk read.
 */
export function binaryHead(data: BinaryData): Bytes {
  return data.kind === 'resident' ? data.bytes.subarray(0, HEAD_BYTES) : data.head;
}

/**
 * The value as a Blob, for a download or an object URL.
 *
 * Free for a deferred value and a copy for a resident one, which is the right
 * way round: the resident ones are the small ones.
 */
export function binaryBlob(data: BinaryData, mediaType: string | null): Blob {
  const type = mediaType ?? 'application/octet-stream';
  return data.kind === 'deferred'
    ? data.blob.slice(0, data.size, type)
    : new Blob([data.bytes], { type });
}

/**
 * THE ONE PLACE THAT BUFFERS A WHOLE VALUE, and it is deliberately hard to
 * reach by accident.
 *
 * A tool never calls this. `eraseTool` calls it, once, for a tool that
 * declared it reads binary input RESIDENTLY - and by the time it does, the
 * engine has already refused anything over that tool's own `maxInputBytes`.
 * So the size of what this allocates is a number the tool wrote down about
 * itself, rather than the size of whatever happened to arrive.
 *
 * That is the whole answer to "what do the tools that do not stream have to
 * know about the ones that do": nothing. They declare a limit and are handed
 * bytes inside it, exactly as before.
 */
export async function materialiseBinary(data: BinaryData): Promise<Bytes> {
  if (data.kind === 'resident') return data.bytes;
  return new Uint8Array(await data.blob.arrayBuffer());
}

/* ========================================================================== *
 * Reading without holding
 * ========================================================================== */

/**
 * RANDOM ACCESS OVER BYTES THAT MAY NOT BE IN MEMORY.
 *
 * This is what a tool that reads large binary input is handed instead of a
 * `Uint8Array`, and the shape of it is chosen to fit the parsers that already
 * exist rather than to be elegant. Three properties, each load-bearing:
 *
 *   - IT IS SYNCHRONOUS. Every container reader in this repository is a
 *     synchronous walk over offsets, and the alternative - an `await` in the
 *     middle of a loop that visits twenty million transport-stream packets -
 *     is not a change to those parsers, it is a rewrite of them into
 *     incremental state machines. `FileReaderSync` exists in a worker in all
 *     three engines precisely for this, and a windowed read through it runs at
 *     868 MB/s in JavaScriptCore, 1149 MB/s in Chromium and 4163 MB/s in
 *     Gecko, measured over a 512 MB blob in 4 MB windows.
 *   - READING PAST THE END GIVES ZERO, which is what indexing a `Uint8Array`
 *     past its end already did. Every reader in the video tool was written
 *     against that behaviour and checks its ranges separately; changing it
 *     into a throw here would move a documented refusal into a crash.
 *   - `view` HANDS BACK A WINDOW AND `slice` HANDS BACK A COPY. The
 *     distinction is the one sharp edge in this interface and it is why both
 *     exist: a walk that reads a header and moves on wants the window, and
 *     anything KEPT past the next read - a sample entry, a codec private
 *     block, a display matrix - has to be a copy.
 */
export interface ByteSource {
  readonly size: number;
  /** One byte. Zero past the end, exactly as indexing an array would give. */
  readonly u8: (at: number) => number;
  /**
   * A view of `[at, at + length)`, clamped to the end of the source.
   *
   * READ-ONLY, AND IT MAY ALIAS AN INTERNAL WINDOW - so never write through
   * one. It stays READABLE for as long as it is held, which is a promise this
   * interface makes deliberately rather than by accident: a window that is
   * evicted is REPLACED with a fresh array rather than overwritten in place,
   * and the transport-stream walk relies on that - it pulls a block of packets
   * and iterates inside it while the visitor reads elsewhere in the file.
   *
   * Use `slice` when the bytes have to be owned rather than merely read.
   */
  readonly view: (at: number, length: number) => Uint8Array;
  /** A copy of `[at, at + length)` that outlives the next read. */
  readonly slice: (at: number, length: number) => Bytes;
}

/** A source over bytes that are already here. Every read is a direct index. */
export function residentSource(bytes: Bytes): ByteSource {
  return {
    size: bytes.byteLength,
    u8: (at) => (at >= 0 && at < bytes.byteLength ? (bytes[at] ?? 0) : 0),
    view: (at, length) => bytes.subarray(Math.max(0, at), Math.max(0, at) + Math.max(0, length)),
    slice: (at, length) => bytes.slice(Math.max(0, at), Math.max(0, at) + Math.max(0, length)),
  };
}

/**
 * How much of a blob one window holds, and how many windows a source keeps.
 *
 * Four rather than one, and the reason is the MP4 writer rather than any
 * reader. It copies the finished file chunk by chunk in playback order, which
 * alternates between the video track's bytes and the audio track's bytes every
 * second or so - two cursors, a long way apart in the file. With a single
 * window that pattern reloads the window twice per chunk and a two-hour film
 * reads fourteen gigabytes to copy two. With four, both cursors stay resident
 * and each byte of the input is read about once.
 *
 * Four megabytes of window per source is the budget that buys it, and it is
 * a bounded number rather than a fraction of anything.
 */
const WINDOW_BYTES = 1024 * 1024;
const WINDOW_COUNT = 4;

interface Window {
  start: number;
  end: number;
  bytes: Uint8Array;
  /** Monotonic use counter, for evicting the least recently read. */
  used: number;
}

/**
 * A source over a blob, read in windows through `FileReaderSync`.
 *
 * WORKER ONLY, and deliberately so rather than incidentally: `FileReaderSync`
 * is the only synchronous way to get bytes out of a blob, it exists nowhere
 * else, and a tool that wants one has declared it runs in the worker. The
 * caller checks `canWindowBlobs` rather than this throwing, so the fallback is
 * a decision somewhere a person can read it.
 */
export function blobSource(blob: Blob): ByteSource {
  const Reader = syncReaderConstructor();
  if (Reader === null) {
    // Unreachable through `sourceFor` and through every sink built with
    // `spill: canWindowBlobs()`. Stated rather than assumed, because the
    // alternative to a message is a `TypeError` about an undefined global.
    throw new Error('Blobs cannot be read synchronously outside a worker.');
  }
  const reader = new Reader();
  const size = blob.size;
  const windows: Window[] = [];
  let clock = 0;

  function windowFor(at: number): Window {
    clock += 1;
    for (const held of windows) {
      if (at >= held.start && at < held.end) {
        held.used = clock;
        return held;
      }
    }

    // Aligned to the window grid, so a sequential walk reads each region once
    // rather than sliding a window along by one byte at a time.
    const start = Math.floor(at / WINDOW_BYTES) * WINDOW_BYTES;
    const end = Math.min(size, start + WINDOW_BYTES);
    const bytes = new Uint8Array(reader.readAsArrayBuffer(blob.slice(start, end)));

    let oldest: Window | undefined;
    if (windows.length >= WINDOW_COUNT) {
      for (const held of windows)
        if (oldest === undefined || held.used < oldest.used) oldest = held;
    }

    if (oldest === undefined) {
      const fresh: Window = { start, end, bytes, used: clock };
      windows.push(fresh);
      return fresh;
    }

    oldest.start = start;
    oldest.end = end;
    oldest.bytes = bytes;
    oldest.used = clock;
    return oldest;
  }

  /**
   * A span, assembled out of however many windows it crosses.
   *
   * A request longer than one window is read directly instead, because putting
   * it through the cache would evict everything else to hold something the
   * caller is about to copy anyway.
   */
  function span(at: number, length: number): Bytes {
    const from = Math.min(Math.max(0, at), size);
    const to = Math.min(size, from + Math.max(0, length));
    if (to <= from) return new Uint8Array(0);

    if (to - from > WINDOW_BYTES) {
      return new Uint8Array(reader.readAsArrayBuffer(blob.slice(from, to)));
    }

    const out = new Uint8Array(to - from);
    let at2 = from;
    while (at2 < to) {
      const held = windowFor(at2);
      const stop = Math.min(to, held.end);
      out.set(held.bytes.subarray(at2 - held.start, stop - held.start), at2 - from);
      at2 = stop;
    }
    return out;
  }

  return {
    size,
    u8: (at) => {
      if (at < 0 || at >= size) return 0;
      const held = windowFor(at);
      return held.bytes[at - held.start] ?? 0;
    },
    /*
     * A span that sits inside one window is handed back AS that window, which
     * is the no-copy case the hot loops rely on; anything else is assembled,
     * and is therefore a copy that the caller is free to keep even though the
     * contract does not promise it.
     */
    view: (at, length) => {
      const from = Math.min(Math.max(0, at), size);
      const to = Math.min(size, from + Math.max(0, length));
      if (to <= from) return new Uint8Array(0);
      const held = windowFor(from);
      if (to <= held.end) return held.bytes.subarray(from - held.start, to - held.start);
      return span(from, to - from);
    },
    slice: (at, length) => span(at, length),
  };
}

/**
 * `FileReaderSync`, declared here rather than imported from a lib.
 *
 * It is a WORKER-ONLY API - the only synchronous way to get bytes out of a
 * blob, and the whole reason the container readers did not have to be rewritten
 * as asynchronous state machines - and this project's TypeScript `lib` is DOM,
 * because the application is a page. Pulling in `lib.webworker` for one
 * constructor would bring a second, conflicting declaration of most of the
 * platform with it.
 *
 * So the two members actually used are declared, and reached through
 * `globalThis` rather than as a bare name: a bare name is a `ReferenceError` in
 * a realm that does not have it, and every caller here has to be able to ASK
 * whether it is there.
 */
interface SyncFileReader {
  readAsArrayBuffer: (blob: Blob) => ArrayBuffer;
}

type SyncFileReaderConstructor = new () => SyncFileReader;

function syncReaderConstructor(): SyncFileReaderConstructor | null {
  const realm = globalThis as { FileReaderSync?: SyncFileReaderConstructor };
  return realm.FileReaderSync ?? null;
}

/** Whether this realm can read a blob synchronously. True in a worker. */
export function canWindowBlobs(): boolean {
  return syncReaderConstructor() !== null;
}

/**
 * A source for a value, whichever kind it is.
 *
 * The asynchronous signature is the honest one: a deferred value outside a
 * worker has no synchronous route to its bytes, so it is materialised, and
 * that is a thing a caller should have to await rather than discover. In the
 * app it never happens - the one tool that takes a source runs in the worker -
 * and in a unit suite it happens every time, which is what keeps the fallback
 * from rotting.
 */
export async function sourceFor(data: BinaryData): Promise<ByteSource> {
  if (data.kind === 'deferred' && canWindowBlobs()) return blobSource(data.blob);
  return residentSource(await materialiseBinary(data));
}

/* ========================================================================== *
 * Writing without holding
 * ========================================================================== */

/**
 * How much is held in memory before it is handed to blob storage.
 *
 * Eight megabytes is large enough that a film is a couple of hundred parts
 * rather than a couple of hundred thousand, and small enough that the peak
 * this sink contributes is a rounding error beside the index it is written
 * alongside.
 */
const SPILL_BYTES = 8 * 1024 * 1024;

/**
 * SOMEWHERE TO PUT AN OUTPUT THAT DOES NOT FIT IN A `Uint8Array`.
 *
 * The mirror image of `ByteSource`, and it has the same shape of argument
 * behind it: an MP4 writer that builds its whole answer in one buffer cannot
 * write a file bigger than the memory it is running in, and the files worth
 * writing are bigger than that.
 *
 * A SMALL OUTPUT STAYS A `Uint8Array`. Nothing spills until there is more than
 * `SPILL_BYTES` of it, so every output this app produced before this existed
 * is still produced in exactly the same form, with the same cost, and is still
 * something a test can compare against a literal. That is deliberate: a value
 * model where a 200-byte answer arrives as a blob would have made every tool
 * and every view pay for a problem only one tool has.
 */
export interface ByteSink {
  readonly written: number;
  /** Appends a copy of `chunk`. The caller may reuse its buffer afterwards. */
  readonly write: (chunk: Uint8Array) => void;
  /** Appends `length` bytes from `source`, without assembling them first. */
  readonly copyFrom: (source: ByteSource, at: number, length: number) => void;
  /** Everything written, as a value. Callable once. */
  readonly finish: () => BinaryData;
  /**
   * Everything written, as something to read back. Callable once, instead of
   * `finish`.
   *
   * For the case where the thing being assembled is not the answer but an
   * intermediate that this same run has to index - a transport stream's frames
   * gathered out of its packets, which are then copied into the output in a
   * different order. Build such a sink with `spill: canWindowBlobs()`, since a
   * realm that cannot read a blob synchronously cannot read one back here
   * either.
   */
  readonly source: () => ByteSource;
}

export interface SinkOptions {
  /**
   * Whether to hand full buffers to blob storage as they fill.
   *
   * True by default and false only where the sink's own output has to be read
   * back synchronously in a realm with no `FileReaderSync` - which is the unit
   * suite, where the data is small by construction. It is a fallback that
   * costs memory rather than correctness, and having it is what keeps the two
   * paths honest: the same code assembles a transport stream in a test and in
   * a worker.
   */
  readonly spill?: boolean;
}

export function createByteSink(options: SinkOptions = {}): ByteSink {
  const spilling = options.spill ?? true;
  const parts: Blob[] = [];
  let buffer = new Uint8Array(spilling ? SPILL_BYTES : 64 * 1024);
  let used = 0;
  let written = 0;
  /*
   * Captured as it goes past rather than read back at the end, because at the
   * end the cheap half of it may already be in blob storage - and the head is
   * wanted precisely so that nothing has to read blob storage to describe the
   * value.
   */
  const head = new Uint8Array(HEAD_BYTES);

  function spill(): void {
    if (used === 0) return;
    if (spilling) {
      parts.push(new Blob([buffer.slice(0, used)]));
      used = 0;
      return;
    }
    // Not spilling: grow instead, which is the old behaviour and the only
    // thing a realm without synchronous blob reads can do.
    const grown = new Uint8Array(buffer.byteLength * 2);
    grown.set(buffer);
    buffer = grown;
  }

  function append(chunk: Uint8Array): void {
    if (written < HEAD_BYTES) {
      head.set(chunk.subarray(0, HEAD_BYTES - written), written);
    }
    let at = 0;
    while (at < chunk.byteLength) {
      if (used === buffer.byteLength) spill();
      const room = Math.min(buffer.byteLength - used, chunk.byteLength - at);
      buffer.set(chunk.subarray(at, at + room), used);
      used += room;
      at += room;
    }
    written += chunk.byteLength;
  }

  return {
    get written() {
      return written;
    },
    write: append,
    copyFrom: (source, at, length) => {
      let done = 0;
      while (done < length) {
        // A bounded bite, so a sample the size of a film is still copied
        // through a buffer the size of a window rather than assembled whole.
        const take = Math.min(SPILL_BYTES, length - done);
        append(source.view(at + done, take));
        done += take;
      }
    },
    finish: () => {
      if (parts.length === 0) {
        const out = buffer.slice(0, used);
        // Nothing more will be written, and the scratch buffer is eight
        // megabytes; dropping it here matters when the answer was two hundred
        // bytes.
        buffer = new Uint8Array(0);
        used = 0;
        return residentBinary(out);
      }
      spill();
      buffer = new Uint8Array(0);
      return deferredBinary(new Blob(parts), head.subarray(0, Math.min(written, HEAD_BYTES)));
    },
    source: () => {
      if (parts.length === 0) return residentSource(buffer.slice(0, used));
      spill();
      buffer = new Uint8Array(0);
      return blobSource(new Blob(parts));
    },
  };
}
