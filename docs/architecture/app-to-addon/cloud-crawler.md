# Cloud Crawler: `HCW-CloudCrawler_App` and `HCW-CloudCrawler_AddOn`

The fourth pair of the [App-to-AddOn program](README.md). Its catalogue row is
`coming` since 2026-10-24: the page at `/tools/cloud-crawler` renders the
explainer, nothing is framed, and no app setting, `group_vars` row or CSP
entry exists for it yet. The site-side row was added when the pair was
introduced, ahead of a release, the same way the network and cloud assessment
rows were.

| Fact | Value |
| --- | --- |
| Catalogue id | `cloud-crawler` |
| Site route | `/tools/cloud-crawler` (not in the Tools menu while `coming`) |
| AddOn origin (reserved) | `https://cloud-crawler.lab.hybridcloudworks.com` |
| Image (reserved) | `docker.io/hybridcloudworks/img-cc-lab-addon` (the AddOn's `publish-images.yml` publishes it on `v*` tags) |
| Lab host port | not assigned; "the next free port is the website's call" (the AddOn's ADR 0003). The Cloud Assessor uses 18083. |
| Row status | `coming`; capabilities to be granted `navigate`, `downloads` |
| Status proxy | `GET /api/public/addons/cloud-crawler/status`, reading `ADDON_CLOUD_CRAWLER_URL` (not declared until the row is `available`; the proxy answers `{ configured: false }`) |
| Settings prefix | `CC_` (the AddOn's `.env.example`) |
| Vault key (reserved) | `vault_addon_cloud_crawler_turnstile_secret` (the AddOn's ADR 0003) |
| Pull requests | App: <https://github.com/saulpatinojr/HCW-CloudCrawler_App>; AddOn: <https://github.com/saulpatinojr/HCW-CloudCrawler_AddOn> |

## Where it stands, read on 2026-10-24

- **The App has not released.** There is no tag and no GitHub Release; `v0.1.0`
  was prepared on 2026-10-21 and not tagged (the AddOn's
  `docs/whats-new-upstream.md`, which records how it was checked).
- **The AddOn is a skeleton.** It has the lab application skeleton, the edition
  boundary, content-free logging, the upload and rate limits and a flat
  `/api/health`; it pins no engine yet and has published no image (no tag, no
  release). Its `core-update.yml` does nothing until the App releases.
- **The site side is only the row.** The catalogue row, the server registry
  entry, the route and the explainer page. Everything below "Flipping the row
  to `available`" is still to do, and none of it can start before there is an
  image to pin.

## What the App keeps

The Cloud Crawler engine (`cloud-crawler-core`) and the App edition, which runs
on Azure Container Apps beside an Azure MCP Server under a managed identity or
on-behalf-of authentication. The engine is seeded and versioned in the App and
adopted unchanged by the AddOn when the App releases.

## What the AddOn is

The lab edition. It **collects evidence but never fetches it**: a visitor
uploads an Azure Resource Graph export, an azqr report or Terraform
artifacts; it validates, hashes, redacts and normalises them, runs
deterministic drift detectors against the decision records in the session, and
answers with evidence, drift findings, draft decision records and review
proposals. Everything lives in memory and expires after two hours. It is
technically unable to reach Azure: no cloud SDK is installed, it refuses to
start if `azure`, `msal` or `boto3` can be imported or if any Azure identity
variable is set, and its health answer reports `azureConnectivity:
"disabled-by-design"`. Its README also describes a lab chat path in which the
site hands it evidence it obtained on the visitor's behalf; that path is
planned, not built, and would be reached by the site's Function App over https
exactly as `/api/health` is.

## Flipping the row to `available`

When the App has released, the AddOn has adopted the engine and published its
first image, one pull request, as for the
[migration](migration.md) and [cloud assessment](cloud-assessment.md) rows:

- the row's `status` (and remove `comingSince` and `comingReason`);
- `ADDON_CLOUD_CRAWLER_URL` in `infra/functionapp.tf`;
- a `group_vars/all.yml` row with the image digest, a free loopback port, the
  `CC_` environment and the attestation identity;
- the origin in `frame-src` (`frontend/staticwebapp.config.json`);
- the owner's widget and vault key, per the [Labs host
  runbook](../../runbooks/labs-host.md), "Tool add-ons".

The AddOn's `docs/website-integration/` guide should be written in the same
change set as the AddOn's first release; the other three AddOns have one.
