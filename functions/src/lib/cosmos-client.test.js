import { describe, expect, it } from 'vitest';

import {
  PARTITION_KEY_PATHS,
  resolvePartitionKey,
  MAX_PATCH_OPERATIONS,
  applyFieldPath,
  bindConditionValues,
  planPatch,
  toJsonPointer,
  validateWhereClause,
  getDatabaseContainer,
} from './cosmos-client.js';

/**
 * These cover `patchDoc`'s decision rules, which exist because Cosmos cannot
 * express Firestore's `.update()` semantics directly:
 *
 *   - a patch specification is capped at ten operations
 *   - `remove` fails on an absent path, while Firestore's field delete is a
 *     no-op on a missing field
 *   - property names escape `~` and `/` per RFC 6902, per path segment
 *
 * Getting any of these wrong is silent. The old `upsertDoc` comment claimed
 * merge semantics for a full replace, and nothing in the suite noticed; this
 * file is the check that the replacement does not repeat it.
 */

describe('toJsonPointer', () => {
  it('converts a flat field', () => {
    expect(toJsonPointer('title')).toBe('/title');
  });

  it("converts Firestore's dotted nesting to pointer segments", () => {
    expect(toJsonPointer('meta.author.name')).toBe('/meta/author/name');
  });

  it('escapes ~ and / inside a property name, per RFC 6902', () => {
    expect(toJsonPointer('a~b')).toBe('/a~0b');
    expect(toJsonPointer('a/b')).toBe('/a~1b');
  });

  it('escapes a property name while dots still separate segments', () => {
    // Characterisation, not a guard: escape-then-split and split-then-escape
    // are equivalent here, because neither escape sequence introduces a '.'.
    // Checked by writing the "wrong" order and watching all 20 tests still
    // pass. Recorded so the next reader does not mistake this for an
    // ordering constraint that needs defending.
    expect(toJsonPointer('outer.in/ner')).toBe('/outer/in~1ner');
  });
});

describe('planPatch', () => {
  it('treats an empty update as a no-op rather than an empty patch', () => {
    expect(planPatch({}).strategy).toBe('noop');
    expect(planPatch(undefined).strategy).toBe('noop');
  });

  it('builds set operations for a small update', () => {
    const plan = planPatch({ title: 'x', 'meta.slug': 'y' });
    expect(plan.strategy).toBe('patch');
    expect(plan.operations).toEqual([
      { op: 'set', path: '/title', value: 'x' },
      { op: 'set', path: '/meta/slug', value: 'y' },
    ]);
  });

  it('patches at exactly the ten-operation ceiling', () => {
    const updates = Object.fromEntries(
      Array.from({ length: MAX_PATCH_OPERATIONS }, (_, i) => [`f${i}`, i])
    );
    expect(planPatch(updates).strategy).toBe('patch');
  });

  it('falls back to read-modify-write one operation past the ceiling', () => {
    // Cosmos rejects an 11-operation specification outright. Chunking would
    // drop atomicity silently, so the fallback is a guarded whole-document
    // write instead.
    const updates = Object.fromEntries(
      Array.from({ length: MAX_PATCH_OPERATIONS + 1 }, (_, i) => [`f${i}`, i])
    );
    const plan = planPatch(updates);
    expect(plan.strategy).toBe('rmw');
    expect(plan.reason).toBe('exceeds-operation-limit');
  });

  it('routes deletions through read-modify-write even when small', () => {
    // Cosmos `remove` errors with "Node(PATH) to be removed is absent";
    // Firestore's FieldValue.delete() on a missing field is a no-op. RMW keeps
    // the Firestore behaviour the 48 ported call sites rely on.
    const plan = planPatch({ draft: undefined });
    expect(plan.strategy).toBe('rmw');
    expect(plan.reason).toBe('deletion');
  });

  it('refuses to modify system properties', () => {
    for (const prop of ['id', '_etag', '_ts', '_rid']) {
      expect(() => planPatch({ [prop]: 'x' })).toThrow(/system property/);
    }
  });

  it('refuses a system property reached through a dotted path root', () => {
    expect(() => planPatch({ '_etag.nested': 'x' })).toThrow(/system property/);
  });

  it('allows a field that merely starts with an underscore', () => {
    expect(planPatch({ _draftNote: 'x' }).strategy).toBe('patch');
  });
});

