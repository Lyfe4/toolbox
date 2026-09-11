import { fail, ok, type ByteSource, type ToolResult } from '@/features/registry/types';
import { canWindowBlobs, createByteSink } from '@/lib/binary';

import {
  ParameterSets,
  reframeInto,
  reframedCeiling,
  splitAnnexB,
  type AnnexBCodec,
  type VideoConfig,
} from './annexb';
import {
  CODECS,
  detectTransportStream,
  LIMITS,
  type CodecId,
  type Edit,
  type SampleTable,
  type SourceFile,
  type SourceTrack,
  type TrackKind,
} from './containers';
import { splitAdts, splitMpegAudio, type AudioFrame } from './elementary';

/**
 * READING AN MPEG TRANSPORT STREAM: .ts, .m2ts and .mts.
 *
 * This is the format with the strongest case for being here, and the case is
 * worth stating because it is also the argument for what got refused:
 *
 *   ALMOST EVERY REAL TRANSPORT STREAM HOLDS H.264 OR H.265 WITH AAC, WHICH IS
 *   EXACTLY WHAT THIS TOOL CARRIES. A screen recording out of OBS, a clip off
 *   an AVCHD camcorder, a tuner recording, an HLS segment - every one of them
 *   is a codec that every device in the house decodes, inside a container that
 *   no browser opens and almost no consumer player will touch. "This video
 *   won't play" is true of the wrapper and false of the contents, which is the
 *   one sentence this tool exists for.
 *
 * Now the four ways it is unlike everything else here, each of which shapes
 * the code below.
 *
 * IT WAS DESIGNED FOR BROADCAST, SO IT HAS NO BEGINNING. There is no header
 * and no magic number; a receiver tunes in partway through and finds its
 * footing from the fact that every packet is 188 bytes and starts with 0x47.
 * A file is whatever the recorder had buffered, so it can begin mid-packet.
 * Detection is therefore periodicity - see `detectTransportStream`.
 *
 * NOTHING IN IT IS CONTIGUOUS. One video frame is sprayed across dozens of
 * packets, each with a four-byte header in the middle of it and often an
 * adaptation field after that. There is no run of bytes in the file that IS
 * the frame, so a frame has to be gathered before it can be indexed - which is
 * what `SourceTrack.media` is for, and the reason a transport stream costs
 * more memory to read than an MKV of the same size.
 *
 * IT CARRIES BOTH TIMESTAMPS, WHICH NOTHING ELSE HERE DOES. A PES header
 * states the presentation time and the decode time separately, in a 90 kHz
 * clock. So the one piece of inference in this tool - the Matroska reader's
 * reconstruction of decode times from presentation times - is simply absent:
 * both numbers are read out of the file.
 *
 * AND IT IS THE ONE CONTAINER THAT ROUTINELY ARRIVES ENCRYPTED. A recording
 * off a pay-television tuner is scrambled at the transport layer, and the
 * result is a file whose structure parses perfectly and whose every frame is
 * noise. That is the worst output this tool could produce, so it is checked
 * for and refused by name.
 */

/* ========================================================================== *
 * Stream types
 * ========================================================================== */

/**
 * What the program map table's `stream_type` means.
 *
 * Four travel: 0x1B (H.264), 0x24 (H.265), 0x0F (AAC in ADTS) and the MPEG
 * audio types, whose LAYER decides whether they do - which is why they map to
 * `mp3` here and are corrected to `mp2` once a frame header has been read.
 * Layer III travels; Layer II is what European broadcasters use and does not.
 *
 * Everything else is named rather than lumped under "unknown", because the
 * refusal is the useful half of reading a format like this. "Your recording is
 * MPEG-2 video with Dolby Digital sound" is an answer; "unsupported" is not.
 */
function codecForStreamType(streamType: number): CodecId {
  switch (streamType) {
    case 0x01:
    case 0x02:
    case 0x80:
      return 'mpeg2video';
    case 0x03:
    case 0x04:
      return 'mp3';
    case 0x0f:
      return 'aac';
    case 0x10:
      return 'mpeg4part2';
    case 0x1b:
      return 'avc';
    case 0x24:
    case 0x27:
      return 'hevc';
    case 0x81:
    case 0x87:
    case 0x91:
      return 'ac3';
    case 0x1c:
    case 0x83:
      return 'pcm';
    default:
      /*
       * Including 0x11, which is AAC in LATM rather than in ADTS - a different
       * framing with the configuration in a StreamMuxConfig instead of in each
       * frame header. It is refused rather than read as ADTS, because reading
       * it as ADTS finds sync words inside the audio and produces frames that
       * are all the wrong length: sound that is present and is static.
       */
      return 'unknown';
  }
}

function kindForCodec(codec: CodecId): TrackKind {
  if (codec === 'avc' || codec === 'hevc' || codec === 'mpeg2video' || codec === 'mpeg4part2') {
    return 'video';
  }
  if (codec === 'aac' || codec === 'mp3' || codec === 'mp2' || codec === 'ac3' || codec === 'pcm') {
    return 'audio';
  }
  return 'other';
}

/** The four this tool can actually carry out of a transport stream. */
const CARRIABLE: ReadonlySet<CodecId> = new Set<CodecId>(['avc', 'hevc', 'aac', 'mp3']);

/* ========================================================================== *
 * The packet layer
 * ========================================================================== */

interface Walk {
  problem: string | null;
  scrambled: boolean;
}

/**
 * Whether any packet was scrambled, read through a function on purpose.
 *
 * `walk` is filled in by the passes below rather than returned from them, so a
 * bare second read of `walk.scrambled` after an early `if (walk.scrambled)`
 * looks statically impossible - the type checker narrows it to `false` and
 * cannot see that `eachPacket` sets it again. Reading it through a call is what
 * says "this is mutable state, checked at two points on purpose"; the two
 * points exist because the first refuses a wholly scrambled recording before
 * anything is allocated for it, and the second catches one whose tables were
 * in the clear.
 */
function wasScrambled(walk: Walk): boolean {
  return walk.scrambled;
}

interface Packet {
  readonly pid: number;
  readonly start: boolean;
  readonly from: number;
  readonly to: number;
}

