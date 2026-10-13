/**
 * The podcast voice card (#432, 2026-09-26): "not configured" reads as a
 * state, not a failure; a configured key shows the plan, the credits, the
 * reset date and what the last render billed; the free plan says it is not
 * published; and the live check runs only on a click, once, and shows the
 * audio, the characters billed and the credits left, or the server's refusal
 * word for word.
 *
 * Since #725 the card also holds the Podcast voices picker (its own tests are
 * in PodcastVoices.test.jsx); here, the live check waits for a saved pair and
 * a paid-only voice points at the picker.
 *
 * Since 2026-09-27 the last stored sample plays on load, for nothing, and a
 * new render asks first: Cancel sends nothing, Render sends one request.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

import ElevenLabsCard, {
  ELEVENLABS_SAMPLE_ROUTE,
  ELEVENLABS_STATUS_ROUTE,
  renderSourceOf,
} from './ElevenLabsCard';
import { ELEVENLABS_VOICES_ROUTE } from './PodcastVoices';
import { settingRoute } from './settingShared';

const getJSON = vi.fn();
const postJSON = vi.fn();
const toast = vi.fn();

vi.mock('@/lib/api', () => ({
  getJSON: (...args) => getJSON(...args),
  postJSON: (...args) => postJSON(...args),
  sendJSON: vi.fn(),
  authedFetch: vi.fn(),
}));
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast }) }));
vi.mock('@/lib/functionsBase', () => ({
  resolveMediaUrl: (url) => `https://api.example.test${url}`,
}));

const SAMPLE = { characters: 257, turns: 2 };

const UNSEEDED = {
  success: true,
  configured: false,
  reason:
    'ELEVENLABS_API_KEY is not configured. Create a key at https://elevenlabs.io/app/developers/api-keys and seed it as the ELEVENLABS-API-KEY secret at https://hybridcloudworks.com/admin/integrations?tab=keys.',
  subscription: null,
  subscriptionError: null,
  lastRender: null,
  lastRenderError: null,
  sample: SAMPLE,
};

const FREE_MONTH = {
  success: true,
  configured: true,
  reason: null,
  subscription: {
    tier: 'free',
    status: 'free',
    freePlan: true,
    creditsUsed: 8912,
    creditLimit: 10000,
    creditsLeft: 1088,
    overageCredits: 0,
    resetAt: '2026-10-26T00:00:00.000Z',
  },
  subscriptionError: null,
  lastRender: {
    characters: 8912,
    estimated: false,
    at: null,
    source: 'podcast:audio',
    model: 'eleven_v3',
  },
  lastRenderError: null,
  sample: SAMPLE,
};

const SAMPLE_URL = '/api/public/media/podcast/sample/elevenlabs-live-check.mp3';

const RENDERED = {
  ok: true,
  audioUrl: `${SAMPLE_URL}?v=1790000000000`,
  audioError: null,
  charactersBilled: 257,
  billedEstimated: false,
  creditsLeftBefore: 10000,
  creditsLeft: 9743,
  creditLimit: 10000,
  tier: 'free',
  freePlan: true,
  lastSample: {
    audioUrl: `${SAMPLE_URL}?v=1790000000000`,
    renderedAt: '2026-09-27T15:00:00.000Z',
    voices: {
      Maya: { voiceId: 'MayaVoice00000000001', name: 'Bella' },
      Elena: { voiceId: 'ElenaVoice0000000002', name: 'Jessica' },
    },
    charactersBilled: 257,
    billedEstimated: false,
    model: 'eleven_v3',
    recorded: true,
  },
};

/** The sample the owner's two checks of 2026-09-27 left, as the status read returns it. */
const LAST_SAMPLE = {
  audioUrl: `${SAMPLE_URL}?v=1790000000001`,
  renderedAt: '2026-09-27T14:03:00.000Z',
  voices: {
    Maya: { voiceId: 'MayaVoice00000000001', name: 'Bella' },
    Elena: { voiceId: 'ElenaVoice0000000002', name: 'Jessica' },
  },
  charactersBilled: 257,
  billedEstimated: false,
  model: 'eleven_v3',
  recorded: true,
};
const WITH_SAMPLE = { ...FREE_MONTH, lastSample: LAST_SAMPLE, lastSampleError: null };

