# Cost page: what the platform costs, and how to keep it honest

> **Status: in use from the deploy that follows its merge.** Owner request of
> 2026-11-01: a **Cost** page under **Platform** in the admin portal that shows
> current and end-of-month costs for Azure, the AI providers (subscriptions or
> credits left) and the services paid for outside Azure, with alerts. The
> design and its trade-offs are in
> [ADR 0039](../decisions/0039-cost-page.md).

**Scope:** what the page shows and where each number comes from, the one-time
setup only the owner can do, how to keep the subscriptions ledger, what raises
an alert and where it goes, and what to do when a number looks wrong.

**Authority:** the page reads costs; it never changes a budget, a plan or a
resource. The admin portal's **editor** role or above can open it and edit the
ledger and settings.

## Where it is

[`/admin/cost`](https://hybridcloudworks.com/admin/cost) (menu: **Cost**, in
the **Platform** group, under Integrations). It has five tabs:

| Tab | What it shows | Where the numbers come from |
| --- | --- | --- |
| Overview | The month at a glance: Azure against its budgets, AI spend, subscriptions per month, the alerts count, the last months, and when each source was last read | All of the below |
| Azure | One card per subscription or resource group with a budget: spent so far, Azure's estimate for the whole month, the daily line and the most expensive services | Azure Cost Management and the three Azure budgets ([`infra/budget.tf`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/infra/budget.tf), [`infra/foundry.tf`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/infra/foundry.tf)) |
| AI | The site's own estimate of what each AI provider and each task cost, ElevenLabs credits left, the monthly image budget, and the Microsoft Foundry budget | The AI usage ledger (every model call writes a row), the ElevenLabs account, the image budget settings |
| Services | The subscriptions the site pays for outside Azure: price, cycle, renewal date, whether it renews on its own | A sheet you keep on this tab |
| Alerts | Everything that needs a look, worst first, with the rule behind each one, and the settings | Worked out from the three tabs above |

A few things to know before trusting a number:

