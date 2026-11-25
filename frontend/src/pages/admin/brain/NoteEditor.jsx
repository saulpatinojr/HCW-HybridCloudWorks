import React, { useEffect, useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { brainApi } from '@/lib/brainApi';
import ConfirmModal from '@/components/admin/ConfirmModal';
import DraftFromNote from './DraftFromNote';
import { useUnsavedGuard } from '../drafts/useUnsavedGuard';
import { nodeHeading } from './mapPreferences';
import {
  BacklinksList,
  BodyField,
  CollectionsField,
  EditorActions,
  HeadingField,
  HistoryList,
  inputClass,
  LinksField,
  Markdown,
  TagsField,
  UrlsField,
} from './NoteEditorParts';

export { Markdown };

export const noteFields = (item) => ({
  id: item.id,
  type: item.type,
  title: item.title,
  body: item.body || '',
  tags: item.tags || [],
  links: item.links || [],
  collections: item.collections || [],
  urls: item.urls || [],
  properties: item.properties || {},
  archived: item.archived === true,
  inbox: item.inbox !== false,
  ...(item.type === 'conflict' && { conflictOf: item.conflictOf }),
});
function headingInfo(form) {
  const heading =
    typeof form.properties.heading === 'string' ? form.properties.heading : nodeHeading(form);
  const invalidHeading = !heading.trim() || heading.trim().split(/\s+/).length > 4;
  return { heading, invalidHeading };
}
export default function NoteEditor({
  item,
  collections,
  candidates,
  backlinks,
  onSaved,
  onSelect,
  onClose,
  onDirty,
  snapshot,
  onSnapshot,
}) {
  const recovery = snapshot?.id === item.id ? snapshot : null;
  const [form, setForm] = useState(() => recovery?.form || noteFields(item));
  const [tagText, setTagText] = useState(() => recovery?.tagText ?? (item.tags || []).join(', '));
  const [version, setVersion] = useState(() => recovery?.version ?? item.version ?? 0);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState([]);
  const [historyBefore, setHistoryBefore] = useState(null);
  const [mutation, setMutation] = useState(() => recovery?.mutation || crypto.randomUUID());
  useEffect(() => {
    onSnapshot?.({ id: item.id, form, tagText, version, mutation });
  }, [onSnapshot, item.id, form, tagText, version, mutation]);
  const dirty = JSON.stringify(form) !== JSON.stringify(noteFields(item));
  const { heading, invalidHeading } = headingInfo(form);
  const headingHelpId = useId();
  useEffect(() => {
    onDirty?.(dirty);
    return () => onDirty?.(false);
  }, [dirty, onDirty]);
  const leave = useUnsavedGuard(dirty);
  async function loadHistory(before = null) {
    try {
      const page = await brainApi.history(item.id, before);
      setHistory((old) => (before ? [...old, ...page.items] : page.items));
      setHistoryBefore(page.before);
    } catch (err) {
      setError(err.message);
    }
  }
  const change = (key, value) => {
    setForm((old) => ({ ...old, [key]: value }));
    setMutation(crypto.randomUUID());
  };
  async function save(next = form) {
    setBusy(true);
    setError('');
    try {
      const saved = await brainApi.save(
        {
          ...next,
          properties: { ...next.properties, heading: headingInfo(next).heading },
        },
        version,
        mutation
      );
      setVersion(saved.item.version);
      setForm(noteFields(saved.item));
      setMutation(crypto.randomUUID());
      onSaved(saved.item);
      if (saved.indexPending)
        setError('Saved. Search indexing will catch up during reconciliation.');
    } catch (err) {
      setError(
        `${err.message} Your text is still here. Use History or save a recovery copy before loading another item.`
      );
    } finally {
      setBusy(false);
    }
  }
  async function recover() {
    setBusy(true);
    try {
      const result = await brainApi.save(
        {
          ...form,
          id: crypto.randomUUID(),
          type: 'conflict',
          conflictOf: item.id,
          title: `Recovery: ${form.title}`,
          archived: false,
        },
        0,
        crypto.randomUUID()
      );
      onSaved(result.item);
      setError('Recovery copy saved. Your original item remains unchanged.');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }
  // Puts an earlier version into the editor, unsaved, for the writer to review.
  const loadForReview = (result) => {
    setForm(noteFields(result));
    setTagText((result.tags || []).join(', '));
    setMutation(crypto.randomUUID());
  };
  const dismiss = onClose;
  return (
    <section className="space-y-4 rounded-xl border bg-card p-5" aria-label="Note editor">
      <ConfirmModal
        open={leave.leaving}
        title="Leave this note?"
        description="Your changes have not been saved."
        confirmLabel="Leave without saving"
        onConfirm={leave.confirmLeave}
        onCancel={leave.cancelLeave}
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs uppercase tracking-widest text-muted-foreground">
          {form.type} · Version {version}
          {dirty ? ' · Unsaved changes' : ''}
        </span>
        <Button variant="ghost" size="sm" onClick={dismiss}>
          Close
        </Button>
      </div>
      {error && (
        <p role="alert" className="rounded-lg border border-amber-500/40 p-3 text-sm">
          {error}
        </p>
      )}
      <HeadingField
        heading={heading}
        invalid={invalidHeading}
        helpId={headingHelpId}
        onChange={(value) => change('properties', { ...form.properties, heading: value })}
      />
      <label className="block space-y-1 text-sm">
        <span>Title</span>
        <input
          className={inputClass}
          maxLength={300}
          value={form.title}
          onChange={(e) => change('title', e.target.value)}
        />
      </label>
      {/\[\[|%%|```(?:dataview|tasks|query)/i.test(form.body) && (
        <p className="rounded-lg border p-3 text-sm text-muted-foreground">
          Obsidian-specific markup is preserved. Use linked items below to navigate connections in
          HCW.
        </p>
      )}
      <BodyField body={form.body} onChange={(value) => change('body', value)} />
      <TagsField tagText={tagText} onText={setTagText} onTags={(tags) => change('tags', tags)} />
      <UrlsField urls={form.urls} onChange={(urls) => change('urls', urls)} />
      <CollectionsField
        collections={collections}
        itemId={item.id}
        chosen={form.collections}
        onChange={(ids) => change('collections', ids)}
      />
      <LinksField
        links={form.links}
        candidates={candidates}
        itemId={item.id}
        onChange={(links) => change('links', links)}
        onSelect={onSelect}
      />
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={form.inbox}
          onChange={(e) => change('inbox', e.target.checked)}
        />
        Keep in Inbox
      </label>
      <EditorActions
        busy={busy}
        invalidHeading={invalidHeading}
        archived={form.archived}
        version={version}
        actions={{
          save: () => save(),
          toggleArchive: () => save({ ...form, archived: !form.archived }),
          recover,
          history: () => loadHistory(),
        }}
      />
      <HistoryList
        history={history}
        before={historyBefore}
        onOlder={loadHistory}
        onLoad={loadForReview}
      />
      <BacklinksList backlinks={backlinks} onSelect={onSelect} />
      {form.type !== 'topic' && form.type !== 'project' && !form.archived && (
        <DraftFromNote item={item} form={form} version={version} dirty={dirty} />
      )}
    </section>
  );
}
