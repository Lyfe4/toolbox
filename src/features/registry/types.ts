/**
 * THE TOOL TYPE SYSTEM
 *
 * Every tool in Patchbay is described by this file. It exists to make three
 * classes of mistake impossible to compile:
 *
 *   1. A tool declaring a 'bytes' input but implemented with a function that
 *      expects a string.
 *   2. A tool returning an output whose type its port never promised.
 *   3. A tool throwing across the execution boundary instead of returning a
 *      structured error.
 *
 * The mechanism for (1) and (2) is explained at `defineTool` at the bottom.
 */
import type { ZodType, output as ZodOutput } from 'zod';

/* ========================================================================== *
 * Data types
 * ========================================================================== */

/**
 * `as const` freezes this into a readonly tuple of string literals rather than
 * `string[]`, which is what lets the union type below be derived from it.
 */
export const DATA_TYPES = ['text', 'json', 'bytes', 'image', 'color', 'datetime'] as const;

/**
 * `(typeof DATA_TYPES)[number]` reads as "the type of any element of
 * DATA_TYPES", i.e. 'text' | 'json' | 'bytes' | ... Adding an entry above
 * extends this union automatically.
 */
export type DataType = (typeof DATA_TYPES)[number];

/**
 * Anything JSON.stringify round-trips. Recursive on purpose: a JsonValue may
 * contain arrays and objects of JsonValue.
 */
export type JsonValue =
  string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/**
 * Bytes we own.
 *
 * Explicitly `Uint8Array<ArrayBuffer>` rather than the default
 * `Uint8Array<ArrayBufferLike>`: the loose form also permits a
 * SharedArrayBuffer, which can be neither transferred to a worker nor used to
 * build a Blob. Pinning it here means those guarantees hold everywhere.
 */
export type Bytes = Uint8Array<ArrayBuffer>;

/**
 * True when a JsonValue is an array.
 *
 * `value is readonly JsonValue[]` is a TYPE PREDICATE. It matters because the
 * built-in `Array.isArray` narrows to `any[]`, which would quietly leak `any`
 * into every element read afterwards. This keeps the element type.
 */
export function isJsonArray(value: JsonValue): value is readonly JsonValue[] {
  return Array.isArray(value);
}

/**
 * True when a JsonValue is a plain object.
 *
 * Also a type predicate, and for the same reason as `isJsonArray`: writing the
 * three checks inline does not narrow `JsonValue` down to the object member,
 * because `Array.isArray` narrows to `any[]` rather than excluding the array
 * member of a readonly union. Stating the predicate explicitly does.
 */
export function isJsonObject(value: JsonValue): value is Readonly<Record<string, JsonValue>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** sRGB colour with an alpha channel, all channels 0-1 except alpha. */
export interface ColorPayload {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

export interface DateTimePayload {
  /** Milliseconds since the Unix epoch, UTC. */
  readonly epochMs: number;
  /** IANA zone the value should be displayed in, when one is known. */
  readonly timeZone: string | null;
}

/**
 * A DISCRIMINATED UNION: every member has a `type` field holding a different
 * string literal, so checking `value.type === 'bytes'` tells TypeScript which
 * member it has and therefore that `value.data` is a Uint8Array.
 *
 * Because the tag travels with the payload, a value is always self-describing.
 * A port can hand one to another tool and the receiver can narrow it safely
 * without a cast and without a separate "what is this" argument.
 *
 * Binary is Uint8Array or Blob and NEVER a base64 string. Base64 is an
 * encoding for transport; using it internally would mean paying a 33% size
 * penalty plus an encode/decode on every hop between tools.
 */
export type ToolValue =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'json'; readonly data: JsonValue }
  | {
      readonly type: 'bytes';
      readonly bytes: Bytes;
      /** Declared media type, if the source claimed one. Never trusted. */
      readonly mediaType: string | null;
      readonly filename: string | null;
    }
  | { readonly type: 'image'; readonly blob: Blob; readonly mediaType: string }
  | { readonly type: 'color'; readonly color: ColorPayload }
  | { readonly type: 'datetime'; readonly datetime: DateTimePayload };

