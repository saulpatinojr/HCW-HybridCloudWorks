/**
 * The forge save under a job deadline (#942 follow-up, review of #1199).
 *
 * saveForgeOutcome writes three documents in order: the content itself,
 * then its version snapshot in `content_versions`, then the audit row in
 * `admin_audit_logs`. When a forge-article job's budget runs out as the
 * content write lands, the two writes after it are records of a change that
 * has already happened. Refusing them would leave forged content with no
 * version to restore from and no record of who forged it, so job-context.js
 * keeps both containers. A write that is a side effect of its own, such as
 * the day's forge statistics, is still refused.
 *
 * The real forge pipeline and the real cosmos-client.js run here over a
 * mocked SDK; the drafter and grader are stubs.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sdk = vi.hoisted(() => ({
  docs: new Map(),
  writes: [],
  onWrite: null,
}));

vi.mock('@azure/cosmos', () => ({
  CosmosClient: class {
    database() {
      return {
        container: (name) => {
          const key = (id) => `${name}/${id}`;
          const record = (op, id, resource) => {
            sdk.writes.push(`${op} ${name}`);
            sdk.onWrite?.(name, op);
            return { resource };
          };
          return {
            item: (id) => ({
              read: async () => ({
                resource: sdk.docs.has(key(id)) ? structuredClone(sdk.docs.get(key(id))) : undefined,
              }),
              replace: async (doc) => {
                sdk.docs.set(key(id), { ...doc, _etag: '"next"' });
                return record('replace', id, doc);
              },
              // The budget claim's conditional increment is the only patch
              // before the save; it answers with the day's count.
              patch: async () => record('patch', id, { id, today: { forged: 1 } }),
            }),
            items: {
              upsert: async (doc) => {
                sdk.docs.set(key(doc.id), doc);
                return record('upsert', doc.id, doc);
              },
              create: async (doc) => record('create', doc.id, doc),
              query: () => ({ fetchAll: async () => ({ resources: [] }) }),
            },
          };
        },
      };
    }
  },
}));
vi.mock('@azure/identity', () => ({ DefaultAzureCredential: class {}, ManagedIdentityCredential: class {} }));

process.env.COSMOS_ENDPOINT = 'https://example.documents.azure.com';

const cosmos = await import('../cosmos-client.js');
const { createForge } = await import('./forge.js');
const { DEFAULT_PROFILE, DEFAULT_PROMPTS } = await import('./forge-config.js');
const { runAsJob } = await import('../job-context.js');

const POST = [
  '## Why gp3 beats gp2',
  'Concrete numbers: 3,000 IOPS baseline, $0.08 per GB-month in us-east-1. '.repeat(30),
  '<module type="recommendation" align="left">Migrate volumes with aws ec2 modify-volume --volume-type gp3.</module>',
  '## Steps',
  'Run the command per volume. '.repeat(30),
  '## TL;DR',
  'Switch to gp3.',
].join('\n\n');

/** The forge with stub model calls, writing through the real cosmos-client. */
function forgeOverCosmos() {
  let n = 0;
  return createForge({
    store: cosmos,
    config: {
      loadForgeProfile: async () => DEFAULT_PROFILE,
      loadForgePrompts: async () => DEFAULT_PROMPTS,
    },
    drafter: {
      generateDraft: async () => ({
        title: 'Cut EBS cost: gp2 to gp3',
        summary: 'Numbers and commands.',
        postContent: POST,
        summaryPrompt: 'scene',
        detailsPrompt: 'details',
        keyTopics: ['AWS EBS'],
      }),
    },
    grader: { gradeArticle: async () => ({ overall: 90, subs: [], skippedLlm: false }) },
    log: { warn: vi.fn(), error: vi.fn(), log: vi.fn() },
    now: () => new Date('2026-10-15T12:00:00.000Z'),
    uuid: () => `uuid-${(n += 1)}`,
  });
}

beforeEach(() => {
  sdk.docs.clear();
  sdk.writes.length = 0;
  sdk.onWrite = null;
  sdk.docs.set('content/c-1', {
    id: 'c-1',
    Title: 'EBS gp3 migration notes',
    content: 'source markdown',
    'Cloud Provider': 'AWS',
    sourceUrl: 'https://src/ebs',
    _etag: '"c1"',
  });
  sdk.docs.set('admin_config/forge_stats', {
    id: 'forge_stats',
    configScope: 'admin_config',
    today: { date: '2026-10-15', forged: 0 },
    _etag: '"s1"',
  });
});

describe('a forge job whose deadline lands on the content write (#942)', () => {
  it('still writes the version snapshot and the audit row, and refuses the statistics after them', async () => {
    const job = new AbortController();
    sdk.onWrite = (container, op) => {
      if (container === 'content' && op === 'replace') {
        job.abort(Object.assign(new Error('job timed out'), { code: 'JOB_TIMEOUT' }));
      }
    };

    const outcome = await runAsJob(job.signal, () =>
      forgeOverCosmos().runForgePipeline({ contentId: 'c-1', actor: { oid: 'o1' } })
    );

    expect(job.signal.aborted).toBe(true);
    expect(outcome.ok).toBe(true);
    const fromContent = sdk.writes.slice(sdk.writes.indexOf('replace content'));
    expect(fromContent).toEqual([
      'replace content',
      'upsert content_versions',
      'upsert admin_audit_logs',
    ]);
    const version = sdk.docs.get('content_versions/uuid-1');
    expect(version).toMatchObject({ contentId: 'c-1', versionReason: 'forge_generated' });
  });

  it('writes the same sequence, statistics included, when the deadline does not arrive', async () => {
    const job = new AbortController();
    const outcome = await runAsJob(job.signal, () =>
      forgeOverCosmos().runForgePipeline({ contentId: 'c-1', actor: { oid: 'o1' } })
    );
    expect(outcome.ok).toBe(true);
    const fromContent = sdk.writes.slice(sdk.writes.indexOf('replace content'));
    expect(fromContent.slice(0, 3)).toEqual([
      'replace content',
      'upsert content_versions',
      'upsert admin_audit_logs',
    ]);
    expect(fromContent.slice(3).some((write) => write.endsWith(' admin_config'))).toBe(true);
  });
});
