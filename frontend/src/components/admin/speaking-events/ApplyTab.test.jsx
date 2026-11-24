/**
 * Speaking → Events to apply to, as the owner sees it (#1823): the no-key
 * state, the rows, the calendar's clash marks, and the three writes. What
 * must hold above all: nothing asks for an estimate unless its button is
 * pressed, a save carries the version it was read at, and someone else's
 * text is shown as text.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

import ApplyTab, {
  AI_SWITCHES_HREF,
  CHANGED_ELSEWHERE,
  ESTIMATE_LABEL,
  KEYS_HREF,
  SWITCHED_OFF_CODE,
} from './ApplyTab';
import ApplyCalendar, { UNMARKED_SHOWN, describeDay } from './ApplyCalendar';
import { marksForMonth } from './applyModel';
import { EVENTS_ROUTE, REFRESH_ROUTE } from './useApplyEvents';

const getJSON = vi.fn();
const sendJSON = vi.fn();

vi.mock('@/lib/api', () => ({
  getJSON: (...args) => getJSON(...args),
  sendJSON: (...args) => sendJSON(...args),
}));
vi.mock('@/hooks/useAuthReady', () => ({ useAuthReady: () => ({ authReady: true }) }));
vi.mock('react-router', () => ({
  Link: ({ to, children, ...rest }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));

const event = (over = {}) => ({
  id: 'event-1',
  title: 'Example Community Day',
  tagline: 'A free day of talks',
  url: 'https://www.communitydays.org/event/2099-03-06/example-community-day',
  website: null,
  startDate: '2099-03-06',
  endDate: '2099-03-07',
  eventType: 'In Person',
  city: 'Exampleville',
  region: 'Ontario',
  country: 'CA',
  costTiers: ['Free'],
  callUrl: 'https://example.org/speak',
  callCloses: '2099-01-15',
  cancelled: false,
  postponed: false,
  note: null,
  ...over,
});

const answer = (over = {}) => ({
  ok: true,
  status: 'ok',
  keySet: true,
  events: [event()],
  saved: [],
  fetchedAt: '2026-11-24T12:00:00.000Z',
  total: 1,
  truncated: false,
  error: null,
  notice: null,
  topics: {
    count: 3,
    hasBio: true,
    from: ['Speaking hub sessions and topics', 'Speaker profile bio'],
  },
  ...over,
});

const read = (data, error = '') => ({ data, loaded: true, error, pending: false });
const hubData = (talks = []) => ({
  sessionize: read([]),
  stored: read([]),
  rows: { mergedEvents: [], manualEntries: talks },
});
const acceptedTalk = (over = {}) => ({
  _docId: 'm1',
  eventName: 'Other Conf',
  date: '2099-03-07',
  status: 'accepted',
  ...over,
});

/** What the owner saved for an event, as the server sends it. */
const savedNote = (status, over = {}) => ({
  eventId: 'event-1',
  status,
  notes: '',
  costs: { travel: null, lodging: null, other: null },
  estimate: null,
  etag: '"n1"',
  ...over,
});

const show = async (data = hubData()) => {
  render(<ApplyTab data={data} />);
  await waitFor(() => expect(getJSON).toHaveBeenCalledWith(EVENTS_ROUTE));
};

beforeEach(() => {
  getJSON.mockReset();
  sendJSON.mockReset();
  getJSON.mockResolvedValue(answer());
  // A Refresh answers the list, as the server does; the other writes answer ok.
  sendJSON.mockImplementation(async (route) => (route === REFRESH_ROUTE ? answer() : { ok: true }));
});

