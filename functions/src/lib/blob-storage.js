/**
 * Azure Blob Storage helpers for Azure Functions.
 *
 * Replaces firebase-admin/storage (Cloud Storage / GCS) with @azure/storage-blob.
 * Provides upload, download, delete, and URL generation for blog covers,
 * cert badges, speaker images, and AI-generated content.
 *
 * Authentication is managed identity via DefaultAzureCredential — the same
 * posture as lib/cosmos-client.js, and the one the infrastructure actually
 * provisions. `infra/main.tf` grants the Function App identity Storage Blob
 * Data Contributor on the media account and sets STORAGE_ACCOUNT_NAME and
 * STORAGE_BLOB_ENDPOINT; it has never set a connection string or an account
 * key, and it must not, because a key in app settings is a key in the portal
 * and in Terraform state.
 *
 * This module previously required STORAGE_CONNECTION_STRING and threw without
 * it, which made every upload and every gallery delete fail on a deployed
 * app — invisibly, because the one test suite covering uploads injected a fake
 * `uploadBlob` and so never reached this file (T-104).
 *
 * Required app settings: STORAGE_BLOB_ENDPOINT (or STORAGE_ACCOUNT_NAME)
 * Required RBAC on the Function App MI: Storage Blob Data Contributor, plus
 * Storage Blob Delegator for `generateSasUrl`.
 *
 * An upload or a delete first calls `refuseWriteAfterJobAbort`
 * (job-context.js): inside a platform job whose budget has run out, one
 * that starts now throws the job's reason instead of reaching Storage
 * (#942). Outside a job it does nothing.
 */

import {
  BlobServiceClient,
  generateBlobSASQueryParameters,
  BlobSASPermissions,
  SASProtocol,
} from '@azure/storage-blob';
import { DefaultAzureCredential, ManagedIdentityCredential } from '@azure/identity';
import { refuseWriteAfterJobAbort } from './job-context.js';

let blobServiceClient = null;

/**
 * Resolve the blob service endpoint from configuration.
 *
 * Split out and exported because it is the part with the rules in it, and it
 * is pure — the house style in this directory is a testable pure core over a
 * thin client-construction shell (see `planPatch` in cosmos-client.js).
 *
 * STORAGE_BLOB_ENDPOINT is what Terraform sets, and it is preferred because it
 * carries the correct suffix for whichever cloud the account lives in.
 * STORAGE_ACCOUNT_NAME is the fallback, and only then is the public-cloud
 * suffix assumed.
 *
 * @param {Record<string, string|undefined>} [env] - defaults to process.env
 * @returns {string} Endpoint with no trailing slash.
 * @throws {Error} When neither setting is present.
 */
export function resolveBlobEndpoint(env = process.env) {
  const endpoint = (env.STORAGE_BLOB_ENDPOINT || '').trim();
  if (endpoint) return endpoint.replace(/\/+$/, '');

  const accountName = (env.STORAGE_ACCOUNT_NAME || '').trim();
  if (accountName) return `https://${accountName}.blob.core.windows.net`;

  throw new Error('Missing STORAGE_BLOB_ENDPOINT (or STORAGE_ACCOUNT_NAME) environment variable');
}

/**
 * Resolve the storage account name, which the user-delegation SAS signature
 * requires separately from the endpoint.
 *
 * @param {Record<string, string|undefined>} [env] - defaults to process.env
 * @returns {string}
 * @throws {Error} When it can be derived from neither setting.
 */
export function resolveAccountName(env = process.env) {
  const accountName = (env.STORAGE_ACCOUNT_NAME || '').trim();
  if (accountName) return accountName;

  const endpoint = (env.STORAGE_BLOB_ENDPOINT || '').trim();
  if (endpoint) {
    const host = new URL(endpoint).hostname;
    const [first] = host.split('.');
    if (first) return first;
  }

  throw new Error('Missing STORAGE_ACCOUNT_NAME environment variable');
}

/**
 * Initialize or return the singleton Blob Service client.
 */
function getBlobService() {
  if (blobServiceClient) return blobServiceClient;

  const credential =
    process.env.WEBSITE_INSTANCE_ID || process.env.IDENTITY_ENDPOINT
      ? new ManagedIdentityCredential()
      : new DefaultAzureCredential();

  blobServiceClient = new BlobServiceClient(resolveBlobEndpoint(), credential);
  return blobServiceClient;
}

