/**
 * Credentials tab — every credential the site, its workflows and the lab host
 * use, in one register (#1026): where it lives, what uses it, who issues it,
 * how old it is, when it expires and whether anything renews it. Overdue is
 * red.
 *
 * The register, the dates and the states are the API's (`cms/credentials`,
 * functions/src/lib/credentials); the words are credentialsView.js's. This
 * file loads the answer, lays it out by store, and makes the tab's two
 * writes:
 *
 *   Record rotation   for a credential only the owner renews (`recordable`),
 *                     the date it was last rotated: a PUT of
 *                     `{ credentialId, rotatedOn }`, or `rotatedOn: null` to
 *                     clear a mistaken one. That date is what dates a
 *                     credential the site cannot read (a GitHub secret, a
 *                     workspace variable, a file on the lab host), and a Key
 *                     Vault one seeded before the Keys tab recorded writes.
 *   Update reminders  a POST that brings the reminders sheet in line, shown
 *                     when a reminder is not on it yet. The API also does it
 *                     after every recorded rotation and before every daily
 *                     reminders run.
 *
 * Both answer with the whole register, which replaces what is shown, so the
 * row, its state and its reminder line change together.
 *
 * ## Race-safety, as the Keys tab's
 *
 * The read is generation-guarded: only the newest load may set state, nothing
 * sets state after unmount, and a failed load clears the rows rather than
 * leaving dates that are no longer true beside the error. One write at a
 * time: an in-flight ref refuses a second while the first is going.
 *
 * NO VALUE IS SHOWN, OR ASKED FOR. The answer carries names and dates only,
 * and the one input here is a date.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { BellRing, CalendarCheck, RefreshCw, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/use-toast';
import StatusBadge from '@/components/admin/shared/StatusBadge';
import { useAuthReady } from '@/hooks/useAuthReady';
import { getJSON, sendJSON } from '@/lib/api';
import {
  CREDENTIALS_ROUTE,
  CREDENTIAL_STATE,
  RENEWAL_LABELS,
  REMINDERS_SYNC_ROUTE,
  describeAge,
  describeAgeSource,
  describeExpiry,
  describeReminder,
  describeRule,
  describeSync,
  groupByStore,
  remindersOutOfStep,
  rotationDateBounds,
  stateCounts,
  stateOf,
} from './credentialsView';
import { TabError, TabLoading } from './TabNotice';

/** `GET cms/credentials`, generation-guarded; `replace` takes a write's answer. */
export function useCredentialRegister() {
  // Every cms/credentials route is super_admin: a read before the token
  // exists is a guaranteed 401.
  const { authReady } = useAuthReady();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const generation = useRef(0);

  const fetchRegister = useCallback((mine) => {
    const current = () => mine === generation.current;
    return getJSON(CREDENTIALS_ROUTE)
      .then((response) => {
        if (!current()) return;
        setData(response);
        setError(null);
      })
      .catch((err) => {
        if (!current()) return;
        setData(null);
        setError(err?.message ?? 'Could not load the credential register.');
      })
      .finally(() => {
        if (current()) setLoading(false);
      });
  }, []);

  const reload = useCallback(() => {
    if (!authReady) return Promise.resolve();
    const mine = ++generation.current;
    setLoading(true);
    return fetchRegister(mine);
  }, [authReady, fetchRegister]);

  // A write's answer is the newest register: it wins over any load in flight.
  const replace = useCallback((response) => {
    generation.current += 1;
    setData(response);
    setError(null);
    setLoading(false);
  }, []);

  useEffect(() => {
    if (!authReady) return undefined;
    fetchRegister(++generation.current);
    return () => {
      generation.current += 1;
    };
  }, [authReady, fetchRegister]);

  return { data, loading, error, reload, replace };
}

/** The tab's two writes, one at a time. */
function useRegisterWrites(replace) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(null);
  const writing = useRef(false);

  const run = async (key, call, describe) => {
    if (writing.current) return false;
    writing.current = true;
    setBusy(key);
    try {
      const response = await call();
      if (response?.credentials) replace(response);
      toast(describe(response));
      return true;
    } catch (err) {
      toast({
        title: 'Nothing was changed',
        description: err?.message ?? 'The write was refused.',
        variant: 'destructive',
      });
      return false;
    } finally {
      writing.current = false;
      setBusy(null);
    }
  };

  const record = (credential, rotatedOn) =>
    run(
      credential.id,
      () => sendJSON(CREDENTIALS_ROUTE, 'PUT', { credentialId: credential.id, rotatedOn }),
      (response) => ({
        title: rotatedOn
          ? `${credential.name}: rotation recorded for ${rotatedOn}`
          : `${credential.name}: recorded date cleared`,
        description: describeSync(response?.reminders) ?? undefined,
      })
    );

  const syncReminders = () =>
    run(
      'reminders',
      () => sendJSON(REMINDERS_SYNC_ROUTE, 'POST', {}),
      (response) => ({
        title: 'Reminders',
        description: describeSync(response?.reminders) ?? undefined,
      })
    );

  return { busy, record, syncReminders };
}

