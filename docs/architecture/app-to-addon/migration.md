# Migration: `HCW-AzMigrateOrchestrator_App` and `HCW-AzMigrateOrchestrator_Addon`

The first pair of the [App-to-AddOn program](README.md), and the one row the
site frames today.

| Fact | Value |
| --- | --- |
| Catalogue id | `migration` |
| Site route | `/tools/migration` (Tools menu: **Migration Hub**) |
| AddOn origin | `https://migration.lab.hybridcloudworks.com` (`panePath` `/`, `healthPath` `/api/health`) |
| Image | `docker.io/hybridcloudworks/hcw-addon-migration`, tag `0.3.0`, pinned by digest in `lab-host/ansible/group_vars/all.yml`: `sha256:175622db4d7029902b68e8e51f8132f78e5247e219944031f00dc2fdc814aa83`, the `v0.3.0` image index, attestation verified (2026-10-11) |
| Lab host port | `127.0.0.1:18081` → container `8080`, container `hcw-addon-migration` |
| Row status | `available`; capabilities granted to the pane `navigate` and `downloads` (ADR 0035 decision 9, confirmed by the owner on 2026-10-10) |
| Status proxy | `GET /api/public/addons/migration/status`, reading `ADDON_MIGRATION_URL` |
| Health `edition` | `demo` (an upstream constant; the site treats it as opaque) |
| Vault key | `vault_addon_migration_turnstile_secret` (the AddOn's own human-verification widget `hcw-addon-migration`, separate from the site's, created by the owner on 2026-10-11) |
| Pull requests | App: <https://github.com/saulpatinojr/HCW-AzMigrateOrchestrator_App/pull/15> (the `REFACTOR_APP.md` refactoring). AddOn: <https://github.com/saulpatinojr/HCW-AzMigrateOrchestrator_Addon/pull/4> (the pane app, the standard health shape, configurable `frame-ancestors`, rate limiting, `v0.3.0`) |

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
