/**
 * One Terraform version rule for all three packs (#1860). Azure used to ask
 * for 1.12 or newer while AWS and Google Cloud asked for 1.9 with no upper
 * bound, and nothing said why. These tests keep the three on the one value in
 * terraformVersion.js, and keep a second copy from being declared elsewhere.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { DEFAULT_STATE, TERRAFORM_REQUIRED_VERSION, emitFiles } from './index';

const HERE = import.meta.dirname;
const CLOUDS = ['azure', 'aws', 'gcp'];

const fileOf = (cloud, path) =>
  emitFiles({ ...DEFAULT_STATE, cloud }).find((f) => f.path === path)?.content ?? '';

/** Every non-test source file in the landing zone folder, so a new one is read too. */
function sourceFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== '__snapshots__') sourceFiles(path, out);
    } else if (/\.jsx?$/.test(name) && !/\.test\.jsx?$/.test(name)) {
      out.push(path);
    }
  }
  return out;
}

describe('the Terraform version rule', () => {
  it('is 1.12 or newer and below 2.0', () => {
    expect(TERRAFORM_REQUIRED_VERSION).toBe('>= 1.12, < 2.0');
  });

  it.each(CLOUDS)('is the line the %s pack writes into terraform.tf', (cloud) => {
    const lines = fileOf(cloud, 'terraform.tf').match(/required_version\s*=\s*"[^"]*"/g);
    expect(lines).toEqual([`required_version = "${TERRAFORM_REQUIRED_VERSION}"`]);
  });

  it.each(CLOUDS)('is the version the %s pack README names', (cloud) => {
    expect(fileOf(cloud, 'README.md')).toContain(TERRAFORM_REQUIRED_VERSION);
  });

  it('is declared in terraformVersion.js and nowhere else', () => {
    // A second constant, or a version typed straight into a generator's
    // required_version line, would let the packs drift apart again.
    const declares =
      /TERRAFORM_REQUIRED_VERSION\s*=|required_version['"]?\s*[,:=]\s*(?:q\(\s*)?['"`][<>=~]/;
    const files = sourceFiles(HERE);
    expect(files.length).toBeGreaterThan(20);
    const declaring = files
      .filter((file) => declares.test(readFileSync(file, 'utf8')))
      .map((file) => relative(HERE, file).replace(/\\/g, '/'));
    expect(declaring).toEqual(['terraformVersion.js']);
  });
});
