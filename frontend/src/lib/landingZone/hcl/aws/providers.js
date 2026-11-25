import { block, file, obj, q } from '../format';

export function providersTf() {
  return file(
    'providers.tf',
    block('provider "aws"', [
      ['region', 'var.aws_region'],
      // `default_tags` is a nested block in the aws provider, not an attribute.
      ...block('default_tags', [
        [
          'tags',
          obj([
            ['ManagedBy', q('Terraform')],
            ['Architecture', q('AWS Landing Zone Foundation')],
            ['Framework', q('Enterprise Reference Blueprint')],
          ]),
        ],
      ]),
    ])
  );
}
