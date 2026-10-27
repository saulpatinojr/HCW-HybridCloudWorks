/**
 * Registration Shims Contract Test (QA-2 #977).
 *
 * Verifies that every registration shim under functions/src/functions/
 * can be imported directly, evaluates without side-effect errors or uncaught
 * exceptions, and registers with the Azure Functions v4 programming model.
 */
import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

const httpRegistrations = new Map();
const timerRegistrations = new Map();
const cosmosRegistrations = new Map();
const queueRegistrations = new Map();

vi.mock("@azure/functions", () => ({
  app: {
    http: (name, options) => httpRegistrations.set(name, options),
    timer: (name, options) => timerRegistrations.set(name, options),
    cosmosDB: (name, options) => cosmosRegistrations.set(name, options),
    storageQueue: (name, options) => queueRegistrations.set(name, options),
  },
  output: {
    storageQueue: (options) => ({ type: "queue", ...options }),
  },
}));

vi.mock("@azure/cosmos", () => ({ CosmosClient: class {} }));
vi.mock("@azure/identity", () => ({
  DefaultAzureCredential: class {},
  ManagedIdentityCredential: class {},
}));
vi.mock("@azure/storage-blob", () => ({ BlobServiceClient: class {} }));
vi.mock("@aws-sdk/client-pricing", () => ({
  PricingClient: class {},
  GetProductsCommand: class {},
}));
vi.mock("sharp", () => ({ default: vi.fn() }));
vi.mock("@breezystack/lamejs", () => ({ default: {}, Mp3Encoder: class {} }));
vi.mock("cheerio", () => ({ load: vi.fn() }));
vi.mock("turndown", () => ({
  default: class {
    addRule() {}
    turndown() {
      return "";
    }
  },
}));
vi.mock("rss-parser", () => ({ default: class {} }));

import { listJobTypes } from "../lib/jobs.js";

const EXPECTED_SHIM_FILES = [
  "addons-public-http.js",
  "admin-crud-http.js",
  "admin-identity-http.js",
  "admin-integrations-http.js",
  "admin-secrets-http.js",
  "admin-snapshots-http.js",
  "admin-uploads-http.js",
  "ai-model-catalog-http.js",
  "ai-proxy-http.js",
  "ambassador-audience.js",
  "ambassador-http.js",
  "blog-sources-http.js",
  "brain-http.js",
  "calendar-alerts-http.js",
  "calendar-http.js",
  "change-feed.js",
  "cloud-tools-http.js",
  "cloud-tools-jobs.js",
  "cms-http.js",
  "code-quality-http.js",
  "connection-probe-http.js",
  "content-workflow-http.js",
  "cosmos-export.js",
  "credentials-http.js",
  "doc-vault-http.js",
  "drafts-http.js",
  "forge-config-http.js",
  "forge-jobs.js",
  "gallery-images-http.js",
  "generate-article-draft-http.js",
  "health-http.js",
  "image-prompts-http.js",
  "inspect-jobs.js",
  "integrations-http.js",
  "jobs-http.js",
  "jobs-sweeper.js",
  "jobs-worker.js",
  "lab-agent-http.js",
  "labs-http.js",
  "labs-jobs.js",
  "labs-public-http.js",
  "legacy-blogs-telemetry-http.js",
  "listen-and-learn-http.js",
  "listen-and-learn-jobs.js",
  "manual-images-http.js",
  "mcp-http.js",
  "newsletter-admin-http.js",
  "newsletter-http.js",
  "newsletter-insights-http.js",
  "ops-health-http.js",
  "platform-health-http.js",
  "platform-settings-http.js",
  "podcast-http.js",
  "podcast-jobs.js",
  "podcast-recordings-http.js",
  "public-content-manifest.js",
  "public-media.js",
  "public-preview.js",
  "public-reads.js",
  "public-submissions.js",
  "publish-http.js",
  "publish-jobs.js",
  "recording-content-http.js",
  "reviewer-digest-http.js",
  "rss-jobs.js",
  "schedulers.js",
  "social-caption-http.js",
  "streamyard-http.js",
  "telegram-http.js",
  "visitor-session-sweep.js",
];

const allFiles = fs.readdirSync(here);
const shimFiles = allFiles
  .filter(
    (file) =>
      file.endsWith(".js") && !file.endsWith(".test.js") && file !== "index.js",
  )
  .sort();

describe("registration shims contract (QA-2 #977)", () => {
  it("identifies all registration shims in functions/src/functions", () => {
    expect(shimFiles).toEqual(EXPECTED_SHIM_FILES);
  });

  describe("direct shim import contracts", () => {
    for (const file of shimFiles) {
      it(`imports and registers contract for ${file}`, async () => {
        const beforeTotal =
          httpRegistrations.size +
          timerRegistrations.size +
          cosmosRegistrations.size +
          queueRegistrations.size +
          listJobTypes().length;

        const fileUrl = new URL(file, import.meta.url).href;
        const module = await import(/* @vite-ignore */ fileUrl);
        expect(module).toBeDefined();

        const afterTotal =
          httpRegistrations.size +
          timerRegistrations.size +
          cosmosRegistrations.size +
          queueRegistrations.size +
          listJobTypes().length;

        // Verify that this specific shim contributed at least one registration
        expect(afterTotal).toBeGreaterThan(beforeTotal);
      });
    }
  });
});
