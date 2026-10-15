/**
 * The blog review board's actions sidebar (ADR 0033, PR #841): published
 * URL, pipeline triggers with the AI cover prompt, review notes, workflow
 * actions, document info and the debug tools.
 */
import React from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Newspaper, PenSquare, XCircle, Loader2, Wand2, Image as ImageIcon } from 'lucide-react';
import { formatPostDate } from '@/lib/blogUtils';
import { ExternalAnchor } from './BlogReviewContent';
import {
  deriveWorkflowFlags,
  describeCoverPlanSource,
  formatPlanPagePaths,
} from './blogReviewModel';

function PublishedUrlCard({ displayUrl }) {
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs font-medium text-muted-foreground mb-2">
          Published URL:{' '}
          {displayUrl ? (
            <ExternalAnchor href={displayUrl} maxLength={60} />
          ) : (
            <span className="text-sm text-muted-foreground">Not yet generated.</span>
          )}
        </p>
      </CardContent>
    </Card>
  );
}

const LINK_BUTTON_CLASS = 'text-blue-600 hover:underline dark:text-blue-400';

function AssignedSetNote({ plan, navigate }) {
  return (
    <>
      Without an override the cover uses the{' '}
      <button
        type="button"
        className={LINK_BUTTON_CLASS}
        onClick={() => navigate(`/admin/image-prompts?set=${encodeURIComponent(plan.setName)}`)}
      >
        {plan.setName}
      </button>{' '}
      image set
      {describeCoverPlanSource(plan)}, with the hero slot template, style rules and keyword matrix.
    </>
  );
}

function MissingSetNote({ plan, navigate }) {
  return (
    <>
      No image set is assigned to this content&apos;s pages
      {formatPlanPagePaths(plan)}, so the built-in illustration prompt applies.{' '}
      <button
        type="button"
        className={LINK_BUTTON_CLASS}
        onClick={() => navigate('/admin/image-prompts')}
      >
        Assign one on Image Prompts
      </button>
      .
    </>
  );
}

/** What the cover will be generated from when the override is empty (ADR 0033). */
function CoverPlanNote({ imagePrompt, plan, navigate }) {
  if (imagePrompt.trim()) {
    return 'Your override is sent as written; the image set and keyword matrix are not applied.';
  }
  if (plan === null) return 'Checking which image set applies…';
  if (plan.setName) return <AssignedSetNote plan={plan} navigate={navigate} />;
  return <MissingSetNote plan={plan} navigate={navigate} />;
}

