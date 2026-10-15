import React, { Suspense, lazy, useEffect, useState } from 'react';
import {
  BrowserRouter as Router,
  Routes,
  Route,
  Navigate,
  useLocation,
  useParams,
} from 'react-router';
import ScrollToTop from '@/components/shared/ScrollToTop';
import Header from '@/components/shared/Header';
import Footer from '@/components/shared/Footer';
import { VALID_PROVIDERS, ProviderLayout } from '@/context/ProviderContext';
import { ThemeProvider } from '@/context/ThemeContext';
// A bare string module, deliberately: importing this from msalConfig.js would
// drag MSAL onto every public route (#520).
import { AUTH_REDIRECT_PATH } from '@/lib/authRoutes';
// Plain data and one Navigate, so no admin page is pulled onto the public
// bundle: every retired admin path and where it goes now (#442, #569, #570,
// and the slugs renamed to their menu labels for AP-F13, #937).
import { adminLegacyRoutes } from '@/config/adminRedirects';

const lazyPage = (loader) => lazy(loader);

// --- Lazy Load Pages ---

// Shared
const HomePage = lazyPage(() => import('@/pages/shared/HomePage'));
const AboutPage = lazyPage(() => import('@/pages/shared/AboutPage'));
const ContactPage = lazyPage(() => import('@/pages/shared/ContactPage'));
const EducationIndexPage = lazyPage(() => import('@/pages/shared/EducationIndexPage'));
const LabsLearnPage = lazyPage(() => import('@/pages/shared/LabsLearnPage'));
const LabPanePage = lazyPage(() => import('@/pages/shared/LabPanePage'));
const NewsPage = lazyPage(() => import('@/pages/shared/NewsPage'));
const SharedPodcastPage = lazyPage(() => import('@/pages/shared/PodcastPage'));
const NotFoundPage = lazyPage(() => import('@/pages/NotFoundPage'));
const ThemeToggleButton = lazyPage(() => import('@/components/shared/ThemeToggleButton'));

// AWS
const AWSLandingPage = lazyPage(() => import('@/pages/aws/LandingPage'));
const AWSArchitecturePage = lazyPage(() => import('@/pages/aws/ArchitecturePage'));
const AWSFrameworksPage = lazyPage(() => import('@/pages/aws/FrameworksPage'));
const AWSBlogPage = lazyPage(() => import('@/pages/aws/BlogPage'));
const AWSEducationPage = lazyPage(() => import('@/pages/aws/EducationPage'));
const AWSCertDetailPage = lazyPage(() => import('@/pages/aws/education/CertDetailPage'));
const AWSMicrocredentialDetailPage = lazyPage(
  () => import('@/pages/aws/education/MicrocredentialDetailPage')
);
const AWSRssPage = lazyPage(() => import('@/pages/aws/RssPage'));

// Azure
const AzureLandingPage = lazyPage(() => import('@/pages/azure/LandingPage'));
const AzureArchitecturePage = lazyPage(() => import('@/pages/azure/ArchitecturePage'));
const AzureFrameworksPage = lazyPage(() => import('@/pages/azure/FrameworksPage'));
const AzureBlogPage = lazyPage(() => import('@/pages/azure/BlogPage'));
const AzureEducationPage = lazyPage(() => import('@/pages/azure/EducationPage'));
const AzureCertDetailPage = lazyPage(() => import('@/pages/azure/education/CertDetailPage'));
const AzureRssPage = lazyPage(() => import('@/pages/azure/RssPage'));

// GCP
const GCPLandingPage = lazyPage(() => import('@/pages/gcp/LandingPage'));
const GCPArchitecturePage = lazyPage(() => import('@/pages/gcp/ArchitecturePage'));
const GCPFrameworksPage = lazyPage(() => import('@/pages/gcp/FrameworksPage'));
const GCPBlogPage = lazyPage(() => import('@/pages/gcp/BlogPage'));
const GCPEducationPage = lazyPage(() => import('@/pages/gcp/EducationPage'));
const GCPRssPage = lazyPage(() => import('@/pages/gcp/RssPage'));

// FinOps
const FinOpsLandingPage = lazyPage(() => import('@/pages/finops/LandingPage'));
const FinOpsToolsPage = lazyPage(() => import('@/pages/finops/ToolsPage'));
const FinOpsFocusPage = lazyPage(() => import('@/pages/finops/FocusPage'));
const FinOpsArchitecturePage = lazyPage(() => import('@/pages/finops/ArchitecturePage'));
const FinOpsBlogPage = lazyPage(() => import('@/pages/finops/BlogPage'));
const FinOpsFrameworksPage = lazyPage(() => import('@/pages/finops/FrameworksPage'));
const FinOpsEducationPage = lazyPage(() => import('@/pages/finops/EducationPage'));
const FinOpsRssPage = lazyPage(() => import('@/pages/finops/RssPage'));

// Terraform
const TerraformLandingPage = lazyPage(() => import('@/pages/terraform/LandingPage'));
const TerraformCodePage = lazyPage(() => import('@/pages/terraform/CodePage'));
const TerraformModulesPage = lazyPage(() => import('@/pages/terraform/ModulesPage'));
const TerraformToolsPage = lazyPage(() => import('@/pages/terraform/ToolsPage'));
const TerraformBlogPage = lazyPage(() => import('@/pages/terraform/BlogPage'));
const TerraformRssPage = lazyPage(() => import('@/pages/terraform/RssPage'));
const TerraformEducationPage = lazyPage(() => import('@/pages/terraform/EducationPage'));

