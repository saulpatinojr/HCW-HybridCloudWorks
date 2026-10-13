import { describe, it, expect, vi } from "vitest";
import {
  createStreamYardHandlers,
  extractWebhookKey,
  maskEmail,
  parseRegistrantPayload,
  STREAMYARD_ONAIR_CONFIG_ID,
} from "./onair.js";
import { ADMIN_CONFIG_PARTITION } from "../cosmos-client.js";

function makeStore(initialDoc = null) {
  const docs = new Map();
  if (initialDoc) {
    docs.set(
      `${ADMIN_CONFIG_PARTITION}:${STREAMYARD_ONAIR_CONFIG_ID}`,
      initialDoc,
    );
  }
  return {
    docs,
    readDoc: vi.fn(
      async (container, id) => docs.get(`${container}:${id}`) || null,
    ),
    upsertDoc: vi.fn(async (container, doc) => {
      docs.set(`${container}:${doc.id}`, doc);
      return doc;
    }),
    incrementIf: vi.fn(async () => ({ count: 1 })),
  };
}

function makeGuard(allowed = true) {
  return {
    requireRole: vi.fn(async () =>
      allowed
        ? { user: { oid: "admin-1" }, role: "editor" }
        : {
            error: {
              status: 403,
              headers: {},
              body: JSON.stringify({ ok: false, error: "Forbidden" }),
            },
          },
    ),
  };
}

function makeRequest({ body = null, headers = {} } = {}) {
  const lower = Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return {
    headers: {
      get: (name) => lower[String(name).toLowerCase()] ?? null,
    },
    json: async () => body,
  };
}

