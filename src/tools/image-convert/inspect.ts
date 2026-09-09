/**
 * WHAT THE FILE SAYS ABOUT ITSELF, READ BEFORE ANY DECODER TOUCHES IT.
 *
 * Three questions have to be answered from the bytes, and all three are
 * answered here rather than after `createImageBitmap`:
 *
 * 1. HOW BIG IS IT. This is the one that matters most, and the reason this
 *    file exists. The pixel guard used to run on the DECODED bitmap, which
 *    reads as safe and is not: measured in this repo's own harness, a 48 kB
 *    20000x20000 PNG decodes successfully in ~2 s in both Firefox and WebKit,
 *    and by the time its dimensions are readable the browser has already
 *    committed 1.6 GB of RGBA. The canvas the old guard prevented was never
 *    the expensive allocation. Reading the header first refuses the file for
 *    the cost of parsing about forty bytes.
 *
 * 2. WHAT WILL BE LOST. Transparency flattened onto white, every frame after
 *    the first, and all metadata. Each is a silent change to the image unless
 *    the tool says so, and none of them is knowable from the decoded bitmap -
 *    a decoder hands back one opaque frame and no history.
 *
 * 3. WHAT PRIVATE INFORMATION IT CARRIES. Re-encoding through a canvas drops
 *    EXIF, GPS, timestamps and ICC profiles. That is the right behaviour for
 *    this app and it is worth stating as a promise rather than leaving as an
 *    accident - but it can only be stated about a specific file if we know
 *    what that file was carrying.
 *
 * Nothing here decompresses anything. Every parser walks a chunk or marker
 * table, is bounded, and returns partial knowledge rather than throwing: a
 * field it cannot read is `null`, and the caller falls back to the decoder.
 */

/** Formats we will decode. AVIF and SVG are deliberately absent - see README. */
export type DecodableType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

/** A kind of metadata found in the source, named for the user. */
export const METADATA_KINDS = [
  'EXIF',
  'GPS location',
  'ICC colour profile',
  'XMP',
  'IPTC',
  'Text comments',
] as const;

export type MetadataKind = (typeof METADATA_KINDS)[number];

export interface ImageHeader {
  readonly mediaType: DecodableType;
  /** Pixel dimensions from the container, or null when unreadable. */
  readonly width: number | null;
  readonly height: number | null;
  /** True when the format can carry per-pixel transparency AND says it does. */
  readonly hasAlpha: boolean;
  /**
   * Frame count, or null when the format cannot say cheaply.
   *
   * Counting is bounded (see FRAME_SCAN_LIMIT): past the limit the answer is
   * "more than this", which is all the caller needs to warn about.
   */
  readonly frames: number | null;
  readonly animated: boolean;
  /**
   * Whether the source encoding is lossless.
   *
   * Used only to decide whether re-encoding costs a generation: a JPEG that
   * becomes a JPEG loses a little more detail, and that is worth saying.
   */
  readonly lossless: boolean;
  readonly metadata: readonly MetadataKind[];
}

/**
 * Stop counting frames here.
 *
 * A frame count is only ever used to say "N frames were discarded", so the
 * difference between 400 and 4000 is worth nothing and the walk over a hostile
 * file is worth avoiding. Past this the count is reported as the limit and
 * `animated` carries the meaning.
 */
const FRAME_SCAN_LIMIT = 1_000;

/** Stop walking a chunk or marker table here, however long the file is. */
const CHUNK_SCAN_LIMIT = 4_096;

function readU32BE(bytes: Uint8Array, offset: number): number | null {
  if (offset + 4 > bytes.length) return null;
  // `>>> 0` keeps it unsigned: a PNG width with the top bit set is nonsense,
  // but it should arrive as a huge positive number that the limit check
  // rejects, not as a negative one that slips under it.
  return (
    ((bytes[offset] ?? 0) * 0x1000000 +
      ((bytes[offset + 1] ?? 0) << 16) +
      ((bytes[offset + 2] ?? 0) << 8) +
      (bytes[offset + 3] ?? 0)) >>>
    0
  );
}

