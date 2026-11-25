/**
 * publer-sync.js — `syncSocialCalendarScheduled`, every 5 minutes: reconcile
 * `social_posts` with Publer's scheduled/published/failed posts.
 *
 * Ported from Site-Main `cms/social.js` `reconcilePublerCalendar` and its
 * helpers (088f458). Three outcomes per run: a social post that matches a
 * Publer post (by `publerPostIds` or `publerJobId`) takes Publer's state; a
 * post that once had Publer ids but no longer matches anything is marked
 * deleted (unless Publer itself created it); a Publer post nothing matches
 * becomes `social_posts/publer_<id>`, unlinked from the calendar.
 *
 * This is D12's live writer: on Site-Main it runs every five minutes, so the
 * cutover delta import happens with it paused there and this flag still off
 * here (Migration-Plan §6). The API key and workspace id come from app
 * settings (Key Vault references); a missing key skips the run.
 *
 * So does a REJECTED one (#358). A 401 or 403 from Publer is a configuration
 * state — the key is stale, revoked, or valid for another workspace — not a
 * transient fault, and a timer that throws on it every five minutes turns
 * one fact into 288 exceptions a day that no alert reads. Measured on
 * 2026-09-09: 429 failed invocations in 36 hours, 0 successes. The run now
 * skips with one warning naming the pair, and the client reports the verdict
 * to the API-keys page through `lib/key-verdict.js`, the same path the AI
 * router uses — the red light `secrets-health.js` says only the upstream
 * service can switch on. A 500 or a timeout still throws: those ARE transient,
 * and a failed invocation is the right record of them.
 *
 * WHAT THE API ACTUALLY LOOKS LIKE (#463, read against Publer's own docs on
 * 2026-09-09 — every one of these was wrong here, and none could be caught by
 * a test because the 401 had kept the code paths dark since the port):
 *
 *   - `GET /posts` takes `state[]` as an array, so the three reconciled states
 *     travel in ONE request rather than three loops. `per_page` is a field of
 *     the response, not a parameter of the request; sending it did nothing.
 *   - The rate limit is **100 requests per two minutes per user account,
 *     across every API key it holds** — shared with the owner's browser and
 *     the admin pages, which is why paging stops early on
 *     `X-RateLimit-Remaining` rather than spending the whole window here.
 *   - Deleting is `DELETE /posts?post_ids[]=…`, answering `{ deleted_ids }`.
 *     `DELETE /posts/{id}` was invented. Omitting `post_ids` deletes every
 *     non-published post in the workspace, so the empty list is refused before
 *     the request rather than sent.
 *   - Errors arrive as `{ "errors": [...] }`, and that sentence is the whole
 *     difference between a malformed header and a revoked key. It is now on
 *     the thrown message and on the key verdict.
 *
 * PUBLER'S DOCUMENTED 401/403 SEMANTICS ARE BACKWARDS, and believing them cost
 * #358 two days. The documentation says 401 is a missing, invalid, revoked or
 * expired key and that a bad workspace id or a missing scope is 403. MEASURED
 * against the live API on 2026-09-09, with a working key and a deliberately
 * wrong value in each position:
 *
 *   correct key + correct workspace     -> 200
 *   correct key + WRONG workspace id    -> 401 "You don't have access on this
 *                                          workspace"
 *   WRONG key + correct workspace       -> 403 "Invalid API key or not active
 *                                          for this account."
 *
 * So **401 blames the workspace id and 403 blames the key**, the opposite way
 * round. This client used to report both against `PUBLER_API_KEY`, so a wrong
 * workspace id turned the KEY red on the API-keys page and the owner reminted
 * a perfectly good key, repeatedly, for two days. `publerSettingForStatus`
 * below is that fix, and it is written from the measurement rather than from
 * the documentation for exactly the reason above.
 *
 * Two more things the same measurement settled, both of which had been
 * proposed as causes and neither of which is one: a key with the `Bearer-API `
 * scheme already baked into the value still answers **200** (Publer tolerates
 * the doubled prefix), and a key carrying a zero-width character never reaches
 * Publer at all -- `fetch` throws `Cannot convert argument to a ByteString`
 * while building the header, which is a crash and not a 401.
 */
import { isCredentialRejected } from '../key-verdict.js';
import { publerSettingForStatus } from './publer-client.js';
import { buildSocialPostSyncPatch, findSocialPostForPublerPost, publerStateToSocialStatus } from './publer-posts.js';

// The API client lives in publer-client.js and the pure post helpers in
// publer-posts.js; they are exported again here so callers keep importing
// from publer-sync.js.
export { createPublerClient, PUBLER_API_BASE_URL, publerSettingForStatus } from './publer-client.js';
export {
  buildSocialPostSyncPatch,
  extractPublerList,
  findSocialPostForPublerPost,
  normalizePublerPost,
  publerStateToSocialStatus,
} from './publer-posts.js';

/**
 * The run's answer when Publer rejected the credential. Names the setting
 * the status actually blames. The old message named both and left the
 * operator to guess, which in practice meant reminting the key when the
 * workspace id was wrong (#358).
 *
 * The gloss is derived from the SAME function as the setting name, not
 * from a second comparison of `error.status`. A strict `=== 401` here
 * disagreed with `publerSettingForStatus`, which coerces with `Number`,
 * so a string status would have named PUBLER_WORKSPACE_ID and then
 * explained it as "a 403 is the key" in the same sentence (Copilot
 * review of a0c1ca3e). A warning that contradicts itself is worse than
 * the bare status it replaced.
 */
