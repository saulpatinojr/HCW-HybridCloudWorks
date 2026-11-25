import { RAW_MODULE_TYPES } from '@/lib/moduleParser';
import { FULL_WIDTH_MODULE_TYPES } from '@/lib/modulePairing';
import {
  comparisonToInput,
  linksToInput,
  parseComparisonInput,
  parseLinksInput,
  parseStatsInput,
  parseStepsInput,
  statsToInput,
  stepsToInput,
} from './moduleFormEncoding';

// Pure helpers for useModules: the module form's defaults, and turning the
// form into a module payload and back.

// `MAP[key]` when the map has its own entry for key, else `fallback`.
// (Own entries only, so a type named like "toString" falls back too.)
function lookup(map, key, fallback) {
  return Object.hasOwn(map, key) ? map[key] : fallback;
}

const FACT_DRAFT = 'Add a sharp supporting insight or important fact here.';

const DEFAULT_MODULE_DRAFTS = {
  recommendation: 'Use this callout for best practices, decisions, or recommended next steps.',
  code: 'const message = "Add your code snippet";\nconsole.log(message);',
  text: 'Add framed narrative copy here.',
  links: '- [Reference link](https://example.com)',
  picture: '',
  video: '',
  spacer: 'gradient',
  design: 'graph TD;\n  A[Start] --> B[Finish]',
  pull_quote: 'One striking sentence worth restating large.',
  stat_board: '40% | lower cost\n3x | faster deploys',
  comparison: 'Dimension | Option A | Option B\nCost | $ | $$',
  timeline: 'Assess :: Inventory what you run today\nMigrate :: Move workloads in waves',
  callout: 'One or two sentences of detail.',
  fact: FACT_DRAFT,
};

export function getDefaultModuleDraft(type) {
  return lookup(DEFAULT_MODULE_DRAFTS, type, FACT_DRAFT);
}

function trimmed(value) {
  return String(value || '').trim();
}

// stat_board, comparison and timeline always render full width; their payloads
// pin align="all" the same way spacer pins its own.
const RICH_PAYLOAD_BUILDERS = {
  pull_quote: ({ type, align, content, attribution }) => {
    const payload = { type, align, text: trimmed(content) };
    if (trimmed(attribution)) payload.attribution = attribution.trim();
    return payload;
  },
  stat_board: ({ type, content }) => ({ type, align: 'all', stats: parseStatsInput(content) }),
  comparison: ({ type, content }) => ({ type, align: 'all', ...parseComparisonInput(content) }),
  timeline: ({ type, content }) => ({ type, align: 'all', steps: parseStepsInput(content) }),
  callout: ({ type, align, content, title, eyebrow }) => {
    const payload = { type, align, title: trimmed(title), body: trimmed(content) };
    if (trimmed(eyebrow)) payload.eyebrow = eyebrow.trim();
    return payload;
  },
};

const PLAIN_PAYLOAD_BUILDERS = {
  links: ({ align, content }) => ({ type: 'links', align, links: parseLinksInput(content) }),
  picture: ({ align, imageUrl, caption }) => ({ type: 'picture', align, imageUrl, caption }),
  video: ({ align, videoUrl, caption }) => ({ type: 'video', align, videoUrl, caption }),
  spacer: ({ content }) => ({
    type: 'spacer',
    align: 'left',
    style: content || 'gradient',
    height: 'h-1',
  }),
  design: ({ type, content }) => ({ type, align: 'all', content }),
};

const PAYLOAD_BUILDERS = { ...RICH_PAYLOAD_BUILDERS, ...PLAIN_PAYLOAD_BUILDERS };

function contentPayload({ type, align, content }) {
  return { type, align, content };
}

export function buildPayloadFromForm(form) {
  return lookup(PAYLOAD_BUILDERS, form.type, contentPayload)(form);
}

const FORM_CONTENT_READERS = {
  links: (item) => linksToInput(item.links || []),
  spacer: (item) => item.style || 'gradient',
  pull_quote: (item) => item.text || '',
  stat_board: (item) => statsToInput(item.stats || []),
  comparison: (item) => comparisonToInput(item),
  timeline: (item) => stepsToInput(item.steps || []),
  callout: (item) => item.body || '',
};

/** The form's `content` textarea representation of a committed payload. */
function formContentFor(item) {
  return lookup(FORM_CONTENT_READERS, item.type, (it) => it.content || '')(item);
}

/** Load a committed module payload back into the flat form representation. */
export function moduleToFormState(item) {
  return {
    type: item.type || 'fact',
    align: item.align || 'left',
    content: formContentFor(item),
    imageUrl: item.imageUrl || '',
    videoUrl: item.videoUrl || '',
    caption: item.caption || '',
    attribution: item.attribution || '',
    title: item.title || '',
    eyebrow: item.eyebrow || '',
  };
}

