import React, { useState } from 'react';
import { postJSON, getJSON } from '@/lib/api';
import { logAdminAction } from '@/lib/auditLog';
import { unpublishToInspected } from '@/lib/contentWorkflow';
import { getPublishTargetForItem } from '@/lib/contentModel';
import {
  getPrePublishFailures,
  findPublishMapping,
  buildPublishDebug,
  getPublishErrorMessage,
} from './publishHelpers';

export function usePublishWorkflow({ navigate, withImageOverride, setLocalLiveOverrides }) {
  const [publishingId, setPublishingId] = useState('');
  const [publishError, setPublishError] = useState('');
  const [publishDebug, setPublishDebug] = useState(null);
  const [unpublishTarget, setUnpublishTarget] = useState(null);
  // Pre-publish validation modal state
  const [publishCandidate, setPublishCandidate] = useState(null);
  const [publishFailures, setPublishFailures] = useState([]);
  const [validatingId, setValidatingId] = useState('');
  const [autoPostSocial, setAutoPostSocial] = useState(false);

  const handlePublishRequest = async (item) => {
    setPublishError('');
    setValidatingId(item.id);
    try {
      let merged = withImageOverride(item);
      try {
        const res = await getJSON(`cms/content/item?contentId=${encodeURIComponent(item.id)}`);
        if (res.item) merged = { ...res.item, ...merged };
      } catch {
        // Snapshot data only
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

      setLocalLiveOverrides((prev) => ({ ...prev, [item.id]: true }));
      try {
        await logAdminAction('content_published_live', {
          contentId: item.id,
          title: item.Title || item.title,
          publishTarget,
          publishMapping: mapping || null,
        });
      } catch (auditErr) {
        console.warn('Failed to log admin action for content_published_live:', auditErr);
      }
      if (autoPostSocial) {
        navigate(`/admin/social-hub?tab=compose&contentId=${encodeURIComponent(item.id)}`);
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

export function PublishDiagnostics({ publishDebug }) {
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
