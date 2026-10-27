import { httpRouteByMethod } from '../lib/auth/http-route.js';
import { getDefaultGuard } from '../lib/auth/default-guard.js';
import {
  queryDocs,
  readDoc,
  createDoc,
  replaceDocIfMatch,
  upsertDoc,
} from '../lib/cosmos-client.js';
import { createBlogSourceHandlers } from '../lib/rss/source-handlers.js';
const handlers = () =>
  createBlogSourceHandlers({
    guard: getDefaultGuard(),
    store: { queryDocs, readDoc, createDoc, replaceDocIfMatch, upsertDoc },
  });
httpRouteByMethod('cmsBlogSources', {
  authLevel: 'anonymous',
  route: 'cms/blog-sources',
  handlers: {
    GET: (request, context) => handlers().list(request, context),
    POST: (request, context) => handlers().save(request, context),
  },
});
httpRouteByMethod('cmsBlogSource', {
  authLevel: 'anonymous',
  route: 'cms/blog-sources/{id}',
  handlers: {
    PUT: (request, context) => handlers().save(request, context),
  },
});
