/**
 * The closed registry of AddOns the status proxy may read (ADR 0035; the
 * HCW AddOn Integration Standard, section 10).
 *
 * `GET /api/public/addons/{id}/status` is anonymous and takes `id` from the
 * path, so the ids are closed HERE, server side: a visitor can make the
 * Function App read the health of an AddOn this table names and nothing
 * else, whatever the path says. The address itself comes from the app
 * setting the entry names (`ADDON_<ID>_URL`, a plain Terraform setting in
 * infra/functionapp.tf, public because it is already in the site's CSP),
 * never from the request.
 *
 * The site's catalogue (frontend/src/data/addons/catalogue.js) holds the
 * same ids and health paths; its test reads this file and fails when the
 * two drift. An entry here whose setting is unset answers
 * `{ configured: false }`, which is how a `coming` row stays closed.
 */

export const ADDONS = Object.freeze({
  migration: Object.freeze({ setting: 'ADDON_MIGRATION_URL', healthPath: '/api/health' }),
  'network-assessment': Object.freeze({
    setting: 'ADDON_NETWORK_ASSESSMENT_URL',
    healthPath: '/api/health',
  }),
  'cloud-assessment': Object.freeze({
    setting: 'ADDON_CLOUD_ASSESSMENT_URL',
    healthPath: '/api/health',
  }),
  'cloud-crawler': Object.freeze({
    setting: 'ADDON_CLOUD_CRAWLER_URL',
    healthPath: '/api/health',
  }),
});

export const ADDON_IDS = Object.freeze(Object.keys(ADDONS));

/** Whether an id is one the registry names: an own property, never a prototype one. */
export const isKnownAddon = (id) => typeof id === 'string' && Object.hasOwn(ADDONS, id);

/** The registry entry for an id, or null. */
export const addonEntry = (id) => (isKnownAddon(id) ? ADDONS[id] : null);
