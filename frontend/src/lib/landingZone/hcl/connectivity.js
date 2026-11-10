/**
 * `connectivity.tf` (#667): the hub from
 * avm-ptn-alz-connectivity-hub-and-spoke-vnet, with the firewall and its
 * policy as blocks of the hub object only when selected, and the private
 * DNS resources on the option.
 */
import { isSelected } from '../state';
import { block, file, moduleSource, obj, providersMap, q } from './format';

function header(firewall, dns, sku) {
  return [
    '# Connectivity: one hub virtual network with a Bastion host, the gateway subnet for a',
    '# future ExpressRoute or VPN (the gateways themselves are off), route tables, and',
    firewall
      ? `# an Azure Firewall (${sku}) with its policy that every private spoke routes through.`
      : '# no firewall: spokes egress directly until the firewall component is added.',
    dns
      ? '# The private DNS zones for Private Link are created and linked to the hub.'
      : '# Private DNS zones are off; private endpoints in spokes will not resolve by name.',
  ];
}

function hubObject(firewall, dns, sku) {
  const hub = [
    ['location', 'var.location'],
    ['default_hub_address_space', 'var.hub_address_space'],
    ['default_parent_id', 'azurerm_resource_group.connectivity.id'],
    [
      'enabled_resources',
      obj([
        ['firewall', String(firewall)],
        ['firewall_policy', String(firewall)],
        ['bastion', 'true'],
        ['private_dns_zones', String(dns)],
        ['private_dns_resolver', String(dns)],
        ['dns_resolver_policy', String(dns)],
        ['virtual_network_gateway_express_route', 'false'],
        ['virtual_network_gateway_vpn', 'false'],
      ]),
    ],
  ];
  // Copy and paste through Bastion stays off, as it was before connectivity
  // 0.18.1 changed the module's default to on (#1658). Turning it off needs
  // the Standard or Premium SKU; the module's default SKU is Standard.
  hub.push(['bastion', obj([['copy_paste_enabled', 'false']])]);
  if (firewall) {
    hub.push(
      ['firewall', obj([['sku_tier', q(sku)]])],
      ['firewall_policy', obj([['sku', q(sku)]])]
    );
  }
  return obj(hub);
}

export function connectivityTf(state) {
  const firewall = isSelected(state, 'firewall');
  const dns = state.options.privateDnsZones;
  const sku = state.options.firewallSku;
  return file('connectivity.tf', [
    ...header(firewall, dns, sku),
    ...block('resource "azurerm_resource_group" "connectivity"', [
      ['provider', 'azurerm.connectivity'],
      '',
      ['location', 'var.location'],
      ['name', q('rg-alz-connectivity-${var.location}')],
    ]),
    '',
    ...block('module "connectivity"', [
      ...moduleSource('avm-ptn-alz-connectivity-hub-and-spoke-vnet'),
      '',
      ['enable_telemetry', 'var.enable_telemetry'],
      '',
      '# A DDoS protection plan is a fixed monthly charge; the learning build leaves it out.',
      [
        'hub_and_spoke_networks_settings',
        obj([['enabled_resources', obj([['ddos_protection_plan', 'false']])]]),
      ],
      '',
      ['hub_virtual_networks', obj([['primary', hubObject(firewall, dns, sku)]])],
      '',
      ['providers', providersMap('avm-ptn-alz-connectivity-hub-and-spoke-vnet', 'connectivity')],
    ]),
  ]);
}
