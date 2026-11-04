import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const roots = [];
const gate = resolve(import.meta.dirname, "docs/check_redaction.py");
// A GUID that is neither the placeholder form nor on the allow-list: what a
// pasted subscription, tenant or client id looks like to the gate.
const REAL_LOOKING = "11111111-1111-1111-1111-111111111111";
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

  it("reads only the top level of scripts/, where the operator scripts live", () => {
    // Nested test suites under scripts/ use made-up ids as fixtures; the
    // gate's scope is the scripts an operator runs, not their tests.
    const result = check({
      files: { "scripts/lab/Fixture.Tests.ps1": `$id = '${REAL_LOOKING}'\n` },
    });
    expect(result.status, result.stdout).toBe(0);
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
