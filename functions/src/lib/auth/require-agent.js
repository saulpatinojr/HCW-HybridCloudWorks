/**
 * The authorization guard for the Labs VPS agent.
 *
 * ===========================================================================
 * WHY THE AGENT DOES NOT GET A COSMOS CLIENT
 * ===========================================================================
 * `vps-agent/index.js` held a Cosmos **account primary key** — read/write over
 * all 71 containers — deployed to a third-party VPS (T-401). The VPS is outside
 * the trust boundary in exactly the way the browser is, so it gets the same
 * answer the browser got: no data-plane client, no key, an API instead.
 *
 * T-401 offered a Cosmos **resource token** brokered by a Functions
 * endpoint as the narrower alternative. It is not viable here. Resource tokens
 * are minted from the SQL API's users/permissions model, which requires the
 * master key to create, and `disableLocalAuth` permits "only MSI and AAD" —
 * it disables resource tokens along with keys. Brokering them would mean the
 * Functions app holds the master key and the account can never turn local auth
 * off, which is the whole point of T-315. So that option would have
 * traded one permanent key for another.
 *
 * ===========================================================================
 * THE TWO GATES, AND WHY THEY ARE NOT THE ADMIN ONES
 * ===========================================================================
 * Structurally this mirrors `require-role.js`: a coarse Entra App Role, then
 * an authoritative database record. The gates differ in what they authorize.
 *
 *   Gate 1 — the `LabAgent` App Role on the agent's app registration. A token
 *            without it never reaches a database read.
 *   Gate 2 — a `lab_agents/{agentId}` document whose `oid` equals the token's
 *            object id and whose `active` is true. This is what binds a
 *            credential to one agent identity: possessing a valid LabAgent
 *            token is not enough to act *as* an arbitrary agent.
 *
 * An admin token deliberately does NOT satisfy this guard, and an agent token
 * deliberately does not satisfy `requireRole`. They are disjoint. An agent
 * credential stolen off the VPS must not become admin access to the CMS, and
 * an admin session must not be able to complete jobs as an agent — job results
 * are attributable, and attribution is worthless if anyone can forge it.
 *
 * The registry lookup is NOT cached. `require-role.js` caches admin records
 * for a TTL because admin requests are interactive and bursty; agents call
 * `claimLabJob` on a poll interval, and the point of `active: false` is to be
 * able to revoke a compromised agent immediately. A cache would put a TTL
 * between the revocation and its effect.
 */

// Static, not `await import()` inside the guard. verify-token.js imports
// nothing from here, so there was no cycle to break (T-408).
import { bearerTokenFrom } from './verify-token.js';
import { errorCode } from '../http/error-response.js';

const deny = (status, error) => ({
  status,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ ok: false, error }),
});

/** The App Role the agent's app registration must be assigned. */
export const ENTRA_LAB_AGENT_APP_ROLE = 'LabAgent';

/**
 * Create the agent guard.
 *
 * Dependencies are injected rather than imported, matching `createRoleGuard`,
 * so the whole thing is testable without a tenant or a database.
 *
 * @param {object} deps
 * @param {{ verify(token: string): Promise<object> }} deps.verifier
 * @param {(agentId: string) => Promise<{oid: string, active: boolean, capabilities?: string[]}|null>} deps.lookupAgent
 *        Point-read of `lab_agents/{agentId}`. Must resolve null when absent.
 * @param {(entry: object) => void} [deps.auditDenial] Called on every denial.
 * @returns {{ requireAgent: Function }}
 */
export function createAgentGuard({ verifier, lookupAgent, auditDenial }) {
  if (!verifier) throw new Error('createAgentGuard requires a verifier');
  if (!lookupAgent) throw new Error('createAgentGuard requires lookupAgent');

  const audit = (entry) => {
    try {
      auditDenial?.(entry);
    } catch {
      // An audit sink failure must never turn a clean 403 into a 500.
    }
  };

  /**
   * Authenticate the caller and bind it to the agent identity it claims.
   *
   * @param {object} request Azure Functions HttpRequest
   * @param {string} agentId The agent the caller claims to be, from the body.
   * @returns {Promise<{agent: object|null, identity: object|null, error: object|null}>}
   */
  async function requireAgent(request, agentId) {
    const token = bearerTokenFrom(request);

    if (!token) {
      return { agent: null, identity: null, error: deny(401, 'Authentication required') };
    }

    let identity;
    try {
      identity = await verifier.verify(token);
    } catch (err) {
      // The verifier's code, not its sentence: the row is stored (#945).
      audit({ outcome: 'denied', reason: 'invalid-token', detail: errorCode(err) });
      return { agent: null, identity: null, error: deny(401, 'Authentication required') };
    }

    const oid = identity.oid ?? identity.sub;

    // An agent token is CLIENT-CREDENTIALS: it carries `roles` and, by
    // construction, no `scp`. A token bearing a delegated scope is a user's
    // token, and a user's token must never satisfy the agent path however many
    // app roles it happens to carry (#515).
    //
    // The disjointness this file argues for below was, until now, enforced only
    // by the two role names being different. This is the other half: the admin
    // guard requires `scp` and this one refuses it, so neither token type can
    // cross into the other's path even if a principal were assigned both roles.
    if (typeof identity.scp === 'string' && identity.scp.trim()) {
      audit({ outcome: 'denied', reason: 'delegated-token-on-agent-path', oid, agentId });
      return { agent: null, identity: null, error: deny(403, 'Agent access required') };
    }

    // Gate 1: the coarse App Role.
    const claimRoles = Array.isArray(identity.roles) ? identity.roles : [];
    if (!claimRoles.includes(ENTRA_LAB_AGENT_APP_ROLE)) {
      audit({ outcome: 'denied', reason: 'missing-app-role', oid, agentId });
      return { agent: null, identity: null, error: deny(403, 'Agent access required') };
    }

    // A caller that omits the id cannot be bound to a registry record, so it
    // cannot be authorized — there is no "default agent".
    const id = typeof agentId === 'string' ? agentId.trim() : '';
    if (!id) {
      audit({ outcome: 'denied', reason: 'no-agent-id', oid });
      return { agent: null, identity: null, error: deny(400, 'agentId is required') };
    }

    // Gate 2: the authoritative record. Not wrapped in try/catch, for the same
    // reason require-role.js does not: a lookup failure must become a 500, not
    // a fallback to the token's own claim about who it is.
    const record = await lookupAgent(id);
    if (!record) {
      audit({ outcome: 'denied', reason: 'no-agent-record', oid, agentId: id });
      return { agent: null, identity: null, error: deny(403, 'Agent access required') };
    }
    if (record.active !== true) {
      audit({ outcome: 'denied', reason: 'inactive', oid, agentId: id });
      return { agent: null, identity: null, error: deny(403, 'Agent access required') };
    }

    // The binding. Without this, any holder of a LabAgent token could act as
    // any registered agent — claim another host's jobs, or write results
    // attributed to it.
    if (record.oid !== oid) {
      audit({ outcome: 'denied', reason: 'oid-mismatch', oid, agentId: id, expected: record.oid });
      return { agent: null, identity: null, error: deny(403, 'Agent access required') };
    }

    return { agent: { ...record, agentId: id }, identity, error: null };
  }

  return { requireAgent };
}
