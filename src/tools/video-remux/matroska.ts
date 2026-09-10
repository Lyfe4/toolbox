import { fail, ok, type ToolResult } from '@/features/registry/types';

import {
  decodeTimes,
  LIMITS,
  reorderDelay,
  type CodecId,
  type SampleTable,
  type SourceFile,
  type SourceTrack,
  type TrackKind,
} from './containers';

/**
 * READING MATROSKA: MKV, and WebM, which is the same container with a
 * restricted codec list.
 *
 * Matroska is EBML - a tree where every node is an id, a length and a payload,
 * both of the first two written as variable-length integers. It is a much
 * better container than MP4 in almost every way, and the one respect in which
 * it is harder to convert FROM is the reason this file is longer than it
 * looks:
 *
 *   IT STORES PRESENTATION TIMES, AND MP4 WANTS DECODE TIMES TOO.
 *
 * A Matroska block carries one timestamp, and it is when the frame is SHOWN.
 * The order the blocks are stored in is the order they are DECODED. For a
 * stream with B-frames those two orders differ, and an MP4 has to state both
 * separately. Reconstructing the missing half is `reorderDelay` in
 * containers.ts, and it is the only thing in this tool that is inference
 * rather than transcription.
 *
 * The second thing worth knowing before reading on is LACING. Matroska packs
 * several small audio frames into one block to save headers, with the frame
 * boundaries encoded three different ways. MP4 has no equivalent - every
 * sample is separately indexed - so a laced block has to be taken apart, and a
 * reader that does not handle it produces audio that is silently wrong: the
 * frames are all there, in one sample, with one timestamp.
 */

/* ========================================================================== *
 * EBML primitives
 * ========================================================================== */

interface Vint {
  /** The value, with the length marker removed. */
  readonly value: number;
  /** Bytes consumed. Zero means the encoding was invalid. */
  readonly length: number;
  /** True when every value bit was set, which EBML uses to mean "unknown". */
  readonly unknown: boolean;
}

const INVALID_VINT: Vint = { value: 0, length: 0, unknown: false };

/**
 * A variable-length integer, with the length marker stripped.
 *
 * The first byte's leading zero count gives the total length: `1xxxxxxx` is
 * one byte, `01xxxxxx` two, and so on to eight. A first byte of zero declares
 * a length past eight, which EBML does not define - and which, read
 * carelessly, is a zero-length read and therefore a loop that never advances.
 */
function readVint(bytes: Uint8Array, at: number, end: number): Vint {
  if (at >= end) return INVALID_VINT;
  const first = bytes[at] ?? 0;
  if (first === 0) return INVALID_VINT;

  let length = 1;
  let mask = 0x80;
  while ((first & mask) === 0) {
    mask >>= 1;
    length += 1;
  }
  if (at + length > end) return INVALID_VINT;

  let value = first & (mask - 1);
  let allOnes = value === mask - 1;
  for (let index = 1; index < length; index += 1) {
    const byte = bytes[at + index] ?? 0;
    value = value * 256 + byte;
    if (byte !== 0xff) allOnes = false;
  }

  return { value, length, unknown: allOnes };
}

/** An element id keeps its marker: ids are compared as whole byte sequences. */
function readId(bytes: Uint8Array, at: number, end: number): Vint {
  if (at >= end) return INVALID_VINT;
  const first = bytes[at] ?? 0;
  if (first === 0) return INVALID_VINT;

  let length = 1;
  let mask = 0x80;
  while ((first & mask) === 0) {
    mask >>= 1;
    length += 1;
  }
  if (length > 4 || at + length > end) return INVALID_VINT;

  let value = 0;
  for (let index = 0; index < length; index += 1) value = value * 256 + (bytes[at + index] ?? 0);
  return { value, length, unknown: false };
}

function readUint(bytes: Uint8Array, from: number, to: number): number {
  let value = 0;
  for (let at = from; at < to && at - from < 8; at += 1) value = value * 256 + (bytes[at] ?? 0);
  return value;
}

/** Matroska floats are 4 or 8 bytes, IEEE 754, big-endian. */
function readFloat(bytes: Uint8Array, from: number, to: number): number | null {
  const length = to - from;
  if (length !== 4 && length !== 8) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset + from, length);
  return length === 4 ? view.getFloat32(0) : view.getFloat64(0);
}

