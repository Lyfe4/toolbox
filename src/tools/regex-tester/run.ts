import { fail, ok, type JsonValue, type ToolResult } from '@/features/registry/types';

import { parsePattern, type ParsedPattern, type PatternSyntaxError } from './pattern';

/**
 * REGEX EXECUTION, AND WHY IT RUNS IN A WORKER
 *
 * JavaScript's regex engine is a backtracking one. For a pattern like
 * `(a+)+$` against a string of `a`s with no match, the number of ways to
 * partition the input grows exponentially, and `RegExp.prototype.exec` will
 * sit there for longer than the heat death of anything you care about.
 *
 * There is no way to interrupt it from inside. `exec` is a single synchronous
 * call into the engine; no AbortSignal, no step budget, no callback ever runs.
 * Every "regex timeout" that works in JavaScript works the same way: put the
 * call somewhere killable and kill it. That is exactly what the execution
 * engine does with a wedged worker - it terminates and replaces it - which is
 * why this tool declares `strategy: 'worker'` and a deliberately short
 * timeout, and why it supplies its own `timeoutMessage` so the user is told it
 * was their pattern that was too slow rather than that "the tool failed".
 *
 * What this module CAN bound is the work it asks for BETWEEN engine calls: a
 * match limit, a highlight limit, and a soft time budget checked between
 * matches. None of the three helps against a single `exec` that never
 * returns - only the worker kill does - but all three help against the other
 * shape of runaway, which is a perfectly fast pattern asked to produce a
 * million results.
 */

export const REGEX_FLAGS = ['g', 'i', 'm', 's', 'u', 'v', 'y'] as const;
export type RegexFlag = (typeof REGEX_FLAGS)[number];

/**
 * How many matches are described in full.
 *
 * Past this the scan carries on COUNTING but stops building result objects.
 * That split is deliberate: "how many times does this appear" is the question
 * people most often bring to a regex tester, and the previous behaviour -
 * stop at 5,000 and report 5,000 as the count - answered it with a number
 * that looked like a fact and was not.
 */
export const MAX_MATCHES = 5_000;

/**
 * How many matches the highlighted view draws.
 *
 * Every highlighted match is a DOM element. Five thousand of them is a slide
 * show, and nobody reads the four thousandth. The listing and the count are
 * unaffected; only the picture stops.
 */
export const MAX_HIGHLIGHT_MATCHES = 500;

/** Above this the subject is not shipped to the view at all. */
export const MAX_HIGHLIGHT_CHARS = 100_000;

/**
 * Soft budget for the scan, well under the 2s worker kill.
 *
 * Measured: every honest pattern tried against the largest subject this tool
 * accepts (2M characters of Apache log) finishes in under 25 ms, so anything
 * that reaches a second here is already pathological. Stopping ourselves lets
 * the user keep the matches found so far and read an explanation, where the
 * worker kill gives them neither.
 */
export const SCAN_BUDGET_MS = 1_000;

/** How often the budget is consulted. A clock read per match would dominate. */
const BUDGET_CHECK_INTERVAL = 256;

export interface GroupDetail {
  /** 1-based, as it is written in a replacement string. */
  readonly number: number;
  readonly name: string | null;
  /** `null` when the group took no part in this match. */
  readonly value: string | null;
  /** Offsets into the subject, when the engine supports the `d` flag. */
  readonly start: number | null;
  readonly end: number | null;
}

export interface MatchDetail {
  /** UTF-16 code unit offset, the unit the engine itself reports. */
  readonly index: number;
  readonly end: number;
  /** 1-based line, and column in UTF-16 code units. */
  readonly line: number;
  readonly column: number;
  readonly match: string;
  /** A match of length zero. Legal, useful, and easy to mistake for a bug. */
  readonly empty: boolean;
  readonly groups: readonly GroupDetail[];
  readonly named: Readonly<Record<string, string | null>>;
}

/** One run of the subject: either inside a match, or between two. */
export interface Segment {
  readonly text: string;
  /** Index into `matches`, or null for the text between matches. */
  readonly match: number | null;
}

export type StopReason = 'complete' | 'budget';

export interface RegexReport {
  readonly matches: readonly MatchDetail[];
  /** Every match found, including the ones past the listing limit. */
  readonly total: number;
  readonly truncated: boolean;
  /** Why the scan stopped. `budget` means the total is a lower bound. */
  readonly stoppedBecause: StopReason;
  readonly segments: readonly Segment[] | null;
  /** Why there are no segments, when there are none. */
  readonly highlightSkipped: 'too-long' | 'too-many' | null;
  readonly replaced: string | null;
}

