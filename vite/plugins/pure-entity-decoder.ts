import type { Plugin } from 'vite';

/**
 * Forces `decode-named-character-reference` to its lookup-table build.
 *
 * THE BUG THIS FIXES. That package - a transitive dependency of micromark, and
 * so of every Markdown parse - ships two implementations. One is a table of
 * named character references. The other decodes them by doing
 * `document.createElement('i')` and setting `innerHTML`, which is smaller in a
 * page and impossible in a Web Worker.
 *
 * Its exports map offers both, keyed by condition, with `worker` listed before
 * `browser`. Vite resolves for the browser, so the Markdown tools got the DOM
 * version and then died in the worker with "document is not defined" the first
 * time anything containing an entity was converted. jsdom supplies a
 * `document`, so all 1300 unit tests passed; only `pnpm check:browsers`,
 * driving a real worker in a real engine, caught it.
 *
 * WHY A PLUGIN rather than `resolve.conditions`. Adding `'worker'` to the
 * global condition list means restating Vite's defaults, and getting them
 * subtly wrong breaks everything: the first attempt wrote
 * `'development|production'` as a literal, which matches nothing, so React and
 * Zustand resolved to the wrong builds and the app failed to mount with
 * "e.stores is undefined". A resolver that rewrites exactly one module id
 * cannot have that blast radius.
 *
 * WHY NOT AN ALIAS to a file path: pnpm's store layout puts the real file
 * behind a content-hashed directory, so any literal path would be a hostage to
 * the lockfile.
 */
const PACKAGE = 'decode-named-character-reference';

export function pureEntityDecoder(): Plugin {
  return {
    name: 'patchbay:pure-entity-decoder',
    // Before Vite's own resolver, so this sees the bare specifier.
    enforce: 'pre',

    async resolveId(source, importer, options) {
      if (source !== PACKAGE) return null;

      // Let the normal resolution run, then redirect the result. skipSelf
      // stops this hook seeing its own request again.
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      if (!resolved) return null;

      return resolved.id.endsWith('index.dom.js')
        ? resolved.id.replace(/index\.dom\.js$/, 'index.js')
        : resolved.id;
    },
  };
}
