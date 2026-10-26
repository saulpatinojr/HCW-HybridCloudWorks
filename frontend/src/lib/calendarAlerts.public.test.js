/**
 * Calendar alerts are the owner's private notes. Nothing a visitor loads, and
 * nothing the build writes into the public site, may reach them.
 *
 * Three guards, because each fails differently:
 *
 *   1. No PUBLIC ENTRY POINT (and not the application root) statically
 *      imports the alerts' code. A static import is resolved by the bundler
 *      before any role check could run, so a "gated" import in a public
 *      graph is still downloaded by every visitor. The pop-up is reached
 *      only through a dynamic import() inside the admin layout, which this
 *      walk deliberately does not follow, exactly as
 *      msal-not-on-public-routes.test.js does not.
 *   2. Only the admin portal's own files name the alerts' API route.
 *   3. The build (prerender and data scripts) and the static assets never
 *      mention them, so no manifest, sitemap or prerendered page can.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

// process.cwd(), as msal-not-on-public-routes.test.js explains: Vitest runs from the package root.
const ROOT = process.cwd();
const SRC = resolve(ROOT, 'src');

const PUBLIC_ENTRIES = [
  'App.jsx',
  'main.jsx',
  'pages/shared/NewsPage.jsx',
  'pages/shared/HomePage.jsx',
  'pages/azure/BlogPage.jsx',
  'pages/aws/BlogPage.jsx',
  'components/templates/BlogDetailTemplate.jsx',
  'components/templates/ContentListingTemplate.jsx',
  'hooks/useBlogData.js',
  'lib/publicApi.js',
  'lib/api.js',
];

const ALERT_MODULE = /(^|\/)calendarAlerts(Ics|Link)?(\.js)?$|calendar-alerts\//;
const EXTENSIONS = ['', '.js', '.jsx', '.ts', '.tsx', '/index.js', '/index.jsx'];

function resolveSpecifier(specifier, fromFile) {
  let base;
  if (specifier.startsWith('@/')) base = join(SRC, specifier.slice(2));
  else if (specifier.startsWith('.')) base = resolve(dirname(fromFile), specifier);
  else return null;
  for (const ext of EXTENSIONS) {
    const candidate = base + ext;
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function staticImportsOf(file) {
  const source = readFileSync(file, 'utf8');
  const specifiers = [];
  for (const match of source.matchAll(/^\s*(?:import|export)\s[^;]*?\sfrom\s*['"]([^'"]+)['"]/gm)) {
    specifiers.push(match[1]);
  }
  for (const match of source.matchAll(/^\s*import\s*['"]([^'"]+)['"]/gm)) specifiers.push(match[1]);
  return specifiers;
}

/** The first static import path from `entry` that reaches the alerts' code, or null. */
function pathToAlerts(entry) {
  const start = join(SRC, entry);
  const seen = new Set([start]);
  const queue = [[start]];
  while (queue.length > 0) {
    const path = queue.shift();
    const file = path[path.length - 1];
    for (const specifier of staticImportsOf(file)) {
      if (ALERT_MODULE.test(specifier)) {
        return [...path, specifier].map((p) => String(p).replace(SRC, 'src'));
      }
      const next = resolveSpecifier(specifier, file);
      if (!next || seen.has(next)) continue;
      seen.add(next);
      queue.push([...path, next]);
    }
  }
  return null;
}

describe('public bundles', () => {
  it('every listed entry exists, so a typo cannot make this test vacuous', () => {
    for (const entry of PUBLIC_ENTRIES) {
      expect(existsSync(join(SRC, entry)), `${entry} not found`).toBe(true);
    }
  });

  for (const entry of PUBLIC_ENTRIES) {
    it(`${entry} does not statically reach the calendar alerts`, () => {
      const path = pathToAlerts(entry);
      expect(
        path,
        path ? `Calendar alerts are in a public graph via:\n  ${path.join('\n  → ')}` : ''
      ).toBeNull();
    });
  }

  it('the walker detects the alerts when it is pointed at the admin layout', () => {
    // Guards the guard: AdminLayout does import the gate statically.
    expect(pathToAlerts('pages/admin/AdminLayout.jsx')).not.toBeNull();
  });

  it('the admin layout reaches the pop-up only through the gate, which loads it lazily', () => {
    const layout = readFileSync(join(SRC, 'pages/admin/AdminLayout.jsx'), 'utf8');
    const gate = readFileSync(
      join(SRC, 'components/admin/calendar-alerts/CalendarAlertsGate.jsx'),
      'utf8'
    );
    expect(layout).toContain("from '@/components/admin/calendar-alerts/CalendarAlertsGate'");
    expect(layout).not.toMatch(/from '[^']*CalendarAlertsPrompt'/);
    expect(gate).toMatch(/lazy\(\(\) => import\('\.\/CalendarAlertsPrompt'\)\)/);
    expect(gate).not.toMatch(/^import .*CalendarAlertsPrompt/m);
  });
});

/** Every source file under a directory, as paths relative to the package root. */
function filesUnder(directory, keep) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : filesUnder(path, keep);
    return keep(name) ? [relative(ROOT, path).split('\\').join('/')] : [];
  });
}

describe('where the alerts are named', () => {
  it('names the API route only in the timeout table and the lib that calls it', () => {
    const sources = filesUnder(
      SRC,
      (name) => /\.(js|jsx|ts|tsx)$/.test(name) && !/\.test\./.test(name)
    );
    const naming = sources.filter((file) =>
      readFileSync(join(ROOT, file), 'utf8').includes('cms/calendar-alerts')
    );
    // api.js carries the route's timeout and calendarAlerts.js is the client.
    expect(naming.sort()).toEqual(['src/lib/api.js', 'src/lib/calendarAlerts.js']);
  });

  it('has no menu entry or route of its own: the alerts live on the Calendar page', () => {
    // Owner instruction 2026-10-26: build on the existing calendar, not beside it.
    for (const file of ['config/adminNav.js', 'App.jsx', 'config/admin-v2.js']) {
      const source = readFileSync(join(SRC, file), 'utf8');
      expect(source, file).not.toMatch(/calendar-alerts/);
      expect(source, file).not.toMatch(/Calendar Alerts/);
    }
    expect(existsSync(join(SRC, 'pages/admin/CalendarAlertsPage.jsx'))).toBe(false);
  });

  it('the Calendar page does reach the panel (the walker sees it) and the layout reaches only the gate', () => {
    expect(pathToAlerts('pages/admin/CalendarPage.jsx')).not.toBeNull();
  });

  it('is not named by the build scripts, the data, or the static assets', () => {
    const files = [
      ...filesUnder(join(ROOT, 'scripts'), (name) => /\.(mjs|cjs|js)$/.test(name)),
      ...filesUnder(join(ROOT, 'data'), () => true),
      ...filesUnder(join(ROOT, 'public'), (name) =>
        /\.(xml|json|txt|html|webmanifest)$/.test(name)
      ),
    ].filter((file) => !/\.test\./.test(file));
    expect(files.length).toBeGreaterThan(5);
    const naming = files.filter((file) =>
      /calendar[-_ ]?alerts?/i.test(readFileSync(join(ROOT, file), 'utf8'))
    );
    expect(naming).toEqual([]);
  });
});
