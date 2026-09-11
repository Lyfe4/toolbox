import { create } from 'zustand';

import type { ToolValue } from '@/features/registry/types';
import type { LoadedFile } from '@/lib/fileInput';

import type { FileInputRef, NodeId } from './types';

/**
 * THE BYTES BEHIND A NODE'S FILE INPUT.
 *
 * A fifth store, and it is here rather than in `graphStore` for the same reason
 * execution status is in `pipelineStore`: it is not part of the document. The
 * document records that a port was fed a file and what it was called; this
 * holds the file itself, for the length of the session and no longer.
 *
 * WHY NOT PERSIST IT. A `File` cannot be JSON-serialised, so it cannot go in
 * the `localStorage` key the graph lives in; IndexedDB could hold one, and that
 * would mean a canvas silently carrying somebody's 60 MB photograph across
 * sessions, plus a second store to validate, migrate and garbage-collect - for
 * a value the user still has on disk. And it must never go in a share
 * link at any size. So a file is session state, deliberately, and the reload
 * path says so out loud instead of failing quietly.
 *
 * WHAT IS HELD IS THE BUILT VALUE, and for a `bytes` port that value is a
 * REFERENCE TO THE FILE rather than its contents. It was validated against its
 * port at selection - see `loadFileForPort` - so nothing downstream can be
 * handed a file its port cannot use, and no run has to decode anything.
 *
 * That reference is the difference between this store costing a session's
 * worth of chosen files and costing a session's worth of pointers. Choosing a
 * 320 MB video used to put 320 MB here until the tab closed; it now costs the
 * 4 kB head the sniff already read. A port that needs TEXT still holds the
 * decoded string, which is the honest shape of that case - decoding is a pass
 * over the whole file, and the tools with a text-only document port declare
 * limits in the kilobytes.
 *
 * ONE FILE CAN FEED SEVERAL NODES. The value is handed out by reference and the
 * pipeline executes with `ownership: 'borrow'`, so each consumer gets a
 * structured clone - and where the value is a blob, the clone is a second
 * reference to the same immutable bytes rather than a copy of them. A blob
 * cannot be detached, so the failure this rule was written to prevent is not
 * available to it. `fanout.test.ts` holds the line for wired outputs;
 * `attachments.test.ts` holds it for a file, and reads every consumer's value
 * rather than the first.
 */

/** Node id -> port id -> the file on that port. */
export type AttachmentMap = Readonly<Record<NodeId, Readonly<Record<string, LoadedFile>>>>;

export interface AttachmentStore {
  readonly files: AttachmentMap;
  /**
   * Stores a file and returns the reference the DOCUMENT should record.
   *
   * The two halves are set together and deliberately in this order: the store
   * write happens first, so there is no render in which the graph names a file
   * the store cannot produce.
   */
  readonly attach: (nodeId: NodeId, portId: string, loaded: LoadedFile) => FileInputRef;
  readonly detach: (nodeId: NodeId, portId: string) => void;
  /** Every file on every port. Used when a whole graph is replaced. */
  readonly resetAttachments: () => void;
  readonly attachmentFor: (nodeId: NodeId, portId: string) => LoadedFile | undefined;
  /** The value for a port, or undefined. This is what the engine reads. */
  readonly valueFor: (nodeId: NodeId, portId: string) => ToolValue | undefined;
}

/**
 * Monotonic, module-scoped, and never reset.
 *
 * It only has to be unique within one page load. A token restored from storage
 * points at nothing, and cannot collide its way into a wrong answer: the
 * pipeline cache only ever holds entries for keys computed while a file was
 * actually attached, so a stale token can cause a redundant re-run and never a
 * stale hit. Asserted by `attachments.test.ts`.
 */
let nextToken = 1;

export const useAttachmentStore = create<AttachmentStore>()((set, get) => ({
  files: {},

  attach: (nodeId, portId, loaded) => {
    const token = nextToken;
    nextToken += 1;

    set((state) => ({
      files: {
        ...state.files,
        [nodeId]: { ...state.files[nodeId], [portId]: loaded },
      },
    }));

    return { name: loaded.file.name, size: loaded.file.size, token };
  },

  detach: (nodeId, portId) => {
    set((state) => {
      const forNode = state.files[nodeId];
      if (!forNode || !(portId in forNode)) return state;

      /*
       * Rebuilt by filtering rather than by deleting a computed key, which the
       * lint rules refuse - and rightly, since `delete` on a record indexed by
       * a runtime string is one typo away from removing the wrong entry.
       */
      const rest = Object.fromEntries(Object.entries(forNode).filter(([id]) => id !== portId));

      // The node's own entry goes when its last port does, so an empty record
      // per node cannot accumulate for the length of a session.
      const files = Object.fromEntries(Object.entries(state.files).filter(([id]) => id !== nodeId));
      if (Object.keys(rest).length > 0) files[nodeId] = rest;

      return { files };
    });
  },

  /*
   * DELETING A NODE DOES NOT DROP ITS FILE, and that is a choice.
   *
   * Undo restores a deleted node whole - its options, its wires and its typed
   * text all come back - and a file that did not would make undo a partial
   * repair of the user's own data. The cost is that a deleted node's bytes are
   * retained until the graph is replaced or the tab closes, bounded by the
   * tool's own `maxInputBytes` and by the user's own actions. Losing the file
   * is the worse half of that trade.
   */
  resetAttachments: () => {
    set({ files: {} });
  },

  attachmentFor: (nodeId, portId) => get().files[nodeId]?.[portId],

  valueFor: (nodeId, portId) => get().files[nodeId]?.[portId]?.value,
}));
