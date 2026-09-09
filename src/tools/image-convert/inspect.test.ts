import { describe, expect, it } from 'vitest';

import {
  ascii,
  concat,
  exifBlock,
  gif,
  jpeg,
  jpegExif,
  jpegSegment,
  png,
  pngChunk,
  u32be,
  webpExtended,
  webpLossless,
  webpLossy,
} from './fixtures';
import { inspectImage } from './inspect';

/*
 * WHY THIS FILE EXISTS AT ALL.
 *
 * Everything the tool tells the user about what a conversion cost - the
 * transparency it flattened, the frames it dropped, the location data it
 * removed - is read out of the container header, not out of the decoded
 * bitmap. A decoder hands back one opaque frame and no history.
 *
 * And the limit that stops a decompression bomb is applied to these numbers,
 * BEFORE any decoder runs. Measured in the cross-browser harness: a 48 kB
 * 20000x20000 PNG decodes successfully in ~2 s in Firefox and WebKit, having
 * committed 1.6 GB of RGBA on the way. A guard that reads `bitmap.width` has
 * already lost. So a wrong answer here is not a cosmetic wrong answer.
 */

describe('PNG', () => {
  it('reads dimensions from IHDR', () => {
    const header = inspectImage(png({ width: 1234, height: 567 }), 'image/png');
    expect(header.width).toBe(1234);
    expect(header.height).toBe(567);
  });

  it('reports an RGBA image as carrying alpha', () => {
    expect(inspectImage(png({ colourType: 6 }), 'image/png').hasAlpha).toBe(true);
    expect(inspectImage(png({ colourType: 4 }), 'image/png').hasAlpha).toBe(true);
  });

  it('reports a plain RGB image as opaque', () => {
    expect(inspectImage(png({ colourType: 2 }), 'image/png').hasAlpha).toBe(false);
  });

  /*
   * Caught: transparency reported as absent for the most common kind of
   * transparent PNG there is. A palette image carries its transparency in a
   * tRNS chunk rather than in the colour type, so reading only the colour type
   * calls every transparent logo, icon and screenshot-with-rounded-corners
   * opaque - and skips the one warning that matters most when the target is
   * JPEG.
   */
  it('reports a palette image with tRNS as carrying alpha', () => {
    const header = inspectImage(
      png({ colourType: 3, before: [pngChunk('tRNS', new Uint8Array([0]))] }),
      'image/png',
    );
    expect(header.hasAlpha).toBe(true);
  });

  it('names the metadata it finds, and finds GPS inside EXIF', () => {
    const header = inspectImage(
      png({
        before: [
          pngChunk('eXIf', exifBlock({ gps: true })),
          pngChunk('iCCP', ascii('profile\0\0')),
          pngChunk('iTXt', ascii('XML:com.adobe.xmp\0')),
        ],
      }),
      'image/png',
    );
    expect(header.metadata).toContain('EXIF');
    expect(header.metadata).toContain('GPS location');
    expect(header.metadata).toContain('ICC colour profile');
    expect(header.metadata).toContain('XMP');
  });

  it('separates a plain text chunk from an XMP one', () => {
    const header = inspectImage(
      png({ before: [pngChunk('tEXt', ascii('Comment\0hello'))] }),
      'image/png',
    );
    expect(header.metadata).toEqual(['Text comments']);
  });

  it('reports an APNG as animated, with its frame count', () => {
    const header = inspectImage(
      png({ before: [pngChunk('acTL', concat([u32be(12), u32be(0)]))] }),
      'image/png',
    );
    expect(header.animated).toBe(true);
    expect(header.frames).toBe(12);
  });

  it('reports an ordinary PNG as a single still frame', () => {
    const header = inspectImage(png(), 'image/png');
    expect(header.animated).toBe(false);
    expect(header.frames).toBe(1);
  });

  /*
   * A chunk length is a 32-bit number the file chooses. A length that runs
   * past the end of the buffer must end the walk, not index into nothing
   * forever or wrap to a negative offset.
   */
  it('stops walking when a chunk length overruns the file', () => {
    const hostile = concat([
      png().subarray(0, 33),
      u32be(0xfffffff0),
      ascii('tEXt'),
      new Uint8Array(4),
    ]);
    const header = inspectImage(hostile, 'image/png');
    expect(header.width).toBe(4);
  });

  it('reports unknown dimensions rather than guessing when IHDR is missing', () => {
    const header = inspectImage(
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]),
      'image/png',
    );
    expect(header.width).toBeNull();
    expect(header.height).toBeNull();
  });
});

