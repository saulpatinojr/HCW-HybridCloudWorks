/**
 * What the API-keys page may seed, in the sections it presents.
 *
 * ## Why a list in code when `06-seed-secret.ps1` reads `infra/`
 *
 * That script runs on an operator's desktop with the repository checked out.
 * The Function App does not have the `infra/` module at run time, so the catalogue
 * has to travel in the bundle. A list in code can drift from Terraform, and
 * drift here is the specific failure Required-Inputs §4.5 describes: app settings are
 * `UPPER_SNAKE_CASE`, vault secrets are `UPPER-KEBAB-CASE` because Key Vault
 * forbids underscores, and a mismatch resolves to nothing. The app deploys
 * clean and a missing credential presents as missing *data*, days later, in a
 * feature nobody was looking at.
 *
 * So `secret-catalog.test.js` reads every `.tf` file in `infra/` (through
 * `test/terraform-source.js`) and asserts this table is
 * exactly the set of `@Microsoft.KeyVault(SecretUri=…secrets/NAME)` references
 * it declares, with the setting names paired as Terraform pairs them. Add a
 * reference without adding it here — or spell either name wrong — and CI fails
 * on a checkout with no Azure credentials and no Terraform binary. The page can
 * therefore never offer a secret the application cannot read.
 *
 * ## Why the page cannot invent a new name
 *
 * A secret with no `@Microsoft.KeyVault(…)` app setting pointing at it is
 * unreachable by application code — no setting, no environment variable,
 * nothing to read. Seeding one would put a live credential in the vault that
 * nothing consumes and nobody owns, which is how orphaned credentials happen.
 * Adding a *new* kind of key stays a code change, because the code has to learn
 * to read it in the same change.
 */

/**
 * Presentation sections, in display order.
 *
 * Grouped by what the reader is trying to do, not by vendor: someone fixing a
 * dead social post wants every social credential together, whichever companies
 * they belong to.
 */
export const SECRET_SECTIONS = Object.freeze([
  {
    id: "gen-ai",
    title: "Gen AI",
    blurb:
      "Language models. When something needs writing the site tries them in order, so removing " +
      "one changes which model writes your content. Each row says what it is used for.",
  },
  {
    id: "ai-services",
    title: "AI services",
    blurb:
      "Called for one job each — narration, cover images, and reading a web page well enough to summarise it.",
  },
  {
    id: "communication",
    title: "Communication",
    blurb:
      "Anything that speaks to an audience \u2014 posts, newsletters, links and alerts.",
  },
  {
    id: "content",
    title: "Content",
    blurb: "Where episodes, videos and recordings are published and read from.",
  },
  {
    id: "cloud",
    title: "Cloud",
    blurb:
      "Read the three clouds\u2019 PUBLIC price lists for the comparison tools. None of these bills " +
      "this site \u2014 that runs on Azure and is not charged through anything here.",
  },
  {
    id: "code-quality",
    title: "Code quality",
    blurb:
      "Read-only access to the repository’s scanner results, shown on the Health page.",
  },
  {
    id: "platform",
    title: "Site platform",
    blurb:
      "Values the site itself runs on. Changing one of these takes effect immediately and is " +
      "felt by visitors, so each says what it breaks.",
  },
  {
    id: "labs",
    title: "Hybrid Lab",
    blurb:
      "The browser workspaces learners open from the labs page, and the check that lets the " +
      "Landing Zone Builder send the lab a job. The site shows the workspaces’ status and links " +
      "to them, and never signs anyone in to them.",
  },
]);

