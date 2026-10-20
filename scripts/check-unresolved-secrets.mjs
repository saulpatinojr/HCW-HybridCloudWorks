#!/usr/bin/env node
import { pathToFileURL } from "node:url";

// Report app settings whose Key Vault reference is NOT resolving (T-720).
//
// WHY THIS IS A WORKFLOW AND NOT THE ALERT RULE THE TRACKER ASKED FOR.
//
// TODO.md once carried "a scheduled-query alert on unresolvedSecrets ... needs an
// apply" for weeks. There was nothing to apply, and there could not be: the
// count exists only as a field in the /api/health RESPONSE BODY. Nothing writes
// it to Log Analytics, so a scheduled-query rule would run against a table that
// never receives it and return zero rows forever — an alert that reads as
// healthy precisely because it can never fire.
//
// The obvious second design fails too. A workflow cannot simply curl
// /api/health: through Cloudflare a GitHub-hosted runner gets a Bot Fight Mode
// 403, and direct to origin it gets the origin lock's 403, because the site
// denies every address outside Cloudflare's ranges. validate-deployed.yml was
// the workflow that documented this at length; it could never pass from a
// runner for exactly this reason and was deleted on 2026-09-08. The check it
// could not do is run from an operator machine — see
// docs/runbooks/edge-dns-verification.md and `node scripts/smoke-deployed.mjs`.
//
// So this reads the CONDITION through ARM instead, which is the same argument
// monitor-functions-registered.yml already makes and wins on the same axes: it
// survives the Log Analytics daily cap that silences every rule in
// observability.tf, it does not traverse Cloudflare, it needs no metric that
// does not exist, and it names WHICH setting is broken rather than a count.
//
// NAMES, NEVER VALUES. A reference that fails to resolve is a credential
// problem, and the standing rule in this repository is that a missing
// credential is recorded by name, owner and location — never by value. This
// prints setting names and statuses. It deliberately does not print the vault
// URI, which carries the vault name, secret name and version.

/** Statuses the platform reports for a healthy reference. */
export const HEALTHY_STATUS = "resolved";

/**
 * References that are SUPPOSED to be unresolved, and why.
 *
 * Added after the first live run, which was correct and still useless as a
 * page: it went red on AZURE_SPEECH_KEY, which infra/functionapp.tf:444 says in
 * as many words is "the fallback and is expected to stay unresolved". Azure AI
 * Speech is a written, tested second path for the day the preview Gemini TTS
 * models are retired; using it means creating a Cognitive Services resource,
 * which is a spend decision nobody has made. An unseeded reference arrives as
 * the literal @Microsoft.KeyVault(...) string, readSetting() treats that as no
 * key at all, and the provider is simply not offered.
 *
 * A monitor that is red every six hours for a condition its own repository
 * documents as intended is not a monitor. It is a thing people mute, and then
 * the real finding arrives into a channel nobody reads. That failure mode is
 * named in this workflow's own header, which makes shipping it here worse than
 * careless.
 *
 * THIS IS NOT A MUTE. An entry here is reported every run, just not as a
 * failure — and if one ever starts resolving, that is reported too, because it
 * means this list and the comment in functionapp.tf have gone stale.
 */
