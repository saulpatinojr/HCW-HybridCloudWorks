/**
 * The Integrations Hub's registry: every service, the group it sits under, and
 * the browser-side test that asks it whether it works.
 *
 * Moved unchanged out of pages/admin/IntegrationsPage.jsx (#570), which is now
 * only the tab bar. Every tab reads this one list, so the Overview grid, the
 * Services cards and the Keys tab's "used by" line cannot disagree about which
 * service owns which key. The Health page's probe registry reads it too
 * (pages/admin/health/probeRegistry.js), so a service tested here is a service
 * probed there, by the same function.
 *
 * ADR 0033 (Platform) added a card for every AI key that until then appeared
 * only as a loose key on the Keys tab — Gemini, Anthropic, OpenAI, NVIDIA,
 * ElevenLabs, Azure Speech, Firecrawl, Replicate (and Perplexity, until #1029
 * retired the key nothing read) — and one for the
 * Hybrid Lab's three values, each saying what the service is for, what it can
 * do, which hubs use it, which way data flows and what the key can reach.
 */

import React from 'react';
import {
  ArrowRightLeft,
  Award,
  BookOpen,
  Bot,
  Cloud,
  Coins,
  FlaskConical,
  Globe,
  Image as ImageIcon,
  Link2,
  Mail,
  Mic,
  Radio,
  Rss,
  ScanText,
  Send,
  Share2,
  ShieldCheck,
  Sparkles,
  Volume2,
} from 'lucide-react';
import { getJSON, postJSON } from '@/lib/api';
import { fetchCloudPricing } from '@/lib/publicApi';
import { DEFAULT_PRICING_REGION, describeAge, describeCounts } from '@/lib/cloudPricing';
import { countList, unwrapProxy } from '@/lib/proxyEnvelope';
import { extractProfiles } from '@/lib/linkie';
import { DEFAULT_SESSIONIZE_SPEAKER_ID } from '@/lib/adminSettings';

// lucide-react v1.x dropped brand icons — inline YouTube glyph (same as SocialHubPage).
const Youtube = ({ className }) => (
  <svg
    className={className}
    viewBox="0 0 24 24"
    fill="currentColor"
    aria-hidden="true"
    focusable="false"
  >
    <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z" />
  </svg>
);

// ── Service test runners ──────────────────────────────────────────────────────
// Each returns a human-readable success string or throws.

// EVERY ONE OF THESE MUST READ `ok`. The three REST proxies answer HTTP 200
// for every outcome, so `authedFetch` does not throw and a refused credential
// arrives as a resolved envelope. `testPubler` used to read
// `Array.isArray(accounts)` on that envelope — an object, never an array — so
// it computed zero and said "Connected — 0 social account(s)" for a 403.
// The button reported Connected while the timer beside it had been failing for
// hours. `unwrapProxy` throws instead, with the upstream's own sentence.

async function testPubler() {
  const body = unwrapProxy(
    await postJSON('publerProxy', { path: '/accounts', method: 'GET' }),
    'Publer'
  );
  const count = countList(body, 'accounts');
  return count === null ? 'Connected to Publer.' : `Connected — ${count} social account(s).`;
}

async function testPlaud() {
  // Same path the Recording Hub's Plaud tab uses — credentials stay server-side in mcpProxy.
  // mcpProxy answers `{ ok: false, error }` with HTTP 200 for a tool or upstream
  // refusal (lib/ai/mcp.js), so the envelope's `ok` is the verdict, as above.
  unwrapProxy(
    await postJSON('mcpProxy', {
      serverId: 'plaud',
      tool: 'list_files',
      arguments: { limit: 1 },
    }),
    'Plaud'
  );
  return 'Connected — Plaud MCP responded.';
}

async function testSessionize(speakerId) {
  const id = speakerId || DEFAULT_SESSIONIZE_SPEAKER_ID;
  const res = await fetch(`https://sessionize.com/api/speaker/json/${id}`);
  if (!res.ok) throw new Error(`Sessionize HTTP ${res.status}`);
  const data = await res.json();
  return `Connected — ${(data.events || []).length} event(s) for speaker ${id}.`;
}

async function testLinkie() {
  const res = await postJSON('linkieProxy', { path: '/profiles', method: 'GET' });
  // `unwrapProxy` for the verdict, `extractProfiles` for the count. Linkie
  // answers `{ data: { profiles: [...] } }` and `lib/linkie.js` already knows
  // that - counting it again here would be the second copy that drifts.
  unwrapProxy(res, 'Linkie');
  const profiles = extractProfiles(res);
  return `Connected — ${profiles.length} profile(s).`;
}

// The services whose credentials never reach a browser (#483). Each posts a NAME
// to `connectionProbe`, which builds the whole outbound call server-side; none
// of them names a URL, a path or a method, because the caller supplying one is
// the confused deputy `rest-proxy.js` spends its header on. The envelope is the
// proxies' own, so `unwrapProxy` reads a refusal here exactly as it does there.

