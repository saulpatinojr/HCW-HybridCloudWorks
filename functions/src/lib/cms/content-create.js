/**
 * createContentItem — the write path for new content documents.
 *
 * Ported from Site-Main cms-functions.js createContentItem (:3047-3140),
 * composing the already-ported pieces in source order: normalize type and
 * publish target → shape body fields → four-stage dedup (409) → editorial
 * critique unless the caller opts out → content-quality gate on elevated
 * statuses (422, unless forceQualityBypass) → write the document.
 *
 * Adaptations, each deliberate:
 *   - Firestore `.add()` minted the document id; Cosmos requires an explicit
 *     one, so the handler stamps `id: uuid()` after the data spread — a client
 *     -supplied `id` never picks the document key, exactly like `.add()`.
 *   - `FieldValue.serverTimestamp()` becomes one ISO string used for both
 *     'Created At' and updatedAt — the shape scripts/lib/firestore-transform
 *     .mjs already gives migrated documents.
 *   - `critiqueDraft` is injected and defaults to a null critique: the AI
 *     model-router slice has not landed, and every scorer is specified to
 *     grade correctly with critique=null (the runEditorialCritique:false
 *     path). Wiring the real critique later changes this one default.
 *   - createdBy falls back through the Entra claim names (email is often
 *     absent on access tokens; preferred_username usually is not) before the
 *     source's literal 'admin'.
 *   - `kind` and `ideaOrigin` (ADR 0033 §4) are accepted when they name an
 *     enabled entry of the stored taxonomy and refused with a 400 naming the
 *     allowed ids otherwise; absent, the record is classified at read time
 *     from its `type` and `source`, so nothing here invents a value.
 */
import { randomUUID } from "node:crypto";
import { authoredMessage, errorResponse } from "../http/error-response.js";
import { actorName } from "../auth/actor-name.js";
import {
  normalizeContentBodyFields,
  getPrimaryContentBody,
  buildContentQualityReport,
  buildImageReadinessReport,
  buildImageLineage,
} from "./content-quality.js";
import { findDuplicateContent, buildDedupFields } from "./content-dedup.js";
import {
  normalizePublishTarget,
  SUPPORTED_PUBLISH_TARGETS,
} from "./publish-targets.js";
import {
  TaxonomyFieldError,
  validateTaxonomyFieldsWithStore,
} from "./taxonomy-fields.js";

