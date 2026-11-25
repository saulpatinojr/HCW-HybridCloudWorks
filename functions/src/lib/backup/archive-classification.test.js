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
  ADMIN_SETTINGS_KEEP,
  ADMIN_SETTINGS_LEAVE_OUT,
  AI_PROVIDER_KEEP,
  ARCHIVE_AS_IS,
  ARCHIVE_CHANGED,
  DECISIONS,
  DEVELOPER_EVENT_KEEP,
  DOC_VAULT_KEPT_TYPES,
  DOC_VAULT_SALT_ID,
  KEPT_BY_THE_OWNERS_DECISION,
  KEPT_ON_THE_OWNERS_WORD,
  OWNER_ACCEPTED,
  SENSITIVE_KEPT_ON_PURPOSE,
  ownerAcceptedOn,
  classificationFingerprint,
  LEFT_OUT,
  MCP_SERVER_KEEP,
  NAMED_REMOVALS,
  OTHER_REMOVED,
  PART_REMOVED,
  PROPOSAL_PERSONAL_FIELDS,
  REASONS,
  UNCLASSIFIED,
  addressWithoutSecrets,
  adminConfigDecision,
  adminSettingsDecision,
  archiveClassifiedContainers,
  archiveDecisionFor,
  archivePlan,
  archiveRecord,
  createContentIndex,
  looksSensitive,
} from './archive-classification.js';
import { exportPlanFor } from './export-classification.js';
import { PUBLIC_MEDIA_CONTAINERS, UPLOAD_CONTAINERS } from '../blob-paths.js';
import { ARCHIVE_CONTAINER } from './archive-report.js';
import { DOC_TYPES, SALT_DOCUMENT_ID } from '../doc-vault/model.js';
import { AI_PROVIDER_FIELDS, MCP_SERVER_FIELDS } from '../admin-integrations/config-collections.js';

const ROOT = fileURLToPath(new URL('../../../..', import.meta.url));
const SRC = join(ROOT, 'functions', 'src');

function provisioned() {
  const spec = JSON.parse(readFileSync(join(ROOT, 'infra', 'cosmos-containers.json'), 'utf8'));
  return spec.containers.map((c) => c.name).sort();
}

