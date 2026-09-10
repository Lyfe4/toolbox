import type { Bytes } from '@/features/registry/types';

import type { CodecId, Edit, SampleTable, TrackKind } from './containers';

/**
 * WRITING AN MP4 AROUND SAMPLES THAT ALREADY EXIST.
 *
 * Nothing here encodes anything. Every byte of media in the output is a byte
 * copied from the input; what this file builds is the INDEX around them -
 * `moov`, and the half-dozen tables inside `stbl` that say where each frame
 * is, when it decodes, when it is shown, and whether a player may seek to it.
 *
 * Three decisions are worth knowing before reading the boxes.
 *
 * THE INDEX GOES FIRST. `moov` before `mdat` is what "fast start" means, and
 * it is the difference between a file a browser can begin playing after a few
 * kilobytes and one it has to download in full to find the index at the end.
 * The cost is that chunk offsets depend on the size of the very box that
 * contains them - so `moov` is built twice, once to measure and once for real.
 *
 * `co64` ALWAYS, EVEN FOR A SMALL FILE. The 32-bit `stco` would fit everything
 * this tool accepts, and using it would save four bytes per chunk and
 * reintroduce a feedback loop: switching to `co64` because a file turned out
 * to be large CHANGES THE SIZE OF `moov`, which changes the offsets, which can
 * change the decision. One width means the second `moov` is byte-for-byte as
 * long as the first, always, so two passes are exactly enough.
 *
 * SAMPLE ENTRIES ARE COPIED WHERE THERE IS ONE TO COPY. Repackaging an MP4
 * carries its `avcC`, `esds`, `pasp`, `colr` and everything else through
 * untouched, because the alternative is rebuilding from the handful of fields
 * this tool happens to parse and silently dropping the rest. Only a Matroska
 * source needs an entry BUILT, and even then the codec configuration inside it
 * is that file's own `CodecPrivate`, verbatim.
 */

/* ========================================================================== *
 * Bytes
 * ========================================================================== */

type Part = Uint8Array | readonly number[];

function u16(value: number): number[] {
  return [(value >> 8) & 0xff, value & 0xff];
}

/**
 * A 32-bit big-endian field.
 *
 * `Math.floor(value / 0x1000000)` for the top byte rather than `value >> 24`,
 * because `>>` is a 32-bit SIGNED operation: a chunk offset past two gigabytes
 * comes out negative and writes 0xFF into the high byte.
 */
function u32(value: number): number[] {
  const rounded = Math.max(0, Math.floor(value));
  return [
    Math.floor(rounded / 0x1000000) & 0xff,
    (rounded >> 16) & 0xff,
    (rounded >> 8) & 0xff,
    rounded & 0xff,
  ];
}

function i32(value: number): number[] {
  return u32(value < 0 ? value + 0x100000000 : value);
}

/**
 * ASCII bytes, read by code unit rather than by code point.
 *
 * Everything passed here is a four-character box type or a handler name from a
 * literal in this file, so there is nothing outside ASCII to mishandle - and
 * code UNITS are the right granularity anyway, since what is wanted is one
 * byte per character rather than one per grapheme.
 */
function ascii(text: string): number[] {
  const out: number[] = [];
  for (let index = 0; index < text.length; index += 1) out.push(text.charCodeAt(index) & 0xff);
  return out;
}

function zeros(count: number): number[] {
  return new Array<number>(count).fill(0);
}

/**
 * A table of fixed-width numbers, written straight into bytes.
 *
 * The obvious `values.flatMap(u32)` is correct and allocates one small array
 * per entry - half a million of them for a feature-length film's `stsz`, which
 * is where the time goes in a conversion that should be measured in
 * milliseconds. These fill one buffer instead.
 */
function packFields(count: number, width: 4 | 8, valueAt: (index: number) => number): Uint8Array {
  const out = new Uint8Array(count * width);
  for (let index = 0; index < count; index += 1) {
    const value = Math.max(0, Math.floor(valueAt(index)));
    let at = index * width + width;
    let remaining = value;
    while (at > index * width) {
      at -= 1;
      out[at] = remaining % 256;
      remaining = Math.floor(remaining / 256);
    }
  }
  return out;
}

function partLength(part: Part): number {
  return part instanceof Uint8Array ? part.byteLength : part.length;
}

