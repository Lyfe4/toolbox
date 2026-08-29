import { fail, ok, type JsonValue, type ToolResult } from '@/features/registry/types';

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
 * The one thing this module CAN do is bound the work it asks for: a match
 * limit, so a global pattern on a large input cannot produce a million result
 * objects even when each individual match is fast.
 */

export const REGEX_FLAGS = ['g', 'i', 'm', 's', 'u', 'y'] as const;
export type RegexFlag = (typeof REGEX_FLAGS)[number];

/** Beyond this the result is unreadable and the memory is not worth it. */
export const MAX_MATCHES = 5_000;

export interface MatchDetail {
  readonly index: number;
  readonly match: string;
  readonly groups: readonly (string | null)[];
  readonly named: Readonly<Record<string, string | null>>;
}

export interface RegexReport {
  readonly matches: readonly MatchDetail[];
  readonly truncated: boolean;
  readonly replaced: string | null;
}

function describe(match: RegExpExecArray): MatchDetail {
  /*
   * A group that did not participate in the match is `undefined` at runtime.
   * The DOM types model the result as `string[]`, which is simply not true, so
   * the two annotations below correct it - and null is the JSON-representable
   * spelling of the same fact.
   */
  const positional: readonly (string | undefined)[] = match.slice(1);
  const named: Readonly<Record<string, string | undefined>> = match.groups ?? {};

  return {
    index: match.index,
    match: match[0],
    groups: positional.map((group) => group ?? null),
    named: Object.fromEntries(Object.entries(named).map(([name, value]) => [name, value ?? null])),
  };
}

/** Builds the RegExp, turning a syntax error into a structured failure. */
export function compilePattern(pattern: string, flags: string): ToolResult<RegExp> {
  if (pattern === '') return fail('invalid-input', 'Enter a pattern to test.');

  try {
    return ok(new RegExp(pattern, flags));
  } catch (error) {
    return fail('parse-error', 'That pattern is not valid.', {
      detail: error instanceof Error ? error.message : undefined,
    });
  }
}

/**
 * Runs a compiled pattern over the subject.
 *
 * The zero-length-match guard is the classic infinite-loop bug with global
 * regexes: a pattern that can match nothing (`a*`) never advances `lastIndex`
 * on its own, so the loop has to advance it.
 */
export function runRegex(regex: RegExp, subject: string, replacement: string | null): RegexReport {
  const matches: MatchDetail[] = [];
  let truncated = false;

  if (regex.global || regex.sticky) {
    regex.lastIndex = 0;
    let found = regex.exec(subject);

    while (found !== null) {
      matches.push(describe(found));

      if (matches.length >= MAX_MATCHES) {
        truncated = true;
        break;
      }

      if (found[0] === '') regex.lastIndex += 1;
      found = regex.exec(subject);
    }

    regex.lastIndex = 0;
  } else {
    const found = regex.exec(subject);
    if (found !== null) matches.push(describe(found));
  }

  // `replace` already honours the `g` flag, so there is nothing to branch on:
  // it replaces every match when global and the first otherwise.
  const replaced = replacement === null ? null : subject.replace(regex, replacement);

  return { matches, truncated, replaced };
}

/** The match list as JSON, for wiring into another tool. */
export function toJson(report: RegexReport): JsonValue {
  return {
    count: report.matches.length,
    truncated: report.truncated,
    matches: report.matches.map((match) => ({
      index: match.index,
      match: match.match,
      groups: [...match.groups],
      named: { ...match.named },
    })),
  };
}

/** A readable summary for the text output when not replacing. */
export function toSummary(report: RegexReport): string {
  if (report.matches.length === 0) return 'No matches.';

  const lines = report.matches.map(
    (match) => `${match.index.toString().padStart(6, ' ')}  ${match.match}`,
  );

  if (report.truncated) {
    lines.push(`… stopped at ${MAX_MATCHES.toLocaleString('en')} matches.`);
  }

  return lines.join('\n');
}
