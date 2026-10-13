// @vitest-environment node
/**
 * Public pages speak to visitors only (owner direction 2026-09-28).
 *
 * "Scrub all user-facing pages; remove references to backend workings. The
 * user only knows the front end and doesn't know about tools we use (i.e.
 * Cloudflare, etc.), or when you mention items that the admin needs to
 * resolve." The Landing Zone Builder had been printing "The lab is not
 * taking public jobs yet: its browser check (Cloudflare Turnstile) is not
 * configured." under its button, the model and time under every AI
 * explanation, and the labs page named the host's vendor, the API host and
 * the issue that would build the next section.
 *
 * WHAT IS SCANNED. Every string a public page or component can put on the
 * screen: string literals, template text and JSX text in `pages/`,
 * `components/`, `hooks/` and the lab catalogue, admin excluded, read from
 * the parsed module so comments (which may name anything) are not mistaken
 * for copy. Import paths, object keys, `console.*` arguments and
 * SCREAMING_SNAKE machine codes are not copy and are skipped; the codes are
 * kept on purpose, for logs and the admin pages, and the pages map each one
 * to their own words. The static files in `public/` are scanned too.
 *
 * WHAT IS ALLOWED, AND WHERE. The site teaches Azure, AWS, Terraform, GitHub
 * and the rest, so a service can be subject matter: Azure OpenAI on the
 * Azure education page, Cosmos DB in an architecture blueprint, GitHub
 * Actions on the GitHub pages. Those allowances are per file and per term,
 * below, and an allowance nothing needs any more fails the test, so the list
 * can only shrink. The legal pages must name the processors the site uses,
 * by law, and are allowed the vendor terms.
 *
 * The parser is Vite's (`parseSync`, rolldown's oxc parser), already a
 * dependency of the build.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parseSync } from 'vite';
import { describe, expect, it } from 'vitest';

const FRONTEND = process.cwd();
const SRC = join(FRONTEND, 'src');

/** Words a visitor must never read: the site's own implementation, and an admin's to-do list. */
const BACKEND_TERMS = Object.freeze({
  edge: /cloudflare|turnstile/i,
  apiHost: /azure functions?\b|function app|static web apps?\b/i,
  stores: /cosmos|key ?vault/i,
  ai: /gemini|openai|anthropic|nvidia|\b(?:gpt|claude)-\d/i,
  vendors: /elevenlabs|rss\.com|podbean|publer|\bresend\b|hostinger/i,
  pipeline: /github app\b|github actions|\bTFC\b|hcp terraform/i,
  labHost: /\bvps\b/i,
  // The runner behind "Validate on the lab" and what its job log shows: never
  // page copy (owner request 2026-09-28). The learner image, hcw-lab, is
  // subject matter and is not this.
  labRunner: /hcw-lab-runner|sha256:|\/opt\/avm\b|\(unauthenticated\)/i,
  cms: /contentforge|framework studio|review board|admin board/i,
  limits: /queue ceiling|\bTTL\b/,
  adminTodo:
    /not configured|not provisioned|\bthe owner\b|admin needs to|key vault reference|production estate|endpoint is not published/i,
  issue: /\b(?:issue|pull request|PR) ?#/i,
});

/**
 * Subject matter, not implementation: the files where a term is what the page
 * teaches, and the terms each may use. Nothing else may.
 */
const SUBJECT_MATTER = Object.freeze({
  'pages/azure/EducationPage.jsx': ['ai', 'pipeline'],
  'pages/azure/LandingPage.jsx': ['ai'],
  'pages/azure/architecture-blueprints.js': ['stores'],
  'pages/github/BlogPage.jsx': ['pipeline'],
  'pages/github/EducationPage.jsx': ['pipeline'],
  'pages/github/LandingPage.jsx': ['pipeline'],
  'pages/github/WorkflowsPage.jsx': ['pipeline'],
  'pages/submissions/RosettaStoneSubmissionPage.jsx': ['stores'],
  'pages/terraform/EducationPage.jsx': ['pipeline'],
  'pages/terraform/LandingPage.jsx': ['pipeline'],
  'pages/tools/pricingPages.js': ['stores'],
  'components/labs/SandboxSection.jsx': ['ai'],
  'components/shared/ProviderBlogPage.jsx': ['ai'],
});

/** The legal pages name the processors the site uses, because they must. */
const LEGAL = Object.freeze({
  'public/privacy-policy.html': ['edge', 'vendors'],
  'public/terms-of-service.html': ['edge', 'vendors'],
});

