import { resolveMediaUrl } from '../../../lib/functionsBase';

// ── Module preview ────────────────────────────────────────────────────────────
// The one-line summary of a module on the Board tab, one small renderer per
// module type. A type with no entry shows its text content.

function plural(count) {
  return count !== 1 ? 's' : '';
}

function PullQuotePreview(module) {
  return (
    <span className="text-xs text-muted-foreground italic line-clamp-2">
      {module.text ? `"${module.text}"` : '—'}
      {module.attribution ? ` — ${module.attribution}` : ''}
    </span>
  );
}

function StatBoardPreview(module) {
  const stats = module.stats || [];
  return (
    <span className="text-xs text-muted-foreground truncate">
      {stats.length ? stats.map((s) => `${s.value} ${s.label}`.trim()).join(' · ') : '—'}
    </span>
  );
}

function ComparisonPreview(module) {
  const columns = module.columns || [];
  const rows = module.rows || [];
  return (
    <span className="text-xs text-muted-foreground truncate">
      {columns.length ? `${columns.join(' vs ')} · ${rows.length} row${plural(rows.length)}` : '—'}
    </span>
  );
}

function TimelinePreview(module) {
  const steps = module.steps || [];
  return (
    <span className="text-xs text-muted-foreground truncate">
      {steps.length
        ? steps
            .map((s) => s.title)
            .filter(Boolean)
            .join(' → ')
        : '—'}
    </span>
  );
}

function CalloutPreview(module) {
  return (
    <span className="text-xs text-muted-foreground truncate">
      {module.title || '—'}
      {module.body ? ` — ${module.body}` : ''}
    </span>
  );
}

function PicturePreview(module) {
  return (
    <div className="flex items-center gap-2">
      {module.imageUrl && (
        <img
          src={resolveMediaUrl(module.imageUrl)}
          alt={module.caption || ''}
          className="h-10 w-14 object-cover rounded border border-border shrink-0"
        />
      )}
      <span className="text-muted-foreground text-xs truncate">
        {module.caption || module.imageUrl || '—'}
      </span>
    </div>
  );
}

function LinksPreview(module) {
  const links = module.links || [];
  return (
    <div className="flex flex-col gap-0.5">
      {links.slice(0, 3).map((l, i) => (
        <span key={i} className="text-xs text-blue-400 truncate">
          {l.title || l.url}
        </span>
      ))}
      {links.length > 3 && (
        <span className="text-xs text-muted-foreground">+{links.length - 3} more</span>
      )}
    </div>
  );
}

function SpacerPreview(module) {
  return (
    <span className="text-xs text-muted-foreground italic">
      {module.style || 'gradient'} spacer
    </span>
  );
}

function VideoPreview(module) {
  return (
    <span className="text-xs text-muted-foreground truncate">
      {module.caption || module.videoUrl || 'YouTube video'}
    </span>
  );
}

function TextPreview(module) {
  const text = String(module.content || '');
  return <span className="text-xs text-muted-foreground line-clamp-2">{text || '—'}</span>;
}

const PREVIEWS = {
  pull_quote: PullQuotePreview,
  stat_board: StatBoardPreview,
  comparison: ComparisonPreview,
  timeline: TimelinePreview,
  callout: CalloutPreview,
  picture: PicturePreview,
  links: LinksPreview,
  spacer: SpacerPreview,
  video: VideoPreview,
};

export function getModulePreview(module) {
  const render = Object.hasOwn(PREVIEWS, module.type) ? PREVIEWS[module.type] : TextPreview;
  return render(module);
}
