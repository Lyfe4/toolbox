import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * EVERY FILE A CLONE HAS, read from the working tree.
 *
 * Shared by the gates that read the repository as files - `docClaims.test.ts`
 * and `textBytes.test.ts` - so that what one of them skips the other skips
 * too. The skipped directories are what .gitignore keeps out of a clone, so
 * the list is the same on a machine that has built and on CI, which has not:
 * a test must not read gitignored state (CONTRIBUTING.md, "When they pass here
 * and fail in CI, CI is right").
 *
 * The working tree and not the index, on purpose. `.gitattributes` decides
 * what a commit and a checkout hold; the build, the tests and the harness read
 * whatever is on disk, and that is where round twenty-six's line endings did
 * their damage, before anything was committed.
 */
export const SKIP_DIRECTORIES: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  'dist',
  '.netlify',
  '.tanstack',
  'coverage',
  '.mutation',
  'evidence',
]);

export function everyFile(root: string): readonly string[] {
  const found: string[] = [];
  const walk = (directory: string, relative: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue;
      const path = relative === '' ? entry.name : `${relative}/${entry.name}`;
      // `.claude/` is per machine except its skills - the same line .gitignore draws.
      if (relative === '.claude' && entry.name !== 'skills') continue;
      if (entry.isDirectory()) walk(resolve(directory, entry.name), path);
      else found.push(path);
    }
  };
  walk(root, '');
  return found.sort();
}