describe('before the key is set', () => {
  it('says plainly that the key is not set, links the Keys tab, and shows no list or Refresh', async () => {
    getJSON.mockResolvedValue(
      answer({
        status: 'no_key',
        keySet: false,
        events: [],
        fetchedAt: null,
        topics: { count: 0, hasBio: false, from: [] },
      })
    );
    await show();
    expect(await screen.findByText(/The Community Days key is not set yet/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Integrations → Keys' })).toHaveAttribute(
      'href',
      KEYS_HREF
    );
    expect(KEYS_HREF).toBe('/admin/integrations?tab=keys');
    expect(screen.queryByRole('list', { name: 'Events to apply to' })).toBeNull();
    expect(screen.queryByLabelText('Search events')).toBeNull();
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeDisabled();
    // The calendar still shows, for the owner's own talks.
    expect(
      screen.getByRole('region', { name: 'Calendar of events and your talks' })
    ).toBeInTheDocument();
    expect(sendJSON).not.toHaveBeenCalled();
  });
});

describe('the list', () => {
  it('shows each event with its place, dates, closing day, cost, status and links', async () => {
    await show();
    const row = (await screen.findByText('Example Community Day')).closest('li');
    const inRow = within(row);
    expect(inRow.getByRole('link', { name: /^Example Community Day/ })).toHaveAttribute(
      'href',
      'https://www.communitydays.org/event/2099-03-06/example-community-day'
    );
    expect(inRow.getByText('Exampleville, Ontario, CA (In Person)')).toBeInTheDocument();
    expect(inRow.getByText('Mar 6–7, 2099')).toBeInTheDocument();
    expect(inRow.getByText(/Closes Jan 15, 2099, about \d+ days left/)).toBeInTheDocument();
    expect(
      inRow.getByRole('link', { name: 'Apply to Example Community Day (opens in a new tab)' })
    ).toHaveAttribute('href', 'https://example.org/speak');
    expect(inRow.getByText('Free')).toBeInTheDocument();
    expect(inRow.getByText('Not decided')).toBeInTheDocument();
    expect(inRow.getByText('None entered')).toBeInTheDocument();
    expect(inRow.getByText(/No estimate yet/)).toBeInTheDocument();
  });

  it('shows the owner’s saved status, costs with their total, notes and estimate, labelled as a rough estimate', async () => {
    getJSON.mockResolvedValue(
      answer({
        events: [
          event({
            note: {
              eventId: 'event-1',
              status: 'applied',
              notes: 'Sent two talks.',
              costs: { travel: 300, lodging: 410.5, other: null },
              estimate: {
                percent: 62,
                reasons: ['Fits the theme.', 'Close to home.'],
                madeAt: '2026-11-24T12:00:00.000Z',
                topicsFrom: ['Speaker profile bio'],
              },
              etag: '"v1"',
            },
          }),
        ],
      })
    );
    await show();
    const row = (await screen.findByText('Example Community Day')).closest('li');
    const inRow = within(row);
    expect(inRow.getByText('Applied')).toBeInTheDocument();
    expect(inRow.getByText('Travel 300, Lodging 410.5 · total 710.5')).toBeInTheDocument();
    expect(inRow.getByText('Sent two talks.')).toBeInTheDocument();
    expect(inRow.getByTestId('estimate-percent')).toHaveTextContent('62%');
    expect(inRow.getByText(new RegExp(ESTIMATE_LABEL))).toBeInTheDocument();
    expect(inRow.getByText('Fits the theme.')).toBeInTheDocument();
    expect(inRow.getByRole('button', { name: /Estimate again/ })).toBeInTheDocument();
    expect(ESTIMATE_LABEL).toBe('Rough estimate, not a measurement');
  });

  it('shows someone else’s text as text, and never makes a link from anything but http or https', async () => {
    getJSON.mockResolvedValue(
      answer({
        events: [
          event({
            title: '<img src=x onerror=alert(1)> Day',
            tagline: '<script>alert(2)</script>',
            url: 'javascript:alert(3)',
            website: 'javascript:alert(4)',
            callUrl: 'data:text/html,hi',
            note: {
              eventId: 'event-1',
              status: '',
              notes: '',
              costs: {},
              estimate: {
                percent: 10,
                reasons: ['<b>bold</b> reason'],
                madeAt: null,
                topicsFrom: [],
              },
              etag: '"v1"',
            },
          }),
        ],
      })
    );
    await show();
    const row = (await screen.findByText('<img src=x onerror=alert(1)> Day')).closest('li');
    expect(row.querySelector('img')).toBeNull();
    expect(row.querySelector('script')).toBeNull();
    expect(row.querySelector('b')).toBeNull();
    expect(within(row).getByText('<b>bold</b> reason')).toBeInTheDocument();
    expect(within(row).queryAllByRole('link')).toEqual([]);
  });

  it('marks cancelled and postponed events in words and turns Estimate off for a cancelled one', async () => {
    getJSON.mockResolvedValue(
      answer({
        events: [
          event({ cancelled: true }),
          event({ id: 'event-2', title: 'Later Day', postponed: true }),
        ],
      })
    );
    await show();
    const cancelled = (await screen.findByText('Example Community Day')).closest('li');
    expect(within(cancelled).getByText('Cancelled')).toBeInTheDocument();
    expect(within(cancelled).getByText(/not on the calendar/)).toBeInTheDocument();
    expect(within(cancelled).getByRole('button', { name: /^Estimate/ })).toBeDisabled();
    expect(
      within(screen.getByText('Later Day').closest('li')).getByText('Postponed')
    ).toBeInTheDocument();
  });

  it('says so when the copy is stale, with the server’s sentence', async () => {
    getJSON.mockResolvedValue(
      answer({
        status: 'stale',
        error:
          'Community Days did not accept the key: it is missing, wrong, deleted or expired. Paste a current key on Integrations → Keys (HTTP 401).',
      })
    );
    await show();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Showing the last copy that was read.');
    expect(alert).toHaveTextContent('did not accept the key');
    expect(screen.getByText('Example Community Day')).toBeInTheDocument();
  });

  it('says there are no open calls when the list is empty, and keeps saved events that are no longer listed', async () => {
    getJSON.mockResolvedValue(
      answer({
        events: [],
        saved: [
          {
            eventId: 'event-gone',
            status: 'accepted',
            notes: 'Booked.',
            costs: {},
            estimate: null,
            event: {
              title: 'Closed Call Day',
              startDate: '2099-02-01',
              endDate: '2099-02-01',
              city: 'Sampletown',
              country: 'US',
              eventType: 'Hybrid',
            },
            etag: '"g1"',
          },
        ],
      })
    );
    await show();
    expect(await screen.findByText('No open calls for speakers right now.')).toBeInTheDocument();
    const saved = screen.getByText('Closed Call Day').closest('li');
    expect(within(saved).getByText('Accepted')).toBeInTheDocument();
    expect(within(saved).getByText(/Feb 1, 2099 · Sampletown, US \(Hybrid\)/)).toBeInTheDocument();
  });

  it('lets the owner change the status and costs of an event that has left the list, not only clear it', async () => {
    // The call has closed, which is when the answer comes: Applied becomes Accepted.
    const gone = (over = {}) => ({
      eventId: 'event-gone',
      status: 'applied',
      notes: 'Two talks sent.',
      costs: { travel: null, lodging: null, other: null },
      estimate: null,
      event: {
        title: 'Closed Call Day',
        startDate: '2099-02-01',
        endDate: '2099-02-01',
        city: 'Sampletown',
        country: 'US',
        eventType: 'Hybrid',
      },
      etag: '"g1"',
      ...over,
    });
    getJSON.mockResolvedValue(answer({ events: [], saved: [gone()] }));
    await show();
    const saved = (await screen.findByText('Closed Call Day')).closest('li');
    expect(within(saved).getByText('Applied')).toBeInTheDocument();
    expect(
      within(saved).getByRole('button', { name: 'Clear what is saved for Closed Call Day' })
    ).toBeInTheDocument();

    fireEvent.click(
      within(saved).getByRole('button', {
        name: 'Edit status, costs and notes for Closed Call Day',
      })
    );
    const form = within(saved).getByRole('form', { name: 'Your notes for Closed Call Day' });
    expect(within(form).getByLabelText('Your status')).toHaveValue('applied');
    expect(within(form).getByLabelText('Notes')).toHaveValue('Two talks sent.');
    fireEvent.change(within(form).getByLabelText('Your status'), { target: { value: 'accepted' } });
    fireEvent.change(within(form).getByLabelText('Travel'), { target: { value: '420' } });
    getJSON.mockResolvedValue(
      answer({
        events: [],
        saved: [
          gone({
            status: 'accepted',
            costs: { travel: 420, lodging: null, other: null },
            etag: '"g2"',
          }),
        ],
      })
    );
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(sendJSON).toHaveBeenCalledWith(`${EVENTS_ROUTE}/event-gone`, 'PUT', {
        status: 'accepted',
        notes: 'Two talks sent.',
        costs: { travel: 420, lodging: null, other: null },
        etag: '"g1"',
      })
    );
    // The form closes and the row shows what is now saved.
    await waitFor(() => expect(screen.queryByRole('form')).toBeNull());
    const after = screen.getByText('Closed Call Day').closest('li');
    expect(within(after).getByText('Accepted')).toBeInTheDocument();
    expect(after).toHaveTextContent('Your costs: Travel 420 · total 420');
  });

  it('shows the read’s own error with a way to try again', async () => {
    getJSON.mockRejectedValueOnce(new Error('HTTP 500'));
    render(<ApplyTab data={hubData()} />);
    expect(await screen.findByText('The events could not be loaded: HTTP 500')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Try again/ }));
    expect(await screen.findByText('Example Community Day')).toBeInTheDocument();
  });
});

