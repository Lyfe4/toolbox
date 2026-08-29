import type { ToolId } from './manifest';
import type { ErasedTool } from './types';

/**
 * Lazy tool loading.
 *
 * Each entry is a separate `import()` with a literal path. That literalness is
 * load-bearing: a bundler can only split a chunk it can see statically, so
 * `import('@/tools/' + id)` would either fail or drag every tool into one
 * chunk. `Record<ToolId, ...>` makes the map exhaustive - adding an id to the
 * manifest without adding a loader here is a compile error.
 */
const LOADERS: Record<ToolId, () => Promise<{ readonly default: ErasedTool }>> = {
  base64: () => import('@/tools/base64'),
  'structured-data': () => import('@/tools/structured-data'),
  hash: () => import('@/tools/hash'),
};

/** Resolved tools, so switching back to a tool does not re-await the import. */
const cache = new Map<ToolId, ErasedTool>();

export async function loadTool(id: ToolId): Promise<ErasedTool> {
  const cached = cache.get(id);
  if (cached) return cached;

  const module = await LOADERS[id]();
  cache.set(id, module.default);
  return module.default;
}

/** Every tool id that has a loader. Used by the registry test. */
export function loadableToolIds(): readonly ToolId[] {
  return Object.keys(LOADERS) as readonly ToolId[];
}
