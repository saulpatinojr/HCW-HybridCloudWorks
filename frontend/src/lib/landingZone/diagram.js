/**
 * The build as a picture (#667): a tidy tree of management groups with the
 * subscriptions and network pieces under them, hub peered to spokes, laid
 * out in fixed units. Pure: no viewport, no clock, no randomness, so the
 * pre-rendered SVG and the hydrated one agree byte for byte.
 *
 *   { width, height,
 *     nodes: [{ id, kind, label, x, y, w, h }],
 *     edges: [{ from, to, kind }] }
 *
 * `kind` is one of `management-group`, `policy`, `workspace`, `vnet`,
 * `firewall`, `dns`, `spoke`; `edges[].kind` is `contains` for the tree and
 * `peering` for hub-to-spoke. Layout is the classic one: every leaf takes a
 * slot, a parent is centred over its children, and rows are depths, which is
 * what makes nodes unable to overlap. One helper per branch of the tree
 * below, so each reads as the part of the picture it draws.
 */
import { spokeAddressSpace } from './cidr';
import { isSelected, normalizeState } from './state';

export const NODE_W = 168;
export const NODE_H = 48;
export const H_GAP = 24;
export const V_GAP = 40;
export const PAD = 16;

const node = (id, kind, label, children = []) => ({ id, kind, label, children });

const spokeLabel = (name, options, group, index) =>
  `${name} ${spokeAddressSpace(options.spokeCidr, group, index)}`;

// The words each cloud uses for the same boxes. Azure's are the default, so
// any other value of `cloud` draws the Azure diagram, as it always has.
const CLOUD_LABELS = {
  azure: {
    root: 'alz',
    rootUnder: 'alz',
    policy: 'Policy baseline',
    platform: 'Platform',
    management: 'Management',
    workspace: 'Log Analytics + Automation',
    connectivity: 'Connectivity',
    hub: 'Hub VNet',
    firewall: (options) => `Azure Firewall ${options.firewallSku}`,
    dns: 'Private DNS zones',
    identity: 'Identity',
    identitySpoke: 'Identity spoke',
    landingZones: 'Landing zones',
    zoneItemSuffix: '',
  },
  aws: {
    root: 'AWS Organizations Root',
    rootUnder: 'AWS Org',
    policy: 'Service Control Policies',
    platform: 'Infrastructure OUs',
    management: 'Security OU',
    workspace: 'Log Archive + CloudTrail',
    connectivity: 'Infrastructure OU',
    hub: 'Transit Gateway',
    firewall: () => 'AWS Network Firewall',
    dns: 'Route 53 Resolver',
    identity: 'Shared Services OU',
    identitySpoke: 'Identity spoke',
    landingZones: 'Workloads OU',
    zoneItemSuffix: ' VPC',
  },
  gcp: {
    root: 'Google Cloud Organization',
    rootUnder: 'GCP Org',
    policy: 'Organization Policies',
    platform: 'Platform Folders',
    management: 'Platform Folder',
    workspace: 'Central Audit Log Export',
    connectivity: 'Platform Folder',
    hub: 'Shared VPC Host',
    firewall: () => 'Cloud NGFW Policy',
    dns: 'Cloud DNS Private Zones',
    identity: 'Platform Folder',
    identitySpoke: 'Identity / WIF',
    landingZones: 'Workloads Folders',
    zoneItemSuffix: ' Project',
  },
};

const labelsFor = (cloud) =>
  cloud === 'aws' || cloud === 'gcp' ? CLOUD_LABELS[cloud] : CLOUD_LABELS.azure;

/** Management → its workspace, or null. */
function managementNode(state) {
  if (!isSelected(state, 'management')) return null;
  const words = labelsFor(state.cloud);
  return node('mg:management', 'management-group', words.management, [
    node('sub:management', 'workspace', words.workspace),
  ]);
}

/** Connectivity → the hub with its firewall and DNS, or null. */
function connectivityNode(state) {
  if (!isSelected(state, 'connectivity-hub')) return null;
  const { options } = state;
  const words = labelsFor(state.cloud);
  const hub = node('hub', 'vnet', `${words.hub} ${options.hubCidr}`);
  if (isSelected(state, 'firewall')) {
    hub.children.push(node('firewall', 'firewall', words.firewall(options)));
  }
  if (options.privateDnsZones) hub.children.push(node('dns', 'dns', words.dns));
  return node('mg:connectivity', 'management-group', words.connectivity, [hub]);
}