/**
 * Every packet in the file, as a callback rather than as an array.
 *
 * A 200 MB transport stream is a million packets, and an array of a million
 * small objects is tens of megabytes of garbage in a tool whose whole point is
 * that it does not hold the file at all. The walk is run once per thing that
 * needs it instead - for the program tables, to measure each stream, and to
 * read each stream - and every pass is a scan of headers rather than of data,
 * through a window onto the file rather than over an array.
 *
 * LOSING THE PACKET GRID IS TREATED AS DAMAGE, NOT AS A REASON TO
 * RESYNCHRONISE. A transport stream whose 0x47s stop lining up is a file with
 * bytes missing from the middle, and hunting for the next plausible sync byte
 * inside compressed video finds one within a few hundred bytes - which
 * produces a reader that carries on confidently through nonsense and a result
 * that says nothing went wrong.
 */
function eachPacket(
  bytes: ByteSource,
  packetSize: number,
  firstSync: number,
  walk: Walk,
  visit: (packet: Packet) => void,
  /**
   * Checked once per block, and stops the walk when it answers true.
   *
   * For the one pass that does not need the whole file: the program tables
   * repeat, so a reader that has found them has no reason to walk the other
   * four gigabytes. Per BLOCK rather than per packet because that is the
   * granularity everything else here works at, and a few hundred extra packets
   * is not worth a branch in the innermost loop.
   */
  until?: () => boolean,
): void {
  /*
   * A BLOCK OF PACKETS PER READ, rather than a read per field.
   *
   * The five bytes this loop looks at are five reads through the source, and
   * an hour of broadcast is twenty million packets - so a hundred million
   * calls, each doing the window arithmetic again for a byte it has already
   * paid for. Pulling a block and indexing inside it does that arithmetic once
   * per forty-eight kilobytes instead, which is what keeps a walk over a
   * multi-gigabyte recording in the same order of magnitude as it was when the
   * whole file was an array.
   *
   * The block is deliberately far smaller than a window, so it is a view onto
   * one rather than an assembly across two.
   */
  const BLOCK_PACKETS = 256;
  let at = firstSync;

  while (at + 188 <= bytes.size) {
    const span = Math.min(BLOCK_PACKETS * packetSize, bytes.size - at);
    const block = bytes.view(at, span);
    let within = 0;

    while (within + 188 <= block.length) {
      const off = within;
      const base = at + off;
      within += packetSize;

      if (block[off] !== 0x47) {
        walk.problem = 'the packet grid stops lining up part of the way through';
        return;
      }
      const b1 = block[off + 1] ?? 0;
      const b3 = block[off + 3] ?? 0;

      // A packet the transmitter itself flagged as damaged: its payload is
      // whatever the demodulator guessed, so it is skipped rather than trusted.
      if ((b1 & 0x80) !== 0) {
        walk.problem = 'some packets arrived damaged and were left out';
        continue;
      }
      if ((b3 & 0xc0) !== 0) {
        walk.scrambled = true;
        continue;
      }

      const adaptation = (b3 >> 4) & 0x03;
      if (adaptation === 0 || adaptation === 2) continue; // neither carries payload

      let from = base + 4;
      if (adaptation === 3) {
        from += 1 + (block[off + 4] ?? 0);
        // An adaptation field longer than its own packet is the file lying
        // about its shape. Reading on would take payload from the one after.
        if (from > base + 188) continue;
      }

      visit({
        pid: ((b1 & 0x1f) << 8) | (block[off + 2] ?? 0),
        start: (b1 & 0x40) !== 0,
        from,
        to: base + 188,
      });
    }

    // `within` always advances by at least one packet, so this terminates.
    at += within;
    if (until?.() === true) return;
  }
}

/* ========================================================================== *
 * The program tables
 * ========================================================================== */

interface ElementaryStream {
  readonly pid: number;
  readonly codec: CodecId;
  readonly language: string | null;
}

interface Programs {
  readonly streams: readonly ElementaryStream[];
  /** How many programmes the multiplex held, of which the first was taken. */
  readonly programCount: number;
  /** Streams past `maxElementaryStreams`, which were never looked at. */
  readonly ignored: number;
}

/**
 * A PSI section, assembled from the packets that carry it.
 *
 * Sections are the one part of a transport stream with a length field, and the
 * length is twelve bits - so the whole thing is bounded at four kilobytes by
 * the format rather than by a limit chosen here. A section may still be split
 * across packets, which is why this exists at all: a program map table for a
 * multiplex with several streams and a descriptor on each will not fit in 184
 * bytes, and a reader that assumes one packet finds a truncated table and
 * reports a file with no tracks in it.
 */
class SectionReader {
  private buffer: number[] = [];
  private wanted = 0;

  /** The completed section, or null while there is more of it to come. */
  push(bytes: ByteSource, packet: Packet): Uint8Array | null {
    let from = packet.from;
    if (packet.start) {
      // A `pointer_field` says how many bytes of the PREVIOUS section trail
      // into this packet before the new one starts.
      from += 1 + bytes.u8(from);
      if (from >= packet.to) return null;
      this.buffer = [];
      this.wanted = 0;
    } else if (this.wanted === 0 && this.buffer.length === 0) {
      return null; // a continuation with no beginning
    }

    const run = bytes.view(from, packet.to - from);
    for (const byte of run) this.buffer.push(byte);

    if (this.wanted === 0) {
      if (this.buffer.length < 3) return null;
      this.wanted = 3 + (((this.buffer[1] ?? 0) & 0x0f) * 256 + (this.buffer[2] ?? 0));
      if (this.wanted > 4096) {
        this.buffer = [];
        this.wanted = 0;
        return null;
      }
    }
    if (this.buffer.length < this.wanted) return null;

    const done = Uint8Array.from(this.buffer.slice(0, this.wanted));
    this.buffer = [];
    this.wanted = 0;
    return done;
  }
}

/** An ISO 639 language, from the descriptor a broadcaster puts on a track. */
function languageDescriptor(section: Uint8Array, from: number, to: number): string | null {
  let at = from;
  while (at + 2 <= to) {
    const tag = section[at] ?? 0;
    const length = section[at + 1] ?? 0;
    if (at + 2 + length > to) return null;
    if (tag === 0x0a && length >= 3) {
      let text = '';
      for (let index = 0; index < 3; index += 1) {
        text += String.fromCharCode(section[at + 2 + index] ?? 0);
      }
      const trimmed = text.toLowerCase().trim();
      return trimmed === 'und' || trimmed === '' ? null : trimmed;
    }
    at += 2 + length;
  }
  return null;
}