function box(type: string, ...parts: Part[]): Uint8Array {
  const body = parts.reduce((total, part) => total + partLength(part), 0);
  const out = new Uint8Array(8 + body);
  out.set(u32(8 + body), 0);
  out.set(ascii(type), 4);
  let at = 8;
  for (const part of parts) {
    out.set(part instanceof Uint8Array ? part : Uint8Array.from(part), at);
    at += partLength(part);
  }
  return out;
}

/** A full box: the same, with a one-byte version and three flag bytes. */
function fullBox(type: string, version: number, flags: number, ...parts: Part[]): Uint8Array {
  return box(type, [version, (flags >> 16) & 0xff, (flags >> 8) & 0xff, flags & 0xff], ...parts);
}

/** The unity transform. The last row is 2.30 fixed point, hence 0x40000000. */
const IDENTITY_MATRIX: readonly number[] = [
  ...u32(0x00010000),
  ...u32(0),
  ...u32(0),
  ...u32(0),
  ...u32(0x00010000),
  ...u32(0),
  ...u32(0),
  ...u32(0),
  ...u32(0x40000000),
];

/* ========================================================================== *
 * Sample entries built from scratch
 * ========================================================================== */

/**
 * An MPEG-4 descriptor, with its base-128 length.
 *
 * Written in the shortest form the length allows. Several encoders pad these
 * to four bytes with 0x80 continuations; both are legal and short is what
 * every modern muxer writes.
 */
function descriptor(tag: number, ...parts: Part[]): number[] {
  const length = parts.reduce((total, part) => total + partLength(part), 0);
  const size: number[] = [];
  let remaining = length;
  do {
    size.unshift(remaining & 0x7f);
    remaining >>= 7;
  } while (remaining > 0);
  for (let index = 0; index < size.length - 1; index += 1) {
    size[index] = (size[index] ?? 0) | 0x80;
  }

  const flat: number[] = [tag, ...size];
  for (const part of parts) flat.push(...(part instanceof Uint8Array ? [...part] : part));
  return flat;
}

/**
 * The `esds` box, which is how an MP4 says what an `mp4a` really contains.
 *
 * `objectType` is the whole point: 0x40 is AAC and 0x6B is MPEG-1 layer III,
 * and the sample entry is called `mp4a` in both cases. A player that finds no
 * `esds` has no way to tell which it is looking at.
 */
function esds(objectType: number, config: Uint8Array | null): Uint8Array {
  const specific = config === null || config.byteLength === 0 ? [] : [descriptor(0x05, config)];

  const decoderConfig = descriptor(
    0x04,
    [objectType],
    // Stream type 5 (audio) in the top six bits, upstream 0, then the reserved
    // bit the specification fixes at 1.
    [0x15],
    zeros(3), // buffer size, which nothing reads
    u32(0), // maximum bitrate
    u32(0), // average bitrate
    ...specific,
  );

  return fullBox(
    'esds',
    0,
    0,
    descriptor(
      0x03,
      u16(0), // ES_ID
      [0], // no dependency, no URL, no OCR stream
      decoderConfig,
      descriptor(0x06, [0x02]), // SL config: "predefined 2", the MP4 default
    ),
  );
}

export interface BuiltEntry {
  readonly codec: CodecId;
  readonly width: number;
  readonly height: number;
  readonly channels: number;
  readonly sampleRate: number;
  readonly codecPrivate: Uint8Array | null;
}

/**
 * A sample entry for a stream that arrived without one.
 *
 * Only Matroska sources reach here. The visual entry's fixed fields are all
 * conventional - 72 dpi, 24-bit depth, an empty compressor name - and the one
 * part that carries information is the configuration record at the end, which
 * is the source's `CodecPrivate` unaltered. Matroska stores H.264 and H.265 in
 * exactly the form an MP4 does, length-prefixed with the same configuration
 * record, so there is no bitstream to convert and nothing to get wrong.
 *
 * Null means the stream cannot be described, which for AVC and HEVC means the
 * file gave no configuration record at all. A track without one is a track no
 * decoder can start, and writing the entry anyway would produce a file that
 * looks complete and shows nothing.
 */
