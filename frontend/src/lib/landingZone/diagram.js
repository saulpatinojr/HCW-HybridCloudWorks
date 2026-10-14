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

/** Management → its workspace, or null. */
function managementNode(state) {
  if (!isSelected(state, 'management')) return null;
  const { cloud } = state;
  if (cloud === 'aws') {
    return node('mg:management', 'management-group', 'Security OU', [
      node('sub:management', 'workspace', 'Log Archive + CloudTrail'),
    ]);
  }
  if (cloud === 'gcp') {
    return node('mg:management', 'management-group', 'Platform Folder', [
      node('sub:management', 'workspace', 'Central Audit Log Export'),
    ]);
  }
  return node('mg:management', 'management-group', 'Management', [
    node('sub:management', 'workspace', 'Log Analytics + Automation'),
  ]);
}

/** Connectivity → the hub with its firewall and DNS, or null. */
function connectivityNode(state) {
  if (!isSelected(state, 'connectivity-hub')) return null;
  const { options, cloud } = state;
  if (cloud === 'aws') {
    const hub = node('hub', 'vnet', `Transit Gateway ${options.hubCidr}`);
    if (isSelected(state, 'firewall')) {
      hub.children.push(node('firewall', 'firewall', 'AWS Network Firewall'));
    }
    if (options.privateDnsZones) hub.children.push(node('dns', 'dns', 'Route 53 Resolver'));
    return node('mg:connectivity', 'management-group', 'Infrastructure OU', [hub]);
  }
  if (cloud === 'gcp') {
    const hub = node('hub', 'vnet', `Shared VPC Host ${options.hubCidr}`);
    if (isSelected(state, 'firewall')) {
      hub.children.push(node('firewall', 'firewall', 'Cloud NGFW Policy'));
    }
    if (options.privateDnsZones) hub.children.push(node('dns', 'dns', 'Cloud DNS Private Zones'));
    return node('mg:connectivity', 'management-group', 'Platform Folder', [hub]);
  }
  const hub = node('hub', 'vnet', `Hub VNet ${options.hubCidr}`);
  if (isSelected(state, 'firewall')) {
    hub.children.push(node('firewall', 'firewall', `Azure Firewall ${options.firewallSku}`));
  }
  if (options.privateDnsZones) hub.children.push(node('dns', 'dns', 'Private DNS zones'));
  return node('mg:connectivity', 'management-group', 'Connectivity', [hub]);
}

/** Identity → its spoke, or null. */
function identityNode(state) {
  if (!isSelected(state, 'identity')) return null;
  const { cloud } = state;
  if (cloud === 'aws') {
    return node('mg:identity', 'management-group', 'Shared Services OU', [
      node('spoke:identity', 'spoke', spokeLabel('Identity spoke', state.options, 'identity')),
    ]);
  }
  if (cloud === 'gcp') {
    return node('mg:identity', 'management-group', 'Platform Folder', [
      node('spoke:identity', 'spoke', spokeLabel('Identity / WIF', state.options, 'identity')),
    ]);
  }
  return node('mg:identity', 'management-group', 'Identity', [
    node('spoke:identity', 'spoke', spokeLabel('Identity spoke', state.options, 'identity')),
  ]);
}

/** The Platform branch, or null when none of its children is selected. */
function platformNode(state) {
  const children = [managementNode(state), connectivityNode(state), identityNode(state)].filter(
    Boolean
  );
  const { cloud } = state;
  let label = 'Platform';
  if (cloud === 'aws') {
    label = 'Infrastructure OUs';
  } else if (cloud === 'gcp') {
    label = 'Platform Folders';
  }
  return children.length ? node('mg:platform', 'management-group', label, children) : null;
}

/** Corp or Online → one spoke per landing zone, or null. */
function landingZoneGroup(state, id, label) {
  if (!isSelected(state, id)) return null;
  const count = state.options[id === 'corp' ? 'corpCount' : 'onlineCount'];
  const spokes = [];
  const { cloud } = state;
  let itemPrefix = label;
  if (cloud === 'aws') {
    itemPrefix = `${label} VPC`;
  } else if (cloud === 'gcp') {
    itemPrefix = `${label} Project`;
  }
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
  const { cloud } = state;
  let label = 'Landing zones';
  if (cloud === 'aws') {
    label = 'Workloads OU';
  } else if (cloud === 'gcp') {
    label = 'Workloads Folders';
  }
  return children.length ? node('mg:landingzones', 'management-group', label, children) : null;
}

/** The whole tree for a state, before layout. Null when nothing is selected. */
function buildTree(state) {
  if (!isSelected(state, 'management-groups')) return null;
  const parent = state.options.rootParentId;
  const { cloud } = state;
  let rootLabel = parent ? `alz under ${parent}` : 'alz';
  let policyLabel = 'Policy baseline';
  if (cloud === 'aws') {
    rootLabel = parent ? `AWS Org under ${parent}` : 'AWS Organizations Root';
    policyLabel = 'Service Control Policies';
  } else if (cloud === 'gcp') {
    rootLabel = parent ? `GCP Org under ${parent}` : 'Google Cloud Organization';
    policyLabel = 'Organization Policies';
  }
  const root = node('mg:alz', 'management-group', rootLabel);
  if (isSelected(state, 'policy')) root.children.push(node('policy', 'policy', policyLabel));
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
