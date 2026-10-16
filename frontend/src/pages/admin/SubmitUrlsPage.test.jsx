import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import SubmitUrlsPage from './SubmitUrlsPage';

const mockFetchPromptSets = vi.fn().mockResolvedValue([]);
const mockFetchPromptSet = vi.fn().mockResolvedValue({});
const mockFetchPromptNames = vi.fn().mockResolvedValue([]);
const mockFetchPrompt = vi.fn().mockResolvedValue({});
const mockFetchPageAssignment = vi.fn().mockResolvedValue(null);
const mockSavePageAssignment = vi.fn().mockResolvedValue({});

vi.mock('@/hooks/useImagePrompts', () => ({
  useImagePrompts: () => ({
    fetchPromptSets: mockFetchPromptSets,
    fetchPromptSet: mockFetchPromptSet,
    fetchPromptNames: mockFetchPromptNames,
    fetchPrompt: mockFetchPrompt,
    fetchPageAssignment: mockFetchPageAssignment,
    savePageAssignment: mockSavePageAssignment,
  }),
}));

vi.mock('@/lib/api', () => ({
  getJSON: vi.fn().mockResolvedValue({}),
  postJSON: vi.fn().mockResolvedValue({}),
  sendJSON: vi.fn().mockResolvedValue({}),
}));

describe('SubmitUrlsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it('renders the workflow header, summary card, and all four stage cards', () => {
    render(
      <MemoryRouter initialEntries={['/admin/new-content']}>
        <SubmitUrlsPage />
      </MemoryRouter>
    );

    expect(screen.getByRole('heading', { level: 1, name: /New Content/i })).toBeInTheDocument();
    expect(screen.getByText(/Stage 1: Global Options/i)).toBeInTheDocument();
    expect(screen.getByText(/Stage 2: URL Submission/i)).toBeInTheDocument();
    expect(screen.getByText(/Stage 3: Image Generation/i)).toBeInTheDocument();
    expect(screen.getByText(/Stage 4: Content Draft/i)).toBeInTheDocument();
  });

  it('allows entering a title and updating stage 1 fields', () => {
    render(
      <MemoryRouter initialEntries={['/admin/new-content']}>
        <SubmitUrlsPage />
      </MemoryRouter>
    );

    const titleInput = screen.getByPlaceholderText(/Optional title seed/i);
    expect(titleInput).toBeInTheDocument();
    fireEvent.change(titleInput, { target: { value: 'My Awesome New Article' } });
    expect(titleInput).toHaveValue('My Awesome New Article');
  });
});
