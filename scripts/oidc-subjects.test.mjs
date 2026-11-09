/**
 * Every workflow that logs into Azure must present a subject some federated
 * credential actually trusts.
 *
 * This exists because that stopped being true and nothing noticed. `de99aa0`
 * put deploy-functions.yml behind `environment: production` to gate production
 * deploys — correct in itself, with a consequence nothing accounted for:
 * declaring an environment CHANGES the OIDC subject GitHub composes, from
 * repo:<org>/<repo>:ref:<ref> to repo:<org>/<repo>:environment:<name>. No
 * credential matched the new subject, so every production deploy failed at
 * azure/login with AADSTS700213.
 *
 * It stayed invisible for a day because no deploy ran in between. That is the
 * property worth defending against: the failure is silent until someone
 * deploys, and by then it reads as a permissions problem rather than as a
 * consequence of a workflow edit. A `terraform validate` cannot catch it —
 * both files are individually valid — and neither can any linter that looks at
 * one file at a time. The check has to be a cross-reference, which is what this
 * is.
 *
 * Deliberately regex-based rather than YAML/HCL parsed. Adding a parser
 * dependency to catch a two-line pattern costs more than it returns, and the
 * shapes matched here are the ones the repository actually writes.
 *
 * ## Per identity since T-728
 *
 * This used to collect every `subject = "..."` in oidc.tf into one pool and ask
 * whether SOMETHING trusted the form a workflow presents. That was sound while
 * one identity served every workflow. It stopped being sound the moment a second
 * one appeared: a reader workflow that sends READER_CLIENT_ID needs a credential
 * on the READER identity, and a pooled check would have been satisfied by the
 * deploy identity's ref credential — passing green while every monitor failed at
 * azure/login with AADSTS700213.
 *
 * So credentials are attributed to the identity their
 * `user_assigned_identity_id` names, workflows are attributed to the identity
 * whose client-id secret they send, and the two are matched up. Both identities
 * happen to trust the same ref subject today, which is exactly why the pooled
 * version would have looked fine.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { identityMismatches, mainSubject, onActions, readOidcIdentity } from './check-oidc-owner.mjs';
import { parse as parseYaml } from 'yaml';

/**
 * Every job's GitHub environment in one workflow, read with a YAML parser
 * (#1590), as `{ environments: [{ job, name }], problems: [string] }`.
 *
 * This guards the one rule that keeps root on the lab host behind its own
 * reviewers: only lab-host-arc-run.yml may name the `lab-host-arc`
 * environment, because github_arc_run trusts that environment's OIDC subject.
 * A job names an environment as a string or as a mapping with `name`, and
 * YAML lets the same key be written many ways (quoted keys, flow or block
 * mappings, anchors and aliases), so a reader of the text missed forms three
 * times over (#1609). The `yaml` package (eemeli/yaml, pinned exactly in
 * package.json) reads them all as GitHub does. Merge keys (`<<`) are resolved
 * too, so an environment that could arrive through one is seen.
 *
 * Fail-closed: a file that is not valid YAML (a duplicate key included),
 * a `jobs` that is not a mapping, or an environment whose name is not a plain
 * environment name (a `${{ }}` expression, a number, a list, a mapping with
 * no `name`) is a problem naming the file and job, never a pass.
 */
function workflowEnvironments(file, text) {
  let doc;
  try {
    doc = parseYaml(text, { merge: true, uniqueKeys: true, maxAliasCount: 1000 });
  } catch (error) {
    return { environments: [], problems: [`${file}: not valid YAML (${error.message.split('\n')[0]})`] };
  }
  const jobs = doc?.jobs;
  if (jobs === null || typeof jobs !== 'object' || Array.isArray(jobs)) {
    return { environments: [], problems: [`${file}: has no jobs mapping`] };
  }
  const environments = [];
  const problems = [];
  for (const [job, body] of Object.entries(jobs)) {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      problems.push(`${file}:${job}: the job is not a mapping`);
      continue;
    }
    if (!Object.hasOwn(body, 'environment')) continue;
    const value = body.environment;
    const name =
      typeof value === 'string'
        ? value
        : value !== null && typeof value === 'object' && !Array.isArray(value)
          ? value.name
          : undefined;
    if (typeof name !== 'string' || !/^[A-Za-z0-9._-]+$/.test(name)) {
      problems.push(`${file}:${job}: environment is not a plain name: ${JSON.stringify(value)}`);
      continue;
    }
    environments.push({ job, name });
  }
  return { environments, problems };
}

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOWS = join(REPO, '.github', 'workflows');

