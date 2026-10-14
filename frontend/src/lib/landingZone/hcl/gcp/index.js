import { isSelected, normalizeState } from '../../state';
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

export function emitGcpFiles(state) {
  const normalized = normalizeState(state);
  if (!normalized.selected.length) return [readmeMd(normalized, [])];

  const files = [terraformTf(), providersTf()];

  if (isSelected(normalized, 'management-groups')) {
    files.push(foldersTf());
  }
  if (isSelected(normalized, 'policy')) {
    files.push(orgPoliciesTf());
  }
  if (isSelected(normalized, 'management')) {
    files.push(loggingSinkTf());
  }
  if (isSelected(normalized, 'connectivity-hub')) {
    files.push(sharedVpcTf());
  }
  if (isSelected(normalized, 'firewall')) {
    files.push(cloudNgfwTf());
  }
  if (isSelected(normalized, 'identity')) {
    files.push(identityTf());
  }
  if (isSelected(normalized, 'corp') || isSelected(normalized, 'online')) {
    files.push(projectsTf(normalized));
  }

  files.push(variablesTf(), tfvarsExample(normalized));
  files.push(readmeMd(normalized, files));
  return files;
}