- **Azure updates its cost figures a few times a day**, and this month's
  charges can still change until the invoice closes
  ([Understand Cost Management data](https://learn.microsoft.com/azure/cost-management-billing/costs/understand-cost-mgt-data)).
  Today's spend can lag by up to a day.
- **The end-of-month figure is Azure's own forecast** when the budget has one
  (the same number the forecast alert uses). Otherwise it is a straight line:
  the spend so far divided by the days so far, times the days in the month.
  The card says which.
- **AI figures are estimates, not invoices.** Most providers (Google, Anthropic,
  OpenAI) do not tell an API key its balance, so the page adds up the price of
  each call the site made. ElevenLabs does report credits, and that card shows
  them. Microsoft Foundry bills through Azure and has its own budget.
- **The Services tab only knows what you type.** No API tells the site what
  Cloudflare, the domain or GitHub charge.

## One-time setup (owner only)

The page reads Azure's costs with the Function App's own identity (a managed
identity: an identity Azure gives the app, with no password to store). That
identity needs the built-in **Cost Management Reader** role on the two
subscriptions. That role can read costs and budgets and cannot change anything
([role definition](https://learn.microsoft.com/azure/role-based-access-control/built-in-roles/management-and-governance#cost-management-reader)).

Terraform does not make this grant, on purpose: the grant sits at subscription
level, and the Terraform identity is kept from granting anything at that level
(the reason is in [`infra/budget.tf`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/infra/budget.tf),
at the end of the file). So you make it once, by hand. Until you do, the Azure
tab says the figures cannot be read and names the missing role; everything
else on the page works.

1. Open PowerShell and sign in with the account that owns the subscriptions:

   ```powershell
   az login
   ```

   A browser window opens; pick your account. The terminal then lists your
   subscriptions.

2. Paste this one line. It looks up the Function App's identity, then gives it
   Cost Management Reader on the application and Platform Management
   subscriptions:

   ```powershell
   $p = az functionapp identity show -n func-site-prod-cus-01 -g rg-web-site-prod-cus --subscription sub-app-site-prod-cus --query principalId -o tsv; foreach ($s in 'sub-app-site-prod-cus', 'sub-plat-mgmt-prod-cus') { $id = az account show --subscription $s --query id -o tsv; az role assignment create --assignee-object-id $p --assignee-principal-type ServicePrincipal --role "Cost Management Reader" --scope "/subscriptions/$id" -o none; "$s done" }
   ```

   **What you should see:** `sub-app-site-prod-cus done` and
   `sub-plat-mgmt-prod-cus done`, with no red text. If you see
   `AuthorizationFailed`, the signed-in account cannot grant roles there; sign
   in with the subscription's owner and run it again.

3. Check the two grants exist:

   ```powershell
   $p = az functionapp identity show -n func-site-prod-cus-01 -g rg-web-site-prod-cus --subscription sub-app-site-prod-cus --query principalId -o tsv; foreach ($s in 'sub-app-site-prod-cus', 'sub-plat-mgmt-prod-cus') { az role assignment list --assignee $p --subscription $s --role "Cost Management Reader" -o json | ConvertFrom-Json | Select-Object roleDefinitionName, @{ n = 'subscription'; e = { $s } } }
   ```

   **What you should see:** two rows, each `Cost Management Reader`, one per
   subscription.

4. Open the [Cost page](https://hybridcloudworks.com/admin/cost) and press
   **Refresh** on the Overview tab. A new role can take a few minutes to
   reach the app; if the Azure tab still names the role after ten minutes,
   press Refresh again.

## Keeping the subscriptions ledger

The [Services tab](https://hybridcloudworks.com/admin/cost?tab=services) is a
sheet of what you pay outside Azure. Each row is one subscription: a name, the
vendor, the plan, the price and how often it bills (monthly, yearly,
quarterly, pay-as-you-go, free or one-off), the next renewal date, whether it
renews on its own, how it is paid ("Card ending 1234"; the form refuses a full
card number), a link to the vendor's billing page and a short note.

- **Start from the chips.** Above the form, the page lists services the site is
  already set up to use (from the API-keys list) that the ledger does not have
  yet. Press one to fill in the name, vendor and category, then add the price.
- **Things the site does not know about** need adding by hand. From
  [the cost analysis](../architecture/cost-analysis.md) these are at least the
  domain host, Cloudflare and anything billed to the owner's own accounts
  (GitHub, Docker Hub, HCP Terraform, Claude) that the site depends on.
- **Pay-as-you-go**: type your usual monthly amount; it counts as that much a
  month.
- **Yearly or quarterly** prices are spread over the months, so the
  "per month" figure is comparable across rows.
- **Cancelled** rows stay in the list but stop counting and stop alerting.

Every renewal date also appears on the admin
[Calendar](https://hybridcloudworks.com/admin/calendar) as a **Renewal** item.

## Alerts: what raises one, and where it goes

The rules follow the Azure budgets' own thresholds, so the page and Azure's
emails always agree about where a budget stands.

| Severity | Raised when |
| --- | --- |
| Critical | A budget is at 90 % or more of its amount; the AI budget is spent; ElevenLabs has under 5 % of its credits left; the image budget is spent |
| Warning | A budget passes 75 %; Azure forecasts a budget will be passed; a renewal is due today or tomorrow, or its date has passed and it does not renew on its own; ElevenLabs has under 20 % left; the AI or image budget passes 80 %; Azure's costs could not be read |
| Info | A budget passes 50 %; a renewal is inside the warning window (7 days by default); the figures are more than 36 hours old; a credit balance could not be read |

Where each alert shows up:

1. **The Cost page's Alerts tab**: every alert, with a link to the tab that
   explains it.
2. **The dashboard's Needs a decision list** (Governance tab): warnings and
   critical alerts, for editors.
3. **Telegram**: each new warning or critical alert, once, through the same bot
   as the [reminders sheet](https://hybridcloudworks.com/admin/platform-settings?tab=reminders).
   It is told again only if it clears and comes back.
4. **A monthly digest on Telegram** on the first day of each month: last
   month's Azure, AI and subscription figures.
5. **Azure's own budget emails** still go out as before; nothing here replaces
   them.

The settings at the bottom of the Alerts tab decide the AI monthly budget (none
by default), how many days before a renewal to warn (7), whether Telegram hears
about alerts and the digest (both on), and how often the figures are re-read
(every 6 hours).

## How the figures stay fresh

The figures are kept in one saved snapshot, so opening the page does not make
Azure work. The snapshot is rebuilt:

- **every 6 hours** (the "re-read every" setting) by the platform's five-minute
  health timer, which also checks the alerts once an hour; and
- **when you press Refresh** on the Overview tab, at most once every five
  minutes (Cost Management limits how often it can be asked).

The Services tab is read live, so a change there shows at once.

## When a number looks wrong

| What the page says | What it means | What to do |
| --- | --- | --- |
| "Azure refused the read (HTTP 403): the Function App's identity needs the Cost Management Reader role" | The one-time grant above has not been made, or not on that subscription | Do the [one-time setup](#one-time-setup-owner-only) |
| "COST_SCOPES is not set" | The app setting that lists what to read is missing, usually because a deploy has not run since this change merged | Wait for the next Terraform apply, or ask the session that runs deployments |
| "Azure rate-limited the read (HTTP 429)" | Cost Management was asked too often | Nothing; the next refresh tries again |
| An Azure figure lower than the invoice | Cost data lags by up to a day, and this month can still change | Compare again after the invoice closes |
| An AI figure that differs from a provider's bill | The page prices each call from the published rates; the provider's own bill is the truth | Check the provider's console; the [AI Engine usage tab](https://hybridcloudworks.com/admin/ai-engine?tab=usage) lists each call |
| "ElevenLabs credits could not be read" | The ElevenLabs key needs the **User → Read** permission | Add it on [ElevenLabs' API keys page](https://elevenlabs.io/app/developers/api-keys) |

## What is stored, and who can see it

- `admin_config/cost_ledger`: the subscriptions ledger and the page's settings.
- `admin_config/cost_snapshot`: the last Azure and AI reading, the closing
  figures of up to twelve past months, and which alerts Telegram has been told.

Both are in the database container every admin setting uses. No public route
reads them. The page never shows a subscription id: each Azure card is named by
its label. Every change to the ledger or the settings writes an audit row with
the row's id and the names of the fields that changed, never the amounts or
words.

Koda, the content agent, can read the page (summary, ledger and settings) when
its **Platform** switch is on, and cannot change anything on it
([Agent Content API](agent-content-api.md)).
