import {
  analyseRisk,
  parsePattern,
  prefixesOf,
  walkTerms,
  type ParsedPattern,
  type RiskReport,
} from './pattern';

import type { RegexReport } from './run';

/**
 * WHY A PATTERN DID WHAT IT DID
 *
 * A regex tester that reports the match count correctly and says nothing else
 * has answered the easy half of the question. The hard half - "it found
 * nothing and I cannot see why" - is the reason people open one of these in
 * the first place, and it is answerable, because almost every miss has one of
 * a small number of causes:
 *
 *   - a flag that is off (`i`, `m`, `s`), which is testable by turning it on;
 *   - line endings, where `$` sits before the `\r` of a CRLF pair;
 *   - the pattern pasted with its delimiters still attached;
 *   - one specific part of the pattern that stops matching, which is findable
 *     by cutting the pattern short at each of its top-level boundaries and
 *     asking which is the last one that still matches.
 *
 * Every note here is derived by RUNNING something, never by guessing: if this
 * module says the pattern matches with `i` on, it has compiled that pattern
 * and matched it. That is what stops the advice drifting away from the truth
 * as the rest of the tool changes.
 *
 * The work is bounded. Each probe is a single `test` against a non-global
 * copy, the prefix search is capped, and the whole set is skipped when the
 * main scan was already slow - a pattern that took half a second to find
 * nothing must not be run eight more times to explain itself.
 */

export type NoteLevel = 'info' | 'warn' | 'hint';

export interface Note {
  readonly level: NoteLevel;
  readonly title: string;
  readonly body: string;
}

/** Above this the main scan was slow enough that probing it again is rude. */
const PROBE_BUDGET_MS = 50;

/** A long pattern has a lot of top-level terms; the search is not the point. */
const MAX_PREFIX_PROBES = 24;

/** True when `pattern` finds anything in `subject`. Never throws. */
function wouldMatch(pattern: string, flags: string, subject: string): boolean {
  try {
    // Non-global: one `exec` is all that is being asked, and a global copy
    // would carry lastIndex between calls for no benefit.
    return new RegExp(pattern, flags.replace(/[gy]/g, '')).test(subject);
  } catch {
    return false;
  }
}

function withFlag(flags: string, flag: string): string {
  return flags.includes(flag) ? flags : flags + flag;
}

/* ========================================================================== *
 * Replacement strings
 * ========================================================================== */

export interface ReplacementToken {
  readonly text: string;
  readonly kind: 'literal' | 'match' | 'group' | 'named' | 'prefix' | 'suffix' | 'dollar';
  readonly reference: string | null;
}

/**
 * Splits a replacement string into the tokens the engine will see.
 *
 * The rules are the engine's, reproduced here for EXPLANATION only - the
 * replacement itself is still done by `String.prototype.replace`, so nothing
 * downstream depends on this being exactly right. What it is for is saying
 * "`$3` is not a group reference, because the pattern has two groups, so it
 * will appear literally" - which is the single most common way a replacement
 * silently does the wrong thing.
 */