/** RIFF, and every field inside a WebP bitstream, is little-endian. */
function readU32LE(bytes: Uint8Array, offset: number): number | null {
  if (offset + 4 > bytes.length) return null;
  return (
    ((bytes[offset + 3] ?? 0) * 0x1000000 +
      ((bytes[offset + 2] ?? 0) << 16) +
      ((bytes[offset + 1] ?? 0) << 8) +
      (bytes[offset] ?? 0)) >>>
    0
  );
}

function readU16BE(bytes: Uint8Array, offset: number): number | null {
  if (offset + 2 > bytes.length) return null;
  return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
}

function readU16LE(bytes: Uint8Array, offset: number): number | null {
  if (offset + 2 > bytes.length) return null;
  return ((bytes[offset + 1] ?? 0) << 8) | (bytes[offset] ?? 0);
}

function readU24LE(bytes: Uint8Array, offset: number): number | null {
  if (offset + 3 > bytes.length) return null;
  return ((bytes[offset + 2] ?? 0) << 16) | ((bytes[offset + 1] ?? 0) << 8) | (bytes[offset] ?? 0);
}

/** ASCII at an offset, for four-character chunk and marker tags. */
function tagAt(bytes: Uint8Array, offset: number, length: number): string {
  if (offset + length > bytes.length) return '';
  let out = '';
  for (let index = 0; index < length; index += 1)
    out += String.fromCharCode(bytes[offset + index] ?? 0);
  return out;
}

/* ========================================================================== *
 * PNG
 * ========================================================================== */

/**
 * PNG is the friendliest of the four: IHDR is mandatory, first, and fixed.
 *
 * Alpha is not one flag. Colour types 4 and 6 carry an alpha channel; types 0,
 * 2 and 3 carry transparency only if a tRNS chunk is present, which is how
 * most small transparent PNGs (palette + tRNS) are actually written. Reading
 * only the colour type would report a transparent logo as opaque and skip the
 * warning that matters most.
 */
function inspectPng(bytes: Uint8Array): ImageHeader {
  const metadata = new Set<MetadataKind>();
  let width: number | null = null;
  let height: number | null = null;
  let hasAlpha = false;
  let frames: number | null = 1;
  let animated = false;

  if (tagAt(bytes, 12, 4) === 'IHDR') {
    width = readU32BE(bytes, 16);
    height = readU32BE(bytes, 20);
    const colourType = bytes[25] ?? 0;
    hasAlpha = colourType === 4 || colourType === 6;
  }

  let offset = 8;
  for (let scanned = 0; scanned < CHUNK_SCAN_LIMIT; scanned += 1) {
    const length = readU32BE(bytes, offset);
    if (length === null) break;
    const type = tagAt(bytes, offset + 4, 4);
    if (type === '' || type === 'IEND') break;

    if (type === 'tRNS') hasAlpha = true;
    else if (type === 'iCCP') metadata.add('ICC colour profile');
    else if (type === 'eXIf') {
      metadata.add('EXIF');
      if (exifHasGps(bytes.subarray(offset + 8, offset + 8 + length))) metadata.add('GPS location');
    } else if (type === 'tEXt' || type === 'zTXt' || type === 'iTXt') {
      // XMP travels as an iTXt whose keyword is this exact string; anything
      // else in a text chunk is a comment, an author, a source program.
      if (tagAt(bytes, offset + 8, 17) === 'XML:com.adobe.xmp') metadata.add('XMP');
      else metadata.add('Text comments');
    } else if (type === 'acTL') {
      // APNG. Browsers that support it animate it; the ones that do not show
      // the still IDAT. Either way only one frame survives a canvas.
      animated = true;
      const count = readU32BE(bytes, offset + 8);
      frames = count === null ? null : Math.min(count, FRAME_SCAN_LIMIT);
    }

    // The 12 is length + type + CRC. A length that overflows the file ends the
    // walk rather than wrapping into a negative offset.
    const next = offset + 12 + length;
    if (next <= offset || next > bytes.length) break;
    offset = next;
  }

  return {
    mediaType: 'image/png',
    width,
    height,
    hasAlpha,
    frames,
    animated,
    lossless: true,
    metadata: [...metadata],
  };
}

/* ========================================================================== *
 * JPEG
 * ========================================================================== */

