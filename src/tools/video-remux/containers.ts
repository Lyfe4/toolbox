import { fail, type ToolResult } from '@/features/registry/types';

/**
 * WHAT BOTH READERS PRODUCE, AND THE CEILINGS THEY READ UNDER.
 *
 * This tool changes a video's container without touching a single compressed
 * frame. Both halves of that are worth stating precisely, because both shape
 * everything below:
 *
 *   - The pixels are never decoded. A sample goes from one file to the other
 *     as bytes, byte for byte. There is no codec here, no decoder, and nothing
 *     to be lossy WITH. What is rewritten is the index - the tables saying
 *     which bytes are which frame, when each is shown, and which ones a player
 *     may seek to.
 *   - Which means every input is parsed, and NOTHING is decoded. That is the
 *     opposite of the usual arrangement, where a library absorbs a hostile
 *     file on your behalf. Here the hostile file is read by this code, and the
 *     first bug will be here rather than in somebody else's C.
 *
 * That is why the limits below are stated as a group rather than sprinkled
 * through the parsers. The image tool learned this the expensive way: its
 * decompression-bomb guard read as safe, ran after the decode, and was
 * measured committing 1.6 GB before it could refuse anything. The rule that
 * came out of it is that a limit has to be checked against what the CONTAINER
 * DECLARES, before anything is allocated on the strength of it.
 *
 * Applied here, that means one thing above all: a sample table's declared
 * entry count is an attacker-controlled 32-bit number, and no array is ever
 * sized from one.
 */

/* ========================================================================== *
 * Limits
 * ========================================================================== */

/**
 * Every ceiling this tool reads under, with the reason for each.
 *
 * These are deliberately not tuned to any particular file. Each is set where a
 * legitimate file has never been and a hostile one wants to go, so that
 * tripping one is evidence about the input rather than about the limit.
 */
export const LIMITS = {
  /**
   * The shortest thing that could possibly be a container.
   *
   * An ISO-BMFF file needs 8 bytes to hold one box header; a Matroska file
   * needs 4 for its EBML magic. Below this there is nothing to read and the
   * honest answer is "this is not a video", not a parse error.
   */
  minBytes: 16,

  /**
   * Tracks in one file.
   *
   * A DVD rip with every audio dub and every subtitle language runs to a dozen
   * or so. Thirty-two is generous for that and refuses a file declaring
   * thousands, which is a shape that only exists to make a parser allocate.
   */
  maxTracks: 32,

  /**
   * Samples - frames - in one track.
   *
   * Two hours of 30 fps video is 216,000 video samples and about 340,000 audio
   * ones. A million is comfortably past anything that fits in this tool's
   * input limit and is the number an `stsz` declaring 0xFFFFFFFF entries runs
   * into. Nothing is ever allocated from a declared count: the tables grow as
   * real entries are read, and this is where the growing stops.
   */
  maxSamplesPerTrack: 1_000_000,

  /**
   * Frames in one Matroska laced block.
   *
   * Lacing packs several small audio frames into one block, and the count is a
   * single byte, so 256 is the format's own ceiling. Stated anyway, because
   * the sizes that follow it are attacker-controlled and the loop reading them
   * must have a bound that does not depend on them.
   */
  maxLaceFrames: 256,

  /**
   * How deep a box or element tree may nest.
   *
   * The real ones are five deep - `moov/trak/mdia/minf/stbl/stsd`. Twelve
   * leaves room for a container nobody has met without letting a file whose
   * boxes contain themselves recurse until the stack gives out.
   */
  maxDepth: 12,

  /**
   * Total boxes or elements read from one file, at every level together.
   *
   * The per-level walks already terminate: each one advances by at least one
   * byte and stops at its parent's end. This is the second bound, on TIME
   * rather than on termination - a 256 MB file of two-byte elements is a
   * hundred million legal iterations, and a tool that takes a minute to refuse
   * something has not really refused it.
   */
  maxNodes: 4_000_000,

  /**
   * How far into a file the transport-stream detector may look.
   *
   * Twenty-one 188-byte packets. This is not a safety bound - the scan is
   * already trivially bounded - it is a CONSISTENCY bound, and it belongs to
   * `lib/sniff` rather than to this tool. A file's type is decided there from
   * a 4096-byte slice, so that a 200 MB video dropped on a text-only port can
   * be refused without being read into memory, and `fileInput.test.ts` asserts
   * that the slice and the whole file produce an identical verdict. A detector
   * that looked past 4096 bytes would be able to disagree with itself between
   * those two calls, which presents as a file accepted on one route and
   * refused on the other.
   */
  tsScanBytes: 4096,

  /**
   * Elementary streams tracked while reading a transport stream.
   *
   * A broadcast multiplex carries a dozen programmes and a hundred streams,
   * and a recording of one carries the handful the recorder kept. This is the
   * number of PIDs a reader will hold state for at once; past it, the extra
   * ones are ignored and named. It is separate from `maxTracks` because that
   * counts tracks OFFERED to the user and this counts streams SEEN in a
   * multiplex, which in a broadcast capture is much the larger number.
   */
  maxElementaryStreams: 64,

  /**
   * Chunks read from an AVI's `movi` list when there is no index to use.
   *
   * An AVI with a usable `idx1` is bounded by that table's own length. One
   * without it is walked chunk by chunk, and a two-hour film is a quarter of a
   * million chunks - so the walk needs a ceiling that is not derived from
   * anything the file said. Two million is past any real file that fits inside
   * this tool's input limit.
   */
  maxAviChunks: 2_000_000,
} as const;