/** The saved podcast voices (#725), as the platform-settings route answers. */
const SAVED_VOICES = {
  success: true,
  setting: 'podcast-voices',
  value: { Maya: 'MayaVoice00000000001', Elena: 'ElenaVoice0000000002' },
  exists: true,
  stored: 'valid',
  updatedAt: '2026-09-26T12:00:00.000Z',
};
const NO_VOICES = {
  success: true,
  setting: 'podcast-voices',
  value: { Maya: '', Elena: '' },
  exists: false,
  stored: null,
  updatedAt: null,
};
const VOICE_LIST = {
  success: true,
  configured: true,
  rule: 'On the free plan ElevenLabs lets the API use your own voices and its default voices, not Voice Library voices.',
  plan: { tier: 'free', freePlan: true },
  subscriptionError: null,
  voices: [],
  truncated: false,
  voicesError: null,
};

/**
 * One answer per route. `status` is what the ElevenLabs status route returns
 * (a value, or a function for a sequence); `voices` is the saved setting;
 * `voiceList` is the key's voice listing.
 */
let answers;
const routeAnswer = async (route) => {
  if (route === ELEVENLABS_STATUS_ROUTE) {
    return typeof answers.status === 'function' ? answers.status() : answers.status;
  }
  if (route === settingRoute('podcast-voices')) return answers.voices;
  if (route === ELEVENLABS_VOICES_ROUTE) return answers.voiceList;
  throw new Error(`unexpected route ${route}`);
};
const statusReads = () =>
  getJSON.mock.calls.filter(([route]) => route === ELEVENLABS_STATUS_ROUTE).length;

const RENDER_BUTTON = /Render a new sample/;

/** The render button, once the saved voices have loaded and enabled it. */
async function renderButton() {
  const button = await screen.findByRole('button', { name: RENDER_BUTTON });
  await waitFor(() => expect(button.disabled).toBe(false));
  return button;
}

/** Click Render a new sample; the confirmation that opens. */
async function askToRender() {
  fireEvent.click(await renderButton());
  return within(await screen.findByRole('dialog'));
}

/** Click Render a new sample and confirm it. */
async function confirmRender() {
  const dialog = await askToRender();
  fireEvent.click(dialog.getByRole('button', { name: /^Render \(about 257 credits\)$/ }));
}

beforeEach(() => {
  answers = { status: FREE_MONTH, voices: SAVED_VOICES, voiceList: VOICE_LIST };
  getJSON.mockReset().mockImplementation(routeAnswer);
  postJSON.mockReset();
  toast.mockReset();
});

