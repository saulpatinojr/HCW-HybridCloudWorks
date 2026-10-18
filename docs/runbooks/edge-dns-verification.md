# Edge and DNS verification — the four checks after a change at the edge

> **Status: in use.** Moved here from issue #357 on the owner's instruction:
> a checklist that can never close is not a ticket. The four checks and their
> success criteria are unchanged from the issue. The run log at the bottom
> replaces the issue's dated comments, and the 2026-09-07 run is seeded there
> as the first entry so the format is demonstrated rather than described.

**Scope:** four read-only checks that say whether the public site and the
public API still answer after something at the edge moved. Every command below
is a read; nothing here changes anything.

**Authority:** this page does not authorize a change. It is what you run after
one.

## When this comes due

Only on a trigger. There is no schedule, and adding one would be the wrong
instrument — the Worker probe of [ADR 0024](../decisions/0024-edge-availability-probe.md)
already asks `/api/health` every five minutes, and these checks exist to catch
what a change just did, not to watch for drift.

Run all four after any of:

- **a DNS change** in the `hybridcloudworks.com` zone, whether from an apply of
  `infra/frontend.tf` or by hand in the Cloudflare dashboard;
- **a Cloudflare rule change** — the origin-secret transform rule, a WAF or
  rate-limiting rule, Bot Fight Mode, or a plan change that makes any of those
  available;
- **a Static Web App custom-domain change**, including a re-validation of the
  apex;
- **a Functions custom-domain change**, including a rebind of
  `api-azure.hybridcloudworks.com`.

Taking a baseline before an unrelated apply is a legitimate second use — the
2026-09-07 run below was one — but it is not required, and such a run is
recorded with its trigger stated as none.

## Read this first: only one hostname is proxied

The obvious expectation — Cloudflare in front of the whole zone — is wrong
here, and an operator holding it will raise a finding on every single run.

| Hostname | Answers from | Proxied | Declared in |
| --- | --- | :---: | --- |
| `hybridcloudworks.com` (apex) | Azure, the Static Web App | no | not Terraform-managed |
| `www.hybridcloudworks.com` | Azure, CNAME into `azurestaticapps.net` | no | not Terraform-managed |
| `api-azure.hybridcloudworks.com` | Cloudflare | **yes** | `infra/frontend.tf`, `cloudflare_dns_record.azure_functions` |
| `docs.hybridcloudworks.com` | GitHub Pages | no | `infra/frontend.tf`, `cloudflare_dns_record.docs_pages` |
| `podcast.hybridcloudworks.com` | Podbean, CNAME to `pbcdn2.podbean.com` | no | `infra/frontend.tf`, `cloudflare_dns_record.podcast_podbean` |
| `asuid.api-azure.hybridcloudworks.com` | nothing — a TXT record holding Azure's ownership proof | n/a | `infra/frontend.tf`, `cloudflare_dns_record.azure_functions_domain_verification` |

`infra/frontend.tf` declares exactly four Cloudflare records, and ADR 0024
names `api-azure` in as many words as *the one proxied hostname*. Three things
about that table are deliberate rather than oversight:

