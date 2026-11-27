/**
 * The Cloudflare page's Overview (#1905): whether the page is set up, the
 * picked zone (#1911) and what it is for, what the admin token can read in
 * it, what is locked there and why, and where to go for the rest. It only reads; every change is on the
 * other tabs.
 */
import React from 'react';
import { Link } from 'react-router';
import { CheckCircle2, Globe, HelpCircle, Lock, XCircle } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import StatusBadge from '@/components/admin/shared/StatusBadge';
import { agentKeyTab } from '@/components/admin/ai-engine/agentKeys';
import { agentKeyTabHref } from '@/components/admin/agents/tabs';
import { navItemById } from '@/config/adminNav';
import {
  CLOUDFLARE_DOCS,
  ExternalLink,
  NotConfigured,
  ReadGate,
  useCloudflareRead,
} from './CloudflareParts';
import {
  APEX_WILDCARD_REASON,
  editablePhaseList,
  familyRows,
  protectedDnsList,
  protectedPhaseList,
  protectedPrefixList,
  READ_ONLY_PHASE_REASON,
} from './cloudflareView';
import { DEFAULT_ZONE, OWNER_ONLY_SETTINGS } from './cloudflareLocks';

/** Whether the server named a zone other than the site's (an older server names none: the site's). */
const isOtherZone = (status) =>
  Boolean(status?.managed?.name) && status.managed.name.toLowerCase() !== DEFAULT_ZONE;
import { RATE_LIMIT_RUNBOOK_URL, checkRateLimit } from './rateLimitCheck';
import { tabHref } from './tabs';

const NETWORK_AGENT = agentKeyTab('claude-network');

/** The runbook for this page: the token, Claude Network Guy's key, and what is refused. */
export const CLOUDFLARE_RUNBOOK_URL =
  'https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/docs/runbooks/cloudflare-admin.md';

/** The runbook for the one Cloudflare value that must change on both sides at once. */
export const ORIGIN_SECRET_RUNBOOK_URL =
  'https://github.com/saulpatinojr/HCW-HybridCloudWorks/blob/main/docs/runbooks/origin-secret-rotation.md';

function ZoneCard({ status }) {
  const { zone } = status;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg flex items-center gap-2">
          <Globe className="h-5 w-5" aria-hidden="true" />
          The zone
        </CardTitle>
        <CardDescription>
          A zone is Cloudflare’s word for one domain and everything under it: its DNS records, its
          settings and its rules. This page looks after two zones, the site’s own and the lab’s
          certificate zone, and no other; the picker above chooses which one every tab shows.
          {status.managed?.role ? ` ${status.managed.role}` : ''}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {zone ? (
          <dl className="grid grid-cols-1 sm:grid-cols-3 gap-x-6 gap-y-2 text-sm">
            <div>
              <dt className="text-muted-foreground">Name</dt>
              <dd className="font-medium">{zone.name}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Status</dt>
              <dd>{zone.status || '—'}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Plan</dt>
              {/* A name, or Cloudflare's own `{ name }` object. */}
              <dd>{(typeof zone.plan === 'object' ? zone.plan?.name : zone.plan) || '—'}</dd>
            </div>
          </dl>
        ) : (
          <NoZone zoneError={status.zoneError} />
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Why the zone is missing: the server's own sentence when it gave one (a
 * refused token, a limit, Cloudflare down), else the likeliest cause.
 */
function NoZone({ zoneError }) {
  if (zoneError) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="zone-error">
        {zoneError}
      </p>
    );
  }
  return (
    <p className="text-sm text-muted-foreground">
      The token is set, but Cloudflare did not return the zone. Check that this zone is among the
      token’s zones and that it has the Zone Read permission (
      <ExternalLink href={CLOUDFLARE_DOCS.permissions}>Cloudflare’s permission list</ExternalLink>
      ).
    </p>
  );
}

const FAMILY_ICONS = {
  yes: <CheckCircle2 className="h-4 w-4 text-emerald-600" aria-hidden="true" />,
  refused: <XCircle className="h-4 w-4 text-rose-600" aria-hidden="true" />,
  unknown: <HelpCircle className="h-4 w-4 text-amber-600" aria-hidden="true" />,
};

