/**
 * The expected-plan checker, and the addresses it checks (T-724).
 *
 * Two different things are asserted here and both matter.
 *
 * The first is that the checker classifies a plan correctly — an expected
 * permanent diff passes, real drift hiding beside it does not. That is what
 * turns "a comment says a plan of this shape means no drift" into something a
 * machine decides.
 *
 * The second is that `EXPECTED` still names resources that exist in
 * `infra/main.tf`. A checker whose expectations have drifted from the
 * configuration is worse than none: it would wave through the very plan it was
 * written to catch, and do it with a reassuring green line.
 *
 * Since #719 a third: that an update is compared on every attribute, not only
 * `app_settings`, against a plan-JSON fixture. A change is named by its path
 * with both values, a sensitive value never appears in the output, and an
 * intended change passes only when it is declared.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  attributeChanges,
  checkPlan,
  classify,
  CONDITIONAL_REPLACED,
  declarationLines,
  DECLARED,
  EXPECTED,
  formatPath,
  OVERDUE_LAST_DUE,
  OVERDUE_LAST_DUE_BIN_AT,
  overdueQuery,
  redact,
  SSH_LOGIN_ALERT_DESCRIPTION,
  sshLoginAlertQuery,
  secretsOf,
} from './assert-expected-plan.mjs';
// The module-reading helper moved to its own file when a second check needed
// it (terraform-role-definitions.test.mjs). Same eight lines, one copy.
import { terraformSource } from './terraform-source.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FUNCTION_APP = 'azurerm_function_app_flex_consumption.hcw';

/**
 * A fresh copy of `fixtures/plan-permanent-diff.json`, and its Function App
 * change, for one test to mutate.
 *
 * The fixture is the known permanent diff in `terraform show -json` form: the
 * three azapi replacements, the Function App update that changes only
 * RUNTIME_CONFIG_WRITER, and a no-op. It is NOT a copy of a live hcw-azure
 * plan. That JSON carries the estate's sensitive values in plaintext and needs
 * a workspace-admin token to read. Two things keep it honest instead. Its
 * attribute names are held to `infra/` by "the fixture" tests below. Its
 * marker trees (`after_unknown`, `before_sensitive`, `after_sensitive`) follow
 * the shape a real Terraform 1.15.8 plan produced on 2026-09-27: `{}` and
 * `[false]` where nothing is marked, `true` where something is, and unknown
 * values omitted from `after`.
 */
function fixture() {
  const plan = JSON.parse(readFileSync(join(HERE, 'fixtures', 'plan-permanent-diff.json'), 'utf8'));
  const app = plan.resource_changes.find((c) => c.address === FUNCTION_APP).change;
  return { plan, app };
}

/** The #718 change, declared the way a pull request would declare it. */
const RUNTIME_22_TO_24 = Object.freeze({
  address: FUNCTION_APP,
  path: 'runtime_version',
  before: '22',
  after: '24',
  reason: '#718: Node.js 24 on Flex Consumption',
});

/** A plan carrying exactly the known permanent diff. */
const expectedPlan = () => ({
  resource_changes: [
    ...EXPECTED.replaced.map((address) => ({
      address,
      change: { actions: ['delete', 'create'] },
    })),
    {
      address: EXPECTED.updated[0].address,
      change: {
        actions: ['update'],
        before: { app_settings: { RUNTIME_CONFIG_WRITER: 'azapi-strip', OTHER: 'same' } },
        after: { app_settings: { RUNTIME_CONFIG_WRITER: 'azurerm', OTHER: 'same' } },
        // Every real update carries these, and since #719 one without them is
        // refused rather than printed.
        after_unknown: {},
        before_sensitive: {},
        after_sensitive: {},
      },
    },
  ],
});

describe('classify', () => {
  it('reads Terraform action lists', () => {
    expect(classify(['delete', 'create'])).toBe('replace');
    expect(classify(['create', 'delete'])).toBe('replace');
    expect(classify(['create'])).toBe('create');
    expect(classify(['delete'])).toBe('delete');
    expect(classify(['update'])).toBe('update');
    expect(classify(['no-op'])).toBe('no-op');
    expect(classify([])).toBe('no-op');
    expect(classify()).toBe('no-op');
  });
});

describe('checkPlan', () => {
  it('accepts exactly the permanent diff', () => {
    expect(checkPlan(expectedPlan())).toMatchObject({ ok: true, unexpected: [], missing: [] });
  });

  it('ignores no-op entries', () => {
    const plan = expectedPlan();
    plan.resource_changes.push({
      address: 'azurerm_key_vault.hcw',
      change: { actions: ['no-op'] },
    });
    expect(checkPlan(plan).ok).toBe(true);
  });

  it('catches a destroy hiding beside the expected three', () => {
    // THE failure this exists for. Three destroys look like three destroys on
    // a summary line, and T-708 is what makes the consequence data loss.
    const plan = expectedPlan();
    plan.resource_changes.push({
      address: 'azurerm_cosmosdb_sql_container.hcw["content"]',
      change: { actions: ['delete', 'create'] },
    });
    const result = checkPlan(plan);
    expect(result.ok).toBe(false);
    expect(result.unexpected).toEqual([
      'azurerm_cosmosdb_sql_container.hcw["content"]: replace',
    ]);
  });

  it('catches a second attribute changing on the function app', () => {
    // The subtler one: the address IS expected to update, so an address-only
    // check would pass this. A settings change riding along with the marker is
    // drift.
    const plan = expectedPlan();
    plan.resource_changes[3].change.after.app_settings.OTHER = 'changed';
    const result = checkPlan(plan, { declared: [] });
    expect(result.ok).toBe(false);
    // Named by path since #719; an app setting's value is never printed,
    // because the report is public. The marker beside it is still tolerated,
    // so it is the only line.
    expect(result.unexpected).toEqual([
      'azurerm_function_app_flex_consumption.hcw: update app_settings.OTHER: (set) -> (set)',
    ]);
  });

  it('catches a plain create or delete', () => {
    for (const actions of [['create'], ['delete']]) {
      const plan = expectedPlan();
      plan.resource_changes.push({ address: 'azurerm_storage_account.new', change: { actions } });
      expect(checkPlan(plan).ok).toBe(false);
    }
  });

  it('reports an expected change that has stopped appearing', () => {
    // If the strip stops running, AzureWebJobsStorage comes back — the one
    // thing the pair exists to prevent (T-511). Silence is not success.
    const plan = expectedPlan();
    plan.resource_changes = plan.resource_changes.filter(
      (c) => c.address !== 'azapi_update_resource.function_app_settings_without_webjobs_storage'
    );
    const result = checkPlan(plan);
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual([
      'azapi_update_resource.function_app_settings_without_webjobs_storage',
    ]);
  });

  it('accepts a genuinely empty plan, with or without the key', () => {
    // What a plan should look like the day #29149 closes and the pair is
    // deleted along with EXPECTED.
    for (const plan of [{}, { resource_changes: [] }]) {
      const result = checkPlan(plan);
      expect(result.unexpected).toEqual([]);
      // `missing` is populated, correctly: with the pair still in main.tf, an
      // empty plan means the workaround is not running.
      expect(result.missing).toEqual(EXPECTED.replaced);
    }
  });

  it('throws on something that is not a plan', () => {
    // Distinguished from "unexpected changes" by the caller, which exits 2
    // rather than 1: "I could not read the plan" and "the plan is wrong" call
    // for different responses.
    expect(() => checkPlan(null)).toThrow();
    expect(() => checkPlan({ resource_changes: 'nope' })).toThrow();
  });
});

