/**
 * The lab catalogue is data the pages trust without checking, so this is
 * where it is checked (#681, ADR 0033 §4): every row has every field with the
 * right shape, ids are unique and usable as a Coder parameter, providers,
 * difficulties, tools and validation job types come from the fixed lists,
 * steps are ordered prose with at most one runner check each, and the pane's
 * address carries the row's own id under its provider. The workspace names
 * are checked against the lab launcher's own map, which is lab-host's to
 * change, the way #758 checks the sign-in path against its Caddy route.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { VALID_PROVIDERS } from '@/context/ProviderContext';
import { FALLBACK_JOB_TYPES } from '@/components/admin/labs/labsView';
import {
  CODER_APPS_ORIGIN,
  CODER_GITHUB_SIGN_IN_PATH,
  CODER_ORIGIN,
  DIFFICULTY_LABELS,
  LAB_DIFFICULTIES,
  LAB_FIELDS,
  LAB_LAUNCHER_PATH,
  LAB_PROVIDERS,
  LAB_STATUSES,
  LAB_TEMPLATE,
  LAB_TOOLS,
  LAB_VALIDATION_JOB_TYPES,
  RUN_LOCALLY_COMMANDS,
  allLabArticles,
  articlePath,
  availableLabs,
  coderSignInUrl,
  labById,
  labLauncherUrl,
  labPanePath,
  labs,
  labsByProvider,
  labsForProvider,
  labsPath,
  primaryProvider,
  providersWithLabs,
} from './catalogue';

/** A lab-host file, as text: those files are lab-host's to change, and these tests say what the site relies on. */
const labHostFile = (path) => readFileSync(join(process.cwd(), '..', 'lab-host', path), 'utf8');

/** The launcher's LAB_WORKSPACES, read from its source as `{ id: name }`. */
function launcherWorkspaces() {
  const source = labHostFile('coder/launcher/launcher.js');
  const block = source.match(/export const LAB_WORKSPACES = Object\.freeze\(\{([^}]*)\}\);/);
  if (!block)
    throw new Error('lab-host/coder/launcher/launcher.js no longer declares LAB_WORKSPACES');
  return Object.fromEntries(
    [...block[1].matchAll(/'([a-z0-9-]+)':\s*'([a-z0-9-]+)'/g)].map(([, id, name]) => [id, name])
  );
}

/** The ids the workspace template accepts, from its parameter's regex. */
function templateLabIds() {
  const template = labHostFile('coder/templates/hcw-lab/main.tf');
  const regex = template.match(/regex = "\^\(([^)]+)\)\$"/);
  if (!regex) throw new Error('hcw-lab/main.tf no longer validates the lab parameter with a regex');
  return regex[1].split('|');
}

const isNonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0;

