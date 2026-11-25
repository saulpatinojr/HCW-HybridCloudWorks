import { describe, expect, it } from 'vitest';
import { emitFiles } from '../index';
import { MAPPED_AZURE_REGIONS, REGION_SHAPE, nearestRegion } from './cloudRegion';
import { AWS_PRESETS, GCP_PRESETS } from '../presets';

const AZURE_SHAPE = /^[a-z]+\d?$/;

function exampleRegion(cloud, location) {
  const state = location ? { cloud, options: { location } } : { cloud };
  const text = emitFiles(state).find((f) => f.path.endsWith('terraform.tfvars.example')).content;
  return /^(?:aws|gcp)_region\s*=\s*"([^"]*)"/m.exec(text)[1];
}

// The tfvars examples once copied the builder's Azure region (`centralus`)
// into the AWS and Google Cloud packs, where it is not a region (#1875).
describe.each(['aws', 'gcp'])('the %s tfvars example', (cloud) => {
  it('never writes an Azure region id', () => {
    for (const location of [undefined, 'centralus', 'westeurope', 'nowhere1']) {
      const region = exampleRegion(cloud, location);
      expect(region, `${location} gave ${region}`).toMatch(REGION_SHAPE[cloud]);
      expect(region).not.toBe(location);
    }
  });

  it('maps every listed Azure region to a region of this cloud', () => {
    for (const azure of MAPPED_AZURE_REGIONS) {
      expect(azure).toMatch(AZURE_SHAPE);
      expect(nearestRegion(cloud, azure, 'x'), azure).toMatch(REGION_SHAPE[cloud]);
    }
  });

  it('falls back to the pack default for a region it does not know', () => {
    expect(exampleRegion(cloud, 'nowhere1')).toBe(cloud === 'aws' ? 'us-east-1' : 'us-central1');
  });
});

// AWS switches on only the regions that existed before 20 March 2019; every
// newer one stays off until the account owner opts in, and a plan there fails
// on an account that has not. This is AWS's list of regions enabled by
// default, which cannot grow: https://docs.aws.amazon.com/global-infrastructure/latest/regions/aws-regions.html
const AWS_ON_BY_DEFAULT = [
  'ap-northeast-1',
  'ap-northeast-2',
  'ap-northeast-3',
  'ap-south-1',
  'ap-southeast-1',
  'ap-southeast-2',
  'ca-central-1',
  'eu-central-1',
  'eu-north-1',
  'eu-west-1',
  'eu-west-2',
  'eu-west-3',
  'sa-east-1',
  'us-east-1',
  'us-east-2',
  'us-west-1',
  'us-west-2',
];

describe('AWS regions in the table', () => {
  it('are all switched on by default', () => {
    for (const azure of MAPPED_AZURE_REGIONS) {
      expect(AWS_ON_BY_DEFAULT, azure).toContain(nearestRegion('aws', azure, 'x'));
    }
  });
});

describe('the presets', () => {
  // The presets once named `us-east-1` / `us-central1`, which the builder's
  // location field (Azure ids only) silently replaced with `centralus`, so the
  // AWS presets wrote us-east-2.
  it.each([
    ['aws', AWS_PRESETS, 'us-east-1'],
    ['gcp', GCP_PRESETS, 'us-central1'],
  ])('%s presets write the region they mean', (cloud, presets, region) => {
    for (const preset of presets) {
      expect(exampleRegion(cloud, preset.state.options.location), preset.id).toBe(region);
    }
  });
});
