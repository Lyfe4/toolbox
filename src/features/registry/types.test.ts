import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  canAcceptValue,
  canConnect,
  defineTool,
  eraseTool,
  fail,
  isValueOfType,
  ok,
  validateInputs,
  type InputPort,
  type OutputPort,
  type ToolRunContext,
  type ToolValue,
} from './types';

const schema = z.object({ upper: z.boolean().default(false) });

const context: ToolRunContext = {
  signal: new AbortController().signal,
  reportProgress: () => undefined,
};

function textValue(text: string): ToolValue {
  return { type: 'text', text };
}

/* ========================================================================== *
 * Compile-time behaviour
 *
 * These blocks assert things about TYPES, not about runtime values. The
 * `@ts-expect-error` comments are the assertions: each one fails the build if
 * the line below it ever starts compiling. That is how the port/run contract
 * is proved - not by a runtime check, but by demonstrating that the wrong
 * implementation is rejected by tsc.
 * ========================================================================== */

// A tool whose input port declares bytes cannot be implemented as if it were text.
defineTool({
  id: 'compile-check-bytes',
  name: 'Compile check',
  summary: 'Type-level fixture.',
  category: 'encoding',
  inputs: [{ id: 'data', label: 'Data', types: ['bytes'], required: true }],
  outputs: [{ id: 'out', label: 'Out', types: ['text'] }],
  optionsSchema: schema,
  defaultOptions: { upper: false },
  optionFields: [],
  execution: {
    strategy: 'main',
    requiresWasm: false,
    wasmModules: [],
    reportsProgress: false,
    timeoutMs: 1000,
    maxInputBytes: 1024,
  },
  run: ({ inputs }) => {
    // @ts-expect-error a 'bytes' port has no `text` property
    void inputs.data.text;

    // The correct property is available without a cast.
    const right: Uint8Array = inputs.data.bytes;
    void right;

    return ok({ out: { type: 'text', text: String(right.length) } as const });
  },
});

// An output port declaring 'text' cannot be satisfied with a json payload.
defineTool({
  id: 'compile-check-output',
  name: 'Compile check',
  summary: 'Type-level fixture.',
  category: 'encoding',
  inputs: [{ id: 'in', label: 'In', types: ['text'], required: true }],
  outputs: [{ id: 'out', label: 'Out', types: ['text'] }],
  optionsSchema: schema,
  defaultOptions: { upper: false },
  optionFields: [],
  execution: {
    strategy: 'main',
    requiresWasm: false,
    wasmModules: [],
    reportsProgress: false,
    timeoutMs: 1000,
    maxInputBytes: 1024,
  },
  // @ts-expect-error 'json' is not one of the declared output types
  run: () => ok({ out: { type: 'json', data: { a: 1 } } as const }),
});

// A port that is not required arrives as possibly-undefined.
defineTool({
  id: 'compile-check-optional',
  name: 'Compile check',
  summary: 'Type-level fixture.',
  category: 'encoding',
  inputs: [{ id: 'extra', label: 'Extra', types: ['text'], required: false }],
  outputs: [{ id: 'out', label: 'Out', types: ['text'] }],
  optionsSchema: schema,
  defaultOptions: { upper: false },
  optionFields: [],
  execution: {
    strategy: 'main',
    requiresWasm: false,
    wasmModules: [],
    reportsProgress: false,
    timeoutMs: 1000,
    maxInputBytes: 1024,
  },
  run: ({ inputs }) => {
    // @ts-expect-error `extra` may be undefined because the port is optional
    void inputs.extra.text;

    return ok({ out: { type: 'text', text: inputs.extra?.text ?? '' } as const });
  },
});

/* ========================================================================== *
 * Runtime behaviour
 * ========================================================================== */

