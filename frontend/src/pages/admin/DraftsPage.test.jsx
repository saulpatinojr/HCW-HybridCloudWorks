/**
 * /admin/drafts (owner request 2026-10-03): the list, the editor with its
 * live preview, the save state, delete with a confirm (and its refusal for a
 * live article), Send to In Review, Back to Drafts, the docs/content import,
 * a conflict from another tab, and the warning before leaving with unsaved
 * changes.
 */
import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Link, MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import DraftsPage from './DraftsPage';
import { isDirty, fromDraft, toPayload, EMPTY_FORM, describeSaveState } from './drafts/draftForm';

const getJSON = vi.fn();
const postJSON = vi.fn();
const sendJSON = vi.fn();
const toast = vi.fn();

vi.mock('@/hooks/useAuthReady', () => ({ useAuthReady: () => ({ authReady: true }) }));
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast }) }));
vi.mock('@/lib/api', () => ({
  getJSON: (...args) => getJSON(...args),
  postJSON: (...args) => postJSON(...args),
  sendJSON: (...args) => sendJSON(...args),
}));

const ACTIONS = {
  draft: { edit: true, save: true, sendToReview: true, backToDrafts: false, delete: true },
  in_review: { edit: false, save: false, sendToReview: false, backToDrafts: true, delete: true },
  live: { edit: false, save: false, sendToReview: false, backToDrafts: false, delete: false },
};

const FIELDS = {
  title: 'Landing zones you can read',
  subtitle: 'What each block does.',
  date: '2026-10-01',
  track: 'how-to',
  part: '1 of 3',
  tags: ['azure', 'terraform'],
  reading: 9,
  body: '## Management groups\n\nThe hierarchy first.',
};

const view = (overrides = {}) => {
  const stage = overrides.stage || 'draft';
  return {
    id: 'd1',
    title: FIELDS.title,
    subtitle: FIELDS.subtitle,
    contentStatus: { draft: 'drafting', live: 'published' }[stage] || stage,
    stage,
    live: stage === 'live',
    origin: 'drafts',
    repoPath: null,
    updatedAt: '2026-10-02T10:00:00.000Z',
    etag: '"e1"',
    actions: ACTIONS[stage],
    fields: FIELDS,
    ...overrides,
  };
};
const row = (draft) => {
  const { fields: _fields, ...rest } = draft;
  return rest;
};

const DOCKER = view({
  id: 'docker-1',
  title: 'Docker images, built',
  stage: 'in_review',
  origin: 'repo-import',
  repoPath: 'docs/content/blog-docker-01-building-images.md',
  etag: '"docker"',
});

function respond({ drafts = [view(), DOCKER], open = {} } = {}) {
  getJSON.mockImplementation(async (route) => {
    if (route === 'cms/drafts') return { ok: true, drafts: drafts.map(row) };
    const id = decodeURIComponent(route.split('/').at(-1));
    const draft = open[id] || drafts.find((d) => d.id === id);
    if (!draft) throw Object.assign(new Error('No such draft.'), { status: 404 });
    return { ok: true, draft };
  });
}

/**
 * The Drafts page with a link to the Review Queue beside it and a route for it,
 * so a navigation away from unsaved work has somewhere to land.
 */
function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/admin/drafts']}>
      <Routes>
        <Route
          path="/admin/drafts"
          element={
            <>
              <Link to="/admin/review-queue">Review Queue</Link>
              <DraftsPage />
            </>
          }
        />
        <Route path="/admin/review-queue" element={<h1>Queue page</h1>} />
      </Routes>
    </MemoryRouter>
  );
}

async function openFirstDraft() {
  renderPage();
  const list = await screen.findByRole('list', { name: 'Drafts' });
  fireEvent.click(await within(list).findByRole('button', { name: /Landing zones you can read/ }));
  return screen.findByLabelText('Title');
}

