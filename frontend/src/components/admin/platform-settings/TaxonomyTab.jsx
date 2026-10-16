/**
 * Content types & idea origins — the two editorial dimensions every content
 * record can carry (ADR 0033 §4), one list each:
 *
 *   Kinds         WHAT an item will become: article, tutorial, newsletter…
 *   Idea origins  HOW it became an idea: manual, audience question, RSS feed…
 *
 * Both are stored in admin_config/content_taxonomy and read by every picker
 * and list that classifies content. An entry can be renamed, described,
 * reordered, disabled or added. A built-in entry cannot be removed — a record
 * classified years ago must still resolve to a label — so the server refuses
 * a save without it, and this tab offers Disable instead of Remove for them.
 */

import React, { useMemo, useState } from 'react';
import { useAuthReady } from '@/hooks/useAuthReady';
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { ArrowDown, ArrowUp, Plus, Shapes, Sparkles, Trash2 } from 'lucide-react';
import { DEFAULT_IDEA_ORIGINS, DEFAULT_KINDS, resetTaxonomyCache } from '@/lib/taxonomy';
import { SETTING_LABELS, SaveRow, SettingSection, StoredState, useSetting } from './settingShared';

const BUILT_IN = {
  kinds: new Set(DEFAULT_KINDS.map((k) => k.id)),
  ideaOrigins: new Set(DEFAULT_IDEA_ORIGINS.map((o) => o.id)),
};

