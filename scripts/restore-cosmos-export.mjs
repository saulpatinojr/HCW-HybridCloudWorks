/**
 * restore-cosmos-export.mjs — restore the Cosmos out-of-account export into a
 * target account (ADR 0028 §6, issue #231; runbook docs/runbooks/cosmos-restore.md).
 *
 * Reads the latest complete full export and every complete delta after it
 * from the `cosmos-export` blob container, and upserts every document into
 * the target database, container by container, full first, deltas in date
 * order. `--dry-run` reads the same blobs and only counts.
 *
 * Both clients authenticate with DefaultAzureCredential — `az login` on a
 * workstation. The signed-in identity needs Storage Blob Data Reader on the
 * export container and Cosmos DB Built-in Data Contributor on the TARGET
 * account. It never needs anything on the production Cosmos account: the
 * restore reads blobs, not the source.
 *
 * Output is the report: one row per container with the documents in the full,
 * in the deltas, the distinct ids written, and the elapsed time; a final
 * total. With `--verify` each target container is counted after the write and
 * the count printed beside the expected distinct total.
 *
 * Usage:
 *   node scripts/restore-cosmos-export.mjs --storage-account stsiteprodcus01 --dry-run
 *   node scripts/restore-cosmos-export.mjs --storage-account stsiteprodcus01 --target-endpoint https://cosmos-site-sbx-cus.documents.azure.com:443/ --verify
 *
 * Options:
 *   --storage-account <name>    account holding the cosmos-export container (required)
 *   --target-endpoint <url>     Cosmos endpoint to write to (required unless --dry-run)
 *   --database <id>             target database (default hcw)
 *   --code-brain-database <id>  target database for the Code Conductor brain's
 *                               containers (default hcw_code_brain; never the
 *                               same as --database)
 *   --as-of <YYYY-MM-DD>        latest run to apply (default: everything complete)
 *   --containers <a,b,c>        restore only these (default: every container in the full)
 *   --concurrency <n>           upserts in flight per container (default 8, max 32)
 *   --dry-run                   read and count; write nothing
 *   --verify                    after writing, count each target container
 *   --allow-production-target   write to an account whose name has -prod- in it
 *   --help
 */
import { createInterface } from 'node:readline';
import { createGunzip } from 'node:zlib';
import { pathToFileURL } from 'node:url';

import { parseArgs, splitList } from './lib/cli.mjs';
import {
  selectRestoreSet,
  restoreLayers,
  containersToRestore,
  assertManifest,
  layersCarrying,
  verifyTargetCount,
  dataBlobName,
  manifestBlobName,
  parseLine,
  assertLayerBlobPresent,
  requireBody,
  createRestoreTally,
  formatRow,
  parseConcurrency,
  forEachConcurrent,
  CODE_BRAIN_DATABASE,
  targetDatabaseFor,
  sameDatabase,
} from './lib/cosmos-export-restore.mjs';

export const EXPORT_CONTAINER = 'cosmos-export';

const HELP = `Usage: node scripts/restore-cosmos-export.mjs --storage-account <name> [--target-endpoint <url>] [options]

  --storage-account <name>    account holding the cosmos-export container (required)
  --target-endpoint <url>     Cosmos endpoint to write to (required unless --dry-run)
  --database <id>             target database (default hcw)
  --code-brain-database <id>  target database for code_brain_records
                              (default hcw_code_brain; must differ from --database)
  --as-of <YYYY-MM-DD>        latest run to apply (default: everything complete)
  --containers <a,b,c>        restore only these containers
  --concurrency <n>           upserts in flight per container (default 8, max 32)
  --dry-run                   read and count; write nothing
  --verify                    after writing, count each target container
  --allow-production-target   write to an account whose name has -prod- in it
                              (a real restore into a new account; never a drill)
  --help

Authenticates with DefaultAzureCredential (az login). Needs Storage Blob Data
Reader on the cosmos-export container and, unless --dry-run, Cosmos DB
Built-in Data Contributor on the TARGET account. Never touches the source.
`;

