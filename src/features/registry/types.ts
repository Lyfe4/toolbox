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
import {
  materialiseBinary,
  residentBinary,
  sourceFor,
  type BinaryData,
  type ByteSource,
  type Bytes,
} from '@/lib/binary';

import type { ZodType, output as ZodOutput } from 'zod';

/**
 * Re-exported rather than moved, because `Bytes` is the name every tool
 * imports and the module it now lives in is about where bytes ARE rather than
 * about the tool contract.
 */
export type { BinaryData, ByteSource, Bytes };

/* ========================================================================== *
 * Data types
 * ========================================================================== */

/**
 * `as const` freezes this into a readonly tuple of string literals rather than
 * `string[]`, which is what lets the union type below be derived from it.
 *
 * A DATA TYPE EARNS ITS PLACE WHEN A PORT CARRIES IT. This list held `image`
 * and `datetime` for a long time and no port on any tool declared either, so
 * both were a distinction that could only ever produce friction:
 *
 *   - `image` contradicted the rule the rest of the app follows. The one tool
 *     that produces a picture declares `bytes` and lets the SNIFF say what the
 *     bytes are, which is what makes `image-convert -> hash` and
 *     `image-convert -> base64` legal. A separate `image` type would have made
 *     exactly those wires illegal, and given every future author a choice
 *     between two types for one concept with no right answer.
 *   - `datetime` had no producer and no consumer, and so no test could say
 *     whether its payload shape was right. It also appeared in the canvas's
 *     port legend as a type the canvas could not produce.
 *
 * `color` is the counter-example and the reason the shape is worth having at
 * all: `color-convert` really does carry a parsed colour on a port, which is
 * what lets a colour hop between nodes without a lossy round trip through
 * text. Re-adding a type is one entry here, one glyph and one payload member;
 * carrying one nothing produces is a permanent tax on every switch over
 * `ToolValue`.
 */
export const DATA_TYPES = ['text', 'json', 'bytes', 'color'] as const;

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

interface TextValue {
  readonly type: 'text';
  readonly text: string;
}

interface JsonBox {
  readonly type: 'json';
  readonly data: JsonValue;
}

interface ColorValue {
  readonly type: 'color';
  readonly color: ColorPayload;
}

interface BytesFacts {
  readonly type: 'bytes';
  /** Declared media type, if the source claimed one. Never trusted. */
  readonly mediaType: string | null;
  readonly filename: string | null;
}

/**
 * THE THREE SHAPES A BINARY VALUE HAS, AND WHY THERE ARE THREE.
 *
 * Everywhere outside a tool - on a wire, in the result cache, across the
 * worker boundary - a `bytes` value carries a `BinaryData`, which says whether
 * its bytes are in memory or in a blob that nobody has read. That is the
 * TRANSPORT shape, and it is the only one anything stores.
 *
 * A tool never sees it. What a tool sees is derived from what the tool said
 * about itself, in exactly the way its `run` signature is already derived from
 * its ports:
 *
 *   - A tool that reads binary input RESIDENTLY is handed `bytes`, a
 *     `Uint8Array`, which is byte for byte the shape every tool has always
 *     been handed. Nine of the ten tools are in this class and not one line of
 *     any of them changed.
 *   - A tool that reads binary input in WINDOWS is handed `source`, and there
 *     IS NO `bytes` MEMBER on it. That absence is the whole mechanism: the
 *     failure this was not built to avoid for a long time is a streaming value
 *     that some tools handle and others quietly buffer, and a tool cannot
 *     quietly buffer a value it has no way to ask for whole.
 */
interface ResidentBytes extends BytesFacts {
  readonly bytes: Bytes;
}

interface WindowedBytes extends BytesFacts {
  readonly source: ByteSource;
}

interface TransportBytes extends BytesFacts {
  readonly data: BinaryData;
}

/**
 * A value as it travels: between nodes, into the cache, across `postMessage`.
 *
 * A DISCRIMINATED UNION: every member has a `type` field holding a different
 * string literal, so checking `value.type === 'bytes'` tells TypeScript which
 * member it has and therefore that `value.data` is a `BinaryData`.
 *
 * Because the tag travels with the payload, a value is always self-describing.
 * A port can hand one to another tool and the receiver can narrow it safely
 * without a cast and without a separate "what is this" argument.
 *
 * Binary is a `Uint8Array` or a `Blob` and NEVER a base64 string. Base64 is an
 * encoding for transport; using it internally would mean paying a 33% size
 * penalty plus an encode/decode on every hop between tools.
 */
export type ToolValue = TextValue | JsonBox | TransportBytes | ColorValue;

/** A value as a tool that reads binary input residently sees it. */
export type ResidentValue = TextValue | JsonBox | ResidentBytes | ColorValue;

