import { block, file, joinBlocks, list, obj, q } from '../format';
import { isSelected } from '../../state';
import { AWS_MODULES } from './moduleVersions';

export function spokesTf(state) {
  const blocks = [];
  const vpcModule = AWS_MODULES.vpc;
  const corpCount = isSelected(state, 'corp') ? Number(state.options?.corpCount ?? 1) : 0;
  const onlineCount = isSelected(state, 'online') ? Number(state.options?.onlineCount ?? 1) : 0;

  for (let i = 1; i <= corpCount; i += 1) {
    blocks.push(
      block(`module "corp_spoke_${i}"`, [
        ['source', q(vpcModule.source)],
        ['version', q(vpcModule.version)],
        ['name', q(`corp-workload-vpc-${i}`)],
        ['cidr', `cidrsubnet(var.spoke_cidr, 4, ${i})`],
        ['azs', list([q('${var.aws_region}a'), q('${var.aws_region}b')])],
        [
          'private_subnets',
          list([
            q(`\${cidrsubnet(cidrsubnet(var.spoke_cidr, 4, ${i}), 2, 0)}`),
            q(`\${cidrsubnet(cidrsubnet(var.spoke_cidr, 4, ${i}), 2, 1)}`),
          ]),
        ],
        ['enable_nat_gateway', 'false'],
        ['single_nat_gateway', 'false'],
        [
          'tags',
          obj([
            ['Environment', q('CorpPrivate')],
            ['WorkloadIndex', q(String(i))],
          ]),
        ],
      ])
    );
  }

  for (let i = 1; i <= onlineCount; i += 1) {
    const slot = corpCount + i;
    blocks.push(
      block(`module "online_spoke_${i}"`, [
        ['source', q(vpcModule.source)],
        ['version', q(vpcModule.version)],
        ['name', q(`online-workload-vpc-${i}`)],
        ['cidr', `cidrsubnet(var.spoke_cidr, 4, ${slot})`],
        ['azs', list([q('${var.aws_region}a'), q('${var.aws_region}b')])],
        [
          'public_subnets',
          list([
            q(`\${cidrsubnet(cidrsubnet(var.spoke_cidr, 4, ${slot}), 2, 0)}`),
            q(`\${cidrsubnet(cidrsubnet(var.spoke_cidr, 4, ${slot}), 2, 1)}`),
          ]),
        ],
        [
          'private_subnets',
          list([
            q(`\${cidrsubnet(cidrsubnet(var.spoke_cidr, 4, ${slot}), 2, 2)}`),
            q(`\${cidrsubnet(cidrsubnet(var.spoke_cidr, 4, ${slot}), 2, 3)}`),
          ]),
        ],
        ['enable_nat_gateway', 'true'],
        ['single_nat_gateway', 'true'],
        [
          'tags',
          obj([
            ['Environment', q('OnlinePublicEdge')],
            ['WorkloadIndex', q(String(i))],
          ]),
        ],
      ])
    );
  }

  return file('spokes.tf', joinBlocks(blocks));
}