function credentialRejected(log, status) {
  const blamed = publerSettingForStatus(status);
  const gloss = blamed === 'PUBLER_WORKSPACE_ID' ? 'a 401 is the workspace id' : 'a 403 is the key';
  log.warn?.(
    `[syncSocialCalendar] Publer rejected the credential (HTTP ${status}); ` +
      `check ${blamed} (${gloss}) — skipping until it is fixed`
  );
  return {
    skipped: true,
    reason: 'credential_rejected',
    status,
    fetched: 0,
    updated: 0,
    created: 0,
  };
}

/** Whether a Publer post belongs to the social post `item` by its job id. */
const sameJob = (item, post) => post.jobId && String(item.publerJobId || '') === String(post.jobId);

/**
 * Sync one social post with the Publer post(s) it matches, or mark it
 * deleted when it once had Publer ids and now matches nothing (unless
 * Publer itself created it). True when the post was patched.
 */
async function reconcileItem(r, item) {
  const ids = Array.isArray(item.publerPostIds) ? item.publerPostIds.map(String) : [];
  const matchingPost = ids.map((id) => r.publerById.get(id)).find(Boolean) || r.publerPosts.find((post) => sameJob(item, post));
  if (matchingPost) {
    r.matchedIds.add(String(matchingPost.id));
    const relatedPosts = r.publerPosts.filter((post) => sameJob(item, post) || ids.includes(String(post.id)));
    relatedPosts.forEach((post) => r.matchedIds.add(String(post.id)));
    await r.store.patchDoc(
      'social_posts',
      item.id,
      buildSocialPostSyncPatch(matchingPost, item, relatedPosts.length ? relatedPosts : [matchingPost], r.stamp)
    );
    return true;
  }
  if (ids.length === 0 || item.syncOrigin === 'publer' || item.status === 'deleted') return false;
  await r.store.patchDoc('social_posts', item.id, {
    publerStatus: 'deleted',
    status: 'deleted',
    syncStatus: 'synced',
    syncOrigin: 'publer',
    lastSyncedAt: r.stamp,
  });
  return true;
}

/** A Publer post nothing matches, as a new social post unlinked from the calendar. */
function unlinkedSocialPost(post, stamp) {
  return {
    id: `publer_${post.id}`,
    caption: post.text || '',
    url: post.url || null,
    accountIds: post.accountId ? [post.accountId] : [],
    platforms: post.network ? [post.network] : [],
    scheduledAt: post.scheduledAt,
    publerPostIds: [post.id],
    publerJobId: post.jobId,
    publerStatus: post.state,
    status: publerStateToSocialStatus(post.state),
    source: 'publer',
    unlinkedFromCalendar: true,
    syncStatus: 'synced',
    syncOrigin: 'publer',
    createdAt: stamp,
    lastSyncedAt: stamp,
  };
}

/** Sync the social posts with Publer's list: patch the matched, create the unmatched. */
async function reconcile({ store, now, log }, publerPosts) {
  const socialPosts = await store.queryDocs('social_posts', 'SELECT TOP 500 * FROM c', []);
  const r = {
    store,
    publerPosts,
    publerById: new Map(publerPosts.map((post) => [String(post.id), post])),
    matchedIds: new Set(),
    stamp: now().toISOString(),
  };
  let updated = 0;
  let created = 0;
  for (const item of socialPosts || []) {
    if (await reconcileItem(r, item)) updated += 1;
  }
  for (const post of publerPosts) {
    if (r.matchedIds.has(String(post.id)) || findSocialPostForPublerPost(socialPosts || [], post)) continue;
    await store.upsertDoc('social_posts', unlinkedSocialPost(post, r.stamp));
    created += 1;
  }
  log.log?.(
    `[syncSocialCalendar] fetched=${publerPosts.length} updated=${updated} created=${created}`
  );
  return { skipped: false, fetched: publerPosts.length, updated, created };
}

async function run(d) {
  const { client, log } = d;
  if (!client.configured) {
    log.warn?.(
      '[syncSocialCalendar] PUBLER_API_KEY / PUBLER_WORKSPACE_ID not configured; skipping'
    );
    return { skipped: true, reason: 'not_configured', fetched: 0, updated: 0, created: 0 };
  }
  // Publer first, then Cosmos — no longer in parallel. The list is the gate:
  // a rejected credential fails on its first page, and there is nothing to
  // reconcile 500 social posts against when it does. Only Publer's own
  // status is read here; a Cosmos error carries `code`, not `status`, and
  // still throws as it always did.
  let publerPosts;
  try {
    publerPosts = await client.listPostsForSync();
  } catch (error) {
    if (!isCredentialRejected(error?.status)) throw error;
    return credentialRejected(log, error.status);
  }
  return reconcile(d, publerPosts);
}

export function createPublerReconcile({ store, client, now = () => new Date(), log = {} }) {
  const d = { store, client, now, log };
  return { run: () => run(d) };
}