function readString(bytes: Uint8Array, from: number, to: number): string {
  let out = '';
  for (let at = from; at < to && at - from < 256; at += 1) {
    const byte = bytes[at] ?? 0;
    if (byte === 0) break;
    out += String.fromCharCode(byte);
  }
  return out;
}

/* ========================================================================== *
 * Element ids
 * ========================================================================== */

const ID = {
  ebml: 0x1a45dfa3,
  docType: 0x4282,
  segment: 0x18538067,
  info: 0x1549a966,
  timestampScale: 0x2ad7b1,
  duration: 0x4489,
  tracks: 0x1654ae6b,
  trackEntry: 0xae,
  trackNumber: 0xd7,
  trackType: 0x83,
  codecId: 0x86,
  codecPrivate: 0x63a2,
  defaultDuration: 0x23e383,
  language: 0x22b59c,
  video: 0xe0,
  pixelWidth: 0xb0,
  pixelHeight: 0xba,
  displayWidth: 0x54b0,
  displayHeight: 0x54ba,
  audio: 0xe1,
  samplingFrequency: 0xb5,
  channels: 0x9f,
  dateUtc: 0x4461,
  tags: 0x1254c367,
  attachments: 0x1941a469,
  chapters: 0x1043a770,
  cluster: 0x1f43b675,
  clusterTimestamp: 0xe7,
  simpleBlock: 0xa3,
  blockGroup: 0xa0,
  block: 0xa1,
  referenceBlock: 0xfb,
} as const;

interface Element {
  readonly id: number;
  readonly body: number;
  readonly end: number;
}

interface Walk {
  nodes: number;
  problem: string | null;
}

/**
 * The elements directly inside `[from, to)`.
 *
 * The awkward case is a declared length of "unknown", which EBML writes as a
 * vint with every value bit set. It is legal, and it is how a file being
 * written live describes its Segment before it knows how long the Segment will
 * be. For the Segment that is easy - it runs to the end of the file - and for
 * anything else it means scanning forward for the next element that could
 * plausibly follow, which over compressed frame data is guesswork. So it is
 * accepted at the top level and refused below it, by name, rather than
 * silently producing half a file.
 */
function children(
  bytes: Uint8Array,
  from: number,
  to: number,
  walk: Walk,
  depth: number,
): Element[] {
  const found: Element[] = [];
  if (depth > LIMITS.maxDepth) {
    walk.problem = 'the elements are nested deeper than any real file nests them';
    return found;
  }

  let cursor = from;
  while (cursor < to) {
    if (walk.problem !== null) break;
    walk.nodes += 1;
    if (walk.nodes > LIMITS.maxNodes) {
      walk.problem = 'the file holds more elements than this tool will read';
      break;
    }

    const id = readId(bytes, cursor, to);
    if (id.length === 0) {
      walk.problem = 'an element id is not a valid EBML integer';
      break;
    }
    const size = readVint(bytes, cursor + id.length, to);
    if (size.length === 0) {
      walk.problem = 'an element length is not a valid EBML integer';
      break;
    }

    const body = cursor + id.length + size.length;
    let end: number;

    if (size.unknown) {
      if (id.value === ID.segment) {
        // The ordinary streamed shape: one Segment holding the rest of the file.
        end = to;
      } else {
        walk.problem =
          'an element inside the segment does not say how long it is, which only a live stream capture does';
        break;
      }
    } else {
      end = body + size.value;
    }

    if (end > to) {
      walk.problem = 'an element runs past the end of the one that contains it';
      break;
    }

    found.push({ id: id.value, body, end });
    if (end <= cursor) {
      walk.problem = 'an element does not advance, so the file cannot be read past it';
      break;
    }
    cursor = end;
  }

  return found;
}

function findElement(elements: readonly Element[], id: number): Element | null {
  return elements.find((element) => element.id === id) ?? null;
}

/* ========================================================================== *
 * Codecs
 * ========================================================================== */

