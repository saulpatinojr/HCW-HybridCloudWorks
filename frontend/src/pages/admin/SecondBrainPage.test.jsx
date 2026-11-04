import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Link, MemoryRouter } from 'react-router';
import SecondBrainPage from './SecondBrainPage';
import { brainApi } from '@/lib/brainApi';
import { useBrainAccess } from '@/hooks/useBrainAccess';
import { reauthenticateForApi } from '@/lib/entraAuth';

vi.mock('@/hooks/useBrainAccess', () => ({ useBrainAccess: vi.fn() }));
vi.mock('@/lib/entraAuth', () => ({ reauthenticateForApi: vi.fn() }));
vi.mock('@/lib/brainApi', () => ({
  brainApi: {
    status: vi.fn(),
    list: vi.fn(),
    get: vi.fn(),
    search: vi.fn(),
    graph: vi.fn(),
    save: vi.fn(),
    history: vi.fn(),
    ask: vi.fn(),
    draft: vi.fn(),
    context: vi.fn(),
    reindex: vi.fn(),
  },
}));
const note = {
  id: 'note-1',
  type: 'note',
  title: 'Terraform state research',
  body: 'State tracks your infrastructure.',
  tags: ['terraform'],
  links: [],
  collections: [],
  urls: [],
  version: 1,
  seq: 1,
  inbox: true,
  archived: false,
};
const status = { enabled: true, aiEnabled: true, indexing: { status: 'complete', count: 1 } };
const mount = (path = '/admin/second-brain') =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <SecondBrainPage />
    </MemoryRouter>
  );
beforeEach(() => {
  vi.resetAllMocks();
  useBrainAccess.mockReturnValue(status);
  brainApi.status.mockResolvedValue(status);
  brainApi.list.mockResolvedValue({ items: [note], after: null });
  brainApi.get.mockResolvedValue({ item: note, backlinks: [] });
  brainApi.search.mockResolvedValue({ items: [note], cursor: null });
  brainApi.graph.mockResolvedValue({ nodes: [note], edges: [], cursor: null });
  brainApi.history.mockResolvedValue({ items: [] });
  brainApi.save.mockImplementation(async (item) => ({ item: { ...item, version: 2, seq: 2 } }));
});

