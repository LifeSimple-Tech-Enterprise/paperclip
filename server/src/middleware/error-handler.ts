import type { Request, Response, NextFunction } from "express";
import { ZodError, type ZodIssue } from "zod";
import { HttpError } from "../errors.js";
import { trackErrorHandlerCrash } from "@paperclipai/shared/telemetry";
import { getTelemetryClient } from "../telemetry.js";

export interface ErrorContext {
  error: { message: string; stack?: string; name?: string; details?: unknown; raw?: unknown };
  method: string;
  url: string;
  reqBody?: unknown;
  reqParams?: unknown;
  reqQuery?: unknown;
}

const UNKNOWN_VALIDATION_GUIDANCE =
  "This request was rejected with HTTP 422 but no structured `code` was attached. " +
  "Treat it as a transient validation failure: re-read the route contract, fix the " +
  "payload shape, and retry. Do NOT loop on the same body — escalate or change strategy.";

/**
 * Render a ZodError as a flat string array. Each issue becomes
 * `path.with.dots: <message>` so an agent can read it without parsing
 * a nested tree. Stage 3a (LIF-375 plan rev 26).
 */
export function formatZodError(err: ZodError): { issues: string[] } {
  const issues = err.issues.map((issue: ZodIssue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "<root>";
    return `${path}: ${issue.message}`;
  });
  return { issues };
}

function attachErrorContext(
  req: Request,
  res: Response,
  payload: ErrorContext["error"],
  rawError?: Error,
) {
  (res as any).__errorContext = {
    error: payload,
    method: req.method,
    url: req.originalUrl,
    reqBody: req.body,
    reqParams: req.params,
    reqQuery: req.query,
  } satisfies ErrorContext;
  if (rawError) {
    (res as any).err = rawError;
  }
}

/**
 * Send a 422 with the descriptive envelope `{ error, code, details? }`. Stage 3a
 * guarantees: every 422 carries a `code`; uncoded HttpErrors get
 * `UNKNOWN_VALIDATION_ERROR` plus guidance text + `details.originalMessage` so
 * agents see the original failure even when the route author forgot to attach a code.
 */
function sendDescriptive422(
  res: Response,
  message: string,
  code: string | undefined,
  details: unknown,
): void {
  if (code) {
    const payload: Record<string, unknown> = { error: message, code };
    if (details !== undefined) payload.details = details;
    res.status(422).json(payload);
    return;
  }

  // Uncoded 422: tag UNKNOWN_VALIDATION_ERROR + guidance + originalMessage.
  // We preserve the legacy `error` string for clients that still read it; the
  // structured `code` and `details.guidance` are the new signal agents should
  // act on under LIF-375 Stage 3a.
  const payload: Record<string, unknown> = {
    error: message,
    code: "UNKNOWN_VALIDATION_ERROR",
    details: {
      ...(details && typeof details === "object" ? (details as Record<string, unknown>) : {}),
      originalMessage: message,
      guidance: UNKNOWN_VALIDATION_GUIDANCE,
    },
  };
  res.status(422).json(payload);
}

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
) {
  // Express body-parser raises `entity.too.large` for over-limit payloads.
  // Stage 3a treats this as a terminal 413: the agent's payload is so big it
  // can never succeed with the same body, so we surface it with a code so the
  // tracker can mark the action terminal.
  if (
    err &&
    typeof err === "object" &&
    "type" in err &&
    (err as { type?: string }).type === "entity.too.large"
  ) {
    const limit =
      "limit" in err && typeof (err as { limit?: unknown }).limit === "number"
        ? (err as { limit: number }).limit
        : undefined;
    res.status(413).json({
      error: "Request payload exceeds the actor body-size limit",
      code: "PAYLOAD_TOO_LARGE",
      details: limit !== undefined ? { limit } : undefined,
    });
    return;
  }

  if (err instanceof ZodError) {
    sendDescriptive422(
      res,
      "Validation failed",
      "VALIDATION_ERROR",
      formatZodError(err),
    );
    return;
  }

  if (err instanceof HttpError) {
    if (err.status === 422) {
      sendDescriptive422(res, err.message, err.code, err.details);
      return;
    }

    if (err.status >= 500) {
      attachErrorContext(
        req,
        res,
        { message: err.message, stack: err.stack, name: err.name, details: err.details },
        err,
      );
      const tc = getTelemetryClient();
      if (tc) trackErrorHandlerCrash(tc, { errorCode: err.name });
    }
    res.status(err.status).json({
      error: err.message,
      ...(err.code ? { code: err.code } : {}),
      ...(err.details ? { details: err.details } : {}),
    });
    return;
  }

  const rootError = err instanceof Error ? err : new Error(String(err));
  attachErrorContext(
    req,
    res,
    err instanceof Error
      ? { message: err.message, stack: err.stack, name: err.name }
      : { message: String(err), raw: err, stack: rootError.stack, name: rootError.name },
    rootError,
  );

  const tc = getTelemetryClient();
  if (tc) trackErrorHandlerCrash(tc, { errorCode: rootError.name });

  res.status(500).json({ error: "Internal server error" });
}
