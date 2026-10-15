/**
 * certifications.js — the certification routes of the admin CRUD surface
 * (CertificationsPage.jsx): list ALL docs (the page filters/sorts client-side
 * on display_order), create stamps _createdAt/_updatedAt, edits are PARTIAL
 * patches stamping _updatedAt — the page's patchCert() sends single-field
 * toggles, so a whole-doc replace would drop everything else. Every route
 * sits behind the editor role guard.
 *
 * Each handler body is a module-level function over `ctx` (guard, store,
 * storage, now, uuid); the factory at the bottom only wires them.
 */
import { json, listAllHandler, validBody } from '../http/admin-handler.js';
import { recordMutationAudit } from '../audit.js';
import {
  checkNewCertification,
  isCertImagePath,
  validateCertification,
} from './certification-rules.js';

/** POST /api/cms/certifications — create; name is the page's one required field. */
async function createCertification(ctx, request, context) {
  const auth = await ctx.guard.requireRole(request, 'editor');
  if (auth.error) return auth.error;
  try {
    const checked = checkNewCertification(validBody(await request.json().catch(() => null)));
    if (checked.error) return json(400, { error: checked.error });

    const nowIso = ctx.now().toISOString();
    const doc = {
      ...checked.value,
      id: ctx.uuid(), // never client-chosen — matches addDoc semantics
      _createdAt: nowIso,
      _updatedAt: nowIso,
    };
    await ctx.store.upsertDoc('certifications', doc);
    await recordMutationAudit(ctx.store, {
      action: 'certification_created',
      actor: auth.user,
      resource: `certifications:${doc.id}`,
      before: null,
      after: doc,
      now: ctx.now,
      uuid: ctx.uuid,
      context,
    });
    return json(200, { success: true, id: doc.id, item: doc });
  } catch (error) {
    context.error('createCertification failed:', error);
    return json(500, { error: 'Failed to create certification' });
  }
}

/**
 * Route id, body and stored document of a PATCH, checked in that order:
 * `{ id, value }` or `{ error }` holding the response that refuses it.
 */
async function prepareCertificationPatch(store, request) {
  const id = String(request.params.id || '').trim();
  if (!id) return { error: json(400, { error: 'id required' }) };
  const body = validBody(await request.json().catch(() => null));
  if (!body || Object.keys(body).length === 0) {
    return { error: json(400, { error: 'Body must be a non-empty JSON object' }) };
  }
  const existing = await store.readDoc('certifications', id, id);
  if (!existing) return { error: json(404, { error: `certification ${id} not found` }) };
  const checked = validateCertification(body, existing);
  return checked.error
    ? { error: json(400, { error: checked.error }) }
    : { id, value: checked.value, existing };
}

/** PATCH /api/cms/certifications/{id} — partial update, stamps _updatedAt. */
async function patchCertification(ctx, request, context) {
  const auth = await ctx.guard.requireRole(request, 'editor');
  if (auth.error) return auth.error;
  try {
    const prepared = await prepareCertificationPatch(ctx.store, request);
    if (prepared.error) return prepared.error;
    const updated = await ctx.store.patchDoc('certifications', prepared.id, {
      ...prepared.value,
      _updatedAt: ctx.now().toISOString(),
    });
    await recordMutationAudit(ctx.store, {
      action: 'certification_updated',
      actor: auth.user,
      resource: `certifications:${prepared.id}`,
      before: prepared.existing,
      after: updated,
      now: ctx.now,
      uuid: ctx.uuid,
      context,
    });
    return json(200, { success: true, item: updated });
  } catch (error) {
    context.error('patchCertification failed:', error);
    return json(500, { error: 'Failed to update certification' });
  }
}

/** Delete an abandoned badge upload: only at a cert image path, never one a stored certification still references. */
async function deleteCertImage({ store, storage }, path) {
  if (!isCertImagePath(path)) {
    return json(400, { error: 'path must be a certification image path ({docId}/images/…)' });
  }
  const referencing = await store.queryDocs(
    'certifications',
    'SELECT TOP 1 c.id FROM c WHERE CONTAINS(c.imageUrl, @path)',
    [{ name: '@path', value: path }]
  );
  if (referencing.length > 0) {
    return json(409, { error: 'A stored certification still references this image' });
  }
  await storage.deleteBlob('certifications', path);
  return json(200, { success: true, path });
}

/**
 * DELETE /api/cms/certifications/images — body `{ path }`. The editor's
 * cancel path: a badge uploaded and then abandoned would otherwise sit
 * in the container until the nightly cleanup's seven-day rule (ADR 0033,
 * Spotlight slice). Only `{docId}/images/…` paths, and never a blob a
 * stored certification still references.
 */
async function deleteCertificationImage(ctx, request, context) {
  const auth = await ctx.guard.requireRole(request, 'editor');
  if (auth.error) return auth.error;
  try {
    if (!ctx.storage?.deleteBlob) return json(503, { error: 'Blob storage is not configured' });
    const body = validBody(await request.json().catch(() => null));
    const path = String(body?.path || '').trim();
    const res = await deleteCertImage(ctx, path);
    if (res.status === 200) {
      await recordMutationAudit(ctx.store, {
        action: 'certification_image_deleted',
        actor: auth.user,
        resource: `certifications:image:${path}`,
        details: { path },
        now: ctx.now,
        uuid: ctx.uuid,
        context,
      });
    }
    return res;
  } catch (error) {
    context.error('deleteCertificationImage failed:', error);
    return json(500, { error: 'Failed to delete certification image' });
  }
}

/** DELETE /api/cms/certifications/{id} */
async function deleteCertification(ctx, request, context) {
  const auth = await ctx.guard.requireRole(request, 'editor');
  if (auth.error) return auth.error;
  try {
    const id = String(request.params.id || '').trim();
    if (!id) return json(400, { error: 'id required' });
    const existing = await ctx.store.readDoc('certifications', id, id).catch(() => null);
    await ctx.store.deleteDoc('certifications', id);
    await recordMutationAudit(ctx.store, {
      action: 'certification_deleted',
      actor: auth.user,
      resource: `certifications:${id}`,
      before: existing,
      after: null,
      now: ctx.now,
      uuid: ctx.uuid,
      context,
    });
    return json(200, { success: true });
  } catch (error) {
    context.error('deleteCertification failed:', error);
    return json(500, { error: 'Failed to delete certification' });
  }
}

/**
 * @param {{ guard: object, store: object, storage: object|null, now: () => Date, uuid: () => string }} ctx
 */
export function createCertificationHandlers(ctx) {
  return {
    /** GET /api/cms/certifications — all docs; the page sorts client-side. */
    listCertifications: listAllHandler(ctx, {
      container: 'certifications',
      name: 'listCertifications',
      failure: 'Failed to list certifications',
    }),
    createCertification: (request, context) => createCertification(ctx, request, context),
    patchCertification: (request, context) => patchCertification(ctx, request, context),
    deleteCertificationImage: (request, context) => deleteCertificationImage(ctx, request, context),
    deleteCertification: (request, context) => deleteCertification(ctx, request, context),
  };
}
