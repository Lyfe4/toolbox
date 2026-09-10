/**
 * SYNTHETIC CONTAINERS, BUILT BY HAND.
 *
 * These exist so the readers are tested against files this repository did not
 * write with its own writer. That distinction is the whole point: a fixture
 * produced by `mp4writer.ts` and read back by `isobmff.ts` proves the two
 * agree, and proves nothing at all about whether either is right - a shared
 * misunderstanding passes such a test perfectly.
 *
 * So the MP4 builder here deliberately does everything the WRITER does not:
 *
 *   - `mdat` first and `moov` last, which is what a camera writes and a
 *     "faststart" pass exists to undo;
 *   - the 32-bit `stco` rather than `co64`;
 *   - several samples per chunk, with an uneven final chunk;
 *   - a QuickTime version-1 audio sample entry, whose fixed part is sixteen
 *     bytes longer than the ISO one - the shape that silently moves `esds` out
 *     from under a reader that assumes version 0;
 *   - an `stss`, a `ctts`, an `elst` and a `udta` carrying GPS coordinates.
 *
 * The Matroska builder is the only Matroska writer in this repository, so
 * independence there comes from the format itself: lacing, block groups and
 * signed relative timestamps are all encodings this code has to get right in
 * one direction only, with nothing of ours on the other side to agree with it.
 *
 * The MPEG-TS and AVI builders further down are the same argument again, and
 * one of them goes further than the others have to. A transport-stream fixture
 * whose H.264 parameter sets were a hand-picked byte string would exercise
 * `describeAvc` against a picture size THIS FILE invented, which proves that
 * the two agree and nothing else - so the parameter sets are written out bit by
 * bit through the real syntax, exponential-Golomb codes included. 640 by 480 is
 * forty macroblocks by thirty map units, and the reader has to do that
 * arithmetic to get there.
 *
 * Three other things in those two builders are deliberate rather than
 * incidental, and each is a shape that produces a file which plays:
 *
 *   - Every transport-stream frame's last packet is padded with a stuffing
 *     adaptation field, because that is what a real muxer writes and a reader
 *     skipping the field by the wrong amount gets exactly that case wrong.
 *   - The AVI `idx1` offsets are DELIBERATE NONSENSE, since whether they are
 *     measured from the file or from the `movi` list was never settled.
 *   - AVI chunks appear at odd lengths and at zero length, which are the pad
 *     byte and the dropped frame.
 */

/* ========================================================================== *
 * Bytes
 * ========================================================================== */

type Chunk = Uint8Array | readonly number[];

function join(...parts: Chunk[]): Uint8Array {
  const total = parts.reduce(
    (sum, part) => sum + (part instanceof Uint8Array ? part.byteLength : part.length),
    0,
  );
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    const bytes = part instanceof Uint8Array ? part : Uint8Array.from(part);
    out.set(bytes, at);
    at += bytes.byteLength;
  }
  return out;
}

function be(value: number, width: number): number[] {
  const out: number[] = [];
  let remaining = Math.max(0, Math.floor(value));
  for (let index = 0; index < width; index += 1) {
    out.unshift(remaining % 256);
    remaining = Math.floor(remaining / 256);
  }
  return out;
}

function chars(text: string): number[] {
  const out: number[] = [];
  for (let index = 0; index < text.length; index += 1) out.push(text.charCodeAt(index) & 0xff);
  return out;
}

export function mp4Box(type: string, ...parts: Chunk[]): Uint8Array {
  const body = join(...parts);
  return join(be(8 + body.byteLength, 4), chars(type), body);
}

function fullBox(type: string, version: number, flags: number, ...parts: Chunk[]): Uint8Array {
  return mp4Box(type, [version], be(flags, 3), ...parts);
}

/** Distinguishable bytes, so a sample that moved can be told from one that did not. */
export function sampleBytes(seed: number, length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) out[index] = (seed * 31 + index * 7 + 11) & 0xff;
  return out;
}

/* ========================================================================== *
 * A hand-written MP4
 * ========================================================================== */

export interface FixtureTrack {
  readonly kind: 'video' | 'audio' | 'other';
  /** Four-character sample entry code: `avc1`, `mp4a`, `tx3g`, `vp09`. */
  readonly fourcc: string;
  readonly timescale: number;
  readonly samples: readonly Uint8Array[];
  /** Decode delta per sample, in the track's ticks. */
  readonly delta: number;
  /** Composition offsets, when the stream is reordered. */
  readonly compositionOffsets?: readonly number[];
  /** 1-based sample numbers a player may seek to. Absent means all of them. */
  readonly syncSamples?: readonly number[];
  readonly width?: number;
  readonly height?: number;
  readonly channels?: number;
  /** A QuickTime version-1 audio entry, sixteen bytes longer than version 0. */
  readonly audioEntryVersion?: 0 | 1;
  readonly language?: string;
  /** A 3x3 display matrix, for the rotation case. */
  readonly matrix?: readonly number[];
  readonly edits?: readonly { readonly duration: number; readonly mediaTime: number }[];
  /** Samples per chunk. The last chunk takes whatever is left. */
  readonly perChunk?: number;
}

export interface Mp4Fixture {
  readonly tracks: readonly FixtureTrack[];
  readonly timescale?: number;
  readonly brand?: string;
  /** QuickTime coordinates, written as a `©xyz` atom in `moov/udta`. */
  readonly location?: string;
  readonly creationTime?: number;
}

const ROTATE_90: readonly number[] = [
  ...be(0, 4),
  ...be(0x00010000, 4),
  ...be(0, 4),
  ...be(0xffff0000, 4),
  ...be(0, 4),
  ...be(0, 4),
  ...be(0, 4),
  ...be(0, 4),
  ...be(0x40000000, 4),
];

