/**
 * Pick an image from the gallery into content (review board, editor
 * metadata, Linkie post). Reads the same listing the Image Gallery page
 * does — active images only, so an archived or trashed image is never
 * offered — with the search done server-side (title, alt text, tags,
 * prompt, set) and the set an image came from shown on its card.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Plus, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import EmptyState from '@/components/admin/shared/EmptyState';
import { loadGalleryItems, getSourceLabel } from '@/lib/imageGallery';
import { resolveMediaUrl } from '../../lib/functionsBase';

/** The non-grid states, or null when the grid should render. */
function pickerState({ error, loading, empty, filtered, retry }) {
  if (error) {
    return (
      <EmptyState
        compact
        variant="error"
        title="Gallery unavailable"
        description={error}
        onRetry={retry}
      />
    );
  }
  if (loading) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Loading gallery…
      </p>
    );
  }
  if (empty) {
    return (
      <EmptyState
        compact
        variant={filtered ? 'filtered' : 'empty'}
        title={filtered ? 'No gallery images match' : 'The gallery is empty'}
        description={
          filtered
            ? 'Try another word, or clear the search to see every active image.'
            : 'Upload or import images on the Image Gallery page and they appear here.'
        }
      />
    );
  }
  return null;
}

export function ImageGalleryPicker({ onSelect, provider = '', title = 'Add From Image Gallery' }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [refreshToken, setRefreshToken] = useState(0);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 250);
    return () => clearTimeout(timer);
  }, [query]);

  // A read is "silent" (spinner on the refresh button, list kept) once
  // something is on screen; the first read shows the loading line instead.
  // The ref is written when a read lands, so it is never read during render.
  const hasItems = useRef(false);
  const read = useCallback(async (params, isStale) => {
    if (hasItems.current) setRefreshing(true);
    else setLoading(true);
    try {
      const next = await loadGalleryItems(params);
      if (isStale()) return;
      hasItems.current = next.length > 0;
      setItems(next);
      setError('');
    } catch (err) {
      if (!isStale()) setError(err?.message || 'The gallery could not be read.');
    } finally {
      if (!isStale()) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    // The read marks itself pending — the one state write a fetching effect makes.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    read(
      { q: debounced, provider: provider.trim().toLowerCase() || undefined, limit: 48 },
      () => cancelled
    );
    return () => {
      cancelled = true;
    };
  }, [debounced, provider, refreshToken, read]);

  const visible = useMemo(() => items.slice(0, 24), [items]);

  return (
    <div className="rounded-lg border border-border p-3 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-medium">{title}</p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setRefreshToken((n) => n + 1)}
          aria-label="Refresh gallery"
        >
          {refreshing ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
          )}
        </Button>
      </div>

      <Input
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search by title, alt text, tag, prompt or set…"
        aria-label="Search the image gallery"
      />

      {pickerState({
        error,
        loading,
        empty: visible.length === 0,
        filtered: Boolean(debounced || provider),
        retry: () => setRefreshToken((n) => n + 1),
      }) || (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 max-h-96 overflow-y-auto pr-1">
          {visible.map((item) => (
            <div key={item.id} className="rounded-md border border-border p-2 space-y-2">
              <img
                src={resolveMediaUrl(item.imageUrl)}
                alt={item.altText || item.title || item.articleId}
                loading="lazy"
                className="h-28 w-full rounded object-cover"
              />
              <div className="flex flex-wrap gap-1">
                <Badge variant="outline" className="text-xs">
                  {getSourceLabel(item.source || item.sourceCollection)}
                </Badge>
                {item.provider && (
                  <Badge variant="secondary" className="text-xs">
                    {item.provider}
                  </Badge>
                )}
                {item.slot && (
                  <Badge variant="secondary" className="text-xs">
                    {item.slot}
                  </Badge>
                )}
                {item.promptSet && (
                  <Badge variant="secondary" className="text-xs" title="Image set">
                    {item.promptSet}
                  </Badge>
                )}
              </div>
              <p className="text-xs font-medium truncate" title={item.title}>
                {item.title || item.articleId}
              </p>
              <Button type="button" size="sm" className="w-full" onClick={() => onSelect(item)}>
                <Plus className="h-4 w-4 mr-2" aria-hidden="true" />
                Add Image
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default ImageGalleryPicker;