/**
 * Every seedable secret.
 *
 * `setting` is the app-setting name (what `process.env` holds); `secret` is the
 * Key Vault secret name (what gets written). Both are asserted against
 * the `infra/` module. `probe` names the reporter whose verdict can turn this
 * light red.
 *
 * `null` is the honest default and most entries have it. A non-null probe is a
 * PROMISE that something reports this credential's health, and the page prints
 * "no liveness check for this one" beside a green light that has none. Three
 * things report today, all through `lib/key-verdict.js`, which is what
 * distinguishes a rejected credential (401/403) from a bad request:
 * `ai/router.js` for its four providers, the Publer client and proxy for BOTH
 * `PUBLER_API_KEY` and `PUBLER_WORKSPACE_ID` (#358), and the Telegram
 * connection probe for `TELEGRAM_BOT_TOKEN` (`integrations/connection-probe.js`).
 * Only those may carry a probe, and `secret-catalog.test.js` holds that.
 * Wiring a new reporter and setting a probe is one change, not two.
 *
 * The workspace id gained a probe on 2026-09-09, and the reason is worth
 * keeping: Publer answers 401 when the WORKSPACE ID is wrong and 403 when the
 * KEY is, which is the reverse of its own documentation and was measured
 * against the live API. Reporting both against the key meant a wrong workspace
 * id turned the key red, and two days went into reminting a key that was fine.
 * An identifier that can be wrong on its own, and that an upstream service
 * will tell you about, deserves its own light.
 */
