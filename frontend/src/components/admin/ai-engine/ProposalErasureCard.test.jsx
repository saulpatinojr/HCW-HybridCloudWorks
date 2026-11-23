/**
 * The erasure card on the Developer API tab (ProposalErasureCard.jsx, #1777):
 * the search by address, the list it draws (event, status and date only), the
 * confirmed delete, and the controls an editor sees gated.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { AdminRoleProvider } from '@/hooks/useAdminRole';

const findProposalsByEmail = vi.fn();
const eraseProposal = vi.fn();
const toast = vi.fn();

vi.mock('@/lib/developerApi', async (importOriginal) => ({
  ...(await importOriginal()),
  findProposalsByEmail: (...a) => findProposalsByEmail(...a),
  eraseProposal: (...a) => eraseProposal(...a),
}));
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast }) }));

const { default: ProposalErasureCard } = await import('./ProposalErasureCard.jsx');

const ONE = {
  id: '00000000-0000-4000-8000-000000000001',
  eventId: 'cloud-day-2027',
  status: 'pending',
  submittedAt: '2026-11-21T10:00:00.000Z',
};
const TWO = { ...ONE, id: '00000000-0000-4000-8000-000000000002', eventId: 'other-day-2027' };

function renderCard(role = 'super_admin') {
  return render(
    <AdminRoleProvider value={role}>
      <ProposalErasureCard />
    </AdminRoleProvider>
  );
}
const type = (value) =>
  fireEvent.change(screen.getByLabelText('Speaker’s email address'), { target: { value } });
const find = () => fireEvent.click(screen.getByRole('button', { name: /Find proposals/ }));

beforeEach(() => {
  for (const fn of [findProposalsByEmail, eraseProposal, toast]) fn.mockReset();
});

describe('ProposalErasureCard', () => {
  it('refuses something that is not an address before any call', async () => {
    renderCard();
    find();
    expect(await screen.findByRole('alert')).toHaveTextContent('Type the speaker’s email address.');
    type('not-an-address');
    find();
    expect(findProposalsByEmail).not.toHaveBeenCalled();
  });

  it('lists where the address has proposals: event, status and date', async () => {
    findProposalsByEmail.mockResolvedValue({ ok: true, proposals: [ONE, TWO], count: 2 });
    renderCard();
    type('  grace@example.com ');
    find();
    const list = await screen.findByRole('list', { name: 'Proposals from this address' });
    expect(findProposalsByEmail).toHaveBeenCalledWith('grace@example.com');
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    expect(within(list).getByText('cloud-day-2027')).toBeInTheDocument();
    expect(within(list).getByText('other-day-2027')).toBeInTheDocument();
    expect(screen.queryByText(/Only the first 200/)).not.toBeInTheDocument();
  });

  it('says so when nothing is stored for the address, and when the list was cut short', async () => {
    findProposalsByEmail.mockResolvedValueOnce({ ok: true, proposals: [], count: 0 });
    renderCard();
    type('nobody@example.com');
    find();
    expect(
      await screen.findByText('No proposals are stored for that address.')
    ).toBeInTheDocument();
    findProposalsByEmail.mockResolvedValueOnce({ ok: true, proposals: [ONE], truncated: true });
    find();
    expect(await screen.findByText(/Only the first 200 are listed/)).toBeInTheDocument();
  });

  it('deletes only after the confirmation, removes the row, and keeps the address out of the toast', async () => {
    findProposalsByEmail.mockResolvedValue({ ok: true, proposals: [ONE, TWO] });
    eraseProposal.mockResolvedValue({ ok: true, id: ONE.id, deleted: true });
    renderCard();
    type('grace@example.com');
    find();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Delete the proposal on cloud-day-2027' })
    );
    expect(eraseProposal).not.toHaveBeenCalled();
    expect(await screen.findByText('Delete this proposal?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Delete proposal' }));
    await waitFor(() => expect(eraseProposal).toHaveBeenCalledWith(ONE.id));
    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: 'Delete the proposal on cloud-day-2027' })
      ).not.toBeInTheDocument()
    );
    expect(
      screen.getByRole('button', { name: 'Delete the proposal on other-day-2027' })
    ).toBeInTheDocument();
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Proposal deleted' }));
    expect(JSON.stringify(toast.mock.calls)).not.toContain('grace@example.com');
  });

  it('cancelling the confirmation deletes nothing', async () => {
    findProposalsByEmail.mockResolvedValue({ ok: true, proposals: [ONE] });
    renderCard();
    type('grace@example.com');
    find();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Delete the proposal on cloud-day-2027' })
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(eraseProposal).not.toHaveBeenCalled();
    expect(
      screen.getByRole('button', { name: 'Delete the proposal on cloud-day-2027' })
    ).toBeInTheDocument();
  });

  it('says a proposal was already deleted, and keeps the row when a delete fails', async () => {
    findProposalsByEmail.mockResolvedValue({ ok: true, proposals: [ONE, TWO] });
    eraseProposal
      .mockResolvedValueOnce({ ok: true, id: ONE.id, deleted: false })
      .mockRejectedValueOnce(
        new Error('The proposal changed while it was being deleted. Try again.')
      );
    renderCard();
    type('grace@example.com');
    find();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Delete the proposal on cloud-day-2027' })
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Delete proposal' }));
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Already deleted' }))
    );
    fireEvent.click(screen.getByRole('button', { name: 'Delete the proposal on other-day-2027' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete proposal' }));
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Nothing was deleted', variant: 'destructive' })
      )
    );
    expect(
      screen.getByRole('button', { name: 'Delete the proposal on other-day-2027' })
    ).toBeInTheDocument();
  });

  it('shows the API’s sentence when the search fails, and no stale list', async () => {
    findProposalsByEmail
      .mockResolvedValueOnce({ ok: true, proposals: [ONE] })
      .mockRejectedValueOnce(new Error('speakerEmail must be an email address.'));
    renderCard();
    type('grace@example.com');
    find();
    await screen.findByRole('list', { name: 'Proposals from this address' });
    find();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'speakerEmail must be an email address.'
    );
    expect(
      screen.queryByRole('list', { name: 'Proposals from this address' })
    ).not.toBeInTheDocument();
  });

  it('gates the search for an editor', async () => {
    renderCard('editor');
    const button = screen.getByRole('button', { name: /Find proposals/ });
    expect(button).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(button);
    expect(findProposalsByEmail).not.toHaveBeenCalled();
  });
});
