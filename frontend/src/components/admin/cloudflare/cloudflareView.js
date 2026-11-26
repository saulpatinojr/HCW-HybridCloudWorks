/**
 * The Cloudflare page's pure half (#1905): what the API's answers become on
 * screen, and what a form becomes before it is sent. No I/O and no React, so
 * every sentence and every check is testable without a render.
 *
 * WHAT IS LOCKED IS THE SERVER'S DECISION. The server marks a DNS record or
 * a ruleset `locked` with a reason, and refuses a change to it (409) whatever
 * the browser sends. The lists here are a mirror, so the page can say so
 * before the request instead of after it:
 *
 *   PROTECTED_PHASES  mirrors functions/src/lib/cloudflare/protected.js;
 *                     cloudflareView.test.js compares the two once that file
 *                     exists
 *   DNS names         come from the status answer (`protected.dnsNames`),
 *                     because they are built from Terraform's records and the
 *                     zone's own name; the page only matches against them
 */

// ── Locked things ────────────────────────────────────────────────────────────

/**
 * The rule phases nobody changes from here, and why. The browser's mirror of
 * the server's list; the server's own reason wins when it gives one.
 */
export const PROTECTED_PHASES = Object.freeze([
  Object.freeze({
    phase: 'http_request_late_transform',
    reason:
      'The origin secret rule (infra/frontend.tf, cloudflare_ruleset.origin_secret) adds the header that proves a visitor came through Cloudflare. Changing it locks every visitor out of the API.',
  }),
  Object.freeze({
    phase: 'http_ratelimit',
    reason:
      'The API rate limit rule is managed by Terraform (infra/). A change here would be undone on the next Terraform run, and removing it lets one visitor flood the API.',
  }),
]);

/** One locked thing in the shape every list here uses, whatever the server sent. */
function entry(item, key) {
  if (typeof item === 'string') return { [key]: item, reason: '' };
  if (item && typeof item === 'object' && typeof item[key] === 'string') {
    return { [key]: item[key], reason: typeof item.reason === 'string' ? item.reason : '' };
  }
  return null;
}

/**
 * Every protected phase with its reason: the server's list from the status
 * answer, joined with the mirror above (so a phase is locked on screen even
 * before the status has been read).
 */
export function protectedPhaseList(status) {
  const fromServer = (status?.protected?.phases ?? [])
    .map((item) => entry(item, 'phase'))
    .filter(Boolean);
  const byPhase = new Map(PROTECTED_PHASES.map((item) => [item.phase, { ...item }]));
  for (const item of fromServer) {
    const known = byPhase.get(item.phase);
    byPhase.set(item.phase, { phase: item.phase, reason: item.reason || known?.reason || '' });
  }
  return [...byPhase.values()];
}

/** Why a phase is locked, or null when it may be changed. */
export function phaseLock(phase, { ruleset = null, status = null } = {}) {
  if (ruleset?.locked) {
    return ruleset.lockedReason || 'The server marks this phase as locked.';
  }
  const listed = protectedPhaseList(status).find((item) => item.phase === phase);
  if (!listed) return null;
  return listed.reason || 'This phase keeps the site running, so it is locked.';
}

/** A DNS name as Cloudflare spells it in full: lower case, no trailing dot, `@` read as the zone. */
export function normalizeDnsName(name, zoneName = '') {
  const zone = String(zoneName || '')
    .trim()
    .toLowerCase()
    .replace(/\.$/, '');
  let value = String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/\.$/, '');
  if (!value) return '';
  if (value === '@') return zone;
  if (zone && value !== zone && !value.endsWith(`.${zone}`)) value = `${value}.${zone}`;
  return value;
}

/** Every protected DNS name from the status answer, each `{ name, reason }`. */
export function protectedDnsList(status) {
  return (status?.protected?.dnsNames ?? []).map((item) => entry(item, 'name')).filter(Boolean);
}

const ACME_REASON =
  'A certificate check record (_acme-challenge). The certificate for this name is renewed through it, so it is changed only where the certificate is managed.';

/**
 * Why a DNS name is locked, or null. Matches the status answer's list (an
 * entry ending in `*` is a prefix), and any name whose first label starts
 * `_acme-challenge`, which the server always protects.
 */
export function dnsNameLock(name, { status = null, zoneName = '' } = {}) {
  const zone = zoneName || status?.zone?.name || '';
  const full = normalizeDnsName(name, zone);
  if (!full) return null;
  for (const item of protectedDnsList(status)) {
    const listed = item.name.trim().toLowerCase();
    const matches = listed.endsWith('*')
      ? full.startsWith(normalizeDnsName(listed.slice(0, -1), '').replace(/\.$/, ''))
      : normalizeDnsName(listed, zone) === full;
    if (matches) return item.reason || 'This record keeps the site running, so it is locked.';
  }
  if (full.split('.')[0].startsWith('_acme-challenge')) return ACME_REASON;
  return null;
}