describe('clashes', () => {
  it('flags a clash on the row and on the calendar, in words and with a mark that is not colour alone', async () => {
    getJSON.mockResolvedValue(answer({ events: [event({ note: savedNote('applied') })] }));
    await show(hubData([acceptedTalk()]));
    const row = (await screen.findByText('Example Community Day')).closest('li');
    const clash = within(row).getByTestId('clash');
    expect(clash).toHaveTextContent(
      'Clash: these dates meet Other Conf (Accepted talk on Mar 7, 2099).'
    );

    const calendar = screen.getByRole('region', { name: 'Calendar of events and your talks' });
    expect(within(calendar).getByText('March 2099')).toBeInTheDocument();
    const day = within(calendar).getByRole('button', { name: /Mar 7, 2099: clash/ });
    expect(day).toHaveAttribute('data-overlap', 'true');
    // The first day of the event has no talk on it: marked, but not a clash.
    expect(
      within(calendar).getByRole('button', { name: 'Mar 6, 2099: 1 event you marked' })
    ).not.toHaveAttribute('data-overlap');

    fireEvent.click(day);
    expect(within(calendar).getByText('Mar 7, 2099 (clash)')).toBeInTheDocument();
    expect(
      within(calendar).getByText('Event: Example Community Day (Applied)')
    ).toBeInTheDocument();
    expect(within(calendar).getByText('Your talk: Other Conf (Accepted)')).toBeInTheDocument();
  });

  it('keeps an event with no status quiet: no clash on the row or the calendar, only what its dates would meet', async () => {
    // The same talk on the same day as above, but the owner has not marked the event.
    await show(hubData([acceptedTalk()]));
    const row = (await screen.findByText('Example Community Day')).closest('li');
    expect(within(row).queryByTestId('clash')).toBeNull();
    expect(within(row).getByTestId('would-meet')).toHaveTextContent(
      'If you go, these dates meet Other Conf (Accepted talk on Mar 7, 2099).'
    );

    const calendar = screen.getByRole('region', { name: 'Calendar of events and your talks' });
    expect(within(calendar).queryByRole('button', { name: /clash/ })).toBeNull();
    const day = within(calendar).getByRole('button', {
      name: 'Mar 7, 2099: 1 listed event you have not marked, 1 of your talks',
    });
    expect(day).not.toHaveAttribute('data-overlap');
    fireEvent.click(day);
    expect(within(calendar).getByText('Listed, not marked by you (1):')).toBeInTheDocument();
    expect(within(calendar).getByText('Example Community Day')).toBeInTheDocument();
  });

  it('says nothing on the row, and shows nothing on the calendar, for an event marked Not going', async () => {
    getJSON.mockResolvedValue(answer({ events: [event({ note: savedNote('not_going') })] }));
    await show(hubData([acceptedTalk()]));
    // Not going is hidden by the default filter; show every event to read its row.
    fireEvent.change(await screen.findByLabelText('Show'), { target: { value: 'all' } });
    const row = (await screen.findByText('Example Community Day')).closest('li');
    expect(within(row).queryByTestId('clash')).toBeNull();
    expect(within(row).queryByTestId('would-meet')).toBeNull();
    const calendar = screen.getByRole('region', { name: 'Calendar of events and your talks' });
    expect(within(calendar).queryByRole('button', { name: /Mar 6, 2099/ })).toBeNull();
    expect(
      within(calendar).getByRole('button', { name: 'Mar 7, 2099: 1 of your talks' })
    ).not.toHaveAttribute('data-overlap');
  });

  it('flags two events the owner planned on both rows, and only tells an unmarked one what it would meet', async () => {
    const second = event({
      id: 'event-2',
      title: 'Second Day',
      startDate: '2099-03-07',
      endDate: '2099-03-08',
      note: savedNote('applied', { eventId: 'event-2', etag: '"s1"' }),
    });
    getJSON.mockResolvedValue(
      answer({ events: [event({ note: savedNote('interested') }), second] })
    );
    await show();
    const first = (await screen.findByText('Example Community Day')).closest('li');
    expect(within(first).getByTestId('clash')).toHaveTextContent(
      'Second Day (Applied, Mar 7–8, 2099)'
    );
    expect(
      within(screen.getByText('Second Day').closest('li')).getByTestId('clash')
    ).toHaveTextContent('Example Community Day (Interested, Mar 6–7, 2099)');
  });

  it('does not flag an event the owner applied to because an unmarked event shares its days', async () => {
    const second = event({
      id: 'event-2',
      title: 'Second Day',
      startDate: '2099-03-07',
      endDate: '2099-03-08',
      note: savedNote('applied', { eventId: 'event-2', etag: '"s1"' }),
    });
    getJSON.mockResolvedValue(answer({ events: [event(), second] }));
    await show();
    const first = (await screen.findByText('Example Community Day')).closest('li');
    expect(within(first).queryByTestId('clash')).toBeNull();
    expect(within(first).getByTestId('would-meet')).toHaveTextContent(
      'Second Day (Applied, Mar 7–8, 2099)'
    );
    const other = screen.getByText('Second Day').closest('li');
    expect(within(other).queryByTestId('clash')).toBeNull();
    expect(within(other).queryByTestId('would-meet')).toBeNull();
    const calendar = screen.getByRole('region', { name: 'Calendar of events and your talks' });
    expect(within(calendar).queryByRole('button', { name: /clash/ })).toBeNull();
  });

  it('says "already have a talk" for the same event, and flags nothing', async () => {
    await show(hubData([acceptedTalk({ eventName: 'Example Community Day', date: '2099-03-06' })]));
    const row = (await screen.findByText('Example Community Day')).closest('li');
    expect(
      within(row).getByText('You already have a talk at this event (Accepted).')
    ).toBeInTheDocument();
    expect(within(row).queryByTestId('clash')).toBeNull();
  });

  it('says clashes may be missing while the owner’s own talks have not loaded', async () => {
    await show({
      ...hubData(),
      stored: { data: [], loaded: false, error: 'failed', pending: false },
    });
    expect(await screen.findByText(/clashes with them may be missing/)).toBeInTheDocument();
  });
});

