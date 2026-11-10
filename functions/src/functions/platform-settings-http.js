/**
 * platform-settings-http.js — the Admin → Platform settings page's routes
 * (#351, #352, #348, #571). Registration only; semantics in
 * lib/platform-settings.js.
 *
 * The {setting} segment is allowlisted in the lib (default-heroes,
 * social-autopost, podcast-feeds, listen-and-learn-speech, podcast-voices,
 * newsletter-settings) — anything else 404s before touching Cosmos, the same
 * pattern as cms/config/{collection}.
 *
 * `history` is a literal segment beside that template. Which of the two the
 * Functions host picks for GET .../history is not something to rely on — its
 * precedence has been reported to differ from ASP.NET Core's literal-first
 * rule (Azure/azure-functions-host#9876) — so both answer it the same way:
 * the {setting} GET hands that segment to the same history reader, behind
 * the same editor guard. No setting is named `history`.
 */
import { httpRoute, httpRouteByMethod } from '../lib/auth/http-route.js';
import { getDefaultGuard } from '../lib/auth/default-guard.js';
import {
  createDoc,
  patchDoc,
  queryDocs,
  readDoc,
  replaceDocIfMatch,
  upsertDoc,
} from '../lib/cosmos-client.js';
import { createPlatformSettingsHandlers } from '../lib/platform-settings.js';
import { createNotifier } from '../lib/notify.js';
import { createNotifyTestHandlers } from '../lib/notify-test.js';

const handlers = () =>
  createPlatformSettingsHandlers({
    guard: getDefaultGuard(),
    store: { readDoc, upsertDoc, replaceDocIfMatch, createDoc, queryDocs },
  });

// Test Telegram (owner brief 2026-10-06): one message through the production
// notifier, so the Reminders tab can prove the channel before relying on it.
// The notifier claims its cooldown with a conditional patch, hence patchDoc.
// A literal two-segment path beside the {setting} template; the template
// matches one segment, so the two never meet.
httpRoute('cmsRemindersTelegramTest', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'cms/platform-settings/reminders/test',
  handler: (request, context) =>
    createNotifyTestHandlers({
      guard: getDefaultGuard(),
      notifier: createNotifier({ store: { readDoc, upsertDoc, patchDoc, createDoc }, log: context }),
    }).sendTelegramTest(request, context),
});

httpRoute('cmsPlatformSettingHistory', {
  methods: ['GET'],
  authLevel: 'anonymous',
  route: 'cms/platform-settings/history',
  handler: (request, context) => handlers().getHistory(request, context),
});

httpRouteByMethod('cmsPlatformSetting', {
  authLevel: 'anonymous',
  route: 'cms/platform-settings/{setting}',
  handlers: {
    GET: (request, context) => handlers().getSetting(request, context),
    PUT: (request, context) => handlers().putSetting(request, context),
  },
});
