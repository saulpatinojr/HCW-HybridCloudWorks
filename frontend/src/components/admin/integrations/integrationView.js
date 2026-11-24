/**
 * The joins behind the Integrations Hub's tabs (#570). Pure, so each can be
 * tested without a network or a DOM.
 *
 *   buildIntegrationView  services with their credentials, sorted into groups
 *                         (Services tab); moved unchanged from IntegrationsPage
 *   buildKeyGroups        every credential under its group, each naming the
 *                         services that use it (Keys tab)
 *   serviceStatus         one word for a service, from its keys and this
 *                         session's test (Overview tab)
 *   sortByStatus          broken and not-configured first
 */

import { SYSTEM_STATUS, classifyFailure } from '@/lib/status';
import { SERVICES, SERVICE_GROUPS } from './serviceRegistry';

// ── Joining the two halves ────────────────────────────────────────────────────

/**
 * Give every credential to the service that owns it, and keep the rest.
 *
 * Pure, so the join can be tested without a network or a DOM. A secret named
 * by a service but absent from the API response is skipped rather than
 * rendered as an empty row — the catalogue can grow a name this page has not
 * been taught yet, and the honest rendering of that is nothing.
 *
 * @param {{ services?: ReadonlyArray<object>, groups?: ReadonlyArray<object>, sections?: ReadonlyArray<object>, secrets?: ReadonlyArray<object> }} input
 * @returns {{ serviceCards: Array<object>, serviceGroups: Array<object>, orphanSections: Array<object> }}
 *   `serviceCards` is every card in registry order; `serviceGroups` is the
 *   same cards under their headings, which is what the page renders.
 */
export function buildIntegrationView({
  services = SERVICES,
  groups = SERVICE_GROUPS,
  sections = [],
  secrets = [],
} = {}) {
  const bySecretName = new Map((secrets ?? []).map((item) => [item.secret, item]));
  const claimed = new Set();

  const serviceCards = services.map((service) => {
    const items = (service.secrets ?? [])
      .map((name) => {
        const item = bySecretName.get(name);
        if (item) claimed.add(name);
        return item;
      })
      .filter(Boolean);
    return { ...service, items };
  });

  // The safety net, and normally empty. Every credential is shown under its
  // group below; this catches one whose section matches NO group at all,
  // which would otherwise disappear from the page entirely. A key nobody can
  // see is a key nobody can rotate, so it gets a heading of its own rather
  // than silence. `sections` supplies the titles when it can.
  const groupIds = new Set((groups ?? []).map((group) => group.id));
  const byId = new Map((sections ?? []).map((section) => [section.id, section]));
  const orphanSections = [
    ...new Set(
      (secrets ?? [])
        .filter((item) => !claimed.has(item.secret) && !groupIds.has(item.section))
        .map((item) => item.section)
    ),
  ].map((id) => ({
    id,
    title: byId.get(id)?.title ?? id,
    blurb: byId.get(id)?.blurb ?? 'These have no group on this page yet.',
    items: (secrets ?? []).filter((item) => item.section === id && !claimed.has(item.secret)),
  }));

  // Cards, sorted into their headings. A group with no cards is dropped
  // rather than rendered as an empty heading, and a service whose `group` is
  // not in SERVICE_GROUPS falls into the last one rather than vanishing -
  // silently dropping a card is the failure mode worth avoiding here.
  const known = new Set(groups.map((group) => group.id));
  const fallback = groups.length ? groups[groups.length - 1].id : null;
  //
  // Each group carries BOTH its service cards and the credentials in that
  // group that no card claimed. The page used to render every card in one
  // flat list and then sweep the remaining keys into a separate "Other
  // credentials" bucket organised on different lines, so Publer's card and
  // Publer's keys could appear under two different words. One taxonomy, one
  // pass, and a credential is always under the same heading as the service it
  // belongs to.
  const serviceGroups = groups
    .map((group) => ({
      ...group,
      cards: serviceCards.filter((card) =>
        known.has(card.group) ? card.group === group.id : group.id === fallback
      ),
      loose: (secrets ?? []).filter(
        (item) => item.section === group.id && !claimed.has(item.secret)
      ),
    }))
    // `platform` used to survive an empty result because it carried the Entra
    // configuration panel (#519). That panel has its own Identity tab now
    // (#570), so an empty platform group is as empty as any other.
    .filter((group) => group.cards.length > 0 || group.loose.length > 0);

  return { serviceCards, serviceGroups, orphanSections };
}

// ── Keys tab ──────────────────────────────────────────────────────────────────

/**
 * Every credential under its group, each naming the services that use it.
 *
 * Unlike `buildIntegrationView`, a key a service claims stays in the list: the
 * Keys tab is where every key lives, and "used by" is the service join. A
 * section no group knows gets its own entry in `otherSections`, so a key is
 * never off the page — a key nobody can see is a key nobody can rotate.
 *
 * @returns {{ groups: Array<object>, otherSections: Array<object> }}
 */
