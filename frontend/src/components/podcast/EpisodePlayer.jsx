/**
 * The one player on the podcast page (#349).
 *
 * A native `<audio>` element drives it, because that is what already honours
 * OS media keys, playback-speed preferences and the browser's own byte-range
 * seeking. The controls are the page's — play/pause and a real slider — so the
 * page can style them per provider and keep the list in step with what is
 * playing, without reimplementing decoding or buffering.
 *
 * Seeking is a `<input type="range">`, not a click on a div: it is keyboard
 * operable, announces its value, and its `max` is the real duration once
 * metadata has arrived. It works because the media route answers `Range`
 * requests — before that (lib/public-media.js) a seek into a Listen & Learn
 * episode downloaded the whole file first.
 *
 * `preload="metadata"` fetches only the header, so the page costs a few
 * kilobytes per episode until someone presses play. Mount with
 * `key={episode.id}` and every piece of state below resets with the element.
 */
import React, { useEffect, useRef, useState } from 'react';
import {
  formatSeconds,
  readPlaybackPosition,
  savePlaybackPosition,
  stripHtml,
} from '@/lib/audioEpisodes';
import { safeUrl } from '@/lib/safeUrl';

/**
 * A sanitised link that stays on this site.
 *
 * `//evil.example` also starts with a slash and passes `safeUrl` — it is a
 * relative reference by the URL grammar — but it navigates cross-origin. A
 * feed could otherwise put a same-tab link to another site behind the
 * "Certification" label, with no `rel="noopener"`. Same rule as the admin
 * platform-settings page.
 */
export function isInternalPath(url) {
  return Boolean(url && url.startsWith('/') && !url.startsWith('//'));
}

/** The cover, or the provider-coloured placeholder when the feed has none. */
function EpisodeArtwork({ image, episode, meta }) {
  if (image) {
    return (
      <img
        src={image}
        alt={episode.title}
        loading="lazy"
        decoding="async"
        className="w-full aspect-square max-w-50 rounded-lg object-cover shrink-0"
      />
    );
  }
  return (
    <div
      className={`w-full aspect-square max-w-50 rounded-lg bg-linear-to-br ${meta.placeholder} flex items-center justify-center shrink-0`}
    >
      <span className={`material-symbols-outlined ${meta.placeholderIcon} text-3xl`}>podcasts</span>
    </div>
  );
}

/**
 * Download and the episode link, beside the play button. Both render only
 * from a sanitised URL; an enclosure that failed `safeUrl` says so instead.
 */
