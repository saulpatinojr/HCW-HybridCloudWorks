/**
 * GET /api/public/labs/estate — "The Hybrid Lab right now" (#664, Phase 4 of
 * #656; ADR 0032 decision 3).
 *
 * The public, live view of the hybrid estate: the Arc-enabled lab host's state
 * as Azure sees it, its policy compliance, whether the `vps-agent` job runner
 * is heartbeating and how deep its queue is, and Coder's capacity from the
 * status proxy beside this module. Read by the Function App's managed identity
 * through Azure Resource Graph under a Reader grant on `rg-lab-hybrid-prod-cus`
 * alone (infra/lab-hybrid.tf) — the browser never sees Azure, and no new
 * credential exists anywhere in the path.
 *
 * Two shapes, both 200, each cached for a minute in `tool_service_cache`:
 *
 *   { configured: false }
 *       Resource Graph returned no Arc machine in the lab resource group —
 *       because the group does not exist yet, or exists and holds no machine.
 *       Both read the same to a visitor: the card says "not yet provisioned",
 *       and nothing is invented to fill it.
 *   { configured: true, arc, policy, agent, coder, asOf }
 *       arc    { status, statusSince, agentVersion, osName } — always present
 *       policy { compliant, nonCompliant, notApplicable } | null
 *       agent  { online, queued, lastHeartbeatAt } | null
 *              online: any lab agent heartbeating (lib/labs.js isAgentOnline);
 *              lastHeartbeatAt: the freshest online agent's, else null
 *       coder  { reachable, running, max } | null
 *
 * NULL MEANS UNKNOWN, NOT ZERO. The three side reads — policy, agent queue,
 * Coder — are independent of the Arc row and of each other, and one of them
 * failing must not sink the others or, worse, become a number. `policy` is
 * `{ compliant: 0, nonCompliant: 0 }` only when Resource Graph answered and
 * counted nothing; a failed policy query is `null`. The same rule applies to
 * `agent` (a store failure) and `coder` (its own module says unconfigured, or
 * threw).
 *
 * When the Arc read itself fails — ARM refused, the token could not be minted,
 * the call timed out — the route answers **503**, not `{ configured: false }`:
 * "we cannot see the estate" and "there is no estate" are different sentences
 * and the card should say the first. That 503 is cached for the same minute
 * as a success, so an outage never turns anonymous page loads into a stream
 * of management-plane calls.
 *
 * `arc.statusSince` IS NOT A HEARTBEAT. Azure Resource Manager exposes no
 * heartbeat timestamp on an Arc machine; the row's
 * `properties.lastStatusChange` is the time the agent's status last changed,
 * and the agent's status becomes Disconnected on its own once heartbeats
 * stop. Until #1009 this field was called `lastHeartbeatAt` and the card
 * printed it as "Last heartbeat", so a host connected without a break for
 * three days read "Last heartbeat: 3 days ago". It is the moment the status
 * beside it began, and is named so. The Log Analytics `Heartbeat` table
 * would be exact, and would need a workspace grant this route does not have
 * (ADR 0032 decision 3 keeps the identity's reach to the one resource group).
 * The heartbeat a visitor can read is the job runner's own:
 * `agent.lastHeartbeatAt`, from `lab_agents` (lib/lab-agent.js).
 *
 * THE POLICY COUNTS ARE OF CHECKS THAT CAN EVALUATE THIS LAB. The group
 * inherits the subscription's security benchmark as well as holding the
 * one assignment infra/lab-hybrid.tf makes, and several of those can never
 * pass here, by design rather than by fault. Counted as non-compliant they
 * made the card say the host failed checks it could not take. They are
 * counted apart, as `notApplicable`, each for the reason in
 * NOT_APPLICABLE_POLICIES, and only while their result is NonCompliant: a
 * check on the list that does report Compliant evaluated, and is counted so.
 *
 * The response names no host. The machine's `name` is its hostname, and the
 * queries here never project it: status, timestamps, an agent version and an
 * OS name are the entire disclosure, and each of those is already public on
 * the lab's pages by design.
 *
 * KQL, checked against the Resource Graph references on 2026-09-25 —
 * https://learn.microsoft.com/azure/azure-arc/servers/resource-graph-samples
 * (`properties.status`, `properties.osName`, `type =~
 * 'microsoft.hybridcompute/machines'`), the `@azure/arm-hybridcompute`
 * MachineProperties reference (`lastStatusChange`, `status`, `agentVersion`),
 * and https://learn.microsoft.com/azure/governance/policy/samples/resource-graph-samples
 * (`policyresources`, `microsoft.policyinsights/policystates`,
 * `tostring(properties.complianceState)`, and, read 2026-10-08,
 * `properties.policyAssignmentName`; `policyDefinitionName` is the policy
 * state's definition name, the GUID for a built-in). String literals are
 * single-quoted throughout, as KQL requires.
 *
 * Shaped like cloud-tools/explain/handler.js: each read is a module-scope
 * step over a `deps` object, so the factory below only wires them. One place
 * turns the built result into a response, one place turns a throw into 500.
 */

