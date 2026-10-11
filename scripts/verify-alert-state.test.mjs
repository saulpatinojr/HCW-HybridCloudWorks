/**
 * The alert verifier (PLAT-4, #964): the HCL scanner it stands on, the
 * declared inventory it derives from infra/, the comparison with what ARM
 * returns, and the operator table that has to name every rule it checks.
 *
 * The live half is exercised against a fake ARM, never Azure: every response
 * below is a fixture shaped like the REST reference for its api-version.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { parseBody, scanCode, skipString } from './lib/hcl-blocks.mjs';
import { declaredAlertRules, environmentSuffix, evaluateTemplate, shortName } from './lib/alert-declarations.mjs';
import { INFRA, terraformSource } from './terraform-source.mjs';
import {
  API_VERSIONS,
  ARM,
  GATES,
  actionGroupProblems,
  coverageOf,
  armGet,
  classifyError,
  compare,
  expectation,
  pendingCreates,
  readLive,
  renderReport,
  readFailureLabel,
  runFails,
  staleUnreadable,
  summariseActionGroup,
  tableCell,
  undeclared,
  unreadableWarnings,
  verdictLine,
  UNREADABLE,
} from './verify-alert-state.mjs';

const REPO = join(INFRA, '..');

/** The last non-empty line of a report: where the runbook says the verdict is. */
const lastLine = (report) => report.trimEnd().split('\n').at(-1);

// ---------------------------------------------------------------------------
// hcl-blocks
// ---------------------------------------------------------------------------

describe('the HCL scanner', () => {
  it('skips a brace inside a string, and an interpolation holding a quoted string', () => {
    const src = '"a } { ${lower("}")} b" rest';
    expect(skipString(src, 0)).toBe(src.indexOf(' rest'));
  });

  it('treats $${ as a literal, not an interpolation', () => {
    const src = '"cost $${not code" tail';
    expect(skipString(src, 0)).toBe(src.indexOf(' tail'));
  });

  it('closes a block past braces in strings, heredocs and comments', () => {
    const src = [
      '{',
      '  a = "}"',
      '  # a comment with a } in it',
      '  /* and { another */',
      '  q = <<-KQL',
      '    T | where x == "}" // resource "azurerm_monitor_metric_alert" "fake" {',
      '  KQL',
      '}',
      'after',
    ].join('\n');
    expect(src.slice(scanCode(src, 1, '}'))).toBe('\nafter');
  });

  it('refuses an unbalanced bracket rather than guessing where the block ends', () => {
    expect(() => scanCode('{ a = [1, 2 }', 1, '}')).toThrow(/expected/);
    expect(() => skipString('"never closed', 0)).toThrow(/unterminated|newline/);
  });

  it('reads attributes and nested blocks one level at a time', () => {
    const body = parseBody(
      [
        'name = "x"',
        'scopes = [',
        '  a.id,',
        '  b.id,',
        ']',
        'query = <<-KQL',
        '  T | summarize n = count()',
        'KQL',
        'count = var.on ? 1 : 0 # trailing comment',
        'action {',
        '  action_groups = [ag.ops.id]',
        '}',
        'dynamic "sms_receiver" {',
        '  for_each = []',
        '}',
      ].join('\n')
    );
    expect(body.attributes.get('name')).toBe('"x"');
    expect(body.attributes.get('scopes')).toContain('b.id');
    expect(body.attributes.get('query')).toMatch(/^<<-KQL[\s\S]*KQL$/);
    expect(body.attributes.get('count')).toBe('var.on ? 1 : 0');
    expect(body.blocks.map((b) => [b.type, b.labels])).toEqual([
      ['action', []],
      ['dynamic', ['sms_receiver']],
    ]);
    expect(parseBody(body.blocks[0].body).attributes.get('action_groups')).toBe('[ag.ops.id]');
  });
});

// ---------------------------------------------------------------------------
// alert-declarations, on a fixture module
// ---------------------------------------------------------------------------

const FIXTURE_BASE = `
variable "environment" {
  default = "prod"
}
variable "region_abbreviation" {
  default = "cus"
}
variable "subscription_app" {
  description = "Application landing zone (sub-app-x)"
  type        = string
  sensitive   = true
}
variable "subscription_mgmt" {
  description = "Platform Management (sub-mgmt-x)"
  sensitive   = true
}
provider "azurerm" {
  features {}
  subscription_id = var.subscription_app
}
provider "azurerm" {
  alias = "mgmt"
  features {}
  subscription_id = var.subscription_mgmt
}
locals {
  # A data block or locals between two resources is what a split on
  # ^resource " gets wrong; this one also carries braces in a string.
  noise = "} { \${lower("}")}"
}
resource "azurerm_resource_group" "app" {
  for_each = toset(["web"])
  name     = "rg-\${each.key}-\${var.environment}"
}
resource "azurerm_resource_group" "mgmt" {
  provider = azurerm.mgmt
  name     = "rg-mgmt-\${var.environment}"
}
resource "azurerm_monitor_action_group" "ops" {
  provider            = azurerm.mgmt
  name                = "ag-ops-\${var.environment}"
  resource_group_name = azurerm_resource_group.mgmt.name
}
`;

