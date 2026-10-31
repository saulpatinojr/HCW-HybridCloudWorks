/**
 * The Code Conductor brain's HTTP handlers (#1457, ADR 0036).
 *
 * The same authored-record and sync mechanics as the creator Second Brain
 * (lib/brain/repository.js and lib/brain/workspace.js), with a smaller
 * surface: status, list, read, save, history, and the desktop sync. There is
 * no search index, no creator reference, no draft, no linked-research context
 * and no AI call here, because this workspace holds engineering notes and
 * never touches the creator site's content.
 *
 * Every route needs the code_brain_sync scope, the configured owner and the
 * configured desktop client. An ordinary admin token (access_as_admin) and a
 * creator sync token (brain_sync) both fail the scope check before anything
 * is read.
 */
import { fail, clean, readJson, ID, TYPES } from '../brain/model.js';
import { requireWorkspaceOwner } from '../brain/guard.js';
import {
  privateRoute,
  summary,
  prepareWrite,
  listPage,
  historyPage,
  syncStatusRecord,
  safeNumber,
  queryOf,
} from '../brain/workspace.js';
import { codeBrainConfig } from './config.js';

export const CODE_BRAIN_PROTOCOL = 1;

export function createCodeBrainHandlers({
  syncGuard,
  repo,
  env = process.env,
  log = console,
}) {
  const route = (work) =>
    privateRoute(work, {
      authorize: (request) =>
        requireWorkspaceOwner(syncGuard, request, codeBrainConfig(env), true),
      failure:
        'Could not complete the Code Conductor brain action. Your saved work is unchanged.',
      log,
    });
  const write = async (body) => {
    const item = await prepareWrite(repo, body);
    const saved = await repo.commit(item, {
      version: body.version,
      mutationId: body.mutationId,
    });
    return { item: saved };
  };
  const readItem = async (id) => {
    if (!ID.test(id || '')) fail(400, 'INVALID', 'Invalid item id.');
    const item = await repo.read(id);
    if (!item || !TYPES.includes(item.type))
      fail(404, 'NOT_FOUND', 'Item no longer available.');
    return item;
  };

  return {
    status: route(async () => {
      const config = codeBrainConfig(env);
      return {
        enabled: true,
        workspace: 'code-conductor',
        sync: clean(await repo.read('sync-status')),
        syncClientId: config.syncClientId,
        tenantId: config.ownerTenantId,
        audience: env.ENTRA_API_AUDIENCE,
        protocol: CODE_BRAIN_PROTOCOL,
      };
    }),
    list: route((request) => listPage(repo, request)),
    get: route(async (request) => {
      const item = await readItem(request.params.id);
      return {
        item: clean(item),
        backlinks: (await repo.backlinks(item.id)).map(summary),
      };
    }),
    history: route(async (request) => {
      await readItem(request.params.id);
      return historyPage(repo, request.params.id, request);
    }),
    syncPull: route(async (request) => {
      const cursor = safeNumber(
        queryOf(request).get('cursor'),
        0,
        Number.MAX_SAFE_INTEGER,
      );
      return {
        ...(await repo.changes(cursor)),
        protocol: CODE_BRAIN_PROTOCOL,
      };
    }),
    syncPush: route(async (request) => ({
      ...(await write(await readJson(request))),
      protocol: CODE_BRAIN_PROTOCOL,
    })),
    syncStatus: route(async (request) => {
      await repo.putInternal(syncStatusRecord(await readJson(request)));
      return { ok: true, protocol: CODE_BRAIN_PROTOCOL };
    }),
  };
}
