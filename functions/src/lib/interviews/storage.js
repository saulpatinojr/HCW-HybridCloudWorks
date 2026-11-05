/**
 * storage.js — where an interview's recording and transcripts live.
 *
 * One private container, two prefixes: the lifecycle rule in infra/storage.tf
 * expires `audio/` after the owner's retention and never touches
 * `transcripts/` (ADR 0040, D10). Nothing else writes here, and nothing
 * public reads here: the container is in neither PUBLIC_MEDIA_CONTAINERS nor
 * UPLOAD_CONTAINERS on purpose.
 */

export const INTERVIEWS_AUDIO_CONTAINER = 'interviews-audio';

export const AUDIO_TYPES = Object.freeze({
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/wav': 'wav',
});

export const MAX_AUDIO_BYTES = 500 * 1024 * 1024;

export function audioBlobPath(interviewId, ext) {
  return `audio/${interviewId}.${ext}`;
}

export function transcriptBlobPath(interviewId, version) {
  return `transcripts/${interviewId}/v${version}.json`;
}

export function transcriptPartPath(interviewId, version, windowIndex) {
  return `transcripts/${interviewId}/v${version}.parts/${String(windowIndex).padStart(3, '0')}.json`;
}
