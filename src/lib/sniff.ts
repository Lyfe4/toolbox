/**
 * Content sniffing from magic bytes.
 *
 * A file's declared `type` comes from the operating system's extension mapping
 * and is trivially wrong: rename `payload.exe` to `notes.json` and the browser
 * will cheerfully report `application/json`. Nothing here trusts it. Where a
 * tool cares what a file actually is, the answer comes from the bytes.
 */

export interface SniffResult {
  /** Media type inferred from the bytes, or null when nothing matched. */
  readonly mediaType: string | null;
  /** Human label for the UI, e.g. "PNG image". */
  readonly label: string;
  /** Whether the content can sensibly be handed to a text-only tool. */
  readonly isProbablyText: boolean;
}

interface Signature {
  /**
   * The bytes to match. `null` is a wildcard for one byte, which is what makes
   * a container signature expressible: a WebP file is RIFF, then a length
   * nobody can predict, then WEBP.
   */
  readonly bytes: readonly (number | null)[];
  readonly offset: number;
  readonly mediaType: string;
  readonly label: string;
}

const SIGNATURES: readonly Signature[] = [
  { bytes: [0x89, 0x50, 0x4e, 0x47], offset: 0, mediaType: 'image/png', label: 'PNG image' },
  { bytes: [0xff, 0xd8, 0xff], offset: 0, mediaType: 'image/jpeg', label: 'JPEG image' },
  { bytes: [0x47, 0x49, 0x46, 0x38], offset: 0, mediaType: 'image/gif', label: 'GIF image' },
  {
    /*
     * RIFF, four bytes of length, WEBP. Matching only the WEBP at offset 8 -
     * which is what this did - calls any file with those four bytes in that
     * position a WebP image, and the RIFF container is the whole reason they
     * are there. The decoder rejects such a file anyway, so this buys a
     * truthful error message rather than an opaque one.
     */
    bytes: [0x52, 0x49, 0x46, 0x46, null, null, null, null, 0x57, 0x45, 0x42, 0x50],
    offset: 0,
    mediaType: 'image/webp',
    label: 'WebP image',
  },
  /*
   * The ISO base media family, matched on the `ftyp` box that opens the file
   * rather than on any one brand. Three entries, in this order, because the
   * brand is the only thing that separates a film from a song from a
   * QuickTime recording - and every one of them is `ftyp` at offset 4.
   *
   * Nothing here tries to distinguish HEIC, which is also `ftyp`: it would be
   * labelled as an MP4, and the tool that opens it says what it really found.
   * A sniff is a coarse "what is this", and the readers do not trust it.
   */
  {
    bytes: [0x66, 0x74, 0x79, 0x70, 0x71, 0x74, 0x20, 0x20],
    offset: 4,
    mediaType: 'video/quicktime',
    label: 'QuickTime video',
  },
  {
    bytes: [0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20],
    offset: 4,
    mediaType: 'audio/mp4',
    label: 'MPEG-4 audio',
  },
  {
    bytes: [0x66, 0x74, 0x79, 0x70],
    offset: 4,
    mediaType: 'video/mp4',
    label: 'MP4 video',
  },
  /*
   * EBML, which is Matroska and WebM alike. Which one it is lives in a DocType
   * element at a position that varies, so this signature cannot say - and the
   * label does not pretend to. `readMatroska` reads the DocType properly.
   */
  {
    bytes: [0x1a, 0x45, 0xdf, 0xa3],
    offset: 0,
    mediaType: 'video/x-matroska',
    label: 'Matroska or WebM video',
  },
  {
    bytes: [0x25, 0x50, 0x44, 0x46],
    offset: 0,
    mediaType: 'application/pdf',
    label: 'PDF document',
  },
  {
    bytes: [0x50, 0x4b, 0x03, 0x04],
    offset: 0,
    mediaType: 'application/zip',
    label: 'ZIP archive',
  },
  { bytes: [0x1f, 0x8b], offset: 0, mediaType: 'application/gzip', label: 'gzip archive' },
  {
    bytes: [0x7f, 0x45, 0x4c, 0x46],
    offset: 0,
    mediaType: 'application/x-elf',
    label: 'ELF binary',
  },
  {
    bytes: [0x4d, 0x5a],
    offset: 0,
    mediaType: 'application/x-msdownload',
    label: 'Windows executable',
  },
];

function matches(bytes: Uint8Array, signature: Signature): boolean {
  if (bytes.length < signature.offset + signature.bytes.length) return false;
  return signature.bytes.every(
    (byte, index) => byte === null || bytes[signature.offset + index] === byte,
  );
}

/** UTF-8, UTF-16 LE and UTF-16 BE byte order marks. */
function hasTextBom(bytes: Uint8Array): boolean {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return true;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return true;
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return true;
  return false;
}

/**
 * Heuristic: text does not contain NUL, and is overwhelmingly printable.
 *
 * Only the first 4 kB is examined - enough to be confident, cheap on a large
 * file, and the same window browsers use for their own sniffing.
 */
function looksLikeText(bytes: Uint8Array): boolean {
  const window = bytes.subarray(0, 4096);
  if (window.length === 0) return true;

  let suspicious = 0;
  for (const byte of window) {
    // NUL essentially never appears in text and is the strongest single signal.
    if (byte === 0) return false;
    // Control characters other than tab, LF, CR and form feed.
    if (byte < 0x09 || (byte > 0x0d && byte < 0x20)) suspicious += 1;
  }

  return suspicious / window.length < 0.05;
}

export function sniffBytes(bytes: Uint8Array): SniffResult {
  for (const signature of SIGNATURES) {
    if (matches(bytes, signature)) {
      return { mediaType: signature.mediaType, label: signature.label, isProbablyText: false };
    }
  }

  if (hasTextBom(bytes)) {
    return { mediaType: 'text/plain', label: 'Text (with BOM)', isProbablyText: true };
  }

  if (looksLikeText(bytes)) {
    return { mediaType: 'text/plain', label: 'Text', isProbablyText: true };
  }

  return { mediaType: null, label: 'Binary data', isProbablyText: false };
}

/** Human-readable size, for file summaries and limit messages. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes.toString()} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
