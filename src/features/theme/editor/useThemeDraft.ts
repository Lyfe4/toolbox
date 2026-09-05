import { useCallback, useEffect, useRef, useState } from 'react';

import { THEMED_TOKENS, type CustomTheme, type ThemedToken } from '../types';

/**
 * UNDO AND REDO FOR ONE EDITING SESSION
 *
 * The classic three-list shape: everything before now, now, and everything
 * that was undone. Each entry is a whole `CustomTheme`, which is cheap - a
 * theme is a name and at most 36 short strings - and means undo is an
 * assignment rather than an inverse operation per field. Inverse operations
 * are where undo stacks go wrong.
 *
 * The history does not outlive the session. Closing the editor discards it,
 * because "undo" across a save and a reload would have to mean undoing a save,
 * and that is a different feature with different stakes.
 */
interface DraftHistory {
  readonly past: readonly CustomTheme[];
  readonly present: CustomTheme;
  readonly future: readonly CustomTheme[];
}

/**
 * How long two edits to the SAME control stay one history entry.
 *
 * Dragging a native colour picker fires a change per pixel of travel. Without
 * this, one drag becomes four hundred undo steps and the button is useless;
 * with it, a drag is one step, and a deliberate second edit to the same token
 * a moment later is another. 800ms is long enough to cover a drag and short
 * enough that it never joins two edits a person thinks of as separate.
 */
const COALESCE_MS = 800;

export interface ThemeDraft {
  readonly theme: CustomTheme;
  /** True while this draft has never been saved, which changes what Save means. */
  readonly isNew: boolean;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly isDirty: boolean;
}

export interface UseThemeDraftResult {
  readonly draft: ThemeDraft | null;
  /** Opens an editing session on `theme`. */
  readonly begin: (theme: CustomTheme, options: { readonly isNew: boolean }) => void;
  readonly close: () => void;
  readonly setLabel: (label: string) => void;
  readonly setToken: (token: ThemedToken, value: string) => void;
  readonly clearToken: (token: ThemedToken) => void;
  /** Drops every override, returning the draft to its untouched base preset. */
  readonly clearAllTokens: () => void;
  readonly setBase: (base: CustomTheme['base']) => void;
  readonly undo: () => void;
  readonly redo: () => void;
  /** Records the state that is now on disk, so `isDirty` goes quiet. */
  readonly markSaved: (theme: CustomTheme) => void;
}