export function buildSampleEntry(entry: BuiltEntry): Uint8Array | null {
  const config = entry.codecPrivate;

  if (entry.codec === 'avc' || entry.codec === 'hevc') {
    if (config === null || config.byteLength === 0) return null;
    const isAvc = entry.codec === 'avc';
    return box(
      isAvc ? 'avc1' : 'hvc1',
      zeros(6),
      u16(1), // data reference index
      zeros(16),
      u16(entry.width),
      u16(entry.height),
      u32(0x00480000), // 72 dpi horizontal
      u32(0x00480000), // 72 dpi vertical
      u32(0),
      u16(1), // frames per sample
      zeros(32), // compressor name: length-prefixed, and empty
      u16(0x0018), // 24-bit colour
      u16(0xffff), // pre_defined, which the specification fixes at -1
      box(isAvc ? 'avcC' : 'hvcC', config),
    );
  }

  if (entry.codec === 'aac' || entry.codec === 'mp3') {
    /*
     * AAC needs its AudioSpecificConfig and MP3 does not, which is not a
     * quirk: an MP3 frame header states its own sample rate, layer and channel
     * mode, so the stream describes itself and there is nothing for the
     * container to add. AAC's does not, and a decoder handed an `esds` with no
     * DecoderSpecificInfo has no way to start.
     *
     * A handful of older Matroska files leave `CodecPrivate` off an AAC track
     * and expect a player to infer the config from the codec id, the sample
     * rate and the channel count. That inference is exact for plain AAC-LC and
     * WRONG for the SBR variants, where it produces audio at half pitch and
     * twice the length - which plays, and is the kind of plausible wrong
     * answer nobody reports. So the track is refused instead, and the result
     * says which track and why.
     */
    if (entry.codec === 'aac' && (config === null || config.byteLength === 0)) return null;

    return box(
      'mp4a',
      zeros(6),
      u16(1),
      u32(0), // QuickTime version and revision: 0, so this is the short entry
      u32(0), // vendor
      u16(entry.channels),
      u16(16), // bits per sample
      u16(0), // compression id
      u16(0), // packet size
      /*
       * The sample rate as 16.16 fixed point, which CANNOT HOLD 96 kHz OR
       * ABOVE - the integer part is sixteen bits wide. Every file at those
       * rates states the real number in `mdhd`, which is the media timescale,
       * so that is where a player looks and this field is clamped rather than
       * allowed to wrap into a plausible wrong number.
       */
      u32(Math.min(entry.sampleRate, 0xffff) * 0x10000),
      esds(entry.codec === 'aac' ? 0x40 : 0x6b, config),
    );
  }

  return null;
}

/* ========================================================================== *
 * The tracks handed to the writer
 * ========================================================================== */

export interface OutputTrack {
  readonly kind: TrackKind;
  readonly codec: CodecId;
  readonly timescale: number;
  readonly language: string | null;
  readonly width: number;
  readonly height: number;
  /** Ready to embed in `stsd`: copied from the source, or built above. */
  readonly sampleEntry: Uint8Array;
  readonly matrix: Uint8Array | null;
  readonly edits: readonly Edit[];
  readonly samples: SampleTable;
}

/** Three five-bit letters packed into sixteen bits. `und` where unknown. */
function packLanguage(language: string | null): number {
  const text = language !== null && language.length === 3 ? language : 'und';
  let packed = 0;
  for (let index = 0; index < 3; index += 1) {
    packed = (packed << 5) | ((text.charCodeAt(index) - 0x60) & 0x1f);
  }
  return packed;
}

/* ========================================================================== *
 * The sample tables
 * ========================================================================== */

/** A run-length table of pairs, which is the shape of `stts` and `ctts`. */
function packRuns(runs: readonly (readonly [number, number])[], signed: boolean): Uint8Array {
  const out = new Uint8Array(runs.length * 8);
  for (const [index, run] of runs.entries()) {
    out.set(u32(run[0]), index * 8);
    out.set(signed ? i32(run[1]) : u32(run[1]), index * 8 + 4);
  }
  return out;
}

/** `stts`: how long each sample takes to decode, run-length compressed. */
function timeToSample(samples: SampleTable): Uint8Array {
  const runs: [number, number][] = [];

  for (let index = 0; index < samples.count; index += 1) {
    const delta =
      index + 1 < samples.count
        ? (samples.dts[index + 1] ?? 0) - (samples.dts[index] ?? 0)
        : samples.lastDuration;
    const last = runs.at(-1);
    if (last?.[1] === delta) last[0] += 1;
    else runs.push([1, Math.max(0, delta)]);
  }

  return fullBox('stts', 0, 0, u32(runs.length), packRuns(runs, false));
}

