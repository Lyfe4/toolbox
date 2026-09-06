import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  analyseRisk,
  capturingGroupNames,
  parsePattern,
  prefixesOf,
  type ParsedPattern,
} from './pattern';

function parse(pattern: string, unicodeSets = false): ParsedPattern {
  const result = parsePattern(pattern, unicodeSets);
  if (!result.ok) throw new Error(`${result.error.message} at ${result.error.offset.toString()}`);
  return result.value;
}

function failure(pattern: string, unicodeSets = false) {
  const result = parsePattern(pattern, unicodeSets);
  if (result.ok) throw new Error('expected the pattern to be rejected');
  return result.error;
}

describe('reading a pattern', () => {
  it('counts capturing groups and ignores the non-capturing kinds', () => {
    const parsed = parse('(a)(?:b)(?<c>d)(?=e)(?<!f)');
    expect(parsed.capturingGroups).toBe(2);
    expect(parsed.groupNames).toEqual(['c']);
  });

  it('numbers a nested group after its parent, as the engine does', () => {
    // Capture order is the order of the OPENING parentheses, so the outer
    // group is $1 even though it closes last. Getting this backwards would
    // put the wrong name against the wrong number in every listing.
    expect(capturingGroupNames(parse('((?<inner>a))'))).toEqual([null, 'inner']);
  });

  it('reads a class containing a bracket, a dash and an escape', () => {
    const parsed = parse('[\\]a-z-]+');
    expect(parsed.alternatives[0]).toHaveLength(1);
  });

  it('treats `[]` as an empty class rather than the start of one', () => {
    // ECMAScript differs from POSIX here: `[]` is a class that matches
    // nothing, and the `]` does not need escaping to close it.
    expect(parse('[]a').alternatives[0]).toHaveLength(2);
  });

  it('does not mistake a brace inside \\p{...} for a quantifier', () => {
    expect(parse('\\p{Script=Greek}+').alternatives[0]).toHaveLength(1);
  });

  it('treats a brace that is not a quantifier as a literal', () => {
    // `a{x}` is three literals plus a brace pair, not a malformed quantifier.
    expect(parse('a{x}').alternatives[0]).toHaveLength(4);
  });

  it('splits top-level alternatives without splitting nested ones', () => {
    const parsed = parse('a|(b|c)|d');
    expect(parsed.alternatives).toHaveLength(3);
  });

  it('nests classes only under the v flag', () => {
    // `[[a]]` is a class containing `[a`, then a literal `]`, under `u`; under
    // `v` it is one nested class. Scanning it the same way in both would read
    // half of a v-mode pattern as trailing junk.
    expect(parse('[[a]]', false).alternatives[0]).toHaveLength(2);
    expect(parse('[[a]]', true).alternatives[0]).toHaveLength(1);
  });
});

describe('explaining a broken pattern', () => {
  it('points at the parenthesis that was never closed', () => {
    const error = failure('\\d+(abc');
    expect(error.message).toContain('never closed');
    expect(error.offset).toBe(3);
  });

  it('points at the bracket that was never closed', () => {
    const error = failure('x[a-z');
    expect(error.message).toContain('character class');
    expect(error.offset).toBe(1);
  });

  it('names Python group syntax rather than saying "invalid group"', () => {
    // `(?P<name>...)` is the single most common thing to arrive here from a
    // pattern written for another language, and V8's answer is "Invalid
    // group", which tells the user nothing about what to do instead.
    const error = failure('(?P<year>\\d{4})');
    expect(error.message).toContain('Python');
    expect(error.hint).toContain('(?<name>...)');
  });

  it('names an inline comment, which JavaScript has never had', () => {
    expect(failure('a(?#why)b').message).toContain('comment');
  });

  it('says a quantifier counts down when {3,1} is written', () => {
    const error = failure('a{3,1}');
    expect(error.message).toContain('counts down');
    expect(error.hint).toContain('{1,3}');
  });

  it('names a possessive quantifier rather than repeating "nothing to repeat"', () => {
    expect(failure('a++').message).toContain('possessive');
  });

  it('reports a lone trailing backslash', () => {
    expect(failure('abc\\').message).toContain('lone backslash');
  });

  it('reports a duplicate group name with the name in it', () => {
    expect(failure('(?<n>a)(?<n>b)').message).toContain('"n"');
  });

  it('reports a stray closing parenthesis', () => {
    const error = failure('a)b');
    expect(error.offset).toBe(1);
  });

  it('collects a backreference to a name that does not exist', () => {
    expect(parse('(?<a>x)\\k<b>').unknownNameReferences).toEqual(['b']);
  });

  it('collects a numbered backreference beyond the number of groups', () => {
    expect(parse('(a)\\2').outOfRangeBackreferences).toEqual([2]);
  });
});

