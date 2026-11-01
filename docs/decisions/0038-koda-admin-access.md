# ADR 0038: Koda's key reaches the admin API through the role guard, for the sections the owner named, creating and reviewing but never deleting or publishing

**Status:** Accepted 2026-11-01 by the owner (the instruction that set the sections and the "no deletion" rule); the route list below is the session's reading of that instruction, for the owner to confirm or trim on the Koda tab
**Decision date:** 2026-11-01
**Owners:** Workload owner and architecture owner

Related: issue [#1477](https://github.com/saulpatinojr/HCW-HybridCloudWorks/issues/1477);
[ADR 0037](0037-agent-content-api.md) (the Agent Content API this amends); the
[Agent Content API runbook](../runbooks/agent-content-api.md), part 7.

## Context

ADR 0037 gave Koda (the owner's content agent, run by Muse) one hashed key and a
small API of its own under `/api/agent-content/v1/`: the Drafts stage and the
published reads, behind five switches. Its guard was deliberately disjoint from
the admin role guard: the key passed nothing that called `requireRole`, so no
`/api/cms/*` route and no workflow function could ever see it.

On 2026-11-01 the owner widened Koda's job: it will be creating content, and it
should have access to the **Pipeline** section (New Content, Drafts, Review
Queue, Editor, Live Pages), the **Enhanced** section (Listen & Learn, Labs,
Frameworks, Coder Corner, Blogs), the **Second Brain** alone in the Creative
section, the **Spotlight** section (Speaking, Certifications, Ambassador, Doc
Vault) and, in the Platform section, **Health and Integrations only**. It may
create, produce and review; it may not delete.

Those sections are served by about a hundred routes, each guarded by the admin
role guard with a required role, most of them `editor`. Copying each behind the
key guard, as ADR 0037 did for the Drafts routes, would have meant a second
registration and a second test for every one, drifting from the first the day
either changed.

## Purpose and decision drivers

- Give Koda every route it needs to create and review content in the named
  sections, and nothing in the sections the owner did not name.
- Keep one implementation per route: the handler the admin uses is the handler
  Koda uses, with the same validation, limits and audit rows.
- Keep the lines ADR 0037 drew where the owner kept them: no deleting, no
  publishing, scheduling or unpublishing, no settings, keys or secrets.
- Keep the owner able to narrow Koda's reach without a deploy, as the five
  switches already do.
- Keep every refusal explainable: a row in `admin_audit_logs` with the reason,
  and content-free: the route as the policy spells it (the template, or
  `unlisted`), never the concrete path, whose segments can be document ids.

## Decision

1. **The admin role guard accepts the key, on an allow-list.** `getDefaultGuard()`
   now returns the role guard wrapped by `withAgentAccess`
   (`functions/src/lib/agent-content/admin-access.js`). A request whose selected
   credential is shaped like a site key takes the key path: the key guard's own
   `authenticate` (hash compare, revocation, the 120-a-minute limit, `lastUsedAt`),
   then the policy table. Any other request takes the role guard's path
   unchanged. `requireUser` refuses a key outright.
2. **The policy is a table of method and route, each under a section switch.**
   `POLICY` lists about a hundred rows, every one a route this Function App registers
   (`admin-access-registry.test.js` holds each row to a registration and its
   methods). Five new switches on the Koda tab, `admin.pipeline`,
   `admin.enhanced`, `admin.brain`, `admin.spotlight` and `admin.platform`, open
   their rows; a switch that is off refuses with 403 and an audit row, like a
   capability. The upload route is under Pipeline and Spotlight both, because
   articles and certifications both carry images.
3. **DELETE is never allowed.** No row has it, and `matchPolicy` refuses the verb
   before looking. The POST routes that delete or trash (`deleteContentItem`,
   `deleteRejectedContent`, `deleteSpeakerEvent`, `softDeleteLivePage`, the
   image deletes) are not listed. `drafts.delete` on the v1 API now starts off.
4. **Publishing stays a human act.** `publishContent`, `saveContentSchedule`,
   `unscheduleContent`, `unpublishContentToInspected`, the slug and rehost
   writes and the podcast publish are not listed. Three routes that could reach
   publishing through their body are allowed with a body rule, read from a
   clone of the request so the handler still gets its body: a
   `transitionContentStatus` may move content to `approved`, `editing`,
   `forge_ready` or `rejected` and never to `published` or `archived`; an
   `enqueueJob` may enqueue `forge-article`, `forge-from-url`, `batch-inspect`,
   `sync-blog-source` or `generate-listen-and-learn` and never
   `publish-content`; a `createContentItem` may not ask, under `data` where
   the handler reads the item, to be born `published` or `archived` or
   `Live`. `updateContentItem` needs no rule: it already refuses the workflow
   fields (`contentStatus`, `Status`, `Live`).
5. **The role each row grants is the least that opens it.** `editor` nearly
   everywhere; `viewer` for the dashboard, queue, publish-board, health and lab
   reads; `publisher` only for the Doc Vault, whose every route, reads included,
   requires it (`lib/doc-vault/model.js`, the owner's request of 2026-10-26). A handler that asks for more than the row grants is
   refused with 403 and reason `role`.
6. **Koda acts as `koda (agent)` everywhere but the Second Brain.** The brain is
   the owner's private workspace, partitioned by the owner's object id and
   guarded by `requireBrainOwner`, so on its routes the key acts as the owner
   (`asOwner`: the owner's `oid` and `tid` from `BRAIN_OWNER_OID` and
   `BRAIN_OWNER_TENANT_ID`, with `actingFor: 'owner'`, `preferred_username:
   'koda (agent)'` and `agent: 'koda'` kept). Notes Koda writes land in the
   owner's partition; the audit rows still name the key. The sync routes, the
   desktop plugin's, and `reindex` are not listed.
7. **Not listed, by the owner's section list:** Forge Studio, AI Engine, Image
   Prompts (including its keyword configuration) and the Image Gallery's
   writes (Creative, other than the brain), the generic config read
   (`cms/config/{collection}`, whose only collections are the AI providers and
   the MCP servers),
   every Amplify route (calendar, newsletters, mailing list, social, Linkie,
   recordings), Platform Settings, secrets, credentials, admins, bootstrap,
   MCP, AI routing and model catalogue, the lab agent registry, the Coder
   token, lab job launches and cancels, and the integration-status and
   probe-results writes. Gallery reads are allowed under Pipeline so an article
   can pick an image.
8. **Every refusal of a presented key is a row**, including the key guard's
   own (wrong, revoked, over the limit), which the wrapper tells the surface
   and the route template before it checks the key, and the user-only
   routes (the sign-in expectations, the current-admin status, the
   bootstrap), which refuse a key with 401 and a `user-only-route` row.
9. **Discovery and the tab.** `GET /api/agent-content/v1/status` and the key
   route both carry `adminAccess`: each section, its switch state and its
   routes with their body limits. The Koda tab shows it as "What Koda may do
   in the admin".

## Consequences and accepted risks

- Koda's writes through the admin routes are attributed as the admin routes
  attribute any editor: `actor()` resolves to `koda (agent)`, `userId` to
  `agent:koda`, `userEmail` to null. In the Second Brain the editor id is the
  owner's, by design; the denial rows and `recordAdminAudit` rows still carry
  the agent name.
- The key is as powerful as an editor on the listed routes. Its limit stays
  120 calls a minute, its revocation immediate, and every row it may call is
  on the tab. The owner narrows it by switch; widening needs a pull request.
- A body rule reads the request twice (clone and handler). The bodies are
  small JSON; the cost is a parse.
- ADR 0037's sentence "the key passes nothing that calls `requireRole`" no
  longer holds; its amendment points here. The route-inventory test still
  knows the key guard by name for the v1 routes, and the admin routes still
  count as guarded through the role guard they always called.

## Alternatives considered

- **Mirror every route under `/api/agent-content/v1/`, as ADR 0037 did for
  Drafts.** Rejected: about a hundred registrations and handler compositions
  to keep in step with the originals, for no gain in safety, since the policy
  table can say the same thing in one place.
- **Give the key an admin record and let it be an editor.** Rejected: an editor
  can delete and an editor's token reaches every editor route; the owner asked
  for less than that, and a record would also let the key through
  `requireUser`.
- **Let Koda publish.** Rejected, as in ADR 0037: publishing is the owner's act
  in the site's own screens. The owner can reverse this with a row in the
  table.

## Validation and revisit triggers

- `admin-access.test.js`: the table lists no DELETE and no publishing, deleting,
  settings, secrets or admin route; matching, the body rules and the
  `asOwner` identity; the wrapper's refusals and their audit rows.
- `admin-access-registry.test.js`: every row names a registered route and a
  method it answers; the publishing, deleting, secrets and admin registrations
  are not listed for a write.
- Revisit when a section is added to the admin, when a route in a listed
  section gains a destructive verb or body, or when the owner wants Koda to
  publish or to reach a section not named here.

## Related decisions and references

- [ADR 0037](0037-agent-content-api.md): the key, the v1 API and the lines kept.
- The Doc Vault's publisher-only rule (`functions/src/lib/doc-vault/model.js`),
  which is why its rows grant `publisher`.
- [Agent Content API runbook](../runbooks/agent-content-api.md), part 7: the
  route list as a table, and how to narrow it.
