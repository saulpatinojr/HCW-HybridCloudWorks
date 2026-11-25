/**
 * The report side of the contrast scanner (#1859). The scan itself needs a
 * running site and a browser, so it is not run here; what is held is what
 * the scanner writes from axe's answers: the row per route and the Markdown
 * report. The scanner's main function was split into smaller ones in #1859
 * to meet the linter's complexity limit, and these tests were written to
 * hold the report exactly as the single function wrote it.
 *
 * The helpers live in axe-theme-report.mjs, which loads no Playwright: the
 * scanner itself starts a browser as soon as it is loaded. Node environment,
 * because nothing here touches a page.
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import { buildMarkdown, errorResult, routeResult } from './axe-theme-report.mjs';

const node = (n, extra = {}) => ({
  target: [`#n${n}`],
  html: `<p   id="n${n}">\n  text</p>`,
  failureSummary: `fix ${n}`,
  any: [{ id: 'color-contrast', message: 'm', data: {} }],
  ...extra,
});

const axeAnswer = {
  violations: [
    {
      id: 'color-contrast',
      impact: 'serious',
      help: 'Contrast',
      helpUrl: 'https://example.test/contrast',
      nodes: [
        node(1, {
          any: [
            {
              id: 'color-contrast',
              message: 'low',
              data: {
                fgColor: '#777',
                bgColor: '#fff',
                contrastRatio: 4.48,
                expectedContrastRatio: '4.5:1',
              },
            },
          ],
        }),
        node(2),
        node(3),
        node(4, { html: undefined, target: undefined }),
      ],
    },
    {
      id: 'image-alt',
      impact: 'critical',
      help: 'Alt',
      helpUrl: 'https://example.test/alt',
      nodes: [node(5), node(6), node(7), node(8)],
    },
  ],
  incomplete: [{ id: 'x', impact: 'minor', nodes: [node(9), node(10)] }],
  passes: [{}, {}, {}],
};

describe('routeResult', () => {
  it('keeps every contrast node and the first three of any other rule', () => {
    const row = routeResult('dark', '/about', 'http://h/about', axeAnswer);
    expect(row).toMatchObject({
      theme: 'dark',
      route: '/about',
      url: 'http://h/about',
      passCount: 3,
      incomplete: [{ id: 'x', impact: 'minor', nodeCount: 2 }],
    });
    expect(row.violations.map((v) => [v.id, v.nodeCount, v.nodes.length])).toEqual([
      ['color-contrast', 4, 4],
      ['image-alt', 4, 3],
    ]);
    expect(row.violations[0]).toMatchObject({
      impact: 'serious',
      help: 'Contrast',
      helpUrl: 'https://example.test/contrast',
    });
    expect(row.violations[1].nodes[0]).toEqual({
      target: ['#n5'],
      html: '<p   id="n5">\n  text</p>',
      failureSummary: 'fix 5',
      any: [{ id: 'color-contrast', message: 'm', data: {} }],
    });
  });

  it('writes a route that could not be scanned as an empty row with the reason', () => {
    expect(errorResult('light', '/x', 'http://h/x', new Error('timed out'))).toEqual({
      theme: 'light',
      route: '/x',
      url: 'http://h/x',
      error: 'timed out',
      violations: [],
      incomplete: [],
      passCount: 0,
    });
  });
});

describe('buildMarkdown', () => {
  it('writes the totals, a row per route and the detail of each contrast failure', () => {
    const results = [
      routeResult('light', '/', 'http://h/', axeAnswer),
      errorResult('dark', '/admin', 'http://h/admin', new Error('no')),
    ];
    const { markdown, totalContrast, totalAll } = buildMarkdown(results, {
      startedAt: '2026-11-25T00:00:00Z',
      baseUrl: 'http://h',
      routeCount: 3,
      themeCount: 2,
    });
    expect(totalContrast).toBe(4);
    expect(totalAll).toBe(8);
    const lines = markdown.split('\n');
    expect(lines[0]).toBe('# Axe Theme Scan Report');
    expect(lines[2]).toBe('- **Generated:** 2026-11-25T00:00:00Z');
    expect(lines[3]).toBe('- **Base URL:** http://h');
    expect(lines[4]).toBe('- **Routes scanned:** 3 × 2 themes = 6');
    expect(lines.slice(5)).toEqual([
      '- **Total contrast violation nodes:** 4',
      '- **Total violation nodes (all rules):** 8',
      '',
      '## Per-route summary',
      '',
      '| Theme | Route | Contrast | Other | Incomplete |',
      '| ----- | ----- | -------- | ----- | ---------- |',
      '| light | `/` | 4 | 4 | 2 |',
      '| dark | `/admin` | 0 | 0 | 0 |',
      '',
      '## Color-contrast failures (detailed)',
      '',
      '### light — `/` (4 nodes)',
      '- `#n1`',
      '  - fg: #777, bg: #fff, ratio: 4.48, expected: 4.5:1',
      '  - `<p id="n1"> text</p>`',
      '- `#n2`',
      '  - `<p id="n2"> text</p>`',
      '- `#n3`',
      '  - `<p id="n3"> text</p>`',
      '- ``',
      '',
    ]);
  });
});
