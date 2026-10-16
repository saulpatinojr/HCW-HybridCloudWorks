/**
 * A diagnostic setting on a storage service names no collection mode (#1209).
 *
 * Azure Storage writes its resource logs only to its own resource-specific
 * tables (StorageBlobLogs, StorageQueueLogs and the rest), and it is not one
 * of the services that let a diagnostic setting choose between those and
 * AzureDiagnostics. So Azure keeps no value for `log_analytics_destination_type`
 * on a storage target. Set in Terraform, it reads back empty and every plan
 * proposes it again: `infra/lab-hybrid-backups.tf` set "Dedicated" on
 * 2026-10-14, and the plan for #1207's merge carried `"" -> "Dedicated"` as
 * an undeclared change. The other storage settings never set it and never
 * drifted. This holds every storage diagnostic setting in the module to that.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { moduleBlocks } from './lib/alert-declarations.mjs';

const INFRA = join(dirname(fileURLToPath(import.meta.url)), '..', 'infra');

/** Every `.tf` file in infra/, as one module, the way Terraform reads it. */
const moduleSource = () =>
  readdirSync(INFRA)
    .filter((f) => f.endsWith('.tf'))
    .map((f) => readFileSync(join(INFRA, f), 'utf8'))
    .join('\n');

/** The diagnostic settings whose target is a storage account or one of its services. */
function storageDiagnosticSettings(source) {
  return [...moduleBlocks(source).resources.values()].filter(
    (r) =>
      r.type === 'azurerm_monitor_diagnostic_setting' &&
      /\bazurerm_storage_account\.[A-Za-z0-9_-]+\.id\b/.test(r.attributes.get('target_resource_id') ?? '')
  );
}

/** The addresses of those that set a collection mode, which Azure would not keep. */
const settingAMode = (source) =>
  storageDiagnosticSettings(source)
    .filter((r) => r.attributes.has('log_analytics_destination_type'))
    .map((r) => `${r.type}.${r.name}`);

describe('storage diagnostic settings', () => {
  it('finds every storage diagnostic setting in the module, so the check below is not vacuous', () => {
    const names = storageDiagnosticSettings(moduleSource()).map((r) => r.name);
    expect(names).toEqual(
      expect.arrayContaining(['content_blob', 'content_queue', 'functions_blob', 'functions_queue', 'lab_hybrid_backups_blob'])
    );
  });

  it('none names a collection mode, which Azure keeps no value for on storage', () => {
    expect(settingAMode(moduleSource())).toEqual([]);
  });

  it('would name one that did', () => {
    const source = `
resource "azurerm_monitor_diagnostic_setting" "example" {
  name                           = "diag"
  target_resource_id             = "\${azurerm_storage_account.example.id}/blobServices/default"
  log_analytics_workspace_id     = azurerm_log_analytics_workspace.hcw.id
  log_analytics_destination_type = "Dedicated"
}

resource "azurerm_monitor_diagnostic_setting" "not_storage" {
  name                           = "diag"
  target_resource_id             = azurerm_cosmosdb_account.hcw.id
  log_analytics_workspace_id     = azurerm_log_analytics_workspace.hcw.id
  log_analytics_destination_type = "Dedicated"
}
`;
    expect(settingAMode(source)).toEqual(['azurerm_monitor_diagnostic_setting.example']);
  });
});