/** Identity → its spoke, or null. */
function identityNode(state) {
  if (!isSelected(state, 'identity')) return null;
  const words = labelsFor(state.cloud);
  return node('mg:identity', 'management-group', words.identity, [
    node('spoke:identity', 'spoke', spokeLabel(words.identitySpoke, state.options, 'identity')),
  ]);
}

/** The Platform branch, or null when none of its children is selected. */
function platformNode(state) {
  const children = [managementNode(state), connectivityNode(state), identityNode(state)].filter(
    Boolean
  );
  const label = labelsFor(state.cloud).platform;
  return children.length ? node('mg:platform', 'management-group', label, children) : null;
}

/** Corp or Online → one spoke per landing zone, or null. */
function landingZoneGroup(state, id, label) {
  if (!isSelected(state, id)) return null;
  const count = state.options[id === 'corp' ? 'corpCount' : 'onlineCount'];
  const spokes = [];
  const itemPrefix = `${label}${labelsFor(state.cloud).zoneItemSuffix}`;
  for (let i = 1; i <= count; i += 1) {
    spokes.push(
      node(`spoke:${id}-${i}`, 'spoke', spokeLabel(`${itemPrefix} ${i}`, state.options, id, i))
    );
  }
  return node(`mg:${id}`, 'management-group', label, spokes);
}

/** The Landing zones branch, or null. */
function landingZonesNode(state) {
  const children = [
    landingZoneGroup(state, 'corp', 'Corp'),
    landingZoneGroup(state, 'online', 'Online'),
  ].filter(Boolean);
  const label = labelsFor(state.cloud).landingZones;
  return children.length ? node('mg:landingzones', 'management-group', label, children) : null;
}

/** The whole tree for a state, before layout. Null when nothing is selected. */
function buildTree(state) {
  if (!isSelected(state, 'management-groups')) return null;
  const parent = state.options.rootParentId;
  const words = labelsFor(state.cloud);
  const rootLabel = parent ? `${words.rootUnder} under ${parent}` : words.root;
  const root = node('mg:alz', 'management-group', rootLabel);
  if (isSelected(state, 'policy')) root.children.push(node('policy', 'policy', words.policy));
  for (const branch of [platformNode(state), landingZonesNode(state)]) {
    if (branch) root.children.push(branch);
  }
  return root;
}

function subtreeWidth(n) {
  if (!n.children.length) return NODE_W;
  const childrenWidth = n.children.reduce((sum, c) => sum + subtreeWidth(c), 0);
  return Math.max(NODE_W, childrenWidth + H_GAP * (n.children.length - 1));
}

/** Depth-first placement: each node centred over its subtree, rows by depth. */
function place(n, left, depth, out) {
  const width = subtreeWidth(n);
  out.maxDepth = Math.max(out.maxDepth, depth);
  out.nodes.push({
    id: n.id,
    kind: n.kind,
    label: n.label,
    x: left + (width - NODE_W) / 2,
    y: PAD + depth * (NODE_H + V_GAP),
    w: NODE_W,
    h: NODE_H,
  });
  let cursor = left;
  for (const child of n.children) {
    out.edges.push({ from: n.id, to: child.id, kind: 'contains' });
    place(child, cursor, depth + 1, out);
    cursor += subtreeWidth(child) + H_GAP;
  }
}

/**
 * @returns {{ width: number, height: number,
 *   nodes: Array<{ id: string, kind: string, label: string, x: number, y: number, w: number, h: number }>,
 *   edges: Array<{ from: string, to: string, kind: string }> }}
 */
export function layoutDiagram(state) {
  const root = buildTree(normalizeState(state));
  if (!root) return { width: 0, height: 0, nodes: [], edges: [] };

  const out = { nodes: [], edges: [], maxDepth: 0 };
  place(root, PAD, 0, out);

  if (out.nodes.some((n) => n.id === 'hub')) {
    for (const n of out.nodes) {
      if (n.kind === 'spoke') out.edges.push({ from: 'hub', to: n.id, kind: 'peering' });
    }
  }

  return {
    width: PAD * 2 + subtreeWidth(root),
    height: PAD * 2 + (out.maxDepth + 1) * NODE_H + out.maxDepth * V_GAP,
    nodes: out.nodes,
    edges: out.edges,
  };
}
