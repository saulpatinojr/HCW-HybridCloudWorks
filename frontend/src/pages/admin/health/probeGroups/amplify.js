/** The Amplify hub's probes (ADR 0033 §1 Platform, §8): social, mail, Telegram, podcast, recordings, video. */
import { INTEGRATIONS, NEWSLETTER, fromService, liveProbe, snapshotProbe } from '../probeKit';
import { evaluateTelegramNotify } from '../probeEvaluators';
import { runNewsletterBuild } from '../probeRunners';

export const AMPLIFY_PROBES = [
  fromService('publer', {
    hub: 'amplify',
    covers: 'Social autoposting and the Social Hub.',
    impact: 'Live publishes produce no social posts.',
    action: 'Check the key and workspace id lights on Keys; the Social Hub lists refused posts.',
  }),
  fromService('resend', {
    hub: 'amplify',
    covers: 'The mailing list and newsletter sends.',
    impact: 'Issues cannot be sent and sign-ups cannot be confirmed.',
    action: 'Mint a Full access key and paste it on Keys.',
  }),
  liveProbe({
    id: 'newsletter-build',
    label: 'Newsletter build timer',
    hub: 'amplify',
    covers: 'Whether a weekly issue has been built on schedule.',
    impact: 'No issue to review or send this week.',
    action: 'Check the send day in Newsletter Hub Settings and build an issue by hand.',
    href: NEWSLETTER,
    run: runNewsletterBuild,
  }),
  fromService('linkie', {
    hub: 'amplify',
    covers: 'The link-in-bio page.',
    impact: 'New live pages are not added to the bio links.',
    action: 'Rotate the key on Keys.',
  }),
  fromService('telegram', {
    hub: 'amplify',
    covers: 'Approve-or-reject notices and alert messages.',
    impact: 'Nobody is told when content is ready or when something fails.',
    action: 'Re-mint the bot token with BotFather and re-register the webhook.',
  }),
  snapshotProbe({
    id: 'telegram-notify',
    label: 'Telegram notices sent',
    hub: 'amplify',
    covers: 'When each alert source last sent a Telegram message, from the notify cooldown state.',
    impact: 'Silence here with alerts open means notices are not going out.',
    action: 'Test Telegram above; check TELEGRAM_CHAT_ID on Keys.',
    href: INTEGRATIONS('communication'),
    evaluate: evaluateTelegramNotify,
  }),
  fromService('podbean', {
    hub: 'amplify',
    covers: 'Podcast hosting and episode publishing.',
    impact: 'Episodes have to be published by hand in Podbean.',
    action: 'Rotate the client secret on Keys.',
  }),
  fromService('streamyard', {
    hub: 'amplify',
    covers: 'StreamYard On-Air webinar registrations, newsletter invites and Telegram alerts.',
    impact: 'Webinar registrant webhooks and attendance alerts are rejected until the key is set.',
    action: 'Set or rotate STREAMYARD-API-KEY on Keys and run the test on Services.',
  }),
  fromService('plaud', {
    hub: 'amplify',
    covers: 'Recordings and transcripts from the voice recorder.',
    impact: 'The Recording Hub shows no new recordings.',
    action: 'Reconnect from Recording Hub → Settings; the sign-in renews every 12 hours.',
  }),
  fromService('youtube', {
    hub: 'amplify',
    covers: 'The watch-next videos beside Listen & Learn episodes.',
    impact: 'Episodes show no related videos.',
    action: 'Check quota in the Google console; rotate the key on Keys.',
  }),
];
