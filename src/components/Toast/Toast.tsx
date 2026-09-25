import * as RadixToast from '@radix-ui/react-toast';
import {
  createContext,
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { Button } from '@/components/Button';
import { CheckIcon, CloseIcon, ErrorIcon, InfoIcon, WarningIcon } from '@/components/Icon';
import { IconButton } from '@/components/IconButton';
import { cx } from '@/lib/cx';
import { useMediaQuery } from '@/lib/useMediaQuery';

import { NARROW_TOASTS } from './clearance';
import styles from './Toast.module.css';

export type ToastTone = 'info' | 'ok' | 'warn' | 'error';

/**
 * ONE CONTROL A TOAST MAY CARRY, AND WHY IT IS WORTH THE PROP.
 *
 * A destructive action needs its reversal visible at the moment it happens,
 * not discoverable later. The canvas has had undo since it had a history, and
 * a visible Undo in the toolbar - but on a phone the toolbar collapses and
 * undo moves into an overflow menu, so the recovery from a tap that deleted
 * the wrong node was three taps away behind a control that says nothing about
 * deletion. Putting it in the notification that reports the deletion is what
 * makes "you can take that back" a fact the user is told rather than one they
 * have to already know.
 *
 * `altText` IS REQUIRED, AND IT IS NOT A LABEL. Radix reads it to screen
 * readers in the announcement as the way to describe an alternative to the
 * control, which a live region cannot be clicked through - "press F8 then
 * Undo", not "Undo".
 */
export interface ToastAction {
  /** The visible word on the control. */
  readonly label: string;
  /** How to achieve the same thing without reaching the toast. */
  readonly altText: string;
  readonly onAction: () => void;
}

/** What a caller passes to `notify`. The id is assigned by the provider. */
export interface ToastInput {
  readonly title: string;
  readonly description?: string;
  readonly tone?: ToastTone;
  readonly action?: ToastAction;
}

interface ToastRecord extends ToastInput {
  readonly id: string;
  readonly tone: ToastTone;
  /** Milliseconds of un-paused time before this one takes itself down. */
  readonly lifetime: number;
}

interface ToastContextValue {
  readonly notify: (toast: ToastInput) => void;
}

/**
 * `null` is the "no provider above me" sentinel. useToast checks for it and
 * throws a useful error, which beats a confusing crash deep inside a handler.
 */
const ToastContext = createContext<ToastContextValue | null>(null);

const TONE_ICONS: Record<ToastTone, ReactNode> = {
  info: <InfoIcon size={14} />,
  ok: <CheckIcon size={14} />,
  warn: <WarningIcon size={14} />,
  error: <ErrorIcon size={14} />,
};

/**
 * HOW LONG EACH KIND STAYS UP, and the question behind the numbers.
 *
 * The split is not by severity. It is by what the reader has to DO with the
 * message before it is safe to take it away.
 *
 *  1. NOTICE IT. `Copied`, `Downloaded`, `Theme applied` - the effect is
 *     already visible somewhere else, so the toast is a receipt. Missing one
 *     costs nothing. Six seconds.
 *
 *  2. READ IT AND DECIDE. Every refusal and every caveat: `Connection
 *     refused`, `File rejected`, `Nothing to drop that on`, `Theme saved with
 *     failing contrast`. These carry the REASON something did not happen the
 *     way it was asked for, and they are the durable copy of it - the canvas
 *     has one polite live region shared with the pipeline, so a refusal can be
 *     overwritten by "Pipeline finished" a few hundred milliseconds later.
 *     Twice the receipt, because reading a sentence and working out what to do
 *     about it is not the same act as noticing a word.
 *
 *     `warn` sits with `error` here rather than with the receipts, which is
 *     the one row that changed for a reason other than the bug: `File
 *     rejected` is an error and `Nothing to drop that on` is a warning, they
 *     are the same sentence to the person reading them, and there is no
 *     defending one lasting half as long as the other.
 *
 *  3. REACH IT - see ACTION_LIFETIME.
 */
const TONE_LIFETIME: Record<ToastTone, number> = {
  info: 6_000,
  ok: 6_000,
  warn: 12_000,
  error: 12_000,
};

/**
 * THE FLOOR FOR A TOAST THAT CARRIES A CONTROL.
 *
 * An offer is not read, it is TAKEN, and the window has to cover the whole
 * approach: notice that something was deleted, understand that the thing
 * beside it undoes that, and get a pointer or a focus ring onto it. On a phone
 * that is a thumb travelling to a control that was not there a moment ago; on
 * a keyboard it is noticing, remembering that F8 exists, and pressing it -
 * the viewport is last in the tab order, so F8 is the only way in that is not
 * a walk through the whole page.
 *
 * Twenty seconds, and the figure is borrowed rather than invented: WCAG 2.2.1
 * draws its line at twenty, treating any limit at or under it as one the user
 * has to be given a way out of. It is the smallest number this repo can point
 * at and say the reader was not being raced.
 *
 * It is enough, rather than merely generous, BECAUSE THE COUNTDOWN STOPS WHEN
 * THE VIEWPORT IS REACHED. Hovering it, or focusing anything inside it,
 * freezes every countdown - so the twenty seconds only has to cover ARRIVING.
 * Reading, deciding and pressing all happen with the clock stopped. That is
 * the whole argument for a bounded lifetime over a permanent one.
 *
 * And permanent was the tempting answer, so it is worth saying why it is
 * wrong: a toast that never leaves turns four deletions into four
 * notifications closed by hand, which is the complaint this change exists to
 * fix. The offer is also not the only way back - Ctrl+Z is, and `altText`
 * says so to the people who cannot reach the button at all.
 */
const ACTION_LIFETIME = 20_000;

/**
 * HOW MANY MAY BE ON SCREEN AT ONCE.
 *
 * The viewport is 320px wide, pinned to the bottom-right corner, and stacks
 * upwards over the canvas. Unbounded, five deletions in a row is a column of
 * notifications tall enough to cover the node the sixth one is about - the
 * feedback for what the user is doing now hidden by the feedback for what they
 * did a moment ago, which is exactly backwards.
 *
 * Three, oldest evicted, and an offer somebody has walked past while
 * performing three more actions has been declined in every sense that
 * matters; Ctrl+Z is still there for the one who changes their mind.
 *
 * TWO BELOW `NARROW_TOASTS`, where the stack is a band across the full width
 * of the canvas rather than a column beside it. There every notification
 * covers the canvas edge to edge, so each one costs a whole strip of the
 * thing being worked on. Two single-line notifications are 72px of a 794px
 * canvas at 390px under a mouse and 112px under a finger, where every
 * control is 44px tall; three of the old ones were 214px.
 * Evicted rather than hidden, the same rule as above: nothing is kept counting
 * down where nobody can see or reach it.
 */
const MAX_ON_SCREEN = 3;
const MAX_ON_SCREEN_NARROW = 2;

/** A running countdown. `handle` is 0 when it is frozen or not yet started. */
interface Countdown {
  remaining: number;
  startedAt: number;
  handle: number;
}

export interface ToastProviderProps {
  readonly children: ReactNode;
}

/**
 * Announces asynchronous results to screen readers.
 *
 * Radix Toast owns the live region, which is the part that is easy to get
 * wrong: the region has to exist in the DOM before the message is inserted, or
 * assistive technology never notices the change. Errors go in as `foreground`
 * (aria-live="assertive") so they interrupt; everything else is `background`
 * (polite) and waits its turn.
 *
 * WHAT IT NO LONGER BORROWS FROM RADIX IS THE CLOCK, and that is a bug fix
 * rather than a preference. Radix keeps ONE pause flag for the whole provider,
 * raises it on the first `pointermove` or `focusin` over the viewport, and
 * lowers it on the matching `pointerleave` or `focusout` - but it only has
 * those listeners attached while at least one toast exists. Press the dismiss
 * button and the pointer is, necessarily, over the toast: the flag goes up,
 * the last toast leaves, the listeners come down in the same commit, and the
 * `pointerleave` that would have lowered it arrives at nothing. Every toast
 * after that mounts into a provider that believes it is paused, and starts no
 * timer at all.
 *
 * It sustains itself, which is why it presents as permanent rather than
 * intermittent: the only way to clear a toast with no timer is to press
 * dismiss, and pressing dismiss is what re-arms the leak.
 *
 * The one thing that lowers the flag again is a `pointerleave` or a window
 * refocus that arrives WHILE some toast exists - so on a desktop it reads as
 * "the notification sits there until I happen to sweep the mouse across it",
 * and on a phone, or from the keyboard, where no pointer ever crosses the
 * viewport, it reads as "notifications stopped timing out".
 *
 * So the countdown lives here, and the pause condition is DERIVED rather than
 * latched: focus-inside and tab-hidden are read from the DOM at the moment
 * they are needed and cannot go stale. Only "the pointer is over the viewport"
 * has to be remembered, because nothing can be asked where the pointer is -
 * and that one is cleared whenever the viewport empties, since an empty
 * viewport is not something anybody can be hovering.
 */
export function ToastProvider({ children }: ToastProviderProps) {
  const [toasts, setToasts] = useState<readonly ToastRecord[]>([]);
  // A plain counter, so ids are deterministic and tests never flake.
  const nextId = useRef(0);
  const viewportRef = useRef<HTMLOListElement>(null);
  const countdowns = useRef(new Map<string, Countdown>());
  const pointerInside = useRef(false);
  const narrow = useMediaQuery(NARROW_TOASTS);
  const limit = narrow ? MAX_ON_SCREEN_NARROW : MAX_ON_SCREEN;
  const [appliedLimit, setAppliedLimit] = useState(limit);

  // Narrowing the window with three up takes the oldest down, like a fourth
  // would. Decided during render, so no frame shows three in a two-wide band.
  if (appliedLimit !== limit) {
    setAppliedLimit(limit);
    if (toasts.length > limit) setToasts(toasts.slice(-limit));
  }

  const notify = useCallback(
    (toast: ToastInput) => {
      nextId.current += 1;
      const id = `toast-${nextId.current.toString()}`;
      const tone = toast.tone ?? 'info';
      // The longer of the two, so an actionable error is not cut to the action
      // floor and an actionable receipt is not cut to the tone default.
      const lifetime =
        toast.action === undefined
          ? TONE_LIFETIME[tone]
          : Math.max(TONE_LIFETIME[tone], ACTION_LIFETIME);
      setToasts((current) => [...current, { ...toast, id, tone, lifetime }].slice(-limit));
    },
    [limit],
  );

  const dismiss = useCallback((id: string) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  /*
   * Everything that stops the clock, asked fresh every time it is needed.
   *
   * `document.hidden` rather than a window blur listener: a hidden tab is the
   * mechanism that actually costs somebody a message - its timers are
   * throttled and the toast burns its life where nobody can see it - and it is
   * the one that can be observed without guessing. A blurred window is not the
   * same thing, and pausing on it would leave a toast sitting there because
   * the user glanced at another application.
   */
  const isPaused = useCallback((): boolean => {
    const viewport = viewportRef.current;
    if (viewport === null) return false;
    return pointerInside.current || viewport.contains(document.activeElement) || document.hidden;
  }, []);

  /** Freeze or run every countdown, to match whatever is true right now. */
  const sync = useCallback(() => {
    const paused = isPaused();
    const now = Date.now();
    for (const [id, countdown] of countdowns.current) {
      if (paused) {
        if (countdown.handle === 0) continue;
        window.clearTimeout(countdown.handle);
        countdown.handle = 0;
        countdown.remaining = Math.max(0, countdown.remaining - (now - countdown.startedAt));
      } else {
        if (countdown.handle !== 0) continue;
        countdown.startedAt = now;
        countdown.handle = window.setTimeout(() => {
          dismiss(id);
        }, countdown.remaining);
      }
    }
  }, [dismiss, isPaused]);

  /*
   * One countdown per toast on screen, created and destroyed with it.
   *
   * Reconciled from the rendered list rather than started inside `notify`, so
   * that a toast evicted by the cap takes its timer with it and no path can
   * leave a timer running against an id that is no longer on screen.
   */
  useEffect(() => {
    const running = countdowns.current;
    for (const toast of toasts) {
      if (running.has(toast.id)) continue;
      running.set(toast.id, { remaining: toast.lifetime, startedAt: 0, handle: 0 });
    }
    for (const [id, countdown] of running) {
      if (toasts.some((toast) => toast.id === id)) continue;
      window.clearTimeout(countdown.handle);
      running.delete(id);
    }
    // THE LINE THAT CLOSES THE LEAK described above. An empty viewport cannot
    // be hovered, so a pointer that left while the DOM under it was being
    // removed can no longer strand every toast that comes after it.
    if (running.size === 0) pointerInside.current = false;
    sync();
  }, [toasts, sync]);

  /*
   * `pointermove` rather than `pointerenter`, for the reason Radix uses it: a
   * toast that appears under a stationary cursor does not reliably get a
   * boundary event in every engine, and a move is what says somebody is
   * actually there.
   *
   * `focusin` on the document rather than `focusout` on the viewport, because
   * `focusout` fires BEFORE the new element is focused - `activeElement` still
   * reads as the control being left, so a countdown would stay frozen after
   * focus had already gone. Radix works around that with `relatedTarget`,
   * which is null both for a click on unfocusable chrome and for focus leaving
   * the document; reading the DOM after the move has landed needs no such
   * special case.
   */
  useEffect(() => {
    const viewport = viewportRef.current;
    if (viewport === null) return undefined;

    const enter = () => {
      pointerInside.current = true;
      sync();
    };
    const leave = () => {
      pointerInside.current = false;
      sync();
    };
    viewport.addEventListener('pointermove', enter);
    viewport.addEventListener('pointerleave', leave);
    document.addEventListener('focusin', sync);
    document.addEventListener('visibilitychange', sync);
    return () => {
      viewport.removeEventListener('pointermove', enter);
      viewport.removeEventListener('pointerleave', leave);
      document.removeEventListener('focusin', sync);
      document.removeEventListener('visibilitychange', sync);
    };
  }, [sync]);

  // Clear every pending timeout if the provider itself goes away.
  useEffect(() => {
    const running = countdowns.current;
    return () => {
      for (const countdown of running.values()) window.clearTimeout(countdown.handle);
      running.clear();
    };
  }, []);

  // useMemo keeps the context value referentially stable, so consumers do not
  // re-render every time a toast is added or removed.
  const value = useMemo<ToastContextValue>(() => ({ notify }), [notify]);

  return (
    <ToastContext value={value}>
      {/*
        `duration={Infinity}` switches Radix's own timer off - see the note on
        ToastProvider for why it cannot be trusted. Radix still owns the live
        region, the F8 hotkey, the focus loop and the swipe; only the clock
        moved.
      */}
      <RadixToast.Provider duration={Infinity} swipeDirection="right">
        {children}

        {toasts.map((toast) => (
          <RadixToast.Root
            key={toast.id}
            className={cx(styles.toast, styles[toast.tone])}
            type={toast.tone === 'error' ? 'foreground' : 'background'}
            onOpenChange={(open) => {
              if (!open) dismiss(toast.id);
            }}
          >
            <span className={styles.icon}>{TONE_ICONS[toast.tone]}</span>
            <div className={styles.text}>
              <RadixToast.Title className={styles.title}>{toast.title}</RadixToast.Title>
              {toast.description !== undefined ? (
                <RadixToast.Description className={styles.description}>
                  {toast.description}
                </RadixToast.Description>
              ) : null}
              {toast.action !== undefined ? (
                /*
                 * `asChild`, so the control is the application's own Button
                 * and not a second button style that only appears here. Radix
                 * closes the toast after the action runs, which is right: the
                 * offer has been taken and leaving it on screen invites a
                 * second press that would undo something else.
                 */
                <RadixToast.Action asChild altText={toast.action.altText} className={styles.action}>
                  <Button size="sm" variant="ghost" onClick={toast.action.onAction}>
                    {toast.action.label}
                  </Button>
                </RadixToast.Action>
              ) : null}
            </div>
            <RadixToast.Close asChild>
              <IconButton label="Dismiss notification" size="sm" icon={<CloseIcon size={12} />} />
            </RadixToast.Close>
          </RadixToast.Root>
        ))}

        <RadixToast.Viewport ref={viewportRef} className={styles.viewport} label="Notifications" />
      </RadixToast.Provider>
    </ToastContext>
  );
}

/** Typed access to `notify`. Throws if used outside a ToastProvider. */
export function useToast(): ToastContextValue {
  const context = use(ToastContext);
  if (context === null) {
    throw new Error('useToast must be used inside a <ToastProvider>');
  }
  return context;
}