import { isAgentOnline } from '../labs.js';
import { createMinuteCache, jsonResponse, MINUTE_CACHE_SECONDS } from './minute-cache.js';
import { errorFacts } from '../http/error-response.js';

export const ESTATE_CACHE_ID = 'labs:estate';
export const ESTATE_CACHE_SECONDS = MINUTE_CACHE_SECONDS;
/** Fixed by ADR 0032 decision 3 and created by infra/lab-hybrid.tf. */
export const LAB_RESOURCE_GROUP = 'rg-lab-hybrid-prod-cus';

/** The one Arc machine row the card is built from. Never projects `name`. */
export const ARC_MACHINE_QUERY = [
  'resources',
  `| where type =~ 'microsoft.hybridcompute/machines' and resourceGroup =~ '${LAB_RESOURCE_GROUP}'`,
  '| project status = tostring(properties.status), lastStatusChange = tostring(properties.lastStatusChange), agentVersion = tostring(properties.agentVersion), osName = tostring(properties.osName)',
  '| take 1',
].join(' ');

/**
 * Policy state counts for resources in the lab group, one row per compliance
 * state, definition and assignment, so the checks that cannot evaluate here
 * can be told apart (NOT_APPLICABLE_POLICIES). Both names are lowercased in
 * the query, so the match below is one comparison.
 */
export const POLICY_COMPLIANCE_QUERY = [
  'policyresources',
  `| where type =~ 'microsoft.policyinsights/policystates' and tostring(properties.resourceGroup) =~ '${LAB_RESOURCE_GROUP}'`,
  '| summarize count() by complianceState = tostring(properties.complianceState), policyDefinition = tolower(tostring(properties.policyDefinitionName)), policyAssignment = tolower(tostring(properties.policyAssignmentName))',
].join(' ');

/**
 * The checks that can never pass on this lab. Each matches a built-in
 * definition (by its name, the GUID, as Learn's built-in reference lists it,
 * read 2026-10-08) or the one assignment infra/lab-hybrid.tf makes, and the
 * comment above each is why. Every reason is a decision recorded elsewhere,
 * so an entry leaves this list when that decision changes, not when the
 * count looks better. The reasons are comments rather than strings because
 * this module answers a public route, and nothing here is said to a visitor
 * beyond the count (lib/public-visitor-copy.test.js).
 */
export const NOT_APPLICABLE_POLICIES = Object.freeze([
  // The Linux security baseline is a machine-configuration audit, and
  // machine configuration (guest configuration) is off on the Arc agent
  // (LAB-6, #984; ADR 0032 amendment of 2026-10-07), so nothing on the host
  // can report it. Leaves this list if #952 turns guest configuration back
  // on; estate.test.js fails until it does.
  { assignment: 'audit-linux-baseline-lab-hybrid' },
  // "Linux machines should meet requirements for the Azure compute security
  // baseline": the same audit, wherever it is assigned from. With guest
  // configuration off there is no report to read.
  { definition: 'fc9b3da7-8347-4380-8e70-0a0361d8dedd' },
  // "System updates should be installed on your machines (powered by Update
  // Center)" reads a Defender for Cloud assessment of update data the lab
  // does not produce: Defender for Servers stays off (ADR 0032, alternatives
  // considered), and the host patches itself with unattended-upgrades.
  { definition: 'f85bf3e0-d513-442e-89c3-1784ad63382b' },
  // "SQL servers on machines should have vulnerability findings resolved"
  // needs Defender for SQL on machines, which nothing in infra/ turns on, and
  // the host runs no SQL Server.
  { definition: '6ba6d016-e7c3-4842-b8f2-4992ebc0d72d' },
  // "Azure Key Vaults should use private link": the seal-key vault's only
  // caller is the lab host, outside Azure, which a private endpoint cannot
  // serve (infra/lab-hybrid.tf; ADR 0031, owner decision 2026-09-14).
  { definition: 'a6abeaec-4d90-4a02-805f-6b26c4d3fbe9' },
  // "Azure Key Vault should have firewall enabled or public network access
  // disabled": the seal-key vault stays open on purpose, because an IP rule
  // would copy an address infra/ does not own and a drifted rule would leave
  // Vault unable to unseal; Entra ID and one key-scoped grant gate every
  // call (infra/lab-hybrid.tf; ADR 0032 amendment of 2026-09-29).
  { definition: '55615ac9-af46-4a59-874e-391cc3dfb490' },
]);