const ROOTS = ['pages', 'components', 'hooks', 'data/labs', 'data/addons'];
const ADMIN = /^(?:pages|components)\/admin\//;
const SOURCE = /\.(?:jsx?|tsx?)$/;
const TEST = /\.(?:test|spec)\.|\.fixture\./;
const CODE = /^[A-Z][A-Z0-9_]+$/;

function walkFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walkFiles(path) : [path];
  });
}

const rel = (path, from) => relative(from, path).replace(/\\/g, '/');

/** Every public source file, relative to src/. */
const publicSources = () =>
  ROOTS.flatMap((root) => walkFiles(join(SRC, root)))
    .map((path) => rel(path, SRC))
    .filter((path) => SOURCE.test(path) && !TEST.test(path) && !ADMIN.test(path))
    .sort();

/** Walk every node of an ESTree tree, telling the visitor each node's parent. */
function walk(node, visit, parent = null) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit, parent);
    return;
  }
  if (typeof node.type === 'string' && visit(node, parent) === false) return;
  for (const [key, value] of Object.entries(node)) {
    if (key !== 'type' && value && typeof value === 'object') walk(value, visit, node);
  }
}

const isConsoleCall = (node) =>
  node.type === 'CallExpression' &&
  node.callee?.type === 'MemberExpression' &&
  node.callee.object?.name === 'console';

/** Nodes that name a module path rather than saying anything. */
const MODULE_PATH_NODES = new Set([
  'ImportDeclaration',
  'ImportExpression',
  'ExportAllDeclaration',
]);
const isReExport = (node) => node.type === 'ExportNamedDeclaration' && Boolean(node.source);

/** Nodes whose strings are not copy: module paths and console output. */
const skipsSubtree = (node) =>
  MODULE_PATH_NODES.has(node.type) || isReExport(node) || isConsoleCall(node);

/** A property key, which names a field rather than saying anything. */
const isKey = (node, parent) =>
  parent?.type === 'Property' && parent.key === node && !parent.computed;

/**
 * The strings in one module a visitor could read: literals, template text and
 * JSX text, minus module paths, object keys, console output and codes.
 */
function visibleStrings(source, filename) {
  const { program, errors } = parseSync(filename, source);
  if (errors.length) throw new Error(`${filename} did not parse: ${errors[0].message}`);
  const found = [];
  walk(program, (node, parent) => {
    if (skipsSubtree(node)) return false;
    if (node.type === 'Literal' && typeof node.value === 'string' && !isKey(node, parent)) {
      if (!CODE.test(node.value)) found.push(node.value);
    } else if (node.type === 'TemplateElement') {
      found.push(node.value.cooked ?? node.value.raw);
    } else if (node.type === 'JSXText' && node.value.trim()) {
      found.push(node.value.replace(/\s+/g, ' ').trim());
    }
    return true;
  });
  return found;
}

/** The backend terms a string names, as `term: "match"`. */
function termsIn(text) {
  return Object.entries(BACKEND_TERMS).flatMap(([term, pattern]) => {
    const match = String(text).match(pattern);
    return match ? [[term, match[0]]] : [];
  });
}

/** What a file says that it may not: `[term, match, text]` for every term outside its allowance. */
function offences(texts, allowed = []) {
  return texts.flatMap((text) =>
    termsIn(text)
      .filter(([term]) => !allowed.includes(term))
      .map(([term, match]) => [term, match, text.slice(0, 160)])
  );
}

