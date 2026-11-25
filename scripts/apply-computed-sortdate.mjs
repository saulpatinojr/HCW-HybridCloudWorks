#!/usr/bin/env node
/**
 * T-206 — check that the public content list can ORDER BY cp_sortDate safely.
 *
 * The published date lives under five aliases, so a plain ORDER BY silently
 * drops any document missing the chosen field (public-reads.js rule 2). The
 * fix is a Cosmos COMPUTED PROPERTY, `cp_sortDate`: evaluated server-side on
 * every document, defined on every document (it falls back to '' when no alias
 * is present), and indexable — so `ORDER BY c.cp_sortDate DESC` makes the
 * TOP window return the NEWEST N documents instead of an arbitrary N, with no
 * backfill and no write-site maintenance.
 *
 * THE APPLY WRITES THE PROPERTY (#816). infra/cosmos.tf puts cp_sortDate on
 * `content` and `blogs` in the same apply that could wipe it
 * (azapi_update_resource.cosmos_computed_properties), from the definition in
 * lib/cosmos-sort-date.mjs, and fails the run if a container lacks it. The
 * `--apply` path this script had, and the six-hourly workflow that ran it,
 * were deleted in #816's second pull request. The file keeps its name so the
 * references to `apply-computed-sortdate.mjs --inspect` stay true.
 *
 * What is left is the one check the apply cannot make, because it is about
 * the DATA rather than the container:
 *
 *   `--inspect`  Sample every date alias in `content` and `blogs` and report
 *                non-ISO values. cp_sortDate sorts ISO-8601 strings
 *                lexicographically = chronologically; a container holding
 *                non-ISO date strings would mis-sort, and only the live data
 *                can say whether any exist. It is the precondition for
 *                PUBLIC_LIST_SQL_ORDER=1 (infra/functionapp.tf), and the first
 *                thing to run if the list ever comes back mis-ordered.
 *
 * Run locally after `az login`. Needs COSMOS_ENDPOINT (+ optional
 * COSMOS_DATABASE), a data-plane read on both containers, and an operator
 * window through `cosmos_admin_ip_rules` (ADR 0025).
 */

import process from 'node:process';
import { pathToFileURL } from 'node:url';

// The definition lives in lib/cosmos-sort-date.mjs since #816, shared with the
// spec generator that puts it in front of Terraform. Re-exported so this
// script's tests and callers keep their imports.
import { COMPUTED_PROPERTY, SORT_DATE_CONTAINERS, sortDateQuery } from './lib/cosmos-sort-date.mjs';

export { COMPUTED_PROPERTY, sortDateQuery };

const CONTAINERS = SORT_DATE_CONTAINERS;

/** ISO-8601-enough for lexicographic order: YYYY-MM-DD prefix. */
export const isSortableIso = (value) =>
  typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value);

async function getClient() {
  const endpoint = process.env.COSMOS_ENDPOINT;
  if (!endpoint) throw new Error('COSMOS_ENDPOINT is not set');
  const { CosmosClient } = await import('@azure/cosmos');
  const { DefaultAzureCredential } = await import('@azure/identity');
  const client = new CosmosClient({ endpoint, aadCredentials: new DefaultAzureCredential() });
  return client.database(process.env.COSMOS_DATABASE || 'hcw');
}

async function inspect() {
  const db = await getClient();
  let dirty = 0;
  for (const name of CONTAINERS) {
    console.log(`\n== ${name}`);
    const container = db.container(name);
    // One pass, projecting only the aliases: cheap even on serverless.
    const { resources } = await container.items
      .query(
        'SELECT c.id, c.publishedDate, c.datePublished, c["Published At"] AS publishedAtSpaced, c.blogPublishedAt, c.publishedAt FROM c'
      )
      .fetchAll();
    console.log(`  ${resources.length} documents`);
    const bad = resources.flatMap(nonIsoDates);
    dirty += bad.length;
    reportNonIso(bad);
  }
  process.exit(dirty ? 1 : 0);
}

/** The date aliases of one document that are present and not ISO-sortable. */
function nonIsoDates(doc) {
  return Object.entries(doc)
    .filter(([field, value]) => field !== 'id' && value !== undefined && value !== null && !isSortableIso(value))
    .map(([field, value]) => ({ id: doc.id, field, value }));
}

/** One container's verdict: all sortable, or the first 20 values that are not. */
function reportNonIso(bad) {
  if (bad.length === 0) {
    console.log('  every present date alias is ISO-sortable');
    return;
  }
  console.log(`  ${bad.length} NON-ISO date values — these mis-sort under ORDER BY cp_sortDate:`);
  for (const entry of bad.slice(0, 20)) {
    console.log(`    ${entry.id} ${entry.field} = ${JSON.stringify(entry.value)}`);
  }
  if (bad.length > 20) console.log(`    ... and ${bad.length - 20} more`);
}

const HELP = `Usage: node apply-computed-sortdate.mjs --inspect

  --inspect   report non-ISO date values in content/blogs; exits 1 if any
              exist, since they would mis-sort under ORDER BY cp_sortDate

Needs COSMOS_ENDPOINT (+ COSMOS_DATABASE) and a data-plane read on both
containers. The cp_sortDate property itself is written by the Terraform
apply (azapi_update_resource.cosmos_computed_properties, #816).
`;

// pathToFileURL, not `file://${argv[1]}`: on Windows argv[1] is `C:\...`, which
// never string-matches import.meta.url, so the script would exit 0 having run
// nothing. Same fix as check-deploy-drift.mjs.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const mode = process.argv[2];
  if (mode !== '--inspect') {
    console.log(HELP);
    process.exit(mode === '--help' || mode === '-h' ? 0 : 2);
  }
  inspect().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
