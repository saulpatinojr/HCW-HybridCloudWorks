import { emitCloudPack } from '../cloudPack';
import { identityTf } from './identity';
import { loggingTf } from './logging';
import { networkFirewallTf } from './networkFirewall';
import { organizationsTf } from './organizations';
import { providersTf } from './providers';
import { readmeMd } from './readme';
import { scpTf } from './scp';
import { spokesTf } from './spokes';
import { terraformTf } from './terraform';
import { transitGatewayTf } from './transitGateway';
import { tfvarsExample, variablesTf } from './variables';

// Each component the builder offers, and the file it adds, in emit order.
const COMPONENT_FILES = [
  ['management-groups', organizationsTf],
  ['policy', scpTf],
  ['management', loggingTf],
  ['connectivity-hub', transitGatewayTf],
  ['firewall', networkFirewallTf],
  ['identity', identityTf],
];

/**
 * Emit the AWS landing-zone pack for one builder state: `terraform.tf` and
 * `providers.tf` always, one file per selected component, then variables,
 * the tfvars example and a README that lists what was emitted. A state with
 * nothing selected yields the README alone, which says so.
 *
 * @param {object} state the builder state `normalizeState` accepts
 * @returns {Array<{ path: string, content: string }>} the files, in emit order
 */
export function emitAwsFiles(state) {
  return emitCloudPack(state, {
    terraform: terraformTf,
    providers: providersTf,
    components: COMPONENT_FILES,
    workloads: spokesTf,
    variables: variablesTf,
    tfvars: tfvarsExample,
    readme: readmeMd,
  });
}
