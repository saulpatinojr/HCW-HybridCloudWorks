/**
 * One expanded sending domain (#504): its DNS records, Verify, and the open
 * and click tracking switches.
 *
 *   GET   cms/mailing-list/domains/{domainId}
 *   POST  cms/mailing-list/domains/{domainId}/verify              publisher
 *   PATCH cms/mailing-list/domains/{domainId}  { open_tracking? , click_tracking? }  publisher
 *
 * The parent keeps each loaded detail, so collapsing and reopening a domain
 * does not ask Resend again, and a detail that arrived with a create is shown
 * without a second read. The writes are shown to everyone and a 403 is shown
 * in the server's words, as on the Audience tab.
 *
 * A PATCH sends only the switch that changed. Resend answers `{ ok, id }`, so
 * the new value is applied to the loaded detail here rather than re-read.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { AlertTriangle, CheckCircle, RefreshCw, ShieldCheck } from 'lucide-react';
import { getJSON, sendJSON } from '@/lib/api';
import { describeResendError } from '../resendFormat';
import { CopyButton, Loading, Notice, RESEND_ROUTE, StatusBadge } from './resendShared';

const domainRoute = (id) => `${RESEND_ROUTE}/domains/${encodeURIComponent(id)}`;

function RecordsTable({ records }) {
  if (!records.length) {
    return <p className="text-sm text-muted-foreground">Resend returned no DNS records.</p>;
  }
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full min-w-[44rem] text-left text-sm">
        <thead>
          <tr className="border-b border-border text-xs text-muted-foreground">
            <th className="py-2 pl-3 pr-3 font-medium">Type</th>
            <th className="py-2 pr-3 font-medium">Name / host</th>
            <th className="py-2 pr-3 font-medium">Value</th>
            <th className="py-2 pr-3 font-medium">Priority</th>
            <th className="py-2 pr-3 font-medium">TTL</th>
            <th className="py-2 pr-3 font-medium">Status</th>
          </tr>
        </thead>
        <tbody>
          {records.map((record, index) => (
            <tr
              key={`${record.record}-${record.type}-${record.name}-${index}`}
              className="border-b border-border align-top last:border-0"
            >
              <td className="py-2 pl-3 pr-3">
                <span className="font-mono text-xs">{record.type || '—'}</span>
                {record.record && (
                  <span className="block text-xs text-muted-foreground">{record.record}</span>
                )}
              </td>
              <td className="py-2 pr-3 font-mono text-xs break-all">{record.name || '—'}</td>
              <td className="py-2 pr-3">
                <span className="block max-w-[18rem] font-mono text-xs break-all">
                  {record.value || '—'}
                </span>
                {record.value && (
                  <CopyButton value={record.value} label={`Copy ${record.type || ''} value`} />
                )}
              </td>
              <td className="py-2 pr-3">{record.priority ?? '—'}</td>
              <td className="py-2 pr-3">{record.ttl ?? '—'}</td>
              <td className="py-2 pr-3">
                <StatusBadge status={record.status} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TrackingSwitch({ id, label, checked, busy, onChange }) {
  return (
    <div className="flex items-center gap-2">
      <Switch id={id} checked={checked} disabled={busy} onCheckedChange={onChange} />
      <label htmlFor={id} className="text-sm">
        {label}
      </label>
    </div>
  );
}

function TrackingControls({ domain, busy, onToggle }) {
  return (
    <div className="space-y-2 rounded-lg border border-border p-3">
      <p className="text-sm font-medium">Tracking</p>
      <div className="flex flex-wrap gap-6">
        <TrackingSwitch
          id={`open-tracking-${domain.id}`}
          label="Open tracking"
          checked={domain.open_tracking === true}
          busy={busy.has('open_tracking')}
          onChange={(value) => onToggle('open_tracking', value)}
        />
        <TrackingSwitch
          id={`click-tracking-${domain.id}`}
          label="Click tracking"
          checked={domain.click_tracking === true}
          busy={busy.has('click_tracking')}
          onChange={(value) => onToggle('click_tracking', value)}
        />
      </div>
      <p className="flex items-start gap-2 text-xs text-amber-700 dark:text-amber-300">
        <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
        <span>
          Open tracking needs the tracking subdomain CNAME
          {domain.tracking_subdomain ? ` (${domain.tracking_subdomain})` : ''} in DNS, and Resend
          recommends open tracking only for broadcasts. Publisher only.
        </span>
      </p>
    </div>
  );
}

function VerifyControls({ verifying, verified, onVerify, onRefresh }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" variant="outline" className="gap-2" disabled={verifying} onClick={onVerify}>
        <ShieldCheck className="h-4 w-4" /> Verify
      </Button>
      {verified && (
        <>
          <span role="status" className="flex items-center gap-1 text-sm text-muted-foreground">
            <CheckCircle className="h-4 w-4" /> Resend is checking the records in the background.
            This can take a few minutes.
          </span>
          <Button size="sm" variant="ghost" className="gap-2" onClick={onRefresh}>
            <RefreshCw className="h-4 w-4" /> Refresh
          </Button>
        </>
      )}
    </div>
  );
}

/** The detail, loaded when absent; `reload` asks Resend again. */
function useDomainDetail(id, domain, onLoaded) {
  const [loading, setLoading] = useState(!domain);
  const [error, setError] = useState('');
  // Only the latest reload may write: an earlier, slower answer is dropped.
  const generation = useRef(0);
  const reload = useCallback(async () => {
    generation.current += 1;
    const mine = generation.current;
    setLoading(true);
    try {
      const res = await getJSON(domainRoute(id));
      if (mine !== generation.current) return;
      setError('');
      if (res?.domain) onLoaded(res.domain);
    } catch (err) {
      if (mine === generation.current) setError(describeResendError(err));
    } finally {
      if (mine === generation.current) setLoading(false);
    }
  }, [id, onLoaded]);
  // Load whenever no full detail is held: on open, after the list's Refresh
  // drops the cached details, and after a create, whose answer carries the
  // records but not the tracking fields (so the switches would guess). The
  // records a create returned stay on screen while that load runs.
  const missing = !domain || typeof domain.open_tracking !== 'boolean';
  useEffect(() => {
    if (!missing) return;
    queueMicrotask(reload);
  }, [missing, reload]);
  return { loading, error, reload };
}

