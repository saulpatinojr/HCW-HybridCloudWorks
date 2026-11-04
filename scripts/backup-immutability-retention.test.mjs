/**
 * backup-immutability-retention.test.mjs — tests for PLAT-8 audit remediation (#968).
 *
 * Asserts the presence and invariants of:
 * 1. Time-based WORM immutability policy on the cosmos-export container (35 days).
 * 2. Dedicated cosmos-export-state container for continuation tokens.
 * 3. Log Analytics workspace retention at or above 90 days.
 * 4. Cosmos DB diagnostic setting carrying DataPlaneRequests, filtered at ingestion
 *    by the workspace transformation rule (#1530).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { moduleBlocks } from './lib/alert-declarations.mjs';

const INFRA = join(dirname(fileURLToPath(import.meta.url)), '..', 'infra');

const storageTf = readFileSync(join(INFRA, 'storage.tf'), 'utf8');
const mainTf = readFileSync(join(INFRA, 'main.tf'), 'utf8');
const variablesTf = readFileSync(join(INFRA, 'variables.tf'), 'utf8');
const observabilityTf = readFileSync(join(INFRA, 'observability.tf'), 'utf8');

describe('PLAT-8 backup immutability & log retention audit checks (#968)', () => {
  describe('Cosmos export container immutability & state isolation', () => {
    it('declares time-based immutability policy for cosmos-export with 35-day retention', () => {
      const blocks = moduleBlocks(storageTf);
      const policy = blocks.resources.get('azurerm_storage_container_immutability_policy.cosmos_export');
      expect(policy, 'azurerm_storage_container_immutability_policy.cosmos_export must exist').toBeDefined();
      expect(policy.attributes.get('storage_container_resource_manager_id')).toBe(
        'azurerm_storage_container.cosmos_export.id'
      );
      expect(policy.attributes.get('immutability_period_in_days')).toBe('35');
      expect(policy.attributes.get('locked')).toBe('var.cosmos_export_immutability_locked');
      expect(storageTf).toMatch(
        /resource\s+"azurerm_storage_container_immutability_policy"\s+"cosmos_export"[\s\S]*?prevent_destroy\s*=\s*true/
      );
    });

    it('declares dedicated cosmos-export-state container for mutable change-feed continuation tokens', () => {
      const blocks = moduleBlocks(storageTf);
      const container = blocks.resources.get('azurerm_storage_container.cosmos_export_state');
      expect(container, 'azurerm_storage_container.cosmos_export_state must exist').toBeDefined();
      expect(container.attributes.get('name')).toBe('"cosmos-export-state"');
      expect(container.attributes.get('container_access_type')).toBe('"private"');
    });

    it('declares variable cosmos_export_immutability_locked with default false', () => {
      expect(variablesTf).toMatch(/variable\s+"cosmos_export_immutability_locked"\s*\{[\s\S]*?default\s*=\s*false/);
    });
  });

  describe('Log Analytics retention at or above 90 days', () => {
    it('sets workspace retention to var.logs_retention_in_days', () => {
      const blocks = moduleBlocks(mainTf);
      const ws = blocks.resources.get('azurerm_log_analytics_workspace.hcw');
      expect(ws, 'azurerm_log_analytics_workspace.hcw must exist').toBeDefined();
      expect(ws.attributes.get('retention_in_days')).toBe('var.logs_retention_in_days');
    });

    it('declares logs_retention_in_days defaulting to 90 days with boundary validation', () => {
      expect(variablesTf).toMatch(
        /variable\s+"logs_retention_in_days"\s*\{[\s\S]*?default\s*=\s*90[\s\S]*?condition\s*=\s*var\.logs_retention_in_days >= 30/
      );
    });
  });

  describe('Cosmos DB data-plane audit with PII container filtering', () => {
    it('enables both ControlPlaneRequests and DataPlaneRequests in diagnostic setting', () => {
      expect(observabilityTf).toMatch(
        /resource\s+"azurerm_monitor_diagnostic_setting"\s+"cosmos"[\s\S]*?category\s*=\s*"ControlPlaneRequests"[\s\S]*?category\s*=\s*"DataPlaneRequests"/
      );
    });

    // Until #1530 this asserted a `transformKql` property on the table, which
    // is what PLAT-8 wrote and what Azure never stored: the Tables API has no
    // such property, so the filter never ran. The filter is a data collection
    // rule of kind WorkspaceTransforms, linked as the workspace's default
    // rule, and the three assertions below hold the three parts together.
    it('filters CDBDataPlaneRequests in a WorkspaceTransforms data collection rule that keeps the personal-data containers (#1530)', () => {
      const rule = /resource\s+"azurerm_monitor_data_collection_rule"\s+"workspace_transforms"[\s\S]*?\n}/.exec(observabilityTf);
      expect(rule, 'azurerm_monitor_data_collection_rule.workspace_transforms not found').not.toBeNull();
      expect(rule[0]).toMatch(/kind\s*=\s*"WorkspaceTransforms"/);
      expect(rule[0]).toMatch(/streams\s*=\s*\["Microsoft-Table-CDBDataPlaneRequests"\]/);
      expect(rule[0]).toMatch(/transform_kql\s*=\s*local\.cosmos_request_log_transform_kql/);
      const kql = /cosmos_request_log_transform_kql\s*=\s*"([^"]+)"/.exec(observabilityTf);
      expect(kql, 'local.cosmos_request_log_transform_kql not found').not.toBeNull();
      expect(kql[1]).toMatch(/^source \| where /);
      for (const container of ['ambassador', 'doc_vault', 'brain_records']) {
        expect(kql[1], `${container} must be kept in full`).toContain(`'${container}'`);
      }
    });

    it('links the rule as the workspace default, through an attribute azurerm reads back (#1530)', () => {
      expect(mainTf).toMatch(
        /resource\s+"azurerm_log_analytics_workspace"\s+"hcw"[\s\S]*?data_collection_rule_id\s*=\s*azurerm_monitor_data_collection_rule\.workspace_transforms\.id/
      );
    });

    it('keeps the table retention at var.logs_retention_in_days on an azurerm table resource, not an azapi write (#1530)', () => {
      expect(observabilityTf).toMatch(
        /resource\s+"azurerm_log_analytics_workspace_table"\s+"cosmos_data_plane"[\s\S]*?name\s*=\s*"CDBDataPlaneRequests"[\s\S]*?retention_in_days\s*=\s*var\.logs_retention_in_days[\s\S]*?total_retention_in_days\s*=\s*var\.logs_retention_in_days/
      );
      expect(observabilityTf).not.toMatch(/resource\s+"azapi_update_resource"\s+"cosmos_data_plane_table"/);
      // The comments may tell the history; no attribute may set it again.
      expect(observabilityTf).not.toMatch(/^\s*transformKql\s*=/m);
    });
  });
});