export function useThemeDraft(
  /**
   * Called with the draft whenever it changes, and with null when it closes.
   * The editor points this at the theme store, which applies it to the page.
   *
   * Must be STABLE - wrap it in `useCallback`. It is a dependency of the effect
   * that publishes the draft, and a new identity every render would republish
   * on every render.
   */
  onChange: (theme: CustomTheme | null) => void,
): UseThemeDraftResult {
  const [history, setHistory] = useState<DraftHistory | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [saved, setSaved] = useState<CustomTheme | null>(null);

  /**
   * What the last history push was about, and when. A ref rather than state:
   * changing it must never cause a render, and it is read inside the updater
   * where a state value would be a stale closure.
   */
  const lastPush = useRef<{ key: string; at: number } | null>(null);

  /*
   * PUBLISHING IS AN EFFECT, NOT A CALL INSIDE THE UPDATER.
   *
   * Applying the draft to the document is a side effect on the world outside
   * React. Doing it inside a `setState` updater would run it twice under
   * StrictMode's double-invoke and once more on any re-render React decided to
   * throw away - so it happens here, after the state that caused it has
   * actually committed.
   */
  const present = history?.present ?? null;
  useEffect(() => {
    onChange(present);
  }, [present, onChange]);

  /**
   * The one place history is written.
   *
   * `coalesceKey` is null for anything that should always be its own step.
   * When it matches the previous push and arrived within the window, the
   * present is replaced instead of being pushed - which is what turns a drag
   * into one entry.
   */
  const commit = useCallback(
    (next: (current: CustomTheme) => CustomTheme, coalesceKey: string | null): void => {
      const now = Date.now();
      const previous = lastPush.current;
      const coalesce =
        coalesceKey !== null &&
        previous !== null &&
        previous.key === coalesceKey &&
        now - previous.at < COALESCE_MS;

      setHistory((current) => {
        if (current === null) return current;

        const updated = next(current.present);
        // Referential equality: every updater above returns the object it was
        // given when nothing changed, so a no-op edit costs no history entry.
        if (updated === current.present) return current;

        return coalesce
          ? { ...current, present: updated, future: [] }
          : { past: [...current.past, current.present], present: updated, future: [] };
      });

      lastPush.current = coalesceKey === null ? null : { key: coalesceKey, at: now };
    },
    [],
  );

  const begin = useCallback<UseThemeDraftResult['begin']>((theme, options) => {
    lastPush.current = null;
    setIsNew(options.isNew);
    setSaved(options.isNew ? null : theme);
    setHistory({ past: [], present: theme, future: [] });
  }, []);

  const close = useCallback(() => {
    lastPush.current = null;
    setHistory(null);
    setSaved(null);
    setIsNew(false);
  }, []);

  const setLabel = useCallback<UseThemeDraftResult['setLabel']>(
    (label) => {
      // Coalesced under one key, so typing a name is one undo step rather than
      // one per character.
      commit((theme) => (theme.label === label ? theme : { ...theme, label }), 'label');
    },
    [commit],
  );

  const setBase = useCallback<UseThemeDraftResult['setBase']>(
    (base) => {
      commit((theme) => (theme.base === base ? theme : { ...theme, base }), null);
    },
    [commit],
  );

  const setToken = useCallback<UseThemeDraftResult['setToken']>(
    (token, value) => {
      commit(
        (theme) =>
          theme.overrides[token] === value
            ? theme
            : { ...theme, overrides: { ...theme.overrides, [token]: value } },
        `token:${token}`,
      );
    },
    [commit],
  );

  const clearToken = useCallback<UseThemeDraftResult['clearToken']>(
    (token) => {
      commit((theme) => {
        if (theme.overrides[token] === undefined) return theme;

        /*
         * Rebuilt without the key rather than deleted. `delete` on a computed
         * key is banned by the lint rules for good reasons, and rebuilding
         * from THEMED_TOKENS keeps every key in the new object a real
         * `ThemedToken` without a cast.
         */
        const overrides: Partial<Record<ThemedToken, string>> = {};
        for (const candidate of THEMED_TOKENS) {
          if (candidate === token) continue;
          const value = theme.overrides[candidate];
          if (value !== undefined) overrides[candidate] = value;
        }
        return { ...theme, overrides };
      }, null);
    },
    [commit],
  );

  const clearAllTokens = useCallback(() => {
    commit(
      (theme) => (Object.keys(theme.overrides).length === 0 ? theme : { ...theme, overrides: {} }),
      null,
    );
  }, [commit]);

  const undo = useCallback(() => {
    lastPush.current = null;
    setHistory((current) => {
      if (current === null) return current;
      const previous = current.past.at(-1);
      if (previous === undefined) return current;

      return {
        past: current.past.slice(0, -1),
        present: previous,
        future: [current.present, ...current.future],
      };
    });
  }, []);

  const redo = useCallback(() => {
    lastPush.current = null;
    setHistory((current) => {
      if (current === null) return current;
      const [next, ...rest] = current.future;
      if (next === undefined) return current;

      return { past: [...current.past, current.present], present: next, future: rest };
    });
  }, []);

  const markSaved = useCallback<UseThemeDraftResult['markSaved']>((theme) => {
    // A save ends the coalescing window: the next edit is a new step, not a
    // continuation of whatever was being typed when Save was pressed.
    lastPush.current = null;
    setIsNew(false);
    setSaved(theme);
    // The saved theme carries the id the store assigned, which for a brand new
    // theme is the first time the draft has had one that means anything.
    setHistory((current) => (current === null ? current : { ...current, present: theme }));
  }, []);

  const draft: ThemeDraft | null =
    history === null
      ? null
      : {
          theme: history.present,
          isNew,
          canUndo: history.past.length > 0,
          canRedo: history.future.length > 0,
          isDirty: saved === null || !sameTheme(saved, history.present),
        };

  return {
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
  };
}

/**
 * Value equality for two themes.
 *
 * Written out rather than `JSON.stringify`-compared, because key order is not
 * part of what makes two themes the same and stringify says it is.
 */
export function sameTheme(a: CustomTheme, b: CustomTheme): boolean {
  if (a.id !== b.id || a.label !== b.label || a.base !== b.base) return false;
  return THEMED_TOKENS.every((token) => a.overrides[token] === b.overrides[token]);
}
