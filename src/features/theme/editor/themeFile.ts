import { z } from '@/lib/zod';
import { formatColor, parseColor } from '@/tools/color-convert/color';

import { availableLabel, MAX_LABEL_LENGTH, newThemeId } from '../customThemes';
import { THEMED_TOKENS, THEME_NAMES, type CustomTheme, type ThemedToken } from '../types';

/**
 * THEME FILES: EXPORT AND IMPORT
 *
 * An exported theme is a small JSON document a person can read, diff and send.
 * An imported one is somebody else's file, which means it is untrusted input
 * and gets the same treatment as a share link: bounded, schema-checked, and
 * either applied whole or refused whole.
 *
 * WHY ZOD HERE AND NOT IN customThemes.ts. The two validators answer different
 * questions and are meant to behave differently.
 *
 *   - Reading storage is repairing OUR OWN data. One bad token out of twelve
 *     should cost you that token, not the theme. It is lenient, and it runs at
 *     startup, where a 87 kB validation library would be in the initial
 *     payload for every visitor.
 *
 *   - Reading a file is accepting a STRANGER'S data. One bad token means the
 *     document is not what its author meant, and applying the other eleven
 *     produces a theme nobody designed. It is strict, and it runs only in this
 *     lazily-loaded chunk, where Zod is already paid for by the tools.
 *
 * themeFile.test.ts asserts the difference rather than leaving it to be
 * inferred, so neither can drift into the other's behaviour unnoticed.
 */

export const THEME_FILE_KIND = 'patchbay-theme';
export const THEME_FILE_VERSION = 1;

/**
 * A theme is 36 short colours and a name. 16 kB is roughly forty times the
 * largest honest file and small enough that a hostile one cannot make
 * `JSON.parse` the expensive part.
 */
export const MAX_THEME_FILE_BYTES = 16 * 1024;

/**
 * `z.partialRecord` keys the record by the token union while leaving every key
 * optional - `z.record` with an enum key demands all of them, which would
 * refuse the ordinary case of a theme that overrides four colours.
 *
 * A key outside the union is REJECTED rather than dropped: an unknown token
 * name means the file was written for a different version of this application,
 * and quietly ignoring it would apply a theme that is missing whatever that
 * key was for.
 */
const overridesSchema = z.partialRecord(
  z.enum(THEMED_TOKENS),
  z
    .string()
    .max(64)
    // The colour tool's parser decides what a colour is, so a theme file
    // accepts exactly the notations the colour tool converts between.
    .refine((value) => parseColor(value).ok, 'Not a colour this application can read'),
);

/**
 * `strictObject` refuses unknown top-level keys. That is what makes a payload
 * carrying `__proto__` or `constructor` a validation failure rather than
 * something to reason about: it never reaches any code that could act on it.
 */
export const themeFileSchema = z.strictObject({
  kind: z.literal(THEME_FILE_KIND),
  version: z.literal(THEME_FILE_VERSION),
  label: z.string().trim().min(1).max(MAX_LABEL_LENGTH),
  base: z.enum(THEME_NAMES),
  overrides: overridesSchema,
});

export type ThemeFile = z.output<typeof themeFileSchema>;

/* ========================================================================== *
 * Export
 * ========================================================================== */

export function toThemeFile(theme: CustomTheme): ThemeFile {
  return {
    kind: THEME_FILE_KIND,
    version: THEME_FILE_VERSION,
    label: theme.label,
    base: theme.base,
    overrides: { ...theme.overrides },
  };
}

/** Pretty-printed, because the point of JSON over a blob is that it is readable. */
export function serialiseTheme(theme: CustomTheme): string {
  return `${JSON.stringify(toThemeFile(theme), null, 2)}\n`;
}

/** A filename that survives every filesystem: lowercase, hyphens, nothing else. */
export function themeFileName(label: string): string {
  const slug = label
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${slug === '' ? 'theme' : slug}.patchbay-theme.json`;
}

/* ========================================================================== *
 * Import
 * ========================================================================== */

/**
 * A DISCRIMINATED UNION again: after `if (result.ok)` the compiler knows there
 * is a theme, and in the other branch it knows there is a message. There is no
 * way to read a theme without having checked that there is one.
 */
export type ImportResult =
  | { readonly ok: true; readonly theme: CustomTheme }
  | { readonly ok: false; readonly message: string; readonly detail: string | null };

function refuse(message: string, detail: string | null = null): ImportResult {
  return { ok: false, message, detail };
}

/** The first schema complaint, phrased for a person rather than for a log. */
function firstProblem(error: z.ZodError): string {
  const issue = error.issues[0];
  if (issue === undefined) return 'The file is not a Patchbay theme.';

  const where = issue.path.join('.');
  return where === '' ? issue.message : `${where}: ${issue.message}`;
}

/**
 * Turns a theme file into a theme that can be saved.
 *
 * `existing` is used only to pick a free name: a file whose name is already
 * taken is imported as "Midnight 2" rather than refused, because the user
 * asked for the file and renaming it is a chore they can undo by typing.
 */
export function importTheme(text: string, existing: readonly CustomTheme[]): ImportResult {
  /*
   * Bytes, not characters. `text.length` counts UTF-16 code units, and a file
   * of astral-plane characters would be twice the size this thinks it is -
   * which is exactly the shape of input someone probing a size limit sends.
   */
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > MAX_THEME_FILE_BYTES) {
    return refuse(
      'That file is too large to be a theme.',
      `${(bytes / 1024).toFixed(1)} kB, and the limit is ${(MAX_THEME_FILE_BYTES / 1024).toFixed(0)} kB.`,
    );
  }
  if (text.trim() === '') return refuse('That file is empty.');

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return refuse('That file is not valid JSON.');
  }

  const result = themeFileSchema.safeParse(parsed);
  if (!result.success) {
    return refuse('That file is not a Patchbay theme.', firstProblem(result.error));
  }

  /*
   * CANONICALISE ON THE WAY IN.
   *
   * The schema accepts `oklch(0.7 0.2 40)`; storage and the stylesheet accept
   * hex and nothing else. Converting here means the security boundary in
   * customThemes.ts is never asked to make an exception for imports, and that
   * an imported theme is byte-identical to the same theme built by hand.
   */
  const overrides: Partial<Record<ThemedToken, string>> = {};
  // Driven by the known token list rather than by the parsed object's own
  // keys, so every `token` here is a `ThemedToken` by construction and nothing
  // has to be cast back into the union.
  for (const token of THEMED_TOKENS) {
    const value = result.data.overrides[token];
    if (value === undefined) continue;

    const colour = parseColor(value);
    // Unreachable - the schema already refused anything unparseable - but the
    // alternative to checking is a cast, and a cast is a promise the compiler
    // cannot keep.
    if (!colour.ok) return refuse('That file contains a colour that cannot be read.', token);
    overrides[token] = formatColor(colour.value, 'hex', 3);
  }

  return {
    ok: true,
    theme: {
      id: newThemeId(),
      label: availableLabel(result.data.label, existing),
      base: result.data.base,
      overrides,
    },
  };
}
