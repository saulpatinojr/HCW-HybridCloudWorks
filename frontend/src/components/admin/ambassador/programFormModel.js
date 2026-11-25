/**
 * The Settings tab's program editor: a stored program as the form holds it,
 * and the form checked and turned back into what a save sends.
 */
import { EVIDENCE_SOURCES, MEMBERSHIP_STATUSES, UPKEEP_PERIODS } from './ambassadorModel';

export const EMPTY_PROGRAM_FORM = Object.freeze({
  name: '',
  provider: '',
  category: 'community-expert',
  description: '',
  applicationUrl: '',
  eligibility: '',
  criteria: '',
  recommendedActivities: '',
  applicationWindow: { opens: '', closes: '', note: '' },
  renewalCadence: 'annual',
  expirationRule: '',
  requirements: [],
  evidenceTypes: [],
  reminders: { daysBeforeDeadline: 14, daysBeforeRenewal: 30 },
  customFields: [],
  membershipStatus: 'none',
  parentProgramId: '',
  contributionTrackerUrl: '',
  upkeep: { period: '', minCount: 2, note: '', evidenceTypes: [] },
});

export const EMPTY_REQUIREMENT = Object.freeze({
  id: '',
  label: '',
  description: '',
  evidenceTypes: [],
  minCount: 1,
  weight: 1,
});

