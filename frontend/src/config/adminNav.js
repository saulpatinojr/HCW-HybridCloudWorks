/**
 * The ContentForge navigation registry (ADR 0033 §3).
 *
 * ONE list, read by the sidebar (AdminLayout), the dashboard's "Explore"
 * strip and each page's header, so a group's name, an item's description
 * and its route are written once. A new user reads the description on
 * hover in the sidebar, under the title on the page, and on the dashboard
 * card — the same sentence in all three places.
 *
 * Groups answer the question a first-time user has at the menu:
 *
 *   Pipeline   where a piece of content moves from idea to live page
 *   Enhanced   tools that turn published content into something more
 *   Creative   where new content and images are made
 *   Amplify    where finished content reaches an audience
 *   Spotlight  the author's own visibility: talks, credentials, programs
 *   Platform   how the system itself is configured and watched
 *
 * Item order inside Pipeline is the order the work happens. No text tags
 * beside an item (#566): a badge is state, a tag naming the product behind a
 * page belongs on that page's header.
 *
 * THE LABEL IS THE ROUTE AND THE TITLE (AP-F13, #937). Each item's path is
 * `/admin/<slug of its label>` (`labelSlug` below; adminNav.test.js holds every
 * row to it), and PageHeader renders the label as the page's h1, so the menu
 * entry, the address bar and the heading cannot say three different things —
 * which they did: "Publish" opened /admin/published under the title "Publish",
 * "Review Queue" opened /admin/queue under "Content Queue". The old paths
 * redirect (config/adminRedirects.jsx), so nothing bookmarked or mailed broke.
 *
 * The registry is two tables — the groups, and the items with the group each
 * belongs to — joined once below. One row per entry, so adding a page is one
 * line and no group is a copy of another's shape.
 *
 * Every item also carries the lowest role it is shown to (`minRole`, AP-F4,
 * #928), so the sidebar, the drawer and the dashboard's Explore strip filter
 * from the same answer: `visibleNavFor(role)`. The role is read from what the
 * server enforces, never chosen here; the table above ITEMS records where.
 */
import { ADMIN_ROLES } from '@/config/admin-v2';
import {
  Brain,
  Activity,
  Award,
  BadgeCheck,
  BookOpen,
  Bot,
  Calendar,
  Code2,
  FilePen,
  FlaskConical,
  Flame,
  Globe,
  Headphones,
  Image,
  Images,
  LayoutDashboard,
  Link2,
  ListChecks,
  Mail,
  Mic,
  Newspaper,
  PenLine,
  Plug,
  Radio,
  Share2,
  SlidersHorizontal,
  Vault,
  Zap,
} from 'lucide-react';

/** `[id, label, description]`, in menu order. */
const GROUPS = [
  ['home', 'Home', 'Where you are, what is waiting, and what to do next.'],
  [
    'pipeline',
    'Pipeline',
    'Every piece of content moves through these stages, in this order, to a live page.',
  ],
  [
    'enhanced',
    'Enhanced',
    'Tools that turn published content into something more: audio, labs, structured guides.',
  ],
  [
    'creative',
    'Creative',
    'Where new content and images are made, and how the AI behind them is set up.',
  ],
  [
    'amplify',
    'Amplify',
    'Where finished content reaches an audience: the calendar, the newsletter, social.',
  ],
  [
    'spotlight',
    'Spotlight',
    'Your own visibility: the talks you give, the credentials you hold, the programs you pursue.',
  ],
  ['platform', 'Platform', 'How the system itself is configured, connected and watched.'],
];

/**
 * The role ladder: config/admin-v2.js's read-only mirror of the server's
 * `roles.js` — viewer 1, editor 2, publisher 3, super_admin 4 — which is also
 * the table `hasRole` in hooks/useAdminAuth.js compares against. An unknown
 * name is 0, below every real role, so it never satisfies a check; the
 * server's `roleLevel` does the same.
 */
const ROLE_LEVELS = Object.freeze(
  Object.fromEntries(Object.values(ADMIN_ROLES).map(({ name, level }) => [name, level]))
);

