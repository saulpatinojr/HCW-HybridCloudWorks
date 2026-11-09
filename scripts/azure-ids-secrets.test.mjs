/**
 * The Azure ids the workflows sign in with are read from repository SECRETS,
 * never from repository variables: the two subscription ids since #1610, and
 * the tenant id and the six client ids since #1618, and the frontend
 * deploy's client id since #1617.
 *
 * This repository is public, so every Actions log is public. GitHub prints a
 * step's `env:` and `with:` values in its log, and it masks a value as `***`
 * only when it came from a secret; a variable is printed as it is. Since
 * 2026-11-09 the owner keeps these ids as secrets, so a workflow that
 * reads `vars.<one of them>` would print a real id again (and, once the
 * variables are deleted, would read an empty value). This test fails on any
 * such read in .github/workflows, comments included, and holds the script
 * that seeds the repository's variables to the same rule.
 *
 * Deliberately NOT in the list, with the reason:
 * - VITE_ENTRA_CLIENT_ID and VITE_ENTRA_TENANT_ID are built into the public
 *   website's JavaScript for sign-in, so anyone can read them from the site
 *   and masking them in a log would hide nothing.
 * - MANIFEST_APP_ID and COPILOT_REVIEW_APP_ID are numeric GitHub App ids, and
 *   the CLOUDFLARE_* values are Cloudflare's; none is an Azure id.
 *
 * Before #1618 this file was scripts/subscription-id-secrets.test.mjs.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOWS = join(REPO, '.github', 'workflows');
const files = readdirSync(WORKFLOWS).filter((name) => /\.ya?ml$/.test(name));

/** The ids kept as secrets: two since #1610, seven since #1618, one since #1617. */
const SUBSCRIPTION_IDS = ['SUBSCRIPTION_ID', 'SUBSCRIPTION_MGMT_ID'];
const TENANT_AND_CLIENT_IDS = [
  'TENANT_ID',
  'CLIENT_ID',
  'READER_CLIENT_ID',
  'MANIFEST_WINDOW_CLIENT_ID',
  'COPILOT_REVIEW_CLIENT_ID',
  'ARC_RUN_CLIENT_ID',
  'ALERT_READER_CLIENT_ID',
  'FRONTEND_DEPLOY_CLIENT_ID',
];
const SECRET_IDS = [...SUBSCRIPTION_IDS, ...TENANT_AND_CLIENT_IDS];
const NAMES = SECRET_IDS.join('|');
const VARS_READ = new RegExp(`\\bvars\\s*\\.\\s*(${NAMES})\\b|\\bvars\\s*\\[\\s*['"](${NAMES})['"]\\s*\\]`);

/** Each line of `text` that matches `pattern`, as `file:line: text`. */
function hits(file, text, pattern) {
  return text
    .split(/\r?\n/)
    .map((line, i) => [line, i + 1])
    .filter(([line]) => pattern.test(line))
    .map(([line, n]) => `${file}:${n}: ${line.trim()}`);
}

/** The workflows that read `secrets.<name>` inside an expression. */
function readersOf(name) {
  const read = new RegExp(`\\$\\{\\{[^}]*secrets\\.${name}\\b[^}]*\\}\\}`);
  return files.filter((file) => read.test(readFileSync(join(WORKFLOWS, file), 'utf8')));
}

