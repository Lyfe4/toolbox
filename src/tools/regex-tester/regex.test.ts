import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { getManifestEntry } from '@/features/registry';
import type { ToolRunContext } from '@/features/registry/types';

import regexTool from './index';
import { flagsFor, regexDefaultOptions, regexOptionsSchema, type RegexOptions } from './options';
import { capturingGroupNames, parsePattern } from './pattern';
import {
  advanceIndex,
  compilePattern,
  DEFAULT_LIMITS,
  HAS_INDICES,
  MAX_MATCHES,
  missingFeature,
  runRegex,
  toSummary,
  type EngineFeature,
  type RegexReport,
  type RunLimits,
} from './run';

const context: ToolRunContext = {
  signal: new AbortController().signal,
  reportProgress: () => undefined,
};

function compile(pattern: string, flags = 'g'): RegExp {
  const result = compilePattern(pattern, flags);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function namesFor(pattern: string): readonly (string | null)[] {
  const parsed = parsePattern(pattern, false);
  return parsed.ok ? capturingGroupNames(parsed.value) : [];
}

function run(
  pattern: string,
  flags: string,
  subject: string,
  replacement: string | null = null,
  limits: RunLimits = DEFAULT_LIMITS,
): RegexReport {
  return runRegex(compile(pattern, flags), subject, replacement, limits, namesFor(pattern));
}

/** What `String.prototype.matchAll` says, which is the spec's own answer. */
function reference(pattern: string, flags: string, subject: string): [number, string][] {
  return [...subject.matchAll(new RegExp(pattern, flags))].map((match) => [match.index, match[0]]);
}

function listed(report: RegexReport): [number, string][] {
  return report.matches.map((match) => [match.index, match.match]);
}

/* ========================================================================== *
 * Compiling
 * ========================================================================== */

describe('compiling', () => {
  it('refuses an empty pattern with a message rather than matching everything', () => {
    const result = compilePattern('', 'g');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invalid-input');
  });

  it('turns a syntax error into an explanation and an offset', () => {
    /*
     * What the engine says here is "Invalid regular expression: /\d+(unclosed/:
     * Unterminated group" - the pattern repeated back, prose that differs
     * between V8, SpiderMonkey and JavaScriptCore, and no position at all.
     * The offset is the part that makes it actionable.
     */
    const result = compilePattern('\\d+(unclosed', 'g');
    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error.code).toBe('parse-error');
    expect(result.error.message).toContain('never closed');
    expect(result.error.position?.offset).toBe(3);
    expect(result.error.detail).toBeTruthy();
  });

  it('names Python group syntax for a pattern copied from another language', () => {
    const result = compilePattern('(?P<year>\\d{4})', '');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('Python');
    expect(result.error.detail).toContain('(?<name>...)');
  });

  it('explains that u and v cannot both be on', () => {
    // Reachable only from a hand-edited share link now that the option is a
    // select, but "Invalid flags: uv" is a dead end wherever it comes from.
    const result = compilePattern('a', 'uv');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('cannot both be on');
  });

  it('falls back to matching without `d` where the engine has no `d`', () => {
    // The tool asks for `d` so it can report WHERE a group matched. An engine
    // without it must still run the pattern rather than reporting the tool's
    // own optional flag as the user's syntax error.
    expect(compile('(a)', 'g').hasIndices).toBe(HAS_INDICES);
    expect(compile('(a)', 'g').flags).toContain('g');
  });

  it('names a feature this browser lacks instead of blaming the pattern', () => {
    /*
     * `(?<=a)b` is a syntax error on Safari before 16.4, and the message the
     * engine gives is about syntax - which sends the user hunting for a typo
     * in a pattern that is perfectly well formed. The probe list is injected
     * here because every engine that can run this test has all four features.
     */
    const pretendOld: readonly EngineFeature[] = [
      {
        label: 'lookbehind assertions',
        supported: false,
        wantedBy: (pattern) => pattern.includes('(?<='),
        hint: 'Rewrite it as a capture group you discard.',
      },
    ];

    expect(missingFeature('(?<=a)b', pretendOld)?.label).toBe('lookbehind assertions');
    expect(missingFeature('ab', pretendOld)).toBeNull();
    // And on this engine, which has them all, nothing is reported.
    expect(missingFeature('(?<=a)(?<n>b)\\p{L}')).toBeNull();
  });

  it('assembles flags from the toggles', () => {
    const options = (overrides: Partial<RegexOptions>): RegexOptions => ({
      ...regexDefaultOptions,
      ...overrides,
    });
    expect(flagsFor(options({ global: true, ignoreCase: true }))).toBe('gi');
    expect(flagsFor(options({ global: false, dotAll: true, unicode: 'u' }))).toBe('su');
    expect(flagsFor(options({ global: false, unicode: 'v', sticky: true }))).toBe('vy');
  });

  it('reads the unicode option in its old boolean spelling', () => {
    /*
     * The option used to be a boolean, and options travel in share links and
     * in the saved canvas. Zod strips keys it does not recognise, so without
     * this a link made before the `v` flag existed would come back with the
     * `u` flag quietly missing - the same pattern, matching different text,
     * with nothing on screen to say why.
     */
    expect(regexOptionsSchema.parse({ unicode: true }).unicode).toBe('u');
    expect(regexOptionsSchema.parse({ unicode: false }).unicode).toBe('none');
    expect(regexOptionsSchema.parse({}).unicode).toBe('none');
  });
});

