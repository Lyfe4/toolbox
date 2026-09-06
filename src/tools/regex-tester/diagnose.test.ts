import { describe, expect, it } from 'vitest';

import { diagnose, tokeniseReplacement, type Note } from './diagnose';
import { capturingGroupNames, parsePattern } from './pattern';
import { compilePattern, runRegex } from './run';

function notesFor(
  pattern: string,
  flags: string,
  subject: string,
  mode: 'match' | 'replace' = 'match',
  replacement = '',
): readonly Note[] {
  const compiled = compilePattern(pattern, flags);
  if (!compiled.ok) throw new Error(compiled.error.message);

  const parsed = parsePattern(pattern, flags.includes('v'));
  const report = runRegex(
    compiled.value,
    subject,
    mode === 'replace' ? replacement : null,
    undefined,
    parsed.ok ? capturingGroupNames(parsed.value) : [],
  );

  return diagnose({ pattern, flags, subject, report, mode, replacement, elapsedMs: 0 }).notes;
}

const titles = (notes: readonly Note[]): string[] => notes.map((note) => note.title);

function expectNote(notes: readonly Note[], fragment: string): Note {
  const found = notes.find((note) => note.title.includes(fragment));
  expect(
    found,
    `no note mentioning "${fragment}" in ${JSON.stringify(titles(notes))}`,
  ).toBeDefined();
  // Non-null via the assertion above; returning it lets the caller check body.
  return found ?? { level: 'info', title: '', body: '' };
}

/* ========================================================================== *
 * Why it did not match
 * ========================================================================== */

describe('diagnosing a pattern that found nothing', () => {
  it('spots a pattern pasted with its slashes still on', () => {
    // `/\d+/g` in the box matches a literal slash, a digit run and another
    // slash. It finds nothing and looks like the pattern is wrong.
    const note = expectNote(notesFor('/\\d+/g', 'g', 'abc 123'), 'slashes');
    expect(note.body).toContain('\\d+');
  });

  it('says so when the only problem is case', () => {
    expectNote(notesFor('HELLO', 'g', 'hello world'), 'ignore case');
  });

  it('says so when `^` needs the multiline flag', () => {
    expectNote(notesFor('^world', 'g', 'hello\nworld'), 'multiline');
  });

  it('says so when `.` needs to cross a line break', () => {
    expectNote(notesFor('hello.world', 'g', 'hello\nworld'), 'line break');
  });

  /*
   * CRLF.
   *
   * Text pasted from a Windows file ends its lines `\r\n`. A pattern written
   * against `\n` meets a `\r` it never allowed for - `.` and `[^\n]` both
   * stop at one - so a pattern that works in the user's editor finds nothing
   * here, and the character responsible does not draw anything on screen.
   */
  it('spots CRLF line endings the pattern did not allow for', () => {
    const note = expectNote(notesFor('(\\w+)\\n', 'g', 'hello\r\nworld\r\n'), 'CRLF');
    expect(note.body).toContain('\\r?');
  });

  it('stays quiet about CRLF when the pattern already copes', () => {
    // `$` under `m` matches before a `\r` perfectly well. A note here would
    // be advice to fix something that is not broken.
    expect(titles(notesFor('^(\\w+)$', 'gm', 'hello\r\nworld\r\n')).join(' ')).not.toContain(
      'CRLF',
    );
  });

  it('narrows down which part of the pattern stops matching', () => {
    // This is the diagnosis that turns "no matches" into something to act on:
    // not "your pattern is wrong" but "everything up to here is fine".
    const note = expectNote(
      notesFor('\\d{4}-\\d{2}-\\d{2}', 'g', '2024-06 was the month'),
      'far as',
    );
    expect(note.title).toContain('\\d{4}-');
  });

  it('says when even the first part fails', () => {
    expectNote(notesFor('\\d+-\\w+', 'g', 'no digits here'), 'first part');
  });

  it('declines to narrow a pattern with top-level alternation', () => {
    // `abc` is not a prefix of `abc|def`, so reporting it as one would be
    // reporting a fact that is not true.
    expect(titles(notesFor('abc|def', 'g', 'xyz')).join(' ')).not.toContain('far as');
  });

  it('points out an empty subject rather than blaming the pattern', () => {
    expectNote(notesFor('\\d+', 'g', ''), 'nothing to search');
  });

  it('explains sticky before anything else', () => {
    expectNote(notesFor('world', 'y', 'hello world'), 'Sticky');
  });

  it('does not run the pattern again when the first run was already slow', () => {
    const compiled = compilePattern('a', 'g');
    if (!compiled.ok) throw new Error('unreachable');
    const report = runRegex(compiled.value, 'zzz', null);

    const { notes } = diagnose({
      pattern: 'a',
      flags: 'g',
      subject: 'zzz',
      report,
      mode: 'match',
      replacement: '',
      elapsedMs: 500,
    });

    expectNote(notes, 'No diagnosis was attempted');
  });
});

