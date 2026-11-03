/**
 * cost/collector.js — subscription renewals as a Calendar source (ADR 0033 §4:
 * "adding a source is adding a collector to COLLECTORS"; ADR 0039).
 *
 * One point read of the ledger document, no write. Each billing subscription
 * with a renewal day inside the window is one all-day item, kind `renewal`,
 * opening the Cost page's Services tab. The amount travels in `meta` so the
 * chip's preview can say what renews and for how much.
 */
import { ADMIN_CONFIG_PARTITION } from '../cosmos-client.js';
import { item, rowsInWindow } from '../calendar/items.js';
import { LEDGER_DOC_ID, readState } from './ledger-store.js';
import { dateOnly } from './model.js';
import { isStoredItem, presentItem } from './services.js';

export const RENEWALS_HREF = '/admin/cost?tab=services';

export async function collectRenewals({ store, from, to, now = () => new Date() }) {
  const doc = await store.readDoc('admin_config', LEDGER_DOC_ID, ADMIN_CONFIG_PARTITION);
  const today = dateOnly(now());
  const rows = readState(doc)
    .items.filter(isStoredItem)
    .map((row) => presentItem(row, today))
    .filter((row) => row.status !== 'cancelled' && row.nextRenewal);
  return rowsInWindow(rows, { from, to }, (row) => row.nextRenewal).map(({ row, when }) =>
    item({
      id: `renewal:${row.id}`,
      kind: 'renewal',
      title: `Renews: ${row.name}`,
      start: when.iso,
      allDay: true,
      status: 'deadline',
      href: RENEWALS_HREF,
      sourceId: row.id,
      sourceCollection: 'admin_config',
      meta: {
        vendor: row.vendor || null,
        amount: row.amount,
        currency: row.currency,
        cycle: row.cycle,
        autoRenew: row.autoRenew,
      },
    })
  );
}
