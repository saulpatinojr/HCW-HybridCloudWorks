/**
 * The Terraform run identity's grants, held to what infra/ actually declares
 * (estate review 2026-10-06, finding SEC-1).
 *
 * `scripts/bootstrap-terraform-oidc.ps1` grants `id-plat-terraform-prod-cus-01`
 * Contributor on each resource group infra/ declares, and a custom
 * subscription-scope role for the few things infra/ does above a group.
 * Both lists live in `scripts/terraform-identity-grants.json`. They are
 * copies of facts that live in `infra/*.tf`, and a copy drifts in the
 * direction nobody sees until an apply: a group added to infra/ and not to
 * the JSON is a group Terraform can create and then cannot fill, and the
 * failure is `AuthorizationFailed` on the owner's confirmation, naming a
 * resource rather than the missing grant. So the copies are compared here,
 * from the HCL, on every run.
 *
 * And `scripts/Set-TerraformRbacCondition.ps1` says "nothing in infra/
 * assigns a denied role". That sentence is a contract: an infra/ change that
 * assigns a denied role plans cleanly and is refused at apply. It is
 * enforced here too.
 *
 * Text, not a parser, like the other infra checks in this package
 * (terraform-source.mjs): every value read below is a literal on its own
 * line, and each reader asserts it found something, so a regex that rots
 * fails loudly instead of comparing two empty lists.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { terraformSource, INFRA } from './terraform-source.mjs';

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const grants = JSON.parse(readFileSync(join(SCRIPTS, 'terraform-identity-grants.json'), 'utf8'));
const source = terraformSource();
const variables = readFileSync(join(INFRA, 'variables.tf'), 'utf8');
const conditionScript = readFileSync(join(SCRIPTS, 'Set-TerraformRbacCondition.ps1'), 'utf8');
const bootstrapScript = readFileSync(join(SCRIPTS, 'bootstrap-terraform-oidc.ps1'), 'utf8');

/**
 * The HCP Terraform project in the federated-credential subject has one
 * documented value, and the script's default must be that value: on
 * 2026-10-07 the default, the runbook and backend.tf all said one project while
 * the live workspace sat in another, and a re-run would have replaced the
 * credentials silently. This pins the default to the two documents an operator
 * reads first, so the three cannot drift apart again; which project is RIGHT
 * is read off the workspace's Settings page, not from any of them.
 */
describe('the OIDC project default', () => {
  const scriptDefault = bootstrapScript.match(/^\s*\[string\] \$TfcProject = '([^']+)',/m)[1];
  const backend = readFileSync(join(SCRIPTS, '..', 'infra', 'backend.tf'), 'utf8');
  const backendProject = backend.match(/^# Org: hcw \| Project: ([^|]+?) \| Workspace: hcw-azure$/m)[1];
  const runbook = readFileSync(join(SCRIPTS, '..', 'docs', 'runbooks', 'deployment-runbook.md'), 'utf8');
  const runbookProject = runbook.match(/org `hcw`, project `([^`]+)`, workspace `hcw-azure`/)[1];

  it('is the project backend.tf and the deployment runbook name', () => {
    expect(scriptDefault).toBe(backendProject);
    expect(scriptDefault).toBe(runbookProject);
  });

  it('is replaced on the identity only when asked', () => {
    expect(bootstrapScript).toMatch(/\[switch\] \$ReplaceFederatedCredentials/);
    expect(bootstrapScript).toMatch(/if \(-not \$ReplaceFederatedCredentials\) \{\s*Stop-WithGuidance/);
  });
});

/** Every `resource "<type>" "<label>" { ... }` block, braces balanced. */
function resourceBlocks(text, type) {
  const out = [];
  const head = new RegExp(`^resource\\s+"${type}"\\s+"(\\w+)"\\s*\\{`, 'gm');
  for (const m of text.matchAll(head)) {
    let depth = 0;
    let end = m.index;
    for (let i = m.index; i < text.length; i += 1) {
      if (text[i] === '{') depth += 1;
      else if (text[i] === '}') {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    out.push({ label: m[1], body: text.slice(m.index, end + 1) });
  }
  return out;
}

/** A variable's string default from infra/variables.tf. */
function stringDefault(name) {
  const m = variables.match(
    new RegExp(`variable\\s+"${name}"\\s*\\{[^}]*?\\bdefault\\s*=\\s*"([^"]*)"`, 's')
  );
  if (!m) throw new Error(`variable "${name}" has no string default in infra/variables.tf`);
  return m[1];
}