describe('EXPECTED matches the configuration', () => {
  const infraSource = terraformSource();

  it('names every azapi action and update resource declared in infra/*.tf, and only those', () => {
    // Both directions. A resource added to the module but not here would have
    // its permanent replacement reported as drift, training operators to ignore
    // this tool; one removed from the module but left here would be reported
    // missing forever, with the same result.
    //
    // Reads the WHOLE module, not main.tf: until 2026-08-29 an azapi resource
    // in any other .tf file was invisible here, so "and only those" was only
    // ever true of one file.
    //
    // The two PATCH types, not every azapi resource. azapi_resource_action and
    // azapi_update_resource are what the #29149 workaround uses, and each is
    // recreated by replace_triggered_by on every apply. An azapi_resource is an
    // ordinary managed resource that plans nothing once it exists: since #726
    // one holds the lab Vault's seal key (lab-hybrid.tf), which Resource
    // Manager can create and azurerm cannot. The test below keeps that
    // distinction honest from the other side.
    //
    // Since #816 the module also holds azapi update resources that are
    // replaced only when the resource they correct changes. They are listed
    // apart (CONDITIONAL_REPLACED), so between them the two lists still name
    // every one exactly once.
    const declared = [
      ...infraSource.matchAll(/^resource "(azapi_resource_action|azapi_update_resource)" "([a-z0-9_]+)"/gm),
    ].map((m) => `${m[1]}.${m[2]}`);
    expect(declared.length).toBeGreaterThan(0);
    expect([...EXPECTED.replaced, ...CONDITIONAL_REPLACED].sort()).toEqual([...declared].sort());
    expect(EXPECTED.replaced.filter((a) => CONDITIONAL_REPLACED.includes(a))).toEqual([]);
  });

  it('declares no azapi_resource that is replaced on every apply', () => {
    // The other half of the split above. An azapi_resource with
    // replace_triggered_by would be a per-apply replacement the list above
    // cannot see. Each azapi_resource block is read up to the next top-level
    // block and must not carry one.
    const blocks = [...infraSource.matchAll(/^resource "azapi_resource" "([a-z0-9_]+)" \{[\s\S]*?^\}/gm)];
    expect(blocks.map((m) => m[1])).toContain('lab_hybrid_vault_seal_key');
    for (const [block, name] of blocks) {
      expect(block, `azapi_resource.${name}`).not.toMatch(/replace_triggered_by/);
    }
  });

  it('names a resource and an app setting that exist', () => {
    const { address, attribute } = EXPECTED.updated[0];
    const [type, name] = address.split('.');
    expect(infraSource).toContain(`resource "${type}" "${name}"`);
    expect(infraSource).toContain(`"${attribute}"`);
  });
});

