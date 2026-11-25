# Landing Zone Builder: AWS and Google Cloud module pins

**Audience:** whoever is told the weekly pin check failed, or moves an AWS or
Google Cloud module pin in the Landing Zone Builder.
**Workflow:**
[`check-cloud-module-pins.yml`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/.github/workflows/check-cloud-module-pins.yml),
Wednesdays 07:43 UTC.
**History:** [#1869](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1869),
which grew out of [#1862](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1862).

## What it checks, and why

The Landing Zone Builder hands out Terraform that uses ready-made modules from
the [Terraform Registry](https://registry.terraform.io/) (a public library of
Terraform modules). Each module is "pinned": the Terraform names one exact
release, such as `terraform-aws-modules/vpc/aws` release `5.19.0`. The pins
live in two files:

- [`frontend/src/lib/landingZone/hcl/aws/moduleVersions.js`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/frontend/src/lib/landingZone/hcl/aws/moduleVersions.js)
  (`AWS_MODULES`)
- [`frontend/src/lib/landingZone/hcl/gcp/moduleVersions.js`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/frontend/src/lib/landingZone/hcl/gcp/moduleVersions.js)
  (`GCP_MODULES`)

In [#1862](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1862)
one pin named a release that was never published, so `terraform init` failed
for everyone who downloaded the AWS pack. The tests that run on every pull
request cannot catch that, because they do not call the registry. This
workflow does, once a week, and also on any pull request that changes one of
the two files.

For each pin, the script
([`frontend/scripts/check-cloud-module-pins.mjs`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/frontend/scripts/check-cloud-module-pins.mjs))
asks the registry for the module's list of releases
([the registry's API](https://developer.hashicorp.com/terraform/registry/api-docs#list-available-versions-for-a-specific-module)):

| What it finds | What the run does |
| --- | --- |
| The pinned release is in the list | Passes that pin. |
| The pinned release is **not** in the list | **Fails**, naming the module, the pin and the newest release. |
| A newer release exists | Passes, with a warning in the run summary. It reads that release's `versions.tf` (the file where a module says which Terraform and provider versions it needs) and says where it differs from the `requires` recorded beside the pin. |
| The registry or GitHub cannot be reached, times out or answers something it cannot read | **Fails** as "could not finish". It never reports a pin it did not check as fine. |

A scheduled or manual run that fails opens one issue, labelled `terraform`,
titled "Landing Zone Builder: an AWS or Google Cloud module pin needs
attention", or comments on it if it is already open. The next green run of
`main` closes it. Pull request runs never touch the issue.

The Azure pins are not in this check. They have their own weekly workflow,
[`update-avm-versions.yml`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/.github/workflows/update-avm-versions.yml),
which also opens the pull request that moves them.

## Run it by hand

Bash, from the repository's `frontend/` folder. It needs no secret and no
`npm install`:

```bash
node scripts/check-cloud-module-pins.mjs
```

Each pin prints one line starting `OK`, `WARN`, `FAIL` or `ERROR`. The exit code
is 0 when every pin is published, 1 when one is not, and 2 when the check could
not finish. To run the workflow itself, open
[the workflow's page](https://github.com/saulpatinojr/HCW-HybridCloudWorks/actions/workflows/check-cloud-module-pins.yml)
and choose **Run workflow**.

## When it fails

A `FAIL` line means the Terraform the builder hands out cannot be initialised.

1. Open the failed run from the issue and read the **FAIL** line. It names the
   pin (for example `AWS networkFirewall`), the release it asks for and the
   newest release the registry lists.
2. Pick the release to move to. The newest is not always right: a newer major
   release can need a newer provider than the pack pins. The comment at the top
   of the `moduleVersions.js` file explains how each current pin was chosen.
3. In that file, change the pin's version, and copy what that release's
   `versions.tf` asks for into its `requires` (its own file and those of the
   submodules it calls), with `readAt` set to the same version. The module's
   page on the registry links its GitHub repository; open the release's tag
   there (`v` and the version, such as `v1.0.2`) and read `versions.tf`.
4. Bash, from `frontend/`, run the offline tests, which check that the
   recorded `requires` fit the pack's own provider pins:

   ```bash
   npx vitest run src/lib/landingZone
   ```

   If the snapshot tests fail only because the version changed, refresh them
   with `npx vitest run src/lib/landingZone -u` and read the diff.
5. Run the check by hand (above). Every line should start `OK` or `WARN`, and
   the exit code should be 0.
6. Open a pull request. This workflow runs on it too. Once it merges, the next
   Wednesday run (or a manual run of `main`) closes the issue.

## When it cannot finish

An `ERROR` line names the address that could not be read and why: no answer
within 20 seconds, an HTTP error, or an answer that is not what the registry
documents. Each request is tried twice before it counts as failed.

1. Run the workflow again from
   [its page](https://github.com/saulpatinojr/HCW-HybridCloudWorks/actions/workflows/check-cloud-module-pins.yml).
   Most of these are a short outage.
2. If it fails again, open the address from the `ERROR` line in a browser. If
   the registry is down, check
   [HashiCorp's status page](https://status.hashicorp.com/) and wait.
3. If the address answers in the browser but not in the run, the registry may
   have changed the shape of its answer. The reading is in
   [`frontend/scripts/cloud-module-pins.mjs`](https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/frontend/scripts/cloud-module-pins.mjs),
   tested by `check-cloud-module-pins.test.js` beside it.

## The warnings

A `WARN` line is not a failure. It says a newer release exists and, where its
`versions.tf` asks for something different, what. The recorded `requires` can
be tighter than any one file because it also counts the submodules a release
calls, so a difference is a reason to read the release, not proof the pin is
wrong. Moving a pin is a separate change, made when it is worth it.