describe('lab catalogue', () => {
  it('has the nine labs', () => {
    expect(labs.map((lab) => lab.id)).toEqual([
      'landing-zone-builder-output',
      'wsl-containers-walkthrough',
      'defender-wsl-plugin-walkthrough',
      'aws-transit-gateway-walkthrough',
      'gcp-shared-vpc-walkthrough',
      'vmware-hcx-migration-walkthrough',
      'terraform-validate-walkthrough',
      'ansible-syntax-check-walkthrough',
      'docker-sandbox-agent-walkthrough',
    ]);
  });

  it.each(labs.map((lab) => [lab.id, lab]))('%s carries every field', (id, lab) => {
    for (const field of LAB_FIELDS) {
      expect(lab, `${id} is missing ${field}`).toHaveProperty(field);
    }
    const extras = lab.status === 'coming' ? ['comingSince', 'comingReason'] : [];
    expect(Object.keys(lab).sort()).toEqual([...LAB_FIELDS, ...extras].sort());

    expect(lab.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    // Coder's rule for a name, and short enough that code-server's address,
    // code-server--<workspace>--<owner>, fits one DNS label (63) with a
    // 32-character Coder username.
    expect(lab.workspaceName).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(lab.workspaceName.length).toBeLessThanOrEqual(16);
    expect(`code-server--${lab.workspaceName}--${'u'.repeat(32)}`.length).toBeLessThanOrEqual(63);
    expect(lab.title.trim().length).toBeGreaterThan(0);
    expect(lab.summary.trim().length).toBeGreaterThan(40);
    expect(lab.tools.length).toBeGreaterThan(0);
    for (const tool of lab.tools) {
      expect(LAB_TOOLS, `${id} names a tool the image does not ship: ${tool}`).toContain(tool);
    }
    expect(lab.template).toBe(LAB_TEMPLATE);
    expect(lab.params).toEqual({ lab: id });
    expect(Number.isInteger(lab.estimatedMinutes)).toBe(true);
    expect(lab.estimatedMinutes).toBeGreaterThan(0);
  });

  it.each(labs.map((lab) => [lab.id, lab]))(
    '%s is placed under known providers, a difficulty and a status',
    (id, lab) => {
      expect(lab.providers.length).toBeGreaterThan(0);
      expect(new Set(lab.providers).size).toBe(lab.providers.length);
      for (const provider of lab.providers) {
        expect(LAB_PROVIDERS, `${id} names an unknown provider: ${provider}`).toContain(provider);
      }
      expect(lab.technology.length).toBeGreaterThan(0);
      for (const tech of lab.technology) expect(tech).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(LAB_DIFFICULTIES).toContain(lab.difficulty);
      expect(LAB_STATUSES).toContain(lab.status);
      if (lab.status === 'coming') {
        // Nothing is promised without a date and a reason (ADR 0033).
        expect(lab.comingSince).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(isNonEmptyString(lab.comingReason)).toBe(true);
      }
    }
  );

  it.each(labs.map((lab) => [lab.id, lab]))('%s teaches something, in steps', (id, lab) => {
    expect(lab.objectives.length).toBeGreaterThanOrEqual(3);
    expect(lab.prerequisites.length).toBeGreaterThanOrEqual(1);
    for (const line of [...lab.objectives, ...lab.prerequisites]) {
      expect(isNonEmptyString(line)).toBe(true);
    }
    expect(lab.steps.length).toBeGreaterThanOrEqual(3);
    const checks = lab.steps.filter((entry) => entry.validation);
    for (const entry of lab.steps) {
      expect(isNonEmptyString(entry.title)).toBe(true);
      expect(isNonEmptyString(entry.body)).toBe(true);
      // A fenced block that opens must close, or the page renders the rest
      // of the step as code.
      expect((entry.body.match(/```/g) || []).length % 2).toBe(0);
      if (entry.validation) {
        expect(LAB_VALIDATION_JOB_TYPES).toContain(entry.validation.jobType);
        expect(isNonEmptyString(entry.validation.hint)).toBe(true);
      }
    }
    // The step a runner can check names the lab's own validation job type.
    expect(checks.length).toBeLessThanOrEqual(1);
    if (lab.validation) {
      expect(checks).toHaveLength(1);
      expect(checks[0].validation.jobType).toBe(lab.validation.jobType);
    }
    expect(lab.resources.length).toBeGreaterThanOrEqual(1);
    for (const entry of lab.resources) {
      expect(isNonEmptyString(entry.label)).toBe(true);
      expect(entry.url).toMatch(/^(\/|https:\/\/)/);
    }
  });

  it.each(labs.map((lab) => [lab.id, lab]))(
    '%s names a validation the runner can perform, with a sample that fits',
    (id, lab) => {
      if (!lab.validation) return;
      expect(LAB_VALIDATION_JOB_TYPES).toContain(lab.validation.jobType);
      const type = FALLBACK_JOB_TYPES.find((entry) => entry.type === lab.validation.jobType);
      expect(type, `${id} names a job type the runner does not offer`).toBeDefined();
      expect(type.payloadEncodings).toContain(lab.validation.payloadEncoding);
      expect(isNonEmptyString(lab.validation.samplePayload)).toBe(true);
      // The smallest payload cap any checking job type has (labs.js).
      expect(Buffer.byteLength(lab.validation.samplePayload, 'utf8')).toBeLessThanOrEqual(4 * 1024);
    }
  );

  it('keeps its fixed lists honest', () => {
    for (const provider of LAB_PROVIDERS) expect(VALID_PROVIDERS).toContain(provider);
    expect(Object.keys(DIFFICULTY_LABELS).sort()).toEqual([...LAB_DIFFICULTIES].sort());
    const runnerTypes = FALLBACK_JOB_TYPES.map((entry) => entry.type);
    for (const type of LAB_VALIDATION_JOB_TYPES) expect(runnerTypes).toContain(type);
    expect(LAB_VALIDATION_JOB_TYPES).not.toContain('shell-echo');
  });

  it('gives no two labs the same id, or the same workspace', () => {
    const ids = labs.map((lab) => lab.id);
    expect(new Set(ids).size).toBe(ids.length);
    const names = labs.map((lab) => lab.workspaceName);
    expect(new Set(names).size).toBe(names.length);
  });

  it('names each workspace exactly as the lab launcher does', () => {
    expect(launcherWorkspaces()).toEqual(
      Object.fromEntries(labs.map((lab) => [lab.id, lab.workspaceName]))
    );
  });

  it('offers exactly the labs the workspace template accepts', () => {
    expect([...templateLabIds()].sort()).toEqual(labs.map((lab) => lab.id).sort());
  });

  it('is frozen, rows included', () => {
    expect(Object.isFrozen(labs)).toBe(true);
    for (const lab of labs) {
      expect(Object.isFrozen(lab), `${lab.id} is mutable`).toBe(true);
      for (const key of [
        'providers',
        'technology',
        'tools',
        'objectives',
        'prerequisites',
        'steps',
        'resources',
        'params',
        'articleSlugs',
      ]) {
        expect(Object.isFrozen(lab[key]), `${lab.id}.${key} is mutable`).toBe(true);
      }
    }
  });

  it('names every tool and nothing the pane page may not say', () => {
    // LabPanePage.test.jsx holds the rendered page to this; the rows are
    // where the words come from, so the rule is checked at the source too.
    const behindTheSite = /\bcoder\b|oauth|code-server|\bvps\b|callback|caddy|hostinger|\bapi\b/i;
    for (const lab of labs) {
      const words = JSON.stringify(lab);
      expect(words, `${lab.id} names something behind the site`).not.toMatch(behindTheSite);
    }
  });
});

describe('the lists the pages derive', () => {
  it('lists only available labs publicly', () => {
    expect(availableLabs.every((lab) => lab.status === 'available')).toBe(true);
    expect(availableLabs.length).toBe(labs.length);
  });

  it('filters by provider, and groups the index by it', () => {
    expect(labsForProvider('terraform').map((lab) => lab.id)).toEqual([
      'landing-zone-builder-output',
      'terraform-validate-walkthrough',
    ]);
    expect(labsForProvider('azure').map((lab) => lab.id)).toEqual([
      'landing-zone-builder-output',
      'wsl-containers-walkthrough',
      'defender-wsl-plugin-walkthrough',
    ]);
    expect(labsForProvider('aws').map((lab) => lab.id)).toEqual([
      'aws-transit-gateway-walkthrough',
    ]);
    expect(labsForProvider('gcp').map((lab) => lab.id)).toEqual(['gcp-shared-vpc-walkthrough']);
    expect(labsForProvider('vmware').map((lab) => lab.id)).toEqual([
      'vmware-hcx-migration-walkthrough',
    ]);
    expect(labsForProvider('ansible').map((lab) => lab.id)).toEqual([
      'ansible-syntax-check-walkthrough',
    ]);
    expect(labsForProvider('docker').map((lab) => lab.id)).toEqual([
      'docker-sandbox-agent-walkthrough',
    ]);
    // The index prints each lab once, under its home provider.
    expect(
      labsByProvider().map((group) => [group.provider, group.labs.map((lab) => lab.id)])
    ).toEqual([
      [
        'azure',
        [
          'landing-zone-builder-output',
          'wsl-containers-walkthrough',
          'defender-wsl-plugin-walkthrough',
        ],
      ],
      ['aws', ['aws-transit-gateway-walkthrough']],
      ['gcp', ['gcp-shared-vpc-walkthrough']],
      ['vmware', ['vmware-hcx-migration-walkthrough']],
      ['terraform', ['terraform-validate-walkthrough']],
      ['ansible', ['ansible-syntax-check-walkthrough']],
      ['docker', ['docker-sandbox-agent-walkthrough']],
    ]);
    expect(providersWithLabs()).toEqual([
      'azure',
      'aws',
      'gcp',
      'vmware',
      'terraform',
      'ansible',
      'docker',
    ]);
  });

  it('knows each lab’s home provider', () => {
    expect(primaryProvider(labById('landing-zone-builder-output'))).toBe('azure');
    expect(primaryProvider(labById('terraform-validate-walkthrough'))).toBe('terraform');
  });

  it('points at published articles once each', () => {
    const articles = allLabArticles();
    expect(articles.map(articlePath)).toEqual([
      '/azure/blog/build-a-landing-zone-you-can-read',
      '/terraform/blog/follow-along-in-one-container',
      '/terraform/blog/let-an-agent-explain-it',
    ]);
    for (const entry of labs.flatMap((lab) => lab.articleSlugs)) {
      expect(VALID_PROVIDERS).toContain(entry.provider);
      expect(entry.slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(isNonEmptyString(entry.title)).toBe(true);
    }
  });
});

describe('labLauncherUrl', () => {
  it('opens the lab launcher on Coder’s name, told which lab', () => {
    for (const lab of labs) {
      expect(labLauncherUrl(lab)).toBe(
        `https://coder.lab.hybridcloudworks.com/_hcw/lab/?lab=${lab.id}`
      );
    }
  });

  it('encodes an id that is not a plain query value', () => {
    expect(labLauncherUrl({ id: 'x&y=z' })).toBe(`${CODER_ORIGIN}/_hcw/lab/?lab=x%26y%3Dz`);
  });

  it('keeps the launcher’s path in step with the Caddy route that serves it', () => {
    // The route is lab-host's to change; if it moves, every pane would load
    // a Coder page that does not exist instead of the launcher.
    expect(labHostFile('ansible/roles/coder/templates/10-coder.caddy.j2')).toContain(
      `  path ${LAB_LAUNCHER_PATH}*\n`
    );
  });
});

describe('the pane page and its sign-in (#751, ADR 0033 routes)', () => {
  it('gives every lab a pane page under each of its providers, and one under the index', () => {
    for (const lab of labs) {
      for (const provider of lab.providers) {
        expect(labPanePath(provider, lab.id)).toBe(`/${provider}/education/labs/${lab.id}`);
      }
      expect(labPanePath(null, lab.id)).toBe(`/education/labs/${lab.id}`);
    }
    expect(labPanePath('azure', 'a/b?c')).toBe('/azure/education/labs/a%2Fb%3Fc');
    expect(labPanePath(null, 'a/b?c')).toBe('/education/labs/a%2Fb%3Fc');
  });

  it('gives every provider a list, and the index its own', () => {
    expect(labsPath('terraform')).toBe('/terraform/education/labs');
    expect(labsPath()).toBe('/education/labs');
    expect(labsPath(null)).toBe('/education/labs');
  });

  it('finds a lab by id, and nothing for an id the catalogue does not have', () => {
    for (const lab of labs) expect(labById(lab.id)).toBe(lab);
    expect(labById('no-such-lab')).toBeNull();
    expect(labById(undefined)).toBeNull();
  });

  it('starts GitHub sign-in at the one path #750 lets through at the top level', () => {
    expect(CODER_GITHUB_SIGN_IN_PATH).toBe('/api/v2/users/oauth2/github/callback');
    expect(coderSignInUrl()).toBe(
      'https://coder.lab.hybridcloudworks.com/api/v2/users/oauth2/github/callback?redirect=%2F'
    );
  });

  it('keeps the sign-in path in step with the Caddy exemption it relies on', () => {
    // #750's exemption is lab-host's to change; if it moves, this page's
    // sign-in tab would be redirected before GitHub is ever reached.
    const caddy = labHostFile('ansible/roles/coder/templates/10-coder.caddy.j2');
    expect(caddy).toContain(`path ${CODER_GITHUB_SIGN_IN_PATH}\n`);
  });

  it('names the apps origin one label below Coder, and nothing broader', () => {
    expect(CODER_APPS_ORIGIN).toBe(CODER_ORIGIN.replace('https://', 'https://*.'));
  });
});

describe('RUN_LOCALLY_COMMANDS', () => {
  it('is PowerShell then bash, with the exact lines the page prints', () => {
    expect(RUN_LOCALLY_COMMANDS.map((entry) => entry.shell)).toEqual(['PowerShell', 'bash']);
    expect(RUN_LOCALLY_COMMANDS[0].command).toBe(
      'docker run --rm -it -v ${PWD}:/workspace hybridcloudworks/hcw-lab:latest'
    );
    expect(RUN_LOCALLY_COMMANDS[1].command).toBe(
      'docker run --rm -it -v "$PWD":/workspace hybridcloudworks/hcw-lab:latest'
    );
  });

  it('carries no comment inside a command', () => {
    for (const { command } of RUN_LOCALLY_COMMANDS) {
      expect(command).not.toMatch(/#/);
      expect(command).not.toMatch(/\n/);
    }
  });
});