/* ========================================================================== *
 * Codecs
 * ========================================================================== */

/**
 * The codecs this tool understands, and what it can do with each.
 *
 * `carried` is the whole product decision. A container change cannot convert a
 * codec, and this version does not re-encode - so the question for every
 * stream is only ever "can this travel inside an MP4", and the answer is a
 * property of the codec rather than of the file.
 *
 * VP8, VP9, AV1, Opus and Vorbis are the interesting refusals, because a muxer
 * COULD write them into an MP4 and this one deliberately does not. They are
 * WebM's native codecs; the result would be a file that plays in fewer players
 * than the one it came from - Safari in particular takes none of them in an
 * MP4 - so "convert this WebM to MP4" is a request that cannot be granted by
 * repackaging, and saying so is more use than producing a worse file. They are
 * named here rather than lumped under "unknown" precisely so the refusal can
 * say which codec it found.
 */
export type CodecId =
  | 'avc'
  | 'hevc'
  | 'aac'
  | 'mp3'
  | 'vp8'
  | 'vp9'
  | 'av1'
  | 'opus'
  | 'vorbis'
  | 'flac'
  | 'ac3'
  | 'mp2'
  | 'mpeg4part2'
  | 'mpeg2video'
  | 'mjpeg'
  | 'pcm'
  | 'subtitle'
  | 'unknown';

export interface CodecFacts {
  readonly label: string;
  /** True when an MP4 can carry this stream untouched, and usefully. */
  readonly carried: boolean;
  /** Why not, written for the person holding the file. */
  readonly refusal?: string;
}

