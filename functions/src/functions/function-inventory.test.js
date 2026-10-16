/**
 * The function inventory, held to the code (PLAT-2, #962).
 *
 * `functions/function-inventory.json` lists every function the host registers,
 * by trigger. Two workflows compare a live listing against it, through
 * `scripts/check-registered-functions.mjs`: `deploy-functions.yml` after
 * SyncTriggers, and `monitor-functions-registered.yml` on its timer. Both used
 * to ask only whether the count was above zero, so the 2026-08-21 incident (83
 * deployed, 80 registered, three timers silently down) passed both. They now
 * name every expected function that is not registered.
 *
 * A file the workflows trust is only as good as its agreement with the code,
 * so this enumerates the registrations exactly as route-inventory.test.js
 * does (mock the host, import index.js) and fails, naming each name, when the
 * two disagree in either direction:
 *
 *   - registered here but absent from the file: the deploy and the monitor
 *     would never notice that function going missing;
 *   - in the file but not registered: both would report a function missing
 *     that no deploy can ever register, which reads as an outage.
 *
 * Adding, renaming or removing a function therefore means editing the file in
 * the same change. That is the point: the expected set is reviewed, not
 * inferred from whatever the host happens to report.
 *
 * A new KIND of trigger (app.serviceBusQueue, app.eventGrid, ...) fails the
 * import below, because the mock has no such method. Add it here, to the
 * file, and to TRIGGERS in scripts/check-registered-functions.mjs together.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** trigger -> names, in registration order, recorded in place of the host. */
const registered = { http: [], timer: [], cosmosDB: [], storageQueue: [] };

vi.mock('@azure/functions', () => ({
  app: {
    http: (name) => registered.http.push(name),
    timer: (name) => registered.timer.push(name),
    cosmosDB: (name) => registered.cosmosDB.push(name),
    storageQueue: (name) => registered.storageQueue.push(name),
  },
  output: { storageQueue: (options) => options },
}));

// Handlers are never invoked here, but index.js resolves guards at import.
vi.mock('../lib/auth/default-guard.js', () => ({
  getDefaultGuard: () => ({ requireRole: vi.fn(), requireUser: vi.fn() }),
  resetDefaultGuard: () => {},
}));
vi.mock('../lib/auth/default-agent-guard.js', () => ({
  getDefaultAgentGuard: () => ({ requireAgent: vi.fn() }),
  resetDefaultAgentGuard: () => {},
}));

// Same as api-contract and route-inventory: enumerating registrations never
// touches the cloud, media or parser SDKs (#1203).
vi.mock('@azure/cosmos', () => ({ CosmosClient: class {} }));
vi.mock('@azure/identity', () => ({
  DefaultAzureCredential: class {},
  ManagedIdentityCredential: class {},
}));
vi.mock('@azure/storage-blob', () => ({ BlobServiceClient: class {} }));
vi.mock('@aws-sdk/client-pricing', () => ({
  PricingClient: class {},
  GetProductsCommand: class {},
}));
vi.mock('sharp', () => ({ default: vi.fn() }));
vi.mock('@breezystack/lamejs', () => ({ default: {}, Mp3Encoder: class {} }));
vi.mock('cheerio', () => ({ load: vi.fn() }));
vi.mock('turndown', () => ({ default: class { addRule() {} turndown() { return ''; } } }));
vi.mock('rss-parser', () => ({ default: class {} }));

const INVENTORY_PATH = fileURLToPath(new URL('../../function-inventory.json', import.meta.url));
const inventory = JSON.parse(readFileSync(INVENTORY_PATH, 'utf8'));
const TRIGGERS = Object.keys(registered);

/** Code-unit order, the order the file is kept in. */
const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

beforeAll(async () => {
  // Same rule as route-inventory: importing index.js must not reach the
  // network.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('network disabled in function-inventory tests');
    })
  );
  await import('./index.js');
}, 30_000);

afterAll(() => {
  vi.unstubAllGlobals();
});

describe('functions/function-inventory.json', () => {
  it('has exactly the known trigger groups, each a list of names', () => {
    // scripts/check-registered-functions.mjs refuses a file with any other
    // shape, so a shape change here would break the deploy and the monitor
    // without failing this package's own suite.
    expect(Object.keys(inventory).filter((key) => key !== '$comment').sort()).toEqual(
      [...TRIGGERS].sort()
    );
    for (const trigger of TRIGGERS) {
      expect(Array.isArray(inventory[trigger]), trigger).toBe(true);
      for (const name of inventory[trigger]) expect(typeof name, `${trigger}: ${name}`).toBe('string');
    }
  });

  it('keeps each group sorted and free of duplicates, so a diff shows exactly what changed', () => {
    for (const trigger of TRIGGERS) {
      const names = inventory[trigger];
      expect(names, `${trigger} is not sorted`).toEqual([...names].sort(byCodeUnit));
      expect(new Set(names).size, `${trigger} repeats a name`).toBe(names.length);
    }
  });

  it('recorded the registrations at all', () => {
    // A mocking mistake that silently records nothing would make the two
    // comparisons below compare an empty list with the file and fail
    // confusingly, or, if the file were emptied too, pass.
    expect(registered.http.length).toBeGreaterThan(50);
    expect(registered.timer.length).toBeGreaterThan(0);
  });

  it.each(TRIGGERS)('lists every %s function the code registers', (trigger) => {
    const listed = new Set(inventory[trigger]);
    const unlisted = registered[trigger].filter((name) => !listed.has(name));
    expect(
      unlisted,
      `registered as ${trigger} but missing from functions/function-inventory.json; add them, sorted, so the deploy and the monitor notice if they stop registering`
    ).toEqual([]);
  });

  it.each(TRIGGERS)('lists no %s function the code does not register', (trigger) => {
    const code = new Set(registered[trigger]);
    const phantom = inventory[trigger].filter((name) => !code.has(name));
    expect(
      phantom,
      `listed as ${trigger} in functions/function-inventory.json but not registered; remove them, or the deploy and the monitor report them missing forever`
    ).toEqual([]);
  });

  it('never lists one name under two triggers', () => {
    // The host keys functions by name alone, so a name in two groups is a
    // function the file describes wrongly at least once.
    const all = TRIGGERS.flatMap((trigger) => inventory[trigger]);
    expect(new Set(all).size).toBe(all.length);
  });
});
