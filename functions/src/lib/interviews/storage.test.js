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

  it('no lifecycle rule without a prefix deletes base blobs, so transcripts are never expired by a rule that reaches them', () => {
    // Each `rule { ... }` block of the management policy, read as text: one
    // that is enabled, names no prefix_match and carries a base_blob delete
    // would reach transcripts/ (and everything else on the account). The
    // account-wide rule that expires previous versions only is allowed.
    const policy = STORAGE_TF.slice(STORAGE_TF.indexOf('resource "azurerm_storage_management_policy" "cleanup"'));
    const rules = policy.split(/\n  rule \{/).slice(1);
    expect(rules.length).toBeGreaterThanOrEqual(5);
    const offenders = rules.filter(
      (rule) =>
        /enabled\s*=\s*true/.test(rule) &&
        !/prefix_match\s*=/.test(rule) &&
        /base_blob\s*\{[^}]*delete_after/s.test(rule)
    );
    expect(offenders.map((r) => (r.match(/name\s*=\s*"([^"]+)"/) ?? [])[1])).toEqual([]);
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