export function tokeniseReplacement(
  replacement: string,
  groupCount: number,
  hasNamedGroups: boolean,
): readonly ReplacementToken[] {
  const tokens: ReplacementToken[] = [];
  let literal = '';

  const flush = (): void => {
    if (literal !== '') tokens.push({ text: literal, kind: 'literal', reference: null });
    literal = '';
  };

  let index = 0;
  while (index < replacement.length) {
    if (replacement[index] !== '$') {
      literal += replacement[index] ?? '';
      index += 1;
      continue;
    }

    const next = replacement[index + 1];

    if (next === '$') {
      flush();
      tokens.push({ text: '$$', kind: 'dollar', reference: null });
      index += 2;
      continue;
    }
    if (next === '&') {
      flush();
      tokens.push({ text: '$&', kind: 'match', reference: null });
      index += 2;
      continue;
    }
    if (next === '`') {
      flush();
      tokens.push({ text: '$`', kind: 'prefix', reference: null });
      index += 2;
      continue;
    }
    if (next === "'") {
      flush();
      tokens.push({ text: "$'", kind: 'suffix', reference: null });
      index += 2;
      continue;
    }

    // `$<name>` is only a reference when the pattern has named groups at all.
    // Otherwise the whole thing is literal text - which is why a replacement
    // written for the wrong pattern comes out with `$<year>` still in it.
    if (next === '<' && hasNamedGroups) {
      const close = replacement.indexOf('>', index + 2);
      if (close !== -1) {
        flush();
        tokens.push({
          text: replacement.slice(index, close + 1),
          kind: 'named',
          reference: replacement.slice(index + 2, close),
        });
        index = close + 1;
        continue;
      }
    }

    // Two digits are tried before one, so `$12` is group 12 where it exists
    // and group 1 followed by a literal `2` where it does not.
    const two = replacement.slice(index + 1, index + 3);
    const one = replacement.slice(index + 1, index + 2);
    if (/^\d\d$/.test(two) && Number(two) >= 1 && Number(two) <= groupCount) {
      flush();
      tokens.push({ text: `$${two}`, kind: 'group', reference: two });
      index += 3;
      continue;
    }
    if (/^\d$/.test(one) && Number(one) >= 1 && Number(one) <= groupCount) {
      flush();
      tokens.push({ text: `$${one}`, kind: 'group', reference: one });
      index += 2;
      continue;
    }

    literal += '$';
    index += 1;
  }

  flush();
  return tokens;
}

function replacementNotes(replacement: string, parsed: ParsedPattern | null, notes: Note[]): void {
  const groupCount = parsed?.capturingGroups ?? 0;
  const names = parsed?.groupNames ?? [];
  const tokens = tokeniseReplacement(replacement, groupCount, names.length > 0);

  // `\1` is the backreference spelling in a PATTERN, and in sed, and in most
  // other languages' replacement strings. In a JavaScript replacement it is
  // an escaped 1, which is a 1.
  if (/\\\d/.test(replacement)) {
    notes.push({
      level: 'warn',
      title: 'A replacement uses `$1`, not `\\1`',
      body: 'JavaScript spells a group reference in a replacement string with a dollar. `\\1` here is just the character `1`.',
    });
  }

  const literalDollars = tokens
    .filter((token) => token.kind === 'literal' && token.text.includes('$'))
    .map((token) => token.text);

  if (literalDollars.length > 0) {
    const numbered = /\$(\d+)/.exec(replacement);
    if (numbered && Number(numbered[1]) > groupCount) {
      notes.push({
        level: 'warn',
        title: `\`$${numbered[1] ?? ''}\` is not a group reference here`,
        body:
          groupCount === 0
            ? 'The pattern has no capture groups, so this appears in the output literally. Wrap the part you want to keep in parentheses.'
            : `The pattern has ${groupCount.toString()} capture ${groupCount === 1 ? 'group' : 'groups'}, so this appears in the output literally.`,
      });
    } else if (replacement.includes('$0')) {
      notes.push({
        level: 'warn',
        title: '`$0` is not the whole match',
        body: 'Groups are numbered from 1. The whole match is `$&`.',
      });
    }
  }

  const unknownName = tokens.find(
    (token) =>
      token.kind === 'named' && token.reference !== null && !names.includes(token.reference),
  );
  if (unknownName) {
    notes.push({
      level: 'warn',
      title: `\`${unknownName.text}\` names a group that does not exist`,
      body: `Because the pattern has named groups, this is still read as a reference - and an unknown name is replaced by nothing at all rather than left alone. The names here are ${names.map((name) => `\`${name}\``).join(', ')}.`,
    });
  }

  if (tokens.some((token) => token.kind === 'prefix' || token.kind === 'suffix')) {
    notes.push({
      level: 'info',
      title: "This replacement uses `$`` ` or `$'`",
      body: 'They insert everything before, and everything after, the match. On a global replace that means each match carries a copy of the rest of the subject.',
    });
  }
}

/* ========================================================================== *
 * Diagnosis
 * ========================================================================== */

