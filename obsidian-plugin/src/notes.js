import { createHash } from "node:crypto";
export const hash = (text) => createHash("sha256").update(text).digest("hex");
const safeTitle = (title) =>
  title
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "-")
    .replace(/[. ]+$/g, "")
    .slice(0, 60) || "Note";
export const notePath = (item, folder = "Notes") =>
  `HCW/${folder}/${safeTitle(item.title)}--${item.id}.md`;
// True when a note has something to send: a send already started, or text
// that changed since the last send. A note that never reached the site and
// is gone from disk, or an archived note already sent, has nothing to send.
export function needsPush(entry, raw) {
  if (raw === null && entry.version === 0) return false;
  if (entry.pending) return true;
  if (raw !== null) return hash(raw) !== entry.hash;
  return !entry.item.archived;
}
// The counts the status call carries: notes not yet on the site, and open
// recovery copies.
export function statusCounts(entries) {
  const all = Object.values(entries);
  return {
    pending: all.filter((e) => e.pending || !e.version).length,
    conflicts: all.filter((e) => e.item.type === "conflict" && !e.item.archived)
      .length,
  };
}
