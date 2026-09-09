import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  Button,
  Field,
  Panel,
  Select,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  TextInput,
  Toggle,
  useToast,
} from '@/components';
import { cx } from '@/lib/cx';
import { counted } from '@/lib/plural';

import { ContrastReport } from './ContrastReport';
import styles from './themeEditor.module.css';
import { importTheme, serialiseTheme, themeFileName } from './themeFile';
import { TokenField } from './TokenField';
import { useThemeDraft } from './useThemeDraft';
import { draftReader, measureContrast, presetReader, summariseContrast } from '../contrast';
import { availableLabel, labelTaken, newThemeId, normaliseLabel } from '../customThemes';
import { THEME_PRESETS } from '../presets';
import { TOKEN_GROUPS } from '../tokenGroups';
import { isThemeName } from '../types';
import { useTheme } from '../useTheme';

import type { CustomTheme, ThemeName, ThemeSelection } from '../types';

/**
 * THE THEME EDITOR
 *
 * A panel on /styleguide rather than a route or a dialog, and that placement
 * is the design. This page already renders every token and every primitive in
 * every state; editing a token here means watching the actual design system
 * answer, not a swatch pretending to be one. A modal would cover the thing it
 * was editing, which is why this is a panel.
 *
 * IS THE EDITOR IMMUNE TO THE THEME IT EDITS? No, deliberately - see the
 * README. In short: an editor painted in colours other than the ones being
 * edited would be lying about what you are building, and no CSS can promise
 * legibility to somebody who has set every token to the same colour anyway.
 * What is guaranteed instead is that you can always get OUT: the live preview
 * toggle, undo, and Discard are all keyboard-reachable, none of them is
 * labelled by colour, and forced-colors mode overrides the lot.
 */

/* -------------------------------------------------------------------------- *
 * Small helpers
 * -------------------------------------------------------------------------- */

/**
 * Presets and saved themes share one `<Select>`, so an option's value has to
 * say which list it came from. `preset:vellum` and `custom:theme-abc` are
 * unambiguous, and parsing one back is a `startsWith` rather than a cast.
 */
const PRESET_PREFIX = 'preset:';
const CUSTOM_PREFIX = 'custom:';

/* -------------------------------------------------------------------------- *
 * The editor
 * -------------------------------------------------------------------------- */

export interface ThemeEditorProps {
  readonly className?: string;
}

