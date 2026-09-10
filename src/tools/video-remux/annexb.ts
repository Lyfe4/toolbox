import { LIMITS } from './containers';

/**
 * ANNEX B INTO WHAT AN MP4 WANTS, WHICH IS THE ONE PLACE THIS TOOL REWRITES
 * BYTES.
 *
 * Everywhere else in this directory a sample is a run of bytes copied from one
 * file into another. H.264 and H.265 arriving from a transport stream or from
 * an AVI are the exception, and the reason is that those two containers store
 * the SAME codec in a different framing:
 *
 *   - Annex B, which is what a stream that might be joined halfway through
 *     needs, delimits each NAL unit with a `00 00 01` start code and repeats
 *     the sequence and picture parameter sets in the stream itself every
 *     second or so, so a receiver that tuned in late can start decoding.
 *   - An MP4 has an index, so it needs neither: each NAL unit is preceded by
 *     its own length, and the parameter sets are hoisted out of the stream
 *     into one `avcC` or `hvcC` record inside the sample entry.
 *
 * WHAT SURVIVES AND WHAT DOES NOT. Every coded picture comes through
 * untouched - each NAL unit's payload is copied verbatim, so every
 * coefficient, every macroblock and every slice header is the encoder's own.
 * Nothing is decoded and nothing can be lossy. What changes is the four bytes
 * in front of each NAL unit, and the removal of the repeated parameter sets
 * and access-unit delimiters, which the MP4 states once in the sample entry
 * instead. That is why `SourceFile.reframed` exists: this tool tells people
 * their frames travel byte for byte, and for these two containers the sentence
 * has to be narrowed to the coded pictures rather than quietly stretched.
 *
 * TWO THINGS ARE READ OUT OF THE PARAMETER SETS AND BOTH ARE LOAD-BEARING.
 *
 * The CONFIGURATION RECORD, because there is no other copy of it. A wrong one
 * produces a file that is structurally perfect and shows either nothing or a
 * green smear - the profile and level are what a player consults before it
 * allocates a decoder - and the failure is asymmetric in the worst way,
 * because VLC barely reads the record and Safari will not start without it.
 * So the H.264 profile bytes are copied from fixed positions rather than
 * derived, and everything that genuinely has to be parsed is parsed with a
 * real bit reader below.
 *
 * The PICTURE SIZE, because neither of these two containers has to state it
 * anywhere a remuxer can reach. A transport stream never states it at all. An
 * MP4 with a `tkhd` of 0x0 plays perfectly in QuickTime, which reads the size
 * out of the stream, and occupies no space at all in a browser, which does
 * not - a video element that lays out at zero by zero and reports no error.
 * That is the plausible-wrong-answer shape again, so the size is parsed
 * properly, cropping included, rather than left for a player to work out.
 */

/* ========================================================================== *
 * NAL units
 * ========================================================================== */

export interface Nal {
  /** First byte of the NAL unit itself, past the start code. */
  readonly start: number;
  /** One past its last byte, with trailing zero bytes trimmed. */
  readonly end: number;
}

/**
 * The NAL units inside a run of Annex B bytes.
 *
 * A start code is `00 00 01`, optionally preceded by any number of further
 * zero bytes - a writer is allowed to pad, and hardware encoders do, so the
 * three-byte and four-byte forms both appear inside one stream. The scan
 * therefore looks for `00 00 01` and lets the leading zeros fall out as
 * trailing padding of the previous unit, which is what the trim below is for:
 * those zeros belong to no NAL unit, and copying them into the MP4 sample
 * would put a length prefix in front of more bytes than the encoder wrote.
 *
 * Bounded by `maxNodes` for the same reason every other walk in this tool is:
 * the loop already advances, and the second bound is on TIME. A 256 MB run of
 * nothing but start codes is eighty million legal iterations.
 */