describe('the estimate', () => {
  it('is never asked for by opening the tab, refreshing, or saving', async () => {
    await show();
    await screen.findByText('Example Community Day');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(sendJSON).toHaveBeenCalledWith(REFRESH_ROUTE, 'POST'));
    fireEvent.click(await screen.findByRole('button', { name: /Add status, costs and notes/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(sendJSON).toHaveBeenCalledWith(`${EVENTS_ROUTE}/event-1`, 'PUT', expect.anything())
    );
    expect(sendJSON.mock.calls.filter(([route]) => String(route).endsWith('/estimate'))).toEqual(
      []
    );
  });

  it('is asked for once, for that event only, when its button is pressed, and a second click while it is out sends nothing', async () => {
    let finish;
    sendJSON.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ ok: true });
        })
    );
    await show();
    const button = await screen.findByRole('button', { name: /^Estimate the chance/ });
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(sendJSON).toHaveBeenCalledTimes(1));
    expect(sendJSON).toHaveBeenCalledWith(`${EVENTS_ROUTE}/event-1/estimate`, 'POST');
    finish();
    // The list is read again once the estimate has landed.
    await waitFor(() => expect(getJSON).toHaveBeenCalledTimes(2));
  });

  it('is off, with the reason, when the site holds no talk topics', async () => {
    getJSON.mockResolvedValue(answer({ topics: { count: 0, hasBio: false, from: [] } }));
    await show();
    expect(await screen.findByRole('button', { name: /^Estimate/ })).toBeDisabled();
    expect(screen.getByTestId('topics-line')).toHaveTextContent(
      'No talk topics were found, so Estimate is off.'
    );
  });

  it('says what an estimate is compared with, and that it is a rough estimate', async () => {
    await show();
    expect(await screen.findByTestId('topics-line')).toHaveTextContent(
      'An estimate compares an event’s page with your 3 talk topics and your bio (from: Speaking hub sessions and topics; Speaker profile bio). Rough estimate, not a measurement; it is made only when you press Estimate.'
    );
  });

  it('shows the server’s sentence when it is refused', async () => {
    sendJSON.mockRejectedValueOnce(
      new Error(
        'The model did not answer with a usable number. Nothing was saved; press Estimate to try again.'
      )
    );
    await show();
    fireEvent.click(await screen.findByRole('button', { name: /^Estimate the chance/ }));
    expect(await screen.findByText(/did not answer with a usable number/)).toBeInTheDocument();
    // An ordinary refusal carries no link to the switch.
    expect(screen.queryByRole('link', { name: /AI Engine/ })).toBeNull();
  });

  it('says the estimate is switched off, with a link to the switch, when the server answers that', async () => {
    // What lib/api.js throws for the server's 409: its sentence, the status and the code.
    sendJSON.mockRejectedValueOnce(
      Object.assign(
        new Error(
          'The acceptance estimate is switched off. To use it, switch on “Speaking acceptance estimate” on the AI Engine page (the AI Services tab), then press Estimate again. Nothing was asked of a model.'
        ),
        { status: 409, code: SWITCHED_OFF_CODE }
      )
    );
    await show();
    fireEvent.click(await screen.findByRole('button', { name: /^Estimate the chance/ }));
    expect(await screen.findByText(/The acceptance estimate is switched off/)).toBeInTheDocument();
    expect(SWITCHED_OFF_CODE).toBe('ESTIMATE_SWITCHED_OFF');
    expect(screen.getByRole('link', { name: 'Open AI Engine → AI Services' })).toHaveAttribute(
      'href',
      AI_SWITCHES_HREF
    );
    expect(AI_SWITCHES_HREF).toBe('/admin/ai-engine?tab=services');
    // The row is as it was: no estimate was stored, and the button can be pressed again.
    expect(screen.getByText('No estimate yet. Press Estimate to ask for one.')).toBeInTheDocument();
  });
});