/** How many credentials are in each state, as the badges above the tables. */
function Counts({ counts }) {
  return (
    <div
      className="flex flex-wrap items-center gap-3 rounded-lg border bg-muted/30 px-4 py-3 text-sm"
      data-testid="credential-counts"
    >
      {stateCounts(counts).map(({ state, count }) => (
        <span key={state} className="flex items-center gap-2">
          <StatusBadge status={CREDENTIAL_STATE[state]} size="xs" />
          {count}
        </span>
      ))}
    </div>
  );
}

/**
 * The inline form under a row: the date it was rotated, at most the API's
 * own bound (rotationDateBounds). It opens on the date already recorded when
 * there is one, so the stored record is what the form shows, and on this
 * browser's day otherwise.
 */
function RecordForm({ credential, busy, onSave, onClear, onCancel }) {
  const [bounds] = useState(() => rotationDateBounds());
  const [date, setDate] = useState(() => credential.recordedOn ?? bounds.initial);
  const submit = (event) => {
    event.preventDefault();
    if (date) onSave(date);
  };
  return (
    <form onSubmit={submit} className="flex flex-wrap items-center gap-2 py-1">
      <label className="flex items-center gap-2 text-xs">
        <span>Rotated on</span>
        <input
          type="date"
          className="h-8 rounded-md border border-input bg-background px-2 text-xs"
          aria-label={`Rotation date for ${credential.name}`}
          value={date}
          max={bounds.max}
          onChange={(event) => setDate(event.target.value)}
          required
        />
      </label>
      <Button type="submit" size="sm" disabled={busy || !date}>
        Save
      </Button>
      {credential.recordedOn ? (
        <Button type="button" size="sm" variant="outline" disabled={busy} onClick={onClear}>
          Clear recorded date
        </Button>
      ) : null}
      <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
        Cancel
      </Button>
      {credential.rotate ? (
        <p className="basis-full text-xs text-muted-foreground">{credential.rotate}</p>
      ) : null}
    </form>
  );
}

const COLUMNS = ['Credential', 'Used by', 'Issuer', 'Age', 'Expiry', 'Renews', 'State', ''];

function CredentialRow({ credential, editing, busy, onEdit, onSave, onClear, onCancel }) {
  const overdue = credential.state === 'overdue';
  const expiry = describeExpiry(credential);
  const ageSource = describeAgeSource(credential);
  const rule = describeRule(credential);
  const reminder = describeReminder(credential);
  return (
    <>
      <tr
        className={`border-t border-border/60 align-top ${overdue ? 'bg-rose-50 dark:bg-rose-950/30' : ''}`}
        data-testid="credential-row"
        data-state={credential.state}
      >
        <th scope="row" className="px-3 py-2 font-medium">
          <span className="font-mono break-all">{credential.name}</span>
          {reminder ? (
            <span
              className={`mt-1 flex items-center gap-1 text-xs font-normal ${reminder.inStep === false ? 'text-amber-700 dark:text-amber-400' : 'text-muted-foreground'}`}
            >
              <BellRing className="h-3 w-3 shrink-0" aria-hidden="true" />
              {reminder.text}
            </span>
          ) : null}
        </th>
        <td className="px-3 py-2 text-muted-foreground">{credential.consumer}</td>
        <td className="px-3 py-2">{credential.issuer}</td>
        <td className="px-3 py-2 whitespace-nowrap">
          {describeAge(credential)}
          {ageSource ? (
            <span className="block text-xs text-muted-foreground">{ageSource}</span>
          ) : null}
        </td>
        <td
          className={`px-3 py-2 whitespace-nowrap ${overdue ? 'font-medium text-destructive' : ''}`}
        >
          {expiry.text}
          {expiry.kind ? (
            <span className="block text-xs font-normal text-muted-foreground">{expiry.kind}</span>
          ) : null}
        </td>
        <td className="px-3 py-2 whitespace-nowrap">
          {RENEWAL_LABELS[credential.renewal] ?? credential.renewal}
          {rule ? <span className="block text-xs text-muted-foreground">{rule}</span> : null}
        </td>
        <td className="px-3 py-2">
          <StatusBadge status={stateOf(credential)} size="xs" />
          <span className="mt-1 block text-xs text-muted-foreground">{credential.reason}</span>
        </td>
        <td className="px-3 py-2 text-right">
          {credential.recordable && !editing ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={onEdit}
              aria-label={`Record rotation of ${credential.name}`}
            >
              <CalendarCheck className="mr-1.5 h-3.5 w-3.5" /> Record
            </Button>
          ) : null}
        </td>
      </tr>
      {editing ? (
        <tr className="border-t border-border/30 bg-muted/20">
          <td colSpan={COLUMNS.length} className="px-3 py-2">
            <RecordForm
              credential={credential}
              busy={busy}
              onSave={onSave}
              onClear={onClear}
              onCancel={onCancel}
            />
          </td>
        </tr>
      ) : null}
    </>
  );
}

