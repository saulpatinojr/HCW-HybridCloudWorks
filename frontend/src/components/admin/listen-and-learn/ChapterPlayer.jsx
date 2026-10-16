/**
 * The player on a chapter row (ADR 0033 §4): a native `<audio>` that picks
 * up where this browser left off in that chapter, with the duration, the
 * file size and a download link beside it.
 *
 * Native audio, because it is keyboard accessible, respects OS media keys and
 * playback-speed preferences, and costs nothing to ship. The remembered
 * position is a per-browser convenience (lib/audioEpisodes.js): a private
 * window or blocked storage plays from the top and nothing complains.
 *
 * `resolveMediaUrl` is not optional. The API stores audio as the
 * site-relative `/api/public/media/...` path so a topology change cannot
 * invalidate every episode already generated — which means it resolves
 * against the SPA's own origin unless it is rewritten, and a cross-origin
 * deployment would serve index.html to an `<audio>` element.
 */
import React, { useRef } from 'react';
import { Download } from 'lucide-react';
import { resolveMediaUrl } from '@/lib/functionsBase';
import { readPlaybackPosition, savePlaybackPosition } from '@/lib/audioEpisodes';
import { formatDuration, formatSize } from './episodeView';

/**
 * @param {object} props
 * @param {string} props.positionKey what the position is remembered under
 * @param {string} props.audioUrl site-relative or absolute
 * @param {string} props.title for the accessible name
 * @param {number|null} [props.durationSeconds]
 * @param {number|null} [props.audioBytes]
 * @param {boolean} [props.download] offer the file; drafts are reachable by
 *   path already, so this is a convenience rather than a disclosure
 * @param {() => void} [props.onEnded]
 */
export default function ChapterPlayer({
  positionKey,
  audioUrl,
  title,
  durationSeconds = null,
  audioBytes = null,
  download = true,
  onEnded,
}) {
  const audioRef = useRef(null);
  const src = resolveMediaUrl(audioUrl);
  const meta = [formatDuration(durationSeconds), formatSize(audioBytes)].filter(Boolean);

  const remember = () => {
    const audio = audioRef.current;
    if (!audio) return;
    savePlaybackPosition(positionKey, audio.currentTime, audio.duration || durationSeconds);
  };

  return (
    <div className="space-y-1">
      {/* eslint-disable-next-line jsx-a11y/media-has-caption -- the transcript on the card is the text alternative */}
      <audio
        ref={audioRef}
        controls
        preload="none"
        src={src}
        className="h-10 w-full"
        aria-label={`Play: ${title}`}
        onLoadedMetadata={() => {
          const audio = audioRef.current;
          const at = readPlaybackPosition(positionKey);
          if (audio && at > 0 && at < (audio.duration || Infinity)) audio.currentTime = at;
        }}
        onPause={remember}
        onTimeUpdate={remember}
        onEnded={() => {
          savePlaybackPosition(positionKey, 0);
          onEnded?.();
        }}
      />
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        {meta.length > 0 && <span>{meta.join(' · ')}</span>}
        {download && src && (
          <a
            href={src}
            download
            className="inline-flex items-center gap-1 underline-offset-2 hover:text-foreground hover:underline"
          >
            <Download className="h-3 w-3" aria-hidden="true" />
            Download MP3
          </a>
        )}
      </div>
    </div>
  );
}