/** Parse argv into the options the run needs. Throws on anything malformed. */
export function parseOptions(argv) {
  const { flags, options } = parseArgs(argv, {
    flags: ['dry-run', 'verify', 'allow-production-target', 'help'],
    options: [
      'storage-account',
      'target-endpoint',
      'database',
      'code-brain-database',
      'as-of',
      'containers',
      'concurrency',
    ],
  });
  if (flags.help) return { help: true };
  const storageAccount = (options['storage-account'] || '').trim();
  if (!storageAccount) throw new Error('--storage-account is required');
  const targetEndpoint = (options['target-endpoint'] || '').trim();
  if (!flags['dry-run'] && !targetEndpoint) {
    throw new Error('--target-endpoint is required unless --dry-run');
  }
  if (targetEndpoint && !/^https:\/\//.test(targetEndpoint)) {
    throw new Error('--target-endpoint must be an https URL');
  }
  // A restore upserts backup documents over whatever the target holds, so a
  // production account as the target writes older copies over live ones. The
  // drill restores into a scratch account; a real restore goes into a new
  // account and says so with the flag (docs/runbooks/cosmos-restore.md).
  const targetAccount = targetEndpoint ? new URL(targetEndpoint).hostname.split('.')[0] : '';
  if (/-prod-/.test(targetAccount) && !flags['allow-production-target']) {
    throw new Error(
      `--target-endpoint names ${targetAccount}, a production account: a restore writes backup copies over what is there. ` +
        'A drill restores into a scratch account (cosmos-site-sbx-cus); a real restore into a new account adds --allow-production-target'
    );
  }
  // An absent --database means hcw; a present-but-blank one is a mistake to
  // name here, not an SDK error about a resource with no id later.
  const database = options.database === undefined ? 'hcw' : options.database.trim();
  if (!database) throw new Error('--database must name the target database (the default is hcw)');
  // The Code Conductor brain restores into its own database (#1457): pointing
  // both at one database would mix the two workspaces in the target.
  const codeBrainDatabase =
    options['code-brain-database'] === undefined ? CODE_BRAIN_DATABASE : options['code-brain-database'].trim();
  if (!codeBrainDatabase) {
    throw new Error(`--code-brain-database must name a database (the default is ${CODE_BRAIN_DATABASE})`);
  }
  if (sameDatabase(codeBrainDatabase, database)) {
    throw new Error('--code-brain-database must differ from --database: the Code Conductor brain has its own database');
  }
  return {
    help: false,
    storageAccount,
    targetEndpoint: targetEndpoint || null,
    database,
    codeBrainDatabase,
    // Trimmed like the other string options; selectRestoreSet validates the shape.
    asOf: options['as-of'] === undefined ? undefined : options['as-of'].trim(),
    containers: splitList(options.containers),
    concurrency: parseConcurrency(options.concurrency),
    dryRun: flags['dry-run'],
    verify: flags.verify,
  };
}

async function exportContainerClient(storageAccount) {
  const { BlobServiceClient } = await import('@azure/storage-blob');
  const { DefaultAzureCredential } = await import('@azure/identity');
  const service = new BlobServiceClient(
    `https://${storageAccount}.blob.core.windows.net`,
    new DefaultAzureCredential()
  );
  return service.getContainerClient(EXPORT_CONTAINER);
}

/** The target account's databases, opened through one client. */
async function targetDatabases(endpoint) {
  const { CosmosClient } = await import('@azure/cosmos');
  const { DefaultAzureCredential } = await import('@azure/identity');
  const client = new CosmosClient({ endpoint, aadCredentials: new DefaultAzureCredential() });
  return (database) => client.database(database);
}

async function listNames(container) {
  const names = [];
  for await (const blob of container.listBlobsFlat()) names.push(blob.name);
  return names;
}

