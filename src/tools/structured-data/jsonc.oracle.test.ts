import { describe, expect, it } from 'vitest';

import { readAuto, readSource } from './convert';
import { describeJsonc, stripJsonc } from './jsonc';
import oracle from './spec/jsonc.json';

/**
 * JSONC, AGAINST THE PARSER VISUAL STUDIO CODE USES FOR ITS OWN SETTINGS.
 *
 * `stripJsonc` is forty lines of character scanning, and forty lines of
 * character scanning checked against expected values somebody wrote by reading
 * them is a test that this file agrees with the module beside it. So every case
 * below carries the value `jsonc-parser` produced for the same text, generated
 * by `scripts/generate-jsonc-oracle.mjs` and committed as
 * [`spec/jsonc.json`](./spec/jsonc.json).
 *
 * WHAT IS COMPARED IS THE VALUE. The two implementations do different things to
 * the text - jsonc-parser removes comments and tolerates the trailing comma in
 * its own parser, this one blanks both and hands the result to `JSON.parse` -
 * so comparing the stripped strings would compare two implementation details
 * rather than two answers to "what does this document mean".
 */

interface OracleCase {
  readonly name: string;
  readonly text: string;
  readonly ok: boolean;
  readonly value: unknown;
  readonly errors: readonly string[];
}

const cases = oracle.cases as readonly OracleCase[];

/** What this tool makes of a document, going through the JSONC step. */
function ours(text: string): { readonly ok: boolean; readonly value: unknown } {
  const stripped = stripJsonc(text);
  const read = readSource(stripped.text, 'json', ',');
  return read.ok ? { ok: true, value: read.value.data } : { ok: false, value: null };
}

describe('the fixture itself', () => {
  /*
   * Satisfied by an empty file, every assertion below - so this is the one that
   * says the oracle was really loaded and really holds what it claims.
   */
  it('holds the reference implementation it says it holds', () => {
    expect(oracle.generator).toContain('jsonc-parser');
    expect(cases.length).toBeGreaterThan(20);
    expect(oracle.counts.total).toBe(cases.length);
    expect(oracle.counts.readable).toBeGreaterThan(20);
  });

  it('has cases that exercise the thing a regular expression gets wrong', () => {
    // Named, because "25 cases pass" says nothing about whether any of them is
    // a `//` inside a string literal - which is the entire reason this is a
    // scanner rather than a substitution.
    const names = cases.map((entry) => entry.name);
    expect(names).toContain('a slash-slash inside a string');
    expect(names).toContain('a slash-star inside a string');
    expect(names).toContain('an escaped quote before a comment marker');
    expect(names).toContain('a comment marker inside a block comment');
  });
});

describe('against jsonc-parser', () => {
  it.each(cases.map((entry) => [entry.name, entry] as const))(
    'reads %s to the value jsonc-parser gives',
    (_name, entry) => {
      const result = ours(entry.text);
      expect(result.ok).toBe(entry.ok);
      if (!entry.ok) return;
      expect(result.value).toEqual(entry.value);
    },
  );

  /*
   * THE NEGATIVE CONTROL, because 25 out of 25 on a first run is the shape of a
   * comparison that cannot fail. A stripper that removed nothing would disagree
   * with the oracle on every commented case; one that removed too much would
   * disagree on the string cases. This says the comparison can tell.
   */
  it('can tell a right answer from a wrong one', () => {
    const commented = cases.find((entry) => entry.name === 'line comment before a key');
    expect(commented).toBeDefined();
    if (commented === undefined) return;

    // Without the strip, the same text is not JSON at all.
    expect(readSource(commented.text, 'json', ',').ok).toBe(false);
    // And the oracle's own answer is not the empty object, so `toEqual` above
    // is comparing something.
    expect(commented.value).toEqual({ a: 1 });
  });
});

describe('what the strip preserves', () => {
  /*
   * OFFSETS. Everything removed is replaced by a space of the same length and
   * line breaks inside a block comment are kept, so `JSON.parse`'s line and
   * column still point at the character the user is looking at. A stripper that
   * shortened the text would move every error after the first comment.
   */
  it.each(cases.map((entry) => [entry.name, entry] as const))(
    'does not move a single character of %s',
    (_name, entry) => {
      const stripped = stripJsonc(entry.text);
      expect(stripped.text).toHaveLength(entry.text.length);

      const lines = (text: string): number => text.split('\n').length;
      expect(lines(stripped.text)).toBe(lines(entry.text));
    },
  );

  it('reports an error at the line the original has it, not the line a shorter text would', () => {
    /*
     * Two comment lines, then a genuine fault - a missing comma - on line 5.
     *
     * Two things are asserted at once. The error is the one from the STRIPPED
     * document rather than "there is a comment on line 2", which is what used to
     * come back and is not what is wrong with this file. And its line is the
     * line the user is looking at: a stripper that DELETED the comments instead
     * of blanking them would report line 3.
     */
    const source = '{\n  // a comment about a\n  /* and another */\n  "a": 1\n  "b": 2\n}';
    const result = readAuto(source, ',');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toBe('That is not valid JSON.');
    expect(result.error.position?.line).toBe(5);
  });
});

describe('what it reports', () => {
  it('names what was removed, counted', () => {
    const stripped = stripJsonc('{\n  // one\n  /* two */\n  "a": 1,\n}');
    expect(stripped.lineComments).toBe(1);
    expect(stripped.blockComments).toBe(1);
    expect(stripped.trailingCommas).toBe(1);
    expect(describeJsonc(stripped)).toBe('2 comments and 1 trailing comma');
  });

  /*
   * THE NEGATIVE CONTROL FOR THE REPORT. Ordinary JSON must not be described as
   * JSONC, and neither must a document whose only slashes and commas are inside
   * strings - which is the case that would catch a stripper that had stopped
   * tracking string state.
   */
  it('says nothing was removed from a document that had none of it', () => {
    for (const source of ['{"a": 1}', '{"url": "https://x/y", "glob": "/*.ts", "a": "x,"}']) {
      const stripped = stripJsonc(source);
      expect(stripped.changed).toBe(false);
      expect(describeJsonc(stripped)).toBeNull();
      expect(stripped.text).toBe(source);
    }
  });
});