/* ========================================================================== *
 * Matching
 * ========================================================================== */

describe('matching', () => {
  it('reports every match with its offset', () => {
    const report = run('\\d+', 'g', 'a1 bb22 c333');
    expect(report.matches.map((match) => match.match)).toEqual(['1', '22', '333']);
    expect(report.matches.map((match) => match.index)).toEqual([1, 5, 9]);
  });

  it('reports the line and column of each match', () => {
    const report = run('x', 'g', 'ab\ncdx\nx');
    expect(report.matches.map((match) => [match.line, match.column])).toEqual([
      [2, 3],
      [3, 1],
    ]);
  });

  it('reports only the first match without the global flag', () => {
    const report = run('\\d+', '', 'a1 bb22');
    expect(report.matches).toHaveLength(1);
    expect(report.total).toBe(1);
  });

  it('carries positional and named groups', () => {
    const report = run('(?<key>\\w+)=(\\w+)', 'g', 'a=1 b=2');

    expect(report.matches[0]?.groups.map((group) => group.value)).toEqual(['a', '1']);
    expect(report.matches[0]?.groups.map((group) => group.name)).toEqual(['key', null]);
    expect(report.matches[0]?.named).toEqual({ key: 'a' });
  });

  it('records a group that did not participate as null, not undefined', () => {
    const report = run('(a)|(b)', 'g', 'b');
    // JSON has no undefined; a hole in the group list has to survive the trip.
    expect(report.matches[0]?.groups.map((group) => group.value)).toEqual([null, 'b']);
  });

  it('reports where each group matched, not only what it captured', () => {
    // "My group captured the wrong thing" is most of what people come here to
    // work out, and the answer is usually visible from the offsets alone.
    if (!HAS_INDICES) return;
    const report = run('(\\w+)@(\\w+)', 'g', 'x ada@example');
    expect(report.matches[0]?.groups.map((group) => [group.start, group.end])).toEqual([
      [2, 5],
      [6, 13],
    ]);
  });

  /*
   * ZERO-LENGTH MATCHES UNDER THE UNICODE FLAGS.
   *
   * This is the bug this hardening pass exists for. The remedy every tutorial
   * gives for a global pattern that can match nothing is `lastIndex += 1`,
   * and it is wrong under `u` or `v`: incrementing by one code UNIT lands
   * between the two halves of a surrogate pair, and the engine resolves that
   * position back to the start of the same code point. The match repeats at
   * the same offset forever.
   *
   * The symptom was a plausible one rather than a hang: `/^/gu` against any
   * text containing an emoji reported 5,000 matches at index 0 and described
   * itself as merely truncated. The fix is the spec's AdvanceStringIndex.
   */
  describe('zero-length matches next to an astral character', () => {
    const SUBJECT = '\u{1F600}a\u{1F600}';

    it('does not loop on `^` with the unicode flag', () => {
      const report = run('^', 'gu', SUBJECT);
      expect(listed(report)).toEqual(reference('^', 'gu', SUBJECT));
      expect(report.total).toBe(1);
    });

    it('advances by a whole code point on an empty match', () => {
      expect(listed(run('(?:)', 'gu', SUBJECT))).toEqual(reference('(?:)', 'gu', SUBJECT));
      expect(listed(run('a*', 'gu', SUBJECT))).toEqual(reference('a*', 'gu', SUBJECT));
      expect(listed(run('\\B', 'gu', SUBJECT))).toEqual(reference('\\B', 'gu', SUBJECT));
    });

    it('still advances by one code unit when unicode is off', () => {
      // Without `u` the string really is a sequence of code units and every
      // one of them is a valid position, so the old behaviour is the right
      // behaviour there. Both halves have to be preserved.
      expect(listed(run('(?:)', 'g', SUBJECT))).toEqual(reference('(?:)', 'g', SUBJECT));
    });

    it('advances a lone surrogate by one, because it is not a pair', () => {
      expect(advanceIndex('\uD800x', 0, true)).toBe(1);
      expect(advanceIndex('\u{1F600}', 0, true)).toBe(2);
      expect(advanceIndex('\u{1F600}', 0, false)).toBe(1);
    });
  });

  it('terminates on a pattern that can match nothing', () => {
    const report = run('a*', 'g', 'bbb');
    expect(report.matches.length).toBeGreaterThan(0);
    expect(report.matches.length).toBeLessThanOrEqual(MAX_MATCHES);
  });

  /*
   * A truncated listing used to report `count: 5000`, which is a wrong answer
   * presented as a fact - and "how many times does this appear" is the
   * question people most often bring to a regex tester. The scan now keeps
   * counting after it stops describing.
   */
  it('counts every match even when it stops describing them', () => {
    const report = run('a', 'g', 'a'.repeat(MAX_MATCHES + 500));
    expect(report.matches).toHaveLength(MAX_MATCHES);
    expect(report.total).toBe(MAX_MATCHES + 500);
    expect(report.truncated).toBe(true);
    expect(toSummary(report)).toContain('5,500 matches in total');
  });

  it('stops on its own before the worker is killed, and says so', () => {
    /*
     * The worker kill is the only defence against a single `exec` that never
     * returns, but it is a blunt one: it takes the whole result with it. A
     * fast pattern producing an enormous number of matches is the other shape
     * of runaway, and there the tool can stop itself and keep what it found.
     */
    let clock = 0;
    const limits: RunLimits = {
      ...DEFAULT_LIMITS,
      budgetMs: 100,
      now: () => {
        clock += 60;
        return clock;
      },
    };

    const report = run('a', 'g', 'a'.repeat(2_000), null, limits);
    expect(report.stoppedBecause).toBe('budget');
    expect(report.total).toBeLessThan(2_000);
    expect(toSummary(report)).toContain('stopped early');
  });

  it('does not carry lastIndex out of the run', () => {
    // A regex object with a stale lastIndex is the classic "it worked the
    // first time" bug. Nothing here reuses the object, but `replace` below
    // does read it for a sticky pattern.
    const regex = compile('a', 'g');
    runRegex(regex, 'aaa', null);
    expect(regex.lastIndex).toBe(0);
  });
});

