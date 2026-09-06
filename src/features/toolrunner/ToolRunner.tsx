import { useEffect, useRef, useState } from 'react';

import { Button } from '@/components/Button';
import { Panel } from '@/components/Panel';
import { TextArea } from '@/components/TextArea';
import { useToast } from '@/components/Toast';
import { useToolExecution, type ExecutionState } from '@/features/execution';
import { loadTool, type ToolId, type ToolManifestEntry } from '@/features/registry';
import type {
  Bytes,
  ErasedTool,
  InputPort,
  ToolInputs,
  ToolValue,
} from '@/features/registry/types';
import { formatBytes } from '@/lib/sniff';

import { FileDrop, type LoadedFile } from './FileDrop';
import { copyRichText } from './HtmlView';
import { OptionsPanel } from './OptionsPanel';
import { ErrorReport, OutputView } from './OutputPanel';
import { richTextDocument, richTextPlain } from './richText';
import styles from './runner.module.css';

import type { ImageComparison } from './ImageView';

/** Builds the value for a port from whatever the user supplied. */
function buildInputValue(
  port: InputPort,
  text: string,
  bytes: Bytes | null,
  file: LoadedFile | null,
): { readonly value: ToolValue } | { readonly error: string } {
  if (bytes && file) {
    if (port.types.includes('bytes')) {
      return {
        value: {
          type: 'bytes',
          bytes,
          // The sniffed type, never the one the file declared.
          mediaType: file.sniff.mediaType,
          filename: file.file.name,
        },
      };
    }

    // The port only takes text. Decoding is fine for a text file and nonsense
    // for a PNG, so the sniff decides rather than the extension.
    if (port.types.includes('text')) {
      if (!file.sniff.isProbablyText) {
        return {
          error: `That file looks like ${file.sniff.label.toLowerCase()}, and this tool needs text.`,
        };
      }
      return { value: { type: 'text', text: new TextDecoder('utf-8').decode(bytes) } };
    }

    return { error: 'This tool cannot accept a file.' };
  }

  /*
   * No file, and a port that cannot take text has nothing to be handed here.
   * The engine's own refusal - `Input "Image" cannot accept text data` - is
   * true and unhelpful, because the thing to do about it is choose a file.
   */
  if (!port.types.includes('text')) {
    return { error: `${port.label} takes a file. Choose or drop one first.` };
  }

  return { value: { type: 'text', text } };
}

/**
 * The source image to draw a before-and-after against, or nothing.
 *
 * Three conditions, and each one is a case where offering a comparison would
 * be worse than offering none:
 *
 *  - No file at all: there is no "before".
 *  - A file that is not an image: a CSV has nothing to look at, and labelling
 *    an unrelated thing "Before" is a comparison that lies.
 *  - A file the run did not read: the bytes are what was actually handed to
 *    the tool, so a null there means this file fed nothing.
 *
 * The sniffed type decides, never the declared one - rename `payload.zip` to
 * `photo.png` and the operating system will tell you it is an image.
 */
export function comparisonFor(
  file: LoadedFile | null,
  bytes: Bytes | null,
): ImageComparison | null {
  if (file === null || bytes === null) return null;
  if (file.sniff.mediaType?.startsWith('image/') !== true) return null;

  // The File itself, not its bytes: a File IS a Blob, the browser is already
  // holding it, and copying tens of megabytes into React state to show a
  // thumbnail would be the one genuinely expensive way to do this.
  return { blob: file.file, label: file.sniff.label, byteLength: bytes.byteLength };
}

function busyLabel(state: ExecutionState): string {
  if (state.status !== 'running') return '';
  return state.label ?? 'Running';
}

export interface ToolRunnerProps {
  readonly entry: ToolManifestEntry;
}

