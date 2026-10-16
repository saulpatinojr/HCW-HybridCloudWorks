/**
 * The whole "Browse Certifications" carousel of a certification hub: the
 * heading with its catalogue-freshness line, the filter row and card grid
 * (CertificationBrowser), and the pagination under them. The GCP, GitHub
 * and Terraform hubs each rendered this chrome from their own copy of the
 * same seventy lines around the shared browser (PR #841); the page now
 * holds the state through useCertificationCarousel and hands it here as
 * `carousel`.
 *
 * `tone` carries the hub's colour classes (the TONE constant in each page),
 * so the markup here names no colour: `tone.headingIcon` colours the
 * `school` icon and `tone.activeDot` the current pagination dot. Full class
 * strings, so Tailwind sees them.
 *
 * The pagination keeps the variable names `i`, `carouselPage` and
 * `totalPages` on purpose: education-a11y.test.js reads this source for the
 * exact `aria-label` and `aria-current` expressions.
 */
import React from 'react';
import CatalogueFreshness from '@/components/education/CatalogueFreshness';
import CertificationBrowser from '@/components/education/CertificationBrowser';

const PAGE_BUTTON_CLASS =
  'h-9 w-9 bg-card/40 hover:bg-card/60 disabled:opacity-30 border border-card/50 rounded-lg flex items-center justify-center transition-colors';

/** Previous, one dot per page, Next, and "n–m of total". Rendered only when there is more than one page. */
function CarouselPagination({
  carouselPage,
  totalPages,
  visibleCount,
  filteredCount,
  onPageChange,
  tone,
}) {
  return (
    <div className="flex items-center justify-center gap-3 mt-6">
      <button
        onClick={() => onPageChange((p) => Math.max(0, p - 1))}
        disabled={carouselPage === 0}
        aria-label="Previous page"
        className={PAGE_BUTTON_CLASS}
      >
        <span className="material-symbols-outlined text-[18px]" aria-hidden="true">
          chevron_left
        </span>
      </button>
      {Array.from({ length: totalPages }).map((_, i) => (
        <button
          key={i}
          onClick={() => onPageChange(i)}
          aria-label={`Page ${i + 1} of ${totalPages}`}
          aria-current={i === carouselPage ? 'true' : undefined}
          className="group flex h-6 min-w-6 items-center justify-center rounded-full"
        >
          <span
            aria-hidden="true"
            className={`block h-2.5 rounded-full transition-all ${i === carouselPage ? `${tone.activeDot} w-5` : 'w-2.5 bg-card/60 group-hover:bg-card/80'}`}
          />
        </button>
      ))}
      <button
        onClick={() => onPageChange((p) => Math.min(totalPages - 1, p + 1))}
        disabled={carouselPage === totalPages - 1}
        aria-label="Next page"
        className={PAGE_BUTTON_CLASS}
      >
        <span className="material-symbols-outlined text-[18px]" aria-hidden="true">
          chevron_right
        </span>
      </button>
      <span className="text-xs text-muted-foreground ml-2">
        {carouselPage * visibleCount + 1}–
        {Math.min((carouselPage + 1) * visibleCount, filteredCount)} of {filteredCount}
      </span>
    </div>
  );
}

export default function CertificationCarouselSection({
  asOf,
  source,
  filterLevels,
  statusFilters,
  levelMeta,
  getLevelFilterClass,
  tone,
  carousel,
}) {
  const {
    levelFilter,
    statusFilter,
    carouselPage,
    setCarouselPage,
    today,
    filteredCerts,
    visibleCerts,
    totalPages,
    visibleCount,
    handleLevelFilter,
    handleStatusFilter,
  } = carousel;
  return (
    <section className="mb-16">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
        <div>
          <h3 className="text-2xl font-bold text-slate-950 dark:text-white flex items-center gap-2">
            <span
              className={`${tone.headingIcon} text-[24px] material-symbols-outlined`}
              aria-hidden="true"
            >
              school
            </span>
            Browse Certifications
          </h3>
          <CatalogueFreshness asOf={asOf} source={source} className="mt-1" />
        </div>
      </div>

      <CertificationBrowser
        filterLevels={filterLevels}
        statusFilters={statusFilters}
        levelFilter={levelFilter}
        statusFilter={statusFilter}
        onLevelFilter={handleLevelFilter}
        onStatusFilter={handleStatusFilter}
        getLevelFilterClass={getLevelFilterClass}
        levelMeta={levelMeta}
        certs={visibleCerts}
        today={today}
        tone={tone}
      />

      {totalPages > 1 && (
        <CarouselPagination
          carouselPage={carouselPage}
          totalPages={totalPages}
          visibleCount={visibleCount}
          filteredCount={filteredCerts.length}
          onPageChange={setCarouselPage}
          tone={tone}
        />
      )}
    </section>
  );
}
