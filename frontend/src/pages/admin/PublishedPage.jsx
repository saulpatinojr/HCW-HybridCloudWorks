import React, { useState } from 'react';
import ConfirmModal from '@/components/admin/ConfirmModal';
import { Link, useNavigate } from 'react-router';
import { useAuthReady } from '@/hooks/useAuthReady';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { Calendar, Rocket } from 'lucide-react';
import EmptyState from '@/components/admin/shared/EmptyState';
import PageHeader from '@/components/admin/shared/PageHeader';
import { contentStatusInfo } from '@/lib/status';
import { useToast } from '@/components/ui/use-toast';
import { ADMIN_ROUTES } from '@/config/admin';
import RehostImagesPanel from './RehostImagesPanel';

import {
  getPrePublishFailures,
  slugRowOverride,
  getReviewPath,
  PUBLISH_HELP,
  sortByUpdatedAtDesc,
  sortByPublishedAtDesc,
} from '@/components/admin/published/publishHelpers';
import PrePublishModal from '@/components/admin/published/PrePublishModal';
import {
  usePublishWorkflow,
  PublishDiagnostics,
} from '@/components/admin/published/usePublishWorkflow';
import { PublishedRow, StagedRow } from './published/PublishRows';
import {
  useImageDrafts,
  usePodcastTranscript,
  usePublishSnapshot,
} from './published/usePublishedState';

export { getPrePublishFailures, slugRowOverride };

// The publishable statuses by their canonical names (content-status.js
// PUBLISHABLE_NORMALIZED_STATUSES); the legacy spellings resolve to them.
const PUBLISHABLE = ['approved', 'forge_ready', 'published'];

/** Opens the row whose id is given, or closes it when it is already open. */
const toggleId = (id) => (current) => (current === id ? '' : id);

