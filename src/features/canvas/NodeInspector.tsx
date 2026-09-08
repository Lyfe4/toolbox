import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

import { Button } from '@/components/Button';
import { CloseIcon } from '@/components/Icon';
import { TextArea } from '@/components/TextArea';
import { useToast } from '@/components/Toast';
import type { NodeRunState } from '@/features/execution/graph';
import { getManifestEntry, loadTool } from '@/features/registry';
import type { ErasedTool, InputPort } from '@/features/registry/types';
import { ErrorReport, OptionsPanel, OutputView } from '@/features/toolrunner';
import { counted } from '@/lib/plural';
import { formatBytes } from '@/lib/sniff';

import { formatDuration } from './CanvasNodeView';
import styles from './inspector.module.css';
import { summariseValue } from './resultSummary';

import type { CanvasNode, NodeId } from './types';

/**
 * THE NODE INSPECTOR
 *
 * The canvas could build a pipeline and run it correctly and show you none of
 * it. A node drew a title, its ports, a status light and a text box; it drew
 * no options, so every node in every chain ran on defaults, and it drew no
 * output, so the answer - including the LAST node's answer, which is the thing
 * you built the chain for - existed only in memory.
 *
 * This is the one place a node's input, options and output are read and
 * edited, and it is deliberately the ONLY place input is entered. Two boxes
 * holding one value is worse than one extra press: it doubles the surface that
 * has to stay in step, and it makes every node tall enough that you cannot see
 * two of them at once, which is the whole point of a canvas.
 *
 * WHAT IS REUSED, AND WHY IT COULD BE. Both panels below are the tool runner's
 * own, unmodified:
 *
 *   - `OptionsPanel` is driven by the tool's typed `optionFields`, including
 *     the `when` predicates that make text-convert's panel a function of its
 *     target format. It filters internally, so the conditional-options
 *     stability property holds here for free rather than being reimplemented
 *     and then drifting.
 *   - `OutputView` picks a renderer from the port's `presentation` hint and,
 *     for bytes, from the sniffed content. Its five views each cap their own
 *     height (the diff scroller at 520px, the regex tables at 320 and 380, an
 *     image at 420) and are already measured at 320-430px by
 *     `checkMobileLayout`, because that is what a tool page looks like on a
 *     phone. A 320px rail is inside a range those views are held to, which is
 *     why a full-width panel's components fit in a narrow one without a second
 *     implementation.
 *
 * The one thing not passed through is `comparison`, the image before-and-after.
 * ImageView's own reasoning is that two images side by side at 320px are two
 * images too small to judge anything by; the rail is 320px at its narrowest by
 * construction, and the tool page is where that comparison belongs.
 */

export interface InspectorNode {
  readonly node: CanvasNode;
  readonly run: NodeRunState;
  /** Input ports with nothing wired in: the ones that take typed text. */
  readonly typedInputPorts: readonly string[];
  /** For each wired input port, what is feeding it, as a sentence. */
  readonly wiredFrom: Readonly<Record<string, string>>;
}

export interface NodeInspectorProps {
  /** The single selected node, or null when none or several are selected. */
  readonly target: InspectorNode | null;
  /** Every selected node, for the several-selected state. */
  readonly selectedIds: readonly NodeId[];
  /** Names for `selectedIds`, so the panel does not reach for the manifest. */
  readonly selectedLabels: Readonly<Record<NodeId, string>>;
  readonly onSelectOnly: (id: NodeId) => void;
  readonly onInputChange: (nodeId: NodeId, portId: string, value: string) => void;
  /**
   * `coalesce` merges this change into the previous one in the undo history.
   * True while typing, false for a deliberate discrete choice - see the note
   * at the call sites below.
   */
  readonly onOptionChange: (nodeId: NodeId, key: string, value: unknown, coalesce: boolean) => void;
  readonly onClose: () => void;
  /** Escape inside the panel: hand focus back to the node it is showing. */
  readonly onEscape: () => void;
  /** Called when the inspected node disappears while focus is inside here. */
  readonly onOrphaned: () => void;
  readonly hasNodes: boolean;
}

