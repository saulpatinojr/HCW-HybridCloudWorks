import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import EditorPage from './EditorPage';

vi.mock('@/features/editor/context/EditorContext', () => ({
  EditorProvider: ({ children, blogId }) => (
    <div data-testid="editor-provider" data-blog-id={blogId}>
      {children}
    </div>
  ),
  useEditor: () => ({
    blog: { id: 'blog-123', title: 'Test Article Title', status: 'draft' },
    loading: false,
  }),
}));

vi.mock('@/features/editor/components/EditorLayout', () => ({
  EditorLayout: () => <div data-testid="editor-layout">Editor Layout Content</div>,
}));

vi.mock('@/components/admin/PipelineStepper', () => ({
  default: () => <div data-testid="pipeline-stepper" />,
}));

vi.mock('@/components/admin/shared/StatusBadge', () => ({
  default: () => <div data-testid="status-badge" />,
}));

vi.mock('@/components/admin/shared/TaxonomyChips', () => ({
  default: () => <div data-testid="taxonomy-chips" />,
}));

describe('EditorPage', () => {
  it('renders EditorHeader, EditorProvider, and EditorLayout with router blogId param', () => {
    render(
      <MemoryRouter initialEntries={['/admin/editor/sample-draft-id']}>
        <Routes>
          <Route path="/admin/editor/:blogId" element={<EditorPage />} />
        </Routes>
      </MemoryRouter>
    );

    expect(screen.getByTestId('editor-provider')).toBeInTheDocument();
    expect(screen.getByTestId('editor-provider')).toHaveAttribute(
      'data-blog-id',
      'sample-draft-id'
    );
    expect(screen.getByText('Test Article Title')).toBeInTheDocument();
    expect(screen.getByTestId('editor-layout')).toBeInTheDocument();
  });
});
