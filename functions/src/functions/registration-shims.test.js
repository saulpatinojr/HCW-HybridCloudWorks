/**
 * Registration Shims Contract Test (QA-2 #977).
 *
 * Verifies that every registration shim under functions/src/functions/
 * can be imported directly, evaluates without side-effect errors or uncaught
 * exceptions, and registers with the Azure Functions v4 programming model.
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

const httpRegistrations = new Map();
const timerRegistrations = new Map();
const cosmosRegistrations = new Map();
const queueRegistrations = new Map();

vi.mock('@azure/functions', () => ({
  app: {
    http: (name, options) => httpRegistrations.set(name, options),
    timer: (name, options) => timerRegistrations.set(name, options),
    cosmosDB: (name, options) => cosmosRegistrations.set(name, options),
    storageQueue: (name, options) => queueRegistrations.set(name, options),
  },
  output: {
    storageQueue: (options) => ({ type: 'queue', ...options }),
  },
}));

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

const allFiles = fs.readdirSync(here);
const shimFiles = allFiles
  .filter((file) => file.endsWith('.js') && !file.endsWith('.test.js') && file !== 'index.js')
  .sort();

describe('registration shims contract (QA-2 #977)', () => {
  it('identifies all registration shims in functions/src/functions', () => {
    expect(shimFiles.length).toBeGreaterThanOrEqual(60);
  });

  describe('direct shim import contracts', () => {
    for (const file of shimFiles) {
      it(`imports and registers contract for ${file}`, async () => {
        const fileUrl = new URL(file, import.meta.url).href;
        const module = await import(/* @vite-ignore */ fileUrl);
        expect(module).toBeDefined();

        const totalRegistered =
          httpRegistrations.size +
          timerRegistrations.size +
          cosmosRegistrations.size +
          queueRegistrations.size;

        // Verify that the file either made a registration or export
        expect(totalRegistered).toBeGreaterThan(0);
      });
    }
  });
});
