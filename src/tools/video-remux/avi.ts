import { fail, ok, type ByteSource, type ToolResult } from '@/features/registry/types';
import { canWindowBlobs, createByteSink } from '@/lib/binary';

import {
  ParameterSets,
  reframeInto,
  reframedCeiling,
  splitAnnexB,
  type VideoConfig,
} from './annexb';
import {
  CODECS,
  LIMITS,
  type CodecId,
  type SampleTable,
  type SourceFile,
  type SourceTrack,
  type TrackKind,
} from './containers';
import { splitMpegAudio } from './elementary';

/**
 * READING AVI, AND BEING HONEST ABOUT WHAT THAT BUYS.
 *
 * This reader is here for a narrower reason than the other three, and the
 * reason is worth stating at the top rather than discovered at the bottom of a
 * refusal.
 *
 * MOST REAL AVI FILES WILL BE READ BY THIS CODE AND THEN REFUSED FOR
 * REPACKAGING. The video in an old AVI is MPEG-4 Part 2 - DivX or Xvid - or
 * Motion JPEG, or MPEG-2. All three have a perfectly legal home in an MP4, and
 * none of them is decoded by any browser, by any iPhone, or by anything Apple
 * ships. So carrying them would produce a file that plays in VLC, which
 * already played the AVI, and nowhere else: the tool's own doctrine, written
 * down for VP9 and AV1 long before this reader existed, says refuse and name
 * the codec. A container change cannot convert a codec.
 *
 * WHAT IT IS STILL WORTH, then, is two things:
 *
 *   - THE REFUSAL IS THE ANSWER. "That does not look like a video file" is the
 *     wrong response to an AVI, and it is what this tool said before. "Your
 *     video is Xvid, which is why nothing plays it, and repackaging cannot
 *     help" is the thing the person holding the file actually wanted to know.
 *   - THE SOUND COMES OUT. The audio in those films is MP3 in the large
 *     majority, and extracting it is exact and lossless - which makes
 *     "Extract the audio track" a working feature on the format rather than a
 *     second refusal. An AVI carrying H.264, which some capture hardware
 *     writes, repackages properly too.
 *
 * The format itself is RIFF: a tree of four-character chunks with
 * little-endian lengths, which is the one thing here that is genuinely simple.
 * Two decisions below are not.
 *
 * THE INDEX IS NOT USED FOR OFFSETS. An `idx1` table states each chunk's
 * position, and whether that position is measured from the start of the file
 * or from the start of the `movi` list is famously not settled - both exist in
 * the wild, and a reader that guesses wrong produces an index pointing at
 * chunk headers instead of frames, which is video that decodes into noise. So
 * the `movi` list is WALKED for positions, which cannot be ambiguous, and
 * `idx1` is consulted only for the keyframe flags it is the only source of.
 *
 * A ZERO-LENGTH CHUNK IS A FRAME. It means "identical to the one before",
 * which is how an AVI encodes a dropped frame, and it must consume a frame's
 * worth of TIME without producing a sample. A reader that skips it entirely
 * produces a video that is shorter than its own soundtrack by however many
 * frames were dropped, and drifts steadily out of step on the way there.
 */

/* ========================================================================== *
 * RIFF
 * ========================================================================== */

function fourcc(bytes: ByteSource, at: number): string {
  if (at + 4 > bytes.size) return '';
  let out = '';
  for (let index = 0; index < 4; index += 1) out += String.fromCharCode(bytes.u8(at + index));
  return out;
}

/** Little-endian, which is the whole of what makes RIFF not ISO-BMFF. */
function u32le(bytes: ByteSource, at: number): number {
  if (at + 4 > bytes.size) return 0;
  return (
    bytes.u8(at) +
    bytes.u8(at + 1) * 0x100 +
    bytes.u8(at + 2) * 0x10000 +
    bytes.u8(at + 3) * 0x1000000
  );
}

function u16le(bytes: ByteSource, at: number): number {
  return bytes.u8(at) + bytes.u8(at + 1) * 0x100;
}

interface Chunk {
  readonly id: string;
  /** For a LIST or RIFF chunk, the type that follows the length. */
  readonly listType: string;
  readonly body: number;
  readonly end: number;
}

