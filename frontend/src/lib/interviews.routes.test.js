/**
 * Which interview routes the build pre-renders (scripts/prerender-entry.jsx):
 * the list and one page per interview, for Azure only, and none at all while
 * there is no interview file.
 *
 * The data module is replaced with a list this test controls, so what is
 * checked is the route derivation, not the contents of the folder.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeInterview } from '@/test-utils/interviews';

async function routesFor(list) {
  vi.resetModules();
  vi.doMock('@/data/interviews', () => ({ interviews: list, findInterview: () => undefined }));
  const entry = await import('../../scripts/prerender-entry.jsx');
  return entry.routes();
}

afterEach(() => {
  vi.doUnmock('@/data/interviews');
});

describe('pre-rendered interview routes', () => {
  it('lists none while there are no interviews: the empty list would be a thin page in the sitemap', async () => {
    const routes = await routesFor([]);
    expect(routes.filter((route) => route.includes('interviews'))).toEqual([]);
  });

  it('lists the list and every interview once there are some', async () => {
    const routes = await routesFor([makeInterview('first-one'), makeInterview('second-one')]);
    expect(routes.filter((route) => route.includes('interviews'))).toEqual([
      '/azure/interviews',
      '/azure/interviews/first-one',
      '/azure/interviews/second-one',
    ]);
  });

  it('is Azure only: no other provider gets an interviews route', async () => {
    const routes = await routesFor([makeInterview('first-one')]);
    const elsewhere = routes.filter(
      (route) => route.includes('interviews') && !route.startsWith('/azure/')
    );
    expect(elsewhere).toEqual([]);
  });

  it('never repeats a route, since one render and one sitemap entry per route is the rule', async () => {
    const routes = await routesFor([makeInterview('first-one')]);
    const interviewRoutes = routes.filter((route) => route.includes('interviews'));
    expect(new Set(interviewRoutes).size).toBe(interviewRoutes.length);
  });
});