// GitHub
const GitHubLandingPage = lazyPage(() => import('@/pages/github/LandingPage'));
const GitHubWorkflowsPage = lazyPage(() => import('@/pages/github/WorkflowsPage'));
const GitHubCodePage = lazyPage(() => import('@/pages/github/CodePage'));
const GitHubToolsPage = lazyPage(() => import('@/pages/github/ToolsPage'));
const GitHubBlogPage = lazyPage(() => import('@/pages/github/BlogPage'));
const GitHubRssPage = lazyPage(() => import('@/pages/github/RssPage'));
const GitHubEducationPage = lazyPage(() => import('@/pages/github/EducationPage'));

// VMware
const VMwareLandingPage = lazyPage(() => import('@/pages/vmware/LandingPage'));
const VMwareArchitecturePage = lazyPage(() => import('@/pages/vmware/ArchitecturePage'));
const VMwareFrameworksPage = lazyPage(() => import('@/pages/vmware/FrameworksPage'));
const VMwareBlogPage = lazyPage(() => import('@/pages/vmware/BlogPage'));
const VMwareEducationPage = lazyPage(() => import('@/pages/vmware/EducationPage'));
const VMwareRssPage = lazyPage(() => import('@/pages/vmware/RssPage'));

// Ansible
const AnsibleLandingPage = lazyPage(() => import('@/pages/ansible/LandingPage'));
const AnsibleCodePage = lazyPage(() => import('@/pages/ansible/CodePage'));
const AnsibleBlogPage = lazyPage(() => import('@/pages/ansible/BlogPage'));
const AnsibleEducationPage = lazyPage(() => import('@/pages/ansible/EducationPage'));
const AnsibleRssPage = lazyPage(() => import('@/pages/ansible/RssPage'));

// Docker (service-provider pattern, like Terraform). The blog and code pages
// list published Docker content, with detail pages, as every provider's do
// (#776); a page whose content is still to be written is a placeholder.
const DockerLandingPage = lazyPage(() => import('@/pages/docker/LandingPage'));
const DockerBlogPage = lazyPage(() => import('@/pages/docker/BlogPage'));
const DockerCodePage = lazyPage(() => import('@/pages/docker/CodePage'));
const DockerEducationPage = lazyPage(() => import('@/pages/docker/EducationPage'));
const DockerRssPage = lazyPage(() => import('@/pages/docker/RssPage'));
const DockerSandboxesPage = lazyPage(() => import('@/pages/docker/SandboxesPage'));
const DockerBuildingImagesPage = lazyPage(() => import('@/pages/docker/BuildingImagesPage'));
const DockerDesktopPage = lazyPage(() => import('@/pages/docker/DesktopPage'));
const DockerToolsPage = lazyPage(() => import('@/pages/docker/ToolsPage'));

// Coder Corner (shared public list page)
const ProviderCoderCornerPage = lazyPage(
  () => import('@/components/shared/ProviderCoderCornerPage')
);

// Cloud Tools
const ToolsMigrationPage = lazyPage(() => import('@/pages/tools/MigrationPage'));
const ToolsNetworkAssessmentPage = lazyPage(() => import('@/pages/tools/NetworkAssessmentPage'));
const ToolsCloudAssessmentPage = lazyPage(() => import('@/pages/tools/CloudAssessmentPage'));
const ToolsComparisonPage = lazyPage(() => import('@/pages/tools/ComparisonPage'));
const ToolsResourcesPage = lazyPage(() => import('@/pages/tools/ResourcesPage'));
const ToolsDecisionsPage = lazyPage(() => import('@/pages/tools/DecisionsPage'));
const ToolsLandingZonePage = lazyPage(() => import('@/pages/tools/LandingZonePage'));

// Templates
const FrameworkSubmissionPage = lazyPage(
  () => import('@/pages/submissions/FrameworkSubmissionPage')
);
const ArchitectureSubmissionPage = lazyPage(
  () => import('@/pages/submissions/ArchitectureSubmissionPage')
);
const BlogSubmissionPage = lazyPage(() => import('@/pages/submissions/BlogSubmissionPage'));
const CoderCornerSubmissionPage = lazyPage(
  () => import('@/pages/submissions/CoderCornerSubmissionPage')
);
const ArchitectureDetailTemplate = lazyPage(
  () => import('@/components/templates/ArchitectureDetailTemplate')
);
const FrameworkDetailTemplate = lazyPage(
  () => import('@/components/templates/FrameworkDetailTemplate')
);
const BlogDetailTemplate = lazyPage(() => import('@/components/templates/BlogDetailTemplate'));
const PreviewPage = lazyPage(() => import('@/pages/PreviewPage'));
const NewsletterConfirmPage = lazyPage(() => import('@/pages/NewsletterConfirmPage'));
const RosettaStoneSubmissionPage = lazyPage(
  () => import('@/pages/submissions/RosettaStoneSubmissionPage')
);

