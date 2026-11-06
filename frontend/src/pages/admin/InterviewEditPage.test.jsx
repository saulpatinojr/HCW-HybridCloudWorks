/**
 * /admin/interviews/:interviewId: the page follows the jobs (checking again
 * while one works), starts the next step only where nothing can be lost,
 * shows the drafted Q&A with the honesty flags, saves edits, moves the
 * status, publishes and unpublishes (publisher only), deletes the recording
 * after asking, takes a source when the interview has none, and holds the
 * status moves while there are unsaved edits.
 *
 * The API is a small fake over one interview document, answering the way
 * functions/src/lib/interviews/admin.js and the content routes do.
 */
import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Link, MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import InterviewEditPage from './InterviewEditPage';
import { AdminRoleProvider } from '@/hooks/useAdminRole';

const getJSON = vi.fn();
const postJSON = vi.fn();
const sendJSON = vi.fn();
const putBytes = vi.fn();
const toast = vi.fn();
vi.mock('@/hooks/useAuthReady', () => ({ useAuthReady: () => ({ authReady: true }) }));
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast }) }));
vi.mock('@/lib/api', () => ({
  getJSON: (...args) => getJSON(...args),
  postJSON: (...args) => postJSON(...args),
  sendJSON: (...args) => sendJSON(...args),
  putBytes: (...args) => putBytes(...args),
}));

const QA = [
  { q: 'Why landing zones?', a: 'Because every team needs a start.', pullQuote: '' },
  { q: 'What went wrong?', a: 'We forgot the network.', pullQuote: '', needsReview: true },
];

let state;
function baseDoc(over = {}) {
  return {
    id: 'int-1',
    type: 'interview',
    title: 'Landing zones in practice',
    date: '2026-11-01',
    guest: { name: 'Ada Example', role: 'Architect' },
    bio: '',
    tags: ['azure'],
    contentStatus: 'draft',
    Live: false,
    qa: [],
    consent: { confirmed: true, date: '2026-11-01', wording: 'v1' },
    provenance: { audio: { path: 'audio/int-1/u.mp3' }, drafting: { droppedQuotes: 1 } },
    transcription: { version: 1, status: 'done' },
    interview: { stage: 'ready' },
    ...over,
  };
}

/** The fake routes. `onPost` lets a test change the document as a route would. */
function install({ doc = baseDoc(), transcript = null, onPost = {} } = {}) {
  state = { doc, transcript };
  getJSON.mockImplementation(async () => ({
    ok: true,
    interview: state.doc,
    transcript: state.transcript,
    consentWording: 'x',
  }));
  postJSON.mockImplementation(async (route, body) => {
    if (onPost[route]) return onPost[route](body);
    if (route === 'updateContentItem') {
      state.doc = { ...state.doc, ...body.updates };
      return { success: true };
    }
    if (route === 'transitionContentStatus') {
      state.doc = { ...state.doc, contentStatus: body.newStatus };
      return { success: true };
    }
    if (route === 'publishContent') {
      state.doc = { ...state.doc, contentStatus: 'published', Live: true };
      return {
        success: true,
        errors: [],
        mappings: [{ contentId: 'int-1', curatedSubpagePath: '/azure/interviews/landing-zones' }],
      };
    }
    if (route === 'unpublishContentToInspected') {
      state.doc = { ...state.doc, contentStatus: 'inspected', Live: false };
      return { success: true };
    }
    return { ok: true };
  });
  sendJSON.mockImplementation(async () => {
    state.doc = { ...state.doc, provenance: { ...state.doc.provenance, audio: null } };
    return { ok: true };
  });
}

function renderPage({ role = null } = {}) {
  return render(
    <MemoryRouter initialEntries={['/admin/interviews/int-1']}>
      <AdminRoleProvider value={role}>
        <Routes>
          <Route
            path="/admin/interviews/:interviewId"
            element={<InterviewEditPage pollMs={10} readDuration={async () => 60} />}
          />
        </Routes>
      </AdminRoleProvider>
    </MemoryRouter>
  );
}

/** A wider wait where a test waits on the page's own polling, which runs slower under the full suite. */
const SLOW = { timeout: 4000 };

const routes = () => postJSON.mock.calls.map(([route]) => route);
const stage = () => screen.getByTestId('interview-stage');

beforeEach(() => {
  for (const mock of [getJSON, postJSON, sendJSON, putBytes, toast]) mock.mockReset();
});

