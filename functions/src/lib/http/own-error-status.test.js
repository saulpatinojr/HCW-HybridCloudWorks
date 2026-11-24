/**
 * own-error-status.test.js — the errors this code throws about another
 * service's HTTP answer carry that status as a field (#1802).
 *
 * Each of these errors names the status in its message ("Google SKUs
 * returned 503"). A log line never prints a message, so before the field
 * existed the line said where the error was thrown and not what the service
 * answered. Every row below makes one of those sites fail with a fake
 * answer and checks three things: the message is word for word what it was,
 * the status is on the error as a number, and the log line that errorFacts
 * builds shows it next to the file that threw.
 *
 * Sites whose own test file already had the failing answer set up are
 * checked there instead: the image fetch (triggers/triggers.test.js), the
 * guarded fetch's redirect limit (http/guarded-fetch.test.js) and the
 * repository read's redirect (cms/repo-draft-source.test.js).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { errorCode, errorFacts, storedFailure } from './error-response.js';
import { setVaultSecret } from '../secret-vault.js';
import { writeCatalogSecret } from '../admin-secrets.js';
import { fetchAzurePrice } from '../cloud-tools/pricing/azure.js';
import { fetchGcpPrice, resetGoogleCaches } from '../cloud-tools/pricing/gcp.js';
import { fetchLivePricing } from '../cloud-tools/pricing/index.js';
import {
  GOOGLE_TARGETS,
  createGoogleApiKey,
  deleteGoogleApiKey,
  getGoogleKeyDetails,
  getGoogleKeyString,
  lookupGoogleApiKey,
  pollGoogleOperation,
  verifyGoogleApiKey,
} from '../credentials/google-roll.js';
import { rollCloudflareToken, updateTfcVariable, verifyCloudflareToken } from '../credentials/cloudflare-roll.js';
import { createAwsAccessKey, deleteAwsAccessKey, listAwsAccessKeys } from '../credentials/aws-roll.js';
import { fetchStudyGuide } from '../listen-and-learn/studyguide.js';
import { fetchPreviewAudio } from '../listen-and-learn/speech/elevenlabs-preview.js';
import { scrapeArticle } from '../content/scrape.js';

/** Something only the other service's answer holds; it must never reach a field or a line. */
const BODY_TEXT = 'upstream-body-text-for-org-abc';

/** A refused answer: a status, and a body no field may copy. */
const refused = (status, extra = {}) => ({
  ok: false,
  status,
  statusText: '',
  headers: { get: () => null },
  json: async () => ({ error: { message: BODY_TEXT }, errors: [{ detail: BODY_TEXT }] }),
  text: async () => BODY_TEXT,
  ...extra,
});

const answers = (status) => vi.fn(async () => refused(status));
const KEY_NAME = 'projects/1/locations/global/keys/k1';
const TFC = { tfcToken: 'placeholder', organization: 'hcw', workspace: 'hcw-azure', key: 'cloudflare_api_token', value: 'placeholder' };
const AWS = { accessKeyId: 'AKIA-PLACEHOLDER', secretAccessKey: 'placeholder', now: new Date('2026-10-17T02:00:00Z') };
const jsonOk = (body) => ({ ok: true, status: 200, statusText: 'OK', json: async () => body });

/** A fetch that answers each call in turn from a list. */
const inTurn = (...list) => {
  const queue = [...list];
  return vi.fn(async () => queue.shift());
};

afterEach(() => {
  vi.unstubAllGlobals();
  resetGoogleCaches();
});

/**
 * One row per site: where it is, the status the fake service answers, the
 * call that fails, and the message it has always thrown.
 */
