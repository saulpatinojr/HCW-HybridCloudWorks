import { createHash } from 'node:crypto';
import { test, expect } from './fixtures/entra.js';

/**
 * The interview form, end to end in a real browser (ADR 0040, D7 and D12;
 * issue #1565), against the stubbed API of fixtures/entra.js. Runs on the
 * desktop and the phone projects.
 *
 * 1. A pasted transcript: sign in, fill the guest, tick the consent with its
 *    date, paste, create; the interview's page drafts the transcript by
 *    itself and shows the drafted questions with the honesty flag.
 * 2. A recording: a real WAV file whose length Chromium reads from its
 *    header, uploaded as raw blocks with the declared SHA-256, completed,
 *    and queued for transcription.
 *
 * Nothing here reaches a real API or storage: every `/api/` route is the
 * fixture's, and the fixture fails the test on any other host.
 */

const INTERVIEW_ID = 'int-e2e-1';
const UPLOAD_ID = '0e2e0000-0000-4000-8000-0000000000b1';

const DRAFTED_QA = [
  {
    q: 'Why did your team start with a landing zone?',
    a: 'Because every workload needed the same network and identity rules first.',
    pullQuote: '',
  },
  {
    q: 'What would you do differently?',
    a: 'We would have written the naming rules down on day one.',
    pullQuote: '',
    needsReview: true,
  },
];

/** The interview document as GET cms/interviews/{id} returns it, at a stage. */
function interviewAt(stage, extra = {}) {
  return {
    ok: true,
    interview: {
      id: INTERVIEW_ID,
      type: 'interview',
      title: 'Landing zones in practice',
      date: '2026-11-05',
      guest: { name: 'Ada Example', role: 'Cloud architect' },
      bio: '',
      tags: ['azure'],
      contentStatus: 'draft',
      Live: false,
      qa: [],
      consent: { confirmed: true, date: '2026-11-05', wording: 'v1' },
      provenance: {},
      interview: { stage },
      ...extra,
    },
    transcript: null,
  };
}

/** A valid one-second, 8 kHz, 16-bit mono WAV file of silence. */
function silentWav(seconds = 1) {
  const rate = 8000;
  const data = rate * 2 * seconds;
  const buffer = Buffer.alloc(44 + data);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + data, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(rate, 24);
  buffer.writeUInt32LE(rate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(data, 40);
  return buffer;
}

/**
 * A small MP3 whose Xing header declares a length of `seconds`: one frame
 * carrying the header, then a few silent frames. The browser reads the
 * length from that header, so a file of a few kilobytes can say it lasts
 * over 9.5 hours. MPEG-1 Layer III, 128 kbit/s, 44.1 kHz, stereo: frames of
 * 417 bytes and 1152 samples.
 */
function longMp3(seconds) {
  const frameBytes = 417;
  const header = Buffer.from([0xff, 0xfb, 0x90, 0x00]);
  const first = Buffer.alloc(frameBytes);
  header.copy(first, 0);
  first.write('Xing', 36);
  first.writeUInt32BE(0x0001, 40);
  first.writeUInt32BE(Math.ceil((seconds * 44_100) / 1152), 44);
  const silent = Buffer.alloc(frameBytes);
  header.copy(silent, 0);
  return Buffer.concat([first, ...Array.from({ length: 8 }, () => silent)]);
}

async function fillGuestAndConsent(page) {
  await page.getByLabel('Guest’s name').fill('Ada Example');
  await page.getByLabel('Guest’s role (optional)').fill('Cloud architect');
  await page.getByLabel('Title', { exact: true }).fill('Landing zones in practice');
  await page.getByLabel(/The guest has agreed that this interview may be published/).check();
  await expect(page.getByLabel('Date the guest agreed')).toHaveValue(/^\d{4}-\d{2}-\d{2}$/);
}

async function expectNoSideways(page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true
  );
}

test.beforeEach(async ({ identity }) => {
  identity.answerApi('cms/calendar-alerts', { today: '2026-11-05', alerts: [] });
  identity.answerApi('cms/interviews', (request) =>
    request.method() === 'POST'
      ? { ok: true, id: INTERVIEW_ID, etag: '"e1"' }
      : { ok: true, interviews: [], limit: 200 }
  );
});

