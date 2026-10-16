/**
 * The Set tab (ADR 0033): the shared creative brief rendered from
 * `SET_FIELD_ROWS`, the name field for a new set, Save / Create, and the
 * primary-prompt version history with "restore this text".
 */
import React from 'react';
import { History, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { SET_FIELD_ROWS, inputClass } from './promptSetEditorModel';

const CONTROLS = {
  input: ({ field, value, onChange }) => (
    <Input
      id={field.id}
      value={value}
      onChange={onChange}
      placeholder={field.placeholder}
      maxLength={field.maxLength}
      className={field.className}
    />
  ),
  textarea: ({ field, value, onChange }) => (
    <Textarea
      id={field.id}
      value={value}
      onChange={onChange}
      rows={field.rows}
      placeholder={field.placeholder}
    />
  ),
  select: ({ field, value, onChange }) => (
    <select id={field.id} value={value} onChange={onChange} className={inputClass}>
      {field.options.map((option) => (
        <option key={option.value || 'default'} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  ),
};

function SetField({ field, value, onChange }) {
  const Control = CONTROLS[field.kind];
  return (
    <div>
      <label htmlFor={field.id} className="text-xs font-medium">
        {field.label}
        {field.required && (
          <>
            {' '}
            <span className="text-destructive">*</span>
          </>
        )}
      </label>
      <Control field={field} value={value} onChange={(e) => onChange(field.key, e.target.value)} />
      {field.help && <p className="mt-1 text-xs text-muted-foreground">{field.help}</p>}
    </div>
  );
}

function FieldRow({ row, fields, onChange }) {
  const cells = row.map((field) => (
    <SetField key={field.key} field={field} value={fields[field.key]} onChange={onChange} />
  ));
  if (row.length === 1) return cells;
  return <div className="grid grid-cols-1 gap-3 md:grid-cols-2">{cells}</div>;
}

function NewSetName({ value, onChange }) {
  return (
    <div>
      <label htmlFor="new-set-name" className="text-xs font-medium">
        Set name <span className="text-destructive">*</span>
      </label>
      <Input
        id="new-set-name"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="e.g. Azure Chibi, Enterprise Hero"
        maxLength={120}
      />
    </div>
  );
}

function HistoryToggle({ history, showHistory, onToggle }) {
  if (history.length === 0) return null;
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="gap-1"
      onClick={onToggle}
      aria-expanded={showHistory}
    >
      <History className="h-3.5 w-3.5" aria-hidden="true" /> {showHistory ? 'Hide' : 'Show'} history
      ({history.length})
    </Button>
  );
}

function HistoryList({ history, onRestore }) {
  return (
    <ol className="space-y-2 rounded-lg border border-border p-3 text-xs">
      {history.map((entry) => (
        <li key={`${entry.version}-${entry.savedAt}`} className="space-y-1">
          <p className="font-medium">
            v{entry.version}
            {entry.savedAt ? ` · ${new Date(entry.savedAt).toLocaleString()}` : ''}
            {entry.savedBy ? ` · ${entry.savedBy}` : ''}
          </p>
          <pre className="whitespace-pre-wrap rounded bg-muted/40 p-2 text-xs">
            {entry.primaryPrompt}
          </pre>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-6 text-xs"
            onClick={() => onRestore(entry.primaryPrompt)}
          >
            Restore this text into the editor
          </Button>
        </li>
      ))}
    </ol>
  );
}

export default function SetTab({ set, isNew, busy, state, canSaveSet, actions }) {
  const history = isNew ? [] : set.history || [];
  return (
    <>
      {isNew && <NewSetName value={state.newName} onChange={actions.setNewName} />}
      {SET_FIELD_ROWS.map((row) => (
        <FieldRow key={row[0].key} row={row} fields={state.fields} onChange={actions.setField} />
      ))}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" onClick={actions.saveSet} disabled={busy || !canSaveSet}>
          {busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" aria-hidden="true" /> : null}
          {isNew ? 'Create set' : 'Save set'}
        </Button>
        <HistoryToggle
          history={history}
          showHistory={state.showHistory}
          onToggle={actions.toggleHistory}
        />
      </div>
      {state.showHistory && !isNew && (
        <HistoryList
          history={history}
          onRestore={(text) => actions.setField('primaryPrompt', text)}
        />
      )}
    </>
  );
}
