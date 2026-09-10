import { fail, ok, type ToolResult } from '@/features/registry/types';

import {
  LIMITS,
  type CodecId,
  type Edit,
  type SampleTable,
  type SourceFile,
  type SourceTrack,
  type TrackKind,
} from './containers';

/**
 * READING AN ISO BASE MEDIA FILE: MP4, MOV, M4A, 3GP.
 *
 * All four are the same container - a tree of length-prefixed boxes - and the
 * differences between them are brands in `ftyp` and habits in `stsd`. This
 * reads the tree, and specifically it reads the SAMPLE TABLE: `stbl` is an
 * index of the media data, saying where every frame is, how big it is, when it
 * decodes, when it is shown, and whether a player may seek to it. Repackaging
 * is rebuilding that index in a new file around the same bytes.
 *
 * NOTHING HERE TRUSTS A DECLARED COUNT. Every table in `stbl` begins with a
 * 32-bit entry count that came out of the file, and every one of them is used
 * only after checking that the entries it promises actually fit inside the box
 * that declared them - `entriesThatFit` below. That check is one line per
 * table and it is the whole difference between refusing a hostile file and
 * allocating four billion of something on its say-so.
 *
 * WHAT IS DELIBERATELY NOT READ: `moof`. A fragmented MP4 keeps its sample
 * tables in movie fragments spread through the file rather than in `stbl`, and
 * reading them is a second parser rather than an extension of this one. It is
 * refused by name - see `readIsoBmff` - because "no `moov`" would be a true
 * error message about the wrong thing.
 */

/* ========================================================================== *
 * Bounded reading
 * ========================================================================== */

function u8(bytes: Uint8Array, at: number): number {
  return bytes[at] ?? 0;
}

function u16(bytes: Uint8Array, at: number): number {
  return (u8(bytes, at) << 8) | u8(bytes, at + 1);
}

function i16(bytes: Uint8Array, at: number): number {
  const value = u16(bytes, at);
  return value >= 0x8000 ? value - 0x10000 : value;
}

/** `* 0x1000000` rather than `<< 24`, because the shift operator is signed. */
function u32(bytes: Uint8Array, at: number): number {
  return (
    u8(bytes, at) * 0x1000000 +
    (u8(bytes, at + 1) << 16) +
    (u8(bytes, at + 2) << 8) +
    u8(bytes, at + 3)
  );
}

function i32(bytes: Uint8Array, at: number): number {
  const value = u32(bytes, at);
  return value >= 0x80000000 ? value - 0x100000000 : value;
}

/**
 * A 64-bit field, read as a double.
 *
 * Exact to 2^53, which is eight petabytes of file offset and about three
 * hundred thousand years of 90 kHz timestamps. Anything past that is not a
 * number this tool could act on anyway, and every caller range-checks what it
 * gets rather than assuming it is sane.
 */
function u64(bytes: Uint8Array, at: number): number {
  return u32(bytes, at) * 0x100000000 + u32(bytes, at + 4);
}

function tag(bytes: Uint8Array, at: number): string {
  let out = '';
  for (let index = 0; index < 4; index += 1) out += String.fromCharCode(u8(bytes, at + index));
  return out;
}

/* ========================================================================== *
 * The box tree
 * ========================================================================== */

interface Box {
  readonly type: string;
  /** First byte of the box itself, header included. */
  readonly start: number;
  /** First byte of the box's contents. */
  readonly body: number;
  /** One past the last byte of the whole box. */
  readonly end: number;
}

/**
 * Shared state for one walk of one file: how much has been read, and the first
 * thing that turned out to be impossible.
 *
 * A problem is recorded rather than thrown, and the walk then stops producing
 * children. The alternative - a result type on every level of a recursive
 * descent - turns the readable shape of this file inside out for a case that
 * ends in one message.
 */
interface Walk {
  nodes: number;
  problem: string | null;
}