/**
 * Matroska names its codecs in full, which makes this the one place in the
 * tool where the mapping is a table rather than an inference.
 *
 * `V_MPEG4/ISO/AVC` and `V_MPEGH/ISO/HEVC` are the two that matter, and the
 * important fact about both is that Matroska stores them in exactly the form
 * an MP4 does - length-prefixed NAL units, with the `avcC`/`hvcC`
 * configuration record as the track's `CodecPrivate`. So no bitstream
 * conversion is needed in either direction, which is why an MKV of an H.264
 * film becomes an MP4 in a fraction of a second.
 */
function codecOf(codecId: string): CodecId {
  if (codecId.startsWith('V_MPEG4/ISO/AVC')) return 'avc';
  if (codecId.startsWith('V_MPEGH/ISO/HEVC')) return 'hevc';
  if (codecId.startsWith('V_VP8')) return 'vp8';
  if (codecId.startsWith('V_VP9')) return 'vp9';
  if (codecId.startsWith('V_AV1')) return 'av1';
  if (codecId.startsWith('A_AAC')) return 'aac';
  if (codecId === 'A_MPEG/L3') return 'mp3';
  if (codecId.startsWith('A_OPUS')) return 'opus';
  if (codecId.startsWith('A_VORBIS')) return 'vorbis';
  if (codecId.startsWith('A_FLAC')) return 'flac';
  if (codecId.startsWith('A_AC3') || codecId.startsWith('A_EAC3')) return 'ac3';
  if (codecId.startsWith('S_')) return 'subtitle';
  return 'unknown';
}

/* ========================================================================== *
 * Blocks and lacing
 * ========================================================================== */

interface Frame {
  readonly offset: number;
  readonly size: number;
}

/**
 * The frames inside one block, taking lacing apart.
 *
 * Four encodings, and the two variable ones are where a hostile file gets to
 * choose numbers:
 *
 *   - NONE: one frame, the rest of the block.
 *   - XIPH: each size is a run of 0xFF bytes plus a final byte. Unbounded in
 *     principle, so the loop is bounded by the block instead.
 *   - FIXED: the remainder split evenly, which must actually divide.
 *   - EBML: the first size is a vint, and each one after it is a SIGNED vint
 *     difference from the previous. A negative difference is normal - audio
 *     frames vary by a byte or two - and a large one can drive the running
 *     size negative, which is refused rather than allowed to produce a
 *     negative-length read.
 *
 * In every case the sizes are accumulated and checked against what is actually
 * left in the block before a single frame is emitted, so a lace claiming more
 * than the block holds produces nothing rather than a set of frames pointing
 * past the end.
 */
function laceFrames(
  bytes: Uint8Array,
  from: number,
  to: number,
  lacing: number,
  walk: Walk,
): Frame[] | null {
  if (lacing === 0) return to > from ? [{ offset: from, size: to - from }] : [];

  if (from >= to) return null;
  const count = (bytes[from] ?? 0) + 1;
  if (count > LIMITS.maxLaceFrames) return null;
  let cursor = from + 1;

  const sizes: number[] = [];

  if (lacing === 2) {
    // Fixed: no sizes at all, so the remainder has to divide exactly. A block
    // that does not is malformed, and splitting it anyway would slice frames
    // across boundaries and produce audio that is noise.
    const remaining = to - cursor;
    if (remaining <= 0 || remaining % count !== 0) return null;
    for (let index = 0; index < count; index += 1) sizes.push(remaining / count);
  } else if (lacing === 1) {
    for (let index = 0; index < count - 1; index += 1) {
      let size = 0;
      for (;;) {
        if (cursor >= to) return null;
        walk.nodes += 1;
        if (walk.nodes > LIMITS.maxNodes) return null;
        const byte = bytes[cursor] ?? 0;
        cursor += 1;
        size += byte;
        if (byte !== 0xff) break;
      }
      sizes.push(size);
    }
  } else {
    const first = readVint(bytes, cursor, to);
    if (first.length === 0) return null;
    cursor += first.length;
    sizes.push(first.value);

    for (let index = 1; index < count - 1; index += 1) {
      const delta = readVint(bytes, cursor, to);
      if (delta.length === 0) return null;
      cursor += delta.length;
      // A signed vint is biased by half its range, so the same encoding can
      // express a small step in either direction.
      const bias = 2 ** (7 * delta.length - 1) - 1;
      const previous = sizes[index - 1] ?? 0;
      const size = previous + (delta.value - bias);
      if (size < 0) return null;
      sizes.push(size);
    }
  }

  if (lacing !== 2) {
    const declared = sizes.reduce((total, size) => total + size, 0);
    const remaining = to - cursor;
    if (declared > remaining) return null;
    // The last frame gets whatever is left, which is how every lacing mode
    // except FIXED avoids writing one more size.
    sizes.push(remaining - declared);
  }

  const frames: Frame[] = [];
  let at = cursor;
  for (const size of sizes) {
    if (size < 0 || at + size > to) return null;
    frames.push({ offset: at, size });
    at += size;
  }
  return frames;
}