/** A value as a tool that reads binary input in windows sees it. */
export type WindowedValue = TextValue | JsonBox | WindowedBytes | ColorValue;

/** Every family, for the few helpers that are honestly generic over them. */
export type AnyValue = ToolValue | ResidentValue | WindowedValue;

/**
 * The payload shape for one or more data types, within one family.
 *
 * `Extract<Union, Shape>` keeps only the union members assignable to `Shape`.
 * So `ValueOfType<'bytes'>` is just the bytes member, and
 * `ValueOfType<'text' | 'bytes'>` is those two members - which is exactly what
 * a port accepting either type should hand its tool.
 *
 * It defaults to the RESIDENT family because tools are what read it, and the
 * resident family is what nine of the ten are handed.
 */
export type ValueOfType<T extends DataType, F extends AnyValue = ResidentValue> = Extract<
  F,
  { type: T }
>;

/**
 * A transport value over bytes that are already in memory.
 *
 * Worth a helper rather than an object literal because the literal is now four
 * fields deep, and because every call site that writes one is asserting the
 * bytes ARE resident - which is a claim, and is easier to see when it has a
 * name.
 */
export function bytesValue(
  bytes: Bytes,
  facts: { readonly mediaType?: string | null; readonly filename?: string | null } = {},
): ToolValue {
  return {
    type: 'bytes',
    data: residentBinary(bytes),
    mediaType: facts.mediaType ?? null,
    filename: facts.filename ?? null,
  };
}

/** Runtime tag check. Mirrors what `ValueOfType` does at compile time. */
export function isValueOfType<T extends DataType, F extends AnyValue = ToolValue>(
  value: F,
  types: readonly T[],
): value is ValueOfType<T, F> {
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
   *
   * `report` is the same bargain for a conversion report: a `summary` line,
   * optional `from` and `to` fact blocks, and a list of levelled notes. Drawn
   * as JSON it is a wall of braces in a read-only textarea, which is where
   * `GPS location was removed` had been living.
   *
   * `jwt` is the same again, and the one where the stakes are not aesthetic: a
   * decoded token whose signature verdict reads as one more line of braces
   * invites somebody to believe claims that nothing checked.
   */
  readonly presentation?: 'diff' | 'html' | 'jwt' | 'regex' | 'report';
}

/** True when an output port's declared types overlap an input port's. */
export function canConnect(from: OutputPort, to: InputPort): boolean {
  return from.types.some((type) => (to.types as readonly DataType[]).includes(type));
}

