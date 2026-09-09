import { cx } from '@/lib/cx';

import styles from './themeEditor.module.css';

import type { ContrastProblem, Measurement } from '../contrast';

/** Why a pair could not be measured, said in words rather than in a code. */
function explainProblem(problem: ContrastProblem): string {
  switch (problem) {
    case 'missing':
      return 'one of these tokens has no value';
    case 'unreadable':
      return 'one of these colours cannot be read';
    case 'translucent':
      return 'a translucent colour has no single ratio';
  }
}

/**
 * One row of the readout.
 *
 * STATE IS NEVER COLOUR ALONE. Each row carries a word - "Pass" or "Fail" - and
 * a glyph, because the whole premise of this panel is that the colours around
 * it may currently be terrible. A row rendered in a theme whose signal colours
 * have collapsed into the background still reads correctly as text.
 */
function ContrastRow({ measurement }: { readonly measurement: Measurement }) {
  const { pair, ratio, threshold, problem, passes } = measurement;

  const verdict = problem !== null ? 'Unknown' : passes ? 'Pass' : 'Fail';
  const detail =
    problem !== null
      ? explainProblem(problem)
      : `${(ratio ?? 0).toFixed(2)}:1, needs ${threshold.toFixed(1)}:1`;

  return (
    <li className={cx(styles.contrastRow, !passes && styles.contrastRowBad)}>
      <span className={styles.contrastVerdict} aria-hidden="true">
        {passes ? '✓' : '✗'}
      </span>
      <span className={styles.contrastLabel}>
        {pair.label}
        <span className={styles.contrastPair}>
          --pb-{pair.foreground} on --pb-{pair.background}
        </span>
      </span>
      <span className={styles.contrastValue}>
        {/*
          The verdict is spoken but not shown: the glyph and the treatment
          carry it visually, and reading "Fail Body text" before the numbers is
          what makes the list scannable with a screen reader.
        */}
        <span className={styles.srOnlyVerdict}>{verdict}. </span>
        {detail}
      </span>
    </li>
  );
}

export interface ContrastReportProps {
  readonly measurements: readonly Measurement[];
  /** Shows only the pairs that fail, which is usually all anyone wants. */
  readonly failuresOnly: boolean;
}

export function ContrastReport({ measurements, failuresOnly }: ContrastReportProps) {
  const shown = failuresOnly ? measurements.filter((one) => !one.passes) : measurements;

  if (shown.length === 0) {
    return (
      <p className={styles.contrastEmpty}>
        {failuresOnly
          ? 'Every pair meets WCAG AA.'
          : 'No pairs to measure, which should be impossible.'}
      </p>
    );
  }

  return (
    <ul className={styles.contrastList}>
      {shown.map((measurement) => (
        <ContrastRow
          key={`${measurement.pair.foreground}/${measurement.pair.background}`}
          measurement={measurement}
        />
      ))}
    </ul>
  );
}
