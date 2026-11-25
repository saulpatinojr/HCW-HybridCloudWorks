/** Where promote-idea.mjs may write a draft: the vault's Drafts folder, never anywhere inside this repository, however the path is spelled. */
import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The repository this script belongs to: two folders up from scripts/ideas. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The vault's folder for drafts, and the environment variable that names the vault. */
const DRAFTS_FOLDER = 'Drafts';
const VAULT_ENV = 'HCW_VAULT';

/**
 * The real, absolute form of a path that may not exist yet: the longest part
 * that exists is resolved through symlinks and junctions, and the rest is put
 * back on the end. Without this a link in the path would be taken at its word,
 * and a Drafts folder that does not exist yet could hide a link in its parent.
 */
export function realPathOf(path) {
  let current = resolve(path);
  const rest = [];
  for (;;) {
    try {
      const real = realpathSync.native(current);
      return rest.length === 0 ? real : join(real, ...rest);
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
      const parent = dirname(current);
      if (parent === current) return resolve(path);
      rest.unshift(basename(current));
      current = parent;
    }
  }
}

/**
 * Is `target` the repository root or anywhere below it? Both paths are taken as
 * already real (see realPathOf). Windows and macOS file systems ignore case by
 * default, so there `C:\Repo` and `c:\repo` are the same folder; elsewhere case
 * counts. A sibling whose name only starts with the repository's name
 * (`repo-copy` next to `repo`) is not inside it.
 */
export function isInside(target, root, caseInsensitive = process.platform === 'win32' || process.platform === 'darwin') {
  const fold = (path) => (caseInsensitive ? path.toLowerCase() : path);
  const below = relative(fold(resolve(root)), fold(resolve(target)));
  return below === '' || (below !== '..' && !below.startsWith(`..${sep}`) && !isAbsolute(below));
}

/**
 * Where drafts go: `<vault>/Drafts`, or a plain-language reason there is none.
 * Nothing is created here; the folder is only worked out and checked.
 */
export function chooseDraftsFolder({ vault, env, repoRoot }) {
  const given = vault ?? env[VAULT_ENV];
  if (!given || !given.trim()) {
    return {
      error:
        'No vault was given, so there is nowhere safe to put the draft. Give the folder of your Obsidian vault with ' +
        `--vault <folder>, or set the ${VAULT_ENV} environment variable to it. Drafts are never written into this ` +
        'repository, because it is public.',
    };
  }
  const drafts = join(resolve(given), DRAFTS_FOLDER);
  let real;
  let realRoot;
  try {
    real = realPathOf(drafts);
    realRoot = realPathOf(repoRoot);
  } catch (error) {
    return { error: `Cannot work out where "${drafts}" is: ${error.message}` };
  }
  if (isInside(real, realRoot)) {
    return {
      refused: true,
      error:
        `Refused: "${drafts}"${real === drafts ? '' : ` (which is really "${real}")`} is inside the repository ` +
        `"${repoRoot}". The repository is public, and a draft that is not published yet must never be saved in it. ` +
        'Use the folder of your private Obsidian vault, which belongs somewhere outside the repository.',
    };
  }
  return { drafts, realRoot };
}
