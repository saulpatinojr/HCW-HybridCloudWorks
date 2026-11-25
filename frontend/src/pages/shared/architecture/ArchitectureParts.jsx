/**
 * Pieces the provider "architecture designs" pages share. The AWS and Azure
 * pages share the gallery card's two detail rows and the sidebar's checkbox
 * groups; the Google Cloud and FinOps pages share the category filter panel,
 * the featured design's three numbers and the mapping of a published design
 * to a gallery card. Each page used to carry its own copy of these.
 */
import React from 'react';

/** The first value that is set and not empty, or null when none is. */
export function firstPresent(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') {
      return value;
    }
  }
  return null;
}

/**
 * A published design, as the Google Cloud and FinOps galleries show it.
 * `defaults` holds the page's own fallbacks: { category, icon, categoryColor }.
 */
export function mapDynamicBlueprint(doc, index, normalizeCategory, defaults) {
  const category = normalizeCategory(firstPresent(doc.category, doc.Category, defaults.category));
  return {
    id: firstPresent(doc.id, doc.slug, doc.Slug, `dynamic-${index}`),
    icon: firstPresent(doc.icon, defaults.icon),
    category,
    categoryColor: defaults.categoryColor,
    title: firstPresent(doc.title, doc.Title, 'Untitled Blueprint'),
    description: firstPresent(doc.summary, doc.Summary, doc.description, ''),
    rpo: firstPresent(doc.rpo, doc.RPO, 'N/A'),
    rto: firstPresent(doc.rto, doc.RTO, 'N/A'),
    level: firstPresent(doc.level, doc.complexity, 'Production'),
    cost: firstPresent(doc.costAnalysis?.estimatedMonthly, doc.cost, 'TBD'),
    costColor: firstPresent(doc.costColor, 'text-green-400'),
    featured: doc.featured === true || doc.Featured === true,
    waf: firstPresent(doc.waf, doc.wellArchitectedScore, 90),
    slug: firstPresent(doc.slug, doc.Slug),
  };
}

/** Whether a published document belongs to this provider's page. */
export function isProviderDoc(doc, provider) {
  return (doc.cloudProvider || doc['Cloud Provider'] || provider).toLowerCase() === provider;
}

/** A titled group of filter checkboxes in the AWS and Azure sidebars. */
export function CheckboxGroup({ title, items }) {
  return (
    <div>
      <h4 className="text-xs font-bold text-slate-600 dark:text-slate-400 uppercase tracking-widest mb-3">
        {title}
      </h4>
      <div className="space-y-2">
        {items.map((item) => (
          <label key={item} className="flex items-center gap-3 cursor-pointer group">
            <input
              className="rounded border-slate-700 bg-[hsl(var(--background))] text-primary focus:ring-primary/50 focus:ring-offset-0"
              type="checkbox"
              aria-label={`Select ${item}`}
            />
            <span className="text-sm text-slate-300 group-hover:text-white transition-colors">
              {item}
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}

/** A gallery card's category badge and monthly cost (AWS and Azure). */
export function BlueprintCategoryCost({ blueprint }) {
  return (
    <div className="flex justify-between items-start mb-2">
      <div
        className={`px-2 py-0.5 rounded bg-${blueprint.categoryColor}-500/10 border border-${blueprint.categoryColor}-500/20 text-${blueprint.categoryColor}-400 text-[10px] font-bold uppercase tracking-wide`}
      >
        {blueprint.category}
      </div>
      <div className="flex items-center gap-1 text-[10px] text-slate-400">
        <span
          className={`material-symbols-outlined text-[12px] text-${blueprint.costColor || 'primary'}`}
        >
          attach_money
        </span>
        <span>{blueprint.cost}</span>
      </div>
    </div>
  );
}

function StatColumn({ label, value }) {
  return (
    <div className="flex flex-col">
      <span className="text-slate-500 text-[10px]">{label}</span>
      <span>{value}</span>
    </div>
  );
}

/** A gallery card's recovery point, recovery time and level row (AWS and Azure). */
export function BlueprintStats({ blueprint }) {
  return (
    <div className="flex gap-4 mb-4 text-xs text-slate-400 font-mono border-y border-border-dark py-2 mt-auto">
      <StatColumn label="RPO" value={blueprint.rpo} />
      <div className="w-px bg-border-dark"></div>
      <StatColumn label="RTO" value={blueprint.rto} />
      <div className="w-px bg-border-dark"></div>
      <StatColumn label="Level" value={blueprint.level} />
    </div>
  );
}

function FeaturedMetric({ label, value }) {
  return (
    <div className="bg-slate-900/50 rounded-lg p-3">
      <span className="text-[10px] text-foreground uppercase font-bold">{label}</span>
      <p className="text-xl font-bold text-white">{value}</p>
    </div>
  );
}

/** The featured design's SLA, recovery point and recovery time (Google Cloud and FinOps). */
export function FeaturedMetrics({ arch }) {
  return (
    <div className="grid grid-cols-3 gap-4 mb-6">
      <FeaturedMetric label="SLA" value={`${arch.waf}%`} />
      <FeaturedMetric label="RPO" value={arch.rpo} />
      <FeaturedMetric label="RTO" value={arch.rto} />
    </div>
  );
}

/**
 * The category filter panel (Google Cloud and FinOps). `panelClass` is the
 * panel's colour and glow; `resetClass` sizes the reset button.
 */
export function CategoryFilterPanel({
  categories,
  selected,
  onToggle,
  onReset,
  panelClass,
  resetClass,
}) {
  return (
    <div className={panelClass}>
      <div className="flex items-center justify-between mb-6">
        <h3 className="text-lg font-bold flex items-center gap-2">
          <span className="text-primary text-[20px] material-symbols-outlined">filter_alt</span>
          Filters
        </h3>
      </div>

      {/* Category Checkboxes */}
      <div className="space-y-3 mb-6">
        {categories.map((category) => (
          <label key={category} className="flex items-center gap-3 cursor-pointer group">
            <input
              type="checkbox"
              checked={selected.includes(category)}
              onChange={() => onToggle(category)}
              className="w-4 h-4 rounded border border-slate-600 bg-slate-700 checked:bg-primary checked:border-primary cursor-pointer"
            />
            <span className="text-sm text-slate-300 group-hover:text-white transition-colors">
              {category}
            </span>
          </label>
        ))}
      </div>

      {/* Reset Button */}
      {selected.length > 0 && (
        <button onClick={onReset} className={resetClass}>
          <span className="text-[18px] material-symbols-outlined">restart_alt</span>
          Reset Filters
        </button>
      )}
    </div>
  );
}
