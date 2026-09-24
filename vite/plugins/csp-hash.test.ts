import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

import { radixViewportStylesheet } from './csp-hash';

/**
 * The Radix Select viewport stylesheet, which `style-src` admits by its hash.
 *
 * What cannot be tested here is whether the browser then honours the hash -
 * `checkPopovers` in scripts/cross-browser-check.mjs asserts that nothing is
 * refused and that the stylesheet's rules are live, in two engines. What can
 * be is that the extractor finds the ONE string the installed package renders,
 * and refuses every shape of source where the hash it produced would be for
 * the wrong bytes.
 */

const installed = readFileSync(
  createRequire(import.meta.url).resolve('@radix-ui/react-select'),
  'utf8',
);

describe('radixViewportStylesheet', () => {
  it('finds the stylesheet in the installed package', () => {
    const css = radixViewportStylesheet(installed);

    expect(css.startsWith('[data-radix-select-viewport]{scrollbar-width:none')).toBe(true);
    expect(css).toContain('::-webkit-scrollbar{display:none}');
  });

  it('hashes to what the browser computes over the same bytes', () => {
    // The digest a browser takes is over the element's text as UTF-8. Pinned
    // as a literal so a Radix upgrade that changes the string shows up here,
    // by name, rather than only as a refusal in a browser.
    const digest = createHash('sha256')
      .update(radixViewportStylesheet(installed), 'utf8')
      .digest('base64');

    expect(digest).toBe('441zG27rExd4/il+NvIqyL8zFx5XmyNQtE381kSkUJk=');
  });

  it('accepts the same stylesheet written twice, which a CJS and an ESM build both do', () => {
    const css = '[data-radix-select-viewport]{a:b}';
    expect(radixViewportStylesheet(`__html: \`${css}\` ... __html:\`${css}\``)).toBe(css);
  });

  it('refuses a package with no such stylesheet', () => {
    expect(() => radixViewportStylesheet('export const nothing = 1;')).toThrow(/found 0/);
  });

  it('refuses two different ones, because it could not know which to pin', () => {
    const source =
      '__html: `[data-radix-select-viewport]{a:b}` __html: `[data-radix-select-viewport]{c:d}`';
    expect(() => radixViewportStylesheet(source)).toThrow(/found 2/);
  });

  it('refuses one computed at runtime, which no hash taken here could match', () => {
    // Built by concatenation so the fixture holds a literal `${`.
    const source = '__html: `[data-radix-select-viewport]{width:$' + '{w}px}`';
    expect(() => radixViewportStylesheet(source)).toThrow(/no longer a fixed string/);
  });
});
