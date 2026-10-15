/**
 * The Published tab as a filtered embed of the shared Calendar (ADR 0033 §2).
 * What must hold: it reads newsletter items only, opening one shows the
 * email in an empty sandbox with its metrics, a scheduled issue can be
 * canceled (after confirming) and rescheduled, a failed one retried, any one
 * duplicated, and Resend's refusal is shown in its own words.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

import NewsletterPublished from './NewsletterPublished';

const getJSON = vi.fn();
const postJSON = vi.fn();
vi.mock('@/lib/api', () => ({
  getJSON: (...args) => getJSON(...args),
  postJSON: (...args) => postJSON(...args),
}));
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('react-router', async () => {
  const React_ = await vi.importActual('react');
  return { Link: ({ to, children }) => React_.createElement('a', { href: to }, children) };
});

const TODAY = new Date(2026, 9, 3, 12);
const SCHEDULED = 'issue-2026-10-06';
const FAILED = 'issue-2026-09-29';

const items = [
  {
    id: `newsletter:${SCHEDULED}`,
    kind: 'newsletter',
    title: 'Identity',
    start: new Date(2026, 9, 6, 9).toISOString(),
    allDay: false,
    status: 'scheduled',
    href: '',
    sourceId: SCHEDULED,
    sourceCollection: 'newsletters',
    meta: {},
  },
  {
    id: `newsletter:${FAILED}`,
    kind: 'newsletter',
    title: 'Networking',
    start: new Date(2026, 9, 1, 9).toISOString(),
    allDay: false,
    status: 'failed',
    href: '',
    sourceId: FAILED,
    sourceCollection: 'newsletters',
    meta: {},
  },
];

const detailFor = (id, over = {}) => ({
  ok: true,
  issue: {
    id,
    status: id === FAILED ? 'failed' : 'scheduled',
    subject: id === FAILED ? 'Networking' : 'Identity',
    scheduledAt: '2026-10-06T14:00:00.000Z',
    lastError: id === FAILED ? 'Resend no longer has broadcast bc-1' : null,
    broadcastId: 'bc-1',
    etag: 'e1',
    ...over,
  },
  preview: { html: `<p>${id}</p>` },
});

beforeEach(() => {
  getJSON.mockReset();
  postJSON.mockReset();
  getJSON.mockImplementation(async (route) => {
    if (route.startsWith('cms/calendar?')) return { ok: true, items, warnings: [] };
    return detailFor(route.split('/').pop());
  });
});

const openIssue = async (title) => {
  render(<NewsletterPublished today={TODAY} />);
  fireEvent.click(await screen.findByRole('button', { name: new RegExp(`Newsletter: ${title}`) }));
  return screen.findByTitle('Published newsletter');
};

describe('NewsletterPublished', () => {
  it('reads newsletter items only and opens an issue to its email in an empty sandbox', async () => {
    const frame = await openIssue('Identity');
    expect(frame.getAttribute('sandbox')).toBe('');
    expect(frame.getAttribute('srcdoc')).toBe(`<p>${SCHEDULED}</p>`);
    expect(getJSON.mock.calls.some(([route]) => /kinds=newsletter$/.test(route))).toBe(true);
    expect(screen.getByText('Metrics appear after it sends.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Cancel send/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Reschedule/ })).toBeInTheDocument();
  });

  it('opens the issue a deep link names without a click', async () => {
    render(<NewsletterPublished today={TODAY} initialIssueId={SCHEDULED} />);
    expect(await screen.findByTitle('Published newsletter')).toBeInTheDocument();
  });

  it('cancels only after confirming, with the etag, and says where the issue went', async () => {
    postJSON.mockResolvedValue(
      detailFor(SCHEDULED, { status: 'draft', scheduledAt: null, broadcastId: null })
    );
    await openIssue('Identity');
    fireEvent.click(screen.getByRole('button', { name: /Cancel send/ }));
    expect(postJSON).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel the send' }));
    await waitFor(() =>
      expect(postJSON).toHaveBeenCalledWith(`cms/newsletters/${SCHEDULED}/cancel`, { etag: 'e1' })
    );
    expect(await screen.findByText(/The send is canceled/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open Drafts' })).toHaveAttribute(
      'href',
      '/admin/newsletter-hub?tab=drafts'
    );
  });

  it("shows Resend's refusal word for word when a cancel is refused", async () => {
    postJSON.mockRejectedValue(
      Object.assign(
        new Error(
          'Resend did not cancel the broadcast: HTTP 403 restricted_api_key: Scheduled broadcasts cannot be deleted on this plan'
        ),
        { status: 502 }
      )
    );
    await openIssue('Identity');
    fireEvent.click(screen.getByRole('button', { name: /Cancel send/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel the send' }));
    expect(await screen.findByText(/cannot be deleted on this plan/)).toBeInTheDocument();
  });

  it('reschedules to the time picked, refusing the past first', async () => {
    postJSON.mockResolvedValue(detailFor(SCHEDULED, { scheduledAt: '2099-10-07T14:00:00.000Z' }));
    await openIssue('Identity');
    fireEvent.click(screen.getByRole('button', { name: /Reschedule/ }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/Sends at/), {
      target: { value: '2020-01-01T09:00' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/at least a minute ahead/);
    expect(postJSON).not.toHaveBeenCalled();
    fireEvent.change(within(dialog).getByLabelText(/Sends at/), {
      target: { value: '2099-10-07T09:00' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Move' }));
    await waitFor(() =>
      expect(postJSON).toHaveBeenCalledWith(`cms/newsletters/${SCHEDULED}/reschedule`, {
        etag: 'e1',
        scheduledAt: new Date(2099, 9, 7, 9).toISOString(),
      })
    );
    expect(await screen.findByText(/Moved — it now sends/)).toBeInTheDocument();
  });

  it('a failed issue shows its reason and retries as a draft; any issue duplicates', async () => {
    postJSON.mockImplementation(async (route) =>
      route.endsWith('/duplicate')
        ? { ok: true, issue: { id: 'issue-2026-10-03', status: 'draft' } }
        : detailFor(FAILED, { status: 'draft', lastError: 'Resend no longer has broadcast bc-1' })
    );
    await openIssue('Networking');
    expect(screen.getByRole('alert')).toHaveTextContent(/no longer has broadcast/);
    fireEvent.click(screen.getByRole('button', { name: /Retry as a draft/ }));
    await waitFor(() =>
      expect(postJSON).toHaveBeenCalledWith(`cms/newsletters/${FAILED}/retry`, { etag: 'e1' })
    );
    expect(await screen.findByText(/Back in Drafts as a draft/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Duplicate/ }));
    await waitFor(() =>
      expect(postJSON).toHaveBeenCalledWith(`cms/newsletters/${FAILED}/duplicate`, {})
    );
    expect(await screen.findByText(/Duplicated as issue-2026-10-03/)).toBeInTheDocument();
  });

  it('Check Resend now asks the server to reconcile every scheduled issue', async () => {
    postJSON.mockResolvedValue({ ok: true, reconciled: 2, changed: [SCHEDULED], warnings: [] });
    render(<NewsletterPublished today={TODAY} />);
    fireEvent.click(await screen.findByRole('button', { name: /Check Resend now/ }));
    await waitFor(() => expect(postJSON).toHaveBeenCalledWith('cms/newsletter-reconcile', {}));
    expect(
      await screen.findByText(/Checked 2 scheduled issue\(s\); 1 changed/)
    ).toBeInTheDocument();
  });
});
