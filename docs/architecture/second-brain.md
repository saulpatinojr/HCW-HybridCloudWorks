# HCW Second Brain

Owner-approved design, 2026-10-26. Implementation is in the application and
desktop plugin; production activation and private Publish retirement follow
the [rollout runbook](../runbooks/second-brain.md).

A second, separate workspace for engineering notes, the Code Conductor brain,
reuses this design's save and sync code with its own database, switches,
owner, desktop client and scope; see
[ADR 0036](../decisions/0036-code-conductor-brain.md). Nothing below changes
for the creator workspace.

## Product and authority

`/admin/second-brain` is the private creator workspace: Home, Inbox, Library,
Topics & Projects, Map, and Ask. Capture is free-form. Notes have Markdown,
tags, sources, explicit links, collection membership, backlinks, revision
history, and archive/restore. The existing command palette, Drafts page, and
content editor expose the same workspace and linked research.

Existing creator records remain authoritative in their existing tools.
References have stable IDs derived from their container and document ID.
Private provenance stays outside the content document when an outline becomes
a draft. Draft creation uses existing field and taxonomy validation and the
existing `drafting`/`Live: false` invariants; it never publishes.

Private search uses POST bodies so keywords do not enter request URLs. The
owner's command palette uses this same search for both notes and creator
references. Notes and revision history are paginated; saves preserve additional
Obsidian properties within a 16 KB structured metadata limit.

The editorial allowlist covers `content` (excluding news/RSS ingestion),
`frameworks`, `designs`, `newsletters`, `social_posts`, `recordings`, and
`podcast_transcripts`. Bodies are projected from editorial text only, including
newsletter sections and dialogue turns. Subscriber and operational records,
credentials, audio binaries, OCR, and URL crawling are excluded. A URL saved
on a note remains a reference.

## Access and storage

All browser routes use the existing Entra access token, delegated
`access_as_admin` scope, `Admin` app role, and active registry role of at least
editor. They additionally require `BRAIN_ENABLED=true` and an exact configured
owner tenant/object identity match. A different super administrator is denied.
The browser derives navigation capability from the protected status endpoint.
The disabled default is fail-closed; ownership is never claimed on first use.

`brain_records` is partitioned on `/ownerId`. Notes, topics, projects,
conflicts, revisions, mutation receipts, and ordered sync events share this
partition. Each authored save transaction replaces the sequence counter under
its ETag, conditionally writes the record, and creates its revision, event,
and receipt. A stale base version returns 412 with the current owner-visible
record. Retrying the same mutation is idempotent; reusing its ID for different
input is refused. No timestamp chooses a conflict winner.

`brain_search`, also partitioned on `/ownerId`, is a regenerable lexical index.
A separate `brain-index` queue keeps private indexing checkpoints/results out
of the generic jobs surface. Each delivery processes one bounded source page.
A 15-minute reconciliation timer resumes interrupted checkpoints and refreshes
updates/deletions. Its schedule is included in the timer-overdue alert contract.
Reads recheck the authoritative source, so stale projections cannot expose
removed text. Search is paginated and ranks matches within the retrieved page;
it is not vector search or an exhaustive semantic ranking.

Authored records participate in daily delta and weekly full backups. Derived
search records are rebuilt. Private API successes and errors carry no-store
and noindex headers. No brain container participates in public APIs,
prerendering, feeds, or public preview generation.

## Obsidian

The Windows desktop plugin connects through a separate public Entra client,
delegated `brain_sync` scope, the same active-admin registry, the configured
owner identity, and the configured desktop `azp`. A sync token fails ordinary
admin API authentication. No app credential or general-purpose admin token is
stored in the plugin settings.

MSAL device-code sign-in uses an encrypted cache under Windows LOCALAPPDATA,
outside the vault. The packaged, fixed PowerShell helper calls Windows DPAPI
with CurrentUser scope. Cache data travels through pipes, never process
arguments. Writes use a lock and atomic rename; encryption failure never falls
back to plaintext. This avoids the unsigned native DPAPI addon blocked by
Application Control on the development host. No policy setting is changed.

Enrollment previews existing Markdown files, with none selected initially.
Only enrolled notes and generated HCW folders participate. Stable IDs are kept
in plugin state and note properties; file/folder rename events update paths.
Unknown YAML properties and unsupported Markdown are retained. Resolvable
wikilinks to enrolled notes also create stable graph links.

Notes, topics and projects sync both ways while the vault is open. A durable
pending mutation survives network interruption; recovery copies are retained
before accepting conflicting remote text. Local deletion becomes a remote
archive; restoration uses a newer version. Vault.process compare-and-write
refuses edits that changed during the network request.

Website content downloads under `HCW/Site` as references. Editing one creates
a recoverable working note; it never edits an article or draft on the site.
Reference removal is reconciled only after a complete index/reference scan.
Credentials remain outside the vault, but local notes and sync state are plain
files governed by computer and OneDrive access permissions.

## On-demand AI

`brainAssistant` is registered in the existing AI Engine with a Foundry-only
provider policy. No trial provider or alternate provider receives private
excerpts through failover. `BRAIN_AI_ENABLED` is separately disabled by default.
No background process calls AI.

Questions retrieve a bounded candidate window and send at most eight excerpts,
5,000 characters each. The assistant has no tools or write/publish authority.
Retrieved prose is untrusted evidence. Structured claims require valid source
IDs; creative suggestions are presented separately. Missing evidence,
incomplete indexing, bounded retrieval, provider failure, and token/cost usage
are visible. Citation validation establishes source identity, not a guarantee
that a model's interpretation is correct; the owner reviews the answer.

The owner explicitly reviews an answer as a new note or creates a draft from
reviewed text. Neither action is performed by the model.

## Validation boundary

Unit and integration checks cover authorization, scope isolation, atomic
history, replay, conflicts, archive/restore, source refresh/deletion, draft
idempotency, private provenance, citations, and UI actions. Browser tests use
the real admin shell and MSAL flow with synthetic identity/API boundaries.
Plugin engine tests exercise offline and conflict scenarios; a Windows test
performs an actual DPAPI round trip on synthetic data. These do not replace
production Entra/Cosmos checks or the test-vault pilot in the runbook. See the
[implementation validation record](second-brain-validation.md) for results and
the remaining live verification boundary.
