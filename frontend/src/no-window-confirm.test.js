/**
 * No browser confirm dialog anywhere under src (AP-F12, #936).
 *
 * Confirmations are state rendered with components/admin/ConfirmModal (ADR
 * 0033 §2). The browser's dialog blocks the thread, cannot be styled or
 * labelled, is read by a screen reader as nothing to do with the page, and
 * on a phone opens as a system sheet over whatever the tap was meant to
 * close. Three of them sat beside the modal for a year; this reads every
 * source file so a fourth cannot land unnoticed.
 *
 * Source text, not parsed code, on purpose: a comment that names the call
 * fails too, so the rule has no exceptions to remember.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = import.meta.dirname;
const SOURCE = /\.(js|jsx|ts|tsx)$/;
const TEST = /\.test\.(js|jsx|ts|tsx)$/;
const SKIP_DIRS = new Set(['__tests__', 'node_modules']);

// `window.confirm`, any other global's `.confirm(`, and a bare `confirm(`
// that is not a method or a longer identifier (`writes.confirmDelete(`,
// `onConfirm(` and `confirmLeave(` are not this).
const BROWSER_CONFIRM =
  /(?:window|globalThis|self|global)\s*\.\s*confirm\b|(?<![\w$.])confirm\s*\(/;

/** Every non-test source file under a directory, so a new file is read without being listed. */
function sourceFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      sourceFiles(path, out);
    } else if (SOURCE.test(name) && !TEST.test(name)) {
      out.push(path);
    }
  }
  return out;
}

describe('the browser confirm dialog', () => {
  it('appears in no source file under src', () => {
    const files = sourceFiles(SRC);
    expect(files.length).toBeGreaterThan(100);
    const offenders = files
      .filter((file) => BROWSER_CONFIRM.test(readFileSync(file, 'utf8')))
      .map((file) => relative(SRC, file).replace(/\\/g, '/'));
    expect(offenders).toEqual([]);
  });

  it('is what the pattern catches, and a method or a longer name is not', () => {
    expect(BROWSER_CONFIRM.test('if (!window.confirm("Sure?")) return;')).toBe(true);
    expect(BROWSER_CONFIRM.test('if (confirm(UNSAVED_MESSAGE)) return;')).toBe(true);
    expect(BROWSER_CONFIRM.test('globalThis.confirm(msg)')).toBe(true);
    expect(BROWSER_CONFIRM.test('writes.confirmDelete()')).toBe(false);
    expect(BROWSER_CONFIRM.test('onConfirm(() => run())')).toBe(false);
    expect(BROWSER_CONFIRM.test('leave.confirmLeave()')).toBe(false);
    expect(BROWSER_CONFIRM.test('const confirmLabel = "Delete";')).toBe(false);
  });
});