describe('applyFieldPath', () => {
  it('sets a flat field', () => {
    const doc = { a: 1 };
    applyFieldPath(doc, ['b'], 2);
    expect(doc).toEqual({ a: 1, b: 2 });
  });

  it('leaves sibling fields untouched — the whole point of a partial write', () => {
    const doc = { keep: 'me', change: 'old' };
    applyFieldPath(doc, ['change'], 'new');
    expect(doc).toEqual({ keep: 'me', change: 'new' });
  });

  it('creates intermediate objects', () => {
    const doc = {};
    applyFieldPath(doc, ['meta', 'author', 'name'], 'Ada');
    expect(doc).toEqual({ meta: { author: { name: 'Ada' } } });
  });

  it('replaces a non-object intermediate rather than throwing', () => {
    const doc = { meta: 'scalar' };
    applyFieldPath(doc, ['meta', 'slug'], 'x');
    expect(doc).toEqual({ meta: { slug: 'x' } });
  });

  it('replaces a null intermediate', () => {
    // typeof null === 'object', so a null check has to be explicit or this
    // throws on property assignment.
    const doc = { meta: null };
    applyFieldPath(doc, ['meta', 'slug'], 'x');
    expect(doc).toEqual({ meta: { slug: 'x' } });
  });

  it('deletes on undefined', () => {
    const doc = { a: 1, b: 2 };
    applyFieldPath(doc, ['b'], undefined);
    expect(doc).toEqual({ a: 1 });
    expect('b' in doc).toBe(false);
  });

  it('deleting an absent field is a no-op, matching Firestore', () => {
    const doc = { a: 1 };
    expect(() => applyFieldPath(doc, ['nope'], undefined)).not.toThrow();
    expect(doc).toEqual({ a: 1 });
  });

  it('preserves null as a value rather than treating it as a delete', () => {
    const doc = { a: 1 };
    applyFieldPath(doc, ['a'], null);
    expect(doc).toEqual({ a: null });
  });
});

describe('partition keys (T-312, T-313)', () => {
  it('stays in step with the migration manifest', async () => {
    // infra/cosmos-containers.json is the source of truth. Adding a fifth
    // non-/id container there without adding it here would reintroduce the
    // silent-null trap, so this fails CI instead.
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const manifest = JSON.parse(
      readFileSync(
        fileURLToPath(new URL('../../../infra/cosmos-containers.json', import.meta.url)),
        'utf8'
      )
    );
    const fromManifest = Object.fromEntries(
      manifest.containers
        .filter((c) => c.partition_key_path !== '/id')
        .map((c) => [c.name, c.partition_key_path])
    );
    expect({ ...PARTITION_KEY_PATHS }).toEqual(fromManifest);
  });

  it('defaults to the document id for an /id container', () => {
    expect(resolvePartitionKey('content', undefined, 'doc-1')).toBe('doc-1');
  });

  it('throws rather than guessing for a non-/id container', () => {
    // Guessing produces a point read against the wrong logical partition,
    // which returns nothing — and readDoc maps that to null. A loud throw is
    // recoverable; a permanent null is not.
    expect(() => resolvePartitionKey('content_versions', undefined, 'v1')).toThrow(/contentId/);
    expect(() => resolvePartitionKey('image_prompt_sets_prompts', undefined, 'p1')).toThrow(
      /setName/
    );
    expect(() => resolvePartitionKey('image_prompts_sets', undefined, 's1')).toThrow(/pageId/);
    expect(() => resolvePartitionKey('listen_and_learn_episodes', undefined, 'e1')).toThrow(
      /setId/
    );
  });

  it('accepts an explicit key for those containers', () => {
    expect(resolvePartitionKey('content_versions', 'content-7', 'v1')).toBe('content-7');
  });

  it('accepts an explicit key that happens to be empty', () => {
    // '' is a legitimate partition key value and must not fall through to the
    // id default — the manifest records that /contentId was written as the
    // empty string on every legacy document.
    expect(resolvePartitionKey('content_versions', '', 'v1')).toBe('');
  });
});

/**
 * `incrementIf`'s predicate is a raw SQL fragment — neither the Cosmos REST API
 * nor the SDK offers parameter binding for it, so this substitution is the only
 * thing standing between a condition and SQL injection. It is separated from
 * the network call precisely so it can be tested without a Cosmos account: a
 * safety property that only runs against live infrastructure is a safety
 * property that does not run.
 */
