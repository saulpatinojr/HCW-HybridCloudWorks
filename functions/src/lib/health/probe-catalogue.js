/**
 * probe-catalogue.js — every probe the Health Hub knows, by id, with its kind
 * and the role a person needs to record its result (#1011).
 *
 * The probes themselves are the frontend's registry
 * (frontend/src/pages/admin/health/probeRegistry.js and probeGroups/): what
 * each covers, how it runs, what breaks. This table is the server's half of
 * that contract, and it is closed on purpose:
 *
 *   - `PUT cms/health/probe-results` accepts only an id listed here, so the
 *     store holds at most one document per real probe and nothing else;
 *   - the server, not the browser, decides a result's `kind`, which decides
 *     its freshness window;
 *   - `writeRole` is the least role that can run the probe: the routes its
 *     run calls require it (viewer for the ops snapshot, the labs snapshot,
 *     the identity reads and the public routes; editor for the proxies,
 *     connectionProbe, testAiProvider, the platform settings, the newsletter
 *     list, the lab job routes and the smoke-test jobs). Someone who could not
 *     have run the probe cannot record its result.
 *
 * The frontend's statusParity.test.js reads this table beside the registry
 * and fails when a probe is added to one and not the other, or when the two
 * disagree on a kind.
 */

const probe = (kind, writeRole) => Object.freeze({ kind, writeRole });

export const HEALTH_PROBES = Object.freeze({
  // Pipeline
  "rss-fetch": probe("session", "editor"),
  "batch-inspect": probe("session", "editor"),
  "reviewer-digest": probe("session", "editor"),
  "scheduled-publishing": probe("snapshot", "viewer"),
  "publishing-failures": probe("snapshot", "viewer"),
  "queue-sla": probe("snapshot", "viewer"),
  "link-rot": probe("snapshot", "viewer"),
  "broken-relationships": probe("live", "viewer"),
  // Creative
  "ai-providers": probe("live", "editor"),
  replicate: probe("live", "editor"),
  firecrawl: probe("live", "editor"),
  "mcp-servers": probe("live", "editor"),
  forge: probe("snapshot", "viewer"),
  "orphaned-images": probe("snapshot", "viewer"),
  // Amplify
  publer: probe("live", "editor"),
  resend: probe("live", "editor"),
  "newsletter-build": probe("live", "editor"),
  linkie: probe("live", "editor"),
  telegram: probe("live", "editor"),
  "telegram-notify": probe("snapshot", "viewer"),
  podbean: probe("live", "editor"),
  streamyard: probe("live", "editor"),
  plaud: probe("live", "editor"),
  youtube: probe("live", "editor"),
  // Enhanced
  elevenlabs: probe("live", "editor"),
  "lab-agents": probe("live", "viewer"),
  // #1009: the host runs main, and Coder serves its template. Read from the
  // Labs snapshot in a browser, recorded by the pulse every five minutes.
  "lab-drift": probe("live", "viewer"),
  "coder-template": probe("live", "viewer"),
  // #1009: a real lab job runs end to end (the hourly canary), and Coder
  // accepts the site's status token. Recorded the same way.
  "lab-canary": probe("live", "viewer"),
  "coder-token": probe("live", "viewer"),
  // #1282: Portainer on the lab host, from the host's own fifteen-minute
  // read of it (labs/host-checks.js, labs/lab-checks.js). Recorded the same
  // way; the Labs snapshot serves it to the card's Run.
  portainer: probe("live", "viewer"),
  "labs-noop": probe("session", "editor"),
  "labs-unauth": probe("session", "viewer"),
  "hybrid-lab": probe("live", "viewer"),
  "migration-addon": probe("live", "viewer"),
  // Spotlight
  sessionize: probe("live", "viewer"),
  // Platform
  cosmos: probe("snapshot", "viewer"),
  blob: probe("live", "editor"),
  storage: probe("snapshot", "viewer"),
  "runtime-config": probe("snapshot", "viewer"),
  "unresolved-secrets": probe("live", "viewer"),
  qlty: probe("live", "editor"),
  "cloud-pricing": probe("live", "viewer"),
  "identity-token": probe("session", "viewer"),
  "admin-registry": probe("session", "viewer"),
});

export const HEALTH_PROBE_IDS = Object.freeze(Object.keys(HEALTH_PROBES));

/** The catalogue entry for an id, or null — never a prototype property. */
export const healthProbe = (id) =>
  Object.hasOwn(HEALTH_PROBES, String(id)) ? HEALTH_PROBES[String(id)] : null;