/**
 * The payload shape for one or more data types.
 *
 * `Extract<Union, Shape>` keeps only the union members assignable to `Shape`.
 * So `ValueOfType<'bytes'>` is just the bytes member, and
 * `ValueOfType<'text' | 'bytes'>` is those two members - which is exactly what
 * a port accepting either type should hand its tool.
 */
export type ValueOfType<T extends DataType> = Extract<ToolValue, { type: T }>;

/** Runtime tag check. Mirrors what `ValueOfType` does at compile time. */
export function isValueOfType<T extends DataType>(
  value: ToolValue,
  types: readonly T[],
): value is ValueOfType<T> {
  return (types as readonly DataType[]).includes(value.type);
}

/* ========================================================================== *
 * Ports
 * ========================================================================== */

/**
 * A non-empty list of data types.
 *
 * `[DataType, ...DataType[]]` means "one DataType, then any number more", so
 * the compiler rejects a port that accepts nothing at all.
 */
export type DataTypeList = readonly [DataType, ...DataType[]];

interface PortBase {
  /** Stable within the tool. Used as the key in the inputs/outputs record. */
  readonly id: string;
  readonly label: string;
  /**
   * The types this port can carry.
   *
   * NOTE ON NAMING: the original spec called this `type` (singular). It is a
   * list because base64's output really is text when encoding and bytes when
   * decoding, and its input accepts either. Modelling that as one port with
   * two admissible types is honest; the alternative is ports that appear and
   * disappear as options change, which is far more machinery for no gain.
   * A connection is checked statically against these declared types and again
   * at runtime against the actual value's tag - see `canAcceptValue`.
   */
  readonly types: DataTypeList;
  readonly description?: string;
}

export interface InputPort extends PortBase {
  /** When false the tool must cope with the port being absent. */
  readonly required: boolean;
}

export interface OutputPort extends PortBase {
  /**
   * A hint about how to draw this value, for the rare case where the data
   * type alone is not enough.
   *
   * A diff is `json` - it has to be, because a screen reader needs the rows as
   * structure rather than as a wall of prefixed text - but so is half of
   * everything else, and a JSON tree is the wrong view for it. This says which
   * renderer to reach for. It is a presentation hint only: the value is
   * ordinary JSON, and any consumer that ignores this still gets valid data.
   */
  readonly presentation?: 'diff';
}

/** True when an output port's declared types overlap an input port's. */
export function canConnect(from: OutputPort, to: InputPort): boolean {
  return from.types.some((type) => (to.types as readonly DataType[]).includes(type));
}

/** True when a concrete value may be delivered to a port. */
export function canAcceptValue(port: PortBase, value: ToolValue): boolean {
  return (port.types as readonly DataType[]).includes(value.type);
}

/* ========================================================================== *
 * Results
 * ========================================================================== */

export const TOOL_ERROR_CODES = [
  'invalid-input',
  'parse-error',
  'unsupported-type',
  'limit-exceeded',
  'cancelled',
  'timeout',
  'internal',
] as const;

export type ToolErrorCode = (typeof TOOL_ERROR_CODES)[number];

/** 1-based line and column, for pointing at a spot in the user's input. */
export interface SourcePosition {
  readonly line: number;
  readonly column: number;
  /** Character offset from the start of the input, when known. */
  readonly offset: number | null;
}

export interface ToolError {
  readonly code: ToolErrorCode;
  /** Written for the person using the tool, not for a log file. */
  readonly message: string;
  /** Where in the input the problem is, for parse failures. */
  readonly position?: SourcePosition;
  /** Extra context shown under the message when present. */
  readonly detail?: string;
}

