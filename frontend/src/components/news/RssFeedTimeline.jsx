import React from 'react';
import { ScrollTrigger } from '@/components/animations';
import { safeUrl } from '@/lib/safeUrl';
import { firstField } from '@/components/shared/firstField';

const FEED_ICONS = {
  'Azure Updates': 'cloud',
  'Azure AI': 'smart_toy',
  "AWS What's New": 'cloud_queue',
  'AWS ML Blog': 'psychology',
  'Google Cloud Blog': 'cloud_sync',
  'Google AI Blog': 'neurology',
  'GitHub Blog': 'code',
  'GitHub Changelog': 'update',
  'HashiCorp Blog': 'build',
  'Terraform Registry': 'account_tree',
  'FinOps Foundation': 'savings',
  Default: 'rss_feed',
};

const FEED_COLORS = {
  'Azure Updates': 'text-blue-300',
  'Azure AI': 'text-cyan-300',
  "AWS What's New": 'text-orange-300',
  'AWS ML Blog': 'text-amber-300',
  'Google Cloud Blog': 'text-blue-300',
  'Google AI Blog': 'text-green-300',
  'GitHub Blog': 'text-slate-300',
  'GitHub Changelog': 'text-gray-300',
  'HashiCorp Blog': 'text-purple-300',
  'Terraform Registry': 'text-violet-300',
  'FinOps Foundation': 'text-emerald-300',
  Default: 'text-primary',
};

const CATEGORY_COLORS = {
  'AI/ML': 'border-purple-500/30 text-purple-300 bg-purple-500/10',
  Security: 'border-rose-500/30 text-rose-300 bg-rose-500/10',
  Architecture: 'border-blue-500/30 text-blue-300 bg-blue-500/10',
  Containers: 'border-orange-500/30 text-orange-300 bg-orange-500/10',
  Database: 'border-cyan-500/30 text-cyan-300 bg-cyan-500/10',
  DevOps: 'border-indigo-500/30 text-indigo-300 bg-indigo-500/10',
  Serverless: 'border-amber-500/30 text-amber-300 bg-amber-500/10',
  Cost: 'border-emerald-500/30 text-emerald-300 bg-emerald-500/10',
  Networking: 'border-teal-500/30 text-teal-300 bg-teal-500/10',
  GA: 'border-green-500/30 text-green-300 bg-green-500/10',
  Preview: 'border-amber-500/30 text-amber-300 bg-amber-500/10',
  Update: 'border-slate-500/30 text-slate-300 bg-slate-500/10',
};

function formatRelativeTime(dateString) {
  if (!dateString) return '';

  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now - date;
  const diffMins = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;

  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined,
  });
}

function extractFeedName(item) {
  return firstField(item, ['feedName', 'source', 'Source Feed', 'author'], 'RSS Feed');
}

function extractCategory(item) {
  return item.category || 'Update';
}

function extractTitle(item) {
  return item.title || item.Title || '';
}

function extractSummary(item) {
  return item.summary || item.description || item.Summary || '';
}

function extractLink(item) {
  return firstField(item, ['link', 'url', 'sourceUrl', 'CD Url'], '#');
}

// ⚡ Bolt: Prevent unnecessary re-renders of individual timeline items when parent timeline updates
const FeedTimelineItem = React.memo(({ item, index }) => {
  const feedName = extractFeedName(item);
  const category = extractCategory(item);
  const title = extractTitle(item);
  const summary = extractSummary(item);
  const link = extractLink(item);
  const relativeTime = formatRelativeTime(item.pubDate || item['Published At']);

  const icon = FEED_ICONS[feedName] || FEED_ICONS.Default;
  const iconColor = FEED_COLORS[feedName] || FEED_COLORS.Default;
  const categoryStyle = CATEGORY_COLORS[category] || 'border-primary/30 text-primary bg-primary/10';

  return (
    <ScrollTrigger animation="slideLeft" duration={0.4} delay={index * 0.05}>
      <a
        href={safeUrl(link)}
        target="_blank"
        rel="noopener noreferrer"
        className="group block p-4 rounded-xl border transition-all duration-300
          bg-white/5 dark:bg-slate-800/30 backdrop-blur-sm
          border-slate-200/20 dark:border-slate-700/50
          hover:border-primary/40 hover:bg-slate-800/40 hover:-translate-y-0.5"
      >
        <div className="flex items-start gap-3">
          <div className="flex-shrink-0 mt-0.5">
            <span
              className={`material-symbols-outlined text-lg ${iconColor} group-hover:scale-110 transition-transform`}
            >
              {icon}
            </span>
          </div>

          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between gap-2 mb-2">
              <span className="text-[10px] text-slate-900 dark:text-slate-300 font-medium truncate max-w-[140px]">
                {feedName}
              </span>
              <span className="text-[10px] text-slate-900 dark:text-slate-400 flex-shrink-0">
                {relativeTime}
              </span>
            </div>

            <h3 className="text-sm font-semibold text-slate-900 dark:text-white group-hover:text-primary transition-colors line-clamp-2 mb-2">
              {title}
            </h3>

            {summary && (
              <p className="text-xs text-slate-700 dark:text-slate-300 line-clamp-2 mb-3 leading-relaxed">
                {summary}
              </p>
            )}

            <div className="flex items-center justify-between">
              <span
                className={`px-2 py-0.5 rounded-md border text-[9px] font-medium ${categoryStyle}`}
              >
                {category}
              </span>
              <span className="text-[10px] text-primary opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1">
                Read
                <span className="material-symbols-outlined text-xs">arrow_outward</span>
              </span>
            </div>
          </div>
        </div>
      </a>
    </ScrollTrigger>
  );
});

FeedTimelineItem.displayName = 'FeedTimelineItem';

function TimelineSkeleton() {
  return (
    <div className="space-y-3">
      {[...Array(6)].map((_, i) => (
        <div
          key={i}
          className="p-4 rounded-xl border border-slate-700/50 bg-slate-800/30 animate-pulse"
        >
          <div className="flex items-start gap-3">
            <div className="w-5 h-5 bg-slate-700/40 rounded" />
            <div className="flex-1 space-y-2">
              <div className="h-2 bg-slate-700/40 rounded w-1/3" />
              <div className="h-3 bg-slate-700/30 rounded w-full" />
              <div className="h-2 bg-slate-700/20 rounded w-4/5" />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

export default function RssFeedTimeline({ items = [], loading = false }) {
  const displayItems = items.slice(0, 24);

  if (loading) {
    return <TimelineSkeleton />;
  }

  if (displayItems.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-48 text-slate-700 dark:text-slate-300 rounded-xl border border-slate-200/20 dark:border-slate-700/50 bg-white/5 dark:bg-slate-800/20 backdrop-blur-sm">
        <span className="material-symbols-outlined text-4xl mb-2 text-slate-500">rss_feed</span>
        <p className="text-sm">No RSS feed items available</p>
      </div>
    );
  }

  return (
    <section className="space-y-3 max-h-[900px] overflow-y-auto custom-scrollbar pr-1">
      <div className="space-y-3">
        {displayItems.map((item, index) => (
          <FeedTimelineItem key={item.id || `${item.title}-${index}`} item={item} index={index} />
        ))}
      </div>
    </section>
  );
}
