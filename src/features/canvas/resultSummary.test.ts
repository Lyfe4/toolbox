import { describe, expect, it } from 'vitest';

import { getManifestEntry, TOOL_MANIFEST } from '@/features/registry';
import type { ToolValue } from '@/features/registry/types';
import { bytesValue } from '@/features/registry/types';

import { summariseOutputs, summariseValue, SUMMARY_LIMIT } from './resultSummary';

/**
 * WHAT A NODE SAYS ABOUT ITS RESULT.
 *
 * A node is 224px wide with two clamped lines, so every one of these is a
 * MEASUREMENT of the result rather than a slice of it. The cases below are the
 * ones where measuring the wrong thing produces a plausible sentence that is
 * false, which is the failure worth a test - a summary nobody can tell is
 * wrong is worse than no summary.
 */

function text(value: string): ToolValue {
  return { type: 'text', text: value };
}

function json(data: unknown): ToolValue {
  return { type: 'json', data: data as never };
}

function bytes(source: readonly number[]): ToolValue {
  return bytesValue(new Uint8Array(source));
}

const PNG_HEADER = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

describe('regex', () => {
  it('counts matches', () => {
    expect(summariseValue(json({ count: 47 }), 'regex')).toBe('47 matches');
  });

  it('says no matches rather than zero of them', () => {
    // "0 matches" is arithmetic; "No matches" is the answer to the question
    // the person asked, and it is the outcome they most need to notice.
    expect(summariseValue(json({ count: 0 }), 'regex')).toBe('No matches');
  });

  it('singularises', () => {
    expect(summariseValue(json({ count: 1 }), 'regex')).toBe('1 match');
  });

  /*
   * THE COUNT OUTLIVES THE LISTING, and this is the whole reason the summary
   * reads `count` and not `listed`. The regex tool caps how many matches it
   * enumerates; a node summarising the enumeration would report "200 matches"
   * for a pattern that found five thousand - a confident, plausible, wrong
   * number, which the README records this tool producing once already.
   */
  it('reports the real count even when the listing was truncated', () => {
    expect(summariseValue(json({ count: 5000, listed: 200 }), 'regex')).toBe('5000 matches');
  });
});

describe('diff', () => {
  it('gives additions and removals', () => {
    expect(
      summariseValue(json({ identical: false, stats: { added: 12, removed: 3 } }), 'diff'),
    ).toBe('+12 −3');
  });

  /*
   * Not "+0 −0". Two documents that differ only in the ways the options were
   * told to ignore is a real outcome and the reason those options exist; a
   * pair of zeroes reads as the tool having failed to run.
   */
  it('names an identical comparison rather than reporting two zeroes', () => {
    expect(summariseValue(json({ identical: true, stats: { added: 0, removed: 0 } }), 'diff')).toBe(
      'Identical',
    );
  });
});

describe('jwt', () => {
  /*
   * THE ONE SUMMARY THAT IS A WARNING RATHER THAN A MEASUREMENT.
   *
   * A JWT payload is base64, not encryption. A node in the middle of a chain
   * is exactly where nobody opens the panel, so a decoded token that reads as
   * ordinary at a glance is one that makes a forgery look authoritative. The
   * verdict comes first and it shouts, in the same words JwtView uses.
   */
  it('leads with the verdict when nothing checked the signature', () => {
    expect(
      summariseValue(json({ signature: { algorithm: 'HS256', verified: false } }), 'jwt'),
    ).toBe('NOT VERIFIED · HS256');
  });

  it('leads with the verdict when something did', () => {
    expect(summariseValue(json({ signature: { algorithm: 'HS256', verified: true } }), 'jwt')).toBe(
      'Verified · HS256',
    );
  });

  it('never reports a verified token for a payload it cannot read', () => {
    // A malformed payload falls through to the JSON shape rather than
    // defaulting to anything about trust.
    expect(summariseValue(json({ signature: 'yes' }), 'jwt')).toBe('1 key');
  });
});

