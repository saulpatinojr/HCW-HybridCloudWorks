import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const runbookPath = resolve(here, '../docs/runbooks/data-subject-requests.md');
const runbookContent = readFileSync(runbookPath, 'utf8');

describe('data-subject-requests runbook integrity (#1237)', () => {
  it('names the real Cosmos DB account and database', () => {
    expect(runbookContent).toContain('cosmos-site-prod-cus');
    expect(runbookContent).toContain('database `hcw`');
    expect(runbookContent).not.toContain('cosmos-hcw-prod-cus');
  });

  it('contains no nonexistent az cosmosdb sql CLI commands', () => {
    expect(runbookContent).not.toContain('az cosmosdb sql query');
    expect(runbookContent).not.toContain('az cosmosdb sql document delete');
  });

  it('references real storage account and container for Cosmos backups', () => {
    expect(runbookContent).toContain('stsiteprodcus01');
    expect(runbookContent).toContain('rg-stor-site-prod-cus');
    expect(runbookContent).toContain('cosmos-export');
    expect(runbookContent).toContain('expire-cosmos-export');
    expect(runbookContent).toContain('35 days');
    expect(runbookContent).not.toContain('sthcwprodbackupscus');
  });

  it('references speakerevents container for ambassador blob attachments', () => {
    expect(runbookContent).toContain('speakerevents');
  });

  it('clarifies that public submissions in content do not accept or store emails', () => {
    expect(runbookContent).toMatch(/anonymous/i);
    expect(runbookContent).toContain('functions/src/lib/submissions.js');
  });

  it('records a verified, reproducible exercise record with real commands', () => {
    expect(runbookContent).toContain('**PASS.**');
    expect(runbookContent).not.toContain('UNVERIFIED');
    expect(runbookContent).toContain('scripts/data-subject-search.mjs');
    expect(runbookContent).toContain('az storage account management-policy show');
  });
});
