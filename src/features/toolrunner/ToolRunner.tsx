import { useEffect, useRef, useState } from 'react';

import { Button } from '@/components/Button';
import { Panel } from '@/components/Panel';
import { TextArea } from '@/components/TextArea';
import { useToast } from '@/components/Toast';
import { useToolExecution, type ExecutionState } from '@/features/execution';
import { loadTool, type ToolId, type ToolManifestEntry } from '@/features/registry';
import type { ErasedTool, InputPort, ToolInputs, ToolValue } from '@/features/registry/types';
import type { LoadedFile } from '@/lib/fileInput';
import { formatBytes } from '@/lib/sniff';

import { FileDrop } from './FileDrop';
import { copyRichText } from './HtmlView';
import { OptionsPanel } from './OptionsPanel';
import { ErrorReport, OutputView } from './OutputPanel';
import { richTextDocument, richTextPlain } from './richText';
import styles from './runner.module.css';

import type { ImageComparison } from './ImageView';

/**
 * Builds the value for a port from whatever the user supplied.
 *
 * A FILE ARRIVES ALREADY BUILT. `LoadedFile.value` was produced and validated
 * against this very port when the file was chosen - see `lib/fileInput.ts` -
 * so the branching that used to live here (bytes port or text port, sniffed
 * text or not, decode or refuse) happens once, at selection, where a refusal
 * can name the file and be acted on. The canvas inspector reuses the same
 * function, which is why there is no second copy of those rules anywhere.
 */
