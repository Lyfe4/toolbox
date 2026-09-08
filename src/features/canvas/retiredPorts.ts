/**
 * Ports that were renamed, and what they are called now.
 *
 * A port id is a persisted identifier. It is the key of `CanvasNode.inputs`,
 * it is two of the four fields of every edge, and it travels in a share link -
 * so renaming one is a breaking change to documents that already exist out in
 * the world, in the same way retiring a tool is. `retiredTools.ts` is the same
 * idea one level up, and this module is deliberately shaped like it:
 *
 * ONE MODULE, because four places need the same answer and they must not
 * drift - the persisted-graph migration, the share-link migration, and the
 * tests that prove both. A second copy of a rename table is a bug waiting for
 * whichever copy someone forgot to update.
 *
 * WHAT THE RENAMES WERE FOR, since a rename with no reason is pure cost:
 *
 * | Tool            | Was      | Is       | Why                                |
 * | --------------- | -------- | -------- | ---------------------------------- |
 * | `hash`          | `digest` | `output` | Every tool's first output is now   |
 * |                 |          |          | `output`, which makes "the first   |
 * |                 |          |          | port is the tool's answer" a       |
 * |                 |          |          | structural fact instead of a       |
 * |                 |          |          | per-tool lookup. `registry.test`   |
 * |                 |          |          | asserts it for every tool.         |
 * | `image-convert` | `info`   | `report` | The port declares                  |
 * |                 |          |          | `presentation: 'report'` and is    |
 * |                 |          |          | drawn by `ReportView`. Three names |
 * |                 |          |          | for one thing, none of them the    |
 * |                 |          |          | word that describes it.            |
 *
 * The LABELS a person reads changed in several more places, and none of those
 * needed a migration or appear here: a label is not an identity.
 */

/** Output port renames, by tool id. Old id -> current id. */
const RENAMED_OUTPUTS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  hash: { digest: 'output' },
  'image-convert': { info: 'report' },
};

/**
 * Input port renames, by tool id.
 *
 * EMPTY, AND THAT IS A FINDING RATHER THAN A GAP. The audit that produced the
 * table above looked at every input port in the set and renamed no id: the
 * convention was already sound - a tool with one input calls it `input`, and
 * the only tool with two names both of them (`original`, `changed`) - so the
 * only thing left to improve was the human LABEL, which is not an identity and
 * needs no migration.
 *
 * The mapping still exists, and is still applied on both routes, because the
 * alternative is discovering on the day an input port is renamed that half the
 * migration was never written. Its own test asserts the identity behaviour so
 * the empty case is a decision rather than an oversight.
 */
const RENAMED_INPUTS: Readonly<Record<string, Readonly<Record<string, string>>>> = {};

/** The current id of an output port, which is the same id unless it moved. */
export function currentOutputPortId(toolId: unknown, portId: unknown): unknown {
  if (typeof toolId !== 'string' || typeof portId !== 'string') return portId;
  return RENAMED_OUTPUTS[toolId]?.[portId] ?? portId;
}

/** The current id of an input port, which is the same id unless it moved. */
export function currentInputPortId(toolId: unknown, portId: unknown): unknown {
  if (typeof toolId !== 'string' || typeof portId !== 'string') return portId;
  return RENAMED_INPUTS[toolId]?.[portId] ?? portId;
}

/**
 * Rewrites the keys of a node's typed-in inputs onto their current ports.
 *
 * Untrusted input, like everything else read back from storage: a key that is
 * not a string, or a value that is not one, is passed through for the schema
 * to refuse rather than repaired here. Two old keys mapping onto one current
 * port keeps the FIRST, because a migration that silently picks the last of
 * two conflicting values is a migration nobody can reason about - and the pair
 * cannot arise from any table this module has ever held.
 */
export function migrateInputKeys(toolId: unknown, inputs: unknown): unknown {
  if (typeof inputs !== 'object' || inputs === null || Array.isArray(inputs)) return inputs;
  if (typeof toolId !== 'string') return inputs;

  const renames = RENAMED_INPUTS[toolId];
  if (renames === undefined) return inputs;

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(inputs as Record<string, unknown>)) {
    const target = renames[key] ?? key;
    if (!(target in out)) out[target] = value;
  }
  return out;
}
