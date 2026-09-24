import { describe, expect, it } from 'vitest';

import { locateJsonSyntaxError } from './jsonSyntax';
import oracle from './spec/json-syntax-oracle.json';

/**
 * HELD TO TWO ENGINES' PARSERS, NOT TO WHAT THIS FILE THINKS JSON IS.
 *
 * `spec/json-syntax-oracle.json` is 2,165 documents JSON.parse refuses - every
 * single-character deletion, substitution and insertion of five seeds, on a
 * fixed stride - with the offset Gecko reports for each and the one V8
 * reports where its message has one. See scripts/generate-json-syntax-oracle.mjs.
 */

type Case = readonly [source: string, gecko: number, v8: number | null, jsc: boolean];

const cases = oracle.cases as unknown as readonly Case[];

describe('locateJsonSyntaxError', () => {
  it('has the sweep it claims to have', () => {
    // So an emptied fixture cannot pass the loops below.
    expect(cases.length).toBe(oracle.summary.cases);
    expect(cases.length).toBeGreaterThan(2000);
  });

  it('finds the fault where Gecko does, in every document of the sweep', () => {
    const wrong = cases
      .map(([source, gecko]) => ({ source, gecko, ours: locateJsonSyntaxError(source) }))
      .filter((entry) => entry.ours !== entry.gecko);
    expect(wrong).toEqual([]);
  });

  it('finds it where V8 does, wherever V8 says, except inside a misspelled keyword', () => {
    const wrong = cases
      .filter(([, gecko, v8]) => v8 !== null && v8 !== gecko)
      .filter(([source, gecko, v8]) => {
        // The one convention the engines split on, checked by the generator:
        // Gecko points at the keyword, V8 at the first letter that is wrong.
        const keyword = /^(t|f|n)/.test(source.slice(gecko));
        return !(keyword && v8 !== null && v8 > gecko && v8 <= gecko + 4);
      });
    expect(wrong).toEqual([]);
    const agreed = cases.filter(
      ([source, gecko, v8]) => v8 === gecko && v8 === locateJsonSyntaxError(source),
    );
    expect(agreed.length).toBeGreaterThan(1400);
  });

  it('finds nothing in a document that is JSON', () => {
    // The negative control: every seed parses, and each must come back clean.
    for (const seed of oracle.seeds) {
      expect(() => JSON.parse(seed) as unknown).not.toThrow();
      expect(locateJsonSyntaxError(seed)).toBeNull();
    }
    expect(locateJsonSyntaxError(' [ "\ud800" , -0 , 1E+2 , {} ] ')).toBeNull();
  });

  it('does not overflow on a document too deep for the engine', () => {
    // The engine refuses this with a RangeError; the locator must still answer.
    const deep = '['.repeat(200_000);
    expect(locateJsonSyntaxError(deep)).toBe(deep.length);
  });

  it('records the engine that gave no position at all', () => {
    // Not a test of this code: the measurement the change rests on, pinned so
    // a regenerated fixture that changed it would be noticed in review.
    expect(oracle.summary.webkitGavePosition).toBe(0);
    expect(oracle.summary.firefoxGavePosition).toBe(cases.length);
    expect(oracle.summary.chromiumGavePosition).toBeLessThan(cases.length);
  });
});
