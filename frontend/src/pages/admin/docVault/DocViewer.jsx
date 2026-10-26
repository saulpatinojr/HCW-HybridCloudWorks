/**
 * The right column of /admin/doc-vault when a document is open: its details,
 * the two Copy buttons, the text, and its history.
 *
 * The text is shown as plain text, never rendered as markdown or HTML: what is
 * copied is what is on the screen, and a stray tag in a pasted letter cannot
 * become part of the page. Copy gives the text exactly as stored; Copy as plain
 * text gives it without markdown marks (headings, emphasis, link syntax), for a
 * form or an email where the marks would show.
 *
 * History lists the newest ten versions, this one included. An earlier version
 * can be read first (View), then made the newest (Restore). Restoring never
 * deletes: the text it replaces becomes the next entry in History.
 */
import React from 'react';
import { Link } from 'react-router';
import {
  ArrowLeft,
  ExternalLink,
  FileText,
  History,
  Loader2,
  Pencil,
  RotateCcw,
  Trash2,
  Undo2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import CopyButton from './CopyButton';
import {
  KEPT_VERSIONS,
  formatBytes,
  formatWhen,
  isAdminRoute,
  isSafeLink,
  markdownToPlainText,
} from './docVaultModel';

/**
 * The text is shown in a read-only box, not a styled div: a box is reached by
 * the Tab key, scrolls with the arrow keys, and lets Ctrl+A and Ctrl+C take
 * the text as it is, with no extra code. It is as tall as the text up to 28
 * lines, then scrolls.
 */
const textRows = (body) => Math.min(28, Math.max(8, String(body ?? '').split('\n').length + 1));

function RelatedLink({ href }) {
  if (!isSafeLink(href)) return null;
  const className = 'inline-flex items-center gap-1 text-sm underline';
  if (isAdminRoute(href)) {
    return (
      <Link to={href} className={className}>
        Related page in this admin
      </Link>
    );
  }
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={className}>
      Related link <ExternalLink className="h-3 w-3" aria-hidden="true" />
      <span className="sr-only">(opens in a new tab)</span>
    </a>
  );
}

/** The grey line of facts under the title. */
function Facts({ shown, isPreview, newest }) {
  const saved = isPreview ? shown.savedAt : shown.updatedAt;
  const parts = [
    isPreview ? `Version ${shown.version} (an earlier one)` : `Version ${shown.version} (newest)`,
    shown.source === 'uploaded' ? 'from an uploaded file' : 'pasted or typed',
    formatBytes(shown.bodyBytes),
    saved ? `saved ${formatWhen(saved, { withTime: true })}` : '',
    !isPreview && newest?.createdAt ? `first added ${formatWhen(newest.createdAt)}` : '',
    shown.restoredFromVersion ? `restored from version ${shown.restoredFromVersion}` : '',
  ].filter(Boolean);
  return <p className="text-xs text-muted-foreground">{parts.join(' · ')}</p>;
}

function HistoryList({ doc, versions, previewVersion, busy, onView, onRestore, canRestore }) {
  const earlier = versions ?? [];
  return (
    <Card aria-labelledby="doc-history-heading" role="region">
      <CardHeader className="pb-2">
        <CardTitle id="doc-history-heading" className="flex items-center gap-2 text-base">
          <History className="h-4 w-4" aria-hidden="true" /> History
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          The newest {KEPT_VERSIONS} versions are kept, this one included. Restoring an earlier one
          makes it the newest and keeps the text it replaces.
        </p>
      </CardHeader>
      <CardContent>
        <ul aria-label="Versions" className="space-y-2 text-sm">
          <li className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2">
            <span>
              <strong>Version {doc.version}</strong> (newest)
              <span className="block text-xs text-muted-foreground">
                {formatWhen(doc.updatedAt, { withTime: true })} · {formatBytes(doc.bodyBytes)}
              </span>
            </span>
            {previewVersion !== null && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => onView(null)}
                aria-label={`Show version ${doc.version}, the newest`}
              >
                Show
              </Button>
            )}
          </li>
          {earlier.map((entry) => (
            <li
              key={entry.version}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2"
            >
              <span>
                <strong>Version {entry.version}</strong>
                <span className="block text-xs text-muted-foreground">
                  {formatWhen(entry.savedAt, { withTime: true })} · {formatBytes(entry.bodyBytes)} ·{' '}
                  {entry.source === 'uploaded' ? 'uploaded' : 'pasted or typed'}
                  {entry.restoredFromVersion ? ` · restored from ${entry.restoredFromVersion}` : ''}
                </span>
              </span>
              <span className="flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  aria-pressed={previewVersion === entry.version}
                  onClick={() => onView(entry.version)}
                  aria-label={`View version ${entry.version}`}
                >
                  View
                </Button>
                {canRestore && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={Boolean(busy)}
                    onClick={() => onRestore(entry.version)}
                    aria-label={`Restore version ${entry.version}`}
                  >
                    Restore
                  </Button>
                )}
              </span>
            </li>
          ))}
          {earlier.length === 0 && (
            <li className="text-xs text-muted-foreground">
              No earlier versions yet. Saving a change, or adding a document with this title and
              category again, keeps the text it replaces here.
            </li>
          )}
        </ul>
      </CardContent>
    </Card>
  );
}