/**
 * `ctts`, or nothing at all when the stream has no reordering in it.
 *
 * Version 1 exists so an offset can be negative, which is how a stream says a
 * frame is shown BEFORE the moment it decodes. Choosing the version from the
 * data rather than always writing one or the other is what lets a file that
 * arrived with signed offsets leave with them intact, while a file that never
 * needed them keeps the box the widest range of players understands.
 */
function compositionOffsets(samples: SampleTable): Uint8Array | null {
  const runs: [number, number][] = [];
  let interesting = false;
  let negative = false;

  for (let index = 0; index < samples.count; index += 1) {
    const offset = (samples.cts[index] ?? 0) - (samples.dts[index] ?? 0);
    if (offset !== 0) interesting = true;
    if (offset < 0) negative = true;
    const last = runs.at(-1);
    if (last?.[1] === offset) last[0] += 1;
    else runs.push([1, offset]);
  }

  if (!interesting) return null;
  return fullBox('ctts', negative ? 1 : 0, 0, u32(runs.length), packRuns(runs, negative));
}

/** `stss`, and nothing at all when every sample is a sync sample. */
function syncSamples(samples: SampleTable): Uint8Array | null {
  const numbers: number[] = [];
  for (let index = 0; index < samples.count; index += 1) {
    if ((samples.sync[index] ?? 0) !== 0) numbers.push(index + 1);
  }
  /*
   * An ABSENT `stss` means every sample is a sync sample, which is both
   * smaller and more accurate than listing all of them. An EMPTY one means the
   * opposite - nothing in this track is seekable - and the two must never be
   * confused: writing an empty box for an all-keyframe stream produces a video
   * that plays from the start and cannot be scrubbed.
   */
  if (numbers.length === samples.count) return null;
  return fullBox(
    'stss',
    0,
    0,
    u32(numbers.length),
    packFields(numbers.length, 4, (index) => numbers[index] ?? 0),
  );
}

function sampleSizes(samples: SampleTable): Uint8Array {
  const first = samples.size[0] ?? 0;
  if (samples.count > 0 && samples.size.every((size) => size === first)) {
    return fullBox('stsz', 0, 0, u32(first), u32(samples.count));
  }
  return fullBox(
    'stsz',
    0,
    0,
    u32(0),
    u32(samples.count),
    packFields(samples.count, 4, (index) => samples.size[index] ?? 0),
  );
}

/* ========================================================================== *
 * Interleaving
 * ========================================================================== */

/** One run of consecutive samples from one track, stored together. */
interface Chunk {
  readonly track: number;
  readonly first: number;
  readonly count: number;
}

/**
 * How much of each track goes into one chunk before switching to the next.
 *
 * Interleaving is why a video plays while it downloads. A file holding all its
 * video and then all its audio is perfectly valid and completely unplayable
 * over a network: the player needs both streams at the same instant and they
 * are half a film apart. A second is what every muxer uses - small enough that
 * a player never waits, large enough that the chunk tables stay small.
 */
const CHUNK_SECONDS = 1;

/**
 * The chunk plan, walked by TIME rather than by a fixed step.
 *
 * Each pass takes the earliest sample still waiting and sweeps a one-second
 * window from there. Stepping the window by a fixed second instead would cost
 * one iteration per second of declared duration - and a hostile file's
 * timestamps run to four billion ticks, which is a denial of service written
 * as arithmetic. Advancing to the next real sample bounds this loop by the
 * sample count, which is already bounded.
 */
function planChunks(tracks: readonly OutputTrack[]): Chunk[] {
  const chunks: Chunk[] = [];
  const cursors = tracks.map(() => 0);
  const scales = tracks.map((track) => Math.max(1, track.timescale));

  for (;;) {
    let earliest = Number.POSITIVE_INFINITY;
    for (const [index, track] of tracks.entries()) {
      const at = cursors[index] ?? 0;
      if (at >= track.samples.count) continue;
      earliest = Math.min(earliest, (track.samples.dts[at] ?? 0) / (scales[index] ?? 1));
    }
    if (!Number.isFinite(earliest)) break;

    const limit = earliest + CHUNK_SECONDS;
    for (const [index, track] of tracks.entries()) {
      const first = cursors[index] ?? 0;
      const scale = scales[index] ?? 1;
      let at = first;
      while (at < track.samples.count && (track.samples.dts[at] ?? 0) / scale < limit) at += 1;
      // The track that set `earliest` always takes at least one sample, so
      // every pass consumes something and the loop always terminates.
      if (at > first) chunks.push({ track: index, first, count: at - first });
      cursors[index] = at;
    }
  }

  return chunks;
}