async function readJson(container, name) {
  const res = await container.getBlobClient(name).download(0);
  const chunks = [];
  for await (const chunk of requireBody(res, name)) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** Stream one data blob as documents, one per non-empty line. */
async function* readDocuments(container, name) {
  const res = await container.getBlobClient(name).download(0);
  const lines = createInterface({
    input: requireBody(res, name).pipe(createGunzip()),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    if (line.trim()) yield parseLine(line);
  }
}

async function blobExists(container, name) {
  return container.getBlobClient(name).exists();
}

/** How many documents a target container holds. */
async function countDocuments(container) {
  const { resources } = await container.items.query('SELECT VALUE COUNT(1) FROM c').fetchAll();
  return Number(resources[0]) || 0;
}

/**
 * The restore, end to end: choose the set (the latest complete full and every
 * complete delta after it), check each layer's manifest, then for every
 * container apply the layers that carry it, in order, and with --verify count
 * the target. Returns the exit code: 0 done, 1 a container that failed its
 * count. A refusal (a missing or corrupted layer, a production target without
 * the flag) throws before anything is written.
 *
 * @param {string[]} [argv]
 * @param {{ log: (line: string) => void }} [out]
 * @returns {Promise<number>}
 */
export async function main(argv = process.argv.slice(2), out = console) {
  const opts = parseOptions(argv);
  if (opts.help) {
    out.log(HELP);
    return 0;
  }
  const startedAt = Date.now();
  const exportBlobs = await exportContainerClient(opts.storageAccount);
  const names = await listNames(exportBlobs);
  const set = selectRestoreSet(names, { asOf: opts.asOf });
  const layers = restoreLayers(set);
  // Every layer's manifest, because each says which containers that layer
  // carries: a delta lists fewer than the full (layersCarrying). Each is
  // checked before the target is opened (assertManifest).
  const manifests = new Map();
  for (const layer of layers) {
    const manifest = await readJson(exportBlobs, manifestBlobName(layer.mode, layer.runId));
    manifests.set(`${layer.mode}/${layer.runId}`, assertManifest(manifest, layer));
  }
  const fullManifest = manifests.get(`full/${set.full}`);
  const deltaManifests = layers.slice(1).map((layer) => manifests.get(`${layer.mode}/${layer.runId}`));
  const containers = containersToRestore(fullManifest, opts.containers, deltaManifests);

  out.log(
    `${opts.dryRun ? 'DRY RUN — counting' : 'Restoring'} full/${set.full} + ${set.deltas.length} delta(s)` +
      (set.deltas.length ? ` (${set.deltas[0]} … ${set.deltas[set.deltas.length - 1]})` : '') +
      ` — ${containers.length} container(s)` +
      (opts.dryRun ? '' : ` → ${opts.targetEndpoint} / ${opts.database} (Code Conductor brain: ${opts.codeBrainDatabase})`)
  );
  if (set.incompleteSkipped.length) {
    out.log(`Skipped incomplete runs (no manifest): ${set.incompleteSkipped.join(', ')}`);
  }

  const databaseOf = opts.dryRun ? null : await targetDatabases(opts.targetEndpoint);
  const widths = [32, 10, 10, 10, 10, 10, 10];
  out.log(
    formatRow(
      ['container', 'full', 'deltas', 'created', 'replaced', opts.verify ? 'target' : '', 'ms'],
      widths
    )
  );

  let totalDocuments = 0;
  let totalCreated = 0;
  let totalReplaced = 0;
  let mismatches = 0;
  for (const name of containers) {
    const t0 = Date.now();
    const target = databaseOf ? databaseOf(targetDatabaseFor(name, opts)).container(name) : null;
    const tally = createRestoreTally({ writes: Boolean(target) });
    // What the target already held, so --verify can expect that plus what this
    // run creates: an empty account on a first run, more on a rerun.
    const before = target && opts.verify ? await countDocuments(target) : 0;
    for (const layer of layersCarrying(name, layers, manifests)) {
      const layerName = `${layer.mode}/${layer.runId}`;
      const blob = dataBlobName(layer.mode, layer.runId, name);
      // Only the layers whose manifest lists this container, and a manifest is
      // written only once every listed container's marker is present, so a
      // missing data blob here is a corrupted or expired set, never an empty
      // container (those still have a blob). Loud, in --dry-run too.
      assertLayerBlobPresent(await blobExists(exportBlobs, blob), blob);
      tally.touch(layerName);
      if (target) {
        // Nothing per document is kept: the upsert's status code says whether
        // the id was new (201) or already restored by an earlier layer (200).
        await forEachConcurrent(readDocuments(exportBlobs, blob), opts.concurrency, async (doc) => {
          const { statusCode } = await target.items.upsert(doc);
          tally.add(layerName, statusCode);
        });
      } else {
        for await (const _doc of readDocuments(exportBlobs, blob)) tally.add(layerName);
      }
    }
    const counts = tally.result();
    const fullCount = counts.perLayer[`full/${set.full}`] ?? 0;
    const deltaCount = Object.entries(counts.perLayer)
      .filter(([layer]) => layer.startsWith('delta/'))
      .reduce((n, [, c]) => n + c, 0);
    let verified = '';
    if (target && opts.verify) {
      const check = verifyTargetCount({ before, created: counts.created, inTarget: await countDocuments(target) });
      verified = check.cell;
      if (!check.ok) mismatches += 1;
    }
    totalDocuments += counts.documents;
    totalCreated += counts.created ?? 0;
    totalReplaced += counts.replaced ?? 0;
    out.log(
      formatRow(
        [
          name,
          fullCount,
          deltaCount,
          counts.created ?? '',
          counts.replaced ?? '',
          verified,
          Date.now() - t0,
        ],
        widths
      )
    );
  }

  const elapsedMs = Date.now() - startedAt;
  const minutes = (elapsedMs / 60000).toFixed(1);
  if (opts.dryRun) {
    out.log(
      `Would restore ${totalDocuments} document(s) across ${containers.length} container(s) in ${elapsedMs} ms (${minutes} min) — distinct and overwritten counts come from the upsert responses and are computed only on a real run`
    );
  } else {
    out.log(
      `Restored ${totalDocuments} document(s): ${totalCreated} created, ${totalReplaced} replaced (already in the target, or superseded by a later layer), across ${containers.length} container(s) in ${elapsedMs} ms (${minutes} min)`
    );
  }
  if (mismatches) {
    out.log(
      `${mismatches} container(s) MISMATCH: the target does not hold what it held before this run plus what the run created — investigate before calling the drill passed`
    );
    return 1;
  }
  return 0;
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(err?.message || err);
      process.exit(2);
    }
  );
}
