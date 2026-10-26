/**
 * "Upload files" (POST cms/doc-vault/upload): text and markdown files become
 * documents. Files go one request at a time, in the order they were chosen, so
 * the server sees one file at once and the owner sees each answer as it comes;
 * a file that fails is reported and the rest still go. The list reloads once at
 * the end, not after every file. The same shape as the Drafts page's
 * useMarkdownDrafts, which this follows.
 */
import { useState } from 'react';
import { postJSON } from '@/lib/api';
import {
  MAX_FILE_BYTES,
  UPLOAD_ROUTE,
  describeUploadResult,
  summarizeBatch,
} from './docVaultModel';

/** The text of a chosen file, as UTF-8. */
export function readFileText(file) {
  if (typeof file.text === 'function') return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('The file could not be read.'));
    reader.readAsText(file);
  });
}

/** One file → its result line. Never throws: a failure is a line, not the end of the batch. */
async function sendOne(file, defaultCategory) {
  const name = file.name || 'Unnamed file';
  try {
    if (file.size > MAX_FILE_BYTES) {
      throw new Error(
        `this file is over ${MAX_FILE_BYTES / 1024} KB, the most a document and its front matter can be. Nothing was sent.`
      );
    }
    const text = await readFileText(file);
    const answer = await postJSON(UPLOAD_ROUTE, { filename: name, text, defaultCategory });
    return describeUploadResult(name, { answer });
  } catch (error) {
    return describeUploadResult(name, { error });
  }
}

/**
 * @param {{ reload: () => Promise<unknown>|void, toast: (message: object) => void }} deps
 */
export function useDocUploads({ reload, toast }) {
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(null);
  const [lines, setLines] = useState(null);

  /** Send `files` in order; resolves to the result lines. */
  const uploadFiles = async (files, defaultCategory) => {
    const chosen = Array.from(files);
    setRunning(true);
    setLines([]);
    const done = [];
    try {
      for (const [index, file] of chosen.entries()) {
        setProgress({ index: index + 1, total: chosen.length, name: file.name });
        done.push(await sendOne(file, defaultCategory));
        setLines([...done]);
      }
    } finally {
      setProgress(null);
      setRunning(false);
    }
    const changed = done.some((line) => ['created', 'versioned', 'restored'].includes(line.kind));
    toast({
      title: changed ? 'Files added to the vault' : 'Nothing new added',
      description: summarizeBatch(done),
    });
    if (changed) await reload();
    return done;
  };

  return {
    running,
    progress,
    lines,
    summary: lines && !running && lines.length ? summarizeBatch(lines) : null,
    uploadFiles,
    dismiss: () => setLines(null),
  };
}
