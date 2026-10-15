/**
 * Multi-Format Landing Zone Export Engine.
 * Supports:
 *  - Native Terraform HCL (default)
 *  - OpenTofu 1.8+ bundle (with client-side state encryption block and tofu CLI workflows)
 *  - Terragrunt bundle (with root terragrunt.hcl, DRY state, and run-all CLI workflows)
 */

export const SUPPORTED_FORMATS = Object.freeze(['terraform', 'opentofu', 'terragrunt']);

export const FORMAT_LABELS = Object.freeze({
  terraform: 'Terraform HCL',
  opentofu: 'OpenTofu 1.8+',
  terragrunt: 'Terragrunt',
});

/**
 * OpenTofu 1.8+ root configuration with client-side state encryption.
 */
export function tofuTf() {
  return {
    path: 'tofu.tf',
    content: `# OpenTofu 1.8+ Root Configuration
# Features OpenTofu client-side state encryption (AES-GCM PBKDF2)
terraform {
  required_version = ">= 1.8.0"

  encryption {
    key_provider "pbkdf2" "passphrase" {
      passphrase = "tofu-landing-zone-key"
    }

    method "aes_gcm" "default" {
      keys = key_provider.pbkdf2.passphrase
    }

    state {
      method   = method.aes_gcm.default
      enforced = true
    }
  }
}
`,
  };
}

/**
 * Root terragrunt.hcl configuration for DRY remote state and inputs.
 */
export function rootTerragruntHcl(cloud = 'azure') {
  return {
    path: 'terragrunt.hcl',
    content: `# Root Terragrunt Configuration
# DRY local/remote state and module variable inheritance
remote_state {
  backend = "local"
  generate = {
    path      = "backend.tf"
    if_exists = "overwrite_terragrunt"
  }
  config = {
    path = "terraform.tfstate"
  }
}

inputs = {
  cloud_target = "${cloud}"
  environment  = "production"
}
`,
  };
}

/**
 * Transform standard Terraform files into OpenTofu or Terragrunt bundles.
 *
 * @param {Array<{ path: string, content: string }>} files
 * @param {'terraform'|'opentofu'|'terragrunt'} format
 * @param {object} [state]
 * @returns {Array<{ path: string, content: string }>}
 */
export function transformBundle(files, format = 'terraform', state = {}) {
  if (!format || format === 'terraform') {
    return files;
  }

  const cloud = state?.cloud || state?.options?.cloud || 'azure';

  if (format === 'opentofu') {
    return files.map((file) => {
      if (file.path === 'terraform.tf') {
        return tofuTf();
      }
      if (file.path === 'README.md') {
        let tofuContent = file.content
          .replace(/terraform init/g, 'tofu init')
          .replace(/terraform validate/g, 'tofu validate')
          .replace(/terraform fmt/g, 'tofu fmt')
          .replace(/terraform plan/g, 'tofu validate\ntofu plan')
          .replace(/Terraform/g, 'OpenTofu');

        if (!tofuContent.includes('tofu validate')) {
          tofuContent = tofuContent.replace('tofu plan', 'tofu validate\ntofu plan');
        }

        tofuContent = tofuContent.replace(
          '## Running it',
          '## OpenTofu 1.8+ Security\n\nState is encrypted at rest using AES-GCM (see `tofu.tf`).\n\n## Running it'
        );

        return { ...file, content: tofuContent };
      }
      return file;
    });
  }

  if (format === 'terragrunt') {
    const rootHcl = rootTerragruntHcl(cloud);
    const updatedFiles = files.map((file) => {
      if (file.path === 'README.md') {
        let tgContent = file.content
          .replace(/terraform init/g, 'terragrunt run-all init')
          .replace(/terraform validate/g, 'terragrunt run-all validate')
          .replace(/terraform plan/g, 'terragrunt run-all validate\nterragrunt run-all plan')
          .replace(/Terraform/g, 'Terragrunt');

        if (!tgContent.includes('terragrunt run-all validate')) {
          tgContent = tgContent.replace(
            'terragrunt run-all plan',
            'terragrunt run-all validate\nterragrunt run-all plan'
          );
        }

        tgContent = tgContent.replace(
          '## Running it',
          '## Terragrunt Harness\n\nAll landing zone modules are orchestrated via the root `terragrunt.hcl` harness.\n\n## Running it'
        );

        return { ...file, content: tgContent };
      }
      return file;
    });

    return [rootHcl, ...updatedFiles];
  }

  return files;
}