interface Walk {
  chunks: number;
  problem: string | null;
}

/**
 * The chunks directly inside `[from, to)`.
 *
 * RIFF pads every chunk to an even length and does not count the pad in the
 * length, which is the one place a careless walk goes wrong: an odd-length
 * chunk followed by a cursor advanced by its stated length lands one byte
 * early, reads a four-character code straddling two chunks, and finds garbage
 * for the rest of the file.
 */
function children(bytes: ByteSource, from: number, to: number, walk: Walk, depth: number): Chunk[] {
  const found: Chunk[] = [];
  if (depth > LIMITS.maxDepth) {
    walk.problem = 'the chunks are nested deeper than any real file nests them';
    return found;
  }

  let cursor = from;
  while (cursor + 8 <= to) {
    walk.chunks += 1;
    if (walk.chunks > LIMITS.maxAviChunks) {
      walk.problem = 'the file holds more chunks than this tool will read';
      break;
    }

    const id = fourcc(bytes, cursor);
    const size = u32le(bytes, cursor + 4);
    const isList = id === 'LIST' || id === 'RIFF';
    const body = cursor + 8 + (isList ? 4 : 0);
    const end = cursor + 8 + size;

    if (end > to || body > end) {
      walk.problem = 'a chunk runs past the end of the one that contains it';
      break;
    }

    found.push({ id, listType: isList ? fourcc(bytes, cursor + 8) : '', body, end });

    // The pad byte, and the guarantee that this loop advances: `size` may be
    // zero, and eight bytes of header always move the cursor forward.
    cursor = end + (size % 2);
  }

  return found;
}

/* ========================================================================== *
 * Codecs
 * ========================================================================== */

/**
 * A video codec from its `biCompression` four-character code.
 *
 * Matched case-insensitively, because the same codec is written a dozen ways -
 * `XVID`, `xvid`, `DX50`, `DIVX`, `FMP4` are all the same MPEG-4 Part 2
 * bitstream, and the case a particular encoder chose says nothing.
 */
function videoCodecFor(code: string): CodecId {
  const tag = code.toUpperCase();
  if (['H264', 'X264', 'AVC1', 'DAVC', 'VSSH'].includes(tag)) return 'avc';
  if (['HEVC', 'H265', 'HVC1', 'HEV1'].includes(tag)) return 'hevc';
  if (
    [
      'XVID',
      'DIVX',
      'DX50',
      'DIV3',
      'DIV4',
      'DIV5',
      'MP43',
      'MP42',
      'MPG4',
      'MP4V',
      'FMP4',
    ].includes(tag)
  ) {
    return 'mpeg4part2';
  }
  if (['MJPG', 'JPEG', 'DMB1', 'MJPA'].includes(tag)) return 'mjpeg';
  if (['MPG2', 'MP2V', 'HDV2', 'MPEG'].includes(tag)) return 'mpeg2video';
  return 'unknown';
}

/** An audio codec from its `wFormatTag`, which is the Windows registry number. */
function audioCodecFor(formatTag: number): CodecId {
  switch (formatTag) {
    case 0x0055:
      return 'mp3';
    case 0x0050:
      return 'mp2';
    case 0x0001:
    case 0x0003:
    case 0xfffe:
      return 'pcm';
    case 0x2000:
    case 0x2001:
      return 'ac3';
    case 0x00ff:
    case 0x1600:
    case 0x1601:
      return 'aac';
    default:
      return 'unknown';
  }
}

/* ========================================================================== *
 * The stream headers
 * ========================================================================== */

interface StreamDraft {
  readonly number: number;
  readonly kind: TrackKind;
  readonly codec: CodecId;
  /** `00` for stream zero: the first two characters of every chunk id. */
  readonly prefix: string;
  readonly scale: number;
  readonly rate: number;
  readonly width: number | null;
  readonly height: number | null;
  readonly channels: number | null;
  readonly sampleRate: number | null;
  readonly language: string | null;
  /** Whatever followed the fixed part of `strf`, which is codec-specific. */
  readonly extra: Uint8Array | null;
  readonly chunks: { offset: number; size: number }[];
  keyframes: number[] | null;
}

