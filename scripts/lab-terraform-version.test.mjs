/**
 * Every Terraform root the lab ships states the Landing Zone packs' version
 * rule (#1864).
 *
 * The packs require `>= 1.12, < 2.0`, kept in one place:
 * frontend/src/lib/landingZone/terraformVersion.js says why. Until #1864 the
 * lab's own roots each said something different (`>= 1.9`, `>= 1.9.0`,
 * `>= 1.12`) and nothing said why. They now all say the packs' rule, because
 * each is run by a Terraform that already sits inside it:
 *
 *   - lab-image/smoke/*: smoke.sh runs them with the lab image's Terraform
 *     (TERRAFORM_VERSION in lab-image/versions.env), the same one the packs
 *     run on in the lab. frontend/src/lib/landingZone/labImage.test.js already
 *     fails when that version leaves the rule.
 *   - lab-host/coder/templates/*: the Coder server runs them with the
 *     Terraform built into its own image, not the lab image's. Read on
 *     2026-11-25 for the pinned Coder (coder_image_tag v2.39.4 in
 *     lab-host/ansible/group_vars/all.yml): its TerraformVersion is 1.17.2 and
 *     it accepts a Terraform from 1.1.0 to 1.17.9
 *     (https://github.com/coder/coder/blob/v2.39.4/provisioner/terraform/install.go),
 *     and its image installs 1.17.2
 *     (https://github.com/coder/coder/blob/v2.39.4/scripts/Dockerfile.base).
 *     That is inside the rule, so the templates take it too. A future Coder
 *     that brings Terraform 2.x would be refused by `< 2.0` when the template
 *     is pushed, which is the same check the packs get: someone looks first.
 *
 * The lab catalogue's samples are held to the same rule by
 * frontend/src/data/labs/catalogue.test.js. The site's own roots (infra/,
 * infra-lab/) run on HCP Terraform and carry their own reasons beside their
 * lines; version-floors.test.mjs covers them.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { TERRAFORM_REQUIRED_VERSION } from "../frontend/src/lib/landingZone/terraformVersion.js";
import { terraformConstraintAdmits } from "./lib/version-math.mjs";

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The main.tf of every folder directly under `dir`, so a new root is checked too. */
function roots(dir) {
  const base = path.join(repo, dir);
  return readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(base, entry.name, "main.tf"))
    .filter((file) => existsSync(file))
    .map((file) => [
      path.relative(repo, file).replace(/\\/g, "/"),
      readFileSync(file, "utf8"),
    ]);
}

const SMOKE = roots("lab-image/smoke");
const TEMPLATES = roots("lab-host/coder/templates");

describe("the lab’s Terraform roots (#1864)", () => {
  it("finds both smoke roots and all three Coder templates", () => {
    expect(SMOKE.map(([file]) => file)).toEqual(
      expect.arrayContaining([
        "lab-image/smoke/providers-only/main.tf",
        "lab-image/smoke/terraform-validate-payload/main.tf",
      ]),
    );
    expect(TEMPLATES.length).toBeGreaterThanOrEqual(3);
  });

  it.each([...SMOKE, ...TEMPLATES])(
    "%s states the packs’ rule",
    (_file, text) => {
      expect(
        text
          .match(/^\s*required_version\s*=\s*"[^"]*"/gm)
          ?.map((line) => line.trim()),
      ).toEqual([`required_version = "${TERRAFORM_REQUIRED_VERSION}"`]);
    },
  );

  it.each([...SMOKE, ...TEMPLATES])(
    "%s says where the rule comes from",
    (_file, text) => {
      expect(text).toContain(
        "frontend/src/lib/landingZone/terraformVersion.js",
      );
    },
  );

  it.each(TEMPLATES)(
    "%s says Coder runs it with its own Terraform",
    (_file, text) => {
      expect(text).toMatch(
        /Coder runs this with the Terraform built into its own image/,
      );
    },
  );

  // 1.17.2 was read from Coder v2.39.4's own source on 2026-11-25. Coder is
  // pinned in group_vars, so a Coder upgrade fails here until someone reads
  // the new release's Terraform and updates both lines.
  it("admits the Terraform the pinned Coder brings (1.17.2 in v2.39.4)", () => {
    const vars = readFileSync(
      path.join(repo, "lab-host", "ansible", "group_vars", "all.yml"),
      "utf8",
    );
    expect(/^coder_image_tag:\s*(\S+)\s*$/m.exec(vars)?.[1]).toBe("v2.39.4");
    expect(
      terraformConstraintAdmits(TERRAFORM_REQUIRED_VERSION, "1.17.2"),
    ).toBe(true);
  });

  it("admits the lab image’s Terraform", () => {
    const env = readFileSync(
      path.join(repo, "lab-image", "versions.env"),
      "utf8",
    );
    const version = /^TERRAFORM_VERSION=(\S+)$/m.exec(env)?.[1];
    expect(version).toBeTruthy();
    expect(terraformConstraintAdmits(TERRAFORM_REQUIRED_VERSION, version)).toBe(
      true,
    );
  });
});
