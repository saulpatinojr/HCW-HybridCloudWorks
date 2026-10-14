/**
 * Landing Zone Builder, Phase 1 (#667, epic #657): the logic behind "build an
 * Azure landing zone component by component and read the Terraform it
 * becomes", with no page yet. Mirrors pricingScenarios/: pure functions,
 * frozen catalogues, the state as a value and as a URL.
 *
 * PURE. No React, no DOM, no clock, no network. The input is a state
 * `{ selected, options }`; the outputs are plain objects, strings and
 * `{ path, content }` files. Nothing here talks to a tenant, and the README
 * every emission carries says so.
 *
 * One module per concern, this file the public surface:
 *   components.js   the eight components, what each teaches, its knobs
 *   avmVersions.js  the four Azure Verified Modules, pinned and dated
 *   cidr.js         the address arithmetic behind hub and spokes
 *   state.js        normalisation and the dependency rule
 *   share.js        the build as a query string
 *   hcl/            the build as Terraform files, one module per file
 *   labImage.js     which modules the lab's runner image can resolve (#672)
 *   tfConstraints.js  Terraform version constraints, as the image reads them
 *   labPayload.js   the files as a lab job payload (#672), imported by path
 *                   rather than from here, as LzFiles imports the zip's
 *                   compressor: only the button that sends one needs it
 *   diagram.js      the build as a laid-out tree
 */
export {
  COMPONENTS,
  COMPONENT_IDS,
  PLATFORM_IDS,
  APPLICATION_IDS,
  OPTIONS,
  OPTION_IDS,
  OPTION_CHOICES,
  FIREWALL_SKUS,
  MAX_LANDING_ZONES,
  componentById,
  componentByShortId,
  countOptionFor,
  isCidr,
  isSpokeCidr,
  isRootParentId,
  isFirewallSku,
  isLocation,
  isLandingZoneCount,
  isManagementGroupId,
} from './components';
export {
  AVM_MODULES,
  AVM_MODULE_NAMES,
  AVM_SOURCES,
  AVM_VERIFIED_ON,
  ALZ_LIBRARY_REFERENCE,
  PROVIDER_NAMES,
  PROVIDER_PINS,
  SUBSCRIPTION_SCOPED_PROVIDERS,
  TERRAFORM_REQUIRED_VERSION,
  avmModule,
  isAvmSource,
} from './avmVersions';
export {
  HUB_PREFIX_RANGE,
  SPOKE_MAX_PREFIX,
  SPOKE_PREFIX_RANGE,
  cidrsOverlap,
  spokeAddressSpace,
  spokeSlot,
} from './cidr';
export {
  DEFAULT_OPTIONS,
  DEFAULT_SELECTION,
  DEFAULT_STATE,
  SPOKE_CIDR_FALLBACKS,
  addComponent,
  dependentsOf,
  isComponentId,
  isSelected,
  normalizeOptions,
  normalizeState,
  removeWithDependents,
  selectedPlatform,
  setOption,
  withDependencies,
} from './state';
export { decodeLz, encodeLz, isLzParam } from './share';
export {
  LAB_IMAGE_AVM,
  LAB_IMAGE_AVM_ROOT,
  LAB_IMAGE_BUILDER_AVM,
  LAB_IMAGE_CHILD_AVM,
  labModuleReport,
  labResolution,
} from './labImage';
export { chooseVendored, parseVersion, satisfies, vendoredModules } from './tfConstraints';
export { emitFiles, emitAwsFiles, emitGcpFiles } from './hcl/index';
export { BASELINE_ASSIGNMENTS, POLICY_DEFAULTS, groupsAssigning } from './hcl/policy';
export { H_GAP, NODE_H, NODE_W, PAD, V_GAP, layoutDiagram } from './diagram';
export {
  AWS_PRESETS,
  GCP_PRESETS,
  LZ_PRESETS,
  MULTI_CLOUD_PACKS,
  MULTI_CLOUD_PRESETS,
  STANDING_COSTS_USD,
  activePresetForState,
  estimateMonthlyBaseline,
  presetHref,
} from './presets';
