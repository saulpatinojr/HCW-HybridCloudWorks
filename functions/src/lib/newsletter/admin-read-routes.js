/**
 * admin-read-routes.js — the newsletter routes that read issues, copy one,
 * ask Resend where scheduled ones stand, and read or set the From address
 * (admin-handlers.js builds the routes).
 */
import { LIST_LIMIT, SUMMARY_PROJECTION, monthWindow, PUBLISHED_LIMIT, reconcileOverdueRows, summarise, resolveSender } from './admin-issue-store.js';
import { json, errorMeta, notFound, resendNotConfigured } from './admin-responses.js';
import { reconcileForRead } from './admin-patch.js';
import { reconcileIssues } from './reconcile.js';
import { NEWSLETTER_SENDER_CONFIG_ID, presentSender } from './sender.js';
import { ADMIN_CONFIG_PARTITION } from '../cosmos-client.js';
import { parseSenderBody } from './validate.js';

// ── Reads, copies and the sender ───────────────────────────────────────────

/** The list's rows: the month's published issues, or the latest kept ones. */
export async function listRows(store, month) {
  if (!month) {
    return store.queryDocs(
      'newsletters',
      `SELECT TOP ${LIST_LIMIT} ${SUMMARY_PROJECTION}, c.broadcastId, c._etag FROM c WHERE c.kind = 'weekly_issue' AND c.status != 'deleted' ORDER BY c.createdAt DESC`,
      []
    );
  }
  // Published: what went out, or will, in that month.
  const { from, to } = monthWindow(month);
  return store.queryDocs(
    'newsletters',
    `SELECT TOP ${PUBLISHED_LIMIT} ${SUMMARY_PROJECTION}, c.broadcastId, c._etag FROM c WHERE c.kind = 'weekly_issue' AND ((c.status = 'sent' AND c.sentAt >= @from AND c.sentAt < @to) OR ((c.status = 'scheduled' OR c.status = 'failed') AND c.scheduledAt >= @from AND c.scheduledAt < @to)) ORDER BY c.createdAt DESC`,
    [
      { name: '@from', value: from },
      { name: '@to', value: to },
    ]
  );
}

export async function list(ctx, request, context) {
  const auth = await ctx.guard.requireRole(request, 'editor');
  if (auth.error) return auth.error;
  const month = request.query?.get?.('month') ?? null;
  if (month !== null && !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    return json(400, { ok: false, error: 'month must be YYYY-MM' });
  }
  try {
    const rows = await listRows(ctx.store, month);
    // Scheduled issues whose time has passed: ask Resend before answering,
    // so the list never shows a send as pending after it went (ADR 0033).
    const reconciled = await reconcileOverdueRows(ctx, rows || [], context);
    return json(200, {
      ok: true,
      issues: reconciled.rows.map(summarise),
      ...(reconciled.warnings.length ? { reconcileWarnings: reconciled.warnings } : {}),
    });
  } catch (error) {
    context.error?.(`listNewsletters failed: ${errorMeta(error)}`);
    return json(500, {
      ok: false,
      error: 'Failed to list newsletter issues',
    });
  }
}

export async function get(ctx, request, context) {
  const auth = await ctx.guard.requireRole(request, 'editor');
  if (auth.error) return auth.error;
  try {
    const stored = await ctx.readIssue(request);
    if (!stored) return notFound();
    const { issue, reconcileWarning } = await reconcileForRead(ctx, stored, context);
    return json(200, {
      ...(await ctx.present(issue, await ctx.readSettings(), context)),
      ...(reconcileWarning ? { reconcileWarning } : {}),
    });
  } catch (error) {
    context.error?.(`getNewsletter failed: ${errorMeta(error)}`);
    return json(500, {
      ok: false,
      error: 'Failed to read the newsletter issue',
    });
  }
}

/** Today's issue id, or a suffixed one when today's is taken (a deleted one may be reused). */
export async function freeIssueId(store, day) {
  let id = `issue-${day}`;
  for (let n = 2; n < 100; n += 1) {
    const taken = await store.readDoc('newsletters', id, id);
    if (!taken || taken.status === 'deleted') break;
    id = `issue-${day}-${n}`;
  }
  return id;
}

