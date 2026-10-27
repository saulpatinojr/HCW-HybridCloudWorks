/**
 * Import evidence from Speaking, Certifications or Published content
 * (ADR 0033 §5: Speaking + Certifications → Ambassador evidence). The picker
 * lists what the source holds and marks what is already imported, so the same
 * talk is never two evidence rows; the API is idempotent on
 * (sourceModule, sourceId) besides. Chosen programs are stamped on every
 * imported row; none means "counts for every program".
 */
import React, { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Loader2 } from 'lucide-react';
import { TabError, TabLoading } from '@/components/admin/integrations/TabNotice';
import useGuardedLoad from '@/components/admin/shared/useGuardedLoad';
import { sourceLabel } from './ambassadorModel';
import { ProgramsFieldset } from './Parts';
import { loadImportSources } from './useAmbassadorData';

const NO_ROWS = Object.freeze([]);
const describeError = (err) => `Could not read the source: ${err?.message}`;

export default function ImportDialog({ sourceModule, programs, onClose, onImport, importing }) {
  const load = useMemo(() => () => loadImportSources(sourceModule), [sourceModule]);
  const sources = useGuardedLoad(load, { empty: NO_ROWS, describeError });
  const [chosen, setChosen] = useState(() => new Set());
  const [programIds, setProgramIds] = useState([]);
  const [search, setSearch] = useState('');

  const rows = sources.data.filter(
    (row) => !search || row.title.toLowerCase().includes(search.toLowerCase())
  );
  const available = rows.filter((row) => !row.imported);
  const toggle = (id) =>
    setChosen((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !importing) onClose();
      }}
    >
      <DialogContent className="w-[calc(100%-2rem)] min-w-0 [&>*]:min-w-0 max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Import from {sourceLabel(sourceModule)}</DialogTitle>
          <DialogDescription>
            Each chosen item becomes one evidence row with a snapshot of what the source says today.
            Items already imported are marked and cannot be imported twice.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label className="text-xs" htmlFor="import-search">
              Search
            </Label>
            <Input
              id="import-search"
              className="h-8 text-xs"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Title…"
            />
          </div>
          {sources.loading && (
            <TabLoading>Reading {sourceLabel(sourceModule).toLowerCase()}…</TabLoading>
          )}
          {sources.error && <TabError message={sources.error} onRetry={sources.refresh} />}
          {sources.loaded && rows.length === 0 && (
            <p className="text-sm text-muted-foreground">
              Nothing to import{search ? ' matches that search' : ''}.
            </p>
          )}
          {sources.loaded && rows.length > 0 && (
            <>
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>
                  {available.length} available · {rows.length - available.length} already imported
                </span>
                <button
                  type="button"
                  className="underline"
                  onClick={() => setChosen(new Set(available.map((r) => r.id)))}
                >
                  Select all available
                </button>
              </div>
              <ul className="max-h-72 space-y-1 overflow-y-auto rounded-md border border-border p-2">
                {rows.map((row) => (
                  <li key={row.id} className="flex items-center gap-2 text-sm">
                    <input
                      id={`import-${row.id}`}
                      type="checkbox"
                      checked={row.imported || chosen.has(row.id)}
                      disabled={row.imported}
                      onChange={() => toggle(row.id)}
                    />
                    <label
                      htmlFor={`import-${row.id}`}
                      className={row.imported ? 'text-muted-foreground' : ''}
                    >
                      {row.title}{' '}
                      <span className="text-xs text-muted-foreground">
                        · {row.date || 'undated'}
                        {row.imported ? ' · already imported' : ''}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            </>
          )}
          <ProgramsFieldset programs={programs} value={programIds} onChange={setProgramIds} />
        </div>
        <DialogFooter className="gap-2 sm:gap-0">
          <Button type="button" variant="outline" onClick={onClose} disabled={importing}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={chosen.size === 0 || importing}
            onClick={async () => {
              if (await onImport([...chosen], programIds)) onClose();
            }}
          >
            {importing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Import {chosen.size || ''} {chosen.size === 1 ? 'item' : 'items'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
