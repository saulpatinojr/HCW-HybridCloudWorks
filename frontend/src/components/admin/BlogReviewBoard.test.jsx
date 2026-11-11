/**
 * The review board's provider picker. A post the classifier filed under no
 * known provider cannot be sent to the publish queue until one is chosen, so
 * every provider an article can be published under has to be offered here.
 * Docker, VMware and Ansible were not until 2026-10-03, which left their
 * articles stuck on the board although each provider has a blog route.
 */
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const postJSON = vi.fn();
vi.mock('@/lib/api', () => ({
  postJSON: (...args) => postJSON(...args),
  // The cover card asks which prompt set a cover would use (ADR 0033);
  // answered empty here so the board renders without that lookup.
  getJSON: async () => ({}),
}));
vi.mock('@/lib/auditLog', () => ({ logAdminAction: vi.fn() }));
vi.mock('@/lib/contentWorkflow', () => ({
  unpublishToInspected: vi.fn(),
  requestContentInspection: vi.fn(),
  saveContentSchedule: vi.fn(),
  resetContentReviewState: vi.fn(),
}));
vi.mock('@/components/admin/ImageOrderManager', () => ({ ImageOrderManager: () => null }));
vi.mock('@/components/admin/ImageGalleryPicker', () => ({ ImageGalleryPicker: () => null }));

import { PROVIDER_LABELS } from '@/config/admin';
import { CANONICAL_PROVIDERS } from '@/lib/providers';
import BlogReviewBoard from './BlogReviewBoard';

const renderBoard = (blog) =>
  render(
    <MemoryRouter>
      <BlogReviewBoard blog={{ id: 'c1', Title: 'Compose Basics', ...blog }} blogId="c1" />
    </MemoryRouter>
  );

beforeEach(() => {
  postJSON.mockReset();
  postJSON.mockResolvedValue({ success: true });
});

describe('BlogReviewBoard provider picker', () => {
  it('offers Docker while the post has no provider, and holds the publish queue until one is set', () => {
    renderBoard({ contentStatus: 'inspected' });
    expect(screen.getByRole('button', { name: 'Docker' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send to Publish Queue' })).toBeDisabled();
  });

  it('offers a button for every provider the site routes', () => {
    // Derived from the registry, so a provider added to CANONICAL_PROVIDERS
    // and missing from the board fails here (Docker, VMware and Ansible all
    // were until 2026-10-03).
    renderBoard({ contentStatus: 'inspected' });
    for (const provider of CANONICAL_PROVIDERS) {
      expect(
        screen.getByRole('button', { name: PROVIDER_LABELS[provider] }),
        provider
      ).toBeInTheDocument();
    }
    expect(screen.getByRole('button', { name: 'VMware' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ansible' })).toBeInTheDocument();
  });

  it('files the post under Docker, the value the server stores', async () => {
    renderBoard({ contentStatus: 'inspected' });
    fireEvent.click(screen.getByRole('button', { name: 'Docker' }));
    await waitFor(() => expect(postJSON).toHaveBeenCalledTimes(1));
    expect(postJSON).toHaveBeenCalledWith('updateContentItem', {
      contentId: 'c1',
      updates: { cloudProvider: 'Docker', 'Cloud Provider': 'Docker' },
    });
  });

  it('lets a Docker post go to the publish queue', () => {
    renderBoard({
      contentStatus: 'inspected',
      'Cloud Provider': 'Docker',
      cloudProvider: 'Docker',
    });
    expect(screen.getByRole('button', { name: 'Send to Publish Queue' })).toBeEnabled();
  });
});

describe('BlogReviewBoard address topic (#1628)', () => {
  it('shows the stored topic, and saves "Pick automatically" as null', async () => {
    renderBoard({ contentStatus: 'inspected', topic: 'hybrid' });
    const select = await screen.findByLabelText('Address topic');
    await waitFor(() => expect(select).toHaveValue('hybrid'));
    expect(screen.getByText(/Sets the first word of the page address/)).toBeInTheDocument();

    fireEvent.change(select, { target: { value: '' } });
    await waitFor(() => expect(postJSON).toHaveBeenCalledTimes(1));
    expect(postJSON).toHaveBeenCalledWith('updateContentItem', {
      contentId: 'c1',
      updates: { topic: null },
    });
    expect(select).toHaveValue('');
  });

  it('saves a chosen topic word as it is', async () => {
    renderBoard({ contentStatus: 'inspected' });
    const select = screen.getByLabelText('Address topic');
    expect(select).toHaveValue('');
    fireEvent.change(select, { target: { value: 'security' } });
    await waitFor(() =>
      expect(postJSON).toHaveBeenCalledWith('updateContentItem', {
        contentId: 'c1',
        updates: { topic: 'security' },
      })
    );
  });

  it('shows the save failure instead of swallowing it', async () => {
    postJSON.mockRejectedValue(new Error('Topic not saved.'));
    renderBoard({ contentStatus: 'inspected' });
    fireEvent.change(screen.getByLabelText('Address topic'), { target: { value: 'data' } });
    expect(await screen.findByText(/Topic not saved\./)).toBeInTheDocument();
  });

  it('is not offered for an interview, whose address keeps its title', () => {
    renderBoard({ contentStatus: 'inspected', type: 'interview' });
    expect(screen.queryByLabelText('Address topic')).not.toBeInTheDocument();
  });
});
