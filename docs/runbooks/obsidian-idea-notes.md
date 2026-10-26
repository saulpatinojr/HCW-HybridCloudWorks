# Idea notes: keep ideas in Obsidian, promote the ready ones to drafts

> **Status: in use from 2026-10-24** (#1343), **changed on 2026-10-25** (the
> move of drafts out of the public repository, [PR 1](https://github.com/saulpatinojr/HCW-HybridCloudWorks/pull/1379)
> added the upload box; this page and the promote script are the second step). This is the first step only: a
> format for an idea note, a check for a folder of them, and a script that turns
> one ready idea into a draft article **in your vault's `Drafts` folder**. From
> there you upload it on [Admin → Drafts](https://hybridcloudworks.com/admin/drafts).
> The script no longer writes into this repository, and the old route (commit
> the draft, then *Import from docs/content*) has been removed. There is no
> admin screen for the idea backlog.

**Scope:** how to keep content ideas in [Obsidian](https://obsidian.md/download)
(a notes app that stores plain files on your computer), hold them to one
format, turn an outlined idea into a draft file in your vault's `Drafts`
folder, and upload it on Admin → Drafts.

**Authority:** nothing here changes the site by itself. The scripts only read
your notes and write one new file, inside your own vault. Uploading it on
Admin → Drafts is a separate step, and it is yours. Uploading creates a draft;
it publishes nothing.

## Why the notes, and the drafts, stay outside this repository

This repository is public, and so is the documentation site built from it. A
vault inside it would publish every private thought in it. And an article that
is not finished must not be public either: anything committed under
`docs/content` is visible to everyone the moment it is merged, long before you
decide to publish it. (Owner rule 2026-10-25: pre-publish drafts live in your
private vault and on the Admin → Drafts page, never in the repository or the
docs site.)

So the vault lives somewhere else on your computer, and the scripts are given
the folder as an argument. Nothing from the vault is committed. The promote
script goes one step further: it **refuses** to write a draft anywhere inside
this repository, however the folder is spelt (a relative path, `..`, a
different upper or lower case, or a shortcut folder that really points into the
repository), so a slip cannot publish a draft by accident. A second guard sits
in the test suite: `functions/test/docs-content-guard.test.js` fails the
`functions (azure)` check on any pull request that adds a `blog-*.md` file to
`docs/content`, other than the two contract files `blog-template.md` and
`blog-machine.md`, and its message says where drafts go instead.

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
5. **Tell the promote script where your vault is, once.** Promoted drafts are
   saved in the vault's `Drafts` folder (the script makes the folder if it is
   not there yet), so the script has to know which folder is your vault. Give it
   the vault's full path in an *environment variable* (a named setting that
   Windows keeps for your account and hands to every program you start), called
   `HCW_VAULT`. In PowerShell, the first line asks for the path and the second
   saves it
   ([about_Environment_Variables, Microsoft Learn](https://learn.microsoft.com/powershell/module/microsoft.powershell.core/about/about_environment_variables?view=powershell-7.6#set-environment-variables-with-setenvironmentvariable)):

   ```powershell
   $vault = Read-Host 'Full path of your Obsidian vault folder'
   ```

   ```powershell
   [Environment]::SetEnvironmentVariable('HCW_VAULT', $vault, 'User')
   ```

   Close PowerShell and open a new window: a setting saved this way only reaches
   windows opened afterwards. To check it, run this in the new window. You
   should see your vault's path; a blank line means it did not save, so repeat
   the two lines above:

   ```powershell
   $env:HCW_VAULT
   ```

   If you would rather not save it, skip this step and add `--vault "$vault"`
   to the promote commands below (after running the first line above in the same
   window). The vault must be **outside** the repository: the script refuses a
   folder inside it (see the table at the end of this page).

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
- `type` is `blog` (only blog articles become drafts);
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

   You should see `Would write ...\Drafts\blog-<name>.md`, with the path of
   your own vault in front of `Drafts`, followed by the draft. Nothing is
   written yet. If it lists reasons instead, fix them in the note (the table
   below). If it says `No vault was given`, step 5 of "Set it up once" is not
   done in this window: add `--vault "$vault"` to the command, as that step
   explains. If it says `Refused`, the folder is inside the repository: use
   your private vault.

3. Write it for real:

   ```powershell
   node scripts/ideas/promote-idea.mjs "$note"
   ```

   You should see `Wrote ...\Drafts\blog-<name>.md` and three reminders. The
   file is now in your vault's `Drafts` folder, and nowhere in the repository.
   The file name comes from the title. To choose another, add
   `--name some-other-words`. The script never overwrites: if the file exists
   it stops and says so.

4. **Read the new file through.** It will be published one day, and the script
   cannot know what in your outline you would not want published.
5. In your note, change `status` to `drafted`. The script never edits your
   notes, so this is yours to do.
6. **Upload the file on Admin → Drafts.** Open
   <https://hybridcloudworks.com/admin/drafts>, find the box called **Paste or
   upload a markdown draft**, and follow
   [Send a draft to Admin Drafts](#send-a-draft-to-admin-drafts) below. From
   then on the Drafts page, not the file, is the source of truth for the
   article. Nothing is published by uploading.

There is no step that puts the draft into the repository, on purpose. Do not
commit it, and do not open a pull request for it.

## Send a draft to Admin Drafts

*Added 2026-10-25; it is now the only way in.* The repository is public, so a
draft that is not ready to be seen must not be committed to it.
**Admin → Drafts** takes a markdown file straight from your vault instead. The
older route, committing the draft under `docs/content` and using **Import from
docs/content**, has been removed.

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
| `only blog articles become drafts` | `type` is not `blog`. | Only blog ideas become drafts this way. |
| `a blog draft is a how-to or a build-log` | `format` is something else. | Pick the track the article follows. |
| `a [[wikilink]] or ![[embed]] ...` | A link to another note in your vault. It would show as plain brackets on the site, and it names a private note. | Rewrite it as plain text or a normal link. |
| `an Obsidian %% comment %%` | A private note to yourself inside the text. | Delete it. |
| `a dataview block` (or `tasks`, `query`) | Only Obsidian can run it. | Remove it. |
| `... already exists, and this script never overwrites` | A draft with that name is already in your vault's `Drafts` folder. | Choose another with `--name`. |
| `No vault was given` | Neither `--vault` nor the `HCW_VAULT` setting names your vault. | Do step 5 of "Set it up once", or add `--vault "$vault"`. |
| `The vault folder ... does not exist` | The path is wrong, or the vault has moved. | Check the path; the script never makes the vault itself. |
| `Refused: ... is inside the repository` | The folder you gave (or a shortcut it follows) is inside `HCW-HybridCloudWorks`, which is public. Nothing was written. | Use your private vault, which must be outside the repository. |
| `--out-dir no longer exists` | An old command still has `--out-dir`. | Drop it; the folder is always `<vault>/Drafts`. |

Code blocks and inline code are not searched, so a shell example such as
`if [[ -f x ]]` is fine.

## What this does not do

- It does not edit your notes, sync the vault, or back it up. It only adds one
  file to `Drafts`.
- It does not read JSON-style properties (Obsidian can save those); use the
  normal property table.
- Only blog ideas become drafts. Other types and formats are tracked in the
  notes but are written by hand.
- It does not decide what is private. The refusals above catch what is
  obviously Obsidian-only; reading the draft is the check on everything else.
- It does not upload. Uploading is a step in the admin, by you, and the script
  never signs in to the site.
- There is no admin screen for the idea backlog. Add one only if the notes turn
  out not to be enough.

## How it works, for whoever changes the code

- `scripts/ideas/idea-notes.mjs` holds the format, the reader, the check and
  the promotion, with no dependency. `check-idea-notes.mjs` and
  `promote-idea.mjs` are the two command-line entry points.
- The properties are read by hand rather than by a YAML library, because
  Obsidian writes lists in the block form and the import's own reader takes only
  the inline form. The reader takes both and nothing else it does not need.
- `promote-idea.mjs` works out `<vault>/Drafts`, resolves it through any
  symlink or junction (a folder that is really a shortcut to another folder),
  and refuses it, exit code 1, if it is the repository or anywhere inside it.
  The comparison ignores upper and lower case on Windows and macOS. It checks
  once before reading the note and again after making the folder.
- `functions/src/lib/cms/idea-promotion.test.js` holds the two sides to each
  other: every draft the script writes is read back by the server's own
  parsers (`parseRepoDraft`, and `parseMarkdownDraft`, which the upload route
  uses), and the format's limits and content types equal the reader's and the
  publisher's. CI's `functions` row watches `scripts/ideas/idea-notes.mjs` for
  that reason.
- The tests build their notes and vaults in temporary folders. They never read
  a real vault, and a test must never write under `docs/content`: the refusal
  tests compare that folder before and after each run.