export function NodeInspector({
  target,
  selectedIds,
  selectedLabels,
  onSelectOnly,
  onInputChange,
  onOptionChange,
  onClose,
  onEscape,
  onOrphaned,
  hasNodes,
}: NodeInspectorProps) {
  const { notify } = useToast();
  const headingId = useId();
  const bodyRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLElement>(null);

  const toolId = target ? target.node.toolId : null;
  const nodeId = target ? target.node.id : null;

  /*
   * The tool module, imported for its option field descriptors and nothing
   * else. Same lazily-loaded chunk the worker runs, and the canvas has already
   * asked the engine to prefetch it at the moment the node was added - so in
   * practice this resolves from the module cache and the panel never shows its
   * loading line. It is still written as a load, because "usually warm" is not
   * a guarantee and a share link opened cold is the case that is not.
   */
  const [loaded, setLoaded] = useState<{ id: string; tool: ErasedTool } | null>(null);
  useEffect(() => {
    if (toolId === null) return undefined;
    let cancelled = false;
    void loadTool(toolId).then((tool) => {
      if (!cancelled) setLoaded({ id: toolId, tool });
    });
    return () => {
      cancelled = true;
    };
  }, [toolId]);

  /*
   * The loaded module carries the id it was loaded FOR, and is used only while
   * that still matches. Clearing it in the effect instead would be a setState
   * inside an effect body - a cascading render this codebase's lint rules
   * refuse - and would also paint one frame of the previous tool's option
   * fields against the new node's values, which is worse than a loading line.
   */
  const tool = loaded !== null && loaded.id === toolId ? loaded.tool : null;

  /*
   * A new node starts the panel at the top.
   *
   * Without this, moving from a node with a long diff to the next one leaves
   * you looking at the second node's footer, which reads as the panel having
   * failed to update.
   */
  useEffect(() => {
    // `scrollTop`, not `scrollTo({top: 0})`: the property is the one both
    // jsdom and every engine implement, and there is no smooth scroll wanted
    // here - the panel is showing a different node, not the same one moved.
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  }, [nodeId]);

  /*
   * THE NODE BEING EDITED IS DELETED.
   *
   * Deleting from the canvas already returns focus to the canvas root, because
   * the key that did it was handled there. Every other route out - undo, a
   * share link replacing the graph, a redo that removes the node again - runs
   * while focus is in here, and leaving focus on an element that is about to
   * unmount drops it to <body>, where none of the canvas's keys work and no
   * announcement says why.
   *
   * The guard is deliberately narrow: it only fires when focus is actually
   * inside this panel, so a deletion the user performed on the canvas is left
   * exactly as the canvas arranged it.
   */
  /*
   * ESCAPE LEAVES THE PANEL AND RETURNS TO THE NODE.
   *
   * The mirror of Enter, and the wording the shortcuts map has always carried
   * for stepping out of an editor.
   *
   * Bound natively rather than with an `onKeyDown` prop, and for the reason the
   * canvas states about its own root: this is a non-interactive element as far
   * as the linter is concerned, and that warning is worth keeping switched on
   * for the cases it really catches. It is also the right place - the panel is
   * a SIBLING of the canvas root, so no canvas listener ever sees a key typed
   * in here, which is exactly what stops a `role="application"` region
   * claiming the letter "k" out of somebody's regex.
   */
  useEffect(() => {
    const element = rootRef.current;
    if (!element) return undefined;

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onEscape();
    };

    element.addEventListener('keydown', onKeyDown);
    return () => {
      element.removeEventListener('keydown', onKeyDown);
    };
  }, [onEscape]);

  /*
   * WHETHER FOCUS WAS IN HERE, tracked rather than read at the moment it
   * matters.
   *
   * By the time the effect below runs, React has already unmounted the field
   * that had focus and the browser has moved it to <body> - so asking
   * `rootRef.contains(document.activeElement)` after the fact always answers
   * no, and the guard would never fire. It has to be known BEFORE.
   *
   * `focusout` with a null `relatedTarget` is exactly the unmount case, and is
   * deliberately NOT treated as leaving: focus went nowhere, because the thing
   * that had it stopped existing.
   */
  const focusWasInside = useRef(false);
  useEffect(() => {
    const element = rootRef.current;
    if (!element) return undefined;

    const onFocusIn = (): void => {
      focusWasInside.current = true;
    };
    const onFocusOut = (event: FocusEvent): void => {
      const next = event.relatedTarget;
      if (next instanceof Node && element.contains(next)) return;
      if (next === null) return;
      focusWasInside.current = false;
    };

    element.addEventListener('focusin', onFocusIn);
    element.addEventListener('focusout', onFocusOut);
    return () => {
      element.removeEventListener('focusin', onFocusIn);
      element.removeEventListener('focusout', onFocusOut);
    };
  }, []);

  const wasShowing = useRef(false);
  useEffect(() => {
    const showing = target !== null;
    const lost = wasShowing.current && !showing;
    wasShowing.current = showing;

    if (!lost || !focusWasInside.current) return;
    focusWasInside.current = false;
    onOrphaned();
  }, [target, onOrphaned]);

  return (
    <aside
      ref={rootRef}
      className={styles.inspector}
      /*
       * A landmark, so the panel is reachable by landmark navigation as well
       * as by Tab - it is a region of the page rather than a dialog, and it
       * must not trap focus: the canvas behind it stays live and editable
       * while it is open, which is the entire point of docking it.
       */
      aria-labelledby={headingId}
      data-testid="node-inspector"
    >
      <div className={styles.head}>
        <h2 className={styles.heading} id={headingId}>
          {target ? getManifestEntry(target.node.toolId).name : 'Inspector'}
        </h2>
        {target ? (
          <span className={styles.headMeta}>
            {target.run.durationMs === null ? null : (
              <span className={styles.mono}>{formatDuration(target.run.durationMs)}</span>
            )}
            <span>{target.node.id}</span>
          </span>
        ) : null}
        <Button size="sm" variant="ghost" onClick={onClose} aria-label="Close the inspector">
          <CloseIcon size={12} />
        </Button>
      </div>

      <div className={styles.body} ref={bodyRef} data-testid="inspector-body">
        {target === null ? (
          <EmptyState
            selectedIds={selectedIds}
            selectedLabels={selectedLabels}
            onSelectOnly={onSelectOnly}
            hasNodes={hasNodes}
          />
        ) : (
          <>
            <Section title="Input">
              <InputSection
                node={target.node}
                typedInputPorts={target.typedInputPorts}
                wiredFrom={target.wiredFrom}
                onInputChange={onInputChange}
              />
            </Section>

            <Section title="Options">
              {tool === null ? (
                <p className={styles.hint}>Loading options…</p>
              ) : (
                <OptionsPanel
                  fields={tool.optionFields}
                  /*
                   * The tool's defaults UNDER the node's own options, rather
                   * than the node's options alone.
                   *
                   * `addNode` stores `{}` and the engine fills the gaps by
                   * parsing through the tool's Zod schema, so a node really
                   * does run on its defaults - but a control handed
                   * `undefined` draws itself empty, which says the option has
                   * no value when it has the default one. The node's own
                   * entries always win, so nothing the user set is displaced.
                   */
                  values={{
                    ...(tool.defaultOptions as Record<string, unknown>),
                    ...target.node.options,
                  }}
                  onChange={(key, value) => {
                    /*
                     * COALESCED FOR TEXT AND NUMBERS, NOT FOR THE REST.
                     *
                     * Options are an undoable graph edit here, unlike on the
                     * tool page where they are component state - so typing a
                     * regex pattern would otherwise put one entry in the undo
                     * history per keystroke and bury everything before it.
                     * Merging consecutive edits of the same node is the same
                     * trick a held arrow key already uses for moves.
                     *
                     * A toggle or a select is a single deliberate act and is
                     * worth its own step, so those are not merged. The line is
                     * drawn on the CONTROL rather than on timing, because a
                     * control is a fact and a pause is a guess.
                     */
                    const field = tool.optionFields.find((candidate) => candidate.key === key);
                    const typed = field?.control === 'text' || field?.control === 'number';
                    onOptionChange(target.node.id, key, value, typed);
                  }}
                />
              )}
            </Section>

            <Section title="Output">
              <OutputSection target={target} notify={notify} />
            </Section>
          </>
        )}
      </div>
    </aside>
  );
}

