import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { BrainAccessProvider, useBrainAccess } from './useBrainAccess';
import { brainApi } from '@/lib/brainApi';
vi.mock('@/lib/brainApi', () => ({ brainApi: { status: vi.fn() } }));
function Consumer() {
  const { enabled, loading, refresh } = useBrainAccess();
  if (loading) return <p>Checking</p>;
  return (
    <>
      <p>{enabled ? 'Owner workspace' : 'Unavailable'}</p>
      <button onClick={refresh}>Retry access</button>
    </>
  );
}
describe('server-derived workspace capability', () => {
  beforeEach(() => brainApi.status.mockReset());
  afterEach(() => vi.restoreAllMocks());
  it('fails closed on an authorization rejection', async () => {
    brainApi.status.mockRejectedValueOnce(Object.assign(new Error('Forbidden'), { status: 403 }));
    render(
      <BrainAccessProvider>
        <Consumer />
      </BrainAccessProvider>
    );
    expect(await screen.findByText('Unavailable')).toBeInTheDocument();
  });
  it('enables the workspace only after a successful server response', async () => {
    brainApi.status.mockResolvedValueOnce({ enabled: true });
    render(
      <BrainAccessProvider>
        <Consumer />
      </BrainAccessProvider>
    );
    expect(await screen.findByText('Owner workspace')).toBeInTheDocument();
  });
  it('recovers an initial failed check only after a successful retry', async () => {
    brainApi.status.mockRejectedValueOnce(Object.assign(new Error('Not enabled'), { status: 404 }));
    brainApi.status.mockResolvedValueOnce({ enabled: true });
    render(
      <BrainAccessProvider>
        <Consumer />
      </BrainAccessProvider>
    );
    expect(await screen.findByText('Unavailable')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry access' }));
    expect(await screen.findByText('Owner workspace')).toBeInTheDocument();
  });
  it('rechecks on a later tab focus and clears a revoked capability', async () => {
    brainApi.status.mockResolvedValueOnce({ enabled: true });
    brainApi.status.mockRejectedValueOnce(Object.assign(new Error('Revoked'), { status: 403 }));
    render(
      <BrainAccessProvider>
        <Consumer />
      </BrainAccessProvider>
    );
    expect(await screen.findByText('Owner workspace')).toBeInTheDocument();
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 11000);
    fireEvent.focus(window);
    expect(await screen.findByText('Unavailable')).toBeInTheDocument();
  });
});
