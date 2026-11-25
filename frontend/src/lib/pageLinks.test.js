/**
 * The two halves of "which Pages can send work into the Pipeline" (#1886):
 * the server's ORIGIN_PAGES (functions/src/lib/page-links/origin-pages.js), which
 * checks a reference, and this build's ORIGIN_RECORD_PATHS, which opens one.
 * A Page added to one and not the other fails here, as does one with no nav
 * entry (its name and icon come from the nav registry) or a link that names a
 * parameter no page reads.
 */
import { describe, it, expect } from 'vitest';
import { ORIGIN_PAGE_IDS } from '../../../functions/src/lib/page-links/origin-pages.js';
import { navItemById } from '@/config/adminNav';
import { LINK_PARAMS, isAdminPath } from '@/lib/itemLinks';
import { ORIGIN_RECORD_PAGE_IDS, ORIGIN_RECORD_PATHS, originLink } from './pageLinks';

describe('the Pages that send work into the Pipeline', () => {
  it('are the same list on the server and here', () => {
    expect([...ORIGIN_RECORD_PAGE_IDS].sort()).toEqual([...ORIGIN_PAGE_IDS].sort());
  });

  it('each has a nav entry, and a record link inside the admin that names a known parameter', () => {
    const known = new Set(['tab', ...Object.values(LINK_PARAMS)]);
    for (const page of ORIGIN_PAGE_IDS) {
      expect(navItemById(page), page).not.toBeNull();
      const href = ORIGIN_RECORD_PATHS[page]({ page, id: 'record-1', part: null, label: 'x' });
      expect(isAdminPath(href), href).toBe(true);
      const url = new URL(href, 'https://hybridcloudworks.com');
      expect(url.pathname).toBe(navItemById(page).to);
      for (const name of url.searchParams.keys()) expect(known.has(name), name).toBe(true);
      expect([...url.searchParams.values()]).toContain('record-1');
    }
  });
});

describe('originLink', () => {
  it('names the Page from the nav registry and links the record', () => {
    const link = originLink({
      page: 'ambassador',
      id: 'program-gitkraken-ambassador',
      part: null,
      label: 'GitKraken Ambassador',
    });
    expect(link).toMatchObject({
      pageLabel: 'Ambassador',
      label: 'GitKraken Ambassador',
      href: '/admin/ambassador?tab=programs&program=program-gitkraken-ambassador',
    });
    expect(link.icon).toBeTruthy();
  });

  it('encodes the id', () => {
    expect(originLink({ page: 'ambassador', id: 'a&b', label: 'x' }).href).toContain(
      'program=a%26b'
    );
  });

  it('is null for no reference, and for a Page this build does not know', () => {
    expect(originLink(null)).toBeNull();
    expect(originLink({ page: 'not-a-page', id: 'x' })).toBeNull();
    expect(originLink({ page: 'ambassador' })).toBeNull();
  });
});