const FamilyIcon = ({ state }) => FAMILY_ICONS[state] ?? FAMILY_ICONS.unknown;

function FamiliesCard({ status }) {
  const rows = familyRows(status);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">What the token can read</CardTitle>
        <CardDescription>
          Each line is one kind of thing the page shows. A cross means Cloudflare refused the token
          when the page asked, so that tab stays empty until the token is given that permission. A
          question mark means the page could not check just now (Cloudflare was slow or answered
          with an error); try again in a minute.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">The server did not say.</p>
        ) : (
          <ul className="space-y-1.5 text-sm">
            {rows.map((row) => (
              <li key={row.id} className="flex items-center gap-2" data-testid={`family-${row.id}`}>
                <FamilyIcon state={row.state} />
                <span>{row.label}</span>
                <span className="text-muted-foreground">{row.words}</span>
              </li>
            ))}
          </ul>
        )}
        {/* The API rate limit rule is the site's (#1909): hidden only when the server says it answered for another zone (#1911). */}
        {isOtherZone(status) ? null : <RateLimitLine />}
      </CardContent>
    </Card>
  );
}

/**
 * Whether the API rate limit rule is on (#1909): the same check, and the
 * same words, as the Health page's Cloudflare API rate limit probe.
 */
function RateLimitLine() {
  const read = useCloudflareRead(checkRateLimit, null);
  const check = read.data;
  return (
    <div className="mt-4 border-t border-border/60 pt-3 text-sm" data-testid="rate-limit-check">
      <p className="font-medium">The API rate limit rule</p>
      {check ? (
        <p className="mt-1 flex flex-wrap items-center gap-2">
          <StatusBadge system={check.status} size="xs" />
          <span>{check.sentence}</span>
        </p>
      ) : (
        <p className="mt-1 text-muted-foreground">Checking…</p>
      )}
      <p className="mt-1 text-xs text-muted-foreground">
        {check?.state === 'off' ? (
          <>
            How to make it:{' '}
            <ExternalLink href={RATE_LIMIT_RUNBOOK_URL}>
              Part 4 of the Cloudflare admin runbook
            </ExternalLink>
            .{' '}
          </>
        ) : null}
        <Link to={tabHref('rules')} className="underline underline-offset-2 hover:text-foreground">
          Open the Rules tab
        </Link>
      </p>
    </div>
  );
}

/** One locked item with its reason. */
function Reasoned({ code, reason }) {
  return (
    <li>
      <code>{code}</code>
      {reason ? <span className="text-muted-foreground"> — {reason}</span> : null}
    </li>
  );
}

function LockedNames({ status }) {
  const names = protectedDnsList(status);
  return (
    <div>
      <p className="text-sm font-medium">DNS records</p>
      <p className="text-xs text-muted-foreground">
        An entry that starts with <code>*.</code> covers every name under it. A wildcard over a
        locked name (such as <code>*.www</code>) is locked too, and so is <code>*</code> for the
        whole zone: {APEX_WILDCARD_REASON}
      </p>
      {status?.protected?.wildcardReason ? (
        <p className="text-xs text-muted-foreground" data-testid="all-wildcards">
          In this zone every wildcard is locked: {status.protected.wildcardReason}
        </p>
      ) : null}
      <ul className="mt-1 space-y-1 text-sm">
        {protectedPrefixList(status).map((item) => (
          <Reasoned key={item.prefix} code={`${item.prefix}…`} reason={item.reason} />
        ))}
        {names.map((item) => (
          <Reasoned key={item.name} code={item.name} reason={item.reason} />
        ))}
      </ul>
      {names.length === 0 && (
        <p className="mt-1 text-sm text-muted-foreground">
          The full list of names comes from the server once the token is set.
        </p>
      )}
    </div>
  );
}

