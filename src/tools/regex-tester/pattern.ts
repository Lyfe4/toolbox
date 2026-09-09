/**
 * A STRUCTURAL READING OF THE PATTERN, SEPARATE FROM THE ENGINE
 *
 * Three things this tool needs to say cannot be answered by handing the
 * pattern to `new RegExp` and looking at what comes back:
 *
 *  1. WHY a pattern is invalid, and WHERE. Engines answer the first question
 *     in prose that differs between them - V8 says "Unterminated group",
 *     SpiderMonkey says "unterminated parenthetical", JavaScriptCore says
 *     something else again - and none of the three answers the second at all.
 *     Matching on those strings would be a browser-sniffing exercise that
 *     rots the first time an engine rewords a message.
 *
 *  2. Whether a pattern is likely to backtrack catastrophically. That is a
 *     question about nesting, and nesting is exactly what a compiled RegExp
 *     no longer exposes.
 *
 *  3. Which PREFIX of a pattern still matches, when the whole thing does not.
 *     Cutting a pattern short is only meaningful if you cut at a boundary
 *     between its parts, which again means knowing where the parts are.
 *
 * So this module reads the pattern itself. It is deliberately NOT a complete
 * ECMAScript parser: it recognises structure, not semantics, and where it is
 * unsure it says nothing and lets the engine be the authority. Every consumer
 * treats `new RegExp` as the final word on validity - a pattern this module
 * dislikes but the engine accepts still runs.
 */

/* ========================================================================== *
 * Model
 * ========================================================================== */

export type AtomKind =
  'literal' | 'dot' | 'class' | 'escape' | 'anchor' | 'backref' | 'group' | 'empty';

export type GroupKind =
  | 'capturing'
  | 'named'
  | 'non-capturing'
  | 'lookahead'
  | 'negative-lookahead'
  | 'lookbehind'
  | 'negative-lookbehind'
  | 'modifier';

export interface Quantifier {
  readonly text: string;
  readonly min: number;
  /** `Infinity` for `*`, `+` and `{n,}`. */
  readonly max: number;
  readonly lazy: boolean;
  readonly start: number;
  readonly end: number;
}

export interface Atom {
  readonly kind: AtomKind;
  /** Offset of the first character of the atom within the pattern source. */
  readonly start: number;
  /** Offset one past the last character. */
  readonly end: number;
  readonly text: string;
  readonly groupKind: GroupKind | null;
  readonly groupName: string | null;
  /** Present for groups: the `|`-separated branches of the body. */
  readonly alternatives: readonly Sequence[] | null;
}

export interface Term {
  readonly atom: Atom;
  readonly quantifier: Quantifier | null;
  readonly start: number;
  readonly end: number;
}

export type Sequence = readonly Term[];

export interface PatternSyntaxError {
  /** Written for the person who typed the pattern. */
  readonly message: string;
  /** Offset into the pattern, for a caret. */
  readonly offset: number;
  /** The concrete next step, when there is one. */
  readonly hint: string | null;
}

export interface ParsedPattern {
  readonly alternatives: readonly Sequence[];
  readonly capturingGroups: number;
  readonly groupNames: readonly string[];
  /** Names referenced by `\k<name>` that no group defines. */
  readonly unknownNameReferences: readonly string[];
  /** `\1`-style references beyond the number of capturing groups. */
  readonly outOfRangeBackreferences: readonly number[];
}

export type ParseResult =
  | { readonly ok: true; readonly value: ParsedPattern }
  | { readonly ok: false; readonly error: PatternSyntaxError };

/* ========================================================================== *
 * Parsing
 * ========================================================================== */

const DIGITS = new Set('0123456789');

/** `{2}`, `{2,}` and `{2,5}` are quantifiers; anything else is a literal `{`. */
function readBraceQuantifier(
  source: string,
  at: number,
): { readonly min: number; readonly max: number; readonly end: number } | null {
  let index = at + 1;
  let min = '';
  while (index < source.length && DIGITS.has(source[index] ?? '')) {
    min += source[index] ?? '';
    index += 1;
  }
  if (min === '') return null;

  if (source[index] === '}') {
    const value = Number(min);
    return { min: value, max: value, end: index + 1 };
  }

  if (source[index] !== ',') return null;
  index += 1;

  let max = '';
  while (index < source.length && DIGITS.has(source[index] ?? '')) {
    max += source[index] ?? '';
    index += 1;
  }
  if (source[index] !== '}') return null;

  return { min: Number(min), max: max === '' ? Infinity : Number(max), end: index + 1 };
}