beforeEach(() => {
  getJSON.mockReset();
  postJSON.mockReset();
  sendJSON.mockReset();
  toast.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the form model', () => {
  it('round-trips a draft, and a typed reading time is not an edit', () => {
    const form = fromDraft(view());
    expect(form).toMatchObject({ tags: 'azure, terraform', reading: '9' });
    expect(isDirty(form, fromDraft(view()))).toBe(false);
    expect(isDirty({ ...form, body: 'x' }, form)).toBe(true);
    // The classification always travels with the form: a draft that never
    // said is an article someone typed in (ADR 0033 §4).
    expect(toPayload(form)).toEqual({ ...FIELDS, kind: 'article', ideaOrigin: 'manual' });
    expect(toPayload({ ...EMPTY_FORM, title: ' T ', tags: 'a, ,a, b' })).toMatchObject({
      title: 'T',
      tags: ['a', 'b'],
      reading: null,
      date: null,
    });
  });

  it('names each save state', () => {
    expect(describeSaveState({ saving: true }).label).toBe('Saving…');
    expect(describeSaveState({ error: true }).key).toBe('error');
    expect(describeSaveState({ dirty: true }).label).toBe('Unsaved changes');
    expect(describeSaveState({ isNew: true }).label).toBe('Not saved yet');
    expect(describeSaveState({}).label).toBe('Saved');
  });
});

