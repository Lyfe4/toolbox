/**
 * Joins class names, dropping anything falsy.
 *
 * Needed because `noUncheckedIndexedAccess` makes every CSS Module lookup
 * `string | undefined` - the compiler cannot know that `styles.button` exists.
 * The `value is string` return type is a TYPE PREDICATE: it tells TypeScript
 * that when this function returns true, the value really is a string, which is
 * what lets `.filter()` narrow the array from `(string | undefined)[]` to
 * `string[]`.
 */
export function cx(...values: readonly (string | false | null | undefined)[]): string {
  return values
    .filter((value): value is string => typeof value === 'string' && value !== '')
    .join(' ');
}
