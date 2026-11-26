/**
 * The Cloudflare page's Overview (#1905): whether the page is set up, the
 * zone it looks after, what the admin token can read, what is locked and
 * why, and where to go for the rest. It only reads; every change is on the
 * other tabs.
 */
import React from 'react';
import { Link } from 'react-router';
import { CheckCircle2, Globe, Lock, XCircle } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { agentKeyTab } from '@/components/admin/ai-engine/agentKeys';
import { agentKeyTabHref } from '@/components/admin/agents/tabs';
import { navItemById } from '@/config/adminNav';
import { CLOUDFLARE_DOCS, ExternalLink, NotConfigured, ReadGate } from './CloudflareParts';
import { familyRows, protectedDnsList, protectedPhaseList } from './cloudflareView';

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
          settings and its rules. This page looks after the site’s own zone and no other.
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
          <p className="text-sm text-muted-foreground">
            The token is set, but Cloudflare did not return the zone. Check that the token is
            limited to the site’s zone and has the Zone Read permission (
            <ExternalLink href={CLOUDFLARE_DOCS.permissions}>
              Cloudflare’s permission list
            </ExternalLink>
            ).
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function FamiliesCard({ status }) {
  const rows = familyRows(status);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">What the token can read</CardTitle>
        <CardDescription>
          Each line is one kind of thing the page shows. A cross means the token was refused when
          the page asked, so that tab will be empty until the token is given that permission.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">The server did not say.</p>
        ) : (
          <ul className="space-y-1.5 text-sm">
            {rows.map((row) => (
              <li key={row.id} className="flex items-center gap-2" data-testid={`family-${row.id}`}>
                {row.readable ? (
                  <CheckCircle2 className="h-4 w-4 text-emerald-600" aria-hidden="true" />
                ) : (
                  <XCircle className="h-4 w-4 text-rose-600" aria-hidden="true" />
                )}
                <span>{row.label}</span>
                <span className="text-muted-foreground">
                  {row.readable ? 'can be read' : 'refused'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function LockedCard({ status }) {
  const names = protectedDnsList(status);
  const phases = protectedPhaseList(status);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg flex items-center gap-2">
          <Lock className="h-5 w-5" aria-hidden="true" />
          What is locked, and why
        </CardTitle>
        <CardDescription>
          These keep the site running and are managed by Terraform (the code that builds the site’s
          cloud resources). Nobody can change them from here, not an admin and not an agent; the
          server refuses. Change them in the Terraform files the reason names. Nothing on this page
          can delete anything.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <p className="text-sm font-medium">DNS records</p>
          {names.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              The list comes from the server once the token is set. Certificate check records
              (_acme-challenge) are always locked.
            </p>
          ) : (
            <ul className="mt-1 space-y-1 text-sm">
              {names.map((item) => (
                <li key={item.name}>
                  <code>{item.name}</code>
                  {item.reason ? (
                    <span className="text-muted-foreground"> — {item.reason}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <p className="text-sm font-medium">Rule phases</p>
          <ul className="mt-1 space-y-1 text-sm">
            {phases.map((item) => (
              <li key={item.phase}>
                <code>{item.phase}</code>
                {item.reason ? (
                  <span className="text-muted-foreground"> — {item.reason}</span>
                ) : null}
              </li>
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
            Making the admin token (an account-owned token, limited to this zone):{' '}
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
          <NotConfigured />
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
