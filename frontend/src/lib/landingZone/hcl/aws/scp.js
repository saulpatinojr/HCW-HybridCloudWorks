import { block, file, joinBlocks, q } from '../format';

export function scpTf() {
  const blocks = [];

  // SCP: Deny root user actions in member accounts
  blocks.push(
    block('resource "aws_organizations_policy" "deny_root"', [
      ['name', q('DenyRootUserActions')],
      [
        'description',
        q('Enforces least privilege by denying root account usage across all member accounts.'),
      ],
      ['type', q('SERVICE_CONTROL_POLICY')],
      [
        'content',
        `jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "DenyRootAccountUsage"
        Effect    = "Deny"
        Action    = "*"
        Resource  = "*"
        Condition = {
          StringLike = {
            "aws:PrincipalArn" = "arn:aws:iam::*:root"
          }
        }
      }
    ]
  })`,
      ],
    ])
  );

  blocks.push(
    block('resource "aws_organizations_policy_attachment" "deny_root_attach"', [
      ['policy_id', 'aws_organizations_policy.deny_root.id'],
      ['target_id', 'aws_organizations_organizational_unit.workloads.id'],
    ])
  );

  // SCP: Require IMDSv2
  blocks.push(
    block('resource "aws_organizations_policy" "require_imdsv2"', [
      ['name', q('RequireIMDSv2Tokens')],
      [
        'description',
        q('Denies running EC2 instances without token-based IMDSv2 metadata protection.'),
      ],
      ['type', q('SERVICE_CONTROL_POLICY')],
      [
        'content',
        `jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "EnforceIMDSv2"
        Effect    = "Deny"
        Action    = "ec2:RunInstances"
        Resource  = "arn:aws:ec2:*:*:instance/*"
        Condition = {
          StringNotEquals = {
            "ec2:MetadataHttpTokens" = "required"
          }
        }
      }
    ]
  })`,
      ],
    ])
  );

  blocks.push(
    block('resource "aws_organizations_policy_attachment" "require_imdsv2_attach"', [
      ['policy_id', 'aws_organizations_policy.require_imdsv2.id'],
      ['target_id', 'aws_organizations_organizational_unit.workloads.id'],
    ])
  );

  return file('scp.tf', joinBlocks(blocks));
}
