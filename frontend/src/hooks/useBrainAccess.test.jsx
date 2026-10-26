import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { BrainAccessProvider, useBrainAccess } from './useBrainAccess';
import { brainApi } from '@/lib/brainApi';
vi.mock('@/lib/brainApi', () => ({ brainApi: { status: vi.fn() } }));
function Consumer() {
  const { enabled, loading } = useBrainAccess();
  if (loading) return <p>Checking</p>;
  return <p>{enabled ? 'Owner workspace' : 'Unavailable'}</p>;
}
describe('server-derived workspace capability', () => {
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
});
