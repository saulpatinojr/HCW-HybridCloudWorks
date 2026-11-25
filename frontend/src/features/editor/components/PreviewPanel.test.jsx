/**
 * PreviewPanel in diff mode: the panel hands the draft as it was first loaded
 * and the draft as it is now to the diff view. It used to hand them over under
 * names the diff view does not read, so the view always said nothing had
 * changed (#1853).
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PreviewPanel } from './PreviewPanel';
import { useEditor } from '../context/EditorContext';

vi.mock('../context/EditorContext', () => ({ useEditor: vi.fn() }));

/** The editor state the panel reads, in diff mode, with the two drafts given. */
const editorState = (baselineDraft, draft) => ({
  sections: [],
  selectedSectionIndex: 0,
  selectedSection: null,
  moduleItems: [],
  sectionModuleOffsets: [],
  baselineDraft,
  fields: { draft },
  editorMode: 'diff',
  editModule: vi.fn(),
});

describe('PreviewPanel, diff mode', () => {
  it('shows both versions of a line that was edited', () => {
    useEditor.mockReturnValue(
      editorState('# Title\nThe first wording.', '# Title\nThe second wording.')
    );
    render(<PreviewPanel />);
    expect(screen.getByText('1 line changed')).toBeInTheDocument();
    expect(screen.getByText('The first wording.')).toBeInTheDocument();
    expect(screen.getByText('The second wording.')).toBeInTheDocument();
    expect(screen.queryByText('No differences detected yet.')).toBeNull();
  });

  it('says there is no difference when the draft is unchanged', () => {
    useEditor.mockReturnValue(editorState('# Title\nSame.', '# Title\nSame.'));
    render(<PreviewPanel />);
    expect(screen.getByText('No differences detected yet.')).toBeInTheDocument();
  });
});
