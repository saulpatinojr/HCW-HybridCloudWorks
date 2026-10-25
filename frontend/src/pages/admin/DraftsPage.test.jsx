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
import {
  isDirty,
  fromDraft,
  toPayload,
  EMPTY_FORM,
  describeSaveState,
  describeMarkdownResult,
  summarizeMarkdownBatch,
} from './drafts/draftForm';

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

  describe('Paste or upload a markdown draft', () => {
    const file = (name, text) => new File([text], name, { type: 'text/markdown' });
    const NEW_FILE = file('new-article.md', '---\ntitle: New article\n---\n\nBody');
    const DUPLICATE_FILE = file('already-here.md', '---\ntitle: Already here\n---\n\nBody');
    const INVALID_FILE = file('no-front-matter.md', 'Just text, no block.');

    const created = (title) => ({
      ok: true,
      outcome: 'created',
      contentId: 'c1',
      title,
      warnings: [],
      draft: row(view({ id: 'c1', title })),
    });
    const present = {
      ok: true,
      outcome: 'skipped',
      code: 'ALREADY_IMPORTED',
      contentId: 'd1',
      stage: 'draft',
    };
    const rejection = Object.assign(
      new Error('The file does not open with a --- front-matter block.'),
      { status: 422 }
    );

    /** The panel, with the import button's route answering nothing in case it is pressed. */
    async function renderPanel() {
      respond();
      renderPage();
      await screen.findByRole('list', { name: 'Drafts' });
      return screen.getByRole('region', { name: 'Paste or upload a markdown draft' });
    }
    const choose = (files) =>
      fireEvent.change(screen.getByLabelText(/Markdown files from my vault/), {
        target: { files },
      });
    const markdownCalls = () =>
      postJSON.mock.calls.filter(([route]) => route === 'cms/drafts/from-markdown');

    it('offers a labelled file picker for several .md files and a labelled box, and keeps the docs/content import', async () => {
      const panel = await renderPanel();
      const picker = within(panel).getByLabelText(/Markdown files from my vault/);
      expect(picker).toHaveAttribute('type', 'file');
      expect(picker).toHaveAttribute('multiple');
      expect(picker.getAttribute('accept')).toContain('.md');
      expect(within(panel).getByLabelText(/Or paste one draft/)).toBeInTheDocument();
      expect(within(panel).getByText(/Nothing is published/)).toBeInTheDocument();
      expect(within(panel).getByRole('button', { name: 'Upload files' })).toBeDisabled();
      expect(within(panel).getByRole('button', { name: 'Add pasted draft' })).toBeDisabled();
      expect(screen.getByRole('button', { name: /Import from docs\/content/ })).toBeInTheDocument();
    });

    it('sends a mixed batch one request at a time, in order, and one bad file does not stop the rest', async () => {
      const panel = await renderPanel();
      const first = Promise.withResolvers();
      postJSON
        .mockReturnValueOnce(first.promise)
        .mockResolvedValueOnce(present)
        .mockRejectedValueOnce(rejection);
      choose([NEW_FILE, DUPLICATE_FILE, INVALID_FILE]);
      getJSON.mockClear();
      fireEvent.click(within(panel).getByRole('button', { name: 'Upload 3 files' }));

      // The first request is out and unanswered: the second has not been sent.
      await waitFor(() => expect(markdownCalls()).toHaveLength(1));
      expect(await within(panel).findByRole('status')).toHaveTextContent(
        'Sending 1 of 3: new-article.md'
      );
      expect(within(panel).getByRole('button', { name: 'Upload 3 files' })).toBeDisabled();
      first.resolve(created('New article'));

      await waitFor(() => expect(markdownCalls()).toHaveLength(3));
      expect(markdownCalls().map(([, body]) => body.origin)).toEqual(['vault', 'vault', 'vault']);
      expect(markdownCalls()[0][1].markdown).toContain('title: New article');
      expect(markdownCalls()[1][1].markdown).toContain('title: Already here');

      const results = await within(panel).findByRole('list', { name: 'Upload results' });
      const lines = within(results).getAllByRole('listitem');
      expect(lines).toHaveLength(3);
      expect(lines[0]).toHaveTextContent('new-article.md Created as a draft');
      expect(lines[1]).toHaveTextContent('already-here.md Already present — Draft');
      expect(lines[2]).toHaveTextContent(
        'no-front-matter.md Not added: The file does not open with a --- front-matter block.'
      );
      expect(
        await within(panel).findByText(
          '3 files: 1 created, 1 already present, 1 not added. Nothing was published.'
        )
      ).toBeInTheDocument();
      // The list is reloaded once for the batch, not once per file.
      await waitFor(() => expect(getJSON).toHaveBeenCalledWith('cms/drafts'));
      expect(getJSON.mock.calls.filter(([route]) => route === 'cms/drafts')).toHaveLength(1);
      expect(toast).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Drafts added',
          description: expect.stringContaining('1 created'),
        })
      );
      // Back to a clean picker.
      expect(within(panel).getByRole('button', { name: 'Upload files' })).toBeDisabled();
    });

    it('reports a published title as already present, and a failure that is not the file’s fault', async () => {
      const panel = await renderPanel();
      postJSON
        .mockResolvedValueOnce({ ok: true, outcome: 'skipped', code: 'PUBLISHED_ELSEWHERE' })
        .mockRejectedValueOnce(Object.assign(new Error('Sign in again.'), { status: 401 }));
      choose([NEW_FILE, DUPLICATE_FILE]);
      fireEvent.click(within(panel).getByRole('button', { name: 'Upload 2 files' }));
      const results = await within(panel).findByRole('list', { name: 'Upload results' });
      await within(panel).findByText(/2 files: 0 created, 1 already present, 1 not added/);
      expect(results).toHaveTextContent(
        'new-article.md Already present — an article with this title is already published'
      );
      expect(results).toHaveTextContent('already-here.md Not added: Sign in again.');
      expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'No new drafts' }));
    });

    it('does not send a file over the size cap, and still sends the others', async () => {
      const panel = await renderPanel();
      const big = file('big.md', 'a'.repeat(272 * 1024 + 1));
      postJSON.mockResolvedValueOnce(created('New article'));
      choose([big, NEW_FILE]);
      fireEvent.click(within(panel).getByRole('button', { name: 'Upload 2 files' }));
      await within(panel).findByText(/2 files: 1 created, 0 already present, 1 not added/);
      expect(markdownCalls()).toHaveLength(1);
      expect(within(panel).getByRole('list', { name: 'Upload results' })).toHaveTextContent(
        'big.md Not added: this file is over 272 KB'
      );
    });

    it('sends pasted text as pasted, and clears the box only when it went in', async () => {
      const panel = await renderPanel();
      const box = within(panel).getByLabelText(/Or paste one draft/);
      const add = within(panel).getByRole('button', { name: 'Add pasted draft' });
      postJSON.mockRejectedValueOnce(rejection).mockResolvedValueOnce(created('Pasted one'));

      fireEvent.change(box, { target: { value: 'no front matter here' } });
      fireEvent.click(add);
      await within(panel).findByText(/1 pasted draft: 0 created, 0 already present, 1 not added/);
      expect(markdownCalls()[0][1]).toEqual({ markdown: 'no front matter here', origin: 'paste' });
      expect(box).toHaveValue('no front matter here');

      fireEvent.change(box, { target: { value: '---\ntitle: Pasted one\n---\n\nBody' } });
      fireEvent.click(add);
      await within(panel).findByText(/1 pasted draft: 1 created/);
      expect(markdownCalls()[1][1].origin).toBe('paste');
      expect(box).toHaveValue('');
    });

    it('shows the server’s warnings under a created file', async () => {
      const panel = await renderPanel();
      postJSON.mockResolvedValueOnce({
        ...created('New article'),
        warnings: ['date "soon" is not YYYY-MM-DD and was ignored'],
      });
      choose([NEW_FILE]);
      fireEvent.click(within(panel).getByRole('button', { name: 'Upload 1 file' }));
      expect(await within(panel).findByText(/date "soon" is not YYYY-MM-DD/)).toBeInTheDocument();
    });

    it('labels where a draft came from in the list', async () => {
      respond({
        drafts: [
          view({ id: 'a', title: 'From the vault', origin: 'vault' }),
          view({ id: 'b', title: 'From a paste', origin: 'paste' }),
          view({ id: 'c', title: 'Typed here', origin: 'drafts' }),
        ],
      });
      renderPage();
      const list = await screen.findByRole('list', { name: 'Drafts' });
      expect(await within(list).findByRole('button', { name: /From the vault/ })).toHaveTextContent(
        'From my vault'
      );
      expect(within(list).getByRole('button', { name: /From a paste/ })).toHaveTextContent(
        'Pasted in'
      );
      expect(within(list).getByRole('button', { name: /Typed here/ })).toHaveTextContent(
        'Written here'
      );
    });
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

