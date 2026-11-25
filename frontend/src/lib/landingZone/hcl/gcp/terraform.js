import { block, file, obj, q } from '../format';
import { TERRAFORM_REQUIRED_VERSION } from '../../terraformVersion';
import { GCP_PROVIDER_PIN } from './moduleVersions';

export function terraformTf() {
  return file(
    'terraform.tf',
    block('terraform', [
      ['required_version', q(TERRAFORM_REQUIRED_VERSION)],
      '',
      // A nested block, not `required_providers = { … }`: Terraform refuses
      // the `=` form, so `terraform init` failed on every Google Cloud pack.
      ...block('required_providers', [
        [
          'google',
          obj([
            ['source', q('hashicorp/google')],
            ['version', q(GCP_PROVIDER_PIN)],
          ]),
        ],
      ]),
    ])
  );
}
