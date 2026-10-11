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
 * whose client-id variable they send, and the two are matched up. Both identities
 * happen to trust the same ref subject today, which is exactly why the pooled
 * version would have looked fine.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { identityMismatches, mainSubject, onActions, readOidcIdentity } from './check-oidc-owner.mjs';

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
 * Which identity a workflow authenticates as, from the client-id variable it
 * sends. The variable name is the only thing that decides it — both identities
 * trust the same ref subject, so the subject cannot tell them apart.
 */
const IDENTITY_BY_CLIENT_ID_VAR = {
  CLIENT_ID: 'github_deploy',
  READER_CLIENT_ID: 'github_reader',
  // verify-alert-state.yml: alert rules and action groups, nothing else (#1053).
  ALERT_READER_CLIENT_ID: 'github_alert_reader',
  // copilot-setup-steps.yml: the identity Copilot code review signs in as.
  COPILOT_REVIEW_CLIENT_ID: 'github_copilot_review',
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
          clientIdVars: [
            ...new Set(
              [
                ...body.matchAll(/client-id:\s*\$\{\{[^}]*?\bvars\.([A-Z0-9_]+)\b[^}]*\}\}/g),
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

  it.each(workflows)('$file:$job names exactly one known client-id variable', ({ file, job, clientIdVars }) => {
    // Two would mean two jobs authenticating as different identities in one
    // file, which nothing here does and which the per-workflow checks below
    // would then only half cover. An unknown one means a variable this test
    // cannot attribute to an identity — it would silently check nothing.
    expect(
      clientIdVars.length,
      `${file}:${job} sends ${clientIdVars.length} client-id variables`
    ).toBe(1);
    expect(
      IDENTITY_BY_CLIENT_ID_VAR[clientIdVars[0]],
      `${file} authenticates with vars.${clientIdVars[0]}, which this test cannot map to an ` +
        `identity in infra/oidc.tf. Add it to IDENTITY_BY_CLIENT_ID_VAR, or the workflow's ` +
        'credentials go unchecked.'
    ).toBeDefined();
  });

  it.each(workflows)(
    '$file:$job presents a subject its own identity trusts',
    ({ file, job, environments, clientIdVars }) => {
      const identity = IDENTITY_BY_CLIENT_ID_VAR[clientIdVars[0]];
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
    expect(subjects.every((s) => s.includes(':environment:production'))).toBe(true);
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
