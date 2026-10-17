/**
 * backup-immutability-retention.test.mjs — tests for PLAT-8 audit remediation (#968).
 *
 * Asserts the presence and invariants of:
 * 1. Time-based WORM immutability policy on the cosmos-export container (35 days).
 * 2. Dedicated cosmos-export-state container for continuation tokens.
 * 3. Log Analytics workspace retention at or above 90 days.
 * 4. Cosmos DB diagnostic setting carrying DataPlaneRequests with PII container filtering.
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

    it('configures table ingestion transformation on CDBDataPlaneRequests filtering to ambassador container', () => {
      expect(observabilityTf).toMatch(
        /resource\s+"azapi_update_resource"\s+"cosmos_data_plane_table"[\s\S]*?tables\/CDBDataPlaneRequests[\s\S]*?transformKql[\s\S]*?ambassador/
      );
    });
  });
});