// Admin
const AdminAuthGuard = lazyPage(() => import('@/pages/admin/AdminAuthGuard'));
// The Entra redirect target (#520). Lazy like every other page, so the public
// bundle does not carry it — and it is the only route that touches MSAL
// outside /admin.
const AuthCallbackPage = lazyPage(() => import('@/pages/AuthCallbackPage'));
const AdminLayout = lazyPage(() => import('@/pages/admin/AdminLayout'));
const AdminDashboardPage = lazyPage(() => import('@/pages/admin/DashboardPage'));
const AdminDraftsPage = lazyPage(() => import('@/pages/admin/DraftsPage'));
const AdminQueuePage = lazyPage(() => import('@/pages/admin/QueuePage'));
const AdminReviewPage = lazyPage(() => import('@/pages/admin/ReviewPage'));
const AdminEditorPage = lazyPage(() => import('@/pages/admin/EditorPage'));
const AdminEditorListPage = lazyPage(() => import('@/pages/admin/EditorListPage'));
const AdminSubmitUrlsPage = lazyPage(() => import('@/pages/admin/SubmitUrlsPage'));
const AdminPublishedPage = lazyPage(() => import('@/pages/admin/PublishedPage'));
const AdminLivePagesPage = lazyPage(() => import('@/pages/admin/LivePagesPage'));
const AdminCalendarPage = lazyPage(() => import('@/pages/admin/CalendarPage'));
const AdminImagePromptsPage = lazyPage(() => import('@/pages/admin/ImagePromptsPage'));
const AdminImageGalleryPage = lazyPage(() => import('@/pages/admin/ImageGalleryPage'));
const AdminHealthPage = lazyPage(() => import('@/pages/admin/HealthPage'));
const AdminPlatformSettingsPage = lazyPage(() => import('@/pages/admin/PlatformSettingsPage'));
const AdminFrameworksPage = lazyPage(() => import('@/pages/admin/FrameworksPage'));
const AdminCoderCornerPage = lazyPage(() => import('@/pages/admin/CoderCornerPage'));
const AdminSpeakingEventsPage = lazyPage(() => import('@/pages/admin/SpeakingEventsPage'));
const AdminCertificationsPage = lazyPage(() => import('@/pages/admin/CertificationsPage'));
const AdminSocialHubPage = lazyPage(() => import('@/pages/admin/SocialHubPage'));
const AdminRecordingHubPage = lazyPage(() => import('@/pages/admin/RecordingHubPage'));
const AdminAIEnginePage = lazyPage(() => import('@/pages/admin/AIEnginePage'));
const AdminServiceDocsPage = lazyPage(() => import('@/pages/admin/ServiceDocsPage'));
const AdminMcpOAuthCallbackPage = lazyPage(() => import('@/pages/admin/McpOAuthCallbackPage'));
const AdminForgeStudioPage = lazyPage(() => import('@/pages/admin/ForgeStudioPage'));
const AdminLinkiePage = lazyPage(() => import('@/pages/admin/LinkiePage'));
const AdminMailingListPage = lazyPage(() => import('@/pages/admin/MailingListPage'));
const AdminIntegrationsPage = lazyPage(() => import('@/pages/admin/IntegrationsPage'));
const AdminLabsPage = lazyPage(() => import('@/pages/admin/LabsPage'));
const AdminListenAndLearnPage = lazyPage(() => import('@/pages/admin/ListenAndLearnPage'));
const AdminAmbassadorPage = lazyPage(() => import('@/pages/admin/AmbassadorPage'));

// Placeholder loader
// Shown on every lazy route. It was a bare spinning div: no role, no
// accessible name, so the wait between routes was silent as well as
// unfocused (T-740). `role="status"` is implicitly aria-live="polite", which
// is what a loading indicator wants — it should not interrupt.
const PageLoader = () => (
  <div className="flex items-center justify-center min-h-[50vh]" role="status">
    <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-slate-blue" />
    <span className="sr-only">Loading page…</span>
  </div>
);

/**
 * A failed dynamic import, as the browsers and bundlers word it, against a
 * runtime exception in a page. The two want different advice: a stale chunk
 * is fixed by a reload, a render error is not, and the boundary used to blame
 * stale chunks for both (AP-F7, #931).
 *
 * @param {unknown} error
 * @returns {boolean}
 */
export function isChunkLoadError(error) {
  if (!error) return false;
  // The name webpack-style loaders give it, matched exactly; then the
  // sentences Vite, Chromium, Firefox and Safari use for a failed dynamic
  // import, each anchored to its own shape so a runtime error that happens
  // to mention a chunk ("Loading chunk of report failed") is not read as one
  // (review on #1170).
  if (error.name === 'ChunkLoadError') return true;
  const message = String(error.message ?? '');
  return (
    /^Loading (?:CSS )?chunk [\w-]+ failed/i.test(message) ||
    /^Failed to fetch dynamically imported module/i.test(message) ||
    /^Importing a module script failed/i.test(message) ||
    /^error loading dynamically imported module/i.test(message)
  );
}

/**
 * Catches a render error below the router.
 *
 * It RESETS WHEN THE PATH CHANGES (AP-F7, #931). Before, one render error on
 * any admin route kept the failure card on every admin route until a hard
 * refresh, because the flag was set once and never cleared; the menu kept
 * working and every item led to the same card. Keyed on `pathname` through
 * `componentDidUpdate` rather than a `key` on the element, so an ordinary
 * navigation does not remount the routes.
 */
