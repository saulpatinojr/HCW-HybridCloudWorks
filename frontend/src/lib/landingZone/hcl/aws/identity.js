import { block, file, joinBlocks, list, obj, q } from '../format';
import { AWS_MODULES } from './moduleVersions';

export function identityTf() {
  const blocks = [];
  const vpcModule = AWS_MODULES.vpc;

  // Identity Spoke VPC
  blocks.push(
    block('module "identity_spoke_vpc"', [
      ['source', q(vpcModule.source)],
      ['version', q(vpcModule.version)],
      ['name', q('identity-spoke-vpc')],
      ['cidr', 'var.spoke_cidr'],
      ['azs', list([q('${var.aws_region}a'), q('${var.aws_region}b')])],
      [
        'private_subnets',
        list([q('${cidrsubnet(var.spoke_cidr, 4, 8)}'), q('${cidrsubnet(var.spoke_cidr, 4, 9)}')]),
      ],
      ['tags', obj([['Role', q('IdentityAndSharedServices')]])],
    ])
  );

  return file('identity.tf', joinBlocks(blocks));
}