/**
 * The boxes directly inside `[from, to)`.
 *
 * Three header shapes, and each one has a way of being wrong that this has to
 * refuse rather than believe:
 *
 *   - size >= 8 is the ordinary case, and the size may still reach past the
 *     parent. That is a truncated file or a lie, and both end the walk.
 *   - size == 1 means the real size is a 64-bit field after the type, so the
 *     header is 16 bytes and anything claiming less is malformed.
 *   - size == 0 means "to the end of the enclosing box", which is legal, is
 *     how a streamed `mdat` is written, and is also the shape that makes a
 *     careless parser loop forever if it treats it as zero.
 *
 * A box that does not advance the cursor ends the walk in every case, which is
 * the property that makes this loop terminate whatever the file says.
 */
function childBoxes(bytes: Uint8Array, from: number, to: number, walk: Walk, depth: number): Box[] {
  const found: Box[] = [];
  if (depth > LIMITS.maxDepth) {
    walk.problem = 'the boxes are nested deeper than any real file nests them';
    return found;
  }

  let cursor = from;
  while (cursor + 8 <= to) {
    if (walk.problem !== null) break;
    walk.nodes += 1;
    if (walk.nodes > LIMITS.maxNodes) {
      walk.problem = 'the file holds more boxes than this tool will read';
      break;
    }

    const declared = u32(bytes, cursor);
    const type = tag(bytes, cursor + 4);
    let body = cursor + 8;
    let end: number;

    if (declared === 1) {
      if (cursor + 16 > to) {
        walk.problem = `a "${type}" box declares a 64-bit size it has no room for`;
        break;
      }
      end = cursor + u64(bytes, cursor + 8);
      body = cursor + 16;
      if (end < body) {
        walk.problem = `a "${type}" box declares a size smaller than its own header`;
        break;
      }
    } else if (declared === 0) {
      end = to;
    } else if (declared < 8) {
      walk.problem = `a "${type}" box declares ${String(declared)} bytes, which is less than a header`;
      break;
    } else {
      end = cursor + declared;
    }

    if (end > to) {
      walk.problem = `a "${type}" box runs ${String(end - to)} bytes past the end of the ${
        from === 0 ? 'file' : 'box that contains it'
      }`;
      break;
    }

    found.push({ type, start: cursor, body, end });
    if (end <= cursor) {
      walk.problem = `a "${type}" box does not advance, so the file cannot be read past it`;
      break;
    }
    cursor = end;
  }

  return found;
}

function findBox(boxes: readonly Box[], type: string): Box | null {
  return boxes.find((box) => box.type === type) ?? null;
}

/**
 * How many fixed-width entries a box really has room for.
 *
 * The guard that matters most in this file, and it is deliberately a named
 * function rather than a habit: `declared` came out of the file and is
 * attacker-controlled, `available` is arithmetic on the box that declared it.
 * Everything downstream sizes itself from the answer, so no array is ever
 * allocated from a number a file chose.
 */
function entriesThatFit(declared: number, from: number, to: number, width: number): number {
  const available = Math.floor(Math.max(0, to - from) / width);
  return Math.min(declared, available, LIMITS.maxSamplesPerTrack);
}

/* ========================================================================== *
 * Sample entries
 * ========================================================================== */

/** Offsets inside a visual sample entry, from the first byte of its contents. */
const VISUAL_WIDTH = 24;
const VISUAL_HEIGHT = 26;

/** And inside an audio one, whose fixed part has three possible lengths. */
const AUDIO_CHANNELS = 16;

/**
 * Where an audio sample entry's own sub-boxes begin.
 *
 * ISO-BMFF says the two bytes after `data_reference_index` are reserved zero.
 * QuickTime put a VERSION there, and versions 1 and 2 add sixteen and
 * thirty-six bytes of extra fields before the sub-boxes start. A camera's MOV
 * really does write version 1, and reading it as version 0 puts the search for
 * `esds` sixteen bytes early - where it finds nothing, and the track silently
 * loses the configuration a decoder needs to play it.
 */
function audioSubBoxes(bytes: Uint8Array, entryBody: number): number {
  const version = u16(bytes, entryBody + 8);
  if (version === 1) return 44;
  if (version === 2) return 64;
  return 28;
}

/**
 * The object type in an `esds`, which is the only thing that tells AAC from
 * MP3 - both travel in a sample entry called `mp4a`.
 *
 * A minimal descriptor walk: enough to reach the one byte, bounded at every
 * step. The descriptor length is a base-128 varint whose continuation bit is
 * in the top of each byte, which is its own small opportunity to run away.
 */