export const CODECS: Readonly<Record<CodecId, CodecFacts>> = {
  avc: { label: 'H.264', carried: true },
  hevc: { label: 'H.265', carried: true },
  aac: { label: 'AAC', carried: true },
  mp3: { label: 'MP3', carried: true },
  vp8: {
    label: 'VP8',
    carried: false,
    refusal: 'VP8 is a WebM codec. Putting it in an MP4 makes a file fewer players accept.',
  },
  vp9: {
    label: 'VP9',
    carried: false,
    refusal: 'VP9 is a WebM codec. Putting it in an MP4 makes a file fewer players accept.',
  },
  av1: {
    label: 'AV1',
    carried: false,
    refusal: 'AV1 in an MP4 is not played by Safari, so repackaging would lose you a player.',
  },
  opus: {
    label: 'Opus',
    carried: false,
    refusal: 'Opus is a WebM codec. In an MP4 it is refused by Safari.',
  },
  vorbis: {
    label: 'Vorbis',
    carried: false,
    refusal: 'Vorbis has no standard place in an MP4.',
  },
  flac: {
    label: 'FLAC',
    carried: false,
    refusal: 'FLAC in an MP4 is a recent extension that most players do not read.',
  },
  ac3: {
    label: 'Dolby Digital',
    carried: false,
    refusal: 'AC-3 needs a sample entry this version does not write.',
  },
  /*
   * THE FIVE REFUSALS THAT ARRIVED WITH AVI AND MPEG-TS.
   *
   * Every one of them is the same refusal the WebM codecs above get, for the
   * same reason: an MP4 could legally hold the stream, and the resulting file
   * would play in strictly fewer places than the file it came from.
   *
   * That is worth being precise about, because it is not obvious and it is the
   * whole reason reading AVI does not amount to converting AVI. MPEG-4 Part 2
   * has a settled MP4 sample entry - `mp4v`, object type 0x20 - and an
   * `mp4v` file is played by no browser, by no iPhone, and by no Apple device
   * since Perian stopped shipping. VLC plays it, and VLC already played the
   * AVI. So "convert this DivX film to MP4" is a request a REMUXER cannot
   * grant, and the honest answer names the codec instead of producing a file
   * that has moved the problem rather than solved it.
   *
   * MPEG-2 video and Motion JPEG are the same argument with older files, and
   * uncompressed PCM is that argument plus a file three times the size. Layer
   * II audio is the one that costs a real European DVB capture its sound: it
   * is what essentially every broadcaster there uses, `esds` object type 0x69
   * would carry it, and almost nothing outside VLC decodes Layer II out of an
   * MP4. Layer III in the same file travels, because the layer is in each
   * frame header and the reader looks.
   */
  mp2: {
    label: 'MPEG audio Layer II',
    carried: false,
    refusal:
      'Layer II is what broadcast television uses. An MP4 can hold it and almost nothing outside VLC will decode it from there, so the sound would be lost on the players most likely to be the reason you are converting.',
  },
  mpeg4part2: {
    label: 'MPEG-4 Part 2 (DivX or Xvid)',
    carried: false,
    refusal:
      'This is the codec in most AVI films, and it is the reason they do not play. An MP4 can legally hold it, and no browser and no Apple device will decode it from there - so a repackage would move the problem rather than fix it. Nothing short of re-encoding helps, which this tool does not do.',
  },
  mpeg2video: {
    label: 'MPEG-2 video',
    carried: false,
    refusal:
      'DVD and broadcast video. An MP4 can hold it and no browser plays it, so repackaging would not gain you a player.',
  },
  mjpeg: {
    label: 'Motion JPEG',
    carried: false,
    refusal:
      'A run of JPEG stills, which is what older cameras recorded to AVI. No browser plays it inside an MP4.',
  },
  pcm: {
    label: 'uncompressed audio',
    carried: false,
    refusal:
      'Uncompressed sound has no settled place in an MP4 that ordinary players read, and carrying it would make the file several times larger for no gain.',
  },
  subtitle: {
    label: 'Subtitles',
    carried: false,
    refusal: 'Subtitle tracks are not carried into the MP4.',
  },
  unknown: {
    label: 'an unrecognised codec',
    carried: false,
    refusal: 'This version only carries H.264, H.265, AAC and MP3.',
  },
};

/* ========================================================================== *
 * The parsed file
 * ========================================================================== */

export type TrackKind = 'video' | 'audio' | 'other';

/**
 * One track's sample table, in decode order.
 *
 * Parallel arrays rather than an array of objects, because a two-hour film is
 * half a million entries and five numbers each is the difference between a few
 * megabytes and a few dozen. They are always the same length, which is
 * `count`.
 *
 * `dts` is when the sample is DECODED and `cts` is when it is SHOWN. They
 * differ only where a stream has B-frames, and keeping both is what lets a
 * reordered stream survive the trip: Matroska stores presentation times and
 * MP4 wants both, so one of the two readers has to reconstruct the other. See
 * `reconstructDecodeTimes`.
 */
export interface SampleTable {
  readonly count: number;
  /** Byte offset of each sample in the SOURCE file. */
  readonly offset: readonly number[];
  readonly size: readonly number[];
  /** Decode time, in the track's own timescale. */
  readonly dts: readonly number[];
  /** Composition (presentation) time, same timescale. */
  readonly cts: readonly number[];
  /** 1 where a player may start decoding at this sample. */
  readonly sync: readonly number[];
  /** Duration of the last sample, which no delta can give. */
  readonly lastDuration: number;
}

/** One entry of an edit list, carried through a repackage unchanged. */
export interface Edit {
  /** In MOVIE timescale. */
  readonly segmentDuration: number;
  /** In MEDIA timescale. -1 is an empty edit. */
  readonly mediaTime: number;
  readonly mediaRateInteger: number;
  readonly mediaRateFraction: number;
}

