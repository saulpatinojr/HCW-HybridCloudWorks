/**
 * router-transport.js — how the AI router (router.js) talks to a provider:
 * the message parts each API takes, the provider endpoints and pacing, the
 * bounded POST, which failures are retried or failed over, and the budget a
 * call runs inside. router.js re-exports the public names.
 */
import { AuthoredError, errorCode } from '../http/error-response.js';
import { MIN_ATTEMPT_MS, providerShareMs } from './time-budget.js';
import { KEY_ENV } from './router-base.js';
import { isRetryableError, readKey } from './router-base.js';

/**
 * A part a converter cannot carry is refused, never dropped.
 *
 * Until #433 each converter returned null for a shape it did not recognise and
 * filtered it out, so a `fileData` part reached the model as nothing and the
 * model answered — confidently — without it. Nothing errored and nothing
 * logged. The refusal is a 400 on purpose: `isRetryableError` will not retry
 * it and `isProviderUnusable` will not fail over from it, because the next
 * provider would refuse the same part (or, worse, be the one that drops it).
 * The wording avoids every token those two predicates match on.
 */
function refusePart(provider, part, expected) {
  const shape =
    part && typeof part === 'object' ? `{${Object.keys(part).join(', ')}}` : String(typeof part);
  const err = new Error(
    `Cannot send a prompt part to ${provider}: expected ${expected}, got ${shape}. Nothing was sent.`
  );
  err.status = 400;
  err.code = 'AI_PART_REFUSED';
  return err;
}

/** Multimodal parts → OpenAI content blocks. */
export function toOpenAiContent(parts, prompt) {
  if (!Array.isArray(parts) || parts.length === 0) return [{ type: 'text', text: prompt }];
  return parts.map((part) => {
    if (typeof part?.text === 'string') return { type: 'text', text: part.text };
    const mime = String(part?.inlineData?.mimeType || '').toLowerCase();
    if (mime.startsWith('image/') && part?.inlineData?.data) {
      return {
        type: 'image_url',
        image_url: { url: `data:${mime};base64,${part.inlineData.data}` },
      };
    }
    throw refusePart(
      'openai',
      part,
      mime
        ? `{text} or image/* inline data, not ${mime}`
        : '{text} or {inlineData:{mimeType:image/*,data}}'
    );
  });
}

/**
 * Parts → one plain string, for a text-only provider. Only text parts are
 * possible here — `chainForParts` keeps anything else away — so any other
 * shape is refused rather than dropped, as everywhere else.
 */
export function toPlainText(parts, prompt) {
  if (!Array.isArray(parts) || parts.length === 0) return prompt;
  return parts
    .map((part) => {
      if (typeof part?.text === 'string') return part.text;
      throw refusePart('nvidia', part, '{text}');
    })
    .join('\n\n');
}

/** Multimodal parts → Anthropic content blocks. */
export function toAnthropicContent(parts, prompt) {
  if (!Array.isArray(parts) || parts.length === 0) return [{ type: 'text', text: prompt }];
  return parts.map((part) => {
    if (typeof part?.text === 'string') return { type: 'text', text: part.text };
    const mime = String(part?.inlineData?.mimeType || '').toLowerCase();
    if (mime.startsWith('image/') && part?.inlineData?.data) {
      return {
        type: 'image',
        source: {
          type: 'base64',
          media_type: part.inlineData.mimeType,
          data: part.inlineData.data,
        },
      };
    }
    throw refusePart(
      'anthropic',
      part,
      mime
        ? `{text} or image/* inline data, not ${mime}`
        : '{text} or {inlineData:{mimeType:image/*,data}}'
    );
  });
}

/** Multimodal parts → Gemini parts (already the native shape). */
export function toGeminiParts(parts, prompt) {
  if (!Array.isArray(parts) || parts.length === 0) return [{ text: prompt }];
  return parts.map((part) => {
    if (typeof part?.text === 'string') return { text: part.text };
    if (part?.inlineData?.mimeType && part?.inlineData?.data) {
      return {
        inlineData: {
          mimeType: part.inlineData.mimeType,
          data: part.inlineData.data,
        },
      };
    }
    // A URL the model should fetch is not a part on this endpoint at all — it
    // is a grounded call; see generateGroundedJsonResponse.
    throw refusePart('gemini', part, '{text} or {inlineData:{mimeType,data}}');
  });
}

