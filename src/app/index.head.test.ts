import { describe, expect, it } from 'vitest';

import { resolveTheme } from '@/lib/cssTokens';

import { SITE_DESCRIPTION, SITE_NAME, SOCIAL_IMAGE_ALT } from './head';
import indexHtml from '../../index.html?raw';

/**
 * THE STATIC HEAD.
 *
 * index.html carries a complete baseline of meta tags, because it is the only
 * thing a crawler or a link-preview bot will ever see - none of them run the
 * router. This file asserts the set is complete and self-consistent, since
 * nothing else in the build would notice a missing one.
 *
 * The file is read with Vite's `?raw` suffix, the same trick the token tests
 * use, and matched with small regexes rather than a DOM parse: these are
 * assertions about the SHIPPED TEXT, and parsing it would paper over a
 * malformed tag that a browser happened to recover from.
 *
 * Note that this is the SOURCE, so `%VITE_SITE_URL%` is still a placeholder
 * here. That it gets substituted, and that the result is absolute, is enforced
 * at build time by vite/plugins/index-html.ts and asserted against the built
 * output in scripts/cross-browser-check.mjs.
 */

const SITE = '%VITE_SITE_URL%';

/** Every TypeScript source in the app, as text. See `the stylesheet` below. */
const sources = import.meta.glob<string>('../**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
});

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

/**
 * THE DOCUMENT OWNS ITS STYLESHEET.
 *
 * It did not, and the bug that produced was invisible to every gate.
 * `main.tsx` imported `@/styles/global.css`, which made the whole style layer
 * part of the MODULE GRAPH. In a production build that is harmless - Vite
 * extracts it and writes a render-blocking <link> into the head, which is why
 * the cross-browser harness, which only ever tests the build, said the first
 * screen was painted. In dev there is no extraction: the CSS arrives as a
 * JavaScript module that injects a <style> tag when it runs.
 *
 * So `pnpm dev` served the cold open - hand-written markup whose entire
 * purpose is to be on screen before any module has been fetched - as raw
 * unstyled HTML on a white page, for as long as the first chunk took. The one
 * screen that was supposed to prove the document could stand on its own was
 * the screen that could not.
 *
 * A <link> in index.html is the same trade the inline theme script already
 * makes, one layer along: whatever has to be true before the module runs is
 * declared by the document, not by the module. Vite resolves the href at
 * build time and emits the identical single hashed stylesheet, so this costs
 * the payload nothing and makes dev and production agree.
 *
 * Both halves are asserted, because either one alone can be reverted without
 * breaking anything a browser would notice in production.
 */
describe('the stylesheet', () => {
  it('is linked by the document rather than imported by a module', () => {
    expect(indexHtml).toMatch(/<link[^>]+rel="stylesheet"[^>]+href="\/src\/styles\/global\.css"/);
  });

  /*
   * And is not ALSO in the module graph. A second owner is not a duplicate
   * stylesheet in the build - Vite dedupes - it is a silent route back to the
   * dev behaviour above, because the module copy is the one dev serves.
   */
  it('is imported by no module', () => {
    const offenders = Object.entries(sources)
      .filter(([, source]) => /import\s+['"][^'"]*styles\/global\.css['"]/.test(source))
      .map(([path]) => path);

    expect(offenders).toEqual([]);
  });
});

describe('the static baseline', () => {
  it('has a title', () => {
    // Not just present: it is what a no-JS crawler and the pre-mount tab show.
    expect(/<title[^>]*>([^<]+)<\/title>/.exec(indexHtml)?.[1]).toBe(SITE_NAME);
  });

  it('describes the site the same way head.ts does', () => {
    for (const [attribute, name] of [
      ['name', 'description'],
      ['property', 'og:description'],
      ['name', 'twitter:description'],
    ] as const) {
      expect(metaContent(attribute, name), name).toBe(SITE_DESCRIPTION);
    }
  });

  it('carries a complete Open Graph set', () => {
    expect(metaContent('property', 'og:type')).toBe('website');
    expect(metaContent('property', 'og:site_name')).toBe(SITE_NAME);
    expect(metaContent('property', 'og:locale')).toBe('en');
    expect(metaContent('property', 'og:title')).toBe(SITE_NAME);
    expect(metaContent('property', 'og:url')).toBe(`${SITE}/`);
    expect(metaContent('property', 'og:image')).toBe(`${SITE}/social-preview.png`);
    expect(metaContent('property', 'og:image:width')).toBe('1200');
    expect(metaContent('property', 'og:image:height')).toBe('630');
    expect(metaContent('property', 'og:image:alt')).toBe(SOCIAL_IMAGE_ALT);
  });

  it('carries a complete Twitter card set', () => {
    // summary_large_image, not summary: the preview is 1200x630, and the small
    // card would centre-crop it into an unreadable square.
    expect(metaContent('name', 'twitter:card')).toBe('summary_large_image');
    expect(metaContent('name', 'twitter:title')).toBe(SITE_NAME);
    expect(metaContent('name', 'twitter:image')).toBe(`${SITE}/social-preview.png`);
  });

  it('declares a canonical URL', () => {
    expect(/<link[^>]*rel="canonical"[^>]*href="([^"]*)"/.exec(indexHtml)?.[1]).toBe(`${SITE}/`);
  });

  it('links every icon the manifest promises', () => {
    for (const href of ['/favicon.svg', '/favicon.ico', '/apple-touch-icon.png']) {
      expect(indexHtml).toContain(`href="${href}"`);
    }
    expect(indexHtml).toContain('rel="manifest" href="/site.webmanifest"');
  });

  it('builds every absolute URL from the one configurable origin', () => {
    // Never a literal hostname in the markup: a custom domain later has to be
    // one edit in .env, not a search for stragglers across the repo.
    expect(indexHtml).not.toMatch(/https:\/\/(?!schema\.org)[a-z0-9.-]+\.[a-z]{2,}/i);
    expect(indexHtml.split(SITE).length - 1).toBeGreaterThanOrEqual(4);
  });
});

describe('the tags the router replaces', () => {
  /*
   * Every tag the runtime also emits must be marked, because React hoists its
   * own copy into <head> without removing what was there. Before this, every
   * route ended up with two <title>, two og:title, two og:description, two
   * description and two og:image. dropStaticHead() clears the marked set once
   * the router's head is live.
   */
  it('the title element is marked data-default', () => {
    // Separate from the list below because the needle is a tag name rather
    // than an attribute, and the shared pattern matches on attributes.
    expect(/<title[^>]*>/.exec(indexHtml)?.[0]).toContain('data-default');
  });

  const REPLACED = [
    'name="description"',
    'rel="canonical"',
    'property="og:title"',
    'property="og:description"',
    'property="og:url"',
    'name="twitter:title"',
    'name="twitter:description"',
  ];

  it.each(REPLACED)('%s is marked data-default', (needle) => {
    const tag = new RegExp(`<[a-z]+[^>]*${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^>]*>`);
    const found = tag.exec(indexHtml)?.[0] ?? '';

    expect(found, `not found: ${needle}`).not.toBe('');
    expect(found).toContain('data-default');
  });

  it('leaves tags the router never touches unmarked', () => {
    // Removing these on mount would drop the favicon and the manifest.
    for (const needle of ['rel="icon"', 'rel="manifest"', 'name="theme-color"']) {
      const tag = new RegExp(`<[a-z]+[^>]*${needle}[^>]*>`);
      expect(tag.exec(indexHtml)?.[0]).not.toContain('data-default');
    }
  });
});