/** Canonical role names, lowest privilege first. */
export const ROLE_NAMES = Object.freeze(
  Object.values(ADMIN_ROLES)
    .slice()
    .sort((a, b) => a.level - b.level)
    .map((role) => role.name)
);

/** Hierarchy level for a role name, or 0 when the name is unknown or empty. */
export function roleLevel(role) {
  return ROLE_LEVELS[String(role || '').toLowerCase()] ?? 0;
}

/** Whether `actual` is `required` or outranks it. An unknown requirement is never met. */
export function satisfiesRole(actual, required) {
  const need = roleLevel(required);
  return need > 0 && roleLevel(actual) >= need;
}

/** The role name as the chrome prints it: `super_admin` reads "Super admin". */
export function roleLabel(role) {
  const name = String(role || '').toLowerCase();
  if (!ROLE_LEVELS[name]) return 'Unknown role';
  return name.charAt(0).toUpperCase() + name.slice(1).replace(/_/g, ' ');
}

/**
 * `[group, to, icon, label, description, extra]`, in the order each group
 * shows them. `extra` carries `minRole` (every row), `end` (exact match for
 * the dashboard route) and `badgeKey` (which count the sidebar shows beside
 * the item).
 *
 * `minRole` is the lowest role the menu shows the item to (AP-F4, #928): the
 * role the server's guard (`functions/src/lib/auth/require-role.js`) asks for
 * on the routes the page exists to call, so a viewer no longer learns a
 * page's role from its 403. A page a viewer can read is `viewer`; a page
 * whose purpose is a write carries the write's role even where its listing
 * happens to be readable lower down (the Publish page's snapshot is a viewer
 * read, but publishing is what the page is for). Actions above the page's
 * own role are gated where they sit (components/admin/RoleGate.jsx). Read
 * against functions/src on 2026-10-15; paths are under functions/src/lib:
 *
 *   Dashboard          viewer     getAdminDashboardSnapshot, getDecisionCenter (admin-snapshots.js,
 *                                 decision-center.js); Recount is recalculateDashboardStats, editor, gated on the button
 *   New Content        editor     generateArticleDraft (content/draft-from-url.js), createContentItem
 *                                 (cms/content-create.js), generatePreviewImages (manual-images/preview.js)
 *   Drafts             editor     cms/drafts (cms/drafts-handlers.js)
 *   Review Queue       editor     transitionContentStatus (cms/content-update.js) for approve and reject; the
 *                                 snapshot (getQueueSnapshot) is a viewer read; deleteRejectedContent
 *                                 (gallery-images.js) and deleteContentItem (content-workflow.js) are publisher, gated
 *   Editor             editor     cms/content (cms-content.js), saveEditorDraft (content-workflow/editor.js); the
 *                                 Archive board's Restore to live (archived → published, cms/content-update.js) and
 *                                 Delete permanently (deleteContentItem, content-workflow.js) are publisher, gated
 *   Publish            publisher  publishContent (cms/publish.js), unpublishContentToInspected (content-workflow.js),
 *                                 cms/content/slug (cms/set-slug.js), cms/content/rehost-images POST (cms/rehost-images.js)
 *   Live Pages         editor     cms/content?live=true (cms-content.js); Archive (published → archived through
 *                                 transitionContentStatus, cms/content-update.js) is publisher, gated, so the Undo
 *                                 its toast offers reaches only the publisher who archived
 *   Listen & Learn     editor     cms/listen-and-learn (listen-and-learn/book-handlers.js); approving a chapter with
 *                                 publish is publisher (listen-and-learn/speech-handlers.js), gated
 *   Labs               editor     enqueueLabJob, cancelLabJob (labs.js), cms/labs/agents (labs/agent-registry.js); the
 *                                 live snapshot (getLabsSnapshot) is a viewer read
 *   Frameworks         editor     cms/content (cms-content.js), updateContentItem (cms/content-update.js)
 *   Coder Corner       editor     the same routes as Frameworks
 *   Forge Studio       editor     getForgeConfig (content/forge-studio/config.js), cms/forge/queue (…/queue.js),
 *                                 cms/forge/assist (…/workspace.js)
 *   AI Engine          editor     cms/config/{collection} (admin-integrations/config-collections.js), cms/ai-features,
 *                                 cms/ai-routing (admin-integrations/ai-features.js, ai-routing.js); the MCP OAuth
 *                                 routes are super_admin (ai/mcp-oauth-handlers.js); the Koda tab reads
 *                                 cms/agent-content/key at editor and its writes (generate, switch, revoke) are
 *                                 super_admin (agent-content/admin-handlers.js, ADR 0037)
 *   Image Prompts      editor     cms/image-prompts (cms/image-prompts/handlers.js)
 *   Image Gallery      editor     cms/images (admin-integrations.js), cms/images/bulk (gallery-images.js)
 *   Calendar           editor     cms/calendar (calendar.js); saveContentSchedule and unscheduleContent are publisher
 *                                 (content-workflow/schedule.js), gated
 *   Newsletter Hub     editor     cms/newsletters (newsletter/admin-handlers.js); approve, test, cancel, reschedule and
 *                                 retry are publisher (newsletter/admin-handlers.js, newsletter/issue-actions.js), gated
 *   Social Hub         editor     cms/social-posts (admin-crud/social-posts.js), publerProxy (integrations/rest-proxy.js)
 *   Linkie Hub         editor     linkieProxy (integrations/rest-proxy.js), cms/content (cms-content.js)
 *   Recording Hub      editor     cms/recordings (admin-integrations.js), cms/podcast/transcripts (podcast/handlers.js);
 *                                 the transcript review and the host publish retry are publisher (podcast/handlers.js), gated
 *   Speaking           editor     cms/speakerevents (admin-integrations.js), upsertSpeakerEvent (admin-identity/speaker-events.js)
 *   Certifications     editor     cms/certifications (admin-crud/certifications.js), publishSnapshot (snapshots-publish.js)
 *   Ambassador         editor     cms/ambassador/programs, applications, evidence (ambassador/handlers.js); deletes are publisher
 *   Platform Settings  editor     cms/platform-settings/{setting} (platform-settings.js)
 *   Health             viewer     getOpsHealthSnapshot (ops-health.js), cms/health/probe-results (health/probe-results.js);
 *                                 updateWorkflowAlert is publisher (ops-health.js), gated
 *   Integrations       editor     connectionProbe (integrations/connection-probe.js), cms/integration-status
 *                                 (integrations/integration-status.js); the Keys tab's cms/secrets is super_admin (admin-secrets.js)
 *   Doc Vault          publisher  cms/doc-vault (doc-vault/handlers.js), every route, reads included: the vault holds
 *                                 private letters and applications, so it is above the editor role (doc-vault/model.js)
 */