/**
 * The result of anything that can fail.
 *
 * Another discriminated union, tagged on `ok`. After `if (result.ok)` the
 * compiler knows `result.value` exists; in the `else` branch it knows
 * `result.error` exists. There is no way to read a value without having
 * checked, and no way for a failure to be silently ignored - which is exactly
 * the guarantee an exception does not give you.
 */
export type ToolResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: ToolError };

export function ok<T>(value: T): ToolResult<T> {
  return { ok: true, value };
}

export function err<T = never>(error: ToolError): ToolResult<T> {
  return { ok: false, error };
}

/** Convenience for the common "bad input" case. */
export function fail<T = never>(
  code: ToolErrorCode,
  message: string,
  // `| undefined` here, but not on ToolError: callers routinely compute a
  // maybe-detail, and exactOptionalPropertyTypes would otherwise reject it.
  extra?: { readonly position?: SourcePosition | undefined; readonly detail?: string | undefined },
): ToolResult<T> {
  return {
    ok: false,
    error: {
      code,
      message,
      ...(extra?.position ? { position: extra.position } : {}),
      ...(extra?.detail !== undefined ? { detail: extra.detail } : {}),
    },
  };
}

/* ========================================================================== *
 * Options metadata
 * ========================================================================== */

/**
 * Describes one control in the options panel.
 *
 * `keyof TOptions & string` ties every descriptor to a real key of the
 * options type, so renaming an option in the Zod schema breaks this list at
 * compile time instead of silently rendering a control that edits nothing.
 * A registry test additionally asserts the descriptors cover every key.
 */
interface OptionFieldBase<TOptions> {
  readonly key: keyof TOptions & string;
  readonly label: string;
  readonly description?: string;
}

export type OptionField<TOptions> =
  | (OptionFieldBase<TOptions> & { readonly control: 'toggle' })
  | (OptionFieldBase<TOptions> & {
      readonly control: 'select';
      readonly choices: readonly { readonly value: string; readonly label: string }[];
    })
  | (OptionFieldBase<TOptions> & {
      readonly control: 'number';
      readonly min: number;
      readonly max: number;
      readonly step: number;
    })
  | (OptionFieldBase<TOptions> & {
      readonly control: 'text';
      readonly placeholder?: string;
      /**
       * Renders as a password field and is never echoed in a share link.
       * Options DO travel in share links, so a secret must opt out - see
       * `secretOptionKeys` on the tool definition.
       */
      readonly secret?: boolean;
      readonly multiline?: boolean;
    });

/* ========================================================================== *
 * Execution metadata
 * ========================================================================== */

/**
 * Where a tool runs.
 *
 * 'main' is only for tools that are pure, synchronous and cheap on any input
 * they accept. It is a declared property of the tool rather than a decision
 * made at the call site, so the choice is reviewed once, in the tool, instead
 * of guessed at differently by every caller.
 */
export type ExecutionStrategy = 'worker' | 'main';

export interface ExecutionMeta {
  readonly strategy: ExecutionStrategy;
  /** Declared shape for WASM-backed tools. Nothing needs this yet. */
  readonly requiresWasm: boolean;
  readonly wasmModules: readonly string[];
  /**
   * True when the tool's worker path needs `OffscreenCanvas`.
   *
   * Declared rather than probed inside the tool, because by the time `run`
   * executes the context has already been chosen and cannot be changed. The
   * engine reads this and downgrades the tool to the main thread on browsers
   * that lack the API - Safari before 16.4, Firefox before 105.
   */
  readonly requiresOffscreenCanvas: boolean;
  /** True when run() calls context.reportProgress, so the UI can show a bar. */
  readonly reportsProgress: boolean;
  /** Worker is terminated and replaced if a run exceeds this. */
  readonly timeoutMs: number;
  /** Inputs larger than this are rejected before the tool is even loaded. */
  readonly maxInputBytes: number;
  /**
   * Shown instead of the generic timeout text when this tool runs over.
   *
   * A regex that backtracks catastrophically needs to say "this pattern is too
   * slow", not "the tool took too long" - the user has to know it is their
   * pattern, not the app.
   */
  readonly timeoutMessage?: string;
}

