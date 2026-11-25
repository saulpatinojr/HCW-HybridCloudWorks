import React from 'react';
import { Card } from '@/components/ui/card';
import ColumnHeads from '@/components/admin/shared/ColumnHeads';

/**
 * The Entra configuration this site runs on (#519).
 *
 * Shown on the Integrations Hub's Identity tab (#570); it used to sit under the
 * "Site platform" group — these are values the site runs on, and each one says
 * what changing it breaks. They are not Key Vault secrets, so they never appear in
 * `secret-catalog.js` and had no surface anywhere in the admin UI: a scope that
 * disagrees with the audience, or a SPA pointed at a different tenant from the
 * API, was invisible until every call started returning 401.
 *
 * WHAT IS SHOWN, AND WHY IT IS SAFE. Identifiers only — a tenant id, an
 * application id, an App Role name, a scope name. Every one of them is already
 * in the SPA's own bundle or in this repository, and the page's rule about
 * never rendering a credential is untouched: there is no credential here.
 *
 * BOTH HALVES, SIDE BY SIDE, WHICH IS THE POINT. The left column is what this
 * browser was built with; the right is what the API says it enforces, fetched
 * from `getAuthExpectations`. A page that compared the frontend against itself
 * would prove only that it agrees with itself.
 *
 * @param {{expectations: object|null, error: string|null}} props
 */
export function EntraConfigurationCard({ expectations, error }) {
  const rows = [
    {
      label: 'Tenant',
      browser: import.meta.env.VITE_ENTRA_TENANT_ID || null,
      api: expectations?.tenantId ?? null,
      breaks: 'Sign-in goes to the wrong directory, or to none.',
    },
    {
      label: 'API audience',
      browser: null,
      api: expectations?.expectedAudience ?? null,
      breaks: 'Every authenticated call returns 401.',
    },
    {
      label: 'SPA client id',
      browser: import.meta.env.VITE_ENTRA_CLIENT_ID || null,
      api: null,
      breaks: 'Sign-in fails at the authority, before any token exists.',
    },
    {
      label: 'Requested scope',
      browser: import.meta.env.VITE_ENTRA_API_SCOPE || null,
      api: expectations?.requiredScope ?? null,
      breaks: 'Tokens arrive without `scp` and the guard refuses them.',
    },
    {
      label: 'Admin App Role',
      browser: null,
      api: expectations?.adminAppRole ?? null,
      breaks: 'Nobody satisfies gate 1, whatever the registry says.',
    },
    {
      label: 'Agent App Role',
      browser: null,
      api: expectations?.labAgentAppRole ?? null,
      breaks: 'The Labs VPS agent cannot authenticate.',
    },
    {
      label: 'Token version',
      browser: null,
      api: expectations?.requiredTokenVersion ?? null,
      breaks: 'Changing it changes the shape of `aud`, so every token is rejected.',
    },
    {
      label: 'Registry container',
      browser: null,
      api: expectations?.registryContainer ?? null,
      breaks: 'Gate 2 reads the wrong container and every admin is unknown.',
    },
  ];

  return (
    <Card className="p-4">
      <div className="mb-3">
        <h3 className="text-sm font-semibold">Microsoft Entra ID</h3>
        <p className="text-xs text-muted-foreground">
          Identifiers, not credentials. The API column comes from <code>getAuthExpectations</code>,
          so this compares the browser against the API as deployed rather than against itself.
        </p>
      </div>

      {error ? (
        <p className="mb-3 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-muted-foreground">
          The API did not answer, so only the browser column is filled in: {error}
        </p>
      ) : null}

      <div className="overflow-x-auto rounded-md border border-border/60 bg-muted/20">
        <table className="w-full text-left text-xs">
          <thead className="text-muted-foreground">
            <ColumnHeads
              labels={[
                'Value',
                'In this browser',
                'Enforced by the API',
                'What changing it breaks',
              ]}
              cellClassName="px-3 py-2 font-medium"
            />
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.label} className="border-t border-border/60 align-top">
                <th scope="row" className="px-3 py-2 font-medium">
                  {row.label}
                </th>
                <td className="px-3 py-2 font-mono break-all">{row.browser ?? '—'}</td>
                <td className="px-3 py-2 font-mono break-all">{row.api ?? '—'}</td>
                <td className="px-3 py-2 text-muted-foreground">{row.breaks}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="mt-3 text-xs text-muted-foreground">
        A live token is checked against these on{' '}
        {/*
          A plain anchor, not a router Link: this card is rendered by tests that
          mount the page without a Router, and one full navigation on an admin
          page is a smaller cost than a Router in every one of those tests.
        */}
        <a href="/admin/health" className="underline underline-offset-2">
          Health
        </a>
        , which decodes the caller&apos;s own token and reports a verdict per claim.
      </p>
    </Card>
  );
}
