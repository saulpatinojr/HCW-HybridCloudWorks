/**
 * google-auth.js — signs the Function App in to Google with no stored secret
 * (#1612), so the Search Console sync can read the site's Google data.
 *
 * ## How it works, in three hops
 *
 * Google calls this "workload identity federation"
 * (https://cloud.google.com/iam/docs/workload-identity-federation-with-other-clouds):
 * Google agrees, once, to trust tokens that Microsoft Entra issues for this
 * app, and to let them act as one Google service account.
 *
 *   1. Entra token. The Function App's managed identity (an identity Azure
 *      gives the app, with no password) asks Entra for a token whose audience
 *      is our own app registration's Application ID URI (GSC_ENTRA_APP_ID_URI).
 *      Its `sub` claim is the identity's object id, which is what Google's
 *      pool is told to trust.
 *   2. Token exchange. Google's Security Token Service (sts.googleapis.com)
 *      swaps that token for a short-lived "federated" Google token, after
 *      checking it against the pool provider named by GSC_WIF_AUDIENCE.
 *   3. Impersonation. The IAM Credentials API turns the federated token into
 *      an access token for the service account GSC_SERVICE_ACCOUNT_EMAIL,
 *      limited to the read-only Search Console scope. That token is what
 *      client.js sends to Search Console.
 *
 * Google's page shows the VM flavour of hop 1 (asking the Azure instance
 * metadata endpoint for a token). A Function App gets managed-identity tokens
 * through a different local endpoint, so this file asks @azure/identity for
 * the token and does hops 2 and 3 itself instead of using Google's client
 * library and a credential configuration file.
 *
 * ## Invariants
 *
 * 1. NO TOKEN LEAVES THIS FILE except as the return value of getAccessToken.
 *    No token, and no Google response body (which can echo one), is ever
 *    logged, thrown, stored or returned in an error.
 * 2. ERRORS NAME THE HOP AND THE HTTP STATUS, nothing else, as a
 *    GoogleAuthError whose sentence this file wrote (an AuthoredError, so the
 *    admin page may show it).
 * 3. PURE AND INJECTABLE: `fetchImpl`, the Azure `credential`, the settings
 *    (`env`) and the clock are parameters, so the tests run with no network.
 * 4. CACHED IN MEMORY until five minutes before the Google token expires, and
 *    two callers asking at once share one sign-in.
 * 5. NO HOP WAITS FOREVER: each call to Google gives up after 30 seconds
 *    (http/fetch-with-timeout.js) and fails as that hop. When the provider is
 *    given the run's `signal` (an AbortSignal, the run's cancel switch), every
 *    hop is also cut off the moment it fires, so a run that has reached its
 *    time limit is not kept waiting by a sign-in.
 */
import { DefaultAzureCredential, ManagedIdentityCredential } from '@azure/identity';
import { AuthoredError } from '../http/error-response.js';
import { fetchWithTimeout } from '../http/fetch-with-timeout.js';

export const STS_TOKEN_URL = 'https://sts.googleapis.com/v1/token';
export const IAM_CREDENTIALS_BASE = 'https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts';
/** What the federated token may do: only ask for the service account's token, in practice. */
export const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
/** What the service account's token may do: read Search Console, nothing else. */
export const SEARCH_CONSOLE_READONLY_SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
/** Renew this long before the Google token expires. */
export const EARLY_RENEW_MS = 5 * 60 * 1000;
/** Asked of the IAM Credentials API; one hour is its default maximum. */
export const TOKEN_LIFETIME = '3600s';

/** The app settings this file reads, by name. Identifiers, not secrets. */
export const SETTING_NAMES = Object.freeze({
  audience: 'GSC_WIF_AUDIENCE',
  appIdUri: 'GSC_ENTRA_APP_ID_URI',
  serviceAccountEmail: 'GSC_SERVICE_ACCOUNT_EMAIL',
  siteUrl: 'GSC_SITE_URL',
});
export const DEFAULT_SITE_URL = 'sc-domain:hybridcloudworks.com';

