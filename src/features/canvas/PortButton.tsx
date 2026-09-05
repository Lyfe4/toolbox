import { Tooltip } from '@/components/Tooltip';
import type { DataType } from '@/features/registry';
import { useIsTruncated } from '@/lib/useIsTruncated';

import styles from './canvas.module.css';
import { describeTypes, PortGlyph } from './PortGlyph';

import type { PortSide } from './geometry';
import type { CSSProperties, PointerEvent } from 'react';

export interface PortButtonProps {
  readonly label: string;
  readonly portId: string;
  readonly types: readonly DataType[];
  readonly side: PortSide;
  readonly connected: boolean;
  readonly className: string;
  readonly style: CSSProperties;
  readonly state: 'held' | 'armed' | 'refused' | 'valid' | 'idle';
  readonly onPointerDown: (event: PointerEvent<HTMLButtonElement>) => void;
}

/**
 * One port: its glyph, its label, and a tooltip when the label does not fit.
 *
 * ITS OWN COMPONENT because of the hook. Measuring truncation is per-port
 * state, and a node cannot call a hook once per port inside a `.map` without
 * promising React that the count never changes. It does not - tools have
 * different port counts, and the node re-renders across them.
 *
 * THE TOOLTIP IS CONDITIONAL, and that is the point rather than an
 * optimisation. `port.label` is already on the button's accessible name in
 * full, so a tooltip adds nothing for a label you can read; attaching one to
 * every port would put a hover card on "Input" and "Digest" and teach people
 * that these tooltips are not worth waiting for.
 *
 * THE TRIGGER IS THE BUTTON, not the label span. Radix opens a tooltip on
 * focus as well as hover, and only a focusable element can be focused - so
 * wrapping the span would quietly make this hover-only. (Ports carry
 * `tabIndex={-1}`: Tab walks nodes, and `C` on a focused node opens the
 * connect dialog, which lists every port by its full name. So focus reaches
 * ports programmatically rather than by tabbing, and the tooltip is ready for
 * it either way.)
 *
 * ON TOUCH there is no hover and Radix does not open on tap, which is the
 * behaviour we want: a port's primary gesture is dragging a wire out of it,
 * and a card appearing under the finger that starts a drag would be in the
 * way. The full label stays available through the connect dialog.
 */
export function PortButton({
  label,
  portId,
  types,
  side,
  connected,
  className,
  style,
  state,
  onPointerDown,
}: PortButtonProps) {
  const { ref: labelRef, truncated } = useIsTruncated(label);

  const button = (
    <button
      type="button"
      tabIndex={-1}
      className={className}
      style={style}
      data-port-id={portId}
      data-port-side={side}
      data-port-state={state}
      // Always the FULL label, however little of it is drawn. Truncation is a
      // fact about the box, not about the name of the thing.
      aria-label={
        side === 'input'
          ? `Input ${label}, accepts ${describeTypes(types)}`
          : `Output ${label}, carries ${describeTypes(types)}`
      }
      onPointerDown={onPointerDown}
    >
      {/*
        A real element rather than a border or an outline, so the state rings
        hold their space and nothing reflows when one appears. It is also what
        carries held/armed/valid SHAPE-wise, which is what keeps these states
        legible without colour.
      */}
      <span className={styles.portHalo} aria-hidden="true" />
      <PortGlyph types={types} connected={connected} className={styles.portConnector} />
      <span ref={labelRef} className={styles.portLabel}>
        {label}
      </span>
    </button>
  );

  if (!truncated) return button;

  return (
    <Tooltip content={label} side={side === 'input' ? 'left' : 'right'}>
      {button}
    </Tooltip>
  );
}
