import axe, { type AxeResults, type ElementContext, type RunOptions } from 'axe-core';
import { expect } from 'vitest';

/**
 * Rules that cannot produce a meaningful result under jsdom, which has no
 * layout engine and therefore no computed colours or element geometry.
 */
const JSDOM_UNSUPPORTED_RULES: RunOptions = {
  rules: {
    'color-contrast': { enabled: false },
  },
};

function formatViolations(results: AxeResults): string {
  return results.violations
    .map((violation) => {
      const targets = violation.nodes.map((node) => `    at ${node.target.join(', ')}`).join('\n');
      return `  [${violation.impact ?? 'unknown'}] ${violation.id}: ${violation.help}\n${targets}`;
    })
    .join('\n\n');
}

/**
 * Asserts that a rendered subtree has no axe-core accessibility violations.
 *
 * `context` is normally the `container` returned by Testing Library's `render`.
 * Pass `options` to enable or disable individual rules for one assertion.
 */
export async function expectNoAxeViolations(
  context: ElementContext,
  options?: RunOptions,
): Promise<void> {
  const results = await axe.run(context, { ...JSDOM_UNSUPPORTED_RULES, ...options });

  expect(
    results.violations,
    results.violations.length > 0
      ? `Accessibility violations found:\n\n${formatViolations(results)}`
      : undefined,
  ).toHaveLength(0);
}