export interface SourceTrack {
  /** 1-based position in the file, for messages a person reads. */
  readonly number: number;
  readonly kind: TrackKind;
  readonly codec: CodecId;
  /** Ticks per second for this track's own timestamps. Never zero. */
  readonly timescale: number;
  readonly width: number | null;
  readonly height: number | null;
  readonly channels: number | null;
  readonly sampleRate: number | null;
  /** ISO 639-2/T, or null. Carried so a multi-language file can say which. */
  readonly language: string | null;
  /**
   * The source's own MP4 sample entry box, verbatim, when there was one.
   *
   * THIS IS THE MOST LOAD-BEARING FIELD IN THE FILE. Repackaging an MP4 or a
   * MOV does not need this tool to understand `avcC`, `esds`, `pasp`, `colr`,
   * `btrt` or anything else a real encoder put in there - it needs to not
   * damage them. Copying the entry whole is both simpler and strictly more
   * faithful than rebuilding one from fields we happened to parse, and it is
   * why a MOV from a camera keeps its colour information through a repackage.
   */
  readonly sampleEntry: Uint8Array | null;
  /**
   * The codec configuration record, when the source was Matroska.
   *
   * Matroska has no sample entry to copy, so one has to be built - and its
   * `CodecPrivate` is, by that format's own definition, exactly the `avcC` or
   * `hvcC` or AudioSpecificConfig that goes inside it. Nothing is invented.
   */
  readonly codecPrivate: Uint8Array | null;
  /**
   * The track header's 3x3 display matrix, verbatim, when the source had one.
   *
   * WHY PHONE VIDEO IS NOT SIDEWAYS. A phone held upright records landscape
   * pixels and writes a 90-degree rotation here. Everything else about the
   * file describes a landscape video; this is the entire reason a player turns
   * it up the right way. A rebuilt track header without it produces a
   * repackage that is correct in every measurable respect and plays on its
   * side - output nobody reports, because it looks like a video.
   */
  readonly matrix: Uint8Array | null;
  readonly edits: readonly Edit[];
  readonly samples: SampleTable;
  /**
   * The buffer this track's sample offsets point into, or null for the file.
   *
   * WHY A TRACK CAN HAVE ITS OWN BYTES. Repackaging an MP4 or a Matroska file
   * never needs this: a sample is a contiguous run of bytes in the input, so
   * the writer copies straight out of the file it was handed. Neither of the
   * two containers added later can promise that.
   *
   *   - In MPEG-TS one frame is sprayed across dozens of 188-byte packets,
   *     each with its own four-byte header in the middle of it. There is no
   *     contiguous run to point at; the frame has to be gathered up first.
   *   - In both TS and AVI, H.264 and H.265 arrive as Annex B - NAL units
   *     separated by start codes - and an MP4 wants them length-prefixed. The
   *     coded pictures are identical either way, but the four bytes in front
   *     of each one are not, so the sample that gets written is not the sample
   *     that was read.
   *
   * Per TRACK rather than per file, because a reader should not have to copy a
   * stream it is about to refuse. An AVI holding Xvid video and MP3 sound
   * assembles the MP3 - whose frames straddle chunk boundaries - and leaves
   * the Xvid pointing at the original file, where it costs nothing.
   */
  readonly media: Uint8Array | null;
}

export type ContainerId = 'mp4' | 'matroska' | 'mpegts' | 'avi';

export interface SourceFile {
  readonly container: ContainerId;
  /** How the file describes itself: an MP4 brand, or a Matroska DocType. */
  readonly flavour: string;
  readonly timescale: number;
  readonly durationSeconds: number | null;
  readonly tracks: readonly SourceTrack[];
  /**
   * What the recording device wrote alongside the streams, named for a person.
   *
   * A repackage carries the frames and rebuilds the index; everything else -
   * the location a phone stamped into the file, the date it was recorded, the
   * titles and tags a ripper added - is left behind. That is a privacy
   * improvement and it is also information somebody may have wanted, and in an
   * application whose whole pitch is that your data does not move, "GPS
   * location was removed" is close to the most important sentence it can
   * print. This is the list the result says was dropped.
   */
  readonly metadata: readonly string[];
  /**
   * What went wrong while reading, when something did AND enough was readable
   * to go on with.
   *
   * A download interrupted three quarters of the way through is a real file
   * with real frames in it, and refusing the lot is worse than repackaging
   * what survived. But a partial recovery that says nothing is the failure
   * this repository keeps writing down - output that looks exactly like a
   * successful conversion and is not - so this is carried out of the reader
   * and turned into a warning on the result. Silence here means the whole file
   * was read.
   */
  readonly problem: string | null;
  /**
   * True when the samples were re-framed on the way out rather than copied.
   *
   * THE ONE SENTENCE IN THIS TOOL'S PITCH THAT TWO CONTAINERS MADE UNTRUE.
   * "The frames are copied across byte for byte" is exact for MP4 and for
   * Matroska, and it is not exact for MPEG-TS or for H.264 in an AVI: those
   * store Annex B, where a NAL unit is introduced by a `00 00 01` start code
   * and the sequence and picture parameter sets sit in the stream itself. An
   * MP4 wants each NAL unit preceded by its length and the parameter sets
   * hoisted into `avcC`. So every coefficient and every macroblock survives
   * untouched - this is still not a decode, and still cannot be lossy - but
   * the bytes around them are rewritten and a byte-for-byte assertion over the
   * whole sample would be false.
   *
   * Carried out to the report rather than left in a comment, because a claim
   * this tool makes about itself everywhere else has to stop being made on the
   * files where it does not hold.
   */
  readonly reframed: boolean;
}

