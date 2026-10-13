/**
 * IntegrationBadge — the one way a third-party service is credited in the
 * admin: "Powered by <Platform>", in the platform's colour, with a medallion
 * (owner brief 2026-10-06, #918).
 *
 * WHY ONE COMPONENT. Before this, each card that leaned on a service named it
 * in its own way — a title in brackets, an emoji, a sentence — so the same
 * platform looked different on every page and adding a service meant
 * inventing a style. The registry below is the whole of that knowledge: the
 * platform's name, its colours in light and dark, and its site. A card asks
 * for a badge by the service id the Integrations registry already uses
 * (components/admin/integrations/serviceRegistry.jsx) and gets the same pill
 * everywhere; an id the registry does not know renders nothing, so a badge
 * can be placed beside any service without a guard.
 *
 * LOGOS. The brief asks for the platform's logo and typography "when
 * licensing allows". Logos are trademarks with their own guidelines, and
 * shipping an SVG of each in this repository is a licensing decision per
 * platform, not a style one. Until that decision is recorded for a platform
 * (`glyph` below, an SVG path), the medallion is the platform's initial in
 * its colour — the colour is the recognisable part of every one of these
 * marks, and a letter is never a misuse of anyone's logo.
 *
 * COLOURS are the platform's published primary where that is stated on the
 * platform's own site; the entries marked `approximate` were read from the
 * site's wordmark rather than a brand page and are the ones to correct when
 * a brand page says otherwise. Dark mode: a black wordmark colour becomes
 * white (`onDark`), everything else is bright enough as it is.
 *
 * THE LABEL IS THEME FOREGROUND, NOT BRAND COLOUR (review of #921). At the
 * sizes a badge is set in, most brand colours over their own tint fail WCAG
 * AA — AWS orange at about 2:1, Telegram blue at about 2.5:1 against the 4.5:1
 * the text needs — and the admin routes are outside the public contrast scan,
 * so nothing else would catch it. The brand colour stays where it carries
 * recognition and no words: the border, the tint and the medallion.
 *
 * ADMIN ONLY. The 2026-09-28 rule keeps vendors, tools and models off public
 * pages; this component is for the admin surfaces and nothing here changes
 * that.
 */
import React from 'react';

/** service id → how the platform is credited. Ids match serviceRegistry.jsx and the AI providers. */
export const BRANDS = Object.freeze({
  telegram: { name: 'Telegram', color: '#26A5E4', site: 'https://telegram.org' },
  anthropic: { name: 'Anthropic', color: '#D97757', site: 'https://www.anthropic.com' },
  openai: { name: 'OpenAI', color: '#000000', onDark: '#FFFFFF', site: 'https://openai.com' },
  gemini: { name: 'Google Gemini', color: '#4285F4', site: 'https://ai.google.dev' },
  'google-developer': { name: 'Google', color: '#4285F4', site: 'https://developers.google.com' },
  nvidia: { name: 'NVIDIA', color: '#76B900', site: 'https://www.nvidia.com' },
  foundry: { name: 'Microsoft Foundry', color: '#0078D4', site: 'https://ai.azure.com' },
  azure: { name: 'Microsoft Azure', color: '#0078D4', site: 'https://azure.microsoft.com' },
  'azure-speech': {
    name: 'Azure AI Speech',
    color: '#0078D4',
    site: 'https://azure.microsoft.com',
  },
  'microsoft-learn': {
    name: 'Microsoft Learn',
    color: '#0078D4',
    site: 'https://learn.microsoft.com',
  },
  perplexity: { name: 'Perplexity', color: '#20808D', site: 'https://www.perplexity.ai' },
  elevenlabs: {
    name: 'ElevenLabs',
    color: '#000000',
    onDark: '#FFFFFF',
    site: 'https://elevenlabs.io',
  },
  replicate: {
    name: 'Replicate',
    color: '#000000',
    onDark: '#FFFFFF',
    site: 'https://replicate.com',
  },
  firecrawl: {
    name: 'Firecrawl',
    color: '#FF6B35',
    site: 'https://www.firecrawl.dev',
    approximate: true,
  },
  publer: { name: 'Publer', color: '#2E6BFF', site: 'https://publer.com', approximate: true },
  resend: { name: 'Resend', color: '#000000', onDark: '#FFFFFF', site: 'https://resend.com' },
  // The green podbean.com's own stylesheet uses most (read 2026-10-13), not a
  // brand page, hence approximate.
  podbean: {
    name: 'Podbean',
    color: '#428200',
    site: 'https://www.podbean.com',
    approximate: true,
  },
  streamyard: {
    name: 'StreamYard',
    color: '#1F6FEB',
    site: 'https://streamyard.com',
    approximate: true,
  },
  youtube: { name: 'YouTube', color: '#FF0000', site: 'https://www.youtube.com' },
  plaud: { name: 'Plaud', color: '#000000', onDark: '#FFFFFF', site: 'https://www.plaud.ai' },
  sessionize: {
    name: 'Sessionize',
    color: '#0EA5E9',
    site: 'https://sessionize.com',
    approximate: true,
  },
  credly: { name: 'Credly', color: '#FF6B00', site: 'https://www.credly.com' },
  'aws-skill-builder': { name: 'AWS', color: '#FF9900', site: 'https://aws.amazon.com' },
  github: { name: 'GitHub', color: '#24292F', onDark: '#F0F6FC', site: 'https://github.com' },
  cloudflare: { name: 'Cloudflare', color: '#F6821F', site: 'https://www.cloudflare.com' },
  hashicorp: { name: 'HashiCorp', color: '#7B42BC', site: 'https://www.hashicorp.com' },
  coder: { name: 'Coder', color: '#000000', onDark: '#FFFFFF', site: 'https://coder.com' },
  linkie: { name: 'Linkie', color: '#7C3AED', site: 'https://linkie.app', approximate: true },
  qlty: { name: 'Qlty', color: '#3B82F6', site: 'https://qlty.sh', approximate: true },
});