function buildInputValue(
  port: InputPort,
  text: string,
  file: LoadedFile | null,
): { readonly value: ToolValue } | { readonly error: string } {
  if (file) return { value: file.value };

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
 * Two conditions, and each one is a case where offering a comparison would be
 * worse than offering none:
 *
 *  - No file at all: there is no "before".
 *  - A file that is not an image: a CSV has nothing to look at, and labelling
 *    an unrelated thing "Before" is a comparison that lies.
 *
 * There used to be a third - a file the run had read no bytes from - and it is
 * gone because it cannot happen any more rather than because it stopped
 * mattering: a `LoadedFile` only exists once its bytes have been read and
 * accepted for its port, so a non-null one always fed the run.
 *
 * The sniffed type decides, never the declared one - rename `payload.zip` to
 * `photo.png` and the operating system will tell you it is an image.
 */
export function comparisonFor(file: LoadedFile | null): ImageComparison | null {
  if (file === null) return null;
  if (file.sniff.mediaType?.startsWith('image/') !== true) return null;

  // The File itself, not its bytes: a File IS a Blob, the browser is already
  // holding it, and copying tens of megabytes into React state to show a
  // thumbnail would be the one genuinely expensive way to do this.
  return { blob: file.file, label: file.sniff.label, byteLength: file.file.size };
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

  /*
   * NOTHING IS READ HERE ANY MORE, so this is no longer async.
   *
   * It used to re-read the whole `File` on every press, having already read it
   * once to sniff it - so a 60 MB image was pulled into memory twice per run,
   * and the sniff came from one read while the bytes came from another. A file
   * edited on disk between the two would have been processed under the
   * previous file's verdict about what it was.
   */
  function onRun(): void {
    if (!tool) return;

    // Built mutably and frozen into the readonly ToolInputs at the end: the
    // engine's type says "you may not edit these", which is right for a
    // consumer and unhelpful while assembling them.
    const inputs: Record<string, ToolValue> = {};
    for (const input of entry.inputs) {
      const isFileTarget = file !== null && input.id === filePort?.id;
      const built = buildInputValue(input, texts[input.id] ?? '', isFileTarget ? file : null);
      if ('error' in built) {
        notify({ title: 'Cannot run', description: built.error, tone: 'error' });
        return;
      }
      // Assigned through a local so the union stays narrowed; the key is a
      // port id from the manifest, never anything user-supplied.
      inputs[input.id] = built.value;
    }

    // Pinned HERE, at the moment of the run - see the note on the state above.
    setComparison(comparisonFor(file));

    run(inputs satisfies ToolInputs, options);
  }

  return (
    <>
      {/*
        TWO REGIONS, NOT ONE, AND THE SPLIT IS THE FIX FOR A REAL DEFECT.
        ────────────────────────────────────────────────────────────────
        `.layout` is the two-column region - Input, the controls rail, Output -
        and NOTHING ELSE MAY GO IN IT. The Ports footnote below is a sibling in
        the page's own flow.

        A `position: sticky` box's travel is bounded by its containing block,
        and for a grid item that containing block is the GRID CONTAINER, not
        the grid area it was placed in. Measured, because the opposite is the
        intuitive reading and it is wrong: at the foot of a JWT page the rail
        sat 52px over the Ports panel, and from there down its bottom edge
        tracked the grid's bottom edge exactly. The rail spans both content
        rows so sticky has somewhere to travel; that span never constrained it.

        So a full-bleed section inside this grid is a section inside the rail's
        travel range, and no amount of z-index, margin or padding changes that
        - the rail is ALLOWED to be there. Moving Ports out is what removes the
        permission. The rail's containing block now ends where the content
        column ends, so there is nothing below it to paint over.

        THE ORDER OF THE FOUR REGIONS IS STILL THE POINT. Input, the controls,
        Output, then Ports - the order the eye reads them in at every width,
        because it is the order they are written in. Ports moving out of the
        grid does not move it in the source. See the note at the top of
        runner.module.css.
      */}
      <div className={styles.layout}>
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
                        onRun();
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

            {/*
              The control is given the PORT the file will feed, not just a size
              limit. That is what lets it refuse a PNG on a text-only port at the
              moment of selection rather than at the moment of Run, and it is the
              same component the canvas inspector renders per port.
            */}
            {filePort ? (
              <FileDrop
                port={filePort}
                loaded={file}
                maxBytes={entry.execution.maxInputBytes}
                disabled={isBusy}
                onFile={setFile}
                onReject={(message) => {
                  notify({ title: 'File rejected', description: message, tone: 'error' });
                }}
              />
            ) : null}
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

          {/*
            RUN, CANCEL AND THE BUSY READOUT, IN A CARD RATHER THAN ON THE PAGE.
            ──────────────────────────────────────────────────────────────────
            This cluster used to be the rail's bare tail: three controls and a
            progress bar sitting directly on the page background, below the
            Options panel and belonging to nothing. On a surface where every
            other region is a bordered module, the primary action was the one
            thing with no container.

            IT HAS NOT MOVED IN THE DOM, and that is deliberate. Run comes after
            the options because that is what makes the stacked layout work -
            change a flag, then reach the button, without going back up the page
            - and `ToolRunner.layout.test.tsx` asserts that tab order.

            The other thing wrong with it was that Run MOVED: the rail's height
            was the options' height, so its last row shifted whenever a
            conditional option appeared or went. That was never a fact about
            where Run sits in the source, and moving it would not have fixed it.
            It is fixed in the stylesheet, by giving the rail the region's height
            rather than its own content's - see the note on `.controls`.
          */}
          <Panel className={styles.runCard}>
            <div className={styles.actions}>
              <div className={styles.row}>
                <Button
                  onClick={() => {
                    onRun();
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
          </Panel>
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

          {/*
            DESCRIPTIVE, NOT AN INSTRUCTION, and the difference is why it
            changed. It read "Run the tool to see output here." - which tells
            the reader to do something and then leaves them to find the
            control, while the control is in the rail beside this panel rather
            than under this sentence. On a wide screen it sat several hundred
            pixels above Run, so the page instructed first and offered the
            button second.

            Saying what this box IS costs nothing and puts no direction in it.
            Run is a labelled button in a card of its own, on screen at every
            scroll position above the breakpoint; a sentence pointing at it was
            never what made it findable.
          */}
          {state.status === 'idle' ? (
            <p className={styles.hint}>No output yet. Results appear here.</p>
          ) : null}

          {state.status === 'running' ? <p className={styles.hint}>Working…</p> : null}
        </Panel>
      </div>

      <Panel title="Ports" footer={`Runs in a ${entry.execution.strategy} context`}>
        {/*
          AN OUTPUT PORT'S DESCRIPTION IS SHOWN HERE, AND IT USED TO BE SHOWN
          NOWHERE AT ALL.

          `PortBase.description` is the one place a port explains itself, and
          for an OUTPUT port nothing on any route read it. An input's is its
          editor's placeholder and, for a bytes-only port, the instruction for
          the file control - but an output's existed only for whoever was
          reading the manifest source, including the sentence saying base64's
          single output is text one way and bytes the other, which is the most
          surprising fact in the whole port set.

          This panel is where it belongs rather than beside the value: it is
          the footnote about how the tool wires up, consulted while building a
          pipeline rather than while reading a result. Every port now has a
          description and `ports.test.ts` asserts that.

          INPUTS DELIBERATELY DO NOT REPEAT THEIRS. Their prose is already on
          this page, in the panel where it is acted on, and printing the same
          sentence twice on one screen is worse than printing it once - the
          image tool's "A PNG, JPEG, GIF or WebP file" would have appeared as
          an instruction and again as a footnote four regions below it.
        */}
        <div className={styles.stack}>
          {entry.inputs.map((input) => (
            <p key={input.id} className={styles.hint}>
              In · {input.label} · {input.types.join(' or ')}
            </p>
          ))}
          {entry.outputs.map((output) => (
            <div key={output.id} className={styles.port}>
              <p className={styles.hint}>
                Out · {output.label} · {output.types.join(' or ')}
              </p>
              {output.description === undefined ? null : (
                <p className={styles.portNote}>{output.description}</p>
              )}
            </div>
          ))}
        </div>
      </Panel>
    </>
  );
}
