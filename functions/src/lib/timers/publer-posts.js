/**
 * publer-posts.js — Publer posts as `social_posts` sees them: one post in a
 * single shape, Publer's state as a calendar status, finding the social post
 * a Publer post belongs to, and the patch that syncs it. Pure functions, for
 * the reconcile in publer-sync.js, which says why and exports them again.
 */

function asIsoString(value) {
  if (!value) return null;
  const date = value?.toDate ? value.toDate() : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function normalizePublerPost(post = {}) {
  const id = post.id || post.post_id || null;
  const state = String(post.state || post.status || '').toLowerCase();
  return {
    ...post,
    id,
    state,
    text: post.text || post.caption || post.description || '',
    scheduledAt: asIsoString(post.scheduled_at || post.scheduledAt),
    updatedAt: asIsoString(post.updated_at || post.updatedAt),
    accountId: post.account_id || post.accountId || null,
    network: post.network || post.provider || null,
    jobId: post.job_id || post.jobId || null,
  };
}

export function publerStateToSocialStatus(state) {
  const normalized = String(state || '').toLowerCase();
  if (normalized.startsWith('published')) return 'published';
  if (normalized.startsWith('failed')) return 'failed';
  if (normalized.startsWith('scheduled')) return 'scheduled';
  if (normalized.startsWith('draft')) return 'draft';
  return normalized || 'unknown';
}

export function extractPublerList(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.posts)) return data.posts;
  if (Array.isArray(data?.data)) return data.data;
  return [];
}

export function findSocialPostForPublerPost(socialPosts, publerPost) {
  const normalized = normalizePublerPost(publerPost);
  return socialPosts.find((item) => {
    const ids = Array.isArray(item.publerPostIds) ? item.publerPostIds.map(String) : [];
    return (
      (normalized.id && ids.includes(String(normalized.id))) ||
      (normalized.jobId && String(item.publerJobId || '') === String(normalized.jobId))
    );
  });
}

/** The patch a matched social post takes from its Publer post(s). `syncError` is cleared. */
export function buildSocialPostSyncPatch(
  publerPost,
  existing = {},
  relatedPosts = [publerPost],
  stamp
) {
  const normalized = normalizePublerPost(publerPost);
  const existingIds = Array.isArray(existing.publerPostIds) ? existing.publerPostIds : [];
  const activePosts = relatedPosts.map(normalizePublerPost).filter((post) => post.id);
  const states = activePosts.map((post) => post.state);
  let aggregateStatus = publerStateToSocialStatus(normalized.state);
  if (states.some((state) => state.startsWith('scheduled'))) aggregateStatus = 'scheduled';
  else if (states.some((state) => state.startsWith('failed'))) aggregateStatus = 'failed';
  return {
    publerStatus:
      states.length > 1 && new Set(states).size > 1 ? 'mixed' : normalized.state || null,
    publerActivePostIds: activePosts.map((post) => post.id),
    publerScheduledAt:
      activePosts.find((post) => post.scheduledAt)?.scheduledAt || normalized.scheduledAt || null,
    publerUpdatedAt: normalized.updatedAt || null,
    publerPostIds: [...new Set([...existingIds, ...(normalized.id ? [normalized.id] : [])])],
    publerJobId: normalized.jobId || existing.publerJobId || null,
    status: aggregateStatus,
    syncStatus: 'synced',
    syncOrigin: 'publer',
    lastSyncedAt: stamp,
    syncError: null,
  };
}

