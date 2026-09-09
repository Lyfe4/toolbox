import { measureInputs } from '@/features/execution/protocol';
import { getManifestEntry } from '@/features/registry';
import type { InputPort, ToolInputs, ToolValue } from '@/features/registry/types';
import type { LoadedFile } from '@/lib/fileInput';

import { typedInputPorts } from './geometry';

import type { CanvasNode, GraphData } from './types';

/**
 * The two questions the canvas asks about a file input, in one place.
 *
 * Both are about a NODE rather than about a file, which is why neither belongs
 * in `lib/fileInput.ts` - that module knows about ports and files and nothing
 * about graphs.
 */

/**
 * What a node's OTHER inputs already weigh, for the size budget.
 *
 * `maxInputBytes` bounds a tool's whole input rather than one file - `diff`'s
 * README says 8 MB across both ports - so a second file has to be weighed
 * against the first, and against any typed text on a third port. Measured with
 * `measureInputs`, the very function the engine weighs the run with, so a file
 * accepted at selection cannot be refused at run time for its size.
 *
 * A port fed by a WIRE is deliberately not counted: what will arrive on it is
 * not known until the node above it has run, so counting nothing is the only
 * honest answer. That is the one case where a size refusal can still land at
 * run time, and it is the case where it could not have landed any earlier.
 */
export function otherInputBytes(
  node: CanvasNode,
  ports: readonly InputPort[],
  exceptPortId: string,
  attachments: Readonly<Record<string, LoadedFile>>,
): number {
  const others: Record<string, ToolValue> = {};

  for (const port of ports) {
    if (port.id === exceptPortId) continue;

    const attached = attachments[port.id];
    if (attached) {
      others[port.id] = attached.value;
      continue;
    }

    const typed = node.inputs[port.id] ?? '';
    if (typed !== '') others[port.id] = { type: 'text', text: typed };
  }

  return measureInputs(others satisfies ToolInputs);
}

/**
 * The input ports a file DROPPED ON THIS NODE could go to.
 *
 * Every unwired input port, and no filter on the port's types: every input in
 * the current set declares `text` or `bytes`, and both can come from a file -
 * a text-only port takes a text-sniffed one and refuses the rest, which
 * `sniffRejection` says at the moment of selection.
 *
 * A WIRED port is not a candidate, for the same reason it gets no editor: a
 * wire wins, so putting a file there would be putting it somewhere the run
 * would ignore.
 *
 * Returning a LIST rather than picking one is the point. With a single
 * candidate the drop is unambiguous and lands; with two - `diff`, the only
 * tool in the set with two inputs - "the file" is not a well-formed idea, and
 * the gesture hands over to the inspector rather than guessing. See Canvas.tsx.
 */
export function fileTargetPorts(graph: GraphData, node: CanvasNode): readonly InputPort[] {
  const unwired = new Set(typedInputPorts(graph, node));
  return getManifestEntry(node.toolId).inputs.filter((port) => unwired.has(port.id));
}