// ---------------------------------------------------------------------------
// NVIDIA API Catalog (#701).

export const NVIDIA_BASE_URL = 'https://integrate.api.nvidia.com/v1';

/**
 * The Entra audience the Foundry v1 endpoint accepts. Microsoft's pages name
 * two: the keyless-authentication guide for Foundry resources on the
 * /openai/v1 path says tokens must carry `https://ai.azure.com/.default`,
 * while older Azure OpenAI pages say `https://cognitiveservices.azure.com`.
 * This is the documented one for the resource kind foundry.tf creates;
 * FOUNDRY_TOKEN_SCOPE in the environment overrides it, so a 401 on the other
 * audience is an app setting away rather than a deploy.
 */
export const FOUNDRY_TOKEN_SCOPE = 'https://ai.azure.com/.default';

/** The audience to request: the environment's override, else FOUNDRY_TOKEN_SCOPE. */
export const foundryTokenScope = (env) => readKey(env, 'FOUNDRY_TOKEN_SCOPE') || FOUNDRY_TOKEN_SCOPE;

/** The account's base URL for the OpenAI v1 surface, from FOUNDRY_ENDPOINT without a trailing slash. */
export function foundryBaseUrl(env) {
  return readKey(env, KEY_ENV.foundry).replace(/\/+$/, '');
}

/**
 * An Entra token for Foundry, fetched through @azure/identity and reused
 * until five minutes before it expires (#849). `getToken(scope)` is the
 * credential's own shape, `{ token, expiresOnTimestamp }`, so a test hands
 * in a stub and production hands in DefaultAzureCredential: the Function
 * App's system-assigned identity there, `az login` on a workstation.
 */
export function createFoundryTokenProvider({
  getToken,
  now = () => Date.now(),
  scope = FOUNDRY_TOKEN_SCOPE,
}) {
  const EARLY_MS = 5 * 60_000;
  let cached = null;
  return async () => {
    if (cached && cached.expiresOnTimestamp - now() > EARLY_MS) return cached.token;
    cached = await getToken(scope);
    return cached.token;
  };
}

/**
 * Production's token source: @azure/identity, imported only when Foundry is
 * first called. The specifier is a variable with `@vite-ignore` because the
 * frontend's contract tests import this module through Vite, which would
 * otherwise try to resolve a package only the Function App installs.
 */
export async function defaultGetToken(scope) {
  const identity = '@azure/identity';
  const { DefaultAzureCredential } = await import(/* @vite-ignore */ identity);
  return new DefaultAzureCredential().getToken(scope);
}

/**
 * Requests per rolling minute this instance will send to NVIDIA.
 *
 * The account limit is about 40 RPM (issue #701, checked 2026-09-25). 36 leaves
 * headroom for the admin portal's Test button and for clock skew between our
 * window and theirs. `NVIDIA_REQUESTS_PER_MINUTE` overrides it — lower, or
 * higher once NVIDIA raises the account's limit.
 *
 * The guard is per Function App INSTANCE. Two instances can together exceed
 * the account limit; when they do, NVIDIA answers 429, the router retries and
 * then fails over, which is the same degradation by a longer road.
 */
export const NVIDIA_DEFAULT_RPM = 36;

/** Reasoning models think before they answer; 60 s was sized for chat. */
export const NVIDIA_TIMEOUT_MS = 120_000;

/**
 * A draft is long. Without it some NIM endpoints apply a small default and
 * truncate mid-article; a model whose cap is lower answers 400, which fails
 * over (see the header).
 */
export const NVIDIA_MAX_TOKENS = 8192;

/**
 * A sliding-window pacing guard: at most `limit` grants in any `windowMs`.
 *
 * Sliding rather than a refilling bucket so the bound is exact — a full bucket
 * plus a minute of refill can pass nearly twice the limit inside one rolling
 * minute, which is precisely what an RPM limit counts. `take()` never waits: a
 * refusal is immediate, so the caller fails over instead of holding a request
 * open for up to a minute.
 */
