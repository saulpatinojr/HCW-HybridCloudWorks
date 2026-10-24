# Cloud assessment: `HCW-CloudAssessor_App` and `HCW-CloudAssessor_AddOn`

The third pair of the [App-to-AddOn program](README.md). Its catalogue row has
been `available` since 2026-10-12 (#1089): `/tools/cloud-assessment` frames the
AddOn and the Tools menu lists it. Until then the row was `coming`.

| Fact | Value |
| --- | --- |
| Catalogue id | `cloud-assessment` |
| Site route | `/tools/cloud-assessment` (in the Tools menu) |
| AddOn origin | `https://cloud-assessment.lab.hybridcloudworks.com` (`panePath` `/`, `healthPath` `/api/health`) |
| Image | `docker.io/hybridcloudworks/hcw-addon-cloud-assessment`; the tag, the digest and the attestation identity are pinned in the `cloud-assessment` row of `lab-host/ansible/group_vars/all.yml`, which is the one place they are written down |
| Lab host port | `127.0.0.1:18083` → container `8080` |
| Row status | `available`; capabilities granted to the pane `navigate` and `downloads` |
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