function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.js$/.test(entry.name) && !/\.test\.js$/.test(entry.name) ? [path] : [];
  });
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

  it('is 54 as they are, 6 kept in part, 19 left out and none waiting for the owner: 79', () => {
    expect(ARCHIVE_AS_IS).toHaveLength(54);
    expect(Object.keys(ARCHIVE_CHANGED).sort()).toEqual([
      'admin_config',
      'admin_settings',
      'ai_providers',
      'developer_events',
      'doc_vault',
      'mcp_servers',
    ]);
    expect(Object.keys(LEFT_OUT)).toHaveLength(19);
    expect(UNCLASSIFIED).toEqual([]);
    expect(archiveClassifiedContainers()).toHaveLength(79);
    // No container is named twice.
    expect(new Set(archiveClassifiedContainers()).size).toBe(79);
  });

  it('keeps, whole, the 21 containers the owner chose on 2026-11-24, the ones with tool users’ email addresses included', () => {
    expect(KEPT_BY_THE_OWNERS_DECISION).toEqual([
      'character_images',
      'character_modules',
      'character_profiles',
      'character_tag_adjectives',
      'config',
      'config_providers',
      'config_settings',
      'config_tags',
      'content_templates',
      'pillar_details',
      'pillar_items',
      'prompts',
      'roadmap_items',
      'site_settings',
      'tool_architecture_plans',
      'tool_assessment_sessions',
      'tool_exports',
      'tool_migration_workspaces',
      'tool_workspaces',
      'wiki_pages',
      'youtubevideos',
    ]);
    for (const container of KEPT_BY_THE_OWNERS_DECISION) {
      expect(archiveDecisionFor(container), container).toMatchObject({ decision: DECISIONS.archive, reason: null, keeps: null });
      expect(Object.hasOwn(LEFT_OUT, container), container).toBe(false);
      const doc = { id: 'made-up-id', email: 'made-up@example.com', sessionId: 'made-up-session' };
      expect(archiveRecord(container, doc)).toEqual({ keep: true, doc, removed: [], reason: null });
    }
    // The comment beside them says, in so many words, what the three tool containers hold and who chose.
    const source = readFileSync(new URL('./archive-classification.js', import.meta.url), 'utf8');
    const comments = source.replace(/\n\s*\/\/ ?/g, ' ');
    expect(comments).toContain('hold the EMAIL ADDRESS and the SESSION ID of whoever used the tool');
    expect(comments).toContain('recommended leaving those three out; the owner chose to keep them');
    // ...and which three, with the field names the dry run showed.
    for (const line of ['tool_workspaces ownerEmail', 'tool_assessment_sessions ownerEmail, requestedByEmail, ownerUid', 'tool_architecture_plans requestedByEmail, ownerUid, sessionId']) {
      expect(comments.replace(/ +/g, ' ')).toContain(line);
    }
  });

  it('records the owner’s blanket decision per container, with its date, and does not pass it off as names reviewed one by one', () => {
    expect(OWNER_ACCEPTED.date).toBe('2026-11-24');
    expect(OWNER_ACCEPTED.record).toMatch(/issues\/1811#issuecomment-\d+$/);
    expect(OWNER_ACCEPTED.containers).toHaveLength(31);
    for (const container of KEPT_BY_THE_OWNERS_DECISION) expect(OWNER_ACCEPTED.containers).toContain(container);
    for (const container of ['blogs', 'certifications', 'speakerevents', 'brain_records', 'ai_usage', 'content', 'system', 'admin_config', 'ai_providers', 'mcp_servers']) {
      expect(ownerAcceptedOn(container), container).toBe('2026-11-24');
    }
    // Every one of them is a container an archive writes.
    for (const container of OWNER_ACCEPTED.containers) expect(archivePlan(), container).toContain(container);
    expect(ownerAcceptedOn('newsletters')).toBeNull();
    expect(ownerAcceptedOn('a_new_container')).toBeNull();
    // The reviewed-by-name list is still one name on two containers: nothing was added to it.
    expect(SENSITIVE_KEPT_ON_PURPOSE).toEqual({
      mcp_servers: { apiKeyEnvVar: expect.any(String) },
      ai_providers: { apiKeyEnvVar: expect.any(String) },
    });
  });

  it('gives the rules one fingerprint: the same every time it is asked, and built from every list and function that decides a record', () => {
    const print = classificationFingerprint();
    expect(print).toMatch(/^[0-9a-f]{64}$/);
    expect(classificationFingerprint()).toBe(print);
    // The function names every list a record's fate depends on, so a change to any of them changes it.
    const source = readFileSync(new URL('./archive-classification.js', import.meta.url), 'utf8');
    const body = source.slice(source.indexOf('export function classificationFingerprint()'));
    for (const part of [
      'ARCHIVE_AS_IS',
      'ARCHIVE_CHANGED',
      'LEFT_OUT',
      'RECORD_RULES',
      'MCP_SERVER_KEEP',
      'AI_PROVIDER_KEEP',
      'DEVELOPER_EVENT_KEEP',
      'DOC_VAULT_KEPT_TYPES',
      'DOC_VAULT_SALT_ID',
      'ADMIN_CONFIG_KEEP',
      'ADMIN_CONFIG_LEAVE_OUT',
      'ADMIN_SETTINGS_KEEP',
      'ADMIN_SETTINGS_LEAVE_OUT',
      'SENSITIVE_NAME_WORDS',
      'text(archiveRecord)',
      'text(keepOnly)',
      'text(adminConfigDecision)',
      'text(adminSettingsDecision)',
      'text(withoutSensitiveKeys)',
      'text(addressWithoutSecrets)',
      'text(isPublicDocument)',
      'Object.entries(KINDS)',
    ]) {
      expect(body, part).toContain(part);
    }
    // Every keep list and decision list the file exports is in it: a new one must be added.
    // The rules are split over this file and three beside it; read all four.
    const ruleSources = [source, ...['admin', 'fields', 'reasons'].map((part) => readFileSync(new URL(`./archive-classification-${part}.js`, import.meta.url), 'utf8'))].join('\n');
    const lists = [...ruleSources.matchAll(/^export const ([A-Z_]+_(?:KEEP|LEAVE_OUT)) = /gm)].map((m) => m[1]);
    expect(lists.length).toBeGreaterThanOrEqual(7);
    for (const name of lists) expect(body, name).toContain(name);
  });

  it('"everything stays" did not put a secret back: the keep lists still drop what they dropped', () => {
    expect(archiveRecord('mcp_servers', { id: 'm1', name: 'A server', oauthToken: 'made-up-token', headers: { Authorization: 'made-up' } }).doc).toEqual({ id: 'm1', name: 'A server' });
    expect(archiveRecord('ai_providers', { id: 'a1', name: 'A provider', apiKey: 'made-up-key' }).doc).toEqual({ id: 'a1', name: 'A provider' });
    expect(archiveRecord('admin_config', { id: 'developer_api_key:made-up', keyHash: 'made-up-hash' })).toMatchObject({ keep: false, reason: REASONS.secret });
    expect(archiveRecord('admin_settings', { id: 'bootstrap-state', oid: 'made-up-oid' })).toMatchObject({ keep: false, reason: REASONS.accessList });
    expect(archiveRecord('developer_events', { id: 'p1', eventId: 'e1', docType: 'cfs-submission', title: 'A talk', speakerEmail: 'speaker@example.com' }).doc).toEqual({ id: 'p1', eventId: 'e1', docType: 'cfs-submission', title: 'A talk' });
    // And the two rules about interviews are as they were (the open question stays NONE).
    expect(archiveRecord('content', { id: 'c2', type: 'interview', status: 'draft' })).toMatchObject({ keep: false, reason: REASONS.promise });
  });

  it('leaves both access lists out: who may sign in, and which machine is which lab agent', () => {
    expect(archiveDecisionFor('admins')).toMatchObject({ decision: DECISIONS.leaveOut, reason: REASONS.accessList });
    expect(archiveDecisionFor('lab_agents')).toMatchObject({ decision: DECISIONS.leaveOut, reason: REASONS.accessList });
    expect(archiveRecord('lab_agents', { id: 'made-up-agent', oid: '00000000-0000-0000-0000-000000000001', updatedBy: 'x', hostname: 'made-up-host' }).keep).toBe(false);
  });

  /**
   * "Archive as is" means nobody looks at the fields, so it is only right for
   * a container whose fields the code knows. Every container on that list
   * must be named, in quotes, by a file under functions/src that is not a
   * test and not the backup's own lists. One that no code names is one
   * nobody can describe: it belongs with the unclassified ones until the
   * owner has read its dry-run report. The exception is what the owner
   * answered for by name (question 5 of ADR 0046, and the 21 of 2026-11-24).
   */
  it('archives as is only a container some code under functions/src names', () => {
    const texts = sourceFiles(SRC)
      .filter((path) => !path.includes(`${join('lib', 'backup')}`))
      .map((path) => readFileSync(path, 'utf8'));
    const named = (container) => {
      const quoted = new RegExp(`['"\`]${container}['"\`]`);
      return texts.some((text) => quoted.test(text));
    };
    const unknown = ARCHIVE_AS_IS.filter((name) => !KEPT_ON_THE_OWNERS_WORD.includes(name) && !named(name));
    expect(
      unknown,
      'archived as is, but no code under functions/src names it, so nobody knows what it holds: move it to the unclassified list in archive-classification.js'
    ).toEqual([]);
    // Exactly these are kept without the code being able to say what they hold: nothing slips onto the list.
    expect(KEPT_ON_THE_OWNERS_WORD).toEqual(['plaud_ingest', ...KEPT_BY_THE_OWNERS_DECISION].sort());
    for (const name of KEPT_ON_THE_OWNERS_WORD) expect(ARCHIVE_AS_IS).toContain(name);
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
    expect(archivePlan()).toHaveLength(60);
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

describe('archiveRecord: talk proposals and calls for speakers (developer_events)', () => {
  const proposal = (over = {}) => ({
    id: 'p1',
    eventId: 'e1',
    docType: 'cfs-submission',
    status: 'accepted',
    title: 'A made-up talk',
    abstract: 'About nothing real',
    format: 'talk',
    level: 'intro',
    submittedAt: '2026-05-01T00:00:00.000Z',
    reviewedAt: '2026-05-02T00:00:00.000Z',
    reviewedBy: 'made-up-reviewer-id',
    speakerName: 'Example Speaker',
    speakerEmail: 'speaker@example.com',
    speakerBio: 'A made-up biography',
    reviewNote: 'A made-up note',
    ...over,
  });

  it('keeps the talk and the decision from every proposal, accepted or not, and none of the people', () => {
    for (const status of ['accepted', 'declined', 'pending']) {
      const fed = proposal({ status });
      const result = archiveRecord('developer_events', fed);
      expect(result.keep).toBe(true);
      expect(result.removed).toEqual([...PROPOSAL_PERSONAL_FIELDS, 'reviewedBy'].sort());
      expect(result.doc).toEqual({
        id: 'p1',
        eventId: 'e1',
        docType: 'cfs-submission',
        status,
        title: 'A made-up talk',
        abstract: 'About nothing real',
        format: 'talk',
        level: 'intro',
        submittedAt: '2026-05-01T00:00:00.000Z',
        reviewedAt: '2026-05-02T00:00:00.000Z',
      });
      // The record handed in is not changed.
      expect(fed.speakerEmail).toBe('speaker@example.com');
    }
  });

  it('keeps a call for speakers without the organizer’s name, key id or the id of who changed it', () => {
    const call = {
      id: 'cfs-call:e1',
      eventId: 'e1',
      docType: 'cfs-call',
      status: 'open',
      title: 'A made-up call',
      description: 'Send us a talk',
      closesAt: null,
      openedAt: '2026-04-01T00:00:00.000Z',
      closedAt: null,
      createdAt: '2026-04-01T00:00:00.000Z',
      updatedAt: '2026-04-02T00:00:00.000Z',
      organizerName: 'Example Organizer',
      organizerKeyId: 'made-up-key-id',
      updatedBy: 'made-up-object-id',
    };
    const result = archiveRecord('developer_events', call);
    expect(result.removed).toEqual(['organizerKeyId', 'organizerName', 'updatedBy']);
    const { organizerName: _n, organizerKeyId: _k, updatedBy: _u, ...kept } = call;
    expect(result.doc).toEqual(kept);
  });

  it('drops a field nobody listed, a nested copy of a personal field, and a field cased another way', () => {
    const result = archiveRecord(
      'developer_events',
      proposal({
        speakerPhone: '+1 555 0100',
        SpeakerEmail: 'speaker@example.com',
        extra: { speakerEmail: 'speaker@example.com', speakerName: 'Example Speaker' },
        // A kept field that is not plain text is dropped whole, so nothing can ride inside it.
        abstract: { text: 'About nothing real', speakerEmail: 'speaker@example.com' },
        _etag: 'made-up-etag',
      })
    );
    const out = JSON.stringify(result.doc);
    for (const value of ['speaker@example.com', 'Example Speaker', '555 0100', 'made-up-reviewer-id', 'made-up-etag']) {
      expect(out, value).not.toContain(value);
    }
    expect(Object.keys(result.doc).sort()).toEqual(
      ['docType', 'eventId', 'format', 'id', 'level', 'reviewedAt', 'status', 'submittedAt', 'title'].sort()
    );
    // A dropped field's own name is never repeated unless this repository wrote it.
    expect(result.removed).toContain(OTHER_REMOVED);
    for (const name of result.removed) expect([...NAMED_REMOVALS, OTHER_REMOVED, PART_REMOVED]).toContain(name);
    expect(result.removed).not.toContain('speakerPhone');
  });

  it('leaves out a record that is neither a call nor a proposal', () => {
    for (const docType of [undefined, null, 'event', 'CFS-CALL', 7, 'constructor', 'toString']) {
      expect(archiveRecord('developer_events', { id: 'x', eventId: 'e', docType, speakerEmail: 'speaker@example.com' })).toMatchObject({
        keep: false,
        reason: REASONS.unlisted,
      });
    }
  });

  it('has no personal field on either keep list', () => {
    const personal = [...PROPOSAL_PERSONAL_FIELDS, 'reviewedBy', 'organizerName', 'organizerKeyId', 'updatedBy'];
    for (const [docType, list] of Object.entries(DEVELOPER_EVENT_KEEP)) {
      expect(Object.keys(list).filter((field) => personal.includes(field)), docType).toEqual([]);
      expect(Object.values(list).every((kind) => kind === 'scalar'), docType).toBe(true);
    }
    expect(Object.keys(DEVELOPER_EVENT_KEEP).sort()).toEqual(['cfs-call', 'cfs-submission']);
  });
});

describe('archiveRecord: outside tool servers (mcp_servers) are a keep list', () => {
  const server = (over = {}) => ({
    id: 'made-up-server',
    name: 'Made-up tools',
    url: 'https://tools.example.com/mcp',
    transport: 'http',
    apiKeyEnvVar: 'SOME_SETTING_NAME',
    enabled: true,
    order: 2,
    authType: 'bearer',
    allowedTools: ['search'],
    description: 'A made-up server',
    notes: '',
    tools: [{ name: 'search', description: 'Search things', inputSchema: { properties: { api_key: { default: 'made-up-schema-key' } } } }],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    ...over,
  });

  it('keeps the settings and drops every sign-in field, the free-form headers and the last test result', () => {
    const result = archiveRecord(
      'mcp_servers',
      server({
        oauthToken: 'made-up-access-token',
        oauthRefreshToken: 'made-up-refresh-token',
        oauthClientSecret: 'made-up-client-secret',
        oauthPending: { stateHash: 'made-up-state', codeVerifier: 'made-up-verifier' },
        oauth: { tokenEndpoint: 'https://login.example.com/token' },
        headers: { Authorization: 'Bearer made-up-header-token' },
        status: 'connected',
        lastError: 'made-up error text from the far end',
        lastTestedAt: '2026-01-03T00:00:00.000Z',
      })
    );
    expect(result.keep).toBe(true);
    expect(result.doc).toEqual({
      id: 'made-up-server',
      name: 'Made-up tools',
      url: 'https://tools.example.com/mcp',
      transport: 'http',
      apiKeyEnvVar: 'SOME_SETTING_NAME',
      enabled: true,
      order: 2,
      authType: 'bearer',
      allowedTools: ['search'],
      description: 'A made-up server',
      notes: '',
      tools: [{ name: 'search', description: 'Search things' }],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
    });
    expect(result.removed).toEqual(
      ['(part of a kept field)', 'headers', 'lastError', 'lastTestedAt', 'oauth', 'oauthClientSecret', 'oauthPending', 'oauthRefreshToken', 'oauthToken', 'status'].sort()
    );
  });

  it('drops a field nobody listed, a nested token, a field cased another way, and a key in the web address', () => {
    const result = archiveRecord(
      'mcp_servers',
      server({
        url: 'https://user:made-up-url-password@tools.example.com/mcp?api_key=made-up-url-key#made-up-fragment',
        somethingAddedLater: 'made-up-later-value',
        OAuthToken: 'made-up-cased-token',
        oauthtoken: 'made-up-lower-token',
        // A kept field that should be plain text but holds an object is dropped whole.
        description: { text: 'A made-up server', token: 'made-up-nested-token' },
        allowedTools: ['search', { token: 'made-up-list-token' }],
        tools: [{ name: 'search', description: 'Search', auth: { token: 'made-up-tool-token' } }, { token: 'made-up-nameless-tool' }],
        apiKeyEnvVar: 'made-up-pasted-key-value',
      })
    );
    const out = JSON.stringify(result.doc);
    for (const value of [
      'made-up-url-password',
      'made-up-url-key',
      'made-up-fragment',
      'made-up-later-value',
      'made-up-cased-token',
      'made-up-lower-token',
      'made-up-nested-token',
      'made-up-list-token',
      'made-up-tool-token',
      'made-up-nameless-tool',
      'made-up-pasted-key-value',
      'made-up-schema-key',
    ]) {
      expect(out, value).not.toContain(value);
    }
    expect(result.doc.url).toBe('https://tools.example.com/mcp');
    expect(result.doc.allowedTools).toEqual(['search']);
    expect(result.doc.tools).toEqual([{ name: 'search', description: 'Search' }]);
    expect(result.doc).not.toHaveProperty('apiKeyEnvVar');
    expect(result.doc).not.toHaveProperty('description');
    // The report may print only names this repository wrote.
    for (const name of result.removed) expect([...NAMED_REMOVALS, OTHER_REMOVED, PART_REMOVED]).toContain(name);
    expect(result.removed).not.toContain('somethingAddedLater');
  });

  it('drops a web address it cannot read, and one that is not http or https', () => {
    for (const url of ['not a url', 'javascript:alert(1)', 'ftp://tools.example.com/x', '', 7, null, { href: 'https://tools.example.com' }]) {
      expect(archiveRecord('mcp_servers', server({ url })).doc, String(url)).not.toHaveProperty('url');
    }
    expect(addressWithoutSecrets('https://tools.example.com/mcp/?a=1')).toBe('https://tools.example.com/mcp/');
    expect(addressWithoutSecrets('HTTPS://u:p@Tools.Example.com:8443/x?sig=abc#f')).toBe('https://tools.example.com:8443/x');
  });

  it('keeps no field the writer does not accept, and none that can hold a token', () => {
    const kept = Object.keys(MCP_SERVER_KEEP);
    expect(kept.filter((field) => !MCP_SERVER_FIELDS.includes(field)), 'on the keep list but not a field the writer accepts').toEqual([]);
    expect(kept.filter((field) => /oauth|headers|token|secret/i.test(field))).toEqual([]);
    // Every field the writer accepts and the archive drops is dropped on purpose.
    expect(MCP_SERVER_FIELDS.filter((field) => !kept.includes(field)).sort()).toEqual(
      ['headers', 'lastError', 'lastTestedAt', 'oauthRefreshToken', 'oauthToken', 'status'].sort()
    );
  });
});

describe('archiveRecord: AI provider cards (ai_providers) are a keep list', () => {
  it('keeps what today’s writer accepts and drops an old key, wherever it sits', () => {
    const result = archiveRecord('ai_providers', {
      id: 'made-up-provider',
      name: 'Made-up provider',
      enabled: true,
      order: 1,
      apiKeyEnvVar: 'SOME_PROVIDER_KEY',
      model: 'made-up-model',
      baseUrl: 'https://ai.example.com/v1?key=made-up-url-key',
      models: ['made-up-model', { apiKey: 'made-up-list-key' }],
      apiKey: 'made-up-old-key',
      APIKEY: 'made-up-cased-key',
      credentials: { apiKey: 'made-up-nested-key' },
      notes: { apiKey: 'made-up-notes-key' },
      lastError: 'the far end said made-up-error-key',
      status: 'ok',
    });
    expect(result.doc).toEqual({
      id: 'made-up-provider',
      name: 'Made-up provider',
      enabled: true,
      order: 1,
      apiKeyEnvVar: 'SOME_PROVIDER_KEY',
      model: 'made-up-model',
      baseUrl: 'https://ai.example.com/v1',
      models: ['made-up-model'],
    });
    expect(JSON.stringify(result.doc)).not.toMatch(/made-up-(old|cased|nested|notes|list|url|error)-key/);
    expect(result.removed).toContain('apiKey');
    expect(result.removed).toContain(OTHER_REMOVED);
    expect(result.removed).not.toContain('credentials');
  });

  it('keeps no field the writer does not accept', () => {
    const kept = Object.keys(AI_PROVIDER_KEEP);
    expect(kept.filter((field) => !AI_PROVIDER_FIELDS.includes(field))).toEqual([]);
    expect(AI_PROVIDER_FIELDS.filter((field) => !kept.includes(field)).sort()).toEqual(['lastError', 'lastTestedAt', 'status']);
  });
});

describe('looksSensitive: a field name that reads like a secret or contact details', () => {
  it('matches the names it is meant to, however they are cased or joined', () => {
    for (const name of ['token', 'oauthToken', 'refresh_token', 'clientSecret', 'password', 'passwd', 'apiKey', 'api_key', 'API-KEY', 'apikey', 'Authorization', 'credentials', 'privateKey', 'private_key', 'keyHash', 'email', 'speakerEmail', 'phone', 'sas', 'sasToken', 'blobSasUrl', 'sig', 'url_sig', 'key', 'pwd', 'cookie', 'salt']) {
      expect(looksSensitive(name), name).toBe(true);
    }
  });

  it('does not match ordinary names, or anything that is not text', () => {
    for (const name of ['id', 'title', 'status', 'design', 'signal', 'assigned', 'partitionKey', 'dedupeKey', 'keyboard', 'basis', 'createdAt', '', null, undefined, 7, {}]) {
      expect(looksSensitive(name), String(name)).toBe(false);
    }
  });
});

describe('archiveRecord: nothing secret or personal comes out', () => {
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
      'made-up-header-token',
      'made-up-url-key',
      'made-up-old-key',
      'made-up-admin-object-id',
      'made-up-legacy-key',
    ];
    const fed = [
      ['mcp_servers', { id: 's', url: `https://t.example.com/?k=${secrets[12]}`, headers: { Authorization: secrets[11] }, oauthToken: secrets[0], oauthRefreshToken: secrets[1], oauthClientSecret: secrets[2], oauthPending: { codeVerifier: secrets[3] } }],
      ['ai_providers', { id: 'p', apiKey: secrets[13] }],
      ['admin_config', { id: 'developer_api_key:abc', keyHash: secrets[4], organizerName: secrets[10] }],
      ['admin_config', { id: 'agent_content_key:koda', keyHash: secrets[4] }],
      ['admin_settings', { id: 'bootstrap-state', adminOid: secrets[14] }],
      ['admin_settings', { id: 'integrations', sessionizeSpeakerId: 'x', someOldKey: secrets[15], speakerProfile: { name: 'Owner', apiKey: secrets[15] } }],
      ['doc_vault', { id: 'vault-id-salt', docType: 'salt', value: secrets[5] }],
      ['developer_events', { id: 'p', docType: 'cfs-submission', speakerEmail: secrets[6], speakerName: secrets[7], speakerBio: secrets[8], reviewNote: secrets[9] }],
      ['developer_events', { id: 'c', docType: 'cfs-call', organizerName: secrets[10] }],
      ['lab_agents', { id: 'a', oid: secrets[14] }],
    ];
    const results = fed.map(([container, doc]) => archiveRecord(container, doc));
    const out = JSON.stringify(results);
    for (const secret of secrets) expect(out, secret).not.toContain(secret);
    // And something did come out, so the test is not passing on an empty answer.
    expect(results.filter((result) => result.keep).length).toBeGreaterThanOrEqual(5);
  });
});

