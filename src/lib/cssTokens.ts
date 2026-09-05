/**
 * Reads the token CSS files as text and resolves them into plain objects.
 *
 * The files are pulled in with Vite's `?raw` suffix, which hands us the file
 * contents as a string.
 *
 * WHY THIS IS NOT A TEST HELPER ANY MORE
 *
 * It began as one, asserting things about the design system's actual values.
 * The theme editor needs the same answer at runtime - "what does `vellum`
 * resolve `--pb-ink-muted` to?" - in order to show a token's inherited value
 * and to measure contrast against tokens the user has not overridden.
 *
 * `getComputedStyle` cannot supply it. A browser substitutes `var()` at
 * computed-value time, so it would work there; jsdom cascades custom
 * properties but does NOT substitute, and hands back the literal string
 * `var(--raw-paper-600)`. Measured, not assumed. Reading the stylesheet text
 * gives one answer in both environments, and it is the same answer the
 * contrast test has always asserted against - which is what lets the editor's
 * live readout and themes.contrast.test.ts share a single implementation
 * rather than two that could drift.
 *
 * It costs the ~22 kB of raw CSS in whatever chunk imports it. Only the
 * lazily-loaded /styleguide route does.
 */
import primitivesCss from '@/styles/primitives.css?raw';
import semanticCss from '@/styles/semantic.css?raw';
import themesCss from '@/styles/themes.css?raw';

/** A flat map of custom-property name (without `--`) to its resolved value. */
export type TokenMap = Readonly<Record<string, string>>;

/** Selector shape used for theme override blocks in themes.css. */
const THEME_SELECTOR_PREFIX = "[data-theme='";
const THEME_SELECTOR_SUFFIX = "']";

interface Block {
  readonly selector: string;
  readonly declarations: ReadonlyMap<string, string>;
}

/** Removes CSS block comments without needing a regex. */
function stripComments(css: string): string {
  let out = '';
  let cursor = 0;

  while (cursor < css.length) {
    const start = css.indexOf('/*', cursor);
    if (start === -1) {
      out += css.slice(cursor);
      break;
    }
    out += css.slice(cursor, start);
    const end = css.indexOf('*/', start + 2);
    if (end === -1) break;
    cursor = end + 2;
  }

  return out;
}

/** Splits flat (non-nested) CSS into selector/declaration pairs. */
function parseBlocks(css: string): Block[] {
  const source = stripComments(css);
  const blocks: Block[] = [];
  let cursor = 0;

  while (cursor < source.length) {
    const open = source.indexOf('{', cursor);
    if (open === -1) break;
    const close = source.indexOf('}', open);
    if (close === -1) break;

    const selector = source.slice(cursor, open).trim();
    const declarations = new Map<string, string>();

    for (const part of source.slice(open + 1, close).split(';')) {
      const colon = part.indexOf(':');
      if (colon === -1) continue;
      const name = part.slice(0, colon).trim();
      if (!name.startsWith('--')) continue;
      declarations.set(name.slice(2), part.slice(colon + 1).trim());
    }

    blocks.push({ selector, declarations });
    cursor = close + 1;
  }

  return blocks;
}

/** True when `selector` contains `target` in its comma-separated list. */
function selectorMatches(selector: string, target: string): boolean {
  return selector.split(',').some((part) => part.trim() === target);
}

/** Pulls the token name out of `var(--some-name)`. Returns null if not a var(). */
function readVarReference(value: string): string | null {
  if (!value.startsWith('var(')) return null;
  const inner = value.slice(4, value.lastIndexOf(')')).trim();
  if (!inner.startsWith('--')) return null;
  const comma = inner.indexOf(',');
  return (comma === -1 ? inner : inner.slice(0, comma)).trim().slice(2);
}

/**
 * Follows `var()` chains until a literal value is reached.
 * Bails out after a fixed number of hops so a circular reference throws a
 * clear error instead of hanging the test run.
 */
function resolve(name: string, raw: TokenMap): string {
  let value = raw[name];
  if (value === undefined) throw new Error(`Unknown token --${name}`);

  for (let hop = 0; hop < 10; hop += 1) {
    const reference = readVarReference(value);
    if (reference === null) return value;
    const next = raw[reference];
    if (next === undefined) throw new Error(`--${name} points at unknown --${reference}`);
    value = next;
  }

  throw new Error(`--${name} has a circular var() chain`);
}

/**
 * Builds the fully-resolved token map for one theme.
 *
 * Mirrors what the browser does: start from the `:root` declarations in
 * primitives.css and semantic.css, then layer the matching `[data-theme]`
 * block from themes.css on top.
 */
export function resolveTheme(theme: string): TokenMap {
  const raw: Record<string, string> = {};

  for (const block of [...parseBlocks(primitivesCss), ...parseBlocks(semanticCss)]) {
    if (!selectorMatches(block.selector, ':root')) continue;
    for (const [name, value] of block.declarations) raw[name] = value;
  }

  for (const block of parseBlocks(themesCss)) {
    if (
      !selectorMatches(block.selector, `${THEME_SELECTOR_PREFIX}${theme}${THEME_SELECTOR_SUFFIX}`)
    )
      continue;
    for (const [name, value] of block.declarations) raw[name] = value;
  }

  const resolved: Record<string, string> = {};
  for (const name of Object.keys(raw)) resolved[name] = resolve(name, raw);
  return resolved;
}

/** Every semantic token name declared in semantic.css, in source order. */
export function semanticTokenNames(): readonly string[] {
  const names: string[] = [];
  for (const block of parseBlocks(semanticCss)) {
    if (!selectorMatches(block.selector, ':root')) continue;
    for (const name of block.declarations.keys()) names.push(name);
  }
  return names;
}

/** Theme names discovered from the `[data-theme='...']` blocks in themes.css. */
export function overrideThemeNames(): readonly string[] {
  const names: string[] = [];
  for (const block of parseBlocks(themesCss)) {
    const match = block.selector.startsWith(THEME_SELECTOR_PREFIX) ? block.selector : null;
    if (match === null) continue;
    names.push(match.slice(THEME_SELECTOR_PREFIX.length, match.lastIndexOf(THEME_SELECTOR_SUFFIX)));
  }
  return names;
}

/** Token names declared inside each theme override block in themes.css. */
export function themeOverrideTokens(): ReadonlyMap<string, readonly string[]> {
  const result = new Map<string, readonly string[]>();
  const prefix = THEME_SELECTOR_PREFIX;

  for (const block of parseBlocks(themesCss)) {
    if (!block.selector.startsWith(prefix)) continue;
    const name = block.selector.slice(
      prefix.length,
      block.selector.lastIndexOf(THEME_SELECTOR_SUFFIX),
    );
    result.set(name, [...block.declarations.keys()]);
  }

  return result;
}

/**
 * `resolveTheme` re-parses three stylesheets on every call, which is fine once
 * in a test and wasteful in a component that re-renders on every keystroke.
 * The CSS is a build-time constant, so the answer can never go stale.
 */
const themeCache = new Map<string, TokenMap>();

export function cachedTheme(theme: string): TokenMap {
  const hit = themeCache.get(theme);
  if (hit !== undefined) return hit;

  const resolved = resolveTheme(theme);
  themeCache.set(theme, resolved);
  return resolved;
}
