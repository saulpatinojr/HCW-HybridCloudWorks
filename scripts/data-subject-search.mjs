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
  const q = query.toLowerCase();
  const matches = [];

  if (typeof value === 'string') {
    if (value.toLowerCase().includes(q)) {
      const idx = value.toLowerCase().indexOf(q);
      const start = Math.max(0, idx - 40);
      const end = Math.min(value.length, idx + q.length + 40);
      const snippet = (start > 0 ? '...' : '') + value.slice(start, end).trim() + (end < value.length ? '...' : '');
      matches.push({ path: prefix, snippet });
    }
    return matches;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      matches.push(...searchRecordFields(item, query, prefix ? `${prefix}[${index}]` : `[${index}]`));
    });
    return matches;
  }

  if (typeof value === 'object') {
    for (const [key, val] of Object.entries(value)) {
      const childPath = prefix ? `${prefix}.${key}` : key;
      matches.push(...searchRecordFields(val, query, childPath));
    }
  }

  return matches;
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
    if (Array.isArray(list)) {
      for (const item of list) {
        if (!item || typeof item !== 'object') continue;
        const name = String(item.name || item.path || item.url || 'unnamed');
        const container = item.container ? String(item.container) : item.path ? DEFAULT_ATTACHMENT_CONTAINER : null;
        const path = item.path ? String(item.path) : null;
        const url = item.url ? String(item.url) : null;
        if (path || url) {
          attachments.push({ docId, docType, kind, name, container, path, url });
        }
      }
    }
  }

  return attachments;
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

    const docAttachments = extractDocAttachments(doc);
    if (docAttachments.length > 0) {
      attachments.push(...docAttachments);
    }
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