interface ParserState {
  readonly source: string;
  readonly unicodeSets: boolean;
  index: number;
  capturing: number;
  readonly names: string[];
  readonly nameReferences: { readonly name: string; readonly offset: number }[];
  readonly numberedReferences: { readonly index: number; readonly offset: number }[];
}

class SyntaxFault extends Error {
  constructor(readonly detail: PatternSyntaxError) {
    super(detail.message);
    this.name = 'SyntaxFault';
  }
}

function fault(message: string, offset: number, hint: string | null = null): never {
  throw new SyntaxFault({ message, offset, hint });
}

/**
 * Reads one escape sequence, starting at the backslash.
 *
 * Multi-character escapes matter here only so that the scan does not mistake
 * a `}` inside `\p{Letter}` or a `{` inside `\u{1F600}` for structure.
 */
function readEscape(state: ParserState): Atom {
  const { source } = state;
  const start = state.index;
  state.index += 1;

  if (state.index >= source.length) {
    fault(
      'The pattern ends with a lone backslash.',
      start,
      'Write `\\\\` for a literal backslash.',
    );
  }

  const marker = source[state.index] ?? '';
  state.index += 1;

  // \p{...} and \P{...} - a Unicode property escape.
  if ((marker === 'p' || marker === 'P') && source[state.index] === '{') {
    const close = source.indexOf('}', state.index);
    if (close === -1) {
      fault(
        'A Unicode property escape is missing its closing brace.',
        start,
        'Write it as `\\p{Letter}`.',
      );
    }
    state.index = close + 1;
    return atomAt('escape', start, state.index, source);
  }

  // \u{...} - a code point escape, only legal under `u` or `v`.
  if (marker === 'u' && source[state.index] === '{') {
    const close = source.indexOf('}', state.index);
    if (close === -1) {
      fault(
        'A code point escape is missing its closing brace.',
        start,
        'Write it as `\\u{1F600}`.',
      );
    }
    state.index = close + 1;
    return atomAt('escape', start, state.index, source);
  }

  // \k<name> - a named backreference.
  if (marker === 'k' && source[state.index] === '<') {
    const close = source.indexOf('>', state.index);
    if (close === -1) {
      fault('A named backreference is missing its closing `>`.', start, 'Write it as `\\k<name>`.');
    }
    const name = source.slice(state.index + 1, close);
    state.nameReferences.push({ name, offset: start });
    state.index = close + 1;
    return atomAt('backref', start, state.index, source);
  }

  // \1 .. \99 - a numbered backreference. \0 is the NUL escape, not a
  // reference, which is why the first digit is excluded here.
  if (DIGITS.has(marker) && marker !== '0') {
    let digits = marker;
    while (state.index < source.length && DIGITS.has(source[state.index] ?? '')) {
      digits += source[state.index] ?? '';
      state.index += 1;
    }
    state.numberedReferences.push({ index: Number(digits), offset: start });
    return atomAt('backref', start, state.index, source);
  }

  return atomAt('escape', start, state.index, source);
}

/**
 * Reads a character class, starting at `[`.
 *
 * Under `v` a class may nest, so the scan counts depth; otherwise the first
 * unescaped `]` closes it. `[]` is an empty class in ECMAScript rather than
 * the start of a class containing `]`, which is why nothing special happens
 * for a `]` in first position.
 */
function readClass(state: ParserState): Atom {
  const { source } = state;
  const start = state.index;
  state.index += 1;
  if (source[state.index] === '^') state.index += 1;

  let depth = 1;
  while (state.index < source.length) {
    const character = source[state.index];

    if (character === '\\') {
      state.index += 2;
      continue;
    }
    if (state.unicodeSets && character === '[') depth += 1;
    if (character === ']') {
      depth -= 1;
      if (depth === 0) {
        state.index += 1;
        return atomAt('class', start, state.index, source);
      }
    }
    state.index += 1;
  }

  fault(
    'A character class was opened with `[` and never closed.',
    start,
    'Add a `]`, or write `\\[` for a literal bracket.',
  );
}

function atomAt(kind: AtomKind, start: number, end: number, source: string): Atom {
  return {
    kind,
    start,
    end,
    text: source.slice(start, end),
    groupKind: null,
    groupName: null,
    alternatives: null,
  };
}