/*
 * THE PARSER MUST NOT BE STRICTER THAN THE ENGINE.
 *
 * The engine is the only authority on validity - `compilePattern` asks it
 * first and only consults this reader once it has refused. But everything
 * else the reader produces (risk findings, group names, prefixes) is silently
 * lost when it cannot parse a pattern, so a reader that rejects valid
 * patterns degrades the tool quietly rather than loudly. This generates
 * patterns from real constructs and asserts the two agree.
 */
describe('agreement with the engine', () => {
  const atom = fc.constantFrom(
    'a',
    'Z',
    '9',
    '\\d',
    '\\w',
    '\\s',
    '\\.',
    '\\\\',
    '.',
    '[a-z]',
    '[^0-9]',
    '[\\]]',
    '[]',
    '\\u0041',
    '\\x41',
    '\\p{L}',
    '^',
    '$',
    '\\b',
    '-',
    '{',
    '}',
    ']',
    ',',
    '/',
    '"',
  );

  const quantifier = fc.constantFrom('', '*', '+', '?', '{2}', '{2,}', '{1,3}', '*?', '+?', '??');

  const piece = fc.tuple(atom, quantifier).map(([base, repeat]) => base + repeat);

  const grouped = fc.tuple(
    fc.constantFrom('(', '(?:', '(?=', '(?!', '(?<=', '(?<!', '(?<name>'),
    fc.array(piece, { minLength: 1, maxLength: 3 }),
    quantifier,
  );

  const expression = fc
    .array(
      fc.oneof(
        piece,
        grouped.map(([open, pieces, repeat]) => {
          // A lookbehind may not be quantified, and a named group appears
          // once, so those two shapes are normalised here rather than
          // generating patterns the engine itself would refuse.
          const body = pieces.join('');
          const suffix = open.startsWith('(?<') && open !== '(?<name>' ? '' : repeat;
          return `${open}${body})${suffix}`;
        }),
      ),
      { minLength: 1, maxLength: 5 },
    )
    .map((parts) => parts.join(''));

  it('accepts everything the engine accepts', () => {
    fc.assert(
      fc.property(expression, fc.constantFrom('', 'u'), (pattern, flags) => {
        try {
          new RegExp(pattern, flags);
        } catch {
          return true; // The engine refused; the reader is free to as well.
        }
        const parsed = parsePattern(pattern, false);
        if (!parsed.ok) {
          throw new Error(
            `engine accepted /${pattern}/${flags} but the reader said: ${parsed.error.message}`,
          );
        }
        return true;
      }),
      { numRuns: 1_500 },
    );
  });

  it('counts groups the way the engine does', () => {
    fc.assert(
      fc.property(expression, (pattern) => {
        let probe: RegExp;
        try {
          // `pattern|` always matches the empty string, so the result array is
          // one entry plus one per capturing group - which is the engine's own
          // count, obtained without depending on the pattern matching anything.
          probe = new RegExp(`${pattern}|`);
        } catch {
          return true;
        }
        const parsed = parsePattern(pattern, false);
        if (!parsed.ok) return true;

        const matched = probe.exec('');
        expect(parsed.value.capturingGroups).toBe((matched?.length ?? 1) - 1);
        return true;
      }),
      { numRuns: 1_000 },
    );
  });

  it('never throws, whatever string it is handed', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 60 }), (pattern) => {
        expect(() => parsePattern(pattern, false)).not.toThrow();
        expect(() => parsePattern(pattern, true)).not.toThrow();
        return true;
      }),
      { numRuns: 500 },
    );
  });
});