/** A new entry's id from its label: lower-case, hyphens, 2-40 characters. */
export function slugify(label) {
  return String(label || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

function move(list, from, to) {
  if (to < 0 || to >= list.length) return list;
  const copy = [...list];
  const [item] = copy.splice(from, 1);
  copy.splice(to, 0, item);
  return copy;
}

/**
 * One editable list. `field` is `kinds` or `ideaOrigins`; the parent owns
 * the whole working copy so one Save stores both lists.
 */
export function TaxonomyList({ field, title, icon: Icon, blurb, entries, onChange, disabled }) {
  const [newLabel, setNewLabel] = useState('');
  const ids = useMemo(() => new Set(entries.map((e) => e.id)), [entries]);
  const newId = slugify(newLabel);
  const canAdd = newId.length >= 2 && !ids.has(newId);
  const enabledCount = entries.filter((e) => e.enabled !== false).length;

  const update = (index, patch) =>
    onChange(entries.map((e, i) => (i === index ? { ...e, ...patch } : e)));

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <Icon className="h-5 w-5" aria-hidden="true" /> {title}
        </CardTitle>
        <CardDescription>{blurb}</CardDescription>
        <p className="text-xs text-muted-foreground">
          {enabledCount} of {entries.length} offered in pickers. Order here is the order a picker
          shows.
        </p>
      </CardHeader>
      <CardContent className="space-y-2">
        <ul className="space-y-2" aria-label={title}>
          {entries.map((entry, index) => {
            const builtIn = BUILT_IN[field].has(entry.id);
            const off = entry.enabled === false;
            return (
              <li
                key={entry.id}
                className={`grid gap-2 rounded-lg border p-3 sm:grid-cols-[auto_1fr_auto] sm:items-start ${
                  off ? 'border-border/60 bg-muted/30' : 'border-border'
                }`}
              >
                <div className="flex items-center gap-1 sm:flex-col">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    aria-label={`Move ${entry.label} up`}
                    disabled={disabled || index === 0}
                    onClick={() => onChange(move(entries, index, index - 1))}
                  >
                    <ArrowUp className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    aria-label={`Move ${entry.label} down`}
                    disabled={disabled || index === entries.length - 1}
                    onClick={() => onChange(move(entries, index, index + 1))}
                  >
                    <ArrowDown className="h-3.5 w-3.5" />
                  </Button>
                </div>
                <div className="min-w-0 space-y-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <Input
                      value={entry.label}
                      onChange={(e) => update(index, { label: e.target.value })}
                      disabled={disabled}
                      aria-label={`Label for ${entry.id}`}
                      className="h-8 max-w-xs text-sm"
                    />
                    <code className="text-xs text-muted-foreground">{entry.id}</code>
                    {builtIn && (
                      <span className="rounded-full border px-1.5 text-xs text-muted-foreground">
                        built-in
                      </span>
                    )}
                  </div>
                  <Input
                    value={entry.description || ''}
                    onChange={(e) => update(index, { description: e.target.value })}
                    disabled={disabled}
                    placeholder="One sentence a new user reads in the picker"
                    aria-label={`Description for ${entry.id}`}
                    className="h-8 text-xs"
                  />
                </div>
                <div className="flex items-center gap-2 sm:flex-col sm:items-end">
                  <label className="flex items-center gap-2 text-xs">
                    <Switch
                      checked={!off}
                      onCheckedChange={(checked) => update(index, { enabled: checked })}
                      disabled={disabled}
                      aria-label={`${entry.label} offered in pickers`}
                    />
                    {off ? 'Off' : 'On'}
                  </label>
                  {!builtIn && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 text-xs text-destructive"
                      disabled={disabled}
                      onClick={() => onChange(entries.filter((_, i) => i !== index))}
                      title="Remove this custom entry. Records already using it will show its id."
                    >
                      <Trash2 className="mr-1 h-3 w-3" /> Remove
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
        <form
          className="flex flex-wrap items-center gap-2 pt-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!canAdd) return;
            onChange([
              ...entries,
              { id: newId, label: newLabel.trim(), description: '', enabled: true },
            ]);
            setNewLabel('');
          }}
        >
          <Input
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
            disabled={disabled}
            placeholder={`Add a ${field === 'kinds' ? 'kind' : 'n origin'}…`}
            aria-label={`New ${field === 'kinds' ? 'kind' : 'idea origin'} label`}
            className="h-8 max-w-xs text-sm"
          />
          {newLabel && (
            <code className="text-xs text-muted-foreground">
              {newId || '…'}
              {ids.has(newId) ? ' (already exists)' : ''}
            </code>
          )}
          <Button type="submit" size="sm" variant="outline" disabled={disabled || !canAdd}>
            <Plus className="mr-1 h-3.5 w-3.5" /> Add
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

export default function TaxonomyTab() {
  const { authReady } = useAuthReady();
  const setting = useSetting('content-taxonomy', authReady);

  const strip = (list) =>
    (list ?? []).map(({ id, label, description, enabled }) => ({
      id,
      label,
      description,
      enabled: enabled !== false,
    }));

  const onSubmit = async (event) => {
    event.preventDefault();
    const { value } = setting;
    if (!value) return;
    const saved = await setting.save({
      kinds: strip(value.kinds),
      ideaOrigins: strip(value.ideaOrigins),
    });
    if (saved) resetTaxonomyCache();
  };

  return (
    <SettingSection
      setting={setting}
      label={SETTING_LABELS['content-taxonomy']}
      render={({ value, setValue, saving, meta }) => (
        <form onSubmit={onSubmit} className="space-y-6">
          <div className="space-y-1">
            <h2 className="text-lg font-semibold">{SETTING_LABELS['content-taxonomy']}</h2>
            <p className="max-w-3xl text-sm text-muted-foreground">
              Two separate questions about every piece of content: what will it become, and how did
              it become an idea? Keeping them apart is what lets the pipeline treat a tutorial that
              came from an audience question differently from one that came from a certification
              objective.
            </p>
            <StoredState meta={meta} />
          </div>
          <TaxonomyList
            field="kinds"
            title="Kinds — what an item will become"
            icon={Shapes}
            blurb="Offered on New Content, Drafts and in Forge Studio. Editorial only: where an item publishes is still its type (blog, framework, architecture, Coder Corner)."
            entries={value?.kinds ?? []}
            onChange={(kinds) => setValue({ ...(value ?? {}), kinds })}
            disabled={saving}
          />
          <TaxonomyList
            field="ideaOrigins"
            title="Idea origins — how it became an idea"
            icon={Sparkles}
            blurb="Offered on the same screens, and derived for older records from where they came in (a feed, an import, a recording)."
            entries={value?.ideaOrigins ?? []}
            onChange={(ideaOrigins) => setValue({ ...(value ?? {}), ideaOrigins })}
            disabled={saving}
          />
          <SaveRow saving={saving} disabled={!value}>
            <span className="text-xs text-muted-foreground">
              Saving replaces both lists. Built-in entries can be turned off, never removed.
            </span>
          </SaveRow>
        </form>
      )}
    />
  );
}
