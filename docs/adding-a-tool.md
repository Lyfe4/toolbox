# Adding a tool

A complete worked example: a tool that converts text between cases. Small
enough to read in one go, and it touches every part you would need for a real
one — options, a schema, a port, the manifest, the loader, tests and a README.

Five files, two edits. The compiler catches four of the five ways to get it
wrong.

## 1. The options

`src/tools/case-convert/options.ts`

Options are a Zod schema with a `.default()` on every field. That is what makes
`defaultOptions` one call rather than a hand-maintained copy of the schema, and
it is what lets a share link omit anything left at its default.

```ts
import type { OptionField } from '@/features/registry/types';
// Not 'zod' directly: @/lib/zod configures it once (jitless, for CSP) and an
// ESLint rule enforces the indirection.
import { z } from '@/lib/zod';

export const caseOptionsSchema = z.object({
  target: z.enum(['upper', 'lower', 'title', 'snake', 'kebab']).default('upper'),
  trim: z.boolean().default(true),
});

// `z.output` is the type AFTER parsing, so every default has been applied and
// every field is present. `z.input` would leave them all optional.
export type CaseOptions = z.output<typeof caseOptionsSchema>;

export const caseDefaultOptions: CaseOptions = caseOptionsSchema.parse({});

// What the UI draws. It is a plain array rather than anything derived from the
// schema, because labels and ordering are editorial decisions.
export const caseOptionFields: readonly OptionField<CaseOptions>[] = [
  {
    key: 'target',
    label: 'Convert to',
    control: 'select',
    choices: [
      { value: 'upper', label: 'UPPER CASE' },
      { value: 'lower', label: 'lower case' },
      { value: 'title', label: 'Title Case' },
      { value: 'snake', label: 'snake_case' },
      { value: 'kebab', label: 'kebab-case' },
    ],
  },
  { key: 'trim', label: 'Trim whitespace', control: 'toggle' },
];
```

## 2. The implementation

`src/tools/case-convert/index.ts`

```ts
import { defineTool, eraseTool, fail, ok, type ErasedTool } from '@/features/registry/types';

import { caseDefaultOptions, caseOptionFields, caseOptionsSchema } from './options';

export const caseConvertTool = defineTool({
  id: 'case-convert',
  name: 'Case',
  summary: 'Convert text between upper, lower, title, snake and kebab case.',
  category: 'text',

  inputs: [
    {
      id: 'input',
      label: 'Text',
      types: ['text'],
      required: true,
      description: 'The text to convert.',
    },
  ],

  outputs: [
    {
      id: 'output',
      label: 'Converted',
      types: ['text'],
      description: 'The text, in the chosen case.',
    },
  ],

  optionsSchema: caseOptionsSchema,
  defaultOptions: caseDefaultOptions,
  optionFields: caseOptionFields,

  execution: {
    // Main thread: this is a string transform on text a person typed. A worker
    // would cost more in postMessage than the work itself.
    strategy: 'main',
    requiresOffscreenCanvas: false,
    reportsProgress: false,
    timeoutMs: 5_000,
    maxInputBytes: 2 * 1024 * 1024,
  },

  run: ({ inputs, options }) => {
    // `inputs.input` is narrowed to the text variant by the single declared
    // type above. Declare `['text', 'bytes']` and the compiler would force a
    // check on `input.type` before letting you read either payload.
    const source = options.trim ? inputs.input.text.trim() : inputs.input.text;

    if (source === '') {
      // A ToolResult, not a throw. Execution must never throw across the
      // boundary - bad input is a result, and the UI renders it as one.
      return fail('invalid-input', 'Nothing to convert: the input is empty.');
    }

    return ok({ output: { type: 'text', text: convert(source, options.target) } as const });
  },
});

// The default export is the type-erased tool. `defineTool` keeps the precise
// types for the tool's own code; `eraseTool` is what the registry can store in
// a uniform map.
const erased: ErasedTool = eraseTool(caseConvertTool);
export default erased;
```

### The rules the port set holds itself to

