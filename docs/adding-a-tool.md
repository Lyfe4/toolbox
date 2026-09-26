# Adding a tool

A complete worked example: a tool that converts text between cases. Small
enough to read in one go, and it touches every part of the tool itself —
options, a schema, a port, the manifest, the loader, tests and a README.

**The tool is five files and two edits; getting it merged is more.** This page
used to stop at the tool and say so in its first line, and the timestamp round
measured what that left out by following it literally: the closing command
below found eight failures on its first run, in files this page never named,
and a grep afterwards found ten more sentences the gates cannot see. Sections 1
to 6 are the tool. [The rest of the chain](#7-the-rest-of-the-chain) is
everything else, sorted by which kind of tool needs it, and
[Then](#then) is the command that actually has to pass.

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

`ports.test.ts` asserts most of these for every tool at once, so a new tool that
breaks one fails the suite rather than the reviewer's memory; the two that it
holds only for a named list are marked. (This paragraph used to say all of
them, for every tool.) The reasoning for each is in
[architecture.md](architecture.md#the-conventions-and-what-each-one-is-worth).

- **The first output is `output`.** A node summarises its first declared output
  as "the tool's answer", and that only means anything if the set agrees.
- **If that answer is a serialised document, say what measures it.** A node
  prints a measurement, and the rule for `text` — its first non-empty line — is
  right for prose and is syntax for everything else: pretty-printed JSON
  summarised as `[` and every unified patch as `--- original`. If your tool
  writes its answer out from a value it also puts on another port, name that
  port with `measuredBy` and the node prints its summary instead. See
  [architecture.md](architecture.md#a-summary-that-could-not-tell-two-results-apart).
  _Not generic:_ `ports.test.ts` checks that every `measuredBy` names a real,
  text-only, unmeasured port, and pins the exact list of the three that declare
  one — so adding one means editing that list, and leaving one out fails
  nothing.
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
  takes a short literal (a token, a colour) does not. _Not generic:_ the
  assertion names the six tools whose ports read a document, so a new one is
  held to it only once it is added to that list.
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
  outputs: [
    { id: 'output', label: 'Converted', types: ['text'],
      description: 'The text, in the chosen case.' },
  ],
  execution: {
    strategy: 'main', requiresOffscreenCanvas: false,
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
  ] as const)('%s -> %s', (input, target, expected) => {
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

## 7. The rest of the chain

**Every tool** needs these, and none of them is found by the compiler:

- **The counts.** `vite/docClaims.test.ts` holds every sentence that states how
  many tools there are, in any of the phrasings its `COUNTS` table lists, to the
  number of directories under `src/tools`, in every document and every comment.
  Adding a tool fails it in eight places, one of them the cold open's own
  sentence in `index.html`, which is the first thing a visitor reads. Its
  patterns catch the present-tense phrasings; a count phrased any other way is
  caught by nothing - the timestamp round found ten - so after fixing the eight,
  search for the old number spelled out.
- **The lists the gates do not read.** The README's table of tools and its
  table of what each conversion is held to; the port-set table in
  [architecture.md](architecture.md#the-whole-set-as-it-stands); and the
  verification skill's list of tool ids in its `SKILL.md`. Its probes compare
  the live `/tools` page with the manifest itself, so they need no edit.
- **A name in backticks must exist.** In a document or a code comment, the doc
  gate refuses a backticked identifier the code does not define - somebody
  else's (a Go function, a specification's abstract operation) included. Write
  it plain, or add it to the gate's exemption table with a reason.
- **A category** is an entry in `TOOL_CATEGORIES`, which is shared: every
  entry must hold a tool, so a new one is a decision rather than a line.

**A tool that can lose something** - it declares a `report` port:

- `resultSummary.test.ts` names every tool with a report port, and
  `notePorts.test.ts` needs a run in `LOSSY_RUNS` that really loses something
  for each. Both fail until the new tool is added, which is the point.
- **Each loss is a row of the loss corpus**,
  [`spec/loss-corpus.json`](../src/features/registry/spec/loss-corpus.json), with a
  document of the same shape that loses nothing. `lossCorpus.test.ts` runs it,
  and prints the replacement for the block in
  [conversion-matrix.md](conversion-matrix.md#the-corpus-the-ratio-and-why-it-is-not-a-number-any-more)
  when it fails - paste it. `checkLossCorpus` drives every row in two engines
  with no edit to the harness, within two limits that `lossCorpus.test.ts`
  checks and the corpus file's own `howToAddACase` repeats:
  - **The answer must be a text box labelled `Converted`.** The harness reads
    it as `<Tool name> Converted`, as a text box's value. A tool whose first
    output is not text, has a view of its own, or is labelled anything else
    cannot have a row until the harness learns to read it - relabelling a port
    to fit is not the fix. This is an accident of the four tools that had rows,
    kept as a stated limit. Four of the eight tools with a report port are
    outside it today - base64 (`Result`), jwt-decode (the verdict view),
    image-convert and video-remux (bytes) - so none of their losses can be a
    row.
  - **`choose` only drives a select.** An option typed into a text field has to
    be carried in the row's input. Deliberate enough: every option a loss has
    depended on so far is a select, and a typed one would need the harness to
    know which control it is, which the page does not say.
- **Warn is a promise.** A `warn` note is something that went in and did not
  come out, and it is printed on the node's face; everything else is `info`.

**A tool that converts** needs a section in the
[conversion matrix](conversion-matrix.md), with the evidence for each verdict,
and the evidence is an external reference: a specification's own vectors, or
another implementation run by a script in `scripts/` and committed as a
fixture. A generator that has to convert something itself checks its own output
before writing. A number past 2^53 in a fixture is a string, or JavaScript
reads it rounded - the timestamp oracle had that on its first run.

**A tool whose answer depends on the engine** - layout, a worker, an encoder,
`Intl` data - needs a section in `scripts/cross-browser-check.mjs`, added to
`SECTIONS`, and CONTRIBUTING's count of the section names goes up by one.

**A tool whose port reads a document** is added to the named list in
`ports.test.ts` that holds those ports to accepting `bytes`; one whose first
output is a serialised document declares `measuredBy`, and that list is named
too.

## Then

The six gates, and then the harness - not the four this page used to list:

```bash
pnpm typecheck && pnpm lint && pnpm format:check && pnpm test && pnpm build && pnpm bundle:check
pnpm check:browsers
```

`registry.test.ts` will tell you if the manifest and the implementation
disagree. `bundle:check` will tell you if your tool leaked into the initial
payload instead of becoming its own chunk. `check:browsers` needs the network
and an idle machine; see [CONTRIBUTING](../CONTRIBUTING.md#three-more-that-are-not-in-ci).
Record the round in [test-findings.md](test-findings.md).

The tool then appears in the index, in canvas search, in the palette, and can
be wired to anything whose ports are compatible — without any of those places
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
- Write a harness check for a loss. A corpus row is driven in two engines, on
  the tool page and on a canvas node, by the next run.
