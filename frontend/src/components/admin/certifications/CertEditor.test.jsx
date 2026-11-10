/**
 * The certification editor (ADR 0033 §2, Spotlight slice): a real dialog;
 * validation names the field and nothing is sent until it passes; a new cert
 * POSTs and an existing one PATCHes with calendar-day dates and order 0 kept;
 * a double click saves once; the image upload keeps its type and size rules;
 * an upload abandoned by Cancel is deleted; and the order helper reads the
 * global ladder.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';

import CertEditor, { buildPayload, initialForm, uploadedPathFromUrl } from './CertEditor';
import {
  CERTIFICATION_FIELDS,
  validateCertification,
} from '../../../../../functions/src/lib/admin-crud/certification-rules.js';
import { ladderWindow, nextFreeOrder, siblingsOf, issuerOptionsFrom } from './editorFields';

const postJSON = vi.fn();
const sendJSON = vi.fn();
const toast = vi.fn();
vi.mock('@/lib/api', () => ({
  postJSON: (...args) => postJSON(...args),
  sendJSON: (...args) => sendJSON(...args),
}));
vi.mock('@/components/ui/use-toast', () => ({ useToast: () => ({ toast }) }));

beforeEach(() => {
  postJSON.mockReset();
  sendJSON.mockReset().mockResolvedValue({ success: true });
  toast.mockReset();
});

const EXISTING = {
  _docId: 'c1',
  name: 'Azure Administrator',
  code: 'AZ-104',
  issuer: 'Microsoft',
  expDate: '2027-03-01T00:00:00.000Z',
  display: true,
  certState: true,
  featured: false,
  display_order: 2,
};

describe('payload', () => {
  it('sends only fields the server accepts, so a save is never refused for its shape (#1663)', () => {
    // The editor sent `vendor` and `description`, which CERTIFICATION_FIELDS
    // did not list, and every save failed with "Unknown field(s)". The list
    // is read from the server's own module, so the two cannot drift apart.
    const full = buildPayload({
      ...initialForm({}),
      name: 'Cloud Architect',
      issuer: 'Microsoft',
      code: 'AZ-305',
      issueDate: '2026-01-02',
      expDate: '2027-01-02',
      renewalDate: '2026-11-01',
      renewalRequirements: 'Renew online',
      verifyUrl: 'https://learn.microsoft.com/x',
      learnUrl: 'https://learn.microsoft.com/y',
      imageUrl: 'https://images.example/badge.png',
      description: 'Why it matters',
      evidence: [{ label: 'Transcript', url: 'https://t' }],
      relatedLearning: [{ label: 'Path', url: 'https://p' }],
      display_order: 3,
    });
    const unknown = Object.keys(full).filter((key) => !CERTIFICATION_FIELDS.includes(key));
    expect(unknown).toEqual([]);
    expect(full).not.toHaveProperty('vendor');
    expect(validateCertification(full).error).toBeUndefined();
    expect(validateCertification(full).value.description).toBe('Why it matters');
  });

  it('trims, nulls empties, keeps dates as calendar days, keeps order 0 and defaults a blank order', () => {
    const payload = buildPayload({
      ...initialForm({}),
      name: '  Cloud Architect ',
      issuer: 'Custom Issuer',
      issueDate: '2026-01-02',
      renewalDate: '2026-11-01',
      display_order: '',
      evidence: [
        { label: '', url: 'https://t' },
        { label: 'x', url: '' },
      ],
    });
    expect(payload).toMatchObject({
      name: 'Cloud Architect',
      code: null,
      issuer: 'Custom Issuer',
      issueDate: '2026-01-02',
      expDate: null,
      renewalDate: '2026-11-01',
      renewalRequirements: null,
      verifyUrl: null,
      evidence: [{ label: 'https://t', url: 'https://t' }],
      relatedLearning: [],
      display: true,
      certState: true,
      featured: false,
      display_order: 999,
    });
    expect(buildPayload({ ...initialForm({}), name: 'X', display_order: 0 }).display_order).toBe(0);
  });

  it('opens an existing cert with its dates as yyyy-mm-dd', () => {
    expect(initialForm(EXISTING)).toMatchObject({ expDate: '2027-03-01', issuer: 'Microsoft' });
    expect(initialForm({ issuer: '' }).issuer).toBe('');
    expect(initialForm({ evidence: ['https://a'] }).evidence).toEqual([
      { label: 'https://a', url: 'https://a' },
    ]);
  });

  it('reads the blob path back out of an upload URL', () => {
    expect(uploadedPathFromUrl('/api/public/media/certifications/c1/images/badge-1.png')).toBe(
      'c1/images/badge-1.png'
    );
    expect(uploadedPathFromUrl('https://images.credly.com/x.png')).toBeNull();
  });
});

describe('saving', () => {
  it('is a dialog, refuses a save without a name and says so beside the field', async () => {
    render(<CertEditor cert={{}} allCerts={[]} onClose={vi.fn()} onSaved={vi.fn()} />);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Add Certification/ })).toBeInTheDocument();
    // The issuer list offers the registry even when no cert carries it yet
    // (owner request 2026-10-05: Anthropic), so it is picked, not typed.
    fireEvent.click(screen.getByRole('button', { name: 'Show all issuers' }));
    expect(screen.getByRole('button', { name: 'Anthropic' })).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Anthropic' }));
    expect(screen.getByPlaceholderText('Pick or type…')).toHaveValue('Anthropic');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    });
    expect(postJSON).not.toHaveBeenCalled();
    expect(screen.getByText('Name is required.')).toBeInTheDocument();
    expect(screen.getByLabelText('Name *')).toHaveAttribute('aria-invalid', 'true');
  });

  it('refuses an expiry before the issue date and a non-http verify URL', async () => {
    render(
      <CertEditor cert={EXISTING} allCerts={[EXISTING]} onClose={vi.fn()} onSaved={vi.fn()} />
    );
    fireEvent.change(screen.getByLabelText('Issue date'), { target: { value: '2027-06-01' } });
    fireEvent.change(screen.getByLabelText('Verify URL'), { target: { value: 'credly.com/x' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });
    expect(sendJSON).not.toHaveBeenCalled();
    expect(screen.getByText(/on or after the issue date/)).toBeInTheDocument();
    expect(screen.getByText(/Must start with http/)).toBeInTheDocument();
  });

  it('creates a new cert once, however many clicks, and hands back the row', async () => {
    let answer;
    postJSON.mockReturnValue(new Promise((res) => (answer = res)));
    const onSaved = vi.fn();
    const onClose = vi.fn();
    render(<CertEditor cert={{}} allCerts={[]} onClose={onClose} onSaved={onSaved} />);
    fireEvent.change(screen.getByPlaceholderText('Google Cloud Professional Cloud Architect'), {
      target: { value: 'New cert' },
    });
    const add = screen.getByRole('button', { name: 'Add' });
    fireEvent.click(add);
    fireEvent.click(add);
    await act(async () => {
      answer({ id: 'new-id' });
    });
    expect(postJSON).toHaveBeenCalledTimes(1);
    expect(postJSON).toHaveBeenCalledWith(
      'cms/certifications',
      expect.objectContaining({ name: 'New cert' })
    );
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ _docId: 'new-id' }));
    expect(onClose).toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith({ title: 'Certification added' });
  });

  it('patches an existing cert and keeps the editor open when refused', async () => {
    sendJSON.mockRejectedValueOnce(new Error('403'));
    const onClose = vi.fn();
    render(
      <CertEditor cert={EXISTING} allCerts={[EXISTING]} onClose={onClose} onSaved={vi.fn()} />
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    });
    expect(sendJSON).toHaveBeenCalledWith(
      'cms/certifications/c1',
      'PATCH',
      expect.objectContaining({
        name: 'Azure Administrator',
        code: 'AZ-104',
        expDate: '2027-03-01',
      })
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Save failed' }));
  });
});

describe('image upload', () => {
  const pick = (file) => {
    const input = document.querySelector('input[type="file"]');
    fireEvent.change(input, { target: { files: [file] } });
  };

  it('rejects a non-image and an image over 5 MB without uploading', () => {
    render(<CertEditor cert={EXISTING} allCerts={[]} onClose={vi.fn()} onSaved={vi.fn()} />);
    pick(new File(['x'], 'a.txt', { type: 'text/plain' }));
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Not an image' }));
    const big = new File(['x'], 'a.png', { type: 'image/png' });
    Object.defineProperty(big, 'size', { value: 6 * 1024 * 1024 });
    pick(big);
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Image too large' }));
    expect(postJSON).not.toHaveBeenCalled();
  });

  it('deletes an upload that Cancel abandons, and keeps the one a save references', async () => {
    postJSON.mockResolvedValue({ url: '/api/public/media/certifications/c1/images/badge-9.png' });
    const onClose = vi.fn();
    render(<CertEditor cert={EXISTING} allCerts={[]} onClose={onClose} onSaved={vi.fn()} />);
    await act(async () => {
      pick(new File(['x'], 'a.png', { type: 'image/png' }));
    });
    await waitFor(() =>
      expect(postJSON).toHaveBeenCalledWith('cms/uploads/certifications', expect.anything())
    );
    await waitFor(() =>
      expect(screen.getByLabelText('Image URL')).toHaveValue(
        '/api/public/media/certifications/c1/images/badge-9.png'
      )
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    });
    expect(onClose).toHaveBeenCalled();
    await waitFor(() =>
      expect(sendJSON).toHaveBeenCalledWith('cms/certifications/images', 'DELETE', {
        path: 'c1/images/badge-9.png',
      })
    );
  });
});

describe('order and issuer helpers', () => {
  const all = [
    { _docId: 'a', issuer: 'Microsoft', display_order: 1, name: 'A' },
    { _docId: 'b', issuer: 'microsoft', display_order: 2, name: 'B' },
    { _docId: 'c', issuer: 'AWS', display_order: 4, name: 'C' },
    { _docId: 'd', issuer: 'Unknown' },
  ];

  it('reads one global ladder across issuers and suggests the first free order on it', () => {
    const siblings = siblingsOf(all, 'x');
    expect(siblings.map((s) => s._docId)).toEqual(['a', 'b', 'c', 'd']);
    expect(nextFreeOrder(siblings)).toBe(3);
    expect(siblingsOf(all, 'a').map((s) => s._docId)).toEqual(['b', 'c', 'd']);
    expect(ladderWindow(siblings, 2, 1).map((s) => s._docId)).toEqual(['a', 'b', 'c']);
  });

  it('builds the issuer list from the collection, deduped case-insensitively, plus the registry', () => {
    // With no curated list: the collection alone, the first spelling kept.
    expect(issuerOptionsFrom(all, [])).toEqual(['AWS', 'Microsoft']);
    // With the registry (the default): its names join, the collection's
    // spelling wins a tie, and an issuer no cert carries yet is offered.
    const options = issuerOptionsFrom(all);
    expect(options).toEqual([...options].sort((a, b) => a.localeCompare(b)));
    expect(options).toContain('Anthropic');
    expect(options.filter((o) => o.toLowerCase() === 'microsoft')).toEqual(['Microsoft']);
    expect(options).toContain('AWS');
  });
});