async function testTelegram() {
  const body = unwrapProxy(await postJSON('connectionProbe', { probe: 'telegram' }), 'Telegram');
  // getMe answers `{ ok, result: { username, ... } }`. The username is the
  // useful half: it says WHICH bot the token belongs to, which is the question
  // an operator holding two tokens actually has.
  const username = body?.result?.username;
  return username ? `Connected — @${username}.` : 'Connected to Telegram.';
}

async function testRssCom() {
  const body = unwrapProxy(await postJSON('connectionProbe', { probe: 'rsscom' }), 'RSS.com');
  const count = countList(body, 'podcasts');
  return count === null ? 'Connected to RSS.com.' : `Connected — ${count} show(s) visible.`;
}

async function testStreamYard() {
  const res = await getJSON('cms/streamyard/status');
  if (!res?.configured) {
    throw new Error('StreamYard On-Air is not configured: STREAMYARD_API_KEY is not set.');
  }
  const registrants = Number.isInteger(res.totalRegistrants) ? res.totalRegistrants : 0;
  const attended = Number.isInteger(res.totalAttended) ? res.totalAttended : 0;
  const channels = [
    res.newsletterConfigured ? 'newsletter sync ready' : 'newsletter key missing',
    res.telegramConfigured ? 'Telegram alerts ready' : 'Telegram not configured',
  ].join(', ');
  return `Connected — ${registrants} registrant(s), ${attended} attended (${channels}).`;
}

async function testYouTube() {
  unwrapProxy(await postJSON('connectionProbe', { probe: 'youtube' }), 'YouTube');
  // No count: the probe asks for one result and discards it, so any number
  // here would describe the probe rather than the account. The quota cost is
  // said out loud because pressing this button spends it — about 100 of the
  // 10,000 units a day that Listen & Learn draws on for real episodes.
  return 'Connected — the Data API answered. This check costs ~100 of 10,000 daily quota units.';
}

async function testResend() {
  // GET /domains, server-side. A sending-access-only key is refused here with
  // Resend's own sentence, which `unwrapProxy` surfaces, so a pass means the
  // key can manage contacts and broadcasts (ADR 0030).
  const body = unwrapProxy(await postJSON('connectionProbe', { probe: 'resend' }), 'Resend');
  const count = countList(body);
  if (count === null) return 'Connected to Resend.';
  // Zero is worth its own sentence: the key works, and nothing can be sent
  // until a domain is added and verified.
  return count === 0
    ? 'Connected, but no sending domain has been added to Resend yet.'
    : `Connected — ${count} sending domain(s).`;
}

async function testQlty() {
  // GET https://api.qlty.sh/user, server-side. The envelope's `data` is Qlty's
  // user object; its login says whose token this is.
  const body = unwrapProxy(await postJSON('connectionProbe', { probe: 'qlty' }), 'Qlty');
  const login = body?.login;
  return typeof login === 'string' && login.trim()
    ? `Connected as ${login.trim()}.`
    : 'Connected to Qlty.';
}

async function testReplicate() {
  // GET /v1/account, server-side (ADR 0033): whose account the token is, with
  // no prediction started and nothing billed.
  const body = unwrapProxy(await postJSON('connectionProbe', { probe: 'replicate' }), 'Replicate');
  const who = body?.username;
  return typeof who === 'string' && who.trim()
    ? `Connected as ${who.trim()}.`
    : 'Connected to Replicate.';
}

async function testFirecrawl() {
  // GET /v1/team/credit-usage, server-side (ADR 0033): free, and the count
  // says how close the summariser is to running dry.
  const body = unwrapProxy(await postJSON('connectionProbe', { probe: 'firecrawl' }), 'Firecrawl');
  const credits = body?.data?.remaining_credits ?? body?.remaining_credits;
  return Number.isFinite(credits)
    ? `Connected — ${credits} credits remaining.`
    : 'Connected to Firecrawl.';
}

/**
 * The AI Engine's own Test, by route: `testAiProvider` sends the one-word
 * prompt the portal button sends and the weekly probe repeats, and writes the
 * outcome onto the provider document. It answers `{ status, latencyMs, error }`
 * with HTTP 200 whatever the model said, so `status` is the verdict.
 */
const testAiProvider = (providerId, label) => async () => {
  const outcome = await postJSON('testAiProvider', { providerId });
  if (outcome?.status !== 'connected') {
    throw new Error(outcome?.error || `${label} did not answer the test prompt.`);
  }
  return Number.isFinite(outcome.latencyMs)
    ? `Connected — answered in ${outcome.latencyMs} ms.`
    : `Connected to ${label}.`;
};

async function testElevenLabs() {
  // The Audio tab's status read (cms/podcast/elevenlabs): plan and credits,
  // no synthesis. `configured: false` and `subscriptionError` are both the
  // server's own sentences.
  const res = await getJSON('cms/podcast/elevenlabs');
  if (!res?.configured) {
    throw new Error(res?.reason || 'ElevenLabs is not configured: ELEVENLABS_API_KEY is not set');
  }
  if (res.subscriptionError) throw new Error(res.subscriptionError);
  const sub = res.subscription || {};
  const tier = typeof sub.tier === 'string' && sub.tier ? ` on the ${sub.tier} plan` : '';
  const credits =
    Number.isFinite(sub.creditsLeft) && Number.isFinite(sub.creditLimit)
      ? ` — ${sub.creditsLeft} of ${sub.creditLimit} credits left`
      : '';
  return `Connected${tier}${credits}.`;
}

