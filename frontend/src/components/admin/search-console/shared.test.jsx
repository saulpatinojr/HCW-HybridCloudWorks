/**
 * `Breakable` (#1612): an address with a line-break hint (`<wbr>`) after each
 * slash and after each dot of its host, so a long one wraps between its parts.
 * The hints add no character, so the text a person reads or copies is the
 * address exactly as given.
 */
import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Breakable } from './shared';

/** The text and the markup `Breakable` draws for one value. */
function draw(text) {
  const { container } = render(
    <span>
      <Breakable text={text} />
    </span>
  );
  const span = container.firstChild;
  return {
    text: span.textContent,
    html: span.innerHTML,
    breaks: span.querySelectorAll('wbr').length,
  };
}

describe('Breakable', () => {
  it('keeps the text exactly as given, for addresses and for odd values', () => {
    const values = [
      'https://podcast.hybridcloudworks.com/e/a-long-slug/',
      'https://docs.hybridcloudworks.com/a?b=c/d#e.f',
      '/blog/x?y=1',
      'sc-domain:hybridcloudworks.com',
      'https://',
      '///',
      '',
    ];
    for (const value of values) expect(draw(value).text).toBe(value);
    expect(draw(null).text).toBe('');
    expect(draw(undefined).text).toBe('');
    expect(draw(42).text).toBe('42');
  });

  it('offers a break after each slash and each dot of the host, never inside the scheme', () => {
    const { html } = draw('https://podcast.hybridcloudworks.com/e/slug/');
    // "https://" stays on the host: no break between the scheme and the name.
    expect(html.startsWith('https://podcast.<wbr>')).toBe(true);
    expect(html).toBe('https://podcast.<wbr>hybridcloudworks.<wbr>com/<wbr>e/<wbr>slug/<wbr>');
  });

  it('does not break at dots in a path, only at its slashes', () => {
    // A bare path (how the main site's pages are shown) has no host part.
    const { html, breaks } = draw('/docs/v1.2/page.html');
    expect(html).toBe('/<wbr>docs/<wbr>v1.2/<wbr>page.html');
    expect(breaks).toBe(3);
  });

  it('adds nothing to a value with no slash and no scheme', () => {
    expect(draw('dva-c03').breaks).toBe(0);
  });
});
