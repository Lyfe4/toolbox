import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

import { cspHash } from './vite/plugins/csp-hash.ts';
import { indexHtml } from './vite/plugins/index-html.ts';
import { serviceWorker } from './vite/plugins/service-worker.ts';

// Absolute path to `src`, used for the `@/*` alias. Derived from this file's
// own URL so it works no matter where the process was started from.
const srcPath = fileURLToPath(new URL('./src', import.meta.url));

/*
 * TEN HASH CHARACTERS, NOT THE DEFAULT EIGHT - and not for collisions.
 *
 * A file's hash is taken before the `//# sourceMappingURL=` comment is
 * appended, so moving `sourcemap` from `true` to `'hidden'` changed the bytes
 * of 51 files and the names of none. Those URLs are served `immutable` and the
 * service worker is cache-first, so every returning visitor kept the commented
 * bytes - and its next precache filled from the same HTTP cache - under names
 * that would never change again: DevTools on the live site went on fetching
 * maps, and `connect-src 'none'` went on refusing them. Changing the length
 * gave every URL a new name once, which is the only thing that reaches a cache
 * nobody can purge. It is harmless to change again; what must not happen is a
 * URL keeping its name while its bytes change, and `checkLiveAssets` in
 * check:browsers compares this build against the live site for exactly that.
 */
const ASSET_NAMES = {
  entryFileNames: 'assets/[name]-[hash:10].js',
  chunkFileNames: 'assets/[name]-[hash:10].js',
  assetFileNames: 'assets/[name]-[hash:10][extname]',
};