describe('JPEG', () => {
  it('reads dimensions from the start-of-frame marker', () => {
    const header = inspectImage(jpeg({ width: 4032, height: 3024 }), 'image/jpeg');
    expect(header.width).toBe(4032);
    expect(header.height).toBe(3024);
  });

  it('reads them from a progressive frame too', () => {
    const header = inspectImage(jpeg({ width: 800, height: 600, sofMarker: 0xc2 }), 'image/jpeg');
    expect(header.width).toBe(800);
  });

  /*
   * 0xC4 is a Huffman table, not a frame, and it sits squarely in the
   * 0xC0-0xCF range. Treating the range as "all frames" reads four bytes of
   * Huffman code lengths as a width and a height, which is a plausible pair of
   * numbers and a completely wrong image size - and, since the limit check now
   * runs on these numbers, either a refused photograph or a decoded bomb.
   */
  it('does not mistake a Huffman table for a frame header', () => {
    const header = inspectImage(
      jpeg({
        width: 100,
        height: 50,
        segments: [jpegSegment(0xc4, new Uint8Array([0x00, 0xff, 0xff, 0xff, 0xff]))],
      }),
      'image/jpeg',
    );
    expect(header.width).toBe(100);
    expect(header.height).toBe(50);
  });

  it('finds EXIF, and the GPS pointer inside it', () => {
    const header = inspectImage(
      jpeg({ segments: [jpegExif({ orientation: 6, gps: true })] }),
      'image/jpeg',
    );
    expect(header.metadata).toContain('EXIF');
    expect(header.metadata).toContain('GPS location');
  });

  it('does not claim GPS for an EXIF block that has none', () => {
    const header = inspectImage(jpeg({ segments: [jpegExif({ orientation: 6 })] }), 'image/jpeg');
    expect(header.metadata).toContain('EXIF');
    expect(header.metadata).not.toContain('GPS location');
  });

  it('finds an ICC profile, XMP, IPTC and a comment', () => {
    const header = inspectImage(
      jpeg({
        segments: [
          jpegSegment(0xe2, concat([ascii('ICC_PROFILE'), new Uint8Array(4)])),
          jpegSegment(0xe1, ascii('http://ns.adobe.com/xap/1.0/\0<x/>')),
          jpegSegment(0xed, ascii('Photoshop 3.0\0')),
          jpegSegment(0xfe, ascii('taken on a phone')),
        ],
      }),
      'image/jpeg',
    );
    expect([...header.metadata].sort()).toEqual([
      'ICC colour profile',
      'IPTC',
      'Text comments',
      'XMP',
    ]);
  });

  it('has no alpha, because the format cannot carry one', () => {
    expect(inspectImage(jpeg(), 'image/jpeg').hasAlpha).toBe(false);
  });

  /*
   * A segment length below 2 makes the walk step backwards, which is an
   * infinite loop on a file anyone can write in a hex editor. The scan limit
   * would eventually stop it; the length check stops it immediately and keeps
   * the dimensions read before the bad segment.
   */
  it('stops rather than looping on a segment claiming a length of zero', () => {
    const hostile = concat([
      new Uint8Array([0xff, 0xd8]),
      jpegSegment(
        0xc0,
        concat([new Uint8Array([8]), new Uint8Array([0, 40, 0, 60]), new Uint8Array([1])]),
      ),
      new Uint8Array([0xff, 0xe0, 0x00, 0x00]),
      new Uint8Array(64),
    ]);
    const header = inspectImage(hostile, 'image/jpeg');
    expect(header.width).toBe(60);
    expect(header.height).toBe(40);
  });

  /*
   * Entropy-coded scan data is full of bytes that look like markers, and a
   * walk that tried to skip the scan would read them as segments. The bytes
   * appended here spell a comment marker; a walk that carried on past SOS
   * reports a comment this file does not have, and would go on to report
   * whatever else the compressed pixels happened to spell.
   */
  it('stops at the start of scan rather than reading entropy data as markers', () => {
    const withScan = concat([
      jpeg({ width: 20, height: 10 }),
      jpegSegment(0xfe, ascii('not really a comment')),
    ]);
    const header = inspectImage(withScan, 'image/jpeg');
    expect(header.width).toBe(20);
    expect(header.metadata).toEqual([]);
  });
});

describe('GIF', () => {
  it('reads the logical screen size', () => {
    const header = inspectImage(gif({ screenWidth: 320, screenHeight: 240 }), 'image/gif');
    expect(header.width).toBe(320);
    expect(header.height).toBe(240);
  });

  it('counts frames, and calls more than one animated', () => {
    const still = inspectImage(gif({ frames: [{ width: 8, height: 8 }] }), 'image/gif');
    expect(still.frames).toBe(1);
    expect(still.animated).toBe(false);

    const moving = inspectImage(
      gif({
        frames: [
          { width: 8, height: 8 },
          { width: 8, height: 8 },
          { width: 8, height: 8 },
        ],
      }),
      'image/gif',
    );
    expect(moving.frames).toBe(3);
    expect(moving.animated).toBe(true);
  });

  it('reads the transparent-colour flag', () => {
    expect(inspectImage(gif({ transparent: true }), 'image/gif').hasAlpha).toBe(true);
    expect(inspectImage(gif({ transparent: false }), 'image/gif').hasAlpha).toBe(false);
  });

  /*
   * Caught before it shipped: a GIF's frames are not obliged to fit inside its
   * declared logical screen. A file can announce a 1x1 screen and then hold a
   * 20000x20000 image descriptor - so a size check that trusted the screen
   * descriptor would wave the bomb through to the decoder, which is precisely
   * the allocation the check exists to prevent. The reported size is the
   * largest extent any frame reaches.
   */
  it('reports the largest frame extent, not the declared screen', () => {
    const header = inspectImage(
      gif({ screenWidth: 1, screenHeight: 1, frames: [{ width: 20_000, height: 20_000 }] }),
      'image/gif',
    );
    expect(header.width).toBe(20_000);
    expect(header.height).toBe(20_000);
  });

  it('accounts for a frame offset when measuring the extent', () => {
    const header = inspectImage(
      gif({
        screenWidth: 10,
        screenHeight: 10,
        frames: [{ left: 100, top: 5, width: 10, height: 10 }],
      }),
      'image/gif',
    );
    expect(header.width).toBe(110);
    expect(header.height).toBe(15);
  });

  it('finds a comment extension', () => {
    expect(inspectImage(gif({ comment: true }), 'image/gif').metadata).toEqual(['Text comments']);
  });
});

