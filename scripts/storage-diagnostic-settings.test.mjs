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

/**
 * A resource the target is read from, written directly as
 * `azurerm_<type>.<name>.id` (a `data.` source matches the same way). A
 * target reached through a `local.` or a `var.` names no type, so it cannot be
 * classified here, and the test refuses it rather than skipping it.
 */
const DIRECT_TARGET = /\b(azurerm_[a-z0-9_]+)\.[A-Za-z0-9_-]+\.id\b/;

/** Every diagnostic setting, with what its target is: storage, other, or unclassified. */
function diagnosticSettings(source) {
  return [...moduleBlocks(source).resources.values()]
    .filter((r) => r.type === 'azurerm_monitor_diagnostic_setting')
    .map((r) => {
      const match = DIRECT_TARGET.exec(r.attributes.get('target_resource_id') ?? '');
      const target = !match ? 'unclassified' : match[1] === 'azurerm_storage_account' ? 'storage' : 'other';
      return { address: `${r.type}.${r.name}`, name: r.name, target, setsMode: r.attributes.has('log_analytics_destination_type') };
    });
}

/** The addresses of storage settings that set a collection mode, which Azure would not keep. */
const settingAMode = (source) =>
  diagnosticSettings(source)
    .filter((s) => s.target === 'storage' && s.setsMode)
    .map((s) => s.address);

/** The addresses whose target this cannot tell storage from not. */
const unclassified = (source) =>
  diagnosticSettings(source)
    .filter((s) => s.target === 'unclassified')
    .map((s) => s.address);

describe('storage diagnostic settings', () => {
  it('finds every storage diagnostic setting in the module, so the check below is not vacuous', () => {
    const names = diagnosticSettings(moduleSource())
      .filter((s) => s.target === 'storage')
      .map((s) => s.name);
    expect(names).toEqual(
      expect.arrayContaining(['content_blob', 'content_queue', 'functions_blob', 'functions_queue', 'lab_hybrid_backups_blob'])
    );
  });

  it('can classify every diagnostic setting, so none escapes the check through an indirect target', () => {
    // Reference the target resource directly, as every setting does today,
    // or extend DIRECT_TARGET to resolve the new form.
    expect(unclassified(moduleSource())).toEqual([]);
  });

  it('none names a collection mode, which Azure keeps no value for on storage', () => {
    expect(settingAMode(moduleSource())).toEqual([]);
  });

  it('refuses a target it cannot classify, such as one read from a local', () => {
    const source = `
locals {
  backup_blob_service_id = "\${azurerm_storage_account.example.id}/blobServices/default"
}

resource "azurerm_monitor_diagnostic_setting" "indirect" {
  name                           = "diag"
  target_resource_id             = local.backup_blob_service_id
  log_analytics_workspace_id     = azurerm_log_analytics_workspace.hcw.id
  log_analytics_destination_type = "Dedicated"
}
`;
    expect(unclassified(source)).toEqual(['azurerm_monitor_diagnostic_setting.indirect']);
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
