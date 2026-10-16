/**
 * Source-grounded episodes on the Listen & Learn admin page (#433).
 *
 * Two pieces. `SourceGroundingPanel` is the form: a title, a textarea of URLs
 * one per line, and a Generate button that queues one episode built from
 * those pages and videos. Each line is classified as it is typed — page,
 * video, or a sentence saying why it will be refused — by the same rule the
 * server applies (lib/sourceUrl.js, pinned equal by a test on the functions
 * side), so the owner sees what the model will be given before spending on
 * it and never learns of a bad line from a failed job.
 *
 * `EpisodeSources` is the review half: the list an episode was built from,
 * with links, shown beside its transcript. Reviewing an AI-written episode
 * without seeing what it was given is reviewing half of it. It renders
 * nothing for a guide-grounded episode, whose grounding is the study guide
 * the set already names.
 *
 * Its own file so the page's edit is one import and two mounts, and so the
 * form can be tested without the page's job polling.
 */
import React, { useState } from 'react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { AlertTriangle, ExternalLink, FileText, Loader2, Play, Video } from 'lucide-react';
import { classifySourceLines } from '@/lib/sourceUrl';
import { generateSourceEpisode } from '@/lib/sourceEpisode';

/** Sub-cent runs are normal here, so two decimals would read as free. */
const formatCost = (usd) => (usd >= 0.01 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(4)}`);

const KIND_LABEL = { page: 'page', video: 'video' };

function SourceLine({ line }) {
  if (line.error) {
    return (
      <li className="flex items-start gap-1.5 text-xs text-destructive">
        <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
        <span className="break-all">
          {line.url} {line.error}
        </span>
      </li>
    );
  }
  const Icon = line.kind === 'video' ? Video : FileText;
  return (
    <li className="flex items-start gap-1.5 text-xs text-muted-foreground">
      <Icon className="h-3.5 w-3.5 mt-0.5 shrink-0" />
      <Badge variant="outline" className="text-xs px-1 py-0">
        {KIND_LABEL[line.kind]}
      </Badge>
      <span className="break-all">{line.url}</span>
    </li>
  );
}

/**
 * @param {object} props
 * @param {string} props.platform
 * @param {string} props.examCode
 * @param {string} [props.certTitle]
 * @param {() => Promise<void>|void} [props.onDone] called after the job reaches a terminal state, so the page reloads the set
 */
export function SourceGroundingPanel({ platform, examCode, certTitle, onDone }) {
  const [title, setTitle] = useState('');
  const [urls, setUrls] = useState('');
  const [generating, setGenerating] = useState(false);
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState(null);

  const lines = classifySourceLines(urls);
  const valid = lines.filter((line) => !line.error);
  const invalid = lines.filter((line) => line.error);
  const pages = valid.filter((line) => line.kind === 'page').length;
  const videos = valid.filter((line) => line.kind === 'video').length;

  const ready =
    Boolean(examCode?.trim()) &&
    Boolean(title.trim()) &&
    valid.length > 0 &&
    invalid.length === 0 &&
    !generating;

  const handleSubmit = async (event) => {
    event.preventDefault();
    if (!ready) return;
    setGenerating(true);
    setError(null);
    setProgress('Queued…');
    try {
      const job = await generateSourceEpisode({
        platform,
        examCode: examCode.trim(),
        certTitle: certTitle?.trim() || undefined,
        title: title.trim(),
        sources: valid.map(({ kind, url }) => ({ kind, url })),
        onUpdate: (j) => setProgress(`Job ${j.status}…`),
      });
      const report = job?.result;
      if (job?.status === 'succeeded' && report) {
        const audio = report.audioError ? ', without audio' : '';
        const cost = report.costUsd ? ` · ${formatCost(report.costUsd)}` : '';
        setProgress(`Drafted from ${report.sourceCount} sources${audio}${cost}`);
      } else {
        // The job's own sentence — the router's refusal, a source Gemini
        // could not read — is the thing worth showing.
        setProgress(null);
        setError(job?.error || `Job ${job?.status}`);
      }
      await onDone?.();
    } catch (err) {
      setError(err.message);
      setProgress(null);
    } finally {
      setGenerating(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Generate an episode from sources</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-3">
          <p className="text-xs text-muted-foreground">
            One episode for {examCode?.trim() ? examCode.trim() : 'the exam code above'}, built from
            web pages and YouTube videos you choose rather than the study guide. It is a second kind
            of episode — the guide-grounded ones are unchanged — and it lands as a draft in the same
            set, marked as source-grounded, with its sources listed beside the transcript.
          </p>
          {error && (
            <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </div>
          )}
          <label className="text-xs font-medium space-y-1 block">
            <span>Episode title</span>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Entra ID basics"
              maxLength={120}
              required
            />
          </label>
          <label className="text-xs font-medium space-y-1 block">
            <span>Sources, one URL per line</span>
            <Textarea
              value={urls}
              onChange={(e) => setUrls(e.target.value)}
              placeholder={
                'https://learn.microsoft.com/entra/fundamentals/whatis\nhttps://www.youtube.com/watch?v=…'
              }
              rows={5}
              spellCheck={false}
            />
          </label>
          {lines.length > 0 && (
            <ul className="space-y-1" aria-label="Classified sources">
              {lines.map((line, i) => (
                <SourceLine key={`${line.url}-${i}`} line={line} />
              ))}
            </ul>
          )}
          <div className="flex items-center gap-3">
            <Button type="submit" disabled={!ready}>
              {generating ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Play className="h-4 w-4 mr-2" />
              )}
              Generate from sources
            </Button>
            <span className="text-xs text-muted-foreground">
              {progress ||
                (lines.length > 0
                  ? `${pages} ${pages === 1 ? 'page' : 'pages'}, ${videos} ${videos === 1 ? 'video' : 'videos'}${invalid.length ? `, ${invalid.length} refused` : ''}`
                  : null)}
            </span>
          </div>
          <p className="text-xs text-muted-foreground">
            Gemini reads the pages and watches the videos itself, so this needs Gemini enabled on
            the AI Engine page; no other provider can, and the run refuses rather than falling back
            to one. At most 20 pages and 10 videos. Re-running the same title adds a new take to the
            same chapter and keeps its approval; the earlier take stays in its versions.
          </p>
        </form>
      </CardContent>
    </Card>
  );
}

/**
 * What a source-grounded episode was built from, beside its transcript.
 *
 * @param {object} props
 * @param {{ kind?: string, sources?: Array<{ kind: string, url: string, title?: string }> }} props.episode
 */
export function EpisodeSources({ episode }) {
  if (episode?.kind !== 'source') return null;
  const sources = Array.isArray(episode.sources) ? episode.sources : [];
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium flex items-center gap-1.5">
        <Badge variant="secondary" className="text-xs px-1 py-0">
          Source-grounded
        </Badge>
        Built from {sources.length} {sources.length === 1 ? 'source' : 'sources'}
      </p>
      {sources.length > 0 && (
        <ul className="space-y-0.5" aria-label="Episode sources">
          {sources.map((source, i) => {
            const Icon = source.kind === 'video' ? Video : FileText;
            return (
              <li
                key={`${source.url}-${i}`}
                className="flex items-start gap-1.5 text-xs text-muted-foreground"
              >
                <Icon className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                <a
                  href={source.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline-offset-2 hover:underline break-all inline-flex items-center gap-1"
                >
                  {source.title || source.url}
                  <ExternalLink className="h-3 w-3 shrink-0" />
                </a>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export default SourceGroundingPanel;
