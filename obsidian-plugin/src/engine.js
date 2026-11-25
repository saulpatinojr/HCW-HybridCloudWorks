import { randomUUID } from "node:crypto";
import { hash, needsPush, notePath, statusCounts } from "./notes.js";
import { syncReferences } from "./references.js";
export { notePath };
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
    if (!needsPush(entry, raw)) return;
    if (!entry.pending) await this.stage(id, entry, raw);
    const pending = entry.pending;
    try {
      const saved = await this.api.push(pending);
      await this.accept(entry, pending, saved);
    } catch (error) {
      await this.rejected(id, entry, raw, error);
    }
  }
  // Record what is about to be sent before sending it, so a send cut short
  // is retried with the same mutation id.
  async stage(id, entry, raw) {
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
  // The site stored the note: take its version, and write its copy back
  // when nothing was edited locally in the meantime.
  async accept(entry, pending, saved) {
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
  }
  // A 412 means the site holds a newer version. Anything else is rethrown.
  async rejected(id, entry, raw, error) {
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
    await syncReferences(this);
  }
  async run({ references = false } = {}) {
    if (this.running) return;
    this.running = true;
    try {
      // Bound a cycle; newly created recovery copies push next cycle.
      for (const [id, entry] of Object.entries(this.state.entries))
        await this.push(id, entry);
      await this.pullAll();
      if (references) await this.references();
      this.state.lastSuccessfulSync = new Date().toISOString();
      this.state.lastError = null;
      await this.persist();
      await this.sendStatus(this.state.lastSuccessfulSync, "none");
      this.report(`Synced ${new Date().toLocaleTimeString()}`);
    } catch (error) {
      this.state.lastError =
        error.status === 401
          ? "Sign in again to resume sync."
          : "Sync paused. Local changes are retained; use Sync now to retry.";
      await this.persist();
      await this.sendStatus(
        this.state.lastSuccessfulSync || null,
        error.status === 401 ? "authentication" : "unavailable",
      );
      this.report(this.state.lastError);
      throw error;
    } finally {
      this.running = false;
    }
  }
  // Apply every page of changes from the site, saving the cursor after each.
  async pullAll() {
    let more;
    do {
      const page = await this.api.pull(this.state.cursor);
      if (page.protocol !== 1)
        throw new Error("Update the plugin before continuing synchronization.");
      for (const item of page.items) await this.apply(item);
      this.state.cursor = page.cursor;
      await this.persist();
      more = page.hasMore;
    } while (more);
  }
  // Tell the site how this vault is doing, when the API offers it. A failed
  // status call never fails the sync.
  async sendStatus(lastSuccessfulSync, error) {
    await this.api
      .status?.({
        ...statusCounts(this.state.entries),
        lastSuccessfulSync,
        error,
      })
      .catch(() => {});
  }
}
