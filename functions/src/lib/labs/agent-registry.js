/**
 * The lab agent registry's write path (#740): `POST cms/labs/agents`,
 * `PATCH cms/labs/agents/{agentId}` and `DELETE cms/labs/agents/{agentId}`.
 * What they accept, and the document they write, are
 * agent-registry-rules.js; this file applies them.
 *
 * The agent guard's second gate (auth/require-agent.js) admits a lab agent
 * only when `lab_agents/{agentId}` names it, and until this module nothing
 * could write that container: no route, a read-only Labs page, and a Cosmos
 * firewall that admits only the Function App's subnet. So the agent
 * authenticated and was refused with "Agent access required", and
 * scripts/lab/Register-LabAgent.ps1 could only print the document it needed.
 *
 * ===========================================================================
 * THE DOCUMENT, AS ITS READERS READ IT
 * ===========================================================================
 *
 *   id            the agent id. lab_agents is partitioned on /id, and every
 *                 reader point-reads it as (agentId, agentId):
 *                 default-agent-guard.js, lab-agent.js's heartbeat patch
 *   agentId       the same value (infra/main.tf's partition-key rationale);
 *                 timers/agent-health.js reads `agentId || id`
 *   oid           the agent service principal's object id, which is the `oid`
 *                 claim of its app-only token. require-agent.js compares it
 *                 with `!==`, and Entra writes that claim in lower case, so it
 *                 is stored lower-cased: an upper-case paste would otherwise
 *                 be an oid-mismatch that looks exactly like a missing grant
 *   active        `true` or `false`, never anything else: the guard admits
 *                 only `active === true`
 *   capabilities  the job types the agent may claim. The claim path reads it
 *                 from here and never from the request (lab-agent.js), and
 *                 public-submit.js reads it to decide whether anything online
 *                 can run a public job. Validated against LAB_JOB_TYPES and
 *                 stored in that table's order, so a re-registration with the
 *                 same set in another order is not a change
 *   registeredAt, updatedAt, updatedBy
 *                 when, and which admin's object id. Identifiers, not secrets
 *
 * The heartbeat's fields (hostname, version, status, activeJobs, lastSeenAt)
 * live in the same document and are never written here: an existing document
 * is PATCHED with the registry fields only, so a registration never rewinds a
 * heartbeat that landed in between. Nothing secret is stored, because nothing
 * secret is accepted: the body is exactly { agentId, oid, jobTypes? } and any
 * other key is a 400.
 *
 * ===========================================================================
 * WHO MAY WRITE IT
 * ===========================================================================
 * `editor`, the role the other Labs writes require (enqueueLabJob,
 * cancelLabJob). That is enough because this is gate 2 of two, not the whole
 * grant. Gate 1 is the LabAgent app role, which only a tenant administrator
 * can assign (Register-LabAgent.ps1 does it as the owner), so a registry row
 * can bind an agent id only to a principal the tenant already trusts as an
 * agent; it can never mint an agent credential. What an editor can do here,
 * rebind or deactivate an agent, is audited like every other admin mutation.
 *
 * ===========================================================================
 * IDEMPOTENT, AND A REVOCATION STAYS REVOKED
 * ===========================================================================
 * POST creates the document active, or updates `oid` and `capabilities` on
 * one that exists. It does NOT reactivate a deactivated agent: re-running the
 * go-live, or pasting the same values again, must not quietly undo a
 * revocation. Only `PATCH { active: true }` does that, so turning an agent
 * back on is always its own audited act. A POST that changes nothing writes
 * nothing, document or audit row, and answers `changed: false`.
 *
 * ===========================================================================
 * REMOVING ONE (owner request 2026-09-28)
 * ===========================================================================
 * A host rebuild can leave the old agent id behind: the VPS reinstalled on
 * 2026-09-26 came back as vps-hostinger-01, and srv939861's record stayed on
 * the Agents tab, offline and deactivated, with no way to take it off. DELETE
 * deletes the document, and refuses two cases first:
 *
 *   - an ACTIVE agent (409, "Deactivate it first"). The guard admits it, so
 *     deleting it would revoke it without the audited deactivation, and the
 *     page offers Remove only on a deactivated card anyway.
 *   - an agent that still HOLDS a job (409): a `running` one, or a `claimed`
 *     one inside lab-agent.js's CLAIM_LEASE_MS. That is how jobs reference an
 *     agent, `lab_jobs.agentId`, written by the claim. A claim older than the
 *     lease is not held: the claim path hands it to the next agent that polls
 *     for its type, and a deactivated agent could never report it anyway
 *     (the guard refuses its completeLabJob). Counting it would let one
 *     stranded job block the removal forever, with nothing on the page able
 *     to clear it, since cancelLabJob cancels only queued jobs.
 *
 * The deletion is audited as `lab_agent_removed` with the removed document's
 * agentId, oid, lastSeenAt and version, because the row is then the only
 * record the agent existed. A second DELETE answers 404, the same answer as
 * PATCH on an unknown id. Nothing about the host changes: its certificate and
 * app registration stay, and without a document gate 2 refuses it, which is
 * the state before its first registration. Register agent adds it back.
 *
 * Between the read and the delete another editor could activate the agent.
 * That race only ever errs towards revocation, since a deleted agent is
 * refused, and a registration restores it; so the delete is not ETag-guarded.
 *
 * The handlers are module-scope functions over one `deps` object and the
 * factory only wires them, the shape public-submit.js uses: written as
 * closures inside the factory, every branch of every handler counted into the
 * factory's own complexity.
 */
