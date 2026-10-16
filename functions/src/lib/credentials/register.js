/**
 * The credential register: every credential the site, its workflows and the
 * lab host use, by NAME AND METADATA ONLY (#1026, owner approval 2026-10-08).
 *
 * ## Why one list
 *
 * The estate keeps credentials in a dozen places, and until now each place
 * knew only about itself: the Keys tab knew Key Vault, the Hybrid Lab card
 * knew the Coder tokens, a runbook knew the lab agent's certificate expires
 * after 730 days, TODO.md knew the Static Web Apps deployment token should be
 * reset every 90. Nothing could answer "what expires next, and is anything
 * renewing it". This list is that answer's input; `status.js` turns it and the
 * live dates into an age, an expiry and a state, Admin → Integrations →
 * Credentials shows it, and `reminders.js` turns the hand-only ones into rows
 * on the reminders sheet.
 *
 * ## What an entry is
 *
 *   id            stable, lower-case kebab, at most 53 characters, because a
 *                 reminder's id is `credential-<id>` and the sheet allows 64
 *   name          what the credential is called IN ITS STORE: the secret,
 *                 variable, vault key or file, so the owner can find it there
 *   store         one of CREDENTIAL_STORES below: where it lives
 *   consumer      what uses it
 *   issuer        who issues it: a vendor, a system, or this estate
 *   renewal       RENEWAL below: whether anything renews it
 *   lifetimeDays  where a fixed policy exists, the days between rotations:
 *                 a vendor's expiry or a rotation rule; null where none does
 *   source        where live dates come from (`status.js` resolveLive):
 *                 `secret` a Key Vault name in admin_config/secret_state,
 *                 `coder` a token the lab host reports in
 *                 admin_config/coder_automation, `mcpServer` an mcp_servers
 *                 document. Absent means only an owner-recorded date exists.
 *   rotate        one sentence on how it is rotated, for the reminder
 *
 * NEVER A VALUE. Nothing here, and nothing built from it, reads, holds or
 * returns a credential. The live sources are read for dates and states by
 * field name (`status.js`), and the one document this feature writes,
 * admin_config/credential_register, holds a date per credential.
 *
 * ## The Key Vault part cannot drift from the Keys tab
 *
 * Its rows are not written out here: they are BUILT from secret-catalog.js,
 * the list the Keys tab seeds and CI holds to the `infra/` module, with the
 * metadata below added by secret name. register.test.js holds the metadata to
 * exactly the catalogue's names, so a secret added to (or retired from) the
 * catalogue fails CI until the register says who issues it and whether
 * anything renews it.
 *
 * ## Where the rest came from
 *
 * docs/standards/required-inputs.md (§4.1 HCP Terraform, §4.3 the Actions and
 * Agents secrets, §4.4 environments, §4.7 the lab host),
 * docs/standards/variables-and-secrets.md, the `secrets.*` the workflows in
 * .github/workflows read, lab-host/README.md and the lab host roles' READMEs
 * (the 730-day certificates, the Coder rotation credential), TODO.md's
 * accepted risk for #834 (the 90-day deployment-token reset), and the MCP
 * servers that keep tokens (lib/ai/mcp-oauth.js, lib/timers/plaud-token.js).
 * Identifiers that are not credentials are left out, except in Key Vault,
 * where the register mirrors the catalogue whole.
 */

import { SECRET_CATALOG } from "../secret-catalog.js";

/**
 * Where a credential lives, in the order the tab lists them. `label` is what
 * the tab shows as the group heading.
 */
export const CREDENTIAL_STORES = Object.freeze(
  [
    { id: "key-vault", label: "Key Vault kv-site-prod-cus-01" },
    { id: "cosmos", label: "Cosmos mcp_servers" },
    { id: "github-actions", label: "GitHub Actions secret" },
    { id: "github-agents", label: "GitHub Agents secret" },
    {
      id: "github-environment",
      label: "GitHub environment (OIDC, no stored secret)",
    },
    { id: "tfc-azure", label: "HCP Terraform hcw/hcw-azure" },
    { id: "tfc-lab", label: "HCP Terraform hcw/hcw-lab" },
    { id: "azure", label: "Azure Static Web App" },
    { id: "entra", label: "Entra" },
    { id: "docker", label: "Docker Home" },
    { id: "lab-vault", label: "Lab host Ansible Vault" },
    { id: "lab-file", label: "Lab host file" },
    { id: "owner", label: "Owner’s password manager" },
  ].map(Object.freeze),
);

