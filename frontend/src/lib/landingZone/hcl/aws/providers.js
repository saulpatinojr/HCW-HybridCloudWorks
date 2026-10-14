import { block, file, obj, q } from '../format';

export function providersTf() {
  return file(
    'providers.tf',
    block('provider "aws"', [
      ['region', 'var.aws_region'],
      [
        'default_tags',
        obj([
          [
            'tags',
            obj([
              ['ManagedBy', q('Terraform')],
              ['Architecture', q('AWS Landing Zone Foundation')],
              ['Framework', q('Enterprise Reference Blueprint')],
            ]),
          ],
        ]),
      ],
    ])
  );
}
