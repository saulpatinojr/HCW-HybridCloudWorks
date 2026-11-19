# Investigate: lab unit failed on arcs-lab-hybrid-prod-cus-01

Opened 2026-11-15. Updated 2026-11-19. Status: **still investigating**
(draft PR [#1731](https://github.com/saulpatinojr/HCW-HybridCloudWorks/pull/1731)).
The failed unit is narrowed down from the repository and GitHub, but **not yet
confirmed on the host**: the session that wrote this update had no Azure
sign-in and no SSH key, so it could not read the host or Log Analytics.

## What was seen

- **Sev2 `alert-lab-unit-failed-prod-cus`** fired on lab host
  `arcs-lab-hybrid-prod-cus-01` (`rg-mgmt-plat-prod-cus`) at:
  - **03:16 UTC Nov 14** (7:16 PM PT / 9:16 PM CT, Nov 13)
  - **03:16 UTC Nov 18** (7:16 PM PT, Nov 17)
  - **03:16 UTC Nov 19** (7:16 PM PT, Nov 18)
- No "resolved" email for any of them. That part is expected; see
  "Why there is never a resolved email" below.
- The alert means a watched systemd unit (a background service or timed job
  on the host) entered the failed state. This is the lab host, not the site.

## Related work

Issue [#1632](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1632)
(closed Nov 9) looked at the same alert chain. The nightly drift check
(`hcw-playbook-drift`) failed every night Nov 3–9 and no alert fired. The
chain is:

1. On the host, a unit that fails runs `hcw-unit-failed@<unit>.service` (its
   `OnFailure=` line), which writes one syslog line, tag `hcw-unit-failed`,
   text `unit <name> entered the failed state on <host>`.
2. The Azure Monitor Agent sends syslog to the `log-plat-prod-cus-01` Log
   Analytics workspace.
3. The alert rule
   ([`infra/lab-hybrid.tf` line 596](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/infra/lab-hybrid.tf#L596))
   looks every 15 minutes at the last hour and fires when it finds one or
   more of those lines.

The alert does fire now, so the chain works. The open question was which unit.

## Findings (2026-11-19)

### 1. The unit is almost certainly `hcw-playbook-drift`, not the four in the alert text

The alert's description names four services (Coder backup, labs agent,
Caddy, Vault), but that list is out of date. Twelve unit templates under
[`lab-host/ansible/roles`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/tree/main/lab-host/ansible/roles)
name the notifier in `OnFailure=` (found with
`grep -l "^OnFailure=hcw-unit-failed@"` on the `.service.j2` files).

The firing time is the strongest clue. All three alerts came at exactly
03:16 UTC. The host runs on UTC, and the alert checks at :01, :16, :31 and
:46 past each hour, so the failure line was written between 03:01 and 03:16
UTC each time. These are the timed jobs that report to the alert:

| Unit | Starts (UTC) | Could its failure fire at 03:16? |
| --- | --- | --- |
| `hcw-playbook-drift` (nightly drift check) | 03:00, plus up to 15 min random delay | **Yes**, the only one |
| `coder-postgres-backup` (nightly Coder backup) | 03:30, plus up to 10 min | No: earliest alert 03:31 |
| `hcw-vault-backup` (nightly Vault snapshot) | 03:45, plus up to 10 min | No: earliest alert 03:46 |
| `hcw-reboot-when-idle` | 04:30 | No |
| `hcw-coder-automation` | 05:45, plus up to 30 min | No |
| `hcw-held-upgradable` | 07:15, plus up to 15 min | No |

Read from the `.timer.j2` templates and each role's `defaults/main.yml`
under [`lab-host/ansible/roles`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/tree/main/lab-host/ansible/roles).

Two other possibilities could not be ruled out from here. A service such as
Caddy, Vault or the labs agent that keeps failing all day would also fire
the alert, and the alert's 6-hour mute would then space the emails 6 hours
apart (03:16, 09:16, 15:16, 21:16 UTC). Only one email a day was noticed,
which points away from this, but the emails at the other three times have
not been checked. The same goes for the two checks that run every 15
minutes, `hcw-portainer-check` and `hcw-workspace-reach` (which checks that a
lab workspace can reach Coder and the lab repository). The workspace check
deserves a look because of finding 3: it depends on the same lab job path
that failed on Nov 12.

### 2. The drift check exits non-zero whenever it finds drift, by design

The drift check runs the whole setup playbook in check mode (a dry run that
changes nothing). It exits 1 if the playbook fails and 2 if anything would
change
([`hcw-playbook-drift.sh.j2`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/lab-host/ansible/roles/hardening/templates/hcw-playbook-drift.sh.j2)).
systemd counts both as a failure, so drift on the host means one alert
every night.

On 2026-11-10 the owner ran it by hand and got exit 2, "2 change(s) would be
applied"
([#1631, last comment](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1631)).
[PR #1641](https://github.com/saulpatinojr/HCW-HybridCloudWorks/pull/1641)
fixed those two false changes, but its own Verification section says "Not
checked yet: a check-mode run on the host".

### 3. The last bootstrap of the host failed partway, on Nov 12

A bootstrap is a full run of `lab-host/bootstrap.sh`, which brings the host
up to date with a commit of this repository.

- Arc run
  [43174903868](https://github.com/saulpatinojr/HCW-HybridCloudWorks/actions/runs/43174903868)
  (bootstrap, 2026-11-12 07:23 UTC, commit `2a72d00`) **failed**. The play
  recap was `ok=419 changed=34 unreachable=0 failed=1`, and the one failed
  task was `privilege_checks : Refuse a host where a job cannot run through
  the proxy, or the proxy lets the wrong call through`. The full log is on
  the host at `/var/log/hcw-arc-run/bootstrap-20261112T072426Z.log`
  (readable by root only).
- Run
  [43306934816](https://github.com/saulpatinojr/HCW-HybridCloudWorks/actions/runs/43306934816)
  (Nov 12 21:06 UTC) was cancelled before it reached the host.
- Run
  [43323362633](https://github.com/saulpatinojr/HCW-HybridCloudWorks/actions/runs/43323362633)
  (Nov 12 22:49 UTC) has been **waiting for approval in the `lab-host-arc`
  environment for 7 days**. Which action it asks for is not shown until it
  runs.

What that leaves on the host:

- **The code folder moved but the host did not finish.** `bootstrap.sh`
  switches `/opt/hcw-src` to the new commit before the playbook runs
  ([`lab-host/bootstrap.sh` line 515](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/lab-host/bootstrap.sh#L515)).
  So `/opt/hcw-src` has been at `2a72d00` since Nov 12. The last *completed*
  bootstrap is still the older one (`e8724ae` on Nov 10, if nothing has run
  over SSH since; not checked). Every nightly drift check since then has
  compared the host with a commit that was only partly applied.
- **The failed task points at a real fault, not just drift.** It checks that
  a lab job, run as the labs agent's user through the agent's Docker proxy
  (the `hcw-labs-agent-docker-proxy` container, which lets the agent use
  only some Docker commands), prints its output. Its error message names the
  likely causes: the proxy's list of allowed calls, a missing lab image, or
  a proxy started before the Docker daemon last restarted, so it still holds
  the old socket. **Lab jobs may not be running.** That task is skipped in
  check mode, so the nightly drift check cannot see this fault.

### 4. Why there is never a "resolved" email

The rule is stateless on purpose: the alerting runbook calls it "stateless,
muted 6 h: the line is an event". Its Terraform block does not set
`auto_mitigation_enabled`, while most other lab rules in the same file set
it to `true`. So Azure never marks it resolved, and "no resolution" does not
mean the unit is still failing. Only the host can tell that.

### Not checked

- The host itself: `systemctl --failed`, the `hcw-unit-failed` and
  `hcw-playbook-drift` journal lines, the current commit in `/opt/hcw-src`.
  There was no SSH key and no Azure sign-in.
- The `hcw-unit-failed` rows in Log Analytics, which name the unit directly.
- Fired-alert history in Azure Monitor, including any emails at 09:16, 15:16
  or 21:16 UTC.
- What run 43323362633 is waiting to do.

## Confirm on the host (owner, about 5 minutes)

All commands are **PowerShell**, from the workstation that has the
`hcw-lab` SSH key and an `az login` session.

1. **Read the unit names from Log Analytics.** This shows every failure
   line from the past 7 days with its time:

   ```powershell
   $ws = (az monitor log-analytics workspace show -n log-plat-prod-cus-01 -g rg-mgmt-plat-prod-cus --subscription sub-plat-mgmt-prod-cus -o json | ConvertFrom-Json).customerId; az monitor log-analytics query -w $ws --analytics-query "Syslog | where TimeGenerated > ago(7d) | where tolower(_ResourceId) endswith '/providers/microsoft.hybridcompute/machines/arcs-lab-hybrid-prod-cus-01' | where ProcessName == 'hcw-unit-failed' | project TimeGenerated, SyslogMessage | order by TimeGenerated asc" -o json | ConvertFrom-Json | Format-Table -Wrap
   ```

   Success looks like rows such as `unit hcw-playbook-drift.service entered
   the failed state on ...`, each a few minutes after 03:00 UTC. If the rows
   name a different unit, or there are rows at other times of day, put that
   on this PR; the next fix step below changes.

2. **Read the live state on the host:**

   ```powershell
   ssh hcw-lab 'systemctl --failed --no-pager; sudo journalctl -t hcw-unit-failed --since 2026-11-12 --no-pager; sudo journalctl -t hcw-playbook-drift --since 2026-11-12 --no-pager; git -C /opt/hcw-src log -1 --format="%h %cI %s"; sudo grep ^completed_ /etc/hcw/bootstrap-host-accepted; sudo docker ps --filter name=hcw-labs-agent-docker-proxy --format "{{.Names}} {{.Status}}"'
   ```

   The expected output if the findings above are right: `hcw-playbook-drift.service`
   is listed as failed; its journal shows `playbook drift detected` or
   `playbook check failed` each night; `/opt/hcw-src` shows `2a72d00`; and
   `completed_commit` is older than that.

3. **See why the Nov 12 bootstrap failed.** This prints only the failed
   task's lines from the host's own log:

   ```powershell
   ssh hcw-lab 'sudo grep -A12 "Refuse a host where a job cannot run through the proxy" /var/log/hcw-arc-run/bootstrap-20261112T072426Z.log; sudo docker logs --tail 30 hcw-labs-agent-docker-proxy'
   ```

   If the proxy log shows `503 Service Unavailable` on forwarded calls, the
   proxy is holding the Docker daemon's old socket (cause 3 in the task's
   message).

## Next fix step

If steps 1 and 2 confirm `hcw-playbook-drift`:

1. **Fix the proxy fault behind the failed Nov 12 bootstrap first**, using
   what step 3 shows. If it is the stale-socket case, restarting the proxy
   container on its own is not the fix. The `labs_agent` role is meant to
   restart such a proxy, and the run still failed, so look into why that
   role's restart did not help.
2. **Then run one complete bootstrap to current `main`**, over SSH
   (`ssh hcw-lab "sudo /opt/hcw-src/lab-host/bootstrap.sh"`) or the Arc
   `bootstrap` action. Run
   [43323362633](https://github.com/saulpatinojr/HCW-HybridCloudWorks/actions/runs/43323362633),
   waiting since Nov 12, will bootstrap an older commit (`3d481df`), so
   cancel it instead of approving it.
3. **Start the drift check by hand and read its result:**

   ```powershell
   ssh hcw-lab 'sudo systemctl start hcw-playbook-drift.service; sudo journalctl -t hcw-playbook-drift --since -20min --no-pager'
   ```

   Success is `playbook check: no drift detected`. That also completes the
   "not checked yet" step in #1641's Verification section.
4. If it still reports drift, the task names it prints are the next ticket.
   Each one is either a real change the host is missing or a task that
   always looks changed in check mode, the same kind #1641 fixed.

## Discrepancy found

The alert's description
([`infra/lab-hybrid.tf` line 603](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/infra/lab-hybrid.tf#L603))
names only "the nightly Coder backup, the labs agent, Caddy or Vault". The
units that actually report to the alert also include the drift check, the
Coder automation, the Vault backup, the held-package report, the idle reboot,
the Portainer check, the host firewall and the workspace reach check. The
[alerting runbook's table](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/docs/runbooks/alerting-and-support.md)
is closer but is also missing the Portainer check, the host firewall and the
workspace reach check. Both look like oversights: neither was updated as
units were added. The out-of-date email text is why this investigation
started with the wrong four candidates. The fix is a one-line Terraform
change to the
`description`, saying "the line names the unit" and pointing to the runbook
table instead of listing the units, plus the three missing rows in the
runbook table. That goes in its own pull request (it changes `infra/`), not
this investigation one.

## Done when

- [ ] The failed unit is named in this doc, **confirmed from the host or Log
      Analytics** (step 1 or 2 above). Narrowed to `hcw-playbook-drift` from
      the firing times; not yet confirmed.
- [ ] Its root cause is fixed and the unit is healthy (a hand-started drift
      check prints `no drift detected`).
- [ ] A test failure on the host raises a fired alert visible in Azure Monitor
      within about 20 minutes (the #1632 done-when test).