const NOT_APPLICABLE_DEFINITIONS = new Set(
  NOT_APPLICABLE_POLICIES.filter((p) => p.definition).map((p) => p.definition)
);
const NOT_APPLICABLE_ASSIGNMENTS = new Set(
  NOT_APPLICABLE_POLICIES.filter((p) => p.assignment).map((p) => p.assignment)
);

/** Whether a policy state row belongs to a check that cannot evaluate this lab. */
export function isNotApplicableHere(row) {
  const definition = String(row?.policyDefinition ?? '').toLowerCase();
  const assignment = String(row?.policyAssignment ?? '').toLowerCase();
  return NOT_APPLICABLE_DEFINITIONS.has(definition) || NOT_APPLICABLE_ASSIGNMENTS.has(assignment);
}

const UNAVAILABLE = { status: 503, body: { error: 'Labs estate status is unavailable' } };
const ABSENT = { status: 200, body: { configured: false } };

const toIsoOrNull = (value) => {
  const ms = Date.parse(String(value ?? ''));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};
const toTextOrNull = (value) =>
  typeof value === 'string' && value.trim() ? value.trim() : null;
const intOrNull = (value) => (Number.isInteger(value) ? value : null);

/** The card's `arc` block from one Resource Graph row. `statusSince` is not a heartbeat (above). */
export function shapeArcRow(row) {
  return {
    status: toTextOrNull(row?.status),
    statusSince: toIsoOrNull(row?.lastStatusChange),
    agentVersion: toTextOrNull(row?.agentVersion),
    osName: toTextOrNull(row?.osName),
  };
}

/**
 * `{ compliant, nonCompliant, notApplicable }` from the summarize rows. A
 * NonCompliant row of a check on NOT_APPLICABLE_POLICIES is `notApplicable`;
 * states other than Compliant and NonCompliant are none of the three.
 */
export function shapePolicyRows(rows) {
  const totals = { compliant: 0, nonCompliant: 0, notApplicable: 0 };
  for (const row of Array.isArray(rows) ? rows : []) {
    const count = Number(row?.count_);
    if (!Number.isFinite(count)) continue;
    const state = String(row?.complianceState ?? '').toLowerCase();
    if (state === 'compliant') totals.compliant += count;
    else if (state === 'noncompliant') {
      if (isNotApplicableHere(row)) totals.notApplicable += count;
      else totals.nonCompliant += count;
    }
  }
  return totals;
}

/**
 * The job runner's block: whether any agent is online by the shared rule,
 * the queue depth, and the freshest online agent's heartbeat. An agent that
 * is not online contributes no heartbeat, so the row never shows the time of
 * a goodbye as if it were a sign of life (#1009).
 */
export function shapeAgentRows(agents, queued, nowMs) {
  const online = (Array.isArray(agents) ? agents : []).filter((a) => isAgentOnline(a, nowMs));
  const freshestMs = Math.max(...online.map((a) => Date.parse(String(a.lastSeenAt))), Number.NEGATIVE_INFINITY);
  return {
    online: online.length > 0,
    queued: Number(queued?.[0]) || 0,
    lastHeartbeatAt: Number.isFinite(freshestMs) ? new Date(freshestMs).toISOString() : null,
  };
}

