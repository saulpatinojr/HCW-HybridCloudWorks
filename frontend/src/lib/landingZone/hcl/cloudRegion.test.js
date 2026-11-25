import { describe, expect, it } from 'vitest';
import { emitFiles } from '../index';
import { MAPPED_AZURE_REGIONS, REGION_SHAPE, nearestRegion } from './cloudRegion';

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
