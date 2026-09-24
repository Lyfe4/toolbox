import { render } from '@testing-library/react';
import * as aliased from 'react-style-singleton';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { styleHookSingleton, styleSingleton, stylesheetSingleton } from './styleSingleton';

/**
 * The stand-in for react-style-singleton that keeps react-remove-scroll's page
 * scroll lock from being a `<style>` element the CSP refuses.
 *
 * jsdom has no constructable stylesheets, so they are provided here: a sheet
 * that records its text, and an `adoptedStyleSheets` that is a plain array.
 * Whether a real engine applies the result, under the real policy, with
 * nothing refused, is not a question jsdom can answer - `checkPopovers` in
 * scripts/cross-browser-check.mjs asks it in two engines.
 */

class FakeSheet {
  text = '';
  replaceSync(text: string) {
    this.text = text;
  }
}

const adopted = () =>
  (document as unknown as { adoptedStyleSheets: FakeSheet[] }).adoptedStyleSheets;

beforeEach(() => {
  vi.stubGlobal('CSSStyleSheet', FakeSheet);
  Object.defineProperty(document, 'adoptedStyleSheets', {
    configurable: true,
    writable: true,
    value: [],
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(document, 'adoptedStyleSheets');
});

describe('the alias', () => {
  it('is what the package name resolves to', () => {
    // The whole fix is this redirect. If vite.config.ts stops making it, the
    // library's own <style> element comes back and the policy refuses it.
    expect(aliased.styleSingleton).toBe(styleSingleton);
    expect(aliased.styleHookSingleton).toBe(styleHookSingleton);
    expect(aliased.stylesheetSingleton).toBe(stylesheetSingleton);
  });

  // That it offers the same exports as the package it replaces is asserted in
  // vite/styleSingletonAlias.test.ts, which can resolve that package by path.
});

describe('stylesheetSingleton', () => {
  it('adopts one sheet for the first add, and removes it with the last remove', () => {
    const sheet = stylesheetSingleton();

    sheet.add('body { overflow: hidden; }');
    sheet.add('ignored, because a sheet is already in place');
    expect(adopted()).toHaveLength(1);
    expect(adopted()[0]?.text).toBe('body { overflow: hidden; }');

    sheet.remove();
    expect(adopted()).toHaveLength(1);
    sheet.remove();
    expect(adopted()).toHaveLength(0);
  });

  it('leaves sheets it did not adopt where they are', () => {
    const someoneElses = new FakeSheet();
    adopted().push(someoneElses);
    const sheet = stylesheetSingleton();

    sheet.add('a {}');
    sheet.remove();

    expect(adopted()).toEqual([someoneElses]);
  });

  it('never writes a <style> element, which is the thing the CSP refuses', () => {
    const before = document.querySelectorAll('style').length;
    const sheet = stylesheetSingleton();

    sheet.add('body { overflow: hidden; }');

    // The positive half first: something WAS applied, so the absence below is
    // not the absence of having done anything at all.
    expect(adopted()).toHaveLength(1);
    expect(document.querySelectorAll('style')).toHaveLength(before);
    sheet.remove();
  });

  it('does nothing, rather than throwing, where constructable sheets do not exist', () => {
    // Safari before 16.4. Under this site's policy that is exactly what the
    // original package achieved too: its element was refused.
    Reflect.deleteProperty(document, 'adoptedStyleSheets');
    const sheet = stylesheetSingleton();

    expect(() => {
      sheet.add('a {}');
      sheet.remove();
    }).not.toThrow();
    expect(document.querySelectorAll('style')).toHaveLength(0);
  });
});

describe('styleSingleton', () => {
  it('is mounted by its first instance and unmounted by its last', () => {
    const Sheet = styleSingleton();
    const first = render(<Sheet styles="a { color: red; }" />);
    const second = render(<Sheet styles="b { color: blue; }" />);

    expect(adopted().map((s) => s.text)).toEqual(['a { color: red; }']);

    first.unmount();
    expect(adopted()).toHaveLength(1);
    second.unmount();
    expect(adopted()).toHaveLength(0);
  });

  it('keeps the styles it mounted with unless it was told they are dynamic', () => {
    // react-remove-scroll-bar measures the scrollbar once, on mount, and says
    // so: measuring again after the lock has removed the scrollbar would read
    // zero. The original package keeps the first styles for that reason.
    const Sheet = styleSingleton();
    const view = render(<Sheet styles="first" />);
    view.rerender(<Sheet styles="second" />);
    expect(adopted().map((s) => s.text)).toEqual(['first']);
    view.unmount();

    const dynamic = render(<Sheet styles="first" dynamic />);
    dynamic.rerender(<Sheet styles="second" dynamic />);
    expect(adopted().map((s) => s.text)).toEqual(['second']);
    dynamic.unmount();
    expect(adopted()).toHaveLength(0);
  });
});
