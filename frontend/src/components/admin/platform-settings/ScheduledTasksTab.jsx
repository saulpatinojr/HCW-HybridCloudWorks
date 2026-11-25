/**
 * Scheduled tasks: every job in the estate that runs on a clock, in one
 * place (owner request 2026-11-25; the rule "anything that recurs runs on a
 * schedule" in .claude/CLAUDE.md is why there are so many).
 *
 * Grouped by where each one runs (GitHub Actions, the Function App, the lab
 * host, the owner's Claude account), because that is where a reader goes to
 * change or rerun it. Within a group the most frequent come first, then the
 * rest in the order the week meets them (Monday first), so the always-on
 * monitors sit together at the top and the weekly jobs read as a timetable.
 *
 * Reads nothing from the server: the rows are scheduledTasks.js, which
 * scripts/scheduled-tasks-list.test.mjs holds to the real schedules.
 */

import React from 'react';
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '@/components/ui/card';
import { ArrowUpRight, CalendarClock } from 'lucide-react';
import { SCHEDULE_GROUPS, SCHEDULED_TASKS } from './scheduledTasks';
import { describeSchedule } from '@/lib/scheduleWords';
import { compareSchedules, formatRunTime, nextRun } from '@/lib/scheduleTimes';

/** The rows of each group, sorted once: most frequent first, then the earlier in the week. */
const ROWS_BY_GROUP = Object.freeze(
  Object.fromEntries(
    SCHEDULE_GROUPS.map((group) => [
      group.id,
      SCHEDULED_TASKS.filter((task) => task.group === group.id).sort(
        (a, b) => compareSchedules(a.schedules, b.schedules) || a.name.localeCompare(b.name)
      ),
    ])
  )
);

/** The soonest next run of a task, or null when its clock is not UTC or it counts from its last run. */
function soonest(task, clock, now) {
  if (clock !== 'UTC') return null;
  const runs = task.schedules.map((schedule) => nextRun(schedule, now)).filter(Boolean);
  return runs.length ? new Date(Math.min(...runs.map((run) => run.getTime()))) : null;
}

function ScheduleCell({ task, clock, now }) {
  const next = soonest(task, clock, now);
  return (
    <td className="py-2 pr-4 text-xs">
      {task.schedules.map((schedule) => (
        <div key={schedule} className="mb-1 last:mb-0">
          <div className="font-medium text-foreground">{describeSchedule(schedule, { clock })}</div>
          <code className="font-mono text-[11px] text-muted-foreground">{schedule}</code>
        </div>
      ))}
      {next ? <div className="mt-1 text-muted-foreground">Next: {formatRunTime(next)}</div> : null}
    </td>
  );
}

function GroupTable({ group, now }) {
  const rows = ROWS_BY_GROUP[group.id];
  const headingId = `scheduled-tasks-${group.id}`;
  return (
    <section aria-labelledby={headingId} className="space-y-2">
      <h4 id={headingId} className="text-sm font-semibold">
        {group.label}{' '}
        <span className="font-normal text-muted-foreground">
          ({rows.length} {rows.length === 1 ? 'task' : 'tasks'})
        </span>
      </h4>
      <p className="text-xs text-muted-foreground">{group.explain}</p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[42rem] text-left text-sm">
          <caption className="sr-only">Scheduled tasks that run in {group.label}</caption>
          <thead className="border-b border-border text-xs uppercase text-muted-foreground">
            <tr>
              <th scope="col" className="w-[24%] py-2 pr-4 font-medium">
                Task
              </th>
              <th scope="col" className="w-[24%] py-2 pr-4 font-medium">
                Schedule
              </th>
              <th scope="col" className="py-2 pr-4 font-medium">
                What it does
              </th>
              <th scope="col" className="py-2 font-medium">
                <span className="sr-only">Open</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((task) => (
              <tr key={task.id} className="border-b border-border/60 align-top last:border-0">
                <td className="py-2 pr-4">
                  <div className="font-medium">{task.name}</div>
                  <code className="break-all font-mono text-[11px] text-muted-foreground">
                    {task.code}
                  </code>
                </td>
                <ScheduleCell task={task} clock={group.clock} now={now} />
                <td className="py-2 pr-4 text-xs">
                  <div>{task.does}</div>
                  {task.leaves ? (
                    <div className="mt-1 text-muted-foreground">Leaves behind: {task.leaves}</div>
                  ) : null}
                </td>
                <td className="whitespace-nowrap py-2">
                  <a
                    href={task.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-xs font-medium text-primary underline-offset-2 hover:underline"
                    aria-label={`Open ${task.name} (opens in a new tab)`}
                  >
                    Open <ArrowUpRight className="h-3 w-3" aria-hidden="true" />
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/**
 * @param {object} props
 * @param {Date} [props.now] the time "Next" is counted from; the tests pass one
 */
export default function ScheduledTasksTab({ now = new Date() }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <CalendarClock className="h-5 w-5" aria-hidden="true" /> Scheduled tasks
        </CardTitle>
        <CardDescription>
          Every job in the estate that runs on a clock: {SCHEDULED_TASKS.length} tasks in{' '}
          {SCHEDULE_GROUPS.length} places. Each row says when it runs, what it does, what it leaves
          behind for someone to finish, and links to where it lives. Nothing is changed on this tab.
          Times are UTC unless the row says otherwise.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-8 pt-0">
        {SCHEDULE_GROUPS.map((group) => (
          <GroupTable key={group.id} group={group} now={now} />
        ))}
      </CardContent>
    </Card>
  );
}