/* ========================================================================== *
 * Compiling
 * ========================================================================== */

/**
 * Whether this engine supports the `d` flag.
 *
 * `d` costs nothing at match time and yields `match.indices`, which is the
 * only way to say WHERE a capture group matched rather than merely what it
 * captured - and "my group captured the wrong thing" is most of what people
 * come here to work out. Probed once, because an engine without it throws on
 * construction and the tool must still work there.
 */
export const HAS_INDICES: boolean = (() => {
  try {
    return new RegExp('', 'd').hasIndices;
  } catch {
    return false;
  }
})();

export interface CompileFailure {
  readonly message: string;
  readonly detail: string;
  readonly offset: number | null;
  readonly hint: string | null;
}

/**
 * Builds the RegExp, and explains a syntax error in words rather than
 * repeating the engine's.
 *
 * ORDER MATTERS. The engine is asked first and is the only authority on
 * whether a pattern is valid: a pattern our own reader dislikes but the
 * engine accepts simply runs. Only once the engine has refused is the reader
 * consulted, and only to turn "Invalid regular expression: /(a/u:
 * Unterminated group" into "A group was opened with `(` and never closed",
 * plus the offset the engine never reports. Where the reader has nothing to
 * say, the engine's own message is shown instead of a worse guess.
 */
export function compilePattern(pattern: string, flags: string): ToolResult<RegExp> {
  if (pattern === '') {
    return fail('invalid-input', 'Enter a pattern to test.', {
      detail: 'An empty pattern would match at every position, which is never what anyone means.',
    });
  }

  const wanted = HAS_INDICES && !flags.includes('d') ? `${flags}d` : flags;

  try {
    return ok(new RegExp(pattern, wanted));
  } catch (error) {
    // A browser that rejected `d` rather than the pattern still gets to run.
    if (wanted !== flags) {
      try {
        return ok(new RegExp(pattern, flags));
      } catch {
        // Fall through to the report below, built from the original failure.
      }
    }

    const raw = error instanceof Error ? error.message : String(error);
    const explained = explainCompileFailure(pattern, flags, raw);

    return fail('parse-error', explained.message, {
      detail:
        explained.hint === null ? explained.detail : `${explained.hint} (${explained.detail})`,
      ...(explained.offset === null
        ? {}
        : { position: { line: 1, column: explained.offset + 1, offset: explained.offset } }),
    });
  }
}

/** Flag-level failures the reader cannot see, because they are not in the pattern. */
function explainFlagFailure(flags: string, raw: string): CompileFailure | null {
  if (!/invalid flags/i.test(raw)) return null;

  if (flags.includes('u') && flags.includes('v')) {
    return {
      message: 'Unicode (u) and Unicode sets (v) cannot both be on.',
      detail: raw,
      offset: null,
      hint: 'Pick one. `v` is `u` plus set notation, so it is the one to keep.',
    };
  }

  if (flags.includes('v')) {
    return {
      message: 'This browser does not support the v flag (Unicode sets).',
      detail: raw,
      offset: null,
      hint: 'Use Unicode (u) instead, or open this in a newer browser.',
    };
  }

  return { message: 'This browser rejected those flags.', detail: raw, offset: null, hint: null };
}

/* -------------------------------------------------------------------------- *
 * Features this engine may not have
 * -------------------------------------------------------------------------- */

export interface EngineFeature {
  readonly label: string;
  /** Probed once at module load, never asserted from a version number. */
  readonly supported: boolean;
  /** True when the pattern is asking for the feature. */
  readonly wantedBy: (pattern: string) => boolean;
  readonly hint: string;
}

/** True when this engine accepts a pattern at all. */
function accepts(pattern: string, flags: string): boolean {
  try {
    new RegExp(pattern, flags);
    return true;
  } catch {
    return false;
  }
}

/**
 * Modern regex features, and whether THIS browser has them.
 *
 * Every one of these is a syntax error on an engine that lacks it, and the
 * message the engine gives is about syntax - "Invalid group", "Invalid escape"
 * - which sends the user looking for a typo in a pattern that is perfectly
 * well formed. Probing beats sniffing a version: the answer is a fact about
 * the browser doing the running rather than a table that goes stale.
 */