/**
 * The status token's expiry, as a sentence to append, or an Error to throw
 * (#763): the token is made with a one-year lifetime and nothing renews it,
 * so the card is the reminder. `renewSoon` (inside the server's warning
 * window) turns the card red with the renewal steps named; an unknown
 * expiry says why — the token lacks the `api_key:read` scope that lets it
 * read its own record (Coder answers that read 403, or 404 since v2.38), or
 * it is not set. A token without the scope still serves the card, so that
 * sentence stays green and names the fix: re-issue it with the scope.
 */
export function describeTokenExpiry(read) {
  const token = read?.token;
  if (!read?.configured || !token) return '';
  if (token.known) {
    const day = String(token.expiresAt).slice(0, 10);
    const left = `${token.daysLeft} day${token.daysLeft === 1 ? '' : 's'}`;
    if (token.renewSoon) {
      throw new Error(
        `Status token expires on ${day} (${left}): renew it — lab-host/README.md, "The status token for the site".`
      );
    }
    return ` Status token expires on ${day} (${left}).`;
  }
  if (token.reason === 'refused') {
    throw new Error(
      'Coder refused the status token: it has expired or been revoked. Renew it — lab-host/README.md, "The status token for the site".'
    );
  }
  if (token.reason === 'scope') {
    return ` Status token expiry unknown: Coder will not show the token its own record without the ${token.scope} scope. Re-issue the token with ${token.scope} added — lab-host/README.md, "The status token for the site" — and the card will show its expiry.`;
  }
  if (token.reason === 'unset') return ' No status token is set.';
  return '';
}

async function testHybridLab() {
  // The public labs card's own read (public/labs/coder-status), which the
  // server answers from CODER_URL and CODER_STATUS_TOKEN and caches.
  const res = await getJSON('public/labs/coder-status');
  if (!res?.configured) throw new Error('Coder is not configured: CODER_URL is not set');
  if (!res.reachable) throw new Error('Coder is configured but did not answer within 5 s.');
  const templates = Array.isArray(res.templates) ? res.templates.length : 0;
  const running = res.capacity?.running ?? 'unknown';
  const max = res.capacity?.max ?? 'unknown';
  const base = `Connected — ${templates} template(s), ${running} of ${max} workspaces running.`;
  // The token's own expiry (cms/labs/coder-token, editor); a failed read
  // leaves the sentence as it was rather than hiding a working Coder.
  const expiry = await getJSON('cms/labs/coder-token').catch(() => null);
  return `${base}${describeTokenExpiry(expiry)}`;
}

/** Read the migration add-on's status through the site's own proxy; configured and reachable is a pass. */
async function testMigrationAddon() {
  // The pane page's own read (public/addons/migration/status), which the
  // server answers from ADDON_MIGRATION_URL and caches for a minute. The
  // body is a six-field projection; version and edition are what an
  // operator wants to read here.
  const res = await getJSON('public/addons/migration/status');
  if (!res?.configured) {
    throw new Error('The migration add-on is not configured: ADDON_MIGRATION_URL is not set.');
  }
  if (!res.reachable) {
    throw new Error(
      'The migration add-on is configured but did not answer its health read within 5 s.'
    );
  }
  return `Connected: version ${res.version ?? 'unknown'}, edition ${res.edition ?? 'unknown'}.`;
}

async function testCloudPricing() {
  // The public read the comparison page makes, for the default region, and
  // always FRESH: a diagnostic that could answer from the browser's copy would
  // report the cache as it was before "Refresh now" for fifteen minutes.
  const pricing = await fetchCloudPricing(DEFAULT_PRICING_REGION, { fresh: true });
  if (!pricing) throw new Error('The pricing route is missing (HTTP 404).');
  if (!pricing.refreshedAt) {
    // Not a credential failure, but the public page shows no prices until
    // the first refresh — which is the red light this card exists to show.
    throw new Error('No prices cached yet. Press Refresh now to fill the cache.');
  }
  const age = describeAge(pricing.ageMinutes) ?? 'an unknown time ago';
  const counts = describeCounts(pricing.counts);
  if (pricing.stale) {
    throw new Error(`Stale: last refreshed ${age} (${counts}). The daily refresh has missed.`);
  }
  return `Fresh: refreshed ${age} (${counts}).`;
}

// ── Groups and services ───────────────────────────────────────────────────────

/**
 * The groups everything on this page is sorted into — services AND the
 * credentials underneath them.
 *
 * ONE TAXONOMY, not two. The page used to show a flat list of service cards
 * and then a separate "Other credentials" bucket organised on different lines,
 * so Publer’s card and Publer’s keys could sit under different words. These
 * ids match `SECRET_SECTIONS` in `functions/src/lib/secret-catalog.js`, which
 * is what lets a group show its services and its loose keys together.
 *
 * `education` is the one id with no secrets behind it — those services are
 * public profiles with nothing to store — and the catalogue deliberately does
 * not declare it, because a section there with no secrets renders as an empty
 * heading and its own test refuses that.
 */
