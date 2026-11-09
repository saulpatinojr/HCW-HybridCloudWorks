# Migration: `HCW-MigrateOrchestrator_App` and `HCW-MigrateOrchestrator_AddOn`

The first pair of the [App-to-AddOn program](README.md), and the first row the
site framed. Network and cloud assessment joined it on 2026-10-12.

| Fact | Value |
| --- | --- |
| Catalogue id | `migration` |
| Site route | `/tools/migration` (Tools menu: **Migration Hub**) |
| AddOn origin | `https://migration.lab.hybridcloudworks.com` (`panePath` `/`, `healthPath` `/api/health`) |
| Image | `docker.io/hybridcloudworks/img-mo-lab-addon`; the tag, the digest and the attestation identity are pinned in the `migration` row of `lab-host/ansible/group_vars/all.yml`, which is the one place they are written down. Since 2026-11-09 the row pins `v0.3.4`, index digest `sha256:41d8ce05c164b40527f438dcfdccce56a6575842ce2bc5c8d693051940a0a61d`, published by the AddOn's `publish-images.yml` on its `v0.3.4` tag ([run 42566459768](https://github.com/saulpatinojr/HCW-MigrateOrchestrator_AddOn/actions/runs/42566459768)); `gh attestation verify` exited 0 on 2026-11-09 and the signer is that workflow at `refs/tags/v0.3.4`. The release is a rebuild with no code change that picks up Debian's zlib fix for CVE-2026-76844 and CVE-2026-85091 ([#1600](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1600)). From 2026-11-05 to 2026-11-09 the row pinned `v0.3.3` (digest `sha256:7db831b3f348ce904c538881d744d8d6afa8d46f0aa4dddef913a4ecc16bf2e6`, [run 42161656096](https://github.com/saulpatinojr/HCW-MigrateOrchestrator_AddOn/actions/runs/42161656096)), which builds on Debian 13 (`node:26-trixie-slim`, apt 3.0.4) and clears the apt CVE-2026-109518 finding in the base image ([#1562](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1562)). Before that the row pinned `v0.3.2` (digest `sha256:bd3e0a164429984d50382368f9789d47ffa1af48061221041326a0bd0ed35ade`) from 2026-10-25. The host runs the new image once the owner re-runs the lab-host playbook. These dated lines record what was pinned when; the row stays the source for the current pin |
| Lab host port | `127.0.0.1:18081` → container `8080`, container `hcw-addon-migration` |
| Row status | `available`; capabilities granted to the pane `navigate` and `downloads` (ADR 0035 decision 9, confirmed by the owner on 2026-10-10) |
| Status proxy | `GET /api/public/addons/migration/status`, reading `ADDON_MIGRATION_URL` |
| Health `edition` | `demo` (an upstream constant; the site treats it as opaque) |
| Vault key | `vault_addon_migration_turnstile_secret` (the AddOn's own human-verification widget `hcw-addon-migration`, separate from the site's, created by the owner on 2026-10-11) |
| Pull requests | App: <https://github.com/saulpatinojr/HCW-MigrateOrchestrator_App/pull/15> (the `REFACTOR_APP.md` refactoring). AddOn: <https://github.com/saulpatinojr/HCW-MigrateOrchestrator_AddOn/pull/4> (the pane app, the standard health shape, configurable `frame-ancestors`, rate limiting, `v0.3.0`) |

## What the App keeps

The engine, the rule corpus, the `amo` CLI, the explorer UI components and the
Azure appliance edition (Container Apps, managed identity, Entra token
validation on every route). It publishes `@hybridcloudworks/migration-core`
and `@hybridcloudworks/migration-ui`; `azure-auth`, `azure-arm` and
`azure-execution` are never published, so the AddOn is technically unable to
reach Azure (its ADR-0028).

## What the AddOn is

The web-front edition: the CSV lab API, the pane app the site frames
(`apps/lab-web`), the browser e2e suite, the lab image and the
website-integration docs. It takes an uploaded inventory of up to 5 MB and
5,000 rows, holds at most 200 assessments in memory for 120 minutes, gates
every upload with its own human-verification widget, rate-limits per client
address (the first `X-Forwarded-For` value, since Caddy sets it), bounds
concurrent assessments at two, and answers the standard health envelope with
`X-Addon-Id` and `X-Addon-Version` on every response.

## The environment the host renders

From the AddOn's `docs/deployment/lab-host.md`, as the `migration` row's `env`
in `group_vars/all.yml`: `AMO_FRAME_ANCESTORS` and `AMO_SITE_ORIGINS` derived
from `caddy_frame_ancestors`, `AMO_TRUST_PROXY=1`, `AMO_TURNSTILE_SITE_KEY`
(public: the `hcw-addon-migration` widget's site key), `AMO_RATE_LIMIT_POSTS=10`,
`AMO_RATE_LIMIT_WINDOW_MINUTES=10`, `AMO_MAX_CONCURRENT=2`,
`AMO_ASSESSMENT_TTL_MINUTES=120`, `AMO_PUBLIC_BASE_URL`, `AMO_ALLOWED_ORIGINS`
empty, `AMO_TELEMETRY=0`, `AMO_WORKSPACE_PROVIDER=disabled`; `TURNSTILE_SECRET`
from the vault key.

## Owner steps

In the [Labs host runbook](../../runbooks/labs-host.md), "Tool add-ons":
create the widget, seed the secret, write the digest and site key in, run
`bootstrap.sh`, and read `http://127.0.0.1:18081/api/health` over SSH.
