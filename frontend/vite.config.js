import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { cfWebAnalyticsPlugin } from './scripts/cf-web-analytics.mjs';

function pickMarkdownChunk(id) {
  if (
    id.includes('react-markdown') ||
    id.includes('react-syntax-highlighter') ||
    id.includes('remark-') ||
    id.includes('rehype-') ||
    id.includes('refractor') ||
    id.includes('hast-') ||
    id.includes('mdast-') ||
    id.includes('micromark') ||
    id.includes('unified') ||
    id.includes('unist-') ||
    id.includes('vfile') ||
    id.includes('property-information') ||
    id.includes('comma-separated-tokens') ||
    id.includes('space-separated-tokens') ||
    id.includes('character-entities') ||
    id.includes('decode-named-character-reference')
  ) {
    return 'vendor-markdown';
  }
  return null;
}

/**
 * React's own runtime, claimed before any feature predicate runs (T-715).
 *
 * `manualChunks` assigns a module to the first chunk that claims it, and
 * rollup then places shared dependencies alongside whatever needs them. React's
 * jsx-runtime is needed by every component, so when `vendor-charts` was
 * evaluated first it captured the runtime — which made a 456 kB charting bundle
 * a STATIC dependency of the app entry. Every page, including ones with no
 * chart at all, modulepreloaded it.
 *
 * Pinning the runtime to its own chunk removes the mechanism rather than the
 * symptom: no feature chunk can capture it, whatever order the predicates run
 * in later.
 */
function pickReactChunk(id) {
  if (
    /node_modules\/(react|react-dom)\//.test(id) ||
    id.includes('node_modules/react/jsx-runtime') ||
    id.includes('node_modules/scheduler/')
  ) {
    return 'vendor-react';
  }
  return null;
}

function pickChartsChunk(id) {
  // node_modules only, and matched on package directory boundaries. The old
  // test was a bare `id.includes('d3')`, which matches any path containing
  // those two characters anywhere — an application file, a hashed asset name.
  if (!id.includes('node_modules/')) return null;
  // Split per library rather than one combined bundle (T-715). rolldown places
  // React's jsx-runtime alongside whichever of these chunks it likes, and the
  // entry needs jsx-runtime, so ONE of these chunks is unavoidably on the
  // critical path. Splitting decides how much rides along with it: a combined
  // chunk meant all 456 kB of recharts + chart.js + d3 were modulepreloaded on
  // every page, to render zero charts, because the chart components themselves
  // are lazily imported everywhere they are used.
  if (id.includes('node_modules/recharts/') || id.includes('node_modules/victory-vendor/')) {
    return 'vendor-recharts';
  }
  if (id.includes('node_modules/chart.js/') || id.includes('node_modules/react-chartjs-2/')) {
    return 'vendor-chartjs';
  }
  if (/node_modules\/d3(-[a-z-]+)?\//.test(id)) {
    return 'vendor-d3';
  }
  return null;
}

// https://vitejs.dev/config/

/**
 * Read a browser variable the same way the bundle will receive it.
 *
 * The injection loop below accepts a non-`VITE_` spelling as a fallback, so
 * `ENTRA_TENANT_ID` reaches `import.meta.env.VITE_ENTRA_TENANT_ID` exactly as
 * `VITE_ENTRA_TENANT_ID` does. `assertDeployConfig` read only the prefixed
 * spelling and would therefore have refused a deploy whose bundle was going to
 * be correct.
 *
 * Both sides now call this, so the check and the injection cannot disagree —
 * which is the actual fix. Two copies of one rule is what produced the bug.
 */
export function browserEnvValue(env = {}, key) {
  return (env[key] || env[key.replace('VITE_', '')] || '').trim();
}