/**
 * Drop the memoized client. Tests only — nothing in the request path should
 * need to rebuild it, and the credential is safe to reuse across invocations.
 */
export function resetBlobServiceForTests() {
  blobServiceClient = null;
}

/**
 * Get a container client.
 * @param {string} containerName - e.g. 'blogs', 'covers', 'certifications'
 */
export function getContainerClient(containerName) {
  return getBlobService().getContainerClient(containerName);
}

/**
 * Upload a buffer or stream to Blob Storage.
 * Equivalent to: bucket.file(path).save(buffer, { contentType })
 *
 * @param {string} containerName - Blob container name
 * @param {string} blobName - Blob path (e.g. 'blogId/images/cover.png')
 * @param {Buffer|ReadableStream} content - File content
 * @param {string} contentType - MIME type (e.g. 'image/png')
 * @param {object} [metadata] - Custom metadata key-value pairs
 * @param {object} [options]
 * @param {boolean} [options.overwrite=true] - When false, the upload is
 *   conditioned on `If-None-Match: *` and the service answers 409
 *   `BlobAlreadyExists` rather than replacing an existing blob. Opt-in rather
 *   than the default so the AI-image and migration paths, which rewrite the
 *   same deterministic keys on purpose, keep working unchanged (T-307).
 * @returns {Promise<string>} URL of the uploaded blob
 */
export async function uploadBlob(
  containerName,
  blobName,
  content,
  contentType,
  metadata = {},
  options = {}
) {
  refuseWriteAfterJobAbort();
  const containerClient = getContainerClient(containerName);
  const blockBlobClient = containerClient.getBlockBlobClient(blobName);

  await blockBlobClient.upload(content, Buffer.byteLength(content), {
    blobHTTPHeaders: { blobContentType: contentType },
    metadata,
    ...(options.overwrite === false ? { conditions: { ifNoneMatch: '*' } } : {}),
  });

  return blockBlobClient.url;
}

/**
 * Upload a readable stream to Blob Storage as a block blob.
 * For bodies whose length is not known up front — the Cosmos export's gzip
 * stream (lib/backup/cosmos-export.js) is the first caller.
 *
 * @param {string} containerName
 * @param {string} blobName
 * @param {import('node:stream').Readable} stream
 * @param {number} [bufferSize] - bytes per uploaded block. This is the SDK's
 *   `bufferSize`, not the stream's length: the parameter used to be named
 *   `streamLength`, which is what `uploadStream`'s second positional is NOT.
 *   Nothing called it under the old name. `undefined` takes the SDK default
 *   (8 MiB).
 * @param {string} contentType
 * @param {object} [options]
 * @param {string} [options.tier] - access tier to write at, e.g. 'Cool'
 * @param {Record<string, string>} [options.metadata]
 * @returns {Promise<string>} Blob URL
 */
export async function uploadBlobFromStream(
  containerName,
  blobName,
  stream,
  bufferSize,
  contentType,
  options = {}
) {
  refuseWriteAfterJobAbort();
  const containerClient = getContainerClient(containerName);
  const blockBlobClient = containerClient.getBlockBlobClient(blobName);

  await blockBlobClient.uploadStream(stream, bufferSize, undefined, {
    blobHTTPHeaders: { blobContentType: contentType },
    ...(options.metadata ? { metadata: options.metadata } : {}),
    ...(options.tier ? { tier: options.tier } : {}),
  });

  return blockBlobClient.url;
}

/**
 * Download a blob as a buffer.
 * Equivalent to: bucket.file(path).download()
 *
 * @param {string} containerName
 * @param {string} blobName
 * @returns {Promise<Buffer>}
 */
