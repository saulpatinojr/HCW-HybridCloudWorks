/**
 * The Pages tab (ADR 0033): every allowlisted page grouped by provider, each
 * with its current assignment and a prompt dropdown. Changing the dropdown
 * saves nothing; only Assign / Update writes, and it writes what the
 * dropdown showed.
 */
import React from 'react';
import { Button } from '@/components/ui/button';
import { pageRowState, promptOptions } from './promptSetEditorModel';

function PageRow({ page, groupLabel, row, options, locked, busy, onChoose, onAssign, onUnassign }) {
  return (
    <li className="flex flex-wrap items-center gap-2 px-3 py-1.5 text-xs">
      <span className="min-w-[9rem] font-medium">{page.label}</span>
      <span className="text-muted-foreground">{row.label}</span>
      <div className="ml-auto flex items-center gap-1">
        <select
          value={row.choice}
          onChange={(e) => onChoose(page.path, e.target.value)}
          className="rounded border border-input bg-background px-1.5 py-0.5 text-xs"
          aria-label={`Prompt for ${groupLabel} ${page.label}`}
          disabled={locked}
        >
          {options.map((option) => (
            <option key={option.value || 'none'} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <Button
          type="button"
          size="sm"
          className="h-6 px-2 text-xs"
          disabled={locked}
          onClick={() => onAssign(page.path, row.choice)}
        >
          {row.mine ? 'Update' : 'Assign'}
        </Button>
        {row.mine && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-xs"
            disabled={busy}
            onClick={() => onUnassign(page.path)}
          >
            Unassign
          </Button>
        )}
      </div>
    </li>
  );
}

export default function PagesTab({
  set,
  groups,
  prompts,
  pageAssignments,
  busy,
  state,
  actions,
  onAssignPage,
}) {
  const archived = Boolean(set?.archivedAt);
  const locked = busy || archived;
  const options = promptOptions(prompts);
  const assign = (path, choice) => onAssignPage(path, set.name, choice);
  const unassign = (path) => onAssignPage(path, '', '');
  return (
    <>
      <p className="text-xs text-muted-foreground">
        A page assigned to this set generates its AI covers, previews and curated images from it.
        Choose a prompt and press Assign; changing the dropdown alone saves nothing. A page can have
        one set at a time, so assigning here replaces another set&apos;s assignment.
      </p>
      {archived && (
        <p className="text-xs text-destructive">
          This set is archived; restore it before assigning pages.
        </p>
      )}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 2xl:grid-cols-3">
        {groups.map((group) => (
          <div key={group.provider} className="rounded-lg border border-border">
            <p className="border-b border-border px-3 py-1.5 text-xs font-semibold">
              {group.label}
            </p>
            <ul className="divide-y divide-border/60">
              {group.pages.map((page) => (
                <PageRow
                  key={page.path}
                  page={page}
                  groupLabel={group.label}
                  row={pageRowState({
                    page,
                    setName: set.name,
                    pageAssignments,
                    pageChoice: state.pageChoice,
                  })}
                  options={options}
                  locked={locked}
                  busy={busy}
                  onChoose={actions.choosePage}
                  onAssign={assign}
                  onUnassign={unassign}
                />
              ))}
            </ul>
          </div>
        ))}
      </div>
    </>
  );
}