function EpisodeLinks({ episode, mediaUrl, link }) {
  const internalLink = isInternalPath(link);
  return (
    <>
      {mediaUrl && (
        <a
          href={mediaUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2 px-4 py-2 bg-card/50 hover:bg-card/70 text-foreground rounded-lg transition-colors text-sm font-semibold"
        >
          <span className="material-symbols-outlined text-[16px]">download</span>
          Download
        </a>
      )}
      {episode.mediaUrl && !mediaUrl && (
        <span className="text-xs text-foreground/70" role="note">
          Media URL not playable
        </span>
      )}
      {link && (
        <a
          href={link}
          {...(internalLink ? {} : { target: '_blank', rel: 'noopener noreferrer' })}
          className="flex items-center gap-2 px-4 py-2 bg-card/50 hover:bg-card/70 text-foreground rounded-lg transition-colors text-sm font-semibold"
        >
          <span className="material-symbols-outlined text-[16px]">
            {internalLink ? 'school' : 'open_in_new'}
          </span>
          {internalLink ? 'Certification' : 'Open'}
        </a>
      )}
    </>
  );
}

/**
 * Mirror the play/pause state onto the element. jsdom and some embedded
 * browsers return undefined rather than a promise from play(); a rejection
 * (autoplay policy, network) drops back to paused.
 */
function syncAudioToState(audio, isPlaying, setIsPlaying) {
  if (!audio) return;
  if (!isPlaying) {
    audio.pause();
    return;
  }
  const result = audio.play();
  if (result && typeof result.catch === 'function') {
    result.catch(() => setIsPlaying(false));
  }
}

/** The hidden <audio> element, and the state it reports back to the player. */
function EpisodeAudio({
  audioRef,
  mediaUrl,
  episode,
  known,
  setCurrentTime,
  setDuration,
  setIsPlaying,
}) {
  // Where this browser left off in this episode (ADR 0033 §4): restored once
  // the element knows its length, saved as it plays and when it pauses, and
  // cleared when it ends so the next visit starts from the top. A storage
  // that cannot be read or written leaves the player exactly as it was.
  function restorePosition(audioEl) {
    const at = readPlaybackPosition(episode.id);
    if (at > 0 && at < (audioEl.duration || Infinity)) {
      audioEl.currentTime = at;
      setCurrentTime(at);
    }
  }
  function rememberPosition(audioEl) {
    savePlaybackPosition(episode.id, audioEl.currentTime, audioEl.duration || known);
  }

  return (
    // eslint-disable-next-line jsx-a11y/media-has-caption
    <audio
      ref={audioRef}
      src={mediaUrl}
      preload="metadata"
      onTimeUpdate={(e) => {
        setCurrentTime(e.currentTarget.currentTime || 0);
        rememberPosition(e.currentTarget);
      }}
      onLoadedMetadata={(e) => {
        const d = e.currentTarget.duration;
        if (Number.isFinite(d) && d > 0) setDuration(d);
        restorePosition(e.currentTarget);
      }}
      onEnded={() => {
        setIsPlaying(false);
        savePlaybackPosition(episode.id, 0);
      }}
      // The element is the source of truth, not the button: OS media keys,
      // headphone controls and the browser's own audio UI move it without
      // going through our handler, and the indicator on the list above
      // would otherwise keep saying "playing" over silence. Both handlers
      // are idempotent against the effect that mirrors this state onto the
      // element (play() on a playing element, pause() on a paused one).
      onPlay={() => setIsPlaying(true)}
      onPause={(e) => {
        setIsPlaying(false);
        rememberPosition(e.currentTarget);
      }}
      aria-label={`Audio: ${episode.title}`}
    />
  );
}

/** The progress bar with a transparent range slider over it for seeking. */
function SeekTrack({ meta, currentTime, sliderMax, mediaUrl, onSeek }) {
  return (
    <div
      // The input inside is transparent so the styled bar shows through;
      // the ring on the track is what makes keyboard focus visible.
      className="relative w-full h-2 bg-card/60 rounded-full mb-2 focus-within:ring-2 focus-within:ring-white/80 focus-within:ring-offset-2 focus-within:ring-offset-transparent"
      data-testid="episode-track"
    >
      <div
        className={`h-full bg-linear-to-r ${meta.progressBar} rounded-full transition-all duration-200`}
        style={{
          // Clamped like the slider's value: a document's durationSeconds
          // can be shorter than the real file, and the bar must not
          // overflow its track while the last seconds play.
          width: sliderMax ? `${(Math.min(currentTime, sliderMax) / sliderMax) * 100}%` : '0%',
        }}
        data-testid="episode-progress"
        aria-hidden="true"
      />
      <input
        type="range"
        aria-label="Seek"
        min="0"
        max={sliderMax}
        step="1"
        value={Math.min(currentTime, sliderMax)}
        onChange={onSeek}
        disabled={!mediaUrl || !sliderMax}
        className="absolute inset-0 w-full h-full opacity-0 cursor-pointer disabled:cursor-default"
      />
    </div>
  );
}

export default function EpisodePlayer({ episode, meta, onPlayingChange }) {
  const audioRef = useRef(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(null);

  useEffect(() => {
    onPlayingChange?.(isPlaying);
  }, [isPlaying, onPlayingChange]);

  useEffect(() => {
    syncAudioToState(audioRef.current, isPlaying, setIsPlaying);
  }, [isPlaying]);

  // Decide on the sanitised value: an unsafe URL (javascript:, data:, control
  // characters) gets the placeholder, not an <img> with no src.
  const image = safeUrl(episode.image);
  // Same decision for the audio: the element is rendered only from a safe
  // URL, Play is disabled and Download withheld otherwise. A feed can carry
  // anything in an enclosure.
  const mediaUrl = safeUrl(episode.mediaUrl);
  // And for the episode link: `link` is `item.link || null` from a feed, so
  // it can be null or not a string at all. Decide internal-vs-external on the
  // sanitised string and render the link only when there is one.
  const link = safeUrl(episode.link);
  const known = duration ?? episode.durationSeconds ?? null;
  const sliderMax = known && known > 0 ? known : 0;

  function handleSeek(event) {
    const audio = audioRef.current;
    const next = Number(event.target.value);
    setCurrentTime(next);
    if (audio) audio.currentTime = next;
  }

  return (
    <article
      className={`bg-card/40 backdrop-blur-md border ${meta.border} rounded-2xl overflow-hidden`}
      data-testid="episode-player"
    >
      {mediaUrl && (
        <EpisodeAudio
          audioRef={audioRef}
          mediaUrl={mediaUrl}
          episode={episode}
          known={known}
          setCurrentTime={setCurrentTime}
          setDuration={setDuration}
          setIsPlaying={setIsPlaying}
        />
      )}

      <div className="p-6 sm:p-8">
        <div className="flex items-center gap-2 mb-4">
          <span className={`px-3 py-1 ${meta.badge} border text-xs font-bold rounded`}>
            Now Playing
          </span>
          <span className="px-3 py-1 bg-card/60 border border-card/80 text-foreground text-xs font-semibold rounded">
            {episode.sourceLabel}
          </span>
        </div>

        <div className="flex gap-6 items-start mb-6">
          <EpisodeArtwork image={image} episode={episode} meta={meta} />
          <div className="flex-1 min-w-0">
            <h2 className="text-xl sm:text-2xl font-bold mb-2 leading-tight">{episode.title}</h2>
            <p className="text-sm text-foreground line-clamp-3">
              {stripHtml(episode.longDescription || episode.description)}
            </p>
          </div>
        </div>

        <SeekTrack
          meta={meta}
          currentTime={currentTime}
          sliderMax={sliderMax}
          mediaUrl={mediaUrl}
          onSeek={handleSeek}
        />
        <div className="flex justify-between text-xs text-foreground mb-5">
          <span>{formatSeconds(currentTime)}</span>
          <span>{formatSeconds(known)}</span>
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          <button
            type="button"
            onClick={() => setIsPlaying((p) => !p)}
            disabled={!mediaUrl}
            aria-label={isPlaying ? 'Pause' : 'Play'}
            className={`w-12 h-12 bg-linear-to-br ${meta.playBtn} rounded-full flex items-center justify-center transition-all shadow-lg disabled:opacity-40`}
          >
            <span className="material-symbols-outlined text-white text-2xl">
              {isPlaying ? 'pause' : 'play_arrow'}
            </span>
          </button>
          <EpisodeLinks episode={episode} mediaUrl={mediaUrl} link={link} />
        </div>
      </div>
    </article>
  );
}