- **The apex and `www` are not in Terraform.** A Static Web App root domain
  validates against a token Azure generates when the validation starts, so
  pinning one in state would drift the moment Azure reissued it. They are
  created by hand, per
  [cutover runbook step 3b](../history/cutover-runbook.md#3b-custom-domains-on-the-static-web-app).
- **`docs` is DNS-only.** GitHub issues and renews a Pages certificate by
  checking that the CNAME resolves to `*.github.io`; a proxied record answers
  with Cloudflare's addresses instead, and the domain sticks at "certificate
  pending".
- **`podcast` is DNS-only, and a subdomain.** Podbean provisions the
  certificate for the show's website the same way. Its "Use a domain I own"
  page prefills `www`. A CNAME there would hand the site to the podcast host.
  The podcast takes `podcast.hybridcloudworks.com`, never `www` or the apex.

So the apex resolving to Azure, answering with **no** `CF-RAY` header, and
presenting a **DigiCert**-issued certificate is the design. **An apex behind
the Cloudflare proxy is the finding, not an apex in front of it.**

Issue #357 originally said success looked like *"DNS resolves to Cloudflare,
not directly to Azure"*. Measured against the zone as a whole, that has never
been true and was never meant to be. The 2026-09-07 run corrected it, and this
section is
that correction: the old wording would have read as a red result on every
future run, which is how a checklist becomes something people stop running.

## The four checks

PowerShell, from the owner's workstation. **Not from a cloud VM, a GitHub
runner or a hosted shell** — Cloudflare's Bot Fight Mode answers datacenter
clients with a 403 interstitial, which is a reporting failure that looks
exactly like an outage. That is the whole reason the availability probe is a
Cloudflare Worker (ADR 0024), and why `scripts/check-unresolved-secrets.mjs`
reads ARM rather than asking `/api/health`.

### 1. DNS resolves the way the split says it should

```powershell
'hybridcloudworks.com','www.hybridcloudworks.com','api-azure.hybridcloudworks.com','podcast.hybridcloudworks.com' | ForEach-Object { Resolve-DnsName -Name $_ } | Select-Object Name, Type, IPAddress, NameHost
```

```powershell
'https://hybridcloudworks.com/','https://api-azure.hybridcloudworks.com/api/health','https://podcast.hybridcloudworks.com/' | ForEach-Object { $r = Invoke-WebRequest -Uri $_ -UseBasicParsing; [pscustomobject]@{ Url = $_; Status = [int]$r.StatusCode; Server = ($r.Headers['Server'] -join ','); CfRay = ($r.Headers['CF-RAY'] -join ',') } }
```

`-UseBasicParsing` is deliberate and is not there for PowerShell 7, where it
does nothing at all — measured on 7.6.5, it is accepted silently, with no
deprecation warning and no effect. It is there for **Windows PowerShell 5.1**,
which still ships with Windows and is what `powershell.exe` starts: without the
flag, `Invoke-WebRequest` parses the response with the Internet Explorer
engine, and on a host where IE's first-run configuration has never been
completed it throws instead of returning. That failure names the browser
engine, not the site, so it reads as the site being down when nothing is wrong
— which is precisely the reporting failure this runbook exists to prevent.
Costing nothing in the shell you are probably using and saving a false alarm in
the other one, it stays.

**Success.** The apex returns an `A` record outside Cloudflare's ranges and
`www` returns a `CNAME` into `*.azurestaticapps.net`; neither answer carries a
`CF-RAY` header or `Server: cloudflare`. `api-azure` returns two `A` records
inside `104.16.0.0/13` and `172.64.0.0/13` — both published Cloudflare ranges —
plus `AAAA` records, and it answers with `Server: cloudflare` and a `CF-RAY`.
`podcast` returns a `CNAME` to `pbcdn2.podbean.com` and answers with no
`CF-RAY`, because it is DNS-only and Podbean serves it. Until the domain is
entered in Podbean and its certificate is issued, that HTTPS request fails: an
unfinished setup, not an outage. Key on the ranges and the headers, never on a
literal address: the Static Web App's address is Azure's to change.

If the headers are ambiguous, confirm the certificate in a browser at
<https://hybridcloudworks.com/>. The padlock should show `CN=hybridcloudworks.com`
issued by DigiCert on a GeoTrust chain — the Static Web App's managed
certificate, not a Cloudflare edge certificate.

**Not a failure.** A disagreement within a few minutes of a DNS change is
propagation, not drift. `Resolve-DnsName` reads the local client cache first,
so run `Clear-DnsClientCache` and try again, then ask a public resolver
directly:

```powershell
'hybridcloudworks.com','www.hybridcloudworks.com','api-azure.hybridcloudworks.com' | ForEach-Object { Resolve-DnsName -Name $_ -Server 1.1.1.1 } | Select-Object Name, Type, IPAddress, NameHost
```

Give it the record's TTL before calling it a finding: five minutes on the
unproxied records Terraform manages, whatever the Cloudflare dashboard shows on
the hand-made apex and `www`, and less than that on `api-azure`, which is
TTL-automatic because a proxied record accepts no other value.

### 2. The site answers

```powershell
(Invoke-WebRequest -Uri 'https://hybridcloudworks.com/' -Method Head).StatusCode
```

**Success:** `200`.

**How it fails, and what each failure means.** PowerShell throws on a non-2xx
rather than printing the number, so a failure arrives as a red exception —
read `StatusCode` off its response before concluding anything. A
`404` immediately after a custom-domain change is the Static Web App binding
still validating, not the site being down. A `403` here would be Cloudflare,
and that is itself the finding, because the apex is not supposed to be proxied
at all.

### 3. The API is healthy

```powershell
Invoke-RestMethod -Uri 'https://api-azure.hybridcloudworks.com/api/health'
```

**Success:** `status` is `ok`, `service` is `hcw-functions`, and
`unresolvedSecrets` is **2**. `generation` names the CI run and commit that
stamped the running configuration, which is worth comparing against the deploy
you just made when the trigger was a Functions change.

**`unresolvedSecrets: 2` is the healthy answer, and an operator who does not
know that will chase it.** The count is Key Vault references that arrived as
the literal `@Microsoft.KeyVault(…)` string instead of a resolved secret. Two
findings, one setting: Azure surfaces every app setting twice, plain and
`APPSETTING_`-prefixed, so a single unresolved reference reads as two. The
setting is `AZURE_SPEECH_KEY`, and `scripts/check-unresolved-secrets.mjs`
carries it in `EXPECTED_UNRESOLVED` with the reason — Azure AI Speech is the
written, tested fallback TTS path, deliberately unprovisioned because standing
one up is a spend decision nobody has made.

Any other number is actionable. Which references are unresolved is deliberately
not in this anonymous response; the names are on the authenticated Integrations
page at <https://hybridcloudworks.com/admin/integrations>, and Actions →
**Monitor Unresolved Secrets** answers the same question from ARM without
traversing Cloudflare at all.

That page, not Ops Health. This line used to point at `/admin/ops-health`,
which never carried the names: `getOpsHealthSnapshot` returns readiness, the
digest, alerts and operational signals, and nothing about secrets. The names
come from `cms/secrets`, which is the credential surface — the old API Keys
page, now merged into Integrations. There an unresolved reference shows the
same gray **Not set** light as a secret nobody ever seeded, because
`computeSecretState` cannot tell the two apart from inside the worker: both
mean `process.env` is holding the literal `@Microsoft.KeyVault(…)` string or
nothing at all.

**A 404 on every route is not a DNS or edge failure**, though it presents like
one. It is the Functions host answering with no functions registered, or App
Service finding no site bound to `api-azure.hybridcloudworks.com`. Both have
the same signature, and neither is fixed here — see
[Alerting and support](../runbooks/alerting-and-support.md#the-failure-with-no-alert).

### 4. A public read returns data, not a challenge

```powershell
Invoke-RestMethod -Uri 'https://api-azure.hybridcloudworks.com/api/public/podcasts?provider=azure&limit=1' | ConvertTo-Json -Depth 3
```

**Success:** JSON with `success` true. `items: []` and `total: 0` is a **pass** —
no feed is configured yet, which is a content question and not an edge one.
What this check asks is whether an anonymous caller reaches the application at
all.

**HTML instead of JSON** is a Cloudflare challenge page: Bot Fight Mode has
decided the caller is a datacenter client. Re-run from the workstation before
treating it as an outage.

**A 403 on every anonymous request** — the whole public API refusing, not one
route — is the origin lock, and it means the shared secret is out of step. It
has to match in three places at once:

1. the `cloudflare_origin_secret` workspace variable in HCP Terraform,
   <https://app.terraform.io/app/hcw/workspaces/hcw-azure/variables>;
2. Key Vault `CF-ORIGIN-SECRET` in `kv-site-prod-cus-01`, which the Function
   App reads as the `CF_ORIGIN_SECRET` app setting (`infra/functionapp.tf`);
3. the Cloudflare transform rule that stamps `x-hcw-origin-secret`
   (`cloudflare_ruleset.origin_secret` in `infra/frontend.tf`).

The third is written by Terraform from the first, so the repair is to make (1)
and (2) agree and re-apply — never to edit the rule in the Cloudflare
dashboard, which the next apply would overwrite. Check when the vault side last
moved, without the value ever reaching the screen (`secret list` returns
metadata only, no values):

```powershell
az keyvault secret list --vault-name kv-site-prod-cus-01 -o json | ConvertFrom-Json | Where-Object { $_.name -eq 'CF-ORIGIN-SECRET' } | Select-Object name, @{n='updated';e={$_.attributes.updated}}
```

`TODO.md` carries this as an accepted risk with the same consequence stated:
the value must change in all three places in one window, and a partial rotation
is a **full outage of the public API** rather than a degradation. See
[TODO and accepted risks](../repo/todo.md).

## The daily DNS audit

The four checks above run on a trigger. Between triggers, one thing watches
the zone itself: the
[Cloudflare DNS audit](https://github.com/saulpatinojr/HCW-HybridCloudWorks/actions/workflows/cloudflare-dns-audit.yml)
workflow, added 2026-10-18 as the LAB-1 interim (#948). The lab host's Caddy
holds a token with DNS edit on `hybridcloudworks.com` until a dedicated lab
zone exists ([ADR 0032](../decisions/0032-learner-labs-platform.md)), and
Cloudflare has no notification type for audit-log or DNS-record events on any
plan, so a poller of the account audit log stands in for the notification
that does not exist.

**What it checks.** Daily at 05:50 UTC, `scripts/cloudflare-dns-audit.mjs`
reads the account audit log (Audit Logs v2,
`GET /accounts/{account_id}/logs/audit`, paged through in full) from two
hours before the workflow's previous successful **scheduled** run — never
less than 26 hours back, never more than 14 days, and 26 hours when there is
no previous success — so a failed or missed run widens the next window
rather than leaving a gap. Manual runs (`workflow_dispatch`) never move that
resume point, so a narrow `since` by hand cannot hide the time before it; a
longer outage is read in manual windows, each judged on its own. It keeps the
create, update and delete events on DNS records in the production zone, and
judges each against the allowlist at the top of the script. Anything the
allowlist does not name is UNEXPECTED. A run that could not read the log
fails, on purpose: a quiet run means the window was read and every change
was expected, never that the token was missing.

**The allowlist, and how to extend it.** Three entries, each with its reason
beside it in the script:

| Entry | Allows | Identified by |
| --- | --- | --- |
| `hcp-terraform` | every DNS-record action by the HCP Terraform workspace's token | the token name `hcp-terraform-cloudflare-dns` in the entry's `actor.token_name` |
| `caddy-acme` | the Caddy runtime token, **only** on a `TXT` record named `_acme-challenge.<lab name>` (`_acme-challenge.lab.hybridcloudworks.com` or `_acme-challenge.coder.lab.hybridcloudworks.com`); an A record from it, or a challenge for `www`, is the finding the poller exists for | the token name in the `CLOUDFLARE_CADDY_TOKEN_NAME` repository variable |
| `owner-dashboard` | the owner's own edits in the Cloudflare dashboard (the apex and `www` records are hand-made by design, above) | a `dash` session whose e-mail is the `CLOUDFLARE_DNS_AUDIT_OWNER_EMAIL` repository variable; the owner's API tokens are not this entry |

An entry whose variable is unset is inactive, and the report says so: its
edits then read UNEXPECTED, which costs an issue to read and never a missed
edit. A new legitimate actor is a new entry with its reason, added to
`ALLOWLIST` in `scripts/cloudflare-dns-audit.mjs` with a case in
`scripts/cloudflare-dns-audit.test.mjs`, in a reviewed pull request; an
existing entry is never widened in place.

**What it needs.** The `CLOUDFLARE_AUDIT_LOG_TOKEN` repository secret, a
Cloudflare API token with *Account → Account Settings → Read* on the one
account and nothing else (that is the permission the audit-log endpoint
accepts; the token catalogue has no separate audit-log read), and the
`CLOUDFLARE_ACCOUNT_ID` repository variable. Optional: `CLOUDFLARE_ZONE_ID`
(the zone is matched by name regardless), and the two allowlist variables
above. All four are in
[Required inputs](../standards/required-inputs.md), §4.2 and §4.3.

**Running it by hand.** Open the workflow page linked above → **Run
workflow**; leave `since` and `before` empty for the default window, or set
either as `YYYY-MM-DD` or an RFC3339 timestamp (UTC) to read a wider or older
window, up to the 18 months Cloudflare retains. Untick `open_issue` while
tuning the allowlist: the run then only reports, and for each UNEXPECTED
change the summary adds the shape of the entry (the actor's field names as
Cloudflare sent them, the request method, the user agent) so a new allowlist
entry is written to what the audit log really carries. A scheduled run always
escalates. The report is the run's
summary. Success looks like a green run whose summary reads
`N DNS-record changes on the zone, **0 unexpected**` and lists all three
allowlist entries as active. A red run is a read failure, and its summary
says which: a missing secret or variable, an expired token (`HTTP 401` or
`403`), or an API failure.

**What an issue from it means.** The workflow opens
`Cloudflare DNS audit: unexpected record change (<date>)`, labelled
`Security` and `live-check`, and comments on it rather than opening another
while one is open. Each UNEXPECTED row names the time, the actor (a token by
name, a dashboard user by masked e-mail, with the client address), the
action, the record's type and name, and the audit log entry id. Record
contents are not in the report by design. Then:

1. Open the entry in the dashboard at
   `https://dash.cloudflare.com/?to=/:account/audit-log` (search the entry id)
   and read what was written.
2. **The Caddy token on anything but a lab `_acme-challenge` TXT, or an actor
   you do not recognise:** treat it as the token compromise ADR 0032 accepted
   the risk of. Roll the token first
   ([DNS token stolen](dns-token-stolen.md); the Caddy token is rotated through
   the lab host's Vault, [Labs host](labs-host.md)), then revert the record,
   then run the four checks above and record the run below.
3. **An edit you recognise and the allowlist does not name** (a new workflow's
   token, say): revert nothing, add the entry with its reason as described
   above, and close the issue naming the pull request.

## Recording a run

This page is the durable record — issue #357 held the first runs and is closed
once this runbook merges. Add a row for every run, newest last, and a short
section under the table when the run found something or corrected something. A
run that found nothing is still recorded: the value of the log is knowing when
the estate was last confirmed, and by which trigger.

| Date | Trigger | 1 DNS | 2 Site | 3 Health | 4 Public read | Notes |
| --- | --- | :---: | :---: | :---: | :---: | --- |
| 2026-09-07 | None — baseline before the Cosmos exporter apply (#231) | pass | pass | pass | pass | Corrected the DNS criterion, and confirmed `unresolvedSecrets: 2` as the expected state |

### 2026-09-07 — baseline, and the criterion that was wrong

Read-only, from the owner's workstation. Three checks passed as written. The
fourth did not fail: the criterion it was measured against was wrong, and
correcting it is what produced the topology section above.

| Check | Observed |
| --- | --- |
| DNS | apex `A` → `172.169.198.52`; `www` CNAME → `calm-ground-0d0e6a010.7.azurestaticapps.net`; `api-azure` → `104.21.48.160` and `172.67.154.84` plus two `AAAA` |
| Site | `HEAD /` → `200` |
| Health | `status: ok`, `service: hcw-functions`, `generation: gate2-a8fd3c8`, `unresolvedSecrets: 2` |
| Public read | `{"success":true,"items":[],"total":0}` — a real API answer, not a challenge page |

`api-azure` answered with `Server: cloudflare` and a `CF-RAY` header. The apex
and `www` answered with neither, and the apex presented a DigiCert GeoTrust
certificate for `CN=hybridcloudworks.com` — the Static Web App's managed
certificate. That split is the design, not drift.

Running `scripts/check-unresolved-secrets.mjs` against the live ARM response
for `func-site-prod-cus-01` reported one reference unresolved as intended
(`AZURE_SPEECH_KEY`) out of 42, and exited `0`.

One thing this run says about **#127**, which proposes Cloudflare Pro for the
managed WAF rulesets: a zone-level WAF protects proxied traffic, and today the
only proxied hostname is `api-azure`. The site itself would not sit behind it.
That does not settle #127 either way — the API is the surface that takes
untrusted input — but it should be decided with the topology in view rather
than assumed.

## Related

- [ADR 0024](../decisions/0024-edge-availability-probe.md) — why `api-azure` is the one
  proxied hostname, and why reachability is watched by a Worker
- [Availability probe](../runbooks/availability-probe.md) — the five-minute signal these
  checks sit alongside
- [Alerting and support](../runbooks/alerting-and-support.md) — what pages an operator, and
  the 404-on-every-route failure that no rule catches
- [DNS token stolen](../runbooks/dns-token-stolen.md) — the roll, when the daily DNS audit
  above names a token on a record it may not touch
- [Cutover runbook, step 3b](../history/cutover-runbook.md#3b-custom-domains-on-the-static-web-app)
  — how the apex and `www` were bound, and why they are not in Terraform
- `infra/frontend.tf` — every record, the custom hostname binding, and the
  origin-secret ruleset, each beside its reason
