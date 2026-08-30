/**
 * Counted nouns.
 *
 * Exists because "1 wires" shipped. The status bar, the node footers and the
 * palette each did their own `${n} wires`, and only some of them remembered
 * the singular. One function means the next counter cannot get it wrong by
 * omission, and a test can cover every caller at once.
 *
 * English-only and deliberately so: Patchbay has no localisation, and a
 * pluralisation library that supports Polish would be a hundred times the size
 * of the problem. `Intl.PluralRules` is the escape hatch if that ever changes.
 */
export function plural(count: number, singular: string, pluralForm?: string): string {
  return count === 1 ? singular : (pluralForm ?? `${singular}s`);
}

/** "1 wire", "2 wires", "0 wires". */
export function counted(count: number, singular: string, pluralForm?: string): string {
  return `${count.toString()} ${plural(count, singular, pluralForm)}`;
}
