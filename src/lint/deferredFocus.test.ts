import { ESLint, Linter } from 'eslint';
import tseslint from 'typescript-eslint';
import { beforeAll, describe, expect, it } from 'vitest';

/*
 * THE ONE LINT RULE THAT IS LOAD-BEARING ENOUGH TO TEST.
 *
 * Five separate bugs in this repository have come from deferring a focus move
 * past the end of the task that asked for it - to a `requestAnimationFrame`,
 * a `setTimeout`, or the post-paint half of a `useEffect`. Each was found
 * individually, months apart, because each presented as a different bug: a
 * palette missing the first letters of a word, an `Enter` that landed on
 * "Close the inspector", a keyboard-built pipeline that came out wired
 * backwards. See the note beside the selector in eslint.config.js.
 *
 * The rule that now prevents a sixth is a SELECTOR STRING. Nothing type-checks
 * it, and a rule that has quietly stopped matching looks exactly like a rule
 * with nothing to report - which is the same failure mode as the bug it exists
 * to catch. So the selector is exercised here against the six shapes actually
 * written in this repo and the three that must stay legal.
 *
 * IT IS READ OUT OF THE REAL CONFIG, through ESLint's own resolver rather than
 * by importing the config module: `calculateConfigForFile` answers "what rules
 * are in force for THIS file", so the test also proves the rule reaches .tsx
 * at all. A test carrying its own copy of the selector would only prove that
 * the copy works.
 */

const RULE = 'no-restricted-syntax';

/** A real component file, so "in force here" is the question being asked. */
const TARGET = 'src/features/canvas/Canvas.tsx';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

// `Array.isArray` on an `unknown` narrows to `any[]`, which would leak `any`
// into everything downstream. This narrows to the array of unknowns it is.
function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

/** The rule's options as ESLint resolves them, severity stripped. */
async function shippedOptions(): Promise<readonly unknown[]> {
  // `calculateConfigForFile` is typed `Promise<any>`; narrowed here and never
  // read as anything but `unknown` below.
  const resolved: unknown = await new ESLint().calculateConfigForFile(TARGET);

  const rules: unknown = isRecord(resolved) ? resolved.rules : undefined;
  const entry: unknown = isRecord(rules) ? rules[RULE] : undefined;

  if (!isUnknownArray(entry)) {
    throw new Error(`${RULE} is not in force for ${TARGET}. The rule has been lost, not relaxed.`);
  }
  // [severity, ...options] - the severity is not an option.
  return entry.slice(1);
}

let options: readonly unknown[] = [];

beforeAll(async () => {
  options = await shippedOptions();
});

/**
 * Lint one snippet with the shipped options and return only this rule's
 * complaints.
 *
 * The type-aware half of the config is deliberately absent: the selector is
 * purely syntactic, and standing a TypeScript program up per fixture would
 * make a fast test slow for no extra coverage.
 */
function focusErrors(source: string): readonly Linter.LintMessage[] {
  const messages = new Linter().verify(source, {
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaFeatures: { jsx: true }, sourceType: 'module' },
    },
    rules: { [RULE]: ['error', ...options] },
  });
  return messages.filter((message) => message.message.includes('Focus moved after the task'));
}

describe('the deferred-focus rule', () => {
  /*
   * Each of these is a shape that was really written here, not an invention.
   * The `window.`-prefixed forms are listed separately because the selector
   * has to match a bare identifier AND a member expression, and one that knew
   * only the first would pass this file with half a rule.
   */
  const REFUSED: readonly (readonly [string, string])[] = [
    ['requestAnimationFrame', 'requestAnimationFrame(() => { ref.current?.focus(); });'],
    [
      'window.requestAnimationFrame',
      'window.requestAnimationFrame(() => { ref.current?.focus(); });',
    ],
    ['setTimeout', 'setTimeout(() => { ref.current?.focus(); }, 0);'],
    ['window.setTimeout', 'window.setTimeout(() => { ref.current?.focus(); }, 0);'],
    ['useEffect', 'useEffect(() => { ref.current?.focus(); }, []);'],
    [
      'useEffect, without optional chaining',
      'useEffect(() => { const node = ref.current; if (node) node.focus(); }, []);',
    ],
  ];

  it.each(REFUSED)('refuses a focus move deferred to %s', (_name, source) => {
    expect(focusErrors(source)).toHaveLength(1);
  });

  /*
   * The three legal shapes. Firing on any of these would be worse than having
   * no rule at all: `useLayoutEffect` IS the fix, so flagging it would send
   * the next person straight back to the bug.
   */
  const ALLOWED: readonly (readonly [string, string])[] = [
    ['a layout effect, which is the fix', 'useLayoutEffect(() => { ref.current?.focus(); }, []);'],
    ['an event handler', 'const onClick = () => { ref.current?.focus(); };'],
    [
      'a deferred callback that does not touch focus',
      'useEffect(() => { window.setTimeout(() => { redraw(); }, 0); }, []);',
    ],
  ];

  it.each(ALLOWED)('allows %s', (_name, source) => {
    expect(focusErrors(source)).toHaveLength(0);
  });
});
