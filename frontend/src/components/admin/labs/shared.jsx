/**
 * The pieces more than one Labs tab renders (#577).
 */
import React from 'react';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Server } from 'lucide-react';
import { isAgentOnline, toMillis } from '@/lib/labsPolling';
import { STATUS_STYLES, formatTime } from './labsView';

export function StatusBadge({ status }) {
  return (
    <Badge
      variant="outline"
      className={`text-[10px] capitalize ${STATUS_STYLES[status] || STATUS_STYLES.cancelled}`}
    >
      {status}
    </Badge>
  );
}

/**
 * Only a literal `false`: a snapshot from an API older than #740 carries no
 * `active` at all, and that agent is not known to be deactivated.
 */
function DeactivatedBadge({ active }) {
  if (active !== false) return null;
  return (
    <Badge
      variant="outline"
      className="text-[10px] border-slate-300 text-slate-500 dark:border-slate-700 dark:text-slate-400"
    >
      Deactivated
    </Badge>
  );
}

/**
 * The service principal the registry binds the agent to. "Agent access
 * required" has three causes at gate 2 (no document, deactivated, another
 * object id), and this line is how the third is told from the other two.
 */
function ObjectIdLine({ oid }) {
  if (!oid) return null;
  return (
    <p className="text-[10px] text-muted-foreground mt-1 font-mono break-all">object id {oid}</p>
  );
}

/** The drift verdict's colour, by its Health Hub status. */
const DRIFT_TONES = Object.freeze({
  healthy: 'text-emerald-600 dark:text-emerald-400',
  degraded: 'text-amber-600 dark:text-amber-400',
  critical: 'text-rose-600 dark:text-rose-400',
  offline: 'text-rose-600 dark:text-rose-400',
});

/**
 * The commit the agent's host last converged from, and whether that is main
 * (#1009). The words are the server's drift verdict for this agent, the
 * sentence the Health Hub's `lab-drift` probe records, so the card and the
 * hub cannot disagree. Nothing when the API sends neither: one older than
 * #1009 cannot say, and the card does not guess.
 */
function DriftLine({ applied, drift }) {
  if (!applied && !drift) return null;
  return (
    <div className="mt-1 space-y-0.5">
      {applied?.commit && (
        <p className="text-[10px] text-muted-foreground font-mono break-all">
          commit {applied.commit.slice(0, 8)} · converged {formatTime(applied.appliedAt)}
        </p>
      )}
      {drift?.summary && (
        <p
          className={`text-xs ${DRIFT_TONES[drift.status] || 'text-muted-foreground'}`}
          data-testid="agent-drift"
          data-status={drift.status}
        >
          {drift.summary}
        </p>
      )}
    </div>
  );
}

function CertificateLine({ certificateExpiresAt, now }) {
  if (!certificateExpiresAt) return null;
  const expiresMs = new Date(certificateExpiresAt).getTime();
  if (!Number.isFinite(expiresMs)) return null;
  const nowMs = toMillis(now);
  if (!nowMs) return null;
  const daysLeft = Math.round((expiresMs - nowMs) / (24 * 60 * 60 * 1000));
  const isExpiringSoon = daysLeft <= 60;
  const isExpired = daysLeft <= 0;

  let tone = 'text-muted-foreground';
  if (isExpired) {
    tone = 'text-rose-600 dark:text-rose-400 font-semibold';
  } else if (isExpiringSoon) {
    tone = 'text-amber-600 dark:text-amber-400 font-semibold';
  }

  let label = `Certificate valid for ${daysLeft}d`;
  if (isExpired) {
    label = `Certificate expired ${Math.abs(daysLeft)}d ago`;
  } else if (isExpiringSoon) {
    label = `Certificate expires in ${daysLeft}d`;
  }

  return (
    <p className={`text-[11px] ${tone} mt-0.5`} data-testid="agent-cert-expiry">
      {label}
    </p>
  );
}

function CertWarningBadge({ certDaysLeft }) {
  if (certDaysLeft === null || certDaysLeft > 60) return null;
  const isExpired = certDaysLeft <= 0;
  const toneClass = isExpired
    ? 'border-rose-300 text-rose-600 dark:border-rose-700 dark:text-rose-400'
    : 'border-amber-300 text-amber-600 dark:border-amber-700 dark:text-amber-400';
  const label = isExpired ? 'Cert expired' : `Cert expires in ${certDaysLeft}d`;

  return (
    <Badge
      variant="outline"
      className={`text-[10px] ${toneClass}`}
      data-testid="agent-cert-warning-badge"
    >
      {label}
    </Badge>
  );
}

function computeCertDaysLeft(expiresAt, nowMs) {
  if (!expiresAt || !nowMs) return null;
  const exp = new Date(expiresAt).getTime();
  if (!Number.isFinite(exp)) return null;
  return Math.round((exp - nowMs) / (24 * 60 * 60 * 1000));
}

/**
 * One agent. The Agents tab passes `actions` (Activate or Deactivate, #740)
 * and `registry`, which adds the bound object id; the Dashboard passes
 * neither. Both show the applied commit and its drift verdict (#1009).
 */
export function AgentCard({ agent, now, actions = null, registry = false }) {
  const online = isAgentOnline(agent, now);
  const nowMs = toMillis(now);
  const certDaysLeft = computeCertDaysLeft(agent.certificateExpiresAt, nowMs);

  return (
    <Card className="p-4">
      <div className="flex items-start gap-3">
        <Server
          className={`h-5 w-5 shrink-0 mt-0.5 ${online ? 'text-emerald-500' : 'text-muted-foreground'}`}
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="text-sm font-semibold truncate">{agent.agentId || agent.id}</p>
            <Badge
              variant="outline"
              className={`text-[10px] ${
                online
                  ? 'border-emerald-300 text-emerald-600 dark:border-emerald-700 dark:text-emerald-400'
                  : 'border-rose-300 text-rose-600 dark:border-rose-700 dark:text-rose-400'
              }`}
            >
              {online ? 'Online' : 'Offline'}
            </Badge>
            <DeactivatedBadge active={agent.active} />
            {agent.version && (
              <Badge variant="outline" className="text-[10px]">
                v{agent.version}
              </Badge>
            )}
            <CertWarningBadge certDaysLeft={certDaysLeft} />
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            {agent.hostname || 'unknown host'} · last seen {formatTime(agent.lastSeenAt)}
            {online && agent.status ? ` · ${agent.status}` : ''}
          </p>
          {registry && <ObjectIdLine oid={agent.oid} />}
          <CertificateLine certificateExpiresAt={agent.certificateExpiresAt} now={now} />
          <DriftLine applied={agent.applied} drift={agent.drift} />
          {(agent.capabilities || []).length > 0 && (
            <div className="flex flex-wrap gap-1 mt-2">
              {agent.capabilities.map((cap) => (
                <Badge key={cap} variant="outline" className="text-[10px] font-mono">
                  {cap}
                </Badge>
              ))}
            </div>
          )}
        </div>
        {actions && <div className="shrink-0">{actions}</div>}
      </div>
    </Card>
  );
}
