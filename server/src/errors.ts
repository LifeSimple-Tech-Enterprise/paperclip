export class HttpError extends Error {
  status: number;
  details?: unknown;
  code?: string;

  constructor(status: number, message: string, details?: unknown, code?: string) {
    super(message);
    this.status = status;
    this.details = details;
    this.code = code;
  }
}

export function badRequest(message: string, details?: unknown) {
  return new HttpError(400, message, details);
}

export function unauthorized(message = "Unauthorized") {
  return new HttpError(401, message);
}

export function forbidden(message = "Forbidden") {
  return new HttpError(403, message);
}

export function notFound(message = "Not found") {
  return new HttpError(404, message);
}

export function conflict(message: string, details?: unknown) {
  return new HttpError(409, message, details);
}

export function unprocessable(message: string, details?: unknown) {
  return new HttpError(422, message, details);
}

/**
 * Stage 3a — descriptive 422 helper. Use this in place of `unprocessable()`
 * whenever the client (an agent) needs structured guidance on how to recover.
 *
 *   throw descriptiveError("DELEGATE_REQUIRES_BRANCH",
 *     "delegate handoffs require a `branch` field; pass the working branch");
 *
 * The `prompt` becomes the human-readable message; `code` is the machine-checkable
 * tag; `details` is structured context. The error handler emits
 * `{ error, code, details }` for every 422.
 */
export function descriptiveError(
  code: string,
  prompt: string,
  details?: unknown,
): HttpError {
  return new HttpError(422, prompt, details, code);
}
