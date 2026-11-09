# Network assessment: `HCW-NetworkEyes_App` and `HCW-NetworkEyes_AddOn`

The second pair of the [App-to-AddOn program](README.md). Its catalogue row has
been `available` since 2026-10-12 (#1089): `/tools/network-assessment` frames
the AddOn and the Tools menu lists it. Until then the row was `coming`.

| Fact | Value |
| --- | --- |
| Catalogue id | `network-assessment` |
| Site route | `/tools/network-assessment` (in the Tools menu) |
| AddOn origin | `https://network-assessment.lab.hybridcloudworks.com` (`panePath` `/`, `healthPath` `/api/health`) |
| Image | `docker.io/hybridcloudworks/img-ne-lab-addon`; the tag, the digest and the attestation identity are pinned in the `network-assessment` row of `lab-host/ansible/group_vars/all.yml`, which is the one place they are written down. Since 2026-11-09 the row pins `v0.1.3`, index digest `sha256:a7d77470c9f965da019696b7e30b25007b7c98b348c3fc4f38ea47855c6bf6b2`, published by the AddOn's `publish-images.yml` on its `v0.1.3` tag ([run 42563530777](https://github.com/saulpatinojr/HCW-NetworkEyes_AddOn/actions/runs/42563530777)); `gh attestation verify` exited 0 on 2026-11-09 and the signer is that workflow at `refs/tags/v0.1.3`. The release carries engine 0.1.5 (an upload whose resource names contain a hedge word no longer fails; rule set `2026.11.1`). From 2026-11-05 to 2026-11-09 the row pinned `v0.1.2` (digest `sha256:b8818f7a25610da372d0744f2b0584ccbea5d91a60518d02b68a48fbda99f381`), which cleared the apt CVE-2026-109518 finding ([#1562](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1562)). Before that the row pinned `v0.1.0` (digest `sha256:202bc43bba9b8842bc9594c1dbe203ff636fddf3514d4255b8a60aabcb60aa77`) from 2026-10-12; `v0.1.1` (2026-10-27) was never pinned. The host runs the new image once the owner re-runs the lab-host playbook |
| Lab host port | `127.0.0.1:18082` → container `8080` |
| Row status | `available`; capabilities granted to the pane `downloads` and `clipboard-write` (owner decision 2026-10-24, [#1354](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1354); the row held `navigate` and `downloads` before, copied from the migration row, although this AddOn never sends a `navigate` message) |
| Status proxy | `GET /api/public/addons/network-assessment/status`, reading `ADDON_NETWORK_ASSESSMENT_URL` (a plain app setting in `infra/functionapp.tf`) |
| Health `edition` | `lab`. Read from the live status route on 2026-10-24: configured, reachable, version 0.1.0. |
| Settings prefix | `NA_` |
| Vault key | `vault_addon_network_assessment_turnstile_secret` (the AddOn's own human-verification widget) |
| Site backend it calls | the lab host's Coder, to start a guided lab workspace: `CODER_URL` and `CODER_TEMPLATE_ID=na-guided-lab` in its `group_vars` row, and the `workspace` capability in its health answer |
| Pull request | App: <https://github.com/saulpatinojr/HCW-NetworkEyes_App/pull/179> (the `REFACTOR_APP.md` refactoring) |

## What the App keeps

The Cloud Network Assessment core and its Azure appliance edition, which
reads a tenant's network estate under a managed identity. The retired
`HCW-NetworkEyes_App` repository's history lives in `Work-Cloud_Network_Core`;
the appliance work is in the per-cloud appliance repositories.

## What the AddOn is

A Python lab edition: an uploaded Azure Resource Graph export of network
resources, assessed for topology, segmentation and exposure, held in memory
for two hours, with no cloud SDK in the image and a startup refusal under any
identity endpoint. It follows the standard's health envelope, headers, pane
protocol, limits and hardening, with the `NA_` environment prefix.

## How the row was flipped

One pull request (#1089): the row's `status`, `ADDON_NETWORK_ASSESSMENT_URL`
in `infra/functionapp.tf`, a `group_vars` row with the image digest and the
widget's site key, and the origin in `frame-src`, with the owner's widget and
vault key, as the [migration record](migration.md) and the
[runbook](../../runbooks/labs-host.md) describe.

As of 2026-10-24 the AddOn's own `docs/website-integration/` guide still
carries a copy of the catalogue row from before the flip (status `coming`, a
different title and pane path). The site's row in
`frontend/src/data/addons/catalogue.js` is the one that counts.