/** The Publish stage, where content goes live, read as one snapshot; its publish and unpublish buttons are gated because the routes behind them are publisher. */
export default function PublishedPage() {
  const navigate = useNavigate();
  const { authReady } = useAuthReady();
  const { snapshot, loading, queryErrorMessage } = usePublishSnapshot(authReady);
  const [localLiveOverrides, setLocalLiveOverrides] = useState({});
  const [expandedImagesId, setExpandedImagesId] = useState('');
  // #400: which published row has its slug control open, and the fields a
  // successful set-slug returned, so the row's "View Live" link points at the
  // new URL without waiting for a snapshot refetch.
  const [expandedSlugId, setExpandedSlugId] = useState('');
  const [slugOverrides, setSlugOverrides] = useState({});
  const { toast } = useToast();
  const images = useImageDrafts();
  const transcript = usePodcastTranscript(toast);

  const isItemLive = (item) => {
    if (typeof localLiveOverrides[item.id] === 'boolean') return localLiveOverrides[item.id];
    return item.Live === true;
  };

  const readyToPublish = (snapshot.readyCandidates || [])
    .filter((item) => !isItemLive(item) && PUBLISHABLE.includes(contentStatusInfo(item).id))
    .sort(sortByUpdatedAtDesc);

  const published = (snapshot.publishedItems || [])
    .filter((item) => isItemLive(item))
    .sort(sortByPublishedAtDesc);

  const withSlugOverride = (item) =>
    slugOverrides[item.id] ? { ...item, ...slugOverrides[item.id] } : item;

  const applySlugResult = (contentId, result) => {
    const override = slugRowOverride(result);
    if (Object.keys(override).length === 0) return;
    // Merged onto whatever this row already carried, not substituted for it —
    // see slugRowOverride. A second apply that reports fewer fields than the
    // first must not drop the first's.
    setSlugOverrides((prev) => ({
      ...prev,
      [contentId]: { ...(prev[contentId] || {}), ...override },
    }));
  };

  const workflow = usePublishWorkflow({
    navigate,
    withImageOverride: images.withImageOverride,
    setLocalLiveOverrides,
  });
  const { publishError, publishDebug, unpublishTarget, setUnpublishTarget } = workflow;

  if (loading) {
    return <Spinner label="Loading published articles" className="min-h-[40vh]" />;
  }

  const errors = [queryErrorMessage, publishError, images.imageError];

  return (
    <div className="space-y-4">
      <PageHeader
        icon={Rocket}
        help={PUBLISH_HELP}
        status={
          <span className="text-muted-foreground">
            {snapshot.readyTotal || readyToPublish.length} staged for go-live from Review or Editor
            · {snapshot.publishedTotal || published.length} already live
          </span>
        }
      >
        {errors.map(
          (message, i) =>
            message && (
              <p key={i} className="text-sm text-destructive">
                {message}
              </p>
            )
        )}
        <PublishDiagnostics publishDebug={publishDebug} />
      </PageHeader>

      <Card>
        <CardContent className="p-4 space-y-3">
          <div className="flex items-center justify-between">
            <p className="font-medium">Staged for Publish</p>
            <Button variant="outline" size="sm" onClick={() => navigate('/admin/calendar')}>
              <Calendar className="h-4 w-4 mr-2" />
              Open Calendar
            </Button>
          </div>

          {readyToPublish.length === 0 ? (
            <EmptyState
              compact
              title="No items are currently staged for publishing."
              description="Approve an item in the Review Queue, or Send to Publish from the Editor, and it appears here."
              action={
                <Button variant="outline" size="sm" asChild>
                  <Link to={ADMIN_ROUTES.QUEUE}>Open Review Queue</Link>
                </Button>
              }
            />
          ) : (
            <div className="space-y-2">
              {readyToPublish.map((item) => (
                <StagedRow
                  key={item.id}
                  item={item}
                  images={images}
                  workflow={workflow}
                  isItemLive={isItemLive}
                  imagesOpen={expandedImagesId === item.id}
                  onToggleImages={() => setExpandedImagesId(toggleId(item.id))}
                  onReview={() => navigate(`${getReviewPath(item.id)}?source=content`)}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Issue #374 backfill: the bulk re-host of hotlinked body images. */}
      <RehostImagesPanel />

      {published.length === 0 ? (
        <EmptyState
          title="No published content yet."
          description="Pages you publish from the list above appear here with their live URL."
        />
      ) : (
        <div className="space-y-2">
          {published.map((row) => {
            const blog = withSlugOverride(row);
            return (
              <PublishedRow
                key={blog.id}
                blog={blog}
                slugOpen={expandedSlugId === blog.id}
                onToggleSlug={() => setExpandedSlugId(toggleId(blog.id))}
                onSlugApplied={applySlugResult}
                transcript={transcript}
              />
            );
          })}
        </div>
      )}

      {/* Pre-publish validation checklist modal */}
      <PrePublishModal
        candidate={workflow.publishCandidate}
        failures={workflow.publishFailures}
        autoPostSocial={workflow.autoPostSocial}
        onAutoPostSocialChange={workflow.setAutoPostSocial}
        onClose={() => workflow.setPublishCandidate(null)}
        onPublishNow={workflow.handlePublishNow}
      />

      <ConfirmModal
        open={Boolean(unpublishTarget)}
        title="Unpublish this item?"
        description="The item will be returned to preview status and removed from the live site."
        confirmLabel="Unpublish"
        onConfirm={() => {
          const item = unpublishTarget;
          setUnpublishTarget(null);
          workflow.doUnpublish(item);
        }}
        onCancel={() => setUnpublishTarget(null)}
      />

      <ConfirmModal
        open={Boolean(transcript.transcriptTarget)}
        title="Generate a podcast transcript?"
        description="Generates a two-host script and audio from this article; lands as a draft."
        confirmLabel="Generate"
        destructive={false}
        onConfirm={() => {
          const item = transcript.transcriptTarget;
          transcript.setTranscriptTarget(null);
          transcript.queuePodcastTranscript(item);
        }}
        onCancel={() => transcript.setTranscriptTarget(null)}
      />
    </div>
  );
}
