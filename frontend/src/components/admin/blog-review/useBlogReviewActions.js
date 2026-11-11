/**
 * The blog review board's actions (ADR 0033, PR #841): the status moves
 * through the shared useContentTransitions hook, the schedule, the provider
 * pick, the key topics, the review images and the AI cover trigger.
 *
 * The status moves (approve, reject, recall) go through the shared
 * useContentTransitions hook (ADR 0033 §2); the server writes the audit
 * row, so none is written here (ADR 0033 §1). `onChanged` lets the page
 * refetch the record after one lands.
 */
import { useCallback } from 'react';
import { postJSON } from '@/lib/api';
import { logAdminAction } from '@/lib/auditLog';
import { getPublishTargetForItem } from '@/lib/contentModel';
import {
  requestContentInspection,
  saveContentSchedule,
  resetContentReviewState,
} from '@/lib/contentWorkflow';
import { useContentTransitions } from '@/pages/admin/queue/useContentTransitions';
import { appendGalleryImage, buildScheduleRequest, describeCoverQueued } from './blogReviewModel';

/**
 * Wraps an async handler so a failure lands on `transitionError` instead of
 * escaping, with optional patches applied before the work, on failure, and
 * after it either way.
 */
export function useGuardedAction(patch) {
  return useCallback(
    (work, { before, onError, after } = {}) =>
      async (...args) => {
        if (before) patch(before);
        try {
          return await work(...args);
        } catch (err) {
          patch({ ...onError, transitionError: err.message });
          return null;
        } finally {
          if (after) patch(after);
        }
      },
    [patch]
  );
}

export function useBlogReviewActions({ blog, blogId, status, state, patch, onChanged }) {
  const transitions = useContentTransitions({ onTransitioned: () => onChanged?.() });
  const guarded = useGuardedAction(patch);
  // The verb in flight for this record ('approving' | 'rejecting' | 'recalling'), or null.
  const transitioning = transitions.loading[blogId] || null;
  const transitionError = state.transitionError || transitions.errors[blogId] || null;

  const transitionOptions = () => ({
    reviewNotes: state.notes,
    publishTarget: getPublishTargetForItem(blog),
  });

  const handleTransition = (newStatus) => {
    patch({ transitionError: null });
    return newStatus === 'rejected'
      ? transitions.reject(blogId, transitionOptions())
      : transitions.approve(blog, transitionOptions());
  };

  const handleRecall = () => {
    patch({ transitionError: null });
    return transitions.recall(blogId, {
      currentStatus: status,
      reviewNotes: state.notes || 'Returned to review queue from review board',
    });
  };

  const handleTriggerInspect = guarded(() => requestContentInspection(blogId));
  const handleResetStatus = guarded(() => resetContentReviewState(blogId));

  const handleSelectProvider = guarded(
    async (providerValue) => {
      await postJSON('updateContentItem', {
        contentId: blogId,
        updates: { cloudProvider: providerValue, 'Cloud Provider': providerValue },
      });
      patch({ providerPickerOpen: false });
    },
    { before: { providerSaving: true }, after: { providerSaving: false } }
  );

  const handleTriggerCover = guarded(
    async () => {
      // An empty seed clears a previous override, so the assigned set applies
      // again; a non-empty one is used verbatim.
      const promptOverride = state.imagePrompt.trim();
      await postJSON('triggerAiImageGeneration', {
        contentIds: [blogId],
        aiImageTargets: ['hero'],
        imagePromptSeed: promptOverride,
      });
      patch({ coverTriggerMessage: describeCoverQueued(promptOverride, state.coverPromptPlan) });
    },
    {
      before: { transitionError: null, coverTriggerMessage: null, coverTriggerPending: true },
      onError: { coverTriggerPending: false },
    }
  );

  return {
    guarded,
    transitioning,
    transitionError,
    handleTransition,
    handleRecall,
    handleTriggerInspect,
    handleResetStatus,
    handleSelectProvider,
    handleTriggerCover,
  };
}

export function useScheduleActions({ blog, blogId, state, patch }) {
  const handleSaveSchedule = async () => {
    const request = buildScheduleRequest({
      blog,
      blogId,
      instantPublish: state.instantPublish,
      scheduledDate: state.scheduledDate,
      scheduledTime: state.scheduledTime,
    });
    if (request.error) {
      patch({ scheduleMessage: { type: 'error', text: request.error } });
      return;
    }
    patch({ scheduleMessage: null, savingSchedule: true });
    try {
      await saveContentSchedule(request.payload);
      await logAdminAction('schedule_saved', request.audit);
      patch({ scheduleMessage: { type: 'success', text: 'Schedule saved successfully.' } });
      setTimeout(() => patch({ scheduleMessage: null }), 4000);
    } catch (err) {
      console.error('Failed to save schedule:', err);
      patch({
        scheduleMessage: { type: 'error', text: `Failed to save schedule: ${err.message}` },
      });
    } finally {
      patch({ savingSchedule: false });
    }
  };

  return { handleSaveSchedule };
}

export function useTopicActions({ blogId, state, patch, guarded }) {
  const persistTopics = guarded(async (nextTopics) => {
    patch({ keyTopics: nextTopics });
    await postJSON('updateContentItem', { contentId: blogId, updates: { keyTopics: nextTopics } });
  });

  const handleRemoveTopic = (topicToRemove) =>
    persistTopics(state.keyTopics.filter((topic) => topic !== topicToRemove));

  const handleAddTopic = (event) => {
    if (event.key !== 'Enter') return undefined;
    event.preventDefault();
    const topic = state.newTopic.trim();
    patch({ newTopic: '' });
    if (!topic || state.keyTopics.includes(topic)) return undefined;
    return persistTopics([...state.keyTopics, topic]);
  };

  // The address topic (#1628). "Pick automatically" ('') is stored as null,
  // which tells the server to choose one at publish.
  const handleSelectAddressTopic = guarded(async (value) => {
    patch({ topic: value });
    await postJSON('updateContentItem', { contentId: blogId, updates: { topic: value || null } });
  });

  return { handleRemoveTopic, handleAddTopic, handleSelectAddressTopic };
}

export function useReviewImageActions({ blogId, state, patch, updateImages, guarded }) {
  const handleReviewImageReorder = (nextImages) => patch({ reviewImages: nextImages });

  const handleRemoveReviewImage = (index) =>
    updateImages((images) => images.filter((_, currentIndex) => currentIndex !== index));

  const handleAttachReviewImage = (item) =>
    updateImages((images) => appendGalleryImage(images, item, blogId));

  const handleSaveReviewImages = guarded(
    async () => {
      await postJSON('saveContentImageOrder', {
        contentId: blogId,
        imageUrls: state.reviewImages.map((image) => image.url),
      });
      await logAdminAction('review_images_saved', {
        contentId: blogId,
        imageCount: state.reviewImages.length,
      });
    },
    { before: { savingImages: true }, after: { savingImages: false } }
  );

  return {
    handleReviewImageReorder,
    handleRemoveReviewImage,
    handleAttachReviewImage,
    handleSaveReviewImages,
  };
}
