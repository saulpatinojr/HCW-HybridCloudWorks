/**
 * Console — submit a job and watch it run (#577).
 *
 * Unchanged from the tab of the same name: the same job types, the same
 * payload hints, the same poll and the same cancel. What a job printed
 * yesterday is the Jobs tab's question now.
 *
 * The form and the output pane are separate components, and the poll is
 * useJobWatch: Qlty counts a closure's branches into the function that holds
 * it, so with all three written inline this tab was one function of complexity
 * 19 with six exits.
 */
import React, { useState } from 'react';
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/ui/use-toast';
import { Ban, Loader2, Send, Terminal } from 'lucide-react';
import { postJSON } from '@/lib/api';
import { isTerminalJobStatus } from '@/lib/labsPolling';
import { StatusBadge } from './shared';
import { PAYLOAD_PLACEHOLDERS, formatDuration, formatTime } from './labsView';
import useJobWatch from './useJobWatch';

function PollErrorNotice({ pollError }) {
  if (!pollError) return null;
  return (
    <p className="text-xs text-amber-600 dark:text-amber-400" role="status">
      Can&apos;t reach the status endpoint ({pollError}). The job is still running — retrying.
    </p>
  );
}

/** The exit code once the agent reports one. `0` is a value, so `!exit` is wrong. */
function ExitCode({ exit }) {
  if (exit === null || exit === undefined) return null;
  return <span className="font-mono text-muted-foreground">exit {exit}</span>;
}

/**
 * Cancel, offered only while the job is still queued — once an agent has
 * claimed it there is nothing left for the API to withdraw.
 */
function CancelButton({ status, cancelling, onCancel }) {
  if (status !== 'queued') return null;
  return (
    <Button
      size="sm"
      variant="outline"
      onClick={onCancel}
      disabled={cancelling}
      className="gap-1 ml-auto"
    >
      {cancelling ? <Loader2 className="h-3 w-3 animate-spin" /> : <Ban className="h-3 w-3" />}
      Cancel
    </Button>
  );
}

/**
 * The one line of metadata above the output: id, status, agent, exit, cancel.
 *
 * Its five conditionals measured 11 together, so the two that are whole
 * decisions of their own are components. Destructured once rather than read
 * through `activeJob?.` five times, which counts as five branches.
 */
function JobHeader({ activeJobId, activeJob, cancelling, onCancel }) {
  const { status, agentId, exitCode } = activeJob || {};
  return (
    <div className="flex items-center gap-2 flex-wrap text-xs">
      <span className="font-mono text-muted-foreground">{activeJobId}</span>
      <StatusBadge status={status || 'queued'} />
      {agentId && <span className="text-muted-foreground">on {agentId}</span>}
      <ExitCode exit={exitCode} />
      <CancelButton status={status} cancelling={cancelling} onCancel={onCancel} />
    </div>
  );
}

/**
 * What the pane shows, split from the pane itself: Qlty counts the branches of
 * a header, a body and a footer together, and this component came back at 19.
 */
function JobOutputPane({ activeJobId, activeJob, cancelling, onCancel, pollError }) {
  const isTerminal = isTerminalJobStatus(activeJob?.status);
  if (!activeJobId) {
    return (
      <p className="text-sm text-muted-foreground py-8 text-center">
        Submit a job to watch it run.
      </p>
    );
  }
  return (
    <>
      <JobHeader
        activeJobId={activeJobId}
        activeJob={activeJob}
        cancelling={cancelling}
        onCancel={onCancel}
      />
      <PollErrorNotice pollError={pollError} />
      <pre className="bg-muted/60 border border-border rounded-md p-3 text-xs font-mono whitespace-pre-wrap break-words min-h-[200px] max-h-[400px] overflow-auto">
        {activeJob?.output ??
          (isTerminal ? '(no output)' : 'Waiting for the agent to pick this up…')}
      </pre>
      {isTerminal && (
        <p className="text-xs text-muted-foreground">
          Finished {formatTime(activeJob?.finishedAt)} · duration {formatDuration(activeJob || {})}
        </p>
      )}
    </>
  );
}

/**
 * What to submit: the allowlisted type, its payload, and the hints the server
 * sent for it. Split from the tab because its four conditional renders were
 * counted into the tab's own complexity.
 */
