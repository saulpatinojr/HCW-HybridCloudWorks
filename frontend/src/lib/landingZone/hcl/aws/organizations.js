import { block, file, joinBlocks, list, q } from '../format';

export function organizationsTf() {
  const blocks = [];

  // Root Organization
  blocks.push(
    block('resource "aws_organizations_organization" "org"', [
      [
        'aws_service_access_principals',
        list([
          q('cloudtrail.amazonaws.com'),
          q('config.amazonaws.com'),
          q('sso.amazonaws.com'),
          q('ram.amazonaws.com'),
        ]),
      ],
      ['enabled_policy_types', list([q('SERVICE_CONTROL_POLICY'), q('TAG_POLICY')])],
      ['feature_set', q('ALL')],
    ])
  );

  // Core Organizational Units
  blocks.push(
    block('resource "aws_organizations_organizational_unit" "security"', [
      ['name', q('Security')],
      ['parent_id', 'aws_organizations_organization.org.roots[0].id'],
    ])
  );

  blocks.push(
    block('resource "aws_organizations_organizational_unit" "infrastructure"', [
      ['name', q('Infrastructure')],
      ['parent_id', 'aws_organizations_organization.org.roots[0].id'],
    ])
  );

  blocks.push(
    block('resource "aws_organizations_organizational_unit" "workloads"', [
      ['name', q('Workloads')],
      ['parent_id', 'aws_organizations_organization.org.roots[0].id'],
    ])
  );

  return file('organizations.tf', joinBlocks(blocks));
}
