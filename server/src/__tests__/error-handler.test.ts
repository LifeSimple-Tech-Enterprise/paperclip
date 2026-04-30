import type { NextFunction, Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { HttpError, descriptiveError } from "../errors.js";
import { errorHandler, formatZodError } from "../middleware/error-handler.js";

function makeReq(): Request {
  return {
    method: "GET",
    originalUrl: "/api/test",
    body: { a: 1 },
    params: { id: "123" },
    query: { q: "x" },
  } as unknown as Request;
}

function makeRes(): Response {
  const res = {
    status: vi.fn(),
    json: vi.fn(),
  } as unknown as Response;
  (res.status as unknown as ReturnType<typeof vi.fn>).mockReturnValue(res);
  return res;
}

describe("errorHandler — 500 fallthrough (carry-forward)", () => {
  it("attaches the original Error to res.err for 500s", () => {
    const req = makeReq();
    const res = makeRes() as any;
    const next = vi.fn() as unknown as NextFunction;
    const err = new Error("boom");

    errorHandler(err, req, res, next);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: "Internal server error" });
    expect(res.err).toBe(err);
    expect(res.__errorContext?.error?.message).toBe("boom");
  });

  it("attaches HttpError instances for 500 responses", () => {
    const req = makeReq();
    const res = makeRes() as any;
    const next = vi.fn() as unknown as NextFunction;
    const err = new HttpError(500, "db exploded");

    errorHandler(err, req, res, next);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: "db exploded" });
    expect(res.err).toBe(err);
    expect(res.__errorContext?.error?.message).toBe("db exploded");
  });
});

describe("errorHandler — 422 descriptive envelope (LIF-375 Stage 3a)", () => {
  it("emits {error, code, details} for descriptiveError", () => {
    const err = descriptiveError("INVALID_KIND", "kind must be foo|bar", { kind: "baz" });
    const res = makeRes() as any;
    errorHandler(err, makeReq(), res, vi.fn() as unknown as NextFunction);
    expect(res.status).toHaveBeenCalledWith(422);
    expect(res.json).toHaveBeenCalledWith({
      error: "kind must be foo|bar",
      code: "INVALID_KIND",
      details: { kind: "baz" },
    });
  });

  it("uncoded HttpError(422) → UNKNOWN_VALIDATION_ERROR + guidance + originalMessage", () => {
    const err = new HttpError(422, "raw legacy message");
    const res = makeRes() as any;
    errorHandler(err, makeReq(), res, vi.fn() as unknown as NextFunction);
    expect(res.status).toHaveBeenCalledWith(422);
    const payload = (res.json as any).mock.calls[0][0];
    expect(payload.code).toBe("UNKNOWN_VALIDATION_ERROR");
    expect(payload.error).toBe("raw legacy message");
    expect(payload.details.originalMessage).toBe("raw legacy message");
    expect(payload.details.guidance).toMatch(/no structured `code`/);
  });

  it("preserves details for non-422 HttpError without a code", () => {
    const err = new HttpError(403, "no access");
    const res = makeRes() as any;
    errorHandler(err, makeReq(), res, vi.fn() as unknown as NextFunction);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: "no access" });
  });
});

describe("errorHandler — ZodError → 422 with formatZodError", () => {
  it("flattens issues to `path: message` strings", () => {
    const schema = z.object({ name: z.string(), nested: z.object({ age: z.number() }) });
    const result = schema.safeParse({ name: 1, nested: { age: "x" } });
    expect(result.success).toBe(false);
    if (result.success) return;
    const flat = formatZodError(result.error);
    expect(flat.issues).toBeInstanceOf(Array);
    expect(flat.issues.length).toBeGreaterThanOrEqual(2);
    expect(flat.issues.every((i) => typeof i === "string")).toBe(true);
    expect(flat.issues.some((i) => i.startsWith("name:"))).toBe(true);
    expect(flat.issues.some((i) => i.startsWith("nested.age:"))).toBe(true);
  });

  it("ZodError thrown into errorHandler emits 422 with VALIDATION_ERROR + flat issues", () => {
    const schema = z.object({ name: z.string() });
    const parsed = schema.safeParse({ name: 1 });
    if (parsed.success) throw new Error("expected zod failure for test");
    const res = makeRes() as any;
    errorHandler(parsed.error, makeReq(), res, vi.fn() as unknown as NextFunction);
    expect(res.status).toHaveBeenCalledWith(422);
    const payload = (res.json as any).mock.calls[0][0];
    expect(payload.code).toBe("VALIDATION_ERROR");
    expect(payload.details.issues[0]).toMatch(/^name:/);
  });
});

describe("errorHandler — 413 entity.too.large is terminal", () => {
  it("emits PAYLOAD_TOO_LARGE with the configured limit", () => {
    const err = Object.assign(new Error("request entity too large"), {
      type: "entity.too.large",
      limit: 10240,
    });
    const res = makeRes() as any;
    errorHandler(err, makeReq(), res, vi.fn() as unknown as NextFunction);
    expect(res.status).toHaveBeenCalledWith(413);
    expect(res.json).toHaveBeenCalledWith({
      error: "Request payload exceeds the actor body-size limit",
      code: "PAYLOAD_TOO_LARGE",
      details: { limit: 10240 },
    });
  });
});
