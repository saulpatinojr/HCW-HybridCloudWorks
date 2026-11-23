/**
 * Developer API — the AI Engine's organizer-key tab (ADR 0042).
 *
 * Event organizers reach the site's Developer API (`/api/developer/v1`) with
 * a key of their own. This tab is the only place those keys are made,
 * re-scoped, rotated and revoked, and the only place a key's value is ever
 * shown: once, right after Make or Rotate, for the owner to hand to the
 * organizer through a secure channel. After that the site holds a hash and
 * shows a hint. Modelled on the Koda tab (KodaTab.jsx, ADR 0037), which does
 * the same for Koda's single key.
 *
 * Four cards:
 *   1. Make a key       organizer name, contact, scopes; Make (super_admin)
 *   2. Organizer keys   one row per key: state, scopes (switches), details,
 *                       Rotate / Revoke, or Make a new key once revoked
 *   3. Connect          the base URL and header an organizer needs, none
 *                       secret, and the plain rule that no key publishes
 *   4. What a key can reach   the endpoints and who may call each
 *
 * Role gating is RoleGate's: an editor sees the tab and the list, and the
 * controls say they need super_admin instead of answering with a 403.
 */
import React, { useEffect, useState } from 'react';
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { useToast } from '@/components/ui/use-toast';
import {
  Copy,
  KeyRound,
  Loader2,
  Pencil,
  Plug,
  Plus,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import RoleGate from '@/components/admin/RoleGate';
import ConfirmModal from '@/components/admin/ConfirmModal';
import EmptyState from '@/components/admin/shared/EmptyState';
import useWriteGuard from '@/components/admin/shared/useWriteGuard';
import { kodaApiAddress as apiAddress } from '@/lib/agentContent';
import useDeveloperKeys from './useDeveloperKeys';
import {
  MAX_ORGANIZER_CONTACT,
  MAX_ORGANIZER_NAME,
  connectionValues,
  endpointRows,
  keyState,
  newKeyProblem,
  orderKeys,
  scopeRows,
  scopeText,
  whenText,
  withScope,
} from './developerApiView';

const WRITE_REASON = 'Making, changing or revoking organizer keys needs the super_admin role.';

const TONE = {
  ok: 'bg-emerald-100 text-emerald-700 border-emerald-200',
  danger: 'bg-red-100 text-red-700 border-red-200',
  muted: 'bg-slate-100 text-slate-500 border-slate-200',
};

function StateBadge({ state }) {
  return (
    <span className={`text-xs font-medium px-2 py-0.5 rounded-full border ${TONE[state.tone]}`}>
      {state.label}
    </span>
  );
}

/**
 * The one-time reveal. The secret lives in the tab's state and nowhere else;
 * the hide button drops it. There is no "show again".
 */
export function DeveloperSecretReveal({ secret, organizerName, onDismiss }) {
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
      toast({
        title: 'Key copied',
        description: 'Send it to the organizer through a secure channel.',
      });
    } catch {
      toast({
        title: 'Could not copy',
        description: 'Select the key and copy it by hand.',
        variant: 'destructive',
      });
    }
  };
  return (
    <div
      role="region"
      aria-label="The organizer's new key"
      className="rounded-lg border border-amber-300 bg-amber-50 p-4 space-y-3 dark:bg-amber-900/20 dark:border-amber-700"
    >
      <p className="flex items-start gap-2 text-sm font-medium text-amber-900 dark:text-amber-200">
        <ShieldAlert className="h-4 w-4 mt-0.5 shrink-0" aria-hidden="true" />
        <span>
          The new key for {organizerName || 'this organizer'}. This is the only time it is shown.
          Copy it and hand it over through a secure channel (a password manager share, not plain
          email or chat). The site keeps a fingerprint, not the key: if it is lost, rotate it.
        </span>
      </p>
      <code
        data-testid="developer-secret"
        className="block break-all rounded bg-white px-3 py-2 text-sm font-mono dark:bg-slate-900"
      >
        {secret}
      </code>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={copy}>
          <Copy className="h-3.5 w-3.5 mr-1" aria-hidden="true" />
          {copied ? 'Copied' : 'Copy key'}
        </Button>
        <Button size="sm" variant="outline" onClick={onDismiss}>
          I have handed it over, hide the key
        </Button>
      </div>
    </div>
  );
}