export function createRequestPacer({ limit, windowMs = 60_000, now = () => Date.now() }) {
  const grants = [];
  const prune = (t) => {
    while (grants.length && t - grants[0] >= windowMs) grants.shift();
  };
  return {
    take() {
      const t = now();
      prune(t);
      if (grants.length >= limit) return false;
      grants.push(t);
      return true;
    },
    /** Grants inside the current window; for tests and diagnostics. */
    used() {
      prune(now());
      return grants.length;
    },
  };
}

export function nvidiaRpm(env) {
  const n = Number.parseInt(String(env?.NVIDIA_REQUESTS_PER_MINUTE ?? ''), 10);
  return Number.isInteger(n) && n > 0 ? n : NVIDIA_DEFAULT_RPM;
}

export function pacedError(limit) {
  const err = new Error(
    `nvidia pacing guard: ${limit} requests in the last minute already sent from this instance; not sent.`
  );
  // 429 so it reads as what it is everywhere else; AI_PACED so withRetry does
  // not sleep and try again against a window that is still full.
  err.status = 429;
  err.code = 'AI_PACED';
  return err;
}

/** Providers that take text only, and are left out of a call carrying other parts. */
export const TEXT_ONLY_PROVIDERS = Object.freeze(['nvidia']);

export function hasNonTextParts(parts) {
  return Array.isArray(parts) && parts.some((part) => typeof part?.text !== 'string');
}

