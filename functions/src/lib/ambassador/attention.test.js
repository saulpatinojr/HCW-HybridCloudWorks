/**
 * What Ambassador needs from the owner, and by when (#1886, phase 2): the
 * one list the Dashboard and the Telegram reminders both read.
 */
import { MAX_LEAD_DAYS } from "../reminders/settings.js";
import { describe, it, expect } from "vitest";
import {
  DEFAULT_LEAD_DAYS,
  OPEN_APPLICATION_STATUSES,
  ambassadorAttention,
  isDueSoon,
} from "./attention.js";

const TODAY = "2026-11-25";
const EXAMPLE = Object.freeze({
  id: "program-example",
  docType: "program",
  name: "Example Program",
  enabled: true,
  membershipStatus: "active",
  upkeep: { period: "quarter", minCount: 2, evidenceTypes: [], note: "" },
  reminders: { daysBeforeDeadline: 14, daysBeforeRenewal: 45 },
});
const SECOND = Object.freeze({
  id: "program-second",
  docType: "program",
  name: "Second Program",
  enabled: true,
  membershipStatus: "working",
  reminders: { daysBeforeDeadline: 21, daysBeforeRenewal: 30 },
});
const filed = (id, date, programIds = ["program-example"]) => ({
  id,
  docType: "evidence",
  date,
  programIds,
  sourceModule: "content",
});

const byKey = (items) =>
  Object.fromEntries(items.map((item) => [item.key, item]));

describe("upkeep: a held membership whose activity requirement is not yet met", () => {
  it("is due on the period's last day, said from the program's renewal lead time", () => {
    const items = ambassadorAttention({
      programs: [EXAMPLE],
      evidence: [filed("e1", "2026-10-15")],
      today: TODAY,
    });
    expect(items).toEqual([
      expect.objectContaining({
        key: "program-example:upkeep:2026-10-01",
        kind: "upkeep",
        title: "Example Program: Q4 2026 activity requirement not yet met",
        due: "2026-12-31",
        leadDays: 45,
        daysLeft: 36,
        href: "/admin/ambassador?tab=programs&program=program-example",
        detail:
          "1 of 2 recorded for Q4 2026; the period ends 2026-12-31",
      }),
    ]);
    expect(isDueSoon(items[0])).toBe(true);
  });

  it("disappears as soon as the activity requirement is met", () => {
    const items = ambassadorAttention({
      programs: [EXAMPLE],
      evidence: [filed("e1", "2026-10-15"), filed("e2", "2026-11-20")],
      today: TODAY,
    });
    expect(items).toEqual([]);
  });

  it("counts only evidence filed under this program, in this period, not deleted", () => {
    const items = ambassadorAttention({
      programs: [EXAMPLE],
      evidence: [
        filed("general", "2026-10-15", []),
        filed("last-quarter", "2026-09-30"),
        {
          ...filed("gone", "2026-11-01"),
          softDeletedAt: "2026-11-02T00:00:00Z",
        },
      ],
      today: TODAY,
    });
    expect(items[0].detail).toContain("0 of 2");
  });

  it("is not asked of a membership that is not held, a disabled or a deleted program", () => {
    for (const program of [
      { ...EXAMPLE, membershipStatus: "working" },
      { ...EXAMPLE, enabled: false },
      { ...EXAMPLE, softDeletedAt: "2026-11-01T00:00:00Z" },
    ]) {
      expect(
        ambassadorAttention({ programs: [program], today: TODAY }),
      ).toEqual([]);
    }
  });
});

describe("deadlines on applications", () => {
  it("names the program, uses the program's own lead times, and links the application", () => {
    const items = byKey(
      ambassadorAttention({
        programs: [SECOND],
        applications: [
          {
            id: "app-1",
            programId: "program-second",
            title: "Second Program 2026",
            status: "preparing",
            submissionDeadline: "2026-12-10",
          },
        ],
        today: TODAY,
      }),
    );
    expect(items["app-1:submissionDeadline"]).toMatchObject({
      kind: "deadline",
      title: "Submit: Second Program",
      due: "2026-12-10",
      leadDays: 21,
      daysLeft: 15,
      href: "/admin/ambassador?tab=applications&application=app-1",
    });
    expect(isDueSoon(items["app-1:submissionDeadline"])).toBe(true);
  });

  it("falls back to the default lead times when the program states none", () => {
    const items = ambassadorAttention({
      programs: [{ ...SECOND, reminders: undefined }],
      applications: [
        {
          id: "a",
          programId: "program-second",
          status: "active",
          renewalDate: "2027-01-31",
        },
        {
          id: "b",
          programId: "program-second",
          status: "ready",
          submissionDeadline: "2027-01-31",
        },
      ],
      today: TODAY,
    });
    expect(byKey(items)["a:renewalDate"].leadDays).toBe(
      DEFAULT_LEAD_DAYS.renewal,
    );
    expect(byKey(items)["b:submissionDeadline"].leadDays).toBe(
      DEFAULT_LEAD_DAYS.deadline,
    );
  });

  it("holds a lead time to the reminders sheet's limit, so the Dashboard and Telegram agree", () => {
    const far = {
      ...SECOND,
      reminders: { daysBeforeDeadline: 500, daysBeforeRenewal: 400 },
    };
    const items = ambassadorAttention({
      programs: [far],
      applications: [
        {
          id: "b",
          programId: far.id,
          status: "ready",
          submissionDeadline: "2027-01-31",
        },
      ],
      today: TODAY,
    });
    expect(byKey(items)["b:submissionDeadline"].leadDays).toBe(MAX_LEAD_DAYS);
  });

  it("skips a deleted application, a date that no longer matters for its status, and a non-date", () => {
    const items = ambassadorAttention({
      programs: [SECOND],
      applications: [
        {
          id: "gone",
          programId: "program-second",
          status: "preparing",
          submissionDeadline: "2026-12-01",
          softDeletedAt: "2026-11-01T00:00:00Z",
        },
        {
          id: "sent",
          programId: "program-second",
          status: "submitted",
          submissionDeadline: "2026-12-01",
        },
        {
          id: "blank",
          programId: "program-second",
          status: "preparing",
          submissionDeadline: null,
        },
      ],
      today: TODAY,
    });
    expect(items).toEqual([]);
  });

  it("is not due soon outside its lead time, and is overdue past its day", () => {
    const [later, past] = ambassadorAttention({
      programs: [SECOND],
      applications: [
        {
          id: "later",
          programId: "program-second",
          status: "ready",
          submissionDeadline: "2027-03-01",
        },
        {
          id: "past",
          programId: "program-second",
          status: "ready",
          submissionDeadline: "2026-11-20",
        },
      ],
      today: TODAY,
    });
    expect(isDueSoon(later)).toBe(false);
    expect(past.daysLeft).toBe(-5);
    expect(isDueSoon(past)).toBe(true);
  });

  it("lists every status in which some date still matters", () => {
    expect([...OPEN_APPLICATION_STATUSES].sort()).toEqual(
      [
        "accepted",
        "active",
        "interested",
        "preparing",
        "ready",
        "renewal_due",
      ].sort(),
    );
  });
});
