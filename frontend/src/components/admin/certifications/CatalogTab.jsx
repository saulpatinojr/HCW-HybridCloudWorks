/**
 * Catalog — every certification, with the stats strip, search, the issuer
 * filter, and Add cert. Featured, expiring and hidden certs are here too; each
 * also has the tab that owns its duty (Featured, Renewals, Settings).
 */
import React, { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent } from '@/components/ui/card';
import { Plus, Search } from 'lucide-react';
import { CertGrid } from './CertCard';
import { CertListNotice, TabIntro } from './shared';
import { computeStats, filterCatalog, issuerList } from './certView';

function Stat({ label, className = 'text-2xl font-bold', children }) {
  return (
    <Card>
      <CardContent className="p-3">
        <p className="text-xs uppercase tracking-wide text-slate-500">{label}</p>
        <p className={className}>{children}</p>
      </CardContent>
    </Card>
  );
}

export function StatsStrip({ items, nowMs }) {
  const stats = useMemo(() => computeStats(items, nowMs), [items, nowMs]);
  return (
    <div className="grid grid-cols-2 md:grid-cols-5 gap-3" role="group" aria-label="Catalog stats">
      <Stat label="Total">{stats.total}</Stat>
      <Stat label="Showing" className="text-2xl font-bold text-emerald-600">
        {stats.shown}
      </Stat>
      <Stat label="Featured" className="text-2xl font-bold text-amber-500">
        {stats.featured}
      </Stat>
      <Stat label="Expiring 90d" className="text-2xl font-bold text-rose-500">
        {stats.expiringSoon}
      </Stat>
      {/* Two lines, not an ellipsis: issuer labels run long ("Microsoft Global
          Channel Partner…") and the card has the height (owner, 2026-10-05). */}
      <Stat label="Top issuer" className="text-sm font-bold leading-snug line-clamp-2 break-words">
        {stats.topIssuer ? `${stats.topIssuer[0]} (${stats.topIssuer[1]})` : '—'}
      </Stat>
    </div>
  );
}

function Filters({ search, setSearch, issuer, setIssuer, issuers, onNew }) {
  return (
    <div className="flex flex-wrap gap-2 items-end">
      <div className="flex-1 min-w-48">
        <Label className="text-xs" htmlFor="cert-search">
          Search
        </Label>
        <div className="relative mt-1">
          <Search className="absolute left-2.5 top-2 h-4 w-4 text-slate-400" />
          <Input
            id="cert-search"
            className="pl-8 h-8 text-xs"
            placeholder="Name, code, issuer…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>
      <div>
        <Label className="text-xs" htmlFor="cert-issuer">
          Issuer
        </Label>
        <select
          id="cert-issuer"
          className="block h-8 w-44 text-xs mt-1 rounded-md border border-input bg-background px-2"
          value={issuer}
          onChange={(e) => setIssuer(e.target.value)}
        >
          <option value="">All issuers</option>
          {issuers.map((i) => (
            <option key={i} value={i}>
              {i}
            </option>
          ))}
        </select>
      </div>
      <Button size="sm" className="h-8 ml-auto" onClick={onNew}>
        <Plus className="h-4 w-4 mr-1" />
        Add cert
      </Button>
    </div>
  );
}

export default function CatalogTab({ certs, nowMs, actions, onNew }) {
  const [search, setSearch] = useState('');
  const [issuer, setIssuer] = useState('');
  const issuers = useMemo(() => issuerList(certs.items), [certs.items]);
  const filtered = useMemo(
    () => filterCatalog(certs.items, { search, issuer }),
    [certs.items, search, issuer]
  );

  return (
    <div className="space-y-4">
      <TabIntro>
        Every certification in the collection. Add one, edit it, show or hide it on the About page,
        or feature it.
      </TabIntro>
      {certs.loaded ? (
        <>
          <StatsStrip items={certs.items} nowMs={nowMs} />
          <Filters
            search={search}
            setSearch={setSearch}
            issuer={issuer}
            setIssuer={setIssuer}
            issuers={issuers}
            onNew={onNew}
          />
          <CertGrid
            certs={filtered}
            nowMs={nowMs}
            busyIds={certs.busyIds}
            actions={actions}
            empty="No certifications match these filters."
          />
        </>
      ) : (
        <CertListNotice certs={certs} />
      )}
    </div>
  );
}
