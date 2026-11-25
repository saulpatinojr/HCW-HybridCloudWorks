import { hash, notePath } from "./notes.js";
// Write one site reference into HCW/Site. A local edit to the old copy is
// preserved as a recovery copy before it is replaced.
async function refreshReference(engine, item) {
  const old = engine.state.references[item.id];
  const path = old?.path || notePath(item, "Site");
  const raw = await engine.files.read(path);
  if (old && raw !== null && hash(raw) !== old.hash)
    await engine.preserve(item, raw, item.id);
  const encoded = engine.files.encode({ ...item, type: "reference" }, "");
  if (raw !== encoded) await engine.files.compareAndWrite(path, raw, encoded);
  engine.state.references[item.id] = { path, hash: hash(encoded) };
}
// Remove the references the site no longer lists, keeping a recovery copy of
// any that were edited locally.
async function dropMissingReferences(engine, seen) {
  for (const [id, entry] of Object.entries(engine.state.references)) {
    if (seen.has(id)) continue;
    const raw = await engine.files.read(entry.path);
    if (raw !== null && hash(raw) !== entry.hash)
      await engine.preserve({ title: id }, raw, id);
    if (raw !== null) await engine.files.trashIfUnchanged(entry.path, raw);
    delete engine.state.references[id];
  }
}
// Page through the site's references. Missing ones are removed only when
// the site says its index is complete.
export async function syncReferences(engine) {
  let cursor = null;
  const seen = new Set();
  let complete = true;
  do {
    const page = await engine.api.references(cursor);
    complete &&= page.indexComplete;
    for (const item of page.items) {
      seen.add(item.id);
      await refreshReference(engine, item);
    }
    await engine.persist();
    cursor = page.cursor;
  } while (cursor);
  if (complete) await dropMissingReferences(engine, seen);
  await engine.persist();
}
