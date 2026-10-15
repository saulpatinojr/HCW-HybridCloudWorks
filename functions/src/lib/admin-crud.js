/**
 * Admin CRUD — certifications and social posts (api-surface adminWrites,
 * first two slices in the contract's page-usage order), plus the one blog
 * delete.
 *
 * Like the public reads, there is no backend source to port: the admin pages
 * called Firestore directly (CertificationsPage.jsx addDoc/updateDoc/
 * deleteDoc, SocialHubPage.jsx addDoc/deleteDoc + status-filtered list).
 * Semantics mirror those call sites so the pages can swap fetch targets
 * without behavior change:
 *
 *   - certifications: list ALL docs (the page filters/sorts client-side on
 *     display_order), create stamps _createdAt/_updatedAt, edits are PARTIAL
 *     patches stamping _updatedAt — the page's patchCert() sends single-field
 *     toggles, so a whole-doc replace would drop everything else.
 *   - social_posts: list filtered to status IN (scheduled, published) newest
 *     first (createdAt is sorted in memory — Cosmos ORDER BY drops docs
 *     missing the property, same trap as public-reads), create stamps
 *     createdAt, delete by id.
 *
 * Every route sits behind the editor role guard; these were previously
 * "protected" only by Firestore rules that trusted the admin custom claim.
 *
 * The routes live one hub per module under ./admin-crud/ — blogs.js,
 * certifications.js (+ certification-rules.js), social-posts.js (+
 * social-post-rules.js) — and this module composes them and re-exports the
 * public names, so admin-crud-http.js and every test import exactly what they
 * always did.
 */
import { randomUUID } from 'node:crypto';
import { createBlogHandlers } from './admin-crud/blogs.js';
import { createCertificationHandlers } from './admin-crud/certifications.js';
import { createSocialPostHandlers } from './admin-crud/social-posts.js';

export {
  CERTIFICATION_FIELDS,
  isCertImagePath,
  toCalendarDate,
  validateCertification,
} from './admin-crud/certification-rules.js';
export {
  SOCIAL_CREATE_FIELDS,
  socialPostEditRefusal,
  validateSocialPostCreate,
  validateSocialPostPatch,
} from './admin-crud/social-post-rules.js';

/**
 * @param {object} deps
 * @param {{ requireRole: Function }} deps.guard
 * @param {{ queryDocs: Function, readDoc: Function, upsertDoc: Function, patchDoc: Function, deleteDoc: Function }} deps.store
 * @param {{ deleteBlob: Function }} [deps.storage] — for the editor's cancel path
 * @param {() => Date} [deps.now]
 * @param {() => string} [deps.uuid]
 * @param {(post: object) => Promise<{attempted: number, removed: number}>} [deps.unpublishSocialPost]
 */
export function createAdminCrudHandlers({
  guard,
  store,
  storage = null,
  now = () => new Date(),
  uuid = randomUUID,
  unpublishSocialPost = null,
}) {
  const ctx = { guard, store, storage, now, uuid, unpublishSocialPost };
  return {
    ...createBlogHandlers(ctx),
    ...createCertificationHandlers(ctx),
    ...createSocialPostHandlers(ctx),
  };
}