describe('the scan itself', () => {
  it('reads literals, template text and JSX text, and skips paths, keys, console output and codes', () => {
    const source = [
      "import { loadTurnstile } from '@/lib/turnstile';",
      "const lines = { unavailable: 'Plain words.', TURNSTILE_NOT_CONFIGURED: 'x' };",
      "const codes = ['TURNSTILE_NOT_CONFIGURED'];",
      'const t = `Checked ${when} ago`;',
      "console.warn('Cloudflare said no');",
      '// Cloudflare Turnstile, in a comment',
      'export const P = () => <p title="A title">Some text</p>;',
    ].join('\n');
    expect(visibleStrings(source, 'probe.jsx')).toEqual([
      'Plain words.',
      'x',
      'Checked ',
      ' ago',
      'A title',
      'Some text',
    ]);
  });

  it.each([
    [
      'The lab is not taking public jobs yet: its browser check (Cloudflare Turnstile) is not configured.',
      'edge',
    ],
    ['gemini-3.5-flash-lite · Sep 28, 2026, 12:10 AM', 'ai'],
    ['The lab host is a Hostinger VPS onboarded to Azure Arc.', 'vendors'],
    ['The Function App reads its Arc row.', 'apiHost'],
    ['Coming soon: this section is being built in issue #677.', 'issue'],
    ['Coming soon: this section is being built in issue #', 'issue'],
    ['Publish framework content from ContentForge to populate this page.', 'cms'],
    [
      "Unable to find image 'ghcr.io/hybridcloudworks/hcw-lab-runner:x@sha256:y' locally",
      'labRunner',
    ],
    ['- connectivity in ../../../opt/avm/avm-ptn-alz@0.21.0', 'labRunner'],
    ['- Installed hashicorp/azurerm v4.81.0 (unauthenticated)', 'labRunner'],
  ])('catches %j', (text, term) => {
    expect(termsIn(text).map(([t]) => t)).toContain(term);
  });

  it.each([
    "Validation on the lab isn't available right now. You can still download the files and validate locally.",
    'AI-generated summary. Check the module documentation before relying on it.',
    "You've reached the limit for explanations for now. Try again in about an hour.",
    'The lab host is a server onboarded to Azure Arc.',
    'The lab uses offline copies of the Azure Verified Modules, so validation needs no internet.',
    'ghcr.io/hybridcloudworks/hcw-lab:latest',
    'hybridcloudworks/hcw-lab:latest',
    // The lab pane (#751): what the page says in place of the tools behind it.
    "Lab workspaces aren't available right now.",
    'Sign in with GitHub to open your lab workspace',
    "Finish signing in with GitHub in the new tab. Your workspace opens here when you're done; if it doesn't, choose I've already signed in.",
    'Lab workspaces are for members of the HybridCloudWorks organization on GitHub.',
    // The Coder credit on the labs page (owner request 2026-09-28; the owner
    // confirmed Coder may be named there), and the intro's Arc sentence.
    ', the open-source platform for self-hosted development environments. Every lab workspace is a Coder workspace built from our lab template.',
    'Coder (opens in a new tab)',
    'a single server whose Azure Arc status is on the live card further down this page.',
    'This card shows what Azure Arc reports for the lab host right now: its connection, its Arc agent and its policy compliance.',
  ])('passes %j', (text) => {
    expect(termsIn(text)).toEqual([]);
  });
});

describe('public pages, components and hooks', () => {
  const files = publicSources();

  it('finds the files it is meant to scan, and no admin file', () => {
    expect(files).toContain('pages/tools/landingZone/labValidateRules.js');
    expect(files).toContain('pages/tools/explain/ExplainControl.jsx');
    expect(files).toContain('components/labs/LabsEstateCard.jsx');
    // The lab pane page and its sign-in step (#751).
    expect(files).toContain('pages/shared/LabPanePage.jsx');
    expect(files).toContain('components/labs/labSignIn.js');
    // The Coder credit beside the labs intro (2026-09-28).
    expect(files).toContain('components/labs/CoderCredit.jsx');
    // The AddOn panes and their catalogue (ADR 0035).
    expect(files).toContain('pages/tools/AddOnPanePage.jsx');
    expect(files).toContain('data/addons/catalogue.js');
    expect(files.filter((f) => ADMIN.test(f))).toEqual([]);
  });

  it.each(files)('%s names nothing behind the site', (file) => {
    const texts = visibleStrings(readFileSync(join(SRC, file), 'utf8'), file);
    expect(offences(texts, SUBJECT_MATTER[file])).toEqual([]);
  });

  it.each(Object.entries(SUBJECT_MATTER))(
    '%s still teaches every term it is allowed, so the allowance is not stale',
    (file, terms) => {
      const texts = visibleStrings(readFileSync(join(SRC, file), 'utf8'), file);
      for (const term of terms) {
        expect(
          texts.some((text) => BACKEND_TERMS[term].test(text)),
          `${file} no longer needs "${term}": remove it from SUBJECT_MATTER`
        ).toBe(true);
      }
    }
  );
});

describe('the static files in public/', () => {
  const PUBLIC = join(FRONTEND, 'public');
  const statics = walkFiles(PUBLIC)
    .map((path) => rel(path, FRONTEND))
    .filter((path) => /\.(?:html|txt|js|json|xml|webmanifest)$/.test(path))
    .sort();

  it.each(statics)('%s names nothing behind the site, legal pages aside', (file) => {
    const text = readFileSync(join(FRONTEND, file), 'utf8');
    expect(offences([text], LEGAL[file])).toEqual([]);
  });

  it('keeps the privacy policy naming the browser check it runs, as the law requires', () => {
    const policy = readFileSync(join(FRONTEND, 'public/privacy-policy.html'), 'utf8');
    expect(policy).toMatch(/Cloudflare Turnstile/);
  });
});