function readStreamHeader(
  bytes: ByteSource,
  list: Chunk,
  index: number,
  walk: Walk,
): StreamDraft | null {
  const fields = children(bytes, list.body, list.end, walk, 2);
  const strh = fields.find((chunk) => chunk.id === 'strh');
  const strf = fields.find((chunk) => chunk.id === 'strf');
  if (strh === undefined || strh.end - strh.body < 40) return null;

  const type = fourcc(bytes, strh.body);
  const scale = u32le(bytes, strh.body + 20);
  const rate = u32le(bytes, strh.body + 24);

  // Declared without a value, because every branch below assigns one and an
  // initialiser here would be a default nothing can reach.
  let codec: CodecId;
  let width: number | null = null;
  let height: number | null = null;
  let channels: number | null = null;
  let sampleRate: number | null = null;
  let extra: Uint8Array | null = null;

  if (type === 'vids') {
    if (strf === undefined || strf.end - strf.body < 40) return null;
    width = u32le(bytes, strf.body + 4);
    // `biHeight` is signed, and a NEGATIVE value means the rows are stored top
    // down rather than bottom up. That is a fact about an uncompressed bitmap
    // and says nothing about a coded stream, so only the magnitude is a size.
    const raw = u32le(bytes, strf.body + 8);
    height = raw >= 0x80000000 ? 0x100000000 - raw : raw;
    codec = videoCodecFor(fourcc(bytes, strf.body + 16));
    const headerSize = Math.max(40, u32le(bytes, strf.body));
    if (strf.body + headerSize < strf.end) {
      extra = bytes.slice(strf.body + headerSize, strf.end - strf.body - headerSize);
    }
  } else if (type === 'auds') {
    if (strf === undefined || strf.end - strf.body < 16) return null;
    codec = audioCodecFor(u16le(bytes, strf.body));
    channels = u16le(bytes, strf.body + 2);
    sampleRate = u32le(bytes, strf.body + 4);
    const cbSize = strf.end - strf.body >= 18 ? u16le(bytes, strf.body + 16) : 0;
    if (cbSize > 0 && strf.body + 18 + cbSize <= strf.end) {
      extra = bytes.slice(strf.body + 18, cbSize);
    }
  } else {
    // `txts` for subtitles, `mids` for MIDI, and anything else a writer
    // invented. Named as another track so the result can say it was there.
    codec = type === 'txts' ? 'subtitle' : 'unknown';
  }

  const kind: TrackKind = type === 'vids' ? 'video' : type === 'auds' ? 'audio' : 'other';

  return {
    number: index + 1,
    kind,
    codec,
    prefix: index.toString().padStart(2, '0'),
    // A scale or rate of zero would divide by zero in the timescale. One frame
    // per second is not a guess about the file, it is the only value that
    // keeps a broken header from taking the whole read down - and a file in
    // that state has its timing named on the result as damage.
    scale: scale > 0 ? scale : 1,
    rate: rate > 0 ? rate : 1,
    width: width === 0 ? null : width,
    height: height === 0 ? null : height,
    channels: channels === 0 ? null : channels,
    sampleRate: sampleRate === 0 ? null : sampleRate,
    language: null,
    extra,
    chunks: [],
    keyframes: null,
  };
}

/* ========================================================================== *
 * `movi`
 * ========================================================================== */

/**
 * Whether a chunk id belongs to a stream, by its two-digit prefix.
 *
 * The suffix says what KIND of data it is - `dc` compressed video, `db`
 * uncompressed, `wb` audio, `tx` text - and is deliberately not checked, since
 * the stream header has already said what the stream is and a disagreement
 * between the two is not something a remuxer can adjudicate.
 */
function chunkBelongsTo(id: string, prefix: string): boolean {
  return id.startsWith(prefix) && id.length === 4;
}

