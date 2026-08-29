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
  readonly bytes: readonly number[];
  readonly offset: number;
  readonly mediaType: string;
  readonly label: string;
}

const SIGNATURES: readonly Signature[] = [
  { bytes: [0x89, 0x50, 0x4e, 0x47], offset: 0, mediaType: 'image/png', label: 'PNG image' },
  { bytes: [0xff, 0xd8, 0xff], offset: 0, mediaType: 'image/jpeg', label: 'JPEG image' },
  { bytes: [0x47, 0x49, 0x46, 0x38], offset: 0, mediaType: 'image/gif', label: 'GIF image' },
  { bytes: [0x57, 0x45, 0x42, 0x50], offset: 8, mediaType: 'image/webp', label: 'WebP image' },
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
  return signature.bytes.every((byte, index) => bytes[signature.offset + index] === byte);
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
