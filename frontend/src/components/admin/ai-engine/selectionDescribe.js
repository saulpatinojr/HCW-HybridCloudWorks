import { providerLabel } from './providerLabels';

// What the resolver's answer says, in words and badges, for the task rows
// and the Priority list. Re-exported by selectionModel.js.

/**
 * What a task will use, in a sentence, from the resolver's chain: the model
 * named on the first candidate, or the provider's default (judged on the
 * modality model), via the provider; or that nothing is eligible.
 */
export function describeEffective(resolved, providers = []) {
  const first = resolved?.chain?.[0];
  if (resolved?.planned) return 'Not connected yet';
  if (!first) return 'No eligible model';
  const via = providerLabel(first.provider, providers);
  if (first.model) return `${first.model} via ${via}`;
  // modalityModel is an eligibility check, not the model used for each purpose.
  if (resolved?.media && first.modalityModel) return `${first.modalityModel} via ${via}`;
  return `Provider default via ${via}`;
}

/** The first turned-away candidate, as "Provider: why", or null. */
export function firstRejection(resolved, providers = []) {
  const first = resolved?.rejected?.[0];
  return first ? `${providerLabel(first.provider, providers)}: ${first.why}` : null;
}

/**
 * The badges a task row carries (ADR 0034 §4): the recommendation did not
 * lead, the custom chain had nothing eligible, the model it will use is
 * unpriced, or nothing is eligible at all.
 */
export function taskBadges(resolved, catalog = null) {
  if (resolved?.planned) return ['planned'];
  const asked = resolved?.entry?.mode;
  const got = resolved?.mode;
  const first = resolved?.chain?.[0] || null;
  return [
    asked === 'recommended' && got !== 'recommended' && 'recommendation not live',
    asked === 'custom' && got !== 'custom' && 'custom had nothing eligible',
    !first && 'no eligible model',
    first && isUnpriced(catalog, first) && 'unpriced',
  ].filter(Boolean);
}

/** True when the catalogue prices neither the candidate's model nor the one it was judged on. */
function isUnpriced(catalog, candidate) {
  const model = candidate.model || candidate.modalityModel;
  return catalog?.providers?.[candidate.provider]?.models?.[model]?.unpriced === true;
}

/**
 * Retired models the Priority list or a custom chain still names, from the
 * resolver's rejections (`code: 'retired'`), each with where it is named.
 */
export function retiredInUse(effective) {
  const seen = new Map();
  for (const [task, resolved] of Object.entries(effective?.tasks || {})) {
    for (const r of resolved?.rejected || []) {
      if (r.code !== 'retired') continue;
      const key = `${r.provider}/${r.model}`;
      const where = r.selection === 'custom' ? resolved.label || task : 'the Priority list';
      const entry = seen.get(key) || { provider: r.provider, model: r.model, where: [] };
      if (!entry.where.includes(where)) entry.where.push(where);
      seen.set(key, entry);
    }
  }
  return [...seen.values()];
}

/**
 * The Priority row's one-line "will use": the named model, or what a null
 * resolves to for text (drafts and short answers) and for vision, from what
 * the API reports per row.
 */
export function describePriorityRow(row) {
  if (!row) return '';
  if (row.model) return `Will use ${row.model} for every task.`;
  const d = row.defaults || {};
  const text =
    d.draft && d.general && d.draft !== d.general
      ? `${d.draft} for drafts, ${d.general} for short answers`
      : d.general || d.draft || 'provider default';
  const vision = row.modality?.vision ? d.multimodal || row.modality.vision : null;
  return `Will use ${text}; vision: ${vision || 'no model — the next row serves'}.`;
}
