/**
 * The Health page's on-demand checks themselves: they make the requests (the
 * session's identity, the Labs no-op probe with and without a token) and
 * hand the answers to identityVerdicts.jsx. No React state; the page awaits
 * these. Moved out of probes.jsx, which re-exports them.
 */
import { authedFetch, getEndpoint, getJSON, postJSON } from '@/lib/api';

import {
  LABS_PROBE_JOB,
  decodeJwtPayload,
  summarizeAdminStatus,
  summarizeToken,
} from './identityVerdicts';

// ── The checks themselves (no React state; the page awaits these) ────────────

/** Read a Response body as JSON without throwing on a non-JSON body. */
const bodyOf = async (res) => {
  try {
    return await res.json();
  } catch {
    return null;
  }
};

export const messageOf = (err, fallback) => err?.message || fallback;

/**
 * Token, expectations, registry. The decoded payload lives only inside this
 * function; only the summaries leave it.
 */
export async function collectIdentity() {
  const result = {
    token: null,
    tokenError: null,
    expectations: null,
    expectationsError: null,
    admin: null,
    adminHttp: null,
    adminError: null,
  };
  // ONE acquisition, decoded here and sent on the status call. authedFetch
  // force-refreshes for getCurrentAdminStatus so a just-granted role is
  // visible at once; decoding a separately acquired (cached) token could show
  // the role missing while the API call, on a fresh token, succeeded. So the
  // token is acquired once with that same refresh behaviour and handed to
  // authedFetch as `token`, which skips its own acquisition — so the claims
  // shown and the claims the API judged are the same bytes, and there is no
  // second (forced-refresh) round trip to Entra.
  let payload = null;
  let token = null;
  try {
    const { acquireApiToken } = await import('@/lib/entraAuth');
    token = await acquireApiToken({ forceRefresh: true });
    payload = decodeJwtPayload(token);
    if (!payload) result.tokenError = 'the access token could not be decoded';
  } catch (err) {
    result.tokenError = messageOf(err, 'could not acquire the access token');
  }
  try {
    // Same acquisition as the status call below — the whole run is one token.
    result.expectations = await getJSON('getAuthExpectations', token ? { token } : {});
  } catch (err) {
    result.expectationsError = messageOf(err, 'getAuthExpectations failed');
  }
  result.token = summarizeToken(payload, result.expectations);
  try {
    const res = await authedFetch('getCurrentAdminStatus', {
      method: 'GET',
      ...(token ? { token } : {}),
    });
    result.adminHttp = res.status;
    const body = await bodyOf(res);
    if (body === null) {
      // A 2xx with nothing parseable is not "no admin" and not a silent blank:
      // it is its own finding, and it must say so in the panel and the report.
      result.adminError = `status route answered ${res.status} with no JSON body`;
    } else {
      result.admin = summarizeAdminStatus(body, payload?.oid ?? payload?.sub ?? null);
    }
  } catch (err) {
    result.adminError = messageOf(err, 'getCurrentAdminStatus failed');
  }
  token = null;
  return result;
}

/** Enqueue exactly as the Labs console does; read back; cancel; read again. */
export async function runLabsProbeSteps() {
  const probe = { enqueue: null, read: null, cancel: null, final: null };
  try {
    const res = await authedFetch('enqueueLabJob', {
      method: 'POST',
      body: JSON.stringify(LABS_PROBE_JOB),
    });
    const body = (await bodyOf(res)) || {};
    probe.enqueue = {
      httpStatus: res.status,
      jobId: body.jobId ?? null,
      type: body.type ?? null,
      status: body.status ?? null,
    };
  } catch (err) {
    probe.enqueue = { httpStatus: null, error: messageOf(err, 'enqueueLabJob failed') };
    return probe;
  }

  const { jobId } = probe.enqueue;
  if (!jobId) return probe;

  try {
    const { job } = await postJSON('getLabJob', { jobId });
    probe.read = { found: Boolean(job), status: job?.status ?? null };
  } catch (err) {
    probe.read = { found: false, error: messageOf(err, 'getLabJob failed') };
  }
  try {
    const cancelled = await postJSON('cancelLabJob', { jobId });
    probe.cancel = { httpStatus: 200, status: cancelled?.status ?? null };
  } catch (err) {
    // 409 means an agent already claimed it — not a hang, and reported as such.
    probe.cancel = { error: messageOf(err, 'cancelLabJob failed') };
  }
  try {
    const { job } = await postJSON('getLabJob', { jobId });
    probe.final = { status: job?.status ?? null };
  } catch (err) {
    probe.final = { status: null, error: messageOf(err, 'getLabJob failed') };
  }
  return probe;
}

/** The same request through plain fetch: no token acquired, no header. */
export async function probeUnauthenticated() {
  // Outside the try on purpose: an unset VITE_AZURE_FUNCTIONS_URL throws
  // here, and that is a configuration fault to surface as one, not a probe
  // result to score as a failed request.
  const url = getEndpoint('enqueueLabJob');
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(LABS_PROBE_JOB),
    });
    const body = (await bodyOf(res)) || {};
    return { httpStatus: res.status, error: null, message: body.error ?? null };
  } catch (err) {
    return { httpStatus: null, error: messageOf(err, 'request failed') };
  }
}