export class RouteErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error: error ?? new Error('Unknown render error') };
  }

  componentDidUpdate(prevProps) {
    if (this.state.error && prevProps.pathname !== this.props.pathname) {
      this.setState({ error: null });
    }
  }

  render() {
    if (!this.state.error) {
      return this.props.children;
    }

    const { isAdminRoute } = this.props;
    const { error } = this.state;
    const chunk = isChunkLoadError(error);

    return (
      <div className="flex min-h-[50vh] items-center justify-center px-4 py-10">
        <div
          className="w-full max-w-lg rounded-lg border bg-card p-6 text-card-foreground shadow-sm"
          role="alert"
        >
          <h2 className="text-xl font-semibold">
            {chunk ? 'Page load failed' : 'This page hit an error'}
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">
            {chunk
              ? 'A required module failed to load. This is usually an out-of-date cached page referencing old build chunks; a hard refresh fetches the current ones.'
              : 'The page could not be drawn. Open another page from the menu; this one is tried again when you come back to it.'}
          </p>
          {isAdminRoute && !chunk && error?.message && (
            // The message is for the admin who can act on it; public routes
            // keep the generic line. A render error's text names components,
            // not secrets.
            <p className="mt-2 break-words rounded bg-muted px-2 py-1 font-mono text-xs">
              {String(error.message).slice(0, 300)}
            </p>
          )}
          {isAdminRoute && (
            <div className="mt-4">
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 sm:w-auto"
              >
                {chunk ? 'Hard Refresh Admin' : 'Reload this page'}
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }
}

/**
 * The site's one route table: the public pages, the auth callback, the guarded
 * admin pages under /admin and, beside them, the old admin paths that redirect
 * to the renamed ones (config/adminRedirects.jsx).
 */
function App() {
  const location = useLocation();
  // NOTHING REACHES MSAL FROM HERE ANY MORE (#531).
  //
  // Auth ROUTING still lives in this file — `/auth/callback` is declared below,
  // from the shared AUTH_REDIRECT_PATH. What is gone is auth CODE running on
  // every render of every route.
  //
  // `useAuthRedirectLanding()` used to sit on this line, mounted on every route
  // in the application — including every anonymous visit to a provider news
  // page — so that a regex could watch `window.location.hash` for an auth
  // fragment that only ever appeared on one. It existed because `redirectUri`
  // was `window.location.origin`, so Entra returned the browser to the public
  // home page, which had never touched MSAL.
  //
  // #520 gave sign-in its own route, and the API registration's bare-origin
  // redirect URIs were cleared on 2026-09-12, so a fragment can no longer land
  // on `/` at all. The 2026-08-23 incident the hook documented lives on in
  // `pages/AuthCallbackPage.jsx`.
  const [, firstSegment] = location.pathname.split('/');
  const provider = VALID_PROVIDERS.includes(firstSegment) ? firstSegment : null;
  const isAdminRoute = firstSegment === 'admin';

  return (
    <div
      className={`min-h-screen flex flex-col relative bg-background text-foreground ${
        provider ? `theme-${provider}` : ''
      }`}
    >
      <div className="fixed inset-0 w-full h-full bg-grid-pattern -z-20 opacity-20 dark:opacity-50"></div>

      {!isAdminRoute && <Header />}

      <ScrollToTop />
      {/*
        Route-change announcer (T-740). ScrollToTop writes the new document
        title here after each navigation; `aria-live="polite"` makes a screen
        reader read it without interrupting whatever it is saying. It must be
        in the DOM from first render and stay mounted — a live region added at
        the same moment its text changes is not reliably announced.

        `sr-only` rather than `hidden` or `display: none`, which would remove
        it from the accessibility tree and silence it.
      */}
      <div
        id="route-announcer"
        className="sr-only"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      />
      <main id="main-content" tabIndex={-1} className="grow">
        <RouteErrorBoundary isAdminRoute={isAdminRoute} pathname={location.pathname}>
          <Suspense fallback={<PageLoader />}>
            <Routes>
              {/* --- Root & Shared --- */}
              <Route path="/" element={<HomePage />} />
              <Route path="/about" element={<AboutPage />} />
              <Route path="/contact" element={<ContactPage />} />
              {/* Cross-provider Learn index. A static first segment outranks
                  `/:provider` in route ranking, so this wins over the provider
                  layout the same way `/preview/:id` and `/tools/*` do. */}
              <Route path="/education" element={<EducationIndexPage />} />
              {/* The browser labs page (#681). Static like `/education`, and for
                  the same reason: it must beat `/:provider/education`. */}
              <Route path="/education/labs" element={<LabsLearnPage />} />
              {/* One lab's workspace, in a pane (#751). Two static segments
                  outrank `/:provider/*`; an id the catalogue does not have
                  goes back to `/education/labs`. Pre-rendered per catalogue
                  row in scripts/prerender-entry.jsx. */}
              <Route path="/education/labs/:labId" element={<LabPanePage />} />
              {/* --- Provider Routes (Wrapped in ProviderLayout) --- */}
              <Route path="/:provider" element={<ProviderLayout />}>
                <Route index element={<ProviderLandingDispatcher />} />
                {/* Shared paths across providers */}
                <Route path="blog" element={<ProviderBlogDispatcher />} />
                <Route path="blog/:slug" element={<ProviderBlogDetailDispatcher />} />
                <Route path="news/:slug" element={<ProviderNewsDetailDispatcher />} />
                <Route path="architecture-designs" element={<ProviderArchitectureDispatcher />} />
                <Route
                  path="architecture-designs/:slug"
                  element={<ProviderArchitectureDispatcher />}
                />
                <Route path="frameworks" element={<ProviderFrameworksDispatcher />} />
                <Route path="frameworks/:slug" element={<ProviderFrameworksDispatcher />} />
                <Route path="code" element={<ProviderCodeDispatcher />} />
                <Route path="code/:slug" element={<ProviderCodeDispatcher />} />
                <Route path="coder-corner" element={<ProviderCoderCornerDispatcher />} />
                <Route path="coder-corner/:slug" element={<ProviderCoderCornerDispatcher />} />
                <Route path="education" element={<ProviderEducationDispatcher />} />
                {/* A provider's labs under its Learn section (ADR 0033 §3): the
                    list and one lab's pane. Declared before `education/:certSlug`
                    so `labs` is never read as a certification slug (ADR 0033 §6
                    item 6); `/education/labs` above stays the cross-provider
                    index. Pre-rendered per provider and per lab in
                    scripts/prerender-entry.jsx. */}
                <Route path="education/labs" element={<LabsLearnPage />} />
                <Route path="education/labs/:labId" element={<LabPanePage />} />
                <Route path="education/:certSlug" element={<ProviderEducationDetailDispatcher />} />
                <Route
                  path="education/microcredentials/:mcSlug"
                  element={<ProviderMicrocredentialDetailDispatcher />}
                />
                <Route path="audio-architecture" element={<ProviderAudioDispatcher />} />
                <Route path="audio" element={<ProviderAudioDispatcher />} />
                <Route path="news" element={<ProviderRssDispatcher />} />
                <Route path="rss" element={<ProviderRssDispatcher />} />
                {/* Fallback for provider sub-routes */}
                <Route path="*" element={<NotFoundPage />} />
              </Route>
              {/*
                --- Dedicated Section Routes (FinOps, Terraform, Docker, GitHub) ---

                These are provider paths that have no cross-provider dispatcher,
                so they are declared statically.

                Three of them used to be DUPLICATES of routes the `/:provider`
                block above already served — `/finops/architecture-designs`,
                `/terraform/code`, `/github/code` — and were removed (T-762).
                Each rendered exactly the component its dispatcher renders, but
                a static path outranks `/:provider`, so the static one won and
                the dispatcher's matching branch was unreachable while its
                `:slug` sibling still ran: one URL family served by two code
                paths. Worse, the static declarations sit OUTSIDE
                `ProviderLayout`, so `useProvider()` was null on them and
                populated on the adjacent `/:provider` routes.

                Before adding one here, check whether the `/:provider` block
                already covers it. `App.routes.test.jsx` asserts no path is
                declared twice.
              */}
              {/* AWS Specifics */}
              {/* Azure Specifics */}
              {/* GCP Specifics */}
              {/* FinOps Specifics */}
              <Route path="/finops/tools" element={<FinOpsToolsPage />} />
              <Route path="/finops/focus" element={<FinOpsFocusPage />} />
              <Route path="/finops/architectures" element={<FinOpsArchitecturePage />} />
              {/* Terraform Specifics */}
              <Route path="/terraform/modules" element={<TerraformModulesPage />} />
              <Route path="/terraform/tools" element={<TerraformToolsPage />} />
              {/* Docker Specifics */}
              <Route path="/docker/sandboxes" element={<DockerSandboxesPage />} />
              <Route path="/docker/building-images" element={<DockerBuildingImagesPage />} />
              <Route path="/docker/desktop" element={<DockerDesktopPage />} />
              <Route path="/docker/tools" element={<DockerToolsPage />} />
              {/* GitHub Specifics */}
              <Route path="/github/workflows" element={<GitHubWorkflowsPage />} />
              <Route path="/github/tools" element={<GitHubToolsPage />} />
              {/* --- Cloud Tools --- */}
              <Route path="/tools/migration" element={<ToolsMigrationPage />} />
              <Route path="/tools/comparison" element={<ToolsComparisonPage />} />
              <Route path="/tools/resources" element={<ToolsResourcesPage />} />
              <Route path="/tools/decisions" element={<ToolsDecisionsPage />} />
              <Route path="/tools/landing-zone" element={<ToolsLandingZonePage />} />
              {/* AddOn panes (ADR 0035); one route per catalogue row */}
              <Route path="/tools/network-assessment" element={<ToolsNetworkAssessmentPage />} />
              <Route path="/tools/cloud-assessment" element={<ToolsCloudAssessmentPage />} />
              {/* --- Staging preview (T-606): signed-link view of unpublished
                  drafts. Static segment outranks /:provider in route ranking. --- */}
              <Route path="/preview/:id" element={<PreviewPage />} />
              {/* --- Newsletter double opt-in landing (#504): the signed link's
                  target. Static segments outrank /:provider. --- */}
              <Route path="/newsletter/confirm" element={<NewsletterConfirmPage />} />
              {/* --- Templates --- */}
              <Route path="/templates/framework" element={<FrameworkSubmissionPage />} />
              <Route path="/templates/architecture" element={<ArchitectureSubmissionPage />} />
              <Route path="/templates/blog" element={<BlogSubmissionPage />} />
              <Route path="/templates/coder-corner" element={<CoderCornerSubmissionPage />} />
              <Route path="/templates/rosetta-stone" element={<RosettaStoneSubmissionPage />} />
              {/* --- Entra sign-in redirect target (#520) --- */}
              <Route path={AUTH_REDIRECT_PATH} element={<AuthCallbackPage />} />

              {/* --- Admin CMS --- */}
              <Route
                path="/admin"
                element={
                  <AdminAuthGuard>
                    <AdminLayout />
                  </AdminAuthGuard>
                }
              >
                {/* Each page's segment is the slug of its menu label
                    (config/adminNav.js, AP-F13 #937); adminNav.test.js holds
                    the registry to that, adminRedirects.test.jsx holds this
                    table to the registry. */}
                <Route index element={<AdminDashboardPage />} />
                <Route path="drafts" element={<AdminDraftsPage />} />
                <Route path="review-queue" element={<AdminQueuePage />} />
                <Route path="review-queue/:blogId" element={<AdminReviewPage />} />
                <Route path="editor" element={<AdminEditorListPage />} />
                <Route path="editor/:blogId" element={<AdminEditorPage />} />
                <Route path="new-content" element={<AdminSubmitUrlsPage />} />
                <Route path="publish" element={<AdminPublishedPage />} />
                <Route path="live-pages" element={<AdminLivePagesPage />} />
                <Route path="calendar" element={<AdminCalendarPage />} />
                <Route path="frameworks" element={<AdminFrameworksPage />} />
                <Route path="coder-corner" element={<AdminCoderCornerPage />} />
                <Route path="speaking" element={<AdminSpeakingEventsPage />} />
                <Route path="certifications" element={<AdminCertificationsPage />} />
                <Route path="ambassador" element={<AdminAmbassadorPage />} />
                <Route path="image-prompts" element={<AdminImagePromptsPage />} />
                <Route path="image-gallery" element={<AdminImageGalleryPage />} />
                <Route path="platform-settings" element={<AdminPlatformSettingsPage />} />
                <Route path="health" element={<AdminHealthPage />} />
                <Route path="integrations" element={<AdminIntegrationsPage />} />
                <Route path="social-hub" element={<AdminSocialHubPage />} />
                <Route path="recording-hub" element={<AdminRecordingHubPage />} />
                <Route path="forge-studio" element={<AdminForgeStudioPage />} />
                <Route path="ai-engine" element={<AdminAIEnginePage />} />
                <Route path="ai-engine/docs/:serviceId" element={<AdminServiceDocsPage />} />
                {/* An MCP vendor's sign-in returns here (OAuth Connect, 2026-10-08). */}
                <Route path="ai-engine/oauth/callback" element={<AdminMcpOAuthCallbackPage />} />
                <Route path="linkie-hub" element={<AdminLinkiePage />} />
                <Route path="newsletter-hub" element={<AdminMailingListPage />} />
                {/* Every retired admin path, redirected with its query and
                    nested segment (config/adminRedirects.jsx). */}
                {adminLegacyRoutes()}
                <Route path="labs" element={<AdminLabsPage />} />
                <Route path="listen-and-learn" element={<AdminListenAndLearnPage />} />
                <Route path="*" element={<NotFoundPage />} />
              </Route>
              {/* Catch-All */}
              <Route path="*" element={<NotFoundPage />} />
            </Routes>
          </Suspense>
        </RouteErrorBoundary>
      </main>

      {!isAdminRoute && <Footer />}

      <DeferredChrome immediate={isAdminRoute} />
    </div>
  );
}

/**
 * The theme toggle, mounted once the browser is idle.
 *
 * The toaster used to mount here too, lazily, so a toast fired by an admin
 * page before the toaster's chunk arrived expired unseen (AP-F12, #936). No
 * public page fires a toast, so it is a static import of the admin shell
 * (pages/admin/AdminLayout.jsx) now and nothing of it is here.
 *
 * ITS OWN COMPONENT SO THE IDLE UPDATE CANNOT REACH THE ROUTE (#604). This
 * state used to live in `App`, and `setIdleReached` re-rendered `App` — the
 * parent of the route-level `<Suspense>`. On a pre-rendered page that boundary
 * is still dehydrated while its lazy page chunk is on the wire, and
 * `requestIdleCallback` routinely fires first. React 19 answers an update to a
 * dehydrated boundary it cannot hydrate yet by throwing the server HTML away
 * and client-rendering it — silently, with no `onRecoverableError` — so every
 * pre-rendered page, the home page included, lost its markup about 150 ms
 * after load. Here the update lands on a sibling of `<main>`, which leaves the
 * boundary's props untouched however slow the chunk is.
 *
 * Do not lift this state back into `App`, and do not add other mount-time
 * state updates there: anything that re-renders `App` before the page chunk
 * arrives has the same effect. e2e/hydration.spec.js tags a node inside
 * `<main>` to catch it.
 */
function DeferredChrome({ immediate }) {
  // Derived rather than synced from the effect below. Admin routes need the
  // deferred chrome immediately, and once idle time has been reached we keep it
  // on; expressing that as `immediate || idleReached` avoids calling setState
  // synchronously inside the effect, which triggers a cascading render.
  const [idleReached, setIdleReached] = useState(immediate);
  const show = immediate || idleReached;

  useEffect(() => {
    // Nothing to schedule on admin routes — `show` is already true.
    if (immediate) return undefined;

    let cancelled = false;
    let timeoutId = null;
    const activate = () => {
      if (!cancelled) setIdleReached(true);
    };

    if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
      const idleId = window.requestIdleCallback(activate, { timeout: 2000 });
      return () => {
        cancelled = true;
        window.cancelIdleCallback?.(idleId);
      };
    }

    timeoutId = window.setTimeout(activate, 1500);
    return () => {
      cancelled = true;
      if (timeoutId !== null) window.clearTimeout(timeoutId);
    };
  }, [immediate]);

  if (!show) return null;

  return (
    <>
      <Suspense fallback={null}>
        <ThemeToggleButton
          variant="outline"
          size="icon"
          className="fixed bottom-5 right-5 z-70 h-11 w-11 rounded-full border-border bg-background/90 text-foreground shadow-lg backdrop-blur supports-backdrop-filter:bg-background/75"
        />
      </Suspense>
    </>
  );
}

// --- Dispatch Components to handle /:provider/... rendering ---

function ProviderLandingDispatcher() {
  const { provider } = useParams();
  if (provider === 'aws') return <AWSLandingPage />;
  if (provider === 'azure') return <AzureLandingPage />;
  if (provider === 'gcp') return <GCPLandingPage />;
  if (provider === 'finops') return <FinOpsLandingPage />;
  if (provider === 'terraform') return <TerraformLandingPage />;
  if (provider === 'github') return <GitHubLandingPage />;
  if (provider === 'vmware') return <VMwareLandingPage />;
  if (provider === 'ansible') return <AnsibleLandingPage />;
  if (provider === 'docker') return <DockerLandingPage />;
  return <NotFoundPage />;
}

function ProviderBlogDispatcher() {
  const { provider } = useParams();
  if (provider === 'aws') return <AWSBlogPage />;
  if (provider === 'azure') return <AzureBlogPage />;
  if (provider === 'gcp') return <GCPBlogPage />;
  if (provider === 'finops') return <FinOpsBlogPage />;
  if (provider === 'terraform') return <TerraformBlogPage />;
  if (provider === 'github') return <GitHubBlogPage />;
  if (provider === 'vmware') return <VMwareBlogPage />;
  if (provider === 'ansible') return <AnsibleBlogPage />;
  if (provider === 'docker') return <DockerBlogPage />;
  return <NotFoundPage />;
}

// Every provider's articles and news items open in the one article template,
// so these two are a membership test rather than a branch per provider. They
// used to be nine identical `if` lines each, and the list is what matters:
// scripts/build-content-manifest.mjs pre-renders `/<provider>/blog/<slug>`
// for every provider in VALID_PROVIDERS, so a provider missing here would
// publish its articles as 404 pages (Docker's, until #776).
function ProviderBlogDetailDispatcher() {
  const { provider } = useParams();
  if (!VALID_PROVIDERS.includes(provider)) return <NotFoundPage />;
  return <BlogDetailTemplate provider={provider} />;
}

function ProviderNewsDetailDispatcher() {
  const { provider } = useParams();
  if (!VALID_PROVIDERS.includes(provider)) return <NotFoundPage />;
  return <BlogDetailTemplate provider={provider} section="news" />;
}

function ProviderArchitectureDispatcher() {
  // `slug` comes from the route pattern (`architecture-designs/:slug`), which is the
  // router's own answer to list-versus-detail. This used to sniff
  // `pathname.split('/').pop()` and compare it to the literal 'architecture-designs' —
  // a second, hand-rolled parse of information `useParams` already had, and
  // one that answers "detail" for any path whose last segment happens to
  // differ, including a trailing-slash variant (T-762).
  const { provider, slug } = useParams();
  const isDetail = Boolean(slug);

  if (provider === 'aws') {
    return isDetail ? <ArchitectureDetailTemplate provider="aws" /> : <AWSArchitecturePage />;
  }
  if (provider === 'azure') {
    return isDetail ? <ArchitectureDetailTemplate provider="azure" /> : <AzureArchitecturePage />;
  }
  if (provider === 'gcp') {
    return isDetail ? <ArchitectureDetailTemplate provider="gcp" /> : <GCPArchitecturePage />;
  }
  if (provider === 'finops') {
    return isDetail ? <ArchitectureDetailTemplate provider="finops" /> : <FinOpsArchitecturePage />;
  }
  if (provider === 'vmware') {
    return isDetail ? <ArchitectureDetailTemplate provider="vmware" /> : <VMwareArchitecturePage />;
  }
  return <NotFoundPage />;
}

function ProviderFrameworksDispatcher() {
  // `slug` comes from the route pattern (`frameworks/:slug`), which is the
  // router's own answer to list-versus-detail. This used to sniff
  // `pathname.split('/').pop()` and compare it to the literal 'frameworks' —
  // a second, hand-rolled parse of information `useParams` already had, and
  // one that answers "detail" for any path whose last segment happens to
  // differ, including a trailing-slash variant (T-762).
  const { provider, slug } = useParams();
  const isDetail = Boolean(slug);

  if (provider === 'aws') {
    return isDetail ? <FrameworkDetailTemplate provider="aws" /> : <AWSFrameworksPage />;
  }
  if (provider === 'azure') {
    return isDetail ? <FrameworkDetailTemplate provider="azure" /> : <AzureFrameworksPage />;
  }
  if (provider === 'gcp') {
    return isDetail ? <FrameworkDetailTemplate provider="gcp" /> : <GCPFrameworksPage />;
  }
  if (provider === 'finops') {
    return isDetail ? <FrameworkDetailTemplate provider="finops" /> : <FinOpsFrameworksPage />;
  }
  if (provider === 'vmware') {
    return isDetail ? <FrameworkDetailTemplate provider="vmware" /> : <VMwareFrameworksPage />;
  }
  return <NotFoundPage />;
}

function ProviderCodeDispatcher() {
  // `slug` comes from the route pattern (`code/:slug`), which is the
  // router's own answer to list-versus-detail. This used to sniff
  // `pathname.split('/').pop()` and compare it to the literal 'code' —
  // a second, hand-rolled parse of information `useParams` already had, and
  // one that answers "detail" for any path whose last segment happens to
  // differ, including a trailing-slash variant (T-762).
  const { provider, slug } = useParams();
  const isDetail = Boolean(slug);

  if (provider === 'github') {
    return isDetail ? <BlogDetailTemplate provider="github" section="code" /> : <GitHubCodePage />;
  }
  if (provider === 'terraform') {
    return isDetail ? (
      <BlogDetailTemplate provider="terraform" section="code" />
    ) : (
      <TerraformCodePage />
    );
  }
  if (provider === 'ansible') {
    return isDetail ? (
      <BlogDetailTemplate provider="ansible" section="code" />
    ) : (
      <AnsibleCodePage />
    );
  }
  if (provider === 'docker') {
    return isDetail ? <BlogDetailTemplate provider="docker" section="code" /> : <DockerCodePage />;
  }

  return <NotFoundPage />;
}

function ProviderCoderCornerDispatcher() {
  const { provider, slug } = useParams();
  if (!VALID_PROVIDERS.includes(provider)) return <NotFoundPage />;
  if (slug) {
    return <BlogDetailTemplate provider={provider} section="coder-corner" />;
  }
  return <ProviderCoderCornerPage provider={provider} />;
}

function ProviderEducationDispatcher() {
  const { provider } = useParams();
  if (provider === 'aws') return <AWSEducationPage />;
  if (provider === 'azure') return <AzureEducationPage />;
  if (provider === 'gcp') return <GCPEducationPage />;
  if (provider === 'finops') return <FinOpsEducationPage />;
  if (provider === 'github') return <GitHubEducationPage />;
  if (provider === 'terraform') return <TerraformEducationPage />;
  if (provider === 'vmware') return <VMwareEducationPage />;
  if (provider === 'ansible') return <AnsibleEducationPage />;
  if (provider === 'docker') return <DockerEducationPage />;
  return <NotFoundPage />;
}

function ProviderEducationDetailDispatcher() {
  const { provider } = useParams();
  if (provider === 'aws') return <AWSCertDetailPage />;
  if (provider === 'azure') return <AzureCertDetailPage />;
  // Providers without dedicated cert-detail pages fall back to their
  // education hub instead of dead-ending on a 404.
  if (['gcp', 'finops', 'terraform', 'github', 'vmware', 'ansible', 'docker'].includes(provider)) {
    return <Navigate to={`/${provider}/education`} replace />;
  }
  return <NotFoundPage />;
}

function ProviderMicrocredentialDetailDispatcher() {
  const { provider } = useParams();
  if (provider === 'aws') return <AWSMicrocredentialDetailPage />;
  return <NotFoundPage />;
}

// One podcast page for every provider (#349). The aws, azure and gcp copies
// were the shared page with the colours inlined; they are now rows in its
// PROVIDER_META, and provider-coverage.test.js checks every provider routed
// here has one. Every provider is routed here, so this is a membership test
// rather than a branch per provider; Docker joined with #777, when it would
// have been the tenth identical `if`.
function ProviderAudioDispatcher() {
  const { provider } = useParams();
  if (!VALID_PROVIDERS.includes(provider)) return <NotFoundPage />;
  return <SharedPodcastPage />;
}

function ProviderRssDispatcher() {
  const { provider } = useParams();
  if (provider === 'aws') return <AWSRssPage />;
  if (provider === 'azure') return <AzureRssPage />;
  if (provider === 'gcp') return <GCPRssPage />;
  if (provider === 'finops') return <FinOpsRssPage />;
  if (provider === 'terraform') return <TerraformRssPage />;
  if (provider === 'github') return <GitHubRssPage />;
  if (provider === 'vmware') return <VMwareRssPage />;
  if (provider === 'ansible') return <AnsibleRssPage />;
  if (provider === 'docker') return <DockerRssPage />;
  return <NewsPage provider={provider} />;
}

/**
 * Everything the application needs that is NOT the router.
 *
 * Split out so the browser entry and the pre-render step share one list. They
 * mount different routers — `BrowserRouter` here, `StaticRouter` under Node —
 * and before this existed the only way to render the tree on a server was to
 * rebuild the provider stack alongside it, which is a copy that silently stops
 * matching the moment anyone adds a provider.
 */
export function AppProviders({ children }) {
  return <ThemeProvider>{children}</ThemeProvider>;
}

/** The routed application, without a router. The pre-render entry supplies its own. */
export { App };

function AppWrapper() {
  return (
    <AppProviders>
      <Router
        future={{
          v7_startTransition: true,
          v7_relativeSplatPath: true,
        }}
      >
        <App />
      </Router>
    </AppProviders>
  );
}

export default AppWrapper;
