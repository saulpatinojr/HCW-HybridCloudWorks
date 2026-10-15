/** The Pipeline hub's probes (ADR 0033 §1 Platform, §8): feeds, inspection, scheduling, links, covers. */
import {
  ALERTS,
  GALLERY,
  LIVE_PAGES,
  QUEUE,
  liveProbe,
  sessionProbe,
  snapshotProbe,
} from '../probeKit';
import {
  evaluateLinkRot,
  evaluatePublishingFailures,
  evaluateQueueSla,
  evaluateScheduledPublishing,
  smokeEvaluator,
} from '../probeEvaluators';
import { runBrokenRelationships } from '../probeRunners';

/** A pipeline smoke test: it writes real data, so it runs from its own card only. */
const smokeProbe = (actionId, entry) =>
  sessionProbe({
    hub: 'pipeline',
    safe: false,
    evaluate: smokeEvaluator(actionId, 'Not run in this session.'),
    run: (ctx) => ctx.actions.runSmoke(actionId),
    ...entry,
  });

export const PIPELINE_PROBES = [
  smokeProbe('rss', {
    id: 'rss-fetch',
    label: 'RSS fetch job',
    covers: 'Pulls every feed and creates new content candidates.',
    impact: 'Without it the Review Queue stops receiving new items.',
    action:
      'Run it from the Pipeline Smoke Tests card below; a failed feed is named in the result.',
    href: QUEUE,
    costNote: 'Writes real content documents, so it runs from its own button only.',
  }),
  smokeProbe('inspect', {
    id: 'batch-inspect',
    label: 'Batch inspect job',
    covers: 'Runs the inspector on up to ten ingested items.',
    impact: 'Items without metadata reach review unexplained.',
    action: 'Run it below; a model refusal shows on the AI providers probe too.',
    href: QUEUE,
    costNote: 'Spends model calls and writes inspection results.',
  }),
  smokeProbe('digest', {
    id: 'reviewer-digest',
    label: 'Reviewer digest',
    covers: 'Builds the reviewer summary from queued and recent RSS entries.',
    impact: 'The Overview digest row and the Telegram summary go stale.',
    action: 'Run it below; an indexing error names the Cosmos indexing policy.',
    href: ALERTS,
    costNote: 'Writes a digest document.',
  }),
  snapshotProbe({
    id: 'scheduled-publishing',
    label: 'Scheduled publishing',
    hub: 'pipeline',
    covers: 'The 15-minute scheduler that publishes due items, and its 6-hour watchdog.',
    impact: 'Scheduled items stay unpublished and overdue.',
    action: 'Open Alerts for the failure; the Publish page lists what is due.',
    href: { to: '/admin/publish', label: 'Publish' },
    evaluate: evaluateScheduledPublishing,
  }),
  snapshotProbe({
    id: 'publishing-failures',
    label: 'Publishing failures',
    hub: 'pipeline',
    covers: 'Open scheduled_publish_failures alerts.',
    impact: 'Each one is a scheduled item that did not go live.',
    action: 'Resolve the alert once the item is republished.',
    href: ALERTS,
    evaluate: evaluatePublishingFailures,
  }),
  snapshotProbe({
    id: 'queue-sla',
    label: 'Review queue age',
    hub: 'pipeline',
    covers: 'Items waiting in review for more than 24 hours, and the oldest staged item.',
    impact: 'Content ages before anyone sees it.',
    action: 'Work the Review Queue oldest first.',
    href: QUEUE,
    evaluate: evaluateQueueSla,
  }),
  snapshotProbe({
    id: 'link-rot',
    label: 'Live page links',
    hub: 'pipeline',
    covers: 'The weekly link-rot check over every live page and its source URL.',
    impact: 'Visitors meet 404s on pages this site still links to.',
    action: 'Fix or unpublish the broken pages listed in the detail.',
    href: LIVE_PAGES,
    evaluate: evaluateLinkRot,
  }),
  liveProbe({
    id: 'broken-relationships',
    label: 'Cover images of published items',
    hub: 'pipeline',
    covers: 'Whether the cover image URLs of the 20 newest published items answer.',
    impact: 'Published pages render a broken image.',
    action: 'Regenerate or replace the cover from the Editor.',
    href: GALLERY,
    run: runBrokenRelationships,
  }),
];
