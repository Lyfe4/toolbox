import { describe, expect, it } from 'vitest';

import { getManifestEntry } from '@/features/registry';
import type { ToolRunContext } from '@/features/registry/types';

import regexTool from './index';
import { flagsFor, regexDefaultOptions } from './options';
import { compilePattern, MAX_MATCHES, runRegex, toSummary } from './run';

const context: ToolRunContext = {
  signal: new AbortController().signal,
  reportProgress: () => undefined,
};

function compile(pattern: string, flags = 'g'): RegExp {
  const result = compilePattern(pattern, flags);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

describe('compiling', () => {
  it('refuses an empty pattern with a message rather than matching everything', () => {
    const result = compilePattern('', 'g');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invalid-input');
  });

  it('turns a syntax error into a structured failure', () => {
    const result = compilePattern('(unclosed', 'g');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('parse-error');
    expect(result.error.detail).toBeTruthy();
  });

  it('assembles flags from the toggles', () => {
    expect(flagsFor({ ...regexDefaultOptions, global: true, ignoreCase: true })).toBe('gi');
    expect(flagsFor({ ...regexDefaultOptions, global: false, dotAll: true, unicode: true })).toBe(
      'su',
    );
  });
});

describe('matching', () => {
  it('reports every match with its offset', () => {
    const report = runRegex(compile('\\d+'), 'a1 bb22 c333', null);
    expect(report.matches.map((match) => match.match)).toEqual(['1', '22', '333']);
    expect(report.matches.map((match) => match.index)).toEqual([1, 5, 9]);
  });

  it('reports only the first match without the global flag', () => {
    const report = runRegex(compile('\\d+', ''), 'a1 bb22', null);
    expect(report.matches).toHaveLength(1);
  });

  it('carries positional and named groups', () => {
    const report = runRegex(compile('(?<key>\\w+)=(\\w+)'), 'a=1 b=2', null);

    expect(report.matches[0]?.groups).toEqual(['a', '1']);
    expect(report.matches[0]?.named).toEqual({ key: 'a' });
  });

  it('records a group that did not participate as null, not undefined', () => {
    const report = runRegex(compile('(a)|(b)'), 'b', null);
    // JSON has no undefined; a hole in the group list has to survive the trip.
    expect(report.matches[0]?.groups).toEqual([null, 'b']);
  });

  /*
   * A global pattern that can match the empty string never advances lastIndex
   * on its own. Without the guard in runRegex this is an infinite loop, which
   * is the same tab-killing failure as backtracking by a different route.
   */
  it('terminates on a pattern that can match nothing', () => {
    const report = runRegex(compile('a*'), 'bbb', null);
    expect(report.matches.length).toBeGreaterThan(0);
    expect(report.matches.length).toBeLessThanOrEqual(MAX_MATCHES);
  });

  it('stops at the match limit rather than building an unbounded list', () => {
    const report = runRegex(compile('a'), 'a'.repeat(MAX_MATCHES + 500), null);
    expect(report.matches).toHaveLength(MAX_MATCHES);
    expect(report.truncated).toBe(true);
    expect(toSummary(report)).toContain('stopped at');
  });

  it('replaces with group references', () => {
    const report = runRegex(compile('(\\w+)@(\\w+)'), 'ada@example bob@example', '$2:$1');
    expect(report.replaced).toBe('example:ada example:bob');
  });
});

/*
 * CATASTROPHIC BACKTRACKING
 *
 * `(a+)+$` against a run of `a`s with a non-matching tail takes time
 * exponential in the input length. The tool's answer is the worker timeout,
 * because the regex engine cannot be interrupted from inside - so what can be
 * tested here is (a) that the hazard is real and measurable, on an input small
 * enough that CI still finishes, and (b) that the tool is configured to be
 * killed and to say why.
 */
describe('the pathological case', () => {
  const PATTERN = '(a+)+$';

  const timeFor = (length: number): number => {
    const start = performance.now();
    runRegex(compile(PATTERN, ''), `${'a'.repeat(length)}!`, null);
    return performance.now() - start;
  };

  it('goes exponential on an input short enough to fit in a tweet', () => {
    // Walked up from trivially small rather than pinned to a fixed length, so
    // this proves the shape of the curve without holding CI hostage to how
    // fast the machine happens to be. Each step doubles, so the whole loop
    // costs about twice its last measurement.
    let length = 12;
    let elapsed = 0;

    while (length < 40 && elapsed < 200) {
      length += 1;
      elapsed = timeFor(length);
    }

    // Something linear would still be in microseconds at this size.
    expect(elapsed).toBeGreaterThanOrEqual(200);
    expect(length).toBeLessThan(40);

    // And it really is exponential, not merely slow: four fewer characters is
    // dramatically less work. A factor of four is generous against 2^4 = 16.
    const shorter = Math.max(timeFor(length - 4), 0.5);
    expect(elapsed / shorter).toBeGreaterThan(4);
  });

  it('is declared with a short timeout and its own explanation', () => {
    const meta = getManifestEntry('regex-tester').execution;

    expect(meta.strategy).toBe('worker');
    expect(meta.timeoutMs).toBeLessThanOrEqual(5_000);
    expect(meta.timeoutMessage).toBeDefined();
    // The message has to name the cause. "The tool failed" would send the user
    // looking for a bug in Patchbay rather than at their own pattern.
    expect(meta.timeoutMessage).toContain('too slow');
    expect(meta.timeoutMessage).toContain('backtracking');
  });
});

describe('the tool', () => {
  it('lists matches when finding', async () => {
    const result = await regexTool.run({
      inputs: { input: { type: 'text', text: 'x1 y2' } },
      options: { ...regexDefaultOptions, pattern: '\\d' },
      context,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.matches?.type).toBe('json');
    const text = result.value.output;
    if (text?.type === 'text') expect(text.text).toContain('1');
  });

  it('returns the replaced text when replacing', async () => {
    const result = await regexTool.run({
      inputs: { input: { type: 'text', text: 'one two' } },
      options: { ...regexDefaultOptions, pattern: 'two', mode: 'replace', replacement: 'three' },
      context,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const text = result.value.output;
    expect(text?.type === 'text' ? text.text : '').toBe('one three');
  });

  it('reports a bad pattern as an error rather than throwing', async () => {
    const result = await regexTool.run({
      inputs: { input: { type: 'text', text: 'anything' } },
      options: { ...regexDefaultOptions, pattern: '[' },
      context,
    });

    expect(result.ok).toBe(false);
  });
});
