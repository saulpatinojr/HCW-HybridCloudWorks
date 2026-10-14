/**
 * The build as Terraform (#667): `emitFiles(state)` returns the files a
 * learner downloads, mirroring the examples the Azure Verified Modules ship
 * rather than a hand-drawn approximation of them. One module per emitted
 * file; format.js is the `terraform fmt` shape they all write in.
 *
 * WHAT IS EMITTED. Only files whose components are selected: alz.tf for the
 * management groups (and, inside it, the policy configuration when policy
 * is selected), subscriptions.tf when any subscription is placed (the ids
 * in one list, refused if not distinct), management.tf, connectivity.tf
 * (the firewall and DNS as blocks of the hub's object), identity.tf for the identity spoke,
 * application.tf for the corp and online spokes, and always terraform.tf,
 * providers.tf, variables.tf, an example tfvars and a README. An empty build
 * is a README saying so. Every emission says it was generated for learning
 * and never applied here.
 */
import { isSelected, normalizeState } from '../state';
import { alzTf } from './alz';
import { applicationTf } from './application';
import { connectivityTf } from './connectivity';
import { identityTf } from './identity';
import { managementTf } from './management';
import { providersTf } from './providers';
import { readmeMd } from './readme';
import { subscriptionIdsTf } from './subscriptionIds';
import { placements } from './subscriptions';
import { terraformTf } from './terraform';
import { tfvarsExample, variablesTf } from './variables';

import { emitAwsFiles } from './aws/index';
import { emitGcpFiles } from './gcp/index';

/** Component → the file it adds, in emission order. */
const COMPONENT_FILES = [
  ['management-groups', alzTf],
  ['management', managementTf],
  ['connectivity-hub', connectivityTf],
  ['identity', identityTf],
  ['corp', applicationTf],
  ['online', applicationTf],
];

/**
 * The Azure Terraform files for a build.
 */
export function emitAzureFiles(normalized) {
  if (!normalized.selected.length) return [readmeMd(normalized, [])];

  const files = [terraformTf(), providersTf(normalized)];
  const emitted = new Set();
  for (const [id, emit] of COMPONENT_FILES) {
    if (!isSelected(normalized, id) || emitted.has(emit)) continue;
    emitted.add(emit);
    files.push(emit(normalized));
    if (id === 'management-groups' && placements(normalized).length) {
      files.push(subscriptionIdsTf(normalized));
    }
  }
  files.push(variablesTf(normalized), tfvarsExample(normalized));
  files.push(readmeMd(normalized, files));
  return files;
}

/**
 * The Terraform files for a build across Azure, AWS, and Google Cloud.
 *
 * @param {{ selected?: string[], options?: object, cloud?: string }} state
 * @returns {Array<{ path: string, content: string }>}
 */
export function emitFiles(state) {
  const normalized = normalizeState(state);
  const cloud = state?.cloud || normalized.cloud || normalized.options?.cloud || 'azure';
  if (cloud === 'aws') {
    return emitAwsFiles(normalized);
  }
  if (cloud === 'gcp') {
    return emitGcpFiles(normalized);
  }
  return emitAzureFiles(normalized);
}
export { emitAwsFiles, emitGcpFiles };
