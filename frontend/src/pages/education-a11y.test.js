/**
 * Guards for two defects the education pages shipped with, both of which are
 * invisible to every other test in this repository because both are a matter
 * of which class or attribute a JSX element happens to carry.
 *
 * 1. Light mode. `src/index.css` sets `--background: 0 0% 100%` and
 *    `--card: 0 0% 100%`, and `ThemeContext` follows the OS by default, so a
 *    heading with a bare `text-white` is white on white for any visitor whose
 *    machine is in light mode. Five of the six certification hubs had fifteen
 *    of them each and zero `dark:text-white`; the Azure page, built later,
 *    had the `text-slate-950 dark:text-white` pairing throughout. The page
 *    still renders, still passes a render test, and is simply blank.
 *
 *    `text-white` on a coloured button is the correct thing and stays — the
 *    rule below is therefore "paired with `dark:` OR sitting on an opaque
 *    background", not "never".
 *
 * 2. The carousel pagination. The dots were `<button />` with no children and
 *    no label, which a screen reader announces as "button, button, button",
 *    and the prev/next buttons contained only the ligature text
 *    `chevron_left` / `chevron_right`, which is announced literally.
 *
 * A grep over the source is the right shape for both: the failure mode is a
 * class name or a missing attribute, so nothing short of reading the source
 * can see it, and the cost of regressing is one plausible-looking line.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// `process.cwd()` rather than `import.meta.url`: under the jsdom environment
// Vite rewrites `import.meta.url` to an http URL. Same reasoning as
// `lib/msal-not-on-public-routes.test.js`.
const SRC = resolve(process.cwd(), 'src');

/** The certification hubs with a `certifications` carousel. */
const HUBS = [
  'pages/aws/EducationPage.jsx',
  'pages/azure/EducationPage.jsx',
  'pages/gcp/EducationPage.jsx',
  'pages/github/EducationPage.jsx',
  'pages/terraform/EducationPage.jsx',
  'pages/finops/EducationPage.jsx',
];

/**
 * The carousel chrome the GCP, GitHub and Terraform hubs render from one
 * shared component (PR #841). The pagination assertions below read the
 * source that holds the markup, so for these hubs they read this file.
 */
const SHARED_CAROUSEL = 'components/education/CertificationCarouselSection.jsx';
/** The Azure hub's sections live beside it, in their own module (Qlty smells cleanup). */
const AZURE_SECTIONS = 'pages/azure/education/AzureEducationSections.jsx';
// The AWS, Azure and FinOps hubs lay out their own carousels but render the
// pagination controls from the shared component (Qlty smells cleanup, round 2).
const CAROUSEL_SOURCE = {
  'pages/aws/EducationPage.jsx': SHARED_CAROUSEL,
  'pages/azure/EducationPage.jsx': SHARED_CAROUSEL,
  'pages/finops/EducationPage.jsx': SHARED_CAROUSEL,
  'pages/gcp/EducationPage.jsx': SHARED_CAROUSEL,
  'pages/github/EducationPage.jsx': SHARED_CAROUSEL,
  'pages/terraform/EducationPage.jsx': SHARED_CAROUSEL,
};

/** Hubs plus the detail templates they link to. */
const EDUCATION_FILES = [
  ...HUBS,
  SHARED_CAROUSEL,
  AZURE_SECTIONS,
  'pages/azure/education/azureTimeline.jsx',
  'pages/shared/education/EducationSections.jsx',
  'pages/aws/education/CertDetailPage.jsx',
  'pages/azure/education/CertDetailPage.jsx',
  'pages/aws/education/MicrocredentialDetailPage.jsx',
  // The parts the detail pages and the AWS and Azure hubs share.
  'components/education/CertDetailParts.jsx',
  'components/education/FeaturedTopicList.jsx',
  'components/education/CertStatusBadge.jsx',
  // Rendered inside the Azure and AWS detail pages, and missed by the first
  // sweep: its heading was the one bare `text-white` left on those routes.
  'components/education/ListenAndLearn.jsx',
];

const read = (rel) => readFileSync(resolve(SRC, rel), 'utf8');

/**
 * Every `className` value in a file, as `{ value, line }`. Both the string
 * form and the template-literal form; prettier keeps each on one line, so a
 * line number is enough to point at the offender.
 */
function classNames(source) {
  const out = [];
  const re = /className=(?:"([^"]*)"|\{`([^`]*)`\})/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    out.push({
      value: m[1] ?? m[2],
      line: source.slice(0, m.index).split('\n').length,
    });
  }
  return out;
}

