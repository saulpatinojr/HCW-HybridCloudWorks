/**
 * The Landing Zone Builder's catalogue (#667): the eight components a learner
 * assembles, what each one teaches, which module deploys it, what it depends
 * on, and the knobs it exposes.
 *
 * Two groups. `platform` is what the organisation runs once: the management
 * group tree, the policy baseline, central logging, the hub network, the
 * firewall in it, and identity. `application` is what teams get, N times:
 * corp landing zones (reached through the hub) and online landing zones
 * (internet-facing). The names are the ones HashiCorp's validated pattern and
 * the `alz` architecture definition use, so a learner who reads on meets the
 * same words.
 *
 * `teaches` is the hand-written explanation, three to five sentences a
 * beginner reads: what the thing is, why a landing zone has it, and what
 * breaks without it. `avm` is the Azure Verified Module that deploys the
 * component, or null when the component is configuration of another
 * module's call (policy sits inside avm-ptn-alz; the firewall is a block of
 * the connectivity module). A landing zone, identity included, is a
 * subscription placed in the tree by avm-ptn-alz plus a spoke virtual
 * network from the virtual network module, peered to the hub. Every `avm`
 * comes from avmVersions.js so the catalogue and the pins cannot disagree.
 */
import { AVM_MODULES } from './avmVersions';
import { isCidr, isSpokeCidr } from './cidr';

export { isCidr, isSpokeCidr };

const pin = (name) =>
  Object.freeze({ source: AVM_MODULES[name].source, version: AVM_MODULES[name].version });

/** Azure Firewall SKUs, in price order. */
export const FIREWALL_SKUS = Object.freeze(['Basic', 'Standard', 'Premium']);

/** How many application landing zones of one kind a build may hold. */
export const MAX_LANDING_ZONES = 5;

export function isFirewallSku(value) {
  return FIREWALL_SKUS.includes(value);
}

/** What an Azure region id looks like: `centralus`, `westeurope`, `uksouth`. */
const REGION_ID = /^[a-z][a-z0-9]{2,31}$/;

export function isLocation(value) {
  return typeof value === 'string' && REGION_ID.test(value);
}

/**
 * An integer count of landing zones, 0 to MAX_LANDING_ZONES: a number, or a
 * string of digits only. Whitespace, signs, an empty string and anything
 * `Number` would quietly turn into 0 are refused, so a blank field or a
 * `corp=%20` in the URL falls back to the default rather than deselecting.
 */
export function isLandingZoneCount(value) {
  if (typeof value === 'string') {
    return /^[0-9]+$/.test(value) && Number(value) <= MAX_LANDING_ZONES;
  }
  return (
    typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_LANDING_ZONES
  );
}

/**
 * A management group id: letters, digits, hyphen, underscore, period and
 * parentheses, up to 90 characters, not starting with punctuation.
 */
const MANAGEMENT_GROUP_ID = /^[A-Za-z0-9][A-Za-z0-9._()-]{0,89}$/;

export function isManagementGroupId(value) {
  return typeof value === 'string' && MANAGEMENT_GROUP_ID.test(value);
}

/** The parent of the alz root: a management group id, or '' for the tenant root group. */
export function isRootParentId(value) {
  return value === '' || isManagementGroupId(value);
}

export function isBoolean(value) {
  return typeof value === 'boolean';
}

/**
 * One knob. `kind` is what a Phase 2 form renders: `text`, `choice` (see
 * OPTION_CHOICES), `boolean` or `count`; `validate` is the predicate a value
 * must pass, and `default` is what an absent or failing value becomes.
 */
const option = (spec) => Object.freeze({ ...spec });

