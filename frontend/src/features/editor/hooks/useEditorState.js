import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { usePublicData } from '@/hooks/usePublicData';
import { getCoverImageUrl } from '@/lib/blogUtils';
import { toMillis } from '@/lib/dateUtils';
import { postJSON, getJSON } from '@/lib/api';
import { logAdminAction } from '@/lib/auditLog';
import { useSections, joinSectionsToDraft } from './useSections';
import { useModules } from './useModules';
import { applyBoardReorder, buildBoardItems } from '../components/BoardTab';
import { getOrderedContentImageUrls } from '@/lib/contentImages';
import { ensureTldrSectionAtEnd } from '@/lib/contentDraft';

// ── Pure helpers (module-private) ────────────────────────────────────────────

const PROVIDER_ALIASES = {
  amazon: 'aws',
  'amazon web services': 'aws',
  google: 'gcp',
  'google cloud': 'gcp',
  microsoft: 'azure',
};

function normalizeProvider(value = '') {
  const key = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, '')
    .trim();
  return PROVIDER_ALIASES[key] || key.replace(/\s+/g, '');
}

function getEditedAtMs(data = {}) {
  return toMillis(data.blogEditedAt);
}

function getEditorAuthor(data = {}) {
  return (
    data.editorAuthor ||
    data.siteAuthor ||
    data.publishedByName ||
    data.createdByName ||
    'Hybrid Cloud Works'
  );
}

function getDraftFromDoc(data = {}) {
  return ensureTldrSectionAtEnd(
    data.blogDraft || data.content || data.Content || data.postContent || ''
  );
}

function getBaselineDraftFromDoc(data = {}) {
  return ensureTldrSectionAtEnd(data.content || data.Content || data.postContent || '');
}

export function getDestinationUrl(docData = {}) {
  const explicitUrl =
    docData.slugPageUrl || docData.publishedUrl || docData.blogUrl || docData.publicUrl || '';
  if (explicitUrl) return explicitUrl;

  const provider = normalizeProvider(
    docData['Cloud Provider'] || docData.cloudProvider || docData.provider || docData.Provider || ''
  );
  const slug = docData.slug || docData.Slug || '';
  if (!provider || !slug) return null;

  const target = String(docData.publishTarget || docData.type || '').toLowerCase();
  const segmentByTarget = {
    framework: 'frameworks',
    architecture: 'architecture-designs',
    coder_corner: 'code',
    news: 'news',
    rss: 'news',
  };
  const segment = segmentByTarget[target] || 'blog';
  return `https://hybridcloudworks.com/${provider}/${segment}/${slug}`;
}

function resolveBlogProvider(blog = {}) {
  return normalizeProvider(
    blog?.['Cloud Provider'] || blog?.cloudProvider || blog?.provider || blog?.Provider || ''
  );
}

async function requestAiDraft({ blog, draft, instruction }) {
  const sourceUrl = String(blog?.sourceUrl || blog?.url || '').trim();
  if (!sourceUrl) throw new Error('Missing source URL for AI generation.');
  const response = await postJSON('generateArticleDraft', {
    url: sourceUrl,
    cloudProvider: resolveBlogProvider(blog),
    draftText: draft,
    instructions: instruction,
  });
  return response?.draft || {};
}

const INITIAL_FIELDS = {
  title: '',
  authorName: 'Hybrid Cloud Works',
  publishedDate: '',
  draft: '',
  summary: '',
  tags: '',
  sidebarContent: '',
};

