# Investigate: lab unit failed on arcs-lab-hybrid-prod-cus-01

Date: 2026-11-15. Status: investigating (draft PR).

## What was seen

- **Sev2 `alert-lab-unit-failed-prod-cus`** fired **03:16 UTC Nov 14**
  (9:16 PM CT Nov 13) on lab host `arcs-lab-hybrid-prod-cus-01`
  (`rg-mgmt-plat-prod-cus`). Still open, no resolution email as of Nov 15
  evening.
- A watched systemd unit failed — one of the nightly Coder backup, the labs
  agent, Caddy, or Vault. This is the lab host, not the site itself.

## Related work

Issue #1632 (closed Nov 9) investigated the same alert chain:
`hcw-playbook-drift.service` failed every night Nov 3–9, but the alert never
fired — the signal was lost somewhere between the failed unit and the alert.
The chain, as documented there:

1. On the host, `OnFailure=hcw-unit-failed@%n.service` writes a syslog line
   tagged `hcw-unit-failed`.
2. The Azure Monitor Agent's data collection rule sends syslog to
   `log-plat-prod-cus-01`.
3. The alert runs every 15 minutes on that syslog tag and fires on a count
   above 0. The rule is `azurerm_monitor_scheduled_query_rules_alert_v2
   .lab_hybrid_unit_failed` in `infra/lab-hybrid.tf`.

This time the alert **did** fire, so the chain works. What is still unknown is
**which unit failed** on the night of Nov 13–14.

## What to check

1. On the host, find the failed unit for the night of Nov 13–14
   (`systemctl --failed`, journal around 03:16 UTC Nov 14). Is it
   `hcw-playbook-drift` again, or a different unit?
2. Confirm the unit is healthy now; if it is still failing, fix the
   underlying cause (not just restart it).
3. Confirm the `hcw-unit-failed` notifier line reached Log Analytics for this
   event, closing the loop on #1632.

## Done when

- [ ] The failed unit is named in this doc.
- [ ] Its root cause is fixed and the unit is healthy.
- [ ] A test failure on the host raises a fired alert visible in Azure Monitor
      within about 20 minutes (the #1632 done-when test).
