# Idea notes: keep ideas in Obsidian, promote the ready ones to drafts

> **Status: in use from 2026-10-24** (#1343). This is the first step only: a
> format for an idea note, a check for a folder of them, and a script that turns
> one ready idea into a draft article. There is no admin screen for the idea
> backlog.

**Scope:** how to keep content ideas in [Obsidian](https://obsidian.md/download)
(a notes app that stores plain files on your computer), hold them to one
format, and turn an outlined idea into `docs/content/blog-<name>.md`, the file
the admin's *Import from docs/content* button reads.

**Authority:** nothing here changes the site by itself. The scripts only read
your notes and write one new file. Putting that file into the repository,
merging it and importing it are separate steps, and they are yours.

## Why the notes stay outside this repository

This repository is public. A vault inside it would publish every private
thought in it. So the vault lives somewhere else on your computer, and the
scripts are given the folder as an argument. Nothing from the vault is ever
committed except the one draft you choose to promote, and you read it first.

## Set it up once

1. **Install Obsidian** from <https://obsidian.md/download> (Windows, Mac,
   Linux, iOS and Android are listed there).
2. **Make a vault** (Obsidian's word for a folder of notes) in a folder that is
   **not** inside `HCW-HybridCloudWorks`, for example in your Documents folder.
   Inside it, make a folder called `Ideas`. Only this folder is checked, so the
   rest of the vault can hold anything.
3. **Make a template note** so every idea starts with the right properties.
   Inside `Ideas`, make a folder called `_Templates` (a folder or file name
   starting with `_` is skipped by the check), and in it a note called
   `Idea template` with exactly this at the top:

   ```yaml
   ---
   type: blog
   theme:
   format: how-to
   status: idea
   ---
   ```

   Obsidian shows those lines as a small table at the top of the note. Its own
   help page on
   [Properties](https://obsidian.md/help/properties) explains the table, and
   says they are stored as YAML (plain text between two `---` lines) at the top
   of the file, which is what these scripts read.
4. **Tell Obsidian where the template is**, so you can use it. A template note
   does nothing by itself: a new note stays empty until you put the template in
   it. In Obsidian, open **Settings → Core plugins**, switch **Templates** on,
   then under **Templates** set **Template folder location** to
   `Ideas/_Templates`
   ([Templates, Obsidian Help](https://obsidian.md/help/plugins/templates)).

## Start a new idea

1. Make a new note in `Ideas` and give it the idea's working title as its name.
2. In the new note, use the **Insert template** button in the left ribbon, or
   open the command palette and run **Templates: Insert template**, and pick
   `Idea template`. The four properties appear at the top, ready to fill in.
   (Without the Templates plugin you can instead copy the template file in your
   file manager and rename the copy.)
3. Fill in `theme`, set `format` and `type` if they differ, and write the idea
   underneath. Leave `status: idea` until you have an outline.

If you skip the template, the checker will tell you which properties are
missing.

## The format of an idea note

One note is one idea. The file name is its working title.

| Property | Required | What goes in it |
| --- | --- | --- |
| `type` | yes | What it becomes: `blog`, `framework`, `architecture` or `coder_corner`. |
| `theme` | yes | The group it belongs to, as lower-case words joined by hyphens, for example `landing-zones`. |
| `format` | yes | How it is told: `how-to`, `build-log`, `article`, `video`, `podcast` or `newsletter`. |
| `status` | yes | Where it is: `idea`, `outlined`, `drafted`, `published` or `parked`. |
| `title` | no | The article title. The file name is used when this is empty. At most 300 characters. |
| `subtitle` | no | One sentence. At most 500 characters. |
| `tags` | no | Up to 12, each lower-case words joined by hyphens, at most 40 characters. |
| `reading` | no | Minutes to read, a whole number from 1 to 999. |
| `part` | no | Written like `1 of 2`. |
| `date` | no | `YYYY-MM-DD`. Today's date is used when this is empty. |

Other properties you add, such as `aliases` or `created`, are left alone.

The text under the properties is the note itself. Once the status is
`outlined`, it must not be empty: that is the outline the draft starts from.

A finished example, as it looks in the file:

```yaml
---
type: blog
theme: landing-zones
format: how-to
status: outlined
subtitle: What to build first, and what to leave out.
tags:
- azure
- terraform
reading: 12
---

## Why most small teams over-build

...
```

**Two rules that catch people out.** A value that starts with a quote mark and
carries on (`title: "Quoted" at the start`) would be cut off at the second
quote, so the check refuses it: wrap the whole value in the other kind of quote
(`title: '"Quoted" at the start'`). And a `#` after a space starts a comment,
so a title containing ` #` must be in quotes.

## Check your ideas

Run this from the repository folder, in PowerShell. The first line asks for the
folder, and the second checks every note in it:

```powershell
$ideas = Read-Host 'Full path of your Ideas folder'
```

```powershell
node scripts/ideas/check-idea-notes.mjs "$ideas"
```

**What you should see** when every note is fine:

```text
3 notes checked, all fine.
Fine notes by status: idea 1, outlined 2.
Fine notes by type: blog 3.
```

When a note has a problem, its path is printed with one line per problem and
the check exits with an error:

```text
Landing zones/Typo.md
  line 5: status: "outline" is not one of idea, outlined, drafted, published, parked
4 notes checked: 3 fine, 1 with problems.
Fine notes by status: idea 1, outlined 2.
Fine notes by type: blog 3.
```

Fix the note and run it again. If it says `No .md notes found`, the folder is
wrong. The check never changes a file.

## Promote an outlined idea to a draft

An idea can be promoted when all of these are true:

- `status` is `outlined`, and there is an outline under the properties;
- `type` is `blog` (the import takes blog articles only);
- `format` is `how-to` or `build-log` (the two tracks in the
  [blog template](../content/blog-template.md));
- the outline holds nothing that only works in Obsidian (see the table below).

**Steps**

1. Make sure you are on `main` with the scripts, from the repository folder.
   `Test-Path` should print `True`:

   ```powershell
   Test-Path scripts/ideas/promote-idea.mjs
   ```

   If it prints `False`, run `git switch main` and then `git pull`, and try
   again.

2. Give the script the note. The first line asks for the note's full path; the
   second shows the draft without writing anything:

   ```powershell
   $note = Read-Host 'Full path of the idea note to promote'
   ```

   ```powershell
   node scripts/ideas/promote-idea.mjs "$note" --dry-run
   ```

   You should see `Would write ...\docs\content\blog-<name>.md` followed by the
   draft. If it lists reasons instead, fix them in the note (the table below).

3. Write it for real:

   ```powershell
   node scripts/ideas/promote-idea.mjs "$note"
   ```

   You should see `Wrote ...\docs\content\blog-<name>.md` and two reminders.
   The file name comes from the title. To choose another, add
   `--name some-other-words`. The script never overwrites: if the file exists
   it stops and says so.

4. **Read the new file through.** What is committed under `docs/content` is
   public, and the script cannot know what in your outline you would not want
   published.
5. In your note, change `status` to `drafted`. The script never edits your
   vault, so this is yours to do.
6. Put the file into the repository with a pull request, like any other change.
   Once it is merged to `main`, open **Admin → Drafts** on the site
   (<https://hybridcloudworks.com/admin/drafts>) and use **Import from
   docs/content**. Importing reads the file from `main`, creates a draft, and
   skips any file it has already imported. From then on the Drafts page is the
   source of truth for the article.

   If the draft should not go through the public repository, skip steps 4 to 6
   and send the file straight to the admin instead: see
   [Send a draft straight to Admin Drafts](#send-a-draft-straight-to-admin-drafts-no-repository-needed).

## Send a draft straight to Admin Drafts (no repository needed)

*Added 2026-10-25.* The repository is public, so a draft that is not ready to
be seen should not be committed to it. **Admin → Drafts** can take a markdown
file straight from your vault instead. This is a second way in, next to the
promote-and-import route above: that route still works, and nothing about it
has changed.

A file can be sent this way when it starts with a front-matter block, a few
`key: value` lines between two `---` lines, the same block a `docs/content`
article has (see "Front matter" in the
[blog template](../content/blog-template.md)). It needs a `title`, and there
must be an article under the block. `subtitle`, `date`, `track`, `part`,
`tags` and `reading` are used if present. Other properties, such as `type`,
`theme`, `format` or `status` from an idea note, are left alone and are not
saved.

1. Open the admin Drafts page and sign in if it asks:
   <https://hybridcloudworks.com/admin/drafts>. You should see a box called
   **Paste or upload a markdown draft** near the top.
2. Under **Markdown files from my vault**, click **Choose files** (the button
   may say *Browse*) and pick your `.md` files. You can pick many at once: in
   the file window open your vault's `Drafts` folder, press `Ctrl` and `A` to
   select every file, then click **Open**. The button below the picker changes
   to **Upload 17 files** (or however many you chose).
3. Click that button. The files go up one at a time, and you should see a line
   appear for each, in this order: the file name, then one of:
   - `Created as a draft`: it is now in the list on this page, marked
     *From my vault*.
   - `Already present — Draft` (or `In Review`): an article with the same
     title is already on this page, so nothing was added. Sending a file twice
     is safe.
   - `Already present — an article with this title is already published`:
     nothing was added.
   - `Not added: ...` followed by the reason, for example that the file does
     not open with a `---` block. Fix that file and send it again; the other
     files are not affected.
4. When the last file is done, a line under the list gives the totals, for
   example `17 files: 15 created, 2 already present, 0 not added. Nothing was
   published.`

To send one draft that you have copied instead of saved as a file, paste the
whole text, front matter first, into **Or paste one draft** and click
**Add pasted draft**. It is saved as *Pasted in*. The box empties when the
draft went in, and keeps your text when it did not, so you can fix it.

From here a draft behaves like any other on the Drafts page: open it, edit it,
**Send to In Review** when it is ready. Nothing is published by uploading.
A file can be at most 272 KB (the article itself at most 256 KB).

## What the scripts refuse, and what to do

| Message | What it means | Fix |
| --- | --- | --- |
| `the note has no properties` | The note does not start with a `---` line. | Add the properties block from the template. |
| `type is missing` (or `theme`, `format`, `status`) | A required property is empty or absent. | Fill it in. |
| `status: "outline" is not one of ...` | The value is not in the list. | Use one of the listed words. |
| `write "Status" in lower case` | Property names are lower case. | Rename the property. |
| `status is "outlined" but nothing is written` | An outlined idea needs its outline. | Write the outline, or set the status back to `idea`. |
| `only an outlined idea is promoted` | The status is not `outlined`. | Finish the outline and set it. |
| `the repository import takes blog articles only` | `type` is not `blog`. | Only blog ideas become drafts this way. |
| `a blog draft is a how-to or a build-log` | `format` is something else. | Pick the track the article follows. |
| `a [[wikilink]] or ![[embed]] ...` | A link to another note in your vault. It would show as plain brackets on the site, and it names a private note. | Rewrite it as plain text or a normal link. |
| `an Obsidian %% comment %%` | A private note to yourself inside the text. | Delete it. |
| `a dataview block` (or `tasks`, `query`) | Only Obsidian can run it. | Remove it. |
| `... already exists, and this script never overwrites` | A draft with that name is already there. | Choose another with `--name`. |

Code blocks and inline code are not searched, so a shell example such as
`if [[ -f x ]]` is fine.

## What this does not do

- It does not edit your vault, sync it, or back it up.
- It does not read JSON-style properties (Obsidian can save those); use the
  normal property table.
- Only blog ideas become drafts. Other types and formats are tracked in the
  notes but are written by hand.
- It does not decide what is private. The refusals above catch what is
  obviously Obsidian-only; reading the draft is the check on everything else.
- There is no admin screen for the idea backlog. Add one only if the notes turn
  out not to be enough.

## How it works, for whoever changes the code

- `scripts/ideas/idea-notes.mjs` holds the format, the reader, the check and
  the promotion, with no dependency. `check-idea-notes.mjs` and
  `promote-idea.mjs` are the two command-line entry points.
- The properties are read by hand rather than by a YAML library, because
  Obsidian writes lists in the block form and the import's own reader takes only
  the inline form. The reader takes both and nothing else it does not need.
- `functions/src/lib/cms/idea-promotion.test.js` holds the two sides to each
  other: every draft the script writes is read back by the import's own parser
  (`parseRepoDraft`), and the format's limits and content types equal the
  import's and the publisher's. CI's `functions` row watches
  `scripts/ideas/idea-notes.mjs` for that reason.
- The tests build their notes in temporary folders. They never read a real
  vault.
