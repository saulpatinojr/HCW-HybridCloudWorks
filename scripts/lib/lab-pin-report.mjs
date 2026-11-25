/** The pull request text for a lab pin bump: the plan, the evidence and the notes (see lab-pin-bumps.mjs). */

// ── Reporting ──────────────────────────────────────────────────────────────

/**
 * A value on one line. A README sentence spans two lines in the file, and a
 * line break inside a table cell would end the row (#1604).
 */
const oneLine = (s) => String(s).replace(/\s+/g, ' ');

/** The planned edits, one line each, for the console and --dry-run. */
export function renderPlan(applied) {
  if (applied.length === 0) return 'No pin to move.\n';
  const lines = [];
  for (const bump of applied) {
    lines.push(`${bump.label}: ${bump.from} -> ${bump.to}`);
    for (const c of bump.changes) lines.push(`  ${c.file}: ${c.where}: ${oneLine(c.from)} -> ${oneLine(c.to)}`);
  }
  return `${lines.join('\n')}\n`;
}

const code = (s) => `\`${oneLine(s).replace(/`/g, "'")}\``;

/** The evidence section of the pull request body. */
export function renderEvidence(applied, { set, date }) {
  if (applied.length === 0) return '';
  const out = [
    `Every value below was read from its publisher on ${date} by \`node scripts/lab-pins-upstream.mjs --bump ${set}\`. A pin moves here only with the checksum or digest beside it; one the publisher did not serve is listed under "Not bumped" instead.`,
    '',
  ];
  for (const bump of applied) {
    out.push(`### ${bump.label}: ${bump.from} → ${bump.to}`, '');
    out.push('| File | Pin | Was | Now |', '| --- | --- | --- | --- |');
    for (const c of bump.changes) out.push(`| ${code(c.file)} | ${code(c.where)} | ${code(c.from)} | ${code(c.to)} |`);
    out.push('', '| Checksum or digest of | Value | Read from |', '| --- | --- | --- |');
    for (const e of bump.evidence) out.push(`| ${e.item} | ${code(e.value)} | ${e.source} |`);
    out.push('');
  }
  return out.join('\n');
}

/**
 * The pins that were not moved, and why. The heading covers every kind of
 * note the planners write (the reason beside each says which), so it must
 * not name one kind as the only one.
 */
export function renderNotes(notes) {
  if (notes.length === 0) return '';
  const out = [
    'Not bumped: nothing was edited for these. The reason is beside each one: its publisher could not be read, a checksum or digest could not be verified, the edit could not be made exactly, or the move is one a person makes (a new release line, or a pin with no automated bump).',
    '',
  ];
  for (const n of notes) out.push(`- **${n.label}** ${n.from ?? '—'} → ${n.to ?? '—'}: ${n.reason}`);
  return `${out.join('\n')}\n`;
}
