/**
 * The one provider canonicaliser (T-738).
 *
 * Before this module there were four independent implementations —
 * `useBlogData`, `useProviderLandingContent`, `lib/contentModel.js` and
 * `lib/blogUtils.js` — with different alias tables, and the divergence was
 * live rather than hypothetical: `useProviderLandingContent` knew `vmware`,
 * `broadcom`, `ansible` and `redhat`; `useBlogData` did not. So a VMware or
 * Ansible document with no explicit provider field appeared on the landing
 * page and vanished from `/vmware/blog`. Nobody had changed anything; one copy
 * had simply been updated and the others had not.
 *
 * The table below is the reason this file exists. Adding a provider is a data
 * edit in one place, not four code edits that someone has to remember to keep
 * in step, and `providers.test.js` walks the table so a new entry is covered
 * the moment it is added.
 *
 * **Matching is by substring, not exact key.** Real documents carry
 * "Microsoft Azure", "Amazon Web Services", "AWS Lambda" — values that an
 * exact-key alias map turns into `microsoftazure` and `awslambda`, which are
 * not routes. `contentModel.normalizeContentProvider` did exactly that, and
 * because it feeds `getContentPublicPath`, a multi-word provider produced a
 * URL no route serves.
 */

/** The providers the router actually serves; mirrors VALID_PROVIDERS. */
export const CANONICAL_PROVIDERS = Object.freeze([
  'azure',
  'aws',
  'gcp',
  'github',
  'terraform',
  'finops',
  'vmware',
  'ansible',
  'docker',
]);

/**
 * Ordered because the first match wins and some tokens are substrings of
 * phrases belonging to another provider — "google cloud" must be tested
 * before a bare "google" would matter, and `github` before anything that
 * merely contains "git".
 *
 * `squashed` matches a value with all non-alphanumerics stripped (so
 * "Google Cloud" → "googlecloud"); `text` matches free prose, where the spaces
 * survive. Keeping the two lists separate is what lets "cloud.google" work in
 * prose without polluting the squashed form.
 *
 * `docker` is LAST on purpose. Containers come up in writing about every other
 * provider — "Docker images on Azure Container Apps", "a GitHub workflow that
 * builds a Docker image" — and those documents belong to the other provider.
 * Last means a text is filed under Docker only when it names no one else,
 * which is also the only case where adding Docker changes an answer at all:
 * before it was in this table, such a text inferred no provider.
 */
export const PROVIDER_ALIASES = Object.freeze([
  { provider: 'github', squashed: ['github'], text: ['github'] },
  { provider: 'terraform', squashed: ['terraform'], text: ['terraform'] },
  { provider: 'finops', squashed: ['finops'], text: ['finops'] },
  { provider: 'azure', squashed: ['azure', 'microsoft'], text: ['azure', 'microsoft'] },
  {
    provider: 'gcp',
    squashed: ['gcp', 'googlecloud'],
    text: ['gcp', 'google cloud', 'cloud.google'],
  },
  {
    provider: 'aws',
    squashed: ['aws', 'amazon'],
    text: ['aws', 'amazon web services', 'amazon'],
  },
  { provider: 'vmware', squashed: ['vmware', 'broadcom'], text: ['vmware', 'broadcom'] },
  { provider: 'ansible', squashed: ['ansible', 'redhat'], text: ['ansible', 'red hat'] },
  { provider: 'docker', squashed: ['docker'], text: ['docker'] },
]);

/** Lowercase, strip everything that is not a letter or digit. */
export function squashProvider(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Canonicalise an explicit provider field.
 *
 * An unrecognised value is returned squashed rather than dropped: the
 * hooks have always behaved that way, and silently emptying a provider would
 * turn "a document filed under something we do not know" into "a document
 * with no provider at all", which reads identically to a data defect.
 */
export function canonicalizeProvider(value) {
  const squashed = squashProvider(value);
  if (!squashed) return '';
  for (const { provider, squashed: tokens } of PROVIDER_ALIASES) {
    if (tokens.some((token) => squashed.includes(token))) return provider;
  }
  return squashed;
}

// The fields a stored document may name its provider in, most specific first.
const DOC_PROVIDER_FIELDS = Object.freeze([
  'Cloud Provider',
  'cloudProvider',
  'provider',
  'Provider',
  'primaryProvider',
]);

/**
 * Canonicalise the provider a document names itself: the first filled-in
 * provider field, read the same way as `a || b || c`.
 */
export function canonicalDocProvider(doc = {}) {
  return canonicalizeProvider(
    DOC_PROVIDER_FIELDS.reduce((found, field) => found || doc[field], undefined)
  );
}

/**
 * Infer a provider from free text (a title, a summary, a URL).
 *
 * Returns '' when nothing matches — unlike `canonicalizeProvider`, because
 * here "no evidence" is the honest answer and a squashed sentence is not a
 * provider.
 */
export function inferProviderFromText(value) {
  const text = String(value ?? '').toLowerCase();
  if (!text) return '';
  for (const { provider, text: tokens } of PROVIDER_ALIASES) {
    if (tokens.some((token) => text.includes(token))) return provider;
  }
  return '';
}

/**
 * `inferProviderFromText` over several fields of a document, in order: the
 * first field that names a provider wins, and '' when none does.
 */
export function inferProviderFromFields(doc, fields) {
  for (const field of fields) {
    const provider = inferProviderFromText(doc[field]);
    if (provider) return provider;
  }
  return '';
}

/** Whether a canonicalised value is one the router serves. */
export function isCanonicalProvider(value) {
  return CANONICAL_PROVIDERS.includes(value);
}