export function splitAnnexB(bytes: Uint8Array, from: number, to: number): Nal[] {
  const found: Nal[] = [];
  let at = from;
  let start = -1;

  const close = (end: number): void => {
    if (start < 0) return;
    let trailing = end;
    while (trailing > start && bytes[trailing - 1] === 0) trailing -= 1;
    if (trailing > start) found.push({ start, end: trailing });
  };

  let steps = 0;
  while (at + 2 < to) {
    steps += 1;
    if (steps > LIMITS.maxNodes) break;

    if (bytes[at] !== 0 || bytes[at + 1] !== 0) {
      // Neither of the next two bytes can begin a start code when the second
      // is not zero, so two may be skipped at once. This is the difference
      // between a scan that keeps up with a 200 MB file and one that does not.
      at += bytes[at + 1] === 0 ? 1 : 2;
      continue;
    }
    if (bytes[at + 2] === 1) {
      close(at);
      at += 3;
      start = at;
      continue;
    }
    at += bytes[at + 2] === 0 ? 1 : 3;
  }

  close(to);
  return found;
}

/**
 * The NAL unit with its emulation-prevention bytes removed.
 *
 * A payload is not allowed to contain `00 00 01`, since that would look like
 * the next start code, so an encoder inserts a `03` after any `00 00` that
 * would otherwise be followed by 00, 01, 02 or 03. Reading any field out of a
 * parameter set means undoing that first - `00 00 03 01` is the number
 * `00 00 01`, and a bit reader that does not know it will read the wrong
 * profile out of an SPS whose bytes happened to need escaping.
 *
 * ONLY EVER USED FOR READING. The bytes written into the MP4 are the escaped
 * originals, untouched; this produces a separate copy for the parser.
 */
function toRbsp(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.byteLength);
  let written = 0;
  let zeros = 0;

  for (const byte of bytes) {
    if (zeros >= 2 && byte === 0x03) {
      zeros = 0;
      continue;
    }
    zeros = byte === 0 ? zeros + 1 : 0;
    out[written] = byte;
    written += 1;
  }

  return out.subarray(0, written);
}

/* ========================================================================== *
 * A bit reader, because parameter sets are not byte-aligned
 * ========================================================================== */

/**
 * Bits out of an RBSP, with exponential-Golomb codes.
 *
 * Needed because everything wanted from a parameter set - the picture size,
 * HEVC's profile-tier-level, both codecs' chroma format and bit depths - sits
 * behind variable-length integers and cannot be reached by counting bytes.
 *
 * Every read past the end returns zero rather than throwing, and sets
 * `overran` so the caller can refuse. That is the same rule the rest of this
 * tool follows and it is deliberate: a truncated parameter set must produce a
 * refused TRACK, decided by the caller looking at what it got, rather than an
 * exception that takes the worker down with every unrelated request in flight.
 */
class BitReader {
  private at = 0;

  constructor(private readonly bytes: Uint8Array) {}

  get overran(): boolean {
    return this.at > this.bytes.length * 8;
  }

  u(count: number): number {
    let value = 0;
    for (let index = 0; index < count; index += 1) {
      const byte = this.bytes[this.at >> 3] ?? 0;
      value = value * 2 + ((byte >> (7 - (this.at & 7))) & 1);
      this.at += 1;
    }
    return value;
  }

  skip(count: number): void {
    this.at += count;
  }

  /**
   * An unsigned exp-Golomb code: n leading zeros, a one, then n more bits.
   *
   * The leading-zero count is capped at 32 because a corrupt parameter set is
   * a long run of zero bytes, and an uncapped loop over one is a scan of the
   * whole buffer for every field read. Past the cap the reader marks itself
   * overrun, which is the caller's signal to refuse the track.
   */
  ue(): number {
    let zeros = 0;
    while (zeros < 32 && !this.overran && this.u(1) === 0) zeros += 1;
    if (zeros >= 32) {
      this.at = this.bytes.length * 8 + 1;
      return 0;
    }
    return 2 ** zeros - 1 + this.u(zeros);
  }

  se(): number {
    const value = this.ue();
    const magnitude = Math.ceil(value / 2);
    return value % 2 === 0 ? -magnitude : magnitude;
  }
}

/* ========================================================================== *
 * What a video stream turned out to be
 * ========================================================================== */

