import { useMemo } from 'react';
import { usePublicData } from '@/hooks/usePublicData';
import { fetchPublicFeed } from '@/lib/publicApi';

const SITE_RELEVANT_TAGS_BY_PROVIDER = {
  azure: [
    'AI/ML',
    'Security',
    'Architecture',
    'Containers',
    'Database',
    'DevOps',
    'Serverless',
    'Cost',
    'Networking',
    'GA',
    'Update',
    'Preview',
  ],
  aws: [
    'AI/ML',
    'Security',
    'Architecture',
    'Containers',
    'Database',
    'DevOps',
    'Serverless',
    'Cost',
    'Networking',
    'GA',
    'Update',
    'Preview',
  ],
  gcp: [
    'AI/ML',
    'Security',
    'Architecture',
    'Containers',
    'Database',
    'DevOps',
    'Serverless',
    'Cost',
    'Networking',
    'GA',
    'Update',
    'Preview',
  ],
  github: ['AI/ML', 'Security', 'DevOps', 'Copilot', 'Actions', 'Automation', 'GA', 'Update'],
  terraform: [
    'IaC',
    'DevOps',
    'Modules',
    'Cloud',
    'Architecture',
    'Best Practices',
    'Update',
    'GA',
  ],
  finops: [
    'Cost',
    'Optimization',
    'AI/ML',
    'FinOps',
    'Framework',
    'Cloud',
    'Efficiency',
    'Update',
    'GA',
  ],
};

function scoreRssItemForCuration(item, provider) {
  let score = 0;
  const relevantTags = SITE_RELEVANT_TAGS_BY_PROVIDER[provider] || [];

  if (item.tags || item.category) {
    const itemTags = (item.tags || []).concat(item.category || []).map((tag) => String(tag).trim());
    itemTags.forEach((tag) => {
      if (relevantTags.some((candidate) => candidate.toLowerCase() === tag.toLowerCase())) {
        score += 5;
      }
    });
  }

  if (item.category && relevantTags.includes(item.category)) {
    score += 3;
  }

  if (item.pubDate) {
    const pubDate = new Date(item.pubDate);
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    if (pubDate > sevenDaysAgo) {
      score += 2;
    }
  }

  if (item.title) {
    const titleLower = item.title.toLowerCase();
    const keywords = [
      'ai',
      'ml',
      'machine learning',
      'security',
      'architecture',
      'best practice',
      'new release',
      'announcement',
      'innovation',
      'optimization',
      'performance',
      'kubernetes',
      'container',
      'serverless',
      'database',
      'network',
    ];
    keywords.forEach((keyword) => {
      if (titleLower.includes(keyword)) score += 1;
    });
  }

  return Math.max(0, score);
}

// The article's link with the scheme and punctuation stripped, or, with no
// link, its title the same way.
function rssItemSlug(item) {
  const url = [item.sourceUrl, item['CD Url'], item.url, item.link].find(Boolean) || '';
  if (url) {
    return url
      .replace(/^https?:\/\//, '')
      .replace(/[^a-z0-9]/gi, '')
      .slice(0, 60);
  }
  return item.title?.replace(/[^a-z0-9]/gi, '').slice(0, 40) || '';
}

function curateArticlesFromRss(rssItems, provider) {
  if (!rssItems || rssItems.length === 0) {
    return { curatedArticles: [], liveItems: [] };
  }

  const scoredItems = rssItems.map((item) => {
    // Derive a stable ID from the article URL so cache hits survive position changes on refresh.
    // Fall back to title-only slug if no URL is available.
    const stableKey = item.id || `rss-${provider}-${rssItemSlug(item)}`;
    return {
      ...item,
      id: stableKey,
      _curationScore: scoreRssItemForCuration(item, provider),
    };
  });

  const sorted = scoredItems.sort((a, b) => b._curationScore - a._curationScore);
  const maxCurated = 12;

  return {
    curatedArticles: sorted.slice(0, maxCurated).map(({ _curationScore, ...item }) => item),
    liveItems: sorted.slice(maxCurated).map(({ _curationScore, ...item }) => item),
  };
}

export function useNewsData(provider) {
  // One round trip: the feed endpoint returns the rss_cache documents for the
  // provider. (It also carried `ai_insights` until 2026-09-05, when the panel
  // that read them was retired — T-765; nothing ever wrote that container.)
  const {
    data: feed,
    loading,
    error,
  } = usePublicData(() => fetchPublicFeed(provider), provider ? `feed:${provider}` : '');

  const rawRssCache = feed?.rssCache;

  const rssFromFirestore = useMemo(() => {
    if (rawRssCache && rawRssCache.length > 0) {
      const allItems = rawRssCache.flatMap((cache) =>
        (cache.items || []).map((item) => ({
          item: {
            ...item,
            feedName: cache.feedName,
          },
          sortTime: new Date(item.pubDate).getTime(),
        }))
      );

      return allItems
        .sort((a, b) => b.sortTime - a.sortTime)
        .slice(0, 30)
        .map(({ item }) => item);
    }
    return null;
  }, [rawRssCache]);

  const rssItemsFromProvider = useMemo(() => rssFromFirestore || [], [rssFromFirestore]);

  const { curatedArticles, liveItems } = useMemo(
    () => curateArticlesFromRss(rssItemsFromProvider, provider),
    [rssItemsFromProvider, provider]
  );

  const articles = curatedArticles;
  const rssItems = liveItems;

  return { articles, rssItems, loading, error };
}

export default useNewsData;
