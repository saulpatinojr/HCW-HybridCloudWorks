import React, { useEffect, useMemo } from 'react';
import { ScrollTrigger } from '@/components/animations';
import { useGenerateCuratedImages } from '@/hooks/useGenerateCuratedImages';
import { normalizePublicImageUrl } from '@/lib/blogUtils';
import ResponsiveCoverImage from '@/components/shared/ResponsiveCoverImage';
import { resolveMediaUrl } from '../../lib/functionsBase';
import { safeUrl } from '@/lib/safeUrl';
import { firstField } from '@/components/shared/firstField';

// Pulls the WebP variants that match whichever imageUrl resolveImageUrl
// picked. Returns null when the source doesn't carry variants.
function resolveImageVariants(article, imageUrl) {
  if (!imageUrl) return null;
  if (article.altCoverImage && imageUrl === normalizePublicImageUrl(article.altCoverImage)) {
    return article.altCoverImageVariants || null;
  }
  return null;
}

function resolveImageUrl(article) {
  if (article.altCoverImage && typeof article.altCoverImage === 'string') {
    return normalizePublicImageUrl(article.altCoverImage);
  }

  const coverImage = article['Cover Image'] || article['Content Image'];
  if (Array.isArray(coverImage) && coverImage.length > 0) {
    const [img] = coverImage;
    return normalizePublicImageUrl(img.downloadURL || img.url || img.src || '');
  }
  if (coverImage && typeof coverImage === 'object' && coverImage.downloadURL) {
    return normalizePublicImageUrl(coverImage.downloadURL);
  }

  if (
    article.contentImageUrl &&
    (article.contentImageUrl.startsWith('http') || article.contentImageUrl.startsWith('/'))
  ) {
    return normalizePublicImageUrl(article.contentImageUrl);
  }
  return '';
}

function formatDate(date) {
  if (!date) return '';
  let d;
  if (date instanceof Date) {
    d = date;
  } else if (date.toDate) {
    d = date.toDate();
  } else {
    d = new Date(date);
  }
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function extractSourceFeed(article) {
  return firstField(
    article,
    ['feedName', 'source', 'Source Feed', 'Author', 'author', 'Author Name'],
    'Cloud Provider'
  );
}

function extractTitle(article) {
  return article.Title || article.title || '';
}

function extractSummary(article) {
  return firstField(article, ['aiSummary', 'Summary', 'summary', 'description'], '');
}

function extractTags(article) {
  return article.Tags || article.tags || article.aiTags || [];
}

const CATEGORY_COLORS = {
  'AI/ML':
    'bg-purple-500/20 border-purple-500/30 text-purple-300 dark:bg-purple-500/20 dark:text-purple-300',
  Security:
    'bg-rose-500/20 border-rose-500/30 text-rose-300 dark:bg-rose-500/20 dark:text-rose-300',
  Architecture:
    'bg-blue-500/20 border-blue-500/30 text-blue-300 dark:bg-blue-500/20 dark:text-blue-300',
  Containers:
    'bg-orange-500/20 border-orange-500/30 text-orange-300 dark:bg-orange-500/20 dark:text-orange-300',
  Serverless:
    'bg-amber-500/20 border-amber-500/30 text-amber-300 dark:bg-amber-500/20 dark:text-amber-300',
  Database:
    'bg-cyan-500/20 border-cyan-500/30 text-cyan-300 dark:bg-cyan-500/20 dark:text-cyan-300',
  Networking:
    'bg-teal-500/20 border-teal-500/30 text-teal-300 dark:bg-teal-500/20 dark:text-teal-300',
  Cost: 'bg-emerald-500/20 border-emerald-500/30 text-emerald-300 dark:bg-emerald-500/20 dark:text-emerald-300',
  DevOps:
    'bg-indigo-500/20 border-indigo-500/30 text-indigo-300 dark:bg-indigo-500/20 dark:text-indigo-300',
  GA: 'bg-green-500/20 border-green-500/30 text-green-300 dark:bg-green-500/20 dark:text-green-300',
  Preview:
    'bg-amber-500/20 border-amber-500/30 text-amber-300 dark:bg-amber-500/20 dark:text-amber-300',
  Update:
    'bg-slate-500/20 border-slate-500/30 text-slate-300 dark:bg-slate-500/20 dark:text-slate-300',
};

function getCategoryColor(category) {
  return CATEGORY_COLORS[category] || 'bg-primary/20 border-primary/30 text-primary';
}

function ArticleImageSection({ imageUrl, imageVariants, title, category }) {
  return (
    <div className="relative overflow-hidden bg-linear-to-br from-slate-700/50 to-slate-900/50 flex items-center justify-center shrink-0 h-48">
      {imageUrl ? (
        <ResponsiveCoverImage
          src={resolveMediaUrl(imageUrl)}
          variants={imageVariants}
          alt={title}
          // Card images max out around half-width on desktop, full-width on
          // mobile. Picking the 640w variant covers most cases.
          sizes="(max-width: 768px) 100vw, 50vw"
          className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
          loading="lazy"
        />
      ) : (
        <span className="material-symbols-outlined text-slate-500/50 group-hover:text-primary/30 transition-colors text-6xl">
          article
        </span>
      )}
      <div className="absolute inset-0 bg-linear-to-t from-black/60 via-transparent to-transparent" />

      <span
        className={`absolute top-3 right-3 px-2.5 py-1 border rounded text-[9px] font-bold uppercase tracking-wider backdrop-blur-sm ${getCategoryColor(category)}`}
      >
        {category}
      </span>
    </div>
  );
}

function ArticleContentSection({ title, summary, tags, sourceFeed, date }) {
  return (
    <div className="flex-1 flex flex-col p-3.5">
      <h3 className="font-bold text-slate-900 dark:text-white group-hover:text-primary transition-colors line-clamp-2 mb-1 text-sm leading-tight">
        {title}
      </h3>

      <p className="text-slate-700 dark:text-slate-300 line-clamp-2 mb-2 text-xs shrink-0">
        {summary}
      </p>

      {tags.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-auto py-1">
          {tags.slice(0, 2).map((tag, i) => (
            <span
              key={i}
              className="px-1.5 py-0.5 bg-slate-700/30 dark:bg-slate-700/50 text-slate-700 dark:text-slate-300 text-[8px] rounded-full whitespace-nowrap"
            >
              {tag}
            </span>
          ))}
        </div>
      )}

      <div className="flex items-center justify-between pt-2 mt-auto border-t border-slate-200/10 dark:border-slate-700/50 text-[10px] text-slate-700 dark:text-slate-300">
        <span className="truncate max-w-25">{sourceFeed}</span>
        <span>{date ? date.split(',')[0] : ''}</span>
      </div>
    </div>
  );
}