function SubmitJobForm({ jobTypes, type, spec, payload, submitting, onType, onPayload, onSubmit }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Submit a job</CardTitle>
        <CardDescription>
          Job types come from a server-side allowlist; the agent only ever runs fixed, sandboxed
          commands — the payload is mounted as a read-only file.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <Label className="text-xs" htmlFor="labs-job-type">
            Job type
          </Label>
          <select
            id="labs-job-type"
            value={type}
            onChange={(e) => onType(e.target.value)}
            className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          >
            {jobTypes.map((jt) => (
              <option key={jt.type} value={jt.type}>
                {jt.type}
              </option>
            ))}
          </select>
          {spec?.description && (
            <p className="text-xs text-muted-foreground mt-1">{spec.description}</p>
          )}
        </div>
        <div>
          <Label className="text-xs" htmlFor="labs-job-payload">
            Payload
          </Label>
          <Textarea
            id="labs-job-payload"
            value={payload}
            onChange={(e) => onPayload(e.target.value)}
            rows={10}
            placeholder={PAYLOAD_PLACEHOLDERS[type] || 'hello vps'}
            className="mt-1 font-mono text-xs"
          />
          {spec?.maxPayloadBytes && (
            <p className="text-xs text-muted-foreground mt-1">
              Max {Math.round(spec.maxPayloadBytes / 1024)} KB
            </p>
          )}
        </div>
        <Button onClick={onSubmit} disabled={submitting} className="gap-1.5">
          {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          Submit job
        </Button>
      </CardContent>
    </Card>
  );
}

/**
 * @param {object} props
 * @param {Array<object>} props.jobTypes the runner's allowlist
 * @param {{jobId: string, type?: string}|null} [props.watch] a job to open
 *   on: the Catalogue tab's Validate enqueues a lab's check and lands here
 *   with it (ADR 0033), so the pane shows that job rather than an empty one
 */
function ConsoleTab({ jobTypes, watch = null }) {
  const { toast } = useToast();
  const [type, setType] = useState(watch?.type || jobTypes[0]?.type || 'shell-echo');
  const [payload, setPayload] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [activeJobId, setActiveJobId] = useState(watch?.jobId ?? null);
  const [cancelling, setCancelling] = useState(false);
  // The status poll, and the read error kept apart from it — a failure to
  // *read* the status is not a status. (useJobWatch)
  const { job: activeJob, pollError } = useJobWatch(activeJobId);

  // Keep the selected type valid when the live job-type list arrives —
  // derived during render rather than synced via effect.
  const effectiveType =
    jobTypes.length && !jobTypes.some((jt) => jt.type === type) ? jobTypes[0].type : type;

  const handleSubmit = async () => {
    setSubmitting(true);
    try {
      // The textarea holds text; a type that accepts only `tar` (helm-template)
      // takes the base64 of the archive pasted there, and says so in its hint.
      const encodings = jobTypes.find((jt) => jt.type === effectiveType)?.payloadEncodings;
      const payloadEncoding = !encodings || encodings.includes('text') ? 'text' : encodings[0];
      const res = await postJSON('enqueueLabJob', {
        type: effectiveType,
        payload,
        payloadEncoding,
      });
      setActiveJobId(res.jobId);
      toast({ title: 'Job queued', description: `${type} → ${res.jobId}` });
    } catch (err) {
      toast({ title: 'Submit failed', description: err.message, variant: 'destructive' });
    } finally {
      setSubmitting(false);
    }
  };

  const handleCancel = async () => {
    if (!activeJobId) return;
    setCancelling(true);
    try {
      await postJSON('cancelLabJob', { jobId: activeJobId });
      toast({ title: 'Job cancelled' });
    } catch (err) {
      toast({ title: 'Cancel failed', description: err.message, variant: 'destructive' });
    } finally {
      setCancelling(false);
    }
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <SubmitJobForm
        jobTypes={jobTypes}
        type={effectiveType}
        spec={jobTypes.find((jt) => jt.type === effectiveType)}
        payload={payload}
        submitting={submitting}
        onType={setType}
        onPayload={setPayload}
        onSubmit={handleSubmit}
      />

      {/* Live job status + output */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Terminal className="h-4 w-4 text-muted-foreground" />
            Job output
          </CardTitle>
          <CardDescription>
            Polled from the API — updates as the agent claims, runs, and finishes the job.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <JobOutputPane
            activeJobId={activeJobId}
            activeJob={activeJob}
            cancelling={cancelling}
            onCancel={handleCancel}
            pollError={pollError}
          />
        </CardContent>
      </Card>
    </div>
  );
}

export default function LabsConsoleTab({ hub }) {
  return <ConsoleTab jobTypes={hub.jobTypes} watch={hub.watchJob} />;
}
