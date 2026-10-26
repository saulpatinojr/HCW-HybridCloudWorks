# Cloud Crawler: `HCW-CloudCrawler_App` and `HCW-CloudCrawler_AddOn`

The fourth pair of the [App-to-AddOn program](README.md). Its catalogue row was
`coming` from 2026-10-24 and is `available` from the second of the two pull
requests for [#1357](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1357):
`/tools/cloud-crawler` frames the AddOn and the Tools menu lists it, from the
day the owner deploys the site (the website is deployed by hand, so merging is
not enough). The first
pull request ([#1411](https://github.com/saulpatinojr/HCW-HybridCloudWorks/pull/1411))
made the host able to run the container and the site's backend able to reach it,
and the row stayed `coming` until the container ran and the status route
answered. The site-side row was added when the pair was introduced, ahead of a
release, the same way the network and cloud assessment rows were.

| Fact | Value |
| --- | --- |
| Catalogue id | `cloud-crawler` |
| Site route | `/tools/cloud-crawler` (in the Tools menu once the site is deployed) |
| AddOn origin | `https://cloud-crawler.lab.hybridcloudworks.com` (the wildcard `*.lab` name resolves to the lab host's address; read from a public resolver on 2026-10-26) |
| Image | `docker.io/hybridcloudworks/img-cc-lab-addon:v0.2.0`, index digest `sha256:5a43c90bda9bed1d3472847f492b7c05405e6a6ce2d4aa7f4d9b519bb72daf28` (linux/amd64), published by the AddOn's `publish-images.yml` on its `v0.2.0` tag ([run 40318349978](https://github.com/saulpatinojr/HCW-CloudCrawler_AddOn/actions/runs/40318349978)); the build attestation verifies against `HCW-CloudCrawler_AddOn` and the signer is that workflow at `refs/tags/v0.2.0` |
| Lab host port | `18084` on `127.0.0.1` (the website's call, per the AddOn's ADR 0003; the next after the Cloud Assessor's 18083) |
| Lab host row | in `lab-host/ansible/group_vars/all.yml` since [#1411](https://github.com/saulpatinojr/HCW-HybridCloudWorks/pull/1411); the host runs it: the owner reported running the playbook on 2026-10-26 and a session read the container's health through the status route afterwards (below). The steps are [the runbook's](../../runbooks/labs-host.md#cloud-crawler-the-host-steps) |
| Row status | `available`; the pane is granted `downloads` and `clipboard-write`, not `navigate` (why, below the table) |
| Status proxy | `GET /api/public/addons/cloud-crawler/status`, reading `ADDON_CLOUD_CRAWLER_URL` (a plain app setting in `infra/functionapp.tf`, applied by the owner's HCP Terraform run). On 2026-10-26 (its `asOf` was 16:06Z) it answered `configured: true, reachable: true`, version 0.2.0, edition `lab`, with the upload capabilities listed in the AddOn's guide |
| Settings prefix | `CC_` (the AddOn's `.env.example`) |
| Vault key | `vault_addon_cloud_crawler_turnstile_secret` (the AddOn's ADR 0003); the owner states it is in the host's vault, which no session can read. Whether it pairs with the widget's site key is proved only by one real upload (below) |
| Pull requests | App: <https://github.com/saulpatinojr/HCW-CloudCrawler_App>; AddOn: <https://github.com/saulpatinojr/HCW-CloudCrawler_AddOn> |

**Why the pane gets `downloads` and `clipboard-write` and not `navigate`.** The
rule is that a pane is granted what it uses (website issue
[#1354](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1354)). The
pane's own code (`web/app.js` and `web/index.html` in the AddOn, read on
2026-10-26) saves the report and the sample files through download links and a
file made in the browser, which needs `downloads`; it copies the report with the
clipboard's write call, which needs `clipboard-write` and never the read call;
and it has no code that sends a `navigate` message, opens a window or changes the
page's address. It sends the site only its own state (`loading`, `ready`,
`working`, `unavailable`).

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
- **The host runs it.** The owner reported running the vault check and the
  lab-host playbook on 2026-10-26; [a session's note on #1357](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1357#issuecomment-6420765765)
  records it (the pasted `PLAY RECAP` showed the run completed, and the host
  recorded commit `cab8bcc4`). HCP Terraform's commit status on the merge commit
  of #1411 read Success that day, and a session then read the status route
  (`configured: true, reachable: true`, version 0.2.0) and the pane's address,
  which answers with `X-Addon-Id: cloud-crawler` and a `frame-ancestors` that
  allows the pane itself and the site's two origins only. The vault key and the
  certificate were not read by any session. The status answer and the pane's
  headers show the container started and the name is served over a certificate
  the site's backend accepts. The key was not empty (the playbook stops
  otherwise), but whether it is the right secret for the widget is not known
  until the first real upload (below).
- **Terraform reading is not in this image, so the row does not promise it.**
  The upload accepts a Terraform state or plan, but the engine 0.1.0 does not
  read it, so a claim about Terraform stays `unknown` (the AddOn's `docs/api.md`,
  "The upload"). The row's first summary said "or your Terraform"; the flip
  removes those words and the `terraform` entry from the row's `technology`
  list. **Restore both when the AddOn ships an engine that reads Terraform**
  (the engine change is merged upstream,
  [HCW-CloudCrawler_App#60](https://github.com/saulpatinojr/HCW-CloudCrawler_App/pull/60)
  for [#54](https://github.com/saulpatinojr/HCW-CloudCrawler_App/issues/54),
  but the App has no release after `v0.1.0` and the AddOn has not taken a new
  engine). The AddOn tracks this as
  [HCW-CloudCrawler_AddOn#29](https://github.com/saulpatinojr/HCW-CloudCrawler_AddOn/issues/29),
  and its integration guide holds the same row, field by field.
- **Not verified by any session when the row was flipped:** the pane inside the
  site's frame in a real browser (the empty state and the theme), and one real
  upload with the human check, which is the only thing that proves the
  widget's secret pairs with its site key. Both are the owner's first
  checks after the deploy
  ([the runbook](../../runbooks/labs-host.md#cloud-crawler-the-first-real-upload)).

## What the App keeps

The Cloud Crawler engine (`cloud-crawler-core`) and the App edition, which runs
on Azure Container Apps beside an Azure MCP Server under a managed identity or
on-behalf-of authentication. The engine is seeded and versioned in the App and
adopted unchanged by the AddOn when the App releases.

## What the AddOn is

The lab edition. It **collects evidence but never fetches it**: a visitor
uploads an Azure Resource Graph export (a Terraform state or plan is
accepted too, but the engine this version runs does not read it); it validates,
hashes, redacts and normalises it, runs
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

## How the row was flipped

The migration and cloud assessment rows flipped in one pull request
([migration](migration.md), [cloud assessment](cloud-assessment.md)). Here it
took two, so that the public catalogue never said `available` before the
container ran (owner decision of 2026-10-26, written on
[#1357](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1357) when
the first pull request was opened).

**First pull request,
[#1411](https://github.com/saulpatinojr/HCW-HybridCloudWorks/pull/1411) (the host
side; the row stayed `coming`):**

- a `group_vars/all.yml` row with the image digest, the loopback port 18084, the
  `CC_` environment and the attestation identity;
- `vault_addon_cloud_crawler_turnstile_secret` in the vault-key table
  (`lab-host/README.md`) and the runbook's list of keys set by hand (the count
  of keys is stated in both and changed);
- `ADDON_CLOUD_CRAWLER_URL` in `infra/functionapp.tf`, declared in
  `scripts/assert-expected-plan.mjs` as exactly one added app setting;
- the owner's steps after the merge: the HCP Terraform run, the playbook run on
  the host and the status check ([the runbook](../../runbooks/labs-host.md#cloud-crawler-the-host-steps)).

**Second pull request (after the status route answered `configured: true,
reachable: true`):**

- the row's `status` set to `available` (`comingSince` and `comingReason`
  removed), `capabilities` set to what the pane uses (`downloads` and
  `clipboard-write`) and the summary and `technology` worded for what the lab
  does today (above);
- the origin in `frame-src` and in the three delegations of `Permissions-Policy`
  (`frontend/staticwebapp.config.json`), with the tests that list the available
  origins (`catalogue.test.js`, `csp.test.js`) and every count of available
  rows moved from three to four;
- in the AddOn's repository, `docs/website-integration/integration-guide.md`
  ("Where it stands", the Image row, the loopback port and the pasted row),
  whose pasted row and loopback port the weekly drift check holds equal to the
  site's ([the runbook](../../runbooks/addon-guide-drift.md));
- what the review of the first pull request asked for: a test title and the
  API surface note that still said the setting was not provisioned; the
  `scripts (operations)` path filter in `.github/workflows/ci.yml` (the list of
  changed files that makes that CI job run), which now includes the registry
  file that `assert-expected-plan.test.mjs` reads; and the plan check's entry
  for `ADDON_CLOUD_CRAWLER_URL`, deleted now that the setting is applied, as its
  own comment said to do.

`lab-host/` is not touched by the second pull request on purpose: the site
counts every commit under `lab-host/` that merges after the host's last
playbook run as "the host is behind" (`functions/src/lib/labs/drift.js`), so a
wording change there would ask the owner for a playbook run that changes
nothing.