describe('following the jobs', () => {
  it('checks again while transcribing, and says which hour it is on', async () => {
    install({
      doc: baseDoc({
        interview: { stage: 'transcribing', window: 1 },
        transcription: { version: 1, status: 'running' },
      }),
    });
    renderPage();
    expect(await screen.findByText('Working on hour 2 of the recording.')).toBeInTheDocument();
    expect(stage()).toHaveTextContent('Transcribing the recording');
    const reads = getJSON.mock.calls.length;
    await waitFor(() => expect(getJSON.mock.calls.length).toBeGreaterThan(reads), SLOW);
    expect(postJSON).not.toHaveBeenCalled();
  });

  it('keeps checking after a read fails, so a network blip does not stop the progress view', async () => {
    install({
      doc: baseDoc({
        interview: { stage: 'transcribing', window: 0 },
        transcription: { version: 1, status: 'running' },
      }),
    });
    const answer = getJSON.getMockImplementation();
    let calls = 0;
    getJSON.mockImplementation(async (...args) => {
      calls += 1;
      if (calls === 2) throw new Error('Failed to fetch');
      return answer(...args);
    });
    renderPage();
    await waitFor(() => expect(calls).toBeGreaterThan(3), SLOW);
    expect(stage()).toHaveTextContent('Transcribing the recording');
  });

  it('drafts a new transcript by itself, once, and shows the pass it is on', async () => {
    install({
      doc: baseDoc({ interview: { stage: 'transcribed' }, qa: [] }),
      onPost: {
        'cms/interviews/int-1/draft': () => {
          // The shape draft.js writes while it runs: one pass saved of three.
          state.doc = {
            ...state.doc,
            interview: { stage: 'drafting' },
            provenance: {
              ...state.doc.provenance,
              drafting: {
                transcriptVersion: 1,
                passCount: 3,
                passes: [{ transcriptVersion: 1, qa: [QA[0]], speakers: {} }],
              },
            },
          };
          return { ok: true };
        },
      },
    });
    renderPage();
    expect(
      await screen.findByText('Pass 2 of 3 over the transcript.', {}, SLOW)
    ).toBeInTheDocument();
    expect(stage()).toHaveTextContent('Drafting the questions and answers');
    expect(routes().filter((r) => r === 'cms/interviews/int-1/draft')).toHaveLength(1);
  });

  it('shows a finished draft with its flags and notes, and stops checking', async () => {
    install({
      doc: baseDoc({
        qa: QA,
        interview: { stage: 'ready', speakers: { guest: 'Speaker 2', unsure: true } },
        provenance: {
          audio: { path: 'audio/int-1/u.mp3' },
          drafting: { droppedQuotes: 2, truncated: true, passCount: 3 },
        },
      }),
    });
    renderPage();
    await waitFor(() => expect(screen.getAllByTestId('qa-item')).toHaveLength(2));
    expect(stage()).toHaveTextContent('Draft ready for your review');
    const [first, second] = screen.getAllByTestId('qa-item');
    expect(within(second).getByText(/Check this answer/)).toBeInTheDocument();
    expect(within(first).queryByText(/Check this answer/)).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Answer 2' })).toHaveAccessibleDescription(
      /Check this answer/
    );
    expect(screen.getByText('1 answer(s) to check')).toBeInTheDocument();
    expect(screen.getByText(/2 pull quote\(s\) were left out/)).toBeInTheDocument();
    expect(screen.getByText(/first 40 are kept/)).toBeInTheDocument();
    expect(screen.getByText(/could not tell for certain which speaker/)).toBeInTheDocument();
    const reads = getJSON.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(getJSON.mock.calls.length).toBe(reads);
    expect(postJSON).not.toHaveBeenCalled();
  });

  it('transcribes a fetched recording by itself, but never redrafts over existing questions', async () => {
    install({
      doc: baseDoc({ interview: { stage: 'fetched' }, transcription: undefined, qa: [] }),
    });
    const first = renderPage();
    await waitFor(() => expect(routes()).toContain('cms/interviews/int-1/transcribe'));
    first.unmount();

    postJSON.mockClear();
    install({ doc: baseDoc({ interview: { stage: 'transcribed' }, qa: QA }) });
    renderPage();
    await screen.findAllByTestId('qa-item');
    expect(routes()).not.toContain('cms/interviews/int-1/draft');
  });

  it('shows why a stage stopped, and runs a step again on the owner’s word', async () => {
    install({
      doc: baseDoc({
        interview: { stage: 'failed', error: 'The URL answered with an empty file.' },
      }),
    });
    renderPage();
    expect(await screen.findByText('The URL answered with an empty file.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Transcribe again/ }));
    await waitFor(() => expect(routes()).toContain('cms/interviews/int-1/transcribe'));
    fireEvent.click(await screen.findByRole('button', { name: /Draft again/ }));
    await waitFor(() => expect(routes()).toContain('cms/interviews/int-1/draft'));
  });

  it('treats a 409 on a step it starts as already running, not as an error', async () => {
    install({
      doc: baseDoc({ interview: { stage: 'transcribed' }, qa: [] }),
      onPost: {
        'cms/interviews/int-1/draft': () => {
          throw Object.assign(new Error('A draft for this interview is already being made.'), {
            status: 409,
          });
        },
      },
    });
    renderPage();
    await waitFor(() => expect(routes()).toContain('cms/interviews/int-1/draft'));
    await waitFor(() => expect(getJSON.mock.calls.length).toBeGreaterThan(1));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('asks the API nothing for an address that is not an interview id', async () => {
    install();
    render(
      <MemoryRouter initialEntries={['/admin/interviews/..']}>
        <Routes>
          <Route
            path="/admin/interviews/:interviewId"
            element={<InterviewEditPage pollMs={10} />}
          />
        </Routes>
      </MemoryRouter>
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('No interview has that address.');
    expect(getJSON).not.toHaveBeenCalled();
  });

  it('shows the API’s sentence when a step it starts is refused', async () => {
    install({
      doc: baseDoc({ qa: QA }),
      onPost: {
        'cms/interviews/int-1/draft': () => {
          throw Object.assign(
            new Error('This interview has no finished transcript to draft from.'),
            {
              status: 422,
            }
          );
        },
      },
    });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /Draft again/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('no finished transcript');
  });
});

describe('the Q&A editor', () => {
  it('saves edits, a cleared flag, a new order and a removal', async () => {
    install({ doc: baseDoc({ qa: QA }) });
    renderPage();
    await screen.findAllByTestId('qa-item');
    fireEvent.change(screen.getByLabelText('Answer 2'), {
      target: { value: 'We forgot the network at first.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'I have checked answer 2' }));
    fireEvent.click(screen.getByRole('button', { name: 'Move question 2 up' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add a question' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove question 3' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save questions and answers' }));
    await waitFor(() => expect(routes()).toContain('updateContentItem'));
    expect(postJSON.mock.calls.find(([r]) => r === 'updateContentItem')[1]).toEqual({
      contentId: 'int-1',
      updates: {
        qa: [
          { q: 'What went wrong?', a: 'We forgot the network at first.', pullQuote: '' },
          { q: 'Why landing zones?', a: 'Because every team needs a start.', pullQuote: '' },
        ],
      },
    });
    expect(toast).toHaveBeenCalledWith({ title: 'Questions and answers saved' });
  });

  it('refuses an empty question before sending, and undoes changes', async () => {
    install({ doc: baseDoc({ qa: QA }) });
    renderPage();
    await screen.findAllByTestId('qa-item');
    fireEvent.change(screen.getByLabelText('Question 1'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save questions and answers' }));
    expect(await screen.findByText('Question 1 is empty.')).toBeInTheDocument();
    expect(routes()).not.toContain('updateContentItem');
    fireEvent.click(screen.getAllByRole('button', { name: 'Undo changes' })[0]);
    expect(screen.getByLabelText('Question 1')).toHaveValue('Why landing zones?');
  });
});

describe('review and publish', () => {
  it('shows nothing of the last interview when the address moves to another', async () => {
    install({ doc: baseDoc({ qa: QA }) });
    let answerSecond;
    getJSON.mockImplementation((route) =>
      route === 'cms/interviews/int-2'
        ? new Promise((resolve) => {
            answerSecond = resolve;
          })
        : Promise.resolve({ ok: true, interview: state.doc, transcript: null, consentWording: 'x' })
    );
    render(
      <MemoryRouter initialEntries={['/admin/interviews/int-1']}>
        <AdminRoleProvider value={null}>
          <Link to="/admin/interviews/int-2">Next interview</Link>
          <Routes>
            <Route
              path="/admin/interviews/:interviewId"
              element={<InterviewEditPage pollMs={10} readDuration={async () => 60} />}
            />
          </Routes>
        </AdminRoleProvider>
      </MemoryRouter>
    );
    expect(await screen.findByLabelText('Question 1')).toHaveValue('Why landing zones?');
    fireEvent.click(screen.getByText('Next interview'));
    // While the second is read, the first's Q&A is gone, not shown under its address.
    await waitFor(() => expect(screen.queryByLabelText('Question 1')).not.toBeInTheDocument());
    answerSecond({
      ok: true,
      interview: baseDoc({ id: 'int-2', qa: [{ q: 'Second?', a: 'Yes.', pullQuote: '' }] }),
      transcript: null,
      consentWording: 'x',
    });
    expect(await screen.findByLabelText('Question 1')).toHaveValue('Second?');
  });

  it('sends to review and approves, holding both while edits are unsaved', async () => {
    install({ doc: baseDoc({ qa: QA }) });
    renderPage();
    const review = await screen.findByRole('button', { name: 'Send to review' });
    fireEvent.change(screen.getByLabelText('Question 1'), { target: { value: 'Changed?' } });
    expect(review).toBeDisabled();
    expect(screen.getByText(/Save or undo your changes first/)).toBeInTheDocument();
    // A new draft or transcript would replace the unsaved Q&A, so both wait too.
    expect(screen.getByRole('button', { name: /Draft again/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Transcribe again/ })).toBeDisabled();
    fireEvent.click(screen.getAllByRole('button', { name: 'Undo changes' })[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Send to review' }));
    await waitFor(() =>
      expect(screen.getByTestId('interview-status')).toHaveTextContent('In review')
    );
    expect(postJSON).toHaveBeenCalledWith('transitionContentStatus', {
      contentId: 'int-1',
      newStatus: 'in_review',
      reviewNotes: '',
      publishTarget: 'interview',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() =>
      expect(screen.getByTestId('interview-status')).toHaveTextContent('Approved')
    );
  });

  it('publishes as an interview, links the live page, then unpublishes', async () => {
    install({ doc: baseDoc({ qa: QA, contentStatus: 'approved' }) });
    renderPage({ role: 'publisher' });
    fireEvent.click(await screen.findByRole('button', { name: 'Publish' }));
    await waitFor(() =>
      expect(screen.getByTestId('interview-status')).toHaveTextContent('Published')
    );
    expect(postJSON.mock.calls.find(([r]) => r === 'publishContent')[1]).toMatchObject({
      contentIds: ['int-1'],
      publishTarget: 'interview',
      markLive: true,
    });
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({
        description: 'Live at /azure/interviews/landing-zones within five minutes.',
      })
    );
    state.doc = { ...state.doc, curatedSubpagePath: '/azure/interviews/landing-zones' };
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByRole('link', { name: /Open the live page/ })).toHaveAttribute(
      'href',
      '/azure/interviews/landing-zones'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Unpublish' }));
    await waitFor(() =>
      expect(screen.getByTestId('interview-status')).toHaveTextContent('Unpublished')
    );
    expect(postJSON.mock.calls.find(([r]) => r === 'unpublishContentToInspected')[1]).toMatchObject(
      {
        contentId: 'int-1',
        currentStatus: 'published',
      }
    );
  });

  it('shows a publish refusal in the server’s words', async () => {
    install({
      doc: baseDoc({ qa: QA, contentStatus: 'approved' }),
      onPost: {
        publishContent: () => ({
          success: true,
          errors: [
            {
              contentId: 'int-1',
              code: 'CONSENT_REQUIRED',
              error: 'The consent date is in the future.',
            },
          ],
          mappings: [],
        }),
      },
    });
    renderPage({ role: 'publisher' });
    fireEvent.click(await screen.findByRole('button', { name: 'Publish' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The consent date is in the future.'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('links the live page only when its address is a page of this site', async () => {
    install({
      doc: baseDoc({
        qa: QA,
        contentStatus: 'published',
        Live: true,
        curatedSubpagePath: 'https://phish.example/azure/interviews/x',
      }),
    });
    renderPage({ role: 'publisher' });
    await screen.findByRole('button', { name: 'Unpublish' });
    expect(screen.queryByRole('link', { name: /Open the live page/ })).not.toBeInTheDocument();
  });

  it('says so when the recording could not be deleted, and gates the button for an editor', async () => {
    install({ doc: baseDoc({ qa: QA }) });
    sendJSON.mockImplementation(async () => {
      throw Object.assign(new Error('The recording could not be deleted; try again.'), {
        status: 502,
        code: 'DELETE_FAILED',
      });
    });
    const publisher = renderPage({ role: 'publisher' });
    fireEvent.click(await screen.findByRole('button', { name: 'Delete recording' }));
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete recording' })
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be deleted');
    expect(
      screen.queryByText('No recording is stored for this interview.')
    ).not.toBeInTheDocument();
    publisher.unmount();

    sendJSON.mockClear();
    renderPage({ role: 'editor' });
    const button = await screen.findByRole('button', { name: 'Delete recording' });
    expect(button.closest('[data-role-gate="publisher"]')).not.toBeNull();
    fireEvent.click(button);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(sendJSON).not.toHaveBeenCalled();
  });

  it('holds Delete recording while a job is reading the recording', async () => {
    install({ doc: baseDoc({ qa: QA, interview: { stage: 'transcribing' } }) });
    renderPage({ role: 'publisher' });
    expect(await screen.findByRole('button', { name: 'Delete recording' })).toBeDisabled();
    expect(screen.getByText(/once the step working on it has finished/)).toBeInTheDocument();
  });

  it('tells an editor that publishing needs the Publisher role, and sends nothing', async () => {
    install({ doc: baseDoc({ qa: QA, contentStatus: 'approved' }) });
    renderPage({ role: 'editor' });
    const publish = await screen.findByRole('button', { name: 'Publish' });
    fireEvent.click(publish);
    expect(routes()).not.toContain('publishContent');
    expect(publish.closest('[data-role-gate="publisher"]')).not.toBeNull();
  });

  it('deletes the recording only after asking, and keeps the transcript', async () => {
    install({
      doc: baseDoc({ qa: QA }),
      transcript: { version: 1, text: 'Speaker 1: Hello there.' },
    });
    renderPage({ role: 'publisher' });
    fireEvent.click(await screen.findByRole('button', { name: 'Delete recording' }));
    const dialog = await screen.findByRole('dialog');
    expect(sendJSON).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete recording' }));
    await waitFor(() =>
      expect(sendJSON).toHaveBeenCalledWith('cms/interviews/int-1/audio', 'DELETE')
    );
    expect(
      await screen.findByText('No recording is stored for this interview.')
    ).toBeInTheDocument();
    expect(screen.getByText(/Show transcript version 1/)).toBeInTheDocument();
    expect(screen.getByText('Speaker 1: Hello there.')).toBeInTheDocument();
  });
});

describe('the rest of the page', () => {
  it('takes a source for an interview that has none', async () => {
    install({
      doc: baseDoc({ provenance: {}, transcription: undefined, interview: { stage: 'created' } }),
    });
    renderPage();
    expect(
      await screen.findByRole('heading', { name: 'Give the interview its source' })
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('Paste the transcript.')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox', { name: 'Transcript' }), {
      target: { value: 'Speaker 1: Hi' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() =>
      expect(postJSON).toHaveBeenCalledWith('cms/interviews/int-1/transcript', {
        text: 'Speaker 1: Hi',
      })
    );
  });

  it('saves the guest’s details', async () => {
    install({ doc: baseDoc({ qa: QA }) });
    renderPage();
    const name = await screen.findByLabelText('Guest’s name');
    fireEvent.change(name, { target: { value: 'Ada Q. Example' } });
    fireEvent.change(screen.getByLabelText('Tags (optional)'), {
      target: { value: 'azure, networking' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save details' }));
    await waitFor(() => expect(routes()).toContain('updateContentItem'));
    expect(postJSON.mock.calls.find(([r]) => r === 'updateContentItem')[1].updates).toMatchObject({
      guest: { name: 'Ada Q. Example', role: 'Architect' },
      tags: ['azure', 'networking'],
    });
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save details' }));
    expect(await screen.findByText('Give the interview a title.')).toBeInTheDocument();
  });

  it('says plainly when the interview cannot be read, or has no consent record', async () => {
    getJSON.mockImplementation(async () => {
      throw new Error('No interview has that id.');
    });
    const first = renderPage();
    expect(await screen.findByRole('alert')).toHaveTextContent('No interview has that id.');
    first.unmount();

    install({ doc: baseDoc({ consent: null }) });
    renderPage();
    expect(await screen.findByText(/No consent record/)).toBeInTheDocument();
  });
});
