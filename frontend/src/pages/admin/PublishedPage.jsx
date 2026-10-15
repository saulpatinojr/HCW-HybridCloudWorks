import React, { useEffect, useState } from 'react';
import ConfirmModal from '@/components/admin/ConfirmModal';
import { Link, useNavigate } from 'react-router';
import { useAuthReady } from '@/hooks/useAuthReady';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { getCoverImageUrl, formatPostDate } from '@/lib/blogUtils';
import { byNewest } from '@/lib/dateUtils';
import { PenSquare, Loader2, Calendar, Images, Headphones, Rocket } from 'lucide-react';
import EmptyState from '@/components/admin/shared/EmptyState';
import PageHeader from '@/components/admin/shared/PageHeader';
import StatusBadge from '@/components/admin/shared/StatusBadge';
import TaxonomyChips from '@/components/admin/shared/TaxonomyChips';
import { getLiveUrl } from '@/lib/livePages';
import { contentStatusInfo } from '@/lib/status';
import { postJSON, getJSON } from '@/lib/api';
import { useToast } from '@/components/ui/use-toast';
import { logAdminAction } from '@/lib/auditLog';
import { unpublishToInspected } from '@/lib/contentWorkflow';
import { ADMIN_ROUTES } from '@/config/admin';
import { getCanonicalContentType, getPublishTargetForItem } from '@/lib/contentModel';
import { ImageOrderManager } from '@/components/admin/ImageOrderManager';
import { ImageGalleryPicker } from '@/components/admin/ImageGalleryPicker';
import { getOrderedContentImages } from '@/lib/contentImages';
import PipelineStepper from '@/components/admin/PipelineStepper';
import RoleGate from '@/components/admin/RoleGate';
import RehostImagesPanel from './RehostImagesPanel';
import SetSlugPanel, { SetSlugButton } from './SetSlugPanel';

// ── Pre-publish validation ────────────────────────────────────────────────────
// Client-side checklist run before publishContent is invoked. `item` is
// the snapshot row merged with the full content record (for body length).

const MIN_BODY_CHARS = 200;

export function getPrePublishFailures(item) {
  const failures = [];
  if (!getCoverImageUrl(item)) {
    failures.push('Hero image is missing — add one via the Images panel.');
  }
  if (!String(item.Title || item.title || '').trim()) {
    failures.push('Title is empty.');
  }
  if (!String(item.Summary || item.summary || '').trim()) {
    failures.push('Summary is empty.');
  }
  const body = String(item.blogDraft || item.Body || item.body || item.Content || '');
  if (body.trim().length <= MIN_BODY_CHARS) {
    failures.push(`Body is too short (needs more than ${MIN_BODY_CHARS} characters).`);
  }
  const slug =
    String(item.slug || item.Slug || '').trim() || String(item.curatedSubpagePath || '').trim();
  if (!slug) {
    failures.push('Slug is missing.');
  }
  return failures;
}

/**
 * The row fields a set-slug response justifies changing — ONLY the ones it
 * actually carried (#400).
 *
 * This used to spread every field with `|| ''`, so a response that omitted the
 * URLs wrote empty strings over the ones the row already had: the row lost its
 * `curatedSubpagePath`, `getPublicUrl` fell through to the client-derived
 * `getContentPublicPath`, and "View Live" either vanished or pointed at a URL
 * built by rules the server does not use. That is the same mistake as the
 * server-side bug this PR fixes — reacting to an ABSENT value as though it
 * were a NEW value — so it is fixed the same way: an absent field means "no
 * information", and the row keeps what it had.
 *
 * It matters most across a deploy: a Functions app that predates the
 * no-path refusal can still answer `changed: true` with no URL fields at all,
 * and that is precisely the response that must not blank a live row.
 *
 * A refusal never reaches here — the panel only calls this on a `changed`
 * response, and a refusal throws — but an empty override is returned rather
 * than assumed, so nothing repaints if it ever does.
 */
export function slugRowOverride(result = {}) {
  const override = {};
  const slug = typeof result.slug === 'string' ? result.slug.trim() : '';
  if (slug) {
    override.slug = slug;
    override.Slug = slug;
  }
  const path =
    typeof result.curatedSubpagePath === 'string' ? result.curatedSubpagePath.trim() : '';
  if (path) override.curatedSubpagePath = path;

  const url = typeof result.publicUrl === 'string' ? result.publicUrl.trim() : '';
  if (url) {
    override.slugPageUrl = url;
    override.publishedUrl = url;
    override.publicUrl = url;
  }
  return override;
}

