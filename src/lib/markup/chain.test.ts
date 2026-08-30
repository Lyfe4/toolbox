import { describe, expect, it } from 'vitest';

import { loadTool } from '@/features/registry/loader';
import type { ToolValue } from '@/features/registry/types';

/**
 * CHAINING.
 *
 * These tools are only worth having on a canvas if their output is something
 * the next tool can actually read. Text in, text out is necessary but not
 * sufficient - what matters is that the CONTENT is still meaningful.
 *
 * Each case here runs the real tools through the real registry, in the order a
 * user would wire them.
 */

const text = (value: string): ToolValue => ({ type: 'text', text: value });

async function run(
  id: string,
  input: string,
  options: Readonly<Record<string, unknown>>,
): Promise<Record<string, ToolValue>> {
  const tool = await loadTool(id as never);
  const result = await tool.run({
    inputs: { input: text(input) },
    options: { ...(tool.defaultOptions as Record<string, unknown>), ...options },
    context: { signal: new AbortController().signal, reportProgress: () => undefined },
  });

  if (!result.ok) throw new Error(`${id} failed: ${result.error.message}`);
  return result.value;
}

const asText = (value: ToolValue | undefined): string => (value?.type === 'text' ? value.text : '');

const MESSY = '<div><h2>Notes</h2><p>Some <b>bold</b> text.</p><ul><li>one</li></ul></div>';

describe('text-convert → text-convert', () => {
  it('turns messy HTML into Markdown and back into clean HTML', async () => {
    // The "Clean up pasted HTML" preset, run for real. Both nodes are the same
    // tool now - which is the point of the merge: one entry, two settings.
    const markdown = asText(
      (await run('text-convert', MESSY, { source: 'html', target: 'markdown' })).output,
    );

    expect(markdown).toContain('## Notes');
    expect(markdown).toContain('**bold**');
    expect(markdown).toContain('- one');

    const html = asText(
      (await run('text-convert', markdown, { source: 'markdown', target: 'html' })).output,
    );

    expect(html).toContain('<h2');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<li>one</li>');
    // The wrapper div is gone: this is the clean-up, not a copy.
    expect(html).not.toContain('<div');
  });
});

describe('text-convert → diff', () => {
  it('compares two rendered outputs', async () => {
    const render = async (source: string): Promise<string> =>
      asText((await run('text-convert', source, { source: 'markdown', target: 'html' })).output);

    const a = await render('# Title\n\nOne\n');
    const b = await render('# Title\n\nTwo\n');

    const diff = await loadTool('diff');
    const result = await diff.run({
      inputs: { original: text(a), changed: text(b) },
      options: diff.defaultOptions,
      context: { signal: new AbortController().signal, reportProgress: () => undefined },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const patch = asText((result.value as Record<string, ToolValue>).output);
    expect(patch).toContain('One');
    expect(patch).toContain('Two');
    // Only the paragraph changed, so the heading must not appear as a change.
    expect(patch).not.toMatch(/^[+-].*Title/m);
  });
});

describe('text-convert → hash', () => {
  it('fingerprints rendered content, and the fingerprint tracks the content', async () => {
    const render = async (source: string): Promise<string> =>
      asText((await run('text-convert', source, { source: 'markdown', target: 'html' })).rendered);

    const hash = await loadTool('hash');
    const digest = async (value: string): Promise<string> => {
      const result = await hash.run({
        inputs: { input: text(value) },
        options: { ...(hash.defaultOptions as Record<string, unknown>), algorithm: 'sha-256' },
        context: { signal: new AbortController().signal, reportProgress: () => undefined },
      });
      if (!result.ok) throw new Error('hash failed');
      return asText((result.value as Record<string, ToolValue>).digest);
    };

    const one = await digest(await render('# Title\n\nBody\n'));
    const same = await digest(await render('# Title\n\nBody\n'));
    const other = await digest(await render('# Title\n\nDifferent\n'));

    expect(one).toHaveLength(64);
    expect(same).toBe(one);
    expect(other).not.toBe(one);
  });

  it('gives the same fingerprint for Markdown that differs only in spelling', async () => {
    // *em* and _em_ are the same document. Hashing the RENDERED output rather
    // than the source is what makes that true, and is the reason to chain
    // through this tool rather than hashing the Markdown directly.
    const render = async (source: string): Promise<string> =>
      asText((await run('text-convert', source, { source: 'markdown', target: 'html' })).rendered);

    expect(await render('*em* and **strong**\n')).toBe(await render('_em_ and __strong__\n'));
  });
});