export const SECRET_CATALOG = Object.freeze([
  // EVERY `help` BELOW IS WRITTEN FOR SOMEONE WHO HAS NEVER SEEN THIS
  // REPOSITORY. It reaches the API-keys page and nowhere else, so it says what
  // kind of value it is and what it does for the site — never an issue
  // number, an ADR section, a function name or a file path. The engineering
  // detail that used to live in these strings is in the comments beside them,
  // where it is still findable and no longer shown to someone trying to work
  // out which box to paste a key into.

  // ── Gen AI ───────────────────────────────────────────────────────
  {
    setting: "GEMINI_API_KEY",
    secret: "GEMINI-API-KEY",
    section: "gen-ai",
    label: "Google Gemini",
    // The Listen & Learn voice: Gemini TTS reads every study episode (ADR 0029
    // §2b). Its place in the writing order is the AI Engine page's, not this
    // text's — see the note above NVIDIA's entry.
    help: "API key. One of the models the site writes with, tried in the order set on the AI Engine page, and the voice that reads every Listen & Learn episode.",
    probe: "gemini",
  },
  {
    setting: "ANTHROPIC_API_KEY",
    secret: "ANTHROPIC-API-KEY",
    section: "gen-ai",
    label: "Anthropic",
    help: "API key. One of the models the site writes with, tried in the order set on the AI Engine page.",
    probe: "anthropic",
  },
  {
    setting: "OPENAI_API_KEY",
    secret: "OPENAI-API-KEY",
    section: "gen-ai",
    label: "OpenAI",
    help: "API key. One of the models the site writes with, tried in the order set on the AI Engine page.",
    probe: "openai",
  },
  {
    setting: "NVIDIA_API_KEY",
    secret: "NVIDIA-API-KEY",
    section: "gen-ai",
    label: "NVIDIA API",
    // #701. An `nvapi-` key from build.nvidia.com/settings/api-keys, trial
    // tier (~40 requests a minute). Placed per feature
    // (ai-config.js PROVIDER_PLACEMENT_DEFAULTS): the backup, 'order', for
    // owner-triggered content features since 2026-09-29 (#812), and locked
    // off for the anonymous public explain routes. Its verdicts are reported
    // by ai/router.js like the other three.
    //
    // NO HELP TEXT HERE NAMES A POSITION. Until 2026-09-29 these said Gemini
    // was "first", Anthropic "second" and OpenAI "third", while
    // DEFAULT_PROVIDER_ORDER put OpenAI before Anthropic, and NVIDIA's said it
    // wrote "first" the day it became the backup (#815). The order is
    // DEFAULT_PROVIDER_ORDER until the AI Engine page changes it, so a
    // position in this text is wrong the moment anyone reorders.
    // secret-catalog.test.js refuses one.
    help: "API key starting nvapi-. Free, rate-limited models: by default the backup for drafts, summaries and scripts, used when the models above cannot answer. The AI Engine page can make them the main writer for a feature. Never used on the public pages.",
    probe: "nvidia",
  },

  // ── AI services ───────────────────────────────────────────────────
  {
    setting: "ELEVENLABS_API_KEY",
    secret: "ELEVENLABS-API-KEY",
    section: "ai-services",
    label: "ElevenLabs",
    // The podcast voice ONLY — article and Plaud transcripts to Podbean
    // (ADR 0029 §2a, scoped by §2b); never Listen & Learn, which is Gemini
    // TTS. A re-minted key needs an app restart to take effect. On the free
    // plan from 2026-09-26 (§2a amended); the permissions are the three the
    // podcast needs (Voices → Read since #725, for the voice picker), see
    // docs/standards/required-inputs.md.
    help: "API key. Reads podcast episodes aloud. Create it restricted to Text to Speech (Access), User (Read) and Voices (Read), with a credit limit. Free plan: 10,000 credits a month, one per character, and free-plan episodes are not published.",
    probe: null,
  },
  {
    setting: "AZURE_SPEECH_KEY",
    secret: "AZURE-SPEECH-KEY",
    section: "ai-services",
    label: "Azure AI Speech",
    // Written and tested against the day the preview Gemini TTS models
    // retire. Deliberately unprovisioned; monitor-unresolved-secrets.yml
    // excludes it by name for that reason.
    help: "API key. A spare narrator, ready in case the main one stops being available. Not set up on purpose.",
    probe: null,
  },
  {
    setting: "FIRECRAWL_API_KEY",
    secret: "FIRECRAWL-API-KEY",
    section: "ai-services",
    label: "Firecrawl",
    help: "API key. Reads a web page and pulls out its text, so a link can be summarised.",
    probe: null,
  },
  {
    setting: "REPLICATE_API_KEY",
    secret: "REPLICATE-API-KEY",
    section: "ai-services",
    label: "Replicate",
    // A service that runs a model for you, not one of the three the site
    // chooses between when it needs writing. It sits with the other things
    // called for a single job.
    help: "API key. Generates the cover image for a post. Without it, posts use a stock image instead.",
    probe: null,
  },

  // ── Communication ───────────────────────────────────────────────
  {
    setting: "PUBLER_API_KEY",
    secret: "PUBLER-API-KEY",
    section: "communication",
    label: "Publer \u2014 API key",
    // Publer answers 403 when the KEY is wrong and 401 when the workspace id
    // is — the reverse of its own documentation, measured 2026-09-09 (#358).
    help: "API key. Lets the site schedule social posts through Publer. If Publer refuses with a 403, this is the value to check.",
    probe: "publer",
  },
  {
    setting: "PUBLER_WORKSPACE_ID",
    secret: "PUBLER-WORKSPACE-ID",
    section: "communication",
    label: "Publer \u2014 workspace id",
    help:
      "Identifier, not a secret. Which Publer workspace to post into. A 401 from Publer means " +
      "this value is wrong, not the key \u2014 copy it from Publer\u2019s API playground, because " +
      "the id on their settings page is a different number.",
    probe: "publer",
  },
  {
    setting: "RESEND_API_KEY",
    secret: "RESEND-API-KEY",
    section: "communication",
    label: "Resend — API key",
    // ADR 0030. Must be a FULL ACCESS key: a sending-access key can send one
    // email but cannot add contacts or create broadcasts, and the Integrations
    // page's beaker is what tells the two apart. No probe: Resend refuses both a
    // wrong key and a sending-only key, and only the first means remint.
    help:
      "API key, created with Full access. Holds the newsletter mailing list and sends the " +
      "newsletter. A key with Sending access only will not work.",
    probe: null,
  },
  {
    setting: "LINKIE_API_KEY",
    secret: "LINKIE-API-KEY",
    section: "communication",
    label: "Linkie",
    help: "API key. Manages the link-in-bio page and the links on it.",
    probe: null,
  },
  {
    setting: "TELEGRAM_BOT_TOKEN",
    secret: "TELEGRAM-BOT-TOKEN",
    section: "communication",
    label: "Telegram \u2014 bot token",
    // Rotating this INVALIDATES the registered webhook — re-run
    // scripts/cutover/04-telegram-webhook.ps1 afterwards.
    help:
      "Bot token. Sends the approve-or-reject messages for new content. Changing it stops those " +
      "messages until the bot is reconnected.",
    // The Integrations page's Telegram beaker calls getMe, which authenticates
    // on this token alone and answers 401 when it is wrong (#483). The chat id
    // below stays unprobed on purpose: getMe never reads it, so a success here
    // says nothing about it.
    probe: "telegram",
  },
  {
    setting: "TELEGRAM_CHAT_ID",
    secret: "TELEGRAM-CHAT-ID",
    section: "communication",
    label: "Telegram \u2014 chat id",
    help: "Identifier, not a secret. Which Telegram conversation those messages are sent to.",
    probe: null,
  },

  // ── Content ──────────────────────────────────────────────────────
  // Podbean's developer app (ADR 0029 §1c): a client-credentials pair the
  // publisher exchanges for a token. No `probe` here, for the reason the
  // test gives — the Integrations page's own beaker (connectionProbe
  // `podbean`) is the check for these two.
  {
    setting: "PODBEAN_CLIENT_ID",
    secret: "PODBEAN-CLIENT-ID",
    section: "content",
    label: "Podbean \u2014 client ID",
    help: "Identifier from your Podbean developer app (developers.podbean.com). Paired with the client secret.",
    probe: null,
  },
  {
    setting: "PODBEAN_CLIENT_SECRET",
    secret: "PODBEAN-CLIENT-SECRET",
    section: "content",
    label: "Podbean \u2014 client secret",
    help: "Publishes an approved episode to the podcast. Without it, episodes are published by hand in Podbean.",
    probe: null,
  },
  {
    setting: "STREAMYARD_API_KEY",
    secret: "STREAMYARD-API-KEY",
    section: "content",
    label: "StreamYard On-Air \u2014 API key",
    help:
      "API key from StreamYard (Team settings \u2192 Integrations \u2192 Zapier \u2192 Generate API key). " +
      "Authenticates webinar registration and attendance updates sent from StreamYard On-Air.",
    probe: null,
  },
  {
    setting: "YOUTUBE_API_KEY",
    secret: "YOUTUBE-API-KEY",
    section: "content",
    label: "YouTube Data API",
    // One certification costs ~505 of the default 10,000 daily quota units.
    help: "API key. Finds the \u201cwatch next\u201d videos shown beside each Listen & Learn episode.",
    probe: null,
  },
  {
    setting: "PLAUD_EMBEDDED_CLIENT_ID",
    secret: "PLAUD-EMBEDDED-CLIENT-ID",
    section: "content",
    label: "Plaud Embedded \u2014 client id",
    // A different credential from the Plaud MCP OAuth tokens the Connect tab
    // stores; sent as X-Client-Api-Key beside the key below (#442).
    help: "Identifier, not a secret. Names this site to Plaud when audio is sent for transcription.",
    probe: null,
  },
  {
    setting: "PLAUD_EMBEDDED_API_KEY",
    secret: "PLAUD-EMBEDDED-API-KEY",
    section: "content",
    label: "Plaud Embedded \u2014 API key",
    help:
      "API key. Turns an uploaded recording into text. Without it, the upload is refused before " +
      "any audio is stored.",
    probe: null,
  },

  // ── Cloud ────────────────────────────────────────────────────────
  {
    setting: "AWS_ACCESS_KEY_ID",
    secret: "AWS-ACCESS-KEY-ID",
    section: "cloud",
    label: "AWS \u2014 access key id",
    // Scope the IAM policy to pricing:GetProducts only.
    help: "Access key id. Reads Amazon\u2019s public price list for the cost comparison tools.",
    probe: null,
  },
  {
    setting: "AWS_SECRET_ACCESS_KEY",
    secret: "AWS-SECRET-ACCESS-KEY",
    section: "cloud",
    label: "AWS \u2014 secret access key",
    help: "The secret half of the AWS key above. The two are always changed together.",
    probe: null,
  },
  {
    setting: "GCP_BILLING_API_KEY",
    secret: "GCP-BILLING-API-KEY",
    section: "cloud",
    label: "Google Cloud Billing Catalog",
    // A restricted API key, which is what Google documents for this API.
    help:
      "API key. Reads Google\u2019s public price list. Without it the Google column disappears from " +
      "the comparison and the other two still work.",
    probe: null,
  },

  // ── Code quality ─────────────────────────────────────────────────
  {
    setting: "QLTY_API_TOKEN",
    secret: "QLTY-API-TOKEN",
    section: "code-quality",
    label: "Qlty — access token",
    help:
      "Personal access token from qlty.sh (User settings → Access tokens). Reads the " +
      "project’s open findings and metrics for the Health page’s Code and Security tab. " +
      "Without it that tab says Qlty is not configured and everything else still works.",
    probe: null,
  },

  // ── Site platform ────────────────────────────────────────────────
  {
    setting: "CF_ORIGIN_SECRET",
    secret: "CF-ORIGIN-SECRET",
    section: "platform",
    label: "Cloudflare origin secret",
    help:
      "Shared password. Proves a visitor reached the site through Cloudflare. It has to be " +
      "changed in Cloudflare at the same time \u2014 until both match, public form submissions are " +
      "refused.",
    probe: null,
  },
  {
    setting: "CLIENT_IP_SALT",
    secret: "CLIENT-IP-SALT",
    section: "platform",
    label: "Client IP salt",
    help:
      "Random value. Scrambles visitor addresses before they are counted, so nobody is tracked. " +
      "Changing it resets every rate limit \u2014 which is sometimes the point.",
    probe: null,
  },
  {
    setting: "PREVIEW_SIGNING_SECRET",
    secret: "PREVIEW-SIGNING-SECRET",
    section: "platform",
    label: "Preview signing secret",
    help:
      "Random value. Signs the private links used to preview unpublished pages. Changing it makes " +
      "every preview link already shared stop working.",
    probe: null,
  },
  // The read-only Cloudflare API token the monthly audience timer reads page
  // views with (#1302, lib/timers/ambassador-audience.js): Account →
  // Account Analytics → Read, and nothing else. The site tag and the account
  // id beside it are plain settings written by Terraform, not secrets. No
  // probe: nothing reports this credential's health between the monthly
  // runs, and a probe here would promise a light that nothing switches.
  {
    setting: "CLOUDFLARE_ANALYTICS_TOKEN",
    secret: "CLOUDFLARE-ANALYTICS-TOKEN",
    section: "platform",
    label: "Cloudflare analytics token",
    help:
      "Read-only API token, from the Cloudflare dashboard (My Profile, API Tokens, with the " +
      "Account Analytics Read permission only). Lets the site read its own monthly page-view " +
      "count for the Ambassador hub. Until it is set, no monthly audience figure is recorded.",
    probe: null,
  },

  // ── Hybrid Lab ───────────────────────────────────────────────────
  // An address rather than a credential, kept in the vault so the pair is
  // seeded through one procedure and watched by one monitor (ADR 0032
  // decision 4). Read by lib/labs/coder-status.js, which requires https: the
  // token beside it travels in a header.
  {
    setting: "CODER_URL",
    secret: "CODER-URL",
    section: "labs",
    label: "Coder address",
    help:
      "Web address, starting https://. Where the lab’s browser workspaces run. The site reads " +
      "their status from it and links visitors to it; until it is set the labs page says the lab " +
      "is not yet provisioned.",
    probe: null,
  },
  // Read-only in Coder: it can list templates and count running workspaces
  // and nothing else. Never reaches the browser.
  {
    setting: "CODER_STATUS_TOKEN",
    secret: "CODER-STATUS-TOKEN",
    section: "labs",
    label: "Coder status token",
    help:
      "Read-only API token. Lets the site list the lab’s templates and count running workspaces " +
      "for the labs page. It cannot start or change anything, and it is never shown to visitors.",
    probe: null,
  },
  // The token the visitor session broker acts in Coder with
  // (lib/labs/visitor-session.js, #1016; the sweepVisitorSessions timer uses it
  // too, #1403). Unlike the status token above it can CHANGE things: it makes
  // and deletes visitors' Coder users and workspaces. There is deliberately no
  // fallback to the status token (readBrokerConfig), so without this one the
  // broker is not configured. No probe: nothing reports this token's health
  // between sessions, and a probe here would promise a light nothing switches.
  {
    setting: "CODER_BROKER_TOKEN",
    secret: "CODER-BROKER-TOKEN",
    section: "labs",
    label: "Coder broker token",
    help:
      "API token the site uses to start and end visitors’ short lab sessions in Coder: it creates " +
      "and deletes their temporary Coder users and workspaces, so unlike the status token it can " +
      "change things. It is never shown to visitors. Until it is set, visitor lab sessions cannot " +
      "start and the clean-up timer has nothing to call Coder with.",
    probe: null,
  },
  // The secret half of the Turnstile widget the owner creates in the
  // Cloudflare dashboard (ADR 0032 decision 6, revised 2026-09-28). Read by
  // lib/labs/public-lock.js, which sends it to Cloudflare's siteverify and
  // nowhere else. The site key is public and is a build variable, not here.
  // The widget is not a Terraform resource because its secret would sit in
  // state (infra/frontend.tf).
  {
    setting: "TURNSTILE_SECRET_KEY",
    secret: "TURNSTILE-SECRET-KEY",
    section: "labs",
    label: "Cloudflare Turnstile — secret key",
    help:
      "Secret key of the lab’s Turnstile widget, from the Cloudflare dashboard (Turnstile, then " +
      "the widget’s settings). It proves a real browser on this site pressed Validate on the lab " +
      "in the Landing Zone Builder. Until it is set the builder says the lab’s browser check is " +
      "not configured, and the lab takes no public jobs.",
    probe: null,
  },
]);