/** One sentence per hop, written here, so a failure says where to look. */
const HOP_SENTENCES = Object.freeze({
  entra:
    'Google sign-in failed at hop 1: the Function App could not get an Entra token for GSC_ENTRA_APP_ID_URI. Check that the app registration exists and its Application ID URI matches the setting.',
  sts:
    'Google sign-in failed at hop 2: Google\'s token service refused the Entra token. Check the workload identity pool provider: its issuer, its allowed audience (the Application ID URI) and GSC_WIF_AUDIENCE.',
  impersonation:
    'Google sign-in failed at hop 3: Google refused to issue the service account\'s token. Check that the Function App\'s identity holds Workload Identity User on the service account, and that the IAM Credentials API is enabled.',
});

/**
 * A failed hop. `kind` is 'entra' | 'sts' | 'impersonation'; `status` is the
 * HTTP status Google answered with, or undefined when the hop never reached
 * Google. The message is this file's own sentence plus the status.
 */
export class GoogleAuthError extends AuthoredError {
  /**
   * @param {'entra'|'sts'|'impersonation'} kind
   * @param {number} [status]
   */
  constructor(kind, status) {
    const suffix = Number.isInteger(status) ? ` (HTTP ${status})` : '';
    super(`${HOP_SENTENCES[kind] ?? 'Google sign-in failed.'}${suffix}`, {
      code: `GSC_AUTH_${String(kind).toUpperCase()}`,
      ...(Number.isInteger(status) ? { status } : {}),
    });
    this.kind = kind;
  }
}

const text = (value) => (typeof value === 'string' ? value.trim() : '');

/**
 * The four settings, trimmed, and whether the three that sign in are all set.
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {{ audience: string, appIdUri: string, serviceAccountEmail: string, siteUrl: string, configured: boolean, missing: string[] }}
 */
export function readGoogleAuthConfig(env = process.env) {
  const audience = text(env[SETTING_NAMES.audience]);
  const appIdUri = text(env[SETTING_NAMES.appIdUri]).replace(/\/+$/, '');
  const serviceAccountEmail = text(env[SETTING_NAMES.serviceAccountEmail]);
  const siteUrl = text(env[SETTING_NAMES.siteUrl]) || DEFAULT_SITE_URL;
  const missing = [
    ['audience', audience],
    ['appIdUri', appIdUri],
    ['serviceAccountEmail', serviceAccountEmail],
  ]
    .filter(([, value]) => !value)
    .map(([key]) => SETTING_NAMES[key]);
  return { audience, appIdUri, serviceAccountEmail, siteUrl, configured: missing.length === 0, missing };
}

/**
 * The same credential choice cosmos-client.js makes: the managed identity
 * when running in Azure (WEBSITE_INSTANCE_ID or IDENTITY_ENDPOINT is set),
 * otherwise whatever `az login` provides on a workstation.
 *
 * Everything this function decides is read from `env`. The Function App uses
 * its system-assigned identity, so AZURE_CLIENT_ID is normally empty; when it
 * is set (a user-assigned identity), it is passed to the managed identity
 * credential from `env` too. DefaultAzureCredential, the workstation branch,
 * takes no settings object: it reads its own variables from process.env, so
 * that branch cannot be steered through `env`.
 */
export function defaultAzureCredential(env = process.env) {
  if (!(env.WEBSITE_INSTANCE_ID || env.IDENTITY_ENDPOINT)) return new DefaultAzureCredential();
  const clientId = typeof env.AZURE_CLIENT_ID === 'string' ? env.AZURE_CLIENT_ID.trim() : '';
  return clientId ? new ManagedIdentityCredential({ clientId }) : new ManagedIdentityCredential();
}

