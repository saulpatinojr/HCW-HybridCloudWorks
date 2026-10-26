/**
 * Dashboard — orientation for whoever opens ContentForge (ADR 0033 §1 Home).
 *
 * One pipeline graphic, not two. The quick-action row and the "ContentForge
 * Pipeline" card showed the same four stages with the same counts; the card
 * stays because it is the one that reads as a flow, and it gains the two
 * stages the sidebar already had — Drafts before the queue, Live Pages after
 * publish — so the picture and the menu agree.
 *
 * Below it: what needs a decision, the count by content type, and an
 * "Explore" strip that introduces each group of the menu in one sentence,
 * for a user who has never seen the product.
 */
import React from 'react';
import { Link, useNavigate } from 'react-router';
import { useAuthReady } from '@/hooks/useAuthReady';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Loader2, FileText, Globe, BookOpen, Code2, AlertCircle, Layers } from 'lucide-react';
import useDashboardCounts from '@/hooks/useDashboardCounts';
import { useAdminRole } from '@/hooks/useAdminRole';
import { useBrainAccess } from '@/hooks/useBrainAccess';
import { visibleNavFor } from '@/config/adminNav';
import DecisionCenter from '@/components/admin/dashboard/DecisionCenter';
import StatTile from '@/components/admin/shared/StatTile';
import EmptyState from '@/components/admin/shared/EmptyState';
import DashboardPipeline, {
  PIPELINE_STAGES,
  Section,
} from '@/components/admin/dashboard/DashboardPipeline';
import DashboardHeader from '@/components/admin/dashboard/DashboardHeader';

export { PIPELINE_STAGES };

/**
 * The content types, each counted across every stage, and Rejected.
 *
 * WHAT A TILE OPENS, AND WHY ITS NOTE SAYS SO. A type's number is its total
 * across every stage (the stats document's `total`). No list in the admin
 * shows that set: the Review Queue and the Frameworks and Coder Corner lists
 * have no all-statuses view, and each opens on its needs-review filter. The
 * Blogs tile used to show the total and land on that filter with nothing to
 * say so. Now the section says the number is every stage, the tile's link
 * names the filter it opens (`status=needs_review`, explicit rather than the
 * page's default), and the note says how many are waiting there, which is
 * the count the destination shows. Rejected opens the rejected list.
 */
const TYPE_TILES = Object.freeze([
  {
    label: 'Blogs',
    noun: 'blog',
    types: ['blog', 'news'],
    to: '/admin/review-queue?contentType=blog&status=needs_review',
    icon: FileText,
    iconClassName: 'text-blue-500',
  },
  {
    label: 'Architecture',
    noun: 'architecture',
    types: ['architecture'],
    to: '/admin/review-queue?contentType=architecture&status=needs_review',
    icon: Globe,
    iconClassName: 'text-purple-500',
  },
  {
    label: 'Frameworks',
    noun: 'framework',
    types: ['framework'],
    to: '/admin/frameworks?status=needs_review',
    icon: BookOpen,
    iconClassName: 'text-sky-500',
  },
  {
    label: 'Coder Corner',
    noun: 'Coder Corner',
    types: ['coder_corner'],
    to: '/admin/coder-corner?status=needs_review',
    icon: Code2,
    iconClassName: 'text-amber-500',
  },
]);

/** A type tile from countsFromSnapshot's byType, which holds every type. */
function typeTile({ types, noun, ...tile }, byType) {
  const sum = (bucket) => types.reduce((n, type) => n + byType[type][bucket], 0);
  const total = sum('total');
  const waiting = sum('needsReview');
  return {
    ...tile,
    value: total,
    note: `${waiting} to review`,
    ariaLabel: `${tile.label}: ${total} across every stage, ${waiting} waiting for review. Opens the ${noun} review list.`,
  };
}

/**
 * The dashboard's count tiles: one per content type and one for rejected items,
 * each opening the list it counts.
 */
function DashboardStats({ counts }) {
  const tiles = [
    ...TYPE_TILES.map((tile) => typeTile(tile, counts.byType)),
    {
      label: 'Rejected',
      icon: AlertCircle,
      iconClassName: 'text-destructive',
      value: counts.rejected,
      to: '/admin/review-queue?status=rejected',
      note: counts.rejected > 0 ? 'Auto-deletes in 24h' : null,
      noteClassName: 'text-red-700 dark:text-red-300',
      ariaLabel: `Rejected: ${counts.rejected}.${counts.rejected > 0 ? ' Auto-deletes in 24h.' : ''} Opens the rejected list.`,
    },
  ];

  return (
    <Section
      title="Content by type"
      icon={Layers}
      iconColor="text-primary"
      hint="Each type's total across every stage. A tile opens that type's review list, and its note says how many are waiting there."
    >
      {/* Sized by the card, like the pipeline: five from 48rem (the 926 px
          card at xl), three from 32rem, two below. Not `@2xl`: index.css
          sets `--container-2xl` to 1400px, so `@2xl` would never apply. */}
      <div className="@container">
        <div className="grid auto-rows-fr grid-cols-2 gap-3 @lg:grid-cols-3 @3xl:grid-cols-5">
          {tiles.map(({ label, ...tile }) => (
            <StatTile key={label} label={label} {...tile} />
          ))}
        </div>
      </div>
    </Section>
  );
}

