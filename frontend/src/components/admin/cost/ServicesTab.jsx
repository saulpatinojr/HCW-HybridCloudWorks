/**
 * Services — the ledger of subscriptions the site pays for outside Azure
 * (Cloudflare, ElevenLabs, Publer, the domain and so on): what each costs,
 * when it renews, and whether it renews on its own.
 *
 * Top: the totals. Then the form, which adds one item or, from a row's Edit,
 * changes it in place (the RemindersTab shape). Chips offer the vendors the
 * site is already configured with that are not yet in the ledger; one click
 * pre-fills the form. Below: what renews in the next 30 days and what is
 * overdue, then every item grouped by category. Remove asks once through the
 * shared ConfirmModal.
 *
 * The server validates every field and answers with a sentence; the form
 * shows that sentence and keeps the draft. The monthly figure beside the
 * amount field is the same rule the server applies (lib/cost monthlyEquivalent).
 */
import React, { useMemo, useState } from 'react';
import { CreditCard, ExternalLink, Loader2, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import ConfirmModal from '@/components/admin/ConfirmModal';
import EmptyState from '@/components/admin/shared/EmptyState';
import StatusBadge from '@/components/admin/shared/StatusBadge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import {
  CATEGORIES,
  CYCLES,
  STATUSES,
  categoryLabel,
  cycleLabel,
  fmtUsd,
  monthlyEquivalent,
  renewalLabel,
  statusInfo,
} from '@/lib/cost';
import useCostServices from './useCostServices';
import { DateText, Figure, Figures, Money, SectionCard } from './costShared';

const SELECT_CLASS =
  'flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50';

/** A fresh draft, every editable field present so the form is controlled from the start. */
export const newDraft = (over = {}) => ({
  name: '',
  vendor: '',
  category: 'other',
  plan: '',
  amount: '',
  currency: 'USD',
  cycle: 'monthly',
  nextRenewal: '',
  autoRenew: true,
  status: 'active',
  paymentMethod: '',
  link: '',
  note: '',
  ...over,
});

/** A stored item as the form holds it (strings in the inputs). */
export const draftOf = (item) =>
  newDraft({
    name: item.name ?? '',
    vendor: item.vendor ?? '',
    category: item.category ?? 'other',
    plan: item.plan ?? '',
    amount: item.amount === null || item.amount === undefined ? '' : String(item.amount),
    currency: item.currency ?? 'USD',
    cycle: item.cycle ?? 'monthly',
    nextRenewal: item.nextRenewal ?? '',
    autoRenew: Boolean(item.autoRenew),
    status: item.status ?? 'active',
    paymentMethod: item.paymentMethod ?? '',
    link: item.link ?? '',
    note: item.note ?? '',
  });

/** The draft as the server takes it: trimmed strings, a number or null amount, a date or null. */
export function fieldsOf(draft) {
  const amount = String(draft.amount).trim();
  return {
    name: draft.name.trim(),
    vendor: draft.vendor.trim(),
    category: draft.category,
    plan: draft.plan.trim(),
    amount: amount === '' ? null : Number(amount),
    currency: draft.currency.trim().toUpperCase() || 'USD',
    cycle: draft.cycle,
    nextRenewal: draft.nextRenewal || null,
    autoRenew: Boolean(draft.autoRenew),
    status: draft.status,
    paymentMethod: draft.paymentMethod.trim(),
    link: draft.link.trim(),
    note: draft.note.trim(),
  };
}

function Field({ id, label, children, className = '' }) {
  return (
    <div className={`space-y-1 ${className}`}>
      <Label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </Label>
      {children}
    </div>
  );
}

