/**
 * The Azure Verified Modules the Landing Zone Builder emits (#667), pinned.
 *
 * EXACTLY THESE FOUR, and the versions are looked up, not remembered. Each
 * `version` is the latest the Terraform Registry listed on `verifiedOn`, read
 * from `https://registry.terraform.io/v1/modules/Azure/<name>/azurerm` and
 * cross-checked against the repository's latest GitHub release the same day.
 * Three are the ALZ pattern modules HashiCorp's validated pattern calls; the
 * fourth is the virtual network resource module every spoke is built from.
 * The pattern module for application landing zones,
 * avm-ptn-alz-application-landing-zone-identity-and-access, was on GitHub as
 * the unfilled AVM template with no release and no registry listing on the
 * verification date, so the builder does not call it; a spoke is a resource
 * module call plus a `subscription_placement` entry in avm-ptn-alz instead.
 * `avm-ptn-hubnetworking` is archived and is not here on purpose;
 * hcl.test.js asserts it never reaches the output.
 *
 * `requiredProviders` is each module's `required_providers` at its pinned
 * tag, read from that tag's `terraform.tf`. It drives two things that must
 * agree: the root `terraform.tf` declares every provider any module needs,
 * and every emitted `module` block's `providers` map names every provider
 * that module requires, because once a block carries a `providers` argument
 * Terraform stops inheriting defaults for the providers it leaves out.
 */
export const AVM_VERIFIED_ON = '2026-10-20';

const registryUrl = (name) => `https://registry.terraform.io/modules/Azure/${name}/azurerm`;
const repositoryUrl = (name) => `https://github.com/Azure/terraform-azurerm-${name}`;

const avm = (name, version, requiredProviders) =>
  Object.freeze({
    name,
    source: `Azure/${name}/azurerm`,
    version,
    verifiedOn: AVM_VERIFIED_ON,
    registry: registryUrl(name),
    repository: repositoryUrl(name),
    requiredProviders: Object.freeze(requiredProviders),
  });

/** Keyed by module name; every `version` is a published release string. */
export const AVM_MODULES = Object.freeze({
  'avm-ptn-alz': avm('avm-ptn-alz', '0.22.0', ['alz', 'azapi', 'modtm', 'random', 'time']),
  'avm-ptn-alz-management': avm('avm-ptn-alz-management', '0.9.0', [
    'azapi',
    'azurerm',
    'modtm',
    'random',
  ]),
  'avm-ptn-alz-connectivity-hub-and-spoke-vnet': avm(
    'avm-ptn-alz-connectivity-hub-and-spoke-vnet',
    '0.17.7',
    ['azapi', 'azurerm', 'modtm', 'random']
  ),
  'avm-res-network-virtualnetwork': avm('avm-res-network-virtualnetwork', '0.22.3', [
    'azapi',
    'modtm',
    'random',
  ]),
});

export const AVM_MODULE_NAMES = Object.freeze(Object.keys(AVM_MODULES));

export const AVM_SOURCES = Object.freeze(Object.values(AVM_MODULES).map((module) => module.source));

const AVM_BY_SOURCE = new Map(Object.values(AVM_MODULES).map((module) => [module.source, module]));

/** The pinned module by name; null for a name this builder does not emit. */
export function avmModule(name) {
  return AVM_MODULES[name] ?? null;
}

/** Whether a `source` string is one of the four pinned modules. */
export function isAvmSource(source) {
  return AVM_BY_SOURCE.has(source);
}

/**
 * What `terraform.tf` requires, chosen so every module above is satisfied:
 * avm-ptn-alz 0.21.0 wants terraform >= 1.12, alz ~> 0.21, azapi ~> 2.4,
 * modtm ~> 0.3, random ~> 3.6 and time ~> 0.9; management 0.9.0 wants
 * azapi ~> 2.4, azurerm ~> 4.35, modtm ~> 0.3 and random ~> 3.6; the
 * connectivity module 0.17.5 wants terraform ~> 1.12, azapi ~> 2.4,
 * azurerm ~> 4.0, modtm ~> 0.3 and random ~> 3.5; the virtual network
 * module 0.22.2 wants azapi ~> 2.12, modtm ~> 0.3 and random ~> 3.5.
 *
 * The alz line is avm-ptn-alz 0.21.0's own (`terraform.tf`, tag v0.21.0):
 * `~> 0.21` is Terraform's pessimistic constraint on a two-part version,
 * so it means `>= 0.21, < 1.0`, not 0.21.x. The lab image's mirror
 * (lab-image/versions.env, PROVIDER_ALZ_VERSION=0.22.0) satisfies it, as
 * do its azapi 2.12.0, azurerm 4.81.0, random 3.9.1, modtm 0.4.0 and time
 * 0.14.2.
 */
export const TERRAFORM_REQUIRED_VERSION = '>= 1.12, < 2.0';

export const PROVIDER_PINS = Object.freeze([
  Object.freeze({ name: 'alz', source: 'azure/alz', version: '~> 0.21' }),
  Object.freeze({ name: 'azapi', source: 'Azure/azapi', version: '~> 2.12' }),
  Object.freeze({ name: 'azurerm', source: 'hashicorp/azurerm', version: '~> 4.35' }),
  Object.freeze({ name: 'modtm', source: 'azure/modtm', version: '~> 0.3' }),
  Object.freeze({ name: 'random', source: 'hashicorp/random', version: '~> 3.6' }),
  Object.freeze({ name: 'time', source: 'hashicorp/time', version: '~> 0.9' }),
]);

export const PROVIDER_NAMES = Object.freeze(PROVIDER_PINS.map((pin) => pin.name));

/**
 * The providers whose configuration is a subscription, so a module block
 * maps them to the alias for the subscription it deploys into. Every other
 * provider (alz, modtm, random, time) has no subscription and maps to its
 * default configuration.
 */
export const SUBSCRIPTION_SCOPED_PROVIDERS = Object.freeze(['azurerm', 'azapi']);

/**
 * The ALZ library release the alz provider reads the `alz` architecture from:
 * the latest `platform/alz` tag on Azure/Azure-Landing-Zones-Library on the
 * verification date.
 */
export const ALZ_LIBRARY_REFERENCE = Object.freeze({ path: 'platform/alz', ref: '2026.08.1' });