export const ROTATION_MATRIX = ROTATE_90;

const IDENTITY: readonly number[] = [
  ...be(0x00010000, 4),
  ...be(0, 4),
  ...be(0, 4),
  ...be(0, 4),
  ...be(0x00010000, 4),
  ...be(0, 4),
  ...be(0, 4),
  ...be(0, 4),
  ...be(0x40000000, 4),
];

/** An `avcC` that is structurally plausible; its contents are never read. */
export function avcConfig(): Uint8Array {
  return Uint8Array.from([
    0x01, 0x64, 0x00, 0x1f, 0xff, 0xe1, 0x00, 0x04, 0x67, 0x64, 0x00, 0x1f, 0x01, 0x00, 0x03, 0x68,
    0xee, 0x3c,
  ]);
}

/** An AAC AudioSpecificConfig: profile 2, 44.1 kHz, stereo. */
export function aacConfig(): Uint8Array {
  return Uint8Array.from([0x12, 0x10]);
}

function sampleEntryFor(track: FixtureTrack): Uint8Array {
  if (track.kind === 'video') {
    return mp4Box(
      track.fourcc,
      new Uint8Array(6),
      be(1, 2),
      new Uint8Array(16),
      be(track.width ?? 640, 2),
      be(track.height ?? 480, 2),
      be(0x00480000, 4),
      be(0x00480000, 4),
      be(0, 4),
      be(1, 2),
      new Uint8Array(32),
      be(0x0018, 2),
      be(0xffff, 2),
      mp4Box('avcC', avcConfig()),
    );
  }

  if (track.kind === 'audio') {
    const version = track.audioEntryVersion ?? 0;
    const esds = fullBox(
      'esds',
      0,
      0,
      // ES_Descriptor, DecoderConfig (object type 0x40, AAC), DecoderSpecific.
      [0x03, 0x19, 0x00, 0x00, 0x00],
      [0x04, 0x11, 0x40, 0x15, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
      [0x05, 0x02],
      aacConfig(),
      [0x06, 0x01, 0x02],
    );
    return mp4Box(
      'mp4a',
      new Uint8Array(6),
      be(1, 2),
      be(version, 2),
      be(0, 2),
      be(0, 4),
      be(track.channels ?? 2, 2),
      be(16, 2),
      be(0, 2),
      be(0, 2),
      be(track.timescale * 0x10000, 4),
      // Version 1 puts four extra 32-bit fields here, which is the whole
      // reason this option exists: a reader assuming version 0 looks for the
      // `esds` sixteen bytes early and finds nothing.
      version === 1 ? join(be(1024, 4), be(0, 4), be(0, 4), be(2, 4)) : new Uint8Array(0),
      esds,
    );
  }

  return mp4Box(track.fourcc, new Uint8Array(6), be(1, 2));
}

function languageBits(language: string): number {
  const text = language.length === 3 ? language : 'und';
  let packed = 0;
  for (let index = 0; index < 3; index += 1) {
    packed = (packed << 5) | ((text.charCodeAt(index) - 0x60) & 0x1f);
  }
  return packed;
}

export function makeMp4(fixture: Mp4Fixture): Uint8Array {
  const movieTimescale = fixture.timescale ?? 1000;

  const ftyp = mp4Box(
    'ftyp',
    chars(fixture.brand ?? 'isom'),
    be(0x200, 4),
    chars('isom'),
    chars('mp41'),
  );

  // mdat FIRST, which is what a camera writes: the offsets in `moov` therefore
  // point backwards past it, and a reader that assumes a faststart layout gets
  // every sample wrong.
  const mediaParts: Uint8Array[] = [];
  const offsets: number[][] = [];
  let cursor = ftyp.byteLength + 8;

  for (const track of fixture.tracks) {
    const own: number[] = [];
    for (const sample of track.samples) {
      own.push(cursor);
      cursor += sample.byteLength;
      mediaParts.push(sample);
    }
    offsets.push(own);
  }

  const mdat = join(be(8 + (cursor - ftyp.byteLength - 8), 4), chars('mdat'), join(...mediaParts));

  const traks = fixture.tracks.map((track, index) => {
    const own = offsets[index] ?? [];
    const perChunk = track.perChunk ?? 1;
    const duration = track.samples.length * track.delta;

    // Chunk offsets: the first sample of every chunk. Deliberately not one
    // sample per chunk, so `stsc` has to be read properly.
    const chunkOffsets: number[] = [];
    const runs: number[][] = [];
    for (let at = 0; at < own.length; at += perChunk) {
      chunkOffsets.push(own[at] ?? 0);
      const count = Math.min(perChunk, own.length - at);
      const last = runs.at(-1);
      if (last?.[1] !== count) runs.push([chunkOffsets.length, count, 1]);
    }

    const stbl = mp4Box(
      'stbl',
      fullBox('stsd', 0, 0, be(1, 4), sampleEntryFor(track)),
      fullBox('stts', 0, 0, be(1, 4), be(track.samples.length, 4), be(track.delta, 4)),
      track.compositionOffsets === undefined
        ? new Uint8Array(0)
        : fullBox(
            'ctts',
            0,
            0,
            be(track.compositionOffsets.length, 4),
            join(
              ...track.compositionOffsets.map((offset) =>
                Uint8Array.from(join(be(1, 4), be(offset, 4))),
              ),
            ),
          ),
      track.syncSamples === undefined
        ? new Uint8Array(0)
        : fullBox(
            'stss',
            0,
            0,
            be(track.syncSamples.length, 4),
            join(...track.syncSamples.map((number) => Uint8Array.from(be(number, 4)))),
          ),
      fullBox(
        'stsc',
        0,
        0,
        be(runs.length, 4),
        join(
          ...runs.map((run) =>
            Uint8Array.from(join(be(run[0] ?? 1, 4), be(run[1] ?? 1, 4), be(1, 4))),
          ),
        ),
      ),
      fullBox(
        'stsz',
        0,
        0,
        be(0, 4),
        be(track.samples.length, 4),
        join(...track.samples.map((sample) => Uint8Array.from(be(sample.byteLength, 4)))),
      ),
      // The 32-bit table, which the writer never emits.
      fullBox(
        'stco',
        0,
        0,
        be(chunkOffsets.length, 4),
        join(...chunkOffsets.map((offset) => Uint8Array.from(be(offset, 4)))),
      ),
    );

    const handler = track.kind === 'video' ? 'vide' : track.kind === 'audio' ? 'soun' : 'sbtl';

    return mp4Box(
      'trak',
      fullBox(
        'tkhd',
        0,
        7,
        be(0, 4),
        be(0, 4),
        be(index + 1, 4),
        be(0, 4),
        be(Math.round((duration / track.timescale) * movieTimescale), 4),
        new Uint8Array(8),
        be(0, 2),
        be(0, 2),
        be(track.kind === 'audio' ? 0x0100 : 0, 2),
        be(0, 2),
        track.matrix ?? IDENTITY,
        be((track.width ?? 0) * 0x10000, 4),
        be((track.height ?? 0) * 0x10000, 4),
      ),
      track.edits === undefined
        ? new Uint8Array(0)
        : mp4Box(
            'edts',
            fullBox(
              'elst',
              0,
              0,
              be(track.edits.length, 4),
              join(
                ...track.edits.map((edit) =>
                  Uint8Array.from(
                    join(
                      be(edit.duration, 4),
                      be(edit.mediaTime < 0 ? 0xffffffff : edit.mediaTime, 4),
                      be(1, 2),
                      be(0, 2),
                    ),
                  ),
                ),
              ),
            ),
          ),
      mp4Box(
        'mdia',
        fullBox(
          'mdhd',
          0,
          0,
          be(0, 4),
          be(0, 4),
          be(track.timescale, 4),
          be(duration, 4),
          be(languageBits(track.language ?? 'und'), 2),
          be(0, 2),
        ),
        fullBox('hdlr', 0, 0, be(0, 4), chars(handler), new Uint8Array(12), chars('Fixture'), [0]),
        mp4Box(
          'minf',
          track.kind === 'video'
            ? fullBox('vmhd', 0, 1, be(0, 2), be(0, 2), be(0, 2), be(0, 2))
            : fullBox('smhd', 0, 0, be(0, 2), be(0, 2)),
          mp4Box('dinf', fullBox('dref', 0, 0, be(1, 4), fullBox('url ', 0, 1))),
          stbl,
        ),
      ),
    );
  });

  const udta =
    fixture.location === undefined
      ? new Uint8Array(0)
      : mp4Box(
          'udta',
          // `©xyz`: the copyright sign is 0xA9 in the MacRoman that QuickTime
          // atom names are written in.
          mp4Box(
            String.fromCharCode(0xa9) + 'xyz',
            be(fixture.location.length, 2),
            be(0x15c7, 2),
            chars(fixture.location),
          ),
        );

  const moov = mp4Box(
    'moov',
    fullBox(
      'mvhd',
      0,
      0,
      be(fixture.creationTime ?? 0, 4),
      be(0, 4),
      be(movieTimescale, 4),
      be(
        Math.max(
          0,
          ...fixture.tracks.map((track) =>
            Math.round(((track.samples.length * track.delta) / track.timescale) * movieTimescale),
          ),
        ),
        4,
      ),
      be(0x00010000, 4),
      be(0x0100, 2),
      be(0, 2),
      new Uint8Array(8),
      IDENTITY,
      new Uint8Array(24),
      be(fixture.tracks.length + 1, 4),
    ),
    ...traks,
    udta,
  );

  return join(ftyp, mdat, moov);
}

/* ========================================================================== *
 * A hand-written Matroska file
 * ========================================================================== */

/** An EBML element id, written as the literal bytes it is. */
function ebmlId(id: number): number[] {
  const out: number[] = [];
  let remaining = id;
  while (remaining > 0) {
    out.unshift(remaining & 0xff);
    remaining = Math.floor(remaining / 256);
  }
  return out;
}

/** A length, in the shortest vint that holds it. */
function vint(value: number): number[] {
  for (let width = 1; width <= 8; width += 1) {
    const capacity = 2 ** (7 * width) - 1;
    if (value < capacity) {
      const out = be(value, width);
      out[0] = (out[0] ?? 0) | (0x80 >> (width - 1));
      return out;
    }
  }
  return [0x01, ...be(value, 7)];
}

export function ebml(id: number, ...parts: Chunk[]): Uint8Array {
  const body = join(...parts);
  return join(ebmlId(id), vint(body.byteLength), body);
}

function ebmlUint(id: number, value: number): Uint8Array {
  let width = 1;
  while (width < 8 && value >= 2 ** (8 * width)) width += 1;
  return ebml(id, be(value, width));
}

function ebmlFloat(id: number, value: number): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setFloat64(0, value);
  return ebml(id, out);
}