/**
 * True when a stream of private type carries AC-3, per its own descriptor.
 *
 * Stream type 0x06 is "PES carrying private data" and says nothing at all, so
 * a DVB broadcaster's Dolby Digital track is indistinguishable from a subtitle
 * page or a teletext stream without reading the descriptors. Both AC-3
 * registration tags are checked - the type is refused either way, and the
 * point is only to name it correctly on the result rather than reporting an
 * unrecognised codec on a track the user knows perfectly well is the sound.
 */
function privateCodec(section: Uint8Array, from: number, to: number): CodecId {
  let at = from;
  while (at + 2 <= to) {
    const tag = section[at] ?? 0;
    const length = section[at + 1] ?? 0;
    if (at + 2 + length > to) return 'unknown';
    if (tag === 0x6a || tag === 0x7a) return 'ac3';
    if (tag === 0x59) return 'subtitle'; // DVB subtitling
    at += 2 + length;
  }
  return 'unknown';
}

/**
 * The first programme's elementary streams.
 *
 * ONE PROGRAMME, which is the same decision `selectTracks` makes about tracks
 * and for the same reason. A recording off a tuner holds one; a recording off
 * a whole multiplex can hold a dozen, and an MP4 has no way to express "here
 * are nine television channels". So the first travels, and the count is named
 * on the result - somebody who recorded the wrong thing finds out that their
 * file has nine channels in it, rather than wondering why the picture is a
 * programme they did not want.
 */
function readPrograms(bytes: ByteSource, packetSize: number, firstSync: number): Programs {
  const walk: Walk = { problem: null, scrambled: false };
  const patReader = new SectionReader();
  const pmtReaders = new Map<number, SectionReader>();
  let programPid: number | null = null;
  let programCount = 0;
  let streams: readonly ElementaryStream[] = [];
  let ignored = 0;

  eachPacket(
    bytes,
    packetSize,
    firstSync,
    walk,
    (packet) => {
      if (streams.length > 0) return;

      if (packet.pid === 0) {
        const section = patReader.push(bytes, packet);
        if (section === null || (section[0] ?? 0xff) !== 0x00) return;
        // An eight-byte header, then four bytes per programme, then a CRC.
        const end = section.length - 4;
        let found = 0;
        for (let at = 8; at + 4 <= end; at += 4) {
          const number = ((section[at] ?? 0) << 8) | (section[at + 1] ?? 0);
          // Programme number zero is the network information table rather than a
          // channel, and pointing the PMT reader at it finds no streams at all.
          if (number === 0) continue;
          found += 1;
          programPid ??= (((section[at + 2] ?? 0) & 0x1f) << 8) | (section[at + 3] ?? 0);
        }
        programCount = Math.max(programCount, found);
        if (programPid !== null && !pmtReaders.has(programPid)) {
          pmtReaders.set(programPid, new SectionReader());
        }
        return;
      }

      const reader = pmtReaders.get(packet.pid);
      if (reader === undefined) return;
      const section = reader.push(bytes, packet);
      if (section === null || (section[0] ?? 0xff) !== 0x02) return;

      const programInfoLength = (((section[10] ?? 0) & 0x0f) << 8) | (section[11] ?? 0);
      const end = section.length - 4;
      const found: ElementaryStream[] = [];
      let at = 12 + programInfoLength;

      while (at + 5 <= end) {
        const streamType = section[at] ?? 0;
        const pid = (((section[at + 1] ?? 0) & 0x1f) << 8) | (section[at + 2] ?? 0);
        const infoLength = (((section[at + 3] ?? 0) & 0x0f) << 8) | (section[at + 4] ?? 0);
        const infoFrom = at + 5;
        const infoTo = Math.min(infoFrom + infoLength, end);

        if (found.length >= LIMITS.maxElementaryStreams) {
          ignored += 1;
        } else {
          found.push({
            pid,
            codec:
              streamType === 0x06
                ? privateCodec(section, infoFrom, infoTo)
                : codecForStreamType(streamType),
            language: languageDescriptor(section, infoFrom, infoTo),
          });
        }

        at = infoFrom + infoLength;
      }

      if (found.length > 0) streams = found;
    },
    /*
     * The tables repeat every second or so, so once they have been read there
     * is nothing left in the file for this pass to learn - and a walk to the
     * end of a four-gigabyte recording to learn nothing is a whole pass over
     * it. Where they are never found the walk runs to the end, which is what
     * `readMpegTs` needs in order to tell "no tables" apart from "scrambled".
     */
    () => streams.length > 0,
  );

  return { streams, programCount: Math.max(programCount, streams.length > 0 ? 1 : 0), ignored };
}

/* ========================================================================== *
 * PES
 * ========================================================================== */

const PES_CLOCK = 90_000;
/** One full turn of the 33-bit clock, which is about 26 hours and 30 minutes. */
const PES_WRAP = 0x200000000;

/** A 33-bit timestamp spread over five bytes with a marker bit in each. */
function readTimestamp(bytes: ByteSource, at: number): number {
  return (
    ((bytes.u8(at) >> 1) & 0x07) * 0x40000000 +
    bytes.u8(at + 1) * 0x400000 +
    ((bytes.u8(at + 2) >> 1) & 0x7f) * 0x8000 +
    bytes.u8(at + 3) * 0x80 +
    ((bytes.u8(at + 4) >> 1) & 0x7f)
  );
}

interface PesHeader {
  /** Where the elementary-stream payload starts. */
  readonly payload: number;
  readonly pts: number | null;
  readonly dts: number | null;
}

function readPesHeader(bytes: ByteSource, from: number, to: number): PesHeader | null {
  if (from + 9 > to) return null;
  if (bytes.u8(from) !== 0 || bytes.u8(from + 1) !== 0 || bytes.u8(from + 2) !== 1) return null;

  const flags = bytes.u8(from + 7);
  const payload = from + 9 + bytes.u8(from + 8);
  if (payload > to) return null;

  const present = (flags >> 6) & 0x03;
  // 0b01 is reserved - a decode time with no presentation time cannot be
  // expressed - so a stream claiming it is read as having neither rather than
  // as having a decode time, which would put the frame at instant zero.
  const pts = present >= 2 && from + 14 <= to ? readTimestamp(bytes, from + 9) : null;
  const dts = present === 3 && from + 19 <= to ? readTimestamp(bytes, from + 14) : null;

  return { payload, pts, dts };
}

/**
 * A 33-bit clock unwrapped into a number that keeps going up.
 *
 * The clock turns over roughly every twenty-six and a half hours, which sounds
 * like something no file under this tool's size limit could reach - and that
 * misses the case that matters. A recording does not start at zero; it starts
 * wherever the transmitter's clock happened to be. So a two-minute capture
 * made shortly before a turnover contains one, and a reader that does not
 * unwrap it produces a file whose timestamps fall back by twenty-six hours in
 * the middle - which an MP4 writes as a video a day and a bit long that a
 * player shows as stopping after two minutes.
 */
