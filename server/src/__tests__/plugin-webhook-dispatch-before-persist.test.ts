/**
 * Unit tests for POST /api/plugins/:pluginId/webhooks/:endpointKey
 *
 * Verifies the dispatch-before-persist contract introduced in LIF-336:
 *   - ok+accepted  → row inserted with status="accepted", caller gets plugin's status
 *   - ok+unresolved → row inserted with status="unresolved"
 *   - !ok+401      → NO row inserted, caller gets 401
 *   - dispatch_failed → row inserted with status="dispatch_failed", caller gets 502
 *   - null worker response (LIF-364) → NO row inserted, caller gets 401 invalid_signature
 */

import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";

// ---------------------------------------------------------------------------
// Module-level vi.hoisted mocks — must be at the top level before imports
// ---------------------------------------------------------------------------

const mockRegistry = vi.hoisted(() => ({
  getById: vi.fn(),
  getByKey: vi.fn(),
}));

const mockLifecycle = vi.hoisted(() => ({
  load: vi.fn(),
  upgrade: vi.fn(),
}));

vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: () => mockRegistry,
}));

vi.mock("../services/plugin-lifecycle.js", () => ({
  pluginLifecycleManager: () => mockLifecycle,
}));

vi.mock("../services/activity-log.js", () => ({
  logActivity: vi.fn(),
}));

vi.mock("../services/live-events.js", () => ({
  publishGlobalLiveEvent: vi.fn(),
}));

vi.mock("../services/issues.js", () => ({
  issueService: () => ({ getById: vi.fn(), assertCheckoutOwner: vi.fn() }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PLUGIN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DELIVERY_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

function webhookManifest(): PaperclipPluginManifestV1 {
  return {
    id: "paperclip.ci-test",
    apiVersion: 1,
    version: "1.0.0",
    displayName: "CI Test",
    description: "Test webhook plugin",
    author: "Test",
    categories: ["automation"],
    capabilities: ["webhooks.receive"],
    entrypoints: { worker: "dist/worker.js" },
    webhooks: [{ endpointKey: "ci_event", description: "CI event relay" }],
  };
}

function readyPlugin() {
  mockRegistry.getById.mockResolvedValue({
    id: PLUGIN_ID,
    pluginKey: "paperclip.ci-test",
    status: "ready",
    manifestJson: webhookManifest(),
  });
  mockRegistry.getByKey.mockResolvedValue({
    id: PLUGIN_ID,
    pluginKey: "paperclip.ci-test",
    status: "ready",
    manifestJson: webhookManifest(),
  });
}

/**
 * Build a minimal DB mock that records insert calls.
 * Returns `insertSpy` to inspect recorded calls.
 */
function makeDbMock(deliveryId = DELIVERY_ID) {
  const insertedRows: unknown[] = [];
  const db = {
    insert: vi.fn().mockImplementation((table) => {
      void table;
      return {
        values: vi.fn().mockImplementation((row) => {
          insertedRows.push(row);
          return {
            returning: vi.fn().mockResolvedValue([{ id: deliveryId }]),
          };
        }),
      };
    }),
    update: vi.fn().mockImplementation(() => ({
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue(undefined),
    })),
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          limit: vi.fn().mockResolvedValue([]),
        }),
      }),
    }),
  };
  return { db, insertedRows };
}

