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

import { getContainer as defaultGetContainer } from '../cosmos-client.js';
import * as defaultStorage from '../blob-storage.js';
import { EXPORT_CONTAINER, EXPORT_STATE_CONTAINER } from './cosmos-export.js';

/** 4 MiB blocks: the SDK's `uploadStream` buffer size for the gzip body. */
export const UPLOAD_BUFFER_BYTES = 4 * 1024 * 1024;

/**
 * @param {object} [deps]
 * @param {(name: string) => import('@azure/cosmos').Container} [deps.getContainer]
 * @returns {import('./cosmos-export.js').CosmosReader}
 */
export function createCosmosReader({ getContainer = defaultGetContainer } = {}) {
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

/**
 * Did storage refuse a conditional write because its condition did not hold?
 * For "create only" (`If-None-Match: *`) that means the blob already exists.
 * Storage answers either 409 `BlobAlreadyExists` or 412 `ConditionNotMet`,
 * depending on the operation
 * (https://learn.microsoft.com/rest/api/storageservices/specifying-conditional-headers-for-blob-service-operations),
 * so both are read as the same answer.
 */
function isAlreadyExists(error) {
  return (
    error?.statusCode === 409 ||
    error?.statusCode === 412 ||
    error?.code === 'BlobAlreadyExists' ||
    error?.code === 'ConditionNotMet'
  );
}

/** Did storage answer that the blob is not there? */
function isNotFound(error) {
  return error?.statusCode === 404 || error?.code === 'BlobNotFound';
}

/**
 * Where `state/...` files go: the given state container, else the export
 * state container when the store is the export container, else the store's
 * own container.
 */
function stateContainerFor(container, stateContainer) {
  if (stateContainer !== undefined) return stateContainer;
  return container === EXPORT_CONTAINER ? EXPORT_STATE_CONTAINER : container;
}

/**
 * The checks behind setTier: only a data file of a yearly archive, and only
 * to the Archive tier (see setTier below for why).
 */
function assertArchiveTierMove(name, tier) {
  if (typeof name !== 'string' || !/^\d{4}\/cosmos\/[A-Za-z0-9_]+\.ndjson\.gz$/.test(name)) {
    throw new Error('only a data file of a yearly archive can change tier here');
  }
  if (tier !== 'Archive') throw new Error('a data file of a yearly archive can only be moved to the Archive tier here');
}

/** The check behind deleteReportFile (see it below for why). */
function assertReportFile(name) {
  if (typeof name !== 'string' || !name.startsWith('state/archive-report/') || name.includes('..')) {
    throw new Error('only a file of an archive dry-run report can be deleted here');
  }
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
  const effectiveStateContainer = stateContainerFor(container, stateContainer);

  function targetContainer(name) {
    if (typeof name === 'string' && name.startsWith('state/')) {
      return effectiveStateContainer;
    }
    return container;
  }

  return {
    /**
     * Upload a gzip stream. With `conditions` the write is conditional (see
     * blob-storage.js uploadBlobFromStream) and the answer is `false` when
     * storage refused it because the condition did not hold; without, it is
     * always `true` or a throw.
     */
    async uploadGzipStream(name, stream, { tier, metadata, conditions } = {}) {
      try {
        await storage.uploadBlobFromStream(
          targetContainer(name),
          name,
          stream,
          'application/gzip',
          {
            bufferSize: UPLOAD_BUFFER_BYTES,
            tier,
            metadata,
            ...(conditions ? { conditions } : {}),
          }
        );
        return true;
      } catch (error) {
        if (conditions && isAlreadyExists(error)) return false;
        throw error;
      }
    },

    async putJson(name, value, { overwrite = true } = {}) {
      const body = Buffer.from(JSON.stringify(value, null, 2), 'utf8');
      try {
        await storage.uploadBlob(targetContainer(name), name, body, 'application/json', { overwrite });
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

    /**
     * A blob's bytes as a stream, or null when it is not there. For the
     * archive dry run (archive-report.js), which reads a backup file a piece
     * at a time and so never holds a whole container in memory.
     */
    async readGzipStream(name) {
      try {
        const blob = await storage.downloadBlobStream(targetContainer(name), name);
        return blob.stream;
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },

    async listNames(prefix) {
      const blobs = await storage.listBlobs(targetContainer(prefix), prefix);
      return blobs.map((b) => b.name);
    },

    /**
     * Name, size in bytes, access tier and version stamp (ETag) of every
     * file under a prefix. For the yearly archive (archive-job.js), which
     * checks that each data file is there, in the very version it checked,
     * before the manifest names it, and which files are already in the
     * Archive tier.
     */
    async listDetails(prefix) {
      const blobs = await storage.listBlobs(targetContainer(prefix), prefix);
      return blobs.map((b) => ({ name: b.name, size: Number(b.size) || 0, tier: b.tier ?? null, etag: b.etag ?? null }));
    },

    /**
     * Move one data file of a yearly archive to the Archive tier. Only a
     * name shaped exactly like `<year>/cosmos/<file>.ndjson.gz` is accepted,
     * so this can never be pointed at a backup file, a bookmark or a
     * manifest (the manifest stays online on purpose: ADR 0046 section 4).
     * Only the tier 'Archive' is accepted: nothing here ever brings a file
     * back online, which costs money and is the owner's to do.
     */
    async setTier(name, tier) {
      assertArchiveTierMove(name, tier);
      await storage.setBlobAccessTier(container, name, tier);
    },

    /** Does the store's main container exist? A failure to ask is a throw, never `false`. */
    async containerExists() {
      return storage.containerExists(container);
    },

    /**
     * Delete one file of an old archive dry-run report. Only a name under
     * `state/archive-report/` is accepted: this store also holds the backup
     * and its bookmarks, and nothing here may ever delete one of those.
     */
    async deleteReportFile(name) {
      assertReportFile(name);
      await storage.deleteBlob(targetContainer(name), name);
    },
  };
}