`ports.test.ts` asserts all of these for every tool at once, so a new tool that
breaks one fails the suite rather than the reviewer's memory. The reasoning for
each is in
[architecture.md](architecture.md#the-conventions-and-what-each-one-is-worth).

- **The first output is `output`.** A node summarises its first declared output
  as "the tool's answer", and that only means anything if the set agrees.
- **One input is called `input`; several are each named.**
- **Every port carries a description.** It is the only documentation of a port
  that reaches a person: an input's is its editor's placeholder — or, on a port
  that cannot take text, the instruction above its file control — and an
  output's is shown in the Ports panel on the tool page.
- **A label fits in about eleven characters.** The label box on a node is 84px
  at 10px uppercase. Go past thirteen and it is mostly ellipsis.
- **No label appears twice on one tool**, or a node shows the same word on both
  sides with nothing to tell them apart.
- **A port that reads a document accepts `bytes` as well as `text`**, and
  decodes them through [`lib/text.ts`](../src/lib/text.ts) — strictly, so bytes
  that are not text say so instead of being processed as mojibake. A port that
  takes a short literal (a token, a colour) does not.
- **A data type earns its place when a port carries it.** Adding a member to
  `DATA_TYPES` for a tool you are about to write is fine; leaving one there for
  a tool nobody wrote is a permanent tax on every switch over `ToolValue`.

### `defineTool`, or `defineStreamingTool`

Almost certainly the first. `defineTool` gives a `bytes` input to your `run` as
a `Uint8Array`, bounded by the `maxInputBytes` you declare, exactly as every
tool in this repository except one works.

`defineStreamingTool` is for a tool whose input can be larger than the tab —
today that means `video-remux` and nothing else. Its `run` is handed a
`ByteSource` instead: `u8`, `view` and `slice` over bytes that may still be on
disk, and **no `bytes` member to reach for**. That absence is deliberate; see
[where a value's bytes are](architecture.md#where-a-values-bytes-are). Its
outputs are `BinaryData` rather than arrays, which is what lets it write a
result larger than memory through a `ByteSink`.

The cost is that every reader you write has to be a walk over offsets rather
than over an array, and that is a real constraint rather than a style: it is
why the video tool's four container readers look the way they do. Reach for it
when the file genuinely does not fit, and not before.

A port id is a persisted identifier — it is two of the four fields of every
edge, a key of `CanvasNode.inputs`, and it travels in share links — so renaming
one later means a migration in
[`retiredPorts.ts`](../src/features/canvas/retiredPorts.ts) plus a version bump
on both routes. Labels are free to change. Pick ids you can live with.

`convert` is ordinary code and lives in its own file — `case.ts` — so it can be
unit-tested without going near the registry.

## 3. The manifest entry

`src/features/registry/manifest.ts` — add to `TOOL_MANIFEST`:

```ts
{
  id: 'case-convert',
  name: 'Case',
  summary: 'Convert text between upper, lower, title, snake and kebab case.',
  category: 'text',
  // Terms people search for that are not in the name or summary.
  keywords: ['camel', 'pascal', 'capitalise', 'capitalize', 'slug'],
  inputs: [
    { id: 'input', label: 'Text', types: ['text'], required: true,
      description: 'The text to convert.' },
  ],
  outputs: [{ id: 'output', label: 'Converted', types: ['text'] }],
  execution: {
    strategy: 'main', requiresOffscreenCanvas: false, reportsProgress: false,
    timeoutMs: 5_000, maxInputBytes: 2 * 1024 * 1024,
  },
},
```

This duplication is deliberate. The manifest is **eager** — it is in the initial
bundle so the index, the search box and the canvas can list tools and decide
which ports may legally connect, none of which needs a line of the tool's actual
code. `registry.test.ts` loads every implementation for real and asserts the two
descriptions agree, so they cannot drift.

## 4. The loader entry

`src/features/registry/loader.ts`:

```ts
const LOADERS: Record<ToolId, () => Promise<{ readonly default: ErasedTool }>> = {
  // …
  'case-convert': () => import('@/tools/case-convert'),
};
```

The literal path matters: a bundler can only split a chunk it can see
statically, so `import('@/tools/' + id)` would either fail or pull every tool
into one chunk.

`Record<ToolId, …>` makes this map exhaustive — adding the manifest entry
without adding a loader is a compile error, not a runtime one.

## 5. Tests

`src/tools/case-convert/case-convert.test.ts`

Test the pure function directly. The registry, the ports and the option schema
are already covered generically; what is yours to prove is the behaviour.

```ts
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { convert } from './case';

describe('convert', () => {
  it.each([
    ['hello world', 'upper', 'HELLO WORLD'],
    ['Hello World', 'snake', 'hello_world'],
    ['hello world', 'kebab', 'hello-world'],
  ])('%s -> %s', (input, target, expected) => {
    expect(convert(input, target)).toBe(expected);
  });

  it('is idempotent', () => {
    // Property-based, because the interesting inputs are the ones nobody
    // thinks to write down: unicode, runs of separators, empty segments.
    fc.assert(
      fc.property(fc.string(), (text) => {
        const once = convert(text, 'snake');
        expect(convert(once, 'snake')).toBe(once);
      }),
    );
  });
});
```

## 6. The README

`src/tools/case-convert/README.md`

Every tool has one, next to the code. Not a description of what the buttons do
— the interesting part is what you decided and why: which unicode case-folding
rules you used, what happens to a string that is already snake_case, why title
case does not capitalise "of".

## Then

```bash
pnpm typecheck && pnpm test && pnpm build && pnpm bundle:check
```

`registry.test.ts` will tell you if the manifest and the implementation
disagree. `bundle:check` will tell you if your tool leaked into the initial
payload instead of becoming its own chunk.

The tool now appears in the index, in canvas search, in the palette, and can be
wired to anything whose ports are compatible — without any of those places
having been edited.

## What you did not have to do

- Register a route. `/tools/:toolId` is generic.
- Write any UI. `OptionField[]` is rendered by the shared runner and by the
  node inspector.
- Accept a file. Every unwired input port gets a file control on both routes,
  built from the port's own types and the tool's `maxInputBytes` — a `bytes`
  port takes any file, a text port takes a text-sniffed one and refuses the
  rest, and both refusals happen at the moment of selection. See
  [a file as an input](architecture.md#a-file-as-an-input).
- Write a worker message type. The protocol is generic over the tool.
- Handle cancellation, timeouts, size limits or progress. `execution` declares
  them and the engine enforces them.
- Think about caching. The cache key is derived from the tool id, the options,
  the typed input, the identity of any file chosen for a port, and the upstream
  keys.
