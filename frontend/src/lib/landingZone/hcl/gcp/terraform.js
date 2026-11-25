import { block, file, obj, q } from '../format';
import { TERRAFORM_REQUIRED_VERSION } from '../../terraformVersion';
import { GCP_PROVIDER_PIN } from './moduleVersions';

export function terraformTf() {
  return file(
    'terraform.tf',
    block('terraform', [
      ['required_version', q(TERRAFORM_REQUIRED_VERSION)],
      [
        'required_providers',
        obj([
          [
            'google',
            obj([
              ['source', q('hashicorp/google')],
              ['version', q(GCP_PROVIDER_PIN)],
            ]),
          ],
        ]),
      ],
    ])
  );
}