const lines = (text) =>
  String(text || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

/** A stored value as the form holds it: the text, or the field's default when unset. */
const textOf = (value, fallback = '') => value || fallback;
/** A stored list as one-per-line text. */
const linesOf = (list) => (list || []).join('\n');

/** A stored program as the Settings editor's form (lists as one-per-line text). */
export function programForm(program) {
  if (!program) return { ...EMPTY_PROGRAM_FORM };
  const window = program.applicationWindow || {};
  const reminders = program.reminders || {};
  return {
    ...EMPTY_PROGRAM_FORM,
    name: textOf(program.name),
    provider: textOf(program.provider),
    category: textOf(program.category, EMPTY_PROGRAM_FORM.category),
    description: textOf(program.description),
    applicationUrl: textOf(program.applicationUrl),
    eligibility: linesOf(program.eligibility),
    criteria: linesOf(program.criteria),
    recommendedActivities: linesOf(program.recommendedActivities),
    applicationWindow: {
      opens: textOf(window.opens),
      closes: textOf(window.closes),
      note: textOf(window.note),
    },
    renewalCadence: textOf(program.renewalCadence, EMPTY_PROGRAM_FORM.renewalCadence),
    expirationRule: textOf(program.expirationRule),
    membershipStatus: MEMBERSHIP_STATUSES.includes(program.membershipStatus)
      ? program.membershipStatus
      : 'none',
    parentProgramId: textOf(program.parentProgramId),
    requirements: (program.requirements || []).map((r) => ({ ...EMPTY_REQUIREMENT, ...r })),
    evidenceTypes: program.evidenceTypes || [],
    reminders: {
      daysBeforeDeadline:
        reminders.daysBeforeDeadline ?? EMPTY_PROGRAM_FORM.reminders.daysBeforeDeadline,
      daysBeforeRenewal:
        reminders.daysBeforeRenewal ?? EMPTY_PROGRAM_FORM.reminders.daysBeforeRenewal,
    },
    customFields: program.customFields || [],
    contributionTrackerUrl: textOf(program.contributionTrackerUrl),
    upkeep: program.upkeep
      ? {
          period: textOf(program.upkeep.period),
          minCount: program.upkeep.minCount ?? EMPTY_PROGRAM_FORM.upkeep.minCount,
          note: textOf(program.upkeep.note),
          evidenceTypes: program.upkeep.evidenceTypes || [],
        }
      : { ...EMPTY_PROGRAM_FORM.upkeep },
  };
}

/** The tracker link as a save sends it: the URL, or null; `{ error }` for one that is not http(s). */
function trackerPayload(text) {
  const url = String(text || '').trim();
  if (url && !/^https?:\/\//i.test(url)) {
    return { error: 'Contribution tracker URL must start with http:// or https://.' };
  }
  return { value: url || null };
}

/** The upkeep rule as a save sends it, or null for none; `{ error }` for a minimum under 1. */
function upkeepPayload(rule = EMPTY_PROGRAM_FORM.upkeep) {
  if (!UPKEEP_PERIODS.includes(rule.period)) return { value: null };
  const minCount = Math.floor(Number(rule.minCount) || 0);
  if (minCount < 1) {
    return { error: 'Keeping the membership active needs a minimum of at least 1.' };
  }
  return {
    value: {
      period: rule.period,
      minCount,
      evidenceTypes: (rule.evidenceTypes || []).filter((t) => EVIDENCE_SOURCES.includes(t)),
      note: String(rule.note || '').trim(),
    },
  };
}

/** The requirements as a save sends them, each with an id (made up when blank). */
function requirementsPayload(requirements) {
  return (requirements || []).map((r, index) => ({
    id: String(r.id || '').trim() || `req-${index + 1}`,
    label: String(r.label || '').trim(),
    description: String(r.description || '').trim(),
    evidenceTypes: (r.evidenceTypes || []).filter((t) => EVIDENCE_SOURCES.includes(t)),
    minCount: Math.max(0, Math.floor(Number(r.minCount) || 0)),
    weight: Math.max(0, Number(r.weight) || 0),
  }));
}

/**
 * The parts of a save that need checking, checked in the order the form
 * shows them; `{ error }` names the first problem instead.
 */
function checkedProgramParts(form) {
  if (!String(form.name || '').trim()) return { error: 'Program name is required.' };
  if (form.applicationUrl && !/^https?:\/\//i.test(form.applicationUrl.trim())) {
    return { error: 'Application URL must start with http:// or https://.' };
  }
  const tracker = trackerPayload(form.contributionTrackerUrl);
  const upkeep = upkeepPayload(form.upkeep);
  if (tracker.error || upkeep.error) return { error: tracker.error || upkeep.error };
  const requirements = requirementsPayload(form.requirements);
  const unlabeled = requirements.findIndex((r) => !r.label);
  if (unlabeled !== -1) return { error: `Requirement ${unlabeled + 1} needs a label.` };
  return { tracker, upkeep, requirements };
}

/** What a program save sends; `{ error }` names the first problem instead. */
export function programPayload(form) {
  const checked = checkedProgramParts(form);
  if (checked.error) return { error: checked.error };
  const { tracker, upkeep, requirements } = checked;
  return {
    value: {
      name: form.name.trim(),
      provider: form.provider.trim(),
      category: form.category.trim(),
      membershipStatus: MEMBERSHIP_STATUSES.includes(form.membershipStatus)
        ? form.membershipStatus
        : 'none',
      parentProgramId: String(form.parentProgramId || '').trim() || null,
      description: form.description.trim(),
      applicationUrl: form.applicationUrl.trim() || null,
      eligibility: lines(form.eligibility),
      criteria: lines(form.criteria),
      recommendedActivities: lines(form.recommendedActivities),
      applicationWindow: {
        opens: form.applicationWindow.opens || null,
        closes: form.applicationWindow.closes || null,
        note: form.applicationWindow.note.trim(),
      },
      renewalCadence: form.renewalCadence.trim(),
      expirationRule: form.expirationRule.trim(),
      requirements,
      evidenceTypes: form.evidenceTypes,
      reminders: {
        daysBeforeDeadline: Math.max(0, Math.floor(Number(form.reminders.daysBeforeDeadline) || 0)),
        daysBeforeRenewal: Math.max(0, Math.floor(Number(form.reminders.daysBeforeRenewal) || 0)),
      },
      customFields: (form.customFields || []).filter((f) => f.id && f.label),
      contributionTrackerUrl: tracker.value,
      upkeep: upkeep.value,
    },
  };
}