function esdsObjectType(bytes: Uint8Array, from: number, to: number): number | null {
  let cursor = from + 4; // version and flags
  let guard = 0;

  while (cursor < to && guard < 16) {
    guard += 1;
    const descriptorTag = u8(bytes, cursor);
    cursor += 1;

    let length = 0;
    for (let index = 0; index < 4 && cursor < to; index += 1) {
      const byte = u8(bytes, cursor);
      cursor += 1;
      length = (length << 7) | (byte & 0x7f);
      if ((byte & 0x80) === 0) break;
    }
    if (length < 0 || cursor + length > to) return null;

    if (descriptorTag === 0x03) {
      // ES_Descriptor: ES_ID, then flags that decide what follows them.
      let inner = cursor + 2;
      const flags = u8(bytes, inner);
      inner += 1;
      if ((flags & 0x80) !== 0) inner += 2;
      if ((flags & 0x40) !== 0) inner += 1 + u8(bytes, inner);
      if ((flags & 0x20) !== 0) inner += 2;
      if (inner <= cursor) return null;
      cursor = inner;
      continue;
    }

    if (descriptorTag === 0x04) return u8(bytes, cursor);
    cursor += length;
  }

  return null;
}

/**
 * What a sample entry's four-character code means.
 *
 * `mp4a` is the interesting one: it is the sample entry for anything described
 * by an MPEG-4 object type, so it covers AAC and MP3 and several things this
 * tool refuses. The object type inside its `esds` is what separates them, and
 * an `mp4a` with no readable `esds` is treated as AAC because that is what it
 * is in every file anybody has.
 */
function codecOfEntry(bytes: Uint8Array, entry: Box, kind: TrackKind): CodecId {
  switch (entry.type) {
    case 'avc1':
    case 'avc3':
      return 'avc';
    case 'hvc1':
    case 'hev1':
      return 'hevc';
    case 'vp08':
      return 'vp8';
    case 'vp09':
      return 'vp9';
    case 'av01':
      return 'av1';
    case 'Opus':
      return 'opus';
    case 'fLaC':
      return 'flac';
    case 'ac-3':
    case 'ec-3':
      return 'ac3';
    case 'tx3g':
    case 'wvtt':
    case 'stpp':
      return 'subtitle';
    case '.mp3':
      return 'mp3';
    case 'mp4a': {
      const walk: Walk = { nodes: 0, problem: null };
      const children = childBoxes(
        bytes,
        entry.body + audioSubBoxes(bytes, entry.body),
        entry.end,
        walk,
        1,
      );
      const esds = findBox(children, 'esds');
      const objectType = esds === null ? null : esdsObjectType(bytes, esds.body, esds.end);
      // 0x69 and 0x6B are MPEG-2 and MPEG-1 layer III; 0x40 and the 0x66-0x68
      // range are the AAC profiles.
      if (objectType === 0x69 || objectType === 0x6b) return 'mp3';
      return 'aac';
    }
    default:
      return kind === 'other' ? 'subtitle' : 'unknown';
  }
}

/* ========================================================================== *
 * The sample table
 * ========================================================================== */

interface TableParts {
  readonly sizes: number[];
  readonly dts: number[];
  readonly cts: number[];
  readonly offsets: number[];
  readonly sync: number[];
  readonly lastDuration: number;
}

