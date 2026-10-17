/**
 * The Terraform run identity may ASSIGN roles. It may not INVENT them.
 *
 * ## The failure this catches
 *
 * `azurerm_role_definition` needs `Microsoft.Authorization/roleDefinitions/write`.
 * The HCP Terraform workspace identity is Contributor + Role Based Access
 * Control Administrator, and neither built-in role carries it — verified
 * against Microsoft's published definitions, not from memory:
 *
 *   - Contributor's notActions include `Microsoft.Authorization/*\/Write`.
 *   - RBAC Administrator's actions are roleAssignments/write,
 *     roleAssignments/delete, `*\/read` and Microsoft.Support/*. `*\/read`
 *     covers roleDefinitions/READ and stops there.
 *
 * So a `resource "azurerm_role_definition"` block does not fail review, does
 * not fail `terraform validate`, does not fail `plan` — it fails at APPLY, on
 * the owner's confirmation, with an authorization error naming
 * Microsoft.Authorization rather than the feature being deployed. infra/oidc.tf
 * records that happening on 2026-08-21; infra/keyvault.tf reintroduced it on
 * 2026-08-29 in the two roles the API Keys page depends on, where it would have
 * broken the very apply that turns the page on. Twice is a pattern, and a
 * pattern that only shows up at apply time is what a guard is for.
 *
 * ## The shape that works instead
 *
 * The owner creates the definition once from reviewed JSON in `infra/roles/`,
 * and Terraform consumes it by name:
 *
 *   az role definition create --role-definition @infra/roles/<name>.json
 *
 *   data "azurerm_role_definition" "x" { name = "..." scope = ... }
 *   resource "azurerm_role_assignment" "y" { role_definition_id = data...id }
 *
 * That is what this asserts: no `resource` form anywhere in the module, and
 * every `data` form backed by a JSON file whose `Name` matches, so the lookup
 * cannot silently name a role nobody ever created. A missing definition would
 * otherwise surface as "role definition not found" at apply — the same class of
 * late failure, one step further along.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { terraformSource, INFRA } from './terraform-source.mjs';

const ROOT = dirname(INFRA);
const ROLES = join(INFRA, 'roles');

/** `Name` from every reviewed role JSON, which is what `az role definition create` registers. */
function reviewedRoleNames() {
  return readdirSync(ROLES)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(ROLES, f), 'utf8')).Name);
}

describe('custom role definitions', () => {
  const source = terraformSource();

  it('reads the module and the role JSONs at all', () => {
    // Guards the guard: an empty scan on either side makes every assertion
    // below pass by comparing nothing to nothing.
    expect(source.length).toBeGreaterThan(1000);
    expect(reviewedRoleNames().length).toBeGreaterThan(0);
  });

  it('are never declared as a Terraform resource', () => {
    const declared = [...source.matchAll(/^resource\s+"azurerm_role_definition"\s+"(\w+)"/gm)].map(
      (m) => m[1]
    );
    expect(
      declared,
      'infra/*.tf declares azurerm_role_definition as a `resource`. That needs ' +
        'Microsoft.Authorization/roleDefinitions/write, which the Terraform run identity ' +
        'does not hold (Contributor excludes Microsoft.Authorization/*/Write; RBAC ' +
        'Administrator grants roleAssignments/write and */read only), so it fails at ' +
        'APPLY and not before. Move the definition to infra/roles/<name>.json for the ' +
        'owner to create with `az role definition create`, and read it back with a ' +
        '`data "azurerm_role_definition"` block.'
    ).toEqual([]);
  });

  it('are looked up by a name some reviewed JSON actually registers', () => {
    // A data lookup naming a role nobody created fails at apply with "role
    // definition not found" — later than here, and reading like a permissions
    // problem rather than a missing owner step.
    const reviewed = new Set(reviewedRoleNames());
    const lookups = [
      ...source.matchAll(
        /^data\s+"azurerm_role_definition"\s+"(\w+)"\s*\{[^}]*?\bname\s*=\s*"([^"]+)"/gms
      ),
    ].map((m) => ({ label: m[1], name: m[2] }));

    expect(lookups.length, 'no data "azurerm_role_definition" blocks found — the regex has rotted').toBeGreaterThan(0);

    const orphans = lookups
      .filter((l) => !reviewed.has(l.name))
      .map((l) => `${l.label} looks up "${l.name}", which no infra/roles/*.json declares`);
    expect(orphans).toEqual([]);
  });

  it('never gives a reviewed JSON an assignable scope Azure refuses outright', () => {
    // The narrow claim, because the broad one is false. Microsoft documents
    // custom roles as assignable at management group, subscription and resource
    // group scopes — but cosmos-container-writer.json (deleted with the healer
    // in #816) named a RESOURCE and was created and used, so ARM accepts more
    // than the doc lists. Asserting
    // the documented set would fail CI on a role that works, which is how a
    // guard teaches people to ignore guards.
    //
    // What IS enforced, and is a documented hard limit: the root scope "/" is
    // refused, and wildcards are refused so nobody can widen a role by editing
    // its definition. Both fail at `az role definition create`, on the owner,
    // after review has passed.
    //
    // Prefer a resource group for new roles anyway — it is the documented shape
    // and costs nothing when the group holds only what the role reaches.
    const bad = readdirSync(ROLES)
      .filter((f) => f.endsWith('.json'))
      .flatMap((f) => {
        const scopes = JSON.parse(readFileSync(join(ROLES, f), 'utf8')).AssignableScopes ?? [];
        if (scopes.length === 0) return [`${f}: AssignableScopes is empty`];
        return scopes
          .filter((s) => s === '/' || s.includes('*'))
          .map((s) => `${f}: ${s} is a root or wildcard scope, which ARM refuses`);
      });
    expect(bad).toEqual([]);
  });

  it('provides bootstrap-roles scripts that cover every reviewed custom role', () => {
    const ps1Path = join(ROOT, 'scripts', 'bootstrap-roles.ps1');
    const shPath = join(ROOT, 'scripts', 'bootstrap-roles.sh');

    const ps1 = readFileSync(ps1Path, 'utf8');
    const sh = readFileSync(shPath, 'utf8');

    const roles = readdirSync(ROLES).filter((f) => f.endsWith('.json'));
    for (const roleFile of roles) {
      expect(ps1).toContain(roleFile);
      expect(sh).toContain(roleFile);
    }
  });
});
