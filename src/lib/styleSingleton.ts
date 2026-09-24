/**
 * `react-style-singleton`, rebuilt on a constructable stylesheet.
 *
 * vite.config.ts aliases the package name to this file. Its one consumer here
 * is react-remove-scroll, which Radix Select wraps around every open list, and
 * which uses it to insert the stylesheet that locks the page's scroll: body
 * `overflow: hidden`, `overscroll-behavior: contain`, and a margin the width of
 * the scrollbar it just removed so nothing shifts sideways.
 *
 * WHY THIS EXISTS. The original inserts that stylesheet as a `<style>`
 * element, and `style-src` in public/_headers refuses every `<style>` it does
 * not have a hash for. This one's text cannot be hashed ahead of time: it
 * carries the scrollbar's measured width and the body's measured margins,
 * which differ by platform, zoom level and page. So every open select logged
 * a refusal, the lock's CSS never applied, and the verification skill filed
 * the refusal as noise.
 *
 * A constructable stylesheet is the CSSOM, not markup, and `style-src`
 * governs only styles that arrive as markup - the same line React's `style`
 * prop already sits on the right side of (see the note on it in
 * public/_headers). Nothing about the policy is loosened: an injected `<style>`
 * element or `style=""` attribute is refused exactly as before, and the only
 * way to reach `replaceSync` is to be running script, which `script-src`
 * already decides.
 *
 * WHERE THERE IS NO `adoptedStyleSheets` - Safari before 16.4, and jsdom - it
 * does nothing, which is precisely what the original did under this policy:
 * the lock's JavaScript half (react-remove-scroll cancels wheel and touch
 * moves outside the list) still runs, and only the CSS half is missing.
 *
 * The public surface is the package's own three exports, with its semantics:
 * the first instance to mount inserts the sheet, the last to unmount removes
 * it, and a changed `styles` is ignored unless `dynamic` is set.
 */
import { useEffect, useState } from 'react';

export interface StyleSheetSingleton {
  add(style: string): void;
  remove(): void;
}

function adoptable(): boolean {
  return (
    typeof document !== 'undefined' &&
    'adoptedStyleSheets' in document &&
    typeof CSSStyleSheet === 'function' &&
    typeof CSSStyleSheet.prototype.replaceSync === 'function'
  );
}

export function stylesheetSingleton(): StyleSheetSingleton {
  let counter = 0;
  let sheet: CSSStyleSheet | null = null;

  return {
    add(style) {
      if (counter === 0 && adoptable()) {
        sheet = new CSSStyleSheet();
        sheet.replaceSync(style);
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      }
      counter += 1;
    },
    remove() {
      counter -= 1;
      if (counter === 0 && sheet !== null) {
        const leaving = sheet;
        document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== leaving);
        sheet = null;
      }
    },
  };
}

export function styleHookSingleton() {
  const sheet = stylesheetSingleton();

  return function useStyle(styles: string, isDynamic?: boolean) {
    // The styles a component mounted with, which is what a non-dynamic
    // singleton keeps for its whole life - the original's
    // `[styles && isDynamic]` dependency, said in a way the hook rules can
    // check.
    const [initial] = useState(styles);
    const current = isDynamic === true ? styles : initial;

    useEffect(() => {
      sheet.add(current);
      return () => {
        sheet.remove();
      };
    }, [current]);
  };
}

export function styleSingleton() {
  const useStyle = styleHookSingleton();

  function Sheet({ styles, dynamic }: { readonly styles: string; readonly dynamic?: boolean }) {
    useStyle(styles, dynamic);
    return null;
  }

  return Sheet;
}