function ebmlString(id: number, value: string): Uint8Array {
  return ebml(id, chars(value));
}

export type Lacing = 'none' | 'xiph' | 'ebml' | 'fixed';

export interface MatroskaTrack {
  readonly number: number;
  readonly kind: 'video' | 'audio' | 'other';
  readonly codecId: string;
  readonly codecPrivate?: Uint8Array;
  readonly width?: number;
  readonly height?: number;
  readonly channels?: number;
  readonly sampleRate?: number;
  readonly language?: string;
  /** Nanoseconds per frame. */
  readonly defaultDuration?: number;
}

export interface MatroskaBlock {
  readonly track: number;
  /** Milliseconds from the start of the file, at the default timestamp scale. */
  readonly time: number;
  readonly frames: readonly Uint8Array[];
  readonly lacing?: Lacing;
  readonly keyframe?: boolean;
  /**
   * The block's whole body, replacing everything computed from `frames`.
   *
   * The escape hatch the malformed suite needs: a lace whose declared sizes
   * overrun the block cannot be expressed by describing frames, because the
   * point of it is that the description and the frames disagree.
   */
  readonly rawBody?: Uint8Array;
  /** Written as a BlockGroup with a ReferenceBlock rather than a SimpleBlock. */
  readonly inBlockGroup?: boolean;
}