function StoreGroup({ group, editingId, busy, setEditingId, record }) {
  const finish = (rotatedOn, credential) =>
    record(credential, rotatedOn).then((ok) => {
      if (ok) setEditingId(null);
    });
  return (
    <section className="space-y-2" aria-label={group.store.label}>
      <h2 className="text-lg font-semibold">{group.store.label}</h2>
      <div className="overflow-x-auto rounded-md border border-border/60">
        <table className="w-full text-left text-xs">
          <thead className="bg-muted/30 text-muted-foreground">
            <tr>
              {COLUMNS.map((column, index) => (
                <th key={column || index} scope="col" className="px-3 py-2 font-medium">
                  {column || <span className="sr-only">Actions</span>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {group.credentials.map((credential) => (
              <CredentialRow
                key={credential.id}
                credential={credential}
                editing={editingId === credential.id}
                busy={busy !== null}
                onEdit={() => setEditingId(credential.id)}
                onSave={(date) => finish(date, credential)}
                onClear={() => finish(null, credential)}
                onCancel={() => setEditingId(null)}
              />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Unavailable({ sources }) {
  if (!sources?.length) return null;
  return (
    <div
      role="status"
      className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200"
    >
      Some dates could not be read: {sources.map((source) => source.label).join('; ')}. The
      credentials that depend on them show Unknown until a refresh reads them.
    </div>
  );
}

function RemindersNotice({ count, busy, onSync }) {
  if (!count) return null;
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">
      <BellRing className="h-4 w-4 shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1">
        {count === 1 ? '1 reminder is' : `${count} reminders are`} not on the reminders sheet yet.
        The daily reminders run adds them before it says anything; Update reminders adds them now.
      </span>
      <Button size="sm" variant="outline" disabled={busy} onClick={onSync}>
        Update reminders
      </Button>
    </div>
  );
}

export default function IntegrationsCredentials() {
  const { data, loading, error, reload, replace } = useCredentialRegister();
  const { busy, record, syncReminders } = useRegisterWrites(replace);
  const [storeFilter, setStoreFilter] = useState('all');
  const [editingId, setEditingId] = useState(null);

  const stores = data?.stores ?? [];
  const groups = groupByStore(data?.credentials ?? [], stores, storeFilter);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <p className="max-w-2xl text-sm text-muted-foreground">
          Every credential the site, its workflows and the lab host use: where it lives, what uses
          it, who issues it, how old it is, when it expires and whether anything renews it. Each one
          only you can renew on a schedule gets a reminder on Telegram, through Platform Settings →
          Reminders: to rotate it when its date is known, and to record that date until it is.
        </p>
        <div className="flex items-center gap-2">
          <select
            className="h-8 rounded-md border border-input bg-background px-2 text-xs"
            aria-label="Show credentials from"
            value={storeFilter}
            onChange={(event) => setStoreFilter(event.target.value)}
          >
            <option value="all">All stores</option>
            {stores.map((store) => (
              <option key={store.id} value={store.id}>
                {store.label}
              </option>
            ))}
          </select>
          <Button variant="outline" size="sm" onClick={reload}>
            <RefreshCw className="mr-2 h-3.5 w-3.5" /> Refresh
          </Button>
        </div>
      </div>

      {loading && !data ? <TabLoading>Reading the credential register…</TabLoading> : null}
      <TabError message={error} onRetry={reload} />

      {data ? <Counts counts={data.counts} /> : null}
      <Unavailable sources={data?.unavailable} />
      <RemindersNotice
        count={remindersOutOfStep(data?.credentials)}
        busy={busy !== null}
        onSync={syncReminders}
      />

      {groups.map((group) => (
        <StoreGroup
          key={group.store.id}
          group={group}
          editingId={editingId}
          busy={busy}
          setEditingId={setEditingId}
          record={record}
        />
      ))}

      {data ? (
        <p className="flex items-start gap-2 text-xs text-muted-foreground">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Names and dates only: no value is read, stored or shown here. A Key Vault secret’s age
            is its last write on the Keys tab; the Coder tokens’ dates are what the lab host
            reports; for a credential the site cannot read, Record sets the date it was last
            rotated, and its reminder turns from “record the date” into “rotate it” at the next due
            date.
          </span>
        </p>
      ) : null}
    </div>
  );
}
