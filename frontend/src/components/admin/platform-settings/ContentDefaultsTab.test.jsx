/**
 * Content defaults: what the covers card sends on Save is exactly the body the
 * server's normalizer expects, the bundled defaults are the eight lowercase
 * paths under /images/default-heroes/, a hand-seeded document that failed
 * validation is shown as such, and the newsletter's settings are linked to
 * rather than repeated.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

import ContentDefaultsTab, {
  DefaultCoversCard,
  NEWSLETTER_SETTINGS_PATH,
  bundledDefaultHeroes,
  isAcceptableHeroUrl,
} from './ContentDefaultsTab';
import { HERO_PROVIDERS, PODCAST_PROVIDERS, settingRoute } from './settingShared';

const getJSON = vi.fn();
const sendJSON = vi.fn();
const toast = vi.fn();

vi.mock('@/lib/api', () => ({
  getJSON: (...args) => getJSON(...args),
  sendJSON: (...args) => sendJSON(...args),
  postJSON: vi.fn(),
}));
vi.mock('@/hooks/useAuthReady', () => ({ useAuthReady: () => ({ authReady: true }) }));
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast }) }));

const meta = { exists: false, stored: null, updatedAt: null, problem: null };

const renderTab = () =>
  render(
    <MemoryRouter>
      <ContentDefaultsTab />
    </MemoryRouter>
  );

beforeEach(() => {
  getJSON.mockReset().mockResolvedValue({
    success: true,
    setting: 'default-heroes',
    value: { heroes: {} },
    exists: false,
    stored: null,
    updatedAt: null,
  });
  sendJSON.mockReset().mockImplementation(async (_route, _method, body) => ({
    success: true,
    setting: 'default-heroes',
    value: body,
    exists: true,
    stored: 'valid',
    updatedAt: '2026-09-07T12:00:00.000Z',
  }));
  toast.mockReset();
});

describe('bundled defaults', () => {
  it('are the nine lowercase files under /images/default-heroes/', () => {
    expect(bundledDefaultHeroes()).toEqual({
      Azure: '/images/default-heroes/azure.png',
      AWS: '/images/default-heroes/aws.png',
      GCP: '/images/default-heroes/gcp.png',
      GitHub: '/images/default-heroes/github.png',
      Terraform: '/images/default-heroes/terraform.png',
      Ansible: '/images/default-heroes/ansible.png',
      VMware: '/images/default-heroes/vmware.png',
      Docker: '/images/default-heroes/docker.png',
      Multi: '/images/default-heroes/multi.png',
    });
    expect(HERO_PROVIDERS).toHaveLength(9);
    expect(PODCAST_PROVIDERS).toEqual([
      'azure',
      'aws',
      'gcp',
      'github',
      'terraform',
      'finops',
      'vmware',
      'ansible',
      'docker',
    ]);
  });
});

describe('DefaultCoversCard', () => {
  it('renders one field per provider and fills them all from the bundled button', () => {
    const onChange = vi.fn();
    render(
      <DefaultCoversCard
        value={{ heroes: {} }}
        meta={meta}
        saving={false}
        onChange={onChange}
        onSave={vi.fn()}
      />
    );
    for (const provider of HERO_PROVIDERS) expect(screen.getByLabelText(provider)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Use bundled defaults/ }));
    expect(onChange).toHaveBeenCalledWith({ heroes: bundledDefaultHeroes() });
  });

  it('edits one provider without touching the others and saves once per submit', () => {
    const onChange = vi.fn();
    const onSave = vi.fn();
    render(
      <DefaultCoversCard
        value={{ heroes: { AWS: '/aws.png' } }}
        meta={meta}
        saving={false}
        onChange={onChange}
        onSave={onSave}
      />
    );
    fireEvent.change(screen.getByLabelText('Azure'), {
      target: { value: '/api/public/media/covers/azure.png' },
    });
    expect(onChange).toHaveBeenCalledWith({
      heroes: { AWS: '/aws.png', Azure: '/api/public/media/covers/azure.png' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Save/ }));
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it('previews only what the server would store, and shows again once corrected', () => {
    // The page-side rule mirrors the server's: no scheme other than https, no
    // protocol-relative host, no query string or fragment (a SAS token there
    // would be published with the post).
    expect(isAcceptableHeroUrl('/images/default-heroes/azure.png')).toBe(true);
    expect(isAcceptableHeroUrl('https://cdn.example.com/a.png')).toBe(true);
    expect(isAcceptableHeroUrl('javascript:alert(1)')).toBe(false);
    expect(isAcceptableHeroUrl('data:image/png;base64,AAAA')).toBe(false);
    expect(isAcceptableHeroUrl('//evil.example.com/a.png')).toBe(false);
    expect(isAcceptableHeroUrl('/a.png?sig=token')).toBe(false);
    expect(isAcceptableHeroUrl('https://cdn.example.com/a.png#x')).toBe(false);

    const props = { meta, saving: false, onChange: vi.fn(), onSave: vi.fn() };
    const { container, rerender } = render(
      <DefaultCoversCard
        value={{
          heroes: {
            Azure: 'javascript:alert(1)',
            AWS: 'data:image/png;base64,AAAA',
            GCP: '/api/public/media/covers/gcp.png?sv=2024&sig=abc',
          },
        }}
        {...props}
      />
    );
    expect(container.querySelectorAll('img')).toHaveLength(0);

    rerender(
      <DefaultCoversCard
        value={{ heroes: { Azure: '/images/default-heroes/azure.png' } }}
        {...props}
      />
    );
    const img = screen.getByRole('img', { name: 'Azure cover preview' });
    expect(img.getAttribute('src')).toBe('/images/default-heroes/azure.png');
    expect(container.querySelectorAll('img')).toHaveLength(1);
  });

  it('hides a preview that failed to load only until the value changes', () => {
    const props = { meta, saving: false, onChange: vi.fn(), onSave: vi.fn() };
    const { rerender } = render(
      <DefaultCoversCard value={{ heroes: { Azure: '/images/missing.png' } }} {...props} />
    );
    fireEvent.error(screen.getByRole('img', { name: 'Azure cover preview' }));
    expect(screen.queryByRole('img', { name: 'Azure cover preview' })).toBeNull();

    // Same broken value: stays hidden rather than retrying on every render.
    rerender(<DefaultCoversCard value={{ heroes: { Azure: '/images/missing.png' } }} {...props} />);
    expect(screen.queryByRole('img', { name: 'Azure cover preview' })).toBeNull();

    rerender(
      <DefaultCoversCard
        value={{ heroes: { Azure: '/images/default-heroes/azure.png' } }}
        {...props}
      />
    );
    expect(screen.getByRole('img', { name: 'Azure cover preview' })).toBeTruthy();
  });

  it('says when the stored document failed validation and shows the reason', () => {
    render(
      <DefaultCoversCard
        value={{ heroes: {} }}
        meta={{
          exists: true,
          stored: 'invalid',
          updatedAt: null,
          problem: 'heroes must be an object',
        }}
        saving={false}
        onChange={vi.fn()}
        onSave={vi.fn()}
      />
    );
    expect(screen.getByText(/does not match the shape/)).toBeTruthy();
    expect(screen.getByText(/heroes must be an object/)).toBeTruthy();
  });
});

describe('the Content defaults tab', () => {
  it('loads only its own setting', async () => {
    renderTab();
    await screen.findByText('Default covers');
    expect(getJSON).toHaveBeenCalledTimes(1);
    expect(getJSON).toHaveBeenCalledWith(settingRoute('default-heroes'));
  });

  it('PUTs the bundled defaults to the default-heroes route', async () => {
    renderTab();
    await screen.findByText('Default covers');
    fireEvent.click(screen.getByRole('button', { name: /Use bundled defaults/ }));
    fireEvent.submit(screen.getByLabelText('Azure').closest('form'));
    await waitFor(() =>
      expect(sendJSON).toHaveBeenCalledWith(settingRoute('default-heroes'), 'PUT', {
        heroes: bundledDefaultHeroes(),
      })
    );
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Saved' }))
    );
    expect(screen.getByLabelText('Multi').value).toBe('/images/default-heroes/multi.png');
  });

  it('links to the Newsletter Hub settings rather than repeating them', async () => {
    renderTab();
    await screen.findByText('Default covers');
    expect(screen.getByText(/Newsletter settings live in Newsletter Hub → Settings/)).toBeTruthy();
    const link = screen.getByRole('link', { name: /Open Newsletter Hub settings/ });
    expect(link.getAttribute('href')).toBe(NEWSLETTER_SETTINGS_PATH);
    expect(NEWSLETTER_SETTINGS_PATH).toBe('/admin/newsletter-hub?tab=settings');
    expect(getJSON).not.toHaveBeenCalledWith(settingRoute('newsletter-settings'));
  });

  it('shows a failed load with a retry, and no form to save over the document', async () => {
    getJSON.mockRejectedValueOnce(new Error('HTTP 500'));
    renderTab();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Default covers: HTTP 500');
    expect(screen.queryByLabelText('Azure')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Retry/ }));
    expect(await screen.findByLabelText('Azure')).toBeTruthy();
    expect(getJSON).toHaveBeenCalledTimes(2);
  });
});