export interface VideoConfig {
  /** `avcC` or `hvcC` contents, ready to go inside a sample entry. */
  readonly config: Uint8Array;
  readonly width: number;
  readonly height: number;
}

/** Chroma subsampling, which is what turns a crop in samples into pixels. */
function subsampling(chromaFormat: number): { readonly x: number; readonly y: number } {
  if (chromaFormat === 1) return { x: 2, y: 2 }; // 4:2:0
  if (chromaFormat === 2) return { x: 2, y: 1 }; // 4:2:2
  return { x: 1, y: 1 }; // monochrome and 4:4:4
}

/* ========================================================================== *
 * H.264
 * ========================================================================== */

const AVC_NAL = {
  nonIdrSlice: 1,
  idrSlice: 5,
  sei: 6,
  sps: 7,
  pps: 8,
  accessUnitDelimiter: 9,
  filler: 12,
} as const;

function avcNalType(bytes: Uint8Array, nal: Nal): number {
  return (bytes[nal.start] ?? 0) & 0x1f;
}

/** The profiles whose SPS carries the chroma format and bit depths. */
const AVC_CHROMA_PROFILES: readonly number[] = [
  100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135,
];

/** The profiles whose `avcC` carries three more bytes at the end. */
const AVC_HIGH_PROFILES: readonly number[] = [100, 110, 122, 244];

/**
 * A scaling list, read only to get past it.
 *
 * The values are never wanted - they are inside the parameter set that gets
 * copied whole into `avcC` - but the list is variable-length, so the fields
 * after it cannot be reached without walking it. Up to twelve of these stand
 * between the bit depths and the picture size, which is the entire reason this
 * file needs an exp-Golomb reader rather than a handful of byte offsets.
 */
function skipScalingList(bits: BitReader, size: number): void {
  let lastScale = 8;
  let nextScale = 8;
  for (let index = 0; index < size; index += 1) {
    if (nextScale !== 0) nextScale = (lastScale + bits.se() + 256) % 256;
    if (nextScale !== 0) lastScale = nextScale;
  }
}

interface AvcSps {
  readonly profile: number;
  readonly chromaFormat: number;
  readonly bitDepthLuma: number;
  readonly bitDepthChroma: number;
  readonly width: number;
  readonly height: number;
}

/**
 * An H.264 sequence parameter set, as far as the frame cropping.
 *
 * Everything before `pic_width_in_mbs_minus1` is skipped rather than kept, and
 * the walk follows the standard's syntax table in order. The two places this
 * is easy to get wrong, both of which produce a size that looks plausible:
 *
 *   - `frame_mbs_only_flag` doubles the height when it is CLEAR, because the
 *     picture is then stored as two interleaved fields. Interlaced broadcast
 *     video read without that comes out exactly half as tall, which looks like
 *     a squashed picture rather than like a parse error.
 *   - The cropping is in CHROMA SAMPLES, not pixels, and 1080p is the case
 *     that catches it: 1080 is not a multiple of 16, so it is coded as 1088
 *     lines with the bottom eight cropped - and the number written in the
 *     parameter set is 4, not 8. A reader that treats it as pixels reports
 *     1084 and writes a track header that stretches the picture.
 */
