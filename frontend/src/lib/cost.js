/**
 * Cost — the browser's side of the Cost page (`/admin/cost`).
 *
 * The server (functions/src/lib/cost) reads Azure Cost Management, the AI
 * usage ledger, ElevenLabs and the services ledger (the subscriptions the site
 * pays for outside Azure), works out the alerts, and keeps one snapshot. This
 * file only fetches that snapshot and the ledger, checks each answer has the
 * shape the server promised (so a proxy's error page never reads as "no
 * cost"), and holds the small pure rules the tabs share: how a dollar figure
 * prints, how far through a budget something is, and what each category,
 * billing cycle and status is called.
 *
 * Every figure comes from the API. Nothing here knows a price.
 */
import { getJSON, sendJSON } from '@/lib/api';

export const COST_SUMMARY_ROUTE = 'cms/cost/summary';
export const COST_SERVICES_ROUTE = 'cms/cost/services';
export const COST_SETTINGS_ROUTE = 'cms/cost/settings';

const SHAPE_ERROR = 'The cost answer was not in the expected shape.';

// ── The API ──────────────────────────────────────────────────────────────────

/**
 * The cost snapshot. `refresh` asks the server to re-read Azure, the AI ledger
 * and ElevenLabs now; it may refuse one made within five minutes of the last
 * and then answers the cached snapshot with `refreshed: false` and
 * `nextRefreshAt`. Throws when the answer is not a snapshot.
 *
 * @param {{ refresh?: boolean }} [options]
 * @returns {Promise<object>} the snapshot, as the contract describes it
 */
export async function fetchCostSummary({ refresh = false } = {}) {
  const body = await getJSON(refresh ? `${COST_SUMMARY_ROUTE}?refresh=1` : COST_SUMMARY_ROUTE);
  if (
    !body ||
    body.ok !== true ||
    !body.period ||
    !body.azure ||
    !body.ai ||
    !body.services ||
    !Array.isArray(body.signals) ||
    !Array.isArray(body.sources)
  ) {
    throw new Error(SHAPE_ERROR);
  }
  return body;
}

/**
 * The services ledger: every item, the server's UTC `today`, and the vendors
 * the site is configured with that are not yet in the ledger (`suggestions`).
 *
 * @returns {Promise<{ today: string, items: object[], total: number, suggestions: object[] }>}
 */
export async function fetchCostServices() {
  const body = await getJSON(COST_SERVICES_ROUTE);
  if (!body || body.ok !== true || !Array.isArray(body.items)) throw new Error(SHAPE_ERROR);
  return {
    today: typeof body.today === 'string' ? body.today : '',
    items: body.items,
    total: Number.isFinite(body.total) ? body.total : body.items.length,
    suggestions: Array.isArray(body.suggestions) ? body.suggestions : [],
  };
}

const itemOf = (body) => {
  if (!body?.item || typeof body.item.id !== 'string') throw new Error(SHAPE_ERROR);
  return body.item;
};

/** @returns {Promise<object>} the item as saved, with its computed fields */
export const createCostService = async (fields) =>
  itemOf(await sendJSON(COST_SERVICES_ROUTE, 'POST', fields));

/** @returns {Promise<object>} the item as saved, with its computed fields */
export const updateCostService = async (id, changes) =>
  itemOf(await sendJSON(`${COST_SERVICES_ROUTE}/${encodeURIComponent(id)}`, 'PATCH', changes));

export const deleteCostService = (id) =>
  sendJSON(`${COST_SERVICES_ROUTE}/${encodeURIComponent(id)}`, 'DELETE');

/** What the settings hold before anything was saved: the server's own defaults. */
export const DEFAULT_SETTINGS = Object.freeze({
  aiMonthlyBudgetUsd: null,
  renewalLeadDays: 7,
  telegram: true,
  monthlyDigest: true,
  refreshHours: 6,
});

const settingsOf = (body) => {
  if (!body || body.ok !== true || !body.settings || typeof body.settings !== 'object') {
    throw new Error(SHAPE_ERROR);
  }
  return { ...DEFAULT_SETTINGS, ...body.settings };
};

/** @returns {Promise<object>} the settings object */
export const fetchCostSettings = async () => settingsOf(await getJSON(COST_SETTINGS_ROUTE));

/** PUT the whole settings object; the server refuses an unknown key. @returns {Promise<object>} as saved */
export const saveCostSettings = async (settings) =>
  settingsOf(await sendJSON(COST_SETTINGS_ROUTE, 'PUT', settings));

// ── Money and budgets ────────────────────────────────────────────────────────

/**
 * A dollar figure as the page prints it: two decimals (`$12.34`, `$0.00`), and
 * up to four below one cent (`$0.0042`) so a small AI charge is not rounded
 * to nothing. A figure that is not a number prints as a dash, never as zero:
 * "unknown" and "nothing" are different answers.
 */
