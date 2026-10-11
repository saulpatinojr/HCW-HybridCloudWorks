/**
 * Settings (ADR 0033 §4; last on purpose): the program catalogue — add, edit,
 * disable and re-enable, reorder — each program's requirements and evidence
 * types, the reminder lead times (stored here; the Calendar slice reads the
 * deadlines), and custom fields an application can carry. Writes need the
 * super_admin role; the API refuses others and the toast says so.
 */
import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ArrowDown, ArrowUp, Loader2, Pencil, Plus, Trash2 } from 'lucide-react';
import ConfirmModal from '@/components/admin/ConfirmModal';
import StatusBadge from '@/components/admin/shared/StatusBadge';
import {
  AMBASSADOR_STATUS,
  APPLICATION_STATUSES,
  EMPTY_REQUIREMENT,
  EVIDENCE_SOURCES,
  MEMBERSHIP_STATUS,
  MEMBERSHIP_STATUSES,
  PROGRAM_STATE,
  latestApplicationFor,
  programById,
  programForm,
  programGate,
  programPayload,
  sourceLabel,
} from './ambassadorModel';
import DataTable from './DataTable';
import {
  Field,
  ReadsStatus,
  SelectField,
  SourcePicker,
  TextAreaField,
  TextField,
  allLanded,
} from './Parts';

function RequirementsEditor({ rows, onChange }) {
  const update = (index, patch) =>
    onChange(rows.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  return (
    <fieldset className="space-y-3 rounded-md border border-border p-3">
      <legend className="px-1 text-xs font-medium">Requirements</legend>
      <p className="text-[11px] text-muted-foreground">
        Each is met when the count of relevant evidence of its types reaches the minimum; weight is
        its share of the readiness score.
      </p>
      {rows.length === 0 && <p className="text-xs text-muted-foreground">No requirements yet.</p>}
      {rows.map((req, index) => (
        <div key={index} className="space-y-2 rounded-md border border-border/60 p-3">
          <div className="grid gap-2 md:grid-cols-[2fr_1fr_1fr_auto] md:items-end">
            <TextField
              id={`req-${index}-label`}
              label="Label *"
              value={req.label}
              onChange={(v) => update(index, { label: v })}
            />
            <TextField
              id={`req-${index}-min`}
              label="Minimum count"
              type="number"
              min="0"
              value={req.minCount}
              onChange={(v) => update(index, { minCount: v })}
            />
            <TextField
              id={`req-${index}-weight`}
              label="Weight"
              type="number"
              min="0"
              value={req.weight}
              onChange={(v) => update(index, { weight: v })}
            />
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="text-destructive"
              aria-label={`Remove requirement ${index + 1}`}
              onClick={() => onChange(rows.filter((_, i) => i !== index))}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
          <TextField
            id={`req-${index}-description`}
            label="Description"
            value={req.description}
            onChange={(v) => update(index, { description: v })}
          />
          <Field id={`req-${index}-types`} label="Evidence types">
            <SourcePicker
              idPrefix={`req-${index}-type`}
              value={req.evidenceTypes}
              onChange={(v) => update(index, { evidenceTypes: v })}
              sources={EVIDENCE_SOURCES}
            />
          </Field>
        </div>
      ))}
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => onChange([...rows, { ...EMPTY_REQUIREMENT }])}
      >
        <Plus className="mr-1 h-3.5 w-3.5" /> Add requirement
      </Button>
    </fieldset>
  );
}

