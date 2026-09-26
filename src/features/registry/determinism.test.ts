import { afterEach, describe, expect, it, vi } from 'vitest';

import { createExecutionEngine } from '@/features/execution/engine';
import { encodeBase64, textToBytes } from '@/lib/base64';
import { residentBinary } from '@/lib/binary';
import { makeMp4, sampleBytes } from '@/tools/video-remux/fixtures';

import { getManifestEntry, loadTool, TOOL_MANIFEST, type ToolId } from './index';

import type { ToolValue } from './types';

/**
 * EVERY TOOL'S ANSWER IS THE SAME WHENEVER IT IS ASKED.
 *
 * A canvas node's cache key is its tool, options and inputs, and a result is
 * re-served for as long as they stay the same - so the cache is only correct
 * for a tool whose output is a function of those and nothing else. The comment
 * on `nodeCacheKey` used to say the type system enforced that. It cannot:
 * jwt-decode read `Date.now()` inside `run`, typechecked, and a node went on
 * calling an expired token live for as long as its graph was left alone.
 *
 * So the precondition is held here instead, by running each tool twice with
 * the clock moved decades between the runs and requiring the two results to
 * be equal. A tool that stamps the time, counts relative to it, or decides
 * anything from it fails; so does one that draws on `Math.random`, which the
 * second run reseeds.
 *
 * WHAT IT DOES NOT HOLD. The engine's own data - `Intl`'s zone rules, an image
 * encoder - differs between browsers, which is a different question with its
 * own answer (the timestamp tool names the tz release; image output is not
 * claimed byte-identical across engines). `image-convert` needs a canvas that
 * jsdom does not have and is not run here: its pixels come from the engine's
 * encoder and its one other input to the output, the file's name, is an input.
 */

/** One input per tool that produces a real answer, rather than a refusal. */
const SAMPLES: Readonly<
  Partial<Record<ToolId, { inputs: Record<string, ToolValue>; options?: object }>>
> = {
  base64: { inputs: { input: { type: 'text', text: 'hello, world' } } },
  'structured-data': { inputs: { input: { type: 'text', text: '{"a": [1, 2], "b": "x"}' } } },
  hash: { inputs: { input: { type: 'text', text: 'abc' } } },
  'jwt-decode': {
    inputs: {
      input: {
        type: 'text',
        text: [
          { alg: 'HS256', typ: 'JWT' },
          { sub: 'ada', iat: 1_800_000_000, nbf: 1_800_000_000, exp: 1_800_003_600 },
        ]
          .map((part) =>
            encodeBase64(textToBytes(JSON.stringify(part)), {
              urlSafe: true,
              padding: false,
              wrapAt: 0,
            }),
          )
          .concat('c2ln')
          .join('.'),
      },
    },
  },
  diff: {
    inputs: {
      original: { type: 'text', text: 'one\ntwo\nthree\n' },
      changed: { type: 'text', text: 'one\n2\nthree\n' },
    },
  },
  'regex-tester': {
    inputs: { input: { type: 'text', text: 'a1 b22 c333' } },
    options: { pattern: '\\d+' },
  },
  'color-convert': { inputs: { input: { type: 'text', text: 'oklch(0.7 0.1 150)' } } },
  'video-remux': {
    inputs: {
      input: {
        type: 'bytes',
        data: residentBinary(
          new Uint8Array(
            makeMp4({
              tracks: [
                {
                  kind: 'video',
                  fourcc: 'avc1',
                  timescale: 30_000,
                  delta: 1000,
                  samples: [sampleBytes(1, 400), sampleBytes(2, 120), sampleBytes(3, 130)],
                  width: 640,
                  height: 360,
                  syncSamples: [1],
                  perChunk: 3,
                  language: 'eng',
                },
              ],
            }),
          ),
        ),
        mediaType: null,
        filename: 'clip.mp4',
      },
    },
  },
  'text-convert': { inputs: { input: { type: 'text', text: '# Title\n\nSome *text*.' } } },
  timestamp: { inputs: { input: { type: 'text', text: '2024-09-26T08:00:00+02:00' } } },
};

/** Tools this file cannot run, each with the reason in the note above. */
const NOT_RUN: readonly ToolId[] = ['image-convert'];

const engine = createExecutionEngine({
  createWorker: () => {
    throw new Error('no worker in jsdom');
  },
  loadTool,
  getExecutionMeta: (id) => ({ ...getManifestEntry(id).execution, strategy: 'main' }),
  setTimer: (callback, ms) => window.setTimeout(callback, ms),
  clearTimer: (handle) => {
    window.clearTimeout(handle);
  },
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('a tool run twice, decades apart', () => {
  /*
   * A NAMED LIST, ON PURPOSE. A new tool fails this until its author gives it
   * a sample - which is the moment to ask whether anything it produces
   * depends on when it runs.
   */
  it('has a sample for every tool it can run, and a reason for every one it cannot', () => {
    const ids = TOOL_MANIFEST.map((entry) => entry.id);
    expect([...Object.keys(SAMPLES), ...NOT_RUN].sort()).toEqual([...ids].sort());
  });

  const runnable = Object.entries(SAMPLES).map(([id, sample]) => ({ id: id as ToolId, sample }));

  it.each(runnable)('$id produces the same result', async ({ id, sample }) => {
    const tool = await loadTool(id);
    const options = { ...(tool.defaultOptions as object), ...sample.options };
    const at = async (moment: number, seed: number) => {
      vi.useFakeTimers({ toFake: ['Date'], now: moment });
      vi.spyOn(Math, 'random').mockReturnValue(seed);
      try {
        return await engine.execute({ toolId: id, inputs: sample.inputs, options });
      } finally {
        vi.useRealTimers();
        vi.restoreAllMocks();
      }
    };

    const first = await at(Date.UTC(2001, 0, 1), 0.1);
    const second = await at(Date.UTC(2061, 6, 1, 12, 34, 56), 0.9);

    // The positive partner: a refusal equals a refusal just as happily.
    expect(first.ok, first.ok ? '' : first.error.message).toBe(true);
    expect(second).toEqual(first);
  });
});