const ITEMS = [
  [
    'creative',
    '/admin/second-brain',
    Brain,
    'Second Brain',
    'Your private notes, connected content, projects, and research.',
    { minRole: 'editor', requiresBrain: true },
  ],
  [
    'home',
    '/admin',
    LayoutDashboard,
    'Dashboard',
    'Everything waiting on you, the pipeline at a glance, and recent activity.',
    { end: true, minRole: 'viewer' },
  ],

  // Pipeline, in the order the work happens.
  [
    'pipeline',
    '/admin/new-content',
    Zap,
    'New Content',
    'Start something: import a URL or document, or draft from a source.',
    { minRole: 'editor' },
  ],
  [
    'pipeline',
    '/admin/drafts',
    FilePen,
    'Drafts',
    'Your writing desk. Articles you are still writing, before anyone reviews them.',
    { minRole: 'editor' },
  ],
  [
    'pipeline',
    '/admin/review-queue',
    ListChecks,
    'Review Queue',
    'Triage what arrived: approve it for editing, send it back, or reject it.',
    { badgeKey: 'queue', minRole: 'editor' },
  ],
  [
    'pipeline',
    '/admin/editor',
    PenLine,
    'Editor',
    'Polish approved drafts: text, metadata, images, and the publish date.',
    { badgeKey: 'editor', minRole: 'editor' },
  ],
  [
    'pipeline',
    '/admin/publish',
    Newspaper,
    'Publish',
    'Push finished content live, now or on a schedule, and see what went out.',
    { badgeKey: 'publish', minRole: 'publisher' },
  ],
  [
    'pipeline',
    '/admin/live-pages',
    Globe,
    'Live Pages',
    'Every page visitors can open right now, with its URL, type and provider.',
    { badgeKey: 'live', minRole: 'editor' },
  ],

  // Enhanced
  [
    'enhanced',
    '/admin/listen-and-learn',
    Headphones,
    'Listen & Learn',
    'Turn study guides and articles into spoken chapters, organised as books and courses.',
    { minRole: 'editor' },
  ],
  [
    'enhanced',
    '/admin/labs',
    FlaskConical,
    'Labs',
    'Hands-on learning environments per provider, and the agent and desktop behind them.',
    { minRole: 'editor' },
  ],
  [
    'enhanced',
    '/admin/frameworks',
    BookOpen,
    'Frameworks',
    'Well-Architected style reference guides, reviewed and published on their own board.',
    { minRole: 'editor' },
  ],
  [
    'enhanced',
    '/admin/coder-corner',
    Code2,
    'Coder Corner',
    'Code-first tutorials and snippets, reviewed and published on their own board.',
    { minRole: 'editor' },
  ],

  [
    'enhanced',
    '/admin/blogs',
    Newspaper,
    'Blogs',
    'Review articles, manage blog sources, and choose fallback images for intake.',
    { minRole: 'editor' },
  ],

  // Creative
  [
    'creative',
    '/admin/forge-studio',
    Flame,
    'Forge Studio',
    'Brief, draft and shape a piece with AI help, then send it into the pipeline.',
    { minRole: 'editor' },
  ],
  [
    'creative',
    '/admin/ai-engine',
    Bot,
    'AI Engine',
    'Which AI provider and model handles each kind of task, with fallbacks and usage.',
    { minRole: 'editor' },
  ],
  [
    'creative',
    '/admin/image-prompts',
    Image,
    'Image Prompts',
    'Prompt sets that generate coordinated images on a shared theme.',
    { minRole: 'editor' },
  ],
  [
    'creative',
    '/admin/image-gallery',
    Images,
    'Image Gallery',
    'Every image the site holds: generated, uploaded or imported, with where it is used.',
    { minRole: 'editor' },
  ],

  // Amplify
  [
    'amplify',
    '/admin/calendar',
    Calendar,
    'Calendar',
    'Everything scheduled across ContentForge: publishes, sends, posts, talks, deadlines.',
    { minRole: 'editor' },
  ],
  [
    'amplify',
    '/admin/newsletter-hub',
    Mail,
    'Newsletter Hub',
    'Build, review, send and measure newsletter issues; manage who receives them.',
    { minRole: 'editor' },
  ],
  [
    'amplify',
    '/admin/social-hub',
    Share2,
    'Social Hub',
    'Schedule live pages to LinkedIn, X and other networks through Publer.',
    { minRole: 'editor' },
  ],
  [
    'amplify',
    '/admin/linkie-hub',
    Link2,
    'Linkie Hub',
    'The link-in-bio profile: which pages it lists and how they perform.',
    { minRole: 'editor' },
  ],
  [
    'amplify',
    '/admin/recording-hub',
    Radio,
    'Recording Hub',
    'Plaud recordings to transcripts to podcast episodes, and their distribution.',
    { minRole: 'editor' },
  ],

  // Spotlight
  [
    'spotlight',
    '/admin/speaking',
    Mic,
    'Speaking',
    'Talks, proposals and deadlines, synced from Sessionize and published to About.',
    { minRole: 'editor' },
  ],
  [
    'spotlight',
    '/admin/certifications',
    Award,
    'Certifications',
    'Credentials, badges, expiry and renewal dates, published to About.',
    { minRole: 'editor' },
  ],
  [
    'spotlight',
    '/admin/ambassador',
    BadgeCheck,
    'Ambassador',
    'Prepare and track applications to MVP, Hero, Captain and other programs, with evidence.',
    { minRole: 'editor' },
  ],

  // Platform
  [
    'platform',
    '/admin/platform-settings',
    SlidersHorizontal,
    'Platform Settings',
    'Defaults the pipeline reads on every run: covers, voices, content types, autoposting — and the reminders sheet.',
    { minRole: 'editor' },
  ],
  [
    'platform',
    '/admin/health',
    Activity,
    'Health',
    'Whether each part of the platform is working, with last-checked times and fixes.',
    { minRole: 'viewer' },
  ],
  [
    'platform',
    '/admin/integrations',
    Plug,
    'Integrations',
    'Every external service, its keys, its connection test, where it is used, and a directory explaining each one.',
    { minRole: 'editor' },
  ],

  // Spotlight, appended last (owner request 2026-10-26): private, so publisher and above.
  [
    'spotlight',
    '/admin/doc-vault',
    Vault,
    'Doc Vault',
    'Your own templates, pasted applications and letters, kept private with their history. Not shown on the site.',
    { minRole: 'publisher' },
  ],
];

