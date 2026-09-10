/**
 * AUDIO FRAMES OUT OF A STREAM THAT IS NOT INDEXED.
 *
 * MP4 wants one sample per audio frame, separately indexed, with a start, a
 * length and a time. Neither of the two containers added later hands over
 * anything of the sort:
 *
 *   - A transport stream delivers audio in PES packets whose boundaries have
 *     nothing to do with frame boundaries. One packet holds four and a half
 *     AAC frames, and the half finishes in the next one.
 *   - An AVI stores audio in chunks whose sizes were chosen by the interleaver
 *     rather than by the codec, so an MP3 frame routinely straddles two.
 *
 * In both cases the only thing that says where a frame ends is the frame
 * itself. So both formats are read the same way: gather the payload, then walk
 * it by frame headers.
 *
 * THE FAILURE THIS AVOIDS is the one the Matroska lacing note already names,
 * arrived at from the other direction. Treating a PES packet or an AVI chunk
 * as one sample produces a track with all the audio in it and a fraction of
 * the timestamps - which writes out perfectly, plays, and is the wrong length
 * at the wrong speed. Splitting on the wrong boundary is worse still: the
 * frames are sliced across samples and the result is noise, which at least
 * nobody mistakes for success.
 */

/* ========================================================================== *
 * MPEG-1 and MPEG-2 audio: Layer I, II and III
 * ========================================================================== */

/**
 * The bitrate tables, indexed the way the header indexes them.
 *
 * Five rows rather than six, because Layer II and Layer III share the MPEG-2
 * table. Index 0 is "free format" and index 15 is forbidden; both are left as
 * zero, and a zero bitrate is what makes `mpegAudioFrame` refuse - a frame
 * whose length cannot be computed is a frame the walk cannot step over, and
 * guessing one would resynchronise the reader somewhere inside the audio.
 */
const MPEG_BITRATES: Readonly<Record<string, readonly number[]>> = {
  '1-1': [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448, 0],
  '1-2': [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, 0],
  '1-3': [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0],
  '2-1': [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256, 0],
  '2-2': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0],
};

const MPEG_RATES: Readonly<Record<number, readonly number[]>> = {
  3: [44_100, 48_000, 32_000], // MPEG-1
  2: [22_050, 24_000, 16_000], // MPEG-2
  0: [11_025, 12_000, 8_000], // MPEG-2.5
};

export interface MpegAudioFrame {
  readonly length: number;
  readonly sampleRate: number;
  readonly channels: number;
  /** 1, 2 or 3. Only Layer III travels; the other two are refused by name. */
  readonly layer: number;
  readonly samplesPerFrame: number;
}

/**
 * One MPEG audio frame header, or null if there is not one here.
 *
 * Read strictly. Every reserved combination is refused rather than defaulted,
 * because this function is also the resynchroniser: after a damaged region the
 * walk below scans for the next byte pair that looks like a header, and a
 * lenient reader finds one in the middle of the audio data almost immediately.
 * Eleven bits of sync are only eleven bits, so the check has to be everything
 * else in the header as well.
 */
export function mpegAudioFrame(bytes: Uint8Array, at: number): MpegAudioFrame | null {
  if (at + 4 > bytes.length) return null;
  const b0 = bytes[at] ?? 0;
  const b1 = bytes[at + 1] ?? 0;
  const b2 = bytes[at + 2] ?? 0;
  const b3 = bytes[at + 3] ?? 0;

  if (b0 !== 0xff || (b1 & 0xe0) !== 0xe0) return null;

  const version = (b1 >> 3) & 0x03;
  if (version === 1) return null; // reserved
  const layerBits = (b1 >> 1) & 0x03;
  if (layerBits === 0) return null; // reserved
  const layer = 4 - layerBits;

  const bitrateIndex = (b2 >> 4) & 0x0f;
  const rateIndex = (b2 >> 2) & 0x03;
  if (rateIndex === 3) return null; // reserved
  const padding = (b2 >> 1) & 0x01;

  const table =
    version === 3
      ? MPEG_BITRATES[`1-${String(layer)}`]
      : MPEG_BITRATES[layer === 1 ? '2-1' : '2-2'];
  const bitrate = (table?.[bitrateIndex] ?? 0) * 1000;
  const sampleRate = MPEG_RATES[version]?.[rateIndex] ?? 0;
  if (bitrate === 0 || sampleRate === 0) return null;

  // Layer III at MPEG-2 or 2.5 is a half-size frame, which is the one number
  // here that is easy to get wrong and produces audio at double speed.
  const samplesPerFrame = layer === 1 ? 384 : layer === 3 && version !== 3 ? 576 : 1152;
  const length =
    layer === 1
      ? (Math.floor((12 * bitrate) / sampleRate) + padding) * 4
      : Math.floor((samplesPerFrame / 8) * (bitrate / sampleRate)) + padding;
  if (length < 4) return null;

  return {
    length,
    sampleRate,
    channels: ((b3 >> 6) & 0x03) === 3 ? 1 : 2,
    layer,
    samplesPerFrame,
  };
}