export const ENGINE_FEATURES: readonly EngineFeature[] = [
  {
    label: 'lookbehind assertions',
    supported: accepts('(?<=a)b', ''),
    wantedBy: (pattern) => pattern.includes('(?<=') || pattern.includes('(?<!'),
    hint: 'Safari did not support `(?<=...)` until 16.4. Rewrite it as a capture group you discard, or use a newer browser.',
  },
  {
    label: 'named capture groups',
    supported: accepts('(?<n>a)', ''),
    wantedBy: (pattern) => /\(\?<[A-Za-z_$]/.test(pattern),
    hint: 'Use numbered groups - `(...)` and `$1` - instead.',
  },
  {
    label: 'Unicode property escapes',
    supported: accepts('\\p{L}', 'u'),
    wantedBy: (pattern) => /\\[pP]\{/.test(pattern),
    hint: 'Spell the characters out as a class, or use a newer browser.',
  },
  {
    label: 'inline modifier groups',
    supported: accepts('(?i:a)', ''),
    wantedBy: (pattern) => /\(\?[a-z]*-?[a-z]*:/.test(pattern) && !pattern.includes('(?:'),
    hint: '`(?i:...)` is very new. Turn Ignore case on for the whole pattern instead.',
  },
];

/** The first feature the pattern needs and this engine does not have. */
export function missingFeature(
  pattern: string,
  features: readonly EngineFeature[] = ENGINE_FEATURES,
): EngineFeature | null {
  return features.find((feature) => !feature.supported && feature.wantedBy(pattern)) ?? null;
}

export function explainCompileFailure(pattern: string, flags: string, raw: string): CompileFailure {
  const flagFailure = explainFlagFailure(flags, raw);
  if (flagFailure) return flagFailure;

  // Asked before the pattern is read, because on an engine without the
  // feature the pattern is not malformed - it is unsupported, and every
  // structural complaint about it would be a lie.
  const missing = missingFeature(pattern);
  if (missing) {
    return {
      message: `This browser does not support ${missing.label}.`,
      detail: raw,
      offset: null,
      hint: missing.hint,
    };
  }

  const parsed = parsePattern(pattern, flags.includes('v'));

  if (!parsed.ok) return fromSyntaxError(parsed.error, raw);

  // The pattern is structurally sound, so the fault is semantic: an unknown
  // property name, an escape that only `u` forbids, a backreference to a name
  // that does not exist. Those the reader can still often name.
  const semantic = explainSemanticFailure(pattern, flags, parsed.value, raw);
  if (semantic) return semantic;

  return {
    message: 'That pattern is not valid.',
    // Trimmed of the engine's `/pattern/flags:` preamble, which restates what
    // the user can already see and buries the part that says why.
    detail: raw.replace(/^Invalid regular expression: \/.*\/[a-z]*: /, ''),
    offset: null,
    hint: null,
  };
}

function fromSyntaxError(error: PatternSyntaxError, raw: string): CompileFailure {
  return { message: error.message, detail: raw, offset: error.offset, hint: error.hint };
}

function explainSemanticFailure(
  pattern: string,
  flags: string,
  parsed: ParsedPattern,
  raw: string,
): CompileFailure | null {
  const unknownName = parsed.unknownNameReferences[0];
  if (unknownName !== undefined) {
    return {
      message: `\`\\k<${unknownName}>\` refers to a group that does not exist.`,
      detail: raw,
      offset: pattern.indexOf(`\\k<${unknownName}>`),
      hint:
        parsed.groupNames.length > 0
          ? `The named groups here are ${parsed.groupNames.map((name) => `\`${name}\``).join(', ')}.`
          : 'Name a group with `(?<name>...)` before referring to it.',
    };
  }

  const outOfRange = parsed.outOfRangeBackreferences[0];
  if (outOfRange !== undefined) {
    return {
      message: `\`\\${outOfRange.toString()}\` refers to capture group ${outOfRange.toString()}, and there ${parsed.capturingGroups === 1 ? 'is only 1' : `are only ${parsed.capturingGroups.toString()}`}.`,
      detail: raw,
      offset: pattern.indexOf(`\\${outOfRange.toString()}`),
      hint: 'Under the Unicode flags a backreference must name a group that exists.',
    };
  }

  if (/property/i.test(raw)) {
    return {
      message: 'That is not a Unicode property JavaScript knows.',
      detail: raw,
      offset: !pattern.includes('\\p') ? pattern.indexOf('\\P') : pattern.indexOf('\\p'),
      hint: 'Try `\\p{L}`, `\\p{Nd}`, `\\p{Script=Greek}` or `\\p{Emoji}`.',
    };
  }

  if (/invalid escape/i.test(raw) && flags.includes('u')) {
    return {
      message: 'The Unicode flag forbids that escape.',
      detail: raw,
      offset: null,
      hint: 'Under `u`, only known escapes are allowed - `\\-` and `\\q` are errors rather than literals. Escape the character itself, or turn Unicode off.',
    };
  }

  return null;
}

/* ========================================================================== *
 * Matching
 * ========================================================================== */

export interface RunLimits {
  readonly maxMatches: number;
  readonly maxHighlightMatches: number;
  readonly maxHighlightChars: number;
  readonly budgetMs: number;
  readonly now: () => number;
}

export const DEFAULT_LIMITS: RunLimits = {
  maxMatches: MAX_MATCHES,
  maxHighlightMatches: MAX_HIGHLIGHT_MATCHES,
  maxHighlightChars: MAX_HIGHLIGHT_CHARS,
  budgetMs: SCAN_BUDGET_MS,
  now: () => (typeof performance === 'undefined' ? Date.now() : performance.now()),
};

/**
 * The next scan position after a zero-length match.
 *
 * This is the spec's AdvanceStringIndex, and writing it out is not
 * pedantry. `lastIndex += 1` - the remedy every tutorial gives, and the one
 * this tool used to use - lands between the two halves of a surrogate pair
 * under `u` or `v`, and the engine then resolves that position back to the
 * START of the same code point. The match repeats at the same offset forever.
 *
 * The visible symptom was that `/^/gu` against any text containing an emoji
 * produced five thousand matches at index 0 and reported itself as merely
 * "truncated" - a wrong answer wearing the costume of a big one.
 */
export function advanceIndex(subject: string, index: number, unicode: boolean): number {
  if (!unicode || index + 1 >= subject.length) return index + 1;

  const lead = subject.charCodeAt(index);
  if (lead < 0xd800 || lead > 0xdbff) return index + 1;

  const trail = subject.charCodeAt(index + 1);
  if (trail < 0xdc00 || trail > 0xdfff) return index + 1;

  return index + 2;
}

/** Offsets of the first character of each line, for line/column lookup. */
function lineStarts(subject: string): readonly number[] {
  const starts = [0];
  for (let index = 0; index < subject.length; index += 1) {
    if (subject[index] === '\n') starts.push(index + 1);
  }
  return starts;
}

/** Binary search, because doing this per match by scanning is quadratic. */
function lineOf(starts: readonly number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if ((starts[middle] ?? 0) <= offset) low = middle;
    else high = middle - 1;
  }
  return low;
}