/** `stsz`, or `stz2` where the sizes are packed into 4, 8 or 16 bits. */
function readSizes(bytes: Uint8Array, stbl: readonly Box[]): number[] | null {
  const stsz = findBox(stbl, 'stsz');
  if (stsz !== null) {
    const uniform = u32(bytes, stsz.body + 4);
    const declared = u32(bytes, stsz.body + 8);
    if (uniform > 0) {
      // Every sample is the same size and there is no per-sample table to
      // bound the count with - so the file itself is the bound: a sample of
      // `uniform` bytes cannot appear more times than the file has room for.
      const count = Math.min(
        declared,
        LIMITS.maxSamplesPerTrack,
        Math.ceil(bytes.length / uniform) + 1,
      );
      return new Array<number>(count).fill(uniform);
    }
    const count = entriesThatFit(declared, stsz.body + 12, stsz.end, 4);
    const sizes: number[] = [];
    for (let index = 0; index < count; index += 1) {
      sizes.push(u32(bytes, stsz.body + 12 + index * 4));
    }
    return sizes;
  }

  const stz2 = findBox(stbl, 'stz2');
  if (stz2 === null) return null;

  const fieldSize = u8(bytes, stz2.body + 7);
  const declared = u32(bytes, stz2.body + 8);
  const from = stz2.body + 12;
  const sizes: number[] = [];

  if (fieldSize === 4) {
    const count = Math.min(declared, Math.max(0, stz2.end - from) * 2, LIMITS.maxSamplesPerTrack);
    for (let index = 0; index < count; index += 1) {
      const byte = u8(bytes, from + (index >> 1));
      sizes.push(index % 2 === 0 ? byte >> 4 : byte & 0x0f);
    }
    return sizes;
  }
  if (fieldSize === 8 || fieldSize === 16) {
    const width = fieldSize / 8;
    const count = entriesThatFit(declared, from, stz2.end, width);
    for (let index = 0; index < count; index += 1) {
      sizes.push(width === 1 ? u8(bytes, from + index) : u16(bytes, from + index * 2));
    }
    return sizes;
  }
  return null;
}

/**
 * `stts`: a run-length list of decode deltas, expanded into absolute times.
 *
 * The last sample's DURATION is not derivable from the deltas - there is no
 * delta after it - so it is kept separately. It is what the writer needs for
 * its final `stts` entry, and getting it wrong truncates the last frame, which
 * for a one-frame file is the whole file.
 */
function readDecodeTimes(
  bytes: Uint8Array,
  stbl: readonly Box[],
  sampleCount: number,
): { readonly dts: number[]; readonly lastDuration: number } | null {
  const stts = findBox(stbl, 'stts');
  if (stts === null) return null;

  const declared = u32(bytes, stts.body + 4);
  const count = entriesThatFit(declared, stts.body + 8, stts.end, 8);
  const dts: number[] = [];
  let now = 0;
  let delta = 0;

  for (let index = 0; index < count && dts.length < sampleCount; index += 1) {
    const at = stts.body + 8 + index * 8;
    const runLength = u32(bytes, at);
    delta = u32(bytes, at + 4);
    for (let step = 0; step < runLength && dts.length < sampleCount; step += 1) {
      dts.push(now);
      now += delta;
    }
  }

  // A table shorter than the sample count leaves the tail without times. The
  // honest repair is the last delta continued, not zero - zero would give a
  // pile of samples all claiming to decode at the same instant.
  while (dts.length < sampleCount) {
    dts.push(now);
    now += delta;
  }

  return { dts, lastDuration: delta === 0 ? 1 : delta };
}

/** `ctts`: how far each sample's presentation time is from its decode time. */
function readCompositionOffsets(
  bytes: Uint8Array,
  stbl: readonly Box[],
  sampleCount: number,
): number[] {
  const offsets = new Array<number>(sampleCount).fill(0);
  const ctts = findBox(stbl, 'ctts');
  if (ctts === null) return offsets;

  // Version 1 offsets are SIGNED, which is how a stream expresses a
  // presentation time earlier than its decode time. Reading one as unsigned
  // turns a small negative into about four billion ticks, and the file plays
  // as a still frame followed by nothing.
  const version = u8(bytes, ctts.body);
  const declared = u32(bytes, ctts.body + 4);
  const count = entriesThatFit(declared, ctts.body + 8, ctts.end, 8);
  let sample = 0;

  for (let index = 0; index < count && sample < sampleCount; index += 1) {
    const at = ctts.body + 8 + index * 8;
    const runLength = u32(bytes, at);
    const offset = version === 1 ? i32(bytes, at + 4) : u32(bytes, at + 4);
    for (let step = 0; step < runLength && sample < sampleCount; step += 1) {
      offsets[sample] = offset;
      sample += 1;
    }
  }

  return offsets;
}

/**
 * `stsc` plus `stco`/`co64`: where every sample actually is.
 *
 * The file stores chunk offsets and a run-length description of how many
 * samples each chunk holds; a sample's offset is its chunk's offset plus the
 * sizes of the samples before it in that chunk. This is the one place in the
 * table where two boxes have to agree, and where they do not, what comes out
 * is a set of offsets pointing at the wrong bytes - so `readIsoBmff` checks
 * every one of them against the length of the file afterwards.
 */
