import React from 'react';
import { Helmet } from 'react-helmet-async';
import { Link } from 'react-router';
import { Calendar, User, Clock, ArrowLeft, Tag } from 'lucide-react';
import { Skeleton } from '@/components/performance/Skeleton';
import ShareVia from '@/components/shared/ShareVia';
import ResponsiveCoverImage from '@/components/shared/ResponsiveCoverImage';
import { resolveMediaUrl } from '../../lib/functionsBase';

// The smaller pieces of BlogDetailTemplate, split out so the page itself
// reads top to bottom.

export function BlogDetailSkeleton() {
  return (
    <div className="pt-28 pb-20 px-4 md:px-8 max-w-[1200px] mx-auto w-full">
      <Skeleton variant="button" className="mb-8 w-32" />
      <Skeleton variant="rect" className="mb-8 h-64 rounded-2xl" />
      <Skeleton variant="heading" className="mb-4 w-3/4" />
      <Skeleton variant="heading" className="mb-8 w-1/2" />
      <div className="flex gap-6 mb-8">
        <Skeleton variant="text" className="w-32" />
        <Skeleton variant="text" className="w-24" />
        <Skeleton variant="text" className="w-20" />
      </div>
      <div className="space-y-3">
        <Skeleton variant="text" />
        <Skeleton variant="text" />
        <Skeleton variant="text" className="w-5/6" />
        <Skeleton variant="text" />
        <Skeleton variant="text" className="w-4/5" />
        <Skeleton variant="text" />
        <Skeleton variant="text" className="w-3/4" />
      </div>
    </div>
  );
}

export function ArticleNotFound({ backPath, backLabel }) {
  return (
    <div className="max-w-4xl mx-auto px-4 py-20 text-center">
      <span className="text-6xl material-symbols-outlined text-slate-600 block mb-4">article</span>
      <h1 className="text-3xl font-bold mb-4 text-slate-900 dark:text-white">Article Not Found</h1>
      <p className="text-slate-700 dark:text-slate-400 mb-6">
        This article doesn&apos;t exist or hasn&apos;t been published yet.
      </p>
      <Link
        to={backPath}
        className="inline-flex items-center gap-2 px-5 py-2.5 bg-primary hover:bg-primary/80 text-primary-foreground font-bold rounded-lg transition-colors"
      >
        <ArrowLeft className="h-4 w-4" />
        {backLabel}
      </Link>
    </div>
  );
}

export function ArticleHelmet({ post, previewMode, canonicalUrl }) {
  if (previewMode) {
    return (
      <Helmet>
        <title>{`Preview: ${post.title} | HCW`}</title>
        {/* A preview URL is semi-secret and temporary — never indexed. */}
        <meta name="robots" content="noindex, nofollow" />
      </Helmet>
    );
  }
  return (
    <Helmet>
      <title>{`${post.title} | HCW`}</title>
      <meta name="description" content={post.summary} />
      <link rel="canonical" href={canonicalUrl} />
      {/* Open Graph */}
      <meta property="og:type" content="article" />
      <meta property="og:title" content={`${post.title} | HCW`} />
      <meta property="og:description" content={post.summary} />
      <meta property="og:url" content={canonicalUrl} />
      {post.imageUrl && <meta property="og:image" content={resolveMediaUrl(post.imageUrl)} />}
      {/* Twitter Card */}
      <meta name="twitter:card" content={post.imageUrl ? 'summary_large_image' : 'summary'} />
      <meta name="twitter:title" content={`${post.title} | HCW`} />
      <meta name="twitter:description" content={post.summary} />
      {post.imageUrl && <meta name="twitter:image" content={resolveMediaUrl(post.imageUrl)} />}
    </Helmet>
  );
}

function ForgeGradeLine({ forgeGrade }) {
  if (typeof forgeGrade?.overall !== 'number') return null;
  return (
    <>
      {' · '}Forge grade:{' '}
      <span className="font-medium">
        {forgeGrade.overall}
        {typeof forgeGrade.threshold === 'number' ? ` / threshold ${forgeGrade.threshold}` : ''}
      </span>
    </>
  );
}

