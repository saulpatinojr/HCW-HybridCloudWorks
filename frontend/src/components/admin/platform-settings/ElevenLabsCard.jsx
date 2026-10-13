/**
 * The podcast voice on the Audio tab: ElevenLabs's plan and credits, what the
 * last render billed, and the owner's live check (#432; ADR 0029 §2a, amended
 * 2026-09-26).
 *
 *   GET  cms/podcast/elevenlabs          plan, credits used / limit, reset
 *                                        date, the last render's billed
 *                                        characters, the last sample to
 *                                        replay; "not configured" is a 200,
 *                                        not an error
 *   POST cms/podcast/elevenlabs/sample   a fixed two-turn sample of under 300
 *                                        characters through the real provider,
 *                                        in the saved podcast voices
 *
 * Between the two, the Podcast voices picker (PodcastVoices.jsx, #725): the
 * owner plays the voices the key may use and saves one per host. The code has
 * no default voice, so the live check waits for a saved pair, and a 402
 * `paid_plan_required` says to choose voices the plan allows.
 *
 * The server does the work (functions/src/lib/podcast/elevenlabs-admin.js).
 * This card reads it, and runs the check on a click, never on load, because
 * the check spends credits.
 *
 * ## Replay first, spend on purpose (owner request 2026-09-27)
 *
 * Two checks were spent only to test playback, because the player showed
 * only for a check run in the same session. Now the status read carries
 * `lastSample`, the last stored sample, and the **Last sample** section plays
 * it from the media route on every load: replaying costs nothing and never
 * reaches ElevenLabs. **Render a new sample** asks first, in the admin
 * ConfirmModal, naming the credits left, that the last sample replays free,
 * and whether it already used the saved voices. It confirms; it does not
 * block.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '@/components/ui/card';
import IntegrationBadge from '@/components/admin/shared/IntegrationBadge';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/components/ui/use-toast';
import { AlertTriangle, Loader2, Mic, Play, RefreshCw } from 'lucide-react';
import ConfirmModal from '@/components/admin/ConfirmModal';
import { getJSON, postJSON } from '@/lib/api';
import { resolveMediaUrl } from '@/lib/functionsBase';
import { safeUrl } from '@/lib/safeUrl';
import { relativeTime, useSetting } from './settingShared';
import PodcastVoices, { PODCAST_HOSTS, useVoiceList } from './PodcastVoices';

export const ELEVENLABS_STATUS_ROUTE = 'cms/podcast/elevenlabs';
export const ELEVENLABS_SAMPLE_ROUTE = 'cms/podcast/elevenlabs/sample';

const count = (n) =>
  typeof n === 'number' && Number.isFinite(n) ? n.toLocaleString('en-US') : '—';

const day = (iso) =>
  typeof iso === 'string' && iso.length >= 10 ? `${iso.slice(0, 10)} (UTC)` : 'not reported';

/** "about 257 credits", or "credits" before the sample's size is known. */
const aboutCredits = (characters) =>
  typeof characters === 'number' ? `about ${count(characters)} credits` : 'credits';

/**
 * What wrote the last ElevenLabs usage row, as a person reads it. An
 * episode row written since ADR 0034 slice 5 (#860) carries the task as
 * `source` (ai:podcastVoice) and this slug as `product`; one written before
 * carries only `source: podcast:audio`. So the key is `product` first,
 * `source` as the historical fallback (`renderSourceOf`).
 */
const RENDER_SOURCES = Object.freeze({
  'podcast:audio': 'an episode',
  'podcast:sample': 'a live check',
});

/** The sentence for a last-render row, by its product, else its source; undefined for neither. */
export const renderSourceOf = (lastRender) =>
  RENDER_SOURCES[lastRender?.product] ?? RENDER_SOURCES[lastRender?.source];

/**
 * The status read. Race-safe the way `useSetting` is: a load only writes
 * state while it is the newest, so a slow first load cannot land over a
 * retry and an unmounted card's load writes nothing.
 */
function useElevenLabsStatus(authReady) {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [attempt, setAttempt] = useState(0);
  const generation = useRef(0);

  useEffect(() => {
    if (!authReady) return undefined;
    const mine = ++generation.current;
    const current = () => mine === generation.current;
    getJSON(ELEVENLABS_STATUS_ROUTE)
      .then((response) => {
        if (current()) {
          setStatus(response ?? null);
          setError(null);
        }
      })
      .catch((err) => {
        if (current()) {
          setStatus(null);
          setError(err?.message ?? 'Could not load the ElevenLabs status.');
        }
      })
      .finally(() => {
        if (current()) setLoading(false);
      });
    return () => {
      if (current()) generation.current += 1;
    };
  }, [authReady, attempt]);

  const reload = useCallback(() => {
    generation.current += 1;
    setLoading(true);
    setError(null);
    setAttempt((n) => n + 1);
  }, []);

  return { status, loading, error, reload };
}

