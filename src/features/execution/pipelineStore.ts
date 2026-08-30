import { create } from 'zustand';

import type { GraphData, NodeId } from '@/features/canvas/types';
import type { ToolOutputs, ToolResult } from '@/features/registry/types';
import { counted } from '@/lib/plural';

import {
  CycleError,
  DEFAULT_CONCURRENCY,
  DEFAULT_MAX_NODES,
  idleState,
  runPipeline,
  type NodeRunState,
  type PipelineCache,
  type PipelineState,
  type PipelineSummary,
} from './graph';
import { getSharedEngine } from './sharedEngine';

import type { ExecuteOptions } from './engine';

/** How long typing must pause before the pipeline re-runs. */
export const RERUN_DEBOUNCE_MS = 300;

/** A run must last at least this long before its start is announced. */
const START_ANNOUNCE_MS = 400;

export interface PipelineAnnouncement {
  readonly text: string;
  readonly seq: number;
}

export interface PipelineStore {
  readonly states: PipelineState;
  readonly running: boolean;
  readonly summary: PipelineSummary | null;
  readonly announcement: PipelineAnnouncement;
  /** Injectable so tests can drive the pipeline without a Worker. */
  readonly execute: (options: ExecuteOptions) => Promise<ToolResult<ToolOutputs>>;

  readonly run: (graph: GraphData) => Promise<void>;
  readonly schedule: (graph: GraphData) => void;
  readonly cancel: () => void;
  readonly reset: () => void;
  readonly stateFor: (nodeId: NodeId) => NodeRunState;
}

export const usePipelineStore = create<PipelineStore>()((set, get) => {
  /*
   * The result cache lives outside reactive state on purpose. It is keyed by
   * node id and holds whole outputs - including multi-megabyte byte arrays -
   * and nothing renders from it directly, so putting it in the store would
   * only mean notifying every subscriber whenever a cache entry changed.
   */
  const cache: PipelineCache = new Map();

  let debounceTimer: number | null = null;
  let startTimer: number | null = null;
  let controller: AbortController | null = null;
  let runToken = 0;

  const announce = (text: string): void => {
    set((state) => ({ announcement: { text, seq: state.announcement.seq + 1 } }));
  };

  const clearStartTimer = (): void => {
    if (startTimer !== null) window.clearTimeout(startTimer);
    startTimer = null;
  };

  const clearTimers = (): void => {
    if (debounceTimer !== null) window.clearTimeout(debounceTimer);
    if (startTimer !== null) window.clearTimeout(startTimer);
    debounceTimer = null;
    startTimer = null;
  };

  return {
    states: {},
    running: false,
    summary: null,
    announcement: { text: '', seq: 0 },
    execute: (options) => getSharedEngine().execute(options),

    stateFor: (nodeId) => get().states[nodeId] ?? idleState(),

    run: async (graph) => {
      controller?.abort();
      controller = new AbortController();
      const signal = controller.signal;

      runToken += 1;
      const token = runToken;

      set({ running: true });

      /*
       * Only announce the START if the run is still going after a moment.
       * A pipeline that finishes in 5ms would otherwise fire "running" and
       * "finished" back to back on every keystroke, which is unusable.
       */
      clearStartTimer();
      startTimer = window.setTimeout(() => {
        if (get().running && runToken === token) announce('Running pipeline.');
      }, START_ANNOUNCE_MS);

      let summary: PipelineSummary;
      try {
        summary = await runPipeline(graph, {
          execute: get().execute,
          concurrency: DEFAULT_CONCURRENCY,
          maxNodes: DEFAULT_MAX_NODES,
          signal,
          cache,
          onUpdate: (nodeId, state) => {
            // A superseded run must not paint over the newer one's results.
            if (runToken !== token) return;
            set((current) => ({ states: { ...current.states, [nodeId]: state } }));
          },
        });
      } catch (error) {
        clearStartTimer();
        if (runToken !== token) return;
        set({ running: false });

        // A cycle here is a bug, not a user error: connections are checked
        // before they are made. Surface it loudly rather than swallowing it.
        announce(
          error instanceof CycleError
            ? 'Pipeline could not run: the graph contains a cycle.'
            : 'Pipeline could not run.',
        );
        return;
      }

      clearStartTimer();
      if (runToken !== token) return;

      set({ running: false, summary, states: summary.states });

      if (summary.cancelled) {
        announce('Pipeline cancelled.');
        return;
      }

      const parts: string[] = [];
      if (summary.ran > 0) parts.push(`${summary.ran.toString()} run`);
      if (summary.cached > 0) parts.push(`${summary.cached.toString()} cached`);
      if (summary.blocked > 0) parts.push(`${summary.blocked.toString()} blocked`);

      if (summary.failed > 0) {
        announce(
          `Pipeline finished with ${counted(summary.failed, 'failure')}. ${parts.join(', ')}.`,
        );
      } else if (parts.length > 0) {
        announce(`Pipeline finished. ${parts.join(', ')}.`);
      }
    },

    schedule: (graph) => {
      // Debounced: typing into a node should not launch a run per keystroke.
      if (debounceTimer !== null) window.clearTimeout(debounceTimer);
      debounceTimer = window.setTimeout(() => {
        debounceTimer = null;
        void get().run(graph);
      }, RERUN_DEBOUNCE_MS);
    },

    cancel: () => {
      clearTimers();
      controller?.abort();
      controller = null;
      set({ running: false });
    },

    reset: () => {
      clearTimers();
      controller?.abort();
      controller = null;
      cache.clear();
      set({ states: {}, running: false, summary: null });
    },
  };
});
