/**
 * /admin/drafts — the Drafts stage (owner request 2026-10-03), the step
 * before the Review Queue.
 *
 * Articles are written and kept here, saved in the site: a save is one API
 * call from any device, with no GitHub credential and no pull request. When
 * one is ready, Send to In Review moves it onto the Review Queue's In Review
 * filter — the same place the old "Import drafts from the repository" panel
 * landed files — where the provider is set and it goes on to the Publish
 * Queue. An article In Review that came from here can come back with Back to
 * Drafts; one that is live is never touched from this page.
 *
 * "Import from docs/content" brings the repository's `blog-*.md` articles in
 * once, as drafts. After that, this page is their source of truth and
 * docs/content is an archive.
 *
 * TWO TABS. Every write carries the etag of the version on screen, and the
 * API refuses it (412, code CONFLICT) when the stored version has moved on.
 * The page keeps the owner's text and offers to reload the latest; it never
 * retries a save over someone else's.
 *
 * The state is in four hooks beside this file — the list, the open article,
 * the writes and the import — and this component lays them out. Server side:
 * functions/src/lib/cms/drafts-handlers.js, drafts.js and drafts-stage.js.
 */
import React, { useState } from 'react';
import { FileInput, FilePen, Loader2, Plus, RefreshCw } from 'lucide-react';
import ConfirmModal from '@/components/admin/ConfirmModal';
import SharedPageHeader from '@/components/admin/shared/PageHeader';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/use-toast';
import { useAuthReady } from '@/hooks/useAuthReady';
import DraftList from './drafts/DraftList';
import DraftEditor from './drafts/DraftEditor';
import { deleteConfirmCopy, describeImportResult, describeSaveState } from './drafts/draftForm';
import { useDraftList } from './drafts/useDraftList';
import { useOpenDraft } from './drafts/useOpenDraft';
import { useDraftWrites } from './drafts/useDraftWrites';
import { useDraftImport } from './drafts/useDraftImport';
import { LEAVE_CONFIRM, useUnsavedGuard } from './drafts/useUnsavedGuard';

const IMPORT_TONE_CLASS = {
  ok: 'text-green-700 dark:text-green-300',
  skip: 'text-muted-foreground',
  bad: 'text-destructive',
};