/**
 * The live check, run on a click and never on load, because it spends
 * credits. A second click while one is running sends nothing. `onRendered`
 * re-reads the status so the figures above show the spend.
 */
function useLiveCheck(onRendered) {
  const [sample, setSample] = useState(null);
  const [running, setRunning] = useState(false);
  const runningRef = useRef(false);
  const { toast } = useToast();

  const runSample = useCallback(async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    setRunning(true);
    try {
      const result = await postJSON(ELEVENLABS_SAMPLE_ROUTE, {});
      setSample(result ?? null);
      toast({
        title: 'Live check rendered',
        description: `${count(result?.charactersBilled)} characters billed; ${count(result?.creditsLeft)} credits left.`,
      });
      onRendered();
    } catch (err) {
      const message = err?.message ?? 'The live check failed.';
      setSample({ error: message, code: err?.code ?? null });
      toast({ title: 'Live check not rendered', description: message, variant: 'destructive' });
    } finally {
      runningRef.current = false;
      setRunning(false);
    }
  }, [onRendered, toast]);

  return { sample, running, runSample };
}

/** The status read and the live check, for the card. */
export function useElevenLabs(authReady) {
  const status = useElevenLabsStatus(authReady);
  const check = useLiveCheck(status.reload);
  return { ...status, ...check };
}

function PlanFigures({ subscription }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
      <dt className="text-muted-foreground">Plan</dt>
      <dd>
        {subscription.tier ?? 'not reported'}
        {subscription.status ? ` (${subscription.status})` : ''}
      </dd>
      <dt className="text-muted-foreground">Credits</dt>
      <dd>
        {`${count(subscription.creditsUsed)} used of ${count(subscription.creditLimit)}, ${count(subscription.creditsLeft)} left`}
      </dd>
      <dt className="text-muted-foreground">Resets</dt>
      <dd>{day(subscription.resetAt)}</dd>
    </dl>
  );
}

function FreePlanNote() {
  return (
    <p className="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs">
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
      <span>
        Free plan: no commercial licence. Episodes voiced on it are for testing and are never
        published to Podbean; approval refuses them. Upgrade, then regenerate, to publish.
      </span>
    </p>
  );
}

function LastRender({ lastRender, lastRenderError }) {
  if (lastRenderError) {
    return <p className="text-xs text-amber-700">Last render: {lastRenderError}</p>;
  }
  if (!lastRender) {
    return <p className="text-xs text-muted-foreground">No ElevenLabs render recorded yet.</p>;
  }
  const from = renderSourceOf(lastRender);
  const when = relativeTime(lastRender.at);
  return (
    <p className="text-sm">
      {`Last render billed ${count(lastRender.characters)} characters`}
      {lastRender.estimated ? ' (our count; ElevenLabs sent no figure)' : ''}
      {from ? `, ${from}` : ''}
      {when ? `, ${when}` : ''}
    </p>
  );
}

/** Refusals whose fix is in the Podcast voices section above, not a retry. */
const VOICE_FIXES = Object.freeze({
  paid_plan_required:
    'Choose voices your plan allows under Podcast voices above (the ones listed as usable), Save, and run the check again.',
  voices_not_chosen:
    'Choose a voice for each host under Podcast voices above, Save, and run the check again.',
  invalid_voice:
    'Choose the voices again under Podcast voices above, Save, and run the check again.',
});

/** "Rendered 2026-09-27 14:03 (UTC), 257 characters billed then." */
function sampleFacts(lastSample) {
  const at = lastSample.renderedAt;
  const when =
    typeof at === 'string' && at.length >= 16
      ? `Rendered ${at.slice(0, 10)} ${at.slice(11, 16)} (UTC)`
      : 'Render time not recorded';
  const billed =
    typeof lastSample.charactersBilled === 'number'
      ? `, ${count(lastSample.charactersBilled)} characters billed then`
      : '';
  return `${when}${billed}.`;
}

