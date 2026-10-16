import { describe, it, expect } from 'vitest';
import {
  DEFAULT_PARTITION_KEY,
  CONTAINER_TTL_SECONDS,
  COLLECTIONS,
  MIGRATED_DISPOSITIONS,
  PROVISIONED_DISPOSITIONS,
  flattenManifest,
  provisionedContainers,
  knownCollectionIds,
  findCollection,
} from './migration-manifest.mjs';

describe('migration-manifest contract (QA-2 #977)', () => {
  it('defines the standard default partition key', () => {
    expect(DEFAULT_PARTITION_KEY).toBe('/id');
  });

  it('declares valid TTL settings for expiring containers', () => {
    expect(CONTAINER_TTL_SECONDS).toBeDefined();
    for (const [container, ttl] of Object.entries(CONTAINER_TTL_SECONDS)) {
      expect(typeof container).toBe('string');
      expect(typeof ttl).toBe('number');
      expect(ttl).toBeGreaterThan(0);
    }
  });

  it('defines expected disposition sets', () => {
    expect(MIGRATED_DISPOSITIONS.has('migrate')).toBe(true);
    expect(MIGRATED_DISPOSITIONS.has('probe')).toBe(false);

    expect(PROVISIONED_DISPOSITIONS.has('migrate')).toBe(true);
    expect(PROVISIONED_DISPOSITIONS.has('reseed')).toBe(true);
    expect(PROVISIONED_DISPOSITIONS.has('regenerate')).toBe(true);
    expect(PROVISIONED_DISPOSITIONS.has('transient')).toBe(true);
    expect(PROVISIONED_DISPOSITIONS.has('azure-only')).toBe(true);
    expect(PROVISIONED_DISPOSITIONS.has('probe')).toBe(false);
  });

  it('contains valid collections metadata', () => {
    expect(Array.isArray(COLLECTIONS)).toBe(true);
    expect(COLLECTIONS.length).toBeGreaterThan(50);

    const names = new Set();
    for (const col of COLLECTIONS) {
      expect(typeof col.name).toBe('string');
      expect(typeof col.disposition).toBe('string');
      expect(names.has(col.name)).toBe(false);
      names.add(col.name);

      if (col.subcollections) {
        expect(Array.isArray(col.subcollections)).toBe(true);
        for (const sub of col.subcollections) {
          expect(typeof sub.name).toBe('string');
          expect(typeof sub.container).toBe('string');
        }
      }
    }
  });

  describe('flattenManifest', () => {
    it('flattens only migrated collections by default', () => {
      const flattened = flattenManifest();
      expect(flattened.length).toBeGreaterThan(0);
      for (const item of flattened) {
        expect(item.disposition).toBe('migrate');
        expect(item.partitionKey).toBeDefined();
      }
    });

    it('includes non-migrated collections when requested', () => {
      const all = flattenManifest({ includeNonMigrated: true });
      const migratedOnly = flattenManifest({ includeNonMigrated: false });
      expect(all.length).toBeGreaterThan(migratedOnly.length);

      const hasSubcollection = all.some((item) => item.isSubcollection);
      expect(hasSubcollection).toBe(true);
    });
  });

  describe('provisionedContainers', () => {
    it('returns a sorted list of unique containers to provision', () => {
      const list = provisionedContainers();
      expect(Array.isArray(list)).toBe(true);
      expect(list.length).toBeGreaterThan(40);

      // Verify sorted order
      const copy = [...list].sort();
      expect(list).toEqual(copy);

      // Verify each is a non-empty string
      for (const name of list) {
        expect(typeof name).toBe('string');
        expect(name.length).toBeGreaterThan(0);
      }
    });
  });

  describe('knownCollectionIds', () => {
    it('returns a set of all known collections including subcollections', () => {
      const ids = knownCollectionIds();
      expect(ids instanceof Set).toBe(true);
      expect(ids.size).toBeGreaterThan(50);
      expect(ids.has('content')).toBe(true);
      expect(ids.has('admin_config')).toBe(true);
    });
  });

  describe('findCollection', () => {
    it('finds existing top-level collections', () => {
      const content = findCollection('content');
      expect(content).not.toBeNull();
      expect(content?.name).toBe('content');
      expect(content?.disposition).toBe('migrate');

      const adminConfig = findCollection('admin_config');
      expect(adminConfig).not.toBeNull();
      expect(adminConfig?.name).toBe('admin_config');
    });

    it('returns null for unknown collections', () => {
      expect(findCollection('non_existent_collection_xyz')).toBeNull();
      expect(findCollection('')).toBeNull();
    });
  });
});