describe('Second Brain owner workspace', () => {
  it('saves a short heading without replacing the full title or idea body', async () => {
    mount('/admin/second-brain?item=note-1');
    expect(await screen.findByLabelText('Short heading (1–4 words)')).toHaveValue(
      'Terraform state research'
    );
    fireEvent.change(screen.getByLabelText('Short heading (1–4 words)'), {
      target: { value: 'Release candidate rehearsal' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save note' }));
    await waitFor(() =>
      expect(brainApi.save).toHaveBeenCalledWith(
        expect.objectContaining({
          title: note.title,
          body: note.body,
          properties: expect.objectContaining({ heading: 'Release candidate rehearsal' }),
        }),
        1,
        expect.any(String)
      )
    );
    fireEvent.change(screen.getByLabelText('Short heading (1–4 words)'), {
      target: { value: 'one two three four five' },
    });
    expect(screen.getByRole('button', { name: 'Save note' })).toBeDisabled();
  });
  it('hides private text on failed access and restores the unsaved version after access returns', async () => {
    const tree = () => (
      <MemoryRouter>
        <SecondBrainPage />
      </MemoryRouter>
    );
    const { rerender } = render(tree());
    await screen.findByText(note.title);
    fireEvent.click(screen.getByRole('button', { name: 'Capture an idea' }));
    fireEvent.change(await screen.findByLabelText('Markdown'), {
      target: { value: 'Unsaved private outline' },
    });
    useBrainAccess.mockReturnValue({ enabled: false, loading: false });
    rerender(tree());
    expect(screen.queryByRole('region', { name: 'Note editor' })).not.toBeInTheDocument();
    expect(screen.queryByText('Unsaved private outline')).not.toBeInTheDocument();
    useBrainAccess.mockReturnValue(status);
    rerender(tree());
    expect(await screen.findByLabelText('Markdown')).toHaveValue('Unsaved private outline');
    fireEvent.click(screen.getByRole('button', { name: 'Save note' }));
    await waitFor(() =>
      expect(brainApi.save).toHaveBeenCalledWith(
        expect.objectContaining({ body: 'Unsaved private outline' }),
        0,
        expect.any(String)
      )
    );
  });
  it.each(['invalid_token', 'insufficient_scope'])(
    'offers session renewal only for an invalid token (%s)',
    async (error) => {
      useBrainAccess.mockReturnValue({
        enabled: false,
        loading: false,
        errorStatus: 401,
        wwwAuthenticate: { error },
      });
      mount();
      const button = screen.queryByRole('button', { name: 'Renew website session' });
      if (error === 'invalid_token') {
        fireEvent.click(button);
        await waitFor(() => expect(reauthenticateForApi).toHaveBeenCalledOnce());
      } else {
        expect(button).not.toBeInTheDocument();
        expect(reauthenticateForApi).not.toHaveBeenCalled();
      }
    }
  );
  it('offers no data or requests when access is unavailable', () => {
    useBrainAccess.mockReturnValue({ enabled: false, loading: false });
    mount();
    expect(screen.getByText(/unavailable for this account/)).toBeInTheDocument();
    expect(brainApi.list).not.toHaveBeenCalled();
    expect(brainApi.search).not.toHaveBeenCalled();
  });
  it('provides all six views and opens a map node through its accessible link', async () => {
    mount();
    await screen.findByText('Terraform state research');
    for (const name of ['Home', 'Inbox', 'Library', 'Topics & Projects', 'Map', 'Ask'])
      expect(screen.getByRole('button', { name, exact: true })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Map', exact: true }));
    const link = await screen.findByRole('button', { name: 'Open Terraform state research' });
    fireEvent.click(link);
    expect(await screen.findByLabelText('Title')).toHaveValue(note.title);
    expect(brainApi.get).toHaveBeenCalledWith(note.id);
  });
  it('captures free-form notes and preserves private text on a failed save', async () => {
    mount();
    await screen.findByText(note.title);
    fireEvent.click(screen.getByRole('button', { name: 'Capture an idea' }));
    fireEvent.change(await screen.findByLabelText('Title'), {
      target: { value: 'My next article' },
    });
    fireEvent.change(screen.getByLabelText('Markdown'), { target: { value: 'Private outline' } });
    brainApi.save.mockRejectedValueOnce(
      Object.assign(new Error('This item changed.'), { status: 412 })
    );
    fireEvent.click(screen.getByRole('button', { name: 'Save note' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Your text is still here');
    expect(screen.getByLabelText('Markdown')).toHaveValue('Private outline');
    expect(brainApi.draft).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Save recovery copy' }));
    await waitFor(() =>
      expect(brainApi.save).toHaveBeenLastCalledWith(
        expect.objectContaining({
          type: 'conflict',
          body: 'Private outline',
          title: 'Recovery: My next article',
        }),
        0,
        expect.any(String)
      )
    );
  });
  it('shows source-citing AI results and saves nothing until explicitly requested', async () => {
    brainApi.ask.mockResolvedValue({
      insufficientEvidence: false,
      claims: [{ text: 'Your notes cover state.', sourceIds: ['S1'] }],
      suggestions: [{ text: 'Consider a recovery tutorial.', sourceIds: [] }],
      sources: [
        {
          citation: 'S1',
          id: note.id,
          title: note.title,
          href: `/admin/second-brain?item=${note.id}`,
        },
      ],
      usage: [],
      indexing: { status: 'complete' },
    });
    mount();
    await screen.findByText(note.title);
    fireEvent.click(screen.getByRole('button', { name: 'Ask', exact: true }));
    fireEvent.change(screen.getByLabelText('Your question'), {
      target: { value: 'What have I written about Terraform?' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Ask my brain' }));
    expect(await screen.findByText('From your sources')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: `S1: ${note.title}` })).toHaveAttribute(
      'href',
      `/admin/second-brain?item=${note.id}`
    );
    expect(brainApi.save).not.toHaveBeenCalled();
    expect(brainApi.draft).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Review as a new note' }));
    expect((await screen.findByLabelText('Markdown')).value).toContain('Your notes cover state.');
    expect(screen.getByLabelText('Markdown').value).toContain('](/admin/second-brain?item=note-1)');
    expect(brainApi.save).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Save note' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Create draft', exact: true })).toBeEnabled()
    );
    brainApi.draft.mockResolvedValue({ id: 'draft-from-outline', href: '/admin/drafts' });
    fireEvent.click(screen.getByRole('button', { name: 'Create draft', exact: true }));
    expect(await screen.findByRole('link', { name: 'Open Drafts' })).toHaveAttribute(
      'href',
      '/admin/drafts'
    );
    expect(brainApi.draft).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ body: expect.stringContaining('Your notes cover state.') }),
      expect.any(String)
    );
  });
  it('requires saving a new selected idea before sending it as assistant context', async () => {
    mount();
    await screen.findByText(note.title);
    fireEvent.click(screen.getByRole('button', { name: 'Capture an idea' }));
    fireEvent.click(screen.getByRole('button', { name: 'Ask', exact: true }));
    expect(await screen.findByText(/Save this note before using it/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Your question'), {
      target: { value: 'Outline this idea' },
    });
    expect(screen.getByRole('button', { name: 'Ask my brain' })).toBeDisabled();
    expect(brainApi.ask).not.toHaveBeenCalled();
  });
  it('loads a deep-linked private note without exposing its body in the URL', async () => {
    mount('/admin/second-brain?item=note-1');
    expect(await screen.findByLabelText('Markdown')).toHaveValue(note.body);
    expect(brainApi.get).toHaveBeenCalledWith('note-1');
  });
  it('follows a citation link to its source while the page stays mounted (#1408)', async () => {
    const source = { ...note, id: 'source-1', title: 'A cited source', body: 'Source text.' };
    brainApi.get.mockImplementation(async (id) => ({
      item: id === source.id ? source : note,
      backlinks: id === source.id ? [note] : [],
    }));
    brainApi.ask.mockResolvedValue({
      insufficientEvidence: false,
      claims: [{ text: 'A claim.', sourceIds: ['S1'] }],
      suggestions: [],
      sources: [
        {
          id: source.id,
          citation: 'S1',
          title: source.title,
          href: `/admin/second-brain?item=${source.id}`,
        },
      ],
      usage: [],
      indexing: { status: 'complete' },
    });
    mount();
    await screen.findByText(note.title);
    fireEvent.click(screen.getByRole('button', { name: 'Ask', exact: true }));
    fireEvent.change(screen.getByLabelText('Your question'), { target: { value: 'Outline it' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask my brain' }));
    fireEvent.click(await screen.findByRole('link', { name: `S1: ${source.title}` }));
    expect(await screen.findByLabelText('Markdown')).toHaveValue(source.body);
    expect(brainApi.get).toHaveBeenCalledTimes(1);
    expect(brainApi.get).toHaveBeenCalledWith(source.id);
    // Open another note from the source's "Linked from" list (which leaves the
    // address at ?item=source-1), then follow the same citation again: the
    // address does not change, but the click is a new navigation and opens it.
    fireEvent.click(screen.getByRole('button', { name: note.title, exact: true }));
    await waitFor(() => expect(screen.getByLabelText('Markdown')).toHaveValue(note.body));
    fireEvent.click(screen.getByRole('link', { name: `S1: ${source.title}` }));
    await waitFor(() => expect(screen.getByLabelText('Markdown')).toHaveValue(source.body));
    expect(brainApi.get).toHaveBeenCalledTimes(3);
    expect(brainApi.get).toHaveBeenLastCalledWith(source.id);
  });
  it('starts a linked research note from a capture link and keeps unsaved text on a second one', async () => {
    brainApi.context.mockResolvedValue({ sourceId: 'ref_abc', items: [], provenance: null });
    render(
      <MemoryRouter initialEntries={['/admin/second-brain?capture=content-1']}>
        <Link to="/admin/second-brain?capture=content-2">Another capture link</Link>
        <SecondBrainPage />
      </MemoryRouter>
    );
    expect(await screen.findByLabelText('Markdown')).toHaveValue('');
    expect(brainApi.context).toHaveBeenCalledWith('content-1');
    expect(screen.getByText('ref_abc')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Markdown'), {
      target: { value: 'Typed and unsaved.' },
    });
    // A second capture link while the editor is dirty is held by the editor's
    // click guard (useUnsavedGuard); the page's own guard covers Back/Forward,
    // which a click cannot reproduce here. Cancelling keeps the typed text
    // and makes no context request.
    fireEvent.click(screen.getByRole('link', { name: 'Another capture link' }));
    expect(await screen.findByText('Leave this note?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel', exact: true }));
    expect(screen.getByLabelText('Markdown')).toHaveValue('Typed and unsaved.');
    expect(brainApi.context).toHaveBeenCalledTimes(1);
  });
});
