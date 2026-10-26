/**
 * "Upload files": choose one or more text or markdown files (all of a vault
 * folder at once is fine). They are sent one at a time, each answer appears in
 * the list as it arrives, and a file that fails does not stop the rest. A file
 * may open with a front-matter block (title, category, tags, link), as an
 * Obsidian note does; without one the title is its first heading or its file
 * name, and the category is the one chosen here.
 *
 * Not the Ambassador hub's Evidence upload: that attaches proof of a
 * contribution to a programme. This puts your own writing in the vault.
 */
import React, { useId, useState } from 'react';
import { FileUp, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import {
  CATEGORIES,
  DEFAULT_CATEGORY,
  MAX_BODY_BYTES,
  MAX_FILE_BYTES,
  UPLOAD_ACCEPT,
} from './docVaultModel';

const SELECT_CLASS =
  'h-10 w-full rounded-md border border-input bg-background px-3 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2';

const TONE_CLASS = {
  ok: 'text-green-700 dark:text-green-300',
  skip: 'text-muted-foreground',
  bad: 'text-destructive',
};

function ResultList({ lines, summary, onDismiss }) {
  if (!lines) return null;
  return (
    <div className="space-y-2">
      <ul aria-label="Upload results" className="space-y-1 text-sm">
        {lines.map((line, index) => (
          <li key={`${index}-${line.name}`}>
            <span className="font-medium">{line.name}</span>{' '}
            <span className={TONE_CLASS[line.tone]}>{line.text}</span>
            {line.warnings.map((warning) => (
              <span key={warning} className="block text-xs text-muted-foreground">
                {warning}
              </span>
            ))}
          </li>
        ))}
      </ul>
      {summary && (
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-medium">{summary}</p>
          <Button type="button" variant="ghost" size="sm" onClick={onDismiss}>
            Dismiss
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * @param {{
 *   uploads: ReturnType<typeof import('./useDocUploads').useDocUploads>,
 *   onClose: () => void,
 * }} props
 */
export default function UploadPanel({ uploads, onClose }) {
  const ids = useId();
  const fileId = `${ids}-files`;
  const categoryId = `${ids}-category`;
  const [files, setFiles] = useState([]);
  const [category, setCategory] = useState(DEFAULT_CATEGORY);
  // A file input cannot be emptied from React except by replacing it.
  const [pickerKey, setPickerKey] = useState(0);
  const { running, progress } = uploads;

  const send = async () => {
    await uploads.uploadFiles(files, category);
    // The results list names every file, so a failed one is chosen again from there.
    setFiles([]);
    setPickerKey((key) => key + 1);
  };

  return (
    <Card aria-labelledby={`${ids}-heading`} role="region">
      <CardHeader className="pb-3">
        <CardTitle id={`${ids}-heading`} className="flex items-center gap-2 text-base">
          <FileUp className="h-4 w-4" aria-hidden="true" /> Upload files
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          Text and markdown files only (.md, .markdown, .txt). A file may open with a block between
          two <code>---</code> lines giving a title, category, tags and link; the other lines in it
          are not kept, and the result below says which. A document with the same title and category
          as one already here becomes its newest version.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1">
          <Label htmlFor={fileId}>Files (one or many)</Label>
          <input
            key={pickerKey}
            id={fileId}
            type="file"
            accept={UPLOAD_ACCEPT}
            multiple
            disabled={running}
            onChange={(event) => setFiles(Array.from(event.target.files || []))}
            className="block w-full text-sm file:mr-3 file:rounded-md file:border file:bg-background file:px-3 file:py-1.5 file:text-sm"
          />
          <p className="text-xs text-muted-foreground">
            Files go in one at a time, each at most {MAX_FILE_BYTES / 1024} KB (the text can be{' '}
            {MAX_BODY_BYTES / 1024} KB). A file with a problem does not stop the others.
          </p>
        </div>
        <div className="max-w-xs space-y-1">
          <Label htmlFor={categoryId}>Category for files that do not name one</Label>
          <select
            id={categoryId}
            className={SELECT_CLASS}
            value={category}
            disabled={running}
            onChange={(event) => setCategory(event.target.value)}
          >
            {CATEGORIES.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            onClick={send}
            disabled={running || files.length === 0}
            className="gap-1"
          >
            <FileUp className="h-4 w-4" aria-hidden="true" />
            {files.length === 0
              ? 'Upload files'
              : `Upload ${files.length} ${files.length === 1 ? 'file' : 'files'}`}
          </Button>
          <Button type="button" variant="outline" onClick={onClose} disabled={running}>
            Close
          </Button>
        </div>

        <div aria-live="polite" className="space-y-2">
          {progress && (
            <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Sending {progress.index} of {progress.total}: {progress.name}
            </p>
          )}
          <ResultList lines={uploads.lines} summary={uploads.summary} onDismiss={uploads.dismiss} />
        </div>
      </CardContent>
    </Card>
  );
}