describe('report', () => {
  it('uses the report’s own sentence rather than deriving a second one', () => {
    expect(summariseValue(json({ summary: '1.0 kB → 800 B (-20.0%)' }), 'report')).toBe(
      '1.0 kB → 800 B (-20.0%)',
    );
  });

  it('falls back to the shape when there is no summary line', () => {
    expect(summariseValue(json({ from: {}, to: {} }), 'report')).toBe('2 keys');
  });
});

describe('text', () => {
  it('is the first line', () => {
    expect(summariseValue(text('hello world\nsecond line'))).toBe('hello world');
  });

  it('skips leading blank lines rather than calling the result empty', () => {
    expect(summariseValue(text('\n\n  actual content'))).toBe('actual content');
  });

  /*
   * An empty result rendered as an empty summary is indistinguishable from no
   * summary at all - the node would look as though it had not run. It is also
   * usually the surprise: an encoder that produced nothing is the thing you
   * want to see from across the canvas.
   */
  it('says so when a run produced nothing', () => {
    expect(summariseValue(text(''))).toBe('Empty');
    expect(summariseValue(text('   \n \t '))).toBe('Whitespace only');
  });

  it('truncates, so a 30 MB document never reaches a node’s accessible name', () => {
    const summary = summariseValue(text('x'.repeat(10_000)));
    expect(summary.length).toBeLessThanOrEqual(SUMMARY_LIMIT);
    expect(summary.endsWith('…')).toBe(true);
  });
});

describe('bytes', () => {
  /*
   * The SNIFFED label, never the declared one - the same rule the rest of the
   * app follows. `payload.zip` renamed to `photo.png` describes itself here as
   * whatever its bytes actually are.
   */
  it('is the size and the sniffed kind', () => {
    expect(summariseValue(bytes([...PNG_HEADER, ...new Array<number>(2048).fill(0)]))).toMatch(
      /^2\.0 kB PNG image$/,
    );
  });

  it('describes bytes that are not a known format by what they look like', () => {
    expect(summariseValue(bytes([0x68, 0x69]))).toBe('2 B Text');
  });
});

describe('the remaining data types', () => {
  it('gives a colour as hex', () => {
    expect(summariseValue({ type: 'color', color: { r: 0.2, g: 0.4, b: 1, a: 1 } })).toBe(
      '#3366ff',
    );
  });

  it('says when a colour is not opaque, because the hex alone would not', () => {
    expect(summariseValue({ type: 'color', color: { r: 0, g: 0, b: 0, a: 0.5 } })).toBe(
      '#000000 at 50%',
    );
  });

  it('describes a bare JSON value by its shape', () => {
    expect(summariseValue(json({ a: 1, b: 2, c: 3 }))).toBe('3 keys');
    expect(summariseValue(json([1, 2]))).toBe('2 items');
  });
});

describe('which output a node summarises', () => {
  /*
   * THE FIRST DECLARED OUTPUT, and only that one. Seven of the ten tools have
   * more than one, and the manifest's order is not arbitrary: the first port
   * is the tool's answer and the rest are its working. This asserts the
   * property the summary relies on rather than the summary itself, so a tool
   * added later that puts its working first fails here rather than quietly
   * making every one of its nodes report the wrong thing.
   */
  it('summarises the first declared output', () => {
    const entry = getManifestEntry('regex-tester');
    expect(entry.outputs[0]?.id).toBe('output');
    expect(
      summariseOutputs(entry, {
        output: text('result line'),
        matches: json({ count: 9 }),
      }),
    ).toBe('result line');
  });

  it('is null for a node that has not produced anything', () => {
    expect(summariseOutputs(getManifestEntry('hash'), null)).toBeNull();
    expect(summariseOutputs(getManifestEntry('hash'), {})).toBeNull();
  });

  it('stays inside the limit for every tool in the manifest', () => {
    for (const entry of TOOL_MANIFEST) {
      // Every tool declares at least one output; a tool that did not would
      // have no result to summarise, and this asserts the assumption rather
      // than skipping past it.
      const port = entry.outputs[0];
      expect(port, entry.id).toBeDefined();
      const summary = summariseOutputs(entry, { [port.id]: text('a'.repeat(5_000)) });
      expect(summary, entry.id).not.toBeNull();
      expect(summary?.length, entry.id).toBeLessThanOrEqual(SUMMARY_LIMIT);
    }
  });
});
