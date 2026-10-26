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

The reader is an administrator who may be new to this estate. Every term is
explained where it first appears, and every command says what a good result
looks like.

Words used on this page:

- **DSOS** is the Docker-Sponsored Open Source programme: Docker gives
  qualifying open-source projects extra features on Docker Hub, free for a year
  at a time ([Docker's programme page](https://docs.docker.com/docker-hub/repos/manage/trusted-content/dsos-program/)).
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
- **OIDC** is a short-lived login that a GitHub Actions workflow exchanges for a
  temporary credential, so no password or token is stored in the repository
  ([GitHub's explanation](https://docs.github.com/en/actions/security-for-github-actions/security-hardening-your-deployments/about-security-hardening-with-openid-connect),
  [Docker's OIDC connections](https://docs.docker.com/security/authentication/oidc-connections/create-manage/)).
- **Provenance** is a signed statement of which workflow built an image
  ([Docker's provenance attestations](https://docs.docker.com/build/metadata/attestations/slsa-provenance/)).
  An **SBOM** (software bill of materials) lists what is inside it
  ([Docker's SBOM attestations](https://docs.docker.com/build/metadata/attestations/sbom/)).
  Both travel with the image as attachments called attestations.
- **Docker Scout** is Docker's image checker for known vulnerabilities
  ([Docker Scout](https://docs.docker.com/scout/); this repository's
  [Scout runbook](../runbooks/docker-scout.md)).
- A **ruleset** is a repository's merge rules
  ([GitHub's rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets)).
  **Dependabot** opens pull requests for outdated dependencies
  ([options](https://docs.github.com/en/code-security/dependabot/working-with-dependabot/dependabot-options-reference)),
  **CodeQL** is GitHub's code scanner
  ([CodeQL](https://docs.github.com/en/code-security/code-scanning/introduction-to-code-scanning/about-code-scanning-with-codeql)),
  and **dependency review** blocks a pull request that adds a known-bad
  dependency
  ([dependency review](https://docs.github.com/en/code-security/supply-chain-security/understanding-your-software-supply-chain/about-dependency-review)).

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

Docker's wording of the four rules:

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
writing when you apply, keep the reply, and put its date and summary in the
dossier (the "Docker's reply" field in section 4). What to do with a plan
afterwards is an owner decision, recorded in the dossier and not on this page.

**Two more things to ask.** First, Docker's fourth rule says "through
services". Keep paid support, consulting and training out of the product's
README, documentation and image descriptions (rule OSS-8 below). Whether HCW's
separate teaching work counts as a pathway is Docker's decision, so ask it in
the same message. Second, Docker's first rule talks about "the project
namespace", which is the whole Docker organisation and not one image. A new
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
    not exist fails the second call with `404 (Not Found)`, because a call that is
    not signed in cannot see it. That also means this check cannot find a private
    repository you did not name: compare the count the next command prints with
    the count on the organisation's repository list on
    [Docker Hub](https://hub.docker.com/orgs/hybridcloudworks/repositories)
    (signed in). They must be equal.

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
    `Copyright 2026 Hybrid Cloud Works` in `NOTICE` is enough. The year is the
    year of the repository's first commit. This rule says who the holder is; it
    is not legal advice.

    ```powershell
    'LICENSE','NOTICE' | ForEach-Object { $f = $_; gh api "repos/$repo/contents/$f" -H 'Accept: application/vnd.github.raw+json' | Select-String -Pattern 'Copyright (19|20)[0-9]{2} (Saul Patino|Hybrid Cloud Works)' | ForEach-Object { "$f -> $($_.Line)" } }
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
    The Scout check is a step in the publishing workflow: open the workflow file
    in `.github/workflows/`, find the step that runs `docker/scout-action`, and
    open the latest run to confirm that step succeeded. Save the run's link as the
    evidence.

- [ ] **OSS-7 The image repository is named
    `img-<code>-<lab-addon|appliance-app>`.** `<code>` is the product's two-letter
    code (`mo`, `ca`, `ne`, `cc`, and any later one), `lab-addon` is the free
    upload-only build the website frames, and `appliance-app` is the upstream app
    image. This is the same convention as [IMG-1](hcw-field-application-standard.md#211-container-images)
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
    "edition".** In `README.md`, `CLAUDE.md` and the documentation. Those words
    make a reader (and a Docker reviewer) think of a paid product. Say "user" for
    the people, and say what a free build is ("the lab build") instead of
    "edition". Technical terms that happen to contain a word are fine
    (`APP_CLIENT_ID`, "client secret"): the rule is about people and prices.

    ```powershell
    'README.md','CLAUDE.md' | ForEach-Object { $f = $_; gh api "repos/$repo/contents/$f" -H 'Accept: application/vnd.github.raw+json' | Select-String -Pattern 'customer|client|pricing|edition' | ForEach-Object { "$f line $($_.LineNumber)" } }
    ```

    You should see nothing. Each line printed names a file and a line number to
    read, and either change or record as a technical term. A product with a
    `docs/` folder runs the same search over it.

- [ ] **OSS-10 The product is in active development.** Docker's rule 3: an image
    pushed in the last six months. The date of the newest tag is the proof.

    ```powershell
    (Invoke-RestMethod "https://hub.docker.com/v2/repositories/$image/tags?page_size=3").results | Select-Object name, last_updated | Format-Table
    ```

    You should see up to three tags and their push dates, the newest first. Every
    date older than six months fails the rule.

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
    list, form files ending in `.yml` in the second, and `true` last.

- [ ] **OSS-12 The rulesets "Protect main" and "Protect release tags" are
    active.** The field standard's rule is [PRO-1](hcw-field-application-standard.md#25-branch-and-tag-protection).

    ```powershell
    gh api repos/$repo/rulesets | ConvertFrom-Json | Select-Object name, enforcement, target | Format-Table
    ```

    You should see two rows, `Protect main` (target `branch`) and
    `Protect release tags` (target `tag`), both with enforcement `active`.

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
    prints `not-configured` for the second line; then open the repository's
    Security tab, Code scanning, and confirm a recent CodeQL run. The dependency
    review job is found by reading the workflow file for
    `actions/dependency-review-action`.

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
  OSS-9  wording (user, not customer or client):  <link> <date> <status>
  OSS-10 active development:                      <link> <date> <status>
  OSS-11 community files and issue forms:         <link> <date> <status>
  OSS-12 rulesets:                                <link> <date> <status>
  OSS-13 Dependabot, CodeQL, dependency review:   <link> <date> <status>

Open gaps (rule, what is missing, who closes it, ticket):
  <rule> <gap> <person> <link>

DSOS application:
  Status:                 <not submitted | submitted | approved | refused | renewed>
  Date:                   <YYYY-MM-DD>
  Docker's reply:         <date, one-line summary, link to where the reply is kept>
  Answer to the paid-plan question: <Docker's answer, or "not asked yet">
  Renewal date:           <one year after approval, YYYY-MM-DD>
```

## 5. Worked example: Network Eyes

Network Eyes is the first product written up. All values were read on
2026-10-25 (times in UTC) from the repository's default branch, Docker Hub and
the registry. Re-read before relying on any of them: the repository changes
every day.

| Field | Value |
| --- | --- |
| Product name | Network Eyes (the repositories and images write it `NetworkEyes`) |
| Short code | `ne` |
| Source repositories | [HCW-NetworkEyes_App](https://github.com/saulpatinojr/HCW-NetworkEyes_App) (Apache-2.0), [HCW-NetworkEyes_AddOn](https://github.com/saulpatinojr/HCW-NetworkEyes_AddOn) (MIT) |
| Docker organisation | [hybridcloudworks](https://hub.docker.com/u/hybridcloudworks) |
| Image repositories | [img-ne-appliance-app](https://hub.docker.com/r/hybridcloudworks/img-ne-appliance-app), [img-ne-lab-addon](https://hub.docker.com/r/hybridcloudworks/img-ne-lab-addon) |
| Licence | Apache-2.0 for the app and its image, MIT for the add-on repository |
| Copyright holder | Hybrid Cloud Works (owner rule). Not yet written into `LICENSE` or `NOTICE` on `main`; see OSS-4 below |
| One-sentence goal | Point it at an Azure or AWS environment and it checks the network against security and migration-readiness rules and writes a report. |
| Who benefits | Cloud and network engineers who follow Hybrid Cloud Works, and students learning how a network assessment works. |
| First image published | 2026-10-25 (Docker Hub lists both repositories as created that day) |
| Related ticket | [#678](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/678) |
| DSOS application | Not submitted. The answers are prepared in the owner's private notes. |
| Docker's reply | None yet. |
| Renewal date | None yet (it starts one year after approval). |

Status of each rule on 2026-10-25:

| Rule | Status | Evidence |
| --- | --- | --- |
| OSS-1 | Met, one part not checked | The repository reports `private: false`; both image repositories answer a signed-out call. Nine repositories are listed to a signed-out visitor under `hybridcloudworks`. Whether the organisation also holds a private one was not checked (a signed-out call cannot see it). |
| OSS-2 | Met | GitHub reports `Apache-2.0`; `LICENSE` is the Apache License 2.0 text, which is on the [OSI list](https://opensource.org/license/apache-2-0). |
| OSS-3 | Met for the app, **not met for the add-on image** | App: the root [`Dockerfile`](https://github.com/saulpatinojr/HCW-NetworkEyes_App/blob/main/Dockerfile) label, [`NOTICE`](https://github.com/saulpatinojr/HCW-NetworkEyes_App/blob/main/NOTICE) and the README's Licence section all say `Apache-2.0`, and the registry shows `Apache-2.0` on the tags `latest`, `web-latest`, `api-latest`, `worker-latest` and `migrator-latest`. The add-on's tags `0.1.0` and `v0.1.1-rc.1` carry no licence label although its repository is MIT. |
| OSS-4 | **Not met on `main`** | `LICENSE` still carries the Apache text's unfilled `Copyright [yyyy] [name of copyright owner]` line and `NOTICE` has no copyright line. The open [pull request #316](https://github.com/saulpatinojr/HCW-NetworkEyes_App/pull/316) adds `Copyright 2026 Hybrid Cloud Works`; it was not merged when this was read. The add-on's `LICENSE` already names Hybrid Cloud Works. |
| OSS-5 | Part: publishing is OIDC, stored Docker secrets remain | The [publishing workflow](https://github.com/saulpatinojr/HCW-NetworkEyes_App/blob/main/.github/workflows/200-build-images.yml) logs in to Docker Hub through OIDC. The separate clean-up workflow [`370-registry-cleanup.yml`](https://github.com/saulpatinojr/HCW-NetworkEyes_App/blob/main/.github/workflows/370-registry-cleanup.yml) still reads the stored secret `DOCKERHUB_PERSONAL_TOKEN`; the field standard tracks it as G-11. The repository's secret list (names only) also holds `DOCKERHUB_TOKEN`, which no workflow in `.github/workflows` references; whether it is still needed is an owner question. |
| OSS-6 | Met | Both `latest` (app) and `0.1.0` (add-on) carry an SPDX SBOM and SLSA provenance attestation. Docker Scout steps ran and succeeded in [run 40245507222](https://github.com/saulpatinojr/HCW-NetworkEyes_App/actions/runs/40245507222) of the publishing workflow (2026-10-25). |
| OSS-7 | Met | `img-ne-appliance-app` and `img-ne-lab-addon`. The organisation also holds `hcw-lab` and `hcw-lab-runner`, older names for the website's lab images, which do not follow the convention. |
| OSS-8 | Owner statement | Owner statement, 2026-10-25: a free tool for followers of Hybrid Cloud Works, shared through GitHub, with no paid edition. A repository search for payment code is not proof and was not relied on. |
| OSS-9 | **Not met on `main`** | `README.md` says "client" on lines 12, 28 and 74 and "edition" on lines 9, 13 and 22; `CLAUDE.md` says "Customers" on line 14 and "edition" on lines 20, 22, 29 and 179. The other hits (`APP_CLIENT_ID`, "client secret") are technical terms. [Pull request #316](https://github.com/saulpatinojr/HCW-NetworkEyes_App/pull/316) rewrites the README and `CLAUDE.md` wording; open when read. |
| OSS-10 | Met | Newest tag pushed 2026-10-25 23:42 UTC (`img-ne-appliance-app`); the repository was last pushed 2026-10-26 04:01 UTC. |
| OSS-11 | Met | `SECURITY.md`, `CONTRIBUTING.md` and `CODE_OF_CONDUCT.md` in [`.github/`](https://github.com/saulpatinojr/HCW-NetworkEyes_App/tree/main/.github); forms `bug_report.yml`, `feature_request.yml`, `work_item.yml` and `config.yml`; private vulnerability reporting is `true`. |
| OSS-12 | Met, one difference | Both rulesets are `active`. "Protect main" has the rules `deletion`, `non_fast_forward`, `pull_request` and `required_status_checks` (11 checks). "Protect release tags" protects `refs/tags/v*` but lists the repository-administrator role as a bypass actor (`always`), the same in all four App repositories; the field standard's PRO-1 says "no bypass". Left for the owner to reconcile. |
| OSS-13 | Met | `dependabot.yml` covers `uv`, `github-actions`, `docker` and `npm`; CodeQL default setup is `configured` for `actions`, `javascript-typescript` and `python`; the job `Dependency Review` is in workflow `300-test-codebase.yml` and is a required check. (The field standard's gap G-16, CodeQL scanning only `actions`, was true when it was written and is no longer.) |

What the example shows: a product can have every rule met for its main image and
still fail on its second image or on the words in its README. Fill the dossier
honestly and let the gap column drive the next pull request.

Not assessed for the add-on repository `HCW-NetworkEyes_AddOn`: everything
except its licence, its copyright line and the label on its image. Run the
checklist on it as its own pair of names.

## 6. When a product stops being eligible

A product stops being eligible the moment it gets a paid edition or features
only paying users can have. Docker's rule 4 looks at a "pathway to
commercialization", and the namespace is shared: one product that fails the rule
puts every other image in the same Docker organisation at risk. So move that
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
  documentation build and the two documentation scans that run on every pull
  request.

## 8. How this was checked, and what was not

Read on 2026-10-25: Docker's two pages (raw HTML, to confirm the quoted words),
the Network Eyes repository through the GitHub API (licence, files, rulesets,
code scanning setting, workflows, secret names, a recent run), Docker Hub's
public API (repositories and tags), and the registry (image labels and
attestations). Every command in section 3 was run against Network Eyes and
printed what the page says it should. The other documentation links were opened
and their titles read.

Not checked:

- The Docker application form (its fields, and whether it has a free-text box).
- Whether the Docker organisation holds private repositories (a signed-out call
  cannot see them).
- Anything about the other three App repositories beyond the bypass setting on
  their tag rulesets.
- How Docker will treat any of this: the programme's decision is Docker's.
