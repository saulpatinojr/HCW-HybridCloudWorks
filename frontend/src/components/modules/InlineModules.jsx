import React, { useMemo, useState } from 'react';
import {
  Lightbulb,
  CheckCircle2,
  Link2,
  Image,
  BarChart3,
  FileCode2,
  Video,
  Play,
  X,
  Quote,
  Table2,
  ListOrdered,
  Megaphone,
  Workflow,
} from 'lucide-react';
import { resolveMediaUrl } from '../../lib/functionsBase';
import { getModuleLayoutClass, getPictureFrameClass, getYouTubeEmbedUrl } from './moduleLayout';
import {
  CalloutModule,
  ComparisonModule,
  DesignModule,
  PullQuoteModule,
  StatBoardModule,
  TimelineModule,
} from './RichModules';

export {
  CalloutModule,
  ComparisonModule,
  DesignModule,
  PullQuoteModule,
  StatBoardModule,
  TimelineModule,
};

export const SPACER_STYLE_OPTIONS = [
  { key: 'gradient', label: 'Gradient Bar' },
  { key: 'solid', label: 'Solid Bar' },
  { key: 'dots', label: 'Dotted Rule' },
  { key: 'double', label: 'Double Line' },
  { key: 'glow', label: 'Glow Pulse' },
  { key: 'accent', label: 'Accent Split' },
];

/**
 * Inline Module Components
 * Used in both the blog detail display and editor preview
 * Each module can be left/right aligned and has custom styling
 */

// Module type configuration
export const MODULE_TYPES = {
  fact: {
    label: 'Fact',
    icon: Lightbulb,
    color: 'bg-blue-500/10 border-blue-500/30',
    accentColor: 'text-blue-300',
    badgeColor: 'bg-blue-500/20 text-blue-200',
  },
  recommendation: {
    label: 'Recommendation',
    icon: CheckCircle2,
    color: 'bg-emerald-500/10 border-emerald-500/30',
    accentColor: 'text-emerald-400',
    badgeColor: 'bg-emerald-500/20 text-emerald-300',
  },
  links: {
    label: 'Links',
    icon: Link2,
    color: 'bg-blue-500/10 border-blue-500/30',
    accentColor: 'text-blue-400',
    badgeColor: 'bg-blue-500/20 text-blue-300',
  },
  picture: {
    label: 'Image',
    icon: Image,
    color: 'bg-purple-500/10 border-purple-500/30',
    accentColor: 'text-purple-400',
    badgeColor: 'bg-purple-500/20 text-purple-300',
  },
  spacer: {
    label: 'Spacer',
    icon: BarChart3,
    color: 'bg-slate-500/5 border-slate-500/20',
    accentColor: 'text-slate-400',
    badgeColor: 'bg-slate-500/10 text-slate-300',
  },
  text: {
    label: 'Text Frame',
    icon: BarChart3,
    color: 'bg-sky-500/10 border-sky-500/30',
    accentColor: 'text-sky-300',
    badgeColor: 'bg-sky-500/20 text-sky-200',
  },
  code: {
    label: 'Code',
    icon: FileCode2,
    color: 'bg-indigo-500/10 border-indigo-500/30',
    accentColor: 'text-indigo-300',
    badgeColor: 'bg-indigo-500/20 text-indigo-200',
  },
  video: {
    label: 'Video',
    icon: Video,
    color: 'bg-rose-500/10 border-rose-500/30',
    accentColor: 'text-rose-300',
    badgeColor: 'bg-rose-500/20 text-rose-200',
  },
  design: {
    label: 'Diagram',
    icon: Workflow,
    color: 'bg-teal-500/10 border-teal-500/30',
    accentColor: 'text-teal-300',
    badgeColor: 'bg-teal-500/20 text-teal-200',
  },
  pull_quote: {
    label: 'Pull Quote',
    icon: Quote,
    color: 'bg-violet-500/10 border-violet-500/30',
    accentColor: 'text-violet-300',
    badgeColor: 'bg-violet-500/20 text-violet-200',
  },
  stat_board: {
    label: 'Stat Board',
    icon: BarChart3,
    color: 'bg-cyan-500/10 border-cyan-500/30',
    accentColor: 'text-cyan-300',
    badgeColor: 'bg-cyan-500/20 text-cyan-200',
  },
  comparison: {
    label: 'Comparison',
    icon: Table2,
    color: 'bg-indigo-500/10 border-indigo-500/30',
    accentColor: 'text-indigo-300',
    badgeColor: 'bg-indigo-500/20 text-indigo-200',
  },
  timeline: {
    label: 'Timeline',
    icon: ListOrdered,
    color: 'bg-orange-500/10 border-orange-500/30',
    accentColor: 'text-orange-300',
    badgeColor: 'bg-orange-500/20 text-orange-200',
  },
  callout: {
    label: 'Callout',
    icon: Megaphone,
    color: 'bg-yellow-500/10 border-yellow-500/30',
    accentColor: 'text-yellow-300',
    badgeColor: 'bg-yellow-500/20 text-yellow-200',
  },
};

