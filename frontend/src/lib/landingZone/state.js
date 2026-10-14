/**
 * The build as a value (#667): which components are selected and what the
 * knobs are set to, with the dependency rule enforced so the state can never
 * describe a firewall without a hub or a corp landing zone without a tree.
 *
 *   { selected: string[], options: { location, rootParentId, hubCidr, spokeCidr,
 *     privateDnsZones, firewallSku, corpCount, onlineCount },
 *     warnings: [{ code, from, to }] }
 *
 * `selected` is in catalogue order. The application components are counted
 * as well as selected: `corp` is in `selected` exactly when `corpCount` is
 * above zero, and `normalizeState` keeps the two in step whichever one a
 * caller changed. The two address ranges are checked against each other as
 * well as on their own: a spoke range that overlaps the hub is replaced by
 * the first fallback that does not, and `warnings` says so, so a page can
 * tell the reader what changed and why. Every function here is pure and
 * returns a new state.
 */
import { cidrsOverlap } from './cidr';
import {
  APPLICATION_IDS,
  COMPONENTS,
  COMPONENT_IDS,
  OPTIONS,
  OPTION_IDS,
  PLATFORM_IDS,
  componentById,
  countOptionFor,
  isComponentId,
} from './components';

export { isComponentId };

/**
 * Where the spoke range goes when it overlaps the hub, tried in order: the
 * default first, then the next /16 up, then a range in a different private
 * block for a hub that owns all of 10/8.
 */
export const SPOKE_CIDR_FALLBACKS = Object.freeze(['10.1.0.0/16', '10.2.0.0/16', '172.16.0.0/16']);

/**
 * The cross-option rule: the hub keeps its value, the spoke range moves.
 * Mutates `options`; returns the warnings it raised (none when the pair
 * was already apart).
 */
function separateSpokeFromHub(options) {
  if (!cidrsOverlap(options.hubCidr, options.spokeCidr)) return [];
  const to =
    SPOKE_CIDR_FALLBACKS.find((candidate) => !cidrsOverlap(options.hubCidr, candidate)) ??
    SPOKE_CIDR_FALLBACKS[SPOKE_CIDR_FALLBACKS.length - 1];
  const from = options.spokeCidr;
  options.spokeCidr = to;
  return [{ code: 'spoke-cidr-overlap', from, to }];
}

/** Every option at its default. */
export const DEFAULT_OPTIONS = Object.freeze(
  Object.fromEntries(OPTION_IDS.map((id) => [id, OPTIONS[id].default]))
);

/**
 * The default build is the whole landing zone: every platform component and
 * one corp and one online landing zone. It is what the validated pattern
 * deploys, and it is what a bare URL means.
 */
export const DEFAULT_SELECTION = COMPONENT_IDS;

const inCatalogueOrder = (ids) => COMPONENT_IDS.filter((id) => ids.has(id));

/**
 * The selection with every dependency added, transitively, in catalogue
 * order. Unknown ids are dropped.
 */
export function withDependencies(ids) {
  const chosen = new Set();
  const visit = (id) => {
    if (!isComponentId(id) || chosen.has(id)) return;
    chosen.add(id);
    for (const dep of componentById(id).dependsOn) visit(dep);
  };
  for (const id of Array.isArray(ids) ? ids : []) visit(id);
  return inCatalogueOrder(chosen);
}

/** Every component that depends on `id`, transitively, in catalogue order. */
export function dependentsOf(id) {
  const out = new Set();
  const visit = (target) => {
    for (const c of COMPONENTS) {
      if (c.dependsOn.includes(target) && !out.has(c.id)) {
        out.add(c.id);
        visit(c.id);
      }
    }
  };
  visit(id);
  return inCatalogueOrder(out);
}

/** One option's value, or its default when the value does not validate. */
function normalizeOption(id, value) {
  const spec = OPTIONS[id];
  if (spec.kind === 'count') {
    return spec.validate(value) ? Number(value) : spec.default;
  }
  return spec.validate(value) ? value : spec.default;
}

/** Every option present and valid; anything missing or invalid is its default. */
export function normalizeOptions(partial) {
  const out = {};
  for (const id of OPTION_IDS) out[id] = normalizeOption(id, partial?.[id]);
  return out;
}

/**
 * A full state from a partial one. With no `selected` the build is the
 * default, less any application component whose count is zero. With a
 * `selected` list, the list is authoritative: unknown ids are dropped,
 * dependencies are added, a counted component in the list has a count of at
 * least one and one absent from it has a count of zero. A spoke range that
 * overlaps the hub is moved to a fallback, with a warning.
 */
export function normalizeState(partial) {
  const options = normalizeOptions(partial?.options);
  const warnings = separateSpokeFromHub(options);
  let requested;
  if (Array.isArray(partial?.selected)) {
    requested = partial.selected;
  } else {
    requested = DEFAULT_SELECTION.filter((id) => {
      const countId = countOptionFor(id);
      return countId === null || options[countId] > 0;
    });
  }
  const selected = withDependencies(requested);
  for (const id of APPLICATION_IDS) {
    const countId = countOptionFor(id);
    if (selected.includes(id)) options[countId] = Math.max(1, options[countId]);
    else options[countId] = 0;
  }
  const result = { selected, options, warnings };
  if (partial?.cloud) {
    result.cloud = partial.cloud;
  }
  return result;
}

export const DEFAULT_STATE = Object.freeze(normalizeState({}));

export function isSelected(state, id) {
  return Array.isArray(state?.selected) && state.selected.includes(id);
}

/** The state with `id` and its dependencies selected. */
export function addComponent(state, id) {
  const current = normalizeState(state);
  if (!isComponentId(id)) return current;
  return normalizeState({ ...current, selected: [...current.selected, id] });
}

/** The state with `id` and everything that depends on it removed. */
export function removeWithDependents(state, id) {
  const current = normalizeState(state);
  if (!isComponentId(id)) return current;
  const gone = new Set([id, ...dependentsOf(id)]);
  return normalizeState({
    ...current,
    selected: current.selected.filter((s) => !gone.has(s)),
  });
}

/**
 * The state with one option changed. An invalid value leaves the option as it
 * was; a count of zero on `corpCount` or `onlineCount` deselects the
 * component, and a positive count selects it (and its dependencies).
 */
export function setOption(state, id, value) {
  const current = normalizeState(state);
  const spec = OPTIONS[id];
  if (!spec || !spec.validate(value)) return current;
  const options = { ...current.options, [id]: normalizeOption(id, value) };
  let { selected } = current;
  for (const componentId of APPLICATION_IDS) {
    if (countOptionFor(componentId) !== id) continue;
    selected =
      options[id] > 0 ? [...selected, componentId] : selected.filter((s) => s !== componentId);
  }
  return normalizeState({ ...current, selected, options });
}

/** The selected platform components, in catalogue order. */
export function selectedPlatform(state) {
  return PLATFORM_IDS.filter((id) => isSelected(state, id));
}