/**
 * An opaque background — the one place a bare `text-white` belongs. Matches
 * `bg-amber-700`, `bg-slate-600`, `bg-primary` and `bg-primary/90`, but not
 * `bg-card/40` or `bg-amber-500/20`, whose light-mode composite is near-white.
 * A `${...}` hole naming a button class (MicrocredentialDetailPage builds its
 * CTA colour that way) counts too.
 *
 * ONLY A BASE TOKEN COUNTS — a variant prefix disqualifies it. The first
 * version tested the whole class string with `\b`, which matches after a
 * colon, so `hover:bg-amber-700 text-white` read as opaque while being white
 * on white in the state a reader actually arrives in. `dark:bg-*` and
 * `sm:bg-*` had the same hole: a background that exists only in dark mode, or
 * only above a breakpoint, is no defence in light mode on a phone. A guard
 * with a hole in it is worse than no guard, because it is trusted.
 * (Copilot review of f05cf27d.)
 *
 * Opacity at or above 80% still counts — `bg-primary/90` is what Azure's
 * timeline scroll buttons use, and it composites nowhere near white.
 */
const OPAQUE_BG = /^bg-(?:[a-z]+-\d{2,3}|primary|secondary|accent)(?:\/(?:8\d|9\d|100))?$/;

function hasOpaqueBackground(value) {
  const base = value.split(/\s+/).filter((token) => !token.includes(':'));
  return base.some((token) => OPAQUE_BG.test(token)) || /\$\{[^}]*\bbtn\b[^}]*\}/.test(value);
}

/** Class tokens that end in `text-white`, keeping their variant chain. */
function whiteTextTokens(value) {
  return value.split(/\s+/).filter((t) => /(^|:)text-white$/.test(t));
}

describe('education pages are readable in light mode', () => {
  for (const rel of EDUCATION_FILES) {
    it(`${rel} pairs every bare text-white with a dark: variant or an opaque background`, () => {
      const offenders = classNames(read(rel))
        .filter(({ value }) => {
          const tokens = whiteTextTokens(value);
          if (tokens.length === 0) return false;
          if (tokens.every((t) => t.includes('dark:'))) return false;
          return !hasOpaqueBackground(value);
        })
        .map(({ value, line }) => `${rel}:${line} — ${value}`);

      expect(
        offenders,
        `\nBare text-white on a --card / --background surface is white on white in light mode.
Use "text-slate-950 dark:text-white", as azure/EducationPage.jsx does:
${offenders.join('\n')}`
      ).toEqual([]);
    });
  }

  it('CertStatusBadge gives every status a light-mode foreground', () => {
    const source = read('components/education/CertStatusBadge.jsx');
    const block = source.slice(
      source.indexOf('const STATUS_CLASS'),
      source.indexOf('export default')
    );
    const entries = [...block.matchAll(/^\s*(\w+): '([^']+)',$/gm)];
    expect(entries.length).toBeGreaterThanOrEqual(4);
    for (const [, status, classes] of entries) {
      // A `*-300` foreground on a `*-500/20` tint is ~1.5:1 once that tint is
      // composited over a white card. Each status needs a light foreground
      // and the original as the dark: variant.
      expect(classes, `${status} has no light-mode foreground`).toMatch(
        /(^|\s)text-[a-z]+-(7|8|9)00(\s|$)/
      );
      expect(classes, `${status} has no dark: foreground`).toMatch(/\sdark:text-[a-z]+-\d{3}/);
    }
  });
});

describe('education carousels are usable with a screen reader', () => {
  for (const rel of HUBS) {
    const source = read(CAROUSEL_SOURCE[rel] ?? rel);

    it(`${rel} labels each pagination dot and marks the current one`, () => {
      expect(source).toContain('aria-label={`Page ${i + 1} of ${totalPages}`}');
      expect(source).toMatch(/aria-current=\{i === carouselPage \?/);
    });

    it(`${rel} gives the dots a 24px target without growing the dot`, () => {
      // WCAG 2.5.8: the hit area, not the ink. The dot stays 10px and the
      // button around it is 24px.
      expect(source).toMatch(/className="group flex h-6 min-w-6 items-center justify-center/);
    });

    it(`${rel} labels the prev/next buttons rather than leaving the ligature to be read`, () => {
      for (const label of ['Previous page', 'Next page']) {
        expect(source).toContain(`aria-label="${label}"`);
      }
    });
  }

  for (const rel of EDUCATION_FILES) {
    it(`${rel} hides decorative material-symbols icons from the accessibility tree`, () => {
      const source = read(rel);
      const unhidden = [];
      const re = /<span\b[^<>]*material-symbols-outlined[^<>]*>/g;
      let m;
      while ((m = re.exec(source)) !== null) {
        if (!m[0].includes('aria-hidden')) {
          unhidden.push(`${rel}:${source.slice(0, m.index).split('\n').length} — ${m[0]}`);
        }
      }
      expect(
        unhidden,
        `\nA material-symbols span with no aria-hidden is read aloud as its ligature name
("workspace_premium", "arrow_forward"):
${unhidden.join('\n')}`
      ).toEqual([]);
    });
  }
});