function readAvcSps(sps: Uint8Array): AvcSps | null {
  const bits = new BitReader(toRbsp(sps));
  bits.skip(8); // the NAL header
  const profile = bits.u(8);
  bits.skip(16); // the constraint flags and level_idc
  bits.ue(); // seq_parameter_set_id

  let chromaFormat = 1;
  let separateColourPlane = 0;
  let bitDepthLuma = 8;
  let bitDepthChroma = 8;

  if (AVC_CHROMA_PROFILES.includes(profile)) {
    chromaFormat = bits.ue();
    if (chromaFormat === 3) separateColourPlane = bits.u(1);
    bitDepthLuma = bits.ue() + 8;
    bitDepthChroma = bits.ue() + 8;
    bits.u(1); // qpprime_y_zero_transform_bypass_flag
    if (bits.u(1) === 1) {
      const lists = chromaFormat === 3 ? 12 : 8;
      for (let index = 0; index < lists; index += 1) {
        if (bits.u(1) === 1) skipScalingList(bits, index < 6 ? 16 : 64);
      }
    }
  }

  bits.ue(); // log2_max_frame_num_minus4
  const orderCountType = bits.ue();
  if (orderCountType === 0) {
    bits.ue(); // log2_max_pic_order_cnt_lsb_minus4
  } else if (orderCountType === 1) {
    bits.u(1);
    bits.se();
    bits.se();
    const cycle = bits.ue();
    // The standard bounds this at 255. A larger value means the reader has
    // lost its place, and looping on it is a scan driven by a corrupt field.
    if (cycle > 255) return null;
    for (let index = 0; index < cycle; index += 1) bits.se();
  }
  bits.ue(); // max_num_ref_frames
  bits.u(1); // gaps_in_frame_num_value_allowed_flag

  const widthInMbs = bits.ue() + 1;
  const heightInUnits = bits.ue() + 1;
  const frameMbsOnly = bits.u(1);
  if (frameMbsOnly === 0) bits.u(1); // mb_adaptive_frame_field_flag
  bits.u(1); // direct_8x8_inference_flag

  let cropLeft = 0;
  let cropRight = 0;
  let cropTop = 0;
  let cropBottom = 0;
  if (bits.u(1) === 1) {
    cropLeft = bits.ue();
    cropRight = bits.ue();
    cropTop = bits.ue();
    cropBottom = bits.ue();
  }

  if (bits.overran) return null;
  if (chromaFormat > 3 || bitDepthLuma > 14 || bitDepthChroma > 14) return null;

  const mono = chromaFormat === 0 || separateColourPlane === 1;
  const chroma = subsampling(mono ? 3 : chromaFormat);
  const unitX = mono ? 1 : chroma.x;
  const unitY = (mono ? 1 : chroma.y) * (2 - frameMbsOnly);

  const width = widthInMbs * 16 - unitX * (cropLeft + cropRight);
  const height = (2 - frameMbsOnly) * heightInUnits * 16 - unitY * (cropTop + cropBottom);
  if (width <= 0 || height <= 0 || width > 32_768 || height > 32_768) return null;

  return { profile, chromaFormat, bitDepthLuma, bitDepthChroma, width, height };
}

/** A parameter set inside a configuration record: two length bytes, then it. */
function lengthPrefixed(nal: Uint8Array): number[] {
  return [(nal.byteLength >> 8) & 0xff, nal.byteLength & 0xff, ...nal];
}

/**
 * `avcC` and the picture size, from the parameter sets found in the stream.
 *
 * The three bytes that matter are copied rather than computed:
 * `AVCProfileIndication`, the constraint-flag byte and `AVCLevelIndication`
 * are bytes 1, 2 and 3 of the SPS, in that order, which is exactly what these
 * fields are defined to hold. Deriving them instead would be inventing a claim
 * about the stream, and a wrong one produces a file Safari refuses and VLC
 * plays - the worse of the two failure shapes, because it presents as a Safari
 * bug rather than as a bad conversion.
 *
 * The trailing three bytes are written for the high profiles, because a
 * high-profile `avcC` without them is what several older muxers wrote and what
 * some hardware decoders reject.
 */
export function describeAvc(
  sps: readonly Uint8Array[],
  pps: readonly Uint8Array[],
): VideoConfig | null {
  const first = sps[0];
  if (first === undefined || pps.length === 0 || first.byteLength < 4) return null;

  const parsed = readAvcSps(first);
  if (parsed === null) return null;

  const keptSps = sps.slice(0, 31);
  const keptPps = pps.slice(0, 255);

  const out: number[] = [
    1, // configurationVersion
    first[1] ?? 0, // AVCProfileIndication
    first[2] ?? 0, // profile_compatibility
    first[3] ?? 0, // AVCLevelIndication
    0xfc | 3, // six reserved bits set, then lengthSizeMinusOne = 3
    0xe0 | keptSps.length,
  ];

  for (const nal of keptSps) out.push(...lengthPrefixed(nal));
  out.push(keptPps.length);
  for (const nal of keptPps) out.push(...lengthPrefixed(nal));

  if (AVC_HIGH_PROFILES.includes(parsed.profile)) {
    out.push(
      0xfc | parsed.chromaFormat,
      0xf8 | (parsed.bitDepthLuma - 8),
      0xf8 | (parsed.bitDepthChroma - 8),
      0, // no sequence parameter set extensions
    );
  }

  return { config: Uint8Array.from(out), width: parsed.width, height: parsed.height };
}

