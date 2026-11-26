/**
 * Ambassador's rows on the reminders sheet (#1886): what they say, when they
 * go, and that a sync keeps the timer's stamps and the owner's own rows.
 */
import { describe, it, expect, vi } from "vitest";
import {
  MAX_AMBASSADOR_ROWS,
  OVERDUE_DROP_DAYS,
  ambassadorRowId,
  syncAmbassadorReminders,
  wantedAmbassadorRows,
} from "./reminder-rows.js";
import { syncReminderProviders } from "../reminders/providers.js";

const NOW = new Date("2026-11-25T13:00:00.000Z");
const EXAMPLE = {
  id: "program-example",
  docType: "program",
  name: "Example Program",
  enabled: true,
  membershipStatus: "active",
  upkeep: { period: "quarter", minCount: 2, evidenceTypes: [], note: "" },
  reminders: { daysBeforeDeadline: 14, daysBeforeRenewal: 45 },
};

const item = (over = {}) => ({
  key: "app-1:submissionDeadline",
  kind: "deadline",
  title: "Submit: Second Program",
  due: "2026-12-10",
  leadDays: 21,
  daysLeft: 15,
  href: "/admin/ambassador?tab=applications&application=app-1",
  detail: "",
  ...over,
});

/** An ambassador container and a reminders document with the real client's conditional write. */
function storeWith({ ambassador = [], reminders = null } = {}) {
  let doc = reminders ? { id: "reminders", _etag: '"1"', reminders } : null;
  let etag = 1;
  return {
    get doc() {
      return doc;
    },
    readDoc: vi.fn(async () => (doc ? structuredClone(doc) : null)),
    queryDocs: vi.fn(async (container, query) => {
      if (container !== "ambassador")
        throw new Error(`unexpected ${container}`);
      const kind = /docType = '(\w+)'/.exec(query)[1];
      return ambassador.filter((row) => row.docType === kind);
    }),
    replaceDocIfMatch: vi.fn(async (container, next) => {
      if (next._etag !== doc._etag)
        throw Object.assign(new Error("changed"), { code: 412 });
      doc = { ...next, _etag: `"${++etag}"` };
    }),
    createDoc: vi.fn(async (container, next) => {
      doc = { ...next, _etag: `"${++etag}"` };
    }),
  };
}

describe("wantedAmbassadorRows", () => {
  it("makes a row that links the record, said from the program's lead time", () => {
    const [row] = wantedAmbassadorRows([item()]);
    expect(row).toMatchObject({
      id: ambassadorRowId("app-1:submissionDeadline"),
      title: "Submit: Second Program",
      dueDate: "2026-12-10",
      leadDays: 21,
      url: "https://hybridcloudworks.com/admin/ambassador?tab=applications&application=app-1",
      done: false,
      notified: {},
    });
    expect(row.notes).toMatch(/Ambassador keeps this row/);
    expect(row.id).toMatch(/^ambassador-[0-9a-f]{16}$/);
  });

  it("drops a deadline long past, keeps the soonest when there are too many", () => {
    expect(
      wantedAmbassadorRows([item({ daysLeft: -OVERDUE_DROP_DAYS - 1 })]),
    ).toEqual([]);
    const many = Array.from({ length: MAX_AMBASSADOR_ROWS + 5 }, (_, i) =>
      item({ key: `k${i}`, due: `2027-01-${String(i + 1).padStart(2, "0")}` }),
    );
    const rows = wantedAmbassadorRows(many);
    expect(rows).toHaveLength(MAX_AMBASSADOR_ROWS);
    expect(rows[0].dueDate).toBe("2027-01-01");
  });

  it("leaves out an item without a whole date, and trims a title", () => {
    expect(wantedAmbassadorRows([item({ due: "2026-12" })])).toEqual([]);
    const [row] = wantedAmbassadorRows([item({ title: "  Submit: Second Program " })]);
    expect(row.title).toBe("Submit: Second Program");
  });

  it("gives an item the same id every day, so the timer's stamps are kept", () => {
    expect(ambassadorRowId("x")).toBe(ambassadorRowId("x"));
    expect(ambassadorRowId("x")).not.toBe(ambassadorRowId("y"));
  });
});