/* ========================================================================== *
 * Why the matches look odd
 * ========================================================================== */

describe('diagnosing a pattern that did match', () => {
  it('warns when every match is empty and the pattern could have consumed', () => {
    const note = expectNote(notesFor('x*', 'g', 'abc'), 'Every match is empty');
    expect(note.level).toBe('warn');
    expect(note.body).toContain('`+` rather than `*`');
  });

  it('does not scold a pattern made only of anchors', () => {
    // `/^/gm` matching nothing at every line start is the whole point of it.
    // "That is usually a quantifier that should be `+`" is advice about a
    // pattern the user did not write.
    const note = expectNote(notesFor('^', 'gm', 'a\nb'), 'Every match is empty');
    expect(note.level).toBe('info');
    expect(note.body).toContain('a position rather than any text');
  });

  it('counts the empty matches when only some are', () => {
    expectNote(notesFor('a*', 'g', 'aab'), 'empty');
  });

  it('says that global is off when only one match is shown', () => {
    expectNote(notesFor('a', '', 'aaa'), 'Only the first match');
  });

  it('explains what sticky and global do together', () => {
    expectNote(notesFor('a', 'gy', 'aab'), 'first gap');
  });

  it('names a group that never captured', () => {
    // An alternative that is never taken looks exactly like a group that is
    // broken, and the difference is invisible in a listing of nulls.
    expectNote(notesFor('(a)|(b)', 'g', 'aaa'), 'never captured');
  });

  it('says offsets are UTF-16 when the text contains astral characters', () => {
    const note = expectNote(notesFor('a', 'g', '\u{1F600}a'), 'UTF-16');
    expect(note.body).toContain('counts as 2');
  });

  it('stays quiet about UTF-16 for ordinary text', () => {
    expect(titles(notesFor('a', 'g', 'plain ascii')).join(' ')).not.toContain('UTF-16');
  });

  it('says nothing at all about a pattern that simply worked', () => {
    expect(notesFor('\\d+', 'g', 'a1 b22')).toEqual([]);
  });
});

/* ========================================================================== *
 * Replacement strings
 * ========================================================================== */

describe('reading a replacement string', () => {
  it('splits the tokens the engine will see', () => {
    const tokens = tokeniseReplacement('[$1]$&$$x', 1, false);
    expect(tokens.map((token) => token.kind)).toEqual([
      'literal',
      'group',
      'literal',
      'match',
      'dollar',
      'literal',
    ]);
  });

  it('prefers a two-digit group reference where one exists', () => {
    expect(tokeniseReplacement('$11', 11, false)[0]).toMatchObject({
      kind: 'group',
      reference: '11',
    });
    expect(tokeniseReplacement('$11', 1, false)[0]).toMatchObject({
      kind: 'group',
      reference: '1',
    });
  });

  it('reads `$<name>` as a reference only when the pattern has named groups', () => {
    // The rule is genuinely surprising: with no named groups anywhere,
    // `$<name>` is literal text; with any named group at all, an unknown name
    // is replaced by nothing.
    expect(tokeniseReplacement('$<x>', 0, false)[0]?.kind).toBe('literal');
    expect(tokeniseReplacement('$<x>', 1, true)[0]?.kind).toBe('named');
  });

  it('warns about a group reference the pattern cannot satisfy', () => {
    const note = expectNote(
      notesFor('(\\w+)@(\\w+)', 'g', 'ada@example', 'replace', '$3'),
      'not a group reference',
    );
    expect(note.body).toContain('2 capture groups');
  });

  it('warns about `$0`', () => {
    expectNote(notesFor('a', 'g', 'a', 'replace', '$0'), '`$0` is not the whole match');
  });

  it('warns about a sed-style backreference', () => {
    expectNote(notesFor('(a)', 'g', 'a', 'replace', '\\1'), '`$1`, not `\\1`');
  });

  it('warns about a named reference that does not exist', () => {
    const note = expectNote(
      notesFor('(?<user>\\w+)', 'g', 'ada', 'replace', '$<name>'),
      'names a group that does not exist',
    );
    expect(note.body).toContain('replaced by nothing');
  });

  it("mentions the cost of `$`` ` and `$'`", () => {
    expectNote(notesFor('a', 'g', 'abc', 'replace', "$'"), '$');
  });

  it('says nothing about a replacement that is fine', () => {
    expect(notesFor('(\\w+)@(\\w+)', 'g', 'ada@example', 'replace', '$2/$1')).toEqual([]);
  });
});