/* -------------------------------------------------------------------------- *
 * Sections
 * -------------------------------------------------------------------------- */

/**
 * INPUT, THEN OPTIONS, THEN OUTPUT, in the source order they are read in.
 *
 * The same order the tool runner puts its four regions in, for the same reason
 * written down in architecture.md: with the options above the output, changing
 * one means looking down at what changed, rather than scrolling past an
 * arbitrarily long result to reach the control and back again to see it work.
 * Here it is a single column at every width, so there is no CSS that could
 * disagree with the markup in the first place.
 */
function Section({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  const id = useId();
  return (
    <section className={styles.section} aria-labelledby={id}>
      <h3 className={styles.sectionTitle} id={id}>
        {title}
      </h3>
      {children}
    </section>
  );
}

function InputSection({
  node,
  typedInputPorts,
  wiredFrom,
  onInputChange,
}: {
  readonly node: CanvasNode;
  readonly typedInputPorts: readonly string[];
  readonly wiredFrom: Readonly<Record<string, string>>;
  readonly onInputChange: (nodeId: NodeId, portId: string, value: string) => void;
}) {
  const entry = getManifestEntry(node.toolId);
  const named = entry.inputs.length > 1;

  if (entry.inputs.length === 0) {
    return <p className={styles.hint}>This tool takes no input.</p>;
  }

  return (
    <div className={styles.stack}>
      {entry.inputs.map((port) => {
        const wired = wiredFrom[port.id];
        if (wired !== undefined) {
          /*
           * A wired port has no editor, because a wire wins over typed text
           * everywhere else in the engine too - drawing a box whose contents
           * the run would ignore is the same defect in a different costume.
           */
          return (
            <p key={port.id} className={styles.hint}>
              {named ? `${port.label}: ` : ''}Wired from {wired}.
            </p>
          );
        }

        if (!typedInputPorts.includes(port.id)) return null;
        return (
          <PortEditor
            key={port.id}
            node={node}
            port={port}
            named={named}
            toolName={entry.name}
            onInputChange={onInputChange}
          />
        );
      })}
    </div>
  );
}

/**
 * ONE EDITOR PER PORT THAT CAN ACTUALLY TAKE TEXT.
 *
 * `image-convert` declares `types: ['bytes']`, and the canvas drew it a
 * textarea anyway - one per unwired input port, with no question asked about
 * what the port accepts. Typing into it could not fail loudly either: the
 * engine's preflight sees a required bytes port with no wire and reports
 * `blocked` whatever is in the box, so the node sat there permanently blocked
 * with an editor under it inviting another attempt. The tool runner had the
 * same bug and reported a type error at least; this one said nothing at all.
 *
 * A port that cannot take text now gets its own description as the
 * instruction, which is exactly the fix architecture.md records for the runner.
 */
function PortEditor({
  node,
  port,
  named,
  toolName,
  onInputChange,
}: {
  readonly node: CanvasNode;
  readonly port: InputPort;
  readonly named: boolean;
  readonly toolName: string;
  readonly onInputChange: (nodeId: NodeId, portId: string, value: string) => void;
}) {
  if (!port.types.includes('text')) {
    return (
      <p className={styles.hint}>
        {named ? `${port.label}: ` : ''}
        {port.description ??
          `${port.label} takes ${port.types.join(' or ')} rather than typed text. Wire an output into it.`}
      </p>
    );
  }

  const value = node.inputs[port.id] ?? '';
  const label = named ? `${toolName} ${port.label} input` : `${toolName} input`;

  return (
    <div className={styles.stack}>
      {named ? <p className={styles.hint}>{port.label}</p> : null}
      <TextArea
        className={styles.editor}
        aria-label={label}
        data-inspector-input={port.id}
        placeholder={port.description ?? 'Type or paste input'}
        value={value}
        spellCheck={false}
        onChange={(event) => {
          onInputChange(node.id, port.id, event.target.value);
        }}
      />
      <p className={styles.hint}>{value === '' ? 'Empty' : counted(value.length, 'character')}</p>
    </div>
  );
}

/**
 * The node's result, or the reason there is not one.
 *
 * A RUNNING NODE SHOWS "RUNNING", NOT ITS PREVIOUS ANSWER. Keeping the last
 * result on screen while a new one computes would mean showing the answer to a
 * question the user has already changed, and the only case where it lasts long
 * enough to notice - a slow tool - is exactly the case where saying so is the
 * truth. `NodeRunState` clears `outputs` when a node starts, so this is also
 * the shape the engine already has rather than a second copy of it.
 */
function OutputSection({
  target,
  notify,
}: {
  readonly target: InspectorNode;
  readonly notify: ReturnType<typeof useToast>['notify'];
}) {
  const entry = getManifestEntry(target.node.toolId);
  const { run } = target;

  if (run.status === 'error' && run.error) return <ErrorReport error={run.error} />;

  if (run.status === 'upstream-failed') {
    return (
      <p className={styles.hint}>
        Nothing ran here: {run.failedUpstream ?? 'a node upstream'} failed. Its own message says
        why.
      </p>
    );
  }

  if (run.status === 'blocked') {
    return <p className={styles.hint}>{run.blockedReason ?? 'Waiting for input.'}</p>;
  }

  if (run.status === 'running') {
    return (
      <p className={styles.hint} role="status">
        Running…
      </p>
    );
  }

  if (run.status !== 'ok' || !run.outputs) {
    return <p className={styles.hint}>This node has not run yet.</p>;
  }

  const outputs = run.outputs;

  return (
    <div className={styles.stack}>
      {entry.outputs.map((port) => {
        const value = outputs[port.id];
        if (!value) return null;
        return (
          <div key={port.id} className={styles.stack}>
            <p className={styles.outputLabel}>
              <span>{port.label}</span>
              <span className={styles.hint}>{summariseValue(value, port.presentation)}</span>
            </p>
            <OutputView
              value={value}
              label={`${entry.name} ${port.label}`}
              baseFilename={entry.id}
              {...(port.presentation === undefined ? {} : { presentation: port.presentation })}
              onCopy={(copied) => {
                void navigator.clipboard.writeText(copied).then(
                  () => {
                    notify({
                      title: 'Copied',
                      description: `${formatBytes(copied.length)} to the clipboard.`,
                      tone: 'ok',
                    });
                  },
                  () => {
                    notify({
                      title: 'Could not copy',
                      description: 'The browser refused clipboard access.',
                      tone: 'error',
                    });
                  },
                );
              }}
              /*
               * Rich-text copy is the tool page's affordance and stays there.
               * It needs the clipboard document builder, which pulls the whole
               * markup pipeline in behind it - a cost the canvas chunk should
               * not carry for a button that is one click away on /tools. The
               * HTML view's Source, Preview and Copy all work here regardless.
               */
              onCopyRich={() => {
                notify({
                  title: 'Rich text lives on the tool page',
                  description: `Open ${entry.name} under Tools to copy this as rich text.`,
                  tone: 'warn',
                });
              }}
              onDownload={(blob, filename) => {
                const url = URL.createObjectURL(blob);
                const anchor = document.createElement('a');
                anchor.href = url;
                anchor.download = filename;
                anchor.click();
                URL.revokeObjectURL(url);
                notify({ title: 'Downloaded', description: filename, tone: 'ok' });
              }}
            />
          </div>
        );
      })}
    </div>
  );
}

/* -------------------------------------------------------------------------- *
 * Nothing selected, or too much
 * -------------------------------------------------------------------------- */

/**
 * NO SELECTION AND MANY SELECTIONS ARE DIFFERENT QUESTIONS.
 *
 * "Select a node" is the answer to the first and an insult in the second - the
 * user has selected several nodes, deliberately, and telling them to select
 * one without saying which ones they have is a dead end. So the several case
 * lists them and lets one be picked, which turns the state into a way through
 * rather than a wall.
 */
function EmptyState({
  selectedIds,
  selectedLabels,
  onSelectOnly,
  hasNodes,
}: {
  readonly selectedIds: readonly NodeId[];
  readonly selectedLabels: Readonly<Record<NodeId, string>>;
  readonly onSelectOnly: (id: NodeId) => void;
  readonly hasNodes: boolean;
}) {
  if (selectedIds.length > 1) {
    return (
      <div className={styles.stack}>
        <p className={styles.hint}>
          {counted(selectedIds.length, 'node')} selected. Choose one to inspect it.
        </p>
        <ul className={styles.pickList}>
          {selectedIds.map((id) => (
            <li key={id}>
              <button
                type="button"
                className={styles.pick}
                onClick={() => {
                  onSelectOnly(id);
                }}
              >
                <span>{selectedLabels[id] ?? id}</span>
                <span className={styles.mono}>{id}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <p className={styles.hint}>
      {hasNodes
        ? 'No node selected. Select a node to see its input, options and output.'
        : 'Nothing on the canvas yet. Add a tool, then select it to set its input and read what it produced.'}
    </p>
  );
}