function readOffsets(
  bytes: Uint8Array,
  stbl: readonly Box[],
  sizes: readonly number[],
): number[] | null {
  const stco = findBox(stbl, 'stco');
  const co64 = findBox(stbl, 'co64');
  const chunks = stco ?? co64;
  const stsc = findBox(stbl, 'stsc');
  if (chunks === null || stsc === null) return null;

  const width = stco === null ? 8 : 4;
  const chunkCount = entriesThatFit(
    u32(bytes, chunks.body + 4),
    chunks.body + 8,
    chunks.end,
    width,
  );
  const runCount = entriesThatFit(u32(bytes, stsc.body + 4), stsc.body + 8, stsc.end, 12);
  if (runCount === 0) return null;

  const offsets: number[] = [];
  let run = 0;
  let sample = 0;

  for (let chunk = 1; chunk <= chunkCount && sample < sizes.length; chunk += 1) {
    // Advance to the run governing this chunk. `first_chunk` is 1-based and
    // non-decreasing in any real file; a run that goes backwards is stepped
    // over rather than allowed to rewind the walk.
    while (run + 1 < runCount && u32(bytes, stsc.body + 8 + (run + 1) * 12) <= chunk) run += 1;

    const perChunk = u32(bytes, stsc.body + 8 + run * 12 + 4);
    if (perChunk === 0 || perChunk > LIMITS.maxSamplesPerTrack) return null;

    const entry = chunks.body + 8 + (chunk - 1) * width;
    let at = width === 4 ? u32(bytes, entry) : u64(bytes, entry);

    for (let index = 0; index < perChunk && sample < sizes.length; index += 1) {
      offsets.push(at);
      at += sizes[sample] ?? 0;
      sample += 1;
    }
  }

  // A short offset list is not repairable: the remaining samples would have to
  // be guessed at, and a guessed offset produces a file that looks converted
  // and holds the wrong bytes.
  return offsets.length === sizes.length ? offsets : null;
}

/** `stss`: the samples a player may seek to. Absent means every one of them. */
function readSyncFlags(bytes: Uint8Array, stbl: readonly Box[], sampleCount: number): number[] {
  const stss = findBox(stbl, 'stss');
  if (stss === null) return new Array<number>(sampleCount).fill(1);

  const flags = new Array<number>(sampleCount).fill(0);
  const count = entriesThatFit(u32(bytes, stss.body + 4), stss.body + 8, stss.end, 4);
  for (let index = 0; index < count; index += 1) {
    const sample = u32(bytes, stss.body + 8 + index * 4);
    if (sample >= 1 && sample <= sampleCount) flags[sample - 1] = 1;
  }
  return flags;
}

function readTable(bytes: Uint8Array, stbl: readonly Box[]): TableParts | null {
  const sizes = readSizes(bytes, stbl);
  if (sizes === null || sizes.length === 0) return null;

  const times = readDecodeTimes(bytes, stbl, sizes.length);
  if (times === null) return null;

  const offsets = readOffsets(bytes, stbl, sizes);
  if (offsets === null) return null;

  const composition = readCompositionOffsets(bytes, stbl, sizes.length);

  return {
    sizes,
    dts: times.dts,
    cts: times.dts.map((at, index) => at + (composition[index] ?? 0)),
    offsets,
    sync: readSyncFlags(bytes, stbl, sizes.length),
    lastDuration: times.lastDuration,
  };
}

/* ========================================================================== *
 * Tracks
 * ========================================================================== */

/** Three five-bit letters, each offset from 0x60. `und` means unset. */
function readLanguage(packed: number): string | null {
  const letters = [
    ((packed >> 10) & 0x1f) + 0x60,
    ((packed >> 5) & 0x1f) + 0x60,
    (packed & 0x1f) + 0x60,
  ];
  if (letters.some((code) => code < 0x61 || code > 0x7a)) return null;
  const language = String.fromCharCode(...letters);
  return language === 'und' ? null : language;
}

