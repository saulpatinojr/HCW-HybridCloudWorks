/**
 * The agent's only connection to the platform.
 *
 * There is deliberately no Cosmos client in this process. The agent runs on a
 * third-party VPS, which puts it outside the trust boundary in exactly the way
 * the browser is — so it gets the same answer the browser got during the
 * migration: an authenticated API, not a data-plane credential
 * (T-401).
 *
 * What it holds instead is an Entra **certificate** credential for a
 * confidential-client app registration carrying the `LabAgent` App Role. A
 * certificate rather than a client secret because the private key can be
 * generated on the VPS and never transmitted, and because a leaked secret is a
 * copy-paste away from working anywhere while a leaked certificate is at least
 * a file someone has to exfiltrate.
 *
 * Even so, assume the credential is stealable — a VPS is a machine you do not
 * fully control. What bounds the damage is the server: the four endpoints
 * this file calls are the whole of what the credential can do, and each is
 * constrained further (claim only registered job types, complete only jobs
 * this agent holds, hand over only the Coder status token and only a
 * working, read-only key of the status user, as Coder itself shows it).
 * See functions/src/lib/lab-agent.js.
 */

import { ClientCertificateCredential } from '@azure/identity';

/**
 * How long one call may take, token included, unless the caller names its
 * own. It bounds a claim already sent, which the agent waits out before it
 * acknowledges the host's maintenance hold (lib/maintenance-hold.js,
 * ACK_WITHIN_MS; LAB-13, #959).
 */
export const REQUEST_TIMEOUT_MS = 20000;

/**
 * Build the API client.
 *
 * @param {object} config
 * @param {string} config.apiBase - Functions base URL, including the `/api` route prefix
 * @param {string} config.tenantId
 * @param {string} config.clientId - the agent's app registration
 * @param {string} config.certificatePath - PEM containing the private key
 * @param {string} config.scope - e.g. `api://<api-client-id>/.default`
 * @param {string} config.agentId - must match the lab_agents registry document
 * @param {typeof fetch} [config.fetchImpl]
 * @param {{ getToken: Function }} [config.credential] - tests only; production
 *   always builds the certificate credential from the three values above
 */
export function createApiClient({
  apiBase,
  tenantId,
  clientId,
  certificatePath,
  scope,
  agentId,
  fetchImpl = fetch,
  credential: injectedCredential = null,
}) {
  const credential =
    injectedCredential ?? new ClientCertificateCredential(tenantId, clientId, certificatePath);

  // The SDK caches and refreshes internally; asking per request is correct and
  // cheap, and avoids the agent holding a token past its expiry across a long
  // idle period. The request's signal goes with it, so the timeout covers
  // the token too: a refresh that hangs at Entra would otherwise hold a
  // shutdown heartbeat past its 5 s (lib/shutdown.js).
  async function authHeader(abortSignal) {
    const token = await credential.getToken(scope, { abortSignal });
    if (!token?.token) throw new Error('failed to acquire an API token');
    return `Bearer ${token.token}`;
  }

  async function post(path, body, { timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`${apiBase}/${path}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: await authHeader(controller.signal),
        },
        // agentId travels in the body on every call; the server binds it to the
        // token's object id and refuses a mismatch, so it is a claim to be
        // checked rather than an assertion to be trusted.
        body: JSON.stringify({ agentId, ...body }),
        signal: controller.signal,
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const err = new Error(data.error || `${path} failed with HTTP ${res.status}`);
        err.status = res.status;
        throw err;
      }
      return data;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    /** @returns {Promise<{id: string, type: string, payload: string}|null>} */
    async claimJob() {
      const { job } = await post('agent/claimLabJob', {});
      return job ?? null;
    },

    /**
     * Liveness. The server owns the field names and the busy/idle derivation.
     * `applied` is the commit the host last converged from
     * (lib/applied-commit.js); null or absent leaves it out of the body.
     * `timeoutMs` is for the two shutdown heartbeats (lib/shutdown.js): at
     * the 20 s default, the pair alone could outlast the unit's stop budget.
     * Left undefined, `post` applies that default.
     */
    heartbeat({ status, activeJobs, hostname, version, applied }, { timeoutMs } = {}) {
      return post(
        'agent/heartbeat',
        {
          status,
          activeJobs,
          hostname,
          version,
          applied: applied ?? undefined,
        },
        { timeoutMs }
      );
    },

    /** Terminal result. The server refuses jobs this agent does not hold. */
    completeJob({ jobId, claimId, status, exitCode, output }) {
      return post('agent/completeLabJob', {
        jobId,
        claimId: claimId ?? undefined,
        status,
        exitCode,
        output,
      });
    },

    /**
     * The lab host's Coder upkeep, and a renewed status token when there is
     * one (bin/report-coder-automation.js). The server verifies the token
     * against Coder before it stores it, and answers `{ ok, stored }`; an
     * absent `statusToken` is left out of the body by JSON.stringify.
     */
    reportCoderAutomation({ statusToken, report }) {
      return post('agent/reportCoderAutomation', { statusToken, report });
    },
  };
}
