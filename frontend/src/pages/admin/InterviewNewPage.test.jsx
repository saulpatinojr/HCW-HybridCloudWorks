/**
 * /admin/interviews/new: the form refuses what the server would refuse with
 * a sentence beside the field; a pasted transcript, a link and a recording
 * each reach their route after the interview is created; a recording longer
 * than 9.5 hours is refused before anything is created; an interrupted
 * upload carries on without creating a second interview; INTERVIEW_DELETED
 * stops the upload for good; and the optional photo goes through the image
 * upload onto the interview.
 */
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import InterviewNewPage from './InterviewNewPage';
import { CONSENT_WORDING_V1 } from '@/components/admin/interviews/interviewModel';

const postJSON = vi.fn();
const putBytes = vi.fn();
const toast = vi.fn();
vi.mock('@/hooks/useAuthReady', () => ({ useAuthReady: () => ({ authReady: true }) }));
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast }) }));
vi.mock('@/lib/api', () => ({
  postJSON: (...args) => postJSON(...args),
  putBytes: (...args) => putBytes(...args),
}));

const readDuration = vi.fn();
/** A made-up upload id in the server's UUID shape. */
const UP = '00000000-0000-0000-0000-000000000013';

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/admin/interviews/new']}>
      <Routes>
        <Route
          path="/admin/interviews/new"
          element={<InterviewNewPage readDuration={readDuration} />}
        />
        <Route path="/admin/interviews/:id" element={<h1>Interview page</h1>} />
      </Routes>
    </MemoryRouter>
  );
}

/** The API as the interview routes answer it. */
function answerRoutes(overrides = {}) {
  postJSON.mockImplementation(async (route, body) => {
    if (overrides[route]) return overrides[route](body);
    if (route === 'cms/interviews') return { ok: true, id: 'int-1', etag: '"e1"' };
    if (route === 'cms/interviews/uploads') {
      return { uploadId: UP, blockSize: 4 * 1024 * 1024, blockCount: 1 };
    }
    if (route === 'cms/uploads/covers') return { url: '/api/public/media/covers/x.png' };
    return { ok: true };
  });
  putBytes.mockResolvedValue({ ok: true });
}

function fillGuest() {
  fireEvent.change(screen.getByLabelText('Guest’s name'), { target: { value: 'Ada Example' } });
  fireEvent.change(screen.getByLabelText('Title'), {
    target: { value: 'Landing zones in practice' },
  });
  fireEvent.click(screen.getByLabelText(CONSENT_WORDING_V1));
}

const routesCalled = () => postJSON.mock.calls.map(([route]) => route);
const submit = () => fireEvent.click(screen.getByRole('button', { name: 'Create interview' }));

beforeEach(() => {
  for (const mock of [postJSON, putBytes, toast, readDuration]) mock.mockReset();
  readDuration.mockImplementation(async () => 60);
});