class Clock {
  private last: number | null = null;
  private wraps = 0;

  unwrap(raw: number): number {
    if (this.last !== null && raw < this.last - PES_WRAP / 2) this.wraps += 1;
    this.last = raw;
    return raw + this.wraps * PES_WRAP;
  }

  /** The offset established by `unwrap`, for a time that did not set it. */
  applied(raw: number): number {
    const value = raw + this.wraps * PES_WRAP;
    // A presentation time can sit the other side of a turnover from the decode
    // time that established the offset, which is the one place a frame comes
    // out an entire clock period early.
    if (this.last === null) return value;
    return value + PES_WRAP / 2 < this.last + this.wraps * PES_WRAP ? value + PES_WRAP : value;
  }
}

/* ========================================================================== *
 * Gathering one access unit
 * ========================================================================== */

/**
 * The buffer one access unit is assembled in, reused for every frame.
 *
 * It grows rather than being sized for the worst case, because the worst case
 * is the whole stream: sizing it at the elementary stream's length would hold
 * a second copy of a 200 MB file to assemble frames a few kilobytes each. It
 * settles after the first large frame and is never reallocated again.
 */
class Unit {
  private buffer: Uint8Array;
  private length = 0;

  constructor(
    initial: number,
    private readonly cap: number,
  ) {
    this.buffer = new Uint8Array(Math.min(initial, cap));
  }

  reset(): void {
    this.length = 0;
  }

  /** False when the frame was larger than the cap, so the caller can refuse. */
  append(bytes: ByteSource, from: number, to: number): boolean {
    const wanted = this.length + Math.max(0, to - from);
    if (wanted > this.cap) return false;
    if (wanted > this.buffer.length) {
      const grown = new Uint8Array(Math.min(this.cap, Math.max(wanted, this.buffer.length * 2)));
      grown.set(this.buffer.subarray(0, this.length));
      this.buffer = grown;
    }
    this.buffer.set(bytes.view(from, to - from), this.length);
    this.length = wanted;
    return true;
  }

  view(): Uint8Array {
    return this.buffer.subarray(0, this.length);
  }
}

/**
 * The largest access unit this reader will assemble.
 *
 * A 4K intra-coded picture is a couple of megabytes and a 1080p one is a
 * fraction of that, so this is generous by an order of magnitude for anything
 * a real encoder produces. It exists because the alternative is a bound taken
 * from the file - and a hostile transport stream can withhold the start of the
 * next PES packet indefinitely, which turns "gather until the next frame
 * begins" into "gather the entire file into a second buffer".
 */
const MAX_ACCESS_UNIT_BYTES = 32 * 1024 * 1024;

/* ========================================================================== *
 * Reading one stream
 * ========================================================================== */

interface RawVideo {
  readonly media: ByteSource;
  readonly offset: readonly number[];
  readonly size: readonly number[];
  readonly dts: readonly number[];
  readonly pts: readonly number[];
  readonly sync: readonly number[];
  readonly config: VideoConfig | null;
  /** Access units holding only configuration, which are not frames. */
  readonly configOnly: number;
  /** Access units past what the measuring pass said this stream holds. */
  readonly oversized: number;
  /** Frames whose stated decode time went backwards and had to be clamped. */
  readonly backwards: number;
}

/**
 * Video: one PES packet is one access unit, which is one MP4 sample.
 *
 * That equivalence is the standard's own - a video PES packet is required to
 * hold exactly one access unit - and it is why no slice header has to be
 * parsed here to find frame boundaries. Doing it the other way, by looking for
 * the first slice of a new picture, means reading `first_mb_in_slice` out of
 * every slice in the file and getting the field-coded cases wrong.
 */
