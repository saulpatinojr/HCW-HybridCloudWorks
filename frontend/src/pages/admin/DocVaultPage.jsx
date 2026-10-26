/**
 * /admin/doc-vault — the Doc Vault (owner request 2026-10-26): the owner's
 * own templates, applications written out in full, letters and notes, kept in
 * the site and shown to nobody else. Paste a document or upload text and
 * markdown files; open one to read it, copy it (as saved, or as plain text for
 * a form or an email), edit it, see its history and restore an earlier
 * version, or move it to Trash.
 *
 * NOT THE AMBASSADOR EVIDENCE TAB. Evidence is proof of a contribution to a
 * programme (a talk, a certification, an article), linked to that programme's
 * requirements. The Doc Vault is the owner's own writing, for reuse. They share
 * no container, no route and no code.
 *
 * PRIVATE, AND IT SAYS SO. The banner under the title stays on screen in every
 * state. The routes need the publisher role (functions/src/lib/doc-vault/
 * model.js says why), so a signed-in editor or viewer is told so here and
 * nothing is requested for them. No document is ever public: the container is
 * named by no public read (functions/src/lib/doc-vault/no-leak.test.js).
 *
 * The state is in hooks beside this file (docVault/): the list, the open
 * document and the writes, the form, and the file uploads. This component lays
 * them out, and asks first before any exit that would lose typed text.
 */
import React, { useMemo, useState } from 'react';
import { FilePlus, FileUp, RefreshCw } from 'lucide-react';
import ConfirmModal from '@/components/admin/ConfirmModal';
import SharedPageHeader from '@/components/admin/shared/PageHeader';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/use-toast';
import { satisfiesRole } from '@/config/adminNav';
import { useAdminRole } from '@/hooks/useAdminRole';
import { useAuthReady } from '@/hooks/useAuthReady';
import { useUnsavedGuard } from './drafts/useUnsavedGuard';
import DocList from './docVault/DocList';
import DocPane, { paneKind } from './docVault/DocPane';
import { Alert, NeedsPublisher, NotProvisioned, PrivateBanner } from './docVault/Notices';
import {
  DOC_VAULT_MIN_ROLE,
  EMPTY_FILTERS,
  KEPT_VERSIONS,
  TRASH_DAYS,
  filterDocuments,
  payloadFromForm,
} from './docVault/docVaultModel';
import { useDocForm } from './docVault/useDocForm';
import { useDocUploads } from './docVault/useDocUploads';
import { useDocVault } from './docVault/useDocVault';

const HELP = [
  'What goes here: your own templates, applications you have written out, letters and notes. Anything you want to keep, find again and copy from.',
  'What does not: proof of a contribution to a programme (a talk, a certification, an article) belongs in Ambassador, on its Evidence tab. This is separate from that.',
  `Adding a document with the same title and category as one already here does not make a copy: it becomes the newest version. The newest ${KEPT_VERSIONS} versions are kept, and any of them can be restored.`,
  `Deleting moves a document to Trash for ${TRASH_DAYS} days. Put it back, or delete it for good, from the Trash list.`,
  'Nothing in the vault is ever published or shown on the public site.',
];

/** The three questions the page asks before it acts, by name. */
const QUESTIONS = {
  trash: {
    title: 'Move this document to Trash?',
    description: `It leaves the vault list and waits in Trash for ${TRASH_DAYS} days, with its history. You can put it back until then.`,
    confirmLabel: 'Move to Trash',
    destructive: true,
  },
  forever: {
    title: 'Delete this document for good?',
    description:
      'The document and all of its earlier versions are removed from the vault now. This cannot be undone. Backup copies are kept for up to 35 days, then deleted automatically.',
    confirmLabel: 'Delete forever',
    destructive: true,
  },
  restore: {
    title: 'Make this version the newest?',
    description:
      'The text that is newest now becomes the next entry in History, so nothing is lost by restoring.',
    confirmLabel: 'Restore this version',
    destructive: false,
  },
};

function PageActions({ onPaste, onUpload, onRefresh, loading }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" onClick={onPaste} className="gap-1">
        <FilePlus className="h-4 w-4" aria-hidden="true" /> Paste a document
      </Button>
      <Button size="sm" variant="outline" onClick={onUpload} className="gap-1">
        <FileUp className="h-4 w-4" aria-hidden="true" /> Upload files
      </Button>
      <Button size="sm" variant="outline" onClick={onRefresh} disabled={loading} className="gap-1">
        <RefreshCw className="h-4 w-4" aria-hidden="true" /> Refresh
      </Button>
    </div>
  );
}

