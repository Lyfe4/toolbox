import { describe, expect, it } from 'vitest';

import { TOOL_MANIFEST } from './manifest';
import skillDoc from '../../../.claude/skills/verify-patchbay/SKILL.md?raw';
import architectureDoc from '../../../docs/architecture.md?raw';
import matrixDoc from '../../../docs/conversion-matrix.md?raw';
import readmeDoc from '../../../README.md?raw';

import type { InputPort, OutputPort } from './types';

/**
 * THE TABLES THAT RESTATE THE MANIFEST, HELD TO IT.
 *
 * Three documents list every tool: the README's table of tools, the port-set
 * table in architecture.md and the verification skill's list of ids. Each is a
 * projection of `TOOL_MANIFEST` - it says nothing the manifest does not - and
 * each had to be edited by hand when the timestamp tool arrived, with nothing
 * to fail if it was not (round twenty-four's ledger).
 *
 * So each sits between markers and is rendered here from the manifest, the way
 * the loss-corpus block in the conversion matrix is rendered from what the
 * tools said. A tool added, renamed or re-ported fails this until the block is
 * replaced, and the failure prints the replacement.
 *
 * WHAT IS NOT GENERATED, ON PURPOSE: anything that judges. The README's
 * "held to" table, the matrix verdicts and the named lists in tests are
 * decisions somebody makes about a tool; a block written from the manifest can
 * only restate it, which is exactly why it is safe to generate and why a
 * verdict is not.
 */

/** Every tool directory's README, by path. */
const TOOL_READMES = import.meta.glob<string>('../../tools/*/README.md', {
  query: '?raw',
  import: 'default',
  eager: true,
});

const typesOf = (port: InputPort | OutputPort): string => port.types.join(', ');
const portCell = (ports: readonly (InputPort | OutputPort)[]): string =>
  ports.map((port) => `\`${port.id}\` ${port.label} · ${typesOf(port)}`).join(' — ');

const BLOCKS = [
  {
    name: 'tools',
    document: 'README.md',
    text: readmeDoc,
    render: () =>
      [
        '| Tool | Does |',
        '| --- | --- |',
        ...TOOL_MANIFEST.map((tool) => `| **${tool.name}** | ${tool.summary} |`),
      ].join('\n'),
  },
  {
    name: 'port-set',
    document: 'docs/architecture.md',
    text: architectureDoc,
    render: () =>
      [
        '| Tool | In | Out |',
        '| --- | --- | --- |',
        ...TOOL_MANIFEST.map(
          (tool) => `| \`${tool.id}\` | ${portCell(tool.inputs)} | ${portCell(tool.outputs)} |`,
        ),
      ].join('\n'),
  },
  {
    name: 'tool-ids',
    document: '.claude/skills/verify-patchbay/SKILL.md',
    text: skillDoc,
    render: () => TOOL_MANIFEST.map((tool) => `\`${tool.id}\``).join(', '),
  },
] as const;

/**
 * Both sides through the same sieve, as the corpus block is: Prettier pads a
 * table's cells to its column widths once it is in the file, so the bytes would
 * make this fail on formatting rather than on content.
 */
export function canonical(block: string): string {
  return block
    .replace(/\r\n/gu, '\n')
    .split('\n')
    .map((line) =>
      line.trim().startsWith('|')
        ? line
            .trim()
            .split('|')
            .map((cell) => cell.trim().replace(/^-+$/u, '-'))
            .join('|')
        : line.trim(),
    )
    .filter((line) => line !== '')
    .join('\n');
}

export function between(text: string, name: string): string | null {
  const begin = `<!-- manifest:${name}:begin -->`;
  const end = `<!-- manifest:${name}:end -->`;
  const start = text.indexOf(begin);
  const stop = text.indexOf(end);
  if (start === -1 || stop < start) return null;
  return text.slice(start + begin.length, stop);
}

describe('the tables that restate the manifest', () => {
  it.each(BLOCKS)('$document prints the manifest in its $name block', (block) => {
    const printed = between(block.text, block.name);
    expect(
      printed,
      `the manifest:${block.name} markers are missing from ${block.document}`,
    ).not.toBe(null);
    // The positive partner: an empty block would compare equal to nothing.
    expect(canonical(printed ?? '').length).toBeGreaterThan(0);
    expect(
      canonical(printed ?? ''),
      `${block.document} no longer restates the manifest. Replace the block between the manifest:${block.name} markers with the expected text below.`,
    ).toBe(canonical(block.render()));
  });

  /*
   * THE TWO THINGS A TOOL MUST HAVE THAT NO BLOCK CAN WRITE FOR IT, HELD TO
   * EXIST. The matrix section and the README are judgements - which evidence,
   * which verdict, what was decided and why - so neither is generated, and
   * round twenty-six's throwaway tool showed both could be left out with every
   * gate green. Their PRESENCE is not a judgement: a heading and a file.
   */
  it.each(TOOL_MANIFEST.map((tool) => [tool.id, tool.name] as const))(
    '%s has a section in the conversion matrix and a README beside its code',
    (id, name) => {
      expect(matrixDoc, `docs/conversion-matrix.md has no "## ${name}" section`).toMatch(
        new RegExp(`^## ${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'),
      );
      expect(Object.keys(TOOL_READMES)).toContain(`../../tools/${id}/README.md`);
    },
  );

  /*
   * Every tool that can lose something appears in the matrix's table of where
   * its losses travel. The rows are judgements - which port each note reaches,
   * and why - so they are written by hand; that a reporting tool has a row at
   * all is not, and the timestamp tool had none from round twenty-four to round
   * twenty-six with every gate green.
   */
  it('gives every tool with a report port a row in the table of where its losses travel', () => {
    // The whole header row: an earlier table ends its header with a `Note` column.
    const start = matrixDoc.search(/^\| Note +\| In +\| Because +\|/m);
    expect(start, 'the "| Note | In | Because |" table is missing from the matrix').toBeGreaterThan(
      -1,
    );
    const table = matrixDoc.slice(start, matrixDoc.indexOf('\n\n', start));
    const firstCells = table
      .split('\n')
      .map((row) => row.split('|')[1] ?? '')
      .join('\n');
    const reporting = TOOL_MANIFEST.filter((tool) =>
      tool.outputs.some((port) => 'presentation' in port && port.presentation === 'report'),
    ).map((tool) => tool.id);
    expect(reporting.length).toBeGreaterThan(0);
    const missing = reporting.filter(
      (id) =>
        !firstCells.includes(`\`${id}\``) &&
        // structured-data's rows name what each note is about, not the tool.
        !(id === 'structured-data' && firstCells.includes('CSV')),
    );
    expect(missing).toEqual([]);
  });

  // The instrument, against a block written to be wrong: a tool missing.
  it('tells a block that lost a tool from one that did not', () => {
    const tools = BLOCKS[0];
    const lost = tools.render().split('\n').slice(0, -1).join('\n');
    expect(canonical(lost)).not.toBe(canonical(tools.render()));
    expect(between('a <!-- manifest:x:begin -->b<!-- manifest:x:end --> c', 'x')).toBe('b');
    expect(between('no markers here', 'x')).toBe(null);
  });
});
