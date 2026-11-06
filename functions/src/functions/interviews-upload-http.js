/**
 * interviews-upload-http.js — a guest's recording reaches the private
 * interviews-audio container in 4 MiB blocks through the Function App
 * (ADR 0040 D1, #1565). Three routes, all editor: open a session, put one
 * block, complete. The rules live in lib/interviews/upload.js; this file
 * only wires the production store and storage into them.
 *
 * No queue output: nothing is enqueued here. Transcription is the
 * `interview-transcribe` job the interviews-jobs.js routes start.
 *
 * `deleteBlob` is not optional: completion removes a blob whose size or hash
 * did not match its declaration, and without it a wrong file would stay in
 * the container until the lifecycle rule. interviews-upload-http.test.js
 * pins that it is wired, as podcast-recordings-http.test.js does for its
 * upload.
 */
import { httpRoute, httpRouteByMethod } from '../lib/auth/http-route.js';
import { getDefaultGuard } from '../lib/auth/default-guard.js';
import { patchDoc, queryDocs, readDoc } from '../lib/cosmos-client.js';
import { commitBlockList, deleteBlob, hashBlobSha256, stageBlock } from '../lib/blob-storage.js';
import { createInterviewUploadHandlers } from '../lib/interviews/upload.js';

const handlers = () =>
  createInterviewUploadHandlers({
    guard: getDefaultGuard(),
    store: { readDoc, queryDocs, patchDoc },
    storage: { stageBlock, commitBlockList, hashBlobSha256, deleteBlob },
  });

httpRoute('cmsInterviewUploads', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'cms/interviews/uploads',
  handler: (request, context) => handlers().openUpload(request, context),
});

// One registration per template (httpRouteByMethod): the host keys its route
// table on the template alone. PUT is the only verb today; the helper keeps
// a later GET (a block-list read for a smarter resume) on the same function.
httpRouteByMethod('cmsInterviewUploadBlock', {
  authLevel: 'anonymous',
  route: 'cms/interviews/uploads/{uploadId}/blocks/{index}',
  handlers: {
    PUT: (request, context) => handlers().putBlock(request, context),
  },
});

httpRoute('cmsInterviewUploadComplete', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'cms/interviews/uploads/{uploadId}/complete',
  handler: (request, context) => handlers().completeUpload(request, context),
});
