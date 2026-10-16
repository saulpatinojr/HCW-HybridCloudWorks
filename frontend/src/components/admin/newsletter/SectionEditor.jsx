/**
 * SectionEditor — trim and reorder a draft's sections and items. It edits a
 * local copy only; the parent saves it with PATCH.
 *
 * The API accepts removal and reordering and nothing else, matching items by
 * section id and url and refusing any field that differs from the stored one.
 * So this never builds an item: it moves the stored objects around, and
 * `toSectionsPayload` sends them back unchanged. The last remaining item
 * cannot be removed, because the server refuses an issue with none.
 */
import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Trash2, X } from 'lucide-react';

const LAST_ITEM_TITLE = 'An issue needs at least one item, so the last one cannot be removed';

/**
 * What PATCH expects: each section's id and its remaining items, in order.
 * A manual section (one the owner created for their own blocks) carries its
 * title too, because the server has no stored copy to take it from.
 */
export function toSectionsPayload(sections) {
  return sections.map((section) =>
    section.manual
      ? { id: section.id, title: section.title, items: section.items }
      : { id: section.id, items: section.items }
  );
}

/**
 * `sections` with `item` appended to the section `sectionId`, creating the
 * section (with `sectionTitle`, marked manual) when it is not there yet.
 * Pure: the caller holds the result as local state until Save changes.
 */
export function addItemToSections(sections, sectionId, sectionTitle, item) {
  const exists = sections.some((section) => section.id === sectionId);
  if (!exists)
    return [
      ...sections,
      { id: sectionId, title: sectionTitle || sectionId, manual: true, items: [item] },
    ];
  return sections.map((section) =>
    section.id === sectionId
      ? {
          ...section,
          items: [...(section.items || []).filter((row) => row.url !== item.url), item],
        }
      : section
  );
}

/** Section ids and item urls in order: equal signatures mean nothing was edited. */
export function sectionsSignature(sections) {
  return (sections || [])
    .map((section) => `${section.id}:${(section.items || []).map((item) => item.url).join('|')}`)
    .join('\n');
}

function move(list, index, delta) {
  const target = index + delta;
  if (target < 0 || target >= list.length) return list;
  const next = list.slice();
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

function IconButton({ label, title, disabled, onClick, children }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="h-7 w-7 p-0"
      aria-label={label}
      title={title ?? label}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

function SectionBlock({ section, index, count, totalItems, disabled, onChange }) {
  const [open, setOpen] = useState(true);
  const items = section.items || [];
  const name = section.title || section.id;
  const holdsEveryItem = items.length === totalItems;

  const setItems = (next) => onChange({ type: 'items', index, items: next });

  return (
    <li className="rounded-lg border">
      <div className="flex items-center gap-1 px-2 py-1.5">
        <button
          type="button"
          className="flex flex-1 items-center gap-1.5 text-left text-sm font-medium"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {open ? (
            <ChevronDown className="h-3.5 w-3.5 shrink-0" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 shrink-0" />
          )}
          <span className="truncate">{name}</span>
          <span className="text-xs font-normal text-muted-foreground">({items.length})</span>
        </button>
        <IconButton
          label={`Move section ${name} up`}
          disabled={disabled || index === 0}
          onClick={() => onChange({ type: 'move', index, delta: -1 })}
        >
          <ArrowUp className="h-3.5 w-3.5" />
        </IconButton>
        <IconButton
          label={`Move section ${name} down`}
          disabled={disabled || index === count - 1}
          onClick={() => onChange({ type: 'move', index, delta: 1 })}
        >
          <ArrowDown className="h-3.5 w-3.5" />
        </IconButton>
        <IconButton
          label={`Remove section ${name}`}
          title={holdsEveryItem ? LAST_ITEM_TITLE : `Remove section ${name}`}
          disabled={disabled || holdsEveryItem}
          onClick={() => onChange({ type: 'remove', index })}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </IconButton>
      </div>
      {open && (
        <ul className="space-y-1 border-t px-2 py-1.5">
          {items.map((item, itemIndex) => {
            const label = item.title || item.url;
            return (
              <li key={item.url} className="flex items-center gap-1 text-sm">
                <a
                  href={item.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex-1 truncate underline-offset-2 hover:underline"
                >
                  {label}
                </a>
                {item.manual && (
                  <span
                    className="rounded border border-border px-1 text-xs text-muted-foreground"
                    title="Added by hand; not collected from the site"
                  >
                    manual
                  </span>
                )}
                <IconButton
                  label={`Move item ${label} up`}
                  disabled={disabled || itemIndex === 0}
                  onClick={() => setItems(move(items, itemIndex, -1))}
                >
                  <ArrowUp className="h-3.5 w-3.5" />
                </IconButton>
                <IconButton
                  label={`Move item ${label} down`}
                  disabled={disabled || itemIndex === items.length - 1}
                  onClick={() => setItems(move(items, itemIndex, 1))}
                >
                  <ArrowDown className="h-3.5 w-3.5" />
                </IconButton>
                <IconButton
                  label={`Remove item ${label}`}
                  title={totalItems === 1 ? LAST_ITEM_TITLE : `Remove item ${label}`}
                  disabled={disabled || totalItems === 1}
                  onClick={() => setItems(items.filter((_, i) => i !== itemIndex))}
                >
                  <X className="h-3.5 w-3.5" />
                </IconButton>
              </li>
            );
          })}
        </ul>
      )}
    </li>
  );
}

export default function SectionEditor({ sections, disabled, onChange }) {
  const totalItems = sections.reduce((sum, section) => sum + (section.items?.length || 0), 0);

  const apply = (edit) => {
    if (edit.type === 'move') return onChange(move(sections, edit.index, edit.delta));
    if (edit.type === 'remove') return onChange(sections.filter((_, i) => i !== edit.index));
    // A section whose last item goes is a removed section, as on the server.
    const next = sections
      .map((section, i) => (i === edit.index ? { ...section, items: edit.items } : section))
      .filter((section) => section.items?.length);
    return onChange(next);
  };

  if (!sections.length) {
    return <p className="text-sm text-muted-foreground">This issue has no sections.</p>;
  }
  return (
    <ul className="space-y-2" aria-label="Sections">
      {sections.map((section, index) => (
        <SectionBlock
          key={section.id}
          section={section}
          index={index}
          count={sections.length}
          totalItems={totalItems}
          disabled={disabled}
          onChange={apply}
        />
      ))}
    </ul>
  );
}