describe('InterviewNewPage', () => {
  it('names every missing field and sends nothing', async () => {
    answerRoutes();
    renderPage();
    expect(screen.getByLabelText(CONSENT_WORDING_V1)).not.toBeChecked();
    submit();
    expect(await screen.findByText('The guest’s name is required.')).toBeInTheDocument();
    expect(screen.getByText('Give the interview a title.')).toBeInTheDocument();
    expect(
      screen.getByText('Tick the box once the guest has agreed to publication.')
    ).toBeInTheDocument();
    expect(screen.getByText('Paste the transcript.')).toBeInTheDocument();
    expect(postJSON).not.toHaveBeenCalled();
  });

  it('creates the interview with its consent, stores a pasted transcript and opens its page', async () => {
    answerRoutes();
    renderPage();
    fillGuest();
    fireEvent.change(screen.getByLabelText('Transcript'), {
      target: { value: 'Speaker 1: Why landing zones?\nSpeaker 2: Because.' },
    });
    submit();
    expect(await screen.findByRole('heading', { name: 'Interview page' })).toBeInTheDocument();
    expect(postJSON.mock.calls[0][0]).toBe('cms/interviews');
    expect(postJSON.mock.calls[0][1]).toMatchObject({
      title: 'Landing zones in practice',
      guest: { name: 'Ada Example' },
      consent: { confirmed: true },
    });
    expect(postJSON.mock.calls[0][1].consent.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(postJSON).toHaveBeenCalledWith('cms/interviews/int-1/transcript', {
      text: 'Speaker 1: Why landing zones?\nSpeaker 2: Because.',
    });
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Interview created' }));
  });

  it('shows the server’s refusal of the create, sends nothing else, and lets the owner fix it', async () => {
    answerRoutes({
      'cms/interviews': () => {
        throw Object.assign(new Error('The consent date cannot be in the future.'), {
          status: 422,
          code: 'CONSENT_REQUIRED',
        });
      },
    });
    renderPage();
    fillGuest();
    fireEvent.change(screen.getByLabelText('Transcript'), { target: { value: 'Speaker 1: Hi' } });
    submit();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The consent date cannot be in the future.'
    );
    expect(routesCalled()).toEqual(['cms/interviews']);
    expect(screen.getByRole('button', { name: 'Create interview' })).toBeEnabled();
    expect(screen.getByLabelText('Guest’s name')).toBeEnabled();
  });

  it('sends a link to the server to download', async () => {
    answerRoutes();
    renderPage();
    fillGuest();
    fireEvent.click(screen.getByLabelText('Link to a recording'));
    fireEvent.change(screen.getByLabelText('Recording link'), {
      target: { value: ' https://media.example.test/talk.mp3 ' },
    });
    submit();
    await screen.findByRole('heading', { name: 'Interview page' });
    expect(postJSON).toHaveBeenCalledWith('cms/interviews/int-1/audio-from-url', {
      url: 'https://media.example.test/talk.mp3',
    });
  });

  it('uploads a recording in blocks, completes it and queues the transcription', async () => {
    answerRoutes();
    readDuration.mockImplementation(async () => 95);
    renderPage();
    fillGuest();
    fireEvent.click(screen.getByLabelText('Upload a recording'));
    const file = new File([new Uint8Array([1, 2, 3, 4, 5])], 'talk.mp3', { type: 'audio/mpeg' });
    fireEvent.change(screen.getByLabelText('Recording file'), { target: { files: [file] } });
    expect(await screen.findByText(/Length: 1 min 35 s/)).toBeInTheDocument();
    submit();
    await screen.findByRole('heading', { name: 'Interview page' });
    expect(routesCalled()).toEqual([
      'cms/interviews',
      'cms/interviews/uploads',
      `cms/interviews/uploads/${UP}/complete`,
      'cms/interviews/int-1/transcribe',
    ]);
    expect(postJSON.mock.calls[1][1]).toMatchObject({
      interviewId: 'int-1',
      fileName: 'talk.mp3',
      contentType: 'audio/mpeg',
      bytes: 5,
      durationSec: 95,
      // sha256 of the bytes 01 02 03 04 05
      sha256: '74f81fe167d99b4cb41d6d0ccda82278caee9f3e2f25d5e5a3936ff3dcec60d0',
    });
    expect(putBytes).toHaveBeenCalledTimes(1);
    expect(putBytes.mock.calls[0][0]).toBe(`cms/interviews/uploads/${UP}/blocks/0`);
  });

  it('refuses a recording over 9.5 hours before anything is created', async () => {
    answerRoutes();
    readDuration.mockImplementation(async () => 34_201);
    renderPage();
    fillGuest();
    fireEvent.click(screen.getByLabelText('Upload a recording'));
    const file = new File([new Uint8Array([1])], 'long.mp3', { type: 'audio/mpeg' });
    fireEvent.change(screen.getByLabelText('Recording file'), { target: { files: [file] } });
    expect(await screen.findByText(/most one transcription can take/)).toBeInTheDocument();
    submit();
    expect(
      await screen.findByText('Some fields need attention; each says what is missing.')
    ).toBeInTheDocument();
    expect(postJSON).not.toHaveBeenCalled();
  });

  it('refuses a file of the wrong kind, and one whose length cannot be read', async () => {
    answerRoutes();
    readDuration.mockImplementation(async () => {
      throw new Error('unreadable');
    });
    renderPage();
    fillGuest();
    fireEvent.click(screen.getByLabelText('Upload a recording'));
    fireEvent.change(screen.getByLabelText('Recording file'), {
      target: { files: [new File(['x'], 'notes.txt', { type: 'text/plain' })] },
    });
    submit();
    expect(await screen.findByText('Choose an MP3, M4A or WAV recording.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Recording file'), {
      target: { files: [new File(['x'], 'talk.wav', { type: 'audio/wav' })] },
    });
    await waitFor(() => expect(readDuration).toHaveBeenCalled());
    submit();
    expect(await screen.findByText(/could not be read/)).toBeInTheDocument();
    expect(postJSON).not.toHaveBeenCalled();
  });

  it('carries on an interrupted upload without creating a second interview', async () => {
    answerRoutes();
    readDuration.mockImplementation(async () => 60);
    putBytes.mockImplementationOnce(async () => {
      throw Object.assign(new Error('Block 0 refused'), { status: 400 });
    });
    renderPage();
    fillGuest();
    fireEvent.click(screen.getByLabelText('Upload a recording'));
    fireEvent.change(screen.getByLabelText('Recording file'), {
      target: { files: [new File([new Uint8Array([9, 9])], 'talk.m4a', { type: 'audio/x-m4a' })] },
    });
    await screen.findByText(/Length: 1 min 00 s/);
    submit();
    expect(await screen.findByText('Block 0 refused')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'the interview’s page' })).toHaveAttribute(
      'href',
      '/admin/interviews/int-1'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Carry on uploading' }));
    await screen.findByRole('heading', { name: 'Interview page' });
    expect(routesCalled().filter((route) => route === 'cms/interviews')).toHaveLength(1);
    expect(routesCalled().filter((route) => route === 'cms/interviews/uploads')).toHaveLength(1);
    expect(postJSON.mock.calls[1][1].contentType).toBe('audio/mp4');
  });

  it('stops for good when the interview is being deleted', async () => {
    answerRoutes();
    readDuration.mockImplementation(async () => 60);
    putBytes.mockImplementation(async () => {
      throw Object.assign(new Error('gone'), { status: 409, code: 'INTERVIEW_DELETED' });
    });
    renderPage();
    fillGuest();
    fireEvent.click(screen.getByLabelText('Upload a recording'));
    fireEvent.change(screen.getByLabelText('Recording file'), {
      target: { files: [new File([new Uint8Array([1])], 'talk.mp3', { type: 'audio/mpeg' })] },
    });
    await screen.findByText(/Length:/);
    submit();
    expect(await screen.findByText(/This interview is being deleted/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Try again|Carry on/ })).not.toBeInTheDocument();
    expect(putBytes).toHaveBeenCalledTimes(1);
  });

  it('adds the optional photo through the image upload, with its description', async () => {
    answerRoutes();
    renderPage();
    fillGuest();
    fireEvent.change(screen.getByLabelText('Transcript'), { target: { value: 'Speaker 1: Hi' } });
    fireEvent.change(screen.getByLabelText('Photo file'), {
      target: { files: [new File(['png'], 'ada.png', { type: 'image/png' })] },
    });
    submit();
    expect(
      await screen.findByText('Describe the photo in a few words, for people who cannot see it.')
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('What the photo shows'), {
      target: { value: 'Ada on a stage' },
    });
    submit();
    await screen.findByRole('heading', { name: 'Interview page' });
    const upload = postJSON.mock.calls.find(([route]) => route === 'cms/uploads/covers');
    expect(upload[1].path).toMatch(/^interviews\/int-1\/guest-\d+\.png$/);
    expect(postJSON).toHaveBeenCalledWith('updateContentItem', {
      contentId: 'int-1',
      updates: { image: { src: '/api/public/media/covers/x.png', alt: 'Ada on a stage' } },
    });
  });

  it('keeps going without the photo when its upload fails, and says so', async () => {
    answerRoutes({
      'cms/uploads/covers': () => {
        throw new Error('Images must be 15 MB or smaller');
      },
    });
    renderPage();
    fillGuest();
    fireEvent.change(screen.getByLabelText('Transcript'), { target: { value: 'Speaker 1: Hi' } });
    fireEvent.change(screen.getByLabelText('Photo file'), {
      target: { files: [new File(['png'], 'ada.png', { type: 'image/png' })] },
    });
    fireEvent.change(screen.getByLabelText('What the photo shows'), { target: { value: 'Ada' } });
    submit();
    await screen.findByRole('heading', { name: 'Interview page' });
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'The photo was not added' })
    );
  });
});