describe('every attribute of an update is compared, not only app_settings (#719)', () => {
  const unexpected = (plan, declared = []) => checkPlan(plan, { declared }).unexpected;

  it('an app_settings-only per-apply change still passes', () => {
    // The permanent diff itself. Its one difference is the marker, which is
    // tolerated whatever its values, exactly as before #719.
    const { plan, app } = fixture();
    expect(attributeChanges(app).map((d) => d.path)).toEqual(['app_settings.RUNTIME_CONFIG_WRITER']);
    expect(checkPlan(plan, { declared: [] })).toEqual({
      ok: true,
      unexpected: [],
      missing: [],
      declared: [],
      unused: [],
    });
  });

  it('fails a runtime_version change nobody declared, naming it and both values', () => {
    // #718's plan. The app_settings-only check passed this without reading it.
    const { plan, app } = fixture();
    app.before.runtime_version = '22';
    const result = checkPlan(plan, { declared: [] });
    expect(result.ok).toBe(false);
    expect(result.unexpected).toEqual([`${FUNCTION_APP}: update runtime_version: "22" -> "24"`]);
  });

  it('passes a runtime_version change the pull request declared', () => {
    const { plan, app } = fixture();
    app.before.runtime_version = '22';
    const result = checkPlan(plan, { declared: [RUNTIME_22_TO_24] });
    expect(result).toEqual({
      ok: true,
      unexpected: [],
      missing: [],
      declared: [RUNTIME_22_TO_24],
      unused: [],
    });
    expect(declarationLines(result)).toEqual([
      `DECLARED    ${FUNCTION_APP} runtime_version: "22" -> "24" (#718: Node.js 24 on Flex Consumption)`,
    ]);
  });

  it('holds a declaration to its values and its address, so a stale one passes nothing else', () => {
    // A rollback of the declared bump is a different change and fails.
    const rollback = fixture();
    rollback.app.after.runtime_version = '22';
    const result = checkPlan(rollback.plan, { declared: [RUNTIME_22_TO_24] });
    expect(result.unexpected).toEqual([`${FUNCTION_APP}: update runtime_version: "24" -> "22"`]);
    expect(result.unused).toEqual([RUNTIME_22_TO_24]);

    // The same path and values on another address do not match it either.
    const elsewhere = fixture();
    elsewhere.app.before.runtime_version = '22';
    const other = { ...RUNTIME_22_TO_24, address: 'azurerm_linux_function_app.other' };
    expect(unexpected(elsewhere.plan, [other])).toEqual([
      `${FUNCTION_APP}: update runtime_version: "22" -> "24"`,
    ]);
  });

  it('reports a declaration the plan does not contain, without failing', () => {
    // After the apply the declared change is gone from every plan. That is
    // the prompt to delete the entry, not drift.
    const { plan } = fixture();
    const result = checkPlan(plan, { declared: [RUNTIME_22_TO_24] });
    expect(result.ok).toBe(true);
    expect(result.unused).toEqual([RUNTIME_22_TO_24]);
    expect(declarationLines(result)).toEqual([
      `NOTE        declared, not in this plan: ${FUNCTION_APP} runtime_version: "22" -> "24" ` +
        '(#718: Node.js 24 on Flex Consumption). Once it has applied, delete it from DECLARED in ' +
        'scripts/assert-expected-plan.mjs.',
    ]);
  });

  it('uses the shipped DECLARED when none is passed', () => {
    const { plan } = fixture();
    expect(checkPlan(plan).unused).toEqual(DECLARED);
  });

  it('fails a sensitive attribute change without printing either value', () => {
    const { plan, app } = fixture();
    const before = app.before.site_config[0].application_insights_connection_string;
    const after = before.replace(/a{8}-a{4}-a{4}-a{4}-a{12}/, '11111111-1111-1111-1111-111111111111');
    expect(after).not.toBe(before);
    app.after.site_config[0].application_insights_connection_string = after;

    const result = checkPlan(plan, { declared: [] });
    expect(result.unexpected).toEqual([
      `${FUNCTION_APP}: update site_config[0].application_insights_connection_string: (sensitive) -> (sensitive)`,
    ]);
    const printed = JSON.stringify(result);
    expect(printed).not.toContain(before);
    expect(printed).not.toContain('11111111');
  });

  it('will not match a declaration for a sensitive change, even with the right values', () => {
    // Declaring it would mean writing the value into this repository.
    const { plan, app } = fixture();
    const before = app.before.site_config[0].application_insights_key;
    app.after.site_config[0].application_insights_key = '11111111-1111-1111-1111-111111111111';
    const declaration = {
      address: FUNCTION_APP,
      path: 'site_config[0].application_insights_key',
      before,
      after: '11111111-1111-1111-1111-111111111111',
      reason: 'test',
    };
    const result = checkPlan(plan, { declared: [declaration] });
    expect(result.ok).toBe(false);
    expect(result.unused).toEqual([declaration]);
  });

  it('masks a whole sensitive block, keys and all', () => {
    // site_credential is sensitive as a block, so its field names are not
    // printed either. Terraform's renderer does the same.
    const { plan, app } = fixture();
    app.after.site_credential = [{ name: '$func-site-prod-cus-01', password: 'bbbb' }];
    const lines = unexpected(plan);
    expect(lines).toEqual([`${FUNCTION_APP}: update site_credential: (sensitive) -> (sensitive)`]);
    expect(lines.join('\n')).not.toContain('password');
    expect(lines.join('\n')).not.toContain('bbbb');
  });

  it('prints a value known only after apply as such', () => {
    // Terraform omits an unknown value from `after` and marks it in
    // after_unknown, so there is nothing to print but the fact.
    // The subscription id inside it is masked too: the report is public.
    const { plan, app } = fixture();
    delete app.after.virtual_network_subnet_id;
    app.after_unknown.virtual_network_subnet_id = true;
    expect(unexpected(plan)).toEqual([
      `${FUNCTION_APP}: update virtual_network_subnet_id: "/subscriptions/<guid>/resourceGroups/` +
        'rg-net-site-prod-cus/providers/Microsoft.Network/virtualNetworks/vnet-site-prod-cus/' +
        'subnets/snet-functions-integration" -> (known after apply)',
    ]);
  });

  it('prints neither value of an unknown block with a sensitive value beneath it', () => {
    const { plan, app } = fixture();
    delete app.after.site_config;
    app.after_unknown.site_config = true;
    const lines = unexpected(plan);
    expect(lines).toEqual([`${FUNCTION_APP}: update site_config: (sensitive) -> (known after apply)`]);
    expect(lines.join('\n')).not.toContain('InstrumentationKey');
  });

  it('prints a list or object about to be recomputed by its size, not its contents', () => {
    // The shape Terraform 1.15.8 produced for terraform_data on 2026-09-27: a
    // sensitive input copied into the computed `output`, and left unmarked in
    // before_sensitive. Terraform's own renderer printed the secret.
    const { plan } = fixture();
    plan.resource_changes.push({
      address: 'terraform_data.example',
      change: {
        actions: ['update'],
        before: { id: 'x', output: { SECRET: 'aaaa', runtime_version: '22' }, list: ['aaaa'] },
        after: { id: 'x' },
        after_unknown: { output: true, list: true },
        before_sensitive: { output: {}, list: [false] },
        after_sensitive: {},
      },
    });
    const lines = unexpected(plan);
    expect(lines).toEqual([
      'terraform_data.example: update list: (a list of 1 item) -> (known after apply)',
      'terraform_data.example: update output: (an object with 2 keys) -> (known after apply)',
    ]);
    expect(lines.join('\n')).not.toContain('aaaa');
  });

  it('names attributes inside nested blocks by their path', () => {
    const { plan, app } = fixture();
    const site = app.after.site_config[0];
    site.http2_enabled = false;
    site.cors[0].allowed_origins.push('https://example.com');
    site.ip_restriction.push({ action: 'Allow', ip_address: '203.0.113.0/24', priority: 100 });
    expect(unexpected(plan)).toEqual([
      `${FUNCTION_APP}: update site_config[0].cors[0].allowed_origins[3]: (absent) -> "https://example.com"`,
      `${FUNCTION_APP}: update site_config[0].http2_enabled: true -> false`,
      `${FUNCTION_APP}: update site_config[0].ip_restriction[0]: (absent) -> ` +
        '{"action":"Allow","ip_address":"203.0.113.0/24","priority":100}',
    ]);
  });

  it('matches a declaration by the path it prints, nested blocks included', () => {
    const { plan, app } = fixture();
    app.after.site_config[0].http2_enabled = false;
    const declaration = {
      address: FUNCTION_APP,
      path: 'site_config[0].http2_enabled',
      before: true,
      after: false,
      reason: 'test',
    };
    expect(checkPlan(plan, { declared: [declaration] })).toMatchObject({
      ok: true,
      declared: [declaration],
    });
  });

  it('quotes an app setting whose name holds a dot', () => {
    // AzureWebJobs.<function>.Disabled is the platform's own naming. Printed
    // bare, it would read as three levels.
    const { plan, app } = fixture();
    app.after.app_settings['AzureWebJobs.syncContent.Disabled'] = 'true';
    expect(unexpected(plan)).toEqual([
      `${FUNCTION_APP}: update app_settings["AzureWebJobs.syncContent.Disabled"]: (absent) -> (set)`,
    ]);
  });

  it('names each attribute issue #719 listed, and passes none of them', () => {
    const { plan, app } = fixture();
    Object.assign(app.after, {
      instance_memory_in_mb: 4096,
      maximum_instance_count: 100,
      https_only: false,
      virtual_network_subnet_id: null,
      storage_authentication_type: 'StorageAccountConnectionString',
    });
    expect(unexpected(plan).map((line) => line.split(': ')[1])).toEqual([
      'update https_only',
      'update instance_memory_in_mb',
      'update maximum_instance_count',
      'update storage_authentication_type',
      'update virtual_network_subnet_id',
    ]);
  });

  it('does not pass an update in which nothing visibly differs', () => {
    // Terraform planned a change this checker cannot see. That is not
    // evidence of a harmless one.
    const { plan, app } = fixture();
    app.after.app_settings.RUNTIME_CONFIG_WRITER = app.before.app_settings.RUNTIME_CONFIG_WRITER;
    expect(unexpected(plan)).toEqual([
      `${FUNCTION_APP}: update, but no attribute differs between before and after. Read this change in the plan.`,
    ]);
  });

  it('compares an update to any other resource the same way', () => {
    const { plan } = fixture();
    plan.resource_changes.push({
      address: 'azurerm_storage_account.content',
      change: {
        actions: ['update'],
        before: { min_tls_version: 'TLS1_2' },
        after: { min_tls_version: 'TLS1_0' },
        after_unknown: {},
        before_sensitive: {},
        after_sensitive: {},
      },
    });
    expect(unexpected(plan)).toEqual([
      'azurerm_storage_account.content: update min_tls_version: "TLS1_2" -> "TLS1_0"',
    ]);
  });
});

describe('formatPath', () => {
  it('writes a path the way Terraform does', () => {
    expect(formatPath(['runtime_version'])).toBe('runtime_version');
    expect(formatPath(['site_config', 0, 'cors', 0, 'allowed_origins', 2])).toBe(
      'site_config[0].cors[0].allowed_origins[2]'
    );
    expect(formatPath(['app_settings', 'RUNTIME_CONFIG_WRITER'])).toBe(
      'app_settings.RUNTIME_CONFIG_WRITER'
    );
    expect(formatPath(['app_settings', 'AzureWebJobs.x.Disabled'])).toBe(
      'app_settings["AzureWebJobs.x.Disabled"]'
    );
    expect(formatPath([])).toBe('(the whole resource)');
  });
});

/** An update to a resource outside the fixture, with every marker present. */
const update = (address, change) => ({
  address,
  change: {
    actions: ['update'],
    after_unknown: {},
    before_sensitive: {},
    after_sensitive: {},
    ...change,
  },
});

