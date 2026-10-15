/**
 * The settings card must never offer a save it cannot make safely: after a
 * failed load its fields would hold defaults, and saving them would overwrite
 * the real settings.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

import NewsletterSettingsCard from './NewsletterSettingsCard';
import { CHANGED_ELSEWHERE } from '@/components/admin/platform-settings/settingShared';

const fetchSpy = vi.fn();

const getJSON = vi.fn();
const sendJSON = vi.fn();

vi.mock('@/lib/api', () => ({
  getJSON: (...args) => getJSON(...args),
  sendJSON: (...args) => sendJSON(...args),
}));

const STORED = {
  postalAddress: 'PO Box 1',
  replyTo: 'owner@example.com',
  sendDay: 'thursday',
  sendTime: '07:30',
  timeZone: 'Europe/London',
  sections: [
    { id: 'articles', enabled: true, maxItems: 12 },
    { id: 'certification-news', enabled: true, maxItems: 12 },
    { id: 'episodes', enabled: false, maxItems: 4 },
  ],
  windowDays: 7,
  introEnabled: true,
  introTone: 'professional',
  signupPlacement: 'both',
  signupHeading: 'Stay ahead of the cloud curve.',
  signupBlurb: 'Weekly notes.',
  templateId: '',
};

const OPTIONS = {
  sections: [
    { id: 'articles', title: 'New on HybridCloudWorks' },
    { id: 'certification-news', title: 'Certification news' },
    { id: 'episodes', title: 'Listen & learn' },
  ],
  introTones: ['professional', 'friendly', 'concise', 'enthusiastic'],
  windowDays: { min: 1, max: 31 },
  maxItems: { min: 1, max: 20 },
};

const ROUTE = 'cms/platform-settings/newsletter-settings';

/** Section titles in the order the list shows them. */
const sectionOrder = () =>
  within(screen.getByRole('list', { name: 'Sections' }))
    .getAllByRole('checkbox')
    .map((box) => box.labels[0].textContent);

async function renderLoaded(value = STORED) {
  getJSON.mockResolvedValue({ value, options: OPTIONS });
  const utils = render(<NewsletterSettingsCard />);
  await screen.findByRole('list', { name: 'Sections' });
  return utils;
}

const save = () => fireEvent.click(screen.getByRole('button', { name: /save settings/i }));