/** The estate's `coder` block from the status proxy's body; null when unconfigured. */
export function shapeCoderStatus(status) {
  if (!status?.configured) return null;
  return {
    reachable: status.reachable === true,
    running: intOrNull(status.capacity?.running),
    max: intOrNull(status.capacity?.max),
  };
}

/**
 * Run a side read; on failure log why and answer null, so one unavailable
 * source is reported as unknown rather than as a number or as an outage.
 */
async function sideRead(label, context, read) {
  try {
    return await read();
  } catch (error) {
    context?.warn?.(`labs-estate: ${label} read failed: ${errorFacts(error)}`);
    return null;
  }
}

/**
 * The steps, each `(deps, context)` at module scope. `deps` is
 * `{ store, arm, coderStatus, now }` — see createEstateHandlers.
 */

/** { kind: 'present', arc } | { kind: 'absent' } | { kind: 'unavailable' } */
async function readArc({ arm }, context) {
  try {
    const rows = await arm.query(ARC_MACHINE_QUERY);
    if (!Array.isArray(rows) || rows.length === 0) return { kind: 'absent' };
    return { kind: 'present', arc: shapeArcRow(rows[0]) };
  } catch (error) {
    // No subscription to scope the read to: a local or test process. There is
    // no estate this process could see, and the reason is not an outage.
    if (error?.code === 'ARG_UNSCOPED') return { kind: 'absent' };
    context?.warn?.(`labs-estate: Arc read failed: ${errorFacts(error)}`);
    return { kind: 'unavailable' };
  }
}

const readPolicy = ({ arm }, context) =>
  sideRead('policy', context, async () => shapePolicyRows(await arm.query(POLICY_COMPLIANCE_QUERY)));

/** The same two reads getLabsSnapshot makes (lib/labs.js), reduced to shapeAgentRows. */
const readAgent = ({ store, now }, context) =>
  sideRead('agent', context, async () => {
    const [agents, queued] = await Promise.all([
      store.queryDocs('lab_agents', 'SELECT TOP 200 c.lastSeenAt, c.status, c.active FROM c', []),
      store.queryDocs('lab_jobs', "SELECT VALUE COUNT(1) FROM c WHERE c.status = 'queued'", []),
    ]);
    return shapeAgentRows(agents, queued, now());
  });

const readCoder = ({ coderStatus }, context) =>
  sideRead('Coder', context, async () => shapeCoderStatus(await coderStatus.readStatus(context)));

/** The `{ status, body }` the route answers with, built live. */
async function buildEstate(deps, context) {
  const machine = await readArc(deps, context);
  if (machine.kind === 'unavailable') return UNAVAILABLE;
  if (machine.kind === 'absent') return ABSENT;

  const [policy, agent, coder] = await Promise.all([
    readPolicy(deps, context),
    readAgent(deps, context),
    readCoder(deps, context),
  ]);

  return {
    status: 200,
    body: { configured: true, arc: machine.arc, policy, agent, coder, asOf: new Date(deps.now()).toISOString() },
  };
}

/**
 * @param {object} deps
 * @param {{ readDoc: Function, upsertDoc: Function, queryDocs: Function }} deps.store
 * @param {{ query: (kql: string) => Promise<object[]> }} deps.arm - Resource Graph (resource-graph.js)
 * @param {{ readStatus: (context: object) => Promise<object> }} deps.coderStatus - coder-status.js
 * @param {() => number} [deps.now] - epoch ms
 */
export function createEstateHandlers({ store, arm, coderStatus, now = () => Date.now() }) {
  const deps = { store, arm, coderStatus, now };
  const cache = createMinuteCache({
    store,
    id: ESTATE_CACHE_ID,
    kind: 'labs-estate',
    now,
    seconds: ESTATE_CACHE_SECONDS,
  });

  return {
    /** GET /api/public/labs/estate */
    async getEstate(request, context) {
      try {
        let result = await cache.read(context);
        if (!result) {
          result = await buildEstate(deps, context);
          await cache.write(result, context);
        }
        return jsonResponse(result.status, result.body, result.status === 200 ? ESTATE_CACHE_SECONDS : 0);
      } catch (error) {
        context.error('publicGetLabsEstate failed:', errorFacts(error));
        return jsonResponse(500, { error: 'Failed to read the labs estate' });
      }
    },
  };
}
