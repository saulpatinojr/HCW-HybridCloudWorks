/**
 * Derives out-of-component file dependencies (imports and file reads) from tests
 * and asserts that CI path filters in .github/workflows/ci.yml match every one.
 *
 * (QA-4, #979)
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const COMPONENTS = [
  { name: 'frontend', dir: 'frontend' },
  { name: 'functions (azure)', dir: 'functions' },
  { name: 'scripts (operations)', dir: 'scripts' },
  { name: 'vps-agent', dir: 'vps-agent' },
  { name: 'edge (availability probe)', dir: 'edge/availability-probe' },
];

/** Recursively discover test files inside a component directory. */
export function findTestFiles(dir) {
  let results = [];
  if (!existsSync(dir)) return results;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules', 'dist', '.git', 'coverage', 'e2e'].includes(entry.name)) continue;
      results = results.concat(findTestFiles(full));
    } else if (/\.test\.[cm]?[jt]sx?$/.test(entry.name)) {
      results.push(full);
    }
  }
  return results;
}

function resolveFile(candidate) {
  if (existsSync(candidate) && statSync(candidate).isFile()) {
    return candidate;
  }
  for (const ext of ['.js', '.jsx', '.mjs', '.ts', '.tsx', '.json', '/index.js']) {
    const withExt = candidate + ext;
    if (existsSync(withExt) && statSync(withExt).isFile()) {
      return withExt;
    }
  }
  return null;
}

/**
 * Derive out-of-component file paths that are imported or read by test files
 * or test helpers within the component.
 */
export function deriveCrossRootReads(compDir, repoRoot = DEFAULT_REPO_ROOT) {
  const compDirAbs = join(repoRoot, compDir);
  const testFiles = findTestFiles(compDirAbs);
  const scanned = new Set(testFiles);
  const queue = [...testFiles];
  const crossRootReads = new Set();

  while (queue.length > 0) {
    const current = queue.shift();
    const content = readFileSync(current, 'utf8');

    // 1. Static and dynamic imports / requires: import ... from '...', require('...')
    const importMatches = content.matchAll(
      /(?:import|export|from|require)\s*(?:\(\s*)?['"](\.[^'"]+)['"]/g
    );
    for (const match of importMatches) {
      const spec = match[1];
      const targetAbs = resolve(dirname(current), spec);
      const resolved = resolveFile(targetAbs);
      if (resolved) {
        if (
          !resolved.startsWith(compDirAbs + '\\') &&
          !resolved.startsWith(compDirAbs + '/') &&
          resolved !== compDirAbs
        ) {
          const relTarget = relative(repoRoot, resolved).replace(/\\/g, '/');
          crossRootReads.add(relTarget);
        } else if (!scanned.has(resolved) && !resolved.includes('node_modules')) {
          scanned.add(resolved);
          queue.push(resolved);
        }
      }
    }

    // 2. new URL('...', import.meta.url)
    const urlMatches = content.matchAll(
      /new URL\(\s*['"](\.[^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/g
    );
    for (const match of urlMatches) {
      const spec = match[1];
      const targetAbs = resolve(dirname(current), spec);
      const resolved = resolveFile(targetAbs);
      if (resolved) {
        if (
          !resolved.startsWith(compDirAbs + '\\') &&
          !resolved.startsWith(compDirAbs + '/') &&
          resolved !== compDirAbs
        ) {
          const relTarget = relative(repoRoot, resolved).replace(/\\/g, '/');
          crossRootReads.add(relTarget);
        }
      }
    }

    // 3. Explicit filesystem reads: readFileSync, readFile, labHostFile, read(...)
    const readMatches = content.matchAll(
      /(?:readFileSync|readFile|labHostFile|read)\s*\(\s*([^,)]+)/g
    );
    for (const rm of readMatches) {
      const callArg = rm[1].trim();
      // Check for string literal inside the read call
      const strMatch = callArg.match(/['"]([^'"]+)['"]/);
      if (strMatch) {
        const str = strMatch[1];
        const candidates = [
          resolve(dirname(current), str),
          resolve(repoRoot, str),
          resolve(repoRoot, 'lab-host', str),
          resolve(repoRoot, 'lab-image', str),
          resolve(repoRoot, 'infra', str),
          resolve(repoRoot, 'functions', str),
          resolve(repoRoot, 'frontend', str),
        ];
        for (const cand of candidates) {
          const resolved = resolveFile(cand);
          if (
            resolved &&
            !resolved.startsWith(compDirAbs + '\\') &&
            !resolved.startsWith(compDirAbs + '/')
          ) {
            crossRootReads.add(relative(repoRoot, resolved).replace(/\\/g, '/'));
            break;
          }
        }
      } else {
        // If the argument is an identifier like `read(ADDON_PANE_PAGE)`:
        // Find const/let ADDON_PANE_PAGE = '...'
        const id = callArg.trim();
        if (/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(id)) {
          const declMatch = content.match(
            new RegExp(`(?:const|let|var)\\s+${id}\\s*=\\s*['"]([^'"]+)['"]`)
          );
          if (declMatch) {
            const str = declMatch[1];
            const candidates = [
              resolve(dirname(current), str),
              resolve(repoRoot, str),
              resolve(repoRoot, 'lab-host', str),
              resolve(repoRoot, 'lab-image', str),
              resolve(repoRoot, 'infra', str),
              resolve(repoRoot, 'functions', str),
              resolve(repoRoot, 'frontend', str),
            ];
            for (const cand of candidates) {
              const resolved = resolveFile(cand);
              if (
                resolved &&
                !resolved.startsWith(compDirAbs + '\\') &&
                !resolved.startsWith(compDirAbs + '/')
              ) {
                crossRootReads.add(relative(repoRoot, resolved).replace(/\\/g, '/'));
                break;
              }
            }
          }
        }
      }
    }
  }

  return crossRootReads;
}

/** Parse matrix filters from .github/workflows/ci.yml */
export function parseCiFilters(
  ciYmlContent = readFileSync(join(DEFAULT_REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8')
) {
  const filterRegex = /- name:\s*([^\n]+)\s+dir:\s*([^\n]+)(?:[\s\S]*?)filter:\s*'([^']+)'/g;
  const filters = new Map();
  let m;
  while ((m = filterRegex.exec(ciYmlContent)) !== null) {
    const name = m[1].trim();
    const dir = m[2].trim();
    const filter = m[3].trim();
    filters.set(dir, { name, filter, regex: new RegExp(filter) });
  }
  return filters;
}
