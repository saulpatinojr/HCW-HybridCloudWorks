/**
 * One row of Live Pages: a live page's title, badges and URL, with Open
 * Editor, Archive and Open Live Page. Its own module so the page's
 * truncation tests can stand a trivial element in for it (#1194): the banner
 * reads only how many records came back, and five hundred full rows in jsdom
 * cost seconds a loaded machine does not have.
 */
import React from 'react';
import { Link } from 'react-router';
import { Archive, ExternalLink } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import RoleGate from '@/components/admin/RoleGate';
import StatusBadge from '@/components/admin/shared/StatusBadge';
import TaxonomyChips from '@/components/admin/shared/TaxonomyChips';
import { safeUrl } from '@/lib/safeUrl';
import { getLiveUrl } from '@/lib/livePages';
import { editorTargetId, getProvider, getTitle, getTypeLabel } from './liveItems';

/** One live page: its title, badges and URL, with Open Editor, Archive and Open Live Page. */
export default function LivePageRow({ item, archiving, archiveBlockedReason, onArchive }) {
  const liveUrl = getLiveUrl(item);
  return (
    <div className="flex flex-col gap-3 rounded-lg border p-4 lg:flex-row lg:items-center">
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">{getTitle(item)}</p>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <StatusBadge content={item} />
          <Badge variant="outline">{getProvider(item)}</Badge>
          <Badge variant="secondary">{getTypeLabel(item)}</Badge>
          <TaxonomyChips item={item} />
        </div>
        <a
          href={safeUrl(liveUrl, '#')}
          target={liveUrl ? '_blank' : undefined}
          rel={liveUrl ? 'noreferrer' : undefined}
          className={`mt-2 block truncate text-sm ${liveUrl ? 'text-blue-600 hover:underline' : 'text-muted-foreground'}`}
        >
          {liveUrl || 'Live URL unavailable on record'}
        </a>
      </div>

      <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" asChild>
          <Link to={`/admin/editor/${editorTargetId(item)}`}>Open Editor</Link>
        </Button>
        {/* No confirm step: Archive is reversible from the toast it raises
            (AP-F13, #937). A row the API would refuse — a legacy blog with
            no content record behind it, or a live page in a status with no
            edge to archived — has the button disabled, and its title says
            why. Taking a page off the site is a publisher's edge
            (lib/cms/content-update.js), so below that role the gate says
            why first (AP-F4). */}
        <RoleGate minRole="publisher" reason="Taking a page off the site needs the publisher role.">
          <Button
            size="sm"
            variant="outline"
            onClick={() => onArchive(item)}
            disabled={archiving || Boolean(archiveBlockedReason)}
            title={archiveBlockedReason || undefined}
          >
            <Archive className="mr-2 h-4 w-4" />
            {archiving ? 'Archiving…' : 'Archive'}
          </Button>
        </RoleGate>
        {liveUrl && (
          <Button size="sm" asChild>
            <a href={safeUrl(liveUrl)} target="_blank" rel="noreferrer">
              <ExternalLink className="mr-2 h-4 w-4" />
              Open Live Page
            </a>
          </Button>
        )}
      </div>
    </div>
  );
}
