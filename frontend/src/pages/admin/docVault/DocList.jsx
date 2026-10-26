/**
 * The left column of /admin/doc-vault: the Documents / Trash switch, the
 * search words and the two filters, and the rows. A row is a button that opens
 * the document; it shows the title, the category, the version, the size and
 * the date, and the first few tags. The filters work on the list the page
 * already has (a few hundred rows of titles and tags, never the text), so
 * typing answers at once.
 */
import React from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  CATEGORIES,
  EMPTY_FILTERS,
  LIST_LIMIT,
  anyFilter,
  formatBytes,
  formatWhen,
} from './docVaultModel';

const SELECT_CLASS =
  'h-10 w-full rounded-md border border-input bg-background px-3 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2';

const SHOWN_TAGS = 4;

function Row({ doc, selected, onSelect, inTrash }) {
  const extra = Math.max(0, (doc.tags ?? []).length - SHOWN_TAGS);
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(doc.id)}
        aria-current={selected ? 'true' : undefined}
        className={`w-full rounded-lg border p-2 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
          selected ? 'border-primary bg-primary/5 dark:bg-primary/10' : 'hover:bg-muted/40'
        }`}
      >
        <span className="flex items-start justify-between gap-2">
          <span className="line-clamp-2 font-medium leading-snug">{doc.title}</span>
          <span className="shrink-0 rounded-full border px-2 py-0.5 text-xs">{doc.category}</span>
        </span>
        <span className="mt-0.5 block text-xs text-muted-foreground">
          Version {doc.version} · {formatBytes(doc.bodyBytes)}
          {doc.updatedAt ? ` · ${formatWhen(doc.updatedAt)}` : ''}
          {inTrash && doc.purgeAt ? ` · gone for good ${formatWhen(doc.purgeAt)}` : ''}
        </span>
        {(doc.tags ?? []).length > 0 && (
          <span className="mt-1 flex flex-wrap gap-1">
            {doc.tags.slice(0, SHOWN_TAGS).map((tag) => (
              <span key={tag} className="rounded bg-muted px-1.5 py-0.5 text-xs">
                {tag}
              </span>
            ))}
            {extra > 0 && <span className="text-xs text-muted-foreground">+{extra} more</span>}
          </span>
        )}
      </button>
    </li>
  );
}

/** What an empty list says, for each reason it can be empty. */
function emptyMessage({ filtered, inTrash }) {
  if (filtered) return 'Nothing matches that search. Clear it to see everything.';
  if (inTrash) return 'Trash is empty. A deleted document waits here for 30 days.';
  return 'The vault is empty. Use Paste a document or Upload files to add the first one.';
}

/**
 * @param {{
 *   view: 'active'|'trash',
 *   onView: (view: string) => void,
 *   documents: object[],
 *   shown: object[],
 *   counts: Record<string, number>,
 *   tags: Array<{ tag: string, count: number }>,
 *   total: number,
 *   truncated: boolean,
 *   filters: { q: string, category: string, tag: string },
 *   onFilters: (filters: object) => void,
 *   selectedId: string|null,
 *   onSelect: (id: string) => void,
 *   loading: boolean,
 * }} props
 */
export default function DocList({
  view,
  onView,
  shown,
  counts,
  tags,
  total,
  truncated,
  filters,
  onFilters,
  selectedId,
  onSelect,
  loading,
}) {
  const inTrash = view === 'trash';
  const filtered = anyFilter(filters);
  const set = (field) => (event) => onFilters({ ...filters, [field]: event.target.value });

  return (
    <Card aria-labelledby="doc-list-heading" role="region">
      <CardHeader className="space-y-3 pb-3">
        <CardTitle id="doc-list-heading" className="text-base">
          {inTrash ? 'Trash' : 'Documents'}
          {!loading && (
            <span className="ml-2 text-sm font-normal text-muted-foreground">{total}</span>
          )}
        </CardTitle>
        <div className="flex gap-2" role="group" aria-label="Which documents">
          <Button
            type="button"
            size="sm"
            variant={inTrash ? 'outline' : 'default'}
            aria-pressed={!inTrash}
            onClick={() => onView('active')}
          >
            Documents
          </Button>
          <Button
            type="button"
            size="sm"
            variant={inTrash ? 'default' : 'outline'}
            aria-pressed={inTrash}
            onClick={() => onView('trash')}
          >
            Trash
          </Button>
        </div>
        <div className="space-y-1">
          <Label htmlFor="doc-search">Search the vault</Label>
          <Input
            id="doc-search"
            type="search"
            value={filters.q}
            onChange={set('q')}
            placeholder="Title, tag or category"
            autoComplete="off"
          />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <Label htmlFor="doc-category">Filter by category</Label>
            <select
              id="doc-category"
              className={SELECT_CLASS}
              value={filters.category}
              onChange={set('category')}
            >
              <option value="">All categories</option>
              {CATEGORIES.map((category) => (
                <option key={category} value={category}>
                  {category} ({counts[category] ?? 0})
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="doc-tag">Filter by tag</Label>
            <select id="doc-tag" className={SELECT_CLASS} value={filters.tag} onChange={set('tag')}>
              <option value="">All tags</option>
              {tags.map(({ tag, count }) => (
                <option key={tag} value={tag}>
                  {tag} ({count})
                </option>
              ))}
            </select>
          </div>
        </div>
        {filtered && (
          <Button type="button" variant="ghost" size="sm" onClick={() => onFilters(EMPTY_FILTERS)}>
            Clear the search and filters
          </Button>
        )}
      </CardHeader>
      <CardContent>
        {loading && (
          <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </p>
        )}
        {!loading && shown.length === 0 && (
          <p className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
            {emptyMessage({ filtered, inTrash })}
          </p>
        )}
        {!loading && shown.length > 0 && (
          <ul aria-label={inTrash ? 'Documents in Trash' : 'Documents'} className="space-y-2">
            {shown.map((doc) => (
              <Row
                key={doc.id}
                doc={doc}
                selected={doc.id === selectedId}
                onSelect={onSelect}
                inTrash={inTrash}
              />
            ))}
          </ul>
        )}
        {truncated && (
          <p className="mt-3 text-xs text-muted-foreground">
            The vault holds more than {LIST_LIMIT} documents; only the newest {LIST_LIMIT} are
            listed.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
