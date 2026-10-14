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

  const files = [terraformTf(), providersTf(normalized)];

  if (isSelected(normalized, 'management-groups')) {
    files.push(foldersTf(normalized));
  }
  if (isSelected(normalized, 'policy')) {
    files.push(orgPoliciesTf(normalized));
  }
  if (isSelected(normalized, 'management')) {
    files.push(loggingSinkTf(normalized));
  }
  if (isSelected(normalized, 'connectivity-hub')) {
    files.push(sharedVpcTf(normalized));
  }
  if (isSelected(normalized, 'firewall')) {
    files.push(cloudNgfwTf(normalized));
  }
  if (isSelected(normalized, 'identity')) {
    files.push(identityTf(normalized));
  }
  if (isSelected(normalized, 'corp') || isSelected(normalized, 'online')) {
    files.push(projectsTf(normalized));
  }

  files.push(variablesTf(normalized), tfvarsExample(normalized));
  files.push(readmeMd(normalized, files));
  return files;
}
