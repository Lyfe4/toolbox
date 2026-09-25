import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { serviceWorker } from './service-worker';

import type { ResolvedConfig } from 'vite';

// The repository root, as docClaims.test.ts takes it: under jsdom the
// `node:url` helpers refuse this module's URL.
const ROOT = process.cwd();

/** Runs the plugin's two hooks the way a build does, against `outDir`. */
function emit(outDir: string): string[] {
  const plugin = serviceWorker();
  const messages: string[] = [];
  const configResolved = plugin.configResolved as (config: ResolvedConfig) => void;
  const closeBundle = plugin.closeBundle as (this: { info: (m: string) => void }) => void;
  configResolved({ root: ROOT, build: { outDir } } as ResolvedConfig);
  closeBundle.call({ info: (message) => messages.push(message) });
  return messages;
}

describe('serviceWorker', () => {
  const made: string[] = [];
  afterEach(() => {
    for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  /*
   * The directory was `join(root, outDir)`, which for an absolute outDir on
   * Windows is the root with a drive letter glued on - `C:\project\C:\tmp\out`
   * - so `vite build --outDir <absolute>` wrote every asset and then threw in
   * this hook, leaving a build with no sw.js. Found building an old commit
   * into a temporary directory to compare its file names with today's.
   */
  it('writes sw.js into an absolute outDir, listing what is there', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'pb-sw-'));
    made.push(outDir);
    mkdirSync(join(outDir, 'assets'));
    writeFileSync(join(outDir, 'assets', 'app-0123456789.js'), '');
    writeFileSync(join(outDir, 'assets', 'app-0123456789.js.map'), '');

    emit(outDir);

    const sw = readFileSync(join(outDir, 'sw.js'), 'utf8');
    expect(sw).toContain('\\"/assets/app-0123456789.js\\"');
    expect(sw).not.toContain('app-0123456789.js.map');
  });
});
