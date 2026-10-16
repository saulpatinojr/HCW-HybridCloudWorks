/**
 * Catalogue — every lab the site offers, and where each is published
 * (ADR 0033 "Labs"; the hub managed only the job runner before).
 *
 * The rows are the catalogue (data/labs/catalogue.js), which is a repository
 * file: adding or changing a lab is a pull request, so this tab has no
 * editor and says so. What it does have per row: the provider hubs the lab
 * is listed under, its difficulty, duration and step count, whether it is
 * listed publicly, the runner job type that checks it, a link to its public
 * page, and **Validate**, which enqueues that job type with the lab's own
 * sample payload through the same `enqueueLabJob` the Console uses and then
 * opens the Console on the job, so the operator watches the runner answer
 * exactly what a learner's check would.
 */
import React, { useState } from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/use-toast';
import { ExternalLink, Loader2, PlayCircle } from 'lucide-react';
import StatusBadge from '@/components/admin/shared/StatusBadge';
import EmptyState from '@/components/admin/shared/EmptyState';
import { postJSON } from '@/lib/api';
import { DIFFICULTY_LABELS, labPanePath, labs, primaryProvider } from '@/data/labs/catalogue';
import { providerName } from '@/components/labs/labsWords';
import { labStatusInfo } from './labsView';

/**
 * Validate: enqueue the lab's validation job with its sample payload, then
 * hand the job to the Console. Nothing is offered for a lab with no
 * validation; a lab whose job type the runner's allowlist does not carry
 * says so instead of failing on submit.
 */
function ValidateButton({ lab, jobTypes, onWatchJob }) {
  const { toast } = useToast();
  const [submitting, setSubmitting] = useState(false);
  if (!lab.validation) {
    return <span className="text-xs text-muted-foreground">No runner check</span>;
  }
  const offered = jobTypes.some((entry) => entry.type === lab.validation.jobType);
  if (!offered) {
    return (
      <span
        className="text-xs text-muted-foreground"
        title="The runner does not offer this job type"
      >
        {lab.validation.jobType} not offered
      </span>
    );
  }
  const submit = async () => {
    setSubmitting(true);
    try {
      const res = await postJSON('enqueueLabJob', {
        type: lab.validation.jobType,
        payload: lab.validation.samplePayload,
        payloadEncoding: lab.validation.payloadEncoding,
      });
      toast({
        title: 'Validation queued',
        description: `${lab.validation.jobType} for ${lab.title} → ${res.jobId}`,
      });
      onWatchJob(res.jobId, lab.validation.jobType);
    } catch (err) {
      toast({ title: 'Validate failed', description: err.message, variant: 'destructive' });
    } finally {
      setSubmitting(false);
    }
  };
  return (
    <Button
      size="sm"
      variant="outline"
      onClick={submit}
      disabled={submitting}
      aria-label={`Validate ${lab.title}`}
      className="gap-1.5"
    >
      {submitting ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
      ) : (
        <PlayCircle className="h-3.5 w-3.5" aria-hidden="true" />
      )}
      Validate
    </Button>
  );
}

function LabRow({ lab, jobTypes, onWatchJob }) {
  const publicPath = labPanePath(primaryProvider(lab), lab.id);
  return (
    <tr className="border-b border-border/50 last:border-0 align-top" data-lab={lab.id}>
      <td className="px-3 py-2">
        <p className="font-semibold">{lab.title}</p>
        <p className="font-mono text-xs text-muted-foreground">{lab.id}</p>
      </td>
      <td className="px-3 py-2">{lab.providers.map(providerName).join(', ')}</td>
      <td className="px-3 py-2">{DIFFICULTY_LABELS[lab.difficulty]}</td>
      <td className="px-3 py-2 whitespace-nowrap">{lab.estimatedMinutes} min</td>
      <td className="px-3 py-2">{lab.steps.length}</td>
      <td className="px-3 py-2">
        <StatusBadge status={labStatusInfo(lab)} size="xs" />
      </td>
      <td className="px-3 py-2 font-mono">{lab.validation?.jobType ?? '—'}</td>
      <td className="px-3 py-2">
        <div className="flex flex-wrap items-center gap-2">
          <a
            href={publicPath}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-xs font-medium underline underline-offset-4 hover:text-primary"
          >
            <ExternalLink className="h-3 w-3" aria-hidden="true" />
            Public page
            <span className="sr-only"> for {lab.title} (opens in a new tab)</span>
          </a>
          <ValidateButton lab={lab} jobTypes={jobTypes} onWatchJob={onWatchJob} />
        </div>
      </td>
    </tr>
  );
}

export default function CatalogueTab({ hub }) {
  const { jobTypes, onWatchJob } = hub;
  if (labs.length === 0) {
    return (
      <EmptyState
        title="The catalogue is empty"
        description="A lab is a row in frontend/src/data/labs/catalogue.js plus one entry in the workspace template; add the first one in a pull request."
      />
    );
  }
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Every lab the site offers, in catalogue order. The catalogue is a repository file, so a new
        lab or a changed step is a pull request; Validate runs each lab&apos;s check on the runner
        with its sample payload and opens the Console on the job.
      </p>
      <Card className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border text-left text-muted-foreground">
              <th className="px-3 py-2 font-medium">Lab</th>
              <th className="px-3 py-2 font-medium">Providers</th>
              <th className="px-3 py-2 font-medium">Difficulty</th>
              <th className="px-3 py-2 font-medium">Duration</th>
              <th className="px-3 py-2 font-medium">Steps</th>
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 font-medium">Check</th>
              <th className="px-3 py-2 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody>
            {labs.map((lab) => (
              <LabRow key={lab.id} lab={lab} jobTypes={jobTypes} onWatchJob={onWatchJob} />
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