export interface DiagnoseInput {
  readonly pattern: string;
  /** The user's flags, without the `d` this tool adds for itself. */
  readonly flags: string;
  readonly subject: string;
  readonly report: RegexReport;
  readonly mode: 'match' | 'replace';
  readonly replacement: string;
  /** Milliseconds the main scan took, so a slow one is not probed again. */
  readonly elapsedMs: number;
}

export interface Diagnosis {
  readonly notes: readonly Note[];
  readonly risk: RiskReport;
}

export function diagnose(input: DiagnoseInput): Diagnosis {
  const { pattern, flags, report } = input;
  const parsedResult = parsePattern(pattern, flags.includes('v'));
  const parsed = parsedResult.ok ? parsedResult.value : null;
  const notes: Note[] = [];

  delimiterNote(pattern, notes);

  if (report.total === 0) noMatchNotes(input, parsed, notes);
  else matchNotes(input, parsed, notes);

  if (input.mode === 'replace') replacementNotes(input.replacement, parsed, notes);

  return {
    notes,
    risk: parsed ? analyseRisk(parsed) : { level: 'none', findings: [] },
  };
}

/**
 * The pattern still wearing its slashes.
 *
 * Reported whatever the outcome, because the failure is not always "no
 * matches": `/\d+/g` finds nothing in `a1`, but `/a/` finds the `a` in
 * `x/a/y` and looks like it worked.
 */
function delimiterNote(pattern: string, notes: Note[]): void {
  const delimited = /^\/(.*)\/([dgimsuvy]*)$/.exec(pattern);
  if (!delimited || delimited[1] === '' || delimited[1] === undefined) return;

  const trailingFlags = delimited[2] ?? '';
  const flagTail = trailingFlags === '' ? '' : ` and the \`${trailingFlags}\``;

  notes.push({
    level: 'warn',
    title: 'The pattern still has its slashes',
    body: `This box takes the pattern on its own. As written, the leading and trailing \`/\`${flagTail} are being matched as literal characters. Try \`${delimited[1]}\`.`,
  });
}

function noMatchNotes(input: DiagnoseInput, parsed: ParsedPattern | null, notes: Note[]): void {
  const { pattern, flags, subject } = input;

  if (subject === '') {
    notes.push({
      level: 'hint',
      title: 'There is nothing to search',
      body: 'The subject is empty, so only a pattern that can match the empty string would find anything.',
    });
    return;
  }

  if (flags.includes('y') && !flags.includes('g')) {
    notes.push({
      level: 'hint',
      title: 'Sticky (y) anchors the match to the start',
      body: 'With `y` the pattern has to match at position 0 exactly, not somewhere later. Turn it off to search the whole subject.',
    });
  }

  // Probing means running the pattern again, several times. A pattern that
  // was already slow is exactly the one not to do that to.
  if (input.elapsedMs > PROBE_BUDGET_MS) {
    notes.push({
      level: 'info',
      title: 'No diagnosis was attempted',
      body: 'Working out why a pattern did not match means running it again with one thing changed at a time, and this pattern was already slow enough that doing so would be worse than the silence.',
    });
    return;
  }

  flagProbes(pattern, flags, subject, notes);
  crlfNote(pattern, flags, subject, notes);
  prefixNote(pattern, flags, subject, parsed, notes);
}

function flagProbes(pattern: string, flags: string, subject: string, notes: Note[]): void {
  if (!flags.includes('i') && wouldMatch(pattern, withFlag(flags, 'i'), subject)) {
    notes.push({
      level: 'hint',
      title: 'It matches if you ignore case',
      body: 'Turn on Ignore case (i).',
    });
  }

  if (
    !flags.includes('m') &&
    /[$^]/.test(pattern) &&
    wouldMatch(pattern, withFlag(flags, 'm'), subject)
  ) {
    notes.push({
      level: 'hint',
      title: 'It matches with multiline on',
      body: 'Without `m`, `^` and `$` mean the start and end of the whole subject rather than of each line. Turn on Multiline (m).',
    });
  }

  if (
    !flags.includes('s') &&
    pattern.includes('.') &&
    wouldMatch(pattern, withFlag(flags, 's'), subject)
  ) {
    notes.push({
      level: 'hint',
      title: 'It matches if `.` can cross a line break',
      body: 'By default `.` matches anything except a line terminator. Turn on Dot matches newline (s).',
    });
  }

  for (const flag of ['u', 'v'] as const) {
    if (flags.includes(flag) && wouldMatch(pattern, flags.replace(flag, ''), subject)) {
      notes.push({
        level: 'hint',
        title: `It matches without the ${flag === 'u' ? 'Unicode (u)' : 'Unicode sets (v)'} flag`,
        body: 'Under the Unicode flags the pattern is read as code points and the escape rules are stricter, which changes what some patterns mean.',
      });
    }
  }
}