function getReviewPath(contentId) {
  return ADMIN_ROUTES.REVIEW.replace(':id', contentId);
}

function getItemProvider(item) {
  return item['Cloud Provider'] || item.cloudProvider || 'Unknown';
}

function getItemTypeLabel(item) {
  const type = getCanonicalContentType(item);
  switch (type) {
    case 'framework':
      return 'Framework';
    case 'architecture':
      return 'Architecture';
    case 'coder_corner':
      return 'Coder Corner';
    case 'news':
      return 'News / RSS';
    case 'blog':
    default:
      return 'Blog';
  }
}

/** The one live-URL rule every surface shares (lib/livePages.js, ADR 0033 §2). */
const getPublicUrl = getLiveUrl;

const PUBLISH_HELP = [
  'What arrives here: items approved in the Review Queue or sent from the Editor (Approved, Forge ready, or Published but not yet live).',
  'What to do: open Images to set the hero and order, check the slug, then Publish. The pre-publish checklist names anything missing before it goes out.',
  'Publishing writes the public page and sets Live; Unpublish takes a page back to Inspected. Schedule from the Calendar when it should go out later.',
  'Where it goes next: a live page appears on Live Pages with its URL, can be read aloud as a podcast transcript, and is picked up by the newsletter and social tools.',
];

// Both of these were timestamp-object-only (`?.toMillis?.() || 0`), so against the ISO
// strings Cosmos returns they scored every document 0 and the comparators were
// permanent no-ops (T-304).
const sortByUpdatedAtDesc = byNewest('updatedAt');
const sortByPublishedAtDesc = byNewest('blogPublishedAt');

function findPublishMapping(result, contentId) {
  if (!Array.isArray(result?.mappings)) return null;
  return result.mappings.find((entry) => entry.contentId === contentId) || null;
}

function getPublishWarnings(result, contentId) {
  if (!Array.isArray(result?.warnings)) return [];
  return result.warnings.filter((warning) => warning.contentId === contentId);
}

function buildPublishDebug(item, result, mapping) {
  return {
    contentId: item.id,
    blogId: mapping?.blogId || null,
    reused: Boolean(mapping?.reused),
    landingProvider: mapping?.landingProvider || null,
    slug: mapping?.slug || null,
    curatedSubpagePath: mapping?.curatedSubpagePath || null,
    expectedPublicUrl: mapping?.expectedPublicUrl || null,
    sourceUrl: mapping?.sourceUrl || null,
    warnings: getPublishWarnings(result, item.id),
  };
}

function getPublishErrorMessage(mapping) {
  if (!mapping) {
    return 'Publish completed without mapping diagnostics. Check Azure Function logs.';
  }

  if (!mapping.expectedPublicUrl) {
    return 'Publish completed but published URL is missing. Check landingProvider/slug mapping in publish response.';
  }

  if (mapping.sourceUrl && mapping.expectedPublicUrl === mapping.sourceUrl) {
    return 'Publish completed but published URL matches source URL. This indicates a mapping issue.';
  }

  return '';
}

function getPublishButtonContent(isSubmitting, isLive) {
  if (isSubmitting) {
    return <Loader2 className="h-4 w-4 animate-spin" />;
  }

  return isLive ? 'Published' : 'Publish';
}

/**
 * Publish-workflow state + handlers (validation modal, publish, unpublish),
 * extracted from the component to keep PublishedPage itself readable.
 */