describe('archiveRecord: the Doc Vault keeps documents and versions, and nothing else', () => {
  it('names the kinds the way the Doc Vault does: every kind but the salt', () => {
    expect(DOC_VAULT_SALT_ID).toBe(SALT_DOCUMENT_ID);
    expect([...DOC_VAULT_KEPT_TYPES].sort()).toEqual(
      Object.values(DOC_TYPES)
        .filter((type) => type !== DOC_TYPES.salt)
        .sort()
    );
  });

  it('leaves out the salt, an item of a kind it does not name, and an item with no kind', () => {
    expect(archiveRecord('doc_vault', { id: 'vault-id-salt', docType: 'salt', value: 'x'.repeat(64) })).toMatchObject({
      keep: false,
      reason: REASONS.secret,
    });
    expect(archiveRecord('doc_vault', { id: 'anything', docType: 'salt', value: 'x'.repeat(64) }).keep).toBe(false);
    expect(archiveRecord('doc_vault', { id: 'vault-id-salt' }).keep).toBe(false);
    // The salt's id under a kept kind is still the salt.
    expect(archiveRecord('doc_vault', { id: 'vault-id-salt', docType: 'document' }).keep).toBe(false);
    for (const docType of ['a-kind-added-later', 'Salt', '', undefined, null, 7]) {
      expect(archiveRecord('doc_vault', { id: 'x', docType, value: 'made-up' }).keep, String(docType)).toBe(false);
    }
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

  it('keeps no earlier version of any interview, public or not, and every version of other content', () => {
    const index = createContentIndex();
    for (const doc of [article, publicInterview, draftInterview, withdrawnInterview]) index.add(doc);
    expect(index.size).toBe(4);
    expect(index.interviewCount).toBe(3);
    expect(index.withheldCount).toBe(2);
    const ctx = { contentIndex: index };
    expect(archiveRecord('content_versions', { id: 'v1', contentId: 'a1' }, ctx).keep).toBe(true);
    // A PUBLIC interview's history holds its drafts from before it was published: all of it stays out.
    expect(archiveRecord('content_versions', { id: 'v2', contentId: 'i1' }, ctx)).toMatchObject({
      keep: false,
      reason: REASONS.promise,
    });
    expect(archiveRecord('content_versions', { id: 'v3', contentId: 'i2' }, ctx)).toMatchObject({
      keep: false,
      reason: REASONS.promise,
    });
    expect(archiveRecord('content_versions', { id: 'v4', contentId: 'i3' }, ctx).keep).toBe(false);
    // The public interview itself is still kept, in `content`.
    expect(archiveRecord('content', publicInterview).keep).toBe(true);
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

describe('admin_settings: one document at a time', () => {
  it('keeps the settings documents whole, and the news sources by their prefix', () => {
    for (const id of ['ai-features', 'ai-routing', 'telegram_bot', 'blog-source-0123abcd', 'blog-source-custom-made-up']) {
      expect(adminSettingsDecision(id), id).toMatchObject({ keep: true, reason: null });
    }
    const doc = { id: 'telegram_bot', commands: { status: true, publish: false } };
    expect(archiveRecord('admin_settings', doc)).toEqual({ keep: true, doc, removed: [], reason: null });
  });

  it('leaves out the record of who set the site up, test results, the fetched model list and source runs', () => {
    expect(adminSettingsDecision('bootstrap-state')).toMatchObject({ keep: false, reason: REASONS.accessList });
    expect(adminSettingsDecision('integration-status')).toMatchObject({ keep: false, reason: REASONS.workingState });
    expect(adminSettingsDecision('ai-model-catalog')).toMatchObject({ keep: false, reason: REASONS.derived });
    expect(adminSettingsDecision('run-blog-source-0123abcd')).toMatchObject({ keep: false, reason: REASONS.workingState });
    expect(archiveRecord('admin_settings', { id: 'bootstrap-state', adminOid: 'made-up' })).toMatchObject({
      keep: false,
      reason: REASONS.accessList,
    });
  });

  it('leaves out a document id it does not name, and a record with no id', () => {
    for (const id of ['something_added_later', 'constructor', 'toString', undefined, null, '', 7, {}]) {
      expect(adminSettingsDecision(id), String(id)).toMatchObject({ keep: false, reason: REASONS.unlisted });
    }
    expect(archiveRecord('admin_settings', { id: 'something_added_later', apiKey: 'made-up' })).toMatchObject({
      keep: false,
      reason: REASONS.unlisted,
    });
  });

  it('keeps from the integrations document only what today’s writer accepts', () => {
    const result = archiveRecord('admin_settings', {
      id: 'integrations',
      sessionizeSpeakerId: 'made-up-speaker-id',
      speakerProfile: { name: 'Owner', bio: 'A bio', links: [{ label: 'Site', url: 'https://example.com' }], apiToken: 'made-up-profile-token' },
      publerApiKey: 'made-up-legacy-key',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(result.doc).toEqual({
      id: 'integrations',
      sessionizeSpeakerId: 'made-up-speaker-id',
      speakerProfile: { name: 'Owner', bio: 'A bio', links: [{ label: 'Site', url: 'https://example.com' }] },
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(result.removed).toEqual([OTHER_REMOVED, PART_REMOVED]);
  });

  it('names no id on both lists', () => {
    const out = new Set(Object.keys(ADMIN_SETTINGS_LEAVE_OUT.ids));
    expect(Object.keys(ADMIN_SETTINGS_KEEP.ids).filter((id) => out.has(id))).toEqual([]);
    for (const prefix of ADMIN_SETTINGS_KEEP.prefixes) {
      expect(Object.keys(ADMIN_SETTINGS_LEAVE_OUT.prefixes).some((p) => prefix.startsWith(p) || p.startsWith(prefix)), prefix).toBe(false);
    }
  });

  /**
   * The list is held to the code, the way admin_config's is. Every file
   * under functions/src that names the admin_settings container is read for
   * the ids it gives a document there: a constant whose name ends in _ID or
   * _PREFIX, a literal right after 'admin_settings' in a call, a literal
   * `id:` in a document written there, and the start of an id built from a
   * template (`run-${...}`). Each must be on the keep list or the leave-out
   * list. A constant that is not an admin_settings document id is listed in
   * NOT_SETTINGS_IDS with what it is.
   *
   * What this cannot see: an id built some other way. Those stay out of the
   * archive anyway (an unnamed id is left out) and show in the dry-run
   * report as "unlisted".
   */
  const NOT_SETTINGS_IDS = new Map([
    ['admin_settings', 'the container name itself'],
    ['ai_providers', 'another container (ai/containers.js PROVIDERS_CONTAINER)'],
    ['admin_config', 'another container (ai/containers.js)'],
    ['listen_and_learn_speech', 'a document of the admin_config container (ai/containers.js)'],
  ]);

  function settingsIdsIn(text) {
    const found = new Set();
    const shape = /^[a-z][a-z0-9_:-]{2,63}$/;
    const add = (value) => {
      if (shape.test(value)) found.add(value);
    };
    for (const m of text.matchAll(/\b[A-Z][A-Z0-9_]*(?:_ID|_ID_PREFIX|_PREFIX)\s*=\s*['"`]([^'"`$]+)['"`]/g)) add(m[1]);
    for (const m of text.matchAll(/['"]admin_settings['"],\s*['"]([^'"]+)['"]/g)) add(m[1]);
    for (const m of text.matchAll(/\bid:\s*['"]([^'"]+)['"]/g)) add(m[1]);
    for (const m of text.matchAll(/`([a-z][a-z0-9_:-]+-)\$\{/g)) add(m[1]);
    return found;
  }

  it('names every admin_settings document id the code under functions/src writes', () => {
    const unnamed = [];
    const seen = new Set();
    let files = 0;
    for (const path of sourceFiles(SRC)) {
      if (path.includes(join('lib', 'backup'))) continue;
      const text = readFileSync(path, 'utf8');
      // Any file that mentions the container, in code or in a comment: the
      // document id is often declared in a file that only describes it.
      if (!/admin_settings|\bSETTINGS_CONTAINER\b/.test(text)) continue;
      files += 1;
      for (const id of settingsIdsIn(text)) {
        if (NOT_SETTINGS_IDS.has(id)) continue;
        seen.add(id);
        const verdict = adminSettingsDecision(/[:_-]$/.test(id) ? `${id}x` : id);
        if (verdict.reason === REASONS.unlisted) unnamed.push(`${id} (${path.slice(SRC.length + 1)})`);
      }
    }
    expect(files).toBeGreaterThan(8);
    expect(
      unnamed,
      'an admin_settings document id the archive classification does not name: add it to ADMIN_SETTINGS_KEEP or ADMIN_SETTINGS_LEAVE_OUT in archive-classification.js (or to NOT_SETTINGS_IDS in this test, with what it is)'
    ).toEqual([]);
    // The scan really does find the ids the lists are about.
    for (const id of ['ai-features', 'ai-routing', 'ai-model-catalog', 'telegram_bot', 'integrations', 'integration-status', 'bootstrap-state', 'blog-source-', 'run-']) {
      expect([...seen], id).toContain(id);
    }
  });
});
