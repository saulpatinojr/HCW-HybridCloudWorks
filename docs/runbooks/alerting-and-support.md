# Alerting and support

**Scope:** what pages an operator, what each page means, what to look at first,
and — stated as plainly as the coverage itself — what nothing watches.

**State:** the rules described here are declared in `infra/observability.tf`
and `infra/lab-hybrid.tf` on `main`, in two resource groups and two
subscriptions, and [The rules](#the-rules) below has a row for each one. Which
of them the live tenant holds is read every Monday by the **Verify Alert Rule
State** workflow, which takes its list from those files rather than from this
page (PLAT-4, #964); see
[To check what is actually deployed](#to-check-what-is-actually-deployed).

> **Corrected 2026-09-07.** This block used to read "declared on
> `fix/go-live-remediation` and **have not been applied**", and told the reader
> to treat every "fires when" below as configuration rather than as the live
> tenant. Both halves are now wrong, and in the direction that matters: an
> operator was being told nothing was watching while rules were firing.
>
> - **The branch is gone.** `fix/go-live-remediation` no longer exists on
>   `origin`; every rule it declared is on `main` in `infra/observability.tf`.
> - **At least one rule is demonstrably live.**
>   `alert-api-reachability-prod-cus` was armed on 2026-09-01 when T-519
>   closed — this page says so itself, forty lines below — and
>   [Availability probe](../runbooks/availability-probe.md) records the same
>   arming. `alert-cosmos-export-daily` and `alert-cosmos-export-full` are
>   bound to `cosmos_export_enabled` ([ADR 0028](../decisions/0028-cosmos-out-of-account-export.md)).
> - **What is still not settled here is which rules the last apply carried.**
>   That is a live-tenant question this page cannot answer from the
>   repository. Since PLAT-4 (#964) the **Verify Alert Rule State** workflow
>   answers it weekly for every declared rule; the commands below are the
>   same reads by hand.

The Go-Live readiness review of 2026-08-24 found `az monitor metrics alert
list` and `az monitor scheduled-query list` empty in both subscriptions. That
reading is what the paragraph above described, and it is many applies old.
Re-read it rather than trusting a date. The application subscription's group
holds the workload rules, one command per rule type:

```powershell
az monitor scheduled-query list -g rg-web-site-prod-cus -o json | ConvertFrom-Json | Select-Object name, enabled
```

```powershell
az monitor metrics alert list -g rg-web-site-prod-cus -o json | ConvertFrom-Json | Select-Object name, enabled
```

```powershell
az monitor activity-log alert list -g rg-web-site-prod-cus -o json | ConvertFrom-Json | Select-Object name, enabled
```

**The capacity rule and the lab rules are in none of those.** They read the
Log Analytics workspace, so they are declared in
`azurerm_resource_group.platform_mgmt`, a different resource group **and a
different subscription**, which is why they need their own read:

```powershell
az monitor scheduled-query list -g rg-mgmt-plat-prod-cus --subscription sub-plat-mgmt-prod-cus -o json | ConvertFrom-Json | Select-Object name, enabled
```

```powershell
az monitor activity-log alert list -g rg-mgmt-plat-prod-cus --subscription sub-plat-mgmt-prod-cus -o json | ConvertFrom-Json | Select-Object name, enabled
```

A rule named in this page and absent from the list that should hold it has not
been applied; a rule present with `enabled: True` is watching the live tenant
now. An empty activity-log list is the expected reading until a rule of that
type is declared. Looking for `alert-logs-capacity` in `rg-web-site-prod-cus`
and concluding it was never applied is the one easy mistake here.

**Authority:** this page does not authorize anything. Tuning a threshold is a
normal pull request; arming the availability test or the timers is an owner
decision, made on an `owner-gated` GitHub issue and recorded in
`CHANGELOG.md` once taken.

## Read this before the rules

An inventory of rules is not the same as coverage. Two things make this fabric
less than its inventory suggests, and both are worth knowing before the first
one fires. A third, whether a page is delivered at all, was open until
2026-08-30 and is settled; its section is kept because the way it was proven
is the way to re-prove it.

### Reachability is covered, but not by the Azure test

This heading read *Reachability is not covered* until 2026-09-07. It was
written before [ADR 0024](../decisions/0024-edge-availability-probe.md) and
outlived the gap it named: the section's own body has recorded the Worker probe
as armed since 2026-09-01. The Azure availability test is still not created,
which is the part that remains true and is why the section is kept.

`azurerm_monitor_metric_alert.api_availability` carries `count = 0`. The
availability test it watches is created with `enabled = false`, and the alert is
gated on the same variable so that an inventory cannot report a reachability
alert that nothing can fire. Both are off for a measured reason: Cloudflare's
Bot Fight Mode answers datacenter clients — which is exactly what Azure's
availability agents are — with a 403 interstitial, and a WAF skip rule against
it was built, applied and confirmed **inert**, because Bot Fight Mode does not
run on the Ruleset Engine.

That gap is not one rule out of six. It is the cover for **the failure this
platform has actually had, three times**:

| Date | What happened |
| --- | --- |
| 2026-08-20 | Every route returned 404 |
| 2026-08-21 | 83 functions deployed, 80 registered |
| 2026-08-21 | Timer listeners down through the 104-function deploy |

All three are the same shape: the host is up and healthy, the functions are not
registered, requests 404. **None of the log or metric rules detects it.**
`Http5xx` does not count 404s. `AppExceptions` cannot fire because no handler
runs to throw. The availability rule is the only one that asks from outside —
and **it is armed as of 2026-09-01 (T-519 closed):**
`alert-api-reachability-prod-cus`, fed by the Worker probe below, fires when
successes in a trailing 30-minute window drop below 3 of the expected 6.

Until that date this failure class was caught only by a human running the
check in *[The failure with no alert](#the-failure-with-no-alert)* below, by
the scheduled `Monitor Functions Registered` workflow (which reads ARM, not
the network path, and which GitHub delivers 22% of the time), or by the
assertion inside `deploy-functions.yml`, which only runs when someone deploys.
Those remain the diagnosing checks that name WHICH condition; the probe is the
one that notices fast.

Since 2026-08-28 the arm path no longer waits on a Cloudflare plan change:
[ADR 0024](../decisions/0024-edge-availability-probe.md) probes `/api/health` from a
Cloudflare Worker cron — the one external-shaped client Bot Fight Mode does
not challenge — reporting into `availabilityResults`, with a success-counting
rule (`edge_probe_availability`, gated on `availability_probe_alert_enabled`)
that fires as readily on a dead probe as on an unreachable API. Deploying the
Worker and arming the rule are the owner procedure in
[Availability-Probe](../runbooks/availability-probe.md).

### Delivery is proven, on both channels

This heading read *Delivery is unproven* until PLAT-4 (#964), six weeks after
the evidence that settled it was recorded.

Every rule routes solely through `azurerm_monitor_action_group.ops`
(`ag-plat-prod-cus-01`), which lives in the **Platform Management**
subscription, while most rules live in the **application** subscription.
Neither `azurerm_monitor_metric_alert` nor
`azurerm_monitor_scheduled_query_rules_alert_v2` has a per-rule email field, so
a rule has no path of its own; the action group's two receivers, `ops-email`
and `ops-sms`, are the two paths.

What has been observed, and where it is recorded:

- **Both receivers deliver.** On 2026-08-30 a test notification sent to
  `ag-plat-prod-cus-01` through the CLI arrived in the `ops-email` inbox (fired
  21:36 UTC), and the same command with `-a sms` reached the `ops-sms` phone
  the same evening, which closed T-709. Recorded in
  [CHANGELOG.md](../repo/changelog.md) under *Live confirmations completed*:
  "Observe an alert actually being delivered. Done 2026-08-30."
- **A rule in the application subscription reaches the group across the
  boundary.** `alert-app-exceptions-prod-cus` fired at 23:06 on 2026-08-25 and
  its mail kept arriving every five to ten minutes until the rule was made
  stateful; [CHANGELOG.md](../repo/changelog.md), "The alert rules re-notified
  every five minutes, because a scheduled query rule is stateless by default."
  That is the hop the budget could never prove, because the budget also mails
  `contact_emails` directly.

The portal's **Test action group** button is not evidence either way. On
2026-08-30 it reported *"There was a problem completing this test"* with status
`Unknown` and delivered nothing, while the CLI form of the same test delivered
within a minute. Re-prove delivery with the CLI after any change to the action
group. Both pairs below are PowerShell; the first line of each reads the
receiver off the action group, so nothing is retyped.

```powershell
$e = (az monitor action-group show -n ag-plat-prod-cus-01 -g rg-mgmt-plat-prod-cus --subscription sub-plat-mgmt-prod-cus -o json | ConvertFrom-Json).emailReceivers | Where-Object name -eq 'ops-email'
```

```powershell
az monitor action-group test-notifications create --action-group ag-plat-prod-cus-01 --resource-group rg-mgmt-plat-prod-cus --subscription sub-plat-mgmt-prod-cus --alert-type budget -a email ops-email $e.emailAddress usecommonalertschema
```

```powershell
$s = (az monitor action-group show -n ag-plat-prod-cus-01 -g rg-mgmt-plat-prod-cus --subscription sub-plat-mgmt-prod-cus -o json | ConvertFrom-Json).smsReceivers | Where-Object name -eq 'ops-sms'
```

```powershell
az monitor action-group test-notifications create --action-group ag-plat-prod-cus-01 --resource-group rg-mgmt-plat-prod-cus --subscription sub-plat-mgmt-prod-cus --alert-type budget -a sms ops-sms $s.countryCode $s.phoneNumber
```

Success is two independent witnesses: the command returns `"state":
"Complete"` with a `"Status": "Succeeded"`, as it did on 2026-08-30, **and**
the mail or text arrives within a few minutes. The first without the second is the portal's failure
mode again, a verdict on nothing.

### Silence is not health

Most rules need the application to be healthy enough to emit telemetry, and
every log rule additionally needs the Log Analytics workspace to be ingesting.
The workspace was found `OverQuota` on 2026-08-24 — dropping every billable
table — with nothing anywhere saying so. `alert-logs-capacity` exists to make
that specific silence loud, and it is deliberately built to keep working from
inside a capped workspace: the daily cap stops collection of *billable* tables,
and `Usage` is not billable. The two metric rules do not read the workspace at
all, and the rules that count successes (reachability, the two export rules,
the lab heartbeat) fire on silence rather than being silenced by it: a capped
workspace makes them page, not sleep.

### The delivery monitor speaks on Telegram

Merging to `main` ships nothing here: the frontend and Functions deploys are
started by hand, and Terraform is confirmed in HCP Terraform. So a merge can
leave production behind `main` without anything being broken. The GitHub check
[Monitor delivery health](https://github.com/saulpatinojr/HCW-HybridCloudWorks/actions/workflows/monitor-deploy-drift.yml)
(`monitor-deploy-drift.yml`) is what notices. It runs every four hours and goes
red when a deploy has waited more than **8 hours** behind `main` (it was 24
until 2026-10-23), or when a workflow keeps failing.

Red used to reach the owner only as GitHub's failure email. On 2026-10-22 it
sat red for a day among other mail. Now the Functions app also sends a
Telegram message, from the hourly `checkAgentHealth` timer
(`functions/src/lib/timers/delivery-monitor-watch.js`). It reads the check's
run history from GitHub's public API, so no bot token is stored in GitHub; the
token stays in Key Vault with the other notifier settings.

| Message title | What it means | What to do |
| --- | --- | --- |
| **DELIVERY MONITOR RED** | The newest finished run of the check failed. The message names the failed jobs and links the run. Sent once per red stretch | Open the linked run and read its table: each service that is behind has a red mark. Start the matching deploy, or confirm the Terraform run, then wait for the next run |
| **DELIVERY MONITOR STILL RED** | Still red 24 hours after the first message. Sent again so one missed notification does not mean silence | Same as above; nothing has fixed it yet |
| **DELIVERY MONITOR back to green** | A run succeeded after the owner was told. Sent once, then the record is cleared | Nothing |
| **DELIVERY MONITOR WATCH IS BLIND** | The watcher has failed to read GitHub for about a day of hourly attempts, so it cannot tell red from green | Check GitHub's status page and the Functions logs; the GitHub failure email still goes out while this lasts |

Two limits. The Telegram message depends on the Functions app being up, so if
Azure is down only GitHub's email arrives; nothing here replaces that email.
And the watcher only exists once the Functions app has been deployed with it,
which is itself a manual deploy.

## The rules

| Rule | Sev | Fires when | What it usually means | Look at first |
| --- | :---: | --- | --- | --- |
| `alert-func-http5xx` | 1 | More than 5 HTTP 5xx on the Function App in 15 min, evaluated every 5 min. From #250 until the apply of #816 the deployed window was 30 min, on reasoning that belonged to the availability probe | The host answered and failed: a cold start that timed out, a worker that died mid-request, an unhandled 500 | Application Insights → **Failures**, filtered to the window, grouped by operation |
| `alert-func-latency` | 2 | P95 request duration above 5 s over 30 min, evaluated every 5 min | A slow dependency, or cold starts dominating a low-traffic window | Application Insights → **Performance**, split by operation; then check whether a deploy landed in the window |
| `alert-cosmos-throttle` | 2 | More than 10 Cosmos responses with `StatusCode = 429` in 15 min | Retries are no longer absorbing throttling | Cosmos → **Insights** → normalized RU consumption, to find the container and partition key range |
| `alert-app-exceptions` | 1 | More than 5 `AppExceptions` rows in 15 min | Handlers are throwing | The `AppExceptions` table, grouped by `ProblemId` and `OperationName` |
| `alert-telegram-delivery` | 2 | A `[notify] Telegram API error` or `[notify] notifyTelegram failed` trace in the last hour, evaluated every 15 min (stateful) | Telegram refused or failed a notification to the owner: the bot is blocked, or the chat id is stale. Every owner notification is silent until it is fixed, which is why this pages by SMS and mail instead | `AppTraces` for messages starting `[notify]` over the last two hours; then message the bot from the owner's Telegram account |
| `alert-api-reachability` | 1 | Fewer than 3 `edge-api-health` successes in `availabilityResults` in 30 min, of the 6 expected, evaluated every 5 min (stateful). Gated on `availability_probe_alert_enabled`, armed 2026-09-01 (T-519) | The API is unreachable over the Cloudflare path, or the edge probe itself has stopped; from a visitor's seat they are the same incident | `AppAvailabilityResults` for `edge-api-health` over the last hour, then [Availability probe](availability-probe.md) |
| `alert-cosmos-export-daily` | 2 | No `cosmosExportCompleted` event, full or delta, in the last 2 days, evaluated daily. **Stateless**: mails once a day until a run completes. Gated on `cosmos_export_enabled` | The 03:00 UTC exporter is not finishing, and the out-of-account copy is going stale | `AppEvents` for `cosmosExportCompleted`, and `AppExceptions` for the export timer and job; then [Cosmos restore](cosmos-restore.md) |
| `alert-cosmos-export-full` | 2 | On a Monday, no full export completed in the trailing 2 days, evaluated daily. **Stateless**: one mail per missed Sunday. Gated on `cosmos_export_enabled` | Sunday's full did not land: deltas keep accumulating and deletes stay unreconciled until the next full | The same `AppEvents` rows, filtered to `mode` `full` |
| `alert-logs-capacity` | 2 | Billable ingestion passes 80% of the daily cap since the 08:00 UTC reset, hourly (stateful: resolves after the reset). In `rg-mgmt-plat-prod-cus`, Management subscription | Telemetry is about to stop for the day, taking the log-based signals with it | The `Usage` table, grouped by `DataType`, over the same window |
| ~~`alert-api-availability`~~ | 1 | **Not created** (`count = 0`, gated on `availability_test_enabled`) | — | See *[Reachability is covered, but not by the Azure test](#reachability-is-covered-but-not-by-the-azure-test)* |
| `alert-lab-heartbeat` | 1 | No `Heartbeat` row from `arcs-lab-hybrid-prod-cus-01` in 30 min, evaluated every 15 min (stateful). In `rg-mgmt-plat-prod-cus`, Management subscription | The lab host is down, the Azure Monitor Agent is stopped, or the host cannot reach Azure; public lab submission fails closed meanwhile | `ssh hcw-lab 'systemctl status azuremonitoragent himdsd hcw-labs-agent --no-pager'`; the Hostinger panel if ssh fails |
| `alert-lab-disk` | 2 | Root filesystem past 85% used, hourly (stateful). Management subscription | Docker images, Coder workspaces or pg_dumps filling the disk | `ssh hcw-lab 'df -h /; sudo docker system df; sudo ls -l /var/backups/coder'` |
| `alert-lab-unit-failed` | 2 | A `hcw-unit-failed` line in `Syslog` from the lab host in the last hour, evaluated every 15 min (stateless, muted 6 h: the line is an event). Management subscription | A unit that names the notifier in `OnFailure=` entered the failed state; the line names the unit. They are the Coder backup and Coder automation, the Vault backup, the labs agent, Caddy, Vault, the daily held-package report (`hcw-held-upgradable`, when apt fails), the nightly idle reboot (`hcw-reboot-when-idle`, when `apt-config`, logind or a docker daemon cannot answer, or the run times out; `sudo journalctl -t hcw-reboot-when-idle` says which), and the nightly playbook drift detection (`hcw-playbook-drift`, when drift is detected or the playbook fails; `sudo journalctl -t hcw-playbook-drift` says which). Stopping the idle reboot is not a failure | `ssh hcw-lab 'systemctl --failed --no-pager; sudo journalctl -t hcw-unit-failed --since -2h --no-pager'`, which lists the failed units and the notifier's own lines naming them |
| `alert-lab-backup-missing-coder` | 2 | No successful blob write under `host-backups/coder/` in `stlabhybridprodcus01` (`StorageBlobLogs`, `PutBlob`/`PutBlockList`) in two days, hourly (stateful: resolves once a backup lands). Management subscription | The nightly Coder dump or its upload is failing, or the host is down; the 35-day immutable copies stop growing | `ssh hcw-lab 'systemctl status coder-postgres-backup.timer coder-postgres-backup --no-pager; sudo journalctl -t hcw-backup-upload --since -2d --no-pager; sudo ls -l /var/backups/coder'` |
| `alert-lab-backup-missing-vault` | 2 | No successful blob write under `host-backups/vault/` in `stlabhybridprodcus01` in two days, hourly (stateful: resolves once a backup lands). Management subscription | The nightly Vault raft snapshot or its upload is failing (its token expired or was revoked), or the host is down | `ssh hcw-lab 'systemctl status hcw-vault-backup.timer hcw-vault-backup --no-pager; sudo journalctl -t hcw-backup-upload --since -2d --no-pager'` |
| `alert-lab-ssh-login` | 1 | sshd on the lab host accepted a login that is not a `lab_ssh_admin_users` user (`hcwadmin`) by public key with a `lab_ssh_admin_key_fingerprints` key, or that did not arrive through Arc SSH (`lab_ssh_loopback_only`, on since #953 stage 3 closed port 22). Reads the `Syslog` rows ingested in the last 20 min, every 15 min (stateless, not muted: a login is an event, so one login can now and then mail twice). Management subscription (#953) | Someone other than the owner logged in; or the owner did with a password, another key, or not through Arc, over port 22 reopened from the Web Console ([labs-host runbook](labs-host.md), "When Arc SSH is down"). A rebuilt host's logins before Arc onboards it page nothing: the rule reads only the Arc machine's `Syslog`, which starts with onboarding. A key changed in `lab-host/ansible/group_vars/all.yml` without its fingerprint in `infra/variables.tf` would page on every login, which `scripts/lab-host-ssh-login-alert.test.mjs` fails in CI first | The `Syslog` line behind the alert, through the mail's link to the query results: it names the method, user, address and key. Then `ssh hcw-lab 'who; last -a -n 20'` for the sessions open and recent |

### To check what is actually deployed

Run the workflow rather than reading it off the repository:
[Verify Alert Rule State](https://github.com/saulpatinojr/HCW-HybridCloudWorks/actions/workflows/verify-alert-state.yml)
→ **Run workflow**, or read Monday's scheduled run there. It exists because a
green TFC run proves ARM *accepted* an apply, not that a rule now behaves
differently, and because `autoMitigate`, the one attribute that decides whether
a firing rule mails once or every five minutes, is invisible from the
repository, from CI and from the run list.

The list of rules is not written in the workflow. `scripts/verify-alert-state.mjs`
derives it from `infra/` at the commit it runs, through
`scripts/lib/alert-declarations.mjs`: every alert resource in the module, its
Azure name, resource group, subscription, `count` gate and action group. It then
reads each resource group's scheduled query, metric and Activity Log alert
rules through Azure Resource Manager, the action group, and each live log
search rule's Resource Health (*[Resource Health](#resource-health)*), and
writes one row per declared rule to the job summary (legible from a phone) and
to the log:

| State | What it means | What to do |
| --- | --- | --- |
| `OK` | Live, enabled, wired to `ag-plat-prod-cus-01`, `autoMitigate` as declared | Nothing |
| `MISSING` | Declared, not live. If the detail says the create is **waiting for an apply**, `scripts/assert-expected-plan.mjs` declares it and the run has not been confirmed | Confirm the pending run in the `hcw-azure` workspace; otherwise the rule was deleted out of band, and an apply restores it |
| `DISABLED` | Live with `enabled: false`; nothing in `infra/` disables a rule, so this was done by hand | Find out who and why first (the Activity Log has the write), then re-apply |
| `NOT WIRED` | Live, but its actions do not name the ops action group | Re-apply; the rule pages nobody until then |
| `DRIFT` | `autoMitigate` differs from the declaration, or a `count`-gated rule is live while `GATES` records its gate as off | Re-apply; for a gate, correct `GATES` if the gate was armed on purpose |
| `UNHEALTHY` | A log search rule whose Resource Health is `Unavailable` or `Degraded`: Azure reports it cannot evaluate, so it pages nobody however live and wired it is. The detail starts with Azure's title (`Semantic error`, `Syntax error`, `Query is throttled`, ...). Not raised for a rule evaluated less often than every 15 minutes whose title gives no reason, because Microsoft documents no health for those | Run the rule's query under its scope → **Logs** to see the error; for a semantic or syntax error, fix the query in `infra/` and apply. `alert-timer-overdue` read `Semantic error` from its create on 2026-10-10 until #964 replaced its query |
| `HEALTH UNREADABLE` | The rule was read and its Resource Health was not: the identity may not read it, `Microsoft.ResourceHealth` is not registered in that subscription, or Azure answered with a state the script does not know. Whether the rule can evaluate is **unknown**, never `OK`. Fails the run | The owner steps under *[Resource Health](#resource-health)*; the detail says which |
| `NOT AUTHORIZED` | The workflow's identity could not read that resource group. The rules' state is **unknown**, which is not the same finding as `MISSING` | See the identity note below |
| `UNREADABLE` | The same refusal, in a subscription the script's `UNREADABLE` table records as not yet readable. Shown in every run and as a warning annotation; the state is **unknown**. Does not fail the run | The table is empty since #1053, so this appears only if a subscription is recorded again. Grant the alert identity the read there; once it applies, the workflow's next run fails with `STALE RECORD` until the entry is deleted, so the exception cannot outlive the gap |
| `READ FAILED` | ARM answered with some other error; the detail carries the status and code, with IDs masked | Re-run; if it repeats, the detail says what ARM refused |
| `ABSENT` | A `count`-gated rule whose gate `GATES` does not record, and absent. Not a failure, and not a pass either | Record the gate in `GATES`; the test suite already refuses a new gate without an entry |
| `GATED OFF` | A `count`-gated rule whose gate is recorded as off (`GATES` in the script), and absent | Nothing. Arming the gate is an owner decision; record it in `GATES` in the same change |

The **Health** column shows each log search rule's Resource Health:
`Available`, `Unknown` (not a finding; a rule evaluated less often than every
15 minutes reads it), `Unavailable`, `Degraded`, or `unread`. Metric and
Activity Log rules show a dash.

The action group gets its own row: it fails if it is missing, disabled, or has
no receiver whose status is `Enabled`. Receiver names and statuses are printed;
the address and number are not, because the report is public. A live rule that
no declaration names is listed and does not fail the run.

**The identity.** The job runs as `github_alert_reader`
(`ALERT_READER_CLIENT_ID`, `infra/oidc.tf`) and makes only GET calls. Since
#1053 that identity holds one custom role, *HCW Alert Rule Reader*
(`infra/roles/alert-rule-reader.json`), in `rg-web-site-prod-cus` and
`rg-mgmt-plat-prod-cus`: the four alert-rule and action-group read actions,
and since #964 the two Resource Health reads, and nothing else, so it cannot
query a log or change anything. Both subscriptions
are therefore read on every run, and the script's `UNREADABLE` table is empty.

**Which subscriptions it reads.** Because that role is held at resource-group
scope, the sign-in pins no subscription (`allow-no-subscriptions`), and the
subscription list the identity sees may leave one out. The workflow therefore
names both ids in `ALERT_SUBSCRIPTION_IDS`, built from the repository
variables `SUBSCRIPTION_ID` and `SUBSCRIPTION_MGMT_ID`, and the script uses a
named id for any subscription the list does not show. If the list itself is
refused, the named ids are used for every rule, and the report says so above
its table. An entry that is not
`display-name=GUID` stops the check with exit 2: an unset variable renders as
`sub-plat-mgmt-prod-cus=`, and the run says so rather than skipping the
Management rules.

Until #1053 the job ran as `github_reader`. That identity also held a
Function App config write until #1098, and holds nothing in the Management subscription,
so the capacity rule, the lab rules, the Management role-change rules and the
action group reported `UNREADABLE` every week. Reader on the Management group
would have closed that gap but also let the job query every log in the
Management workspace, so the owner chose the narrower identity on 2026-10-11.

**The custom role is created by the owner, once**, because the Terraform run
identity deliberately cannot write role definitions. It was created before
the apply that grants it. If it is ever deleted, the plan stops at the role
lookup. Recreate it from the repository root of a checkout of `main`, where
this must print `True` first:

```powershell
Test-Path infra/roles/alert-rule-reader.json
```

```powershell
az role definition create --role-definition '@infra/roles/alert-rule-reader.json' -o none
```

That needs a role allowed to write role definitions on both groups (Owner or
User Access Administrator). The definition is written in the application
subscription, the home of its first assignable scope, so
`alert-rbac-definition-app` fires, as it should for any hand change to a role.

The same check runs from an operator's machine under the operator's own
rights, which do reach the Management subscription. Run it from the repository
root of a checkout of `main` that includes PLAT-4's verifier; `True` means the
script is there:

```powershell
Test-Path scripts/verify-alert-state.mjs
```

```powershell
node scripts/verify-alert-state.mjs
```

Success is a last line reading **Every expected rule is live, enabled and wired
to its action group.** and `$LASTEXITCODE` of `0`; `1` means a finding named in
the table, and `2` means the check could not run (most often: no `az login`).
The verdict is always the last line. A run from an operator's machine reads the
Management subscription with the operator's own rights, so its rules get real
states there; it does not judge the `UNREADABLE` record, which describes the
workflow's identity and is checked only by the workflow's own runs.
To print the declared inventory without touching Azure:

```powershell
node scripts/verify-alert-state.mjs --list
```

### Resource Health

`alert-timer-overdue` was live, enabled and wired from its create on
2026-10-10, so this check read it `OK` every week while Kusto refused its query
at every evaluation (`SEM0040`) and the rule paged nobody. The one place Azure
said so was the rule's Resource Health: `Unavailable`, `Semantic error`. Since
#964 the check reads Resource Health for every live log search rule and fails
one that reads `Unavailable` or `Degraded` as `UNHEALTHY`. Microsoft reports
health only for a rule evaluated every 15 minutes or more often
([Monitor the health of log search alert rules](https://learn.microsoft.com/azure/azure-monitor/alerts/log-alert-rule-health)),
so a less frequent rule reads `Unknown` (both daily Cosmos export rules did on
2026-10-15), which is not a finding; the same page says such a rule may read
`Unavailable for unknown reason`, which is not one either.

Two owner steps make the read possible, each once. Until both are done, the
rules they cover read `HEALTH UNREADABLE` and the run fails, naming the step
in the detail. The same page says reading a rule's health needs only read on
the rule, which the role already has, so the role step may prove unneeded;
the role carries the Resource Health reads anyway, so the check does not
depend on that sentence.

**Register the provider in the Management subscription.**
`Microsoft.ResourceHealth` is registered in `sub-app-site-prod-cus` and was
not in `sub-plat-mgmt-prod-cus` on 2026-10-15: every health read there
answered `AuthError ... Make sure the resource provider has been registered
with this subscription`, so the eleven Management log rules read
`HEALTH UNREADABLE`. Registering needs Owner or Contributor on that
subscription:

```powershell
az provider register --namespace Microsoft.ResourceHealth --subscription sub-plat-mgmt-prod-cus
```

Registration takes a few minutes. Success is this printing `Registered`;
`Registering` means wait and read again, and `NotRegistered` (what it printed
on 2026-10-15) means the register did not take:

```powershell
az provider show --namespace Microsoft.ResourceHealth --subscription sub-plat-mgmt-prod-cus --query registrationState -o tsv
```

**Give the role its two health reads.** Since #964
`infra/roles/alert-rule-reader.json` carries
`Microsoft.ResourceHealth/availabilityStatuses/read` and
`Microsoft.ResourceHealth/availabilityStatuses/current/read`: the provider's
scope-wide read and its read of one resource's current status, the GET the
script makes. Both are reads and nothing else. The role in Azure changes only
when the owner writes it, from the repository root of a checkout of `main`
after the #964 fix merged, where this must print two lines:

```powershell
Select-String -Path infra/roles/alert-rule-reader.json -Pattern 'Microsoft.ResourceHealth' -SimpleMatch
```

```powershell
az role definition update --role-definition '@infra/roles/alert-rule-reader.json' --subscription sub-app-site-prod-cus -o none
```

That needs the same rights as the create above, finds the role by its name at
its first assignable scope, and fires `alert-rbac-definition-app`, as it
should.

**Record the rollout.** Three reads show the change landed where the check
needs it, and each prints what it read, so their output is the rollout
record: paste it on #964 with the date. They need only read, and each works in
PowerShell 7 and in Windows PowerShell 5.1. The role's actions, then how many
of them are Resource Health reads:

```powershell
$rd = (az role definition list --name 'HCW Alert Rule Reader' --custom-role-only true --subscription sub-app-site-prod-cus -o json | ConvertFrom-Json) | Select-Object -First 1; $rd.permissions.actions; 'Resource Health actions: ' + @($rd.permissions.actions | Where-Object { $_ -like 'Microsoft.ResourceHealth/*' }).Count
```

Where the role is assigned, one row per subscription:

```powershell
'sub-app-site-prod-cus', 'sub-plat-mgmt-prod-cus' | ForEach-Object { (az role assignment list --all --subscription $_ -o json | ConvertFrom-Json) | Where-Object roleDefinitionName -eq 'HCW Alert Rule Reader' | Select-Object principalType, scope }
```

The provider in both subscriptions:

```powershell
'sub-app-site-prod-cus', 'sub-plat-mgmt-prod-cus' | ForEach-Object { $_ + ': ' + (az provider show --namespace Microsoft.ResourceHealth --subscription $_ --query registrationState -o tsv) }
```

| Read | Success, after both steps | Read on 2026-10-15, before either |
| --- | --- | --- |
| Role actions | Six actions, two of them `Microsoft.ResourceHealth/...`, then `Resource Health actions: 2` | The four `Microsoft.Insights/...` reads, then `Resource Health actions: 0`; the definition unchanged since its create on 2026-10-11 |
| Assignments | Two `ServicePrincipal` rows, one scope ending `/resourceGroups/rg-web-site-prod-cus` and one ending `/resourceGroups/rg-mgmt-plat-prod-cus` | The same two rows. The update changes the definition, so both assignments carry it with no change of their own |
| Provider | `sub-app-site-prod-cus: Registered` and `sub-plat-mgmt-prod-cus: Registered` | `Registered` and `NotRegistered` |

Then run
[Verify Alert Rule State](https://github.com/saulpatinojr/HCW-HybridCloudWorks/actions/workflows/verify-alert-state.yml)
→ **Run workflow**. Success is no `HEALTH UNREADABLE` row. Until the apply that
replaces its query, `alert-timer-overdue` reads `UNHEALTHY` with
`Semantic error`, which is the check working; after it, `Available` once the
rule has evaluated again, within about 15 minutes. That run is the evidence
the definition cannot give: it makes the health read as the workflow's own
identity, in both resource groups.

**Restore the previous action set** if the update wrote anything other than
the six actions, or the role must go back to what it held before #964. The
previous definition is the file at `0bd89190` (#1074), the last commit on
`main` to change it before #964, and what Azure held from the role's create on
2026-10-11 until the #964 update. `git show` reads it from git's history, not
the working tree, so these work on any branch of a clone fetched since
2026-10-11, run from inside the checkout. This must print `commit` first:

```powershell
git cat-file -t 0bd891906fbf1dcac64c0179f632cfbdb2b39b76
```

```powershell
$pj = Join-Path ([IO.Path]::GetTempPath()) 'alert-rule-reader-0bd89190.json'
```

```powershell
git show 0bd891906fbf1dcac64c0179f632cfbdb2b39b76:infra/roles/alert-rule-reader.json | Set-Content -LiteralPath $pj
```

Before the file goes to Azure, this must print the four
`Microsoft.Insights/...` reads and nothing else:

```powershell
(Get-Content -LiteralPath $pj -Raw | ConvertFrom-Json).Actions
```

```powershell
az role definition update --role-definition "@$pj" --subscription sub-app-site-prod-cus -o none
```

Success is the role-actions read above printing those four and
`Resource Health actions: 0`. The restore fires `alert-rbac-definition-app`
too, and takes the health reads away, so the next run may read
`HEALTH UNREADABLE` for the rules that needed them: that is the restore
working. If it is meant to last, revert the two actions in
`infra/roles/alert-rule-reader.json` on `main` as well, so the next update
from the file does not grant them again. Then remove the temporary file:

```powershell
Remove-Item -LiteralPath $pj
```

### Notes that change what you do

**5xx and exceptions are not redundant.** A 5xx with no exception is the host; an
exception with no 5xx is a handler that caught the error and degraded. If both
fire together, start with the exception. If only the 5xx fires, start with the
host — instance restarts, cold-start failures, package state.

**Cosmos throttling has no throughput dial.** The account is serverless
(ADR 0003), so there is nothing to turn up. A firing throttle alert points at a
query or a partition key, not at capacity. Note also that per-request Cosmos
logs go away with the same change that adds this rule — `CDBDataPlaneRequests`
is pruned for being most of the daily cap — so from that apply on this is
answered from metrics, not from logs.

**One mail per incident, not one every five minutes.** The workload rules are
*stateful* (`auto_mitigation_enabled = true`, or a metric rule's own default):
each fires once, stays fired while the condition holds, and sends a single
Resolved mail once the condition has been clear: for three evaluation periods
on a rule evaluated every 5 to 15 minutes (fifteen minutes on the PT5M rules),
and for two on a rule evaluated less often, up to every 11 hours (two hours on
the hourly rules). Since 2026-10-16 that
includes `alert-logs-capacity`, `alert-lab-disk` and both
`alert-lab-backup-missing` rules, which used to mute instead and left an alert
open for every evaluation over their threshold ([ADR 0022](../decisions/0022-alerting-fabric.md)
decision 6). The exceptions are deliberate. The three daily rules
(`alert-export-window-latency` and the two Cosmos export rules) are stateless
because Azure refuses auto-resolution on a rule evaluated less often than every
twelve hours. `alert-lab-unit-failed` mutes for six hours because its condition
is a log line, an event. A stateful rule would call it resolved once the line
left the query's one-hour window and two 15-minute evaluations then came back
clear, about an hour and a half after the failure, whether or not the unit came
back. `alert-lab-ssh-login` is stateless for the same reason, a login being an
event, and is not muted either: a mute would hide a second unexpected login in
the muted hours. Each evaluation that sees a login mails, and a line ingested
in the five minutes two evaluations' lookbacks share is seen by both, so one
login can now and then mail twice (#953). Activity Log alerts are stateless by
platform; each one is an event a person reads and closes.
They were not stateful when they first went live, and `alert-app-exceptions`
demonstrated the difference on the night of 2026-08-25: a stateless log rule
re-notifies on *every* evaluation whose condition is met, and because each
window is three to six times the evaluation frequency, the same burst is counted
by several consecutive evaluations and the mail continues after the exceptions
have stopped. Nothing about detection changed — same frequency, same query, same
threshold. **If a rule is still noisy after this, it is firing too often, not
notifying too often**, and the fix is the query or the threshold, below.

**The capacity alert fires once a day at most, and resolves after the reset.**
Ingestion only goes up between resets, so once it is past 80% it stays past
until 08:00 UTC, when the sum starts again and the alert resolves two
evaluations later. Until 2026-10-16 it muted for six hours instead, which still
mailed up to four times a day. When it fires, prune a
diagnostic category before raising the cap; raising the cap moves spend into the
Platform Management budget ([Cost analysis](../architecture/cost-analysis.md)).

**Every threshold here is a first estimate.** None of these numbers is
incident-derived; each records its assumption beside the resource. Tune them
against the first week of real firing rather than leaving an estimate in place
because it is written down — and tune rather than mute.

That week has started. `alert-app-exceptions` fired at 23:06 on 2026-08-25, the
first firing of any rule on this platform. Before changing its threshold or its
severity, find out what is actually throwing — a rule that pages on five
exceptions is right if those five are one broken handler and wrong if they are a
retried dependency being logged five times:

```kusto
AppExceptions
| where TimeGenerated > ago(24h)
| summarize Count = count(),
            Sample = any(OuterMessage)
        by ProblemId, OperationName, SeverityLevel
| order by Count desc
```

Then choose per finding, in this order — each costs more coverage than the one
before it:

1. **Fix the throw.** The cheapest alert to silence is one with nothing to fire
   on, and a handler that throws six times an hour is telling you something.
2. **Filter the query**, if the exceptions are genuine but expected — a
   dependency that is retried and recovers, a client abort. Excluding a named
   `ProblemId` keeps the rule sensitive to everything else; raising the
   threshold blinds it to everything equally. The query is `exceptions` on the
   component (classic schema — see the note in `infra/observability.tf`), so a
   filter reads `exceptions | where problemId != "…"`.
3. **Require it to persist.** `failing_periods` is 1-of-1 on every rule, so one
   spike pages. Two of two means the condition has to survive a second
   evaluation, which costs five minutes of detection latency and removes
   single-burst noise.
4. **Raise the threshold**, once there is a baseline to raise it against.
5. **Lower the severity.** Sev1 on exceptions asserts that a throwing handler is
   as urgent as the API returning 5xx. If a week of firing says otherwise, Sev2
   is the honest number — but change it because the evidence says so, not to
   make the mail quieter, and note that severity alone does not change what the
   action group sends.

An [alert processing rule](https://learn.microsoft.com/azure/azure-monitor/alerts/alerts-processing-rules)
is the right tool for a *planned* silence — a deploy window, a known-bad
weekend — because it is time-boxed and visible. It is the wrong tool for a rule
that is simply mis-tuned, because the suppression outlives the reason for it.

## The PLAT-4 rules

The rules PLAT-4 (#964) added, for conditions the estate assessment of
2026-10-06 found nothing paging on: timer silence, the poison queue, the
Static Web App's bandwidth ceiling, the lab agent, and the security signals the
estate already collected without alerting on them. Every one reads data that
was already arriving (Application Insights, the Key Vault and storage
diagnostic settings, the lab host's data collection rule, the Activity Log), so
none adds ingestion. All route to `ag-plat-prod-cus-01`. They are declared at
the end of `infra/observability.tf` and `infra/lab-hybrid.tf`, each with its
reasoning beside it.

| Rule | Sev | Fires when | What it usually means | Look at first |
| --- | :---: | --- | --- | --- |
| `alert-timer-overdue` | 2 | A Function App timer that was due at least 45 minutes ago has no successful run since. One alert per timer, named in the alert; more than five overdue at once collapse into one alert named `more than five timers at once`. Every 15 min, stateful. Quiet while no request telemetry arrives at all, which the capacity and reachability rules own | The host is not running that timer, or every run fails | `AppExceptions` for the named function, then the registration check in *[The failure with no alert](#the-failure-with-no-alert)*. If it stayed quiet while a timer was known to be down, the rule's Resource Health first (*[Resource Health](#resource-health)*): `Unavailable` there means the rule itself cannot evaluate, as from 2026-10-10 to #964 |
| `alert-lab-agent-offline` | 2 | `checkAgentHealth` decided to tell the owner a lab agent has been offline five minutes or more (sent, not sent, or failed). Every 15 min, stateful. Needs `CHECK_AGENT_HEALTH` armed | The labs agent stopped or lost its way to the API; public lab jobs wait. The 04:30 reboot does not fire it | `ssh hcw-lab 'systemctl status hcw-labs-agent --no-pager'` |
| `alert-jobs-poison` | 2 | A message was put into `platform-jobs-poison` on `stsitefuncprodcus01` in the last hour. Management subscription | The host failed to hand a job to `platformJobWorker` five times | `AppExceptions` for `platformJobWorker` around the time of the put |
| `alert-swa-bandwidth` | 2 | The Static Web App's `BytesSent` over the last 24 hours passes 2,666,666,666 bytes (80% of a thirtieth of the Free plan's 100 GB month). Hourly | Traffic on pace to exhaust the month; on Free, past 100 GB the site stops serving | Static Web App → Metrics → Data Out, summed over the month to date |
| `alert-kv-errors` | 2 | A request to `kv-site-prod-cus-01` or `kv-labhybrid-prod-cus-01` answered 400 or above, other than the 401 authentication challenge and a `SecretGet` 404 on an unseeded secret. Last hour, every 15 min. Management subscription | An RBAC or firewall refusal, throttling, or a service error | The `AzureDiagnostics` rows, with the query in *[Before the apply](#before-the-apply)* narrowed to the last hour |
| `alert-kv-data-write` | 1 | An identity other than the Function App's wrote, deleted, purged, restored or backed up a secret or key in either vault through the data plane, or tried to. Management subscription | A human writing by script, or a caller that should not be there | The row's caller object id and address |
| `alert-kv-config-write` | — | Resource Manager wrote to either vault: its network ACL or properties, a key or secret through ARM, a delete, a role assignment or lock on it, its tags or its diagnostic settings. Succeeded or failed. Only the KeyVault, Authorization, Resources and Insights providers count, so closing one of this rule's own alerts, which is logged beneath the vault, does not fire it again (#1216). Activity Log, free | An HCP Terraform apply that changed a vault (expected), or a change made outside one | The vault's Activity Log; the event names the caller |
| `alert-rbac-assignment-app` | — | A role assignment was created or deleted in the application subscription, or an attempt failed. Activity Log, free | An apply that grants or removes a role (expected), or a grant made outside one | Activity Log filtered to `Microsoft.Authorization` |
| `alert-rbac-assignment-mgmt` | — | The same, in the Management subscription | As above | As above, in `sub-plat-mgmt-prod-cus` |
| `alert-rbac-definition-app` | — | A role definition was created, changed or deleted in the application subscription, or an attempt failed. No apply writes one. Activity Log, free | A custom role changed by hand: the owner's own change (expected only then), or someone widening a role every assignment of it inherits | The event's caller and request body, then that role's actions against its file: `infra/roles/`, or `scripts/terraform-identity-grants.json` for the run identity's role |
| `alert-rbac-definition-mgmt` | — | The same, in the Management subscription | As above | As above, in `sub-plat-mgmt-prod-cus` |
| `alert-lab-vault-unwrap` | 1 | The lab vault's seal key was asked to wrap or unwrap from an address the lab host has not heartbeated from in the last hour. Management subscription | Vault's identity in use off the host, or the host's address changed | The caller address in the row against the host's `Heartbeat` address |
| `alert-lab-ssh-burst` | 2 | Failed SSH lines on the lab host in 15 minutes number at least 50 and more than four times the day's quarter-hour average. Management subscription | A distributed attempt that fail2ban's per-address ban does not stop, or a broken key | `ssh hcw-lab 'sudo fail2ban-client status sshd'` |
| `alert-export-window-latency` | 3 | On the previous whole UTC day, the API's HTTP P95 inside the nightly Cosmos export window (03:00 to 03:45 UTC) was above 1 s and above twice the rest of that day's P95, over at least 20 requests. Daily, stateless (one mail per day the condition holds), scoped to the Application Insights component | A scheduler degrading the API: ADR 0019's revisit trigger, met | The alert's dimensions carry both P95s (ms) and both request counts; then `requests` split by the window under Application Insights → **Logs**, and ADR 0019's revisit, which returns the split worker-first |

Activity Log alerts carry no severity of their own; their mail shows the
common schema's default. `alert-kv-config-write` and the two role-assignment
rules fire on every apply that changes a vault or a role assignment. That is
intended: it is a second witness that the apply did what its plan said, and the
only place a change made outside an apply shows up. The two role-definition
rules never fire on an apply, because no apply writes a role definition.

Role assignments and role definitions are a rule each because Azure requires
it, not by choice. A subscription-wide rule in the Administrative category
needs one more single-value condition, and a rule watching both resource types
sends them as an any-of group, which Azure does not count: the first apply was
refused with `UnsupportedCondition` (2026-10-10).

### Before the apply

Read-only checks, worth running before confirming the run that creates these
rules, because each tests an assumption a rule rests on. All are PowerShell.
The first line finds the workspace; the others use it.

```powershell
$ws = (az monitor log-analytics workspace show -n log-plat-prod-cus-01 -g rg-mgmt-plat-prod-cus --subscription sub-plat-mgmt-prod-cus -o json | ConvertFrom-Json).customerId
```

**Timer request rows carry the function's name.** `alert-timer-overdue` matches
each timer by the request row's name.

```powershell
az monitor log-analytics query -w $ws --analytics-query "AppRequests | where TimeGenerated > ago(2h) | summarize Runs = count(), Succeeded = countif(Success) by Name | order by Name asc" -o json | ConvertFrom-Json | Format-Table Name, Runs, Succeeded
```

Success is one row per timer that ran in the two hours, named exactly as in
`functions/function-inventory.json` (`healthPulse`, `checkAgentHealth`,
`syncSocialCalendarScheduled`, …; a `Functions.` prefix is also handled), with
`Succeeded` above zero. Names in any other shape mean the rule would see every
timer as overdue: do not confirm the run, and say so on #964.

**The seal key's caller is the address the host heartbeats from.**
`alert-lab-vault-unwrap` assumes Vault reaches Key Vault from the same address
the Azure Monitor Agent reports. The first query reads the lab vault only,
`kv-labhybrid-prod-cus-01`, by the same `_ResourceId` the rule matches, so a call
to the site vault cannot fail the comparison.

```powershell
az monitor log-analytics query -w $ws --analytics-query "AzureDiagnostics | where TimeGenerated > ago(1h) | where ResourceProvider == 'MICROSOFT.KEYVAULT' | where tolower(_ResourceId) endswith '/providers/microsoft.keyvault/vaults/kv-labhybrid-prod-cus-01' | where OperationName in ('KeyWrap', 'KeyUnwrap') | summarize Calls = count() by CallerIPAddress" -o json | ConvertFrom-Json | Format-Table
```

```powershell
az monitor log-analytics query -w $ws --analytics-query "Heartbeat | where TimeGenerated > ago(1h) | where tolower(_ResourceId) endswith 'arcs-lab-hybrid-prod-cus-01' | distinct ComputerIP" -o json | ConvertFrom-Json | Format-Table
```

Success is every `CallerIPAddress` in the first list appearing in the second.
A caller address the heartbeat does not show (an IPv6 one against an IPv4
heartbeat, say) means the rule would page on Vault's own ten-minute health
check, every evaluation.

**What the Key Vault failure rule would have caught last week.**

```powershell
az monitor log-analytics query -w $ws --analytics-query "AzureDiagnostics | where TimeGenerated > ago(7d) | where ResourceProvider == 'MICROSOFT.KEYVAULT' | where httpStatusCode_d >= 400 | where not(OperationName == 'Authentication' and httpStatusCode_d == 401) | where not(OperationName == 'SecretGet' and httpStatusCode_d == 404) | summarize Rows = count() by Resource, OperationName, httpStatusCode_d" -o json | ConvertFrom-Json | Format-Table
```

Success is no rows: the rule is quiet in normal running. Each row is a
condition it would page on; if any is routine, exclude that operation in the
rule, as the two above are, rather than raising the count.

### Making each one fire once

**With the script.** `scripts/alerts/Invoke-AlertFireTest.ps1` runs each block
below as written: the same stop conditions, the same record files in your home
folder, the same clean-up, put back in a `finally` so that a failure or Ctrl+C
part-way still restores. Then, instead of watching the inbox, it reads Azure
Monitor's fired alerts for the rule once a minute and prints
`PASS <rule> fired at <time>` only for an alert that started after the test
did, or `FAIL <rule>: no alert within <n> minutes`. It ends with the
*[Fire record](#fire-record)* rows to paste. Run it from the repository root
of a checkout of `main`, which has it once the change that adds it is merged,
signed in with `az login` and with `sub-app-site-prod-cus` as az's default
subscription (it checks, and prints the `az account set` line when not).
`True` means the file is there:

```powershell
Test-Path scripts/alerts/Invoke-AlertFireTest.ps1
```

One test at a time, quickest first. Adding `-WhatIf` to a line runs only the
reads, so a stop condition still refuses, and prints every change as the one
command it would run. The window stays open while a test waits.
`lab-agent-offline` keeps the agent stopped for a quarter of an hour of it, and
`swa-bandwidth`, `lab-heartbeat`, `lab-disk` and `timer-overdue` keep their
change until the alert fires: the Azure Monitor Agent stopped, a file filling
the lab host's root to 87%, the rule's threshold or the timer's setting.

| Test | Rules it proves | Needs | Up to | PowerShell |
| --- | --- | --- | --- | --- |
| `kv-config-write` | `alert-kv-config-write` | `az` | 20 min | `pwsh -NoProfile -File scripts/alerts/Invoke-AlertFireTest.ps1 -Test kv-config-write` |
| `rbac-assignment` | `alert-rbac-assignment-mgmt`, `-app` | `az` | 25 min | `pwsh -NoProfile -File scripts/alerts/Invoke-AlertFireTest.ps1 -Test rbac-assignment` |
| `rbac-definition` | `alert-rbac-definition-mgmt`, `-app` | `az` | 30 min | `pwsh -NoProfile -File scripts/alerts/Invoke-AlertFireTest.ps1 -Test rbac-definition` |
| `lab-unit-failed` | `alert-lab-unit-failed` | `az`, `ssh hcw-lab` | 35 min | `pwsh -NoProfile -File scripts/alerts/Invoke-AlertFireTest.ps1 -Test lab-unit-failed` |
| `kv-errors-and-data-write` | `alert-kv-errors`, `alert-kv-data-write` | `az` | 45 min | `pwsh -NoProfile -File scripts/alerts/Invoke-AlertFireTest.ps1 -Test kv-errors-and-data-write` |
| `lab-vault-unwrap` | `alert-lab-vault-unwrap` | `az` | 45 min | `pwsh -NoProfile -File scripts/alerts/Invoke-AlertFireTest.ps1 -Test lab-vault-unwrap` |
| `lab-ssh-burst` | `alert-lab-ssh-burst` | `az`, `ssh hcw-lab` | 45 min | `pwsh -NoProfile -File scripts/alerts/Invoke-AlertFireTest.ps1 -Test lab-ssh-burst` |
| `lab-ssh-login` | `alert-lab-ssh-login` | `az`, `ssh hcw-lab` | 45 min | `pwsh -NoProfile -File scripts/alerts/Invoke-AlertFireTest.ps1 -Test lab-ssh-login` |
| `jobs-poison` | `alert-jobs-poison` | `az`, `gh` | 50 min | `pwsh -NoProfile -File scripts/alerts/Invoke-AlertFireTest.ps1 -Test jobs-poison` |
| `lab-agent-offline` | `alert-lab-agent-offline` | `az`, `ssh hcw-lab` | 45 min | `pwsh -NoProfile -File scripts/alerts/Invoke-AlertFireTest.ps1 -Test lab-agent-offline` |
| `lab-heartbeat` | `alert-lab-heartbeat` | `az`, `ssh hcw-lab`, no lab job running | 55 min | `pwsh -NoProfile -File scripts/alerts/Invoke-AlertFireTest.ps1 -Test lab-heartbeat` |
| `swa-bandwidth` | `alert-swa-bandwidth` | `az` | 75 min | `pwsh -NoProfile -File scripts/alerts/Invoke-AlertFireTest.ps1 -Test swa-bandwidth` |
| `lab-disk` | `alert-lab-disk` | `az`, `ssh hcw-lab`, root at most 80% used | 80 min | `pwsh -NoProfile -File scripts/alerts/Invoke-AlertFireTest.ps1 -Test lab-disk` |
| `timer-overdue` | `alert-timer-overdue` | `az` | 90 min | `pwsh -NoProfile -File scripts/alerts/Invoke-AlertFireTest.ps1 -Test timer-overdue` |

Success is a `PASS` line for every rule and a `$LASTEXITCODE` of `0`. `1`
means the run stopped: a stop condition refused before any change, or a step
failed and what it had changed was put back; the lines above it say which.
`2` means a rule did not fire in time, and everything was put back. `3`
means something was not put back: its record is kept, and the script prints the
line that recovers it. A run cut off any other way, a closed window or a lost
connection, is recovered with its test's line here, which does the recovery
written in its block below and confirms it with that block's read:

| Test | Recovery, PowerShell |
| --- | --- |
| `kv-config-write` | `pwsh -NoProfile -File scripts/alerts/Invoke-AlertFireTest.ps1 -Recover -Test kv-config-write` |
| `rbac-assignment` | `pwsh -NoProfile -File scripts/alerts/Invoke-AlertFireTest.ps1 -Recover -Test rbac-assignment` |
| `rbac-definition` | `pwsh -NoProfile -File scripts/alerts/Invoke-AlertFireTest.ps1 -Recover -Test rbac-definition` |
| `jobs-poison` | `pwsh -NoProfile -File scripts/alerts/Invoke-AlertFireTest.ps1 -Recover -Test jobs-poison` |
| `lab-agent-offline` | `pwsh -NoProfile -File scripts/alerts/Invoke-AlertFireTest.ps1 -Recover -Test lab-agent-offline` |
| `lab-heartbeat` | `pwsh -NoProfile -File scripts/alerts/Invoke-AlertFireTest.ps1 -Recover -Test lab-heartbeat` |
| `swa-bandwidth` | `pwsh -NoProfile -File scripts/alerts/Invoke-AlertFireTest.ps1 -Recover -Test swa-bandwidth` |
| `lab-disk` | `pwsh -NoProfile -File scripts/alerts/Invoke-AlertFireTest.ps1 -Recover -Test lab-disk` |
| `timer-overdue` | `pwsh -NoProfile -File scripts/alerts/Invoke-AlertFireTest.ps1 -Recover -Test timer-overdue` |

The kv-config-write test keeps no record, because its tag is named for the
moment; its recovery takes off any `plat4FireTest` tag the site vault still
carries. `lab-heartbeat` and `lab-disk` keep none either, because the host is
the record: their recoveries start the Azure Monitor Agent again and remove
the test file, and confirm each with the block's own read.
`kv-errors-and-data-write`, `lab-vault-unwrap`, `lab-ssh-burst`,
`lab-ssh-login` and `lab-unit-failed` change nothing, so they have no
recovery.

**By hand.** The blocks below are the reference the script implements, step
for step, and still the way to run a test without it.

The acceptance of #964 is that each new rule has been seen to fire once. These
are the tests, one per rule. Each says what success looks like and how to put
things back; record the date in the *[Fire record](#fire-record)* below. All are
PowerShell, from any directory, signed in with `az login` as the owner.

**`alert-timer-overdue`**: stop one harmless timer for an hour.
`healthPulse` only refreshes the Health Hub, which shows the pulse as stale
meanwhile. Disabling a function is an app setting, so this restarts the app
once on the way in and once on the way out. The test records the setting's
prior state in a file first, and puts back exactly that.

```powershell
$hf = Join-Path $HOME 'plat4-timer-test.json'
```

**Stop conditions.** The first must print `False` (`True` means an earlier run
did not finish: do its recovery, below, first). The second must not show a
value of `true`: if it does, the timer is already off and the test would
change nothing.

```powershell
Test-Path -LiteralPath $hf
```

```powershell
$prior = az functionapp config appsettings list -n func-site-prod-cus-01 -g rg-web-site-prod-cus -o json | ConvertFrom-Json | Where-Object name -eq 'AzureWebJobs.healthPulse.Disabled'
```

```powershell
$prior | Select-Object name, value
```

Record it, then disable the timer:

```powershell
@{ present = [bool]$prior; value = $prior.value } | ConvertTo-Json | Set-Content -LiteralPath $hf
```

```powershell
az functionapp config appsettings set -n func-site-prod-cus-01 -g rg-web-site-prod-cus --settings AzureWebJobs.healthPulse.Disabled=true -o none
```

Success is a mail and a text for `alert-timer-overdue-prod-cus` naming
`healthPulse`, within about 75 minutes (45 of grace, then the next 15-minute
evaluation, then delivery). Then restore from the record: the prior value if
there was one, and otherwise delete the setting, which also takes it back out
of Terraform's view. The same two lines are the recovery after an interruption,
in any window:

```powershell
$h = Get-Content -LiteralPath (Join-Path $HOME 'plat4-timer-test.json') -Raw | ConvertFrom-Json
```

```powershell
if ($h.present) { az functionapp config appsettings set -n func-site-prod-cus-01 -g rg-web-site-prod-cus --settings ('AzureWebJobs.healthPulse.Disabled=' + $h.value) -o none } else { az functionapp config appsettings delete -n func-site-prod-cus-01 -g rg-web-site-prod-cus --setting-names AzureWebJobs.healthPulse.Disabled -o none }
```

Success is this read matching the record (no row if `present` was `false`):

```powershell
az functionapp config appsettings list -n func-site-prod-cus-01 -g rg-web-site-prod-cus -o json | ConvertFrom-Json | Where-Object name -eq 'AzureWebJobs.healthPulse.Disabled' | Select-Object name, value
```

Only then remove the record:

```powershell
Remove-Item -LiteralPath (Join-Path $HOME 'plat4-timer-test.json')
```

Then confirm the writes left the strip intact, with the two reads in
*[The failure with no alert](#the-failure-with-no-alert)*: one
`RUNTIME_CONFIG_WRITER` row reading `azapi-strip`, and an `AzureWebJobsStorage`
count of `0`. The Resolved mail follows the first good run.

**`alert-lab-agent-offline`**: stop the labs agent for a quarter of an
hour, when the Labs dashboard shows it idle. First, `True` in the value column
means the health timer that decides is armed:

```powershell
az functionapp config appsettings list -n func-site-prod-cus-01 -g rg-web-site-prod-cus -o json | ConvertFrom-Json | Where-Object name -eq 'FEATURE_FLAG_CHECK_AGENT_HEALTH' | Select-Object name, value
```

**Stop condition:** this must print `active`. Anything else means the agent is
already down; do not run the test, and find out why instead.

```powershell
ssh hcw-lab 'systemctl is-active hcw-labs-agent'
```

```powershell
ssh hcw-lab 'sudo systemctl stop hcw-labs-agent'
```

Wait until the Telegram "offline" message arrives (five to ten minutes), then
start it again. This line is also the recovery if the test is interrupted, from
any window, and success is its last line reading `active`:

```powershell
ssh hcw-lab 'sudo systemctl start hcw-labs-agent; systemctl is-active hcw-labs-agent'
```

Success is Telegram's "offline" and "back online" messages, and the mail and
text for `alert-lab-agent-offline-prod-cus` within about 30 minutes of the
stop. Public lab submissions are closed while the agent is stopped.

**`alert-jobs-poison`**: put one short-lived message into the poison
queue. No human holds a data-plane role on `stsitefuncprodcus01`, and its
firewall denies everything but the Functions subnet, so the test takes a
temporary role and a temporary firewall entry for this machine. It owns exactly
those two changes and nothing else. It runs alone, stops if either change
already exists, writes down what it is about to change before changing it, and
undoes exactly what it wrote down.

**Run it alone.** The checks below cannot reserve anything: two runs of this
test with the same account and address would both pass them, and one run's
cleanup would undo the other's access. So run it with no other fire test from
this page in progress, by you or anyone using the same account, and not during
a `deploy-functions.yml` run, which opens and closes the same firewall. This
prints nothing when no deploy is running:

```powershell
gh run list -R saulpatinojr/HCW-HybridCloudWorks -w deploy-functions.yml -s in_progress
```

Four values next. `$sf` is where the test records what it owns, so a recovery
in a new window undoes the same things:

```powershell
$sa = (az storage account show -n stsitefuncprodcus01 -g rg-web-site-prod-cus -o json | ConvertFrom-Json).id
```

```powershell
$me = (az ad signed-in-user show -o json | ConvertFrom-Json).id
```

```powershell
$ip = Invoke-RestMethod -Uri https://api.ipify.org
```

```powershell
$sf = Join-Path $HOME 'plat4-poison-test.json'
```

**Stop conditions.** The first must print `False`: `True` means an earlier
run did not finish, so do its recovery (below) first. The other two must print
nothing. A row in the second means you already hold an assignment on the
account, which this test would share a scope with: skip the test and note that
in the fire record. An address in the third means the firewall is already open:
wait until it prints nothing.

```powershell
Test-Path -LiteralPath $sf
```

```powershell
az role assignment list --assignee $me --scope $sa -o json | ConvertFrom-Json | Select-Object roleDefinitionName, scope
```

```powershell
(az storage account show -n stsitefuncprodcus01 -g rg-web-site-prod-cus -o json | ConvertFrom-Json).networkRuleSet.ipRules
```

Choose the role assignment's id before it exists, and record it with the
address, so every change is in the record before it is made:

```powershell
$ran = [guid]::NewGuid().Guid
```

```powershell
$ra = "$sa/providers/Microsoft.Authorization/roleAssignments/$ran"
```

```powershell
@{ ip = $ip; ra = $ra } | ConvertTo-Json | Set-Content -LiteralPath $sf
```

```powershell
az role assignment create --name $ran --assignee-object-id $me --assignee-principal-type User --role "Storage Queue Data Contributor" --scope $sa -o none
```

```powershell
az storage account network-rule add --account-name stsitefuncprodcus01 -g rg-web-site-prod-cus --ip-address $ip -o none
```

Wait five minutes for the role and the rule to take effect, then create the
queue if the host never has (it is a no-op if it exists) and put a message
that expires on its own after 15 minutes. An `AuthorizationPermissionMismatch`
or `AuthorizationFailure` here means the wait was too short: wait and repeat.

```powershell
az storage queue create --name platform-jobs-poison --account-name stsitefuncprodcus01 --auth-mode login -o none
```

```powershell
az storage message put --queue-name platform-jobs-poison --account-name stsitefuncprodcus01 --auth-mode login --content plat4-fire-test --time-to-live 900 -o none
```

Then undo both, whether or not the put worked, by the recorded address and id:

```powershell
az storage account network-rule remove --account-name stsitefuncprodcus01 -g rg-web-site-prod-cus --ip-address $ip -o none
```

```powershell
az role assignment delete --ids $ra
```

Success is `alert-jobs-poison-prod-cus` within about 30 minutes, and the two
stop-condition reads printing nothing again:

```powershell
az role assignment list --assignee $me --scope $sa -o json | ConvertFrom-Json | Select-Object roleDefinitionName, scope
```

```powershell
(az storage account show -n stsitefuncprodcus01 -g rg-web-site-prod-cus -o json | ConvertFrom-Json).networkRuleSet.ipRules
```

Only once both print nothing, remove the record. Until then it is what a
recovery works from:

```powershell
Remove-Item -LiteralPath $sf
```

**If the test was interrupted**, recover from the record, in any window, still
alone. It removes the address the test opened, even if this machine's address
has changed since, and the assignment the test created or was about to create.
A delete that answers that the assignment does not exist means the run stopped
before creating it, which is fine:

```powershell
$s = Get-Content -LiteralPath (Join-Path $HOME 'plat4-poison-test.json') -Raw | ConvertFrom-Json
```

```powershell
az storage account network-rule remove --account-name stsitefuncprodcus01 -g rg-web-site-prod-cus --ip-address $s.ip -o none
```

```powershell
az role assignment delete --ids $s.ra
```

Then run the two verification reads above (set `$sa` and `$me` again first in
a new window). Only once both print nothing, delete the record:

```powershell
Remove-Item -LiteralPath (Join-Path $HOME 'plat4-poison-test.json')
```

The role's create and delete also fire `alert-rbac-assignment-app-prod-cus`, twice.
That is that rule's test done as well.

**`alert-swa-bandwidth`**: lower the threshold to one byte for an hour and
put it back. Driving 2.7 GB of real traffic would spend nearly 3% of the
month's allowance, and Cloudflare's cache would absorb most of it before it
reached the Static Web App. The test saves the rule's definition, exactly as
ARM returns it, to a file before changing anything, and restores from that
file, so an interruption cannot lose the real threshold. First the rule's URL
and the two files: the saved original in your home folder, and a temporary
working copy of this test's own:

```powershell
$u = 'https://management.azure.com' + (az monitor metrics alert show -n alert-swa-bandwidth-prod-cus -g rg-web-site-prod-cus -o json | ConvertFrom-Json).id + '?api-version=2018-03-01'
```

```powershell
$bf = Join-Path $HOME 'plat4-swa-test.json'
```

```powershell
$f = Join-Path ([IO.Path]::GetTempPath()) ('plat4-swa-' + [guid]::NewGuid() + '.json')
```

**Stop condition:** this must print `False`. `True` means an earlier run did not
finish: do its recovery, below, first.

```powershell
Test-Path -LiteralPath $bf
```

Save the original, then lower the threshold in the working copy and apply it:

```powershell
az rest --method get --url $u -o json | Set-Content -LiteralPath $bf
```

```powershell
$a = Get-Content -LiteralPath $bf -Raw | ConvertFrom-Json
```

```powershell
$a.properties.criteria.allOf[0].threshold = 1
```

```powershell
[IO.File]::WriteAllText($f, ($a | ConvertTo-Json -Depth 20))
```

```powershell
az rest --method put --url $u --body "@$f" -o none
```

Success is `alert-swa-bandwidth-prod-cus` at the next hourly evaluation, as
long as the site has served anything in a day. Then restore the saved original.
This is also the recovery after an interruption, in any window (set `$u` and
`$bf` again first, with the lines above):

```powershell
az rest --method put --url $u --body "@$bf" -o none
```

```powershell
(az monitor metrics alert show -n alert-swa-bandwidth-prod-cus -g rg-web-site-prod-cus -o json | ConvertFrom-Json).criteria.allOf[0].threshold
```

Success is `2666666666`. Only then remove the saved original:

```powershell
Remove-Item -LiteralPath $bf
```

and the working copy, if this window still has `$f`:

```powershell
Remove-Item -LiteralPath $f
```

An HCP Terraform plan taken while the threshold is lowered shows it as drift;
the restore ends that.

**`alert-kv-errors` and `alert-kv-data-write`**: one refused write
fires both. It updates the attributes of a secret that does not exist, named
with this moment's time so it cannot be an existing secret, so even if it got
through it would change nothing.

```powershell
$sn = 'plat4-fire-test-' + (Get-Date -Format 'yyyyMMddHHmmss')
```

```powershell
az keyvault secret set-attributes --vault-name kv-site-prod-cus-01 --name $sn --enabled false
```

The command failing is the expected result: `Forbidden` (the firewall or the
missing data role) or `SecretNotFound`. Success is
`alert-kv-errors-prod-cus` and `alert-kv-data-write-prod-cus` within about 30
minutes. If only the first arrives, the refused row did not carry the
operation name; the Key Vault query in *[Before the apply](#before-the-apply)*,
narrowed to the last hour, shows what it did carry.

**`alert-lab-vault-unwrap`**: ask the seal key to wrap a test value from
this machine. The owner holds no role on the key, so Key Vault refuses it, and
the refusal is logged with this machine's address. It wraps and never unwraps,
so nothing about Vault changes either way.

```powershell
$t = (az account get-access-token --resource https://vault.azure.net -o json | ConvertFrom-Json).accessToken
```

```powershell
Invoke-RestMethod -Method Post -Uri 'https://kv-labhybrid-prod-cus-01.vault.azure.net/keys/vault-seal/wrapkey?api-version=7.4' -Headers @{ Authorization = "Bearer $t" } -ContentType 'application/json' -Body '{"alg":"RSA-OAEP-256","value":"cGxhdDQtZmlyZS10ZXN0"}'
```

A 403 error is the expected result. Success is
`alert-lab-vault-unwrap-prod-cus` within about 30 minutes, with
`alert-kv-errors-prod-cus` beside it for the same refusal.

**`alert-lab-ssh-burst`**: write a thousand failed-login lines to the lab
host's auth log under sshd's name, from a documentation address. They are
written by `logger`, not by sshd, so fail2ban (which reads the sshd unit's
journal) bans nothing, and no login is attempted. Each line carries its own
port number on purpose: the host's rsyslog has `$RepeatedMsgReduction on`
(`/etc/rsyslog.conf`, Ubuntu's default), which folds identical consecutive
lines into one `message repeated N times` line, and the 2026-10-15 run with
one fixed port reached the workspace as two `Syslog` rows and fired nothing
(#964). A thousand distinct lines arrive as a thousand.

```powershell
ssh hcw-lab 'for i in {1..1000}; do logger -p auth.info -t sshd "Invalid user plat4firetest from 192.0.2.10 port $((20000 + i))"; done'
```

Success is `alert-lab-ssh-burst-prod-cus` within about 30 minutes. It
resolves on its own once the burst leaves the 15-minute window.

**`alert-lab-ssh-login`**: write one accepted-login line to the lab host's
auth log under sshd's name, for a user that does not exist, from a
documentation address, with a fingerprint no key has. It is written by
`logger`, not by sshd, so no login happens and nothing on the host changes.
The line has the shape of OpenSSH's own, which the rule parses, and both its
user and its key are outside the expected pair, so the rule pages on it
whether or not `lab_ssh_loopback_only` is set (#953).

```powershell
ssh hcw-lab 'logger -p auth.info -t sshd "Accepted publickey for firetest from 192.0.2.10 port 1 ssh2: ED25519 SHA256:firetest"'
```

Success is `alert-lab-ssh-login-prod-cus` within about 30 minutes. The rule
is stateless, so no Resolved mail follows, and now and then a second alert for
the same line arrives a quarter of an hour after the first: the duplicate the
rule accepts rather than miss a login.

**`alert-lab-unit-failed`** (#981, LAB-2): write one line to the lab host's
syslog exactly as the `hcw-unit-failed@` notifier writes its own
(`lab-host/ansible/roles/hardening/templates/hcw-unit-failed@.service.j2`:
`logger -t hcw-unit-failed -p daemon.err "unit %i entered the failed state on
%H"`), naming a unit called `hcw-fire-test-<UTC stamp>.service`, which does
not exist. The tag is what the rule reads (`ProcessName == "hcw-unit-failed"`),
and the daemon facility at err is within what the lab DCR ships. No unit
fails, nothing is stopped, and nothing is put back: the rule is stateless and
the line leaves its hour-long window on its own.

**Stop condition:** this must print nothing. A line means a unit failed in the
last hour, or an earlier run of this test is still in the window; either way
the alert that opens next could be that line's, so look at the unit first
(`systemctl --failed --no-pager` names it).

```powershell
ssh hcw-lab 'sudo journalctl -t hcw-unit-failed --since -1h --no-pager -q -o cat'
```

The stamp is the moment of the write, so the mail and the Fire record can
quote the unit:

```powershell
$stamp = [datetime]::UtcNow.ToString("yyyyMMdd'T'HHmmss'Z'"); ssh hcw-lab ('logger -t hcw-unit-failed -p daemon.err "unit hcw-fire-test-' + $stamp + '.service entered the failed state on $(hostname)"')
```

Success is `alert-lab-unit-failed-prod-cus` within about 20 minutes (a
15-minute evaluation plus Syslog's ingestion), its mail naming the
`hcw-fire-test` unit. No Resolved mail follows, and for six hours after it the
rule's actions are muted: a real failure in that time opens an alert but sends
no mail, which is the mute doing what ADR 0022 says.

**`alert-lab-heartbeat`** (#981, LAB-2): stop the Azure Monitor Agent on the
lab host until the rule sees an empty 30-minute window, then start it again.
The unit is `azuremonitoragent`, installed by the Arc extension
`Microsoft.Azure.Monitor/AzureMonitorLinuxAgent`; it is the unit that writes
the `Heartbeat` rows. The Arc agent itself (`himdsd`) is not touched, so the
machine stays Connected and Arc SSH keeps working, which is the path that puts
it back. While it is stopped the host ships nothing to Log Analytics: no
`Heartbeat`, and no `Perf` or `Syslog` rows either, so `alert-lab-disk`,
`alert-lab-unit-failed` and the two ssh rules see nothing from the host for
that window. Run it with no lab job running, when
`https://hybridcloudworks.com/admin/labs?tab=agents` shows the agent idle.

**Stop conditions:** the first must print nothing (a `labjob-` name is a lab
job running), and the second must print `active`. Anything else means the host
is already shipping nothing and the alert is open or about to be; do not run
the test, and find out why instead.

```powershell
ssh hcw-lab 'sudo docker ps --filter name=labjob- --format {{.Names}}'
```

```powershell
ssh hcw-lab 'systemctl is-active azuremonitoragent'
```

```powershell
ssh hcw-lab 'sudo systemctl stop azuremonitoragent'
```

The window is empty 30 minutes after the stop, and the next quarter-hour
evaluation after that opens the alert: 30 to 45 minutes, plus delivery. Then
start the agent again. This line is also the recovery if the test is
interrupted, from any window, and success is its last line reading `active`:

```powershell
ssh hcw-lab 'sudo systemctl start azuremonitoragent; systemctl is-active azuremonitoragent'
```

Success is `alert-lab-heartbeat-prod-cus` within about 45 minutes of the stop
and `azuremonitoragent` active again. The alert is stateful and resolves on
its own once heartbeats resume.

**`alert-lab-disk`** (#981, LAB-2): allocate one file on the lab host's root
filesystem so that it reads 87% used, past the rule's 85%, hold it until the
alert fires, and remove it. The file is `/var/tmp/hcw-fire-test-disk.img`
(`/var/tmp`, not `/tmp`, which may be a tmpfs). Usage is measured as `df`'s
`Use%` does, used over used plus available, which is what the agent reports as
`% Used Space`; the lab DCR (`infra/lab-hybrid.tf`, `performance_counter`)
samples it every 60 seconds, so the sample lands within a minute, and the rule
evaluates hourly over the hour's maximum, which is the wait.

**Stop conditions:** the file must not be there (an earlier run did not
finish; the remove below is its recovery), the root must be at most 80% used,
and 87% must leave at least 10 GiB free. `df -h /` shows the first two at a
glance; the script computes the third, and refuses on any of them. The
allocation below recomputes the size from `df` at that moment, rounded down to
a MiB, and refuses with exit 4 if the numbers have moved past the same limits.

```powershell
ssh hcw-lab 'df -h /; ls -l /var/tmp/hcw-fire-test-disk.img'
```

```powershell
ssh hcw-lab 'set -e; set -- $(df -B1 --output=size,used,avail / | tail -n 1); used=$2; avail=$3; total=$((used+avail)); add=$(( (87*total/100 - used) / 1048576 * 1048576 )); if [ $((used*100/total)) -gt 80 ] || [ $add -le 0 ] || [ $((avail-add)) -lt 10737418240 ]; then echo "refused: df moved past a stop condition (used=$used avail=$avail add=$add)"; exit 4; fi; sudo fallocate -l $add /var/tmp/hcw-fire-test-disk.img; echo "allocated $add bytes"; df -B1 --output=size,used,avail /'
```

Wait for the alert: the first hourly evaluation after the sample lands, so up
to an hour and a few minutes. Then remove the file. This line is also the
recovery if the test is interrupted, from any window, and success is `absent`
followed by `df`'s row reading as it did before:

```powershell
ssh hcw-lab 'sudo rm -f /var/tmp/hcw-fire-test-disk.img; test -e /var/tmp/hcw-fire-test-disk.img && echo present || echo absent; df -B1 --output=size,used,avail /'
```

Success is `alert-lab-disk-prod-cus` within about 65 minutes and `df` reading
as it did before. The alert is stateful and resolves two clear evaluations
after the file is gone.

**Adding, rotating or removing an admin SSH key.** The rule's approved keys
are a reviewed list in `infra/` (`lab_ssh_admin_key_fingerprints`), never
read from the host, so a key the host merely has is not trusted by the alert.
A change to the keys the host accepts is therefore two edits in one pull
request: the public key in `lab-host/ansible/group_vars/all.yml`
(`hardening_admin_authorized_keys`) and its fingerprint in
`infra/variables.tf`. `scripts/lab-host-ssh-login-alert.test.mjs` fails when
the two lists differ. The fingerprint of the workstation key pinned today
prints with this PowerShell line; for another key, run it on that key's own
`.pub` file. The second field of the output, starting `SHA256:`, is the value
to list:

```powershell
ssh-keygen -lf $HOME\.ssh\hcw-lab_ed25519.pub
```

Apply in this order:
1. Confirm the `hcw-azure` run first, so the alert knows the new key.
2. Then run `bootstrap.sh`, which installs the key on the host.

The other order makes the first login with the new key page. Removing a
key is the same two edits in the reverse order: bootstrap first, then the
apply.

**`alert-kv-config-write`**: add a tag to the site vault and take it off.
A tag write is a Resource Manager write on the vault and touches nothing else.
The key carries this moment's time, so it cannot be a tag the vault already
has, and the delete removes that key alone.

```powershell
$kv = (az keyvault show -n kv-site-prod-cus-01 -g rg-sec-site-prod-cus -o json | ConvertFrom-Json).id
```

```powershell
$tk = 'plat4FireTest' + (Get-Date -Format 'yyyyMMddHHmmss')
```

```powershell
az tag update --resource-id $kv --operation Merge --tags "$tk=1" -o none
```

```powershell
az tag update --resource-id $kv --operation Delete --tags "$tk=1" -o none
```

Success is two notifications for `alert-kv-config-write-prod-cus`, one per
write, within about ten minutes. Activity Log alerts are stateless, so there
is no Resolved mail.

**`alert-rbac-assignment-app` and `alert-rbac-assignment-mgmt`**: grant this
account Reader on one group in each subscription and take it back. Like the
poison test, each half chooses the assignment's id before creating it, records
it in a file, deletes by that id, and recovers from the file. The poison queue
test above already covers the application subscription; this covers both.
Run one half at a time, in one window. The record file is the test's lock: the
line that writes it refuses to overwrite one, so an error there saying the file
exists means a run is unfinished; stop and do the recovery below. Every group
is looked up with its subscription named, so the window's default subscription
does not matter. `$me` is the value from that test; set it again in a new
window:

```powershell
$me = (az ad signed-in-user show -o json | ConvertFrom-Json).id
```

```powershell
$rf = Join-Path $HOME 'plat4-rbac-test.json'
```

```powershell
$mg = (az group show -n rg-mgmt-plat-prod-cus --subscription sub-plat-mgmt-prod-cus -o json | ConvertFrom-Json).id
```

**Stop conditions:** the first must print `False` (`True` means an earlier run
did not finish: do the recovery below first), and the second must print
nothing. A row in the second means you already hold a direct assignment at that
group; skip this half and note it in the fire record.

```powershell
Test-Path -LiteralPath $rf
```

```powershell
az role assignment list --assignee $me --scope $mg -o json | ConvertFrom-Json | Select-Object roleDefinitionName, scope
```

Choose and record the id, then create and delete by it:

```powershell
$rn = [guid]::NewGuid().Guid
```

```powershell
$rid = "$mg/providers/Microsoft.Authorization/roleAssignments/$rn"
```

```powershell
@{ ra = $rid } | ConvertTo-Json | Out-File -LiteralPath $rf -NoClobber
```

```powershell
az role assignment create --name $rn --assignee-object-id $me --assignee-principal-type User --role Reader --scope $mg -o none
```

```powershell
az role assignment delete --ids $rid
```

Success is two notifications for `alert-rbac-assignment-mgmt-prod-cus` within about
ten minutes, and the stop-condition list printing nothing again. Only then
remove the record:

```powershell
Remove-Item -LiteralPath $rf
```

For the application subscription, the same with `rg-web-site-prod-cus`: check
both stop conditions again, then:

```powershell
$rg = (az group show -n rg-web-site-prod-cus --subscription sub-app-site-prod-cus -o json | ConvertFrom-Json).id
```

```powershell
az role assignment list --assignee $me --scope $rg -o json | ConvertFrom-Json | Select-Object roleDefinitionName, scope
```

```powershell
$rn = [guid]::NewGuid().Guid
```

```powershell
$rid = "$rg/providers/Microsoft.Authorization/roleAssignments/$rn"
```

```powershell
@{ ra = $rid } | ConvertTo-Json | Out-File -LiteralPath $rf -NoClobber
```

```powershell
az role assignment create --name $rn --assignee-object-id $me --assignee-principal-type User --role Reader --scope $rg -o none
```

```powershell
az role assignment delete --ids $rid
```

Success is two notifications for `alert-rbac-assignment-app-prod-cus`, and
this list printing nothing again. A row means the delete did not take: keep
the record and do the recovery below.

```powershell
az role assignment list --assignee $me --scope $rg -o json | ConvertFrom-Json | Select-Object roleDefinitionName, scope
```

Only then remove the record:

```powershell
Remove-Item -LiteralPath $rf
```

**If either half was interrupted**, recover from the record in any window. A
delete that answers that the assignment does not exist means the run stopped
before creating it:

```powershell
$r = Get-Content -LiteralPath (Join-Path $HOME 'plat4-rbac-test.json') -Raw | ConvertFrom-Json
```

```powershell
az role assignment delete --ids $r.ra
```

Then repeat that half's stop-condition list, which should print nothing, and
only then remove the record:

```powershell
Remove-Item -LiteralPath (Join-Path $HOME 'plat4-rbac-test.json')
```

**`alert-rbac-definition-app` and `alert-rbac-definition-mgmt`**: create a
throwaway custom role in each subscription and delete it. The role can read
resource groups and nothing else, is assignable at one group only, and is never
assigned. Azure chooses a new role's id itself, so this test chooses the role's
name instead, records it before creating the role, and deletes and recovers by
it. The record is the lock, as in the test above: one half at a time, and an
error on the line that writes it, saying the file exists, means stop and
recover. First the Management half's group and the record:

```powershell
$mg = (az group show -n rg-mgmt-plat-prod-cus --subscription sub-plat-mgmt-prod-cus -o json | ConvertFrom-Json).id
```

```powershell
$df = Join-Path $HOME 'plat4-roledef-test.json'
```

**Stop conditions:** the first must print `False` (`True` means an earlier run
did not finish: do the recovery below first), and the second must print
nothing. A row in the second is a fire-test role an earlier run left behind;
recover it first.

```powershell
Test-Path -LiteralPath $df
```

```powershell
az role definition list --custom-role-only true --scope $mg -o json | ConvertFrom-Json | Where-Object roleName -like 'plat4-fire-test-*' | Select-Object roleName, id
```

Choose and record the name, write the role to a temporary file, then create
it:

```powershell
$dn = 'plat4-fire-test-' + [guid]::NewGuid().Guid
```

```powershell
@{ name = $dn; scope = $mg } | ConvertTo-Json | Out-File -LiteralPath $df -NoClobber
```

```powershell
$dj = Join-Path ([IO.Path]::GetTempPath()) ($dn + '.json')
```

```powershell
@{ Name = $dn; IsCustom = $true; Description = 'PLAT-4 fire test. Delete on sight.'; Actions = @('Microsoft.Resources/subscriptions/resourceGroups/read'); NotActions = @(); AssignableScopes = @($mg) } | ConvertTo-Json | Set-Content -LiteralPath $dj
```

```powershell
az role definition create --role-definition "@$dj" -o none
```

Run the stop-condition list again: it should now print one row, named `$dn`.
A new custom role can take a minute to be listed; run it again until the row
appears. Then delete the role by its name:

```powershell
az role definition delete --name $dn --scope $mg
```

Success is two notifications for `alert-rbac-definition-mgmt-prod-cus` within
about ten minutes, one for the create and one for the delete, and the
stop-condition list printing nothing again. Only then remove the two files:

```powershell
Remove-Item -LiteralPath $dj
```

```powershell
Remove-Item -LiteralPath $df
```

For the application subscription, the same with `rg-web-site-prod-cus`. The
group first, then the same two stop conditions: `False`, then nothing.

```powershell
$rg = (az group show -n rg-web-site-prod-cus --subscription sub-app-site-prod-cus -o json | ConvertFrom-Json).id
```

```powershell
Test-Path -LiteralPath $df
```

```powershell
az role definition list --custom-role-only true --scope $rg -o json | ConvertFrom-Json | Where-Object roleName -like 'plat4-fire-test-*' | Select-Object roleName, id
```

Then choose, record, write and create, and run that list again until it
prints the new role's row before deleting it:

```powershell
$dn = 'plat4-fire-test-' + [guid]::NewGuid().Guid
```

```powershell
@{ name = $dn; scope = $rg } | ConvertTo-Json | Out-File -LiteralPath $df -NoClobber
```

```powershell
$dj = Join-Path ([IO.Path]::GetTempPath()) ($dn + '.json')
```

```powershell
@{ Name = $dn; IsCustom = $true; Description = 'PLAT-4 fire test. Delete on sight.'; Actions = @('Microsoft.Resources/subscriptions/resourceGroups/read'); NotActions = @(); AssignableScopes = @($rg) } | ConvertTo-Json | Set-Content -LiteralPath $dj
```

```powershell
az role definition create --role-definition "@$dj" -o none
```

```powershell
az role definition delete --name $dn --scope $rg
```

Success is two notifications for `alert-rbac-definition-app-prod-cus`, and
this list printing nothing again. A row means the delete did not take: keep
both files and do the recovery below.

```powershell
az role definition list --custom-role-only true --scope $rg -o json | ConvertFrom-Json | Where-Object roleName -like 'plat4-fire-test-*' | Select-Object roleName, id
```

Only then remove the two files:

```powershell
Remove-Item -LiteralPath $dj
```

```powershell
Remove-Item -LiteralPath $df
```

**If either half was interrupted**, recover from the record in any window. A
delete that answers that the role does not exist means the run stopped before
creating it, or the role is not listed yet: run the list below, and if it
prints a row, delete again.

```powershell
$d = Get-Content -LiteralPath (Join-Path $HOME 'plat4-roledef-test.json') -Raw | ConvertFrom-Json
```

```powershell
az role definition delete --name $d.name --scope $d.scope
```

```powershell
az role definition list --custom-role-only true --scope $d.scope -o json | ConvertFrom-Json | Where-Object roleName -like 'plat4-fire-test-*' | Select-Object roleName, id
```

Only once that list prints nothing, remove the temporary role file, if the run
got as far as writing it, and then the record:

```powershell
Remove-Item -LiteralPath (Join-Path ([IO.Path]::GetTempPath()) ($d.name + '.json')) -ErrorAction SilentlyContinue
```

```powershell
Remove-Item -LiteralPath (Join-Path $HOME 'plat4-roledef-test.json')
```

### Fire record

| Rule | Seen to fire | Notes |
| --- | --- | --- |
| `alert-timer-overdue` | 2026-10-15, 21:52Z | `Invoke-AlertFireTest.ps1 -Test timer-overdue`: `healthPulse` was disabled at 20:48Z and the alert opened at 21:52:30Z naming it; the setting was put back as recorded and the strip read intact. This is the first evaluation-capable run: the earlier try that day stayed silent for 95 minutes because Kusto refused the rule's query at every evaluation from its create on 2026-10-10 (`SEM0040`, `bin_at()` given per-row columns). #1195 replaced that line, and the owner's apply put it live at 20:42Z (#964) |
| `alert-lab-agent-offline` | 2026-10-15, 05:51Z | `Invoke-AlertFireTest.ps1 -Test lab-agent-offline`: the agent stopped at 05:40:06Z, the alert opened at 05:51:03Z, the agent started again at 05:55Z (#964) |
| `alert-jobs-poison` | 2026-10-15, 04:07Z | `Invoke-AlertFireTest.ps1 -Test jobs-poison`: the message was put at 03:52Z after the five-minute propagation wait; the alert opened at 04:07:24Z; the temporary role fired `alert-rbac-assignment-app` beside it, as the test says (#964) |
| `alert-swa-bandwidth` | 2026-10-15, 03:44Z | `Invoke-AlertFireTest.ps1 -Test swa-bandwidth`: the threshold went to one byte at 03:38Z, the alert opened at 03:44:22Z at the next hourly evaluation, and the threshold read 2666666666 again after (#964) |
| `alert-kv-errors` | 2026-10-15, 03:21Z | `Invoke-AlertFireTest.ps1 -Test kv-errors-and-data-write`: a `secret set-attributes` on a name that does not exist, refused `Forbidden` at 03:05Z; the alert opened at 03:21:21Z (#964) |
| `alert-kv-data-write` | 2026-10-15, 03:14Z | The same refusal; the alert opened at 03:14:14Z (#964) |
| `alert-kv-config-write` | 2026-10-11, 04:52Z | `Invoke-AlertFireTest.ps1 -Test kv-config-write`: the test tag went on and came off at 04:46Z; Azure Monitor opened the alert (ActivityLog Administrative) at 04:52:04Z. The first proof that Activity Log alerts reach Alerts Management, where the script reads them |
| `alert-rbac-assignment-app` | 2026-10-15, 03:32Z | `Invoke-AlertFireTest.ps1 -Test rbac-assignment`: a Reader grant to the signed-in account at rg-web-site-prod-cus, created and deleted; the alert opened at 03:32:04Z (#964) |
| `alert-rbac-assignment-mgmt` | 2026-10-15, 03:31Z | The same at rg-mgmt-plat-prod-cus; the alert opened at 03:31:03Z (#964) |
| `alert-rbac-definition-app` | 2026-10-15, 03:37Z | `Invoke-AlertFireTest.ps1 -Test rbac-definition`: a throwaway `plat4-fire-test-*` role at rg-web-site-prod-cus, created, listed and deleted; the alert opened at 03:37:04Z (#964) |
| `alert-rbac-definition-mgmt` | 2026-10-15, 03:36Z | The same at rg-mgmt-plat-prod-cus; the alert opened at 03:36:04Z (#964) |
| `alert-lab-vault-unwrap` | 2026-10-15, 04:23Z | `Invoke-AlertFireTest.ps1 -Test lab-vault-unwrap`: a wrap request from the workstation, refused 403 at 04:08Z and logged with its address; the alert opened at 04:23:01Z. `alert-kv-errors` did not open beside it because its 03:21Z alert was still open, which the test allows (#964) |
| `alert-lab-ssh-burst` | 2026-10-15, 07:41Z | `Invoke-AlertFireTest.ps1 -Test lab-ssh-burst`: a thousand `sshd` lines from a documentation address, each with its own port, written by `logger` at 07:27Z; the alert opened at 07:41:48Z. The first run, with one fixed port, failed: rsyslog's `$RepeatedMsgReduction on` folded the burst into two Syslog rows (#964), which is why each line now differs |
| `alert-lab-backup-missing-coder` | 2026-10-14, 06:23Z | On the real condition, not a staged one. The rule was created at 06:16:56Z, before the host had uploaded any Coder dump, and its first evaluation opened an alert at 06:23:14Z with its actions run. It opened again every hour, its actions muted for a day by the `mute_actions_after_alert_duration` it had then, until 03:23Z on 2026-10-15. The first dump, `coder/coder-20261015T033716Z.sql.gz`, landed at 03:37:18Z, and no evaluation has opened one since. Read from Alerts Management on 2026-10-16. So the two-night timer stop this row used to call for is not needed (#964, #955) |
| `alert-lab-backup-missing-vault` | 2026-10-14, 06:30Z | The same way. Created at 06:16:56Z with no Vault snapshot uploaded yet, it opened an alert at 06:30:23Z with its actions run, and again hourly until 14:30Z. The first snapshot, `vault/vault-20261014T143509Z.snap`, landed at 14:35:10Z, and none has opened since (#964, #955) |
| `alert-lab-ssh-login` | 2026-10-17, 00:01Z | `Invoke-AlertFireTest.ps1 -Test lab-ssh-login`: one accepted-login line for a user that does not exist, from a documentation address, written with `logger` at 23:55:40Z on 2026-10-16; the alert opened at 00:01:44Z. Created by `run-6uJYNGWLDxkdv5ZB`, and `verify-alert-state.yml` read it OK (#953) |
| `alert-lab-heartbeat` | 2026-10-18, 15:36Z | `Invoke-AlertFireTest.ps1 -Test lab-heartbeat`: `azuremonitoragent` stopped at 14:52:53Z, the 30-minute window empty from 15:22:53Z, the alert opened at 15:36:11Z at the quarter-hour evaluation after; the agent started again and read `active` (#981, LAB-2). The 2026-10-06 alert at the rule's first evaluation was the `Computer` predicate misreading an Arc machine, not a missing heartbeat, and does not count |
| `alert-lab-disk` | 2026-10-18, 16:20Z | `Invoke-AlertFireTest.ps1 -Test lab-disk`: one 138.9 GiB file took the root filesystem from 15% to 87% used at 15:43:26Z, the alert opened at 16:20:16Z at the hourly evaluation, the file was removed and df read 15% again (#981, LAB-2) |
| `alert-lab-unit-failed` | 2026-10-18, 14:46Z | `Invoke-AlertFireTest.ps1 -Test lab-unit-failed`: one `hcw-unit-failed` line at `daemon.err` naming `hcw-fire-test-20261018T143622Z.service`, written at 14:36:22Z as the notifier writes its own; the alert opened at 14:46:59Z; nothing to put back (#981, LAB-2) |
| `alert-export-window-latency` | not yet | No fire test: a degraded export window cannot be staged without slowing production. Design test: the rule's query with `windowRequests >= 1` and `windowP95 > 0` under Application Insights → **Logs** returns one row on any night with requests in the window |

### What these still do not cover

- **A daily digest of denials.** Denials are written to a Cosmos container,
  not to Log Analytics, so a digest needs code (a timer that reads the
  container and mails or posts a summary), not an alert rule. It is a
  follow-up on #964, not part of this change.
- **Log alerts sleep while the workspace is capped.** Every rule above that
  reads a billable table stops seeing new rows at the cap until the 08:00 UTC
  reset. `alert-logs-capacity` warns at 80%, and the reachability rule fires on
  the silence; the metric and Activity Log rules here keep evaluating.
- **Cloudflare's audit log and 90-day retention** for the tables these rules
  read are the rest of the assessment's security-observability item (PLAT-8),
  not this change.
- **The Coder status token's refusal and the lab canary (#1009).** Both are
  raised by the health pulse (the Health Hub's **Coder status token** and
  **Lab job canary** cards) and each writes a content-free warning line, but
  no rule pages on either yet. A follow-up rule, scoped like
  `alert-timer-overdue` (the component, classic schema), would read:

  ```kusto
  traces
  | where severityLevel == 2
  | where message startswith "coder-status: Coder refused CODER_STATUS_TOKEN (401)"
  | summarize refusals = count()
  ```

  and, for a canary that has stopped passing,

  ```kusto
  traces
  | where severityLevel == 2
  | where message startswith "[labCanary] the end-to-end lab job did not pass"
  | summarize failures = count()
  ```

  each firing on a count above zero over a 15-minute window. Traces are
  sampled under load (`host.json`), so a rule on them is a second channel;
  the pulse's record is the one that is always written.

## The failure with no alert

Run this when the site is reported down but Azure looks healthy, and as step 1
of the post-apply sequence. The latest **Monitor Functions Registered** run's
job summary answers all three questions below, if one has landed since the
change; these are the same reads by hand. All are PowerShell.

Which expected functions are not registered. This reads
`functions/function-inventory.json`, so run it from the repository root of a
checkout of `main`, and only when `main` is what was last deployed (the
monitor reads the deployed commit's copy itself). Confirm the file is there
first; `True` means it is:

```powershell
Test-Path functions/function-inventory.json
```

```powershell
az functionapp function list -n func-site-prod-cus-01 -g rg-web-site-prod-cus -o json | ConvertFrom-Json | ForEach-Object name | node scripts/check-registered-functions.mjs
```

Success is a first line of two equal numbers, the size of the inventory twice
(`248 of 248` when this was written), and `$LASTEXITCODE` of `0`. Anything
missing is listed beneath as `` `name` (trigger) ``, and the exit code is `1`.

The strip's stamp, which should be one row reading `azapi-strip`, and the
`AzureWebJobsStorage` row count, which should be `0`:

```powershell
az functionapp config appsettings list -n func-site-prod-cus-01 -g rg-web-site-prod-cus -o json | ConvertFrom-Json | Where-Object name -eq 'RUNTIME_CONFIG_WRITER' | Select-Object name, value
```

```powershell
(az functionapp config appsettings list -n func-site-prod-cus-01 -g rg-web-site-prod-cus -o json | ConvertFrom-Json | Where-Object name -eq 'AzureWebJobsStorage' | Measure-Object).Count
```

An expected function missing, or an `AzureWebJobsStorage` count of `1`, is the
condition behind all three recorded incidents: every function missing on
2026-08-20, three timers on 2026-08-21. The mechanism is documented in
`infra/functionapp.tf` beside the azapi strip pair: `azurerm` writes an
`AzureWebJobsStorage` connection string with an empty account key on every write
to the site and never shows it in a plan, the host prefers it over the
identity-based setting, and every storage call then fails on the signature —
which presents as SyncTriggers not registering functions, not as a storage
error.

`RUNTIME_CONFIG_WRITER` should read `azapi-strip`. If it reads `azurerm`, the
strip did not complete and the app is running on the first write. When that
can happen, and why no Terraform ordering prevents it, is in
[Deployment runbook](deployment-runbook.md) §4 step 1.

The repair is to re-apply `infra/` so the strip runs again. **Do not delete the
setting by hand** — that hides the regression from the assertions in
`deploy-functions.yml` and `monitor-functions-registered.yml`, which are the
automated detectors this failure class has. When the strip's two reads are
healthy and functions are still missing, the strip is not the cause: the named
functions failed to start, and the host log says why.

## A failure an admin page names by its reference

An admin page that says `… (reference <id>)`, a stored failure such as a job's
`The job failed (ECONNRESET; reference <id>).`, and every failure answer's
`correlationId` all point at one log line. Since #945 that line is the only
record of the failure on the server, and it is content-free: the sentence the
code wrote, the error's class name, code, HTTP status, Cosmos substatus and
its cause's code, and up to three places in this repository's code
(`at=src/lib/jobs.js:657`). The error's message and its stack are not logged.

Paste the reference when the first command asks for it; the workspace is
looked up, not typed. PowerShell:

```powershell
$ref = Read-Host 'Reference from the admin page'; $ws = (az monitor log-analytics workspace show -n log-plat-prod-cus-01 -g rg-mgmt-plat-prod-cus --subscription sub-plat-mgmt-prod-cus -o json | ConvertFrom-Json).customerId; az monitor log-analytics query -w $ws --analytics-query "AppTraces | where TimeGenerated > ago(7d) | where Message startswith '[$ref]' | project TimeGenerated, SeverityLevel, Message" -o json | ConvertFrom-Json | Format-Table -Wrap
```

Success is a row for each failure logged under that reference, usually one,
whose `Message` reads `[<id>] <sentence> (name=… code=… at=…)`. An empty
result does not prove the line was never written: the reference may be older
than the seven days asked for (widen `ago(7d)`), or the failure may have
happened in a worker that had not yet sent its telemetry.

Most references are the function invocation's id, a GUID. For one of those,
every line that invocation wrote, the host's included, is the second command,
in the same window (it reuses `$ref` and `$ws`):

```powershell
az monitor log-analytics query -w $ws --analytics-query "AppTraces | where TimeGenerated > ago(7d) | where tostring(Properties.InvocationId) == '$ref' | order by TimeGenerated asc | project TimeGenerated, SeverityLevel, Message" -o json | ConvertFrom-Json | Format-Table -Wrap
```

A reference that is not a GUID is a caller's `x-correlation-id` or
`x-request-id` header, or the W3C traceparent; only the first query finds
those.

## Break-glass: storage after shared-key authentication is disabled

`shared_access_key_enabled = false` on both production storage accounts,
`stsiteprodcus01` (content and media) and `stsitefuncprodcus01` (Functions host
state and deployment packages), comes from `storage_shared_access_key_enabled`,
which **defaults to `false` on `main`** (`infra/variables.tf`,
`infra/storage.tf`).

> **Corrected 2026-09-07.** This paragraph credited the retired
> `fix/go-live-remediation` branch and asserted "**That apply has not run** —
> key access reads `true` on both accounts today". The branch is gone and the
> setting is on `main`, so the claim's basis no longer exists. Whether the
> apply has landed on the live accounts is a tenant read, not something this
> page can assert either way — take it from the accounts themselves before
> assuming you still have key access:
>
> ```powershell
> az storage account list -o json | ConvertFrom-Json | Where-Object { $_.name -in 'stsiteprodcus01','stsitefuncprodcus01' } | Select-Object name, resourceGroup, allowSharedKeyAccess
> ```
>
> `allowSharedKeyAccess: False` on both rows means everything below already
> applies. The two accounts sit in **different** resource groups —
> `stsiteprodcus01` in `rg-stor-site-prod-cus` and `stsitefuncprodcus01` in
> `rg-web-site-prod-cus` — which is why this reads the subscription and filters
> rather than passing one `-g`.

What follows describes the estate from that apply onward.

Nothing in the platform reads an account key. The Function App uses its managed
identity, the deploy workflow uploads with the deploy identity's Entra token,
and the media SAS the app hands out is a *user delegation* SAS, which Entra
authorizes and which is therefore unaffected — a service or account SAS would
have broken. The keys were two standing credentials no code path used.

**The first person to hit this will read it as an outage.** It is not. Azure
Storage answers a shared-key request on such an account with **HTTP 403** and an
error saying key-based authentication is not permitted, and two common operator
tools reach for shared key by default:

- `az storage` **data-plane** commands (`blob list`, `blob download`,
  `container list`, …) default to key authentication and will fail.
- The portal's **Storage Browser** chooses an authentication method for you and
  uses the account key when it can.

### The credential half

Add `--auth-mode login` to every `az storage` data-plane command, or export
`AZURE_STORAGE_AUTH_MODE=login` for the session. In the portal, switch the
authentication method to your Microsoft Entra account on the container blade.

```bash
export AZURE_STORAGE_AUTH_MODE=login
az storage container list --account-name stsitefuncprodcus01 --auth-mode login -o table
```

That alone is not enough. An Entra request needs a **data-plane** role, and the
control-plane roles an operator normally holds do not grant one: Owner,
Contributor and Storage Account Contributor gave access to data only because
they carry `listKeys`, which is precisely what has stopped mattering. Reading
blobs needs `Storage Blob Data Reader`; writing needs `Storage Blob Data
Contributor`. The configuration declares those roles for the Function App
identity and for the deploy identity, and **for no human** — the same posture as
`admin_object_ids` on Key Vault, where standing human access to production is
not treated as a steady state. Granting one to an operator is a role assignment,
so it is a change with a reviewer.

### The network half, which is the one that surprises

Fixing the credential does not make either account reachable from a laptop.

- **`stsitefuncprodcus01`** has an operator path: `functions_storage_admin_ip_rules`.
  Populate it, apply, do the work, empty it, apply again — the same
  populate/apply/work/empty pattern as the Key Vault and Cosmos admin variables.
- **`stsiteprodcus01`** has none. Its network rules are `default_action = "Deny"`
  with `bypass = ["AzureServices"]` and the Functions integration subnet, and
  there is no operator IP variable on it at all. Its data plane is not reachable
  from outside that subnet, with or without a key. Reaching it means changing
  code, and that is deliberate: public media is served through the Function
  App's identity at `GET /api/public/media/{container}/{*path}`, not by anyone
  browsing the account.

### What still works, unchanged

Control-plane commands — `az storage account show`, `az storage account update`,
`az storage account network-rule add/remove` — authorize through Azure RBAC and
are unaffected. That is why `deploy-functions.yml` still opens and closes its
per-run firewall window normally.

### Rollback

Set `storage_shared_access_key_enabled = true` in the `hcw-azure` workspace and
apply. One edit, both accounts. Reach for it if a deploy starts failing with an
authentication error against storage, or if the host stops cold-starting — and
note that the latter does **not** present as a storage failure; it presents as
404s on every route, which is the same signature as the section above.

Rolling back to debug an operator's own access is the wrong reason: that
re-enables two standing credentials nothing uses, to solve a problem
`--auth-mode login` and a role assignment solve properly.

## Related

- [Deployment Runbook](../runbooks/deployment-runbook.md) — §4 post-apply verification, §6
  day-2 operations
- [Cost analysis](../architecture/cost-analysis.md) — what the alert fabric and the daily cap cost
- [ADR 0022](../decisions/0022-alerting-fabric.md) — why these rules and not others, and the
  reachability trade
- `infra/observability.tf` — every threshold's stated assumption, beside the
  resource