/**
 * A carriage return the pattern did not account for.
 *
 * Text pasted from a Windows file, or copied out of an HTTP response, ends
 * its lines `\r\n`. A pattern written against `\n` - `(.*)\n`, `[^\n]+\n`,
 * anything that names the newline explicitly - then meets a `\r` it was not
 * expecting, because `.` and `[^\n]` both stop at it. This is the single most
 * common "it works in my editor and not here", and it is invisible: the
 * character responsible draws nothing.
 *
 * The test is empirical rather than syntactic. The pattern is run again
 * against the same text with the CRLFs normalised, and the note only appears
 * if that is what made the difference - so it cannot fire on a pattern that
 * already handles them (`$` under `m` matches before a `\r` perfectly well,
 * and gets no note).
 */
function crlfNote(pattern: string, flags: string, subject: string, notes: Note[]): void {
  if (!subject.includes('\r\n')) return;
  if (!wouldMatch(pattern, flags, subject.replaceAll('\r\n', '\n'))) return;

  notes.push({
    level: 'hint',
    title: 'Your text uses CRLF line endings',
    body: `Every line ends \`\\r\\n\`, and this pattern matches once they are plain \`\\n\`. The \`\\r\` is real text: allow for it with \`\\r?\`${pattern.includes('$') ? ' - `\\r?$` rather than `$`' : ''}.`,
  });
}

/**
 * The longest prefix of the pattern that still matches.
 *
 * This is the diagnosis that turns "no matches" into something actionable:
 * not "your pattern is wrong" but "everything up to here is fine, and the
 * next part is what fails". Only attempted on a pattern with no top-level
 * alternation, where a prefix is a meaningful thing - see `prefixesOf`.
 */
