/**
 * The archive classification (ADR 0046 section 2) against the list of
 * database containers Terraform creates, and every rule that takes a field
 * or a record out. All records here are made up.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ADMIN_CONFIG_KEEP,
  ADMIN_CONFIG_LEAVE_OUT,
  ARCHIVE_AS_IS,
  ARCHIVE_CHANGED,
  DECISIONS,
  DOC_VAULT_SALT_ID,
  DOC_VAULT_SALT_TYPE,
  LEFT_OUT,
  MCP_SERVER_SECRET_FIELDS,
  PROPOSAL_PERSONAL_FIELDS,
  REASONS,
  UNCLASSIFIED,
  adminConfigDecision,
  archiveClassifiedContainers,
  archiveDecisionFor,
  archivePlan,
  archiveRecord,
  createContentIndex,
} from './archive-classification.js';
import { exportPlanFor } from './export-classification.js';
import { PUBLIC_MEDIA_CONTAINERS, UPLOAD_CONTAINERS } from '../blob-paths.js';
import { ARCHIVE_CONTAINER } from './archive-report.js';
import { DOC_TYPES, SALT_DOCUMENT_ID } from '../doc-vault/model.js';

const ROOT = fileURLToPath(new URL('../../../..', import.meta.url));
const SRC = join(ROOT, 'functions', 'src');

function provisioned() {
  const spec = JSON.parse(readFileSync(join(ROOT, 'infra', 'cosmos-containers.json'), 'utf8'));
  return spec.containers.map((c) => c.name).sort();
}

describe('archive classification against infra/cosmos-containers.json', () => {
  it('names every provisioned container exactly once', () => {
    const names = archiveClassifiedContainers();
    const seen = new Map();
    for (const name of names) seen.set(name, (seen.get(name) || 0) + 1);
    expect(
      [...seen].filter(([, n]) => n > 1).map(([name]) => name),
      'named under more than one decision'
    ).toEqual([]);

    const unnamed = provisioned().filter((name) => archiveDecisionFor(name) === null);
    expect(
      unnamed,
      'in infra/cosmos-containers.json but not in archive-classification.js: decide whether the yearly archive keeps it, changes it or leaves it out'
    ).toEqual([]);
  });

  it('names nothing that is not provisioned', () => {
    const live = new Set(provisioned());
    expect(archiveClassifiedContainers().filter((name) => !live.has(name))).toEqual([]);
  });

  it('is 50 as they are, 4 changed first, 25 left out (7 of them waiting for the owner): 79', () => {
    expect(ARCHIVE_AS_IS).toHaveLength(50);
    expect(Object.keys(ARCHIVE_CHANGED).sort()).toEqual([
      'admin_config',
      'developer_events',
      'doc_vault',
      'mcp_servers',
    ]);
    expect(Object.keys(LEFT_OUT)).toHaveLength(25);
    expect(UNCLASSIFIED).toEqual([
      'config_providers',
      'config_settings',
      'tool_architecture_plans',
      'tool_assessment_sessions',
      'tool_exports',
      'tool_migration_workspaces',
      'tool_workspaces',
    ]);
    expect(archiveClassifiedContainers()).toHaveLength(79);
  });

  it('gives every left-out container a reason from the list', () => {
    const reasons = new Set(Object.values(REASONS));
    for (const [name, reason] of Object.entries(LEFT_OUT)) {
      expect(reasons.has(reason), `${name}: ${reason}`).toBe(true);
    }
  });

  it('keeps the owner’s recordings as they are (question 5: MINE)', () => {
    expect(archiveDecisionFor('recordings').decision).toBe(DECISIONS.archive);
    expect(archiveDecisionFor('plaud_ingest').decision).toBe(DECISIONS.archive);
  });

  it('plans only containers the weekly full backup holds: no backup file, no archive file', () => {
    const backup = new Set(exportPlanFor('full'));
    expect(archivePlan().filter((name) => !backup.has(name))).toEqual([]);
    expect(archivePlan()).toHaveLength(54);
  });

  it('treats a container it does not name as left out', () => {
    expect(archiveDecisionFor('a_new_container')).toBeNull();
    expect(archiveRecord('a_new_container', { id: 'x' })).toMatchObject({
      keep: false,
      reason: REASONS.unclassified,
    });
  });

  it('never serves or takes uploads into the archive’s blob container', () => {
    expect(ARCHIVE_CONTAINER).toBe('content-archive');
    expect([...PUBLIC_MEDIA_CONTAINERS]).not.toContain(ARCHIVE_CONTAINER);
    expect([...UPLOAD_CONTAINERS]).not.toContain(ARCHIVE_CONTAINER);
  });
});

describe('archiveRecord: fields taken out', () => {
  it('removes the four personal fields from every talk proposal, accepted or not', () => {
    for (const status of ['accepted', 'declined', 'submitted']) {
      const proposal = {
        id: 'p1',
        eventId: 'e1',
        docType: 'cfs-submission',
        status,
        title: 'A made-up talk',
        abstract: 'About nothing real',
        speakerName: 'Example Speaker',
        speakerEmail: 'speaker@example.com',
        speakerBio: 'A made-up biography',
        reviewNote: 'A made-up note',
      };
      const result = archiveRecord('developer_events', proposal);
      expect(result.keep).toBe(true);
      expect(result.removed.sort()).toEqual([...PROPOSAL_PERSONAL_FIELDS].sort());
      expect(result.doc).toEqual({
        id: 'p1',
        eventId: 'e1',
        docType: 'cfs-submission',
        status,
        title: 'A made-up talk',
        abstract: 'About nothing real',
      });
      // The record handed in is not changed.
      expect(proposal.speakerEmail).toBe('speaker@example.com');
    }
  });

  it('keeps a call for speakers whole and reports nothing removed', () => {
    const call = { id: 'c1', eventId: 'e1', docType: 'cfs-call', status: 'open' };
    expect(archiveRecord('developer_events', call)).toEqual({
      keep: true,
      doc: call,
      removed: [],
      reason: null,
    });
  });

  it('removes the sign-in fields of an outside tool server', () => {
    const server = {
      id: 'made-up-server',
      url: 'https://tools.example.com/mcp',
      apiKeyEnvVar: 'SOME_SETTING_NAME',
      oauthToken: 'made-up-access-token',
      oauthRefreshToken: 'made-up-refresh-token',
      oauthClientSecret: 'made-up-client-secret',
      oauthPending: { stateHash: 'made-up', codeVerifier: 'made-up' },
    };
    const result = archiveRecord('mcp_servers', server);
    expect(result.removed.sort()).toEqual([...MCP_SERVER_SECRET_FIELDS].sort());
    expect(result.doc).toEqual({
      id: 'made-up-server',
      url: 'https://tools.example.com/mcp',
      apiKeyEnvVar: 'SOME_SETTING_NAME',
    });
  });

  it('lets no secret or personal value out the other side, whatever the container', () => {
    // ADR 0046 section 7: a made-up record carrying each field, and each record that is left out whole.
    const secrets = [
      'made-up-access-token',
      'made-up-refresh-token',
      'made-up-client-secret',
      'made-up-verifier',
      'made-up-key-hash',
      'made-up-salt-value',
      'speaker@example.com',
      'Example Speaker',
      'A made-up biography',
      'A made-up note',
      'Example Organizer',
    ];
    const fed = [
      ['mcp_servers', { id: 's', oauthToken: secrets[0], oauthRefreshToken: secrets[1], oauthClientSecret: secrets[2], oauthPending: { codeVerifier: secrets[3] } }],
      ['admin_config', { id: 'developer_api_key:abc', keyHash: secrets[4], organizerName: secrets[10] }],
      ['admin_config', { id: 'agent_content_key:koda', keyHash: secrets[4] }],
      ['doc_vault', { id: 'vault-id-salt', docType: 'salt', value: secrets[5] }],
      ['developer_events', { id: 'p', docType: 'cfs-submission', speakerEmail: secrets[6], speakerName: secrets[7], speakerBio: secrets[8], reviewNote: secrets[9] }],
    ];
    const out = fed
      .map(([container, doc]) => archiveRecord(container, doc))
      .filter((result) => result.keep)
      .map((result) => JSON.stringify(result.doc))
      .join('\n');
    for (const secret of secrets) expect(out).not.toContain(secret);
  });
});

describe('archiveRecord: the Doc Vault salt', () => {
  it('names the salt item the way the Doc Vault does', () => {
    expect(DOC_VAULT_SALT_ID).toBe(SALT_DOCUMENT_ID);
    expect(DOC_VAULT_SALT_TYPE).toBe(DOC_TYPES.salt);
  });

  it('leaves the salt item out by its id and by its type, and keeps documents and versions', () => {
    expect(archiveRecord('doc_vault', { id: 'vault-id-salt', docType: 'salt', value: 'x'.repeat(64) })).toMatchObject({
      keep: false,
      reason: REASONS.secret,
    });
    expect(archiveRecord('doc_vault', { id: 'anything', docType: 'salt', value: 'x'.repeat(64) }).keep).toBe(false);
    expect(archiveRecord('doc_vault', { id: 'vault-id-salt' }).keep).toBe(false);
    const doc = { id: 'd1', docType: 'document', title: 'A made-up letter', body: 'text' };
    expect(archiveRecord('doc_vault', doc)).toEqual({ keep: true, doc, removed: [], reason: null });
    expect(archiveRecord('doc_vault', { id: 'd1~v1', docType: 'version' }).keep).toBe(true);
  });
});

describe('archiveRecord: interviews', () => {
  const article = { id: 'a1', type: 'article', contentStatus: 'draft' };
  const publicInterview = { id: 'i1', type: 'Interview', Live: true };
  const draftInterview = { id: 'i2', type: 'interview', contentStatus: 'draft' };
  const withdrawnInterview = { id: 'i3', type: 'interview', publishedAt: '2026-03-01T00:00:00.000Z', contentStatus: 'draft' };
  const deletedInterview = { id: 'i4', type: 'interview', Live: true, softDeletedAt: '2026-06-01T00:00:00.000Z' };

  it('keeps a public interview and every other kind of content, published or not', () => {
    expect(archiveRecord('content', publicInterview).keep).toBe(true);
    expect(archiveRecord('content', article).keep).toBe(true);
  });

  it('leaves out an interview that is a draft, was taken down, or is being deleted', () => {
    for (const doc of [draftInterview, withdrawnInterview, deletedInterview]) {
      expect(archiveRecord('content', doc), doc.id).toMatchObject({ keep: false, reason: REASONS.promise });
    }
  });

  it('applies the same rule to versions, through the content index', () => {
    const index = createContentIndex();
    for (const doc of [article, publicInterview, draftInterview, withdrawnInterview]) index.add(doc);
    expect(index.size).toBe(4);
    expect(index.withheldCount).toBe(2);
    const ctx = { contentIndex: index };
    expect(archiveRecord('content_versions', { id: 'v1', contentId: 'a1' }, ctx).keep).toBe(true);
    expect(archiveRecord('content_versions', { id: 'v2', contentId: 'i1' }, ctx).keep).toBe(true);
    expect(archiveRecord('content_versions', { id: 'v3', contentId: 'i2' }, ctx)).toMatchObject({
      keep: false,
      reason: REASONS.promise,
    });
    expect(archiveRecord('content_versions', { id: 'v4', contentId: 'i3' }, ctx).keep).toBe(false);
  });

  it('leaves out a version whose content item is not in the backup, or when no index was built', () => {
    const index = createContentIndex();
    index.add(article);
    expect(archiveRecord('content_versions', { id: 'v', contentId: 'gone' }, { contentIndex: index })).toMatchObject({
      keep: false,
      reason: REASONS.orphan,
    });
    expect(archiveRecord('content_versions', { id: 'v' }, { contentIndex: index }).keep).toBe(false);
    expect(archiveRecord('content_versions', { id: 'v', contentId: 'a1' }).keep).toBe(false);
  });
});

describe('archiveRecord: whole containers and odd input', () => {
  it('keeps nothing from a left-out container', () => {
    for (const [name, reason] of Object.entries(LEFT_OUT)) {
      expect(archiveRecord(name, { id: 'x' })).toEqual({ keep: false, doc: null, removed: [], reason });
    }
  });

  it('leaves out a line that is not a record', () => {
    for (const value of [null, 'text', 7, ['a']]) {
      expect(archiveRecord('blogs', value).keep).toBe(false);
    }
  });
});

describe('admin_config: one document at a time', () => {
  it('keeps settings and the owner’s own documents', () => {
    for (const id of [...ADMIN_CONFIG_KEEP.ids, 'community_days_event_made-up-1']) {
      expect(adminConfigDecision(id), id).toEqual({ keep: true, reason: null });
    }
    const doc = { id: 'reminders', configScope: 'admin_config', reminders: [] };
    expect(archiveRecord('admin_config', doc)).toEqual({ keep: true, doc, removed: [], reason: null });
  });

  it('leaves out every key record, as a secret', () => {
    expect(adminConfigDecision('developer_api_key:made-up-key-id')).toEqual({ keep: false, reason: REASONS.secret });
    expect(adminConfigDecision('agent_content_key:koda')).toEqual({ keep: false, reason: REASONS.secret });
    expect(archiveRecord('admin_config', { id: 'developer_api_key:x', keyHash: 'h' }).keep).toBe(false);
  });

  it('leaves out state, caches and queues', () => {
    for (const id of Object.keys(ADMIN_CONFIG_LEAVE_OUT.ids)) {
      expect(adminConfigDecision(id).keep, id).toBe(false);
    }
    expect(adminConfigDecision('health_probe_result:cosmos')).toEqual({ keep: false, reason: REASONS.workingState });
    expect(adminConfigDecision('podbean_host_stats_30d')).toEqual({ keep: false, reason: REASONS.derived });
    expect(adminConfigDecision('forge_queue_item:0123abcd')).toEqual({ keep: false, reason: REASONS.workingState });
  });

  it('leaves out a document id it does not name, and a record with no id', () => {
    expect(adminConfigDecision('something_added_later')).toEqual({ keep: false, reason: REASONS.unlisted });
    for (const id of [undefined, null, '', 7, {}]) {
      expect(adminConfigDecision(id)).toEqual({ keep: false, reason: REASONS.unlisted });
    }
  });

  it('names no id on both lists', () => {
    const out = new Set(Object.keys(ADMIN_CONFIG_LEAVE_OUT.ids));
    expect(ADMIN_CONFIG_KEEP.ids.filter((id) => out.has(id))).toEqual([]);
    for (const prefix of ADMIN_CONFIG_KEEP.prefixes) {
      expect(adminConfigDecision(`${prefix}x`).keep, prefix).toBe(true);
    }
  });

  /**
   * The list is held to the code. Every file under functions/src that
   * mentions admin_config is read for the ids it gives a document there:
   * a constant whose name ends in _ID or _PREFIX, a literal right after
   * 'admin_config' in a call, and a literal `id:` just above a `configScope`.
   * Each one must be on the keep list or the leave-out list. A constant that
   * is not an admin_config document id is listed in NOT_DOCUMENT_IDS with
   * what it is.
   *
   * What this cannot see: an id built some other way. Those stay out of the
   * archive anyway (an unnamed id is left out) and show in the dry-run
   * report as "unlisted".
   */
  const NOT_DOCUMENT_IDS = new Map([
    ['koda', 'the content agent’s name (agent-content/keys.js AGENT_ID)'],
    ['ai-features', 'a document of the admin_settings container (ai/containers.js)'],
    ['labs:coder-status', 'a document of the tool_service_cache container (labs/coder-status.js)'],
    ['admin_config', 'the container and partition name itself'],
    ['admin_settings', 'the next container name in the backup’s list (export-classification.js)'],
    ['hcwk_', 'how the content agent’s key starts (agent-content/keys.js)'],
    ['hcdk_', 'how a developer key starts (developer-api/keys.js)'],
    ['kv-', 'how a Key Vault credential’s register id starts (credentials/register.js)'],
    ['mcp:', 'how a tool server’s credential id starts (credentials/sources.js)'],
    ['credential-', 'how a reminder row made from a credential starts (reminders/settings.js)'],
    ['reminder:', 'how a reminder’s notice id starts (timers/reminders.js)'],
  ]);

  function sourceFiles(dir) {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(path);
      return /\.js$/.test(entry.name) && !/\.test\.js$/.test(entry.name) ? [path] : [];
    });
  }

  function idsIn(text) {
    const found = new Set();
    const shape = /^[a-z][a-z0-9_:-]{2,63}$/;
    const add = (value) => {
      if (shape.test(value)) found.add(value);
    };
    for (const m of text.matchAll(/\b[A-Z][A-Z0-9_]*(?:_ID|_ID_PREFIX|_PREFIX)\s*=\s*['"`]([^'"`$]+)['"`]/g)) add(m[1]);
    for (const m of text.matchAll(/['"]admin_config['"],\s*['"]([^'"]+)['"]/g)) add(m[1]);
    for (const m of text.matchAll(/\bid:\s*['"]([^'"]+)['"],?\s*\n(?:[^\n]*\n){0,3}?[^\n]*configScope/g)) add(m[1]);
    for (const m of text.matchAll(/=>\s*`([a-z][a-z0-9_:-]+)\$\{/g)) add(m[1]);
    return found;
  }

  it('names every admin_config document id the code under functions/src writes', () => {
    const unnamed = [];
    let files = 0;
    for (const path of sourceFiles(SRC)) {
      if (path.endsWith('archive-classification.js')) continue;
      const text = readFileSync(path, 'utf8');
      if (!/admin_config|ADMIN_CONFIG/.test(text)) continue;
      files += 1;
      for (const id of idsIn(text)) {
        if (NOT_DOCUMENT_IDS.has(id)) continue;
        // A prefix is tried with something after it, the way a real id has.
        const verdict = adminConfigDecision(/[:_]$/.test(id) ? `${id}x` : id);
        if (verdict.reason === REASONS.unlisted) unnamed.push(`${id} (${path.slice(SRC.length + 1)})`);
      }
    }
    expect(files).toBeGreaterThan(40);
    expect(
      unnamed,
      'an admin_config document id the archive classification does not name: add it to ADMIN_CONFIG_KEEP or ADMIN_CONFIG_LEAVE_OUT in archive-classification.js (or to NOT_DOCUMENT_IDS in this test, with what it is)'
    ).toEqual([]);
  });
});
