import { block, file, joinBlocks, q } from '../format';
import { GCP_MODULES } from './moduleVersions';

/**
 * The organisation log sink and the Cloud Storage bucket it writes to.
 *
 * The sink writes as its own Google identity (its `writer_identity`), and
 * Google refuses the logs until that identity may create objects in the
 * bucket (https://docs.cloud.google.com/logging/docs/export/configure_export_v2#dest-auth).
 * log-export's own `modules/storage` destination makes the bucket and grants
 * `roles/storage.objectCreator` to the identity it is given, so the two
 * modules feed each other: the sink takes the bucket's address, the bucket
 * takes the sink's identity. Terraform orders the resources underneath, as
 * log-export's README shows for this exact pair (#1870).
 */
export function loggingSinkTf() {
  const blocks = [];
  const logModule = GCP_MODULES.logExport;
  const bucketModule = GCP_MODULES.logStorage;

  blocks.push(
    block('module "org_log_export"', [
      ['source', q(logModule.source)],
      ['version', q(logModule.version)],
      ['destination_uri', 'module.audit_destination_bucket.destination_uri'],
      ['filter', q('severity >= NOTICE')],
      ['log_sink_name', q('org-audit-log-sink')],
      ['parent_resource_id', 'var.organization_id'],
      ['parent_resource_type', q('organization')],
      ['include_children', 'true'],
    ])
  );

  blocks.push(
    block('module "audit_destination_bucket"', [
      ['source', q(bucketModule.source)],
      ['version', q(bucketModule.version)],
      ['project_id', 'var.logging_project_id'],
      ['storage_bucket_name', q('hcw-gcp-audit-logs-\${var.organization_id}')],
      ['location', 'var.gcp_region'],
      ['log_sink_writer_identity', 'module.org_log_export.writer_identity'],
      ['versioning', 'true'],
      ['force_destroy', 'false'],
      ['public_access_prevention', q('enforced')],
    ])
  );

  return file('logging-sink.tf', joinBlocks(blocks));
}
