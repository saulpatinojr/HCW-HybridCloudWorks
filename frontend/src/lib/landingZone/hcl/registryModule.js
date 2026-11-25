/**
 * A pinned Terraform registry module. Its `name` is its registry source.
 *
 * `requires` is what the release at `version` asks of Terraform and its
 * providers, copied by hand from its versions.tf files (its own and those of
 * the submodules it calls): `{ terraform: '<constraint>', providers: {
 * <name>: '<constraint>' }, readAt: '<version>' }`. `readAt` names the
 * release they were read from, and a test fails when it differs from
 * `version`, so bumping a pin forces a fresh read of its versions.tf.
 * cloudModuleVersions.test.js checks the pack's own
 * pins against it, so a bump that needs a newer provider fails a test
 * instead of `terraform init` (#1862, #1863).
 *
 * This file imports nothing, and the two moduleVersions.js files import it
 * with its `.js` ending, so plain Node can load the pins without the build
 * tool. The weekly check that every pin is a published release
 * (frontend/scripts/check-cloud-module-pins.mjs, #1869) relies on that.
 */
export const registryModule = (source, version, summary, requires) =>
  Object.freeze({
    name: source,
    source,
    version,
    summary,
    requires: Object.freeze({
      terraform: requires.terraform,
      readAt: requires.readAt,
      providers: Object.freeze({ ...requires.providers }),
    }),
  });
