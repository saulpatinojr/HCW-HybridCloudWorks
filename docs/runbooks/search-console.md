# Search Console page: what Google knows about the site

> **Status: built, waiting for the owner's one-time Google setup.** Owner
> request of 2026-11-09, ticket
> [#1612](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1612).
> Until the setup below is done, the page says **not configured** and the
> timer does nothing.

**Scope:** what the admin Search Console page shows and where each number
comes from, what Google's API cannot give us, and the owner's one-time setup.

**Authority:** the page only reads Google's data about the public site. It
cannot submit, remove or change anything in Search Console. The admin
portal's **editor** role or above can open it and press Run now.

## What the page shows

The page reads one document the backend writes twice a day. The run starts
at 00:10 and 12:10 UTC, which is 18:10 and 06:10 Central Standard Time
(19:10 and 07:10 Central Daylight Time, in summer). The owner asked for about
6 PM and 6 AM Central; the times are written in UTC because the app clock is
UTC ([#416](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/416)).
The page never calls Google while you look at it. The **Run now** button asks
for one extra run; it takes a few minutes.

| Part | What it shows | Where it comes from |
| --- | --- | --- |
| Indexing | For each page in the live [sitemap](https://hybridcloudworks.com/sitemap.xml), and for up to 150 strays (next row): Google's verdict (pass, neutral, fail), its coverage state ("Submitted and indexed", "Crawled - currently not indexed", ...), whether Google could fetch it, robots.txt, the last crawl, and which address Google treats as the real one (the "canonical"). Each row says which host it is on and where it came from (**Sitemap** or **Found in search**), and the table can be narrowed to one host. Totals by verdict and by state, and how those totals moved over the last two months | Google's [URL Inspection API](https://developers.google.com/webmaster-tools/v1/urlInspection.index/inspect), one call per page |
| Strays | Pages on `hybridcloudworks.com` or any of its subdomains (for example `api-azure.`, `docs.` and the lab hosts) that get search impressions but are **not** in the sitemap, most impressions first. The 150 with the most impressions are also inspected in each run, after the sitemap's pages | The Performance data below, grouped by page, compared with the sitemap |
| Performance | Clicks, impressions, click-through rate (CTR, a fraction from 0 to 1) and average position for the last 90 days and the last 28, a line per day, and the top 50 queries, pages, countries, devices and search appearances. The figures cover the whole Search Console property: `hybridcloudworks.com` and every subdomain (owner decision of 2026-11-09 on [#1612](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1612)), so they match Google's own Performance screen for the property. The Pages table shows each page's full address, host included | Google's [Search Analytics API](https://developers.google.com/webmaster-tools/v1/searchanalytics/query) |
| Sitemaps | Each sitemap Google has, when it was submitted and last read, and its warnings and errors | Google's [Sitemaps API](https://developers.google.com/webmaster-tools/v1/sitemaps/list) |

Things to know before trusting a number:

- **The inspection result is Google's indexed copy, not a live test.**
  Google's own page says so: you cannot test the indexability of a live URL
  through the API. A page you fixed this morning shows as fixed only after
  Google crawls it again.
- **Search figures lag about two days**, so the 90 days end two days ago.
- **Country codes** are Google's three-letter lower-case codes, for example
  `usa` and `gbr`.
- **Only the main site publishes a sitemap.** The run reads
  `https://hybridcloudworks.com/sitemap.xml` (the app setting
  `GSC_SITEMAP_URL` can point it elsewhere; it is not set in Terraform). The
  subdomains publish none, so
  their pages reach the Indexing table when the sitemap lists them or as
  strays, found in Google's search figures.
- **Each run uses one inspection per page, and the app stops at
  1,800 a day.** Google allows 2,000 inspections a day and 600 a minute for
  one property, and its day runs midnight to midnight Pacific time
  ([usage limits](https://developers.google.com/webmaster-tools/limits)).
  Every run, scheduled or Run now, inspects each page in the sitemap once
  (about 203 on 2026-11-09), then up to 150 strays, never more than 900
  pages in all. The sitemap's pages come first, so when the day's allowance
  runs short it is the strays that wait. The app counts every
  inspection request it sends, a retry after an error from Google included,
  in `admin_config/search_console_lease`, never sends one it has no room
  for, and stops at
  1,800 for the Pacific day, which leaves 200 for your own inspections in
  Search Console. When the allowance runs out, Run now says so and when it
  starts again, a scheduled run keeps each page's last answer (the Indexing
  table marks it **stale**), and the note above the tabs says why. The app
  setting `GSC_DAILY_INSPECTION_BUDGET` can lower the number; it is not set
  in Terraform, so 1,800 applies.
- **Two runs never overlap.** A run first takes a lease (a short hold) on
  `admin_config/search_console_lease`. While a run holds it, Run now answers
  that a run is already going, and a timer run that starts meanwhile does
  nothing. A run that stops without giving the lease back holds it for at
  most 35 minutes. Two presses of Run now at the same moment queue one run:
  the first press marks the same document (`pendingJob`) before it queues,
  and the second answers that a run is already queued. A queued run that is
  no longer needed stops before it calls Google: when that mark names
  another queued run (for example, a run queued by hand through the jobs
  route, which makes no mark, gives way to a Run now press), or when another
  run finished after it was queued (a queue message that arrived late or
  twice). The job then shows as succeeded with `skipped: superseded`.
- **A run stops itself after 25 minutes.** That is well inside the lease's
  35, so a slow run cannot outlive its lease. At 25 minutes the run starts
  nothing new, cuts off any call to Google still waiting for an answer,
  saves what it has (the pages it did not reach keep their last answer,
  marked stale, and the note above the tabs says the run hit its time
  limit). Just before it saves, it checks that it still holds the lease; if
  another run has taken it, the slow run writes nothing, so it can never
  overwrite newer figures. A Run now job has its own 28-minute limit, set
  above the run's 25 minutes so a slow Run now also saves what it has; a job
  that somehow reaches it saves nothing and is recorded as timed out.
- **A run that goes wrong keeps the last good figures.** If the sitemap
  cannot be read, the run changes nothing but the message. An answer counts
  as a sitemap only when it starts with `<urlset>` (or `<sitemapindex>` for
  the main sitemap address): the site answers any address it does not know
  with its normal web page and HTTP 200
  ([#1613](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1613)),
  so a sitemap that has moved is treated as not read rather than as an
  empty one. If only part of
  it can be read (one of the sitemaps a sitemap index points to fails, or
  the index lists more than the 20 the run reads), pages the last run had
  that the part read does not list keep their last answer, marked stale,
  instead of disappearing. The strays are worked out only from a sitemap
  read in full and Google's list of pages; when either is missing, the
  strays from the last run keep their last answer, marked stale. If Google answers that its quota is used up (HTTP
  429) even after retrying, the run stops inspecting, and the pages it did
  not reach keep their last answer, marked stale. If Google answers with
  something that is not what it documents, that part keeps its last
  figures.

## What Google's API cannot give us

Google's [API reference](https://developers.google.com/webmaster-tools/v1/api_reference_index)
lists four things the API can reach: Search Analytics, Sitemaps, Sites and
URL Inspection. So two Search Console screens have no API at all, and the
page says so in a box rather than guessing:

- **Page indexing totals and reasons** (the screen with "Indexed / Not
  indexed" and "Why pages aren't indexed"). The page shows its own tally of
  the pages it inspected instead (the sitemap's and up to 150 strays), which
  is a smaller set than Google's: on 2026-11-09 Google knew 436 addresses
  and the sitemap had 203. Inspecting the strays narrows that gap.
- **Links** (internal and external links). Not shown; open it in
  [Search Console](https://search.google.com/search-console) (left menu, **Links**).

## How the app signs in to Google (no key to store)

There is no Google key or password anywhere. Google calls the method
[workload identity federation](https://cloud.google.com/iam/docs/workload-identity-federation-with-other-clouds):
Google agrees, once, to trust tokens that Microsoft Entra (our Microsoft
sign-in directory) issues for the Function App, and lets them act as one
Google service account (a Google identity for a program, not a person). Each
run makes three hops:

1. **Entra token.** The Function App's managed identity (an identity Azure
   gives the app, with no password) asks Entra for a token meant for our own
   app registration, named by its Application ID URI.
2. **Token exchange.** Google's token service checks that token against the
   workload identity pool provider (the trust we set up below) and gives back
   a short-lived Google token.
3. **Service account token.** Google turns that into a one-hour token for
   the service account `sa-hcw-search-console`, limited to reading Search
   Console. That service account is a **Full** user on the property.

Google's page shows hop 1 for a virtual machine, which asks the Azure
instance metadata endpoint for its token. A Function App gets its
managed-identity token through a different local endpoint, so the app does
the three hops in its own code
([`functions/src/lib/search-console/google-auth.js`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/functions/src/lib/search-console/google-auth.js))
instead of Google's client library and credential file. When a run fails,
the page's message names the hop that failed and the HTTP status.

**Full, not Restricted.** Google's
[permissions table](https://support.google.com/webmasters/answer/7687615)
gives Restricted users only "Fetch only" for URL inspection, so the service
account must be added as Full.

## One-time setup (owner only)

You need: PowerShell, the Azure CLI signed in as an owner of the production
subscriptions, the [Google Cloud CLI](https://cloud.google.com/sdk/docs/install)
signed in as your Google account (`gcloud auth login`), and the Google
account that owns the Search Console property. Run the commands in one
PowerShell window from top to bottom: later commands use values the earlier
ones put in `$variables`. If you close the window, run steps 3, 5, 8 and 10
again (they only read values) before continuing. Do **not** run steps 6 and 7
again: step 7 creates the app registration, and a second run makes a second
one. Read their values back instead with this one line (PowerShell); it prints
the `api://` address, and an empty line means step 7 never finished:

```powershell
az account set --subscription sub-app-site-prod-cus; $tenant = az account show --query tenantId -o tsv; $app = az ad app list --display-name app-gsc-wif-site-prod-cus -o json | ConvertFrom-Json | Select-Object -First 1; $appId = $app.appId; $uri = "api://" + $appId; $uri
```

Google lists no charge for the APIs and the federation used here; this was
not checked against a bill. No step creates a key.

### Google Cloud project

> **Cannot be undone:** a Google Cloud project id is permanent. It cannot be
> renamed, and after a project is deleted its id can never be used again.

1. Create the project:

   ```powershell
   gcloud projects create hcw-search-console --name "HCW Search Console"
   ```

   Success: `Create in progress for [https://cloudresourcemanager.googleapis.com/v1/projects/hcw-search-console]` and then a line saying the operation finished. If it says the id is already in use, run it again with `hcw-search-console-2` in both places, and use that id in step 2.

2. Make it the current project for the commands below:

   ```powershell
   gcloud config set project hcw-search-console
   ```

   Success: `Updated property [core/project].`

3. Read the project's id and number into variables:

   ```powershell
   $project = gcloud config get-value project; $number = gcloud projects describe $project --format "value(projectNumber)"; "$project $number"
   ```

   Success: the id and a long number on one line, for example `hcw-search-console 123456789012`. If the number is empty, step 1 did not finish; wait a minute and run this again.

4. Turn on the five Google APIs the setup and the app use (IAM, Resource Manager, IAM Credentials, Security Token Service and Search Console):

   ```powershell
   gcloud services enable iam.googleapis.com cloudresourcemanager.googleapis.com iamcredentials.googleapis.com sts.googleapis.com searchconsole.googleapis.com --project $project
   ```

   Success: `Operation "operations/..." finished successfully.` It can take a minute.

### Service account

5. Create the service account and keep its email:

   ```powershell
   gcloud iam service-accounts create sa-hcw-search-console --project $project --display-name "HCW Search Console reader"; $sa = "sa-hcw-search-console@$project.iam.gserviceaccount.com"; $sa
   ```

   Success: `Created service account [sa-hcw-search-console].` and the email. If it says it already exists, that is fine; the email line still prints.

### Entra app registration (the audience, no secret)

6. Sign in to Azure and choose the application subscription:

   ```powershell
   az login; az account set --subscription sub-app-site-prod-cus; $tenant = az account show --query tenantId -o tsv; $tenant
   ```

   Success: a directory id (a long id with dashes). If `az account set` says the subscription was not found, the sign-in went to another directory; run `az login --tenant` followed by the directory that owns `sub-app-site-prod-cus`, as the [Cost page runbook](cost.md#one-time-setup-owner-only) step 2 does.

7. Create the app registration, give it an Application ID URI, and create its service principal (Entra will not issue a token for an app without one). No client secret is created:

   ```powershell
   $appId = az ad app create --display-name app-gsc-wif-site-prod-cus --query appId -o tsv; $uri = "api://" + $appId; az ad app update --id $appId --identifier-uris $uri; az ad sp create --id $appId --query id -o tsv; $uri
   ```

   Success: an object id, then `api://` followed by the app id. If `az ad sp create` says the principal already exists, that is fine. Do not change the registration's token version: the issuer in step 9 assumes the default (version 1) tokens, whose issuer is `https://sts.windows.net/<directory id>/`.

8. Read the Function App's managed identity id (Google trusts exactly this identity):

   ```powershell
   $principal = az functionapp identity show -g rg-web-site-prod-cus -n func-site-prod-cus-01 --query principalId -o tsv; $principal
   ```

   Success: a long id with dashes. The app uses its system-assigned identity (`infra/functionapp.tf`, the `identity` block); if this prints nothing, the subscription from step 6 is not the application subscription.

### Workload identity pool and provider

> **Cannot be undone:** a pool id cannot be changed after it is created
> (Google's page above).

9. Create the pool `hcw-azure` and its provider `entra`, trusting tokens from our directory meant for the app registration, and only those of the Function App's identity from step 8:

   ```powershell
   gcloud iam workload-identity-pools create hcw-azure --project $project --location global --display-name "HCW Azure"; gcloud iam workload-identity-pools providers create-oidc entra --project $project --location global --workload-identity-pool hcw-azure --issuer-uri "https://sts.windows.net/$tenant/" --allowed-audiences $uri --attribute-mapping "google.subject=assertion.sub" --attribute-condition "assertion.sub=='$principal'"
   ```

   Success: `Created workload identity pool [hcw-azure].` and `Created workload identity pool provider [entra].` `google.subject=assertion.sub` makes each Azure identity's object id its Google name, which step 10 uses. The attribute condition (a rule Google checks on every token, described on [Google's federation page](https://cloud.google.com/iam/docs/workload-identity-federation-with-other-clouds)) refuses any token whose subject is not the Function App's identity, so no other identity in the directory can even exchange a token. PowerShell fills in `$principal` inside the double quotes and leaves the single quotes as they are, which is what Google's rule language expects. To check, run `gcloud iam workload-identity-pools providers describe entra --project $project --location global --workload-identity-pool hcw-azure --format "value(attributeCondition)"`: it prints `assertion.sub=='` followed by the id from step 8 and `'`. If it prints `assertion.sub==''`, step 8's `$principal` was empty; run step 8 again, then `gcloud iam workload-identity-pools providers update-oidc entra --project $project --location global --workload-identity-pool hcw-azure --attribute-condition "assertion.sub=='$principal'"`.

10. Let the Function App's identity, and nothing else, act as the service account, and keep the provider's full name:

    ```powershell
    gcloud iam service-accounts add-iam-policy-binding $sa --project $project --role roles/iam.workloadIdentityUser --member "principal://iam.googleapis.com/projects/$number/locations/global/workloadIdentityPools/hcw-azure/subject/$principal"; $audience = "//iam.googleapis.com/projects/$number/locations/global/workloadIdentityPools/hcw-azure/providers/entra"; $audience
    ```

    Success: `Updated IAM policy for serviceAccount [sa-hcw-search-console@...]` with a `roles/iam.workloadIdentityUser` binding, then the provider's name starting `//iam.googleapis.com/projects/` and your project **number**.

### Search Console

11. Open [Users and permissions for the property](https://search.google.com/search-console/users?resource_id=sc-domain%3Ahybridcloudworks.com), choose **Add user**, paste the service account email from step 5 (`$sa`), choose **Full**, and add it.

    Success: the email is listed with permission **Full**. If the page says you cannot add users, you are signed in as a Google account that is not the property's owner.

### HCP Terraform workspace

12. Print the four values the workspace needs:

    ```powershell
    "gsc_wif_audience = $audience"; "gsc_entra_app_id_uri = $uri"; "gsc_service_account_email = $sa"; "gsc_site_url = sc-domain:hybridcloudworks.com"
    ```

    None of them is a secret: they name things and open nothing on their own.

13. In the [`hcw-azure` workspace variables](https://app.terraform.io/app/hcw/workspaces/hcw-azure/variables), add three Terraform variables, `gsc_wif_audience`, `gsc_entra_app_id_uri` and `gsc_service_account_email`, each with the value printed in step 12, HCL off, Sensitive off. Leave `gsc_site_url` out; its default is already the property.

    Success: the three are listed. A value of the wrong shape fails the next plan on the variable's own check, naming it.

14. In the [`hcw-azure` workspace variables](https://app.terraform.io/app/hcw/workspaces/hcw-azure/variables), check that `schedulers_master_enabled` is `true`. If it is `false`, stop: turning it on lets every timer in `enabled_timers` run, which is a separate decision. Then edit `enabled_timers` (HCL) to add `"SYNC_SEARCH_CONSOLE"` to the list, and save.

15. Start a run from the [workspace's runs page](https://app.terraform.io/app/hcw/workspaces/hcw-azure/runs) and read the plan before you confirm it. Confirming applies the change to Azure.

    Success: the plan changes only `azurerm_function_app_flex_consumption.hcw`'s app settings: the three `GSC_*` settings from `""` to your values (the plan check, `tfc-plan-check`, lists these as UNEXPECTED on purpose, because the real values are not written in the repository; check they are the three from step 12) and `FEATURE_FLAG_SYNC_SEARCH_CONSOLE` from `"false"` to `"true"`. If anything else changes, stop and ask.

### Check it works

16. Open the admin Search Console page (Platform menu, **Search Console**; [`/admin/search-console`](https://hybridcloudworks.com/admin/search-console)) and press **Run now**. Wait three to five minutes and reload.

    Success: the status is **ok**, "last run" shows the time you pressed it, about 200 pages or more are inspected (the sitemap's, plus any strays) with none or few failed, and Performance has numbers. Then the timer runs on its own at the next 00:10 or 12:10 UTC.

    If the status is **error**, the message names the hop. Find it here:

    | Message says | What is wrong | Check |
    | --- | --- | --- |
    | hop 1 (Entra token) | The app cannot get a token for the registration | Steps 7 and 13: `gsc_entra_app_id_uri` is exactly the `api://...` value, and the service principal exists (`az ad sp show --id` followed by the app id prints it) |
    | hop 2 (Google token exchange), HTTP 400 | Google's token service does not trust the token | Step 9: the issuer is `https://sts.windows.net/` + directory id + `/`, the allowed audience is the same `api://...` value, and the attribute condition names the id from step 8; step 13: `gsc_wif_audience` uses the project **number** |
    | hop 3 (service account token), HTTP 403 | The app's identity may not act as the service account | Step 10 ran with the right `$principal` (step 8), and the IAM Credentials API is on (step 4) |
    | HTTP 403 ... not a Full user | Google signed in, but the service account cannot read the property | Step 11: the service account is listed as **Full** |
    | 404 ... GSC_SITE_URL | Google has no property at that address, or the service account cannot see it | The workspace variable `gsc_site_url`, if someone set it (step 13 leaves it out, so its default `sc-domain:hybridcloudworks.com` applies), must be the property's exact name in Search Console; step 11 for the service account |

## Turning it off

Remove `"SYNC_SEARCH_CONSOLE"` from `enabled_timers` in the
[workspace variables](https://app.terraform.io/app/hcw/workspaces/hcw-azure/variables)
and apply. The page keeps showing the last run. To cut Google's trust
completely, remove the service account from the property in
[Users and permissions](https://search.google.com/search-console/users?resource_id=sc-domain%3Ahybridcloudworks.com).

## Where the code is

- [`functions/src/lib/search-console/`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/tree/main/functions/src/lib/search-console):
  the sign-in (`google-auth.js`), the three Google calls (`client.js`), one
  run (`sync.js`) and the two routes (`handlers.js`).
- [`functions/src/functions/search-console-http.js`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/functions/src/functions/search-console-http.js):
  `GET cms/search-console`, `POST cms/search-console/run` and the
  `sync-search-console` job.
- The timer `syncSearchConsole` is in
  [`functions/src/functions/schedulers.js`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/functions/src/functions/schedulers.js).
- The documents are `admin_config/search_console_snapshot` (what the page shows) and
  `admin_config/search_console_lease` (the run lease and the day's inspection count,
  [`lease.js`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/functions/src/lib/search-console/lease.js)) in Cosmos DB.
- The settings are in [`infra/functionapp.tf`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/infra/functionapp.tf)
  and [`infra/variables.tf`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/infra/variables.tf),
  and listed in [Required inputs](../standards/required-inputs.md).
