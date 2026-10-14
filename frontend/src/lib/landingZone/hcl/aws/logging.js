import { block, file, joinBlocks, obj, q } from '../format';

export function loggingTf() {
  const blocks = [];

  // Central KMS Log Key
  blocks.push(
    block('resource "aws_kms_key" "log_key"', [
      ['description', q('KMS Customer Managed Key for central organization audit logs')],
      ['deletion_window_in_days', '30'],
      ['enable_key_rotation', 'true'],
    ])
  );

  // Central S3 Audit Bucket
  blocks.push(
    block('resource "aws_s3_bucket" "audit_logs"', [
      ['bucket', q('hcw-org-audit-logs-${data.aws_caller_identity.current.account_id}')],
      ['force_destroy', 'false'],
    ])
  );

  blocks.push(
    block('resource "aws_s3_bucket_server_side_encryption_configuration" "audit_encryption"', [
      ['bucket', 'aws_s3_bucket.audit_logs.id'],
      [
        'rule',
        obj([
          [
            'apply_server_side_encryption_by_default',
            obj([
              ['kms_master_key_id', 'aws_kms_key.log_key.arn'],
              ['sse_algorithm', q('aws:kms')],
            ]),
          ],
        ]),
      ],
    ])
  );

  blocks.push(
    block('resource "aws_s3_bucket_public_access_block" "audit_pab"', [
      ['bucket', 'aws_s3_bucket.audit_logs.id'],
      ['block_public_acls', 'true'],
      ['block_public_policy', 'true'],
      ['ignore_public_acls', 'true'],
      ['restrict_public_buckets', 'true'],
    ])
  );

  // Multi-Region Organization CloudTrail
  blocks.push(
    block('resource "aws_cloudtrail" "org_trail"', [
      ['name', q('org-audit-trail')],
      ['s3_bucket_name', 'aws_s3_bucket.audit_logs.id'],
      ['kms_key_id', 'aws_kms_key.log_key.arn'],
      ['include_global_service_events', 'true'],
      ['is_multi_region_trail', 'true'],
      ['is_organization_trail', 'true'],
      ['enable_log_file_validation', 'true'],
    ])
  );

  return file('logging.tf', joinBlocks(blocks));
}
