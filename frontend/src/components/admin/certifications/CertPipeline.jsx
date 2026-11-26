/**
 * A certification's pieces in the Pipeline (#1886): study notes, or what was
 * learned for it, started from the certification's editor and worked in the
 * Pipeline like any other draft. Certifications keeps no draft of its own;
 * this is the shared box (components/admin/shared/pipeline) with the
 * certification's reference.
 */
import React from 'react';
import RecordPipeline from '@/components/admin/shared/pipeline/RecordPipeline';

/** The nav id this Page sends work under (functions/src/lib/page-links/origin-pages.js). */
export const CERTIFICATIONS_PAGE = 'certifications';

/** A stored certification's reference, as the hand-off sends it. */
export const certRef = (cert) => ({ page: CERTIFICATIONS_PAGE, id: cert._docId });

/**
 * The certification a link names (`?certification=<id>`), from the loaded
 * list, or null when none has that id.
 */
export function linkedCert(items, id) {
  if (!id) return null;
  return (items || []).find((cert) => cert._docId === id) || null;
}

/** In the editor of a saved certification; a new one has no record to name yet. */
export default function CertPipeline({ cert }) {
  if (!cert?._docId) return null;
  const name = String(cert.name || '').trim() || cert._docId;
  return (
    <RecordPipeline
      originRef={certRef(cert)}
      recordLabel={name}
      intro="Pieces started for this certification, such as study notes. Each one is written, reviewed, scheduled and published in the Pipeline."
      emptyText="Nothing started for this certification yet."
    />
  );
}
