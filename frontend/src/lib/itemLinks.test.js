/**
 * Where an admin item opens (#1013, #1014), and the contract with the API's
 * copy: functions/src/lib/decision-center/links.js builds the same links for
 * the Decision Center, so for every status the two must agree, and every
 * deep link it builds must name a tab and a parameter the page reads.
 */
import { describe, expect, it } from 'vitest';
import {
  CONTENT_STAGE_PATHS,
  LINK_PARAMS,
  contentItemHref,
  decisionHref,
  isAdminPath,
} from './itemLinks';
import { CONTENT_STATUS, contentStatusInfo } from './status';
import { statusParamFor } from '@/components/admin/TypedReviewList';
import { TABS as RECORDING_TABS } from '@/components/admin/recording-hub/tabs';
import { TABS as HEALTH_TABS } from '@/pages/admin/health/tabs';
import { TABS as LISTEN_TABS } from '@/components/admin/listen-and-learn/tabs';
import { TABS as AMBASSADOR_TABS } from '@/components/admin/ambassador/tabs';
import { TABS as SOCIAL_TABS } from '@/components/admin/social/tabs';
import { TABS as FORGE_TABS } from '@/components/admin/forge-studio/tabs';
import * as api from '../../../functions/src/lib/decision-center/links.js';
import { REVIEW_DECISION_STATUSES } from '../../../functions/src/lib/cms/content-status.js';

describe('contentItemHref — one place maps a stage to its page', () => {
  it('opens each stage where it is worked', () => {
    expect(contentItemHref({ id: 'a', contentStatus: 'ingested' })).toBe(
      '/admin/review-queue/a?source=content'
    );
    expect(contentItemHref({ id: 'a', contentStatus: 'in_review' })).toBe(
      '/admin/review-queue/a?source=content'
    );
    expect(contentItemHref({ id: 'a', contentStatus: 'approved' })).toBe('/admin/editor/a');
    expect(contentItemHref({ id: 'a', contentStatus: 'needs_rework' })).toBe('/admin/editor/a');
    expect(contentItemHref({ id: 'a', contentStatus: 'drafting' })).toBe('/admin/drafts');
    expect(contentItemHref({ id: 'a', contentStatus: 'approved', Live: true })).toBe(
      '/admin/review-queue/a?source=content'
    );
    expect(contentItemHref({ id: 'a/b', contentStatus: 'editing' })).toBe('/admin/editor/a%2Fb');
  });

  it('has a page for every stage lib/status.js names', () => {
    const stages = new Set(Object.values(CONTENT_STATUS).map((row) => row.stage));
    stages.add('live');
    for (const stage of stages) expect(CONTENT_STAGE_PATHS, stage).toHaveProperty(stage);
  });

  it('agrees with the API for every status, live or not, and every legacy spelling', () => {
    const statuses = [
      ...Object.keys(CONTENT_STATUS),
      'approved_blog',
      'published_both',
      'ready_to_publish',
      'never-heard-of-it',
    ];
    for (const contentStatus of statuses) {
      for (const Live of [false, true]) {
        const item = { id: 'x1', contentStatus, Live };
        const label = `${contentStatus} Live=${Live}`;
        expect(api.contentStage(item), label).toBe(contentStatusInfo(item).stage);
        expect(api.contentHref(item), label).toBe(contentItemHref(item));
      }
    }
  });
});

describe('decisionHref', () => {
  it('builds a content item’s link from its status, whatever the API sent', () => {
    const item = {
      status: 'approved',
      href: '/admin/review-queue/c1?source=content',
      source: { collection: 'content', id: 'c1', Live: false },
    };
    expect(decisionHref(item)).toBe('/admin/editor/c1');
  });

  it('keeps another kind’s link only while it stays inside the admin', () => {
    const at = (href) => decisionHref({ href, source: { collection: 'workflow_alerts' } });
    expect(at('/admin/health?tab=alerts&alert=a1')).toBe('/admin/health?tab=alerts&alert=a1');
    expect(at('/admin')).toBe('/admin');
    expect(at('https://evil.example/admin')).toBe('/admin');
    expect(at('//evil.example/admin')).toBe('/admin');
    expect(at('javascript:alert(1)')).toBe('/admin');
    expect(at('/administrator')).toBe('/admin');
    expect(at(undefined)).toBe('/admin');
    expect(isAdminPath('/admin/review-queue\\x')).toBe(false);
  });
});

