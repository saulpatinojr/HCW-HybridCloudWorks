/**
 * ApprovalBox — the only control on the page that reaches subscribers. It says
 * what a send still needs before offering one, and asks for confirmation.
 */
import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import RoleGate from '@/components/admin/RoleGate';
import { Loader2, Send } from 'lucide-react';
import { describePlan } from './issueFormat';

/** The approval, or the reason there is none yet, since an approval the server would refuse is a button that cannot work. */
export default function ApprovalBox({ detail, dirty, busy, onApprove }) {
  const [confirming, setConfirming] = useState(false);
  const planText = describePlan(detail.sendPlan);

  // Terraform's newsletter_sending_enabled: off, the server refuses approval,
  // so the page says so instead of offering a button that cannot work.
  if (!detail.sendingEnabled) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Sending is switched off, so this issue cannot be approved yet. It is turned on in Terraform
        (newsletter_sending_enabled).
      </p>
    );
  }
  if (detail.templateProblem) {
    return (
      <p role="alert" className="text-sm text-destructive">
        The chosen template cannot be used yet. {detail.templateProblem.message} Fix it in
        Newsletter settings or choose the built-in design before approving.
      </p>
    );
  }
  if (!detail.readyToSend) {
    return (
      <p role="alert" className="text-sm text-destructive">
        Add the {detail.missingSettings.join(' and ')} in Newsletter settings before approving.
      </p>
    );
  }
  // No send plan means the server could not work out a send time from the
  // settings, and it would refuse approval (SETTINGS_INVALID).
  if (!detail.sendPlan) {
    return (
      <p role="alert" className="text-sm text-destructive">
        The send day, time or time zone in Newsletter settings is not valid. Save them again before
        approving.
      </p>
    );
  }
  return (
    <div className="space-y-2">
      <p className="text-sm">
        Approving sends this to every confirmed subscriber <strong>{planText}</strong>.
      </p>
      {dirty && <p className="text-sm text-destructive">Save your changes before approving.</p>}
      {confirming ? (
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            className="gap-1.5"
            onClick={() => onApprove().finally(() => setConfirming(false))}
            disabled={dirty || Boolean(busy)}
          >
            {busy === 'approve' ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Send className="h-3.5 w-3.5" />
            )}
            Yes, send it {planText}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setConfirming(false)}
            disabled={Boolean(busy)}
          >
            Cancel
          </Button>
        </div>
      ) : (
        // The approve route is publisher (lib/newsletter/admin-handlers.js);
        // gating the first step is enough, since the confirmation is only
        // reached through it.
        <RoleGate minRole="publisher" reason="Approving a send needs the publisher role.">
          <Button
            size="sm"
            className="gap-1.5"
            onClick={() => setConfirming(true)}
            disabled={dirty || Boolean(busy)}
          >
            <Send className="h-3.5 w-3.5" /> Approve and schedule
          </Button>
        </RoleGate>
      )}
    </div>
  );
}
