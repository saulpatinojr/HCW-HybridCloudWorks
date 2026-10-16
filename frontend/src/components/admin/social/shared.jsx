/**
 * The small pieces more than one Social Hub tab renders (#575).
 *
 * `PublerAccountsNotice` is the reason this file exists: Compose, Accounts and
 * Settings each show the account list, and until #397 each of them described an
 * empty one in its own words — so an unseeded key, a refused key and a genuinely
 * empty workspace were three different problems shown as the same sentence.
 */
import React from 'react';
import { Badge } from '@/components/ui/badge';
import { CheckCircle, Loader2, Calendar, Send } from 'lucide-react';
import { PLATFORM_META } from './socialView';

export function PlatformBadge({ provider }) {
  const meta = PLATFORM_META[typeof provider === 'string' ? provider.toLowerCase() : ''] || {};
  const { Icon, color, label } = meta;
  return (
    <Badge variant="outline" className={`text-xs capitalize gap-1 ${color || ''}`}>
      {Icon && <Icon className="h-2.5 w-2.5" />}
      {label || provider}
    </Badge>
  );
}

export function AccountToggle({ account, selected, onToggle }) {
  const provider = account.provider?.toLowerCase() || '';
  const meta = PLATFORM_META[provider] || {};
  const { Icon, color, bg } = meta;
  const isOn = selected.includes(account.id);
  return (
    <button
      type="button"
      onClick={() => onToggle(account.id)}
      className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-sm font-medium transition-all ${
        isOn ? `${bg} ${color} shadow-sm` : 'border-border text-muted-foreground hover:bg-muted'
      }`}
    >
      {Icon ? <Icon className={`h-4 w-4 ${isOn ? color : ''}`} /> : null}
      <span className="truncate max-w-30">{account.name || account.provider}</span>
      {isOn && <CheckCircle className="h-3.5 w-3.5 ml-auto shrink-0" />}
    </button>
  );
}

/**
 * What the account list says when it has nothing to show. An unseeded
 * integration, a failed call and a genuinely empty workspace are three
 * different problems with three different fixes, and until #397 all three
 * rendered as the same "No accounts found."
 *
 * `atConnectionSettings` is true on the tabs that hold the fix — Accounts and
 * Settings — where "go to the Settings tab" would be pointing at itself.
 */
export function PublerAccountsNotice({ status, error, reason, atConnectionSettings = false }) {
  if (status === 'loading') {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading accounts…
      </div>
    );
  }
  if (status === 'not_configured') {
    return (
      <p className="text-sm text-muted-foreground">
        <strong>Publer is not connected.</strong>{' '}
        {/* The proxy returns one code for a missing key and for a missing
            workspace id, so naming only the key would be a guess. Its `error`
            names the setting when it sends one; otherwise say both. */}
        {reason
          ? `${reason}, so Publer was never asked for accounts.`
          : 'PUBLER_API_KEY or PUBLER_WORKSPACE_ID is not set on the function app, so Publer was never asked for accounts.'}{' '}
        {atConnectionSettings
          ? 'Set both on the function app — as Key Vault references — then reload this page.'
          : 'Connect it on the Accounts tab.'}
      </p>
    );
  }
  if (status === 'error') {
    return (
      <p className="text-sm text-destructive">
        <strong>Publer accounts could not be loaded</strong> — {error || 'the call failed'}. The
        list is empty because the call did not succeed, not because the workspace is.
      </p>
    );
  }
  return (
    <p className="text-sm text-muted-foreground">
      No accounts found. Add social accounts in{' '}
      <a
        href="https://app.publer.com"
        target="_blank"
        rel="noopener noreferrer"
        className="text-primary underline"
      >
        Publer
      </a>
      .
    </p>
  );
}

export function ScheduleButtonContent({ submitting, jobStatus, scheduledAt }) {
  if (submitting) {
    return (
      <>
        <Loader2 className="h-4 w-4 animate-spin" />{' '}
        {jobStatus === 'polling' ? 'Processing…' : 'Scheduling…'}
      </>
    );
  }

  if (scheduledAt) {
    return (
      <>
        <Calendar className="h-4 w-4" /> Schedule Post
      </>
    );
  }

  return (
    <>
      <Send className="h-4 w-4" /> Post Now
    </>
  );
}