/** "Voices: Maya: Bella, Elena: Jessica.", each named by the record, else the list, else its id. */
function sampleVoices(voices, names) {
  if (!voices) return 'Voices: not recorded.';
  const named = PODCAST_HOSTS.map((host) => {
    const voice = voices[host];
    return `${host}: ${voice?.name || names.get(voice?.voiceId) || voice?.voiceId || 'not recorded'}`;
  });
  return `Voices: ${named.join(', ')}.`;
}

/**
 * The last stored sample, playable from the media route on every load.
 * Replaying it reaches our own storage only, never ElevenLabs.
 */
function LastSample({ lastSample, lastSampleError, names, configured }) {
  if (!lastSample && lastSampleError) {
    return <p className="text-xs text-amber-700">Last sample: {lastSampleError}</p>;
  }
  if (!lastSample) {
    return configured ? (
      <p className="text-xs text-muted-foreground">
        No sample yet. The next render is kept here, and replaying it costs nothing.
      </p>
    ) : null;
  }
  const src = safeUrl(resolveMediaUrl(lastSample.audioUrl));
  return (
    <section
      aria-labelledby="elevenlabs-last-sample"
      className="space-y-2 rounded-md border border-input p-3"
    >
      <p id="elevenlabs-last-sample" className="text-sm font-medium">
        Last sample
      </p>
      {src ? (
        // eslint-disable-next-line jsx-a11y/media-has-caption
        <audio controls preload="metadata" src={src} className="h-8 w-full" />
      ) : null}
      <p className="text-xs text-muted-foreground">{sampleFacts(lastSample)}</p>
      <p className="text-xs text-muted-foreground">{sampleVoices(lastSample.voices, names)}</p>
      <p className="text-xs font-medium">Replaying costs nothing.</p>
    </section>
  );
}

function SampleResult({ sample }) {
  if (!sample) return null;
  if (sample.error) {
    const fix = VOICE_FIXES[sample.code];
    return (
      <div className="space-y-1">
        <p className="text-sm text-destructive">{sample.error}</p>
        {fix ? <p className="text-sm font-medium">{fix}</p> : null}
      </div>
    );
  }
  return (
    <div className="space-y-1">
      {sample.audioUrl ? (
        <p className="text-xs text-muted-foreground">
          Kept as the Last sample above, to replay for nothing.
        </p>
      ) : (
        <p className="text-xs text-amber-700">{sample.audioError ?? 'No audio was returned.'}</p>
      )}
      <p className="text-sm">
        {`Characters billed: ${count(sample.charactersBilled)}`}
        {sample.billedEstimated ? ' (our count)' : ''}
      </p>
      <p className="text-sm">
        {`Credits left: ${count(sample.creditsLeft)} of ${count(sample.creditLimit)}`}
      </p>
    </div>
  );
}

function LiveCheck({ characters, configured, voicesChosen, running, onRun, sample }) {
  return (
    <div className="space-y-2 rounded-md border border-input p-3">
      <p className="text-sm font-medium">Live check</p>
      <p className="text-xs text-muted-foreground">
        Renders a fixed two-turn sample of {count(characters)} characters through the real provider,
        about {count(characters)} credits, in the saved podcast voices. It proves the key, both
        voices and the credit check without spending a month on an episode. It asks before it
        spends.
      </p>
      {configured && !voicesChosen ? (
        <p className="text-xs text-amber-700">
          Choose the podcast voices first: save a voice for each host above.
        </p>
      ) : null}
      <Button
        type="button"
        size="sm"
        onClick={onRun}
        disabled={running || !configured || !voicesChosen}
      >
        {running ? (
          <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
        ) : (
          <Play className="mr-2 h-3.5 w-3.5" />
        )}
        {typeof characters === 'number'
          ? `Render a new sample (${aboutCredits(characters)})`
          : 'Render a new sample'}
      </Button>
      <SampleResult sample={sample} />
    </div>
  );
}

/** Whether the saved pair is the pair the last sample used. */
function sameVoices(saved, lastSample) {
  const voices = lastSample?.voices;
  if (!saved || !voices) return false;
  return PODCAST_HOSTS.every(
    (host) => Boolean(saved[host]) && voices[host]?.voiceId === saved[host]
  );
}

/** What a render spends, of what is left, and that the last sample replays free. */
function confirmDescription({ characters, creditsLeft, lastSample }) {
  const spend =
    typeof creditsLeft === 'number'
      ? `This spends ${aboutCredits(characters)} of the ${count(creditsLeft)} left.`
      : `This spends ${aboutCredits(characters)}; the credits left could not be read.`;
  return lastSample
    ? `${spend} The last sample can be replayed free under Last sample.`
    : `${spend} There is no sample to replay yet.`;
}