/** Entra client and tenant ids are GUIDs. `common` is not one, and that is the point. */
const ENTRA_GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The nil UUID, which `msalConfig.js` uses as its "no tenant configured"
 * sentinel — kept in step with `NO_TENANT_CONFIGURED` there.
 *
 * It has to be rejected explicitly, because it satisfies ENTRA_GUID: without
 * this the validator would wave through the one value the runtime chose
 * precisely because it can never authenticate anyone, and a deploy build would
 * ship an authority guaranteed to fail. The two halves must agree, and this is
 * the line that makes them.
 */
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/**
 * Everything a deploy build must have before it is allowed to produce a bundle.
 *
 * WHY THIS EXISTS (#516). `msalConfig.js` used to default the authority to
 * `common` when `VITE_ENTRA_TENANT_ID` was empty, so a deploy build with the
 * Entra variables unset succeeded and shipped a sign-in page pointed at every
 * Entra tenant on earth plus personal Microsoft accounts. The backend has had
 * this instinct since it was written — `verify-token.js` refuses to start
 * without its two settings, and `infra/variables.tf` rejects an empty audience
 * because an empty one SILENTLY DISABLES audience validation. The client half
 * never got it.
 *
 * SHAPE, NOT PRESENCE. A presence check would have caught neither live failure
 * mode: `.env.example` recommended `common` for the tenant and `.default` for
 * the scope, so the values most likely to be pasted in are non-empty and wrong.
 * A GUID test rejects empty, `common`, `organizations` and `consumers` in one
 * rule.
 *
 * EVERY PROBLEM AT ONCE. Throwing on the first means three deploy attempts to
 * learn about three missing variables.
 *
 * Exported so it can be tested directly. Do NOT test this by invoking the
 * config factory: that calls `loadEnv(mode, process.cwd(), '')`, so a
 * developer's local `frontend/.env` would leak into the assertion and the
 * result would depend on whose machine it ran on.
 *
 * @param {Record<string, string|undefined>} env  The merged environment.
 * @returns {void} Throws with every problem listed when the build must not proceed.
 */
export function assertDeployConfig(env = {}) {
  const problems = [];

  // Trimmed like every other check here. An all-whitespace value is how a
  // variable set from a broken shell expansion arrives, and untrimmed it is
  // truthy — so it would pass this gate and be baked into the bundle.
  if (!browserEnvValue(env, 'VITE_AZURE_FUNCTIONS_URL')) {
    problems.push(
      'VITE_AZURE_FUNCTIONS_URL is required for a deploy build. Set it to "/api" ' +
        'for a same-origin deployment, or to the Function App origin followed by ' +
        '"/api" for a cross-origin one.'
    );
  }

  // Same rule, different advice. The multi-tenant authorities are a tenant
  // mistake and nobody ever types "common" as a client id, so sharing one
  // message would send whoever broke the client id chasing the wrong thing.
  const GUID_ADVICE = {
    VITE_ENTRA_TENANT_ID:
      'A multi-tenant authority such as "common", "organizations" or "consumers" is not ' +
      'valid here: the API pins one tenant by issuer, so those only produce a sign-in ' +
      'that succeeds and then 401s on every call.',
    VITE_ENTRA_CLIENT_ID:
      'Use the Application (client) ID of the SPA app registration, copied from the ' +
      'Entra portal — not the display name, and not the API scope it requests.',
  };

  for (const key of ['VITE_ENTRA_CLIENT_ID', 'VITE_ENTRA_TENANT_ID']) {
    const value = browserEnvValue(env, key);
    if (!ENTRA_GUID.test(value) || value.toLowerCase() === NIL_UUID) {
      problems.push(
        `${key} must be a GUID for a deploy build; got ${value ? `"${value}"` : '(empty)'}. ` +
          GUID_ADVICE[key]
      );
    }
  }

  // Deliberately not rejecting `/.default`: it is a real, working delegated
  // request shape against Entra, just not the one this registration is built
  // around. The lever for that is the documentation, not the build.
  // The prefix alone is not a scope: `api://` names no resource and no
  // permission, so require something after it rather than accepting a value
  // that is well-formed and useless.
  const scope = browserEnvValue(env, 'VITE_ENTRA_API_SCOPE');
  if (!/^api:\/\/.+/.test(scope)) {
    problems.push(
      `VITE_ENTRA_API_SCOPE must start with "api://" for a deploy build; got ${
        scope ? `"${scope}"` : '(empty)'
      }. A Graph scope such as User.Read produces a token this API rejects on audience.`
    );
  }

  if (problems.length) {
    throw new Error(
      `Deploy build refused — ${problems.length} configuration problem(s):\n  - ${problems.join(
        '\n  - '
      )}`
    );
  }
}