function CustomFieldsEditor({ rows, onChange }) {
  const update = (index, patch) =>
    onChange(rows.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  return (
    <fieldset className="space-y-2 rounded-md border border-border p-3">
      <legend className="px-1 text-xs font-medium">Custom fields</legend>
      <p className="text-[11px] text-muted-foreground">
        Extra values an application for this program records (an id, a label and a type).
      </p>
      {rows.map((f, index) => (
        <div key={index} className="grid gap-2 md:grid-cols-[1fr_2fr_1fr_auto] md:items-end">
          <TextField
            id={`cf-${index}-id`}
            label="Id"
            value={f.id}
            onChange={(v) => update(index, { id: v.replace(/[^a-z0-9_-]/gi, '').toLowerCase() })}
          />
          <TextField
            id={`cf-${index}-label`}
            label="Label"
            value={f.label}
            onChange={(v) => update(index, { label: v })}
          />
          <SelectField
            id={`cf-${index}-type`}
            label="Type"
            value={f.type || 'text'}
            onChange={(v) => update(index, { type: v })}
            options={[
              { value: 'text', label: 'Text' },
              { value: 'date', label: 'Date' },
              { value: 'url', label: 'URL' },
              { value: 'number', label: 'Number' },
            ]}
          />
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="text-destructive"
            aria-label={`Remove custom field ${index + 1}`}
            onClick={() => onChange(rows.filter((_, i) => i !== index))}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() => onChange([...rows, { id: '', label: '', type: 'text' }])}
      >
        <Plus className="mr-1 h-3.5 w-3.5" /> Add field
      </Button>
    </fieldset>
  );
}

/**
 * The add/edit dialog for one program: every catalogue field, the membership,
 * the upkeep rule and the contribution tracker. Saves through `onSave` and
 * closes when it answers true.
 */
export function ProgramEditor({ program, programs = [], onClose, onSave, saving }) {
  const [form, setForm] = useState(() => programForm(program));
  // A parent is a top-level program other than this one: one level only,
  // as the API enforces.
  const parentOptions = [
    { value: '', label: '— none —' },
    ...programs
      .filter((p) => !p.parentProgramId && p.id !== program?.id)
      .map((p) => ({ value: p.id, label: p.name })),
  ];
  const [error, setError] = useState('');
  const set = (key) => (value) => setForm((f) => ({ ...f, [key]: value }));
  const setWindow = (key) => (value) =>
    setForm((f) => ({ ...f, applicationWindow: { ...f.applicationWindow, [key]: value } }));
  const setReminder = (key) => (value) =>
    setForm((f) => ({ ...f, reminders: { ...f.reminders, [key]: value } }));
  const setUpkeep = (key) => (value) =>
    setForm((f) => ({ ...f, upkeep: { ...f.upkeep, [key]: value } }));

  const submit = async (event) => {
    event.preventDefault();
    const checked = programPayload(form);
    if (checked.error) {
      setError(checked.error);
      return;
    }
    setError('');
    if (await onSave(checked.value)) onClose();
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <form className="space-y-4" noValidate onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>{program ? `Edit ${program.name}` : 'Add a program'}</DialogTitle>
            <DialogDescription>
              Match the requirements to the program&apos;s current published rules; the seeded ones
              are starting points.
            </DialogDescription>
          </DialogHeader>
          {error && (
            <p
              role="alert"
              className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              {error}
            </p>
          )}
          <div className="grid gap-3 md:grid-cols-2">
            <TextField id="program-name" label="Name *" value={form.name} onChange={set('name')} />
            <TextField
              id="program-provider"
              label="Provider"
              value={form.provider}
              onChange={set('provider')}
            />
            <TextField
              id="program-category"
              label="Category"
              value={form.category}
              onChange={set('category')}
              hint="community-expert, training, partner…"
            />
            <TextField
              id="program-url"
              label="Application URL"
              type="url"
              placeholder="https://..."
              value={form.applicationUrl}
              onChange={set('applicationUrl')}
            />
            <TextAreaField
              id="program-description"
              label="Description"
              value={form.description}
              onChange={set('description')}
              className="md:col-span-2"
            />
            <TextAreaField
              id="program-eligibility"
              label="Eligibility (one per line)"
              value={form.eligibility}
              onChange={set('eligibility')}
            />
            <TextAreaField
              id="program-criteria"
              label="Criteria (one per line)"
              value={form.criteria}
              onChange={set('criteria')}
            />
            <TextAreaField
              id="program-activities"
              label="Recommended activities (one per line)"
              value={form.recommendedActivities}
              onChange={set('recommendedActivities')}
              className="md:col-span-2"
            />
            <TextField
              id="program-window-opens"
              label="Window opens"
              type="date"
              value={form.applicationWindow.opens}
              onChange={setWindow('opens')}
            />
            <TextField
              id="program-window-closes"
              label="Window closes"
              type="date"
              value={form.applicationWindow.closes}
              onChange={setWindow('closes')}
            />
            <TextField
              id="program-window-note"
              label="Window note"
              value={form.applicationWindow.note}
              onChange={setWindow('note')}
              className="md:col-span-2"
              hint="Leave the dates empty for a rolling program."
            />
            <SelectField
              id="program-membership"
              label="Membership status"
              hint="Where you stand with the program; separate from an application's state."
              value={form.membershipStatus}
              onChange={set('membershipStatus')}
              options={MEMBERSHIP_STATUSES.map((s) => ({
                value: s,
                label: MEMBERSHIP_STATUS[s].label,
              }))}
            />
            <SelectField
              id="program-parent"
              label="Additional to"
              hint="Its card, questions and application open only while that program's membership is Active; that program's evidence counts here too."
              value={form.parentProgramId}
              onChange={set('parentProgramId')}
              options={parentOptions}
            />
            <TextField
              id="program-renewal"
              label="Renewal cadence"
              value={form.renewalCadence}
              onChange={set('renewalCadence')}
              hint="annual, ongoing…"
            />
            <TextField
              id="program-expiry"
              label="Expiration rule"
              value={form.expirationRule}
              onChange={set('expirationRule')}
            />
            <TextField
              id="program-tracker"
              label="Contribution tracker URL"
              type="url"
              placeholder="https://..."
              value={form.contributionTrackerUrl}
              onChange={set('contributionTrackerUrl')}
              className="md:col-span-2"
              hint="Where the program wants each contribution logged. Kept with this program only; the seeded catalogue never carries one."
            />
            <SelectField
              id="program-upkeep-period"
              label="Keeps the membership active"
              hint="A minimum of evidence filed under this program in every calendar quarter or year, once the membership is held."
              value={form.upkeep.period}
              onChange={setUpkeep('period')}
              options={[
                { value: '', label: '— no rule —' },
                { value: 'quarter', label: 'Every quarter' },
                { value: 'year', label: 'Every year' },
              ]}
            />
            <TextField
              id="program-upkeep-min"
              label="Minimum each period"
              type="number"
              min="1"
              value={form.upkeep.minCount}
              onChange={setUpkeep('minCount')}
            />
            <TextAreaField
              id="program-upkeep-note"
              label="What the program asks, to stay active"
              value={form.upkeep.note}
              onChange={setUpkeep('note')}
              className="md:col-span-2"
            />
            <TextField
              id="program-reminder-deadline"
              label="Remind before a deadline (days)"
              type="number"
              min="0"
              value={form.reminders.daysBeforeDeadline}
              onChange={setReminder('daysBeforeDeadline')}
            />
            <TextField
              id="program-reminder-renewal"
              label="Remind before a renewal (days)"
              type="number"
              min="0"
              value={form.reminders.daysBeforeRenewal}
              onChange={setReminder('daysBeforeRenewal')}
              hint="Stored here; the Calendar reads the dates."
            />
            <Field
              id="program-evidence-types"
              label="Evidence types this program values"
              className="md:col-span-2"
            >
              <SourcePicker
                idPrefix="program-type"
                value={form.evidenceTypes}
                onChange={set('evidenceTypes')}
                sources={EVIDENCE_SOURCES}
              />
            </Field>
            <div className="md:col-span-2">
              <RequirementsEditor rows={form.requirements} onChange={set('requirements')} />
            </div>
            <div className="md:col-span-2">
              <CustomFieldsEditor rows={form.customFields} onChange={set('customFields')} />
            </div>
          </div>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {program ? 'Save program' : 'Add program'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const COLUMNS = [
  'Order',
  'Program',
  'Requirements',
  'Reminders',
  'State',
  'Membership',
  'Application state',
  '',
];

const NO_APPLICATION = '';

const ROW_SELECT = 'h-8 rounded-md border border-input bg-background px-2 text-xs';

/** The row's Membership select: where the owner stands with the program. */
function MembershipSelect({ program, busy, onChange }) {
  return (
    <select
      className={ROW_SELECT}
      aria-label={`Membership status for ${program.name}`}
      value={
        MEMBERSHIP_STATUSES.includes(program.membershipStatus) ? program.membershipStatus : 'none'
      }
      disabled={busy}
      onChange={(e) => onChange(e.target.value)}
    >
      {MEMBERSHIP_STATUSES.map((s) => (
        <option key={s} value={s}>
          {MEMBERSHIP_STATUS[s].label}
        </option>
      ))}
    </select>
  );
}

/**
 * The row's Application state select. A program additional to another is
 * disabled until that membership is Active, and the tooltip says so — the
 * API would answer 409 PARENT_NOT_ACTIVE to the same request.
 */
function ApplicationStateSelect({ program, gate, busy, value, onChange }) {
  return (
    <select
      className={ROW_SELECT}
      aria-label={`Application state for ${program.name}`}
      title={
        gate.unlocked
          ? undefined
          : `Opens when the ${gate.parent.name || 'parent'} membership is Active`
      }
      value={value}
      disabled={busy || !gate.unlocked}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value={NO_APPLICATION}>— no application —</option>
      {APPLICATION_STATUSES.map((s) => (
        <option key={s} value={s}>
          {AMBASSADOR_STATUS[s].label}
        </option>
      ))}
    </select>
  );
}

export default function SettingsTab({ hub }) {
  const { programs, applications } = hub;
  const [editing, setEditing] = useState(null); // null | {} (new) | program
  const [confirmDelete, setConfirmDelete] = useState(null);
  const ordered = [...programs.data].sort((a, b) => (a.order ?? 999) - (b.order ?? 999));
  const byId = programById(programs.data);

  // The Application state select (owner request 2026-10-05): sets the
  // program's latest application to ANY status, outside the funnel, recorded
  // as an override in its history (super_admin); with no application yet it
  // starts one at that status.
  const setApplicationState = async (program, status) => {
    if (!status) return;
    const latest = latestApplicationFor(applications?.data, program.id);
    if (latest) {
      await hub.writes.patchApplication(latest.id, {
        status,
        statusNote: 'Set from Settings',
        statusOverride: true,
      });
    } else {
      await hub.writes.createApplication({ programId: program.id, status });
    }
  };

  const save = async (payload) => {
    const saved = editing?.id
      ? await hub.writes.patchProgram(editing.id, payload)
      : await hub.writes.createProgram(payload);
    return Boolean(saved);
  };

  const move = async (index, direction) => {
    const other = index + direction;
    if (other < 0 || other >= ordered.length) return;
    const a = ordered[index];
    const b = ordered[other];
    await hub.writes.patchProgram(a.id, { order: other + 1 });
    await hub.writes.patchProgram(b.id, { order: index + 1 });
  };

  return (
    <div className="space-y-4 pt-4">
      <p className="text-sm text-muted-foreground">
        The catalogue, its requirements and evidence types, reminder lead times and custom fields.
        Disabling a program hides it from new applications and keeps its history; nothing here
        deletes an application. Membership is where you stand with the program; Application state
        sets the latest application directly, outside the funnel, and the record says it was set
        here.
      </p>
      <ReadsStatus reads={[programs, applications]} label="programs and applications" />
      {allLanded([programs, applications]) && (
        <>
          <div className="flex justify-end">
            <Button size="sm" onClick={() => setEditing({})}>
              <Plus className="mr-1 h-3.5 w-3.5" /> Add program
            </Button>
          </div>
          <DataTable columns={COLUMNS}>
            {ordered.map((program, index) => {
              const busy = hub.busyIds.has(program.id);
              const disabled = program.enabled === false;
              const gate = programGate(program, byId);
              return (
                <tr key={program.id} className={disabled ? 'opacity-60' : ''}>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 w-7 p-0"
                        aria-label={`Move ${program.name} up`}
                        disabled={busy || index === 0}
                        onClick={() => move(index, -1)}
                      >
                        <ArrowUp className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 w-7 p-0"
                        aria-label={`Move ${program.name} down`}
                        disabled={busy || index === ordered.length - 1}
                        onClick={() => move(index, 1)}
                      >
                        <ArrowDown className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="font-medium">{program.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {program.provider}
                      {gate.gated &&
                        ` · additional to ${gate.parent.name || gate.parent.id}${
                          gate.unlocked ? '' : ' (opens when Active)'
                        }`}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-xs">
                    {(program.requirements || []).length} ·{' '}
                    {(program.requirements || [])
                      .flatMap((r) => r.evidenceTypes)
                      .filter((v, i, a) => a.indexOf(v) === i)
                      .map(sourceLabel)
                      .join(', ') || '—'}
                  </td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">
                    {program.reminders?.daysBeforeDeadline ?? 14}d before a deadline ·{' '}
                    {program.reminders?.daysBeforeRenewal ?? 30}d before a renewal
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge
                      size="xs"
                      status={PROGRAM_STATE[disabled ? 'disabled' : 'enabled']}
                    />
                  </td>
                  <td className="px-4 py-3">
                    <MembershipSelect
                      program={program}
                      busy={busy}
                      onChange={(value) =>
                        hub.writes.patchProgram(program.id, { membershipStatus: value })
                      }
                    />
                  </td>
                  <td className="px-4 py-3">
                    <ApplicationStateSelect
                      program={program}
                      gate={gate}
                      busy={busy}
                      value={
                        latestApplicationFor(applications?.data, program.id)?.status ||
                        NO_APPLICATION
                      }
                      onChange={(value) => setApplicationState(program, value)}
                    />
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex justify-end gap-1">
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 px-2"
                        onClick={() => setEditing(program)}
                      >
                        <Pencil className="mr-1 h-3 w-3" /> Edit
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 px-2"
                        disabled={busy}
                        onClick={() => hub.writes.patchProgram(program.id, { enabled: disabled })}
                      >
                        {disabled ? 'Re-enable' : 'Disable'}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 px-2 text-destructive"
                        disabled={busy}
                        onClick={() => setConfirmDelete(program)}
                      >
                        <Trash2 className="h-3 w-3" />
                        <span className="sr-only">Delete {program.name}</span>
                      </Button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </DataTable>
        </>
      )}
      {editing && (
        <ProgramEditor
          program={editing.id ? editing : null}
          programs={programs.data}
          onClose={() => setEditing(null)}
          onSave={save}
          saving={editing.id ? hub.busyIds.has(editing.id) : hub.busyIds.has('program:new')}
        />
      )}
      <ConfirmModal
        open={Boolean(confirmDelete)}
        title="Delete this program?"
        description={`${confirmDelete?.name || ''} is kept with a deletion stamp and leaves the catalogue; applications that name it keep their records. Prefer Disable unless it was added by mistake. Deleting needs the publisher role.`}
        confirmLabel="Delete"
        onCancel={() => setConfirmDelete(null)}
        onConfirm={async () => {
          const program = confirmDelete;
          setConfirmDelete(null);
          if (program) await hub.writes.deleteProgram(program.id);
        }}
      />
    </div>
  );
}