/** The tab and the parameters a link opens with. */
const parse = (href) => {
  const url = new URL(href, 'https://site.test');
  return { path: url.pathname, tab: url.searchParams.get('tab'), params: url.searchParams };
};
const ids = (tabs) => tabs.map((tab) => tab.id);

describe('the API’s deep links name a tab and a parameter each page reads', () => {
  it('transcript → Recording Hub, Transcripts', () => {
    const { path, tab, params } = parse(api.transcriptHref('t 1'));
    expect(path).toBe('/admin/recording-hub');
    expect(ids(RECORDING_TABS)).toContain(tab);
    expect(params.get(LINK_PARAMS.transcript)).toBe('t 1');
  });

  it('alert → Health Hub, Alerts; unresolved secrets → Overview', () => {
    const { path, tab, params } = parse(api.alertHref('a1'));
    expect(path).toBe('/admin/health');
    expect(tab).toBe('alerts');
    expect(ids(HEALTH_TABS)).toContain(tab);
    expect(params.get(LINK_PARAMS.alert)).toBe('a1');
    expect(ids(HEALTH_TABS)).toContain(parse(api.UNRESOLVED_SECRETS_HREF).tab);
  });

  it('issue → Newsletter Hub, on the tab it waits on', () => {
    for (const view of ['newsletter', 'drafts']) {
      const { path, tab, params } = parse(api.newsletterIssueHref('issue-1', view));
      expect(path).toBe('/admin/newsletter-hub');
      expect(tab).toBe(view);
      expect(params.get(LINK_PARAMS.issue)).toBe('issue-1');
    }
  });

  it('reminder → Platform Settings, Reminders', () => {
    const { path, tab, params } = parse(api.reminderHref('r1'));
    expect(path).toBe('/admin/platform-settings');
    expect(tab).toBe('reminders');
    expect(params.get(LINK_PARAMS.reminder)).toBe('r1');
  });

  it('chapter → Listen & Learn, Review, with its book', () => {
    const href = api.chapterHref({ provider: 'azure', examCode: 'AZ-104', id: 'storage' });
    const { path, tab, params } = parse(href);
    expect(path).toBe('/admin/listen-and-learn');
    expect(ids(LISTEN_TABS)).toContain(tab);
    expect(params.get(LINK_PARAMS.platform)).toBe('azure');
    expect(params.get(LINK_PARAMS.exam)).toBe('AZ-104');
    expect(params.get(LINK_PARAMS.chapter)).toBe('storage');
  });

  it('application → Ambassador Hub, Applications', () => {
    const { path, tab, params } = parse(api.ambassadorHref('app1'));
    expect(path).toBe('/admin/ambassador');
    expect(ids(AMBASSADOR_TABS)).toContain(tab);
    expect(params.get(LINK_PARAMS.application)).toBe('app1');
  });

  it('social and the Forge Studio Queue open real tabs', () => {
    expect(ids(SOCIAL_TABS)).toContain(parse(api.socialComposeHref('c1')).tab);
    expect(parse(api.socialComposeHref('c1')).params.get('contentId')).toBe('c1');
    expect(ids(SOCIAL_TABS)).toContain(parse(api.SOCIAL_QUEUE_HREF).tab);
    expect(ids(FORGE_TABS)).toContain(parse(api.FORGE_QUEUE_HREF).tab);
  });
});

describe('the review set agrees everywhere it is listed', () => {
  it('Frameworks and Coder Corner ask for the statuses the queue and the counters use', () => {
    expect(statusParamFor('needs_review')).toBe(REVIEW_DECISION_STATUSES.join(','));
    for (const status of REVIEW_DECISION_STATUSES) {
      expect(CONTENT_STATUS[status].stage, status).toBe('review');
    }
  });
});