// ── Overview ─────────────────────────────────────────────────────────────────

/** What reading each family lets the page do, for the Overview's list. */
export const FAMILY_WORDS = Object.freeze({
  settings: 'Zone settings (HTTPS, security level, caching and the rest)',
  dns: 'DNS records',
  rules: 'Rules (the zone’s rulesets, by phase)',
  cache: 'The cache (emptying it)',
});

/** One line per family the status reports, in its order. */
export function familyRows(status) {
  return (status?.families ?? []).map((family) => ({
    id: family.id,
    label: family.label || FAMILY_WORDS[family.id] || family.id,
    readable: family.readable === true,
  }));
}

// ── Settings ─────────────────────────────────────────────────────────────────

/**
 * Settings whose value is one of a fixed list, and the list. From Cloudflare's
 * zone settings reference (https://developers.cloudflare.com/api/, Zones →
 * Settings). A value the list does not hold falls back to the JSON editor
 * rather than being forced into a select.
 */
export const SETTING_CHOICES = Object.freeze({
  ssl: ['off', 'flexible', 'full', 'strict'],
  min_tls_version: ['1.0', '1.1', '1.2', '1.3'],
  tls_1_3: ['on', 'off', 'zrt'],
  security_level: ['off', 'essentially_off', 'low', 'medium', 'high', 'under_attack'],
  cache_level: ['aggressive', 'basic', 'simplified'],
  polish: ['off', 'lossless', 'lossy'],
  pseudo_ipv4: ['off', 'add_header', 'overwrite_header'],
  origin_max_http_version: ['1', '2'],
});

/**
 * Settings that can lock visitors out or open the site up when they are
 * wrong. Saving one asks first, and the row says why.
 */
export const CAREFUL_SETTINGS = Object.freeze({
  ssl: 'How Cloudflare connects to the site. The wrong mode breaks HTTPS for every visitor.',
  always_use_https: 'Sends every visitor to HTTPS. Turning it off lets pages load unencrypted.',
  min_tls_version:
    'The oldest encryption a visitor’s browser may use. Too new locks out older browsers.',
  tls_1_3: 'The newest encryption. Turning it off makes every connection slower.',
  security_level:
    'How suspicious Cloudflare is of visitors. "Under attack" shows every visitor a check page.',
  development_mode: 'Turns the cache off for three hours. The site is slower while it is on.',
});