/**
 * Whether anything renews a credential.
 *
 *   self        nothing is stored to rotate: a federated or managed identity,
 *               or a certificate its server renews itself
 *   automation  a job in this estate renews it (a timer, the lab host)
 *   hand        only the owner can, by minting a new one and storing it
 *   none        not a credential: an identifier or an address that the Key
 *               Vault catalogue keeps beside one. The issue's vocabulary had
 *               the first three; an identifier is none of them, and calling it
 *               "hand" would ask the owner to rotate a chat id.
 */
export const RENEWAL = Object.freeze(["self", "automation", "hand", "none"]);

/**
 * The rotation rule for a hand-only credential whose issuer sets no expiry.
 *
 * The issue names Anthropic, the Telegram bot token, the two GitHub App
 * private keys and the Coder GitHub OAuth secret as credentials no API can
 * renew, and asks for a reminder for each; none of them expires, so a
 * reminder needs a rule to be due by. 180 days is that rule: the owner's
 * decision of 2026-10-09, on the review of #1039, which had proposed a year.
 * It lives here, in one constant, so changing it is one line.
 */
export const HAND_ROTATION_DAYS = 180;

/** The Static Web Apps deployment token's reset rule: TODO.md, accepted risk for #834. */
export const SWA_TOKEN_RESET_DAYS = 90;

/** The lab host's generated certificates: `labs_agent_certificate_days`, `vault_certificate_days`. */
export const LAB_CERTIFICATE_DAYS = 180;

/** What the lab host mints: a 90-day status token, a year-long rotation credential (lab-host/README.md). */
export const CODER_STATUS_TOKEN_DAYS = 90;
export const CODER_ROTATION_CREDENTIAL_DAYS = 365;

const KEYS_TAB_ROTATION =
  "Mint a new one from the issuer, paste it on Integrations → Keys, then revoke the old one.";

/**
 * The Key Vault metadata, by secret name. Every name the catalogue declares,
 * and no other: register.test.js holds the two to the same set.
 */
