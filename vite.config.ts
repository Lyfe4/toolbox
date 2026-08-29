import { fileURLToPath } from 'node:url';

import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

import { cspHash } from './vite/plugins/csp-hash.ts';

// Absolute path to `src`, used for the `@/*` alias. Derived from this file's
// own URL so it works no matter where the process was started from.
const srcPath = fileURLToPath(new URL('./src', import.meta.url));

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
    // Must be last: it reads the finished index.html out of the build output.
    cspHash(),
  ],

  resolve: {
    // Mirror of the `paths` entry in tsconfig.app.json.
    alias: { '@': srcPath },
  },

  build: {
    // The security posture depends on shipping no inline scripts, so never let
    // Rollup inline an asset back into the HTML as a data: URL.
    assetsInlineLimit: 0,
    sourcemap: true,
  },

  test: {
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    // No implicit globals: every test imports `describe`/`it`/`expect`
    // explicitly, which keeps the types honest.
    globals: false,
    // Process CSS Modules in tests so `styles.foo` is a real class name.
    css: true,
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.{test,spec}.{ts,tsx}', 'src/routeTree.gen.ts', 'src/main.tsx'],
    },
  },
});