/**
 * Subjects trusted by each identity, keyed by the identity's Terraform label.
 *
 * Matched as whole `azurerm_federated_identity_credential` blocks so `subject`
 * and `user_assigned_identity_id` stay associated. Reading them as two flat
 * lists would pair them by position, which is right until someone reorders the
 * attributes inside one block.
 */
function trustedSubjectsByIdentity() {
  const hcl = readFileSync(join(REPO, 'infra', 'oidc.tf'), 'utf8');
  const blocks = [
    ...hcl.matchAll(/resource\s+"azurerm_federated_identity_credential"\s+"\w+"\s*\{([\s\S]*?)\n\}/g),
  ];
  const byIdentity = {};
  for (const [, body] of blocks) {
    const subject = body.match(/^\s*subject\s*=\s*"([^"]+)"/m)?.[1];
    const identity = body.match(
      /^\s*user_assigned_identity_id\s*=\s*azurerm_user_assigned_identity\.(\w+)\.id/m
    )?.[1];
    if (!subject || !identity) continue;
    (byIdentity[identity] ??= []).push(subject);
  }
  return byIdentity;
}

/**
 * Which identity a workflow authenticates as, from the client-id secret it
 * sends. The name is the only thing that decides it — both identities trust
 * the same ref subject, so the subject cannot tell them apart. They were
 * repository variables until #1618 and are repository secrets since, so the
 * public logs print them as ***; azure-ids-secrets.test.mjs forbids a `vars.`
 * read of any of them.
 */
const IDENTITY_BY_CLIENT_ID_SECRET = {
  CLIENT_ID: 'github_deploy',
  // deploy-azure-frontend.yml from #1617's PR 2: the Static Web App's
  // deployment token, nothing else.
  FRONTEND_DEPLOY_CLIENT_ID: 'github_frontend_deploy',
  READER_CLIENT_ID: 'github_reader',
  // verify-alert-state.yml: alert rules and action groups, nothing else (#1053).
  ALERT_READER_CLIENT_ID: 'github_alert_reader',
  // publish-content-manifest.yml: its origin window, nothing else (#1098).
  MANIFEST_WINDOW_CLIENT_ID: 'github_manifest_window',
  // copilot-setup-steps.yml: the identity Copilot code review signs in as.
  COPILOT_REVIEW_CLIENT_ID: 'github_copilot_review',
  // lab-host-arc-run.yml: Run Command on the lab host, behind its own
  // environment, lab-host-arc (#1590).
  ARC_RUN_CLIENT_ID: 'github_arc_run',
};

/**
 * Azure-login JOBS: the identity each uses, and the environment its own job
 * names.
 *
 * ## Per job since #567
 *
 * This used to scan the whole FILE for `environment:` and for the client-id,
 * without asking which job held either. That was sound while the only reason
 * to name an environment was to gate the login job itself.
 *
 * It stopped being sound when #567 scoped the PR-opening jobs of
 * publish-content-manifest.yml and update-learn-catalogue.yml to
 * `environment: automation` for zizmor's secrets-outside-env. Those jobs hold
 * a GitHub App key and never call azure/login; the login lives in a different
 * job in the same file, with no environment. The file-level scan read the two
 * as one and failed, claiming a subject change that GitHub does not make.
 *
 * GitHub composes the subject from the JOB: a job tied to an environment
 * presents repo:<org>/<repo>:environment:<name>, and a job that is not
 * presents the ref form, whatever a sibling job in the same file declares.
 *
 * Per job is also strictly stronger. The old shape could not see a file where
 * one login job names an environment and another does not — it would check the
 * environment form for both and miss a missing ref credential entirely.
 */
