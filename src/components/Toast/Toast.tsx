import * as RadixToast from '@radix-ui/react-toast';
import { createContext, use, useCallback, useMemo, useRef, useState, type ReactNode } from 'react';

import { CheckIcon, CloseIcon, ErrorIcon, InfoIcon, WarningIcon } from '@/components/Icon';
import { IconButton } from '@/components/IconButton';
import { cx } from '@/lib/cx';

import styles from './Toast.module.css';

export type ToastTone = 'info' | 'ok' | 'warn' | 'error';

/** What a caller passes to `notify`. The id is assigned by the provider. */
export interface ToastInput {
  readonly title: string;
  readonly description?: string;
  readonly tone?: ToastTone;
}

interface ToastRecord extends ToastInput {
  readonly id: string;
  readonly tone: ToastTone;
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

export interface ToastProviderProps {
  readonly children: ReactNode;
  /** Milliseconds a toast stays up before dismissing itself. */
  readonly duration?: number;
}

/**
 * How long each tone stays up.
 *
 * An error is the durable copy of something the live region may already have
 * lost - the canvas has one polite region shared with the pipeline, so a
 * connection refusal can be overwritten a few hundred milliseconds later by
 * "Pipeline finished". Six seconds is fine for "Copied"; it is not long
 * enough to read a refusal, decide what to do, and reach the toast. Errors
 * therefore stay twice as long.
 *
 * Nothing here is a substitute for being able to summon it: Radix binds F8 to
 * move focus to the toast viewport, which is listed in the shortcuts
 * reference so it is discoverable rather than folklore.
 */
const TONE_DURATION: Partial<Record<ToastTone, number>> = {
  error: 12_000,
};

/**
 * Announces asynchronous results to screen readers.
 *
 * Radix Toast owns the live region, which is the part that is easy to get
 * wrong: the region has to exist in the DOM before the message is inserted, or
 * assistive technology never notices the change. Errors go in as `foreground`
 * (aria-live="assertive") so they interrupt; everything else is `background`
 * (polite) and waits its turn.
 */
export function ToastProvider({ children, duration = 6000 }: ToastProviderProps) {
  const [toasts, setToasts] = useState<readonly ToastRecord[]>([]);
  // A plain counter, so ids are deterministic and tests never flake.
  const nextId = useRef(0);

  const notify = useCallback((toast: ToastInput) => {
    nextId.current += 1;
    const id = `toast-${nextId.current.toString()}`;
    setToasts((current) => [...current, { ...toast, id, tone: toast.tone ?? 'info' }]);
  }, []);

  const dismiss = useCallback((id: string) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  // useMemo keeps the context value referentially stable, so consumers do not
  // re-render every time a toast is added or removed.
  const value = useMemo<ToastContextValue>(() => ({ notify }), [notify]);

  return (
    <ToastContext value={value}>
      <RadixToast.Provider duration={duration} swipeDirection="right">
        {children}

        {toasts.map((toast) => (
          <RadixToast.Root
            key={toast.id}
            className={cx(styles.toast, styles[toast.tone])}
            type={toast.tone === 'error' ? 'foreground' : 'background'}
            {...durationFor(toast.tone)}
            onOpenChange={(open) => {
              if (!open) dismiss(toast.id);
            }}
          >
            <span className={styles.icon}>{TONE_ICONS[toast.tone]}</span>
            <div>
              <RadixToast.Title className={styles.title}>{toast.title}</RadixToast.Title>
              {toast.description !== undefined ? (
                <RadixToast.Description className={styles.description}>
                  {toast.description}
                </RadixToast.Description>
              ) : null}
            </div>
            <RadixToast.Close asChild>
              <IconButton label="Dismiss notification" size="sm" icon={<CloseIcon size={12} />} />
            </RadixToast.Close>
          </RadixToast.Root>
        ))}

        <RadixToast.Viewport className={styles.viewport} label="Notifications" />
      </RadixToast.Provider>
    </ToastContext>
  );
}

/**
 * The duration override for a tone, as props to spread.
 *
 * Spread rather than passed as `duration={...}` because
 * `exactOptionalPropertyTypes` refuses an explicit `undefined` for an
 * optional prop - and omitting it is exactly what "use the provider default"
 * has to mean.
 */
function durationFor(tone: ToastTone): { duration?: number } {
  const duration = TONE_DURATION[tone];
  return duration === undefined ? {} : { duration };
}

/** Typed access to `notify`. Throws if used outside a ToastProvider. */
export function useToast(): ToastContextValue {
  const context = use(ToastContext);
  if (context === null) {
    throw new Error('useToast must be used inside a <ToastProvider>');
  }
  return context;
}