const SITES = [
  [
    'secret-vault.js: the Key Vault write',
    'src/lib/secret-vault.js',
    403,
    () =>
      setVaultSecret('OPENAI-API-KEY', 'placeholder-value', {
        fetch: answers(403),
        credential: { getToken: async () => ({ token: 'placeholder' }) },
        vaultUrl: 'https://kv/',
      }),
    'Key Vault refused to set OPENAI-API-KEY: HTTP 403',
  ],
  [
    'pricing/gcp.js: the Google services list',
    'src/lib/cloud-tools/pricing/gcp.js',
    500,
    () => fetchGcpPrice('compute-vm', 'us-central1', { apiKey: 'placeholder', fetch: answers(500) }),
    'Google services list returned 500',
  ],
  [
    'pricing/gcp.js: the Google SKU list',
    'src/lib/cloud-tools/pricing/gcp.js',
    503,
    () =>
      fetchGcpPrice('compute-vm', 'us-central1', {
        apiKey: 'placeholder',
        fetch: vi.fn(async (url) =>
          String(url).includes('/services?')
            ? jsonOk({ services: [{ name: 's/1', displayName: 'Compute Engine' }] })
            : refused(503)
        ),
      }),
    'Google SKUs returned 503',
  ],
  [
    'pricing/azure.js: the Azure retail prices',
    'src/lib/cloud-tools/pricing/azure.js',
    503,
    () => fetchAzurePrice('storage-object', 'eastus', { fetch: answers(503) }),
    'Azure retail prices returned 503',
  ],
  [
    'google-roll.js: the key lookup',
    'src/lib/credentials/google-roll.js',
    403,
    () => lookupGoogleApiKey({ keyString: 'placeholder', gcpToken: 'placeholder', fetchImpl: answers(403) }),
    `Google API key lookup failed (HTTP 403): ${BODY_TEXT}`,
  ],
  [
    'google-roll.js: the key details read',
    'src/lib/credentials/google-roll.js',
    500,
    () => getGoogleKeyDetails({ keyName: KEY_NAME, gcpToken: 'placeholder', fetchImpl: answers(500) }),
    `Google API key details read failed (HTTP 500): ${BODY_TEXT}`,
  ],
  [
    'google-roll.js: the key creation',
    'src/lib/credentials/google-roll.js',
    400,
    () =>
      createGoogleApiKey({
        parent: 'projects/1',
        displayName: 'site-key',
        gcpToken: 'placeholder',
        fetchImpl: answers(400),
      }),
    `Google API key creation initiation failed (HTTP 400): ${BODY_TEXT}`,
  ],
  [
    'google-roll.js: the operation poll',
    'src/lib/credentials/google-roll.js',
    503,
    () =>
      pollGoogleOperation({
        operationName: 'operations/op-1',
        gcpToken: 'placeholder',
        fetchImpl: answers(503),
        sleep: async () => {},
      }),
    `Polling operation operations/op-1 failed (HTTP 503): ${BODY_TEXT}`,
  ],
  [
    'google-roll.js: the key string read',
    'src/lib/credentials/google-roll.js',
    403,
    () => getGoogleKeyString({ keyName: KEY_NAME, gcpToken: 'placeholder', fetchImpl: answers(403) }),
    `Retrieving keyString for ${KEY_NAME} failed (HTTP 403): ${BODY_TEXT}`,
  ],
  [
    'google-roll.js: the key delete',
    'src/lib/credentials/google-roll.js',
    404,
    () => deleteGoogleApiKey({ keyName: KEY_NAME, gcpToken: 'placeholder', fetchImpl: answers(404) }),
    `Deleting Google API key ${KEY_NAME} failed (HTTP 404): ${BODY_TEXT}`,
  ],
  [
    'google-roll.js: the verification probe',
    'src/lib/credentials/google-roll.js',
    400,
    () => verifyGoogleApiKey({ target: GOOGLE_TARGETS.gemini, keyString: 'placeholder', fetchImpl: answers(400) }),
    'Verification probe for GEMINI-API-KEY returned HTTP 400',
  ],
  [
    'cloudflare-roll.js: the token roll',
    'src/lib/credentials/cloudflare-roll.js',
    403,
    () => rollCloudflareToken({ tokenId: 'tok-1', rollToken: 'placeholder', fetchImpl: answers(403) }),
    /^Cloudflare roll-token request failed \(403\): /,
  ],
  [
    'cloudflare-roll.js: the token verification',
    'src/lib/credentials/cloudflare-roll.js',
    401,
    () => verifyCloudflareToken({ tokenValue: 'placeholder', fetchImpl: answers(401) }),
    /^Cloudflare token verification failed \(401\): /,
  ],
  [
    'cloudflare-roll.js: the workspace lookup',
    'src/lib/credentials/cloudflare-roll.js',
    404,
    () => updateTfcVariable({ ...TFC, fetchImpl: answers(404) }),
    `HCP Terraform workspace hcw/hcw-azure lookup failed (404): ${BODY_TEXT}`,
  ],
  [
    'cloudflare-roll.js: the variable list',
    'src/lib/credentials/cloudflare-roll.js',
    500,
    () => updateTfcVariable({ ...TFC, fetchImpl: inTurn(jsonOk({ data: { id: 'ws-1' } }), refused(500)) }),
    `HCP Terraform list vars failed for hcw/hcw-azure (500): ${BODY_TEXT}`,
  ],
  [
    'cloudflare-roll.js: the variable update',
    'src/lib/credentials/cloudflare-roll.js',
    422,
    () =>
      updateTfcVariable({
        ...TFC,
        fetchImpl: inTurn(
          jsonOk({ data: { id: 'ws-1' } }),
          jsonOk({ data: [{ id: 'var-1', attributes: { key: TFC.key, category: 'terraform' } }] }),
          refused(422)
        ),
      }),
    `HCP Terraform update variable cloudflare_api_token in hcw/hcw-azure failed (422): ${BODY_TEXT}`,
  ],
  [
    'cloudflare-roll.js: the variable create',
    'src/lib/credentials/cloudflare-roll.js',
    403,
    () =>
      updateTfcVariable({
        ...TFC,
        fetchImpl: inTurn(jsonOk({ data: { id: 'ws-1' } }), jsonOk({ data: [] }), refused(403)),
      }),
    `HCP Terraform create variable cloudflare_api_token in hcw/hcw-azure failed (403): ${BODY_TEXT}`,
  ],
  [
    'aws-roll.js: the access key list',
    'src/lib/credentials/aws-roll.js',
    403,
    () => listAwsAccessKeys({ ...AWS, fetchImpl: answers(403) }),
    'AWS IAM ListAccessKeys failed: HTTP 403',
  ],
  [
    'aws-roll.js: the access key create',
    'src/lib/credentials/aws-roll.js',
    409,
    () => createAwsAccessKey({ ...AWS, fetchImpl: answers(409) }),
    'AWS IAM CreateAccessKey failed: HTTP 409',
  ],
  [
    'aws-roll.js: the access key delete',
    'src/lib/credentials/aws-roll.js',
    404,
    () => deleteAwsAccessKey({ ...AWS, targetAccessKeyId: 'AKIA-OLD', fetchImpl: answers(404) }),
    'AWS IAM DeleteAccessKey for AKIA-OLD failed: HTTP 404',
  ],
  [
    'studyguide.js: the study guide page',
    'src/lib/listen-and-learn/studyguide.js',
    404,
    () => {
      vi.stubGlobal('fetch', answers(404));
      return fetchStudyGuide({ provider: 'microsoft', examCode: 'az-104', sourceUrl: 'https://learn.example/az-104' });
    },
    'Study guide fetch failed: HTTP 404 for https://learn.example/az-104',
  ],
];

