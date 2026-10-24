/**
 * The header's Interviews link is Azure's alone and exists only once there is
 * an interview file. `Header.test.jsx` holds the exact link list for every
 * provider with no interviews; this holds the other case.
 */
import React from 'react';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

async function labelsAt(pathname, { hasInterviews }) {
  vi.resetModules();
  vi.doMock('@/data/interviews/available', () => ({ hasInterviews }));
  const { default: Header } = await import('./Header');
  render(
    <MemoryRouter initialEntries={[pathname]}>
      <Header />
    </MemoryRouter>
  );
  const nav = screen.getByRole('navigation', { name: 'Primary' });
  return within(nav)
    .getAllByRole('link')
    .map((link) => ({ label: link.textContent.trim(), href: link.getAttribute('href') }));
}

afterEach(() => {
  vi.doUnmock('@/data/interviews/available');
});

describe('Header: Interviews link', () => {
  it('appears on Azure once there is an interview, between Podcast and Frameworks', async () => {
    const links = await labelsAt('/azure', { hasInterviews: true });
    const labels = links.map((link) => link.label);
    expect(labels).toContain('Interviews');
    expect(labels.indexOf('Interviews')).toBe(labels.indexOf('Podcast') + 1);
    expect(labels.indexOf('Interviews')).toBe(labels.indexOf('Frameworks') - 1);
    expect(links.find((link) => link.label === 'Interviews').href).toBe('/azure/interviews');
  });

  it('is not on Azure while there are no interviews', async () => {
    const links = await labelsAt('/azure', { hasInterviews: false });
    expect(links.map((link) => link.label)).not.toContain('Interviews');
  });

  it.each(['/aws', '/gcp', '/vmware', '/finops', '/github', '/terraform', '/docker', '/ansible'])(
    'is never on %s, whatever Azure has',
    async (pathname) => {
      const links = await labelsAt(pathname, { hasInterviews: true });
      expect(links.map((link) => link.label)).not.toContain('Interviews');
    }
  );
});
