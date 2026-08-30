import type { ExecutionMeta, InputPort, OutputPort, ToolCategory } from './types';

/**
 * Eager metadata for every tool.
 *
 * This file is imported by the main bundle; tool IMPLEMENTATIONS are not. That
 * split is the whole point: the index page, the search box and (later) the
 * canvas need to list tools and work out which ports can legally connect, and
 * none of that requires a single line of a tool's actual code.
 *
 * The duplication with each tool's own declaration is deliberate and guarded -
 * registry.test.ts loads every implementation and asserts the two agree.
 */
export interface ToolManifestEntry {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly category: ToolCategory;
  /** Extra search terms that do not appear in the name or summary. */
  readonly keywords: readonly string[];
  readonly inputs: readonly InputPort[];
  readonly outputs: readonly OutputPort[];
  /**
   * Also eager, because the execution engine has to choose worker vs main
   * thread and enforce the input-size limit BEFORE it fetches the tool. Kept
   * in step with the implementation by registry.test.ts.
   */
  readonly execution: ExecutionMeta;
  /**
   * Option keys holding user secrets. Eager, unlike the rest of the tool,
   * because share links are built without loading a single tool module and the
   * encoder has to know what to leave out before it can do that.
   */
  readonly secretOptionKeys?: readonly string[];
}

/**
 * `as const satisfies ...` does two jobs at once: `satisfies` type-checks each
 * entry against ToolManifestEntry, while `as const` keeps the literal types so
 * `ToolId` below is a union of the actual id strings rather than plain string.
 */
