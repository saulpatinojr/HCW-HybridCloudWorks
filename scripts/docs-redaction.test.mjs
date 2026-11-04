import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const roots = [];
const gate = resolve(import.meta.dirname, "docs/check_redaction.py");
// A GUID that is neither a placeholder, nor a recognised synthetic shape, nor
// on the allow-list: what a pasted subscription, tenant or client id looks
// like to the gate. (It was 11111111-1111-... until the follow-up to #1540
// made a repeated-digit first group the test fixtures' recognised shape.)
const REAL_LOOKING = "3b9e1f20-7c4d-4a8e-9b61-5d2f8a7c0e13";
const PLACEHOLDER = "00000000-0000-0000-0000-000000000001";

/**
 * Build a fixture root: docs/ plus the three root documents the gate
 * requires, the optional MEMORY.md, and any extra files given as
 * `{ "relative/path": "contents" }` (parent folders are created).
 */
function check({ memory, files = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), "hcw-memory-redaction-"));
  roots.push(root);
  mkdirSync(join(root, "docs"));
  for (const name of ["README.md", "CHANGELOG.md", "TODO.md"])
    writeFileSync(join(root, name), "# Fixture\n");
  if (memory !== undefined) writeFileSync(join(root, "MEMORY.md"), memory);
  for (const [rel, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), contents);
  }
  return spawnSync("python3", ["-I", gate, root], { encoding: "utf8" });
}
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
describe("root continuation memory redaction", () => {
  it("accepts a clean handoff", () => {
    const result = check({
      memory: "# Memory\nResume from main and check recent workflow runs.\n",
    });
    expect(result.status, result.stderr).toBe(0);
  });
  it("rejects identifiers in a handoff even though it is not a docs-site page", () => {
    const result = check({ memory: `# Memory\n${REAL_LOOKING}\n` });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("MEMORY.md:2: non-placeholder GUID");
  });
  it("retains compatibility with fixture roots without a handoff", () => {
    const result = check();
    expect(result.status, result.stderr).toBe(0);
  });
});

