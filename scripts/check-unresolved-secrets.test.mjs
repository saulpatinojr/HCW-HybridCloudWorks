import { describe, expect, it } from "vitest";
import {
  EXPECTED_UNRESOLVED,
  assertKnownShape,
  canonicalName,
  evaluate,
  formatReport,
  parseReferenceStatuses,
  unresolvedFrom,
} from "./check-unresolved-secrets.mjs";

const shapeA = (entries) => ({
  properties: { keyToReferenceStatuses: entries },
});
const shapeB = (rows) => ({ value: rows });

describe("parseReferenceStatuses", () => {
  it("reads the keyToReferenceStatuses map", () => {
    const got = parseReferenceStatuses(
      shapeA({
        "ANTHROPIC-API-KEY": { status: "Resolved" },
        "REPLICATE-API-KEY": {
          status: "SecretNotFound",
          details: "secret not found",
        },
      }),
    );
    expect(got).toEqual([
      { name: "ANTHROPIC-API-KEY", status: "Resolved", details: "" },
      {
        name: "REPLICATE-API-KEY",
        status: "SecretNotFound",
        details: "secret not found",
      },
    ]);
  });

  it("reads the value[] array", () => {
    const got = parseReferenceStatuses(
      shapeB([
        { name: "PREVIEW_SIGNING_SECRET", properties: { status: "Resolved" } },
      ]),
    );
    expect(got).toEqual([
      { name: "PREVIEW_SIGNING_SECRET", status: "Resolved", details: "" },
    ]);
  });

  it("returns null for a shape it does not recognise", () => {
    expect(parseReferenceStatuses({ somethingElse: true })).toBeNull();
  });

  it("names a missing status rather than treating it as healthy", () => {
    const [row] = parseReferenceStatuses(shapeA({ "A-KEY": {} }));
    expect(row.status).toBe("(no status reported)");
    expect(unresolvedFrom([row])).toHaveLength(1);
  });
});

describe("assertKnownShape", () => {
  it("throws on an unrecognised payload instead of reporting health", () => {
    const raw = { unexpected: 1, alsoUnexpected: 2 };
    expect(() => assertKnownShape(parseReferenceStatuses(raw), raw)).toThrow(
      /neither known Key Vault reference shape/,
    );
  });

  it("says explicitly that this is not a clean bill of health", () => {
    expect(() => assertKnownShape(null, {})).toThrow(
      /NOT "every reference is healthy"/,
    );
  });

  it("passes a recognised payload straight through", () => {
    const statuses = [{ name: "A", status: "Resolved", details: "" }];
    expect(assertKnownShape(statuses, {})).toBe(statuses);
  });
});

describe("unresolvedFrom", () => {
  it("treats Resolved as healthy regardless of case", () => {
    const statuses = [
      { name: "A", status: "Resolved", details: "" },
      { name: "B", status: "resolved", details: "" },
      { name: "C", status: "RESOLVED", details: "" },
    ];
    expect(unresolvedFrom(statuses)).toHaveLength(0);
  });

  it("flags every other status", () => {
    const statuses = [
      { name: "A", status: "Resolved", details: "" },
      { name: "B", status: "SecretNotFound", details: "" },
      { name: "C", status: "AccessToKeyVaultDenied", details: "" },
      { name: "D", status: "VaultNotFound", details: "" },
    ];
    expect(unresolvedFrom(statuses).map((s) => s.name)).toEqual([
      "B",
      "C",
      "D",
    ]);
  });
});

describe("formatReport", () => {
  it("prints names and statuses", () => {
    const out = formatReport([
      {
        name: "REPLICATE-API-KEY",
        status: "SecretNotFound",
        details: "not found",
      },
    ]);
    expect(out).toContain("REPLICATE-API-KEY");
    expect(out).toContain("SecretNotFound");
  });

  // The standing rule: a missing credential is recorded by name, owner and
  // location — never by value. A vault URI carries the vault name, the secret
  // name and the version, and this output goes into a public CI log.
  it("never prints a vault URI even when the payload carries one", () => {
    const raw = shapeA({
      "A-KEY": {
        status: "SecretNotFound",
        details: "not found",
        vaultName: "kv-site-prod-cus-01",
        secretName: "A-KEY",
        reference:
          "@Microsoft.KeyVault(SecretUri=https://kv-site-prod-cus-01.vault.azure.net/secrets/A-KEY/abc123)",
      },
    });
    const out = formatReport(evaluate(raw).unexpected);
    expect(out).not.toContain("vault.azure.net");
    expect(out).not.toContain("SecretUri");
    expect(out).not.toContain("abc123");
  });
});

describe("canonicalName", () => {
  it("strips the platform-added APPSETTING_ prefix", () => {
    expect(canonicalName("APPSETTING_AZURE_SPEECH_KEY")).toBe(
      "AZURE_SPEECH_KEY",
    );
  });

  it("leaves an unprefixed name alone", () => {
    expect(canonicalName("AZURE_SPEECH_KEY")).toBe("AZURE_SPEECH_KEY");
  });
});

