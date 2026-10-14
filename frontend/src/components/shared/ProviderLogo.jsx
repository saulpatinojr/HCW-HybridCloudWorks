import React from 'react';
import { cn } from '@/lib/utils';
import { PROVIDER_LOGOS } from '@/lib/providerLogos';

/**
 * A provider's logo that reads on the light theme and on the dark one.
 *
 * Where a provider has two variants, BOTH are rendered and CSS shows one:
 * `dark:hidden` on the light-surface file, `hidden dark:inline` on the other.
 * `theme-init.js` puts `.dark` on <html> before first paint, so the right one
 * is the only one ever painted, and a browser does not fetch a lazy image
 * that is `display: none`.
 *
 * Picking the file in React instead (`theme === 'dark' ? … : …`) broke on
 * every pre-rendered page. The pre-renderer's jsdom reports no dark
 * preference, so the static HTML carried the light file; React's hydration
 * keeps a server attribute that differs from the client's, so a visitor on
 * the dark theme kept the black GitHub mark on a near-black page (seen on the
 * home strip, 2026-09-28).
 *
 * Every other prop goes to both <img> elements.
 */
export default function ProviderLogo({ provider, className, alt = '', ...imgProps }) {
  const logo = PROVIDER_LOGOS[provider];
  if (!logo) return null;
  if (logo.light === logo.dark) {
    return <img src={logo.light} alt={alt} className={className} {...imgProps} />;
  }
  return (
    <>
      <img src={logo.light} alt={alt} className={cn(className, 'dark:hidden')} {...imgProps} />
      <img
        src={logo.dark}
        alt=""
        aria-hidden="true"
        className={cn(className, 'hidden dark:inline')}
        {...imgProps}
      />
    </>
  );
}