/** Recognises the `(?...` prefixes, returning the kind and the body offset. */
function readGroupPrefix(state: ParserState): {
  readonly kind: GroupKind;
  readonly name: string | null;
  readonly bodyAt: number;
} {
  const { source } = state;
  const open = state.index;
  const after = source.slice(open + 1);

  if (!after.startsWith('?')) {
    state.capturing += 1;
    return { kind: 'capturing', name: null, bodyAt: open + 1 };
  }

  if (after.startsWith('?:')) return { kind: 'non-capturing', name: null, bodyAt: open + 3 };
  if (after.startsWith('?=')) return { kind: 'lookahead', name: null, bodyAt: open + 3 };
  if (after.startsWith('?!')) return { kind: 'negative-lookahead', name: null, bodyAt: open + 3 };
  if (after.startsWith('?<=')) return { kind: 'lookbehind', name: null, bodyAt: open + 4 };
  if (after.startsWith('?<!')) return { kind: 'negative-lookbehind', name: null, bodyAt: open + 4 };

  // `(?P<name>` is Python's spelling and is the single most common thing to
  // arrive here from a pattern written for another flavour.
  if (after.startsWith('?P<') || after.startsWith('?P=')) {
    fault(
      'JavaScript does not support Python-style `(?P<name>...)` groups.',
      open,
      'Write `(?<name>...)`, and `\\k<name>` to refer back to it.',
    );
  }

  if (after.startsWith('?#')) {
    fault(
      'JavaScript regular expressions have no `(?#...)` comment syntax.',
      open,
      'Delete the comment, or keep the note outside the pattern.',
    );
  }

  if (after.startsWith('?<')) {
    const close = source.indexOf('>', open + 2);
    if (close === -1) {
      fault('A named group is missing its closing `>`.', open, 'Write it as `(?<name>...)`.');
    }
    const name = source.slice(open + 3, close);
    if (name === '') fault('A named group has an empty name.', open, 'Write it as `(?<name>...)`.');
    if (state.names.includes(name)) {
      fault(
        `Two groups are both named "${name}".`,
        open,
        'Give each group its own name. (Duplicate names are only allowed in alternatives that cannot both match.)',
      );
    }
    state.names.push(name);
    state.capturing += 1;
    return { kind: 'named', name, bodyAt: close + 1 };
  }

  // `(?i:...)` and `(?-i:...)` - inline modifiers, ES2025. Recognised so the
  // body is parsed as a body rather than as a fault; validity is the engine's
  // call, and an engine without them says so itself.
  const modifier = /^\?[a-z]*(-[a-z]+)?:/.exec(after);
  if (modifier) {
    return { kind: 'modifier', name: null, bodyAt: open + 1 + modifier[0].length };
  }

  fault(
    'That is not a group prefix JavaScript understands.',
    open,
    'The forms are `(...)`, `(?:...)`, `(?<name>...)`, `(?=...)`, `(?!...)`, `(?<=...)` and `(?<!...)`.',
  );
}

function readQuantifier(state: ParserState, atom: Atom): Quantifier | null {
  const { source } = state;
  const start = state.index;
  const character = source[start];
  let min: number;
  let max: number;
  let end: number;

  if (character === '*') {
    [min, max, end] = [0, Infinity, start + 1];
  } else if (character === '+') {
    [min, max, end] = [1, Infinity, start + 1];
  } else if (character === '?') {
    [min, max, end] = [0, 1, start + 1];
  } else if (character === '{') {
    const brace = readBraceQuantifier(source, start);
    if (!brace) return null;
    [min, max, end] = [brace.min, brace.max, brace.end];
  } else {
    return null;
  }

  if (min > max) {
    fault(
      `The quantifier \`${source.slice(start, end)}\` counts down rather than up.`,
      start,
      `Write \`{${max.toString()},${min.toString()}}\` if that is what you meant.`,
    );
  }

  // Anchors and lookarounds consume nothing, so quantifying one is either an
  // error (under `u`) or meaningless. Worth saying either way.
  if (atom.kind === 'anchor') {
    fault(
      'A quantifier here has nothing to repeat.',
      start,
      'Anchors like `^`, `$` and `\\b` match a position, not a character.',
    );
  }

  state.index = end;
  const lazy = source[state.index] === '?';
  if (lazy) state.index += 1;
  // `a++` and `a*+` are possessive quantifiers in other flavours and a syntax
  // error in JavaScript; saying so beats "Nothing to repeat".
  else if (source[state.index] === '+' || source[state.index] === '*') {
    fault(
      'JavaScript has no possessive quantifiers.',
      state.index,
      'Use `?` after a quantifier to make it lazy; there is no possessive form.',
    );
  }

  return { text: source.slice(start, state.index), min, max, lazy, start, end: state.index };
}

