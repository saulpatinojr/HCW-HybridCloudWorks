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
  EDITABLE_PHASES,
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
} from './cloudflareLocks';

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
 * Whether a replacement needs the phase's name typed to confirm: in the
 * custom security rules, a shorter list removes a security rule, so the
 * page asks for more than one click.
 */
export const needsTypedConfirm = (phase, currentCount, nextCount) =>
  phase === 'http_request_firewall_custom' && nextCount < currentCount;

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
