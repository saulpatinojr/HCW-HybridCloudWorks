/**
 * No source map ships, and the maps are kept (AP-F11, #935).
 *
 * WHY THIS EXISTS. `vite.config.js` builds hidden maps for every bundle, and
 * `deploy-azure-frontend.yml` uploads dist whole — so until #935 every map
 * was on the public site, fetchable by its hashed name, and nothing said so.
 * The fix is two halves in two files: the workflow moves the maps out of
 * dist and keeps them as an artifact, and the payload check refuses a dist
 * with one left. Either half can be edited without the other noticing, and a
 * deploy is the first place that would notice, so this reads both files and
 * holds them together — in the frontend test job, minutes after the push.
 *
 * Read as text, like prerender.test.js reads the same workflow: a YAML parser
 * would add a dependency to assert on four lines.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FRONTEND_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = join(FRONTEND_ROOT, '..');

const workflow = readFileSync(
  join(REPO_ROOT, '.github', 'workflows', 'deploy-azure-frontend.yml'),
  'utf8'
);
const viteConfig = readFileSync(join(FRONTEND_ROOT, 'vite.config.js'), 'utf8');

/** Where a step starts, so order can be asserted; -1 when it is gone. */
const stepAt = (name) => workflow.indexOf(`- name: ${name}`);
/** The text of one step, up to the next. */
const step = (name, next) => workflow.slice(stepAt(name), stepAt(next));

describe('the deploy workflow and source maps', () => {
  it('builds hidden maps, which is what the deploy expects to find', () => {
    expect(viteConfig).toMatch(/sourcemap: mode === 'development' \? true : 'hidden'/);
  });

  it('sets the maps aside after the build and before the payload check, in that order', () => {
    const order = [
      'Build',
      'Set the source maps aside',
      'Keep the source maps for thirty days',
      'Verify the upload payload',
      'Upload the verified site',
    ].map(stepAt);
    expect(order).not.toContain(-1);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('moves every map out of dist, and fails a build that produced none', () => {
    const aside = step('Set the source maps aside', 'Keep the source maps for thirty days');
    expect(aside).toMatch(/find dist -name '\*\.map'/);
    expect(aside).toMatch(/mv "\$map" "\$target"/);
    expect(aside).toMatch(/\[ "\$count" -gt 0 \]/);
  });

  it('keeps them as a workflow artifact on the same pinned action as the site, for thirty days', () => {
    const keep = step('Keep the source maps for thirty days', 'Verify the upload payload');
    const site = step('Upload the verified site', 'Deploy to Azure Static Web Apps');
    const pin = /uses: actions\/upload-artifact@([0-9a-f]{40}) # v[\d.]+/.exec(site);
    expect(pin, 'the site upload no longer pins upload-artifact by SHA').not.toBe(null);
    expect(keep).toContain(`uses: actions/upload-artifact@${pin[1]} # ${pin[0].split('# ')[1]}`);
    expect(keep).toMatch(/name: source-maps/);
    expect(keep).toMatch(/path: frontend\/source-maps/);
    expect(keep).toMatch(/retention-days: 30/);
    expect(keep).toMatch(/if-no-files-found: error/);
  });

  it('refuses a payload with a map left in it', () => {
    const verify = step('Verify the upload payload', 'Upload the verified site');
    expect(verify).toMatch(/maps=\$\(find dist -name '\*\.map' \| wc -l\)/);
    expect(verify).toMatch(/\[ "\$maps" -eq 0 \]/);
  });

  it('never hands the maps to the deploy job, which uploads to the site', () => {
    const deploy = workflow.slice(workflow.indexOf('\n  deploy:'));
    expect(deploy).not.toContain('source-maps');
  });
});