export interface AudioFrame {
  readonly offset: number;
  readonly size: number;
}

export interface AudioSplit {
  readonly frames: readonly AudioFrame[];
  readonly sampleRate: number;
  readonly channels: number;
  readonly samplesPerFrame: number;
  /** 3 for Layer III, which travels. 1 or 2 do not. */
  readonly layer: number;
  /** True where the walk had to skip bytes to find the next header. */
  readonly resynced: boolean;
}

/**
 * Every MPEG audio frame in a buffer, by walking header to header.
 *
 * Where a header does not validate the walk advances ONE BYTE and tries again,
 * which is the only way to get past an ID3 tag, a Xing header's padding or a
 * damaged region without knowing in advance which it was. That is bounded by
 * the length of the buffer, and the fact that it happened is carried out in
 * `resynced` so the caller can say the file was damaged rather than quietly
 * producing a shorter track than the file holds.
 */
export function splitMpegAudio(bytes: Uint8Array, limit: number): AudioSplit | null {
  const frames: AudioFrame[] = [];
  let sampleRate = 0;
  let channels = 2;
  let samplesPerFrame = 1152;
  let layer = 3;
  let resynced = false;
  let at = 0;

  while (at + 4 <= bytes.length && frames.length < limit) {
    const frame = mpegAudioFrame(bytes, at);
    if (frame === null) {
      resynced = true;
      at += 1;
      continue;
    }
    // A frame that runs past the buffer is a truncated last frame. Writing it
    // would index bytes that are not there; the caller learns from `resynced`.
    if (at + frame.length > bytes.length) {
      resynced = true;
      break;
    }
    if (sampleRate === 0) {
      sampleRate = frame.sampleRate;
      channels = frame.channels;
      samplesPerFrame = frame.samplesPerFrame;
      layer = frame.layer;
    }
    frames.push({ offset: at, size: frame.length });
    at += frame.length;
  }

  if (frames.length === 0) return null;
  return { frames, sampleRate, channels, samplesPerFrame, layer, resynced };
}

/* ========================================================================== *
 * AAC in ADTS, which is how a transport stream carries it
 * ========================================================================== */

const AAC_SAMPLE_RATES: readonly number[] = [
  96_000, 88_200, 64_000, 48_000, 44_100, 32_000, 24_000, 22_050, 16_000, 12_000, 11_025, 8_000,
  7_350,
];

interface AdtsFrame {
  /** Total frame length, header included. */
  readonly length: number;
  /** 7, or 9 where the frame carries a CRC. */
  readonly headerLength: number;
  readonly objectType: number;
  readonly rateIndex: number;
  readonly channelConfig: number;
  /** 1024 per raw data block, and a frame may hold up to four. */
  readonly samplesPerFrame: number;
}

function adtsFrame(bytes: Uint8Array, at: number): AdtsFrame | null {
  if (at + 7 > bytes.length) return null;
  const b0 = bytes[at] ?? 0;
  const b1 = bytes[at + 1] ?? 0;
  if (b0 !== 0xff || (b1 & 0xf6) !== 0xf0) return null; // sync, and layer must be 0

  const protectionAbsent = b1 & 0x01;
  const b2 = bytes[at + 2] ?? 0;
  const objectType = ((b2 >> 6) & 0x03) + 1;
  const rateIndex = (b2 >> 2) & 0x0f;
  if (rateIndex >= AAC_SAMPLE_RATES.length) return null;
  const channelConfig = (((b2 & 0x01) << 2) | (((bytes[at + 3] ?? 0) >> 6) & 0x03)) & 0x07;
  if (channelConfig === 0) return null; // the config is in the stream, not here

  const length =
    (((bytes[at + 3] ?? 0) & 0x03) << 11) |
    ((bytes[at + 4] ?? 0) << 3) |
    (((bytes[at + 5] ?? 0) >> 5) & 0x07);
  const headerLength = protectionAbsent === 1 ? 7 : 9;
  if (length <= headerLength) return null;

  return {
    length,
    headerLength,
    objectType,
    rateIndex,
    channelConfig,
    samplesPerFrame: 1024 * (((bytes[at + 6] ?? 0) & 0x03) + 1),
  };
}