describe('the report is public, so values the plan protects stay unprinted (#719 review)', () => {
  // This repository is public and the verdict goes to a job summary. The
  // security review of the first #719 commit found each case below printing a
  // value that HCP Terraform keeps behind workspace access.
  const unexpected = (plan) => checkPlan(plan, { declared: [] }).unexpected;

  it('never prints an app setting value, such as a literal written on the live app', () => {
    const { plan, app } = fixture();
    app.before.app_settings.OPENAI_API_KEY = 'literal-value-aaaaaaaa';
    const lines = unexpected(plan);
    expect(lines).toEqual([`${FUNCTION_APP}: update app_settings.OPENAI_API_KEY: (set) -> (absent)`]);
    expect(lines.join('\n')).not.toContain('literal-value');
  });

  it('prints a recomputed app_settings map by its size', () => {
    const { plan, app } = fixture();
    delete app.after.app_settings;
    app.after_unknown.app_settings = true;
    expect(unexpected(plan)).toEqual([
      `${FUNCTION_APP}: update app_settings: (an object with 6 keys) -> (known after apply)`,
    ]);
  });

  it('masks a sensitive string copied into an attribute Terraform left unmarked', () => {
    // The scalar form of the terraform_data case: `input` is marked, and its
    // computed copy `output` is not.
    const { plan } = fixture();
    plan.resource_changes.push(
      update('terraform_data.recomputed', {
        before: { id: 'x', input: 'copied-secret-aaaa', output: 'copied-secret-aaaa' },
        after: { id: 'x', input: 'copied-secret-bbbb' },
        after_unknown: { output: true },
        before_sensitive: { input: true },
        after_sensitive: { input: true },
      }),
      update('terraform_data.known', {
        before: { id: 'y', input: 'copied-secret-cccc', output: 'copied-secret-cccc' },
        after: { id: 'y', input: 'copied-secret-dddd', output: 'copied-secret-dddd' },
        before_sensitive: { input: true },
        after_sensitive: { input: true },
      })
    );
    const lines = unexpected(plan);
    expect(lines).toEqual([
      'terraform_data.recomputed: update input: (sensitive) -> (sensitive)',
      'terraform_data.recomputed: update output: "(sensitive)" -> (known after apply)',
      'terraform_data.known: update input: (sensitive) -> (sensitive)',
      'terraform_data.known: update output: "(sensitive)" -> "(sensitive)"',
    ]);
    expect(lines.join('\n')).not.toContain('copied-secret');
  });

  it('masks a sensitive variable value wherever it appears in a printed value', () => {
    const { plan } = fixture();
    plan.variables = { token: { value: 'variable-secret-aaaa' }, region: { value: 'centralus' } };
    plan.configuration = { root_module: { variables: { token: { sensitive: true }, region: {} } } };
    plan.resource_changes.push(
      update('azurerm_monitor_action_group.webhook', {
        before: { uri: 'https://hooks.example.com/old', location: 'eastus' },
        after: { uri: 'https://hooks.example.com/variable-secret-aaaa', location: 'centralus' },
      })
    );
    expect(unexpected(plan)).toEqual([
      'azurerm_monitor_action_group.webhook: update location: "eastus" -> "centralus"',
      'azurerm_monitor_action_group.webhook: update uri: "https://hooks.example.com/old" -> ' +
        '"https://hooks.example.com/(sensitive)"',
    ]);
  });

  it('masks GUIDs and email addresses, and nothing else of the value', () => {
    const { plan } = fixture();
    plan.resource_changes.push(
      update('azurerm_monitor_action_group.owner', {
        before: { email: 'someone@example.com', principal_id: '11111111-2222-3333-4444-555555555555' },
        after: { email: 'another@example.org', principal_id: '66666666-7777-8888-9999-aaaaaaaaaaaa' },
      })
    );
    expect(unexpected(plan)).toEqual([
      'azurerm_monitor_action_group.owner: update email: "<email>" -> "<email>"',
      'azurerm_monitor_action_group.owner: update principal_id: "<guid>" -> "<guid>"',
    ]);
  });

  it('reads a malformed marker as set, so it masks rather than reveals', () => {
    const { plan } = fixture();
    plan.resource_changes.push(
      update('azurerm_application_insights.malformed', {
        before: { key: 'marker-value-aaaa' },
        after: { key: 'marker-value-bbbb' },
        before_sensitive: { key: 'true' },
        after_sensitive: { key: 1 },
      })
    );
    const lines = unexpected(plan);
    expect(lines).toEqual(['azurerm_application_insights.malformed: update key: (sensitive) -> (sensitive)']);
    expect(lines.join('\n')).not.toContain('marker-value');
  });

  it('refuses an update without its markers, rather than guess which values are secret', () => {
    // checkPlan throws, which the entry points turn into exit 2.
    const { plan } = fixture();
    plan.resource_changes.push({
      address: 'azurerm_application_insights.bare',
      change: { actions: ['update'], before: { key: 'bare-aaaa' }, after: { key: 'bare-bbbb' } },
    });
    expect(() => checkPlan(plan, { declared: [] })).toThrow(
      /azurerm_application_insights.bare: update has no after_unknown, before_sensitive, after_sensitive/
    );
  });

  it('sees a map key named __proto__', () => {
    // Read from the side that lacks it, `__proto__` is Object.prototype, which
    // walked as an empty object and hid the key.
    const { plan, app } = fixture();
    app.after.tags = JSON.parse('{"environment":"prod","workload":"site","__proto__":{}}');
    expect(unexpected(plan)).toEqual([
      `${FUNCTION_APP}: update tags.__proto__: (absent) -> {}`,
    ]);
  });

  it('collects sensitive strings from resources, outputs and variables, longest first', () => {
    const plan = {
      resource_changes: [
        {
          change: {
            before: { a: 'resource-secret', b: 'plain-value' },
            after: { a: ['listed-secret-value'] },
            before_sensitive: { a: true },
            after_sensitive: { a: [true] },
          },
        },
      ],
      output_changes: {
        out: { before: 'output-secret', after: 'short', before_sensitive: true, after_sensitive: true },
      },
      variables: { v: { value: { nested: 'variable-secret' } }, w: { value: 'not-sensitive' } },
      configuration: { root_module: { variables: { v: { sensitive: true }, w: {} } } },
    };
    // 'short' is under six characters: common short values are not redacted.
    expect(secretsOf(plan)).toEqual([
      'listed-secret-value',
      'resource-secret',
      'variable-secret',
      'output-secret',
    ]);
  });

  it('redacts a secret in its JSON-escaped form too', () => {
    const secret = 'quote"secret';
    expect(redact(JSON.stringify({ v: secret }), [secret])).toBe('{"v":"(sensitive)"}');
  });
});

describe('every change is read, not only the ones classify names (#719 review)', () => {
  const unexpected = (plan) => checkPlan(plan, { declared: [] }).unexpected;

  it('reports an action it does not recognise instead of reading it as a no-op', () => {
    // `forget` is what a `removed` block plans. It dropped a resource from
    // state and passed silently.
    const { plan } = fixture();
    plan.resource_changes.push({
      address: 'azurerm_cosmosdb_sql_container.hcw["content"]',
      change: { actions: ['forget'] },
    });
    expect(unexpected(plan)).toEqual([
      'azurerm_cosmosdb_sql_container.hcw["content"]: actions ["forget"], which this checker does not recognise',
    ]);
  });

  it('reports an import and a move, even when the action is a no-op', () => {
    const { plan } = fixture();
    plan.resource_changes.push(
      { address: 'azurerm_key_vault.imported', change: { actions: ['no-op'], importing: { id: 'x' } } },
      {
        address: 'azurerm_key_vault.renamed',
        previous_address: 'azurerm_key_vault.old',
        change: { actions: ['no-op'] },
      }
    );
    expect(unexpected(plan)).toEqual([
      'azurerm_key_vault.imported: import',
      'azurerm_key_vault.renamed: moved from azurerm_key_vault.old',
    ]);
  });

  it('keeps a data source read quiet', () => {
    const { plan } = fixture();
    plan.resource_changes.push({ address: 'data.azurerm_client_config.current', change: { actions: ['read'] } });
    expect(checkPlan(plan, { declared: [] }).ok).toBe(true);
  });

  it('refuses a change with no action list', () => {
    for (const change of [{ address: 'azurerm_key_vault.a' }, { address: 'azurerm_key_vault.b', change: {} }]) {
      const { plan } = fixture();
      plan.resource_changes.push(change);
      expect(() => checkPlan(plan, { declared: [] })).toThrow(/has no change.actions list/);
    }
  });
});