/** Secrets that may be generated rather than pasted, and why only these. */
export const GENERATABLE_SECRETS = Object.freeze([
  // Both are values this estate INVENTS. Everything else is issued by an
  // upstream service, where a generated value is guaranteed wrong — and worse
  // than absent, because absent is a gray light and wrong is a green one.
  "PREVIEW-SIGNING-SECRET",
  "CLIENT-IP-SALT",
]);

const BY_SECRET = new Map(SECRET_CATALOG.map((entry) => [entry.secret, entry]));
const BY_SETTING = new Map(
  SECRET_CATALOG.map((entry) => [entry.setting, entry.secret]),
);

/**
 * App-setting name → Key Vault secret name.
 *
 * Through the catalogue, never by replacing underscores with hyphens. That
 * translation is right for every name here today and would still be the wrong
 * way to do it: the day a pair does not follow the pattern, a string transform
 * produces a plausible name for a secret that does not exist, and the caller
 * records a verdict against nothing. Returns null for an unknown setting.
 */
export function settingToSecret(setting) {
  return BY_SETTING.get(String(setting ?? "")) ?? null;
}

/** The catalogue entry for a vault secret name, or undefined. */
export function findBySecretName(name) {
  return BY_SECRET.get(String(name ?? ""));
}

/** Is this a secret the page is allowed to write? */
export function isSeedableSecret(name) {
  return BY_SECRET.has(String(name ?? ""));
}

/** May this secret be generated instead of pasted? */
export function isGeneratable(name) {
  return GENERATABLE_SECRETS.includes(String(name ?? ""));
}
