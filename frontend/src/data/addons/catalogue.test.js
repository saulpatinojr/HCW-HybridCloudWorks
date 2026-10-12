/**
 * The AddOn catalogue is data the pages trust without checking, so this is
 * where it is checked (ADR 0035; the standard's section 4): every row has
 * every field with the right shape, ids are unique and usable as a path
 * segment, a hostname label and a setting suffix, the origin is exactly the
 * id on the lab domain, providers and capabilities come from the fixed
 * lists, a `coming` row says since when and why, the copy fields name
 * nothing behind the site, and the server registry
 * (functions/src/lib/addons/registry.js) names the same ids and health
 * paths, the way the labs catalogue is held to the lab launcher's map.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { VALID_PROVIDERS } from '@/context/ProviderContext';
import { staticRoutes } from '@/lib/routeFactory';
import {
  ADDON_CAPABILITIES,
  ADDON_FIELDS,
  ADDON_OPTIONAL_FIELDS,
  ADDON_ORIGIN_SUFFIX,
  ADDON_PROVIDERS,
  ADDON_STATUSES,
  SITE_ORIGINS,
  TOOLS_PATH,
  addonById,
  addonOrigins,
  addonPanePath,
  addonPaneUrl,
  addons,
  addonsForProvider,
  availableAddons,
} from './catalogue';

/** Whether a value is a string with visible characters. */
const isNonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0;

/** The copy fields public-copy.test.js's rule applies to (standard, section 4). */
const COPY_FIELDS = ['title', 'menuLabel', 'summary', 'comingReason'];

/** Backend words a visitor must not read from a row, in any copy field. */
const BEHIND_THE_SITE =
  /\bcoder\b|oauth|code-server|\bvps\b|callback|caddy|hostinger|cloudflare|turnstile|docker|\bapi\b/i;

/** `migration` to `migration`, `network-assessment` to `networkAssessment`. */
const camel = (id) => id.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());

/**
 * The Function App's registry, read from its source as `{ id: healthPath }`:
 * that file is the proxy's to change, and this test says what the site
 * relies on.
 */
function serverRegistry() {
  const source = readFileSync(
    join(process.cwd(), '..', 'functions/src/lib/addons/registry.js'),
    'utf8'
  );
  const block = source.match(/export const ADDONS = Object\.freeze\(\{([\s\S]*?)\n\}\);/);
  if (!block) throw new Error('functions/src/lib/addons/registry.js no longer declares ADDONS');
  const entries = [
    ...block[1].matchAll(
      /(?:'([a-z0-9-]+)'|([a-z0-9]+)):\s*Object\.freeze\(\{[^}]*healthPath:\s*'([^']+)'[^}]*\}\)/g
    ),
  ];
  return Object.fromEntries(
    entries.map(([, quoted, bare, healthPath]) => [quoted ?? bare, healthPath])
  );
}