export interface MatroskaFixture {
  readonly docType?: string;
  readonly tracks: readonly MatroskaTrack[];
  readonly blocks: readonly MatroskaBlock[];
  readonly durationTicks?: number;
  readonly timestampScale?: number;
  readonly dateUtc?: boolean;
  readonly tags?: boolean;
}

function laceBody(block: MatroskaBlock): Uint8Array {
  const frames = block.frames;
  const lacing = block.lacing ?? 'none';
  if (lacing === 'none' || frames.length === 1) return join(...frames);

  if (lacing === 'fixed') return join([frames.length - 1], ...frames);

  if (lacing === 'xiph') {
    const sizes: number[] = [];
    for (const frame of frames.slice(0, -1)) {
      let remaining = frame.byteLength;
      while (remaining >= 255) {
        sizes.push(255);
        remaining -= 255;
      }
      sizes.push(remaining);
    }
    return join([frames.length - 1], sizes, ...frames);
  }

  // EBML lacing: the first size is a plain vint, the rest are signed
  // differences biased by half the range of the width they are written in.
  const head = vint(frames[0]?.byteLength ?? 0);
  const rest: number[] = [];
  for (let index = 1; index < frames.length - 1; index += 1) {
    const delta = (frames[index]?.byteLength ?? 0) - (frames[index - 1]?.byteLength ?? 0);
    // Two-byte signed vint: bias 2^13 - 1, marker 0x40.
    const biased = delta + (2 ** 13 - 1);
    rest.push(0x40 | ((biased >> 8) & 0x3f), biased & 0xff);
  }
  return join([frames.length - 1], head, rest, ...frames);
}

export function makeMatroska(fixture: MatroskaFixture): Uint8Array {
  const scale = fixture.timestampScale ?? 1_000_000;

  const header = ebml(
    0x1a45dfa3,
    ebmlUint(0x4286, 1), // EBMLVersion
    ebmlUint(0x42f7, 1), // EBMLReadVersion
    ebmlString(0x4282, fixture.docType ?? 'matroska'),
    ebmlUint(0x4287, 4), // DocTypeVersion
    ebmlUint(0x4285, 2), // DocTypeReadVersion
  );

  const info = ebml(
    0x1549a966,
    ebmlUint(0x2ad7b1, scale),
    ...(fixture.durationTicks === undefined ? [] : [ebmlFloat(0x4489, fixture.durationTicks)]),
    // DateUTC: nanoseconds since 2001, which is a real recording timestamp.
    ...(fixture.dateUtc === true ? [ebml(0x4461, be(0, 8))] : []),
  );

  const tracks = ebml(
    0x1654ae6b,
    ...fixture.tracks.map((track) =>
      ebml(
        0xae,
        ebmlUint(0xd7, track.number),
        ebmlUint(0x83, track.kind === 'video' ? 1 : track.kind === 'audio' ? 2 : 17),
        ebmlString(0x86, track.codecId),
        ...(track.codecPrivate === undefined ? [] : [ebml(0x63a2, track.codecPrivate)]),
        ...(track.language === undefined ? [] : [ebmlString(0x22b59c, track.language)]),
        ...(track.defaultDuration === undefined ? [] : [ebmlUint(0x23e383, track.defaultDuration)]),
        ...(track.kind === 'video'
          ? [ebml(0xe0, ebmlUint(0xb0, track.width ?? 640), ebmlUint(0xba, track.height ?? 480))]
          : []),
        ...(track.kind === 'audio'
          ? [
              ebml(
                0xe1,
                ebmlFloat(0xb5, track.sampleRate ?? 44100),
                ebmlUint(0x9f, track.channels ?? 2),
              ),
            ]
          : []),
      ),
    ),
  );

  // One cluster per distinct block time, so relative timestamps stay in range
  // and the cluster walk is exercised more than once.
  const times = [...new Set(fixture.blocks.map((block) => block.time))].toSorted((a, b) => a - b);
  const clusters = times.map((time) => {
    const here = fixture.blocks.filter((block) => block.time === time);
    return ebml(
      0x1f43b675,
      ebmlUint(0xe7, time),
      ...here.map((block) => {
        const flags = block.inBlockGroup === true ? 0 : (block.keyframe ?? true) ? 0x80 : 0;
        const laceBits =
          block.lacing === 'xiph'
            ? 0x02
            : block.lacing === 'fixed'
              ? 0x04
              : block.lacing === 'ebml'
                ? 0x06
                : 0;
        const body =
          block.rawBody ?? join(vint(block.track), be(0, 2), [flags | laceBits], laceBody(block));

        if (block.inBlockGroup !== true) return ebml(0xa3, body);
        return ebml(
          0xa0,
          ebml(0xa1, body),
          // A ReferenceBlock is what makes a Block a non-keyframe. Its absence
          // is the only way a BlockGroup says "this one is a keyframe".
          ...((block.keyframe ?? true) ? [] : [ebml(0xfb, [0xff])]),
        );
      }),
    );
  });

  const segment = ebml(
    0x18538067,
    info,
    tracks,
    ...(fixture.tags === true ? [ebml(0x1254c367, ebml(0x7373, ebml(0x63c0)))] : []),
    ...clusters,
  );

  return join(header, segment);
}

