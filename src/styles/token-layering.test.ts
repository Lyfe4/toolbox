import { describe, expect, it } from 'vitest';

import { semanticTokenNames } from '@/lib/cssTokens';

/**
 * Enforces the three-layer token rule.
 *
 * The convention is that components describe INTENT (`--pb-ink-secondary`) and
 * never a specific shade (`--raw-grey-300`). A component that hard-codes a
 * shade cannot be re-themed, which would quietly break every preset.
 *
 * ESLint cannot see inside CSS, so the rule is enforced here instead: this
 * test reads every component stylesheet and fails if one reaches past the
 * semantic layer. `import.meta.glob` is Vite's build-time file glob, and
 * `query: '?raw'` asks for each file's text rather than its compiled class map.
 */
const componentStyles = import.meta.glob<string>('../components/**/*.module.css', {
  query: '?raw',
  import: 'default',
  eager: true,
});

const featureStyles = import.meta.glob<string>('../features/**/*.module.css', {
  query: '?raw',
  import: 'default',
  eager: true,
});

const routeStyles = import.meta.glob<string>('../routes/**/*.module.css', {
  query: '?raw',
  import: 'default',
  eager: true,
});

const styleEntries = Object.entries({ ...componentStyles, ...featureStyles, ...routeStyles });

/** Pulls every `var(--name)` reference out of a stylesheet. */
function usedTokens(css: string): string[] {
  const names: string[] = [];
  const opener = 'var(--';
  let cursor = 0;

  for (;;) {
    const start = css.indexOf(opener, cursor);
    if (start === -1) break;

    const nameStart = start + opener.length;
    let end = nameStart;
    while (end < css.length) {
      const char = css[end];
      if (char === ')' || char === ',' || char === ' ') break;
      end += 1;
    }

    names.push(css.slice(nameStart, end));
    cursor = end;
  }

  return names;
}

describe('token layering', () => {
  it('finds the component stylesheets', () => {
    expect(styleEntries.length).toBeGreaterThan(5);
  });

  it.each(styleEntries)('%s uses no primitive tokens directly', (_path, css) => {
    const primitives = usedTokens(css).filter((name) => name.startsWith('raw-'));
    expect(primitives).toEqual([]);
  });

  it.each(styleEntries)('%s only references semantic tokens that exist', (_path, css) => {
    const declared = new Set(semanticTokenNames());
    const unknown = usedTokens(css)
      .filter((name) => name.startsWith('pb-'))
      .filter((name) => !declared.has(name));
    expect([...new Set(unknown)]).toEqual([]);
  });
});