const context = {
  log: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

describe("streamyard/onair helpers", () => {
  it("masks email addresses without exposing the local part", () => {
    expect(maskEmail("Saul.Patino@Example.com")).toBe("s***@example.com");
    expect(maskEmail("invalid")).toBe("***");
  });

  it("extracts the webhook key from X-StreamYard-Api-Key or Authorization Bearer", () => {
    expect(
      extractWebhookKey(
        makeRequest({ headers: { "X-StreamYard-Api-Key": " sy-key-1 " } }),
      ),
    ).toBe("sy-key-1");
    expect(
      extractWebhookKey(
        makeRequest({ headers: { Authorization: "Bearer sy-key-2" } }),
      ),
    ).toBe("sy-key-2");
    expect(extractWebhookKey(makeRequest())).toBe("");
  });

  it("validates registrant payloads and rejects unknown fields", () => {
    expect(parseRegistrantPayload(null).error).toMatch(/JSON object/);
    expect(
      parseRegistrantPayload({ email: "a@b.com", extra: 1 }).error,
    ).toMatch(/Unknown field/);
    expect(parseRegistrantPayload({ email: "not-an-email" }).error).toMatch(
      /valid email/,
    );
    expect(
      parseRegistrantPayload({ email: "a@b.com", status: "bogus" }).error,
    ).toMatch(/status must be one of/);

    const valid = parseRegistrantPayload({
      email: "Alice@Example.com",
      firstName: "Alice",
      webinarTitle: "Azure Landing Zones Live",
      status: "Attended Live",
    });
    expect(valid.error).toBeUndefined();
    expect(valid.value).toMatchObject({
      email: "Alice@Example.com",
      firstName: "Alice",
      webinarTitle: "Azure Landing Zones Live",
      status: "attended_live",
      subscribeNewsletter: true,
    });
  });
});

describe("createStreamYardHandlers", () => {
  it("getStatus returns configuration flags and stored registrant summary for editors", async () => {
    const store = makeStore({
      id: STREAMYARD_ONAIR_CONFIG_ID,
      totalRegistrants: 4,
      totalAttended: 2,
      lastEventAt: "2026-10-12T12:00:00.000Z",
      recentRegistrants: [
        {
          maskedEmail: "a***@example.com",
          webinarTitle: "Hybrid Cloud Deep Dive",
          status: "registered",
          source: "webhook",
          newsletterInvited: true,
          telegramSent: true,
          recordedAt: "2026-10-12T12:00:00.000Z",
        },
      ],
    });
    const handlers = createStreamYardHandlers({
      guard: makeGuard(true),
      store,
      env: {
        STREAMYARD_API_KEY: "sy-secret",
        RESEND_API_KEY: "re-secret",
        TELEGRAM_BOT_TOKEN: "tg-token",
        TELEGRAM_CHAT_ID: "12345",
      },
      sendTelegram: vi.fn(async () => ({ sent: true })),
    });

    const res = await handlers.getStatus(makeRequest(), context);
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toMatchObject({
      ok: true,
      configured: true,
      newsletterConfigured: true,
      telegramConfigured: true,
      totalRegistrants: 4,
      totalAttended: 2,
    });
    expect(body.recentRegistrants).toHaveLength(1);
  });

  it("testEvent returns INTEGRATION_NOT_CONFIGURED when STREAMYARD_API_KEY is unset", async () => {
    const handlers = createStreamYardHandlers({
      guard: makeGuard(true),
      store: makeStore(),
      env: {},
      sendTelegram: vi.fn(async () => ({ sent: false })),
    });

    const res = await handlers.testEvent(makeRequest({ body: {} }), context);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      ok: false,
      code: "INTEGRATION_NOT_CONFIGURED",
    });
  });

  it("testEvent records a synthetic event and sends a Telegram alert when configured", async () => {
    const store = makeStore();
    const sendTelegram = vi.fn(async () => ({ sent: true }));
    const handlers = createStreamYardHandlers({
      guard: makeGuard(true),
      store,
      env: { STREAMYARD_API_KEY: "sy-secret" },
      sendTelegram,
      now: () => Date.parse("2026-10-12T18:00:00.000Z"),
    });

    const res = await handlers.testEvent(
      makeRequest({
        body: { webinarTitle: "Zero Trust Lab", status: "registered" },
      }),
      context,
    );
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.ok).toBe(true);
    expect(data.totalRegistrants).toBe(1);
    expect(data.event).toMatchObject({
      maskedEmail: "t***@hybridcloudworks.com",
      webinarTitle: "Zero Trust Lab",
      status: "registered",
      source: "test",
      telegramSent: true,
    });
    expect(sendTelegram).toHaveBeenCalledTimes(1);
  });

  it("webhook authenticates STREAMYARD_API_KEY in constant time, invites registrant to newsletter, and notifies Telegram", async () => {
    const store = makeStore();
    const sendTelegram = vi.fn(async () => ({ sent: true }));
    const sendEmail = vi.fn(async () => ({ ok: true, id: "email-1" }));
    const handlers = createStreamYardHandlers({
      guard: makeGuard(true),
      store,
      env: {
        STREAMYARD_API_KEY: "sy-live-key",
        RESEND_API_KEY: "re-live-key",
      },
      createResend: () => ({ sendEmail }),
      sendTelegram,
      now: () => Date.parse("2026-10-12T19:00:00.000Z"),
    });

    const unauth = await handlers.webhook(
      makeRequest({
        headers: { "X-StreamYard-Api-Key": "wrong-key" },
        body: { email: "user@example.com" },
      }),
      context,
    );
    expect(unauth.status).toBe(401);

    const okRes = await handlers.webhook(
      makeRequest({
        headers: { "X-StreamYard-Api-Key": "sy-live-key" },
        body: {
          email: "reader@example.com",
          firstName: "Reader",
          webinarTitle: "Multi-Cloud Networking",
          status: "registered",
        },
      }),
      context,
    );
    expect(okRes.status).toBe(200);
    expect(JSON.parse(okRes.body)).toEqual({
      ok: true,
      status: "registered",
      newsletterInvited: true,
      telegramSent: true,
    });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendTelegram).toHaveBeenCalledTimes(1);

    // Attendance update increments totalAttended without re-sending newsletter confirmation
    const attendedRes = await handlers.webhook(
      makeRequest({
        headers: { Authorization: "Bearer sy-live-key" },
        body: {
          email: "reader@example.com",
          webinarTitle: "Multi-Cloud Networking",
          status: "attended_live",
        },
      }),
      context,
    );
    expect(attendedRes.status).toBe(200);
    expect(JSON.parse(attendedRes.body)).toEqual({
      ok: true,
      status: "attended_live",
      newsletterInvited: false,
      telegramSent: true,
    });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const saved = store.docs.get(
      `${ADMIN_CONFIG_PARTITION}:${STREAMYARD_ONAIR_CONFIG_ID}`,
    );
    expect(saved.totalRegistrants).toBe(1);
    expect(saved.totalAttended).toBe(1);
  });

  it("publicRegister verifies Cloudflare origin identity, honors honeypot, and records website registrations", async () => {
    const store = makeStore();
    const sendTelegram = vi.fn(async () => ({ sent: true }));
    const sendEmail = vi.fn(async () => ({ ok: true, id: "email-2" }));
    const handlers = createStreamYardHandlers({
      guard: makeGuard(true),
      identity: {
        anonymousKey: vi.fn(() => ({ key: "client-hash-1" })),
      },
      store,
      env: {
        RESEND_API_KEY: "re-live-key",
      },
      createResend: () => ({ sendEmail }),
      sendTelegram,
      now: () => Date.parse("2026-10-12T19:30:00.000Z"),
    });

    // Honeypot filled -> silent 200, no writes
    const botRes = await handlers.publicRegister(
      makeRequest({
        body: {
          email: "bot@example.com",
          website: "https://spam.example",
        },
      }),
      context,
    );
    expect(botRes.status).toBe(200);
    expect(sendEmail).not.toHaveBeenCalled();

    // Real registration -> 201
    const regRes = await handlers.publicRegister(
      makeRequest({
        body: {
          email: "architect@example.com",
          firstName: "Cloud",
          webinarTitle: "Azure Migrate Live Lab",
          subscribeNewsletter: true,
        },
      }),
      context,
    );
    expect(regRes.status).toBe(201);
    expect(JSON.parse(regRes.body)).toMatchObject({
      ok: true,
      newsletterInvited: true,
    });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendTelegram).toHaveBeenCalledTimes(1);
  });
});
