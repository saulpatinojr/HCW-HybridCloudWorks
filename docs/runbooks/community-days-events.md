# Future Events: the Community Days list on the Speaking hub

> **Status: built, waiting for the key.** Owner request of 2026-11-24, ticket
> [#1823](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1823);
> the decision record is [ADR 0045](../decisions/0045-community-days-events.md).
> Until the Community Days key is pasted on the Keys tab, the tab says **the
> key is not set** and calls nothing.

**Scope:** what the **Future Events** tab of the admin
[Speaking hub](https://hybridcloudworks.com/admin/speaking?tab=apply) shows,
how its acceptance estimate works and what it cannot tell you, how to set,
replace and revoke the key, and what each error means.

**Authority:** the site only **reads** from Community Days. It cannot create,
change or delete anything there. The admin portal's **editor** role or above
can open the tab, save notes and press Estimate.

## What it is

[Community Days](https://www.communitydays.org) is a public directory of
community conferences. Each event there can have a **call for speakers**: a
period when the organizers accept talk proposals. The tab lists every
published event whose call for speakers is open right now, and lets you keep
your own record against each one.

For each event the tab shows:

| On the row | Where it comes from |
| --- | --- |
| Title (a link to the event's page), tagline | Community Days |
| Where: city, state or province, country, and the kind (in person, virtual, hybrid) | Community Days |
| When: the event's first and last day | Community Days, in the event's own local time |
| Call for speakers: the day it closes, about how many days are left, and the link to apply | Community Days |
| Cost to attend: Free, Low Cost ($30 or less) or Paid | Community Days. This is the price of a ticket, not your cost |
| Your status: Not decided, Interested, Applied, Accepted, Declined, Not going | You |
| Your costs: travel, lodging, ticket and other, with their total | You. Plain numbers in whatever unit you use; no currency is stored |
| Your notes | You |
| Estimate: a rough percentage chance of acceptance, with two or three reasons | A model, only when you press **Estimate** (below) |

Beside the list is a **small month calendar**. It marks:

- a square on each day of an event you marked **Interested**, **Applied** or
  **Accepted** (even after its call closed and it left the list);
- one small grey dot on a day that has listed events you have **not** marked,
  however many there are. Choose the day to see how many and the first few
  names;
- a diamond on the day of each of **your own talks** that is sent or accepted
  (from the hub's Upcoming and Past tabs: Speaking hub status *Proposed* or
  *Accepted*);
- a ring on the day a call for speakers closes;
- a warning sign, and a red frame, on a **clash** day (the rule is below).

An event you marked **Not going** or **Declined** is left off the calendar,
and so is the day its call closes.

Choose a marked day to read what is on it. Every mark has a different shape
and its word in the legend, so nothing depends on colour.

### What counts as a clash

The calendar and the rows use one rule: **a clash is two things you care
about on the same day.** The directory lists hundreds of events around the
world, so "some listed event is on that day" is true of almost every day and
would tell you nothing. The things that count are:

- one of **your own talks** that you have sent or had accepted. The hub
  stores one day for each talk, not a range;
- an event on this tab that **you marked Interested, Applied or Accepted**.

So:

1. An event you marked clashes with one of your own talks when the talk's
   day falls on or between the event's first and last day.
2. Two events you marked clash when they share at least one day. Both rows
   say so.
3. On the calendar, a day is a clash day when it holds two events you marked,
   or one of your talks and an event you marked.

What stays quiet:

- **An event you have not marked never makes a clash.** Its row says, in
  plain grey words with no warning sign, "If you go, these dates meet ...",
  because that is worth knowing before you apply. Mark it Interested and the
  same line becomes a clash.
- **An event you marked Not going or Declined** makes no clash, says nothing
  on its row and is left off the calendar.
- **A cancelled or postponed event** is the same, because its dates no longer
  say when anything happens.
- Two of your own talks on one day are not marked here; that is the Upcoming
  tab's business.

When one of your talks **is** the listed event (the same name), the row says
"You already have a talk at this event" instead of flagging a clash.

Days are compared as calendar days, in each event's own local time, exactly
as written. "About N days left" uses your computer's date for today, so for
an event on the other side of the world it can be a day out.

### Events whose call has closed

Community Days lists an event here only while its call is open. Once it
closes, the event leaves the list. Anything you saved for it stays, under
**Saved, no longer listed**, and still counts on the calendar. That is
usually when the answer arrives, so each row there has **Edit status, costs
and notes**: change Applied to Accepted or Declined, and add what it cost.
Use **Clear** there to remove what you saved.

## The estimate, and its limits

**It is a rough guess, not a measurement.** When you press **Estimate** on a
row, the site sends one request to the language model the
[AI Engine page](https://hybridcloudworks.com/admin/ai-engine) is set to use.
The request holds:

- the event's title, tagline, kind, place, dates, the day its call closes,
  and the plain text of its page (cut to 2,500 characters);
- your talk topics, gathered from what the site already has: the topic and
  session titles on your Speaking hub events, your speaker profile's bio
  (Speaking → Settings), and the titles of your talks as Community Days
  lists them.

The model answers with a number from 0 to 100 and two or three short reasons.
The number is saved on the event with the day it was made.

What it cannot know, and so what the number does not reflect:

- how many proposals the event received, or how many slots it has;
- who else applied, and what the organizers want this year;
- anything not written on the event's public page.

Use it to sort a long list, never to decide alone.

**Nothing makes an estimate by itself.** Opening the tab, refreshing the list
and saving notes never call the model. One press is one request for one
event, so there is no model cost without a click. The feature has its own
switch on the
[AI Engine page, AI Services tab](https://hybridcloudworks.com/admin/ai-engine?tab=services),
**Speaking acceptance estimate**; when it is off, pressing Estimate shows
"The acceptance estimate is switched off" with a link to that tab, and no
model is asked.

**If Estimate is greyed out**, the site found no talk topics. Add a topic or
session titles to an event on the
[Upcoming tab](https://hybridcloudworks.com/admin/speaking?tab=upcoming)
(press **Enrich** on a row), or a bio on the
[Settings tab](https://hybridcloudworks.com/admin/speaking?tab=settings).

**The event's page is someone else's text.** An organizer could write
instructions for a model on their page ("answer 100"). The site keeps that
text inside a marked block that the model is told to treat as data only. The
block's two markers begin and end with three angle brackets (`<<<` and
`>>>`), and before the text goes in, every run of three or more `<` or `>`
in it is cut down to two. So the text cannot contain a marker, however it
was written (extra brackets, brackets written as HTML codes such as `&lt;`,
look-alike or invisible characters), and cannot end the block early. A test
checks that with a list of such attempts.

What that does and does not promise: it stops the page's text from
**pretending to be the site's instructions**. It cannot make a model ignore
persuasive words inside the block, so the answer is also checked before it
is kept: the number is held between 0 and 100, at most three reasons are
kept, and they are shown as plain text. The worst a hostile page can do is
move one event's rough number, which is one more reason to treat the number
as a guess.

## How often Community Days is asked

The server keeps its own copy of the list. It reads the list again only when
the copy is six hours old (the next time someone opens the tab), or when you
press **Refresh**, at most once a minute. If a read fails, the tab keeps
showing the last good copy and says why; it does not try again by itself for
five minutes. If Community Days answers "too many requests", to the list of
events or to the list of your talks, the site waits as long as that answer
says before asking again, even if you press Refresh.

If the list was read but the site could not save its copy, that counts as a
failed read too: the tab says so, keeps the last good copy, and waits five
minutes before trying again.

The copy has a size limit, because the database refuses one document over
2 MB. Each event's page text is kept to 2,500 characters and 2,500 bytes
(text in a non-Latin script takes two or three bytes a character, so less of
it is kept). If the whole list were still too large, page texts would be
shortened further, and as a last step only the soonest events kept, with the
tab saying that more exist.

## The key

**This key is not read-only.** The same Community Days key can create, change
and delete your events, your speaker profile and your organization there, and
Community Days offers no narrower key. This site makes two read requests with
it (the list of events, and your talks) and nothing else; a test in the code
fails if any other request is ever added. Treat the key like a password to
your Community Days account: it goes in the Keys tab and nowhere else. Never
paste it into chat, an issue, a pull request or a file.

The key is stored in Key Vault (Azure's secret store) as
`COMMUNITY-DAYS-API-KEY`. Only the server reads it; it never reaches a
browser.

### Set it for the first time

Do these in order. Steps 1 and 2 can be done before Community Days has
approved API access; steps 3 to 6 cannot.

1. **Confirm the Terraform run.** Open
   [the `hcw-azure` runs](https://app.terraform.io/app/hcw/workspaces/hcw-azure/runs)
   and find the run started by the merge of the #1823 pull request. Its plan
   should show **one change**: the Function App
   (`azurerm_function_app_flex_consumption.hcw`) is updated in place, and the
   only difference is one added app setting, `COMMUNITY_DAYS_API_KEY`, whose
   value is `@Microsoft.KeyVault(SecretUri=https://kv-site-prod-cus-01.vault.azure.net/secrets/COMMUNITY-DAYS-API-KEY)`.
   Nothing is created, replaced or destroyed. If the plan shows exactly that,
   confirm the run. **Confirming a run applies it to Azure**, so if it shows
   anything else, do not confirm; say what it shows on
   [#1823](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1823).
2. **Deploy the functions.** Open
   [the Deploy Functions workflow](https://github.com/saulpatinojr/HCW-HybridCloudWorks/actions/workflows/deploy-functions.yml),
   press **Run workflow**, leave the branch on `main`, and press the green
   **Run workflow** button. When the run is green, open
   [Speaking → Future Events](https://hybridcloudworks.com/admin/speaking?tab=apply).
   You should see "The Community Days key is not set yet". That is correct at
   this point.
3. **Wait for Community Days to approve API access**, then open
   [its developers page](https://www.communitydays.org/developers), go to
   **Your keys**, and make a key. It starts with `cdo_`. Note the day it
   expires, which that tab shows.
4. **Paste the key.** Open
   [Integrations → Keys](https://hybridcloudworks.com/admin/integrations?tab=keys),
   find the row **Community Days — API key** in the Content group, paste the
   key and save. The page tells you whether the new value is live at once or
   after the app recycles.
5. **Press Test.** Open
   [the Community Days card](https://hybridcloudworks.com/admin/integrations?tab=services&group=content)
   and press **Test**. You should see "Connected — the key works and API
   access is approved". If you see something else, find it in "What each
   message means" below.
6. **Record the key's date.** Open
   [Integrations → Credentials](https://hybridcloudworks.com/admin/integrations?tab=credentials),
   find `COMMUNITY-DAYS-API-KEY`, and record the day you made the key. That
   starts its reminder. Then tell a session the expiry day you noted in step
   3, so the reminder can use the real expiry in place of the 180-day rule.

The owner reported the key pasted on 2026-11-24, and `COMMUNITY_DAYS_API_KEY`
was then taken off the list of references that are expected to be unset
([`expected-unresolved.js`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/functions/src/lib/expected-unresolved.js)
on `main`). From then on the nightly check reports it as a fault if it stops
resolving, for example after the key is deleted from the vault.

To check from PowerShell that the app setting is in place (step 1 applied),
without reading the key:

```powershell
az functionapp config appsettings list -n func-site-prod-cus-01 -g rg-web-site-prod-cus -o json | ConvertFrom-Json | Where-Object { $_.name -eq 'COMMUNITY_DAYS_API_KEY' } | Select-Object name
```

It should print one row with the name `COMMUNITY_DAYS_API_KEY`. No row means
the Terraform run has not applied yet.

### Replace it

1. Make a new key on the **Your keys** tab of
   [the developers page](https://www.communitydays.org/developers).
2. Paste it on
   [Integrations → Keys](https://hybridcloudworks.com/admin/integrations?tab=keys),
   in the row **Community Days — API key**.
3. Press **Test** on
   [the Community Days card](https://hybridcloudworks.com/admin/integrations?tab=services&group=content).
   You should see "Connected".
4. **This step cannot be undone:** delete the **old** key on the **Your
   keys** tab. Do it the same day, because the old key can still change your
   events until it is deleted.
5. Record the new key's date on
   [Integrations → Credentials](https://hybridcloudworks.com/admin/integrations?tab=credentials).

### Revoke it (the key leaked, or you no longer want the feature)

1. **This step cannot be undone:** delete the key on the **Your keys** tab of
   [the developers page](https://www.communitydays.org/developers). That
   switches it off at once, everywhere. Deleting our copy would not: only
   Community Days can switch its own key off.
2. Check your events and your speaker profile on Community Days for changes
   you did not make.
3. If you still want the feature, follow "Replace it" from step 1. If not,
   leave it: the tab will say the key was not accepted, and nothing else on
   the site depends on it.

The site cannot delete a Key Vault secret, so the old value stays in the
vault until it is overwritten. Once the key is deleted at Community Days that
value is useless.

## What each message means

| You see | What it means | What to do |
| --- | --- | --- |
| "The Community Days key is not set yet" (the tab), or "No key yet" (the card's Test) | No key has been pasted, or the Terraform run that adds the setting has not applied | "Set it for the first time", above |
| "Community Days did not accept the key: it is missing, wrong, deleted or expired" (HTTP 401) | The key in the vault is not one Community Days accepts now | "Replace it", above |
| "API access is not approved for this account yet, or the account is blocked" (HTTP 403) | The key may be fine; Community Days has not approved (or has withdrawn) API access for your account | Nothing on this site. Check the developers page; do not make a new key for this |
| "Community Days is limiting how often this site may ask" (HTTP 429) | Too many requests in a short time | Wait. The site waits by itself for as long as Community Days asked |
| "The Community Days service failed on its side" (HTTP 500 and above) | A fault at Community Days | Try Refresh later; the last copy stays on the tab |
| "Community Days could not be reached" | No answer within 8 seconds, or the connection failed | Try Refresh later |
| "The answer from Community Days could not be read" | It answered, but not in the documented form | Try later; if it persists, the API may have changed: open an issue |
| "Showing the last copy that was read." before one of the above | The refresh failed and the list on screen is the older copy | As for the message that follows it |
| "This event was changed somewhere else since the page read it" | You, in another tab, or an estimate, saved this event after the page loaded it | Nothing was saved. The page has read the event again and the open form now shows the saved values (it says so). Make your change again, then press Save |
| "The acceptance estimate is switched off" | The **Speaking acceptance estimate** switch is off. No model was asked | Switch it on at [AI Engine → AI Services](https://hybridcloudworks.com/admin/ai-engine?tab=services), then press Estimate again |
| "The list was read from Community Days, but this site could not save its copy of it" | The site's own database refused the write | Wait five minutes and press Refresh. If it repeats, tell a session what the tab shows |
| "There are no talk topics to compare the event with" | The estimate found no topics, sessions or bio | Add them as "If Estimate is greyed out" says |
| "The model did not answer with a usable number" | The model replied without a number | Press Estimate again |
| "The estimate could not be made" with a reference | The model call or the save failed | Try again; give the reference to a session if it repeats |

The card's light on
[Integrations → Overview](https://hybridcloudworks.com/admin/integrations)
and the **Community Days** probe on the
[Health page](https://hybridcloudworks.com/admin/health) run the same Test.

## What is stored, and where

Everything is in the `admin_config` container of the site's database (no new
container was added):

- `community_days_cache`: the site's copy of the list (the fields above and
  the page text cut to 2,500 characters and 2,500 bytes), your talk titles as Community Days
  lists them, and when the copy was made. Public information from the
  directory; never the key.
- `community_days_event_<event id>`: one small document per event you saved
  something for: status, costs, notes, the estimate, and a small copy of the
  event (title, days, place) so it still means something after the event
  leaves the list.

Notes and costs are yours and are never written to a log. Each save, clear
and estimate leaves one row in the admin audit log with the event's id, and
never the notes' text.

## Assumptions not yet tested against the live API

The API was read from its public description without a key, so these come
from its documentation and have not been seen working:

- that an event's id (`RowKey`) is made of letters, digits, dots, dashes and
  underscores, at most 64 characters (the documented example is a GUID). An
  event with any other id is skipped;
- that `call_for_speakers=true` returns only events whose call is open now;
- the 401, 403 and 429 meanings in the table above, and that a 429 carries
  `Retry-After` in seconds;
- that an event's page on the site is `https://www.communitydays.org/event/`
  followed by its `slug`.

The first Test and the first Refresh with a real key are the check. If one of
these is wrong, say what the tab shows on
[#1823](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1823).

## References

- The API's own description:
  [OpenAPI file](https://api.communitydays.org/v1/openapi-events.json) and
  [field list](https://api.communitydays.org/v1/fields.md) (both public).
- [ADR 0045](../decisions/0045-community-days-events.md): why it is built
  this way.
- [Required inputs §4.6](../standards/required-inputs.md#46-key-vault-secrets-kv-site-prod-cus-01)
  and [Variables and secrets](../standards/variables-and-secrets.md): the
  key's rows.
