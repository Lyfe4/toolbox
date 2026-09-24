import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * vite.config.ts redirects `react-style-singleton` to
 * src/lib/styleSingleton.ts, so that react-remove-scroll's page scroll lock is
 * a constructable stylesheet rather than a `<style>` element the CSP refuses.
 *
 * A redirect is only safe while the replacement answers everything its
 * consumers ask of the original, and those consumers are other people's
 * packages that can change on any upgrade. So this reads them: the real
 * package, and every file in the two packages that import it, found by the
 * same resolution chain the build uses. None of them is a dependency of this
 * project directly - they are three and four levels under Radix Select.
 */

// Through `createRequire` rather than `fileURLToPath`: under the jsdom test
// environment the `node:url` helpers reject the file URL outright.
const ROOT = dirname(createRequire(import.meta.url).resolve('../package.json'));

/** Resolves each name from inside the one before it, as Node and Vite do. */
function resolveChain(names: readonly string[]): string {
  let from = join(ROOT, 'package.json');
  for (const name of names) {
    from = createRequire(from).resolve(name);
  }
  return from;
}

const CONSUMERS = ['react-remove-scroll', 'react-remove-scroll-bar'] as const;

function packageDir(entry: string, name: string): string {
  let dir = dirname(entry);
  while (!dir.replaceAll('\\', '/').endsWith(`/node_modules/${name}`)) dir = dirname(dir);
  return dir;
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? filesUnder(join(dir, entry.name))
      : entry.name.endsWith('.js')
        ? [join(dir, entry.name)]
        : [],
  );
}

const exportNames = (module: unknown) =>
  Object.keys(module as object)
    .filter((name) => name !== 'default' && name !== '__esModule')
    .sort();

describe('the react-style-singleton alias', () => {
  it('offers exactly the exports of the package it replaces', async () => {
    const original: unknown = await import(
      /* @vite-ignore */ pathToFileURL(
        resolveChain([
          '@radix-ui/react-select',
          'react-remove-scroll',
          'react-remove-scroll-bar',
          'react-style-singleton',
        ]),
      ).href
    );
    const replacement: unknown = await import(
      /* @vite-ignore */ pathToFileURL(join(ROOT, 'src/lib/styleSingleton.ts')).href
    );

    // Three, not "whatever both happen to have": two empty modules agree.
    expect(exportNames(original)).toHaveLength(3);
    expect(exportNames(replacement)).toEqual(exportNames(original));
  });

  it('answers every name its consumers import from it', async () => {
    const replacement: unknown = await import(
      /* @vite-ignore */ pathToFileURL(join(ROOT, 'src/lib/styleSingleton.ts')).href
    );
    const offered = new Set(exportNames(replacement));

    const chains: Record<(typeof CONSUMERS)[number], string[]> = {
      'react-remove-scroll': ['@radix-ui/react-select', 'react-remove-scroll'],
      'react-remove-scroll-bar': [
        '@radix-ui/react-select',
        'react-remove-scroll',
        'react-remove-scroll-bar',
      ],
    };

    const asked = new Set<string>();
    for (const consumer of CONSUMERS) {
      const dir = packageDir(resolveChain(chains[consumer]), consumer);
      for (const file of filesUnder(join(dir, 'dist'))) {
        const source = readFileSync(file, 'utf8');
        for (const match of source.matchAll(
          /import\s*\{([^}]*)\}\s*from\s*['"]react-style-singleton['"]/g,
        )) {
          for (const name of (match[1] ?? '').split(',')) {
            const bare = name.trim().split(/\s+as\s+/)[0];
            if (bare) asked.add(bare);
          }
        }
      }
    }

    // The positive partner: the scan found the imports it exists to check.
    // react-remove-scroll-bar's scroll lock and react-remove-scroll's side
    // effect both import `styleSingleton` today.
    expect([...asked]).toContain('styleSingleton');
    for (const name of asked) expect(offered).toContain(name);
  });
});
