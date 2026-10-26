import { createHash, randomUUID } from "node:crypto";
const hash = (text) => createHash("sha256").update(text).digest("hex");
const safeTitle = (title) =>
  title
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "-")
    .replace(/[. ]+$/g, "")
    .slice(0, 60) || "Note";
export const notePath = (item, folder = "Notes") =>
  `HCW/${folder}/${safeTitle(item.title)}--${item.id}.md`;
export class SyncEngine {
  constructor({ files, api, state, persist, report }) {
    Object.assign(this, { files, api, state, persist, report });
    this.state.entries ||= {};
    this.state.references ||= {};
    this.state.cursor ||= 0;
  }
  async enroll(paths) {
    for (const path of paths) {
      if (Object.values(this.state.entries).some((e) => e.path === path))
        continue;
      const raw = await this.files.read(path);
      const item = this.files.decode(raw, path);
      // A copied note never silently adopts another enrolled note's identity.
      const id = randomUUID();
      this.state.entries[id] = {
        path,
        version: 0,
        seq: 0,
        hash: null,
        item: { ...item, id },
      };
    }
    await this.persist();
  }
  async preserve(item, raw, conflictOf) {
    const id = randomUUID();
    const copy = {
      ...this.files.decode(raw, ""),
      id,
      type: "conflict",
      title: `Recovery: ${item.title}`.slice(0, 300),
      conflictOf,
      archived: false,
    };
    copy.links = [...new Set([...(copy.links || []), conflictOf])];
    const path = notePath(copy, "Conflicts");
    const encoded = this.files.encode(copy, raw);
    await this.files.create(path, encoded);
    this.state.entries[id] = {
      path,
      version: 0,
      seq: 0,
      hash: null,
      item: copy,
    };
    await this.persist();
    return copy;
  }
  async push(id, entry) {
    const raw = await this.files.read(entry.path);
    if (raw === null && entry.version === 0) return;
    if (raw !== null && hash(raw) === entry.hash && !entry.pending) return;
    if (raw === null && entry.item.archived && !entry.pending) return;
    if (!entry.pending) {
      const decoded =
        raw === null ? entry.item : this.files.decode(raw, entry.path);
      const item = {
        ...decoded,
        id,
        type: entry.item.type,
        ...(entry.item.conflictOf && { conflictOf: entry.item.conflictOf }),
        archived: raw === null || decoded.archived === true,
      };
      entry.pending = {
        item,
        version: entry.version,
        mutationId: randomUUID(),
        raw,
      };
      await this.persist();
    }
    const pending = entry.pending;
    try {
      const saved = await this.api.push(pending);
      Object.assign(entry, {
        version: saved.item.version,
        seq: saved.item.seq,
        hash: pending.raw === null ? null : hash(pending.raw),
        item: saved.item,
      });
      delete entry.pending;
      if (
        pending.raw !== null &&
        (await this.files.read(entry.path)) === pending.raw
      ) {
        const encoded = this.files.encode(saved.item, pending.raw);
        await this.files.compareAndWrite(entry.path, pending.raw, encoded);
        entry.hash = hash(encoded);
      }
      await this.persist();
    } catch (error) {
      if (error.status !== 412) throw error;
      // Preserve the local text BEFORE accepting any remote replacement.
      if (raw !== null) await this.preserve(entry.item, raw, id);
      const remote = error.details?.current;
      if (!remote) throw error;
      delete entry.pending;
      Object.assign(entry, {
        version: remote.version,
        seq: 0,
        hash: raw === null ? null : hash(raw),
        item: remote,
      });
      await this.persist();
      this.report("Conflict preserved in HCW/Conflicts. Review both versions.");
    }
  }
  async apply(item) {
    let entry = this.state.entries[item.id];
    if (entry && item.seq <= entry.seq) return;
    if (!entry) {
      if (item.archived) return;
      entry = { path: notePath(item), version: 0, hash: null, item };
      this.state.entries[item.id] = entry;
    }
    const raw = await this.files.read(entry.path);
    if (raw !== null && entry.hash !== null && hash(raw) !== entry.hash)
      await this.preserve(entry.item, raw, item.id);
    // compareAndWrite uses Vault.process and refuses if another local edit
    // happened while the network or conflict preservation was in progress.
    if (item.archived) {
      if (raw !== null) await this.files.trashIfUnchanged(entry.path, raw);
      Object.assign(entry, {
        item,
        version: item.version,
        seq: item.seq,
        hash: null,
      });
    } else {
      const encoded = this.files.encode(item, raw || "");
      await this.files.compareAndWrite(entry.path, raw, encoded);
      Object.assign(entry, {
        item,
        version: item.version,
        seq: item.seq,
        hash: hash(encoded),
      });
    }
    await this.persist();
  }
  async references() {
    let cursor = null;
    const seen = new Set();
    let complete = true;
    do {
      const page = await this.api.references(cursor);
      complete &&= page.indexComplete;
      for (const item of page.items) {
        seen.add(item.id);
        const old = this.state.references[item.id];
        const path = old?.path || notePath(item, "Site");
        const raw = await this.files.read(path);
        if (old && raw !== null && hash(raw) !== old.hash)
          await this.preserve(item, raw, item.id);
        const encoded = this.files.encode({ ...item, type: "reference" }, "");
        if (raw !== encoded)
          await this.files.compareAndWrite(path, raw, encoded);
        this.state.references[item.id] = { path, hash: hash(encoded) };
      }
      await this.persist();
      cursor = page.cursor;
    } while (cursor);
    if (complete)
      for (const [id, entry] of Object.entries(this.state.references)) {
        if (seen.has(id)) continue;
        const raw = await this.files.read(entry.path);
        if (raw !== null && hash(raw) !== entry.hash)
          await this.preserve({ title: id }, raw, id);
        if (raw !== null) await this.files.trashIfUnchanged(entry.path, raw);
        delete this.state.references[id];
      }
    await this.persist();
  }
  async run({ references = false } = {}) {
    if (this.running) return;
    this.running = true;
    try {
      // Bound a cycle; newly created recovery copies push next cycle.
      for (const [id, entry] of Object.entries(this.state.entries))
        await this.push(id, entry);
      let more;
      do {
        const page = await this.api.pull(this.state.cursor);
        if (page.protocol !== 1)
          throw new Error(
            "Update the plugin before continuing synchronization.",
          );
        for (const item of page.items) await this.apply(item);
        this.state.cursor = page.cursor;
        await this.persist();
        more = page.hasMore;
      } while (more);
      if (references) await this.references();
      this.state.lastSuccessfulSync = new Date().toISOString();
      this.state.lastError = null;
      await this.persist();
      await this.api
        .status?.({
          pending: Object.values(this.state.entries).filter(
            (e) => e.pending || !e.version,
          ).length,
          conflicts: Object.values(this.state.entries).filter(
            (e) => e.item.type === "conflict" && !e.item.archived,
          ).length,
          lastSuccessfulSync: this.state.lastSuccessfulSync,
          error: "none",
        })
        .catch(() => {});
      this.report(`Synced ${new Date().toLocaleTimeString()}`);
    } catch (error) {
      this.state.lastError =
        error.status === 401
          ? "Sign in again to resume sync."
          : "Sync paused. Local changes are retained; use Sync now to retry.";
      await this.persist();
      await this.api
        .status?.({
          pending: Object.values(this.state.entries).filter(
            (e) => e.pending || !e.version,
          ).length,
          conflicts: Object.values(this.state.entries).filter(
            (e) => e.item.type === "conflict" && !e.item.archived,
          ).length,
          lastSuccessfulSync: this.state.lastSuccessfulSync || null,
          error: error.status === 401 ? "authentication" : "unavailable",
        })
        .catch(() => {});
      this.report(this.state.lastError);
      throw error;
    } finally {
      this.running = false;
    }
  }
}