function azureLoginJobs() {
  return readdirSync(WORKFLOWS)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'))
    .flatMap((file) => {
      const text = readFileSync(join(WORKFLOWS, file), 'utf8');
      if (!/uses:\s*azure\/login@/.test(text)) return [];

      // Split on job headers: a name at two spaces under `jobs:`. Everything
      // until the next such line belongs to that job.
      const lines = text.split('\n');
      const starts = [];
      lines.forEach((line, i) => {
        if (/^ {2}[A-Za-z0-9_-]+:\s*$/.test(line)) starts.push(i);
      });

      return starts
        .map((start, n) => ({
          job: lines[start].trim().replace(':', ''),
          body: lines.slice(start, starts[n + 1] ?? lines.length).join('\n'),
        }))
        .filter(({ body }) => /uses:\s*azure\/login@/.test(body))
        .map(({ job, body }) => ({
          file,
          job,
          environments: [
            ...new Set(
              [...body.matchAll(/^\s{4}environment:\s*([A-Za-z0-9._-]+)\s*$/gm)].map((m) => m[1])
            ),
          ],
          clientIdSecrets: [
            ...new Set(
              [
                ...body.matchAll(/client-id:\s*\$\{\{[^}]*?\bsecrets\.([A-Z0-9_]+)\b[^}]*\}\}/g),
              ].map((m) => m[1])
            ),
          ],
        }));
    });
}