const LOG_RULE = `
resource "azurerm_monitor_scheduled_query_rules_alert_v2" "log" {
  count               = var.gate_on ? 1 : 0
  name                = "alert-log-\${var.environment}-\${var.region_abbreviation}"
  resource_group_name = azurerm_resource_group.app["web"].name
  auto_mitigation_enabled = true
  criteria {
    query = <<-KQL
      T | where x == "}" // resource "azurerm_monitor_metric_alert" "fake" {
    KQL
  }
  action {
    action_groups = [azurerm_monitor_action_group.ops.id]
  }
}
resource "azurerm_monitor_activity_log_alert" "rbac" {
  provider            = azurerm.mgmt
  name                = "alert-rbac-\${var.environment}"
  resource_group_name = azurerm_resource_group.mgmt.name
  location            = "global"
  action {
    action_group_id = azurerm_monitor_action_group.ops.id
  }
}
`;

describe('declaredAlertRules on a fixture module', () => {
  const rules = declaredAlertRules(FIXTURE_BASE + LOG_RULE);
  const byName = Object.fromEntries(rules.map((r) => [r.name, r]));

  it('resolves names, resource groups and subscriptions, for_each key included', () => {
    expect(Object.keys(byName).sort()).toEqual(['alert-log-prod-cus', 'alert-rbac-prod']);
    expect(byName['alert-log-prod-cus']).toMatchObject({
      resourceGroup: 'rg-web-prod',
      subscription: 'sub-app-x',
      kind: 'log',
      gate: { variable: 'gate_on' },
      autoMitigate: true,
      enabled: true,
    });
    expect(byName['alert-rbac-prod']).toMatchObject({
      resourceGroup: 'rg-mgmt-prod',
      subscription: 'sub-mgmt-x',
      kind: 'activity-log',
      gate: null,
      autoMitigate: null,
    });
  });

  it('resolves the action group through its own provider and resource group', () => {
    for (const rule of rules) {
      expect(rule.actionGroups).toEqual([
        {
          address: 'azurerm_monitor_action_group.ops',
          name: 'ag-ops-prod',
          resourceGroup: 'rg-mgmt-prod',
          subscription: 'sub-mgmt-x',
        },
      ]);
    }
  });

  it('does not read a resource header out of a heredoc', () => {
    expect(rules.some((r) => r.address.endsWith('.fake'))).toBe(false);
  });

  it('refuses an alert type it cannot read back, so the inventory cannot shrink silently', () => {
    const smart = `resource "azurerm_monitor_smart_detector_alert_rule" "s" {\n  name = "x"\n}\n`;
    expect(() => declaredAlertRules(FIXTURE_BASE + smart)).toThrow(/cannot read back/);
  });

  it('refuses a rule whose provider and resource group are in different subscriptions', () => {
    const crossed = `resource "azurerm_monitor_metric_alert" "m" {
  name                = "alert-m"
  resource_group_name = azurerm_resource_group.mgmt.name
}
`;
    expect(() => declaredAlertRules(FIXTURE_BASE + crossed)).toThrow(/ResourceGroupNotFound/);
  });

  it('refuses a name it cannot resolve instead of dropping the rule', () => {
    const local = `resource "azurerm_monitor_metric_alert" "m" {
  name                = "alert-\${local.thing}"
  resource_group_name = azurerm_resource_group.app["web"].name
}
`;
    expect(() => declaredAlertRules(FIXTURE_BASE + local)).toThrow(/local\.thing/);
  });

  it('records a count it does not recognise by its text', () => {
    const odd = `resource "azurerm_monitor_metric_alert" "m" {
  count               = length(var.list)
  name                = "alert-m"
  resource_group_name = azurerm_resource_group.app["web"].name
}
`;
    const [rule] = declaredAlertRules(FIXTURE_BASE + odd);
    expect(rule.gate).toEqual({ expression: 'length(var.list)' });
    expect(rule.autoMitigate).toBe(true);
  });

  it('undoes template escapes', () => {
    expect(evaluateTemplate('"a\\"b$${c}"', () => 'x')).toBe('a"b${c}');
  });
});

// ---------------------------------------------------------------------------
// alert-declarations, on the real module
// ---------------------------------------------------------------------------

