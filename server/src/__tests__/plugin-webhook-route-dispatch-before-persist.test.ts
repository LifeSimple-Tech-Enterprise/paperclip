import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  createDb,
  pluginWebhookDeliveries,
  plugins,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { pluginRoutes } from "../routes/plugins.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";

/**
 * LIF-343 §2 / LIF-336 — Dispatch-before-persist contract for the plugin
 * webhook ingestion route.
 *
 * **Security gate (the heart of LIF-336):** the route MUST consult the plugin
 * worker's `handleWebhook` return value BEFORE writing a row to
 * `plugin_webhook_deliveries`. The current implementation persists first and
 * dispatches after, which means an attacker can flood the table with rows
 * carrying invalid signatures (DoS / log noise vector).
 *
 * The new contract returns:
 *   { ok: true,  status?: number, deliveryMetadata?: object }                — happy path
 *   { ok: false, status: 401|403, reason: "invalid_signature" | "replay" }   — auth fail
 *   { ok: false, status: 400,     reason: "unparseable_body" }               — parse fail
 * Plus exceptions thrown by the worker → row with status='dispatch_failed'.
 *
 * RED-phase: every assertion below targets behaviour LIF-336 will introduce.
 * The current code:
 *   - inserts a `pending` row before dispatching (fails the zero-row asserts);
 *   - ignores the worker's return value (fails the 401/400 status asserts);
 *   - on RPC throw, sets status='failed' (fails the 'dispatch_failed' assert).
 *
 * `pnpm --filter @paperclipai/paperclip-server test` should show 6 reds.
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping plugin-webhook dispatch-before-persist tests: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const PLUGIN_ID = "11111111-1111-4111-8111-111111111111";
const PLUGIN_KEY = "paperclipai.plugin-github-ci-bridge";
const ENDPOINT_KEY = "ci_event";

describeEmbeddedPostgres("plugin webhook route — dispatch-before-persist (LIF-336)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plugin-webhook-route-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(pluginWebhookDeliveries);
    await db.delete(plugins);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedPlugin() {
    await db.insert(plugins).values({
      id: PLUGIN_ID,
      pluginKey: PLUGIN_KEY,
      packageName: "@paperclipai/plugin-github-ci-bridge",
      version: "0.1.0",
      apiVersion: 1,
      categories: [],
      status: "ready",
      manifestJson: {
        id: PLUGIN_KEY,
        version: "0.1.0",
        displayName: "GitHub CI Bridge",
        description: "Receives workflow_run webhooks",
        author: "test",
        capabilities: ["webhooks.receive"],
        webhooks: [
          {
            endpointKey: ENDPOINT_KEY,
            displayName: "GitHub workflow_run relay",
            description: "Receives GitHub workflow_run completion events",
          },
        ],
      } as never,
    });
  }

  /**
   * Build the express app. `workerHandleWebhook` is the mocked plugin RPC
   * surface — tests parameterise it per scenario (return ok:false, throw, etc).
   */
  async function createApp(workerHandleWebhook: (payload: unknown) => Promise<unknown>) {
    const workerManager = {
      call: vi.fn(async (_pluginId: string, method: string, payload: unknown) => {
        if (method !== "handleWebhook") throw new Error(`unexpected RPC: ${method}`);
        return workerHandleWebhook(payload);
      }),
    } as unknown as PluginWorkerManager;

    const loader = { installPlugin: vi.fn() };

    const app = express();
    app.use(
      express.json({
        verify: (req, _res, buf) => {
          (req as unknown as { rawBody?: Buffer }).rawBody = Buffer.from(buf);
        },
      }),
    );
    app.use((req, _res, next) => {
      req.actor = { type: "system" } as typeof req.actor;
      next();
    });
    app.use(
      "/api",
      pluginRoutes(db, loader as never, undefined, { workerManager }),
    );

    return { app, workerManager };
  }

  async function countDeliveries(): Promise<number> {
    const rows = await db.select().from(pluginWebhookDeliveries).where(eq(pluginWebhookDeliveries.pluginId, PLUGIN_ID));
    return rows.length;
  }

  it("1.1 invalid signature → plugin returns ok:false reason='invalid_signature' → HTTP 401, ZERO rows inserted (security gate)", async () => {
    await seedPlugin();
    const { app } = await createApp(async () => ({
      ok: false,
      status: 401,
      reason: "invalid_signature",
    }));

    const res = await request(app)
      .post(`/api/plugins/${PLUGIN_ID}/webhooks/${ENDPOINT_KEY}`)
      .set("x-hub-signature-256", "sha256=deadbeef")
      .set("x-paperclip-timestamp", String(Math.floor(Date.now() / 1000)))
      .send({ workflow_run: { id: 1 } });

    expect(res.status).toBe(401);
    expect(await countDeliveries()).toBe(0); // CRITICAL: no row written for forged signatures
  }, 30_000);

  it("1.2 replay (timestamp drift > 5min) → plugin returns ok:false reason='replay' → HTTP 401, ZERO rows inserted", async () => {
    await seedPlugin();
    const { app } = await createApp(async () => ({
      ok: false,
      status: 401,
      reason: "replay",
    }));

    const staleTs = Math.floor(Date.now() / 1000) - 600; // 10 minutes in the past
    const res = await request(app)
      .post(`/api/plugins/${PLUGIN_ID}/webhooks/${ENDPOINT_KEY}`)
      .set("x-hub-signature-256", "sha256=stillvalidsignaturejustold")
      .set("x-paperclip-timestamp", String(staleTs))
      .send({ workflow_run: { id: 2 } });

    expect(res.status).toBe(401);
    expect(await countDeliveries()).toBe(0); // CRITICAL: replays leave no trace
  }, 30_000);

  it("1.3 unparseable body → plugin returns ok:false reason='unparseable_body' → HTTP 400, ZERO rows inserted", async () => {
    await seedPlugin();
    const { app } = await createApp(async () => ({
      ok: false,
      status: 400,
      reason: "unparseable_body",
    }));

    const res = await request(app)
      .post(`/api/plugins/${PLUGIN_ID}/webhooks/${ENDPOINT_KEY}`)
      .set("x-hub-signature-256", "sha256=whatever")
      .set("x-paperclip-timestamp", String(Math.floor(Date.now() / 1000)))
      .send({ "garbage payload, missing workflow_run": true });

    expect(res.status).toBe(400);
    expect(await countDeliveries()).toBe(0);
  }, 30_000);

  it("1.4 valid signature + happy path → plugin returns ok:true → HTTP 200, ONE row with status='accepted' AND dispatch was called", async () => {
    await seedPlugin();
    const handle = vi.fn(async () => ({
      ok: true,
      status: 200,
      deliveryMetadata: { issueId: "issue-A-uuid", action: "wake" },
    }));
    const { app, workerManager } = await createApp(handle);

    const res = await request(app)
      .post(`/api/plugins/${PLUGIN_ID}/webhooks/${ENDPOINT_KEY}`)
      .set("x-hub-signature-256", "sha256=valid")
      .set("x-paperclip-timestamp", String(Math.floor(Date.now() / 1000)))
      .send({ workflow_run: { id: 100001 } });

    expect(res.status).toBe(200);
    expect(handle).toHaveBeenCalledTimes(1);
    expect(workerManager.call).toHaveBeenCalledWith(
      PLUGIN_ID,
      "handleWebhook",
      expect.objectContaining({ endpointKey: ENDPOINT_KEY }),
    );

    const rows = await db.select().from(pluginWebhookDeliveries).where(eq(pluginWebhookDeliveries.pluginId, PLUGIN_ID));
    expect(rows).toHaveLength(1);
    // LIF-336 introduces 'accepted' as the canonical happy-path status, replacing the
    // pre-LIF-336 'success' value. 'accepted' more accurately reflects that the host
    // accepted the delivery and the plugin worker validated the payload — actual
    // downstream side-effects (wakes, comments) may still occur asynchronously.
    expect(rows[0].status).toBe("accepted");
    expect(rows[0].webhookKey).toBe(ENDPOINT_KEY);
  }, 30_000);

  it("1.5 worker crash AFTER signature passes → row with status='dispatch_failed' (so SRE alerts) and HTTP 502", async () => {
    await seedPlugin();
    const { app } = await createApp(async () => {
      throw new Error("worker crashed mid-dispatch");
    });

    const res = await request(app)
      .post(`/api/plugins/${PLUGIN_ID}/webhooks/${ENDPOINT_KEY}`)
      .set("x-hub-signature-256", "sha256=valid")
      .set("x-paperclip-timestamp", String(Math.floor(Date.now() / 1000)))
      .send({ workflow_run: { id: 100002 } });

    expect(res.status).toBe(502);

    const rows = await db.select().from(pluginWebhookDeliveries).where(eq(pluginWebhookDeliveries.pluginId, PLUGIN_ID));
    expect(rows).toHaveLength(1);
    // NEW contract: distinguish "plugin rejected" (no row) from "plugin crashed" (row, dispatch_failed).
    // Current code uses 'failed' for both; LIF-336 introduces 'dispatch_failed' for the latter.
    expect(rows[0].status).toBe("dispatch_failed");
    expect(rows[0].error).toMatch(/worker crashed/);
  }, 30_000);

  it("1.6 plugin resolves event but issue cannot be matched → ok:true status='unresolved' → HTTP 200, ONE row with status='unresolved' (no comment/wake side-effects, but auditable)", async () => {
    await seedPlugin();
    const { app } = await createApp(async () => ({
      ok: true,
      status: 200,
      deliveryMetadata: { unresolved: true, branch: "main" },
    }));

    const res = await request(app)
      .post(`/api/plugins/${PLUGIN_ID}/webhooks/${ENDPOINT_KEY}`)
      .set("x-hub-signature-256", "sha256=valid")
      .set("x-paperclip-timestamp", String(Math.floor(Date.now() / 1000)))
      .send({ workflow_run: { id: 100003, head_branch: "main", pull_requests: [] } });

    expect(res.status).toBe(200);

    const rows = await db.select().from(pluginWebhookDeliveries).where(eq(pluginWebhookDeliveries.pluginId, PLUGIN_ID));
    expect(rows).toHaveLength(1);
    // Distinguish "delivered + processed but no issue match" — for unresolvable events
    // the host can show "received but not actionable" in the dashboard rather than
    // a misleading 'success' that suggests an agent was woken.
    expect(rows[0].status).toBe("unresolved");
  }, 30_000);
});
