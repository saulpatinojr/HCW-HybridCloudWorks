/**
 * The Cloudflare page's pure half (#1905): what the API's answers become on
 * screen, and what a form becomes before it is sent. No I/O and no React, so
 * every sentence and every check is testable without a render.
 *
 * What is locked (the protected names, the allow-list of rule phases, the
 * owner-only settings) is in cloudflareLocks.js, the browser's mirror of the
 * server's protected.js; it is re-exported here so the tabs import from one
 * place.
 */

export {
  APEX_WILDCARD_REASON,
  DEFAULT_ZONE,
  EDITABLE_PHASES,
  MANAGED_ZONE_NAMES,
  OWNER_ONLY_SETTINGS,
  PROTECTED_DNS_PREFIXES,
  PROTECTED_PHASES,
  READ_ONLY_PHASE_REASON,
  REDACTED_VALUE,
  ZONE_APEX,
  dnsNameLock,
  editablePhaseList,
  holdsHiddenValue,
  isEditablePhase,
  normalizeDnsName,
  ownerOnlyReason,
  phaseLock,
  protectedDnsList,
  protectedPhaseList,
  protectedPrefixList,
  resolveZone,
} from './cloudflareLocks';
import { DEFAULT_ZONE } from './cloudflareLocks';

export {
  CAREFUL_SETTINGS,
  SETTING_CHOICES,
  parseSettingDraft,
  settingControl,
  settingDraft,
  settingLabel,
  settingMatches,
} from './cloudflareSettingsView';
export {
  AUTO_TTL,
  DNS_TYPES,
  PROXIABLE_TYPES,
  dnsDialogCheck,
  dnsForm,
  dnsRecordBody,
  dnsRecordPatch,
  editableType,
  ttlText,
} from './cloudflareDnsForm';

// ── Not set up yet ───────────────────────────────────────────────────────────

/**
 * The two things the page needs, as the server names them in `missing`
 * (functions/src/lib/cloudflare/zone-routes.js PREREQUISITES), and what each
 * one is and where it comes from. The token is pasted on the Keys tab; the
 * zone id is never pasted, Terraform sets it.
 */
export const PREREQUISITE_NOTES = Object.freeze({
  token: Object.freeze({
    setting: 'CLOUDFLARE_ADMIN_TOKEN',
    short: 'the admin token',
    description:
      'The page needs the Cloudflare admin token: an account-owned API token limited to the site’s zone and the lab zone. Make it in the Cloudflare dashboard, then paste it on Integrations → Keys (the row CLOUDFLARE-ADMIN-TOKEN). The site never shows it again.',
  }),
  zoneId: Object.freeze({
    setting: 'CF_ZONE_ID',
    short: 'the zone id',
    description:
      'The page needs the zone id (CF_ZONE_ID), which names the site’s zone. It is not pasted anywhere: Terraform sets it on the function app on the next apply of the hcw-azure workspace.',
  }),
});

/**
 * What is missing: the server's `missing` list when it sent one, else read
 * from its sentence (a 503 answer names each missing setting), else unknown
 * (an empty list).
 */
export function missingPrerequisites({ missing, message } = {}) {
  const ids = Object.keys(PREREQUISITE_NOTES);
  if (Array.isArray(missing)) return ids.filter((id) => missing.includes(id));
  const text = String(message ?? '');
  return ids.filter((id) => text.includes(PREREQUISITE_NOTES[id].setting));
}

/**
 * The "not set up yet" note: its description and whether it offers the Keys
 * tab. It names only what is missing, so a missing zone id never sends the
 * owner to paste a token that is already there. When nothing says what is
 * missing, it shows the server's sentence, or names both.
 */
export function notConfiguredNote({ missing, message } = {}) {
  const found = missingPrerequisites({ missing, message });
  if (found.length) {
    return {
      description: found.map((id) => PREREQUISITE_NOTES[id].description).join(' '),
      keysLink: found.includes('token'),
    };
  }
  if (message) return { description: message, keysLink: false };
  return {
    description: Object.values(PREREQUISITE_NOTES)
      .map((note) => note.description)
      .join(' '),
    keysLink: true,
  };
}

/** The page header's one line while the page is not set up. */
export function notConfiguredHeadline(status) {
  const found = missingPrerequisites(status ?? {});
  if (found.length === 0) return 'Not set up yet.';
  const words = found.map((id) => PREREQUISITE_NOTES[id].short).join(' and ');
  const verb = found.length > 1 ? 'are' : 'is';
  const terraform = found.includes('zoneId') ? ' (Terraform sets the zone id)' : '';
  return `Not set up yet: ${words} ${verb} missing${terraform}.`;
}

