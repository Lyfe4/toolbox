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

/** Typed access to `notify`. Throws if used outside a ToastProvider. */
export function useToast(): ToastContextValue {
  const context = use(ToastContext);
  if (context === null) {
    throw new Error('useToast must be used inside a <ToastProvider>');
  }
  return context;
}
