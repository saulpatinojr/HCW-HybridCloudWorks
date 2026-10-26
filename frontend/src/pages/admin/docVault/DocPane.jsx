/**
 * The right column of /admin/doc-vault: whichever one thing the owner is doing.
 * The form wins over everything (typed text is never hidden behind another
 * panel), then the upload panel, then the open document, then a prompt.
 */
import React from 'react';
import { Loader2 } from 'lucide-react';
import DocForm from './DocForm';
import DocViewer from './DocViewer';
import UploadPanel from './UploadPanel';

/** Which of the five things the column shows. */
export function paneKind({ formMode, pane, opening, hasDocument }) {
  if (formMode) return 'form';
  if (pane === 'upload') return 'upload';
  if (opening) return 'opening';
  return hasDocument ? 'document' : 'empty';
}

/**
 * @param {{
 *   kind: ReturnType<typeof paneKind>,
 *   editor: ReturnType<typeof import('./useDocForm').useDocForm>,
 *   vault: ReturnType<typeof import('./useDocVault').useDocVault>,
 *   uploads: ReturnType<typeof import('./useDocUploads').useDocUploads>,
 *   onSubmit: () => void,
 *   onCloseUpload: () => void,
 *   onAsk: (question: { name: string, version?: number }) => void,
 * }} props
 */
export default function DocPane({ kind, editor, vault, uploads, onSubmit, onCloseUpload, onAsk }) {
  const { current } = vault;
  if (kind === 'form') {
    return (
      <DocForm
        mode={editor.mode}
        form={editor.form}
        onChange={editor.change}
        onSubmit={onSubmit}
        onCancel={editor.cancel}
        busy={vault.busy === 'save'}
        dirty={editor.dirty}
        problem={editor.problem}
      />
    );
  }
  if (kind === 'upload') return <UploadPanel uploads={uploads} onClose={onCloseUpload} />;
  if (kind === 'opening') {
    return (
      <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Opening…
      </p>
    );
  }
  if (kind === 'document') {
    return (
      <DocViewer
        doc={current.document}
        versions={current.versions}
        preview={vault.preview}
        busy={vault.busy}
        onEdit={() => editor.startEdit(current.document)}
        onTrash={() => onAsk({ name: 'trash' })}
        onPutBack={vault.putBack}
        onDeleteForever={() => onAsk({ name: 'forever' })}
        onViewVersion={(version) =>
          version === null ? vault.closePreview() : vault.viewVersion(version)
        }
        onRestoreVersion={(version) => onAsk({ name: 'restore', version })}
      />
    );
  }
  return (
    <div className="rounded-lg border border-dashed p-8 text-center text-sm text-muted-foreground">
      Pick a document on the left to read and copy it, or add one with{' '}
      <strong>Paste a document</strong> or <strong>Upload files</strong>.
    </div>
  );
}