describe('risk analysis', () => {
  const level = (pattern: string): string => analyseRisk(parse(pattern)).level;

  it('flags the textbook nested quantifier', () => {
    expect(level('(a+)+$')).toBe('danger');
    expect(level('(a*)*')).toBe('danger');
    expect(level('([a-z]+)*x')).toBe('danger');
  });

  it('flags repeated alternatives that can match the same character', () => {
    // `(a|a)*` and `(\d|\w)*` are the other route to an exponential search:
    // every character has more than one derivation, so n characters have 2^n.
    expect(level('(a|a)*')).toBe('danger');
    expect(level('(\\d|\\w)+')).toBe('danger');
  });

  it('leaves an unambiguous alternation alone', () => {
    expect(level('(a|b|c)*')).not.toBe('danger');
    expect(level('(\\d|[a-z])+')).not.toBe('danger');
  });

  it('does not flag a quantified lookahead', () => {
    // A lookaround is tried once at a position and cannot be re-partitioned,
    // so it does not multiply the way a consuming group does.
    expect(level('(?=a+)*')).toBe('none');
  });

  it('says nothing about the patterns people actually write', () => {
    // The check is only worth having if it is quiet on ordinary work: a
    // warning that fires on an email pattern is a warning nobody reads.
    for (const pattern of [
      '\\b[\\w.%+-]+@[\\w.-]+\\.[A-Za-z]{2,}\\b',
      '^(\\d{1,3}\\.){3}\\d{1,3}$',
      '<a href="([^"]*)">',
      '^(?<key>[^=]+)=(?<value>.*)$',
      '(?:GET|POST|PUT) (/\\S*) HTTP/1\\.[01]',
    ]) {
      expect(level(pattern), pattern).toBe('none');
    }
  });

  it('reports the offending fragment, not just a level', () => {
    const [finding] = analyseRisk(parse('x(a+)+y')).findings;
    expect(finding?.fragment).toBe('(a+)+');
    expect(finding?.start).toBe(1);
  });
});

describe('prefixes', () => {
  it('cuts at top-level boundaries and drops the trailing anchor', () => {
    // The pattern WITHOUT its `$` is a prefix worth testing in its own right:
    // "it matches `^\d+-\w+` but not `^\d+-\w+$`" points at the anchor, which
    // is a different answer from any of the shorter cuts.
    expect(prefixesOf(parse('^\\d+-\\w+$'), '^\\d+-\\w+$')).toEqual([
      '^',
      '^\\d+',
      '^\\d+-',
      '^\\d+-\\w+',
    ]);
  });

  it('keeps a group whole rather than cutting inside it', () => {
    expect(prefixesOf(parse('(ab|cd)x'), '(ab|cd)x')).toEqual(['(ab|cd)']);
  });

  it('declines when the pattern has top-level alternation', () => {
    // The first branch of `a|b` is not a prefix of the whole thing, so
    // narrowing would report a fact that is not true.
    expect(prefixesOf(parse('abc|def'), 'abc|def')).toEqual([]);
  });

  it('produces only patterns that still compile', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          '^\\d{4}-\\d{2}-\\d{2}$',
          '(?<user>\\w+)@(?<host>[\\w.]+)',
          '\\[(\\d+)\\]\\s+(\\w+)',
          '(?=.*[A-Z])(?=.*\\d).{8,}',
        ),
        (pattern) => {
          for (const prefix of prefixesOf(parse(pattern), pattern)) {
            expect(() => new RegExp(prefix), prefix).not.toThrow();
          }
          return true;
        },
      ),
      { numRuns: 50 },
    );
  });
});
