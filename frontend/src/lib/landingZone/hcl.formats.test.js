import { describe, expect, it } from 'vitest';
import {
  DEFAULT_STATE,
  emitFiles,
  FORMAT_LABELS,
  SUPPORTED_FORMATS,
  transformBundle,
} from './index';
import { rootTerragruntHcl, tofuTf } from './hcl/formats';

describe('Landing Zone Multi-Format Export Engine', () => {
  it('exposes the supported format identifiers and human labels', () => {
    expect(SUPPORTED_FORMATS).toEqual(['terraform', 'opentofu', 'terragrunt']);
    expect(FORMAT_LABELS.terraform).toBe('Terraform HCL');
    expect(FORMAT_LABELS.opentofu).toBe('OpenTofu 1.8+');
    expect(FORMAT_LABELS.terragrunt).toBe('Terragrunt');
  });

  it('emits standard native Terraform by default without modifications', () => {
    const defaultFiles = emitFiles(DEFAULT_STATE);
    const terraformFiles = emitFiles(DEFAULT_STATE, 'terraform');
    expect(defaultFiles.map((f) => f.path)).toEqual(terraformFiles.map((f) => f.path));
    expect(defaultFiles.find((f) => f.path === 'terraform.tf')).toBeDefined();
    expect(defaultFiles.find((f) => f.path === 'tofu.tf')).toBeUndefined();
    expect(defaultFiles.find((f) => f.path === 'terragrunt.hcl')).toBeUndefined();
  });

  it('emits OpenTofu bundle with tofu.tf and client-side state encryption', () => {
    const tofuFiles = emitFiles(DEFAULT_STATE, 'opentofu');
    expect(tofuFiles.find((f) => f.path === 'terraform.tf')).toBeUndefined();
    const tofuFile = tofuFiles.find((f) => f.path === 'tofu.tf');
    expect(tofuFile).toBeDefined();
    expect(tofuFile.content).toContain('encryption {');
    expect(tofuFile.content).toContain('key_provider "pbkdf2" "passphrase"');
    expect(tofuFile.content).toContain('method   = method.aes_gcm.default');

    const readme = tofuFiles.find((f) => f.path === 'README.md');
    expect(readme).toBeDefined();
    expect(readme.content).toContain('tofu init');
    expect(readme.content).toContain('tofu validate');
    expect(readme.content).toContain('State is encrypted at rest using AES-GCM');
  });

  it('emits Terragrunt bundle with root terragrunt.hcl and run-all commands', () => {
    const tgFiles = emitFiles(DEFAULT_STATE, 'terragrunt');
    const rootHcl = tgFiles.find((f) => f.path === 'terragrunt.hcl');
    expect(rootHcl).toBeDefined();
    expect(rootHcl.content).toContain('remote_state {');
    expect(rootHcl.content).toContain('backend = "local"');
    expect(rootHcl.content).toContain('cloud_target = "azure"');

    const readme = tgFiles.find((f) => f.path === 'README.md');
    expect(readme).toBeDefined();
    expect(readme.content).toContain('terragrunt run-all init');
    expect(readme.content).toContain('terragrunt run-all validate');
    expect(readme.content).toContain('root `terragrunt.hcl` harness');
  });

  it('correctly adapts Terragrunt cloud target for AWS and GCP states', () => {
    const awsFiles = emitFiles({ cloud: 'aws' }, 'terragrunt');
    const awsRoot = awsFiles.find((f) => f.path === 'terragrunt.hcl');
    expect(awsRoot.content).toContain('cloud_target = "aws"');

    const gcpFiles = emitFiles({ cloud: 'gcp' }, 'terragrunt');
    const gcpRoot = gcpFiles.find((f) => f.path === 'terragrunt.hcl');
    expect(gcpRoot.content).toContain('cloud_target = "gcp"');
  });

  it('generates tofu.tf and terragrunt.hcl objects directly', () => {
    const tofuFile = tofuTf();
    expect(tofuFile.path).toBe('tofu.tf');
    expect(tofuFile.content).toContain('encryption');

    const tgFile = rootTerragruntHcl('azure');
    expect(tgFile.path).toBe('terragrunt.hcl');
    expect(tgFile.content).toContain('remote_state');

    const transformed = transformBundle(
      [{ path: 'terraform.tf', content: 'test' }],
      'opentofu',
      DEFAULT_STATE
    );
    expect(transformed.some((f) => f.path === 'tofu.tf')).toBe(true);
  });
});
