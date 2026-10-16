/**
 * Directory — every external service this site connects to, as a reader
 * would want it explained: what it is, what it powers here, whether it is
 * connected, where its documentation and official site are, and how to set
 * it up (owner brief 2026-10-06, #919).
 *
 * Configuration-driven: the rows are config/integrationsDirectory.js merged
 * with the service registry, the status is the same verdict the Overview
 * computes (integrationView.js serviceStatus, from key lights and the last
 * test), and the brand pill is IntegrationBadge. Search, a category filter,
 * a connection filter and alphabetical order; nothing here is edited, and
 * Set up opens the Services tab on the service's group, where keys and
 * tests live.
 */

import React, { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import StatusBadge from '@/components/admin/shared/StatusBadge';
import IntegrationBadge from '@/components/admin/shared/IntegrationBadge';
import { BookOpen, ExternalLink, Search, Settings2 } from 'lucide-react';
import {
  DIRECTORY_CATEGORIES,
  decorateEntries,
  directoryEntries,
} from '@/config/integrationsDirectory';
import { SERVICE_STATUS } from './integrationView';
import useServiceCards from './useServiceCards';
import { KeyStatusNotices } from './TabNotice';

export const CONNECTION_FILTERS = Object.freeze([
  { id: 'all', label: 'All' },
  { id: 'connected', label: 'Connected' },
  { id: 'not-connected', label: 'Not connected' },
  { id: 'unknown', label: 'Not yet tested' },
]);

/** The rows that survive the search and both filters, alphabetical by name. */
export function filterDirectory(
  entries,
  { query = '', category = 'all', connection = 'all' } = {}
) {
  const needle = query.trim().toLowerCase();
  return entries
    .filter((entry) => category === 'all' || entry.category === category)
    .filter((entry) => connection === 'all' || entry.connection === connection)
    .filter(
      (entry) =>
        needle === '' ||
        [entry.name, entry.summary, entry.powers, entry.categoryLabel, ...(entry.usedIn ?? [])]
          .join(' ')
          .toLowerCase()
          .includes(needle)
    )
    .sort((a, b) => a.name.localeCompare(b.name));
}

function DirectoryCard({ entry }) {
  const presentation = SERVICE_STATUS[entry.statusKey] ?? SERVICE_STATUS.untested;
  return (
    <Card className="flex h-full flex-col gap-3 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <h3 className="text-sm font-semibold">{entry.name}</h3>
          <div className="flex flex-wrap items-center gap-2">
            <IntegrationBadge id={entry.id} size="xs" />
            <span className="rounded-full border border-border px-2 py-0.5 text-xs uppercase tracking-wide text-muted-foreground">
              {entry.categoryLabel}
            </span>
          </div>
        </div>
        <StatusBadge status={presentation.badge} size="xs" />
      </div>
      <p className="text-sm">{entry.summary}</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted-foreground">Powers</dt>
        <dd className="min-w-0">{entry.powers}</dd>
        {entry.usedIn.length > 0 ? (
          <>
            <dt className="text-muted-foreground">Used in</dt>
            <dd className="min-w-0">{entry.usedIn.join(', ')}</dd>
          </>
        ) : null}
      </dl>
      <div className="mt-auto flex flex-wrap items-center gap-2 pt-1">
        <Button asChild size="sm">
          <Link to={entry.setupHref}>
            <Settings2 className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" /> Set up
          </Link>
        </Button>
        {entry.docsUrl ? (
          <Button asChild size="sm" variant="outline">
            <a href={entry.docsUrl} target="_blank" rel="noopener noreferrer">
              <BookOpen className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" /> Docs
            </a>
          </Button>
        ) : null}
        {entry.siteUrl ? (
          <Button asChild size="sm" variant="ghost">
            <a href={entry.siteUrl} target="_blank" rel="noopener noreferrer">
              <ExternalLink className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" /> Official site
            </a>
          </Button>
        ) : null}
      </div>
    </Card>
  );
}

/** A row of toggle chips; one pressed at a time. */
function Chips({ label, options, value, onChange }) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-1.5">
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          aria-pressed={value === option.id}
          onClick={() => onChange(option.id)}
          className={`rounded-full border px-2.5 py-1 text-xs ${
            value === option.id
              ? 'border-foreground bg-foreground text-background'
              : 'border-border text-muted-foreground hover:text-foreground'
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export default function IntegrationsDirectory({ tests }) {
  const { serviceCards, results, data, loading, error, reload } = useServiceCards(tests);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('all');
  const [connection, setConnection] = useState('all');

  const entries = useMemo(
    () =>
      decorateEntries(directoryEntries(), { serviceCards, results, secretsKnown: Boolean(data) }),
    [serviceCards, results, data]
  );

  const used = new Set(entries.map((entry) => entry.category));
  const categories = [
    { id: 'all', label: 'All categories' },
    ...DIRECTORY_CATEGORIES.filter((c) => used.has(c.id)),
  ];
  const shown = filterDirectory(entries, { query, category, connection });
  const connected = entries.filter((entry) => entry.connection === 'connected').length;

  return (
    <div className="space-y-4">
      <p className="max-w-2xl text-sm text-muted-foreground">
        Every external service this site connects to, what it brings, and whether it is connected
        right now. {connected} of {entries.length} connected. Set up opens the service on the
        Services tab, where its keys and its test live.
      </p>
      <div className="flex flex-col gap-3">
        <label className="relative block max-w-md">
          <Search
            className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            type="search"
            aria-label="Search integrations"
            placeholder="Search by name, what it does, or where it is used"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="pl-8"
          />
        </label>
        <Chips label="Category" options={categories} value={category} onChange={setCategory} />
        <Chips
          label="Connection"
          options={CONNECTION_FILTERS}
          value={connection}
          onChange={setConnection}
        />
      </div>

      <KeyStatusNotices
        loading={loading}
        data={data}
        error={error}
        onRetry={reload}
        fallback="connection shows recorded tests and key-free services only; a keyed service with no recorded test reads as not yet tested"
      />

      {shown.length === 0 ? (
        <p className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
          No integration matches. Clear the search or a filter.
        </p>
      ) : (
        <ul
          className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3"
          aria-label="Integrations directory"
        >
          {shown.map((entry) => (
            <li key={entry.id}>
              <DirectoryCard entry={entry} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