function LockedCard({ status }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg flex items-center gap-2">
          <Lock className="h-5 w-5" aria-hidden="true" />
          What is locked, and why
        </CardTitle>
        <CardDescription>
          The records and rule phases below are looked after elsewhere: in the site’s zone by
          Terraform (the code that builds the site’s cloud resources), and in the lab zone by the
          lab host’s web server, which writes its certificate checks there. Nobody can change them
          from here, not an admin and not an agent; the server refuses. No DNS record or ruleset can
          be deleted from this page, but replacing a phase’s rules removes the ones you leave out.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <LockedNames status={status} />
        <div>
          <p className="text-sm font-medium">Rule phases Terraform manages</p>
          <ul className="mt-1 space-y-1 text-sm" data-testid="locked-phases">
            {protectedPhaseList(status).map((item) => (
              <Reasoned key={item.phase} code={item.phase} reason={item.reason} />
            ))}
          </ul>
          {protectedPhaseList(status).length === 0 && (
            <p className="mt-1 text-sm text-muted-foreground">
              None in this zone: Terraform writes no rules here.
            </p>
          )}
        </div>
        <div>
          <p className="text-sm font-medium">Rule phases that can be changed here</p>
          <p className="text-xs text-muted-foreground">
            Only these. Every other phase is read-only: {READ_ONLY_PHASE_REASON}
          </p>
          <ul className="mt-1 space-y-1 text-sm" data-testid="open-phases">
            {editablePhaseList(status).map((item) => (
              <Reasoned key={item.phase} code={item.phase} reason={item.description} />
            ))}
          </ul>
        </div>
        <div>
          <p className="text-sm font-medium">Settings only you change</p>
          <p className="text-xs text-muted-foreground">
            An agent key is refused these; you, signed in as the owner, can change them on the
            Settings tab.
          </p>
          <ul className="mt-1 space-y-1 text-sm">
            {(status?.protected?.ownerOnlySettings ?? OWNER_ONLY_SETTINGS).map((item) => (
              <Reasoned key={item.setting} code={item.setting} />
            ))}
          </ul>
        </div>
      </CardContent>
    </Card>
  );
}

function WhereCard() {
  const agents = navItemById('agents');
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">Where to go next</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="list-disc pl-5 space-y-1.5 text-sm text-muted-foreground">
          <li>
            The full Cloudflare dashboard, for anything this page does not cover:{' '}
            <ExternalLink href="https://dash.cloudflare.com/">dash.cloudflare.com</ExternalLink>.
          </li>
          <li>
            {NETWORK_AGENT.displayName}, the agent that can do the same work when you ask it: its
            key and switches are on{' '}
            <Link
              to={agentKeyTabHref(NETWORK_AGENT.id)}
              className="underline underline-offset-2 hover:text-foreground"
            >
              {agents.label} → {NETWORK_AGENT.displayName}
            </Link>
            .
          </li>
          <li>
            Every step, in order (the token, the key, what is refused and why):{' '}
            <ExternalLink href={CLOUDFLARE_RUNBOOK_URL}>the Cloudflare admin runbook</ExternalLink>.
          </li>
          <li>
            Making the admin token (an account-owned token, limited to the two zones):{' '}
            <ExternalLink href={CLOUDFLARE_DOCS.accountTokens}>account-owned tokens</ExternalLink>,{' '}
            <ExternalLink href={CLOUDFLARE_DOCS.createToken}>creating a token</ExternalLink> and{' '}
            <ExternalLink href={CLOUDFLARE_DOCS.permissions}>the permission list</ExternalLink>.
          </li>
          <li>
            Changing the origin secret, which must change in Cloudflare and on the site at the same
            time:{' '}
            <ExternalLink href={ORIGIN_SECRET_RUNBOOK_URL}>the origin secret runbook</ExternalLink>.
          </li>
          <li>
            What each call does:{' '}
            <ExternalLink href={CLOUDFLARE_DOCS.api}>Cloudflare’s API reference</ExternalLink>.
          </li>
        </ul>
      </CardContent>
    </Card>
  );
}

export default function CloudflareOverview({ statusRead }) {
  return (
    <ReadGate read={statusRead} label="Cloudflare’s status">
      {statusRead.data?.configured === false ? (
        <div className="space-y-6">
          <NotConfigured missing={statusRead.data.missing} message={statusRead.data.message} />
          <LockedCard status={statusRead.data} />
          <WhereCard />
        </div>
      ) : (
        <div className="space-y-6">
          <ZoneCard status={statusRead.data ?? {}} />
          <FamiliesCard status={statusRead.data ?? {}} />
          <LockedCard status={statusRead.data ?? {}} />
          <WhereCard />
        </div>
      )}
    </ReadGate>
  );
}
