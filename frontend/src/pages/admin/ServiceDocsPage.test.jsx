import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import ServiceDocsPage from './ServiceDocsPage';

const mockNavigate = vi.fn();
vi.mock('react-router', async () => {
  const actual = await vi.importActual('react-router');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

describe('ServiceDocsPage', () => {
  it('renders documentation not found when serviceId is unknown', () => {
    render(
      <MemoryRouter initialEntries={['/admin/ai-engine/docs/unknown-service-xyz']}>
        <Routes>
          <Route path="/admin/ai-engine/docs/:serviceId" element={<ServiceDocsPage />} />
        </Routes>
      </MemoryRouter>
    );

    expect(screen.getByText('Documentation not found')).toBeInTheDocument();
    expect(screen.getByText('unknown-service-xyz')).toBeInTheDocument();

    const backButton = screen.getByRole('button', { name: /Back to AI Engine/i });
    fireEvent.click(backButton);
    expect(mockNavigate).toHaveBeenCalledWith('/admin/ai-engine');
  });

  it('renders documentation for a known service (e.g. gemini)', () => {
    render(
      <MemoryRouter initialEntries={['/admin/ai-engine/docs/gemini']}>
        <Routes>
          <Route path="/admin/ai-engine/docs/:serviceId" element={<ServiceDocsPage />} />
        </Routes>
      </MemoryRouter>
    );

    expect(screen.getByRole('heading', { level: 1, name: /Gemini/i })).toBeInTheDocument();
    expect(screen.getAllByText('Requirements').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('HCW Uses').length).toBeGreaterThanOrEqual(1);
  });
});