export const SERVICE_GROUPS = Object.freeze([
  {
    id: 'communication',
    title: 'Communication',
    blurb: 'Anything that speaks to an audience — posts, newsletters, links and alerts.',
  },
  {
    id: 'content',
    title: 'Content',
    blurb: 'Where episodes, videos and recordings are published and read from.',
  },
  {
    id: 'education',
    title: 'Education',
    blurb: 'The public profiles behind the certifications and Learn pages. Nothing to store here.',
  },
  {
    id: 'gen-ai',
    title: 'Gen AI',
    blurb:
      'Language models. The site tries them in order when something needs writing. Each row says what it is used for.',
  },
  {
    id: 'ai-services',
    title: 'AI services',
    blurb:
      'Called for one job each — narration, cover images, and reading a web page well enough to summarise it.',
  },
  {
    id: 'cloud',
    title: 'Cloud',
    blurb: 'Public price lists for the cost comparison tools. None of these bills this site.',
  },
  {
    id: 'code-quality',
    title: 'Code quality',
    blurb: 'Read-only access to the repository’s scanner results, shown on the Health page.',
  },
  {
    id: 'platform',
    title: 'Site platform',
    blurb: 'Values the site runs on. Each one says what changing it breaks.',
  },
  {
    id: 'labs',
    title: 'Hybrid Lab',
    blurb:
      'The browser workspaces learners open from the labs page, and the check that lets the Landing Zone Builder send the lab a job.',
  },
  {
    id: 'addons',
    title: 'Tool add-ons',
    blurb:
      'Independently built tools the site shows in a pane under Tools, each with its own status read.',
  },
]);

/** The sentence every key-based card shows about disconnecting (ADR 0033). */
export const DISCONNECT_NOTE =
  'This hub writes to Key Vault but cannot delete from it, so disconnecting a key-based service means pasting a replacement key, or revoking the key at the provider and leaving the light to go red.';

/** What a LLM provider card says the key can reach. */
const LLM_SECURITY_NOTE =
  'The key never reaches a browser: every call is made server-side through the AI router, and a rejected key is reported as a red light on the Keys tab.';

/**
 * Every service, and the credentials that belong to it.
 *
 * `secrets` names entries in the catalogue. A name that is not there renders
 * nothing — the catalogue is the source of truth for what exists.
 *
 * THREE FIELDS DRIVE THE CARD, and each may be absent for a reason:
 *
 *   `url`   Where this service lives, as specifically as possible: the page
 *           that holds the credential when there is one, and the owner’s own
 *           profile when there is not. EVERY service has one, and a test says
 *           so — a card with no key, no test and no link is a dead end.
 *   `test`  A GET that proves the credential works, or `null` where no cheap
 *           read exists. `null` is honest rather than lazy, and since ADR 0033
 *           it comes with `untestedReason` saying why, shown on the card: the
 *           education profiles are public HTML a browser cannot fetch from
 *           another origin; Azure Speech is unprovisioned on purpose.
 *
 *           NO BEAKER MEANS THE GLOBE HAS TO WORK HARDER. When a service holds
 *           credentials and offers no test, the only thing this page can do
 *           about a red light is send you where the credential is managed — so
 *           `url` must be that page, not the vendor’s front door. A test below
 *           holds it: such a service must point at a specific page rather
 *           than a bare host.
 *   `group` Which heading it sits under.
 *
 * FOUR MORE SAY WHAT THE SERVICE IS (ADR 0033 Platform), for a reader who has
 * never seen this repository: `capabilities` (what it can do here), `usedIn`
 * (which hubs call it), `dataDirection` (which way data flows) and
 * `securityNote` (what the key can reach and where it lives).
 *
 * Two optional fields put something the card can DO beneath the key lines,
 * and IntegrationsServices maps each to a component: `setting` for the one
 * service configured rather than credentialed (Sessionize’s speaker id), and
 * `action` for the one the site fills itself (the pricing cache’s Refresh
 * now). `reconnectHref` names the page holding a service's own sign-in flow
 * (Plaud's OAuth connect, in the Recording Hub). `keyGroups` splits a card's
 * keys into titled boxes, each of which may name a `panel` drawn inside it:
 * the Hybrid Lab card's Coder box carries the lab host's automatic renewal
 * (CoderAutomation). All are names, not components, so this file stays free
 * of React state and the registry test can read them as data.
 *
 * DESCRIPTIONS ARE FOR SOMEONE WHO HAS NEVER SEEN THIS REPOSITORY. One line,
 * saying what the service is and what it does for the site. No issue numbers,
 * no function names, no file paths.
 */