export const EXPECTED_UNRESOLVED = new Map([
  [
    "AZURE_SPEECH_KEY",
    "fallback TTS provider, deliberately unprovisioned — infra/functionapp.tf:444",
  ],
  // The two Podbean secrets wait on the owner, not on engineering: the show
  // moved to Podbean on 2026-10-13 (ADR 0029 §1c), and they stay unseeded
  // until the owner creates the Podbean developer app and pastes its client
  // ID and secret on Integrations -> Keys. They took the places of the two
  // podcast-host secrets this list carried before (unseeded since #432 and
  // retired with that host). Take both off when the owner seeds them; this
  // file then reports them as resolved-but-still-listed.
  [
    "PODBEAN_CLIENT_ID",
    "Podbean developer-app client ID, unseeded until the owner creates the Podbean developer app",
  ],
  [
    "PODBEAN_CLIENT_SECRET",
    "Podbean developer-app client secret, unseeded until the owner creates the Podbean developer app",
  ],
  [
    "STREAMYARD_API_KEY",
    "StreamYard On-Air API key, unseeded until the owner seeds STREAMYARD-API-KEY on Integrations -> Keys",
  ],
  // The read-only Cloudflare analytics token (#1302) waits on the owner the
  // same way: the reference lands with its Terraform run, and the monthly
  // audience timer stays quiet (one log line, no writes) until
  // CLOUDFLARE-ANALYTICS-TOKEN is pasted on Integrations -> Keys. Take it
  // off when the owner seeds it.
  [
    "CLOUDFLARE_ANALYTICS_TOKEN",
    "Cloudflare read-only analytics token, unseeded until the owner mints it and seeds CLOUDFLARE-ANALYTICS-TOKEN on Integrations -> Keys",
  ],
  // CODER_STATUS_TOKEN was here from its Terraform run until the owner
  // created it in Coder and seeded CODER-STATUS-TOKEN on 2026-09-28 (#682),
  // when the site's Coder card first listed hcw-lab and a running count. It
  // must resolve from now on. It lapses on 2027-09-28 unless renewed (#763);
  // a lapsed token still resolves here, and only Coder refuses it.
  // TURNSTILE_SECRET_KEY was here from its Terraform run until the owner
  // seeded TURNSTILE-SECRET-KEY on 2026-09-28, when "Validate on the lab"
  // started working end to end. It must resolve from now on, so an
  // unresolved one is a real finding again.
]);

/**
 * Strip the APPSETTING_ prefix the platform adds to its own duplicate.
 *
 * Azure surfaces every app setting twice, plain and prefixed, so one broken
 * secret arrives as two findings. The first live run reported AZURE_SPEECH_KEY
 * and APPSETTING_AZURE_SPEECH_KEY as "2 of 42" when the true count of broken
 * secrets was one. Doubling a count is how a small problem gets read as a
 * bigger one, and this file's entire job is not misreporting scale.
 */
export function canonicalName(name) {
  return String(name).replace(/^APPSETTING_/, "");
}

/**
 * Pull {name, status, details} out of an ARM KeyVaultReferenceCollection.
 *
 * SHAPE A IS CONFIRMED. The first live run on 2026-08-30 returned
 * properties.keyToReferenceStatuses and parsed 42 references, so the guess this
 * was written against was right. Shape B stays because one tenant on one
 * api-version is not every tenant on every api-version, and the cost of keeping
 * it is a branch that never executes. Anything matching NEITHER still throws —
 * see assertKnownShape. Do not relax the throw.
 */
export function parseReferenceStatuses(payload) {
  if (!payload || typeof payload !== "object") {
    throw new Error("The ARM response was not a JSON object.");
  }

  // Shape A: { properties: { keyToReferenceStatuses: { NAME: {status, ...} } } }
  const map = payload?.properties?.keyToReferenceStatuses;
  if (map && typeof map === "object" && !Array.isArray(map)) {
    return Object.entries(map).map(([name, entry]) => ({
      name,
      status:
        typeof entry?.status === "string"
          ? entry.status
          : "(no status reported)",
      details: typeof entry?.details === "string" ? entry.details : "",
    }));
  }

  // Shape B: { value: [ { name, properties: { status, ... } } ] }
  if (Array.isArray(payload?.value)) {
    return payload.value.map((row) => ({
      name: typeof row?.name === "string" ? row.name : "(unnamed)",
      status:
        typeof row?.properties?.status === "string"
          ? row.properties.status
          : "(no status reported)",
      details:
        typeof row?.properties?.details === "string"
          ? row.properties.details
          : "",
    }));
  }

  return null;
}

/**
 * Turn an unrecognised payload into a stop, not a clean bill of health.
 *
 * This is the same guard as the row-shape assertion that used to live in
 * scripts/cutover/workspace-query.psm1 (retired 2026-09-08 with the timer
 * script it served), for the same reason. A call that succeeds and answers a
 * different question is worse than one that fails, because its output looks
 * like data. On 2026-08-30 a truncated query reported 57,984 invocations and
 * no worker traces in the same run, and both numbers were real — about the
 * wrong subject.
 */
