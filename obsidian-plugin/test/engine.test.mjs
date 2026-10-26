import { test } from "node:test";
import assert from "node:assert/strict";
import { SyncEngine } from "../src/engine.js";

const note = (id = "note-1", body = "Original") => ({
  id,
  type: "note",
  title: "Research",
  body,
  tags: [],
  links: [],
  collections: [],
  urls: [],
  archived: false,
  inbox: true,
  version: 1,
  seq: 1,
});
function fixture() {
  const disk = new Map();
  const remote = new Map();
  const receipts = new Map();
  const state = { entries: {}, references: {}, cursor: 0 };
  let seq = 0,
    offline = false;
  const files = {
    read: async (p) => disk.get(p) ?? null,
    create: async (p, raw) => {
      assert.equal(disk.has(p), false);
      disk.set(p, raw);
    },
    decode: (raw) => {
      try {
        return JSON.parse(raw);
      } catch {
        return { ...note(), body: raw };
      }
    },
    encode: (item) => JSON.stringify(item),
    compareAndWrite: async (p, expected, raw) => {
      assert.equal(disk.get(p) ?? null, expected);
      disk.set(p, raw);
    },
    trashIfUnchanged: async (p, raw) => {
      assert.equal(disk.get(p), raw);
      disk.delete(p);
    },
  };
  const api = {
    push: async ({ item, version, mutationId }) => {
      if (offline) throw new Error("offline");
      if (receipts.has(mutationId)) return receipts.get(mutationId);
      const old = remote.get(item.id);
      if ((old?.version || 0) !== version)
        throw Object.assign(new Error("conflict"), {
          status: 412,
          details: { current: old },
        });
      const saved = { ...item, version: version + 1, seq: ++seq };
      remote.set(item.id, saved);
      const result = { item: saved };
      receipts.set(mutationId, result);
      return result;
    },
    pull: async (cursor) => ({
      protocol: 1,
      items: [...remote.values()].filter((n) => n.seq > cursor),
      cursor: seq,
      hasMore: false,
    }),
    references: async () => ({ items: [], cursor: null, indexComplete: true }),
  };
  const engine = new SyncEngine({
    files,
    api,
    state,
    persist: async () => {},
    report: () => {},
  });
  return {
    disk,
    remote,
    state,
    api,
    engine,
    offline: (v) => {
      offline = v;
    },
  };
}

test("enrolls selected notes only and catches up after an offline edit", async () => {
  const f = fixture();
  f.disk.set("Ideas/Research.md", JSON.stringify(note()));
  f.disk.set("Private.md", "leave alone");
  await f.engine.enroll(["Ideas/Research.md"]);
  const [id] = Object.keys(f.state.entries);
  f.offline(true);
  await assert.rejects(f.engine.run());
  const mutation = f.state.entries[id].pending.mutationId;
  f.offline(false);
  await f.engine.run();
  assert.equal(f.remote.size, 1);
  assert.equal(f.remote.get(id).version, 1);
  assert.equal(f.disk.get("Private.md"), "leave alone");
  assert.equal(f.state.entries[id].pending, undefined);
  assert.ok(mutation);
});
test("preserves both sides of a simultaneous edit instead of last-write-wins", async () => {
  const f = fixture();
  f.disk.set("Idea.md", JSON.stringify(note()));
  await f.engine.enroll(["Idea.md"]);
  await f.engine.run();
  const [id] = Object.keys(f.state.entries);
  f.disk.set("Idea.md", JSON.stringify(note(id, "My offline edit")));
  const old = f.remote.get(id);
  await f.api.push({
    item: { ...old, body: "Website edit" },
    version: old.version,
    mutationId: "remote-edit",
  });
  await f.engine.run();
  assert.equal(f.remote.get(id).body, "Website edit");
  const copy = Object.values(f.state.entries).find(
    (e) => e.item.type === "conflict",
  );
  assert.ok(copy);
  assert.equal(JSON.parse(f.disk.get(copy.path)).body, "My offline edit");
  assert.equal(JSON.parse(f.disk.get("Idea.md")).body, "Website edit");
  await f.engine.run();
  assert.ok(
    [...f.remote.values()].some(
      (n) => n.type === "conflict" && n.body === "My offline edit",
    ),
  );
});
test("archives a locally deleted note and can restore it from the website", async () => {
  const f = fixture();
  f.disk.set("Idea.md", JSON.stringify(note()));
  await f.engine.enroll(["Idea.md"]);
  await f.engine.run();
  const [id] = Object.keys(f.state.entries);
  f.disk.delete("Idea.md");
  await f.engine.run();
  const archived = f.remote.get(id);
  assert.equal(archived.archived, true);
  await f.api.push({
    item: { ...archived, archived: false },
    version: archived.version,
    mutationId: "restore-note",
  });
  await f.engine.run();
  assert.equal(JSON.parse(f.disk.get("Idea.md")).archived, false);
});
test("preserves local edits to site references as working notes without changing HCW content", async () => {
  const f = fixture();
  const reference = {
    ...note("ref_article"),
    type: "reference",
    body: "Published text",
  };
  f.api.references = async () => ({
    items: [reference],
    cursor: null,
    indexComplete: true,
  });
  await f.engine.run({ references: true });
  const entry = f.state.references.ref_article;
  f.disk.set(
    entry.path,
    JSON.stringify({ ...reference, body: "My annotation" }),
  );
  await f.engine.run({ references: true });
  assert.equal(JSON.parse(f.disk.get(entry.path)).body, "Published text");
  assert.ok(
    [...f.disk.values()].some(
      (raw) => JSON.parse(raw).body === "My annotation",
    ),
  );
  assert.equal(f.remote.has("ref_article"), false);
});
test("does not overwrite a note that changed while the remote update was being applied", async () => {
  const f = fixture();
  f.remote.set("note-1", note());
  const original = f.engine.files.compareAndWrite;
  f.engine.files.compareAndWrite = async (p, expected, raw) => {
    f.disk.set(p, "Concurrent local edit");
    return original(p, expected, raw);
  };
  await assert.rejects(f.engine.apply(note()));
  assert.ok([...f.disk.values()].includes("Concurrent local edit"));
  assert.equal(f.state.cursor, 0);
});
test("retains references if backfill is incomplete", async () => {
  const f = fixture();
  f.api.references = async () => ({
    items: [{ ...note("ref_article"), type: "reference" }],
    cursor: null,
    indexComplete: true,
  });
  await f.engine.run({ references: true });
  f.api.references = async () => ({
    items: [],
    cursor: null,
    indexComplete: false,
  });
  await f.engine.run({ references: true });
  assert.ok(f.disk.has(f.state.references.ref_article.path));
});
