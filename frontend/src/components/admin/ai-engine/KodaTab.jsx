/**
 * Koda — the AI Engine's agent tab (ADR 0037).
 *
 * Koda is the owner's content agent, run by the Muse service. It reaches the
 * site through the Agent Content API with one key. This tab is the only place
 * that key is made, switched and revoked, and the only place its value is
 * ever shown: once, right after Generate, for the owner to paste into Muse's
 * secure connector page. After that the site holds a hash and shows a hint.
 *
 * Four cards:
 *   1. The key      state, Generate / Rotate, Revoke (super_admin), the
 *                   one-time reveal with Copy
 *   2. What Koda may do   one switch per capability (super_admin)
 *   3. Connect Muse       every value the connector form needs, none secret,
 *                         and the numbered steps
 *   4. What Koda can reach   the endpoints, grouped by capability
 *
 * Role gating is RoleGate's: an editor sees the tab and the state, and the
 * controls say they need super_admin instead of answering with a 403.
 */
import React, { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { useToast } from '@/components/ui/use-toast';
import {
  Bot,
  Copy,
  KeyRound,
  Loader2,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import RoleGate from '@/components/admin/RoleGate';
import ConfirmModal from '@/components/admin/ConfirmModal';
import EmptyState from '@/components/admin/shared/EmptyState';
import useWriteGuard from '@/components/admin/shared/useWriteGuard';
import { kodaApiAddress } from '@/lib/agentContent';
import useKodaKey from './useKodaKey';
import { capabilityRows, connectorValues, endpointGroups, keyState, whenText } from './kodaView';

const WRITE_REASON = 'Making, changing or revoking Koda’s key needs the super_admin role.';

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
 * The one-time reveal. The secret lives in the parent's state and nowhere
 * else; Dismiss drops it. There is no "show again".
 */
export function SecretReveal({ secret, onDismiss }) {
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
      toast({ title: 'Key copied', description: 'Paste it into Muse’s secure field now.' });
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
      aria-label="Koda's new key"
      className="rounded-lg border border-amber-300 bg-amber-50 p-4 space-y-3 dark:bg-amber-900/20 dark:border-amber-700"
    >
      <p className="flex items-start gap-2 text-sm font-medium text-amber-900 dark:text-amber-200">
        <ShieldAlert className="h-4 w-4 mt-0.5 shrink-0" aria-hidden="true" />
        This is the only time the key is shown. Copy it into Muse’s secure connector page now. The
        site keeps a fingerprint, not the key: if it is lost, rotate it.
      </p>
      <code
        data-testid="koda-secret"
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
          I have pasted it, hide the key
        </Button>
      </div>
    </div>
  );
}

function KeyCard({ data, busy, onGenerate, onRevoke, secret, onDismissSecret }) {
  const state = keyState(data.key);
  const [confirm, setConfirm] = useState(null); // 'rotate' | 'revoke' | null
  const generateLabel = data.key.active ? 'Rotate key' : 'Generate key';
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="text-lg flex items-center gap-2">
            <KeyRound className="h-5 w-5" aria-hidden="true" />
            Koda’s key
          </CardTitle>
          <StateBadge state={state} />
        </div>
        <CardDescription>{state.sentence}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {secret && <SecretReveal secret={secret} onDismiss={onDismissSecret} />}
        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 text-sm">
          <div>
            <dt className="text-muted-foreground">Made by</dt>
            <dd>{data.key.createdBy || '—'}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Made</dt>
            <dd>{whenText(data.key.createdAt)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Last rotated</dt>
            <dd>{whenText(data.key.rotatedAt)}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Last used</dt>
            <dd>{whenText(data.key.lastUsedAt)}</dd>
          </div>
        </dl>
        <div className="flex flex-wrap gap-2">
          <RoleGate minRole="super_admin" reason={WRITE_REASON}>
            <Button
              size="sm"
              disabled={busy}
              onClick={() => (data.key.active ? setConfirm('rotate') : onGenerate())}
            >
              {busy ? (
                <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" aria-hidden="true" />
              ) : (
                <RefreshCw className="h-3.5 w-3.5 mr-1" aria-hidden="true" />
              )}
              {generateLabel}
            </Button>
          </RoleGate>
          {data.key.active && (
            <RoleGate minRole="super_admin" reason={WRITE_REASON}>
              <Button
                size="sm"
                variant="destructive"
                disabled={busy}
                onClick={() => setConfirm('revoke')}
              >
                <Trash2 className="h-3.5 w-3.5 mr-1" aria-hidden="true" />
                Revoke key
              </Button>
            </RoleGate>
          )}
        </div>
        <p className="flex items-start gap-2 text-xs text-muted-foreground">
          <ShieldCheck className="h-4 w-4 mt-0.5 shrink-0" aria-hidden="true" />
          <span>
            Rotating or revoking cuts the old key on its very next request; there is no cache in
            front of it. Every refused call is written to the audit log without the key. Drafts Koda
            writes appear on the{' '}
            <Link to="/admin/drafts" className="underline">
              Drafts page
            </Link>{' '}
            with <code>koda (agent)</code> as their author.
          </span>
        </p>
      </CardContent>
      <ConfirmModal
        open={confirm === 'rotate'}
        title="Rotate Koda’s key?"
        description="A new key is made and shown once. The key Muse holds now stops working on its next request, so update Muse straight after."
        confirmLabel="Rotate key"
        busy={busy}
        onConfirm={async () => {
          setConfirm(null);
          await onGenerate();
        }}
        onCancel={() => setConfirm(null)}
      />
      <ConfirmModal
        open={confirm === 'revoke'}
        title="Revoke Koda’s key?"
        description="Koda loses access on its next request. Nothing Koda wrote is changed. Generate a new key here when you want it back."
        confirmLabel="Revoke key"
        busy={busy}
        onConfirm={async () => {
          setConfirm(null);
          await onRevoke();
        }}
        onCancel={() => setConfirm(null)}
      />
    </Card>
  );
}

function CapabilitiesCard({ data, busyIds, onToggle }) {
  const rows = capabilityRows(data.capabilities, data.key.capabilities);
  const disabled = !data.key.present;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">What Koda may do</CardTitle>
        <CardDescription>
          Each switch is a group of endpoints. All are on for a new key. Publishing is not on this
          list and has no endpoint: a draft Koda sends to review is published by a person, on the
          Review board, as every other draft is.
        </CardDescription>
      </CardHeader>
      <CardContent className="divide-y">
        {rows.map((row) => (
          <div key={row.id} className="flex items-start justify-between gap-4 py-3">
            <div className="min-w-0">
              <Label htmlFor={`koda-cap-${row.id}`} className="font-medium">
                {row.label}
              </Label>
              <p className="text-sm text-muted-foreground">{row.description}</p>
            </div>
            <RoleGate minRole="super_admin" reason={WRITE_REASON}>
              <Switch
                id={`koda-cap-${row.id}`}
                checked={row.on}
                disabled={disabled || busyIds.has(row.id)}
                aria-label={row.label}
                onCheckedChange={(on) => onToggle(row.id, on)}
              />
            </RoleGate>
          </div>
        ))}
        {disabled && (
          <p className="pt-3 text-xs text-muted-foreground">
            The switches apply once a key exists.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function ConnectCard({ data }) {
  const address = kodaApiAddress(data.basePath);
  const values = connectorValues(address, data.limits?.requestsPerMinute ?? 120);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Connect Muse to the site</CardTitle>
        <CardDescription>
          Every value the connector form asks for, none of them secret. The key itself goes only
          into Muse’s secure field.
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
        <ol className="list-decimal pl-5 space-y-1 text-sm">
          <li>Press Generate key above and keep this tab open; the key is shown once.</li>
          <li>
            In Muse, add a custom connector with the host and base URL above and API-key
            authentication in the Authorization header as Bearer.
          </li>
          <li>Paste the key into Muse’s secure field, then press “I have pasted it” above.</li>
          <li>
            Let Muse make the first test call. A good answer is <code>200</code> with{' '}
            <code>&quot;agent&quot;: &quot;koda&quot;</code> and the capabilities list;{' '}
            <code>401</code> means the key was pasted wrong, <code>403</code> means the switch for
            that call is off here.
          </li>
          <li>
            Check the card above: “Last used” updates within a few minutes of Koda’s first call.
          </li>
        </ol>
      </CardContent>
    </Card>
  );
}

function ReachCard({ data }) {
  const groups = endpointGroups(data.endpoints, data.capabilities);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">What Koda can reach</CardTitle>
        <CardDescription>
          The whole surface, as the API reports it. Paths are under the base URL. Drafts are the
          same documents the Drafts page edits: the same fields, size cap, version check and audit
          rows. Nothing under <code>/api/cms/</code> accepts the key.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {groups.map((group) => (
          <div key={group.id}>
            <p className="text-sm font-medium">{group.label}</p>
            <ul className="text-sm font-mono text-muted-foreground">
              {group.endpoints.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

export default function KodaTab() {
  const { toast } = useToast();
  const { data, loaded, error, refresh, generate, setCapability, revoke } = useKodaKey();
  const { busyIds, claim, release } = useWriteGuard();
  const [secret, setSecret] = useState(null);

  // Leaving the tab drops the secret; nothing keeps it.
  useEffect(() => () => setSecret(null), []);

  const run = async (id, work, done) => {
    if (!claim(id)) return;
    try {
      const answer = await work();
      done?.(answer);
    } catch (err) {
      toast({
        title: 'Nothing was changed',
        description: err?.message || 'The request failed.',
        variant: 'destructive',
      });
    } finally {
      release(id);
    }
  };

  if (error && !loaded) {
    return (
      <EmptyState
        variant="error"
        title="Koda’s key could not be read"
        description={error}
        onRetry={refresh}
      />
    );
  }
  if (!loaded) {
    return (
      <div className="flex justify-center py-12" role="status" aria-label="Reading Koda's key">
        <Loader2 className="h-6 w-6 animate-spin text-slate-400" />
      </div>
    );
  }

  const busy = busyIds.has('key');
  return (
    <div className="space-y-6">
      <p className="flex items-start gap-2 text-sm text-muted-foreground">
        <Bot className="h-4 w-4 mt-0.5 shrink-0" aria-hidden="true" />
        <span>
          Koda is the content agent that drafts and reviews posts for the series. It signs in with
          the key below and works only on the Drafts stage and the published reads; it cannot
          publish, change settings or read anything else.
        </span>
      </p>
      <KeyCard
        data={data}
        busy={busy}
        secret={secret}
        onDismissSecret={() => setSecret(null)}
        onGenerate={() =>
          run('key', generate, (answer) => {
            setSecret(answer?.secret || null);
            toast({ title: 'Key ready', description: 'Copy it now; it is shown once.' });
          })
        }
        onRevoke={() =>
          run('key', revoke, () => {
            setSecret(null);
            toast({ title: 'Key revoked', description: 'Koda’s next request is refused.' });
          })
        }
      />
      <CapabilitiesCard
        data={data}
        busyIds={busyIds}
        onToggle={(id, on) =>
          run(
            id,
            () => setCapability(id, on),
            () => toast({ title: on ? 'Switched on' : 'Switched off', description: id })
          )
        }
      />
      <ConnectCard data={data} />
      <ReachCard data={data} />
    </div>
  );
}