beforeEach(() => {
  getJSON.mockReset();
  sendJSON.mockReset();
  fetchSpy.mockReset();
  vi.stubGlobal('fetch', fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('NewsletterSettingsCard', () => {
  it('shows the stored settings for editing', async () => {
    getJSON.mockResolvedValue({ value: STORED });
    render(<NewsletterSettingsCard />);
    expect(await screen.findByLabelText('Reply-to address')).toHaveValue('owner@example.com');
    expect(screen.getByLabelText('Send day')).toHaveValue('thursday');
  });

  it('offers no form, and so no save, when the settings could not be loaded', async () => {
    getJSON.mockRejectedValue(new Error('Network error'));
    render(<NewsletterSettingsCard />);
    expect(await screen.findByText(/could not be loaded.*Network error/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /save settings/i })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Postal address')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Days back')).not.toBeInTheDocument();
    expect(sendJSON).not.toHaveBeenCalled();
  });

  it('loads the real values on retry, and only then shows the form', async () => {
    getJSON
      .mockRejectedValueOnce(new Error('Network error'))
      .mockResolvedValueOnce({ value: STORED });
    render(<NewsletterSettingsCard />);
    fireEvent.click(await screen.findByRole('button', { name: /retry/i }));
    expect(await screen.findByLabelText('Postal address')).toHaveValue('PO Box 1');
    // Two reads of the settings; the template list is a separate route.
    expect(getJSON.mock.calls.filter(([route]) => route === ROUTE)).toHaveLength(2);
  });

  it('saves what is on the form', async () => {
    getJSON.mockResolvedValue({ value: STORED });
    sendJSON.mockResolvedValue({ value: { ...STORED, replyTo: 'new@example.com' } });
    const onSaved = vi.fn();
    render(<NewsletterSettingsCard onSaved={onSaved} />);
    fireEvent.change(await screen.findByLabelText('Reply-to address'), {
      target: { value: 'new@example.com' },
    });
    save();
    await waitFor(() =>
      expect(sendJSON).toHaveBeenCalledWith(ROUTE, 'PUT', {
        ...STORED,
        replyTo: 'new@example.com',
      })
    );
    expect(onSaved).toHaveBeenCalled();
  });

  describe('names the version it read (#946)', () => {
    const OTHER = { ...STORED, replyTo: 'other@example.com' };

    /** The settings route answers each read in turn, the last one from then on; others answer empty. */
    const readsInTurn = (...reads) =>
      getJSON.mockImplementation(async (route) => {
        if (route !== ROUTE) return {};
        return reads.length > 1 ? reads.shift() : reads[0];
      });

    it('sends the ETag it read as If-Match, and the one its save returned next time', async () => {
      readsInTurn({ value: STORED, options: OPTIONS, etag: '"v1"' });
      sendJSON
        .mockResolvedValueOnce({ value: STORED, options: OPTIONS, etag: '"v2"' })
        .mockResolvedValueOnce({ value: STORED, options: OPTIONS, etag: '"v3"' });
      render(<NewsletterSettingsCard />);
      await screen.findByLabelText('Postal address');

      save();
      expect(await screen.findByText('Newsletter settings saved.')).toBeInTheDocument();
      save();
      await waitFor(() => expect(sendJSON).toHaveBeenCalledTimes(2));
      expect(sendJSON.mock.calls[0]).toEqual([
        ROUTE,
        'PUT',
        STORED,
        { headers: { 'If-Match': '"v1"' } },
      ]);
      expect(sendJSON.mock.calls[1][3]).toEqual({ headers: { 'If-Match': '"v2"' } });
    });

    it.each([
      [412, 'CONFLICT'],
      [428, 'PRECONDITION_REQUIRED'],
    ])(
      'on a %i says the settings changed elsewhere and shows what is stored now, without saving again',
      async (status, code) => {
        readsInTurn(
          { value: STORED, options: OPTIONS, etag: '"v1"' },
          { value: OTHER, options: OPTIONS, etag: '"v2"' }
        );
        sendJSON.mockRejectedValueOnce(Object.assign(new Error('refused'), { status, code }));
        render(<NewsletterSettingsCard />);
        fireEvent.change(await screen.findByLabelText('Postal address'), {
          target: { value: 'PO Box 9' },
        });
        save();

        expect(await screen.findByText(CHANGED_ELSEWHERE)).toBeInTheDocument();
        await waitFor(() =>
          expect(screen.getByLabelText('Reply-to address')).toHaveValue('other@example.com')
        );
        expect(screen.getByLabelText('Postal address')).toHaveValue('PO Box 1');
        expect(sendJSON).toHaveBeenCalledTimes(1);
        expect(getJSON.mock.calls.filter(([route]) => route === ROUTE)).toHaveLength(2);
      }
    );
  });

  describe('Content', () => {
    it('shows the saved sections in order, with their switches, counts, window and intro', async () => {
      await renderLoaded({
        ...STORED,
        sections: [STORED.sections[2], STORED.sections[0], STORED.sections[1]],
        windowDays: 14,
        introTone: 'friendly',
      });
      expect(sectionOrder()).toEqual([
        'Listen & learn',
        'New on HybridCloudWorks',
        'Certification news',
      ]);
      expect(screen.getByLabelText('Listen & learn')).not.toBeChecked();
      expect(screen.getByLabelText('New on HybridCloudWorks')).toBeChecked();
      expect(screen.getByLabelText('Most items in Listen & learn')).toHaveValue(4);
      expect(screen.getByLabelText('Days back')).toHaveValue(14);
      expect(screen.getByRole('switch', { name: 'AI intro' })).toBeChecked();
      expect(screen.getByLabelText('Intro tone')).toHaveValue('friendly');
    });

    it('saves toggled sections, a new order and new counts, then shows what the server stored', async () => {
      await renderLoaded();
      fireEvent.click(screen.getByLabelText('Listen & learn'));
      fireEvent.click(screen.getByLabelText('Certification news'));
      fireEvent.click(screen.getByRole('button', { name: 'Move Listen & learn up' }));
      fireEvent.change(screen.getByLabelText('Most items in New on HybridCloudWorks'), {
        target: { value: '5' },
      });
      fireEvent.change(screen.getByLabelText('Days back'), { target: { value: '10' } });
      const sections = [
        { id: 'articles', enabled: true, maxItems: 5 },
        { id: 'episodes', enabled: true, maxItems: 4 },
        { id: 'certification-news', enabled: false, maxItems: 12 },
      ];
      // A stored value unlike the one sent, so the test can tell which one the form shows.
      sendJSON.mockResolvedValue({
        value: { ...STORED, sections, windowDays: 12 },
        options: OPTIONS,
      });
      save();
      await waitFor(() => expect(sendJSON).toHaveBeenCalledTimes(1));
      expect(sendJSON).toHaveBeenCalledWith(ROUTE, 'PUT', { ...STORED, sections, windowDays: 10 });
      expect(await screen.findByText('Newsletter settings saved.')).toBeInTheDocument();
      expect(screen.getByLabelText('Days back')).toHaveValue(12);
      expect(sectionOrder()).toEqual([
        'New on HybridCloudWorks',
        'Listen & learn',
        'Certification news',
      ]);
    });

    it('saves the intro switched off and the chosen tone', async () => {
      await renderLoaded();
      fireEvent.change(screen.getByLabelText('Intro tone'), { target: { value: 'concise' } });
      fireEvent.click(screen.getByRole('switch', { name: 'AI intro' }));
      sendJSON.mockResolvedValue({
        value: { ...STORED, introEnabled: false, introTone: 'concise' },
      });
      save();
      await waitFor(() =>
        expect(sendJSON).toHaveBeenCalledWith(ROUTE, 'PUT', {
          ...STORED,
          introEnabled: false,
          introTone: 'concise',
        })
      );
      expect(await screen.findByText('Newsletter settings saved.')).toBeInTheDocument();
      expect(screen.getByLabelText('Intro tone')).toBeDisabled();
    });

    it('does not move the first section up or the last one down', async () => {
      await renderLoaded();
      expect(
        screen.getByRole('button', { name: 'Move New on HybridCloudWorks up' })
      ).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Move Listen & learn down' })).toBeDisabled();
    });

    it('refuses to save with every section off or a count left blank, and says why', async () => {
      await renderLoaded();
      fireEvent.click(screen.getByLabelText('New on HybridCloudWorks'));
      fireEvent.click(screen.getByLabelText('Certification news'));
      save();
      expect(await screen.findByText('Turn on at least one section.')).toBeInTheDocument();
      fireEvent.click(screen.getByLabelText('Certification news'));
      fireEvent.change(screen.getByLabelText('Most items in Certification news'), {
        target: { value: '' },
      });
      save();
      expect(
        await screen.findByText('Enter how many items each section may show.')
      ).toBeInTheDocument();
      expect(sendJSON).not.toHaveBeenCalled();
    });

    it('sends one save for a double click', async () => {
      await renderLoaded();
      let finish;
      sendJSON.mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          })
      );
      const form = screen.getByRole('button', { name: /save settings/i }).closest('form');
      fireEvent.submit(form);
      fireEvent.submit(form);
      expect(sendJSON).toHaveBeenCalledTimes(1);
      finish({ value: STORED });
      expect(await screen.findByText('Newsletter settings saved.')).toBeInTheDocument();
    });

    it('never lets an earlier load overwrite a later one', async () => {
      let resolveFirst;
      getJSON
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveFirst = resolve;
            })
        )
        .mockResolvedValueOnce({ value: { ...STORED, windowDays: 21 }, options: OPTIONS });
      const { unmount } = render(<NewsletterSettingsCard />);
      unmount();
      render(<NewsletterSettingsCard />);
      expect(await screen.findByLabelText('Days back')).toHaveValue(21);
      resolveFirst({ value: { ...STORED, windowDays: 3 }, options: OPTIONS });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(screen.getByLabelText('Days back')).toHaveValue(21);
    });
  });
  describe('Signup form', () => {
    it('shows the saved placement, heading and blurb with character counts', async () => {
      await renderLoaded({ ...STORED, signupPlacement: 'blogEnd' });
      const placement = screen.getByLabelText('Where it appears');
      expect(placement).toHaveValue('blogEnd');
      expect(
        within(placement)
          .getAllByRole('option')
          .map((o) => o.textContent)
      ).toEqual(['Footer on every page', 'End of blog posts', 'Both', 'Nowhere (hide the form)']);
      expect(screen.getByLabelText('Heading')).toHaveValue('Stay ahead of the cloud curve.');
      expect(screen.getByLabelText('Blurb')).toHaveValue('Weekly notes.');
      expect(screen.getByText('30/80 characters')).toBeInTheDocument();
      expect(screen.getByText('13/240 characters')).toBeInTheDocument();
    });

    it('fills in the site defaults for settings saved before the signup fields existed', async () => {
      const legacy = { ...STORED };
      delete legacy.signupPlacement;
      delete legacy.signupHeading;
      delete legacy.signupBlurb;
      await renderLoaded(legacy);
      expect(screen.getByLabelText('Where it appears')).toHaveValue('both');
      expect(screen.getByLabelText('Heading')).toHaveValue('Stay ahead of the cloud curve.');
    });

    it('previews the wording as it is typed, as literal text', async () => {
      await renderLoaded();
      fireEvent.change(screen.getByLabelText('Heading'), {
        target: { value: '<b>New</b> heading' },
      });
      fireEvent.change(screen.getByLabelText('Blurb'), { target: { value: 'New blurb' } });
      const preview = screen.getByRole('region', { name: 'Newsletter signup preview' });
      expect(within(preview).getByRole('heading')).toHaveTextContent('<b>New</b> heading');
      expect(within(preview).getByText('New blurb')).toBeInTheDocument();
      expect(preview.querySelector('b')).toBeNull();
      expect(screen.getByText('18/80 characters')).toBeInTheDocument();
    });

    it('saves the placement, heading and blurb in the settings payload', async () => {
      await renderLoaded();
      fireEvent.change(screen.getByLabelText('Where it appears'), { target: { value: 'none' } });
      fireEvent.change(screen.getByLabelText('Heading'), { target: { value: 'Join us' } });
      fireEvent.change(screen.getByLabelText('Blurb'), { target: { value: 'Monthly.' } });
      const saved = {
        ...STORED,
        signupPlacement: 'none',
        signupHeading: 'Join us',
        signupBlurb: 'Monthly.',
      };
      sendJSON.mockResolvedValue({ value: saved, options: OPTIONS });
      save();
      await waitFor(() => expect(sendJSON).toHaveBeenCalledWith(ROUTE, 'PUT', saved));
      expect(await screen.findByText('Newsletter settings saved.')).toBeInTheDocument();
      expect(
        screen.getByText('Hidden on the site. This is how it would look.')
      ).toBeInTheDocument();
    });

    it('refuses to save a blank heading, and says why', async () => {
      await renderLoaded();
      fireEvent.change(screen.getByLabelText('Heading'), { target: { value: '   ' } });
      save();
      expect(await screen.findByText('Enter a heading for the signup form.')).toBeInTheDocument();
      expect(sendJSON).not.toHaveBeenCalled();
    });

    it('caps the inputs at the server limits', async () => {
      await renderLoaded();
      expect(screen.getByLabelText('Heading')).toHaveAttribute('maxLength', '80');
      expect(screen.getByLabelText('Blurb')).toHaveAttribute('maxLength', '240');
    });

    it('never subscribes anyone from the preview, and never saves from it', async () => {
      await renderLoaded();
      const preview = screen.getByRole('region', { name: 'Newsletter signup preview' });
      const subscribe = within(preview).getByRole('button', { name: 'Subscribe' });
      expect(subscribe).toBeDisabled();
      expect(subscribe).toHaveAttribute('type', 'button');
      expect(within(preview).getByLabelText('Email address')).toBeDisabled();
      fireEvent.click(subscribe);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(sendJSON).not.toHaveBeenCalled();
    });
  });

  describe('Template', () => {
    const TEMPLATES_ROUTE = 'cms/mailing-list/templates?limit=100';
    const TEMPLATES = [
      { id: 'tpl-weekly', name: ' Weekly brand ', status: 'published' },
      { id: 'tpl-draft', name: 'Work in progress', status: 'draft' },
    ];

    /** Settings and the template list answered by route; `templates` may be an Error. */
    function answer({ value = STORED, templates = TEMPLATES } = {}) {
      getJSON.mockImplementation(async (route) => {
        if (route === TEMPLATES_ROUTE) {
          if (templates instanceof Error) throw templates;
          return { templates };
        }
        return { value, options: OPTIONS };
      });
    }

    const option = (name) => screen.getByRole('option', { name });

    it('lists the built-in design and the Resend templates, and saves the chosen templateId', async () => {
      answer();
      sendJSON.mockImplementation(async (_route, _method, body) => ({ value: body }));
      render(<NewsletterSettingsCard />);
      const select = await screen.findByLabelText('Email design');
      expect(select).toHaveValue('');
      await screen.findByRole('option', { name: 'Weekly brand (published)' });
      expect(getJSON).toHaveBeenCalledWith(TEMPLATES_ROUTE);
      expect(screen.getByRole('link', { name: /open resend templates/i })).toHaveAttribute(
        'href',
        'https://resend.com/templates'
      );
      expect(screen.getByText(/put \{\{\{NEWSLETTER_BODY\}\}\} where/)).toBeInTheDocument();

      fireEvent.change(select, { target: { value: 'tpl-weekly' } });
      save();
      await waitFor(() =>
        expect(sendJSON).toHaveBeenCalledWith(ROUTE, 'PUT', { ...STORED, templateId: 'tpl-weekly' })
      );
      expect(await screen.findByText('Newsletter settings saved.')).toBeInTheDocument();
      expect(screen.getByLabelText('Email design')).toHaveValue('tpl-weekly');
    });

    it('shows an unpublished template disabled, with a note', async () => {
      answer();
      render(<NewsletterSettingsCard />);
      await screen.findByRole('option', { name: 'Work in progress (not published)' });
      expect(option('Work in progress (not published)')).toBeDisabled();
      expect(option('Weekly brand (published)')).not.toBeDisabled();
      expect(screen.getByText(/not published cannot be chosen/)).toBeInTheDocument();
    });

    it('keeps the saved template and says why when the list cannot be loaded', async () => {
      answer({
        value: { ...STORED, templateId: 'tpl-weekly' },
        templates: Object.assign(new Error('Service unavailable'), { status: 503 }),
      });
      sendJSON.mockImplementation(async (_route, _method, body) => ({ value: body }));
      render(<NewsletterSettingsCard />);
      expect(
        await screen.findByText(
          /could not be loaded, so the saved choice is kept: Resend is not configured/
        )
      ).toBeInTheDocument();
      expect(screen.getByLabelText('Email design')).toHaveValue('tpl-weekly');
      expect(option('Saved template (tpl-weekly), list unavailable')).toBeInTheDocument();
      save();
      await waitFor(() =>
        expect(sendJSON).toHaveBeenCalledWith(ROUTE, 'PUT', { ...STORED, templateId: 'tpl-weekly' })
      );
    });

    it('shows no stale list after a failed reload', async () => {
      let fail = false;
      getJSON.mockImplementation(async (route) => {
        if (route !== TEMPLATES_ROUTE) return { value: STORED, options: OPTIONS };
        if (fail) throw Object.assign(new Error('Too many'), { status: 429, retryAfterSeconds: 3 });
        return { templates: TEMPLATES };
      });
      render(<NewsletterSettingsCard />);
      await screen.findByRole('option', { name: 'Weekly brand (published)' });
      fail = true;
      fireEvent.click(screen.getByRole('button', { name: /reload templates/i }));
      expect(await screen.findByText(/Wait 3 seconds/)).toBeInTheDocument();
      expect(
        screen.queryByRole('option', { name: 'Weekly brand (published)' })
      ).not.toBeInTheDocument();
    });
  });
});