describe('OIDC federated credentials cover every Azure login', () => {
  const byIdentity = trustedSubjectsByIdentity();
  const workflows = azureLoginJobs();
  const allSubjects = Object.values(byIdentity).flat();

  it('finds the workflows and the credentials at all', () => {
    // A silently empty scan would make every assertion below vacuously pass,
    // which is the way a cross-reference check rots.
    expect(workflows.length).toBeGreaterThan(0);
    expect(allSubjects.length).toBeGreaterThan(0);
    expect(Object.keys(byIdentity).length).toBeGreaterThan(0);
  });

  it.each(workflows)('$file:$job names exactly one known client-id secret', ({ file, job, clientIdSecrets }) => {
    // Two would mean two jobs authenticating as different identities in one
    // file, which nothing here does and which the per-workflow checks below
    // would then only half cover. An unknown one means a secret this test
    // cannot attribute to an identity — it would silently check nothing. A
    // `vars.` client id counts as none, which fails here too (#1618).
    expect(
      clientIdSecrets.length,
      `${file}:${job} sends ${clientIdSecrets.length} client-id secrets`
    ).toBe(1);
    expect(
      IDENTITY_BY_CLIENT_ID_SECRET[clientIdSecrets[0]],
      `${file} authenticates with secrets.${clientIdSecrets[0]}, which this test cannot map to an ` +
        `identity in infra/oidc.tf. Add it to IDENTITY_BY_CLIENT_ID_SECRET, or the workflow's ` +
        'credentials go unchecked.'
    ).toBeDefined();
  });

  it.each(workflows)(
    '$file:$job presents a subject its own identity trusts',
    ({ file, job, environments, clientIdSecrets }) => {
      const identity = IDENTITY_BY_CLIENT_ID_SECRET[clientIdSecrets[0]];
      const subjects = byIdentity[identity] ?? [];
      const held = `Trusted by ${identity} today:\n  ${subjects.join('\n  ') || '(none)'}`;

      if (environments.length === 0) {
        // No environment named, so GitHub composes the ref form.
        expect(
          subjects.filter((s) => s.includes(':ref:')).length,
          `${file}:${job} logs into Azure as ${identity} without an environment, so it presents a ` +
            `repo:<org>/<repo>:ref:<ref> subject, and that identity has no ref credential.\n${held}`
        ).toBeGreaterThan(0);
        return;
      }

      for (const env of environments) {
        expect(
          subjects.filter((s) => s.endsWith(`:environment:${env}`)).length,
          `${file}:${job} declares "environment: ${env}", so GitHub composes the subject ` +
            `repo:<org>/<repo>:environment:${env} — NOT the ref form. Identity ${identity} ` +
            `trusts no such subject, so azure/login will fail with AADSTS700213. Add an ` +
            `azurerm_federated_identity_credential for it on THAT identity (both the name and ` +
            `immutable-ID forms).\n${held}`
        ).toBeGreaterThan(0);
      }
    }
  );

  it('the deploy identity trusts environment-form subjects only, so the production gate cannot be routed around (SEC-2)', () => {
    // A ref-form credential on the deploy identity would let any job on
    // main with `id-token: write` sign in as it without the production
    // environment's reviewers. Retired 2026-10-06; this pins the retirement.
    const subjects = byIdentity.github_deploy ?? [];
    expect(subjects.length).toBeGreaterThan(0);
    const refForm = subjects.filter((s) => s.includes(':ref:'));
    expect(
      refForm,
      `github_deploy trusts a ref-form subject, which bypasses the production environment gate:\n  ${refForm.join('\n  ')}`
    ).toEqual([]);
  });

  it('the deploy identity trusts exactly production and production-backend, both forms, until PR 2 of #1617', () => {
    // PR 1 of #1617 adds the reviewed production-backend environment's pair
    // beside the production pair, so nothing breaks before the workflows
    // move. PR 2 moves deploy-functions.yml to production-backend, moves the
    // frontend to github_frontend_deploy, and deletes the production pair:
    // then this list is the two production-backend subjects alone.
    // An exact list, not a substring: `:environment:production` is also the
    // start of `:environment:production-backend`.
    expect([...(byIdentity.github_deploy ?? [])].sort()).toEqual(
      [
        'repo:${var.github_org}/${var.github_repo}:environment:production',
        '${local.github_immutable_prefix}:environment:production',
        'repo:${var.github_org}/${var.github_repo}:environment:production-backend',
        '${local.github_immutable_prefix}:environment:production-backend',
      ].sort()
    );
  });

  it('the frontend deploy identity trusts exactly the production environment, both forms (#1617)', () => {
    // Entra matches on the subject, not the client id, so whatever this
    // identity trusts, any job presenting that subject can sign in as it.
    // production is the frontend's environment, with no reviewers since
    // #1613; this identity can reach the site's deployment token and nothing
    // else, which is why that is acceptable.
    expect([...(byIdentity.github_frontend_deploy ?? [])].sort()).toEqual(
      [
        'repo:${var.github_org}/${var.github_repo}:environment:production',
        '${local.github_immutable_prefix}:environment:production',
      ].sort()
    );
  });

  it('no identity but the deploy identity trusts production-backend, the reviewed backend environment (#1617)', () => {
    // A second identity trusting it would be a second identity reachable by
    // a job that names production-backend, and the deploy identity holds the
    // Function App's publishing rights.
    const holders = Object.entries(byIdentity)
      .filter(([, subjects]) => subjects.some((s) => s.endsWith(':environment:production-backend')))
      .map(([identity]) => identity);
    expect(holders).toEqual(['github_deploy']);
  });

  it('trusts each subject in both the name and immutable-ID forms, per identity', () => {
    // GitHub composes the subject with numeric org/repo IDs embedded; the
    // repository trusts both forms deliberately (see infra/oidc.tf). One
    // without the other is half a credential and fails on whichever form the
    // token happens to carry.
    //
    // Per identity, and covering the ref form too: the reader identity's only
    // credentials are a ref pair, so an environment-only check would have said
    // nothing about it at all.
    const missing = [];
    for (const [identity, subjects] of Object.entries(byIdentity)) {
      const suffixes = [
        ...new Set(subjects.map((s) => s.replace(/^repo:\$\{var\.github_org\}[^:]*|^\$\{local\.github_immutable_prefix\}/, ''))),
      ];
      for (const suffix of suffixes) {
        const forms = subjects.filter((s) => s.endsWith(suffix));
        // The immutable form is written via the `github_immutable_prefix` local,
        // so the numeric IDs never appear in the literal here — matching on '@'
        // would report every immutable credential as missing. Match the prefix
        // expression instead, which is what the HCL actually contains.
        if (!forms.some((s) => s.startsWith('${local.github_immutable_prefix}'))) {
          missing.push(`${identity} ${suffix}: no immutable-ID-form credential`);
        }
        if (!forms.some((s) => s.startsWith('repo:${var.github_org}'))) {
          missing.push(`${identity} ${suffix}: no name-form credential`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});

/**
 * Every role assignment in infra/ to one identity, as `role @ scope` strings.
 *
 * The role is the `role_definition_name` literal, or `data.<label>` for a
 * custom role read by `role_definition_id`; the scope is the expression as
 * written. Whole blocks again, so the three attributes stay together.
 */
function grantsTo(identity) {
  const infra = join(REPO, 'infra');
  return readdirSync(infra)
    .filter((f) => f.endsWith('.tf'))
    .flatMap((f) => [
      ...readFileSync(join(infra, f), 'utf8').matchAll(
        /resource\s+"azurerm_role_assignment"\s+"\w+"\s*\{([\s\S]*?)\n\}/g
      ),
    ])
    .map(([, body]) => {
      const named = body.match(/^\s*role_definition_name\s*=\s*"([^"]+)"/m)?.[1];
      // `[0]` is a count-gated lookup (storage_firewall_writer, #1463): the same role.
      const custom = body.match(/^\s*role_definition_id\s*=\s*data\.azurerm_role_definition\.(\w+)(?:\[0\])?\.id/m)?.[1];
      return {
        principal: body.match(/^\s*principal_id\s*=\s*azurerm_user_assigned_identity\.(\w+)\.principal_id/m)?.[1],
        role: named ?? (custom ? `data.${custom}` : undefined),
        scope: body.match(/^\s*scope\s*=\s*(\S+)/m)?.[1],
      };
    })
    .filter((grant) => grant.principal === identity)
    .map(({ role, scope }) => `${role} @ ${scope}`)
    .sort();
}

/**
 * What github_reader and github_manifest_window may hold, exactly (#1098).
 *
 * The reader held HCW Function Config Refresh beside HCW Function Settings
 * Reader until #1098, while infra/oidc.tf said it "can change nothing". RBAC
 * is additive, so the one principal could list app settings and write them.
 * Exact lists rather than a deny-list of known write roles: a new grant to
 * either identity has to change this test, which puts it in front of a
 * reviewer with the reason beside it.
 */
describe('the reader and the manifest window hold what infra/oidc.tf says', () => {
  it('github_reader holds reads only: Reader and the settings list, on the web group', () => {
    expect(grantsTo('github_reader')).toEqual([
      'Reader @ azurerm_resource_group.app["web"].id',
      'data.function_settings_reader @ azurerm_resource_group.app["web"].id',
    ]);
  });

  it('github_manifest_window holds the config write on the one site, the firewall write on the one storage account and Reader on the web group, and nothing else', () => {
    // Reader at the group rather than the site so the subscription is
    // discoverable at sign-in, as for github_reader (infra/oidc.tf).
    // The storage grant arrived with #1463: remove-ci-access-windows.yml runs
    // as this identity every hour and puts the host storage account's
    // firewall back to Deny. HCW Storage Firewall Writer is the account's
    // read and write actions and nothing else (no listKeys, no data plane),
    // scoped to that one account; infra/oidc.tf says why not the deploy
    // identity. A Storage Account Contributor grant here would be the widening
    // this list exists to put in front of a reviewer.
    expect(grantsTo('github_manifest_window')).toEqual([
      'Reader @ azurerm_resource_group.app["web"].id',
      'data.func_config_refresh @ azurerm_function_app_flex_consumption.hcw.id',
      'data.storage_firewall_writer @ azurerm_storage_account.functions.id',
    ]);
  });

  it('github_arc_run holds the Run Command role on the lab group, and nothing else (#1590)', () => {
    // Run Command is root on the lab host. The identity that can create one
    // holds nothing else, so a dependency in some other job's tree never
    // inherits it, and no other identity holds the role: a second grant of
    // data.arc_run_command_operator would be a second way to root.
    expect(grantsTo('github_arc_run')).toEqual(['data.arc_run_command_operator @ azurerm_resource_group.lab_hybrid.id']);
    for (const identity of ['github_deploy', 'github_frontend_deploy', 'github_reader', 'github_alert_reader', 'github_manifest_window', 'github_copilot_review']) {
      expect(grantsTo(identity).filter((g) => g.startsWith('data.arc_run_command_operator')), identity).toEqual([]);
    }
  });

  it('github_frontend_deploy holds HCW Static Web App Deployer on the one site, and nothing else (#1617)', () => {
    // The frontend deploy reads the site's deployment token and does nothing
    // else in Azure. The site itself is the narrowest scope the role can
    // have; the resource group would also reach any later static site.
    expect(grantsTo('github_frontend_deploy')).toEqual(['data.static_web_app_deployer @ azurerm_static_web_app.hcw.id']);
  });

  it('only the deploy identity and the frontend deploy identity hold the site role, until PR 2 of #1617 removes the first', () => {
    // PR 2 deletes github_deploy_swa_token once deploy-azure-frontend.yml
    // signs in as github_frontend_deploy; then this list is that one.
    const holders = ['github_deploy', 'github_frontend_deploy', 'github_reader', 'github_alert_reader', 'github_manifest_window', 'github_copilot_review', 'github_arc_run'].filter(
      (identity) => grantsTo(identity).some((g) => g.startsWith('data.static_web_app_deployer @'))
    );
    expect(holders).toEqual(['github_deploy', 'github_frontend_deploy']);
  });

  it('github_arc_run trusts the lab-host-arc environment only, and no other identity trusts it (#1590)', () => {
    // Entra matches a federated credential on issuer, subject and audience
    // alone, and a client id is public: any job presenting a subject this
    // identity trusts can sign in as it. So its subject is an environment
    // only lab-host-arc-run.yml names, never production (whose deploy jobs
    // run package scripts), and no other identity shares it.
    const byIdentity = trustedSubjectsByIdentity();
    const subjects = byIdentity.github_arc_run ?? [];
    expect(subjects.length).toBe(2);
    expect(subjects.every((s) => s.endsWith(':environment:lab-host-arc'))).toBe(true);
    for (const [identity, held] of Object.entries(byIdentity)) {
      if (identity === 'github_arc_run') continue;
      expect(held.filter((s) => s.includes(':environment:lab-host-arc')), identity).toEqual([]);
    }
  });

  it('no workflow but lab-host-arc-run.yml names the lab-host-arc environment, and none but deploy-functions.yml names production-backend, in any form (#1590, #1617)', () => {
    // Naming it is what presents the subject github_arc_run trusts, so a
    // second workflow naming it would be a second way to root on the lab host.
    // Every workflow is parsed as YAML; anything that cannot be read as a
    // plain environment name fails here, naming the file and job.
    const files = readdirSync(WORKFLOWS).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));
    expect(files.length).toBeGreaterThan(20);
    const read = files.map((file) => ({ file, ...workflowEnvironments(file, readFileSync(join(WORKFLOWS, file), 'utf8')) }));
    expect(read.flatMap((r) => r.problems)).toEqual([]);
    const named = read.flatMap((r) => r.environments.map((env) => ({ file: r.file, ...env })));
    expect(named.some((n) => n.file === 'docs-pages.yml' && n.name === 'github-pages'), 'docs-pages.yml does not read as github-pages').toBe(true);
    expect(named.some((n) => n.file === 'deploy-functions.yml' && n.name === 'production'), 'deploy-functions.yml does not read as production').toBe(true);
    // Environment names are not case-sensitive on GitHub, so neither is this.
    expect(named.filter((n) => n.name.toLowerCase() === 'lab-host-arc').map((n) => n.file)).toEqual(['lab-host-arc-run.yml']);
    // production-backend (#1617) is the reviewed environment the deploy
    // identity trusts for the backend. No workflow names it until PR 2 moves
    // deploy-functions.yml to it, and no other workflow may name it after.
    const backend = [...new Set(named.filter((n) => n.name.toLowerCase() === 'production-backend').map((n) => n.file))];
    expect(backend.filter((file) => file !== 'deploy-functions.yml')).toEqual([]);
  });

  /** A fixture workflow whose one job, `only`, carries `lines`. */
  const fixture = (...lines) =>
    ['name: fixture', 'on: workflow_dispatch', 'jobs:', '  only:', ...lines, '    runs-on: ubuntu-26.04', ''].join('\n');

  it.each([
    ['a string', fixture('    environment: lab-host-arc')],
    ['a quoted string with a comment', fixture("    environment: 'lab-host-arc' # comment")],
    ['a space before the colon', fixture('    environment : lab-host-arc')],
    ['a double-quoted key', fixture('    "environment": lab-host-arc')],
    ['a single-quoted key and a flow mapping', fixture("    'environment': {name: lab-host-arc}")],
    ['a flow mapping', fixture('    environment: { name: "lab-host-arc", url: https://example.invalid }')],
    ['a flow mapping with a space before the colon', fixture('    environment: { name : lab-host-arc }')],
    ['a flow mapping split over lines', fixture('    environment: {', '      name: lab-host-arc }')],
    ['a block mapping', fixture('    environment:', '      # a comment', '      url: https://example.invalid', '      name: lab-host-arc')],
    ['a block mapping with spaces around the colon', fixture('    environment:', '      name   :   lab-host-arc')],
    ['a block mapping with a quoted name key', fixture('    environment:', '      "name": lab-host-arc')],
    [
      'an alias to an anchor elsewhere in the file',
      ['name: fixture', 'on: workflow_dispatch', 'env:', '  WHERE: &where lab-host-arc', 'jobs:', '  only:', '    environment: *where', '    runs-on: ubuntu-26.04', ''].join('\n'),
    ],
    [
      'a merge key from an anchored mapping',
      ['name: fixture', 'on: workflow_dispatch', 'x-base: &base', '  environment: lab-host-arc', 'jobs:', '  only:', '    <<: *base', '    runs-on: ubuntu-26.04', ''].join('\n'),
    ],
    [
      'quoted top-level and job keys',
      ['"name": fixture', '"on": workflow_dispatch', '"jobs":', '  "only":', '    "environment": "lab-host-arc"', '    "runs-on": ubuntu-26.04', ''].join('\n'),
    ],
  ])('reads lab-host-arc written as %s (#1590)', (_form, text) => {
    expect(workflowEnvironments('fixture.yml', text)).toEqual({ environments: [{ job: 'only', name: 'lab-host-arc' }], problems: [] });
  });

  it.each([
    ['a flow mapping with no name', fixture('    environment: { url: https://example.invalid }')],
    ['a block mapping with no name', fixture('    environment:', '      url: https://example.invalid')],
    ['an expression', fixture('    environment: ${{ inputs.target }}')],
    ['a mapping whose name is an expression', fixture('    environment:', '      name: ${{ inputs.target }}')],
    ['a list', fixture('    environment: [lab-host-arc]')],
    ['an empty value', fixture('    environment:')],
    ['a duplicate key', fixture('    environment: production', '    environment: lab-host-arc')],
    ['text that is not YAML', fixture('    environment: "lab-host-arc')],
    ['jobs that are not a mapping', 'name: fixture\non: workflow_dispatch\njobs: [only]\n'],
  ])('fails closed on an environment written as %s (#1590)', (_form, text) => {
    expect(workflowEnvironments('fixture.yml', text).problems.length).toBeGreaterThan(0);
  });

  it('reads a grant it is shown, so an empty list above means no grant rather than a broken scan', () => {
    expect(grantsTo('github_alert_reader').length).toBeGreaterThan(0);
    expect(grantsTo('github_deploy').length).toBeGreaterThan(0);
  });
});

/**
 * The owner and the two numeric IDs every subject above is built from, checked
 * against the repository CI is actually running in. The reasoning, and the
 * 2026-10-07 transfer that prompted it, are in scripts/check-oidc-owner.mjs,
 * which ci.yml also runs on its own on every pull request.
 */
describe('OIDC subjects name the repository CI runs in', () => {
  const identity = readOidcIdentity();
  const run = (owner, ownerId) => ({
    GITHUB_REPOSITORY: `${owner}/HCW-HybridCloudWorks`,
    GITHUB_REPOSITORY_OWNER_ID: ownerId,
    GITHUB_REPOSITORY_ID: '1268997852',
  });

  it('infra/ and the Docker rule in publish-lab-image.yml agree with each other', () => {
    expect(identityMismatches(identity)).toEqual([]);
  });

  it('would have failed on the first run after the 2026-10-07 transfer', () => {
    // The files as they stood before this fix, in the repository as it is now.
    const before = { ...identity, owner: 'HybridCloudWorks', ownerId: '312844660' };
    before.expectedRule = mainSubject(before);
    const problems = identityMismatches(before, run('saulpatinojr', '34853639'));
    expect(problems.join('\n')).toMatch(/github_org default.*HybridCloudWorks.*saulpatinojr/);
    expect(problems.join('\n')).toMatch(/owner ID.*312844660.*34853639/);
  });

  it('passes for the repository the files name', () => {
    expect(identityMismatches(identity, run(identity.owner, identity.ownerId))).toEqual([]);
  });

  it.skipIf(!onActions())('matches the owner, owner ID and repository ID GitHub reports for this run', () => {
    expect(identityMismatches(identity, process.env)).toEqual([]);
  });

  it('ci.yml runs the check on every pull request, outside the path filter', () => {
    // The point of the separate file. Gated on the filter, the check would
    // skip the docs-only pull request after a transfer, which is the one that
    // has to fail.
    const ci = readFileSync(join(WORKFLOWS, 'ci.yml'), 'utf8');
    const at = ci.indexOf('run: node check-oidc-owner.mjs');
    expect(at, 'no ci.yml step runs `node check-oidc-owner.mjs`').toBeGreaterThan(-1);
    // From the step's own `- name:` to its `run:`, so only its condition is read.
    const step = ci.slice(ci.lastIndexOf('- name:', at), at);
    expect(step).toMatch(/if: matrix\.name == 'scripts \(operations\)'/);
    expect(step).not.toMatch(/steps\.changes\.outputs\.relevant/);
  });
});
