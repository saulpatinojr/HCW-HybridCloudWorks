import axe from 'axe-core';
import { expect } from 'vitest';

export { axe };

/**
 * Runs axe-core accessibility checks on a rendered DOM container.
 * Color contrast checking is disabled by default because jsdom lacks layout/styling engine calculations.
 */
export async function runAxe(container, options = {}) {
  return await axe.run(container, {
    rules: {
      'color-contrast': { enabled: false },
      ...options.rules,
    },
    ...options,
  });
}

export function toHaveNoViolations(results) {
  const violations = results.violations || [];
  const pass = violations.length === 0;
  if (pass) {
    return {
      pass: true,
      message: () => 'expected accessibility violations to be present',
    };
  }
  const formattedViolations = violations
    .map(
      (v) =>
        `[${v.impact || 'minor'}] ${v.id}: ${v.description}\n${v.nodes
          .map((n) => `  - ${n.html}\n    ${n.failureSummary}`)
          .join('\n')}`
    )
    .join('\n\n');
  return {
    pass: false,
    message: () =>
      `Expected no accessibility violations, but found ${violations.length}:\n\n${formattedViolations}`,
  };
}

expect.extend({ toHaveNoViolations });
