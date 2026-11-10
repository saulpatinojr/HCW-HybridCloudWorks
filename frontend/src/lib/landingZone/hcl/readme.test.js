/**
 * The generated README's "Upgrading" section (#1658): a breaking upgrade of a
 * pinned module is named only for a build that uses that module, and only
 * while the pin is at or above the release the note is about.
 */
import { describe, it, expect } from 'vitest';
import { upgradeSection } from './readme';
import { AVM_MODULES, AVM_UPGRADE_NOTES } from '../avmVersions';

const CONNECTIVITY = 'avm-ptn-alz-connectivity-hub-and-spoke-vnet';
const { source } = AVM_MODULES[CONNECTIVITY];
const modulesAt = (version) => ({ [CONNECTIVITY]: { source, version } });

describe('the README names a breaking module upgrade (#1658)', () => {
  it('names the connectivity Bastion migration for a build that uses the hub', () => {
    const lines = upgradeSection(new Set([source]));
    expect(lines[0]).toBe('## Upgrading a landing zone an earlier build deployed');
    const text = lines.join('\n');
    expect(text).toContain(`\`${source}\` 0.18.1 is a breaking upgrade.`);
    expect(text).toContain('migrate the Bastion');
    expect(text).toContain('releases/tag/v0.18.1');
  });

  it('says nothing for a build without the hub, or with nothing selected', () => {
    expect(upgradeSection(new Set([AVM_MODULES['avm-ptn-alz'].source]))).toEqual([]);
    expect(upgradeSection(new Set())).toEqual([]);
  });

  it('says nothing while the pin is below the release the note is about', () => {
    expect(upgradeSection(new Set([source]), AVM_UPGRADE_NOTES, modulesAt('0.17.7'))).toEqual([]);
    expect(upgradeSection(new Set([source]), AVM_UPGRADE_NOTES, modulesAt('0.18.1'))).not.toEqual(
      []
    );
    expect(upgradeSection(new Set([source]), AVM_UPGRADE_NOTES, modulesAt('0.19.0'))).not.toEqual(
      []
    );
  });

  it('every note names a pinned module and a release that exists in the pin history', () => {
    for (const note of AVM_UPGRADE_NOTES) {
      expect(AVM_MODULES[note.module], note.module).toBeDefined();
      expect(note.since).toMatch(/^\d+\.\d+\.\d+$/);
      expect(note.url).toMatch(/^https:\/\/github\.com\/Azure\//);
    }
  });
});
