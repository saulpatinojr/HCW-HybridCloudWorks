/**
 * How a plan difference is printed (#719). Pure; no I/O.
 *
 * EVERYTHING PRINTED HERE IS PUBLISHED. This repository is public, and
 * `tfc-plan-check.yml` writes the verdict to its job summary and log, which
 * anyone can read. The plan itself stays behind HCP Terraform's workspace
 * access, so the report names what changed and leaves the values where they
 * are protected. The rules, applied in order:
 *
 *   1. A value under `before_sensitive` or `after_sensitive` prints as
 *      `(sensitive)` on both sides, and so does a block with anything
 *      sensitive beneath it.
 *   2. A value under `after_unknown` prints as `(known after apply)`, and a
 *      list or object about to be recomputed prints by its size.
 *   3. An `app_settings` value prints as `(set)`. They are free-form strings,
 *      and a literal written on the live app outside Terraform, which
 *      infra/functionapp.tf expects can happen, is exactly the drift this
 *      catches. The path is the finding. The same goes for the Cloudflare
 *      identifiers the Web Analytics site carries (#1923): `account_id`,
 *      `zone_tag`, `site_tag`, `site_token` and `snippet`. They are 32-hex
 *      strings (or hold one) that the GUID rule below does not catch, and
 *      the owner's values are never written in this repository.
 *   4. Any string of six or more characters that the plan marks sensitive
 *      anywhere is replaced wherever it appears in a printed value. That
 *      covers resource values, sensitive input variables and sensitive
 *      outputs. It closes the case a local Terraform 1.15.8 plan showed on
 *      2026-09-27, where a provider copied a sensitive input into a computed
 *      attribute it does not declare sensitive (`terraform_data`'s `output`),
 *      and the copy arrived unmarked.
 *   5. A GUID prints as `<guid>` and an email address as `<email>`.
 *      Subscription and tenant ids are kept out of CI logs on purpose
 *      (infra/variables.tf), and an address is personal data.
 */

import { isSet, own } from './plan-diff.mjs';

const SENSITIVE = '(sensitive)';
const UNKNOWN = '(known after apply)';

/** Top-level attributes whose values are never printed (rule 3). */
export const HIDDEN_VALUES = new Set(['app_settings', 'account_id', 'zone_tag', 'site_tag', 'site_token', 'snippet']);

/** Shorter strings are too common to redact without masking ordinary values. */
const MIN_SECRET_LENGTH = 6;

const GUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

const isContainer = (value) => value !== null && typeof value === 'object';

/** A value for the report. `undefined` is an attribute or element that is not there. */
export const render = (value) => (value === undefined ? '(absent)' : JSON.stringify(value));

/** A list or object by its size. */
function sizeOf(value) {
  if (Array.isArray(value)) return `(a list of ${value.length} item${value.length === 1 ? '' : 's'})`;
  const keys = Object.keys(value).length;
  return `(an object with ${keys} key${keys === 1 ? '' : 's'})`;
}

/** One side of a difference, before redaction. */
function side(value, hidden) {
  if (value === undefined || value === null || !hidden) return render(value);
  return isContainer(value) ? sizeOf(value) : '(set)';
}

/** Every string at or beneath a value. */
function collectStrings(value, into) {
  if (typeof value === 'string') {
    if (value.length >= MIN_SECRET_LENGTH) into.add(value);
  } else if (isContainer(value)) {
    for (const child of Object.values(value)) collectStrings(child, into);
  }
}

/** Every string under a set marker. */
function collectMarked(value, marker, into) {
  if (isSet(marker)) collectStrings(value, into);
  else if (isContainer(value) && isContainer(marker)) {
    for (const key of Object.keys(value)) collectMarked(value[key], own(marker, key), into);
  }
}

const asArray = (value) => (Array.isArray(value) ? value : []);

/** The strings a plan marks sensitive in its resource and output changes. */
function markedChangeStrings(plan, into) {
  const outputs = Object.values(isContainer(plan?.output_changes) ? plan.output_changes : {});
  for (const change of [...asArray(plan?.resource_changes).map((c) => c?.change), ...outputs]) {
    collectMarked(change?.before, change?.before_sensitive, into);
    collectMarked(change?.after, change?.after_sensitive, into);
  }
}

/**
 * Every string the plan marks sensitive (rule 4), longest first so that a
 * secret containing another is replaced whole.
 */
export function secretsOf(plan) {
  const into = new Set();
  markedChangeStrings(plan, into);
  const declared = own(own(plan?.configuration, 'root_module'), 'variables');
  for (const [name, variable] of Object.entries(isContainer(plan?.variables) ? plan.variables : {})) {
    if (own(declared, name)?.sensitive === true) collectStrings(variable?.value, into);
  }
  return [...into].sort((a, b) => b.length - a.length);
}

/** Rules 4 and 5, on text that is about to be printed. */
export function redact(text, secrets = []) {
  let out = text;
  for (const secret of secrets) {
    // A secret appears JSON-escaped inside a rendered string value.
    for (const form of new Set([secret, JSON.stringify(secret).slice(1, -1)])) {
      out = out.split(form).join(SENSITIVE);
    }
  }
  return out.replace(GUID, '<guid>').replace(EMAIL, '<email>');
}

/** `before -> after` for one difference from lib/plan-diff.mjs, safe to publish. */
export function describeDifference(difference, secrets = []) {
  const { before, after, sensitive, unknown } = difference;
  if (sensitive) return `${SENSITIVE} -> ${unknown ? UNKNOWN : SENSITIVE}`;
  const hidden = HIDDEN_VALUES.has(difference.root);
  const left = unknown && isContainer(before) ? sizeOf(before) : side(before, hidden);
  const right = unknown ? UNKNOWN : side(after, hidden);
  return redact(`${left} -> ${right}`, secrets);
}
