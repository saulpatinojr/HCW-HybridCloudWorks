/**
 * All settings — the index of every setting document the platform reads,
 * where it is stored, where it is edited and who reads it (ADR 0033 §1
 * Platform: settings were split across `admin_config`, `admin_settings` and
 * `cms/config/*` with no one place that listed them).
 *
 * This tab moves nothing. Each setting stays where it is edited — the Audio
 * tab, the Newsletter Hub, AI Engine, Integrations — because that is where the
 * thing it configures is seen working. What was missing was the map, so a
 * reader could find a setting without knowing which hub had grown it. The
 * rows are data (SETTINGS_INDEX), so the test can hold that every row links
 * to a real admin route.
 */

import React from 'react';
import { Link } from 'react-router';
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '@/components/ui/card';
import { ArrowUpRight, ListTree } from 'lucide-react';

/**
 * Every setting document, in the order a reader meets the hubs.
 *
 *   storedAt  container/document, as a Cosmos reader would find it
 *   editedIn  the page and tab a person changes it on
 *   readBy    what consumes it, in words
 *   href      the deep link to the editor
 *   history   whether a save lands in Change history on this hub
 */
export const SETTINGS_INDEX = Object.freeze([
  {
    id: 'default-heroes',
    label: 'Default covers',
    storedAt: 'admin_config/default_heroes',
    editedIn: 'Platform Settings → Content defaults',
    readBy: 'The AI cover trigger, when a post has no cover of its own.',
    href: '/admin/platform-settings?tab=content',
    history: true,
  },
  {
    id: 'content-taxonomy',
    label: 'Content types & idea origins',
    storedAt: 'admin_config/content_taxonomy',
    editedIn: 'Platform Settings → Content types & origins',
    readBy: 'Every content form and board; absent values derive from the source field.',
    href: '/admin/platform-settings?tab=taxonomy',
    history: true,
  },
  {
    id: 'social-autopost',
    label: 'Social autoposting',
    storedAt: 'admin_config/social_autopost',
    editedIn: 'Platform Settings → Social automation',
    readBy: 'The social caption trigger on a live publish, posting through Publer.',
    href: '/admin/platform-settings?tab=social',
    history: true,
  },
  {
    id: 'podcast-feeds',
    label: 'Podcast feeds',
    storedAt: 'admin_config/podcast_feeds',
    editedIn: 'Platform Settings → Audio',
    readBy: 'The podcast ingest timer.',
    href: '/admin/platform-settings?tab=audio',
    history: true,
  },
  {
    id: 'podcast-voices',
    label: 'Podcast voices',
    storedAt: 'admin_config/podcast_voices',
    editedIn: 'Platform Settings → Audio',
    readBy: 'Every podcast render and the ElevenLabs live check.',
    href: '/admin/platform-settings?tab=audio',
    history: true,
  },
  {
    id: 'listen-and-learn-speech',
    label: 'Listen & Learn voice',
    storedAt: 'admin_config/listen_and_learn_speech',
    editedIn: 'Platform Settings → Audio',
    readBy: 'The Listen & Learn episode generator.',
    href: '/admin/platform-settings?tab=audio',
    history: true,
  },
  {
    id: 'reminders',
    label: 'Reminders',
    storedAt: 'admin_config/reminders',
    editedIn: 'Platform Settings → Reminders',
    readBy: 'The daily reminder check, which says each dated reminder on Telegram.',
    href: '/admin/platform-settings?tab=reminders',
    history: true,
  },
  {
    id: 'newsletter-settings',
    label: 'Newsletter settings',
    storedAt: 'admin_config/newsletter_settings',
    editedIn: 'Newsletter Hub → Settings',
    readBy: 'Issue building, the send schedule and the public signup box.',
    href: '/admin/newsletter-hub?tab=settings',
    history: true,
  },
  {
    id: 'ai-providers',
    label: 'AI providers and models',
    storedAt: 'ai_providers (one document per provider)',
    editedIn: 'AI Engine → Providers',
    readBy: 'The AI router: order, enabled switch, model per provider.',
    href: '/admin/ai-engine',
    history: false,
  },
  {
    id: 'mcp-servers',
    label: 'MCP servers',
    storedAt: 'mcp_servers (one document per server; tokens never read back)',
    editedIn: 'AI Engine → MCP',
    readBy: 'The MCP proxy and the Plaud recording reader.',
    href: '/admin/ai-engine',
    history: false,
  },
  {
    id: 'ai-features',
    label: 'AI feature switches',
    storedAt: 'admin_settings/ai_features',
    editedIn: 'AI Engine → AI Services (Where AI is used)',
    readBy: 'Every generator: which features may call a model.',
    href: '/admin/ai-engine',
    history: false,
  },
  {
    id: 'ai-routing',
    label: 'AI model selection: the Priority list and each task’s mode',
    storedAt: 'admin_settings/ai-routing',
    editedIn: 'AI Engine → AI Services (Priority) and Tasks',
    readBy: 'The AI router, through one resolver for every call (ADR 0034).',
    href: '/admin/ai-engine',
    history: false,
  },
  {
    id: 'integrations',
    label: 'Sessionize speaker id',
    storedAt: 'admin_settings/integrations',
    editedIn: 'Integrations → Services → Content → Sessionize',
    readBy: 'The Speaking page and the Sessionize connection test.',
    href: '/admin/integrations?tab=services&group=content',
    history: true,
  },
  {
    id: 'integration-status',
    label: 'Integration test record',
    storedAt: 'admin_settings/integration-status',
    editedIn: 'Written by every connection test on Integrations and Health',
    readBy: 'The Integrations grid and cards: when a service last worked and last failed.',
    href: '/admin/integrations',
    history: false,
  },
  {
    id: 'secrets',
    label: 'API keys and secrets',
    storedAt: 'Azure Key Vault (lights in admin_config/secret_state)',
    editedIn: 'Integrations → Keys',
    readBy: 'Every integration, through its app setting. Values are never read back.',
    href: '/admin/integrations?tab=keys',
    history: false,
  },
  {
    id: 'credential-register',
    label: 'Credential rotation dates',
    storedAt: 'admin_config/credential_register',
    editedIn: 'Integrations → Credentials (Record)',
    readBy:
      'The credential register: the age and due date of each credential only you renew, and its reminder on the Reminders sheet.',
    href: '/admin/integrations?tab=credentials',
    history: false,
  },
  {
    id: 'gallery-folders',
    label: 'Gallery folders',
    storedAt: 'admin_config/gallery_folders',
    editedIn: 'Image Gallery',
    readBy: 'The gallery grid and the image set view.',
    href: '/admin/image-gallery',
    history: false,
  },
  {
    id: 'plaud',
    label: 'Plaud sign-in',
    storedAt: 'mcp_servers/plaud (OAuth tokens, write-only)',
    editedIn: 'Recording Hub → Settings → Connect',
    readBy: 'The recording reader and its 12-hour refresh timer.',
    href: '/admin/recording-hub?tab=settings',
    history: false,
  },
  {
    id: 'lab-agents',
    label: 'Labs agents',
    storedAt: 'lab_agents (one document per agent)',
    editedIn: 'Labs → Agents',
    readBy: 'The agent guard and the labs job queue.',
    href: '/admin/labs?tab=agents',
    history: false,
  },
]);