describe('bindConditionValues', () => {
  it('substitutes numeric placeholders', () => {
    expect(
      bindConditionValues('FROM c WHERE c.windowStartMs > @floor AND c.count < @limit', {
        floor: 1000,
        limit: 5,
      })
    ).toBe('FROM c WHERE c.windowStartMs > 1000 AND c.count < 5');
  });

  it('substitutes every occurrence of a placeholder', () => {
    expect(bindConditionValues('FROM c WHERE c.a > @n OR c.b > @n', { n: 3 })).toBe(
      'FROM c WHERE c.a > 3 OR c.b > 3'
    );
  });

  it('accepts zero and negatives rather than treating them as missing', () => {
    expect(bindConditionValues('FROM c WHERE c.n > @a AND c.m > @b', { a: 0, b: -1 })).toBe(
      'FROM c WHERE c.n > 0 AND c.m > -1'
    );
  });

  it('refuses a string, rather than quoting it', () => {
    // Quoting is where interpolation into SQL goes wrong. Nothing in this
    // repository needs a string binding, so the safe answer is to refuse until
    // something does and can argue for it.
    expect(() => bindConditionValues('FROM c WHERE c.id = @id', { id: "x' OR '1'='1" })).toThrow(
      /finite number/
    );
  });

  it('refuses NaN and Infinity', () => {
    // `Number(undefined)` and a divide-by-zero both arrive here looking numeric
    // and would interpolate as bare `NaN`/`Infinity` tokens.
    expect(() => bindConditionValues('FROM c WHERE c.n < @n', { n: NaN })).toThrow(/finite/);
    expect(() => bindConditionValues('FROM c WHERE c.n < @n', { n: Infinity })).toThrow(/finite/);
  });

  it('refuses a placeholder with no value instead of leaving it in the SQL', () => {
    expect(() => bindConditionValues('FROM c WHERE c.n < @limit', {})).toThrow(/no value/);
    expect(() => bindConditionValues('FROM c WHERE c.n < @limit')).toThrow(/no value/);
  });

  it('refuses an empty or absent condition', () => {
    // An empty predicate would make the patch unconditional — the exact defect
    // the primitive exists to prevent, arriving silently.
    expect(() => bindConditionValues('', { a: 1 })).toThrow(/required/);
    expect(() => bindConditionValues('   ', { a: 1 })).toThrow(/required/);
    expect(() => bindConditionValues(undefined, { a: 1 })).toThrow(/required/);
  });
});

describe('validateWhereClause (countDocs SQL injection defense)', () => {
  it('returns empty string for null, undefined, or empty string', () => {
    expect(validateWhereClause(null)).toBe('');
    expect(validateWhereClause(undefined)).toBe('');
    expect(validateWhereClause('')).toBe('');
    expect(validateWhereClause('   ')).toBe('');
  });

  it('allows safe where expressions', () => {
    expect(validateWhereClause('c.status = @status')).toBe('c.status = @status');
    expect(validateWhereClause('c.count > 0 AND c.type = @type')).toBe('c.count > 0 AND c.type = @type');
  });

  it('refuses statements containing semicolons', () => {
    expect(() => validateWhereClause('c.id = 1; DROP TABLE c')).toThrow(/illegal or unsafe/);
  });

  it('refuses SQL comment indicators', () => {
    expect(() => validateWhereClause('c.id = 1 -- comment')).toThrow(/illegal or unsafe/);
    expect(() => validateWhereClause('c.id = 1 /* comment */')).toThrow(/illegal or unsafe/);
  });

  it('refuses UNION attempts', () => {
    expect(() => validateWhereClause('1=1 UNION SELECT * FROM secret')).toThrow(/illegal or unsafe/);
    expect(() => validateWhereClause('1=1 UNION ALL SELECT * FROM secret')).toThrow(/illegal or unsafe/);
  });
});

describe('getDatabaseContainer (#1457)', () => {
  it('refuses COSMOS_DATABASE and a blank name before any client is made', () => {
    const saved = process.env.COSMOS_DATABASE;
    try {
      delete process.env.COSMOS_DATABASE;
      for (const spelling of ['hcw', 'HCW', ' hcw', 'Hcw ']) {
        expect(() => getDatabaseContainer(spelling, 'code_brain_records'), spelling).toThrow(/separate database/);
      }
      process.env.COSMOS_DATABASE = 'drill';
      expect(() => getDatabaseContainer('drill', 'code_brain_records')).toThrow(/separate database/);
      expect(() => getDatabaseContainer(' DRILL', 'code_brain_records')).toThrow(/separate database/);
      expect(() => getDatabaseContainer('  ', 'code_brain_records')).toThrow(/database id is required/);
      expect(() => getDatabaseContainer(undefined, 'code_brain_records')).toThrow(/database id is required/);
    } finally {
      if (saved === undefined) delete process.env.COSMOS_DATABASE;
      else process.env.COSMOS_DATABASE = saved;
    }
  });
});
