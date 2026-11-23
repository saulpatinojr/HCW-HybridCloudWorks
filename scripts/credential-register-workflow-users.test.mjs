/**
 * A GitHub Actions secret's row in the credential register names every
 * workflow that reads it.
 *
 * The row for MANIFEST_APP_PRIVATE_KEY (the private key of this repository's
 * GitHub App) said four workflows while seven read the key (#1778, #1795). A
 * workflow that starts reading the key, or stops, fails here until the row in
 * functions/src/lib/credentials/register.js and the two standards pages
 * (docs/standards/required-inputs.md, variables-and-secrets.md) say so.
 *
 * It lives in scripts/, not beside the register, because this row of the CI
 * matrix already runs on every workflow change and the functions row does not.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, it, expect } from 'vitest';

import { findCredential } from '../functions/src/lib/credentials/register.js';

const workflowsDir = fileURLToPath(new URL('../.github/workflows/', import.meta.url));

describe('the credential register and the workflows agree on who reads the GitHub App key', () => {
  const readers = readdirSync(workflowsDir)
    .filter((file) => /\.ya?ml$/.test(file))
    .filter((file) => readFileSync(workflowsDir + file, 'utf8').includes('secrets.MANIFEST_APP_PRIVATE_KEY'))
    .sort();

  it('MANIFEST_APP_PRIVATE_KEY lists exactly the workflows that use it', () => {
    const row = findCredential('gh-manifest-app-private-key');
    const listed = row.consumer.split(', ').sort();

    expect(readers.length).toBeGreaterThan(0);
    expect(listed).toEqual(readers);
  });
});