// ── The picked zone ──────────────────────────────────────────────────────────

/**
 * The status answer for the picked zone, or null while none is in hand, and
 * whether the server answered for another zone. The server names the zone
 * each answer is about (`managed`); an answer without it comes from a server
 * older than #1911, which knows only the site's zone. So while the read for
 * a newly picked zone is out the old answer is not shown as this zone's, and
 * a settled answer for another zone means the server cannot act on this one
 * yet: the page then shows a note in place of the tabs rather than let a
 * change land in the wrong zone.
 */
export function zoneStatus(read, zone) {
  const data = read?.loaded ? read.data : null;
  if (!data) return { status: null, otherZone: false };
  if ((data.managed?.name ?? DEFAULT_ZONE) === zone) return { status: data, otherZone: false };
  return { status: null, otherZone: !read.pending };
}

// ── After a change ───────────────────────────────────────────────────────────

/**
 * The warning a saved change carries, or null. Two answers need one: the
 * change was made but its audit row could not be written (`audited: false`),
 * and a DNS edit came back under a protected name (`protectedAfterWrite`).
 * The server also tells the owner's phone about both.
 */
export function changeWarning(answer) {
  const notes = [];
  if (answer?.protectedAfterWrite === true) {
    notes.push(
      'The record came back with a protected name: someone may have renamed it while you were editing. Check it in the Cloudflare dashboard.'
    );
  }
  if (answer?.concurrentWrite === true) {
    notes.push(
      'Another change to this rule phase was saved just before yours, so yours may have replaced it. Reload the phase and check it.'
    );
  }
  if (answer?.audited === false) {
    notes.push(
      'The change was made in Cloudflare, but its audit row could not be written, so the audit log does not show it. A warning has been sent to the owner’s Telegram.'
    );
  }
  return notes.length ? notes.join(' ') : null;
}

// ── Overview ─────────────────────────────────────────────────────────────────

/** What reading each family lets the page do, for the Overview's list. */
export const FAMILY_WORDS = Object.freeze({
  settings: 'Zone settings (HTTPS, security level, caching and the rest)',
  dns: 'DNS records',
  rules: 'Rules (the zone’s rulesets, by phase)',
  cache: 'The cache (emptying it)',
});

/**
 * What each answer to "can the token read this?" means. The server answers
 * true (it read), false (Cloudflare refused the token: 401 or 403) or null
 * (anything else: a timeout or an error, so it is not known).
 */
export const FAMILY_STATES = Object.freeze({
  yes: 'can be read',
  refused: 'refused (the token lacks this permission)',
  unknown: 'could not check right now',
});

const familyState = (readable) => {
  if (readable === true) return 'yes';
  return readable === false ? 'refused' : 'unknown';
};

/** One line per family the status reports, in its order, with its state and words. */
export function familyRows(status) {
  return (status?.families ?? []).map((family) => {
    const state = familyState(family.readable);
    return {
      id: family.id,
      label: family.label || FAMILY_WORDS[family.id] || family.id,
      readable: family.readable === true,
      state,
      words: FAMILY_STATES[state],
    };
  });
}

// ── The API rate limit (#1909) ───────────────────────────────────────────────

/**
 * The status tone (lib/status.js) for each state the server reports in the
 * status answer's `rateLimit` (functions/src/lib/cloudflare/rate-limit.js
 * RATE_LIMIT_STATES; the mirror test fails when a state has no tone here).
 * The sentence is the server's, so only the tone lives here: green when a
 * rule is on, amber when the phase is empty or every rule is off, red when
 * Cloudflare refused the token, offline when it did not answer.
 */
export const RATE_LIMIT_TONES = Object.freeze({
  on: 'healthy',
  empty: 'degraded',
  off: 'degraded',
  refused: 'critical',
  unreachable: 'offline',
});

/**
 * The rate limit line for a status answer: `{ state, tone, message }`, or
 * null when the answer carries none (the lab zone, which has no API to
 * protect, or an older server). While the token or the zone id is not set,
 * nothing was checked in the site's zone, and the line says so with the
 * server's own "not set up" sentence.
 */
export function rateLimitLine(status) {
  const siteZone = (status?.managed?.name ?? DEFAULT_ZONE) === DEFAULT_ZONE;
  if (status?.configured === false && siteZone) {
    const why = status.message || 'Cloudflare is not set up yet.';
    return { state: 'not-configured', tone: 'unknown', message: `Not checked. ${why}` };
  }
  const found = status?.rateLimit;
  if (!found || !Object.hasOwn(RATE_LIMIT_TONES, found.state)) return null;
  return { state: found.state, tone: RATE_LIMIT_TONES[found.state], message: found.message };
}

