import { block, file, obj, q } from '../format';
import { TERRAFORM_REQUIRED_VERSION } from '../../terraformVersion';
import { AWS_PROVIDER_PIN } from './moduleVersions';

export function terraformTf() {
  return file(
    'terraform.tf',
    block('terraform', [
      ['required_version', q(TERRAFORM_REQUIRED_VERSION)],
      '',
      // A nested block, not `required_providers = { … }`: Terraform refuses
      // the `=` form, so `terraform init` failed on every AWS pack (#1862).
      ...block('required_providers', [
        [
          'aws',
          obj([
            ['source', q('hashicorp/aws')],
            ['version', q(AWS_PROVIDER_PIN)],
          ]),
        ],
      ]),
    ])
  );
}