export function fmtUsd(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  if (abs > 0 && abs < 0.01) {
    // Four places, then the trailing zeros dropped down to two.
    const fixed = abs.toFixed(4).replace(/0+$/, '');
    const [whole, frac = ''] = fixed.split('.');
    return `${sign}$${whole}.${frac.padEnd(2, '0')}`;
  }
  return `${sign}$${abs.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** `part` as a percentage of `whole`, one decimal; null when there is no whole to compare with. */
export function percent(part, whole) {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0) return null;
  return Math.round((part / whole) * 1000) / 10;
}

/**
 * How a budget reads at a percentage: `ok` under half, `info` under three
 * quarters, `warn` under nine tenths, `bad` from there. The same steps the
 * server's alert rules use. Nothing to compare with is `muted`.
 */
export function budgetTone(pct) {
  if (!Number.isFinite(pct)) return 'muted';
  if (pct < 50) return 'ok';
  if (pct < 75) return 'info';
  if (pct < 90) return 'warn';
  return 'bad';
}

/**
 * What a subscription costs per month, by its billing cycle: the server's
 * rule, mirrored so the form can show the figure before a save. Monthly is
 * the amount; annual is a twelfth; quarterly a third; usage is treated as a
 * monthly estimate; free and one-off count as nothing; no amount is nothing.
 */
export function monthlyEquivalent(amount, cycle) {
  if (!Number.isFinite(amount) || amount < 0) return 0;
  const divisor = { monthly: 1, annual: 12, quarterly: 3, usage: 1 }[cycle];
  if (!divisor) return 0;
  return Math.round((amount / divisor) * 100) / 100;
}

// ── Words for the ledger's fields ────────────────────────────────────────────

/** Each category the server accepts, in the order the ledger groups them. */
export const CATEGORIES = Object.freeze([
  { id: 'infrastructure', label: 'Infrastructure' },
  { id: 'ai', label: 'AI' },
  { id: 'communication', label: 'Communication' },
  { id: 'content', label: 'Content' },
  { id: 'developer', label: 'Developer tools' },
  { id: 'other', label: 'Other' },
]);

/** Each billing cycle, with what it means in plain words. */
export const CYCLES = Object.freeze([
  { id: 'monthly', label: 'Monthly', help: 'Billed every month.' },
  { id: 'annual', label: 'Yearly', help: 'Billed once a year; shown as a twelfth per month.' },
  {
    id: 'quarterly',
    label: 'Every 3 months',
    help: 'Billed four times a year; shown as a third per month.',
  },
  {
    id: 'usage',
    label: 'Pay as you go',
    help: 'Billed on use; the amount is your monthly estimate.',
  },
  {
    id: 'free',
    label: 'Free',
    help: 'Costs nothing; listed so the renewal date is not forgotten.',
  },
  { id: 'one-off', label: 'One-off', help: 'Paid once; not counted in the monthly total.' },
]);

/** Each status, with the tone StatusBadge paints it. */
export const STATUSES = Object.freeze([
  { id: 'active', label: 'Active', tone: 'ok', help: 'Paid for and in use.' },
  {
    id: 'trial',
    label: 'Trial',
    tone: 'warn',
    help: 'Free for now; it will start billing or stop.',
  },
  {
    id: 'cancelled',
    label: 'Cancelled',
    tone: 'off',
    help: 'No longer paid for; kept for the record.',
  },
]);

const byId = (table) => Object.fromEntries(table.map((row) => [row.id, row]));
const CATEGORY_BY_ID = byId(CATEGORIES);
const CYCLE_BY_ID = byId(CYCLES);
const STATUS_BY_ID = byId(STATUSES);

export const categoryLabel = (id) => CATEGORY_BY_ID[id]?.label ?? String(id || 'Other');
export const cycleLabel = (id) => CYCLE_BY_ID[id]?.label ?? String(id || '');

/** A status as `{ id, label, tone, help }` for StatusBadge; an unknown one is said as it came. */
export const statusInfo = (id) =>
  STATUS_BY_ID[id] ?? {
    id: String(id || 'unknown'),
    label: String(id || 'Unknown'),
    tone: 'muted',
    help: '',
  };

/**
 * How a signal's severity is painted: `bad` for critical, `warn` for a
 * warning, `muted` for information. The word and an icon always travel with
 * the colour (AlertsTab), so this only picks the colour.
 */
export function severityTone(severity) {
  if (severity === 'critical') return 'bad';
  if (severity === 'warning') return 'warn';
  return 'muted';
}

export const SEVERITIES = Object.freeze([
  {
    id: 'critical',
    label: 'Critical',
    help: 'Needs attention today: a budget is spent or nearly spent.',
  },
  { id: 'warning', label: 'Warning', help: 'Heading somewhere you may not want: look this week.' },
  { id: 'info', label: 'Information', help: 'Worth knowing; nothing to do yet.' },
]);

// ── Dates ────────────────────────────────────────────────────────────────────

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * Where a renewal stands, in words, from the server's `daysUntilRenewal`:
 * "in 14 days", "tomorrow", "today", "3 days overdue", or "no date".
 */
export function renewalLabel(days) {
  if (!Number.isFinite(days)) return 'no date';
  if (days < 0) return `${plural(-days, 'day')} overdue`;
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  return `in ${plural(days, 'day')}`;
}

/**
 * How long ago an instant was, in words a reader can place without a clock:
 * "just now", "5 minutes ago", "3 hours ago", "2 days ago". Null for no time.
 */
export function agoLabel(iso, now = Date.now()) {
  const then = Date.parse(iso ?? '');
  if (!Number.isFinite(then)) return null;
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${plural(Math.floor(seconds / 60), 'minute')} ago`;
  if (seconds < 86400) return `${plural(Math.floor(seconds / 3600), 'hour')} ago`;
  return `${plural(Math.floor(seconds / 86400), 'day')} ago`;
}

/** A `YYYY-MM` as "November 2026", on the month it names in every time zone. */
export function monthLabel(month) {
  const date = new Date(`${month}-01T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return String(month ?? '');
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    month: 'long',
    year: 'numeric',
  }).format(date);
}