function usePublishWorkflow({ navigate, withImageOverride, setLocalLiveOverrides }) {
  const [publishingId, setPublishingId] = useState('');
  const [publishError, setPublishError] = useState('');
  const [publishDebug, setPublishDebug] = useState(null);
  const [unpublishTarget, setUnpublishTarget] = useState(null);
  // Pre-publish validation modal state
  const [publishCandidate, setPublishCandidate] = useState(null); // merged item awaiting confirm
  const [publishFailures, setPublishFailures] = useState([]);
  const [validatingId, setValidatingId] = useState('');
  const [autoPostSocial, setAutoPostSocial] = useState(false);

  // Step 1 — validate before publishing. Merges the snapshot row with the full
  // content record (the snapshot omits body text) and opens the checklist modal.
  const handlePublishRequest = async (item) => {
    setPublishError('');
    setValidatingId(item.id);
    try {
      let merged = withImageOverride(item);
      try {
        const res = await getJSON(`cms/content/item?contentId=${encodeURIComponent(item.id)}`);
        if (res.item) merged = { ...res.item, ...merged };
      } catch {
        // Snapshot data only — body check may report a false negative, which
        // the admin can override from the modal.
      }
      setPublishFailures(getPrePublishFailures(merged));
      setPublishCandidate(item);
    } finally {
      setValidatingId('');
    }
  };

  const handlePublishNow = async (item) => {
    const selectedProvider = item['Cloud Provider'] || item.cloudProvider || '';
    setPublishError('');
    setPublishDebug(null);
    setPublishingId(item.id);
    try {
      const publishTarget = getPublishTargetForItem(item);
      const result = await postJSON('publishContent', {
        contentIds: [item.id],
        publishTarget,
        cloudProvider: selectedProvider,
        markLive: true,
        createSlugPageTrigger: true,
        addToCurated: true,
      });

      const mapping = findPublishMapping(result, item.id);
      const nextDebug = buildPublishDebug(item, result, mapping);
      const nextError = getPublishErrorMessage(mapping);

      setPublishDebug(nextDebug);
      if (nextError) {
        setPublishError(nextError);
      }

      await logAdminAction('content_published_live', {
        contentId: item.id,
        title: item.Title || item.title,
        publishTarget,
        publishMapping: mapping || null,
      });
      setLocalLiveOverrides((prev) => ({ ...prev, [item.id]: true }));
      if (autoPostSocial) {
        // Deep-link to Social Hub compose with this content preselected.
        navigate(`/admin/social?tab=compose&contentId=${encodeURIComponent(item.id)}`);
      }
    } catch (err) {
      setPublishError(`Publish failed: ${err.message}`);
    } finally {
      setPublishingId('');
    }
  };

  const handleUnpublish = (item) => {
    setUnpublishTarget(item);
  };

  const doUnpublish = async (item) => {
    setPublishError('');
    setPublishingId(item.id);
    try {
      await unpublishToInspected(
        item.id,
        item.contentStatus || '',
        'Unpublished from Publish pane and returned to preview'
      );
      setLocalLiveOverrides((prev) => ({ ...prev, [item.id]: false }));
    } catch (err) {
      setPublishError(`Unpublish failed: ${err.message}`);
    } finally {
      setPublishingId('');
    }
  };

  return {
    publishingId,
    publishError,
    publishDebug,
    unpublishTarget,
    setUnpublishTarget,
    publishCandidate,
    setPublishCandidate,
    publishFailures,
    validatingId,
    autoPostSocial,
    setAutoPostSocial,
    handlePublishRequest,
    handlePublishNow,
    handleUnpublish,
    doUnpublish,
  };
}

/**
 * The amber panel summarising the last publish attempt.
 *
 * Lifted out of PublishedPage unchanged: it is six `|| 'n/a'` fallbacks and a
 * guarded warnings line, which together were about a third of that component’s
 * branch count while being entirely presentational.
 */
function PublishDiagnostics({ publishDebug }) {
  if (!publishDebug) return null;

  return (
    <div className="mt-2 rounded-md border border-amber-500/40 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
      <p className="font-medium">Latest Publish Diagnostics</p>
      <p>Content: {publishDebug.contentId}</p>
      <p>Blog: {publishDebug.blogId || 'n/a'}</p>
      <p>Provider: {publishDebug.landingProvider || 'n/a'}</p>
      <p>Slug: {publishDebug.slug || 'n/a'}</p>
      <p>Path: {publishDebug.curatedSubpagePath || 'n/a'}</p>
      <p>Expected URL: {publishDebug.expectedPublicUrl || 'n/a'}</p>
      <p>Source URL: {publishDebug.sourceUrl || 'n/a'}</p>
      {publishDebug.warnings?.length > 0 && (
        <p>Warnings: {publishDebug.warnings.map((w) => w.warning).join(' | ')}</p>
      )}
    </div>
  );
}