describe("syncAmbassadorReminders", () => {
  it("adds an activity requirement not yet met beside the owner's rows, and keeps the timer's stamps on the next sync", async () => {
    const own = {
      id: "mine",
      title: "Mine",
      dueDate: "2026-12-01",
      leadDays: 7,
      notes: "",
      url: "",
      done: false,
      notified: {},
    };
    const store = storeWith({ ambassador: [EXAMPLE], reminders: [own] });
    expect(
      await syncAmbassadorReminders({ store, now: () => NOW }),
    ).toMatchObject({
      synced: true,
      changed: true,
      reminders: 1,
    });
    const [kept, row] = store.doc.reminders;
    expect(kept).toEqual(own);
    expect(row.title).toBe(
      "Example Program: Q4 2026 activity requirement not yet met",
    );

    // The timer says the "ahead" stage and stamps it; the next sync keeps it.
    store.doc.reminders[1].notified = { ahead: "2026-11-25T13:00:01.000Z" };
    expect(
      await syncAmbassadorReminders({ store, now: () => NOW }),
    ).toMatchObject({ changed: false });
    expect(store.doc.reminders[1].notified).toEqual({
      ahead: "2026-11-25T13:00:01.000Z",
    });
  });

  it("removes the row once the period's activity requirement is met", async () => {
    const store = storeWith({ ambassador: [EXAMPLE] });
    await syncAmbassadorReminders({ store, now: () => NOW });
    expect(store.doc.reminders).toHaveLength(1);
    const filed = (id) => ({
      id,
      docType: "evidence",
      date: "2026-11-01",
      programIds: ["program-example"],
      sourceModule: "content",
    });
    store.queryDocs.mockImplementation(async (container, query) => {
      const kind = /docType = '(\w+)'/.exec(query)[1];
      return [EXAMPLE, filed("e1"), filed("e2")].filter(
        (row) => row.docType === kind,
      );
    });
    await syncAmbassadorReminders({ store, now: () => NOW });
    expect(store.doc.reminders).toEqual([]);
  });

  it("writes nothing when a list was cut at its read limit", async () => {
    const store = storeWith({ ambassador: [EXAMPLE] });
    store.queryDocs.mockImplementation(async (container, query) =>
      query.includes("'evidence'")
        ? Array.from({ length: 2000 }, () => ({}))
        : [EXAMPLE],
    );
    const warn = vi.fn();
    expect(
      await syncAmbassadorReminders({ store, now: () => NOW, log: { warn } }),
    ).toEqual({
      synced: false,
      reason: "truncated",
    });
    expect(store.createDoc).not.toHaveBeenCalled();
    expect(warn.mock.calls[0][0]).not.toMatch(/program-example/);
  });
});

describe("syncReminderProviders", () => {
  it("runs every provider in turn, and one that throws does not stop the next", async () => {
    const order = [];
    const warn = vi.fn();
    const results = await syncReminderProviders({
      store: {},
      at: NOW,
      log: { warn },
      providers: [
        {
          id: "first",
          sync: async () => {
            order.push("first");
            throw Object.assign(new Error("secret text"), { code: 503 });
          },
        },
        {
          id: "second",
          sync: async () => {
            order.push("second");
            return { synced: true };
          },
        },
      ],
    });
    expect(order).toEqual(["first", "second"]);
    expect(results).toEqual([
      { id: "first", synced: false, reason: "threw" },
      { id: "second", synced: true, reason: undefined },
    ]);
    expect(warn).toHaveBeenCalledWith(
      "[sendReminders] first reminders sync threw (503)",
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain("secret text");
  });
});