/* ========================================================================== *
 * Elementary streams, which both later containers carry
 * ========================================================================== */

/**
 * A bit writer, needed for exactly one thing: a real sequence parameter set.
 *
 * Every other fixture here is byte-aligned and this one cannot be. The picture
 * size in an H.264 or H.265 parameter set sits behind a run of exponential-
 * Golomb codes, so a fixture with a hand-picked byte string in place of a real
 * one would only exercise `describeAvc` against a value this file invented -
 * which is the shape of test the header above exists to avoid. Writing the
 * syntax out properly means the size the reader reports is a size an encoder
 * would have written.
 */
class Bits {
  private readonly bits: number[] = [];

  u(count: number, value: number): this {
    for (let index = count - 1; index >= 0; index -= 1) {
      this.bits.push(Math.floor(value / 2 ** index) % 2);
    }
    return this;
  }

  /** An unsigned exp-Golomb code: n leading zeros, a one, then n more bits. */
  ue(value: number): this {
    const shifted = value + 1;
    let width = 1;
    while (2 ** width <= shifted) width += 1;
    return this.u(width - 1, 0).u(width, shifted);
  }

  /** With `rbsp_trailing_bits`: a one, then zeros to the byte boundary. */
  bytes(...prefix: readonly number[]): Uint8Array {
    const all = [...this.bits, 1];
    while (all.length % 8 !== 0) all.push(0);
    const out = new Uint8Array(prefix.length + all.length / 8);
    out.set(prefix, 0);
    for (const [index, bit] of all.entries()) {
      const at = prefix.length + Math.floor(index / 8);
      out[at] = (((out[at] ?? 0) << 1) | bit) & 0xff;
    }
    return out;
  }
}

/**
 * A real H.264 sequence parameter set, at Baseline profile.
 *
 * Baseline (66) deliberately, because it is NOT one of the profiles carrying a
 * chroma format and scaling lists - so this fixture exercises the ordinary
 * path and `avcSpsHigh` below exercises the other one. The width is in
 * macroblocks and the height in map units, which is what makes the arithmetic
 * worth asserting: 640 by 480 is 40 by 30 of them.
 */
export function avcSps(widthInMbs = 40, heightInUnits = 30): Uint8Array {
  return new Bits()
    .ue(0) // seq_parameter_set_id
    .ue(0) // log2_max_frame_num_minus4
    .ue(2) // pic_order_cnt_type: 2, which carries no further fields
    .ue(1) // max_num_ref_frames
    .u(1, 0) // gaps_in_frame_num_value_allowed_flag
    .ue(widthInMbs - 1)
    .ue(heightInUnits - 1)
    .u(1, 1) // frame_mbs_only_flag
    .u(1, 1) // direct_8x8_inference_flag
    .u(1, 0) // frame_cropping_flag
    .u(1, 0) // vui_parameters_present_flag
    .bytes(0x67, 66, 0x00, 30);
}

/**
 * A High-profile SPS with 1080p's cropping in it, which is the case that
 * catches a reader treating a crop as pixels.
 *
 * 1080 is not a multiple of sixteen, so the picture is coded as 1088 lines
 * with the bottom eight discarded - and the number written here is FOUR,
 * because the crop is counted in chroma samples and this is 4:2:0. A reader
 * that subtracts it as pixels reports 1084 and writes a track header that
 * stretches every frame by a hair.
 */
export function avcSpsHigh(): Uint8Array {
  return new Bits()
    .ue(0) // seq_parameter_set_id
    .ue(1) // chroma_format_idc: 4:2:0
    .ue(0) // bit_depth_luma_minus8
    .ue(0) // bit_depth_chroma_minus8
    .u(1, 0) // qpprime_y_zero_transform_bypass_flag
    .u(1, 0) // seq_scaling_matrix_present_flag
    .ue(0) // log2_max_frame_num_minus4
    .ue(2) // pic_order_cnt_type
    .ue(1) // max_num_ref_frames
    .u(1, 0) // gaps_in_frame_num_value_allowed_flag
    .ue(119) // 120 macroblocks across: 1920
    .ue(67) // 68 map units down: 1088
    .u(1, 1) // frame_mbs_only_flag
    .u(1, 1) // direct_8x8_inference_flag
    .u(1, 1) // frame_cropping_flag
    .ue(0) // left
    .ue(0) // right
    .ue(0) // top
    .ue(4) // bottom: eight lines, counted in 4:2:0 chroma samples
    .u(1, 0) // vui_parameters_present_flag
    .bytes(0x67, 100, 0x00, 40);
}

/** A picture parameter set. Its contents are copied and never read. */
export function avcPps(): Uint8Array {
  return Uint8Array.from([0x68, 0xce, 0x3c, 0x80]);
}

/**
 * A real H.265 sequence parameter set: Main profile, 1280 by 720.
 *
 * Unlike H.264's, this states the picture size in luma samples directly - and
 * it sits behind the twelve bytes of profile-tier-level that `hvcC` is mostly
 * made of, so reaching it at all is most of the assertion.
 */