/** True when a concrete value may be delivered to a port. */
export function canAcceptValue(port: PortBase, value: AnyValue): boolean {
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
  /**
   * Shows this control only when the current options satisfy it.
   *
   * For a tool whose options depend on the conversion it is doing - Markdown
   * output settings mean nothing when the target is plain text - the
   * alternative is rendering controls that silently do nothing, which is the
   * `cursor: pointer` with no handler problem in another costume.
   *
   * A HIDDEN FIELD KEEPS ITS VALUE. This governs display only; the option is
   * still in the object, still travels in a share link, and comes back the
   * moment its condition holds again. Nothing is reset by looking away.
   *
   * Keep the predicate a function of as FEW options as possible. A panel whose
   * shape shifts on every toggle feels broken even when it is right; one whose
   * shape is a function of a single deliberate choice reads as the panel
   * answering you.
   */
  readonly when?: (options: TOptions) => boolean;
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

/*
 * A FIELD EARNS ITS PLACE WHEN SOMETHING READS IT.
 *
 * `requiresWasm: boolean` and `wasmModules: string[]` were declared here and
 * set on all nine tools, and nothing in `src/`, `scripts/` or `vite/` ever
 * read either one. They were exactly what `image` and `datetime` were before
 * the port audit removed them: a distinction the type system carried and
 * nothing acted on, plus a line every future tool author had to copy without
 * being able to find out what it did.
 *
 * The video feasibility investigation named them as the one thing that would
 * give them a job, and then the tool that was built does not need one - it
 * reads and writes container boxes in TypeScript rather than shipping a codec.
 * So they are deleted on the audit's own reasoning. Re-adding them is nine
 * lines and a consumer; carrying them was a tax on every tool for a consumer
 * that never arrived.
 *
 * `requiresOffscreenCanvas` is the counter-example and the reason the shape is
 * worth having at all: the engine really does read it, and really does choose
 * a different execution context because of it.
 */
export interface ExecutionMeta {
  readonly strategy: ExecutionStrategy;
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
  /**
   * Extra deadline granted per MiB of input, for a tool whose work is linear
   * in the size of the file.
   *
   * A DEADLINE MEASURES A TOOL'S OWN WORK, and a constant stopped being able
   * to when one tool's accepted input went from 256 MB to 4 GiB. A number that
   * fits a four-minute phone clip strangles an hour of broadcast; a number
   * that fits the broadcast lets the clip hang for twenty minutes before
   * anybody is told anything. Nothing else changes - the engine still restarts
   * the clock when the tool actually begins, so this is still a budget for the
   * work rather than for the queue.
   *
   * Omitted by every tool whose cost is bounded by its own small limit.
   */
  readonly timeoutMsPerMiB?: number;
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
export type InputsOf<TInputs extends readonly InputPort[], F extends AnyValue = ResidentValue> = {
  readonly [P in TInputs[number] as P['id']]: P['required'] extends true
    ? ValueOfType<P['types'][number], F>
    : ValueOfType<P['types'][number], F> | undefined;
};

/** The same idea for outputs; every declared output must be produced. */
export type OutputsOf<
  TOutputs extends readonly OutputPort[],
  F extends AnyValue = ResidentValue,
> = {
  readonly [P in TOutputs[number] as P['id']]: ValueOfType<P['types'][number], F>;
};

export interface ToolRunArgs<
  TInputs extends readonly InputPort[],
  TOptions,
  F extends AnyValue = ResidentValue,
> {
  readonly inputs: InputsOf<TInputs, F>;
  readonly options: TOptions;
  readonly context: ToolRunContext;
}

/* ========================================================================== *
 * Tool definition
 * ========================================================================== */

/**
 * How a tool reads binary input, and therefore what it is handed.
 *
 * Two classes, and the app now genuinely has two - which is a change to how
 * anybody reasons about it, not an implementation detail:
 *
 *   - `resident` is every tool that existed before the video tool grew past
 *     the size of memory. Its binary inputs arrive whole, bounded by its own
 *     `maxInputBytes`, exactly as they always did.
 *   - `windowed` is a tool that reads its input through a `ByteSource` and
 *     never holds it. It is the only class that can be given a file larger
 *     than the tab, and the price is that it has to be written as a walk over
 *     offsets rather than over an array.
 *
 * The class is a property of the IMPLEMENTATION, not of the manifest, and that
 * is deliberate: nothing outside `eraseTool` acts on it. The engine's job is
 * unchanged either way - it refuses an input over the tool's limit and posts
 * the value - so there is no third place for the two descriptions to disagree.
 */
export type BinaryHandling = 'resident' | 'windowed';

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
>(definition: ToolDefinition<TInputs, TOutputs, TSchema>): DefinedTool<TInputs, TOutputs, TSchema> {
  return { ...definition, binary: 'resident' };
}

/**
 * A tool that reads its binary input through a window onto it.
 *
 * Everything above is the same except the two halves that have to be: its
 * `run` is handed a `ByteSource` where a resident tool is handed a
 * `Uint8Array`, and it returns a `BinaryData` where a resident tool returns
 * one. Both are the transport shape, so a streaming tool is the one kind of
 * tool that decides for itself whether its answer is in memory.
 */
export interface StreamingToolDefinition<
  TInputs extends readonly InputPort[] = readonly InputPort[],
  TOutputs extends readonly OutputPort[] = readonly OutputPort[],
  TSchema extends ZodType = ZodType,
> extends Omit<ToolDefinition<TInputs, TOutputs, TSchema>, 'run'> {
  readonly run: (
    args: ToolRunArgs<TInputs, ZodOutput<TSchema>, WindowedValue>,
  ) => MaybePromise<ToolResult<OutputsOf<TOutputs, ToolValue>>>;
}

/**
 * The two things `defineTool` and `defineStreamingTool` return.
 *
 * The `binary` tag is added by the factory rather than written by the author,
 * so it cannot disagree with the shape of the `run` the compiler just checked.
 * A tool declaring `windowed` and reading `input.bytes` is not a mismatch that
 * has to be tested for; it is a definition that does not compile.
 */
export type DefinedTool<
  TInputs extends readonly InputPort[] = readonly InputPort[],
  TOutputs extends readonly OutputPort[] = readonly OutputPort[],
  TSchema extends ZodType = ZodType,
> = ToolDefinition<TInputs, TOutputs, TSchema> & { readonly binary: 'resident' };

export type DefinedStreamingTool<
  TInputs extends readonly InputPort[] = readonly InputPort[],
  TOutputs extends readonly OutputPort[] = readonly OutputPort[],
  TSchema extends ZodType = ZodType,
> = StreamingToolDefinition<TInputs, TOutputs, TSchema> & { readonly binary: 'windowed' };

export function defineStreamingTool<
  const TInputs extends readonly InputPort[],
  const TOutputs extends readonly OutputPort[],
  TSchema extends ZodType,
>(
  definition: StreamingToolDefinition<TInputs, TOutputs, TSchema>,
): DefinedStreamingTool<TInputs, TOutputs, TSchema> {
  return { ...definition, binary: 'windowed' };
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
>(
  tool: DefinedTool<TInputs, TOutputs, TSchema> | DefinedStreamingTool<TInputs, TOutputs, TSchema>,
): ErasedTool {
  return {
    id: tool.id,
    name: tool.name,
    summary: tool.summary,
    category: tool.category,
    inputs: tool.inputs,
    outputs: tool.outputs,
    optionsSchema: tool.optionsSchema,
    defaultOptions: tool.defaultOptions,
    /*
     * The one cast in the erasure, and it is `when` that forces it.
     *
     * A field holding `(options: TOptions) => boolean` makes OptionField
     * CONTRAVARIANT in TOptions, so `OptionField<Base64Options>[]` is no
     * longer assignable to `OptionField<Record<string, unknown>>[]` - which is
     * TypeScript being right: a predicate expecting Base64Options must not be
     * handed an arbitrary record.
     *
     * It is sound here for the same reason the erased `run` below is sound.
     * These descriptors are only ever evaluated against THIS tool's own
     * options object, by the panel rendering THIS tool. The predicates are
     * also written to be total: they compare a string, so a missing key yields
     * false and the field is hidden rather than anything throwing.
     */
    optionFields: tool.optionFields as unknown as readonly OptionField<Record<string, unknown>>[],
    execution: tool.execution,
    secretOptionKeys: tool.secretOptionKeys ?? [],
    run: async ({ inputs, options, context }) => {
      const checked = validateInputs(tool.inputs, inputs);
      if (!checked.ok) return checked;

      const parsed = tool.optionsSchema.safeParse(options);
      if (!parsed.success) {
        return fail('invalid-input', 'Those options are not valid for this tool.', {
          detail: parsed.error.issues.map((issue) => issue.message).join('; '),
        });
      }

      /*
       * THE BOUNDARY BETWEEN THE TWO CLASSES OF TOOL, AND THE ONLY ONE.
       *
       * A streaming tool is handed a source per binary input and its answer
       * needs no conversion, because it already speaks the transport shape. A
       * resident tool is handed whole bytes - which is where a deferred value
       * is materialised, and the ONLY place in the app where that happens on
       * behalf of a tool.
       *
       * That it is safe rests entirely on the engine having already refused an
       * input over this tool's `maxInputBytes`. A resident tool therefore
       * cannot be handed more than the number it wrote down about itself,
       * however large the value that arrived on the wire was, and a video
       * output too big for `hash` fails as a size refusal naming both rather
       * than as an allocation nobody predicted.
       */
      if (tool.binary === 'windowed') {
        return await tool.run({
          inputs: (await mapValues(checked.value, windowValue)) as InputsOf<TInputs, WindowedValue>,
          options: parsed.data,
          context,
        });
      }

      const result = await tool.run({
        inputs: (await mapValues(checked.value, residentValue)) as InputsOf<TInputs>,
        options: parsed.data,
        context,
      });
      if (!result.ok) return result;
      return ok(await mapValues(result.value, transportValue));
    },
  };
}

/**
 * Rebuilds a record of values through one conversion, leaving gaps as gaps.
 *
 * Sequential rather than `Promise.all`, and deliberately: the conversions that
 * are not free are materialisations, and two of those running together is two
 * whole files in memory at the same moment for no gain in wall clock, since
 * both are waiting on the same disk.
 */
async function mapValues<In, Out>(
  values: Readonly<Record<string, In | undefined>>,
  convert: (value: In) => MaybePromise<Out>,
): Promise<Readonly<Record<string, Out>>> {
  const out: Record<string, Out> = {};
  for (const [id, value] of Object.entries(values)) {
    if (value === undefined) continue;
    out[id] = await convert(value);
  }
  return out;
}

async function residentValue(value: ToolValue): Promise<ResidentValue> {
  if (value.type !== 'bytes') return value;
  const { mediaType, filename } = value;
  return { type: 'bytes', bytes: await materialiseBinary(value.data), mediaType, filename };
}

async function windowValue(value: ToolValue): Promise<WindowedValue> {
  if (value.type !== 'bytes') return value;
  const { mediaType, filename } = value;
  return { type: 'bytes', source: await sourceFor(value.data), mediaType, filename };
}

function transportValue(value: ResidentValue): ToolValue {
  if (value.type !== 'bytes') return value;
  const { mediaType, filename } = value;
  return { type: 'bytes', data: residentBinary(value.bytes), mediaType, filename };
}