const KEY_VAULT_METADATA = Object.freeze({
  "GEMINI-API-KEY": {
    issuer: "Google AI Studio",
    consumer: "AI router; Listen & Learn narration",
  },
  "ANTHROPIC-API-KEY": {
    issuer: "Anthropic Console",
    consumer: "AI router",
    lifetimeDays: HAND_ROTATION_DAYS,
  },
  "OPENAI-API-KEY": { issuer: "OpenAI", consumer: "AI router" },
  "NVIDIA-API-KEY": {
    issuer: "NVIDIA API Catalog",
    consumer: "AI router, content features only",
  },
  "ELEVENLABS-API-KEY": { issuer: "ElevenLabs", consumer: "Podcast narration" },
  "AZURE-SPEECH-KEY": {
    issuer: "Azure AI Speech",
    consumer: "Listen & Learn spare narrator, not set up on purpose",
  },
  "FIRECRAWL-API-KEY": {
    issuer: "Firecrawl",
    consumer: "Link summaries for content research",
  },
  "REPLICATE-API-KEY": { issuer: "Replicate", consumer: "Post cover images" },
  "PUBLER-API-KEY": { issuer: "Publer", consumer: "Social publishing" },
  "PUBLER-WORKSPACE-ID": {
    issuer: "Publer",
    consumer: "Social publishing",
    renewal: "none",
  },
  "RESEND-API-KEY": {
    issuer: "Resend",
    consumer: "Newsletter list and sending",
  },
  "LINKIE-API-KEY": { issuer: "Linkie", consumer: "Link-in-bio page" },
  "TELEGRAM-BOT-TOKEN": {
    issuer: "Telegram BotFather",
    consumer: "Approvals, alerts and reminders on Telegram",
    lifetimeDays: HAND_ROTATION_DAYS,
    // The catalogue's own warning, which a rotation must not miss.
    rotate:
      "Revoke and reissue it in BotFather, paste it on Integrations → Keys, then re-run scripts/cutover/04-telegram-webhook.ps1: a new token invalidates the webhook.",
  },
  "TELEGRAM-CHAT-ID": {
    issuer: "Telegram",
    consumer: "Approvals, alerts and reminders on Telegram",
    renewal: "none",
  },
  "PODBEAN-CLIENT-ID": {
    issuer: "Podbean",
    consumer: "Podcast publishing",
    renewal: "none",
  },
  "PODBEAN-CLIENT-SECRET": {
    issuer: "Podbean",
    consumer: "Podcast publishing",
    rotate:
      "Rotate it by hand in Podbean's developer portal (developers.podbean.com), then paste the new secret on Integrations → Keys.",
  },
  "STREAMYARD-API-KEY": {
    issuer: "StreamYard",
    consumer:
      "StreamYard On-Air webinar registrants, newsletter sync and Telegram alerts",
  },
  "YOUTUBE-API-KEY": {
    issuer: "Google Cloud",
    consumer: "Listen & Learn “watch next” links",
  },
  "PLAUD-EMBEDDED-CLIENT-ID": {
    issuer: "Plaud Embedded",
    consumer: "Recording Hub upload transcription",
    renewal: "none",
  },
  "PLAUD-EMBEDDED-API-KEY": {
    issuer: "Plaud Embedded",
    consumer: "Recording Hub upload transcription",
  },
  // The id half of an access key pair: not secret, but it changes whenever
  // the secret half does, so it is rotated with it rather than never.
  "AWS-ACCESS-KEY-ID": {
    issuer: "AWS IAM",
    consumer: "Cloud price comparison (AWS)",
  },
  "AWS-SECRET-ACCESS-KEY": {
    issuer: "AWS IAM",
    consumer: "Cloud price comparison (AWS)",
  },
  "GCP-BILLING-API-KEY": {
    issuer: "Google Cloud",
    consumer: "Cloud price comparison (Google)",
  },
  "QLTY-API-TOKEN": {
    issuer: "Qlty",
    consumer: "Health Hub Code and Security tab",
  },
  "CF-ORIGIN-SECRET": {
    issuer: "This estate, shared with Cloudflare",
    consumer: "Origin lock for public form submissions",
    rotate:
      "Change it here and in the hcw-azure workspace variable cloudflare_origin_secret together: until both match, public submissions are refused.",
  },
  "CLIENT-IP-SALT": {
    issuer: "This estate (generated)",
    consumer: "Visitor rate limits",
    rotate: "Press Generate on Integrations → Keys. Every rate limit resets.",
  },
  "PREVIEW-SIGNING-SECRET": {
    issuer: "This estate (generated)",
    consumer: "Private preview links",
    rotate:
      "Press Generate on Integrations → Keys. Every preview link already shared stops working.",
  },
  "CODER-URL": {
    issuer: "Lab host",
    consumer: "Labs card and lab panes",
    renewal: "none",
  },
  "CODER-STATUS-TOKEN": {
    issuer: "Coder on the lab host",
    consumer: "Labs card: templates and the running count",
    // The lab host renews it (2026-10-08, lib/labs/coder-automation.js), and
    // says when the token it handed over expires.
    renewal: "automation",
    lifetimeDays: CODER_STATUS_TOKEN_DAYS,
    coder: "statusToken",
    rotate:
      'The lab host renews it daily once its rotation credential is seeded; by hand, mint one as lab-host/README.md, "The status token for the site", says and paste it on Integrations → Keys.',
  },
  "TURNSTILE-SECRET-KEY": {
    issuer: "Cloudflare Turnstile",
    consumer: "Landing Zone Builder “Validate on the lab”",
    rotate:
      "Rotate it in the widget’s settings in the Cloudflare dashboard and paste it on Integrations → Keys.",
  },
});

/** The Key Vault metadata's names, for register.test.js. */
export const KEY_VAULT_METADATA_NAMES = Object.freeze(
  Object.keys(KEY_VAULT_METADATA),
);