/** The keys of `local.app_resource_groups` in main.tf. */
function appResourceGroupKeys() {
  const m = source.match(/app_resource_groups\s*=\s*\{([\s\S]*?)\n {2}\}/);
  if (!m) throw new Error('local.app_resource_groups not found in infra/');
  return [...m[1].matchAll(/^\s{4}(\w+)\s*=/gm)].map((k) => k[1]);
}

const SLOT_BY_PROVIDER = { '': 'app', mgmt: 'mgmt', conn: 'conn' };

/** Which subscription slot a resource block lands in, from its provider alias. */
function blockSlot(label, body) {
  const alias = body.match(/^\s*provider\s*=\s*azurerm\.(\w+)/m)?.[1] ?? '';
  const slot = SLOT_BY_PROVIDER[alias];
  if (!slot) throw new Error(`azurerm_resource_group.${label} uses provider alias "${alias}", which has no slot`);
  return slot;
}

/** A name template with `${each.key}` and the naming variables substituted. */
function resolveName(label, template, key, values) {
  return template.replace(/\$\{([^}]+)\}/g, (whole, expr) => {
    if (expr === 'each.key' && key) return key;
    if (expr in values) return values[expr];
    throw new Error(`azurerm_resource_group.${label}: cannot resolve ${whole} in "${template}"`);
  });
}

/** The names one azurerm_resource_group block creates. */
function blockNames(label, body, values) {
  const template = body.match(/^\s*name\s*=\s*"([^"]+)"/m)?.[1];
  if (!template) throw new Error(`azurerm_resource_group.${label} has no literal name template`);
  const keys = /for_each\s*=\s*local\.app_resource_groups/.test(body) ? appResourceGroupKeys() : [null];
  return keys.map((key) => resolveName(label, template, key, values));
}

/** slot -> sorted resource group names, as infra/ would create them with its defaults. */
function declaredResourceGroups() {
  const values = {
    'var.workload_name': stringDefault('workload_name'),
    'var.environment': stringDefault('environment'),
    'var.region_abbreviation': stringDefault('region_abbreviation'),
  };
  const blocks = resourceBlocks(source, 'azurerm_resource_group');
  if (blocks.length === 0) throw new Error('no azurerm_resource_group blocks found — the regex has rotted');
  const bySlot = { app: [], mgmt: [], conn: [] };
  for (const { label, body } of blocks) {
    bySlot[blockSlot(label, body)].push(...blockNames(label, body, values));
  }
  return Object.fromEntries(Object.entries(bySlot).map(([slot, names]) => [slot, names.sort()]));
}

/** The names in a PowerShell `$Name = @( 'a', 'b' )` array. */
function psArray(text, name) {
  const m = text.match(new RegExp(`\\$${name}\\s*=\\s*@\\(([\\s\\S]*?)\\)`));
  if (!m) throw new Error(`$${name} not found`);
  return [...m[1].matchAll(/'([^']+)'/g)].map((s) => s[1]);
}

describe('Contributor on the resource groups infra/ declares', () => {
  const declared = declaredResourceGroups();

  it('reads a plausible set of groups from infra/ at all', () => {
    // Guards the guard: nine groups across three subscriptions on 2026-10-07.
    const total = Object.values(declared).flat().length;
    expect(total).toBeGreaterThanOrEqual(9);
    expect(declared.mgmt.length).toBeGreaterThan(0);
    expect(declared.conn.length).toBeGreaterThan(0);
  });

  it('lists exactly the groups infra/ creates, in the subscription that holds each', () => {
    const listed = Object.fromEntries(
      Object.entries(grants.resourceGroups).map(([slot, names]) => [slot, [...names].sort()])
    );
    expect(
      listed,
      'scripts/terraform-identity-grants.json "resourceGroups" differs from the azurerm_resource_group ' +
        'blocks in infra/. A group missing from the JSON is one Terraform can create and then cannot ' +
        'put anything in. Add it there in the same change, and see the bootstrap script, section 5, ' +
        'for the extra pass a new group needs.'
    ).toEqual(declared);
  });
});

