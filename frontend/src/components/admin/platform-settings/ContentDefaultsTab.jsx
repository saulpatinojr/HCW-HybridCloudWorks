/**
 * Content defaults — what a published post falls back to.
 *
 *   Default covers   admin_config/default_heroes   read by triggers/ai-cover.js
 *
 * The newsletter's settings are not repeated here: they have their own
 * Settings tab in the Newsletter Hub, and a second form over the same
 * document would be a second place for it to be saved from.
 */

import React, { useState } from 'react';
import { Link } from 'react-router';
import { useAuthReady } from '@/hooks/useAuthReady';
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ArrowRight, Images, Mail, Wand2 } from 'lucide-react';
import {
  HERO_PROVIDERS,
  SETTING_LABELS,
  SaveRow,
  SettingSection,
  StoredState,
  useSetting,
} from './settingShared';

/** The covers shipped with the site under frontend/public/images/default-heroes/. */
export const bundledDefaultHeroes = () =>
  Object.fromEntries(
    HERO_PROVIDERS.map((provider) => [
      provider,
      `/images/default-heroes/${provider.toLowerCase()}.png`,
    ])
  );

/**
 * Mirrors the server's rule (functions/src/lib/platform-settings.js
 * isAcceptableHeroUrl): a same-origin path or an https URL, nothing
 * protocol-relative, and no query string or fragment — the value is copied
 * onto published content documents, so a token in a `?` would be published.
 * The preview loads only what the server would store.
 */
export function isAcceptableHeroUrl(value) {
  if (typeof value !== 'string') return false;
  if (value.length === 0 || value.length > 2048) return false;
  if (/[\s<>"'`\\?#]/.test(value)) return false;
  if (value.startsWith('/')) return !value.startsWith('//');
  return /^https:\/\/[^/]+/.test(value);
}

/**
 * Thumbnail for one cover. Rendered with `key={src}` by the caller, so a
 * changed value is a fresh instance: a URL that failed to load hides only
 * until the field changes, and a corrected one shows again.
 */
export function HeroPreview({ src, provider }) {
  const [failed, setFailed] = useState(false);
  if (!isAcceptableHeroUrl(src) || failed) return null;
  return (
    <img
      src={src}
      alt={`${provider} cover preview`}
      className="h-10 w-16 shrink-0 rounded border object-cover"
      onLoad={() => setFailed(false)}
      onError={() => setFailed(true)}
    />
  );
}

export function DefaultCoversCard({ value, onChange, onSave, saving, meta }) {
  const heroes = value?.heroes ?? {};
  const setHero = (provider, url) => onChange({ heroes: { ...heroes, [provider]: url } });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <Images className="h-5 w-5" /> Default covers
        </CardTitle>
        <CardDescription>
          The cover a post gets when AI generation is off or fails, chosen by its cloud provider
          (Google Cloud maps to GCP; anything unmatched uses Multi). A same-origin path such as{' '}
          <code>/images/default-heroes/azure.png</code>, a gallery URL under{' '}
          <code>/api/public/media/…</code>, or an https URL. Blank means no default for that
          provider.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 pt-0">
        <StoredState meta={meta} />
        <form
          className="grid gap-3 sm:grid-cols-2"
          onSubmit={(event) => {
            event.preventDefault();
            onSave();
          }}
        >
          {HERO_PROVIDERS.map((provider) => (
            <div key={provider} className="space-y-1">
              <Label htmlFor={`hero-${provider}`}>{provider}</Label>
              <div className="flex items-center gap-2">
                <Input
                  id={`hero-${provider}`}
                  value={heroes[provider] ?? ''}
                  disabled={saving}
                  spellCheck={false}
                  placeholder={`/images/default-heroes/${provider.toLowerCase()}.png`}
                  onChange={(event) => setHero(provider, event.target.value)}
                  className="font-mono text-xs"
                />
                <HeroPreview
                  key={heroes[provider] ?? ''}
                  src={heroes[provider] ?? ''}
                  provider={provider}
                />
              </div>
            </div>
          ))}
          <div className="sm:col-span-2">
            <SaveRow saving={saving}>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={saving}
                onClick={() => onChange({ heroes: bundledDefaultHeroes() })}
                title="Fill every provider with the cover shipped under /images/default-heroes/"
              >
                <Wand2 className="mr-2 h-3.5 w-3.5" /> Use bundled defaults
              </Button>
            </SaveRow>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

export const NEWSLETTER_SETTINGS_PATH = '/admin/newsletter-hub?tab=settings';

/** A pointer, not a copy: the newsletter's settings are edited in one place. */
export function NewsletterSettingsLinkCard() {
  return (
    <Card>
      <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
        <p className="flex items-center gap-2 text-sm">
          <Mail className="h-4 w-4 text-muted-foreground" />
          Newsletter settings live in Newsletter Hub → Settings.
        </p>
        <Link
          to={NEWSLETTER_SETTINGS_PATH}
          className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline"
        >
          Open Newsletter Hub settings <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      </CardContent>
    </Card>
  );
}

export default function ContentDefaultsTab() {
  const { authReady } = useAuthReady();
  const heroes = useSetting('default-heroes', authReady);

  return (
    <div className="space-y-6">
      <SettingSection
        setting={heroes}
        label={SETTING_LABELS['default-heroes']}
        render={(s) => (
          <DefaultCoversCard
            value={s.value}
            meta={s.meta}
            saving={s.saving}
            onChange={s.setValue}
            onSave={() => s.save(s.value)}
          />
        )}
      />
      <NewsletterSettingsLinkCard />
    </div>
  );
}
