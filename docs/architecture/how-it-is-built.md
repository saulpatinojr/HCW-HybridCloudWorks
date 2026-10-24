# How HybridCloudWorks is built

The engineering picture behind [hybridcloudworks.com](https://hybridcloudworks.com):
what runs where, what each folder of the repository holds, how to run the
pieces locally, and how a change is tested and delivered. The repository's
[README](../repo/readme.md) is the shorter introduction for someone new to the
project.

## The platform

The public pages are React, pre-rendered at build time and served by Azure
Static Web Apps. The site's data and its background jobs go through one Azure
Functions app, which keeps the data in Cosmos DB and Azure Storage and reads
its secrets from Key Vault. Cloudflare is the DNS for the domain and proxies
the API hostname only; the site and the docs resolve straight to Azure and
GitHub Pages. A lab host outside Azure runs the browser labs, the lab job
runner and the tool add-ons, and reports to Azure through Azure Arc.

![How HybridCloudWorks is built: the browser, Cloudflare, the Azure application and management subscriptions, Microsoft Entra ID, the lab host, GitHub and the AI providers, with the requests and data between them](../assets/architecture/hcw-architecture.svg)

The diagram is drawn in draw.io with the official Azure icons; its source is
[`docs/assets/architecture/hcw-architecture.drawio`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/docs/assets/architecture/hcw-architecture.drawio).
Edit that file in draw.io and export it again as SVG, rather than editing the
SVG.

The same picture in words:

- The browser loads pages from Azure Static Web Apps and calls the API at
  `api-azure.hybridcloudworks.com`, the one hostname Cloudflare proxies.
- The API is a single Azure Functions app on the Flex Consumption plan: HTTP
  routes, timers, a queue worker and Cosmos DB change-feed handlers. It uses
  its managed identity for Cosmos DB, Storage and Key Vault, and calls AI
  model providers (Microsoft Foundry and third-party model APIs) for the
  content features.
- Admins sign in with Microsoft Entra ID, and the API checks their tokens on
  every admin call.
- The lab host runs Coder, whose workspaces open in panes on the site;
  `vps-agent`, which polls the API for lab jobs and runs each one in a
  container with no network; and the tool add-ons, each a hardened container
  behind Caddy that the site frames at `/tools/<id>`.
- A Cloudflare Worker checks the API's health every five minutes and reports
  each result to Application Insights, where an alert watches it.
- Every page carries a Cloudflare Web Analytics beacon, built in at deploy
  time when the `CF_WEB_ANALYTICS_TOKEN` repository variable is set, so that
  the site can state a monthly audience figure (owner decision 2026-10-20,
  #1302: the Docker Captain application goes in on the Thought Leader track,
  and the Microsoft MVP form asks for impact metrics). It counts page views
  with no cookies, no client-side state and no fingerprinting, and the site is
  created with Cloudflare's lite option, which asks Cloudflare not to measure
  visitors in the EU — documented for the snippet Cloudflare's proxy injects,
  unverified for the hand-placed one this site carries until the owner has
  confirmed it on the site's Manage page in the Web Analytics dashboard — so
  the figure is aggregate page views, read as a floor. Nothing is shown to
  visitors: once a day the `ambassadorAudienceMonthly` timer reads the
  previous month's total back from Cloudflare's GraphQL Analytics API with a
  read-only token, adds the show's downloads from Podbean, and records one
  evidence row per programme in the Ambassador hub, once per month.

| Layer | Technology |
| --- | --- |
| Website | React 19, Vite, Tailwind CSS and React Router, pre-rendered at build time |
| Hosting | Azure Static Web Apps |
| API and background jobs | Azure Functions (Flex Consumption) on Node.js 24 |
| Data | Azure Cosmos DB (serverless), Azure Blob and Queue Storage |
| Identity and secrets | Microsoft Entra ID, managed identities, Azure Key Vault |
| Edge | Cloudflare DNS, proxy and a Worker probe |
| Observability | Application Insights, Log Analytics and Azure Monitor alerts |
| Infrastructure as code | Terraform, planned and applied in HCP Terraform |
| Lab host | Ubuntu 26.04 on a Hostinger VPS, configured with Ansible: Docker, Caddy, Coder, the tool add-ons and Azure Arc |
| Delivery | GitHub Actions on GitHub-hosted runners, signing in to Azure with OIDC |
| Documentation | MkDocs with the Material theme, on GitHub Pages |

The reasoning behind each choice is in the
[architecture decision records](../decisions/index.md).

## Repository map

| Path | What it holds | Read more |
| --- | --- | --- |
| [`frontend/`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/tree/main/frontend) | The public website and the admin portal: React, Vite, the pre-renderer, unit tests and Playwright browser tests | [ADR 0007](../decisions/0007-static-first-frontend.md) |
| [`functions/`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/tree/main/functions) | The Azure Functions API: HTTP routes, timers, the queue worker, change-feed handlers and their tests | [ADR 0019](../decisions/0019-single-function-app.md) |
| [`infra/`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/tree/main/infra) | Terraform for the Azure estate and the Cloudflare records in front of it | [README](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/infra/README.md) |
| [`infra-lab/`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/tree/main/infra-lab) | Terraform that adopts the lab host and writes its DNS records | [README](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/infra-lab/README.md) |
| [`lab-host/`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/tree/main/lab-host) | Ansible that configures the lab host: hardening, Docker, Caddy, Coder, the job runner, the tool add-ons and Azure Arc | [README](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/lab-host/README.md) |
| [`lab-image/`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/tree/main/lab-image) | The `hcw-lab` container images that lab jobs and workspaces run in, published to Docker Hub | [README](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/lab-image/README.md) |
| [`vps-agent/`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/tree/main/vps-agent) | The lab job runner: polls the API, runs each job in a sandboxed container and reports the result | [Labs host](labs-host.md) |
| [`edge/`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/tree/main/edge) | The Cloudflare Worker that probes the API's availability | [Availability probe](../runbooks/availability-probe.md) |
| [`scripts/`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/tree/main/scripts) | Operations tooling and its tests: deployment smoke checks, monitors, alert fire tests, content manifests, restore and bootstrap scripts, the docs-site build hook, and tests that hold workflows and Terraform to the repository's rules | — |
| [`docs/`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/tree/main/docs) | The documentation source: decisions, architecture, runbooks, standards, articles and history | [This site](../index.md) |
| [`.github/`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/tree/main/.github) | Workflows, issue and pull request templates, and the contributing, security, support and conduct policies | [CONTRIBUTING](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/.github/CONTRIBUTING.md) |
| [`.azure/`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/tree/main/.azure) | Machine-readable contracts: the API surface the website depends on, and the approved infrastructure plan | — |
| [`.vscode/`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/tree/main/.vscode) | The Azure Functions dev loop for VS Code: tasks that start the Functions host and a launch configuration that attaches the debugger | — |
| [`.qlty/`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/tree/main/.qlty) | Configuration for Qlty, which reports maintainability and coverage | — |
| `.claude/`, `hooks/`, `tooling/` | The agent harness that Claude Code sessions in this repository use | — |

At the root, [CHANGELOG.md](../repo/changelog.md) records completed work,
[TODO.md](../repo/todo.md) records the accepted risks, and `mkdocs.yml`
configures this site. Open work is tracked as
[GitHub issues](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues)
and on the [HCW Work Board](https://github.com/users/saulpatinojr/projects/6).

## Run it locally

You need Git and Node.js 26 with npm 10 or later. The API in `functions/`
runs on Node.js 24, the newest line Azure Functions Flex Consumption
supports. This site needs Python 3.14, infrastructure work needs Terraform
1.16, and the lab image needs Docker. The oldest release of each that the
repository accepts is in `scripts/version-floors.json`, which a weekly
workflow re-checks, and CI fails a pin below it.

Each Node.js package installs and tests the same way, from its own directory:

| Package | Node.js | Install | Test | Also run by CI | Start locally |
| --- | --- | --- | --- | --- | --- |
| `frontend/` | 26 | `npm ci` | `npm test` | `npm run lint`, `npm run format:check`, `npm run build` | `npm run dev` |
| `functions/` | 24 | `npm ci` | `npm test` | `npm run lint` | `npm start` |
| `scripts/` | 26 | `npm ci` | `npm test` | `npm run lint` | — |
| `vps-agent/` | 26 | `npm ci` | `npm test` | — | `npm start` |
| `edge/availability-probe/` | 26 | `npm ci` | `npm test` | — | — |
| `lab-host/coder/` | 26 | — (no dependencies, so no lockfile) | `npm test` | `bash compose-config-check.sh`, and `terraform fmt`, `init` and `validate` on the workspace template | — |

A few packages need more than that:

- **Website.** For a session that talks to an API and lets you sign in,
  copy `frontend/.env.example` to `frontend/.env` and fill in its values.
  Every `VITE_` variable is built into the public bundle, so never put a
  secret in one. The Playwright browser suites run with `npm run test:e2e`
  after `npx playwright install chromium`.
- **API.** `npm start` runs `func start`, which needs
  [Azure Functions Core Tools](https://learn.microsoft.com/azure/azure-functions/functions-run-local)
  and a `functions/local.settings.json` copied from
  `local.settings.json.example`. The example points at local storage and
  Cosmos DB emulators.
- **Lab job runner.** `npm start` runs `node index.js`, which reads the
  variables named in `vps-agent/.env.example` from its environment. They
  include the agent's own Entra identity and certificate, so in practice it
  runs on the lab host as a service, and its tests are the way to work on it
  elsewhere.
- **Infrastructure.** Plans and applies run only in HCP Terraform. The
  formatting, validation and test checks you can run without credentials are
  in [infra/README.md](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/infra/README.md)
  and [infra-lab/README.md](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/infra-lab/README.md).
- **Lab host and lab image.** The playbook runs on the lab host itself, as
  [lab-host/README.md](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/lab-host/README.md)
  explains. The images build with Docker and carry their own smoke tests,
  listed in [lab-image/README.md](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/lab-image/README.md).

### This documentation site

The site builds from `docs/` with the pinned MkDocs in
`scripts/docs/requirements.txt`. From the repository root, in PowerShell:

```powershell
python -m pip install -r scripts/docs/requirements.txt
```

```powershell
python scripts/docs/check_redaction.py
```

```powershell
mkdocs build --strict
```

`mkdocs serve` previews it locally. The build also publishes the README, the
changelog and the TODO file, so links in them are written relative to the
repository root and work both on GitHub and here.

## How a change is tested and delivered

Every pull request runs these workflows, all on GitHub-hosted runners:

- **CI** ([`ci.yml`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/.github/workflows/ci.yml)):
  a lockfile-strict install and the tests for each Node.js package, plus that
  package's own checks from the table above (lint for `frontend/`,
  `functions/` and `scripts/`, and the format check and build for
  `frontend/` alone); ansible-lint, a syntax check and the role tests for the
  lab host; checks for the Coder workspace template; tests for the agent
  harness; and the Playwright browser suites as an advisory job. A job whose
  component did not change skips its heavy steps and still reports.
- **CodeQL** for JavaScript and TypeScript, GitHub Actions and Python.
- **IaC Validation**: `terraform fmt`, `terraform validate`, TFLint and a
  Trivy misconfiguration scan for `infra/` and `infra-lab/`.
- **Repository Policy**: the layout and documentation rules in
  `scripts/validate-repository-structure.ps1`, and the Pester tests for the
  PowerShell scripts.
- **Dependency review**, **Coverage** and **Complexity Delta**.
- **Docs site**, when documentation changes: the redaction gate and
  `mkdocs build --strict`.
- **Publish lab image**, when the lab image or what it depends on changes: a
  build and smoke test of both images.

Delivery always involves a person. The site and the API deploy through
workflows that are started by hand and sign in to Azure with OIDC rather than
a stored credential. Terraform changes are planned in HCP Terraform and
applied only after someone reviews the plan. This site deploys to GitHub
Pages when a merge to `main` changes `docs/`, `mkdocs.yml`, `scripts/docs/`,
the README, the changelog, the TODO file or the workflow itself. Scheduled
workflows watch delivery health, unresolved secrets, published pages, alert
rules and pinned versions. When the delivery-health check goes red, the
Functions app also sends a Telegram message, so a deploy left waiting is not
missed ([how it works](../runbooks/alerting-and-support.md#the-delivery-monitor-speaks-on-telegram)).

### The site's security policy is finished at build time

`frontend/staticwebapp.config.json` commits the website's
Content-Security-Policy with no `'unsafe-inline'` and no scheme-wide image
grant (AP-F11, #935). The site is static, so no request can carry a nonce;
instead two scripts run after every `npm run build`, and the deploy ships
what they produce rather than the committed file:

- [`stage-swa-config.mjs`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/frontend/scripts/stage-swa-config.mjs)
  hashes every inline style the pre-rendered pages carry and writes the
  hashes into the staged copy: one `'sha256-…'` per distinct `<style>` body
  in `style-src`, and one per distinct `style` attribute value in
  `style-src-attr 'unsafe-hashes' …`. Styles React sets at runtime go
  through the CSSOM, which no policy governs, so hydration and client-side
  navigation need nothing more.
- [`check-image-hosts.mjs`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/frontend/scripts/check-image-hosts.mjs)
  reads every image the pages, the stylesheets and the article bodies
  reference and fails the build when one comes from a host `img-src` does
  not name, so the list cannot drift silently.

**Measured 2026-10-15** on the 230 HTML documents of one build: 2 `<style>`
elements with one distinct body (the privacy and terms pages share it);
2,969 `style` attributes with 80 distinct values, from the header's
navigation grid (`grid-column` and `grid-template-columns`, on every page),
the code highlighter's token colours, framer-motion's initial states, the
hero carousel's fades, the certification pages' glows, the home page's hub
colours and the tables of one published article. 1,210 image references:
1,193 relative, 6 `data:` PNGs in two article bodies, 7 on Microsoft's
blog and Learn hosts and one article's hotlink, and 4 on the retired
Firebase bucket, which the gate reports and tolerates until the two pages
stop naming it.

The hosts the About, speaking-events and audio pages fetch at runtime are
not in a build, and CI cannot reach the API through Cloudflare's bot
protection. Inventoried the same day from the public API: Credly and
Microsoft Learn badges, one badge each on a CloudFront distribution and on
iconape.com (re-host those two through the admin's certification editor and
drop their entries from `img-src`), the show's artwork on
`pbcdn1.podbean.com`, and nothing live for the speaking events, whose
stored copies are on the retired bucket.

To repeat the build-time measurement after `npm run build`, from
`frontend/`:

```powershell
node scripts/stage-swa-config.mjs; node scripts/check-image-hosts.mjs
```

A successful run prints the inline-style counts, then one row per image
origin with its count, and ends with `every image host the build ships is
in img-src`. For the runtime data, from a workstation (a GitHub runner is
challenged):

```powershell
foreach ($p in 'snapshots/certifications','snapshots/speakerevents','podcasts','content') { (Invoke-WebRequest -UserAgent 'Mozilla/5.0' "https://api-azure.hybridcloudworks.com/api/public/$p").Content | Select-String -Pattern 'https?://[A-Za-z0-9.-]+/[^"\\]*\.(png|jpe?g|svg|webp|gif)' -AllMatches | ForEach-Object { $_.Matches.Value } | ForEach-Object { ([uri]$_).Host } | Sort-Object -Unique }
```

Every host it prints is either in `img-src`, or the retired bucket, or is
a new one that needs an entry with its reason here.