function parseSequence(state: ParserState, depth: number, closingAt: number | null): Sequence {
  const { source } = state;
  const terms: Term[] = [];

  while (state.index < source.length) {
    const character = source[state.index];
    if (character === '|') break;
    if (character === ')') {
      if (closingAt === null) {
        fault(
          'There is a `)` with no matching `(`.',
          state.index,
          'Write `\\)` for a literal closing parenthesis.',
        );
      }
      break;
    }

    const start = state.index;
    let atom: Atom;

    if (character === '\\') {
      atom = readEscape(state);
    } else if (character === '[') {
      atom = readClass(state);
    } else if (character === '(') {
      const prefix = readGroupPrefix(state);
      state.index = prefix.bodyAt;
      const alternatives = parseAlternatives(state, depth + 1, start);
      if (source[state.index] !== ')') {
        fault(
          'A group was opened with `(` and never closed.',
          start,
          'Add a `)`, or write `\\(` for a literal parenthesis.',
        );
      }
      state.index += 1;
      atom = {
        kind: 'group',
        start,
        end: state.index,
        text: source.slice(start, state.index),
        groupKind: prefix.kind,
        groupName: prefix.name,
        alternatives,
      };
    } else if (character === '.') {
      state.index += 1;
      atom = atomAt('dot', start, state.index, source);
    } else if (character === '^' || character === '$') {
      state.index += 1;
      atom = atomAt('anchor', start, state.index, source);
    } else if (character === '*' || character === '+' || character === '?') {
      fault(
        `There is nothing for \`${character}\` to repeat.`,
        start,
        `A quantifier follows what it repeats - did you mean \`\\${character}\`?`,
      );
    } else {
      state.index += 1;
      atom = atomAt('literal', start, state.index, source);
    }

    const quantifier = readQuantifier(state, atom);
    terms.push({ atom, quantifier, start, end: state.index });
  }

  return terms;
}

function parseAlternatives(
  state: ParserState,
  depth: number,
  closingAt: number | null,
): Sequence[] {
  // A guard rather than a limit anybody will meet: the recursion is one frame
  // per nesting level, and the option schema caps a pattern at 4,096 chars.
  if (depth > 200) {
    fault('This pattern nests too deeply to analyse.', state.index, null);
  }

  const alternatives: Sequence[] = [parseSequence(state, depth, closingAt)];
  while (state.source[state.index] === '|') {
    state.index += 1;
    alternatives.push(parseSequence(state, depth, closingAt));
  }
  return alternatives;
}

/**
 * Reads a pattern's structure.
 *
 * `unicodeSets` only changes how character classes are scanned - under `v`
 * they nest. Everything else is flavour-independent.
 */
export function parsePattern(pattern: string, unicodeSets = false): ParseResult {
  const state: ParserState = {
    source: pattern,
    unicodeSets,
    index: 0,
    capturing: 0,
    names: [],
    nameReferences: [],
    numberedReferences: [],
  };

  try {
    const alternatives = parseAlternatives(state, 0, null);

    if (state.index < pattern.length) {
      // parseSequence only stops early on `)`, which it already reports.
      fault('The pattern could not be read past here.', state.index, null);
    }

    return {
      ok: true,
      value: {
        alternatives,
        capturingGroups: state.capturing,
        groupNames: state.names,
        unknownNameReferences: state.nameReferences
          .filter((reference) => !state.names.includes(reference.name))
          .map((reference) => reference.name),
        outOfRangeBackreferences: state.numberedReferences
          .filter((reference) => reference.index > state.capturing)
          .map((reference) => reference.index),
      },
    };
  } catch (error) {
    if (error instanceof SyntaxFault) return { ok: false, error: error.detail };
    throw error;
  }
}

/* ========================================================================== *
 * Walking
 * ========================================================================== */

/** Every term in the tree, outermost first. */
export function* walkTerms(alternatives: readonly Sequence[]): Generator<Term> {
  for (const sequence of alternatives) {
    for (const term of sequence) {
      yield term;
      if (term.atom.alternatives) yield* walkTerms(term.atom.alternatives);
    }
  }
}

