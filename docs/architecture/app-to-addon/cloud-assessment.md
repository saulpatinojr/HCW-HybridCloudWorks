# Cloud assessment: `HCW-CloudAssessor_App` and `HCW-CloudAssessor_AddOn`

The third pair of the [App-to-AddOn program](README.md). Its catalogue row has
been `available` since 2026-10-12 (#1089): `/tools/cloud-assessment` frames the
AddOn and the Tools menu lists it. Until then the row was `coming`.

| Fact | Value |
| --- | --- |
| Catalogue id | `cloud-assessment` |
| Site route | `/tools/cloud-assessment` (in the Tools menu) |
| AddOn origin | `https://cloud-assessment.lab.hybridcloudworks.com` (`panePath` `/`, `healthPath` `/api/health`) |
| Image | `docker.io/hybridcloudworks/img-ca-lab-addon`; the tag, the digest and the attestation identity are pinned in the `cloud-assessment` row of `lab-host/ansible/group_vars/all.yml`, which is the one place they are written down. Since 2026-11-05 the row pins `v0.1.2`, index digest `sha256:8865ecf3115bbdeb8581ef2597290bee5e162b9dc23d5c34f5c1d3c5b1cd404c`, published by the AddOn's `publish-images.yml` on its `v0.1.2` tag ([run 42129319030](https://github.com/saulpatinojr/HCW-CloudAssessor_AddOn/actions/runs/42129319030)); `gh attestation verify` exited 0 on 2026-11-05 and the signer is that workflow at `refs/tags/v0.1.2`. The release clears the apt CVE-2026-109518 finding in the base image ([#1562](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1562)). Before that the row pinned `v0.1.0` (digest `sha256:d51be5be6496588d84bc56f843aa45971fab576bf4ee0d14968fd496888d551b`) from 2026-10-12; `v0.1.1` (2026-10-27) was never pinned. The host runs the new image once the owner re-runs the lab-host playbook |
| Lab host port | `127.0.0.1:18083` → container `8080` |
| Row status | `available`; capabilities granted to the pane `downloads` and `clipboard-write` (owner decision 2026-10-24, [#1354](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1354); the row held `navigate` and `downloads` before, copied from the migration row, although this AddOn never sends a `navigate` message) |
| Status proxy | `GET /api/public/addons/cloud-assessment/status`, reading `ADDON_CLOUD_ASSESSMENT_URL` (a plain app setting in `infra/functionapp.tf`) |
| Health `edition` | `lab`. Read from the live status route on 2026-10-24: configured, reachable, version 0.1.0. |
| Settings prefix | `CA_` |
| Vault key | `vault_addon_cloud_assessment_turnstile_secret` (the AddOn's own human-verification widget) |
| Site backend it calls | none in its `group_vars` row |
| Pull request | App: <https://github.com/saulpatinojr/HCW-CloudAssessor_App/pull/5> (the `REFACTOR_APP.md` refactoring) |

## What the App keeps

The Cloud Assessor's Azure appliance edition. The assessment engine
(`packages/cloud-assessor-core`: a declarative criteria catalogue, severity
and pillar weights, evaluator kinds, with unknown lowering coverage and never
score) is seeded in the AddOn repository and moves upstream unchanged (the
AddOn's ADR-0001).

## What the AddOn is

A Python 3.14 FastAPI lab edition: an uploaded Azure Resource Graph export
assessed against the criteria catalogue, scored by pillar, held in memory for
at most 120 minutes with owner-token isolation, with no cloud SDK in the
image and a startup refusal under any identity endpoint, and a
`NOT-AN-AUDIT.md` in every bundle. It follows the standard's health envelope,
headers, pane protocol, limits and hardening, with the `CA_` environment
prefix.

## How the row was flipped

One pull request (#1089): the row's `status`, `ADDON_CLOUD_ASSESSMENT_URL` in
`infra/functionapp.tf`, a `group_vars` row with the image digest and the
widget's site key, and the origin in `frame-src`, with the owner's widget and
vault key, as the [migration record](migration.md) and the
[runbook](../../runbooks/labs-host.md) describe.

As of 2026-10-24 the AddOn's own `docs/website-integration/` guide still
carries a copy of the catalogue row from before the flip (status `coming`, a
different title and pane path). The site's row in
`frontend/src/data/addons/catalogue.js` is the one that counts.