export interface ToolRunContext {
  /** Aborted on user cancellation or timeout. Long loops should check it. */
  readonly signal: AbortSignal;
  /** `fraction` is 0-1. No-op for tools that declare reportsProgress: false. */
  readonly reportProgress: (fraction: number, label?: string) => void;
}

export const TOOL_CATEGORIES = ['encoding', 'data', 'text', 'colour', 'time', 'hashing'] as const;
export type ToolCategory = (typeof TOOL_CATEGORIES)[number];

/* ========================================================================== *
 * Deriving the run signature from the ports
 * ========================================================================== */

export type MaybePromise<T> = T | Promise<T>;

/**
 * The `inputs` argument a tool's run function receives, computed from its
 * declared input ports.
 *
 * This is a MAPPED TYPE with key remapping. Read it as:
 *   for each port P in the list        -> `[P in TInputs[number]`
 *   name the key after that port's id  -> `as P['id']]`
 *   give it the payload for that port's types, made optional when the port is
 *   not required.
 *
 * So `inputs: [{ id: 'data', types: ['bytes'], required: true }]` produces
 * `{ data: { type: 'bytes'; bytes: Uint8Array; ... } }` and a run function
 * that tried to read `inputs.data.text` would not compile.
 */
export type InputsOf<TInputs extends readonly InputPort[]> = {
  readonly [P in TInputs[number] as P['id']]: P['required'] extends true
    ? ValueOfType<P['types'][number]>
    : ValueOfType<P['types'][number]> | undefined;
};

/** The same idea for outputs; every declared output must be produced. */
export type OutputsOf<TOutputs extends readonly OutputPort[]> = {
  readonly [P in TOutputs[number] as P['id']]: ValueOfType<P['types'][number]>;
};

export interface ToolRunArgs<TInputs extends readonly InputPort[], TOptions> {
  readonly inputs: InputsOf<TInputs>;
  readonly options: TOptions;
  readonly context: ToolRunContext;
}

/* ========================================================================== *
 * Tool definition
 * ========================================================================== */

export interface ToolDefinition<
  TInputs extends readonly InputPort[] = readonly InputPort[],
  TOutputs extends readonly OutputPort[] = readonly OutputPort[],
  TSchema extends ZodType = ZodType,
> {
  /** kebab-case and stable forever: it appears in URLs and saved documents. */
  readonly id: string;
  readonly name: string;
  /** One line. Shown in the tool index and in search results. */
  readonly summary: string;
  readonly category: ToolCategory;

  readonly inputs: TInputs;
  readonly outputs: TOutputs;

  readonly optionsSchema: TSchema;
  readonly defaultOptions: ZodOutput<TSchema>;
  readonly optionFields: readonly OptionField<ZodOutput<TSchema>>[];

  readonly execution: ExecutionMeta;

  /**
   * Option keys holding user secrets, stripped before a graph is shared.
   *
   * Options normally travel in a share link. A JWT signing key does not.
   */
  readonly secretOptionKeys?: readonly (keyof ZodOutput<TSchema> & string)[];

  readonly run: (
    args: ToolRunArgs<TInputs, ZodOutput<TSchema>>,
  ) => MaybePromise<ToolResult<OutputsOf<TOutputs>>>;
}

/**
 * Identity function whose only job is to infer precise types.
 *
 * The `const` modifier on the type parameters is what makes this work. Without
 * it, TypeScript widens `types: ['bytes']` to `string[]` and `required: true`
 * to `boolean`, and the derived `InputsOf` would be useless. With `const`, the
 * object literal is inferred exactly as written - `readonly ['bytes']`,
 * `true` - so `InputsOf<TInputs>` resolves to concrete payload types and the
 * run function is checked against them.
 *
 * That is the compile-time port/implementation check: it is not a separate
 * assertion, it falls out of inferring the run signature FROM the ports rather
 * than declaring the two independently and hoping they agree.
 */