const json = (status, body) => ({
  status,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

/** Statuses that must pass the quality gate to be set at creation time. */
export const QUALITY_ENFORCED_STATUSES = [
  "inspected",
  "approved",
  "forge_ready",
  "published",
];

const nullCritique = async () => null;

/**
 * The write path itself, separated from the HTTP shape so a second caller
 * (createContentFromRecording, #180) persists through the same dedup, quality
 * gate and document shape instead of growing a parallel one. Returns
 * `{ status, body }` in the handler's own vocabulary: 200 with `contentId`,
 * 400 unknown kind or idea origin, 409 duplicate, 422 quality gate. Throws
 * only on a store failure.
 *
 * @param {object} args
 * @param {{ queryDocs: Function, upsertDoc: Function, readDoc?: Function }} args.store
 * @param {object} args.user       The guard's user (claims), for createdBy.
 * @param {object} args.data       The content fields, as the request's `data`.
 * @param {boolean} [args.runEditorialCritique=true]
 * @param {boolean} [args.forceQualityBypass=false]
 * @param {Function} [args.critiqueDraft]
 * @param {() => Date} [args.now]
 * @param {() => string} [args.uuid]
 */
export async function createContentDocument({
  store,
  user,
  data,
  runEditorialCritique = true,
  forceQualityBypass = false,
  critiqueDraft = nullCritique,
  now = () => new Date(),
  uuid = randomUUID,
}) {
  const requestedType = String(data.type || "").toLowerCase();
  const normalizedType = SUPPORTED_PUBLISH_TARGETS.has(requestedType)
    ? requestedType
    : "blog";

  // Before the dedup read: a bad classification is the caller's mistake and
  // costs no query. A disabled id is refused here even though an existing
  // record may keep one (taxonomy-fields.js) — this record does not exist yet.
  let taxonomyFields;
  try {
    taxonomyFields = await validateTaxonomyFieldsWithStore(store, data);
  } catch (error) {
    if (error instanceof TaxonomyFieldError) {
      return {
        status: 400,
        body: {
          success: false,
          error: authoredMessage(error, "The kind or idea origin was refused."),
        },
      };
    }
    throw error;
  }
  const { kind: _kind, ideaOrigin: _ideaOrigin, ...rest } = data;

  const normalizedData = normalizeContentBodyFields({
    ...rest,
    publishTarget: normalizePublishTarget(data.publishTarget, normalizedType),
    type: normalizedType,
  });

  const sourceUrl =
    normalizedData.sourceUrl ||
    normalizedData.url ||
    normalizedData["CD Url"] ||
    "";
  const duplicate = await findDuplicateContent(store, {
    url: sourceUrl,
    canonicalUrl: normalizedData.canonicalUrl,
    title: normalizedData.Title || normalizedData.title,
    publishedAt:
      normalizedData.publishedAt ||
      normalizedData.publishedDate ||
      normalizedData["Published At"],
  });
  if (duplicate.duplicate) {
    return {
      status: 409,
      body: {
        success: false,
        error: "Duplicate content detected",
        duplicateReason: duplicate.reason,
        existingId: duplicate.existingId,
      },
    };
  }

  const qualityCritique =
    runEditorialCritique === false
      ? null
      : await critiqueDraft({
          title: normalizedData.Title || normalizedData.title || "",
          postContent: getPrimaryContentBody(normalizedData),
        });
  const contentQuality = buildContentQualityReport(
    normalizedData,
    qualityCritique,
  );
  const imageReadiness = buildImageReadinessReport(normalizedData);
  const requestedStatus = normalizedData.contentStatus || "draft";
  const shouldEnforceQuality =
    QUALITY_ENFORCED_STATUSES.includes(requestedStatus);
  if (
    shouldEnforceQuality &&
    !contentQuality.ready &&
    forceQualityBypass !== true
  ) {
    return {
      status: 422,
      body: {
        success: false,
        error: "Content quality gate failed",
        contentQuality,
      },
    };
  }

  const dedupFields = buildDedupFields({
    url: sourceUrl,
    canonicalUrl: normalizedData.canonicalUrl,
    title: normalizedData.Title || normalizedData.title,
  });
  const imageLineage = buildImageLineage(normalizedData);

  const timestamp = now().toISOString();
  const doc = {
    ...normalizedData,
    ...dedupFields,
    // Only when the caller classified it; a null clears nothing on a create.
    ...(taxonomyFields.kind && { kind: taxonomyFields.kind }),
    ...(taxonomyFields.ideaOrigin && { ideaOrigin: taxonomyFields.ideaOrigin }),
    id: uuid(),
    contentStatus: requestedStatus,
    storageCollection: "content",
    contentQuality,
    imageReadiness,
    // Source wrote the readiness report under both names; callers read both.
    imageQuality: imageReadiness,
    imageLineage,
    createdBy: actorName(user),
    "Created At": timestamp,
    updatedAt: timestamp,
  };
  // New doc with a fresh uuid — upsert can never overwrite (matches .add()).
  await store.upsertDoc("content", doc);

  return { status: 200, body: { success: true, contentId: doc.id } };
}

/**
 * @param {object} deps
 * @param {{ requireRole: Function }} deps.guard
 * @param {{ queryDocs: Function, upsertDoc: Function, readDoc?: Function }} deps.store
 *   `readDoc` reads the taxonomy when the body names a kind or idea origin;
 *   without it the defaults apply.
 * @param {Function} [deps.critiqueDraft] async ({title, postContent}) => critique|null
 * @param {() => Date} [deps.now]
 * @param {() => string} [deps.uuid]
 */
export function createContentCreateHandler({
  guard,
  store,
  critiqueDraft = nullCritique,
  now = () => new Date(),
  uuid = randomUUID,
}) {
  return async function createContentItem(request, context) {
    const auth = await guard.requireRole(request, "editor");
    if (auth.error) return auth.error;
    const { user } = auth;

    try {
      const body = await request.json().catch(() => null);
      const data =
        body &&
        typeof body.data === "object" &&
        body.data !== null &&
        !Array.isArray(body.data)
          ? body.data
          : {};

      const result = await createContentDocument({
        store,
        user,
        data,
        runEditorialCritique: body?.runEditorialCritique !== false,
        forceQualityBypass: body?.forceQualityBypass === true,
        critiqueDraft,
        now,
        uuid,
      });
      return json(result.status, result.body);
    } catch (error) {
      return errorResponse(context, "Failed to create content item", error, 500, request);
    }
  };
}