describe('an error about another service carries its HTTP status as a field (#1802)', () => {
  it.each(SITES)('%s', async (_, file, status, call, message) => {
    const error = await call().then(
      () => null,
      (thrown) => thrown
    );
    expect(error).toBeInstanceOf(Error);

    // The message is what it was: callers, tests and the owner's scripts read it.
    if (message instanceof RegExp) expect(error.message).toMatch(message);
    else expect(error.message).toBe(message);

    // The status is a field, and it is the number and nothing else.
    expect(error.status).toBe(status);

    // The log line shows the status beside the file that threw. No part of
    // the service's answer is in it.
    const facts = errorFacts(error);
    expect(facts).toContain(`status=${status}`);
    expect(facts).toContain(`at=${file}:`);
    expect(facts).not.toContain(BODY_TEXT);
  });

  it('covers every site that uses withStatus or passes status to its error', () => {
    // A count, so a site added later without a row is noticed when this file is read.
    expect(SITES).toHaveLength(21);
  });
});

describe('the lines that are written from these errors', () => {
  it('the Keys tab logs the status when Key Vault refuses a write, and answers as it did', async () => {
    const log = { error: vi.fn() };
    const written = await writeCatalogSecret(
      {
        store: {},
        env: {},
        now: () => '2026-11-24T00:00:00.000Z',
        log,
        vault: {
          setVaultSecret: (name, value) =>
            setVaultSecret(name, value, {
              fetch: answers(403),
              credential: { getToken: async () => ({ token: 'placeholder' }) },
              vaultUrl: 'https://kv/',
            }),
          refreshKeyVaultReferences: vi.fn(),
        },
      },
      { name: 'GEMINI-API-KEY', value: 'gem-PLACEHOLDER-9999999999', actor: 'tester' }
    );
    expect(written).toEqual({
      ok: false,
      vaultWritten: false,
      status: 502,
      error: 'Key Vault refused the write for GEMINI-API-KEY. The value was not stored.',
    });
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error.mock.calls[0][0]).toMatch(
      /^\[admin-secrets\] could not set GEMINI-API-KEY: name=Error status=403 at=src\/lib\/secret-vault\.js:\d+/
    );
  });

  it('the price reader logs HTTP_503, where it logged Error, and still falls back to the baseline', async () => {
    const logger = { warn: vi.fn(), info: vi.fn() };
    const rows = await fetchLivePricing('compute-vm', 'us-east-1', null, {
      logger,
      suppressMissLog: true,
      loaders: {
        aws: async () => null,
        azure: (serviceId, region) => fetchAzurePrice(serviceId, region, { fetch: answers(503) }),
        gcp: async () => null,
      },
    });
    expect(Array.isArray(rows)).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith(
      '[cloud-tools-pricing] live price fetch FAILED',
      expect.objectContaining({ provider: 'azure', code: 'HTTP_503' })
    );
  });

  it('the scraper logs the status of a refused page, and its answer is the same sentence', async () => {
    const log = { log: vi.fn(), warn: vi.fn() };
    const result = await scrapeArticle('https://site.test/post', {
      fetch: answers(403),
      env: {},
      now: () => 0,
      resolve: async () => ({ address: '93.184.216.34' }),
      log,
    });
    expect(result).toMatchObject({ success: false, scrapeMode: 'failed', error: 'Status code 403' });
    expect(log.warn.mock.calls[0][0]).toMatch(
      /^\[scraper\] Direct scrape failed: name=ScrapeError status=403 at=src\/lib\/content\/scrape\.js:\d+/
    );
  });

  it('a refused preview keeps the 502 it answers with, and the line also shows what the host said', async () => {
    const error = await fetchPreviewAudio('https://storage.googleapis.com/eleven-public-prod/a/b.mp3', {
      fetchImpl: answers(403),
    }).catch((thrown) => thrown);
    expect(error).toMatchObject({
      message: 'The preview host answered HTTP 403.',
      status: 502,
      upstreamStatus: 403,
    });
    expect(errorFacts(error)).toMatch(/^name=SpeechError code=\S+ status=502 upstream=403 at=src\/lib\/listen-and-learn\/speech\/elevenlabs-preview\.js:\d+/);
    // The code a caller branches on, and a stored sentence, are as they were.
    expect(errorCode(error)).toBe(error.code);
    expect(storedFailure(error, 'x')).toBe('The preview host answered HTTP 403.');
  });
});
