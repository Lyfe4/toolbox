import { describe, expect, it } from 'vitest';

import { detectSource, DELIMITERS, parseAuto } from './convert';
import corpus from './spec/detection-corpus.json';

/**
 * TWENTY-NINE DOCUMENTS A PERSON WOULD ACTUALLY PASTE, AND WHAT THIS TOOL DOES
 * WITH EACH ONE.
 *
 * WHY IT IS COMMITTED. Round one ran a corpus of this shape before and after
 * its detection fixes and reported "the only behaviour changes are the ones
 * listed as fixed" - which was true, and which round three could not check,
 * because the corpus itself was never written down. Reconstructing it was the
 * first hour of this round's detection work. A corpus that lives in somebody's
 * terminal is not evidence anybody else can use twice, so this one is a
 * fixture: `spec/detection-corpus.json`, with the document, the format it is
 * detected as, and the exact value it reads to.
 *
 * HOW ROUND THREE USED IT. The same 29 documents were run against the
 * round-two tree (commit 2853062, in a git worktree) and against this one, and
 * the two answers were compared field by field. THREE CHANGED, and all three
 * are decisions this round took on purpose:
 *
 *   a stream ending in a separator     {a: 1}  ->  [{a: 1}, null]
 *   a tsconfig-shaped JSONC document   refused ->  read, reported as JSONC
 *   two lines of YAML with one comma   a table ->  a mapping
 *
 * The other 26 are byte-identical. That is the claim this file makes
 * permanent: not "detection is good", but "these exact answers are the answers,
 * and a change to any of them is a change somebody chose".
 *
 * IT IS NOT AN ORACLE. Nothing outside this repository decided these values -
 * that is what `csv.oracle.test.ts`, `yaml.oracle.test.ts` and
 * `jsonc.oracle.test.ts` are for, each against a real reference implementation.
 * This is a regression corpus, and it earns its place by being REALISTIC rather
 * than by being authoritative.
 */

interface CorpusCase {
  readonly name: string;
  readonly text: string;
  readonly detected: string;
  readonly ok: boolean;
  readonly value: unknown;
  readonly error: string | null;
}

const cases = corpus as readonly CorpusCase[];

describe('the corpus itself', () => {
  it('holds documents of every shape this tool claims to read', () => {
    // Satisfied by an empty file, every assertion below.
    expect(cases.length).toBeGreaterThanOrEqual(29);

    const formats = new Set(cases.map((entry) => entry.detected));
    expect([...formats].toSorted()).toEqual(['csv', 'json', 'tsv', 'yaml']);

    // And it has to contain documents this tool REFUSES, or "nothing
    // over-refuses" is a claim about a corpus with nothing refusable in it.
    expect(cases.filter((entry) => !entry.ok).length).toBeGreaterThanOrEqual(3);
  });
});

describe('every realistic document, before and after', () => {
  it.each(cases.map((entry) => [entry.name, entry] as const))(
    'detects %s as the format the corpus records',
    (_name, entry) => {
      expect(detectSource(entry.text, DELIMITERS.comma).format).toBe(entry.detected);
    },
  );

  it.each(cases.map((entry) => [entry.name, entry] as const))(
    'reads %s to the value the corpus records',
    (_name, entry) => {
      const result = parseAuto(entry.text, DELIMITERS.comma);
      expect(result.ok).toBe(entry.ok);
      if (result.ok) expect(result.value).toEqual(entry.value);
      else expect(result.error.message).toBe(entry.error);
    },
  );

  /*
   * THE NEGATIVE CONTROL. Every assertion above is satisfied by a fixture that
   * agrees with whatever the code does, which is the shape of a test that
   * cannot fail - so this checks that the comparison can tell a wrong answer
   * from a right one, using a document from the corpus itself.
   */
  it('can tell a right answer from a wrong one', () => {
    const entry = cases.find((candidate) => candidate.name === 'a comma-separated export');
    expect(entry).toBeDefined();
    if (entry === undefined) return;

    expect(entry.detected).toBe('csv');
    expect(detectSource(entry.text, DELIMITERS.comma).format).not.toBe('yaml');

    const result = parseAuto(entry.text, DELIMITERS.comma);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).not.toEqual(entry.text);
  });
});
