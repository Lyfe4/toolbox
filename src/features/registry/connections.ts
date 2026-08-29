import { canConnect, type InputPort, type OutputPort } from './types';

import type { ToolManifestEntry } from './manifest';

/**
 * A legal wire between two tools.
 *
 * This is the foundation the canvas will build on: given two tools it can ask
 * which of their ports may be joined, without loading either tool's code.
 */
export interface PortConnection {
  readonly fromPort: OutputPort;
  readonly toPort: InputPort;
}

/** Every output/input pair whose declared types overlap. */
export function findConnections(
  from: ToolManifestEntry,
  to: ToolManifestEntry,
): readonly PortConnection[] {
  const connections: PortConnection[] = [];

  for (const fromPort of from.outputs) {
    for (const toPort of to.inputs) {
      if (canConnect(fromPort, toPort)) connections.push({ fromPort, toPort });
    }
  }

  return connections;
}

/** True when at least one wire is possible from `from` into `to`. */
export function canToolsConnect(from: ToolManifestEntry, to: ToolManifestEntry): boolean {
  return findConnections(from, to).length > 0;
}

/** The tools whose inputs can accept something this tool produces. */
export function downstreamCandidates(
  from: ToolManifestEntry,
  all: readonly ToolManifestEntry[],
): readonly ToolManifestEntry[] {
  return all.filter((candidate) => canToolsConnect(from, candidate));
}