function prefixNote(
  pattern: string,
  flags: string,
  subject: string,
  parsed: ParsedPattern | null,
  notes: Note[],
): void {
  if (!parsed) return;

  const prefixes = prefixesOf(parsed, pattern).slice(0, MAX_PREFIX_PROBES);
  if (prefixes.length === 0) return;

  let longest: string | null = null;
  let firstFailure: string | null = null;

  for (const prefix of prefixes) {
    if (wouldMatch(prefix, flags, subject)) longest = prefix;
    else {
      firstFailure = prefix;
      break;
    }
  }

  if (longest === null) {
    notes.push({
      level: 'hint',
      title: 'Even the first part does not match',
      body: `\`${prefixes[0] ?? ''}\` alone finds nothing in this subject, so the problem is at the very start of the pattern rather than somewhere in the middle.`,
    });
    return;
  }

  const failed = firstFailure ?? pattern;

  /*
   * An anchors-only prefix matches for a reason that has nothing to do with
   * the pattern working: `^` finds the start of the subject whatever the rest
   * says. Reporting "it matches as far as `^`" without that caveat reads as
   * progress, and it is not.
   */
  const trivial = /^(\^|\$|\\b|\\B)+$/.test(longest);

  notes.push({
    level: 'hint',
    title: `It matches as far as \`${longest}\``,
    body: `Extending it to \`${failed}\` is what stops it. Whatever \`${failed.slice(longest.length)}\` is meant to match is not there, or not there in that form.${trivial ? ` (\`${longest}\` matches a position rather than any text, so the pattern is really failing at its first real element.)` : ''}`,
  });
}

function matchNotes(input: DiagnoseInput, parsed: ParsedPattern | null, notes: Note[]): void {
  const { flags, subject, report } = input;

  if (report.stoppedBecause === 'budget') {
    notes.push({
      level: 'warn',
      title: 'The scan was stopped early',
      body: `This pattern was still producing matches after ${(input.elapsedMs / 1000).toFixed(1)}s, so the count below is a lower bound rather than a total.`,
    });
  } else if (report.truncated) {
    notes.push({
      level: 'info',
      title: 'The listing is shorter than the count',
      body: `All ${report.total.toLocaleString('en')} matches were counted; the first ${report.matches.length.toLocaleString('en')} are described in full.`,
    });
  }

  if (!flags.includes('g') && report.total === 1) {
    notes.push({
      level: 'info',
      title: 'Only the first match is shown',
      body: 'Global (g) is off, so this is one match rather than all of them.',
    });
  }

  const empties = report.matches.filter((match) => match.empty).length;
  if (empties === report.matches.length && empties > 0) {
    /*
     * `/^/gm` and `/\b/g` match nothing at every line start and every word
     * boundary, and that is the whole point of them - so this is only a
     * warning when the pattern could have consumed something and did not.
     * Telling someone their anchor should have been a `+` is advice about a
     * pattern they did not write.
     */
    const consuming = /[*]|\{0[,}]/.test(input.pattern);

    notes.push({
      level: consuming ? 'warn' : 'info',
      title: 'Every match is empty',
      body: consuming
        ? 'The pattern can match nothing at all, so it matches at every position without consuming anything. That is usually a quantifier that should be `+` rather than `*`.'
        : 'This pattern matches a position rather than any text - an anchor, a boundary or a lookaround - so every result is a place rather than a piece of the subject.',
    });
  } else if (empties > 0) {
    notes.push({
      level: 'info',
      title: `${empties.toString()} of the matches are empty`,
      body: 'An empty match is a position rather than a piece of text. They are marked in the listing and drawn as a caret in the highlight.',
    });
  }

  if (flags.includes('y') && flags.includes('g')) {
    notes.push({
      level: 'info',
      title: 'Sticky (y) stops at the first gap',
      body: 'With `g` and `y` together, matches have to be consecutive from the start of the subject. The scan ends at the first position that does not match rather than searching onwards.',
    });
  }

  // Offsets are in UTF-16 code units, which is what the engine reports and
  // what `slice` expects. It is also not what a person counts, and the
  // difference only shows up in text most test inputs do not contain.
  if (/[\uD800-\uDBFF][\uDC00-\uDFFF]/.test(subject)) {
    notes.push({
      level: 'info',
      title: 'Offsets are in UTF-16 code units',
      body: 'This text contains characters outside the Basic Multilingual Plane - emoji, or some CJK extensions. Each counts as 2 towards every offset here, because that is how JavaScript itself counts them.',
    });
  }

  unusedGroupNote(parsed, report, notes);
}

/** A group that never captured anything, across every match found. */
function unusedGroupNote(parsed: ParsedPattern | null, report: RegexReport, notes: Note[]): void {
  if (!parsed || parsed.capturingGroups === 0 || report.matches.length === 0) return;

  const used = new Set<number>();
  for (const match of report.matches) {
    for (const group of match.groups) if (group.value !== null) used.add(group.number);
  }

  const idle = Array.from({ length: parsed.capturingGroups }, (_, index) => index + 1).filter(
    (number) => !used.has(number),
  );
  if (idle.length === 0) return;

  // A group inside a lookahead is a normal thing to write and captures
  // normally, so this is about groups that never got there at all.
  notes.push({
    level: 'info',
    title: `Group ${idle.map((number) => number.toString()).join(', ')} never captured`,
    body: `${idle.length === 1 ? 'That group' : 'Those groups'} took no part in any of the matches found - an alternative that was never taken, or an optional part that was never present.`,
  });
}

/** True when the pattern contains a group at all. Used by the view's hints. */
export function hasGroups(parsed: ParsedPattern): boolean {
  return [...walkTerms(parsed.alternatives)].some((term) => term.atom.kind === 'group');
}