function PipelineTriggersCard({
  blog,
  state,
  patch,
  isCoverGenerating,
  onInspect,
  onGenerateCover,
  navigate,
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Pipeline Triggers</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <Button onClick={onInspect} variant="outline" size="sm" className="w-full gap-2">
          <Wand2 className="h-4 w-4" />
          {blog.inspectTrigger ? 'Inspecting (Click to Retry)...' : 'Re-Inspect with AI'}
        </Button>

        <div className="space-y-2">
          <Label
            htmlFor="ai-cover-prompt-override"
            className="text-xs font-medium text-muted-foreground"
          >
            AI Image Prompt Override
          </Label>
          <Textarea
            id="ai-cover-prompt-override"
            value={state.imagePrompt}
            onChange={(e) => patch({ imagePrompt: e.target.value })}
            placeholder="Leave empty to use the assigned image set; type a prompt to use it verbatim."
            className="text-xs min-h-20"
          />
          <p className="text-[11px] text-muted-foreground">
            <CoverPlanNote
              imagePrompt={state.imagePrompt}
              plan={state.coverPromptPlan}
              navigate={navigate}
            />
          </p>
          <Button
            onClick={onGenerateCover}
            variant="outline"
            size="sm"
            className="w-full gap-2"
            disabled={isCoverGenerating}
          >
            <ImageIcon className="h-4 w-4" />
            {isCoverGenerating ? 'Generating...' : 'Generate AI Cover'}
          </Button>
          {state.coverTriggerMessage && (
            <p className="text-[11px] text-muted-foreground">{state.coverTriggerMessage}</p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function ReviewNotesCard({ notes, onChange }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Review Notes</CardTitle>
      </CardHeader>
      <CardContent>
        <Textarea
          value={notes}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Optional notes about this content..."
          rows={3}
        />
      </CardContent>
    </Card>
  );
}

/** A full-width workflow button whose icon becomes a spinner while its verb is in flight. */
function WorkflowButton({ busy, icon: Icon, children, ...buttonProps }) {
  return (
    <Button className="w-full gap-2" {...buttonProps}>
      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Icon className="h-4 w-4" />}
      {children}
    </Button>
  );
}

function EditorButton({ canOpenEditor, onClick }) {
  return (
    <Button
      variant={canOpenEditor ? undefined : 'outline'}
      onClick={onClick}
      className="w-full gap-2"
    >
      <PenSquare className="h-4 w-4" />
      {canOpenEditor ? 'Open in Editor' : 'Open in Editor (Fallback)'}
    </Button>
  );
}

/**
 * The review sidebar's workflow card: the transitions deriveWorkflowFlags
 * offers for the item's status, disabled while one runs, with the last refusal
 * shown above them.
 */
function WorkflowActionsCard({ blogId, view, actions, navigate }) {
  const flags = deriveWorkflowFlags(view);
  const { transitioning, transitionError } = actions;
  const busy = Boolean(transitioning);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Workflow Actions</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {transitionError && <p className="text-xs text-destructive mb-2">{transitionError}</p>}

        {flags.showTransitions && (
          <>
            {flags.recallInsteadOfApprove ? (
              <WorkflowButton
                onClick={actions.handleRecall}
                variant="outline"
                disabled={busy}
                busy={transitioning === 'recalling'}
                icon={Newspaper}
              >
                Recall to Review Queue
              </WorkflowButton>
            ) : (
              <WorkflowButton
                onClick={() => actions.handleTransition('approved')}
                disabled={busy || !view.hasProvider}
                busy={transitioning === 'approving'}
                icon={Newspaper}
              >
                Send to Publish Queue
              </WorkflowButton>
            )}
            <WorkflowButton
              onClick={() => actions.handleTransition('rejected')}
              variant="destructive"
              disabled={busy}
              busy={transitioning === 'rejecting'}
              icon={XCircle}
            >
              Reject
            </WorkflowButton>
          </>
        )}

        {flags.showPublishPane && (
          <Button onClick={() => navigate('/admin/publish')} className="w-full gap-2">
            Go to Publish Pane
          </Button>
        )}

        <EditorButton
          canOpenEditor={flags.canOpenEditor}
          onClick={() => navigate(`/admin/editor/${blogId}`)}
        />

        {flags.showPublishedNavigation && (
          <>
            <Button onClick={() => navigate('/admin/publish')} className="w-full gap-2">
              Go to Publish Pane
            </Button>
            <Button
              variant="outline"
              onClick={() => navigate('/admin/calendar')}
              className="w-full gap-2"
            >
              Schedule on Calendar
            </Button>
          </>
        )}

        {flags.needsProvider && (
          <p className="text-xs text-red-600 dark:text-red-300 mt-2">
            Select a Cloud Provider to enable publish actions.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

const DOCUMENT_INFO_ROWS = Object.freeze([
  { label: 'ID', read: (blog) => blog.id },
  { label: 'Created', read: (blog) => formatPostDate(blog['Created At']) },
  { label: 'Scraped', read: (blog) => blog.scrapedMethod || 'N/A' },
  { label: 'Word Count', read: (blog) => blog.wordCount || 'N/A' },
  { label: 'AI Model', read: (blog) => blog.analysisModel || 'N/A' },
]);

function DocumentInfoCard({ blog }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm">Document Info</CardTitle>
      </CardHeader>
      <CardContent className="text-xs space-y-1 text-muted-foreground">
        {DOCUMENT_INFO_ROWS.map(({ label, read }) => (
          <p key={label}>
            <strong>{label}:</strong> {read(blog)}
          </p>
        ))}
        {blog.inspectError && (
          <p className="text-destructive">
            <strong>Error:</strong> {blog.inspectError}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function DebugToolsCard({ blog, onReset }) {
  return (
    <Card className="border-red-200 dark:border-red-900/30">
      <CardHeader>
        <CardTitle className="text-xs text-red-500 uppercase tracking-wider font-bold">
          Debug Tools
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex gap-2">
          <Button variant="destructive" size="sm" onClick={onReset} className="text-xs h-7">
            Force Reset Status
          </Button>
        </div>
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer hover:text-foreground">
            View Raw Content Record
          </summary>
          <pre className="mt-2 p-2 bg-muted rounded overflow-auto max-h-60">
            {JSON.stringify(blog, null, 2)}
          </pre>
        </details>
      </CardContent>
    </Card>
  );
}

export function BlogReviewSidebar({
  blog,
  blogId,
  view,
  state,
  patch,
  actions,
  isCoverGenerating,
  navigate,
}) {
  return (
    <div className="space-y-4">
      <PublishedUrlCard displayUrl={view.displayUrl} />
      <PipelineTriggersCard
        blog={blog}
        state={state}
        patch={patch}
        isCoverGenerating={isCoverGenerating}
        onInspect={actions.handleTriggerInspect}
        onGenerateCover={actions.handleTriggerCover}
        navigate={navigate}
      />
      <ReviewNotesCard notes={state.notes} onChange={(value) => patch({ notes: value })} />
      <WorkflowActionsCard blogId={blogId} view={view} actions={actions} navigate={navigate} />
      <DocumentInfoCard blog={blog} />
      <DebugToolsCard blog={blog} onReset={actions.handleResetStatus} />
    </div>
  );
}