describe('Azure ids come from secrets, so public logs show ***', () => {
  it('finds the workflows to check', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it('no workflow reads one of the ids from vars', () => {
    const found = files.flatMap((file) => hits(file, readFileSync(join(WORKFLOWS, file), 'utf8'), VARS_READ));
    expect(found, `read secrets.<name> instead for ${SECRET_IDS.join(', ')} (#1610, #1618)`).toEqual([]);
  });

  it('the workflows that sign in to a subscription read it from the secret', () => {
    // A sanity floor, so a rename that drops every read is noticed: the
    // deploys, the monitors, the alert check, the Arc run and Copilot's setup.
    expect(readersOf('SUBSCRIPTION_ID').length).toBeGreaterThanOrEqual(9);
    expect(readFileSync(join(WORKFLOWS, 'verify-alert-state.yml'), 'utf8')).toContain('${{ secrets.SUBSCRIPTION_MGMT_ID }}');
  });

  // Every `azure/login` step, found by parsing each workflow rather than by
  // counting files that mention a secret, so a login that loses its tenant or
  // subscription secret fails here even if another workflow gains a stray read.
  const logins = files.flatMap((file) => {
    const doc = parseYaml(readFileSync(join(WORKFLOWS, file), 'utf8'));
    return Object.entries(doc?.jobs ?? {}).flatMap(([job, body]) =>
      (body?.steps ?? [])
        .filter((step) => typeof step?.uses === 'string' && step.uses.startsWith('azure/login@'))
        .map((step) => ({ where: `${file} > ${job}`, with: step.with ?? {} })),
    );
  });
  /** An input that is one expression whose every operand is `secrets.<name>`. */
  const SECRETS_ONLY = /^\$\{\{\s*secrets\.\w+(\s*\|\|\s*secrets\.\w+)*\s*\}\}$/;
  const CLIENT_IDS = TENANT_AND_CLIENT_IDS.filter((name) => name !== 'TENANT_ID');

  it('finds every azure/login step', () => {
    // Nine today: the two deploys, the two monitors, the alert check, the
    // manifest build, the window remover, the Arc run and Copilot's setup.
    expect(logins.map((login) => login.where.split(' > ')[0]).sort()).toEqual(
      [
        'copilot-setup-steps.yml',
        'deploy-azure-frontend.yml',
        'deploy-functions.yml',
        'lab-host-arc-run.yml',
        'monitor-functions-registered.yml',
        'monitor-unresolved-secrets.yml',
        'publish-content-manifest.yml',
        'remove-ci-access-windows.yml',
        'verify-alert-state.yml',
      ].sort(),
    );
  });

  it('every azure/login reads its client, tenant and subscription from secrets only', () => {
    const problems = logins.flatMap(({ where, with: input }) => {
      const out = [];
      const client = String(input['client-id'] ?? '');
      const tenant = String(input['tenant-id'] ?? '');
      const subscription = String(input['subscription-id'] ?? '');
      if (!SECRETS_ONLY.test(client) || !CLIENT_IDS.some((name) => client.includes(`secrets.${name}`))) {
        out.push(`${where}: client-id is not one of the client id secrets: ${client}`);
      }
      if (!SECRETS_ONLY.test(tenant) || !tenant.includes('secrets.TENANT_ID')) {
        out.push(`${where}: tenant-id is not secrets.TENANT_ID: ${tenant}`);
      }
      if (input['allow-no-subscriptions'] === true) {
        if (subscription) out.push(`${where}: sets both allow-no-subscriptions and subscription-id`);
      } else if (!SECRETS_ONLY.test(subscription) || !SUBSCRIPTION_IDS.some((name) => subscription.includes(`secrets.${name}`))) {
        out.push(`${where}: subscription-id is not a subscription id secret: ${subscription}`);
      }
      return out;
    });
    expect(problems).toEqual([]);
  });

  it.each([
    ['CLIENT_ID', ['deploy-azure-frontend.yml', 'deploy-functions.yml']],
    ['READER_CLIENT_ID', ['monitor-functions-registered.yml', 'monitor-unresolved-secrets.yml']],
    ['MANIFEST_WINDOW_CLIENT_ID', ['publish-content-manifest.yml', 'remove-ci-access-windows.yml']],
    ['COPILOT_REVIEW_CLIENT_ID', ['copilot-setup-steps.yml']],
    ['ARC_RUN_CLIENT_ID', ['lab-host-arc-run.yml']],
    ['ALERT_READER_CLIENT_ID', ['verify-alert-state.yml']],
    // #1617: no workflow reads it until the second pull request moves
    // deploy-azure-frontend.yml onto it (then CLIENT_ID's list above loses
    // that file and this one gains it).
    ['FRONTEND_DEPLOY_CLIENT_ID', []],
  ])('%s is read from the secret by the workflows that sign in with it', (name, expected) => {
    expect(readersOf(name).sort()).toEqual(expected.sort());
  });

  it('a self-arming gate tests the secret in a job of its own, since a job if: cannot read secrets', () => {
    // GitHub refuses `secrets` in a job-level `if:`, so these five each have
    // an `armed` job that reads the secret into env and answers true or false,
    // and the Azure job needs it (#1618).
    for (const [file, name] of [
      ['monitor-functions-registered.yml', 'READER_CLIENT_ID'],
      ['monitor-unresolved-secrets.yml', 'READER_CLIENT_ID'],
      ['verify-alert-state.yml', 'ALERT_READER_CLIENT_ID'],
      ['publish-content-manifest.yml', 'MANIFEST_WINDOW_CLIENT_ID'],
      ['remove-ci-access-windows.yml', 'MANIFEST_WINDOW_CLIENT_ID'],
    ]) {
      const text = readFileSync(join(WORKFLOWS, file), 'utf8');
      expect(text, file).toMatch(/^ {2}armed:\n/m);
      expect(text, file).toContain(`          ${name}: \${{ secrets.${name} }}`);
      expect(text, file).toContain("    needs: armed\n    if: needs.armed.outputs.armed == 'true'\n");
      expect(text, file).not.toMatch(/^\s*if:.*\bsecrets\./m);
    }
  });

  it('the line that catches a variable read is not fooled by spacing', () => {
    for (const line of [
      '${{ vars.SUBSCRIPTION_ID }}',
      '${{ vars . SUBSCRIPTION_MGMT_ID }}',
      "${{ vars['SUBSCRIPTION_ID'] }}",
      '${{ vars.TENANT_ID }}',
      "if: ${{ vars.READER_CLIENT_ID != '' }}",
      '${{ secrets.COPILOT_REVIEW_CLIENT_ID || vars.COPILOT_REVIEW_CLIENT_ID }}',
      '${{ vars["ARC_RUN_CLIENT_ID"] }}',
    ]) {
      expect(VARS_READ.test(line), line).toBe(true);
    }
    for (const line of [
      '${{ secrets.SUBSCRIPTION_ID }}',
      '${{ vars.ARM_SUBSCRIPTION_ID_X }}',
      'ALERT_SUBSCRIPTION_IDS',
      '${{ vars.VITE_ENTRA_CLIENT_ID }}',
      '${{ vars.VITE_ENTRA_TENANT_ID }}',
      '${{ vars.MANIFEST_APP_ID }}',
      '${{ vars.COPILOT_REVIEW_APP_ID }}',
      '${{ secrets.TENANT_ID }}',
    ]) {
      expect(VARS_READ.test(line), line).toBe(false);
    }
  });

  it('set-github-variables.ps1 writes none of the ids as a repository variable', () => {
    const script = readFileSync(join(REPO, 'scripts', 'set-github-variables.ps1'), 'utf8');
    for (const name of SECRET_IDS) {
      expect(script, name).not.toMatch(new RegExp(`Set-RepoVariable\\s+-Name\\s+'${name}'`));
      expect(script, name).not.toMatch(new RegExp(`kind = 'variable'; name = '${name}'`));
    }
    expect(script).toMatch(/Set-RepoSecret\s+-Name\s+'SUBSCRIPTION_ID'/);
    expect(script).toMatch(/Set-RepoSecret\s+-Name\s+'TENANT_ID'/);
    for (const name of TENANT_AND_CLIENT_IDS.filter((n) => n !== 'TENANT_ID')) {
      expect(script, name).toMatch(new RegExp(`kind = 'secret'; name = '${name}'`));
    }
    // The wave-2 loop honours `kind`, so a 'secret' entry is never written as a variable.
    expect(script).toMatch(/if \(\$entry\.kind -eq 'secret'\) \{\s*Set-RepoSecret -Name \$entry\.name -Value \$value/);
  });

  // Copilot review of #1633: the Pester tests only exercise the generic secret
  // writer, so a typo in a wave-2 output key would leave its secret unset
  // without any test failing. Each entry's output must be a real Terraform
  // output, and the #1617 one must feed FRONTEND_DEPLOY_CLIENT_ID.
  it('every wave-2 entry of set-github-variables.ps1 reads a Terraform output that exists', () => {
    const script = readFileSync(join(REPO, 'scripts', 'set-github-variables.ps1'), 'utf8');
    const infra = join(REPO, 'infra');
    const outputs = new Set(
      readdirSync(infra)
        .filter((name) => name.endsWith('.tf'))
        .flatMap((name) => [...readFileSync(join(infra, name), 'utf8').matchAll(/^output "([^"]+)"/gm)].map((m) => m[1]))
    );
    const entries = [...script.matchAll(/@\{ output = '([^']+)'; kind = '(secret|variable)'; name = '([^']+)'/g)].map(
      ([, output, kind, name]) => ({ output, kind, name })
    );
    expect(entries.length).toBeGreaterThan(5);
    for (const entry of entries) expect(outputs, `${entry.name} reads output ${entry.output}`).toContain(entry.output);
    expect(entries).toContainEqual({ output: 'frontend_deploy_client_id', kind: 'secret', name: 'FRONTEND_DEPLOY_CLIENT_ID' });
  });
});
