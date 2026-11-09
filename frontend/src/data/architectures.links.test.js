/**
 * Every lab link on an architecture design page goes to a page the site
 * builds (#1613).
 *
 * Since #1613 an address with no pre-built page answers 404, and the 25
 * design pages in `architectures.js` became pre-built pages of their own.
 * Each one links to a browser lab twice: the "Test in Browser Lab" button
 * (`/education/labs/<interactiveLabId>`) and the "Verify" card's button
 * (`ecosystemPartnerValidation.ctaUrl`, falling back to the same address).
 * Ten of them pointed at `/education/labs/terraform-validate`, a lab id
 * the lab catalogue does not have, so those links led to the not-found page.
 *
 * The list of built pages is `routes()` from the pre-render step, the same
 * list the build writes to disk, read with the content manifest the build
 * uses. The addresses are worked out here the way
 * `ArchitectureDetailTemplate.jsx` works them out.
 */
import { describe, it, expect } from 'vitest';
import manifest from '../../data/content-manifest.json';
import { routes } from '../../scripts/prerender-entry.jsx';
import { architecturesByProvider } from './architectures';

/** The lab links a design page renders, in the template's order of preference. */
function labLinks(design) {
  const links = [];
  if (design.interactiveLabId) links.push(`/education/labs/${design.interactiveLabId}`);
  const validation = design.ecosystemPartnerValidation;
  if (design.interactiveLabId || validation) {
    links.push(
      validation?.cta_url || validation?.ctaUrl || `/education/labs/${design.interactiveLabId}`
    );
  }
  return links;
}

describe('architecture design lab links (#1613)', () => {
  const built = new Set(routes(manifest));
  const designs = Object.entries(architecturesByProvider).flatMap(([provider, catalogue]) =>
    Object.entries(catalogue).map(([slug, design]) => ({ id: `${provider}/${slug}`, design }))
  );

  it('reads every design in the catalogue', () => {
    expect(designs.length).toBe(25);
  });

  it('links only to pages the build writes', () => {
    const dead = designs.flatMap(({ id, design }) =>
      labLinks(design)
        .filter((link) => !built.has(link.split(/[?#]/)[0]))
        .map((link) => `${id} -> ${link}`)
    );
    expect(dead).toEqual([]);
  });
});