/** The kept draft a duplicate writes: the source's content under a new id. */
export function duplicateDoc(source, id, stamp, auth) {
  return {
    id,
    kind: 'weekly_issue',
    version: 1,
    status: 'draft',
    periodStart: source.periodStart ?? null,
    periodEnd: source.periodEnd ?? null,
    subject: source.subject ?? '',
    preheader: source.preheader ?? '',
    intro: source.intro ?? '',
    introError: null,
    customNote: source.customNote ?? '',
    sections: source.sections ?? [],
    itemCount: source.itemCount ?? 0,
    problems: [],
    duplicatedFrom: source.id,
    savedAt: stamp,
    savedBy: auth.user?.oid || auth.user?.sub || null,
    createdAt: stamp,
    updatedAt: stamp,
  };
}

/**
 * A new kept draft with this issue's subject, preview text, note, intro
 * and sections, under today's id (or a suffixed one when today's is taken).
 * Nothing about the source changes.
 */
export async function duplicate(ctx, request, context) {
  const { store } = ctx;
  const auth = await ctx.guard.requireRole(request, 'editor');
  if (auth.error) return auth.error;
  try {
    const source = await ctx.readIssue(request);
    if (!source) return notFound();
    const at = ctx.now();
    const id = await freeIssueId(store, at.toISOString().slice(0, 10));
    const doc = duplicateDoc(source, id, at.toISOString(), auth);
    await store.upsertDoc('newsletters', doc);
    const stored = (await store.readDoc('newsletters', id, id)) ?? doc;
    return json(200, await ctx.present(stored, await ctx.readSettings(), context));
  } catch (error) {
    context.error?.(`duplicateNewsletter failed: ${errorMeta(error)}`);
    return json(500, {
      ok: false,
      error: 'Failed to duplicate the newsletter issue',
    });
  }
}

/** Ask Resend where every scheduled issue stands, now, and write what it says. */
export async function reconcile(ctx, request, context) {
  const { store } = ctx;
  const auth = await ctx.guard.requireRole(request, 'editor');
  if (auth.error) return auth.error;
  const client = ctx.clientOrNull();
  if (!client) return resendNotConfigured();
  try {
    const rows = await store.queryDocs(
      'newsletters',
      `SELECT TOP ${PUBLISHED_LIMIT} * FROM c WHERE c.kind = 'weekly_issue' AND (c.status = 'scheduled' OR c.status = 'sending') AND IS_DEFINED(c.broadcastId)`,
      []
    );
    const outcome = await reconcileIssues({
      store,
      client,
      issues: rows || [],
      now: ctx.now,
      all: true,
      limit: PUBLISHED_LIMIT,
      log: context,
    });
    return json(200, { ok: true, ...outcome });
  } catch (error) {
    context.error?.(`reconcileNewsletters failed: ${errorMeta(error)}`);
    return json(500, {
      ok: false,
      error: 'Failed to reconcile newsletter issues with Resend',
    });
  }
}

/** GET /api/cms/newsletter-sender — the From address, and whether it is the default. */
export async function getSender(ctx, request, context) {
  const auth = await ctx.guard.requireRole(request, 'editor');
  if (auth.error) return auth.error;
  try {
    const doc = await ctx.store.readDoc(
      'admin_config',
      NEWSLETTER_SENDER_CONFIG_ID,
      ADMIN_CONFIG_PARTITION
    );
    return json(200, { ok: true, ...presentSender(doc) });
  } catch (error) {
    context.error?.(`getNewsletterSender failed: ${errorMeta(error)}`);
    return json(500, {
      ok: false,
      error: 'Failed to read the newsletter sender',
    });
  }
}

/**
 * PUT /api/cms/newsletter-sender { from } — publisher. An empty `from`
 * returns to the default. Any other address must parse and sit on a
 * sending domain: the default's, or one Resend lists as verified.
 */
export async function putSender(ctx, request, context) {
  const auth = await ctx.guard.requireRole(request, 'publisher');
  if (auth.error) return auth.error;
  const requested = parseSenderBody(await request.json().catch(() => null));
  if (requested.error) return json(400, { ok: false, error: requested.error });
  try {
    const resolved = await resolveSender(requested.from, ctx.clientOrNull());
    if (resolved.error) return resolved.error;
    const doc = {
      id: NEWSLETTER_SENDER_CONFIG_ID,
      configScope: ADMIN_CONFIG_PARTITION,
      from: resolved.from,
      updatedAt: ctx.now().toISOString(),
      updatedBy: auth.user?.oid || auth.user?.sub || null,
    };
    await ctx.store.upsertDoc('admin_config', doc);
    return json(200, { ok: true, ...presentSender(doc) });
  } catch (error) {
    context.error?.(`putNewsletterSender failed: ${errorMeta(error)}`);
    return json(500, {
      ok: false,
      error: 'Failed to save the newsletter sender',
    });
  }
}