function fieldsFromDoc(data) {
  if (!data) return INITIAL_FIELDS;

  let publishedDate = '';
  const rawDate =
    data.publishedDate ||
    data.datePublished ||
    data['Published At'] ||
    data.blogPublishedAt ||
    data.publishedAt;
  if (rawDate) {
    const dateObj = rawDate?.toDate?.() || rawDate;
    if (dateObj instanceof Date) {
      [publishedDate] = dateObj.toISOString().split('T');
    }
  }
  if (!publishedDate) {
    [publishedDate] = new Date().toISOString().split('T');
  }

  return {
    title: data.Title || data.title || '',
    authorName: getEditorAuthor(data),
    publishedDate,
    draft: getDraftFromDoc(data),
    summary: data.Summary || data.summary || '',
    tags: (data.Tags || data.keyTopics || []).join(', '),
    sidebarContent: data.sidebarContent || '',
  };
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
  const [orderedImageUrls, setOrderedImageUrls] = useState([]);

  // ── AI generation ──────────────────────────────────────────────────────────
  const [generatingTitle, setGeneratingTitle] = useState(false);
  const [generatingSummary, setGeneratingSummary] = useState(false);

  // ── Conflict detection refs ────────────────────────────────────────────────
  const loadTimeRef = useRef(null);
  const initializedRef = useRef(false);
  const lastSeenEditedAtMsRef = useRef(0);
  const orderedImageUrlsRef = useRef([]);
  useEffect(() => {
    orderedImageUrlsRef.current = orderedImageUrls;
  }, [orderedImageUrls]);

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
      const { sections, sectionModuleOffsets } = sectionAPIRef.current;
      const { moduleItems } = moduleAPIRef.current;
      if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0) return;

      const boardItems = buildBoardItems(sections, moduleItems, sectionModuleOffsets);
      if (fromIndex >= boardItems.length || toIndex >= boardItems.length) return;

      const next = [...boardItems];
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);

      const newSections = applyBoardReorder(next, sections, moduleItems);
      setDraft(joinSectionsToDraft(newSections));
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

  const imageCandidates = useMemo(() => {
    const curated = (curatedImages || []).map((item) => ({
      id: item.articleId || item.id,
      imageUrl: item.imageUrl,
      label: item.articleId || item.id || 'Curated image',
      source: 'gallery',
    }));

    const generated = (generatedGalleryImages || []).map((item) => ({
      id: item.id,
      imageUrl: item.imageUrl,
      label: item.title || item.articleId || item.id || 'Generated image',
      source: 'gallery',
    }));

    const scraped = (blog?.scrapedImages || []).map((item, index) => ({
      id: item.url || item.src || item.stored || item.original || `scraped-${index}`,
      // Prefer the archived Storage URL when present (published path);
      // fall back to the original source URL for drafts that haven't been
      // archived yet (F2 — archive deferred to publish-time).
      imageUrl: item.stored || item.url || item.src || item.original,
      label: item.alt || `Scraped ${index + 1}`,
      source: 'scraped',
    }));

    return [...scraped, ...generated, ...curated].filter((item) => item.imageUrl).slice(0, 36);
  }, [blog, curatedImages, generatedGalleryImages]);

  // ── Remote document watch ──────────────────────────────────────────────────
  // The Firestore onSnapshot listener becomes fetch-plus-poll: an immediate
  // load, then a periodic re-fetch. The same handler drives both, so the
  // external-edit-conflict detection (remote blogEditedAt newer than our load
  // time) works exactly as it did with realtime pushes — just with up to one
  // poll interval of latency.
  useEffect(() => {
    initializedRef.current = false;
    loadTimeRef.current = new Date();
    let cancelled = false;
    let inFlight = false;

    const applyRemoteDoc = (data) => {
      if (cancelled) return;
      setLoadError(null);
      const remoteEditedAtMs = getEditedAtMs(data);

      if (!initializedRef.current) {
        initializedRef.current = true;
        lastSeenEditedAtMsRef.current = remoteEditedAtMs;
        setBlog(data);
        setFields(fieldsFromDoc(data));
        setBaselineDraft(getBaselineDraftFromDoc(data));
        setOrderedImageUrls(getOrderedContentImageUrls(data));
        if (remoteEditedAtMs > 0) loadTimeRef.current = new Date(remoteEditedAtMs);
        setExternallyModified(false);
        setLoading(false);
        return;
      }

      // Nothing changed since the last tick — including the case where this is
      // our own save coming back, because `handleSave` records the marker the
      // server returned the moment it returns it.
      //
      // The poll has no change detection at all, so this branch used to fall
      // through and reset `orderedImageUrls` — user-mutable state that is only
      // persisted on save — from the remote document every twenty seconds,
      // discarding an in-progress reorder. It also re-rendered the whole editor
      // on every tick while idle. (T-209)
      //
      // `blogEditedAt` is the only change marker here, and `saveEditorDraft` is
      // its only writer, so an out-of-band status change does not wake this.
      // That is correct for what the poll is: a detector for "another editor
      // saved this document".
      if (remoteEditedAtMs === lastSeenEditedAtMsRef.current) return;

      lastSeenEditedAtMsRef.current = remoteEditedAtMs;

      // Anything that reaches here is a marker we have not seen and did not
      // write, i.e. somebody else's save.
      //
      // What used to be here was a one-shot `pendingLocalSaveRef` boolean,
      // consumed by whatever the *next* response happened to carry. Under
      // `onSnapshot` that was reliably our own write, milliseconds later. Under
      // a twenty-second poll it can be a collaborator's — and the branch then
      // cleared `externallyModified` and adopted THEIR `blogEditedAt` as our
      // baseline, so our next save passed the server's equality check and
      // overwrote them, with no warning to either person. (T-208)
      const wasRemoteUpdateAfterLoad =
        remoteEditedAtMs > 0 &&
        loadTimeRef.current &&
        remoteEditedAtMs > loadTimeRef.current.getTime();

      if (wasRemoteUpdateAfterLoad) setExternallyModified(true);
      setBlog(data);
      if (!wasRemoteUpdateAfterLoad) {
        setOrderedImageUrls(getOrderedContentImageUrls(data));
      }
    };

    const fetchRemoteDoc = async () => {
      // getJSON allows 20 s and the poll below fires every 20 s, so ticks can
      // overlap. Two in flight at once can resolve out of order and render an
      // older document over a newer one — which here is worse than a stale
      // view, because `applyRemoteDoc` compares the response's `blogEditedAt`
      // against our load time to decide whether someone else edited the doc.
      // (T-309)
      if (inFlight) return;
      inFlight = true;
      try {
        const res = await getJSON(`cms/content/item?contentId=${encodeURIComponent(blogId)}`);
        if (res.item) applyRemoteDoc(res.item);
      } catch (err) {
        if (cancelled) return;
        const message = String(err?.message || '');
        if (message.includes('not found')) {
          // Missing doc mirrors the !snap.exists() path: stop loading quietly.
          setLoading(false);
          return;
        }
        console.error('Error loading document:', err);
        // Only surface the error before first load — a failed background
        // poll on an already-open editor shouldn't blank the page.
        if (!initializedRef.current) {
          setLoadError(
            message.includes('Forbidden') || message.includes('401') || message.includes('403')
              ? 'Missing or insufficient permissions. Please sign in with an admin account.'
              : 'Unable to load this document right now. Please try again.'
          );
          setLoading(false);
        }
      } finally {
        // `finally`, not the end of `try` — the catch block returns early on a
        // missing doc and on cancellation, and leaving the flag set on either
        // path would stop the poll permanently.
        inFlight = false;
      }
    };

    fetchRemoteDoc();
    const pollId = setInterval(fetchRemoteDoc, 20_000);

    return () => {
      cancelled = true;
      clearInterval(pollId);
    };
  }, [blogId]);

  // ── Reload from remote ─────────────────────────────────────────────────────
  const handleReloadRemote = useCallback(() => {
    if (!blog) return;
    setFields(fieldsFromDoc(blog));
    setBaselineDraft(getBaselineDraftFromDoc(blog));
    setOrderedImageUrls(getOrderedContentImageUrls(blog));
    loadTimeRef.current = new Date(lastSeenEditedAtMsRef.current || Date.now());
    setExternallyModified(false);
    setSaveError(null);
  }, [blog]);

  // ── Save ───────────────────────────────────────────────────────────────────
  const handleSave = useCallback(
    async ({ force = false } = {}) => {
      setSaving(true);
      setSaveError(null);
      let success = false;
      try {
        if (externallyModified && !force) throw new Error('EDIT_CONFLICT');

        const expectedEditedAtMs = lastSeenEditedAtMsRef.current || 0;

        // Read latest fields snapshot via closure — fields is stable object ref per render
        const { draft, title, authorName, publishedDate, summary, tags, sidebarContent } = fields;
        const normalizedDraft = ensureTldrSectionAtEnd(draft);
        const response = await postJSON('saveEditorDraft', {
          contentId: blogId,
          expectedEditedAtMs,
          force,
          draft: normalizedDraft,
          title,
          authorName,
          publishedDate,
          summary,
          tags,
          sidebarContent,
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
        const savedEditedAtMs = getEditedAtMs(response || {});
        if (savedEditedAtMs > 0) {
          lastSeenEditedAtMsRef.current = savedEditedAtMs;
          loadTimeRef.current = new Date(savedEditedAtMs);
        } else {
          loadTimeRef.current = new Date();
        }
        setExternallyModified(false);
        if (normalizedDraft !== draft) {
          setField('draft', normalizedDraft);
        }
        setLastSaved(new Date());
        success = true;
      } catch (err) {
        console.error('Save error:', err);
        if (String(err?.message || '').includes('EDIT_CONFLICT')) {
          setExternallyModified(true);
          setSaveError(
            'Save blocked: this document changed remotely. Refresh and reconcile changes.'
          );
        } else if (String(err?.message || '').includes('not found')) {
          setSaveError('Save failed: document no longer exists.');
        } else {
          setSaveError(`Save failed: ${err.message}`);
        }
      } finally {
        setSaving(false);
      }
      return success;
    },
    [blogId, externallyModified, fields, setField]
  );

  // ── Publish ────────────────────────────────────────────────────────────────
  const handlePublish = useCallback(
    async (targetStatus = 'approved') => {
      const status = String(blog?.contentStatus || '');
      // `published` is the canonical spelling, `published_*` the Firestore-era
      // one (ADR 0033 §1): either means the article has been published and a
      // save republishes it rather than re-entering the queue.
      const isAlreadyLive =
        blog?.Live === true || status === 'published' || status.startsWith('published_');

      async function handleLiveRepublish() {
        const publishTarget = blog?.publishTarget || blog?.type || null;
        const republishResult = await postJSON('publishContent', {
          contentIds: [blogId],
          publishTarget,
          cloudProvider: resolveBlogProvider(blog),
          landingProvider: blog?.landingProvider || null,
          markLive: true,
          createSlugPageTrigger: true,
          addToCurated: true,
        });

        const mapping =
          Array.isArray(republishResult?.mappings) &&
          republishResult.mappings.find((entry) => entry.contentId === blogId);

        setPublishDebug({
          mode: 'live-republish',
          from: status || null,
          to: 'published',
          contentId: blogId,
          note: 'This live item was republished from the editor so the public page stays in sync.',
          expectedPublicUrl: mapping?.expectedPublicUrl || getDestinationUrl(blog) || null,
        });

        await logAdminAction('content_live_saved_from_editor', {
          contentId: blogId,
          status,
          republished: true,
        });
      }

      async function handleQueueTransition() {
        const result = await postJSON('transitionContentStatus', {
          contentId: blogId,
          newStatus: targetStatus,
          reviewNotes: `Published from editor as ${targetStatus.replace(/_/g, ' ')}`,
        });

        setPublishDebug({
          mode: 'queue-transition',
          from: result?.from || null,
          to: result?.to || targetStatus,
          contentId: result?.contentId || blogId,
          note: 'Status transitioned from editor. Final live publishing still occurs from /admin/publish.',
        });

        // transitionContentStatus writes the `audits` row itself; the client
        // copy that doubled it is gone (ADR 0033 §1).
        navigate('/admin/publish');
      }

      setPublishing(true);
      setPublishError(null);
      setPublishDebug(null);
      try {
        const saved = await handleSave();
        if (!saved) {
          setPublishError('Save failed before publish. Check your connection and try again.');
          return;
        }

        if (isAlreadyLive) {
          await handleLiveRepublish();
          return;
        }

        await handleQueueTransition();
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
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        handleSave();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [handleSave]);

  // ── AI generation ──────────────────────────────────────────────────────────
  const generateTitle = useCallback(async () => {
    setGeneratingTitle(true);
    try {
      const aiDraft = await requestAiDraft({
        blog,
        draft: fields.draft,
        instruction: 'Recreate a clear, catchy title using the article content.',
      });
      const aiTitle = String(aiDraft.title || '').trim();
      if (aiTitle) setField('title', aiTitle);
    } catch (err) {
      window.alert(err?.message || 'AI title generation failed.');
    } finally {
      setGeneratingTitle(false);
    }
  }, [blog, fields.draft, setField]);

  const generateSummary = useCallback(async () => {
    setGeneratingSummary(true);
    try {
      const aiDraft = await requestAiDraft({
        blog,
        draft: fields.draft,
        instruction:
          'Recreate a concise summary for quick intro and reading pane using the article content.',
      });
      const aiSummary = String(aiDraft.summary || '').trim();
      if (aiSummary) setField('summary', aiSummary);
    } catch (err) {
      window.alert(err?.message || 'AI summary generation failed.');
    } finally {
      setGeneratingSummary(false);
    }
  }, [blog, fields.draft, setField]);

  // ── Derived values ─────────────────────────────────────────────────────────
  const coverUrl = blog ? getCoverImageUrl(blog) : null;
  const currentTarget = blog?.publishTarget || '';
  const destinationUrl = blog ? getDestinationUrl(blog) : null;
  const isLiveOrPublished =
    blog?.Live === true ||
    blog?.contentStatus === 'published' ||
    String(blog?.contentStatus || '').startsWith('published_');
  const orderedImages = orderedImageUrls.map((url, index) => ({
    id: `${index}-${url}`,
    url,
    label: index === 0 ? 'Hero' : `Secondary ${index}`,
    sourceLabel: 'Selected',
  }));

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