describe('addon catalogue', () => {
  it('has the three program AddOns', () => {
    expect(addons.map((addon) => addon.id)).toEqual([
      'migration',
      'network-assessment',
      'cloud-assessment',
    ]);
  });

  it.each(addons.map((addon) => [addon.id, addon]))('%s carries every field', (id, addon) => {
    for (const field of ADDON_FIELDS) {
      expect(addon, `${id} is missing ${field}`).toHaveProperty(field);
    }
    const optional = Object.keys(addon).filter((key) => !ADDON_FIELDS.includes(key));
    for (const key of optional) {
      expect(ADDON_OPTIONAL_FIELDS, `${id} carries an unknown field: ${key}`).toContain(key);
    }
    // A path segment, a hostname label and a setting suffix at once.
    expect(addon.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(addon.id.length).toBeLessThanOrEqual(63);
    expect(isNonEmptyString(addon.title)).toBe(true);
    if ('menuLabel' in addon) expect(isNonEmptyString(addon.menuLabel)).toBe(true);
    expect(addon.summary.trim().length).toBeGreaterThanOrEqual(40);
    expect(addon.origin).toBe(`https://${addon.id}${ADDON_ORIGIN_SUFFIX}`);
    expect(addon.panePath).toMatch(/^\//);
    expect(addon.healthPath).toMatch(/^\/api\//);
    expect(addon.docsUrl).toMatch(/^https:\/\//);
    expect(addon.technology.length).toBeGreaterThan(0);
    for (const tech of addon.technology) expect(tech).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it.each(addons.map((addon) => [addon.id, addon]))(
    '%s names known providers, capabilities and a status',
    (id, addon) => {
      expect(addon.providers.length).toBeGreaterThan(0);
      expect(new Set(addon.providers).size).toBe(addon.providers.length);
      for (const provider of addon.providers) {
        expect(ADDON_PROVIDERS, `${id} names an unknown provider: ${provider}`).toContain(provider);
      }
      expect(new Set(addon.capabilities).size).toBe(addon.capabilities.length);
      for (const capability of addon.capabilities) {
        expect(ADDON_CAPABILITIES, `${id} grants an unknown capability: ${capability}`).toContain(
          capability
        );
      }
      expect(ADDON_STATUSES).toContain(addon.status);
      if (addon.status === 'coming') {
        // Nothing is promised without a date and a reason.
        expect(addon.comingSince).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(isNonEmptyString(addon.comingReason)).toBe(true);
      } else {
        expect(addon).not.toHaveProperty('comingSince');
        expect(addon).not.toHaveProperty('comingReason');
      }
    }
  );

  it('keeps its fixed lists honest', () => {
    for (const provider of ADDON_PROVIDERS) expect(VALID_PROVIDERS).toContain(provider);
    expect(ADDON_CAPABILITIES).toEqual([
      'navigate',
      'downloads',
      'popups',
      'clipboard',
      'fullscreen',
    ]);
    expect(ADDON_ORIGIN_SUFFIX).toBe('.lab.hybridcloudworks.com');
    expect(SITE_ORIGINS).toEqual([
      'https://hybridcloudworks.com',
      'https://www.hybridcloudworks.com',
    ]);
    expect(TOOLS_PATH).toBe('/tools');
  });

  it('gives no two AddOns the same id or origin', () => {
    const ids = addons.map((addon) => addon.id);
    expect(new Set(ids).size).toBe(ids.length);
    const origins = addons.map((addon) => addon.origin);
    expect(new Set(origins).size).toBe(origins.length);
  });

  it('is frozen, rows included', () => {
    expect(Object.isFrozen(addons)).toBe(true);
    expect(Object.isFrozen(availableAddons)).toBe(true);
    for (const addon of addons) {
      expect(Object.isFrozen(addon), `${addon.id} is mutable`).toBe(true);
      for (const key of ['providers', 'technology', 'capabilities', 'articleSlugs']) {
        expect(Object.isFrozen(addon[key]), `${addon.id}.${key} is mutable`).toBe(true);
      }
    }
  });

  it('says nothing behind the site in any copy field, and only there', () => {
    // AddOnPanePage.test.jsx holds the rendered page to this; the rows are
    // where the words come from, so the rule is checked at the source too.
    // Addresses (origin, panePath, healthPath, docsUrl) are not copy and may
    // say `api`.
    for (const addon of addons) {
      const copy = [
        ...COPY_FIELDS.map((field) => addon[field]).filter(Boolean),
        ...addon.articleSlugs.map((entry) => entry.title),
      ];
      for (const text of copy) {
        expect(text, `${addon.id} names something behind the site`).not.toMatch(BEHIND_THE_SITE);
      }
    }
  });

  it('points only at published articles, in the labs catalogue’s shape', () => {
    for (const entry of addons.flatMap((addon) => addon.articleSlugs)) {
      expect(VALID_PROVIDERS).toContain(entry.provider);
      expect(entry.slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(isNonEmptyString(entry.title)).toBe(true);
    }
  });

  it('keeps the migration row as the standard’s example row', () => {
    const migration = addonById('migration');
    expect(migration.status).toBe('available');
    expect(migration.menuLabel).toBe('Migration Hub');
    // `downloads` confirmed by the owner on 2026-10-10 (ADR 0035 decision 9, #1044).
    expect(migration.capabilities).toEqual(['navigate', 'downloads']);
    expect(migration.origin).toBe('https://migration.lab.hybridcloudworks.com');
    expect(migration.panePath).toBe('/');
    expect(migration.healthPath).toBe('/api/health');
  });
});

describe('the lists the pages derive', () => {
  it('frames all three available AddOn rows', () => {
    expect(availableAddons.map((addon) => addon.id)).toEqual([
      'migration',
      'network-assessment',
      'cloud-assessment',
    ]);
    expect(availableAddons.every((addon) => addon.status === 'available')).toBe(true);
    expect(addonById('network-assessment').status).toBe('available');
    expect(addonById('cloud-assessment').status).toBe('available');
  });

  it('gives every row a page at /tools/<id>, named in staticRoutes', () => {
    for (const addon of addons) {
      expect(addonPanePath(addon)).toBe(`/tools/${addon.id}`);
      expect(staticRoutes[camel(addon.id)], `staticRoutes has no entry for ${addon.id}`).toBe(
        addonPanePath(addon)
      );
    }
    expect(addonPanePath({ id: 'a/b?c' })).toBe('/tools/a%2Fb%3Fc');
  });

  it('loads each pane from the row’s own origin and pane path', () => {
    for (const addon of addons) {
      const url = new URL(addonPaneUrl(addon));
      expect(url.origin).toBe(addon.origin);
      expect(url.pathname).toBe(addon.panePath);
    }
    expect(addonPaneUrl(addonById('migration'))).toBe(
      'https://migration.lab.hybridcloudworks.com/'
    );
  });

  it('lists the available origins, and nothing broader, for the CSP', () => {
    expect(addonOrigins()).toEqual([
      'https://migration.lab.hybridcloudworks.com',
      'https://network-assessment.lab.hybridcloudworks.com',
      'https://cloud-assessment.lab.hybridcloudworks.com',
    ]);
    for (const origin of addonOrigins()) {
      expect(origin).not.toContain('*');
      expect(origin.endsWith(ADDON_ORIGIN_SUFFIX)).toBe(true);
    }
  });

  it('filters by provider', () => {
    expect(addonsForProvider('azure').map((addon) => addon.id)).toEqual([
      'migration',
      'network-assessment',
      'cloud-assessment',
    ]);
    expect(addonsForProvider('aws')).toEqual([]);
  });

  it('finds an AddOn by id, and nothing for an id the catalogue does not have', () => {
    for (const addon of addons) expect(addonById(addon.id)).toBe(addon);
    expect(addonById('no-such-addon')).toBeNull();
    expect(addonById(undefined)).toBeNull();
  });
});

describe('parity with the Function App’s registry', () => {
  it('names exactly the same ids, with the same health path each', () => {
    const registry = serverRegistry();
    expect(Object.keys(registry).sort()).toEqual(addons.map((addon) => addon.id).sort());
    for (const addon of addons) {
      expect(registry[addon.id], `${addon.id} health path differs`).toBe(addon.healthPath);
    }
  });

  it('names the app setting each row reads, by the id', () => {
    const source = readFileSync(
      join(process.cwd(), '..', 'functions/src/lib/addons/registry.js'),
      'utf8'
    );
    for (const addon of addons) {
      const setting = `ADDON_${addon.id.replace(/-/g, '_').toUpperCase()}_URL`;
      expect(source).toContain(`setting: '${setting}'`);
    }
  });
});