/* ========================================================================== *
 * Sticky
 * ========================================================================== */

describe('the sticky flag', () => {
  it('matches consecutively from the start and stops at the first gap', () => {
    const report = run('a', 'gy', 'aab');
    expect(listed(report)).toEqual([
      [0, 'a'],
      [1, 'a'],
    ]);
  });

  /*
   * Sticky WITHOUT global used to be looped over, which produced two matches
   * for `/a/y` on "aab" while the replacement - which the engine does, and
   * which for a non-global regex is a single `exec` - changed one of them.
   * The listing and the replacement disagreeing about how many matches there
   * are is a worse failure than showing one match where a loop could show two.
   */
  it('is a single match without global, exactly as replace treats it', () => {
    const report = run('a', 'y', 'aab', 'X');
    expect(report.matches).toHaveLength(1);
    expect(report.replaced).toBe('Xab');
  });

  it('agrees with replace when global as well', () => {
    const report = run('a', 'gy', 'aab', 'X');
    expect(report.matches).toHaveLength(2);
    expect(report.replaced).toBe('XXb');
  });
});

/* ========================================================================== *
 * Replacement
 * ========================================================================== */

describe('replacing', () => {
  it('replaces with group references', () => {
    const report = run('(\\w+)@(\\w+)', 'g', 'ada@example bob@example', '$2:$1');
    expect(report.replaced).toBe('example:ada example:bob');
  });

  it('replaces with a named reference', () => {
    const report = run('(?<user>\\w+)@(?<host>\\w+)', 'g', 'ada@example', '$<host>/$<user>');
    expect(report.replaced).toBe('example/ada');
  });

  it('leaves the subject alone when nothing matches', () => {
    expect(run('z+', 'g', 'abc', 'X').replaced).toBe('abc');
  });

  it('matches the engine on every replacement token', () => {
    // The tool deliberately does NOT reimplement substitution - the rules are
    // subtle enough that a reimplementation would produce output that merely
    // looked right. This is the assertion that the decision holds.
    const patterns = ['(a)(b)', '(?<x>a)b', 'a', '(a)|(b)', '(a)(b)(c)(d)(e)(f)(g)(h)(i)(j)(k)'];
    const replacements = [
      '$1',
      '$2',
      '$3',
      '$0',
      '$&',
      '$$',
      '$`',
      "$'",
      '$<x>',
      '$<no>',
      '$11',
      'x$',
    ];

    fc.assert(
      fc.property(
        fc.constantFrom(...patterns),
        fc.constantFrom(...replacements),
        fc.constantFrom('ab', 'b', 'abcdefghijk', 'xaby', ''),
        (pattern, replacement, subject) => {
          const report = run(pattern, 'g', subject, replacement);
          expect(report.replaced).toBe(subject.replace(new RegExp(pattern, 'g'), replacement));
          return true;
        },
      ),
      { numRuns: 400 },
    );
  });
});