function describe(
  match: RegExpExecArray,
  names: readonly (string | null)[],
  starts: readonly number[],
): MatchDetail {
  /*
   * A group that did not participate in the match is `undefined` at runtime.
   * The DOM types model the result as `string[]`, which is simply not true, so
   * the annotations below correct it - and null is the JSON-representable
   * spelling of the same fact.
   */
  const positional: readonly (string | undefined)[] = match.slice(1);
  const named: Readonly<Record<string, string | undefined>> = match.groups ?? {};
  /*
   * `match.indices` is typed as an array of tuples, which - exactly like
   * `groups` above - is not true: a group that did not participate has no
   * entry. Widening it here is the same correction, applied to the same lie.
   */
  const indices: readonly (readonly [number, number] | undefined)[] | undefined = match.indices;

  const line = lineOf(starts, match.index);

  const groups: GroupDetail[] = positional.map((value, offset) => {
    const span = indices?.[offset + 1];
    return {
      number: offset + 1,
      name: names[offset] ?? null,
      value: value ?? null,
      start: span ? span[0] : null,
      end: span ? span[1] : null,
    };
  });

  return {
    index: match.index,
    end: match.index + match[0].length,
    line: line + 1,
    column: match.index - (starts[line] ?? 0) + 1,
    match: match[0],
    empty: match[0] === '',
    groups,
    named: Object.fromEntries(Object.entries(named).map(([name, value]) => [name, value ?? null])),
  };
}

function buildSegments(
  subject: string,
  matches: readonly MatchDetail[],
  limits: RunLimits,
): {
  readonly segments: readonly Segment[] | null;
  readonly skipped: 'too-long' | 'too-many' | null;
} {
  if (subject.length > limits.maxHighlightChars) return { segments: null, skipped: 'too-long' };

  const drawn = Math.min(matches.length, limits.maxHighlightMatches);
  const segments: Segment[] = [];
  let cursor = 0;

  for (let index = 0; index < drawn; index += 1) {
    const detail = matches[index];
    if (!detail) break;
    if (detail.index > cursor) {
      segments.push({ text: subject.slice(cursor, detail.index), match: null });
    }
    // Zero-length matches produce an empty segment on purpose: it is the only
    // thing that can carry "a match happened here" to the renderer, and the
    // renderer draws it as a caret rather than as nothing at all.
    segments.push({ text: detail.match, match: index });
    cursor = Math.max(cursor, detail.end);
  }

  if (cursor < subject.length) {
    segments.push({ text: subject.slice(cursor), match: null });
  }

  return { segments, skipped: drawn < matches.length ? 'too-many' : null };
}

