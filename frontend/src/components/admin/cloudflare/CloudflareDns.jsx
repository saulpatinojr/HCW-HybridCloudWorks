/**
 * The Cloudflare page's DNS tab (#1905): every DNS record in the zone, and a
 * form to add one or change one. A DNS record is a line in the internet's
 * address book: it says where a name such as `lab.example.com` points.
 *
 * NOTHING HERE DELETES. There is no delete button and no delete route.
 * A record that keeps the site running (the site's own names, the records
 * Terraform manages, certificate checks) is LOCKED: its row shows a lock and
 * the server's reason and offers no edit, and the server refuses a change to
 * it (409) whatever is sent. The add form checks a new name against the same
 * list before sending. A long zone is listed up to the server's page cap,
 * and the tab says so when the server answers `truncated`.
 *
 * Adding and changing need the super admin role (RoleGate); the form's Save
 * is disabled while its request is out.
 */
import React, { useState } from 'react';
import { Loader2, Pencil, Plus } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import RoleGate from '@/components/admin/RoleGate';
import EmptyState from '@/components/admin/shared/EmptyState';
import {
  createCloudflareDnsRecord,
  readCloudflareDns,
  updateCloudflareDnsRecord,
} from '@/lib/cloudflare';
import {
  LockNote,
  ReadGate,
  TD,
  TH,
  WRITE_REASON,
  useCloudflareWrite,
  useCloudflareZone,
  useZoneRead,
} from './CloudflareParts';
import {
  DNS_TYPES,
  PROXIABLE_TYPES,
  dnsDialogCheck,
  dnsForm,
  dnsNameLock,
  editableType,
  ttlText,
} from './cloudflareView';

const EMPTY = Object.freeze({ records: [] });
const SELECT_CLASS =
  'h-9 w-full rounded-md border border-input bg-background px-2 text-sm disabled:opacity-50';

/** A row's lock: the server's own marking first, then the name list. */
function rowLock(record, status) {
  if (record.locked) return record.lockedReason || 'This record keeps the site running.';
  return dnsNameLock(record.name, { status });
}

/** The Proxied column: only the types Cloudflare can proxy have an answer. */
function proxiedText(record) {
  if (!PROXIABLE_TYPES.includes(record.type)) return '—';
  return record.proxied ? 'Yes' : 'No';
}

/** The last column: the lock, a note for a type changed elsewhere, or Change. */
function RowAction({ record, lock, busy, onChange }) {
  if (lock) return <LockNote reason={lock} />;
  if (!editableType(record)) {
    return (
      <span className="text-xs text-muted-foreground">
        A {record.type} record is changed in the Cloudflare dashboard.
      </span>
    );
  }
  return (
    <RoleGate minRole="super_admin" reason={WRITE_REASON}>
      <Button
        size="sm"
        variant="outline"
        disabled={busy}
        onClick={onChange}
        aria-label={`Change ${record.type} ${record.name}`}
      >
        <Pencil className="h-3.5 w-3.5 mr-1" aria-hidden="true" />
        Change
      </Button>
    </RoleGate>
  );
}

/**
 * The add and edit form, in a dialog. `record` is null to add one. The
 * type is chosen when adding and fixed when editing.
 */
