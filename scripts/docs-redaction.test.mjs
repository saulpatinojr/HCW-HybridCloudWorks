import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const roots = [];
const gate = resolve(import.meta.dirname, "docs/check_redaction.py");
function check(memory) {
  const root = mkdtempSync(join(tmpdir(), "hcw-memory-redaction-"));
  roots.push(root);
  mkdirSync(join(root, "docs"));
  for (const name of ["README.md", "CHANGELOG.md", "TODO.md"])
    writeFileSync(join(root, name), "# Fixture\n");
  if (memory !== undefined) writeFileSync(join(root, "MEMORY.md"), memory);
  return spawnSync("python3", [gate, root], { encoding: "utf8" });
}
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
describe("root continuation memory redaction", () => {
  it("accepts a clean handoff", () => {
    const result = check(
      "# Memory\nResume from main and check recent workflow runs.\n",
    );
    expect(result.status, result.stderr).toBe(0);
  });
  it("rejects identifiers in a handoff even though it is not a docs-site page", () => {
    const result = check("# Memory\n11111111-1111-1111-1111-111111111111\n");
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("MEMORY.md:2: non-placeholder GUID");
  });
  it("retains compatibility with fixture roots without a handoff", () => {
    const result = check();
    expect(result.status, result.stderr).toBe(0);
  });
});
