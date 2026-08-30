import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, posix, relative, sep } from 'node:path';

import type { Plugin } from 'vite';

/**
 * Emits `dist/sw.js` from `vite/service-worker.js`, with the precache list and
 * a build id substituted in.
 *
 * Generated rather than hand-maintained for the obvious reason: the file names
 * under `/assets/` contain content hashes that change every build, so a
 * hand-written list would be wrong the moment anything was edited.
 */
const BUILD_PLACEHOLDER = '__BUILD_ID__';
const PRECACHE_PLACEHOLDER = "'__PRECACHE__'";

/**
 * Files that must never be precached.
 *
 * `_headers` and `_redirects` are Netlify configuration, not assets. Source
 * maps are large and only ever wanted by a developer with devtools open, who
 * is by definition online. `sw.js` caching itself is a way to become
 * un-updatable.
 */
const EXCLUDED = new Set(['_headers', '_redirects', 'sw.js']);
const EXCLUDED_SUFFIXES = ['.map'];

/** Every file in the build output, as root-relative URL paths. */
function walk(dir: string, root: string): string[] {
  const out: string[] = [];

  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full, root));
      continue;
    }

    // POSIX separators: these become URLs, and this build also runs on Windows.
    const url = `/${relative(root, full).split(sep).join(posix.sep)}`;
    const name = url.slice(url.lastIndexOf('/') + 1);
    if (EXCLUDED.has(name)) continue;
    if (EXCLUDED_SUFFIXES.some((suffix) => url.endsWith(suffix))) continue;

    out.push(url);
  }

  return out;
}

export function serviceWorker(): Plugin {
  let outDir = 'dist';
  let root = process.cwd();

  return {
    name: 'patchbay:service-worker',
    apply: 'build',

    configResolved(config) {
      outDir = config.build.outDir;
      root = config.root;
    },

    /*
     * closeBundle, so the whole output exists to be listed - including the
     * files Vite copies out of `public/` and the ones other plugins emit.
     *
     * It must also run BEFORE csp-hash, which rewrites _headers: this plugin
     * only reads the asset list, but ordering the two explicitly means the
     * dependency is stated rather than incidental.
     */
    closeBundle() {
      const dist = join(root, outDir);
      const source = join(root, 'vite', 'service-worker.js');

      if (!existsSync(source)) {
        throw new Error(`service-worker: ${source} is missing`);
      }

      const files = walk(dist, dist).sort();

      /*
       * The build id is a hash of the file LIST, not of the file contents.
       *
       * Every name under /assets/ already contains a content hash, so the list
       * changes exactly when the build does - and hashing names rather than
       * bytes keeps this from having to read the whole output.
       */
      const build = createHash('sha256').update(files.join('\n')).digest('hex').slice(0, 12);

      const template = readFileSync(source, 'utf8');
      if (!template.includes(BUILD_PLACEHOLDER) || !template.includes(PRECACHE_PLACEHOLDER)) {
        throw new Error('service-worker: template is missing one of its placeholders');
      }

      const emitted = template
        .replace(BUILD_PLACEHOLDER, build)
        // JSON.stringify twice: once for the array, once to make that array a
        // JS string literal the worker parses at startup. Embedding the array
        // directly would work too, but this keeps the template valid JS on
        // disk - so it lints, formats and reads like the file it is.
        .replace(PRECACHE_PLACEHOLDER, JSON.stringify(JSON.stringify(files)));

      writeFileSync(join(dist, 'sw.js'), emitted, 'utf8');
      this.info(`service-worker: sw.js precaches ${files.length.toString()} files, build ${build}`);
    },
  };
}
