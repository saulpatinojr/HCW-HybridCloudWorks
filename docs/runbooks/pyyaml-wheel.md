# PyYAML wheel for the lab host — built here, attested, attached to a release

> **Status: written 2026-11-02 under
> [#1505](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1505);
> no run has published a wheel yet.** The workflow runs for the first time
> when the pull request that adds the `PYYAML_*` lines to
> `lab-image/versions.env` and the `pyyaml-wheel` stage to
> `lab-image/Dockerfile` merges. Until then there is no release to verify,
> and the commands below have not been run against a published asset.
>
> **This whole page is temporary.** It goes, with the workflow, its test
> and the `PYYAML_*` lines, the day PyYAML publishes a wheel for the Python
> the lab image runs on. The weekly pin bot reports when that day comes.

ansible-core imports PyYAML (a Python library that reads YAML files). The lab
image and the lab host both install Python packages the same strict way: as
wheels (ready-built packages) whose SHA256 is written down beforehand, never
built from source on the spot. PyYAML publishes no wheel for the newest
CPython line, and only a new PyYAML release can add one
([yaml/pyyaml#951](https://github.com/yaml/pyyaml/issues/951)). So the lab
image builds the wheel itself, from PyYAML's source archive, checked against
the archive's SHA256 from PyPI (`PYYAML_SDIST_SHA256` in `versions.env`).
That works in the image, where a compiler is allowed in the build-only
stage. The host (`lab-host/bootstrap.sh`) is not allowed to build from
source (its rule LAB-13), so it needs the finished wheel as a file it can
download, hash and check the origin of.

That is what
[`publish-pyyaml-wheel.yml`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/.github/workflows/publish-pyyaml-wheel.yml)
does: it takes the one file out of the image build, attests it (a signed
statement from GitHub saying which workflow, at which commit, built this
exact file), and attaches both to a GitHub release of this repository. The
host then installs the wheel from the release URL by hash, beside the wheels
it takes from PyPI.

## What the workflow does

It runs on a push to `main` that changes `lab-image/versions.env`,
`lab-image/Dockerfile` or the workflow itself, by hand from the Actions tab
(**Run workflow** on
[its page](https://github.com/saulpatinojr/HCW-HybridCloudWorks/actions/workflows/publish-pyyaml-wheel.yml)),
and on a pull request that changes the same files. It takes no inputs: the
pins in `versions.env` are the inputs.

1. **`plan`** reads `PYYAML_VERSION`, `PYYAML_SDIST_SHA256` and
   `BASE_PYTHON_VERSION` from `versions.env`, names the release tag and the
   wheel, and asks GitHub whether that tag already carries the wheel. On a
   pull request this is the whole run: it builds nothing, publishes nothing,
   and its summary says what a push would publish. (The image build itself,
   wheel stage included, is proven by `publish-lab-image.yml` on the same
   pull request.)
2. **`build`** (push or manual run only) builds the `pyyaml-wheel` stage of
   `lab-image/Dockerfile` to a folder, checks that exactly the expected file
   came out, and records its SHA256.
3. **`publish`** (push to `main` or a manual run from `main` only) attests
   the file with
   [`actions/attest-build-provenance`](https://github.com/actions/attest-build-provenance)
   and creates the release with the wheel and the attestation bundle, or
   uploads them into a release that exists without them. It writes the
   release with a one-hour token from the same GitHub App the pin pull
   requests use, asked for `contents: write` and nothing else, and revokes it
   at the end. The job's own token stays read-only. The reason is in the
   workflow's header comment: no workflow in this repository holds a
   `contents: write` grant, and
   [`scripts/workflow-write-permissions.test.mjs`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/scripts/workflow-write-permissions.test.mjs)
   fails if one appears.

The run's summary (the **Summary** page of the run) ends with the three
lines the host side needs: the asset URL, `sha256:<hex>` and the bundle URL.

### The tag and the files

One wheel serves one Python line, so the tag names both the PyYAML release
and the CPython ABI (the `cp314` in a wheel's name, meaning CPython 3.14):

| What | Value today |
| --- | --- |
| Tag | `pyyaml-6.0.3-cp314` |
| Release | <https://github.com/saulpatinojr/HCW-HybridCloudWorks/releases/tag/pyyaml-6.0.3-cp314> |
| Wheel | <https://github.com/saulpatinojr/HCW-HybridCloudWorks/releases/download/pyyaml-6.0.3-cp314/pyyaml-6.0.3-cp314-cp314-linux_x86_64.whl> |
| Attestation bundle | <https://github.com/saulpatinojr/HCW-HybridCloudWorks/releases/download/pyyaml-6.0.3-cp314/pyyaml-6.0.3-cp314-cp314-linux_x86_64.whl.sigstore.json> |

When the base moves to Python 3.15
([#1468](https://github.com/saulpatinojr/HCW-HybridCloudWorks/pull/1468)),
the same pins name `pyyaml-6.0.3-cp315`, a second release beside the first,
and nothing on the first changes. The release is never marked as the
repository's "latest release", and its notes say it is not a release of this
project.

The release notes carry two machine-readable lines, `source-sha256:` (the
source archive) and `wheel-sha256:` (the wheel), which the next run reads
back.

### Idempotent, and never a replacement

A wheel build is not byte-for-byte repeatable (the archive inside carries
timestamps), so building the same pins twice gives two different files. The
rule is therefore: **the first wheel published for a tag is the wheel for
that tag.**

- Tag exists with both files on it, the wheel and its `.sigstore.json`
  bundle (every re-run, and every unrelated push to
  `lab-image/Dockerfile`): nothing is built or published. `plan` downloads
  both, checks the wheel's SHA256 against the release notes, and verifies
  the wheel **with that downloaded bundle** (`gh attestation verify
  --bundle`, requiring the exact signer identity
  `https://github.com/saulpatinojr/HCW-HybridCloudWorks/.github/workflows/publish-pyyaml-wheel.yml@refs/heads/main`),
  which is the pair the host checks. The copy of the attestation in
  GitHub's API is not what is verified, because that copy could be fine
  while the file on the release is stale or wrong. Then it writes the URL
  and SHA256 to the summary under "Already published, nothing changed".
  "Published" means both files: a release with the wheel and no bundle is
  not done, because the host would download the wheel and have nothing to
  verify it with.
- Tag exists but its notes name a different source archive than
  `versions.env`: the run fails. A tag is never reused for different
  source; a new PyYAML release gets a new `PYYAML_VERSION` and so a new
  tag.
- The published wheel's SHA256 or attestation does not check out: the run
  fails and says the asset is not the one the workflow published. Nothing
  is replaced; find out what changed it.
- Tag exists with the wheel but not the bundle (a run that stopped between
  the two uploads): nothing is rebuilt, because a rebuilt wheel would be a
  different file and the wheel already on the release is the wheel for
  that tag. The `build` job is skipped and `publish` repairs the release:
  it downloads the existing wheel, fetches that wheel's own attestation
  from GitHub's API (`gh attestation download`, which writes one Sigstore
  bundle per line of a `.jsonl` file; the first line is the same bundle
  object the attest action writes), verifies the wheel with it the same
  way, uploads it as the bundle, and rewrites the release notes so the
  `wheel-sha256:` line names the wheel that is on the release.
- Tag exists with the bundle but not the wheel: the run **fails closed**,
  in `plan` and again in `publish`, because a new wheel would not be the
  file that bundle attests and the host checks the pair offline. This is
  the one case left for a person; "When it fails" below says what to do.
- Tag exists with neither file: the wheel is built and both files are
  uploaded, and the notes are rewritten.
- A failure while the release is being created leaves a **draft**, not a
  release without the wheel: `gh release create` with files makes a draft
  release first, uploads the files, then publishes it. A draft has no tag,
  so the next run sees nothing there and would make a second draft. Delete
  the draft by hand on the releases page
  (<https://github.com/saulpatinojr/HCW-HybridCloudWorks/releases>, the
  draft is marked **Draft**, **Delete** is in its edit page), then re-run.
- `publish` looks again right before uploading. A wheel that appeared in
  the meantime is compared by SHA256 with the one just built; the same
  bytes are a no-op and different bytes fail the run. `gh release upload`
  is never run with `--clobber` (the flag that overwrites an asset).

## Verifying the asset by hand

PowerShell, from any folder; `gh` is the GitHub CLI, already signed in on
the owner's workstation. Each line is complete as written.

1. Download the wheel into a scratch folder:

   ```powershell
   New-Item -ItemType Directory -Force "$env:TEMP\pyyaml-wheel" | Out-Null
   ```

   ```powershell
   gh release download pyyaml-6.0.3-cp314 --repo saulpatinojr/HCW-HybridCloudWorks --pattern pyyaml-6.0.3-cp314-cp314-linux_x86_64.whl --dir "$env:TEMP\pyyaml-wheel"
   ```

   ```powershell
   gh release download pyyaml-6.0.3-cp314 --repo saulpatinojr/HCW-HybridCloudWorks --pattern pyyaml-6.0.3-cp314-cp314-linux_x86_64.whl.sigstore.json --dir "$env:TEMP\pyyaml-wheel"
   ```

   You should see no output and both files in the folder. `release not found`
   means no run has published that tag yet: open
   [the workflow's runs](https://github.com/saulpatinojr/HCW-HybridCloudWorks/actions/workflows/publish-pyyaml-wheel.yml)
   and read the latest summary.

2. Its SHA256, to compare with the run summary, the release notes'
   `wheel-sha256:` line and the hash `versions.env` pins for the host:

   ```powershell
   Get-FileHash "$env:TEMP\pyyaml-wheel\pyyaml-6.0.3-cp314-cp314-linux_x86_64.whl" -Algorithm SHA256
   ```

   The `Hash` column, lower-cased, is the value. A different value means the
   file on the release is not the file the run hashed; stop and read the
   release's history on its page before anything else.

3. Its provenance, checked with the bundle that is on the release (the
   pair the host checks), requiring the exact signer identity:

   ```powershell
   gh attestation verify "$env:TEMP\pyyaml-wheel\pyyaml-6.0.3-cp314-cp314-linux_x86_64.whl" --repo saulpatinojr/HCW-HybridCloudWorks --bundle "$env:TEMP\pyyaml-wheel\pyyaml-6.0.3-cp314-cp314-linux_x86_64.whl.sigstore.json" --cert-identity https://github.com/saulpatinojr/HCW-HybridCloudWorks/.github/workflows/publish-pyyaml-wheel.yml@refs/heads/main
   ```

   Success prints `Verification succeeded!` (or `✓ Verification succeeded!`)
   and names `.github/workflows/publish-pyyaml-wheel.yml` as the signer
   workflow. A failure naming the issuer or the identity means the bundle
   on the release does not attest this wheel, or was made by another
   workflow. `--bundle` makes `gh` read that file instead of the copy of
   the attestation in GitHub's API; `--cert-identity` compares the whole
   identity, so a workflow whose path merely starts the same way cannot
   pass (`--signer-workflow` matched a prefix in `gh` before 2.102.0,
   [GHSA-wjmr-j3rp-mh2g](https://github.com/cli/cli/security/advisories/GHSA-wjmr-j3rp-mh2g)).
   GitHub documents the command on
   [Verifying attestations offline](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/verify-attestations-offline)
   and the surrounding pages. Checked on 2026-11-02 against the lab image's
   own attestation: the same command verified it with its downloaded
   bundle and the lab image workflow's identity, and failed with this
   workflow's identity, as it should.

Offline, with the bundle and no API call, the way the host already checks
the add-on images (`lab-host/ansible/roles/addons/tasks/main.yml`). **This
is bash on the lab host, not PowerShell**, with cosign at the version
`group_vars/all.yml` pins and both files downloaded to the current folder:

```bash
cosign verify-blob-attestation --type slsaprovenance1 --bundle pyyaml-6.0.3-cp314-cp314-linux_x86_64.whl.sigstore.json --certificate-oidc-issuer https://token.actions.githubusercontent.com --certificate-identity-regexp '^https://github\.com/saulpatinojr/HCW-HybridCloudWorks/\.github/workflows/publish-pyyaml-wheel\.yml@refs/heads/main$' pyyaml-6.0.3-cp314-cp314-linux_x86_64.whl
```

The identity is the workflow's path at `refs/heads/main`: a wheel built by a
manual run from a branch is never published, so no other identity is valid.

`lab-host/bootstrap.sh` runs this same check itself on every build of its
ansible-core environment, once `PYYAML_WHEEL_SHA256` in
`lab-image/versions.env` holds the wheel's SHA256 (the workflow's step
summary prints that line): it downloads the wheel and the bundle from the
release, compares the SHA256, runs cosign, and only then lets uv install
the file, still under `--require-hashes`. While that value is empty the
host installs PyPI's wheel as before and says so in its log.

## When it fails

- **"the GitHub App that writes releases is not configured"**: nothing was
  published (on the new-wheel path the wheel was built and attested, on
  the repair path nothing was fetched yet). The `MANIFEST_APP_ID` variable
  and the `MANIFEST_APP_PRIVATE_KEY` secret are the ones the pin pull
  requests use; they live on the repository's Actions settings page
  (<https://github.com/saulpatinojr/HCW-HybridCloudWorks/settings/secrets/actions>
  for the secret, <https://github.com/saulpatinojr/HCW-HybridCloudWorks/settings/variables/actions>
  for the variable). Set them and press **Re-run jobs** on the run.
- **A 403 from `gh release create`**: the App's installation does not hold
  "Contents: Read and write". It does today (the pin pull requests push
  branches with it); the permission is on the App's installation page under
  the owner's settings, **Installed GitHub Apps**
  (<https://github.com/settings/installations>).
- **"expected the pyyaml-wheel stage to hold exactly one file named …"**:
  pip named the built file differently from what `versions.env` predicts
  (the platform tag, usually), or the stage copied more than the wheel. Fix
  the stage or the naming in the workflow's `plan` job, in one pull request,
  so the test
  ([`scripts/publish-pyyaml-wheel-workflow.test.mjs`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/scripts/publish-pyyaml-wheel-workflow.test.mjs))
  moves with it.
- **"release … was built from source archive sha256:…, but
  PYYAML_SDIST_SHA256 is …"**: the version was kept and the archive hash
  changed. PyPI does not re-issue an archive under the same version, so this
  is a typo in `versions.env` or an archive from somewhere other than PyPI.
  Check the hash on PyPI's page for the release; do not delete the release
  to get past it.
- **The release has the wheel but no `….whl.sigstore.json`** (the run
  summary or the releases page shows one asset): re-run the workflow from
  `main` (**Run workflow** on
  [its page](https://github.com/saulpatinojr/HCW-HybridCloudWorks/actions/workflows/publish-pyyaml-wheel.yml)).
  That is the repair path: `build` is skipped, `publish` downloads the
  wheel that is there, fetches its own attestation from GitHub's API with
  `gh attestation download`, verifies the pair, uploads the bundle and
  rewrites the notes. No file is uploaded by hand.
- **"… has no usable ….whl.sigstore.json"**, **"is not a Sigstore
  bundle"** or **"does not verify … as built by …"**: a file is there
  under the bundle's name but it is empty, not a bundle, or does not attest
  this wheel. The workflow never replaces an asset, so remove that one
  asset by hand first (the release's edit page,
  <https://github.com/saulpatinojr/HCW-HybridCloudWorks/releases/edit/pyyaml-6.0.3-cp314>,
  the **x** beside the file), then re-run: with the wheel alone on the
  release, the repair path above fetches the right bundle for it.
- **"release … has ….whl.sigstore.json but no ….whl"** (`plan` or
  `publish`): the wheel was removed and its bundle stayed. The workflow
  fails closed here on purpose, because a new wheel would be a different
  file from the one that bundle attests, and the host checks the pair
  offline. This is the one repair a person does: remove the bundle asset
  by hand on the same edit page, then re-run, which builds a wheel and
  publishes a fresh pair.
- **A draft release named like the tag, and runs that keep creating
  drafts**: a `gh release create` stopped between making the draft and
  publishing it. Delete the draft on
  <https://github.com/saulpatinojr/HCW-HybridCloudWorks/releases> (open
  the one marked **Draft**, its edit page has **Delete**), then re-run.

## Deleting it when PyYAML ships a wheel

When PyPI lists a `cp3NN-cp3NN-manylinux` wheel of PyYAML for the base's
Python, put that wheel's hash on the `pyyaml==` line of
`ANSIBLE_CORE_DEPS` in `lab-image/versions.env` as for any other
dependency, and in the same pull request delete everything below. This is
the only list: `versions.env` and the lab image's README point here
instead of keeping their own.

In the image (`lab-image/`):

1. `versions.env`: the whole `PYYAML` block, from the `--- PyYAML built from
   source` line to the `--- end of the PyYAML block` line (`PYYAML_VERSION`,
   `PYYAML_SDIST_SHA256`, `PYYAML_BUILD_DEPS`, `PYYAML_WHEEL_SHA256` and
   their comments).
2. `Dockerfile`, the fetch stage's apt step: `gcc`, `libc6-dev` and
   `libyaml-dev` go; `curl unzip git` stay, with the comment above them.
3. `Dockerfile`: the two `PyYAML from source` RUNs (the download RUN and the
   `--network=none` build RUN) and their comments, whole.
4. `Dockerfile`, the ansible-core RUN: restore the original download. Drop
   the `PYYAML_VERSION and the pyyaml line in ANSIBLE_CORE_DEPS name
   different releases` guard, the `| sed '/^pyyaml==/d'` pipe, the
   `requirements-pypi.txt` and `pyyaml-wheel.txt` files, the `--no-deps` on
   the download and the offline `pip install --dry-run` resolve, so the
   step is again the two `printf` lines writing
   `/out/wheels/requirements.txt`, one `pip download --only-binary=:all:
   --require-hashes --dest /out/wheels -r /out/wheels/requirements.txt`
   from it, and the wheel-count check. Reword its comment to match.
5. `Dockerfile`: the `FROM scratch AS pyyaml-wheel` stage and its comment.
6. `smoke.sh`: the `PyYAML ... with the libyaml C loader` check after the
   ansible version line.
7. `README.md`: the `PyYAML is the one exception to "wheels only"` bullet
   under "Updating a version".

In the workflows and on the host:

8. `.github/workflows/publish-lab-image.yml`: the `elif [ "$from" = scratch
   ]` arm of the FROM check, once no stage starts from `scratch`.
9. `.github/workflows/publish-pyyaml-wheel.yml`, the workflow that builds
   and attests the wheel for the host.
10. `lab-host/bootstrap.sh`: the block that reads `PYYAML_WHEEL_SHA256` and
    installs the release asset in place of the PyPI wheel, and the matching
    lines in `lab-host/README.md`.

Tests and docs:

11. `scripts/lab-image-pyyaml-wheel.test.mjs`.
12. `scripts/publish-pyyaml-wheel-workflow.test.mjs`, and the
    `PYYAML_WHEEL_SHA256` cases in
    `scripts/lab-host-bootstrap-ansible-core.test.mjs`.
13. This page and its line in `mkdocs.yml`.

The releases already made can stay as history; a host held back to an
older commit still finds its asset there.
