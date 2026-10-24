/**
 * The Linkie allowlist after Linkie renamed profiles to pages (October 2026).
 *
 * The frontend side (every path the Linkie Hub builds, through this same
 * matcher) is frontend/src/lib/linkie.test.js. This file owns the other half:
 * what the proxy itself allows and refuses, and that `linkieProxy` is built
 * with this list and not a second copy.
 */
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

import { LINKIE_ALLOWED_PATHS } from './linkie-allowlist.js';
import { isAllowedPath } from './rest-proxy.js';

describe('LINKIE_ALLOWED_PATHS', () => {
  it.each([
    ['GET', '/pages'],
    ['GET', '/analytics/traffic-stats'],
    ['GET', '/pages/65a1c8f2d4b9e7f3a2c1b8e1/posts'],
    ['POST', '/pages/65a1c8f2d4b9e7f3a2c1b8e1/posts'],
    ['PATCH', '/pages/65a1c8f2d4b9e7f3a2c1b8e1/posts/x9'],
    ['DELETE', '/pages/65a1c8f2d4b9e7f3a2c1b8e1/posts/x9'],
  ])('allows %s %s', (method, path) => {
    expect(isAllowedPath(LINKIE_ALLOWED_PATHS, path, method)).toBe(true);
  });

  it.each([
    '/profiles',
    '/profiles/abc/posts',
    '/profiles/abc/posts/xyz',
    '/pages/abc',
    '/pages/abc/posts/xyz/extra',
    '/pages/a/b/posts',
    '/billing',
    '/links',
    '/analytics',
  ])('refuses %s', (path) => {
    expect(isAllowedPath(LINKIE_ALLOWED_PATHS, path, 'GET')).toBe(false);
  });

  it('is frozen, so nothing can widen it after the proxy is built', () => {
    expect(Object.isFrozen(LINKIE_ALLOWED_PATHS)).toBe(true);
    expect(Object.isFrozen(LINKIE_ALLOWED_PATHS.paths)).toBe(true);
    expect(Object.isFrozen(LINKIE_ALLOWED_PATHS.patterns)).toBe(true);
  });

  it('is the list linkieProxy is built with, not a second copy', () => {
    const source = readFileSync(new URL('../../functions/integrations-http.js', import.meta.url), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).toMatch(/allowedPaths: LINKIE_ALLOWED_PATHS/);
    expect(code).not.toMatch(/\/profiles/);
  });
});