/** Read a JSON body without letting a parse failure carry its text anywhere. */
async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * Build the sign-in. `getAccessToken()` returns a Search Console access
 * token string; `reset()` drops the cached one (used after Google answers
 * 401 to a token it issued).
 *
 * @param {object} deps
 * @param {string} deps.audience - the pool provider's full resource name, `//iam.googleapis.com/projects/…/providers/…`
 * @param {string} deps.appIdUri - the Entra Application ID URI the token is minted for
 * @param {string} deps.serviceAccountEmail
 * @param {{ getToken: (scope: string) => Promise<{ token: string }|null> }} [deps.credential]
 * @param {Record<string, string|undefined>} [deps.env] - where the Azure credential choice is read from
 * @param {typeof fetch} [deps.fetchImpl]
 * @param {() => number} [deps.now] - milliseconds
 * @param {AbortSignal} [deps.signal] - the run's cancel switch; cuts off every hop when it fires
 */
export function createGoogleTokenProvider({
  audience,
  appIdUri,
  serviceAccountEmail,
  credential,
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  signal,
}) {
  let cached = null; // { token, expiresAt }
  /** Added to every request, so the run's cancel switch reaches it. */
  const cancel = signal ? { signal } : {};
  let inflight = null;
  let azureCredential = credential ?? null;

  async function entraToken() {
    azureCredential ??= defaultAzureCredential(env);
    let answer = null;
    try {
      answer = signal
        ? await azureCredential.getToken(`${appIdUri}/.default`, { abortSignal: signal })
        : await azureCredential.getToken(`${appIdUri}/.default`);
    } catch {
      // The credential's own error can name endpoints and claims; only the hop is kept.
      throw new GoogleAuthError('entra');
    }
    if (!answer || typeof answer.token !== 'string' || !answer.token) throw new GoogleAuthError('entra');
    return answer.token;
  }

  async function federatedToken(subjectToken) {
    const form = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      audience,
      scope: CLOUD_PLATFORM_SCOPE,
      requested_token_type: 'urn:ietf:params:oauth:token-type:access_token',
      subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
      subject_token: subjectToken,
    });
    let response;
    try {
      response = await fetchWithTimeout(fetchImpl, STS_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
        ...cancel,
      });
    } catch {
      throw new GoogleAuthError('sts');
    }
    if (!response.ok) throw new GoogleAuthError('sts', response.status);
    const body = await readJson(response);
    const token = typeof body?.access_token === 'string' ? body.access_token : '';
    if (!token) throw new GoogleAuthError('sts', response.status);
    return token;
  }

  async function serviceAccountToken(federated) {
    const url = `${IAM_CREDENTIALS_BASE}/${encodeURIComponent(serviceAccountEmail)}:generateAccessToken`;
    let response;
    try {
      response = await fetchWithTimeout(fetchImpl, url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${federated}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: [SEARCH_CONSOLE_READONLY_SCOPE], lifetime: TOKEN_LIFETIME }),
        ...cancel,
      });
    } catch {
      throw new GoogleAuthError('impersonation');
    }
    if (!response.ok) throw new GoogleAuthError('impersonation', response.status);
    const body = await readJson(response);
    const token = typeof body?.accessToken === 'string' ? body.accessToken : '';
    if (!token) throw new GoogleAuthError('impersonation', response.status);
    const expiry = Date.parse(body?.expireTime);
    return { token, expiresAt: Number.isFinite(expiry) ? expiry : now() + 3600 * 1000 };
  }

  async function signIn() {
    const subject = await entraToken();
    const federated = await federatedToken(subject);
    return serviceAccountToken(federated);
  }

  return {
    /** A Search Console access token, from the cache while it has five minutes left. */
    async getAccessToken() {
      if (cached && cached.expiresAt - now() > EARLY_RENEW_MS) return cached.token;
      inflight ??= signIn().finally(() => {
        inflight = null;
      });
      cached = await inflight;
      return cached.token;
    },
    /** Forget the cached token, so the next call signs in again. */
    reset() {
      cached = null;
    },
  };
}