function readVideoStream(
  bytes: ByteSource,
  packetSize: number,
  firstSync: number,
  stream: ElementaryStream,
  payloadBytes: number,
  walk: Walk,
): RawVideo {
  const codec: AnnexBCodec = stream.codec === 'avc' ? 'avc' : 'hevc';
  /*
   * THE FOURTH COPY, WHICH IS NO LONGER A COPY OF THE FILE.
   *
   * A transport stream's frames are not contiguous - one picture is sprayed
   * across dozens of 188-byte packets with a header in the middle of each - so
   * unlike an MP4 or a Matroska, there is nothing in the input to point the
   * sample table at and the frames have to be gathered. This used to allocate
   * `reframedCeiling(payloadBytes)` in one go, which for an hour of broadcast
   * is two to four gigabytes and is the single reason a tuner recording could
   * not be read at all.
   *
   * It goes into a sink instead: small streams stay in memory exactly as
   * before, and a large one is handed to blob storage as it fills. What comes
   * back is something the writer indexes the same way it indexes the file.
   */
  const media = createByteSink({ spill: canWindowBlobs() });
  /*
   * Reframing needs somewhere contiguous to put ONE access unit, and the
   * reframed unit is a little larger than the Annex B one it came from. Grown
   * to fit and reused, so a stream of a hundred thousand frames allocates this
   * a handful of times rather than a hundred thousand.
   */
  let scratch = new Uint8Array(0);
  /*
   * STILL BOUNDED BY A MEASUREMENT, which is the guarantee the buffer used to
   * give by being allocated up front. The measuring pass totalled the real PES
   * payload on this stream, and re-framing cannot turn that into more than
   * `reframedCeiling` of it - so a file that keeps claiming frames stops here
   * rather than filling blob storage.
   */
  const capacity = reframedCeiling(payloadBytes);
  const offset: number[] = [];
  const size: number[] = [];
  const dts: number[] = [];
  const pts: number[] = [];
  const sync: number[] = [];

  const parameterSets = new ParameterSets(codec);
  const clock = new Clock();
  const unit = new Unit(256 * 1024, MAX_ACCESS_UNIT_BYTES);

  let written = 0;
  let configOnly = 0;
  let oversized = 0;
  let backwards = 0;
  let started = false;
  let overflowed = false;
  let unitPts: number | null = null;
  let unitDts: number | null = null;

  const flush = (): void => {
    if (!started) return;
    if (overflowed) {
      oversized += 1;
      return;
    }
    if (offset.length >= LIMITS.maxSamplesPerTrack) return;

    const view = unit.view();
    if (view.length === 0) return;
    const nals = splitAnnexB(view, 0, view.length);
    parameterSets.observe(view, nals);

    const room = reframedCeiling(view.length);
    if (scratch.byteLength < room) scratch = new Uint8Array(room);
    const framed = reframeInto(scratch, 0, view, nals, codec);
    if (framed.empty) {
      /*
       * An access unit of nothing but parameter sets, which is what a
       * broadcast emits at a channel change and what a recorder emits at the
       * top of a file. It is not a frame, and giving it a timestamp would put
       * a zero-length picture into the middle of the film - which shows up as
       * a single dropped frame, so it is counted and reported rather than
       * silently swallowed.
       */
      configOnly += 1;
      return;
    }

    /*
     * DECODE TIMES CLAMPED MONOTONIC, which the audio path already does and
     * this one did not.
     *
     * A conforming stream states them in decode order and they only go up. A
     * damaged one - a recording spliced from two sources, a file with a chunk
     * missing - can state a time earlier than the frame before it, and `stts`
     * holds the gap between consecutive samples: a negative gap is written out
     * as zero, which is a frame of no duration. A run of those is a passage
     * that flashes past at the speed the player can decode it, in a file that
     * is otherwise perfect. So the time is pushed forward by one tick instead,
     * and the fact that it had to be is reported.
     */
    const decode = clock.unwrap(unitDts ?? unitPts ?? 0);
    const shown = clock.applied(unitPts ?? unitDts ?? 0);
    const previous = dts.at(-1);
    const monotonic = previous === undefined ? decode : Math.max(decode, previous + 1);
    if (monotonic !== decode) backwards += 1;

    if (written + framed.written > capacity) {
      oversized += 1;
      return;
    }

    offset.push(written);
    size.push(framed.written);
    dts.push(monotonic);
    pts.push(Math.max(shown, monotonic));
    sync.push(framed.sync ? 1 : 0);
    media.write(scratch.subarray(0, framed.written));
    written += framed.written;
  };

  eachPacket(bytes, packetSize, firstSync, walk, (packet) => {
    if (packet.pid !== stream.pid) return;

    if (packet.start) {
      flush();
      const header = readPesHeader(bytes, packet.from, packet.to);
      if (header === null) {
        started = false;
        return;
      }
      started = true;
      overflowed = false;
      unit.reset();
      unitPts = header.pts;
      unitDts = header.dts;
      if (!unit.append(bytes, header.payload, packet.to)) overflowed = true;
      return;
    }

    if (!started || overflowed) return;
    if (!unit.append(bytes, packet.from, packet.to)) overflowed = true;
  });

  flush();

  return {
    media: media.source(),
    offset,
    size,
    dts,
    pts,
    sync,
    config: parameterSets.describe(),
    configOnly,
    oversized,
    backwards,
  };
}

interface Anchor {
  readonly offset: number;
  readonly pts: number;
}

interface RawAudio {
  readonly media: ByteSource;
  readonly frames: readonly AudioFrame[];
  readonly anchors: readonly Anchor[];
  readonly sampleRate: number;
  readonly channels: number;
  readonly samplesPerFrame: number;
  readonly codec: CodecId;
  readonly config: Uint8Array | null;
  readonly resynced: boolean;
}

/**
 * Audio: the whole stream gathered, then walked by frame header.
 *
 * WHY NOT PACKET BY PACKET, which is how the video above is read. A video PES
 * packet holds exactly one access unit; an audio one holds whatever fitted -
 * four and a half AAC frames, with the half finishing in the next packet. So
 * splitting inside each packet loses the straddling frame, and there is one
 * every packet or two. That is audio which is slightly and continuously wrong,
 * plays perfectly, and nobody reports.
 *
 * The timestamps are kept as ANCHORS rather than applied per frame, because a
 * PES header states one time for a group of frames and the frames inside it
 * are consecutive rather than simultaneous. See `projectAudioTimes` for what
 * the anchors are then used for, which is not what it looks like.
 */
function readAudioStream(
  bytes: ByteSource,
  packetSize: number,
  firstSync: number,
  stream: ElementaryStream,
  payloadBytes: number,
  walk: Walk,
): RawAudio | null {
  const media = createByteSink({ spill: canWindowBlobs() });
  const anchors: Anchor[] = [];
  const clock = new Clock();
  let written = 0;

  eachPacket(bytes, packetSize, firstSync, walk, (packet) => {
    if (packet.pid !== stream.pid) return;
    let from = packet.from;

    if (packet.start) {
      const header = readPesHeader(bytes, packet.from, packet.to);
      if (header === null) return;
      from = header.payload;
      if (header.pts !== null) anchors.push({ offset: written, pts: clock.unwrap(header.pts) });
    }

    // Bounded by the measuring pass, which is what stops a file that keeps
    // claiming payload from gathering more than it actually holds.
    const room = Math.min(packet.to - from, payloadBytes - written);
    if (room <= 0) return;
    media.write(bytes.view(from, room));
    written += room;
  });

  if (written === 0 || anchors.length === 0) return null;
  const gathered = media.source();

  if (stream.codec === 'aac') {
    const split = splitAdts(gathered, LIMITS.maxSamplesPerTrack);
    if (split === null) return null;
    return {
      media: gathered,
      frames: split.frames,
      anchors,
      sampleRate: split.sampleRate,
      channels: split.channels,
      samplesPerFrame: split.samplesPerFrame,
      codec: 'aac',
      config: split.config,
      resynced: split.resynced,
    };
  }

  const split = splitMpegAudio(gathered, LIMITS.maxSamplesPerTrack);
  if (split === null) return null;
  return {
    media: gathered,
    frames: split.frames,
    anchors,
    sampleRate: split.sampleRate,
    channels: split.channels,
    samplesPerFrame: split.samplesPerFrame,
    // The layer is in the frame header rather than in the program map table,
    // so this is the first point at which a broadcaster's Layer II can be told
    // apart from an ordinary MP3 - and only one of the two travels.
    codec: split.layer === 3 ? 'mp3' : 'mp2',
    config: null,
    resynced: split.resynced,
  };
}

/* ========================================================================== *
 * Timestamps for audio frames
 * ========================================================================== */

interface AudioTimes {
  readonly dts: readonly number[];
  /** Anchors that disagreed with the projection: real gaps in the recording. */
  readonly gaps: number;
}