// ⚡ Bolt: Prevent unnecessary re-renders of individual curated article cards
const CuratedArticleCard = React.memo(({ article, index, generatedImageUrl }) => {
  const imageUrl = generatedImageUrl || resolveImageUrl(article);
  const imageVariants = resolveImageVariants(article, imageUrl);
  const date = formatDate(article['Published At'] || article.pubDate);
  const category = article.category || 'Update';
  const title = extractTitle(article);
  const summary = extractSummary(article);
  const sourceFeed = extractSourceFeed(article);
  const tags = extractTags(article);
  const externalUrl = firstField(article, ['sourceUrl', 'CD Url', 'url', 'link'], '#');

  return (
    <ScrollTrigger animation="slideUp" duration={0.4} delay={index * 0.03}>
      <a
        href={safeUrl(externalUrl)}
        target="_blank"
        rel="noopener noreferrer"
        className="group flex h-full flex-col rounded-2xl overflow-hidden transition-all duration-300 border
          bg-white/5 dark:bg-slate-800/40 backdrop-blur-md
          border-slate-200/20 dark:border-slate-700/50
          hover:border-primary/50 hover:shadow-[0_0_25px_rgba(var(--primary-rgb,59,130,246),0.15)]
          hover:-translate-y-1"
      >
        <ArticleImageSection
          imageUrl={imageUrl}
          imageVariants={imageVariants}
          title={title}
          category={category}
        />
        <ArticleContentSection
          title={title}
          summary={summary}
          tags={tags}
          sourceFeed={sourceFeed}
          date={date}
        />
      </a>
    </ScrollTrigger>
  );
});

CuratedArticleCard.displayName = 'CuratedArticleCard';

function CuratedArticleSkeleton() {
  return (
    <div className="rounded-2xl overflow-hidden border bg-white/5 dark:bg-slate-800/40 backdrop-blur-md border-slate-700/50 animate-pulse h-full flex flex-col">
      <div className="h-48 bg-slate-700/30" />
      <div className="flex-1 p-3.5 space-y-3">
        <div className="h-3 bg-slate-700/30 rounded w-3/4" />
        <div className="h-2.5 bg-slate-700/20 rounded w-full" />
        <div className="h-2.5 bg-slate-700/20 rounded w-2/3" />
      </div>
    </div>
  );
}

export default function CuratedArticlesGrid({
  articles = [],
  loading = false,
  pagePath = '/aws/news',
  provider = 'AWS',
}) {
  const maxArticles = 12;
  const displayArticles = useMemo(() => articles.slice(0, maxArticles), [articles]);

  const {
    imageMap,
    loading: imageLoading,
    generateImagesForArticles,
  } = useGenerateCuratedImages(pagePath, provider);

  useEffect(() => {
    if (displayArticles.length > 0) {
      generateImagesForArticles(displayArticles);
    }
  }, [displayArticles, generateImagesForArticles]);

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 auto-rows-[340px]">
          {[...Array(6)].map((_, i) => (
            <CuratedArticleSkeleton key={i} />
          ))}
        </div>
      </div>
    );
  }

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined text-black dark:text-amber-300 text-lg">
            star
          </span>
          <h2 className="font-bold text-black dark:text-white text-sm uppercase tracking-wide">
            Curated Articles
          </h2>
        </div>
        <span className="text-[11px] text-slate-900 dark:text-slate-300">
          {displayArticles.length} / 12
        </span>
      </div>

      <p className="text-xs text-slate-700 dark:text-slate-300 mb-4">
        Hand-picked articles related to{' '}
        {displayArticles.length > 0 ? 'your interests' : 'this platform'}
        {imageLoading && (
          <span className="ml-2 text-slate-500 dark:text-slate-400">Generating images...</span>
        )}
      </p>

      {displayArticles.length > 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 auto-rows-[340px]">
          {displayArticles.map((article, index) => (
            <CuratedArticleCard
              key={article.id || index}
              article={article}
              index={index}
              generatedImageUrl={imageMap[article.id]}
            />
          ))}
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center h-40 text-slate-700 dark:text-slate-300 rounded-2xl border border-slate-200/20 dark:border-slate-700/50 bg-white/5 dark:bg-slate-800/20 backdrop-blur-sm">
          <span className="material-symbols-outlined text-4xl mb-2 text-slate-600 dark:text-slate-400">
            article
          </span>
          <p className="text-sm">No curated articles available yet</p>
        </div>
      )}
    </section>
  );
}