/** True when a term can repeat without an upper bound. */
export function isUnbounded(term: Term): boolean {
  return term.quantifier !== null && term.quantifier.max === Infinity;
}

/**
 * The name of each capturing group, by position, with `null` for the unnamed.
 *
 * `match.groups` gives names to values but never says which NUMBERED group a
 * name belongs to, and the listing needs both: `$2` and `$<year>` can be the
 * same group, and someone comparing the two has to be able to see that.
 *
 * Order is capture order, which is the order of the opening parentheses -
 * so a group's own number comes before any group nested inside it.
 */
export function capturingGroupNames(parsed: ParsedPattern): readonly (string | null)[] {
  const names: (string | null)[] = [];

  const visit = (alternatives: readonly Sequence[]): void => {
    for (const sequence of alternatives) {
      for (const term of sequence) {
        const { atom } = term;
        if (atom.kind !== 'group') continue;
        if (atom.groupKind === 'capturing') names.push(null);
        else if (atom.groupKind === 'named') names.push(atom.groupName);
        if (atom.alternatives) visit(atom.alternatives);
      }
    }
  };

  visit(parsed.alternatives);
  return names;
}

/* ========================================================================== *
 * Catastrophic backtracking, statically
 * ========================================================================== */

export type RiskLevel = 'none' | 'caution' | 'danger';

export interface RiskFinding {
  readonly level: Exclude<RiskLevel, 'none'>;
  /** The offending fragment of the pattern. */
  readonly fragment: string;
  readonly start: number;
  readonly end: number;
  readonly message: string;
}

export interface RiskReport {
  readonly level: RiskLevel;
  readonly findings: readonly RiskFinding[];
}

/**
 * A coarse set of characters a term can begin with.
 *
 * `null` means "could be anything, or too complicated to say", and every
 * consumer treats that as "no useful information" rather than as the universe.
 * It exists only to answer one question - can two alternatives both match the
 * same character - and it errs towards saying no.
 */
type FirstSet = { readonly kind: 'chars'; readonly chars: ReadonlySet<string> } | null;

const CLASS_ESCAPES: Readonly<Record<string, string>> = {
  d: '0123456789',
  w: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_',
  s: ' \t\n\r\f\v',
};

/** Expands `[a-z0-9_]`, and only that: negation or nesting yields null. */
function firstSetOfClass(text: string): FirstSet {
  const body = text.slice(1, -1);
  if (body.startsWith('^')) return null;

  const chars = new Set<string>();
  let index = 0;

  while (index < body.length) {
    const character = body[index] ?? '';

    if (character === '\\') {
      const escaped = body[index + 1] ?? '';
      const expansion = CLASS_ESCAPES[escaped];
      if (expansion === undefined) {
        if (/[A-Za-z]/.test(escaped)) return null;
        chars.add(escaped);
      } else {
        for (const member of expansion) chars.add(member);
      }
      index += 2;
      continue;
    }

    if (body[index + 1] === '-' && index + 2 < body.length && body[index + 2] !== ']') {
      const from = character.codePointAt(0) ?? 0;
      const to = body[index + 2]?.codePointAt(0) ?? 0;
      if (to < from || to - from > 0x1000) return null;
      for (let code = from; code <= to; code += 1) chars.add(String.fromCodePoint(code));
      index += 3;
      continue;
    }

    chars.add(character);
    index += 1;
  }

  return { kind: 'chars', chars };
}

function firstSetOfSequence(sequence: Sequence): FirstSet {
  const first = sequence[0];
  if (!first) return null;

  const { atom } = first;
  switch (atom.kind) {
    case 'literal':
      return { kind: 'chars', chars: new Set([atom.text]) };
    case 'class':
      return firstSetOfClass(atom.text);
    case 'escape': {
      const expansion = CLASS_ESCAPES[atom.text[1] ?? ''];
      if (expansion !== undefined) return { kind: 'chars', chars: new Set(expansion) };
      // `\.`, `\/`, `\$` and friends: an escaped punctuation character.
      if (atom.text.length === 2 && !/[A-Za-z]/.test(atom.text[1] ?? '')) {
        return { kind: 'chars', chars: new Set([atom.text[1] ?? '']) };
      }
      return null;
    }
    case 'group':
      return atom.alternatives?.length === 1 && atom.alternatives[0]
        ? firstSetOfSequence(atom.alternatives[0])
        : null;
    default:
      return null;
  }
}

