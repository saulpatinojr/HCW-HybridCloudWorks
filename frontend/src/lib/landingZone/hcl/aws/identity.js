import { block, file, joinBlocks, list, obj, q } from '../format';
import { AWS_MODULES } from './moduleVersions';
import { spokeDefaultRoute } from './spokeVpcs';

// The identity VPC takes the last of the sixteen slices of the spoke range.
// Corp and online VPCs take slices 1 to 10, so none overlap. It used to take
// the whole spoke range, which overlapped every other workload VPC and left
// the Transit Gateway unable to route between them (#1876).
const IDENTITY_SLOT = 15;
const slice = (part) =>
  q(`\${cidrsubnet(cidrsubnet(var.spoke_cidr, 4, ${IDENTITY_SLOT}), 2, ${part})}`);

export function identityTf() {
  const vpcModule = AWS_MODULES.vpc;

  return file(
    'identity.tf',
    joinBlocks([
      block('module "identity_spoke_vpc"', [
        ['source', q(vpcModule.source)],
        ['version', q(vpcModule.version)],
        ['name', q('identity-spoke-vpc')],
        ['cidr', `cidrsubnet(var.spoke_cidr, 4, ${IDENTITY_SLOT})`],
        ['azs', 'local.azs'],
        ['private_subnets', list([slice(0), slice(1)])],
        ['tags', obj([['Role', q('IdentityAndSharedServices')]])],
      ]),
      spokeDefaultRoute('identity_spoke_vpc'),
    ])
  );
}
