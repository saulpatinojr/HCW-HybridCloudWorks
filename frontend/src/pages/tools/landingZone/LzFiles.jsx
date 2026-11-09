/**
 * The build as Terraform (#668): one tab per file `emitFiles` returns,
 * rendered with the site's CodeBlock, and a button that downloads them all
 * as a zip. The tab strip carries every file name, so the pre-rendered page
 * already says what the build produces; only the selected file's content is
 * in the DOM at a time.
 *
 * THE ZIP IS A LAZY CHUNK. `fflate` is imported inside the click handler, so
 * a reader who never downloads never fetches it, and the pre-render never
 * evaluates it. The entries are exactly the emitted files under exactly their
 * paths, which is what the test checks against the tab names: a learner who
 * unzips gets what the tabs showed, nothing renamed and nothing extra.
 *
 * Below the files, "Validate on the lab" (LzLabValidate.jsx, #672) sends the
 * same files, unchanged, to the Hybrid Lab's terraform-validate job, and is
 * disabled with its reason while the lab is not taking public jobs, which
 * is the default.
 */
import React, { useMemo, useState } from 'react';
import { Download, Loader2 } from 'lucide-react';
import CodeBlock from '@/components/shared/CodeBlock';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { emitFiles } from '@/lib/landingZone';
import { LzLabValidate } from './LzLabValidate';
import { HINT_CLASS } from './styles';

export const ZIP_NAME = 'landing-zone.zip';

/** CodeBlock's language for an emitted path: Markdown for the README, HCL for the rest. */
export function languageFor(path) {
  return path.endsWith('.md') ? 'markdown' : 'hcl';
}

/** A DOM id fragment from a file path. */
const slug = (path) => path.replace(/[^a-z0-9]+/gi, '-').toLowerCase();

/**
 * The zip bytes for a list of files. Async because the compressor is a lazy
 * chunk; separate from the component so the test can call it directly.
 *
 * @param {Array<{ path: string, content: string }>} files
 * @returns {Promise<Uint8Array>}
 */
export async function buildZip(files) {
  const { strToU8, zipSync } = await import('fflate');
  const entries = Object.fromEntries(files.map((f) => [f.path, strToU8(f.content)]));
  return zipSync(entries, { level: 6 });
}

/** Hands the bytes to the browser as a download. */
function saveBlob(bytes, name) {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/zip' }));
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    anchor.rel = 'noopener';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}

const TAB_CLASS =
  'rounded-t-md border border-b-0 px-3 py-1.5 font-mono text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
const TAB_ACTIVE =
  'border-slate-300 bg-background text-slate-950 dark:border-slate-600 dark:text-white';
const TAB_IDLE =
  'border-transparent text-slate-600 hover:text-slate-950 dark:text-slate-400 dark:hover:text-white';

/**
 * @param {object} props
 * @param {object} props.state  the normalised build
 */
export function LzFiles({ state }) {
  const files = useMemo(() => emitFiles(state), [state]);
  const [activePath, setActivePath] = useState(null);
  const active = files.find((f) => f.path === activePath) ?? files[0];
  const [download, setDownload] = useState('idle');

  const onDownload = async () => {
    setDownload('busy');
    try {
      saveBlob(await buildZip(files), ZIP_NAME);
      setDownload('idle');
    } catch {
      setDownload('failed');
    }
  };

  // Left and right arrows move between tabs, as the tabs pattern expects.
  const onTabKey = (event, index) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    event.preventDefault();
    const step = event.key === 'ArrowRight' ? 1 : -1;
    const next = files[(index + step + files.length) % files.length];
    setActivePath(next.path);
    document.getElementById(`lz-tab-${slug(next.path)}`)?.focus();
  };

  return (
    <Card data-testid="lz-files">
      <CardHeader className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex flex-col gap-1.5">
          <CardTitle className="text-xl">Generated Terraform</CardTitle>
          <CardDescription>
            The files this build becomes, in the shape of the examples the Azure Verified Modules
            ship. Every module is pinned; the README says what to fill in before a plan.
          </CardDescription>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onDownload}
          disabled={download === 'busy'}
          data-testid="lz-download"
          className="shrink-0"
        >
          {download === 'busy' ? (
            <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          ) : (
            <Download className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
          )}
          Download zip
        </Button>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {download === 'failed' ? (
          <p role="alert" className="text-sm text-amber-700 dark:text-amber-400">
            The zip could not be built in this browser. Copy each file from its tab instead.
          </p>
        ) : null}
        <div
          role="tablist"
          aria-label="Generated files"
          className="flex flex-wrap gap-1 border-b border-slate-300 dark:border-slate-600"
        >
          {files.map((f, index) => {
            const isActive = f === active;
            return (
              <button
                key={f.path}
                type="button"
                role="tab"
                id={`lz-tab-${slug(f.path)}`}
                aria-selected={isActive}
                aria-controls="lz-file-panel"
                tabIndex={isActive ? 0 : -1}
                onClick={() => setActivePath(f.path)}
                onKeyDown={(event) => onTabKey(event, index)}
                className={`${TAB_CLASS} ${isActive ? TAB_ACTIVE : TAB_IDLE}`}
              >
                {f.path}
              </button>
            );
          })}
        </div>
        <div
          role="tabpanel"
          id="lz-file-panel"
          aria-labelledby={`lz-tab-${slug(active.path)}`}
          data-path={active.path}
          className="-my-6"
        >
          <CodeBlock language={languageFor(active.path)} value={active.content} />
        </div>
        <p className={HINT_CLASS}>
          {files.length} {files.length === 1 ? 'file' : 'files'}. Generated for learning and never
          applied here: this page touches no tenant, and the README in the zip says the same.
        </p>
        <LzLabValidate files={files} />
      </CardContent>
    </Card>
  );
}
