/**
 * attention.js — what Ambassador needs from the owner, and by when (#1886,
 * phase 2). One list, read by the Dashboard's waiting list
 * (decision-center/sources.js) and by the Telegram reminders
 * (ambassador/reminder-rows.js), so the two can never disagree.
 *
 * Two kinds of item:
 *
 *   deadline  an application's submission deadline, renewal date or expiry,
 *             while the application is in a status where the date still
 *             matters. Said from the program's own lead time:
 *             `reminders.daysBeforeDeadline` for a submission,
 *             `reminders.daysBeforeRenewal` for a renewal or expiry
 *             (Settings tab; defaults 14 and 30).
 *   upkeep    a held membership whose upkeep rule is not met yet for the
 *             current period (for example, two published pieces a quarter). Due on the
 *             period's last day, said from `daysBeforeRenewal`, because
 *             keeping a membership is its renewal. It disappears as soon as
 *             the requirement is met.
 *
 * Pure: the caller reads the records. Deleted records are skipped here, so a
 * caller cannot forget to.
 */
import { upkeepProgress, daysUntil } from "./upkeep.js";
import {
  ambassadorHref,
  ambassadorProgramHref,
} from "../decision-center/links.js";

/** The lead times a program gets when its Settings name none (model defaults). */
export const DEFAULT_LEAD_DAYS = Object.freeze({ deadline: 14, renewal: 30 });

/** Each application date, the statuses it still matters in, its verb, and which lead time it uses. */
export const APPLICATION_DATES = Object.freeze([
  {
    field: "submissionDeadline",
    verb: "Submit",
    lead: "deadline",
    statuses: ["interested", "preparing", "ready"],
  },
  {
    field: "renewalDate",
    verb: "Renew",
    lead: "renewal",
    statuses: ["accepted", "active", "renewal_due"],
  },
  {
    field: "expirationDate",
    verb: "Expires",
    lead: "renewal",
    statuses: ["accepted", "active", "renewal_due"],
  },
]);

/** Every status in which some application date still matters. */
export const OPEN_APPLICATION_STATUSES = Object.freeze([
  ...new Set(APPLICATION_DATES.flatMap((date) => date.statuses)),
]);

const isLive = (record) => record && !record.softDeletedAt;

const leadDays = (program, kind) => {
  const stored =
    kind === "deadline"
      ? program?.reminders?.daysBeforeDeadline
      : program?.reminders?.daysBeforeRenewal;
  return Number.isInteger(stored) && stored >= 0
    ? stored
    : DEFAULT_LEAD_DAYS[kind];
};

/**
 * @param {{ programs: object[], applications: object[], evidence: object[], today: string }} input
 *        `today` as YYYY-MM-DD (UTC)
 * @returns {Array<{
 *   key: string, kind: 'deadline'|'upkeep', programId: string, recordId: string,
 *   title: string, due: string, leadDays: number, daysLeft: number,
 *   href: string, detail: string, status?: string, field?: string,
 * }>} every item, whether or not it is inside its lead time yet
 */
export function ambassadorAttention({
  programs = [],
  applications = [],
  evidence = [],
  today,
}) {
  const byId = new Map(
    programs.filter(isLive).map((program) => [program.id, program]),
  );
  const items = [];

  for (const application of applications) {
    if (!isLive(application)) continue;
    const program = byId.get(application.programId) || null;
    const name =
      program?.name ||
      application.title ||
      application.programId ||
      "Ambassador application";
    for (const date of APPLICATION_DATES) {
      const value = application[date.field];
      if (
        !date.statuses.includes(application.status) ||
        typeof value !== "string"
      )
        continue;
      const due = value.slice(0, 10);
      items.push({
        key: `${application.id}:${date.field}`,
        kind: "deadline",
        programId: application.programId,
        recordId: application.id,
        title: `${date.verb}: ${name}`,
        due,
        leadDays: leadDays(program, date.lead),
        daysLeft: daysUntil(due, today),
        href: ambassadorHref(application.id),
        detail: "",
        status: application.status,
        field: date.field,
      });
    }
  }

  for (const program of byId.values()) {
    if (program.enabled === false || program.membershipStatus !== "active")
      continue;
    const progress = upkeepProgress(program, evidence, today);
    if (!progress || progress.current.met) continue;
    const { current, minCount } = progress;
    items.push({
      key: `${program.id}:upkeep:${current.start}`,
      kind: "upkeep",
      programId: program.id,
      recordId: program.id,
      title: `${program.name}: ${current.label} activity (${current.count} of ${minCount} recorded)`,
      due: current.end,
      leadDays: leadDays(program, "renewal"),
      daysLeft: current.daysLeft,
      href: ambassadorProgramHref(program.id),
      detail: `Activity requirement not yet met for ${current.label}; the period ends ${current.end}`,
    });
  }
  return items;
}

/** Whether an item is inside its lead time (or past due) on `today`. */
export const isDueSoon = (item) =>
  item.daysLeft !== null && item.daysLeft <= item.leadDays;
