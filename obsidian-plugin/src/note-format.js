import { parseYaml, stringifyYaml } from "obsidian";

const NOTE_TYPES = ["note", "topic", "project", "conflict"];

export function frontmatter(raw) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return { properties: {}, body: raw };
  const properties = parseYaml(match[1]);
  if (
    !properties ||
    typeof properties !== "object" ||
    Array.isArray(properties)
  )
    throw new Error("Invalid note properties. Fix them before syncing.");
  return { properties, body: raw.slice(match[0].length) };
}

const list = (v) =>
  Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];

// The note's own title property, or its file name without .md.
const titleOf = (p, path) =>
  typeof p.title === "string"
    ? p.title
    : path.split("/").at(-1)?.replace(/\.md$/, "") || "Untitled";

/** A note's Markdown text → the item the site stores. `findLinked(target)`
 * returns the [id, entry] pair of an enrolled note a [[link]] points at, if
 * there is one. */
export function decodeNote(raw, path, findLinked) {
  const { properties: p, body } = frontmatter(raw || "");
  const links = new Set(list(p.hcw_links));
  for (const match of body.matchAll(/\[\[([^\]|#]+)(?:[^\]]*)\]\]/g)) {
    const found = findLinked(match[1]);
    if (found) links.add(found[0]);
  }
  const properties = Object.fromEntries(
    Object.entries(p).filter(
      ([key]) => !key.startsWith("hcw_") && !["title", "tags"].includes(key),
    ),
  );
  return {
    type: NOTE_TYPES.includes(p.hcw_type) ? p.hcw_type : "note",
    title: titleOf(p, path),
    body,
    properties,
    tags: list(p.tags),
    links: [...links],
    collections: list(p.hcw_collections),
    urls: list(p.hcw_urls),
    archived: p.hcw_archived === true,
    inbox: p.hcw_inbox !== false,
  };
}

/** An item from the site → Markdown text, keeping the previous text's own
 * properties. */
export function encodeNote(item, previous) {
  const { properties } = frontmatter(previous);
  const p = {
    ...properties,
    ...item.properties,
    title: item.title,
    tags: item.tags || [],
    hcw_id: item.id,
    hcw_type: item.type,
    hcw_links: item.links || [],
    hcw_collections: item.collections || [],
    hcw_urls: item.urls || [],
    hcw_archived: item.archived === true,
    hcw_inbox: item.inbox !== false,
  };
  if (item.href) p.hcw_source = `https://hybridcloudworks.com${item.href}`;
  if (item.type === "reference")
    p.hcw_reference_truncated = item.truncated === true;
  return `---\n${stringifyYaml(p).trimEnd()}\n---\n${item.body}`;
}
