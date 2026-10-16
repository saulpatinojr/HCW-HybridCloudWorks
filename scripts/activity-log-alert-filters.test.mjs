/**
 * No Administrative Activity Log alert can fire on its own alerts (#1216).
 *
 * A change to an alert's state is an Administrative event, logged against the
 * alert's target as `<target id>/providers/Microsoft.AlertsManagement/alerts/
 * <id>`. A rule whose only filters are category and status matches it whenever
 * the target is inside its scope, which a rule's own alerts always are. So
 * closing one of them opens another and pages again. alert-kv-config-write did
 * exactly that on 2026-10-16, when the cleanup closed three of its alerts and
 * three new ones fired at 01:37Z.
 *
 * Activity Log conditions have no "not equals", so the guard is a positive
 * filter. Every Administrative rule names the resource providers or types it
 * watches, and none of them is Microsoft.AlertsManagement.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { moduleBlocks } from './lib/alert-declarations.mjs';
import { parseBody } from './lib/hcl-blocks.mjs';

const INFRA = join(dirname(fileURLToPath(import.meta.url)), '..', 'infra');
const FILTERS = ['resource_provider', 'resource_providers', 'resource_type', 'resource_types'];

/** Every `.tf` file in infra/, as one module, the way Terraform reads it. */
const moduleSource = () =>
  readdirSync(INFRA)
    .filter((f) => f.endsWith('.tf'))
    .map((f) => readFileSync(join(INFRA, f), 'utf8'))
    .join('\n');

/** Each Activity Log alert with its criteria block's attributes, as source text. */
function activityLogAlerts(source) {
  return [...moduleBlocks(source).resources.values()]
    .filter((r) => r.type === 'azurerm_monitor_activity_log_alert')
    .map((r) => {
      const criteria = r.blocks.find((b) => b.type === 'criteria');
      return { address: `${r.type}.${r.name}`, criteria: criteria ? parseBody(criteria.body).attributes : new Map() };
    });
}

/** The addresses of Administrative rules that can match a change to an alert's state. */
function selfTriggering(source) {
  return activityLogAlerts(source)
    .filter(({ criteria }) => /"Administrative"/.test(criteria.get('category') ?? ''))
    .filter(({ criteria }) => {
      const filters = FILTERS.filter((name) => criteria.has(name)).map((name) => criteria.get(name));
      return filters.length === 0 || filters.some((text) => /Microsoft\.AlertsManagement/i.test(text));
    })
    .map(({ address }) => address);
}

describe('Activity Log alert filters', () => {
  it('reads every Activity Log alert in the module, so the check below is not vacuous', () => {
    const addresses = activityLogAlerts(moduleSource()).map((a) => a.address);
    expect(addresses).toEqual(
      expect.arrayContaining([
        'azurerm_monitor_activity_log_alert.key_vault_config_writes',
        'azurerm_monitor_activity_log_alert.rbac_assignment_writes_app',
        'azurerm_monitor_activity_log_alert.rbac_definition_writes_app',
      ])
    );
  });

  it('no Administrative rule can fire on a change to its own alerts', () => {
    expect(selfTriggering(moduleSource())).toEqual([]);
  });

  it('names a rule with no provider or type filter, and one that lets alert changes through', () => {
    const source = `
resource "azurerm_monitor_activity_log_alert" "bare" {
  name   = "a"
  scopes = [azurerm_key_vault.hcw.id]
  criteria {
    category = "Administrative"
    statuses = ["Succeeded", "Failed"]
  }
}

resource "azurerm_monitor_activity_log_alert" "leaky" {
  name   = "b"
  scopes = [azurerm_key_vault.hcw.id]
  criteria {
    category           = "Administrative"
    resource_providers = ["Microsoft.KeyVault", "Microsoft.AlertsManagement"]
  }
}

resource "azurerm_monitor_activity_log_alert" "filtered" {
  name   = "c"
  scopes = [azurerm_key_vault.hcw.id]
  criteria {
    category           = "Administrative"
    resource_providers = ["Microsoft.KeyVault"]
  }
}
`;
    expect(selfTriggering(source)).toEqual([
      'azurerm_monitor_activity_log_alert.bare',
      'azurerm_monitor_activity_log_alert.leaky',
    ]);
  });
});
