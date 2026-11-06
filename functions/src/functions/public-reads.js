/**
 * public-reads.js — anonymous read routes for the public site
 * (api-surface.json rest.publicReads). Registration only; semantics live in
 * lib/public-reads.js. No guard: these replace reads Firestore rules used to
 * allow anonymously, and the lib enforces the public-document filter that
 * those rules provided.
 */
import { httpRoute } from '../lib/auth/http-route.js';
import { queryDocs, readDoc } from '../lib/cosmos-client.js';
import { createPublicReadHandlers } from '../lib/public-reads.js';
import { createPublicPricingHandlers } from '../lib/cloud-tools/public-pricing.js';
import { createPublicPriceChangesHandlers } from '../lib/cloud-tools/public-price-changes.js';

const handlers = () => createPublicReadHandlers({ store: { queryDocs, readDoc } });
const pricing = () => createPublicPricingHandlers({ store: { readDoc } });
const priceChanges = () => createPublicPriceChangesHandlers({ store: { readDoc } });

httpRoute('publicListContent', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'public/content',
  handler: (request, context) => handlers().listContent(request, context),
});

httpRoute('publicGetContent', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'public/content/{slugOrId}',
  handler: (request, context) => handlers().getContent(request, context),
});

// Published interviews (ADR 0040, D6): the list and one by slug, allow-listed
// fields only, never the consent record, the recording's path or the jobs
// that made the page. Read live by /azure/interviews.
httpRoute('publicListInterviews', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'public/interviews',
  handler: (request, context) => handlers().listInterviews(request, context),
});

httpRoute('publicGetInterview', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'public/interviews/{slug}',
  handler: (request, context) => handlers().getInterview(request, context),
});

httpRoute('publicGetSnapshot', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'public/snapshots/{id}',
  handler: (request, context) => handlers().getSnapshot(request, context),
});

httpRoute('publicListPodcasts', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'public/podcasts',
  handler: (request, context) => handlers().listPodcasts(request, context),
});

httpRoute('publicGetFeed', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'public/feed',
  handler: (request, context) => handlers().getFeed(request, context),
});

httpRoute('publicGetListenAndLearn', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'public/listen-and-learn',
  handler: (request, context) => handlers().getListenAndLearn(request, context),
});

// Provider-wide twin of the route above (#349): every approved episode with
// audio, for the podcast page. Same gate, listing projection.
httpRoute('publicListListenAndLearnEpisodes', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'public/listen-and-learn/episodes',
  handler: (request, context) => handlers().listListenAndLearnEpisodes(request, context),
});

// Certification lifecycle events the Friday Skills Hub scraper writes to
// certEvents (#461 item 4). Anonymous, platform validated against the known
// provider list, projected to a listing allowlist, newest first, capped.
httpRoute('publicListCertEvents', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'public/cert-events',
  handler: (request, context) => handlers().listCertEvents(request, context),
});

httpRoute('publicGetCuratedImage', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'public/curated-image/{id}',
  handler: (request, context) => handlers().getCuratedImage(request, context),
});

// Batched twin of the route above (T-739). Same disclosure rules, one round
// trip for a whole grid instead of one per card.
httpRoute('publicGetCuratedImages', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'public/curated-images',
  handler: (request, context) => handlers().getCuratedImages(request, context),
});

// The pricing comparison's cache, one point read per region (#613). Reports
// staleness and never refreshes — lib/cloud-tools/public-pricing.js says why
// the handler is in its own module.
httpRoute('publicGetCloudToolsPricing', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'public/cloud-tools/pricing',
  handler: (request, context) => pricing().getPricing(request, context),
});

// The price-change feed the same refresh derives from its daily snapshots
// (#613 Phase 3): one point read of price-changes:<region>, empty windows
// before the second day of history exists — lib/cloud-tools/public-price-changes.js.
httpRoute('publicGetCloudToolsPriceChanges', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'public/cloud-tools/price-changes',
  handler: (request, context) => priceChanges().getPriceChanges(request, context),
});