describe('the command line never prints a sensitive value', () => {
  // End to end, because main() is what reaches the job summary, and the tests
  // above see only checkPlan's return value.
  function run(plan) {
    const dir = mkdtempSync(join(tmpdir(), 'assert-expected-plan-'));
    try {
      const file = join(dir, 'plan.json');
      writeFileSync(file, JSON.stringify(plan));
      try {
        const stdout = execFileSync(process.execPath, [join(HERE, 'assert-expected-plan.mjs'), file], {
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 30_000,
        });
        return { code: 0, output: stdout };
      } catch (err) {
        return { code: err.status, output: `${err.stdout ?? ''}${err.stderr ?? ''}` };
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('exits 0 on the permanent diff', () => {
    const got = run(fixture().plan);
    expect(got.code).toBe(0);
    expect(got.output).toContain('plan matches the expected permanent diff');
  });

  it('exits 1 naming each path, with no sensitive value in its output', () => {
    const { plan, app } = fixture();
    app.before.runtime_version = '22';
    const key = app.before.site_config[0].application_insights_key;
    app.after.site_config[0].application_insights_key = '11111111-1111-1111-1111-111111111111';
    app.after.app_settings.OPENAI_API_KEY = 'literal-value-aaaaaaaa';

    const got = run(plan);
    expect(got.code).toBe(1);
    expect(got.output).toContain(`UNEXPECTED  ${FUNCTION_APP}: update runtime_version: "22" -> "24"`);
    expect(got.output).toContain(
      `UNEXPECTED  ${FUNCTION_APP}: update site_config[0].application_insights_key: (sensitive) -> (sensitive)`
    );
    expect(got.output).toContain(`UNEXPECTED  ${FUNCTION_APP}: update app_settings.OPENAI_API_KEY: (absent) -> (set)`);
    expect(got.output).not.toContain(key);
    expect(got.output).not.toContain('11111111');
    expect(got.output).not.toContain('literal-value');
  });

  it('exits 2 on a file that is not JSON, without quoting it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'assert-expected-plan-'));
    try {
      const file = join(dir, 'plan.json');
      writeFileSync(file, '{"variables":{"token":{"value":"unparsed-secret-aaaa"}} trailing');
      let got;
      try {
        execFileSync(process.execPath, [join(HERE, 'assert-expected-plan.mjs'), file], {
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 30_000,
        });
        got = { code: 0, output: '' };
      } catch (err) {
        got = { code: err.status, output: `${err.stdout ?? ''}${err.stderr ?? ''}` };
      }
      expect(got.code).toBe(2);
      expect(got.output).toContain('is not valid JSON');
      expect(got.output).not.toContain('unparsed-secret');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the fixture', () => {
  const infraSource = terraformSource();

  it('names Function App attributes that infra/functionapp.tf actually sets', () => {
    // A fixture calibrated against invented attribute names would pass while
    // matching nothing the repository writes.
    const { app } = fixture();
    for (const name of [
      'runtime_name',
      'runtime_version',
      'instance_memory_in_mb',
      'maximum_instance_count',
      'https_only',
      'virtual_network_subnet_id',
      'storage_container_type',
      'storage_container_endpoint',
      'storage_authentication_type',
      'webdeploy_publish_basic_authentication_enabled',
    ]) {
      expect(app.after, name).toHaveProperty(name);
      expect(infraSource, name).toMatch(new RegExp(`^\\s+${name}\\s+=`, 'm'));
    }
    for (const name of [
      'application_insights_connection_string',
      'application_insights_key',
      'http2_enabled',
      'ip_restriction_default_action',
      'scm_ip_restriction_default_action',
    ]) {
      expect(app.after.site_config[0], name).toHaveProperty(name);
      expect(infraSource, name).toMatch(new RegExp(`^\\s+${name}\\s+=`, 'm'));
    }
  });

  it('carries the markers a real plan carries on every change', () => {
    for (const { address, change } of fixture().plan.resource_changes) {
      expect(Array.isArray(change.actions), address).toBe(true);
      for (const key of ['before', 'after', 'after_unknown', 'before_sensitive', 'after_sensitive']) {
        expect(change, `${address} ${key}`).toHaveProperty(key);
      }
    }
  });
});

describe('DECLARED', () => {
  const infraSource = terraformSource();

  it('holds only complete entries, each for a resource infra/*.tf declares, or no longer declares for a delete', () => {
    // Empty is the normal state, and then this passes trivially. An entry
    // needs both values spelled out, because an omitted one matches only an
    // absent attribute, and a reason, because the next reader has to decide
    // whether it has applied.
    for (const declaration of DECLARED) {
      const label = JSON.stringify(declaration);
      expect(typeof declaration.address, label).toBe('string');
      expect(typeof declaration.reason === 'string' && declaration.reason.length > 0, label).toBe(true);
      if (declaration.action) {
        // A create or delete (#816): no path, no values, nothing else.
        expect(['create', 'delete'], label).toContain(declaration.action);
        expect(Object.keys(declaration).sort(), label).toEqual(['action', 'address', 'reason']);
      } else {
        expect(typeof declaration.path, label).toBe('string');
        expect(Object.hasOwn(declaration, 'before') && Object.hasOwn(declaration, 'after'), label).toBe(true);
      }
      const [type, name] = declaration.address.replace(/\[.*$/, '').split('.');
      // A declared delete is the removal of a whole resource (#816), so its
      // block must be gone; every other entry must name a block that exists.
      if (declaration.action === 'delete' && !/\[.*\]$/.test(declaration.address)) {
        expect(infraSource, label).not.toContain(`resource "${type}" "${name}"`);
      } else {
        expect(infraSource, label).toContain(`resource "${type}" "${name}"`);
      }
    }
  });

  /** `local.timer_schedules` in the tree, as `[name, period, anchor]` rows. */
  const treeTimerRows = () => {
    const block = /^\s*timer_schedules\s*=\s*\{\n([\s\S]*?)\n\s*\}\n/m.exec(infraSource);
    expect(block, 'local.timer_schedules not found').not.toBeNull();
    return [
      ...block[1].matchAll(/^\s*(\w+)\s*=\s*\{\s*period\s*=\s*"([^"]+)",\s*anchor\s*=\s*"([^"]+)"\s*\}/gm),
    ].map((m) => [m[1], m[2], m[3]]);
  };

  it('renders alert-timer-overdue’s query exactly as the heredoc in infra/ does (#964)', () => {
    // overdueQuery() keeps its own copy of the query around the rows, so a
    // change to the heredoc that does not move the copy would leave every
    // declaration of this rule matching a query Terraform never renders.
    // `<<-` strips the smallest indent and keeps the newline before the
    // marker; the rows are interpolated after the strip, keeping their own
    // two spaces, in Terraform's map order, which sorts the names.
    const heredoc =
      /resource "azurerm_monitor_scheduled_query_rules_alert_v2" "timer_overdue" \{[\s\S]*?query\s*=\s*<<-KQL\n([\s\S]*?)\n[ \t]*KQL\n/.exec(
        infraSource
      );
    expect(heredoc, 'timer_overdue query heredoc not found').not.toBeNull();
    const lines = heredoc[1].split('\n');
    const indent = Math.min(...lines.filter((line) => line.trim()).map((line) => /^ */.exec(line)[0].length));
    const rows = treeTimerRows()
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([name, period, anchor]) => `  "${name}", ${period}, datetime(${anchor})`)
      .join(',\n');
    const rendered = `${lines.map((line) => line.slice(indent)).join('\n')}\n`.replace('${local.timer_schedule_rows}', rows);
    expect(overdueQuery(treeTimerRows())).toBe(rendered);
    expect(rendered).toContain(OVERDUE_LAST_DUE);
    expect(rendered).not.toContain('bin_at(');
  });

  it('declares alert-timer-overdue’s query for the timer map in the tree, if it declares it at all (#1302, #1009, #964)', () => {
    const declaration = DECLARED.find(
      (entry) =>
        entry.address === 'azurerm_monitor_scheduled_query_rules_alert_v2.timer_overdue' &&
        entry.path === 'criteria[0].query'
    );
    if (!declaration) return;
    const rows = treeTimerRows();
    expect(rows.length).toBeGreaterThan(20);
    expect(declaration.after).toBe(overdueQuery(rows));
    // Each declaration of this rule states its own shape. #964's changed the
    // due-time line alone; #1302's, like #1009's, is one row more: `before`
    // is the tree's rows without ambassadorAudienceMonthly, and the only line
    // the update adds is that timer's row. Neither value carries the bin_at()
    // line Kusto refuses (#964), applied away on 2026-10-15.
    expect(declaration.before).toBe(overdueQuery(rows.filter(([name]) => !['ambassadorAudienceMonthly', 'brainIndexReconcile', 'sweepVisitorSessions'].includes(name))));
    const before = declaration.before.split('\n');
    const added = declaration.after.split('\n').filter((line) => !before.includes(line));
    expect(added).toEqual([
      '  "ambassadorAudienceMonthly", 1d, datetime(2026-01-01 06:45),',
      '  "brainIndexReconcile", 15m, datetime(2026-01-01 00:00),',
      '  "sweepVisitorSessions", 2m, datetime(2026-01-01 00:00),',
    ]);
    expect(declaration.before).not.toContain(OVERDUE_LAST_DUE_BIN_AT);
    expect(declaration.after).not.toContain(OVERDUE_LAST_DUE_BIN_AT);
  });

  /** Every declaration of alert-timer-overdue's query, in the file's order. */
  const timerRuleDeclarations = () =>
    DECLARED.filter(
      (entry) =>
        entry.address === 'azurerm_monitor_scheduled_query_rules_alert_v2.timer_overdue' &&
        entry.path === 'criteria[0].query'
    );

  it('declares the visitor-session sweep’s row for every state the timer rule can be in, each ending at the tree’s query (#1403)', () => {
    // This file cannot read what has applied, so the update is declared three
    // ways: nothing of the audience timer and private indexing applied yet, the
    // audience timer applied, or both applied. Whichever is live, the plan's
    // `after` is the tree's query, so every declaration must end there.
    const rows = treeTimerRows();
    const declarations = timerRuleDeclarations();
    expect(declarations).toHaveLength(3);
    for (const declaration of declarations) {
      expect(declaration.after).toBe(overdueQuery(rows));
    }
    const addedLines = (declaration) => {
      const before = declaration.before.split('\n');
      return declaration.after.split('\n').filter((line) => !before.includes(line));
    };
    expect(declarations.map((declaration) => addedLines(declaration).length).sort()).toEqual([1, 2, 3]);
    const sweepRow = '  "sweepVisitorSessions", 2m, datetime(2026-01-01 00:00),';
    for (const declaration of declarations) expect(addedLines(declaration)).toContain(sweepRow);
    // The tree holds the row under the registration's own schedule.
    expect(rows).toContainEqual(['sweepVisitorSessions', '2m', '2026-01-01 00:00']);
  });

  it('declares the sweep’s flag as disarmed, as armed, and as armed in one apply, naming a flag the tree catalogues (#1403)', () => {
    const flag = 'app_settings.FEATURE_FLAG_SWEEP_VISITOR_SESSIONS';
    const entries = DECLARED.filter((entry) => entry.path === flag);
    expect(entries.map((entry) => [entry.before, entry.after])).toEqual([
      [undefined, 'false'],
      ['false', 'true'],
      [undefined, 'true'],
    ]);
    for (const entry of entries) expect(entry.address).toBe(FUNCTION_APP);
    expect(infraSource).toMatch(/^\s*SWEEP_VISITOR_SESSIONS\s*=\s*"sweepVisitorSessions — /m);
  });

  it('declares the Coder broker token’s Key Vault reference exactly as infra/ writes it, and passes the plan that adds only that (#1403)', () => {
    const entry = DECLARED.find((candidate) => candidate.path === 'app_settings.CODER_BROKER_TOKEN');
    expect(entry, 'no declaration for the broker token’s app setting').toBeDefined();
    expect(entry.address).toBe(FUNCTION_APP);
    expect(entry.before).toBeUndefined();

    // The declared value is the tree's reference with the vault's address filled in:
    // the same setting, pointing at the secret that carries its name in Key Vault's spelling.
    const tree =
      /^\s*"CODER_BROKER_TOKEN"\s*=\s*"@Microsoft\.KeyVault\(SecretUri=\$\{azurerm_key_vault\.hcw\.vault_uri\}secrets\/([A-Z0-9-]+)\)"\s*$/m.exec(
        infraSource
      );
    expect(tree, 'CODER_BROKER_TOKEN is not a Key Vault reference in infra/').not.toBeNull();
    expect(tree[1]).toBe('CODER-BROKER-TOKEN');
    expect(variableDefault('key_vault_name')).toBe('"kv-site-prod-cus-01"');
    expect(entry.after).toBe(
      '@Microsoft.KeyVault(SecretUri=https://kv-site-prod-cus-01.vault.azure.net/secrets/CODER-BROKER-TOKEN)'
    );

    // The plan this pull request queues: the Function App gains that one key.
    const added = fixture();
    added.app.after.app_settings.CODER_BROKER_TOKEN = entry.after;
    expect(checkPlan(added.plan)).toMatchObject({ ok: true, unexpected: [], missing: [] });

    // The same key pointing at another secret (the status token's, say) is not what was declared.
    const wrong = fixture();
    wrong.app.after.app_settings.CODER_BROKER_TOKEN = entry.after.replace('CODER-BROKER-TOKEN', 'CODER-STATUS-TOKEN');
    const result = checkPlan(wrong.plan);
    expect(result.ok).toBe(false);
    expect(result.unexpected.some((line) => line.includes('app_settings.CODER_BROKER_TOKEN'))).toBe(true);
  });

  /** An alert-timer-overdue update as a plan carries it, from one declaration. */
  const timerRuleUpdate = (declaration) => ({
    address: declaration.address,
    change: {
      actions: ['update'],
      before: { criteria: [{ query: declaration.before }] },
      after: { criteria: [{ query: declaration.after }] },
      after_unknown: {},
      before_sensitive: {},
      after_sensitive: {},
    },
  });

  it.each([0, 1, 2])(
    'passes the plan that adds the sweep to the timer alert, with its flag disarmed, whichever of the three states the alert is in: state %i (#1403)',
    (index) => {
      // The three declarations are the three states alert-timer-overdue's query
      // can be in before this change; a plan built from any one of them is the
      // plan the owner sees, so each must pass end to end, not only look right.
      const declaration = timerRuleDeclarations()[index];
      const { plan, app } = fixture();
      app.after.app_settings.FEATURE_FLAG_SWEEP_VISITOR_SESSIONS = 'false';
      plan.resource_changes.push(timerRuleUpdate(declaration));

      const result = checkPlan(plan);

      expect(result).toMatchObject({ ok: true, unexpected: [], missing: [] });
      expect(result.declared.map((entry) => entry.reason)).toEqual(
        expect.arrayContaining(['#1403: the sweepVisitorSessions timer catalogued, disarmed until enabled_timers names it'])
      );
    }
  );

  it('passes the plan that arms the sweep: the flag false to true, or absent to true in one apply (#1403)', () => {
    // false -> true is the arming apply after the catalogue apply. It stays
    // declared until that apply has run, because the file cannot read what has applied.
    const { plan, app } = fixture();
    app.before.app_settings.FEATURE_FLAG_SWEEP_VISITOR_SESSIONS = 'false';
    app.after.app_settings.FEATURE_FLAG_SWEEP_VISITOR_SESSIONS = 'true';
    expect(checkPlan(plan)).toMatchObject({ ok: true, unexpected: [], missing: [] });

    const oneApply = fixture();
    oneApply.app.after.app_settings.FEATURE_FLAG_SWEEP_VISITOR_SESSIONS = 'true';
    oneApply.plan.resource_changes.push(timerRuleUpdate(timerRuleDeclarations()[2]));
    expect(checkPlan(oneApply.plan)).toMatchObject({ ok: true, unexpected: [], missing: [] });
  });

  it('names a second timer row, a changed schedule or any other setting riding along with the sweep’s (#1403)', () => {
    const [, , lastState] = timerRuleDeclarations();
    const { plan, app } = fixture();
    app.after.app_settings.FEATURE_FLAG_SWEEP_VISITOR_SESSIONS = 'false';
    app.after.app_settings.FEATURE_FLAG_SOMETHING_ELSE = 'false';
    // The sweep's row on another period, and one extra row.
    const wrong = { ...lastState, after: lastState.after.replace('"sweepVisitorSessions", 2m,', '"sweepVisitorSessions", 5m,') };
    plan.resource_changes.push(timerRuleUpdate(wrong));

    const result = checkPlan(plan);

    expect(result.ok).toBe(false);
    expect(result.unexpected.some((line) => line.includes('app_settings.FEATURE_FLAG_SOMETHING_ELSE'))).toBe(true);
    expect(result.unexpected.some((line) => line.includes('timer_overdue') && line.includes('criteria[0].query'))).toBe(true);
  });

  it('prunes the stateful-rule and export-latency entries once applied (#1207, #964, #970)', () => {
    // timer_overdue left this list when #1302 declared the rule again (one
    // row more, the test above); it returns once that change has applied
    // and the entry is deleted.
    const addresses = DECLARED.map((entry) => entry.address);
    for (const name of [
      'lab_hybrid_backup_missing_coder',
      'lab_hybrid_backup_missing_vault',
      'lab_hybrid_disk_used',
      'logs_daily_cap',
      'export_window_latency',
    ]) {
      expect(addresses, name).not.toContain(`azurerm_monitor_scheduled_query_rules_alert_v2.${name}`);
    }
  });

  it('prunes alert-kv-config-write’s provider entries once applied (#1216)', () => {
    const addresses = DECLARED.map((entry) => entry.address);
    expect(addresses).not.toContain('azurerm_monitor_activity_log_alert.key_vault_config_writes');
  });

  it('prunes ADDON_NETWORK_ASSESSMENT_URL and ADDON_CLOUD_ASSESSMENT_URL once applied (#1089)', () => {
    const paths = DECLARED.map((entry) => entry.path);
    expect(paths).not.toContain('app_settings.ADDON_NETWORK_ASSESSMENT_URL');
    expect(paths).not.toContain('app_settings.ADDON_CLOUD_ASSESSMENT_URL');
  });

  it('prunes ADDON_CLOUD_CRAWLER_URL once applied, and keeps it set to the lab origin in infra/ (#1357)', () => {
    expect(DECLARED.map((entry) => entry.path)).not.toContain('app_settings.ADDON_CLOUD_CRAWLER_URL');
    // The setting itself stays in infra/: only the plan check's declaration of the change is gone.
    const tree = /"ADDON_CLOUD_CRAWLER_URL"\s*=\s*"([^"]+)"/.exec(infraSource);
    expect(tree, 'ADDON_CLOUD_CRAWLER_URL is not set in infra/').not.toBeNull();
    // The origin the lab host serves it on: one label below the lab domain, exactly the id.
    expect(tree[1]).toBe('https://cloud-crawler.lab.hybridcloudworks.com');
  });

  it('only sets ADDON_*_URL names the Function App’s add-on registry reads, so a typo cannot leave a status route unconfigured (#1357)', () => {
    const registry = readFileSync(join(HERE, '..', 'functions', 'src', 'lib', 'addons', 'registry.js'), 'utf8');
    const read = new Set([...registry.matchAll(/setting:\s*'(ADDON_[A-Z_]+_URL)'/g)].map((match) => match[1]));
    const set = [...infraSource.matchAll(/^\s*"(ADDON_[A-Z_]+_URL)"\s*=/gm)].map((match) => match[1]);
    expect(set.length).toBeGreaterThanOrEqual(4);
    for (const name of set) expect(read, `${name} is not a setting the registry reads`).toContain(name);
  });

  it('prunes alert-lab-ssh-login’s create, Arc SSH’s two creates and STREAMYARD_API_KEY once applied, and keeps the unapplied probe flag (#953, #1101, #701)', () => {
    const creates = DECLARED.filter((entry) => entry.action === 'create').map((entry) => entry.address);
    const paths = DECLARED.map((entry) => entry.path);
    expect(creates).not.toContain('azurerm_monitor_scheduled_query_rules_alert_v2.lab_hybrid_ssh_login_unexpected');
    expect(creates).not.toContain('azapi_resource.lab_hybrid_arc_connectivity_endpoint[0]');
    expect(creates).not.toContain('azapi_resource.lab_hybrid_arc_ssh_service_configuration[0]');
    expect(paths).not.toContain('app_settings.STREAMYARD_API_KEY');
    // Live "false" on 2026-10-17: the arming has not applied, so it stays.
    expect(paths).toContain('app_settings.FEATURE_FLAG_PROBE_AI_PROVIDERS');
  });

  /** alert-lab-ssh-login's resource block in the tree. */
  const sshLoginRule = () => {
    const block =
      /resource "azurerm_monitor_scheduled_query_rules_alert_v2" "lab_hybrid_ssh_login_unexpected" \{[\s\S]*?\n\}\n/.exec(
        infraSource
      );
    expect(block, 'lab_hybrid_ssh_login_unexpected not found').not.toBeNull();
    return block[0];
  };

  /** A variable's default in the tree, as Terraform would interpolate it. */
  const variableDefault = (name) => {
    const match = new RegExp(`variable "${name}" \\{[\\s\\S]*?\\n\\s*default\\s*=\\s*([^\\n]+)\\n`).exec(infraSource);
    expect(match, `var.${name} has no default`).not.toBeNull();
    return match[1].trim();
  };

  it('renders alert-lab-ssh-login’s query exactly as the heredoc in infra/ does, with the tree’s defaults (#953)', () => {
    // sshLoginAlertQuery() keeps its own copy of the query, so a heredoc
    // change that does not move the copy would leave the declaration matching
    // a query Terraform never renders. `<<-` strips the smallest indent and
    // keeps the newline before the marker.
    const heredoc = /query\s*=\s*<<-KQL\n([\s\S]*?)\n[ \t]*KQL\n/.exec(sshLoginRule());
    expect(heredoc, 'lab_hybrid_ssh_login_unexpected query heredoc not found').not.toBeNull();
    const lines = heredoc[1].split('\n');
    const indent = Math.min(...lines.filter((line) => line.trim()).map((line) => /^ */.exec(line)[0].length));
    const hostRows = /^\s*lab_hybrid_host_rows\s*=\s*"(.*)"$/m.exec(infraSource);
    const machine = /^\s*lab_hybrid_machine_name\s*=\s*"([^"]+)"$/m.exec(infraSource);
    expect(hostRows, 'local.lab_hybrid_host_rows not found').not.toBeNull();
    expect(machine, 'local.lab_hybrid_machine_name not found').not.toBeNull();
    const loopbackOnly = variableDefault('lab_ssh_loopback_only');
    const rendered = `${lines.map((line) => line.slice(indent)).join('\n')}\n`
      .replace('${jsonencode(var.lab_ssh_admin_users)}', JSON.stringify(JSON.parse(variableDefault('lab_ssh_admin_users'))))
      .replace(
        '${jsonencode(var.lab_ssh_admin_key_fingerprints)}',
        JSON.stringify(JSON.parse(variableDefault('lab_ssh_admin_key_fingerprints')))
      )
      .replace('${var.lab_ssh_loopback_only}', loopbackOnly)
      .replace(
        '${local.lab_hybrid_host_rows}',
        hostRows[1].replaceAll('\\"', '"').replace(
          '${lower(local.lab_hybrid_machine_name)}',
          machine[1]
            .replace('${var.environment}', JSON.parse(variableDefault('environment')))
            .replace('${var.region_abbreviation}', JSON.parse(variableDefault('region_abbreviation')))
            .toLowerCase()
        )
      );
    expect(loopbackOnly).toBe('true');
    expect(sshLoginAlertQuery(true)).toBe(rendered);
  });

  it('declares alert-lab-ssh-login’s loopback rule and description, and nothing else of the rule, if it declares them at all (#953 stage 3)', () => {
    const address = 'azurerm_monitor_scheduled_query_rules_alert_v2.lab_hybrid_ssh_login_unexpected';
    const entries = DECLARED.filter((entry) => entry.address === address);
    if (entries.length === 0) return;
    expect(entries.map((entry) => entry.path).sort()).toEqual(['criteria[0].query', 'description']);
    const query = entries.find((entry) => entry.path === 'criteria[0].query');
    expect(query.before).toBe(sshLoginAlertQuery(false));
    expect(query.after).toBe(sshLoginAlertQuery(true));
    const after = query.after.split('\n');
    const changed = query.before.split('\n').filter((line, i) => line !== after[i]);
    expect(changed).toEqual(['let LoopbackOnly = false;']);
    const description = entries.find((entry) => entry.path === 'description');
    expect(description.after).toBe(SSH_LOGIN_ALERT_DESCRIPTION);
    expect(sshLoginRule()).toContain(`description         = "${SSH_LOGIN_ALERT_DESCRIPTION}"`);
    expect(description.before).not.toBe(description.after);
  });
});

describe('conditional replacements and declared creates (#816)', () => {
  const COSMOS = 'azapi_update_resource.cosmos_computed_properties';
  const withChanges = (...changes) => {
    const plan = expectedPlan();
    plan.resource_changes.push(...changes);
    return plan;
  };

  it('tolerates the computed-property resource being replaced, instance by instance', () => {
    const plan = withChanges(
      { address: `${COSMOS}["content"]`, change: { actions: ['delete', 'create'] } },
      { address: `${COSMOS}["blogs"]`, change: { actions: ['create', 'delete'] } }
    );
    expect(checkPlan(plan, { declared: [] })).toMatchObject({ ok: true, unexpected: [], missing: [] });
  });

  it('never reports it missing, because most plans do not contain it', () => {
    expect(checkPlan(expectedPlan(), { declared: [] }).missing).toEqual([]);
  });

  it('still names the container update that triggers the replacement', () => {
    const plan = withChanges(
      { address: `${COSMOS}["content"]`, change: { actions: ['delete', 'create'] } },
      {
        address: 'azurerm_cosmosdb_sql_container.hcw["content"]',
        change: {
          actions: ['update'],
          before: { default_ttl: null },
          after: { default_ttl: 60 },
          after_unknown: {},
          before_sensitive: {},
          after_sensitive: {},
        },
      }
    );
    const result = checkPlan(plan, { declared: [] });
    expect(result.ok).toBe(false);
    expect(result.unexpected).toEqual([
      'azurerm_cosmosdb_sql_container.hcw["content"]: update default_ttl: null -> 60',
    ]);
  });

  it('tolerates a replacement, never a create, without a declaration', () => {
    const plan = withChanges({ address: `${COSMOS}["content"]`, change: { actions: ['create'] } });
    expect(checkPlan(plan, { declared: [] }).unexpected).toEqual([`${COSMOS}["content"]: create`]);
  });

  it('matches a declared create by exact address and action, and reports it', () => {
    const declaration = { address: `${COSMOS}["content"]`, action: 'create', reason: 'test' };
    const plan = withChanges({ address: `${COSMOS}["content"]`, change: { actions: ['create'] } });
    const result = checkPlan(plan, { declared: [declaration] });
    expect(result).toMatchObject({ ok: true, unexpected: [] });
    expect(result.declared).toEqual([declaration]);
    expect(declarationLines(result)).toEqual([`DECLARED    ${COSMOS}["content"] create (test)`]);
  });

  it('passes a declared delete beside the permanent diff: 3 add, 1 change, 4 destroy (the #816 healer removal, as it was declared)', () => {
    // The shipped declaration applied on 2026-10-06 and was deleted, as the
    // header asks, so the shape is declared here instead.
    const ROLE = 'azurerm_role_assignment.github_deploy_cosmos_container_writer';
    const declaration = { address: ROLE, action: 'delete', reason: 'test' };
    const plan = withChanges({ address: ROLE, change: { actions: ['delete'] } });
    const result = checkPlan(plan, { declared: [declaration] });
    expect(result).toMatchObject({ ok: true, unexpected: [], missing: [] });
    expect(result.declared.map((d) => d.address)).toEqual([ROLE]);
  });

  it('does not let a create declaration cover a delete, or another instance', () => {
    const declaration = { address: `${COSMOS}["content"]`, action: 'create', reason: 'test' };
    const plan = withChanges(
      { address: `${COSMOS}["content"]`, change: { actions: ['delete'] } },
      { address: `${COSMOS}["blogs"]`, change: { actions: ['create'] } }
    );
    const result = checkPlan(plan, { declared: [declaration] });
    expect(result.unexpected).toEqual([`${COSMOS}["content"]: delete`, `${COSMOS}["blogs"]: create`]);
    expect(result.unused).toEqual([declaration]);
  });
});

describe('a declared container create names a container the spec provisions', () => {
  // The Doc Vault's container (owner request 2026-10-26) is declared until its
  // run has applied. Whatever is declared in this shape must name a container
  // that infra/cosmos-containers.json really lists, or the entry would wave
  // through a create that Terraform will never plan, and miss the one it will.
  it('holds for every declared azurerm_cosmosdb_sql_container create', () => {
    const spec = JSON.parse(readFileSync(join(HERE, '..', 'infra', 'cosmos-containers.json'), 'utf8'));
    const names = new Set(spec.containers.map((container) => container.name));
    const declared = DECLARED.filter((entry) => entry.address.startsWith('azurerm_cosmosdb_sql_container.hcw["'));
    for (const entry of declared) {
      expect(entry.action, entry.address).toBe('create');
      const name = /\["([^"]+)"\]$/.exec(entry.address)?.[1];
      expect(names.has(name), `${entry.address} is not in infra/cosmos-containers.json`).toBe(true);
    }
  });

  it('reads a plan whose only addition is the doc_vault container as that create beside the permanent diff', () => {
    const plan = expectedPlan();
    plan.resource_changes.push({
      address: 'azurerm_cosmosdb_sql_container.hcw["doc_vault"]',
      change: { actions: ['create'] },
    });
    const declaration = DECLARED.find((entry) => entry.address === 'azurerm_cosmosdb_sql_container.hcw["doc_vault"]');
    // Declared now; once it has applied the entry is deleted and this case ends with it.
    if (!declaration) return;
    const result = checkPlan(plan, { declared: [declaration] });
    expect(result.unexpected).toEqual([]);
    expect(result.unused).toEqual([]);
  });

  it('does not let the declaration cover a destroy of the container', () => {
    const plan = expectedPlan();
    plan.resource_changes.push({
      address: 'azurerm_cosmosdb_sql_container.hcw["doc_vault"]',
      change: { actions: ['delete'] },
    });
    const declaration = { address: 'azurerm_cosmosdb_sql_container.hcw["doc_vault"]', action: 'create', reason: 'test' };
    expect(checkPlan(plan, { declared: [declaration] }).unexpected).toEqual([
      'azurerm_cosmosdb_sql_container.hcw["doc_vault"]: delete',
    ]);
  });
});
