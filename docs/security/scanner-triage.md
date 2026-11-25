# Security scanner triage

One row per finding the security scanners reported on `main` at `357114f4`
(after #565), with the verdict, the evidence, and what resolves it. Issue
[#567](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/567).

A suppression in a scanner's own file, or in an inline comment, points back to
the section of this page it belongs to. **A new suppression needs a new row
here first.** Anything paid or irreversible stays unsilenced until the owner
decides. The owner decided the last of them on 2026-09-14; see
[Owner decisions 2026-09-14](#owner-decisions-2026-09-14).

## Counts

Qlty CLI 0.644.0, `qlty check --all --filter <plugin> --no-formatters`, run
locally on 2026-09-14. zizmor (1.30.1) also runs directly, and its counts agree:

```bash
uvx zizmor --offline .github/workflows
```

| Scanner | Before | Fixed | False positive | Accepted | Needs owner decision | After |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| zizmor | 42 | 42 | 0 | 0 | 0 | **0** |
| checkov | 38 | 8 | 12 | 18 | 0 | **0** |
| trivy | 7 | 2 | 2 | 3 | 0 | **0** |
| bandit | 7 | 2 | 0 | 5 | 0 | **0** |
| gitleaks | 9 | 0 | 9 | 0 | 0 | **0** |
| radarlint-iac | 19 | 0 | 19 | 0 | 0 | **19** |
| osv-scanner | 0 | 0 | 0 | 0 | 0 | **0** |
| trufflehog | 0 | 0 | 0 | 0 | 0 | **0** |
| **Total** | **122** | **54** | **42** | **26** | **0** | **19** |

Corrected 2026-09-18: zizmor's "Before" was 36, counting only the regular and
pedantic personas. Six medium `secrets-outside-env` findings stood at the
**auditor** persona and had never been triaged, which the 2026-09-16
verification comment on #567 missed. They are fixed and the row now reads 42.
A persona is not a severity filter — run all three.

What "After" still counts:

- **checkov and trivy 0.** The owner decided every paid or irreversible row
  on 2026-09-14 ([ADR 0031](../decisions/0031-security-scanner-owner-decisions.md)): real changes where the answer was yes,
  inline skips citing that record where it was no. See
  [Owner decisions 2026-09-14](#owner-decisions-2026-09-14). checkov counts 38,
  not 36: Qlty Cloud also reported the two CKV_GHA_7 rows added below, which
  the local run had not.
- **radarlint-iac 19** are false positives, and the one place that can
  silence them is `.qlty/qlty.toml`, which #568 (PR #581) owns. The rule to
  add is in [radarlint-iac](#radarlint-iac).

CodeQL is not in the table: its alerts live in code scanning, and
[CodeQL](#codeql) below records the dismissals. The table is the 2026-09-14 run. Since then #726 (2026-09-29) added rows
below: three accepted checkov rows and one accepted trivy row on the lab-only
Key Vault in `infra/lab-hybrid.tf`, two accepted checkov rows and one fixed
one on the `vault` role's seal checks, and one false-positive gitleaks row.

Verdicts:

- **Fixed:** changed in this PR, so the scanner no longer reports it.
- **False positive:** the scanner is wrong about the code, with the evidence.
- **Accepted:** the scanner is right about the shape, and the risk is taken on
  purpose, either under a recorded owner decision or for the reason given.
- **Needs owner decision:** a real gap whose fix costs money or cannot be
  undone. Nothing in Terraform changes until the owner decides.

## 2026-11-24: rules by kind, and a pull request check

Qlty Cloud's Security grade read **F** on the admin
[Health Hub's Code and Security tab](https://hybridcloudworks.com/admin/health),
while its Maintainability badge read A. The F came from about 120 high and
medium security findings, and none was a real secret or vulnerability:

- **gitleaks, 37 in tracked files**: made-up values in test files, SHA-256
  checksums in `lab-image/versions.env`, a public PGP key fingerprint, a git
  commit id in a document, and the Firebase links in the generated manifest.
- **bandit, 22**: every one rated LOW by bandit, but shown as HIGH by Qlty.
  16 flagged the safe, no-shell way of running a program.
- **checkov and trivy, 69**: production Kubernetes rules applied to the test
  inputs under `lab-image/smoke/`.
- **checkov and trivy, 5** on `infra/`, each already covered by an owner
  decision.

**Why it kept coming back.** Each false positive had been silenced one line
at a time: a `path:rule:line` fingerprint in `.gitleaksignore`, or a
`# nosec` on one call. A fingerprint breaks on the next edit above it, and a
new file starts with none, so the count grew back after every clean-up.
Nothing checked a pull request against these scanners before it merged:
Qlty Cloud analyses `main`.

**What changed**, measured with Qlty CLI 0.672.0 on the branch:

| Change | Where | Effect |
| --- | --- | --- |
| Allowlists that describe a kind of match | [`.gitleaks.toml`](#gitleaks-rules-2026-11-24) | gitleaks 37 → 0 on tracked files; a random key in a source file, and an AWS or GitHub key planted in a test folder, are still caught |
| B404 and B603 off; B602, B605, B607 and the rest stay on | [`.bandit`](#bandit-settings-2026-11-24) | bandit 22 → 0 after the code fixes below |
| `lab-image/smoke/**` excluded as test data | `.qlty/qlty.toml`, [below](#lab-image-smoke-fixtures) | 69 → 0 |
| Recorded reasons on two Terraform resources | [Terraform](#terraform-36), [trivy](#trivy) | 5 → 0, no plan change |
| `security-scan` job in `ci.yml`, which `gate` waits for | `.github/workflows/ci.yml` | A pull request that adds a high or medium finding fails |

The new job runs the same Qlty CLI, pinned and digest-checked, with the
plugins bandit, checkov, gitleaks, osv-scanner, trivy, trufflehog and zizmor,
on the lines a pull request changes (`--upstream` the base commit). **It uses
the base branch's rule files** (`.qlty/qlty.toml`, `.gitleaks.toml`,
`.gitleaksignore`, `.bandit`, `.checkov.yaml`), so a pull request cannot
loosen its own scan; a rule change applies to the pull requests after it
merges, and the job's log names the changed file. A rule file the base does
not have is removed for the scan, so a new rule file cannot excuse anything
in the pull request that adds it, this one included: the four `subprocess`
lines this pull request touches carry `# nosec B603` with the reason instead.
A rule path that is a symbolic link is refused, and each file is removed
before it is written, so the step cannot overwrite a file a link points at
(both from Copilot's review on #1841). Inline notes on one line
(`# nosec`, `checkov:skip`, `trivy:ignore`, `gitleaks:allow`) still come from
the pull request, in the diff a reviewer reads. Proved
both ways on 2026-11-24: clean on this branch, and exit 1 on a throwaway
commit that added a random 32-character `apiKey` to a source file (gitleaks,
high) and a `subprocess.call(..., shell=True)` (bandit B602, high).

## zizmor

### artipacked (19, medium): fixed

`actions/checkout` writes the job's `GITHUB_TOKEN` into `.git/config`, where
any later step, or an uploaded artifact that includes the workspace, can read
it. Each checkout now sets `persist-credentials: false`.

Every job was checked for a later step that needs the persisted credential:
`git push`, `git fetch`/`pull`, `gh` driven by the checkout credential,
`EndBug/add-and-commit`, `peter-evans/*`. None was found. The `git diff`
calls in `ci.yml`, `codeql.yml` and `iac-validate.yml` read the local clone
(`fetch-depth: 0`), and need no credential. The two jobs that do push
(`publish-content-manifest.yml` and `update-learn-catalogue.yml`, second
job each) already used `persist-credentials: false` and push with an app token.

| Rule | File:line | Verdict | Resolution |
| --- | --- | --- | --- |
| artipacked | `.github/workflows/audit-published-pages.yml:40` | Fixed | This PR |
| artipacked | `.github/workflows/ci.yml:92` | Fixed | This PR |
| artipacked | `.github/workflows/ci.yml:171` | Fixed | This PR |
| artipacked | `.github/workflows/codeql.yml:69` | Fixed | This PR |
| artipacked | `.github/workflows/dependency-review.yml:32` | Fixed | This PR |
| artipacked | `.github/workflows/deploy-azure-frontend.yml:149` | Fixed | This PR |
| artipacked | `.github/workflows/deploy-azure-frontend.yml:355` | Fixed | This PR |
| artipacked | `.github/workflows/deploy-functions.yml:62` | Fixed | This PR |
| artipacked | `.github/workflows/docs-pages.yml:48` | Fixed | This PR |
| artipacked | `.github/workflows/heal-computed-properties.yml:62` | Fixed | This PR |
| artipacked | `.github/workflows/iac-validate.yml:61` | Fixed | This PR |
| artipacked | `.github/workflows/iac-validate.yml:147` | Fixed | This PR |
| artipacked | `.github/workflows/monitor-deploy-drift.yml:102` | Fixed | This PR |
| artipacked | `.github/workflows/monitor-deploy-drift.yml:133` | Fixed | This PR |
| artipacked | `.github/workflows/monitor-unresolved-secrets.yml:72` | Fixed | This PR |
| artipacked | `.github/workflows/publish-content-manifest.yml:133` | Fixed | This PR |
| artipacked | `.github/workflows/repository-policy.yml:18` | Fixed | This PR |
| artipacked | `.github/workflows/tfc-plan-check.yml:95` | Fixed | This PR |
| artipacked | `.github/workflows/update-learn-catalogue.yml:79` | Fixed | This PR |

### template-injection (17, informational): fixed

All 17 were in `deploy-functions.yml`: repository variables
(`vars.RESOURCE_GROUP`, `vars.FUNCTIONS_STORAGE_ACCOUNT`,
`vars.FUNCTION_APP_NAME`, `vars.APP_HOSTNAME`, `vars.FUNCTIONS_URL`) and one
step output (`steps.fw.outputs.runner_ip`, the runner's public IP as an
external service reported it), expanded inside `run:`. They now reach the
script through step `env:` as `RG`, `SA`, `APP`, `RUNNER_IP`, `APP_HOSTNAME`
and `FUNCTIONS_URL`, the names the other steps in that file already use. The
unflagged `${{ github.run_id }}` in the same steps is now the runner's
`GITHUB_RUN_ID`, so no `${{ }}` is left in those scripts. The commands run
with the same values.

| Rule | File:line | Step | Verdict | Resolution |
| --- | --- | --- | --- | --- |
| template-injection | `.github/workflows/deploy-functions.yml:131` | Open storage firewall window | Fixed | This PR |
| template-injection | `.github/workflows/deploy-functions.yml:132` | Open storage firewall window | Fixed | This PR |
| template-injection | `.github/workflows/deploy-functions.yml:136` | Open storage firewall window | Fixed | This PR |
| template-injection | `.github/workflows/deploy-functions.yml:137` | Open storage firewall window | Fixed | This PR |
| template-injection | `.github/workflows/deploy-functions.yml:304` | Close storage firewall window | Fixed | This PR |
| template-injection | `.github/workflows/deploy-functions.yml:305` | Close storage firewall window | Fixed | This PR |
| template-injection | `.github/workflows/deploy-functions.yml:308` | Close storage firewall window | Fixed | This PR |
| template-injection | `.github/workflows/deploy-functions.yml:309` | Close storage firewall window | Fixed | This PR |
| template-injection | `.github/workflows/deploy-functions.yml:310` | Close storage firewall window | Fixed | This PR |
| template-injection | `.github/workflows/deploy-functions.yml:312` | Close storage firewall window | Fixed | This PR |
| template-injection | `.github/workflows/deploy-functions.yml:313` | Close storage firewall window | Fixed | This PR |
| template-injection | `.github/workflows/deploy-functions.yml:346` | Open origin firewall window | Fixed | This PR |
| template-injection | `.github/workflows/deploy-functions.yml:347` | Open origin firewall window | Fixed | This PR |
| template-injection | `.github/workflows/deploy-functions.yml:355` | Post-deploy smoke test | Fixed | This PR |
| template-injection | `.github/workflows/deploy-functions.yml:390` | Post-deploy smoke test | Fixed | This PR |
| template-injection | `.github/workflows/deploy-functions.yml:402` | Close origin firewall window | Fixed | This PR |
| template-injection | `.github/workflows/deploy-functions.yml:403` | Close origin firewall window | Fixed | This PR |

### unpinned-uses (#562): not reproduced

zizmor reports no `unpinned-uses`. All 62 `uses:` lines in every tracked YAML
file are pinned to a 40-character commit SHA. That covers the workflows,
`copilot-setup-steps.yml` and the rest of `.github/`. The repository has no
composite actions (no `action.yml` or `action.yaml`). Closes #562.

### secrets-outside-env (6, medium, auditor persona): fixed

**These were missed until 2026-09-18.** The 2026-09-16 verification comment on
#567 reported zero findings at all three personas; it was wrong about the
auditor persona, where six mediums stood. The counts table below is corrected.

| Workflow | Job | Secret | Verdict |
| --- | --- | --- | --- |
| `publish-content-manifest.yml` | `commit` | `MANIFEST_APP_PRIVATE_KEY` (×2) | fixed |
| `update-learn-catalogue.yml` | `commit` | `MANIFEST_APP_PRIVATE_KEY` (×2) | fixed |
| `tfc-plan-check.yml` | `check` | `TFC_TOKEN` (×2) | fixed |

zizmor's auditor persona reports a secret read by a job that belongs to no
GitHub Environment. The remediation is to declare one, and all three jobs now
declare `environment: automation`.

**This was never a new decision.** The estate already scopes every other
secret-using job: `production` on `deploy-functions.yml` and
`deploy-azure-frontend.yml`, `copilot` on `copilot-setup-steps.yml`,
`github-pages` on `docs-pages.yml`. These three were the ones that never
adopted the convention the owner had already applied four times.

It is also what Microsoft asks for. **MCSB v2 DS-3** (*Secure the DevOps
infrastructure*, criticality **Must have**) requires "repository-level service
connection restrictions preventing pipelines from accessing secrets outside
their intended scope", and the `azure/login` guidance states the property
plainly: "use environment secrets instead of repository secrets. If the
environment requires approval, a job cannot access environment secrets until
one of the required reviewers approves it."

**Why `automation` and not `production`.** These jobs open pull requests and
read a Terraform plan; they do not deploy. Two of the three are scheduled, so
inheriting a production approval gate would leave a scheduled run waiting on a
human who is not there.

**No OIDC subject changed.** `infra/oidc.tf` records that declaring an
environment rewrites the OIDC subject, and that a stale federated credential
fails with `AADSTS700213`. That hazard applies to jobs which exchange a token —
none of these three calls `azure/login`. The one job in these files that does
(`build` in `publish-content-manifest.yml`) was never flagged and is untouched.

**The remaining half is the owner's, and the order is load-bearing.**
Declaring the environment changes nothing by itself: a repository secret stays
readable from a job in any environment. The control arrives when the secret
becomes an *environment* secret on `automation`.

Each of these three jobs self-arms — an absent secret makes it report "not set
— skipping" and pass **green**. So the order is load-bearing, and only one
order is safe:

1. **This PR first.** A job that declares an environment can still read a
   REPOSITORY secret — environment secrets *override* repository ones, which
   is only meaningful because the repository one would otherwise be readable.
   So declaring `automation` while the secret sits at repository level changes
   nothing and breaks nothing.
2. **The secret moves second.** By then the job names the environment, so it
   resolves.

The reverse is the trap: move the secret to `automation` while the job has no
`environment:` key and it resolves EMPTY. The job then reports "not set —
skipping" and passes green while the automation is dead — the #630 shape, a
silent no-op behind a passing check.

Stated explicitly because the opposite order is an easy and costly thing to
assume. See [Owner follow-up](#owner-follow-up-2026-09-18).

**On zizmor's own view of this rule.** Since 1.24.0 `secrets-outside-env` is
auditor-persona only, because the remediation has platform sharp edges — most
notably that environment secrets do not reach reusable workflows unless the
caller passes `secrets: inherit`. That caveat does not apply here: none of
these three workflows is called through `workflow_call`. zizmor also cannot
see where a secret is actually stored, so it will report this clear once the
`environment:` key exists whether or not step 2 ever happens. The key is the
evidence that step 2 is possible, not that it was done.

### TFC_TOKEN has no OIDC alternative

Worth recording so nobody re-researches it. HCP Terraform's API accepts a
bearer API token and nothing else — there is no GitHub-OIDC path to
`app.terraform.io/api/v2`. Three things are mistaken for one and none replaces
`TFC_TOKEN`: *dynamic provider credentials* federate a Terraform **run** into
Azure (the other direction), *HCP workload identity federation* mints an HCP
**platform** token for HCP services, and *VCS-driven runs* remove CI from the
path rather than federating it.

The controls that do apply are scope, expiry and placement, and they are owner
actions:

- A **team** token, not a user token (dies with the person) or an organization
  token (owner-equivalent). `tfc-plan-check.yml`'s header already says a user
  or team token with workspace admin is required.
- An **expiration**, with rotation on it. HCP Terraform warns at 30 and 7 days
  and allows concurrent team tokens, so rotation needs no outage window.
- `deploy-functions.yml` reads `TFC_TOKEN` inside a job that already declares
  `environment: production`, so an environment secret there would override the
  repository one and put the deploy-path token behind that gate.

## Owner follow-up 2026-09-18

Nothing below is reachable from this repository; each is a change in GitHub or
HCP Terraform settings.

1. **Create the `automation` environment** — it is created implicitly the first
   time a workflow referencing it runs, so this is only needed to set rules on
   it. **Do not add required reviewers**: `publish-content-manifest.yml`,
   `update-learn-catalogue.yml`, `update-avm-versions.yml` (#671) and
   `update-version-floors.yml` (#715) are scheduled, and an approval gate
   would leave those runs waiting rather than failing. A branch restriction is the useful rule here.
2. **Move `MANIFEST_APP_PRIVATE_KEY` and `TFC_TOKEN`** from repository secrets
   to `automation` environment secrets — **after** this PR merges, never
   before, for the silent-green reason above.
3. **`TFC_TOKEN` hygiene** — team token, with an expiry, as above.

## checkov

Inline suppressions are `#checkov:skip=RULE:reason` on the Terraform resource,
or `# checkov:skip=RULE:reason` (YAML comment spacing) on the
`workflow_dispatch:` key of the workflow. Checkov accepts both spellings. The one repository-wide skip is in
`.checkov.yaml`, with its reason.

### workflow_dispatch inputs, CKV_GHA_7 (10): 8 accepted, 2 fixed

CKV_GHA_7 is a SLSA build-integrity rule: "workflow_dispatch inputs MUST be
empty". None of these workflows builds a release artifact from its inputs, and
every input reaches its script only through `env:`, never through `${{ }}`
inside `run:`. Only people with write access can dispatch a workflow.

| Rule | File:line | Verdict | Evidence | Resolution |
| --- | --- | --- | --- | --- |
| CKV_GHA_7 | `.github/workflows/audit-published-pages.yml:16` | Accepted | Read-only page audit. `only` is a path prefix and `strict` a boolean, both via env. | Inline skip, this PR |
| CKV_GHA_7 | `.github/workflows/deploy-azure-frontend.yml:56` | Accepted | Break-glass `entra_client_id_override` is refused unless it matches the GUID pattern, before it is printed or built in. Runbook: [Admin sign-in rollback](../runbooks/admin-signin-rollback.md). | Inline skip, this PR |
| CKV_GHA_7 | `.github/workflows/heal-computed-properties.yml:39` | Accepted | `mode` is a `choice` of `apply` or `inspect`, passed via env as one flag. | Inline skip, this PR |
| CKV_GHA_7 | `.github/workflows/monitor-deploy-drift.yml:83` | Accepted | Read-only monitor. `scripts/check-deploy-drift.mjs` refuses a threshold that is not a positive number. | Inline skip, this PR |
| CKV_GHA_7 | `.github/workflows/monitor-unresolved-secrets.yml:51` | Accepted | Read-only monitor on the Reader identity. App and resource group names go via env into a quoted ARM URL. | Inline skip, this PR |
| CKV_GHA_7 | `.github/workflows/tfc-plan-check.yml:74` | Accepted | Read-only plan check. `scripts/check-tfc-plan.mjs` validates the run id against `^[A-Za-z0-9]{8,}$`, and uses the commit only for comparison, never in a URL. | Inline skip, this PR |
| CKV_GHA_7 | `.github/workflows/monitor-functions-registered.yml:104` | Fixed | The inputs (app, resource group, minimum count) only repeated the one estate's values. A dispatch could only point the monitor at the wrong app or loosen its threshold. Now fixed in `env:`, so a manual run checks what the schedule checks. | Inputs removed, 2026-09-14 |
| CKV_GHA_7 | `.github/workflows/verify-alert-state.yml:49` | Fixed | Same shape: one resource group input whose only other value would be wrong. | Input removed, 2026-09-14 |
| CKV_GHA_7 | `.github/workflows/cloudflare-dns-audit.yml:69` | Accepted | Read-only audit that builds nothing. `since` and `before` reach the script through `env`; `since` is now checked against the script's own date pattern (`parseWhen` in `scripts/cloudflare-dns-audit.mjs`) before it is written to the step's outputs, because a line break in it could have added an output of its own. The script refuses a bad `before`; `open_issue` is a boolean. | Inline skip and the `since` check, 2026-11-24 |
| CKV_GHA_7 | `.github/workflows/lab-host-arc-run.yml:52` | Accepted | `action` is a `choice` of three fixed scripts, matched by a fixed `case` that refuses any other value, behind the `lab-host-arc` environment's reviewers and its main-only branch rule. | Inline skip, 2026-11-24 |

### Terraform (36)

Infra files at `357114f4`, and the last three rows from #726 on 2026-09-29.
Owner decisions were read from `infra/variables.tf` and `docs/decisions/`
before any verdict.

| Rule | File:line | Resource | Verdict | Reason and evidence | Resolution |
| --- | --- | --- | --- | --- | --- |
| CKV2_AZURE_47 | `infra/storage.tf:363` | `azurerm_storage_account.functions` | Fixed | Anonymous blob access was left at the provider default (true). No container on the account is anonymous, so `allow_nested_items_to_be_public = false` is free, in place and reversible. The content account already sets it. | This PR |
| CKV_AZURE_190 | `infra/storage.tf:363` | `azurerm_storage_account.functions` | Fixed | Same change as above. | This PR |
| CKV_AZURE_132 | `infra/cosmos.tf:20` | `azurerm_cosmosdb_account.hcw` | Fixed | `access_key_metadata_writes_enabled = false`. Local auth is already off, so nothing live changes. It keeps schema writes on Resource Manager if keys are ever switched back on. Free, in place, reversible. | This PR |
| CKV_AZURE_140 | `infra/cosmos.tf:20` | `azurerm_cosmosdb_account.hcw` | False positive | `local_authentication_enabled = !var.cosmos_local_auth_disabled`, and the variable defaults to `true`. checkov cannot evaluate the negation. | Inline skip, this PR |
| CKV_AZURE_110 | `infra/keyvault.tf:19` | `azurerm_key_vault.hcw` | Fixed | Purge protection is on by owner decision 2026-09-14, [ADR 0031](../decisions/0031-security-scanner-owner-decisions.md), superseding ADR 0021. `var.purge_protection_enabled` defaults to `true`. One-way. | Skip removed, 2026-09-14 |
| CKV_AZURE_42 | `infra/keyvault.tf:19` | `azurerm_key_vault.hcw` | Fixed | Purge protection plus 90-day soft delete, as above. | Skip removed, 2026-09-14 |
| CKV2_AZURE_21 | `infra/storage.tf:151` | `azurerm_storage_container.blogs` | False positive | Blob read logging is on for the whole content account: `azurerm_monitor_diagnostic_setting.content_blob` (`infra/observability.tf`) sends StorageRead, StorageWrite and StorageDelete to Log Analytics. checkov looks only for `azurerm_log_analytics_storage_insights`. | Inline skip, this PR |
| CKV2_AZURE_21 | `infra/storage.tf:157` | `azurerm_storage_container.covers` | False positive | As above. | Inline skip, this PR |
| CKV2_AZURE_21 | `infra/storage.tf:163` | `azurerm_storage_container.certifications` | False positive | As above. | Inline skip, this PR |
| CKV2_AZURE_21 | `infra/storage.tf:169` | `azurerm_storage_container.speakerevents` | False positive | As above. | Inline skip, this PR |
| CKV2_AZURE_21 | `infra/storage.tf:175` | `azurerm_storage_container.content` | False positive | As above. | Inline skip, this PR |
| CKV2_AZURE_21 | `infra/storage.tf:186` | `azurerm_storage_container.listenandlearn` | False positive | As above. | Inline skip, this PR |
| CKV2_AZURE_21 | `infra/storage.tf:199` | `azurerm_storage_container.podcast` | False positive | As above. | Inline skip, this PR |
| CKV2_AZURE_21 | `infra/storage.tf:225` | `azurerm_storage_container.cosmos_export` | False positive | As above. | Inline skip, this PR |
| CKV2_AZURE_21 | `infra/storage.tf:248` | `azurerm_storage_container.interviews_audio` | False positive | As above. | Inline skip, #1565 |
| CKV2_AZURE_33 | `infra/storage.tf:363` | `azurerm_storage_account.functions` | Accepted | [ADR 0008](../decisions/0008-selective-private-link.md) accepts public endpoints on Function host storage. The network rules default to Deny and allow the integration subnet. No private endpoints, [ADR 0031](../decisions/0031-security-scanner-owner-decisions.md). | Inline skip |
| CKV_AZURE_59 | `infra/storage.tf:363` | `azurerm_storage_account.functions` | Accepted | Same decision. Disabling the public endpoint also closes the per-run firewall window `deploy-functions.yml` uploads through. | Inline skip |
| CKV2_AZURE_21 | `infra/storage.tf` | `azurerm_storage_container.function_releases` | Accepted | Host blob writes and deletes go to Log Analytics (`azurerm_monitor_diagnostic_setting.functions_blob`). Reads do not: measured at about 573,000 a day, roughly 0.6 GB/day, more than the whole daily cap (0.25 GB then, 0.5 GB since 2026-11-22), which would then stop the log alert rules. checkov looks only for `azurerm_log_analytics_storage_insights`, which needs account keys. [ADR 0031](../decisions/0031-security-scanner-owner-decisions.md) decision 8. | Inline skip, 2026-09-14 |
| CKV_AZURE_33 | `infra/storage.tf` | `azurerm_storage_account.hcw` | False positive | Queue read, write and delete logs go to Log Analytics through `azurerm_monitor_diagnostic_setting.content_queue`. checkov reads only classic `queue_properties.logging`, which Terraform cannot write through the firewall. | Diagnostic setting and inline skip, 2026-09-14 |
| CKV_AZURE_33 | `infra/storage.tf` | `azurerm_storage_account.functions` | False positive | As above, through `azurerm_monitor_diagnostic_setting.functions_queue`. Measured at about 8,700 queue transactions a day, roughly 10 MB/day. | Diagnostic setting and inline skip, 2026-09-14 |
| CKV2_AZURE_33 | `infra/storage.tf` | `azurerm_storage_account.hcw` | Accepted | No private endpoints, owner decision 2026-09-14, [ADR 0031](../decisions/0031-security-scanner-owner-decisions.md). The service firewall defaults to Deny and admits the integration subnet. | Inline skip, 2026-09-14 |
| CKV_AZURE_59 | `infra/storage.tf` | `azurerm_storage_account.hcw` | Accepted | `publicNetworkAccess = Disabled` allows private endpoint traffic only, so it would also refuse the subnet service-endpoint rule the app uses. The account is on selected networks with default Deny. ADR 0031 decision 4. | Inline skip, 2026-09-14 |
| CKV2_AZURE_1 | `infra/storage.tf` | `azurerm_storage_account.hcw` | Accepted | Microsoft-managed keys, owner decision 2026-09-14, ADR 0031. | Inline skip, 2026-09-14 |
| CKV2_AZURE_1 | `infra/storage.tf` | `azurerm_storage_account.functions` | Accepted | As above. | Inline skip, 2026-09-14 |
| CKV_AZURE_206 | `infra/storage.tf` | `azurerm_storage_account.functions` | Fixed | LRS to GRS, in place. Timer schedule status, leases and in-flight queue messages survive a regional loss. Cents a month. | 2026-09-14 |
| CKV_AZURE_101 | `infra/cosmos.tf:20` | `azurerm_cosmosdb_account.hcw` | Accepted | As CKV_AZURE_59: disabling public network access would refuse the `virtual_network_rule`. The firewall admits the integration subnet and empty-by-default operator IPs ([ADR 0025](../decisions/0025-cosmos-firewall-datacenter-sentinel.md)). | Inline skip, 2026-09-14 |
| CKV_AZURE_100 | `infra/cosmos.tf:20` | `azurerm_cosmosdb_account.hcw` | Accepted | Microsoft-managed keys, ADR 0031. CMK is one-way on an existing account. | Inline skip, 2026-09-14 |
| CKV2_AZURE_32 | `infra/keyvault.tf:19` | `azurerm_key_vault.hcw` | Accepted | No private endpoints, ADR 0031. `network_acls` default Deny with the subnet service-endpoint rule. | Inline skip, 2026-09-14 |
| CKV_AZURE_212 | `infra/functionapp.tf:13` | `azurerm_service_plan.hcw` | Accepted | FC1 has no `worker_count`. Failover instances on Flex are always-ready instances, declined by the owner against the USD 150 budget, ADR 0031. | Inline skip, 2026-09-14 |
| CKV_AZURE_225 | `infra/functionapp.tf:13` | `azurerm_service_plan.hcw` | Accepted | Zone redundancy on Flex forces at least two always-ready instances, about USD 40/month. Declined, ADR 0031. | Inline skip, 2026-09-14 |
| CKV_AZURE_109 | `infra/lab-hybrid.tf` | `azurerm_key_vault.lab_hybrid` | Accepted | Network default Allow on purpose. The only caller is HashiCorp Vault on the lab VPS, whose address belongs to the `hcw-lab` workspace that `infra/` never reads (ADR 0032 decision 1), and an IP rule that drifted from it would leave Vault unable to unseal, which its recovery keys cannot do. Entra ID and one key-scoped grant gate every call, and AuditEvent logs each unwrap with the caller's address. [ADR 0032](../decisions/0032-learner-labs-platform.md#amendment-2026-09-29-vault-auto-unseal-through-the-arc-identity), amendment of 2026-09-29. | Inline skip, 2026-09-29 (#726) |
| CKV_AZURE_189 | `infra/lab-hybrid.tf` | `azurerm_key_vault.lab_hybrid` | Accepted | Public network access stays on for the same reason: the VPS is outside Azure and has no private path to the vault. | Inline skip, 2026-09-29 (#726) |
| CKV2_AZURE_32 | `infra/lab-hybrid.tf` | `azurerm_key_vault.lab_hybrid` | Accepted | No private endpoints, ADR 0031, and a private endpoint could not serve a caller outside Azure. | Inline skip, 2026-09-29 (#726) |
| CKV_AZURE_134 | `infra/foundry.tf` | `azurerm_cognitive_account.foundry` | Accepted | Public endpoint, Entra only (`local_auth_enabled = false`, so the account has no keys). The Functions subnet has no Cognitive Services service endpoint, so turning public access off would cut the AI router off. The file already names restricting it to the VNet as a follow-up for the owner. | Inline skip, 2026-11-24 |
| CKV2_AZURE_22 | `infra/foundry.tf` | `azurerm_cognitive_account.foundry` | Accepted, owner confirmed 2026-11-24 | Microsoft-managed keys, as [ADR 0031](../decisions/0031-security-scanner-owner-decisions.md) chose on 2026-09-14 for the storage and Cosmos accounts. This account came later (2026-10-04); the owner extended that choice to it on 2026-11-24, in the session behind #1841. A customer-managed key needs a paid Key Vault key; on this kind of account it can be switched off again ([Microsoft Learn](https://learn.microsoft.com/azure/ai-foundry/openai/encrypt-data-at-rest#disable-customer-managed-keys)). | Inline skip, 2026-11-24 |
| CKV_AZURE_238 | `infra/foundry.tf` | `azurerm_cognitive_account.foundry` | Accepted | The rule asks the account to have its own managed identity. The account makes no outbound call that would use one: callers reach it with their own identity (the Function App's, holding "Cognitive Services OpenAI User"). Adding one would be an unused identity. | Inline skip, 2026-11-24 |

### Ansible (11)

From #726 on 2026-09-29, the `vault` role's auto-unseal checks. Inline
skips on an Ansible task are `# checkov:skip=RULE:reason` inside the task,
above the module, which checkov honours when handed the single file.

| Rule | File | Task | Verdict | Reason and evidence | Resolution |
| --- | --- | --- | --- | --- | --- |
| CKV2_ANSIBLE_1 | `lab-host/ansible/roles/vault/tasks/seal.yml` | Ask the Arc agent for a Key Vault token | Accepted | The Azure Connected Machine agent serves its token endpoint only as plain HTTP on `127.0.0.1:40342`, as Microsoft documents and as Vault's own credential chain calls it. Nothing leaves the host, and the answer is a path to a file only root and the `himds` group can read. | Inline skip, 2026-09-29 (#726) |
| CKV2_ANSIBLE_1 | `lab-host/ansible/roles/vault/tasks/seal.yml` | Answer the challenge and receive a Key Vault token | Accepted | As above: the same loopback endpoint, which issues the token. | Inline skip, 2026-09-29 (#726) |
| CKV2_ANSIBLE_1 | `lab-host/ansible/roles/vault/tasks/seal.yml` | Read the seal key through Key Vault | Fixed | The URL was HTTPS, held in a variable checkov cannot resolve. It is now written out in the task, beginning `https://`. | 2026-09-29 (#726) |
| CKV2_ANSIBLE_1 | `lab-host/ansible/roles/addons/tasks/main.yml:383` | Add-on health read | Accepted | The add-on's own port on `127.0.0.1` (`addons_publish_address` in the role's `vars/main.yml`); nothing leaves the host. | Inline skip, 2026-11-24 |
| CKV2_ANSIBLE_1 | `lab-host/ansible/roles/caddy/tasks/main.yml:220` | Check that Caddy answers on the admin socket | Accepted | A request over Caddy's Unix admin socket; the host in the URL is never looked up. | Inline skip, 2026-11-24 |
| CKV2_ANSIBLE_1 | `lab-host/ansible/roles/coder/tasks/first_user.yml:30` | First user | Accepted | Coder's port on loopback `127.0.0.1:7080` only. | Inline skip, 2026-11-24 |
| CKV2_ANSIBLE_1 | `lab-host/ansible/roles/coder_sandbox/tasks/main.yml:324` | rootlesskit API | Accepted | rootlesskit's Unix API socket. | Inline skip, 2026-11-24 |
| CKV2_ANSIBLE_1 | `lab-host/ansible/roles/labs_agent/tasks/docker_proxy.yml:138` | Docker proxy check | Accepted | The Docker proxy's Unix socket. | Inline skip, 2026-11-24 |
| CKV_ANSIBLE_1 | `lab-host/ansible/roles/portainer/tasks/main.yml:107` | Portainer is up | Accepted | Portainer's own self-signed certificate on `127.0.0.1`; the read sends no token and only asks whether Portainer answers. A comment above the task says so. | Inline skip, 2026-11-24 |
| CKV2_ANSIBLE_3 | `lab-host/ansible/roles/arc/tasks/onboard.yml:127` | Onboarding block | Fixed | A `rescue:` ending in `ansible.builtin.fail` with the runbook pointer; the run still stops as before and `always:` still deletes the connect file. Checked in a scratch play: both "fatal" lines print, so `arc-run/bootstrap.sh` still names the failed task; recap `failed=1 rescued=1`, exit 2. | Rescue added, 2026-11-24 |
| CKV2_ANSIBLE_3 | `lab-host/ansible/roles/hardening/tasks/arc_gate.yml:44` | Arc gate block | Fixed | As above; the `fail` says port 22 and sshd were left unchanged (this file runs before `sshd.yml` and `ufw.yml`). | Rescue added, 2026-11-24 |

**A block cannot take an inline skip** (checkov 3.2.495, found 2026-11-24):
checkov files a skip on a block under `block..Name` and reports the finding
as `block.Name`, so they never match, whatever the comment's placement. A
block finding is fixed in code (as CKV2_ANSIBLE_3 above) or not at all.
Also, checkov did not check `uri` tasks nested in a block for
CKV2_ANSIBLE_1 in that test, so a plain-HTTP call inside a block is not
seen by it; the reviewer checks those by hand.

### Coder templates

| Rule | File | Verdict | Reason and evidence | Resolution |
| --- | --- | --- | --- | --- |
| CKV_TF_1 | `lab-host/coder/templates/hcw-lab/main.tf:393`, `amo-guided-lab/main.tf:253`, `na-guided-lab/main.tf:252` | Accepted | The `code-server` module comes from the Coder registry (`registry.coder.com/coder/code-server/coder`) pinned to the exact release `1.6.0`; a registry source cannot take a commit hash. The two guided-lab templates already carried the skip with no row here; `hcw-lab` lacked it. | Inline skip, 2026-11-24 (row covers all three) |

### Secrets (1)

| Rule | File:line | Verdict | Evidence | Resolution |
| --- | --- | --- | --- | --- |
| CKV_SECRET_6 | `scripts/docs/wiki-redirects.json:69` | False positive | The flagged string is the Wiki page name `Variables-And-Secrets`. It is the entropy heuristic, and the file maps retired page names to docs paths. JSON cannot take an inline skip, and checkov ignores `skip-path` when Qlty hands it single files. So `.checkov.yaml` skips CKV_SECRET_6, the entropy rule only. Secret detection stays with gitleaks, trufflehog and checkov's format-specific secret rules. | `.checkov.yaml`, this PR |

## trivy

Inline suppressions are `#trivy:ignore:AVD-AZU-NNNN` on the line above the
finding. No `.trivyignore` is needed.

| Rule | File:line | Verdict | Reason and evidence | Resolution |
| --- | --- | --- | --- | --- |
| AZU-0016 | `infra/keyvault.tf:26` | Fixed | Purge protection on, owner decision 2026-09-14, [ADR 0031](../decisions/0031-security-scanner-owner-decisions.md). Same as checkov CKV_AZURE_110. | Ignore removed, 2026-09-14 |
| AZU-0057 | `infra/storage.tf:49` | False positive | trivy reads only classic `queue_properties.logging`. Blob and queue resource logs for this account go to Log Analytics through `content_blob` and `content_queue`. | Inline ignore |
| AZU-0057 | `infra/storage.tf` | False positive | The Function host account now logs queues, and blob writes and deletes, through `functions_queue` and `functions_blob`. trivy reads only classic logging. | Diagnostic settings and inline ignore, 2026-09-14 |
| AZU-0061 | `infra/storage.tf:49` | Accepted | Infrastructure encryption can be set only at account creation. The owner kept this account, ADR 0031. | Inline ignore, 2026-09-14 |
| AZU-0061 | `infra/storage.tf` | Accepted | As above, on the Function host account. | Inline ignore, 2026-09-14 |
| AZU-0058 | `infra/storage.tf` | Fixed | Host storage is GRS. Same change as checkov CKV_AZURE_206. | 2026-09-14 |
| AZU-0013 | `infra/lab-hybrid.tf` | Accepted | Network default Allow on `azurerm_key_vault.lab_hybrid`, the lab-only Key Vault; the reason is checkov CKV_AZURE_109's row. Without the ignore it is the file's one finding at any severity (CRITICAL), measured with trivy 0.69.3. | Inline ignore, 2026-09-29 (#726) |
| AZU-0012 | `infra/lab-hybrid-backups.tf` | Accepted | Network default Allow, no rules, on `azurerm_storage_account.lab_hybrid_backups`, the lab host's backup account (LAB-9, #955): the only writer is the lab VPS, outside Azure, whose address infra/ does not own (ADR 0032 decision 1), so an IP rule would drift and stop the nightly backup silently; shared keys are off, OAuth is the default, the Arc identity's grant is container-scoped and the container is immutable for 35 days. The reason the lab Key Vault accepts AZU-0013. Measured with trivy 0.69.3 on #1147: the file's one finding at HIGH or CRITICAL. | Inline ignore, 2026-10-14 (#1147) |
| AZU-0061 | `infra/lab-hybrid-backups.tf` | Accepted, owner confirmed 2026-11-24 | Infrastructure encryption can be set only when an account is created. [ADR 0031](../decisions/0031-security-scanner-owner-decisions.md) decided against it on 2026-09-14 for the two storage accounts that existed then; this account came later (2026-10-14); the owner extended that decision to it on 2026-11-24, in the session behind #1841. | Inline ignore, 2026-11-24 |
| AZU-0057 | `infra/lab-hybrid-backups.tf` | False positive | trivy reads only the classic per-account logging switch. Blob reads, writes and deletes go to Log Analytics through `azurerm_monitor_diagnostic_setting.lab_hybrid_backups_blob` (StorageRead, StorageWrite, StorageDelete); the account has no queues. | Inline ignore, 2026-11-24 |

Two trivy ignores on one resource must sit on consecutive lines directly above
it. A comment line between them drops the upper one, as found locally with
trivy 0.69.2.

## bandit

Developer tooling that Claude Code runs on the owner's machine and that CI
smoke-tests (`ci.yml`, harness job). No argument comes from outside the
repository.

| Rule | File:line | Verdict | Reason and evidence | Resolution |
| --- | --- | --- | --- | --- |
| B404 | `hooks/claude_event.py:14` | Accepted | Importing `subprocess` is the finding. Every call below it uses a list argv and never `shell=True`. | `# nosec B404` with the reason, this PR |
| B607 | `hooks/claude_event.py:30` | Fixed | `git` was resolved from `PATH` at call time. It is now resolved once with `shutil.which("git")` and passed as an absolute path. When git is missing, the hook takes the existing no-git fallback. | This PR |
| B603 | `hooks/claude_event.py:30` | Accepted | Constant argv `rev-parse --show-toplevel`. | `# nosec B603` with the reason, this PR |
| B603 | `hooks/claude_event.py:87` | Accepted | Runs `sys.executable` on the repository's own `tooling/workflow.py`. The workflow id is one argv element read from the repository's state file, with no shell. | `# nosec B603` with the reason, this PR |
| B404 | `tooling/workflow.py:26` | Accepted | As for the hook. | `# nosec B404` with the reason, this PR |
| B607 | `tooling/workflow.py:54` | Fixed | As for the hook. | This PR |
| B603 | `tooling/workflow.py:54` | Accepted | Constant argv. | `# nosec B603` with the reason, this PR |

### bandit settings (2026-11-24)

Qlty runs bandit as `bandit --ini .bandit`, and until 2026-11-24 there was no
`.bandit`, so every check was on and every new helper that ran a program
added findings. Qlty shows bandit's LOW findings as HIGH, so they counted
against the Security grade.

[`.bandit`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/.bandit) turns off two checks, because each flags the safe
form:

| Check | What it flags | Why it is off |
| --- | --- | --- |
| B404 | `import subprocess` | It fires on the import alone, in any file that runs a program. |
| B603 | `subprocess` called with a list and no shell | The list form passes the program and its arguments separately and no shell reads them, so an argument cannot start a second command. |

Every check for the risky forms stays on: B602 (`shell=True`), B605
(`os.system`), B607 (a program named without its full path) and the rest.
The `# nosec B404` and `# nosec B603` comments in the table above are now
redundant and harmless; they were left in place.

The other six findings were handled in code:

| Rule | File | Verdict | Resolution |
| --- | --- | --- | --- |
| B607 | `scripts/complexity/measure.py` (two calls) | Fixed | `git` is resolved once with `shutil.which` and called by its full path; a clear error if it is missing. |
| B607 | `lab-host/ansible/roles/docker/files/hcw-docker-volume-carry.py` | Fixed | `cp` is called by its full path. |
| B607 | `lab-host/ansible/roles/coder/tests/hcw-coder-automation.test.py` | Fixed | `sh` is called by its full path. |
| B311 | `lab-host/ansible/roles/coder/tests/hcw-coder-automation.test.py` | Accepted | `random` makes the fake server's made-up keys and ids; nothing about it needs to be unpredictable. `# nosec B311` on the line, with the reason. |
| B311 | `lab-host/ansible/roles/portainer/tests/hcw-portainer-check.test.py` | Accepted | As above. |

## gitleaks

### gitleaks rules (2026-11-24)

[`.gitleaks.toml`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/.gitleaks.toml) keeps every built-in rule
(`[extend] useDefault = true`) and adds allowlists that say what a harmless
match **is**. Each names the one rule it answers (`targetRules`), so every
precise rule (AWS keys, GitHub tokens, private keys and the rest) still runs
everywhere, test files included; only the broad `generic-api-key` heuristic
is quietened, and only where an allowlist says. They hold when a line moves or a new file arrives. Qlty
passes the file to gitleaks with `--config` (its gitleaks plugin lists
`config_files = [".gitleaks.toml"]` in CLI 0.672.0). The note further down
that "Qlty's gitleaks plugin did not read one when tested" was true of the
earlier CLI 0.644.0 test and is no longer.

Every one of the 37 matches in tracked files on 2026-11-24 (gitleaks' built-in rules alone) was read in full
before this was written. None is printed here.

| Allowlist | Matches it covers | Why it is safe |
| --- | --- | --- |
| `generic-api-key` in test files: `*.test.*`, `*.spec.*`, `*.Tests.ps1`, `test_*.py`, `tests/`, `__tests__/`, `__fixtures__/` | 29: made-up keys such as `0123456789abcdef…` and `sk_test1234567890` in 19 test files | Values there are invented so the code under test has something to read. Every other gitleaks rule still runs on these files. Note that `tests/` also holds a few non-test helpers and captured output (for example `lab-host/ansible/roles/privilege_checks/tests/*.txt`); a real provider key there is still caught by the precise rules. |
| `generic-api-key` on a line that is only `NAME_SHA256=<64 hex>` | 2 in `lab-image/versions.env` | A published checksum of a download. It unlocks nothing. Nothing else may follow on the line, so a value after it is still checked. |
| `generic-api-key` on a line that is only `…_fingerprint: <40 hex>` | 1 in `lab-host/ansible/roles/vault/defaults/main.yml` | The fingerprint of a public PGP key. |
| `sourcegraph-access-token` whose matched value is exactly 40 hex characters, in `docs/**/*.md` | 2 in `docs/architecture/azure-architecture-mcp-appliance.md` | A git commit id has the same 40-hex shape as a legacy Sourcegraph token. The test is on the matched value, not the line, so a modern `sgp_` token beside it is still checked. |
| `generic-api-key` whose matched value is exactly `token=<UUID>`, in `frontend/data/content-manifest.json` only | 3 there (Qlty excludes the folder; gitleaks alone does not) | The download token at the end of a Firebase Storage link; it reads one public image (rows below). The test is on the matched value, not the line, so another key on the same line is still caught (checked by planting one, 2026-11-24, after Copilot's review on #1841). |

Tested with gitleaks 8.29.1: 37 matches before, 0 after, on the whole tree
and file by file as Qlty runs it. The same files without the config still
report (exit 101). Still reported with the config: a random 32-character key
in a non-test source file; an AWS access key and a GitHub token planted in a
`tests/` folder; a GitHub token after a checksum on a `_SHA256=` line; a
generic key on a one-line JSON file that also holds a Firebase link.

**What else catches a real key.** GitHub secret scanning and push protection
are on for this repository and catch known providers' tokens. trufflehog runs
in Qlty with `--only-verified`, so it reports only a key the issuer confirms
is live; it is not a net for a made-up-looking value. The first version of
this page said trufflehog "still scans test files" as if it were; the
independent review on #1841 showed it is not, and the allowlists were
narrowed with `targetRules` instead.

`.gitleaksignore` keeps one entry, the Cosmos DB emulator key in
`functions/local.settings.json.example`: JSON cannot carry an inline comment,
and an allowlist on `.example` files would also wave through a real key
pasted into one. The content-manifest and NewsletterConfirmPage entries left
it because the rules above cover them.

### Record of 2026-09-14

All are `generic-api-key`, and each was read in full before it was
silenced. None is printed here. The nine from 2026-09-14 are fingerprints in
`.gitleaksignore`; the last row, from #726, is an inline `gitleaks:allow` on
the line itself.

| Rule | File:line | Verdict | Evidence | Resolution |
| --- | --- | --- | --- | --- |
| generic-api-key | `frontend/data/content-manifest.json:407` | False positive | A Firebase Storage download URL (`firebasestorage.googleapis.com/v0/b/.../o/...?alt=media&token=...`) for an image the public site already serves. The token grants read on that one public object. | `.gitleaksignore`, this PR |
| generic-api-key | `frontend/data/content-manifest.json:830` | False positive | As above. | `.gitleaksignore`, this PR |
| generic-api-key | `frontend/data/content-manifest.json:831` | False positive | As above. | `.gitleaksignore`, this PR |
| generic-api-key | `frontend/src/pages/NewsletterConfirmPage.test.jsx:16` | False positive | Test fixture. Its two base64url parts decode to `{"v":1}` and `signature`. | `.gitleaksignore`, this PR |
| generic-api-key | `functions/local.settings.json.example:7` | False positive | `COSMOS_KEY` is the Azure Cosmos DB emulator's published well-known key, byte for byte, next to `COSMOS_ENDPOINT` `https://localhost:8081/`. | `.gitleaksignore`, this PR |
| generic-api-key | `scripts/cutover/01-entra-api.ps1:51` | False positive, since removed | `$ApiAppId` default: the Entra API application (client) id. It is an identifier, not a credential. The default went in the follow-up to [#1540](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1540): the scripts look the id up by the registration's name (`scripts/lib/Resolve-EntraApiAppId.ps1`), so there is no line to fingerprint and the four entries left `.gitleaksignore`. | Removed from `.gitleaksignore`, #1540 follow-up |
| generic-api-key | `scripts/cutover/02-entra-spa-client.ps1:75` | False positive, since removed | As above. | As above |
| generic-api-key | `scripts/cutover/03-entra-dev-client.ps1:61` | False positive, since removed | As above. | As above |
| generic-api-key | `scripts/rollback/restore-admin-signin.ps1:60` | False positive, since removed | As above. | As above |
| generic-api-key | `lab-host/ansible/roles/vault/defaults/main.yml`, `vault_seal_azurekeyvault_vault_name` | False positive | The name of the lab-only Key Vault that `infra/lab-hybrid.tf` creates, an identifier and not a credential. The rule reads "key" inside `azurekeyvault` in the variable's name. | Inline `# gitleaks:allow` on that line, 2026-09-29 (#726): it moves with the line, where a fingerprint would not |

A filesystem fingerprint is `path:rule:line`. `publish-content-manifest.yml`
regenerates the manifest weekly, so its three lines move. When they
reappear, check that the new lines are the same URL shape, then move the
fingerprints. A `.gitleaks.toml` allowlist keyed on the URL shape would
survive regeneration, but Qlty's gitleaks plugin did not read one when tested,
so it was not added.

## osv-scanner

osv-scanner checks the lock files against the public OSV list of known
vulnerable package versions. Since 2026-11-24 the `Qlty security scan` job
fails a pull request that changes a lock-file line with a high or medium
advisory. Normally the answer is the upgrade. When no fixed version exists
yet, the route is an `osv-scanner.toml` beside the lock file, one
`[[IgnoredVulns]]` entry per advisory with its `id`, a `reason` and an
`effectiveUntil` date (the day the ignore stops applying) no more than 90
days out, plus a row here first. None
exists today. Format:
[osv-scanner configuration](https://google.github.io/osv-scanner/configuration/).

## lab-image smoke fixtures

**Excluded from Qlty on 2026-11-24.** Every file under `lab-image/smoke/` is an
input that `lab-image/smoke.sh` hands to a validator inside the lab image
(`hcw-kubeconform`, `hcw-helm-template`, `hcw-terraform-validate`,
`ansible-playbook --check`) to prove the validator works. Nothing there is
applied or deployed, `kubeconform-payload/invalid` is broken on purpose, and
`terraform-validate-payload/main.tf` is rewritten by
`update-avm-versions.yml`.

checkov's and trivy's production Kubernetes and Terraform rules reported 69
high and medium findings on those files (no CPU limits, `latest` image tag,
no security context and so on). Hardening a test input would change what the
smoke test proves and say nothing about a real cluster, so the folder is
excluded **for checkov and trivy only** by an `[[exclude]]` block in
`.qlty/qlty.toml`; gitleaks, trufflehog and osv-scanner still read the
folder (checked: a key planted there was reported, and without the block
checkov and trivy report 29 findings on one manifest). This says what the
folder is; it is not a silence on a real resource. checkov's `skip-path` was not used, because checkov does not
honour it when Qlty hands it single files (see [Secrets](#secrets-1)).

## radarlint-iac

**2026-11-24.** Four Dockerfile layout findings were fixed (a long `RUN`
line split in `lab-image/Dockerfile`, two consecutive `RUN` steps merged, and
both package lists in `lab-image/sandbox-template/Dockerfile` wrapped and
sorted, with `scripts/lab-image-azure-cli-overrides.test.mjs` taught to read
a wrapped list). One is kept on purpose: S7031 ("merge consecutive RUN") on
the `fetch` stage of `lab-image/Dockerfile`. That stage ships nothing, and
one `RUN` per download means a changed pin fetches only that artefact again.
radarlint-iac has no inline skip, so a `[[triage]]` rule in
`.qlty/qlty.toml` ignores S7031 for that one file only.

Qlty also ran actionlint 1.7.9, which predates the `artifact-metadata`
permission ([GitHub changelog, 2026-01-13](https://github.blog/changelog/2026-01-13-new-fine-grained-permission-for-artifact-metadata-is-now-generally-available/))
and reported it as unknown in `publish-lab-image.yml`. `.qlty/qlty.toml`
now pins actionlint to 1.7.12, CI's version.

> **Retired 2026-10-02 (#821).** #821 repointed the `TODO.md` comments listed
> below. A recount that day (`grep -rn TODO infra`, case-insensitive) found
> **no** TODO token left under `infra/`, so the triage rule was removed from
> `.qlty/qlty.toml` and S1135 reports again in `infra/`. A new hit there is a
> finding: point the comment at an issue instead. The table is the record as
> of 2026-09-14, and its line numbers are from that date.

All 19 were S1135, "Complete the task associated to this TODO comment". Each
match was the file name `TODO.md` inside an explanatory comment, such as
`see TODO.md T-520` or `(TODO.md)`. None was a TODO marker.

| Rule | File:line | Verdict | Resolution |
| --- | --- | --- | --- |
| terraform:S1135 | `infra/cosmos.tf:111` | False positive | Qlty triage rule below |
| terraform:S1135 | `infra/cosmos.tf:333` | False positive | Qlty triage rule below |
| terraform:S1135 | `infra/functionapp.tf:254` | False positive | Qlty triage rule below |
| terraform:S1135 | `infra/functionapp.tf:327` | False positive | Qlty triage rule below |
| terraform:S1135 | `infra/functionapp.tf:338` | False positive | Qlty triage rule below |
| terraform:S1135 | `infra/functionapp.tf:406` | False positive | Qlty triage rule below |
| terraform:S1135 | `infra/functionapp.tf:463` | False positive | Qlty triage rule below |
| terraform:S1135 | `infra/functionapp.tf:586` | False positive | Qlty triage rule below |
| terraform:S1135 | `infra/functionapp.tf:624` | False positive | Qlty triage rule below |
| terraform:S1135 | `infra/functionapp.tf:680` | False positive | Qlty triage rule below |
| terraform:S1135 | `infra/functionapp.tf:732` | False positive | Qlty triage rule below |
| terraform:S1135 | `infra/functionapp.tf:820` | False positive | Qlty triage rule below |
| terraform:S1135 | `infra/keyvault.tf:38` | False positive | Qlty triage rule below |
| terraform:S1135 | `infra/observability.tf:3` | False positive | Qlty triage rule below |
| terraform:S1135 | `infra/oidc.tf:22` | False positive | Qlty triage rule below |
| terraform:S1135 | `infra/oidc.tf:488` | False positive | Qlty triage rule below |
| terraform:S1135 | `infra/outputs.tf:241` | False positive | Qlty triage rule below |
| terraform:S1135 | `infra/outputs.tf:247` | False positive | Qlty triage rule below |
| terraform:S1135 | `infra/variables.tf:107` | False positive | Qlty triage rule below |

radarlint has no inline suppression, and its only configuration is
`.qlty/qlty.toml`, where #588 added this rule (removed by #821). The rule key contains a colon,
so the match needs the plugin prefix; the bare `terraform:S1135` matches
nothing:

```toml
[[triage]]
match.plugins = ["radarlint-iac"]
match.rules = ["radarlint-iac:terraform:S1135"]
match.file_patterns = ["infra/**"]
set.ignored = true
```

Open work lives in GitHub issues (owner decision 2026-09-05). A real TODO in
`infra/` would name an issue number, not a TODO marker, so silencing S1135
there hid nothing the repository relied on. With no hits left, it also
silenced nothing, and leaving S1135 on costs nothing.

## CodeQL

CodeQL runs from `codeql.yml` with `.github/codeql/codeql-config.yml`, which
has excluded `.claude/` and `.agents/`, the vendored Claude Code harness,
with its reason in the file since a5d580b6 (2026-08-15). Its alerts are
dismissed in the code-scanning UI, not in a scanner file, so this section is
the record a dismissal points to. The rule, from the 2026-10-06 estate
assessment (SEC-5, #974): **every dismissal carries a one-line note in the
dismissal comment naming its evidence**: the test that intends the shape, the
sanitiser the query did not follow, or the path exclusion that makes it moot.
A session never dismisses an alert (`.claude/CLAUDE.md`, "A code scanning
alert is fixed in code, or dismissed by the owner"); the owner dismisses, with
the note. A dismissal made before this rule and without a note is listed
below with its evidence instead.

Read 2026-10-14 (Git Bash):

```bash
gh api "repos/saulpatinojr/HCW-HybridCloudWorks/code-scanning/alerts?state=dismissed&per_page=100" --paginate --jq '.[] | [.number, .dismissed_reason, ((.dismissed_comment // "") | length > 0), .most_recent_instance.location.path, .dismissed_at[0:10]] | @tsv'
```

| Dismissed | Reason | Where | Dismissed on | Per-alert note | Evidence |
| ---: | --- | --- | --- | --- | --- |
| 111 | False positive | `.claude/skills/**` | 2026-08-21 | None | The harness's demonstration scripts (67 `py/clear-text-logging-sensitive-data`, 19 `py/insecure-protocol`, 9 `py/clear-text-storage-sensitive-data`, 7 `py/weak-sensitive-data-hashing`, the rest `py/incomplete-url-substring-sanitization`, `py/polynomial-redos`, `py/flask-debug`, `py/bad-tag-filter`): a hash-cracking skill that hashes with MD5, a TLS skill that enables legacy protocols to show them. Never imported or run by the site or its CI. Closed as a class: the paths are excluded from CodeQL by `codeql-config.yml`, and `.claude/skills` is no longer tracked, so none can recur. No note is added to each retroactively; this row is the note |
| 1 | Mitigated | `.claude/skills/**` | 2026-08-21 | None | As above |
| 28 | Won't fix | `frontend/src/**` | 2026-08-25 | Each | Per-alert notes in the dismissal comments |
| 3 | Used in tests | `frontend/src/**` | 2026-08-25 | Each | Per-alert notes |
| 2 | False positive | `frontend/scripts/**` | 2026-08-25 | Each | Per-alert notes |
| 1 | False positive | `frontend/src/**` | 2026-08-25 | Yes | Per-alert note |
| 1 | Won't fix | `functions/src/**` | 2026-08-25 | Yes | Per-alert note |
| 1 | Used in tests | `functions/src/**` | 2026-08-25 | Yes | Per-alert note |
| 1 | False positive | `functions/src/**` | 2026-10-08 | Yes | Per-alert note |
| 1 (#398) | Used in tests | `lab-host/ansible/roles/coder/tests/hcw-coder-automation.test.py:709` | 2026-10-09 | None | `py/overly-permissive-file`: the test makes a file world-readable on purpose to prove `hcw-coder-automation` refuses it (#1035). Recorded in `.claude/CLAUDE.md` as the example of an alert that is right and intended |
| 1 (#388) | False positive | `scripts/open-lab-pin-pr.mjs:226` | 2026-10-14 | None | `js/file-access-to-http`: the pin-bump script reads a repository file it just wrote (the guide page and the pull-request body) and posts the body to GitHub's API with `gh`, which is the script's purpose; the file's contents are the repository's own, not a secret, and the destination is the repository's pull request (#1129, #1131) |
| 1 (#1448), waiting for the owner | False positive (proposed) | `lab-host/ansible/roles/coder/tests/hcw-coder-automation.test.py:1219` | Not yet | Proposed note below | `py/clear-text-storage-sensitive-data`, raised on #1841. The test writes its temporary state file with the **id** part of a made-up key (`leftover.split("-")[0]`); CodeQL follows the whole token from the fake server's variable named `secret` and cannot see that the split drops it. The same flow is on `main` (line 1146 there); it reads as new on #1841 only because that line changed from `"state.json"` to the `STATE_JSON` constant. Not rewritten to slip past the query, per `.claude/CLAUDE.md`. Proposed dismissal note: "False positive: the stored value is a fake key's id, not its secret; test-only data for a fake Coder server (docs/security/scanner-triage.md#codeql)." |

Counts: 151 dismissed in all; 112 harness, 39 first-party. Of the first-party
rows the two without a dismissal note have their evidence above. Open alerts
on `main` on 2026-10-14: none after #1162.

## Owner decisions 2026-09-14

Nothing is left under *Needs owner decision*. The owner decided every group,
and [ADR 0031](../decisions/0031-security-scanner-owner-decisions.md) records each decision with its cost and what it gives up:

| Decision | Findings | Outcome |
| --- | --- | --- |
| Key Vault purge protection on (one-way), superseding ADR 0021 | checkov CKV_AZURE_110, CKV_AZURE_42, trivy AZU-0016 | Fixed: `var.purge_protection_enabled = true` |
| Keep Microsoft-managed keys | checkov CKV2_AZURE_1 (x2), CKV_AZURE_100 | Accepted, inline skips |
| No private endpoints | checkov CKV2_AZURE_33, CKV2_AZURE_32 | Accepted, inline skips |
| Public network access off where possible | checkov CKV_AZURE_59, CKV_AZURE_101 | Accepted. Already *selected networks* with default Deny everywhere; `Disabled` would refuse the service-endpoint rules too |
| Keep the current accounts, no infrastructure encryption | trivy AZU-0061 (x2) | Accepted, inline ignores |
| Function host storage geo-redundancy | checkov CKV_AZURE_206, trivy AZU-0058 | Fixed: GRS |
| Storage resource logs | checkov CKV_AZURE_33 (x2), CKV2_AZURE_21, trivy AZU-0057 | Diagnostic settings for queues on both accounts and host blob writes and deletes. Host blob reads excluded by measurement |
| No Flex zone redundancy or always-ready instances | checkov CKV_AZURE_212, CKV_AZURE_225 | Accepted, inline skips |

## The lab host's two root scripts: split, not kept

**2026-11-25, owner decision on
[#1845](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1845#issuecomment-7153913362).**
This is a code smell, not a security finding; it is recorded here because
the reason it was not simply left alone is a security one.

Qlty reported a *file-complexity* smell (too much logic in one file to
review comfortably) on the two Python scripts that run as root on the lab
host: `lab-host/ansible/roles/coder/files/hcw-coder-automation.py` (1,333
lines, total complexity 211) and
`lab-host/ansible/roles/portainer/files/hcw-portainer-check` (616 lines,
120). Each had been kept as one file on purpose: a script root runs from one
root-owned file imports nothing but Python's own standard library, so there
is nothing else on disk to swap for code of an attacker's choosing.

The owner chose to split them so no file carries a medium or high smell, as
long as the split keeps that property. Each is now a package of modules
split by job (`files/hcw_coder_automation/`, `files/hcw_portainer_check/`),
with every function moved unchanged, and the script in
`/usr/local/libexec` is only the way in. What keeps the modules as safe as
the single file was:

- They are installed in a fixed directory per script,
  `/usr/local/lib/hcw-lab/coder-automation/` and
  `/usr/local/lib/hcw-lab/portainer-check/`, directories `root:root` `0755`
  and files `root:root` `0644`, by the roles' own tasks.
- Both scripts load one launcher,
  `lab-host/ansible/roles/coder/files/hcw-lab-python-launch.py` (installed
  as `/usr/local/libexec/hcw-lab-python-launch` beside the scripts), with the
  directory and the package name as constants. Before anything is imported
  it checks that every directory from `/` down to the package and every file
  in it is a real directory or file, owned by root and writable by root
  alone, and that the directory holds the package and nothing else (so no
  file there can stand in for a standard-library module once it is first on
  the module path). Otherwise it prints one line naming the path and exits
  1, which fails the unit and raises the lab alert like any other failure.
- The scripts still run under `python3 -I`, so no path comes from the
  environment, the working directory or the user's site-packages, and no
  bytecode is written.

Each role's test runs its script against a copy staged in a scratch
directory and checked by the same launcher, and the coder role's test holds
the launcher to every refusal above. With Qlty CLI 0.672.0, `qlty smells`
reports nothing on the scripts, the launcher or any module (the highest
total complexity is 43, under the threshold of 50).
