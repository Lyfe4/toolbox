import type { ToolId } from './manifest';
import type { ErasedTool } from './types';

/**
 * Lazy tool loading: one chunk per directory under src/tools.
 *
 * `import.meta.glob` is expanded by the bundler, at build time, into one
 * literal `import()` per matching file - which is what lets it split each tool
 * into a chunk of its own, exactly as the hand-written
 * `import('@/tools/base64')` entries this replaced did. What it adds is that it
 * cannot miss a directory. The hand-written list was one more line adding a
 * tool had to remember, and the compile error that caught a missing one came
 * from `Record<ToolId, ...>`; now a missing loader is impossible for any
 * directory that has an `index.ts`, and `registry.test.ts` holds both
 * directions - every manifest id has a loader, every loader has a manifest id -
 * and that a directory's name is its tool's id.
 */
const MODULES = import.meta.glob<{ readonly default: ErasedTool }>('../../tools/*/index.ts');

/** Keyed by directory name, which the registry test holds to the tool's id. */
const LOADERS = new Map(
  Object.entries(MODULES).map(([path, load]) => [path.split('/').at(-2) ?? '', load]),
);

/** Resolved tools, so switching back to a tool does not re-await the import. */
const cache = new Map<ToolId, ErasedTool>();

export async function loadTool(id: ToolId): Promise<ErasedTool> {
  const cached = cache.get(id);
  if (cached) return cached;

  const load = LOADERS.get(id);
  // Unreachable while registry.test.ts passes: every manifest id has a directory.
  if (load === undefined) throw new Error(`No tool directory for "${id}"`);
  const module = await load();
  cache.set(id, module.default);
  return module.default;
}

/** Every directory under src/tools with an `index.ts`. Used by the registry test. */
export function loadableToolIds(): readonly string[] {
  return [...LOADERS.keys()];
}