// Preview banner: what this is and where it stands
export function PreviewBanner({ article }) {
  const findings = article.forgeGrade?.seo?.findings;
  return (
    <div className="mb-8 rounded-xl border border-amber-400/50 bg-amber-500/10 px-5 py-4">
      <p className="eyebrow-label text-amber-700 dark:text-amber-300">Preview — not live</p>
      <p className="mt-1 text-sm text-slate-700 dark:text-slate-300">
        Status: <span className="font-medium">{article.contentStatus || 'unknown'}</span>
        <ForgeGradeLine forgeGrade={article.forgeGrade} />
      </p>
      {/* SEO advisories: informational only — they never gate approval */}
      {Array.isArray(findings) && findings.length > 0 && (
        <ul className="mt-2 list-disc pl-5 text-sm text-slate-700 dark:text-slate-300">
          {findings.map((finding) => (
            <li key={finding.key}>{finding.message}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function HeroImage({ post }) {
  if (!post.imageUrl) return null;
  return (
    <div className="relative w-full h-72 sm:h-96 rounded-2xl overflow-hidden mb-8 bg-card/40">
      <ResponsiveCoverImage
        src={resolveMediaUrl(post.imageUrl)}
        variants={post.imageVariants}
        alt={post.title}
        width="1200"
        height="630"
        fetchPriority="high"
        loading="eager"
        decoding="async"
        sizes="(max-width: 768px) 100vw, 1200px"
        className="absolute inset-0 w-full h-full object-cover"
        onError={(e) => {
          e.currentTarget.style.display = 'none';
        }}
      />
      <div className="absolute inset-0 bg-gradient-to-t from-background/80 via-background/20 to-transparent" />
    </div>
  );
}

function MetaItem({ Icon, text }) {
  if (!text) return null;
  return (
    <div className="flex items-center gap-1.5">
      <Icon className="h-4 w-4 text-primary" />
      <span>{text}</span>
    </div>
  );
}

export function ArticleHeader({ post }) {
  return (
    <header className="mb-12">
      <div className="mb-6 flex justify-end">
        <ShareVia title={post.title} summary={post.summary} />
      </div>

      {/* Title */}
      <h1 className="text-5xl md:text-6xl font-bold text-slate-900 dark:text-white mb-8 leading-tight">
        {post.title}
      </h1>

      {/* Metadata Row: Author (left) + Date/ReadTime (right) */}
      <div className="blog-detail-meta flex items-baseline justify-between gap-6 mb-8 text-sm">
        <div className="blog-detail-author flex items-center gap-2 !text-slate-900 dark:text-slate-400">
          <User className="h-4 w-4 text-primary" />
          <span className="!text-slate-900 dark:text-white font-medium">
            {post.author || 'HCW Team'}
          </span>
        </div>
        <div className="blog-detail-date flex items-center gap-4 !text-slate-900 dark:text-slate-400 ml-auto">
          <MetaItem Icon={Calendar} text={post.date} />
          <MetaItem Icon={Clock} text={post.readTime} />
        </div>
      </div>

      {/* Spacer Bar */}
      <div className="w-16 h-1 bg-gradient-to-r from-primary via-primary/60 to-transparent rounded-full mb-8" />
    </header>
  );
}

export function BodyMissing() {
  return (
    <div className="mb-12 py-10 text-center border border-dashed border-slate-700 rounded-xl">
      <span className="text-4xl material-symbols-outlined text-slate-600 block mb-3">draft</span>
      <p className="text-slate-700 dark:text-slate-400">
        The full article is not available yet. Check back soon.
      </p>
    </div>
  );
}

export function TagsRow({ tags }) {
  if (tags.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 mb-8">
      <Tag className="h-4 w-4 text-slate-500" />
      {tags.map((tag, i) => (
        <span
          key={i}
          className="px-3 py-1 bg-card/50 border border-card/80 text-slate-800 dark:text-slate-300 text-xs rounded-full"
        >
          {tag}
        </span>
      ))}
    </div>
  );
}

export function BackLink({ backPath, backLabel, className }) {
  return (
    <Link to={backPath} className={className}>
      <ArrowLeft className="h-4 w-4 group-hover:-translate-x-1 transition-transform" />
      {backLabel}
    </Link>
  );
}