function RecordDialog({ open, record, status, busy, onClose, onSave }) {
  const [form, setForm] = useState(() => dnsForm(record));
  const set = (key) => (value) => setForm((current) => ({ ...current, [key]: value }));
  const editing = Boolean(record);
  // The new name must not be a locked one; for an edit, the old one was
  // checked when the row offered the edit at all.
  const { body, problem, nothingChanged } = dnsDialogCheck({ record, form, status });
  const id = editing ? record.id : 'new';

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !busy && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing ? `Change ${record.name}` : 'Add a DNS record'}</DialogTitle>
          <DialogDescription>
            {editing
              ? 'Only the fields you change are sent. The type stays as it is.'
              : 'Type a name without the domain ("lab"), or "@" for the domain itself.'}
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (!problem && !nothingChanged && !busy) onSave(id, body);
          }}
        >
          <div className="grid grid-cols-1 sm:grid-cols-[8rem_1fr] gap-3">
            <div>
              <Label htmlFor="dns-type">Type</Label>
              <select
                id="dns-type"
                className={SELECT_CLASS}
                value={form.type}
                disabled={editing || busy}
                onChange={(event) => set('type')(event.target.value)}
              >
                {(editing && !DNS_TYPES.includes(form.type)
                  ? [form.type, ...DNS_TYPES]
                  : DNS_TYPES
                ).map((type) => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <Label htmlFor="dns-name">Name</Label>
              <Input
                id="dns-name"
                value={form.name}
                disabled={busy}
                onChange={(event) => set('name')(event.target.value)}
              />
            </div>
          </div>
          <div>
            <Label htmlFor="dns-content">Content</Label>
            <Input
              id="dns-content"
              value={form.content}
              disabled={busy}
              onChange={(event) => set('content')(event.target.value)}
            />
            <p className="mt-1 text-xs text-muted-foreground">
              The address (A, AAAA), the name it points to (CNAME, MX) or the text (TXT).
            </p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <Label htmlFor="dns-ttl">TTL (seconds; 1 is Automatic)</Label>
              <Input
                id="dns-ttl"
                inputMode="numeric"
                value={form.ttl}
                disabled={busy}
                onChange={(event) => set('ttl')(event.target.value)}
              />
            </div>
            {form.type === 'MX' && (
              <div>
                <Label htmlFor="dns-priority">Priority</Label>
                <Input
                  id="dns-priority"
                  inputMode="numeric"
                  value={form.priority}
                  disabled={busy}
                  onChange={(event) => set('priority')(event.target.value)}
                />
              </div>
            )}
          </div>
          {PROXIABLE_TYPES.includes(form.type) && (
            <div className="flex items-start gap-2">
              {/* A plain checkbox: inside a form the switch component adds a
                  hidden input of its own, which is one more thing to submit. */}
              <input
                id="dns-proxied"
                type="checkbox"
                className="mt-1 h-4 w-4"
                checked={form.proxied}
                disabled={busy}
                onChange={(event) => set('proxied')(event.target.checked)}
              />
              <Label htmlFor="dns-proxied" className="font-normal text-sm">
                Proxied: visitors go through Cloudflare (orange cloud), which hides the real address
                and caches pages. Off means the name points straight at the address.
              </Label>
            </div>
          )}
          <div>
            <Label htmlFor="dns-comment">Comment (optional, for you)</Label>
            <Input
              id="dns-comment"
              value={form.comment}
              disabled={busy}
              onChange={(event) => set('comment')(event.target.value)}
            />
          </div>
          {problem && (
            <p role="alert" className="text-sm text-destructive">
              {problem}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || Boolean(problem) || nothingChanged}>
              {busy && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" aria-hidden="true" />}
              {editing ? 'Save the change' : 'Add the record'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default function CloudflareDns({ status = null }) {
  const zone = useCloudflareZone();
  const read = useZoneRead(readCloudflareDns, EMPTY);
  const { busyIds, run } = useCloudflareWrite(read.refresh);
  // `{ record: null }` adds; `{ record }` edits; null is closed.
  const [dialog, setDialog] = useState(null);
  const records = read.data?.records ?? [];

  const onSave = async (id, body) => {
    const done =
      id === 'new'
        ? await run(id, () => createCloudflareDnsRecord(body, zone), `${body.name} is added.`)
        : await run(id, () => updateCloudflareDnsRecord(id, body, zone), 'The record is changed.');
    if (done) setDialog(null);
  };

  return (
    <ReadGate read={read} label="The DNS records" status={status}>
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-1.5">
              <CardTitle className="text-lg">DNS records</CardTitle>
              <CardDescription>
                Where each name in the zone points. A locked record keeps the site running and is
                changed only in Terraform. No record can be deleted from this page, and only A,
                AAAA, CNAME, MX and TXT records can be added or changed.
              </CardDescription>
              {read.data?.truncated && (
                <p role="status" className="text-sm text-amber-700 dark:text-amber-400">
                  The zone holds more records than this page lists at once; the list stops at the
                  limit. Find the rest in the Cloudflare dashboard.
                </p>
              )}
            </div>
            <RoleGate minRole="super_admin" reason={WRITE_REASON}>
              <Button size="sm" onClick={() => setDialog({ record: null })}>
                <Plus className="h-3.5 w-3.5 mr-1" aria-hidden="true" />
                Add a record
              </Button>
            </RoleGate>
          </div>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {records.length === 0 ? (
            <EmptyState compact title="The zone has no DNS records yet" />
          ) : (
            <table className="w-full min-w-[44rem]">
              <thead>
                <tr>
                  <th scope="col" className={TH}>
                    Type
                  </th>
                  <th scope="col" className={TH}>
                    Name
                  </th>
                  <th scope="col" className={TH}>
                    Content
                  </th>
                  <th scope="col" className={TH}>
                    Proxied
                  </th>
                  <th scope="col" className={TH}>
                    TTL
                  </th>
                  <th scope="col" className={TH}>
                    <span className="sr-only">Change</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {records.map((record) => {
                  const lock = rowLock(record, status);
                  return (
                    <tr key={record.id} data-testid={`dns-row-${record.id}`}>
                      <td className={`${TD} font-mono text-xs`}>{record.type}</td>
                      <td className={`${TD} [overflow-wrap:anywhere]`}>
                        {record.name}
                        {record.comment ? (
                          <span className="block text-xs text-muted-foreground">
                            {record.comment}
                          </span>
                        ) : null}
                      </td>
                      <td className={`${TD} font-mono text-xs [overflow-wrap:anywhere]`}>
                        {record.content}
                      </td>
                      <td className={TD}>{proxiedText(record)}</td>
                      <td className={`${TD} whitespace-nowrap`}>{ttlText(record.ttl)}</td>
                      <td className={`${TD} min-w-[12rem]`}>
                        <RowAction
                          record={record}
                          lock={lock}
                          busy={busyIds.has(record.id)}
                          onChange={() => setDialog({ record })}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
      {dialog && (
        <RecordDialog
          key={dialog.record?.id ?? 'new'}
          open
          record={dialog.record}
          status={status}
          busy={busyIds.has(dialog.record?.id ?? 'new')}
          onClose={() => setDialog(null)}
          onSave={onSave}
        />
      )}
    </ReadGate>
  );
}
