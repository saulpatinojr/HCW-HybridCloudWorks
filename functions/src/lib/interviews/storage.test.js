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

  it('is neither publicly served nor reachable from the generic upload route', () => {
    expect(PUBLIC_MEDIA_CONTAINERS.has(INTERVIEWS_AUDIO_CONTAINER)).toBe(false);
    expect(UPLOAD_CONTAINERS.has(INTERVIEWS_AUDIO_CONTAINER)).toBe(false);
  });

  it('keeps recordings under audio/ and transcripts under transcripts/', () => {
    expect(audioBlobPath('abc', 'mp3')).toBe('audio/abc.mp3');
    expect(transcriptBlobPath('abc', 1)).toBe('transcripts/abc/v1.json');
    expect(transcriptPartPath('abc', 2, 7)).toBe('transcripts/abc/v2.parts/007.json');
    for (const path of [audioBlobPath('abc', 'wav'), transcriptBlobPath('abc', 3), transcriptPartPath('abc', 1, 0)]) {
      expect(path.startsWith('audio/') || path.startsWith('transcripts/')).toBe(true);
      expect(isValidBlobPath(path)).toBe(true);
    }
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