interface RawSample {
  readonly offset: number;
  readonly size: number;
  /** Presentation time, in segment ticks. */
  readonly pts: number;
  readonly sync: number;
}

/* ========================================================================== *
 * Tracks
 * ========================================================================== */

interface TrackDraft {
  readonly number: number;
  readonly trackNumber: number;
  readonly kind: TrackKind;
  readonly codec: CodecId;
  readonly codecPrivate: Uint8Array | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly channels: number | null;
  readonly sampleRate: number | null;
  readonly language: string | null;
  /** Nanoseconds per frame, when the file says. Used for the last sample. */
  readonly defaultDuration: number | null;
  readonly samples: RawSample[];
}

function readTrackEntry(
  bytes: Uint8Array,
  entry: Element,
  position: number,
  walk: Walk,
): TrackDraft | null {
  const fields = children(bytes, entry.body, entry.end, walk, 3);

  const numberField = findElement(fields, ID.trackNumber);
  const typeField = findElement(fields, ID.trackType);
  const codecField = findElement(fields, ID.codecId);
  if (numberField === null || typeField === null || codecField === null) return null;

  const trackNumber = readUint(bytes, numberField.body, numberField.end);
  // Track number zero is reserved and can never appear in a block, so a track
  // claiming it can never receive a frame. Refusing it here also stops it
  // shadowing a real track in the lookup below.
  if (trackNumber === 0) return null;

  const type = readUint(bytes, typeField.body, typeField.end);
  const kind: TrackKind = type === 1 ? 'video' : type === 2 ? 'audio' : 'other';

  const privateField = findElement(fields, ID.codecPrivate);
  const languageField = findElement(fields, ID.language);
  const durationField = findElement(fields, ID.defaultDuration);

  let width: number | null = null;
  let height: number | null = null;
  const videoField = findElement(fields, ID.video);
  if (videoField !== null) {
    const video = children(bytes, videoField.body, videoField.end, walk, 4);
    const pixelWidth = findElement(video, ID.pixelWidth);
    const pixelHeight = findElement(video, ID.pixelHeight);
    const shownWidth = findElement(video, ID.displayWidth);
    const shownHeight = findElement(video, ID.displayHeight);
    width = pixelWidth === null ? null : readUint(bytes, pixelWidth.body, pixelWidth.end);
    height = pixelHeight === null ? null : readUint(bytes, pixelHeight.body, pixelHeight.end);
    // Display dimensions win where they exist, for the same reason the MP4
    // reader prefers `tkhd`: anamorphic video stores square-pixel counts and
    // the shape it is meant to be shown at, and only the second is the answer
    // to "how big is this video".
    if (shownWidth !== null) width = readUint(bytes, shownWidth.body, shownWidth.end) || width;
    if (shownHeight !== null) height = readUint(bytes, shownHeight.body, shownHeight.end) || height;
  }

  let channels: number | null = null;
  let sampleRate: number | null = null;
  const audioField = findElement(fields, ID.audio);
  if (audioField !== null) {
    const audio = children(bytes, audioField.body, audioField.end, walk, 4);
    const channelsField = findElement(audio, ID.channels);
    const rateField = findElement(audio, ID.samplingFrequency);
    channels =
      channelsField === null ? null : readUint(bytes, channelsField.body, channelsField.end);
    sampleRate = rateField === null ? null : readFloat(bytes, rateField.body, rateField.end);
  }

  const language =
    languageField === null ? null : readString(bytes, languageField.body, languageField.end);

  return {
    number: position,
    trackNumber,
    kind,
    codec: codecOf(readString(bytes, codecField.body, codecField.end)),
    codecPrivate:
      privateField === null ? null : bytes.subarray(privateField.body, privateField.end),
    width: width === 0 ? null : width,
    height: height === 0 ? null : height,
    channels: channels === 0 ? null : channels,
    sampleRate: sampleRate === null || sampleRate <= 0 ? null : Math.round(sampleRate),
    language: language === '' || language === 'und' ? null : language,
    defaultDuration:
      durationField === null
        ? null
        : readUint(bytes, durationField.body, durationField.end) || null,
    samples: [],
  };
}