/** `kv-` and the secret's name in lower case: `kv-anthropic-api-key`. */
export const keyVaultCredentialId = (secret) =>
  `kv-${String(secret).toLowerCase()}`;

/**
 * One register row per catalogue secret, in the catalogue's order. A secret
 * the metadata does not name still gets a row, with the issuer unknown,
 * rather than leaving the register; the test is what refuses that state.
 */
function keyVaultEntries() {
  return SECRET_CATALOG.map((entry) => {
    const meta = KEY_VAULT_METADATA[entry.secret] ?? {};
    const renewal = meta.renewal ?? "hand";
    return {
      id: keyVaultCredentialId(entry.secret),
      name: entry.secret,
      store: "key-vault",
      consumer: meta.consumer ?? entry.label,
      issuer: meta.issuer ?? "Unknown",
      renewal,
      lifetimeDays: meta.lifetimeDays ?? null,
      source: meta.coder
        ? { secret: entry.secret, coder: meta.coder }
        : { secret: entry.secret },
      rotate: meta.rotate ?? (renewal === "none" ? null : KEYS_TAB_ROTATION),
    };
  });
}

/**
 * Everything outside Key Vault. Grouped by store, in CREDENTIAL_STORES order.
 * `lifetimeDays` is set only where a rule exists; the reminder-bearing ones
 * are the issue's list, each a `hand` credential with a rule.
 */