test('a pasted transcript becomes a drafted interview to review', async ({ page, identity }) => {
  let drafted = false;
  identity.answerApi(`cms/interviews/${INTERVIEW_ID}/transcript`, {
    ok: true,
    interviewId: INTERVIEW_ID,
    version: 1,
  });
  identity.answerApi(`cms/interviews/${INTERVIEW_ID}/draft`, () => {
    drafted = true;
    return { ok: true, jobId: 'job-draft', status: 'queued', transcriptVersion: 1 };
  });
  let reads = 0;
  identity.answerApi(`cms/interviews/${INTERVIEW_ID}`, () => {
    reads += 1;
    if (!drafted) {
      return interviewAt('transcribed', {
        transcription: { version: 1, status: 'provided' },
        provenance: { source: 'transcript' },
      });
    }
    return interviewAt(reads < 4 ? 'drafting' : 'ready', {
      transcription: { version: 1, status: 'provided' },
      provenance: { source: 'transcript', drafting: { droppedQuotes: 0 } },
      qa: reads < 4 ? [] : DRAFTED_QA,
    });
  });

  await identity.signIn('/admin/interviews/new');
  await expect(page.getByRole('heading', { name: 'New interview', exact: true })).toBeVisible();
  await fillGuestAndConsent(page);
  await page
    .getByRole('textbox', { name: 'Transcript' })
    .fill(
      'Speaker 1: Why did your team start with a landing zone?\nSpeaker 2: Because every workload needed the same network and identity rules first.'
    );
  await expectNoSideways(page);

  const created = page.waitForRequest(
    (request) => request.method() === 'POST' && request.url().endsWith('/api/cms/interviews')
  );
  const pasted = page.waitForRequest((request) => request.url().endsWith('/transcript'));
  await page.getByRole('button', { name: 'Create interview' }).click();

  const createBody = (await created).postDataJSON();
  expect(createBody).toMatchObject({
    title: 'Landing zones in practice',
    guest: { name: 'Ada Example', role: 'Cloud architect' },
    consent: { confirmed: true },
  });
  expect(createBody.consent.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect((await pasted).postDataJSON().text).toContain('Speaker 2: Because every workload');

  await page.waitForURL((url) => url.pathname === `/admin/interviews/${INTERVIEW_ID}`);
  await expect(page.getByTestId('qa-item')).toHaveCount(2, { timeout: 20_000 });
  expect(drafted).toBe(true);
  await expect(page.getByTestId('interview-stage')).toHaveText('Draft ready for your review');
  await expect(page.getByRole('textbox', { name: 'Question 1' })).toHaveValue(DRAFTED_QA[0].q);
  await expect(page.getByText(/Check this answer: some of its words are not/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send to review' })).toBeVisible();
  await expectNoSideways(page);
});

test('a recording is uploaded in blocks with its hash, then queued for transcription', async ({
  page,
  identity,
}) => {
  const wav = silentWav(1);
  const blocks = [];
  let completed = false;
  identity.answerApi('cms/interviews/uploads', (request) => {
    const body = request.postDataJSON();
    return {
      uploadId: UPLOAD_ID,
      blockSize: 4 * 1024 * 1024,
      blockCount: Math.ceil(body.bytes / 4194304),
    };
  });
  identity.answerApi(`cms/interviews/uploads/${UPLOAD_ID}/blocks/0`, (request) => {
    blocks.push({
      method: request.method(),
      type: request.headers()['content-type'],
      bytes: request.postDataBuffer()?.length ?? 0,
    });
    return { ok: true, index: 0, bytes: wav.length };
  });
  identity.answerApi(`cms/interviews/uploads/${UPLOAD_ID}/complete`, () => {
    completed = true;
    return { ok: true, bytes: wav.length, contentType: 'audio/wav' };
  });
  identity.answerApi(`cms/interviews/${INTERVIEW_ID}/transcribe`, {
    ok: true,
    jobId: 'job-t',
    status: 'queued',
    transcriptVersion: 1,
  });
  identity.answerApi(`cms/interviews/${INTERVIEW_ID}`, () =>
    interviewAt('transcribing', {
      provenance: { source: 'upload', audio: { path: `audio/${INTERVIEW_ID}/${UPLOAD_ID}.wav` } },
      transcription: { version: 1, status: 'running', jobId: 'job-t' },
    })
  );

  await identity.signIn('/admin/interviews/new');
  await fillGuestAndConsent(page);
  await page.getByLabel('Upload a recording').check();
  await page.getByLabel('Recording file').setInputFiles({
    name: 'talk.wav',
    mimeType: 'audio/wav',
    buffer: wav,
  });
  await expect(page.getByText('Length: 1 s.', { exact: false })).toBeVisible();

  const opened = page.waitForRequest((request) =>
    request.url().endsWith('/api/cms/interviews/uploads')
  );
  const queued = page.waitForRequest((request) => request.url().endsWith('/transcribe'));
  await page.getByRole('button', { name: 'Create interview' }).click();

  expect((await opened).postDataJSON()).toEqual({
    interviewId: INTERVIEW_ID,
    fileName: 'talk.wav',
    contentType: 'audio/wav',
    bytes: wav.length,
    sha256: createHash('sha256').update(wav).digest('hex'),
    durationSec: 1,
  });
  await queued;
  expect(blocks).toEqual([{ method: 'PUT', type: 'application/octet-stream', bytes: wav.length }]);
  expect(completed).toBe(true);
  await page.waitForURL((url) => url.pathname === `/admin/interviews/${INTERVIEW_ID}`);
  await expect(page.getByTestId('interview-stage')).toHaveText('Transcribing the recording');
  await expectNoSideways(page);
});

test('a recording over 9.5 hours is refused before anything is sent', async ({
  page,
  identity,
}) => {
  const created = [];
  page.on('request', (request) => {
    if (request.url().endsWith('/api/cms/interviews') && request.method() === 'POST') {
      created.push(request);
    }
  });
  await identity.signIn('/admin/interviews/new');
  await fillGuestAndConsent(page);
  await page.getByLabel('Upload a recording').check();
  await page.getByLabel('Recording file').setInputFiles({
    name: 'long.mp3',
    mimeType: 'audio/mpeg',
    buffer: longMp3(34_201),
  });
  await expect(
    page.getByText(/the most one transcription can take is 9 hours 30 minutes/)
  ).toBeVisible();
  await page.getByRole('button', { name: 'Create interview' }).click();
  await expect(
    page.getByText('Some fields need attention; each says what is missing.')
  ).toBeVisible();
  expect(created).toHaveLength(0);
});
