import { base64Meta } from '@/tools/base64/meta';
import { colorConvertMeta } from '@/tools/color-convert/meta';
import { diffMeta } from '@/tools/diff/meta';
import { hashMeta } from '@/tools/hash/meta';
import { imageConvertMeta } from '@/tools/image-convert/meta';
import { jwtDecodeMeta } from '@/tools/jwt-decode/meta';
import { regexTesterMeta } from '@/tools/regex-tester/meta';
import { structuredDataMeta } from '@/tools/structured-data/meta';
import { textConvertMeta } from '@/tools/text-convert/meta';
import { timestampMeta } from '@/tools/timestamp/meta';
import { videoRemuxMeta } from '@/tools/video-remux/meta';

import type { ToolCategory, ToolManifestEntry } from './types';

export type { ToolManifestEntry } from './types';

/**
 * Every tool, in the order the index and the palette list them.
 *
 * This file is imported by the main bundle; tool IMPLEMENTATIONS are not. That
 * split is the whole point: the index page, the search box and the canvas need
 * to list tools and work out which ports can legally connect, and none of that
 * requires a single line of a tool's actual code.
 *
 * Each entry is the tool's own `meta.ts`, which its `index.ts` spreads into
 * its definition - one object, not a copy of one. What this list adds is the
 * ORDER, which is an editorial decision a directory listing cannot make, and a
 * literal `ToolId` union below. `registry.test.ts` fails if a directory under
 * src/tools has no entry here, or an entry has no directory.
 *
 * `as const satisfies ...` does two jobs at once: `satisfies` type-checks each
 * entry against ToolManifestEntry, while `as const` keeps the literal types so
 * `ToolId` is a union of the actual id strings rather than plain string.
 */
export const TOOL_MANIFEST = [
  base64Meta,
  structuredDataMeta,
  hashMeta,
  jwtDecodeMeta,
  diffMeta,
  regexTesterMeta,
  colorConvertMeta,
  imageConvertMeta,
  videoRemuxMeta,
  textConvertMeta,
  timestampMeta,
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
