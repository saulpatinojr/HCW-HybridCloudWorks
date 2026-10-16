/**
 * Accounts — the connected profiles and what each one's status is (#575).
 *
 * Its own tab rather than a card inside Settings: the Newsletter Hub standard
 * gives the audience — here, the profiles a post can go to — a tab of its own,
 * and this is the list an operator checks before composing, not something set
 * once and forgotten.
 *
 * The browser cannot say more about a profile than whether Publer returned it.
 * The key lives in Key Vault and the proxy never sends it back (FINDING-04), so
 * the accounts call is the only evidence this tab has.
 */
import React from 'react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { CheckCircle, ExternalLink } from 'lucide-react';
import { PLATFORM_META, connectedPlatformIds } from './socialView';
import { PublerAccountsNotice } from './shared';
import usePublerAccounts from './usePublerAccounts';

export default function AccountsTab() {
  const { accounts, status, error, reason } = usePublerAccounts();
  const platformIds = connectedPlatformIds(accounts);

  return (
    <div className="max-w-2xl space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Connected Accounts</CardTitle>
          <CardDescription>
            Social accounts connected to your Publer workspace. Add or remove them in Publer — this
            hub reads the list, it does not own it.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {accounts.length > 0 ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {accounts.map((a) => {
                const meta = PLATFORM_META[a.provider?.toLowerCase()] || {};
                const { Icon, color, bg } = meta;
                return (
                  <div
                    key={a.id}
                    className={`flex items-center gap-3 p-3 rounded-lg border ${bg || 'bg-muted/30'}`}
                  >
                    {Icon && <Icon className={`h-5 w-5 shrink-0 ${color}`} />}
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate">{a.name || a.social_id}</p>
                      <p className="text-xs text-muted-foreground capitalize">{a.provider}</p>
                    </div>
                    <CheckCircle className="h-4 w-4 text-emerald-500 ml-auto shrink-0" />
                  </div>
                );
              })}
            </div>
          ) : (
            <PublerAccountsNotice
              status={status}
              error={error}
              reason={reason}
              atConnectionSettings
            />
          )}

          <a
            href="https://app.publer.com"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline"
          >
            Manage accounts in Publer <ExternalLink className="h-3.5 w-3.5" />
          </a>
        </CardContent>
      </Card>

      {/* Supported platforms reference — only platforms with connected accounts */}
      {platformIds.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Supported Platforms</CardTitle>
            <CardDescription>Channels active in your Publer workspace.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {platformIds.map((id) => {
                const { label, Icon, color, bg } = PLATFORM_META[id];
                const count = accounts.filter((a) => a.provider?.toLowerCase() === id).length;
                return (
                  <div key={id} className={`flex items-center gap-2 p-3 rounded-lg border ${bg}`}>
                    <Icon className={`h-4 w-4 ${color}`} />
                    <span className="text-sm font-medium">{label}</span>
                    <Badge variant="secondary" className="ml-auto text-xs">
                      {count}
                    </Badge>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