/* ========================================================================== *
 * The listing and the highlight
 * ========================================================================== */

describe('the summary listing', () => {
  it('escapes the line breaks inside a match', () => {
    /*
     * A match containing a newline used to become two rows, indistinguishable
     * from two matches. The listing is one row per match or it is not a
     * listing.
     */
    const report = run('a.b', 'gs', 'a\nb x a\nb');
    const lines = toSummary(report).split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('a\\nb');
  });

  it('names an empty match rather than printing nothing', () => {
    // An offset followed by nothing reads as a bug in the tool. It is not:
    // it is a position, and saying so is the whole job.
    expect(toSummary(run('x*', 'g', 'ab'))).toContain('(empty match)');
  });
});

describe('the highlight', () => {
  it('reconstructs the subject exactly', () => {
    // The segments are the subject, cut up. If they ever stop concatenating
    // back to it, the highlight is showing text the user did not type.
    fc.assert(
      fc.property(
        fc.constantFrom('a*', '\\w+', '.', '(?:)', '\\b', 'a|b', '^', '$'),
        fc.constantFrom('g', 'gu', 'gm', 'gim'),
        fc.string({ unit: 'binary', maxLength: 120 }),
        (pattern, flags, subject) => {
          const report = run(pattern, flags, subject);
          const rebuilt = (report.segments ?? []).map((segment) => segment.text).join('');
          expect(rebuilt).toBe(subject);
          return true;
        },
      ),
      { numRuns: 400 },
    );
  });

  it('marks a zero-length match as a segment of its own', () => {
    const report = run('^', 'gm', 'a\nb');
    const marks = (report.segments ?? []).filter((segment) => segment.match !== null);
    expect(marks).toHaveLength(2);
    expect(marks.every((segment) => segment.text === '')).toBe(true);
  });

  it('keeps two adjacent matches as two segments', () => {
    // Adjacent matches with no gap between them must not be merged, or the
    // highlight shows one long match where there are two.
    const report = run('ab', 'g', 'abab');
    expect((report.segments ?? []).filter((segment) => segment.match !== null)).toHaveLength(2);
  });

  it('declines to highlight a subject that is too long, and says which', () => {
    const report = run('a', 'g', 'a'.repeat(200), null, {
      ...DEFAULT_LIMITS,
      maxHighlightChars: 100,
    });
    expect(report.segments).toBeNull();
    expect(report.highlightSkipped).toBe('too-long');
  });

  it('stops drawing long before it stops counting', () => {
    const report = run('a', 'g', 'a'.repeat(50), null, {
      ...DEFAULT_LIMITS,
      maxHighlightMatches: 10,
    });
    expect(report.highlightSkipped).toBe('too-many');
    expect((report.segments ?? []).filter((segment) => segment.match !== null)).toHaveLength(10);
    // The tail is still there, so the picture is short rather than wrong.
    expect((report.segments ?? []).map((segment) => segment.text).join('')).toBe('a'.repeat(50));
  });
});