export function hevcSps(width = 1280, height = 720): Uint8Array {
  return new Bits()
    .u(4, 0) // sps_video_parameter_set_id
    .u(3, 0) // sps_max_sub_layers_minus1
    .u(1, 1) // sps_temporal_id_nesting_flag
    .u(2, 0) // general_profile_space
    .u(1, 0) // general_tier_flag
    .u(5, 1) // general_profile_idc: Main
    .u(32, 0x60000000) // general_profile_compatibility_flags
    .u(24, 0xb00000) // the first three constraint-flag bytes
    .u(24, 0x000000) // and the last three
    .u(8, 120) // general_level_idc: 4.0
    .ue(0) // sps_seq_parameter_set_id
    .ue(1) // chroma_format_idc: 4:2:0
    .ue(width)
    .ue(height)
    .u(1, 0) // conformance_window_flag
    .ue(0) // bit_depth_luma_minus8
    .ue(0) // bit_depth_chroma_minus8
    .bytes(0x42, 0x01);
}

export function hevcVps(): Uint8Array {
  return Uint8Array.from([0x40, 0x01, 0x0c, 0x01, 0xff, 0xff, 0x01, 0x60]);
}

export function hevcPps(): Uint8Array {
  return Uint8Array.from([0x44, 0x01, 0xc1, 0x72, 0xb4, 0x62, 0x40]);
}

/** A slice NAL unit of the given type, with distinguishable contents. */
export function avcSlice(type: number, seed: number, length: number): Uint8Array {
  return join([0x60 | type], sampleBytes(seed, length));
}

export function hevcSlice(type: number, seed: number, length: number): Uint8Array {
  return join([(type << 1) & 0x7e, 0x01], sampleBytes(seed, length));
}

/** NAL units joined into an Annex B access unit, with four-byte start codes. */
export function annexB(...nals: readonly Uint8Array[]): Uint8Array {
  return join(...nals.flatMap((nal) => [Uint8Array.from([0, 0, 0, 1]), nal]));
}

/**
 * One ADTS frame: AAC-LC, 44.1 kHz, stereo, with a seven-byte header.
 *
 * The three fields a two-byte AudioSpecificConfig is made of are the profile,
 * the sampling frequency index and the channel configuration, and all three
 * are stated here - which is the point of the fixture. `splitAdts` has to move
 * them from this header into an `esds` without inventing anything.
 */
export function adtsFrame(seed: number, payload: number): Uint8Array {
  const length = 7 + payload;
  return join(
    [
      0xff,
      0xf1, // MPEG-4, layer 0, no CRC
      // profile 1 (AAC-LC), rate index 4 (44.1 kHz), channel config 2
      (1 << 6) | (4 << 2) | ((2 >> 2) & 0x01),
      ((2 & 0x03) << 6) | ((length >> 11) & 0x03),
      (length >> 3) & 0xff,
      ((length & 0x07) << 5) | 0x1f,
      0xfc, // buffer fullness 0x7FF, and one raw data block
    ],
    sampleBytes(seed, payload),
  );
}

/**
 * One MPEG-1 Layer III frame at 128 kbps and 44.1 kHz, which is 417 bytes.
 *
 * The length is computed by the reader from the bitrate and the sample rate
 * rather than stated anywhere in the frame, so writing the header correctly
 * and letting the fixture be whatever length that implies is the assertion.
 */
export const MP3_FRAME_BYTES = 417;
export const MP2_FRAME_BYTES = 418;

export function mpegAudioFrameBytes(seed: number, layerTwo = false): Uint8Array {
  // 0xFB is MPEG-1 Layer III with no CRC; 0xFD is MPEG-1 Layer II. Layer II at
  // 128 kbps and 44.1 kHz is 418 bytes rather than 417, because its frame
  // length formula rounds the other way.
  const header = [0xff, layerTwo ? 0xfd : 0xfb, 0x90, 0x04];
  const length = layerTwo ? MP2_FRAME_BYTES : MP3_FRAME_BYTES;
  return join(header, sampleBytes(seed, length - 4));
}

/* ========================================================================== *
 * A hand-written MPEG transport stream
 * ========================================================================== */

/**
 * Four zero bytes where a CRC-32 belongs.
 *
 * The reader does not check it, and this states that rather than pretending to
 * compute one: a wrong CRC in a fixture is worse than an absent one, because
 * it would make a future decision to start checking look like a fixture bug.
 */
function crcPlaceholder(): number[] {
  return [0, 0, 0, 0];
}

/** A 33-bit timestamp in the five-byte form a PES header uses. */
function pesTimestamp(prefix: number, value: number): number[] {
  return [
    (prefix << 4) | ((Math.floor(value / 2 ** 30) & 0x07) << 1) | 1,
    Math.floor(value / 2 ** 22) & 0xff,
    ((Math.floor(value / 2 ** 15) & 0x7f) << 1) | 1,
    Math.floor(value / 2 ** 7) & 0xff,
    ((value & 0x7f) << 1) | 1,
  ];
}

export interface TsAccessUnit {
  readonly pid: number;
  readonly payload: Uint8Array;
  /** In 90 kHz ticks. */
  readonly pts?: number;
  readonly dts?: number;
  /** Video by default: a video PES declares no length and audio states one. */
  readonly video?: boolean;
}

export interface TsStream {
  readonly pid: number;
  readonly streamType: number;
  readonly language?: string;
  /** Raw descriptor bytes, for the AC-3-inside-private-data case. */
  readonly descriptors?: readonly number[];
}

export interface TsFixture {
  readonly streams: readonly TsStream[];
  readonly units: readonly TsAccessUnit[];
  /** 188 for a plain `.ts`, 192 for the AVCHD form with an arrival header. */
  readonly packetSize?: 188 | 192;
  /** Extra programmes in the table, for the "one programme travels" note. */
  readonly extraPrograms?: number;
  /** Sets the scrambling bits on every media packet. */
  readonly scrambled?: boolean;
  /** Bytes of junk in front of the first packet, as a mid-capture file has. */
  readonly leading?: number;
}

