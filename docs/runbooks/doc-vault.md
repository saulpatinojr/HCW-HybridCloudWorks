# Doc Vault: what goes here, what does not

> **Status: built on 2026-10-26** (owner request). The
> page is [Admin → Doc Vault](https://hybridcloudworks.com/admin/doc-vault). It
> works as soon as its storage exists; the one step that creates the storage is
> in [Set it up once](#set-it-up-once) and is the owner's.

**Scope:** what the Doc Vault is for, what to put in it and what to keep
elsewhere, how to add, read, copy, change, restore and delete a document, and
how it relates to your notes in Obsidian.

**Authority:** the vault only ever holds what you put in it, and it publishes
nothing. Every page and every request behind it needs the **publisher** role.

## What it is, in two sentences

The Doc Vault is a private shelf in the admin for your own writing that you
want to keep and reuse: a cover-letter template, an application you wrote out in
full, a letter, notes. Nothing in it is ever shown on the public site, and each
document remembers its last ten versions so a change can be undone.

## What goes here, and what does not

The Ambassador hub has an **Evidence** tab too, and the two are easy to mix up.
They are separate on purpose.

| | **Doc Vault** | **Ambassador → Evidence** |
|---|---|---|
| What it holds | Your own templates, applications, letters and notes: text you wrote and want to reuse | Proof of a contribution to a programme: a talk, a certification, an article, with a link and a date |
| Who it is for | You, as a place to keep and copy from | A programme's review, as a record that you met its requirements |
| How it is organised | Category, tags and title | By programme, requirement and year |
| Adding to it | Paste a document, or upload text and markdown files | Add by hand, or import from Speaking, Certifications and Published content |
| Page | [Admin → Doc Vault](https://hybridcloudworks.com/admin/doc-vault) | [Admin → Ambassador](https://hybridcloudworks.com/admin/ambassador), the Evidence tab |

A rule of thumb: if you would paste it into a form or an email, it goes in the
Doc Vault. If a programme wants to see that you did something, it goes in
Evidence. They share no storage and no code.

Also keep out of the vault: anything you want visitors to read (that is an
article: start it on [Admin → Drafts](https://hybridcloudworks.com/admin/drafts)),
passwords, API keys and other secrets (those belong in the Key Vault, one home
per secret), and other people's personal data.

## Who can use it, and why that role

Publisher or above. Here is the reasoning, so it can be changed on purpose and
not by accident:

- **Viewer** is the read-only role for watching the dashboards. It has no
  business reading private letters.
- **Editor** is the role an invited co-author gets to write and review
  articles. They need the content pipeline, not your applications and letters.
- **Publisher** is the first role trusted to put things in front of the
  public, which is the right bar for the place where the things that must never
  go public are kept. Super admin passes it too.

The role applies to every request, reading included: a private letter is as
private to read as to change. It is set in one place,
[`DOC_VAULT_ROLE`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/functions/src/lib/doc-vault/model.js).

## Set it up once

The vault keeps its documents in its own database container, called
`doc_vault`. The page and the API are deployed by the normal release, but a
container is created by a Terraform apply (Terraform is the tool that builds
the Azure resources from the files in `infra/`), and applying is yours to
confirm. Until it has run, the page shows "The Doc Vault has no storage yet"
and the API answers 503 `NOT_PROVISIONED`. Nothing is lost and nothing breaks.

1. Open the runs list for the `hcw-azure` workspace:
   <https://app.terraform.io/app/hcw/workspaces/hcw-azure/runs>.
2. Open the newest run for the merge that added the Doc Vault. It should be
   waiting for confirmation.
3. Read the plan. You should see **1 resource to add**:
   `azurerm_cosmosdb_sql_container.hcw["doc_vault"]`, plus the same standing
   changes every run for this workspace shows (the plan check names them, and
   says the addition is declared). If the plan shows anything else being
   destroyed or changed, stop and do not confirm.
4. Choose **Confirm & Apply**. The container is created in a few seconds.
5. Open [Admin → Doc Vault](https://hybridcloudworks.com/admin/doc-vault) and
   press **Try again**. You should see an empty list and the line "Private.
   Only signed-in admins see this. Never shown on the public site." If you still
   see "no storage yet", wait a minute and press Try again once more.

If you would rather check by command first (PowerShell, from the repository
root; this only plans, it changes nothing):

```powershell
terraform -chdir=infra plan
```

A good plan lists the one container to add.

## Add documents

### Paste one

1. Press **Paste a document**.
2. Give it a **title**, choose a **category** (Template, Application, Letter,
   Notes, Reference or Other), add **tags** if you like (separate them with
   commas; up to 12, each up to 40 characters) and a **related link** if one
   helps (an https address, or a page of this admin).
3. Paste the **text**. Plain text or markdown, up to 256 KB. It is stored and
   shown exactly as written; it is never turned into a web page.
4. Press **Add to the vault**. You should see the document open on the right
   and a message "Added to the vault".

### Upload files

1. Press **Upload files**, choose one or many `.md`, `.markdown`, `.txt` or
   `.text` files (a Word or PDF file cannot be read: paste its text instead),
   and choose the category for files that do not name one.
2. Press **Upload**. The files go one at a time and each gets a line saying what
   happened. A file with a problem is reported and the rest carry on.

A file can open with a block between two `---` lines, as an Obsidian note does:

```markdown
---
title: Cover letter for the MVP application
category: Letter
tags:
  - outreach
  - mvp
link: https://example.com/role
---

Dear team, …
```

Four keys are read: `title`, `category`, `tags` (a `[list]`, a comma line, or
Obsidian's one-per-line form) and `link` (also `url` or `related`). Every other
key is **not kept**, and the result line names it so nothing disappears quietly.
Without a title in the block, the first `# heading` is the title, and after that
the file name.

### The same title again is a new version

Adding a document with the **same title and category** as one already in the
vault does not make a second copy. It becomes the newest version of the first,
and the text it replaces is kept in History. Case, accents, punctuation and
spacing do not matter ("Résumé, v2" and "resume v2" are the same title). If the
text is exactly the same, nothing is written and the result says so. Two
documents with the same title in **different** categories are two documents.

## Read, copy and edit

Open a document from the list on the left.

- **Copy** puts the text on the clipboard exactly as saved.
- **Copy as plain text** does the same without the markdown marks (heading
  `#`, `**bold**`, link syntax), for pasting into a form or an email where the
  marks would show. A link keeps its address in brackets after its words.
- Both use the browser's clipboard, and fall back to the older copy command
  where the clipboard is blocked. The page's tests cover both ways and the
  refusal, but they run in a test browser, not in Edge, Chrome and Firefox on
  Windows: if Copy does nothing on yours, the page says so, and the text stays
  in a box you can select with Ctrl+A and copy with Ctrl+C.
- **Edit** opens the form. Saving keeps the text it replaces in History.
- Search the list by title, tag or category, or narrow it with the category and
  tag filters.

## Versions

Each document keeps its newest ten versions, the current one included. Open
**History** under the document:

- **View** shows an earlier version without changing anything, and says which
  version you are reading.
- **Restore** makes that version the newest. It does not delete anything: the
  text it replaces becomes the next entry in History.

Two tabs cannot overwrite each other. If the document changed somewhere else
while you were editing, the save is refused, your text stays in the form, and
**Reload latest** brings in the other change.

## Delete

**Move to Trash** takes a document off the list. It waits in **Trash** for 30
days with its history; **Put back** returns it. After 30 days it, and its
versions, are removed for good the next time the vault list is opened.
**Delete forever** (in Trash only, with a confirmation) removes it at once and
cannot be undone.

Why Trash and not a plain delete: the vault is the primary home of this
writing, so one wrong click on a letter should not be the end of it.

## Obsidian and the site

The site is the primary home of this writing. Obsidian stays on your computer
as a second, visual map of the same notes. A later export feature is meant to
read the vault into Obsidian, so each document is stored with what a note
needs: an id, a title, a category, tags, the created and last-changed dates and
the text (and the last ten versions for history). The list route
(`GET /api/cms/doc-vault`) returns every field of that list except the text for
each document, and `GET /api/cms/doc-vault/{id}` returns one with its text.
Nothing is exported yet.

Your vault's idea notes and drafts have their own routes, described in
[Idea notes in Obsidian](obsidian-idea-notes.md).

## How "never public" is enforced

Not by a setting that someone could change by accident, but by four things that
each have a test (`functions/src/lib/doc-vault/no-leak.test.js`):

1. **Its own container.** No public route, the pre-render, the sitemap or the
   search index names `doc_vault`; the test reads every source file and fails
   if one does.
2. **No public fields.** A vault document has no `Live`, `contentStatus` or
   `slug`, so the public clauses refuse it in every state it can be in.
3. **Every public route, tested.** The test runs each public route against a
   store that answers every read with a vault document, and checks that no
   response carries it.
4. **The page is under `/admin`.** It is behind the sign-in, disallowed to
   crawlers, and absent from the sitemap.

What the vault never writes down: the text, the title, the tags and the link of
a document are never put in a log line, an audit row or an error message. An
audit row (kept 90 days) holds only the document's id, its version, its
category, how it arrived and its size, with your admin id and no name or email.

## If something looks wrong

| You see | It means | Do this |
|---|---|---|
| "The Doc Vault has no storage yet" | The `doc_vault` container has not been created | [Set it up once](#set-it-up-once) |
| "The Doc Vault is for publishers and above" | You are signed in as a viewer or editor | Ask the owner for the publisher role |
| "changed in another tab or on another device" | Someone (you, elsewhere) saved first | Copy your text, press **Reload latest** |
| A file line says "Only text files are read here" | The file is not `.md`, `.markdown`, `.txt` or `.text` | Paste its text instead |
| A file line says "Not added: the file holds binary data" | The file is not text | Open it in a text editor and paste |
| The list says "Only the newest 500 documents are listed" | The vault is bigger than one list | Search by title, tag or category |

## Where the code is

| Part | File |
|---|---|
| Rules (fields, ids, versions) | [`functions/src/lib/doc-vault/model.js`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/functions/src/lib/doc-vault/model.js) |
| Reading an uploaded file | [`functions/src/lib/doc-vault/markdown.js`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/functions/src/lib/doc-vault/markdown.js) |
| The routes | [`functions/src/lib/doc-vault/handlers.js`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/functions/src/lib/doc-vault/handlers.js) and [`functions/src/functions/doc-vault-http.js`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/functions/src/functions/doc-vault-http.js) |
| The page | [`frontend/src/pages/admin/DocVaultPage.jsx`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/frontend/src/pages/admin/DocVaultPage.jsx) and the `docVault/` folder beside it |
| The container | `doc_vault` in [`infra/cosmos-containers.json`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/infra/cosmos-containers.json), made from [`scripts/lib/migration-manifest.mjs`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/scripts/lib/migration-manifest.mjs) |
| The "never public" test | [`functions/src/lib/doc-vault/no-leak.test.js`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/functions/src/lib/doc-vault/no-leak.test.js) |

The container is backed up with the other authored work (weekly full copy and
daily changes to the out-of-account export, [ADR 0028](../decisions/0028-cosmos-out-of-account-export.md)).