describe("evaluate", () => {
  it("reports a healthy estate as nothing unexpected", () => {
    const got = evaluate(
      shapeA({ A: { status: "Resolved" }, B: { status: "Resolved" } }),
    );
    expect(got.checked).toBe(2);
    expect(got.unexpected).toEqual([]);
    expect(got.expected).toEqual([]);
  });

  it("counts what it checked alongside what failed", () => {
    const got = evaluate(
      shapeA({ A: { status: "Resolved" }, B: { status: "SecretNotFound" } }),
    );
    expect(got.checked).toBe(2);
    expect(got.unexpected.map((s) => s.name)).toEqual(["B"]);
  });

  it("accepts an empty but well-formed collection", () => {
    const got = evaluate(shapeA({}));
    expect(got.checked).toBe(0);
    expect(got.unexpected).toEqual([]);
  });

  it("throws rather than returning zero for an unrecognised payload", () => {
    expect(() => evaluate({ nope: true })).toThrow(
      /nothing about the references is known/,
    );
  });

  // THE FIRST LIVE RUN, replayed. It went red on a condition
  // infra/functionapp.tf:444 documents as intended, and reported it twice
  // because Azure surfaces every setting with and without the APPSETTING_
  // prefix. Both halves of that are asserted here.
  it("does not flag a reference that is unresolved on purpose", () => {
    const got = evaluate(
      shapeA({
        ANTHROPIC_API_KEY: { status: "Resolved" },
        AZURE_SPEECH_KEY: { status: "SecretNotFound" },
        APPSETTING_AZURE_SPEECH_KEY: { status: "SecretNotFound" },
      }),
    );
    expect(got.unexpected).toEqual([]);
    expect(got.expected.map((s) => s.name)).toEqual(["AZURE_SPEECH_KEY"]);
  });

  it("counts one broken secret once, not once per platform alias", () => {
    const got = evaluate(
      shapeA({
        REPLICATE_API_KEY: { status: "SecretNotFound" },
        APPSETTING_REPLICATE_API_KEY: { status: "SecretNotFound" },
      }),
    );
    expect(got.unexpected).toHaveLength(1);
    expect(got.unexpected[0].name).toBe("REPLICATE_API_KEY");
  });

  // The allowlist must not become a place findings go to be ignored. A genuine
  // break still pages even when an expected one is present in the same payload.
  it("still fails on an unexpected break alongside an expected one", () => {
    const got = evaluate(
      shapeA({
        AZURE_SPEECH_KEY: { status: "SecretNotFound" },
        REPLICATE_API_KEY: { status: "SecretNotFound" },
      }),
    );
    expect(got.expected.map((s) => s.name)).toEqual(["AZURE_SPEECH_KEY"]);
    expect(got.unexpected.map((s) => s.name)).toEqual(["REPLICATE_API_KEY"]);
  });

  it("notices when an allowlisted reference starts resolving", () => {
    const got = evaluate(shapeA({ AZURE_SPEECH_KEY: { status: "Resolved" } }));
    expect(got.staleAllowlist).toEqual(["AZURE_SPEECH_KEY"]);
    expect(got.unexpected).toEqual([]);
  });

  it("reports no stale entries when the allowlist matches reality", () => {
    const got = evaluate(
      shapeA({ AZURE_SPEECH_KEY: { status: "SecretNotFound" } }),
    );
    expect(got.staleAllowlist).toEqual([]);
  });

  // Seeded 2026-09-28 and resolving since: an unresolved Turnstile secret now
  // closes "Validate on the lab" for everyone, so it pages like any other.
  it("flags an unresolved Turnstile secret, which is seeded and must resolve", () => {
    const got = evaluate(
      shapeA({
        TURNSTILE_SECRET_KEY: { status: "SecretNotFound" },
        APPSETTING_TURNSTILE_SECRET_KEY: { status: "SecretNotFound" },
      }),
    );
    expect(got.unexpected.map((s) => s.name)).toEqual(["TURNSTILE_SECRET_KEY"]);
    expect(got.expected).toEqual([]);
  });
});

describe("EXPECTED_UNRESOLVED", () => {
  // An entry without a reason is a mute wearing a disguise. Every one has to
  // say why, and point at where the decision lives.
  it("gives a reason for every entry", () => {
    for (const [name, reason] of EXPECTED_UNRESOLVED) {
      expect(reason, `${name} has no reason`).toBeTruthy();
      expect(
        reason.length,
        `${name}'s reason is too short to be one`,
      ).toBeGreaterThan(20);
    }
  });

  it("is deliberately small", () => {
    expect(EXPECTED_UNRESOLVED.size).toBeLessThanOrEqual(4);
  });
});