export async function downloadBlob(containerName, blobName) {
  const containerClient = getContainerClient(containerName);
  const blobClient = containerClient.getBlobClient(blobName);
  const downloadResponse = await blobClient.download(0);

  const chunks = [];
  for await (const chunk of downloadResponse.readableStreamBody) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * Read a blob for HTTP delivery: bytes plus the metadata a response needs.
 *
 * Separate from `downloadBlob` because the delivery path needs the content type
 * and the ETag, and needs a missing blob to be a `null` rather than a throw —
 * a 404 on an image URL is an ordinary outcome, not an error to log.
 *
 * @param {string} containerName
 * @param {string} blobName
 * @returns {Promise<{body: Buffer, contentType: string, etag: string, contentLength: number}|null>}
 */
export async function readBlobForDelivery(containerName, blobName) {
  const containerClient = getContainerClient(containerName);
  const blobClient = containerClient.getBlobClient(blobName);

  let response;
  try {
    response = await blobClient.download(0);
  } catch (error) {
    if (error?.statusCode === 404 || error?.code === 'BlobNotFound') return null;
    throw error;
  }

  const chunks = [];
  for await (const chunk of response.readableStreamBody) {
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks);

  return {
    body,
    contentType: response.contentType || 'application/octet-stream',
    etag: response.etag || '',
    contentLength: body.length,
  };
}

const isNotFound = (error) => error?.statusCode === 404 || error?.code === 'BlobNotFound';

/**
 * Total blob size from a ranged download's `Content-Range` (`bytes 0-99/1000`).
 * Exported for its test; `null` when the header is absent or malformed so a
 * caller never mistakes a parse failure for an empty blob.
 *
 * @param {string|undefined} contentRange
 * @returns {number|null}
 */
export function parseContentRangeTotal(contentRange) {
  const match = /^bytes (?:\d+-\d+|\*)\/(\d+)$/.exec(String(contentRange || '').trim());
  return match ? Number(match[1]) : null;
}

/**
 * Metadata for HTTP delivery without the bytes — what a `HEAD` needs, and what
 * a suffix range (`bytes=-500`) needs before it can be turned into an offset.
 *
 * @param {string} containerName
 * @param {string} blobName
 * @returns {Promise<{contentType: string, etag: string, contentLength: number}|null>}
 */
export async function headBlobForDelivery(containerName, blobName) {
  const containerClient = getContainerClient(containerName);
  const blobClient = containerClient.getBlobClient(blobName);

  let properties;
  try {
    properties = await blobClient.getProperties();
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }

  return {
    contentType: properties.contentType || 'application/octet-stream',
    etag: properties.etag || '',
    contentLength: Number(properties.contentLength) || 0,
  };
}

/**
 * Read one byte range of a blob for HTTP delivery (issue #349).
 *
 * `readBlobForDelivery` buffers the whole blob, which is fine for a badge
 * image and wrong for a nine-minute episode a listener wants to scrub through:
 * a seek is a `Range` request, and answering it with the whole file means the
 * browser downloads everything to reach the last minute. This asks the service
 * for exactly `[start, end]` (inclusive, `end` omitted for "to the end"), so
 * the function reads and returns only the bytes the response carries.
 *
 * The total size comes back on the ranged response's `Content-Range`, so a
 * satisfiable range costs one round trip. An unsatisfiable one — `start` at or
 * past the end — is refused by the service with 416, and the size the 416
 * response needs is fetched then, and only then.
 *
 * @param {string} containerName
 * @param {string} blobName
 * @param {{start: number, end?: number|null}} range - inclusive byte offsets
 * @returns {Promise<
 *   | {body: Buffer, contentType: string, etag: string, start: number, end: number, totalLength: number}
 *   | {unsatisfiable: true, totalLength: number}
 *   | null
 * >}
 */
export async function readBlobRangeForDelivery(containerName, blobName, { start, end = null }) {
  const containerClient = getContainerClient(containerName);
  const blobClient = containerClient.getBlobClient(blobName);
  const count = end === null || end === undefined ? undefined : end - start + 1;

  let response;
  try {
    response = await blobClient.download(start, count);
  } catch (error) {
    if (isNotFound(error)) return null;
    if (error?.statusCode === 416 || error?.code === 'InvalidRange') {
      const head = await headBlobForDelivery(containerName, blobName);
      if (!head) return null;
      return { unsatisfiable: true, totalLength: head.contentLength };
    }
    throw error;
  }

  const chunks = [];
  for await (const chunk of response.readableStreamBody) {
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks);

  // The size normally rides on the ranged response's Content-Range, which is
  // what keeps a seek to one round trip. Without it — absent or malformed —
  // the size is read from the blob's properties on this path only: guessing
  // `start + body.length` under-reports it for any non-zero start, and a
  // wrong Content-Range total is what breaks a client's seeking. The
  // arithmetic survives only as the last resort for a blob that vanished
  // between the two calls.
  let totalLength = parseContentRangeTotal(response.contentRange);
  if (totalLength === null) {
    const head = await headBlobForDelivery(containerName, blobName);
    totalLength = head ? head.contentLength : start + body.length;
  }

  return {
    body,
    contentType: response.contentType || 'application/octet-stream',
    etag: response.etag || '',
    start,
    end: start + body.length - 1,
    totalLength,
  };
}

/**
 * Delete a blob.
 * Equivalent to: bucket.file(path).delete()
 *
 * @param {string} containerName
 * @param {string} blobName
 */
export async function deleteBlob(containerName, blobName) {
  refuseWriteAfterJobAbort();
  const containerClient = getContainerClient(containerName);
  const blobClient = containerClient.getBlobClient(blobName);
  await blobClient.deleteIfExists();
}

/**
 * Get the direct URL of a blob.
 *
 * Whether that URL is anonymously readable depends on the container's access
 * level AND on the account's `allow_nested_items_to_be_public`, which is a
 * master override: with it false, a container declared `container_access_type
 * = "blob"` still answers 409 (T-105). Do not assume this URL is
 * public without checking both.
 *
 * @param {string} containerName
 * @param {string} blobName
 * @returns {string}
 */
export function getBlobUrl(containerName, blobName) {
  return `${resolveBlobEndpoint()}/${containerName}/${blobName}`;
}

/**
 * Generate a time-limited SAS URL for a blob.
 * For blobs in private containers that need temporary access.
 *
 * This is a **user-delegation** SAS, signed with a key obtained from Entra ID
 * using the Function App's managed identity. The previous implementation
 * signed with STORAGE_ACCOUNT_KEY, which nothing provisions and which would
 * have put an account key in app settings if anything did.
 *
 * Requires the Storage Blob Delegator role on the identity, in addition to
 * Storage Blob Data Contributor — Contributor alone cannot mint delegation
 * keys, and the failure is a 403 at signing time, not at read time.
 *
 * Async, unlike the shared-key version it replaces: obtaining the delegation
 * key is a network call.
 *
 * @param {string} containerName
 * @param {string} blobName
 * @param {number} [expiresInMinutes=60] - SAS token expiry
 * @returns {Promise<string>} Blob URL with SAS token
 */
export async function generateSasUrl(containerName, blobName, expiresInMinutes = 60) {
  const accountName = resolveAccountName();
  const service = getBlobService();

  // Backdated a little: the delegation key and the SAS are both rejected if
  // their start time is in the future relative to the service's clock.
  const startsOn = new Date(Date.now() - 5 * 60 * 1000);
  const expiresOn = new Date(Date.now() + expiresInMinutes * 60 * 1000);

  const userDelegationKey = await service.getUserDelegationKey(startsOn, expiresOn);

  const sasToken = generateBlobSASQueryParameters(
    {
      containerName,
      blobName,
      permissions: BlobSASPermissions.parse('r'),
      protocol: SASProtocol.Https,
      startsOn,
      expiresOn,
    },
    userDelegationKey,
    accountName
  ).toString();

  return `${getBlobUrl(containerName, blobName)}?${sasToken}`;
}

/**
 * List blobs in a container with a prefix filter.
 * Equivalent to: bucket.getFiles({ prefix })
 *
 * @param {string} containerName
 * @param {string} [prefix] - Filter blobs by path prefix
 * @returns {Promise<Array<{name: string, url: string, contentType: string, size: number}>>}
 */
export async function listBlobs(containerName, prefix = '') {
  const containerClient = getContainerClient(containerName);
  const blobs = [];

  for await (const blob of containerClient.listBlobsFlat({ prefix })) {
    blobs.push({
      name: blob.name,
      url: getBlobUrl(containerName, blob.name),
      contentType: blob.properties.contentType,
      size: blob.properties.contentLength,
      lastModified: blob.properties.lastModified,
    });
  }

  return blobs;
}