/** `stsc`: how many samples each chunk of a track holds, run-length coded. */
function sampleToChunk(chunks: readonly Chunk[], track: number): Uint8Array {
  const runs: [number, number][] = [];
  let position = 0;

  for (const chunk of chunks) {
    if (chunk.track !== track) continue;
    position += 1;
    const last = runs.at(-1);
    if (last?.[1] === chunk.count) continue;
    runs.push([position, chunk.count]);
  }

  const table = new Uint8Array(runs.length * 12);
  for (const [index, run] of runs.entries()) {
    table.set(u32(run[0]), index * 12);
    table.set(u32(run[1]), index * 12 + 4);
    table.set(u32(1), index * 12 + 8); // the one sample description
  }

  return fullBox('stsc', 0, 0, u32(runs.length), table);
}

/* ========================================================================== *
 * The movie
 * ========================================================================== */

/** Media duration in the track's own ticks: where the last sample ends. */
function mediaDuration(samples: SampleTable): number {
  if (samples.count === 0) return 0;
  return (samples.dts[samples.count - 1] ?? 0) + samples.lastDuration;
}

function editList(edits: readonly Edit[]): Uint8Array | null {
  if (edits.length === 0) return null;
  const table = new Uint8Array(edits.length * 12);
  for (const [index, edit] of edits.entries()) {
    table.set(u32(edit.segmentDuration), index * 12);
    table.set(i32(edit.mediaTime), index * 12 + 4);
    table.set(u16(edit.mediaRateInteger), index * 12 + 8);
    table.set(u16(edit.mediaRateFraction), index * 12 + 10);
  }
  return box('edts', fullBox('elst', 0, 0, u32(edits.length), table));
}

interface MovieOptions {
  readonly tracks: readonly OutputTrack[];
  readonly chunks: readonly Chunk[];
  readonly timescale: number;
  /** Where the first byte of media data will land in the finished file. */
  readonly mediaStart: number;
}

function buildTrak(options: MovieOptions, index: number, offsets: readonly number[]): Uint8Array {
  const { tracks, chunks, timescale } = options;
  const track = tracks[index];
  if (track === undefined) return new Uint8Array(0);

  const duration = Math.round((mediaDuration(track.samples) / track.timescale) * timescale);

  const tkhd = fullBox(
    'tkhd',
    0,
    // Enabled, in the movie, in the preview. A track with none of these set is
    // one a player is entitled to ignore entirely.
    0x000007,
    u32(0),
    u32(0),
    u32(index + 1),
    u32(0),
    u32(duration),
    zeros(8),
    u16(0), // layer
    u16(0), // alternate group
    u16(track.kind === 'audio' ? 0x0100 : 0), // full volume, for sound only
    u16(0),
    track.matrix ?? IDENTITY_MATRIX,
    u32(track.width * 0x10000),
    u32(track.height * 0x10000),
  );

  const own: number[] = [];
  for (const [position, chunk] of chunks.entries()) {
    if (chunk.track === index) own.push(offsets[position] ?? 0);
  }
  const chunkOffsets = fullBox(
    'co64',
    0,
    0,
    u32(own.length),
    packFields(own.length, 8, (at) => own[at] ?? 0),
  );

  const stblParts = [
    fullBox('stsd', 0, 0, u32(1), track.sampleEntry),
    timeToSample(track.samples),
    compositionOffsets(track.samples),
    track.kind === 'video' ? syncSamples(track.samples) : null,
    sampleToChunk(chunks, index),
    sampleSizes(track.samples),
    chunkOffsets,
  ].filter((part): part is Uint8Array => part !== null);

  const edts = editList(track.edits);
  const isVideo = track.kind === 'video';

  return box(
    'trak',
    tkhd,
    ...(edts === null ? [] : [edts]),
    box(
      'mdia',
      fullBox(
        'mdhd',
        0,
        0,
        u32(0),
        u32(0),
        u32(track.timescale),
        u32(mediaDuration(track.samples)),
        u16(packLanguage(track.language)),
        u16(0),
      ),
      fullBox(
        'hdlr',
        0,
        0,
        u32(0),
        ascii(isVideo ? 'vide' : 'soun'),
        zeros(12),
        ascii(isVideo ? 'VideoHandler' : 'SoundHandler'),
        [0],
      ),
      box(
        'minf',
        isVideo
          ? fullBox('vmhd', 0, 1, u16(0), u16(0), u16(0), u16(0))
          : fullBox('smhd', 0, 0, u16(0), u16(0)),
        // A self-contained file: the media is in this file, so the one data
        // entry is the "same file" URL with its self-contained flag set and no
        // location after it.
        box('dinf', fullBox('dref', 0, 0, u32(1), fullBox('url ', 0, 1))),
        box('stbl', ...stblParts),
      ),
    ),
  );
}