/** One switch per scope, shared by the Make form and each key's row. */
function ScopeSwitches({ idPrefix, rows, disabledIds, onToggle }) {
  return (
    <div className="divide-y">
      {rows.map((row) => (
        <div key={row.id} className="flex items-start justify-between gap-4 py-2">
          <div className="min-w-0">
            <Label htmlFor={`${idPrefix}-${row.id}`} className="font-medium">
              {row.label}
            </Label>
            <p className="text-xs text-muted-foreground">{row.description}</p>
          </div>
          <RoleGate minRole="super_admin" reason={WRITE_REASON}>
            <Switch
              id={`${idPrefix}-${row.id}`}
              checked={row.on}
              disabled={disabledIds?.has(row.id)}
              aria-label={row.label}
              onCheckedChange={(on) => onToggle(row.id, on)}
            />
          </RoleGate>
        </div>
      ))}
    </div>
  );
}

const BLANK = { organizerName: '', organizerContact: '', scopes: [] };

function NewKeyCard({ catalogue, busy, onCreate }) {
  const [form, setForm] = useState(BLANK);
  const [tried, setTried] = useState(false);
  const problem = newKeyProblem(form);
  const submit = async () => {
    setTried(true);
    if (problem) return;
    const made = await onCreate({
      organizerName: form.organizerName.trim(),
      organizerContact: form.organizerContact.trim() || null,
      scopes: form.scopes,
    });
    if (made) {
      setForm(BLANK);
      setTried(false);
    }
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg flex items-center gap-2">
          <Plus className="h-5 w-5" aria-hidden="true" />
          Make a key for an organizer
        </CardTitle>
        <CardDescription>
          One key per organizer. Give it only what they need; you can change this later without
          giving them a new key.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {/* A div, not a form: a Radix Switch inside a form adds a hidden input
            for native form posts, which this card never makes. */}
        <div className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1">
              <Label htmlFor="developer-new-name">Organizer name</Label>
              <Input
                id="developer-new-name"
                value={form.organizerName}
                maxLength={MAX_ORGANIZER_NAME}
                onChange={(e) => setForm((f) => ({ ...f, organizerName: e.target.value }))}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="developer-new-contact">Contact (optional, only you see it)</Label>
              <Input
                id="developer-new-contact"
                value={form.organizerContact}
                maxLength={MAX_ORGANIZER_CONTACT}
                onChange={(e) => setForm((f) => ({ ...f, organizerContact: e.target.value }))}
              />
            </div>
          </div>
          <div>
            <p className="text-sm font-medium">What the key may do</p>
            <ScopeSwitches
              idPrefix="developer-new-scope"
              rows={scopeRows(catalogue, form.scopes)}
              onToggle={(id, on) =>
                setForm((f) => ({ ...f, scopes: withScope(f.scopes, id, on, catalogue) }))
              }
            />
          </div>
          {tried && problem && (
            <p role="alert" className="text-sm text-red-600">
              {problem}
            </p>
          )}
          <RoleGate minRole="super_admin" reason={WRITE_REASON}>
            <Button size="sm" disabled={busy} onClick={submit}>
              {busy ? (
                <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" aria-hidden="true" />
              ) : (
                <KeyRound className="h-3.5 w-3.5 mr-1" aria-hidden="true" />
              )}
              Make key
            </Button>
          </RoleGate>
        </div>
      </CardContent>
    </Card>
  );
}

