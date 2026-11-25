/**
 * The content agent's card on the Health page's Overview: its key, the sections switched off, and the refusals. Moved out of signals.jsx, which re-exports it, when that file grew
 * too long; the card rules at the top of signals.jsx apply here too.
 */
import React from 'react';
import { Link } from 'react-router';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Bot } from 'lucide-react';
import { contentAgentVerdict } from './probeEvaluators';
import { KODA } from './probeKit';

import {
  CardRow,
  CheckedFooter,
  formatTimestamp,
  getBadgeVariantByCount,
  SignalCardHeader,
} from './signalParts';

/** The key's one word and the badge colour that goes with it. */
function keyBadge(key) {
  if (key.unavailable) return { word: 'could not be read', variant: 'outline' };
  if (!key.present) return { word: 'none', variant: 'outline' };
  if (key.active) return { word: 'active', variant: 'secondary' };
  return { word: 'revoked', variant: 'destructive' };
}

/**
 * The rows that describe a key the snapshot has: when it was last used, when
 * it was rotated (or, for a key never rotated, when it was created, said as
 * such) and which switches are off. Nothing here is shown for a key that is
 * absent or unread, because none of it would be a fact.
 */
function KeyRows({ keyState, sectionsOff }) {
  return (
    <>
      <CardRow label="Last used">
        <Badge variant="outline">{formatTimestamp(keyState.lastUsedAt)}</Badge>
      </CardRow>
      {keyState.rotatedAt ? (
        <CardRow label="Rotated">
          <Badge variant="outline">{formatTimestamp(keyState.rotatedAt)}</Badge>
        </CardRow>
      ) : (
        <CardRow label="Created, never rotated">
          <Badge variant="outline">{formatTimestamp(keyState.createdAt)}</Badge>
        </CardRow>
      )}
      <CardRow label="Switches off">
        <span className="text-right text-xs text-muted-foreground" data-testid="agent-switches-off">
          {sectionsOff.length
            ? sectionsOff.map((section) => section.label).join(', ')
            : 'none, every switch is on'}
        </span>
      </CardRow>
    </>
  );
}

/** The refusal count, or the fact that it could not be made. */
function RefusalsBadge({ denials }) {
  if (denials.unavailable) return <Badge variant="outline">could not be counted</Badge>;
  const total = denials.total || 0;
  return (
    <Badge variant={getBadgeVariantByCount(total, 'destructive')}>
      {total}
      {denials.bounded ? '+' : ''}
    </Badge>
  );
}

/**
 * The reasons, most frequent first, when the read made it and found any. At
 * the read's bound each count is a floor, like the total, so it carries the
 * same "+".
 */
function RefusalReasons({ denials }) {
  if (denials.unavailable || !denials.byReason?.length) return null;
  const floor = denials.bounded ? '+' : '';
  return (
    <ul className="space-y-1 text-xs" data-testid="agent-denials-by-reason">
      {denials.byReason.slice(0, 6).map((row) => (
        <li key={row.reason} className="flex items-center justify-between font-mono">
          <span>{row.reason}</span>
          <span className="text-muted-foreground">
            {row.count}
            {floor}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * The content agent (Koda): its key, the switches that are off and the day's
 * refusals by reason, from the snapshot's `agent` block (#1491). The same
 * verdict as the Content agent probe on Checks. Never the key or its hint:
 * that is the Koda tab's, behind super_admin. A snapshot without the block
 * (one written before this card existed) gets the verdict sentence and the
 * link only: rows of "none" and "0" would read as findings.
 */
export function ContentAgentCard({ agent }) {
  const verdict = contentAgentVerdict(agent);
  const key = agent?.key || {};
  const denials = agent?.denials || {};
  const badge = keyBadge(key);
  const sectionsOff = agent?.sectionsOff || [];
  const kodaLink = (
    <p className="text-xs">
      <Link to={KODA.to} className="font-medium text-primary underline-offset-2 hover:underline">
        {KODA.label}: the key, its switches and the route list
      </Link>
    </p>
  );
  return (
    <Card className="flex h-full flex-col" data-testid="content-agent-card">
      <SignalCardHeader
        icon={<Bot className="h-4 w-4 text-violet-500" aria-hidden="true" />}
        title={`Content agent (${agent?.label || 'Koda'})`}
        status={verdict.status}
      />
      <CardContent className="flex flex-1 flex-col gap-2 text-sm">
        <p className="text-xs text-muted-foreground">{verdict.summary}</p>
        {agent ? (
          <>
            <CardRow label="Key">
              <Badge variant={badge.variant}>{badge.word}</Badge>
            </CardRow>
            {key.present ? <KeyRows keyState={key} sectionsOff={sectionsOff} /> : null}
            <CardRow label="Refusals, last 24 h">
              <RefusalsBadge denials={denials} />
            </CardRow>
            <RefusalReasons denials={denials} />
            {denials.lastAt ? (
              <p className="text-xs text-muted-foreground">
                Last refusal {formatTimestamp(denials.lastAt)}.
              </p>
            ) : null}
          </>
        ) : null}
        {kodaLink}
        <CheckedFooter at={agent?.lastCheckedAt} />
      </CardContent>
    </Card>
  );
}
