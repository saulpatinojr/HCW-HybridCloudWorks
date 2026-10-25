# Network assessment: `HCW-NetworkEyes_App` and `HCW-NetworkEyes_AddOn`

The second pair of the [App-to-AddOn program](README.md). Its catalogue row has
been `available` since 2026-10-12 (#1089): `/tools/network-assessment` frames
the AddOn and the Tools menu lists it. Until then the row was `coming`.

| Fact | Value |
| --- | --- |
| Catalogue id | `network-assessment` |
| Site route | `/tools/network-assessment` (in the Tools menu) |
| AddOn origin | `https://network-assessment.lab.hybridcloudworks.com` (`panePath` `/`, `healthPath` `/api/health`) |
| Image | `docker.io/hybridcloudworks/img-ne-lab-addon`; the tag, the digest and the attestation identity are pinned in the `network-assessment` row of `lab-host/ansible/group_vars/all.yml`, which is the one place they are written down |
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
