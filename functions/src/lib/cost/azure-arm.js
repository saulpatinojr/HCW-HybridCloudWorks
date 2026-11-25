/**
 * cost/azure-arm.js — the one way cost/azure.js talks to Azure Resource
 * Manager (ARM, Azure's management API): a token from the Function App's
 * managed identity, a fetch with a time limit, one wait-and-retry on a 429,
 * and a sentence of our own for any answer that is not 2xx. azure.js
 * re-exports everything here, so callers and tests keep one import.
 */
import { DefaultAzureCredential } from '@azure/identity';
import { fetchWithTimeout } from '../http/fetch-with-timeout.js';
import { AuthoredError, codeShaped } from '../http/error-response.js';

export const ARM_ORIGIN = 'https://management.azure.com';
export const ARM_SCOPE = 'https://management.azure.com/.default';
export const BUDGETS_API_VERSION = '2023-11-01';
export const QUERY_API_VERSION = '2023-11-01';
/** Cost Management can take several seconds on a cold query; this is the ceiling. */
export const ARM_TIMEOUT_MS = 20_000;
/**
 * Cost Management's Query API is limited per TENANT in query processing units
 * (QPU): 12 per 10 seconds, 60 per minute, 600 per hour, one QPU per month of
 * data asked for, and the owner's own Cost Analysis in the portal spends the
 * same allowance. A 429 names the wait in
 * `x-ms-ratelimit-microsoft.costmanagement-qpu-retry-after` (seconds)
 * (https://learn.microsoft.com/azure/cost-management-billing/costs/manage-automation#data-latency-and-rate-limits,
 * read 2026-11-03). So the reader asks one question at a time, and on a 429
 * waits as long as Azure says, at most RETRY_WAIT_CAP_MS, and tries once more.
 */
export const QPU_RETRY_HEADER = 'x-ms-ratelimit-microsoft.costmanagement-qpu-retry-after';
export const RETRY_WAIT_CAP_MS = 30_000;
export const RETRY_WAIT_DEFAULT_MS = 10_000;
export const MAX_ATTEMPTS = 2;

/** ARM answered something other than 2xx; describeArmStatus wrote the sentence, no ARM text is in it. */
export class ArmStatusError extends AuthoredError {
  /**
   * @param {number} status
   * @param {{ retryAfterMs?: number|null, azureCode?: string, step?: string }} [details]
   *   azureCode is Azure's own error code from the answer body, kept only when
   *   it is code-shaped (http/error-response.js codeShaped), so no sentence of
   *   Azure's reaches the page; step names which of the reads it was.
   */
  constructor(status, { retryAfterMs = null, azureCode = '', step = '' } = {}) {
    super(describeArmStatus(status, { azureCode, step }), { code: 'ARM_STATUS' });
    this.status = status;
    this.retryAfterMs = retryAfterMs;
    this.azureCode = azureCode;
    this.step = step;
  }
}

/** The names of the three reads, as the page says them. */
export const STEPS = Object.freeze({
  budgets: 'the budgets read',
  monthToDate: 'the read of this month\u2019s costs',
  lastMonth: 'the read of last month\u2019s total',
});

/** Azure's error code from an answer body (`{ error: { code } }`), when it is code-shaped; else ''. */
export function azureErrorCode(bodyText) {
  try {
    const body = JSON.parse(bodyText);
    return codeShaped(body?.error?.code ?? body?.code ?? '');
  } catch {
    return '';
  }
}

/** How long a 429 asks to wait, in ms: the QPU header, else Retry-After, else the default; capped. */
export function retryAfterMs(headers) {
  const read = (name) => {
    const raw = headers?.get?.(name);
    // An absent header is null, and Number(null) is 0: that would mean "retry now".
    if (raw === null || raw === undefined || String(raw).trim() === '') return null;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? value * 1000 : null;
  };
  const ms = read(QPU_RETRY_HEADER) ?? read('retry-after') ?? RETRY_WAIT_DEFAULT_MS;
  return Math.min(ms, RETRY_WAIT_CAP_MS);
}

/**
 * What a non-2xx answer means, as a sentence the page may show. No ARM text is
 * copied: only the status, Azure's code when it is code-shaped, and which read
 * it was (STEPS), so the owner can tell a refused budgets list from a refused
 * cost query.
 */
export function describeArmStatus(status, { azureCode = '', step = '' } = {}) {
  // Azure sometimes sends the status itself as the code ("429"): saying it twice tells nothing.
  const code = azureCode && azureCode !== String(status) ? azureCode : '';
  const label = `HTTP ${status}${code ? ` ${code}` : ''}`;
  const where = step ? ` to ${step}` : '';
  if (status === 401 || status === 403) {
    return `Azure refused${where ? ` ${step}` : ' the read'} (${label}): the Function App's identity needs the Cost Management Reader role on this scope.`;
  }
  if (status === 404) return `Azure answered ${label}${where}: the scope does not exist or is not visible to this identity.`;
  if (status === 429) {
    return `Azure Cost Management is limiting how often it can be asked (${label}${where}), and still was after a wait; the next refresh will try again. Its allowance is shared with Cost Analysis in the Azure portal.`;
  }
  if (status === 400) {
    return `Azure answered ${label}${where}: it did not accept the question as asked. The code names the reason; the Cost runbook lists the ones seen so far.`;
  }
  return `Azure answered ${label}${where}.`;
}

/**
 * The ARM caller for one reader: `armFetch(path, init, step)` answers the
 * parsed JSON or throws ArmStatusError. The credential is built lazily, so a
 * process that never reads (a unit test, no scopes set) never probes for one.
 *
 * @param {{ fetchImpl: Function, credential?: { getToken: Function }, sleep: Function }} deps
 */
export function createArmFetch({ fetchImpl, credential, sleep }) {
  let cached = credential ?? null;
  const getCredential = () => (cached ??= new DefaultAzureCredential());

  async function armFetchOnce(path, init, step) {
    const token = await getCredential().getToken(ARM_SCOPE);
    if (!token?.token) throw new Error(`Could not acquire a token for ${ARM_SCOPE}`);
    const response = await fetchWithTimeout(fetchImpl, `${ARM_ORIGIN}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token.token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(init.headers ?? {}),
      },
      timeoutMs: ARM_TIMEOUT_MS,
    });
    if (!response.ok) throw await armStatusErrorOf(response, step);
    return response.json();
  }

  /** One ARM call; a 429 waits as long as Azure asks (capped) and tries again, up to MAX_ATTEMPTS. */
  return async function armFetch(path, init = {}, step = '') {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await armFetchOnce(path, init, step);
      } catch (error) {
        if (error?.status !== 429 || attempt >= MAX_ATTEMPTS) throw error;
        await sleep(error.retryAfterMs ?? RETRY_WAIT_DEFAULT_MS);
      }
    }
  };
}

/** The error for a non-2xx answer: its status, Azure's code (code-shaped only) and, on a 429, the wait. */
async function armStatusErrorOf(response, step) {
  const bodyText = await response.text?.().catch(() => '') ?? '';
  return new ArmStatusError(response.status, {
    retryAfterMs: response.status === 429 ? retryAfterMs(response.headers) : null,
    azureCode: azureErrorCode(bodyText),
    step,
  });
}
