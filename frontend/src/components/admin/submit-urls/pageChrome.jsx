/**
 * The furniture around the four stages: the step header, the selection
 * summary, and the result banner (#634).
 *
 * Small and presentational. They sit together because none is big enough to
 * earn a file and all three exist only for this page.
 */
import { Badge } from '@/components/ui/badge';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { CheckCircle, AlertCircle } from 'lucide-react';
import { getQueueReviewPath } from './persistStage';
import { getPublishTargetLabel } from './pageMeta';

/**
 * The step and readiness badges under the page header. The heading itself is
 * the shared PageHeader on SubmitUrlsPage (ADR 0033 §7); this strip is the
 * builder's own progress: Options → Draft → Images → Final QA.
 */
export function WorkflowHeader({ currentStep, readinessComplete, readinessScore, readinessTotal }) {
  return (
    <div>
      <p className="text-sm text-muted-foreground">
        Guided workflow: Options → Draft → Images → Final QA and publish-style preview.
      </p>
      <div className="flex flex-wrap gap-2 mt-2" aria-label="Builder progress">
        {[1, 2, 3, 4].map((step) => (
          <Badge key={step} variant={currentStep >= step ? 'default' : 'outline'}>
            Step {step}
          </Badge>
        ))}
        <Badge variant={readinessComplete ? 'default' : 'outline'}>
          Readiness {readinessScore}/{readinessTotal}
        </Badge>
      </div>
    </div>
  );
}

export function SelectionSummaryCard({
  provider,
  inferredProvider,
  contentType,
  resolvedBlogLandingProvider,
  publishedDate,
}) {
  const resolvedProvider = provider || inferredProvider || 'Auto-detect';
  return (
    <Card className="border-border/60">
      <CardHeader>
        <CardTitle className="text-sm">Current Builder Selections</CardTitle>
        <CardDescription>These values carry into draft, images, and final save.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-2">
        <Badge variant="outline">Provider: {resolvedProvider}</Badge>
        <Badge variant="outline">Type: {getPublishTargetLabel(contentType)}</Badge>
        <Badge variant="outline">Target: {getPublishTargetLabel(contentType)}</Badge>
        {contentType === 'blog' && (
          <Badge variant="outline">
            Landing: {resolvedBlogLandingProvider || 'Match provider'}
          </Badge>
        )}
        {publishedDate && <Badge variant="outline">Date: {publishedDate}</Badge>}
      </CardContent>
    </Card>
  );
}

export default function FeedbackCard({ variant, message, contentId }) {
  const isSuccess = variant === 'success';
  const borderClass = isSuccess
    ? 'border-green-200 dark:border-green-800'
    : 'border-red-200 dark:border-red-800';
  const iconClass = isSuccess ? 'text-green-600' : 'text-red-600';
  const Icon = isSuccess ? CheckCircle : AlertCircle;

  return (
    <Card className={borderClass}>
      <CardContent className="p-4 flex items-start gap-3">
        <Icon className={`h-5 w-5 shrink-0 mt-0.5 ${iconClass}`} />
        <div className="text-sm space-y-1">
          <p className="font-medium">{isSuccess ? 'Success' : 'Error'}</p>
          <p className={isSuccess ? '' : 'text-muted-foreground'}>{message}</p>
          {isSuccess && contentId && (
            <a href={getQueueReviewPath(contentId)} className="text-blue-600 hover:underline">
              Open in Review Queue
            </a>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