export function defineTool<
  const TInputs extends readonly InputPort[],
  const TOutputs extends readonly OutputPort[],
  TSchema extends ZodType,
>(
  definition: ToolDefinition<TInputs, TOutputs, TSchema>,
): ToolDefinition<TInputs, TOutputs, TSchema> {
  return definition;
}

/* ========================================================================== *
 * Erased view, for storing tools of different shapes together
 * ========================================================================== */

export type ToolInputs = Readonly<Record<string, ToolValue | undefined>>;
export type ToolOutputs = Readonly<Record<string, ToolValue>>;

/**
 * A tool with its generics forgotten, so the registry can hold a collection of
 * differently-shaped tools. Callers get runtime validation instead of the
 * compile-time guarantees the tool itself was written against.
 */
export interface ErasedTool {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly category: ToolCategory;
  readonly inputs: readonly InputPort[];
  readonly outputs: readonly OutputPort[];
  readonly optionsSchema: ZodType;
  readonly defaultOptions: unknown;
  readonly optionFields: readonly OptionField<Record<string, unknown>>[];
  readonly execution: ExecutionMeta;
  readonly secretOptionKeys: readonly string[];
  readonly run: (args: {
    readonly inputs: ToolInputs;
    readonly options: unknown;
    readonly context: ToolRunContext;
  }) => MaybePromise<ToolResult<ToolOutputs>>;
}

/** Checks a loose inputs record against a tool's declared input ports. */
export function validateInputs(
  ports: readonly InputPort[],
  inputs: ToolInputs,
): ToolResult<ToolInputs> {
  for (const port of ports) {
    const value = inputs[port.id];

    if (value === undefined) {
      if (port.required) {
        return fail('invalid-input', `Missing required input "${port.label}".`);
      }
      continue;
    }

    if (!canAcceptValue(port, value)) {
      return fail('unsupported-type', `Input "${port.label}" cannot accept ${value.type} data.`, {
        detail: `Accepted types: ${port.types.join(', ')}.`,
      });
    }
  }

  return ok(inputs);
}

/**
 * Drops a tool's generic parameters so it can live in the registry.
 *
 * The cast inside is sound because `validateInputs` has just confirmed, at
 * runtime, exactly what `InputsOf<TInputs>` asserts at compile time: every
 * required port is present and every present value carries a tag the port
 * accepts. The options are re-parsed through the tool's own Zod schema, so
 * they are validated rather than assumed.
 */
export function eraseTool<
  TInputs extends readonly InputPort[],
  TOutputs extends readonly OutputPort[],
  TSchema extends ZodType,
>(tool: ToolDefinition<TInputs, TOutputs, TSchema>): ErasedTool {
  return {
    id: tool.id,
    name: tool.name,
    summary: tool.summary,
    category: tool.category,
    inputs: tool.inputs,
    outputs: tool.outputs,
    optionsSchema: tool.optionsSchema,
    defaultOptions: tool.defaultOptions,
    optionFields: tool.optionFields,
    execution: tool.execution,
    secretOptionKeys: tool.secretOptionKeys ?? [],
    run: ({ inputs, options, context }) => {
      const checked = validateInputs(tool.inputs, inputs);
      if (!checked.ok) return checked;

      const parsed = tool.optionsSchema.safeParse(options);
      if (!parsed.success) {
        return fail('invalid-input', 'Those options are not valid for this tool.', {
          detail: parsed.error.issues.map((issue) => issue.message).join('; '),
        });
      }

      return tool.run({
        inputs: checked.value as InputsOf<TInputs>,
        options: parsed.data,
        context,
      });
    },
  };
}
