/**
 * Route-level tests for the dispatch-before-persist webhook contract — TDD red phase.
 *
 * LIF-343 §2 / LIF-336 implementation target.
 *
 * The NEW contract (not yet implemented):
 *   1. Call the plugin worker's handleWebhook RPC.
 *   2. Worker returns { ok, status, reason?, deliveryMetadata? }.
 *   3. Only if ok:true → INSERT a row into plugin_webhook_deliveries.
 *   4. If ok:false → NO insert (critical security gate: no DB writes on auth failure).
 *
 * The CURRENT code (pre-LIF-336) inserts a 'pending' row BEFORE dispatching,
 * so tests 1.3, 1.4, and 1.6 will fail red because a row IS inserted.
 */

import express from "express";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock plugin registry (same pattern as other route tests)
// ---------------------------------------------------------------------------

const mockRegistry = vi.hoisted(() => ({
  getById: vi.fn(),
  getByKey: vi.fn(),
  getConfig: vi.fn(),
  upsertConfig: vi.fn(),
}));

const mockLifecycle = vi.hoisted(() => ({
  load: vi.fn(),
  upgrade: vi.fn(),
  unload: vi.fn(),
  enable: vi.fn(),
  disable: vi.fn(),
  restartWorker: vi.fn(),
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

// ---------------------------------------------------------------------------
// In-memory DB that tracks plugin_webhook_deliveries inserts/selects
// ---------------------------------------------------------------------------

interface DeliveryRow {
  id: string;
  pluginId: string;
  webhookKey: string;
  status: string;
  payload: Record<string, unknown>;
  headers: Record<string, string>;
  startedAt: Date;
  finishedAt?: Date;
  durationMs?: number;
  error?: string;
  deliveryMetadata?: Record<string, unknown>;
}

function createWebhookDb() {
  const deliveries: DeliveryRow[] = [];

  return {
    insert: vi.fn().mockImplementation((_table: unknown) => ({
      values: vi.fn().mockImplementation((vals: Record<string, unknown>) => ({
        returning: vi.fn().mockImplementation((_shape: unknown) => {
          const row: DeliveryRow = {
            id: randomUUID(),
            pluginId: String(vals.pluginId ?? ""),
            webhookKey: String(vals.webhookKey ?? ""),
            status: String(vals.status ?? "pending"),
            payload: (vals.payload as Record<string, unknown>) ?? {},
            headers: (vals.headers as Record<string, string>) ?? {},
            startedAt: (vals.startedAt as Date) ?? new Date(),
          };
          deliveries.push(row);
          return Promise.resolve([{ id: row.id }]);
        }),
      })),
    })),
    update: vi.fn().mockImplementation((_table: unknown) => ({
      set: vi.fn().mockImplementation((updates: Partial<DeliveryRow>) => ({
        where: vi.fn().mockImplementation((_cond: unknown) => {
          // Apply update to matching delivery (last inserted as a simplification)
          const last = deliveries.at(-1);
          if (last) Object.assign(last, updates);
          return Promise.resolve([]);
        }),
      })),
    })),
    select: vi.fn().mockImplementation(() => ({
      from: vi.fn().mockImplementation((_table: unknown) => Promise.resolve([...deliveries])),
    })),
    // Expose raw deliveries for direct assertions where needed
    _deliveries: deliveries,
  };
}

// ---------------------------------------------------------------------------
// Ready plugin fixture
// ---------------------------------------------------------------------------

const PLUGIN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const COMPANY_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function readyPlugin() {
  return {
    id: PLUGIN_ID,
    companyId: COMPANY_ID,
    pluginKey: "github-ci-bridge",
    status: "ready",
    manifestJson: {
      id: "github-ci-bridge",
      apiVersion: 1,
      version: "0.1.0",
      capabilities: ["webhooks.receive"],
      webhooks: [{ endpointKey: "ci_event", description: "CI events" }],
    },
  };
}

// ---------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------

async function createApp(input: {
  workerResult?: unknown;
  workerThrows?: Error;
  db?: ReturnType<typeof createWebhookDb>;
}) {
  const [{ pluginRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/plugins.js"),
    import("../middleware/index.js"),
  ]);

  const db = input.db ?? createWebhookDb();

  mockRegistry.getById.mockResolvedValue(readyPlugin());
  mockRegistry.getByKey.mockResolvedValue(readyPlugin());
  mockRegistry.getConfig.mockResolvedValue({});

  const workerManager = {
    isRunning: vi.fn().mockReturnValue(true),
    call: input.workerThrows
      ? vi.fn().mockRejectedValue(input.workerThrows)
      : vi.fn().mockResolvedValue(input.workerResult ?? { ok: true, status: 202 }),
  };

  const webhookDeps = { workerManager };

  const actor = {
    type: "board",
    userId: "user-1",
    source: "session",
    isInstanceAdmin: false,
    companyIds: [COMPANY_ID],
  };

  const app = express();
  // Express JSON parser — in production the route uses rawBody from `verify`
  // callback; for tests we skip raw-body stashing.
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor as typeof req.actor;
    next();
  });
  app.use(
    "/api",
    pluginRoutes(
      db as never,
      { installPlugin: vi.fn() } as never,
      undefined,
      webhookDeps as never,
      undefined,
      undefined,
    ),
  );
  app.use(errorHandler);

  return { app, workerManager, db };
}

// ---------------------------------------------------------------------------
// Assertions helpers
// ---------------------------------------------------------------------------

async function selectDeliveries(db: ReturnType<typeof createWebhookDb>): Promise<DeliveryRow[]> {
  return db.select().from("plugin_webhook_deliveries") as unknown as Promise<DeliveryRow[]>;
}

// ---------------------------------------------------------------------------
// Webhook endpoint path
// ---------------------------------------------------------------------------

const ENDPOINT = `/api/plugins/${PLUGIN_ID}/webhooks/ci_event`;
const BODY = { action: "completed", workflow_run: { id: 100001, conclusion: "success" } };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("plugin webhook route — dispatch before persist (LIF-336 contract)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("1.1 valid signature → row inserted with status='accepted', HTTP 202", async () => {
    const db = createWebhookDb();
    const { app } = await createApp({
      db,
      workerResult: { ok: true, status: 202 },
    });

    const res = await request(app)
      .post(ENDPOINT)
      .set("Content-Type", "application/json")
      .send(BODY);

    expect(res.status).toBe(202);

    const rows = await selectDeliveries(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("accepted");
  });

  it("1.2 valid signature, unresolved branch → row status='unresolved', HTTP 202", async () => {
    const db = createWebhookDb();
    const { app } = await createApp({
      db,
      workerResult: {
        ok: true,
        status: 202,
        deliveryMetadata: { unresolved: true, reason: "no branch match" },
      },
    });

    const res = await request(app)
      .post(ENDPOINT)
      .set("Content-Type", "application/json")
      .send(BODY);

    expect(res.status).toBe(202);

    const rows = await selectDeliveries(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("unresolved");
  });

  it("1.3 invalid signature → HTTP 401, zero rows inserted (critical security gate)", async () => {
    const db = createWebhookDb();
    const { app } = await createApp({
      db,
      workerResult: { ok: false, status: 401, reason: "invalid_signature" },
    });

    const res = await request(app)
      .post(ENDPOINT)
      .set("Content-Type", "application/json")
      .send(BODY);

    expect(res.status).toBe(401);

    // CRITICAL: no row must be written — this is the DoS fix
    const rows = await selectDeliveries(db);
    expect(rows).toHaveLength(0);
  });

  it("1.4 replay (timestamp skew) → HTTP 401, zero rows inserted", async () => {
    const db = createWebhookDb();
    const { app } = await createApp({
      db,
      workerResult: { ok: false, status: 401, reason: "replay" },
    });

    const res = await request(app)
      .post(ENDPOINT)
      .set("Content-Type", "application/json")
      .send(BODY);

    expect(res.status).toBe(401);

    const rows = await selectDeliveries(db);
    expect(rows).toHaveLength(0);
  });

  it("1.5 plugin worker crash after valid signature gate → row with status='dispatch_failed', HTTP 502", async () => {
    class WorkerCrashError extends Error {
      constructor() {
        super("Worker process exited unexpectedly");
        this.name = "WorkerCrashError";
      }
    }

    const db = createWebhookDb();
    const { app } = await createApp({
      db,
      workerThrows: new WorkerCrashError(),
    });

    const res = await request(app)
      .post(ENDPOINT)
      .set("Content-Type", "application/json")
      .send(BODY);

    expect(res.status).toBe(502);

    const rows = await selectDeliveries(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("dispatch_failed");
  });

  it("1.6 unparseable body → HTTP 400, zero rows inserted", async () => {
    const db = createWebhookDb();
    const { app } = await createApp({ db });

    const res = await request(app)
      .post(ENDPOINT)
      .set("Content-Type", "application/json")
      .send("not json{");

    expect(res.status).toBe(400);

    const rows = await selectDeliveries(db);
    expect(rows).toHaveLength(0);
  });
});
