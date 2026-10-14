import { block, file } from '../format';

export function providersTf() {
  return file('providers.tf', block('provider "google"', [['region', 'var.gcp_region']]));
}