function gatherMovi(
  bytes: ByteSource,
  list: Chunk,
  drafts: readonly StreamDraft[],
  walk: Walk,
  depth: number,
): void {
  for (const chunk of children(bytes, list.body, list.end, walk, depth)) {
    // `rec ` groups the chunks that should be read together off a slow disc.
    // It changes nothing about the data and has to be descended into.
    if (chunk.id === 'LIST' && chunk.listType === 'rec ') {
      gatherMovi(bytes, chunk, drafts, walk, depth + 1);
      continue;
    }
    for (const draft of drafts) {
      if (!chunkBelongsTo(chunk.id, draft.prefix)) continue;
      if (draft.chunks.length >= LIMITS.maxSamplesPerTrack) break;
      draft.chunks.push({ offset: chunk.body, size: chunk.end - chunk.body });
      break;
    }
  }
}

/**
 * The keyframe flags out of `idx1`, matched to chunks BY POSITION.
 *
 * The Nth entry for a stream describes the Nth chunk of that stream, which is
 * true by construction and needs none of the offsets - see the note at the top
 * of this file about why the offsets are not to be trusted. This is the only
 * place in an AVI that says which frames a player may seek to, and getting it
 * from the one field in the table that cannot be ambiguous is worth the walk.
 */
function readIndexFlags(bytes: ByteSource, index: Chunk, drafts: readonly StreamDraft[]): void {
  const flags = new Map<string, number[]>();
  for (const draft of drafts) flags.set(draft.prefix, []);

  for (let at = index.body; at + 16 <= index.end; at += 16) {
    const list = flags.get(fourcc(bytes, at).slice(0, 2));
    if (list === undefined) continue;
    if (list.length >= LIMITS.maxSamplesPerTrack) continue;
    list.push((u32le(bytes, at + 4) & 0x10) === 0 ? 0 : 1);
  }

  for (const draft of drafts) {
    const found = flags.get(draft.prefix) ?? [];
    if (found.length > 0) draft.keyframes = found;
  }
}

/* ========================================================================== *
 * Building the tracks
 * ========================================================================== */

const EMPTY_TABLE: SampleTable = {
  count: 0,
  offset: [],
  size: [],
  dts: [],
  cts: [],
  sync: [],
  lastDuration: 0,
};

/**
 * A track named from its header, with no samples read.
 *
 * The same decision the transport-stream reader makes, for the same reason: an
 * AVI's stream header states the codec, and a codec this tool is going to
 * refuse does not need its half-gigabyte of frames indexed first. Since most
 * AVI video is refused, this is the common path rather than the exception -
 * without it, reading a DivX film would build a quarter of a million sample
 * entries in order to print one sentence about Xvid.
 */
function namedTrack(draft: StreamDraft): SourceTrack {
  return {
    number: draft.number,
    kind: draft.kind,
    codec: draft.codec,
    timescale: Math.max(1, Math.round(draft.rate / draft.scale)) || 1,
    width: draft.width,
    height: draft.height,
    channels: draft.channels,
    sampleRate: draft.sampleRate,
    language: draft.language,
    sampleEntry: null,
    codecPrivate: null,
    matrix: null,
    edits: [],
    media: null,
    samples: EMPTY_TABLE,
  };
}

/**
 * True when a video stream's `strf` extra data is already an `avcC`.
 *
 * Two things are called H.264 in an AVI and they are not the same file. Most
 * writers store the Annex B byte stream, exactly as a transport stream does,
 * with no configuration record anywhere - and those have to be re-framed. A
 * few store MP4-style length-prefixed NAL units and put the real `avcC` in the
 * extra data after the bitmap header, and for those the samples can be copied
 * verbatim and the record used as it stands.
 *
 * Telling them apart from the extra data is the only option, and the check is
 * the record's own fixed fields: version 1, and the byte holding
 * `lengthSizeMinusOne` has its top six bits set by definition. Guessing wrong
 * in either direction produces samples a decoder cannot start on.
 */
function looksLikeAvcC(extra: Uint8Array | null): boolean {
  if (extra === null || extra.byteLength < 7) return false;
  return extra[0] === 1 && ((extra[4] ?? 0) & 0xfc) === 0xfc;
}

interface Built {
  readonly track: SourceTrack;
  readonly reframed: boolean;
  readonly problem: string | null;
}

/**
 * A video track whose samples are Annex B and have to be re-framed.
 *
 * The frame TIMES come from the chunk positions rather than from the samples,
 * which is what makes the dropped-frame case work: a zero-length chunk still
 * advances the frame counter, so the sample after it lands at the right
 * instant instead of one frame early.
 */
