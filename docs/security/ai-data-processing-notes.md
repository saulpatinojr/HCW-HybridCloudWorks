# AI provider data-processing notes

**What this is:** the formal data-processing and privacy evaluation for each third-party Artificial Intelligence model provider integrated into the HybridCloudWorks platform (ADR 0013, ADR 0034).

**Data Minimization Principle:** All prompts sent to external AI providers consist solely of public educational material, open documentation, and author-provided article drafts. **No subscriber personal data, customer passwords, or internal directory credentials are transmitted to any AI provider.** Pre-flight client scrubbers remove accidental API keys, GUIDs, and email addresses prior to network transmission.

**Second Brain exception (2026-10-26):** Owner-requested questions can retrieve
private, author-provided knowledge notes as well as creator content. The
`brainAssistant` task sends at most eight relevant text excerpts, capped at
5,000 characters each, through the configured Foundry provider only. It has no
tools, automatic publishing, background analysis, or access to subscriber and
operational containers. This private-note path does not inherit a guarantee
that arbitrary prose has been scrubbed of sensitive text: the material is the
owner's input. Enabling it is controlled separately by `BRAIN_AI_ENABLED`.
See [Second Brain](../architecture/second-brain.md).

---

## 1. Anthropic (Claude)

- **Models utilized:** `claude-3-5-sonnet-20241022`, `claude-3-haiku-20240307`.
- **Workloads:** ContentForge drafting assistant, automated PR code review via Copilot MCP server, article categorization, and SEO summary generation.
- **Data in transit:** Transmitted over TLS 1.3 to `https://api.anthropic.com/v1/messages`.
- **Training policy:** Anthropic Commercial Terms of Service explicitly guarantee that **customer prompts, completions, and code submitted via the API are NOT used to train Anthropic models**.
- **Retention:** Commercial API data is retained ephemerally on Anthropic's secure servers for a maximum of 30 days solely to identify abuse and ensure trust and safety, after which it is purged.
- **Security standards:** SOC 2 Type II certified, encrypted in transit (TLS 1.3) and at rest (AES-256).

---

## 2. OpenAI

- **Models utilized:** `gpt-4o`, `gpt-4o-mini`, `text-embedding-3-small`.
- **Workloads:** Vector embeddings for semantic search, tag taxonomy suggestions, and content quality scoring.
- **Data in transit:** Transmitted over TLS 1.3 to `https://api.openai.com/v1/chat/completions` and `https://api.openai.com/v1/embeddings`.
- **Training policy:** OpenAI Business terms guarantee that **data submitted through the API is NOT used to train or improve OpenAI models**.
- **Retention:** API inputs and outputs are retained for up to 30 days for abuse and misuse monitoring, with zero data retention available for authorized healthcare/enterprise tiers.
- **Security standards:** SOC 2 Type II compliant, CCPA/GDPR Data Processing Addendum (DPA) executed, AES-256 encryption at rest.

---

## 3. Google Gemini (Generative Language API)

- **Models utilized:** `gemini-1.5-pro`, `gemini-1.5-flash`, Gemini TTS audio synthesis.
- **Workloads:** Public "Explain with AI" interactive widget on the website, Listen & Learn audio narration synthesis.
- **Data in transit:** Transmitted over TLS 1.3 to `https://generativelanguage.googleapis.com/v1beta/models`.
- **Training policy:** When accessed using paid API keys tied to Google Cloud billing (`GEMINI-API-KEY`), **customer data is NOT used to train Google models**.
- **Retention:** Audio synthesis jobs and generated MP3 audio chunks are processed in memory and streamed directly to client storage; ephemeral caching expires within hours.
- **Security standards:** ISO/IEC 27001, SOC 1/2/3, Google Cloud Privacy Commitments apply to paid API project traffic.

---

## 4. NVIDIA API Catalog

- **Models utilized:** Llama 3.1 70B / 8B endpoints, DeepSeek hosted models.
- **Workloads:** Secondary fallback provider for owner-triggered content drafting when primary providers experience rate limiting or outages (#701, #812).
- **Data in transit:** Transmitted over TLS 1.3 to `https://integrate.api.nvidia.com/v1`.
- **Training policy:** NVIDIA Hosted Inference API does not retain prompt or completion data for foundation model retraining.
- **Retention:** Ephemeral session processing only; no persistent storage of prompts.
- **Rate limiting & controls:** Managed by client-side backoff and pacing under ~40 requests per minute.

---

## 5. Replicate

- **Models utilized:** `google/imagen-4-fast`, `black-forest-labs/flux-schnell`.
- **Workloads:** Cover image and hero graphic generation for approved editorial articles.
- **Data in transit:** Transmitted over TLS 1.3 to `https://api.replicate.com/v1/predictions`.
- **Data payload:** Short visual prompt descriptions (e.g. "Minimalist abstract diagram of hybrid cloud connectivity with blue and indigo gradients"). No text bodies or PII.
- **Retention & storage:** Generated image URLs are valid for 24 hours. The application downloads the output image immediately to Azure Blob Storage (`rg-hcw-prod-storage-cus` / `media`) and re-hosts it from the site's own origin.
- **Spend ceiling:** Bounded by `$0.02` per image and strict monthly budget ceiling (`CONTENTFORGE_IMAGE_MONTHLY_BUDGET_USD = 10`) configured in `infra/functionapp.tf:502-503`.
