/**
 * The builder's `location` option is an Azure region id (`centralus`,
 * `westeurope`). The AWS and Google Cloud packs used to copy it into their
 * tfvars example as it was, so the example asked AWS or Google for a region
 * neither has, and `terraform plan` failed (#1875).
 *
 * This maps an Azure region to the nearest AWS and Google Cloud region by
 * geography. A region not in the table gets the pack's own default, never
 * the Azure id. Nearest by location only: check the region offers the
 * services you need before you deploy.
 *
 * AWS regions are limited to ones every account has switched on. AWS keeps
 * newer regions (Zurich, Milan, Hong Kong, Melbourne) off until the account
 * owner opts in, and a plan there fails on an account that has not, so those
 * Azure regions map to the nearest region that is on by default.
 */

/** Azure region id → [nearest AWS region, nearest Google Cloud region]. */
const NEAREST = Object.freeze({
  eastus: ['us-east-1', 'us-east4'],
  eastus2: ['us-east-1', 'us-east4'],
  centralus: ['us-east-2', 'us-central1'],
  northcentralus: ['us-east-2', 'us-central1'],
  southcentralus: ['us-east-2', 'us-south1'],
  westcentralus: ['us-west-2', 'us-west3'],
  westus: ['us-west-1', 'us-west2'],
  westus2: ['us-west-2', 'us-west1'],
  westus3: ['us-west-1', 'us-west4'],
  canadacentral: ['ca-central-1', 'northamerica-northeast2'],
  canadaeast: ['ca-central-1', 'northamerica-northeast1'],
  brazilsouth: ['sa-east-1', 'southamerica-east1'],
  northeurope: ['eu-west-1', 'europe-west2'],
  westeurope: ['eu-central-1', 'europe-west4'],
  uksouth: ['eu-west-2', 'europe-west2'],
  ukwest: ['eu-west-2', 'europe-west2'],
  francecentral: ['eu-west-3', 'europe-west9'],
  germanywestcentral: ['eu-central-1', 'europe-west3'],
  swedencentral: ['eu-north-1', 'europe-north2'],
  switzerlandnorth: ['eu-central-1', 'europe-west6'],
  italynorth: ['eu-central-1', 'europe-west8'],
  japaneast: ['ap-northeast-1', 'asia-northeast1'],
  japanwest: ['ap-northeast-3', 'asia-northeast2'],
  koreacentral: ['ap-northeast-2', 'asia-northeast3'],
  southeastasia: ['ap-southeast-1', 'asia-southeast1'],
  eastasia: ['ap-northeast-2', 'asia-east2'],
  centralindia: ['ap-south-1', 'asia-south1'],
  australiaeast: ['ap-southeast-2', 'australia-southeast1'],
  australiasoutheast: ['ap-southeast-2', 'australia-southeast2'],
});

/** What a region id looks like on each cloud, for the tests and a guard. */
export const REGION_SHAPE = Object.freeze({
  aws: /^[a-z]{2}(-[a-z]+)+-\d$/,
  gcp: /^[a-z]+(-[a-z]+)*\d$/,
});

/**
 * The region the `cloud` pack's tfvars example writes for a builder
 * location, or `fallback` (the pack variable's own default) when the
 * location has no entry.
 */
export function nearestRegion(cloud, azureLocation, fallback) {
  const row = NEAREST[String(azureLocation || '').toLowerCase()];
  if (!row) return fallback;
  return cloud === 'aws' ? row[0] : row[1];
}

export const MAPPED_AZURE_REGIONS = Object.freeze(Object.keys(NEAREST));