export function ThemeEditor({ className }: ThemeEditorProps) {
  const {
    presets,
    customThemes,
    selection,
    skippedThemes,
    setSelection,
    setDraftTheme,
    saveCustomTheme,
    deleteCustomTheme,
  } = useTheme();
  const { notify } = useToast();

  const [livePreview, setLivePreview] = useState(true);
  const [source, setSource] = useState(`${PRESET_PREFIX}graphite`);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [group, setGroup] = useState(TOKEN_GROUPS[0]?.id ?? 'surfaces');
  const [failuresOnly, setFailuresOnly] = useState(true);
  const [importError, setImportError] = useState<{ message: string; detail: string | null } | null>(
    null,
  );

  /*
   * Publishing the draft to the document. When live preview is off this
   * publishes null instead, which is the escape hatch: whatever the theme
   * under construction looks like, one keyboard-reachable switch puts the page
   * back to the theme that is actually selected without discarding the work.
   */
  const publish = useCallback(
    (theme: CustomTheme | null) => {
      setDraftTheme(livePreview ? theme : null);
    },
    [setDraftTheme, livePreview],
  );

  const {
    draft,
    begin,
    close,
    setLabel,
    setBase,
    setToken,
    clearToken,
    clearAllTokens,
    undo,
    redo,
    markSaved,
  } = useThemeDraft(publish);

  /* --- Contrast ---------------------------------------------------------- */

  const measurements = useMemo(
    () =>
      draft === null
        ? measureContrast(presetReader(activeBaseOf(selection, customThemes)))
        : measureContrast(draftReader(draft.theme.base, draft.theme.overrides)),
    [draft, selection, customThemes],
  );
  const summary = useMemo(() => summariseContrast(measurements), [measurements]);

  /* --- Announcements ------------------------------------------------------ */

  const [announcement, setAnnouncement] = useState('');
  const editing = draft !== null;
  const failing = summary.failing;
  const worstLabel = summary.worst?.pair.label ?? null;
  const worstRatio = summary.worst?.ratio ?? null;

  useEffect(() => {
    if (!editing) return undefined;

    /*
     * DEBOUNCED, because a colour picker drag changes the contrast of six
     * pairs a hundred times a second, and a live region that is written to a
     * hundred times a second says nothing at all - screen readers coalesce or
     * drop the lot. 700ms after the last change is roughly "when the user has
     * stopped moving", which is when the number is worth hearing.
     *
     * The timeout is also why nothing is cleared here when the editor closes:
     * a synchronous setState inside an effect is a cascading render, and the
     * render below simply does not show a stale announcement instead.
     */
    const timer = window.setTimeout(() => {
      setAnnouncement(
        failing === 0
          ? 'All contrast pairs meet WCAG AA.'
          : `${counted(failing, 'contrast pair')} below WCAG AA.${
              worstLabel === null
                ? ''
                : ` Worst: ${worstLabel}${worstRatio === null ? '' : ` at ${worstRatio.toFixed(2)} to 1`}.`
            }`,
      );
    }, 700);

    return () => {
      window.clearTimeout(timer);
    };
  }, [editing, failing, worstLabel, worstRatio]);

  /* --- Names -------------------------------------------------------------- */

  const trimmedLabel = draft === null ? '' : normaliseLabel(draft.theme.label);
  const nameError =
    draft === null
      ? undefined
      : trimmedLabel === ''
        ? 'A theme needs a name.'
        : labelTaken(trimmedLabel, customThemes, draft.theme.id)
          ? `Another theme is already called "${trimmedLabel}".`
          : undefined;

  /* --- Actions ------------------------------------------------------------ */

  const sourceOptions = [
    ...presets.map((preset) => ({ value: `${PRESET_PREFIX}${preset.name}`, label: preset.label })),
    ...customThemes.map((theme) => ({ value: `${CUSTOM_PREFIX}${theme.id}`, label: theme.label })),
  ];

  const startNew = (): void => {
    if (source.startsWith(PRESET_PREFIX)) {
      const name = source.slice(PRESET_PREFIX.length);
      // `isThemeName` narrows the string to the union, so the lookup below
      // needs no cast and an unknown name simply does nothing.
      if (!isThemeName(name)) return;
      const preset = THEME_PRESETS[name];
      begin(
        {
          id: newThemeId(),
          label: availableLabel(`${preset.label} custom`, customThemes),
          base: preset.name,
          overrides: {},
        },
        { isNew: true },
      );
      return;
    }

    const existing = customThemes.find((theme) => theme.id === source.slice(CUSTOM_PREFIX.length));
    if (existing === undefined) return;
    begin(
      {
        id: newThemeId(),
        label: availableLabel(existing.label, customThemes),
        base: existing.base,
        overrides: { ...existing.overrides },
      },
      { isNew: true },
    );
  };

  const save = (): void => {
    if (draft === null || nameError !== undefined) return;
    const theme: CustomTheme = { ...draft.theme, label: trimmedLabel };
    saveCustomTheme(theme);
    markSaved(theme);
    notify(
      summary.failing === 0
        ? { title: 'Theme saved', description: theme.label, tone: 'ok' }
        : {
            title: 'Theme saved with failing contrast',
            description: `${counted(summary.failing, 'pair')} below WCAG AA.`,
            tone: 'warn',
          },
    );
  };

  const apply = (theme: CustomTheme, failingPairs: number): void => {
    setSelection({ kind: 'custom', id: theme.id });
    notify(
      failingPairs === 0
        ? { title: 'Theme applied', description: theme.label, tone: 'ok' }
        : {
            title: 'Applied a theme that fails WCAG AA',
            description: `${counted(failingPairs, 'contrast pair')} below the minimum. Text may be hard to read.`,
            tone: 'warn',
          },
    );
  };

  const duplicate = (theme: CustomTheme): void => {
    const copy: CustomTheme = {
      ...theme,
      id: newThemeId(),
      label: availableLabel(theme.label, customThemes),
      overrides: { ...theme.overrides },
    };
    saveCustomTheme(copy);
    notify({ title: 'Theme duplicated', description: copy.label, tone: 'ok' });
  };

  const exportTheme = (theme: CustomTheme): void => {
    const blob = new Blob([serialiseTheme(theme)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = themeFileName(theme.label);
    anchor.click();
    URL.revokeObjectURL(url);
    notify({ title: 'Theme exported', description: anchor.download, tone: 'ok' });
  };

  const fileInput = useRef<HTMLInputElement>(null);

  const runImport = (text: string): void => {
    const result = importTheme(text, customThemes);
    if (!result.ok) {
      setImportError({ message: result.message, detail: result.detail });
      return;
    }
    setImportError(null);
    saveCustomTheme(result.theme);
    notify({ title: 'Theme imported', description: result.theme.label, tone: 'ok' });
  };

  /* --- Keyboard ----------------------------------------------------------- */

  /**
   * Ctrl/Cmd+Z and Ctrl/Cmd+Shift+Z, but never while a text field has focus.
   *
   * Inside an input the browser's own undo owns that chord and it means
   * something narrower and more immediate - the characters you just typed.
   * Stealing it there would be worse than not offering it, so the Undo and
   * Redo BUTTONS remain the complete answer and this is a convenience on top.
   *
   * Bound with `addEventListener` on the container rather than as a JSX
   * handler, because a keydown handler on a plain <div> is indistinguishable,
   * to a linter and to a screen reader, from an interactive element that
   * forgot its role. This container is not interactive; it is a scope.
   */
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = container.current;
    if (node === null) return undefined;

    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'z') return;

      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;

      event.preventDefault();
      if (event.shiftKey) redo();
      else undo();
    };

    node.addEventListener('keydown', onKeyDown);
    return () => {
      node.removeEventListener('keydown', onKeyDown);
    };
  }, [undo, redo]);

  /* --- Render ------------------------------------------------------------- */

  return (
    <div className={cx(styles.root, className)} ref={container}>
      {skippedThemes > 0 ? (
        <p className={styles.warning} role="status">
          {counted(skippedThemes, 'stored theme')} could not be read and{' '}
          {skippedThemes === 1 ? 'was' : 'were'} skipped.
        </p>
      ) : null}

      {draft === null ? (
        <div className={styles.library}>
          <Panel title="Saved themes">
            {customThemes.length === 0 ? (
              <p className={styles.hint}>
                No custom themes yet. Start from a preset below — a blank theme would have no
                colours at all, which is not a useful place to begin.
              </p>
            ) : (
              <ul className={styles.themeList}>
                {customThemes.map((theme) => {
                  const failingPairs = summariseContrast(
                    measureContrast(draftReader(theme.base, theme.overrides)),
                  ).failing;
                  const isApplied = selection.kind === 'custom' && selection.id === theme.id;

                  return (
                    <li key={theme.id} className={styles.themeRow}>
                      <span className={styles.themeName}>
                        {theme.label}
                        <span className={styles.themeMeta}>
                          {THEME_PRESETS[theme.base].label} base ·{' '}
                          {Object.keys(theme.overrides).length} overridden
                          {failingPairs > 0 ? ` · ${counted(failingPairs, 'pair')} fail AA` : ''}
                          {isApplied ? ' · applied' : ''}
                        </span>
                      </span>

                      <span className={styles.themeActions}>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={isApplied}
                          onClick={() => {
                            apply(theme, failingPairs);
                          }}
                        >
                          Apply
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            begin(
                              { ...theme, overrides: { ...theme.overrides } },
                              { isNew: false },
                            );
                          }}
                        >
                          Edit
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            duplicate(theme);
                          }}
                        >
                          Duplicate
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            exportTheme(theme);
                          }}
                        >
                          Export
                        </Button>
                        {/*
                          Two steps rather than a confirm dialog. Deleting is
                          the only irreversible thing here, and a second
                          deliberate click on a button that has changed its own
                          label is both keyboard-operable and announced.
                        */}
                        {pendingDelete === theme.id ? (
                          <Button
                            size="sm"
                            variant="danger"
                            onClick={() => {
                              deleteCustomTheme(theme.id);
                              setPendingDelete(null);
                              notify({
                                title: 'Theme deleted',
                                description: theme.label,
                                tone: 'info',
                              });
                            }}
                          >
                            Confirm delete
                          </Button>
                        ) : (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => {
                              setPendingDelete(theme.id);
                            }}
                          >
                            Delete
                          </Button>
                        )}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </Panel>

          <Panel title="New theme">
            <div className={styles.newRow}>
              <Field
                label="Start from"
                description="A preset, or one of your own. Every token you do not change is inherited from it."
              >
                {(control) => (
                  <Select
                    {...control}
                    value={source}
                    onValueChange={setSource}
                    options={sourceOptions}
                  />
                )}
              </Field>
              <Button onClick={startNew}>Create theme</Button>
            </div>

            <div className={styles.importRow}>
              <label className={styles.fileLabel} htmlFor="theme-import">
                Import a theme file
              </label>
              <input
                id="theme-import"
                ref={fileInput}
                className={styles.fileInput}
                type="file"
                accept="application/json,.json"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file === undefined) return;
                  void file.text().then(runImport, () => {
                    setImportError({ message: 'That file could not be read.', detail: null });
                  });
                  // Clear, so importing the same file twice in a row still fires.
                  event.target.value = '';
                }}
              />
              {importError === null ? (
                <p className={styles.hint}>
                  A <code>.patchbay-theme.json</code> file. It is checked against the schema and
                  either applied whole or refused whole.
                </p>
              ) : (
                <p className={styles.importError} role="alert">
                  {importError.message}
                  {importError.detail === null ? null : (
                    <span className={styles.importDetail}>{importError.detail}</span>
                  )}
                </p>
              )}
            </div>
          </Panel>
        </div>
      ) : (
        <Panel
          title={`Editing: ${draft.theme.label || 'Untitled'}`}
          actions={
            <span className={styles.headActions}>
              <Button size="sm" variant="ghost" disabled={!draft.canUndo} onClick={undo}>
                Undo
              </Button>
              <Button size="sm" variant="ghost" disabled={!draft.canRedo} onClick={redo}>
                Redo
              </Button>
            </span>
          }
        >
          <div className={styles.editor}>
            <div className={styles.editorHead}>
              <Field
                label="Name"
                {...(nameError === undefined ? {} : { error: nameError })}
                className={cx(styles.nameField)}
              >
                {(control) => (
                  <TextInput
                    {...control}
                    value={draft.theme.label}
                    invalid={nameError !== undefined}
                    maxLength={48}
                    onChange={(event) => {
                      setLabel(event.target.value);
                    }}
                  />
                )}
              </Field>

              <Field label="Base" description="What every token you have not overridden inherits.">
                {(control) => (
                  <Select
                    {...control}
                    value={draft.theme.base}
                    onValueChange={(value) => {
                      const preset = presets.find((one) => one.name === value);
                      if (preset !== undefined) setBase(preset.name);
                    }}
                    options={presets.map((preset) => ({
                      value: preset.name,
                      label: preset.label,
                    }))}
                  />
                )}
              </Field>

              <Toggle
                checked={livePreview}
                label="Live preview"
                onCheckedChange={(next) => {
                  setLivePreview(next);
                  setDraftTheme(next ? draft.theme : null);
                }}
              />
            </div>

            <div className={styles.editorBody}>
              <div className={styles.tokens}>
                <Tabs value={group} onValueChange={setGroup}>
                  <TabList aria-label="Token groups">
                    {TOKEN_GROUPS.map((one) => (
                      <Tab key={one.id} value={one.id}>
                        {one.title}
                      </Tab>
                    ))}
                  </TabList>
                  {TOKEN_GROUPS.map((one) => (
                    <TabPanel key={one.id} value={one.id}>
                      <p className={styles.groupSummary}>{one.summary}</p>
                      <div className={styles.tokenGrid}>
                        {one.tokens.map((descriptor) => {
                          const override = draft.theme.overrides[descriptor.token];
                          const inherited =
                            presetReader(draft.theme.base)(descriptor.token) ?? '#000000';
                          return (
                            <TokenField
                              key={descriptor.token}
                              descriptor={descriptor}
                              value={override ?? inherited}
                              inherited={inherited}
                              overridden={override !== undefined}
                              onChange={(canonical) => {
                                setToken(descriptor.token, canonical);
                              }}
                              onReset={() => {
                                clearToken(descriptor.token);
                              }}
                            />
                          );
                        })}
                      </div>
                    </TabPanel>
                  ))}
                </Tabs>
              </div>

              <div className={styles.contrast}>
                <h3 className={styles.contrastTitle}>Contrast</h3>
                <p
                  className={cx(
                    styles.contrastSummary,
                    summary.failing > 0 && styles.contrastSummaryBad,
                  )}
                >
                  {summary.failing === 0
                    ? `All ${summary.total.toString()} pairs meet WCAG AA.`
                    : `${summary.failing.toString()} of ${summary.total.toString()} pairs fail WCAG AA.`}
                </p>
                <Toggle
                  checked={failuresOnly}
                  label="Failures only"
                  onCheckedChange={setFailuresOnly}
                />
                <ContrastReport measurements={measurements} failuresOnly={failuresOnly} />
              </div>
            </div>

            <div className={styles.editorFoot}>
              <Button onClick={save} disabled={nameError !== undefined}>
                {draft.isNew ? 'Save theme' : 'Save changes'}
              </Button>
              <Button
                variant="ghost"
                disabled={draft.isNew || draft.isDirty}
                onClick={() => {
                  apply(draft.theme, summary.failing);
                }}
              >
                Apply
              </Button>
              <Button
                variant="ghost"
                disabled={Object.keys(draft.theme.overrides).length === 0}
                onClick={clearAllTokens}
              >
                Reset every token
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  close();
                  setPendingDelete(null);
                }}
              >
                {draft.isDirty ? 'Discard changes' : 'Close'}
              </Button>
              {draft.isDirty ? <span className={styles.dirty}>Unsaved changes</span> : null}
            </div>
          </div>
        </Panel>
      )}

      {/*
        The live region exists before there is anything to announce, which is
        the only way a screen reader reliably reads what later arrives in it.
      */}
      <p className={styles.srOnly} role="status" aria-live="polite" data-testid="theme-announcer">
        {editing ? announcement : ''}
      </p>
    </div>
  );
}

/** Which preset the page is currently painted with, draft aside. */
function activeBaseOf(selection: ThemeSelection, customThemes: readonly CustomTheme[]): ThemeName {
  if (selection.kind === 'preset') return selection.name;
  if (selection.kind === 'custom') {
    return customThemes.find((theme) => theme.id === selection.id)?.base ?? 'graphite';
  }
  return 'graphite';
}