/**
 * Each frame's time, projected from the last anchor that agreed with it.
 *
 * The stream states a time every PES packet and each frame is a fixed number
 * of samples long, so there are two sources for a frame's timestamp and they
 * disagree by a tick or two constantly. 1024 samples at 44.1 kHz is 2089.796
 * ticks of a 90 kHz clock, so the encoder rounds, and the rounding alternates.
 *
 * Taking the stated time per frame produces a `stts` with a separate entry for
 * almost every frame - a megabyte of table on an hour of audio - to express
 * jitter that is not in the sound. Taking the projection alone would ignore a
 * real dropout, and sliding every later frame earlier by the length of the
 * hole takes the sound out of step with the picture for the rest of the film.
 * So the projection runs, and an anchor disagreeing with it by more than two
 * frames is treated as a genuine discontinuity and restarts it: uniform where
 * the stream is uniform, honest where it is not, and counted either way.
 */
function projectAudioTimes(raw: RawAudio, timescale: number): AudioTimes {
  const dts: number[] = [];
  const tolerance = raw.samplesPerFrame * 2;
  const inTicks = (pts: number): number => Math.round((pts * timescale) / PES_CLOCK);

  let anchorIndex = 0;
  let base = inTicks(raw.anchors[0]?.pts ?? 0);
  let baseFrame = 0;
  let gaps = 0;

  for (const [index, frame] of raw.frames.entries()) {
    while (
      anchorIndex + 1 < raw.anchors.length &&
      (raw.anchors[anchorIndex + 1]?.offset ?? Number.POSITIVE_INFINITY) <= frame.offset
    ) {
      anchorIndex += 1;
      const stated = inTicks(raw.anchors[anchorIndex]?.pts ?? 0);
      const projected = base + (index - baseFrame) * raw.samplesPerFrame;
      if (Math.abs(stated - projected) > tolerance) {
        base = stated;
        baseFrame = index;
        gaps += 1;
      }
    }
    // Monotonic whatever the anchors said: an `stts` delta cannot be negative,
    // and a stream that steps backwards would otherwise write one.
    dts.push(
      Math.max(base + (index - baseFrame) * raw.samplesPerFrame, (dts[index - 1] ?? -1) + 1),
    );
  }

  return { dts, gaps };
}

/* ========================================================================== *
 * Tracks
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
 * A track named from the program map table, with no samples read.
 *
 * A transport stream's tables name every stream's codec and language, so a
 * stream this tool is going to refuse can be reported without being read at
 * all. That is a memory decision as much as a speed one: a broadcast recording
 * routinely carries MPEG-2 video with Dolby Digital, and gathering both to
 * build tracks that are then named in a warning and discarded would allocate
 * the whole file over again for nothing.
 */
function namedTrack(number: number, stream: ElementaryStream): SourceTrack {
  return {
    number,
    kind: kindForCodec(stream.codec),
    codec: stream.codec,
    timescale: PES_CLOCK,
    width: null,
    height: null,
    channels: null,
    sampleRate: null,
    language: stream.language,
    sampleEntry: null,
    codecPrivate: null,
    matrix: null,
    edits: [],
    media: null,
    samples: EMPTY_TABLE,
  };
}

function videoTrack(number: number, stream: ElementaryStream, raw: RawVideo): SourceTrack {
  const gaps: number[] = [];
  for (let index = 1; index < raw.dts.length; index += 1) {
    gaps.push((raw.dts[index] ?? 0) - (raw.dts[index - 1] ?? 0));
  }
  // The last sample's duration, which no delta can measure. The previous gap
  // is what a muxer uses; 25 frames a second is the fallback for a stream with
  // exactly one frame in it, and is only ever the length of that one frame.
  const lastDuration = Math.max(1, gaps.at(-1) ?? Math.round(PES_CLOCK / 25));

  /*
   * A stream with no random-access picture in it at all, which is what a
   * capture that began mid-GOP and never reached another keyframe looks like.
   *
   * The first sample is marked instead, and which way the error points is the
   * whole reason. An EMPTY `stss` says nothing in the track is seekable, and a
   * player asked to scrub one either refuses or jumps to the start. Marking
   * the first sample says the one thing that is certainly true - that the
   * beginning is a place to start decoding. Over-reporting, by claiming every
   * frame is seekable, is the direction that produces a file which plays
   * perfectly and cannot be scrubbed.
   */
  const sync = raw.sync.some((flag) => flag === 1)
    ? [...raw.sync]
    : raw.sync.map((_flag, at) => (at === 0 ? 1 : 0));

  return {
    number,
    kind: 'video',
    codec: stream.codec,
    timescale: PES_CLOCK,
    width: raw.config?.width ?? null,
    height: raw.config?.height ?? null,
    channels: null,
    sampleRate: null,
    language: stream.language,
    sampleEntry: null,
    codecPrivate: raw.config?.config ?? null,
    /*
     * A transport stream has no display matrix and no edit list. There is
     * nowhere in the format for a rotation to be written, so a portrait clip
     * recorded to one arrives with nothing at all to say it is portrait - and
     * that is a real gap rather than an omission here, named in the README
     * because it is the same failure the phone `.mov` case was about, arrived
     * at from the other side.
     */
    matrix: null,
    edits: [],
    media: raw.media,
    samples: {
      count: raw.offset.length,
      offset: raw.offset,
      size: raw.size,
      dts: raw.dts,
      cts: raw.pts,
      sync,
      lastDuration,
    },
  };
}

function audioTrack(
  number: number,
  stream: ElementaryStream,
  raw: RawAudio,
  timescale: number,
  dts: readonly number[],
): SourceTrack {
  return {
    number,
    kind: 'audio',
    codec: raw.codec,
    timescale,
    width: null,
    height: null,
    channels: raw.channels,
    sampleRate: raw.sampleRate,
    language: stream.language,
    sampleEntry: null,
    codecPrivate: raw.config,
    matrix: null,
    edits: [],
    media: raw.media,
    samples: {
      count: raw.frames.length,
      offset: raw.frames.map((frame) => frame.offset),
      size: raw.frames.map((frame) => frame.size),
      dts,
      cts: dts,
      sync: raw.frames.map(() => 1),
      lastDuration: raw.samplesPerFrame,
    },
  };
}

/* ========================================================================== *
 * Where zero is
 * ========================================================================== */