describe('saving and clearing', () => {
  const noted = () =>
    answer({
      events: [
        event({
          note: {
            eventId: 'event-1',
            status: 'interested',
            notes: 'Old.',
            costs: { travel: 100, lodging: null, other: null },
            estimate: null,
            etag: '"v7"',
          },
        }),
      ],
    });

  it('sends the checked form with the version the row was read at', async () => {
    getJSON.mockResolvedValue(noted());
    await show();
    fireEvent.click(await screen.findByRole('button', { name: /Edit status, costs and notes/ }));
    const form = screen.getByRole('form', { name: 'Your notes for Example Community Day' });
    fireEvent.change(within(form).getByLabelText('Your status'), { target: { value: 'applied' } });
    fireEvent.change(within(form).getByLabelText('Lodging'), { target: { value: '250.50' } });
    fireEvent.change(within(form).getByLabelText('Notes'), {
      target: { value: 'Two talks sent.' },
    });
    expect(within(form).getByText('350.5')).toBeInTheDocument();
    fireEvent.click(within(form).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(sendJSON).toHaveBeenCalledWith(`${EVENTS_ROUTE}/event-1`, 'PUT', {
        status: 'applied',
        notes: 'Two talks sent.',
        costs: { travel: 100, lodging: 250.5, other: null },
        etag: '"v7"',
      })
    );
    await waitFor(() => expect(screen.queryByRole('form')).toBeNull());
  });

  it('sends no version for a first save', async () => {
    await show();
    fireEvent.click(await screen.findByRole('button', { name: /Add status, costs and notes/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sendJSON).toHaveBeenCalledTimes(1));
    expect(sendJSON.mock.calls[0][2]).toEqual({
      status: '',
      notes: '',
      costs: { travel: null, lodging: null, other: null },
    });
  });

  it('refuses a cost that is not a number before anything is sent', async () => {
    await show();
    fireEvent.click(await screen.findByRole('button', { name: /Add status, costs and notes/ }));
    fireEvent.change(screen.getByLabelText('Travel'), { target: { value: 'a lot' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(
      await screen.findByText('Travel must be a number of 0 or more, or empty.')
    ).toBeInTheDocument();
    expect(sendJSON).not.toHaveBeenCalled();
  });

  it('puts the saved values back in the form after a 409, so a second Save cannot overwrite the other change', async () => {
    getJSON.mockResolvedValue(noted());
    sendJSON.mockRejectedValueOnce(
      Object.assign(new Error('This event was changed somewhere else since the page read it.'), {
        status: 409,
      })
    );
    await show();
    fireEvent.click(await screen.findByRole('button', { name: /Edit status, costs and notes/ }));
    const form = () => screen.getByRole('form', { name: 'Your notes for Example Community Day' });
    fireEvent.change(within(form()).getByLabelText('Your status'), {
      target: { value: 'declined' },
    });
    fireEvent.change(within(form()).getByLabelText('Notes'), { target: { value: 'Mine.' } });

    // What another tab saved in the meantime; the re-read after the refusal brings it.
    getJSON.mockResolvedValue(
      answer({
        events: [
          event({
            note: {
              eventId: 'event-1',
              status: 'accepted',
              notes: 'Theirs.',
              costs: { travel: 100, lodging: 300, other: null },
              estimate: null,
              etag: '"v8"',
            },
          }),
        ],
      })
    );
    fireEvent.click(within(form()).getByRole('button', { name: 'Save' }));
    expect(
      await screen.findByText(/changed somewhere else since the page read it/)
    ).toBeInTheDocument();
    await waitFor(() => expect(getJSON).toHaveBeenCalledTimes(2));

    // The form is still open, but it shows what is stored now, and says why.
    expect(await within(form()).findByText(CHANGED_ELSEWHERE)).toBeInTheDocument();
    expect(within(form()).getByLabelText('Your status')).toHaveValue('accepted');
    expect(within(form()).getByLabelText('Notes')).toHaveValue('Theirs.');
    expect(within(form()).getByLabelText('Lodging')).toHaveValue('300');

    // Pressing Save again sends the stored values under the new version: the
    // owner's old form ("declined", "Mine.") is never sent over the other change.
    fireEvent.click(within(form()).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sendJSON).toHaveBeenCalledTimes(2));
    expect(sendJSON.mock.calls[1]).toEqual([
      `${EVENTS_ROUTE}/event-1`,
      'PUT',
      {
        status: 'accepted',
        notes: 'Theirs.',
        costs: { travel: 100, lodging: 300, other: null },
        etag: '"v8"',
      },
    ]);
  });

  it('keeps what was typed when a save fails for another reason and nothing changed underneath', async () => {
    getJSON.mockResolvedValue(noted());
    sendJSON.mockRejectedValueOnce(new Error('Failed to save the event'));
    await show();
    fireEvent.click(await screen.findByRole('button', { name: /Edit status, costs and notes/ }));
    fireEvent.change(screen.getByLabelText('Notes'), { target: { value: 'Typed once.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Failed to save the event')).toBeInTheDocument();
    await waitFor(() => expect(getJSON).toHaveBeenCalledTimes(2));
    expect(screen.getByLabelText('Notes')).toHaveValue('Typed once.');
    expect(screen.queryByText(CHANGED_ELSEWHERE)).toBeNull();
  });

  it('clears only after a confirmation, with the version in If-Match', async () => {
    getJSON.mockResolvedValue(noted());
    await show();
    fireEvent.click(await screen.findByRole('button', { name: /Edit status, costs and notes/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Clear what is saved' }));
    expect(sendJSON).not.toHaveBeenCalled();
    expect(await screen.findByText('Clear what you saved for this event?')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    await waitFor(() =>
      expect(sendJSON).toHaveBeenCalledWith(`${EVENTS_ROUTE}/event-1`, 'DELETE', undefined, {
        headers: { 'If-Match': '"v7"' },
      })
    );
  });
});

describe('the list’s filters', () => {
  it('hides Declined and Not going by default, and finds by search', async () => {
    getJSON.mockResolvedValue(
      answer({
        events: [
          event(),
          event({
            id: 'event-2',
            title: 'Skipped Fest',
            note: {
              eventId: 'event-2',
              status: 'not_going',
              notes: '',
              costs: {},
              estimate: null,
              etag: '"x"',
            },
          }),
        ],
      })
    );
    await show();
    await screen.findByText('Example Community Day');
    expect(screen.queryByText('Skipped Fest')).toBeNull();
    fireEvent.change(screen.getByLabelText('Show'), { target: { value: 'all' } });
    expect(screen.getByText('Skipped Fest')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Search events'), {
      target: { value: 'nothing like this' },
    });
    expect(screen.getByText('No events match these filters.')).toBeInTheDocument();
  });
});

describe('ApplyCalendar', () => {
  const month = { year: 2099, monthIndex: 2 };
  const marks = marksForMonth(month, {
    events: [
      event({ callCloses: '2099-03-02', note: { status: 'interested' } }),
      // Not marked by the owner: a quiet mark on its day, and no clash.
      ...Array.from({ length: UNMARKED_SHOWN + 2 }, (_, n) =>
        event({
          id: `other-${n}`,
          title: `Elsewhere Day ${n}`,
          startDate: '2099-03-20',
          endDate: '2099-03-20',
          callCloses: null,
        })
      ),
    ],
    saved: [],
    talks: [{ name: 'Other Conf', day: '2099-03-07', status: 'accepted', statusLabel: 'Accepted' }],
  });

  it('reads each marked day out in words, and leaves unmarked days as plain text', () => {
    render(<ApplyCalendar month={month} onMonth={() => {}} marks={marks} today="2099-03-10" />);
    expect(screen.getByRole('button', { name: 'Mar 2, 2099: 1 call closing' })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Mar 6, 2099: 1 event you marked' })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', {
        name: 'Mar 7, 2099: clash, 1 event you marked, 1 of your talks',
      })
    ).toBeInTheDocument();
    // 31 days, four of them marked: only those are buttons (plus the two month buttons).
    expect(screen.getAllByRole('button')).toHaveLength(6);
    expect(screen.getByText('10').closest('[aria-current="date"]')).not.toBeNull();
    // The legend names every mark by its shape, so colour is never the only signal.
    const legend = screen.getByRole('list', { name: 'Calendar legend' });
    for (const word of ['square', 'small grey dot', 'diamond', 'ring', 'warning sign'])
      expect(legend).toHaveTextContent(word);
  });

  it('draws a day of unmarked events as one quiet mark, never a clash, and names only a few of them', () => {
    render(<ApplyCalendar month={month} onMonth={() => {}} marks={marks} today="2099-03-10" />);
    const day = screen.getByRole('button', {
      name: `Mar 20, 2099: ${UNMARKED_SHOWN + 2} listed events you have not marked`,
    });
    expect(day).not.toHaveAttribute('data-overlap');
    fireEvent.click(day);
    expect(
      screen.getByText(`Listed, not marked by you (${UNMARKED_SHOWN + 2}):`)
    ).toBeInTheDocument();
    expect(screen.getByText('Elsewhere Day 0')).toBeInTheDocument();
    expect(screen.queryByText(`Elsewhere Day ${UNMARKED_SHOWN}`)).toBeNull();
    expect(screen.getByText('and 2 more; find them in the list.')).toBeInTheDocument();
  });

  it('moves a month at a time from the keyboard-reachable buttons', () => {
    const onMonth = vi.fn();
    render(
      <ApplyCalendar
        month={{ year: 2099, monthIndex: 11 }}
        onMonth={onMonth}
        marks={new Map()}
        today="2099-03-10"
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Next month' }));
    expect(onMonth).toHaveBeenCalledWith({ year: 2100, monthIndex: 0 });
    fireEvent.click(screen.getByRole('button', { name: 'Previous month' }));
    expect(onMonth).toHaveBeenLastCalledWith({ year: 2099, monthIndex: 10 });
  });

  it('describes a day with nothing on it by its date alone', () => {
    expect(describeDay('2099-03-10', undefined)).toBe('Mar 10, 2099');
  });
});