/**
 * One card per menu group after Home, each carrying the registry's sentence
 * and its items — the whole product explained on the first screen. Cut to
 * the signed-in role as the sidebar is (AP-F4), so the strip never
 * introduces a page the menu does not offer.
 */
function DashboardExplore({ role }) {
  const { enabled: brainEnabled } = useBrainAccess();
  const groups = visibleNavFor(role, { brain: brainEnabled }).filter(
    (group) => group.id !== 'home'
  );
  return (
    <section aria-labelledby="explore-heading" className="space-y-3">
      <div>
        <h2 id="explore-heading" className="text-base font-semibold">
          Explore ContentForge
        </h2>
        <p className="mt-1 mb-0 text-xs text-muted-foreground">
          What each part of the menu is for. Hover any menu item for the same sentence.
        </p>
      </div>
      {/* `grid-cols-1`, not the implicit column (AP-F1). An implicit track is
          sized to its content, and each item's one-line, truncated description
          made that the full sentence: on a Pixel 5 the cards were 675 px wide
          in a 393 px column and the dashboard scrolled sideways. An explicit
          column is `minmax(0, 1fr)`, so the description truncates as meant.
          e2e/admin-authenticated.spec.js holds the line on a phone. */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {groups.map((group) => (
          <Card key={group.id} className="h-full">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm uppercase tracking-wider text-muted-foreground">
                {group.label}
              </CardTitle>
              <p className="mb-0 text-xs text-muted-foreground">{group.description}</p>
            </CardHeader>
            <CardContent>
              <ul className="space-y-1">
                {group.items.map((item) => {
                  const Icon = item.icon;
                  return (
                    <li key={item.to}>
                      <Link
                        to={item.to}
                        className="flex items-start gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted/60 transition-colors"
                        title={item.description}
                      >
                        <Icon
                          className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground"
                          aria-hidden="true"
                        />
                        <span className="min-w-0">
                          <span className="font-medium">{item.label}</span>
                          <span className="block truncate text-xs text-muted-foreground">
                            {item.description}
                          </span>
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </CardContent>
          </Card>
        ))}
      </div>
    </section>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────

/** The admin home: pipeline, decisions, counts by type, and the Explore strip. */
export default function DashboardPage() {
  const { authReady } = useAuthReady();
  const role = useAdminRole();
  const navigate = useNavigate();
  const { snapshot, counts, loading, error, refresh, recalculate } = useDashboardCounts({
    enabled: authReady,
    refetchOnNavigate: false,
  });
  const [recalculating, setRecalculating] = React.useState(false);
  const [recalcError, setRecalcError] = React.useState('');

  const handleRecalculate = async () => {
    setRecalculating(true);
    setRecalcError('');
    try {
      await recalculate();
    } catch (err) {
      setRecalcError(err?.message || 'Failed to recalculate.');
    } finally {
      setRecalculating(false);
    }
  };

  const today = new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  }).format(new Date());

  if (loading && !snapshot) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <div className="flex flex-col items-center gap-3 text-muted-foreground">
          <Loader2 className="h-8 w-8 animate-spin" aria-hidden="true" />
          <p className="text-sm">Loading your dashboard…</p>
        </div>
      </div>
    );
  }

  // A first read that failed is an outage, not an empty inbox (AP-F5, #929).
  // This used to fall through to the celebratory heading over zero counts,
  // with a small red line beneath, so a backend outage read as "no work":
  // the unknown-versus-zero confusion the codebase has fixed elsewhere.
  if (error && !snapshot) {
    return (
      <div className="space-y-6">
        <p className="mb-0 text-xs font-medium uppercase tracking-wider text-muted-foreground">
          {today}
        </p>
        <EmptyState
          variant="error"
          title="The dashboard could not be loaded"
          description={error}
          onRetry={refresh}
        />
      </div>
    );
  }

  // One gap token between sections (24 px). Each section owns its inside
  // spacing; nothing here carries a margin of its own, and the paragraphs
  // that close a block set `mb-0` over the `p` default in index.css.
  return (
    <div className="space-y-6">
      <DashboardHeader
        today={today}
        counts={counts}
        loadError={error || recalcError}
        stale={Boolean(error && snapshot)}
        onRetry={error ? refresh : null}
        recalculating={recalculating}
        onRecalculate={handleRecalculate}
        onNewContent={() => navigate('/admin/new-content')}
      />
      <DashboardPipeline counts={counts} role={role} />
      <DashboardStats counts={counts} />
      <DecisionCenter enabled={authReady} />
      <DashboardExplore role={role} />
    </div>
  );
}
