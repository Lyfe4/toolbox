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

/**
 * Every stylesheet a source file imports, with the binding it imported it as.
 *
 * ANY BINDING NAME, NOT JUST `styles`. Canvas.tsx imports two stylesheets -
 * its own as `styles` and the inspector's as `inspectorStyles` - and a reader
 * that only knew the name `styles` was blind to the second one entirely: nine
 * `inspectorStyles.x` references went unchecked in both directions, and the
 * classes behind them looked unused to the reverse check below. A file may
 * import several, so this returns a list rather than the first match.
 */
function stylesheetImports(source: string): readonly { binding: string; specifier: string }[] {
  return [
    ...source.matchAll(/import\s+([A-Za-z_$][\w$]*)\s+from\s+'([^']+\.module\.css)'/g),
  ].flatMap((match) => {
    const [, binding, specifier] = match;
    return binding === undefined || specifier === undefined ? [] : [{ binding, specifier }];
  });
}

/** Every `<binding>.name` written literally in a source file. */
function referencedClasses(source: string, binding = 'styles'): string[] {
  const pattern = new RegExp(`\\b${binding}\\.([A-Za-z_][\\w$]*)`, 'g');
  return [...source.matchAll(pattern)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]],
  );
}

/**
 * Whether a file ever reaches a stylesheet with a COMPUTED key.
 *
 * `styles[variant]` is deliberate in four components - Button, IconButton,
 * Toast and DiffView each map a size or a tone onto a class - and a static
 * reader has no business guessing at the values. It matters only for the
 * reverse check: a stylesheet reached that way has classes that are genuinely
 * used and unnameable from here, so asking "is every class referenced" of it
 * could only ever fail. Those components assert their own rendered classes.
 */
function usesComputedAccess(source: string, binding: string): boolean {
  return new RegExp(`\\b${binding}\\[`).test(source);
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

/** One (source file, stylesheet) edge, for the forward check. */
const pairs = Object.entries(sources).flatMap(([path, source]) =>
  stylesheetImports(source).flatMap(({ binding, specifier }) => {
    const stylesheetPath = resolveFrom(path, specifier);
    const css = stylesheets[stylesheetPath];
    return css === undefined ? [] : [[path, stylesheetPath, source, css, binding] as const];
  }),
);

/**
 * Every stylesheet, with the union of what its importers name.
 *
 * The reverse check has to be asked of the STYLESHEET rather than of one
 * importer, because several files can share one: `runner.module.css` has four,
 * `viewChrome.module.css` two, and TextArea reaches TextInput's through the
 * alias. Asked per importer, every shared stylesheet would report most of its
 * classes as dead.
 */
const sheets = (() => {
  const map = new Map<
    string,
    { readonly referenced: Set<string>; computed: boolean; readonly importers: string[] }
  >();

  for (const [path, source] of Object.entries(sources)) {
    for (const { binding, specifier } of stylesheetImports(source)) {
      const stylesheetPath = resolveFrom(path, specifier);
      if (stylesheets[stylesheetPath] === undefined) continue;

      const entry = map.get(stylesheetPath) ?? {
        referenced: new Set<string>(),
        computed: false,
        importers: [],
      };
      for (const name of referencedClasses(source, binding)) entry.referenced.add(name);
      entry.computed = entry.computed || usesComputedAccess(source, binding);
      entry.importers.push(path);
      map.set(stylesheetPath, entry);
    }
  }

  return map;
})();

/** The stylesheets the reverse check can be asked of, with their text. */
const reverseCheckable = Object.entries(stylesheets).flatMap(([path, css]) => {
  const entry = sheets.get(path);
  if (!entry || entry.computed) return [];
  return [[path, css, entry.referenced] as const];
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
    const unresolved = Object.entries(sources).flatMap(([path, source]) =>
      stylesheetImports(source)
        .filter(({ specifier }) => stylesheets[resolveFrom(path, specifier)] === undefined)
        .map(({ specifier }) => `${path} -> ${specifier}`),
    );
    expect(unresolved).toEqual([]);
  });

  /*
   * The reader for the SECOND binding gets its own assertion, for the reason
   * the selector reader has one: a matcher that quietly stopped finding
   * `inspectorStyles` would silently return the whole canvas feature to being
   * unchecked in both directions.
   */
  it('sees a stylesheet imported under a name other than `styles`', () => {
    const canvas = sources['../features/canvas/Canvas.tsx'];
    expect(canvas).toBeDefined();
    expect(stylesheetImports(canvas ?? '').map((entry) => entry.binding)).toEqual(
      expect.arrayContaining(['styles', 'inspectorStyles']),
    );
  });

  it.each(pairs.map(([path, sheet, source, css, binding]) => [path, sheet, source, css, binding]))(
    '%s names only classes %s declares',
    (_path, _sheet, source, css, binding) => {
      const declared = declaredClasses(css);
      const missing = referencedClasses(source, binding).filter((name) => !declared.has(name));
      expect([...new Set(missing)]).toEqual([]);
    },
  );

  /*
   * THE SAME QUESTION, ASKED THE OTHER WAY ROUND.
   *
   * The check above catches a class a component names and no stylesheet
   * declares, which is how `.tokens` evaporated. This catches the mirror
   * image: a rule that is declared, maintained, themed, given a
   * reduced-motion variant and a forced-colors variant, and never put on an
   * element.
   *
   * It is not tidiness. Adding it found four dead blocks in the canvas alone,
   * and one of them - `.wireActive` - was not dead CSS at all but a dead
   * FEATURE: the travelling dash that shows data moving through a wire had its
   * class written, its condition computed in Canvas.tsx and the set of active
   * edges passed to `Wires`, which never destructured the prop. A stylesheet
   * describing behaviour the application does not have is the inverse of the
   * rule this repository already enforces about styling that implies behaviour
   * it does not have - and it is harder to notice, because nothing looks wrong:
   * the thing that is missing was never seen working.
   *
   * WHAT IT CANNOT SEE: a stylesheet whose importers use a computed key.
   * `styles[size]` is deliberate in four components, so the values are
   * unknowable here and those sheets are exempt by construction rather than by
   * a list someone has to maintain - see `usesComputedAccess`. Their own tests
   * assert the rendered class instead.
   */
  it('finds stylesheets it can ask the reverse question of', () => {
    expect(reverseCheckable.length).toBeGreaterThan(15);
  });

  it.each(reverseCheckable.map(([path, css, referenced]) => [path, css, referenced]))(
    'every class %s declares is named by a component',
    (_path, css, referenced) => {
      const unused = [...declaredClasses(css)].filter((name) => !referenced.has(name));
      expect(unused).toEqual([]);
    },
  );
});
