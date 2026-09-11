import { describe, expect, it } from 'vitest';

import { deferredBinary, residentBytes } from '@/lib/binary';
import { z } from '@/lib/zod';

import {
  bytesValue,
  canAcceptValue,
  canConnect,
  defineStreamingTool,
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
 *
 * Two of them probe a property read, and the `void` in front of it is
 * load-bearing rather than decoration: it is the thing that makes a bare
 * property read a legal STATEMENT, which is all these lines need to be. Drop
 * it and the line is an expression statement, which `no-unused-expressions`
 * rejects; assign it to a local instead and `noUnusedLocals` rejects that for
 * never being read. typescript-eslint 8.69.0 broadened
 * `no-meaningless-void-operator` to report `void` on any non-call expression,
 * so both lines carry a disable. It is a narrower change than contorting a
 * fixture to satisfy a linter, and `reportUnusedDisableDirectives` deletes it
 * for us on the day the rule narrows again.
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
    requiresOffscreenCanvas: false,
    reportsProgress: false,
    timeoutMs: 1000,
    maxInputBytes: 1024,
  },
  run: ({ inputs }) => {
    // @ts-expect-error a 'bytes' port has no `text` property
    // eslint-disable-next-line @typescript-eslint/no-meaningless-void-operator
    void inputs.data.text;

    // The correct property is available without a cast.
    const right: Uint8Array = inputs.data.bytes;

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
    requiresOffscreenCanvas: false,
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
    requiresOffscreenCanvas: false,
    reportsProgress: false,
    timeoutMs: 1000,
    maxInputBytes: 1024,
  },
  run: ({ inputs }) => {
    // @ts-expect-error `extra` may be undefined because the port is optional
    // eslint-disable-next-line @typescript-eslint/no-meaningless-void-operator
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
      requiresOffscreenCanvas: false,
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

/* ========================================================================== *
 * The two classes of tool
 * ========================================================================== */

/**
 * THE GUARANTEE THAT MAKES TWO CLASSES SAFE TO HAVE.
 *
 * The reason a streaming value model was declined once before is that one some
 * tools handle and others quietly buffer would be worse than an honest
 * ceiling. What makes it not that is entirely in `eraseTool`: a resident tool
 * is handed WHOLE BYTES whatever arrived on the wire, and a windowed one is
 * handed a source and has no `bytes` member to reach for. Neither has to know
 * anything about the other, and these are the tests that say so.
 */
describe('a tool is handed what its class declared, whatever arrived', () => {
  const anyOptions = z.object({});

  const ports = {
    inputs: [{ id: 'in', label: 'In', types: ['bytes'], required: true }],
    outputs: [{ id: 'out', label: 'Out', types: ['text'] }],
    optionsSchema: anyOptions,
    defaultOptions: {},
    optionFields: [],
    execution: {
      strategy: 'worker',
      requiresOffscreenCanvas: false,
      reportsProgress: false,
      timeoutMs: 1000,
      maxInputBytes: 1024 * 1024,
    },
  } as const;

  const residentTool = eraseTool(
    defineTool({
      id: 'resident',
      name: 'Resident',
      summary: 'Reports what it was handed.',
      category: 'encoding',
      ...ports,
      run: ({ inputs }) =>
        ok({ out: { type: 'text', text: [...inputs.in.bytes].join(',') } as const }),
    }),
  );

  const windowedTool = eraseTool(
    defineStreamingTool({
      id: 'windowed',
      name: 'Windowed',
      summary: 'Reports what it was handed.',
      category: 'encoding',
      ...ports,
      run: ({ inputs }) =>
        ok({
          out: {
            type: 'text',
            text: `${String(inputs.in.source.size)}:${String(inputs.in.source.u8(1))}`,
          } as const,
        }),
    }),
  );

  const bytes = Uint8Array.from([9, 8, 7]);
  const deferred: ToolValue = {
    type: 'bytes',
    data: deferredBinary(new Blob([bytes]), bytes),
    mediaType: null,
    filename: null,
  };

  /*
   * THE ANSWER TO "WHAT DOES A TOOL THAT DOES NOT STREAM HAVE TO KNOW ABOUT
   * ONE THAT DOES", AND IT IS NOTHING. A deferred value arriving at a resident
   * tool is materialised on its behalf, once, in the erasure - and the size of
   * what that allocates is bounded by the number this tool wrote down about
   * itself, because the engine refused anything larger before posting it.
   */
  it('materialises a deferred value for a resident tool', async () => {
    const result = await residentTool.run({ inputs: { in: deferred }, options: {}, context });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.out).toEqual({ type: 'text', text: '9,8,7' });
  });

  it('and hands a windowed tool a source over the same value', async () => {
    const result = await windowedTool.run({ inputs: { in: deferred }, options: {}, context });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.out).toEqual({ type: 'text', text: '3:8' });
  });

  /*
   * And in the other direction: a RESIDENT value reaching a windowed tool is
   * not a special case either. Both classes take both kinds, which is what
   * keeps the wire free of a distinction the graph would otherwise have to
   * carry - a wire is legal or not because of its port TYPES, and never
   * because of where the bytes on it happen to be.
   */
  it('reads a resident value through a source just as well', async () => {
    const result = await windowedTool.run({
      inputs: { in: bytesValue(bytes) },
      options: {},
      context,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.out).toEqual({ type: 'text', text: '3:8' });
  });

  /*
   * A resident tool's output is still an ordinary `Uint8Array` in its own
   * code, and the transport shape is put back around it by the erasure - so
   * nothing about writing a resident tool changed, which was the point.
   */
  it('wraps a resident tool output back into the transport shape', async () => {
    const producer = eraseTool(
      defineTool({
        id: 'producer',
        name: 'Producer',
        summary: 'Produces bytes.',
        category: 'encoding',
        inputs: [{ id: 'in', label: 'In', types: ['text'], required: true }],
        outputs: [{ id: 'out', label: 'Out', types: ['bytes'] }],
        optionsSchema: anyOptions,
        defaultOptions: {},
        optionFields: [],
        execution: ports.execution,
        run: () =>
          ok({
            out: {
              type: 'bytes',
              bytes: Uint8Array.from([1, 2]),
              mediaType: null,
              filename: null,
            } as const,
          }),
      }),
    );

    const result = await producer.run({
      inputs: { in: { type: 'text', text: 'x' } },
      options: {},
      context,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const out = result.value.out;
    expect(out?.type).toBe('bytes');
    if (out?.type !== 'bytes') return;
    expect(out.data.kind).toBe('resident');
    expect([...(residentBytes(out.data) ?? [])]).toEqual([1, 2]);
  });
});
