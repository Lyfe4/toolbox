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
