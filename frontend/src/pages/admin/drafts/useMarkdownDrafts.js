/**
 * "Paste or upload a markdown draft" (POST cms/drafts/from-markdown): whole
 * draft files, or pasted text, become drafts. Files go one request at a time,
 * in the order they were chosen, so the server sees one file at once and the
 * owner sees each answer as it comes; a file that fails is reported and the
 * rest still go. The list reloads once at the end, not after every file.
 */
import { useState } from 'react';
import { postJSON } from '@/lib/api';
import {
  FROM_MARKDOWN_ROUTE,
  MAX_MARKDOWN_FILE_BYTES,
  describeMarkdownResult,
  summarizeMarkdownBatch,
} from './draftForm';

export const PASTED_NAME = 'Pasted text';

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

/** One item → its result line. Never throws: a failure is a line, not the end of the batch. */
async function sendOne({ name, origin, read, size }) {
  try {
    if (size > MAX_MARKDOWN_FILE_BYTES) {
      throw new Error(
        `this file is over ${MAX_MARKDOWN_FILE_BYTES / 1024} KB, the most a draft can be. Nothing was sent.`
      );
    }
    const markdown = await read();
    const answer = await postJSON(FROM_MARKDOWN_ROUTE, { markdown, origin });
    return describeMarkdownResult(name, { answer });
  } catch (error) {
    return describeMarkdownResult(name, { error });
  }
}

export function useMarkdownDrafts({ list, toast }) {
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(null);
  const [lines, setLines] = useState(null);
  const [noun, setNoun] = useState('file');

  /** Send `items` in order; resolves to the result lines. */
  const run = async (items, label) => {
    setRunning(true);
    setNoun(label);
    setLines([]);
    const done = [];
    try {
      for (const [index, item] of items.entries()) {
        setProgress({ index: index + 1, total: items.length, name: item.name });
        done.push(await sendOne(item));
        setLines([...done]);
      }
    } finally {
      setProgress(null);
      setRunning(false);
    }
    const summary = summarizeMarkdownBatch(done, label);
    toast({
      title: done.some((line) => line.kind === 'created') ? 'Drafts added' : 'No new drafts',
      description: summary,
    });
    if (done.some((line) => line.kind === 'created')) await list.reload();
    return done;
  };

  /** Files from the picker, as the vault's. */
  const uploadFiles = (files) =>
    run(
      Array.from(files).map((file) => ({
        name: file.name,
        origin: 'vault',
        size: file.size,
        read: () => readFileText(file),
      })),
      'file'
    );

  /** Text from the box, as pasted. */
  const uploadPasted = async (text) => {
    const [line] = await run(
      [{ name: PASTED_NAME, origin: 'paste', size: new Blob([text]).size, read: async () => text }],
      'pasted draft'
    );
    return line;
  };

  return {
    running,
    progress,
    lines,
    summary: lines && !running && lines.length ? summarizeMarkdownBatch(lines, noun) : null,
    uploadFiles,
    uploadPasted,
    dismiss: () => setLines(null),
  };
}
