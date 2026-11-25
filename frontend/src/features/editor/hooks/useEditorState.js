import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { usePublicData } from '@/hooks/usePublicData';
import { getCoverImageUrl } from '@/lib/blogUtils';
import { getJSON } from '@/lib/api';
import { useSections, joinSectionsToDraft } from './useSections';
import { useModules } from './useModules';
import { applyBoardReorder, buildBoardItems } from '../components/boardModel';
import { getOrderedContentImageUrls } from '@/lib/contentImages';
import {
  INITIAL_FIELDS,
  buildImageCandidates,
  fieldsFromDoc,
  getBaselineDraftFromDoc,
  getDestinationUrl,
  getEditedAtMs,
  isLiveDoc,
  isSaveShortcut,
  requestAiDraft,
  saveFailure,
  toOrderedImages,
} from './editorDocModel';
import { republishLive, saveDraft, transitionToQueue } from './editorPublish';
import { watchRemoteDoc } from './remoteDocWatch';

// Kept here as well: other code imports it from this file.
export { getDestinationUrl };

// ── Small helpers (module-private) ───────────────────────────────────────────

// The draft after moving board item `fromIndex` to `toIndex`, or null when
// either index is out of range or they are the same.
function reorderedBoardDraft(sectionAPI, moduleAPI, fromIndex, toIndex) {
  const { sections, sectionModuleOffsets } = sectionAPI;
  const { moduleItems } = moduleAPI;
  if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0) return null;

  const boardItems = buildBoardItems(sections, moduleItems, sectionModuleOffsets);
  if (fromIndex >= boardItems.length || toIndex >= boardItems.length) return null;

  const next = [...boardItems];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved);

  const newSections = applyBoardReorder(next, sections, moduleItems);
  return joinSectionsToDraft(newSections);
}

// Puts a document's fields, baseline and chosen images into the editor.
function loadDocIntoEditor(data, { setFields, setBaselineDraft, setOrderedImageUrls }) {
  setFields(fieldsFromDoc(data));
  setBaselineDraft(getBaselineDraftFromDoc(data));
  setOrderedImageUrls(getOrderedContentImageUrls(data));
}

// What the remote watch does with each document it fetches (remoteDocWatch.js).
function remoteDocHandlers(setters) {
  const { loadTimeRef, setBlog, setOrderedImageUrls, setExternallyModified } = setters;
  return {
    onFirstLoad: (data, remoteEditedAtMs) => {
      setBlog(data);
      loadDocIntoEditor(data, setters);
      if (remoteEditedAtMs > 0) loadTimeRef.current = new Date(remoteEditedAtMs);
      setExternallyModified(false);
      setters.setLoading(false);
    },
    onRemoteChange: (data, wasRemoteUpdateAfterLoad) => {
      if (wasRemoteUpdateAfterLoad) setExternallyModified(true);
      setBlog(data);
      if (!wasRemoteUpdateAfterLoad) {
        setOrderedImageUrls(getOrderedContentImageUrls(data));
      }
    },
    setLoadError: setters.setLoadError,
    setLoading: setters.setLoading,
  };
}

// Adopt the marker the server stamped on a save (see handleSave).
function adoptSavedMarker(response, lastSeenEditedAtMsRef, loadTimeRef) {
  const savedEditedAtMs = getEditedAtMs(response || {});
  if (savedEditedAtMs > 0) {
    lastSeenEditedAtMsRef.current = savedEditedAtMs;
    loadTimeRef.current = new Date(savedEditedAtMs);
  } else {
    loadTimeRef.current = new Date();
  }
}

// Values the editor shows that come straight from the loaded document.
function derivedDocValues(blog) {
  return {
    coverUrl: blog ? getCoverImageUrl(blog) : null,
    currentTarget: blog?.publishTarget || '',
    destinationUrl: blog ? getDestinationUrl(blog) : null,
    isLiveOrPublished: isLiveDoc(blog),
  };
}

/**
 * The hero and secondary images picked for the article, in order (at most
 * four when attaching). The ref always holds the latest list, for save.
 */
function useOrderedImages() {
  const [orderedImageUrls, setOrderedImageUrls] = useState([]);
  const orderedImageUrlsRef = useRef([]);
  useEffect(() => {
    orderedImageUrlsRef.current = orderedImageUrls;
  }, [orderedImageUrls]);

  const updateOrderedImages = useCallback((nextImages) => {
    setOrderedImageUrls(nextImages.map((image) => image.url).filter(Boolean));
  }, []);

  const removeOrderedImage = useCallback((index) => {
    setOrderedImageUrls((prev) => prev.filter((_, currentIndex) => currentIndex !== index));
  }, []);

  const attachOrderedImage = useCallback((imageUrl) => {
    const normalizedUrl = String(imageUrl || '').trim();
    if (!normalizedUrl) return;
    setOrderedImageUrls((prev) =>
      prev.includes(normalizedUrl) ? prev : [...prev, normalizedUrl].slice(0, 4)
    );
  }, []);

  return {
    orderedImageUrlsRef,
    setOrderedImageUrls,
    orderedImages: toOrderedImages(orderedImageUrls),
    updateOrderedImages,
    removeOrderedImage,
    attachOrderedImage,
  };
}

