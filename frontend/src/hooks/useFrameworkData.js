import { useMemo } from 'react';
import { usePublicData } from '@/hooks/usePublicData';
import { fetchPublicContentList, PUBLIC_CORPUS_LIMIT } from '@/lib/publicApi';

const normalizeProvider = (value) =>
  String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

const firstPresent = (...values) => {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') {
      return value;
    }
  }
  return null;
};

const normalizeTextList = (value) => {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || '').trim()).filter(Boolean);
  }
  if (typeof value === 'string') {
    return value
      .split(/\n|,|;/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
};

const toSlug = (value) =>
  String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .slice(0, 60);

const inferProviderFromText = (value) => {
  const text = String(value || '').toLowerCase();
  if (!text) return '';

  if (text.includes('finops')) return 'finops';
  if (text.includes('azure') || text.includes('microsoft')) return 'azure';
  if (text.includes('gcp') || text.includes('google cloud') || text.includes('cloud.google')) {
    return 'gcp';
  }
  if (text.includes('aws') || text.includes('amazon web services') || text.includes('amazon')) {
    return 'aws';
  }

  return '';
};

const inferProviderFromDoc = (doc = {}) => {
  const explicit = firstPresent(
    doc['Cloud Provider'],
    doc.cloudProvider,
    doc.provider,
    doc.Provider,
    doc.primaryProvider
  );
  const explicitNormalized = normalizeProvider(explicit);
  if (explicitNormalized) return explicitNormalized;

  const pathProvider = normalizeProvider(String(doc.curatedSubpagePath || '').split('/')[1]);
  if (pathProvider) return pathProvider;

  return firstPresent(
    inferProviderFromText(doc.sourceUrl),
    inferProviderFromText(doc.url),
    inferProviderFromText(doc['CD Url']),
    inferProviderFromText(firstPresent(doc.Title, doc.title)),
    inferProviderFromText(firstPresent(doc.Summary, doc.summary)),
    ''
  );
};

const normalizeConcept = (entry, index = 0) => {
  if (typeof entry === 'string') {
    const label = entry.trim();
    return {
      id: toSlug(label) || `concept-${index + 1}`,
      label,
      summary: '',
      details: '',
      recommendation: '',
      sources: [],
    };
  }

  const label = firstPresent(entry?.label, entry?.title, entry?.name, `Concept ${index + 1}`);
  return {
    id: String(firstPresent(entry?.id, entry?.key, toSlug(label), `concept-${index + 1}`)),
    label,
    summary: firstPresent(entry?.summary, entry?.description, ''),
    details: firstPresent(entry?.details, entry?.implementation, entry?.guidance, ''),
    recommendation: firstPresent(entry?.recommendation, entry?.architectureRecommendation, ''),
    sources: normalizeTextList(firstPresent(entry?.sources, entry?.sourceUrls, entry?.references)),
  };
};

const normalizeConcepts = (doc = {}) => {
  const rawConcepts = firstPresent(
    doc.frameworkConcepts,
    doc.frameworkNodes,
    doc.frameworkPillars,
    doc.keyPillars,
    doc.pillars,
    []
  );

  const concepts = (Array.isArray(rawConcepts) ? rawConcepts : normalizeTextList(rawConcepts)).map(
    normalizeConcept
  );

  if (concepts.length > 0) return concepts;

  return [
    {
      id: 'problem-statement',
      label: 'Problem Statement',
      summary: 'Define the challenge and desired outcomes before implementation.',
      details: 'Detailed framework concepts are coming soon.',
      recommendation: '',
      sources: [],
    },
  ];
};

const normalizeFramework = (doc = {}) => {
  const concepts = normalizeConcepts(doc);
  const title = firstPresent(doc.title, doc.Title, 'Untitled Framework');
  const slug = firstPresent(doc.slug, doc.Slug, toSlug(title));
  const summary = firstPresent(doc.summary, doc.Summary, doc.description, '');
  const category = firstPresent(doc.category, 'Framework');
  const complexity = firstPresent(doc.complexity, 'Foundation');
  const officialSources = normalizeTextList(
    firstPresent(doc.officialSources, doc.frameworkSourceUrls, doc.sourceUrls, [])
  );
  const architectureRecommendation = firstPresent(
    doc.architectureRecommendation,
    doc.recommendation,
    doc.summaryRecommendation,
    ''
  );

  return {
    id: doc.id,
    slug,
    title,
    summary,
    featured: doc.featured === true || doc.Featured === true,
    category,
    complexity,
    tags: normalizeTextList(doc.tags || doc.Tags || doc.keyTopics),
    docLink: firstPresent(doc.docLink, ''),
    officialSources,
    architectureRecommendation,
    concepts,
  };
};

const isFrameworkDocument = (doc = {}) => String(doc.type || '').toLowerCase() === 'framework';

const matchesProvider = (doc, providerKey) => {
  if (!providerKey) return true;
  return inferProviderFromDoc(doc) === providerKey;
};

// Visibility is enforced server-side — the public API only returns published
// documents — so the client filters are scoped to type/provider.
const mapFrameworkDocs = (docs = [], providerKey = '') =>
  docs
    .filter(isFrameworkDocument)
    .filter((doc) => matchesProvider(doc, providerKey))
    .map(normalizeFramework);

const sortFeaturedFirst = (frameworks = []) =>
  [...frameworks].sort((a, b) => Number(b.featured) - Number(a.featured));

export function useFrameworkData(provider) {
  const providerKey = normalizeProvider(provider);

  const {
    data: contentDocs,
    loading: contentLoading,
    error: contentError,
  } = usePublicData(
    () => fetchPublicContentList({ limit: PUBLIC_CORPUS_LIMIT }),
    'frameworks:content'
  );
  const contentFrameworks = useMemo(
    () => sortFeaturedFirst(mapFrameworkDocs(contentDocs || [], providerKey)),
    [contentDocs, providerKey]
  );
  const shouldLoadLegacy = !contentLoading && contentFrameworks.length === 0;
  const {
    data: legacyDocs,
    loading: legacyLoading,
    error: legacyError,
  } = usePublicData(
    () => fetchPublicContentList({ limit: PUBLIC_CORPUS_LIMIT, source: 'blogs' }),
    shouldLoadLegacy ? 'frameworks:legacy' : ''
  );

  const frameworks = useMemo(() => {
    if (contentFrameworks.length > 0) {
      return contentFrameworks;
    }

    return sortFeaturedFirst(mapFrameworkDocs(legacyDocs || [], providerKey));
  }, [contentFrameworks, legacyDocs, providerKey]);

  return {
    frameworks,
    loading: contentLoading || (shouldLoadLegacy && legacyLoading),
    // Was hardcoded null, so a failed fetch was indistinguishable from an
    // empty result on the frameworks path (T-717).
    error: contentError || legacyError || null,
  };
}

export default useFrameworkData;
