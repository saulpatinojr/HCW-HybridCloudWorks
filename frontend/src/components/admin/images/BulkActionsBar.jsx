/**
 * What you can do to a selection (ADR 0033): toggle tags against each
 * image's OWN tags, move to a folder, set provider or slot, archive or
 * restore, trash or restore, delete permanently. Each button names the count
 * it will touch, and destructive actions go through ConfirmModal with the
 * list of titles so the scope is visible before it happens.
 */
import React, { useMemo, useState } from 'react';
import { Archive, FolderInput, RotateCcw, Tag, Trash2, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import ConfirmModal from '@/components/admin/ConfirmModal';
import { COMMON_PROVIDERS, SLOT_OPTIONS, tagToggleIntent, uniqueTags } from '@/lib/imageGallery';

const selectClass =
  'rounded-md border border-input bg-background px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-ring';

/** Filled when every selected image has the tag, tinted when some do, plain otherwise. */
function tagChipClass(onAll, onSome) {
  if (onAll) return 'border-primary bg-primary text-primary-foreground';
  if (onSome) return 'border-primary/50 bg-primary/10';
  return 'border-border bg-background';
}

export default function BulkActionsBar({
  selectedItems,
  allItems,
  folders,
  busy,
  onClear,
  onSelectAll,
  onBulk,
}) {
  const [newTag, setNewTag] = useState('');
  const [folder, setFolder] = useState('');
  const [provider, setProvider] = useState('');
  const [slot, setSlot] = useState('');
  const [confirm, setConfirm] = useState(null);
  const count = selectedItems.length;
  const tags = useMemo(() => uniqueTags(allItems), [allItems]);
  const anyTrashed = selectedItems.some((item) => item.softDeletedAt);
  const anyArchived = selectedItems.some((item) => item.archivedAt);
  const allHidden = selectedItems.every((item) => item.softDeletedAt || item.archivedAt);

  if (count === 0) return null;

  const toggleTag = (tag) => onBulk('tag', tagToggleIntent(tag, selectedItems));
  const addTag = () => {
    const tag = newTag.trim().toLowerCase();
    if (!tag) return;
    onBulk('tag', { addTags: [tag], removeTags: [] });
    setNewTag('');
  };
  const preview = (
    <ul className="max-h-48 space-y-1 overflow-y-auto rounded-md border border-border p-2 text-xs">
      {selectedItems.map((item) => (
        <li key={item.id} className="truncate">
          {item.title}
          {item.usageCount ? (
            <span className="text-muted-foreground"> — used in {item.usageCount}</span>
          ) : null}
        </li>
      ))}
    </ul>
  );

  return (
    <div
      className="sticky top-2 z-20 space-y-3 rounded-xl border border-primary/40 bg-card p-3 shadow-md"
      role="region"
      aria-label={`${count} selected`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge>{count} selected</Badge>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 text-xs"
          onClick={onSelectAll}
        >
          Select all on page
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 gap-1 text-xs"
          onClick={onClear}
        >
          <X className="h-3 w-3" aria-hidden="true" /> Clear
        </Button>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {(anyArchived || anyTrashed) && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 gap-1 text-xs"
              disabled={busy}
              onClick={() => onBulk('restore')}
            >
              <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" /> Restore {count}
            </Button>
          )}
          {!allHidden && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 gap-1 text-xs"
              disabled={busy}
              onClick={() => onBulk('archive')}
            >
              <Archive className="h-3.5 w-3.5" aria-hidden="true" /> Archive {count}
            </Button>
          )}
          {!anyTrashed && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 gap-1 text-xs"
              disabled={busy}
              onClick={() => setConfirm('trash')}
            >
              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" /> Trash {count}
            </Button>
          )}
          <Button
            type="button"
            size="sm"
            variant="destructive"
            className="h-7 gap-1 text-xs"
            disabled={busy}
            onClick={() => setConfirm('delete')}
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" /> Delete permanently
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        <div className="space-y-1.5">
          <p className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
            <Tag className="h-3 w-3" aria-hidden="true" /> Tags — click to add to every selected
            image; click again when all have it to remove
          </p>
          <div className="flex flex-wrap gap-1">
            {tags.map((tag) => {
              const onAll = selectedItems.every((item) =>
                (item.customTags || []).map((t) => String(t).toLowerCase()).includes(tag)
              );
              const onSome =
                !onAll &&
                selectedItems.some((item) =>
                  (item.customTags || []).map((t) => String(t).toLowerCase()).includes(tag)
                );
              return (
                <button
                  key={tag}
                  type="button"
                  onClick={() => toggleTag(tag)}
                  disabled={busy}
                  aria-pressed={onAll}
                  className={`rounded-full border px-2 py-0.5 text-xs ${tagChipClass(onAll, onSome)}`}
                  title={onAll ? 'Remove from all selected' : 'Add to all selected'}
                >
                  {tag}
                </button>
              );
            })}
            {tags.length === 0 && (
              <span className="text-xs text-muted-foreground">No tags yet.</span>
            )}
          </div>
          <div className="flex gap-1">
            <Input
              value={newTag}
              onChange={(e) => setNewTag(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addTag()}
              placeholder="New tag"
              aria-label="New tag for selected images"
              className="h-7 text-xs"
            />
            <Button
              type="button"
              size="sm"
              className="h-7 text-xs"
              onClick={addTag}
              disabled={busy || !newTag.trim()}
            >
              Add
            </Button>
          </div>
        </div>

        <div className="space-y-1.5">
          <label
            htmlFor="bulk-folder"
            className="flex items-center gap-1 text-xs font-medium text-muted-foreground"
          >
            <FolderInput className="h-3 w-3" aria-hidden="true" /> Move to folder
          </label>
          <div className="flex gap-1">
            <select
              id="bulk-folder"
              value={folder}
              onChange={(e) => setFolder(e.target.value)}
              className={`${selectClass} flex-1`}
            >
              <option value="">Choose a folder…</option>
              {folders.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
            <Button
              type="button"
              size="sm"
              className="h-7 text-xs"
              disabled={busy || !folder}
              onClick={() => onBulk('move', { folder })}
            >
              Move {count}
            </Button>
          </div>
        </div>

        <div className="space-y-1.5">
          <p className="text-xs font-medium text-muted-foreground">Set provider / slot</p>
          <div className="flex flex-wrap gap-1">
            <select
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
              className={selectClass}
              aria-label="Provider for selected images"
            >
              <option value="">Provider unchanged</option>
              {COMMON_PROVIDERS.filter((p) => p.value).map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
            <select
              value={slot}
              onChange={(e) => setSlot(e.target.value)}
              className={selectClass}
              aria-label="Slot for selected images"
            >
              <option value="">Slot unchanged</option>
              {SLOT_OPTIONS.filter((s) => s.value).map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
            <Button
              type="button"
              size="sm"
              className="h-7 text-xs"
              disabled={busy || (!provider && !slot)}
              onClick={() => {
                const fields = {};
                if (provider) fields.provider = provider;
                if (slot) fields.slot = slot;
                onBulk('set', { fields });
                setProvider('');
                setSlot('');
              }}
            >
              Apply to {count}
            </Button>
          </div>
        </div>
      </div>

      <ConfirmModal
        open={confirm === 'trash'}
        title={`Move ${count} image${count === 1 ? '' : 's'} to trash?`}
        description="Trashed images are hidden from every picker and the public site keeps serving the file until it is deleted permanently. You can restore them from the Trash filter."
        preview={preview}
        confirmLabel="Move to trash"
        onConfirm={() => {
          setConfirm(null);
          onBulk('trash');
        }}
        onCancel={() => setConfirm(null)}
      />
      <ConfirmModal
        open={confirm === 'delete'}
        title={`Delete ${count} image${count === 1 ? '' : 's'} permanently?`}
        description="The record and its file are removed, and any content pointing at it loses the image. Files still referenced by another record are kept. This cannot be undone."
        preview={preview}
        confirmLabel="Delete permanently"
        onConfirm={() => {
          setConfirm(null);
          onBulk('delete');
        }}
        onCancel={() => setConfirm(null)}
      />
    </div>
  );
}
