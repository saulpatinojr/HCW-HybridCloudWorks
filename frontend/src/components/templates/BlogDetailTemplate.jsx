import React, { useMemo } from 'react';
import { useParams } from 'react-router';
import CoderCornerSnippet from '@/components/shared/CoderCornerSnippet';
import { usePublicData } from '@/hooks/usePublicData';
import { fetchPublicContentItem } from '@/lib/publicApi';
import { Separator } from '@/components/ui/separator';
import PlacedNewsletterSignup from '@/components/shared/PlacedNewsletterSignup';
import BlogArticleBody from './BlogArticleBody';
import {
  ArticleHeader,
  ArticleHelmet,
  ArticleNotFound,
  BackLink,
  BlogDetailSkeleton,
  BodyMissing,
  HeroImage,
  PreviewBanner,
  TagsRow,
} from './BlogDetailParts';
import { backLinkFor, normalizeArticle } from './blogPostModel';

/**
 * Blog/news article detail page.
 * Resolution (id → slug → Slug, content then legacy blogs, public-only) is
 * folded into GET public/content/{slugOrId} server-side — one fetch replaces
 * the six Firestore lookups and candidate-ranking this component carried.
 * - Displays: hero image, title, meta, AI summary, full content, source link.
 */
export default function BlogDetailTemplate({
  provider = 'aws',
  section = 'blog',
  // Staging preview (T-606): when previewItem is set the template renders it
  // instead of fetching by slug, and previewMode swaps the public chrome
  // (canonical/OG, back link) for a noindex meta and a status banner.
  previewItem = null,
  previewMode = false,
}) {
  const { backPath, backLabel } = backLinkFor(provider, section);

  const { slug } = useParams();

  // A falsy key disables usePublicData's fetch (its documented contract), so
  // preview renders never hit the public content route.
  const { data: fetchedArticle, loading: fetchLoading } = usePublicData(
    () => fetchPublicContentItem(slug),
    slug && !previewItem ? `article:${slug}` : ''
  );
  const article = previewItem || fetchedArticle;
  const loading = previewItem ? false : fetchLoading;

  const post = useMemo(() => normalizeArticle(article), [article]);

  if (loading) return <BlogDetailSkeleton />;

  if (!article || !post) {
    return <ArticleNotFound backPath={backPath} backLabel={backLabel} />;
  }

  return (
    <div className="pt-28 pb-20 px-4 md:px-8 max-w-[1200px] mx-auto w-full">
      <ArticleHelmet
        post={post}
        previewMode={previewMode}
        canonicalUrl={`https://hybridcloudworks.com/${provider}/${section}/${slug}`}
      />

      {/* Back link (not in preview — the preview URL stands alone) */}
      {!previewMode && (
        <BackLink
          backPath={backPath}
          backLabel={backLabel}
          className="inline-flex items-center gap-2 text-sm text-foreground hover:text-primary transition-colors mb-8 group"
        />
      )}

      {/* Preview banner: what this is and where it stands */}
      {previewMode && <PreviewBanner article={article} />}

      <article className="blog-detail-article">
        {/* Hero Image */}
        <HeroImage post={post} />

        {/* Header */}
        <ArticleHeader post={post} />

        {/* Body content with inline modules */}
        {post.body ? (
          <div className="mb-12">
            <BlogArticleBody body={post.body} />
          </div>
        ) : (
          <BodyMissing />
        )}

        <CoderCornerSnippet
          codeSnippet={post.codeSnippet}
          language={post.language}
          repoUrl={post.repoUrl}
          body={post.body}
        />

        {/* Tags row */}
        <TagsRow tags={post.tags} />

        <Separator className="my-8 border-slate-700" />

        {/* Footer: back link only */}
        <div className="flex items-center gap-4">
          <BackLink
            backPath={backPath}
            backLabel={backLabel}
            className="inline-flex items-center gap-2 text-sm text-slate-700 dark:text-slate-400 hover:text-primary transition-colors group"
          />
        </div>
        {/* Shown only when the owner's signup placement includes blog posts (#557). */}
        <PlacedNewsletterSignup where="blogEnd" source="blog-post" className="mt-10" />
      </article>
    </div>
  );
}