/** The organizer's name and contact, read or edited in place. */
function DetailsEditor({ keyRecord, busy, onSave }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(keyRecord.organizerName || '');
  const [contact, setContact] = useState(keyRecord.organizerContact || '');
  const id = keyRecord.keyId;
  if (!editing) {
    return (
      <RoleGate minRole="super_admin" reason={WRITE_REASON}>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => {
            setName(keyRecord.organizerName || '');
            setContact(keyRecord.organizerContact || '');
            setEditing(true);
          }}
        >
          <Pencil className="h-3.5 w-3.5 mr-1" aria-hidden="true" />
          Edit name or contact
        </Button>
      </RoleGate>
    );
  }
  const trimmed = name.trim();
  return (
    <div className="w-full grid grid-cols-1 sm:grid-cols-[1fr_1fr_auto] gap-2 items-end">
      <div className="space-y-1">
        <Label htmlFor={`developer-name-${id}`}>Organizer name</Label>
        <Input
          id={`developer-name-${id}`}
          value={name}
          maxLength={MAX_ORGANIZER_NAME}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor={`developer-contact-${id}`}>Contact</Label>
        <Input
          id={`developer-contact-${id}`}
          value={contact}
          maxLength={MAX_ORGANIZER_CONTACT}
          onChange={(e) => setContact(e.target.value)}
        />
      </div>
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={busy || !trimmed}
          onClick={async () => {
            const saved = await onSave({
              organizerName: trimmed,
              organizerContact: contact.trim() || null,
            });
            if (saved) setEditing(false);
          }}
        >
          Save
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => setEditing(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function KeyRow({ keyRecord, catalogue, busy, onScopes, onDetails, onRotate, onRevoke, onRekey }) {
  const state = keyState(keyRecord);
  const scopes = keyRecord.scopes || [];
  // While a write runs every switch waits; otherwise the last scope on cannot
  // be switched off, because the API refuses an empty scope list.
  let locked = new Set(scopes.length === 1 ? scopes : []);
  if (busy) locked = new Set(catalogue.map((s) => s.id));
  const name = keyRecord.organizerName || 'Unnamed organizer';
  return (
    <li className="py-4 space-y-3" aria-label={`Key for ${name}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium">{name}</p>
          {keyRecord.organizerContact && (
            <p className="text-sm text-muted-foreground break-all">{keyRecord.organizerContact}</p>
          )}
          <p className="text-sm text-muted-foreground">{state.sentence}</p>
        </div>
        <StateBadge state={state} />
      </div>
      <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1 text-sm">
        <div>
          <dt className="inline text-muted-foreground">Made by </dt>
          <dd className="inline">{keyRecord.createdBy || '—'}</dd>
        </div>
        <div>
          <dt className="inline text-muted-foreground">Made </dt>
          <dd className="inline">{whenText(keyRecord.createdAt)}</dd>
        </div>
        <div>
          <dt className="inline text-muted-foreground">Last rotated </dt>
          <dd className="inline">{whenText(keyRecord.rotatedAt)}</dd>
        </div>
        <div>
          <dt className="inline text-muted-foreground">Last used </dt>
          <dd className="inline">{whenText(keyRecord.lastUsedAt)}</dd>
        </div>
      </dl>
      {keyRecord.active ? (
        <>
          <ScopeSwitches
            idPrefix={`developer-scope-${keyRecord.keyId}`}
            rows={scopeRows(catalogue, scopes)}
            disabledIds={locked}
            onToggle={(id, on) => onScopes(withScope(scopes, id, on, catalogue))}
          />
          {scopes.length === 1 && (
            <p className="text-xs text-muted-foreground">
              A key needs at least one scope. To stop it doing anything, revoke it.
            </p>
          )}
        </>
      ) : (
        <p className="text-sm text-muted-foreground">Could do: {scopeText(scopes, catalogue)}</p>
      )}
      <div className="flex flex-wrap gap-2">
        <DetailsEditor keyRecord={keyRecord} busy={busy} onSave={onDetails} />
        {keyRecord.active ? (
          <>
            <RoleGate minRole="super_admin" reason={WRITE_REASON}>
              <Button size="sm" disabled={busy} onClick={onRotate}>
                <RefreshCw className="h-3.5 w-3.5 mr-1" aria-hidden="true" />
                Rotate key
              </Button>
            </RoleGate>
            <RoleGate minRole="super_admin" reason={WRITE_REASON}>
              <Button size="sm" variant="destructive" disabled={busy} onClick={onRevoke}>
                <Trash2 className="h-3.5 w-3.5 mr-1" aria-hidden="true" />
                Revoke key
              </Button>
            </RoleGate>
          </>
        ) : (
          <RoleGate minRole="super_admin" reason={WRITE_REASON}>
            <Button size="sm" disabled={busy} onClick={onRekey}>
              <KeyRound className="h-3.5 w-3.5 mr-1" aria-hidden="true" />
              Make a new key
            </Button>
          </RoleGate>
        )}
      </div>
    </li>
  );
}

function KeysCard({ data, busyIds, handlers }) {
  const keys = orderKeys(data.keys);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg flex items-center gap-2">
          <KeyRound className="h-5 w-5" aria-hidden="true" />
          Organizer keys
        </CardTitle>
        <CardDescription>
          Every key made here, active first. A scope switched off here applies on the key’s very
          next request; the organizer keeps the same key.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {keys.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No organizer keys yet. Make one above when an organizer asks for access.
          </p>
        ) : (
          <ul className="divide-y">
            {keys.map((k) => (
              <KeyRow
                key={k.keyId}
                keyRecord={k}
                catalogue={data.scopes || []}
                busy={busyIds.has(`key:${k.keyId}`)}
                onScopes={(scopes) => handlers.scopes(k, scopes)}
                onDetails={(change) => handlers.details(k, change)}
                onRotate={() => handlers.confirm('rotate', k)}
                onRevoke={() => handlers.confirm('revoke', k)}
                onRekey={() => handlers.rekey(k)}
              />
            ))}
          </ul>
        )}
        <p className="mt-4 flex items-start gap-2 text-xs text-muted-foreground">
          <ShieldCheck className="h-4 w-4 mt-0.5 shrink-0" aria-hidden="true" />
          <span>
            Rotating or revoking cuts the old key on its very next request; there is no cache in
            front of it. Every change here is written to the audit log with the key’s hint, never
            the key.
          </span>
        </p>
      </CardContent>
    </Card>
  );
}

function ConnectCard({ data }) {
  const address = apiAddress(data.basePath);
  const values = connectionValues(address, data.limits);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg flex items-center gap-2">
          <Plug className="h-5 w-5" aria-hidden="true" />
          What to send an organizer
        </CardTitle>
        <CardDescription>
          Everything an organizer needs besides the key, none of it secret. Send the key on its own,
          through a secure channel.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <dl className="space-y-2 text-sm">
          {values.map((row) => (
            <div key={row.field} className="grid grid-cols-1 sm:grid-cols-[10rem_1fr] gap-x-4">
              <dt className="text-muted-foreground">{row.field}</dt>
              <dd>
                <code className="break-all">{row.value}</code>
                <span className="block text-xs text-muted-foreground">{row.note}</span>
              </dd>
            </div>
          ))}
        </dl>
        <p className="flex items-start gap-2 text-sm">
          <ShieldCheck className="h-4 w-4 mt-0.5 shrink-0" aria-hidden="true" />
          <span>
            No key can publish anything. Events and talks an organizer sends stay as drafts until a
            person publishes them here in the admin; no scope can change that.
          </span>
        </p>
      </CardContent>
    </Card>
  );
}

function ReachCard({ data }) {
  const rows = endpointRows(data.endpoints, data.scopes || []);
  if (rows.length === 0) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">What a key can reach</CardTitle>
        <CardDescription>
          The Developer API, as it reports itself. Paths are under the base URL above.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="space-y-1 text-sm">
          {rows.map((row) => (
            <li key={row.line} className="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-x-4">
              <span className="font-mono text-muted-foreground break-all">{row.line}</span>
              <span>{row.who}</span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

export default function DeveloperApiTab() {
  const { toast } = useToast();
  const { data, loaded, error, refresh, create, rotate, update, revoke } = useDeveloperKeys();
  const { busyIds, claim, release } = useWriteGuard();
  // { secret, organizerName, keyId } for the one reveal, or null.
  const [reveal, setReveal] = useState(null);
  // { kind: 'rotate' | 'revoke', key } while a confirmation is open.
  const [confirm, setConfirm] = useState(null);

  // Leaving the tab drops the secret; nothing keeps it.
  useEffect(() => () => setReveal(null), []);

  // A write that landed but whose re-read failed is still a write that
  // landed: `done` runs with the answer (for Make and Rotate, the only copy
  // of the key), and a second toast says the list may be stale. Resolves
  // true when the write landed.
  const run = async (id, work, done) => {
    if (!claim(id)) return false;
    try {
      const { answer, refreshed } = await work();
      done?.(answer);
      if (!refreshed) {
        toast({
          title: 'Saved, but the list could not be re-read',
          description: 'Reload the tab to see the current state.',
        });
      }
      return true;
    } catch (err) {
      toast({
        title: 'Nothing was changed',
        description: err?.message || 'The request failed.',
        variant: 'destructive',
      });
      return false;
    } finally {
      release(id);
    }
  };

  const showSecret = (answer, fallbackName) => {
    setReveal(
      answer?.secret
        ? {
            secret: answer.secret,
            organizerName: answer?.key?.organizerName || fallbackName,
            keyId: answer?.key?.keyId || null,
          }
        : null
    );
    toast({ title: 'Key ready', description: 'Copy it now; it is shown once.' });
  };

  const handlers = {
    confirm: (kind, key) => setConfirm({ kind, key }),
    rotate: (key) =>
      run(
        `key:${key.keyId}`,
        () => rotate(key.keyId),
        (answer) => showSecret(answer, key.organizerName)
      ),
    // A revoked key stays revoked (the API refuses to rotate it): a new key is
    // made for the same organizer, with the same scopes, under a new key id.
    rekey: (key) =>
      run(
        `key:${key.keyId}`,
        () =>
          create({
            organizerName: key.organizerName,
            organizerContact: key.organizerContact || '',
            scopes: key.scopes,
          }),
        (answer) => showSecret(answer, key.organizerName)
      ),
    scopes: (key, scopes) =>
      run(
        `key:${key.keyId}`,
        () => update(key.keyId, { scopes }),
        () => toast({ title: 'Scopes saved', description: key.organizerName || '' })
      ),
    details: (key, change) =>
      run(
        `key:${key.keyId}`,
        () => update(key.keyId, change),
        () => toast({ title: 'Details saved', description: change.organizerName })
      ),
  };

  const secretBox = reveal && (
    <DeveloperSecretReveal
      secret={reveal.secret}
      organizerName={reveal.organizerName}
      onDismiss={() => setReveal(null)}
    />
  );

  // A failed read never hides a key that was just made: the reveal, with its
  // only copy of the secret, stays above the error until the owner dismisses it.
  if (error && !loaded) {
    return (
      <div className="space-y-6">
        {secretBox}
        <EmptyState
          variant="error"
          title="The organizer keys could not be read"
          description={error}
          onRetry={refresh}
        />
      </div>
    );
  }
  if (!loaded) {
    return (
      <div className="flex justify-center py-12" role="status" aria-label="Reading organizer keys">
        <Loader2 className="h-6 w-6 animate-spin text-slate-400" />
      </div>
    );
  }

  const confirmKey = confirm?.key;
  const confirmName = confirmKey?.organizerName || 'this organizer';
  const confirmBusy = confirmKey ? busyIds.has(`key:${confirmKey.keyId}`) : false;
  return (
    <div className="space-y-6">
      <p className="flex items-start gap-2 text-sm text-muted-foreground">
        <Plug className="h-4 w-4 mt-0.5 shrink-0" aria-hidden="true" />
        <span>
          The Developer API lets event organizers manage their calls for speakers (and, later, their
          events) from their own code. Each organizer gets their own key, made here. A key can only
          do what its scopes allow, and no key can publish anything: publishing stays here in the
          admin.
        </span>
      </p>
      {secretBox}
      <NewKeyCard
        catalogue={data.scopes || []}
        busy={busyIds.has('create')}
        onCreate={(organizer) =>
          run(
            'create',
            () => create(organizer),
            (answer) => showSecret(answer, organizer.organizerName)
          )
        }
      />
      <KeysCard data={data} busyIds={busyIds} handlers={handlers} />
      <ConnectCard data={data} />
      <ReachCard data={data} />
      <ConfirmModal
        open={confirm?.kind === 'rotate'}
        title={`Rotate ${confirmName}’s key?`}
        description="A new key is made and shown once. The key the organizer holds now stops working straight away, on its very next request, so send them the new one right after."
        confirmLabel="Rotate key"
        busy={confirmBusy}
        onConfirm={async () => {
          const key = confirmKey;
          setConfirm(null);
          await handlers.rotate(key);
        }}
        onCancel={() => setConfirm(null)}
      />
      <ConfirmModal
        open={confirm?.kind === 'revoke'}
        title={`Revoke ${confirmName}’s key?`}
        description="The organizer loses access on their next request. Nothing they sent is deleted. You can give them a new key later with Make a new key."
        confirmLabel="Revoke key"
        busy={confirmBusy}
        onConfirm={async () => {
          const key = confirmKey;
          setConfirm(null);
          await run(
            `key:${key.keyId}`,
            () => revoke(key.keyId),
            () => {
              setReveal((current) => (current?.keyId === key.keyId ? null : current));
              toast({
                title: 'Key revoked',
                description: `${key.organizerName || 'The organizer'}’s next request is refused.`,
              });
            }
          );
        }}
        onCancel={() => setConfirm(null)}
      />
    </div>
  );
}
