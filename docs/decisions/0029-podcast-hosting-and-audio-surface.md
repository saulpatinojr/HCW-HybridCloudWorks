# ADR 0029: Podcast hosting is Podbean, the podcast page is the one audio surface, and the media route serves byte ranges

**Status:** Accepted 2026-09-07; §1 and §2 amended 2026-09-08 (§1b, §2a); §2a scoped 2026-09-09 (§2b); §2a amended 2026-09-26 (free plan for testing, publish blocked), and again 2026-09-26 (the owner picks the podcast voices by ear, #725); §2a noted 2026-09-27 (the last sample replays free; a render asks first); §1 amended 2026-10-13 (§1c: the show moved from RSS.com to Podbean, and publishing with it)
**Decision date:** 2026-09-07
**Owners:** Workload owner

## Context

The show's previous host retired its feed on 2026-09-05: the feed answered
HTTP 410 (#348) and the host's CDN answered 404 for every stored episode
(#372). The ingest timer stopped polling, the public list hid rows whose
media was gone, and the site was left with two audio systems that did not
meet:

| System | Source | Storage and delivery | Reaches Spotify and Apple? |
| --- | --- | --- | --- |
| Podcast pages (`/azure/podcast` and the other providers) | `fetchPodcastFeeds` ingests a host's RSS feed into `podcasts` | Media stays on the host's CDN; the page plays the enclosure URL | Yes, through the host |
| Listen & Learn (certification pages) | `listen-and-learn/generate.js` writes a two-host script, `speech/index.js` synthesises it, `mp3.js` encodes 64 kbps mono | Blob storage, served by `GET /api/public/media/…` | No; the episodes existed only on the certification pages |

Issue #349 evaluated the replacement stack on 2026-09-05: RSS.com for
hosting, ElevenLabs for speech, StreamYard for recording. The findings that
shaped this record:

- **RSS.com** distributes to the directories on every plan. Upload is manual
  on the Free plan; API access — the only route to publishing from the site
  — is on the Max plan at USD 37 a month, and the API was in public beta with
  a warning that endpoints may change.
- **ElevenLabs** produces the dialogue format Listen & Learn already uses and
  emits the stored MP3 shape directly, at about USD 4 per certification on
  the v3 model. Commercial use requires a paid plan.
- **StreamYard** has no public API and no RSS hosting by design. It records;
  a host distributes.
- The media route buffered whole blobs and ignored `Range`, so a seek into a
  Listen & Learn episode downloaded everything before it, and a self-hosted
  feed was ruled out because Apple requires byte-range support of an
  enclosure host.

The owner's decision on 2026-09-07 was **no paid upgrades**. That held for one
day: on 2026-09-08 the owner approved both ElevenLabs and RSS.com Max. Those
amend §1 and §2 below rather than replacing this record, because the reasoning
that produced the Free-plan design is still the reasoning the paid design has to
beat — §1b and §2a say what changed and, more importantly, what did not.

## Purpose and decision drivers

- **Cost.** The platform bills in the tens of dollars a month under a USD 150
  ceiling (ADR 0015). On 2026-09-07 a podcast publishing a handful of episodes
  a month did not justify USD 37 a month for an upload the owner could do by
  hand, or a speech subscription when the configured provider was effectively
  free. The ceiling has not moved; what changed on 2026-09-08 is what is being
  weighed against it (§1b, §2a).
- **Reliability of the public surface.** Whatever the host does, a visitor to
  `/azure/podcast` should find every episode the site has and be able to
  play and seek it. Two disconnected audio systems, one of which had just
  gone dark, was the failure this repairs.
- **Reversibility.** Every choice here must be undoable by a configuration
  change or a small addition, not a migration: the host is a document in
  `admin_config`, the speech provider is an environment variable, and the
  self-hosting path is a route that does not yet exist rather than one that
  cannot.
- **Operational excellence.** The witness for ingest stays what it was — a
  fresh `updatedAt` on `podcasts` at the two-hour firing — and the page's RSS
  button and the timer's ingest read the same document, so they cannot name
  two different feeds.

## Decision

### 1. Hosting: RSS.com, and the feed is the integration boundary (plan and upload amended in §1b, host in §1c)

**Decided 2026-09-07; the plan, the upload and the API claim amended by §1b.**
The show lived on RSS.com's Free plan, and episodes — human recordings and
generated ones alike — were uploaded by hand in the RSS.com dashboard. Nothing
in the repository knew the host's API, and at that date nothing needed to.

**The ingest half of this decision is unchanged and §1b keeps it deliberately.**
The site ingests the show's public feed exactly as it ingested the previous
host's: `fetchPodcastFeeds` reads `admin_config/podcast_feeds`
(`{ feeds: [{ provider, url }] }`, #348) every two hours and upserts one
`podcasts` row per episode. That is still the only way an episode reaches the
site, whoever uploaded it and however.

The owner seeds the feed URL into `admin_config/podcast_feeds` through the
admin platform page. `PODCAST_FEEDS` in `timers/podcasts.js` stays empty;
the host is data, not code.

#### 1a. The show is the site's, not a provider's — amended 2026-09-07

The show that exists is **Hybrid Cloud Insights**
(`https://media.rss.com/hybrid-cloud-insights/feed.xml`), and it belongs to
hybridcloudworks.com rather than to Azure or AWS. The document had no place to
say that: every row in `feeds` is keyed by provider, so seeding the show under
one provider would have hidden it from the other seven pages and mislabelled it
on the one.

**The document grows a field, the run grows a reserved provider.**
`admin_config/podcast_feeds` becomes
`{ mainFeedUrl, feeds: [{ provider, url }] }`. `mainFeedUrl` is a separate
field, not a row, because the two are not the same kind of value and because a
document written before it existed still reads correctly — `feeds` is
untouched, and a Functions revision that predates this change ignores the new
key rather than fetching it as a provider. Inside a run, though, it is an
ordinary entry: `resolvePodcastFeeds` returns it first, under the reserved
provider `main`, so the ingest loop, the dedupe, the 410 handling and the
summary line all work on it unchanged, and the episodes it writes carry
`provider: 'main'`.

A reserved value rather than a new field on the episode, because every
consumer of `podcasts` already keys on `provider`: the container's composite
index is `provider + publishedAt`, the public list filters on it in SQL, and
the section counts read it. A row with no provider would be fetched by no query
and counted by nothing — invisible in exactly the way the empty audio pages
were.

**Consequences that had to be decided rather than discovered:**

- `GET /api/public/podcasts?provider=` returns
  `c.provider IN (@provider, @mainProvider)` — one query, so a show episode
  arrives once. It appears on every provider's page and is duplicated on none,
  because `main` is a value `c.provider` takes rather than a copy of a
  provider's row.
- The page leads with it. `mergeAudioEpisodes` orders the show first as a
  group, each group newest first, so the featured player on every provider page
  plays the newest episode of the show. Source chips and the source filter gain
  a third entry, built from the sources a page actually has rather than a fixed
  pair.
- The RSS subscribe button falls back: the provider's own feed where it has
  one, the show otherwise. `GET public/podcasts` returns both URLs and
  `useAudioEpisodes` chooses, because the hook is what knows which rows the
  list is showing.
- **The section counts had to move with it (#373, #404).** A show episode is
  counted for EVERY provider's `audio` and `audio-architecture`, because every
  provider's audio page shows it. It is not put in `_unattributed`: that bucket
  means "we do not know which pages this reaches", and here we do. So the
  sixteen audio URLs #404 dropped from the sitemap return the moment one show
  episode is ingested and the manifest is refreshed — a page with content that
  is not advertised is the mirror image of the bug #373 fixed.
- Two writes are refused rather than resolved: `main` as a provider row, and a
  provider row repeating the main feed's URL. The second matters more than it
  looks — both ingests build the same episode ids from the same guids, so each
  run would overwrite the other's `provider` and an episode would flip between
  the show and a provider every two hours.

Nothing about hosting changed with 1a. As of 2026-09-07 the upload was still
manual and the host's API still not integrated; §1b changes both. The feed being
the integration boundary is the part that outlived them, and §1b keeps it
deliberately.

#### 1b. RSS.com Max is approved; publishing becomes an API step — amended 2026-09-08

The owner approved the Max plan on 2026-09-08, meeting half of the trigger this
record wrote for itself — "only if the automated publish step is wanted and the
API has left beta". The other half is a fact about the API rather than about the
budget, so it is checked before code is written rather than assumed: #349 found
the API in public beta on 2026-09-05, warning that endpoints may change. If it
still is, that is a constraint to design against and not a blocker — an
idempotent, retryable publish whose failure does not un-approve the episode, and
the manual path left intact underneath it.

**What changes.** Approving an episode uploads it to RSS.com. The manual
dashboard upload stops being the only way an episode reaches the feed, which is
what the Consequences section below called "the cost of ownership of the Free
plan, and it is the whole cost". That was costed against one source of episodes.
#432 adds three (#433, #434, #435), and a per-episode manual step scales with
the number of things producing episodes.

*Landed 2026-09-09 for one of the three sources.* Approving a podcast
transcript — `POST cms/podcast/transcripts/review` moving a
`podcast_transcripts` document to `published` — now queues the
`publish-podcast-transcript` job, which uploads the transcript's MP3 and
creates (or, on a re-run, updates) the RSS.com episode; the outcome lives on the
document under `host.rsscom`, the retry is
`POST cms/podcast/transcripts/{id}/publish`, and a publish that fails or is
skipped (no audio, RSS.com not configured) leaves the approval as written.
Listen & Learn episodes do **not** publish yet: whether the exam-prep playlist
belongs on the show at all is the fourth decision still open on #349, and
`setEpisodeStatus` on `listen_and_learn_episodes` runs no host step until it is
made.

**What does not.** The feed is still the integration boundary. The site learns
about a published episode by ingesting the show's feed into `podcasts`, exactly
as it does for an episode uploaded by hand — not by writing the row at publish
time from what it just uploaded. That shortcut is tempting and wrong: it creates
a row the feed did not produce, and when the two disagree there is no longer a
single answer to what is published. The accepted cost is a visible lag between
approval and appearance, which the admin surface explains rather than leaving an
operator refreshing.

**Generation still does not publish.** `setEpisodeStatus` moving an episode to
`published` is the trigger, never the end of a generation run. Drafts are
AI-written content going out under the owner's name; the review gate is why the
Consequences section says episodes land as drafts, and an automated publish path
must not route around it.

Tracked by #437.

#### 1c. Podbean replaces RSS.com — amended 2026-10-13

**What happened.** The show moved from RSS.com to Podbean on 2026-10-13.
RSS.com's feed URL answers `301` into Podbean's, and the episode GUIDs came
across unchanged, so the `podcasts` rows the ingest built from the old feed are
the rows the new feed produces — the move makes no duplicates. The feed now
lives on the owner's domain, `https://podcast.hybridcloudworks.com/feed.xml`,
served by Podbean behind a DNS-only CNAME (#1110); read on 2026-10-13, it
answers `200` and its own `atom:link rel="self"` names that URL. So the next
host move is a DNS change rather than a new URL for every subscriber. The Main
feed field on `/admin/platform` (`admin_config/podcast_feeds.mainFeedUrl`)
names that URL: the public podcasts API reported it as `mainFeedUrl` on
2026-10-13. The old URL's chain of `301`s is a courtesy to subscribers, not
something the ingest leans on.

**RSS.com's API path never ran.** RSS.com Max was never bought — the owner
deferred it on 2026-09-18 (#432) — so `RSSCOM-API-KEY` and `RSSCOM-PODCAST-ID`
were never seeded and every approval §1b queued was recorded as
`host.rsscom.skipped = 'not_configured'`. Nothing was published through that
client, and nothing needs migrating: the RSS.com client, its tests, its two
app settings and its two Key Vault references are removed, and no code reads
`host.rsscom` any more.

**Publishing now uses Podbean's API.** Same job, same trigger, same retry:
approving a podcast transcript still queues `publish-podcast-transcript`, the
retry is still `POST cms/podcast/transcripts/{id}/publish`, and a publish that
fails or is skipped still leaves the approval as written. What changed is the
host step (`functions/src/lib/podcast/podbean.js`, read against Podbean's own
API documentation data on 2026-10-13):

- **Credentials** are a Podbean developer app's client ID and secret
  (`PODBEAN-CLIENT-ID`, `PODBEAN-CLIENT-SECRET`; app settings
  `PODBEAN_CLIENT_ID`, `PODBEAN_CLIENT_SECRET`), exchanged for an access token
  with the client-credentials grant. The token is cached for its stated life
  less a minute and travels as Podbean's documented `access_token` parameter;
  no error, log line or recorded failure carries it, the secret, or a URL
  holding either.
- **Upload** is `GET /v1/files/uploadAuthorize` for a presigned URL and a
  `file_key`, then a `PUT` of the MP3 to that URL with no token.
- **The episode** is `POST /v1/episodes` with `status: 'publish'` and
  `type: 'public'` — the site's approval is the review, so an approved episode
  goes out at once, as it would have on RSS.com — and its notes as HTML: the
  summary, the key takeaways, and a link to the article where there is one,
  because Podbean has no separate link field. A re-run updates the episode the
  document names (`POST /v1/episodes/{id}`) and never creates a second.
- **No retries of the create.** The one repeat the client makes is a call
  refused with `invalid_token`, once, with a fresh token: a request refused for
  its token created nothing.
- **The outcome** lives under `host.podbean` — `episodeId`, `permalinkUrl`,
  `mediaUrl`, `hostStatus`, `audioPath`, `fileKey`, `publishedAt`,
  `lastAttemptAt`, `error`. Podbean returns no guid, so none is recorded.
- **The Integrations page's beaker** makes one token exchange and then
  `GET /v1/podcast`, the only probe with an exchange step, and still records
  no key verdict: a refused exchange could blame either value.

**What does not change.** The feed is still the integration boundary: the site
learns of a published episode by ingesting the show's feed, never by writing a
`podcasts` row from what it just uploaded. §1b's reasoning holds word for word
with Podbean in RSS.com's place, and so do §2a's free-plan publish block and
§2b's scope, which name RSS.com as the place an episode is published to.

**Podbean is not new to this record.** It is the host the Context section calls
the previous one: its feed and CDN for the show's earlier incarnation went dark
on 2026-09-05 (#348, #372), which is why `public-reads.js` treats media on
Podbean's CDN as retired. With the show back on Podbean, a host alone no
longer says whether media is gone, so the retired-host rule becomes a host and
a moment (#1113). Podbean's MCP server is also offered in the AI Engine
(#1114), as a tool for the owner rather than part of this publish path.

### 2. Speech: providers selected by key presence, in a stated preference order (order amended in §2a, made per product in §2b)

**Decided 2026-09-07; superseded by §2a below.** `speech/index.js` keeps its
order: Gemini TTS when the `GEMINI_API_KEY` app setting is present — a Key Vault
reference to the `GEMINI-API-KEY` secret, which is why the two spellings differ
(`infra/functionapp.tf`) — Azure AI Speech as the fallback, pinnable with
`LISTEN_AND_LEARN_TTS_PROVIDER`. ElevenLabs was not
added: its commercial licence requires a paid plan, and at that date the owner
had declined paid services. The provider switch rejects `elevenlabs` by name in
its tests, so the shape a third provider takes was recorded and the trial was a
bounded piece of work for when a plan was approved.

#### 2a. ElevenLabs is selected — amended 2026-09-08 (scope corrected in §2b)

*Kept as written on 2026-09-08, as history. It was written as if ElevenLabs
replaced Gemini for Listen & Learn — "it is the provider that runs" for every
episode — which was wrong; §2b below records what the owner actually decided.*

The owner approved a paid ElevenLabs plan on 2026-09-08. The trigger this record
wrote for itself — "Revisit ElevenLabs when a paid plan is approved" — is met
literally, so the deferral above is superseded rather than argued with.

**What changes.** A third entry in `PROVIDERS`, selected when its key is
present, under the same contract as its siblings: MP3 out, so the blob path, the
stored `contentType` and the player are untouched and the provider stays an
implementation detail of that directory. The test asserting `elevenlabs` is not
a configured provider was the record of the deferral; it is replaced by tests of
the provider rather than deleted quietly.

**What the preference order has to answer.** Gemini is first today because it
costs nothing beyond a key already seeded, and Azure AI Speech is kept because
every Gemini TTS model is a *preview* model and preview endpoints get retired on
notice. Paying for ElevenLabs changes the first half of that reasoning and none
of the second. So it runs when configured — it is what the owner is paying for
and chose — and Gemini remains the fallback for a state a paid provider has and
a free one does not: out of credit. The estimated cost of a run is stated before
the run starts, because roughly USD 4 per certification is a number an operator
should see beforehand rather than find in the usage table afterwards.

Tracked by #436.

**Amended 2026-09-26: the free plan, for testing; publishing blocked.** The
`ELEVENLABS-API-KEY` secret had never been seeded. The owner's direction on
2026-09-26 was to start on ElevenLabs's free developer offer and test with its
monthly credits. As published that day, the free plan is 10,000 credits a month
with "full access to all APIs"
([developer API](https://join.elevenlabs.io/api/developer-api),
[pricing](https://elevenlabs.io/pricing)). Eleven v3, the only model Text to
Dialogue serves, costs one credit per character. A roughly 9,000-character
episode is therefore nearly the whole month in one run. Four things follow.

- **A credit pre-flight.** Before a render sends its first request it reads the
  account (`GET /v1/user/subscription`) and refuses a job the credits left
  cannot cover in full: "ElevenLabs has N credits left of M, this episode needs
  K; the allowance resets on <date>". A month is never half-spent on an episode
  that cannot finish. The refusal carries the out-of-credit error's
  `quota_exceeded` code. It falls back to nothing: the podcast has one provider
  (§2b), so the draft is saved with the sentence as its `audioError`. An account
  that cannot be read, for example a key without the User → Read permission,
  **fails closed**: nothing is sent. The check exists for exactly the case where
  the credits are unknown, and the plan it reads is what the publish rule below
  is decided from.
- **Test only, block publish.** Owner decision 2026-09-26. The free plan "does
  not include a commercial license and cannot be used for any commercial
  purpose", and publishing its output requires "elevenlabs.io" or "11.ai" in the
  title
  ([ElevenLabs help](https://help.elevenlabs.io/hc/en-us/articles/13313564601361)).
  The site is moving toward sponsorships, so the show counts as commercial. The
  attribution route was offered and declined, along with a setting to choose
  between the two. Episodes whose audio ElevenLabs rendered on the free plan are
  never pushed to RSS.com. Approval refuses them with 409, naming the licence
  and the upgrade, and writes nothing. The retry route refuses the same way, and
  the publish job records a `free_plan_licence` skip as a second guard. The
  decision uses the plan **recorded on the transcript when the audio was
  rendered** (`speechTier`, `speechFreePlan`), not the plan on the day someone
  clicks approve. Upgrading does not license audio made before the upgrade;
  regenerating on the paid plan does. An ElevenLabs render with no recorded plan
  is refused like a free one, because its licence cannot be shown. A render on a
  paid plan publishes as before.
- **Visibility and a cheap first test.** The Audio tab of the Platform settings
  page shows the plan, credits used of the limit, the reset date and what the
  last render billed, or "Not configured". Its live check renders a fixed
  two-turn, 257-character sample through the same path an episode takes. It
  reports the characters billed and the credits left, so the owner's first test
  spends about 257 credits and not the month.
- **The voices have moved.** Sarah, the lead, is an ElevenLabs Default voice.
  Default voices expire on 2026-12-31 and are "only available for accounts that
  were created before March 2026"
  ([Default voices](https://elevenlabs.io/docs/help-center/product/voices/my-voices/what-are-default-voices)).
  Aria is already a Legacy voice whose id the API routes to "Zoe"
  ([Legacy voices](https://elevenlabs.io/docs/help-center/product/voices/my-voices/what-are-legacy-voices)).
  The ids are unchanged until the owner chooses replacements by ear. The live
  check is how to find out whether the account can use them. *(Superseded the
  same day by the amendment below.)*

Tracked by #432.

**Amended 2026-09-26, later the same day: the owner picks the podcast voices
by ear (#725).** The seeded free-plan key passed the subscription read and its
first live check was refused: HTTP 402 `paid_plan_required`, "Free users
cannot use library voices via the API". The account was created after March
2026, so the Default voice Sarah is not one of its defaults, and Aria is a
Legacy voice. To this account both are library voices. Choosing ids from a
help page was the mistake, so the account's own list now decides.

- **The rule, from ElevenLabs.** "Voice Library voices are not available via
  the API to free tier users"
  ([Voices](https://elevenlabs.io/docs/overview/capabilities/voices), read
  2026-09-26). On the free plan the API may use the account's own voices and
  its default voices.
- **A voice list.** `GET cms/podcast/elevenlabs/voices`, editor, reads
  `GET /v2/voices` server-side with the key
  ([List voices](https://elevenlabs.io/docs/api-reference/voices/search);
  `/v1/voices` is filed under Legacy). The voice object has no single type
  field, so the account is listed three times with the documented
  `voice_type` filter: `default`, `non-community` ("'personal' and
  'workspace' combined (excludes library copies)") and `community`. Each
  voice is labelled by the listing that returned it. It is paginated with
  `next_page_token` / `has_more` at 100 a page and cached for five minutes.
  Each voice comes back with its name, category, gender, accent, age and
  description labels, and whether the current plan allows it. When it does
  not, the reason is given: a library voice on the free plan, a Legacy voice,
  or a plan its `available_for_tiers` excludes. Nothing is hidden. Listing
  needs a third key permission, **Voices → Read** (`voices_read`); without
  it the list names the permission.
- **Previews without widening the CSP.** Each voice's `preview_url` is on
  `storage.googleapis.com/eleven-public-prod/`, the host and bucket in every
  example in ElevenLabs's reference. `frontend/staticwebapp.config.json` has
  no `media-src`, so media falls back to `'self'`, which admits neither that
  host nor a `blob:` URL. It is not widened. An editor route,
  `GET cms/podcast/elevenlabs/voices/{voiceId}/preview`, takes a voice id,
  never a URL. It looks the preview up in the key's own listing and fetches
  it only if it is on that exact host and inside that bucket, checked after
  the URL parser has resolved any `..`. The fetch sends no key, refuses
  redirects, stops at 2 MiB, and passes on only bytes that begin like an MP3.
  The page fetches the bytes with its token and plays them with Web Audio
  (`decodeAudioData`), which loads no URL. Tests pin the allowlist: look-alike
  hosts, other buckets on the same host, `../` climbs, ports, credentials and
  queries. The route is therefore not an open proxy.
- **The choice is a podcast-only platform setting.** It is stored as
  `admin_config/podcast_voices`, `{ Maya, Elena }`. It is written through the
  same Platform settings route and store as the Listen & Learn voice
  (`podcast-voices`), not through Function App settings, which would need a
  Terraform apply for every change of ear. A save must name both hosts, each
  a 20-character letters-and-digits ElevenLabs id, and they must differ.
  Every podcast render reads it first: the episode pipeline and the live
  check pass it to the speech switch. The podcast no longer reads
  `LISTEN_AND_LEARN_VOICE_MAYA` / `…_ELENA`, which are Gemini's and Azure's
  (§2b). Listen & Learn is untouched.
- **No default voices.** The Default voices page's replacement table names
  new voices (Talia for Sarah, and so on) but prints no ids. Its links open a
  Voice Library search, and the Voice Library is the part the free tier
  cannot use through the API. Read on 2026-09-26, the docs name no voice id a
  free account made after March 2026 is documented to be able to use. So the
  code default is empty, rather than a third guess. Without a saved pair, a
  render refuses before it sends anything, with `voices_not_chosen` and
  "Choose the podcast voices first". The live check waits for a saved pair.
  An episode generated before the choice is saved is a transcript-only draft
  with that sentence as its `audioError`.
- **The 402 names the fix.** A `paid_plan_required` refusal now reads "Choose
  voices your plan allows under Podcast voices at
  `https://hybridcloudworks.com/admin/platform?tab=audio`", followed by
  ElevenLabs's own body, and the card says the same beside it.

The pre-flight's one-credit-per-character count assumes a voice with no
credit multiplier. That holds for everything the free plan offers here. On a
paid plan the owner may choose a library voice with a multiplier; the
pre-flight would then under-count, and the per-request out-of-credit error
is the backstop, as it already was for two renders racing each other.

Tracked by #725.

**Noted 2026-09-27: the last sample replays free, and a render asks
first.** The owner pressed the live check twice (257 credits each, 9,486
left) only to test playback, which the missing `media-src` had broken (#732
fixes it on deploy). Every check already stored its MP3 at
`podcast/sample/elevenlabs-live-check.mp3`, but the card showed a player only
for a check run in the same session, so every reload looked like "run it
again". A stored sample is now recorded in `admin_config/podcast_last_sample`:
its versioned media URL, the two voice ids, their names when this instance
has the voice listing cached (nothing is listed to find them), the characters
billed and the time. Only the latest is kept, as only the latest blob is. The
status route returns it as `lastSample` once a HEAD on our own storage finds
the blob, and the Audio tab plays it under **Last sample** on every load,
saying that replaying costs nothing. A replay never reaches ElevenLabs. A
sample stored before the record existed is still offered, from the blob and
the newest `podcast:sample` usage row, with the saved voices only if they
were saved before that row. **Run live check** is now **Render a new sample
(about 257 credits)**, and it asks first in the admin pages' `ConfirmModal`.
The prompt names the credits left, says the last sample replays free, and
says so when the last sample already used the saved voices. It asks; it never
blocks. The picker says that voice previews are ElevenLabs's own samples and
cost no credits, so they are the first thing to reach for.

#### 2b. ElevenLabs is the podcast voice only; Listen & Learn is Gemini TTS — amended 2026-09-09

Owner rule, stated 2026-09-09 and fixed: **ElevenLabs is only the podcast
voice** — content transcripts from articles and Plaud recordings, published as
episodes on RSS.com — and is never used for Listen & Learn. **Listen & Learn
audio is Gemini TTS**, generated on demand and stored as MP3, with Azure AI
Speech kept as the GA fallback. §2a read the paid plan as a replacement for
Gemini across the board; it was a decision about the podcast.

**What the code had.** One global preference order in `speech/index.js`, with
ElevenLabs first, read by every caller — so the paid podcast voice read every
study episode the moment its key landed, and `LISTEN_AND_LEARN_TTS_PROVIDER`,
also read for every caller, would have pinned the podcast too. That is why the
owner's instruction to set that pin to `gemini` could not be applied as the
code stood: it would have made the podcast read with Gemini.

**What changes.** Provider selection is per product, and every entry point
takes the product's name and refuses to guess without one:

| product          | providers, in order | pin setting                     |
| ---------------- | ------------------- | ------------------------------- |
| `listenAndLearn` | gemini, azure       | `LISTEN_AND_LEARN_TTS_PROVIDER` |
| `podcast`        | elevenlabs          | `PODCAST_TTS_PROVIDER`          |

A pin may name only its own product's providers; `LISTEN_AND_LEARN_TTS_PROVIDER`
naming `elevenlabs` fails every run with a sentence quoting this rule. Nothing
falls through between products: the podcast without an ElevenLabs key is a saved
transcript-only draft whose `audioError` names `ELEVENLABS_API_KEY`, never a
Gemini reading, and the out-of-credit fallthrough §2a introduced is removed
because its only path was the cross-product one. `LISTEN_AND_LEARN_TTS_PROVIDER
= gemini` is Terraform-managed on the Function App (`infra/functionapp.tf`), so
the rule is stated in the estate and a portal edit is drift.

**The model is the owner's button.** Two Gemini TTS models are offered — *Best*
(`gemini-3.1-flash-tts-preview`, the newest voice, about twice the cost) and
*Economy* (`gemini-2.5-flash-preview-tts`) — as a stored default in
`admin_config/listen_and_learn_speech`, edited on the Platform settings page
with each model's per-episode ceiling beside it, and as a per-run override on
the generation form carried in the job as `ttsModel`. Precedence: the run's
choice → the stored default → `LISTEN_AND_LEARN_TTS_MODEL` → the module
default. The 202 and the queued line name the model and its cost, and the
episode and its usage row record which one read it. The owner's rule of thumb
— newer certifications: Best; older ones: Economy — is guidance on the control,
not automation.

**The estimate in §2a stands, re-scoped.** What a run is expected to spend is
still stated before it starts; for Listen & Learn it is now Gemini's figure
for the chosen model, and it can never name ElevenLabs.

Tracked by #436 and #432.

### 3. The podcast page is the single audio surface

A provider's podcast page lists **both** sources — the host's ingested
episodes and the published Listen & Learn episodes for that provider — in one
date-sorted list, each row labelled with where it came from, played by one
component that supports seeking:

- `GET /api/public/listen-and-learn/episodes?platform=` is the provider-wide
  twin of the per-certification read: the same `status === 'published'`
  equality gate, rows projected to a listing allowlist (no transcript, no
  videos) and joined to their certification's title and slug. An episode
  without audio is omitted, because a podcast row that plays nothing is the
  defect #372 hid on the host side.
- `GET /api/public/podcasts` now returns `feedUrl`, the provider's row in
  `admin_config/podcast_feeds`. The page's RSS subscribe button reads it, so
  the button and the ingest cannot disagree. Spotify, Apple and Amazon stay
  in the provider configuration and each button appears only when its URL is
  configured.
- The aws, azure and gcp copies of the podcast page were the shared page with
  colours inlined. They are gone; every provider routes to the shared page
  and `provider-coverage.test.js` demands a metadata row for each.
- The player is a native `<audio>` element with `preload="metadata"`, driven
  by a keyboard-operable slider. It seeks because of the next decision.

### 4. The media route honours byte ranges

`GET /api/public/media/{container}/{*blobPath}` answers a single
`Range: bytes=…` with `206 Partial Content` and a `Content-Range`, reading
only the requested bytes from blob storage through the SDK's ranged download
rather than buffering the file; a start past the end answers `416` with
`bytes */size`; multi-range requests are ignored and served in full, as RFC
9110 permits; every success carries `Accept-Ranges: bytes`. `HEAD` is
registered alongside `GET` and answers the 200's headers with
`Content-Length` from blob properties alone. Caching is unchanged: the URL
carries the content's timestamp, so `immutable` and the ETag conditional
apply to partial responses as they did to full ones.

This is what a seek needs. It is also what a podcast directory requires of an
enclosure host, which is why option 3 on #349 — a self-hosted feed — is now
open rather than blocked (see revisit triggers).

### 5. StreamYard is a manual studio

No code. StreamYard records; the recording is uploaded to the host like any
other episode, and the feed carries it to the site. A live session, if one is
ever run, is a YouTube embed on a page, not an integration.

## Consequences and accepted risks

- **One manual upload per episode — accepted 2026-09-07, ended by §1b.** That was
  the cost of ownership of the Free plan, and it was the whole cost. Generated
  Listen & Learn episodes were not on the public feed unless the owner uploaded
  them; on the site they were already on the podcast page, which is where a
  visitor looks. §1b is what made that cost worth removing rather than bearing.
- **No download analytics beyond the host's.** The host's dashboard (Podbean's
  since §1c) reports plays of feed episodes; Listen & Learn plays through the media route are
  visible only as Function invocations.
- **Media bytes still pass through Function invocations.** Ranged reads make
  a seek cheap rather than free; ADR 0014's note that a CDN can be layered in
  front of the origin later, without application change, still holds and is
  now more useful, since a CDN forwards `Range` as-is.
- **`If-Range` is not evaluated.** Safe only because a media URL never changes
  content — the path carries the timestamp. If that ever stops being true the
  route must evaluate `If-Range` before answering 206.
- **Two copies of four names.** `public-reads.js` has no imports by design,
  so the feed-config container, document id and partition are copied there —
  and, with 1a, the reserved provider `main`; `public-reads.test.js` asserts
  the copies agree with `timers/podcasts.js` and `cosmos-client.js`, the same
  guard the Listen & Learn container names already had. The browser holds a
  copy of the reserved provider too (`frontend/src/lib/audioEpisodes.js`),
  which no test can tie to the server's: it travels on every episode row
  instead, and the page tests pin what a row carrying it renders as.

## Alternatives considered

- **RSS.com Max with an API publish step (option 2 on #349).** `publish.js`
  would push a finished MP3 to the host and the feed would round-trip it into
  `podcasts`. USD 37 a month for automating something that happens a handful of
  times a month, on a beta API whose endpoints may change. Declined on
  2026-09-07 and **approved on 2026-09-08** (§1b, #437); the site side was
  built so that adding it later is a publish step and a configuration change,
  not a redesign, which is what that issue now does. As considered here the
  push was described per finished MP3, which reads as generation-time
  publishing; **§1b settles it the other way** — approval is the trigger and
  generation never publishes, because a draft must not reach a public feed.
- **Self-host the feed (option 3 on #349).** A new `GET
  /api/public/podcast/{provider}/feed.xml` built from `podcasts` plus
  published Listen & Learn episodes and submitted to the directories
  directly. No vendor and no upload step, but it was blocked on byte-range
  support and it forfeits the host's analytics. The blocker is removed by
  this record; the option is the revisit path below.
- **ElevenLabs now, on a Starter plan.** About USD 4 per certification and a
  dialogue endpoint that matches the stored format. Deferred on 2026-09-07
  because a paid plan is required for commercial use and the configured provider
  costs nothing; **approved on 2026-09-08** (§2a, #436).
- **Serve Listen & Learn audio straight from blob storage.** Requires
  reversing `allow_nested_items_to_be_public` and the account's network
  deny, which ADR 0014 and T-105 chose not to do; the media route with
  ranges gives the same seek behaviour without opening the account.
- **Keep the certification pages as the only place Listen & Learn plays.**
  Leaves the podcast page empty whenever the host is dark, which is exactly
  the state the site was in.

## Validation and revisit triggers

- Validated in code on 2026-09-07: `functions` 1648 tests, `frontend` 494
  tests, `mkdocs build --strict` and the redaction gate green on the change.
- Validated in production when: the RSS.com show exists and its feed URL is
  in `admin_config/podcast_feeds`; `podcasts.updatedAt` is fresh within two
  hours of the seed; `/azure/podcast` lists feed and Listen & Learn rows
  together; a seek into a Listen & Learn episode produces a 206 in the
  Function App's request log rather than a 200 of the whole file.
- Validated for the main feed (1a) when: the Main feed field on
  `/admin/platform` holds the show's URL; within two hours `podcasts` carries
  rows with `provider: 'main'`; every provider's `/…/audio` page leads with a
  show episode and offers an RSS button pointing at the show; and the next
  `publish-content-manifest` run reports non-zero `audio` counts for all eight
  providers, which is what returns those URLs to `sitemap.xml`.
- **Revisit toward self-hosting (option 3)** when any of these holds: the
  manual upload is missed for more than one episode; the owner wants
  generated episodes on the public feed without the upload step; RSS.com's
  plan changes what it distributes. The media route is ready; the work
  is the feed route, the directory submissions, and deciding what replaces
  the host's analytics.
  **The second condition fired on 2026-09-08 and was answered by §1b instead**,
  which buys the same outcome without leaving the directories or giving up the
  host's analytics. Self-hosting stays the fallback if the host's API does not
  hold up; it is no longer the only route to publishing without an upload.
- **Revisit ElevenLabs** when a paid plan is approved. **Met 2026-09-08**
  (§2a, #436), **and scoped 2026-09-09** (§2b): the plan is for the podcast
  voice only, and the trial of one certification through both providers is
  withdrawn — Listen & Learn is Gemini by rule, so there is nothing to compare.
- **Validated for the free plan (§2a, 2026-09-26)** when the seeded key's live
  check on the Audio tab plays both voices, reports about 257 characters billed,
  and reports credits left about 257 below the month's 10,000. Since #725 that
  check runs only after two voices are chosen and saved under Podcast voices.
  Success is the list showing usable voices, two saved, "Characters billed:
  257" and credits left about 9,743 of 10,000.
- **Revisit the empty default voices (§2a, #725)** if ElevenLabs documents
  voice ids that a free account made after March 2026 can use through the
  API. Until then the owner's saved pair is the only source.
- **Revisit the free-plan publish block** when a paid ElevenLabs plan is bought.
  Nothing in code changes: a render on the paid plan records that plan and
  publishes. Episodes voiced on the free plan must be regenerated first.
- **Revisit the Best/Economy rule of thumb** if choosing by hand proves a
  chore: automating it by certification age is the follow-up §2b names, and
  it needs a definition of "newer" the certification documents do not carry
  today.
- **Revisit RSS.com Max** only if the automated publish step is wanted and
  the API has left beta. **The first condition was met 2026-09-08** (§1b, #437);
  the second is a fact about the API today, verified on that issue before the
  client is written. **Moot since 2026-10-13** (§1c): the show left RSS.com.
- **Validated for Podbean (§1c)** when: the Podbean card's test on
  Integrations → Services answers "Connected — Hybrid Cloud Insights."; an
  approved transcript's row on the Recording Hub's Distribution tab reads
  "Published to Podbean" with a link to the episode; and within two hours of
  that, the episode is in the feed at `https://podcast.hybridcloudworks.com/feed.xml`
  and in `podcasts` under `provider: 'main'`, once.

## Related decisions and references

- [ADR 0014](0014-storage-and-media.md) — the closed storage account the
  media route exists to serve from; ranged delivery keeps it closed.
- [ADR 0013](0013-ai-provider-strategy.md) — providers selected by key
  presence, which is the shape the speech order follows.
- [ADR 0015](0015-cost-governance.md) — the ceiling every "no paid upgrade"
  above is measured against.
- Issue #432 (the audio pipeline project §1b and §2a are the spend decisions
  for), #433, #434, #435 (the three source paths that made a per-episode manual
  upload expensive), #436 (ElevenLabs), #437 (the host publish step, RSS.com
  then Podbean), #1110 (the feed on the owner's domain), #1113 (the
  retired-host rule as host and moment), #1114 (Podbean's MCP server).
- Issue #349 (the evaluation and the owner's decisions), #348 (the feed list
  moved to `admin_config`), #372 (retired media hidden from the list); PR
  #363 removed the previous host's remaining references.
- `functions/src/lib/public-media.js`, `functions/src/lib/blob-storage.js`,
  `functions/src/lib/public-reads.js`, `frontend/src/lib/audioEpisodes.js`,
  `frontend/src/components/podcast/EpisodePlayer.jsx`.
- RFC 9110 §14 (Range requests) and Apple Podcasts' requirement that
  enclosure hosts support byte-range requests.