export const TOOL_MANIFEST = [
  {
    id: 'base64',
    name: 'Base64',
    summary: 'Encode text or files to base64, and decode base64 back to bytes.',
    category: 'encoding',
    keywords: ['b64', 'atob', 'btoa', 'url-safe', 'data uri', 'jwt'],
    inputs: [
      {
        id: 'input',
        label: 'Input',
        types: ['text', 'bytes'],
        required: true,
        description: 'Text to encode, base64 to decode, or a dropped file.',
      },
    ],
    outputs: [{ id: 'output', label: 'Output', types: ['text', 'bytes'] }],
    execution: {
      strategy: 'worker',
      requiresWasm: false,
      wasmModules: [],
      requiresOffscreenCanvas: false,
      reportsProgress: false,
      timeoutMs: 15_000,
      maxInputBytes: 32 * 1024 * 1024,
    },
  },
  {
    id: 'structured-data',
    name: 'Structured data',
    summary: 'Convert between JSON, YAML, CSV and TSV, with auto-detection.',
    category: 'data',
    keywords: ['json', 'yaml', 'csv', 'tsv', 'convert', 'format', 'parse'],
    inputs: [
      {
        id: 'input',
        label: 'Document',
        types: ['text', 'json', 'bytes'],
        required: true,
        description: 'Paste a document, drop a file, or wire in data from another tool.',
      },
    ],
    outputs: [
      { id: 'output', label: 'Converted', types: ['text'] },
      {
        id: 'data',
        label: 'Parsed data',
        types: ['json'],
        description: 'The parsed structure, for wiring into another tool.',
      },
    ],
    execution: {
      strategy: 'worker',
      requiresWasm: false,
      wasmModules: [],
      requiresOffscreenCanvas: false,
      reportsProgress: false,
      timeoutMs: 15_000,
      maxInputBytes: 16 * 1024 * 1024,
    },
  },
  {
    id: 'hash',
    name: 'Hash',
    summary: 'MD5, SHA-1, SHA-256, SHA-384 and SHA-512 digests of text or files.',
    category: 'hashing',
    keywords: ['md5', 'sha', 'sha1', 'sha256', 'digest', 'checksum', 'fingerprint'],
    inputs: [
      {
        id: 'input',
        label: 'Input',
        types: ['text', 'bytes'],
        required: true,
        description: 'Text or a file to fingerprint.',
      },
    ],
    outputs: [{ id: 'digest', label: 'Digest', types: ['text'] }],
    execution: {
      strategy: 'worker',
      requiresWasm: false,
      wasmModules: [],
      requiresOffscreenCanvas: false,
      reportsProgress: false,
      timeoutMs: 30_000,
      maxInputBytes: 64 * 1024 * 1024,
    },
  },
  {
    id: 'jwt-decode',
    name: 'JWT',
    summary: 'Decode a JSON Web Token, and verify its signature when you supply the key.',
    category: 'encoding',
    keywords: ['jwt', 'jws', 'token', 'bearer', 'claims', 'signature', 'hs256', 'rs256'],
    inputs: [
      {
        id: 'input',
        label: 'Token',
        types: ['text'],
        required: true,
        description: 'A compact JWT: header.payload.signature.',
      },
    ],
    outputs: [
      {
        id: 'output',
        label: 'Decoded',
        types: ['json'],
        description: 'Signature verdict first, then the header and payload.',
      },
    ],
    secretOptionKeys: ['key'],
    execution: {
      strategy: 'worker',
      requiresWasm: false,
      wasmModules: [],
      requiresOffscreenCanvas: false,
      reportsProgress: false,
      timeoutMs: 10_000,
      maxInputBytes: 256 * 1024,
    },
  },
  {
    id: 'diff',
    name: 'Diff',
    summary: 'Compare two texts line by line, with word-level highlighting.',
    category: 'text',
    keywords: ['compare', 'patch', 'unified', 'changes', 'delta'],
    inputs: [
      {
        id: 'original',
        label: 'Original',
        types: ['text', 'json', 'bytes'],
        required: true,
        description: 'The text to compare against.',
      },
      {
        id: 'changed',
        label: 'Changed',
        types: ['text', 'json', 'bytes'],
        required: true,
        description: 'The text to compare.',
      },
    ],
    outputs: [
      {
        id: 'output',
        label: 'Unified patch',
        types: ['text'],
        description: 'Standard unified diff, ready to paste into a review or apply.',
      },
      {
        id: 'changes',
        label: 'Changes',
        types: ['json'],
        description: 'Row-by-row structure, rendered here as an accessible diff.',
        presentation: 'diff',
      },
    ],
    execution: {
      strategy: 'worker',
      requiresWasm: false,
      wasmModules: [],
      requiresOffscreenCanvas: false,
      reportsProgress: false,
      timeoutMs: 20_000,
      maxInputBytes: 8 * 1024 * 1024,
    },
  },
  {
    id: 'regex-tester',
    name: 'Regex',
    summary: 'Test a regular expression against text, with groups and replacement.',
    category: 'text',
    keywords: ['regexp', 'pattern', 'match', 'replace', 'capture group'],
    inputs: [
      {
        id: 'input',
        label: 'Subject',
        types: ['text'],
        required: true,
        description: 'The text to search. The pattern itself is an option.',
      },
    ],
    outputs: [
      {
        id: 'output',
        label: 'Result',
        types: ['text'],
        description: 'The replaced text, or a list of matches with their offsets.',
      },
      { id: 'matches', label: 'Matches', types: ['json'] },
    ],
    execution: {
      strategy: 'worker',
      requiresWasm: false,
      wasmModules: [],
      requiresOffscreenCanvas: false,
      reportsProgress: false,
      timeoutMs: 2_000,
      timeoutMessage:
        'That pattern is too slow on this input and was stopped. It is almost certainly backtracking catastrophically - nested quantifiers like (a+)+ are the usual cause.',
      maxInputBytes: 4 * 1024 * 1024,
    },
  },
  {
    id: 'color-convert',
    name: 'Colour',
    summary: 'Convert between hex, rgb(), hsl() and oklch(), with contrast checks.',
    category: 'colour',
    keywords: ['color', 'colour', 'hex', 'rgb', 'hsl', 'oklch', 'contrast', 'wcag', 'a11y'],
    inputs: [
      {
        id: 'input',
        label: 'Colour',
        types: ['text', 'color'],
        required: true,
        description: '#3b82f6, rgb(59 130 246), hsl(217 91% 60%) or oklch(0.62 0.19 259).',
      },
    ],
    outputs: [
      { id: 'output', label: 'Converted', types: ['text'] },
      {
        id: 'swatch',
        label: 'Colour',
        types: ['color'],
        description: 'The parsed colour, previewed with its contrast against black and white.',
      },
      {
        id: 'all',
        label: 'Every notation',
        types: ['json'],
        description: 'The same colour in all four notations, for wiring into another tool.',
      },
    ],
    execution: {
      strategy: 'main',
      requiresWasm: false,
      wasmModules: [],
      requiresOffscreenCanvas: false,
      reportsProgress: false,
      timeoutMs: 5_000,
      maxInputBytes: 4 * 1024,
    },
  },
  {
    id: 'image-convert',
    name: 'Image',
    summary: 'Convert and resize images between PNG, JPEG and WebP.',
    category: 'encoding',
    keywords: ['png', 'jpeg', 'jpg', 'webp', 'resize', 'compress', 'convert', 'optimise'],
    inputs: [
      {
        id: 'input',
        label: 'Image',
        types: ['bytes'],
        required: true,
        description: 'A PNG, JPEG, GIF or WebP file. The format is read from the bytes.',
      },
    ],
    outputs: [
      { id: 'output', label: 'Converted image', types: ['bytes'] },
      {
        id: 'info',
        label: 'Details',
        types: ['json'],
        description: 'Dimensions and sizes before and after.',
      },
    ],
    execution: {
      strategy: 'worker',
      requiresWasm: false,
      wasmModules: [],
      requiresOffscreenCanvas: true,
      reportsProgress: false,
      timeoutMs: 60_000,
      maxInputBytes: 64 * 1024 * 1024,
    },
  },
  {
    id: 'markdown',
    name: 'Markdown',
    summary: 'Convert Markdown to HTML and HTML back to Markdown, with GitHub Flavoured syntax.',
    category: 'text',
    keywords: ['md', 'gfm', 'commonmark', 'readme', 'render', 'rich text', 'html'],
    inputs: [
      {
        id: 'input',
        label: 'Input',
        types: ['text'],
        required: true,
        description: 'Markdown, or HTML - whichever the direction expects.',
      },
    ],
    outputs: [
      {
        id: 'output',
        label: 'Converted',
        types: ['text'],
        description: 'HTML, or Markdown, depending on the direction.',
      },
      {
        id: 'rendered',
        label: 'Rendered HTML',
        types: ['text'],
        description: 'Always HTML, sanitised. This is what the preview shows.',
        presentation: 'html',
      },
    ],
    execution: {
      strategy: 'worker',
      requiresWasm: false,
      wasmModules: [],
      requiresOffscreenCanvas: false,
      reportsProgress: false,
      timeoutMs: 15_000,
      maxInputBytes: 4 * 1024 * 1024,
    },
  },
  {
    id: 'html-text',
    name: 'HTML to text',
    summary: 'Turn HTML into Markdown, or strip it down to plain text.',
    category: 'text',
    keywords: ['strip tags', 'plain', 'markdown', 'scrape', 'clean', 'unhtml'],
    inputs: [
      {
        id: 'input',
        label: 'HTML',
        types: ['text'],
        required: true,
        description: 'Any HTML fragment. It is sanitised before anything reads it.',
      },
    ],
    outputs: [
      {
        id: 'output',
        label: 'Converted',
        types: ['text'],
        description: 'Markdown or plain text, depending on the mode.',
      },
    ],
    execution: {
      strategy: 'worker',
      requiresWasm: false,
      wasmModules: [],
      requiresOffscreenCanvas: false,
      reportsProgress: false,
      timeoutMs: 15_000,
      maxInputBytes: 4 * 1024 * 1024,
    },
  },
] as const satisfies readonly ToolManifestEntry[];