/** Start-of-frame markers. C4, C8 and CC are in the range and are not frames. */
function isStartOfFrame(marker: number): boolean {
  if (marker < 0xc0 || marker > 0xcf) return false;
  return marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

/**
 * Does this EXIF payload contain a GPS IFD?
 *
 * Only the top-level IFD0 tag list is read, looking for tag 0x8825. That is
 * the pointer every GPS-tagged photo carries, and following it to read the
 * coordinates would be pointless: the tool is about to discard them, and it
 * needs to say "there were coordinates", not what they were.
 */
function exifHasGps(payload: Uint8Array): boolean {
  // 'Exif\0\0' then a TIFF header, or a bare TIFF header in a PNG eXIf chunk.
  const base = tagAt(payload, 0, 4) === 'Exif' ? 6 : 0;
  const order = tagAt(payload, base, 2);
  if (order !== 'II' && order !== 'MM') return false;
  const big = order === 'MM';
  const u16 = (at: number) => (big ? readU16BE(payload, at) : readU16LE(payload, at));
  const u32 = (at: number) => {
    if (big) return readU32BE(payload, at);
    if (at + 4 > payload.length) return null;
    return (
      (((payload[at + 3] ?? 0) << 24) >>> 0) +
      ((payload[at + 2] ?? 0) << 16) +
      ((payload[at + 1] ?? 0) << 8) +
      (payload[at] ?? 0)
    );
  };

  const ifdOffset = u32(base + 4);
  if (ifdOffset === null) return false;
  const ifd = base + ifdOffset;
  const count = u16(ifd);
  if (count === null) return false;

  for (let index = 0; index < Math.min(count, 512); index += 1) {
    const entry = ifd + 2 + index * 12;
    if (entry + 12 > payload.length) break;
    if (u16(entry) === 0x8825) return true;
  }
  return false;
}

/**
 * JPEG is a marker stream, and the only safe way through it is to respect the
 * declared segment lengths. Two things are load-bearing against a hostile file:
 * a segment length below 2 would walk backwards forever, and entropy-coded
 * scan data after SOS contains bytes that look exactly like markers - so the
 * walk stops at SOS rather than trying to skip the scan.
 */
function inspectJpeg(bytes: Uint8Array): ImageHeader {
  const metadata = new Set<MetadataKind>();
  let width: number | null = null;
  let height: number | null = null;

  let offset = 2;
  for (let scanned = 0; scanned < CHUNK_SCAN_LIMIT; scanned += 1) {
    if (offset + 4 > bytes.length) break;
    if (bytes[offset] !== 0xff) break;
    const marker = bytes[offset + 1] ?? 0;

    // Standalone markers: no length, no payload.
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      offset += 2;
      continue;
    }
    // Start of scan. Everything after this is entropy-coded and full of bytes
    // that look like markers; the frame header is already behind us.
    if (marker === 0xda || marker === 0xd9) break;

    const length = readU16BE(bytes, offset + 2);
    if (length === null || length < 2) break;
    const payload = bytes.subarray(offset + 4, offset + 2 + length);

    if (isStartOfFrame(marker) && width === null) {
      // SOFn payload: precision(1), height(2), width(2).
      height = readU16BE(bytes, offset + 5);
      width = readU16BE(bytes, offset + 7);
    } else if (marker === 0xe1) {
      if (tagAt(payload, 0, 4) === 'Exif') {
        metadata.add('EXIF');
        if (exifHasGps(payload)) metadata.add('GPS location');
      } else if (tagAt(payload, 0, 28) === 'http://ns.adobe.com/xap/1.0/') {
        metadata.add('XMP');
      }
    } else if (marker === 0xe2 && tagAt(payload, 0, 11) === 'ICC_PROFILE') {
      metadata.add('ICC colour profile');
    } else if (marker === 0xed && tagAt(payload, 0, 13) === 'Photoshop 3.0') {
      metadata.add('IPTC');
    } else if (marker === 0xfe) {
      metadata.add('Text comments');
    }

    const next = offset + 2 + length;
    if (next <= offset) break;
    offset = next;
  }

  return {
    mediaType: 'image/jpeg',
    width,
    height,
    // Baseline and progressive JPEG have no alpha channel. There is no flag to
    // read: the format simply cannot carry one.
    hasAlpha: false,
    frames: 1,
    animated: false,
    lossless: false,
    metadata: [...metadata],
  };
}