/* ========================================================================== *
 * What this file is, read from the bytes
 * ========================================================================== */

function tagAt(bytes: Uint8Array, offset: number, length: number): string {
  if (offset + length > bytes.length) return '';
  let out = '';
  for (let index = 0; index < length; index += 1) {
    out += String.fromCharCode(bytes[offset + index] ?? 0);
  }
  return out;
}

/**
 * Which container this is, from the bytes and never from the name.
 *
 * The same rule the rest of the app follows, and it matters more here than
 * anywhere: a `.mp4` that is really a Matroska is a completely ordinary thing
 * to find on a disk, because the extension is what a download named it and the
 * bytes are what an encoder wrote. `file.type` is worse still - it comes from
 * the operating system's extension mapping, so it is that same wrong answer
 * laundered through a media type.
 */
export function detectContainer(bytes: Uint8Array): ContainerId | null {
  // EBML magic. Matroska and WebM are the same container with different
  // DocTypes, and which one it claims to be is checked by the reader.
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    return 'matroska';
  }
  // RIFF, four bytes of length, `AVI `. Matching the `AVI ` alone would claim
  // any file with those bytes in that position, and the RIFF header is the
  // entire reason they are there - the same shape the WebP signature in
  // `lib/sniff` had to be corrected into.
  if (tagAt(bytes, 0, 4) === 'RIFF' && tagAt(bytes, 8, 4) === 'AVI ') return 'avi';
  // ISO base media: the first box is conventionally `ftyp`. QuickTime files
  // written before ftyp existed start with `moov`, `mdat` or `wide`, and
  // several cameras still write them, so those are accepted too.
  const first = tagAt(bytes, 4, 4);
  if (first === 'ftyp' || first === 'moov' || first === 'mdat' || first === 'wide') return 'mp4';
  if (detectTransportStream(bytes) !== null) return 'mpegts';
  return null;
}

/* ========================================================================== *
 * MPEG-TS, the one container with no magic number
 * ========================================================================== */

/**
 * How a transport stream is laid out on disk, when it is one.
 *
 * MPEG-TS IS THE ONE CONTAINER HERE THAT CANNOT BE RECOGNISED BY A SIGNATURE,
 * and that is a property of the format rather than an omission. It was
 * designed to be broadcast, so there is no header and no beginning: a receiver
 * tunes in partway through and finds its footing from the fact that every
 * packet starts with 0x47 and every packet is the same length. A file is
 * whatever the recorder had buffered when it started writing, so it can begin
 * mid-packet, and the first byte is 0x47 only by luck.
 *
 * So detection is PERIODICITY rather than a prefix, and the three numbers are
 * the three shapes this actually comes in:
 *
 *   - 188 is the packet, and a plain `.ts` from a tuner or from ffmpeg.
 *   - 192 is 188 with a four-byte arrival timestamp in front of every packet,
 *     which is BDAV - and which is what `.m2ts` and `.mts` are. Every AVCHD
 *     camcorder writes this, so leaving it out would refuse the single largest
 *     group of files this reader exists for while accepting the format they
 *     are technically in.
 *   - 204 is 188 with sixteen bytes of Reed-Solomon parity after it, which is
 *     what some DVB capture cards hand over unprocessed.
 *
 * The scan is bounded to `tsScanBytes` and NOT to the whole file, and that
 * bound is load-bearing for a reason outside this tool: `lib/sniff` decides a
 * file's type from a 4096-byte slice so that a 200 MB file can be refused by a
 * text-only port without being read, and `fileInput.test.ts` asserts that the
 * slice and the whole file give the same answer. A scan that read further here
 * could disagree with itself between those two calls.
 */
