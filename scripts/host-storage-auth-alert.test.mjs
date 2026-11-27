/**
 * The filter on alert-app-exceptions, and the rule that watches what it
 * leaves out (2026-11-24).
 *
 * alert-app-exceptions (Sev1) fired seven times in three days on one thing:
 * Azure Storage refusing the Functions host's own calls with 403
 * AuthenticationFailed for a few minutes after each Terraform apply (T-511 in
 * infra/functionapp.tf). The record is
 * docs/runbooks/investigate-app-exceptions-2026-11-24.md. Since then the
 * Sev1 rule leaves that one signature out, and alert-host-storage-auth
 * (Sev2) fires when the same signature lasts four quarter hours.
 *
 * That is a filter on a Sev1 rule, so what it must never do is grow quietly.
 * These tests hold four things:
 *
 *   1. The signature keeps all three of its conditions. Dropping one widens
 *      what the Sev1 rule ignores: without the empty operation name it would
 *      ignore a handler's own storage failure, and without the error code it
 *      would ignore every storage failure of the host.
 *   2. Both rules use the one local, so the Sev2 rule watches exactly the
 *      rows the Sev1 rule leaves out, no more and no fewer.
 *   3. The Sev2 rule exists while the filter does, is stateful, and pages
 *      the same action group.
 *   4. The change has applied (both rules read live with the new text on
 *      2026-11-27), so its plan declaration is gone from
 *      assert-expected-plan.mjs, and the plan check reads the same change, or
 *      anything wider, as unexpected.
 *
 * None of this runs the KQL. Azure accepts or refuses the queries at apply,
 * and the validation query in the runbook above is how they are read against
 * real rows.
 */
import { describe, expect, it } from 'vitest';

import {
  APP_EXCEPTIONS_DESCRIPTION,
  APP_EXCEPTIONS_QUERY,
  checkPlan,
  DECLARED,
  EXPECTED,
  HOST_STORAGE_AUTH_SIGNATURE,
} from './assert-expected-plan.mjs';
import { terraformSource } from './terraform-source.mjs';

const source = terraformSource();
const SEV1 = 'azurerm_monitor_scheduled_query_rules_alert_v2.app_exceptions';
const SEV2 = 'azurerm_monitor_scheduled_query_rules_alert_v2.host_storage_auth';