async function createApp(options: {
  workerResponse?: unknown;
  workerShouldThrow?: boolean;
  workerError?: Error;
  workerReturnsNullish?: "null" | "undefined";
  db?: unknown;
}) {
  const [{ pluginRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/plugins.js"),
    import("../middleware/index.js"),
  ]);

  const resolveValue = options.workerReturnsNullish === "null"
    ? null
    : options.workerReturnsNullish === "undefined"
      ? undefined
      : options.workerResponse ?? { ok: true, status: 202 };

  const workerManager = {
    isRunning: vi.fn().mockReturnValue(true),
    call: options.workerShouldThrow
      ? vi.fn().mockRejectedValue(options.workerError ?? new Error("worker crashed"))
      : vi.fn().mockResolvedValue(resolveValue),
    getWorker: vi.fn().mockReturnValue(null),
  };

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = { type: "unauthenticated" } as typeof req.actor;
    next();
  });

  app.use(
    "/api",
    pluginRoutes(
      (options.db ?? makeDbMock().db) as never,
      { installPlugin: vi.fn() } as never,
      undefined,                     // jobDeps
      { workerManager } as never,    // webhookDeps
      undefined,                     // toolDeps
      undefined,                     // bridgeDeps
    ),
  );
  app.use(errorHandler);

  return { app, workerManager };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.sequential("POST /api/plugins/:pluginId/webhooks/:endpointKey — dispatch-before-persist", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("ok+accepted: dispatches to worker first, inserts row with status=accepted, returns plugin status", async () => {
    readyPlugin();
    const { db, insertedRows } = makeDbMock();
    const { app, workerManager } = await createApp({
      db,
      workerResponse: { ok: true, status: 200 },
    });

    const res = await request(app)
      .post(`/api/plugins/${PLUGIN_ID}/webhooks/ci_event`)
      .send({ ref: "refs/heads/main" });

    // Worker was called before any DB insert
    expect(workerManager.call).toHaveBeenCalledOnce();
    expect(workerManager.call).toHaveBeenCalledWith(
      PLUGIN_ID,
      "handleWebhook",
      expect.objectContaining({ endpointKey: "ci_event" }),
    );

    // Exactly one delivery row inserted with status=accepted
    expect(db.insert).toHaveBeenCalledOnce();
    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0]).toMatchObject({ status: "accepted" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ deliveryId: DELIVERY_ID, status: "accepted" });
  });

  it("ok+unresolved: inserts row with status=unresolved when deliveryMetadata signals it", async () => {
    readyPlugin();
    const { db, insertedRows } = makeDbMock();
    const { app } = await createApp({
      db,
      workerResponse: {
        ok: true,
        status: 200,
        deliveryMetadata: { deliveryStatus: "unresolved" },
      },
    });

    const res = await request(app)
      .post(`/api/plugins/${PLUGIN_ID}/webhooks/ci_event`)
      .send({ ref: "refs/heads/unknown-branch" });

    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0]).toMatchObject({ status: "unresolved" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "unresolved" });
  });

  it("!ok+401: writes NO delivery row and returns the plugin's status code", async () => {
    readyPlugin();
    const { db, insertedRows } = makeDbMock();
    const { app, workerManager } = await createApp({
      db,
      workerResponse: { ok: false, status: 401, reason: "invalid signature" },
    });

    const res = await request(app)
      .post(`/api/plugins/${PLUGIN_ID}/webhooks/ci_event`)
      .send({ junk: true });

    // Worker was called
    expect(workerManager.call).toHaveBeenCalledOnce();

    // No DB insert
    expect(db.insert).not.toHaveBeenCalled();
    expect(insertedRows).toHaveLength(0);

    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ status: "rejected", reason: "invalid signature" });
  });

  it("dispatch_failed: inserts row with status=dispatch_failed and returns 502 when worker throws", async () => {
    readyPlugin();
    const { db, insertedRows } = makeDbMock();
    const { app, workerManager } = await createApp({
      db,
      workerShouldThrow: true,
      workerError: new Error("worker timed out"),
    });

    const res = await request(app)
      .post(`/api/plugins/${PLUGIN_ID}/webhooks/ci_event`)
      .send({ event: "push" });

    // Worker was attempted
    expect(workerManager.call).toHaveBeenCalledOnce();

    // One dispatch_failed row inserted
    expect(db.insert).toHaveBeenCalledOnce();
    expect(insertedRows).toHaveLength(1);
    expect(insertedRows[0]).toMatchObject({ status: "dispatch_failed" });
    expect((insertedRows[0] as Record<string, unknown>).error).toBe("worker timed out");

    expect(res.status).toBe(502);
    expect(res.body).toMatchObject({ deliveryId: DELIVERY_ID, status: "dispatch_failed" });
  });

  // Regression: LIF-364 — workerManager.call returns null (not throws) when the
  // plugin worker has no config/secret yet. Before the null-guard at
  // plugins.ts:2330–2354 this dereferenced `.ok` and surfaced as HTTP 500.
  // Expected behaviour: coerce nullish to { ok:false, status:401, reason:"invalid_signature" }.
  it.each([
    ["null", "null" as const],
    ["undefined", "undefined" as const],
  ])("nullish worker response (%s): writes NO delivery row and returns 401 invalid_signature", async (_label, nullish) => {
    readyPlugin();
    const { db, insertedRows } = makeDbMock();
    const { app, workerManager } = await createApp({
      db,
      workerReturnsNullish: nullish,
    });

    const res = await request(app)
      .post(`/api/plugins/${PLUGIN_ID}/webhooks/ci_event`)
      .send({ unsigned: true });

    expect(workerManager.call).toHaveBeenCalledOnce();
    expect(db.insert).not.toHaveBeenCalled();
    expect(insertedRows).toHaveLength(0);
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ status: "rejected", reason: "invalid_signature" });
  });

  it("returns 404 when plugin is not found", async () => {
    mockRegistry.getById.mockResolvedValue(null);
    mockRegistry.getByKey.mockResolvedValue(null);
    const { db } = makeDbMock();
    const { app } = await createApp({ db });

    const res = await request(app)
      .post(`/api/plugins/nonexistent/webhooks/ci_event`)
      .send({});

    expect(db.insert).not.toHaveBeenCalled();
    expect(res.status).toBe(404);
  });

  it("returns 404 when endpointKey is not declared in the manifest", async () => {
    readyPlugin();
    const { db } = makeDbMock();
    const { app } = await createApp({ db });

    const res = await request(app)
      .post(`/api/plugins/${PLUGIN_ID}/webhooks/unknown_key`)
      .send({});

    expect(db.insert).not.toHaveBeenCalled();
    expect(res.status).toBe(404);
  });
});