const OTHER_ENTRIES = [
  // ── Cosmos mcp_servers: OAuth tokens kept on the server documents ───────
  {
    id: "mcp-plaud",
    name: "mcp_servers/plaud (OAuth token pair)",
    store: "cosmos",
    consumer: "Recording Hub Plaud library; podcast scripts from recordings",
    issuer: "Plaud",
    // refreshPlaudToken, every 12 hours (lib/timers/plaud-token.js).
    renewal: "automation",
    lifetimeDays: null,
    source: { mcpServer: "plaud" },
    rotate:
      "Renewed every 12 hours; if it lapses, reconnect on the Recording Hub’s Connect tab.",
  },
  {
    id: "mcp-replicate",
    name: "mcp_servers/replicate-mcp (OAuth Connect)",
    store: "cosmos",
    consumer: "Replicate MCP tools in the AI Engine",
    issuer: "Replicate",
    renewal: "automation",
    lifetimeDays: null,
    source: { mcpServer: "replicate-mcp" },
    rotate:
      "Refreshed before it expires; if a refresh fails, press Connect on its card under AI Engine → MCP Servers.",
  },
  {
    id: "mcp-hostinger",
    name: "mcp_servers/hostinger-mcp (OAuth Connect)",
    store: "cosmos",
    consumer: "Hostinger MCP tools in the AI Engine",
    issuer: "Hostinger",
    renewal: "automation",
    lifetimeDays: null,
    source: { mcpServer: "hostinger-mcp" },
    rotate:
      "Refreshed before it expires; if a refresh fails, press Connect on its card under AI Engine → MCP Servers.",
  },

  // ── GitHub ──────────────────────────────────────────────────────────────
  {
    id: "gh-tfc-token",
    name: "TFC_TOKEN",
    store: "github-actions",
    consumer:
      "tfc-plan-check.yml; deploy-functions.yml’s apply-in-flight check",
    issuer: "HCP Terraform (team token)",
    renewal: "hand",
    lifetimeDays: null,
    rotate:
      "Create a team token in HCP Terraform, set it as the TFC_TOKEN secret, then delete the old one.",
  },
  {
    id: "gh-manifest-app-private-key",
    name: "MANIFEST_APP_PRIVATE_KEY",
    store: "github-actions",
    consumer:
      "publish-content-manifest.yml, update-avm-versions.yml, update-learn-catalogue.yml, update-version-floors.yml",
    issuer: "GitHub App (MANIFEST_APP_ID)",
    renewal: "hand",
    lifetimeDays: HAND_ROTATION_DAYS,
    rotate:
      "Generate a new private key on the GitHub App’s settings page, set it as MANIFEST_APP_PRIVATE_KEY, then delete the old key there.",
  },
  {
    id: "gh-copilot-review-app-private-key",
    name: "COPILOT_REVIEW_APP_PRIVATE_KEY",
    store: "github-agents",
    consumer:
      "copilot-setup-steps.yml: the GitHub MCP server Copilot code review reads with",
    issuer: "GitHub App HCW Copilot Review Reader",
    renewal: "hand",
    lifetimeDays: HAND_ROTATION_DAYS,
    rotate:
      "Generate a new private key on the App’s settings page, store it in the Agents store (docs/runbooks/copilot-code-review-mcp.md, step 4), then delete the old key.",
  },
  {
    id: "gh-oidc-production",
    name: "environment production → github_deploy",
    store: "github-environment",
    consumer: "deploy-functions.yml, deploy-azure-frontend.yml",
    issuer: "GitHub OIDC, trusted by Entra",
    renewal: "self",
    lifetimeDays: null,
  },
  {
    id: "gh-oidc-copilot",
    name: "environment copilot → github_copilot_review",
    store: "github-environment",
    consumer: "copilot-setup-steps.yml (Copilot code review and cloud agent)",
    issuer: "GitHub OIDC, trusted by Entra",
    renewal: "self",
    lifetimeDays: null,
  },

  // ── HCP Terraform ───────────────────────────────────────────────────────
  {
    id: "tfc-azure-cloudflare-api-token",
    name: "cloudflare_api_token",
    store: "tfc-azure",
    consumer: "Cloudflare provider: DNS and the origin transform rule",
    issuer: "Cloudflare",
    renewal: "hand",
    lifetimeDays: null,
    rotate:
      "Roll it in the Cloudflare dashboard and update the sensitive workspace variable.",
  },
  {
    id: "tfc-azure-cloudflare-origin-secret",
    name: "cloudflare_origin_secret",
    store: "tfc-azure",
    consumer: "Cloudflare origin transform rule",
    issuer: "This estate (the same value as CF-ORIGIN-SECRET)",
    renewal: "hand",
    lifetimeDays: null,
    rotate:
      "Change it with CF-ORIGIN-SECRET, never alone: until both match, public submissions are refused.",
  },
  {
    id: "tfc-azure-dynamic-credentials",
    name: "TFC_AZURE_RUN_CLIENT_ID (dynamic provider credentials)",
    store: "tfc-azure",
    consumer: "Every hcw-azure plan and apply",
    issuer:
      "HCP Terraform OIDC, trusted by Entra (id-plat-terraform-prod-cus-01)",
    renewal: "self",
    lifetimeDays: null,
  },
  {
    id: "tfc-lab-hostinger-api-token",
    name: "hostinger_api_token",
    store: "tfc-lab",
    consumer: "infra-lab Hostinger provider",
    issuer: "Hostinger",
    renewal: "hand",
    lifetimeDays: null,
    rotate:
      "Issue a new token in the Hostinger panel and update the sensitive workspace variable.",
  },
  {
    id: "tfc-lab-cloudflare-api-token",
    name: "cloudflare_api_token",
    store: "tfc-lab",
    consumer: "infra-lab lab DNS records",
    issuer: "Cloudflare",
    renewal: "hand",
    lifetimeDays: null,
    rotate:
      "Roll it in the Cloudflare dashboard and update the sensitive workspace variable.",
  },

  // ── Azure ───────────────────────────────────────────────────────────────
  {
    id: "azure-swa-deployment-token",
    name: "Static Web App deployment token",
    store: "azure",
    consumer: "deploy-azure-frontend.yml, read just in time for each run",
    issuer: "Azure Static Web Apps",
    renewal: "hand",
    // TODO.md, accepted risk for #834: nothing stores it, so a reset breaks
    // nothing, and the compensating control is a reset every 90 days.
    lifetimeDays: SWA_TOKEN_RESET_DAYS,
    source: { swaReset: true },
    rotate:
      "Reset it on the Static Web App (Manage deployment token, then Reset). Nothing stores it, so the next deploy reads the new one.",
  },

  // ── Entra ───────────────────────────────────────────────────────────────
  {
    id: "entra-github-reader",
    name: "github_reader federated credential (main branch)",
    store: "entra",
    consumer:
      "monitor-functions-registered.yml, monitor-unresolved-secrets.yml, verify-alert-state.yml, publish-content-manifest.yml",
    issuer: "GitHub OIDC, trusted by Entra",
    renewal: "self",
    lifetimeDays: null,
  },
  {
    id: "entra-function-app-identity",
    name: "func-site-prod-cus-01 managed identity",
    store: "entra",
    consumer: "The API’s reads of Cosmos, Key Vault, Storage and Foundry",
    issuer: "Entra (system-assigned)",
    renewal: "self",
    lifetimeDays: null,
  },
  {
    id: "entra-arc-machine-identity",
    name: "arcs-lab-hybrid-prod-cus-01 managed identity",
    store: "entra",
    consumer: "HashiCorp Vault auto-unseal; the lab host’s Azure Monitor agent",
    issuer: "Azure Arc",
    renewal: "self",
    lifetimeDays: null,
  },

  // ── Docker ──────────────────────────────────────────────────────────────
  {
    id: "docker-oidc-connection",
    name: "OIDC connection publish-lab-image-main",
    store: "docker",
    consumer: "publish-lab-image.yml, Publish to Docker Hub",
    issuer: "Docker, trusting GitHub OIDC",
    renewal: "self",
    lifetimeDays: null,
  },

  // ── Lab host: Ansible Vault (/etc/hcw/ansible/vault.yml) ────────────────
  {
    id: "lab-coder-github-oauth-secret",
    name: "vault_coder_oauth2_github_client_secret",
    store: "lab-vault",
    consumer: "Coder learner sign-in with GitHub",
    issuer: "GitHub OAuth app (HybridCloudWorks organisation)",
    renewal: "hand",
    lifetimeDays: HAND_ROTATION_DAYS,
    rotate:
      "Generate a new client secret on the OAuth app, edit the vault key and re-run bootstrap.sh, which recreates the coder container.",
  },
  {
    id: "lab-coder-postgres-password",
    name: "vault_coder_postgres_password",
    store: "lab-vault",
    consumer: "Coder’s PostgreSQL database",
    issuer: "This host (generated)",
    renewal: "hand",
    lifetimeDays: null,
    rotate:
      'ALTER USER first, then the vault edit and a run: lab-host/README.md, "Rotating the PostgreSQL password".',
  },
  {
    id: "lab-caddy-cloudflare-api-token",
    name: "Caddy CLOUDFLARE_API_TOKEN",
    store: "lab-vault",
    consumer: "Caddy’s DNS-01 certificate renewals",
    issuer: "Cloudflare",
    renewal: "hand",
    lifetimeDays: null,
    rotate:
      "Roll it in the Cloudflare dashboard, edit the vault key and re-run bootstrap.sh; also on every host rebuild.",
  },
  {
    id: "lab-addon-migration-turnstile-secret",
    name: "vault_addon_migration_turnstile_secret",
    store: "lab-vault",
    consumer:
      "The migration add-on’s human verification on uploads (hcw-addon-migration, ADR 0035)",
    issuer:
      "Cloudflare (the add-on’s own Turnstile widget, separate from the site’s)",
    renewal: "hand",
    lifetimeDays: null,
    rotate:
      'Rotate it in the widget’s settings, set the vault key with hcw-vault-set and re-run bootstrap.sh, which recreates the container: docs/runbooks/labs-host.md, "Tool add-ons".',
  },
  {
    id: "lab-arc-service-principal-secret",
    name: "vault_arc_service_principal_secret",
    store: "lab-vault",
    consumer: "Arc onboarding, once; deleted when the host reads Connected",
    issuer: "Entra (sp-arc-onboarding-lab-hybrid-prod-cus)",
    renewal: "hand",
    lifetimeDays: null,
    rotate:
      "Minted for one onboarding by scripts/lab/Register-LabArc.ps1, valid for 24 hours, and deleted by its -Connect run.",
  },

  // ── Lab host: files ─────────────────────────────────────────────────────
  {
    id: "lab-agent-certificate",
    name: "/etc/hcw/labs-agent.pem (sp-labs-agent-lab-hybrid-prod-cus-01)",
    store: "lab-file",
    consumer: "The lab agent’s calls to the API",
    issuer: "Self-signed on the lab host, registered in Entra",
    renewal: "hand",
    lifetimeDays: LAB_CERTIFICATE_DAYS,
    source: { labCertificate: "labAgent" },
    rotate:
      'Generate the next pair on the host and register it with Register-LabAgent.ps1 -NextCertificate before the swap: lab-host/README.md, "Rotating the agent certificate".',
  },
  {
    id: "lab-vault-tls-certificate",
    name: "/etc/vault.d/tls/vault.crt",
    store: "lab-file",
    consumer: "HashiCorp Vault’s listener on 127.0.0.1",
    issuer: "Self-signed on the lab host",
    renewal: "hand",
    lifetimeDays: LAB_CERTIFICATE_DAYS,
    source: { labCertificate: "vaultTls" },
    rotate:
      'Remove the pair and re-run bootstrap.sh, then unseal: lab-host/ansible/roles/vault/README.md, "Rotating the certificate".',
  },
  {
    id: "lab-coder-rotation-credential",
    name: "/etc/hcw/coder/automation/rotation-token",
    store: "lab-file",
    consumer:
      "hcw-coder-automation: renews the status token, publishes the template",
    issuer: "Coder on the lab host (hcw-status)",
    // The automation renews it itself under 60 days left, and reports its
    // expiry as rotationTokenExpiresAt.
    renewal: "automation",
    lifetimeDays: CODER_ROTATION_CREDENTIAL_DAYS,
    source: { coder: "rotationToken" },
    rotate:
      "Renewed by the lab host under 60 days left; seeded by hand with hcw-coder-automation-seed.",
  },
  {
    id: "lab-caddy-certificates",
    name: "Caddy’s certificates for lab.hybridcloudworks.com",
    store: "lab-file",
    consumer: "HTTPS for the lab host and Coder",
    issuer: "ACME, through Caddy",
    renewal: "self",
    lifetimeDays: null,
  },

  // ── The owner's password manager ────────────────────────────────────────
  {
    id: "owner-vault-recovery-keys",
    name: "HashiCorp Vault recovery keys and root token",
    store: "owner",
    consumer: "Vault recovery: generate-root, a rekey, a seal migration",
    issuer: "HashiCorp Vault on the lab host",
    renewal: "hand",
    lifetimeDays: null,
    rotate: "Rekeyed by the owner over SSH; a host rebuild makes them useless.",
  },
  {
    id: "owner-portainer-admin-password",
    name: "Portainer administrator password",
    store: "owner",
    consumer: "Portainer through the SSH tunnel",
    issuer: "Portainer on the lab host",
    renewal: "hand",
    lifetimeDays: null,
    rotate: "Changed in Portainer; a host rebuild needs a new one.",
  },
];

const deepFreeze = (entry) =>
  Object.freeze({
    ...entry,
    source: entry.source ? Object.freeze({ ...entry.source }) : null,
  });

/** The whole register, Key Vault first, every entry frozen. */
export const CREDENTIAL_REGISTER = Object.freeze(
  [
    ...keyVaultEntries(),
    ...OTHER_ENTRIES.map((entry) => ({ rotate: null, ...entry })),
  ].map(deepFreeze),
);

const BY_ID = new Map(CREDENTIAL_REGISTER.map((entry) => [entry.id, entry]));
const STORE_IDS = new Set(CREDENTIAL_STORES.map((store) => store.id));

/** The entry for an id, or undefined. An own-key lookup, so `constructor` finds nothing. */
export function findCredential(id) {
  return BY_ID.get(String(id ?? ""));
}

/** Whether a store id is one the register knows. */
export const isCredentialStore = (id) => STORE_IDS.has(String(id ?? ""));

/**
 * Whether the owner may record when this credential was last rotated: only
 * a hand-renewed one. Nothing is rotated by hand for one that renews itself,
 * an automation's date is the automation's to report, and an identifier has
 * no rotation at all.
 */
export const isRecordable = (entry) => entry?.renewal === "hand";
