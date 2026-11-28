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
  describeDeclaration,
  EXPECTED,
  formatPath,
  KNOWN_AFTER_APPLY,
  OWNER_VALUE,
  OVERDUE_LAST_DUE,
  OVERDUE_LAST_DUE_BIN_AT,
  overdueQuery,
  redact,
  sshLoginAlertQuery,
  secretsOf,
  TIMER_SCHEDULES_APPLIED,
} from './assert-expected-plan.mjs';
// The module-reading helper moved to its own file when a second check needed
// it (terraform-role-definitions.test.mjs). Same eight lines, one copy.
import { terraformSource } from './terraform-source.mjs';
import { describeIncomplete, incompleteSteps, matchesDeclaration } from './lib/plan-declarations.mjs';

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

/**
 * The names of the `azurerm_cosmosdb_sql_role_assignment` blocks in `source`
 * (Terraform text) whose `scope` is a Cosmos account's id and nothing more:
 * `azurerm_cosmosdb_account.<any name>.id` bare or as the whole of an
 * interpolated string (`"${azurerm_cosmosdb_account.<any name>.id}"`), any
 * spacing, a trailing `/` inside the string allowed, with or without a
 * trailing `#` or `//` comment. Names are any
 * valid Terraform identifier (letters, digits, `_` and `-`, not starting
 * with a digit). A database grant's scope goes on with `/dbs/<name>` inside
 * the string and does not match (#1469 step 2).
 */
