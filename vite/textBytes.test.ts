import { readFileSync } from 'node:fs';
import { extname, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { everyFile } from './repoFiles';

/**
 * EVERY TEXT FILE IS UTF-8, WITH LF ENDINGS AND NO OTHER CONTROL CHARACTER.
 *
 * Round twenty-six met this class three times, each caught only by where it
 * happened to land: a CRLF `index.html` that built into a page whose own
 * scripts the CSP refused, a backspace byte where a regex meant `\b`, and a
 * literal newline where a script meant `\n`. All three were one mechanism - a
 * tool that rewrote the text on its way to disk. Python's `write_text` on
 * Windows turns every `\n` into `\r\n`; a regex written into an ordinary
 * Python string turns `\b` into byte 0x08; PowerShell 5.1's `>` writes UTF-8
 * with a byte order mark, or UTF-16, depending on the cmdlet.
 *
 * `.gitattributes` (`eol=lf`) is not the answer to that, and never was: it
 * decides what a commit and a checkout hold, and all three of those did their
 * damage in the working tree, before anything was committed - the build, the
 * tests and the harness read what is on disk. So this reads what is on disk,
 * in `pnpm test`, which is in the six gates and in CI.
 *
 * What it refuses, in every file that is not one of the binary types below:
 *
 *   - a carriage return, alone or before a line feed;
 *   - any other C0 control character but tab and line feed, and DEL - a
 *     backspace, a NUL, an escape, a form feed;
 *   - a byte order mark;
 *   - bytes that are not UTF-8, which is also how UTF-16 arrives.
 *
 * A file that needs one of those characters - a CSV fixture with CRLF rows, a
 * lone surrogate - spells it as an escape (`'\r\n'`) and builds it at test
 * time, which is what every such fixture here already does. There is no
 * exemption table, and adding one should need an argument.
 *
 * What it cannot see: a newline typed into a template literal where `\n` was
 * meant is a newline, and legal. In a quoted string or a regex literal it is a
 * syntax error, which `pnpm lint` and `format:check` refuse in every
 * TypeScript and JavaScript file here.
 */

const ROOT = process.cwd();

/**
 * Types that are binary by construction, and so are not read as text. Fail
 * closed: an extension this list does not name is text and is held to every
 * rule above, so a new binary type has to be added here on purpose - and an
 * entry the tree no longer has any file of fails, so the list cannot outlive
 * its reason.
 */
const BINARY: Readonly<Record<string, string>> = {
  '.png': 'the icons and the social preview image in public/',
  '.ico': 'the favicon',
  '.woff2': 'the self-hosted font subsets in public/fonts/',
};

const NAMES: Readonly<Record<number, string>> = {
  0x00: 'NUL',
  0x08: 'a backspace (0x08)',
  0x0c: 'a form feed (0x0C)',
  0x0d: 'a carriage return (0x0D)',
  0x1b: 'an escape (0x1B)',
  0x7f: 'DEL (0x7F)',
};

/** What is wrong with a text file's bytes, each with its line and column. */
export function strayBytes(bytes: Uint8Array): readonly string[] {
  const found: string[] = [];
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    found.push('a UTF-8 byte order mark at the start');
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    found.push('bytes that are not UTF-8');
  }
  let line = 1;
  let column = 1;
  for (const byte of bytes) {
    if (byte === 0x0a) {
      line += 1;
      column = 1;
      continue;
    }
    if ((byte < 0x20 && byte !== 0x09) || byte === 0x7f) {
      const name = NAMES[byte] ?? `control character 0x${byte.toString(16).padStart(2, '0')}`;
      found.push(`${name} at ${String(line)}:${String(column)}`);
      // One report per file is enough to act on, and a CRLF file would
      // otherwise print a line per line.
      if (found.length >= 3) break;
    }
    column += 1;
  }
  return found;
}

const FILES = everyFile(ROOT);
const TEXT_FILES = FILES.filter((path) => !(extname(path) in BINARY));

describe('the bytes of every text file', () => {
  it('finds each kind of stray byte it is for, and nothing in clean text', () => {
    const bytes = (text: string) => new TextEncoder().encode(text);
    const flagged = (value: Uint8Array) => strayBytes(value).join('; ');

    // Every mechanism above, as the bytes it leaves.
    expect(flagged(bytes('one\r\ntwo\r\n'))).toMatch(/^a carriage return \(0x0D\) at 1:4/);
    expect(flagged(bytes('one\rtwo'))).toMatch(/^a carriage return \(0x0D\) at 1:4/);
    expect(flagged(bytes('const w = /\bword/;'))).toMatch(/^a backspace \(0x08\) at 1:12/);
    expect(flagged(bytes('﻿# title\n'))).toBe('a UTF-8 byte order mark at the start');
    expect(flagged(new Uint8Array([0x68, 0x00, 0x69, 0x00]))).toMatch(/^NUL at 1:2/);
    expect(flagged(new Uint8Array([0x63, 0x61, 0x66, 0xe9]))).toBe('bytes that are not UTF-8');
    expect(flagged(bytes('a\u001B[31mred'))).toMatch(/^an escape \(0x1B\) at 1:2/);

    // And the text a repository is actually made of passes.
    expect(strayBytes(bytes('tab\there\nline two, "quoted", é, ☃, 😀\n'))).toEqual([]);
    expect(strayBytes(bytes(''))).toEqual([]);
  });

  it('reads the files this repository is made of', () => {
    // The positive partner of the check below: a walk that found nothing, or
    // skipped the files that went wrong last time, would pass it perfectly.
    for (const path of ['index.html', 'public/_headers', 'README.md', 'vite/plugins/csp-hash.ts']) {
      expect(TEXT_FILES).toContain(path);
    }
    expect(TEXT_FILES.length).toBeGreaterThan(400);
  });

  it('has no carriage return, stray control character, BOM or non-UTF-8 byte in any of them', () => {
    const offenders = TEXT_FILES.flatMap((path) => {
      const found = strayBytes(readFileSync(resolve(ROOT, path)));
      return found.length === 0 ? [] : [`${path}: ${found.join('; ')}`];
    });
    expect(offenders, 'write these with a tool that does not translate the text').toEqual([]);
  });

  it('names only binary types the tree still has', () => {
    const present = new Set(FILES.map((path) => extname(path)));
    expect(Object.keys(BINARY).filter((extension) => !present.has(extension))).toEqual([]);
  });
});