function readEdits(bytes: Uint8Array, trak: readonly Box[], walk: Walk): readonly Edit[] {
  const edts = findBox(trak, 'edts');
  if (edts === null) return [];
  const elst = findBox(childBoxes(bytes, edts.body, edts.end, walk, 3), 'elst');
  if (elst === null) return [];

  const version = u8(bytes, elst.body);
  const width = version === 1 ? 20 : 12;
  const count = entriesThatFit(u32(bytes, elst.body + 4), elst.body + 8, elst.end, width);
  const edits: Edit[] = [];

  for (let index = 0; index < count; index += 1) {
    const at = elst.body + 8 + index * width;
    if (version === 1) {
      edits.push({
        segmentDuration: u64(bytes, at),
        // A 64-bit media time only ever holds a small number or -1, and -1 is
        // an EMPTY EDIT: the track shows nothing for that long. Reading it as
        // an enormous positive offset would delay the track by six thousand
        // years, which is a black screen rather than an error.
        mediaTime: u32(bytes, at + 8) === 0xffffffff ? -1 : u64(bytes, at + 8),
        mediaRateInteger: i16(bytes, at + 16),
        mediaRateFraction: i16(bytes, at + 18),
      });
    } else {
      edits.push({
        segmentDuration: u32(bytes, at),
        mediaTime: i32(bytes, at + 4),
        mediaRateInteger: i16(bytes, at + 8),
        mediaRateFraction: i16(bytes, at + 10),
      });
    }
  }

  return edits;
}

function readTrack(
  bytes: Uint8Array,
  trakBox: Box,
  number: number,
  walk: Walk,
): SourceTrack | null {
  const trak = childBoxes(bytes, trakBox.body, trakBox.end, walk, 2);
  const mdia = findBox(trak, 'mdia');
  if (mdia === null) return null;

  const mdiaChildren = childBoxes(bytes, mdia.body, mdia.end, walk, 3);
  const mdhd = findBox(mdiaChildren, 'mdhd');
  const hdlr = findBox(mdiaChildren, 'hdlr');
  const minf = findBox(mdiaChildren, 'minf');
  if (mdhd === null || hdlr === null || minf === null) return null;

  const mdhdVersion = u8(bytes, mdhd.body);
  const timescale = mdhdVersion === 1 ? u32(bytes, mdhd.body + 20) : u32(bytes, mdhd.body + 12);
  // A zero timescale is a division by zero waiting in every consumer of this
  // track, and there is no honest repair: "ticks per second" with no value
  // means none of the timestamps mean anything.
  if (timescale === 0) return null;

  const language = readLanguage(
    mdhdVersion === 1 ? u16(bytes, mdhd.body + 32) : u16(bytes, mdhd.body + 20),
  );

  const handler = tag(bytes, hdlr.body + 8);
  const kind: TrackKind = handler === 'vide' ? 'video' : handler === 'soun' ? 'audio' : 'other';

  const stbl = findBox(childBoxes(bytes, minf.body, minf.end, walk, 4), 'stbl');
  if (stbl === null) return null;
  const stblChildren = childBoxes(bytes, stbl.body, stbl.end, walk, 5);

  const stsd = findBox(stblChildren, 'stsd');
  if (stsd === null) return null;
  const entry = childBoxes(bytes, stsd.body + 8, stsd.end, walk, 6)[0];
  if (entry === undefined) return null;

  const parts = readTable(bytes, stblChildren);
  if (parts === null) return null;

  /*
   * The display matrix and the display size, both copied rather than derived.
   * See the note on `matrix` in containers.ts: this is what keeps a portrait
   * phone video the right way up.
   */
  const tkhd = findBox(trak, 'tkhd');
  const matrixAt = tkhd !== null && u8(bytes, tkhd.body) === 1 ? 52 : 40;
  const header = tkhd !== null && tkhd.body + matrixAt + 44 <= tkhd.end ? tkhd : null;
  const matrix =
    header === null ? null : bytes.subarray(header.body + matrixAt, header.body + matrixAt + 36);

  const displayWidth =
    header === null ? 0 : Math.round(u32(bytes, header.body + matrixAt + 36) / 65536);
  const displayHeight =
    header === null ? 0 : Math.round(u32(bytes, header.body + matrixAt + 40) / 65536);

  const width = kind === 'video' ? displayWidth || u16(bytes, entry.body + VISUAL_WIDTH) : 0;
  const height = kind === 'video' ? displayHeight || u16(bytes, entry.body + VISUAL_HEIGHT) : 0;
  const channels = kind === 'audio' ? u16(bytes, entry.body + AUDIO_CHANNELS) : 0;

  const samples: SampleTable = {
    count: parts.sizes.length,
    offset: parts.offsets,
    size: parts.sizes,
    dts: parts.dts,
    cts: parts.cts,
    sync: parts.sync,
    lastDuration: parts.lastDuration,
  };

  return {
    number,
    kind,
    codec: codecOfEntry(bytes, entry, kind),
    timescale,
    width: width === 0 ? null : width,
    height: height === 0 ? null : height,
    channels: channels === 0 ? null : channels,
    /*
     * The sample rate comes from `mdhd`, not from the sample entry.
     *
     * The entry's field is 16.16 fixed point, so it cannot express 96 kHz or
     * 192 kHz at all - it wraps. Every file at those rates carries the real
     * number in the media header instead, and for an audio track the media
     * timescale IS the sampling rate, so the two agree everywhere else.
     */
    sampleRate: kind === 'audio' ? timescale : null,
    language,
    sampleEntry: bytes.subarray(entry.start, entry.end),
    codecPrivate: null,
    matrix,
    edits: readEdits(bytes, trak, walk),
    samples,
  };
}