function Picker({ id, value, options, disabled, onChange }) {
  return (
    <select
      id={id}
      className={SELECT_CLASS}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
    >
      {options.map((option) => (
        <option key={option.id} value={option.id} title={option.help}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

/**
 * The form, for a new item or one being edited. `onSubmit` receives the
 * fields the server takes and resolves true when the save took, which clears
 * a new form or closes an edit; a refusal's sentence shows under the buttons.
 */
export function ServiceForm({ initial, heading, submitLabel, saving, onSubmit, onCancel = null }) {
  const [draft, setDraft] = useState(initial);
  const [problem, setProblem] = useState('');
  const edit = (patch) => setDraft((current) => ({ ...current, ...patch }));
  const amountNumber = Number(String(draft.amount).trim());
  const perMonth = monthlyEquivalent(
    Number.isFinite(amountNumber) ? amountNumber : null,
    draft.cycle
  );
  const id = (field) => `${heading.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${field}`;

  const submit = async (event) => {
    event.preventDefault();
    setProblem('');
    try {
      const taken = await onSubmit(fieldsOf(draft));
      if (taken && !onCancel) setDraft(newDraft());
    } catch (err) {
      setProblem(err?.message || 'The save was refused.');
    }
  };

  return (
    <form
      onSubmit={submit}
      aria-label={heading}
      className="space-y-3 rounded-md border border-border p-3"
    >
      <p className="text-sm font-medium">{heading}</p>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field id={id('name')} label="Name" className="lg:col-span-2">
          <Input
            id={id('name')}
            value={draft.name}
            disabled={saving}
            placeholder="Cloudflare Pro"
            onChange={(e) => edit({ name: e.target.value })}
          />
        </Field>
        <Field id={id('vendor')} label="Vendor">
          <Input
            id={id('vendor')}
            value={draft.vendor}
            disabled={saving}
            onChange={(e) => edit({ vendor: e.target.value })}
          />
        </Field>
        <Field id={id('category')} label="Category">
          <Picker
            id={id('category')}
            value={draft.category}
            options={CATEGORIES}
            disabled={saving}
            onChange={(category) => edit({ category })}
          />
        </Field>
        <Field id={id('plan')} label="Plan">
          <Input
            id={id('plan')}
            value={draft.plan}
            disabled={saving}
            placeholder="Pro, Creator, Business…"
            onChange={(e) => edit({ plan: e.target.value })}
          />
        </Field>
        <Field id={id('amount')} label="Amount">
          <Input
            id={id('amount')}
            type="number"
            min={0}
            step="0.01"
            value={draft.amount}
            disabled={saving}
            placeholder="leave empty if unknown"
            onChange={(e) => edit({ amount: e.target.value })}
          />
        </Field>
        <Field id={id('currency')} label="Currency">
          <Input
            id={id('currency')}
            value={draft.currency}
            disabled={saving}
            maxLength={3}
            className="uppercase"
            onChange={(e) => edit({ currency: e.target.value })}
          />
        </Field>
        <Field id={id('cycle')} label="Billing cycle">
          <Picker
            id={id('cycle')}
            value={draft.cycle}
            options={CYCLES}
            disabled={saving}
            onChange={(cycle) => edit({ cycle })}
          />
        </Field>
        <Field id={id('renewal')} label="Next renewal">
          <Input
            id={id('renewal')}
            type="date"
            value={draft.nextRenewal}
            disabled={saving}
            onChange={(e) => edit({ nextRenewal: e.target.value })}
          />
        </Field>
        <Field id={id('status')} label="Status">
          <Picker
            id={id('status')}
            value={draft.status}
            options={STATUSES}
            disabled={saving}
            onChange={(status) => edit({ status })}
          />
        </Field>
        <Field id={id('payment')} label="Payment method">
          <Input
            id={id('payment')}
            value={draft.paymentMethod}
            disabled={saving}
            placeholder="Card ending 1234 (never the full number)"
            onChange={(e) => edit({ paymentMethod: e.target.value })}
          />
        </Field>
        <div className="flex items-center gap-2 pt-5">
          <Switch
            id={id('auto')}
            checked={draft.autoRenew}
            disabled={saving}
            onCheckedChange={(autoRenew) => edit({ autoRenew })}
          />
          <Label htmlFor={id('auto')} className="text-xs">
            Renews on its own
          </Label>
        </div>
        <Field
          id={id('link')}
          label="Link to the billing page"
          className="sm:col-span-2 lg:col-span-4"
        >
          <Input
            id={id('link')}
            value={draft.link}
            disabled={saving}
            spellCheck={false}
            placeholder="https://"
            className="font-mono text-xs"
            onChange={(e) => edit({ link: e.target.value })}
          />
        </Field>
        <Field id={id('note')} label="Note" className="sm:col-span-2 lg:col-span-4">
          <Textarea
            id={id('note')}
            value={draft.note}
            disabled={saving}
            rows={2}
            placeholder="What it is for, in a line (optional)"
            onChange={(e) => edit({ note: e.target.value })}
          />
        </Field>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">
          {problem ? (
            <span role="alert" className="text-destructive">
              {problem}
            </span>
          ) : (
            `Counts as ${fmtUsd(perMonth)} a month.`
          )}
        </span>
        <span className="flex items-center gap-2">
          {onCancel ? (
            <Button type="button" variant="ghost" size="sm" disabled={saving} onClick={onCancel}>
              Keep as it was
            </Button>
          ) : null}
          <Button type="submit" size="sm" disabled={saving}>
            {saving ? (
              <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            ) : null}
            {!saving && onCancel ? (
              <Pencil className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
            ) : null}
            {!saving && !onCancel ? <Plus className="mr-2 h-3.5 w-3.5" aria-hidden="true" /> : null}
            {submitLabel}
          </Button>
        </span>
      </div>
    </form>
  );
}

/** One ledger row: name, vendor and plan, the figures, the badge, Edit and Remove. */
function ServiceRow({ item, saving, onEdit, onRemove }) {
  const [editing, setEditing] = useState(false);
  if (editing) {
    return (
      <li>
        <ServiceForm
          initial={draftOf(item)}
          heading={`Edit: ${item.name}`}
          submitLabel="Save changes"
          saving={saving}
          onSubmit={async (fields) => {
            const taken = await onEdit(fields);
            if (taken) setEditing(false);
            return taken;
          }}
          onCancel={() => setEditing(false)}
        />
      </li>
    );
  }
  const overdue = Number.isFinite(item.daysUntilRenewal) && item.daysUntilRenewal < 0;
  return (
    <li className="flex flex-wrap items-start gap-3 rounded-md border border-border p-3">
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{item.name}</span>
          <StatusBadge status={statusInfo(item.status)} size="xs" />
          {item.autoRenew ? null : (
            <span className="text-xs text-muted-foreground">does not renew on its own</span>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          {[item.vendor, item.plan].filter(Boolean).join(' · ')}
          {item.vendor || item.plan ? ' · ' : ''}
          {item.amount === null
            ? 'amount unknown'
            : `${fmtUsd(item.amount)} ${cycleLabel(item.cycle).toLowerCase()}`}
          {' · '}
          <Money value={item.monthlyEquivalent} /> a month
          {item.paymentMethod ? ` · ${item.paymentMethod}` : ''}
        </p>
        <p
          className={`text-xs ${overdue ? 'text-rose-700 dark:text-rose-400' : 'text-muted-foreground'}`}
        >
          {item.nextRenewal ? (
            <>
              Renews <DateText value={item.nextRenewal} /> ({renewalLabel(item.daysUntilRenewal)})
            </>
          ) : (
            'No renewal date'
          )}
          {item.link ? (
            <>
              {' · '}
              <a
                href={item.link}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 underline"
              >
                Billing page <ExternalLink className="h-3 w-3" aria-hidden="true" />
              </a>
            </>
          ) : null}
        </p>
        {item.note ? <p className="whitespace-pre-wrap text-sm">{item.note}</p> : null}
      </div>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={saving}
          aria-label={`Edit ${item.name}`}
          onClick={() => setEditing(true)}
        >
          <Pencil className="mr-2 h-3.5 w-3.5" aria-hidden="true" /> Edit
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={saving}
          aria-label={`Remove ${item.name}`}
          onClick={onRemove}
        >
          <Trash2 className="h-3.5 w-3.5 text-destructive" aria-hidden="true" />
        </Button>
      </div>
    </li>
  );
}

function ServiceList({ label, items, saving, onEdit, onRemove }) {
  if (!items.length) return null;
  return (
    <section aria-label={label} className="space-y-2">
      <p className="text-sm font-medium">{label}</p>
      <ul className="space-y-2">
        {items.map((item) => (
          <ServiceRow
            key={item.id}
            item={item}
            saving={saving}
            onEdit={(fields) => onEdit(item.id, fields)}
            onRemove={() => onRemove(item)}
          />
        ))}
      </ul>
    </section>
  );
}

/** Items in the ledger grouped by category, in the categories' own order. */
export function groupByCategory(items) {
  return CATEGORIES.map((category) => ({
    ...category,
    items: items.filter((item) => item.category === category.id),
  })).filter((group) => group.items.length > 0);
}

/**
 * The figures the tab shows from the ledger: per month (active and trial
 * items), renewals in the next 30 days soonest first, overdue active items,
 * and the next renewal. The same rules as the server's summary
 * (functions/src/lib/cost/services.js summarizeServices).
 */
export function ledgerFigures(items) {
  const dated = (item) => Number.isFinite(item.daysUntilRenewal);
  const billing = items.filter((item) => item.status !== 'cancelled');
  const upcoming = billing
    .filter((item) => dated(item) && item.daysUntilRenewal >= 0 && item.daysUntilRenewal <= 30)
    .sort((a, b) => a.daysUntilRenewal - b.daysUntilRenewal);
  return {
    perMonth: billing.reduce((sum, item) => sum + (item.monthlyEquivalent || 0), 0),
    upcoming,
    overdue: items.filter(
      (item) => item.status === 'active' && dated(item) && item.daysUntilRenewal < 0
    ),
    next: upcoming[0] ?? null,
  };
}

/** The four totals at the top; before the ledger has loaded, the summary's figures. */
function LedgerTotals({ ledger, summary, figures }) {
  const { perMonth, next } = figures;
  return (
    <Figures className="rounded-md border border-border p-3">
      <Figure
        label="Per month"
        value={
          <Money
            value={ledger.loaded ? perMonth : (summary?.services?.monthlyEquivalent ?? null)}
          />
        }
        note="active and trial items"
      />
      <Figure
        label="Per year"
        value={
          <Money
            value={
              ledger.loaded
                ? Math.round(perMonth * 1200) / 100
                : (summary?.services?.annualEquivalent ?? null)
            }
          />
        }
      />
      <Figure label="Items" value={ledger.loaded ? String(ledger.items.length) : '…'} />
      <Figure
        label="Next renewal"
        value={next ? next.name : 'none in 30 days'}
        note={next ? renewalLabel(next.daysUntilRenewal) : null}
      />
    </Figures>
  );
}

export default function ServicesTab({ summary, onChanged }) {
  const ledger = useCostServices({ onChanged });
  const { items, saving } = ledger;
  const [removing, setRemoving] = useState(null);
  const [prefill, setPrefill] = useState(null);

  const groups = useMemo(() => groupByCategory(items), [items]);
  const figures = useMemo(() => ledgerFigures(items), [items]);
  const { upcoming, overdue } = figures;

  /** Resolve true when the write took; the form shows the server's sentence otherwise. */
  const add = async (fields) => {
    await ledger.add(fields);
    setPrefill(null);
    return true;
  };
  const edit = async (id, fields) => {
    await ledger.edit(id, fields);
    return true;
  };
  const confirmRemove = async () => {
    const item = removing;
    try {
      await ledger.remove(item.id);
    } finally {
      setRemoving(null);
    }
  };

  if (ledger.error) {
    return (
      <div className="pt-4">
        <EmptyState
          variant="error"
          title="The services ledger could not be read"
          description={ledger.error}
          onRetry={ledger.refresh}
        />
      </div>
    );
  }

  return (
    <div className="space-y-6 pt-4">
      <LedgerTotals ledger={ledger} summary={summary} figures={figures} />

      {ledger.suggestions.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-muted-foreground">
            Configured on the site but not in the ledger yet:
          </span>
          {ledger.suggestions.map((s) => (
            <Button
              key={s.vendor}
              type="button"
              variant="outline"
              size="sm"
              className="h-7 text-xs"
              aria-label={`Add ${s.name}`}
              onClick={() => setPrefill(s)}
            >
              <Plus className="mr-1 h-3 w-3" aria-hidden="true" /> {s.name}
            </Button>
          ))}
        </div>
      ) : null}

      <ServiceForm
        key={prefill ? `prefill-${prefill.vendor}` : 'blank'}
        initial={newDraft(
          prefill
            ? {
                name: prefill.name,
                vendor: prefill.vendor,
                category: prefill.category,
                link: prefill.link || '',
              }
            : {}
        )}
        heading="Add a subscription"
        submitLabel="Add"
        saving={saving}
        onSubmit={add}
      />

      {ledger.loading ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Reading the ledger…
        </p>
      ) : null}

      <ServiceList
        label="Overdue"
        items={overdue}
        saving={saving}
        onEdit={edit}
        onRemove={setRemoving}
      />
      <ServiceList
        label="Renewing in the next 30 days"
        items={upcoming}
        saving={saving}
        onEdit={edit}
        onRemove={setRemoving}
      />

      {ledger.loaded && items.length === 0 ? (
        <EmptyState
          icon={CreditCard}
          title="No subscription recorded yet"
          description="Add the first one above, or press a chip to start from a service the site already uses. Each one appears on the Calendar on its renewal date."
          compact
        />
      ) : null}

      {groups.map((group) => (
        <SectionCard
          key={group.id}
          title={categoryLabel(group.id)}
          description={`${group.items.length} item${group.items.length === 1 ? '' : 's'}, ${fmtUsd(group.items.reduce((sum, item) => sum + (item.status === 'cancelled' ? 0 : item.monthlyEquivalent || 0), 0))} a month.`}
        >
          <ul className="space-y-2">
            {group.items.map((item) => (
              <ServiceRow
                key={item.id}
                item={item}
                saving={saving}
                onEdit={(fields) => edit(item.id, fields)}
                onRemove={() => setRemoving(item)}
              />
            ))}
          </ul>
        </SectionCard>
      ))}

      <p className="text-xs text-muted-foreground">
        Changes here reach the Overview and the Calendar at once.
        <Button
          type="button"
          variant="link"
          size="sm"
          className="h-auto px-1 text-xs"
          onClick={() => ledger.refresh()}
          disabled={saving}
        >
          <RefreshCw className="mr-1 h-3 w-3" aria-hidden="true" /> Re-read the ledger
        </Button>
      </p>

      <ConfirmModal
        open={removing !== null}
        title={removing ? `Remove ${removing.name}?` : 'Remove?'}
        description="It leaves the ledger and the Calendar. This does not cancel the subscription with the vendor."
        confirmLabel="Remove"
        busy={saving}
        busyLabel="Removing…"
        onConfirm={confirmRemove}
        onCancel={() => setRemoving(null)}
      />
    </div>
  );
}
