import { TFile, normalizePath } from "obsidian";

/** Create each missing folder on the way to `path`. A folder another
 * writer created at the same moment is fine. */
async function ensureFolders(vault, path) {
  const parts = normalizePath(path).split("/");
  parts.pop();
  let folder = "";
  for (const part of parts) {
    folder = folder ? `${folder}/${part}` : part;
    if (vault.getAbstractFileByPath(folder)) continue;
    try {
      await vault.createFolder(folder);
    } catch {
      if (!vault.getAbstractFileByPath(folder))
        throw new Error("Could not create sync folder.");
    }
  }
}

/** Write `value` only if the note still holds `expected` (null: does not
 * exist yet). Vault.process refuses if another local edit got there first. */
async function compareAndWrite(vault, path, expected, value) {
  await ensureFolders(vault, path);
  const file = vault.getAbstractFileByPath(path);
  if (!file) {
    if (expected !== null)
      throw new Error("The note moved during sync. Retry.");
    await vault.create(path, value);
  } else if (file instanceof TFile)
    await vault.process(file, (current) => {
      if (current !== expected)
        throw new Error("The note changed during sync. Retry.");
      return value;
    });
  else throw new Error("A folder is using the note path.");
}

async function trashIfUnchanged(vault, path, expected) {
  const file = vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile) || (await vault.read(file)) !== expected)
    throw new Error("The note changed before archiving. Retry.");
  // Vault trash preserves recovery. An active editor is never replaced
  // by a raw filesystem unlink.
  await vault.trash(file, false);
}

/** The file operations the sync engine needs, done through Obsidian's vault
 * so an open editor is never written behind its back. */
export function vaultFiles(vault) {
  return {
    read: async (path) => {
      const file = vault.getAbstractFileByPath(path);
      return file instanceof TFile ? vault.read(file) : null;
    },
    compareAndWrite: (path, expected, value) =>
      compareAndWrite(vault, path, expected, value),
    create: async (path, value) => {
      await ensureFolders(vault, path);
      await vault.create(path, value);
    },
    trashIfUnchanged: (path, expected) =>
      trashIfUnchanged(vault, path, expected),
  };
}
