/**
 * Up to five of them named, and the rest counted: `a, b, c, d, e, and 3 more`.
 *
 * The bargain every by-path and by-name note in the app strikes - a document
 * with two hundred rounded numbers would otherwise produce a list nobody reads,
 * and a list cut short without a count reads as complete. It was written out
 * by hand at every note that needed it, a dozen times across three tools with
 * two separators, until round twenty-six; the copy in jwt-decode had lost the
 * count, so a token with seven rounded claims named five and said nothing
 * about the other two.
 *
 * The separator also joins the count, so a list whose items contain commas -
 * `btn on <a>, <div>` - can use `'; '` and stay readable.
 */
export const SOME_OF_LIMIT = 5;

export function someOf(items: readonly string[], separator = ', ', limit = SOME_OF_LIMIT): string {
  const shown = items.slice(0, limit);
  const rest = items.length - shown.length;
  return `${shown.join(separator)}${rest > 0 ? `${separator}and ${rest.toString()} more` : ''}`;
}