describe('the markdown upload wording', () => {
  it('says each outcome in plain words, without codes', () => {
    expect(
      describeMarkdownResult('a.md', { answer: { outcome: 'created', warnings: ['w'] } })
    ).toMatchObject({ kind: 'created', tone: 'ok', text: 'Created as a draft', warnings: ['w'] });
    expect(
      describeMarkdownResult('a.md', {
        answer: { outcome: 'skipped', code: 'ALREADY_IMPORTED', stage: 'in_review' },
      })
    ).toMatchObject({ kind: 'present', text: 'Already present — In Review' });
    expect(
      describeMarkdownResult('a.md', { answer: { outcome: 'skipped', code: 'ALREADY_IMPORTED' } })
        .text
    ).toBe('Already present — Drafts');
    expect(
      describeMarkdownResult('a.md', { error: new Error('Title is required.') })
    ).toMatchObject({
      kind: 'failed',
      tone: 'bad',
      text: 'Not added: Title is required.',
    });
    expect(describeMarkdownResult('a.md', { answer: {} })).toMatchObject({ kind: 'failed' });
  });

  it('counts a batch, treating a published title as already present', () => {
    const lines = ['created', 'created', 'present', 'published', 'failed'].map((kind) => ({
      kind,
    }));
    expect(summarizeMarkdownBatch(lines)).toBe(
      '5 files: 2 created, 2 already present, 1 not added. Nothing was published.'
    );
    expect(summarizeMarkdownBatch([{ kind: 'created' }], 'pasted draft')).toMatch(
      /^1 pasted draft: 1 created/
    );
  });
});
