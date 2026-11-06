/**
 * The interview container's layout, pinned (ADR 0040 D10, #1565).
 *
 * The lifecycle rule in infra/storage.tf expires `interviews-audio/audio/`
 * and nothing else, so the two prefixes here are a contract with Terraform:
 * a recording that landed anywhere but `audio/` would be kept for ever, and
 * a transcript that landed under `audio/` would be deleted with the
 * recording. The test reads the Terraform file so the two cannot drift apart.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  AUDIO_TYPES,
  INTERVIEWS_AUDIO_CONTAINER,
  MAX_AUDIO_BYTES,
  MAX_AUDIO_SECONDS,
  audioBlobPath,
  canonicalAudioType,
  transcriptBlobPath,
  transcriptPartPath,
} from './storage.js';
import { isValidBlobPath, PUBLIC_MEDIA_CONTAINERS, UPLOAD_CONTAINERS } from '../blob-paths.js';

const STORAGE_TF = readFileSync(
  fileURLToPath(new URL('../../../../infra/storage.tf', import.meta.url)),
  'utf8'
);

describe('interviews storage layout', () => {
  it('names the container Terraform declares, with the lifecycle rule on the audio prefix only', () => {
    expect(STORAGE_TF).toContain(`name                  = "${INTERVIEWS_AUDIO_CONTAINER}"`);
    expect(STORAGE_TF).toContain(`prefix_match = ["${INTERVIEWS_AUDIO_CONTAINER}/audio/"]`);
    expect(STORAGE_TF).not.toContain(`${INTERVIEWS_AUDIO_CONTAINER}/transcripts/`);
  });

  /**
   * The names of the lifecycle rules in a policy text that are enabled, name
   * no prefix_match and carry a base_blob delete: such a rule reaches
   * transcripts/ (and everything else on the account). Comments are dropped
   * first, so a prefix that is only commented out does not count as one. The
   * account-wide rule that expires previous versions only is not an offender.
   */
  const unfilteredBaseBlobDeleteRules = (text) => {
    const code = text.replace(/^\s*#.*$/gm, '').replace(/\/\/.*$/gm, '');
    const policy = code.slice(code.indexOf('resource "azurerm_storage_management_policy" "cleanup"'));
    return policy
      .split(/\n\s*rule \{/)
      .slice(1)
      .filter(
        (rule) =>
          /enabled\s*=\s*true/.test(rule) &&
          !/prefix_match\s*=/.test(rule) &&
          /base_blob\s*\{[^}]*delete_after/s.test(rule)
      )
      .map((rule) => (rule.match(/name\s*=\s*"([^"]+)"/) ?? [])[1]);
  };

  it('no lifecycle rule without a prefix deletes base blobs, so transcripts are never expired by a rule that reaches them', () => {
    expect(STORAGE_TF.split(/\n\s*rule \{/).length - 1).toBeGreaterThanOrEqual(5);
    expect(unfilteredBaseBlobDeleteRules(STORAGE_TF)).toEqual([]);
  });

  it('the guard reads code, not comments: a prefix that is commented out does not exempt a rule', () => {
    const withPrefix = `resource "azurerm_storage_management_policy" "cleanup" {
  rule {
    name    = "expire-interview-audio"
    enabled = true
    filters {
      prefix_match = ["interviews-audio/audio/"]
      blob_types   = ["blockBlob"]
    }
    actions {
      base_blob {
        delete_after_days_since_creation_greater_than = 365
      }
    }
  }
}`;
    expect(unfilteredBaseBlobDeleteRules(withPrefix)).toEqual([]);
    const commentedOut = withPrefix.replace('      prefix_match', '      # prefix_match');
    expect(unfilteredBaseBlobDeleteRules(commentedOut)).toEqual(['expire-interview-audio']);
    const versionsOnly = withPrefix.replace('base_blob', 'version').replace('delete_after_days_since_creation_greater_than', 'delete_after_days_since_creation');
    expect(unfilteredBaseBlobDeleteRules(versionsOnly.replace('      prefix_match', '      # prefix_match'))).toEqual([]);
  });

  it('is neither publicly served nor reachable from the generic upload route', () => {
    expect(PUBLIC_MEDIA_CONTAINERS.has(INTERVIEWS_AUDIO_CONTAINER)).toBe(false);
    expect(UPLOAD_CONTAINERS.has(INTERVIEWS_AUDIO_CONTAINER)).toBe(false);
  });

  it('keeps recordings under audio/, one blob per upload session, and transcripts under transcripts/', () => {
    const upload = '11111111-2222-4333-8444-555555555555';
    expect(audioBlobPath('abc', upload, 'mp3')).toBe(`audio/abc/${upload}.mp3`);
    expect(audioBlobPath('abc', upload, 'mp3')).not.toBe(audioBlobPath('abc', '22222222-2222-4333-8444-555555555555', 'mp3'));
    expect(transcriptBlobPath('abc', 1)).toBe('transcripts/abc/v1.json');
    expect(transcriptPartPath('abc', 2, 7)).toBe('transcripts/abc/v2.parts/007.json');
    for (const path of [audioBlobPath('abc', upload, 'wav'), transcriptBlobPath('abc', 3), transcriptPartPath('abc', 1, 0)]) {
      expect(path.startsWith('audio/') || path.startsWith('transcripts/')).toBe(true);
      expect(isValidBlobPath(path)).toBe(true);
    }
  });

  it('caps a recording at 9.5 hours, the most Gemini takes in one prompt', () => {
    expect(MAX_AUDIO_SECONDS).toBe(34_200);
  });

  it('accepts the three audio types the podcast upload accepts, each with one extension', () => {
    expect(AUDIO_TYPES).toEqual({ 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/wav': 'wav' });
    expect(Object.isFrozen(AUDIO_TYPES)).toBe(true);
  });

  it.each([
    ['audio/mpeg', 'audio/mpeg'],
    ['audio/mp3', 'audio/mpeg'],
    ['audio/x-mp3', 'audio/mpeg'],
    ['audio/mpeg3', 'audio/mpeg'],
    ['audio/mp4', 'audio/mp4'],
    ['audio/x-m4a', 'audio/mp4'],
    ['audio/m4a', 'audio/mp4'],
    ['audio/wav', 'audio/wav'],
    ['audio/x-wav', 'audio/wav'],
    ['audio/wave', 'audio/wav'],
    ['audio/vnd.wave', 'audio/wav'],
  ])('canonicalAudioType folds %s to %s, whatever the case or parameters', (alias, canonical) => {
    expect(canonicalAudioType(alias)).toBe(canonical);
    expect(canonicalAudioType(`${alias.toUpperCase()}; codecs=x`)).toBe(canonical);
  });

  it('canonicalAudioType is null for anything that is not one of the three', () => {
    for (const value of ['audio/aac', 'audio/ogg', 'video/mp4', 'text/html', '', null, undefined, 42]) {
      expect(canonicalAudioType(value)).toBeNull();
    }
  });

  it('caps a recording at 500 MiB', () => {
    expect(MAX_AUDIO_BYTES).toBe(524_288_000);
  });
});
