/**
 * A talk's pieces in the Pipeline (#1886): its recap, write-up or slides
 * post, started from the talk's edit form and worked in the Pipeline like any
 * other draft. Speaking keeps no draft of its own; this is the shared box
 * (components/admin/shared/pipeline) with the talk's reference.
 */
import React from 'react';
import RecordPipeline from '@/components/admin/shared/pipeline/RecordPipeline';

/** The nav id this Page sends work under (functions/src/lib/page-links/origin-pages.js). */
export const SPEAKING_PAGE = 'speaking';

/** A stored talk's reference, as the hand-off sends it. */
export const talkRef = (docId) => ({ page: SPEAKING_PAGE, id: docId });

/**
 * The name the form shows for the talk it has open: the stored name of a
 * Sessionize event (or Sessionize's own), or a manual entry's name.
 */
export function talkLabel(editor) {
  const stored = editor.editingEvent?._storedDoc;
  const name = editor.editingEvent
    ? stored?.eventName || stored?.name || editor.editingEvent.name
    : editor.form?._manualName;
  return String(name || '').trim() || String(editor.editingId);
}

/** Below the edit form of a stored talk; a talk not saved yet says so instead. */
export default function TalkPipeline({ editor }) {
  if (!editor.editingId || editor.editingId === 'new') {
    return (
      <p className="text-xs text-muted-foreground">
        Save this talk first to start a piece for it in the Pipeline.
      </p>
    );
  }
  return (
    <RecordPipeline
      originRef={talkRef(editor.editingId)}
      recordLabel={talkLabel(editor)}
      intro="Pieces started for this talk, such as its recap or write-up. Each one is written, reviewed, scheduled and published in the Pipeline."
      emptyText="Nothing started for this talk yet."
    />
  );
}