/** Claim `key` for one write; false when that write is already running. */
function claimKey(inFlight, key) {
  if (inFlight.current.has(key)) return false;
  inFlight.current.add(key);
  return true;
}

/** A copy of the set without `key`. */
function withoutKey(set, key) {
  const next = new Set(set);
  next.delete(key);
  return next;
}

/** Verify and the tracking switches: each write runs once at a time and says its error. */
function useDomainWrites(id, onLoaded) {
  const [busy, setBusy] = useState(() => new Set());
  const [verifying, setVerifying] = useState(false);
  const [verified, setVerified] = useState(false);
  const [actionError, setActionError] = useState('');
  // Refs, not state, guard the writes: a double click lands before the
  // re-render that disables the control, and would send the write twice.
  const inFlight = useRef(new Set());

  const verify = async () => {
    if (!claimKey(inFlight, 'verify')) return;
    setVerifying(true);
    setActionError('');
    try {
      await sendJSON(`${domainRoute(id)}/verify`, 'POST');
      setVerified(true);
    } catch (err) {
      setActionError(describeResendError(err));
    } finally {
      inFlight.current.delete('verify');
      setVerifying(false);
    }
  };

  const toggle = async (field, value) => {
    if (!claimKey(inFlight, field)) return;
    setBusy((previous) => new Set(previous).add(field));
    setActionError('');
    try {
      await sendJSON(domainRoute(id), 'PATCH', { [field]: value });
      // Only onto a detail still held: a list Refresh may have dropped it while
      // this write ran, and a lone `{ [field]: value }` would then pass for a
      // domain with no records. The reload that Refresh starts reads the change.
      onLoaded((current) => (current ? { ...current, [field]: value } : current));
    } catch (err) {
      setActionError(describeResendError(err));
    } finally {
      inFlight.current.delete(field);
      setBusy((previous) => withoutKey(previous, field));
    }
  };

  return { busy, verifying, verified, actionError, verify, toggle };
}

export default function DomainDetail({ id, domain, onLoaded }) {
  const detail = useDomainDetail(id, domain, onLoaded);
  const { busy, verifying, verified, actionError, verify, toggle } = useDomainWrites(id, onLoaded);

  if (detail.loading && !domain) return <Loading>Loading DNS records…</Loading>;
  if (!domain)
    return <Notice>{detail.error || 'Resend returned no detail for this domain.'}</Notice>;

  return (
    <div className="space-y-3">
      {detail.error && <Notice>{detail.error}</Notice>}
      <p className="text-xs text-muted-foreground">
        Add these records at the DNS provider (Cloudflare for hybridcloudworks.com), then Verify.
      </p>
      <RecordsTable records={Array.isArray(domain.records) ? domain.records : []} />
      {actionError && <Notice>{actionError}</Notice>}
      <VerifyControls
        verifying={verifying || detail.loading}
        verified={verified}
        onVerify={verify}
        onRefresh={detail.reload}
      />
      <TrackingControls domain={domain} busy={busy} onToggle={toggle} />
    </div>
  );
}