export function buildKeyGroups({
  services = SERVICES,
  groups = SERVICE_GROUPS,
  sections = [],
  secrets = [],
} = {}) {
  const usedBy = new Map();
  for (const service of services) {
    for (const name of service.secrets ?? []) {
      usedBy.set(name, [...(usedBy.get(name) ?? []), service.name]);
    }
  }
  // Which of those services can be asked whether the key works (ADR 0033):
  // a key with no timer-driven liveness check may still be checked by the
  // beaker on its service card, and the Keys row says which.
  const testedBy = new Map();
  for (const service of services) {
    if (!service.test) continue;
    for (const name of service.secrets ?? []) {
      testedBy.set(name, [...(testedBy.get(name) ?? []), service.name]);
    }
  }
  const rows = (secrets ?? []).map((item) => ({
    ...item,
    usedBy: usedBy.get(item.secret) ?? [],
    testedBy: testedBy.get(item.secret) ?? [],
  }));
  const groupIds = new Set(groups.map((group) => group.id));
  const byId = new Map((sections ?? []).map((section) => [section.id, section]));

  const keyGroups = groups
    .map((group) => ({ ...group, items: rows.filter((row) => row.section === group.id) }))
    .filter((group) => group.items.length > 0);

  const otherSections = [
    ...new Set(rows.filter((row) => !groupIds.has(row.section)).map((row) => row.section)),
  ].map((id) => ({
    id,
    title: byId.get(id)?.title ?? id,
    blurb: byId.get(id)?.blurb ?? 'These have no group on this page yet.',
    items: rows.filter((row) => row.section === id),
  }));

  return { groups: keyGroups, otherSections };
}

// ── Overview tab ──────────────────────────────────────────────────────────────

/**
 * The Overview's words for a service, worst first. The order IS the sort: a
 * broken service is the one to look at, then one nobody has set up.
 */
export const SERVICE_STATUS = Object.freeze({
  // `badge` is what StatusBadge renders: the shared vocabulary of
  // lib/status.js (ADR 0033 §2), so this page's words are the Health page's.
  // A refused key or a failing test answered and said no: critical. A test
  // that could not reach the service at all: offline (lib/status.js
  // classifyFailure). Both rank first; a missing key is next.
  broken: { rank: 0, label: 'Critical', tone: 'failing', badge: SYSTEM_STATUS.critical },
  offline: { rank: 0, label: 'Offline', tone: 'failing', badge: SYSTEM_STATUS.offline },
  'not-configured': {
    rank: 1,
    label: 'Critical',
    tone: 'never',
    badge: SYSTEM_STATUS.critical,
  },
  pending: { rank: 2, label: 'Degraded', tone: 'pending', badge: SYSTEM_STATUS.degraded },
  untested: { rank: 3, label: 'Unknown', tone: null, badge: SYSTEM_STATUS.unknown },
  ok: { rank: 4, label: 'Healthy', tone: 'live', badge: SYSTEM_STATUS.healthy },
  // A card whose sign-ins this site lists and does not hold (ListedCredential):
  // there is nothing here to test, and it is not a public profile either.
  listed: {
    rank: 5,
    label: 'Listed, not held',
    tone: null,
    badge: {
      id: 'listed',
      label: 'Listed, not held',
      tone: 'muted',
      help: 'Sign-ins this site lists and does not hold, so it cannot test them. Each box on the card says how to check its own.',
    },
  },
  'link-only': {
    rank: 5,
    label: 'Profile link',
    tone: null,
    badge: {
      id: 'link-only',
      label: 'Profile link',
      tone: 'muted',
      help: 'A public profile; nothing to test.',
    },
  },
});

/**
 * The shared status for one test result (`{ ok, message }`): a pass is
 * healthy, nothing yet is unknown, and a failure is critical or offline by
 * the one rule in lib/status.js — a missing setting or a refusal is
 * critical, a service that could not be reached is offline.
 */
export function resultStatus(result) {
  if (!result) return SYSTEM_STATUS.unknown;
  if (result.ok) return SYSTEM_STATUS.healthy;
  return SYSTEM_STATUS[classifyFailure(result.message)];
}

/**
 * One status for a service, from its credential lights and this session's
 * test result (`{ ok, message, at }` or undefined).
 *
 * A failed test outranks green keys: the light is the last verdict a server
 * recorded, and a test is the newest evidence there is. A passing test does
 * NOT outrank a rejected or unset key, because some tests judge one key of two
 * (Telegram's getMe never reads the chat id).
 */
export function serviceStatus(card, result) {
  const states = (card.items ?? []).map((item) => item.state);
  if (result?.ok === false) {
    return classifyFailure(result.message) === 'offline' ? 'offline' : 'broken';
  }
  if (states.includes('failing')) return 'broken';
  if (states.includes('never')) return 'not-configured';
  if (states.includes('pending')) return 'pending';
  if (result?.ok === true) return 'ok';
  if (!card.test) {
    if (states.length > 0) return 'ok';
    return (card.keyGroups ?? []).some((group) => group.panel) ? 'listed' : 'link-only';
  }
  return 'untested';
}

/** Cards with their status, worst first; registry order breaks ties. */
export function sortByStatus(cards, results = {}) {
  return cards
    .map((card, index) => ({ card, index, status: serviceStatus(card, results[card.id]) }))
    .sort(
      (a, b) => SERVICE_STATUS[a.status].rank - SERVICE_STATUS[b.status].rank || a.index - b.index
    )
    .map(({ card, status }) => ({ ...card, status }));
}
