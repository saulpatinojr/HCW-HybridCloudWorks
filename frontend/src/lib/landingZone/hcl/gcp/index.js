import { emitCloudPack } from '../cloudPack';
import { cloudNgfwTf } from './cloudNgfw';
import { foldersTf } from './folders';
import { identityTf } from './identity';
import { loggingSinkTf } from './loggingSink';
import { orgPoliciesTf } from './orgPolicies';
import { projectsTf } from './projects';
import { providersTf } from './providers';
import { readmeMd } from './readme';
import { sharedVpcTf } from './sharedVpc';
import { terraformTf } from './terraform';
import { tfvarsExample, variablesTf } from './variables';

// Each component the builder offers, and the file it adds, in emit order.
const COMPONENT_FILES = [
  ['management-groups', foldersTf],
  ['policy', orgPoliciesTf],
  ['management', loggingSinkTf],
  ['connectivity-hub', sharedVpcTf],
  ['firewall', cloudNgfwTf],
  ['identity', identityTf],
];

/**
 * Emit the GCP landing-zone pack for one builder state: `terraform.tf` and
 * `providers.tf` always, one file per selected component, then variables,
 * the tfvars example and a README that lists what was emitted. A state with
 * nothing selected yields the README alone, which says so.
 *
 * @param {object} state the builder state `normalizeState` accepts
 * @returns {Array<{ path: string, content: string }>} the files, in emit order
 */
export function emitGcpFiles(state) {
  return emitCloudPack(state, {
    terraform: terraformTf,
    providers: providersTf,
    components: COMPONENT_FILES,
    workloads: projectsTf,
    variables: variablesTf,
    tfvars: tfvarsExample,
    readme: readmeMd,
  });
}
