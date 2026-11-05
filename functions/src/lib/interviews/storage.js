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

// Browsers and recorders spell the same three types several ways. The
// canonical type is what is stored and checked against the extension.
const AUDIO_TYPE_ALIASES = Object.freeze({
  'audio/mp3': 'audio/mpeg',
  'audio/x-mp3': 'audio/mpeg',
  'audio/mpeg3': 'audio/mpeg',
  'audio/x-m4a': 'audio/mp4',
  'audio/m4a': 'audio/mp4',
  'audio/x-wav': 'audio/wav',
  'audio/wave': 'audio/wav',
  'audio/vnd.wave': 'audio/wav',
});

export function canonicalAudioType(contentType) {
  const base = String(contentType || '').split(';')[0].trim().toLowerCase();
  const type = AUDIO_TYPE_ALIASES[base] || base;
  return Object.hasOwn(AUDIO_TYPES, type) ? type : null;
}

export const MAX_AUDIO_BYTES = 500 * 1024 * 1024;

export function audioBlobPath(interviewId, uploadId, ext) {
  return `audio/${interviewId}/${uploadId}.${ext}`;
}

export const MAX_AUDIO_SECONDS = 34_200; // Gemini's 9.5 hours per prompt

export function transcriptBlobPath(interviewId, version) {
  return `transcripts/${interviewId}/v${version}.json`;
}

export function transcriptPartPath(interviewId, version, windowIndex) {
  return `transcripts/${interviewId}/v${version}.parts/${String(windowIndex).padStart(3, '0')}.json`;
}