/**
 * Pre-publish checklist modal.
 *
 * Every branch in here keys off whether the checklist passed, so the whole
 * subtree moves together. Rendering nothing without a candidate keeps the
 * mount/unmount behaviour identical to the `{publishCandidate && ...}` guard it
 * replaces.
 */
function PrePublishModal({
  candidate,
  failures,
  autoPostSocial,
  onAutoPostSocialChange,
  onClose,
  onPublishNow,
}) {
  if (!candidate) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm">
      <div className="absolute inset-0" onClick={() => onClose()} aria-hidden="true" />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="prepublish-modal-title"
        className="relative w-full max-w-md rounded-2xl border bg-background shadow-2xl p-6 space-y-4"
      >
        <h2 id="prepublish-modal-title" className="text-lg font-semibold">
          {failures.length === 0 ? 'Ready to publish' : 'Publish blocked'}
        </h2>
        <p className="text-sm text-muted-foreground truncate">
          {candidate.Title || candidate.title || 'Untitled'}
        </p>

        {failures.length === 0 ? (
          <p className="text-sm text-emerald-600 dark:text-emerald-400">
            All pre-publish checks passed: hero image, title, summary, body length, and slug.
          </p>
        ) : (
          <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3">
            <p className="text-sm font-medium text-destructive mb-2">
              Fix these before publishing:
            </p>
            <ul className="list-disc pl-5 space-y-1 text-sm text-destructive">
              {failures.map((failure) => (
                <li key={failure}>{failure}</li>
              ))}
            </ul>
          </div>
        )}

        {failures.length === 0 && (
          <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
            <input
              type="checkbox"
              checked={autoPostSocial}
              onChange={(e) => onAutoPostSocialChange(e.target.checked)}
              className="h-4 w-4 rounded border-border accent-primary"
            />
            Auto-post to Social — open Social Hub compose after publish
          </label>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" size="sm" onClick={() => onClose()}>
            {failures.length === 0 ? 'Cancel' : 'Close'}
          </Button>
          {failures.length > 0 && (
            <Button size="sm" variant="outline" asChild>
              <Link to={ADMIN_ROUTES.EDITOR.replace(':id', candidate.id)}>Open Editor</Link>
            </Button>
          )}
          {failures.length === 0 && (
            <Button
              size="sm"
              onClick={() => {
                const item = candidate;
                onClose();
                onPublishNow(item);
              }}
            >
              Publish Now
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

/** The Publish stage: what is ready to go live and what already is, read as one snapshot. */
export default function PublishedPage() {
  const navigate = useNavigate();
  const { authReady } = useAuthReady();
  const [snapshot, setSnapshot] = useState({ readyCandidates: [], publishedItems: [] });
  const [loading, setLoading] = useState(true);
  const [queryErrorMessage, setQueryErrorMessage] = useState('');
  const [localLiveOverrides, setLocalLiveOverrides] = useState({});
  const [imageDrafts, setImageDrafts] = useState({});
  const [imageOverrides, setImageOverrides] = useState({});
  const [expandedImagesId, setExpandedImagesId] = useState('');
  const [savingImageId, setSavingImageId] = useState('');
  const [imageError, setImageError] = useState('');
  // #400: which published row has its slug control open, and the fields a
  // successful set-slug returned, so the row's "View Live" link points at the
  // new URL without waiting for a snapshot refetch.
  const [expandedSlugId, setExpandedSlugId] = useState('');
  const [slugOverrides, setSlugOverrides] = useState({});
  // #435: the podcast transcript trigger. It lives on this page, at the end
  // of the ContentForge workflow, and only on the already-live list: an
  // article is final once it is published, so the reading can be too.
  const [transcriptTarget, setTranscriptTarget] = useState(null);
  const [queuingTranscriptId, setQueuingTranscriptId] = useState('');
  const { toast } = useToast();

  useEffect(() => {
    if (!authReady) return;
    let cancelled = false;

    async function loadSnapshot() {
      setLoading(true);
      setQueryErrorMessage('');
      try {
        const result = await postJSON('getPublishSnapshot', {});
        if (!cancelled) setSnapshot(result);
      } catch (error) {
        if (!cancelled) {
          setQueryErrorMessage(error.message || 'Failed to load publish snapshot.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadSnapshot();
    return () => {
      cancelled = true;
    };
  }, [authReady]);

  const isItemLive = (item) => {
    if (typeof localLiveOverrides[item.id] === 'boolean') return localLiveOverrides[item.id];
    return item.Live === true;
  };

  const readyToPublish = (snapshot.readyCandidates || [])
    .filter((item) => {
      if (isItemLive(item)) return false;
      // The publishable statuses by their canonical names (content-status.js
      // PUBLISHABLE_NORMALIZED_STATUSES); the legacy spellings resolve to them.
      return ['approved', 'forge_ready', 'published'].includes(contentStatusInfo(item).id);
    })
    .sort(sortByUpdatedAtDesc);

  const published = (snapshot.publishedItems || [])
    .filter((item) => isItemLive(item))
    .sort(sortByPublishedAtDesc);
  const withImageOverride = (item) =>
    imageOverrides[item.id] ? { ...item, ...imageOverrides[item.id] } : item;

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

  /**
   * Enqueue the generate-podcast-transcript job for one live article. The
   * API answers 202 with a job id; the transcript itself lands minutes later
   * as a draft in podcast_transcripts, which the Recording Hub (#442) lists.
   * A refusal — not published, or the container not provisioned yet — is
   * shown verbatim, because the API's sentence names the fix.
   */
  const queuePodcastTranscript = async (item) => {
    setQueuingTranscriptId(item.id);
    let result;
    try {
      result = await postJSON('cms/podcast/transcripts/generate', { articleId: item.id });
    } catch (err) {
      toast({
        title: 'Podcast transcript not queued',
        description: err.message,
        variant: 'destructive',
      });
      setQueuingTranscriptId('');
      return;
    }
    // The job is queued whatever happens next, so say so now. The audit row
    // is in its own try: logAdminAction swallows its own POST failure, but a
    // throw from the identity lookup before it must not turn a queued job
    // into a "not queued" toast — the same posture the helper takes, warn
    // and carry on.
    toast({
      title: 'Podcast transcript queued',
      description: 'Listed under Recording Hub → Podcast when generated.',
    });
    try {
      await logAdminAction('podcast_transcript_queued', {
        contentId: item.id,
        title: item.Title || item.title,
        jobId: result?.jobId || null,
        transcriptId: result?.transcriptId || null,
      });
    } catch (err) {
      console.warn('Audit log failed for podcast_transcript_queued:', err);
    } finally {
      setQueuingTranscriptId('');
    }
  };

  const {
    publishingId,
    publishError,
    publishDebug,
    unpublishTarget,
    setUnpublishTarget,
    publishCandidate,
    setPublishCandidate,
    publishFailures,
    validatingId,
    autoPostSocial,
    setAutoPostSocial,
    handlePublishRequest,
    handlePublishNow,
    handleUnpublish,
    doUnpublish,
  } = usePublishWorkflow({ navigate, withImageOverride, setLocalLiveOverrides });

  const getDraftImages = (item) => imageDrafts[item.id] || getOrderedContentImages(item);

  const setDraftImages = (itemId, nextImages) => {
    setImageDrafts((prev) => ({ ...prev, [itemId]: nextImages }));
  };

  const removeDraftImage = (itemId, index, item) => {
    const currentImages = getDraftImages(item);
    setDraftImages(
      itemId,
      currentImages.filter((_, currentIndex) => currentIndex !== index)
    );
  };

  const attachDraftImage = (itemId, item, imageUrl) => {
    const normalizedUrl = String(imageUrl || '').trim();
    if (!normalizedUrl) return;
    const currentImages = getDraftImages(item);
    if (currentImages.some((entry) => entry.url === normalizedUrl)) return;
    setDraftImages(
      itemId,
      [
        ...currentImages,
        {
          id: `${itemId}-${Date.now()}-${normalizedUrl}`,
          url: normalizedUrl,
          label: `Secondary ${currentImages.length}`,
          sourceLabel: 'Gallery',
        },
      ].slice(0, 4)
    );
  };

  const persistImageOrder = async (item) => {
    const nextImages = getDraftImages(item);
    setImageError('');
    setSavingImageId(item.id);
    try {
      const imageUrls = nextImages.map((image) => image.url);
      await postJSON('saveContentImageOrder', {
        contentId: item.id,
        imageUrls,
      });
      await logAdminAction('content_images_reordered', {
        contentId: item.id,
        imageCount: nextImages.length,
      });
      setImageDrafts((prev) => ({ ...prev, [item.id]: nextImages }));
      setImageOverrides((prev) => ({
        ...prev,
        [item.id]: {
          heroImageUrl: imageUrls[0] || '',
          contentImageUrl: imageUrls[0] || '',
          altCoverImage: imageUrls[0] || '',
          secondaryImageUrls: imageUrls.slice(1, 4),
        },
      }));
    } catch (err) {
      setImageError(`Image order save failed: ${err.message}`);
    } finally {
      setSavingImageId('');
    }
  };

  if (loading) {
    return <Spinner label="Loading published articles" className="min-h-[40vh]" />;
  }

  return (
    <div className="space-y-4">
      <PageHeader
        icon={Rocket}
        title="Publish"
        help={PUBLISH_HELP}
        status={
          <span className="text-muted-foreground">
            {snapshot.readyTotal || readyToPublish.length} staged for go-live from Review or Editor
            · {snapshot.publishedTotal || published.length} already live
          </span>
        }
      >
        {queryErrorMessage && <p className="text-sm text-destructive">{queryErrorMessage}</p>}
        {publishError && <p className="text-sm text-destructive">{publishError}</p>}
        {imageError && <p className="text-sm text-destructive">{imageError}</p>}
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
              {readyToPublish.map((item) => {
                const displayItem = withImageOverride(item);
                const coverUrl = getCoverImageUrl(displayItem);
                const isLive = isItemLive(displayItem);
                const publicUrl = getPublicUrl(displayItem);
                return (
                  <div key={item.id} className="rounded-lg border p-3 space-y-3 hover:bg-muted/40">
                    <div className="flex items-center gap-4">
                      {coverUrl ? (
                        <img
                          src={coverUrl}
                          alt=""
                          className="h-14 w-20 object-cover rounded-md shrink-0"
                          loading="lazy"
                        />
                      ) : (
                        <div className="h-14 w-20 rounded-md bg-muted shrink-0" />
                      )}

                      <div className="flex-1 min-w-0">
                        <p className="font-medium truncate">
                          {displayItem.Title || displayItem.title}
                        </p>
                        <div className="flex flex-wrap items-center gap-2 mt-1">
                          <StatusBadge content={displayItem} />
                          <Badge variant="outline" className="text-xs">
                            {getItemProvider(displayItem)}
                          </Badge>
                          <Badge variant="secondary" className="text-xs">
                            {getItemTypeLabel(displayItem)}
                          </Badge>
                          <TaxonomyChips item={displayItem} />
                        </div>
                        <PipelineStepper item={displayItem} className="mt-2" />
                      </div>

                      <div className="flex gap-2 shrink-0">
                        {publicUrl && (
                          <Button size="sm" variant="outline" asChild>
                            <a href={publicUrl} target="_blank" rel="noreferrer">
                              View Live
                            </a>
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => navigate(`${getReviewPath(item.id)}?source=content`)}
                        >
                          Review
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            setExpandedImagesId((current) => (current === item.id ? '' : item.id))
                          }
                        >
                          <Images className="h-4 w-4 mr-2" />
                          Images
                        </Button>
                        {/* publishContent and unpublishContentToInspected are
                            publisher routes (lib/cms/publish.js,
                            lib/content-workflow.js); below that role the
                            button says so instead of answering with a 403. */}
                        <RoleGate
                          minRole="publisher"
                          reason="Publishing and unpublishing need the publisher role."
                        >
                          <Button
                            size="sm"
                            variant={isLive ? 'outline' : 'default'}
                            onClick={() =>
                              isLive ? handleUnpublish(item) : handlePublishRequest(item)
                            }
                            disabled={publishingId === item.id || validatingId === item.id}
                          >
                            {getPublishButtonContent(
                              publishingId === item.id || validatingId === item.id,
                              isLive
                            )}
                          </Button>
                        </RoleGate>
                      </div>
                    </div>

                    {expandedImagesId === item.id && (
                      <div className="border-t pt-3">
                        <ImageOrderManager
                          images={getDraftImages(displayItem)}
                          onChange={(nextImages) => setDraftImages(item.id, nextImages)}
                          onRemove={(index) => removeDraftImage(item.id, index, displayItem)}
                          description="Drag to set the final publish order. The first image becomes the hero image."
                          emptyMessage="No images are attached to this item yet."
                        />
                        <div className="mt-3">
                          <ImageGalleryPicker
                            provider={getItemProvider(displayItem)}
                            title="Add From Image Gallery"
                            onSelect={(galleryItem) =>
                              attachDraftImage(item.id, displayItem, galleryItem.imageUrl)
                            }
                          />
                        </div>
                        <div className="mt-3 flex flex-wrap gap-2">
                          <Button
                            size="sm"
                            onClick={() => persistImageOrder(displayItem)}
                            disabled={savingImageId === item.id}
                          >
                            {savingImageId === item.id && (
                              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                            )}
                            Apply Image Order
                          </Button>
                          <Button size="sm" variant="outline" asChild>
                            <Link to={ADMIN_ROUTES.EDITOR.replace(':id', item.id)}>
                              Open Editor
                            </Link>
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
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
            const coverUrl = getCoverImageUrl(blog);
            const publicUrl = getPublicUrl(blog);

            return (
              <div key={blog.id} className="rounded-lg border hover:bg-muted/50 transition-colors">
                <div className="flex items-center gap-4 p-4">
                  {coverUrl ? (
                    <img
                      src={coverUrl}
                      alt=""
                      className="h-14 w-20 object-cover rounded-md shrink-0"
                      loading="lazy"
                    />
                  ) : (
                    <div className="h-14 w-20 rounded-md bg-muted shrink-0" />
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="font-medium truncate">{blog.Title || blog.title}</p>
                    <div className="flex flex-wrap items-center gap-2 mt-1">
                      <StatusBadge content={blog} />
                      <Badge variant="outline" className="text-xs">
                        {getItemProvider(blog)}
                      </Badge>
                      <TaxonomyChips item={blog} />
                      <span className="text-xs text-muted-foreground">
                        {formatPostDate(blog.blogPublishedAt)}
                      </span>
                    </div>
                    <PipelineStepper item={blog} className="mt-2" />
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {publicUrl && (
                      <Button size="sm" variant="outline" asChild>
                        <a href={publicUrl} target="_blank" rel="noreferrer">
                          View Live
                        </a>
                      </Button>
                    )}
                    {/* #400: the URL control, beside the link it changes. */}
                    <SetSlugButton
                      open={expandedSlugId === blog.id}
                      onToggle={() =>
                        setExpandedSlugId((current) => (current === blog.id ? '' : blog.id))
                      }
                    />
                    {/* #435: read this article aloud for the podcast. Live rows only. */}
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setTranscriptTarget(blog)}
                      disabled={queuingTranscriptId === blog.id}
                    >
                      {queuingTranscriptId === blog.id ? (
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      ) : (
                        <Headphones className="h-4 w-4 mr-2" />
                      )}
                      Podcast transcript
                    </Button>
                    <Button size="sm" variant="outline" asChild>
                      <Link to={`${getReviewPath(blog.id)}?source=content`}>
                        <PenSquare className="h-4 w-4 mr-2" />
                        Review
                      </Link>
                    </Button>
                  </div>
                </div>

                {expandedSlugId === blog.id && (
                  <div className="px-4 pb-4">
                    <SetSlugPanel item={blog} onApplied={applySlugResult} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Pre-publish validation checklist modal */}
      <PrePublishModal
        candidate={publishCandidate}
        failures={publishFailures}
        autoPostSocial={autoPostSocial}
        onAutoPostSocialChange={setAutoPostSocial}
        onClose={() => setPublishCandidate(null)}
        onPublishNow={handlePublishNow}
      />

      <ConfirmModal
        open={Boolean(unpublishTarget)}
        title="Unpublish this item?"
        description="The item will be returned to preview status and removed from the live site."
        confirmLabel="Unpublish"
        onConfirm={() => {
          const item = unpublishTarget;
          setUnpublishTarget(null);
          doUnpublish(item);
        }}
        onCancel={() => setUnpublishTarget(null)}
      />

      <ConfirmModal
        open={Boolean(transcriptTarget)}
        title="Generate a podcast transcript?"
        description="Generates a two-host script and audio from this article; lands as a draft."
        confirmLabel="Generate"
        destructive={false}
        onConfirm={() => {
          const item = transcriptTarget;
          setTranscriptTarget(null);
          queuePodcastTranscript(item);
        }}
        onCancel={() => setTranscriptTarget(null)}
      />
    </div>
  );
}
