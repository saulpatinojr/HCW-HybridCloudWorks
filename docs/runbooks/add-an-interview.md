# Add an interview

> **Status: built (ADR 0040, proposed 2026-11-05).** An interview is made on
> the admin site, reviewed there, and published there; nothing is written to
> this repository and nothing is deployed per interview. All four parts of the
> plan are merged (the last, the admin pages, in
> [#1576](https://github.com/saulpatinojr/HCW-HybridCloudWorks/pull/1576)).
> They work on the live site once the owner has applied the storage change in
> HCP Terraform and deployed the functions and the frontend. Before this an
> interview was a JSON file in the repository and the only one was a made-up
> sample; both are gone. With no published interview the Azure landing page
> has no Interviews card and the sitemap has no Interviews page, on purpose.

**Scope:** how to get one interview from a recording (or a transcript) to its
page at `/azure/interviews/<name>`, and how to take it down again. The design
and the reasons are in
[ADR 0040](../decisions/0040-interviews-from-the-admin.md); the pieces and
who built them are in the
[slice plan](../architecture/interviews-slices.md).

**Authority:** publishing is yours and is done by a button; nothing publishes
by itself. The one thing this page does not change is the retention of the
recording (how long the site keeps it), which is a Terraform variable the
owner sets (see "Where the retention is set").

## What you get

For each interview the site serves, live from its database, with no deploy:

- **An article page** at `/azure/interviews/<name>` that holds the whole
  interview as plain text. This is the version search engines read, what a
  phone shows, and what a screen reader reads. It also gets a title, a
  description and an *Article* record for search results.
- **A "Book view"** for visitors on a wide screen who have not asked their
  device for less motion. It lays the same words out as pages that turn. It is
  an extra: the article is always there.
- **A card on the list page** at `/azure/interviews`, newest first, and an
  **Interviews** section on the Azure landing page once at least one is
  published.

What the site never shows: the recording, the transcript, the guest's
consent record, and who made the page. Those are the owner's records and
stay in the admin and in a private storage container.

## Before you start

You need, for the guest:

- their **name**, and if you like their **role** and two or three sentences
  about them (the bio);
- **their agreement to be published.** The form has one sentence and a
  checkbox: "The guest has agreed that this interview may be published on
  hybridcloudworks.com, and knows the recording is kept privately for the
  site’s records." Tick it only when that is true, and give the date they
  agreed. The site refuses to publish an interview without it, and records
  who ticked it (you, from your sign-in) and when;
- **one of three inputs:** the recording as a file (`.mp3`, `.m4a` or
  `.wav`, up to 500 MB; strictly 500 MiB, a little over), a link to the
  recording on a public site, or the
  transcript as text (a Plaud export works: its `Speaker 1:` lines are kept
  as speakers). A transcript skips the transcription step;
- an optional **photo** of the guest (PNG, JPEG or WebP, up to 15 MB) with a
  short description of what it shows, which a screen reader says.

## Make the interview

1. **Open the form.** Sign in to the admin and go to
   `https://hybridcloudworks.com/admin/interviews/new`. You should see the
   guest fields, the consent sentence with its checkbox and date, the
   optional photo, and "Where the interview comes from" with three choices.
   The page is also in the admin menu: **Interviews** under Pipeline, then
   **New interview**.
2. **Fill in the guest, the title and the consent, then choose one input and
   press Create interview.** A chosen file is checked at once: the form shows
   its length, and refuses a recording longer than 9 hours 30 minutes (split
   it into parts, one interview each) or one whose length it cannot read. The
   form creates the interview first, then runs the input you chose, then
   opens the interview's page at `/admin/interviews/<id>`. A file is sent in
   pieces of 4 MB with a percentage; if it stops part way, **Carry on
   uploading** sends only the pieces still missing. A closed tab stops it;
   reopening the interview's page lets you send the file again.
3. **Watch the stage.** The page shows where the interview is:

   | Stage | Meaning | How long |
   | --- | --- | --- |
   | `created` | saved, but no input has started yet | until you choose an input |
   | `uploading` | the file is still being sent from your browser | minutes, for a large file |
   | `fetching` | the site is downloading the recording from the link you gave | up to 10 minutes |
   | `fetched` | the recording is stored; the page starts the transcription by itself | seconds |
   | `transcribing` | the recording is being written down, an hour of audio at a time ("Working on hour 2") | up to 25 minutes, then the step stops as `failed` |
   | `transcribed` | the transcript is stored; the page starts the draft by itself when there are no questions yet | seconds |
   | `drafting` | the transcript is being turned into questions and answers, a part at a time for a long one ("Pass 2 of 3") | a few minutes |
   | `ready` | the draft is on the page for you to read | |
   | `failed` | something stopped; the page says what (see below) | |

   A pasted transcript goes from saving straight to `transcribed` and then
   `drafting`. The page checks again every five seconds while a step works;
   you can leave and come back. It never drafts again by itself once there
   are questions, because a new draft replaces them; that is your **Draft
   again**.
4. **Read every answer before you go on.** The draft is a machine's reading of
   a conversation. Three things are yours to check on the interview's page:
   - the **speakers**: the draft says which voice is the guest. If the page
     says it "could not tell for certain which speaker is the guest", check
     the answers against the transcript; if they are the interviewer's
     words, press **Draft again** (the page has no speaker picker yet);
   - any item marked **Check this answer**: the answer uses words the guest
     did not say in the transcript. Fix the words or remove the item, then
     press **I have checked answer N** and **Save questions and answers**;
   - the **pull quotes**: each is a sentence the guest said word for word, or
     it was dropped. You can add one by copying a sentence, word for word,
     from the transcript on the same page.

   The transcript is on the same page, so you can check an answer against
   it. "Transcribe again" writes a new transcript and keeps the old ones.
   "Draft again" replaces the questions and answers on the page; copy
   anything you want to keep first.
5. **Send it to review, then approve it.** The interview moves through the
   same statuses as a blog post: `draft` → `in_review` → `approved` →
   `published`. The buttons are the ones on every content page.
6. **Publish.** The Publish button checks three things and refuses with a
   sentence if one fails: the consent is ticked with a date that is not in
   the future (`CONSENT_REQUIRED`); the questions and answers fit the limits,
   one to forty, a question up to 240 characters, an answer up to 6000
   (`INVALID_INTERVIEW`); and the questions and answers together are at
   least 60 words. When it succeeds you should see the page's
   address, `/azure/interviews/<name>`, and the page is live within five
   minutes (the site caches the public read for that long).
7. **Look at it.** Open `https://hybridcloudworks.com/azure/interviews`. You
   should see the interview's card and, on its page, the article. On a wide
   screen a **Book view** button appears above it. The Azure landing page,
   `https://hybridcloudworks.com/azure`, has an **Interviews** section with an
   **All interviews** link.

## Take it down, or delete things

- **Unpublish.** The Unpublish button puts the interview back to `inspected`
  and the page answers "not found" within five minutes. Nothing is deleted:
  the recording, the transcripts and the draft stay, and you can publish
  again.
- **Delete the recording** (the "Delete recording" button; needs the
  publisher role). Each upload of a recording is its own file, so this
  deletes the one the interview uses now and every earlier one it replaced,
  and then every earlier version of each that the storage account kept;
  the transcripts stay, so the page still has its source. The interview's
  page then shows no recording, and the only way to bring one back within
  seven days is the account's soft delete, which keeps a deleted file for
  that long. The account keeps file versions, so undeleting takes two steps
  ([Microsoft Learn: restore soft-deleted blobs when versioning is enabled](https://learn.microsoft.com/azure/storage/blobs/soft-delete-blob-manage#restore-soft-deleted-blobs-when-versioning-is-enabled)):

  1. In the Azure portal open the storage account `stsiteprodcus01`
     (resource group `rg-stor-site-prod-cus`), then **Containers**, then
     `interviews-audio`, and turn on **Show deleted blobs**. You should see
     the file greyed out. If it is not there, the seven days have passed and
     the recording is gone.
  2. Open the file and press **Undelete** on its **Overview** tab. This
     brings back its versions, not the file itself.
  3. Open the **Versions** tab, pick the newest version and press **Make
     current version**. You should now see the file listed normally. The
     interview's page still shows no recording, because the delete cleared
     the document's pointer to it; ask whoever changes the code to re-attach
     it.

- **Delete the interview** ("Delete permanently" on the Archive board, after
  archiving it). The document, every recording and every transcript go, the
  same way; the site first marks the interview as being deleted, so an
  upload finishing at that moment is refused or swept up too. An interview
  that was never published has no Archive entry; how
  a draft is removed from the Editor list is not written down here, so ask
  whoever changes the code rather than guess.

## Where the retention is set

The recording is kept for **365 days** from its upload, then deleted by a
rule on the storage account (the transcripts are kept). The number is the
Terraform variable `interview_audio_retention_days` in
[`infra/variables.tf`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/infra/variables.tf)
(1 to 3650). To change it the owner sets the variable in HCP Terraform's
variables for the workspace and confirms the run; a session never applies
it. The deletion the rule does is not reversible after the seven-day soft
delete.

## When a stage says `failed`

The page shows a short code. What each means and what to do:

| Code | What happened | What to do |
| --- | --- | --- |
| `BUDGET_EXCEEDED` | this month's transcription spend would pass the ceiling (10 USD unless the owner raised `INTERVIEW_TRANSCRIPTION_MONTHLY_USD`, a setting on the site's Function App that only the owner changes) | wait for next month, paste a transcript instead, or ask the owner to raise the ceiling |
| a fetch error | the link was not `https://`, pointed at a private address, redirected too often, was larger than 500 MB, or was not an audio file | check the link in a browser; upload the file instead |
| `INVALID_DRAFT` | the draft did not come back in the expected shape twice | press "Draft again"; if it fails again, the transcript may be too short or garbled |
| a provider error (`408`, `429`, `5xx`, or `400`, `401`, `403`) | the transcription service refused or was down | `408`, `429` and `5xx` are retried three times already; press "Transcribe again" later. `400`, `401` or `403` is for the owner (a key or request problem). The exact code the page shows is set by the transcription step (slice B) |

A failed step never touches what came before it: the recording and any
earlier transcript are still there.

## What to expect, and what to check if it is wrong

- **The card and the search listing lag the page.** The page is live within
  five minutes. The Azure landing card and the sitemap entry follow the next
  run of the daily content manifest and a frontend deploy, exactly as a blog
  post does.
- **There is no Interviews link in the top menu, on purpose.** The menu is a
  fixed row of nine slots, and a tenth link overflowed it
  ([#1337](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1337)).
  The pages still keep the Azure menu while you read them.
- **The Book view button is missing on your laptop.** That is by design if the
  window is narrower than 768 pixels, or if the device is set to reduce motion.
- **The page says "not found" for an interview you published.** Either it was
  unpublished, or the document fails the page's checks (a link that is not
  `https://`, a picture without its description). The admin page shows the
  same checks when you save, so fix the field there.
- **Logs.** Nothing the guest said reaches a log: the logs carry ids, counts,
  bytes and durations. If you are asked for evidence, that is the sentence
  to give.

## How it works, for whoever changes the code

- **The content type.** An interview is a `content` document with
  `type: 'interview'` on the one status machine
  (`functions/src/lib/cms/content-status.js`); its contract
  (`publish-contracts.js`) gives it the section `interviews`, so the
  published address is `/azure/interviews/<slug>`. The publish pipeline
  (`cms/publish.js`) refuses it without consent or with a bad Q&A before the
  ordinary gates (`functions/src/lib/interviews/publish-gate.js`,
  `consent.js`), and the daily forge never picks one up
  (`timers/forge-scheduled.js`).
- **The admin routes.** `POST/GET cms/interviews`, `GET cms/interviews/{id}`
  (the document and its transcript) and `DELETE cms/interviews/{id}/audio`
  are `functions/src/lib/interviews/admin.js`; edits go through
  `updateContentItem`, which checks interview fields against the schema
  (`content-update-validation.js`). The upload, fetch, transcribe and draft
  routes are the other slices'.
- **The public routes.** `GET public/interviews` and
  `GET public/interviews/{slug}` in `functions/src/lib/public-reads.js`
  answer allow-listed fields only; the test pins the lists against the
  page's own validator, `frontend/src/lib/interviews.js`.
- **The pages.** `frontend/src/pages/azure/InterviewsPage.jsx` reads the two
  routes live; the pre-render seeds the same keys from the content manifest
  (`scripts/build-content-manifest.mjs`, `frontend/scripts/prerender.mjs`),
  so a built page carries the whole interview and the list page exists only
  once there is one.
- **Where the files are.** Each upload is its own blob,
  `audio/<interview id>/<upload id>.<ext>`; the document points at the
  current one (`provenance.audio.path`) and lists the ones it replaced
  (`provenance.audio.superseded`). Transcripts are
  `transcripts/<interview id>/v<n>.json`.
- **Deleting.** `deleteBlobWithVersions` in `interviews/admin.js` deletes a
  blob and then every version of it, because the account keeps versions and
  a plain delete would leave the recording as a previous version for up to
  30 days. "Delete recording" deletes the current recording and every
  superseded one, and only paths shaped like this interview's own. Deleting
  the interview (`deleteContentItem`) first writes a tombstone,
  `provenance.audio.deletedAt`, under the document's ETag (the version stamp
  that makes a write fail if someone else wrote first), deletes the document
  under the tombstone's ETag, and then sweeps the whole `audio/<id>/` and
  `transcripts/<id>/` folders, so a recording an upload committed in the
  moment between is removed too (`lib/interviews/tombstone.js`).
- **The permission behind the version deletes.** Deleting a version needs
  the `deleteBlobVersion/action` data action, which Storage Blob Data Owner
  holds ([Microsoft Learn: blob versioning, authorize operations](https://learn.microsoft.com/azure/storage/blobs/versioning-overview#authorize-operations-on-blob-versions)).
  The upload slice grants the Function App that role on the
  `interviews-audio` container alone (`func_interviews_audio_owner` in
  [`infra/storage.tf`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/infra/storage.tf)),
  and it takes effect when the owner confirms that HCP Terraform run. Before
  then each version delete answers 403, is counted and logged by code, and
  the account's `expire-noncurrent-versions` rule removes the version within
  30 days; the base delete still happens, so the recording stops being
  current at once.
- The book is built with CSS in this repository, with no library. The usual
  flip-book package was last released in April 2021 (owner decision,
  2026-10-24).
- The book's pages use a fixed paper colour and fixed text and link colours,
  not the site's theme classes, because the theme rewrites `bg-white` inside
  a provider page and the dark theme made the pages unreadable.