/**
 * The one step between the button and the spend, in the admin pages'
 * ConfirmModal. It asks; it never blocks.
 */
function RenderConfirm({
  open,
  characters,
  creditsLeft,
  lastSample,
  sameAsLast,
  onConfirm,
  onCancel,
}) {
  return (
    <ConfirmModal
      open={open}
      title="Render a new sample?"
      description={confirmDescription({ characters, creditsLeft, lastSample })}
      preview={
        sameAsLast ? (
          <p className="text-sm font-medium text-amber-700">
            The last sample already used these voices.
          </p>
        ) : null
      }
      confirmLabel={`Render (${aboutCredits(characters)})`}
      destructive={false}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}

function StatusBody({ status }) {
  if (!status?.configured) {
    return (
      <div className="space-y-1">
        <Badge variant="outline">Not configured</Badge>
        <p className="text-xs text-muted-foreground">
          {status?.reason ?? 'ELEVENLABS_API_KEY is not configured.'}
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {status.subscription ? <PlanFigures subscription={status.subscription} /> : null}
      {status.subscription?.freePlan ? <FreePlanNote /> : null}
      {status.subscriptionError ? (
        <p className="text-xs text-amber-700">{status.subscriptionError}</p>
      ) : null}
      <LastRender lastRender={status.lastRender} lastRenderError={status.lastRenderError} />
    </div>
  );
}

/** Whether a valid pair is saved: what the live check and every episode read. */
function savedVoicesChosen(setting) {
  if (setting.loading || setting.error) return false;
  if (!setting.meta.exists || setting.meta.stored !== 'valid') return false;
  return PODCAST_HOSTS.every((host) => Boolean(setting.value?.[host]));
}

/** Voice names by id, from the one listing the picker also shows. */
function useVoiceNames(list) {
  return useMemo(
    () =>
      new Map(
        (Array.isArray(list?.voices) ? list.voices : []).map((voice) => [voice.voiceId, voice.name])
      ),
    [list]
  );
}

export default function ElevenLabsCard({ authReady }) {
  const eleven = useElevenLabs(authReady);
  const voices = useSetting('podcast-voices', authReady);
  const { status, loading, error } = eleven;
  const configured = status?.configured === true;
  const voiceList = useVoiceList(configured);
  const names = useVoiceNames(voiceList.list);
  const [confirming, setConfirming] = useState(false);
  // A render in this session is newer than what the status read last said.
  const fresh = eleven.sample?.lastSample ?? null;
  const lastSample = fresh ?? status?.lastSample ?? null;
  const characters = status?.sample?.characters;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <Mic className="h-5 w-5" /> Podcast voice <IntegrationBadge id="elevenlabs" />
        </CardTitle>
        <CardDescription>
          ElevenLabs reads podcast episodes and never Listen &amp; Learn. Before a render sends
          anything it checks the credits left, and refuses a job they cannot cover in full.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 pt-0">
        {loading ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading the ElevenLabs account…
          </p>
        ) : null}
        {!loading && error ? (
          <div
            role="alert"
            className="flex flex-wrap items-center gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm"
          >
            <span>ElevenLabs: {error}</span>
            <Button type="button" size="sm" variant="outline" onClick={eleven.reload}>
              <RefreshCw className="mr-2 h-3.5 w-3.5" /> Retry
            </Button>
          </div>
        ) : null}
        {!loading && !error ? <StatusBody status={status} /> : null}
        <PodcastVoices setting={voices} configured={configured} voiceList={voiceList} />
        {fresh || (!loading && !error) ? (
          <LastSample
            lastSample={lastSample}
            lastSampleError={status?.lastSampleError}
            names={names}
            configured={configured}
          />
        ) : null}
        <LiveCheck
          characters={characters}
          configured={configured}
          voicesChosen={savedVoicesChosen(voices)}
          running={eleven.running}
          onRun={() => setConfirming(true)}
          sample={eleven.sample}
        />
        <RenderConfirm
          open={confirming}
          characters={characters}
          creditsLeft={status?.subscription?.creditsLeft}
          lastSample={lastSample}
          sameAsLast={sameVoices(voices.saved, lastSample)}
          onConfirm={() => {
            setConfirming(false);
            eleven.runSample();
          }}
          onCancel={() => setConfirming(false)}
        />
      </CardContent>
    </Card>
  );
}
