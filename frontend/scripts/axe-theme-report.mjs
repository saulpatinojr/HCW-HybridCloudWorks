/**
 * The report side of the contrast scanner (axe-theme-scan.mjs): the row it
 * keeps for each route and the Markdown summary it writes. Kept apart from
 * the scanner since #1859 so that a test can check them without loading
 * Playwright, which refuses to be loaded twice in one test worker.
 */

function summarizeNode(node) {
  return {
    target: node.target,
    html: node.html?.slice(0, 240),
    failureSummary: node.failureSummary,
    any: node.any?.map((c) => ({ id: c.id, message: c.message, data: c.data })) ?? [],
  };
}

/**
 * One route's row in the report, from axe's answer. Every contrast failure is
 * kept in full; other rules keep their first three nodes, which is enough to
 * find them.
 */
export function routeResult(theme, route, url, axeResult) {
  const contrastNodes = (
    axeResult.violations.find((v) => v.id === 'color-contrast')?.nodes ?? []
  ).map(summarizeNode);
  return {
    theme,
    route,
    url,
    violations: axeResult.violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      help: v.help,
      helpUrl: v.helpUrl,
      nodeCount: v.nodes.length,
      nodes: v.id === 'color-contrast' ? contrastNodes : v.nodes.slice(0, 3).map(summarizeNode),
    })),
    incomplete: axeResult.incomplete.map((v) => ({
      id: v.id,
      impact: v.impact,
      nodeCount: v.nodes.length,
    })),
    passCount: axeResult.passes.length,
  };
}

/** The row for a route that could not be scanned, with the reason. */
export function errorResult(theme, route, url, err) {
  return {
    theme,
    route,
    url,
    error: err.message,
    violations: [],
    incomplete: [],
    passCount: 0,
  };
}

/** Contrast failure nodes on one row (0 when the rule passed). */
function contrastCount(result) {
  return result.violations.find((v) => v.id === 'color-contrast')?.nodeCount ?? 0;
}

/** The Markdown report: totals, one table row per route, then each contrast failure. */
export function buildMarkdown(results, { startedAt, baseUrl, routeCount, themeCount }) {
  const totalContrast = results.reduce((n, r) => n + contrastCount(r), 0);
  const totalAll = results.reduce(
    (n, r) => n + r.violations.reduce((m, v) => m + v.nodeCount, 0),
    0
  );

  const lines = [];
  lines.push(`# Axe Theme Scan Report`);
  lines.push(``);
  lines.push(`- **Generated:** ${startedAt}`);
  lines.push(`- **Base URL:** ${baseUrl}`);
  lines.push(
    `- **Routes scanned:** ${routeCount} × ${themeCount} themes = ${routeCount * themeCount}`
  );
  lines.push(`- **Total contrast violation nodes:** ${totalContrast}`);
  lines.push(`- **Total violation nodes (all rules):** ${totalAll}`);
  lines.push(``);
  lines.push(`## Per-route summary`);
  lines.push(``);
  lines.push(`| Theme | Route | Contrast | Other | Incomplete |`);
  lines.push(`| ----- | ----- | -------- | ----- | ---------- |`);
  for (const r of results) {
    const other = r.violations
      .filter((v) => v.id !== 'color-contrast')
      .reduce((n, v) => n + v.nodeCount, 0);
    const incomplete = r.incomplete.reduce((n, v) => n + v.nodeCount, 0);
    lines.push(`| ${r.theme} | \`${r.route}\` | ${contrastCount(r)} | ${other} | ${incomplete} |`);
  }

  // Detail section: every contrast failure with selector + colors
  lines.push(``);
  lines.push(`## Color-contrast failures (detailed)`);
  lines.push(``);
  for (const r of results) lines.push(...contrastDetail(r));

  return { markdown: lines.join('\n'), totalContrast, totalAll };
}

/** The detail lines for one route's contrast failures; none when it has none. */
function contrastDetail(r) {
  const contrastViolation = r.violations.find((v) => v.id === 'color-contrast');
  if (!contrastViolation || contrastViolation.nodeCount === 0) return [];
  const lines = [`### ${r.theme} — \`${r.route}\` (${contrastViolation.nodeCount} nodes)`];
  for (const node of contrastViolation.nodes) {
    const data = node.any?.[0]?.data ?? {};
    lines.push(`- \`${(node.target || []).join(' ')}\``);
    if (data.fgColor || data.bgColor || data.contrastRatio) {
      lines.push(
        `  - fg: ${data.fgColor ?? '?'}, bg: ${data.bgColor ?? '?'}, ratio: ${data.contrastRatio ?? '?'}, expected: ${data.expectedContrastRatio ?? '?'}`
      );
    }
    if (node.html) lines.push(`  - \`${node.html.replace(/\s+/g, ' ').slice(0, 160)}\``);
  }
  lines.push(``);
  return lines;
}
