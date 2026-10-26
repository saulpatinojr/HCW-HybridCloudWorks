# Cloud Crawler: `HCW-CloudCrawler_App` and `HCW-CloudCrawler_AddOn`

The fourth pair of the [App-to-AddOn program](README.md). Its catalogue row is
`coming` since 2026-10-24: the page at `/tools/cloud-crawler` renders the
explainer and nothing is framed. The host side is prepared (2026-10-26,
[#1357](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1357)): a
`group_vars` row for the published image, the vault key documented, and the
Function App setting declared. The row stays `coming`, and no CSP entry exists,
until the container runs on the host and the status route answers; that is the
second pull request ("Flipping the row to `available`", below). The site-side
row was added when the pair was introduced, ahead of a release, the same way the
network and cloud assessment rows were.

| Fact | Value |
| --- | --- |
| Catalogue id | `cloud-crawler` |
| Site route | `/tools/cloud-crawler` (not in the Tools menu while `coming`) |
| AddOn origin | `https://cloud-crawler.lab.hybridcloudworks.com` (the wildcard `*.lab` name resolves to the lab host's address; read from a public resolver on 2026-10-26) |
| Image | `docker.io/hybridcloudworks/img-cc-lab-addon:v0.2.0`, index digest `sha256:5a43c90bda9bed1d3472847f492b7c05405e6a6ce2d4aa7f4d9b519bb72daf28` (linux/amd64), published by the AddOn's `publish-images.yml` on its `v0.2.0` tag ([run 40318349978](https://github.com/saulpatinojr/HCW-CloudCrawler_AddOn/actions/runs/40318349978)); the build attestation verifies against `HCW-CloudCrawler_AddOn` and the signer is that workflow at `refs/tags/v0.2.0` |
| Lab host port | `18084` on `127.0.0.1` (the website's call, per the AddOn's ADR 0003; the next after the Cloud Assessor's 18083) |
| Lab host row | in `lab-host/ansible/group_vars/all.yml` since #1357; **not run by the host yet**, so no container exists until the owner's playbook run ([the runbook's steps](../../runbooks/labs-host.md#cloud-crawler-the-host-steps)) |
| Row status | `coming`; capabilities to be granted `downloads` and `clipboard-write`, not `navigate` (the AddOn's guide, read 2026-10-26: the pane saves and copies a report and never asks to navigate) |
| Status proxy | `GET /api/public/addons/cloud-crawler/status`, reading `ADDON_CLOUD_CRAWLER_URL`, declared in `infra/functionapp.tf` since #1357 and applied by the owner's HCP Terraform run; until it applies the proxy answers `{ configured: false }` |
| Settings prefix | `CC_` (the AddOn's `.env.example`) |
| Vault key | `vault_addon_cloud_crawler_turnstile_secret` (the AddOn's ADR 0003); the owner states it is in the host's vault, which no session can check |
| Pull requests | App: <https://github.com/saulpatinojr/HCW-CloudCrawler_App>; AddOn: <https://github.com/saulpatinojr/HCW-CloudCrawler_AddOn> |

## Where it stands, read on 2026-10-26

- **The App has released.** [`v0.1.0`](https://github.com/saulpatinojr/HCW-CloudCrawler_App/releases/tag/v0.1.0)
  was released on 2026-10-26 and the AddOn adopted its engine unchanged.
- **The AddOn has an image with the upload route.** `v0.1.0` (engine adopted,
  no upload route) and `v0.2.0` (the first with the upload route) are on Docker
  Hub; only `v0.2.0` is pinned here, because a row that promises an upload
  needs an image that can take one. The digest and the attestation check are in
  [the tracking issue](https://github.com/saulpatinojr/HCW-CloudCrawler_AddOn/issues/17#issuecomment-6415375789)
  and were re-checked for #1357 (`gh attestation verify` exited 0, and the
  signing certificate names `publish-images.yml` at `refs/tags/v0.2.0`). The
  AddOn's GitHub Release pages for `v0.1.0` and `v0.2.0` were published on
  2026-10-26 ([releases](https://github.com/saulpatinojr/HCW-CloudCrawler_AddOn/releases)).
- **Terraform reading is not in this image.** The upload accepts a Terraform
  state or plan, but the engine 0.1.0 does not read it, so a claim about
  Terraform stays `unknown` (the AddOn's `docs/api.md`, "The upload"). The row's
  summary says "or your Terraform", which promises more than this image does:
  the second pull request has to decide that wording before the row says
  `available`.
- **The host side is prepared and not run.** The `group_vars` row, the vault-key
  documentation and the Function App setting are in #1357's first pull request;
  nothing has been applied, and the container does not exist. Not verified by
  any session: that the vault key is set on the host, that the certificate
  covers the name (the other three names prove the wildcard pattern), and that
  the container starts and answers.
- **The site side is still only the row.** The catalogue row, the server
  registry entry, the route and the explainer page. The flip is in the second
  pull request.

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

The migration and cloud assessment rows flipped in one pull request
([migration](migration.md), [cloud assessment](cloud-assessment.md)). Here it is
two, so that the public catalogue never says `available` before the container
runs (owner decision of 2026-10-26, written on
[#1357](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1357) when
the first pull request was opened).

**First pull request (the host side; the row stays `coming`):**

- a `group_vars/all.yml` row with the image digest, the loopback port 18084, the
  `CC_` environment and the attestation identity;
- `vault_addon_cloud_crawler_turnstile_secret` in the vault-key table
  (`lab-host/README.md`) and the runbook's list of keys set by hand (the count
  of keys is stated in both and changed);
- `ADDON_CLOUD_CRAWLER_URL` in `infra/functionapp.tf`, declared in
  `scripts/assert-expected-plan.mjs` as exactly one added app setting;
- the owner's steps after the merge: the HCP Terraform run, the playbook run on
  the host and the status check ([the runbook](../../runbooks/labs-host.md#cloud-crawler-the-host-steps)).

**Second pull request (after the status route answers `configured: true,
reachable: true`):**

- the row's `status` (and remove `comingSince` and `comingReason`), with
  `capabilities` set to what the pane uses and the summary wording settled
  (above);
- the origin in `frame-src` (`frontend/staticwebapp.config.json`), and in
  `Permissions-Policy` if the row gets `clipboard-write`, with the tests that
  list the available origins (`catalogue.test.js`, `csp.test.js`) and any test
  that counts available rows;
- in the AddOn's repository, `docs/website-integration/integration-guide.md`
  ("Where it stands", the Image row, the loopback port and the pasted row),
  whose pasted row and (once it states one) loopback port the weekly drift
  check holds equal to the site's.