/**
 * The edit and delete buttons of the original modules (fact, tip, links,
 * picture, frame, code, video). Shown only in the editor, when a handler is
 * passed. The rich modules use their own ModuleActions (RichModules.jsx).
 */
function LegacyModuleActions({ onEdit, onDelete, className = 'flex gap-1' }) {
  if (!onEdit && !onDelete) return null;
  return (
    <div className={className}>
      {onEdit && (
        <button onClick={onEdit} className="text-xs text-slate-400 hover:text-primary p-1">
          ✎
        </button>
      )}
      {onDelete && (
        <button onClick={onDelete} className="text-xs text-slate-400 hover:text-red-400 p-1">
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  );
}

/** The icon and capitalised name at the top of an original module. */
function ModuleTitle({ Icon, typeKey, children }) {
  const { accentColor } = MODULE_TYPES[typeKey];
  return (
    <div className="flex items-center gap-2">
      <Icon className={`h-4 w-4 ${accentColor}`} />
      <span className={`font-bold text-sm ${accentColor}`}>{children}</span>
    </div>
  );
}

/** The shared body of the fact and recommendation modules. */
function HighlightModule({ typeKey, Icon, title, borderClass, content, align, onEdit, onDelete }) {
  return (
    <div className="my-4 w-full transition-all duration-200">
      <div className={getModuleLayoutClass(align)}>
        <div
          className={`border rounded-lg p-4 ${MODULE_TYPES[typeKey].color} border-l-4 ${borderClass} space-y-2`}
        >
          <div className="flex items-center justify-between gap-2">
            <ModuleTitle Icon={Icon} typeKey={typeKey}>
              {title}
            </ModuleTitle>
            <LegacyModuleActions onEdit={onEdit} onDelete={onDelete} />
          </div>
          <p className="text-sm text-slate-300 leading-relaxed">{content}</p>
        </div>
      </div>
    </div>
  );
}

/**
 * FactModule - Highlights important facts/insights
 */
export function FactModule({ content, align = 'left', onEdit = null, onDelete = null }) {
  return (
    <HighlightModule
      typeKey="fact"
      Icon={Lightbulb}
      title="FACT"
      borderClass="border-l-blue-500"
      content={content}
      align={align}
      onEdit={onEdit}
      onDelete={onDelete}
    />
  );
}

/**
 * RecommendationModule - Highlights recommendations/best practices
 */
export function RecommendationModule({ content, align = 'left', onEdit = null, onDelete = null }) {
  return (
    <HighlightModule
      typeKey="recommendation"
      Icon={CheckCircle2}
      title="RECOMMENDATION"
      borderClass="border-l-emerald-500"
      content={content}
      align={align}
      onEdit={onEdit}
      onDelete={onDelete}
    />
  );
}

/**
 * LinksModule - Grouped related links
 */
export function LinksModule({ links = [], align = 'left', onEdit = null, onDelete = null }) {
  const linksList = Array.isArray(links) ? links : [];
  return (
    <div className="my-4 w-full transition-all duration-200">
      <div className={getModuleLayoutClass(align)}>
        <div
          className={`border rounded-lg p-4 ${MODULE_TYPES.links.color} border-l-4 border-l-blue-500 space-y-2`}
        >
          <div className="mb-3 flex items-center justify-between gap-2">
            <ModuleTitle Icon={Link2} typeKey="links">
              LINKS
            </ModuleTitle>
            <LegacyModuleActions onEdit={onEdit} onDelete={onDelete} />
          </div>
          <ul className="space-y-1">
            {linksList.map((link, i) => (
              <li key={i} className="text-sm">
                <a
                  href={link.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-400 hover:text-blue-300 underline"
                >
                  {link.title || link.url}
                </a>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

/**
 * PictureModule - Embedded image with caption
 */
export function PictureModule({
  imageUrl,
  caption = '',
  align = 'left',
  paired = false,
  onEdit = null,
  onDelete = null,
}) {
  return (
    <div className="my-4 w-full transition-all duration-200">
      <div className={getModuleLayoutClass(align, paired)}>
        <div
          className={`overflow-hidden rounded-lg border ${MODULE_TYPES.picture.color} ${getPictureFrameClass(align, paired)}`}
        >
          {imageUrl && (
            <div className="flex justify-center bg-black/10">
              <img
                src={resolveMediaUrl(imageUrl)}
                alt={caption || 'Module image'}
                className="block h-auto w-full object-contain"
              />
            </div>
          )}
          <div className="space-y-2 p-4">
            {caption && <p className="text-sm italic text-slate-300">{caption}</p>}
            <LegacyModuleActions onEdit={onEdit} onDelete={onDelete} />
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * SpacerModule - Visual spacer/divider
 */
export function SpacerModule({ style = 'gradient', height = 'h-1' }) {
  const spacerStyles = {
    gradient: 'bg-gradient-to-r from-slate-600 via-slate-500 to-slate-600/0',
    solid: 'bg-slate-600',
    dots: 'border-t-2 border-dotted border-slate-600',
    double: 'border-y border-slate-500 h-2 bg-transparent rounded-none',
    glow: 'bg-gradient-to-r from-primary/0 via-primary/60 to-primary/0 shadow-[0_0_18px_rgba(var(--primary-rgb),0.45)]',
    accent: 'bg-gradient-to-r from-primary via-primary/30 to-transparent',
  };

  return (
    <div className="w-full my-8">
      <div className={`${spacerStyles[style] || spacerStyles.gradient} ${height} rounded-full`} />
    </div>
  );
}

export function TextFrameModule({
  content,
  align = 'left',
  paired = false,
  onEdit = null,
  onDelete = null,
}) {
  return (
    <div className="my-4 w-full transition-all duration-200">
      <div className={getModuleLayoutClass(align, paired)}>
        <div
          className={`relative border rounded-lg p-4 ${MODULE_TYPES.text.color} border-l-4 border-l-sky-500`}
        >
          <LegacyModuleActions
            onEdit={onEdit}
            onDelete={onDelete}
            className="absolute right-2 top-2 flex gap-1"
          />
          <p className="text-sm text-slate-300 leading-relaxed whitespace-pre-wrap">{content}</p>
        </div>
      </div>
    </div>
  );
}

export function CodeModule({
  content,
  align = 'left',
  paired = false,
  onEdit = null,
  onDelete = null,
}) {
  return (
    <div className="my-4 w-full transition-all duration-200">
      <div className={getModuleLayoutClass(align, paired)}>
        <div
          className={`relative border rounded-lg p-4 ${MODULE_TYPES.code.color} border-l-4 border-l-indigo-500`}
        >
          <div className="mb-2 flex items-center justify-between gap-2">
            <ModuleTitle Icon={FileCode2} typeKey="code">
              CODE
            </ModuleTitle>
            <LegacyModuleActions onEdit={onEdit} onDelete={onDelete} />
          </div>
          <pre className="overflow-x-auto rounded-md border border-indigo-500/30 bg-black/30 p-3 text-xs leading-relaxed text-slate-200">
            <code>{content || ''}</code>
          </pre>
        </div>
      </div>
    </div>
  );
}

export function VideoModule({
  videoUrl,
  caption = '',
  align = 'left',
  paired = false,
  onEdit = null,
  onDelete = null,
}) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);

  const embedBaseUrl = useMemo(() => getYouTubeEmbedUrl(videoUrl), [videoUrl]);
  const embedUrl = embedBaseUrl ? `${embedBaseUrl}?autoplay=1&rel=0&modestbranding=1` : '';

  return (
    <div className="my-4 w-full transition-all duration-200">
      <div className={getModuleLayoutClass(align, paired)}>
        <div
          className={`relative overflow-hidden rounded-lg border ${MODULE_TYPES.video.color} ${getPictureFrameClass(align, paired)}`}
        >
          <div className={isExpanded ? 'mx-auto w-[50vw] min-w-[320px] max-w-full' : 'w-full'}>
            <div className="relative aspect-video w-full bg-black/40">
              {isPlaying && embedUrl ? (
                <iframe
                  src={embedUrl}
                  title={caption || 'Embedded YouTube video'}
                  className="h-full w-full"
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                  allowFullScreen
                  onDoubleClick={() => setIsExpanded((prev) => !prev)}
                />
              ) : (
                <button
                  type="button"
                  className="relative h-full w-full cursor-pointer"
                  onClick={() => setIsPlaying(true)}
                  onDoubleClick={() => {
                    setIsPlaying(true);
                    setIsExpanded((prev) => !prev);
                  }}
                >
                  <div className="absolute inset-0 bg-gradient-to-br from-slate-900/80 via-slate-800/70 to-slate-900/85" />
                  <div className="absolute inset-0 flex items-center justify-center">
                    <span className="inline-flex items-center gap-2 rounded-full border border-rose-300/40 bg-black/50 px-4 py-2 text-rose-100">
                      <Play className="h-4 w-4 fill-current" />
                      Click to play
                    </span>
                  </div>
                </button>
              )}
            </div>
          </div>

          <div className="space-y-2 p-4">
            {caption && <p className="text-sm italic text-slate-300">{caption}</p>}
            {!embedBaseUrl && (
              <p className="text-xs text-rose-200">
                Invalid YouTube URL. Use `youtube.com/watch?v=...` or `youtu.be/...`.
              </p>
            )}
            <p className="text-[11px] text-slate-400">
              Double-click video to toggle 50% screen mode.
            </p>
            <LegacyModuleActions onEdit={onEdit} onDelete={onDelete} />
          </div>
        </div>
      </div>
    </div>
  );
}

// How each module type is drawn from its parsed data. `p` carries the
// layout and editor props: align, paired, onEdit and onDelete.
const MODULE_RENDERERS = {
  fact: (d, p) => (
    <FactModule content={d.content} align={p.align} onEdit={p.onEdit} onDelete={p.onDelete} />
  ),
  recommendation: (d, p) => (
    <RecommendationModule
      content={d.content}
      align={p.align}
      onEdit={p.onEdit}
      onDelete={p.onDelete}
    />
  ),
  links: (d, p) => (
    <LinksModule links={d.links} align={p.align} onEdit={p.onEdit} onDelete={p.onDelete} />
  ),
  picture: (d, p) => <PictureModule imageUrl={d.imageUrl} caption={d.caption} {...p} />,
  spacer: (d) => <SpacerModule style={d.style} height={d.height} />,
  video: (d, p) => <VideoModule videoUrl={d.videoUrl} caption={d.caption} {...p} />,
  text: (d, p) => <TextFrameModule content={d.content} {...p} />,
  code: (d, p) => <CodeModule content={d.content} {...p} />,
  // The Phase 4 rich types (RichModules.jsx).
  design: (d, p) => <DesignModule content={d.content} onEdit={p.onEdit} onDelete={p.onDelete} />,
  pull_quote: (d, p) => <PullQuoteModule text={d.text} attribution={d.attribution} {...p} />,
  stat_board: (d, p) => <StatBoardModule stats={d.stats} onEdit={p.onEdit} onDelete={p.onDelete} />,
  comparison: (d, p) => (
    <ComparisonModule columns={d.columns} rows={d.rows} onEdit={p.onEdit} onDelete={p.onDelete} />
  ),
  timeline: (d, p) => <TimelineModule steps={d.steps} onEdit={p.onEdit} onDelete={p.onDelete} />,
  callout: (d, p) => <CalloutModule eyebrow={d.eyebrow} title={d.title} body={d.body} {...p} />,
};

/**
 * ModuleContainer - Display module with inline text wrapping
 * Used to render a single module from parsed data
 */
export function ModuleContainer({
  type,
  data,
  align = 'left',
  paired = false,
  onEdit = null,
  onDelete = null,
  ...inlineData
}) {
  const moduleData = data || inlineData || {};
  if (!Object.hasOwn(MODULE_RENDERERS, type)) return null;
  return MODULE_RENDERERS[type](moduleData, { align, paired, onEdit, onDelete });
}
