/**
 * Search, filters, sort and the state tabs (Active / Archived / Trash) for
 * the gallery. Every control is labelled; the counts come from the server's
 * facets so the tabs say how many are in each state before you click.
 */
import React from 'react';
import { RefreshCw, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { getSourceLabel, SORT_OPTIONS, STATE_OPTIONS } from '@/lib/imageGallery';

const selectClass =
  'w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring';

function FilterSelect({ id, label, value, onChange, options, allLabel }) {
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="text-xs font-medium text-muted-foreground">
        {label}
      </label>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={selectClass}
      >
        <option value="all">{allLabel}</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}

export default function GalleryToolbar({
  filters,
  onChange,
  facets,
  folders,
  providerValues,
  slotValues,
  tagValues,
  loading,
  onRefresh,
  summary,
}) {
  const set = (key) => (value) => onChange({ ...filters, [key]: value, offset: 0 });
  const counts = facets?.counts || {};
  const sources = (facets?.sources || []).map((id) => ({ value: id, label: getSourceLabel(id) }));
  const sets = (facets?.sets || []).map((name) => ({ value: name, label: name }));

  return (
    <div className="space-y-3 rounded-xl border border-border bg-card p-4">
      <div className="flex flex-wrap items-center gap-2" role="tablist" aria-label="Image state">
        {STATE_OPTIONS.map((option) => {
          const active = filters.state === option.value;
          const count = option.value === 'all' ? undefined : counts[option.value];
          return (
            <button
              key={option.value}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => set('state')(option.value)}
              className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                active
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-border bg-background text-muted-foreground hover:text-foreground'
              }`}
            >
              {option.label}
              {typeof count === 'number' ? ` (${count})` : ''}
            </button>
          );
        })}
        <div className="ml-auto flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onRefresh}
            disabled={loading}
            className="gap-1.5"
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`}
              aria-hidden="true"
            />{' '}
            Refresh
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <div className="space-y-1 md:col-span-3 xl:col-span-2">
          <label htmlFor="gallery-search" className="text-xs font-medium text-muted-foreground">
            Search
          </label>
          <div className="relative">
            <Search
              className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              id="gallery-search"
              value={filters.q}
              onChange={(e) => set('q')(e.target.value)}
              placeholder="Title, alt text, tags, prompt, set, URL"
              className="pl-8"
            />
          </div>
        </div>
        <FilterSelect
          id="gallery-folder"
          label="Folder"
          value={filters.folder}
          onChange={set('folder')}
          allLabel="All folders"
          options={folders.map((folder) => ({ value: folder, label: folder }))}
        />
        <FilterSelect
          id="gallery-source"
          label="Source"
          value={filters.source}
          onChange={set('source')}
          allLabel="All sources"
          options={sources}
        />
        <FilterSelect
          id="gallery-provider"
          label="Provider"
          value={filters.provider}
          onChange={set('provider')}
          allLabel="All providers"
          options={providerValues.map((value) => ({ value: value.toLowerCase(), label: value }))}
        />
        <FilterSelect
          id="gallery-slot"
          label="Slot"
          value={filters.slot}
          onChange={set('slot')}
          allLabel="All slots"
          options={slotValues.map((value) => ({ value, label: value }))}
        />
        <FilterSelect
          id="gallery-tag"
          label="Tag"
          value={filters.tag}
          onChange={set('tag')}
          allLabel="All custom tags"
          options={tagValues.map((value) => ({ value, label: value }))}
        />
        {sets.length > 0 && (
          <FilterSelect
            id="gallery-set"
            label="Image set"
            value={filters.set || 'all'}
            onChange={(value) => set('set')(value === 'all' ? '' : value)}
            allLabel="Any set"
            options={sets}
          />
        )}
        <div className="space-y-1">
          <label htmlFor="gallery-sort" className="text-xs font-medium text-muted-foreground">
            Sort
          </label>
          <select
            id="gallery-sort"
            value={filters.sort}
            onChange={(e) => set('sort')(e.target.value)}
            className={selectClass}
          >
            {SORT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      {summary && <p className="text-xs text-muted-foreground">{summary}</p>}
    </div>
  );
}