function overlaps(left: FirstSet, right: FirstSet): boolean {
  if (!left || !right) return false;
  for (const character of left.chars) if (right.chars.has(character)) return true;
  return false;
}

/**
 * Looks for the two shapes that actually hang browsers.
 *
 * This is a heuristic and is described as one wherever it is shown. It reports
 * structure, not a proof: `(a+)+` is flagged whether or not the subject can
 * trigger the blow-up, and a pattern it stays quiet about can still be slow.
 * The value is that the two shapes below cover almost every real-world case,
 * and both are invisible to someone who has not been bitten before.
 */
export function analyseRisk(parsed: ParsedPattern): RiskReport {
  const findings: RiskFinding[] = [];

  for (const term of walkTerms(parsed.alternatives)) {
    const { atom } = term;
    if (atom.kind !== 'group' || !atom.alternatives) continue;
    if (!isUnbounded(term)) continue;
    // A lookaround is tried once at a position and cannot be re-partitioned,
    // so it does not multiply the way a consuming group does.
    if (atom.groupKind?.includes('look') === true) continue;

    // 1. A quantified group whose body can itself repeat without bound. The
    //    classic `(a+)+`: the input can be split between the two quantifiers
    //    in exponentially many ways, and a failing tail makes the engine try
    //    every one of them.
    const inner = [...walkTerms(atom.alternatives)].find((child) => isUnbounded(child));
    if (inner) {
      findings.push({
        level: 'danger',
        fragment: atom.text + (term.quantifier?.text ?? ''),
        start: term.start,
        end: term.end,
        message: `\`${term.atom.text}${term.quantifier?.text ?? ''}\` repeats something that can already repeat. The engine can split the input between the two quantifiers in exponentially many ways, and it will try all of them before giving up.`,
      });
      continue;
    }

    // 2. A quantified group whose branches can match the same character. In
    //    `(a|a)*` every character has two derivations, so n characters have
    //    2^n - the same explosion by a different route.
    if (atom.alternatives.length > 1) {
      const sets = atom.alternatives.map((branch) => firstSetOfSequence(branch));
      const ambiguous = sets.some((left, index) =>
        sets.slice(index + 1).some((right) => overlaps(left, right)),
      );
      if (ambiguous) {
        findings.push({
          level: 'danger',
          fragment: atom.text + (term.quantifier?.text ?? ''),
          start: term.start,
          end: term.end,
          message: `\`${term.atom.text}${term.quantifier?.text ?? ''}\` repeats alternatives that can match the same text. Every character then has more than one derivation, and the number of combinations grows exponentially.`,
        });
        continue;
      }
    }

    // 3. Everything else that repeats a multi-character group is worth a
    //    glance but is not, on its own, a blow-up.
    const body = atom.alternatives[0];
    if (atom.alternatives.length === 1 && body && body.length > 1) {
      findings.push({
        level: 'caution',
        fragment: atom.text + (term.quantifier?.text ?? ''),
        start: term.start,
        end: term.end,
        message: `\`${term.atom.text}${term.quantifier?.text ?? ''}\` repeats a group of several parts. That is usually fine, but it is where nested-quantifier blow-ups start.`,
      });
    }
  }

  const level: RiskLevel = findings.some((finding) => finding.level === 'danger')
    ? 'danger'
    : findings.length > 0
      ? 'caution'
      : 'none';

  return { level, findings };
}

/* ========================================================================== *
 * Prefixes, for narrowing down where a pattern stops matching
 * ========================================================================== */

/**
 * The pattern cut short at each top-level boundary, shortest first.
 *
 * Only meaningful when the pattern is a single sequence: with a top-level `|`
 * the first branch is not a prefix of the whole, and cutting inside a group
 * would produce something that does not compile. A trailing `$` is dropped
 * from each prefix, because keeping it would make every prefix fail for a
 * reason that has nothing to do with the part being tested.
 */
export function prefixesOf(parsed: ParsedPattern, pattern: string): readonly string[] {
  if (parsed.alternatives.length !== 1) return [];
  const sequence = parsed.alternatives[0];
  if (!sequence || sequence.length < 2) return [];

  const prefixes: string[] = [];
  for (const term of sequence) {
    if (term.atom.kind === 'anchor' && term.atom.text === '$') break;
    prefixes.push(pattern.slice(0, term.end));
  }

  // Dropping the trailing `$` can leave a "prefix" that is the whole pattern,
  // and the caller has already run that.
  return prefixes.filter((prefix) => prefix !== pattern);
}
