/**
 * The workflow alerts card on the Health page's Overview, with acknowledge, resolve and reopen in place. Moved out of signals.jsx, which re-exports it, when that file grew
 * too long; the card rules at the top of signals.jsx apply here too.
 */
import React from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import RoleGate from '@/components/admin/RoleGate';
import useLinkedItem from '@/hooks/useLinkedItem';
import { LINK_PARAMS } from '@/lib/itemLinks';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';

import { ALERT_FILTERS, formatTimestamp, getAlertStatus, SignalCardHeader } from './signalParts';

/** One workflow alert with its state changes, gated together because the hub is a viewer read and updateWorkflowAlert is publisher. */
function AlertRow({
  alert,
  alertActionId,
  resolutionNotes,
  setResolutionNotes,
  handleAlertAction,
}) {
  const status = getAlertStatus(alert);
  // `?alert=<id>` (the dashboard's Decision Center) scrolls to this alert and rings it.
  const { ref, linkedProps, linkedClassName } = useLinkedItem(LINK_PARAMS.alert, alert.id);
  return (
    <div
      key={alert.id}
      ref={ref}
      {...linkedProps}
      className={`rounded-lg border p-3 ${linkedClassName}`}
    >
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium">{alert.alertType || 'workflow_alert'}</p>
          <p className="text-xs text-muted-foreground">
            {alert.source || 'unknown source'} ·{' '}
            {formatTimestamp(alert.updatedAt || alert.firstSeenAt)}
          </p>
        </div>
        <Badge variant={alert.severity === 'critical' ? 'destructive' : 'outline'}>
          {alert.severity || 'warning'}
        </Badge>
      </div>
      {status !== 'resolved' && (
        <div className="mt-3">
          <Input
            value={resolutionNotes[alert.id] || ''}
            onChange={(e) =>
              setResolutionNotes((prev) => ({ ...prev, [alert.id]: e.target.value }))
            }
            placeholder="Resolution note (required to resolve)"
          />
        </div>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        {/* The hub is readable by a viewer; updateWorkflowAlert is publisher
            (lib/ops-health.js), so the three state changes say so together. */}
        <RoleGate minRole="publisher" reason="Changing an alert's state needs the publisher role.">
          {status === 'open' && (
            <Button
              size="sm"
              variant="outline"
              disabled={alertActionId !== ''}
              onClick={() => handleAlertAction(alert.id, 'acknowledge')}
            >
              {alertActionId === `${alert.id}:acknowledge` ? 'Acknowledging...' : 'Acknowledge'}
            </Button>
          )}
          {status !== 'resolved' && (
            <Button
              size="sm"
              disabled={alertActionId !== ''}
              onClick={() => handleAlertAction(alert.id, 'resolve')}
            >
              {alertActionId === `${alert.id}:resolve` ? 'Resolving...' : 'Resolve'}
            </Button>
          )}
          {status === 'resolved' && (
            <Button
              size="sm"
              variant="outline"
              disabled={alertActionId !== ''}
              onClick={() => handleAlertAction(alert.id, 'reopen')}
            >
              {alertActionId === `${alert.id}:reopen` ? 'Reopening...' : 'Reopen'}
            </Button>
          )}
        </RoleGate>
        <Badge variant="secondary">{status}</Badge>
      </div>
    </div>
  );
}

export function WorkflowAlertsCard({
  alertFilter,
  setAlertFilter,
  filteredAlerts,
  alertActionId,
  resolutionNotes,
  setResolutionNotes,
  handleAlertAction,
  status = 'unknown',
}) {
  return (
    <Card>
      <SignalCardHeader
        icon={<AlertTriangle className="h-4 w-4 text-amber-500" aria-hidden="true" />}
        title="Workflow Alerts"
        status={status}
      />
      <CardContent>
        <div className="mb-4 flex flex-wrap gap-2">
          {ALERT_FILTERS.map((filter) => (
            <Button
              key={filter.value}
              size="sm"
              variant={alertFilter === filter.value ? 'default' : 'outline'}
              onClick={() => setAlertFilter(filter.value)}
            >
              {filter.label}
            </Button>
          ))}
        </div>
        {filteredAlerts.length === 0 ? (
          <div className="flex items-center gap-2 text-sm text-emerald-600">
            <CheckCircle2 className="h-4 w-4" /> No alerts in this filter.
          </div>
        ) : (
          <div className="space-y-3">
            {filteredAlerts.map((alert) => (
              <AlertRow
                key={alert.id}
                alert={alert}
                alertActionId={alertActionId}
                resolutionNotes={resolutionNotes}
                setResolutionNotes={setResolutionNotes}
                handleAlertAction={handleAlertAction}
              />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