export interface AdtsSplit {
  /** Frames with the ADTS header ALREADY REMOVED - an MP4 sample is raw AAC. */
  readonly frames: readonly AudioFrame[];
  readonly sampleRate: number;
  readonly channels: number;
  readonly samplesPerFrame: number;
  /** The AudioSpecificConfig an `esds` needs, built from the first header. */
  readonly config: Uint8Array;
  readonly resynced: boolean;
}

/**
 * ADTS frames, unwrapped, with the AudioSpecificConfig the MP4 needs.
 *
 * TWO THINGS HAPPEN HERE THAT ARE NOT COPYING, and both are worth being
 * explicit about because this tool refuses to guess elsewhere.
 *
 * THE HEADER IS REMOVED. An MP4 sample is a raw AAC access unit; the seven
 * bytes in front of it in a transport stream restate the sample rate and
 * channel count on every single frame, because a broadcast has no index to
 * put them in. Keeping them would produce a track whose every sample begins
 * with seven bytes of garbage as far as the decoder is concerned.
 *
 * THE CONFIG IS BUILT RATHER THAN COPIED, and this is the case the Matroska
 * reader refuses to do. The distinction is real. There, a missing
 * `CodecPrivate` means inferring the object type from the codec id, which is
 * exact for AAC-LC and wrong for the SBR variants - it produces audio at half
 * pitch and twice the length. Here the ADTS header STATES the object type, the
 * sampling frequency index and the channel configuration, which are precisely
 * and only the three fields of a two-byte AudioSpecificConfig. Nothing is
 * inferred; the same three numbers are moved from one place to another.
 *
 * What survives from that worry is implicit SBR signalling: a stream may say
 * AAC-LC at 24 kHz and expect the decoder to notice the SBR payload and output
 * 48. That ambiguity is in the source and this carries it across unchanged
 * rather than resolving it either way, which is the most honest thing a
 * remuxer can do with it - and it is why the audio pitch is on the device
 * checklist.
 */
export function splitAdts(bytes: Uint8Array, limit: number): AdtsSplit | null {
  const frames: AudioFrame[] = [];
  let first: AdtsFrame | null = null;
  let resynced = false;
  let at = 0;

  while (at + 7 <= bytes.length && frames.length < limit) {
    const frame = adtsFrame(bytes, at);
    if (frame === null) {
      resynced = true;
      at += 1;
      continue;
    }
    if (at + frame.length > bytes.length) {
      resynced = true;
      break;
    }
    first ??= frame;
    frames.push({
      offset: at + frame.headerLength,
      size: frame.length - frame.headerLength,
    });
    at += frame.length;
  }

  if (first === null || frames.length === 0) return null;

  return {
    frames,
    sampleRate: AAC_SAMPLE_RATES[first.rateIndex] ?? 44_100,
    channels: first.channelConfig,
    samplesPerFrame: first.samplesPerFrame,
    config: audioSpecificConfig(first.objectType, first.rateIndex, first.channelConfig),
    resynced,
  };
}

/**
 * A two-byte AudioSpecificConfig: object type, rate index, channel config.
 *
 * The three trailing flag bits are all zero, and each is a statement rather
 * than a default: `frameLengthFlag` 0 says 1024 samples per frame, which is
 * what ADTS means; `dependsOnCoreCoder` 0 says there is no core layer to
 * depend on; and `extensionFlag` 0 says there is no further configuration,
 * which is true of everything ADTS can express.
 */
function audioSpecificConfig(
  objectType: number,
  rateIndex: number,
  channelConfig: number,
): Uint8Array {
  const packed = (objectType << 11) | (rateIndex << 7) | (channelConfig << 3);
  return Uint8Array.from([(packed >> 8) & 0xff, packed & 0xff]);
}
