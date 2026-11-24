# ADR 0044: Signed releases across the estate: the site publishes none, and the four App repositories attach provenance to theirs

**Status:** Proposed (owner's question of 2026-11-23; accepted when the owner
answers on the pull request that adds this record)
**Decision date:** 2026-11-23
**Owners:** Workload owner and architecture owner

## Context

[OpenSSF Scorecard](https://github.com/ossf/scorecard) is an open-source
tool that grades a repository's security habits, one check at a time, from 0
to 10. One of its checks is **Signed-Releases**. It looks at a repository's
GitHub Releases (the download pages GitHub makes for a version tag) and asks
whether the files attached to each one come with proof of where they were
built.

Until 2026-11-23 this repository had two releases. Each held one PyYAML
wheel (a ready-built Python package) that the lab host downloaded, and each
carried a signature file ending `.sigstore.json`, which scored 8. That build
was retired the same day because PyPI now publishes the wheel
([#1778](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1778),
[the PyYAML wheel page](../runbooks/pyyaml-wheel.md)), and the two releases
were deleted. The site now has no releases and no tags. The owner asked how
to make the estate compliant again.

This record answers for all nine repositories: the site, the four add-ons
and the four Apps. Everything below was read on 2026-11-23.

### What the check really does

Read from Scorecard's source at tag `v5.7.0` (the newest release; the five
files compared equal to `main` that day):

- **Which files count as a signature.**
  [`probes/releasesAreSigned/impl.go`](https://github.com/ossf/scorecard/blob/v5.7.0/probes/releasesAreSigned/impl.go)
  has
  `var signatureExtensions = []string{".asc", ".minisig", ".sig", ".sign", ".sigstore", ".sigstore.json"}`.
- **Which files count as provenance** (a signed statement of which workflow
  run built a file).
  [`probes/releasesHaveProvenance/impl.go`](https://github.com/ossf/scorecard/blob/v5.7.0/probes/releasesHaveProvenance/impl.go)
  has `var provenanceExtensions = []string{".intoto.jsonl"}`.
- **Only the name is read.** Both probes test
  `strings.HasSuffix(asset.Name, suffix)` and nothing else, and the
  [check's documentation](https://github.com/ossf/scorecard/blob/v5.7.0/docs/checks.md#signed-releases)
  says "Note: The check does not verify the signatures." So the check is
  easy to satisfy with an empty file. That is the reason this record only
  proposes files that are real and that a person can verify.
- **How many releases.** Both probes set `releaseLookBack = 5` and stop at
  the sixth release in GitHub's list, newest first. Pre-releases are in
  that list. (The documentation also says "the 30 most recent releases",
  which is the one page of releases Scorecard fetches; only the first five
  are judged.)
- **A release with no files is skipped, not failed.** Both probes have
  `if len(release.Assets) == 0 { continue }`. If no release in the five has
  a file, each probe reports "not applicable".
- **The score.** In
  [`checks/evaluation/signed_releases.go`](https://github.com/ossf/scorecard/blob/v5.7.0/checks/evaluation/signed_releases.go)
  a release with a signature file is worth 8 and one with a provenance
  file is worth 10. The check's score is the average over the judged
  releases, rounded down
  (`score = int(math.Floor(float64(score) / float64(totalReleases)))`). If
  none of them has either, the result is 0: "Project has not signed or
  included provenance with any releases." The documentation's wording: "If
  a signature is found in the assets for each release, a score of 8 is
  given. If a SLSA provenance file is found in the assets for each release
  (*.intoto.jsonl), the maximum score of 10 is given."
- **No releases is not a failure.** With nothing to judge the check returns
  `CreateInconclusiveResult(name, "no releases found")`. An inconclusive
  check has score -1, and the overall score skips it
  ([`pkg/scorecard/scorecard_result.go`](https://github.com/ossf/scorecard/blob/v5.7.0/pkg/scorecard/scorecard_result.go):
  "This indicates an inconclusive score." followed by `continue`).
- **A third way to score 10, new in `v5.7.0` and not yet in the
  documentation.**
  [`probes/releasesAreImmutable/impl.go`](https://github.com/ossf/scorecard/blob/v5.7.0/probes/releasesAreImmutable/impl.go)
  reads GitHub's `immutable` flag on each release, and the evaluation file
  says "GitHub immutable releases include an attestation for the release,
  so they are treated the same as provenance" and gives 10. The probe is
  marked `lifecycle: experimental`, and the file does not exist at
  `v5.6.0`. An immutable release is one whose files and tag can never be
  changed after it is published
  ([GitHub Docs: Immutable releases](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases)).

One consequence matters for this estate. Several repositories already attest
their builds with `actions/attest-build-provenance`, which stores the proof
in GitHub's attestation store or in the image registry. Scorecard does not
look there. Only a file attached to the release, or the immutable flag,
counts.

### The nine repositories today

Release lists were read with `gh api "repos/saulpatinojr/<name>/releases?per_page=5"`.
"Score" is what the rules above give; Scorecard itself was not run.

| Repository | Releases, and the files on the last five | Proof that exists today | Signed-Releases today |
| --- | --- | --- | --- |
| [HCW-HybridCloudWorks](https://github.com/saulpatinojr/HCW-HybridCloudWorks/releases) | None, and no tags | Lab images: provenance pushed to Docker Hub by `publish-lab-image.yml` | Inconclusive (left out of the score) |
| [HCW-MigrateOrchestrator_AddOn](https://github.com/saulpatinojr/HCW-MigrateOrchestrator_AddOn/releases) | Six. `v0.3.2`, `v0.3.2-rc.1`, `v0.3.1`, `v0.3.0` have no files; the fifth, `v0.1.3` (2026-10-04, from before the App was split out), has three `amo-*` programs and three `SHA256SUMS-*.txt` | Image: provenance in the registry (`publish-images.yml`). Nothing on a release | **0**, because of `v0.1.3` alone |
| [HCW-NetworkEyes_AddOn](https://github.com/saulpatinojr/HCW-NetworkEyes_AddOn/releases) | Three, none with files | Image: provenance in the registry | Inconclusive |
| [HCW-CloudAssessor_AddOn](https://github.com/saulpatinojr/HCW-CloudAssessor_AddOn/releases) | Three, none with files | Image: provenance in the registry | Inconclusive |
| [HCW-CloudCrawler_AddOn](https://github.com/saulpatinojr/HCW-CloudCrawler_AddOn/releases) | Three, none with files | Image: provenance in the registry | Inconclusive |
| [HCW-MigrateOrchestrator_App](https://github.com/saulpatinojr/HCW-MigrateOrchestrator_App/releases) | Five with files: three programs, two `.tgz` packages, three checksum files and (from `v0.4.0`) two `.cdx.json` SBOMs | Provenance and SBOM attestations in GitHub's store (`release-cli.yml`, `actions/attest`), checked three times by the workflow. No file on the release | **0** |
| [HCW-NetworkEyes_App](https://github.com/saulpatinojr/HCW-NetworkEyes_App/releases) | Five `engine-v*` releases, each a wheel and a `.tar.gz` | None for the wheel (`320-release-engine.yml` has no attest step). The images are signed with cosign in the registry | **0** |
| [HCW-CloudAssessor_App](https://github.com/saulpatinojr/HCW-CloudAssessor_App/releases) | Four, each a wheel and a `.tar.gz` | Provenance in GitHub's store (`publish-core.yml`). No file on the release | **0** |
| [HCW-CloudCrawler_App](https://github.com/saulpatinojr/HCW-CloudCrawler_App/releases) | Two, each a wheel, a `.tar.gz` and a `.cdx.json` SBOM | Provenance and SBOM attestations in GitHub's store (`publish-core.yml`). No file on the release | **0** |

No release in any repository is immutable (`immutable: false` on every one).

Two things in this table are easy to misread:

- The four Apps score 0 although three of them do more checking than most
  projects. The proof exists; it is only kept where Scorecard does not look.
- Only one repository runs Scorecard at all: `scanners.yml` in
  HCW-MigrateOrchestrator_App, with `ossf/scorecard-action` v2.6.0, which
  bundles Scorecard `v5.7.0`. The
  [field application standard](../standards/hcw-field-application-standard.md)
  lists it as optional ("SEC-6, MAY ... MO only"). This repository has no
  Scorecard workflow, so where its old score of 8 was read from was not
  found.

## Purpose and decision drivers

- **A file that proves where a download came from is worth having where
  someone downloads.** The add-ons install the Apps' wheels and packages
  straight from the Apps' release pages, pinned by web address and SHA256.
  That is a real consumer, and a provenance file beside the wheel lets
  anyone check it offline.
- **Do not make a file to please a scanner.** The check reads names only.
  A release invented to hold a file nobody uses is permanent public
  surface with no reader.
- **Keyless only.** Every signature comes from the workflow run's own
  short-lived identity (OIDC, through Sigstore). No private key is stored
  anywhere, the same rule the Docker Hub and npm publishing already follow.
- **Releases and tags are permanent, and a session cannot make or delete
  them.** The owner pushes tags; a workflow creates the release.
- Well-Architected pillars: Security (supply chain) and Operational
  Excellence (no ritual without a purpose).

## Decision

Two decisions, both the owner's.

### 1. The site (this repository): three options

| Option | What it means | What it costs |
| --- | --- | --- |
| **A. Leave it** (recommended) | No releases. Signed-Releases stays inconclusive and is left out of the score. This is not a failure and nothing is hidden. | Nothing. |
| **B. Cut versioned releases of the site** | A new workflow builds something on a `v*` tag (the built frontend as an archive, with an SBOM) and attaches it with provenance. | A new workflow, its tests and a runbook; a release-writing grant that `scripts/workflow-write-permissions.test.mjs` keeps at zero today; and a tag the owner must push on a site that deploys by itself on every merge. The archive would describe a state the live site has usually already left, and nobody installs the site from an archive. |
| **C. Publish something the site already builds** | For example a small file listing the lab images' digests, with provenance, on each `publish-lab-image.yml` run. | A release several times a month, for ever. The digests already reach their only users through the pin pull request, and the lab host already checks each image's provenance in the registry with cosign. The weekly content manifest is a JSON file committed to the repository, so a release of it would be a second copy. |

**Recommendation: A.** The two deleted releases were real because the lab
host downloaded a wheel from them. That need ended, and nothing the site
builds today is fetched from a release page. Options B and C would exist for
the score alone.

If the site ever attaches a download to a release again, that workflow
attaches the provenance as `<file>.intoto.jsonl` from the first run (10),
not only as `.sigstore.json` (8, which is why the old releases scored 8).

### 2. The four App repositories: attach the proof they already make

The Apps have real releases with real users, and three of them already
attest every file. The change is to save the attestation as a file and
attach it. Recommended for all four, one pull request in each repository,
made there and not here.

`actions/attest-build-provenance` (and `actions/attest`, which it wraps)
returns the path of the proof it made as the output `bundle-path`
([`action.yml`](https://github.com/actions/attest-build-provenance/blob/4d101475d8b20a2381f78447822ac1eab6504dd8/action.yml),
[the `actions/attest` README](https://github.com/actions/attest/blob/1e69f48acb82d1966a394da916b4c1698aa569d6/README.md):
"Attestations are saved in the JSON-serialized Sigstore bundle format"). A
Sigstore bundle holds the signed provenance statement, the certificate and
the transparency-log entry. Written one bundle per line, it is the
`.intoto.jsonl` file the check names, and it verifies offline with
`gh attestation verify <file> --repo <owner>/<repo> --bundle <name>.intoto.jsonl`
(the `--bundle` flag takes "a JSON lines file with multiple bundles",
[`verify.go`](https://github.com/cli/cli/blob/trunk/pkg/cmd/attestation/verify/verify.go)).

The pins below are the ones already in these repositories.

**HCW-CloudAssessor_App**, `publish-core.yml` (the job already attests and
already uploads; three changed lines):

```yaml
      - uses: actions/attest-build-provenance@4d101475d8b20a2381f78447822ac1eab6504dd8 # v4.2.2
        id: attest
        if: startsWith(github.ref, 'refs/tags/v')
        with: { subject-path: "dist/*" }
      - name: Attach the wheel, the sdist and their provenance to the GitHub Release
        if: startsWith(github.ref, 'refs/tags/v')
        env: { GH_TOKEN: "${{ secrets.GITHUB_TOKEN }}", BUNDLE: "${{ steps.attest.outputs.bundle-path }}" }
        run: |
          set -euo pipefail
          tag="${GITHUB_REF#refs/tags/}"
          jq -c . "$BUNDLE" > "cloud_assessor_core-${tag#v}.intoto.jsonl"
          for _ in 1 2 3 4 5 6; do gh release view "$tag" >/dev/null 2>&1 && break; sleep 10; done
          gh release upload "$tag" dist/* "cloud_assessor_core-${tag#v}.intoto.jsonl" --clobber
```

**HCW-NetworkEyes_App**, `320-release-engine.yml` (no attestation today, so
one new job; `release-upload` then needs it and attaches its file):

```yaml
  attest:
    name: Attest the wheel and the sdist (keyless)
    runs-on: ubuntu-26.04
    timeout-minutes: 10
    needs: [build-test]
    permissions:
      contents: read
      id-token: write      # the signing certificate for this run's identity
      attestations: write  # store the attestation
    steps:
      - uses: actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333  # v8.0.2
        with: { name: engine-dist, path: dist/ }
      - uses: actions/attest-build-provenance@4d101475d8b20a2381f78447822ac1eab6504dd8  # v4.2.2
        id: attest
        with: { subject-path: "dist/*" }
      - name: Keep the attestation as a file for the release
        env: { BUNDLE: "${{ steps.attest.outputs.bundle-path }}" }
        run: mkdir provenance && jq -c . "$BUNDLE" > "provenance/${GITHUB_REF_NAME}.intoto.jsonl"
      - uses: actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9  # v7.0.2
        with: { name: engine-provenance, path: provenance/, if-no-files-found: error }
```

```yaml
  release-upload:
    needs: [build-test, attest]
    # ... after the existing download of engine-dist:
      - uses: actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333  # v8.0.2
        with: { name: engine-provenance, path: provenance/ }
      - name: Create the release from the tag
        env:
          GH_TOKEN: ${{ github.token }}
        run: gh release create "$GITHUB_REF_NAME" --verify-tag --notes-from-tag dist/* provenance/*.intoto.jsonl
```

The attest action's pin is HCW-CloudAssessor_App's; HCW-NetworkEyes_App
does not use the action yet.

**HCW-CloudCrawler_App**, `publish-core.yml` (the `attest` job has no write
access to the repository, so the file travels to the `release` job as a
workflow artifact):

```yaml
      # attest job: give the first (provenance) step an id, then
      - uses: actions/attest@1e69f48acb82d1966a394da916b4c1698aa569d6 # v4.2.2
        id: provenance
        with: { subject-path: "release-files/dist/*" }
      - name: Keep the provenance as a file for the release
        env: { BUNDLE: "${{ steps.provenance.outputs.bundle-path }}" }
        run: mkdir provenance && jq -c . "$BUNDLE" > provenance/cloud-crawler-core.intoto.jsonl
      - uses: actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7.0.2
        with: { name: cloud-crawler-core-provenance, path: provenance/, if-no-files-found: error }
```

The `release` job downloads that artifact, and `scripts/release-publish.py`
(which today refuses a release that holds anything but "the three expected
files") learns the fourth name, with its tests.

**HCW-MigrateOrchestrator_App**, `release-cli.yml` (the same shape as Cloud
Crawler; the first, third and fifth `actions/attest` steps are the
provenance ones):

```yaml
      # attest job: ids binaries, packages and inventory on the three provenance steps, then
      - name: Keep the provenance as one file for the release
        env:
          B1: "${{ steps.binaries.outputs.bundle-path }}"
          B2: "${{ steps.packages.outputs.bundle-path }}"
          B3: "${{ steps.inventory.outputs.bundle-path }}"
          VERSION: "${{ needs.check.outputs.version }}"
        run: mkdir provenance && jq -c . "$B1" "$B2" "$B3" > "provenance/amo-${VERSION}.intoto.jsonl"
      - uses: actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7.0.2
        with: { name: release-provenance, path: provenance/, if-no-files-found: error }
```

`expectedAssets()` in `scripts/release-publish.mjs` gains the new name, so
the draft check, the publish step and `verify-release` all expect it.

In Cloud Crawler and Migrate Orchestrator the release gains a file, which
by each App's own rule means an entry in its add-on's
`docs/whats-new-upstream.md`. The add-ons download only the wheel or the
`.tgz` by exact address, so nothing they do changes.

**The score moves slowly, and that is expected.** It is the average over
the last five releases that have files. An App shows 2 after its first
release with provenance, then 4, 6, 8, and 10 after the fifth.

**Immutable releases, as a second step.** Turning on **Enable release
immutability** (repository **Settings**, **General**, **Releases**;
[GitHub Docs](https://docs.github.com/en/code-security/how-tos/secure-your-supply-chain/establish-provenance-and-integrity/prevent-release-changes))
locks the files and the tag of every later release and makes GitHub sign a
record of it. It suits the Apps, because the add-ons pin release files by
address and hash and the Apps already treat a `v*` tag as permanent. It
also scores 10 under Scorecard `v5.7.0`. Three things to know first:

1. It applies only to releases published after it is switched on.
2. A file can no longer be added to a published release. GitHub's advice is
   to create the release as a draft, attach everything, then publish. Cloud
   Crawler and Migrate Orchestrator already do that. NetworkEyes'
   `gh release create <tag> <files>` does it by itself ("creates a draft
   release, uploads each asset, and then publishes",
   [`create.go`](https://github.com/cli/cli/blob/trunk/pkg/cmd/release/create/create.go)).
   **Cloud Assessor does not:** `release.yml` publishes an empty release
   and `publish-core.yml` uploads to it afterwards, which immutability
   would refuse. That workflow pair is reordered (draft, upload, publish)
   before the setting is switched on there.
3. A release that went out wrong can be deleted, but its tag name can never
   be used again.

Recommended, after the provenance files are in, as its own owner decision
per repository. It is not a substitute for the file: the probe that reads
it is experimental.

### 3. The four add-ons: no change

Their releases are release notes written by the owner, with no files; the
product is the image on Docker Hub, which carries its provenance in the
registry. A release with no files is skipped, so three add-ons are
inconclusive, which is accurate.

HCW-MigrateOrchestrator_AddOn scores 0 only because `v0.1.3`, the last
release from before the command-line tool moved to the App, is still fifth
in its list with six unsigned files. Its next release of any kind pushes
`v0.1.3` to sixth place, outside the five that are judged, and the check
becomes inconclusive. Nothing needs to be deleted or added.

## Consequences and accepted risks

- The site keeps no release process. A reader of a Scorecard report sees
  Signed-Releases as "inconclusive: no releases found", not as a pass.
- Each App release gains one file. It is public and permanent, like the
  attestation it is a copy of, and it contains nothing the public
  transparency log does not already hold (the repository, the workflow, the
  commit and the files' SHA256).
- The Apps show a low Signed-Releases score for their next four releases.
  Attaching the stored attestations to old releases would shorten that
  (`gh attestation download`, then `gh release upload`, by the owner); it
  is possible for the three Apps that attest, not proposed here, and not
  possible for NetworkEyes' old engine releases, which were never attested.
- The check never verifies the file. The Apps that verify their own
  attestations before publishing keep doing so; the file adds a download,
  not a new guarantee.

## Alternatives considered

- **Sign with a stored key (GPG `.asc`, minisign).** Rejected: a long-lived
  private key to store, protect and rotate, for a score of 8, against the
  estate's keyless rule.
- **`cosign sign-blob` with a `.sigstore.json` bundle.** Keyless and
  honest, but scores 8 and adds a second tool to repositories that already
  call the attest action.
- **The SLSA project's own generator workflow.** It writes `.intoto.jsonl`
  directly, but it is a second provenance system beside the one already
  attested and verified in three of the Apps.
- **Immutable releases alone, with no file.** No workflow change in three
  Apps, but it rests on an experimental probe that the check's
  documentation does not mention yet.
- **Releases for the site (options B and C above).**

## Validation and revisit triggers

- After an App's first release with the change:
  `gh api "repos/saulpatinojr/<name>/releases?per_page=1"` lists an asset
  ending `.intoto.jsonl`, and `gh attestation verify` of the downloaded
  wheel with `--bundle` on that file succeeds.
- In HCW-MigrateOrchestrator_App, the Scorecard run in `scanners.yml`
  reports Signed-Releases above 0 after the next release.
- Revisit option A when the site again publishes a file for someone to
  download from a release, or when a customer or programme asks for a
  Scorecard result that needs this check to be scored.
- Revisit the immutable step when Scorecard's documentation lists it, or
  if the probe is withdrawn.

## Related decisions and references

- [The PyYAML wheel page](../runbooks/pyyaml-wheel.md): the two releases
  this repository used to have.
- [Docker Hub publishing](../runbooks/docker-hub-publishing.md): the
  keyless sign-in and the provenance the lab images carry.
- [HCW field application standard](../standards/hcw-field-application-standard.md),
  SEC-6: Scorecard as an optional, report-only job.
- Scorecard: [Signed-Releases documentation](https://github.com/ossf/scorecard/blob/v5.7.0/docs/checks.md#signed-releases),
  [how releases are listed](https://github.com/ossf/scorecard/blob/v5.7.0/clients/githubrepo/releases.go).
- GitHub Docs: [Immutable releases](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases),
  [Preventing changes to your releases](https://docs.github.com/en/code-security/how-tos/secure-your-supply-chain/establish-provenance-and-integrity/prevent-release-changes).

### What was not checked

- Scorecard was not run against any repository; the scores are the rules
  applied by hand to the release lists.
- No release was made, so the snippets are not proven by a run. In
  particular, that `bundle-path` holds exactly one bundle when a step
  attests several files was read from the action's description, not seen.
- Whether attestations exist in GitHub's store for each of the Apps' older
  releases was not read.
- The source files were fetched from `raw.githubusercontent.com`; the
  `github.com/.../blob/...` links above are the same paths and were not
  opened in a browser.