/* ========================================================================== *
 * H.265
 * ========================================================================== */

const HEVC_NAL = {
  vps: 32,
  sps: 33,
  pps: 34,
  accessUnitDelimiter: 35,
  endOfSequence: 36,
  endOfStream: 37,
  filler: 38,
} as const;

/** The random-access picture types: BLA, IDR and CRA, which are 16 through 21. */
function hevcIsIrap(type: number): boolean {
  return type >= 16 && type <= 21;
}

function hevcNalType(bytes: Uint8Array, nal: Nal): number {
  return ((bytes[nal.start] ?? 0) >> 1) & 0x3f;
}

interface HevcSps {
  readonly profileSpace: number;
  readonly tierFlag: number;
  readonly profileIdc: number;
  readonly compatibility: number;
  /** The six constraint-flag bytes, as two halves of 24 bits each. */
  readonly constraintHigh: number;
  readonly constraintLow: number;
  readonly levelIdc: number;
  readonly chromaFormat: number;
  readonly bitDepthLuma: number;
  readonly bitDepthChroma: number;
  readonly temporalLayers: number;
  readonly temporalIdNested: number;
  readonly width: number;
  readonly height: number;
}

/**
 * The parts of an HEVC sequence parameter set that `hvcC` is made of.
 *
 * THIS IS THE MOST DELICATE FUNCTION IN THE TOOL, and it is worth saying so
 * rather than leaving it to be discovered. H.264's configuration record is
 * three bytes lifted out of the SPS at fixed positions; H.265's is twelve
 * bytes of profile-tier-level plus the chroma format and both bit depths, and
 * every one of them sits behind a variable-length field. There is no way to
 * reach them by counting bytes, and no way to check the answer except against
 * a decoder.
 *
 * What a wrong answer looks like: a file that plays in VLC, which reads the
 * parameter sets out of the samples and barely consults `hvcC`, and shows a
 * black frame in Safari and in QuickTime, which do. That is the failure shape
 * this repository keeps writing down - correct in every measurable respect and
 * obviously wrong to a person - so HEVC out of a transport stream is the first
 * thing on the device checklist.
 *
 * The walk follows the syntax table in the standard exactly:
 *
 *   sps_video_parameter_set_id      u(4)
 *   sps_max_sub_layers_minus1       u(3)
 *   sps_temporal_id_nesting_flag    u(1)
 *   profile_tier_level(1, sps_max_sub_layers_minus1)
 *   sps_seq_parameter_set_id        ue(v)
 *   chroma_format_idc               ue(v)
 *   [ separate_colour_plane_flag    u(1)  when chroma_format_idc == 3 ]
 *   pic_width_in_luma_samples       ue(v)
 *   pic_height_in_luma_samples      ue(v)
 *   [ conformance window            4 x ue(v) ]
 *   bit_depth_luma_minus8           ue(v)
 *   bit_depth_chroma_minus8         ue(v)
 */
