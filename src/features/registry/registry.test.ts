import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { canToolsConnect, findConnections } from './connections';
import { loadableToolIds, loadTool } from './loader';
import { getManifestEntry, isToolId, searchTools, TOOL_MANIFEST } from './manifest';

const ids = TOOL_MANIFEST.map((entry) => entry.id);

describe('manifest integrity', () => {
  it('has at least one tool', () => {
    expect(TOOL_MANIFEST.length).toBeGreaterThan(0);
  });

  it('has unique ids', () => {
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each(ids)('%s has a kebab-case id', (id) => {
    expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it('has a loader for every manifest entry and nothing more', () => {
    expect([...loadableToolIds()].toSorted()).toEqual([...ids].toSorted());
  });

  it.each(ids)('%s has a one-line summary', (id) => {
    const entry = getManifestEntry(id);
    expect(entry.summary.length).toBeGreaterThan(10);
    expect(entry.summary).not.toContain('\n');
  });
});

/**
 * The manifest is hand-written so it can be imported eagerly, which means it
 * could drift from the implementation it describes. These tests are the thing
 * that stops that: they load every tool for real and compare.
 */
describe.each(ids)('tool %s', (id) => {
  it('resolves to a real module', async () => {
    const tool = await loadTool(id);
    expect(tool.id).toBe(id);
  });

  it('matches the manifest metadata', async () => {
    const tool = await loadTool(id);
    const entry = getManifestEntry(id);

    expect(tool.name).toBe(entry.name);
    expect(tool.summary).toBe(entry.summary);
    expect(tool.category).toBe(entry.category);
    expect(tool.execution).toEqual(entry.execution);
  });

  it('matches the manifest ports exactly', async () => {
    const tool = await loadTool(id);
    const entry = getManifestEntry(id);

    // Structural comparison, so a renamed port or a changed accepted type in
    // either place fails here rather than at runtime on the canvas.
    expect(tool.inputs).toEqual(entry.inputs);
    expect(tool.outputs).toEqual(entry.outputs);
  });

  it('declares option fields covering exactly its schema keys', async () => {
    const tool = await loadTool(id);
    expect(tool.optionsSchema).toBeInstanceOf(z.ZodObject);

    const schemaKeys = Object.keys((tool.optionsSchema as z.ZodObject).shape).toSorted();
    const fieldKeys = tool.optionFields.map((field) => field.key).toSorted();

    expect(fieldKeys).toEqual(schemaKeys);
  });

  it('has default options that satisfy its own schema', async () => {
    const tool = await loadTool(id);
    expect(tool.optionsSchema.safeParse(tool.defaultOptions).success).toBe(true);
  });

  it('declares a sane execution budget', async () => {
    const tool = await loadTool(id);
    expect(tool.execution.timeoutMs).toBeGreaterThan(0);
    expect(tool.execution.maxInputBytes).toBeGreaterThan(0);
    // Nothing needs WASM yet; the shape exists but must stay unused for now.
    expect(tool.execution.requiresWasm).toBe(false);
    expect(tool.execution.wasmModules).toEqual([]);
  });
});

describe('isToolId', () => {
  it('accepts a known id', () => {
    expect(isToolId('base64')).toBe(true);
  });

  it('rejects an unknown one', () => {
    expect(isToolId('definitely-not-a-tool')).toBe(false);
  });
});

describe('searchTools', () => {
  it('returns everything for a blank query', () => {
    expect(searchTools('')).toHaveLength(TOOL_MANIFEST.length);
  });

  it('matches on name', () => {
    expect(searchTools('base64').map((entry) => entry.id)).toEqual(['base64']);
  });

  it('matches on a keyword that appears nowhere in the visible text', () => {
    expect(searchTools('btoa').map((entry) => entry.id)).toEqual(['base64']);
  });

  it('filters by category', () => {
    expect(searchTools('', 'data').map((entry) => entry.id)).toEqual(['structured-data']);
  });

  it('returns nothing for a miss', () => {
    expect(searchTools('zzzz')).toHaveLength(0);
  });
});

describe('port connections', () => {
  const base64 = getManifestEntry('base64');
  const structured = getManifestEntry('structured-data');

  it('wires base64 text output into the structured-data document input', () => {
    const connections = findConnections(base64, structured);
    expect(connections).toHaveLength(1);
    expect(connections[0]?.fromPort.id).toBe('output');
    expect(connections[0]?.toPort.id).toBe('input');
  });

  it('wires both structured-data outputs into base64 and structured-data inputs', () => {
    // 'output' is text (accepted by base64's text|bytes input); 'data' is json
    // (not accepted by base64), so exactly one wire is legal.
    expect(findConnections(structured, base64)).toHaveLength(1);
    // Into itself: text -> text|json and json -> text|json, so two.
    expect(findConnections(structured, structured)).toHaveLength(2);
  });

  it('reports connectability without loading any tool code', () => {
    expect(canToolsConnect(base64, structured)).toBe(true);
  });
});
