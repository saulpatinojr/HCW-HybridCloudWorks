/**
 * The blog review board's local state, as one reducer (ADR 0033, PR #841).
 *
 * The board used to hold twenty-odd useState pairs and five effects that
 * each copied one field out of the record. They are one state object here,
 * three generic actions, and one effect that applies the patch the model
 * derives from a fresh record.
 */
import { useCallback, useEffect, useReducer } from 'react';
import { useImagePrompts } from '@/hooks/useImagePrompts';
import { deriveBlogSyncPatch } from './blogReviewModel';

export const INITIAL_REVIEW_STATE = Object.freeze({
  notes: '',
  transitionError: null,
  summaryExpanded: true,
  aiExpanded: false,
  originalExpanded: false,
  imagePrompt: '',
  expandedImage: '',
  coverTriggerPending: false,
  coverTriggerMessage: null,
  // Which Image Prompts set the cover would generate with when the override
  // is empty (ADR 0033): null until the lookup answers.
  coverPromptPlan: null,
  reviewImages: [],
  savingImages: false,
  instantPublish: true,
  scheduledDate: '',
  scheduledTime: '',
  savingSchedule: false,
  scheduleMessage: null,
  providerSaving: false,
  providerPickerOpen: false,
  newTopic: '',
  keyTopics: [],
  // The address topic (#1628): a topic word, or '' to let the server pick.
  topic: '',
});

const REDUCERS = Object.freeze({
  patch: (state, action) => ({ ...state, ...action.patch }),
  toggle: (state, action) => ({ ...state, [action.key]: !state[action.key] }),
  updateImages: (state, action) => ({ ...state, reviewImages: action.update(state.reviewImages) }),
});

export function blogReviewReducer(state, action) {
  const reduce = REDUCERS[action.type];
  return reduce ? reduce(state, action) : state;
}

/**
 * @param {object} blog the content record; re-synced into state whenever it changes
 * @returns {{ state: object, patch: (fields: object) => void, toggle: (key: string) => void, updateImages: (update: (images: object[]) => object[]) => void }}
 */
export function useBlogReviewState(blog) {
  const [state, dispatch] = useReducer(blogReviewReducer, INITIAL_REVIEW_STATE);
  const patch = useCallback((fields) => dispatch({ type: 'patch', patch: fields }), []);
  const toggle = useCallback((key) => dispatch({ type: 'toggle', key }), []);
  const updateImages = useCallback((update) => dispatch({ type: 'updateImages', update }), []);

  // Deferred a tick, as the per-field effects it replaces were, so a record
  // swap never sets state during the render that delivered it.
  useEffect(() => {
    const timer = setTimeout(() => patch(deriveBlogSyncPatch(blog)), 0);
    return () => clearTimeout(timer);
  }, [blog, patch]);

  return { state, patch, toggle, updateImages };
}

/**
 * Reads which Image Prompts set the cover would use, once per record and
 * again after each generated cover, into `coverPromptPlan`.
 */
export function useCoverPromptPlan({ blogId, generatedAt, patch }) {
  const { resolvePromptForContent } = useImagePrompts();
  useEffect(() => {
    if (!blogId) return undefined;
    let cancelled = false;
    resolvePromptForContent(blogId).then((plan) => {
      if (!cancelled) patch({ coverPromptPlan: plan });
    });
    return () => {
      cancelled = true;
    };
  }, [blogId, resolvePromptForContent, generatedAt, patch]);
}