export default function AllSettingsTab() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <ListTree className="h-5 w-5" aria-hidden="true" /> All settings
        </CardTitle>
        <CardDescription>
          Every document the platform reads as configuration, where it lives and where it is edited.
          Settings stay where the thing they configure is seen working; this is the map. Rows marked
          History land in the Change history tab when saved.
        </CardDescription>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">
              Every platform setting, where it is stored and edited
            </caption>
            <thead className="border-b border-border text-xs uppercase text-muted-foreground">
              <tr>
                <th scope="col" className="py-2 pr-4 font-medium">
                  Setting
                </th>
                <th scope="col" className="py-2 pr-4 font-medium">
                  Stored at
                </th>
                <th scope="col" className="py-2 pr-4 font-medium">
                  Edited in
                </th>
                <th scope="col" className="py-2 pr-4 font-medium">
                  Read by
                </th>
                <th scope="col" className="py-2 font-medium">
                  <span className="sr-only">Open</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {SETTINGS_INDEX.map((row) => (
                <tr key={row.id} className="border-b border-border/60 align-top last:border-0">
                  <td className="py-2 pr-4">
                    <span className="font-medium">{row.label}</span>
                    {row.history ? (
                      <span className="ml-2 rounded-full border border-border px-1.5 text-xs uppercase text-muted-foreground">
                        History
                      </span>
                    ) : null}
                  </td>
                  <td className="py-2 pr-4 font-mono text-xs text-muted-foreground">
                    {row.storedAt}
                  </td>
                  <td className="py-2 pr-4 text-xs">{row.editedIn}</td>
                  <td className="py-2 pr-4 text-xs text-muted-foreground">{row.readBy}</td>
                  <td className="whitespace-nowrap py-2">
                    <Link
                      to={row.href}
                      className="inline-flex items-center gap-1 text-xs font-medium text-primary underline-offset-2 hover:underline"
                      aria-label={`Open ${row.label}`}
                    >
                      Open <ArrowUpRight className="h-3 w-3" aria-hidden="true" />
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