describe('DraftsPage', () => {
  it('lists drafts and articles from Drafts, and opens one with a rendered preview', async () => {
    respond();
    renderPage();
    expect(await screen.findByRole('heading', { name: 'Drafts', level: 1 })).toBeInTheDocument();
    const list = await screen.findByRole('list', { name: 'Drafts' });
    expect(within(list).getByText('Docker images, built')).toBeInTheDocument();
    expect(within(list).getByText('In Review')).toBeInTheDocument();

    fireEvent.click(within(list).getByRole('button', { name: /Landing zones you can read/ }));
    expect(await screen.findByLabelText('Title')).toHaveValue(FIELDS.title);
    expect(screen.getByLabelText('Tags')).toHaveValue('azure, terraform');
    expect(screen.getByLabelText('Body (markdown)')).toHaveValue(FIELDS.body);
    const preview = screen.getByRole('region', { name: 'Preview' });
    expect(
      await within(preview).findByRole('heading', { name: 'Management groups', level: 2 })
    ).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Saved');
  });

  it('marks an edit unsaved, saves it with the etag, and shows it saved', async () => {
    respond();
    const saved = view({ etag: '"e2"', fields: { ...FIELDS, body: 'New body' } });
    sendJSON.mockResolvedValue({ ok: true, draft: saved });
    await openFirstDraft();

    fireEvent.change(screen.getByLabelText('Body (markdown)'), { target: { value: 'New body' } });
    expect(screen.getByRole('status')).toHaveTextContent('Unsaved changes');
    expect(screen.getByRole('button', { name: /Send to In Review/ })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));
    await waitFor(() =>
      expect(sendJSON).toHaveBeenCalledWith('cms/drafts/d1', 'PUT', {
        fields: { ...FIELDS, body: 'New body', kind: 'article', ideaOrigin: 'manual' },
        etag: '"e1"',
      })
    );
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Saved'));
    expect(screen.getByRole('button', { name: /Send to In Review/ })).toBeEnabled();
  });

  it('keeps the text and offers a reload when another tab saved first', async () => {
    respond();
    sendJSON.mockRejectedValue(
      Object.assign(new Error('This draft changed in another tab or on another device.'), {
        status: 412,
        code: 'CONFLICT',
      })
    );
    await openFirstDraft();
    fireEvent.change(screen.getByLabelText('Body (markdown)'), { target: { value: 'Mine' } });
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));

    expect(await screen.findByText(/changed in another tab/)).toBeInTheDocument();
    expect(screen.getByLabelText('Body (markdown)')).toHaveValue('Mine');
    expect(screen.getByRole('status')).toHaveTextContent('Not saved');
    getJSON.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Reload latest' }));
    await waitFor(() => expect(getJSON).toHaveBeenCalledWith('cms/drafts/d1'));
  });

  it('creates a new draft on its first save', async () => {
    respond({ drafts: [] });
    const created = view({ id: 'new-1', title: 'Fresh', fields: { ...FIELDS, title: 'Fresh' } });
    postJSON.mockResolvedValue({ ok: true, draft: created });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /New draft/ }));
    expect(screen.getByRole('status')).toHaveTextContent('Not saved yet');
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Fresh' } });
    fireEvent.change(screen.getByLabelText('Body (markdown)'), { target: { value: 'Words.' } });
    fireEvent.click(screen.getByRole('button', { name: /^Save$/ }));

    await waitFor(() =>
      expect(postJSON).toHaveBeenCalledWith('cms/drafts', {
        fields: expect.objectContaining({ title: 'Fresh', body: 'Words.' }),
      })
    );
    const list = screen.getByRole('list', { name: 'Drafts' });
    expect(await within(list).findByRole('button', { name: /Fresh/ })).toBeInTheDocument();
  });

  it('asks before deleting, then deletes with the etag', async () => {
    respond();
    sendJSON.mockResolvedValue({ ok: true, deleted: 'd1', stage: 'draft' });
    await openFirstDraft();
    fireEvent.click(screen.getByRole('button', { name: /Delete/ }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Delete this draft?')).toBeInTheDocument();
    expect(sendJSON).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

    await waitFor(() =>
      expect(sendJSON).toHaveBeenCalledWith('cms/drafts/d1', 'DELETE', { etag: '"e1"' })
    );
    const list = screen.getByRole('list', { name: 'Drafts' });
    await waitFor(() =>
      expect(within(list).queryByText('Landing zones you can read')).not.toBeInTheDocument()
    );
  });

  it('says a delete of an article In Review takes the In Review item with it', async () => {
    respond();
    renderPage();
    const list = await screen.findByRole('list', { name: 'Drafts' });
    fireEvent.click(within(list).getByRole('button', { name: /^Docker images, built In Review/ }));
    expect(await screen.findByLabelText('Title')).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /^Delete$/ }));
    expect(
      await screen.findByText('Delete this draft and its In Review item?')
    ).toBeInTheDocument();
  });

  it('refuses to delete a live article, with a message and no request', async () => {
    const live = view({ id: 'live-1', title: 'Already live', stage: 'live' });
    respond({ drafts: [live] });
    renderPage();
    const list = await screen.findByRole('list', { name: 'Drafts' });
    fireEvent.click(within(list).getByRole('button', { name: /Already live/ }));
    await screen.findByLabelText('Title');
    fireEvent.click(screen.getByRole('button', { name: /^Delete$/ }));
    expect(
      await screen.findByText(/live on the site, so deleting it is refused/)
    ).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(sendJSON).not.toHaveBeenCalled();
  });

  it('sends a saved draft to In Review, after which it is read-only with Back to Drafts', async () => {
    respond();
    postJSON.mockResolvedValue({
      ok: true,
      draft: view({ stage: 'in_review', etag: '"e2"' }),
      reviewPath: '/admin/review-queue/d1',
    });
    await openFirstDraft();
    fireEvent.click(screen.getByRole('button', { name: /Send to In Review/ }));

    await waitFor(() =>
      expect(postJSON).toHaveBeenCalledWith('cms/drafts/d1/send-to-review', { etag: '"e1"' })
    );
    expect(await screen.findByText(/In Review on the Review Queue/)).toBeInTheDocument();
    expect(screen.getByLabelText('Title')).toBeDisabled();
    expect(screen.queryByRole('button', { name: /^Save$/ })).not.toBeInTheDocument();
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Sent to In Review' }));
  });

  it('brings an imported Docker draft back from In Review from its list row', async () => {
    respond();
    postJSON.mockResolvedValue({
      ok: true,
      draft: { ...DOCKER, stage: 'draft', actions: ACTIONS.draft },
    });
    renderPage();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Back to Drafts: Docker images, built' })
    );
    await waitFor(() =>
      expect(postJSON).toHaveBeenCalledWith('cms/drafts/docker-1/back-to-drafts', {
        etag: '"docker"',
      })
    );
    expect(await screen.findByLabelText('Title')).toBeEnabled();
  });

  it('imports from docs/content and reports each file', async () => {
    respond();
    postJSON.mockResolvedValue({
      ok: true,
      counts: { imported: 1, skipped: 1 },
      results: [
        {
          path: 'docs/content/blog-lab-01-landing-zone.md',
          outcome: 'imported',
          title: 'Lab one',
        },
        {
          path: 'docs/content/blog-docker-01-building-images.md',
          outcome: 'skipped',
          code: 'ALREADY_IMPORTED',
          stage: 'in_review',
          title: 'Docker images, built',
        },
      ],
    });
    renderPage();
    await screen.findByRole('list', { name: 'Drafts' });
    getJSON.mockClear();
    fireEvent.click(screen.getByRole('button', { name: /Import from docs\/content/ }));

    await waitFor(() => expect(postJSON).toHaveBeenCalledWith('cms/drafts/import-repo', {}));
    const results = await screen.findByRole('region', { name: 'Import results' });
    expect(within(results).getByText('Imported as a draft')).toBeInTheDocument();
    expect(within(results).getByText('Already imported — In Review')).toBeInTheDocument();
    await waitFor(() => expect(getJSON).toHaveBeenCalledWith('cms/drafts'));
  });

  describe('unsaved changes', () => {
    it('asks before switching to another draft', async () => {
      respond();
      await openFirstDraft();
      fireEvent.change(screen.getByLabelText('Body (markdown)'), { target: { value: 'edit' } });
      const list = screen.getByRole('list', { name: 'Drafts' });
      fireEvent.click(
        within(list).getByRole('button', { name: /^Docker images, built In Review/ })
      );
      expect(await screen.findByText('Discard unsaved changes?')).toBeInTheDocument();
      expect(screen.getByLabelText('Body (markdown)')).toHaveValue('edit');
    });

    it('warns before the tab is closed or reloaded', async () => {
      respond();
      await openFirstDraft();
      const clean = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(clean);
      expect(clean.defaultPrevented).toBe(false);

      fireEvent.change(screen.getByLabelText('Body (markdown)'), { target: { value: 'edit' } });
      const dirty = new Event('beforeunload', { cancelable: true });
      act(() => {
        window.dispatchEvent(dirty);
      });
      expect(dirty.defaultPrevented).toBe(true);
    });

    it('asks before following a link out of the page, in the modal, and stays when told to', async () => {
      respond();
      await openFirstDraft();
      fireEvent.change(screen.getByLabelText('Body (markdown)'), { target: { value: 'edit' } });
      fireEvent.click(screen.getByRole('link', { name: 'Review Queue' }));
      const dialog = await screen.findByRole('dialog', { name: 'Leave this draft?' });
      expect(dialog).toHaveTextContent(/unsaved changes/);
      expect(screen.queryByText('Queue page')).not.toBeInTheDocument();

      fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
      await waitFor(() =>
        expect(screen.queryByRole('dialog', { name: 'Leave this draft?' })).not.toBeInTheDocument()
      );
      expect(screen.queryByText('Queue page')).not.toBeInTheDocument();
      expect(screen.getByLabelText('Body (markdown)')).toHaveValue('edit');
    });

    it('leaves through the link that was clicked when told to', async () => {
      respond();
      await openFirstDraft();
      fireEvent.change(screen.getByLabelText('Body (markdown)'), { target: { value: 'edit' } });
      fireEvent.click(screen.getByRole('link', { name: 'Review Queue' }));
      const dialog = await screen.findByRole('dialog', { name: 'Leave this draft?' });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Leave without saving' }));
      expect(await screen.findByText('Queue page')).toBeInTheDocument();
    });
  });
});
