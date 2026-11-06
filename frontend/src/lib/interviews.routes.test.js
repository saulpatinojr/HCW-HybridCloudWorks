/**
 * Which interview routes the build pre-renders (scripts/prerender-entry.jsx):
 * since ADR 0040 they come from the content manifest, like the article
 * pages, so the entry lists exactly what the manifest says and nothing of
 * its own. The derivation (the list page only once there is an interview,
 * one page per published interview, Azure only) lives in
 * scripts/build-content-manifest.mjs and is tested there.
 */
import { describe, expect, it } from 'vitest';
import { routes } from '../../scripts/prerender-entry.jsx';

const interviewRoutes = (list) => list.filter((route) => route.includes('interviews'));

describe('pre-rendered interview routes', () => {
  it('lists none without a manifest, or with a manifest that carries none: the entry invents no interview', () => {
    expect(interviewRoutes(routes())).toEqual([]);
    expect(interviewRoutes(routes({ routes: ['/azure/blog/a-post'] }))).toEqual([]);
  });

  it('lists exactly the manifest’s interview routes, once each', () => {
    const manifest = {
      routes: ['/azure/interviews', '/azure/interviews/first-one', '/azure/interviews/second-one'],
    };
    expect(interviewRoutes(routes(manifest))).toEqual(manifest.routes);
    const all = routes(manifest);
    expect(new Set(all).size).toBe(all.length);
  });
});