import { randomUUID } from 'node:crypto';
import { CLAIM_LEASE_MS } from '../lab-agent.js';
import {
  LAB_AGENT_REGISTRY_ROLE,
  newAgentDocument,
  presentAgent,
  readActivation,
  readRegistration,
  readRemoval,
  registryChanges,
  removalDetails,
} from './agent-registry-rules.js';

const json = (status, body) => ({
  status,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const CONTAINER = 'lab_agents';

const actorOf = (user) => user?.oid || user?.sub || null;

const notRegistered = (agentId) => json(404, { ok: false, error: `No lab agent ${agentId} is registered` });

/**
 * One admin_audit_logs row, the shape platform-settings.js writes. Best
 * effort, as there: the registry is already written, so a failed audit row
 * must not become a 500 that makes the page report a failure (and the owner
 * retry) for a write that took.
 */
async function audit({ store, now, uuid }, { request, context, user }, action, details) {
  try {
    await store.upsertDoc('admin_audit_logs', {
      id: uuid(),
      action,
      userId: actorOf(user),
      userName: user?.name || null,
      userEmail: user?.email || user?.preferred_username || null,
      timestamp: now().toISOString(),
      details,
      userAgent: request.headers?.get?.('user-agent') || null,
      compliance: { schemaVersion: 1, detailsSanitized: true, identityVerified: true },
    });
  } catch (error) {
    context.warn?.(`${action} for ${details.agentId} saved but the audit row failed: ${error?.message || error}`);
  }
}

/** A new document, active, written with create so a racing POST has a loser. */
async function createAgent(deps, call, value) {
  const doc = newAgentDocument(value, deps.now().toISOString(), actorOf(call.user));
  try {
    const stored = await deps.store.createDoc(CONTAINER, doc);
    await audit(deps, call, 'lab_agent_registered', {
      agentId: value.agentId,
      oid: value.oid,
      capabilities: value.jobTypes,
      active: true,
    });
    return json(201, { ok: true, created: true, changed: true, agent: presentAgent(stored || doc) });
  } catch (error) {
    if (error?.code !== 409) throw error;
    return json(409, {
      ok: false,
      error: `${value.agentId} was registered by another request at the same moment. Submit again to update it.`,
    });
  }
}

/** The registry fields on an existing document, and nothing else. */
async function updateAgent(deps, call, existing, value) {
  const changes = registryChanges(existing, value);
  if (Object.keys(changes).length === 0) {
    return json(200, { ok: true, created: false, changed: false, agent: presentAgent(existing) });
  }
  const stored = await deps.store.patchDoc(
    CONTAINER,
    value.agentId,
    { ...changes, updatedAt: deps.now().toISOString(), updatedBy: actorOf(call.user) },
    { partitionKey: value.agentId }
  );
  await audit(deps, call, 'lab_agent_updated', {
    agentId: value.agentId,
    oid: value.oid,
    previousOid: existing.oid ?? null,
    capabilities: value.jobTypes,
    previousCapabilities: Array.isArray(existing.capabilities) ? existing.capabilities : null,
    active: existing.active === true,
  });
  return json(200, { ok: true, created: false, changed: true, agent: presentAgent(stored) });
}

async function upsertAgent(deps, call, value) {
  const existing = await deps.store.readDoc(CONTAINER, value.agentId, value.agentId);
  return existing ? updateAgent(deps, call, existing, value) : createAgent(deps, call, value);
}

/** Set `active`, or say it already is; 404 for an agent nobody registered. */
async function applyActivation(deps, call, { agentId, active }) {
  const existing = await deps.store.readDoc(CONTAINER, agentId, agentId);
  if (!existing) return notRegistered(agentId);
  if (existing.active === active) {
    return json(200, { ok: true, changed: false, agent: presentAgent(existing) });
  }
  const stored = await deps.store.patchDoc(
    CONTAINER,
    agentId,
    { active, updatedAt: deps.now().toISOString(), updatedBy: actorOf(call.user) },
    { partitionKey: agentId }
  );
  await audit(deps, call, active ? 'lab_agent_activated' : 'lab_agent_deactivated', {
    agentId,
    oid: existing.oid ?? null,
    active,
  });
  return json(200, { ok: true, changed: true, agent: presentAgent(stored) });
}

const LEASE_MINUTES = CLAIM_LEASE_MS / 60_000;

/**
 * The jobs an agent still holds: every `running` one, and every `claimed`
 * one inside the lease. The second clause is the exact complement of the
 * claim path's takeover clause (lab-agent.js: `claimed AND (NOT
 * IS_DEFINED(claimedAt) OR claimedAt < @staleBefore)`), compared as the same
 * ISO strings. Five are enough to name; the answer is "not yet" either way.
 */
export const HELD_JOBS_QUERY = `SELECT TOP 5 c.id, c.status FROM c
  WHERE c.agentId = @agentId
    AND c.status = 'claimed' AND IS_DEFINED(c.claimedAt) AND c.claimedAt >= @staleBefore`;

/** A 409 naming the jobs the agent still holds, or null when it holds none. */
async function heldJobsRefusal(deps, agentId) {
  const staleBefore = new Date(deps.now().getTime() - CLAIM_LEASE_MS).toISOString();
  const held = await deps.store.queryDocs('lab_jobs', HELD_JOBS_QUERY, [
    { name: '@agentId', value: agentId },
    { name: '@staleBefore', value: staleBefore },
  ]);
  if (held.length === 0) return null;
  const jobs = held.map((job) => `${job.id} (${job.status})`).join(', ');
  return json(409, {
    ok: false,
    error: `${agentId} still holds ${jobs}. A deactivated agent cannot finish a job, and another agent may take each one over ${LEASE_MINUTES} minutes after it was claimed; remove ${agentId} after that.`,
  });
}

/**
 * Delete a deactivated agent's document that holds no job, then audit it.
 * 404 for an agent nobody registered, including one another request removed
 * between this read and this delete.
 */
async function removeAgent(deps, call, { agentId }) {
  const existing = await deps.store.readDoc(CONTAINER, agentId, agentId);
  if (!existing) return notRegistered(agentId);
  if (existing.active === true) {
    return json(409, { ok: false, error: `${agentId} is active. Deactivate it first, then remove it.` });
  }
  const refusal = await heldJobsRefusal(deps, agentId);
  if (refusal) return refusal;
  try {
    await deps.store.deleteDoc(CONTAINER, agentId, agentId);
  } catch (error) {
    if (error?.code !== 404) throw error;
    return notRegistered(agentId);
  }
  await audit(deps, call, 'lab_agent_removed', removalDetails(existing));
  return json(200, { ok: true, removed: true, agentId });
}

/**
 * Guard, then read the body, then write; a store failure is a 500 that names
 * the agent in the log and nothing internal in the answer.
 *
 * @param {object} deps
 * @param {object} request
 * @param {object} context
 * @param {{ read: (request: object) => Promise<{value?: object, error?: string}>, write: Function, what: string, failure: string }} step
 */
async function guarded(deps, request, context, { read, write, what, failure }) {
  const auth = await deps.guard.requireRole(request, LAB_AGENT_REGISTRY_ROLE);
  if (auth.error) return auth.error;
  const parsed = await read(request);
  if (parsed.error) return json(400, { ok: false, error: parsed.error });
  try {
    return await write(deps, { request, context, user: auth.user }, parsed.value);
  } catch (err) {
    context.error(`${what}(${parsed.value.agentId}) failed: ${err?.message || err}`);
    return json(500, { ok: false, error: failure });
  }
}

const REGISTER = Object.freeze({
  read: readRegistration,
  write: upsertAgent,
  what: 'registerLabAgent',
  failure: 'Failed to register the lab agent',
});

const ACTIVATE = Object.freeze({
  read: readActivation,
  write: applyActivation,
  what: 'setLabAgentActive',
  failure: 'Failed to update the lab agent',
});

const REMOVE = Object.freeze({
  read: readRemoval,
  write: removeAgent,
  what: 'removeLabAgent',
  failure: 'Failed to remove the lab agent',
});

/**
 * @param {object} deps
 * @param {{ requireRole: Function }} deps.guard
 * @param {{ readDoc: Function, createDoc: Function, patchDoc: Function, upsertDoc: Function, queryDocs: Function, deleteDoc: Function }} deps.store
 * @param {() => Date} [deps.now]
 * @param {() => string} [deps.uuid]
 */
export function createAgentRegistryHandlers({ guard, store, now = () => new Date(), uuid = randomUUID }) {
  const deps = { guard, store, now, uuid };
  return {
    /** POST /api/cms/labs/agents — { agentId, oid, jobTypes? }. */
    registerAgent: (request, context) => guarded(deps, request, context, REGISTER),
    /** PATCH /api/cms/labs/agents/{agentId} — { active }. */
    setAgentActive: (request, context) => guarded(deps, request, context, ACTIVATE),
    /** DELETE /api/cms/labs/agents/{agentId} — no body; deactivated and holding no job. */
    removeAgent: (request, context) => guarded(deps, request, context, REMOVE),
  };
}