/* ========================================================================== *
 * GIF
 * ========================================================================== */

/**
 * The GIF logical screen is not the whole answer.
 *
 * A frame's image descriptor carries its own width, height and offset, and
 * nothing in the format requires them to fit inside the declared screen. So a
 * hostile file can declare a 1x1 screen and hold a 20000x20000 frame. The
 * dimensions reported here are the largest extent any frame reaches, which is
 * the number a limit check has to be applied to; browsers size the bitmap from
 * the logical screen, so this is deliberately the conservative reading.
 */
function inspectGif(bytes: Uint8Array): ImageHeader {
  const screenWidth = readU16LE(bytes, 6);
  const screenHeight = readU16LE(bytes, 8);
  let width = screenWidth;
  let height = screenHeight;
  let hasAlpha = false;
  let frames = 0;
  const metadata = new Set<MetadataKind>();

  const packed = bytes[10] ?? 0;
  let offset = 13;
  // Global colour table, if the flag is set: 3 bytes per entry, 2^(N+1) entries.
  if ((packed & 0x80) !== 0) offset += 3 * 2 ** ((packed & 0x07) + 1);

  const skipSubBlocks = (from: number): number => {
    let at = from;
    for (let guard = 0; guard < CHUNK_SCAN_LIMIT; guard += 1) {
      const size = bytes[at];
      if (size === undefined || size === 0) return at + 1;
      at += size + 1;
      if (at > bytes.length) return bytes.length;
    }
    return bytes.length;
  };

  for (let scanned = 0; scanned < CHUNK_SCAN_LIMIT && offset < bytes.length; scanned += 1) {
    const block = bytes[offset];
    if (block === 0x3b || block === undefined) break;

    if (block === 0x21) {
      const label = bytes[offset + 1] ?? 0;
      if (label === 0xf9) {
        // Graphic control extension: bit 0 of its flags is "transparent colour".
        if (((bytes[offset + 3] ?? 0) & 0x01) !== 0) hasAlpha = true;
      } else if (label === 0xfe) {
        metadata.add('Text comments');
      }
      offset = skipSubBlocks(offset + 2);
      continue;
    }

    if (block === 0x2c) {
      frames += 1;
      const left = readU16LE(bytes, offset + 1) ?? 0;
      const top = readU16LE(bytes, offset + 3) ?? 0;
      const frameWidth = readU16LE(bytes, offset + 5) ?? 0;
      const frameHeight = readU16LE(bytes, offset + 7) ?? 0;
      width = Math.max(width ?? 0, left + frameWidth);
      height = Math.max(height ?? 0, top + frameHeight);
      if (frames >= FRAME_SCAN_LIMIT) break;

      const localPacked = bytes[offset + 9] ?? 0;
      let after = offset + 10;
      if ((localPacked & 0x80) !== 0) after += 3 * 2 ** ((localPacked & 0x07) + 1);
      // LZW minimum code size, then the image data as sub-blocks.
      offset = skipSubBlocks(after + 1);
      continue;
    }

    break;
  }

  return {
    mediaType: 'image/gif',
    width,
    height,
    hasAlpha,
    frames: frames === 0 ? null : frames,
    animated: frames > 1,
    // Palette quantisation happens before the file exists; the encoding of
    // whatever colours survived into the palette is itself lossless.
    lossless: true,
    metadata: [...metadata],
  };
}

/* ========================================================================== *
 * WebP
 * ========================================================================== */

/** VP8X feature flags, MSB first: ICC, alpha, EXIF, XMP, animation. */
const VP8X_ICC = 0x20;
const VP8X_ALPHA = 0x10;
const VP8X_EXIF = 0x08;
const VP8X_XMP = 0x04;
const VP8X_ANIMATION = 0x02;

/**
 * WebP is three formats behind one magic number, and the dimensions live in a
 * different place in each: an extended file states them in VP8X, a lossy one
 * hides them behind the VP8 keyframe start code, and a lossless one packs
 * them as two 14-bit fields inside a bit stream. All three are here because a
 * limit check that only understood VP8X would have nothing to say about the
 * plain lossy file every canvas in every browser produces.
 */
