import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * EVERY RELATIVE LINK IN EVERY MARKDOWN FILE RESOLVES.
 *
 * This exists because two links were reported broken, sat there, and were
 * reported again: `docs/architecture.md` pointed at `../README.md#the-canvas`,
 * an anchor the README has never had, and `src/tools/text-convert/README.md`
 * pointed at `hardening.test.ts` as though it were a sibling when it lives in
 * `src/lib/markup/`. A third was a placeholder `#`, linking to nowhere.
 *
 * None of these is the kind of thing a reader reports twice - they follow the
 * link, land on a page top or a 404, and give up. The prose here is a
 * deliverable (the architecture document is longer than most of the code it
 * describes), and a deliverable with no gate rots at exactly the rate nobody
 * is checking it.
 *
 * WHY IT LIVES IN `vite/` RATHER THAN NEXT TO THE DOCS. This walks the
 * filesystem, and `tsconfig.app.json` deliberately gives the browser project
 * no Node types "so nothing here can reach for `process` or `fs` and quietly
 * assume a server exists". That rule is worth more than the convenience of
 * colocation, and this is the project that is allowed to be a Node script.
 *
 * WHAT IS CHECKED, AND WHAT IS NOT. A relative target must exist, and a
 * fragment pointing into a Markdown file must match a heading in it. External
 * URLs are not fetched: a test that needs the network is a test that fails on
 * a train, and this repository's whole argument is that it needs no network.
 */

/** GitHub's heading slug: lower-cased, punctuation dropped, spaces hyphenated. */
function slugify(heading: string): string {
  return heading
    .replace(/`/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 _-]/g, '')
    .trim()
    .replace(/ +/g, '-');
}

function headingSlugs(file: string): ReadonlySet<string> {
  const slugs = new Set<string>();
  for (const match of readFileSync(file, 'utf8').matchAll(/^#{1,6} +(.+)$/gm)) {
    slugs.add(slugify(match[1] ?? ''));
  }
  return slugs;
}

function markdownFiles(root: string): readonly string[] {
  const skip = new Set(['node_modules', '.git', 'dist', '.netlify', '.tanstack']);
  const found: string[] = [];

  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      const full = resolve(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.md')) found.push(full);
    }
  };

  walk(root);
  return found;
}

/**
 * Links, minus the ones inside code.
 *
 * `[text](url)` appears in text-convert's README as an example of link syntax,
 * inside backticks. Stripping fences and code spans first is what stops a
 * document about Markdown from failing a test about Markdown.
 */
function linksIn(source: string): readonly string[] {
  const prose = source.replace(/^```[\s\S]*?^```/gm, '').replace(/`[^`\n]*`/g, '');
  return [...prose.matchAll(/\]\(([^)\s]+)\)/g)].map((match) => match[1] ?? '');
}

/** Broken links in one file, each with the reason it is broken. */
function brokenLinks(file: string): readonly string[] {
  const broken: string[] = [];

  for (const href of linksIn(readFileSync(file, 'utf8'))) {
    if (/^(?:https?:|mailto:)/.test(href)) continue;

    const hash = href.indexOf('#');
    const path = hash === -1 ? href : href.slice(0, hash);
    const fragment = hash === -1 ? null : href.slice(hash + 1);

    /*
     * A bare `#` is a link to nowhere: it renders, it invites a click, and it
     * does nothing. The one this test was written for was a placeholder for a
     * section somebody meant to write and did not.
     */
    if (fragment === '') {
      broken.push(`${href} (empty fragment)`);
      continue;
    }

    const target = path === '' ? file : resolve(dirname(file), path);
    if (!existsSync(target)) {
      broken.push(`${href} (no such file)`);
      continue;
    }

    if (fragment === null || !target.endsWith('.md')) continue;
    if (!headingSlugs(target).has(fragment)) broken.push(`${href} (no such heading)`);
  }

  return broken;
}

/*
 * The repository root.
 *
 * Neither `__dirname` nor `import.meta.url` can be used here, and both look as
 * though they can: the package is an ES module, so the first is undefined at
 * run time, and the suite runs under jsdom, where the second is the http URL
 * the module was served from and `fileURLToPath` refuses it outright. Vitest
 * resolves its root to the directory holding the config, which is this
 * repository - and the first assertion below fails loudly if that ever stops
 * being true, rather than walking an empty tree and reporting success.
 */
const ROOT = process.cwd();

describe('markdown links', () => {
  const files = markdownFiles(ROOT);
  const cases: readonly (readonly [string, string])[] = files.map((file) => [
    file
      .slice(ROOT.length + 1)
      .split(sep)
      .join('/'),
    file,
  ]);

  it('finds the documentation at all, so a green run means something', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it.each(cases)('%s links only to things that exist', (_name, file) => {
    expect(brokenLinks(file)).toEqual([]);
  });
});