// A spacer is always left-aligned; anything else keeps its alignment.
function carriedAlign(current) {
  return current.type === 'spacer' ? 'left' : current.align || 'left';
}

function buildPictureModule(current, imageCandidates) {
  const isPicture = current.type === 'picture';
  return {
    type: 'picture',
    align: carriedAlign(current),
    imageUrl: isPicture ? current.imageUrl || '' : imageCandidates?.[0]?.imageUrl || '',
    caption: isPicture ? current.caption || '' : '',
  };
}

function buildVideoModule(current) {
  const isVideo = current.type === 'video';
  return {
    type: 'video',
    align: carriedAlign(current),
    videoUrl: isVideo ? current.videoUrl || '' : '',
    caption: isVideo ? current.caption || '' : '',
  };
}

function buildSpacerModule(current) {
  const isSpacer = current.type === 'spacer';
  return {
    type: 'spacer',
    align: 'left',
    style: isSpacer ? current.style || 'gradient' : 'gradient',
    height: isSpacer ? current.height || 'h-1' : 'h-1',
  };
}

function buildContentModule(nextType, current, defaultContent) {
  const isContentType = RAW_MODULE_TYPES.includes(current.type);
  const align = nextType === 'design' ? 'all' : carriedAlign(current);
  return {
    type: nextType,
    align,
    content: isContentType ? current.content || defaultContent : defaultContent,
  };
}

/**
 * The module an existing module becomes when its type is switched, keeping
 * what it can (content, alignment, caption) where the types are compatible.
 */
export function moduleForTypeSwitch(nextType, current, imageCandidates) {
  const defaultContent = getDefaultModuleDraft(nextType);
  if (nextType === 'picture') return buildPictureModule(current, imageCandidates);
  if (nextType === 'spacer') return buildSpacerModule(current);
  if (nextType === 'video') return buildVideoModule(current);
  if (RAW_MODULE_TYPES.includes(nextType)) {
    return buildContentModule(nextType, current, defaultContent);
  }
  // Rich JSON types: build a fresh payload from the default form draft.
  return buildPayloadFromForm({
    type: nextType,
    align: carriedAlign(current),
    content: defaultContent,
    attribution: '',
    title: nextType === 'callout' ? 'Heads up' : '',
    eyebrow: '',
  });
}

/**
 * The payload "Add to Article" commits: an empty textarea gets the type's
 * default text, and links always have at least a fallback entry.
 */
export function newModulePayload(moduleForm) {
  const payload = buildPayloadFromForm({
    ...moduleForm,
    content: moduleForm.content?.trim()
      ? moduleForm.content
      : getDefaultModuleDraft(moduleForm.type),
  });

  // Ensure links always have at least a fallback entry
  if (payload.type === 'links' && (!payload.links || payload.links.length === 0)) {
    payload.links = parseLinksInput(getDefaultModuleDraft('links'));
  }
  return payload;
}

/** Where the module being edited ends up after moving `fromIndex` to `toIndex`. */
export function editingIndexAfterMove(prev, fromIndex, toIndex) {
  if (prev === fromIndex) return toIndex;
  if (prev >= 0) {
    if (fromIndex < prev && toIndex >= prev) return prev - 1;
    if (fromIndex > prev && toIndex <= prev) return prev + 1;
  }
  return prev;
}

export const INITIAL_FORM = {
  type: 'fact',
  align: 'left',
  content: getDefaultModuleDraft('fact'),
  imageUrl: '',
  videoUrl: '',
  caption: '',
  attribution: '',
  title: '',
  eyebrow: '',
};

// A fresh form for a type. callout gets a default title because a callout
// without one is invalid — without this, "Add to Article" straight from the
// picker would commit an invalid module.
export function defaultFormForType(nextType) {
  return {
    ...INITIAL_FORM,
    type: nextType,
    content: getDefaultModuleDraft(nextType),
    title: nextType === 'callout' ? 'Heads up' : '',
  };
}

// ── List edits ───────────────────────────────────────────────────────────────

export function isIndexIn(list, index) {
  return index >= 0 && index < list.length;
}

/** The modules with the one at `index` replaced. */
export function withModuleAt(moduleItems, index, payload) {
  return moduleItems.map((item, i) => (i === index ? payload : item));
}

/**
 * The modules with the one at `index` set to `align`, or null for an
 * alignment we do not know. Full-width types pin their own alignment, so
 * they are left as they are.
 */
export function withModuleAlign(moduleItems, index, align) {
  if (!['left', 'right', 'all'].includes(align)) return null;
  return moduleItems.map((item, i) =>
    i !== index || FULL_WIDTH_MODULE_TYPES.includes(item.type) ? item : { ...item, align }
  );
}

/**
 * The modules with `fromIndex` moved to `toIndex`, or null when either is
 * negative or they are the same. (No upper bound check, as before.)
 */
export function movedModules(moduleItems, fromIndex, toIndex) {
  if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return null;
  const next = [...moduleItems];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved);
  return next;
}