function tsSection(tableId: number, body: readonly number[]): number[] {
  const length = body.length + 4;
  return [tableId, 0xb0 | ((length >> 8) & 0x0f), length & 0xff, ...body, ...crcPlaceholder()];
}

/**
 * The packets one PES packet becomes, padded to the packet boundary with a
 * stuffing adaptation field.
 *
 * The padding is not decoration. A real muxer fills the tail of the last
 * packet of every frame this way, and it is exactly the shape that a reader
 * skipping the adaptation field by the wrong amount gets wrong - so a fixture
 * that packed its payload tightly would never reach that path at all.
 */
function tsPackets(
  pid: number,
  payload: Uint8Array,
  packetSize: number,
  scrambled: boolean,
): Uint8Array[] {
  const packets: Uint8Array[] = [];
  let at = 0;
  let first = true;

  while (at < payload.byteLength) {
    const take = Math.min(184, payload.byteLength - at);
    const stuffing = 184 - take;

    const header = [
      0x47,
      (first ? 0x40 : 0) | ((pid >> 8) & 0x1f),
      pid & 0xff,
      (scrambled ? 0x80 : 0) | (stuffing > 0 ? 0x30 : 0x10) | (packets.length & 0x0f),
    ];

    const adaptation: number[] = [];
    if (stuffing === 1) {
      adaptation.push(0);
    } else if (stuffing > 1) {
      adaptation.push(stuffing - 1, 0x00);
      for (let index = 0; index < stuffing - 2; index += 1) adaptation.push(0xff);
    }

    const body = join(header, adaptation, payload.subarray(at, at + take));
    // The AVCHD form: four bytes of arrival timestamp in front of the packet,
    // chosen so that none of them is 0x47 and the detector cannot lock on to
    // them instead of on to the real grid.
    packets.push(packetSize === 192 ? join([0x40, 0x11, 0x22, 0x33], body) : body);
    at += take;
    first = false;
  }

  return packets;
}

export function makeTransportStream(fixture: TsFixture): Uint8Array {
  const packetSize = fixture.packetSize ?? 188;
  const pmtPid = 0x1000;

  const patBody = [
    0x00,
    0x01, // transport_stream_id
    0xc1, // version 0, current
    0x00, // section_number
    0x00, // last_section_number
    0x00,
    0x01, // programme 1
    0xe0 | ((pmtPid >> 8) & 0x1f),
    pmtPid & 0xff,
  ];
  for (let index = 0; index < (fixture.extraPrograms ?? 0); index += 1) {
    patBody.push(0x00, 2 + index, 0xe0 | 0x10, 0x80 + index);
  }

  const streamBytes: number[] = [];
  for (const stream of fixture.streams) {
    const descriptors: number[] = [...(stream.descriptors ?? [])];
    if (stream.language !== undefined) {
      descriptors.push(0x0a, 4, ...chars(stream.language), 0x00);
    }
    streamBytes.push(
      stream.streamType,
      0xe0 | ((stream.pid >> 8) & 0x1f),
      stream.pid & 0xff,
      0xf0 | ((descriptors.length >> 8) & 0x0f),
      descriptors.length & 0xff,
      ...descriptors,
    );
  }

  const pmtBody = [
    0x00,
    0x01, // programme number
    0xc1,
    0x00,
    0x00,
    0xe0 | 0x10,
    0x00, // PCR pid
    0xf0,
    0x00, // no programme-level descriptors
    ...streamBytes,
  ];

  const table = (pid: number, section: readonly number[]): Uint8Array[] =>
    tsPackets(pid, join([0x00], section), packetSize, false);

  const packets: Uint8Array[] = [
    ...table(0, tsSection(0x00, patBody)),
    ...table(pmtPid, tsSection(0x02, pmtBody)),
  ];

  for (const unit of fixture.units) {
    const video = unit.video ?? true;
    const stamps: number[] = [];
    let flags = 0;
    if (unit.pts !== undefined && unit.dts !== undefined) {
      flags = 0xc0;
      stamps.push(...pesTimestamp(3, unit.pts), ...pesTimestamp(1, unit.dts));
    } else if (unit.pts !== undefined) {
      flags = 0x80;
      stamps.push(...pesTimestamp(2, unit.pts));
    }

    // A video PES packet is allowed to declare a length of zero, meaning "to
    // the next one", and every real muxer does because a frame is longer than
    // the sixteen-bit field can hold. Audio states its real length.
    const declared = video ? 0 : 3 + stamps.length + unit.payload.byteLength;

    packets.push(
      ...tsPackets(
        unit.pid,
        join(
          [0, 0, 1, video ? 0xe0 : 0xc0],
          be(declared, 2),
          [0x80, flags, stamps.length],
          stamps,
          unit.payload,
        ),
        packetSize,
        fixture.scrambled ?? false,
      ),
    );
  }

  // Junk in front of the first packet, masked so it can never contain 0x47:
  // a transport stream recorded from partway through starts mid-packet, and
  // the detector has to find the grid rather than assume it starts at zero.
  const leading = fixture.leading ?? 0;
  const junk = new Uint8Array(leading);
  for (let index = 0; index < leading; index += 1) junk[index] = (index * 13 + 3) & 0x38;

  return join(junk, ...packets);
}

/* ========================================================================== *
 * A hand-written AVI
 * ========================================================================== */

function le(value: number, width: number): number[] {
  const out: number[] = [];
  let remaining = Math.max(0, Math.floor(value));
  for (let index = 0; index < width; index += 1) {
    out.push(remaining % 256);
    remaining = Math.floor(remaining / 256);
  }
  return out;
}