function accountScopedCosmosGrants(source) {
  const identifier = '[A-Za-z_][A-Za-z0-9_-]*';
  const blocks = [...source.matchAll(new RegExp(`^resource "azurerm_cosmosdb_sql_role_assignment" "(${identifier})" \\{[\\s\\S]*?^\\}`, 'gm'))];
  const accountId = `azurerm_cosmosdb_account\\.${identifier}\\.id`;
  // A trailing slash after the interpolated id is still the account scope.
  const accountScope = new RegExp(`^\\s*scope\\s*=\\s*(?:${accountId}|"\\$\\{\\s*${accountId}\\s*\\}/?")\\s*(?:(?:#|\\/\\/).*)?$`, 'm');
  return blocks.filter((m) => accountScope.test(m[0])).map((m) => m[1]);
}

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

  it('passes a declared import at exactly its address, and only the import (#1923)', () => {
    const declaration = { address: 'azurerm_key_vault.imported', action: 'import', reason: 'test' };
    const importing = (address, actions = ['no-op']) => ({ address, change: { actions, importing: { id: 'x' } } });

    let { plan } = fixture();
    plan.resource_changes.push(importing('azurerm_key_vault.imported'));
    let result = checkPlan(plan, { declared: [declaration] });
    expect(result).toMatchObject({ ok: true, unexpected: [] });
    expect(result.declared).toEqual([declaration]);
    expect(declarationLines(result)).toEqual(['DECLARED    azurerm_key_vault.imported import (test)']);

    // Another address is still named.
    ({ plan } = fixture());
    plan.resource_changes.push(importing('azurerm_key_vault.other'));
    result = checkPlan(plan, { declared: [declaration] });
    expect(result.unexpected).toEqual(['azurerm_key_vault.other: import']);
    expect(result.unused).toEqual([declaration]);

    // A declared create does not cover an import, and a declared import does not cover a create.
    ({ plan } = fixture());
    plan.resource_changes.push(importing('azurerm_key_vault.imported'));
    expect(checkPlan(plan, { declared: [{ ...declaration, action: 'create' }] }).unexpected).toEqual([
      'azurerm_key_vault.imported: import',
    ]);
    ({ plan } = fixture());
    plan.resource_changes.push({ address: 'azurerm_key_vault.imported', change: { actions: ['create'] } });
    expect(checkPlan(plan, { declared: [declaration] }).unexpected).toEqual(['azurerm_key_vault.imported: create']);

    // A move beside a declared import is still named.
    ({ plan } = fixture());
    plan.resource_changes.push({ ...importing('azurerm_key_vault.imported'), previous_address: 'azurerm_key_vault.old' });
    expect(checkPlan(plan, { declared: [declaration] }).unexpected).toEqual([
      'azurerm_key_vault.imported: moved from azurerm_key_vault.old',
    ]);
  });

  it('never prints the Web Analytics site’s identifiers on an undeclared change (#1923)', () => {
    const tag = '0123456789abcdef0123456789abcdef';
    const { plan } = fixture();
    plan.resource_changes.push({
      address: 'cloudflare_web_analytics_site.hcw[0]',
      change: {
        actions: ['update'],
        before: { account_id: tag, zone_tag: null, site_tag: tag, site_token: tag, snippet: `<script data="${tag}">` },
        after: { account_id: tag, zone_tag: tag, site_tag: `${tag}0`, site_token: `${tag}1`, snippet: '<script>' },
        after_unknown: {},
        before_sensitive: {},
        after_sensitive: {},
      },
    });
    const result = checkPlan(plan, { declared: [] });
    expect(result.unexpected).toEqual([
      'cloudflare_web_analytics_site.hcw[0]: update site_tag: (set) -> (set)',
      'cloudflare_web_analytics_site.hcw[0]: update site_token: (set) -> (set)',
      'cloudflare_web_analytics_site.hcw[0]: update snippet: (set) -> (set)',
      'cloudflare_web_analytics_site.hcw[0]: update zone_tag: null -> (set)',
    ]);
    expect(result.unexpected.join('\n')).not.toContain(tag);
  });

  it('matches KNOWN_AFTER_APPLY only to an unknown, non-sensitive difference at its exact path (#1923)', () => {
    const declaration = { address: 'example_site.one', path: 'token', after: KNOWN_AFTER_APPLY, reason: 'test' };
    const difference = (extra) => ({ path: 'token', before: 'old', after: undefined, sensitive: false, unknown: true, ...extra });
    expect(matchesDeclaration(declaration, 'example_site.one', difference())).toBe(true);
    // A known change is a value someone has to read, not a computed one.
    expect(matchesDeclaration(declaration, 'example_site.one', difference({ after: 'new', unknown: false }))).toBe(false);
    expect(matchesDeclaration(declaration, 'example_site.one', difference({ sensitive: true }))).toBe(false);
    expect(matchesDeclaration(declaration, 'example_site.two', difference())).toBe(false);
    expect(matchesDeclaration(declaration, 'example_site.one', difference({ path: 'snippet' }))).toBe(false);
    expect(describeDeclaration(declaration)).toBe('example_site.one token: (known after apply) (test)');
  });

  it('matches OWNER_VALUE only from exactly its before to another non-empty, known string (#1923)', () => {
    const declaration = { address: 'example_app.one', path: 'app_settings.ID', before: '', after: OWNER_VALUE, reason: 'test' };
    const difference = (extra) => ({ path: 'app_settings.ID', before: '', after: 'value', sensitive: false, unknown: false, ...extra });
    expect(matchesDeclaration(declaration, 'example_app.one', difference())).toBe(true);
    for (const [label, extra] of [
      ['another before', { before: 'older' }],
      ['emptied', { after: '' }],
      ['removed', { after: undefined }],
      ['not a string', { after: 42 }],
      ['unknown', { after: undefined, unknown: true }],
      ['sensitive', { sensitive: true }],
      ['another path', { path: 'app_settings.OTHER' }],
    ]) {
      expect(matchesDeclaration(declaration, 'example_app.one', difference(extra)), label).toBe(false);
    }
    expect(describeDeclaration(declaration)).toBe(`example_app.one app_settings.ID: "" -> (the owner's value, not printed) (test)`);
  });

  it('holds an imported resource’s update to its own declarations, separately from the import (#1923)', () => {
    const importDeclaration = { address: 'azurerm_key_vault.imported', action: 'import', reason: 'test' };
    const update = {
      address: 'azurerm_key_vault.imported',
      change: {
        actions: ['update'],
        importing: { id: 'x' },
        before: { enabled: null },
        after: { enabled: true },
        after_unknown: {},
        before_sensitive: {},
        after_sensitive: {},
      },
    };
    const { plan } = fixture();
    plan.resource_changes.push(update);
    expect(checkPlan(plan, { declared: [importDeclaration] }).unexpected).toEqual([
      'azurerm_key_vault.imported: update enabled: null -> true',
    ]);
    const enabled = { address: 'azurerm_key_vault.imported', path: 'enabled', before: null, after: true, reason: 'test' };
    expect(checkPlan(plan, { declared: [importDeclaration, enabled] })).toMatchObject({ ok: true, unexpected: [] });
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

describe('declarations that share a step (#1929)', () => {
  const ADDRESS = 'example_resource.example';
  const declared = [
    { address: ADDRESS, path: 'a', step: 'example step', before: 1, after: 2, reason: 'made up' },
    { address: ADDRESS, path: 'b', step: 'example step', before: 1, after: 2, reason: 'made up' },
    { address: ADDRESS, path: 'c', before: 1, after: 2, reason: 'made up, no step' },
  ];
  const planWith = (paths) => {
    const plan = expectedPlan();
    if (paths.length > 0) {
      const before = { a: 1, b: 1, c: 1 };
      const after = { ...before, ...Object.fromEntries(paths.map((path) => [path, 2])) };
      plan.resource_changes.push({
        address: ADDRESS,
        change: { actions: ['update'], before, after, after_unknown: {}, before_sensitive: {}, after_sensitive: {} },
      });
    }
    return plan;
  };

  it('passes a whole step, and leaves a step with no change in the plan to the NOTEs', () => {
    const whole = checkPlan(planWith(['a', 'b']), { declared });
    expect(whole.ok).toBe(true);
    expect(whole.declared).toEqual(declared.slice(0, 2));
    expect(whole.unused).toEqual([declared[2]]);
    const none = checkPlan(planWith([]), { declared });
    expect(none.ok).toBe(true);
    expect(none.unused).toEqual(declared);
    expect(incompleteSteps(declared, new Set())).toEqual([]);
  });

  it('names each declaration a partly matched step lacks, and not as a NOTE', () => {
    const part = checkPlan(planWith(['a']), { declared });
    expect(part.ok).toBe(false);
    expect(part.unexpected).toEqual([describeIncomplete(declared[1])]);
    expect(part.unexpected[0]).toBe(
      `${ADDRESS} b: 1 -> 2 (made up): not in this plan, although other changes of step "example step" are. ` +
        "A step's declarations apply together."
    );
    expect(part.unused).toEqual([declared[2]]);
    // A declaration without a step keeps the old rule: missing is a NOTE, never a failure.
    const loose = checkPlan(planWith(['a', 'b']), { declared: [...declared.slice(0, 2), declared[2]] });
    expect(loose.ok).toBe(true);
    expect(incompleteSteps(declared, new Set([declared[2]]))).toEqual([]);
  });

  it('never opens a step on a computed value alone, and credits every declaration that covers a difference', () => {
    const one = { address: ADDRESS, path: 'a', step: 'one', before: 1, after: 2, reason: 'one' };
    const oneStamp = { address: ADDRESS, path: 'm', step: 'one', after: KNOWN_AFTER_APPLY, reason: 'one' };
    const twoStamp = { address: ADDRESS, path: 'm', step: 'two', after: KNOWN_AFTER_APPLY, reason: 'two' };
    const two = { address: ADDRESS, path: 'b', step: 'two', before: 1, after: 2, reason: 'two' };
    const stamped = (paths) => {
      const before = { a: 1, b: 1, m: 'then' };
      const after = { ...before, ...Object.fromEntries(paths.map((path) => [path, 2])) };
      delete after.m;
      return {
        resource_changes: [
          ...expectedPlan().resource_changes,
          {
            address: ADDRESS,
            change: { actions: ['update'], before, after, after_unknown: { m: true }, before_sensitive: {}, after_sensitive: {} },
          },
        ],
      };
    };
    for (const order of [
      [twoStamp, two, oneStamp, one],
      [one, oneStamp, two, twoStamp],
    ]) {
      const result = checkPlan(stamped(['a']), { declared: order });
      expect(result.unexpected).toEqual([]);
      expect(new Set(result.declared)).toEqual(new Set([one, oneStamp]));
      expect(new Set(result.unused)).toEqual(new Set([two, twoStamp]));
    }
    // Only the computed value differs: neither step opens, and a computed value that belongs to a step covers
    // its difference only while that step is in the plan, so the lone unknown value is named, as it would be
    // with nothing declared. Nothing is credited and no step is reported as missing a part.
    const stampOnly = checkPlan(stamped([]), { declared: [one, oneStamp, two, twoStamp] });
    expect(stampOnly.ok).toBe(false);
    expect(stampOnly.unexpected).toEqual([`${ADDRESS}: update m: "then" -> (known after apply)`]);
    expect(stampOnly.declared).toEqual([]);
    expect(incompleteSteps([one, oneStamp], new Set([oneStamp]))).toEqual([]);
    // A computed value without a step keeps the rule it had before steps: it covers its difference on its own.
    const looseStamp = { address: ADDRESS, path: 'm', after: KNOWN_AFTER_APPLY, reason: 'no step' };
    const loose = checkPlan(stamped([]), { declared: [looseStamp] });
    expect(loose.ok).toBe(true);
    expect(loose.declared).toEqual([looseStamp]);
  });
});

describe('DECLARED', () => {
  const infraSource = terraformSource();

  it('gives each step a name of its own: one change per path in a step, and a declared value in every step (#1929)', () => {
    const steps = new Map();
    for (const entry of DECLARED.filter((declaration) => declaration.step)) {
      if (!steps.has(entry.step)) steps.set(entry.step, []);
      steps.get(entry.step).push(entry);
    }
    for (const [step, entries] of steps) {
      // A step names one run's change: it never declares the same thing twice, so two different changes
      // cannot share a name and be read as one.
      const keys = entries.map((entry) => `${entry.address} ${entry.action ?? entry.path}`);
      expect(new Set(keys).size, step).toBe(keys.length);
      // A step made of computed values alone could never be found in a plan (they do not open a step).
      expect(entries.some((entry) => entry.after !== KNOWN_AFTER_APPLY), step).toBe(true);
    }
    // Two steps that declare the same address and path (forward and back) must differ in their values,
    // or the plan could not tell them apart.
    const values = DECLARED.filter((entry) => entry.step && entry.after !== KNOWN_AFTER_APPLY && !entry.action).map(
      (entry) => JSON.stringify([entry.address, entry.path, entry.before, entry.after])
    );
    expect(new Set(values).size).toBe(values.length);
  });

  it('holds only complete entries, each for a resource infra/*.tf declares, or no longer declares for a delete', () => {
    // Empty is the normal state, and then this passes trivially. An entry
    // needs both values spelled out, because an omitted one matches only an
    // absent attribute, and a reason, because the next reader has to decide
    // whether it has applied.
    for (const declaration of DECLARED) {
      const label = JSON.stringify(declaration);
      expect(typeof declaration.address, label).toBe('string');
      expect(typeof declaration.reason === 'string' && declaration.reason.length > 0, label).toBe(true);
      // `step` (#1929) is optional on either shape and, when present, names the run's change.
      if (Object.hasOwn(declaration, 'step')) {
        expect(typeof declaration.step === 'string' && declaration.step.length > 0, label).toBe(true);
      }
      const keys = Object.keys(declaration)
        .filter((key) => key !== 'step')
        .sort();
      if (declaration.action) {
        // A create, delete (#816) or import (#1923): no path, no values, nothing else.
        expect(['create', 'delete', 'import'], label).toContain(declaration.action);
        expect(keys, label).toEqual(['action', 'address', 'reason']);
      } else if (declaration.after === KNOWN_AFTER_APPLY) {
        // A computed value (#1923): its before is the provider's own and is not
        // compared, so an entry that wrote one would mislead the next reader.
        expect(keys, label).toEqual(['address', 'after', 'path', 'reason']);
      } else {
        expect(typeof declaration.path, label).toBe('string');
        expect(Object.hasOwn(declaration, 'before') && Object.hasOwn(declaration, 'after'), label).toBe(true);
      }
      const [type, name] = declaration.address.replace(/\[.*$/, '').split('.');
      // A declared delete is the removal of a whole resource (#816), so its
      // block must be gone. A delete of one for_each instance is either a key
      // that left a block that stays, or a whole block removed with its keys
      // (#1479), so nothing is asserted about the block for it. Every other
      // entry must name a block that exists.
      if (declaration.action === 'delete') {
        if (!/\[.*\]$/.test(declaration.address)) {
          expect(infraSource, label).not.toContain(`resource "${type}" "${name}"`);
        }
      } else {
        expect(infraSource, label).toContain(`resource "${type}" "${name}"`);
      }
    }
  });

  /**
   * One variable's block in the tree, its braces excluded. A block ends at
   * the first `}` in column 0, so a search inside it cannot run on into the
   * next variable's default.
   */
  const variableBlock = (name) => {
    const match = new RegExp(`^variable "${name}" \\{\\n([\\s\\S]*?)\\n\\}`, 'm').exec(infraSource);
    expect(match, `variable "${name}" not found`).not.toBeNull();
    return match[1];
  };

  /** `[name, period, anchor]` rows as sorted, comparable keys. */
  const rowKeys = (rows) => rows.map((row) => row.join(' | ')).sort();

  /** The datatable rows of an alert-timer-overdue query, commas ignored, as `rowKeys` gives them. */
  const queryRows = (query) =>
    rowKeys(
      [...query.matchAll(/^ {2}"(\w+)", (\S+), datetime\(([^)]+)\),?$/gm)].map((match) => [match[1], match[2], match[3]])
    );

  /** The rows `after` has that `before` does not. */
  const rowsAdded = (before, after) => {
    const had = new Set(queryRows(before));
    return queryRows(after).filter((key) => !had.has(key));
  };

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
    // due-time line alone; #1302's, like #1009's, #1612's and #1918's, was
    // rows added. Whatever the shape, `before` is the query the rule holds in
    // state (TIMER_SCHEDULES_APPLIED), and the rows the update adds are
    // exactly the tree's rows that are not applied yet. Neither value carries
    // the bin_at() line Kusto refuses (#964), applied away on 2026-10-15.
    expect(declaration.before).toBe(overdueQuery(TIMER_SCHEDULES_APPLIED));
    const applied = new Set(TIMER_SCHEDULES_APPLIED.map(([name]) => name));
    const pending = rows.filter(([name]) => !applied.has(name));
    expect(pending.length, 'a declared row change with no row the tree adds').toBeGreaterThan(0);
    expect(rowsAdded(declaration.before, declaration.after)).toEqual(rowKeys(pending));
    expect(declaration.before).not.toContain(OVERDUE_LAST_DUE_BIN_AT);
    expect(declaration.after).not.toContain(OVERDUE_LAST_DUE_BIN_AT);
  });

  it('finds the rows a query adds whether the new row sorts first, in the middle or last', () => {
    // The last datatable row carries no trailing comma, so a row that sorts
    // last gives the old last row a comma. Comparing the rows, not the lines,
    // keeps that from reading as a changed row.
    const base = TIMER_SCHEDULES_APPLIED;
    for (const row of [
      ['aaaFirstTimer', '1d', '2026-01-01 01:00'],
      ['moreTimer', '1d', '2026-01-01 01:00'],
      ['zzzLastTimer', '1d', '2026-01-01 01:00'],
    ]) {
      expect(rowsAdded(overdueQuery(base), overdueQuery([...base, row])), row[0]).toEqual(rowKeys([row]));
    }
    expect(rowsAdded(overdueQuery(base), overdueQuery(base))).toEqual([]);
  });

  it('holds alert-timer-overdue’s applied rows equal to the tree’s while no change to the rule is declared (2026-11-01)', () => {
    // TIMER_SCHEDULES_APPLIED is the query the rule holds in state, the
    // `before` of the next declaration. With nothing declared for the rule, it
    // must be exactly what infra/ renders, or the next declaration's `before`
    // would describe a state the rule was never in.
    const declared = DECLARED.some(
      (entry) =>
        entry.address === 'azurerm_monitor_scheduled_query_rules_alert_v2.timer_overdue' &&
        entry.path === 'criteria[0].query'
    );
    if (declared) return;
    expect(overdueQuery(TIMER_SCHEDULES_APPLIED)).toBe(overdueQuery(treeTimerRows()));
  });

  it('keeps only the sweep’s arming plan declared, naming a flag the tree catalogues (#1403, pruned 2026-11-01)', () => {
    // The catalogue shapes (absent -> false, absent -> true) applied and were
    // deleted; false -> true stays until the owner arms the sweep.
    const flag = 'app_settings.FEATURE_FLAG_SWEEP_VISITOR_SESSIONS';
    const entries = DECLARED.filter((entry) => entry.path === flag);
    expect(entries.map((entry) => [entry.before, entry.after])).toEqual([['false', 'true']]);
    for (const entry of entries) expect(entry.address).toBe(FUNCTION_APP);
    expect(infraSource).toMatch(/^\s*SWEEP_VISITOR_SESSIONS\s*=\s*"sweepVisitorSessions — /m);
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

  it('passes the plan that arms the sweep: the flag false to true (#1403)', () => {
    // false -> true is the arming apply after the catalogue apply. It stays
    // declared until that apply has run, because the file cannot read what has applied.
    const { plan, app } = fixture();
    app.before.app_settings.FEATURE_FLAG_SWEEP_VISITOR_SESSIONS = 'false';
    app.after.app_settings.FEATURE_FLAG_SWEEP_VISITOR_SESSIONS = 'true';
    expect(checkPlan(plan)).toMatchObject({ ok: true, unexpected: [], missing: [] });
  });

  it('reads #1612’s catalogue plan as unexpected now that it has applied, and keeps only its arming (#1918)', () => {
    // The disarmed flag, the four GSC settings and the overdue row applied by
    // 2026-11-10: the plan check on actions run 42728440587 printed each as
    // "declared, not in this plan". So adding any of them from nothing again
    // is unexpected, and the row is in TIMER_SCHEDULES_APPLIED.
    const settings = {
      FEATURE_FLAG_SYNC_SEARCH_CONSOLE: 'false',
      GSC_WIF_AUDIENCE: '',
      GSC_ENTRA_APP_ID_URI: '',
      GSC_SERVICE_ACCOUNT_EMAIL: '',
      GSC_SITE_URL: 'sc-domain:hybridcloudworks.com',
    };
    for (const [name, value] of Object.entries(settings)) {
      const { plan, app } = fixture();
      app.after.app_settings[name] = value;
      const result = checkPlan(plan);
      expect(result.ok, name).toBe(false);
      expect(result.unexpected.some((line) => line.includes(`app_settings.${name}`)), name).toBe(true);
    }
    expect(TIMER_SCHEDULES_APPLIED.map(([name]) => name)).toContain('syncSearchConsole');

    const armed = fixture();
    armed.app.before.app_settings.FEATURE_FLAG_SYNC_SEARCH_CONSOLE = 'false';
    armed.app.after.app_settings.FEATURE_FLAG_SYNC_SEARCH_CONSOLE = 'true';
    expect(checkPlan(armed.plan)).toMatchObject({ ok: true, unexpected: [] });
    const entries = DECLARED.filter((entry) => entry.path === 'app_settings.FEATURE_FLAG_SYNC_SEARCH_CONSOLE');
    expect(entries.map((entry) => [entry.before, entry.after])).toEqual([['false', 'true']]);
    expect(DECLARED.some((entry) => /^app_settings\.GSC_/.test(entry.path ?? ''))).toBe(false);
  });

  it('reads the audience read’s arming plans as unexpected now that the arming has applied (#1302, pruned 2026-11-28)', () => {
    // FEATURE_FLAG_AMBASSADOR_AUDIENCE_MONTHLY read "true" live on 2026-11-28
    // (az functionapp config appsettings list, one name), after the owner
    // armed it at 05:14 UTC. So arming it again, disarming it, or a new
    // setting of either value is unexpected now, and a person reads it.
    const flag = 'FEATURE_FLAG_AMBASSADOR_AUDIENCE_MONTHLY';
    expect(DECLARED.filter((entry) => entry.path === `app_settings.${flag}`)).toEqual([]);
    for (const [before, after] of [
      [undefined, 'false'],
      [undefined, 'true'],
      ['false', 'true'],
      ['true', 'false'],
    ]) {
      const { plan, app } = fixture();
      if (before !== undefined) app.before.app_settings[flag] = before;
      app.after.app_settings[flag] = after;
      const result = checkPlan(plan);
      expect(result.ok, `${before} -> ${after}`).toBe(false);
      expect(result.unexpected.some((line) => line.includes(`app_settings.${flag}`)), `${before} -> ${after}`).toBe(true);
    }
    // The prune hides no catalogue removal: the timer is still in the tree.
    expect(infraSource).toMatch(/^\s*AMBASSADOR_AUDIENCE_MONTHLY\s*=\s*"ambassadorAudienceMonthly — /m);
  });

  it('reads #1918’s plans as unexpected now that the catalogue and the arming have both applied (pruned 2026-11-27)', () => {
    // The disarmed flag and the overdue row applied, and the owner's arming
    // after them: FEATURE_FLAG_CHECK_CLOUDFLARE_RATE_LIMIT read "true" live on
    // 2026-11-27, and the live rule carries the row. So each of those plans,
    // and a disarming, is unexpected now, and the row is applied.
    const flag = 'FEATURE_FLAG_CHECK_CLOUDFLARE_RATE_LIMIT';
    expect(DECLARED.filter((entry) => entry.path === `app_settings.${flag}`)).toEqual([]);
    for (const [before, after] of [
      [undefined, 'false'],
      [undefined, 'true'],
      ['false', 'true'],
      ['true', 'false'],
    ]) {
      const { plan, app } = fixture();
      if (before !== undefined) app.before.app_settings[flag] = before;
      app.after.app_settings[flag] = after;
      const result = checkPlan(plan);
      expect(result.ok, `${before} -> ${after}`).toBe(false);
      expect(result.unexpected.some((line) => line.includes(`app_settings.${flag}`)), `${before} -> ${after}`).toBe(true);
    }
    expect(TIMER_SCHEDULES_APPLIED).toContainEqual(['checkCloudflareRateLimit', '1d', '2026-01-01 12:40']);
    const rows = treeTimerRows();
    const readded = fixture();
    readded.plan.resource_changes.push(
      timerRuleUpdate({
        address: 'azurerm_monitor_scheduled_query_rules_alert_v2.timer_overdue',
        before: overdueQuery(rows.filter(([name]) => name !== 'checkCloudflareRateLimit')),
        after: overdueQuery(rows),
      })
    );
    expect(checkPlan(readded.plan).ok).toBe(false);
    expect(infraSource).toMatch(/^\s*CHECK_CLOUDFLARE_RATE_LIMIT\s*=\s*"checkCloudflareRateLimit — /m);
  });

  it('reads any change to the proposal clean-up’s switch as unexpected, now that the owner’s arming run has applied (#1777)', () => {
    // The switch, declared off, has applied, so adding it from nothing is unexpected now.
    const again = fixture();
    again.app.after.app_settings.PROPOSAL_STRIP_ENABLED = 'false';
    expect(checkPlan(again.plan).ok).toBe(false);

    // The arming run has applied too, so off to on is no longer expected, and neither is on to off.
    const armed = fixture();
    armed.app.before.app_settings.PROPOSAL_STRIP_ENABLED = 'false';
    armed.app.after.app_settings.PROPOSAL_STRIP_ENABLED = 'true';
    expect(checkPlan(armed.plan).ok).toBe(false);
    const disarmed = fixture();
    disarmed.app.before.app_settings.PROPOSAL_STRIP_ENABLED = 'true';
    disarmed.app.after.app_settings.PROPOSAL_STRIP_ENABLED = 'false';
    expect(checkPlan(disarmed.plan).ok).toBe(false);

    // Absent straight to "true" would arm it without a dry run ever having applied: not declared.
    const skipped = fixture();
    skipped.app.after.app_settings.PROPOSAL_STRIP_ENABLED = 'true';
    expect(checkPlan(skipped.plan).ok).toBe(false);
    // Armed by the owner on 2026-11-25 (#1777).
    expect(infraSource).toMatch(/^\s*"PROPOSAL_STRIP_ENABLED"\s*=\s*"true"$/m);
  });

  it('reads any change to the content archive’s switch as unexpected, now that the owner’s arming run has applied (#1811)', () => {
    // The first run has applied, so creating the container or adding the switch from nothing is unexpected now.
    const again = fixture();
    again.app.after.app_settings.CONTENT_ARCHIVE_ENABLED = 'false';
    expect(checkPlan(again.plan).ok).toBe(false);
    const recreated = fixture();
    recreated.plan.resource_changes.push({
      address: 'azurerm_storage_container.content_archive',
      change: { actions: ['create'] },
    });
    expect(checkPlan(recreated.plan).ok).toBe(false);

    // The arming run has applied too, so off to on is no longer expected, and neither is on to off.
    const armed = fixture();
    armed.app.before.app_settings.CONTENT_ARCHIVE_ENABLED = 'false';
    armed.app.after.app_settings.CONTENT_ARCHIVE_ENABLED = 'true';
    expect(checkPlan(armed.plan).ok).toBe(false);
    const disarmed = fixture();
    disarmed.app.before.app_settings.CONTENT_ARCHIVE_ENABLED = 'true';
    disarmed.app.after.app_settings.CONTENT_ARCHIVE_ENABLED = 'false';
    expect(checkPlan(disarmed.plan).ok).toBe(false);
    // Absent straight to "true" would arm it before it had ever applied as off: not declared.
    const skipped = fixture();
    skipped.app.after.app_settings.CONTENT_ARCHIVE_ENABLED = 'true';
    expect(checkPlan(skipped.plan).ok).toBe(false);
    // The job adds no timer of its own: no flag for it, and no row on alert-timer-overdue.
    expect(infraSource).not.toMatch(/FEATURE_FLAG_CONTENT_ARCHIVE|CONTENT_ARCHIVE\w*\s*=\s*"contentArchive/);
    expect(infraSource).not.toMatch(/^\s*contentArchive\w*\s*=\s*\{ period/m);
    // Replacing or deleting the container is never expected.
    for (const actions of [['delete'], ['delete', 'create']]) {
      const lost = fixture();
      lost.plan.resource_changes.push({ address: 'azurerm_storage_container.content_archive', change: { actions } });
      expect(checkPlan(lost.plan).ok).toBe(false);
    }

    // Armed by the owner on 2026-11-24 ("arm now", #1811).
    expect(infraSource).toMatch(/^\s*"CONTENT_ARCHIVE_ENABLED"\s*=\s*"true"$/m);
    const block = /resource "azurerm_storage_container" "content_archive" \{[\s\S]*?\n\}/.exec(infraSource);
    expect(block, 'azurerm_storage_container.content_archive is not in infra/').not.toBeNull();
    expect(block[0]).toMatch(/name\s*=\s*"content-archive"/);
    expect(block[0]).toMatch(/container_access_type\s*=\s*"private"/);
    expect(block[0]).toMatch(/prevent_destroy\s*=\s*true/);
    // No lock and no timer-driven tiering or deletion for the archive (ADR 0046 sections 4 and 7).
    expect(infraSource).not.toMatch(/azurerm_storage_container\.content_archive\.(?:id|resource_manager_id)/);
    expect(infraSource).not.toMatch(/"content-archive\//);
  });

  it('no longer declares the Community Days key’s app setting: its run has applied, so a plan that adds it again is unexpected (#1823)', () => {
    expect(DECLARED.find((candidate) => candidate.path === 'app_settings.COMMUNITY_DAYS_API_KEY')).toBeUndefined();
    const added = fixture();
    added.app.after.app_settings.COMMUNITY_DAYS_API_KEY =
      '@Microsoft.KeyVault(SecretUri=https://kv-site-prod-cus-01.vault.azure.net/secrets/COMMUNITY-DAYS-API-KEY)';
    const result = checkPlan(added.plan);
    expect(result.ok).toBe(false);
    expect(result.unexpected.some((line) => line.includes('app_settings.COMMUNITY_DAYS_API_KEY'))).toBe(true);
  });

  it('no longer declares the Cloudflare admin token’s Key Vault reference now that it has applied, and reads the zone id by hand (#1905)', () => {
    // The reference was present on the live app on 2026-11-27, so a plan that adds it again is unexpected.
    expect(DECLARED.find((candidate) => candidate.path === 'app_settings.CLOUDFLARE_ADMIN_TOKEN')).toBeUndefined();
    const added = fixture();
    added.app.after.app_settings.CLOUDFLARE_ADMIN_TOKEN =
      '@Microsoft.KeyVault(SecretUri=https://kv-site-prod-cus-01.vault.azure.net/secrets/CLOUDFLARE-ADMIN-TOKEN)';
    const again = checkPlan(added.plan);
    expect(again.ok).toBe(false);
    expect(again.unexpected.some((line) => line.includes('app_settings.CLOUDFLARE_ADMIN_TOKEN'))).toBe(true);
    expect(infraSource).toContain('"CLOUDFLARE_ADMIN_TOKEN" = "@Microsoft.KeyVault(SecretUri=${azurerm_key_vault.hcw.vault_uri}secrets/CLOUDFLARE-ADMIN-TOKEN)"');
    // The zone id is the owner's value, so its arrival is shown, not declared.
    const zone = fixture();
    zone.app.after.app_settings.CF_ZONE_ID = '00000000000000000000000000000001';
    const result = checkPlan(zone.plan);
    expect(result.ok).toBe(false);
    expect(result.unexpected.some((line) => line.includes('app_settings.CF_ZONE_ID'))).toBe(true);
  });

  it('reads the owner’s own GSC values as unexpected, so they are checked by hand (#1612)', () => {
    const { plan, app } = fixture();
    app.before.app_settings.GSC_SERVICE_ACCOUNT_EMAIL = '';
    app.after.app_settings.GSC_SERVICE_ACCOUNT_EMAIL = 'sa-hcw-search-console@example-project.iam.gserviceaccount.com';
    const result = checkPlan(plan);
    expect(result.ok).toBe(false);
    expect(result.unexpected.some((line) => line.includes('app_settings.GSC_SERVICE_ACCOUNT_EMAIL'))).toBe(true);
  });

  it('names a changed timer schedule or any other setting riding along with an arming (#1403)', () => {
    const rows = treeTimerRows();
    const { plan, app } = fixture();
    app.before.app_settings.FEATURE_FLAG_SWEEP_VISITOR_SESSIONS = 'false';
    app.after.app_settings.FEATURE_FLAG_SWEEP_VISITOR_SESSIONS = 'true';
    app.after.app_settings.FEATURE_FLAG_SOMETHING_ELSE = 'false';
    // The sweep's row moved to another period: a query nothing declares.
    plan.resource_changes.push(
      timerRuleUpdate({
        address: 'azurerm_monitor_scheduled_query_rules_alert_v2.timer_overdue',
        before: overdueQuery(rows),
        after: overdueQuery(rows.map(([name, period, anchor]) => [name, name === 'sweepVisitorSessions' ? '5m' : period, anchor])),
      })
    );

    const result = checkPlan(plan);

    expect(result.ok).toBe(false);
    expect(result.unexpected.some((line) => line.includes('app_settings.FEATURE_FLAG_SOMETHING_ELSE'))).toBe(true);
    expect(result.unexpected.some((line) => line.includes('timer_overdue') && line.includes('criteria[0].query'))).toBe(true);
  });

  it('prunes the stateful-rule and export-latency entries once applied (#1207, #964, #970)', () => {
    // timer_overdue left this list while #1302, the Second Brain and #1403
    // declared the rule again (three rows more); those applied and were
    // deleted on 2026-11-01. It left it again for #1612's one row
    // (syncSearchConsole, applied and folded in by #1918) and #1918's
    // (checkCloudflareRateLimit, applied and folded in on 2026-11-27), and is
    // back. Take it out again while a later row is declared.
    const addresses = DECLARED.map((entry) => entry.address);
    for (const name of [
      'lab_hybrid_backup_missing_coder',
      'lab_hybrid_backup_missing_vault',
      'lab_hybrid_disk_used',
      'logs_daily_cap',
      'export_window_latency',
      'timer_overdue',
    ]) {
      expect(addresses, name).not.toContain(`azurerm_monitor_scheduled_query_rules_alert_v2.${name}`);
    }
  });

  it('prunes what applied by 2026-11-01 (Second Brain, Doc Vault, #1302, #1403, #1479), and keeps the arming plans', () => {
    const creates = DECLARED.filter((entry) => entry.action === 'create').map((entry) => entry.address);
    const deletes = DECLARED.filter((entry) => entry.action === 'delete').map((entry) => entry.address);
    // #1923 declared CF_ACCOUNT_ID and CF_WEB_ANALYTICS_SITE_TAG again, as
    // "" -> the owner's value, until that run applied on 2026-11-27; what was
    // pruned on 2026-11-01 is #1302's absent -> "". An owner's value declared
    // again by a later change is left to that change's own test.
    const paths = DECLARED.filter((entry) => entry.after !== OWNER_VALUE).map((entry) => entry.path);
    for (const name of ['brain_records', 'brain_search', 'doc_vault']) {
      expect(creates, name).not.toContain(`azurerm_cosmosdb_sql_container.hcw["${name}"]`);
    }
    // #1479's two container deletes are gone; the regex below reads them and
    // the five CODE_BRAIN_* paths together. Other deletes may be declared
    // (#1530's azapi_update_resource delete was the first after this, applied
    // and pruned on 2026-11-04), so the list is not asserted empty.
    expect(deletes.filter((address) => /code_brain/.test(address))).toEqual([]);
    expect(DECLARED.some((entry) => /code_brain|CODE_BRAIN_/.test(entry.address + (entry.path ?? '')))).toBe(false);
    for (const name of [
      'BRAIN_ENABLED', 'BRAIN_AI_ENABLED', 'BRAIN_OWNER_OID', 'BRAIN_OWNER_TENANT_ID', 'BRAIN_SYNC_CLIENT_ID',
      'CLOUDFLARE_ANALYTICS_TOKEN', 'CF_WEB_ANALYTICS_SITE_TAG', 'CF_ACCOUNT_ID', 'CODER_BROKER_TOKEN',
    ]) {
      expect(paths, name).not.toContain(`app_settings.${name}`);
    }
    // The arming plans stay: "not in this plan" cannot tell them from
    // applied, and each waits on a name the owner adds to enabled_timers. The
    // three left read "false" live on 2026-11-27; the audience read's applied
    // on 2026-11-28 and has no declaration left. The Web Analytics site, kept here
    // on 2026-11-01 and an import since #1923, applied on 2026-11-27 and has
    // no declaration left (its own test below).
    const arming = (flag) =>
      DECLARED.filter((entry) => entry.path === `app_settings.${flag}`).map((entry) => [entry.before, entry.after]);
    expect(arming('FEATURE_FLAG_AMBASSADOR_AUDIENCE_MONTHLY')).toEqual([]);
    expect(arming('FEATURE_FLAG_SWEEP_VISITOR_SESSIONS')).toEqual([['false', 'true']]);
    expect(arming('FEATURE_FLAG_PROBE_AI_PROVIDERS')).toEqual([['false', 'true']]);
    expect(arming('FEATURE_FLAG_SYNC_SEARCH_CONSOLE')).toEqual([['false', 'true']]);
    expect(DECLARED.filter((entry) => entry.address === 'cloudflare_web_analytics_site.hcw[0]')).toEqual([]);
  });

  it('keeps the imported Web Analytics site with no declaration left, no Web Analytics rule, and nothing that would recreate it (#1923, applied 2026-11-27)', () => {
    // The plan check on run-su7kVbxufZn3LPdW matched the nine declarations as DECLARED, and the owner's
    // apply of that run on 2026-11-27 imported the site and set enabled, lite and the two app settings, so
    // the nine were deleted. Nothing about the site or those settings is declared now, so the same run
    // again would be read by hand.
    const SITE = 'cloudflare_web_analytics_site.hcw[0]';
    expect(DECLARED.filter((entry) => entry.address === SITE)).toEqual([]);
    expect(
      DECLARED.filter((entry) => /^app_settings\.(CF_ACCOUNT_ID|CF_WEB_ANALYTICS_SITE_TAG)$/.test(entry.path ?? ''))
    ).toEqual([]);
    // The zone's Free plan allows no Web Analytics rules: Cloudflare refused both creates on 2026-11-27
    // (409, code 10012, maxRulesError). None is declared and none is in the configuration, so a rule added
    // back fails here before it fails every apply; the audience read filters by host instead.
    expect(DECLARED.filter((entry) => entry.address.startsWith('cloudflare_web_analytics_rule.'))).toEqual([]);
    expect(infraSource).not.toMatch(/resource\s+"cloudflare_web_analytics_rule"/);

    const block = (header, label) => {
      const start = infraSource.indexOf(`${header} {\n`);
      expect(start, `${label} not found`).toBeGreaterThanOrEqual(0);
      const body = infraSource.slice(start + header.length + 3);
      return body.slice(0, body.indexOf('\n}'));
    };
    const site = block('resource "cloudflare_web_analytics_site" "hcw"', 'the site');
    const imports = [...infraSource.matchAll(/^import \{\n([\s\S]*?)\n\}/gm)]
      .map((match) => match[1])
      .filter((body) => body.includes('cloudflare_web_analytics_site.hcw'));
    expect(imports).toHaveLength(1);
    const [importBlock] = imports;

    // One gate for both: both inputs set. With either missing, nothing is imported or created.
    expect(infraSource).toMatch(
      /^\s*web_analytics_managed\s*=\s*var\.cloudflare_account_id != null && var\.cloudflare_web_analytics_site_tag != null$/m
    );
    expect(site).toMatch(/^\s*count\s*=\s*local\.web_analytics_managed \? 1 : 0$/m);
    // The provider's import id is `<account_id>/<site_id>`; for_each makes the import conditional.
    expect(importBlock).toMatch(/^\s*to\s*=\s*cloudflare_web_analytics_site\.hcw\[0\]$/m);
    expect(importBlock).toMatch(/^\s*id\s*=\s*each\.value$/m);
    expect(importBlock).toContain(
      'for_each = local.web_analytics_managed ? { hcw = "${var.cloudflare_account_id}/${var.cloudflare_web_analytics_site_tag}" } : {}'
    );
    // for_each on an import block needs Terraform 1.7.
    expect(infraSource).toMatch(/^\s*required_version\s*=\s*"~> 1\.7"$/m);

    // The site as Cloudflare made it: on the zone, automatic setup written out (the provider reads it back), no host.
    expect(site).toMatch(/^\s*zone_tag\s*=\s*var\.cloudflare_zone_id$/m);
    expect(site).toMatch(/^\s*auto_install\s*=\s*true$/m);
    expect(site).toMatch(/^\s*enabled\s*=\s*true$/m);
    expect(site).toMatch(/^\s*lite\s*=\s*true$/m);
    expect(site).not.toMatch(/^\s*host\s*=/m);
    // Unsetting the inputs once the site is in state must stop the plan, not delete Cloudflare's site.
    expect(site).toMatch(/^\s*prevent_destroy\s*=\s*true$/m);
    // Once the import block is skipped, a changed tag must stop the plan, not be ignored
    // (infra/tests/guards.tftest.hcl runs the mismatch).
    expect(site).toMatch(/^\s*condition\s*=\s*self\.site_tag == var\.cloudflare_web_analytics_site_tag$/m);

    // The owner's run, as its plan JSON carried it: the import with its update and the Function
    // App's two settings. Every value is a placeholder; none is printed.
    const importId = 'account-placeholder/site-placeholder';
    const accountId = 'account-placeholder-0123456789abcdef';
    const siteTag = 'site-tag-placeholder-0123456789ab';
    const plan = expectedPlan();
    const app = plan.resource_changes.find((change) => change.address === EXPECTED.updated[0].address).change;
    Object.assign(app.before.app_settings, { CF_ACCOUNT_ID: '', CF_WEB_ANALYTICS_SITE_TAG: '' });
    Object.assign(app.after.app_settings, { CF_ACCOUNT_ID: accountId, CF_WEB_ANALYTICS_SITE_TAG: siteTag });
    plan.resource_changes.push(
      {
        address: SITE,
        change: {
          actions: ['update'],
          importing: { id: importId },
          before: {
            enabled: null,
            lite: null,
            auto_install: true,
            site_tag: siteTag,
            site_token: 'token-before',
            snippet: 'snippet-before',
            rules: [],
            ruleset: { id: 'ruleset-before', enabled: true },
          },
          after: { enabled: true, lite: true, auto_install: true, site_tag: siteTag },
          after_unknown: { site_token: true, snippet: true, rules: true, ruleset: true },
          before_sensitive: {},
          after_sensitive: {},
        },
      }
    );
    // That run has applied, so every part of it is unexpected now: the import, each site
    // attribute and both settings are named, and the report still prints none of the values.
    const result = checkPlan(plan);
    expect(result.ok).toBe(false);
    expect(result.declared).toEqual([]);
    const named = result.unexpected.join('\n');
    for (const part of [
      SITE,
      `${SITE}: update enabled`,
      `${SITE}: update lite`,
      ...['rules', 'ruleset', 'site_token', 'snippet'].map((path) => `${SITE}: update ${path}`),
      'app_settings.CF_ACCOUNT_ID',
      'app_settings.CF_WEB_ANALYTICS_SITE_TAG',
    ]) {
      expect(named, part).toContain(part);
    }
    for (const value of [importId, accountId, siteTag, 'token-before', 'snippet-before', 'ruleset-before']) {
      expect(named, value).not.toContain(value);
    }
  });

  // The site's two records (#1929), shared by the two tests below.
  const RECORDS = ['cloudflare_dns_record.site_apex', 'cloudflare_dns_record.site_www'];
  const COMMENTS = {
    [RECORDS[0]]: "The site's own address (Static Web App), apex; proxy switch: site_proxied_hosts",
    [RECORDS[1]]: "The site's own address (Static Web App), www; proxy switch: site_proxied_hosts",
  };
  // A record's in-place update as the provider plans it. `stamped` is a real change, which leaves
  // modified_on unknown until the apply (Terraform then omits it from `after`).
  const LIVE_TTL = { [RECORDS[0]]: 1, [RECORDS[1]]: 60 };
  const update = (address, changes, { stamped = true, from = {} } = {}) => {
    const before = {
      comment: COMMENTS[address],
      modified_on: '2026-11-27T19:21:00Z',
      proxied: false,
      ttl: LIVE_TTL[address],
      ...from,
    };
    const after = { ...before, ...changes };
    if (stamped) delete after.modified_on;
    return {
      address,
      change: {
        actions: ['update'],
        before,
        after,
        after_unknown: stamped ? { modified_on: true } : {},
        before_sensitive: {},
        after_sensitive: {},
      },
    };
  };
  const linesOf = (entries) => entries.map((entry) => `DECLARED    ${describeDeclaration(entry)}`);
  const declaredLines = (result) => declarationLines(result).filter((line) => line.startsWith('DECLARED'));
  const stampLine = (address) => `${address}: update modified_on: "2026-11-27T19:21:00Z" -> (known after apply)`;

  it('keeps the site records in state with no lookup or import left, DNS-only by default, and declares www’s step 1, forward and back (#1929, applied 2026-11-27; #1937)', () => {
    // The owner's apply of 2026-11-27 imported both records and wrote their comments (Cloudflare shows them
    // since about 19:21 UTC, DNS-only, the apex at ttl 1 and www at ttl 60), so the eight declarations, the
    // lookup and the two import blocks were deleted. The only declarations about www since are #1929 step 1's
    // three and its three going back (Part 3, steps 1 and 2 of docs/runbooks/proxy-site-hosts.md: the owner
    // sets site_proxied_hosts from "none" to "www", or back); the apex's step 4 is held by the next test.
    // Any other change to either record, the same import run again included, is UNEXPECTED and read by hand.
    const STEP = '#1929 step 1';
    const BACK = '#1929 step 1 back';
    expect(
      DECLARED.filter((entry) => entry.address === RECORDS[0]).map((entry) => entry.step),
      RECORDS[0]
    ).toEqual(['#1929 step 4', '#1929 step 4', '#1929 step 4 back', '#1929 step 4 back']);
    const wwwDeclared = DECLARED.filter((entry) => entry.address === RECORDS[1]);
    // proxied and ttl move together (`ttl = local.site_www_proxied ? 1 : 60`, held below), and modified_on is
    // the provider's to set: its ModifyPlan (5.29.0) leaves it unknown when proxied or ttl changes, keeps
    // comment_modified_on (the comment is unchanged), proxiable, meta, settings and tags from state, and sets
    // tags_modified_on to null with no tags; id and created_on are held by plan modifiers. So none of those is
    // declared. Both directions stay declared for as long as www is proxied (docs/runbooks/proxy-site-hosts.md).
    expect(wwwDeclared.map(({ path, step, before, after }) => [path, step, before, after])).toEqual([
      ['proxied', STEP, false, true],
      ['ttl', STEP, 60, 1],
      ['modified_on', STEP, undefined, KNOWN_AFTER_APPLY],
      ['proxied', BACK, true, false],
      ['ttl', BACK, 1, 60],
      ['modified_on', BACK, undefined, KNOWN_AFTER_APPLY],
    ]);
    const forward = wwwDeclared.filter((entry) => entry.step === STEP);
    const back = wwwDeclared.filter((entry) => entry.step === BACK);
    // The lookup is gone, so a record missing or renamed by hand no longer fails every plan in the workspace,
    // and no import block names either record.
    expect(infraSource).not.toMatch(/data\s+"cloudflare_dns_record"\s+"site"/);
    const imports = [...infraSource.matchAll(/^import \{\n([\s\S]*?)\n\}/gm)].map((match) => match[1]);
    for (const address of RECORDS) {
      expect(imports.filter((body) => body.includes(address)), address).toEqual([]);
    }

    const block = (header) => {
      const start = infraSource.indexOf(`${header} {\n`);
      expect(start, `${header} not found`).toBeGreaterThanOrEqual(0);
      const body = infraSource.slice(start + header.length + 3);
      return body.slice(0, body.indexOf('\n}'));
    };
    const apex = block('resource "cloudflare_dns_record" "site_apex"');
    const www = block('resource "cloudflare_dns_record" "site_www"');
    for (const [address, body] of [
      [RECORDS[0], apex],
      [RECORDS[1], www],
    ]) {
      // The content is the Static Web App's own default host, read from the resource, never a typed name.
      expect(body, address).toMatch(/^\s*content\s*=\s*azurerm_static_web_app\.hcw\.default_host_name$/m);
      expect(body, address).toMatch(/^\s*type\s*=\s*"CNAME"$/m);
      expect(body, address).toMatch(/^\s*zone_id\s*=\s*var\.cloudflare_zone_id$/m);
      // The comment the apply wrote: a different text here would plan an update on every run.
      expect(body, address).toContain(`comment = ${JSON.stringify(COMMENTS[address])}`);
      // These two records are the site: a plan that would delete or replace one stops.
      expect(body, address).toMatch(/^\s*prevent_destroy\s*=\s*true$/m);
      expect(body, address).toMatch(/^\s*ignore_changes\s*=\s*\[include_shadow_metadata\]$/m);
    }
    expect(apex).toMatch(/^\s*name\s*=\s*var\.domain$/m);
    expect(www).toMatch(/^\s*name\s*=\s*"www\.\$\{var\.domain\}"$/m);
    // Proxied follows the switch, www first and never the apex alone; www's ttl is 60 DNS-only (as made) and 1 proxied.
    expect(apex).toMatch(/^\s*proxied\s*=\s*local\.site_apex_proxied$/m);
    expect(apex).toMatch(/^\s*ttl\s*=\s*1$/m);
    expect(www).toMatch(/^\s*proxied\s*=\s*local\.site_www_proxied$/m);
    expect(www).toMatch(/^\s*ttl\s*=\s*local\.site_www_proxied \? 1 : 60$/m);
    expect(infraSource).toMatch(/^\s*site_www_proxied\s*=\s*contains\(\["www", "both"\], var\.site_proxied_hosts\)$/m);
    expect(infraSource).toMatch(/^\s*site_apex_proxied\s*=\s*var\.site_proxied_hosts == "both"$/m);

    // The switch defaults to "none", so the records stay as they are, and takes only the three values.
    const variable = block('variable "site_proxied_hosts"');
    expect(variable).toMatch(/^\s*default\s*=\s*"none"$/m);
    expect(variable).toContain('contains(["none", "www", "both"], var.site_proxied_hosts)');

    const PROXIED = { proxied: true, ttl: 1 };
    const DNS_ONLY = { proxied: false, ttl: 60 };
    const forwardPlan = () => {
      const plan = expectedPlan();
      plan.resource_changes.push(update(RECORDS[1], PROXIED));
      return plan;
    };
    const backPlan = () => {
      const plan = expectedPlan();
      plan.resource_changes.push(update(RECORDS[1], DNS_ONLY, { from: PROXIED }));
      return plan;
    };

    // Step 1's own run: www proxied, its ttl to automatic and modified_on unknown. It reads as step 1's three
    // DECLARED lines beside the permanent diff and nothing else, the going-back step as NOTEs.
    const passed = checkPlan(forwardPlan());
    expect(passed.unexpected).toEqual([]);
    expect(passed.ok).toBe(true);
    expect(passed.declared).toEqual(forward);
    expect(declaredLines(passed)).toEqual(linesOf(forward));
    for (const entry of back) expect(passed.unused).toContain(entry);
    expect(linesOf(forward).join('\n')).toContain(`${RECORDS[1]} proxied: false -> true`);
    expect(linesOf(forward).join('\n')).toContain(`${RECORDS[1]} ttl: 60 -> 1`);
    expect(linesOf(forward).join('\n')).toContain(`${RECORDS[1]} modified_on: (known after apply)`);

    // The going-back run (www to "none": step 2's test, or a rollback) reads as the back step's three alone.
    const wentBack = checkPlan(backPlan());
    expect(wentBack.unexpected).toEqual([]);
    expect(wentBack.ok).toBe(true);
    expect(wentBack.declared).toEqual(back);
    expect(declaredLines(wentBack)).toEqual(linesOf(back));
    expect(linesOf(back).join('\n')).toContain(`${RECORDS[1]} proxied: true -> false`);
    expect(linesOf(back).join('\n')).toContain(`${RECORDS[1]} ttl: 1 -> 60`);

    // Both directions on one address, in either order in the list (the reviewer's simulation on #1929 step 1's
    // pull request): each run is credited with its own three, whichever step comes first. Before the fix a
    // modified_on credited to the first step alone opened that step, and the other's values read as missing.
    for (const order of [
      [...forward, ...back],
      [...back, ...forward],
    ]) {
      for (const [name, plan, own] of [
        ['forward', forwardPlan(), forward],
        ['back', backPlan(), back],
      ]) {
        const result = checkPlan(plan, { declared: order });
        expect(result.unexpected, `${name}, ${order[0].step} first`).toEqual([]);
        expect(result.ok, `${name}, ${order[0].step} first`).toBe(true);
        expect(declaredLines(result), `${name}, ${order[0].step} first`).toEqual(linesOf(own));
      }
    }
    // The back step without `step` beside step 1 still reads clean: every covering declaration is credited,
    // and step 1's modified_on alone does not open step 1.
    const backLoose = back.map(({ step: _step, ...rest }) => rest);
    expect(checkPlan(backPlan(), { declared: [...forward, ...backLoose] }).unexpected).toEqual([]);

    // An unrelated change to www (its comment, here), with both steps declared: the comment is named, and so
    // is the modified_on the provider leaves unknown with it. Both steps' computed entries match that unknown
    // value, but neither step is in the plan, and a step's computed entry covers its value only while its step
    // is. There is no "missing" line and nothing is credited.
    const STAMP_LINE = stampLine(RECORDS[1]);
    for (const declared of [DECLARED, forward]) {
      const commented = expectedPlan();
      commented.resource_changes.push(update(RECORDS[1], { comment: 'A different comment' }));
      const result = checkPlan(commented, { declared });
      expect(result.ok).toBe(false);
      expect(result.unexpected).toEqual([
        `${RECORDS[1]}: update comment: ${JSON.stringify(COMMENTS[RECORDS[1]])} -> "A different comment"`,
        STAMP_LINE,
      ]);
      expect(result.declared.filter((entry) => entry.address === RECORDS[1])).toEqual([]);
    }

    // A lone unknown modified_on on www, nothing else changing: neither step is in the plan, so it is named.
    const stampOnly = expectedPlan();
    stampOnly.resource_changes.push(update(RECORDS[1], {}));
    const lone = checkPlan(stampOnly);
    expect(lone.ok).toBe(false);
    expect(lone.unexpected).toEqual([STAMP_LINE]);
    expect(lone.declared.filter((entry) => entry.address === RECORDS[1])).toEqual([]);

    // The same run with an apex change that is not the apex's step (its ttl off automatic, here): each of the
    // apex's changes is named, its modified_on included, since step 4 is not in the plan; www's step still matches.
    const withApex = expectedPlan();
    withApex.resource_changes.push(update(RECORDS[1], { proxied: true, ttl: 1 }), update(RECORDS[0], { ttl: 60 }));
    const apexChanged = checkPlan(withApex);
    expect(apexChanged.ok).toBe(false);
    expect(apexChanged.declared).toEqual(forward);
    expect(apexChanged.unexpected).toEqual([`${RECORDS[0]}: update ttl: 1 -> 60`, stampLine(RECORDS[0])]);

    // www proxied with its ttl left at 60 is not step 1, although each change it does carry is declared:
    // the step's ttl is named as missing, and it is not also printed as a NOTE.
    const ttlKept = expectedPlan();
    ttlKept.resource_changes.push(update(RECORDS[1], { proxied: true }));
    const partial = checkPlan(ttlKept);
    expect(partial.ok).toBe(false);
    const ttlDeclaration = forward.find((entry) => entry.path === 'ttl');
    expect(partial.unexpected).toEqual([describeIncomplete(ttlDeclaration)]);
    expect(partial.unexpected[0]).toContain(`${RECORDS[1]} ttl: 60 -> 1`);
    expect(partial.unexpected[0]).toContain(`step "${STEP}"`);
    expect(partial.unused).not.toContain(ttlDeclaration);

    // The ttl alone, www still DNS-only, is not step 1 either: proxied is named as missing.
    const ttlOnly = expectedPlan();
    ttlOnly.resource_changes.push(update(RECORDS[1], { ttl: 1 }));
    expect(checkPlan(ttlOnly).unexpected).toEqual([
      describeIncomplete(forward.find((entry) => entry.path === 'proxied')),
    ]);

    // Going back with the ttl left at 1 is not the back step either: its ttl is named as missing.
    const backTtlKept = expectedPlan();
    backTtlKept.resource_changes.push(update(RECORDS[1], { proxied: false }, { from: PROXIED }));
    expect(checkPlan(backTtlKept).unexpected).toEqual([
      describeIncomplete(back.find((entry) => entry.path === 'ttl')),
    ]);

    // With no www change at all (before the owner's run, or between runs) all six are NOTEs only.
    const quiet = checkPlan(expectedPlan());
    expect(quiet.ok).toBe(true);
    for (const entry of wwwDeclared) expect(quiet.unused).toContain(entry);

    // An apex TTL that moves off automatic is not declared, so it is named.
    const apexTtl = expectedPlan();
    apexTtl.resource_changes.push(update(RECORDS[0], { ttl: 60 }, { stamped: false }));
    expect(checkPlan(apexTtl).unexpected).toEqual([`${RECORDS[0]}: update ttl: 1 -> 60`]);

    // The first apply's own shape, an import adding the comment, is no longer declared either.
    const again = expectedPlan();
    const reimport = update(RECORDS[0], {}, { stamped: false });
    reimport.change.importing = { id: 'zone-placeholder/record-placeholder' };
    reimport.change.before.comment = null;
    again.resource_changes.push(reimport);
    const result = checkPlan(again);
    expect(result.ok).toBe(false);
    expect(result.declared).toEqual([]);
    expect(result.unexpected.join('\n')).toContain(RECORDS[0]);
    expect(result.unexpected.join('\n')).not.toContain('record-placeholder');
  });

  it('declares the apex’s step 4, forward and back, and nothing else on the apex (#1929, Part 3 step 4)', () => {
    // The owner sets site_proxied_hosts from "www" to "both" (or back): only the apex changes, its proxied and
    // the modified_on the provider leaves unknown with it. The apex's ttl is fixed at 1 in infra/frontend.tf,
    // and www stays proxied at ttl 1, so neither changes. The provider's ModifyPlan (5.29.0) copies settings
    // from state when the config does not set it, keeps comment_modified_on with the comment unchanged and
    // sets tags_modified_on to null with no tags, so none of those is declared.
    const [APEX, WWW] = RECORDS;
    const STEP = '#1929 step 4';
    const BACK = '#1929 step 4 back';
    const apexDeclared = DECLARED.filter((entry) => entry.address === APEX);
    expect(apexDeclared.map(({ path, step, before, after }) => [path, step, before, after])).toEqual([
      ['proxied', STEP, false, true],
      ['modified_on', STEP, undefined, KNOWN_AFTER_APPLY],
      ['proxied', BACK, true, false],
      ['modified_on', BACK, undefined, KNOWN_AFTER_APPLY],
    ]);
    const forward = apexDeclared.filter((entry) => entry.step === STEP);
    const back = apexDeclared.filter((entry) => entry.step === BACK);
    const wwwForward = DECLARED.filter((entry) => entry.step === '#1929 step 1');
    const wwwBack = DECLARED.filter((entry) => entry.step === '#1929 step 1 back');
    expect(wwwForward.length).toBe(3);
    expect(wwwBack.length).toBe(3);

    const PROXIED = { proxied: true, ttl: 1 };
    const planWith = (...changes) => {
      const plan = expectedPlan();
      plan.resource_changes.push(...changes);
      return plan;
    };
    const forwardPlan = () => planWith(update(APEX, { proxied: true }));
    const backPlan = () => planWith(update(APEX, { proxied: false }, { from: { proxied: true } }));

    // Step 4's own run reads as its two DECLARED lines beside the permanent diff and nothing else; the going-back
    // step and both of www's are NOTEs.
    const passed = checkPlan(forwardPlan());
    expect(passed.unexpected).toEqual([]);
    expect(passed.ok).toBe(true);
    expect(passed.declared).toEqual(forward);
    expect(declaredLines(passed)).toEqual(linesOf(forward));
    expect(linesOf(forward)).toEqual([
      `DECLARED    ${APEX} proxied: false -> true (${forward[0].reason})`,
      `DECLARED    ${APEX} modified_on: (known after apply) (${forward[1].reason})`,
    ]);
    for (const entry of [...back, ...wwwForward, ...wwwBack]) expect(passed.unused).toContain(entry);

    // The going-back run (both -> www) reads as the back step's two alone.
    const wentBack = checkPlan(backPlan());
    expect(wentBack.unexpected).toEqual([]);
    expect(wentBack.ok).toBe(true);
    expect(wentBack.declared).toEqual(back);
    expect(declaredLines(wentBack)).toEqual(linesOf(back));
    expect(linesOf(back).join('\n')).toContain(`${APEX} proxied: true -> false`);

    // Both directions on one address, in either order in the list: each run is credited with its own two.
    for (const order of [
      [...forward, ...back],
      [...back, ...forward],
    ]) {
      for (const [name, plan, own] of [
        ['forward', forwardPlan(), forward],
        ['back', backPlan(), back],
      ]) {
        const result = checkPlan(plan, { declared: order });
        expect(result.unexpected, `${name}, ${order[0].step} first`).toEqual([]);
        expect(result.ok, `${name}, ${order[0].step} first`).toBe(true);
        expect(declaredLines(result), `${name}, ${order[0].step} first`).toEqual(linesOf(own));
      }
    }

    // Step 4 with the apex's ttl moving too: the ttl is fixed at 1 and declared nowhere, so it is named,
    // while step 4's own two still match.
    const ttlMoved = checkPlan(planWith(update(APEX, { proxied: true, ttl: 60 })));
    expect(ttlMoved.ok).toBe(false);
    expect(ttlMoved.unexpected).toEqual([`${APEX}: update ttl: 1 -> 60`]);
    expect(ttlMoved.declared).toEqual(forward);
    // The same going back.
    const backTtlMoved = checkPlan(
      planWith(update(APEX, { proxied: false, ttl: 60 }, { from: { proxied: true } }))
    );
    expect(backTtlMoved.unexpected).toEqual([`${APEX}: update ttl: 1 -> 60`]);

    // A www change in the same run that is not a whole www step is named: its comment, with the modified_on
    // the provider leaves unknown with it (neither www step is in the plan) ...
    const wwwComment = checkPlan(
      planWith(
        update(APEX, { proxied: true }),
        update(WWW, { comment: 'A different comment' }, { from: PROXIED })
      )
    );
    expect(wwwComment.ok).toBe(false);
    expect(wwwComment.unexpected).toEqual([
      `${WWW}: update comment: ${JSON.stringify(COMMENTS[WWW])} -> "A different comment"`,
      stampLine(WWW),
    ]);
    expect(wwwComment.declared).toEqual(forward);
    // ... www taken off the proxy with its ttl left at 1, which names step 1 back's missing ttl ...
    const wwwPartial = checkPlan(
      planWith(update(APEX, { proxied: true }), update(WWW, { proxied: false }, { from: PROXIED }))
    );
    expect(wwwPartial.ok).toBe(false);
    expect(wwwPartial.unexpected).toEqual([describeIncomplete(wwwBack.find((entry) => entry.path === 'ttl'))]);
    // ... and a lone unknown modified_on on www.
    const wwwStamp = checkPlan(planWith(update(APEX, { proxied: true }), update(WWW, {}, { from: PROXIED })));
    expect(wwwStamp.unexpected).toEqual([stampLine(WWW)]);

    // A whole www step beside the apex's is the run that moves both names at once (the certificate procedure in
    // the runbook's "Going back"): "none" -> "both" and "both" -> "none" each read clean, each step on its record.
    const bothOn = checkPlan(planWith(update(WWW, PROXIED), update(APEX, { proxied: true })));
    expect(bothOn.unexpected).toEqual([]);
    expect(bothOn.ok).toBe(true);
    expect(declaredLines(bothOn)).toEqual(linesOf([...wwwForward, ...forward]));
    const bothOff = checkPlan(
      planWith(
        update(WWW, { proxied: false, ttl: 60 }, { from: PROXIED }),
        update(APEX, { proxied: false }, { from: { proxied: true } })
      )
    );
    expect(bothOff.unexpected).toEqual([]);
    expect(bothOff.ok).toBe(true);
    expect(declaredLines(bothOff)).toEqual(linesOf([...wwwBack, ...back]));

    // A lone unknown modified_on on the apex opens neither of its steps, so it is named.
    const apexStamp = checkPlan(planWith(update(APEX, {})));
    expect(apexStamp.ok).toBe(false);
    expect(apexStamp.unexpected).toEqual([stampLine(APEX)]);
    expect(apexStamp.declared).toEqual([]);

    // With no apex change at all, all four are NOTEs only.
    const quiet = checkPlan(expectedPlan());
    expect(quiet.ok).toBe(true);
    for (const entry of apexDeclared) expect(quiet.unused).toContain(entry);
  });

  it('prunes the Developer API container’s create once applied, with the container still in the spec (#1754, pruned 2026-11-27)', () => {
    // The create applied by 2026-11-27, so a plan that creates it again is unexpected. The container stays
    // in infra/cosmos-containers.json: a declaration pruned while its container was also removed would hide
    // a destroy of the calls for speakers.
    const address = 'azurerm_cosmosdb_sql_container.hcw["developer_events"]';
    expect(DECLARED.filter((entry) => entry.address === address)).toEqual([]);
    const spec = JSON.parse(readFileSync(join(HERE, '..', 'infra', 'cosmos-containers.json'), 'utf8'));
    expect(spec.containers.map((entry) => entry.name)).toContain('developer_events');
    const again = expectedPlan();
    again.resource_changes.push({ address, change: { actions: ['create'] } });
    expect(checkPlan(again).unexpected).toEqual([`${address}: create`]);
  });

  it('prunes what applied by 2026-11-28, keeps the three arming plans and #1929 steps 1 and 4 both ways, and nothing else', () => {
    // The plan check on run-su7kVbxufZn3LPdW matched #1923's nine entries as DECLARED (they applied in that
    // run) and printed every other entry pruned that day as "declared, not in this plan"; run-uBChZAdiYBb1Rma1's
    // plan (commit a7aa1077) matched no declaration. Each pruned change is unconditional in infra/ or was read
    // live that day. What stays waits on the owner: three arming plans (each flag live "false"; the audience read's,
    // a fourth, applied on 2026-11-28 and was pruned that day, its own test above). The two role
    // assignments counted on storage_firewall_remover_enabled and lab_arc_run_command_enabled were pruned too,
    // once the owner confirmed on 2026-11-27 that both workspace variables are true (both assignments were
    // read live that day); docs/standards/required-inputs.md §4.1 records both as SET. Since then, #1929
    // step 1's www entries, forward (site_proxied_hosts "none" -> "www") and back, stay for as long as www is
    // proxied, step 4 included: they go only when the site goes back to "none" for good. #1929 step 4's apex
    // entries, forward ("www" -> "both") and back, stay for as long as the apex is proxied.
    const values = (entry) =>
      entry.after === KNOWN_AFTER_APPLY ? '(known after apply)' : `${entry.before} -> ${entry.after}`;
    expect(DECLARED.map((entry) => `${entry.address} ${entry.action ?? `${entry.path}: ${values(entry)}`}`)).toEqual([
      `${FUNCTION_APP} app_settings.FEATURE_FLAG_PROBE_AI_PROVIDERS: false -> true`,
      'cloudflare_dns_record.site_www proxied: false -> true',
      'cloudflare_dns_record.site_www ttl: 60 -> 1',
      'cloudflare_dns_record.site_www modified_on: (known after apply)',
      'cloudflare_dns_record.site_www proxied: true -> false',
      'cloudflare_dns_record.site_www ttl: 1 -> 60',
      'cloudflare_dns_record.site_www modified_on: (known after apply)',
      'cloudflare_dns_record.site_apex proxied: false -> true',
      'cloudflare_dns_record.site_apex modified_on: (known after apply)',
      'cloudflare_dns_record.site_apex proxied: true -> false',
      'cloudflare_dns_record.site_apex modified_on: (known after apply)',
      `${FUNCTION_APP} app_settings.FEATURE_FLAG_SWEEP_VISITOR_SESSIONS: false -> true`,
      `${FUNCTION_APP} app_settings.FEATURE_FLAG_SYNC_SEARCH_CONSOLE: false -> true`,
    ]);
    // The two pruned role assignments are still in infra/, counted on their workspace variable, so the prune
    // hides no destroy. The default in the tree stays false (a fresh workspace plans nothing until the owner
    // has made the role); the workspace holds true, so a plan that destroys either is UNEXPECTED and read.
    for (const [name, variable] of [
      ['github_manifest_window_storage_firewall', 'storage_firewall_remover_enabled'],
      ['github_arc_run_operator', 'lab_arc_run_command_enabled'],
    ]) {
      expect(infraSource, name).toMatch(
        new RegExp(`resource "azurerm_role_assignment" "${name}" \\{\\n\\s*count\\s*=\\s*var\\.${variable} \\? 1 : 0\\n`)
      );
      expect(variableBlock(variable), variable).toMatch(/^\s*default\s*=\s*false$/m);
    }
    // The pruned creates and settings are still in infra/, so the prune hides no destroy or removal.
    for (const [type, name] of [
      ['azurerm_user_assigned_identity', 'github_arc_run'],
      ['azurerm_federated_identity_credential', 'github_arc_run_env_lab_host_arc'],
      ['azurerm_federated_identity_credential', 'github_arc_run_env_lab_host_arc_immutable'],
      ['azurerm_storage_container', 'interviews_audio'],
      ['azurerm_role_assignment', 'func_interviews_audio_owner'],
      ['azurerm_monitor_scheduled_query_rules_alert_v2', 'host_storage_auth'],
      ['azurerm_monitor_scheduled_query_rules_alert_v2', 'app_exceptions'],
    ]) {
      expect(infraSource, name).toContain(`resource "${type}" "${name}" {`);
    }
    expect(infraSource).toMatch(/^\s*name\s*=\s*"expire-interview-audio"$/m);
    expect(infraSource).toMatch(/^\s*"LABS_VISITOR_SESSIONS_ENABLED"\s*=\s*var\.labs_visitor_sessions_enabled/m);
    expect(infraSource).toMatch(/^\s*BRAIN_INDEX_RECONCILE\s*=\s*"brainIndexReconcile — /m);
    expect(infraSource).toContain('"CLOUDFLARE_ADMIN_TOKEN" = "@Microsoft.KeyVault(');
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

  it('prunes the hcw database grant’s create once applied, declares any later key, and keeps the account-wide grant gone from infra/ with no declaration left (#1469 steps 1 and 2, both pruned 2026-11-04)', () => {
    // Step 1 of #1469 added `func_cosmos_db["hcw"]` beside `func_cosmos`. Its
    // create applied in run-vUQrQLSGJh4J5HZ2 on 2026-11-04 and left DECLARED,
    // so the `hcw` key is in state and must not be declared again. A key added
    // to the local later plans a create of its own and must be declared, or
    // the plan check reads it as UNEXPECTED. Step 2 deleted the `func_cosmos`
    // block (#1544) and declared the delete; that delete applied in
    // run-DvAMt2zE3XU4es4h on 2026-11-04 and the declaration was pruned. So
    // now neither the block nor a declaration of it may exist: the block back
    // in infra/ would plan an undeclared create of the account-wide grant the
    // two steps removed, and a declaration left behind would wave through a
    // later destroy of something that is no longer in state.
    const applied = ['hcw'];
    const block = /^\s*cosmos_database_grants\s*=\s*\{\n([\s\S]*?)\n\s*\}\n/m.exec(infraSource);
    expect(block, 'local.cosmos_database_grants not found in infra/').not.toBeNull();
    const keys = [...block[1].matchAll(/^\s*(\w+)\s*=/gm)].map((m) => m[1]);
    // The applied keys must still be in the local (a key removed from it would
    // plan a destroy); keys may be added beside them, declared below.
    expect(keys).toEqual(expect.arrayContaining(applied));
    const creates = DECLARED.filter((entry) => entry.action === 'create').map((entry) => entry.address);
    const grantAddress = (key) => `azurerm_cosmosdb_sql_role_assignment.func_cosmos_db["${key}"]`;
    for (const key of applied) expect(creates, `${key} applied and is still declared`).not.toContain(grantAddress(key));
    for (const key of keys.filter((key) => !applied.includes(key))) {
      expect(creates, `${key} is a new grant with no declaration`).toContain(grantAddress(key));
    }
    const accountGrantStands = /^resource "azurerm_cosmosdb_sql_role_assignment" "func_cosmos" \{/m.test(infraSource);
    const accountGrantDeleteDeclared = DECLARED.some(
      (entry) => entry.action === 'delete' && entry.address === 'azurerm_cosmosdb_sql_role_assignment.func_cosmos'
    );
    expect(accountGrantStands, 'the account-wide grant func_cosmos is back in infra/ (step 2 of #1469 removed it)').toBe(false);
    expect(accountGrantDeleteDeclared, 'func_cosmos’s delete applied in run-DvAMt2zE3XU4es4h and is still declared').toBe(false);
    // No Cosmos data-plane role assignment in infra/ may be scoped to the
    // whole account again.
    expect(accountScopedCosmosGrants(infraSource), 'a Cosmos role assignment is scoped to the whole account').toEqual([]);
  });

  it('reads an account-scoped Cosmos grant whatever the account resource is called and whatever trails the scope line (#1469 step 2)', () => {
    // The reader above is only as good as its regex, so it is exercised on
    // the shapes a block could take: database grants (ignored, bare or
    // interpolated), the account id with a trailing comment, under another
    // account resource name, with odd spacing, names with hyphens (valid
    // Terraform identifiers), and the account id as the whole of an
    // interpolated string, which evaluates to the same scope.
    const block = (name, scope) =>
      `resource "azurerm_cosmosdb_sql_role_assignment" "${name}" {\n  scope = ${scope}\n}\n`;
    const source = [
      block('db_grant', '"${azurerm_cosmosdb_account.hcw.id}/dbs/${each.value}"'),
      block('db_grant_spaced', '"${ azurerm_cosmosdb_account.hcw.id }/dbs/hcw"'),
      block('commented', 'azurerm_cosmosdb_account.hcw.id # account scope'),
      block('slashes', 'azurerm_cosmosdb_account.hcw.id // account scope'),
      block('other_account', 'azurerm_cosmosdb_account.scratch.id'),
      block('spaced', '   azurerm_cosmosdb_account.hcw.id   '),
      block('func-cosmos', 'azurerm_cosmosdb_account.hcw-prod.id'),
      block('interpolated', '"${azurerm_cosmosdb_account.hcw.id}"'),
      block('interpolated_spaced', '"${ azurerm_cosmosdb_account.hcw.id }" # same scope'),
      block('trailing_slash', '"${azurerm_cosmosdb_account.hcw.id}/"'),
    ].join('\n');
    expect(accountScopedCosmosGrants(source)).toEqual([
      'commented',
      'slashes',
      'other_account',
      'spaced',
      'func-cosmos',
      'interpolated',
      'interpolated_spaced',
      'trailing_slash',
    ]);
  });

  it('prunes #1617’s three applied deletes with their blocks gone from infra/, and PR 1’s six applied creates with their blocks kept', () => {
    // PR 2 deleted the deploy identity's production pair and its site role,
    // once deploy-functions.yml named production-backend and the frontend
    // signed in as github_frontend_deploy. The deletes applied by 2026-11-27
    // and their declarations went. Their blocks stay gone from the tree: a
    // block put back would plan an undeclared create of a trust PR 2 removed.
    const byAction = (action) => DECLARED.filter((entry) => entry.action === action).map((entry) => entry.address);
    const block = (address) => `resource "${address.split('.')[0]}" "${address.split('.')[1]}"`;
    for (const address of [
      'azurerm_federated_identity_credential.github_production',
      'azurerm_federated_identity_credential.github_production_immutable',
      'azurerm_role_assignment.github_deploy_swa_token',
    ]) {
      expect(byAction('delete'), address).not.toContain(address);
      expect(infraSource, `${address} is still declared in infra/`).not.toContain(`${block(address)} {`);
    }
    // PR 1's six creates applied on 2026-11-09 (the commit status on
    // 3ba8f791). Their declarations go; their resources stay, because a
    // declaration pruned while its resource was also removed would hide a
    // destroy of the frontend identity or the backend's trust.
    for (const address of [
      'azurerm_user_assigned_identity.github_frontend_deploy',
      'azurerm_federated_identity_credential.github_frontend_deploy_env_production',
      'azurerm_federated_identity_credential.github_frontend_deploy_env_production_immutable',
      'azurerm_role_assignment.github_frontend_deploy_swa_token',
      'azurerm_federated_identity_credential.github_production_backend',
      'azurerm_federated_identity_credential.github_production_backend_immutable',
    ]) {
      expect(byAction('create'), address).not.toContain(address);
      expect(byAction('delete'), address).not.toContain(address);
      expect(infraSource, `${address} is gone from infra/`).toContain(`${block(address)} {`);
    }
  });

  it('prunes the Cosmos request-log filter’s four entries once applied, with their resources still in infra/ and the azapi table gone (#1530, pruned 2026-11-04)', () => {
    // run-fQRFPxBy7CowV6zG applied the delete and the three creates on
    // 2026-11-04. The declarations go; the three resources stay in the tree
    // (a declaration pruned while its resource was also removed would hide a
    // destroy), and the azapi_update_resource the delete retired is gone.
    // Only the applied actions are asserted gone: a later update to one of
    // the three resources (the rule's KQL, say) is declared by path in the
    // usual way and must not trip this.
    const byAction = (action) => DECLARED.filter((entry) => entry.action === action).map((entry) => entry.address);
    expect(byAction('delete')).not.toContain('azapi_update_resource.cosmos_data_plane_table');
    expect(infraSource).not.toContain('"cosmos_data_plane_table"');
    for (const [type, name] of [
      ['azurerm_log_analytics_workspace_table', 'cosmos_data_plane'],
      ['azurerm_monitor_data_collection_rule', 'workspace_transforms'],
      ['azurerm_monitor_scheduled_query_rules_alert_v2', 'logs_over_quota'],
    ]) {
      expect(byAction('create'), name).not.toContain(`${type}.${name}`);
      expect(infraSource, `${name} is no longer declared in infra/`).toContain(`resource "${type}" "${name}"`);
    }
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
    const match = /^\s*default\s*=\s*([^\n]+)$/m.exec(variableBlock(name));
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

  it('no longer declares alert-lab-ssh-login’s loopback rule or description now that #953 stage 3 has applied (pruned 2026-11-27)', () => {
    // Read live on 2026-11-27: the rule's query says `let LoopbackOnly = true;` and its description is the
    // tree's. So the stage 3 plan again (false -> true) is unexpected, and so is turning the loopback off.
    const address = 'azurerm_monitor_scheduled_query_rules_alert_v2.lab_hybrid_ssh_login_unexpected';
    expect(DECLARED.filter((entry) => entry.address === address)).toEqual([]);
    for (const [before, after] of [
      [false, true],
      [true, false],
    ]) {
      const plan = expectedPlan();
      plan.resource_changes.push({
        address,
        change: {
          actions: ['update'],
          before: { criteria: [{ query: sshLoginAlertQuery(before) }] },
          after: { criteria: [{ query: sshLoginAlertQuery(after) }] },
          after_unknown: {},
          before_sensitive: {},
          after_sensitive: {},
        },
      });
      const result = checkPlan(plan);
      expect(result.ok, `${before} -> ${after}`).toBe(false);
      expect(result.unexpected.some((line) => line.includes('criteria[0].query')), `${before} -> ${after}`).toBe(true);
    }
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
