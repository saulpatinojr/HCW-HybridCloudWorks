import { block, file, obj, q } from '../format';
import { AWS_PROVIDER_PIN, TERRAFORM_REQUIRED_VERSION } from './moduleVersions';

export function terraformTf() {
  return file(
    'terraform.tf',
    block('terraform', [
      ['required_version', q(TERRAFORM_REQUIRED_VERSION)],
      [
        'required_providers',
        obj([
          [
            'aws',
            obj([
              ['source', q('hashicorp/aws')],
              ['version', q(AWS_PROVIDER_PIN)],
            ]),
          ],
        ]),
      ],
    ])
  );
}