/**
 * Services on the Integrations page that are not one vendor, so no single
 * badge is honest for them: the cloud price lists are three publishers at
 * once, the Hybrid Lab card is Coder on this site's own host behind a
 * Cloudflare check, and the migration add-on (ADR 0035) is this site's own
 * image on that host. They get no badge, by decision rather than omission.
 */
export const COMPOSITE_SERVICES = Object.freeze(['cloud-pricing', 'hybrid-lab', 'migration-addon']);

/** The brand for a service id, or null when the registry has no entry. */
export function brandFor(id) {
  const key = String(id ?? '').toLowerCase();
  return Object.hasOwn(BRANDS, key) ? { id: key, ...BRANDS[key] } : null;
}

const SIZES = {
  xs: { pill: 'gap-1 px-1.5 py-0 text-[10px]', medallion: 'h-3 w-3 text-[7px]' },
  sm: { pill: 'gap-1.5 px-2 py-0.5 text-xs', medallion: 'h-4 w-4 text-[9px]' },
};

/**
 * @param {object} props
 * @param {string} props.id        service id (serviceRegistry / AI provider)
 * @param {string} [props.prefix]  "Powered by" unless the relationship is more exact ("Delivered by")
 * @param {'xs'|'sm'} [props.size]
 * @param {boolean} [props.link]   wrap in a link to the platform's site (opens in a new tab)
 */
export default function IntegrationBadge({
  id,
  prefix = 'Powered by',
  size = 'sm',
  link = false,
  className = '',
}) {
  const brand = brandFor(id);
  if (!brand) return null;
  const sizing = SIZES[size] ?? SIZES.sm;
  const style = { '--brand': brand.color, '--brand-dark': brand.onDark ?? brand.color };
  const label = `${prefix} ${brand.name}`;
  const pill = (
    <span
      className={`inline-flex items-center whitespace-nowrap rounded-full border font-medium border-(--brand)/40 bg-(--brand)/10 text-foreground dark:border-(--brand-dark)/40 dark:bg-(--brand-dark)/10 ${sizing.pill} ${className}`}
      style={style}
      title={`${brand.name} · ${brand.site}`}
      data-brand={brand.id}
    >
      <span
        aria-hidden="true"
        className={`flex shrink-0 items-center justify-center rounded-full bg-(--brand) font-bold text-white dark:bg-(--brand-dark) dark:text-black ${sizing.medallion}`}
      >
        {brand.glyph ? (
          <svg viewBox="0 0 24 24" className="h-[70%] w-[70%]" fill="currentColor">
            <path d={brand.glyph} />
          </svg>
        ) : (
          brand.name.charAt(0)
        )}
      </span>
      {label}
    </span>
  );
  if (!link) return pill;
  return (
    <a
      href={brand.site}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`${label} (opens their site)`}
    >
      {pill}
    </a>
  );
}