function ImportResults({ results, onDismiss }) {
  if (!results) return null;
  return (
    <section
      aria-label="Import results"
      className="rounded-md border bg-card px-4 py-3 text-sm shadow-sm"
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="font-medium">Import from docs/content</p>
        <Button variant="ghost" size="sm" onClick={onDismiss}>
          Dismiss
        </Button>
      </div>
      <ul className="space-y-1">
        {results.map((result) => {
          const line = describeImportResult(result);
          return (
            <li key={result.path}>
              <span className="font-medium">{line.title}</span>{' '}
              <span className={IMPORT_TONE_CLASS[line.tone]}>{line.text}</span>
              {(result.warnings || []).map((warning) => (
                <span key={warning} className="block text-xs text-muted-foreground">
                  {warning}
                </span>
              ))}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Alert({ tone = 'error', children }) {
  const toneClass =
    tone === 'conflict'
      ? 'border-amber-500/50 bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300'
      : 'border-destructive/50 bg-destructive/10 text-destructive';
  return (
    <div
      role="alert"
      className={`flex flex-wrap items-center justify-between gap-3 rounded-md border px-4 py-3 text-sm ${toneClass}`}
    >
      {children}
    </div>
  );
}

const DRAFTS_HELP = [
  'What this page is: the writing desk before the pipeline. Articles written here are saved in the site from any device; nothing is published from this page.',
  'New draft starts one; Import from docs/content brings the repository articles in once, as drafts. Save keeps your text; two tabs cannot overwrite each other.',
  'Kind and idea origin classify the draft (what it becomes, how it started); set them before sending it on so downstream tools pick it up correctly.',
  'Where it goes next: Send to In Review puts the draft on the Review Queue under In Review. Back to Drafts brings it here again until it is approved.',
];

function PageHeader({ onNew, onImport, importing, onRefresh, refreshing }) {
  return (
    <SharedPageHeader
      icon={FilePen}
      title="Drafts"
      help={DRAFTS_HELP}
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={onNew} className="gap-1">
            <Plus className="h-4 w-4" /> New draft
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={onImport}
            disabled={importing}
            className="gap-1"
          >
            {importing ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <FileInput className="h-4 w-4" />
            )}
            Import from docs/content
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={onRefresh}
            disabled={refreshing}
            className="gap-1"
          >
            <RefreshCw className="h-4 w-4" /> Refresh
          </Button>
        </div>
      }
    />
  );
}

/** The Drafts stage laid out from its four hooks, asking first on any exit that would lose edits. */
export default function DraftsPage() {
  const { authReady } = useAuthReady();
  const { toast } = useToast();
  const list = useDraftList(authReady);
  const editor = useOpenDraft(list.upsert);
  const writes = useDraftWrites({ editor, list, toast });
  const repoImport = useDraftImport({ list, toast });
  // A pending switch away from unsaved changes: () => void, run on confirm.
  const [pendingSwitch, setPendingSwitch] = useState(null);

  const { current, dirty } = editor;
  // A link out of the page with unsaved changes asks first, below, with the
  // same modal the in-page switch uses (AP-F12, #936).
  const leave = useUnsavedGuard(dirty);

  /** Run `next` now, or after the owner agrees to drop unsaved changes. */
  const guardSwitch = (next) => {
    const run = () => {
      writes.clearErrors();
      next();
    };
    if (dirty) setPendingSwitch(() => run);
    else run();
  };

  const handleSelect = (id) => {
    if (current?.id !== id) guardSwitch(() => editor.open(id));
  };

  /** Back to Drafts on another article than the open one leaves the open one. */
  const handleBackToDrafts = (target) => {
    if (target.id === current?.id) writes.backToDrafts(target);
    else guardSwitch(() => writes.backToDrafts(target));
  };

  const handleReloadLatest = () => {
    writes.clearErrors();
    if (current?.id) editor.open(current.id);
    list.reload();
  };

  const saveState = describeSaveState({
    saving: writes.busy === 'save',
    error: Boolean(writes.actionError || writes.conflict) && dirty,
    dirty,
    isNew: editor.isNew,
  });
  const deleteCopy = deleteConfirmCopy(current);
  const actionError = writes.actionError || editor.openError;

  return (
    <div className="max-w-7xl space-y-6">
      <PageHeader
        onNew={() => guardSwitch(editor.startNew)}
        onImport={repoImport.run}
        importing={repoImport.importing}
        onRefresh={list.reload}
        refreshing={list.loading}
      />

      <ImportResults results={repoImport.results} onDismiss={repoImport.dismiss} />

      {list.error && <Alert>{list.error}</Alert>}
      {writes.conflict && (
        <Alert tone="conflict">
          <span>
            {writes.conflict} Your text is still in the editor; copy anything you want to keep
            before reloading.
          </span>
          <Button size="sm" variant="outline" onClick={handleReloadLatest}>
            Reload latest
          </Button>
        </Alert>
      )}
      {actionError && <Alert>{actionError}</Alert>}

      <div className="grid gap-6 lg:grid-cols-[minmax(16rem,20rem)_1fr]">
        <DraftList
          drafts={list.drafts}
          loading={list.loading}
          selectedId={current?.id || null}
          unsavedNew={editor.isNew}
          busy={Boolean(writes.busy)}
          onSelect={handleSelect}
          onBackToDrafts={handleBackToDrafts}
        />
        <div>
          {editor.opening && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Opening…
            </p>
          )}
          {!editor.opening && current && (
            <DraftEditor
              draft={current}
              form={editor.form}
              onChange={editor.change}
              saveState={saveState}
              dirty={dirty}
              busy={writes.busy}
              onSave={writes.save}
              onSendToReview={writes.sendToReview}
              onDelete={writes.askDelete}
              onBackToDrafts={() => writes.backToDrafts(current)}
            />
          )}
          {!editor.opening && !current && (
            <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
              Pick a draft on the left, or start one with <strong>New draft</strong>.
            </div>
          )}
        </div>
      </div>

      <ConfirmModal
        open={writes.confirmingDelete}
        title={deleteCopy.title}
        description={deleteCopy.description}
        confirmLabel="Delete"
        onConfirm={writes.confirmDelete}
        onCancel={writes.cancelDelete}
      />
      <ConfirmModal
        open={Boolean(pendingSwitch)}
        title="Discard unsaved changes?"
        description="This draft has changes that are not saved. Leave it and lose them?"
        confirmLabel="Discard changes"
        onConfirm={() => {
          const next = pendingSwitch;
          setPendingSwitch(null);
          next?.();
        }}
        onCancel={() => setPendingSwitch(null)}
      />
      <ConfirmModal
        open={leave.leaving}
        title={LEAVE_CONFIRM.title}
        description={LEAVE_CONFIRM.description}
        confirmLabel={LEAVE_CONFIRM.confirmLabel}
        onConfirm={leave.confirmLeave}
        onCancel={leave.cancelLeave}
      />
    </div>
  );
}
