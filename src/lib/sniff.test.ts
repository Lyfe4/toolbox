import { describe, expect, it } from 'vitest';

import { formatBytes, sniffBytes } from './sniff';

function bytesOf(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

describe('sniffBytes', () => {
  it('identifies common formats from their magic bytes', () => {
    expect(sniffBytes(bytesOf(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a)).mediaType).toBe('image/png');
    expect(sniffBytes(bytesOf(0xff, 0xd8, 0xff, 0xe0)).mediaType).toBe('image/jpeg');
    expect(sniffBytes(bytesOf(0x25, 0x50, 0x44, 0x46, 0x2d)).mediaType).toBe('application/pdf');
    expect(sniffBytes(bytesOf(0x50, 0x4b, 0x03, 0x04)).mediaType).toBe('application/zip');
    expect(sniffBytes(bytesOf(0x1f, 0x8b, 0x08)).mediaType).toBe('application/gzip');
    expect(sniffBytes(bytesOf(0x4d, 0x5a, 0x90)).label).toBe('Windows executable');
  });

  it('finds a signature that is not at offset zero', () => {
    // WEBP sits at byte 8, after the RIFF header.
    const webp = bytesOf(0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50);
    expect(sniffBytes(webp).mediaType).toBe('image/webp');
  });

  /*
   * THE ISO BASE MEDIA FAMILY, WHICH IS FOUR FORMATS BEHIND ONE SIGNATURE.
   *
   * `ftyp` at byte 4 is an MP4, a MOV, an M4A and a 3GP alike, and the brand
   * that follows it is the only thing separating them. The order of the
   * signatures is therefore load-bearing: the two specific brands have to be
   * tried before the general one, or every song is reported as a film.
   */
  const ftyp = (brand: string): Uint8Array =>
    new Uint8Array([
      0,
      0,
      0,
      0x18,
      0x66,
      0x74,
      0x79,
      0x70,
      ...brand.split('').map((c) => c.charCodeAt(0)),
    ]);

  it('tells the ISO base media brands apart', () => {
    expect(sniffBytes(ftyp('isom')).mediaType).toBe('video/mp4');
    expect(sniffBytes(ftyp('mp42')).label).toBe('MP4 video');
    expect(sniffBytes(ftyp('qt  ')).mediaType).toBe('video/quicktime');
    expect(sniffBytes(ftyp('M4A ')).mediaType).toBe('audio/mp4');
  });

  it('recognises EBML without claiming to know which flavour it is', () => {
    // Matroska and WebM share the signature, and the DocType that separates
    // them is at a position this cannot depend on. The tool that opens the
    // file reads it properly; a sniff that guessed would be wrong half the
    // time about which one it was looking at.
    const ebml = bytesOf(0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x00, 0x00, 0x00);
    expect(sniffBytes(ebml).mediaType).toBe('video/x-matroska');
    expect(sniffBytes(ebml).isProbablyText).toBe(false);
  });

  it('marks recognised binary formats as not text', () => {
    expect(sniffBytes(bytesOf(0x89, 0x50, 0x4e, 0x47)).isProbablyText).toBe(false);
  });

  it('recognises text, including with a BOM', () => {
    expect(sniffBytes(new TextEncoder().encode('{"a":1}')).isProbablyText).toBe(true);
    expect(sniffBytes(bytesOf(0xef, 0xbb, 0xbf, 0x68, 0x69)).label).toBe('Text (with BOM)');
    expect(sniffBytes(bytesOf(0xff, 0xfe, 0x68, 0x00)).isProbablyText).toBe(true);
  });

  it('treats a NUL byte as decisive evidence of binary', () => {
    expect(sniffBytes(bytesOf(0x68, 0x69, 0x00, 0x68)).isProbablyText).toBe(false);
  });

  it('treats an empty file as text', () => {
    expect(sniffBytes(bytesOf()).isProbablyText).toBe(true);
  });

  it('tolerates tabs, newlines and carriage returns in text', () => {
    const crlf = new TextEncoder().encode('a,b\r\n1,2\r\n\tindented');
    expect(sniffBytes(crlf).isProbablyText).toBe(true);
  });

  it('rejects a run of control characters as binary', () => {
    expect(sniffBytes(new Uint8Array(64).fill(0x01)).isProbablyText).toBe(false);
  });

  /**
   * The point of sniffing: a renamed file lies about what it is, and the
   * browser repeats the lie from the extension. Only the bytes are trustworthy.
   */
  it('ignores what a file claims to be', () => {
    const pngBytesNamedJson = bytesOf(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
    const result = sniffBytes(pngBytesNamedJson);
    expect(result.mediaType).toBe('image/png');
    expect(result.isProbablyText).toBe(false);
  });
});

describe('formatBytes', () => {
  it('scales its unit', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 kB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });
});
