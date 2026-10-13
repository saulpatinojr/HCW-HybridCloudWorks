/**
 * Audio — the shows the site ingests, where the study episodes' voice is
 * chosen, and the voice that reads podcast episodes.
 *
 *   Podcast feeds          admin_config/podcast_feeds           read by timers/podcasts.js
 *   Listen & Learn voice   a line and a link: the model is the Listen & Learn speech
 *                          task's, chosen under AI Engine → Tasks (ADR 0034 slice 5,
 *                          #860); the stored document this card used to edit is read
 *                          once by the router as the migration's input
 *   Podcast voice          GET cms/podcast/elevenlabs           ElevenLabs plan, credits and
 *                                                               the live check (ElevenLabsCard)
 *   Podcast voices         admin_config/podcast_voices          the two hosts' ElevenLabs voices,
 *                                                               picked by ear (PodcastVoices,
 *                                                               inside ElevenLabsCard, #725)
 *
 * Each card loads on its own, so one failing never hides the others.
 */

import React, { useMemo } from 'react';
import { useAuthReady } from '@/hooks/useAuthReady';
import ElevenLabsCard from './ElevenLabsCard';
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Headphones, Podcast } from 'lucide-react';
import { tabHref } from '@/components/admin/ai-engine/tabs';
import {
  PODCAST_PROVIDERS,
  SETTING_LABELS,
  SaveRow,
  SettingSection,
  StoredState,
  useSetting,
} from './settingShared';

export function PodcastFeedsCard({ value, onChange, onSave, saving, meta }) {
  const feeds = useMemo(() => value?.feeds ?? [], [value]);
  // The fixed rows first, then any provider the document carries beyond them.
  const providers = useMemo(() => {
    const extra = feeds
      .map((row) => row.provider)
      .filter((provider) => provider && !PODCAST_PROVIDERS.includes(provider));
    return [...PODCAST_PROVIDERS, ...new Set(extra)];
  }, [feeds]);
  // Spread the current value rather than rebuilding it: the main feed and the
  // provider rows are edited by different controls and neither may drop the
  // other's field on the way to the save.
  const update = (patch) => onChange({ ...(value ?? {}), ...patch });
  const urlFor = (provider) => feeds.find((row) => row.provider === provider)?.url ?? '';
  const setUrl = (provider, url) => {
    const present = feeds.some((row) => row.provider === provider);
    update({
      feeds: present
        ? feeds.map((row) => (row.provider === provider ? { provider, url } : row))
        : [...feeds, { provider, url }],
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <Podcast className="h-5 w-5" /> Podcast feeds
        </CardTitle>
        <CardDescription>
          The main feed is the site&apos;s own show. Its episodes appear on every provider&apos;s
          audio page, at the top, and its RSS button is what a reader gets on a provider with no
          feed of its own. The per-provider feeds below are optional extras for a show that belongs
          to one provider. All are fetched every two hours, all must be https; blank means no feed.
          A feed that answers 410 Gone is reported in Ops Health and should be replaced or blanked
          here.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 pt-0">
        <StoredState meta={meta} />
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            onSave();
          }}
        >
          <div className="space-y-1 rounded-lg border border-primary/40 bg-primary/5 p-3">
            <Label htmlFor="feed-main" className="text-sm font-semibold">
              Main feed
            </Label>
            <Input
              id="feed-main"
              type="text"
              inputMode="url"
              value={value?.mainFeedUrl ?? ''}
              disabled={saving}
              spellCheck={false}
              placeholder="https://podcast.hybridcloudworks.com/feed.xml"
              onChange={(event) => update({ mainFeedUrl: event.target.value })}
              className="font-mono text-xs"
            />
            <p className="text-xs text-muted-foreground">
              The site&apos;s show — not any one provider&apos;s.
            </p>
          </div>

          <div className="space-y-2">
            <p className="text-sm font-medium">Per-provider feeds (optional)</p>
            <div className="grid gap-3 sm:grid-cols-2">
              {providers.map((provider) => (
                <div key={provider} className="space-y-1">
                  <Label htmlFor={`feed-${provider}`}>{provider}</Label>
                  <Input
                    id={`feed-${provider}`}
                    type="text"
                    inputMode="url"
                    value={urlFor(provider)}
                    disabled={saving}
                    spellCheck={false}
                    placeholder="https://…/feed.xml"
                    onChange={(event) => setUrl(provider, event.target.value)}
                    className="font-mono text-xs"
                  />
                </div>
              ))}
            </div>
          </div>

          <SaveRow saving={saving} />
        </form>
      </CardContent>
    </Card>
  );
}

/**
 * Where the Listen & Learn voice is chosen (ADR 0034 slice 5, #860): under
 * AI Engine → Tasks, on the Listen & Learn speech row. The card this
 * replaced stored a Gemini model here; nothing is stored here now, so the
 * card holds one line and a link, and loads nothing.
 */
export function ListenAndLearnVoiceCard() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <Headphones className="h-5 w-5" /> Listen &amp; Learn voice
        </CardTitle>
        <CardDescription>
          Listen &amp; Learn is always Gemini TTS (Azure AI Speech as the fallback); ElevenLabs is
          the podcast voice and is never used here.
        </CardDescription>
      </CardHeader>
      <CardContent className="pt-0 text-sm">
        <p data-testid="listen-and-learn-voice-note">
          The model is chosen under{' '}
          <a href={tabHref('routing')} className="text-primary underline underline-offset-4">
            AI Engine → Tasks
          </a>
          , on the Listen &amp; Learn speech row. Recommended is the Economy voice; Best is one
          Custom step away.
        </p>
      </CardContent>
    </Card>
  );
}

export default function AudioTab() {
  const { authReady } = useAuthReady();
  const podcasts = useSetting('podcast-feeds', authReady);

  return (
    <div className="space-y-6">
      <SettingSection
        setting={podcasts}
        label={SETTING_LABELS['podcast-feeds']}
        render={(s) => (
          <PodcastFeedsCard
            value={s.value}
            meta={s.meta}
            saving={s.saving}
            onChange={s.setValue}
            onSave={() => s.save(s.value)}
          />
        )}
      />
      <ListenAndLearnVoiceCard />
      <ElevenLabsCard authReady={authReady} />
    </div>
  );
}