/**
 * @param {{
 *   doc: object,
 *   versions: object[],
 *   preview: object|null,
 *   busy: string|null,
 *   onEdit: () => void,
 *   onTrash: () => void,
 *   onPutBack: () => void,
 *   onDeleteForever: () => void,
 *   onViewVersion: (version: number|null) => void,
 *   onRestoreVersion: (version: number) => void,
 * }} props
 */
export default function DocViewer({
  doc,
  versions,
  preview,
  busy,
  onEdit,
  onTrash,
  onPutBack,
  onDeleteForever,
  onViewVersion,
  onRestoreVersion,
}) {
  const inTrash = Boolean(doc.deletedAt);
  const shown = preview ?? doc;
  const isPreview = Boolean(preview);
  const working = (name) => busy === name;

  return (
    <div className="space-y-4">
      <Card aria-labelledby="doc-title" role="region">
        <CardHeader className="space-y-2 pb-3">
          <CardTitle id="doc-title" className="flex items-start gap-2 text-xl leading-snug">
            <FileText className="mt-1 h-5 w-5 shrink-0" aria-hidden="true" />
            <span className="break-words">{shown.title}</span>
          </CardTitle>
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full border px-2 py-0.5 text-xs font-medium">
              {shown.category}
            </span>
            {(shown.tags ?? []).map((tag) => (
              <span key={tag} className="rounded bg-muted px-1.5 py-0.5 text-xs">
                {tag}
              </span>
            ))}
          </div>
          <Facts shown={shown} isPreview={isPreview} newest={doc} />
          {shown.relatedLink && <RelatedLink href={shown.relatedLink} />}
        </CardHeader>
        <CardContent className="space-y-4">
          {inTrash && (
            <div
              role="note"
              className="rounded-md border border-amber-400 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200"
            >
              This document is in Trash. It will be removed for good on{' '}
              <strong>{formatWhen(doc.purgeAt)}</strong>. Put it back to edit it.
            </div>
          )}
          {isPreview && (
            <div
              role="note"
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-blue-300 bg-blue-50 px-3 py-2 text-sm text-blue-900 dark:border-blue-800 dark:bg-blue-950/40 dark:text-blue-200"
            >
              <span>
                You are reading version {preview.version}, not the newest (version {doc.version}).
              </span>
              <span className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => onViewVersion(null)}
                >
                  <ArrowLeft className="mr-1 h-4 w-4" aria-hidden="true" /> Back to the newest
                </Button>
                {!inTrash && (
                  <Button
                    type="button"
                    size="sm"
                    disabled={Boolean(busy)}
                    onClick={() => onRestoreVersion(preview.version)}
                  >
                    {working('restore') ? (
                      <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                    ) : (
                      <RotateCcw className="mr-1 h-4 w-4" aria-hidden="true" />
                    )}
                    Restore this version
                  </Button>
                )}
              </span>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <CopyButton
              getText={() => shown.body}
              label="Copy the text"
              variant="default"
              size="lg"
            >
              Copy
            </CopyButton>
            <CopyButton
              getText={() => markdownToPlainText(shown.body)}
              label="Copy as plain text"
              variant="outline"
              size="lg"
            >
              Copy as plain text
            </CopyButton>
          </div>
          <p className="text-xs text-muted-foreground">
            Copy gives the text exactly as saved. Copy as plain text drops the markdown marks
            (headings, bold, link syntax) for a form or an email.
          </p>

          <Textarea
            readOnly
            aria-label="Document text"
            value={shown.body}
            rows={textRows(shown.body)}
            spellCheck={false}
            className="w-full resize-y bg-muted/30 text-sm leading-relaxed"
          />

          <div className="flex flex-wrap gap-2 border-t pt-3">
            {!inTrash && !isPreview && (
              <Button type="button" size="sm" variant="outline" onClick={onEdit} className="gap-1">
                <Pencil className="h-4 w-4" aria-hidden="true" /> Edit
              </Button>
            )}
            {!inTrash && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={Boolean(busy)}
                onClick={onTrash}
                className="gap-1"
              >
                {working('trash') ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                )}
                Move to Trash
              </Button>
            )}
            {inTrash && (
              <>
                <Button
                  type="button"
                  size="sm"
                  disabled={Boolean(busy)}
                  onClick={onPutBack}
                  className="gap-1"
                >
                  {working('untrash') ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Undo2 className="h-4 w-4" aria-hidden="true" />
                  )}
                  Put back
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="destructive"
                  disabled={Boolean(busy)}
                  onClick={onDeleteForever}
                  className="gap-1"
                >
                  {working('forever') ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                  )}
                  Delete forever
                </Button>
              </>
            )}
          </div>
        </CardContent>
      </Card>

      <HistoryList
        doc={doc}
        versions={versions}
        previewVersion={preview ? preview.version : null}
        busy={busy}
        canRestore={!inTrash}
        onView={onViewVersion}
        onRestore={onRestoreVersion}
      />
    </div>
  );
}
