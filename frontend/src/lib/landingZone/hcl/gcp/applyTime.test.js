/**
 * The Google Cloud pack passes `terraform init`, `validate` and `fmt`, but
 * three things in it only fail at `terraform apply` (#1870). Nothing here
 * runs Terraform: each test reads the generated HCL and checks that the
 * wiring which prevents the failure is in place.
 *
 *  1. Service projects must wait for the Shared VPC subnets they attach to,
 *     so their subnet paths come from the network module's outputs.
 *  2. The organisation log sink writes as its own Google identity, which
 *     needs permission to create objects in the bucket.
 *  3. GitHub signs every repository's tokens with one issuer, so the
 *     workload identity provider must only accept the user's organisation.
 */
import { describe, it, expect } from 'vitest';
import { emitFiles } from '../../index';

const pack = (state = {}) =>
  Object.fromEntries(emitFiles({ cloud: 'gcp', ...state }).map((f) => [f.path, f.content]));

/** Every top-level block whose header starts with `header`, as text. */
function blocksOf(text, header) {
  const lines = text.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].startsWith(header)) continue;
    let end = i;
    while (end < lines.length && lines[end] !== '}') end += 1;
    out.push(lines.slice(i, end + 1).join('\n'));
  }
  return out;
}

/** The value of `name = …` in a block, up to the end of a list if it is one. */
function attr(blockText, name) {
  const m = new RegExp(`^\\s*${name}\\s*=\\s*(\\[[\\s\\S]*?\\n\\s*\\]|.*)$`, 'm').exec(blockText);
  return m ? m[1].trim() : undefined;
}

describe('service projects attach to subnets Terraform has already made (#1870)', () => {
  const files = pack({ options: { corpCount: 2, onlineCount: 2 } });
  const projects = blocksOf(files['projects.tf'], 'module ');

  it('emits one project-factory call per requested project', () => {
    expect(projects).toHaveLength(4);
  });

  it.each([0, 1, 2, 3])('project %i takes its subnets from the network module', (i) => {
    const subnets = attr(projects[i], 'shared_vpc_subnets');
    expect(subnets, 'shared_vpc_subnets').toBeDefined();
    // A typed-out "projects/…/subnetworks/…" path gives Terraform nothing to
    // order by, so it may try to attach before the subnet exists.
    expect(subnets).not.toMatch(/"projects\//);
    const refs = [...subnets.matchAll(/module\.shared_vpc_host\.subnets\["([^"]+)"\]\.id/g)];
    expect(refs.length, subnets).toBeGreaterThan(0);
    // Each key is "<region>/<name>" for a subnet the network module really
    // declares, in the region it declares them in.
    const network = files['shared-vpc.tf'];
    expect(network).toMatch(/subnet_region\s*=\s*var\.gcp_region/);
    for (const [, keyText] of refs) {
      const [region, name] = keyText.split('/');
      expect(region).toBe('\${var.gcp_region}');
      expect(network).toMatch(new RegExp(`subnet_name\\s*=\\s*"${name}"`));
    }
  });

  it.each([0, 1, 2, 3])('project %i names the host project through the network module', (i) => {
    // The attachment also needs the host project switched on as a Shared
    // VPC host, which the network module does.
    expect(attr(projects[i], 'svpc_host_project_id')).toBe('module.shared_vpc_host.project_id');
  });

  it('never emits projects without the network they reference', () => {
    // corp and online depend on connectivity-hub, so asking for them alone
    // still brings the Shared VPC file with it.
    for (const selected of [['corp'], ['online'], ['corp', 'online']]) {
      const only = pack({ selected });
      expect(only['projects.tf'], selected.join()).toBeDefined();
      expect(only['shared-vpc.tf'], selected.join()).toContain('module "shared_vpc_host"');
    }
  });
});

describe('the organisation log sink may write to its bucket (#1870)', () => {
  const sinkFile = pack()['logging-sink.tf'];

  it("grants the sink's writer identity object creation on the bucket", () => {
    // log-export's storage destination grants roles/storage.objectCreator to
    // whatever identity it is given; a plain bucket would need its own grant.
    const viaModule = blocksOf(sinkFile, 'module ').some(
      (b) =>
        b.includes('"terraform-google-modules/log-export/google//modules/storage"') &&
        attr(b, 'log_sink_writer_identity') === 'module.org_log_export.writer_identity'
    );
    const viaGrant = blocksOf(sinkFile, 'resource "google_storage_bucket_iam_member"').some(
      (b) =>
        attr(b, 'role') === '"roles/storage.objectCreator"' &&
        attr(b, 'member') === 'module.org_log_export.writer_identity'
    );
    expect(viaModule || viaGrant, sinkFile).toBe(true);
  });

  it('sends the sink to the bucket that carries the grant', () => {
    const [sink] = blocksOf(sinkFile, 'module "org_log_export"');
    expect(attr(sink, 'destination_uri')).toBe('module.audit_destination_bucket.destination_uri');
  });
});

describe('GitHub sign-in accepts only the named organisation (#1870)', () => {
  const files = pack();
  const [provider] = blocksOf(
    files['identity.tf'],
    'resource "google_iam_workload_identity_pool_provider"'
  );

  it('maps the repository owner claim', () => {
    expect(provider).toMatch(/"attribute\.repository_owner"\s*=\s*"assertion\.repository_owner"/);
  });

  it('has an attribute condition built from the organisation variable', () => {
    const condition = attr(provider, 'attribute_condition');
    expect(condition, 'attribute_condition').toBeDefined();
    expect(condition).toBe('"assertion.repository_owner == \'\${var.github_organization}\'"');
  });

  it('declares the organisation as a required, checked variable', () => {
    const [variable] = blocksOf(files['variables.tf'], 'variable "github_organization"');
    expect(variable, 'variable "github_organization"').toBeDefined();
    // No default: a pack that has not been told the organisation must stop.
    expect(attr(variable, 'default')).toBeUndefined();
    // The value lands inside a quoted CEL string, so only the characters a
    // GitHub name can have are let through.
    expect(variable).toContain('validation {');
    expect(variable).toContain('can(regex(');
    expect(files['terraform.tfvars.example']).toMatch(/^github_organization\s*=\s*"/m);
  });

  it('asks for the organisation only when the GitHub sign-in is emitted', () => {
    const without = pack({ selected: ['management-groups', 'policy'] });
    expect(without['identity.tf']).toBeUndefined();
    expect(without['variables.tf']).not.toContain('github_organization');
    expect(without['terraform.tfvars.example']).not.toContain('github_organization');
  });

  it('tells the reader in the README', () => {
    expect(files['README.md']).toContain('github_organization');
  });
});
