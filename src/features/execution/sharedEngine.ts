import { createDefaultEngine, type ExecutionEngine } from './engine';

/**
 * One engine, and therefore one worker, shared by the whole app.
 *
 * Created lazily on first use. Constructing the engine does NOT construct a
 * Worker - that happens on the first run - so this is safe to evaluate in a
 * test environment that has no Worker at all.
 *
 * Lives in its own module so both the single-tool runner and the pipeline can
 * reach it without importing each other.
 */
let shared: ExecutionEngine | null = null;

export function getSharedEngine(): ExecutionEngine {
  shared ??= createDefaultEngine();
  return shared;
}
