/**
 * The build as a query string (#667), so a landing zone is a link:
 * `?lz=mg,policy,mgmt,hub,fw,id&hub.cidr=10.0.0.0/16&spoke.cidr=10.1.0.0/16&fw.sku=Premium&dns=0&loc=westeurope&corp=2&online=1&root=contoso`.
 *
 * `lz=` lists the selected PLATFORM components by short id; the application
 * components travel as their counts, `corp=` and `online=`, where 0 means not
 * selected. Defaults are left out, so the canonical URL for the default build
 * (everything, one corp, one online) is bare, and an empty build is
 * `?lz=&corp=0&online=0`. `root=` is the management group the alz root is
 * created under, absent for the tenant root group. Decoding is tolerant of
 * anything a hand-edited URL can carry: unknown tokens are dropped, an option
 * that fails its validator is its default, and the result is normalised, so
 * dependencies hold.
 *
 * Same contract as pricingScenarios/share.js: `encodeLz` returns plain
 * entries for URLSearchParams, `decodeLz` reads URLSearchParams or a plain
 * object, `isLzParam` says which keys are this module's.
 */
import { DEFAULT_OPTIONS, normalizeOptions, normalizeState, selectedPlatform } from './state';
import {
  OPTIONS,
  OPTION_IDS,
  PLATFORM_IDS,
  componentById,
  componentByShortId,
  countOptionFor,
} from './components';

const SELECTION_KEY = 'lz';

const CLOUD_KEY = 'cloud';

/** Option id → query key, in the order the documented URL lists them. */
const OPTION_KEYS = Object.freeze({
  hubCidr: 'hub.cidr',
  spokeCidr: 'spoke.cidr',
  firewallSku: 'fw.sku',
  privateDnsZones: 'dns',
  location: 'loc',
  corpCount: 'corp',
  onlineCount: 'online',
  rootParentId: 'root',
});

const OWN_KEYS = new Set([SELECTION_KEY, CLOUD_KEY, ...Object.values(OPTION_KEYS)]);

/** The query keys this module owns. */
export function isLzParam(key) {
  return OWN_KEYS.has(key);
}

function encodeOption(id, value) {
  if (OPTIONS[id].kind === 'boolean') return value ? '1' : '0';
  return String(value);
}

/**
 * The build as query entries: `lz=` only when the platform selection is not
 * the full set, and each option only when it differs from its default.
 *
 * @returns {Record<string, string>}
 */
export function encodeLz(state) {
  const normalized = normalizeState(state);
  const out = {};
  const cloud = state?.cloud || normalized.cloud;
  if (cloud && cloud !== 'azure') {
    out[CLOUD_KEY] = cloud;
  }
  const platform = selectedPlatform(normalized);
  if (platform.length !== PLATFORM_IDS.length) {
    out[SELECTION_KEY] = platform.map((id) => componentById(id).shortId).join(',');
  }
  for (const [id, key] of Object.entries(OPTION_KEYS)) {
    const value = normalized.options[id];
    if (value !== DEFAULT_OPTIONS[id]) out[key] = encodeOption(id, value);
  }
  return out;
}

/** One parameter from a URLSearchParams or a plain object; null when absent. */
function readParam(searchParams, key) {
  if (!searchParams) return null;
  if (typeof searchParams.get === 'function') return searchParams.get(key);
  return Object.prototype.hasOwnProperty.call(searchParams, key) ? searchParams[key] : null;
}

function decodeOption(id, raw) {
  if (raw === null || raw === undefined) return undefined;
  if (OPTIONS[id].kind === 'boolean') {
    if (raw === '1' || raw === 'true') return true;
    if (raw === '0' || raw === 'false') return false;
    return undefined;
  }
  return raw;
}

/** The platform ids an `lz=` value names; every platform id when the key is absent. */
function decodeSelection(raw) {
  if (raw === null || raw === undefined) return new Set(PLATFORM_IDS);
  const selected = new Set();
  for (const token of String(raw).split(',')) {
    const c = componentByShortId(token.trim());
    if (c) selected.add(c.id);
  }
  return selected;
}

/**
 * The inverse of `encodeLz`. An absent `lz=` means the full platform; a
 * present one, even empty, means exactly the platform components it names.
 * A count above zero selects its application component, and a `corp` or
 * `online` token in `lz=` does too. Unknown tokens and invalid values fall
 * away; the result is normalised.
 *
 * @param {URLSearchParams|Record<string,string>|null} searchParams
 */
export function decodeLz(searchParams) {
  const get = (key) => readParam(searchParams, key);
  const rawCloud = get(CLOUD_KEY);
  const cloud = rawCloud === 'aws' || rawCloud === 'gcp' ? rawCloud : undefined;
  const options = {};
  for (const id of OPTION_IDS) {
    const value = decodeOption(id, get(OPTION_KEYS[id]));
    if (value !== undefined) options[id] = value;
  }
  const counts = normalizeOptions(options);
  const selected = decodeSelection(get(SELECTION_KEY));
  for (const id of ['corp', 'online']) {
    if (counts[countOptionFor(id)] > 0) selected.add(id);
  }
  // Normalised once, here, so the cross-option fallback's warning is the one returned.
  return normalizeState({ cloud, selected: [...selected], options });
}