function buildAnnexBVideo(bytes: ByteSource, draft: StreamDraft): Built | null {
  const codec = draft.codec === 'avc' ? 'avc' : 'hevc';
  const total = draft.chunks.reduce((sum, chunk) => sum + chunk.size, 0);
  // Assembled rather than pointed at, because Annex B has to be re-framed on
  // the way into an MP4 - so the bytes written are not the bytes read. Through
  // a sink for the same reason the transport-stream reader uses one: an AVI
  // that carries H.264 is a capture file, and capture files are large.
  const media = createByteSink({ spill: canWindowBlobs() });
  const capacity = reframedCeiling(total);
  let scratch = new Uint8Array(0);
  const parameterSets = new ParameterSets(codec);

  const offset: number[] = [];
  const size: number[] = [];
  const dts: number[] = [];
  const sync: number[] = [];
  let written = 0;

  for (const [index, chunk] of draft.chunks.entries()) {
    if (chunk.size === 0) continue; // a dropped frame: time passes, nothing is stored
    const view = bytes.slice(chunk.offset, chunk.size);
    const nals = splitAnnexB(view, 0, view.length);
    parameterSets.observe(view, nals);

    const room = reframedCeiling(view.length);
    if (scratch.byteLength < room) scratch = new Uint8Array(room);
    const framed = reframeInto(scratch, 0, view, nals, codec);
    if (framed.empty) continue;
    // Bounded by the chunk sizes the `movi` walk actually found, so a file
    // that keeps claiming frames cannot gather more than it holds.
    if (written + framed.written > capacity) continue;
    media.write(scratch.subarray(0, framed.written));

    offset.push(written);
    size.push(framed.written);
    dts.push(index * draft.scale);
    // The bitstream is believed over the index here, and only here: an AVI's
    // keyframe flag is written by the muxer and an IDR is written by the
    // encoder, and where the two disagree the encoder is the one that knows.
    sync.push(framed.sync ? 1 : (draft.keyframes?.[index] ?? 0));
    written += framed.written;
  }

  const config: VideoConfig | null = parameterSets.describe();
  if (offset.length === 0 || config === null) return null;

  return {
    reframed: true,
    problem: null,
    track: {
      number: draft.number,
      kind: 'video',
      codec: draft.codec,
      timescale: draft.rate,
      /*
       * THE PARAMETER SET WINS HERE, which is the opposite of the rule the
       * other readers follow, and the reason is that AVI has no display size
       * to prefer. An MP4's `tkhd` and a Matroska file's DisplayWidth both
       * state the shape a video should be SHOWN at, which differs from the
       * coded size for anamorphic video - so there, the container is the
       * better answer. A `BITMAPINFOHEADER` states the coded size, the same
       * thing the parameter set states, and it is written by the muxer rather
       * than by the encoder. Where the two disagree the encoder is the one
       * that knows, and the header is the fallback for a stream whose
       * parameter set could not be parsed for a size at all.
       */
      width: config.width || draft.width,
      height: config.height || draft.height,
      channels: null,
      sampleRate: null,
      language: draft.language,
      sampleEntry: null,
      codecPrivate: config.config,
      matrix: null,
      edits: [],
      media: media.source(),
      samples: {
        count: offset.length,
        offset,
        size,
        dts,
        cts: dts,
        sync,
        lastDuration: Math.max(1, draft.scale),
      },
    },
  };
}

/** A video track already stored the way an MP4 wants it, so copied verbatim. */
function buildCopiedVideo(draft: StreamDraft): Built | null {
  const offset: number[] = [];
  const size: number[] = [];
  const dts: number[] = [];
  const sync: number[] = [];

  for (const [index, chunk] of draft.chunks.entries()) {
    if (chunk.size === 0) continue;
    offset.push(chunk.offset);
    size.push(chunk.size);
    dts.push(index * draft.scale);
    sync.push(draft.keyframes?.[index] ?? (index === 0 ? 1 : 0));
  }

  if (offset.length === 0 || draft.extra === null) return null;

  return {
    reframed: false,
    problem: null,
    track: {
      number: draft.number,
      kind: 'video',
      codec: draft.codec,
      timescale: draft.rate,
      width: draft.width,
      height: draft.height,
      channels: null,
      sampleRate: null,
      language: draft.language,
      sampleEntry: null,
      codecPrivate: draft.extra,
      matrix: null,
      edits: [],
      media: null,
      samples: {
        count: offset.length,
        offset,
        size,
        dts,
        cts: dts,
        sync,
        lastDuration: Math.max(1, draft.scale),
      },
    },
  };
}

