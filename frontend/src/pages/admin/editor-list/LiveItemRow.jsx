/**
 * One row of the Editor list's live board: cover, title, badges and date,
 * with View live page, Edit, Unpublish and Archive. Its own module so the
 * page's truncation tests can stand a trivial element in for it (#1194): the
 * banner reads only how long each board came back, and five hundred full
 * rows in jsdom cost seconds a loaded machine does not have.
 */
import React from 'react';
import { Link } from 'react-router';
import { Archive, ExternalLink, EyeOff, Loader2, PenLine } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import StatusBadge from '@/components/admin/shared/StatusBadge';
import TaxonomyChips from '@/components/admin/shared/TaxonomyChips';
import { getCoverImageUrl, formatPostDate } from '@/lib/blogUtils';
import { safeUrl } from '@/lib/safeUrl';
import { TYPE_BADGE, getContentType, getProviderDisplay, getPublicUrl } from './editorItems';

/** A live item, with its public link, Edit, and Unpublish and Archive, each of which the page confirms first. */
export default function LiveItemRow({ item, onArchive, onUnpublish, actionId }) {
  const coverUrl = getCoverImageUrl(item);
  const type = getContentType(item);
  const publicUrl = getPublicUrl(item);
  const provider = getProviderDisplay(item);
  const title = item.Title || item.title || 'Untitled';
  const isActing = actionId === item.id;

  return (
    <div className="flex items-center gap-3 px-4 py-3 rounded-lg border bg-card hover:bg-muted/40 transition-colors">
      {coverUrl ? (
        <img
          src={safeUrl(coverUrl)}
          alt=""
          className="h-12 w-16 object-cover rounded shrink-0"
          loading="lazy"
        />
      ) : (
        <div className="h-12 w-16 rounded bg-muted shrink-0 flex items-center justify-center">
          <PenLine className="h-4 w-4 text-muted-foreground" />
        </div>
      )}

      <div className="flex-1 min-w-0">
        <p className="font-medium text-sm truncate">{title}</p>
        <div className="flex items-center gap-2 mt-0.5 flex-wrap">
          <StatusBadge content={item} size="xs" />
          <Badge variant="outline" className="text-xs">
            {provider}
          </Badge>
          <span
            className={`inline-flex px-1.5 py-0.5 rounded text-[11px] font-medium ${TYPE_BADGE[type] || TYPE_BADGE.blog}`}
          >
            {type}
          </span>
          <TaxonomyChips item={item} />
          <span className="text-xs text-muted-foreground">
            {formatPostDate(item.blogPublishedAt)}
          </span>
        </div>
      </div>

      <div className="flex items-center gap-1.5 shrink-0">
        {publicUrl && (
          <a
            href={safeUrl(publicUrl)}
            target="_blank"
            rel="noopener noreferrer"
            className="p-1.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
            title="View live page"
          >
            <ExternalLink className="h-4 w-4" />
          </a>
        )}
        <Link
          to={`/admin/editor/${item.id}`}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-primary/10 text-primary hover:bg-primary/20 text-xs font-medium transition-colors"
        >
          <PenLine className="h-3.5 w-3.5" />
          Edit
        </Link>
        <Button
          size="sm"
          variant="outline"
          className="gap-1 text-xs"
          disabled={isActing}
          onClick={() => onUnpublish(item)}
          title="Unpublish — removes from live site and returns to Publish queue"
        >
          {isActing ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <EyeOff className="h-3.5 w-3.5" />
          )}
          Unpublish
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="gap-1 text-xs text-muted-foreground hover:text-foreground"
          disabled={isActing}
          onClick={() => onArchive(item)}
          title="Archive — move to archive board"
        >
          {isActing ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Archive className="h-3.5 w-3.5" />
          )}
          Archive
        </Button>
      </div>
    </div>
  );
}
