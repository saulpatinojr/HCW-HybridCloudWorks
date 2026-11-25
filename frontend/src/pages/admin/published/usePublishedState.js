/**
 * The Publish page's state, in parts: the snapshot it reads, the image-order
 * drafts on the staged rows, and the podcast transcript trigger on the live
 * rows. Each part was written inline in PublishedPage.jsx until the page grew
 * too long to follow.
 */
import { useEffect, useState } from 'react';
import { postJSON } from '@/lib/api';
import { logAdminAction } from '@/lib/auditLog';
import { getOrderedContentImages } from '@/lib/contentImages';

/** The publish snapshot (staged and live items), read once auth is ready. */
export function usePublishSnapshot(authReady) {
  const [snapshot, setSnapshot] = useState({ readyCandidates: [], publishedItems: [] });
  const [loading, setLoading] = useState(true);
  const [queryErrorMessage, setQueryErrorMessage] = useState('');
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
  return { snapshot, loading, queryErrorMessage };
}

/**
 * The image order a staged row is being given before it goes live: the
 * unsaved draft per row, the saved result shown on the row, and saving it.
 */
export function useImageDrafts() {
  const [imageDrafts, setImageDrafts] = useState({});
  const [imageOverrides, setImageOverrides] = useState({});
  const [savingImageId, setSavingImageId] = useState('');
  const [imageError, setImageError] = useState('');

  const withImageOverride = (item) =>
    imageOverrides[item.id] ? { ...item, ...imageOverrides[item.id] } : item;

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

  return {
    imageError,
    savingImageId,
    withImageOverride,
    getDraftImages,
    setDraftImages,
    removeDraftImage,
    attachDraftImage,
    persistImageOrder,
  };
}

/**
 * #435: the podcast transcript trigger. It lives on this page, at the end
 * of the ContentForge workflow, and only on the already-live list: an
 * article is final once it is published, so the reading can be too.
 */
export function usePodcastTranscript(toast) {
  const [transcriptTarget, setTranscriptTarget] = useState(null);
  const [queuingTranscriptId, setQueuingTranscriptId] = useState('');

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

  return { transcriptTarget, setTranscriptTarget, queuingTranscriptId, queuePodcastTranscript };
}