export default defineConfig({
  plugins: [
    // Scans src/routes and regenerates src/routeTree.gen.ts.
    // Must run before the React plugin so the generated tree gets transformed.
    tanstackRouter({
      target: 'react',
      routesDirectory: './src/routes',
      generatedRouteTree: './src/routeTree.gen.ts',
      // Colocated tests live next to their routes; without this the plugin
      // would try to turn `index.test.tsx` into a route. `[.]` is a literal
      // dot, written as a character class to keep the string escape-free.
      routeFileIgnorePattern: '[.](test|spec)[.]tsx?$',
      quoteStyle: 'single',
      // Every route component becomes its own chunk, so /styleguide and the
      // tool pages are not carried by the initial load.
      autoCodeSplitting: true,
    }),
    react(),
    // Strips comments from the shipped HTML and refuses to build if a site
    // URL failed to substitute. transformIndexHtml, so it runs before the
    // file is written and therefore before cspHash reads it back.
    indexHtml(),
    // Emits dist/sw.js with the real asset list. Before cspHash so the
    // ordering of the two closeBundle hooks is stated rather than incidental.
    serviceWorker(),
    // Must be last: it reads the finished index.html out of the build output.
    cspHash(),
  ],

  resolve: {
    /*
     * An array rather than an object so an entry can be a regular expression:
     * an object key matches its package AND every deep import under it, which
     * is right for `@` and wrong for `react-style-singleton` below.
     */
    alias: [
      // Mirror of the `paths` entry in tsconfig.app.json.
      { find: '@', replacement: srcPath },

      /*
       * FORCES `decode-named-character-reference` TO ITS LOOKUP-TABLE BUILD.
       *
       * That package - a transitive dependency of micromark, and so of every
       * Markdown parse - ships two implementations. One is a table of named
       * character references. The other decodes them by doing
       * `document.createElement('i')` and setting `innerHTML`, which is
       * smaller in a page and impossible in a Web Worker.
       *
       * Its exports map keys the two by condition. Resolving for the browser
       * picks the DOM one, and the Markdown tools then died in the worker
       * with "document is not defined" the first time anything containing an
       * entity was converted. jsdom supplies a `document`, so every unit test
       * passed; only `pnpm check:browsers`, driving a real worker in a real
       * engine, caught it.
       *
       * WHY AN ALIAS rather than `resolve.conditions`. Adding 'worker' to the
       * global condition list means restating Vite's defaults, and getting
       * them subtly wrong breaks everything: an early attempt wrote
       * 'development|production' as a literal, which matches nothing, so
       * React and Zustand resolved to the wrong builds and the app failed to
       * mount. Redirecting one module id cannot have that blast radius.
       *
       * WHY RESOLVED HERE rather than written down: pnpm puts the real file
       * behind a content-hashed directory, so a literal path would be a
       * hostage to the lockfile. Node's resolver knows nothing of 'worker' or
       * 'browser', so it falls through the exports map to 'default', which is
       * the table build.
       *
       * WHY AN ALIAS RATHER THAN A PLUGIN. This was a `resolveId` hook, and
       * the dependency optimiser does not run those - it pre-bundles with its
       * own resolution and picked the DOM build regardless. So the tool
       * passed every test and every build and failed only in `pnpm dev`,
       * which is the worst place for a bug to live: nobody running the gates
       * sees it and everybody developing the tool does. An alias is one
       * mechanism that reaches the optimiser, the app and the worker alike.
       */
      {
        find: 'decode-named-character-reference',
        replacement: createRequire(import.meta.url).resolve('decode-named-character-reference'),
      },

      /*
       * `react-style-singleton` IS REPLACED, not configured, because it cannot
       * be configured.
       *
       * react-remove-scroll - which Radix Select wraps around every open list -
       * uses it to insert the page's scroll lock as a `<style>` element, and
       * `style-src` refuses every `<style>` it has no hash for. The lock's text
       * carries the scrollbar's measured width, so no hash can be computed
       * ahead of time. src/lib/styleSingleton.ts is the same three exports on
       * a constructable stylesheet, which is the CSSOM and not governed by
       * `style-src`; its header has the rest.
       *
       * Exact match only. `check:browsers` asserts both halves of what this
       * buys - the policy refuses nothing while a list is open, AND the page
       * really is scroll locked - so a Radix upgrade that stops importing this
       * package, or starts inserting its lock some other way, fails there
       * rather than going quiet.
       */
      {
        find: /^react-style-singleton$/,
        replacement: fileURLToPath(new URL('./src/lib/styleSingleton.ts', import.meta.url)),
      },
    ],
  },

  /*
   * The worker is built as an ES MODULE, not the default IIFE.
   *
   * `engine.ts` already constructs it with `{ type: 'module' }`, but Vite's
   * build defaults to `format: 'iife'` for workers - and an IIFE cannot be
   * code-split, so Rollup sets `inlineDynamicImports` and every tool the
   * worker can reach is concatenated into one file.
   *
   * Measured: that put every tool's code, including the Markdown libraries,
   * into a single 621 kB worker chunk which is fetched when the canvas mounts.
   * As ES modules the worker loads each tool as its own chunk, on first use -
   * the same bargain the registry makes on the main thread.
   *
   * Module workers need Chrome 80, Safari 15 and Firefox 114, all of which are
   * inside the support window this project already states. `pnpm
   * check:browsers` runs a real tool in a real worker in Firefox and WebKit.
   */
  worker: {
    format: 'es',
    // The worker's tool chunks were re-keyed with the page's - see ASSET_NAMES.
    rolldownOptions: { output: ASSET_NAMES },
  },

  build: {
    // The policy admits the two inline scripts it holds hashes for and nothing
    // else inline, so never let Rollup inline an asset back into the HTML as a
    // data: URL.
    assetsInlineLimit: 0,
    /*
     * MAPS ARE BUILT AND NOT POINTED AT. `true` since the scaffold, which
     * writes `//# sourceMappingURL=` into every chunk - and with devtools open
     * the browser fetches each one, `connect-src 'none'` refuses it, and the
     * console fills with twenty violations that are the policy working. Twenty
     * refusals nobody reads is where a real one hides, and the maps could never
     * load there anyway.
     *
     * `hidden` keeps the files and drops the comment. They are still deployed,
     * because a stack trace from the live site is worth resolving and the map
     * for its chunk is one navigation away - a navigation is not a connection.
     * The repository is public, so they publish nothing that is not already.
     * `checkDeployment` holds the missing comment, beside a count of the maps
     * that still exist.
     */
    sourcemap: 'hidden',
    rolldownOptions: { output: ASSET_NAMES },
  },

  test: {
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    // No implicit globals: every test imports `describe`/`it`/`expect`
    // explicitly, which keeps the types honest.
    globals: false,
    // Process CSS Modules in tests so `styles.foo` is a real class name.
    css: true,
    /*
     * Above vitest's 5s default.
     *
     * A handful of tests do real work rather than waiting on a promise: a
     * 2,200-line Myers diff, an axe scan of a populated canvas, the first
     * route render that lazily imports its chunk. Each finishes in well under
     * a second on an idle machine and can pass 5s on a saturated one, which
     * showed up as tests failing roughly one full run in eight - always a
     * timeout, never an assertion.
     *
     * Raising it does not hide a hang: something genuinely stuck still fails,
     * at the timeout below.
     */
    // Above `asyncUtilTimeout` in vitest.setup.ts, or a slow wait is killed
    // before it can report which assertion was still failing.
    testTimeout: 60_000,
    /*
     * `vite/` as well as `src/`: the build plugins are real code with real
     * consequences - the comment stripper runs over the two inline scripts
     * whose bytes are hashed into the CSP - and a plugin that is never tested
     * is a plugin whose failure only shows up in a deployed browser.
     */
    include: ['src/**/*.{test,spec}.{ts,tsx}', 'vite/**/*.{test,spec}.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.{test,spec}.{ts,tsx}', 'src/routeTree.gen.ts', 'src/main.tsx'],
    },
  },
});
