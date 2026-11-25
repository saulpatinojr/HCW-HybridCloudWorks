/** What verify-alert-state.mjs expects of each declared alert rule: the ARM addresses and versions it reads, and the gates that switch a rule off. */
import { DECLARED } from '../assert-expected-plan.mjs';

export const ARM = 'https://management.azure.com';

/**
 * api-version per ARM read, each the GA version its REST reference documents.
 * Resource Health's is the one Microsoft's SDKs default to for
 * AvailabilityStatuses_GetByResource; on 2026-10-15 it returned the same
 * `availabilityState`, `title` and `summary` for alert-timer-overdue as
 * 2023-10-01-preview did (`Unavailable`, `Semantic error`).
 */
export const API_VERSIONS = {
  'Microsoft.Insights/scheduledQueryRules': '2021-08-01',
  'Microsoft.Insights/metricAlerts': '2018-03-01',
  'Microsoft.Insights/activityLogAlerts': '2020-10-01',
  actionGroups: '2021-09-01',
  subscriptions: '2022-12-01',
  resourceHealth: '2025-05-01',
};

/**
 * What each `count` gate is set to in the hcw-azure workspace, and the record
 * that says so.
 *
 * The workspace variables are not readable from here, and github_reader holds
 * no HCP Terraform token, so a gated rule's expected state is recorded rather
 * than read. That record can go stale, and the check fails when it does: a
 * rule present while its gate is recorded off is DRIFT, and one absent while
 * recorded on is MISSING. Every gate a declared
 * rule uses must have an entry, which the test suite enforces; an
 * unrecorded gate reports its rule as unknown rather than guessing.
 */
export const GATES = {
  availability_probe_alert_enabled: {
    armed: true,
    record: 'applied 2026-09-01 when T-519 closed (CHANGELOG.md, "T-519 closed: the reachability alert is armed")',
  },
  cosmos_export_enabled: {
    armed: true,
    record: 'exporter armed and its daily alert live since 2026-09-09 (docs/runbooks/cosmos-restore.md)',
  },
  availability_test_enabled: {
    armed: false,
    record: 'off: Bot Fight Mode answers Azure availability agents with a 403; the edge probe is the armed path (ADR 0024)',
  },
};

/**
 * Subscriptions this workflow's identity is known not to be able to read yet,
 * and the record that says so (review of #1051).
 *
 * EMPTY since #1053. The workflow ran as `github_reader`, which held nothing
 * in the Management subscription, where the capacity and lab rules, the
 * Management role-change rules and the action group live, so that
 * subscription was recorded here from PLAT-4 until the owner's decision on
 * 2026-10-11 gave the job an identity of its own, `github_alert_reader`,
 * that reads alert rules and action groups in both resource groups
 * (infra/oidc.tf). The mechanism stays for the next gap of the kind: a
 * monitor that is red every week for a reason everyone already knows gets
 * muted, and `validate-deployed.yml` was deleted on 2026-09-08 after three
 * weeks of exactly that.
 *
 * THIS IS NOT A MUTE, by the same rules as EXPECTED_UNRESOLVED in
 * check-unresolved-secrets.mjs. A rule in a subscription listed here, whose
 * read is refused (403 or the subscription not visible), is reported as
 * UNREADABLE in every run's table and as a workflow warning, and its state is
 * called unknown, never healthy. Any other failure to read it still fails the
 * run. When a read there succeeds, the report says the entry has gone stale,
 * so it is deleted with the grant that made it stale rather than lingering
 * to hide a later refusal: when the workflow's own run can read a recorded
 * subscription, the run FAILS until the entry is deleted (review of #1051).
 * The step also writes `coverage=partial` while any entry applies, for
 * consumers that read outcomes rather than summaries.
 */
export const UNREADABLE = {};

/** The plan checker's declared creates, by address: rules waiting for an apply. */
export function pendingCreates(declared = DECLARED) {
  return new Map(declared.filter((d) => d.action === 'create').map((d) => [d.address, d.reason]));
}

/**
 * Whether a declared rule should be live.
 *
 * @returns {{expected: 'present'|'absent'|'unknown', why: string}}
 */
export function expectation(rule, gates = GATES) {
  if (!rule.gate) return { expected: 'present', why: '' };
  if (rule.gate.expression) return { expected: 'unknown', why: `count = ${rule.gate.expression}` };
  const gate = gates[rule.gate.variable];
  if (!gate) return { expected: 'unknown', why: `gated on var.${rule.gate.variable}, which GATES does not record` };
  return {
    expected: gate.armed ? 'present' : 'absent',
    why: `var.${rule.gate.variable} ${gate.armed ? 'on' : 'off'}: ${gate.record}`,
  };
}