export function assertKnownShape(statuses, raw) {
  if (statuses !== null) return statuses;
  const keys =
    raw && typeof raw === "object" ? Object.keys(raw).join(", ") : String(raw);
  throw new Error(
    "The ARM response carried neither known Key Vault reference shape " +
      `(top-level keys: ${keys || "(none)"}). This is NOT "every reference is healthy" — ` +
      "the shape was not understood, so nothing about the references is known. " +
      "Read the payload by hand before trusting any run of this check.",
  );
}

/** References that are not reporting healthy. Comparison is case-insensitive. */
export function unresolvedFrom(statuses) {
  return statuses.filter(
    (s) => String(s.status).toLowerCase() !== HEALTHY_STATUS,
  );
}

/** One line per finding: name and status only. No vault URI, no value. */
export function formatReport(unresolved) {
  return unresolved
    .map((s) => `  ${s.name}: ${s.status}${s.details ? ` — ${s.details}` : ""}`)
    .join("\n");
}

export function evaluate(payload) {
  const statuses = assertKnownShape(parseReferenceStatuses(payload), payload);

  const byName = new Map();
  for (const s of unresolvedFrom(statuses)) {
    const name = canonicalName(s.name);
    if (!byName.has(name)) byName.set(name, { ...s, name });
  }

  const unexpected = [];
  const expected = [];
  for (const s of byName.values()) {
    (EXPECTED_UNRESOLVED.has(s.name) ? expected : unexpected).push(s);
  }

  // An allowlisted reference that RESOLVES means this list has outlived the
  // decision behind it. Not a failure — but saying nothing would let the list
  // quietly become a place where real findings go to be ignored.
  const resolvedNames = new Set(
    statuses
      .filter((s) => String(s.status).toLowerCase() === HEALTHY_STATUS)
      .map((s) => canonicalName(s.name)),
  );
  const staleAllowlist = [...EXPECTED_UNRESOLVED.keys()].filter((n) =>
    resolvedNames.has(n),
  );

  return { checked: statuses.length, unexpected, expected, staleAllowlist };
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  const text = await readStdin();
  if (!text.trim()) {
    console.error("No ARM response on stdin. Nothing was checked.");
    process.exit(2);
  }

  let payload;
  try {
    payload = JSON.parse(text);
  } catch (err) {
    console.error(`The ARM response was not valid JSON: ${err.message}`);
    process.exit(2);
  }

  let result;
  try {
    result = evaluate(payload);
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }

  // Reported every run, never as a failure. Silence here would make the
  // allowlist a mute, which is the thing it is written not to be.
  if (result.expected.length > 0) {
    console.log(
      `${result.expected.length} reference(s) are unresolved as intended, and are not a finding:`,
    );
    for (const s of result.expected) {
      console.log(
        `  ${s.name}: ${s.status} — ${EXPECTED_UNRESOLVED.get(s.name)}`,
      );
    }
    console.log("");
  }

  if (result.staleAllowlist.length > 0) {
    console.log(
      "These are on the expected-unresolved list but are RESOLVING, so the list and " +
        `the comment behind it have gone stale: ${result.staleAllowlist.join(", ")}`,
    );
    console.log("");
  }

  if (result.unexpected.length === 0) {
    console.log(
      `All ${result.checked} Key Vault reference(s) are resolving, or unresolved as intended.`,
    );
    process.exit(0);
  }

  console.error(
    `${result.unexpected.length} Key Vault reference(s) are NOT resolving and were not ` +
      `expected to be, out of ${result.checked} checked:`,
  );
  console.error(formatReport(result.unexpected));
  console.error("");
  console.error(
    "Each one is a feature that has quietly turned itself off in production: the code " +
      "takes a clean fallback path, so there is no exception in Application Insights. " +
      "Unseeded, RBAC revoked, vault firewall denying, and rotated-and-broken all look " +
      "identical from here — the status above narrows it.",
  );
  process.exit(1);
}

// pathToFileURL, not a `file://` template — matching check-tfc-plan.mjs:301.
// Node resolves process.argv[1] to an absolute path, so the naive form does
// match for an ordinary invocation. It stops matching when the path needs
// escaping: pathToFileURL percent-encodes a space, and string concatenation
// does not, so the two URLs differ and main() silently never runs. The process
// then exits 0 having checked nothing — a monitor reporting healthy because it
// did not execute, which is the same failure this file's shape assertion
// exists to prevent, one layer up. check-unresolved-secrets.invocation.test.mjs
// pins it by spawning the script for real.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