export default defineConfig(({ mode }) => {
  // Load environment variables.
  // 1. System environment variables (process.env)
  // 2. Variables from the current secrets path
  // 3. Variables from legacy infrastructure path
  // 4. Standard Vite .env files in workspace root
  const secretsEnvDir = path.resolve(import.meta.dirname, 'secrets/env');
  const infrastructureEnvDir = path.resolve(import.meta.dirname, 'infrastructure/secrets/env');
  const env = {
    ...process.env,
    ...loadEnv(mode, secretsEnvDir, ''), // Current custom path (all vars)
    ...loadEnv(mode, infrastructureEnvDir, ''), // Legacy custom path (all vars)
    ...loadEnv(mode, process.cwd(), ''), // Load from root (standard Vite behavior)
  };

  // Browser configuration that must survive the custom secrets directories
  // above. Vite only reads .env files from its own envDir, so anything sourced
  // from secrets/env has to be injected explicitly here.
  //
  // The Firebase variables that used to occupy this list are gone: no file
  // under src/ reads them any more. VITE_GCP_FUNCTIONS_URL is gone with them —
  // the API base is VITE_AZURE_FUNCTIONS_URL, resolved in lib/functionsBase.js.
  const browserEnvVars = [
    'VITE_AZURE_FUNCTIONS_URL',
    'VITE_ENTRA_CLIENT_ID',
    'VITE_ENTRA_TENANT_ID',
    'VITE_ENTRA_API_SCOPE',
    'VITE_SOCIAL_X_URL',
    'VITE_SOCIAL_LINKEDIN_URL',
    'VITE_SOCIAL_GITHUB_URL',
    'VITE_DEFAULT_LANGUAGE',
    'VITE_TRANSLATIONS',
    // Public by design: the site key of the lab's Turnstile widget
    // (src/lib/turnstile.js). Absent, "Validate on the lab" says so.
    'VITE_TURNSTILE_SITE_KEY',
  ];

  // Create define object with fallbacks for non-prefixed versions just in case
  const defineConf = {};
  browserEnvVars.forEach((key) => {
    // Try VITE_ prefixed first, then try same name without VITE_ prefix as fallback
    defineConf[`import.meta.env.${key}`] = JSON.stringify(browserEnvValue(env, key));
  });

  // REQUIRE_API_BASE means "this is a deploy build". The name is now narrower
  // than the job — it gates the Entra variables too (#516) — and it is kept
  // anyway, deliberately. Renaming it is fail-OPEN: deploy-azure-frontend.yml
  // is what sets it, so a rename landing without the matching workflow edit
  // would silently stop every check below on every deploy, with nothing going
  // red. A slightly stale name is the cheaper mistake.
  //
  // Plain CI builds leave it unset and stay green without any backend secrets.
  if (process.env.REQUIRE_API_BASE === 'true') {
    assertDeployConfig(env);
  }

  // Log injected keys (NOT values) to help debug CI issues
  console.log('--- CI/CD Build Config ---');
  console.log('Mode:', mode);
  console.log(
    'Injected VITE keys:',
    Object.keys(defineConf)
      .map((k) => k.split('.').pop())
      .filter((k) => defineConf[`import.meta.env.${k}`] !== '""')
      .join(', ') || 'None!'
  );
  console.log('--------------------------');

  return {
    plugins: [
      react(),
      // The Cloudflare Web Analytics beacon, in index.html only when the
      // repository variable is set (#1302). Not in `browserEnvVars`: no module
      // reads it, so it has no business in the bundle — it lives in the HTML
      // and nowhere else. scripts/cf-web-analytics.mjs says why it is whole or
      // absent and why its shape is checked.
      cfWebAnalyticsPlugin(browserEnvValue(env, 'VITE_CF_WEB_ANALYTICS_TOKEN')),
    ],
    logLevel: mode === 'production' ? 'warn' : 'info',
    resolve: {
      alias: {
        '@': path.resolve(import.meta.dirname, './src'),
      },
    },
    define: defineConf,
    // Build optimization
    build: {
      rollupOptions: {
        output: {
          manualChunks(id) {
            // React first, always. Order is load-bearing here: whichever
            // predicate claims the shared runtime pulls its whole chunk onto
            // the entry's static import graph (T-715).
            const reactChunk = pickReactChunk(id);
            if (reactChunk) return reactChunk;
            const markdownChunk = pickMarkdownChunk(id);
            if (markdownChunk) return markdownChunk;
            const chartsChunk = pickChartsChunk(id);
            if (chartsChunk) return chartsChunk;
            if (id.includes('node_modules')) {
              if (id.includes('@radix-ui')) {
                return 'vendor-radix';
              }
              // framer-motion v13 ships its engine as the separate motion-dom /
              // motion-utils packages. Matching only 'framer-motion' let ~337 kB
              // of engine fall through to the catch-all vendor chunk, which is
              // what pushed that chunk past the 500 kB warning threshold.
              if (
                id.includes('framer-motion') ||
                id.includes('node_modules/motion-dom/') ||
                id.includes('node_modules/motion-utils/')
              ) {
                return 'vendor-framer';
              }
              // MSAL is only reached on the admin/auth path, so it has no
              // business in the chunk every public route downloads.
              if (id.includes('node_modules/@azure/msal-')) {
                return 'vendor-msal';
              }
              if (id.includes('lucide-react')) {
                return 'vendor-lucide';
              }
              // Date / sanitization / interaction libs that aren't on every route.
              if (
                id.includes('date-fns') ||
                id.includes('dompurify') ||
                id.includes('react-zoom-pan-pinch')
              ) {
                return 'vendor-utils';
              }
              // fflate is reached only from the Landing Zone Builder's Download
              // zip click (#668), behind a dynamic import, so it gets its own
              // chunk rather than riding in the one every route downloads.
              if (id.includes('node_modules/fflate/')) {
                return 'vendor-zip';
              }
              if (id.includes('react-router')) {
                return 'vendor-router';
              }
              if (id.includes('react-hook-form')) {
                return 'vendor-forms';
              }
              // The React runtime: needed on every route, but it changes far
              // less often than application code, so it earns its own
              // long-lived cache entry. Anchored on the '/' package boundary so
              // it does not swallow other react-* packages.
              if (
                id.includes('node_modules/react/') ||
                id.includes('node_modules/react-dom/') ||
                id.includes('node_modules/scheduler/')
              ) {
                return 'vendor-react';
              }
              return 'vendor'; // all other node_modules
            }
          },
        },
      },
      // 'hidden' generates source maps without `//# sourceMappingURL=` refs
      // in the bundle output. Lighthouse's `valid-source-maps` audit passes
      // (maps exist), but the public bundle does NOT advertise them, so
      // browser DevTools won't auto-load the source. See GH #171.
      //
      // BUILT, AND NOT SERVED (AP-F11, #935). A map under dist is fetchable by
      // its hashed name whether or not a bundle points at it, and the deploy
      // uploads dist whole. So deploy-azure-frontend.yml moves every .map out
      // of dist before its payload check, keeps them for thirty days as the
      // run's `source-maps` artifact — enough to read a stack trace back
      // against the source — and refuses a dist with one left in it. A
      // deploy that finds no maps at all fails too: that step and this line
      // are two halves of one decision, and scripts/deploy-source-maps.test.js
      // holds them together.
      sourcemap: mode === 'development' ? true : 'hidden',
      minify: 'esbuild',
    },
  };
});