const textPort: InputPort = { id: 'a', label: 'A', types: ['text'], required: true };
const eitherPort: InputPort = { id: 'b', label: 'B', types: ['text', 'bytes'], required: true };
const optionalPort: InputPort = { id: 'c', label: 'C', types: ['json'], required: false };
const textOut: OutputPort = { id: 'o', label: 'O', types: ['text'] };
const jsonOut: OutputPort = { id: 'j', label: 'J', types: ['json'] };

describe('port compatibility', () => {
  it('connects when the declared types overlap', () => {
    expect(canConnect(textOut, textPort)).toBe(true);
    expect(canConnect(textOut, eitherPort)).toBe(true);
  });

  it('refuses a connection with no overlap', () => {
    expect(canConnect(jsonOut, textPort)).toBe(false);
    expect(canConnect(jsonOut, eitherPort)).toBe(false);
  });

  it('checks a concrete value against a port at runtime', () => {
    expect(canAcceptValue(eitherPort, textValue('x'))).toBe(true);
    expect(canAcceptValue(textPort, { type: 'json', data: null })).toBe(false);
  });
});

describe('isValueOfType', () => {
  it('narrows on the tag', () => {
    const value: ToolValue = textValue('hi');
    expect(isValueOfType(value, ['text', 'bytes'])).toBe(true);
    expect(isValueOfType(value, ['json'])).toBe(false);
  });
});

describe('validateInputs', () => {
  it('accepts a well-formed record', () => {
    expect(validateInputs([textPort], { a: textValue('x') }).ok).toBe(true);
  });

  it('reports a missing required input', () => {
    const result = validateInputs([textPort], {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('invalid-input');
      expect(result.error.message).toContain('A');
    }
  });

  it('allows a missing optional input', () => {
    expect(validateInputs([optionalPort], {}).ok).toBe(true);
  });

  it('rejects a value whose tag the port does not accept', () => {
    const result = validateInputs([textPort], { a: { type: 'json', data: 1 } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('unsupported-type');
  });
});

describe('ok / err / fail', () => {
  it('builds a success', () => {
    expect(ok(3)).toEqual({ ok: true, value: 3 });
  });

  it('omits absent optional error fields rather than setting them undefined', () => {
    const result = fail('parse-error', 'bad');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(Object.hasOwn(result.error, 'position')).toBe(false);
      expect(Object.hasOwn(result.error, 'detail')).toBe(false);
    }
  });
});

describe('eraseTool', () => {
  const tool = defineTool({
    id: 'echo',
    name: 'Echo',
    summary: 'Returns its input, optionally upper-cased.',
    category: 'text',
    inputs: [{ id: 'in', label: 'In', types: ['text'], required: true }],
    outputs: [{ id: 'out', label: 'Out', types: ['text'] }],
    optionsSchema: schema,
    defaultOptions: { upper: false },
    optionFields: [{ key: 'upper', label: 'Upper case', control: 'toggle' }],
    execution: {
      strategy: 'main',
      requiresWasm: false,
      wasmModules: [],
      reportsProgress: false,
      timeoutMs: 1000,
      maxInputBytes: 1024,
    },
    run: ({ inputs, options }) =>
      ok({
        out: {
          type: 'text',
          text: options.upper ? inputs.in.text.toUpperCase() : inputs.in.text,
        } as const,
      }),
  });

  const erased = eraseTool(tool);

  it('runs through the erased surface', async () => {
    const result = await erased.run({
      inputs: { in: textValue('hi') },
      options: { upper: true },
      context,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.out).toEqual({ type: 'text', text: 'HI' });
  });

  it('applies schema defaults to partial options', async () => {
    const result = await erased.run({ inputs: { in: textValue('hi') }, options: {}, context });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.out).toEqual({ type: 'text', text: 'hi' });
  });

  it('returns an error for invalid options instead of throwing', async () => {
    const result = await erased.run({
      inputs: { in: textValue('hi') },
      options: { upper: 'yes please' },
      context,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid-input');
  });

  it('validates inputs before the tool sees them', async () => {
    const result = await erased.run({ inputs: {}, options: {}, context });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('invalid-input');
  });
});