// #1540: five role definitions under infra/roles carried a real subscription
// id for months because the gate only ever read docs/. These pin the folders
// it reads now, each with the GUID placed where it was (or would be) found.
describe("redaction outside docs/ (#1540)", () => {
  const roleJson = (scope) =>
    JSON.stringify(
      {
        Name: "HCW Fixture Role",
        IsCustom: true,
        Actions: ["Microsoft.Storage/storageAccounts/read"],
        AssignableScopes: [`/subscriptions/${scope}/resourceGroups/rg-fixture`],
      },
      null,
      2,
    );

  it("rejects a role definition whose assignable scope names a real subscription", () => {
    const result = check({
      files: { "infra/roles/fixture.json": roleJson(REAL_LOOKING) },
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("infra/roles/fixture.json:8: non-placeholder GUID");
  });

  it("accepts a role definition whose assignable scope is the placeholder", () => {
    const result = check({
      files: { "infra/roles/fixture.json": roleJson(PLACEHOLDER) },
    });
    expect(result.status, result.stdout).toBe(0);
  });

  it.each([
    ["infra/main.tf", `subscription_id = "${REAL_LOOKING}"\n`, "infra/main.tf:1"],
    ["infra/modules/x/main.tf", `# ${REAL_LOOKING}\n`, "infra/modules/x/main.tf:1"],
    ["infra/prod.tfvars", `tenant_id = "${REAL_LOOKING}"\n`, "infra/prod.tfvars:1"],
    ["infra/terraform.tfvars.example", `tenant_id = "${REAL_LOOKING}"\n`, "infra/terraform.tfvars.example:1"],
    [".github/workflows/deploy.yml", `env:\n  AZURE_CLIENT_ID: ${REAL_LOOKING}\n`, ".github/workflows/deploy.yml:2"],
    [".github/workflows/deploy.yaml", `env:\n  AZURE_CLIENT_ID: ${REAL_LOOKING}\n`, ".github/workflows/deploy.yaml:2"],
    ["scripts/bootstrap.ps1", `$SubscriptionId = '${REAL_LOOKING}'\n`, "scripts/bootstrap.ps1:1"],
    ["scripts/bootstrap.sh", `SUBSCRIPTION_ID="${REAL_LOOKING}"\n`, "scripts/bootstrap.sh:1"],
  ])("rejects a real-looking GUID in %s", (rel, contents, where) => {
    const result = check({ files: { [rel]: contents } });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(`${where}: non-placeholder GUID`);
  });

  // The follow-up to #1540: the gate read only the top level of scripts/, and
  // the cutover, rollback and lab scripts one level down carried the API's
  // real application id (and the rollback script the tenant id) as parameter
  // defaults, with their tests and two frontend tests holding the same values
  // as fixtures. These pin every folder the gate reads now, each with the id
  // where it was found or would land.
  it.each([
    ["scripts/lab/Register-Fixture.ps1", `[string] $ApiAppId = '${REAL_LOOKING}'\n`, "scripts/lab/Register-Fixture.ps1:1"],
    ["scripts/lab/Register-Fixture.Tests.ps1", `$apiAppId = '${REAL_LOOKING}'\n`, "scripts/lab/Register-Fixture.Tests.ps1:1"],
    ["scripts/rollback/restore.ps1", `[string] $TenantId = '${REAL_LOOKING}'\n`, "scripts/rollback/restore.ps1:1"],
    ["scripts/lab/helper.sh", `APP_ID="${REAL_LOOKING}"\n`, "scripts/lab/helper.sh:1"],
    ["lab-image/bootloaders/walkthrough.sh", `HostDeviceId : ${REAL_LOOKING}\n`, "lab-image/bootloaders/walkthrough.sh:1"],
    ["lab-host/ansible/group_vars/all.yml", `tenant_id: ${REAL_LOOKING}\n`, "lab-host/ansible/group_vars/all.yml:1"],
    ["lab-host/ansible/roles/x/defaults/main.yaml", `tenant_id: ${REAL_LOOKING}\n`, "lab-host/ansible/roles/x/defaults/main.yaml:1"],
    ["lab-host/bootstrap.sh", `TENANT="${REAL_LOOKING}"\n`, "lab-host/bootstrap.sh:1"],
    ["lab-host/ansible/roles/x/templates/env.j2", `CLIENT_ID=${REAL_LOOKING}\n`, "lab-host/ansible/roles/x/templates/env.j2:1"],
    ["functions/src/lib/auth/verify.js", `const TENANT = '${REAL_LOOKING}';\n`, "functions/src/lib/auth/verify.js:1"],
    ["functions/src/lib/auth/verify.test.js", `const TENANT = '${REAL_LOOKING}';\n`, "functions/src/lib/auth/verify.test.js:1"],
    ["frontend/src/lib/msalConfig.test.js", `const CLIENT = '${REAL_LOOKING}';\n`, "frontend/src/lib/msalConfig.test.js:1"],
    ["frontend/src/components/Thing.jsx", `const id = '${REAL_LOOKING}';\n`, "frontend/src/components/Thing.jsx:1"],
  ])("rejects a real-looking GUID in the nested path %s", (rel, contents, where) => {
    const result = check({ files: { [rel]: contents } });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(`${where}: non-placeholder GUID`);
  });

  it("accepts the shapes a fixture is allowed to spell an id in, without an allow-list entry", () => {
    // The placeholder; the browser tests' e2e family; and a first group of one
    // repeated hex digit, which is how the Pester and vitest fixtures spell an
    // id that names nothing.
    const result = check({
      files: {
        "scripts/lab/Fixture.Tests.ps1": [
          `$a = '${PLACEHOLDER}'`,
          "$b = 'e2e00000-0000-4000-8000-00000000c11e'",
          "$c = 'aaaaaaaa-1111-4222-8333-444444444444'",
          "$d = '99999999-5b4a-4938-8271-605f4e3d2c1b'",
          "$e = 'CCCCCCCC-0000-4000-8000-000000000A91'",
          "",
        ].join("\n"),
      },
    });
    expect(result.status, result.stdout).toBe(0);
  });

  it("does not take a repeated pair, a repeated digit anywhere but the first group, or a UUID version for a fixture", () => {
    // c0c0c0c0-... and ...-1111-... are not the convention, and a version-5
    // UUID (third group 5xxx) looks no more made up than any other: a reader
    // cannot tell them from a real id at a glance, so they get no free pass.
    // The three v5 values the tests assert are listed one by one instead
    // (CodeRabbit on #1548).
    const result = check({
      files: {
        "scripts/lab/Fixture.Tests.ps1": [
          "$a = 'c0c0c0c0-0000-4000-8000-000000000001'",
          "$b = '3b9e1f20-1111-4111-8111-111111111111'",
          "$c = '3b9e1f20-7c4d-5a8e-9b61-5d2f8a7c0e13'",
          "",
        ].join("\n"),
      },
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("scripts/lab/Fixture.Tests.ps1:1: non-placeholder GUID");
    expect(result.stdout).toContain("scripts/lab/Fixture.Tests.ps1:2: non-placeholder GUID");
    expect(result.stdout).toContain("scripts/lab/Fixture.Tests.ps1:3: non-placeholder GUID");
  });

  it("allows a UUIDv5 a test asserts only because it is on the allow-list by value", () => {
    // The markdown-draft id test's expected hash; the same shape with one
    // digit changed is a finding.
    const listed = check({
      files: { "functions/src/lib/cms/drafts-markdown.test.js": "'cf2fc369-461c-578f-bb74-4625dfe35260',\n" },
    });
    expect(listed.status, listed.stdout).toBe(0);
    const unlisted = check({
      files: { "functions/src/lib/cms/drafts-markdown.test.js": "'cf2fc369-461c-578f-bb74-4625dfe35261',\n" },
    });
    expect(unlisted.status).toBe(1);
  });

  it("allows an Azure Policy built-in definition id in the functions source, with its reason on the allow-list", () => {
    // "Azure Key Vaults should use private link", the same id in every tenant.
    const result = check({
      files: {
        "functions/src/lib/labs/estate.js": "  { definition: 'a6abeaec-4d90-4a02-805f-6b26c4d3fbe9' },\n",
      },
    });
    expect(result.status, result.stdout).toBe(0);
  });

  it("holds the operator scripts to the lookup rather than a copy of the API's client id", () => {
    // The real scripts, read as committed: no parameter default may be a GUID
    // of any shape, and each must go through the shared lookup.
    const here = import.meta.dirname;
    const operatorScripts = [
      "cutover/01-entra-api.ps1",
      "cutover/02-entra-spa-client.ps1",
      "cutover/03-entra-dev-client.ps1",
      "rollback/restore-admin-signin.ps1",
    ];
    for (const rel of operatorScripts) {
      const source = readFileSync(resolve(here, rel), "utf8");
      expect(source, rel).not.toMatch(/\$ApiAppId\s*=\s*'[0-9a-f-]{36}'/i);
      expect(source, rel).not.toMatch(/\$TenantId\s*=\s*'[0-9a-f-]{36}'/i);
      expect(source, rel).toContain("Resolve-EntraApiAppId -ApiAppId $ApiAppId -DisplayName $ApiDisplayName");
      expect(source, rel).toContain("../lib/Resolve-EntraApiAppId.ps1");
    }
    const lab = readFileSync(resolve(here, "lab", "Register-LabAgent.ps1"), "utf8");
    expect(lab).not.toMatch(/\$ApiAppId\s*=\s*'[0-9a-f-]{36}'/i);
    expect(lab).toContain("Resolve-LabApiAppId -ApiAppId $ApiAppId -DisplayName $ApiDisplayName");
    // Both lookups read the same sources in the same order, so an operator
    // learns one contract.
    for (const source of [readFileSync(resolve(here, "lib", "Resolve-EntraApiAppId.ps1"), "utf8"), lab]) {
      expect(source).toContain("$env:HCW_API_APP_ID");
      expect(source).toContain("'HCWSite API'");
      expect(source).toMatch(/'ad', 'app', 'list', '--display-name'|az ad app list --display-name \$DisplayName/);
      expect(source).toMatch(/-ceq \$DisplayName/);
    }
  });

  it("allows a Microsoft built-in role id in Terraform, with its reason on the allow-list", () => {
    // Storage Blob Data Contributor, the same id in every tenant.
    const result = check({
      files: {
        "infra/backups.tf": 'role_definition_id = "ba92f5b4-2d11-453d-a403-e96b0029c9fe"\n',
      },
    });
    expect(result.status, result.stdout).toBe(0);
  });

  it("applies only the GUID rule to code: a container path inside a workflow is not a local path", () => {
    const result = check({
      files: {
        ".github/workflows/image.yml": "run: test -f /home/agent/.claude/CLAUDE.md\n",
      },
    });
    expect(result.status, result.stdout).toBe(0);
  });

  it("runs on every pull request from repository-policy.yml, not only when a docs path changes", () => {
    // docs-pages.yml is path-filtered to docs/, so a real id pasted into
    // infra/ or a workflow would never meet the gate there. The policy
    // workflow has no path filter; the step must stay in it, unconditional.
    const workflow = readFileSync(
      resolve(import.meta.dirname, "..", ".github", "workflows", "repository-policy.yml"),
      "utf8",
    );
    expect(workflow).toMatch(/^on:\n  pull_request:\n/m);
    const step = workflow.match(
      /- name: Redaction gate over the whole tree\n((?: {8}.*\n)+)/,
    );
    expect(step, "the step is gone from repository-policy.yml").not.toBeNull();
    expect(step[1]).toContain("run: python3 -I scripts/docs/check_redaction.py");
    expect(step[1]).not.toContain("if:");
  });

  it("still applies the local-path rule to documentation", () => {
    const result = check({
      files: { "docs/page.md": "Open /home/someone/notes.md\n" },
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("docs/page.md:1: contributor-local filesystem path");
  });
});
