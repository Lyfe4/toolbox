import * as RadixTooltip from '@radix-ui/react-tooltip';

import styles from './Tooltip.module.css';

import type { ReactElement, ReactNode } from 'react';

export interface TooltipProviderProps {
  readonly children: ReactNode;
  /** Hover delay in ms. Keyboard focus always opens immediately. */
  readonly delayDuration?: number;
}

/** Mount once near the root; Radix shares open/close timing across all tooltips. */
export function TooltipProvider({ children, delayDuration = 200 }: TooltipProviderProps) {
  return <RadixTooltip.Provider delayDuration={delayDuration}>{children}</RadixTooltip.Provider>;
}

export interface TooltipProps {
  readonly content: ReactNode;
  /**
   * The trigger. A single element, because Radix clones it to attach handlers
   * and aria-describedby - so it must be one real DOM element, not a fragment.
   */
  readonly children: ReactElement;
  readonly side?: 'top' | 'right' | 'bottom' | 'left';
}

/**
 * Tooltip built on Radix Tooltip.
 *
 * Reachable by keyboard, not hover-only: Radix opens it on focus as well as
 * pointer-enter, closes it on Escape, and wires aria-describedby from trigger
 * to content so the text is announced rather than merely drawn.
 *
 * A tooltip is supplementary by definition. Never put the only name of a
 * control in here - use IconButton's `label` for that.
 */
export function Tooltip({ content, children, side = 'top' }: TooltipProps) {
  return (
    <RadixTooltip.Root>
      <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content className={styles.content} side={side} sideOffset={6}>
          {content}
          <RadixTooltip.Arrow className={styles.arrow} width={8} height={4} />
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  );
}