export const SERVICES = Object.freeze([
  // ── Communication ────────────────────────────────────────────────────────
  {
    id: 'publer',
    group: 'communication',
    icon: Share2,
    name: 'Publer',
    description: 'Schedules and publishes posts to LinkedIn, X, Facebook, Instagram and YouTube.',
    url: 'https://app.publer.com/#/settings/access',
    test: testPubler,
    secrets: ['PUBLER-API-KEY', 'PUBLER-WORKSPACE-ID'],
    capabilities: ['List connected social accounts', 'Schedule and publish posts'],
    usedIn: ['Social Hub', 'Platform Settings (Social automation)'],
    dataDirection: 'Outbound: captions and links for live content go to Publer.',
    securityNote:
      'Both values are read on the server only. Publer answers 403 for a wrong key and 401 for a wrong workspace id, and each has its own light.',
  },
  {
    id: 'resend',
    group: 'communication',
    icon: Mail,
    name: 'Resend',
    description: 'Holds the newsletter mailing list and sends the newsletter.',
    // Where the key is minted. It must be created with Full access.
    url: 'https://resend.com/api-keys',
    // Server-side: GET /domains, which a sending-only key cannot pass.
    test: testResend,
    secrets: ['RESEND-API-KEY'],
    capabilities: ['Manage contacts', 'Create and send broadcasts', 'Send the confirmation email'],
    usedIn: ['Newsletter Hub'],
    dataDirection: 'Outbound: subscriber addresses and issue HTML go to Resend.',
    securityNote:
      'A Full access key, read on the server only; the test refuses a key minted with sending access alone.',
  },
  {
    id: 'linkie',
    group: 'communication',
    icon: Link2,
    name: 'Linkie',
    description: 'The link-in-bio page and the links on it.',
    url: 'https://app.linkie.bio',
    test: testLinkie,
    secrets: ['LINKIE-API-KEY'],
    capabilities: ['List profiles', 'Add, reorder and remove links'],
    usedIn: ['Linkie Hub'],
    dataDirection: 'Outbound: live page titles and URLs go to Linkie.',
    securityNote: 'Read on the server only, through the Linkie proxy.',
  },
  {
    id: 'telegram',
    group: 'communication',
    icon: Send,
    name: 'Telegram',
    description: 'Sends the approve-or-reject message when new content is ready.',
    // Where the token is minted and re-minted.
    url: 'https://t.me/BotFather',
    // getMe runs on the SERVER (#483), which is how the token is tested
    // without ever reaching a browser. It judges the token alone — getMe does
    // not read the chat id, so a green light here says nothing about it.
    test: testTelegram,
    secrets: ['TELEGRAM-BOT-TOKEN', 'TELEGRAM-CHAT-ID'],
    capabilities: ['Send review notices', 'Answer approve / reject replies', 'Alert on failures'],
    usedIn: ['Review Queue', 'Health (alerts)', 'Forge Studio'],
    dataDirection: 'Two-way: notices go out; approve / reject commands come back on the webhook.',
    securityNote:
      'The token sits in the request path, so no probe ever quotes its URL; the chat id is never tested, only used.',
  },

  // ── Content ──────────────────────────────────────────────────────────────
  {
    id: 'rsscom',
    group: 'content',
    icon: Rss,
    name: 'RSS.com',
    description: 'Hosts the podcast and receives approved episodes.',
    // Where the key is minted, not the dashboard front door. The card gained a
    // beaker in #483 and the globe still points here, because the page a red
    // light sends you to is worth keeping either way.
    url: 'https://dashboard.rss.com/api-access/',
    // Server-side (#483): GET /v4/podcasts, the same call that discovers the
    // show id, so the test works before RSSCOM-PODCAST-ID is seeded.
    test: testRssCom,
    secrets: ['RSSCOM-API-KEY', 'RSSCOM-PODCAST-ID'],
    capabilities: ['List shows', 'Publish an episode'],
    usedIn: ['Recording Hub (Distribution)'],
    dataDirection: 'Outbound: episode audio and show notes go to RSS.com.',
    securityNote: 'Read on the server only. The podcast id is an identifier, not a secret.',
  },
  {
    id: 'streamyard',
    group: 'content',
    icon: Radio,
    name: 'StreamYard On-Air',
    description:
      'Webinar registrations, automatic newsletter double opt-in invites and Telegram attendance alerts.',
    url: 'https://streamyard.com/developer',
    test: testStreamYard,
    secrets: ['STREAMYARD-API-KEY'],
    action: 'streamyardOnAir',
    capabilities: [
      'Receive On-Air webinar registrants and attendance updates',
      'Send newsletter double opt-in confirmation emails to registrants',
      'Notify Telegram on new registrations and live or on-demand attendance',
    ],
    usedIn: ['Newsletter Hub', 'Telegram Alerts', 'Public Webinar Registration'],
    dataDirection:
      'Two-way: webinar registrations come in from StreamYard or the site; confirmation emails and Telegram alerts go out.',
    securityNote:
      'Read on the server only. Authenticates inbound webhook relays in constant time and never exposes registrant emails in logs.',
  },
  {
    id: 'youtube',
    group: 'content',
    icon: Youtube,
    name: 'YouTube',
    description: 'Finds the “watch next” videos shown beside each Listen & Learn episode.',
    url: 'https://console.cloud.google.com/apis/credentials',
    // Server-side (#483). COSTS ~100 OF 10,000 DAILY QUOTA UNITS per press,
    // because the Data API prices search.list per call — so this is a button
    // and must never become an automatic check.
    test: testYouTube,
    // So "Test all" on the Overview tab leaves it out: that button is one
    // press for every service, and this one spends quota each time. It is
    // still tested from its own card, where the cost is said beside the button.
    skipInTestAll: 'Costs ~100 of 10,000 daily YouTube quota units, so it is tested on its own.',
    secrets: ['YOUTUBE-API-KEY'],
    capabilities: ['Search for related videos'],
    usedIn: ['Listen & Learn'],
    dataDirection: 'Inbound: video titles and ids come from YouTube.',
    securityNote:
      'Read on the server only; the key travels in the query string, so no probe quotes its URL.',
  },
  {
    id: 'plaud',
    group: 'content',
    icon: Radio,
    name: 'Plaud',
    description: 'Voice recorder. Its recordings become podcast episodes.',
    url: 'https://app.plaud.ai',
    test: testPlaud,
    secrets: ['PLAUD-EMBEDDED-CLIENT-ID', 'PLAUD-EMBEDDED-API-KEY'],
    credentialNote:
      'Reading recordings from the recorder uses a separate sign-in that renews itself every 12 hours — reconnect from Recording Hub → Settings → Connect. The two values above are only for turning uploaded audio into text.',
    // The one service with its own sign-in flow: Reconnect goes there.
    reconnectHref: '/admin/recording-hub?tab=settings',
    capabilities: ['List recordings', 'Download audio', 'Transcribe an upload'],
    usedIn: ['Recording Hub'],
    dataDirection:
      'Inbound: recordings and transcripts come from Plaud; uploads go to it for transcription.',
    securityNote:
      'The OAuth tokens live on the MCP server document and are never returned to a browser; the embedded key is read on the server only.',
  },
  {
    id: 'sessionize',
    group: 'content',
    icon: Mic,
    name: 'Sessionize',
    description: 'The list of speaking events behind the Speaking Events page.',
    url: 'https://sessionize.com/app/speaker',
    test: (speakerId) => testSessionize(speakerId),
    secrets: [],
    // The one service configured rather than credentialed. Its setting is
    // rendered on this card because the setting IS its connection.
    setting: 'sessionizeSpeakerId',
    capabilities: ['Read the public speaker profile and its events'],
    usedIn: ['Speaking'],
    dataDirection: 'Inbound: a public JSON feed, read by the browser directly.',
    securityNote: 'No credential. The speaker id is public and stored in admin settings.',
  },

  // ── Education ────────────────────────────────────────────────────────────
  {
    id: 'credly',
    group: 'education',
    icon: Award,
    name: 'Credly',
    description: 'The badge wallet behind the certifications page.',
    url: 'https://www.credly.com/users/saul-patino/badges',
    test: null,
    untestedReason: 'A public profile page a browser cannot fetch from another origin.',
    secrets: [],
    usedIn: ['Certifications'],
    dataDirection: 'Inbound: badge images and links, copied by hand.',
  },
  {
    id: 'microsoft-learn',
    group: 'education',
    icon: BookOpen,
    name: 'Microsoft Learn',
    description: 'The certification transcript behind the Azure Learn pages.',
    url: 'https://learn.microsoft.com/en-us/users/saulpatinojr/transcript/d4993ir4gpz8g40',
    test: null,
    untestedReason: 'A public profile page a browser cannot fetch from another origin.',
    secrets: [],
    usedIn: ['Certifications'],
    dataDirection: 'Inbound: transcript entries, copied by hand.',
  },
  {
    id: 'aws-skill-builder',
    group: 'education',
    icon: Cloud,
    name: 'AWS Skill Builder',
    description: 'The certification badges behind the AWS Learn pages.',
    url: 'https://skillsprofile.skillbuilder.aws/user/saulpatino/certification-badges',
    test: null,
    untestedReason: 'A public profile page a browser cannot fetch from another origin.',
    secrets: [],
    usedIn: ['Certifications'],
    dataDirection: 'Inbound: badge images and links, copied by hand.',
  },
  {
    id: 'google-developer',
    group: 'education',
    icon: Globe,
    name: 'Google Developer',
    description: 'The developer profile behind the Google Cloud Learn pages.',
    url: 'https://developers.google.com/profile/u/105048864698113573023',
    test: null,
    untestedReason: 'A public profile page a browser cannot fetch from another origin.',
    secrets: [],
    usedIn: ['Certifications'],
    dataDirection: 'Inbound: profile badges, copied by hand.',
  },

  // ── Gen AI (ADR 0033) ────────────────────────────────────────────────────
  {
    id: 'gemini',
    group: 'gen-ai',
    icon: Sparkles,
    name: 'Google Gemini',
    description:
      'One of the models the site writes with, and the voice that reads every Listen & Learn episode.',
    url: 'https://aistudio.google.com/app/apikey',
    test: testAiProvider('gemini', 'Gemini'),
    secrets: ['GEMINI-API-KEY'],
    capabilities: ['Draft, summarise and grade content', 'Text to speech for Listen & Learn'],
    usedIn: ['Forge Studio', 'Review Queue (inspector)', 'Listen & Learn', 'AI Engine'],
    dataDirection: 'Outbound: article text and prompts go to Google; drafts and audio come back.',
    securityNote: LLM_SECURITY_NOTE,
  },
  {
    id: 'anthropic',
    group: 'gen-ai',
    icon: Bot,
    name: 'Anthropic',
    description:
      'One of the models the site writes with, tried in the order set on the AI Engine page.',
    url: 'https://console.anthropic.com/settings/keys',
    test: testAiProvider('anthropic', 'Anthropic'),
    secrets: ['ANTHROPIC-API-KEY'],
    capabilities: ['Draft, summarise and grade content'],
    usedIn: ['Forge Studio', 'Review Queue (inspector)', 'AI Engine'],
    dataDirection: 'Outbound: article text and prompts go to Anthropic; drafts come back.',
    securityNote: LLM_SECURITY_NOTE,
  },
  {
    id: 'openai',
    group: 'gen-ai',
    icon: Bot,
    name: 'OpenAI',
    description:
      'One of the models the site writes with, tried in the order set on the AI Engine page.',
    url: 'https://platform.openai.com/api-keys',
    test: testAiProvider('openai', 'OpenAI'),
    secrets: ['OPENAI-API-KEY'],
    capabilities: ['Draft, summarise and grade content'],
    usedIn: ['Forge Studio', 'Review Queue (inspector)', 'AI Engine'],
    dataDirection: 'Outbound: article text and prompts go to OpenAI; drafts come back.',
    securityNote: LLM_SECURITY_NOTE,
  },
  {
    id: 'nvidia',
    group: 'gen-ai',
    icon: Bot,
    name: 'NVIDIA API',
    description:
      'Free, rate-limited models: by default the backup writer for drafts, summaries and scripts.',
    url: 'https://build.nvidia.com/settings/api-keys',
    test: testAiProvider('nvidia', 'NVIDIA'),
    secrets: ['NVIDIA-API-KEY'],
    capabilities: ['Draft, summarise and grade content (backup)'],
    usedIn: ['Forge Studio', 'AI Engine'],
    dataDirection: 'Outbound: article text and prompts go to NVIDIA; drafts come back.',
    securityNote: `${LLM_SECURITY_NOTE} Locked off for the anonymous public explain routes.`,
  },

  // ── AI services (ADR 0033) ───────────────────────────────────────────────
  {
    id: 'elevenlabs',
    group: 'ai-services',
    icon: Volume2,
    name: 'ElevenLabs',
    description: 'Reads podcast episodes aloud.',
    url: 'https://elevenlabs.io/app/settings/api-keys',
    // The Audio tab's status read: plan and credits, no synthesis.
    test: testElevenLabs,
    secrets: ['ELEVENLABS-API-KEY'],
    capabilities: ['Text to speech for podcast episodes', 'List voices', 'Preview a voice'],
    usedIn: ['Recording Hub (Episodes)', 'Platform Settings (Audio)'],
    dataDirection: 'Outbound: episode scripts go to ElevenLabs; audio comes back.',
    securityNote:
      'Read on the server only. Create the key restricted to Text to Speech, User (Read) and Voices (Read), with a credit limit.',
  },
  {
    id: 'azure-speech',
    group: 'ai-services',
    icon: Volume2,
    name: 'Azure AI Speech',
    description: 'A spare narrator, ready in case the main one stops being available.',
    // The page that says where the key is read from in the portal; the portal
    // itself routes by fragment, which is a bare host to a reader of the URL.
    url: 'https://learn.microsoft.com/azure/ai-services/speech-service/overview#find-keys-and-endpoint',
    test: null,
    untestedReason:
      'Not set up on purpose: the key is deliberately unprovisioned until it is needed.',
    secrets: ['AZURE-SPEECH-KEY'],
    capabilities: ['Text to speech (standby)'],
    usedIn: [],
    dataDirection: 'None today.',
    securityNote: 'Read on the server only, once provisioned.',
  },
  {
    id: 'firecrawl',
    group: 'ai-services',
    icon: ScanText,
    name: 'Firecrawl',
    description: 'Reads a web page and pulls out its text, so a link can be summarised.',
    url: 'https://www.firecrawl.dev/app/api-keys',
    test: testFirecrawl,
    secrets: ['FIRECRAWL-API-KEY'],
    capabilities: ['Scrape a page to clean text'],
    usedIn: ['New Content (submit a URL)', 'Review Queue (inspector)'],
    dataDirection: 'Outbound: a public URL goes to Firecrawl; the page text comes back.',
    securityNote: 'Read on the server only. The test reads the credit balance and scrapes nothing.',
  },
  {
    id: 'replicate',
    group: 'ai-services',
    icon: ImageIcon,
    name: 'Replicate',
    description:
      'Generates the cover image for a post. Without it, posts use a stock image instead.',
    url: 'https://replicate.com/account/api-tokens',
    test: testReplicate,
    secrets: ['REPLICATE-API-KEY'],
    capabilities: ['Run an image model for a cover'],
    usedIn: ['Image Prompts', 'Image Gallery', 'Editor (AI cover)'],
    dataDirection:
      'Outbound: a prompt goes to Replicate; the image comes back and is stored in Blob.',
    securityNote: 'Read on the server only. The test reads the account and starts no prediction.',
  },

  // ── Cloud ────────────────────────────────────────────────────────────────
  {
    id: 'cloud-pricing',
    group: 'cloud',
    icon: Coins,
    name: 'Cloud pricing cache',
    description:
      'The daily snapshot of AWS, Azure and Google Cloud list prices behind the public pricing comparison page.',
    // Where the cache is shown, since nothing else "lives" anywhere: the keys
    // below are minted at each provider and the Keys tab links there.
    url: 'https://hybridcloudworks.com/tools/comparison',
    // Reads what the public page reads and judges its age, not a credential.
    test: testCloudPricing,
    // The two provider keys the refresh spends. Azure's price list needs none.
    secrets: ['AWS-ACCESS-KEY-ID', 'AWS-SECRET-ACCESS-KEY', 'GCP-BILLING-API-KEY'],
    // The one service the site fills itself, so the card carries the button
    // that fills it (CloudPricingRefresh), the way Sessionize carries its id.
    action: 'refreshCloudPricing',
    capabilities: ['Read three public price lists', 'Refresh the cached comparison'],
    usedIn: ['Public pricing comparison'],
    dataDirection: 'Inbound: list prices come from the providers; nothing of ours goes out.',
    securityNote: 'Read on the server only. Scope the AWS policy to pricing:GetProducts.',
  },

  // ── Code quality ─────────────────────────────────────────────────────────
  {
    id: 'qlty',
    group: 'code-quality',
    icon: ShieldCheck,
    name: 'Qlty',
    description:
      'Scans the repository for maintainability and security issues. Its grades feed the Health page.',
    // Where the access token is minted.
    url: 'https://qlty.sh/user/settings/tokens',
    // Server-side: GET /user with the stored token, which never reaches a browser.
    test: testQlty,
    secrets: ['QLTY-API-TOKEN'],
    capabilities: ['Read grades and open findings'],
    usedIn: ['Health (Code and Security)'],
    dataDirection: 'Inbound: findings come from Qlty; nothing goes out.',
    securityNote: 'A personal token read on the server only.',
  },

  // ── Hybrid Lab (ADR 0033) ────────────────────────────────────────────────
  {
    id: 'hybrid-lab',
    group: 'labs',
    icon: FlaskConical,
    name: 'Hybrid Lab (Coder and Turnstile)',
    description:
      'The browser workspaces behind the labs page, and the check that lets a visitor send the lab a job.',
    url: 'https://developers.cloudflare.com/turnstile/',
    // The public labs card's own read, cached server-side.
    test: testHybridLab,
    secrets: ['CODER-URL', 'CODER-STATUS-TOKEN', 'TURNSTILE-SECRET-KEY'],
    // Two services behind one card, so the keys say which is which: Coder's
    // two values together, with what the lab host last reported about
    // renewing the status token (2026-10-08), and Turnstile's apart.
    keyGroups: [
      { title: 'Coder', secrets: ['CODER-URL', 'CODER-STATUS-TOKEN'], panel: 'coderAutomation' },
      { title: 'Turnstile', secrets: ['TURNSTILE-SECRET-KEY'] },
    ],
    capabilities: ['List lab templates', 'Count running workspaces', 'Verify a browser check'],
    usedIn: ['Labs', 'Public labs page', 'Landing Zone Builder'],
    dataDirection:
      'Inbound: workspace status comes from Coder, and the lab host hands over a renewed status token; a Turnstile token goes to Cloudflare to verify.',
    securityNote:
      'The status token is read-only in Coder and never reaches a browser; a renewed one from the lab host is stored only after Coder shows it is a working, read-only key of the status user. The Turnstile secret goes to Cloudflare siteverify and nowhere else.',
  },

  // ── Tool add-ons (ADR 0035) ─────────────────────────────────────────────
  {
    id: 'migration-addon',
    group: 'addons',
    icon: ArrowRightLeft,
    name: 'Migration add-on',
    description:
      'The Azure migration assessment shown in a pane on the Migration Hub: its own container on the lab host, read through the status proxy.',
    url: 'https://github.com/saulpatinojr/HCW-AzMigrateOrchestrator_Addon/releases',
    // The pane page's own read, cached server-side.
    test: testMigrationAddon,
    // No site secret: the add-on's human-verification secret lives in the
    // lab host's Ansible vault (vault_addon_migration_turnstile_secret) and
    // is listed on Credentials, not here.
    secrets: [],
    capabilities: ['Read the add-on version and edition', 'Decide whether the pane opens'],
    usedIn: ['Tools (Migration Hub)'],
    dataDirection:
      'Inbound only: the Function App reads the add-on’s health; the add-on holds no site credential and nothing goes out to it.',
    securityNote:
      'The address is a plain app setting (ADDON_MIGRATION_URL), public because it is the frame’s source and in the CSP. The browser never calls the add-on’s API; a visitor’s upload goes to the add-on inside the pane and is held in memory for at most two hours.',
  },
]);

/** A service by id, or undefined. Read by the Health probe registry. */
export const serviceById = (id) => SERVICES.find((service) => service.id === id);
