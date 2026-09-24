import { describe, expect, it } from 'vitest';

import { parseSource, serialise } from './convert';
import pyyaml from './spec/yaml-writer-pyyaml.json';

/**
 * OUR YAML OUTPUT, READ BY A THIRD IMPLEMENTATION.
 *
 * The writing row of docs/conversion-matrix.md has rested on js-yaml since
 * round two. That was one independent reader, and one is enough to catch a
 * writer that is wrong and not enough to tell a writer that is wrong from a
 * READER that is limited - which is precisely the question that came up twice:
 * the `\n` block scalar in round two and the empty-document rule in round
 * three were both settled by asking CPython's PyYAML by hand, and the answer
 * lived in a comment where nothing would notice if it changed.
 *
 * So the same corpus is written out, read by PyYAML, and the verdict committed
 * as [`spec/yaml-writer-pyyaml.json`](./spec/yaml-writer-pyyaml.json) by
 * `scripts/generate-yaml-writer-oracle.mjs`. Nothing here runs Python: a test
 * that shelled out to CPython would be a test that quietly did not run on the
 * machines without it.
 *
 * THE FIXTURE IS TIED TO THE BYTES IT WAS ABOUT. Each entry carries the exact
 * YAML this writer produced at generation time, and the first assertion below
 * is that the writer still produces it. A verdict about output nobody writes
 * any more is not evidence, and without that assertion it would read as one.
 *
 * AND IT FOUND SOMETHING, which is the reason for the whole file: eleven
 * documents came out with a TAB inside a plain scalar, which PyYAML and
 * ruamel.yaml both refuse at the scanner - not the value, the whole document.
 * js-yaml reads them, so one reader could never have seen it. Those are quoted
 * now; see `writeYamlDocument`.
 */
interface WriterCase {
  readonly id: string;
  readonly label: string;
  readonly value: unknown;
  readonly yaml: string;
  readonly pyyaml: { readonly agrees: boolean; readonly read?: unknown; readonly detail?: string };
}

const cases = pyyaml.cases as readonly WriterCase[];

/**
 * Every document PyYAML does NOT read back to the value this tool wrote, in
 * the three groups they fall into. Each group is a decision, and each is
 * stated with which of four implementations agree rather than as a judgement.
 *
 *  1. A ROOT-LEVEL BLOCK SCALAR WITH CONTENT AT COLUMN 0. A document whose
 *     whole value is a multi-line string is written `|` followed by the lines
 *     at column 0. Our own `yaml`, js-yaml and ruamel.yaml 0.19.1 all read it;
 *     PyYAML 6.0.3 alone stops with "expected <document start>". Three of four,
 *     so this is recorded as PyYAML's limit. **It is not fixed**, and the
 *     reason is that the emitter has no option for it: indenting the content
 *     means rewriting emitted YAML text by hand, and the indentation indicator
 *     it would have to compute is the very thing implementations disagree
 *     about - see group 2.
 *
 *  2. A ROOT-LEVEL BLOCK SCALAR WITH AN EXPLICIT INDENTATION INDICATOR. Same
 *     shape, for a string whose first line begins with a space, so the header
 *     is `|1-`. Here the readers split two and two: `yaml` and js-yaml read it,
 *     PyYAML and ruamel refuse. The indicator is defined relative to the
 *     PARENT node's indentation, and at the root that is -1, which is what
 *     makes `1` mean column 0 - and what two of the four do not implement.
 *     Recorded as a genuine disagreement rather than as anybody's defect.
 *
 *  3. PyYAML RESOLVES YAML 1.1 TYPES. `2001-01-23` is a string in the 1.2 core
 *     schema and a `datetime.date` in PyYAML; `20:03:20` is a string in 1.2 and
 *     the integer 72200 in 1.1's sexagesimals. This is the reader's schema, not
 *     this writer's output, and js-yaml (which defaults to the 1.2 core schema)
 *     reads both back as the strings they were. It is worth knowing about: a
 *     YAML file from this tool fed to a 1.1 reader can change type on the way
 *     in, and no quoting decision on this side would be visible to it.
 */
const PYYAML_DIFFERENCES: Readonly<Record<string, readonly string[]>> = {
  'root block scalar, content at column 0': [
    '4Q9F',
    '6FWR',
    '6JQW',
    '6VJK',
    '7T8X',
    '93WF',
    '96L6',
    '9YRD',
    'B3HG',
    'DK3J',
    'DWX9',
    'EX5H',
    'FP8R',
    'G992',
    'HS5T',
    'K527',
    'M9B4',
    'MJS9',
    'NP9H',
    'Q8AD',
    'T26H',
    'T5N4',
    'TS54',
  ],
  'root block scalar with an explicit indentation indicator': [
    '6WPF',
    '7A4E',
    '9TFX',
    'PRH3',
    'T4YY',
    'TL85',
  ],
  'PyYAML resolves YAML 1.1 timestamps and sexagesimals': ['RZT7', 'U9NS', 'UGM3'],
};

const EXPECTED_DISAGREEMENTS = Object.values(PYYAML_DIFFERENCES).flat();