describe('ElevenLabsCard', () => {
  it('shows "Not configured" and the sentence that says how to seed it, as a state rather than an error', async () => {
    answers.status = UNSEEDED;
    render(<ElevenLabsCard authReady />);
    expect(await screen.findByText('Not configured')).toBeTruthy();
    expect(screen.getByText(/ELEVENLABS-API-KEY secret/)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    // Nothing to render without a key.
    expect(screen.getByRole('button', { name: RENDER_BUTTON }).disabled).toBe(true);
    // And no "no sample yet" promise either: without a key there is no next render.
    expect(screen.queryByText(/No sample yet/)).toBeNull();
    expect(getJSON).toHaveBeenCalledWith(ELEVENLABS_STATUS_ROUTE);
    // Without a key there is no list to ask for.
    expect(getJSON).not.toHaveBeenCalledWith(ELEVENLABS_VOICES_ROUTE);
  });

  it('shows the plan, the credits used of the limit, the reset date and what the last render billed', async () => {
    render(<ElevenLabsCard authReady />);
    expect(await screen.findByText('free (free)')).toBeTruthy();
    expect(screen.getByText('8,912 used of 10,000, 1,088 left')).toBeTruthy();
    expect(screen.getByText('2026-10-26 (UTC)')).toBeTruthy();
    expect(screen.getByText('Last render billed 8,912 characters, an episode')).toBeTruthy();
  });

  it('reads the last render by its product first and its source as the fallback (ADR 0034 slice 5)', async () => {
    // An episode row written since slice 5: the task as source, the slug as product.
    answers.status = {
      ...FREE_MONTH,
      lastRender: { ...FREE_MONTH.lastRender, source: 'ai:podcastVoice', product: 'podcast:audio' },
    };
    const { unmount } = render(<ElevenLabsCard authReady />);
    expect(await screen.findByText('Last render billed 8,912 characters, an episode')).toBeTruthy();
    unmount();

    // A row written before slice 5: source alone, no product.
    answers.status = {
      ...FREE_MONTH,
      lastRender: { ...FREE_MONTH.lastRender, source: 'podcast:audio', product: null },
    };
    const old = render(<ElevenLabsCard authReady />);
    expect(await screen.findByText('Last render billed 8,912 characters, an episode')).toBeTruthy();
    old.unmount();

    // The live check keeps its own source either way.
    answers.status = {
      ...FREE_MONTH,
      lastRender: { ...FREE_MONTH.lastRender, source: 'podcast:sample', product: null },
    };
    render(<ElevenLabsCard authReady />);
    expect(
      await screen.findByText('Last render billed 8,912 characters, a live check')
    ).toBeTruthy();

    expect(renderSourceOf({ source: 'ai:podcastVoice', product: 'podcast:audio' })).toBe(
      'an episode'
    );
    expect(renderSourceOf({ source: 'podcast:audio' })).toBe('an episode');
    expect(renderSourceOf({ source: 'podcast:sample', product: null })).toBe('a live check');
    expect(renderSourceOf({ source: 'ai:podcastVoice' })).toBeUndefined();
    expect(renderSourceOf(null)).toBeUndefined();
  });

  it('says a free-plan episode is not published, and why', async () => {
    render(<ElevenLabsCard authReady />);
    expect(await screen.findByText(/Free plan: no commercial licence/)).toBeTruthy();
    expect(screen.getByText(/never\s+published to Podbean; approval refuses them/)).toBeTruthy();
  });

  it('does not show the free-plan note on a paid plan', async () => {
    answers.status = {
      ...FREE_MONTH,
      subscription: {
        ...FREE_MONTH.subscription,
        tier: 'creator',
        status: 'active',
        freePlan: false,
      },
    };
    render(<ElevenLabsCard authReady />);
    await screen.findByText('creator (active)');
    expect(screen.queryByText(/Free plan: no commercial licence/)).toBeNull();
  });

  it('shows why the account could not be read, and "no render yet" only when there was none', async () => {
    answers.status = {
      ...FREE_MONTH,
      subscription: null,
      subscriptionError:
        'Could not read the ElevenLabs subscription (HTTP 403 insufficient_permissions: the key needs the User → Read permission (user_read), set at https://elevenlabs.io/app/developers/api-keys); nothing was sent, so no credits were spent.',
      lastRender: null,
    };
    render(<ElevenLabsCard authReady />);
    expect(await screen.findByText(/User → Read permission \(user_read\)/)).toBeTruthy();
    expect(screen.getByText('No ElevenLabs render recorded yet.')).toBeTruthy();
  });

  it('reports a failed status read as an alert with a retry that reads again', async () => {
    let reads = 0;
    answers.status = () => {
      reads += 1;
      if (reads === 1) throw new Error('HTTP 500');
      return FREE_MONTH;
    };
    render(<ElevenLabsCard authReady />);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('ElevenLabs: HTTP 500');
    fireEvent.click(screen.getByRole('button', { name: /Retry/ }));
    expect(await screen.findByText('free (free)')).toBeTruthy();
    expect(statusReads()).toBe(2);
  });

  it('never runs the live check on load, and waits for auth before reading', async () => {
    const { rerender } = render(<ElevenLabsCard authReady={false} />);
    expect(getJSON).not.toHaveBeenCalled();
    rerender(<ElevenLabsCard authReady />);
    await screen.findByText('free (free)');
    expect(postJSON).not.toHaveBeenCalled();
  });

  it('renders on a confirmed click, once, and plays the new sample with the characters billed and the credits left', async () => {
    let resolve;
    postJSON.mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        })
    );
    render(<ElevenLabsCard authReady />);
    const button = await renderButton();
    expect(button.textContent).toBe('Render a new sample (about 257 credits)');
    expect(screen.getByText(/fixed two-turn sample of 257 characters/)).toBeTruthy();

    await confirmRender();
    expect(postJSON).toHaveBeenCalledTimes(1);
    expect(postJSON).toHaveBeenCalledWith(ELEVENLABS_SAMPLE_ROUTE, {});
    // While it runs the button is disabled, so a second click asks nothing and sends nothing.
    await waitFor(() => expect(button.disabled).toBe(true));
    fireEvent.click(button);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(postJSON).toHaveBeenCalledTimes(1);

    resolve(RENDERED);
    expect(await screen.findByText('Characters billed: 257')).toBeTruthy();
    expect(screen.getByText('Credits left: 9,743 of 10,000')).toBeTruthy();
    // One player, in Last sample, on the new sample.
    const players = document.querySelectorAll('audio');
    expect(players).toHaveLength(1);
    expect(players[0].getAttribute('src')).toBe(
      'https://api.example.test/api/public/media/podcast/sample/elevenlabs-live-check.mp3?v=1790000000000'
    );
    expect(screen.getByText('Kept as the Last sample above, to replay for nothing.')).toBeTruthy();
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Live check rendered',
        description: '257 characters billed; 9,743 credits left.',
      })
    );
    // The figures above it are read again, so they show the spend.
    await waitFor(() => expect(statusReads()).toBe(2));
  });

  it('shows a refused live check word for word, and plays nothing', async () => {
    const sentence =
      'ElevenLabs has 100 credits left of 10,000, this episode needs 257; the allowance resets on 2026-10-26 (UTC). Nothing was sent, so no credits were spent.';
    postJSON.mockRejectedValue(new Error(sentence));
    render(<ElevenLabsCard authReady />);
    await confirmRender();
    expect(await screen.findByText(sentence)).toBeTruthy();
    expect(document.querySelector('audio')).toBeNull();
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Live check not rendered', variant: 'destructive' })
    );
  });

  it('waits for a saved pair of podcast voices before it will run, and says so', async () => {
    answers.voices = NO_VOICES;
    render(<ElevenLabsCard authReady />);
    expect(
      await screen.findByText('Choose the podcast voices first: save a voice for each host above.')
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: RENDER_BUTTON }).disabled).toBe(true);
    expect(getJSON).toHaveBeenCalledWith(settingRoute('podcast-voices'));
  });

  it('points a paid-only voice at the picker, beside the server’s sentence', async () => {
    const sentence =
      'ElevenLabs refused this on the current plan (HTTP 402 paid_plan_required): a voice or feature it needs is paid-only. Choose voices your plan allows under Podcast voices at https://hybridcloudworks.com/admin/platform?tab=audio. ElevenLabs said: {"detail":{"code":"paid_plan_required"}}';
    postJSON.mockRejectedValue(Object.assign(new Error(sentence), { code: 'paid_plan_required' }));
    render(<ElevenLabsCard authReady />);
    await confirmRender();
    expect(await screen.findByText(sentence)).toBeTruthy();
    expect(
      screen.getByText(
        'Choose voices your plan allows under Podcast voices above (the ones listed as usable), Save, and run the check again.'
      )
    ).toBeTruthy();
  });

  it('says so when the sample was billed but its audio could not be stored', async () => {
    postJSON.mockResolvedValue({
      ...RENDERED,
      audioUrl: null,
      audioError: 'The sample was rendered and billed but not stored: container missing',
      lastSample: null,
    });
    render(<ElevenLabsCard authReady />);
    await confirmRender();
    expect(await screen.findByText(/rendered and billed but not stored/)).toBeTruthy();
    expect(screen.getByText('Characters billed: 257')).toBeTruthy();
    expect(document.querySelector('audio')).toBeNull();
  });
});