/**
 * Every track moved so the earliest sample in the FILE lands at zero, with
 * what is left over written as an edit list.
 *
 * THIS IS THE FUNCTION THAT KEEPS THE SOUND IN STEP, and it is worth reading
 * before believing the other two readers do not need it.
 *
 * An MP4's sample table has no field for where a track starts. `stts` holds
 * the gap between one sample and the next, so the first sample is at media
 * time zero by construction and any offset in front of it is not expressible
 * there at all. That does not matter for MP4 or for Matroska, where every
 * track starts at zero anyway - and it matters enormously here, because a
 * transport stream's timestamps start wherever the transmitter's clock was and
 * its streams do not start together. Audio commonly leads video by a fraction
 * of a second; a tuner recording can have half a second between them.
 *
 * Dropping that difference produces a file with both tracks starting at zero.
 * It plays, it is the right length, and the sound is out of step with the
 * picture by exactly the offset that was discarded, for the whole film. That
 * is a plausible wrong answer of the worst kind, because it presents as a bad
 * encode rather than as a bad remux.
 *
 * So the earliest decode time in the file is subtracted from every track,
 * which preserves the differences between them, and each track's own
 * remaining offset is written as an edit list: an empty edit of that length,
 * and then the media. TWO entries and not one - an `elst` holding only an
 * empty edit says "show nothing for a while, and then nothing else".
 *
 * The presentation times are shifted here too, and for the same reason the
 * Matroska reader shifts them: `ctts` version 0 cannot express a frame shown
 * before the moment it decodes, and a stream is entitled to state one. One
 * shift for every track, so it cannot move sound relative to picture.
 */
function normalise(tracks: readonly SourceTrack[]): SourceTrack[] {
  const withSamples = tracks.filter((track) => track.samples.count > 0);
  if (withSamples.length === 0) return [...tracks];

  let delay = 0;
  for (const track of withSamples) {
    for (let index = 0; index < track.samples.count; index += 1) {
      const decode = track.samples.dts[index] ?? 0;
      const shown = track.samples.cts[index] ?? decode;
      // In the track's own ticks; converted to seconds so one number can be
      // compared across tracks with different timescales.
      delay = Math.max(delay, (decode - shown) / Math.max(1, track.timescale));
    }
  }

  const earliest = Math.min(
    ...withSamples.map((track) => (track.samples.dts[0] ?? 0) / Math.max(1, track.timescale)),
  );

  return tracks.map((track) => {
    if (track.samples.count === 0) return track;
    const scale = Math.max(1, track.timescale);
    const first = track.samples.dts[0] ?? 0;
    const ownDelay = Math.ceil(delay * scale);

    const samples: SampleTable = {
      ...track.samples,
      dts: track.samples.dts.map((at) => at - first),
      cts: track.samples.cts.map((at) => at + ownDelay - first),
    };

    // What is left of this track's start once the file's own zero is removed.
    const offsetTicks = first - Math.round(earliest * scale);
    if (offsetTicks <= 0) return { ...track, samples };

    const mediaTicks = (samples.dts[samples.count - 1] ?? 0) + samples.lastDuration;
    // The movie timescale for a transport stream is the stream's own 90 kHz
    // clock, so an offset in track ticks converts by ratio alone.
    const toMovie = PES_CLOCK / scale;
    const edits: Edit[] = [
      {
        segmentDuration: Math.round(offsetTicks * toMovie),
        mediaTime: -1,
        mediaRateInteger: 1,
        mediaRateFraction: 0,
      },
      {
        segmentDuration: Math.round(mediaTicks * toMovie),
        mediaTime: 0,
        mediaRateInteger: 1,
        mediaRateFraction: 0,
      },
    ];

    return { ...track, samples, edits };
  });
}

/* ========================================================================== *
 * Entry point
 * ========================================================================== */

/** The PES payload bytes on each PID, measured before anything is allocated. */
function measure(
  bytes: ByteSource,
  packetSize: number,
  firstSync: number,
  wanted: ReadonlySet<number>,
  walk: Walk,
): Map<number, number> {
  const totals = new Map<number, number>();
  eachPacket(bytes, packetSize, firstSync, walk, (packet) => {
    if (!wanted.has(packet.pid)) return;
    totals.set(packet.pid, (totals.get(packet.pid) ?? 0) + (packet.to - packet.from));
  });
  return totals;
}

function refuseScrambled<T>(): ToolResult<T> {
  return fail('unsupported-type', 'That recording is encrypted.', {
    detail:
      'Its packets are scrambled at the transport layer, which is what a recording off a pay-television tuner is. The structure reads perfectly and every frame inside it is noise - so repackaging it would produce a file that looks completely normal and plays static. Nothing short of the decryption key helps, and this tool has no business holding one.',
  });
}

function flavourFor(packetSize: number): string {
  return packetSize === 192 ? 'MPEG-TS (AVCHD)' : 'MPEG-TS';
}

function multiplexNote(programs: Programs): string[] {
  if (programs.programCount <= 1) return [];
  return [
    `${String(programs.programCount - 1)} other ${programs.programCount === 2 ? 'programme' : 'programmes'} in the multiplex`,
  ];
}

/** A file whose streams are all named and none of which could travel. */
function named(
  packetSize: number,
  tracks: readonly SourceTrack[],
  programs: Programs,
  problem: string | null,
): SourceFile {
  return {
    container: 'mpegts',
    flavour: flavourFor(packetSize),
    timescale: PES_CLOCK,
    durationSeconds: null,
    tracks: [...tracks],
    metadata: multiplexNote(programs),
    problem,
    reframed: false,
  };
}

