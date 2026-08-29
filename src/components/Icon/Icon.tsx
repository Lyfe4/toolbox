import type { ReactNode } from 'react';

/**
 * Hand-drawn icon set. Every glyph is built on a 24x24 grid with a 1.5px
 * stroke, square caps and mitred joins - the geometry of engraved panel
 * markings rather than a rounded UI icon set.
 *
 * No icon font and no emoji: both would either need a network request or hand
 * control of the shapes to the user's OS.
 */
export interface IconProps {
  /** Rendered size in px. Defaults to 16, which sits on the 8px grid. */
  readonly size?: number;
  readonly className?: string;
}

interface IconBaseProps extends IconProps {
  readonly children: ReactNode;
}

function IconBase({ size = 16, className, children }: IconBaseProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="square"
      strokeLinejoin="miter"
      /* Icons are always decorative here: every control that uses one also
         carries a real text label or an aria-label, so exposing the SVG to a
         screen reader would only produce a duplicate announcement. */
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      {children}
    </svg>
  );
}

export function ChevronDownIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M5 9 L12 16 L19 9" />
    </IconBase>
  );
}

export function ChevronRightIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M9 5 L16 12 L9 19" />
    </IconBase>
  );
}

export function CheckIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M4 12.5 L9.5 18 L20 6" />
    </IconBase>
  );
}

export function CloseIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M5 5 L19 19" />
      <path d="M19 5 L5 19" />
    </IconBase>
  );
}

export function PlusIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M12 4 L12 20" />
      <path d="M4 12 L20 12" />
    </IconBase>
  );
}

export function MinusIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M4 12 L20 12" />
    </IconBase>
  );
}

export function InfoIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <rect x="3" y="3" width="18" height="18" />
      <path d="M12 10.5 L12 17" />
      <path d="M12 7 L12 8.5" />
    </IconBase>
  );
}

export function WarningIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M12 3 L22 20.5 L2 20.5 Z" />
      <path d="M12 9.5 L12 15" />
      <path d="M12 17 L12 18.5" />
    </IconBase>
  );
}

export function ErrorIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <rect x="3" y="3" width="18" height="18" />
      <path d="M8 8 L16 16" />
      <path d="M16 8 L8 16" />
    </IconBase>
  );
}

export function CopyIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <rect x="8" y="8" width="13" height="13" />
      <path d="M16 4 L3 4 L3 17" />
    </IconBase>
  );
}

export function SlidersIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M4 7 L20 7" />
      <path d="M4 17 L20 17" />
      <rect x="7" y="4" width="4" height="6" />
      <rect x="14" y="14" width="4" height="6" />
    </IconBase>
  );
}

export function SignalIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M2 16 L6 16 L9 6 L13 20 L16 12 L18 12 L22 12" />
    </IconBase>
  );
}

export function SearchIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <circle cx="11" cy="11" r="7" />
      <path d="M16 16 L21 21" />
    </IconBase>
  );
}

export function PortIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="2.5" />
    </IconBase>
  );
}
