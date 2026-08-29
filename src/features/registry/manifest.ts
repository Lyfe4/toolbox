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
      reportsProgress: false,
      timeoutMs: 30_000,
      maxInputBytes: 64 * 1024 * 1024,
    },
  },
] as const satisfies readonly ToolManifestEntry[];

/** The union of every tool id: 'base64' | 'structured-data'. */
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
