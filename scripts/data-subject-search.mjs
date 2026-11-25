#!/usr/bin/env node
/**
 * scripts/data-subject-search.mjs — Search Cosmos DB containers (ambassador, etc.)
 * for data-subject personal data and referenced file/image attachments (#1237).
 *
 * Runs data-subject inquiries under GDPR Art. 15 and CCPA/CPRA across the
 * HybridCloudWorks estate.
 *
 * Usage:
 *   node scripts/data-subject-search.mjs --email user@example.com
 *   node scripts/data-subject-search.mjs --search "Jane Doe" --account cosmos-site-prod-cus
 *   node scripts/data-subject-search.mjs --help
 */

import process from 'node:process';
import { parseArgs } from 'node:util';

export const DEFAULT_COSMOS_ACCOUNT = 'cosmos-site-prod-cus';
export const DEFAULT_DATABASE = 'hcw';
export const DEFAULT_BLOB_ACCOUNT = 'stsiteprodcus01';
export const DEFAULT_ATTACHMENT_CONTAINER = 'speakerevents';

/**
 * Recursively inspect an object/array to find any text field containing query.
 *
 * @param {unknown} value
 * @param {string} query
 * @param {string} [prefix='']
 * @returns {Array<{ path: string, snippet: string }>}
 */
export function searchRecordFields(value, query, prefix = '') {
  if (!value || !query) return [];
  if (typeof value === 'string') return stringMatch(value, query, prefix);
  return childEntries(value, prefix).flatMap(([childPath, child]) => searchRecordFields(child, query, childPath));
}

/** A string that contains the query, as one match with about 40 characters either side; none when it does not. */
function stringMatch(value, query, prefix) {
  const q = query.toLowerCase();
  const idx = value.toLowerCase().indexOf(q);
  if (idx === -1) return [];
  const start = Math.max(0, idx - 40);
  const end = Math.min(value.length, idx + q.length + 40);
  const snippet = (start > 0 ? '...' : '') + value.slice(start, end).trim() + (end < value.length ? '...' : '');
  return [{ path: prefix, snippet }];
}

/** The items of a list or the fields of an object, each with its path; none for anything else. */
function childEntries(value, prefix) {
  if (Array.isArray(value)) {
    return value.map((item, index) => [prefix ? `${prefix}[${index}]` : `[${index}]`, item]);
  }
  if (typeof value === 'object') {
    return Object.entries(value).map(([key, val]) => [prefix ? `${prefix}.${key}` : key, val]);
  }
  return [];
}

/**
 * Extract file and image attachments from an ambassador document.
 *
 * @param {Record<string, any>} doc
 * @returns {Array<{ docId: string, docType: string, kind: 'file' | 'image', name: string, container: string | null, path: string | null, url: string | null }>}
 */
export function extractDocAttachments(doc) {
  if (!doc || typeof doc !== 'object') return [];
  const attachments = [];
  const docId = String(doc.id || 'unknown');
  const docType = String(doc.type || 'unknown');

  for (const [kind, list] of [
    ['file', doc.files],
    ['image', doc.images],
  ]) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const attachment = attachmentOf(item);
      if (attachment) attachments.push({ docId, docType, kind, ...attachment });
    }
  }

  return attachments;
}

/** Where the container is not named, a stored path lives in DEFAULT_ATTACHMENT_CONTAINER. */
function containerOf(item) {
  if (item.container) return String(item.container);
  return item.path ? DEFAULT_ATTACHMENT_CONTAINER : null;
}

/** One entry of `files` or `images` as `{ name, container, path, url }`, or null when it names no path or URL. */
function attachmentOf(item) {
  if (!item || typeof item !== 'object') return null;
  const path = item.path ? String(item.path) : null;
  const url = item.url ? String(item.url) : null;
  if (!path && !url) return null;
  const name = String(item.name || item.path || item.url || 'unnamed');
  return { name, container: containerOf(item), path, url };
}

/**
 * Evaluate a collection of documents against a search query.
 *
 * @param {Array<Record<string, any>>} docs
 * @param {string} query
 * @returns {{ matches: Array<{ docId: string, docType: string, hits: Array<{ path: string, snippet: string }> }>, attachments: Array<any> }}
 */