/**
 * A RIFF chunk, padded to an even length WITHOUT counting the pad in its size.
 *
 * That rule is the one thing a careless walk of this format gets wrong, and it
 * is why several of the fixtures below deliberately carry odd-length chunks: a
 * reader that advances by the stated size alone lands one byte early, reads a
 * four-character code straddling two chunks, and finds garbage from there on.
 */
function riff(id: string, ...parts: Chunk[]): Uint8Array {
  const body = join(...parts);
  const pad = body.byteLength % 2 === 1 ? [0x00] : [];
  return join(chars(id), le(body.byteLength, 4), body, pad);
}

function riffList(type: string, ...parts: Chunk[]): Uint8Array {
  return riff('LIST', chars(type), ...parts);
}

export interface AviStream {
  readonly kind: 'vids' | 'auds' | 'txts';
  /** `biCompression` for video. */
  readonly fourcc?: string;
  /** `wFormatTag` for audio. */
  readonly formatTag?: number;
  readonly scale: number;
  readonly rate: number;
  readonly width?: number;
  readonly height?: number;
  readonly channels?: number;
  readonly sampleRate?: number;
  /** Whatever follows the fixed part of `strf`. */
  readonly extra?: Uint8Array;
  /** One entry per chunk. A zero-length chunk is a dropped frame. */
  readonly chunks: readonly Uint8Array[];
  readonly keyframes?: readonly number[];
}

export interface AviFixture {
  readonly streams: readonly AviStream[];
  readonly index?: boolean;
  readonly info?: boolean;
  /** Wraps the chunks in a `rec ` list, as a disc-optimised writer does. */
  readonly grouped?: boolean;
}

/**
 * An AVI, built the way a real muxer builds one.
 *
 * Three things here are the point rather than incidental detail:
 *
 *   - The `idx1` offsets are DELIBERATE NONSENSE. Whether an AVI's index
 *     offsets are measured from the file or from the `movi` list is famously
 *     not settled, so the reader walks `movi` for positions and takes only the
 *     keyframe flags from the index. A fixture with correct offsets could not
 *     tell a reader that does the right thing from one that got lucky.
 *   - Chunks of odd length appear, so the pad byte is exercised.
 *   - A zero-length chunk can appear, which is how an AVI says "this frame is
 *     the same as the last" and which must consume a frame of time all the
 *     same.
 */
export function makeAvi(fixture: AviFixture): Uint8Array {
  const headers = fixture.streams.map((stream) => {
    const strh = join(
      chars(stream.kind),
      chars(stream.kind === 'vids' ? (stream.fourcc ?? 'H264') : 'sowt'),
      le(0, 4), // dwFlags
      le(0, 2), // wPriority
      le(0, 2), // wLanguage
      le(0, 4), // dwInitialFrames
      le(stream.scale, 4),
      le(stream.rate, 4),
      le(0, 4), // dwStart
      le(stream.chunks.length, 4),
      le(0, 4), // dwSuggestedBufferSize
      le(0, 4), // dwQuality
      le(0, 4), // dwSampleSize
      le(0, 8), // rcFrame
    );

    const strf =
      stream.kind === 'auds'
        ? join(
            le(stream.formatTag ?? 0x0055, 2),
            le(stream.channels ?? 2, 2),
            le(stream.sampleRate ?? 44_100, 4),
            le(16_000, 4), // nAvgBytesPerSec
            le(1, 2), // nBlockAlign
            le(0, 2), // wBitsPerSample
            le(stream.extra?.byteLength ?? 0, 2),
            stream.extra ?? new Uint8Array(0),
          )
        : join(
            le(40, 4), // biSize
            le(stream.width ?? 640, 4),
            le(stream.height ?? 480, 4),
            le(1, 2), // biPlanes
            le(24, 2), // biBitCount
            chars(stream.fourcc ?? 'H264'),
            le(0, 4), // biSizeImage
            le(0, 16), // the four remaining fields
            stream.extra ?? new Uint8Array(0),
          );

    return riffList('strl', riff('strh', strh), riff('strf', strf));
  });

  const suffix = (kind: AviStream['kind']): string =>
    kind === 'vids' ? 'dc' : kind === 'auds' ? 'wb' : 'tx';

  const movi: Uint8Array[] = [];
  const index: number[] = [];
  for (const [position, stream] of fixture.streams.entries()) {
    const id = `${position.toString().padStart(2, '0')}${suffix(stream.kind)}`;
    for (const [at, chunk] of stream.chunks.entries()) {
      movi.push(riff(id, chunk));
      index.push(
        ...chars(id),
        ...le((stream.keyframes ?? []).includes(at) ? 0x10 : 0, 4),
        // A chunk offset and a length that are both lies. See the note above.
        ...le(0xdeadbeef, 4),
        ...le(0xdeadbeef, 4),
      );
    }
  }

  return riff(
    'RIFF',
    chars('AVI '),
    riffList(
      'hdrl',
      riff(
        'avih',
        join(
          le(40_000, 4), // dwMicroSecPerFrame
          le(0, 4), // dwMaxBytesPerSec
          le(0, 4), // dwPaddingGranularity
          le(0x10, 4), // AVIF_HASINDEX
          le(0, 4), // dwTotalFrames
          le(0, 4), // dwInitialFrames
          le(fixture.streams.length, 4),
          le(0, 4), // dwSuggestedBufferSize
          le(640, 4),
          le(480, 4),
          le(0, 16), // dwReserved
        ),
      ),
      ...headers,
    ),
    ...(fixture.info === true ? [riffList('INFO', riff('INAM', chars('A film with a name')))] : []),
    riffList('movi', ...(fixture.grouped === true ? [riffList('rec ', ...movi)] : movi)),
    ...(fixture.index === false ? [] : [riff('idx1', index)]),
  );
}