describe('WebP', () => {
  it('reads dimensions out of a lossy VP8 keyframe', () => {
    const header = inspectImage(webpLossy(640, 480), 'image/webp');
    expect(header.width).toBe(640);
    expect(header.height).toBe(480);
    expect(header.lossless).toBe(false);
  });

  it('reads them out of a lossless VP8L bit stream, with its alpha flag', () => {
    const header = inspectImage(webpLossless(1024, 768, true), 'image/webp');
    expect(header.width).toBe(1024);
    expect(header.height).toBe(768);
    expect(header.hasAlpha).toBe(true);
    expect(header.lossless).toBe(true);
  });

  it('reads them out of a VP8X canvas declaration', () => {
    const header = inspectImage(webpExtended({ width: 3000, height: 2000 }), 'image/webp');
    expect(header.width).toBe(3000);
    expect(header.height).toBe(2000);
  });

  it('decodes every VP8X feature flag', () => {
    const header = inspectImage(
      webpExtended({ alpha: true, icc: true, exif: true, xmp: true }),
      'image/webp',
    );
    expect(header.hasAlpha).toBe(true);
    expect([...header.metadata].sort()).toEqual([
      'EXIF',
      'GPS location',
      'ICC colour profile',
      'XMP',
    ]);
  });

  it('counts animation frames', () => {
    const header = inspectImage(webpExtended({ animated: true, frames: 4 }), 'image/webp');
    expect(header.animated).toBe(true);
    expect(header.frames).toBe(4);
  });

  it('calls a still WebP one frame', () => {
    expect(inspectImage(webpLossy(), 'image/webp').frames).toBe(1);
    expect(inspectImage(webpLossy(), 'image/webp').animated).toBe(false);
  });

  /*
   * RIFF chunk sizes are LITTLE-endian, unlike every length in PNG and JPEG.
   * Reading one big-endian turns a 16-byte chunk into a 268 million byte one,
   * the walk ends at the first chunk, and every feature flag in the file goes
   * unseen - which is silent: the file still converts, it just converts
   * without any of the warnings it should have raised.
   */
  it('walks past the first chunk to reach later ones', () => {
    const header = inspectImage(webpExtended({ exif: true, xmp: true }), 'image/webp');
    expect(header.metadata).toContain('EXIF');
    expect(header.metadata).toContain('XMP');
  });

  it('survives a chunk whose declared length runs off the end', () => {
    const hostile = concat([
      ascii('RIFF'),
      new Uint8Array([0xff, 0xff, 0xff, 0xff]),
      ascii('WEBP'),
      ascii('VP8X'),
      new Uint8Array([0xff, 0xff, 0xff, 0xff]),
      new Uint8Array(10),
    ]);
    expect(() => inspectImage(hostile, 'image/webp')).not.toThrow();
  });
});

describe('every parser, against rubbish', () => {
  const rubbish: readonly (readonly [string, Uint8Array])[] = [
    ['empty', new Uint8Array(0)],
    ['one byte', new Uint8Array([0xff])],
    ['all zeroes', new Uint8Array(64)],
    ['all ones', new Uint8Array(64).fill(0xff)],
    ['a truncated PNG', png().subarray(0, 20)],
    ['a truncated JPEG', jpeg().subarray(0, 6)],
    ['a truncated GIF', gif().subarray(0, 9)],
    ['a truncated WebP', webpLossy().subarray(0, 14)],
  ];

  /*
   * The contract this file lives by: a parser returns partial knowledge and
   * never throws. An exception here would escape `run` and cross the worker
   * boundary, which is the one thing the ToolResult type exists to prevent -
   * and it would do it on a file whose only crime is being damaged.
   */
  it.each(rubbish)('returns something rather than throwing on %s', (_name, bytes) => {
    for (const type of ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const) {
      expect(() => inspectImage(bytes, type)).not.toThrow();
    }
  });
});