function buildMoov(options: MovieOptions): Uint8Array {
  const { tracks, chunks, timescale, mediaStart } = options;

  // Chunk offsets in the order the chunks are written, computed once and read
  // per track, so the plan and the tables cannot disagree about the layout.
  const offsets: number[] = [];
  let at = mediaStart;
  for (const chunk of chunks) {
    offsets.push(at);
    const track = tracks[chunk.track];
    for (let index = 0; index < chunk.count; index += 1) {
      at += track?.samples.size[chunk.first + index] ?? 0;
    }
  }

  const movieDuration = Math.max(
    0,
    ...tracks.map((track) => (mediaDuration(track.samples) / track.timescale) * timescale),
  );

  return box(
    'moov',
    fullBox(
      'mvhd',
      0,
      0,
      u32(0),
      u32(0),
      u32(timescale),
      u32(Math.round(movieDuration)),
      u32(0x00010000), // rate: 1.0
      u16(0x0100), // volume: 1.0
      u16(0),
      zeros(8),
      IDENTITY_MATRIX,
      zeros(24),
      u32(tracks.length + 1),
    ),
    ...tracks.map((_track, index) => buildTrak(options, index, offsets)),
  );
}

/* ========================================================================== *
 * Entry point
 * ========================================================================== */

export interface WriteOptions {
  readonly source: Uint8Array;
  readonly tracks: readonly OutputTrack[];
  readonly timescale: number;
  /** Major brand: `isom` for a film, `M4A ` for an audio-only file. */
  readonly majorBrand: string;
  readonly compatibleBrands: readonly string[];
}

export function writeMp4(options: WriteOptions): Bytes {
  const { source, tracks, timescale } = options;

  const chunks = planChunks(tracks);
  const mediaBytes = mediaSize(tracks);

  const ftyp = box(
    'ftyp',
    ascii(options.majorBrand),
    u32(0x200),
    ...options.compatibleBrands.map((brand) => ascii(brand)),
  );

  /*
   * TWICE, AND EXACTLY TWICE.
   *
   * The first pass exists only to learn how long `moov` is; the chunk offsets
   * in it are wrong and are never used. The second is built knowing where the
   * media data will start. This terminates rather than iterating because
   * `co64` entries are a fixed width, so the second `moov` is exactly as long
   * as the first whatever the offsets turn out to be - which is the whole
   * reason this file never uses the 32-bit `stco`.
   */
  const measured = buildMoov({ tracks, chunks, timescale, mediaStart: 0 });
  const mediaStart = ftyp.byteLength + measured.byteLength + 8;
  const moov = buildMoov({ tracks, chunks, timescale, mediaStart });

  const out = new Uint8Array(mediaStart + mediaBytes);
  out.set(ftyp, 0);
  out.set(moov, ftyp.byteLength);
  out.set(u32(8 + mediaBytes), ftyp.byteLength + moov.byteLength);
  out.set(ascii('mdat'), ftyp.byteLength + moov.byteLength + 4);

  let at = mediaStart;
  for (const chunk of chunks) {
    const track = tracks[chunk.track];
    if (track === undefined) continue;
    for (let index = 0; index < chunk.count; index += 1) {
      const from = track.samples.offset[chunk.first + index] ?? 0;
      const size = track.samples.size[chunk.first + index] ?? 0;
      out.set(source.subarray(from, from + size), at);
      at += size;
    }
  }

  return out;
}

/**
 * The media bytes a set of tracks will contribute, before anything is built.
 *
 * Wanted twice: once by the writer, and once by the caller, which has to
 * decide whether the output is going to fit in memory BEFORE allocating it.
 */
export function mediaSize(tracks: readonly OutputTrack[]): number {
  return tracks.reduce(
    (total, track) => total + track.samples.size.reduce((sum, size) => sum + size, 0),
    0,
  );
}