/**
 * A label as its route segment: lower case, `&` read as "and", every other
 * run of non-alphanumerics one hyphen. "Listen & Learn" is listen-and-learn,
 * "Platform Settings" is platform-settings.
 */
export function labelSlug(label) {
  return String(label || '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** An item's id is its route's last segment; the dashboard, at the bare /admin, is `dashboard`. */
const navId = (to) => (to === '/admin' ? 'dashboard' : to.slice('/admin/'.length));

/**
 * One row of ITEMS as the registry entry the sidebar and the headers read.
 * A row without a role, or with a misspelt one, fails here at module load
 * rather than quietly showing the page to everyone or to no one — the same
 * choice the server's requireRole makes for "publishor".
 */
const navItem = ([, to, icon, label, description, extra = {}]) => {
  if (!ROLE_LEVELS[extra.minRole]) {
    throw new Error(`adminNav: ${label} (${to}) needs a minRole from ${ROLE_NAMES.join(', ')}`);
  }
  return {
    id: navId(to),
    to,
    icon,
    label,
    ...extra,
    description,
  };
};

export const NAV_GROUPS = Object.freeze(
  GROUPS.map(([id, label, description]) => ({
    id,
    label,
    description,
    items: ITEMS.filter(([group]) => group === id).map(navItem),
  }))
);

/** Every item across every group, flat. */
export const NAV_ITEMS = Object.freeze(NAV_GROUPS.flatMap((group) => group.items));

/**
 * The registry entry for a route, so a page header can show the same
 * description the sidebar does. Exact match first, then the longest prefix
 * (so /admin/review-queue/abc resolves to Review Queue), never the bare /admin for
 * a deeper path.
 */
export function navItemFor(pathname) {
  const path = String(pathname || '');
  const exact = NAV_ITEMS.find((item) => item.to === path);
  if (exact) return exact;
  return (
    NAV_ITEMS.filter((item) => item.to !== '/admin' && path.startsWith(`${item.to}/`)).sort(
      (a, b) => b.to.length - a.to.length
    )[0] || null
  );
}

/** The registry entry with this id (`review-queue`, `dashboard`), or null. */
export function navItemById(id) {
  return NAV_ITEMS.find((item) => item.id === id) || null;
}

/** The group an item belongs to. */
export function navGroupFor(item) {
  return NAV_GROUPS.find((group) => group.items.includes(item)) || null;
}

/**
 * The groups and items an admin of `role` is shown, in registry order, with
 * a group that would be empty dropped rather than left as a bare heading. An
 * unknown or missing role is shown the viewer's menu — the smallest set,
 * never a larger one on a guess. The items are the registry's own objects,
 * so navGroupFor still finds them; the arrays are fresh each call, so a
 * component memoises on the role.
 */
export function visibleNavFor(role, capabilities = {}) {
  const level = Math.max(roleLevel(role), roleLevel(ROLE_NAMES[0]));
  return NAV_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter(
      (item) =>
        roleLevel(item.minRole) <= level && (!item.requiresBrain || capabilities.brain === true)
    ),
  })).filter((group) => group.items.length > 0);
}
