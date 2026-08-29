import type { DataType } from '@/features/registry';

/**
 * Data-type indicators, encoded as SHAPE.
 *
 * Colour alone would be unreadable for the ~8% of men with a colour vision
 * deficiency, and it disappears entirely in Windows forced-colors mode where
 * the OS replaces every colour we choose. So each data type gets a distinct
 * silhouette instead, and colour is only ever a secondary reinforcement.
 *
 * A port that accepts several types shows the "multi" glyph rather than
 * guessing which one to display, and names all of them in its label.
 */
const SIZE = 11;

function shapeFor(type: DataType): string {
  switch (type) {
    case 'text':
      // Square.
      return 'M 2 2 H 9 V 9 H 2 Z';
    case 'json':
      // Diamond.
      return 'M 5.5 1.5 L 9.5 5.5 L 5.5 9.5 L 1.5 5.5 Z';
    case 'bytes':
      // Circle, drawn as two arcs.
      return 'M 1.5 5.5 A 4 4 0 1 0 9.5 5.5 A 4 4 0 1 0 1.5 5.5 Z';
    case 'image':
      // Triangle.
      return 'M 5.5 1.5 L 10 9.5 L 1 9.5 Z';
    case 'color':
      // Hexagon.
      return 'M 5.5 1.5 L 9.5 3.5 L 9.5 7.5 L 5.5 9.5 L 1.5 7.5 L 1.5 3.5 Z';
    case 'datetime':
      // Half-round: flat left edge, domed right.
      return 'M 2 1.5 H 5.5 A 4 4 0 0 1 5.5 9.5 H 2 Z';
  }
}

export interface PortGlyphProps {
  readonly types: readonly DataType[];
  /** Filled when the port has a connection, hollow when free. */
  readonly connected: boolean;
  // `| undefined` because a CSS Module lookup is `string | undefined` under
  // noUncheckedIndexedAccess, and exactOptionalPropertyTypes rejects the
  // implicit form.
  readonly className?: string | undefined;
}

export function PortGlyph({ types, connected, className }: PortGlyphProps) {
  const first = types[0];
  const multi = types.length > 1;

  return (
    <svg
      width={SIZE}
      height={SIZE}
      viewBox={`0 0 ${SIZE.toString()} ${SIZE.toString()}`}
      fill={connected ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={1.25}
      strokeLinejoin="miter"
      /* The port's own label already names the types, so the glyph would only
         duplicate it. */
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      {multi ? (
        // Two offset squares: "more than one type accepted here".
        <>
          <path d="M 1.5 1.5 H 7 V 7 H 1.5 Z" />
          <path d="M 4 4 H 9.5 V 9.5 H 4 Z" />
        </>
      ) : (
        <path d={first === undefined ? '' : shapeFor(first)} />
      )}
    </svg>
  );
}

/** Human description of a port's accepted types, for its accessible label. */
export function describeTypes(types: readonly DataType[]): string {
  if (types.length === 1) return types[0] ?? '';
  return `${types.slice(0, -1).join(', ')} or ${types[types.length - 1] ?? ''}`;
}
