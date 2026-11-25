/**
 * config-fields.js — the shape of an ai_providers or mcp_servers document:
 * which fields a write may name, their types, which fields only the OAuth
 * Connect flow writes, and what a read hides. Pure. The routes, and why each
 * rule exists, are in ./config-collections.js, which re-exports the
 * allowlists so callers and tests import what they always did.
 */

/** Allowlists for config collections (AP-B6). */
export const AI_PROVIDER_FIELDS = Object.freeze([
  'id',
  'name',
  'enabled',
  'order',
  'apiKeyEnvVar',
  'model',
  'defaultModel',
  'baseUrl',
  'apiVersion',
  'temperature',
  'maxTokens',
  'timeoutMs',
  'models',
  'description',
  'notes',
  'status',
  'lastError',
  'lastTestedAt',
  'createdAt',
  'updatedAt',
]);

export const MCP_SERVER_FIELDS = Object.freeze([
  'id',
  'name',
  'url',
  'transport',
  'apiKeyEnvVar',
  'enabled',
  'order',
  'authType',
  'allowedTools',
  'oauthToken',
  'oauthRefreshToken',
  'description',
  'notes',
  'headers',
  'status',
  'lastError',
  'lastTestedAt',
  'tools',
  'createdAt',
  'updatedAt',
]);

// The token values are write-only, but consumers need to know whether one is
// stored (RecordingsPage renders 'connected' from status + token presence,
// and since 2026-09-05 shows whether the 12-hour refresh timer has a refresh
// token to work with) — so reads carry a boolean in place of each. The OAuth
// Connect flow's client secret and pending sign-in (PKCE verifier, state
// hash) are write-only too (2026-10-08, ai/mcp-oauth.js), with no boolean:
// nothing on the page needs to know they exist.
export const stripOAuthToken = ({
  oauthToken,
  oauthRefreshToken,
  oauthClientSecret: _clientSecret,
  oauthPending: _pending,
  ...rest
}) => ({
  ...rest,
  hasOauthToken: Boolean(oauthToken),
  hasOauthRefreshToken: Boolean(oauthRefreshToken),
});

/**
 * Fields only the OAuth Connect flow writes (ai/mcp-oauth-handlers.js), never
 * a config write. `oauth.tokenEndpoint` is where the refresh token is POSTed
 * and `oauthPending` is what a callback is checked against, so a browser that
 * could set either could have a stored refresh token sent to a host it
 * chose. They are dropped from every PUT and PATCH body, silently, because a
 * form round-tripping a read carries the readable two back; a PUT keeps the
 * stored values (carryForwardTokens).
 */
export const SERVER_MANAGED_OAUTH_FIELDS = Object.freeze([
  'oauth',
  'oauthClient',
  'oauthClientSecret',
  'oauthPending',
]);

export function withoutServerManagedFields(container, fields) {
  if (container !== 'mcp_servers') return fields;
  const kept = { ...fields };
  for (const key of SERVER_MANAGED_OAUTH_FIELDS) delete kept[key];
  return kept;
}

/**
 * The sentence refusing a body that names a nested path, or null
 * (2026-10-08, security review of the OAuth Connect change). A PATCH reaches
 * Cosmos as field-path operations, and `a.b` is a NESTED write
 * (cosmos-client.js toJsonPointer): `oauth.tokenEndpoint` would slip past the
 * whole-field guard above and point the refresh — refresh token and client
 * secret — at a host an editor chose, and `allowedTools.0` would slip past
 * #995's super_admin rule. Every check on these routes reads top-level
 * fields whole, and no caller writes a nested one, so no dotted name is
 * accepted on either collection.
 */
export function nestedFieldError(fields) {
  const nested = Object.keys(fields).find((key) => key.includes('.'));
  return nested
    ? `Field "${nested.slice(0, 80)}" names a nested path; send the whole top-level field instead.`
    : null;
}

/** What a read of this container returns: tokens stripped for mcp_servers. */
export const readableDoc = (container, doc) => (container === 'mcp_servers' ? stripOAuthToken(doc) : doc);

const isSet = (value) => value !== undefined && value !== null;
/** A rule that lets a missing or null value through and checks any other. */
const optional = (check) => (value) => !isSet(value) || check(value);
const isStringArray = (value) => Array.isArray(value) && value.every((item) => typeof item === 'string');
const isString = (value) => typeof value === 'string';

/** `[field, check, sentence]`, the type rules both collections share, in the order they are reported. */
const SHARED_TYPE_RULES = [
  ['enabled', (value) => value === undefined || typeof value === 'boolean', 'enabled must be a boolean'],
  [
    'order',
    optional((value) => Number.isInteger(Number(value)) && Number(value) >= 0),
    'order must be a non-negative integer',
  ],
  ['name', optional(isString), 'name must be a string'],
  ['apiKeyEnvVar', optional(isString), 'apiKeyEnvVar must be a string or null'],
];

/** Each collection's type rules: the shared ones first, then its own. */
const TYPE_RULES = {
  mcp_servers: [
    ...SHARED_TYPE_RULES,
    ['allowedTools', optional(isStringArray), 'allowedTools must be an array of strings'],
    ['transport', optional(isString), 'transport must be a string'],
  ],
  ai_providers: [
    ...SHARED_TYPE_RULES,
    [
      'temperature',
      optional((value) => {
        const t = Number(value);
        return Number.isFinite(t) && t >= 0 && t <= 2;
      }),
      'temperature must be a number between 0 and 2',
    ],
    [
      'maxTokens',
      optional((value) => Number.isInteger(Number(value)) && Number(value) >= 1),
      'maxTokens must be a positive integer',
    ],
    ['models', optional(isStringArray), 'models must be an array of strings'],
  ],
};

/** The first type rule `fields` breaks for this container, as its sentence, or null. */
export function validateConfigFieldTypes(container, fields) {
  const rules = TYPE_RULES[container] ?? SHARED_TYPE_RULES;
  const broken = rules.find(([key, isValid]) => !isValid(fields[key]));
  return broken ? broken[2] : null;
}

/**
 * putConfig is a full replace, and reads never return `oauthToken`
 * (deliberately — it is write-only). So a read-modify-write round trip
 * from any edit form would silently delete a stored token. Carry it
 * forward unless the caller explicitly supplied a new one; an explicit
 * empty string still clears it, which is how a token is revoked (T-314).
 * Same rule for the refresh token the 12-hour timer rotates with.
 */
export function carryForwardTokens(doc, incoming, existing) {
  // `allowedTools` rides along for a different reason (#995): a PUT that
  // omits it must not widen a server back to every tool, so an omitted list
  // keeps the stored one. Only a write that names it, at super_admin,
  // changes it. The OAuth Connect fields (2026-10-08) are never in a PUT
  // body at all (SERVER_MANAGED_OAUTH_FIELDS), so they always carry.
  // `authType` for the same reason as the list (review of #1019): a PUT that
  // left it out turned an OAuth Connect server into a plain one, past the
  // super_admin rule that reads only the fields a body names, with its
  // tokens carried forward. Changing the sign-in method is a write that
  // names it.
  for (const key of ['oauthToken', 'oauthRefreshToken', 'allowedTools', 'authType', ...SERVER_MANAGED_OAUTH_FIELDS]) {
    if (!Object.prototype.hasOwnProperty.call(incoming, key) && existing?.[key] !== undefined) {
      doc[key] = existing[key];
    }
  }
}
