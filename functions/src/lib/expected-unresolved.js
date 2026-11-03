/**
 * The Key Vault references that are unresolved ON PURPOSE, with the reason
 * for each: the one list the nightly monitor
 * (scripts/check-unresolved-secrets.mjs, which imports it from here) and the
 * Health page's ops snapshot (ops-health.js) both read (#1512).
 *
 * It lived in the monitor script until 2026-11-03. The Health page could not
 * read it there, so it called these three Critical every day while the
 * monitor, reading the same settings, called them expected. A page that is
 * red every day for a condition the repository documents as intended is a
 * page people stop reading. Keeping one list here means the two can no
 * longer disagree about which names are expected.
 *
 * This file has no imports on purpose: the monitor runs it with plain Node
 * from a checkout, without the functions' node_modules.
 */

/**
 * References that are SUPPOSED to be unresolved, and why.
 *
 * Added after the first live run, which was correct and still useless as a
 * page: it went red on AZURE_SPEECH_KEY, which infra/functionapp.tf:444 says in
 * as many words is 'the fallback and is expected to stay unresolved'. Azure AI
 * Speech is a written, tested second path for the day the preview Gemini TTS
 * models are retired; using it means creating a Cognitive Services resource,
 * which is a spend decision nobody has made. An unseeded reference arrives as
 * the literal @Microsoft.KeyVault(...) string, readSetting() treats that as no
 * key at all, and the provider is simply not offered.
 *
 * A monitor that is red every six hours for a condition its own repository
 * documents as intended is not a monitor. It is a thing people mute, and then
 * the real finding arrives into a channel nobody reads. That failure mode is
 * named in the monitor workflow's own header
 * (.github/workflows/monitor-unresolved-secrets.yml), which made shipping it
 * there worse than careless.
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
  // The two Podbean secrets and the StreamYard key were on this list while
  // they waited on the owner; by 2026-11-01 all three resolved (the monitor
  // reported them as resolving-but-still-listed), so they came off.
  // The read-only Cloudflare analytics token (#1302) waits on the owner the
  // same way: the reference lands with its Terraform run, and the monthly
  // audience timer stays quiet (one log line, no writes) until
  // CLOUDFLARE-ANALYTICS-TOKEN is pasted on Integrations -> Keys. Take it
  // off when the owner seeds it.
  [
    "CLOUDFLARE_ANALYTICS_TOKEN",
    "Cloudflare read-only analytics token, unseeded until the owner mints it and seeds CLOUDFLARE-ANALYTICS-TOKEN on Integrations -> Keys",
  ],
  // The visitor session broker's Coder token (#1403) waits on the owner too:
  // the reference lands with its Terraform run, and until the owner has minted
  // the token in Coder and pasted it as CODER-BROKER-TOKEN on Integrations ->
  // Keys, visitor lab sessions answer 'not configured' and the
  // sweepVisitorSessions timer logs one Warning and calls nothing. Take it off
  // when the owner seeds it, and from then on an unresolved one is a real
  // finding.
  [
    "CODER_BROKER_TOKEN",
    "Coder broker token for visitor lab sessions, unseeded until the owner mints it in Coder and seeds CODER-BROKER-TOKEN on Integrations -> Keys",
  ],
  // CODER_STATUS_TOKEN was here from its Terraform run until the owner
  // created it in Coder and seeded CODER-STATUS-TOKEN on 2026-09-28 (#682),
  // when the site's Coder card first listed hcw-lab and a running count. It
  // must resolve from now on. It lapses on 2027-09-28 unless renewed (#763);
  // a lapsed token still resolves here, and only Coder refuses it.
  // TURNSTILE_SECRET_KEY was here from its Terraform run until the owner
  // seeded TURNSTILE-SECRET-KEY on 2026-09-28, when 'Validate on the lab'
  // started working end to end. It must resolve from now on, so an
  // unresolved one is a real finding again.
]);

/** The expected names, sorted, for a snapshot or a test. */
export const EXPECTED_UNRESOLVED_NAMES = Object.freeze(
  [...EXPECTED_UNRESOLVED.keys()].sort(),
);
