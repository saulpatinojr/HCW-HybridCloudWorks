/**
 * ambassador-http.test.js — handler-level tests for the Ambassador HTTP registration (QA-2 #977).
 *
 * Verifies that the routes registered in ambassador-http.js correctly invoke
 * the underlying ambassador handlers with guards and stores wired.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { DEFAULT_PROGRAMS } from "../lib/ambassador/programs.js";

const registrations = new Map();
vi.mock("../lib/auth/http-route.js", async (importOriginal) => ({
  ...(await importOriginal()),
  httpRoute: (name, options) => registrations.set(name, options),
  httpRouteByMethod: (name, options) => registrations.set(name, options),
}));

const mockRequireRole = vi.fn(async (_req, role) => ({
  user: { oid: "user-1", name: "Tester" },
  role,
  error: null,
}));
const mockRequireUser = vi.fn(async () => ({
  user: { oid: "user-1", name: "Tester" },
  error: null,
}));

vi.mock("../lib/auth/default-guard.js", () => ({
  getDefaultGuard: () => ({
    requireRole: (...args) => mockRequireRole(...args),
    requireUser: (...args) => mockRequireUser(...args),
  }),
}));

const queryDocs = vi.fn();
const readDoc = vi.fn();
const createDoc = vi.fn();
const upsertDoc = vi.fn();
const patchDoc = vi.fn();
vi.mock("../lib/cosmos-client.js", async (importOriginal) => ({
  ...(await importOriginal()),
  queryDocs: (...args) => queryDocs(...args),
  readDoc: (...args) => readDoc(...args),
  createDoc: (...args) => createDoc(...args),
  upsertDoc: (...args) => upsertDoc(...args),
  patchDoc: (...args) => patchDoc(...args),
}));

vi.mock("../lib/blob-storage.js", () => ({
  readBlobForDelivery: vi.fn(async () => ({
    stream: null,
    contentType: "application/pdf",
    contentLength: 100,
  })),
}));

await import("./ambassador-http.js");

const makeContext = () => ({
  log: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  invocationId: "inv-ambassador-1",
});
const makeRequest = ({
  method = "GET",
  body = {},
  params = {},
  query = {},
} = {}) => ({
  method,
  params,
  query: new URLSearchParams(query),
  headers: new Headers({ "user-agent": "vitest" }),
  json: async () => body,
  text: async () => JSON.stringify(body),
});

describe("ambassador-http route registrations (QA-2 #977)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("registers all expected ambassador routes", () => {
    expect(registrations.has("cmsAmbassadorFile")).toBe(true);
    expect(registrations.has("cmsAmbassadorPrograms")).toBe(true);
    expect(registrations.has("cmsAmbassadorProgramById")).toBe(true);
    expect(registrations.has("cmsAmbassadorApplications")).toBe(true);
    expect(registrations.has("cmsAmbassadorApplicationById")).toBe(true);
    expect(registrations.has("cmsAmbassadorEvidence")).toBe(true);
    expect(registrations.has("cmsAmbassadorEvidenceImport")).toBe(true);
    expect(registrations.has("cmsAmbassadorEvidenceSources")).toBe(true);
    expect(registrations.has("cmsAmbassadorEvidenceById")).toBe(true);
    expect(registrations.has("cmsAmbassadorReadiness")).toBe(true);
  });

  it("routes GET cms/ambassador/programs to listPrograms", async () => {
    queryDocs.mockResolvedValue(
      DEFAULT_PROGRAMS.map((p) => ({ ...p, docType: "program" })),
    );
    const reg = registrations.get("cmsAmbassadorPrograms");
    const res = await reg.handlers.GET(makeRequest(), makeContext());
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.success).toBe(true);
    expect(Array.isArray(data.items)).toBe(true);
  });

  it("routes GET cms/ambassador/readiness/{programId} to readiness", async () => {
    queryDocs.mockResolvedValue([]);
    readDoc.mockResolvedValue({
      id: "prog-1",
      docType: "program",
      requirements: [],
    });
    const reg = registrations.get("cmsAmbassadorReadiness");
    const res = await reg.handler(
      makeRequest({ params: { programId: "prog-1" } }),
      makeContext(),
    );
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body);
    expect(data.success).toBe(true);
    expect(data.readiness).toBeDefined();
  });

  it("denies GET cms/ambassador/programs when role check fails", async () => {
    mockRequireRole.mockResolvedValueOnce({
      user: null,
      role: null,
      error: {
        status: 403,
        headers: {},
        body: JSON.stringify({ success: false, error: "Forbidden" }),
      },
    });
    const reg = registrations.get("cmsAmbassadorPrograms");
    const res = await reg.handlers.GET(makeRequest(), makeContext());
    expect(res.status).toBe(403);
    expect(mockRequireRole).toHaveBeenCalledWith(expect.anything(), "editor");
    expect(queryDocs).not.toHaveBeenCalled();
  });
});
