/**
 * cosmos-export-edges.js — the real Cosmos and Blob edges behind
 * `cosmos-export.js`, built on the same two modules every other feature
 * uses: `cosmos-client.js` (DefaultAzureCredential, Cosmos Built-in Data
 * Contributor) and `blob-storage.js` (DefaultAzureCredential, Storage Blob
 * Data Contributor). No key, no connection string, nothing new to grant.
 *
 * Change feed: `@azure/cosmos` 4.10's pull model
 * (`items.getChangeFeedIterator`) in latest-version mode over the ENTIRE
 * container — no partition key, so the five containers not partitioned on
 * `/id` (cosmos-client.js `PARTITION_KEY_PATHS`) need no special case. The
 * iterator's `hasMoreResults` is always true (a feed is infinite); the loop
 * ends on the 304 the service answers when it is caught up, and the
 * continuation token on that response is the one the next run resumes from.
 */
import { ChangeFeedMode, ChangeFeedStartFrom, StatusCodes } from '@azure/cosmos';

import {
  getContainer as defaultGetContainer,
  getDatabaseContainer as defaultGetDatabaseContainer,
} from '../cosmos-client.js';
import * as defaultStorage from '../blob-storage.js';
import { EXPORT_CONTAINER, EXPORT_STATE_CONTAINER } from './cosmos-export.js';
import { SEPARATE_DATABASE_CONTAINERS, separateDatabaseFor } from './export-classification.js';

/**
 * The container one export job reads: COSMOS_DATABASE's, or for a container
 * in a separate database (the Code Conductor brain's, #1457) that database's.
 * A separate container whose setting is unset is refused, not read from
 * COSMOS_DATABASE: a same-named container there would be the wrong data.
 *
 * @param {string} name
 * @param {object} [deps]
 */
export function exportSourceContainer(
  name,
  {
    env = process.env,
    getContainer = defaultGetContainer,
    getDatabaseContainer = defaultGetDatabaseContainer,
  } = {}
) {
  const database = separateDatabaseFor(name, env);
  if (database === null) return getContainer(name);
  if (database === undefined) {
    throw new Error(
      `${name} lives in its own database and ${SEPARATE_DATABASE_CONTAINERS[name]} is not set`
    );
  }
  return getDatabaseContainer(database, name);
}

/** 4 MiB blocks: the SDK's `uploadStream` buffer size for the gzip body. */
export const UPLOAD_BUFFER_BYTES = 4 * 1024 * 1024;

/**
 * @param {object} [deps]
 * @param {(name: string) => import('@azure/cosmos').Container} [deps.getContainer]
 * @returns {import('./cosmos-export.js').CosmosReader}
 */
export function createCosmosReader({ getContainer = (name) => exportSourceContainer(name) } = {}) {
  return {
    async *queryPages(container, sql, { maxItemCount }) {
      const iterator = getContainer(container).items.query(sql, { maxItemCount });
      while (iterator.hasMoreResults()) {
        const { resources } = await iterator.fetchNext();
        if (resources?.length) yield resources;
      }
    },

    async *changeFeedPages(container, { continuation }, { maxItemCount }) {
      const iterator = getContainer(container).items.getChangeFeedIterator({
        maxItemCount,
        changeFeedMode: ChangeFeedMode.LatestVersion,
        changeFeedStartFrom: continuation
          ? ChangeFeedStartFrom.Continuation(continuation)
          : ChangeFeedStartFrom.Beginning(),
      });
      // Only 304 ends the loop. The pull model legitimately answers an empty
      // 200 page while more changes remain (a feed range with nothing new
      // before the next range is read), so an empty page is not "caught up"
      // — stopping there would skip changes and, worse, store a continuation
      // past them. Every response's token is yielded; the core keeps the
      // last one it saw, which after 304 is the caught-up position.
      while (iterator.hasMoreResults) {
        const response = await iterator.readNext();
        const items = Array.isArray(response.result) ? response.result : [];
        yield { items, continuationToken: response.continuationToken };
        if (response.statusCode === StatusCodes.NotModified) return;
      }
    },

    async changeFeedCheckpoint(container) {
      const iterator = getContainer(container).items.getChangeFeedIterator({
        maxItemCount: 1,
        changeFeedMode: ChangeFeedMode.LatestVersion,
        changeFeedStartFrom: ChangeFeedStartFrom.Now(),
      });
      const response = await iterator.readNext();
      return response.continuationToken;
    },
  };
}

/** `BlobAlreadyExists` from an `If-None-Match: *` upload. */
function isAlreadyExists(error) {
  return error?.statusCode === 409 || error?.code === 'BlobAlreadyExists';
}

/**
 * @param {object} [deps]
 * @param {string} [deps.container]
 * @param {string} [deps.stateContainer]
 * @param {typeof defaultStorage} [deps.storage]
 * @returns {import('./cosmos-export.js').ExportBlobStore}
 */
export function createExportBlobStore({
  container = EXPORT_CONTAINER,
  stateContainer,
  storage = defaultStorage,
} = {}) {
  const effectiveStateContainer =
    stateContainer !== undefined
      ? stateContainer
      : container === EXPORT_CONTAINER
        ? EXPORT_STATE_CONTAINER
        : container;

  function targetContainer(name) {
    if (typeof name === 'string' && name.startsWith('state/')) {
      return effectiveStateContainer;
    }
    return container;
  }

  return {
    async uploadGzipStream(name, stream, { tier, metadata } = {}) {
      await storage.uploadBlobFromStream(
        targetContainer(name),
        name,
        stream,
        UPLOAD_BUFFER_BYTES,
        'application/gzip',
        {
          tier,
          metadata,
        }
      );
    },

    async putJson(name, value, { overwrite = true } = {}) {
      const body = Buffer.from(JSON.stringify(value, null, 2), 'utf8');
      try {
        await storage.uploadBlob(targetContainer(name), name, body, 'application/json', {}, { overwrite });
        return true;
      } catch (error) {
        if (!overwrite && isAlreadyExists(error)) return false;
        throw error;
      }
    },

    async readJson(name) {
      const blob = await storage.readBlobForDelivery(targetContainer(name), name);
      if (!blob) return null;
      return JSON.parse(blob.body.toString('utf8'));
    },

    async listNames(prefix) {
      const blobs = await storage.listBlobs(targetContainer(prefix), prefix);
      return blobs.map((b) => b.name);
    },
  };
}