/**
 * Runs a compiled pattern over the subject.
 *
 * The loop only runs for a GLOBAL pattern. Sticky without global is a single
 * `exec` - which is what `String.prototype.replace` does with the same regex,
 * and the listing and the replacement disagreeing about how many matches
 * there are is a worse sin than showing one match where a loop could show
 * three.
 */
export function runRegex(
  regex: RegExp,
  subject: string,
  replacement: string | null,
  limits: RunLimits = DEFAULT_LIMITS,
  names: readonly (string | null)[] = [],
): RegexReport {
  const matches: MatchDetail[] = [];
  const starts = lineStarts(subject);
  const unicode = regex.flags.includes('u') || regex.flags.includes('v');
  const startedAt = limits.now();

  let total = 0;
  let stoppedBecause: StopReason = 'complete';

  if (regex.global) {
    regex.lastIndex = 0;
    let found = regex.exec(subject);

    while (found !== null) {
      total += 1;
      if (matches.length < limits.maxMatches) matches.push(describe(found, names, starts));

      if (found[0] === '') regex.lastIndex = advanceIndex(subject, regex.lastIndex, unicode);

      if (total % BUDGET_CHECK_INTERVAL === 0 && limits.now() - startedAt > limits.budgetMs) {
        stoppedBecause = 'budget';
        break;
      }

      found = regex.exec(subject);
    }

    regex.lastIndex = 0;
  } else {
    const found = regex.exec(subject);
    if (found !== null) {
      total = 1;
      matches.push(describe(found, names, starts));
    }
    if (regex.sticky) regex.lastIndex = 0;
  }

  const { segments, skipped } = buildSegments(subject, matches, limits);

  /*
   * The replacement is the ENGINE'S, not ours.
   *
   * `$1`, `$&`, `` $` ``, `$'`, `$$` and `$<name>` have rules subtle enough
   * to be worth reading twice - `$3` with two groups is literal text, but
   * `$<nope>` with any named group at all is the empty string - and a
   * reimplementation that got one of them wrong would produce output that
   * looked right. Measured, the second pass costs about 5 ms on the largest
   * subject this tool accepts, which is a very cheap way to be certain.
   */
  const replaced = replacement === null ? null : subject.replace(regex, replacement);

  return {
    matches,
    total,
    truncated: matches.length < total,
    stoppedBecause,
    segments,
    highlightSkipped: skipped,
    replaced,
  };
}

/* ========================================================================== *
 * Output
 * ========================================================================== */

/** The full report as JSON, for the view and for wiring into another tool. */
export function toJson(report: RegexReport, extra: Readonly<Record<string, JsonValue>>): JsonValue {
  return {
    ...extra,
    count: report.total,
    listed: report.matches.length,
    truncated: report.truncated,
    complete: report.stoppedBecause === 'complete',
    matches: report.matches.map((match) => ({
      index: match.index,
      end: match.end,
      line: match.line,
      column: match.column,
      match: match.match,
      empty: match.empty,
      groups: match.groups.map((group) => ({
        number: group.number,
        name: group.name,
        value: group.value,
        start: group.start,
        end: group.end,
      })),
      named: { ...match.named },
    })),
    segments:
      report.segments?.map((segment) => ({ text: segment.text, match: segment.match })) ?? null,
    highlightSkipped: report.highlightSkipped,
  };
}

/** A readable summary for the text output when not replacing. */
export function toSummary(report: RegexReport): string {
  if (report.matches.length === 0) return 'No matches.';

  const width = Math.max(...report.matches.map((match) => match.index.toString().length), 6);

  const lines = report.matches.map((match) => {
    const offset = match.index.toString().padStart(width, ' ');
    /*
     * Two things a bare `offset + text` listing got wrong, both of which made
     * the output plausible rather than right: a match containing a newline
     * became two rows indistinguishable from two matches, and a zero-length
     * match became a row with nothing after the offset, indistinguishable
     * from a bug. Escaping the breaks fixes the first; naming the second
     * fixes the second.
     */
    if (match.empty) return `${offset}  (empty match)`;
    return `${offset}  ${match.match.replaceAll('\r', '\\r').replaceAll('\n', '\\n')}`;
  });

  if (report.truncated) {
    lines.push(
      `… ${report.total.toLocaleString('en')} matches in total; the first ${report.matches.length.toLocaleString('en')} are listed.`,
    );
  }
  if (report.stoppedBecause === 'budget') {
    lines.push('… the scan was stopped early, so there may be more.');
  }

  return lines.join('\n');
}