function readHevcSps(sps: Uint8Array): HevcSps | null {
  const bits = new BitReader(toRbsp(sps));
  bits.skip(16); // the two-byte NAL header
  bits.skip(4); // sps_video_parameter_set_id
  const subLayers = bits.u(3);
  const temporalIdNested = bits.u(1);

  const profileSpace = bits.u(2);
  const tierFlag = bits.u(1);
  const profileIdc = bits.u(5);
  const compatibility = bits.u(32);
  // The six constraint-flag bytes, read as two halves: 48 bits is past where
  // JavaScript's bit operations can be trusted, and these are copied through
  // rather than interpreted, so the split costs nothing.
  const constraintHigh = bits.u(24);
  const constraintLow = bits.u(24);
  const levelIdc = bits.u(8);

  /*
   * The sub-layer flags, which are the trap in this syntax. Each sub-layer
   * contributes two flags up front and then, for each one whose profile flag
   * is set, eighty-eight more bits further down - and between the two there is
   * an alignment rule that skips fixed pairs up to eight. A reader that
   * assumes a single layer gets the right answer for everything a camera
   * writes and the wrong one for any stream with temporal scalability, which
   * is exactly the plausible-wrong-answer shape: most files keep working.
   */
  const profilePresent: number[] = [];
  const levelPresent: number[] = [];
  for (let index = 0; index < subLayers; index += 1) {
    profilePresent.push(bits.u(1));
    levelPresent.push(bits.u(1));
  }
  if (subLayers > 0) {
    for (let index = subLayers; index < 8; index += 1) bits.skip(2);
  }
  for (let index = 0; index < subLayers; index += 1) {
    if (profilePresent[index] === 1) bits.skip(88);
    if (levelPresent[index] === 1) bits.skip(8);
  }

  bits.ue(); // sps_seq_parameter_set_id
  const chromaFormat = bits.ue();
  if (chromaFormat === 3) bits.u(1);
  const codedWidth = bits.ue();
  const codedHeight = bits.ue();

  let cropLeft = 0;
  let cropRight = 0;
  let cropTop = 0;
  let cropBottom = 0;
  if (bits.u(1) === 1) {
    cropLeft = bits.ue();
    cropRight = bits.ue();
    cropTop = bits.ue();
    cropBottom = bits.ue();
  }
  const bitDepthLuma = bits.ue() + 8;
  const bitDepthChroma = bits.ue() + 8;

  /*
   * Every value is range-checked against the standard's own ranges, and that
   * is the only defence against a parameter set that parsed without overrunning
   * and yielded nonsense. A bit reader cannot tell it has lost its place; a
   * chroma format of 6 is how it says so.
   */
  if (bits.overran) return null;
  if (chromaFormat > 3 || bitDepthLuma > 16 || bitDepthChroma > 16) return null;
  if (profileIdc > 31 || levelIdc === 0) return null;

  const chroma = subsampling(chromaFormat);
  const width = codedWidth - chroma.x * (cropLeft + cropRight);
  const height = codedHeight - chroma.y * (cropTop + cropBottom);
  if (width <= 0 || height <= 0 || width > 32_768 || height > 32_768) return null;

  return {
    profileSpace,
    tierFlag,
    profileIdc,
    compatibility,
    constraintHigh,
    constraintLow,
    levelIdc,
    chromaFormat,
    bitDepthLuma,
    bitDepthChroma,
    temporalLayers: subLayers + 1,
    temporalIdNested,
    width,
    height,
  };
}