export function ToolRunner({ entry }: ToolRunnerProps) {
  const toolId = entry.id as ToolId;
  const { notify } = useToast();
  const { state, run, cancel, isBusy } = useToolExecution(toolId);

  const [tool, setTool] = useState<ErasedTool | null>(null);
  const [options, setOptions] = useState<Record<string, unknown>>({});
  /*
   * Keyed by port id, because a tool can have more than one input - `diff`
   * takes two. A single string would have made the second port unusable here
   * while remaining usable on the canvas, which is exactly the kind of drift
   * that leaves a route quietly half-built.
   */
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [file, setFile] = useState<LoadedFile | null>(null);
  /*
   * THE IMAGE THIS RESULT WAS MADE FROM, captured when the run starts.
   *
   * The output preview offers a before-and-after, and "before" is an input
   * rather than an output, so it has to come from here. It is pinned at the
   * moment of the run and not read live off `file`: choosing a different
   * picture without pressing Run again would otherwise relabel the comparison
   * without changing either image, which is a comparison that quietly lies.
   *
   * The File itself is held, not its bytes. A File IS a Blob, the browser is
   * already holding it, and copying tens of megabytes into React state to show
   * a thumbnail would be the one genuinely expensive way to do this.
   */
  const [comparison, setComparison] = useState<ImageComparison | null>(null);
  const announced = useRef<ExecutionState | null>(null);

  // The tool module is imported here for its options schema and field
  // descriptors. That is the same lazily-loaded chunk the worker uses, so
  // opening a tool page fetches exactly one tool's code and no others.
  useEffect(() => {
    let cancelled = false;
    void loadTool(toolId).then((loaded) => {
      if (cancelled) return;
      setTool(loaded);
      setOptions({ ...(loaded.defaultOptions as Record<string, unknown>) });
    });
    return () => {
      cancelled = true;
    };
  }, [toolId]);

  // Results are announced through the live region, not just drawn on screen.
  useEffect(() => {
    if (state === announced.current) return;

    if (state.status === 'success') {
      announced.current = state;
      notify({
        title: `${entry.name} finished`,
        description: `Completed in ${state.durationMs.toFixed(0)} ms.`,
        tone: 'ok',
      });
    } else if (state.status === 'error') {
      announced.current = state;
      notify({
        title: state.error.code === 'cancelled' ? 'Cancelled' : `${entry.name} failed`,
        description: state.error.message,
        tone: state.error.code === 'cancelled' ? 'warn' : 'error',
      });
    }
  }, [state, notify, entry.name]);

  // A file goes to the first port that actually takes bytes, falling back to
  // the first port so a text-only tool can still be handed a text file.
  const filePort = entry.inputs.find((input) => input.types.includes('bytes')) ?? entry.inputs[0];

  async function onRun(): Promise<void> {
    if (!tool) return;

    // Read from the File on each run rather than caching bytes in state: the
    // File is the source of truth and the read is cheap next to the run.
    // Split across two statements so the buffer is inferred as a plain
    // ArrayBuffer rather than ArrayBufferLike.
    const buffer = file ? await file.file.arrayBuffer() : null;
    const bytes: Bytes | null = buffer === null ? null : new Uint8Array(buffer);

    // Built mutably and frozen into the readonly ToolInputs at the end: the
    // engine's type says "you may not edit these", which is right for a
    // consumer and unhelpful while assembling them.
    const inputs: Record<string, ToolValue> = {};
    for (const input of entry.inputs) {
      const isFileTarget = file !== null && input.id === filePort?.id;
      const built = buildInputValue(
        input,
        texts[input.id] ?? '',
        isFileTarget ? bytes : null,
        isFileTarget ? file : null,
      );
      if ('error' in built) {
        notify({ title: 'Cannot run', description: built.error, tone: 'error' });
        return;
      }
      // Assigned through a local so the union stays narrowed; the key is a
      // port id from the manifest, never anything user-supplied.
      inputs[input.id] = built.value;
    }

    // Pinned HERE, at the moment of the run - see the note on the state above.
    setComparison(comparisonFor(file, bytes));

    run(inputs satisfies ToolInputs, options);
  }

  return (
    <div className={styles.layout}>
      {/*
        THE ORDER OF THESE FOUR REGIONS IS THE POINT.

        Input, then the controls, then the output, then the ports - which is
        the order the eye reads them in at every width, because it is the
        order they are written in. See the note at the top of
        runner.module.css for why that had to be fixed in the DOM rather than
        arranged in CSS.
      */}
      <Panel className={styles.input} title="Input">
        <div className={styles.stack}>
          {entry.inputs.map((input) =>
            /*
              A textarea only where the port can actually take one.
              `image-convert` declares `types: ['bytes']` and had been drawing
              a full-size editor whose every keystroke could only ever produce
              `Input "Image" cannot accept text data` - an affordance for
              behaviour that does not exist, which is the defect CONTRIBUTING
              names explicitly. The port's own description says what to do
              instead, so it is promoted from placeholder to instruction.
            */
            input.types.includes('text') ? (
              <div key={input.id} className={styles.stack}>
                {/*
                  Only labelled visibly when there is more than one port. With
                  one input the panel heading already says "Input"; with two,
                  "Original" and "Changed" have to be distinguishable on screen
                  as well as to a screen reader.
                */}
                {entry.inputs.length > 1 ? <p className={styles.hint}>{input.label}</p> : null}
                <TextArea
                  className={styles.editor}
                  // Naming the port only matters when there is more than one;
                  // "Base64 Input input" is worse than "Base64 input".
                  aria-label={
                    entry.inputs.length > 1
                      ? `${entry.name} ${input.label} input`
                      : `${entry.name} input`
                  }
                  placeholder={input.description ?? 'Paste your input here'}
                  value={texts[input.id] ?? ''}
                  spellCheck={false}
                  disabled={file !== null && input.id === filePort?.id}
                  onChange={(event) => {
                    const { value } = event.target;
                    setTexts((current) => ({ ...current, [input.id]: value }));
                  }}
                  onKeyDown={(event) => {
                    // Ctrl/Cmd+Enter runs, the convention for "submit this box".
                    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                      event.preventDefault();
                      void onRun();
                    }
                  }}
                />
              </div>
            ) : (
              <p key={input.id} className={styles.hint}>
                {entry.inputs.length > 1 ? `${input.label}: ` : ''}
                {input.description ?? 'This input takes a file rather than typed text.'}
              </p>
            ),
          )}

          <FileDrop
            loaded={file}
            maxBytes={entry.execution.maxInputBytes}
            disabled={isBusy}
            onFile={setFile}
            onReject={(message) => {
              notify({ title: 'File rejected', description: message, tone: 'error' });
            }}
          />
        </div>
      </Panel>

      <div className={styles.controls}>
        <div className={styles.optionsScroll}>
          <Panel title="Options">
            {tool ? (
              <OptionsPanel
                fields={tool.optionFields}
                values={options}
                disabled={isBusy}
                onChange={(key, value) => {
                  setOptions((current) => ({ ...current, [key]: value }));
                }}
              />
            ) : (
              <p className={styles.hint}>Loading options…</p>
            )}
          </Panel>
        </div>

        <div className={styles.actions}>
          <div className={styles.row}>
            <Button
              onClick={() => {
                void onRun();
              }}
              disabled={isBusy || tool === null}
            >
              Run
            </Button>
            {isBusy ? (
              <Button variant="danger" onClick={cancel}>
                Cancel
              </Button>
            ) : null}
          </div>

          {/*
            role="status" so the busy state is announced, not merely drawn.
            aria-busy lets assistive tech describe the region as in progress.
          */}
          <div className={styles.busy} role="status" aria-live="polite" aria-busy={isBusy}>
            {state.status === 'running' ? (
              <>
                <span>{busyLabel(state)}</span>
                <span
                  className={styles.progressTrack}
                  role="progressbar"
                  aria-label="Progress"
                  {...(state.progress === null
                    ? {}
                    : {
                        'aria-valuenow': Math.round(state.progress * 100),
                        'aria-valuemin': 0,
                        'aria-valuemax': 100,
                      })}
                >
                  <span
                    className={
                      state.progress === null
                        ? `${styles.progressBar ?? ''} ${styles.progressIndeterminate ?? ''}`
                        : styles.progressBar
                    }
                    style={
                      state.progress === null
                        ? undefined
                        : { inlineSize: `${(state.progress * 100).toString()}%` }
                    }
                  />
                </span>
              </>
            ) : null}
            {state.status === 'success' ? (
              <span>Done in {state.durationMs.toFixed(0)} ms</span>
            ) : null}
          </div>
        </div>
      </div>

      <Panel className={styles.output} title="Output">
        {state.status === 'error' ? <ErrorReport error={state.error} /> : null}

        {state.status === 'success' ? (
          <div className={styles.stack}>
            {entry.outputs.map((output) => {
              const value = state.outputs[output.id];
              if (!value) return null;
              return (
                <div key={output.id} className={styles.stack}>
                  <p className={styles.hint}>{output.label}</p>
                  <OutputView
                    value={value}
                    label={`${entry.name} ${output.label}`}
                    baseFilename={entry.id}
                    {...(output.presentation === undefined
                      ? {}
                      : { presentation: output.presentation })}
                    comparison={comparison}
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
                    onCopyRich={(html) => {
                      /*
                       * Both outcomes are announced. A clipboard write that
                       * silently did nothing is the worst version of this:
                       * the user pastes somewhere else and finds the old
                       * contents, with no idea when it went wrong.
                       */
                      void copyRichText(richTextDocument(html), richTextPlain(html)).then(
                        (result) => {
                          if (result.ok) {
                            notify({
                              title: 'Copied as rich text',
                              description:
                                'Styled for Word and Google Docs, with readable text as the fallback.',
                              tone: 'ok',
                            });
                            return;
                          }
                          notify({
                            title: 'Could not copy as rich text',
                            description: result.reason,
                            tone: 'error',
                          });
                        },
                      );
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
        ) : null}

        {state.status === 'idle' ? (
          <p className={styles.hint}>Run the tool to see output here.</p>
        ) : null}

        {state.status === 'running' ? <p className={styles.hint}>Working…</p> : null}
      </Panel>

      <Panel
        className={styles.ports}
        title="Ports"
        footer={`Runs in a ${entry.execution.strategy} context`}
      >
        <div className={styles.stack}>
          {entry.inputs.map((input) => (
            <p key={input.id} className={styles.hint}>
              In · {input.label} · {input.types.join(' or ')}
            </p>
          ))}
          {entry.outputs.map((output) => (
            <p key={output.id} className={styles.hint}>
              Out · {output.label} · {output.types.join(' or ')}
            </p>
          ))}
        </div>
      </Panel>
    </div>
  );
}