/** The union of every tool id: 'base64' | 'diff' | 'hash' | ... */
export type ToolId = (typeof TOOL_MANIFEST)[number]['id'];

const BY_ID = new Map<string, ToolManifestEntry>(TOOL_MANIFEST.map((entry) => [entry.id, entry]));

export function getManifestEntry(id: ToolId): ToolManifestEntry {
  const entry = BY_ID.get(id);
  // Unreachable for a valid ToolId, but the map lookup is still `| undefined`.
  if (!entry) throw new Error(`No tool in the manifest with id "${id}"`);
  return entry;
}

/** Narrows an arbitrary string (a URL segment, say) to a known tool id. */
export function isToolId(value: string): value is ToolId {
  return BY_ID.has(value);
}

/**
 * Case-insensitive search across name, summary, category and keywords.
 * Returns everything when the query is blank, so the index page can use it
 * unconditionally.
 */
export function searchTools(
  query: string,
  category: ToolCategory | 'all' = 'all',
): readonly ToolManifestEntry[] {
  const needle = query.trim().toLowerCase();

  return TOOL_MANIFEST.filter((entry) => {
    if (category !== 'all' && entry.category !== category) return false;
    if (needle === '') return true;

    return (
      entry.name.toLowerCase().includes(needle) ||
      entry.summary.toLowerCase().includes(needle) ||
      entry.category.includes(needle) ||
      entry.keywords.some((keyword) => keyword.includes(needle))
    );
  });
}
