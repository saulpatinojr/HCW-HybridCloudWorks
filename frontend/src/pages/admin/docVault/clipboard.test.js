/**
 * copyText (clipboard.js): the clipboard API first, the old copy command when
 * the API is missing or refused, and false when neither works.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { copyText } from './clipboard';

const setClipboard = (value) =>
  Object.defineProperty(navigator, 'clipboard', { value, configurable: true });

beforeEach(() => {
  document.execCommand = vi.fn(() => true);
});

afterEach(() => {
  setClipboard(undefined);
  delete document.execCommand;
  vi.restoreAllMocks();
});

describe('copyText', () => {
  it('writes through the clipboard API when it is there', async () => {
    const writeText = vi.fn(async () => {});
    setClipboard({ writeText });
    expect(await copyText('Dear team,\n\nThank you.')).toBe(true);
    expect(writeText).toHaveBeenCalledWith('Dear team,\n\nThank you.');
    expect(document.execCommand).not.toHaveBeenCalled();
  });

  it('leaves the line endings alone', async () => {
    const writeText = vi.fn(async () => {});
    setClipboard({ writeText });
    await copyText('a\r\nb\nc');
    expect(writeText).toHaveBeenCalledWith('a\r\nb\nc');
  });

  it('falls back to the copy command when there is no clipboard API', async () => {
    setClipboard(undefined);
    let copied = null;
    document.execCommand = vi.fn(() => {
      copied = document.activeElement.value;
      return true;
    });
    expect(await copyText('the text')).toBe(true);
    expect(document.execCommand).toHaveBeenCalledWith('copy');
    expect(copied).toBe('the text');
  });

  it('falls back when the API refuses, and removes the hidden box either way', async () => {
    setClipboard({ writeText: vi.fn(async () => Promise.reject(new Error('NotAllowedError'))) });
    expect(await copyText('x')).toBe(true);
    expect(document.execCommand).toHaveBeenCalledTimes(1);
    expect(document.querySelectorAll('textarea')).toHaveLength(0);
  });

  it('gives the focus back to where it was', async () => {
    setClipboard(undefined);
    const button = document.createElement('button');
    document.body.appendChild(button);
    button.focus();
    await copyText('x');
    expect(document.activeElement).toBe(button);
    button.remove();
  });

  it('says false when neither way works', async () => {
    setClipboard(undefined);
    document.execCommand = vi.fn(() => false);
    expect(await copyText('x')).toBe(false);
    document.execCommand = vi.fn(() => {
      throw new Error('blocked');
    });
    expect(await copyText('x')).toBe(false);
    delete document.execCommand;
    expect(await copyText('x')).toBe(false);
    expect(document.querySelectorAll('textarea')).toHaveLength(0);
  });

  it('copes with nothing to copy', async () => {
    const writeText = vi.fn(async () => {});
    setClipboard({ writeText });
    await copyText(null);
    expect(writeText).toHaveBeenCalledWith('');
  });
});