/**
 * An MPEG audio track, gathered and then split on frame headers.
 *
 * The chunks are concatenated first because an AVI's interleaver chose their
 * sizes and the codec did not: an MP3 frame routinely finishes in the chunk
 * after the one it started in. Splitting per chunk loses that frame, which is
 * a click every few hundred milliseconds - audio that plays and is wrong.
 *
 * The timing is the codec's rather than the container's, and that is the right
 * way round for audio. An MPEG frame is exactly 1152 samples (or 576, or 384,
 * depending on layer and version), so the frame count and the sample rate give
 * the duration exactly. The AVI header's own idea of the rate is a nominal
 * figure a muxer wrote and is not consulted.
 */
function buildMpegAudio(bytes: ByteSource, draft: StreamDraft): Built | null {
  const total = draft.chunks.reduce((sum, chunk) => sum + chunk.size, 0);
  if (total === 0) return null;
  const sink = createByteSink({ spill: canWindowBlobs() });
  for (const chunk of draft.chunks) sink.copyFrom(bytes, chunk.offset, chunk.size);
  const media = sink.source();

  const split = splitMpegAudio(media, LIMITS.maxSamplesPerTrack);
  if (split === null) return null;

  const dts = split.frames.map((_frame, index) => index * split.samplesPerFrame);

  return {
    reframed: false,
    problem: split.resynced
      ? 'the audio stream had to be resynchronised, so some frames between the readable ones were skipped'
      : null,
    track: {
      number: draft.number,
      kind: 'audio',
      // The layer is in the frame header, which is a better source than the
      // format tag: a file tagged as MP3 whose frames are Layer II does exist,
      // and only one of the two can travel into an MP4.
      codec: split.layer === 3 ? 'mp3' : 'mp2',
      timescale: split.sampleRate,
      width: null,
      height: null,
      channels: split.channels,
      sampleRate: split.sampleRate,
      language: draft.language,
      sampleEntry: null,
      codecPrivate: null,
      matrix: null,
      edits: [],
      media,
      samples: {
        count: split.frames.length,
        offset: split.frames.map((frame) => frame.offset),
        size: split.frames.map((frame) => frame.size),
        dts,
        cts: dts,
        sync: split.frames.map(() => 1),
        lastDuration: split.samplesPerFrame,
      },
    },
  };
}

/**
 * An AAC track, one chunk per sample.
 *
 * AVI is not a container AAC belongs in, and the consequence is that there is
 * no way to find frame boundaries inside a chunk: the frames are raw, with the
 * configuration in the stream header rather than in each frame, so there is no
 * sync word to walk. One chunk per frame is what every writer that produced
 * these files did, and it is what this assumes - stated here because it is an
 * assumption rather than a reading, and the only one in this file.
 *
 * If a writer packed several frames into a chunk, the result is audio at the
 * right pitch running short - which the report's duration comparison makes
 * visible, since it would no longer match the video's.
 */
function buildAacAudio(draft: StreamDraft): Built | null {
  if (draft.extra === null || draft.extra.byteLength === 0) return null;
  const rate = draft.sampleRate ?? 44_100;

  const offset: number[] = [];
  const size: number[] = [];
  const dts: number[] = [];
  for (const chunk of draft.chunks) {
    if (chunk.size === 0) continue;
    dts.push(offset.length * 1024);
    offset.push(chunk.offset);
    size.push(chunk.size);
  }
  if (offset.length === 0) return null;

  return {
    reframed: false,
    problem: null,
    track: {
      number: draft.number,
      kind: 'audio',
      codec: 'aac',
      timescale: rate,
      width: null,
      height: null,
      channels: draft.channels,
      sampleRate: rate,
      language: draft.language,
      sampleEntry: null,
      codecPrivate: draft.extra,
      matrix: null,
      edits: [],
      media: null,
      samples: {
        count: offset.length,
        offset,
        size,
        dts,
        cts: dts,
        sync: offset.map(() => 1),
        lastDuration: 1024,
      },
    },
  };
}

