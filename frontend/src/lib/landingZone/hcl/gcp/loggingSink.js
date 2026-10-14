import { block, file, joinBlocks, q } from '../format';
import { GCP_MODULES } from './moduleVersions';

export function loggingSinkTf() {
  const blocks = [];
  const logModule = GCP_MODULES.logExport;

  blocks.push(
    block('module "org_log_export"', [
      ['source', q(logModule.source)],
      ['version', q(logModule.version)],
      [
        'destination_uri',
        q('storage.googleapis.com/\${module.audit_destination_bucket.bucket.name}'),
      ],
      ['filter', q('severity >= NOTICE')],
      ['log_sink_name', q('org-audit-log-sink')],
      ['parent_resource_id', 'var.organization_id'],
      ['parent_resource_type', q('organization')],
      ['include_children', 'true'],
    ])
  );

  blocks.push(
    block('module "audit_destination_bucket"', [
      ['source', q('terraform-google-modules/cloud-storage/google')],
      ['version', q('~> 6.0')],
      ['name', q('hcw-gcp-audit-logs-\${var.organization_id}')],
      ['project_id', 'var.logging_project_id'],
      ['location', 'var.gcp_region'],
      ['versioning', 'true'],
      ['force_destroy', 'false'],
      ['public_access_prevention', q('enforced')],
    ])
  );

  return file('logging-sink.tf', joinBlocks(blocks));
}