/* ========================================================================== *
 * Entry point
 * ========================================================================== */

export function readMatroska(bytes: Uint8Array): ToolResult<SourceFile> {
  const walk: Walk = { nodes: 0, problem: null };
  const top = children(bytes, 0, bytes.length, walk, 0);

  const header = findElement(top, ID.ebml);
  const segment = findElement(top, ID.segment);

  if (header === null || segment === null) {
    return fail('parse-error', 'That file starts like a Matroska file and then does not.', {
      detail:
        walk.problem === null
          ? 'It has the EBML signature but no segment, which is where everything lives.'
          : `While reading the file: ${walk.problem}.`,
    });
  }

  const docType = findElement(children(bytes, header.body, header.end, walk, 1), ID.docType);
  const flavour = docType === null ? 'matroska' : readString(bytes, docType.body, docType.end);
  if (flavour !== 'matroska' && flavour !== 'webm') {
    return fail('unsupported-type', 'That file is EBML, but it is not a video.', {
      detail: `It calls itself "${flavour}". Matroska and WebM are the two this tool reads.`,
    });
  }

  const segmentChildren = children(bytes, segment.body, segment.end, walk, 1);
  const infoElement = findElement(segmentChildren, ID.info);
  const tracksElement = findElement(segmentChildren, ID.tracks);

  if (tracksElement === null) {
    return fail('parse-error', 'That file does not say what tracks it contains.', {
      detail:
        walk.problem === null
          ? 'A Matroska segment carries a Tracks element describing every stream. Without it there is nothing to repackage.'
          : `While reading the segment: ${walk.problem}.`,
    });
  }

  /*
   * The timestamp scale, in nanoseconds per tick. A million - one millisecond
   * - is the default and is what essentially every file uses.
   *
   * Zero would make the whole timeline collapse onto instant zero, and it is a
   * division by zero in the timescale below it, so it is refused rather than
   * defaulted: a file that states a scale of zero is stating something, and
   * quietly substituting a different number would produce a plausible file
   * from a broken one.
   */
  const info =
    infoElement === null ? [] : children(bytes, infoElement.body, infoElement.end, walk, 2);
  const scaleElement = findElement(info, ID.timestampScale);
  const scale =
    scaleElement === null ? 1_000_000 : readUint(bytes, scaleElement.body, scaleElement.end);
  if (scale <= 0) {
    return fail('parse-error', 'That file says one timestamp tick is zero seconds long.', {
      detail: 'Every timestamp in it would mean the same instant. Nothing can be made of that.',
    });
  }
  const timescale = Math.max(1, Math.round(1_000_000_000 / scale));

  const durationElement = findElement(info, ID.duration);
  const durationTicks =
    durationElement === null ? null : readFloat(bytes, durationElement.body, durationElement.end);

  const trackElements = children(bytes, tracksElement.body, tracksElement.end, walk, 2).filter(
    (element) => element.id === ID.trackEntry,
  );
  if (trackElements.length > LIMITS.maxTracks) {
    return fail('limit-exceeded', 'That file declares more tracks than this tool will read.', {
      detail: `${String(trackElements.length)} tracks, against a limit of ${String(LIMITS.maxTracks)}.`,
    });
  }

  const drafts: TrackDraft[] = [];
  for (const [index, element] of trackElements.entries()) {
    const draft = readTrackEntry(bytes, element, index + 1, walk);
    // A duplicate track number would make every later block ambiguous. The
    // first one wins, which is what a player does.
    if (draft !== null && !drafts.some((existing) => existing.trackNumber === draft.trackNumber)) {
      drafts.push(draft);
    }
  }

  if (drafts.length === 0) {
    return fail('parse-error', 'That file has no readable tracks in it.', {
      detail:
        walk.problem === null
          ? 'Every track entry was missing its number, its type or its codec.'
          : `${walk.problem.charAt(0).toUpperCase()}${walk.problem.slice(1)}.`,
    });
  }

  const byNumber = new Map(drafts.map((draft) => [draft.trackNumber, draft]));

  /* -- The clusters, which is where the frames are ------------------------ */

  /*
   * How far apart the frames inside one laced block are.
   *
   * Lacing exists because an audio frame's header costs more than the frame
   * saves, so several share one block and one timestamp. They are consecutive
   * in time, not simultaneous, and giving them all the block's timestamp
   * produces a track whose samples have zero duration - which an MP4 writes
   * out perfectly happily and a player renders as silence.
   *
   * The file's own DefaultDuration is the answer where it is stated. Where it
   * is not, the codec's fixed frame size is: an AAC frame is 1024 samples and
   * an MP3 frame is 1152, always, so with the sampling rate that is an exact
   * number of ticks rather than an estimate.
   */
  const laceStep = (draft: TrackDraft): number => {
    if (draft.defaultDuration !== null) {
      return Math.max(1, Math.round((draft.defaultDuration * timescale) / 1e9));
    }
    const samplesPerFrame = draft.codec === 'aac' ? 1024 : draft.codec === 'mp3' ? 1152 : 0;
    if (samplesPerFrame === 0 || draft.sampleRate === null) return 1;
    return Math.max(1, Math.round((samplesPerFrame * timescale) / draft.sampleRate));
  };

  const steps = new Map(drafts.map((draft) => [draft.trackNumber, laceStep(draft)]));

  const addBlock = (element: Element, clusterTime: number, keyframe: boolean | null): void => {
    const trackVint = readVint(bytes, element.body, element.end);
    if (trackVint.length === 0) return;
    let cursor = element.body + trackVint.length;
    // Track number, signed 16-bit relative timestamp, flags. A block with no
    // room for its own header is skipped rather than read out of bounds.
    if (cursor + 3 > element.end) return;

    const draft = byNumber.get(trackVint.value);
    const raw = ((bytes[cursor] ?? 0) << 8) | (bytes[cursor + 1] ?? 0);
    const relative = raw >= 0x8000 ? raw - 0x10000 : raw;
    const flags = bytes[cursor + 2] ?? 0;
    cursor += 3;

    if (draft === undefined) return;
    if (draft.samples.length >= LIMITS.maxSamplesPerTrack) return;

    const lacing = (flags >> 1) & 0x03;
    const frames = laceFrames(bytes, cursor, element.end, lacing, walk);
    if (frames === null) return;

    // A SimpleBlock states keyframe-ness in its flags. A Block inside a
    // BlockGroup does not: it is a keyframe exactly when nothing references
    // another frame, which the caller has already worked out.
    const sync = keyframe ?? (flags & 0x80) !== 0;
    const pts = clusterTime + relative;
    const step = steps.get(draft.trackNumber) ?? 1;

    for (const [index, frame] of frames.entries()) {
      draft.samples.push({
        offset: frame.offset,
        size: frame.size,
        pts: pts + index * step,
        sync: sync ? 1 : 0,
      });
    }
  };

  for (const clusterElement of segmentChildren) {
    if (clusterElement.id !== ID.cluster) continue;
    const cluster = children(bytes, clusterElement.body, clusterElement.end, walk, 2);
    if (walk.problem !== null) break;

    const timeElement = findElement(cluster, ID.clusterTimestamp);
    const clusterTime =
      timeElement === null ? 0 : readUint(bytes, timeElement.body, timeElement.end);

    for (const element of cluster) {
      if (element.id === ID.simpleBlock) {
        addBlock(element, clusterTime, null);
        continue;
      }
      if (element.id !== ID.blockGroup) continue;

      const group = children(bytes, element.body, element.end, walk, 3);
      const block = findElement(group, ID.block);
      if (block === null) continue;
      addBlock(block, clusterTime, findElement(group, ID.referenceBlock) === null);
    }
  }

  if (walk.problem !== null && drafts.every((draft) => draft.samples.length === 0)) {
    return fail('parse-error', 'That file is damaged and none of its frames could be read.', {
      detail: `${walk.problem.charAt(0).toUpperCase()}${walk.problem.slice(1)}.`,
    });
  }

  /* -- Presentation times into decode times ------------------------------- */

  /*
   * ONE DELAY FOR THE WHOLE FILE, which is what keeps sound with picture.
   *
   * Each track needs its presentation times shifted later by enough that no
   * composition offset comes out negative. Doing that per track would move the
   * video and the audio by different amounts - a few tens of milliseconds
   * apart, which is exactly the range a person hears as lip-sync being wrong.
   * The largest requirement is applied to every track, so the whole film moves
   * by one or two frames relative to nothing at all.
   */
  const withSamples = drafts.filter((draft) => draft.samples.length > 0);
  const delay = Math.max(
    0,
    ...withSamples.map((draft) => reorderDelay(draft.samples.map((sample) => sample.pts))),
  );

  const tracks: SourceTrack[] = withSamples.map((draft) => {
    const samples = draft.samples;
    const pts = samples.map((sample) => sample.pts);
    const dts = decodeTimes(pts);

    // Nanoseconds per frame into this track's own ticks, for the last sample -
    // the one no delta can measure. Falling back to the previous gap is what a
    // muxer does when the file does not say.
    const declared =
      draft.defaultDuration === null ? 0 : Math.round((draft.defaultDuration * timescale) / 1e9);
    const lastGap = dts.length >= 2 ? (dts[dts.length - 1] ?? 0) - (dts[dts.length - 2] ?? 0) : 0;
    const lastDuration = Math.max(1, declared || lastGap || 1);

    const table: SampleTable = {
      count: samples.length,
      offset: samples.map((sample) => sample.offset),
      size: samples.map((sample) => sample.size),
      dts,
      cts: pts.map((at) => at + delay),
      sync: samples.map((sample) => sample.sync),
      lastDuration,
    };

    return {
      number: draft.number,
      kind: draft.kind,
      codec: draft.codec,
      timescale,
      width: draft.width,
      height: draft.height,
      channels: draft.channels,
      sampleRate: draft.sampleRate,
      language: draft.language,
      sampleEntry: null,
      codecPrivate: draft.codecPrivate,
      // Matroska has no display matrix and no edit list. A rotation flag does
      // exist in newer revisions of the spec and essentially nothing writes
      // it, so a rotated MKV is a case this tool has never seen.
      matrix: null,
      edits: [],
      samples: table,
    };
  });

  if (tracks.length === 0) {
    return fail('parse-error', 'That file describes tracks but contains no frames.', {
      detail:
        'Its clusters are empty or unreadable. A Matroska file whose index survived and whose media did not is normally one that was cut short.',
    });
  }

  for (const track of tracks) {
    for (let index = 0; index < track.samples.count; index += 1) {
      const at = track.samples.offset[index] ?? 0;
      const size = track.samples.size[index] ?? 0;
      if (at < 0 || size < 0 || at + size > bytes.length) {
        return fail('parse-error', 'That file is truncated: some of its frames are not in it.', {
          detail: `Track ${String(track.number)} says frame ${String(index + 1)} is ${String(size)} bytes at offset ${String(at)}, and the file is ${String(bytes.length)} bytes long.`,
        });
      }
    }
  }

  /*
   * What this file carries that an MP4 repackage will not. See the note on
   * `metadata` in containers.ts: the point is not what the tags say, it is
   * that the result no longer has them and somebody should be told.
   */
  const metadata: string[] = [];
  if (findElement(info, ID.dateUtc) !== null) metadata.push('Recording date');
  if (findElement(segmentChildren, ID.tags) !== null) metadata.push('Titles and tags');
  if (findElement(segmentChildren, ID.chapters) !== null) metadata.push('Chapters');
  if (findElement(segmentChildren, ID.attachments) !== null) metadata.push('Attached files');

  return ok({
    container: 'matroska',
    flavour: flavour === 'webm' ? 'WebM' : 'Matroska',
    timescale,
    durationSeconds:
      durationTicks === null || durationTicks <= 0 ? null : (durationTicks * scale) / 1e9,
    tracks,
    metadata,
    problem: walk.problem,
  });
}