describe('the PyYAML fixture itself', () => {
  it('holds what it says it holds', () => {
    // Satisfied by nothing else here: every assertion below passes over an
    // empty fixture.
    expect(pyyaml.reader).toContain('PyYAML');
    expect(pyyaml.corpus).toContain('yaml-test-suite');
    expect(cases.length).toBeGreaterThan(250);
    expect(pyyaml.counts.total).toBe(cases.length);
  });

  it('agrees on all but the differences named above, and on exactly those', () => {
    const disagreed = cases.filter((entry) => !entry.pyyaml.agrees).map((entry) => entry.id);
    // Sorted lists rather than a count: a case that moved from one group to
    // another would satisfy a count and is a behaviour change.
    expect([...disagreed].sort()).toEqual([...EXPECTED_DISAGREEMENTS].sort());
    expect(pyyaml.counts.agreed).toBe(cases.length - EXPECTED_DISAGREEMENTS.length);
  });

  it('records no document PyYAML could not even scan', () => {
    /*
     * THE ELEVEN THIS FILE WAS WRITTEN FOR, IDENTIFIED BY MECHANISM.
     *
     * A raw tab in a plain scalar fails in PyYAML's SCANNER - "found character
     * '\t' that cannot start any token" - and takes the whole document with it.
     * A root block scalar fails one stage later, in the parser, having scanned
     * perfectly well. So the two are distinguishable without reading the ids:
     * every refusal left is a `ParserError`, and a `ScannerError` reappearing
     * means a value has gone back to being written raw.
     */
    const scanned = cases.filter((entry) => entry.pyyaml.detail === 'ScannerError');
    expect(scanned).toEqual([]);
  });
});

/**
 * The writer's output for a fixture case, driven from the VALUE rather than
 * re-derived from the document - the read is a different claim and it has its
 * own corpus.
 */
function write(entry: (typeof cases)[number]): string {
  const parsed = parseSource(JSON.stringify(entry.value), 'json', ',');
  if (!parsed.ok) throw new Error(`${entry.id}: the fixture value did not parse`);
  const written = serialise(parsed.value, 'yaml', { indent: 2, delimiter: ',' });
  if (!written.ok) throw new Error(`${entry.id}: the writer refused the value`);
  return written.value;
}

describe('writing, against PyYAML', () => {
  it.each(
    cases
      .filter((entry) => entry.pyyaml.agrees)
      .map((entry) => [`${entry.id} ${entry.label}`, entry] as const),
  )('still writes %s as the bytes PyYAML read back to the same value', (_name, entry) => {
    expect(write(entry)).toBe(entry.yaml);
  });

  /*
   * AND THE DIFFERENCES ARE ASSERTED AS THEMSELVES.
   *
   * A list of known differences that is only ever filtered OUT is a list
   * anybody can grow. Each of these is checked to still be produced in the
   * shape the group describes, so a writer that stopped emitting root block
   * scalars - or a regeneration that quietly dropped the cases - turns this
   * file red rather than green.
   *
   * THE WRITER IS RUN, and until round fifteen it was not: these asserted the
   * shape of `entry.yaml`, which is the committed fixture, so a writer change
   * on these 32 documents was invisible and only a regeneration could fail
   * them. The output is held to the fixture's bytes AND to the shape now.
   */
  it.each(
    Object.entries(PYYAML_DIFFERENCES).flatMap(([group, ids]) =>
      ids.map((id) => [group, id] as const),
    ),
  )('still produces the %s shape for %s', (group, id) => {
    const entry = cases.find((candidate) => candidate.id === id);
    expect(entry).toBeDefined();
    if (entry === undefined) return;

    expect(entry.pyyaml.agrees).toBe(false);

    const written = write(entry);
    expect(written).toBe(entry.yaml);
    if (group === 'root block scalar, content at column 0') {
      expect(written).toMatch(/^[|>][-+]?\n/);
    } else if (group === 'root block scalar with an explicit indentation indicator') {
      expect(written).toMatch(/^[|>]\d/);
    } else {
      // The 1.1 group is about the READER, so what is asserted is that our
      // output holds no block scalar at the root at all - it is ordinary YAML,
      // and PyYAML still answers differently.
      expect(written).not.toMatch(/^[|>]/);
    }
  });

  /*
   * THE NEGATIVE CONTROL.
   *
   * 252 documents agreeing is the shape of a check that is not running. The
   * generator refuses to write a fixture unless PyYAML accepts a correct
   * document and rejects two wrong ones - an unquoted `1.10`, and an unquoted
   * `true` used as a key. Those controls run in the generator because they need
   * Python; what runs here is the half that needs none: the same two documents
   * through THIS writer, which must quote both.
   */
  it('quotes the two scalars the generator’s controls are about', () => {
    const written = serialise({ version: '1.10', id: '0123' }, 'yaml', {
      indent: 2,
      delimiter: ',',
    });
    expect(written.ok).toBe(true);
    if (!written.ok) return;
    expect(written.value).toBe('version: "1.10"\nid: "0123"\n');

    const key = serialise({ true: 1 }, 'yaml', { indent: 2, delimiter: ',' });
    expect(key.ok).toBe(true);
    if (!key.ok) return;
    expect(key.value).toBe('"true": 1\n');
  });

  /*
   * And the tab, as behaviour rather than as a fixture entry: one line, in a
   * value and in a key, quoted so that `\t` is an escape rather than a raw tab
   * a scanner has to decide about. A multi-line string keeps its block scalar,
   * because a tab inside one is read correctly by all four implementations and
   * a Makefile written as one long escaped line would be a worse document.
   */
  it('quotes a tab in a one-line scalar and leaves a block scalar alone', () => {
    const inline = serialise({ 'k\tz': 'x\ty' }, 'yaml', { indent: 2, delimiter: ',' });
    expect(inline.ok).toBe(true);
    if (inline.ok) expect(inline.value).toBe('"k\\tz": "x\\ty"\n');

    const block = serialise({ make: 'all:\n\tgcc a.c\n' }, 'yaml', { indent: 2, delimiter: ',' });
    expect(block.ok).toBe(true);
    if (block.ok) expect(block.value).toBe('make: |\n  all:\n  \tgcc a.c\n');
  });
});
