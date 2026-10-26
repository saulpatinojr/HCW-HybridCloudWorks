# Open-source Docker app dossier

Version 1.0, drafted 2026-10-25. It is the standard for what an open-source
Docker app from Hybrid Cloud Works (HCW) must look like so that its images can
qualify for Docker's free open-source programme, plus a fill-in dossier that
records the proof for each product. Owner: the repository owner. Last
reviewed: 2026-10-25. Next review: 2027-01-25, or sooner if Docker changes the
two pages quoted in section 2.

Nothing on this page applies to Docker, sends anything to Docker or changes any
image. It is a checklist and a record. The related ticket is
[#678](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/678).

The reader is an administrator who may be new to this estate. The terms are
explained in the list below, and every command says what a good result looks
like.

Words used on this page:

- **DSOS** is the Docker-Sponsored Open Source programme: Docker gives
  qualifying open-source projects extra features on Docker Hub for a year at a
  time, renewable ([Docker's programme page](https://docs.docker.com/docker-hub/repos/manage/trusted-content/dsos-program/)).
- **Docker Hub** is [Docker's public website](https://hub.docker.com/) for
  sharing container images; the server behind it that stores the images is a
  **registry**. An **image** is a packaged application that Docker can run, a
  **tag** is the name after the colon that picks one version of it (`latest`,
  `v0.1.0`), and a **Dockerfile** is the recipe file an image is built from
  ([Dockerfile reference](https://docs.docker.com/reference/dockerfile/)).
- **Namespace** is the name in front of the slash in an image name. In
  `hybridcloudworks/img-ne-appliance-app` the namespace is `hybridcloudworks`,
  which is also the name of HCW's Docker organisation (a shared account on
  Docker Hub that owns the image repositories).
- **OSI** is the [Open Source Initiative](https://opensource.org/), which keeps
  the [Open Source Definition](https://opensource.org/osd) and a
  [list of licences](https://opensource.org/licenses) that meet it.
- **SPDX id** is the short, fixed name of a licence, such as `Apache-2.0` or
  `MIT`, from the [SPDX licence list](https://spdx.org/licenses/).
- **Image label** is a line of text stored inside a container image. The label
  `org.opencontainers.image.licenses` is the standard place for the licence
  ([OCI image annotations](https://github.com/opencontainers/image-spec/blob/main/annotations.md)).
- A **workflow** is one of a repository's automated jobs, a file in
  `.github/workflows/` that GitHub runs
  ([GitHub Actions](https://docs.github.com/en/actions)). **OIDC** is a
  short-lived login that a workflow exchanges for a temporary credential, so no
  password or token is stored in the repository
  ([GitHub's explanation](https://docs.github.com/en/actions/concepts/security/openid-connect),
  [Docker's OIDC connections](https://docs.docker.com/security/authentication/oidc-connections/create-manage/)).
- **Provenance** is a record of how an image was built: which workflow, from
  which source, with which settings
  ([Docker's provenance attestations](https://docs.docker.com/build/metadata/attestations/slsa-provenance/)),
  written in the [SLSA](https://slsa.dev/spec/v1.0/provenance) format. It is not
  the same thing as a signature on the image.
  An **SBOM** (software bill of materials) lists what is inside it
  ([Docker's SBOM attestations](https://docs.docker.com/build/metadata/attestations/sbom/)).
  Both travel with the image as attachments called attestations.
- **Docker Scout** is Docker's image checker for known vulnerabilities
  ([Docker Scout](https://docs.docker.com/scout/); this repository's
  [Scout runbook](../runbooks/docker-scout.md)).
- A **ruleset** is a repository's merge rules
  ([GitHub's rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets)).
  **Dependabot** opens pull requests for outdated dependencies
  ([options](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference)),
  **CodeQL** is GitHub's code scanner
  ([CodeQL](https://docs.github.com/en/code-security/concepts/code-scanning/codeql/codeql-code-scanning));
  its **default setup** is the version GitHub switches on from the repository's
  settings, with no workflow file. **Dependency review** blocks a pull request
  that adds a known-bad dependency
  ([dependency review](https://docs.github.com/en/code-security/concepts/supply-chain-security/dependency-review)).

## 1. How to use this page

1. Read section 2 once, so you know what Docker asks and what it does not say.
2. For a new product, copy the template in section 4 and fill it. Until the
   owner picks another home, a product's filled block goes on this page, after
   the Network Eyes example in section 5: the
   [field application standard](hcw-field-application-standard.md) explains why
   the shared pages live in this repository.
3. Work down the checklist in section 3. For each rule, run the check, and write
   the link to the proof and the date you read it into the dossier. A rule that
   fails stays in the dossier as a gap with a named person and a ticket.
4. When every rule reads "met", the product is DSOS-ready. Applying to Docker is
   a separate, owner-only step: this page never submits anything.
5. Re-read the checklist before the yearly renewal (section 2) and whenever the
   product changes licence, publisher or image names.

Section 5 is the finished example for Network Eyes. Copy its layout, not its
values.

## 2. What Docker asks for

Read on 2026-10-25 from Docker's two pages: the
[programme page](https://docs.docker.com/docker-hub/repos/manage/trusted-content/dsos-program/)
and the [application page](https://www.docker.com/community/open-source/application/).

Docker's wording of the four rules (the numbers are this page's own; Docker's
page lists the rules without numbers):

| # | Rule | Docker's words | Page |
| --- | --- | --- | --- |
| 1 | Public images and public source | "Be shared in public repositories on Docker Hub, and the source code must also be publicly accessible on its respective repository." The programme page puts it as "a publisher must share the project namespace in public repositories". | [application](https://www.docker.com/community/open-source/application/), [programme](https://docs.docker.com/docker-hub/repos/manage/trusted-content/dsos-program/) |
| 2 | Open source | "Meet the Open Source Initiative definition." | [application](https://www.docker.com/community/open-source/application/) |
| 3 | Active development | "Be in active development on Docker Hub, which means image updates are pushed regularly within the past 6 months or dependencies are updated regularly, even if the project source code is stable." | [application](https://www.docker.com/community/open-source/application/) |
| 4 | No pathway to commercialization | "Not having a pathway to commercialization. Your organization must not seek to make a profit through services or by charging for higher tiers. Accepting donations to sustain your efforts is permissible." | [application](https://www.docker.com/community/open-source/application/) |

What a project gets, in Docker's words: a repository logo, a "Verified
Docker-Sponsored Open Source badge", insights and analytics, "Access to Docker
Scout" (free on up to 100 repositories), "Removal of rate limiting for
developers" and "Improved discoverability on Docker Hub". The application page
adds that core contributors get "a free, one-year Docker Team subscription".

Terms that matter after approval, from the application page:

- "Program status and benefits are valid for one year and can be renewed if your
  project still meets the program requirements." So the dossier carries a
  renewal date, and the yearly renewal is a fresh check of section 3.
- "Program benefits are provided only to project leads and core project
  committers", "solely for developing non-commercial open-source projects", and
  "Docker licenses are for use only by project collaborators and cannot be
  shared with any third party."

**The paid-plan caveat.** Neither page says whether an organisation that
already pays for a Docker plan can be accepted, or what happens to that plan if
it is. The pages are silent, so do not assume either answer. Ask Docker in
writing when you apply and keep the reply in the owner's private notes. The
public dossier records only that the question was asked and on what date; it
never records plan or billing details. What to do with a plan afterwards is an
owner decision, made and kept privately.

**Two more things to ask.** First, Docker's fourth rule says "through
services". Keep paid support, consulting and training out of the product's
README, documentation and image descriptions (rule OSS-8 below). Whether HCW's
separate teaching work counts as a pathway is Docker's decision, so ask it in
the same message. Second, Docker's first rule talks about "the project
namespace", which this page reads as the whole Docker organisation and not one
image. A new
product that publishes into an organisation already in the programme may
therefore not need an application of its own. That is a reading of Docker's
words, not something Docker states, so ask before applying a second time.

Not read: the application form itself. The application page links it
("Apply here") but this page does not describe its fields. The owner keeps the
answers to the form in private notes.

## 3. The HCW rules for a DSOS-ready app

Each rule is a checkbox. Tick it in the product's dossier only after running the
check and saving the link and date. The commands are PowerShell, one line each,
and work from any folder: they read the repository from GitHub and the image
from Docker Hub, not from your disk. They use the
[GitHub command line](https://cli.github.com/) (`gh`, signed in) and the
Docker command line (`docker`) where marked.

Set the two names once at your PowerShell prompt. The values below are
Network Eyes; for another product, put its repository and its image here and
leave every other line alone. A product with two repositories (an upstream app
and a lab add-on) runs the whole list twice, once for each pair.

```powershell
$repo = 'saulpatinojr/HCW-NetworkEyes_App'; $image = 'hybridcloudworks/img-ne-appliance-app'
```

You should see nothing: PowerShell stores the two values and prints no result.
If the prompt shows an error instead, you pasted only part of the line.

### Source and licence

- [ ] **OSS-1 The source and the images are public.** Docker's rule 1. The
    source repository is public, and so is every image repository in the
    organisation's namespace.

    Check the source and one image repository:

    ```powershell
    gh api repos/$repo --jq '.private'; (Invoke-RestMethod "https://hub.docker.com/v2/repositories/$image").is_private
    ```

    You should see `false` and then `False`. A repository that is private or does
    not exist fails the second call with a "not found" (404) error, because a
    call that is not signed in cannot see it. That also means this check cannot
    find a private repository you did not name. Docker Hub shows private
    repositories only to signed-in members of the organisation, so compare the
    count the next command prints with the count on the organisation's
    repository list on
    [Docker Hub](https://hub.docker.com/orgs/hybridcloudworks/repositories)
    (signed in). They must be equal: if the signed-in list is longer, the extra
    repositories are private and this rule fails.

    ```powershell
    (Invoke-RestMethod 'https://hub.docker.com/v2/repositories/hybridcloudworks/?page_size=100').count
    ```

- [ ] **OSS-2 The licence is an OSI-approved licence, in a `LICENSE` file at the
    repository root.** Docker's rule 2. Pick it from the
    [OSI licence list](https://opensource.org/licenses); GitHub's
    [licensing page](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/licensing-a-repository)
    explains how it detects a licence.

    ```powershell
    gh api repos/$repo --jq '.license.spdx_id'
    ```

    You should see an SPDX id from the OSI list, for example `Apache-2.0`.
    `NOASSERTION` or `null` means GitHub could not recognise the file: fix the
    file before going on.

- [ ] **OSS-3 The same SPDX id is stated everywhere.** The `LICENSE` file, the
    `org.opencontainers.image.licenses` label in the Dockerfile, the `NOTICE` file
    and the README's Licence section all name the same SPDX id. A product with a
    tracked test that fails when they disagree is better still: Network Eyes has
    [`tests/unit/test_licence_statement.py`](https://github.com/saulpatinojr/HCW-NetworkEyes_App/blob/main/tests/unit/test_licence_statement.py).
    The cautionary example is Network Eyes itself: its image label said
    "Proprietary" while `LICENSE` said Apache-2.0, so anyone reading the image's
    metadata was told something different from the repository
    ([pull request #306](https://github.com/saulpatinojr/HCW-NetworkEyes_App/pull/306),
    merged 2026-10-25). Check the published image and the two text files (the first
    line needs `docker`):

    ```powershell
    (docker buildx imagetools inspect ${image}:latest --format '{{json .Image}}' | ConvertFrom-Json).config.Labels.'org.opencontainers.image.licenses'
    ```

    ```powershell
    'NOTICE','README.md' | ForEach-Object { $f = $_; gh api "repos/$repo/contents/$f" -H 'Accept: application/vnd.github.raw+json' | Select-String -Pattern 'Apache-2.0' | ForEach-Object { "$f -> $($_.Line)" } }
    ```

    The first should print the SPDX id, the same one as OSS-2. The second should
    print at least one line for each file, starting with the file's name. Change
    `Apache-2.0` in the second line to the product's own id if it differs.
    Nothing printed for a file means that file does not name the licence yet.
    The label can only change when the image is rebuilt, so check a tag built
    after the Dockerfile change.

- [ ] **OSS-4 The copyright holder is named in `LICENSE` or `NOTICE`.** The
    holder is always one of two names (owner instruction, 2026-10-25): **Saul
    Patino** for personal work, or **Hybrid Cloud Works** for the website, the
    apps and every other HCW project. A line in the form
    `Copyright 2026 Hybrid Cloud Works` (or the usual MIT form, `Copyright (c) 2026
    Hybrid Cloud Works`) in `NOTICE` or `LICENSE` is enough. The year is the
    year of the repository's first commit. This rule says who the holder is; it
    is not legal advice.

    ```powershell
    'LICENSE','NOTICE' | ForEach-Object { $f = $_; gh api "repos/$repo/contents/$f" -H 'Accept: application/vnd.github.raw+json' | Select-String -Pattern 'Copyright (\(c\) )?(19|20)[0-9]{2} (Saul Patino|Hybrid Cloud Works)' | ForEach-Object { "$f -> $($_.Line)" } }
    ```

    You should see one matching line, starting with the file's name. Nothing
    printed means no holder is named. The unfilled line
    `Copyright [yyyy] [name of copyright owner]`, which comes with the Apache
    text, does not match and does not count.

### Images and supply chain

- [ ] **OSS-5 Images are published only through Docker's OIDC login from GitHub
    Actions.** One publishing workflow, no registry password or token stored as a
    repository secret for publishing. Read the workflow: it needs
    `id-token: write` and the Docker Hub OIDC connection, and the repository's
    Actions secrets (names only) should list no Docker token. The field standard's
    rule is [REL-3](hcw-field-application-standard.md#210-releases).

    ```powershell
    gh api repos/$repo/actions/secrets --jq '.secrets[].name'
    ```

    You should see only secret names, and none that holds a Docker password or
    token. This reads names only, never values. If it fails with an
    error, your GitHub sign-in is probably not an administrator of the repository:
    ask the owner to run it.

- [ ] **OSS-6 Every published image carries provenance and an SBOM, and a Docker
    Scout check ran on it.** Check the attachments on the published image (needs
    `docker`):

    ```powershell
    docker buildx imagetools inspect ${image}:latest --format '{{json .SBOM}}' | ConvertFrom-Json | ForEach-Object { $_.PSObject.Properties.Name }
    ```

    ```powershell
    docker buildx imagetools inspect ${image}:latest --format '{{json .Provenance}}' | ConvertFrom-Json | ForEach-Object { $_.PSObject.Properties.Name }
    ```

    You should see `SPDX` from the first and `SLSA` from the second. An image
    with no attachments prints `{}` from the raw command and nothing from these.
    These two lines were run only on images built for one platform, as Network
    Eyes's are. For an image built for several platforms the names printed are
    platform names such as `linux/amd64`, and these lines do not tell you
    whether each platform has its attachments: say in the dossier how you
    checked, using [Docker's SBOM attestations](https://docs.docker.com/build/metadata/attestations/sbom/)
    as the guide. The same limit applies to the label check in OSS-3.

    The checks above prove that the attachments exist. They do not prove that
    the image is signed; a signature is a separate step that the publishing
    workflow may add.

    The Scout check is a step in the publishing workflow that runs
    [`docker/scout-action`](https://github.com/docker/scout-action). Open the
    repository's Actions page, pick the publishing workflow, open its latest run
    and confirm that step succeeded. Save the run's link as the evidence.

    ```powershell
    Start-Process "https://github.com/$repo/actions"
    ```

    You should see the repository's list of workflow runs in your browser.

- [ ] **OSS-7 The image repository is named
    `img-<code>-<lab-addon|appliance-app>`.** `<code>` is the product's two-letter
    code (`mo`, `ca`, `ne`, `cc`, and any later one). `appliance-app` is the
    image of the main application (the "upstream app"), and `lab-addon` is the
    small free build, with no cloud access, that the website shows inside a frame
    (an embedded window) on one of its pages. This is the same convention as [IMG-1](hcw-field-application-standard.md#211-container-images)
    in the field standard. The tag is the release tag, such as `v0.1.0`.

    ```powershell
    (Invoke-RestMethod 'https://hub.docker.com/v2/repositories/hybridcloudworks/?page_size=100').results | Select-Object name
    ```

    You should see a name of this shape for the product. A name that does not
    follow it is recorded in the dossier as a gap, with the reason if there is one.

### Free for the community

- [ ] **OSS-8 The product is free for the HCW community, with no paid edition.**
    Docker's rule 4: no profit "through services or by charging for higher
    tiers". No paid version, no feature kept back for payers, no payment code, and
    no offer of paid support, consulting or training in the README, the
    documentation or the image descriptions. Accepting donations is allowed by
    Docker. The proof is the owner's written statement, dated, plus a read of the
    README and the documentation. No command can prove a business model, so the
    dossier names who made the statement and when.

- [ ] **OSS-9 Public text says "user", not "customer", "client", "pricing" or
    "edition".** In every document of the repository: all Markdown files
    (`README.md`, `CLAUDE.md`, the plans, the changelog), `NOTICE`, `.env.example`
    (the list of settings) and the issue forms under `.github/ISSUE_TEMPLATE/`.
    Those words make a reader think of a paid product, and Docker's fourth rule
    is about exactly that. Say "user" for the people, and say what a free build
    is ("the lab build") instead of "edition". Technical terms that happen to
    contain a word are fine (`APP_CLIENT_ID`, "client secret"), and so is saying
    there is no paid edition: the rule is about people and prices. Dated history
    (a changelog entry, a withdrawn decision) and a quote of another party are
    kept as they were. A product name that has to contain a listed word is
    recorded in the dossier as an exception, with the reason and who decided.

    The command asks GitHub for the newest commit on `main`, lists that commit's
    files, keeps the documents named above, reads each one at that same commit
    and prints a line for every hit. It stops with an error, rather than print a
    partial list, if it cannot read the commit, the file list or a file, or if
    GitHub cut the file list off (the limit is 100,000 entries or 7 MB, see
    [GitHub's page](https://docs.github.com/en/rest/git/trees#get-a-tree); none of
    our repositories is near it).

    ```powershell
    $sha = gh api "repos/$repo/commits/main" --jq .sha; if ($LASTEXITCODE -ne 0) { throw 'Could not read main' }; "commit $sha"; $treeJson = gh api "repos/$repo/git/trees/${sha}?recursive=1"; if ($LASTEXITCODE -ne 0) { throw 'Could not read the file list' }; $tree = $treeJson | ConvertFrom-Json; if ($null -eq $tree -or $null -eq $tree.tree) { throw 'Could not parse the file list' }; if ($tree.truncated) { throw 'GitHub cut the file list short' }; $tree.tree | Where-Object { $_.path -match '\.md$|^NOTICE$|^\.env\.example$|^\.github/ISSUE_TEMPLATE/.*\.ya?ml$' } | ForEach-Object { $f = $_.path; $t = gh api "repos/$repo/contents/${f}?ref=$sha" -H 'Accept: application/vnd.github.raw+json'; if ($LASTEXITCODE -ne 0) { throw "Could not read $f" }; $t | Select-String -Pattern 'customer|client|pricing|edition' | ForEach-Object { "$f line $($_.LineNumber)" } }
    ```

    You should see the word `commit` and a 40-character commit id first, then
    one line per hit, for example `README.md line 17`: the file's path, the word
    `line` and the line number (on GitHub, add `#L17` to the file's address to
    jump to it). Expect some lines even for a clean product: a technical term,
    the sentence that denies a paid edition, and anything in a changelog
    (history). Open each one and decide: change it if it describes the product or
    its users; keep it if it is a technical term, dated history or a quote of
    another party. A red error message such as `Could not read` or `GitHub cut
    the file list short` means the list is incomplete: do not call OSS-9 met from
    it.

    OSS-9 is met when the command finishes without an error and every printed
    line is one you decided to keep. Write in the dossier the commit id it
    printed, how many lines there were and why they stay. A product with a
    tracked test that fails when the removed wording comes back is better
    still: Network Eyes has one, `tests/unit/test_free_tool_wording.py`, added by
    [pull request #320](https://github.com/saulpatinojr/HCW-NetworkEyes_App/pull/320).
    It guards the wording that ticket removed (`customer`, a lab, appliance or
    downstream `edition`, `client-facing`, `client delivery` and `client
    engagement` in the documents; a company name anywhere; the Dockerfile
    comments and labels; the text sent to the AI model), so the search above
    stays the rule's check.

- [ ] **OSS-10 The product is in active development.** Docker's rule 3 asks for
    image updates "pushed regularly within the past 6 months" (or dependencies
    updated regularly). HCW's check is stricter and simpler: the newest tag is
    less than six months old. The date of the newest tag is the proof.

    ```powershell
    (Invoke-RestMethod "https://hub.docker.com/v2/repositories/$image/tags?page_size=3").results | Select-Object name, last_updated | Format-Table
    ```

    You should see up to three tags and their push dates, the newest first. If
    even the newest date is older than six months, the product is a gap to
    explain to Docker, because Docker's other test (dependencies updated
    regularly) may still be met.

### Repository health

- [ ] **OSS-11 The community files and issue forms exist.** `SECURITY.md`,
    `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md` (in `.github/` or at the root), issue
    **forms** (`.yml` files, the
    [syntax](https://docs.github.com/en/communities/using-templates-to-encourage-useful-issues-and-pull-requests/syntax-for-issue-forms)),
    and GitHub's private vulnerability reporting switched on
    ([how it works](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)).
    The field standard's rules are COM-1 to COM-3 and COM-7 in
    [section 2.3](hcw-field-application-standard.md#23-community-and-contribution-files).

    ```powershell
    gh api repos/$repo/contents/.github --jq '.[].name'; gh api repos/$repo/contents/.github/ISSUE_TEMPLATE --jq '.[].name'; gh api repos/$repo/private-vulnerability-reporting --jq '.enabled'
    ```

    You should see the three files and an `ISSUE_TEMPLATE` folder in the first
    list, form files ending in `.yml` in the second, and `true` last. The first
    command lists only `.github/`: if a file is not there, look at the
    repository root and `docs/`, where GitHub also finds it.

- [ ] **OSS-12 The rulesets "Protect main" and "Protect release tags" are
    active.** The field standard's rule is [PRO-1](hcw-field-application-standard.md#25-branch-and-tag-protection).

    ```powershell
    (gh api repos/$repo/rulesets | ConvertFrom-Json) | Select-Object name, enforcement, target | Format-Table
    ```

    (The brackets matter: Windows PowerShell 5.1 prints an empty row without
    them.) You should see two rows, `Protect main` (target `branch`) and
    `Protect release tags` (target `tag`), both with enforcement `active`. To
    read what each rule does, open the repository's rules page (signed in or
    not) and pick the ruleset:

    ```powershell
    Start-Process "https://github.com/$repo/rules"
    ```

- [ ] **OSS-13 Dependabot, CodeQL and dependency review are on.** A
    `.github/dependabot.yml` that covers every package type in the repository
    ([DEP-1](hcw-field-application-standard.md#28-dependencies)), CodeQL covering
    every language the repository has ([SEC-3](hcw-field-application-standard.md#29-security-scanning)),
    and a dependency review job ([DEP-3](hcw-field-application-standard.md#28-dependencies)).

    ```powershell
    gh api repos/$repo/contents/.github/dependabot.yml --jq '.path'; gh api repos/$repo/code-scanning/default-setup --jq '.state'
    ```

    You should see `.github/dependabot.yml` and then `configured`. A product that
    runs CodeQL from its own workflow file instead of GitHub's default setup
    prints `not-configured` for the second line; then open the repository's code
    scanning page (signed in) and confirm a recent CodeQL run:

    ```powershell
    Start-Process "https://github.com/$repo/security/code-scanning"
    ```

    The dependency review job is found by reading the workflow files for
    [`actions/dependency-review-action`](https://github.com/actions/dependency-review-action).

## 4. The dossier to fill in

Copy this block into the product's dossier and fill every field. The angle
brackets mark values to replace; this block is a template and is not meant to be
pasted into a shell. Write "none" or "not yet" rather than leaving a field empty,
and never write a secret, a private email address or a Docker plan detail into
it: the dossier is public.

```text
Dossier: <product name>

Product name:             <product name>
Short code:               <two letters, for example ne>
Dossier owner:            <person>
Last reviewed:            <YYYY-MM-DD>
Next review:              <YYYY-MM-DD, within three months>
Related ticket:           <link>

Source repositories (public):
  <upstream app repository link>      licence <SPDX id>
  <add-on repository link, or none>   licence <SPDX id>

Docker organisation:      <organisation name>
Image repositories (public):
  <organisation>/img-<code>-appliance-app
  <organisation>/img-<code>-lab-addon

Licence (SPDX id):        <SPDX id>
Copyright holder:         <Saul Patino | Hybrid Cloud Works>
One-sentence goal:        <what the product does and for whom>
Who benefits:             <the people who use it, in plain words>
First image published:    <YYYY-MM-DD>

Evidence per rule (link, date read, status: met | part | not met):
  OSS-1  public source and images:                <link> <date> <status>
  OSS-2  OSI-approved licence:                    <link> <date> <status>
  OSS-3  same SPDX id in four places:             <link> <date> <status>
  OSS-4  copyright holder named:                  <link> <date> <status>
  OSS-5  published only through OIDC:             <link> <date> <status>
  OSS-6  provenance, SBOM and Scout check:        <link> <date> <status>
  OSS-7  image repository name:                   <link> <date> <status>
  OSS-8  free, no paid edition (owner statement): <link> <date> <status>
  OSS-9  wording in every document:               <link> <date> <status>
  OSS-10 active development:                      <link> <date> <status>
  OSS-11 community files and issue forms:         <link> <date> <status>
  OSS-12 rulesets:                                <link> <date> <status>
  OSS-13 Dependabot, CodeQL, dependency review:   <link> <date> <status>

Open gaps (rule, what is missing, who closes it, ticket):
  <rule> <gap> <person> <link>

DSOS application:
  Status:                 <not submitted | submitted | approved | refused | renewed>
  Date:                   <YYYY-MM-DD>
  Docker's reply:         <date and a one-line summary of the application decision; the full reply stays in the owner's private notes>
  Paid-plan question:     <asked on YYYY-MM-DD | not asked yet> (the answer and any plan details stay in the owner's private notes)
  Renewal date:           <one year after approval, YYYY-MM-DD>
```

## 5. Worked example: Network Eyes

Network Eyes is the first product written up. The values were read on
2026-10-25 (times in UTC) from the repository's default branch, Docker Hub and
the registry; the files that changed in the meantime (`LICENSE`, `NOTICE`, the
README and `CLAUDE.md`, after
[pull request #316](https://github.com/saulpatinojr/HCW-NetworkEyes_App/pull/316)
merged at 04:35 UTC on 2026-10-26) were read again on `main` at commit
`fe6c3b41`. Re-read before relying on any of them: the repository changes every
day.

| Field | Value |
| --- | --- |
| Product name | Network Eyes (the repositories and images write it `NetworkEyes`) |
| Short code | `ne` |
| Source repositories | [HCW-NetworkEyes_App](https://github.com/saulpatinojr/HCW-NetworkEyes_App) (Apache-2.0), [HCW-NetworkEyes_AddOn](https://github.com/saulpatinojr/HCW-NetworkEyes_AddOn) (MIT) |
| Docker organisation | [hybridcloudworks](https://hub.docker.com/u/hybridcloudworks) |
| Image repositories | [img-ne-appliance-app](https://hub.docker.com/r/hybridcloudworks/img-ne-appliance-app), [img-ne-lab-addon](https://hub.docker.com/r/hybridcloudworks/img-ne-lab-addon) |
| Licence | Apache-2.0 for the app and its image, MIT for the add-on repository |
| Copyright holder | Hybrid Cloud Works (owner rule), written into `LICENSE` and `NOTICE` by pull request #316 |
| One-sentence goal | Point it at an Azure or AWS environment and it checks the network against security and migration-readiness rules and writes a report. |
| Who benefits | Cloud and network engineers who follow Hybrid Cloud Works, and students learning how a network assessment works (the owner's wording for the application form). |
| First image published | 2026-10-25 (Docker Hub lists both repositories as created that day) |
| Related ticket | [#678](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/678) |
| DSOS application | Not submitted. The answers are prepared in the owner's private notes. |
| Docker's reply | None yet. |
| Renewal date | None yet (it starts one year after approval). |

Status of each rule on 2026-10-25:

| Rule | Status | Evidence |
| --- | --- | --- |
| OSS-1 | Met, one part not checked | The repository reports `private: false`; both image repositories answer a signed-out call. Nine repositories are listed to a signed-out visitor under `hybridcloudworks`. Whether the organisation also holds a private one was not checked (a signed-out call cannot see it). |
| OSS-2 | Met, one caveat | GitHub reports `Apache-2.0`; `LICENSE` is the Apache License 2.0 text, which is on the [OSI list](https://opensource.org/license/apache-2-0). Caveat: [`NOTICE`](https://github.com/saulpatinojr/HCW-NetworkEyes_App/blob/main/NOTICE) lists the Aeonik typeface (two font files in the repository) as not covered by the Apache licence. It records the owner's statement of 2026-10-25 that no separate licence is required, and says the repository has not verified that. The code is Apache-2.0; whether the font bears on Docker's "Open Source Initiative definition" rule is the owner's call. |
| OSS-3 | Met for the app, **not met for the add-on image** | App: the root [`Dockerfile`](https://github.com/saulpatinojr/HCW-NetworkEyes_App/blob/main/Dockerfile) label, [`NOTICE`](https://github.com/saulpatinojr/HCW-NetworkEyes_App/blob/main/NOTICE) and the README's Licence section all say `Apache-2.0`, and the registry shows `Apache-2.0` on the tags `latest`, `web-latest`, `api-latest`, `worker-latest` and `migrator-latest`. The add-on's tags `0.1.0` and `v0.1.1-rc.1` carry no licence label although its repository is MIT. |
| OSS-4 | Met since pull request #316 | On the morning of 2026-10-25 `LICENSE` still carried the Apache text's unfilled `Copyright [yyyy] [name of copyright owner]` line and `NOTICE` had no copyright line. [Pull request #316](https://github.com/saulpatinojr/HCW-NetworkEyes_App/pull/316) fixed both while this page was being written: on `main` (`fe6c3b41`) `LICENSE` line 189 and `NOTICE` read `Copyright 2026 Hybrid Cloud Works`. The add-on's `LICENSE` says `Copyright (c) 2026 Hybrid Cloud Works`. |
| OSS-5 | Part: publishing is OIDC, stored Docker secrets remain | The [publishing workflow](https://github.com/saulpatinojr/HCW-NetworkEyes_App/blob/main/.github/workflows/200-build-images.yml) logs in to Docker Hub through OIDC. The separate clean-up workflow [`370-registry-cleanup.yml`](https://github.com/saulpatinojr/HCW-NetworkEyes_App/blob/main/.github/workflows/370-registry-cleanup.yml) still reads the stored secret `DOCKERHUB_PERSONAL_TOKEN`; the field standard tracks it as G-11. The repository's secret list (names only) also holds `DOCKERHUB_TOKEN`, which no workflow in `.github/workflows` references; whether it is still needed is an owner question. (The list also holds `DOCKERHUB_PERSONAL_USERNAME`, which workflow 370 reads as a variable and not as a secret.) |
| OSS-6 | Met | Both `latest` (app) and `0.1.0` (add-on), each built for one platform, carry an SPDX SBOM and SLSA provenance attestation. Whether the images are also signed was not checked here (the publishing workflow has signing steps and they succeeded in the run below). Docker Scout steps ran and succeeded in [run 40245507222](https://github.com/saulpatinojr/HCW-NetworkEyes_App/actions/runs/40245507222) of the publishing workflow (2026-10-25). |
| OSS-7 | Met | `img-ne-appliance-app` and `img-ne-lab-addon`. The organisation also holds `hcw-lab` and `hcw-lab-runner`, older names for the website's lab images, which do not follow the convention. |
| OSS-8 | Owner statement | Owner statement, 2026-10-25: a free tool for followers of Hybrid Cloud Works, shared through GitHub, with no paid edition. A repository search for payment code is not proof and was not relied on. |
| OSS-9 | **Part until [pull request #320](https://github.com/saulpatinojr/HCW-NetworkEyes_App/pull/320) merges** | Read on 2026-10-26 on `main` at commit [19759c6a](https://github.com/saulpatinojr/HCW-NetworkEyes_App/commit/19759c6a67aee801afc769faa9f288e3cb81784c) with the check that now reads every Markdown file, `NOTICE`, `.env.example` and the issue forms: it printed 233 lines in 14 files and finished without an error. The README and `CLAUDE.md` have said "user", "free tool" and "lab build" since pull requests [#316](https://github.com/saulpatinojr/HCW-NetworkEyes_App/pull/316) and [#317](https://github.com/saulpatinojr/HCW-NetworkEyes_App/pull/317): their three remaining lines are the sentence that denies a paid edition (README line 17) and two technical terms (`APP_CLIENT_ID`, README line 209, and "client secret", `CLAUDE.md` line 204). The other files did not pass. `.github/SECURITY.md` said "the client delivery portal"; it, `.github/CONTRIBUTING.md`, the pull request template and the three issue forms said "customer data"; `.env.example` said "client delivery portal" and `stcna<customer>tfstate`; `REVIEW.md` said "customer" on 20 lines, `REFACTOR_APP.md` on 9 and `TODO.md` on 2. (Ticket [#318](https://github.com/saulpatinojr/HCW-NetworkEyes_App/issues/318) also found two documents that credited a company's engineering standards; the search cannot find that.) [Pull request #320](https://github.com/saulpatinojr/HCW-NetworkEyes_App/pull/320) rewords them, keeps dated history, a withdrawn decision, the AWS term "customer gateway" and the startup messages the code prints, and adds the test named in the rule. After it merges the same command still prints about 195 lines in 8 files; nearly all stay on purpose (software `client` variables, the `EDITION` build argument and the `edition` JSON key, "client secret", quoted messages, the changelog's history), and you judge each against the rule, so the status becomes met when it merges. Open for the owner (ticket #318): the earlier brand's logo and colour palette (the test lists them line by line), the name of the "Client portal" feature, and the text on the two Docker Hub pages. |
| OSS-10 | Met | Newest tag pushed 2026-10-25 23:42 UTC (`img-ne-appliance-app`); the repository was last pushed on 2026-10-26 UTC (a time-sensitive value, and not a Docker criterion). |
| OSS-11 | Met | `SECURITY.md`, `CONTRIBUTING.md` and `CODE_OF_CONDUCT.md` in [`.github/`](https://github.com/saulpatinojr/HCW-NetworkEyes_App/tree/main/.github); forms `bug_report.yml`, `feature_request.yml`, `work_item.yml` and `config.yml`; private vulnerability reporting is `true`. |
| OSS-12 | Met, one difference | Both rulesets are `active`. "Protect main" has the rules `deletion`, `non_fast_forward` (no force push), `pull_request` and `required_status_checks` (11 checks). "Protect release tags" protects `refs/tags/v*` but lists the repository-administrator role as a bypass actor (a role allowed to skip the rules, here `always`), the same in all four App repositories; the field standard's PRO-1 says "no bypass". Left for the owner to reconcile. |
| OSS-13 | Met | `dependabot.yml` covers `uv`, `github-actions`, `docker` and `npm`; CodeQL default setup is `configured` for `actions`, `javascript-typescript` and `python`; the job `Dependency Review` is in workflow `300-test-codebase.yml` and is a required check. (The field standard's gap G-16, CodeQL scanning only `actions`, was true when it was written and is no longer.) |

Two rows of the field application standard have moved since it was written on
the morning of 2026-10-25: [IMG-1](hcw-field-application-standard.md#211-container-images)
says Docker Hub shows no tags for the `img-*-appliance-app` repositories (Network
Eyes now has 21), and PRO-3 counts 10 required checks (the ruleset now has 11).
Refresh them at the standard's next review.

What the example shows: a product can have every rule met for its main image and
still fail on its second image or on the words in its README. Fill the dossier
honestly and let the gap column drive the next pull request.

Not assessed for the add-on repository `HCW-NetworkEyes_AddOn`: everything
except its licence, its copyright line and the label on its image. Run the
checklist on it as its own pair of names.

## 6. When a product stops being eligible

A product stops being eligible the moment it gets a paid edition or features
only paying users can have. Docker's rule 4 looks at a "pathway to
commercialization", and the namespace is shared. Docker's pages do not say how a
breach is handled, so treat it as a risk to every image in the same Docker
organisation, as a precaution. Move that
product's image repositories to a separate Docker organisation before the paid
edition is released, point its README and website page at the new names, and
record the move in the dossier of every product that stays. The free products
keep the original organisation and the programme status. How to move
repositories between Docker organisations, and whether to tell Docker about it
before the next renewal, are not covered by Docker's two pages: check Docker's
documentation at the time, and ask.

## 7. Keeping this page true

- **Owner:** the repository owner decides the rules. A change to a rule is a
  pull request that also updates the Network Eyes example and the
  [CHANGELOG](../repo/changelog.md).
- **Review cadence:** every quarter (next: 2027-01-25), at each yearly renewal,
  and whenever Docker changes the two pages quoted in section 2.
- **Single copy:** the standard lives here. A product's filled block holds only
  its own values and links back to the rules above; it does not copy them.
- **No guard script:** this repository has no test or script that checks
  standards pages for content, so none was added. The page is covered by the
  documentation build (`mkdocs build --strict`) and the two documentation scans,
  [`check_redaction.py`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/scripts/docs/check_redaction.py)
  and
  [`check_stale_state.py`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/scripts/docs/check_stale_state.py),
  which run on every documentation pull request in
  [`docs-pages.yml`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/.github/workflows/docs-pages.yml).

## 8. How this was checked, and what was not

Read on 2026-10-25: Docker's two pages (raw HTML, to confirm the quoted words),
the Network Eyes repository through the GitHub API (licence, files, rulesets,
code scanning setting, workflows, secret names, a recent run), Docker Hub's
public API (repositories and tags), and the registry (image labels and
attestations). Every command in section 3 except the three `Start-Process` lines (which
open a browser) was run against Network Eyes, in PowerShell 7 and in Windows
PowerShell 5.1, and printed what the page says it
should (on the morning of 2026-10-25 the copyright check printed nothing for the
app, because `main` named no holder yet; after pull request #316 it prints a
line for each of `LICENSE` and `NOTICE`). A separate reviewer re-checked the quotes against Docker's pages and
the Network Eyes values against GitHub and Docker Hub, and its corrections are
in this version. The documentation links were opened and their titles read.

The OSS-9 command was rewritten on 2026-10-26 and run, copied out of this page, in PowerShell 7.6.7 and in Windows
PowerShell 5.1 against Network Eyes `main` at commit 19759c6a: both printed that commit id and 233 lines in 14 files and
finished without an error. Two error paths were triggered: a repository that does not exist stops the command with
`Could not read main`, and a commit id that does not exist stops it with `Could not read the file list`. The paths for a
cut-off file list and for an unreadable file were not triggered, because no repository of ours produces them.

Not checked:

- The Docker application form (its fields, and whether it has a free-text box).
- Whether the Docker organisation holds private repositories (a signed-out call
  cannot see them).
- Anything about the other three App repositories beyond the bypass setting on
  their tag rulesets.
- How Docker will treat any of this: the programme's decision is Docker's.