/** A setting id as words: `always_use_https` is "Always use https". */
export function settingLabel(id) {
  const words = String(id ?? '').replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Which control a setting gets: read-only when Cloudflare says it cannot be
 * changed, a switch for on/off, a select for a known list, a number box for a
 * number, and the JSON editor for everything else.
 */
export function settingControl(setting) {
  if (setting?.editable === false) return 'readonly';
  const { id, value } = setting ?? {};
  if (value === 'on' || value === 'off') return 'switch';
  if (typeof value === 'string' && SETTING_CHOICES[id]?.includes(value)) return 'select';
  if (typeof value === 'number' && Number.isFinite(value)) return 'number';
  return 'json';
}

/** The text a control starts from. */
export function settingDraft(control, value) {
  if (control === 'json' || control === 'readonly') {
    return typeof value === 'string' ? JSON.stringify(value) : JSON.stringify(value, null, 2);
  }
  return String(value ?? '');
}

/** What a control's text becomes when saved, or a sentence saying why it cannot be. */
export function parseSettingDraft(control, draft) {
  if (control === 'switch') {
    if (draft !== 'on' && draft !== 'off') throw new Error('Choose on or off.');
    return draft;
  }
  if (control === 'select') return String(draft);
  if (control === 'number') {
    const text = String(draft ?? '').trim();
    const number = Number(text);
    if (!text || !Number.isFinite(number)) throw new Error('Enter a number.');
    return number;
  }
  if (control === 'json') {
    try {
      return JSON.parse(String(draft ?? ''));
    } catch {
      throw new Error('This is not valid JSON. Check the quotes, commas and brackets.');
    }
  }
  throw new Error('This setting cannot be changed.');
}

/** Whether a setting's id or label holds the filter text. */
export function settingMatches(setting, filter) {
  const text = String(filter ?? '')
    .trim()
    .toLowerCase();
  if (!text) return true;
  return (
    setting.id.toLowerCase().includes(text) || settingLabel(setting.id).toLowerCase().includes(text)
  );
}

// ── DNS ──────────────────────────────────────────────────────────────────────

/** The record types the form offers. Others are listed but changed in the dashboard. */
export const DNS_TYPES = Object.freeze(['A', 'AAAA', 'CNAME', 'TXT', 'MX']);
/** The types Cloudflare can proxy (pass visitors through its network). */
export const PROXIABLE_TYPES = Object.freeze(['A', 'AAAA', 'CNAME']);
/** TTL 1 is Cloudflare's "Automatic"; anything else is seconds, 60 to 86400. */
export const AUTO_TTL = 1;

export function ttlText(ttl) {
  if (ttl === AUTO_TTL || ttl === undefined || ttl === null) return 'Automatic';
  return `${ttl} s`;
}

/** The form's starting values for a new record, or for an existing one. */
export function dnsForm(record = null) {
  return {
    type: record?.type ?? 'A',
    name: record?.name ?? '',
    content: record?.content ?? '',
    ttl: String(record?.ttl ?? AUTO_TTL),
    proxied: record?.proxied === true,
    comment: record?.comment ?? '',
    priority:
      record?.priority === undefined || record?.priority === null ? '' : String(record.priority),
  };
}

/** A form field as trimmed text, whatever it held. */
const field = (form, key) => String(form?.[key] ?? '').trim();

/** A whole number from `low` to `high` written in `text`, or null. */
function wholeNumber(text, low, high) {
  if (!text) return null;
  const number = Number(text);
  return Number.isInteger(number) && number >= low && number <= high ? number : null;
}

/** The TTL a form says, checked: 1 for Automatic, or 60 to 86400 seconds. */
function formTtl(form) {
  const text = field(form, 'ttl') || String(AUTO_TTL);
  const ttl = text === String(AUTO_TTL) ? AUTO_TTL : wholeNumber(text, 60, 86400);
  if (ttl === null) {
    throw new Error('TTL is 1 for Automatic, or a whole number of seconds from 60 to 86400.');
  }
  return ttl;
}

/** The text fields a record cannot be without, checked, in the order the form shows them. */
function requiredFields(form) {
  const type = field(form, 'type');
  if (!DNS_TYPES.includes(type)) throw new Error(`Choose a type: ${DNS_TYPES.join(', ')}.`);
  const name = field(form, 'name');
  if (!name) throw new Error('Enter the name, for example "lab" or "@" for the zone itself.');
  const content = field(form, 'content');
  if (!content) throw new Error('Enter the content: the address or text the record points to.');
  return { type, name, content };
}

/**
 * The body a form sends, checked: the request body for a new record. Throws
 * a sentence the form shows when something is missing or out of range.
 */
export function dnsRecordBody(form) {
  const body = { ...requiredFields(form), ttl: formTtl(form) };
  if (PROXIABLE_TYPES.includes(body.type)) body.proxied = form?.proxied === true;
  const comment = field(form, 'comment');
  if (comment) body.comment = comment;
  if (body.type === 'MX') {
    body.priority = wholeNumber(field(form, 'priority'), 0, 65535);
    if (body.priority === null) {
      throw new Error('An MX record needs a priority, a whole number from 0 to 65535.');
    }
  }
  return body;
}

/** Whether a record's type can be changed from this page (DNS_TYPES). */
export const editableType = (record) => DNS_TYPES.includes(record?.type);

/**
 * What the add or edit form says right now: the body it would send, or the
 * sentence that stops it (a missing field, or a locked name), and whether
 * an edit changed nothing at all.
 */
export function dnsDialogCheck({ record = null, form, status = null }) {
  let body = null;
  let problem = '';
  try {
    body = record ? dnsRecordPatch(record, form) : dnsRecordBody(form);
  } catch (err) {
    problem = err.message;
  }
  const lock = field(form, 'name') ? dnsNameLock(form.name, { status }) : null;
  if (!problem && lock) problem = `That name is locked. ${lock}`;
  const nothingChanged = Boolean(record && body && Object.keys(body).length === 0);
  return { body, problem, nothingChanged };
}

/**
 * Only what changed between a record and its edited form, so an edit sends
 * the fields the owner touched and nothing else. The type is not changed
 * from here. Throws like dnsRecordBody; an empty object means nothing changed.
 */
export function dnsRecordPatch(record, form) {
  const next = dnsRecordBody({ ...form, type: record.type });
  const patch = {};
  if (next.name !== record.name) patch.name = next.name;
  if (next.content !== record.content) patch.content = next.content;
  if (next.ttl !== record.ttl) patch.ttl = next.ttl;
  if ('proxied' in next && next.proxied !== (record.proxied === true)) patch.proxied = next.proxied;
  if ((next.comment ?? '') !== (record.comment ?? '')) patch.comment = next.comment ?? '';
  if ('priority' in next && next.priority !== record.priority) patch.priority = next.priority;
  return patch;
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

/** The zone's own entry points (kind `zone`), one per phase, which this page can edit. */
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