/** Every knob, with its default and validator. */
export const OPTIONS = Object.freeze({
  location: option({
    id: 'location',
    label: 'Azure region',
    kind: 'text',
    default: 'centralus',
    validate: isLocation,
    help: 'Where every regional resource is created: the Log Analytics workspace, the hub network, the firewall, the spokes. Management groups and policy are tenant-wide and have no region.',
  }),
  rootParentId: option({
    id: 'rootParentId',
    label: 'Parent management group',
    kind: 'text',
    default: '',
    validate: isRootParentId,
    help: 'The management group the "alz" root is created under. Leave empty for the tenant root group, which is where the validated pattern puts it; name an existing group to nest the whole tree beneath it.',
  }),
  hubCidr: option({
    id: 'hubCidr',
    label: 'Hub address space',
    kind: 'text',
    default: '10.0.0.0/16',
    validate: isCidr,
    help: 'The IPv4 range the hub virtual network owns. Spokes peer into it, so it must not overlap the spoke range or any on-premises range.',
  }),
  spokeCidr: option({
    id: 'spokeCidr',
    label: 'Spoke address range',
    kind: 'text',
    default: '10.1.0.0/16',
    validate: isSpokeCidr,
    help: 'The range every landing zone’s spoke is carved from, one /24 each: corp spokes from the low half, online spokes from the high half, identity at the top of the low half. /8 to /20. It must not overlap the hub; a range that does is moved to the first free fallback (10.1.0.0/16, 10.2.0.0/16, then 172.16.0.0/16) and the build says so.',
  }),
  privateDnsZones: option({
    id: 'privateDnsZones',
    label: 'Private DNS zones',
    kind: 'boolean',
    default: true,
    validate: isBoolean,
    help: 'Create the private DNS zones for Azure Private Link services in the hub, linked to the hub network, so private endpoints in spokes resolve by name.',
  }),
  firewallSku: option({
    id: 'firewallSku',
    label: 'Firewall SKU',
    kind: 'choice',
    default: 'Standard',
    validate: isFirewallSku,
    help: 'Basic is for small deployments under 250 Mbps; Standard adds threat intelligence and scales; Premium adds TLS inspection and intrusion detection.',
  }),
  corpCount: option({
    id: 'corpCount',
    label: 'Corp landing zones',
    kind: 'count',
    default: 1,
    validate: isLandingZoneCount,
    help: 'How many corp subscriptions to place. Each is a spoke peered to the hub with no public inbound path and, when the firewall is selected, a default route through it.',
  }),
  onlineCount: option({
    id: 'onlineCount',
    label: 'Online landing zones',
    kind: 'count',
    default: 1,
    validate: isLandingZoneCount,
    help: 'How many online subscriptions to place. Each may expose services to the internet and still connects to the hub for shared services. On Azure its outbound traffic leaves directly; on AWS and Google Cloud it leaves through the hub.',
  }),
});

/** The choices a `choice` option offers, by option id. */
export const OPTION_CHOICES = Object.freeze({ firewallSku: FIREWALL_SKUS });

export const OPTION_IDS = Object.freeze(Object.keys(OPTIONS));

const component = (spec) =>
  Object.freeze({
    ...spec,
    dependsOn: Object.freeze(spec.dependsOn),
    options: Object.freeze(spec.options),
  });

/**
 * In the order the issue lists them, which is the order the page, the
 * emitted files and the URL use. It is a reading order, not a topological
 * one: policy comes second because a learner meets it second, though it
 * depends on management, which comes third. `shortId` is the token `?lz=`
 * carries for the component.
 */