/** The vault laid out from its hooks, asking first on any exit that would lose typed text. */
function DocVaultDesk() {
  const { authReady } = useAuthReady();
  const { toast } = useToast();
  const vault = useDocVault({ authReady, toast });
  const editor = useDocForm();
  const uploads = useDocUploads({ reload: vault.reload, toast });
  const [pane, setPane] = useState('view');
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [question, setQuestion] = useState(null);
  const [pendingSwitch, setPendingSwitch] = useState(null);
  const leave = useUnsavedGuard(editor.dirty);

  const shown = useMemo(
    () => filterDocuments(vault.list.documents, filters),
    [vault.list.documents, filters]
  );
  const { current } = vault;

  /** Run `next` now, or after the owner agrees to drop what is typed. */
  const guardSwitch = (next) => {
    if (editor.dirty) setPendingSwitch(() => next);
    else next();
  };

  const select = (id) =>
    guardSwitch(() => {
      editor.cancel();
      vault.clearErrors();
      setPane('view');
      vault.open(id);
    });

  const startPaste = () =>
    guardSwitch(() => {
      vault.clearErrors();
      setPane('view');
      editor.startNew(filters.category);
    });

  const startUpload = () =>
    guardSwitch(() => {
      vault.clearErrors();
      editor.cancel();
      setPane('upload');
    });

  const changeView = (next) =>
    guardSwitch(() => {
      editor.cancel();
      setPane('view');
      vault.setView(next);
    });

  const submit = async () => {
    const fields = payloadFromForm(editor.form);
    const saved = editor.mode === 'edit' ? await vault.update(fields) : await vault.create(fields);
    if (saved) editor.cancel();
  };

  const reloadLatest = () => {
    vault.clearErrors();
    editor.cancel();
    if (current) vault.open(current.document.id);
    vault.reload();
  };

  const answer = async () => {
    const asked = question;
    setQuestion(null);
    if (asked?.name === 'trash') await vault.moveToTrash();
    if (asked?.name === 'forever') await vault.deleteForever();
    if (asked?.name === 'restore') await vault.restoreVersion(asked.version);
  };

  const wording = QUESTIONS[question?.name] ?? QUESTIONS.trash;
  const error = vault.listError || vault.openError || vault.actionError;
  const kind = paneKind({
    formMode: editor.mode,
    pane,
    opening: vault.opening,
    hasDocument: Boolean(current),
  });

  return (
    <div className="max-w-7xl space-y-6">
      <SharedPageHeader
        help={HELP}
        actions={
          <PageActions
            onPaste={startPaste}
            onUpload={startUpload}
            onRefresh={vault.reload}
            loading={vault.loading}
          />
        }
      />
      <PrivateBanner />

      {vault.notProvisioned ? (
        <NotProvisioned onRetry={vault.reload} />
      ) : (
        <>
          {error && <Alert>{error}</Alert>}
          {vault.conflict && (
            <Alert tone="conflict">
              <span>
                {vault.conflict} Your text is still in the form; copy anything you want to keep
                before reloading.
              </span>
              <Button size="sm" variant="outline" onClick={reloadLatest}>
                Reload latest
              </Button>
            </Alert>
          )}
          <div className="grid gap-6 lg:grid-cols-[minmax(18rem,22rem)_1fr]">
            <DocList
              view={vault.view}
              onView={changeView}
              shown={shown}
              counts={vault.list.counts}
              tags={vault.list.tags}
              total={vault.list.total}
              truncated={vault.list.truncated}
              filters={filters}
              onFilters={setFilters}
              selectedId={current?.document.id ?? null}
              onSelect={select}
              loading={vault.loading}
            />
            <div className="min-w-0">
              <DocPane
                kind={kind}
                editor={editor}
                vault={vault}
                uploads={uploads}
                onSubmit={submit}
                onCloseUpload={() => setPane('view')}
                onAsk={setQuestion}
              />
            </div>
          </div>
        </>
      )}

      <ConfirmModal
        open={Boolean(question)}
        title={wording.title}
        description={wording.description}
        confirmLabel={wording.confirmLabel}
        destructive={wording.destructive}
        onConfirm={answer}
        onCancel={() => setQuestion(null)}
      />
      <ConfirmModal
        open={Boolean(pendingSwitch)}
        title="Discard what you typed?"
        description="The form has text that is not saved. Leave it and lose that text?"
        confirmLabel="Discard"
        onConfirm={() => {
          const next = pendingSwitch;
          setPendingSwitch(null);
          editor.cancel();
          next?.();
        }}
        onCancel={() => setPendingSwitch(null)}
      />
      <ConfirmModal
        open={leave.leaving}
        title="Leave this page?"
        description="The form has text that is not saved. Leave without saving it?"
        confirmLabel="Leave without saving"
        onConfirm={leave.confirmLeave}
        onCancel={leave.cancelLeave}
      />
    </div>
  );
}

export default function DocVaultPage() {
  const role = useAdminRole();
  // A missing role (no provider above, as in a test) says nothing; the API still answers for itself.
  const allowed = role === null || satisfiesRole(role, DOC_VAULT_MIN_ROLE);
  if (allowed) return <DocVaultDesk />;
  return (
    <div className="max-w-7xl space-y-6">
      <SharedPageHeader help={HELP} />
      <PrivateBanner />
      <NeedsPublisher />
    </div>
  );
}
