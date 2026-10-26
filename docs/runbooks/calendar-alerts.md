# Calendar Alerts

> **Status: in use from the deploy that follows its merge.** Owner request of
> 2026-10-26: "Calendar Alerts when I log into the Admin portal", then, the same
> day: "we already have a calendar in the admin portal so maybe we can build off
> of that". So alerts are a part of the admin **Calendar** page, not a page of
> their own. The first alert, the Docker-Sponsored Open Source application due
> on 2026-10-30
> ([#678](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/678)), is
> created by the portal itself, so nobody has to type it.

**Scope:** what Calendar Alerts are, how to use them on the Calendar page, what
the sign-in pop-up does and when, how the first alert gets made, where the data
lives and why, and what to do when something looks wrong.

**Authority:** this page changes nothing by itself. Every step below is done in
the admin portal, by a signed-in admin with the **editor** role or above.

## What it is

A calendar alert is a note to yourself with a day on it: a title, a due day, an
optional time, an optional link, and a short note. You see it in two places on
the Calendar page, and, when it is due soon, in a pop-up when you sign in.

Calendar Alerts are **not** the same as the reminders sheet. The sheet
([Platform Settings → Reminders](https://hybridcloudworks.com/admin/platform-settings?tab=reminders))
is read by a daily timer that sends you a Telegram message; an alert is only
ever shown inside the admin portal, and it can be snoozed. They are kept apart
on purpose, so changing one cannot change what the other says.

## Where to find it

Everything is on the Calendar page,
[`/admin/calendar`](https://hybridcloudworks.com/admin/calendar) (menu:
**Calendar**, in the **Amplify** group). There is no second menu entry.

- **On the calendar itself.** An alert is an orange chip with a bell and the
  word **Alert**, on its due day, in the month, week and agenda views. Press it
  to open it. The toolbar's **Kinds** buttons can show or hide alerts, and the
  **Status** list can pick *open*, *snoozed* or *done*.
- **In the Calendar alerts panel**, under the calendar. It lists every alert,
  with filters, and is where you add, edit, finish, snooze and delete them.

## What you see when you sign in

1. Sign in at [`/admin`](https://hybridcloudworks.com/admin) as usual. The
   portal opens first; nothing waits for the alerts.
2. A moment later, if something is due, a window titled **Calendar alerts**
   opens. It lists each open alert that is overdue or due within 7 days,
   soonest first, with how many days that is.
3. For each alert you can press:
   - **Done**: you have dealt with it. It leaves the list.
   - **Snooze: 1 day, 3 days or Next week**: hide it for that long. It comes
     back on its own when the day arrives.
   - **Open link** (or **Open page** for a page in the portal): go to the place
     the alert points at. The button names the site, for example
     "Open link (docker.com)".
4. **All alerts** opens the Calendar page at the alerts panel. **Close for
   today** (or the **Esc** key) closes the window and changes nothing.

The window opens **at most once per browser session and once per day**. If you
close it and sign in again the same day, it stays closed; the alerts are still
on the Calendar, and the pop-up is back tomorrow if they are still due. It
never appears on the public site, only inside the portal.

If the alerts cannot be read (the service is slow or down), the portal still
opens normally and a small notice in the bottom-left corner says so, with a
**Try again** button. That notice is the whole effect.

Keyboard users: focus goes to the window itself when it opens (so a key you
were pressing cannot finish an alert), stays inside it until it closes, **Esc**
closes it, and focus goes back to where it was.

## Add, change and finish alerts

On the Calendar page, in the **Calendar alerts** panel:

1. Press **Add alert**.
2. Fill in **Title** and **Due date**. The day and the time are in **UTC**
   (the world's standard time, which does not move for daylight saving), the
   same clock the rest of ContentForge uses.
3. Optionally add a **Time**, a **Link** and a **Note**. A link must start with
   `https://` (plain ASCII letters; an address with an accented letter has to be
   written in its encoded form), or be a page in the portal such as
   `/admin/health`. The note is limited to 500 characters; do not put passwords
   or keys in it.
4. Press **Add alert**. You should see "Alert added", the alert in the list, and
   its orange chip on the calendar above.

Each row has **Done** (or **Reopen** once finished), the three **Snooze**
buttons, **Edit**, and **Delete**. Delete asks first, because it cannot be
undone. The buttons above the list filter it: **Open**, **Due soon**,
**Snoozed**, **Done** and **All**, each with a count. The same actions are in
the window that opens when you press an alert's chip on the calendar, and a
change in either place shows in the other.

An alert is never scheduled, published or posted: the calendar's reschedule,
unschedule, share and cancel actions are not offered for it.

## The first alert (the Docker application)

The portal makes one alert for you, once:

| Field | Value |
|---|---|
| Title | Submit the Docker-Sponsored Open Source application |
| Due | 2026-10-30 |
| Link | <https://www.docker.com/community/open-source/application/> |
| Note | Text is ready to paste in the Doc Vault note: Docker DSOS application |

**How it gets there.** The first time an editor or above opens the admin portal
after the deploy, the portal asks the server for the alert list, and the server
creates this alert if it has never been created. Nobody runs a command. The
server writes down, in the same document, the ids of every alert it has ever
made for you. (The calendar grid also shows it from that moment, even if the
grid happened to be read first, without writing anything.)

**Why it will not come back.** If you mark it **Done** it stays as a finished
alert. If you **Delete** it, the server removes it and keeps its id in that
written-down list in the same save, so the next read does not make it again.
Reading the list a second time changes nothing.

**To see it after the deploy:**

1. Sign in at [`/admin`](https://hybridcloudworks.com/admin) with an editor,
   publisher or super admin account.
2. You should see the **Calendar alerts** window with the Docker application at
   the top. If you opened the portal earlier today on this browser, the window
   stays closed (once per day), so go to step 3.
3. Open [`/admin/calendar`](https://hybridcloudworks.com/admin/calendar),
   go to October 2026 and look for the orange **Alert** chip on the 30th, and
   find the alert in the **Open** list of the panel under the calendar. If it is
   missing, press **All**; if it is still missing, see "When something looks
   wrong" below.

## Download for your own calendar

**Download .ics** in the panel saves a calendar file of every alert that is not
done, to your computer. Import it into Outlook, Google Calendar or Apple
Calendar. The file is built in your browser from what the page already holds
and is never stored on a web address, so nobody else can fetch it. An alert
with a time becomes a 30-minute event at that UTC time; one without becomes an
all-day event. The format is
[RFC 5545](https://www.rfc-editor.org/info/rfc5545/). Once imported into an
online calendar, the alerts in it belong to that calendar and are no longer
private to this portal.

## Why the alerts have a store of their own

The Calendar page has no storage of its own: it is a read-only union of other
records' dates (content schedules, newsletter sends, social posts, talks,
certifications and so on), each read by one small function
(`functions/src/lib/calendar/collectors.js`). Alerts join it the same way, as
the kind `alert`
(`functions/src/lib/calendar-alerts/collector.js`), with the same role
(**editor**) and the same route (`GET cms/calendar`). What they do not share is
a container, because the records the Calendar already shows are the ones other
machinery acts on:

- A content record with a `scheduledPublishDate` is published by the scheduled
  publisher every fifteen minutes.
- A social post with a `scheduledAt` is pushed to Publer, and reconciled with it
  every five minutes.
- A newsletter issue with a `scheduledAt` is a broadcast scheduled with Resend, which sends it.

An alert stored as any of these could be published, posted or sent. So alerts
sit in one private document, `admin_config/calendar_alerts`, which none of that
machinery reads, and the Calendar read has no way to write to it (the route is
handed only read functions).

## Who can see them

Only signed-in admins with the **editor** role or above, through the admin
service. The alerts live in one document in the private `admin_config`
container, which no public route reads: the public content routes, the content
manifest used to prerender pages, the feeds, the sitemap, the newsletter and
the social queue all read other records by name. Tests hold that:

- `functions/src/lib/calendar-alerts/privacy.test.js` runs every public handler
  against a store that hands back the alerts document to any read of
  `admin_config` and fails if a word of it appears, and fails if any other
  source file even names the alerts (the Calendar read's three files excepted).
- `functions/src/lib/calendar-alerts/collector.test.js` proves that reading the
  Calendar with an alert in it writes nothing, and that the scheduled publisher
  only ever queries `content`, publishes nothing for an alert that is due, and
  patches nothing.
- `frontend/src/lib/calendarAlerts.public.test.js` fails if a public page's
  code could import the alerts, or if a menu entry or route of their own comes
  back.

**It is one shared list, on purpose.** The owner's brief was "editor role and
above", so every admin at that level sees, changes and deletes every alert, and
an alert's link opens when someone presses it. That is why the button names the
site. If alerts should become the owner's alone, raise `CALENDAR_ALERTS_ROLE` in
`functions/src/lib/calendar-alerts/handlers.js` and the `'editor'` checks in the
pop-up and its gate together.

Notes, titles and links are never written to a log. The audit record for a
change (`admin_audit_logs`) holds the alert's id, whether it is open, snoozed or
done, who did it and, for an edit, the **names** of the fields that changed
(such as `link` or `note`), never their words.

## How it is built

For whoever maintains it:

| Part | Where |
|---|---|
| Alert routes | `GET` and `POST` `cms/calendar-alerts`; `PATCH` and `DELETE` `cms/calendar-alerts/{alertId}`, all editor and above (`functions/src/functions/calendar-alerts-http.js`, `functions/src/lib/calendar-alerts/handlers.js`) |
| On the Calendar | The kind `alert` in the `GET cms/calendar` read (`functions/src/lib/calendar-alerts/collector.js`, registered in `COLLECTORS`); the Alert chip, its colour and its statuses in `frontend/src/components/admin/calendar/calendarModel.js`; its actions in `frontend/src/components/admin/calendar-alerts/AlertPreviewBody.jsx` |
| Data | One document, `calendar_alerts`, in `admin_config` (partition `admin_config`), holding `alerts` and `seeded`. No new container. |
| Writes | Read, change, write back under the document's ETag; a lost race reads again and re-applies, up to five times, then answers 409 |
| Starting alerts | `SEED_ALERTS` in `functions/src/lib/calendar-alerts/model.js`; persisted by the first list read, create-only, by fixed id |
| Pop-up | `frontend/src/components/admin/calendar-alerts/CalendarAlertsPrompt.jsx`, loaded lazily by `CalendarAlertsGate.jsx` from the admin layout |
| Panel | `frontend/src/components/admin/calendar-alerts/CalendarAlertsPanel.jsx`, on `frontend/src/pages/admin/CalendarPage.jsx` |
| Backup | `admin_config` is class B (weekly full plus daily changes), so the alerts are in the existing backup |

To add another starting alert, add an entry to `SEED_ALERTS` (a fixed `id`, a
title, a due day and, if wanted, a link and a note) and deploy: the next list
read creates it once. Seeds are public (this repository is), so a seed carries
nothing private. To stop one being made, remove its entry before it has been
read.

## When something looks wrong

| You see | What it means | What to do |
|---|---|---|
| A small notice, "Calendar alerts could not be loaded just now" | The portal opened, but the alert list could not be read | Press **Try again**. If it keeps failing, check [Health](https://hybridcloudworks.com/admin/health) and the function app's logs. |
| On the Calendar: "Some sources could not be read … alert: could not be read" | Only the alerts failed; the rest of the calendar is fine | Reload. The same cause as the row above. |
| "Your role cannot open calendar alerts" | The account is a viewer | Ask a super admin to raise the role to editor. |
| "The alerts changed while this was being saved" | Two tabs saved at once and five tries all lost | Reload the page and make the change again. Nothing was lost. |
| "There are already 300 alerts" or "too large to save any more" | The list is full | Delete finished alerts (**Done** filter), then add again. |
| The pop-up did not open | It had already opened today or in this session, or nothing is open and due within 7 days | Open the Calendar. This is by design. |
| The Docker alert is missing | The list has not been read since the deploy, or it was deleted or finished | Open the Calendar page and press **All** in the panel. A deleted one is not made again; add it by hand. |

## Rollback

Revert the pull request that added it and deploy. The alerts document stays in
`admin_config` and does no harm: after the revert no part of the application
reads it (the weekly backup copies it, as it copies every document in that
container). To remove the data as well, delete the item `calendar_alerts` from
the `admin_config` container in the portal's Cosmos data explorer.