export const COMPONENTS = Object.freeze([
  component({
    id: 'management-groups',
    shortId: 'mg',
    group: 'platform',
    label: 'Management groups',
    summary: 'The tree of management groups every subscription is placed in.',
    teaches:
      'A management group is a container above subscriptions, and the tree of them is the skeleton of a landing zone: an "alz" root, a Platform branch for the shared services and a Landing zones branch for the workloads. Policy and role assignments made on a group flow down to every subscription beneath it, so one decision at the root governs hundreds of subscriptions without being repeated. The avm-ptn-alz module reads the "alz" architecture definition and creates the whole tree in one call, and its subscription_placement input is how every other component’s subscription lands in the right group. The architecture carries the policy baseline with it, so selecting only this component deploys the tree with every assignment present but set to DoNotEnforce; selecting Policy is what turns them on. Without the tree, each subscription is its own island: every guardrail has to be assigned again for each one, and nothing stops a new subscription from arriving with none.',
    avm: pin('avm-ptn-alz'),
    dependsOn: [],
    options: ['location', 'rootParentId'],
  }),
  component({
    id: 'policy',
    shortId: 'policy',
    group: 'platform',
    label: 'Policy baseline',
    summary: 'The Azure Policy assignments the alz architecture makes on each management group.',
    teaches:
      'Azure Policy evaluates every resource against rules and can audit, deny or fix what it finds. The alz architecture assigns a baseline of these rules at each level of the tree: deny public IPs in corp, require encryption, send diagnostics to the central workspace, install the monitoring agent. The baseline is configuration of the same avm-ptn-alz call that builds the tree, with default values that point the policies at the Log Analytics workspace from the management component, the private DNS zones from the hub, and a security contact. Without this component the assignments still exist on the tree, because the architecture carries them, but every one is set to DoNotEnforce: nothing is denied or remediated, nothing decides where logs go or what a team may create, and drift starts on the first day.',
    avm: null,
    dependsOn: ['management-groups', 'management'],
    options: [],
  }),
  component({
    id: 'management',
    shortId: 'mgmt',
    group: 'platform',
    label: 'Management',
    summary:
      'The Log Analytics workspace and Automation account that collect every subscription’s telemetry.',
    teaches:
      'The management subscription holds the platform’s eyes: a Log Analytics workspace that every other subscription sends its logs and metrics to, the data collection rules that tell the monitoring agent what to gather, and an Automation account for update management. The avm-ptn-alz-management module creates them together, with the user-assigned identity the agent runs as. The policy baseline depends on this component because its assignments need the workspace id as a parameter. Without central logging each team keeps its own workspace or none, and the first cross-subscription incident has no single place to ask what happened.',
    avm: pin('avm-ptn-alz-management'),
    dependsOn: ['management-groups'],
    options: [],
  }),
  component({
    id: 'connectivity-hub',
    shortId: 'hub',
    group: 'platform',
    label: 'Connectivity hub',
    summary: 'The hub virtual network, Bastion and DNS that every landing zone peers into.',
    teaches:
      'A hub-and-spoke network puts the shared network services in one virtual network, the hub, and peers every landing zone’s network, a spoke, to it. The hub holds the pieces that are expensive or dangerous to duplicate: the Bastion host for administrative access, the private DNS zones that let private endpoints resolve, and the gateway subnet for a future ExpressRoute or VPN. The avm-ptn-alz-connectivity-hub-and-spoke-vnet module creates the hub network with its subnets, route tables and these services from one object. Without a hub every spoke needs its own Bastion and DNS, spokes cannot reach each other or on-premises without pairwise peering, and there is no single point at which to inspect traffic.',
    avm: pin('avm-ptn-alz-connectivity-hub-and-spoke-vnet'),
    dependsOn: ['management-groups'],
    options: ['hubCidr', 'privateDnsZones'],
  }),
  component({
    id: 'firewall',
    shortId: 'fw',
    group: 'platform',
    label: 'Azure Firewall',
    summary: 'The firewall in the hub that every private spoke’s traffic is routed through.',
    teaches:
      'Azure Firewall is a managed, stateful firewall that sits in its own subnet of the hub. The connectivity module creates it with a firewall policy, and each corp and identity spoke gets a route table whose default route points at the firewall’s private IP, so traffic between spokes, to the internet and to on-premises passes one inspection point. It is a block of the hub’s configuration rather than a separate module, which is why it depends on the hub. The SKU sets the ceiling: Basic for small environments, Standard for most, Premium when TLS inspection and intrusion detection are required. Without it each spoke egresses to the internet directly and there is no central place for rules or logs.',
    avm: null,
    dependsOn: ['connectivity-hub'],
    options: ['firewallSku'],
  }),
  component({
    id: 'identity',
    shortId: 'id',
    group: 'platform',
    label: 'Identity',
    summary: 'The identity subscription, placed under the Identity group, with its own spoke.',
    teaches:
      'The identity subscription is where an organisation runs the services that authenticate everything else: Active Directory domain controllers, Entra Domain Services, or the connectors that sync an on-premises directory to Entra ID. It is a subscription placed under the Identity management group, so it inherits the platform guardrails while being isolated from every workload team, plus a spoke virtual network peered to the hub so each corp spoke can reach a domain controller. Like a corp spoke it is private: when the firewall is selected its default route goes through the firewall. Without a dedicated identity subscription these services end up inside one team’s landing zone, and that team can outlive, delete or misconfigure what everyone depends on.',
    avm: pin('avm-res-network-virtualnetwork'),
    dependsOn: ['management-groups', 'connectivity-hub'],
    options: ['spokeCidr'],
  }),
  component({
    id: 'corp',
    shortId: 'corp',
    group: 'application',
    label: 'Corp landing zone',
    summary: 'An application subscription for internal workloads, reached only through the hub.',
    teaches:
      'An application landing zone is a subscription a team receives with the platform already wired in, and a corp landing zone is the private kind: reached over the private network, through the hub, and never from the internet. It is placed under the Corp management group by avm-ptn-alz, so the corp policies apply, among them the ones that deny public IP addresses and require private endpoints. Inside it the virtual network module creates a spoke, one /24 from the spoke range, peered to the hub in both directions, and when the firewall is selected a route table sends the spoke’s default route through the firewall. Without the corp group there is no place to put a workload that must be private by policy, and a private application gets the same rules as a public one.',
    avm: pin('avm-res-network-virtualnetwork'),
    dependsOn: ['management-groups', 'connectivity-hub'],
    options: ['corpCount', 'spokeCidr'],
  }),
  component({
    id: 'online',
    shortId: 'online',
    group: 'application',
    label: 'Online landing zone',
    summary: 'An application subscription that may face the internet and still uses the hub.',
    teaches:
      'An online landing zone is the internet-facing kind of application subscription: a public website, an API, a customer portal. It is placed under the Online management group, whose policies allow public endpoints where corp’s deny them, while the root policies about logging, encryption and monitoring still apply. Its spoke is also a /24 peered to the hub, so it reaches shared services and DNS there, but its default route is left alone: online traffic goes to the internet directly rather than through the firewall. Without a separate online group, either public workloads are blocked by the corp rules or the corp rules are loosened for everyone.',
    avm: pin('avm-res-network-virtualnetwork'),
    dependsOn: ['management-groups', 'connectivity-hub'],
    options: ['onlineCount', 'spokeCidr'],
  }),
]);

export const COMPONENT_IDS = Object.freeze(COMPONENTS.map((c) => c.id));

export const PLATFORM_IDS = Object.freeze(
  COMPONENTS.filter((c) => c.group === 'platform').map((c) => c.id)
);

export const APPLICATION_IDS = Object.freeze(
  COMPONENTS.filter((c) => c.group === 'application').map((c) => c.id)
);

const COMPONENT_BY_ID = new Map(COMPONENTS.map((c) => [c.id, c]));
const COMPONENT_BY_SHORT_ID = new Map(COMPONENTS.map((c) => [c.shortId, c]));

export function componentById(id) {
  return COMPONENT_BY_ID.get(id) ?? null;
}

export function componentByShortId(shortId) {
  return COMPONENT_BY_SHORT_ID.get(shortId) ?? null;
}

export function isComponentId(id) {
  return COMPONENT_BY_ID.has(id);
}

/** The option that carries a component's count of landing zones, or null. */
export function countOptionFor(id) {
  if (id === 'corp') return 'corpCount';
  if (id === 'online') return 'onlineCount';
  return null;
}