describe('the last sample, replayed for nothing', () => {
  it('plays the stored sample on load, with its date, its voices and that replaying costs nothing, sending nothing', async () => {
    answers.status = WITH_SAMPLE;
    render(<ElevenLabsCard authReady />);
    const section = within((await screen.findByText('Last sample')).closest('section'));
    const audio = document.querySelector('audio');
    expect(audio.getAttribute('src')).toBe(
      'https://api.example.test/api/public/media/podcast/sample/elevenlabs-live-check.mp3?v=1790000000001'
    );
    expect(audio.hasAttribute('controls')).toBe(true);
    expect(
      section.getByText('Rendered 2026-09-27 14:03 (UTC), 257 characters billed then.')
    ).toBeTruthy();
    expect(section.getByText('Voices: Maya: Bella, Elena: Jessica.')).toBeTruthy();
    expect(section.getByText('Replaying costs nothing.')).toBeTruthy();
    // Loading and replaying spend nothing: no render was asked for.
    expect(postJSON).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('names an unrecorded sample’s voices from the key’s voice list, and says when the voices are not known', async () => {
    answers.status = {
      ...FREE_MONTH,
      lastSample: {
        ...LAST_SAMPLE,
        recorded: false,
        voices: {
          Maya: { voiceId: 'MayaVoice00000000001', name: null },
          Elena: { voiceId: 'ElenaVoice0000000002', name: null },
        },
      },
    };
    answers.voiceList = {
      ...VOICE_LIST,
      voices: [
        {
          voiceId: 'MayaVoice00000000001',
          name: 'Bella',
          type: 'default',
          usable: true,
          labels: {},
        },
        {
          voiceId: 'ElenaVoice0000000002',
          name: 'Jessica',
          type: 'default',
          usable: true,
          labels: {},
        },
      ],
    };
    const { unmount } = render(<ElevenLabsCard authReady />);
    expect(await screen.findByText('Voices: Maya: Bella, Elena: Jessica.')).toBeTruthy();
    // One listing for the picker and the names both.
    expect(getJSON.mock.calls.filter(([route]) => route === ELEVENLABS_VOICES_ROUTE)).toHaveLength(
      1
    );
    unmount();

    answers.status = { ...FREE_MONTH, lastSample: { ...LAST_SAMPLE, voices: null } };
    render(<ElevenLabsCard authReady />);
    expect(await screen.findByText('Voices: not recorded.')).toBeTruthy();
  });

  it('says there is no sample yet, with no player, when none is stored', async () => {
    answers.status = { ...FREE_MONTH, lastSample: null, lastSampleError: null };
    render(<ElevenLabsCard authReady />);
    expect(
      await screen.findByText(
        'No sample yet. The next render is kept here, and replaying it costs nothing.'
      )
    ).toBeTruthy();
    expect(screen.queryByText('Last sample')).toBeNull();
    expect(document.querySelector('audio')).toBeNull();

    // Nor does the confirmation offer a replay that does not exist.
    const dialog = await askToRender();
    expect(
      dialog.getByText(
        'This spends about 257 credits of the 1,088 left. There is no sample to replay yet.'
      )
    ).toBeTruthy();
  });

  it('says why the last sample could not be read, rather than "none yet"', async () => {
    answers.status = {
      ...FREE_MONTH,
      lastSample: null,
      lastSampleError: 'The last sample could not be read.',
    };
    render(<ElevenLabsCard authReady />);
    expect(await screen.findByText('Last sample: The last sample could not be read.')).toBeTruthy();
    expect(screen.queryByText(/No sample yet/)).toBeNull();
  });
});

describe('a new render asks first', () => {
  it('names the credits left and the free replay, and Cancel renders nothing', async () => {
    answers.status = WITH_SAMPLE;
    render(<ElevenLabsCard authReady />);
    const dialog = await askToRender();
    expect(dialog.getByText('Render a new sample?')).toBeTruthy();
    expect(
      dialog.getByText(
        'This spends about 257 credits of the 1,088 left. The last sample can be replayed free under Last sample.'
      )
    ).toBeTruthy();

    fireEvent.click(dialog.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(postJSON).not.toHaveBeenCalled();
    // The last sample is still there to replay.
    expect(document.querySelector('audio')).not.toBeNull();
  });

  it('renders once when confirmed', async () => {
    answers.status = WITH_SAMPLE;
    postJSON.mockResolvedValue(RENDERED);
    render(<ElevenLabsCard authReady />);
    await confirmRender();
    await waitFor(() => expect(postJSON).toHaveBeenCalledTimes(1));
    expect(postJSON).toHaveBeenCalledWith(ELEVENLABS_SAMPLE_ROUTE, {});
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // The new sample replaces the old one in Last sample.
    expect(
      await screen.findByText('Rendered 2026-09-27 15:00 (UTC), 257 characters billed then.')
    ).toBeTruthy();
    expect(document.querySelector('audio').getAttribute('src')).toContain('?v=1790000000000');
  });

  it('says the last sample already used these voices when the saved pair is the same, and not otherwise', async () => {
    answers.status = WITH_SAMPLE;
    const { unmount } = render(<ElevenLabsCard authReady />);
    let dialog = await askToRender();
    expect(dialog.getByText('The last sample already used these voices.')).toBeTruthy();
    // It asks; it does not block.
    expect(dialog.getByRole('button', { name: /^Render \(about 257 credits\)$/ }).disabled).toBe(
      false
    );
    unmount();

    answers.voices = {
      ...SAVED_VOICES,
      value: { Maya: 'OtherVoice0000000003', Elena: 'ElenaVoice0000000002' },
    };
    render(<ElevenLabsCard authReady />);
    dialog = await askToRender();
    expect(dialog.queryByText('The last sample already used these voices.')).toBeNull();
  });

  it('still asks when the credits left are unknown, and says so', async () => {
    answers.status = {
      ...WITH_SAMPLE,
      subscription: null,
      subscriptionError: 'Could not read it.',
    };
    render(<ElevenLabsCard authReady />);
    const dialog = await askToRender();
    expect(
      dialog.getByText(
        'This spends about 257 credits; the credits left could not be read. The last sample can be replayed free under Last sample.'
      )
    ).toBeTruthy();
  });
});
