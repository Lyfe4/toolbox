import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Bytes } from '@/features/registry/types';

import {
  checkDimensions,
  convertImage,
  fitDimensions,
  MAX_DIMENSION,
  MAX_PIXELS,
  sizeChangePercent,
} from './convert';
import imageTool from './index';

/** A buffer whose magic bytes say PNG, with no real image behind them. */
function pngHeader(): Bytes {
  const bytes = new Uint8Array(64);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return bytes;
}

/** Counts constructions without being a class that only has a constructor. */
function countingCanvas(onConstruct: () => void): unknown {
  return function OffscreenCanvasStub(): void {
    onConstruct();
  };
}

/** Stands in for a decoded bitmap of any size, without decoding anything. */
function fakeBitmap(width: number, height: number): ImageBitmap {
  // ImageBitmap really is just these three members, so no cast is needed -
  // which is a nice reminder that the interface is thinner than the object.
  return { width, height, close: () => undefined };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('format sniffing', () => {
  it('refuses a file whose bytes are not an image, whatever it is called', async () => {
    const text = new TextEncoder().encode('This is plainly not a PNG.');

    const result = await convertImage({
      bytes: text,
      format: 'image/png',
      quality: 0.8,
      maxEdge: 0,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('unsupported-type');
    // The message has to say the check was on the bytes, because the user is
    // looking at a file that their operating system calls an image.
    expect(result.error.detail).toContain('not its name');
  });

  it('refuses a PDF that has been renamed to .png', async () => {
    const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]);

    const result = await convertImage({
      bytes: pdf,
      format: 'image/png',
      quality: 0.8,
      maxEdge: 0,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('pdf document');
  });
});

/*
 * DECOMPRESSION BOMBS
 *
 * The file-size limit the engine enforces is no defence at all here: a few
 * tens of kB of PNG can decode to a bitmap measured in gigabytes. These check
 * the limit that actually protects memory, and that it is applied before any
 * canvas of that size could be allocated.
 */
describe('dimension limits', () => {
  it('refuses an image whose long edge is too large', () => {
    const result = checkDimensions(MAX_DIMENSION + 1, 10);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('limit-exceeded');
  });

  it('refuses an image whose pixel count is too large even with sane edges', () => {
    // Both edges are legal on their own; their product is not.
    const edge = Math.floor(Math.sqrt(MAX_PIXELS)) + 2_000;
    expect(edge).toBeLessThanOrEqual(MAX_DIMENSION);

    const result = checkDimensions(edge, edge);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.detail).toContain('megapixels');
  });

  it('accepts a large but reasonable photograph', () => {
    expect(checkDimensions(6_000, 4_000).ok).toBe(true);
  });

  it('rejects a bomb before allocating a canvas for it', async () => {
    let canvasesCreated = 0;
    vi.stubGlobal('createImageBitmap', () => Promise.resolve(fakeBitmap(60_000, 60_000)));
    vi.stubGlobal(
      'OffscreenCanvas',
      countingCanvas(() => {
        canvasesCreated += 1;
      }),
    );

    const result = await convertImage({
      bytes: pngHeader(),
      format: 'image/png',
      quality: 0.8,
      maxEdge: 0,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('limit-exceeded');
    // 60000x60000 RGBA is about 14 GB. Nothing may be allocated for it.
    expect(canvasesCreated).toBe(0);
  });
});

describe('scaling', () => {
  it('leaves an image alone when no limit is set', () => {
    expect(fitDimensions(800, 600, 0)).toEqual({ width: 800, height: 600 });
  });

  it('leaves an image alone when it already fits', () => {
    expect(fitDimensions(800, 600, 1_000)).toEqual({ width: 800, height: 600 });
  });

  it('scales the long edge and preserves the aspect ratio', () => {
    expect(fitDimensions(1_600, 900, 800)).toEqual({ width: 800, height: 450 });
    expect(fitDimensions(900, 1_600, 800)).toEqual({ width: 450, height: 800 });
  });

  it('never rounds an edge down to zero', () => {
    // A 4000x1 banner scaled to 512 would otherwise ask for a zero-height
    // canvas, which throws.
    expect(fitDimensions(4_000, 1, 512).height).toBe(1);
  });
});

describe('size reporting', () => {
  it.each([
    [1_000, 400, -60],
    [1_000, 1_500, 50],
    [1_000, 1_000, 0],
  ])('reports %i -> %i as %i%%', (before, after, expected) => {
    expect(sizeChangePercent(before, after)).toBeCloseTo(expected, 6);
  });

  it('does not divide by zero on an empty input', () => {
    expect(sizeChangePercent(0, 100)).toBe(0);
  });
});

describe('execution strategy', () => {
  it('declares that it needs OffscreenCanvas, so the engine can downgrade it', () => {
    // The fallback is only reachable because this is declared eagerly; a probe
    // inside `run` would happen after the context had already been chosen.
    expect(imageTool.execution.requiresOffscreenCanvas).toBe(true);
    expect(imageTool.execution.strategy).toBe('worker');
  });
});