export interface TransportLayout {
  /** 188, 192 or 204. */
  readonly packetSize: number;
  /** Where the first whole packet begins - its 0x47, not the BDAV prefix. */
  readonly firstSync: number;
}

const TS_PACKET_SIZES: readonly number[] = [188, 192, 204];

export function detectTransportStream(bytes: Uint8Array): TransportLayout | null {
  const window = Math.min(bytes.length, LIMITS.tsScanBytes);

  for (let start = 0; start < window && start < 208; start += 1) {
    if (bytes[start] !== 0x47) continue;
    for (const packetSize of TS_PACKET_SIZES) {
      /*
       * Five packets in a row, which is the number that stops a coincidence.
       * One 0x47 is a 1-in-256 accident; two at the right distance happens in
       * any large binary. Five costs 940 bytes to check and is inside the
       * smallest sensible fragment of a transport stream, which carries a
       * program table in its first few packets and therefore several packets.
       */
      let matched = 0;
      while (matched < 5) {
        const at = start + matched * packetSize;
        if (at >= window) break;
        if (bytes[at] !== 0x47) break;
        matched += 1;
      }
      // Fewer than five only counts when the WINDOW ran out rather than the
      // pattern - a 400-byte fragment holding two good packets is still a
      // transport stream, and the reader will say what it could get from it.
      const ran = start + matched * packetSize >= window;
      if (matched >= 5 || (matched >= 2 && ran)) return { packetSize, firstSync: start };
    }
  }

  return null;
}

/**
 * The refusal for something that is not a video at all.
 *
 * Named separately because it is the message most people who mis-drop a file
 * will see, and "unsupported" on its own tells them nothing about what to do.
 */
export function refuseUnknownContainer<T>(bytes: Uint8Array): ToolResult<T> {
  if (bytes.byteLength < LIMITS.minBytes) {
    return fail('invalid-input', 'That file is too small to be a video.', {
      detail: `${String(bytes.byteLength)} bytes. A container needs at least a header.`,
    });
  }
  return fail('unsupported-type', 'That does not look like a video file.', {
    detail:
      'The container is read from the bytes, never from the name. This tool reads MP4, MOV, M4A and 3GP, Matroska (MKV and WebM), MPEG transport streams (TS, M2TS and MTS) and AVI.',
  });
}

/* ========================================================================== *
 * Decode times, where a format only stored presentation times
 * ========================================================================== */

/**
 * Derives decode times from presentation times, for a stream stored in decode
 * order.
 *
 * Matroska stores one timestamp per block and it is the PRESENTATION time; the
 * storage order is the decode order. MP4 wants both, separately, in `stts` and
 * `ctts`. So for any stream with B-frames the decode times have to be
 * reconstructed, and getting it wrong shows up as a file that plays with the
 * frames very slightly out of order - which looks like a bad encode rather
 * than like a bad remux.
 *
 * The construction, and why it is right:
 *
 *   - The i-th frame in decode order cannot be shown before the i-th earliest
 *     presentation time in the whole stream, so `sorted(pts)[i]` is a valid
 *     decode time: it is monotonic by construction, and it never claims a
 *     frame was decoded after something that depends on it.
 *   - It can still be LATER than that frame's own presentation time, which an
 *     MP4 cannot express in `ctts` version 0 (the offsets are unsigned). So
 *     everything is shifted later by `delay`, the worst such overshoot in the
 *     stream. That makes every offset non-negative without needing the signed
 *     version of the box, which older players read differently or not at all.
 *
 * The delay is a whole number of ticks and is applied identically to every
 * track, by the caller, so it cannot desynchronise sound from picture - it
 * moves the entire film later by a frame or two relative to nothing at all.
 */
export function reorderDelay(pts: readonly number[]): number {
  const sorted = [...pts].toSorted((a, b) => a - b);
  let delay = 0;
  for (let index = 0; index < pts.length; index += 1) {
    delay = Math.max(delay, (sorted[index] ?? 0) - (pts[index] ?? 0));
  }
  return delay;
}

/** The decode times themselves: the same instants, in the order they decode. */
export function decodeTimes(pts: readonly number[]): number[] {
  return [...pts].toSorted((a, b) => a - b);
}
