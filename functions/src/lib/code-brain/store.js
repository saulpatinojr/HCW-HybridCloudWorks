/**
 * The Code Conductor brain's storage: the few operations its repository
 * needs, bound to its own database and its one container (#1457).
 *
 * Narrower than cosmos-client.js on purpose. It reaches one container,
 * `code_brain_records`, in the database CODE_BRAIN_COSMOS_DATABASE names,
 * and refuses every other container name. Every point read, query and write
 * names an owner partition: there is no cross-partition query and no write
 * without an `ownerId`, so one owner's records cannot be read by a request
 * scoped to another, even inside this database.
 */
import { getDatabaseContainer } from '../cosmos-client.js';
import { refuseWriteAfterJobAbort } from '../job-context.js';
import { createCosmosBatch } from '../brain/repository.js';
import { CODE_RECORDS } from './config.js';

/**
 * @param {object} options
 * @param {string} options.database - from codeBrainConfig; empty means not configured
 * @param {(database: string, container: string) => object} [options.getContainer]
 */
export function createCodeBrainStore({
  database,
  getContainer = getDatabaseContainer,
}) {
  const container = (name) => {
    if (name !== CODE_RECORDS)
      throw new Error(`The Code Conductor brain stores only ${CODE_RECORDS}`);
    if (!database)
      throw new Error('The Code Conductor brain has no database configured');
    return getContainer(database, name);
  };
  const owner = (value, what) => {
    if (typeof value !== 'string' || !value)
      throw new Error(`${what} must name an owner partition`);
    return value;
  };
  const feed = (options = {}) => ({
    partitionKey: owner(options.partitionKey, 'A Code Conductor brain query'),
    maxItemCount: options.maxItemCount || options.limit || 50,
    ...(options.continuationToken && {
      continuationToken: options.continuationToken,
    }),
  });

  return {
    async readDoc(name, id, partitionKey) {
      const target = container(name);
      try {
        const { resource } = await target
          .item(id, owner(partitionKey, 'A Code Conductor brain read'))
          .read();
        return resource || null;
      } catch (error) {
        if (error.code === 404) return null;
        throw error;
      }
    },
    async queryDocs(name, query, parameters = [], options = {}) {
      const { resources } = await container(name)
        .items.query({ query, parameters }, feed(options))
        .fetchAll();
      return resources;
    },
    async queryDocsPage(name, query, parameters = [], options = {}) {
      const response = await container(name)
        .items.query({ query, parameters }, feed(options))
        .fetchNext();
      return {
        resources: response.resources || [],
        continuationToken: response.continuationToken || null,
        hasMoreResults: response.hasMoreResults ?? false,
      };
    },
    async upsertDoc(name, document) {
      const target = container(name);
      owner(document?.ownerId, 'A Code Conductor brain write');
      refuseWriteAfterJobAbort(name);
      const { resource } = await target.items.upsert(document);
      return resource;
    },
    async createDoc(name, document) {
      const target = container(name);
      owner(document?.ownerId, 'A Code Conductor brain write');
      refuseWriteAfterJobAbort(name);
      const { resource } = await target.items.create(document);
      return resource;
    },
    batch: createCosmosBatch(() => {
      refuseWriteAfterJobAbort(CODE_RECORDS);
      return container(CODE_RECORDS);
    }),
  };
}