/* ========================================================================== *
 * Agreement with the specification
 * ========================================================================== */

/*
 * `String.prototype.matchAll` is the spec's own answer to "every match of a
 * global pattern", AdvanceStringIndex and all. Anywhere this tool disagrees
 * with it, this tool is wrong - so it is worth asserting directly rather than
 * asserting a handful of examples that happen to be right.
 */
describe('agreement with matchAll', () => {
  const PATTERNS = [
    'a',
    'a*',
    'a+?',
    '(a)(b)?',
    '\\b\\w+\\b',
    '.',
    '.*',
    '\\s|x',
    '(?:)',
    'a|',
    '[^a]*',
    '\\d{1,3}',
    '(?<n>a)|b',
    '^',
    '$',
    '\\B',
    '(?=a)',
    '(?<=a)b',
    '\\p{L}+',
  ];
  const FLAGS = ['g', 'gu', 'gi', 'gm', 'gs', 'gum', 'gv'];
  const SUBJECTS = [
    '',
    'a',
    'ab',
    'aab',
    '\u{1F600}a\u{1F600}',
    'a\nb\nc',
    'x\r\ny',
    'é',
    'ß',
    'aaa bbb',
    'é',
  ];

  it.each(PATTERNS)('matches matchAll for %s across every flag and subject', (pattern) => {
    for (const flags of FLAGS) {
      for (const subject of SUBJECTS) {
        let compiled: RegExp;
        try {
          compiled = new RegExp(pattern, flags);
        } catch {
          continue; // Not every combination is legal; the engine decides.
        }
        expect(listed(runRegex(compiled, subject, null)), `/${pattern}/${flags}`).toEqual(
          reference(pattern, flags, subject),
        );
      }
    }
  });

  it('matches matchAll on generated subjects', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('a*', '\\w*', '(?:)', '.', '[\\s\\S]*?', '\\b', '\\S+', '^.*$'),
        fc.constantFrom('g', 'gu', 'gm', 'gv'),
        fc.string({ unit: 'binary', maxLength: 200 }),
        (pattern, flags, subject) => {
          let compiled: RegExp;
          try {
            compiled = new RegExp(pattern, flags);
          } catch {
            return true;
          }
          const report = runRegex(compiled, subject, null);
          if (report.truncated || report.stoppedBecause !== 'complete') return true;
          expect(listed(report)).toEqual(reference(pattern, flags, subject));
          return true;
        },
      ),
      { numRuns: 800 },
    );
  });
});

/* ========================================================================== *
 * Patterns people actually write
 * ========================================================================== */

