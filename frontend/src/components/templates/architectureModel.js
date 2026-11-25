// Plain-data helpers for ArchitectureDetailTemplate: which design to show,
// which deep-dive tabs have something in them, and where each landing pane
// leads.

function hasText(value) {
  return Boolean(value) && String(value).trim() !== '';
}

export function hasNonEmptyList(list) {
  return Array.isArray(list) && list.some(hasText);
}

// `list` with `keep` applied, or an empty list when it is not a list at all.
function listOf(list, keep = Boolean) {
  return Array.isArray(list) ? list.filter(keep) : [];
}

// Both spellings the backend reads: the RSS import writes 'Cloud Provider',
// a manual submission writes cloudProvider (functions/src/lib/content/inspect.js).
function providerOf(item) {
  return String(item?.cloudProvider || item?.['Cloud Provider'] || item?.provider || '')
    .trim()
    .toLowerCase();
}

// The design to show: the built-in one, refreshed by the API's copy when the
// API's copy is an architecture for this provider.
export function resolveArchitecture(item, staticData, providerKey) {
  const itemProvider = providerOf(item);
  // An API design with no provider at all (the API keeps such designs as
  // unattributed) is shown only where this provider has a built-in design of
  // the same address, which it then refreshes. Otherwise it would show under
  // every provider's heading, VMware included (Copilot review of #1624).
  const providerMatches = itemProvider ? itemProvider === providerKey : Boolean(staticData);
  const isArchitecture = Boolean(item) && String(item.type || '').toLowerCase() === 'architecture';
  const dynamicArchitecture = isArchitecture && providerMatches ? item : null;
  return dynamicArchitecture ? { ...staticData, ...dynamicArchitecture } : staticData;
}

function isCostTrap(trap) {
  return Boolean(trap) && Boolean(trap.service || trap.trap || trap.mitigation);
}

function isBreakdownRow(row) {
  return Boolean(row) && Boolean(row.item || row.label || row.category);
}

function overviewSection(architecture) {
  const overviewContent = architecture?.overviewHtml || architecture?.overview || '';
  const specComponents = listOf(architecture?.technicalSpecs?.components);
  const specPatterns = listOf(architecture?.technicalSpecs?.patterns);
  const whenNotToUse = listOf(architecture?.whenNotToUse, hasText);
  const hasWhenNotToUse = whenNotToUse.length > 0;
  const hasSpecs = specComponents.length > 0 || specPatterns.length > 0;
  return {
    overviewContent,
    specComponents,
    specPatterns,
    whenNotToUse,
    hasWhenNotToUse,
    hasOverview: Boolean(String(overviewContent).trim() || hasSpecs || hasWhenNotToUse),
  };
}

function implementationSection(architecture) {
  const deploymentSteps = listOf(architecture?.deploymentSteps, hasText);
  const terraformCode = hasText(architecture?.terraformCode) ? architecture.terraformCode : '';
  const hasLabVerification = Boolean(
    architecture?.interactiveLabId || architecture?.ecosystemPartnerValidation
  );
  return {
    deploymentSteps,
    terraformCode,
    hasLabVerification,
    hasImplementation: Boolean(terraformCode || deploymentSteps.length > 0 || hasLabVerification),
  };
}

function costSection(architecture) {
  const estimatedMonthly =
    architecture?.costAnalysis?.estimatedMonthly || architecture?.estimatedCost || '';
  const costOptimizations = listOf(architecture?.costAnalysis?.optimizations);
  const costBreakdown = listOf(architecture?.costAnalysis?.breakdown, isBreakdownRow);
  const finopsCostTraps = listOf(architecture?.finopsCostTraps, isCostTrap);
  const hasFinopsCostTraps = finopsCostTraps.length > 0;
  const hasLists = costOptimizations.length > 0 || costBreakdown.length > 0;
  return {
    estimatedMonthly,
    costOptimizations,
    costBreakdown,
    finopsCostTraps,
    hasFinopsCostTraps,
    hasCost: Boolean(String(estimatedMonthly).trim() || hasLists || hasFinopsCostTraps),
  };
}

// Everything the deep-dive tabs show, and which tabs have content.
export function deepDiveSections(architecture) {
  const sections = {
    ...overviewSection(architecture),
    hasWaf: Boolean(architecture?.waf),
    ...implementationSection(architecture),
    ...costSection(architecture),
  };
  sections.availableTabs = [
    sections.hasOverview && { value: 'overview', label: 'Overview' },
    sections.hasWaf && { value: 'waf', label: 'Well-Architected' },
    sections.hasImplementation && { value: 'implementation', label: 'Implementation' },
    sections.hasCost && { value: 'cost', label: 'Cost Analysis' },
  ].filter(Boolean);
  return sections;
}

function outcomeTab({ hasCost, hasImplementation }) {
  if (hasCost) return 'cost';
  return hasImplementation ? 'implementation' : 'overview';
}

// Which tab a landing pane opens. Undefined for a pane with no deep dive.
export function paneTab(paneId, sections) {
  const overviewOrImplementation = sections.hasOverview ? 'overview' : 'implementation';
  const targets = {
    'how-it-works': overviewOrImplementation,
    'key-services': overviewOrImplementation,
    security: sections.hasWaf ? 'waf' : 'overview',
    outcome: outcomeTab(sections),
  };
  return Object.hasOwn(targets, paneId) ? targets[paneId] : undefined;
}

function nonEmptyArray(list) {
  return Array.isArray(list) && list.length > 0;
}

function howItWorksPane(architecture) {
  if (hasNonEmptyList(architecture.howItWorks)) return architecture.howItWorks;
  if (Array.isArray(architecture.topology?.stages)) {
    return architecture.topology.stages.map((s) => s.subtitle).filter(Boolean);
  }
  return [];
}

function keyServicesPane(architecture, specComponents) {
  if (nonEmptyArray(architecture.keyServices)) return architecture.keyServices;
  if (nonEmptyArray(architecture.services)) return architecture.services;
  return specComponents.map((name) => ({ name, role: '' }));
}

// What the four landing panes show, each falling back to the deep-dive data
// when the design has no pane-specific list.
export function landingPanes(architecture, specComponents, specPatterns) {
  return {
    howItWorks: howItWorksPane(architecture),
    keyServices: keyServicesPane(architecture, specComponents),
    practices: hasNonEmptyList(architecture.practices) ? architecture.practices : specPatterns,
  };
}

// The one-line promise shown on the landing frame (undefined when none).
export function architecturePromise(architecture) {
  return architecture.promise || architecture.summary || architecture.description;
}

// The same line for meta tags and sharing, never undefined.
export function architectureSummary(architecture) {
  return architecturePromise(architecture) || '';
}

export function hotspotsOf(architecture) {
  return architecture?.hotspots || [];
}

// Category and complexity, when set, as badges on the landing frame.
export function landingBadges(architecture) {
  return [
    architecture.category && { label: architecture.category, variant: 'default' },
    architecture.complexity && { label: architecture.complexity, variant: 'secondary' },
  ].filter(Boolean);
}