/** Each scheduled-query rule's block, by its Terraform name. */
const blocks = Object.fromEntries(
  source
    .split(/^resource "/m)
    .slice(1)
    .map((part) => [/^azurerm_monitor_scheduled_query_rules_alert_v2" "([^"]+)"/.exec(part)?.[1], part])
    .filter(([name]) => name)
);

/** The text of every `query` in a block: heredocs, then one-line strings. */
function queryTexts(body) {
  const heredocs = [...body.matchAll(/query\s*=\s*<<-?([A-Za-z_]\w*)\r?\n([\s\S]*?)\r?\n[ \t]*\1\b/g)].map((m) => m[2]);
  const quoted = [...body.matchAll(/query\s*=\s*"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
  return [...heredocs, ...quoted];
}

/** The value of `local.host_storage_auth_signature`, with HCL's `\"` undone. */
function signatureInTree() {
  const match = /^\s*host_storage_auth_signature\s*=\s*"((?:[^"\\]|\\.)*)"$/m.exec(source);
  expect(match, 'local.host_storage_auth_signature not found in infra/').not.toBeNull();
  return match[1].replaceAll('\\"', '"');
}

/** A one-line or heredoc query with the local written in, as Terraform renders it. */
const rendered = (text) => text.replaceAll('\\"', '"').replaceAll('${local.host_storage_auth_signature}', signatureInTree());

describe('the storage sign-in signature', () => {
  it('is the string assert-expected-plan.mjs declares', () => {
    expect(signatureInTree()).toBe(HOST_STORAGE_AUTH_SIGNATURE);
  });

  it('requires all three conditions: no operation, the SDK’s failure type, and the storage error code', () => {
    const signature = signatureInTree();
    expect(signature).toMatch(
      /^isempty\(operation_Name\) and problemId startswith "Azure\.RequestFailedException" and \((.+)\)$/
    );
    const [, messages] = /and \((.+)\)$/.exec(signature);
    // Every alternative inside the brackets names the error code, so nothing
    // without it can match, whichever message column carries it.
    for (const alternative of messages.split(' or ')) {
      expect(alternative, alternative).toMatch(/^(outerMessage|innermostMessage) has "AuthenticationFailed"$/);
    }
  });

  it('uses only columns the classic exceptions table has', () => {
    // From Microsoft's mapping table for the exceptions table,
    // https://learn.microsoft.com/azure/azure-monitor/app/apm-tables, read
    // 2026-11-24. A column the component cannot resolve fails the rule at
    // apply, not at plan.
    const classic = ['operation_Name', 'problemId', 'outerMessage', 'innermostMessage'];
    const used = signatureInTree()
      .replaceAll(/"[^"]*"/g, '')
      .match(/[A-Za-z_]\w*/g)
      .filter((word) => !['isempty', 'and', 'or', 'startswith', 'has'].includes(word));
    expect([...new Set(used)].sort()).toEqual([...classic].sort());
  });
});

describe('alert-app-exceptions', () => {
  it('counts every exception except that signature', () => {
    const queries = queryTexts(blocks.app_exceptions);
    expect(queries).toHaveLength(1);
    expect(queries[0]).toBe('exceptions | where not(${local.host_storage_auth_signature})');
    expect(rendered(queries[0])).toBe(APP_EXCEPTIONS_QUERY);
  });

  it('keeps its severity, threshold, window and frequency', () => {
    const body = blocks.app_exceptions;
    expect(body).toMatch(/^\s*severity\s*=\s*1$/m);
    expect(body).toMatch(/^\s*threshold\s*=\s*5$/m);
    expect(body).toMatch(/^\s*window_duration\s*=\s*"PT15M"$/m);
    expect(body).toMatch(/^\s*evaluation_frequency\s*=\s*"PT5M"$/m);
    expect(body).toContain(`description         = "${APP_EXCEPTIONS_DESCRIPTION}"`);
  });
});

describe('alert-host-storage-auth', () => {
  it('exists for as long as alert-app-exceptions leaves the signature out', () => {
    expect(blocks.host_storage_auth, 'the Sev1 filter has no rule watching what it leaves out').toBeDefined();
  });

  it('watches exactly the rows the Sev1 rule leaves out, over four quarter hours', () => {
    const queries = queryTexts(blocks.host_storage_auth);
    expect(queries).toHaveLength(1);
    const lines = queries[0].split('\n').map((line) => line.trim());
    expect(lines).toEqual([
      'let Slot = 15m;',
      'let Slots = 4;',
      'exceptions',
      '| where timestamp > now() - Slot * Slots',
      '| where ${local.host_storage_auth_signature}',
      '| summarize by slot = tolong((now() - timestamp) / Slot)',
      '| count',
      '| where Count >= Slots',
    ]);
  });

  it('reads an hour, is stateful, pages the ops action group at Sev2', () => {
    const body = blocks.host_storage_auth;
    expect(body).toMatch(/^\s*name\s*=\s*"alert-host-storage-auth-\$\{var\.environment\}-\$\{var\.region_abbreviation\}"$/m);
    expect(body).toMatch(/^\s*severity\s*=\s*2$/m);
    // Four 15-minute slots need the hour the window gives.
    expect(body).toMatch(/^\s*window_duration\s*=\s*"PT1H"$/m);
    expect(body).toMatch(/^\s*evaluation_frequency\s*=\s*"PT15M"$/m);
    expect(body).toMatch(/^\s*auto_mitigation_enabled\s*=\s*true$/m);
    expect(body).toMatch(/^\s*threshold\s*=\s*0$/m);
    expect(body).toContain('action_groups = [azurerm_monitor_action_group.ops.id]');
    expect(body).toContain('scopes              = [azurerm_application_insights.hcw.id]');
  });
});

describe('the plan declaration, pruned once applied (2026-11-27)', () => {
  it('declares nothing on these two rules', () => {
    expect(DECLARED.filter((entry) => entry.address === SEV1 || entry.address === SEV2)).toEqual([]);
  });

  /** The permanent diff with this change beside it, as `terraform show -json` carries it. */
  const plan = ({ query = APP_EXCEPTIONS_QUERY, threshold } = {}) => ({
    resource_changes: [
      ...EXPECTED.replaced.map((address) => ({ address, change: { actions: ['delete', 'create'] } })),
      {
        address: SEV1,
        change: {
          actions: ['update'],
          before: {
            description: 'More than 5 application exceptions in 15 minutes.',
            criteria: [{ query: 'exceptions', threshold: 5 }],
          },
          after: { description: APP_EXCEPTIONS_DESCRIPTION, criteria: [{ query, threshold: threshold ?? 5 }] },
          after_unknown: {},
          before_sensitive: {},
          after_sensitive: {},
        },
      },
      { address: SEV2, change: { actions: ['create'] } },
    ],
  });

  it('reads the plan this change produced as unexpected now that it has applied, naming all three parts', () => {
    const result = checkPlan(plan());
    expect(result.ok).toBe(false);
    const named = result.unexpected.join('\n');
    expect(named).toContain(`${SEV1}: update criteria[0].query`);
    expect(named).toContain(`${SEV1}: update description`);
    expect(named).toContain(`${SEV2}: create`);
  });
  // With nothing declared on these rules any change to them fails; if a declaration is added again, bring back a test that a wider filter or a moved threshold beside it is still refused.
});