/** Whether the line asks the owner to make or switch on the rule (runbook part 4). */
export const rateLimitNeedsRule = (line) => line?.tone === 'degraded';

// ── Rules ────────────────────────────────────────────────────────────────────

/** Fields Cloudflare writes itself on each rule; the editor leaves them out. */
const RULE_READ_ONLY = ['version', 'last_updated'];

/** A phase's rules as the editor starts them: Cloudflare's own fields taken out. */
export function editableRules(ruleset) {
  return (ruleset?.rules ?? []).map((rule) =>
    Object.fromEntries(Object.entries(rule).filter(([key]) => !RULE_READ_ONLY.includes(key)))
  );
}

/** The edited text as the rules list to send, or a sentence saying what is wrong. */
export function parseRulesDraft(text) {
  let rules;
  try {
    rules = JSON.parse(String(text ?? ''));
  } catch {
    throw new Error('This is not valid JSON. Check the quotes, commas and brackets.');
  }
  if (!Array.isArray(rules))
    throw new Error('The rules must be a list: start with [ and end with ].');
  if (rules.length === 0) {
    throw new Error(
      'An empty list would delete every rule in this phase. Deleting is done in the Cloudflare dashboard.'
    );
  }
  rules.forEach((rule, index) => {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
      throw new Error(`Rule ${index + 1} is not an object: each rule is written inside { }.`);
    }
    if (typeof rule.expression !== 'string' || typeof rule.action !== 'string') {
      throw new Error(`Rule ${index + 1} needs an "expression" and an "action".`);
    }
  });
  return rules;
}

/**
 * The phases whose rules protect the site, so a shorter list takes some
 * protection away: what a removed rule is called, and what removing it does.
 */
export const GUARDED_PHASES = Object.freeze({
  http_request_firewall_custom: Object.freeze({
    rules: 'custom security rule(s)',
    effect: 'requests they blocked or challenged will reach the site',
  }),
  http_ratelimit: Object.freeze({
    rules: 'rate limiting rule(s)',
    effect: 'the requests they limited, such as calls to the API, will no longer be limited',
  }),
});

/**
 * Whether a replacement needs the phase's name typed to confirm: in a
 * guarded phase (custom security rules, rate limiting), a shorter list
 * removes a rule that protects the site, so the page asks for more than one
 * click.
 */
export const needsTypedConfirm = (phase, currentCount, nextCount) =>
  Object.hasOwn(GUARDED_PHASES, phase) && nextCount < currentCount;

/** The zone's own entry points (kind `zone`), one per phase. */
export function entrypointRulesets(rulesets = []) {
  return rulesets.filter((ruleset) => ruleset.kind === 'zone');
}

/** Every other ruleset (Cloudflare's managed ones), listed but not changed here. */
export function otherRulesets(rulesets = []) {
  return rulesets.filter((ruleset) => ruleset.kind !== 'zone');
}

// ── Cache ────────────────────────────────────────────────────────────────────

/** Whether a host is the zone or one of its names. */
function onZone(host, zoneName) {
  const zone = String(zoneName || '').toLowerCase();
  if (!zone) return true;
  return host === zone || host.endsWith(`.${zone}`);
}

/**
 * The addresses to purge from the text box: one per line, each https and on
 * the zone's own names, at most MAX_PURGE_FILES, each once. Returns the list
 * and a sentence per problem; the purge is sent only with no problems.
 */
export function parsePurgeList(text, { zoneName = '', max = 30 } = {}) {
  const lines = String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const files = [];
  const problems = [];
  for (const line of lines) {
    let url;
    try {
      url = new URL(line);
    } catch {
      problems.push(`"${line}" is not a full address. Start it with https://.`);
      continue;
    }
    if (url.protocol !== 'https:') {
      problems.push(`"${line}" is not https.`);
      continue;
    }
    if (!onZone(url.hostname.toLowerCase(), zoneName)) {
      problems.push(`"${line}" is not on ${zoneName}, so this zone cannot purge it.`);
      continue;
    }
    if (!files.includes(url.href)) files.push(url.href);
  }
  if (lines.length === 0) problems.push('Enter at least one address, one per line.');
  if (files.length > max)
    problems.push(`At most ${max} addresses at once; there are ${files.length}.`);
  return { files, problems };
}
