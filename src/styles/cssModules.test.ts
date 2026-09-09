import { describe, expect, it } from 'vitest';

/**
 * EVERY `styles.x` A COMPONENT NAMES MUST EXIST IN ITS STYLESHEET.
 *
 * This test exists because of a specific bug. `ThemeEditor.tsx` wrapped its
 * token column in `<div className={styles.tokens}>`, and `.tokens` was never
 * written in `themeEditor.module.css`. `styles.tokens` was therefore
 * `undefined`, `cx` dropped it, and the div went out with no class at all - so
 * the `min-inline-size: 0` that column needed was never applied and the tab
 * strip's 490px min-content width propagated up until the whole styleguide was
 * wider than a phone.
 *
 * NOTHING CAUGHT IT. Vite types a CSS module as `Record<string, string>`, so
 * `styles.tokens` typechecks against a stylesheet that has never heard of it.
 * ESLint does not read CSS. The unit suite renders in jsdom, which has no
 * layout engine and so cannot tell a constrained column from an unconstrained
 * one. The class simply evaporated between two files that agree at compile
 * time and disagree at runtime.
 *
 * A missing class is silent by nature: React renders `class=""` rather than
 * throwing, and the element inherits whatever its parent's layout happens to
 * give it. That is the failure this closes.
 *
 * WHAT IT CANNOT SEE: `styles[variant]`, where the key is computed. Four
 * components do that deliberately for their size and tone variants, and a
 * static reader has no business guessing at the values. Those are covered by
 * the components' own tests asserting the rendered class.
 */
const sources = import.meta.glob<string>('../**/*.tsx', {
  query: '?raw',
  import: 'default',
  eager: true,
});

const stylesheets = import.meta.glob<string>('../**/*.module.css', {
  query: '?raw',
  import: 'default',
  eager: true,
});

/**
 * Every class name a stylesheet declares.
 *
 * Selectors are collected by brace depth rather than by one big regex: a
 * declaration value can contain a dot (`1.5`, `0.5rem`) and an at-rule prelude
 * can too (`(min-resolution: 1.5x)`), so only the text that is actually a
 * selector may be scanned. Requiring a letter or underscore after the dot
 * discards the numeric cases that survive anyway.
 */
function declaredClasses(css: string): Set<string> {
  const withoutComments = css.replaceAll(/\/\*[\s\S]*?\*\//g, '');
  const classes = new Set<string>();

  let selector = '';
  for (const char of withoutComments) {
    if (char === '{') {
      // An at-rule prelude is not a selector, but it also never contains a
      // class, so scanning it costs nothing and skipping it costs a branch.
      for (const match of selector.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) {
        const name = match[1];
        if (name !== undefined) classes.add(name);
      }
      selector = '';
    } else if (char === '}' || char === ';') {
      selector = '';
    } else {
      selector += char;
    }
  }

  return classes;
}

/** The `./x.module.css` a source file imports its `styles` binding from. */
function stylesheetImport(source: string): string | null {
  return /import\s+styles\s+from\s+'([^']+\.module\.css)'/.exec(source)?.[1] ?? null;
}

/** Every `styles.name` written literally in a source file. */
function referencedClasses(source: string): string[] {
  return [...source.matchAll(/\bstyles\.([A-Za-z_][\w$]*)/g)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]],
  );
}

/**
 * Resolves an import specifier to a glob key.
 *
 * Glob keys are relative to this file's directory, so `@/` - which is `src/` -
 * is one level up. TextArea imports TextInput's stylesheet through the alias
 * rather than a relative path, deliberately: a textarea is the same control
 * with a different box.
 */
function resolveFrom(importer: string, specifier: string): string {
  if (specifier.startsWith('@/')) return `../${specifier.slice(2)}`;

  const segments = importer.split('/').slice(0, -1);
  for (const part of specifier.split('/')) {
    if (part === '.') continue;
    if (part === '..') segments.pop();
    else segments.push(part);
  }
  return segments.join('/');
}

const pairs = Object.entries(sources).flatMap(([path, source]) => {
  const specifier = stylesheetImport(source);
  if (specifier === null) return [];
  const stylesheetPath = resolveFrom(path, specifier);
  const css = stylesheets[stylesheetPath];
  return css === undefined ? [] : [[path, stylesheetPath, source, css] as const];
});

describe('CSS modules', () => {
  it('finds the components that use one', () => {
    expect(pairs.length).toBeGreaterThan(20);
  });

  /*
   * The reader is the whole test, so it gets one of its own. A parser that
   * quietly stopped finding classes would turn every assertion below into a
   * comparison of two empty lists and pass forever.
   */
  it('reads classes out of selectors and not out of values', () => {
    const declared = declaredClasses(`
      /* .commented { } */
      .plain { padding: 1.5rem; }
      .a, .b > .c { gap: 0.5em; }
      @media (min-width: 1000px) { .nested { inline-size: 0; } }
      .withState:is(:hover, [data-force='hover']) .child { color: red; }
    `);

    expect([...declared].sort()).toEqual(['a', 'b', 'c', 'child', 'nested', 'plain', 'withState']);
  });

  it('reads literal references and ignores computed ones', () => {
    expect(referencedClasses('cx(styles.button, styles[size], styles.ghost)')).toEqual([
      'button',
      'ghost',
    ]);
  });

  it('resolves every stylesheet a component imports', () => {
    const unresolved = Object.entries(sources)
      .filter(([path, source]) => {
        const specifier = stylesheetImport(source);
        return specifier !== null && stylesheets[resolveFrom(path, specifier)] === undefined;
      })
      .map(([path]) => path);
    expect(unresolved).toEqual([]);
  });

  it.each(pairs.map(([path, sheet, source, css]) => [path, sheet, source, css]))(
    '%s names only classes %s declares',
    (_path, _sheet, source, css) => {
      const declared = declaredClasses(css);
      const missing = referencedClasses(source).filter((name) => !declared.has(name));
      expect([...new Set(missing)]).toEqual([]);
    },
  );
});