describe('patterns from the wild', () => {
  it.each([
    // The email pattern everybody pastes. It is wrong about plenty of real
    // addresses; what matters here is that the tool reports what it does.
    ['\\b[\\w.%+-]+@[\\w.-]+\\.[A-Za-z]{2,}\\b', 'g', 'ada@example.com, bob@x.co.uk', 2],
    // The IPv4 pattern that matches 999.999.999.999. Reporting the match is
    // correct; the pattern is what is wrong, and the tool must not "fix" it.
    ['^(\\d{1,3}\\.){3}\\d{1,3}$', 'gm', '10.0.0.1\n999.999.999.999', 2],
    // Scraping HTML with a regex. It works right up until an attribute
    // contains a `>`, which is the point.
    ['<a href="([^"]*)"[^>]*>', 'g', '<a href="/a" class="x">A</a><a href="/b">B</a>', 2],
    // Naive CSV splitting: three fields, and the quoted comma splits wrongly.
    ['[^,]+', 'g', 'a,"b,c",d', 4],
    // A password rule built out of lookaheads.
    ['^(?=.*[A-Z])(?=.*\\d)(?=.*[^\\w\\s]).{10,}$', 'gm', 'Passw0rd!!!\nshort', 1],
    // Log parsing with named groups.
    [
      '^(?<ip>\\S+) \\S+ \\S+ \\[(?<when>[^\\]]+)\\] "(?<verb>\\w+) (?<path>\\S+)',
      'gm',
      '127.0.0.1 - - [10/Oct/2000:13:55:36 -0700] "GET /a HTTP/1.0" 200 2326',
      1,
    ],
    // A duplicated-word check, using a backreference.
    ['\\b(\\w+)\\s+\\1\\b', 'g', 'the the quick brown brown fox', 2],
  ])('finds the right number of matches for %s', (pattern, flags, subject, expected) => {
    expect(run(pattern, flags, subject).total).toBe(expected);
  });

  it('reports the CSV pattern splitting a quoted comma, rather than hiding it', () => {
    // The tool's job is to show what the pattern does. `[^,]+` on `a,"b,c",d`
    // yields four fields, and the fourth is the giveaway.
    expect(run('[^,]+', 'g', 'a,"b,c",d').matches.map((match) => match.match)).toEqual([
      'a',
      '"b',
      'c"',
      'd',
    ]);
  });
});

/* ========================================================================== *
 * The pathological case
 * ========================================================================== */

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

  it('warns about the shape before the pattern is ever slow', async () => {
    /*
     * The timeout can only speak after two seconds of a dead tab, and it
     * cannot speak at all on the run that finishes. The static check speaks
     * on a subject small enough to complete in microseconds - which is where
     * the warning is actually useful, because that is the run before the one
     * on the real file.
     */
    const result = await regexTool.run({
      inputs: { input: { type: 'text', text: 'aaa!' } },
      options: { ...regexDefaultOptions, pattern: PATTERN },
      context,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const matches = result.value.matches;
    if (matches?.type !== 'json') throw new Error('expected a JSON report');
    expect(matches.data).toMatchObject({ risk: { level: 'danger' } });
  });
});

/* ========================================================================== *
 * The tool
 * ========================================================================== */

describe('the tool', () => {
  const invoke = (
    text: string,
    overrides: Partial<RegexOptions>,
  ): ReturnType<typeof regexTool.run> =>
    regexTool.run({
      inputs: { input: { type: 'text', text } },
      options: { ...regexDefaultOptions, ...overrides },
      context,
    });

  it('lists matches when finding', async () => {
    const result = await invoke('x1 y2', { pattern: '\\d' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.matches?.type).toBe('json');
    const output = result.value.output;
    if (output?.type !== 'text') throw new Error('expected text output');
    expect(output.text).toContain('1');
  });

  it('returns the replaced text when replacing', async () => {
    const result = await invoke('one two', {
      pattern: 'two',
      mode: 'replace',
      replacement: 'three',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const output = result.value.output;
    if (output?.type !== 'text') throw new Error('expected text output');
    expect(output.text).toBe('one three');
  });

  it('reports a bad pattern as an error rather than throwing', async () => {
    const result = await invoke('anything', { pattern: '[' });
    expect(result.ok).toBe(false);
  });

  it('carries the pattern, the flags and the diagnosis in its JSON', async () => {
    const result = await invoke('abc', { pattern: 'z+', ignoreCase: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const matches = result.value.matches;
    if (matches?.type !== 'json') throw new Error('expected a JSON report');
    expect(matches.data).toMatchObject({ pattern: 'z+', flags: 'gi', count: 0 });
  });

  it('never throws, whatever pattern and subject it is given', async () => {
    // The whole result type exists so that bad input is a value rather than
    // an exception. A tool that throws takes the worker down with it.
    await fc.assert(
      fc.asyncProperty(
        fc.string({ maxLength: 24 }),
        fc.string({ unit: 'binary', maxLength: 60 }),
        fc.string({ maxLength: 12 }),
        async (pattern, subject, replacement) => {
          const result = await invoke(subject, { pattern, mode: 'replace', replacement });
          expect(typeof result.ok).toBe('boolean');
          return true;
        },
      ),
      { numRuns: 300 },
    );
  });
});