function inspectWebp(bytes: Uint8Array): ImageHeader {
  let width: number | null = null;
  let height: number | null = null;
  let hasAlpha = false;
  let animated = false;
  let frames: number | null = null;
  let lossless = false;
  const metadata = new Set<MetadataKind>();

  let offset = 12;
  for (let scanned = 0; scanned < CHUNK_SCAN_LIMIT && offset + 8 <= bytes.length; scanned += 1) {
    const id = tagAt(bytes, offset, 4);
    // RIFF chunk sizes are LITTLE-endian, unlike PNG's and JPEG's.
    const length = readU32LE(bytes, offset + 4);
    if (length === null) break;
    const body = offset + 8;

    if (id === 'VP8X') {
      const flags = bytes[body] ?? 0;
      if ((flags & VP8X_ALPHA) !== 0) hasAlpha = true;
      if ((flags & VP8X_ANIMATION) !== 0) animated = true;
      if ((flags & VP8X_ICC) !== 0) metadata.add('ICC colour profile');
      if ((flags & VP8X_EXIF) !== 0) metadata.add('EXIF');
      if ((flags & VP8X_XMP) !== 0) metadata.add('XMP');
      const canvasWidth = readU24LE(bytes, body + 4);
      const canvasHeight = readU24LE(bytes, body + 7);
      if (canvasWidth !== null) width = canvasWidth + 1;
      if (canvasHeight !== null) height = canvasHeight + 1;
    } else if (id === 'VP8 ' && width === null) {
      // Keyframe: a 3-byte frame tag, the start code 9d 01 2a, then two 16-bit
      // little-endian fields whose low 14 bits are the dimensions.
      const startCode =
        bytes[body + 3] === 0x9d && bytes[body + 4] === 0x01 && bytes[body + 5] === 0x2a;
      if (startCode) {
        const rawWidth = readU16LE(bytes, body + 6);
        const rawHeight = readU16LE(bytes, body + 8);
        if (rawWidth !== null) width = rawWidth & 0x3fff;
        if (rawHeight !== null) height = rawHeight & 0x3fff;
      }
    } else if (id === 'VP8L' && width === null) {
      // 0x2f signature, then 14 bits width-1, 14 bits height-1, 1 alpha bit,
      // packed little-endian into the four bytes that follow it.
      if (bytes[body] === 0x2f) {
        lossless = true;
        const packed = readU32LE(bytes, body + 1);
        if (packed !== null) {
          width = (packed & 0x3fff) + 1;
          height = ((packed >>> 14) & 0x3fff) + 1;
          if (((packed >>> 28) & 0x01) !== 0) hasAlpha = true;
        }
      }
    } else if (id === 'ALPH') {
      hasAlpha = true;
    } else if (id === 'ANMF') {
      frames = Math.min((frames ?? 0) + 1, FRAME_SCAN_LIMIT);
      animated = true;
    } else if (id === 'EXIF') {
      metadata.add('EXIF');
      if (exifHasGps(bytes.subarray(body, body + length))) metadata.add('GPS location');
    } else if (id === 'ICCP') {
      metadata.add('ICC colour profile');
    } else if (id === 'XMP ') {
      metadata.add('XMP');
    }

    // Chunks are padded to an even length.
    const next = body + length + (length % 2);
    if (next <= offset || next > bytes.length) break;
    offset = next;
  }

  return {
    mediaType: 'image/webp',
    width,
    height,
    hasAlpha,
    frames: animated ? (frames ?? null) : 1,
    animated,
    lossless,
    metadata: [...metadata],
  };
}

/* ========================================================================== *
 * Entry point
 * ========================================================================== */

/**
 * Read what the container says, without decoding a pixel.
 *
 * Returns null only for a media type this tool does not decode. Every other
 * field may individually be null: a header we could not read is reported as
 * unknown, and the caller falls back to the decoder rather than refusing a
 * file it simply failed to understand.
 */
export function inspectImage(bytes: Uint8Array, mediaType: DecodableType): ImageHeader {
  switch (mediaType) {
    case 'image/png':
      return inspectPng(bytes);
    case 'image/jpeg':
      return inspectJpeg(bytes);
    case 'image/gif':
      return inspectGif(bytes);
    case 'image/webp':
      return inspectWebp(bytes);
  }
}