export function readMpegTs(bytes: ByteSource): ToolResult<SourceFile> {
  // Detection reads the first few kilobytes and no more - the bound belongs to
  // `lib/sniff`, which has to give the same verdict from a 4 kB slice.
  const layout = detectTransportStream(bytes.view(0, LIMITS.tsScanBytes));
  if (layout === null) {
    return fail('parse-error', 'That file starts like a transport stream and then does not.', {
      detail:
        'A transport stream is a grid of 188-byte packets, each beginning with 0x47. This one loses the grid immediately.',
    });
  }

  const { packetSize, firstSync } = layout;
  const walk: Walk = { problem: null, scrambled: false };
  const programs = readPrograms(bytes, packetSize, firstSync);

  if (programs.streams.length === 0) {
    // The tables are the first thing a scrambled recording still has, so a
    // file with none of them has to be checked for scrambling before it can be
    // told it has no tables: the two produce the same symptom.
    eachPacket(bytes, packetSize, firstSync, walk, () => undefined);
    if (wasScrambled(walk)) return refuseScrambled();
    return fail('parse-error', 'That transport stream does not say what is in it.', {
      detail:
        'A recording carries a program map table naming its streams, and this file has none that could be read. A fragment cut out of the middle of a stream can be missing it entirely - the tables repeat, but not in every packet.',
    });
  }

  const wanted = new Set(
    programs.streams.filter((stream) => CARRIABLE.has(stream.codec)).map((stream) => stream.pid),
  );
  const payloads = measure(bytes, packetSize, firstSync, wanted, walk);
  if (wasScrambled(walk)) return refuseScrambled();

  const tracks: SourceTrack[] = [];
  // Streams whose frames were found and whose decoder configuration was not,
  // which is a different thing from a stream with no frames in it and has to
  // be said differently. See the refusal below.
  const unconfigured: CodecId[] = [];
  let configOnly = 0;
  let oversized = 0;
  let backwards = 0;
  let gaps = 0;
  let resynced = false;

  for (const [index, stream] of programs.streams.entries()) {
    if (tracks.length >= LIMITS.maxTracks) break;
    const number = index + 1;
    const payloadBytes = payloads.get(stream.pid) ?? 0;

    if (!wanted.has(stream.pid) || payloadBytes === 0) {
      tracks.push(namedTrack(number, stream));
      continue;
    }

    if (kindForCodec(stream.codec) === 'video') {
      const raw = readVideoStream(bytes, packetSize, firstSync, stream, payloadBytes, walk);
      configOnly += raw.configOnly;
      oversized += raw.oversized;
      backwards += raw.backwards;
      // No configuration record means no decoder can start. The track is
      // reported without samples, so `remux` says which track and why in the
      // same words it uses for a Matroska file missing its `CodecPrivate`.
      if (raw.offset.length === 0 || raw.config === null) {
        if (raw.offset.length > 0) unconfigured.push(stream.codec);
        tracks.push(namedTrack(number, stream));
        continue;
      }
      tracks.push(videoTrack(number, stream, raw));
      continue;
    }

    const raw = readAudioStream(bytes, packetSize, firstSync, stream, payloadBytes, walk);
    if (raw === null) {
      tracks.push(namedTrack(number, stream));
      continue;
    }
    resynced = resynced || raw.resynced;
    const timescale = raw.sampleRate > 0 ? raw.sampleRate : PES_CLOCK;
    const times = projectAudioTimes(raw, timescale);
    gaps += times.gaps;
    tracks.push(audioTrack(number, stream, raw, timescale, times.dts));
  }

  if (wasScrambled(walk)) return refuseScrambled();

  if (tracks.every((track) => track.samples.count === 0)) {
    /*
     * A FILE READ PERFECTLY WELL THAT HOLDS NOTHING AN MP4 CAN TAKE IS NOT A
     * PARSE FAILURE, and getting this wrong was the first thing the tests
     * found. A tuner recording of MPEG-2 video with Dolby Digital sound has
     * neither stream read - both are refused from the tables, so `wanted` is
     * empty and no samples exist - and reporting "this stream carries no
     * frames" describes the reader rather than the file.
     *
     * So it is returned as a `SourceFile` with its tracks named, and `remux`
     * refuses it in terms of the codecs it found. That is the message worth
     * having: somebody holding a recording that will not play wants to be told
     * it is MPEG-2, not that its frames could not be located.
     */
    if (wanted.size === 0) {
      return ok(named(packetSize, tracks, programs, walk.problem));
    }
    /*
     * FRAMES FOUND, AND NOTHING SAYING HOW TO DECODE THEM, which is a
     * different file from one with no frames in it - and saying "this stream
     * carries no frames" about it describes the reader rather than the input.
     *
     * It is also the single most likely thing to be wrong with a real capture,
     * which is what makes the distinction worth the branch. A transport stream
     * repeats its parameter sets every second or so and a recording begins
     * wherever somebody pressed a button, so a very short clip cut from the
     * middle of one can genuinely contain nothing but slices. The advice is
     * therefore actionable rather than decorative: a longer piece of the same
     * recording will have the parameter sets in it.
     */
    if (unconfigured.length > 0) {
      return fail('parse-error', 'That recording never says how to decode itself.', {
        detail: `Its ${unconfigured.map((codec) => CODECS[codec].label).join(' and ')} frames are all there, and the parameter sets a decoder needs to start on them are not in this file. A transport stream repeats those every second or so, so a clip cut from the middle of one can miss them entirely - a longer piece of the same recording will have them. Writing the track anyway would produce a file that looks complete and shows nothing.`,
      });
    }
    return fail('parse-error', 'That transport stream names its streams and carries no frames.', {
      detail:
        walk.problem === null
          ? 'Its program map table was readable and no frames followed it. A recording started and stopped inside a second looks like this, and so does a fragment holding only the tables.'
          : `While reading it, ${walk.problem}.`,
    });
  }

  const normalised = normalise(tracks);

  const problems: string[] = [];
  if (walk.problem !== null) problems.push(walk.problem);
  if (oversized > 0) {
    problems.push(
      `${String(oversized)} frames were larger than this tool will assemble and were left out`,
    );
  }
  if (configOnly > 0) {
    problems.push(
      `${String(configOnly)} ${configOnly === 1 ? 'unit held' : 'units held'} only decoder configuration and ${configOnly === 1 ? 'was' : 'were'} not written as frames`,
    );
  }
  if (backwards > 0) {
    problems.push(
      `${String(backwards)} ${backwards === 1 ? 'frame states a decode time' : 'frames state decode times'} earlier than the frame before, which is what a recording spliced out of two sources looks like`,
    );
  }
  if (gaps > 0) {
    problems.push(
      `the audio timestamps jump ${String(gaps)} ${gaps === 1 ? 'time' : 'times'}, which is what a recording with dropped packets looks like`,
    );
  }
  if (resynced) {
    problems.push('the audio had to be resynchronised, so some frames were skipped');
  }
  if (programs.ignored > 0) {
    problems.push(
      `${String(programs.ignored)} elementary streams past this tool's limit were not looked at`,
    );
  }

  return ok({
    container: 'mpegts',
    flavour: flavourFor(packetSize),
    timescale: PES_CLOCK,
    /*
     * A transport stream does not state its own duration anywhere. There is no
     * header to put it in, because a broadcast has no end - so the only
     * available answer is where the last sample lands, which `remux` works out
     * from the tracks for exactly this reason.
     */
    durationSeconds: null,
    tracks: normalised,
    metadata: multiplexNote(programs),
    problem: problems.length === 0 ? null : problems.join(', and '),
    reframed: normalised.some((track) => track.kind === 'video' && track.samples.count > 0),
  });
}
