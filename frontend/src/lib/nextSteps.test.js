/**
 * The next step after a piece goes live (#1886): every Page that may send
 * work into the Pipeline (the server's ORIGIN_PAGES) has one here, or is
 * named in NO_NEXT_STEP with its reason, and the link is the record link the
 * "sent from" chip uses.
 */
import { describe, it, expect } from 'vitest';
import { ORIGIN_PAGE_IDS } from '../../../functions/src/lib/page-links/origin-pages.js';
import { ORIGIN_RECORD_PATHS } from './pageLinks';
import { NEXT_STEPS, NO_NEXT_STEP, nextStepFor } from './nextSteps';

const live = (page, id) => ({
  id: 'c1',
  Live: true,
  contentStatus: 'published',
  originRef: { page, id, part: null, label: 'Example' },
});

describe('the next-step list', () => {
  it('covers every Page that sends work, or says why one has none', () => {
    for (const page of ORIGIN_PAGE_IDS) {
      const listed = Object.hasOwn(NEXT_STEPS, page);
      const excused = Object.hasOwn(NO_NEXT_STEP, page);
      expect(listed || excused, `${page} has no next step and no reason`).toBe(true);
      if (excused) expect(String(NO_NEXT_STEP[page]).trim(), page).not.toBe('');
    }
  });

  it('names only Pages that send work', () => {
    for (const page of [...Object.keys(NEXT_STEPS), ...Object.keys(NO_NEXT_STEP)]) {
      expect(ORIGIN_PAGE_IDS, page).toContain(page);
    }
  });

  it('gives each step words and a tooltip', () => {
    for (const [page, step] of Object.entries(NEXT_STEPS)) {
      expect(step.label.trim(), page).not.toBe('');
      expect(step.hint.trim(), page).not.toBe('');
    }
  });
});

describe('nextStepFor', () => {
  it('links a live Ambassador piece to its program', () => {
    const ref = { page: 'ambassador', id: 'program-example' };
    const step = nextStepFor(live(ref.page, ref.id));
    expect(step).toMatchObject({ page: 'ambassador', label: 'Open the program' });
    expect(step.href).toBe(ORIGIN_RECORD_PATHS.ambassador(ref));
  });

  it.each([
    ['speaking', 'talk-example'],
    ['certifications', 'cert-example'],
  ])('offers nothing for a live %s piece, whose chip already links back', (page, id) => {
    expect(nextStepFor(live(page, id))).toBeNull();
  });

  it('opens the program details for an Ambassador piece, where filing happens', () => {
    expect(nextStepFor(live('ambassador', 'program-example')).href).toBe(
      '/admin/ambassador?tab=programs&program=program-example'
    );
  });

  it('offers nothing before a piece is live', () => {
    const item = {
      ...live('ambassador', 'program-example'),
      Live: false,
      contentStatus: 'approved',
    };
    expect(nextStepFor(item)).toBeNull();
  });

  it('offers nothing for a deleted piece', () => {
    const item = {
      ...live('ambassador', 'program-example'),
      softDeletedAt: '2026-11-20T00:00:00.000Z',
    };
    expect(nextStepFor(item)).toBeNull();
  });

  it('offers nothing for a piece no Page sent, or a Page this build does not know', () => {
    expect(nextStepFor({ Live: true })).toBeNull();
    expect(nextStepFor(live('not-a-page', 'x'))).toBeNull();
    expect(nextStepFor(null)).toBeNull();
  });
});