/* ========================================================================== *
 * Metadata, which a repackage does not carry
 * ========================================================================== */

/** Cap on how much of a metadata box is searched. Real ones are kilobytes. */
const METADATA_SCAN_LIMIT = 1024 * 1024;

function containsTag(bytes: Uint8Array, from: number, to: number, wanted: string): boolean {
  const limit = Math.min(to, from + METADATA_SCAN_LIMIT);
  const first = wanted.charCodeAt(0);
  for (let at = from; at + wanted.length <= limit; at += 1) {
    if (u8(bytes, at) !== first) continue;
    let matched = true;
    for (let index = 1; index < wanted.length; index += 1) {
      if (u8(bytes, at + index) !== wanted.charCodeAt(index)) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }
  return false;
}

/**
 * What this file carries that the output will not.
 *
 * Read by looking rather than by parsing the metadata trees, and deliberately
 * so: `udta`, `meta`, `ilst` and QuickTime's `©`-prefixed atoms are four
 * different vocabularies for the same idea, and the question here is not what
 * a tag says but whether one is there. `©xyz` is where a phone writes the
 * coordinates it recorded at, and `loci` is the MP4 equivalent - finding
 * either is the answer, and reading the number out of it would be pointless
 * when the tool is about to discard it.
 */
function readMetadata(
  bytes: Uint8Array,
  moovChildren: readonly Box[],
  trakBoxes: readonly Box[],
  walk: Walk,
  creationTime: number,
): string[] {
  const found = new Set<string>();
  if (creationTime > 0) found.add('Recording date');

  const holders: Box[] = [];
  for (const box of moovChildren) {
    if (box.type === 'udta' || box.type === 'meta') holders.push(box);
  }
  for (const trakBox of trakBoxes) {
    for (const box of childBoxes(bytes, trakBox.body, trakBox.end, walk, 2)) {
      if (box.type === 'udta' || box.type === 'meta') holders.push(box);
    }
  }

  for (const holder of holders) {
    if (holder.end <= holder.body) continue;
    // The copyright sign is 0xA9 in MacRoman, which is what QuickTime's atom
    // names are written in.
    if (
      containsTag(bytes, holder.body, holder.end, '©xyz') ||
      containsTag(bytes, holder.body, holder.end, 'loci')
    ) {
      found.add('GPS location');
    } else {
      found.add('Titles and tags');
    }
  }

  return [...found];
}

/* ========================================================================== *
 * Entry point
 * ========================================================================== */

export function readIsoBmff(bytes: Uint8Array): ToolResult<SourceFile> {
  const walk: Walk = { nodes: 0, problem: null };
  const top = childBoxes(bytes, 0, bytes.length, walk, 0);

  const ftyp = findBox(top, 'ftyp');
  const moov = findBox(top, 'moov');

  if (moov === null) {
    if (findBox(top, 'moof') !== null) {
      return fail('unsupported-type', 'This is a fragmented MP4, which this version cannot read.', {
        detail:
          'Its frame index lives in movie fragments spread through the file rather than in one table at the front. That is what a streaming player downloads, and such files almost always play already.',
      });
    }
    return fail('parse-error', 'This file has no movie header, so nothing describes its frames.', {
      detail:
        walk.problem === null
          ? 'A `moov` box is where an MP4 keeps its index. Without one there is nothing to repackage, and a file that has lost it is usually one that was cut short.'
          : `While reading the file: ${walk.problem}.`,
    });
  }

  const moovChildren = childBoxes(bytes, moov.body, moov.end, walk, 1);
  const mvhd = findBox(moovChildren, 'mvhd');
  const mvhdVersion = mvhd === null ? 0 : u8(bytes, mvhd.body);
  const declaredTimescale =
    mvhd === null ? 0 : mvhdVersion === 1 ? u32(bytes, mvhd.body + 20) : u32(bytes, mvhd.body + 12);
  const timescale = declaredTimescale === 0 ? 1000 : declaredTimescale;
  const durationTicks =
    mvhd === null ? 0 : mvhdVersion === 1 ? u64(bytes, mvhd.body + 24) : u32(bytes, mvhd.body + 16);
  // Seconds since 1904, which is a real timestamp of when this was recorded.
  // The writer emits zero, so it is one of the things the result says it lost.
  const creationTime =
    mvhd === null ? 0 : mvhdVersion === 1 ? u64(bytes, mvhd.body + 4) : u32(bytes, mvhd.body + 4);

  const trakBoxes = moovChildren.filter((box) => box.type === 'trak');
  if (trakBoxes.length > LIMITS.maxTracks) {
    return fail('limit-exceeded', 'That file declares more tracks than this tool will read.', {
      detail: `${String(trakBoxes.length)} tracks, against a limit of ${String(LIMITS.maxTracks)}.`,
    });
  }

  const tracks: SourceTrack[] = [];
  for (const [index, trakBox] of trakBoxes.entries()) {
    const track = readTrack(bytes, trakBox, index + 1, walk);
    if (track !== null) tracks.push(track);
  }

  if (tracks.length === 0) {
    return fail('parse-error', 'That file has no readable tracks in it.', {
      detail:
        walk.problem === null
          ? 'Every track was missing a sample table or a sample description. An MP4 with a movie header and no usable track is normally one that was cut short while it was being written.'
          : `${walk.problem.charAt(0).toUpperCase()}${walk.problem.slice(1)}.`,
    });
  }

  /*
   * EVERY SAMPLE IS INSIDE THE FILE, CHECKED ONCE, HERE.
   *
   * The sample table is an index of byte ranges and nothing in the format
   * requires those ranges to exist. A truncated download produces a complete
   * `moov` describing media data that was never written; a hostile file
   * produces offsets pointing wherever it likes. Without this the repackage
   * reads past the end of the buffer - which in JavaScript is not a crash but
   * a run of zeros - and writes a file that looks exactly like a successful
   * conversion and holds nothing.
   *
   * It is one pass over the sample count rather than a check inside the copy
   * loop, so a file that cannot work is refused before any output is
   * allocated.
   */
  for (const track of tracks) {
    for (let index = 0; index < track.samples.count; index += 1) {
      const at = track.samples.offset[index] ?? 0;
      const size = track.samples.size[index] ?? 0;
      if (at < 0 || size < 0 || at + size > bytes.length) {
        return fail('parse-error', 'That file is truncated: some of its frames are not in it.', {
          detail: `Track ${String(track.number)} says frame ${String(index + 1)} is ${String(size)} bytes at offset ${String(at)}, and the file is ${String(bytes.length)} bytes long. This is what an interrupted download looks like.`,
        });
      }
    }
  }

  return ok({
    container: 'mp4',
    flavour: ftyp === null ? 'QuickTime' : tag(bytes, ftyp.body).trim(),
    timescale,
    durationSeconds: durationTicks > 0 ? durationTicks / timescale : null,
    tracks,
    metadata: readMetadata(bytes, moovChildren, trakBoxes, walk, creationTime),
    problem: walk.problem,
  });
}