export function scanDocuments(docs, query) {
  const matches = [];
  const attachments = [];

  for (const doc of docs) {
    if (!doc || typeof doc !== 'object') continue;
    const docId = String(doc.id || 'unknown');
    const docType = String(doc.type || 'unknown');

    const hits = searchRecordFields(doc, query);
    if (hits.length > 0) {
      matches.push({ docId, docType, hits });
    }

    attachments.push(...extractDocAttachments(doc));
  }

  return { matches, attachments };
}

/**
 * Parse CLI arguments.
 */
export function parseCommandLineArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      email: { type: 'string', short: 'e' },
      search: { type: 'string', short: 's' },
      account: { type: 'string', default: DEFAULT_COSMOS_ACCOUNT },
      database: { type: 'string', default: DEFAULT_DATABASE },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: false,
  });

  return values;
}

const HELP_TEXT = `Usage: node scripts/data-subject-search.mjs [options]

Searches Cosmos DB containers for personal data and lists referenced blob/URL attachments.

Options:
  -e, --email <email>     Search for email address across documents
  -s, --search <term>     Search for arbitrary string (name, ID, etc.)
  --account <name>        Cosmos DB account name (default: cosmos-site-prod-cus)
  --database <name>       Cosmos DB database name (default: hcw)
  -h, --help              Show this help message
`;

export async function main(argv = process.argv.slice(2)) {
  const args = parseCommandLineArgs(argv);

  if (args.help) {
    console.log(HELP_TEXT);
    return 0;
  }

  const query = args.email || args.search;
  if (!query) {
    console.error('Error: specify --email or --search query.\n\n' + HELP_TEXT);
    return 1;
  }

  console.log(`Searching Cosmos DB [${args.account}/${args.database}] for: "${query}"...`);

  // Dynamically load azure dependencies when connecting live
  const { CosmosClient } = await import('@azure/cosmos');
  const { DefaultAzureCredential } = await import('@azure/identity');

  const endpoint = `https://${args.account}.documents.azure.com:443/`;
  const client = new CosmosClient({ endpoint, aadCredentials: new DefaultAzureCredential() });
  const database = client.database(args.database);

  console.log('--- Searching container: ambassador ---');
  const ambassadorContainer = database.container('ambassador');
  const { resources: ambassadorDocs } = await ambassadorContainer.items.readAll().fetchAll();
  const ambassadorResults = scanDocuments(ambassadorDocs, query);

  console.log(`Ambassador documents scanned: ${ambassadorDocs.length}`);
  console.log(`Matching documents: ${ambassadorResults.matches.length}`);
  for (const m of ambassadorResults.matches) {
    console.log(`  Document ID: ${m.docId} (type: ${m.docType})`);
    for (const h of m.hits) {
      console.log(`    - Field: ${h.path} -> "${h.snippet}"`);
    }
  }

  console.log(`\nReferenced attachments in ambassador (${ambassadorResults.attachments.length} total):`);
  for (const att of ambassadorResults.attachments) {
    const loc = att.path ? `blob: ${att.container}/${att.path}` : `url: ${att.url}`;
    console.log(`  [${att.kind}] ${att.name} (in doc ${att.docId}) -> ${loc}`);
  }

  console.log('\n--- Searching container: content (Public Submissions) ---');
  const contentContainer = database.container('content');
  const querySpec = {
    query: 'SELECT c.id, c.type, c.title, c.storageCollection FROM c WHERE CONTAINS(LOWER(c.title), @q) OR CONTAINS(LOWER(c.summary), @q)',
    parameters: [{ name: '@q', value: query.toLowerCase() }],
  };
  const { resources: contentDocs } = await contentContainer.items.query(querySpec).fetchAll();
  console.log(`Content matching items: ${contentDocs.length}`);
  for (const c of contentDocs) {
    console.log(`  Content ID: ${c.id} (type: ${c.type}) title: "${c.title}"`);
  }

  return 0;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  main().then(
    (code) => process.exit(code ?? 0),
    (err) => {
      console.error(err);
      process.exit(1);
    }
  );
}