/* ========================================================================== *
 * Entry point
 * ========================================================================== */

export function readAvi(bytes: ByteSource): ToolResult<SourceFile> {
  const walk: Walk = { chunks: 0, problem: null };
  const top = children(bytes, 0, bytes.size, walk, 0);

  const riff = top.find((chunk) => chunk.id === 'RIFF' && chunk.listType === 'AVI ');
  if (riff === undefined) {
    return fail('parse-error', 'That file starts like an AVI and then does not.', {
      detail:
        walk.problem === null
          ? 'It has the RIFF signature and no AVI list inside it.'
          : `While reading the file: ${walk.problem}.`,
    });
  }

  const inside = children(bytes, riff.body, riff.end, walk, 1);
  const header = inside.find((chunk) => chunk.id === 'LIST' && chunk.listType === 'hdrl');
  if (header === undefined) {
    return fail('parse-error', 'That AVI does not say what streams it contains.', {
      detail:
        walk.problem === null
          ? 'An AVI carries a header list describing every stream. Without it there is nothing to repackage.'
          : `While reading it: ${walk.problem}.`,
    });
  }

  const streamLists = children(bytes, header.body, header.end, walk, 2).filter(
    (chunk) => chunk.id === 'LIST' && chunk.listType === 'strl',
  );
  if (streamLists.length > LIMITS.maxTracks) {
    return fail('limit-exceeded', 'That file declares more streams than this tool will read.', {
      detail: `${String(streamLists.length)} streams, against a limit of ${String(LIMITS.maxTracks)}.`,
    });
  }

  const drafts: StreamDraft[] = [];
  for (const [index, list] of streamLists.entries()) {
    const draft = readStreamHeader(bytes, list, index, walk);
    if (draft !== null) drafts.push(draft);
  }

  if (drafts.length === 0) {
    return fail('parse-error', 'That AVI has no readable streams in it.', {
      detail:
        walk.problem === null
          ? 'Every stream list was missing its header or its format description.'
          : `${walk.problem.charAt(0).toUpperCase()}${walk.problem.slice(1)}.`,
    });
  }

  /*
   * The `movi` lists, of which there can be more than one.
   *
   * A file past two gigabytes cannot express its own offsets in an AVI's
   * 32-bit fields, so the OpenDML extension appends further top-level `RIFF`
   * blocks of type `AVIX`, each with its own `movi`. Those files are past this
   * tool's input limit by definition - which is exactly why they are handled
   * here rather than refused: a file that has been TRUNCATED to fit is a
   * perfectly ordinary thing to be handed, and its second `movi` is where the
   * readable half of it lives.
   */
  const carriable = new Set<CodecId>(['avc', 'hevc', 'aac', 'mp3', 'mp2']);
  const wanted = drafts.filter((draft) => carriable.has(draft.codec));

  if (wanted.length > 0) {
    for (const chunk of inside) {
      if (chunk.id === 'LIST' && chunk.listType === 'movi') {
        gatherMovi(bytes, chunk, wanted, walk, 2);
      }
    }
    for (const chunk of top) {
      if (chunk.id !== 'RIFF' || chunk.listType !== 'AVIX') continue;
      for (const extended of children(bytes, chunk.body, chunk.end, walk, 1)) {
        if (extended.id === 'LIST' && extended.listType === 'movi') {
          gatherMovi(bytes, extended, wanted, walk, 2);
        }
      }
    }

    const index = inside.find((chunk) => chunk.id === 'idx1');
    if (index !== undefined) readIndexFlags(bytes, index, wanted);
  }

  const tracks: SourceTrack[] = [];
  const problems: string[] = [];
  // Streams whose chunks were found and whose decoder configuration was not,
  // which has to be said differently from a stream with no chunks in it.
  const unconfigured: CodecId[] = [];
  let reframed = false;

  for (const draft of drafts) {
    if (!carriable.has(draft.codec) || draft.chunks.length === 0) {
      tracks.push(namedTrack(draft));
      continue;
    }

    const built =
      draft.kind === 'video'
        ? looksLikeAvcC(draft.extra)
          ? buildCopiedVideo(draft)
          : buildAnnexBVideo(bytes, draft)
        : draft.codec === 'aac'
          ? buildAacAudio(draft)
          : buildMpegAudio(bytes, draft);

    if (built === null) {
      unconfigured.push(draft.codec);
      tracks.push(namedTrack(draft));
      continue;
    }
    if (built.problem !== null) problems.push(built.problem);
    reframed = reframed || built.reframed;
    tracks.push(built.track);
  }

  if (tracks.every((track) => track.samples.count === 0)) {
    if (walk.problem === null && drafts.every((draft) => !carriable.has(draft.codec))) {
      // Not a parse failure: the file was read perfectly and holds nothing an
      // MP4 can take. `remux` says which codecs and why, which is a better
      // message than anything this function could write.
      return ok(emptyFile(tracks, walk.problem));
    }
    if (unconfigured.length > 0) {
      return fail('parse-error', 'That AVI never says how to decode itself.', {
        detail: `Its ${unconfigured.map((codec) => CODECS[codec].label).join(' and ')} data is there, and nothing in the file says how to start decoding it. An AVI has two places to put that - inside the stream, as a broadcast does, or after the bitmap header - and this one uses neither.`,
      });
    }
    return fail('parse-error', 'That AVI describes its streams and contains no frames.', {
      detail:
        walk.problem === null
          ? 'Its movie list is empty or its chunks do not belong to any stream it declared.'
          : `While reading it, ${walk.problem}.`,
    });
  }

  // The truncation check every reader here performs, and the reason it is done
  // once at the end: a sample whose bytes are not in the file reads back as
  // zeros in JavaScript rather than failing, so a cut-short download whose
  // index survived would otherwise produce a well-formed MP4 full of silence.
  for (const track of tracks) {
    if (track.media !== null) continue;
    for (let index = 0; index < track.samples.count; index += 1) {
      const at = track.samples.offset[index] ?? 0;
      const size = track.samples.size[index] ?? 0;
      if (at < 0 || size < 0 || at + size > bytes.size) {
        return fail('parse-error', 'That file is truncated: some of its frames are not in it.', {
          detail: `Stream ${String(track.number)} says frame ${String(index + 1)} is ${String(size)} bytes at offset ${String(at)}, and the file is ${String(bytes.size)} bytes long.`,
        });
      }
    }
  }

  if (walk.problem !== null) problems.push(walk.problem);

  return ok({
    container: 'avi',
    flavour: 'AVI',
    // AVI has no movie clock of its own. A millisecond is what the writer uses
    // for everything else that has to choose one.
    timescale: 1000,
    durationSeconds: null,
    tracks,
    /*
     * AVI's own metadata is a set of `INFO` chunks - `INAM` for a title,
     * `ISFT` for the software that wrote it, `ICRD` for a date. They are
     * reported as dropped rather than read, because what the result has to say
     * is that they are gone, and reading them to print them would be the only
     * reason to read them at all.
     */
    metadata: hasInfo(bytes, inside, walk) ? ['Titles and tags'] : [],
    problem: problems.length === 0 ? null : problems.join(', and '),
    reframed,
  });
}

function hasInfo(bytes: ByteSource, inside: readonly Chunk[], walk: Walk): boolean {
  if (inside.some((chunk) => chunk.id === 'LIST' && chunk.listType === 'INFO')) return true;
  const odml = inside.find((chunk) => chunk.id === 'LIST' && chunk.listType === 'odml');
  if (odml === undefined) return false;
  return children(bytes, odml.body, odml.end, walk, 2).some((chunk) => chunk.id === 'dmlh');
}

function emptyFile(tracks: readonly SourceTrack[], problem: string | null): SourceFile {
  return {
    container: 'avi',
    flavour: 'AVI',
    timescale: 1000,
    durationSeconds: null,
    tracks,
    metadata: [],
    problem,
    reframed: false,
  };
}
