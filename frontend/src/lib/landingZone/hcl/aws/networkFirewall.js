import { block, file, joinBlocks, obj, q } from '../format';
import { firewallRouteBlocks } from './firewallRoutes';
import { AWS_MODULES } from './moduleVersions';

/** The variable that holds the egress allow-list; the README and tfvars name it too. */
export const ALLOW_LIST_VARIABLE = 'firewall_allowed_domains';

// An explicit name (api.example.com) or a wildcard for a domain and all its
// subdomains, written with a leading dot (.example.com), as AWS accepts them.
// No scheme, path, port or `*`. HCL string, so the backslashes are escaped.
// Each label starts and ends with a letter or digit, so `-.com` is refused.
const DOMAIN_PATTERN =
  '^\\.?[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$';

export function networkFirewallTf() {
  const blocks = [];
  const nfwModule = AWS_MODULES.networkFirewall;

  // Builds before #1876 called the hub VPC `inspection_vpc` and emitted it
  // only with the firewall. Its firewall subnets are the same ones, so this
  // tells Terraform to keep that VPC under its new name instead of
  // destroying it and building a new one.
  blocks.push(
    block('moved', [
      '# An earlier build named the hub VPC "inspection_vpc". Keep it, renamed.',
      ['from', 'module.inspection_vpc'],
      ['to', 'module.hub_vpc'],
    ])
  );

  // The allow-list the owner of the landing zone fills in. Empty means the
  // firewall lets no web traffic out at all, which is the safe starting point.
  blocks.push(
    block(`variable "${ALLOW_LIST_VARIABLE}"`, [
      [
        'description',
        q(
          'Domains the hub firewall lets workloads reach over HTTP and HTTPS. Empty (the default) allows nothing. Use api.example.com for one name, or .example.com for a domain and all its subdomains.'
        ),
      ],
      ['type', 'list(string)'],
      ['default', '[]'],
      '',
      ...block('validation', [
        [
          'condition',
          `alltrue([for d in var.${ALLOW_LIST_VARIABLE} : can(regex(${q(DOMAIN_PATTERN)}, d))])`,
        ],
        [
          'error_message',
          q(
            'Each entry is a domain such as api.example.com, or .example.com for all subdomains: no https://, path, port or *.'
          ),
        ],
      ]),
    ])
  );

  // The allow-list as a stateful domain-list rule group. It is created only
  // once the list has an entry, because AWS refuses a domain list with no
  // targets. Until then the policy below has no rule group and its default
  // drop applies to everything.
  blocks.push(
    block('resource "aws_networkfirewall_rule_group" "egress_allow_list"', [
      '# Created only once the allow-list has an entry: AWS refuses an empty one.',
      [
        'for_each',
        `length(var.${ALLOW_LIST_VARIABLE}) > 0 ? toset(["egress-allow-list"]) : toset([])`,
      ],
      '',
      ['name', q('hub-egress-allow-list')],
      [
        'description',
        q('Domains workloads may reach through the hub firewall (HTTP Host and TLS SNI).'),
      ],
      ['type', q('STATEFUL')],
      '# Capacity is fixed at creation; each domain uses about two rules. Raising',
      '# it replaces the group, which fails while the policy uses it: detach it first.',
      ['capacity', '1000'],
      '',
      ...block('rule_group', [
        // HOME_NET is "our side" of the traffic. It defaults to the
        // inspection VPC alone, which would never match traffic from the
        // workload VPCs, so it covers the hub and every spoke range.
        '# Our side of the traffic: the hub and every workload VPC, not only',
        '# the inspection VPC that AWS assumes by default.',
        ...block('rule_variables', [
          ...block('ip_sets', [
            ['key', q('HOME_NET')],
            '',
            ...block('ip_set', [['definition', '[var.hub_cidr, var.spoke_cidr]']]),
          ]),
        ]),
        '',
        ...block('rules_source', [
          ...block('rules_source_list', [
            ['generated_rules_type', q('ALLOWLIST')],
            ['target_types', '["HTTP_HOST", "TLS_SNI"]'],
            ['targets', `var.${ALLOW_LIST_VARIABLE}`],
          ]),
        ]),
        '',
        // A rule group must use the same rule order as the policy it is in.
        ...block('stateful_rule_options', [['rule_order', q('STRICT_ORDER')]]),
      ]),
      '',
      ['tags', obj([['Tier', q('StatefulInspection')]])],
    ])
  );

  // AWS Network Firewall
  blocks.push(
    block('module "network_firewall"', [
      ['source', q(nfwModule.source)],
      ['version', q(nfwModule.version)],
      ['name', q('hub-network-firewall')],
      ['description', q('Central stateful inspection firewall for ingress, egress, and east-west')],
      ['vpc_id', 'module.hub_vpc.vpc_id'],
      // One endpoint in each zone's firewall subnet of the hub VPC
      // (transit-gateway.tf). The module reads `subnet_id` from each entry of
      // this map, so every entry is an object, not a bare subnet id (#1862).
      [
        'subnet_mapping',
        obj([
          ['subnet_1', obj([['subnet_id', 'module.hub_vpc.private_subnets[0]']])],
          ['subnet_2', obj([['subnet_id', 'module.hub_vpc.private_subnets[1]']])],
        ]),
      ],
      ['delete_protection', 'false'],
      '',
      // The policy (#1871). The module's own default passes every packet
      // uninspected; these lines are written into the .tf file so whoever
      // deploys it can see why it is not.
      '# Inspect everything, allow only what a rule allows (#1871).',
      '# - Every packet, whole or fragmented, goes to the stateful engine.',
      '# - Rules are evaluated in the order they are written (STRICT_ORDER).',
      '# - drop_established_app_layer_to_server lets the TCP handshake through and',
      '#   holds the decision until the HTTP Host or TLS server name is seen, even',
      '#   when a large TLS hello is split over two packets, then drops what no',
      '#   rule allowed. Plain drop_established can decide on the first packet and',
      '#   drop an allowed site. The to_server form never drops server-to-client',
      '#   packets (keep-alives, resets, replies). UDP and ICMP are dropped either',
      '#   way. The matching alert logs each drop once logging is on.',
      ['policy_stateless_default_actions', '["aws:forward_to_sfe"]'],
      ['policy_stateless_fragment_default_actions', '["aws:forward_to_sfe"]'],
      [
        'policy_stateful_engine_options',
        obj([
          ['rule_order', q('STRICT_ORDER')],
          ['stream_exception_policy', q('DROP')],
        ]),
      ],
      [
        'policy_stateful_default_actions',
        '["aws:drop_established_app_layer_to_server", "aws:alert_established_app_layer_to_server"]',
      ],
      [
        'policy_stateful_rule_group_reference',
        '{ for k, g in aws_networkfirewall_rule_group.egress_allow_list : k => { priority = 100, resource_arn = g.arn } }',
      ],
      '',
      ['tags', obj([['Tier', q('StatefulInspection')]])],
    ])
  );

  blocks.push(...firewallRouteBlocks());

  return file('network-firewall.tf', joinBlocks(blocks));
}