describe('the subscription-scope custom role', () => {
  const role = grants.subscriptionRole;

  it('registers exactly the providers var.azure_resource_providers lists', () => {
    const block = variables.match(/variable\s+"azure_resource_providers"\s*\{[\s\S]*?default\s*=\s*\[([\s\S]*?)\]/);
    expect(block, 'variable "azure_resource_providers" not found').not.toBeNull();
    const providers = [...block[1].matchAll(/"([^"]+)"/g)].map((p) => p[1]).sort();
    expect(providers.length).toBeGreaterThan(5);
    const registers = role.Actions.filter((a) => a.endsWith('/register/action'))
      .map((a) => a.replace(/\/register\/action$/, ''))
      .sort();
    expect(registers).toEqual(providers);
  });

  it('cannot delete a resource group, write authorization, or reach a data plane', () => {
    const lower = role.Actions.map((a) => a.toLowerCase());
    expect(lower).not.toContain('microsoft.resources/subscriptions/resourcegroups/delete');
    expect(lower.filter((a) => a.includes('*'))).toEqual([]);
    expect(lower.filter((a) => a.startsWith('microsoft.authorization/'))).toEqual([]);
    expect(role.DataActions).toEqual([]);
  });

  it('can create the groups and keep the budgets infra/ declares at subscription scope', () => {
    expect(role.Actions).toContain('Microsoft.Resources/subscriptions/resourceGroups/write');
    expect(role.Actions).toContain('Microsoft.Consumption/budgets/write');
    expect(source).toMatch(/^resource\s+"azurerm_consumption_budget_subscription"/m);
  });

  it('is the role the bootstrap reads and the condition script recognises by name', () => {
    expect(bootstrapScript).toContain("'terraform-identity-grants.json'");
    expect(psArray(conditionScript, 'MarkerRoles')).toContain(role.Name);
  });
});

describe('the RBAC Administrator condition against what infra/ assigns', () => {
  const denied = psArray(conditionScript, 'DeniedOnWrite');
  const userOnly = (conditionScript.match(/\$UserOnlyOnWrite\s*=\s*'([^']+)'/) ?? [])[1];

  it('refuses Contributor, so a run cannot hand the subscription-wide grant back to itself', () => {
    expect(denied).toContain('Contributor');
    expect(denied).toContain('Owner');
    expect(userOnly).toBe('Key Vault Secrets Officer');
  });

  it('is never asked by infra/ to assign a denied role, except the user-only seeding window', () => {
    const assignments = resourceBlocks(source, 'azurerm_role_assignment').map(({ label, body }) => ({
      label,
      role: (body.match(/^\s*role_definition_name\s*=\s*"([^"]+)"/m) ?? [])[1],
      principalIsAdminList: /principal_id\s*=\s*each\.value/.test(body) && /var\.admin_object_ids/.test(body),
    }));
    expect(assignments.length).toBeGreaterThan(10);
    const refused = assignments
      .filter((a) => a.role && denied.includes(a.role))
      .filter((a) => !(a.role === userOnly && a.principalIsAdminList))
      .map((a) => `azurerm_role_assignment.${a.label} assigns "${a.role}", which the condition refuses`);
    expect(refused).toEqual([]);
  });
});

/**
 * SEC-1 step two takes Contributor off the subscription, so everything infra/
 * does has to be covered by what is left: Contributor on each declared group,
 * the custom role at the subscription, and RBAC Administrator (conditioned)
 * at the subscription, whose built-in definition also grants every
 * control-plane read (Microsoft's built-in roles reference lists the wildcard
 * read action; the condition restricts role-assignment writes and deletes
 * only). Contributor carries no data actions,
 * so no data-plane path changes with it.
 *
 * The audit is recorded in ADR 0005 (amendment "2026-10-07, step two") and
 * in the bootstrap's section 5 comment. These checks keep it true as infra/
 * grows: every resource and data type infra/ uses is classified below by the
 * grant that covers it, and a type nobody has classified fails the build,
 * because the failure it prevents is AuthorizationFailed on the owner's
 * confirmation, naming a resource rather than the missing grant.
 */
/** Every `resource` and `data` block in infra/, with braces balanced. */
function allBlocks(text) {
  const out = [];
  const head = /^(resource|data)\s+"(\w+)"\s+"(\w+)"\s*\{/gm;
  for (const m of text.matchAll(head)) {
    let depth = 0;
    let end = m.index;
    for (let i = m.index; i < text.length; i += 1) {
      if (text[i] === '{') depth += 1;
      else if (text[i] === '}') {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    const key = m[1] === 'data' ? `data.${m[2]}` : m[2];
    out.push({ key, label: m[3], body: text.slice(m.index, end + 1) });
  }
  return out;
}

/** A block's text with whole-line comments removed. */
function withoutComments(body) {
  return body
    .split('\n')
    .filter((line) => !/^\s*(#|\/\/)/.test(line))
    .join('\n');
}

const BUDGET_ACTIONS = [
  'Microsoft.Consumption/budgets/read',
  'Microsoft.Consumption/budgets/write',
  'Microsoft.Consumption/budgets/delete',
];

/**
 * Types whose Azure scope is the subscription itself, and the custom-role
 * actions each needs. Provider registration is the third subscription-scope
 * job; the register test above holds it to var.azure_resource_providers.
 */
const SUBSCRIPTION_SCOPE = {
  azurerm_resource_group: [
    'Microsoft.Resources/subscriptions/resourceGroups/read',
    'Microsoft.Resources/subscriptions/resourceGroups/write',
  ],
  azurerm_consumption_budget_subscription: BUDGET_ACTIONS,
};

/** Covered by something other than Contributor on a group, and why. */
const OTHER_GRANT = {
  azurerm_role_assignment: 'RBAC Administrator at subscription scope, under its condition',
  azurerm_resource_group_policy_assignment:
    'nothing the run identity holds: the owner grants Resource Policy Contributor on the group ' +
    '(docs/runbooks/labs-host.md) before setting lab_hybrid_policy_enabled; Contributor never could',
  'data.azurerm_client_config': 'no Azure call: read from the token',
  'data.azurerm_role_definition': "RBAC Administrator's */read at subscription scope",
};

/**
 * Created, read and changed inside one of the declared groups, so Contributor
 * on that group covers them. A cross-group or cross-subscription reference
 * among them (peering to the other virtual network, diagnostics and the data
 * collection rule to the Management workspace, an action group in
 * Management) points at another declared group, which Contributor covers too.
 */
const IN_A_DECLARED_GROUP = new Set([
  'azapi_resource',
  'azapi_resource_action',
  'azapi_update_resource',
  'data.azapi_resource',
  'azurerm_app_service_custom_hostname_binding',
  'azurerm_application_insights',
  'azurerm_application_insights_standard_web_test',
  // The account itself is in the `ai` group. Destroying it is not covered:
  // azurerm then purges it through deletedAccounts/delete at subscription
  // scope, which the custom role deliberately lacks (ADR 0005, step two).
  'azurerm_cognitive_account',
  'azurerm_cognitive_deployment',
  'azurerm_consumption_budget_resource_group',
  'azurerm_cosmosdb_account',
  'azurerm_cosmosdb_sql_container',
  'azurerm_cosmosdb_sql_database',
  'azurerm_cosmosdb_sql_role_assignment',
  'azurerm_federated_identity_credential',
  'azurerm_function_app_flex_consumption',
  'azurerm_key_vault',
  'azurerm_log_analytics_workspace',
  'azurerm_monitor_action_group',
  // The rule is written in its resource_group_name, a declared group. What
  // its `scopes` name is only READ: see WATCH_SCOPES below (PLAT-4, #964).
  'azurerm_monitor_activity_log_alert',
  'azurerm_monitor_data_collection_rule',
  'azurerm_monitor_diagnostic_setting',
  'azurerm_monitor_metric_alert',
  'azurerm_monitor_scheduled_query_rules_alert_v2',
  'azurerm_network_security_group',
  'azurerm_route_table',
  'azurerm_service_plan',
  'azurerm_static_web_app',
  'azurerm_storage_account',
  'azurerm_storage_container',
  // The lab backups container's time-based retention (LAB-9, #955): written
  // on a container in a declared group; Contributor's storage actions cover it.
  'azurerm_storage_container_immutability_policy',
  'azurerm_storage_management_policy',
  'azurerm_subnet',
  'azurerm_subnet_network_security_group_association',
  'azurerm_user_assigned_identity',
  'azurerm_virtual_network',
  'azurerm_virtual_network_peering',
]);

/**
 * The attributes that decide where an Azure call lands: the group a resource
 * is created in, the scope a role assignment or alert targets, the parent or
 * target of an azapi or diagnostic resource. Every one of them must resolve
 * to a declared group or something inside one.
 */
const SCOPE_ATTRIBUTES = [
  'scope',
  'scopes',
  'parent_id',
  'resource_id',
  'target_resource_id',
  'resource_group_name',
  'resource_group_id',
];

/**
 * Locals and variables a scope-bearing attribute may name, each with the
 * reason it resolves below a declared group. Empty on purpose: none is used
 * on 2026-10-07, and an entry here is a reviewed decision, not a default.
 */
const SCOPE_EXPRESSION_ALLOWLIST = {};

/**
 * Scope attributes that name what a block WATCHES, not where it writes, and
 * so may name a whole subscription (PLAT-4, #964).
 *
 * An Activity Log alert is created in its `resource_group_name`, which is held
 * below a declared group like every other block's. Its `scopes` are the
 * prefixes of the Activity Log events it evaluates. Microsoft's prerequisite
 * for an alert rule's target is read permission ("Read permission on the
 * target resource of the alert rule"), and every read above a group is RBAC
 * Administrator's `*\/read` on both sides of step two (ADR 0005). Nothing is
 * created, changed or assigned at those scopes, so naming the subscription
 * there widens nothing the run identity does.
 *
 * Only the two subscription slots infra/ already targets are accepted, and
 * only as the whole subscription; any other value in these attributes is
 * checked like every scope above.
 */
const WATCH_SCOPES = {
  'azurerm_monitor_activity_log_alert.scopes':
    'Activity Log events the rule evaluates, read through RBAC Administrator */read',
};
const SUBSCRIPTION_WATCH = /^"\/subscriptions\/\$\{var\.subscription_(app|mgmt)\}"$/;

/** A watch-scope value with its whole-subscription items removed. */
function withoutSubscriptionWatch(value) {
  const items = value
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((item) => !SUBSCRIPTION_WATCH.test(item));
  return `[${items.join(', ')}]`;
}

describe('what infra/ does once subscription Contributor is gone (SEC-1 step two)', () => {
  const blocks = allBlocks(source).filter((b) => /^(data\.)?(azurerm|azapi)_/.test(b.key));
  const declared = Object.values(declaredResourceGroups()).flat();
  const values = {
    'var.workload_name': stringDefault('workload_name'),
    'var.environment': stringDefault('environment'),
    'var.region_abbreviation': stringDefault('region_abbreviation'),
  };

  it('reads a plausible set of Azure blocks from infra/ at all', () => {
    // Guards the guard: about 130 azurerm and azapi blocks on 2026-10-07.
    expect(blocks.length).toBeGreaterThan(100);
    expect(blocks.some((b) => b.key === 'azurerm_consumption_budget_subscription')).toBe(true);
  });

  it('uses no Azure type that nobody has classified by the grant that covers it', () => {
    const unclassified = [...new Set(blocks.map((b) => b.key))]
      .filter((key) => !(key in SUBSCRIPTION_SCOPE) && !(key in OTHER_GRANT) && !IN_A_DECLARED_GROUP.has(key))
      .sort();
    expect(
      unclassified,
      'infra/ uses an Azure type this test has not classified. Decide which grant covers it with ' +
        'subscription Contributor gone: Contributor on a declared group (IN_A_DECLARED_GROUP), the custom ' +
        'role in terraform-identity-grants.json (SUBSCRIPTION_SCOPE, with the actions it needs added to the ' +
        'role), or RBAC Administrator / the owner (OTHER_GRANT). A type that acts at subscription scope ' +
        'and is classified as in-group plans cleanly and fails at apply.'
    ).toEqual([]);
  });

  it('gives the custom role every action the subscription-scope types need', () => {
    const present = [...new Set(blocks.map((b) => b.key))].filter((key) => key in SUBSCRIPTION_SCOPE);
    expect(present.sort()).toEqual(Object.keys(SUBSCRIPTION_SCOPE).sort());
    const missing = present
      .flatMap((key) => SUBSCRIPTION_SCOPE[key].map((action) => ({ key, action })))
      .filter(({ action }) => !grants.subscriptionRole.Actions.includes(action))
      .map(({ key, action }) => `${key} needs ${action}`);
    expect(missing).toEqual([]);
  });

  it('keeps budgets the only delete the custom role carries', () => {
    const deletes = grants.subscriptionRole.Actions.filter((a) => /\/delete$/i.test(a));
    expect(deletes).toEqual(['Microsoft.Consumption/budgets/delete']);
  });

  it('lets a watch scope name only a whole subscription infra/ already targets', () => {
    // The exception is exactly as wide as WATCH_SCOPES says, and no wider: a
    // group, a resource or another subscription in the same list is still
    // left in for the checks below to judge.
    expect(withoutSubscriptionWatch('["/subscriptions/${var.subscription_app}"]')).toBe('[]');
    expect(withoutSubscriptionWatch('["/subscriptions/${var.subscription_mgmt}"]')).toBe('[]');
    expect(withoutSubscriptionWatch('["/subscriptions/${var.subscription_conn}"]')).toBe(
      '["/subscriptions/${var.subscription_conn}"]'
    );
    expect(withoutSubscriptionWatch('["/subscriptions/${var.subscription_app}/resourceGroups/rg-x"]')).toBe(
      '["/subscriptions/${var.subscription_app}/resourceGroups/rg-x"]'
    );
    expect(withoutSubscriptionWatch('[azurerm_key_vault.hcw.id, "/subscriptions/${var.subscription_app}"]')).toBe(
      '[azurerm_key_vault.hcw.id]'
    );
    const watching = blocks.filter((b) => b.key === 'azurerm_monitor_activity_log_alert');
    expect(watching.every((b) => /^\s*resource_group_name\s*=\s*azurerm_resource_group\./m.test(b.body))).toBe(true);
  });

  /** Why one expression does not resolve below a declared group, or null. */
  function expressionProblem(expr) {
    if (expr in SCOPE_EXPRESSION_ALLOWLIST) return null;
    if (/^data\.azurerm_subscriptions?\b/.test(expr)) return `${expr} is the subscription itself`;
    const ref = expr.match(/^(azurerm_\w+|azapi_\w+)\.\w+(?:\[[^\]]+\])?\.(id|name)$/);
    if (!ref) return `${expr} is not a declared resource's id (resolve it, or allowlist it with a reason)`;
    const [, type, attribute] = ref;
    if (type === 'azurerm_resource_group') return null;
    if (attribute !== 'id') return `${expr} names a ${type}'s ${attribute}, not an id`;
    if (!IN_A_DECLARED_GROUP.has(type)) return `${type} is not classified as living in a declared group`;
    return null;
  }

  /** Why one attribute value does not resolve below a declared group, or []. */
  function scopeProblems(value) {
    if (/data\.azurerm_subscriptions?\b/.test(value)) return [`${value} names data.azurerm_subscription`];
    const literal = value.match(/^"(.*)"$/);
    if (!literal) {
      // A bare reference, or a list of them (`scopes`).
      return value
        .replace(/^\[|\]$/g, '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map(expressionProblem)
        .filter(Boolean);
    }
    const text = literal[1];
    if (text.startsWith('/')) {
      const group = text.match(/^\/subscriptions\/[^/]+\/resourceGroups\/([^/]+)/i)?.[1];
      const name = group?.replace(/\$\{([^}]+)\}/g, (whole, expr) => values[expr] ?? whole);
      return name && declared.includes(name) ? [] : [`literal ${text} is not inside a declared resource group`];
    }
    // "${azurerm_x.y.id}/child": the leading reference decides where it lands.
    const lead = text.match(/^\$\{([^}]+)\}/)?.[1];
    if (!lead) return [`literal "${text}" names no declared resource`];
    const problem = expressionProblem(lead.trim());
    return problem ? [problem] : [];
  }

  it('resolves every scope-bearing attribute below a declared group', () => {
    const attribute = new RegExp(`^\\s*(${SCOPE_ATTRIBUTES.join('|')})\\s*=\\s*(.+)$`, 'gm');
    const found = blocks
      .filter((b) => !(b.key in SUBSCRIPTION_SCOPE))
      .flatMap(({ key, label, body }) =>
        [...withoutComments(body).matchAll(attribute)].map((m) => ({
          where: `${key}.${label}.${m[1]}`,
          value: `${key}.${m[1]}` in WATCH_SCOPES ? withoutSubscriptionWatch(m[2].trim()) : m[2].trim(),
        }))
      );
    // Guards the guard: about 115 such attributes on 2026-10-07, 25 of them
    // role-assignment scopes.
    expect(found.length).toBeGreaterThan(100);
    expect(found.filter((f) => /^azurerm_role_assignment\.\w+\.scope$/.test(f.where)).length).toBeGreaterThanOrEqual(25);
    const problems = found.flatMap(({ where, value }) => scopeProblems(value).map((p) => `${where}: ${p}`));
    expect(
      problems,
      'A block is scoped to something that is not a declared resource group or a resource inside one. ' +
        'With subscription Contributor gone the run identity holds Contributor only on the declared groups, ' +
        'and a role assignment at subscription scope would be a widening the condition does not refuse.'
    ).toEqual([]);
  });

  it('writes no literal Azure id above a declared group, except the subscription budgets', () => {
    // A watch scope's whole-subscription items are read, not written to
    // (WATCH_SCOPES), so they are taken out before the scan; anything else on
    // the same line is still scanned.
    const watchLines = (key, text) =>
      text.replace(/^(\s*)(\w+)(\s*=\s*)(.+)$/gm, (line, indent, name, eq, value) =>
        `${key}.${name}` in WATCH_SCOPES ? `${indent}${name}${eq}${withoutSubscriptionWatch(value.trim())}` : line
      );
    const above = blocks
      .filter((b) => !(b.key in SUBSCRIPTION_SCOPE))
      .flatMap(({ key, label, body }) =>
        [...watchLines(key, withoutComments(body)).matchAll(/\/subscriptions\/[^"\s]*/g)]
          .map((m) => m[0])
          .filter((id) => {
            const group = id.match(/\/resourceGroups\/([^/"]+)/i)?.[1];
            if (!group) return true;
            const name = group.replace(/\$\{([^}]+)\}/g, (whole, expr) => values[expr] ?? whole);
            return !declared.includes(name);
          })
          .map((id) => `${key}.${label}: ${id}`)
      );
    expect(
      above,
      'A block builds an Azure id at subscription scope or in an undeclared group. With subscription ' +
        'Contributor gone, only the custom role reaches the subscription; classify the type there.'
    ).toEqual([]);
  });

  it('is what the bootstrap removes only after reading every narrow grant back', () => {
    expect(bootstrapScript).toMatch(/\[switch\] \$RemoveSubscriptionContributor/);
    // RBAC Administrator stays at subscription scope on both sides of the
    // switch: its */read is what covers the reads above a group.
    expect(bootstrapScript).toMatch(
      /\$narrowSubscriptionRoles = @\('Role Based Access Control Administrator', \$scopeRoleName\)/
    );
    // A plain run still grants subscription Contributor: step one, and the rollback.
    expect(bootstrapScript).toMatch(
      /\$subscriptionRoles = if \(\$RemoveSubscriptionContributor\) \{\s*\$narrowSubscriptionRoles\s*\} else \{\s*@\('Contributor'\) \+ \$narrowSubscriptionRoles\s*\}/
    );
    const refuse = bootstrapScript.indexOf('if ($missing.Count -gt 0) {');
    const remove = bootstrapScript.indexOf("Invoke-Az @('role', 'assignment', 'delete', '--ids', $item.Id)");
    expect(refuse).toBeGreaterThan(0);
    expect(remove).toBeGreaterThan(refuse);
    expect(bootstrapScript).toMatch(
      /ShouldProcess\([^\n]*'remove Contributor at subscription scope'\)\) \{\s*Invoke-Az @\('role', 'assignment', 'delete'/
    );
    // The read-back after the deletes looks for Contributor AT SUBSCRIPTION
    // SCOPE on every target, not for the deleted ids: a Contributor granted
    // again under a new id (a concurrent plain run) must still stop it
    // (review of #996).
    const readBack = bootstrapScript.indexOf(
      "$rows = @(@($after) | Where-Object { $_ -and $_.scope -eq $scope -and $_.roleDefinitionName -eq 'Contributor' })"
    );
    expect(readBack).toBeGreaterThan(remove);
    expect(bootstrapScript).not.toContain('$_.id -eq $item.Id');
    expect(bootstrapScript).toContain('Contributor at subscription scope removed');
    expect(bootstrapScript).toContain('Would remove Contributor at subscription scope on');
  });
});