/**
 * One "regenerate with AI" button: asks for a new draft and copies one of its
 * fields (title or summary) into the editor when the answer has one.
 */
function useAiFieldGenerator({ blog, draft, setField, field, instruction, failureMessage }) {
  const [generating, setGenerating] = useState(false);
  const generate = useCallback(async () => {
    setGenerating(true);
    try {
      const aiDraft = await requestAiDraft({ blog, draft, instruction });
      const value = String(aiDraft[field] || '').trim();
      if (value) setField(field, value);
    } catch (err) {
      window.alert(err?.message || failureMessage);
    } finally {
      setGenerating(false);
    }
  }, [blog, draft, setField, field, instruction, failureMessage]);
  return [generating, generate];
}

// ── Hook ──────────────────────────────────────────────────────────────────────

/**
 * Master editor state hook.
 * Owns: Firestore subscription, all field state, save/publish, AI generation.
 * Delegates section and module logic to useSections / useModules.
 *
 * @param {string}   blogId    - Firestore document ID
 * @param {Function} navigate  - react-router navigate function
 */
export function useEditorState(blogId, navigate) {
  // ── Load/save status ───────────────────────────────────────────────────────
  const [blog, setBlog] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [lastSaved, setLastSaved] = useState(null);
  const [saveError, setSaveError] = useState(null);
  const [publishError, setPublishError] = useState(null);
  const [publishDebug, setPublishDebug] = useState(null);
  const [externallyModified, setExternallyModified] = useState(false);
  const [baselineDraft, setBaselineDraft] = useState('');
  const [editorMode, setEditorMode] = useState('visual');
  const [activeTab, setActiveTab] = useState('content');

  // ── Conflict detection refs ────────────────────────────────────────────────
  const loadTimeRef = useRef(null);
  const initializedRef = useRef(false);
  const lastSeenEditedAtMsRef = useRef(0);
  const {
    orderedImageUrlsRef,
    setOrderedImageUrls,
    orderedImages,
    updateOrderedImages,
    removeOrderedImage,
    attachOrderedImage,
  } = useOrderedImages();

  // ── Editable fields (single object to avoid 7 useState calls) ─────────────
  const [fields, setFields] = useState(INITIAL_FIELDS);

  const setField = useCallback((name, value) => {
    setFields((prev) => ({ ...prev, [name]: value }));
  }, []);

  // Stable draft setter to pass to sub-hooks
  const setDraft = useCallback((value) => {
    setFields((prev) => ({ ...prev, draft: value }));
  }, []);

  // ── Sub-hooks ──────────────────────────────────────────────────────────────
  const sectionAPI = useSections(fields.draft, setDraft);
  const moduleAPI = useModules(fields.draft, setDraft);

  // ── Board reorder (cross-section module moves) ────────────────────────────
  // Use refs so the callback always reads current values without stale closure issues.
  const sectionAPIRef = useRef(sectionAPI);
  const moduleAPIRef = useRef(moduleAPI);
  useEffect(() => {
    sectionAPIRef.current = sectionAPI;
    moduleAPIRef.current = moduleAPI;
  }, [sectionAPI, moduleAPI]);

  const reorderBoardItems = useCallback(
    (fromIndex, toIndex) => {
      const nextDraft = reorderedBoardDraft(
        sectionAPIRef.current,
        moduleAPIRef.current,
        fromIndex,
        toIndex
      );
      if (nextDraft !== null) setDraft(nextDraft);
    },
    [setDraft]
  );

  // ── Curated images (one call returns both galleries, newest first) ────────
  const { data: galleries } = usePublicData(
    () => getJSON('cms/images?limit=120'),
    'editor:galleries'
  );
  const curatedImages = galleries?.curated;
  const generatedGalleryImages = galleries?.generated;

  const imageCandidates = useMemo(
    () => buildImageCandidates(blog, curatedImages, generatedGalleryImages),
    [blog, curatedImages, generatedGalleryImages]
  );

  // ── Remote document watch ──────────────────────────────────────────────────
  // Load, then poll every twenty seconds; see remoteDocWatch.js for how an
  // edit by someone else is told apart from our own save.
  useEffect(
    () =>
      watchRemoteDoc(
        blogId,
        { initializedRef, loadTimeRef, lastSeenEditedAtMsRef },
        remoteDocHandlers({
          loadTimeRef,
          setBlog,
          setFields,
          setBaselineDraft,
          setOrderedImageUrls,
          setExternallyModified,
          setLoadError,
          setLoading,
        })
      ),
    [blogId, setOrderedImageUrls]
  );

  // ── Reload from remote ─────────────────────────────────────────────────────
  const handleReloadRemote = useCallback(() => {
    if (!blog) return;
    loadDocIntoEditor(blog, { setFields, setBaselineDraft, setOrderedImageUrls });
    loadTimeRef.current = new Date(lastSeenEditedAtMsRef.current || Date.now());
    setExternallyModified(false);
    setSaveError(null);
  }, [blog, setOrderedImageUrls]);

  // ── Save ───────────────────────────────────────────────────────────────────
  const handleSave = useCallback(
    async ({ force = false } = {}) => {
      setSaving(true);
      setSaveError(null);
      let success = false;
      try {
        if (externallyModified && !force) throw new Error('EDIT_CONFLICT');

        // Read latest fields snapshot via closure — fields is stable object ref per render
        const { response, normalizedDraft } = await saveDraft({
          blogId,
          fields,
          expectedEditedAtMs: lastSeenEditedAtMsRef.current || 0,
          force,
          orderedImageUrls: orderedImageUrlsRef.current,
        });

        // Adopt the marker the server just stamped, rather than waiting up to a
        // poll interval to learn it (T-208).
        //
        // This is what makes the poll's "is this my own write?" test an identity
        // comparison instead of a one-shot flag, and it also fixes a second
        // save inside the poll window: `expectedEditedAtMs` came from this ref,
        // so without it the next save would send the pre-save value and 409
        // against the caller's own previous write.
        //
        // Guarded on `> 0` so an older server that does not return the field
        // leaves the refs alone and the poll reconciles as before — adopting a
        // 0 here would make every later tick look like a remote edit.
        adoptSavedMarker(response, lastSeenEditedAtMsRef, loadTimeRef);
        setExternallyModified(false);
        if (normalizedDraft !== fields.draft) {
          setField('draft', normalizedDraft);
        }
        setLastSaved(new Date());
        success = true;
      } catch (err) {
        console.error('Save error:', err);
        const failure = saveFailure(err);
        if (failure.conflict) setExternallyModified(true);
        setSaveError(failure.message);
      } finally {
        setSaving(false);
      }
      return success;
    },
    [blogId, externallyModified, fields, setField, orderedImageUrlsRef]
  );

  // ── Publish ────────────────────────────────────────────────────────────────
  const handlePublish = useCallback(
    async (targetStatus = 'approved') => {
      const isAlreadyLive = isLiveDoc(blog);

      setPublishing(true);
      setPublishError(null);
      setPublishDebug(null);
      try {
        const saved = await handleSave();
        if (!saved) {
          setPublishError('Save failed before publish. Check your connection and try again.');
        } else if (isAlreadyLive) {
          await republishLive({ blog, blogId, setPublishDebug });
        } else {
          await transitionToQueue({ blogId, targetStatus, setPublishDebug, navigate });
        }
      } catch (err) {
        console.error('Publish error:', err);
        setPublishError(err.message);
      } finally {
        setPublishing(false);
      }
    },
    [blog, blogId, handleSave, navigate]
  );

  // ── Keyboard shortcut Ctrl+S ───────────────────────────────────────────────
  useEffect(() => {
    const handler = (e) => {
      if (isSaveShortcut(e)) {
        e.preventDefault();
        handleSave();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [handleSave]);

  // ── AI generation ──────────────────────────────────────────────────────────
  const [generatingTitle, generateTitle] = useAiFieldGenerator({
    blog,
    draft: fields.draft,
    setField,
    field: 'title',
    instruction: 'Recreate a clear, catchy title using the article content.',
    failureMessage: 'AI title generation failed.',
  });

  const [generatingSummary, generateSummary] = useAiFieldGenerator({
    blog,
    draft: fields.draft,
    setField,
    field: 'summary',
    instruction:
      'Recreate a concise summary for quick intro and reading pane using the article content.',
    failureMessage: 'AI summary generation failed.',
  });

  // ── Derived values ─────────────────────────────────────────────────────────
  const { coverUrl, currentTarget, destinationUrl, isLiveOrPublished } = derivedDocValues(blog);

  return {
    // Load state
    blog,
    loading,
    loadError,

    // Editable fields
    fields,
    setField,

    // Editor UI mode
    editorMode,
    setEditorMode,

    // Active tab (shared so Board/Modules can navigate to Content/Modules)
    activeTab,
    setActiveTab,

    // Baseline (for diff view)
    baselineDraft,

    // Section API (all useSections return values)
    ...sectionAPI,

    // Module API (all useModules return values)
    ...moduleAPI,

    // Board reorder (needs both section + module context)
    reorderBoardItems,

    // Image candidates
    imageCandidates,
    orderedImages,
    updateOrderedImages,
    removeOrderedImage,
    attachOrderedImage,

    // Conflict
    externallyModified,
    setExternallyModified,

    // Save/publish
    saving,
    lastSaved,
    saveError,
    setSaveError,
    publishing,
    publishError,
    publishDebug,
    handleSave,
    handleReloadRemote,
    handlePublish,

    // AI
    generatingTitle,
    generatingSummary,
    generateTitle,
    generateSummary,

    // Derived
    coverUrl,
    currentTarget,
    destinationUrl,
    isLiveOrPublished,
  };
}
