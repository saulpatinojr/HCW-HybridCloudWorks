/**
 * social-post-rules.js — what a social-post edit may change, and which
 * stored posts refuse one (ADR 0033 Amplify slice). Pure: the handlers are
 * in ./social-posts.js, and admin-crud.js re-exports the public names.
 */

export const SOCIAL_DEFAULT_STATUSES = ['scheduled', 'published'];
/** What PATCH may change on a social post; everything else is Publer's or the timer's. */
export const SOCIAL_EDITABLE = ['caption', 'url', 'scheduledAt'];
/** What POST may carry on social post creation (AP-B6). */
export const SOCIAL_CREATE_FIELDS = [
  'caption',
  'text',
  'url',
  'scheduledAt',
  'status',
  'accountIds',
  'platforms',
  'mediaUrls',
  'contentId',
];
const MAX_CAPTION = 5000;

/** One editable field each: the cleaned value, or the sentence refusing it. */
const SOCIAL_FIELD_CLEANERS = {
  caption(value) {
    const caption = typeof value === 'string' ? value.trim() : '';
    if (!caption || caption.length > MAX_CAPTION) {
      return { error: `caption must be 1 to ${MAX_CAPTION} characters` };
    }
    return { value: caption };
  },
  url(value) {
    const url = value === null ? null : String(value).trim();
    if (url && !/^https?:\/\//i.test(url)) return { error: 'url must be absolute http(s)' };
    return { value: url || null };
  },
  scheduledAt(value, nowMs) {
    if (value === null) {
      return { error: 'scheduledAt cannot be cleared; delete the post to cancel it' };
    }
    const when = new Date(value);
    if (Number.isNaN(when.getTime())) return { error: 'scheduledAt must be an ISO instant' };
    if (when.getTime() <= nowMs) return { error: 'scheduledAt must be in the future' };
    return { value: when.toISOString() };
  },
};

/** The body of a social-post PATCH as `{ updates }`, or `{ error }` naming the first bad field. */
export function validateSocialPostPatch(body, nowMs) {
  const unknown = Object.keys(body).filter((key) => !SOCIAL_EDITABLE.includes(key));
  if (unknown.length) return { error: `Unknown field(s): ${unknown.join(', ')}` };
  const updates = {};
  for (const key of SOCIAL_EDITABLE) {
    if (body[key] === undefined) continue;
    const cleaned = SOCIAL_FIELD_CLEANERS[key](body[key], nowMs);
    if (cleaned.error) return cleaned;
    updates[key] = cleaned.value;
  }
  return { updates };
}

/** Why a stored post refuses this edit, or null. */
export function socialPostEditRefusal(existing, updates) {
  if (existing.status === 'published') return 'A published post cannot be edited or rescheduled.';
  if (updates.scheduledAt && existing.status !== 'scheduled') {
    return `Only a scheduled post can be rescheduled; this one is ${existing.status}.`;
  }
  return null;
}

/** Validate fields for social post creation (AP-B6). Returns `{ doc }` or `{ error }`. */
export function validateSocialPostCreate(body, nowMs) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'Body must be a JSON object' };
  }
  const unknown = Object.keys(body).filter((key) => !SOCIAL_CREATE_FIELDS.includes(key));
  if (unknown.length > 0) {
    return { error: `Unknown field(s): ${unknown.join(', ')}` };
  }

  const doc = {};

  // caption or text
  const captionRaw = body.caption ?? body.text;
  if (captionRaw !== undefined) {
    const cleanedCaption = SOCIAL_FIELD_CLEANERS.caption(captionRaw);
    if (cleanedCaption.error) return cleanedCaption;
    doc.caption = cleanedCaption.value;
    if (body.text !== undefined) doc.text = cleanedCaption.value;
  }

  // url
  if (body.url !== undefined) {
    const cleanedUrl = SOCIAL_FIELD_CLEANERS.url(body.url);
    if (cleanedUrl.error) return cleanedUrl;
    doc.url = cleanedUrl.value;
  }

  // scheduledAt
  if (body.scheduledAt !== undefined) {
    const cleanedWhen = SOCIAL_FIELD_CLEANERS.scheduledAt(body.scheduledAt, nowMs);
    if (cleanedWhen.error) return cleanedWhen;
    doc.scheduledAt = cleanedWhen.value;
  }

  // status
  if (body.status !== undefined) {
    const validStatuses = ['draft', 'scheduled', 'published', 'failed'];
    if (!validStatuses.includes(body.status)) {
      return { error: `status must be one of: ${validStatuses.join(', ')}` };
    }
    doc.status = body.status;
  } else {
    doc.status = doc.scheduledAt ? 'scheduled' : 'draft';
  }

  // accountIds
  if (body.accountIds !== undefined) {
    if (!Array.isArray(body.accountIds) || body.accountIds.some((id) => typeof id !== 'string')) {
      return { error: 'accountIds must be an array of strings' };
    }
    doc.accountIds = body.accountIds;
  }

  // platforms
  if (body.platforms !== undefined) {
    if (!Array.isArray(body.platforms) || body.platforms.some((p) => typeof p !== 'string')) {
      return { error: 'platforms must be an array of strings' };
    }
    doc.platforms = body.platforms;
  }

  // mediaUrls
  if (body.mediaUrls !== undefined) {
    if (
      !Array.isArray(body.mediaUrls) ||
      body.mediaUrls.some((u) => typeof u !== 'string' || !/^https?:\/\//i.test(u))
    ) {
      return { error: 'mediaUrls must be an array of http(s) URLs' };
    }
    doc.mediaUrls = body.mediaUrls;
  }

  // contentId
  if (body.contentId !== undefined) {
    if (typeof body.contentId !== 'string') {
      return { error: 'contentId must be a string' };
    }
    doc.contentId = body.contentId;
  }

  return { doc };
}