/** A 24-bit value as three bytes, for the two halves of the constraint flags. */
function three(value: number): number[] {
  return [(value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

/**
 * `hvcC` and the picture size, from the parameter sets in the stream.
 *
 * Three of its fields are declared "unknown" rather than guessed, which the
 * format explicitly allows and which is the honest answer here.
 * `parallelismType` 0 means the stream does not say how it may be decoded in
 * parallel; `min_spatial_segmentation_idc` 0 means the same; and
 * `constantFrameRate` 0 means unknown, which is true - a transport stream
 * carries timestamps and no frame rate at all. Writing 1 there would be a
 * claim about the stream that this reader has no way to check.
 */
export function describeHevc(
  vps: readonly Uint8Array[],
  sps: readonly Uint8Array[],
  pps: readonly Uint8Array[],
): VideoConfig | null {
  const firstSps = sps[0];
  if (firstSps === undefined || pps.length === 0) return null;

  const parsed = readHevcSps(firstSps);
  if (parsed === null) return null;

  const out: number[] = [
    1, // configurationVersion
    (parsed.profileSpace << 6) | (parsed.tierFlag << 5) | parsed.profileIdc,
    (parsed.compatibility >>> 24) & 0xff,
    (parsed.compatibility >>> 16) & 0xff,
    (parsed.compatibility >>> 8) & 0xff,
    parsed.compatibility & 0xff,
    ...three(parsed.constraintHigh),
    ...three(parsed.constraintLow),
    parsed.levelIdc,
    0xf0, // four reserved bits set, then min_spatial_segmentation_idc = 0
    0,
    0xfc, // six reserved bits set, then parallelismType = 0
    0xfc | parsed.chromaFormat,
    0xf8 | (parsed.bitDepthLuma - 8),
    0xf8 | (parsed.bitDepthChroma - 8),
    0, // average frame rate: unknown
    0,
    // constantFrameRate 0, the temporal layer count, the nesting flag, and
    // lengthSizeMinusOne = 3.
    (Math.min(parsed.temporalLayers, 7) << 3) | (parsed.temporalIdNested << 2) | 3,
  ];

  const arrays = [
    { type: HEVC_NAL.vps, nals: vps.slice(0, 0xffff) },
    { type: HEVC_NAL.sps, nals: sps.slice(0, 0xffff) },
    { type: HEVC_NAL.pps, nals: pps.slice(0, 0xffff) },
  ].filter((array) => array.nals.length > 0);

  out.push(arrays.length);
  for (const array of arrays) {
    // The top bit is `array_completeness`: 0, because a transport stream may
    // repeat parameter sets that differ from these, and this record does not
    // claim to be the complete set.
    out.push(array.type & 0x3f);
    out.push((array.nals.length >> 8) & 0xff, array.nals.length & 0xff);
    for (const nal of array.nals) out.push(...lengthPrefixed(nal));
  }

  return { config: Uint8Array.from(out), width: parsed.width, height: parsed.height };
}

/* ========================================================================== *
 * Gathering the parameter sets as a stream goes past
 * ========================================================================== */

export type AnnexBCodec = 'avc' | 'hevc';

function isParameterSet(codec: AnnexBCodec, type: number): boolean {
  return codec === 'avc'
    ? type === AVC_NAL.sps || type === AVC_NAL.pps
    : type >= HEVC_NAL.vps && type <= HEVC_NAL.pps;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, at) => byte === right[at]);
}

/**
 * The parameter sets seen so far, gathered as frames go past.
 *
 * WHY NOT JUST THE FIRST FRAME'S. A broadcast repeats its parameter sets, and
 * a recording starts wherever the user pressed the button - so the first copy
 * in the file can be the tail of one that began before the recording did, and
 * the first frame can have none at all because it arrived mid-repeat. A reader
 * that gives up after the first access unit refuses perfectly ordinary
 * captures for want of a configuration record that is four frames further on.
 *
 * At most two of each kind are kept, and an exact repeat is never stored
 * twice. Without that the record accumulates one entry per second of
 * recording, which for an hour is a sample entry holding three thousand
 * identical parameter sets - legal, and a `moov` nothing parses quickly.
 */
export class ParameterSets {
  private readonly held = new Map<number, Uint8Array[]>();

  constructor(private readonly codec: AnnexBCodec) {}

  observe(bytes: Uint8Array, nals: readonly Nal[]): void {
    for (const nal of nals) {
      const type = this.codec === 'avc' ? avcNalType(bytes, nal) : hevcNalType(bytes, nal);
      if (!isParameterSet(this.codec, type)) continue;
      const list = this.held.get(type) ?? [];
      if (list.length >= 2) continue;
      // Copied out, because the buffer these ranges point into is reused for
      // the next frame.
      const copy = bytes.slice(nal.start, nal.end);
      if (list.some((existing) => sameBytes(existing, copy))) continue;
      list.push(copy);
      this.held.set(type, list);
    }
  }

  describe(): VideoConfig | null {
    if (this.codec === 'avc') {
      return describeAvc(this.held.get(AVC_NAL.sps) ?? [], this.held.get(AVC_NAL.pps) ?? []);
    }
    return describeHevc(
      this.held.get(HEVC_NAL.vps) ?? [],
      this.held.get(HEVC_NAL.sps) ?? [],
      this.held.get(HEVC_NAL.pps) ?? [],
    );
  }
}

/* ========================================================================== *
 * An access unit, written the way an MP4 sample is written
 * ========================================================================== */

/**
 * The largest an access unit can get by being re-framed, from its Annex B size.
 *
 * Needed BEFORE anything is read, because the readers allocate one buffer for
 * a whole track's media rather than one per frame - half a million small
 * allocations is where the time goes in a conversion that should be
 * milliseconds.
 *
 * The bound: a NAL unit costs its own length plus a three or four byte start
 * code going in, and its own length plus exactly four bytes coming out. So the
 * only way out is bigger than in is a three-byte start code, which costs one
 * byte, and the smallest NAL unit is four bytes in - three of start code and
 * one of payload. A quarter more, plus a little, therefore cannot be exceeded,
 * and dropping the parameter sets only makes the real figure smaller.
 */
export function reframedCeiling(annexBBytes: number): number {
  return annexBBytes + Math.ceil(annexBBytes / 4) + 64;
}

export interface Reframed {
  readonly written: number;
  /** True when this access unit can be decoded without any before it. */
  readonly sync: boolean;
  /** True when nothing but parameter sets, delimiters and padding was there. */
  readonly empty: boolean;
}

/**
 * One access unit's NAL units, length-prefixed, written straight into `dest`.
 *
 * Four kinds of NAL unit do not travel, and each for its own reason:
 *
 *   - Parameter sets, because the MP4 states them once in `avcC` or `hvcC`.
 *     Leaving them in every sample is legal and every player tolerates it, but
 *     it is a second copy of a claim the container has already made, and where
 *     the two disagree it is not defined which one wins.
 *   - Access-unit delimiters, whose entire job is to mark a boundary that the
 *     sample table now marks instead.
 *   - Filler, which exists to pad a broadcast out to a constant bitrate and is
 *     dead weight in a file with an index.
 *   - End-of-sequence and end-of-stream markers, which say something about the
 *     stream that the index says better.
 *
 * Everything else - every slice, and every SEI message, including the ones
 * carrying picture timing and closed captions - is copied through byte for
 * byte behind a four-byte length.
 */
export function reframeInto(
  dest: Uint8Array,
  at: number,
  bytes: Uint8Array,
  nals: readonly Nal[],
  codec: AnnexBCodec,
): Reframed {
  let written = 0;
  let sync = false;
  let kept = 0;

  for (const nal of nals) {
    const type = codec === 'avc' ? avcNalType(bytes, nal) : hevcNalType(bytes, nal);
    if (isParameterSet(codec, type)) continue;

    if (codec === 'avc') {
      if (type === AVC_NAL.accessUnitDelimiter || type === AVC_NAL.filler) continue;
      if (type === AVC_NAL.idrSlice) sync = true;
    } else {
      if (type === HEVC_NAL.accessUnitDelimiter || type === HEVC_NAL.filler) continue;
      if (type === HEVC_NAL.endOfSequence || type === HEVC_NAL.endOfStream) continue;
      if (hevcIsIrap(type)) sync = true;
    }

    const length = nal.end - nal.start;
    // The destination was sized by `reframedCeiling`, so this cannot trip for
    // anything the caller measured. It is here because the alternative to a
    // bounds check is `dest.set` throwing out of the worker.
    if (at + written + 4 + length > dest.length) break;
    dest[at + written] = Math.floor(length / 0x1000000) & 0xff;
    dest[at + written + 1] = (length >> 16) & 0xff;
    dest[at + written + 2] = (length >> 8) & 0xff;
    dest[at + written + 3] = length & 0xff;
    dest.set(bytes.subarray(nal.start, nal.end), at + written + 4);
    written += 4 + length;
    kept += 1;
  }

  return { written, sync, empty: kept === 0 };
}