describe('the rules infra/ declares', () => {
  const source = terraformSource();
  const rules = declaredAlertRules(source);
  const suffix = environmentSuffix(source);
  const byName = Object.fromEntries(rules.map((r) => [r.name, r]));

  it('finds them, so a parse that matches nothing fails here rather than reporting zero', () => {
    // A floor, not a count: PLAT-4 adds rules, and pinning a number would
    // make every addition edit this line for no information.
    expect(rules.length).toBeGreaterThanOrEqual(13);
    expect(suffix).toBe('-prod-cus');
  });

  it('places each one where the configuration puts it, in both subscriptions', () => {
    expect(byName['alert-app-exceptions-prod-cus']).toMatchObject({
      resourceGroup: 'rg-web-site-prod-cus',
      subscription: 'sub-app-site-prod-cus',
    });
    for (const name of ['alert-logs-capacity-prod-cus', 'alert-lab-heartbeat-prod-cus', 'alert-lab-unit-failed-prod-cus']) {
      expect(byName[name], name).toMatchObject({
        resourceGroup: 'rg-mgmt-plat-prod-cus',
        subscription: 'sub-plat-mgmt-prod-cus',
      });
    }
  });

  it('routes every rule to the one ops action group', () => {
    for (const rule of rules) {
      expect(rule.actionGroups.map((g) => g.name), rule.address).toEqual(['ag-plat-prod-cus-01']);
      expect(rule.actionGroups[0]).toMatchObject({
        resourceGroup: 'rg-mgmt-plat-prod-cus',
        subscription: 'sub-plat-mgmt-prod-cus',
      });
    }
  });

  it('records every gate a rule uses, and records no gate nothing uses', () => {
    const used = new Set(rules.filter((r) => r.gate).map((r) => r.gate.variable));
    for (const rule of rules.filter((r) => r.gate)) {
      expect(rule.gate.variable, `${rule.address} has count = ${rule.gate.expression}`).toBeDefined();
      expect(GATES[rule.gate.variable], `GATES has no entry for var.${rule.gate.variable}`).toBeDefined();
    }
    for (const name of Object.keys(GATES)) expect(used.has(name), `GATES.${name} gates no rule`).toBe(true);
  });

  it('names every rule in the operator table of the alerting runbook', () => {
    // The acceptance of #964 is that the runbook records every rule. A rule
    // added to infra/ without a row fails here, in the same pull request.
    const runbook = readFileSync(join(REPO, 'docs', 'runbooks', 'alerting-and-support.md'), 'utf8');
    const rows = runbook.split('\n').filter((line) => line.startsWith('| '));
    for (const rule of rules) {
      const short = shortName(rule, suffix);
      expect(
        rows.some((row) => row.includes(`\`${short}\``) || row.includes(`\`${rule.name}\``)),
        `${rule.name} has no row in docs/runbooks/alerting-and-support.md`
      ).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// The comparison
// ---------------------------------------------------------------------------

const APP = 'sub-app';
const MGMT = 'sub-mgmt';
const IDS = new Map([
  [APP, '11111111-1111-1111-1111-111111111111'],
  [MGMT, '22222222-2222-2222-2222-222222222222'],
]);
const OPS = { address: 'azurerm_monitor_action_group.ops', name: 'ag-ops', resourceGroup: 'rg-mgmt', subscription: MGMT };
const OPS_ID = `/subscriptions/${IDS.get(MGMT)}/resourceGroups/rg-mgmt/providers/microsoft.insights/actionGroups/ag-ops`;

/** A declared rule, as declaredAlertRules() returns one, with overrides. */
function rule(overrides = {}) {
  return {
    address: 'azurerm_monitor_scheduled_query_rules_alert_v2.r',
    type: 'azurerm_monitor_scheduled_query_rules_alert_v2',
    kind: 'log',
    armType: 'Microsoft.Insights/scheduledQueryRules',
    name: 'alert-r',
    resourceGroup: 'rg-web',
    subscription: APP,
    gate: null,
    enabled: true,
    autoMitigate: true,
    actionGroups: [OPS],
    ...overrides,
  };
}

/** A live rule, as normaliseRule() returns one, wired to OPS by default. */
function liveRule(overrides = {}) {
  return {
    name: 'alert-r',
    armType: 'Microsoft.Insights/scheduledQueryRules',
    enabled: true,
    autoMitigate: true,
    actionGroupIds: [OPS_ID],
    ...overrides,
  };
}

/** A readLive() result holding an empty list for each rule's group, then the given [declared, live] pairs. */
function liveWith(rules, entries) {
  const lists = new Map();
  for (const r of rules) {
    lists.set(`${r.subscription}|${r.resourceGroup.toLowerCase()}|${r.armType}`, { status: 'ok', rules: new Map() });
  }
  for (const [declared, live] of entries) {
    lists.get(`${declared.subscription}|${declared.resourceGroup.toLowerCase()}|${declared.armType}`).rules.set(
      live.name.toLowerCase(),
      live
    );
  }
  return { ids: IDS, lists, actionGroups: new Map() };
}

describe('compare', () => {
  it('passes a rule that is live, enabled, wired and resolving as declared', () => {
    const r = rule();
    const [v] = compare([r], liveWith([r], [[r, liveRule()]]), { pending: new Map() });
    expect(v.state).toBe('OK');
  });

  it('matches names and action group ids case-insensitively, as ARM returns them', () => {
    const r = rule();
    const live = liveRule({ name: 'ALERT-R', actionGroupIds: [OPS_ID.toLowerCase()] });
    expect(compare([r], liveWith([r], [[r, live]]), { pending: new Map() })[0].state).toBe('OK');
  });

  it('fails a missing rule, and says when its create is waiting for an apply', () => {
    const r = rule();
    const [plain] = compare([r], liveWith([r], []), { pending: new Map() });
    expect(plain.state).toBe('MISSING');
    expect(plain.problems).toEqual(['not in Azure']);
    const [waiting] = compare([r], liveWith([r], []), { pending: new Map([[r.address, 'new rule']]) });
    expect(waiting.state).toBe('MISSING');
    expect(waiting.problems[0]).toMatch(/waiting for an apply: new rule/);
  });

  it('fails a disabled rule', () => {
    const r = rule();
    const [v] = compare([r], liveWith([r], [[r, liveRule({ enabled: false })]]), { pending: new Map() });
    expect(v.state).toBe('DISABLED');
  });

  it('fails a rule wired elsewhere, including the same name in another subscription', () => {
    const r = rule();
    const other = OPS_ID.replace('ag-ops', 'ag-other');
    const elsewhere = OPS_ID.replace(IDS.get(MGMT), IDS.get(APP));
    for (const ids of [[other], [elsewhere], []]) {
      const [v] = compare([r], liveWith([r], [[r, liveRule({ actionGroupIds: ids })]]), { pending: new Map() });
      expect(v.state, JSON.stringify(ids)).toBe('NOT WIRED');
    }
  });

  it('fails autoMitigate drift, the attribute the first version of this check existed for', () => {
    const r = rule();
    const [v] = compare([r], liveWith([r], [[r, liveRule({ autoMitigate: false })]]), { pending: new Map() });
    expect(v.state).toBe('DRIFT');
    expect(v.problems[0]).toMatch(/autoMitigate is false, declared true/);
  });

  it('does not compare autoMitigate on an Activity Log alert, which has none', () => {
    const r = rule({ armType: 'Microsoft.Insights/activityLogAlerts', kind: 'activity-log', autoMitigate: null });
    const live = liveRule({ armType: r.armType, autoMitigate: undefined });
    expect(compare([r], liveWith([r], [[r, live]]), { pending: new Map() })[0].state).toBe('OK');
  });

  it('reports a group it may not read as NOT AUTHORIZED, never as MISSING', () => {
    const r = rule();
    const live = liveWith([r], []);
    live.lists.set(`${APP}|rg-web|${r.armType}`, { status: 'denied', reason: 'HTTP 403 AuthorizationFailed' });
    const [v] = compare([r], live, { pending: new Map() });
    expect(v.state).toBe('NOT AUTHORIZED');
    expect(v.problems).toEqual(['HTTP 403 AuthorizationFailed']);
  });

  it('treats an invisible subscription as NOT AUTHORIZED too', () => {
    const r = rule();
    const live = liveWith([r], []);
    live.lists.set(`${APP}|rg-web|${r.armType}`, { status: 'not-visible', reason: 'not visible' });
    expect(compare([r], live, { pending: new Map() })[0].state).toBe('NOT AUTHORIZED');
  });

  it('expects a gated rule only while its gate is recorded on', () => {
    const r = rule({ gate: { variable: 'g' } });
    const off = { g: { armed: false, record: 'off for a reason' } };
    const on = { g: { armed: true, record: 'armed' } };
    expect(compare([r], liveWith([r], []), { gates: off, pending: new Map() })[0].state).toBe('GATED OFF');
    expect(compare([r], liveWith([r], []), { gates: on, pending: new Map() })[0].state).toBe('MISSING');
    // Live while recorded off fails (review of #1051): Terraform's count is 0
    // for an off gate, so the rule is either hand-made or the record is wrong.
    const [present] = compare([r], liveWith([r], [[r, liveRule()]]), { gates: off, pending: new Map() });
    expect(present.state).toBe('DRIFT');
    expect(present.problems.join(' ')).toMatch(/live although GATES records var\.g as off; correct the record/);
  });

  it('does not guess at a gate nothing records', () => {
    expect(expectation(rule({ gate: { variable: 'nobody' } }), {}).expected).toBe('unknown');
    expect(expectation(rule({ gate: { expression: 'length(x)' } }), {}).expected).toBe('unknown');
    const r = rule({ gate: { variable: 'nobody' } });
    expect(compare([r], liveWith([r], []), { gates: {}, pending: new Map() })[0].state).toBe('ABSENT');
  });

  it('gives an ABSENT rule its own verdict, never "every expected rule is live"', () => {
    // Review of #1051: ABSENT does not fail the run, and is not a pass either.
    const r = rule({ gate: { variable: 'nobody' } });
    const verdicts = compare([r], liveWith([r], []), { gates: {}, pending: new Map() });
    const report = renderReport({ rules: [r], verdicts, extra: [], groups: [], when: 'now', subscriptionsRead: { status: 'ok' } });
    expect(runFails(verdicts, [], { status: 'ok' })).toBe(false);
    expect(lastLine(report)).not.toMatch(/Every expected rule is live/);
    expect(lastLine(report)).toMatch(/1 rule\(s\) are absent behind a `count` gate `GATES` does not record/);
    expect(verdictLine(0, { rules: 0, groups: 0 }, 0)).toBe('**Every expected rule is live, enabled and wired to its action group.**');
    expect(verdictLine(2, { rules: 1, groups: 0 }, 1)).toMatch(/^\*\*2 finding\(s\)\.\*\*/);
  });

  it('lists live rules no declaration names, in the groups it read', () => {
    const r = rule();
    const live = liveWith([r], [[r, liveRule()], [r, liveRule({ name: 'hand-made' })]]);
    expect(undeclared([r], live).map((x) => x.rule.name)).toEqual(['hand-made']);
  });
});

describe('UNREADABLE', () => {
  it('turns only a refusal in a recorded subscription into a non-failing state', () => {
    const recorded = { 'sub-mgmt': { record: 'no grant yet' } };
    expect(readFailureLabel({ status: 'denied' }, 'sub-mgmt', recorded)).toBe('UNREADABLE');
    expect(readFailureLabel({ status: 'not-visible' }, 'sub-mgmt', recorded)).toBe('UNREADABLE');
    // A 401, a 5xx or a 404 is not the recorded gap, and still fails.
    expect(readFailureLabel({ status: 'unauthenticated' }, 'sub-mgmt', recorded)).toBe('NOT AUTHORIZED');
    expect(readFailureLabel({ status: 'failed' }, 'sub-mgmt', recorded)).toBe('READ FAILED');
    expect(readFailureLabel({ status: 'group-not-found' }, 'sub-mgmt', recorded)).toBe('READ FAILED');
    expect(readFailureLabel({ status: 'denied' }, 'sub-app', recorded)).toBe('NOT AUTHORIZED');
  });

  it('records only subscriptions a declared rule lives in', () => {
    const subscriptions = new Set(declaredAlertRules(terraformSource()).map((r) => r.subscription));
    for (const name of Object.keys(UNREADABLE)) expect(subscriptions.has(name), name).toBe(true);
  });
});

describe('tableCell', () => {
  it('escapes a backslash before the pipe it uses to escape, and flattens line breaks', () => {
    // Code scanning js/incomplete-sanitization on #1051: escaping the pipe
    // alone turned `a\|b` into `a\\|b`, an escaped backslash and a bare pipe
    // that splits the cell.
    expect(tableCell('a|b')).toBe('a\\|b');
    expect(tableCell('a\\b')).toBe('a\\\\b');
    expect(tableCell('a\\|b')).toBe('a\\\\\\|b');
    expect(tableCell('one\r\ntwo\nthree')).toBe('one two three');
    expect(tableCell(42)).toBe('42');
  });

  it('keeps an ARM message with a backslash and a pipe inside one cell of the report', () => {
    const r = rule();
    const live = liveWith([r], []);
    live.lists.set(`${APP}|rg-web|${r.armType}`, { status: 'failed', reason: 'HTTP 500: path C:\\x | y' });
    const verdicts = compare([r], live, { pending: new Map() });
    const report = renderReport({ rules: [r], verdicts, extra: [], groups: [], when: 'now', subscriptionsRead: { status: 'ok' } });
    const row = report.split('\n').find((line) => line.startsWith('| `alert-r`'));
    // Ten unescaped pipes make the nine cells of the row; an escaped one does not count.
    expect(row.match(/(?<!\\)(?:\\\\)*\|/g)).toHaveLength(10);
    expect(row).toContain('C:\\\\x \\| y');
  });
});

describe('pendingCreates', () => {
  it('reads the declared creates from the plan checker', () => {
    const pending = pendingCreates([
      { address: 'a.b', action: 'create', reason: 'r' },
      { address: 'c.d', path: 'x', before: 1, after: 2, reason: 'update' },
    ]);
    expect([...pending]).toEqual([['a.b', 'r']]);
  });
});

describe('the action group', () => {
  it('keeps receiver names and statuses and drops the address and number', () => {
    const summary = summariseActionGroup({
      properties: {
        enabled: true,
        emailReceivers: [{ name: 'ops-email', emailAddress: 'owner@example.com', status: 'Enabled' }],
        smsReceivers: [{ name: 'ops-sms', countryCode: '1', phoneNumber: '5555550100', status: 'Enabled' }],
      },
    });
    expect(summary.receivers).toEqual([
      { kind: 'email', name: 'ops-email', status: 'Enabled' },
      { kind: 'sms', name: 'ops-sms', status: 'Enabled' },
    ]);
    expect(JSON.stringify(summary)).not.toContain('owner@example.com');
    expect(JSON.stringify(summary)).not.toContain('5555550100');
  });

  it('fails a disabled group, and one whose receivers are all off', () => {
    const r = rule();
    const live = liveWith([r], []);
    live.actionGroups.set(OPS.address, { status: 'ok', enabled: false, receivers: [{ kind: 'email', name: 'e', status: 'Enabled' }] });
    expect(actionGroupProblems([r], live)[0]).toMatchObject({ state: 'BROKEN', problems: ['the action group is disabled'] });
    live.actionGroups.set(OPS.address, { status: 'ok', enabled: true, receivers: [{ kind: 'email', name: 'e', status: 'Disabled' }] });
    expect(actionGroupProblems([r], live)[0].problems).toEqual(['no receiver has status Enabled']);
    live.actionGroups.set(OPS.address, { status: 'denied', reason: 'HTTP 403' });
    expect(actionGroupProblems([r], live)[0].state).toBe('NOT AUTHORIZED');
  });
});

// ---------------------------------------------------------------------------
// The ARM reader, against a fake ARM
// ---------------------------------------------------------------------------

/** A fetch stand-in answering from [pattern, [status, body]] routes, recording each call. */
function fakeArm(routes) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, auth: init?.headers?.Authorization });
    const route = routes.find(([pattern]) => pattern.test(url));
    const [status, body] = route ? route[1] : [404, { error: { code: 'NotFound', message: 'no route' } }];
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  return { fetchImpl, calls };
}

describe('armGet', () => {
  it('follows nextLink on the ARM host and collects every page', async () => {
    const { fetchImpl, calls } = fakeArm([
      [/page2/, [200, { value: [{ name: 'b' }] }]],
      [/things/, [200, { value: [{ name: 'a' }], nextLink: `${ARM}/things?page2` }]],
    ]);
    const read = await armGet('/things', { token: 't', fetchImpl, list: true });
    expect(read.rows.map((r) => r.name)).toEqual(['a', 'b']);
    expect(calls.every((c) => c.auth === 'Bearer t')).toBe(true);
  });

  it('refuses a nextLink that leaves management.azure.com, before sending the token there', async () => {
    const { fetchImpl, calls } = fakeArm([[/things/, [200, { value: [], nextLink: 'https://elsewhere.example/steal' }]]]);
    const read = await armGet('/things', { token: 't', fetchImpl, list: true });
    expect(read.status).toBe('failed');
    expect(calls.map((c) => c.url)).toEqual([`${ARM}/things`]);
  });

  it('classifies ARM errors and masks the IDs in their messages', () => {
    const denied = classifyError(403, {
      error: {
        code: 'AuthorizationFailed',
        message: "The client 'abcdef01-2345-6789-abcd-ef0123456789' does not have authorization",
      },
    });
    expect(denied.status).toBe('denied');
    expect(denied.reason).not.toMatch(/abcdef01/);
    expect(classifyError(404, { error: { code: 'ResourceGroupNotFound' } }).status).toBe('group-not-found');
    expect(classifyError(500, {}).status).toBe('failed');
  });
});

describe('readLive and the report, end to end on the real inventory', () => {
  const rules = declaredAlertRules(terraformSource());
  const subs = [...new Set(rules.map((r) => r.subscription))].map((name, i) => ({
    displayName: name,
    subscriptionId: `0000000${i}-0000-0000-0000-000000000000`,
  }));
  const idOf = (name) => subs.find((s) => s.displayName === name).subscriptionId;
  const ag = rules[0].actionGroups[0];
  const agId = `/subscriptions/${idOf(ag.subscription)}/resourceGroups/${ag.resourceGroup}/providers/microsoft.insights/actionGroups/${ag.name}`;

  /** ARM rows for every rule a gate does not hold off, in each list's own shape. */
  function rowsFor(armType, group, subscription) {
    return rules
      .filter((r) => r.armType === armType && r.resourceGroup === group && r.subscription === subscription)
      .filter((r) => expectation(r).expected !== 'absent')
      .map((r) => {
        const properties = { enabled: true, autoMitigate: r.autoMitigate ?? undefined };
        if (armType === 'Microsoft.Insights/scheduledQueryRules') properties.actions = { actionGroups: [agId] };
        else if (armType === 'Microsoft.Insights/metricAlerts') properties.actions = [{ actionGroupId: agId }];
        else properties.actions = { actionGroups: [{ actionGroupId: agId }] };
        return { name: r.name, properties };
      });
  }

  function routes({ deny = null } = {}) {
    const out = [[/\/subscriptions\?api-version=/, [200, { value: subs }]]];
    out.push([
      /\/actionGroups\//,
      deny === ag.subscription
        ? [403, { error: { code: 'AuthorizationFailed', message: 'no' } }]
        : [200, { properties: { enabled: true, emailReceivers: [{ name: 'ops-email', emailAddress: 'x@example.com', status: 'Enabled' }] } }],
    ]);
    for (const r of rules) {
      const pattern = new RegExp(`/subscriptions/${idOf(r.subscription)}/resourceGroups/${r.resourceGroup}/providers/${r.armType}\\?`);
      out.push([
        pattern,
        deny === r.subscription
          ? [403, { error: { code: 'AuthorizationFailed', message: 'no' } }]
          : [200, { value: rowsFor(r.armType, r.resourceGroup, r.subscription) }],
      ]);
    }
    return out;
  }

  it('passes when every expected rule is live, and names every declared rule in the report', async () => {
    const { fetchImpl, calls } = fakeArm(routes());
    const live = await readLive(rules, { token: 't', fetchImpl });
    const verdicts = compare(rules, live, { pending: new Map() });
    expect(verdicts.filter((v) => !['OK', 'GATED OFF'].includes(v.state))).toEqual([]);
    const groups = actionGroupProblems(rules, live);
    expect(groups.map((g) => g.state)).toEqual(['OK']);
    const report = renderReport({ rules, verdicts, extra: [], groups, when: 'now', subscriptionsRead: live.subscriptionsRead });
    for (const r of rules) expect(report).toContain(`\`${r.name}\``);
    expect(report).toMatch(/Every expected rule is live, enabled and wired/);
    expect(report).not.toContain('x@example.com');
    for (const call of calls) expect(call.url.startsWith(`${ARM}/`)).toBe(true);
    for (const path of Object.keys(API_VERSIONS).filter((k) => k.includes('/'))) {
      expect(calls.some((c) => c.url.includes(`${path}?api-version=${API_VERSIONS[path]}`))).toBe(rules.some((r) => r.armType === path));
    }
  });

  it('marks a refused, unrecorded subscription NOT AUTHORIZED, and fails', async () => {
    const mgmt = rules.find((r) => r.subscription.includes('mgmt')).subscription;
    const { fetchImpl } = fakeArm(routes({ deny: mgmt }));
    const live = await readLive(rules, { token: 't', fetchImpl });
    const verdicts = compare(rules, live, { pending: new Map(), unreadable: {} });
    for (const v of verdicts.filter((x) => x.rule.subscription === mgmt)) expect(v.state).toBe('NOT AUTHORIZED');
    const groups = actionGroupProblems(rules, live, {});
    const report = renderReport({ rules, verdicts, extra: [], groups, when: 'now', subscriptionsRead: live.subscriptionsRead });
    expect(report).toMatch(/not the same finding as `MISSING`/);
    expect(runFails(verdicts, groups, live.subscriptionsRead)).toBe(true);
  });

  it('reports a recorded gap every run without failing on it, and still fails on the rest', async () => {
    // The estate until #1053: the workflow's identity could read
    // rg-web-site-prod-cus and nothing in Management. The live table is empty
    // since, so this holds the mechanism to a record of its own: the run is
    // green on what it can read, says which rules it could not, and is red
    // the moment a readable rule is wrong.
    const mgmt = rules.find((r) => r.subscription.includes('mgmt')).subscription;
    const recorded = { [mgmt]: { record: 'no grant there yet (test record)' } };
    const { fetchImpl } = fakeArm(routes({ deny: mgmt }));
    const live = await readLive(rules, { token: 't', fetchImpl });
    const verdicts = compare(rules, live, { pending: new Map(), unreadable: recorded });
    const groups = actionGroupProblems(rules, live, recorded);
    for (const v of verdicts.filter((x) => x.rule.subscription === mgmt)) {
      expect(v.state).toBe('UNREADABLE');
      expect(v.notes.join(' ')).toContain(recorded[mgmt].record);
    }
    expect(groups.map((g) => g.state)).toEqual(['UNREADABLE']);
    expect(runFails(verdicts, groups, live.subscriptionsRead)).toBe(false);
    const report = renderReport({ rules, verdicts, extra: [], groups, when: 'now', subscriptionsRead: live.subscriptionsRead });
    expect(report).toMatch(/Every rule this identity can read and judge is live, enabled and wired/);
    expect(report).toMatch(/\*\*unknown\*\*, not healthy/);
    const warnings = unreadableWarnings(verdicts, groups, recorded);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^::warning title=Alert rules not readable::\d+ declared rule\(s\) in sub-plat-mgmt-prod-cus/);
    expect(warnings[0]).toContain('no grant there yet (test record)');

    const appRule = verdicts.find((v) => v.rule.subscription !== mgmt);
    const broken = verdicts.map((v) => (v === appRule ? { ...v, state: 'MISSING' } : v));
    expect(runFails(broken, groups, live.subscriptionsRead)).toBe(true);
  });

  it('records no gap since #1053, so a refused Management read now fails the run', async () => {
    // github_alert_reader reads alert rules and action groups in both groups
    // (infra/oidc.tf), so nothing is excused: a refusal there is NOT
    // AUTHORIZED, a finding, not an UNREADABLE that keeps the run green.
    expect(UNREADABLE).toEqual({});
    const mgmt = rules.find((r) => r.subscription.includes('mgmt')).subscription;
    const { fetchImpl } = fakeArm(routes({ deny: mgmt }));
    const live = await readLive(rules, { token: 't', fetchImpl });
    const verdicts = compare(rules, live, { pending: new Map() });
    const groups = actionGroupProblems(rules, live);
    for (const v of verdicts.filter((x) => x.rule.subscription === mgmt)) expect(v.state).toBe('NOT AUTHORIZED');
    expect(runFails(verdicts, groups, live.subscriptionsRead)).toBe(true);
  });

  it('fails the run on a stale record, so the exception goes with the grant that closed it', async () => {
    // Review of #1051: an entry that outlives the gap would let a later
    // refusal there pass quietly. So a readable recorded subscription fails
    // the workflow's run until the entry is deleted.
    const mgmt = rules.find((r) => r.subscription.includes('mgmt')).subscription;
    const recorded = { [mgmt]: { record: 'no grant there yet (test record)' } };
    const { fetchImpl } = fakeArm(routes());
    const live = await readLive(rules, { token: 't', fetchImpl });
    const stale = staleUnreadable(rules, live, recorded);
    expect(stale).toEqual([mgmt]);
    const verdicts = compare(rules, live, { pending: new Map(), unreadable: recorded });
    const groups = actionGroupProblems(rules, live, recorded);
    expect(runFails(verdicts, groups, live.subscriptionsRead, [])).toBe(false);
    expect(runFails(verdicts, groups, live.subscriptionsRead, stale)).toBe(true);
    const report = renderReport({ rules, verdicts, extra: [], groups, when: 'now', subscriptionsRead: live.subscriptionsRead, stale });
    expect(report).toMatch(/STALE RECORD: `sub-plat-mgmt-prod-cus` is readable by this workflow now/);
    expect(lastLine(report)).toMatch(/^\*\*1 finding\(s\)\.\*\*/);
  });

  it('ends every report with the verdict, whatever notices come before it', async () => {
    // Review of #1051: the runbook's success test reads the last line.
    const mgmt = rules.find((r) => r.subscription.includes('mgmt')).subscription;
    const { fetchImpl } = fakeArm(routes({ deny: mgmt }));
    const live = await readLive(rules, { token: 't', fetchImpl });
    const unrecorded = compare(rules, live, { pending: new Map(), unreadable: {} });
    const denied = renderReport({ rules, verdicts: unrecorded, extra: [], groups: actionGroupProblems(rules, live, {}), when: 'now', subscriptionsRead: live.subscriptionsRead, stale: [mgmt] });
    expect(lastLine(denied)).toMatch(/^\*\*\d+ finding\(s\)\.\*\*/);
    const gap = { [mgmt]: { record: 'no grant there yet (test record)' } };
    const recorded = compare(rules, live, { pending: new Map(), unreadable: gap });
    const partial = renderReport({ rules, verdicts: recorded, extra: [], groups: actionGroupProblems(rules, live, gap), when: 'now', subscriptionsRead: live.subscriptionsRead });
    expect(lastLine(partial)).toMatch(/^\*\*Every rule this identity can read and judge is live, enabled and wired\.\*\*/);
    const { fetchImpl: allOk } = fakeArm(routes());
    const full = await readLive(rules, { token: 't', fetchImpl: allOk });
    const clean = renderReport({ rules, verdicts: compare(rules, full, { pending: new Map() }), extra: [], groups: actionGroupProblems(rules, full), when: 'now', subscriptionsRead: full.subscriptionsRead });
    expect(lastLine(clean)).toBe('**Every expected rule is live, enabled and wired to its action group.**');
  });

  it('reports coverage as partial while a recorded subscription goes unread, and complete otherwise', async () => {
    const mgmt = rules.find((r) => r.subscription.includes('mgmt')).subscription;
    const { fetchImpl: denied } = fakeArm(routes({ deny: mgmt }));
    const partial = await readLive(rules, { token: 't', fetchImpl: denied });
    expect(coverageOf(compare(rules, partial, { pending: new Map() }), actionGroupProblems(rules, partial))).toBe('partial');
    const { fetchImpl: allOk } = fakeArm(routes());
    const full = await readLive(rules, { token: 't', fetchImpl: allOk });
    expect(coverageOf(compare(rules, full, { pending: new Map() }), actionGroupProblems(rules, full))).toBe('complete');
  });

  it('reports coverage as partial when an unrecorded read is refused or fails too', async () => {
    // Review of #1051: a failing run that read half the estate must not tell
    // a consumer of the output that coverage was complete.
    const mgmt = rules.find((r) => r.subscription.includes('mgmt')).subscription;
    const { fetchImpl: denied } = fakeArm(routes({ deny: mgmt }));
    const live = await readLive(rules, { token: 't', fetchImpl: denied });
    const verdicts = compare(rules, live, { pending: new Map(), unreadable: {} });
    expect(verdicts.some((v) => v.state === 'NOT AUTHORIZED')).toBe(true);
    expect(coverageOf(verdicts, actionGroupProblems(rules, live, {}))).toBe('partial');
    const failed = verdicts.map((v) => (v.state === 'NOT AUTHORIZED' ? { ...v, state: 'READ FAILED' } : v));
    expect(coverageOf(failed, [])).toBe('partial');
  });

  it('reports a subscription it cannot see as invisible, not as an empty group', async () => {
    const visible = subs.filter((s) => !s.displayName.includes('mgmt'));
    const base = routes().slice(1);
    const { fetchImpl } = fakeArm([[/\/subscriptions\?api-version=/, [200, { value: visible }]], ...base]);
    const live = await readLive(rules, { token: 't', fetchImpl });
    const mgmtRead = [...live.lists].find(([key]) => key.includes('mgmt'))[1];
    expect(mgmtRead.status).toBe('not-visible');
    expect(live.actionGroups.get(ag.address).status).toBe('not-visible');
  });
});