/** Some reasoning models inline their thinking; the answer is what follows it. */
export function stripThinking(text) {
  return String(text || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .trim();
}

/**
 * One chat attempt's timeout for a provider whose table row sets none: every
 * provider but NVIDIA. A budgeted call cuts it shorter, never longer.
 */
export const CHAT_TIMEOUT_MS = 60_000;

export async function postJson(fetchImpl, url, { headers, body, timeoutMs = CHAT_TIMEOUT_MS, signal: parentSignal }) {
  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
  const signal = parentSignal
    ? AbortSignal.any([parentSignal, timeoutController.signal])
    : timeoutController.signal;
  if (signal.aborted) {
    clearTimeout(timer);
    const err = new Error(signal.reason?.message || 'aborted');
    err.status = 408;
    throw err;
  }
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal,
    });
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!response.ok) {
      const detail = data?.error?.message || data?.message || text.slice(0, 300);
      const err = new Error(`${response.status} ${detail}`);
      err.status = response.status;
      throw err;
    }
    return data;
  } catch (error) {
    if (error?.name === 'AbortError' && !parentSignal?.aborted) {
      const err = new Error(`timeout after ${timeoutMs} ms`);
      err.status = 408;
      throw err;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Does this error mean the PROVIDER is unusable, or that the REQUEST is bad?
 *
 * The distinction decides whether trying the next provider is worth anything.
 * A rejected key, a missing model or a dead endpoint is specific to one
 * provider and the next one will very likely work. A malformed request will
 * be malformed for all three, and walking the whole chain to prove it just
 * spends money and time on the same failure.
 */
export function isProviderUnusable(error, provider = null) {
  const status = Number(error?.status);
  // NVIDIA only: its models differ in context length and accepted
  // parameters, so its 400 is not evidence the request is bad everywhere
  // (header). A part we refused ourselves is, and stays put.
  if (provider === 'nvidia' && [400, 422].includes(status) && error?.code !== 'AI_PART_REFUSED') {
    return true;
  }
  // 401/403 rejected key, 404 unknown model or endpoint.
  if ([401, 403, 404].includes(status)) return true;
  // Anything retryable that survived its retries: the provider is not coming
  // back within this call.
  if (isRetryableError(error)) return true;
  return /model|not found|unsupported|deprecated|quota|billing|credit/i.test(
    String(error?.message || '')
  );
}

/**
 * How a budgeted call ends when too little time is left to try the next
 * provider.
 *
 * It names each provider that was tried with its reason, and each that was
 * never reached. "Timed out" on its own would hide which provider spent the
 * time, and that is the one thing the owner needs in order to act. Status
 * 504 and code AI_BUDGET_EXHAUSTED let a handler map it to an HTTP status.
 * Nothing retries it: it is thrown outside withRetry, and after failover.
 */
function budgetExhausted(budget, attempts, untried) {
  const seconds = Math.round(budget.totalMs / 1000);
  const notTried = untried.map((entry) => entry.provider).join(', ');
  // Each reason is a code, never the provider's own message, so the sentence
  // stays this module's and an admin route may show it whole (#945).
  const tried = attempts
    .map(({ provider, error }) => `${provider} (${attemptReason(error)})`)
    .join('; ');
  return new AiBudgetExhaustedError(
    tried
      ? `This AI call's ${seconds} s budget ran out after ${tried}. Not tried: ${notTried}.`
      : `This AI call's ${seconds} s budget left too little time to try any provider (${notTried}).`,
    attempts.length ? attempts.at(-1).error : undefined
  );
}

/**
 * Why one attempt ended, content-free: "timed out" for the router's own
 * timeout, otherwise the error's code or HTTP status.
 *
 * @param {unknown} error - what the attempt threw
 * @returns {string}
 */
function attemptReason(error) {
  return error?.status === 408 && !error?.code ? 'timed out' : errorCode(error);
}

/**
 * The AI call's time budget is spent. Status 504, code AI_BUDGET_EXHAUSTED;
 * the sentence names the providers and their reasons as codes (authored).
 */
export class AiBudgetExhaustedError extends AuthoredError {
  /**
   * @param {string} message - the authored sentence
   * @param {unknown} [cause] - the last attempt's error, for the log
   */
  constructor(message, cause) {
    super(message, { code: 'AI_BUDGET_EXHAUSTED', status: 504, cause });
  }
}

/**
 * When this provider's share of the budget ends, or the AI_BUDGET_EXHAUSTED
 * error when too little is left to start it at all.
 */
export function shareEndFor(now, budget, { chain, index, attempts }) {
  const startedAt = now();
  const shareMs = providerShareMs({
    remainingMs: budget.deadline - startedAt,
    reserveMs: budget.reserveMs,
    hasNext: index < chain.length - 1,
  });
  if (shareMs === 0) throw budgetExhausted(budget, attempts, chain.slice(index));
  return startedAt + shareMs;
}

/**
 * Retry a retryable failure with backoff. `sleep` and `now` are the router's
 * clock, passed in so a test can run the backoff without waiting it out.
 *
 * Two exceptions, both about not waiting for nothing: a pacing refusal
 * (AI_PACED) is never retried — the window is still full two seconds later
 * — and NVIDIA's timeout is not either, because two more 120 s attempts
 * would hold an owner's job for six minutes before failing over.
 *
 * Inside a budget, `shareEnd` is when this provider's share runs out. A
 * retry is made only if the share still holds MIN_ATTEMPT_MS after the
 * backoff. The check is repeated once the wait is over, in case the wait
 * ran long. Otherwise the error goes straight to the failover, which is
 * worth more than a retry that cannot finish.
 */
export async function withRetry(
  { sleep, now },
  operation,
  { maxAttempts = 3, provider = null, shareEnd = null } = {}
) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const again = await waitToRetry({ sleep, now }, error, { attempt, maxAttempts, provider, shareEnd });
      if (!again) break;
    }
  }
  throw lastError;
}

/** Whether a failure is worth another attempt at all (the two exceptions above, then the retryable kinds). */
function worthRetrying(error, { attempt, maxAttempts, provider }) {
  if (error?.code === 'AI_PACED') return false;
  if (provider === 'nvidia' && Number(error?.status) === 408) return false;
  return attempt < maxAttempts && isRetryableError(error);
}

/** Whether the provider's share still holds MIN_ATTEMPT_MS after waiting `waitMs` (always, outside a budget). */
const shareHolds = (shareEnd, now, waitMs) => shareEnd === null || shareEnd - now() - waitMs >= MIN_ATTEMPT_MS;

/** Wait out the backoff before a retry: false, without waiting, when no retry should be made. */
async function waitToRetry({ sleep, now }, error, { attempt, maxAttempts, provider, shareEnd }) {
  if (!worthRetrying(error, { attempt, maxAttempts, provider })) return false;
  const backoffMs = 2 ** attempt * 1000;
  if (!shareHolds(shareEnd, now, backoffMs)) return false;
  await sleep(backoffMs);
  return shareHolds(shareEnd, now, 0);
}
