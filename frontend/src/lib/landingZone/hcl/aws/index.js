import { isSelected, normalizeState } from '../../state';
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

export function emitAwsFiles(state) {
  const normalized = normalizeState(state);
  if (!normalized.selected.length) return [readmeMd(normalized, [])];

  const files = [terraformTf(), providersTf(normalized)];

  if (isSelected(normalized, 'management-groups')) {
    files.push(organizationsTf(normalized));
  }
  if (isSelected(normalized, 'policy')) {
    files.push(scpTf(normalized));
  }
  if (isSelected(normalized, 'management')) {
    files.push(loggingTf(normalized));
  }
  if (isSelected(normalized, 'connectivity-hub')) {
    files.push(transitGatewayTf(normalized));
  }
  if (isSelected(normalized, 'firewall')) {
    files.push(networkFirewallTf(normalized));
  }
  if (isSelected(normalized, 'identity')) {
    files.push(identityTf(normalized));
  }
  if (isSelected(normalized, 'corp') || isSelected(normalized, 'online')) {
    files.push(spokesTf(normalized));
  }

  files.push(variablesTf(normalized), tfvarsExample(normalized));
  files.push(readmeMd(normalized, files));
  return files;
}
