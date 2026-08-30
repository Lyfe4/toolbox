import { describe, expect, it } from 'vitest';

import { resolveTheme } from '@/lib/testing/cssTokens';

import { SITE_DESCRIPTION, SITE_NAME, SOCIAL_IMAGE } from './head';
import indexHtml from '../../index.html?raw';

/**
 * index.html carries a handful of values that also exist somewhere else -
 * theme colours that belong to the token files, a description that belongs to
 * head.ts. Nothing in the build makes them agree, so this does.
 *
 * The file is read with Vite's `?raw` suffix, the same trick the token tests
 * use, and matched with small regexes rather than a DOM parse: these are
 * assertions about the SHIPPED TEXT, and parsing it would paper over a
 * malformed tag that a browser happened to recover from.
 */

/** The `content` of a `<meta>` matched by some other attribute pair. */
function metaContent(attribute: string, value: string): string | undefined {
  const pattern = new RegExp(
    `<meta[^>]*${attribute}="${value}"[^>]*content="([^"]*)"|` +
      `<meta[^>]*content="([^"]*)"[^>]*${attribute}="${value}"`,
  );
  const match = pattern.exec(indexHtml);
  return match?.[1] ?? match?.[2];
}

describe('theme-color', () => {
  /*
   * The browser paints its own chrome with these before a single line of our
   * CSS has run, so they cannot come from a custom property at runtime - they
   * are the one place a token value is legitimately duplicated as a literal.
   */
  it.each([
    ['dark', 'graphite'],
    ['light', 'vellum'],
  ])('matches the %s default theme (%s)', (scheme, theme) => {
    const pattern = new RegExp(
      `<meta name="theme-color" media="\\(prefers-color-scheme: ${scheme}\\)" content="([^"]*)"`,
    );
    const declared = pattern.exec(indexHtml)?.[1];

    expect(declared).toBe(resolveTheme(theme)['pb-surface-raised']);
  });
});

describe('the default head', () => {
  it('has a title', () => {
    // Not just present: it is what a no-JS crawler and the pre-mount tab show.
    expect(/<title>([^<]+)<\/title>/.exec(indexHtml)?.[1]).toBe(SITE_NAME);
  });

  it('describes the site the same way head.ts does', () => {
    expect(metaContent('name', 'description')).toBe(SITE_DESCRIPTION);
    expect(metaContent('property', 'og:description')).toBe(SITE_DESCRIPTION);
  });

  it('points at the generated social image, at its real size', () => {
    expect(metaContent('property', 'og:image')).toBe(SOCIAL_IMAGE);
    expect(metaContent('property', 'og:image:width')).toBe('1200');
    expect(metaContent('property', 'og:image:height')).toBe('630');
  });

  it('links every icon the manifest promises', () => {
    for (const href of ['/favicon.svg', '/favicon.ico', '/apple-touch-icon.png']) {
      expect(indexHtml).toContain(`href="${href}"`);
    }
    expect(indexHtml).toContain('rel="manifest" href="/site.webmanifest"');
  });
});
