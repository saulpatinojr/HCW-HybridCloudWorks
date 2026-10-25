/**
 * "Paste or upload a markdown draft" on /admin/drafts (owner decision
 * 2026-10-25: pre-publish drafts live in the private Obsidian vault and in
 * this admin, not in the public repository).
 *
 * Two ways in, side by side. Choose one or more `.md` files (all of the vault's
 * Drafts folder at once is fine): they are sent one at a time, each answer
 * appears in the list as it arrives, and a file that fails does not stop the
 * rest. Or paste one draft into the box. Either way the file is the same
 * format as a docs/content article, front matter first
 * (docs/content/blog-template.md), and the result is a draft: nothing is
 * published. The server side is functions/src/lib/cms/drafts-markdown.js.
 */
import React, { useId, useState } from 'react';
import { FileUp, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { MAX_MARKDOWN_FILE_BYTES } from './draftForm';

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
          <Button variant="ghost" size="sm" onClick={onDismiss}>
            Dismiss
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * @param {{ uploads: ReturnType<typeof import('./useMarkdownDrafts').useMarkdownDrafts> }} props
 */
export default function MarkdownDraftPanel({ uploads }) {
  const ids = useId();
  const fileId = `${ids}-files`;
  const pasteId = `${ids}-paste`;
  const [files, setFiles] = useState([]);
  const [pasted, setPasted] = useState('');
  // A file input cannot be emptied from React except by replacing it.
  const [pickerKey, setPickerKey] = useState(0);
  const { running, progress } = uploads;

  const sendFiles = async () => {
    await uploads.uploadFiles(files);
    // The results list names every file, so a failed one is chosen again from there.
    setFiles([]);
    setPickerKey((key) => key + 1);
  };

  const sendPasted = async () => {
    const line = await uploads.uploadPasted(pasted);
    if (line.kind !== 'failed') setPasted('');
  };

  return (
    <Card aria-labelledby={`${ids}-heading`} role="region">
      <CardHeader className="pb-3">
        <CardTitle id={`${ids}-heading`} className="flex items-center gap-2 text-base">
          <FileUp className="h-4 w-4" /> Paste or upload a markdown draft
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          Each draft is one markdown file that starts with a block between two <code>---</code>{' '}
          lines (title, subtitle, date, tags and so on), then the article, the same as a file in
          docs/content. It is saved here as a draft. Nothing is published.
        </p>
      </CardHeader>
      <CardContent className="grid gap-6 md:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor={fileId}>Markdown files from my vault (.md, one or many)</Label>
          <input
            key={pickerKey}
            id={fileId}
            type="file"
            accept=".md,text/markdown"
            multiple
            disabled={running}
            onChange={(event) => setFiles(Array.from(event.target.files || []))}
            className="block w-full text-sm file:mr-3 file:rounded-md file:border file:bg-background file:px-3 file:py-1.5 file:text-sm"
          />
          <p className="text-xs text-muted-foreground">
            Saved as coming from your vault. Files go in one at a time, each at most{' '}
            {MAX_MARKDOWN_FILE_BYTES / 1024} KB. A file whose article is already here is left alone,
            and a file with a problem does not stop the others.
          </p>
          <Button
            size="sm"
            onClick={sendFiles}
            disabled={running || files.length === 0}
            className="gap-1"
          >
            <FileUp className="h-4 w-4" />
            {files.length === 0
              ? 'Upload files'
              : `Upload ${files.length} ${files.length === 1 ? 'file' : 'files'}`}
          </Button>
        </div>

        <div className="space-y-2">
          <Label htmlFor={pasteId}>Or paste one draft (front matter first)</Label>
          <Textarea
            id={pasteId}
            value={pasted}
            onChange={(event) => setPasted(event.target.value)}
            disabled={running}
            rows={6}
            spellCheck={false}
            className="font-mono text-xs"
            placeholder={'---\ntitle: My article\ntags: [azure]\n---\n\nThe article…'}
          />
          <p className="text-xs text-muted-foreground">Saved as pasted text.</p>
          <Button
            size="sm"
            variant="outline"
            onClick={sendPasted}
            disabled={running || !pasted.trim()}
          >
            Add pasted draft
          </Button>
        </div>

        <div className="space-y-2 md:col-span-2" aria-live="polite">
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
